import { describe, expect, test } from 'claude-code/testing'

import type { PermissionsSnapshot } from '../types'
import {
  callDenier,
  checkVerdict,
  describeRefusal,
  explainRefusal,
  guessPlugin,
  type Link,
  permissionsReport,
  readPermissions,
  ruleSource,
  unseenRefusals,
} from '../src/core/permissions.ts'

const engine = (returned: unknown, index = 2): Link => ({ index, plugin: 'engine', tier: 'core', returned })
const mod = (plugin: string, returned: unknown, index = 1, tier = 'user'): Link => ({ index, plugin, tier, returned })

describe('who decided a permission verdict', () => {
  test('the engine alone: its rule, reason and settings hook, no mod named', () => {
    expect(checkVerdict([engine({ decision: 'deny', rule: 'Bash(rm:*)', reason: 'denied by rule' })])).toEqual({
      decision: 'deny',
      rule: 'Bash(rm:*)',
      reason: 'denied by rule',
      source: 'observed',
    })
    expect(checkVerdict([engine({ decision: 'deny', hook: 'PreToolUse', reason: 'blocked' })])).toMatchObject({ decision: 'deny', hook: 'PreToolUse' })
  })

  test('a mod that changed the verdict beneath DevTools is named; one that passed it on is not', () => {
    expect(checkVerdict([mod('policy-mod', { decision: 'deny', reason: 'no deploys' }), engine({ decision: 'ask' })])).toMatchObject({
      decision: 'deny',
      decidedBy: { plugin: 'policy-mod', tier: 'user' },
    })
    expect(checkVerdict([mod('quiet-mod', { decision: 'ask' }), engine({ decision: 'ask' })])).not.toHaveProperty('decidedBy')
    // The innermost link is the baseline, never a decider, whatever it is called.
    expect(checkVerdict([{ index: 3, plugin: 'test', tier: 'builtin', returned: { decision: 'ask', reason: 'r' } }])).toEqual({ decision: 'ask', reason: 'r', source: 'observed' })
    expect(checkVerdict([])).toBeUndefined()
  })
})

describe('who refused a call in the tool.call chain', () => {
  test('the innermost link that returned a deny; those above only passed it on', () => {
    expect(callDenier([mod('outer', { deny: 'x' }, 1), mod('blast-radius', { deny: 'x' }, 2, 'append')])).toEqual({ plugin: 'blast-radius', tier: 'append' })
    expect(callDenier([engine({ deny: 'Permission to use Bash has been denied.' }, 1)])).toEqual({ plugin: 'engine', tier: 'core' })
    expect(callDenier([engine({ result: { stdout: '' } })])).toBeUndefined()
    expect(callDenier([mod('skipped', undefined)])).toBeUndefined()
  })
})

describe('explaining a refusal', () => {
  const base = { text: 'refused', seen: true } as const

  test("DevTools' own refusals are its own", () => {
    expect(explainRefusal({ ...base, outcome: 'debugger-rejected' })).toMatchObject({ by: 'devtools', certainty: 'confirmed' })
    expect(explainRefusal({ ...base, outcome: 'headless-rejected' })).toMatchObject({ by: 'devtools', certainty: 'confirmed' })
  })

  test('a mod named by the call chain is confirmed, with its tier', () => {
    const refusal = explainRefusal({ ...base, outcome: 'blocked-by-hook', text: 'blast-radius: the user pressed Cancel', denier: { plugin: 'blast-radius', tier: 'user' } })
    expect(refusal).toMatchObject({ by: 'mod', plugin: 'blast-radius', tier: 'user', certainty: 'confirmed', reason: 'blast-radius: the user pressed Cancel' })
    expect(refusal.evidence).toContain('blast-radius')
  })

  test('the permission verdict names a rule, a settings hook, a mod or the mode', () => {
    const denied = (extra: object) => explainRefusal({ ...base, outcome: 'permission-denied', permission: { decision: 'deny', source: 'observed', ...extra } })
    expect(denied({ rule: 'Bash(rm:*)' })).toMatchObject({ by: 'rule', rule: 'Bash(rm:*)', certainty: 'confirmed' })
    expect(denied({ hook: 'PreToolUse' })).toMatchObject({ by: 'settings-hook', hook: 'PreToolUse', certainty: 'confirmed' })
    expect(denied({ decidedBy: { plugin: 'policy-mod', tier: 'user' } })).toMatchObject({ by: 'mod', plugin: 'policy-mod', certainty: 'confirmed' })
    expect(denied({ reason: 'Denied in plan mode' })).toMatchObject({ by: 'mode', certainty: 'confirmed' })
    expect(denied({ reason: 'not allowed' })).toMatchObject({ by: 'mode', certainty: 'possible' })
  })

  test('a rejection at the permission prompt is yours', () => {
    expect(explainRefusal({ ...base, outcome: 'permission-denied', text: "The user doesn't want to proceed with this tool use." })).toMatchObject({ by: 'prompt', certainty: 'confirmed' })
    expect(explainRefusal({ ...base, outcome: 'permission-denied', text: 'nope', permission: { decision: 'ask', source: 'observed' } })).toMatchObject({ by: 'prompt', certainty: 'possible' })
  })

  test('Claude Code itself refusing with no permission verdict points at a settings hook, as possible', () => {
    expect(explainRefusal({ ...base, outcome: 'blocked-by-hook', text: 'deploys are blocked', denier: { plugin: 'engine', tier: 'core' } })).toMatchObject({ by: 'settings-hook', certainty: 'possible' })
  })

  test('a call refused before DevTools saw it: the mod is guessed from the text, never confirmed', () => {
    expect(explainRefusal({ outcome: 'blocked-by-hook', text: 'blast-radius: the user pressed Cancel on this command.', seen: false })).toMatchObject({
      by: 'mod',
      plugin: 'blast-radius',
      certainty: 'possible',
    })
    expect(explainRefusal({ outcome: 'blocked-by-hook', text: 'Something refused this.', seen: false })).toMatchObject({ by: 'unknown', certainty: 'possible' })
  })

  test('the reason is kept short', () => {
    expect(explainRefusal({ ...base, outcome: 'blocked-by-hook', text: 'x'.repeat(5000) }).reason.length).toBeLessThanOrEqual(600)
  })
})

describe('guessing a mod from its refusal text', () => {
  test('a leading name: or [name], or "Name held/blocked"', () => {
    expect(guessPlugin('blast-radius: held this command')).toBe('blast-radius')
    expect(guessPlugin('[my-guard] deploys are blocked')).toBe('my-guard')
    expect(guessPlugin('Blast Radius held this command and did not run it')).toBe('Blast Radius')
    expect(guessPlugin('error: something failed')).toBeUndefined()
    expect(guessPlugin('Permission to use Bash has been denied.')).toBeUndefined()
  })
})

describe('tool results refused before DevTools saw the call', () => {
  test('only error results for calls DevTools never saw, not validation errors or interruptions', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 'seen', content: 'refused', is_error: true },
      { type: 'tool_result', tool_use_id: 'ok', content: 'fine' },
      { type: 'tool_result', tool_use_id: 'outer', content: [{ type: 'text', text: 'blast-radius: the user pressed Cancel' }], is_error: true },
      { type: 'tool_result', tool_use_id: 'bad', content: '<tool_use_error>InputValidationError: command is required</tool_use_error>', is_error: true },
      { type: 'tool_result', tool_use_id: 'stop', content: '[Request interrupted by user for tool use]', is_error: true },
      { type: 'text', text: 'hello' },
    ]
    expect(unseenRefusals(content, id => id === 'seen')).toEqual([{ toolUseId: 'outer', text: 'blast-radius: the user pressed Cancel' }])
  })
})

describe('the permission settings', () => {
  const snapshot: PermissionsSnapshot = readPermissions(
    {
      user: { permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(.env)'], defaultMode: 'default', additionalDirectories: ['/extra'] } },
      project: { permissions: { deny: ['Bash(rm -rf:*)'], ask: ['Bash(git push:*)'] } },
      policy: { permissions: { deny: ['Read(.env)'], defaultMode: 'plan' } },
      local: { permissions: { allow: 'not a list', ask: [42] } },
    },
    ['flag: unreadable'],
    1000,
  )

  test('rules keep their behavior and file; the mode comes from the file that wins', () => {
    expect(snapshot.rules).toEqual([
      { behavior: 'deny', rule: 'Read(.env)', source: 'policy' },
      { behavior: 'deny', rule: 'Bash(rm -rf:*)', source: 'project' },
      { behavior: 'deny', rule: 'Read(.env)', source: 'user' },
      { behavior: 'ask', rule: 'Bash(git push:*)', source: 'project' },
      { behavior: 'allow', rule: 'Bash(npm test:*)', source: 'user' },
    ])
    expect(snapshot.defaultMode).toEqual({ mode: 'plan', source: 'policy' })
    expect(snapshot.directories).toEqual([{ path: '/extra', source: 'user' }])
    expect(snapshot.errors).toEqual(['flag: unreadable'])
    expect(snapshot.readAtMs).toBe(1000)
  })

  test('a rule is found in the file that wins', () => {
    expect(ruleSource(snapshot, 'Read(.env)', 'deny')).toBe('policy')
    expect(ruleSource(snapshot, 'Bash(rm -rf:*)')).toBe('project')
    expect(ruleSource(snapshot, 'Bash(x)')).toBeUndefined()
  })

  test('the refusal reads as one line naming who', () => {
    expect(describeRefusal({ by: 'rule', rule: 'Bash(rm -rf:*)', reason: 'r', certainty: 'confirmed', evidence: 'e' }, snapshot)).toBe('rule Bash(rm -rf:*) in .claude/settings.json')
    expect(describeRefusal({ by: 'mod', plugin: 'blast-radius', tier: 'user', reason: 'r', certainty: 'confirmed', evidence: 'e' }, snapshot)).toBe('mod blast-radius (user tier)')
    expect(describeRefusal({ by: 'mod', plugin: 'blast-radius', reason: 'r', certainty: 'possible', evidence: 'e' }, snapshot)).toBe('probably mod blast-radius')
    expect(describeRefusal({ by: 'prompt', reason: 'r', certainty: 'confirmed', evidence: 'e' }, snapshot)).toBe('you, at the permission prompt')
  })

  test('the text report lists the rules and each refusal with its reason', () => {
    const lines = permissionsReport(snapshot, [
      {
        id: 'tu-1',
        tool: 'Bash',
        atMs: Date.UTC(2026, 9, 10, 12, 0, 0),
        inputSummary: 'rm -rf build',
        outcome: 'permission-denied',
        refusal: { by: 'rule', rule: 'Bash(rm -rf:*)', reason: 'Permission denied', certainty: 'confirmed', evidence: 'permission check: deny by the rule Bash(rm -rf:*)' },
      },
    ]).join('\n')
    expect(lines).toContain('Default mode: plan (managed policy)')
    expect(lines).toContain('deny  Read(.env)')
    expect(lines).toContain('Bash rm -rf build')
    expect(lines).toContain('refused by rule Bash(rm -rf:*) in .claude/settings.json (confirmed)')
    expect(lines).toContain('reason: Permission denied')
  })
})
