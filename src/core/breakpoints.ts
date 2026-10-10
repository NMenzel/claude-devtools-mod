// Breakpoint rules: parsing, validation and matching. Pure functions; the
// pattern matchers are bounded so a rule cannot stall a tool call.

import type { Breakpoint, BreakpointAction, BreakpointKind, BreakpointMatch, BreakpointScope, SimulationKind } from '../../types'
import type { NormalizedCall } from './events.ts'

export const KINDS: readonly BreakpointKind[] = ['tool', 'command', 'file', 'error', 'conditional']
export const ACTIONS: readonly BreakpointAction[] = ['pause', 'record', 'warn']
export const SCOPES: readonly BreakpointScope[] = ['all', 'main', 'subagents']
const SIMULATION_KINDS: readonly SimulationKind[] = ['fail', 'stub']

const MAX_PATTERN = 512
const MAX_REGEX = 200
const MAX_COMMAND_SCAN = 8192
const MAX_REGEX_SCAN = 2048
const MAX_PATH = 1024
const MAX_GLOB_WILDCARDS = 12

type Failed = { ok: false; error: string }
type Compiled = { ok: true; test: (text: string) => boolean } | Failed
type CompiledGlob = { ok: true; glob: NormalPath; sensitive: RegExp; insensitive: RegExp } | Failed

// ponycave: plain Map memos, cleared past 256 entries; an LRU only if rule sets get large.
const commandCache = new Map<string, Compiled>()
const globCache = new Map<string, CompiledGlob>()
function memo<T>(cache: Map<string, T>, key: string, build: () => T): T {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  if (cache.size > 256) cache.clear()
  const made = build()
  cache.set(key, made)
  return made
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * A command pattern: words with `*` wildcards, matched case-insensitively
 * anywhere in the command (`npm install` matches `cd web && npm install x`),
 * or `re:<regex>` under limits that keep it from backtracking for long.
 */
export function compileCommandPattern(pattern: string): Compiled {
  return memo(commandCache, pattern, () => {
    if (pattern.trim() === '') return { ok: false, error: 'the command pattern is empty' }
    if (pattern.length > MAX_PATTERN) return { ok: false, error: `the command pattern is longer than ${MAX_PATTERN} characters` }
    if (pattern.startsWith('re:')) return compileGuardedRegex(pattern.slice(3))
    const segments = squash(pattern).split('*').filter(segment => segment !== '')
    if (segments.length === 0) return { ok: true, test: () => true }
    return {
      ok: true,
      test: command => {
        const text = squash(command.slice(0, MAX_COMMAND_SCAN))
        let from = 0
        for (const segment of segments) {
          const at = text.indexOf(segment, from)
          if (at < 0) return false
          from = at + segment.length
        }
        return true
      },
    }
  })
}

/** Rejects the regex features that make backtracking blow up; the input is capped too. */
export function compileGuardedRegex(source: string): Compiled {
  if (source.length === 0) return { ok: false, error: 'the regex is empty' }
  if (source.length > MAX_REGEX) return { ok: false, error: `the regex is longer than ${MAX_REGEX} characters` }
  if (/\\[1-9]|\\k</.test(source)) return { ok: false, error: 'backreferences are not allowed in breakpoint regexes' }
  if (/\)[*+{]/.test(source)) return { ok: false, error: 'quantified groups such as (a+)+ are not allowed in breakpoint regexes' }
  const unbounded = source.match(/(?<!\\)[*+]|\{\d+,\}/g)?.length ?? 0
  if (unbounded > 3) return { ok: false, error: 'a breakpoint regex may hold at most 3 unbounded quantifiers' }
  let regex: RegExp
  try {
    regex = new RegExp(source, 'i')
  } catch (error) {
    return { ok: false, error: `invalid regex: ${(error as Error).message}` }
  }
  return { ok: true, test: text => regex.test(text.slice(0, MAX_REGEX_SCAN)) }
}

type NormalPath = { path: string; isWindows: boolean }

/** Forward slashes, a lowercase drive letter, no `./`, no repeated or trailing slash. */
export function normalizePath(raw: string): NormalPath {
  const isWindows = raw.includes('\\') || /^[a-zA-Z]:/.test(raw)
  let path = raw.trim().replace(/\\/g, '/')
  const isUnc = path.startsWith('//')
  path = path.replace(/\/{2,}/g, '/').replace(/(^|\/)\.(?=\/|$)/g, '$1').replace(/\/{2,}/g, '/')
  path = path.replace(/^([a-zA-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
  if (path.length > 1 && path.endsWith('/') && !/^[a-z]:\/$/.test(path)) path = path.slice(0, -1)
  if (path.startsWith('./')) path = path.slice(2)
  return { path: isUnc ? `/${path}` : path, isWindows }
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:\//.test(path)
}

// Nothing expands `~` or `$HOME`, so a rule and a call can name the same home
// folder differently. Each side under a home folder (`~/`, `$HOME/`,
// `%USERPROFILE%\`, `/home/<user>/`, `/Users/<user>/`, `C:\Users\<user>\`)
// then also matches by its part below home.
const HOME_ALIAS = /^(?:~|\$home|\$\{home\}|%userprofile%|\$env:userprofile)(?=\/|$)/i
const HOME = /^(?:~|\$home|\$\{home\}|%userprofile%|\$env:userprofile|\/home\/[^/]+|\/users\/[^/]+|\/root|\/var\/root|[a-z]:\/users\/[^/]+)(?:\/|$)/i

function belowHome(path: string): string | undefined {
  const found = HOME.exec(path)
  return found === null ? undefined : path.slice(found[0].length)
}

function matchBelowHome(glob: string, path: string, insensitive: boolean, cwd?: string): boolean {
  const full = isAbsolute(path) || HOME_ALIAS.test(path) || cwd === undefined ? path : normalizePath(`${cwd}/${path}`).path
  const globRest = belowHome(glob)
  const pathRest = belowHome(full)
  if (globRest === undefined || pathRest === undefined) return false
  if (globRest === '') return pathRest === ''
  const compiled = compileGlob(globRest)
  return compiled.ok && (insensitive ? compiled.insensitive : compiled.sensitive).test(pathRest)
}

function globSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  // `dir/**` also names `dir` itself, so a search rooted at it matches.
  return out.endsWith('/.*') ? `${out.slice(0, -3)}(?:/.*)?` : out
}

/**
 * Glob over a path: `**` any depth, `*` and `?` within one segment. A glob
 * with no slash matches any segment (`.env*` matches `/repo/.env.local`); a
 * relative glob matches below the working directory or at any segment
 * boundary; an absolute one matches the whole path. Case-insensitive when
 * either side is a Windows path.
 */
export function compileGlob(glob: string): CompiledGlob {
  return memo(globCache, glob, () => {
    if (glob.trim() === '') return { ok: false, error: 'the path glob is empty' }
    if (glob.length > MAX_PATTERN) return { ok: false, error: `the path glob is longer than ${MAX_PATTERN} characters` }
    if ((glob.match(/[*?]/g)?.length ?? 0) > MAX_GLOB_WILDCARDS) return { ok: false, error: `a path glob may hold at most ${MAX_GLOB_WILDCARDS} wildcards` }
    const normal = normalizePath(glob)
    const source = `^${globSource(normal.path)}$`
    return { ok: true, glob: normal, sensitive: new RegExp(source), insensitive: new RegExp(source, 'i') }
  })
}

export function matchPath(glob: string, rawPath: string, cwd?: string): boolean {
  const compiled = compileGlob(glob)
  if (!compiled.ok || rawPath.length > MAX_PATH) return false
  const { glob: pattern, sensitive, insensitive } = compiled
  const target = normalizePath(rawPath)
  const regex = pattern.isWindows || target.isWindows ? insensitive : sensitive
  if (HOME_ALIAS.test(pattern.path) || HOME_ALIAS.test(target.path)) {
    const below = matchBelowHome(pattern.path, target.path, regex === insensitive, cwd)
    if (below || HOME_ALIAS.test(pattern.path)) return below
  }
  const segments = target.path.split('/').filter(segment => segment !== '')

  if (!pattern.path.includes('/')) return segments.some(segment => regex.test(segment))

  if (isAbsolute(pattern.path)) {
    if (isAbsolute(target.path)) return regex.test(target.path)
    return cwd !== undefined && regex.test(normalizePath(`${cwd}/${target.path}`).path)
  }

  if (cwd !== undefined) {
    const root = normalizePath(cwd).path
    const fold = (text: string): string => (regex === insensitive ? text.toLowerCase() : text)
    if (fold(target.path).startsWith(`${fold(root)}/`) && regex.test(target.path.slice(root.length + 1))) return true
  }
  for (let i = 0; i < segments.length; i += 1) if (regex.test(segments.slice(i).join('/'))) return true
  return false
}

function scopeAdmits(scope: BreakpointScope, call: NormalizedCall): boolean {
  return scope === 'all' || (scope === 'main') === (call.scope === 'main')
}

/** Whether a breakpoint's criteria match a call (ignores enabled, kind and threshold). */
export function criteriaMatch(bp: Breakpoint, call: NormalizedCall, cwd?: string): boolean {
  if (!scopeAdmits(bp.scope, call)) return false
  const { tools, command, path } = bp.match
  if (tools !== undefined && tools.length > 0 && !tools.includes(call.tool)) return false
  if (command !== undefined) {
    const compiled = compileCommandPattern(command)
    if (call.command === undefined || !compiled.ok || !compiled.test(call.command)) return false
  }
  if (path !== undefined && !call.paths.some(one => matchPath(path, one, cwd))) return false
  return true
}

export type Evaluation = {
  /** The rules with hit counts advanced. */
  breakpoints: Breakpoint[]
  /** Rules that matched, as advanced. */
  hits: Breakpoint[]
  /** Hits whose threshold is reached: their action applies. */
  effective: Breakpoint[]
}

function evaluate(breakpoints: readonly Breakpoint[], isCandidate: (bp: Breakpoint) => boolean): Evaluation {
  const hits: Breakpoint[] = []
  const next = breakpoints.map(bp => {
    if (!isCandidate(bp)) return bp
    const hit = { ...bp, hitCount: bp.hitCount + 1 }
    hits.push(hit)
    return hit
  })
  const effective = hits.filter(bp => bp.hitThreshold === undefined || bp.hitCount >= bp.hitThreshold)
  return { breakpoints: next, hits, effective }
}

/** Before a call runs: every enabled rule other than error rules. */
export function evaluateCall(breakpoints: readonly Breakpoint[], call: NormalizedCall, cwd?: string): Evaluation {
  return evaluate(breakpoints, bp => bp.enabled && bp.kind !== 'error' && criteriaMatch(bp, call, cwd))
}

/** After a call failed: the enabled error rules. */
export function evaluateError(breakpoints: readonly Breakpoint[], call: NormalizedCall, cwd?: string): Evaluation {
  return evaluate(breakpoints, bp => bp.enabled && bp.kind === 'error' && criteriaMatch(bp, call, cwd))
}

export function nextBreakpointId(breakpoints: readonly Breakpoint[]): string {
  const taken = breakpoints.map(bp => Number(/^bp(\d+)$/.exec(bp.id)?.[1] ?? 0))
  return `bp${Math.max(0, ...taken) + 1}`
}

export type Validated = { ok: true; breakpoint: Breakpoint } | { ok: false; error: string }

const isString = (value: unknown): value is string => typeof value === 'string'

/** Validates a rule from the store, a command or the pane; the one gate every rule passes. */
export function validateBreakpoint(raw: unknown): Validated {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'a breakpoint must be an object' }
  const r = raw as Record<string, unknown>
  if (!isString(r.id) || !/^[A-Za-z0-9_-]{1,32}$/.test(r.id)) return { ok: false, error: 'a breakpoint id is 1-32 letters, digits, _ or -' }
  if (!KINDS.includes(r.kind as BreakpointKind)) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` }
  if (!ACTIONS.includes(r.action as BreakpointAction)) return { ok: false, error: `action must be one of ${ACTIONS.join(', ')}` }
  if (!SCOPES.includes(r.scope as BreakpointScope)) return { ok: false, error: `scope must be one of ${SCOPES.join(', ')}` }
  const m = (r.match ?? {}) as Record<string, unknown>
  if (typeof m !== 'object') return { ok: false, error: 'match must be an object' }
  const match: BreakpointMatch = {}
  if (m.tools !== undefined) {
    if (!Array.isArray(m.tools) || !m.tools.every(tool => isString(tool) && /^[A-Za-z0-9_.:-]{1,128}$/.test(tool)) || m.tools.length > 32) {
      return { ok: false, error: 'tools must be a list of tool names' }
    }
    if (m.tools.length > 0) match.tools = [...(m.tools as string[])]
  }
  if (m.command !== undefined) {
    if (!isString(m.command)) return { ok: false, error: 'command must be a string' }
    const compiled = compileCommandPattern(m.command)
    if (!compiled.ok) return { ok: false, error: compiled.error }
    match.command = m.command
  }
  if (m.path !== undefined) {
    if (!isString(m.path)) return { ok: false, error: 'path must be a string' }
    const compiled = compileGlob(m.path)
    if (!compiled.ok) return { ok: false, error: compiled.error }
    match.path = m.path
  }
  const kind = r.kind as BreakpointKind
  if (kind === 'tool' && match.tools === undefined) return { ok: false, error: 'a tool breakpoint names at least one tool' }
  if (kind === 'command' && match.command === undefined) return { ok: false, error: 'a command breakpoint needs a command pattern' }
  if (kind === 'file' && match.path === undefined) return { ok: false, error: 'a file breakpoint needs a path glob' }
  if (kind === 'conditional' && Object.keys(match).length === 0) return { ok: false, error: 'a conditional breakpoint needs at least one of tool, command or path' }
  let hitThreshold: number | undefined
  if (r.hitThreshold !== undefined) {
    if (typeof r.hitThreshold !== 'number' || !Number.isInteger(r.hitThreshold) || r.hitThreshold < 1 || r.hitThreshold > 1_000_000) {
      return { ok: false, error: 'the hit threshold is a whole number from 1' }
    }
    hitThreshold = r.hitThreshold
  }
  let simulate: Breakpoint['simulate']
  if (r.simulate !== undefined) {
    const s = r.simulate as Record<string, unknown>
    if (s === null || typeof s !== 'object' || !SIMULATION_KINDS.includes(s.kind as SimulationKind)) return { ok: false, error: 'simulate.kind must be fail or stub' }
    if (s.text !== undefined && (!isString(s.text) || s.text.length > 2000)) return { ok: false, error: 'simulate.text is a string of at most 2000 characters' }
    simulate = { kind: s.kind as SimulationKind, ...(isString(s.text) ? { text: s.text } : {}) }
  }
  const name = isString(r.name) && r.name.trim() !== '' ? r.name.trim().slice(0, 80) : `${kind} ${r.id}`
  const hitCount = typeof r.hitCount === 'number' && Number.isInteger(r.hitCount) && r.hitCount >= 0 ? r.hitCount : 0
  return {
    ok: true,
    breakpoint: {
      id: r.id,
      name,
      enabled: r.enabled !== false,
      kind,
      match,
      scope: r.scope as BreakpointScope,
      action: r.action as BreakpointAction,
      hitCount,
      ...(hitThreshold !== undefined ? { hitThreshold } : {}),
      ...(simulate !== undefined ? { simulate } : {}),
    },
  }
}

/**
 * Splits a command line into words, honoring "double" and 'single' quotes.
 * Inside double quotes only \" is unescaped, so regexes (\s) and Windows
 * paths (C:\repo) keep their backslashes.
 */
export function tokenize(input: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : (m[2] ?? m[3] ?? ''))
  }
  return out
}

export const SPEC_HELP = [
  'tool <Name>[,<Name>...]        pause on every call to these tools',
  'command <pattern>              Bash command contains the words (* wildcard, re:<regex>)',
  'file <glob>                    a call names a matching path (src/auth/**, .env*)',
  'error [<Tool>,...]             after a failed call: surface it, arm a pause on the next call',
  'when tool=A,B command=".." path=..   all given conditions must match',
  'flags: --action pause|record|warn  --scope all|main|subagents  --name ".."',
  '       --after <N> (act from the Nth hit)  --simulate fail|stub  --text ".."  --disabled',
]

export type Parsed = { ok: true; breakpoint: Breakpoint } | { ok: false; error: string }

/** Parses the rule language `/devtools-break` and the pane's input share. */
export function parseBreakpointSpec(input: string, id: string, defaultScope: BreakpointScope): Parsed {
  const words = tokenize(input.trim())
  const head = words.shift()?.toLowerCase()
  if (head === undefined) return { ok: false, error: 'empty rule: start with tool, command, file, error or when' }
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string
    if (/^--[a-z]+$/.test(word)) {
      const name = word.slice(2)
      if (name === 'disabled') {
        flags[name] = true
        continue
      }
      const value = words[i + 1]
      if (value === undefined) return { ok: false, error: `${word} needs a value` }
      flags[name] = value
      i += 1
    } else {
      positional.push(word)
    }
  }
  const known = ['action', 'scope', 'name', 'after', 'simulate', 'text', 'disabled']
  const unknown = Object.keys(flags).find(name => !known.includes(name))
  if (unknown !== undefined) return { ok: false, error: `unknown flag --${unknown}` }

  const list = (text: string): string[] => text.split(/[\s,]+/).filter(item => item !== '')
  let kind: BreakpointKind
  const match: BreakpointMatch = {}
  switch (head) {
    case 'tool':
    case 'tools':
      kind = 'tool'
      match.tools = list(positional.join(','))
      break
    case 'command':
    case 'cmd':
    case 'bash':
      kind = 'command'
      match.command = positional.join(' ')
      break
    case 'file':
    case 'path':
      kind = 'file'
      match.path = positional.join(' ')
      break
    case 'error':
    case 'errors':
      kind = 'error'
      if (positional.length > 0) match.tools = list(positional.join(','))
      break
    case 'when':
    case 'if':
      kind = 'conditional'
      for (const pair of positional) {
        const at = pair.indexOf('=')
        if (at < 1) return { ok: false, error: `expected key=value, got "${pair}"` }
        const key = pair.slice(0, at).toLowerCase()
        const value = pair.slice(at + 1)
        if (key === 'tool' || key === 'tools') match.tools = list(value)
        else if (key === 'command' || key === 'cmd') match.command = value
        else if (key === 'path' || key === 'file') match.path = value
        else return { ok: false, error: `unknown condition "${key}": use tool, command or path` }
      }
      break
    default:
      return { ok: false, error: `unknown rule "${head}": start with tool, command, file, error or when` }
  }
  const threshold = flags.after === undefined ? undefined : Number(flags.after)
  const describe = (match.command ?? match.path ?? match.tools?.join(',') ?? 'any tool').slice(0, 48)
  const draft: Record<string, unknown> = {
    id,
    name: typeof flags.name === 'string' ? flags.name : `${kind} ${describe}`,
    enabled: flags.disabled !== true,
    kind,
    match,
    scope: typeof flags.scope === 'string' ? flags.scope : defaultScope,
    action: typeof flags.action === 'string' ? flags.action : kind === 'error' ? 'warn' : 'pause',
    hitCount: 0,
    ...(threshold !== undefined ? { hitThreshold: threshold } : {}),
    ...(typeof flags.simulate === 'string'
      ? { simulate: { kind: flags.simulate, ...(typeof flags.text === 'string' ? { text: flags.text } : {}) } }
      : {}),
  }
  return validateBreakpoint(draft)
}

export function describeBreakpoint(bp: Breakpoint): string {
  const parts: string[] = []
  if (bp.match.tools !== undefined) parts.push(`tool=${bp.match.tools.join(',')}`)
  if (bp.match.command !== undefined) parts.push(`command="${bp.match.command}"`)
  if (bp.match.path !== undefined) parts.push(`path=${bp.match.path}`)
  if (parts.length === 0) parts.push('any tool')
  const extra = [
    bp.scope === 'all' ? undefined : `scope ${bp.scope}`,
    bp.hitThreshold === undefined ? undefined : `from hit ${bp.hitThreshold}`,
    bp.simulate === undefined ? undefined : `simulate ${bp.simulate.kind}`,
  ].filter(Boolean)
  return `${bp.kind} ${parts.join(' ')} → ${bp.action}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`
}
