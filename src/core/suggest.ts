// One-press breakpoints, Chrome DevTools style: the rules a tool call suggests
// (its tool, its command, its path) and the tool categories that can be ticked
// like event-listener breakpoints. Pure.

import type { Breakpoint, BreakpointKind, BreakpointMatch } from '../../types'
import { normalizePath } from './breakpoints.ts'
import { SHELL_TOOLS } from './events.ts'

export type Category = { id: string; label: string; tools: readonly string[] }

/** Tool families a person ticks to pause on, like Chrome's event-listener breakpoints. */
export const CATEGORIES: readonly Category[] = [
  { id: 'shell', label: 'Shell', tools: ['Bash', 'PowerShell'] },
  { id: 'read', label: 'Read', tools: ['Read'] },
  { id: 'search', label: 'Search', tools: ['Grep', 'Glob'] },
  { id: 'edit', label: 'Edit', tools: ['Edit', 'Write', 'NotebookEdit'] },
  { id: 'web', label: 'Web', tools: ['WebFetch', 'WebSearch'] },
  { id: 'agent', label: 'Agents', tools: ['Agent'] },
]

/** The family a tool belongs to, for counts; MCP and unknown tools have their own. */
export function familyOf(tool: string): string {
  if (tool.startsWith('mcp__')) return 'mcp'
  return CATEGORIES.find(category => category.tools.includes(tool))?.id ?? 'other'
}

export type Suggestion = {
  id: 'tool' | 'command' | 'path'
  /** What the button says. */
  label: string
  kind: BreakpointKind
  match: BreakpointMatch
  name: string
}

const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const
/** Tools whose `path` names a directory searched below. */
const DIRECTORY_TOOLS: readonly string[] = ['Grep', 'Glob']

/**
 * The program and its subcommand (`npm install`, `git push`), skipping
 * leading environment assignments and `sudo`; the part of a command that
 * stays the same when its arguments change.
 */
export function commandHead(command: string): string | undefined {
  const first = command.split(/&&|\|\||[;|\n]/)[0] ?? ''
  const words = first.trim().split(/\s+/).filter(word => word !== '')
  while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string) || words[0] === 'sudo')) words.shift()
  const program = words[0]
  if (program === undefined || program === '') return undefined
  const sub = words[1]
  return sub !== undefined && /^[a-z][\w:.-]*$/i.test(sub) ? `${program} ${sub}` : program
}

/** A path shown and matched relative to the working directory when it lies below it. */
export function relativePath(path: string, cwd?: string): string {
  const target = normalizePath(path)
  if (cwd === undefined || cwd === '') return target.path
  const root = normalizePath(cwd).path
  const fold = (text: string): string => (target.isWindows ? text.toLowerCase() : text)
  return fold(target.path).startsWith(`${fold(root)}/`) ? target.path.slice(root.length + 1) : target.path
}

function shorten(text: string, max = 32): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`
}

/** The breakpoints one tool call suggests: its tool, its command (shell), its path. */
export function suggestBreakpoints(tool: string, input: unknown, cwd?: string): Suggestion[] {
  const args = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const out: Suggestion[] = [{ id: 'tool', label: tool, kind: 'tool', match: { tools: [tool] }, name: `${tool} calls` }]
  if (SHELL_TOOLS.includes(tool) && typeof args.command === 'string') {
    const head = commandHead(args.command)
    if (head !== undefined) out.push({ id: 'command', label: `"${shorten(head, 24)}"`, kind: 'command', match: { command: head }, name: head })
  }
  const raw = PATH_FIELDS.map(field => args[field]).find((value): value is string => typeof value === 'string' && value !== '')
  if (raw !== undefined) {
    const relative = relativePath(raw, cwd)
    const glob = DIRECTORY_TOOLS.includes(tool) ? `${relative.replace(/\/$/, '')}/**` : relative
    if (!/[*?]/.test(raw)) out.push({ id: 'path', label: shorten(glob), kind: 'file', match: { path: glob }, name: shorten(glob, 48) })
  }
  return out
}

function canonical(match: BreakpointMatch): string {
  return JSON.stringify({ tools: match.tools === undefined ? undefined : [...match.tools].sort(), command: match.command, path: match.path })
}

/** The existing rule that a suggestion or category stands for, if any. */
export function findRule(breakpoints: readonly Breakpoint[], kind: BreakpointKind, match: BreakpointMatch): Breakpoint | undefined {
  const wanted = canonical(match)
  return breakpoints.find(bp => bp.kind === kind && canonical(bp.match) === wanted)
}

export function findCategoryRule(breakpoints: readonly Breakpoint[], category: Category): Breakpoint | undefined {
  return findRule(breakpoints, 'tool', { tools: [...category.tools] })
}

/** Merges the session's hit counts into the rules. */
export function withHits<T extends { breakpoints: readonly Breakpoint[] }>(settings: T, hits: Readonly<Record<string, number>>): T {
  return { ...settings, breakpoints: settings.breakpoints.map(bp => ({ ...bp, hitCount: hits[bp.id] ?? 0 })) }
}
