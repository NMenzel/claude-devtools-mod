// The debugger's decisions as pure functions: whether a call pauses, what the
// pause dialog offers, what an answer means, and how a finished call is
// classified. The native layer executes these decisions; it decides nothing.

import type { ArmState, Breakpoint, DevtoolsSettings, PauseDecision, PermissionInfo, RiskLevel, TraceOutcome, TraceStatus } from '../../types'
import { countHits, evaluateCall, evaluateError } from './breakpoints.ts'
import { asRecord, type NormalizedCall, type ResultLike } from './events.ts'
import { withHits } from './suggest.ts'

export const DISARMED: ArmState = { pauseNext: false, step: false }

/** Calls stepping and pause-next never stop on: a question already holds the person. */
const NOT_STEPPABLE: readonly string[] = ['AskUserQuestion']

export type CallPlan =
  | { kind: 'pass' }
  | { kind: 'record'; hits: Breakpoint[] }
  | { kind: 'warn'; hits: Breakpoint[]; warned: Breakpoint[] }
  | { kind: 'pause'; hits: Breakpoint[]; at?: Breakpoint; reason: string }

export type Planned = { plan: CallPlan; arm: ArmState }

declare const COUNTED: unique symbol

/**
 * Rules whose hit counts include the call being planned: the only rules
 * planning takes, so a call is never planned uncounted. Made by `counted`
 * (counts the native layer wrote) or `countCall` (a snapshot, counted here).
 */
export type Counted = DevtoolsSettings & { readonly [COUNTED]: true }

/** The rules with the counts an atomic count of this call returned; with none, nothing the call matches to count. */
export function counted(settings: DevtoolsSettings, counts?: Readonly<Record<string, number>>): Counted {
  return (counts === undefined ? settings : withHits(settings, counts)) as Counted
}

/** A snapshot that predates the call, with the call counted: one more hit on each rule it matches. */
export function countCall(settings: DevtoolsSettings, call: NormalizedCall, cwd?: string): Counted {
  const ids = evaluateCall(settings.breakpoints, call, cwd).hits.map(bp => bp.id)
  return { ...settings, breakpoints: countHits(settings.breakpoints, ids) } as Counted
}

/**
 * Decides what happens to a call before it runs. `active` pauses on pause
 * rules and on an armed step; `observe` downgrades every pause to a record
 * and leaves the arm alone; `off` passes everything untouched.
 */
export function planCall(settings: Counted, arm: ArmState, call: NormalizedCall, cwd?: string): Planned {
  if (settings.mode === 'off') return { plan: { kind: 'pass' }, arm }
  const evaluation = evaluateCall(settings.breakpoints, call, cwd)
  const hits = evaluation.hits
  if (settings.mode === 'active') {
    const at = evaluation.effective.find(bp => bp.action === 'pause')
    // A pause at a breakpoint also satisfies an armed step; an unarmed arm keeps its identity (no write).
    if (at !== undefined) return { plan: { kind: 'pause', hits, at, reason: `breakpoint "${at.name}"` }, arm: arm.pauseNext || arm.step ? DISARMED : arm }
    if ((arm.pauseNext || arm.step) && !NOT_STEPPABLE.includes(call.tool)) {
      const reason = arm.step ? 'step' : arm.reason !== undefined ? `pause-next (${arm.reason})` : 'pause-next'
      return { plan: { kind: 'pause', hits, reason }, arm: DISARMED }
    }
  }
  const warned = evaluation.effective.filter(bp => bp.action === 'warn')
  if (warned.length > 0) return { plan: { kind: 'warn', hits, warned }, arm }
  if (hits.length > 0) return { plan: { kind: 'record', hits }, arm }
  return { plan: { kind: 'pass' }, arm }
}

export type ErrorPlan = { arm: ArmState; triggered: Breakpoint[] }

/**
 * After a failed call: error rules surface the failure, and an error rule
 * whose action is pause arms a pause on the next eligible call (a call that
 * already ran is never paused after the fact).
 */
export function planAfterError(settings: Counted, arm: ArmState, call: NormalizedCall, cwd?: string): ErrorPlan {
  if (settings.mode === 'off') return { arm, triggered: [] }
  const evaluation = evaluateError(settings.breakpoints, call, cwd)
  if (evaluation.hits.length === 0) return { arm, triggered: [] }
  const pauses = settings.mode === 'active' && evaluation.effective.some(bp => bp.action === 'pause')
  return {
    arm: pauses ? { pauseNext: true, step: false, reason: `after ${call.tool} failed` } : arm,
    triggered: evaluation.effective,
  }
}

export const LABELS = { continue: 'Continue', step: 'Step', reject: 'Reject', simulate: 'Simulate' } as const

export type PauseQuestion = { question: string; options: string[]; header: string }

export function pauseQuestion(args: {
  tool: string
  summary: string
  reason: string
  risk: RiskLevel
  agentId?: string
  permission?: PermissionInfo
  canSimulate: boolean
}): PauseQuestion {
  const permission = args.permission === undefined ? '' : `, permission ${args.permission.decision}${args.permission.rule !== undefined ? ` by ${args.permission.rule}` : ''}`
  const agent = args.agentId === undefined ? '' : ` in subagent ${args.agentId}`
  const options: string[] = [LABELS.continue, LABELS.step, LABELS.reject]
  if (args.canSimulate) options.push(LABELS.simulate)
  return {
    header: 'DevTools',
    options,
    question: `Paused at ${args.reason}: ${args.tool}${agent} wants to run ${args.summary} (risk ${args.risk}${permission}). Continue runs it through the normal permission checks; Step runs it and pauses on the next call. What should happen?`,
  }
}

export type Interpreted = { decision: PauseDecision; note?: string }

/** Maps the dialog's answer to a decision. Anything unrecognized rejects, keeping the typed text as a note. */
export function interpretAnswer(answer: string, simulateOffered: boolean): Interpreted {
  const text = answer.trim()
  if (text === LABELS.continue) return { decision: 'continue' }
  if (text === LABELS.step) return { decision: 'step' }
  if (text === LABELS.reject) return { decision: 'reject' }
  if (text === LABELS.simulate && simulateOffered) return { decision: 'simulate' }
  return { decision: 'reject', note: text.slice(0, 500) }
}

export type RefusalKind = 'debugger' | 'cancelled' | 'headless' | 'aborted' | 'guard'

/** What Claude reads when the debugger keeps a call from running: what happened and what to do next. */
export function refusalText(kind: RefusalKind, tool: string, reason: string, note?: string): string {
  switch (kind) {
    case 'debugger':
      return `Claude DevTools: the developer rejected this ${tool} call at ${reason}, so it did not run.${note !== undefined && note !== '' ? ` Their note: "${note}".` : ''} Choose a different approach or ask the user how to proceed.`
    case 'cancelled':
      return `Claude DevTools: this ${tool} call was held at ${reason} and the question was dismissed, so it did not run. Ask the user how to proceed before retrying it.`
    case 'headless':
      return `Claude DevTools: ${reason} requires an interactive decision, but this session has nobody to ask (headless), so the ${tool} call did not run. To let such calls through in headless runs, set the devtools option headlessPause to "record-only" or disable the breakpoint.`
    case 'aborted':
      return `Claude DevTools: the turn was interrupted while this ${tool} call was paused at ${reason}; it did not run.`
    case 'guard':
      return `Claude DevTools: its breakpoint guard failed (${reason}), so this ${tool} call was not run to keep the breakpoint's promise. Retry, or turn the debugger off with /devtools-disable off.`
  }
}

const INTERRUPTED = /\[Request interrupted|interrupted by (the )?user|was interrupted|operation was aborted/i
const PERMISSION_REJECTED =
  /doesn't want to proceed|tool use was rejected|permission to use .{1,120} (?:has been|was) denied|denied by (?:a |the )?(?:permission )?(?:rule|policy|settings)|blocked by (?:a |the )?(?:permission|policy)/i

export type Classified = { status: TraceStatus; outcome: TraceOutcome }

/**
 * Tells a tool failure from a permission denial, a hook's refusal and an
 * interrupted call. Permission verdicts come from tool.check when observed;
 * the text patterns are a documented fallback. A deny the call chain shows a
 * mod returned is that mod's, whatever its words.
 */
export function classifyResult(result: ResultLike, permission?: PermissionInfo, isDeniedByMod = false): Classified {
  if (typeof result.deny === 'string') {
    if (isDeniedByMod) return { status: 'denied', outcome: 'blocked-by-hook' }
    return { status: 'denied', outcome: permission?.decision === 'deny' || PERMISSION_REJECTED.test(result.deny) ? 'permission-denied' : 'blocked-by-hook' }
  }
  if (result.isError === true) {
    const text = typeof result.text === 'string' ? result.text : String(result.result ?? '')
    const record = asRecord(result.result)
    if (record.interrupted === true || INTERRUPTED.test(text)) return { status: 'failed', outcome: 'aborted' }
    if (permission?.decision === 'deny' || PERMISSION_REJECTED.test(text)) return { status: 'denied', outcome: 'permission-denied' }
    return { status: 'failed', outcome: 'tool-error' }
  }
  const record = asRecord(result.result)
  if (record.interrupted === true) return { status: 'failed', outcome: 'aborted' }
  return { status: 'completed', outcome: 'ok' }
}

/**
 * Whether a call would have been held, judged from a settings snapshot alone
 * (no state reads): the fail-closed check a `.catch` handler runs when the
 * guard itself failed before deciding.
 */
export function wouldPause(settings: DevtoolsSettings | undefined, arm: ArmState | undefined, call: NormalizedCall, cwd?: string): boolean {
  if (settings === undefined || settings.mode !== 'active') return false
  // The snapshot's counts predate this call: count it, as the hook would have.
  return planCall(countCall(settings, call, cwd), arm ?? DISARMED, call, cwd).plan.kind === 'pause'
}
