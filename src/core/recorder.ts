// The bounded timeline and its exports: a ring buffer of trace events, a
// versioned JSON export with a validator, and a readable Markdown report.

import type { Breakpoint, Certainty, DevtoolsMode, DevtoolsStats, ErrorGroup, LensRecord, TraceEvent, TraceOutcome, TraceStatus } from '../../types'
import { describeBreakpoint } from './breakpoints.ts'
import { lensReport } from './lens.ts'

export const TRACE_SCHEMA = 'claude-devtools.trace'
/** 2: adds Error Lens (`errors`, `errorGroups`). */
export const TRACE_SCHEMA_VERSION = 2
/** Kept under $.fs.write's 4 MiB per file. */
export const MAX_EXPORT_BYTES = 3_500_000

/** Appends, dropping the oldest past `max`. */
export function appendBounded<T>(list: readonly T[], item: T, max: number): T[] {
  const next = [...list, item]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Applies a patch to one event by id; an id no longer in the ring is ignored. */
export function patchEvent(list: readonly TraceEvent[], id: string, patch: Partial<TraceEvent>): TraceEvent[] {
  return list.map(event => (event.id === id ? { ...event, ...patch } : event))
}

/** After a reload no hook still holds a call: what was pending or running is closed as aborted. */
export function closeStale(list: readonly TraceEvent[]): TraceEvent[] {
  return list.map(event =>
    event.status === 'pending' || event.status === 'running'
      ? { ...event, status: 'failed', outcome: 'aborted', errorText: 'Closed by Claude DevTools: the mod reloaded while this call was in flight.' }
      : event,
  )
}

export type TraceExport = {
  schema: typeof TRACE_SCHEMA
  schemaVersion: typeof TRACE_SCHEMA_VERSION
  generator: { name: string; version: string }
  exportedAt: string
  sessionId: string
  redaction: boolean
  rawCapture: boolean
  mode: DevtoolsMode
  /** Events dropped to keep the file under the size limit, oldest first. */
  droppedEvents: number
  stats: DevtoolsStats
  breakpoints: Array<Pick<Breakpoint, 'id' | 'name' | 'kind' | 'enabled' | 'action' | 'scope' | 'match' | 'hitCount'>>
  events: TraceEvent[]
  /** Error Lens: the diagnosed failures, oldest first. */
  errors: LensRecord[]
  /** Error Lens: repeated failures grouped by signature, most recent first. */
  errorGroups: ErrorGroup[]
}

export function buildExport(args: {
  version: string
  exportedAt: string
  sessionId: string
  redaction: boolean
  rawCapture: boolean
  mode: DevtoolsMode
  stats: DevtoolsStats
  breakpoints: readonly Breakpoint[]
  events: readonly TraceEvent[]
  errors?: readonly LensRecord[]
  errorGroups?: readonly ErrorGroup[]
}): TraceExport {
  return {
    schema: TRACE_SCHEMA,
    schemaVersion: TRACE_SCHEMA_VERSION,
    generator: { name: 'devtools', version: args.version },
    exportedAt: args.exportedAt,
    sessionId: args.sessionId,
    redaction: args.redaction,
    rawCapture: args.rawCapture,
    mode: args.mode,
    droppedEvents: 0,
    stats: args.stats,
    breakpoints: args.breakpoints.map(({ id, name, kind, enabled, action, scope, match, hitCount }) => ({ id, name, kind, enabled, action, scope, match, hitCount })),
    events: [...args.events],
    errors: [...(args.errors ?? [])],
    errorGroups: [...(args.errorGroups ?? [])],
  }
}

/** `mayReplace`: the target is in the export folder, the only place an existing file may be replaced. */
export type ExportPaths = { ok: true; json: string; markdown?: string; mayReplace: boolean } | { ok: false; error: string }

const EXPORT_FOLDER = '.claude-devtools'

/** Files coding agents read as instructions; an export never writes one. */
const INSTRUCTIONS_FILE = /(^|[\\/])(claude|claude\.local|agents|gemini)\.md$/i

/**
 * Where `/devtools-export [path] [--md]` writes. A path is the person's own
 * input, so it is checked: a .json or .md name, no `..` segment, no control
 * characters, no unexpanded `~` or environment variable, no hidden file or folder (where settings and tool configuration
 * live) but the export folder, no instructions file; a relative path lands
 * under the session's working directory. Outside the export folder the
 * caller refuses to replace an existing file, so no build, settings or
 * instructions file is ever overwritten.
 */
export function exportPaths(arg: string | undefined, cwd: string, stamp: string, wantsMarkdown: boolean): ExportPaths {
  const root = cwd.replace(/[\\/]+$/, '')
  const target = arg === undefined || arg === '' ? `${EXPORT_FOLDER}/trace-${stamp}.json` : arg
  if (/[\u0000-\u001f]/.test(target)) return { ok: false, error: 'the export path holds a control character' }
  // Nothing expands these here, so `~/t.json` would land in a folder named `~` under the working directory.
  if (/^~|\$[A-Za-z_{(]|%[A-Za-z_][A-Za-z0-9_]*%/.test(target)) {
    return { ok: false, error: 'the export path uses ~ or an environment variable, which are not expanded: give the full path' }
  }
  const segments = target.split(/[\\/]/).filter(part => part !== '' && part !== '.')
  if (segments.includes('..')) return { ok: false, error: 'the export path may not contain ".." segments' }
  if (segments.some(part => part.startsWith('.') && part !== EXPORT_FOLDER)) {
    return { ok: false, error: `the export path may not name a hidden file or folder other than ${EXPORT_FOLDER}/` }
  }
  const isAbsolutePath = /^([a-zA-Z]:[\\/]|[\\/])/.test(target)
  const full = isAbsolutePath ? target : `${root}/${target}`
  const lower = full.toLowerCase()
  let paths: { json: string; markdown?: string }
  if (lower.endsWith('.json')) paths = { json: full, ...(wantsMarkdown ? { markdown: `${full.slice(0, -5)}.md` } : {}) }
  else if (lower.endsWith('.md')) paths = { json: `${full.slice(0, -3)}.json`, markdown: full }
  else return { ok: false, error: 'the export path must end in .json or .md' }
  if (paths.markdown !== undefined && INSTRUCTIONS_FILE.test(paths.markdown)) {
    return { ok: false, error: 'the export path names an instructions file (CLAUDE.md, AGENTS.md, GEMINI.md)' }
  }
  return { ok: true, ...paths, mayReplace: !isAbsolutePath && segments[0] === EXPORT_FOLDER }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Serializes, dropping the oldest events until the text fits `maxBytes`. */
export function serializeExport(trace: TraceExport, maxBytes = MAX_EXPORT_BYTES): string {
  let current = trace
  let text = JSON.stringify(current, null, 2)
  while (byteLength(text) > maxBytes && current.events.length > 0) {
    const drop = Math.max(1, Math.ceil(current.events.length / 10))
    current = { ...current, events: current.events.slice(drop), droppedEvents: current.droppedEvents + drop }
    text = JSON.stringify(current, null, 2)
  }
  return text
}

const CERTAINTIES: readonly Certainty[] = ['confirmed', 'possible', 'unknown']
const STATUSES: readonly TraceStatus[] = ['pending', 'running', 'completed', 'failed', 'denied', 'simulated']
const OUTCOMES: readonly TraceOutcome[] = [
  'ok',
  'tool-error',
  'permission-denied',
  'blocked-by-hook',
  'debugger-rejected',
  'user-cancelled',
  'headless-rejected',
  'simulated',
  'timeout',
  'aborted',
  'guard-failed',
]

/** Checks a parsed export against the schema; returns the problems, empty when valid. */
export function validateExport(value: unknown): string[] {
  const problems: string[] = []
  if (value === null || typeof value !== 'object') return ['the export is not an object']
  const x = value as Record<string, unknown>
  if (x.schema !== TRACE_SCHEMA) problems.push(`schema must be "${TRACE_SCHEMA}"`)
  if (x.schemaVersion !== TRACE_SCHEMA_VERSION) problems.push(`schemaVersion must be ${TRACE_SCHEMA_VERSION}`)
  if (typeof x.exportedAt !== 'string' || Number.isNaN(Date.parse(x.exportedAt))) problems.push('exportedAt must be an ISO time')
  if (typeof x.sessionId !== 'string') problems.push('sessionId must be a string')
  if (typeof x.redaction !== 'boolean') problems.push('redaction must be a boolean')
  if (!Array.isArray(x.breakpoints)) problems.push('breakpoints must be an array')
  if (!Array.isArray(x.errorGroups)) problems.push('errorGroups must be an array')
  if (!Array.isArray(x.errors)) problems.push('errors must be an array')
  else
    x.errors.forEach((raw, i) => {
      const r = raw as Record<string, unknown>
      const at = `errors[${i}]`
      if (typeof r.id !== 'string' || r.id === '') problems.push(`${at}.id must be a non-empty string`)
      if (typeof r.tool !== 'string' || r.tool === '') problems.push(`${at}.tool must be a non-empty string`)
      if (typeof r.category !== 'string' || r.category === '') problems.push(`${at}.category must be a non-empty string`)
      if (typeof r.message !== 'string') problems.push(`${at}.message must be a string`)
      if (!Array.isArray(r.causes) || r.causes.some(c => !CERTAINTIES.includes((c as { certainty?: Certainty }).certainty as Certainty))) {
        problems.push(`${at}.causes must be an array of causes with a known certainty`)
      }
      if (!Array.isArray(r.probes)) problems.push(`${at}.probes must be an array`)
    })
  if (!Array.isArray(x.events)) return [...problems, 'events must be an array']
  x.events.forEach((raw, i) => {
    const e = raw as Record<string, unknown>
    const at = `events[${i}]`
    if (typeof e.id !== 'string' || e.id === '') problems.push(`${at}.id must be a non-empty string`)
    if (typeof e.tool !== 'string' || e.tool === '') problems.push(`${at}.tool must be a non-empty string`)
    if (!STATUSES.includes(e.status as TraceStatus)) problems.push(`${at}.status is not a known status`)
    if (e.outcome !== undefined && !OUTCOMES.includes(e.outcome as TraceOutcome)) problems.push(`${at}.outcome is not a known outcome`)
    if (typeof e.startedAt !== 'string' || Number.isNaN(Date.parse(e.startedAt))) problems.push(`${at}.startedAt must be an ISO time`)
    if (typeof e.simulated !== 'boolean') problems.push(`${at}.simulated must be a boolean`)
    if (e.simulated === true && e.status !== 'simulated') problems.push(`${at} is simulated but its status is ${String(e.status)}`)
    if (e.durationMs !== undefined && (typeof e.durationMs !== 'number' || e.durationMs < 0)) problems.push(`${at}.durationMs must be a non-negative number`)
  })
  return problems
}

const ICON: Record<TraceStatus, string> = {
  pending: '⏸',
  running: '…',
  completed: '✓',
  failed: '✗',
  denied: '⊘',
  simulated: '◇',
}

export function statusIcon(status: TraceStatus): string {
  return ICON[status]
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** A readable report of an export. */
export function exportToMarkdown(trace: TraceExport): string {
  const lines = [
    '# Claude DevTools trace',
    '',
    `- Session: \`${trace.sessionId || 'unknown'}\``,
    `- Exported: ${trace.exportedAt}`,
    `- Mode: ${trace.mode} · redaction ${trace.redaction ? 'on' : 'OFF'} · raw capture ${trace.rawCapture ? 'ON' : 'off'}`,
    `- Calls observed: ${trace.stats.observed} · failed ${trace.stats.failed} · denied ${trace.stats.denied} · simulated ${trace.stats.simulated} · paused ${trace.stats.paused}`,
    ...(trace.droppedEvents > 0 ? [`- ${trace.droppedEvents} oldest events dropped to fit the file size limit`] : []),
    '',
    '## Breakpoints',
    '',
    ...(trace.breakpoints.length === 0
      ? ['None.']
      : trace.breakpoints.map(bp => `- \`${bp.id}\` ${bp.enabled ? '●' : '○'} **${cell(bp.name)}**: ${cell(describeBreakpoint(bp))} · hits ${bp.hitCount}`)),
    '',
    '## Timeline',
    '',
    '| # | Time | Status | Tool | Agent | Duration | Input | Result |',
    '| - | - | - | - | - | - | - | - |',
    ...trace.events.map(e =>
      [
        '',
        String(e.seq),
        e.startedAt,
        `${ICON[e.status]} ${e.status}${e.outcome !== undefined && e.outcome !== 'ok' ? ` (${e.outcome})` : ''}${e.simulated ? ' **SIMULATED**' : ''}`,
        cell(e.tool),
        e.agentId ?? 'main',
        formatDuration(e.durationMs),
        `\`${cell(e.inputSummary)}\``,
        cell(e.errorText ?? e.resultSummary ?? ''),
        '',
      ].join(' | ').trim(),
    ),
    '',
    '## Error Lens',
    '',
    ...(trace.errors.length === 0 ? ['No failed tool calls.', ''] : []),
    ...(trace.errorGroups.some(group => group.count > 1)
      ? ['| Count | Tool | Kind | Error |', '| - | - | - | - |', ...trace.errorGroups.map(g => `| ${g.count} | ${cell(g.tool)} | ${g.category} | ${cell(g.headline)} |`), '']
      : []),
    // A fence inside quoted error text would end the block early.
    ...trace.errors.flatMap(record => ['```text', ...lensReport(record).map(line => line.replace(/`{3,}/g, "'''")), '```', '']),
  ]
  return lines.join('\n')
}
