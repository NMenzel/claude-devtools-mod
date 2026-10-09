import { describe, expect, test } from 'claude-code/testing'

import type { Breakpoint } from '../types'
import { CATEGORIES, commandHead, familyOf, findCategoryRule, findRule, relativePath, suggestBreakpoints, withHits } from '../src/core/suggest.ts'

const ruleOf = (kind: Breakpoint['kind'], match: Breakpoint['match'], id = 'bp1'): Breakpoint => ({ id, name: id, enabled: true, kind, match, scope: 'all', action: 'pause', hitCount: 0 })

describe('suggested breakpoints', () => {
  test('a command keeps its program and subcommand, past env assignments and sudo', () => {
    expect(commandHead('npm install lodash --save')).toBe('npm install')
    expect(commandHead('NODE_ENV=test FOO=[REDACTED] sudo npm test -- --watch')).toBe('npm test')
    expect(commandHead('git push --force origin main')).toBe('git push')
    expect(commandHead('ls -la')).toBe('ls')
    expect(commandHead('./deploy.sh staging && echo ok')).toBe('./deploy.sh staging')
    expect(commandHead('   ')).toBeUndefined()
  })

  test('paths are offered relative to the project, directories as dir/**', () => {
    expect(relativePath('/work/src/a.ts', '/work')).toBe('src/a.ts')
    expect(relativePath('C:\\Work\\src\\a.ts', 'c:/work')).toBe('src/a.ts')
    expect(relativePath('/elsewhere/a.ts', '/work')).toBe('/elsewhere/a.ts')
    expect(suggestBreakpoints('Read', { file_path: '/work/src/a.ts' }, '/work').map(s => [s.id, s.label])).toEqual([
      ['tool', 'Read'],
      ['path', 'src/a.ts'],
    ])
    expect(suggestBreakpoints('Grep', { pattern: 'x', path: '/work/src' }, '/work')[1]?.match).toEqual({ path: 'src/**' })
    expect(suggestBreakpoints('Glob', { pattern: '**/*.ts' }, '/work')).toHaveLength(1)
    expect(suggestBreakpoints('Bash', { command: 'npm test' })[1]).toMatchObject({ id: 'command', label: '"npm test"', match: { command: 'npm test' } })
    expect(suggestBreakpoints('mcp__github__create_issue', { title: 'x' })).toHaveLength(1)
  })

  test('an existing rule is found whatever the order of its tools', () => {
    const rules = [ruleOf('tool', { tools: ['Glob', 'Grep'] }), ruleOf('command', { command: 'npm test' }, 'bp2')]
    expect(findCategoryRule(rules, CATEGORIES.find(c => c.id === 'search') ?? CATEGORIES[0]!)?.id).toBe('bp1')
    expect(findRule(rules, 'command', { command: 'npm test' })?.id).toBe('bp2')
    expect(findRule(rules, 'file', { path: 'npm test' })).toBeUndefined()
  })

  test('families and hit merging', () => {
    expect(['Bash', 'Read', 'Grep', 'Edit', 'WebFetch', 'Agent', 'mcp__x__y', 'TodoWrite'].map(familyOf)).toEqual(['shell', 'read', 'search', 'edit', 'web', 'agent', 'mcp', 'other'])
    const merged = withHits({ breakpoints: [ruleOf('tool', { tools: ['Bash'] }), ruleOf('tool', { tools: ['Read'] }, 'bp2')] }, { bp1: 3 })
    expect(merged.breakpoints.map(bp => bp.hitCount)).toEqual([3, 0])
  })
})
