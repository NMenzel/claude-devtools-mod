// Claude DevTools: the native Mod layer. It connects the pure engine in src/
// to Claude Code's events: it holds tool calls at breakpoints through the
// engine's own question dialog, records what really ran, draws the pane and
// answers the /devtools commands. Decisions live in src/core; this file acts.
//
// The engine requires `$` to be passed only to functions declared at the top
// of this file, so every helper that touches the API lives here, and the
// options `register` receives are kept in module variables.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  ArmState,
  Breakpoint,
  DevtoolsMode,
  DevtoolsSettings,
  DevtoolsStats,
  ErrorCategory,
  LensProbe,
  PauseDecision,
  PendingCall,
  PermissionInfo,
  TraceEvent,
  TraceOutcome,
  TraceStatus,
  ViewState,
} from '../types'
import { DEFAULT_OPTIONS, defaultSettings, type DevtoolsOptions, parseOptions, parsePersisted, STORE_KEY, toPersisted } from '../src/config/schema.ts'
import { criteriaMatch, describeBreakpoint, nextBreakpointId, parseBreakpointSpec, SPEC_HELP, validateBreakpoint } from '../src/core/breakpoints.ts'
import {
  classifyResult,
  DISARMED,
  interpretAnswer,
  type Planned,
  pauseQuestion,
  planAfterError,
  planCall,
  refusalText,
  wouldPause,
} from '../src/core/controller.ts'
import {
  errorTextOf,
  normalizeCall,
  type NormalizedCall,
  rawOf,
  type ResultLike,
  sanitizeInput,
  type SummaryOptions,
  summarizeInput,
  summarizeResult,
  type ToolCallLike,
  truncate,
} from '../src/core/events.ts'
import {
  addToGroups,
  buildLensRecord,
  errorTextOfResult,
  lensReport,
  looksLikeFailure,
  MAX_LENS,
  type ProbeTarget,
  shouldNotify,
  withProbes,
} from '../src/core/lens.ts'
import {
  appendBounded,
  buildExport,
  closeStale,
  exportPaths,
  exportToMarkdown,
  formatDuration,
  patchEvent,
  serializeExport,
  statusIcon,
} from '../src/core/recorder.ts'
import { checkSimulation, synthesize } from '../src/core/simulation.ts'
import { type Category, findCategoryRule, findRule, type Suggestion, suggestBreakpoints, withHits } from '../src/core/suggest.ts'
import { redactString } from '../src/security/redaction.ts'
import { type Offer, renderBar, renderGutter } from '../src/ui/inline.tsx'
import type { Layout } from '../src/ui/model.ts'
import { type PaneActions, renderPane } from '../src/ui/pane.tsx'

const VERSION = '0.1.2'
const PANE = 'devtools'

// The $.state values kept for the session (declared in ../types/index.d.ts):
// host-held, so they survive a hot reload of this module. Settings have no
// static initial: never written means "load from the store first".
const SETTINGS = { plugin: 'devtools', key: 'settings' } as const
const ARM = { plugin: 'devtools', key: 'arm' } as const
const ARM_ATOM = atom({ plugin: 'devtools', key: 'arm' } as const, DISARMED)
const TRACE = atom({ plugin: 'devtools', key: 'trace' } as const, [])
const PENDING = atom({ plugin: 'devtools', key: 'pending' } as const, [])
const HITS = atom({ plugin: 'devtools', key: 'hits' } as const, {})
const VIEW = atom({ plugin: 'devtools', key: 'view' } as const, { tab: 'dashboard', page: 0 })
const SESSION = atom({ plugin: 'devtools', key: 'session' } as const, { sessionId: '', isInteractive: true, cwd: '', surface: null })
const STATS = atom({ plugin: 'devtools', key: 'stats' } as const, {
  observed: 0,
  completed: 0,
  failed: 0,
  denied: 0,
  simulated: 0,
  paused: 0,
})
const LENS = atom({ plugin: 'devtools', key: 'lens' } as const, [])
const GROUPS = atom({ plugin: 'devtools', key: 'errorGroups' } as const, [])

type Dollar = EngineInterface
type ToolResult = { deny: string } | { result: unknown }
type Held = { answer: ToolResult } | { decision: Extract<PauseDecision, 'continue' | 'step'>; permission?: PermissionInfo }

const STATUS_COUNTER: Partial<Record<TraceStatus, keyof DevtoolsStats>> = {
  completed: 'completed',
  failed: 'failed',
  denied: 'denied',
  simulated: 'simulated',
}

// Set by `register`; a reload runs it again with the current options.
let options: DevtoolsOptions = DEFAULT_OPTIONS
let optionWarnings: string[] = []
let summary: SummaryOptions = { maxChars: DEFAULT_OPTIONS.maxSummaryChars, redaction: true, captureRaw: false }
// Snapshot for the .catch handler, which may not call $ on a re-entry and has
// one second: the settings, arm and cwd last read. Refreshed on every call.
const mirror: { settings?: DevtoolsSettings; arm?: ArmState; cwd?: string } = {}
// tool.check verdicts by tool_use_id, consumed when the call finishes.
const verdicts = new Map<string, PermissionInfo>()
let localSeq = 0

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactIf(text: string): string {
  return options.redaction ? redactString(text) : text
}

function debug($: Dollar, text: string): void {
  $.ui.log(`devtools: ${text}`, { to: 'debug' })
}

// ------------------------------------------------------------------ settings

/**
 * The session's rules (hit counts not merged); on first use (a new session,
 * or after /clear) loaded from the store.
 */
async function loadSettings($: Dollar): Promise<DevtoolsSettings> {
  const held = await $.state.get(SETTINGS)
  if (held.value !== undefined) return held.value
  let settings = defaultSettings(options)
  if (options.persistBreakpoints) {
    try {
      const parsed = parsePersisted(await $.store.get(STORE_KEY), options)
      settings = parsed.settings
      for (const warning of parsed.warnings) debug($, warning)
    } catch (error) {
      debug($, `could not read saved settings: ${message(error)}`)
    }
  }
  const written = await $.state.set(SETTINGS, settings, { ifVersion: held.version })
  if (!written.isSet) settings = (await $.state.get(SETTINGS)).value ?? settings
  return settings
}

/** The rules with this session's hit counts, as planning and display need them; also the guard's snapshot. */
async function liveSettings($: Dollar): Promise<DevtoolsSettings> {
  const [settings, hits] = await Promise.all([loadSettings($), read($, HITS)])
  return (mirror.settings = withHits(settings, hits))
}

/** A person's change: written to the session and, when enabled, to the store. */
async function changeSettings($: Dollar, change: (settings: DevtoolsSettings) => DevtoolsSettings): Promise<DevtoolsSettings> {
  await loadSettings($)
  const next = await update($, SETTINGS, current => change(current ?? defaultSettings(options)))
  mirror.settings = withHits(next, await read($, HITS))
  if (options.persistBreakpoints) {
    try {
      await $.store.set(STORE_KEY, toPersisted(next))
    } catch (error) {
      debug($, `could not save settings: ${message(error)}`)
    }
  }
  await refreshStatus($)
  return next
}

/** Counts hits in their own state key: the rules, which transcript rows read, do not change. */
async function bumpHits($: Dollar, ids: readonly string[]): Promise<void> {
  await update($, HITS, hits => {
    const next = { ...hits }
    for (const id of ids) next[id] = (next[id] ?? 0) + 1
    return next
  })
}

async function forgetHits($: Dollar, ids: readonly string[] | 'all'): Promise<void> {
  await update($, HITS, hits => (ids === 'all' ? {} : Object.fromEntries(Object.entries(hits).filter(([id]) => !ids.includes(id)))))
}

/**
 * Sets or removes the rule a suggestion or category stands for, as a click
 * on a line's gutter does in Chrome DevTools. Returns what happened.
 */
async function toggleRule($: Dollar, kind: Breakpoint['kind'], match: Breakpoint['match'], name: string): Promise<string> {
  const settings = await loadSettings($)
  const existing = findRule(settings.breakpoints, kind, match)
  if (existing !== undefined) {
    await changeSettings($, current => ({ ...current, breakpoints: current.breakpoints.filter(bp => bp.id !== existing.id) }))
    await forgetHits($, [existing.id])
    return `Breakpoint removed: ${existing.name}`
  }
  const checked = validateBreakpoint({ id: nextBreakpointId(settings.breakpoints), name, enabled: true, kind, match, scope: options.defaultScope, action: 'pause', hitCount: 0 })
  if (!checked.ok) return `Breakpoint not set: ${checked.error}`
  let id = checked.breakpoint.id
  await changeSettings($, current => {
    id = nextBreakpointId(current.breakpoints)
    return { ...current, breakpoints: [...current.breakpoints, { ...checked.breakpoint, id }] }
  })
  await forgetHits($, [id])
  const mode = (await loadSettings($)).mode
  return `Breakpoint set: ${name} → pause${mode === 'active' ? '' : ` (mode ${mode}: /devtools-enable to pause)`}`
}

async function toggleSuggestion($: Dollar, suggestion: Suggestion): Promise<void> {
  const text = await toggleRule($, suggestion.kind, suggestion.match, suggestion.name)
  $.ui.toast(`DevTools: ${text}`)
  await setView($, { notice: text })
}

async function toggleCategory($: Dollar, category: Category): Promise<void> {
  const settings = await loadSettings($)
  const existing = findCategoryRule(settings.breakpoints, category)
  // A category rule switched off by hand is switched back on, not deleted and re-added.
  if (existing !== undefined && !existing.enabled) {
    await setView($, { notice: await editBreakpoint($, 'enable', existing.id) })
    return
  }
  await setView($, { notice: await toggleRule($, 'tool', { tools: [...category.tools] }, `Pause on ${category.label}`) })
}

async function hideBar($: Dollar): Promise<void> {
  await setView($, { barHidden: true })
}

async function openPane($: Dollar, isAsked: boolean): Promise<string | undefined> {
  const opened = await $.ui.open(isAsked ? { id: PANE, title: 'Claude DevTools', focus: true } : { id: PANE, title: 'Claude DevTools' })
  return opened.isPlaced ? undefined : opened.reason
}

/** The bar's "why?": the pane, on this failure's Error Lens. */
async function openLens($: Dollar, id: string): Promise<void> {
  await setView($, { tab: 'errors', lensId: id })
  await openPane($, true)
}

async function exportFromPane($: Dollar): Promise<void> {
  try {
    const text = await exportTrace($, '')
    await setView($, { notice: text.replace(/\s*\n\s*/g, ' ') })
  } catch (error) {
    await setView($, { notice: `Export failed: ${message(error)}` })
  }
}

async function setArm($: Dollar, arm: ArmState): Promise<void> {
  await $.state.set(ARM, arm)
  mirror.arm = arm
  await refreshStatus($)
}

async function toggleArm($: Dollar): Promise<void> {
  const current = await read($, ARM_ATOM)
  await setArm($, current.pauseNext || current.step ? DISARMED : { pauseNext: true, step: false, reason: 'armed in the pane' })
}

/** Merges a view change and clears the last notice; a key set to undefined is removed (state holds JSON). */
async function setView($: Dollar, change: Partial<ViewState>): Promise<void> {
  await update($, VIEW, ({ notice: _cleared, ...view }) => {
    const merged: Record<string, unknown> = { ...view, ...change }
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
    return merged as ViewState
  })
}

async function movePage($: Dollar, delta: number): Promise<void> {
  await update($, VIEW, ({ notice: _cleared, ...view }) => ({ ...view, page: Math.max(0, view.page + delta) }))
}

async function clearTimeline($: Dollar): Promise<void> {
  await update($, TRACE, () => [])
  await setView($, { page: 0, selectedId: undefined })
}

async function refreshStatus($: Dollar): Promise<void> {
  const [arm, pending, held] = await Promise.all([read($, ARM_ATOM), read($, PENDING), $.state.get(SETTINGS)])
  const mode = held.value?.mode ?? 'active'
  if (pending.length > 0) $.ui.status(`⏸ DevTools: ${pending.length === 1 ? `${pending[0]?.tool} paused` : `${pending.length} calls paused`}`)
  else if (mode === 'active' && (arm.pauseNext || arm.step)) $.ui.status('DevTools: the next tool call will pause')
  else if (mode === 'observe') $.ui.status('DevTools: observing (breakpoints do not pause)')
  else $.ui.status(undefined)
}

// ------------------------------------------------------------------ recording

async function addEvent($: Dollar, event: TraceEvent): Promise<void> {
  await update($, TRACE, list => appendBounded(list, event, options.maxTimelineEntries))
}

async function patch($: Dollar, id: string, change: Partial<TraceEvent>): Promise<void> {
  await update($, TRACE, list => patchEvent(list, id, change))
}

async function count($: Dollar, status: TraceStatus): Promise<void> {
  const key = STATUS_COUNTER[status]
  if (key !== undefined) await update($, STATS, stats => ({ ...stats, [key]: stats[key] + 1 }))
}

/**
 * Claims the plan for a call. A consumed arm (pause-next, step) is written
 * back only if nobody consumed it first, so of two concurrent calls only one
 * pauses for a single step.
 */
async function claimPlan($: Dollar, settings: DevtoolsSettings, call: NormalizedCall, cwd: string | undefined): Promise<Planned> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const held = await $.state.get(ARM)
    const arm = held.value ?? DISARMED
    mirror.arm = arm
    const planned = planCall(settings, arm, call, cwd)
    if (planned.arm === arm) return planned
    const written = await $.state.set(ARM, planned.arm, { ifVersion: held.version })
    if (written.isSet) return planned
  }
  return planCall(settings, DISARMED, call, cwd)
}

/** What the permission rules and mode would decide, asked without running anything. */
async function previewPermission($: Dollar, call: NormalizedCall): Promise<PermissionInfo | undefined> {
  try {
    const verdict = await $.tool.check({ tool: call.tool, input: call.args })
    return { decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, source: 'preview' }
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------------ pausing

async function refuse($: Dollar, event: TraceEvent, status: TraceStatus, outcome: TraceOutcome, deny: string, decision?: PauseDecision): Promise<Held> {
  await patch($, event.id, {
    status,
    outcome,
    ...(decision !== undefined ? { decision } : {}),
    errorText: redactIf(deny),
    durationMs: 0,
    resultSummary: `not run: ${outcome}`,
  })
  await count($, status)
  const now = await $.clock.now()
  await captureFailure($, event, true, { startedMs: now, endedMs: now, status, outcome, text: deny })
  return { answer: { deny } }
}

/**
 * Holds a call until the person decides, inside the engine's own question
 * dialog ($.ui.ask), whose wait does not count against the hook's budget.
 * Headless, nobody can answer: the configured policy decides at once.
 */
async function hold(
  $: Dollar,
  signal: AbortSignal,
  call: NormalizedCall,
  event: TraceEvent,
  reason: string,
  at: Breakpoint | undefined,
  isInteractive: boolean,
): Promise<Held> {
  const pending: PendingCall = { id: event.id, tool: call.tool, inputSummary: event.inputSummary, reason, sinceMs: event.startedAtMs }
  await update($, PENDING, list => [...list, call.agentId === undefined ? pending : { ...pending, agentId: call.agentId }])
  await update($, STATS, stats => ({ ...stats, paused: stats.paused + 1 }))
  await refreshStatus($)
  try {
    if (!isInteractive) {
      if (options.headlessPause === 'record-only') {
        $.ui.log(`devtools: ${reason} matched ${call.tool} in a headless session; recorded and let through (headlessPause=record-only).`)
        return { decision: 'continue' }
      }
      const deny = refusalText('headless', call.tool, reason)
      $.ui.log(`devtools: ${deny}`)
      return await refuse($, event, 'denied', 'headless-rejected', deny)
    }
    const permission = await previewPermission($, call)
    const simulation = checkSimulation(options.simulation, at, call)
    if (permission !== undefined) await patch($, event.id, { permission })
    const question = pauseQuestion({
      tool: call.tool,
      summary: event.inputSummary,
      reason,
      risk: call.risk,
      agentId: call.agentId,
      permission,
      canSimulate: simulation.ok,
    })
    let answer: string | undefined
    try {
      answer = await $.ui.ask(question.question, { options: question.options, header: question.header })
    } catch {
      // Dismissed, "Chat about this", or nobody to ask: the call does not run.
      answer = undefined
    }
    if (signal.aborted) return await refuse($, event, 'failed', 'aborted', refusalText('aborted', call.tool, reason))
    if (answer === undefined) return await refuse($, event, 'denied', 'user-cancelled', refusalText('cancelled', call.tool, reason))
    const { decision, note } = interpretAnswer(answer, simulation.ok)
    if (decision === 'reject') return await refuse($, event, 'denied', 'debugger-rejected', refusalText('debugger', call.tool, reason, note), 'reject')
    if (decision === 'simulate' && simulation.ok) {
      const synthetic = synthesize(simulation.kind, call, simulation.text)
      const shown: ResultLike = 'deny' in synthetic ? { deny: synthetic.deny } : { result: synthetic.result }
      await patch($, event.id, {
        status: 'simulated',
        outcome: 'simulated',
        decision: 'simulate',
        simulated: true,
        durationMs: 0,
        resultSummary: `SIMULATED ${simulation.kind === 'fail' ? 'failure' : 'output'}: ${summarizeResult(call.tool, shown, summary)}`,
      })
      await count($, 'simulated')
      if ('deny' in synthetic) {
        const now = await $.clock.now()
        await captureFailure($, event, true, { startedMs: now, endedMs: now, status: 'simulated', outcome: 'simulated', text: synthetic.deny })
      }
      return { answer: synthetic }
    }
    if (decision === 'step') await $.state.set(ARM, { pauseNext: false, step: true })
    return { decision: decision === 'step' ? 'step' : 'continue', ...(permission !== undefined ? { permission } : {}) }
  } finally {
    await update($, PENDING, list => list.filter(item => item.id !== event.id))
    await refreshStatus($)
  }
}

/** Records what the call really returned, then applies error breakpoints. */
async function afterRun(
  $: Dollar,
  call: NormalizedCall,
  event: TraceEvent,
  isRecorded: boolean,
  startedMs: number,
  result: ResultLike,
  preview: PermissionInfo | undefined,
  cwd: string | undefined,
): Promise<void> {
  const endedMs = await $.clock.now()
  const observed = call.toolUseId === undefined ? undefined : verdicts.get(call.toolUseId)
  if (call.toolUseId !== undefined) verdicts.delete(call.toolUseId)
  const permission = observed ?? preview
  const { status, outcome } = classifyResult(result, permission)
  const errorText = errorTextOf(result, summary)
  const change: Partial<TraceEvent> = {
    status,
    outcome,
    durationMs: Math.max(0, endedMs - startedMs),
    resultSummary: summarizeResult(call.tool, result, summary),
    ...(errorText !== undefined ? { errorText } : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(result.isReadOnly === true ? { isReadOnly: true } : {}),
    ...(options.captureRaw ? { raw: rawOf(call, result, summary) } : {}),
  }
  if (isRecorded) await patch($, event.id, change)
  await count($, status)
  const suspected = status === 'completed' && looksLikeFailure(call.tool, result)
  let errorCategory: ErrorCategory | undefined
  if (status === 'failed' || status === 'denied' || suspected) {
    const content = call.tool === 'Write' && typeof call.args.content === 'string' ? call.args.content : undefined
    errorCategory = await captureFailure(
      $,
      event,
      isRecorded,
      {
        startedMs,
        endedMs,
        status,
        outcome,
        text: errorTextOfResult(result),
        ...(suspected ? { suspected: true } : {}),
        ...(permission !== undefined ? { permission } : {}),
      },
      content === undefined ? undefined : new TextEncoder().encode(content).length,
    )
  }
  if (outcome !== 'tool-error') return

  const [settings, arm] = await Promise.all([liveSettings($), read($, ARM_ATOM)])
  const planned = planAfterError(settings, arm, call, cwd)
  if (planned.triggered.length === 0) return
  const ids = planned.triggered.map(bp => bp.id)
  await bumpHits($, ids)
  if (!isRecorded) await addEvent($, { ...event, ...change, breakpointIds: ids, ...(errorCategory !== undefined ? { errorCategory } : {}) })
  else await patch($, event.id, { breakpointIds: [...(event.breakpointIds ?? []), ...ids] })
  if (planned.arm !== arm) await setArm($, planned.arm)
  const next = planned.arm.pauseNext ? ' The next tool call will pause.' : ''
  $.ui.toast(`DevTools: ${call.tool} failed (${planned.triggered.map(bp => bp.name).join(', ')}).${next}`, { timeoutMs: 6000 })
}

// ------------------------------------------------------------------ error lens

/** What the person did themselves: kept and shown, never announced. */
const QUIET: readonly ErrorCategory[] = ['debugger', 'simulated', 'interrupted']

type Failure = {
  startedMs: number
  endedMs: number
  status: TraceStatus
  outcome: TraceOutcome
  /** The error as Claude read it, before redaction. */
  text: string
  suspected?: true
  permission?: PermissionInfo
}

/**
 * Error Lens: diagnoses a failed call from its result, keeps it, groups
 * repeats, and in probe mode schedules read-only checks for after the result
 * has gone back. It never retries or changes the call, and its own failure
 * is only logged. Returns the category it recorded.
 */
async function captureFailure($: Dollar, event: TraceEvent, isRecorded: boolean, failure: Failure, contentBytes?: number): Promise<ErrorCategory | undefined> {
  if (options.errorLens === 'off') return undefined
  try {
    const { record, plan } = buildLensRecord({
      id: event.id,
      seq: event.seq,
      tool: event.tool,
      ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
      startedAtMs: failure.startedMs,
      endedAtMs: failure.endedMs,
      status: failure.status,
      outcome: failure.outcome,
      ...(failure.suspected === true ? { suspected: true } : {}),
      text: redactIf(failure.text),
      args: event.input ?? {},
      paths: event.paths ?? [],
      ...(failure.permission !== undefined ? { permission: failure.permission } : {}),
      ...(contentBytes !== undefined ? { contentBytes } : {}),
      probing: options.errorLens,
    })
    await update($, LENS, list => [...list.filter(one => one.id !== record.id), record].slice(-MAX_LENS))
    const groups = await update($, GROUPS, list => addToGroups(list, record).groups)
    const group = groups.find(one => one.signature === record.signature)
    if (isRecorded) await patch($, record.id, { errorCategory: record.category })
    if (options.errorToasts && group !== undefined && shouldNotify(group) && !QUIET.includes(record.category)) {
      const verb = record.suspected === true ? 'may have failed' : record.status === 'denied' ? 'denied' : 'failed'
      const repeat = group.count > 1 ? ` · ${group.count}× this session` : ''
      $.ui.toast(`DevTools ✗ ${record.tool} ${verb} (${record.category})${repeat}: ${truncate(record.headline, 90)} · /devtools-errors to inspect`, { timeoutMs: 6000 })
    }
    // Deferred: the checks run once the result is on its way back to Claude.
    if (plan.length > 0) $.clock.after(0, () => settle($, runProbes($, record.id, plan)))
    return record.category
  } catch (error) {
    debug($, `Error Lens could not record ${event.tool}: ${message(error)}`)
    return undefined
  }
}

/** One $.fs.stat per planned path: read-only, metadata only, never a file's contents. */
async function runProbes($: Dollar, id: string, plan: readonly ProbeTarget[]): Promise<void> {
  const probes = await Promise.all(
    plan.map(async ({ path, role }): Promise<LensProbe> => {
      try {
        const stat = await $.fs.stat(path, { resolve: true })
        return {
          path,
          role,
          exists: true,
          kind: stat.kind,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          isLink: stat.isLink,
          ...(stat.realPath !== undefined ? { realPath: redactIf(stat.realPath) } : {}),
        }
      } catch (error) {
        const text = message(error)
        return /\bENOENT\b|no such file/i.test(text) ? { path, role, exists: false } : { path, role, exists: null, error: truncate(redactIf(text), 160) }
      }
    }),
  )
  await update($, LENS, list => list.map(one => (one.id === id ? withProbes(one, probes) : one)))
}

async function clearErrors($: Dollar): Promise<void> {
  await update($, LENS, () => [])
  await update($, GROUPS, () => [])
  await setView($, { lensId: undefined })
}

async function errorsText($: Dollar): Promise<string> {
  if (options.errorLens === 'off') return 'Error Lens is off (the devtools option errorLens).'
  const [lens, groups] = await Promise.all([read($, LENS), read($, GROUPS)])
  const latest = lens.at(-1)
  if (latest === undefined) return 'Error Lens: no failed tool calls this session.'
  return [
    `Error Lens: ${lens.length} failure${lens.length === 1 ? '' : 's'} kept, ${groups.length} kind${groups.length === 1 ? '' : 's'}`,
    ...groups.slice(0, 8).map(group => `  ${group.count}× ${group.tool} · ${group.category} · ${truncate(group.headline, 100)}`),
    '',
    'Latest:',
    ...lensReport(latest),
  ].join('\n')
}

// ------------------------------------------------------------------ commands

async function statusText($: Dollar): Promise<string> {
  const [settings, arm, stats, trace, pending, session] = await Promise.all([
    liveSettings($),
    read($, ARM_ATOM),
    read($, STATS),
    read($, TRACE),
    read($, PENDING),
    read($, SESSION),
  ])
  const enabled = settings.breakpoints.filter(bp => bp.enabled).length
  const lines = [
    `Claude DevTools — mode ${settings.mode} · recording ${settings.recording ? 'on' : 'off'} · simulation ${options.simulation ? 'on' : 'off'} · ${session.isInteractive ? 'interactive' : `headless (pause → ${options.headlessPause})`}`,
    `Paused: ${pending.length === 0 ? 'none' : pending.map(p => `${p.tool} ${p.inputSummary} (${p.reason})`).join('; ')}`,
    `Armed: ${arm.pauseNext || arm.step ? `the next call pauses${arm.step ? ' (step)' : ''}${arm.reason !== undefined ? ` (${arm.reason})` : ''}` : 'no'}`,
    `Calls: ${stats.observed} observed · ${stats.completed} ok · ${stats.failed} failed · ${stats.denied} denied · ${stats.simulated} simulated · ${stats.paused} paused`,
    `Breakpoints: ${enabled} enabled of ${settings.breakpoints.length} (/devtools-list)`,
    `Timeline: ${trace.length} of ${options.maxTimelineEntries} events kept · redaction ${options.redaction ? 'on' : 'OFF'}${options.captureRaw ? ' · RAW CAPTURE ON' : ''}`,
  ]
  const recent = trace.slice(-5)
  if (recent.length > 0) {
    lines.push('Recent:')
    for (const ev of recent) {
      lines.push(`  ${ev.startedAt.slice(11, 19)} ${statusIcon(ev.status)} ${ev.tool} ${formatDuration(ev.durationMs)} ${ev.simulated ? 'SIMULATED ' : ''}${ev.inputSummary}`)
    }
  }
  return lines.join('\n')
}

function listText(settings: DevtoolsSettings): string {
  if (settings.breakpoints.length === 0) return 'No breakpoints. Add one with /devtools-break, e.g. /devtools-break command npm install'
  return [
    `Breakpoints (mode ${settings.mode}):`,
    ...settings.breakpoints.map(bp => `  ${bp.id} ${bp.enabled ? '●' : '○'} ${bp.name} — ${describeBreakpoint(bp)} · hits ${bp.hitCount}`),
  ].join('\n')
}

function helpText(): string {
  return [
    'Claude DevTools: inspect, pause and control tool calls before they run.',
    '',
    '/devtools                 open the pane (Overview, Timeline, Inspector, Breakpoints, Errors)',
    '/devtools-status          debugger state as text',
    '/devtools-break <rule>    add a breakpoint; /devtools-break delete|toggle <id>; /devtools-break clear',
    '/devtools-list            list breakpoints',
    '/devtools-pause           pause on the next tool call',
    '/devtools-continue        disarm pause-next and stepping',
    '/devtools-disable [observe|off]   stop pausing, or turn the debugger off',
    '/devtools-enable          pause on breakpoints again',
    '/devtools-record [on|off] timeline recording',
    '/devtools-export [path] [--md]    write a sanitized JSON trace (and a Markdown report)',
    '/devtools-errors [clear]  Error Lens: why recent calls failed (confirmed / possible / unknown), with fixes',
    '',
    'Short aliases: /bp <rule> (/bp alone lists) · /bpl list · /bpn pause next · /bpc continue · /bpe errors',
    '',
    'Rules:',
    ...SPEC_HELP.map(line => `  ${line}`),
    '',
    'A paused call is answered in the question dialog: Continue (normal permission checks still run),',
    'Step (run it, pause on the next call), Reject (Claude is told it did not run), Simulate (only with',
    'the simulation option, labeled, never claiming side effects). Typed text rejects and is passed to Claude.',
  ].join('\n')
}

async function addBreakpoint($: Dollar, spec: string): Promise<{ ok: true; breakpoint: Breakpoint } | { ok: false; error: string }> {
  const settings = await loadSettings($)
  const parsed = parseBreakpointSpec(spec, nextBreakpointId(settings.breakpoints), options.defaultScope)
  if (!parsed.ok) return parsed
  let added = parsed.breakpoint
  await changeSettings($, current => {
    added = { ...parsed.breakpoint, id: nextBreakpointId(current.breakpoints) }
    return { ...current, breakpoints: [...current.breakpoints, added] }
  })
  return { ok: true, breakpoint: added }
}

async function addFromPane($: Dollar, spec: string): Promise<void> {
  const added = await addBreakpoint($, spec)
  await setView($, { notice: added.ok ? `Added ${added.breakpoint.id}: ${describeBreakpoint(added.breakpoint)}` : `Not added: ${added.error}` })
}

async function editBreakpoint($: Dollar, verb: string, id: string): Promise<string> {
  const settings = await loadSettings($)
  const found = settings.breakpoints.find(bp => bp.id === id)
  if (found === undefined) return `No breakpoint ${id}. ${listText(settings)}`
  if (verb === 'delete' || verb === 'rm' || verb === 'remove') {
    await changeSettings($, current => ({ ...current, breakpoints: current.breakpoints.filter(bp => bp.id !== id) }))
    await forgetHits($, [id])
    return `Deleted ${id} (${found.name}).`
  }
  const enabled = verb === 'enable' ? true : verb === 'disable' ? false : !found.enabled
  await changeSettings($, current => ({ ...current, breakpoints: current.breakpoints.map(bp => (bp.id === id ? { ...bp, enabled } : bp)) }))
  return `${enabled ? 'Enabled' : 'Disabled'} ${id} (${found.name}).`
}

async function setMode($: Dollar, mode: DevtoolsMode): Promise<void> {
  await changeSettings($, current => ({ ...current, mode }))
}

async function toggleRecording($: Dollar): Promise<void> {
  await changeSettings($, current => ({ ...current, recording: !current.recording }))
}

async function exportTrace($: Dollar, args: string): Promise<string> {
  const words = args.split(/\s+/).filter(word => word !== '')
  const wantsMarkdown = words.includes('--md')
  const target = words.find(word => word !== '--md')
  const [cwd, now, settings, trace, stats, session, errors, errorGroups] = await Promise.all([
    $.session.cwd(),
    $.clock.now(),
    loadSettings($),
    read($, TRACE),
    read($, STATS),
    read($, SESSION),
    read($, LENS),
    read($, GROUPS),
  ])
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const paths = exportPaths(target, cwd, stamp, wantsMarkdown)
  if (!paths.ok) return `Export refused: ${paths.error}.`
  const built = buildExport({
    version: VERSION,
    exportedAt: new Date(now).toISOString(),
    sessionId: session.sessionId,
    redaction: options.redaction,
    rawCapture: options.captureRaw,
    mode: settings.mode,
    stats,
    breakpoints: settings.breakpoints,
    events: trace,
    errors,
    errorGroups,
  })
  const text = serializeExport(built)
  await $.fs.write(paths.json, text)
  const written = [paths.json]
  if (paths.markdown !== undefined) {
    await $.fs.write(paths.markdown, exportToMarkdown(JSON.parse(text)))
    written.push(paths.markdown)
  }
  const privacy = options.redaction ? 'secrets redacted' : 'REDACTION OFF'
  return `Exported ${trace.length} events and ${errors.length} Error Lens record${errors.length === 1 ? '' : 's'} (${privacy}${options.captureRaw ? ', raw capture included' : ''}) to:\n${written.map(path => `  ${path}`).join('\n')}`
}

/** Registers the slash commands, each by its literal name; registering again on a reload replaces them. */
async function registerCommands($: Dollar): Promise<void> {
  await $.command.register({ name: 'devtools', description: 'Claude DevTools: open the debugger pane (overview, timeline, inspector, breakpoints)', immediate: true })
  await $.command.register({ name: 'devtools-status', description: 'Claude DevTools: show the debugger state as text', immediate: true })
  await $.command.register({
    name: 'devtools-break',
    description: 'Claude DevTools: add a breakpoint, or delete/toggle one by id',
    argumentHint: 'tool Bash | command npm install | file .env* | error | when tool=Edit path=src/** | delete <id>',
    immediate: true,
  })
  await $.command.register({ name: 'devtools-list', description: 'Claude DevTools: list breakpoint rules', immediate: true })
  await $.command.register({ name: 'devtools-pause', description: 'Claude DevTools: pause on the next tool call', immediate: true })
  await $.command.register({ name: 'devtools-continue', description: 'Claude DevTools: disarm pause-next and stepping so calls run freely', immediate: true })
  await $.command.register({
    name: 'devtools-disable',
    description: 'Claude DevTools: stop pausing (observe), or turn the debugger off',
    argumentHint: '[observe|off]',
    immediate: true,
  })
  await $.command.register({ name: 'devtools-enable', description: 'Claude DevTools: pause on breakpoints again', immediate: true })
  await $.command.register({ name: 'devtools-record', description: 'Claude DevTools: turn timeline recording on or off', argumentHint: '[on|off]', immediate: true })
  await $.command.register({
    name: 'devtools-export',
    description: 'Claude DevTools: export a sanitized trace as JSON (and Markdown)',
    argumentHint: '[path.json|path.md] [--md]',
    immediate: true,
  })
  await $.command.register({
    name: 'devtools-errors',
    description: 'Claude DevTools Error Lens: why recent tool calls failed, with evidence and fixes',
    argumentHint: '[clear]',
    immediate: true,
  })
  await $.command.register({ name: 'devtools-help', description: 'Claude DevTools: usage and the breakpoint rule language', immediate: true })
  // Short aliases.
  await $.command.register({
    name: 'bp',
    description: 'DevTools: add a breakpoint (= /devtools-break); no rule lists them',
    argumentHint: 'command npm install | file .env* | tool Bash | delete <id>',
    immediate: true,
  })
  await $.command.register({ name: 'bpl', description: 'DevTools: list breakpoints (= /devtools-list)', immediate: true })
  await $.command.register({ name: 'bpn', description: 'DevTools: pause on the next tool call (= /devtools-pause)', immediate: true })
  await $.command.register({ name: 'bpc', description: 'DevTools: continue, disarm pause-next and stepping (= /devtools-continue)', immediate: true })
  await $.command.register({ name: 'bpe', description: 'DevTools: Error Lens, why recent calls failed (= /devtools-errors)', argumentHint: '[clear]', immediate: true })
}

const ALIASES: Readonly<Record<string, string>> = { bp: 'devtools-break', bpl: 'devtools-list', bpn: 'devtools-pause', bpc: 'devtools-continue', bpe: 'devtools-errors' }

async function runCommand($: Dollar, command: string, rawArgs: string): Promise<{ text: string }> {
  const args = rawArgs.trim()
  switch (ALIASES[command] ?? command) {
    case 'devtools': {
      const session = await read($, SESSION)
      if (!session.isInteractive) return { text: await statusText($) }
      const waiting = await openPane($, true)
      if (waiting !== undefined) return { text: `${await statusText($)}\n\nThe pane is waiting: ${waiting}` }
      return { text: 'Claude DevTools is open. Keys: d t i b e switch tabs; Tab walks the controls; ctrl+x tab focuses it.' }
    }
    case 'devtools-status':
      return { text: await statusText($) }
    case 'devtools-list':
      return { text: listText(await liveSettings($)) }
    case 'devtools-break': {
      const [first = '', id = ''] = args.split(/\s+/)
      const verb = first.toLowerCase()
      if (['delete', 'rm', 'remove', 'toggle', 'enable', 'disable'].includes(verb) && id !== '') return { text: await editBreakpoint($, verb, id) }
      if (verb === 'clear') {
        await changeSettings($, current => ({ ...current, breakpoints: [] }))
        await forgetHits($, 'all')
        return { text: 'Deleted every breakpoint.' }
      }
      if (args === '') return { text: `${listText(await liveSettings($))}\n\nUsage: /bp <rule> (or /devtools-break <rule>)\n${SPEC_HELP.map(line => `  ${line}`).join('\n')}` }
      const added = await addBreakpoint($, args)
      if (!added.ok) return { text: `Breakpoint not added: ${added.error}.` }
      const settings = await loadSettings($)
      const note = settings.mode === 'active' ? '' : ` Mode is ${settings.mode}: run /devtools-enable for it to pause.`
      return { text: `Added ${added.breakpoint.id} ${added.breakpoint.name}: ${describeBreakpoint(added.breakpoint)}.${note}` }
    }
    case 'devtools-pause':
      await setArm($, { pauseNext: true, step: false, reason: 'armed by /devtools-pause' })
      return { text: 'The next tool call will pause.' }
    case 'devtools-continue':
      await setArm($, DISARMED)
      return { text: 'Disarmed: calls run freely until a breakpoint matches. A call already held is answered in its dialog.' }
    case 'devtools-disable': {
      const mode: DevtoolsMode = args === 'off' ? 'off' : 'observe'
      await setMode($, mode)
      return { text: mode === 'off' ? 'Claude DevTools is off: no interception, no recording.' : 'Breakpoints no longer pause; matches are still recorded (observe mode).' }
    }
    case 'devtools-enable':
      await setMode($, 'active')
      return { text: 'Breakpoints pause again (active mode).' }
    case 'devtools-record': {
      const settings = await loadSettings($)
      const recording = args === 'on' ? true : args === 'off' ? false : !settings.recording
      await changeSettings($, current => ({ ...current, recording }))
      return { text: recording ? 'Recording every tool call.' : 'Recording off: only breakpoint matches are kept.' }
    }
    case 'devtools-errors': {
      if (args === 'clear') {
        await clearErrors($)
        return { text: 'Error Lens cleared.' }
      }
      const text = await errorsText($)
      const session = await read($, SESSION)
      if (!session.isInteractive || options.errorLens === 'off') return { text }
      await setView($, { tab: 'errors', lensId: undefined })
      const waiting = await openPane($, true)
      return { text: waiting === undefined ? text : `${text}\n\nThe pane is waiting: ${waiting}` }
    }
    case 'devtools-export':
      try {
        return { text: await exportTrace($, args) }
      } catch (error) {
        return { text: `Export failed: ${message(error)}` }
      }
    default:
      return { text: helpText() }
  }
}

function settle($: Dollar, work: Promise<unknown>): void {
  work.catch(error => debug($, `pane action failed: ${message(error)}`))
}

// ------------------------------------------------------------------ register

export const register: Register = (on, rawOptions) => {
  const parsed = parseOptions(rawOptions)
  options = parsed.options
  optionWarnings = parsed.warnings
  summary = { maxChars: options.maxSummaryChars, redaction: options.redaction, captureRaw: options.captureRaw }

  on('tool.call', async ($, e, next) => {
    const settings = await liveSettings($)
    if (settings.mode === 'off') return next(e)
    const session = await read($, SESSION)
    const cwd = session.cwd === '' ? undefined : session.cwd
    mirror.cwd = cwd
    const call = normalizeCall(e as ToolCallLike)
    const { plan } = await claimPlan($, settings, call, cwd)
    const hits = plan.kind === 'pass' ? [] : plan.hits.map(bp => bp.id)
    if (hits.length > 0) await bumpHits($, hits)

    const startedMs = await $.clock.now()
    localSeq += 1
    const id = call.toolUseId ?? `call-${startedMs.toString(36)}-${localSeq}`
    const stats = await update($, STATS, current => ({ ...current, observed: current.observed + 1 }))
    const isRecorded = settings.recording || plan.kind !== 'pass'
    const event: TraceEvent = {
      id,
      seq: stats.observed,
      sessionId: session.sessionId,
      ...(call.toolUseId !== undefined ? { toolUseId: call.toolUseId } : {}),
      tool: call.tool,
      ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
      scope: call.scope,
      status: plan.kind === 'pause' ? 'pending' : 'running',
      startedAt: new Date(startedMs).toISOString(),
      startedAtMs: startedMs,
      risk: call.risk,
      inputSummary: summarizeInput(call, summary),
      input: sanitizeInput(call, summary),
      paths: call.paths.map(path => redactIf(path)),
      ...(hits.length > 0 ? { breakpointIds: hits } : {}),
      simulated: false,
      ...(options.captureRaw ? { raw: { input: rawOf(call, undefined, summary).input } } : {}),
    }
    if (isRecorded) await addEvent($, event)
    if (plan.kind === 'warn') {
      $.ui.toast(`DevTools: ${plan.warned.map(bp => bp.name).join(', ')} matched ${call.tool}: ${event.inputSummary}`, { timeoutMs: 6000 })
    }

    let preview: PermissionInfo | undefined
    let runStartedMs = startedMs
    if (plan.kind === 'pause') {
      const held = await hold($, next.signal, call, event, plan.reason, plan.at, session.isInteractive)
      if ('answer' in held) return held.answer
      preview = held.permission
      runStartedMs = await $.clock.now()
      // The turn may have been interrupted between the answer and here: a paused call never runs then.
      if (next.signal.aborted) {
        await patch($, id, { status: 'failed', outcome: 'aborted', durationMs: 0, resultSummary: 'not run: aborted' })
        return { deny: refusalText('aborted', call.tool, plan.reason) }
      }
      await patch($, id, { status: 'running', decision: held.decision })
    }

    // The one call into the rest of the chain: permissions, then the tool.
    const result = await next(e)
    try {
      await afterRun($, call, event, isRecorded, runStartedMs, result as ResultLike, preview, cwd)
    } catch (error) {
      debug($, `recording ${call.tool} failed: ${message(error)}`)
    }
    return result
  }).catch(($, e, next) => {
    // Fail closed only where a breakpoint would have held the call; never run anything twice.
    if (next.error.kind === 're-entry') {
      // The pause dialog itself ($.ui.ask) is an AskUserQuestion call raised beneath this hook.
      if (e.tool === 'AskUserQuestion') return next(e)
      const nested = normalizeCall(e as ToolCallLike)
      return wouldPause(mirror.settings, mirror.arm, nested, mirror.cwd) ? { deny: refusalText('guard', e.tool, 'a nested call during a pause') } : next(e)
    }
    if (next.called) return next(e)
    const call = normalizeCall(e as ToolCallLike)
    if (wouldPause(mirror.settings, mirror.arm, call, mirror.cwd)) {
      const detail = next.error.message === undefined ? next.error.kind : `${next.error.kind}: ${next.error.message.slice(0, 160)}`
      return { deny: refusalText('guard', e.tool, detail) }
    }
    return next(e)
  })

  // Observes the permission verdict each real call reaches; changes nothing.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id !== undefined) {
      if (verdicts.size > 200) verdicts.clear()
      verdicts.set(e.tool_use_id, { decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, source: 'observed' })
    }
    return verdict
  })

  on('session.start', async ($, e, next) => {
    let sessionId = ''
    try {
      sessionId = await $.session.id()
    } catch (error) {
      debug($, `no session id: ${message(error)}`)
    }
    await update($, SESSION, () => ({ sessionId, isInteractive: e.isInteractive, cwd: e.cwd, surface: e.surface }))
    mirror.cwd = e.cwd
    await loadSettings($)
    // After a hot reload nothing still holds a call from the old module.
    await update($, TRACE, closeStale)
    await update($, PENDING, () => [])
    await registerCommands($)
    for (const warning of optionWarnings) debug($, warning)
    await refreshStatus($)
    // Unasked, the engine seats the pane only where it docks beside the transcript (144+ columns); narrower, /devtools opens it.
    if (e.isInteractive && options.openOnStart) {
      try {
        await openPane($, false)
      } catch (error) {
        debug($, `could not open the pane: ${message(error)}`)
      }
    }
    return next(e)
  })

  // /clear resets $.state and fires no session.start: keep the session's id and cwd current.
  on('classic.SessionStart', async ($, e, next) => {
    await update($, SESSION, current => ({ ...current, sessionId: e.session_id || current.sessionId, cwd: e.cwd || current.cwd }))
    return next(e)
  })

  on(
    'command.run',
    {
      command: [
        'devtools',
        'devtools-status',
        'devtools-break',
        'devtools-list',
        'devtools-pause',
        'devtools-continue',
        'devtools-disable',
        'devtools-enable',
        'devtools-record',
        'devtools-export',
        'devtools-errors',
        'devtools-help',
        'bp',
        'bpl',
        'bpn',
        'bpc',
        'bpe',
      ],
    },
    async ($, e) => runCommand($, e.command, e.args),
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const [held, hits, arm, trace, pending, view, session, stats, lens, groups] = await Promise.all([
      $.state.get(SETTINGS),
      read($, HITS),
      read($, ARM_ATOM),
      read($, TRACE),
      read($, PENDING),
      read($, VIEW),
      read($, SESSION),
      read($, STATS),
      read($, LENS),
      read($, GROUPS),
    ])
    const settings = withHits(held.value ?? defaultSettings(options), hits)
    const rows = e.props.placement === 'dock' ? e.props.scroll.bodyRows : Math.min(e.props.scroll.bodyRows, 24)
    const layout: Layout = e.props.placement === 'inline' ? 'mini' : e.props.bodyColumns >= 110 ? 'wide' : 'compact'
    const actions: PaneActions = {
      setTab: tab => settle($, setView($, { tab })),
      inspect: id => settle($, setView($, { tab: 'inspector', selectedId: id })),
      page: delta => settle($, movePage($, delta)),
      toggleBreakpoint: id => settle($, editBreakpoint($, 'toggle', id)),
      deleteBreakpoint: id => settle($, editBreakpoint($, 'delete', id)),
      addBreakpoint: spec => settle($, addFromPane($, spec)),
      toggleCategory: category => settle($, toggleCategory($, category)),
      toggleSuggestion: suggestion => settle($, toggleSuggestion($, suggestion)),
      setMode: mode => settle($, setMode($, mode)),
      toggleRecording: () => settle($, toggleRecording($)),
      togglePauseNext: () => settle($, toggleArm($)),
      clearTimeline: () => settle($, clearTimeline($)),
      exportTrace: () => settle($, exportFromPane($)),
      openLens: id => settle($, setView($, { tab: 'errors', lensId: id })),
      clearErrors: () => settle($, clearErrors($)),
    }
    return renderPane(
      els,
      {
        settings,
        arm,
        trace,
        pending,
        view,
        session,
        stats,
        lens,
        groups,
        options,
        columns: e.props.bodyColumns,
        rows: Math.max(6, rows),
        layout,
        hasFields: e.surface !== 'mobile',
      },
      actions,
    )
  })

  // The gutter on each tool row: "break on" this tool, command or path, and a red mark where a rule covers the call.
  // It reads the rules and the cwd only, never the hit counts or the trace, so a tool call redraws no row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const drawn = await next(e)
    if (options.inlineControls === 'off' || e.props.tool === 'AskUserQuestion') return drawn
    const [held, session] = await Promise.all([$.state.get(SETTINGS), read($, SESSION)])
    const settings = held.value ?? defaultSettings(options)
    if (settings.mode === 'off') return drawn
    const cwd = session.cwd === '' ? undefined : session.cwd
    const input = e.props.input !== null && typeof e.props.input === 'object' ? (e.props.input as Record<string, unknown>) : {}
    const call = normalizeCall({ ...input, tool: e.props.tool, tool_use_id: e.props.tool_use_id })
    const matched = settings.breakpoints.filter(bp => bp.enabled && bp.kind !== 'error' && criteriaMatch(bp, call, cwd))
    const offers: Offer[] = suggestBreakpoints(e.props.tool, input, cwd).map(s => ({ ...s, key: `dt-${s.id}`, rule: findRule(settings.breakpoints, s.kind, s.match) }))
    return renderGutter($.ui.resolve(e), drawn, matched, offers, options.inlineControls, offer => settle($, toggleSuggestion($, offer)))
  })

  // A folded run of reads and searches: one "break on" per tool in it.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const drawn = await next(e)
    if (options.inlineControls === 'off' || e.props.isExpanded) return drawn
    const [held, session] = await Promise.all([$.state.get(SETTINGS), read($, SESSION)])
    const settings = held.value ?? defaultSettings(options)
    if (settings.mode === 'off') return drawn
    const cwd = session.cwd === '' ? undefined : session.cwd
    const calls = e.props.calls.map(one => {
      const input = one.input !== null && typeof one.input === 'object' ? (one.input as Record<string, unknown>) : {}
      return normalizeCall({ ...input, tool: one.tool })
    })
    const matched = settings.breakpoints.filter(bp => bp.enabled && bp.kind !== 'error' && calls.some(call => criteriaMatch(bp, call, cwd)))
    const tools = [...new Set(calls.map(call => call.tool))]
    const offers: Offer[] = tools.map(tool => {
      const s = suggestBreakpoints(tool, {}, cwd)[0] as Suggestion
      return { ...s, key: `dt-tool-${tool}`, rule: findRule(settings.breakpoints, s.kind, s.match) }
    })
    return renderGutter($.ui.resolve(e), drawn, matched, offers, options.inlineControls, offer => settle($, toggleSuggestion($, offer)))
  })

  // The bar above the prompt: the latest call, and one key to break on its tool, command or path.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (options.inlineControls === 'off' || e.props.hasSurvey) return below
    const [held, view, trace, session] = await Promise.all([$.state.get(SETTINGS), read($, VIEW), read($, TRACE), read($, SESSION)])
    const settings = held.value ?? defaultSettings(options)
    const last = trace.at(-1)
    if (settings.mode === 'off' || view.barHidden === true) return below
    const cwd = session.cwd === '' ? undefined : session.cwd
    const offers: Offer[] =
      last === undefined ? [] : suggestBreakpoints(last.tool, last.input, cwd).map(s => ({ ...s, key: `bar-${s.id}`, rule: findRule(settings.breakpoints, s.kind, s.match) }))
    return renderBar($.ui.resolve(e), below, last, offers, e.props.bodyColumns, {
      toggle: offer => settle($, toggleSuggestion($, offer)),
      open: () => settle($, openPane($, true)),
      hide: () => settle($, hideBar($)),
      lens: () => last !== undefined && settle($, openLens($, last.id)),
    })
  })
}
