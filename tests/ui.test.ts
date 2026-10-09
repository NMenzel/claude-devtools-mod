// The pane, the transcript gutter and the bar above the prompt, drawn through
// the mod's real ui.render hooks on each surface's element table and acted on
// by key as a person would.

import { describe, type Engine, expect, test } from 'claude-code/testing'

import { BAR_HINT, barHint } from '../src/ui/inline.tsx'
import { dialog, engineDraws, start, tools, world } from './kit.ts'

const PANE = {
  plugin: 'devtools',
  component: 'Pane',
  requestId: 'devtools',
  viewport: { columns: 140, rows: 40, isFullscreen: true },
  props: {
    title: 'Claude DevTools',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 130, scroll: { offset: 0, bodyRows: 40 } } } as const

function toolRow(tool: string, input: Record<string, unknown>) {
  return {
    plugin: 'devtools',
    component: 'ToolUse',
    requestId: 'toolu_row',
    viewport: { columns: 140, rows: 40, isFullscreen: true },
    props: { tool_use_id: 'toolu_row', tool, input, isRunning: false, isErrored: false, isInterrupted: false },
  } as const
}

const BAND = {
  plugin: 'devtools',
  component: 'AbovePrompt',
  viewport: { columns: 140, rows: 40, isFullscreen: true },
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

async function run($: Engine, command: string, args = ''): Promise<string> {
  return (await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''
}

describe('the DevTools dashboard', () => {
  test('the dashboard: header, legend, breakpoints, calls and timeline panels', async ($, on) => {
    world(on)
    tools(on, e => (e.command === 'npm test' ? { isError: true, result: 'x', text: 'Exit code 1' } : undefined))
    dialog(on, [])
    await start($)
    await run($, 'devtools-break', 'command npm install --action record')
    await $.tool.call({ tool: 'Bash', command: 'npm install lodash' })
    await $.tool.call({ tool: 'Read', file_path: '/work/README.md' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })

    for (const surface of ['terminal', 'desktop'] as const) {
      for (const target of [PANE, WIDE]) {
        const ui = await $.ui.mount({ ...target, surface })
        expect(await ui.find({ type: 'Text', text: 'CLAUDE DEVTOOLS' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: '● active' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: '1 breakpoint' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'BREAKPOINTS' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'CALLS' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'TIMELINE' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: '3 observed' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: '1 failed' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /shell 2 · read 1/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'PAUSED' })).toBeUndefined()
        expect(await ui.find({ type: 'Button', key: 'rule-toggle-bp1', text: /bp1 command npm install/ })).toBeDefined()
        const strip = await ui.findAll({ type: 'Text', text: /^■+$/ })
        expect(strip.map(cell => cell.text).join('')).toBe('■■■')
        const timeline = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('ev-'))
        expect(timeline[0]?.text).toContain('npm test')
        await ui.unmount()
      }
    }
  })

  test('tabs: timeline, inspector with break-on buttons, breakpoints', async ($, on) => {
    world(on)
    tools(on)
    const { asked } = dialog(on, ['Continue'])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'npm install lodash' })
    await $.tool.call({ tool: 'Read', file_path: '/work/src/auth/login.ts' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab-timeline' })
    const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('ev-'))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text).toContain('/work/src/auth/login.ts')

    await ui.press({ key: rows[0]?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: /Read · completed · ok/ })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /"file_path": "\/work\/src\/auth\/login.ts"/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'sug-tool', text: '○ Read' })).toBeDefined()
    await ui.press({ key: 'sug-path' })
    expect(await ui.find({ type: 'Button', key: 'sug-path', text: '● src/auth/login.ts' })).toBeDefined()
    expect(await run($, 'devtools-list')).toContain('path=src/auth/login.ts')
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/auth/login.ts', old_string: 'a', new_string: 'b' })
    expect(asked).toHaveLength(1)

    await ui.press({ key: 'tab-breakpoints' })
    expect(await ui.find({ type: 'Input', key: 'add' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'cat-shell', text: '□ Shell' })).toBeDefined()
    await ui.unmount()
  })

  test('adds, toggles and deletes rules, changes mode, and arms a pause from the pane', async ($, on) => {
    const w = world(on)
    tools(on)
    const { asked } = dialog(on, ['Continue'])
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab-breakpoints' })

    await ui.input({ key: 'add', text: 'file .env* --name secrets' })
    expect(await ui.find({ type: 'Text', text: /Added bp1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /bp1 secrets/ })).toBeDefined()

    await ui.input({ key: 'add', text: 'tool Teleport --action explode' })
    expect(await ui.find({ type: 'Text', text: /Not added: action must be one of/ })).toBeDefined()

    await ui.press({ key: 'bp-toggle-bp1' })
    expect(await ui.find({ type: 'Button', key: 'bp-toggle-bp1', text: 'Enable' })).toBeDefined()
    await $.tool.call({ tool: 'Read', file_path: '/work/.env' })
    expect(asked).toHaveLength(0)

    await ui.select({ key: 'mode', value: 'observe' })
    expect(await ui.find({ type: 'Text', text: '● observe' })).toBeDefined()
    await ui.select({ key: 'mode', value: 'active' })

    await ui.press({ key: 'bp-delete-bp1' })
    expect(await ui.find({ type: 'Text', text: 'No breakpoints yet.' })).toBeDefined()
    expect((w.store.get('settings.v1') as { breakpoints: unknown[] }).breakpoints).toEqual([])

    await ui.press({ key: 'tab-dashboard' })
    await ui.press({ key: 'arm' })
    expect(await ui.find({ type: 'Text', text: 'ARMED' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /the next tool call pauses/ })).toBeDefined()
    await $.tool.call({ tool: 'Glob', pattern: '*.ts' })
    expect(asked).toHaveLength(1)
    expect(await ui.find({ type: 'Button', key: 'arm', text: 'Pause next call' })).toBeDefined()

    await ui.press({ key: 'rec' })
    expect(await ui.find({ type: 'Text', text: '○ not recording' })).toBeDefined()
    await ui.press({ key: 'export' })
    expect(await ui.find({ type: 'Text', text: /Exported 2 events/ })).toBeDefined()
    await ui.unmount()
  })

  test('category toggles work like Chrome event-listener breakpoints', async ($, on) => {
    world(on)
    const ran = tools(on)
    const { asked } = dialog(on, ['Reject'])
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'cat-search' })
    expect(await ui.find({ type: 'Button', key: 'cat-search', text: '■ Search' })).toBeDefined()
    expect(await run($, 'devtools-list')).toContain('Pause on Search')
    await $.tool.call({ tool: 'Grep', pattern: 'TODO', path: '/work/src' })
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    expect(asked).toHaveLength(1)
    expect(ran).toEqual([{ tool: 'Read', file_path: '/work/a.ts' }])
    await ui.press({ key: 'cat-search' })
    expect(await ui.find({ type: 'Button', key: 'cat-search', text: '□ Search' })).toBeDefined()
    expect(await run($, 'devtools-list')).toContain('No breakpoints')
    await ui.unmount()
  })

  test('a paused call shows in a PAUSED panel while the dialog is up', async ($, on) => {
    world(on)
    tools(on)
    let drawn: string | undefined
    // The dialog stub draws the pane through the test's own $ while the call is held.
    on('tool.call', { tool: 'AskUserQuestion' }, async (_, e) => {
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      drawn = [(await ui.find({ type: 'Text', text: 'PAUSED' }))?.text, (await ui.find({ type: 'Text', text: /⏸ Bash/ }))?.text].join(' | ')
      await ui.unmount()
      const question = (e as unknown as { questions: Array<{ question: string }> }).questions[0]?.question ?? ''
      return { result: { questions: [], answers: { [question]: 'Reject' } } }
    })
    await start($)
    await run($, 'devtools-break', 'tool Bash')
    await $.tool.call({ tool: 'Bash', command: 'git push --force' })
    expect(drawn).toBe('PAUSED | ⏸ Bash  git push --force')
  })

  test('inline placement draws the mini summary; narrow rows truncate', async ($, on) => {
    world(on)
    tools(on)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: `echo ${'very-long-argument '.repeat(10)}` })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 32, placement: 'inline', scroll: { offset: 0, bodyRows: 8 } } })
    expect(await ui.find({ type: 'Text', text: /0 breakpoints on/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'BREAKPOINTS' })).toBeUndefined()
    await ui.press({ key: 'tab-timeline' })
    const row = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('ev-'))
    expect((row?.text ?? '').length).toBeLessThanOrEqual(32)
    await ui.unmount()
  })

  test('surfaces without inputs fall back to commands', async ($, on) => {
    world(on)
    tools(on)
    dialog(on, [])
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    await ui.press({ key: 'tab-breakpoints' })
    expect(await ui.find({ type: 'Text', text: /Add rules with \/devtools-break/ })).toBeDefined()
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    await ui.press({ key: 'mode' })
    expect(await ui.find({ type: 'Text', text: '● observe' })).toBeDefined()
    await ui.unmount()
  })
})

describe('breakpoints from the transcript', () => {
  test('a Bash row offers break on tool, command and path, and marks rules that cover it', async ($, on) => {
    world(on)
    engineDraws(on)
    const ran = tools(on)
    const { asked } = dialog(on, ['Reject'])
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...toolRow('Bash', { command: 'npm test -- --watch' }), surface })
      expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'dt-tool', text: '○ Bash' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'dt-command', text: '○ "npm test"' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /● breakpoint/ })).toBeUndefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...toolRow('Bash', { command: 'npm test -- --watch' }), surface: 'terminal' })
    await ui.press({ key: 'dt-command' })
    expect(await ui.find({ type: 'Button', key: 'dt-command', text: '● "npm test"' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● breakpoint bp1 npm test → pause/ })).toBeDefined()
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(asked).toHaveLength(1)
    expect(ran).toEqual([])
    await ui.press({ key: 'dt-command' })
    expect(await ui.find({ type: 'Text', text: /● breakpoint/ })).toBeUndefined()
    expect(await run($, 'devtools-list')).toContain('No breakpoints')
    await ui.unmount()
  })

  test('a Read row offers its path, relative to the project', async ($, on) => {
    world(on)
    engineDraws(on)
    tools(on)
    dialog(on, [])
    await start($)
    const ui = await $.ui.mount({ ...toolRow('Read', { file_path: '/work/prisma/schema.prisma' }), surface: 'terminal' })
    await ui.press({ key: 'dt-path' })
    expect(await run($, 'devtools-list')).toContain('path=prisma/schema.prisma')
    await ui.unmount()
  })

  test('a folded run of reads and searches offers one toggle per tool', async ($, on) => {
    world(on)
    engineDraws(on)
    tools(on)
    dialog(on, [])
    await start($)
    const group = {
      plugin: 'devtools',
      component: 'ToolGroup',
      requestId: 'group',
      viewport: { columns: 140, rows: 40, isFullscreen: true },
      props: {
        calls: [
          { tool_use_id: 'a', tool: 'Read', input: { file_path: '/work/a.ts' }, isRunning: false, isErrored: false, isInterrupted: false },
          { tool_use_id: 'b', tool: 'Grep', input: { pattern: 'x' }, isRunning: false, isErrored: false, isInterrupted: false },
          { tool_use_id: 'c', tool: 'Read', input: { file_path: '/work/b.ts' }, isRunning: false, isErrored: false, isInterrupted: false },
        ],
        isActive: false,
        isExpanded: false,
      },
    } as const
    const ui = await $.ui.mount({ ...group, surface: 'terminal' } as never)
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['dt-tool-Read', 'dt-tool-Grep'])
    await ui.press({ key: 'dt-tool-Grep' })
    expect(await ui.find({ type: 'Text', text: /● breakpoint bp1 Grep calls/ })).toBeDefined()
    await ui.unmount()
  })

  test('by default every row gets a dim "break on" line of its own', async ($, on) => {
    world(on)
    engineDraws(on)
    tools(on)
    dialog(on, [])
    await start($)
    const ui = await $.ui.mount({ ...toolRow('Grep', { pattern: 'TODO', path: '/work/src' }), surface: 'terminal' })
    expect(await ui.find({ type: 'Box', key: 'devtools-gutter' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'break on' })).toMatchObject({ props: { dimColor: true } })
    expect(await ui.find({ type: 'Button', key: 'dt-path', text: '○ src/**' })).toMatchObject({ props: { dimColor: true } })
    await ui.unmount()
  })

  test('inlineControls hover lays the controls over the row only while hovered', { options: { inlineControls: 'hover' } }, async ($, on) => {
    world(on)
    engineDraws(on)
    tools(on)
    dialog(on, [])
    await start($)
    const ui = await $.ui.mount({ ...toolRow('Grep', { pattern: 'TODO', path: '/work/src' }), surface: 'terminal' })
    expect(await ui.find({ type: 'Box', key: 'devtools-gutter' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'dt-path', text: '○ src/**' })).toBeDefined()
    await ui.unmount()
  })

  test('controls hide when the debugger is off', async ($, on) => {
    world(on)
    engineDraws(on)
    tools(on)
    dialog(on, [])
    await start($)
    await run($, 'devtools-disable', 'off')
    const ui = await $.ui.mount({ ...toolRow('Bash', { command: 'ls' }), surface: 'terminal' })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  })

  test('inlineControls off draws Claude Code\'s rows untouched', { options: { inlineControls: 'off' } }, async ($, on) => {
    world(on)
    engineDraws(on)
    tools(on)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const row = await $.ui.mount({ ...toolRow('Bash', { command: 'ls' }), surface: 'terminal' })
    expect(await row.drawn()).toMatchObject({ type: 'Text', children: ['drawn by Claude Code'] })
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Button' })).toBeUndefined()
  })

  test('the bar above the prompt breaks on the latest call by keyboard, opens the pane, hides', async ($, on) => {
    const w = world(on)
    engineDraws(on)
    tools(on)
    dialog(on, [])
    await start($)
    // Before the first call: only a dim hint, how to set a breakpoint and where help is.
    const empty = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await empty.find({ type: 'Button' })).toBeUndefined()
    expect(await empty.find({ type: 'Text', text: /\/devtools-break <rule> · \/devtools-help/ })).toMatchObject({ props: { dimColor: true } })
    await empty.unmount()

    await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    // At 120 columns the longest hint that keeps the bar on one line.
    expect(await ui.find({ type: 'Text', text: '· /devtools-break <rule>' })).toMatchObject({ props: { dimColor: true } })
    const command = await ui.find({ type: 'Button', key: 'bar-command' })
    expect(command?.text).toBe('○ "git push"')
    expect(command?.props.hotkey).toBe('c')
    await ui.press({ key: 'bar-command' })
    expect(await ui.find({ type: 'Button', key: 'bar-command', text: '● "git push"' })).toBeDefined()
    expect(w.toasts.some(t => t.includes('Breakpoint set: git push'))).toBe(true)
    w.opened.length = 0
    await ui.press({ key: 'bar-open' })
    expect(w.opened).toEqual(['devtools'])
    await ui.press({ key: 'bar-hide' })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  })

  test('the bar hint shrinks to fit its line, and disappears before it would wrap', () => {
    expect(barHint(200, 94)).toBe(BAR_HINT)
    expect(barHint(120, 94)).toBe('/devtools-break <rule>')
    expect(barHint(112, 94)).toBe('/devtools-help')
    expect(barHint(110, 94)).toBeUndefined()
  })

  test('the bar yields to a survey', async ($, on) => {
    world(on)
    engineDraws(on)
    tools(on)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
  })
})

describe('commands as the text interface', () => {
  test('the dashboard opens on start in an interactive session, and /devtools opens it asked', async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    expect(w.opened).toEqual(['devtools'])
    expect(await run($, 'devtools')).toContain('Claude DevTools is open')
    expect(w.opened).toEqual(['devtools', 'devtools'])
  })

  test('openOnStart off keeps it closed until asked', { options: { openOnStart: false } }, async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    expect(w.opened).toEqual([])
  })

  test('status, list, help and break subcommands', async ($, on) => {
    world(on)
    tools(on)
    dialog(on, [])
    await start($)
    expect(await run($, 'devtools-help')).toContain('/devtools-break <rule>')
    expect(await run($, 'devtools-list')).toContain('No breakpoints')
    expect(await run($, 'devtools-break')).toContain('Usage')
    expect(await run($, 'devtools-break', 'tool Bash --after 2')).toContain('from hit 2')
    await $.tool.call({ tool: 'Bash', command: 'pwd' })
    expect(await run($, 'devtools-list')).toContain('hits 1')
    expect(await run($, 'devtools-break', 'nonsense')).toContain('Breakpoint not added')
    expect(await run($, 'devtools-break', 'toggle bp1')).toContain('Disabled bp1')
    expect(await run($, 'devtools-break', 'toggle bp9')).toContain('No breakpoint bp9')
    expect(await run($, 'devtools-list')).toContain('bp1 ○')
    expect(await run($, 'devtools-break', 'delete bp1')).toContain('Deleted bp1')
    expect(await run($, 'devtools-break', 'tool Read')).toContain('Added bp1')
    expect(await run($, 'devtools-list')).toContain('hits 0')
    const status = await run($, 'devtools-status')
    expect(status).toContain('mode active')
    expect(status).toContain('1 observed')
    expect(status).toContain('pwd')
  })

  test('export writes JSON and Markdown and refuses unsafe paths', async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const out = await run($, 'devtools-export', 'out/trace.json --md')
    expect(out).toContain('Exported 1 events and 0 Error Lens records (secrets redacted)')
    const paths = [...w.writes.keys()]
    expect(paths.some(path => /out[\\/]trace\.json$/.test(path))).toBe(true)
    expect(paths.some(path => /out[\\/]trace\.md$/.test(path))).toBe(true)
    expect(await run($, 'devtools-export', '../../etc/x.json')).toContain('Export refused')
    expect(await run($, 'devtools-export', 'trace.exe')).toContain('Export refused')
  })
})
