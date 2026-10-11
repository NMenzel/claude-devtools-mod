// The Permissions view through the real hooks: who refused a call, read from
// the chain's trace, the permission verdict and rows refused above DevTools.

import { describe, type Engine, expect, test } from 'claude-code/testing'

import { dialog, start, tools, world } from './kit.ts'

async function run($: Engine, command: string, args = ''): Promise<string> {
  const out = await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  return out.text ?? ''
}

describe('who refused a call', () => {
  test(
    'a mod beneath DevTools is named from the call chain, confirmed',
    {
      plugins: [
        {
          name: 'blast-radius',
          tier: 'append',
          register(on) {
            on('tool.call', { tool: 'Bash' }, () => ({ deny: 'blast-radius: the user pressed Cancel on this command. It would have: delete build/.' }))
          },
        },
      ],
    },
    async ($, on) => {
      world(on)
      tools(on)
      dialog(on, [])
      await start($)
      const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'tu-1' })
      expect(result).toMatchObject({ deny: expect.stringContaining('blast-radius') })
      const text = await run($, 'devtools-permissions')
      expect(text).toContain('Bash rm -rf build')
      expect(text).toContain('refused by mod blast-radius (append tier) (confirmed)')
      expect(text).toContain('reason: blast-radius: the user pressed Cancel on this command.')
      // Error Lens names it too, instead of "unknown".
      const errors = await run($, 'devtools-errors')
      expect(errors).toContain('blast-radius')
      expect(errors).not.toContain('Which hook or mod refused it')
    },
  )

  test(
    'a mod seated above DevTools: its refusal is caught from the tool result, as possible',
    {
      plugins: [
        {
          name: 'blast-radius',
          tier: 'prepend',
          register(on) {
            on('tool.call', { tool: 'Bash' }, () => ({ deny: 'blast-radius: the user pressed Cancel on this command.' }))
          },
        },
      ],
    },
    async ($, on) => {
      world(on)
      // The conversation, as Claude Code keeps it: the call's input is read from here when its refusal arrives.
      let reads = 0
      on('session.messages', () => {
        reads += 1
        const uses = [
          { tool_use_id: 'tu-2', tool: 'Bash', input: { command: 'git reset --hard' } },
          { tool_use_id: 'tu-2b', tool: 'Bash', input: { command: 'git clean -fdx' } },
        ]
        return { value: [{ role: 'assistant', text: '', toolUses: uses }] }
      })
      const ran = tools(on)
      dialog(on, [])
      await start($)
      await $.tool.call({ tool: 'Bash', command: 'git reset --hard', tool_use_id: 'tu-2' })
      await $.tool.call({ tool: 'Bash', command: 'git clean -fdx', tool_use_id: 'tu-2b' })
      expect(ran).toEqual([])
      // Claude Code then stores both refusals as the calls' tool results, in one row.
      const refused = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'blast-radius: the user pressed Cancel on this command.', is_error: true })
      await $.session.append({
        message: { type: 'user', role: 'user', content: [refused('tu-2'), refused('tu-2b')] },
        door: 'tool-result',
        origin: { kind: 'tool', tool: 'Bash' },
        uuid: 'row-2',
      })
      const text = await run($, 'bpp')
      // The refused command is named, read from the model's tool_use block; the list says its times are UTC.
      expect(text).toContain('newest first, times in UTC:')
      expect(text).toContain('✗ 12:00:00 Bash git reset --hard')
      expect(text).toContain('✗ 12:00:00 Bash git clean -fdx')
      expect(text).toContain('refused by probably mod blast-radius (possible)')
      expect(text).toContain("refused before Claude DevTools' hook ran")
      // The conversation is read once for the row, not once per refusal.
      expect(reads).toBe(1)
    },
  )

  test('a call DevTools\' own guard refused is recorded, confirmed as DevTools', async ($, on) => {
    // The clock fails while the call is held, so the guard refuses it; it works again for the tool result.
    // Its words ("is not available") read like a tool that is not there, which is no refusal for anyone else.
    let isClockBroken = false
    on('clock.now', () => (isClockBroken ? { deny: '$.clock is not available' } : { value: Date.UTC(2026, 9, 8, 12, 0, 0) }))
    world(on, {}, false)
    const ran = tools(on)
    dialog(on, [])
    await start($)
    await run($, 'devtools-break', 'command rm -rf')
    isClockBroken = true
    const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'tu-8' })
    isClockBroken = false
    expect(result).toMatchObject({ deny: expect.stringContaining('breakpoint guard failed') })
    expect((result as { deny: string }).deny).toContain('is not available')
    expect(ran).toEqual([])
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-8', content: (result as { deny: string }).deny, is_error: true }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: 'row-8',
    })
    const text = await run($, 'bpp')
    expect(text).toContain('refused by Claude DevTools (your breakpoint) (confirmed)')
    expect(text).toContain('evidence: Claude DevTools recorded its own decision')
    // It was never recorded, and pressing it says so.
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab-permissions' })
    await ui.press({ key: 'den-tu-8' })
    expect(await ui.find({ type: 'Text', text: /guard refused the call before it was recorded/ })).toBeDefined()
    await ui.unmount()
  })

  test('a rejection and its note reach Claude even when clearing the pause fails', async ($, on) => {
    let isPendingBroken = false
    on('state.set', ($, e, next) => (isPendingBroken && (e as { key?: string }).key === 'pending' ? { deny: 'state unavailable' } : next(e)))
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      isPendingBroken = true
      const question = (e as unknown as { questions: Array<{ question: string }> }).questions[0]?.question ?? ''
      return { result: { questions: [], answers: { [question]: 'use git clean instead' } } }
    })
    world(on)
    const ran = tools(on)
    await start($)
    await run($, 'devtools-break', 'command rm -rf')
    const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'tu-15' })
    isPendingBroken = false
    expect(result).toMatchObject({ deny: expect.stringContaining('Their note: "use git clean instead"') })
    expect(ran).toEqual([])
  })

  test('a call rejected at its pause, whose hook then failed, is recorded once', async ($, on) => {
    // Reject is pressed and its refusal kept; then counting it fails, so the hook fails and the guard refuses it too.
    let isStatsBroken = false
    on('state.set', ($, e, next) => (isStatsBroken && (e as { key?: string }).key === 'stats' ? { deny: 'state unavailable' } : next(e)))
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      isStatsBroken = true
      const question = (e as unknown as { questions: Array<{ question: string }> }).questions[0]?.question ?? ''
      return { result: { questions: [], answers: { [question]: 'Reject' } } }
    })
    world(on)
    tools(on)
    await start($)
    await run($, 'devtools-break', 'command rm -rf')
    const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'tu-10' })
    isStatsBroken = false
    expect(result).toMatchObject({ deny: expect.stringContaining('breakpoint guard failed') })
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-10', content: (result as { deny: string }).deny, is_error: true }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: 'row-10',
    })
    const text = await run($, 'bpp')
    expect(text.match(/✗ \d\d:\d\d:\d\d Bash/g)).toHaveLength(1)
    expect(text).toContain('the developer rejected this Bash call')
  })

  test('a guard refusal is recorded even if the debugger was turned off before its result arrived', async ($, on) => {
    let isClockBroken = false
    on('clock.now', () => (isClockBroken ? { deny: 'clock unavailable' } : { value: Date.UTC(2026, 9, 8, 12, 0, 0) }))
    world(on, {}, false)
    tools(on)
    dialog(on, [])
    await start($)
    await run($, 'devtools-break', 'command rm -rf')
    isClockBroken = true
    const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'tu-16' })
    isClockBroken = false
    await run($, 'devtools-disable', 'off')
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-16', content: (result as { deny: string }).deny, is_error: true }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: 'row-16',
    })
    expect(await run($, 'bpp')).toContain('refused by Claude DevTools (your breakpoint) (confirmed)')
  })

  test('a refusal at a pause is kept when the clock fails as it is recorded', async ($, on) => {
    let isClockBroken = false
    on('clock.now', () => (isClockBroken ? { deny: 'clock unavailable' } : { value: Date.UTC(2026, 9, 8, 12, 0, 0) }))
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      isClockBroken = true
      const question = (e as unknown as { questions: Array<{ question: string }> }).questions[0]?.question ?? ''
      return { result: { questions: [], answers: { [question]: 'Reject' } } }
    })
    world(on, {}, false)
    tools(on)
    await start($)
    await run($, 'devtools-break', 'command rm -rf')
    const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'tu-11' })
    isClockBroken = false
    expect(result).toMatchObject({ deny: expect.stringContaining('the developer rejected') })
    const text = await run($, 'bpp')
    expect(text).toContain('✗ 12:00:00 Bash rm -rf /tmp/x')
    expect(text).toContain('refused by Claude DevTools (your breakpoint) (confirmed)')
  })

  test('the guard answers with each call\'s own plan, not a snapshot another call moved', async ($, on) => {
    let isClockBroken = false
    on('clock.now', () => (isClockBroken ? { deny: 'clock unavailable' } : { value: Date.UTC(2026, 9, 8, 12, 0, 0) }))
    world(on, {}, false)
    const ran = tools(on)
    dialog(on, [])
    await start($)
    await run($, 'devtools-break', 'tool Bash --after 3')
    await $.tool.call({ tool: 'Bash', command: 'ls first', tool_use_id: 'tu-12' })
    // Two parallel calls: the first counted is hit 2 (it runs), the second hit 3 (it pauses). Both hooks then fail.
    isClockBroken = true
    const results = await Promise.all([
      $.tool.call({ tool: 'Bash', command: 'ls a', tool_use_id: 'tu-13' }),
      $.tool.call({ tool: 'Bash', command: 'ls b', tool_use_id: 'tu-14' }),
    ])
    isClockBroken = false
    expect(results.filter(one => typeof (one as { deny?: unknown }).deny === 'string')).toHaveLength(1)
    expect(ran).toHaveLength(2)
  })

  test('a guard refusal after the call was recorded closes its timeline event and reaches Error Lens', async ($, on) => {
    let isClockBroken = false
    on('clock.now', () => (isClockBroken ? { deny: 'clock unavailable' } : { value: Date.UTC(2026, 9, 8, 12, 0, 0) }))
    // Continue is pressed, then the clock fails before the call is let through.
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      isClockBroken = true
      const question = (e as unknown as { questions: Array<{ question: string }> }).questions[0]?.question ?? ''
      return { result: { questions: [], answers: { [question]: 'Continue' } } }
    })
    world(on, {}, false)
    const ran = tools(on)
    await start($)
    await run($, 'devtools-break', 'command rm -rf')
    const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'tu-9' })
    isClockBroken = false
    expect(result).toMatchObject({ deny: expect.stringContaining('breakpoint guard failed') })
    expect(ran).toEqual([])
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-9', content: (result as { deny: string }).deny, is_error: true }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: 'row-9',
    })
    const text = await run($, 'bpp')
    expect(text).toContain('Bash rm -rf /tmp/x')
    expect(text).toContain('refused by Claude DevTools (your breakpoint) (confirmed)')
    expect(await run($, 'devtools-status')).toContain('1 denied')
    expect(await run($, 'devtools-errors')).toContain('Bash')
  })

  test('a permission rule is named with the settings file that holds it', async ($, on) => {
    const w = world(on)
    w.verdict = { decision: 'deny', rule: 'Bash(rm -rf:*)', reason: 'Permission to use Bash with command rm -rf build has been denied.' }
    w.settings.project = { permissions: { deny: ['Bash(rm -rf:*)'] } }
    tools(on, () => ({ isError: true, result: 'x', text: 'Permission to use Bash with command rm -rf build has been denied.' }))
    dialog(on, [])
    await start($)
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu-3' })
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'tu-3' })
    const text = await run($, 'devtools-permissions')
    expect(text).toContain('refused by rule Bash(rm -rf:*) in .claude/settings.json (confirmed)')
    expect(text).toContain('✗ deny  Bash(rm -rf:*)  · .claude/settings.json')
  })

  test('a tool result for a call DevTools saw, or that did not fail, adds nothing', async ($, on) => {
    world(on)
    tools(on)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu-4' })
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-4', content: 'ok', is_error: true }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: 'row-4',
    })
    expect(await run($, 'devtools-permissions')).toContain('Refused calls: none this session.')
  })
})

const PANE = {
  plugin: 'devtools',
  component: 'Pane',
  requestId: 'devtools',
  viewport: { columns: 140, rows: 40, isFullscreen: true },
  props: { title: 'Claude DevTools', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

describe('the Permissions tab', () => {
  test(
    'shows each refused call with who refused it and why, then the rules; a call opens its Error Lens',
    {
      plugins: [
        {
          name: 'blast-radius',
          tier: 'append',
          register(on) {
            on('tool.call', { tool: 'Bash' }, () => ({ deny: 'blast-radius: the user pressed Cancel on this command.' }))
          },
        },
      ],
    },
    async ($, on) => {
      const w = world(on)
      w.settings.project = { permissions: { ask: ['Bash(git push:*)'] } }
      tools(on)
      dialog(on, [])
      await start($)
      await $.tool.call({ tool: 'Bash', command: 'git reset --hard', tool_use_id: 'tu-6' })
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      await ui.press({ key: 'tab-permissions' })
      expect(await ui.find({ type: 'Button', key: 'tab-permissions', text: /Permissions 1/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'den-tu-6', text: /Bash git reset --hard/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /✔ by mod blast-radius \(append tier\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /"blast-radius: the user pressed Cancel on this command\."/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Bash\(git push:\*\)/ })).toBeDefined()
      // Rules are read again on Reload.
      w.settings.project = { permissions: { ask: ['Bash(git push:*)'], deny: ['Read(.env)'] } }
      await ui.press({ key: 'perm-reload' })
      expect(await ui.find({ type: 'Text', text: /Read\(\.env\)/ })).toBeDefined()
      await ui.press({ key: 'den-tu-6' })
      expect(await ui.find({ type: 'Text', text: /The mod blast-radius \(append tier\) refused the call/ })).toBeDefined()
      await ui.unmount()
    },
  )
})

describe('the Permissions tab on narrow panes and other surfaces', () => {
  test(
    'rows fit 32 columns inline, and the tab draws on desktop and mobile',
    {
      plugins: [
        {
          name: 'blast-radius',
          tier: 'append',
          register(on) {
            on('tool.call', { tool: 'Bash' }, () => ({ deny: 'blast-radius: the user pressed Cancel on this command, which would have deleted many files.' }))
          },
        },
      ],
    },
    async ($, on) => {
      const w = world(on)
      w.settings.user = { permissions: { allow: ['Bash(npm run some-very-long-script-name --with --many --flags:*)'] } }
      tools(on)
      dialog(on, [])
      await start($)
      await $.tool.call({ tool: 'Bash', command: `rm -rf ${'very-long-path/'.repeat(8)}`, tool_use_id: 'tu-7' })
      const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 32, placement: 'inline', scroll: { offset: 0, bodyRows: 8 } } })
      await narrow.press({ key: 'tab-permissions' })
      const row = await narrow.find({ type: 'Button', key: 'den-tu-7' })
      expect((row?.text ?? '').length).toBeLessThanOrEqual(32)
      expect((await narrow.find({ type: 'Text', text: /^REFUSED CALLS/ }))?.text.length).toBeLessThanOrEqual(32)
      for (const text of (await narrow.findAll({ type: 'Text' })).map(one => one.text)) expect(text.length).toBeLessThanOrEqual(40)
      // A rule row's mark, rule and file fit the pane together.
      const ruleRow = (await narrow.findAll({ type: 'Text' })).map(one => one.text)
      const at = ruleRow.findIndex(text => text.startsWith('allow'))
      expect([' ✓', ruleRow[at], ruleRow[at + 1]].join(' ').length).toBeLessThanOrEqual(32)
      await narrow.unmount()
      for (const surface of ['desktop', 'mobile'] as const) {
        const ui = await $.ui.mount({ ...PANE, surface })
        await ui.press({ key: 'tab-permissions' })
        expect(await ui.find({ type: 'Text', text: /by mod blast-radius/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Bash\(npm run some-very-long/ })).toBeDefined()
        await ui.unmount()
      }
    },
  )
})

describe('the current permissions', () => {
  test('every settings file is read, its rules listed with where they come from; /bpp is the same', async ($, on) => {
    const w = world(on)
    w.settings.user = { permissions: { allow: ['Bash(npm test:*)'], defaultMode: 'acceptEdits' } }
    w.settings.policy = { permissions: { deny: ['Read(.env)'] } }
    tools(on)
    dialog(on, [])
    await start($)
    const text = await run($, 'devtools-permissions')
    expect(text).toContain('Default mode: acceptEdits (~/.claude/settings.json)')
    expect(text).toContain('✗ deny  Read(.env)  · managed policy 🔒')
    expect(text).toContain('✓ allow Bash(npm test:*)  · ~/.claude/settings.json')
    expect(await run($, 'bpp')).toBe(text)
  })

  test('a settings file that cannot be read is named, its error redacted', async ($, on) => {
    const w = world(on)
    const key = ['sk-', 'ant-api03-ABCDEFGHIJKLMNOPQRSTUV'].join('')
    w.settingsErrors.user = `Unexpected token } in JSON at position 41: {"env": {"ANTHROPIC_API_KEY": "${key}"}`
    tools(on)
    dialog(on, [])
    await start($)
    const text = await run($, 'bpp')
    expect(text).toMatch(/Not read: user: .*Unexpected token.*\[REDACTED\]/)
    expect(text).not.toContain('ant-api03')
  })

  test('nothing is read or recorded in off mode', async ($, on) => {
    world(on)
    tools(on)
    dialog(on, [])
    await start($)
    await run($, 'devtools-disable', 'off')
    await $.session.append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-5', content: 'blast-radius: no', is_error: true }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: 'row-5',
    })
    expect(await run($, 'devtools-permissions')).toContain('Refused calls: none this session.')
  })
})
