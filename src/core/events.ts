// Event normalization: one shape for every tool call, whatever the tool's own
// argument and result shapes, plus risk classification and the summaries the
// timeline keeps. Pure: no Claude Code API here.

import type { RiskLevel } from '../../types'
import { redactString, redactValue } from '../security/redaction.ts'

/** Tools whose `command` argument is a shell command line. */
export const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell']

/** Arguments that carry file contents: never kept unless raw capture is on. */
const CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
  MultiEdit: ['edits'],
  NotebookEdit: ['new_source'],
}

/** Argument names that hold a path, across built-in and MCP tools. */
const PATH_FIELDS: readonly string[] = ['file_path', 'notebook_path', 'path', 'filePath', 'filepath', 'directory', 'dir']

const RESERVED_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

export type ToolCallLike = {
  tool: string
  tool_use_id?: string
  agentId?: string
  [argument: string]: unknown
}

export type NormalizedCall = {
  tool: string
  toolUseId?: string
  agentId?: string
  scope: 'main' | 'subagent'
  /** The tool's own arguments, without the envelope keys. */
  args: Readonly<Record<string, unknown>>
  /** The shell command line, for shell tools only. */
  command?: string
  /** Every path the call names (best effort for shell commands). */
  paths: string[]
  risk: RiskLevel
}

export type SummaryOptions = {
  maxChars: number
  redaction: boolean
  captureRaw: boolean
}

export function normalizeCall(e: ToolCallLike): NormalizedCall {
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(e)) if (!RESERVED_KEYS.has(key)) args[key] = value
  const command = SHELL_TOOLS.includes(e.tool) && typeof args.command === 'string' ? args.command : undefined
  const paths = collectPaths(args, command)
  return {
    tool: e.tool,
    toolUseId: e.tool_use_id,
    agentId: e.agentId,
    scope: e.agentId === undefined ? 'main' : 'subagent',
    args,
    command,
    paths,
    risk: classifyRisk(e.tool, command),
  }
}

function collectPaths(args: Record<string, unknown>, command: string | undefined): string[] {
  const found: string[] = []
  for (const field of PATH_FIELDS) {
    const value = args[field]
    if (typeof value === 'string' && value !== '') found.push(value)
  }
  if (Array.isArray(args.paths)) for (const value of args.paths) if (typeof value === 'string') found.push(value)
  if (command !== undefined) found.push(...shellPathTokens(command))
  return [...new Set(found)].slice(0, 32)
}

/** Words of a command line that look like paths: best effort, no full shell parsing. */
export function shellPathTokens(command: string): string[] {
  const tokens = command.slice(0, 4096).match(/"[^"]*"|'[^']*'|[^\s;&|<>()]+/g) ?? []
  return tokens
    .map(token => token.replace(/^["']|["']$/g, ''))
    .filter(token => !token.startsWith('-') && /[\\/.]/.test(token) && !/^[a-z]+:\/\//i.test(token) && !token.includes('='))
}

const DESTRUCTIVE_COMMAND = new RegExp(
  [
    String.raw`\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)`,
    String.raw`\bRemove-Item\b.*-Recurse`,
    String.raw`\bgit\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+)`,
    String.raw`\bgit\s+reset\s+--hard\b`,
    String.raw`\bgit\s+clean\s+-[a-zA-Z]*f`,
    String.raw`\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)`,
    String.raw`\b(drop|truncate)\s+(table|database|schema)\b`,
    String.raw`\bdelete\s+from\b`,
    String.raw`\b(prisma\s+migrate|db:migrate|alembic\s+upgrade|manage\.py\s+migrate|knex\s+migrate|sequelize\s+db:migrate|flyway\s+migrate)\b`,
    String.raw`\b(npm|pnpm|yarn)\s+publish\b`,
    String.raw`\bterraform\s+(apply|destroy)\b`,
    String.raw`\bkubectl\s+(delete|apply|replace)\b`,
    String.raw`\b(mkfs|fdisk|diskpart)\b`,
    String.raw`\bdd\s+.*\bof=`,
    String.raw`\bchmod\s+-R\b`,
    String.raw`\b(deploy|vercel\s+--prod|fly\s+deploy|heroku\s+releases)\b`,
  ].join('|'),
  'i',
)

const NETWORK_COMMAND =
  /\b(curl|wget|ssh|scp|rsync|ftp|nc|Invoke-WebRequest|iwr|git\s+(push|pull|fetch|clone)|(npm|pnpm|yarn|bun)\s+(install|add|i|ci)|pip3?\s+install|cargo\s+(install|add)|go\s+get|docker\s+(pull|push))\b/i

const READ_ONLY_COMMAND =
  /^\s*(ls|dir|pwd|cat|head|tail|less|wc|echo|which|where|type|file|stat|du|df|tree|grep|rg|find|git\s+(status|diff|log|show|branch|rev-parse|remote\s+-v|blame)|node\s+(-v|--version)|npm\s+(ls|list|view|-v|--version)|Get-ChildItem|Get-Content|Get-Location)\b/i

const COMMAND_SEPARATOR = /&&|\|\||;|\|/

/** A coarse label for how consequential a call can be. Not a security boundary. */
export function classifyRisk(tool: string, command?: string): RiskLevel {
  if (command !== undefined) {
    if (DESTRUCTIVE_COMMAND.test(command)) return 'destructive'
    if (NETWORK_COMMAND.test(command)) return 'network'
    const parts = command.split(COMMAND_SEPARATOR)
    const isReadOnly =
      !/[^2]>|>>|\bsudo\b|-delete\b|-exec\b/.test(command) && parts.every(part => READ_ONLY_COMMAND.test(part))
    return isReadOnly ? 'read' : 'exec'
  }
  switch (tool) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'NotebookRead':
    case 'LSP':
      return 'read'
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'write'
    case 'WebFetch':
    case 'WebSearch':
      return 'network'
    case 'Agent':
    case 'Task':
      return 'exec'
    default:
      return 'unknown'
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ⏎ ').trim()
}

function clean(text: string, options: SummaryOptions): string {
  return options.redaction ? redactString(text) : text
}

/** The tool's arguments as the inspector shows them: redacted, truncated, file contents omitted. */
export function sanitizeInput(call: NormalizedCall, options: SummaryOptions): Record<string, unknown> {
  const omitted = options.captureRaw ? [] : (CONTENT_FIELDS[call.tool] ?? [])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(call.args)) {
    if (omitted.includes(key)) {
      out[key] = `<${describeSize(value)} omitted>`
      continue
    }
    out[key] = shrink(value, options.maxChars * 4, 0)
  }
  return (options.redaction ? redactValue(out) : out) as Record<string, unknown>
}

function describeSize(value: unknown): string {
  if (typeof value === 'string') return `${value.length} chars`
  if (Array.isArray(value)) return `${value.length} items`
  return 'value'
}

function shrink(value: unknown, max: number, depth: number): unknown {
  if (typeof value === 'string') return truncate(value, max)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 4) return '[…]'
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map(item => shrink(item, max, depth + 1))
    return value.length > 20 ? [...items, `… ${value.length - 20} more`] : items
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 40)) out[key] = shrink(item, max, depth + 1)
  return out
}

/** One line describing the call for the timeline. */
export function summarizeInput(call: NormalizedCall, options: SummaryOptions): string {
  const a = call.args
  const str = (key: string): string => (typeof a[key] === 'string' ? (a[key] as string) : '')
  let text: string
  if (call.command !== undefined) {
    text = call.command + (a.run_in_background === true ? '  (background)' : '')
  } else {
    switch (call.tool) {
      case 'Read':
        text = str('file_path') + (a.offset !== undefined || a.limit !== undefined ? `  [${String(a.offset ?? 0)}+${String(a.limit ?? '')}]` : '')
        break
      case 'Edit':
        text = `${str('file_path')}  (${str('old_string').length} → ${str('new_string').length} chars${a.replace_all === true ? ', all' : ''})`
        break
      case 'Write':
        text = `${str('file_path')}  (${str('content').length} chars)`
        break
      case 'NotebookEdit':
        text = `${str('notebook_path')}  (${str('edit_mode') || 'replace'})`
        break
      case 'Glob':
        text = str('pattern') + (str('path') ? `  in ${str('path')}` : '')
        break
      case 'Grep':
        text = `/${str('pattern')}/` + (str('path') ? `  in ${str('path')}` : '') + (str('glob') ? `  glob ${str('glob')}` : '')
        break
      case 'WebFetch':
        text = str('url')
        break
      case 'WebSearch':
        text = str('query')
        break
      case 'Agent':
      case 'Task':
        text = `${str('subagent_type') || 'agent'}: ${str('description')}`
        break
      default:
        text = JSON.stringify(sanitizeInput(call, { ...options, redaction: false })) ?? ''
    }
  }
  return truncate(oneLine(clean(text, options)), options.maxChars)
}

/** A loose view of `next(e)`'s answer: the ToolCallResult arms, read without trusting shapes. */
export type ResultLike = {
  deny?: string
  result?: unknown
  text?: string
  isError?: true
  isReadOnly?: true
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
}

/** One line describing what came back, with no file contents. */
export function summarizeResult(tool: string, result: ResultLike, options: SummaryOptions): string {
  if (typeof result.deny === 'string') return truncate(oneLine(`denied: ${clean(result.deny, options)}`), options.maxChars)
  if (result.isError === true) {
    const text = typeof result.text === 'string' ? result.text : String(result.result ?? '')
    return truncate(oneLine(`error: ${clean(text, options)}`), options.maxChars)
  }
  const record = result.result !== null && typeof result.result === 'object' ? (result.result as Record<string, unknown>) : {}
  const parts: string[] = []
  if (SHELL_TOOLS.includes(tool) && typeof record.stdout === 'string') {
    parts.push(`stdout ${lineCount(record.stdout)} lines`, `stderr ${lineCount(String(record.stderr ?? ''))} lines`)
    if (record.interrupted === true) parts.push('interrupted')
    if (typeof record.backgroundTaskId === 'string') parts.push(`background ${record.backgroundTaskId}`)
  } else if (typeof record.numFiles === 'number') {
    parts.push(`${record.numFiles} files`)
    if (typeof record.numLines === 'number') parts.push(`${record.numLines} lines`)
  } else if (typeof result.text === 'string') {
    parts.push(`${lineCount(result.text)} lines`, `${result.text.length} chars`)
  } else if (typeof result.result === 'string') {
    parts.push(`${result.result.length} chars`)
  } else {
    parts.push('ok')
  }
  if (result.isReadOnly === true) parts.push('read-only')
  return truncate(parts.join(', '), options.maxChars)
}

/** The error text the inspector shows: redacted, longer than a summary. */
export function errorTextOf(result: ResultLike, options: SummaryOptions): string | undefined {
  const text = typeof result.deny === 'string' ? result.deny : result.isError === true ? (result.text ?? String(result.result ?? '')) : undefined
  return text === undefined ? undefined : truncate(clean(text, options), options.maxChars * 4)
}

/** Raw capture (opt-in): the input and the result text, redacted unless redaction is off. */
export function rawOf(call: NormalizedCall, result: ResultLike | undefined, options: SummaryOptions): { input: string; result?: string } {
  const limit = 20_000
  const input = truncate(clean(JSON.stringify(call.args) ?? '', options), limit)
  const text = result === undefined ? undefined : (result.deny ?? result.text ?? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result)))
  return { input, result: text === undefined ? undefined : truncate(clean(text, options), limit) }
}
