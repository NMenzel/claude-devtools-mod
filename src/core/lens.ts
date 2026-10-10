// Error Lens: why a tool call failed, from evidence. Deterministic and pure.
// Every cause carries a certainty: `confirmed` when the result itself, a
// permission verdict or a file system fact shows it; `possible` when it is a
// known explanation the evidence does not prove; `unknown` for what no
// observation here can settle. Nothing is guessed beyond the matched evidence.

import type {
  Certainty,
  ErrorCategory,
  ErrorGroup,
  LensCause,
  LensProbe,
  LensRecord,
  PermissionInfo,
  Refusal,
  TraceOutcome,
  TraceStatus,
} from '../../types'
import { SHELL_TOOLS, truncate } from './events.ts'

export const MAX_MESSAGE = 3000
export const MAX_LENS = 80
export const MAX_GROUPS = 50
const MAX_GROUP_IDS = 20

type Advice = { category: ErrorCategory; meaning: string; possible?: string[]; unknown?: string[]; fixes: string[] }

const LOCKS_UNKNOWN = 'Permission bits, ownership, attributes and file locks are not visible to mods ($.fs.stat reports none), so they could not be checked.'

/** errno-style codes: what the OS said, and what usually explains it. */
const CODES: Readonly<Record<string, Advice>> = {
  ENOENT: {
    category: 'not-found',
    meaning: 'a path does not exist',
    possible: ['The path is misspelled, or relative to a different working directory than expected.', 'A parent directory has not been created yet.'],
    fixes: ['Check the path and the working directory (pwd).', 'Create missing parent directories first (mkdir -p).'],
  },
  EACCES: {
    category: 'access-denied',
    meaning: 'access was refused',
    possible: ['This user lacks permission on the file or a parent directory.', 'On Windows: the file is read-only, or another program (editor, antivirus, sync client) holds it.'],
    unknown: [LOCKS_UNKNOWN],
    fixes: ['Check permissions (ls -l, or icacls on Windows).', 'Close programs that may hold the file, then retry.', 'Clear a read-only attribute (chmod u+w, or attrib -r on Windows).'],
  },
  EPERM: {
    category: 'not-permitted',
    meaning: 'the operation is not permitted',
    possible: ['The file is read-only, locked, or owned by another user.', 'On Windows: another program holds the file, or the location is protected.', "Claude Code's sandbox restricts this operation (sandboxed Bash only)."],
    unknown: [LOCKS_UNKNOWN],
    fixes: ['Check permissions and attributes; close programs holding the file.', 'For sandboxed Bash, allow the path in the sandbox settings or run outside the sandbox.'],
  },
  EISDIR: { category: 'is-directory', meaning: 'the path is a directory where a file was expected', fixes: ['Use a path to a file inside the directory.'] },
  ENOTDIR: { category: 'not-directory', meaning: 'a component of the path is not a directory', fixes: ['Check each part of the path: one of them is a file.'] },
  EEXIST: { category: 'already-exists', meaning: 'the path already exists', fixes: ['Use another name, or remove the existing path if that is intended.'] },
  EBUSY: {
    category: 'busy',
    meaning: 'the file or resource is busy or locked',
    possible: ['Another process holds it open (an editor, a dev server, antivirus, a sync client).'],
    unknown: [LOCKS_UNKNOWN],
    fixes: ['Close the program holding it, then retry.'],
  },
  ENOSPC: { category: 'no-space', meaning: 'the device has no space left', fixes: ['Free disk space, then retry.'] },
  EROFS: { category: 'read-only-fs', meaning: 'the file system is read-only', fixes: ['Write somewhere writable, or remount the volume read-write.'] },
  EMFILE: { category: 'too-many-files', meaning: 'the process has too many open files', fixes: ['Close file handles or raise the open-file limit (ulimit -n).'] },
  ENFILE: { category: 'too-many-files', meaning: 'the system has too many open files', fixes: ['Close programs, or raise the system file limit.'] },
  ENAMETOOLONG: { category: 'name-too-long', meaning: 'the path or a name in it is too long', fixes: ['Shorten the path; on Windows, enable long paths or move the project higher up.'] },
  ETIMEDOUT: { category: 'timeout', meaning: 'an operation timed out', possible: ['A slow or unreachable network, or a host that does not answer.'], fixes: ['Check connectivity, then retry.'] },
  ECONNREFUSED: { category: 'network', meaning: 'the connection was refused', possible: ['Nothing listens on that host and port (a server not started?).'], fixes: ['Start the server, or check the host and port.'] },
  ECONNRESET: { category: 'network', meaning: 'the connection was reset by the other side', fixes: ['Retry; check proxies and the remote service.'] },
  ENOTFOUND: { category: 'network', meaning: 'a host name did not resolve', fixes: ['Check the host name, DNS and connectivity.'] },
  EAI_AGAIN: { category: 'network', meaning: 'a host name lookup failed temporarily', fixes: ['Check DNS and connectivity, then retry.'] },
  EHOSTUNREACH: { category: 'network', meaning: 'the host is unreachable', fixes: ['Check the network route, VPN or firewall.'] },
  ENETUNREACH: { category: 'network', meaning: 'the network is unreachable', fixes: ['Check the network connection, VPN or firewall.'] },
}

type TextRule = Advice & { pattern: RegExp; cause: string; mcpOnly?: boolean }

/** Messages of Claude Code's tools and of common programs, most specific first. */
const TEXT_RULES: readonly TextRule[] = [
  {
    category: 'stale-read',
    pattern: /modified since (?:it was )?(?:last )?read/i,
    meaning: '',
    cause: 'The file changed on disk after Claude last read it, so Claude Code refused to overwrite it.',
    possible: ['You, an editor, a formatter or linter, a file watcher, or another tool call changed the file in between.'],
    unknown: ['Which process changed the file: mods cannot see other processes.'],
    fixes: ['Read the file again, then retry the change.', 'If a formatter or watcher rewrites the file, wait for it or pause it while Claude edits.'],
  },
  {
    category: 'not-read-yet',
    pattern: /has not been read yet|read it first/i,
    meaning: '',
    cause: 'Claude Code requires a file to be read in this conversation before it is changed, and it had not been.',
    fixes: ['Read the file first, then retry.'],
  },
  {
    category: 'edit-mismatch',
    pattern: /found \d+ matches of the string to replace|replace_all is false/i,
    meaning: '',
    cause: 'The text to replace occurs more than once, and replace_all was not set.',
    fixes: ['Include more surrounding context so the text is unique, or set replace_all.'],
  },
  {
    category: 'edit-mismatch',
    pattern: /string to replace (?:was )?not found|old_string .{0,40}not found|could not find .{0,60}to replace/i,
    meaning: '',
    cause: 'The exact text to replace was not found in the file.',
    possible: ['The file changed since it was read.', 'Whitespace, indentation or line endings differ from what Claude expected.'],
    fixes: ['Read the file again and copy the exact text, including whitespace.'],
  },
  {
    category: 'input-invalid',
    pattern: /no changes to make|old_string and new_string are (?:exactly )?the same/i,
    meaning: '',
    cause: 'The edit would change nothing: the old and new text are the same.',
    fixes: ['Nothing to fix in the file: the edit was a no-op.'],
  },
  {
    category: 'too-large',
    pattern: /exceeds? (?:the )?maximum (?:allowed )?(?:tokens|size|length)|too large to (?:read|process)|file (?:content|is) too (?:large|big)/i,
    meaning: '',
    cause: 'The file or input exceeds a size limit of the tool.',
    fixes: ['Read it in parts (offset and limit), or search it with Grep.'],
  },
  {
    category: 'input-invalid',
    pattern: /InputValidationError|invalid (?:input|parameters?|arguments?)|required (?:parameter|property)|is not a valid|expected .{1,40} (?:but )?received/i,
    meaning: '',
    cause: 'The tool rejected its arguments as invalid.',
    fixes: ["Check the arguments against the tool's schema."],
  },
  {
    category: 'timeout',
    pattern: /timed out|time ?out (?:after|exceeded)|deadline exceeded/i,
    meaning: '',
    cause: 'The operation ran longer than its time limit.',
    possible: ['The command waited for input, a lock or a slow network, or the job is simply long.'],
    fixes: ['Raise the timeout or run it in the background (run_in_background).', 'Make the command non-interactive (--yes, CI=1).'],
  },
  {
    category: 'command-not-found',
    pattern: /: command not found|is not recognized as an internal or external command|not recognized as the name of a cmdlet/i,
    meaning: '',
    cause: 'The shell could not find the program to run.',
    possible: ['It is not installed, or not on PATH in the shell Claude Code uses.'],
    fixes: ['Install the program, or call it by its full path.', 'Check PATH in the shell Claude Code runs (echo $PATH).'],
  },
  {
    category: 'not-found',
    pattern: /file does not exist|no such file or directory|cannot find the (?:file|path) specified|path not found|directory does not exist/i,
    meaning: '',
    cause: 'The tool reported that a path does not exist.',
    possible: ['The path is misspelled, or relative to a different working directory than expected.'],
    fixes: ['Check the path; Glob for the file name to find where it is.'],
  },
  {
    category: 'access-denied',
    pattern: /permission denied|access is denied|access denied/i,
    meaning: '',
    cause: 'The operating system or the program refused access.',
    possible: ['This user lacks permission, or the file is read-only or held by another program.'],
    unknown: [LOCKS_UNKNOWN],
    fixes: ['Check permissions; close programs holding the file; retry.'],
  },
  {
    category: 'not-permitted',
    pattern: /operation not permitted/i,
    meaning: '',
    cause: 'The operating system did not permit the operation.',
    possible: ["The file is read-only or locked, or Claude Code's sandbox restricts it."],
    unknown: [LOCKS_UNKNOWN],
    fixes: ['Check permissions and the sandbox settings.'],
  },
  {
    category: 'busy',
    pattern: /resource busy or locked|being used by another process|file is locked/i,
    meaning: '',
    cause: 'The file is in use by another process.',
    unknown: [LOCKS_UNKNOWN],
    fixes: ['Close the program holding it, then retry.'],
  },
  { category: 'no-space', pattern: /no space left on device|disk (?:is )?full/i, meaning: '', cause: 'The disk is full.', fixes: ['Free disk space, then retry.'] },
  { category: 'read-only-fs', pattern: /read-only file system/i, meaning: '', cause: 'The file system is read-only.', fixes: ['Write somewhere writable.'] },
  {
    category: 'network',
    pattern: /could not resolve host|connection refused|network is unreachable|getaddrinfo|socket hang up|fetch failed|\bssl\b|certificate (?:has expired|verify failed|is not trusted)|self[- ]signed certificate/i,
    meaning: '',
    cause: 'A network request failed.',
    possible: ['No connectivity, a proxy or firewall, a wrong host, or a server that is down.'],
    fixes: ['Check connectivity and the URL, then retry.'],
  },
  {
    category: 'mcp',
    pattern: /MCP error|MCP server|not connected|disconnected|server .{0,40}(?:unavailable|failed to start|not running)/i,
    meaning: '',
    cause: 'The MCP server behind this tool reported an error or is not connected.',
    possible: ['The server crashed, failed to start, or lost its authentication.'],
    fixes: ['Check the server in /mcp; reconnect or re-authenticate it.'],
    mcpOnly: true,
  },
]

const EXIT_MEANING: Readonly<Record<number, string>> = {
  124: 'Exit code 124 usually means a `timeout` wrapper stopped the command.',
  126: 'Exit code 126 usually means the program was found but is not executable.',
  127: 'Exit code 127 usually means the shell could not find the program.',
  130: 'Exit code 130 usually means the command was interrupted (Ctrl+C, SIGINT).',
  137: 'Exit code 137 usually means the process was killed (SIGKILL), often for running out of memory.',
  143: 'Exit code 143 usually means the process was terminated (SIGTERM).',
}

const USER_REJECTED = /doesn't want to proceed|tool use was rejected|user (?:rejected|denied|declined)/i

export type DiagnoseInput = {
  tool: string
  outcome: TraceOutcome
  /** The error text as Claude read it, already redacted. */
  text: string
  /** The tool's own result record, when there is one (Bash: interrupted). */
  result?: unknown
  args: Readonly<Record<string, unknown>>
  permission?: PermissionInfo
  /** Who refused the call, when the call chain or the verdict shows it. */
  refusal?: Refusal
  durationMs?: number
  suspected?: boolean
}

export type Diagnosis = {
  category: ErrorCategory
  code?: string
  exitCode?: number
  headline: string
  causes: LensCause[]
  fixes: string[]
  mentionedPaths: string[]
}

/** The text a result carries as its error, whatever its shape. */
export function errorTextOfResult(result: { deny?: string; text?: string; result?: unknown }): string {
  if (typeof result.deny === 'string') return result.deny
  if (typeof result.text === 'string' && result.text !== '') return result.text
  if (typeof result.result === 'string') return result.result
  try {
    return JSON.stringify(result.result) ?? ''
  } catch {
    return ''
  }
}

function lines(text: string): string[] {
  return text
    .replace(/<\/?tool_use_error>/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
}

/** The first meaningful line: not an `Exit code N` line, not a tag. */
export function headlineOf(text: string): string {
  const all = lines(text)
  const line = all.find(one => !/^exit code:? \d+$/i.test(one)) ?? all[0] ?? '(no error text)'
  return truncate(line, 160)
}

/** The line of `text` that matched, as a quoted excerpt. */
function excerpt(text: string, pattern: RegExp): string | undefined {
  const line = lines(text).find(one => pattern.test(one))
  return line === undefined ? undefined : `"${truncate(line, 180)}"`
}

const PATH_QUOTED = /'([^'\n]{2,300})'|"([^"\n]{2,300})"/g
const PATH_BARE = /(?:^|[\s(=])((?:[A-Za-z]:)?[\\/][^\s:'"(),]{1,300}|\.{1,2}[\\/][^\s:'"(),]{1,300})/g

/** Paths an error names (quoted, absolute or ./relative), at most three. */
export function pathsInText(text: string): string[] {
  const found: string[] = []
  const add = (candidate: string | undefined): void => {
    if (candidate === undefined) return
    const value = candidate.trim().replace(/[.,;:]+$/, '')
    if (value.length < 2 || value.length > 1024 || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes('[REDACTED]')) return
    if (!/[\\/]/.test(value) && !/\.[a-z0-9]{1,8}$/i.test(value)) return
    if (!found.includes(value)) found.push(value)
  }
  for (const match of text.matchAll(PATH_QUOTED)) add(match[1] ?? match[2])
  for (const match of text.matchAll(PATH_BARE)) add(match[1])
  return found.slice(0, 3)
}

function cause(certainty: Certainty, text: string, evidence: Array<string | undefined> = []): LensCause {
  return { certainty, text, evidence: evidence.filter((item): item is string => item !== undefined && item !== '') }
}

function fromAdvice(advice: Advice, first: LensCause, out: { causes: LensCause[]; fixes: string[] }): void {
  out.causes.push(first)
  for (const text of advice.possible ?? []) out.causes.push(cause('possible', text))
  for (const text of advice.unknown ?? []) out.causes.push(cause('unknown', text))
  out.fixes.push(...advice.fixes)
}

function exitCodeOf(text: string): number | undefined {
  const match = /(?:^|\n)\s*exit code:? (\d{1,3})\b|exited with (?:code|status) (\d{1,3})\b/i.exec(text)
  const value = match?.[1] ?? match?.[2]
  return value === undefined ? undefined : Number(value)
}

// A path from `/` is POSIX, where a backslash is an ordinary filename character.
function isWindowsPath(value: unknown): boolean {
  return typeof value === 'string' && (/^[a-zA-Z]:[\\/]/.test(value) || (value.includes('\\') && !value.startsWith('/')))
}

/**
 * Classifies one failure. Order: what DevTools itself or the permission
 * system decided (known for certain), errno codes in the text, the tools'
 * own messages, shell exit codes, then unknown.
 */
export function diagnose(input: DiagnoseInput): Diagnosis {
  const { text, tool, outcome } = input
  const headline = headlineOf(text)
  const mentionedPaths = pathsInText(text)
  const quoted = text.trim() === '' ? undefined : `"${truncate(headline, 180)}"`
  const out: { causes: LensCause[]; fixes: string[] } = { causes: [], fixes: [] }
  const done = (category: ErrorCategory, extra: Partial<Diagnosis> = {}): Diagnosis => ({
    category,
    headline,
    causes: out.causes,
    fixes: [...new Set(out.fixes)],
    mentionedPaths,
    ...extra,
  })

  switch (outcome) {
    case 'debugger-rejected':
      out.causes.push(cause('confirmed', 'You rejected this call at a Claude DevTools breakpoint, so it never ran.', [quoted]))
      out.fixes.push('Nothing failed: Claude was told the call was rejected. Disable the breakpoint if it should run.')
      return done('debugger')
    case 'user-cancelled':
      out.causes.push(cause('confirmed', 'The Claude DevTools pause question was dismissed, so the call never ran.', [quoted]))
      out.fixes.push('Answer the question with Continue to let such a call run.')
      return done('debugger')
    case 'headless-rejected':
      out.causes.push(cause('confirmed', 'A Claude DevTools pause breakpoint matched in a headless session, where nobody can answer, so the call was refused.', [quoted]))
      out.fixes.push('Set the devtools option headlessPause to "record-only", or disable the breakpoint for headless runs.')
      return done('debugger')
    case 'guard-failed':
      out.causes.push(cause('confirmed', "Claude DevTools' own breakpoint guard failed, so it refused the call to keep the breakpoint's promise.", [quoted]))
      out.fixes.push('Retry; if it repeats, run claude --debug and look for devtools lines.')
      return done('debugger')
    case 'simulated':
      out.causes.push(cause('confirmed', 'Claude DevTools answered with a simulated failure; the real tool never ran.', [quoted]))
      out.fixes.push('Nothing to fix: this failure was injected on purpose.')
      return done('simulated')
    case 'aborted':
      out.causes.push(cause('confirmed', 'The call was interrupted (Esc, or an abort) before it finished.', [quoted]))
      out.fixes.push('Rerun it if it is still needed.')
      return done('interrupted')
    case 'permission-denied': {
      const p = input.permission
      if (p?.decision === 'deny' && p.decidedBy !== undefined) {
        out.causes.push(cause('confirmed', `The mod ${p.decidedBy.plugin} (${p.decidedBy.tier} tier) changed the permission verdict to deny.`, [`tool.check verdict: deny (${p.source})`, p.reason]))
        out.fixes.push(`If it should run, check what ${p.decidedBy.plugin} allows (/plugin).`)
      } else if (p?.decision === 'deny' && p.hook !== undefined) {
        out.causes.push(cause('confirmed', `A ${p.hook} settings hook denied this call.`, [`tool.check verdict: deny by the ${p.hook} hook (${p.source})`, p.reason]))
        out.fixes.push('Review the hook in /hooks if the call should run.')
      } else if (p?.decision === 'deny') {
        out.causes.push(
          cause('confirmed', `Claude Code's permission check denied this call${p.rule !== undefined ? ` by the rule ${p.rule}` : ''}.`, [
            `tool.check verdict: deny (${p.source})`,
            p.reason,
          ]),
        )
        out.fixes.push(`If it should run, change the rule${p.rule !== undefined ? ` ${p.rule}` : ''} in your settings (/permissions).`)
      } else if (USER_REJECTED.test(text)) {
        out.causes.push(cause('confirmed', 'The permission prompt for this call was answered with a rejection.', [excerpt(text, USER_REJECTED)]))
        out.fixes.push('Approve the call when prompted, or add an allow rule in /permissions.')
      } else {
        out.causes.push(cause('possible', 'A permission rule or the permission prompt refused the call; the message reads like a permission denial.', [quoted]))
        out.causes.push(cause('unknown', 'Which rule refused it: no deny verdict was observed for this call.'))
        out.fixes.push('Check /permissions for a deny or ask rule matching this tool.')
      }
      return done('permission-denied')
    }
    case 'blocked-by-hook': {
      const r = input.refusal
      if (r?.by === 'mod' && r.certainty === 'confirmed' && r.plugin !== undefined) {
        out.causes.push(cause('confirmed', `The mod ${r.plugin}${r.tier !== undefined ? ` (${r.tier} tier)` : ''} refused the call before it ran.`, [quoted, r.evidence]))
        out.fixes.push(`Read its refusal; what ${r.plugin} holds or refuses is set in that mod (/plugin).`)
        return done('blocked-by-hook')
      }
      out.causes.push(cause('confirmed', 'A settings hook or another mod beneath Claude DevTools refused the call before it ran.', [quoted]))
      if (r?.by === 'settings-hook') out.causes.push(cause('possible', 'Claude Code itself refused it, not a mod: a PreToolUse settings hook is the usual cause.', [r.evidence]))
      else out.causes.push(cause('unknown', 'Which hook or mod refused it: the result does not name it (claude --debug logs the plugin that denied).'))
      out.fixes.push('Read the refusal text; review /hooks and the mods in /plugin.')
      return done('blocked-by-hook')
    }
    default:
      break
  }

  const exitCode = SHELL_TOOLS.includes(tool) ? exitCodeOf(text) : undefined
  const exitEvidence = exitCode === undefined ? undefined : `exit code ${exitCode}`

  if (input.suspected === true) {
    out.causes.push(cause('possible', 'The tool reported success, but its output begins like an error message.', [quoted]))
    out.causes.push(cause('unknown', 'Whether the call really failed: the tool did not flag it as an error.'))
    out.fixes.push('Read the output to decide whether the call did what was intended.')
    return done('suspected')
  }

  const code = /\b(E[A-Z_]{2,14})\b/g
  for (const match of text.matchAll(code)) {
    const name = match[1] as string
    const advice = CODES[name]
    if (advice === undefined) continue
    // The sandbox restricts Bash alone: the hint does not apply to the file tools.
    const applicable = SHELL_TOOLS.includes(tool) ? advice : { ...advice, possible: (advice.possible ?? []).filter(text => !text.includes('sandbox')) }
    fromAdvice(applicable, cause('confirmed', `The operating system reported ${name}: ${advice.meaning}.`, [excerpt(text, new RegExp(`\\b${name}\\b`)), exitEvidence]), out)
    return done(advice.category, { code: name, ...(exitCode !== undefined ? { exitCode } : {}) })
  }

  for (const rule of TEXT_RULES) {
    if (rule.mcpOnly === true && !tool.startsWith('mcp__')) continue
    if (!rule.pattern.test(text)) continue
    const possible = [...(rule.possible ?? [])]
    if (rule.category === 'edit-mismatch' && isWindowsPath(input.args.file_path)) possible.push('The file uses Windows line endings (CRLF) where the text to replace has LF.')
    fromAdvice({ ...rule, possible }, cause('confirmed', rule.cause, [excerpt(text, rule.pattern), exitEvidence]), out)
    return done(rule.category, exitCode !== undefined ? { exitCode } : {})
  }

  if (exitCode !== undefined) {
    out.causes.push(cause('confirmed', `The command exited with code ${exitCode}.`, [excerpt(text, /exit code|exited with/i)]))
    const meaning = EXIT_MEANING[exitCode]
    if (meaning !== undefined) out.causes.push(cause('possible', meaning))
    else out.causes.push(cause('unknown', "Why: no known signature matched; the command's own output (below) is the evidence."))
    addTimeoutHint(input, out)
    out.fixes.push('Read the command output below; run the command yourself to reproduce it.')
    return done('exit-code', { exitCode })
  }

  if (tool.startsWith('mcp__')) {
    out.causes.push(cause('confirmed', 'The MCP server returned an error for this tool.', [quoted]))
    out.causes.push(cause('unknown', 'Why: the message matches no known signature; it is the server\'s own.'))
    out.fixes.push('Read the server\'s message below; check the server in /mcp.')
    return done('mcp')
  }

  out.causes.push(cause('unknown', 'No known error signature matched, so the cause cannot be determined from the result alone.', [quoted]))
  addTimeoutHint(input, out)
  out.fixes.push('Read the original error below.', 'Reproduce the call by hand to see more detail.')
  return done('unknown')
}

/** A shell call that failed after running about as long as its limit. */
function addTimeoutHint(input: DiagnoseInput, out: { causes: LensCause[]; fixes: string[] }): void {
  if (!SHELL_TOOLS.includes(input.tool) || input.durationMs === undefined) return
  const limit = typeof input.args.timeout === 'number' ? input.args.timeout : 120_000
  if (input.durationMs >= limit - 1000) {
    out.causes.push(cause('possible', `It ran for ${Math.round(input.durationMs / 1000)}s, about its time limit of ${Math.round(limit / 1000)}s, so it may have been stopped for time.`))
  }
}

/** Masks paths, quoted text and numbers so repeats of one failure share a signature. */
export function signatureOf(tool: string, category: ErrorCategory, headline: string): string {
  const masked = headline
    .replace(/'[^']*'|"[^"]*"/g, '…')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:]+|\S+[\\/]\S+/g, '<path>')
    .replace(/\d+/g, '#')
    .toLowerCase()
  return truncate(`${tool}|${category}|${masked}`, 140)
}

/**
 * Whether an MCP call the server reported as successful reads like a failure.
 * Built-in tools flag their own errors, so only MCP servers, which sometimes
 * answer an error as plain text, are judged this way.
 */
export function looksLikeFailure(tool: string, result: { deny?: string; isError?: true; text?: string; result?: unknown }): boolean {
  if (typeof result.deny === 'string' || result.isError === true || !tool.startsWith('mcp__')) return false
  const text = typeof result.text === 'string' ? result.text : typeof result.result === 'string' ? result.result : ''
  return /^\s*(?:error|failed|failure|exception|traceback|fatal)\b[\s:!]/i.test(text.slice(0, 200))
}

const FILE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'Read', 'NotebookEdit']
const DIR_TOOLS: readonly string[] = ['Grep', 'Glob']
const NO_PROBE: readonly ErrorCategory[] = ['debugger', 'simulated', 'interrupted', 'permission-denied', 'blocked-by-hook', 'network', 'mcp', 'input-invalid', 'timeout']

export type ProbeTarget = { path: string; role: LensProbe['role'] }

export function parentOf(path: string): string | undefined {
  const cut = isWindowsPath(path) ? Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) : path.lastIndexOf('/')
  if (cut <= 0) return undefined
  const parent = path.slice(0, cut)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

/** The read-only checks worth making for a failure: its target, the target's parent, paths the error names. */
export function probePlan(tool: string, category: ErrorCategory, args: Readonly<Record<string, unknown>>, mentioned: readonly string[]): ProbeTarget[] {
  if (NO_PROBE.includes(category)) return []
  const out: ProbeTarget[] = []
  const add = (path: string | undefined, role: ProbeTarget['role']): boolean => {
    // Skipped: network paths (a stat could reach out), globs, and spellings redaction or truncation changed (a stat would report a path nobody named).
    if (path === undefined || path === '' || path.length > 1024 || /^[\\/]{2}/.test(path) || /[*?]/.test(path) || path.includes('[REDACTED]') || path.endsWith('…')) return false
    if (!out.some(one => one.path === path)) out.push({ path, role })
    return true
  }
  const field = (name: string): string | undefined => (typeof args[name] === 'string' ? (args[name] as string) : undefined)
  const target = FILE_TOOLS.includes(tool) ? (field('file_path') ?? field('notebook_path')) : DIR_TOOLS.includes(tool) ? field('path') : undefined
  // The parent of a path that could not be checked would be a guess.
  if (add(target, 'target') && FILE_TOOLS.includes(tool)) add(parentOf(target as string), 'parent')
  for (const path of mentioned) add(path, 'mentioned')
  return out.slice(0, 5)
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19)
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** One line describing a probe, for the view and reports. */
export function describeProbe(probe: LensProbe): string {
  if (probe.exists === null) return `${probe.role} ${probe.path}: could not be checked (${probe.error ?? 'error'})`
  if (!probe.exists) return `${probe.role} ${probe.path}: does not exist`
  const parts = [probe.kind === 'dir' ? 'directory' : probe.kind ?? 'exists']
  if (probe.kind === 'file' && probe.size !== undefined) parts.push(size(probe.size))
  if (probe.mtimeMs !== undefined) parts.push(`modified ${clock(probe.mtimeMs)}`)
  if (probe.isLink === true) parts.push(`link → ${probe.realPath ?? '?'}`)
  return `${probe.role} ${probe.path}: ${parts.join(' · ')}`
}

/** Grace for file system clocks (FAT's 2 s granularity, a skew between the host clock and the file system's). */
const MTIME_GRACE_MS = 2000

/**
 * What the read-only checks show. Facts about the files are `confirmed`
 * (they were observed after the failure, and say so); what they suggest
 * about the failure is `possible`.
 */
export function interpretProbes(
  record: Pick<LensRecord, 'tool' | 'category' | 'startedAtMs' | 'endedAtMs' | 'contentBytes'>,
  probes: readonly LensProbe[],
): { causes: LensCause[]; fixes: string[] } {
  const causes: LensCause[] = []
  const fixes: string[] = []
  const isWrite = record.tool === 'Write' || record.tool === 'NotebookEdit'
  for (const probe of probes) {
    const fact = describeProbe(probe)
    if (probe.exists === null) {
      causes.push(cause('confirmed', `Checking ${probe.path} after the failure also failed: ${probe.error ?? 'unknown error'}.`, [fact]))
      continue
    }
    if (probe.role === 'target') {
      if (!probe.exists) {
        causes.push(cause('confirmed', isWrite ? `${probe.path} does not exist after the call: the write did not land.` : `${probe.path} does not exist.`, [fact]))
        if (!isWrite) fixes.push('Check the path; Glob for the file name to find where it is.')
      } else if (probe.kind === 'dir' && record.tool !== 'Grep' && record.tool !== 'Glob') {
        causes.push(cause('confirmed', `${probe.path} is a directory, not a file.`, [fact]))
        fixes.push('Use a path to a file.')
      } else if (probe.kind === 'file' && probe.mtimeMs !== undefined) {
        const changedDuring = probe.mtimeMs >= record.startedAtMs - MTIME_GRACE_MS
        if (isWrite && changedDuring) {
          causes.push(cause('confirmed', `${probe.path} exists and was modified at ${clock(probe.mtimeMs)}, during or right after this call.`, [fact]))
          if (record.contentBytes !== undefined && probe.size === record.contentBytes) {
            causes.push(cause('possible', `The write may have landed despite the reported error: the file's size (${probe.size} bytes) equals what Claude meant to write.`, [fact]))
            fixes.push('Read the file to check its content before retrying the write.')
          }
        } else if (isWrite) {
          causes.push(cause('confirmed', `${probe.path} exists but was last modified at ${clock(probe.mtimeMs)}, before this call: the call did not change it.`, [fact]))
        } else if (record.category === 'stale-read') {
          causes.push(cause('confirmed', `${probe.path} was last modified at ${clock(probe.mtimeMs)}${changedDuring ? ', during or after this call' : ''}.`, [fact]))
        }
      }
      if (probe.isLink === true) causes.push(cause('possible', `${probe.path} is a symbolic link to ${probe.realPath ?? 'an unresolved target'}; the tool may have followed it somewhere unexpected.`, [fact]))
      if (isWindowsPath(probe.path) && probe.path.length >= 260) {
        causes.push(cause('possible', `The path is ${probe.path.length} characters, past Windows' classic 260-character limit (MAX_PATH).`, [fact]))
        fixes.push('Enable long paths on Windows, or shorten the path.')
      }
    } else if (probe.role === 'parent') {
      if (!probe.exists) {
        causes.push(cause('confirmed', `The parent directory ${probe.path} does not exist.`, [fact]))
        fixes.push(`Create it first: mkdir -p "${probe.path}"`)
      } else if (probe.kind !== 'dir') {
        causes.push(cause('confirmed', `${probe.path} is a file, so nothing can be created inside it.`, [fact]))
      } else if (record.category === 'not-found') {
        causes.push(cause('confirmed', 'The parent directory exists, so only the file itself is missing.', [fact]))
      }
    } else if (!probe.exists) {
      causes.push(cause('confirmed', `${probe.path}, named in the error, does not exist now.`, [fact]))
    } else {
      causes.push(cause('possible', `${probe.path}, named in the error, exists now: it may have been created after the failure, or the error meant another location.`, [fact]))
    }
  }
  return { causes, fixes }
}

/** Orders causes confirmed first, keeping each group's order, and drops exact repeats. */
export function orderCauses(causes: readonly LensCause[]): LensCause[] {
  const rank: Record<Certainty, number> = { confirmed: 0, possible: 1, unknown: 2 }
  const seen = new Set<string>()
  return causes
    .filter(one => (seen.has(one.text) ? false : (seen.add(one.text), true)))
    .map((one, index) => ({ one, index }))
    .sort((a, b) => rank[a.one.certainty] - rank[b.one.certainty] || a.index - b.index)
    .map(({ one }) => one)
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export type CaptureInput = {
  id: string
  seq: number
  tool: string
  agentId?: string
  startedAtMs: number
  endedAtMs: number
  status: TraceStatus
  outcome: TraceOutcome
  suspected?: boolean
  /** The error text, already redacted. */
  text: string
  result?: unknown
  /** Sanitized arguments, as the timeline keeps them. */
  args: Record<string, unknown>
  paths: string[]
  permission?: PermissionInfo
  refusal?: Refusal
  contentBytes?: number
  probing: 'probe' | 'classify'
}

/** A diagnosed failure, ready to keep; its probes still to run when the plan has any. */
export function buildLensRecord(input: CaptureInput): { record: LensRecord; plan: ProbeTarget[] } {
  const durationMs = Math.max(0, input.endedAtMs - input.startedAtMs)
  // Terminal color and cursor codes from shell output would garble the pane.
  const text = input.text.replace(ANSI, '')
  const diagnosis = diagnose({
    tool: input.tool,
    outcome: input.outcome,
    text,
    result: input.result,
    args: input.args,
    ...(input.permission !== undefined ? { permission: input.permission } : {}),
    ...(input.refusal !== undefined ? { refusal: input.refusal } : {}),
    durationMs,
    ...(input.suspected === true ? { suspected: true } : {}),
  })
  const plan = input.probing === 'probe' ? probePlan(input.tool, diagnosis.category, input.args, diagnosis.mentionedPaths) : []
  const record: LensRecord = {
    id: input.id,
    seq: input.seq,
    tool: input.tool,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    startedAtMs: input.startedAtMs,
    endedAtMs: input.endedAtMs,
    durationMs,
    status: input.status,
    outcome: input.outcome,
    ...(input.suspected === true ? { suspected: true } : {}),
    category: diagnosis.category,
    ...(diagnosis.code !== undefined ? { code: diagnosis.code } : {}),
    ...(diagnosis.exitCode !== undefined ? { exitCode: diagnosis.exitCode } : {}),
    headline: diagnosis.headline,
    message: truncate(text, MAX_MESSAGE),
    signature: signatureOf(input.tool, diagnosis.category, diagnosis.headline),
    args: input.args,
    paths: input.paths,
    ...(input.permission !== undefined ? { permission: input.permission } : {}),
    ...(input.contentBytes !== undefined ? { contentBytes: input.contentBytes } : {}),
    causes: orderCauses(diagnosis.causes),
    fixes: diagnosis.fixes,
    probes: [],
    probeState: input.probing === 'classify' ? 'off' : plan.length === 0 ? 'none' : 'pending',
  }
  return { record, plan }
}

/** Folds probe results into a record: facts and what they suggest, causes reordered. */
export function withProbes(record: LensRecord, probes: readonly LensProbe[]): LensRecord {
  const found = interpretProbes(record, probes)
  return {
    ...record,
    probes: [...probes],
    probeState: 'done',
    causes: orderCauses([...found.causes.filter(one => one.certainty === 'confirmed'), ...record.causes, ...found.causes.filter(one => one.certainty !== 'confirmed')]),
    fixes: [...new Set([...found.fixes, ...record.fixes])],
  }
}

/** Adds a failure to its group (by signature), newest group first; bounded. */
export function addToGroups(groups: readonly ErrorGroup[], record: LensRecord, max = MAX_GROUPS): { groups: ErrorGroup[]; group: ErrorGroup } {
  const existing = groups.find(group => group.signature === record.signature)
  const group: ErrorGroup =
    existing === undefined
      ? { signature: record.signature, tool: record.tool, category: record.category, headline: record.headline, count: 1, firstMs: record.endedAtMs, lastMs: record.endedAtMs, ids: [record.id] }
      : { ...existing, headline: record.headline, count: existing.count + 1, lastMs: record.endedAtMs, ids: [...existing.ids, record.id].slice(-MAX_GROUP_IDS) }
  return { groups: [group, ...groups.filter(one => one.signature !== record.signature)].slice(0, max), group }
}

/** Whether a failure is worth a toast: the first of its group, then every fifth. */
export function shouldNotify(group: ErrorGroup): boolean {
  return group.count === 1 || group.count % 5 === 0
}

const CERTAINTY_LABEL: Record<Certainty, string> = { confirmed: 'CONFIRMED', possible: 'POSSIBLE', unknown: 'UNKNOWN' }

/** A plain-text report of one failure: the commands' output and the Markdown export share it. */
export function lensReport(record: LensRecord): string[] {
  const out = [
    `✗ ${record.tool} · ${record.category}${record.code !== undefined ? ` (${record.code})` : ''}${record.exitCode !== undefined ? ` · exit ${record.exitCode}` : ''} · ${new Date(record.endedAtMs).toISOString()}`,
    `  error: ${record.headline}`,
  ]
  if (record.permission !== undefined) out.push(`  permission: ${record.permission.decision}${record.permission.rule !== undefined ? ` by ${record.permission.rule}` : ''} (${record.permission.source})`)
  for (const certainty of ['confirmed', 'possible', 'unknown'] as const) {
    const items = record.causes.filter(one => one.certainty === certainty)
    if (items.length === 0) continue
    out.push(`  ${CERTAINTY_LABEL[certainty]}`)
    for (const item of items) {
      out.push(`    - ${item.text}`)
      for (const evidence of item.evidence) out.push(`      evidence: ${evidence}`)
    }
  }
  if (record.probes.length > 0) {
    out.push('  checks (read-only, after the failure)')
    for (const probe of record.probes) out.push(`    - ${describeProbe(probe)}`)
  } else if (record.probeState === 'pending') {
    out.push('  checks: running')
  }
  if (record.fixes.length > 0) {
    out.push('  try')
    record.fixes.forEach((fix, index) => out.push(`    ${index + 1}. ${fix}`))
  }
  return out
}
