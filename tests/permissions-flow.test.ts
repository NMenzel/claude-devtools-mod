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
      const ran = tools(on)
      dialog(on, [])
      await start($)
      await $.tool.call({ tool: 'Bash', command: 'git reset --hard', tool_use_id: 'tu-2' })
      expect(ran).toEqual([])
      // Claude Code then stores the refusal as the call's tool result.
      await $.session.append({
        message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'blast-radius: the user pressed Cancel on this command.', is_error: true }] },
        door: 'tool-result',
        origin: { kind: 'tool', tool: 'Bash' },
        uuid: 'row-2',
      })
      const text = await run($, 'bpp')
      expect(text).toContain('refused by probably mod blast-radius (possible)')
      expect(text).toContain("refused before Claude DevTools' hook ran")
    },
  )

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
