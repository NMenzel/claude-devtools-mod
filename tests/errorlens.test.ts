// Error Lens through the mod's real hooks: failures diagnosed passively (the
// result Claude gets is untouched, nothing reruns), read-only checks after the
// fact, grouping, notifications, the Errors tab and sanitized exports.

import { describe, type Engine, expect, test } from 'claude-code/testing'

import type { LensRecord } from '../types'
import { validateExport, type TraceExport } from '../src/core/recorder.ts'
import { dialog, engineDraws, start, tools, world, type World } from './kit.ts'

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0)

const PANE = {
  plugin: 'devtools',
  component: 'Pane',
  requestId: 'devtools',
  viewport: { columns: 140, rows: 40, isFullscreen: true },
  props: { title: 'Claude DevTools', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BAND = {
  plugin: 'devtools',
  component: 'AbovePrompt',
  viewport: { columns: 140, rows: 40, isFullscreen: true },
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

async function run($: Engine, command: string, args = ''): Promise<string> {
  return (await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''
}

async function exported($: Engine, w: World): Promise<TraceExport> {
  w.writes.clear()
  await run($, 'devtools-export', 'trace.json --md')
  const text = [...w.writes].find(([path]) => /[\\/]work[\\/]trace\.json$/.test(path))?.[1]
  if (text === undefined) throw new Error('no export written')
  const parsed = JSON.parse(text) as TraceExport
  expect(validateExport(parsed)).toEqual([])
  return parsed
}

function only(t: TraceExport): LensRecord {
  expect(t.errors).toHaveLength(1)
  return t.errors[0] as LensRecord
}

const ENOENT = { isError: true, result: 'x', text: "ENOENT: no such file or directory, open '/work/src/missing.ts'" } as const

describe('Error Lens: capture', () => {
  test('a successful call leaves no record and no notification', async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await w.clock.settle()
    expect(await run($, 'devtools-errors')).toBe('Error Lens: no failed tool calls this session.')
    const t = await exported($, w)
    expect(t.errors).toEqual([])
    expect(t.events[0]?.errorCategory).toBeUndefined()
    expect(w.toasts.some(text => text.includes('DevTools ✗'))).toBe(false)
    expect(w.statted).toEqual([])
  })

  test('a failed Read: the result is unchanged, the tool ran once, the failure is diagnosed and checked read-only', async ($, on) => {
    const w = world(on)
    w.files.set('/work/src', { kind: 'dir', size: 0, mtimeMs: T0 - 60_000 })
    const ran = tools(on, () => ENOENT)
    dialog(on, [])
    await start($)
    const result = await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    expect(result).toMatchObject(ENOENT)
    expect(ran).toHaveLength(1)
    expect(w.toasts.some(text => text.startsWith('DevTools ✗ Read failed (not-found)') && text.includes('/devtools-errors'))).toBe(true)

    await w.clock.settle()
    expect(w.statted.map(path => path.replace(/\\/g, '/'))).toEqual(expect.arrayContaining([expect.stringMatching(/\/work\/src\/missing\.ts$/), expect.stringMatching(/\/work\/src$/)]))
    const t = await exported($, w)
    const record = only(t)
    expect(record).toMatchObject({ tool: 'Read', category: 'not-found', code: 'ENOENT', status: 'failed', outcome: 'tool-error', probeState: 'done' })
    expect(record.probes).toEqual([
      { path: '/work/src/missing.ts', role: 'target', exists: false },
      expect.objectContaining({ path: '/work/src', role: 'parent', exists: true, kind: 'dir' }),
    ])
    expect(record.causes.filter(one => one.certainty === 'confirmed').map(one => one.text)).toEqual(
      expect.arrayContaining(['/work/src/missing.ts does not exist.', 'The parent directory exists, so only the file itself is missing.']),
    )
    expect(t.events[0]?.errorCategory).toBe('not-found')
    expect(t.errorGroups).toEqual([expect.objectContaining({ tool: 'Read', category: 'not-found', count: 1 })])
    const md = [...w.writes].find(([path]) => path.endsWith('trace.md'))?.[1] ?? ''
    expect(md).toContain('## Error Lens')
    expect(md).toContain('✗ Read · not-found (ENOENT)')

    const text = await run($, 'devtools-errors')
    expect(text).toContain('1× Read · not-found')
    expect(text).toContain('CONFIRMED')
    expect(text).toContain('checks (read-only, after the failure)')
  })

  test('a failed Write that landed anyway is reported as possible, from the file it finds', async ($, on) => {
    const w = world(on)
    w.files.set('/work/out.txt', { kind: 'file', size: 5, mtimeMs: T0 })
    w.files.set('/work', { kind: 'dir', size: 0, mtimeMs: T0 - 60_000 })
    tools(on, () => ({ isError: true, result: 'x', text: "EBUSY: resource busy or locked, open '/work/out.txt'" }))
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Write', file_path: '/work/out.txt', content: 'hello' })
    await w.clock.settle()
    const record = only(await exported($, w))
    expect(record).toMatchObject({ category: 'busy', contentBytes: 5 })
    expect(record.causes.some(one => one.certainty === 'possible' && one.text.includes('may have landed despite the reported error'))).toBe(true)
    // The record keeps the size, never the content.
    expect(JSON.stringify(record)).not.toContain('hello')
  })

  test('a permission denial and a hook refusal are told apart; the hook stays unknown', async ($, on) => {
    const w = world(on)
    tools(on, e =>
      e.command === 'rm -rf build' ? { deny: 'Permission to use Bash with command rm -rf build has been denied.' } : { deny: 'my-guard: deploys are blocked here' },
    )
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    await $.tool.call({ tool: 'Bash', command: 'npm run deploy' })
    await w.clock.settle()
    const t = await exported($, w)
    expect(t.errors.map(r => [r.status, r.outcome, r.category])).toEqual([
      ['denied', 'permission-denied', 'permission-denied'],
      ['denied', 'blocked-by-hook', 'blocked-by-hook'],
    ])
    expect(t.errors[0]?.causes.map(one => one.certainty)).toEqual(['possible', 'unknown'])
    expect(t.errors[1]?.causes.map(one => one.certainty)).toEqual(['confirmed', 'unknown'])
    expect(w.toasts.some(text => text.startsWith('DevTools ✗ Bash denied (permission-denied)'))).toBe(true)
    expect(w.statted).toEqual([])
  })

  test('an ambiguous failure stays unknown; an MCP success that reads like an error is only suspected', async ($, on) => {
    const w = world(on)
    // The file and its folder are there and untouched: the checks add no cause.
    w.files.set('/work/a.ts', { kind: 'file', size: 10, mtimeMs: T0 - 60_000 })
    w.files.set('/work', { kind: 'dir', size: 0, mtimeMs: T0 - 60_000 })
    tools(on, e => (e.tool === 'Edit' ? { isError: true, result: 'x', text: 'Something odd happened' } : { result: 'Error: rate limited, try later' }))
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
    const mcp = await $.tool.call({ tool: 'mcp__tracker__create', title: 'x' } as never)
    expect(mcp).toMatchObject({ result: 'Error: rate limited, try later' })
    await w.clock.settle()
    const t = await exported($, w)
    expect(t.errors.map(r => r.category)).toEqual(['unknown', 'suspected'])
    expect(t.errors[0]?.causes.every(one => one.certainty === 'unknown')).toBe(true)
    expect(t.errors[1]).toMatchObject({ suspected: true, status: 'completed' })
    // A suspected failure keeps its call counted as completed.
    expect(t.stats.completed).toBe(1)
    expect(w.toasts.some(text => text.includes('mcp__tracker__create may have failed (suspected)'))).toBe(true)
  })

  test('repeats are grouped and announced only on the first and every fifth', async ($, on) => {
    const w = world(on)
    tools(on, () => ({ isError: true, result: 'x', text: 'Exit code 1\nnpm ERR! missing script: lint' }))
    dialog(on, [])
    await start($)
    for (let i = 0; i < 6; i += 1) await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
    const announced = w.toasts.filter(text => text.startsWith('DevTools ✗ Bash failed'))
    expect(announced).toHaveLength(2)
    expect(announced[1]).toContain('5× this session')
    const t = await exported($, w)
    expect(t.errors).toHaveLength(6)
    expect(t.errorGroups).toEqual([expect.objectContaining({ count: 6, category: 'exit-code' })])
  })

  test('refusals at a breakpoint are kept but not announced', async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, ['Reject'])
    await start($)
    await run($, 'devtools-break', 'tool Bash')
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const record = only(await exported($, w))
    expect(record).toMatchObject({ category: 'debugger', outcome: 'debugger-rejected' })
    expect(w.toasts.some(text => text.startsWith('DevTools ✗'))).toBe(false)
  })

  test('recording off: failures are still diagnosed', async ($, on) => {
    const w = world(on)
    tools(on, () => ENOENT)
    dialog(on, [])
    await start($)
    await run($, 'devtools-record', 'off')
    await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    const t = await exported($, w)
    expect(t.events).toEqual([])
    expect(only(t).category).toBe('not-found')
  })

  test('recording off: a failure kept for an error breakpoint still links to its diagnosis', async ($, on) => {
    const w = world(on)
    tools(on, () => ENOENT)
    dialog(on, [])
    await start($)
    await run($, 'devtools-record', 'off')
    await run($, 'devtools-break', 'error Read')
    await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    const t = await exported($, w)
    expect(t.events).toHaveLength(1)
    expect(t.events[0]?.errorCategory).toBe('not-found')
  })

  test('secrets in the error and the arguments are redacted in records and exports', async ($, on) => {
    const w = world(on)
    // Joined at run time so the source holds no token-shaped string for secret scanners to flag.
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')
    tools(on, () => ({ isError: true, result: 'x', text: `Exit code 1\nauth failed for token ${token}` }))
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: `GITHUB_TOKEN=${token} gh repo view` })
    const t = await exported($, w)
    const all = [...w.writes.values()].join('\n')
    expect(all).not.toContain(token)
    expect(only(t).message).toContain('[REDACTED]')
  })

  test('/devtools-errors clear empties the lens', async ($, on) => {
    const w = world(on)
    tools(on, () => ENOENT)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    expect(await run($, 'devtools-errors', 'clear')).toBe('Error Lens cleared.')
    expect((await exported($, w)).errors).toEqual([])
  })
})

describe('Error Lens: options', () => {
  test('errorLens off records nothing and never checks a file', { options: { errorLens: 'off' } }, async ($, on) => {
    const w = world(on)
    tools(on, () => ENOENT)
    dialog(on, [])
    await start($)
    const result = await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    expect(result).toMatchObject(ENOENT)
    await w.clock.settle()
    expect(w.statted).toEqual([])
    expect((await exported($, w)).errors).toEqual([])
    expect(await run($, 'devtools-errors')).toContain('Error Lens is off')
  })

  test('errorLens classify diagnoses without touching the file system', { options: { errorLens: 'classify' } }, async ($, on) => {
    const w = world(on)
    tools(on, () => ENOENT)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    await w.clock.settle()
    expect(w.statted).toEqual([])
    expect(only(await exported($, w))).toMatchObject({ category: 'not-found', probeState: 'off', probes: [] })
  })

  test('errorToasts off keeps failures quiet', { options: { errorToasts: false } }, async ($, on) => {
    const w = world(on)
    tools(on, () => ENOENT)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    expect(w.toasts.some(text => text.startsWith('DevTools ✗'))).toBe(false)
    expect(only(await exported($, w)).category).toBe('not-found')
  })
})

describe('Error Lens: the Errors tab', () => {
  test('confirmed, possible and unknown causes, checks and fixes; reached from the timeline, the inspector and the bar', async ($, on) => {
    const w = world(on)
    w.files.set('/work/src', { kind: 'dir', size: 0, mtimeMs: T0 - 60_000 })
    engineDraws(on)
    tools(on, e => (e.tool === 'Read' ? ENOENT : undefined))
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    await w.clock.settle()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: 'ERRORS' })).toBeDefined()
      await ui.press({ key: 'err-0' })
      expect(await ui.find({ type: 'Text', text: /✗ Read failed · not-found \(ENOENT\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Code', text: /ENOENT: no such file or directory/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✔ CONFIRMED' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '? POSSIBLE' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /parent \/work\/src: directory/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1\. / })).toBeDefined()
      await ui.press({ key: 'lens-inspect' })
      expect(await ui.find({ type: 'Text', text: /Read · failed · tool-error/ })).toBeDefined()
      await ui.press({ key: 'open-lens' })
      expect(await ui.find({ type: 'Button', key: 'lens-clear' })).toBeDefined()
      await ui.press({ key: 'tab-timeline' })
      const why = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('why-'))
      expect(why).toBeDefined()
      await ui.press({ key: why?.key ?? '' })
      expect(await ui.find({ type: 'Text', text: '✔ CONFIRMED' })).toBeDefined()
      await ui.press({ key: 'tab-dashboard' })
      await ui.unmount()
    }

    const bar = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await bar.find({ type: 'Button', key: 'bar-lens', text: '✗ why? (not-found)' })).toBeDefined()
    await bar.press({ key: 'bar-lens' })
    expect(w.opened).toContain('devtools')
    await bar.unmount()
  })

  test('the tab lists repeats and walks failures; Clear empties it', async ($, on) => {
    const w = world(on)
    tools(on, e => (e.command === 'npm run lint' ? { isError: true, result: 'x', text: 'Exit code 1\nnpm ERR! missing script: lint' } : ENOENT))
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
    await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
    await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab-errors' })
    expect(await ui.find({ type: 'Button', key: 'tab-errors', text: 'Errors 3' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'REPEATED' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✗ Read failed/ })).toBeDefined()
    await ui.press({ key: 'lens-older' })
    expect(await ui.find({ type: 'Text', text: /✗ Bash failed · exit-code \(exit 1\)/ })).toBeDefined()
    await ui.press({ key: 'grp-0' })
    expect(await ui.find({ type: 'Text', text: /2 of 3/ })).toBeDefined()
    await ui.press({ key: 'lens-clear' })
    expect(await ui.find({ type: 'Text', text: /No failed tool calls yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('/devtools-errors opens the pane on the Errors tab', async ($, on) => {
    const w = world(on)
    tools(on, () => ENOENT)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/missing.ts' })
    w.opened.length = 0
    await run($, 'devtools-errors')
    expect(w.opened).toEqual(['devtools'])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /✗ Read failed · not-found/ })).toBeDefined()
    await ui.unmount()
  })
})
