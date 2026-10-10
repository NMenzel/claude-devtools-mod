import { describe, expect, test } from 'claude-code/testing'

import type { Breakpoint } from '../types'
import {
  compileCommandPattern,
  compileGuardedRegex,
  describeBreakpoint,
  evaluateCall,
  evaluateError,
  matchPath,
  nextBreakpointId,
  normalizePath,
  parseBreakpointSpec,
  tokenize,
  validateBreakpoint,
} from '../src/core/breakpoints.ts'
import { normalizeCall } from '../src/core/events.ts'

function rule(spec: string, id = 'bp1'): Breakpoint {
  const parsed = parseBreakpointSpec(spec, id, 'all')
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.breakpoint
}

const bash = (command: string, agentId?: string) => normalizeCall({ tool: 'Bash', tool_use_id: 't1', command, ...(agentId ? { agentId } : {}) })
const read = (file_path: string) => normalizeCall({ tool: 'Read', tool_use_id: 't2', file_path })
const edit = (file_path: string) => normalizeCall({ tool: 'Edit', tool_use_id: 't3', file_path, old_string: 'a', new_string: 'b' })

describe('tool breakpoints', () => {
  test('matches the named tool and nothing else', () => {
    const bps = [rule('tool Bash')]
    expect(evaluateCall(bps, bash('ls')).effective).toHaveLength(1)
    expect(evaluateCall(bps, read('/a/b.ts')).hits).toHaveLength(0)
  })

  test('takes several tools, comma or space separated', () => {
    const bp = rule('tool Edit,Write NotebookEdit')
    expect(bp.match.tools).toEqual(['Edit', 'Write', 'NotebookEdit'])
    expect(evaluateCall([bp], edit('/x.ts')).hits).toHaveLength(1)
  })

  test('matches MCP tools by full name', () => {
    const call = normalizeCall({ tool: 'mcp__github__create_issue', tool_use_id: 'm', title: 'x' })
    expect(evaluateCall([rule('tool mcp__github__create_issue')], call).hits).toHaveLength(1)
  })
})

describe('command breakpoints', () => {
  test('match a command containing the words, anywhere, any spacing or case', () => {
    const bps = [rule('command npm install')]
    expect(evaluateCall(bps, bash('cd web && npm   install lodash')).hits).toHaveLength(1)
    expect(evaluateCall(bps, bash('NPM INSTALL')).hits).toHaveLength(1)
    expect(evaluateCall(bps, bash('npm test')).hits).toHaveLength(0)
  })

  test('wildcards order the parts', () => {
    const test1 = compileCommandPattern('git push*--force')
    if (!test1.ok) throw new Error(test1.error)
    expect(test1.test('git push origin main --force')).toBe(true)
    expect(test1.test('git push origin main')).toBe(false)
    expect(test1.test('--force git push')).toBe(false)
  })

  test('only shell tools have a command', () => {
    expect(evaluateCall([rule('command npm')], read('npm')).hits).toHaveLength(0)
  })

  test('regex patterns run under guards', () => {
    expect(evaluateCall([rule('command "re:^git\\s+push\\b"')], bash('git push -f')).hits).toHaveLength(1)
    expect(compileGuardedRegex('(a+)+$').ok).toBe(false)
    expect(compileGuardedRegex('(x)\\1').ok).toBe(false)
    expect(compileGuardedRegex('a*b*c*d*e').ok).toBe(false)
    expect(compileGuardedRegex('[').ok).toBe(false)
    expect(compileGuardedRegex('x'.repeat(201)).ok).toBe(false)
  })

  test('a long hostile command does not stall a guarded regex', () => {
    const compiled = compileGuardedRegex('a.*b.*c')
    if (!compiled.ok) throw new Error(compiled.error)
    const started = Date.now()
    expect(compiled.test('a'.repeat(100_000))).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('file breakpoints', () => {
  test('match a relative glob under any root, POSIX paths', () => {
    expect(matchPath('src/auth/**', '/home/me/app/src/auth/login.ts')).toBe(true)
    expect(matchPath('src/auth/**', '/home/me/app/src/authz/login.ts')).toBe(false)
    expect(matchPath('src/auth/**', '/home/me/app/src/auth')).toBe(true)
    expect(matchPath('prisma/schema.prisma', '/repo/prisma/schema.prisma')).toBe(true)
  })

  test('a glob without a slash matches any segment', () => {
    expect(matchPath('.env*', '/repo/.env')).toBe(true)
    expect(matchPath('.env*', '/repo/config/.env.local')).toBe(true)
    expect(matchPath('.env*', '/repo/env.ts')).toBe(false)
  })

  test('Windows paths: backslashes, drive case, case-insensitive', () => {
    expect(matchPath('src/auth/**', 'C:\\Users\\me\\app\\src\\Auth\\login.ts')).toBe(true)
    expect(matchPath('C:\\Users\\me\\app\\secrets\\*', 'c:/users/ME/app/secrets/key.pem')).toBe(true)
    expect(matchPath('.env*', 'D:\\repo\\.ENV.local')).toBe(true)
    expect(normalizePath('C:\\a\\.\\b\\\\c\\').path).toBe('c:/a/b/c')
  })

  test('POSIX matching stays case-sensitive', () => {
    expect(matchPath('src/Auth/**', '/repo/src/auth/x.ts')).toBe(false)
  })

  test('relative paths resolve against the working directory for absolute globs', () => {
    expect(matchPath('/repo/src/**', 'src/a.ts', '/repo')).toBe(true)
    expect(matchPath('/repo/src/**', 'lib/a.ts', '/repo')).toBe(false)
  })

  test('a home folder matches however either side spells it: ~, $HOME, %USERPROFILE% or the real path', () => {
    expect(matchPath('~/.ssh/**', '/home/me/.ssh/id_rsa')).toBe(true)
    expect(matchPath('~/.ssh/**', '/Users/me/.ssh/config')).toBe(true)
    expect(matchPath('~/.ssh/**', 'C:\\Users\\me\\.ssh\\id_rsa')).toBe(true)
    expect(matchPath('~/.ssh/**', '.ssh/id_rsa', '/home/me')).toBe(true)
    expect(matchPath('/home/me/.ssh/**', '~/.ssh/id_rsa')).toBe(true)
    expect(matchPath('$HOME/.aws/*', '/root/.aws/credentials')).toBe(true)
    expect(matchPath('%USERPROFILE%\\.aws\\*', 'C:\\Users\\me\\.aws\\credentials')).toBe(true)
    // Anchored at home: not a .ssh folder elsewhere, and not outside home.
    expect(matchPath('~/.ssh/**', '/home/me/project/.ssh/x')).toBe(false)
    expect(matchPath('~/.ssh/**', '/etc/ssh/sshd_config')).toBe(false)
    expect(matchPath('~/**', '/etc/passwd')).toBe(false)
    // A rule that does not name home still sees ~ paths by their segments.
    expect(matchPath('.ssh/**', '~/.ssh/id_rsa')).toBe(true)
    const bps = [rule('file ~/.ssh/**')]
    expect(evaluateCall(bps, read('/home/me/.ssh/id_rsa')).hits).toHaveLength(1)
    expect(evaluateCall(bps, bash('cat ~/.ssh/id_rsa')).hits).toHaveLength(1)
  })

  test('file rules see Read, Edit, Grep paths and shell path words', () => {
    const bps = [rule('file .env*')]
    expect(evaluateCall(bps, read('/r/.env')).hits).toHaveLength(1)
    expect(evaluateCall(bps, bash('cat ./.env.production | head')).hits).toHaveLength(1)
    expect(evaluateCall(bps, normalizeCall({ tool: 'Grep', tool_use_id: 'g', pattern: 'KEY', path: '/r/.env' })).hits).toHaveLength(1)
    expect(evaluateCall(bps, bash('ls src')).hits).toHaveLength(0)
  })
})

describe('conditional, scope, threshold, error rules', () => {
  test('conditions combine with AND', () => {
    const bp = rule('when tool=Edit path=src/**/*.sql')
    expect(evaluateCall([bp], edit('/r/src/db/1.sql')).hits).toHaveLength(1)
    expect(evaluateCall([bp], edit('/r/src/db/1.ts')).hits).toHaveLength(0)
    expect(evaluateCall([bp], read('/r/src/db/1.sql')).hits).toHaveLength(0)
  })

  test('scope tells the main agent from subagents', () => {
    const main = rule('tool Bash --scope main')
    const sub = rule('tool Bash --scope subagents', 'bp2')
    expect(evaluateCall([main, sub], bash('ls')).hits.map(bp => bp.id)).toEqual(['bp1'])
    expect(evaluateCall([main, sub], bash('ls', 'agent-7')).hits.map(bp => bp.id)).toEqual(['bp2'])
  })

  test('a hit threshold acts from the Nth hit; counts advance on every hit', () => {
    let bps = [rule('tool Bash --after 3')]
    const effective: number[] = []
    for (let i = 0; i < 4; i += 1) {
      const evaluation = evaluateCall(bps, bash('ls'))
      bps = evaluation.breakpoints
      effective.push(evaluation.effective.length)
    }
    expect(effective).toEqual([0, 0, 1, 1])
    expect(bps[0]?.hitCount).toBe(4)
  })

  test('disabled rules never hit; error rules wait for failures', () => {
    expect(evaluateCall([rule('tool Bash --disabled')], bash('ls')).hits).toHaveLength(0)
    const onError = rule('error Bash --action pause')
    expect(evaluateCall([onError], bash('ls')).hits).toHaveLength(0)
    expect(evaluateError([onError], bash('ls')).effective).toHaveLength(1)
    expect(evaluateError([onError], read('/x')).effective).toHaveLength(0)
  })
})

describe('the rule language and validation', () => {
  test('parses flags, quotes and defaults', () => {
    const bp = rule('command "git push" --action warn --name "pushes" --simulate fail --text "remote down"')
    expect(bp).toMatchObject({ kind: 'command', action: 'warn', name: 'pushes', scope: 'all', match: { command: 'git push' }, simulate: { kind: 'fail', text: 'remote down' } })
    expect(rule('error').action).toBe('warn')
    expect(tokenize(`a "b c" 'd e' f\\"g "say \\"hi\\"" "C:\\repo\\x"`)).toEqual(['a', 'b c', 'd e', 'f\\"g', 'say "hi"', 'C:\\repo\\x'])
  })

  test('refuses what it cannot honor', () => {
    expect(parseBreakpointSpec('', 'bp1', 'all').ok).toBe(false)
    expect(parseBreakpointSpec('tool', 'bp1', 'all').ok).toBe(false)
    expect(parseBreakpointSpec('teleport x', 'bp1', 'all').ok).toBe(false)
    expect(parseBreakpointSpec('tool Bash --action explode', 'bp1', 'all').ok).toBe(false)
    expect(parseBreakpointSpec('tool Bash --bogus 1', 'bp1', 'all').ok).toBe(false)
    expect(parseBreakpointSpec('tool Bash --after 0', 'bp1', 'all').ok).toBe(false)
    expect(parseBreakpointSpec('when color=red', 'bp1', 'all').ok).toBe(false)
    expect(parseBreakpointSpec('file ' + '*'.repeat(13), 'bp1', 'all').ok).toBe(false)
  })

  test('validates stored rules strictly', () => {
    expect(validateBreakpoint({ id: 'x y', kind: 'tool', action: 'pause', scope: 'all', match: { tools: ['Bash'] } }).ok).toBe(false)
    expect(validateBreakpoint({ id: 'a', kind: 'tool', action: 'pause', scope: 'all', match: {} }).ok).toBe(false)
    expect(validateBreakpoint({ id: 'a', kind: 'command', action: 'pause', scope: 'all', match: { command: 're:(a+)+' } }).ok).toBe(false)
    expect(validateBreakpoint(null).ok).toBe(false)
  })

  test('ids and descriptions', () => {
    expect(nextBreakpointId([rule('tool Bash', 'bp4'), rule('tool Read', 'bp2')])).toBe('bp5')
    expect(describeBreakpoint(rule('file .env* --after 2'))).toBe('file path=.env* → pause (from hit 2)')
  })
})
