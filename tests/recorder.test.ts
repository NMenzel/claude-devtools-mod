import { describe, expect, test } from 'claude-code/testing'

import type { TraceEvent } from '../types'
import { DEFAULT_OPTIONS, parseOptions, parsePersisted, toPersisted } from '../src/config/schema.ts'
import { parseBreakpointSpec } from '../src/core/breakpoints.ts'
import {
  appendBounded,
  buildExport,
  closeStale,
  exportPaths,
  exportToMarkdown,
  patchEvent,
  serializeExport,
  validateExport,
} from '../src/core/recorder.ts'

function event(seq: number, extra: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `t${seq}`,
    seq,
    sessionId: 's',
    tool: 'Bash',
    scope: 'main',
    status: 'completed',
    outcome: 'ok',
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    startedAtMs: seq * 1000,
    risk: 'exec',
    inputSummary: `echo ${seq}`,
    simulated: false,
    ...extra,
  }
}

const STATS = { observed: 3, completed: 2, failed: 0, denied: 0, simulated: 1, paused: 1 }

describe('the ring buffer', () => {
  test('keeps at most max events, dropping the oldest', () => {
    let list: TraceEvent[] = []
    for (let i = 1; i <= 25; i += 1) list = appendBounded(list, event(i), 10)
    expect(list).toHaveLength(10)
    expect(list[0]?.seq).toBe(16)
    expect(list.at(-1)?.seq).toBe(25)
  })

  test('patches by id and ignores ids that left the ring', () => {
    const list = [event(1), event(2)]
    expect(patchEvent(list, 't2', { status: 'failed' })[1]?.status).toBe('failed')
    expect(patchEvent(list, 'gone', { status: 'failed' })).toEqual(list)
  })

  test('a reload closes calls left pending or running as aborted', () => {
    const closed = closeStale([event(1, { status: 'pending' }), event(2, { status: 'running' }), event(3)])
    expect(closed.map(e => e.outcome)).toEqual(['aborted', 'aborted', 'ok'])
    expect(closed[0]?.status).toBe('failed')
  })
})

describe('exports', () => {
  const bp = parseBreakpointSpec('command npm install', 'bp1', 'all')
  if (!bp.ok) throw new Error(bp.error)
  const built = buildExport({
    version: '0.1.0',
    exportedAt: '2026-10-08T12:00:00.000Z',
    sessionId: 's',
    redaction: true,
    rawCapture: false,
    mode: 'active',
    stats: STATS,
    breakpoints: [bp.breakpoint],
    events: [event(1), event(2, { status: 'simulated', outcome: 'simulated', simulated: true }), event(3, { status: 'denied', outcome: 'debugger-rejected' })],
  })

  test('the JSON export is valid and round-trips', () => {
    const parsed = JSON.parse(serializeExport(built))
    expect(validateExport(parsed)).toEqual([])
    expect(parsed.schema).toBe('claude-devtools.trace')
    expect(parsed.events).toHaveLength(3)
  })

  test('the validator catches broken exports', () => {
    expect(validateExport({ ...built, schemaVersion: 1 })).toContain('schemaVersion must be 2')
    expect(validateExport({ ...built, errors: undefined })).toContain('errors must be an array')
    expect(validateExport({ ...built, errors: [{ id: 'x', tool: 'Bash', category: 'unknown', message: '', probes: [], causes: [{ certainty: 'likely' }] }] })[0]).toMatch(/known certainty/)
    expect(validateExport({ ...built, events: [{ ...event(1), simulated: true }] })[0]).toMatch(/simulated but its status/)
    expect(validateExport({ ...built, events: [{ ...event(1), status: 'exploded' }] })[0]).toMatch(/status/)
    expect(validateExport('nope')).toEqual(['the export is not an object'])
  })

  test('oversized exports drop the oldest events and say so', () => {
    const big = { ...built, events: Array.from({ length: 200 }, (_, i) => event(i, { inputSummary: 'x'.repeat(500) })) }
    const text = serializeExport(big, 20_000)
    const parsed = JSON.parse(text)
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(20_000)
    expect(parsed.droppedEvents).toBeGreaterThan(0)
    expect(parsed.events.at(-1).seq).toBe(199)
    expect(validateExport(parsed)).toEqual([])
  })

  test('the Markdown report labels simulated events', () => {
    const md = exportToMarkdown(built)
    expect(md).toContain('# Claude DevTools trace')
    expect(md).toContain('**SIMULATED**')
    expect(md).toContain('debugger-rejected')
    expect(md).toContain('`bp1`')
  })

  test('export paths are validated', () => {
    expect(exportPaths(undefined, '/work', 'STAMP', false)).toEqual({ ok: true, json: '/work/.claude-devtools/trace-STAMP.json' })
    expect(exportPaths('out/t.md', 'C:\\repo\\', 'S', false)).toEqual({ ok: true, json: 'C:\\repo/out/t.json', markdown: 'C:\\repo/out/t.md' })
    expect(exportPaths('t.json', '/w', 'S', true)).toEqual({ ok: true, json: '/w/t.json', markdown: '/w/t.md' })
    expect(exportPaths('../escape.json', '/w', 'S', false).ok).toBe(false)
    expect(exportPaths('trace.txt', '/w', 'S', false).ok).toBe(false)
    expect(exportPaths('a\u0007.json', '/w', 'S', false).ok).toBe(false)
  })
})

describe('configuration', () => {
  test('options are validated and clamped', () => {
    const { options, warnings } = parseOptions({ maxTimelineEntries: 999_999, maxSummaryChars: 'long', headlessPause: 'maybe', simulation: true })
    expect(options.maxTimelineEntries).toBe(5000)
    expect(options.maxSummaryChars).toBe(DEFAULT_OPTIONS.maxSummaryChars)
    expect(options.headlessPause).toBe('reject')
    expect(options.simulation).toBe(true)
    expect(warnings.length).toBeGreaterThanOrEqual(3)
    expect(parseOptions(undefined).options).toEqual(DEFAULT_OPTIONS)
  })

  test('persisted settings round-trip, invalid rules are dropped, hit counts reset', () => {
    const bp = parseBreakpointSpec('file .env*', 'bp1', 'all')
    if (!bp.ok) throw new Error(bp.error)
    const saved = toPersisted({ mode: 'observe', recording: false, breakpoints: [{ ...bp.breakpoint, hitCount: 9 }] })
    const raw = JSON.parse(JSON.stringify({ ...saved, breakpoints: [...saved.breakpoints, { id: 'bad', kind: 'nope' }] }))
    const { settings, warnings } = parsePersisted(raw, DEFAULT_OPTIONS)
    expect(settings.mode).toBe('observe')
    expect(settings.recording).toBe(false)
    expect(settings.breakpoints).toHaveLength(1)
    expect(settings.breakpoints[0]?.hitCount).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(parsePersisted({ schemaVersion: 99 }, DEFAULT_OPTIONS).settings.breakpoints).toEqual([])
  })
})
