// Error Lens, the pure engine: classification, certainty, grouping and what
// the read-only checks show. No engine, no file system.

import { describe, expect, test } from 'claude-code/testing'

import type { Certainty, LensProbe, LensRecord, TraceOutcome } from '../types'
import {
  addToGroups,
  buildLensRecord,
  type CaptureInput,
  diagnose,
  headlineOf,
  lensReport,
  looksLikeFailure,
  pathsInText,
  probePlan,
  shouldNotify,
  signatureOf,
  withProbes,
} from '../src/core/lens.ts'

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0)

function capture(tool: string, text: string, args: Record<string, unknown> = {}, extra: Partial<CaptureInput> = {}): ReturnType<typeof buildLensRecord> {
  return buildLensRecord({
    id: 'call-1',
    seq: 1,
    tool,
    startedAtMs: T0,
    endedAtMs: T0 + 40,
    status: 'failed',
    outcome: 'tool-error',
    text,
    args,
    paths: [],
    probing: 'probe',
    ...extra,
  })
}

function certainties(record: Pick<LensRecord, 'causes'>, certainty: Certainty): string[] {
  return record.causes.filter(one => one.certainty === certainty).map(one => one.text)
}

const failed = (tool: string, text: string, outcome: TraceOutcome = 'tool-error', args: Record<string, unknown> = {}) => diagnose({ tool, outcome, text, args })

describe('classifying failures', () => {
  test('ENOENT on Read: confirmed by the code, with the matched line as evidence', () => {
    const { record, plan } = capture('Read', "ENOENT: no such file or directory, open '/work/src/missing.ts'", { file_path: '/work/src/missing.ts' })
    expect(record).toMatchObject({ category: 'not-found', code: 'ENOENT', probeState: 'pending' })
    expect(record.causes[0]).toMatchObject({ certainty: 'confirmed', text: 'The operating system reported ENOENT: a path does not exist.' })
    expect(record.causes[0]?.evidence[0]).toContain("open '/work/src/missing.ts'")
    expect(certainties(record, 'possible').length).toBeGreaterThan(0)
    expect(record.fixes.length).toBeGreaterThan(0)
    expect(plan).toEqual([
      { path: '/work/src/missing.ts', role: 'target' },
      { path: '/work/src', role: 'parent' },
    ])
  })

  test("Claude Code's own messages: missing file, stale read, not read yet, edit mismatch", () => {
    expect(failed('Read', 'File does not exist.').category).toBe('not-found')
    expect(failed('Write', 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.').category).toBe('stale-read')
    expect(failed('Edit', 'File has not been read yet. Read it first before writing to it.').category).toBe('not-read-yet')
    expect(failed('Edit', 'Found 3 matches of the string to replace, but replace_all is false.').category).toBe('edit-mismatch')
    const missing = failed('Edit', 'String to replace not found in file.', 'tool-error', { file_path: 'C:\\repo\\a.ts' })
    expect(missing.category).toBe('edit-mismatch')
    expect(missing.causes.some(one => one.certainty === 'possible' && one.text.includes('CRLF'))).toBe(true)
  })

  test('EACCES and EPERM: what mods cannot see is stated as unknown; the sandbox hint is for shells only', () => {
    const denied = failed('Write', "EACCES: permission denied, open '/etc/hosts'")
    expect(denied.category).toBe('access-denied')
    expect(denied.causes.some(one => one.certainty === 'unknown' && one.text.includes('Permission bits'))).toBe(true)
    const write = failed('Write', "EPERM: operation not permitted, open 'C:\\work\\a.txt'")
    expect(write.category).toBe('not-permitted')
    expect(write.causes.some(one => one.text.includes('sandbox'))).toBe(false)
    const shell = failed('Bash', 'Exit code 1\ncp: cannot create regular file: EPERM')
    expect(shell.causes.some(one => one.text.includes('sandbox'))).toBe(true)
    expect(shell.exitCode).toBe(1)
  })

  test('shell failures: timeouts, a missing program, a bare exit code', () => {
    expect(failed('Bash', 'Command timed out after 2m 0.0s').category).toBe('timeout')
    const missing = failed('Bash', 'Exit code 127\nbash: line 1: tsx: command not found')
    expect(missing).toMatchObject({ category: 'command-not-found', exitCode: 127 })
    const bare = failed('Bash', 'Exit code 2\nsomething went sideways')
    expect(bare).toMatchObject({ category: 'exit-code', exitCode: 2, headline: 'something went sideways' })
    expect(bare.causes.map(one => one.certainty)).toEqual(['confirmed', 'unknown'])
    const killed = failed('Bash', 'Exit code 137')
    expect(killed.causes.some(one => one.certainty === 'possible' && one.text.includes('SIGKILL'))).toBe(true)
  })

  test('a shell call that ran about as long as its limit may have been stopped for time (possible, never confirmed)', () => {
    const slow = diagnose({ tool: 'Bash', outcome: 'tool-error', text: 'Exit code 143', args: { timeout: 60_000 }, durationMs: 59_800 })
    expect(slow.causes.some(one => one.certainty === 'possible' && one.text.includes('time limit of 60s'))).toBe(true)
  })

  test('permission denials: a deny verdict confirms the rule; text alone stays possible', () => {
    const verdict = diagnose({ tool: 'Bash', outcome: 'permission-denied', text: 'denied', args: {}, permission: { decision: 'deny', rule: 'Bash(rm:*)', source: 'observed' } })
    expect(verdict.category).toBe('permission-denied')
    expect(verdict.causes[0]).toMatchObject({ certainty: 'confirmed', text: "Claude Code's permission check denied this call by the rule Bash(rm:*)." })
    const prompt = failed('Bash', "The user doesn't want to proceed with this tool use.", 'permission-denied')
    expect(prompt.causes[0]?.certainty).toBe('confirmed')
    const vague = failed('Bash', 'Permission to use Bash with command rm -rf build has been denied.', 'permission-denied')
    expect(vague.causes.map(one => one.certainty)).toEqual(['possible', 'unknown'])
  })

  test('a hook refusal is confirmed, the hook that refused is unknown', () => {
    const blocked = failed('Bash', 'my-guard: not here', 'blocked-by-hook')
    expect(blocked.category).toBe('blocked-by-hook')
    expect(blocked.causes.map(one => one.certainty)).toEqual(['confirmed', 'unknown'])
  })

  test('DevTools refusals, simulations and interruptions are labeled as what they are', () => {
    expect(failed('Bash', 'x', 'debugger-rejected').category).toBe('debugger')
    expect(failed('Bash', 'x', 'headless-rejected').category).toBe('debugger')
    expect(failed('Bash', 'x', 'simulated').category).toBe('simulated')
    expect(failed('Bash', '[Request interrupted by user]', 'aborted').category).toBe('interrupted')
  })

  test('MCP tools: a server error, a known signature, and the server message as the only evidence', () => {
    expect(failed('mcp__github__create_issue', 'MCP error -32000: Connection closed').category).toBe('mcp')
    const own = failed('mcp__github__create_issue', 'Validation Failed: title is too long')
    expect(own.category).toBe('mcp')
    expect(own.causes.map(one => one.certainty)).toEqual(['confirmed', 'unknown'])
    expect(failed('mcp__fetch__get', 'getaddrinfo ENOTFOUND example.invalid').category).toBe('network')
    // "MCP server" names only count for MCP tools.
    expect(failed('Bash', 'Exit code 1\nMCP server not running').category).toBe('exit-code')
  })

  test('nothing matched: unknown, with the original error as evidence and no invented cause', () => {
    const odd = failed('Write', 'Something odd happened')
    expect(odd.category).toBe('unknown')
    expect(odd.causes).toHaveLength(1)
    expect(odd.causes[0]).toMatchObject({ certainty: 'unknown', evidence: ['"Something odd happened"'] })
    expect(failed('Read', '').headline).toBe('(no error text)')
  })

  test('an MCP success that reads like an error is only suspected; built-in tools flag their own errors', () => {
    expect(looksLikeFailure('mcp__x__y', { result: 'Error: rate limited' })).toBe(true)
    expect(looksLikeFailure('mcp__x__y', { result: { ok: true } })).toBe(false)
    expect(looksLikeFailure('Bash', { result: 'error: one of the tests' })).toBe(false)
    expect(looksLikeFailure('WebFetch', { text: 'Error: a page about errors' })).toBe(false)
    expect(looksLikeFailure('mcp__x__y', { isError: true, text: 'Error: x' })).toBe(false)
    const suspected = diagnose({ tool: 'mcp__x__y', outcome: 'ok', text: 'Error: rate limited', args: {}, suspected: true })
    expect(suspected.category).toBe('suspected')
    expect(suspected.causes.map(one => one.certainty)).toEqual(['possible', 'unknown'])
  })

  test('headlines and paths named in an error', () => {
    expect(headlineOf('Exit code 1\n\nnpm ERR! missing script: lint')).toBe('npm ERR! missing script: lint')
    expect(headlineOf('<tool_use_error>File does not exist.</tool_use_error>')).toBe('File does not exist.')
    expect(pathsInText("open '/a/b.txt' and \"C:\\x\\y.json\" via https://host/p")).toEqual(['/a/b.txt', 'C:\\x\\y.json'])
    expect(pathsInText("token '[REDACTED]/x'")).toEqual([])
  })
})

describe('read-only checks', () => {
  test('only paths that were really named are probed: no globs, network paths, redacted or truncated spellings', () => {
    expect(probePlan('Read', 'not-found', { file_path: '\\\\server\\share\\a.txt' }, [])).toEqual([])
    expect(probePlan('Read', 'not-found', { file_path: '/r/[REDACTED]/a.txt' }, [])).toEqual([])
    expect(probePlan('Read', 'not-found', { file_path: '/r/very/long…' }, [])).toEqual([])
    expect(probePlan('Grep', 'not-found', { path: 'src/**' }, [])).toEqual([])
    expect(probePlan('Bash', 'timeout', { command: 'sleep 999' }, ['/tmp/x'])).toEqual([])
    expect(probePlan('Bash', 'not-found', { command: 'cat /tmp/x' }, ['/tmp/x'])).toEqual([{ path: '/tmp/x', role: 'mentioned' }])
    expect(probePlan('Write', 'not-found', { file_path: 'C:\\a.txt' }, [])).toEqual([
      { path: 'C:\\a.txt', role: 'target' },
      { path: 'C:\\', role: 'parent' },
    ])
  })

  test('terminal color codes are stripped from the kept error', () => {
    const { record } = capture('Bash', 'Exit code 1\n\u001b[31mError:\u001b[0m build failed')
    expect(record.message).toBe('Exit code 1\nError: build failed')
    expect(record.headline).toBe('Error: build failed')
  })

  test('classify mode plans no checks', () => {
    const { record, plan } = capture('Read', 'File does not exist.', { file_path: '/w/a.ts' }, { probing: 'classify' })
    expect(plan).toEqual([])
    expect(record.probeState).toBe('off')
  })

  test('a write that failed but landed: the file changed during the call and has the intended size', () => {
    const { record } = capture('Write', "EBUSY: resource busy or locked, open 'C:\\work\\a.txt'", { file_path: 'C:\\work\\a.txt' }, { contentBytes: 5 })
    const probes: LensProbe[] = [
      { path: 'C:\\work\\a.txt', role: 'target', exists: true, kind: 'file', size: 5, mtimeMs: T0 + 20, isLink: false },
      { path: 'C:\\work', role: 'parent', exists: true, kind: 'dir', size: 0, mtimeMs: T0 - 10_000, isLink: false },
    ]
    const done = withProbes(record, probes)
    expect(done.probeState).toBe('done')
    expect(done.causes[0]).toMatchObject({ certainty: 'confirmed' })
    expect(done.causes[0]?.text).toContain('was modified at 12:00:00, during or right after this call')
    expect(certainties(done, 'possible').some(text => text.includes('may have landed despite the reported error'))).toBe(true)
    expect(done.fixes[0]).toBe('Read the file to check its content before retrying the write.')
  })

  test('a write to a missing directory: the parent is confirmed missing and the fix names it', () => {
    const { record } = capture('Write', "ENOENT: no such file or directory, open '/work/new/dir/a.txt'", { file_path: '/work/new/dir/a.txt' })
    const done = withProbes(record, [
      { path: '/work/new/dir/a.txt', role: 'target', exists: false },
      { path: '/work/new/dir', role: 'parent', exists: false },
    ])
    expect(certainties(done, 'confirmed')).toContain('The parent directory /work/new/dir does not exist.')
    expect(certainties(done, 'confirmed')).toContain('/work/new/dir/a.txt does not exist after the call: the write did not land.')
    expect(done.fixes).toContain('Create it first: mkdir -p "/work/new/dir"')
  })

  test('an untouched target and a check that itself failed are reported as observed', () => {
    const { record } = capture('Write', 'EPERM: operation not permitted', { file_path: '/w/a.txt' })
    const done = withProbes(record, [
      { path: '/w/a.txt', role: 'target', exists: true, kind: 'file', size: 3, mtimeMs: T0 - 60_000, isLink: false },
      { path: '/w', role: 'parent', exists: null, error: 'denied by a hook' },
    ])
    expect(certainties(done, 'confirmed').some(text => text.includes('before this call: the call did not change it'))).toBe(true)
    expect(certainties(done, 'confirmed').some(text => text.includes('Checking /w after the failure also failed: denied by a hook'))).toBe(true)
  })
})

describe('grouping and reports', () => {
  test('repeats share a signature: paths and numbers are masked', () => {
    const a = signatureOf('Read', 'not-found', "ENOENT: no such file or directory, open '/a/b.txt'")
    const b = signatureOf('Read', 'not-found', "ENOENT: no such file or directory, open '/c/d.txt'")
    expect(a).toBe(b)
    expect(signatureOf('Bash', 'exit-code', 'failed at line 12')).toBe(signatureOf('Bash', 'exit-code', 'failed at line 40'))
    expect(signatureOf('Write', 'not-found', 'x')).not.toBe(signatureOf('Read', 'not-found', 'x'))
  })

  test('groups count repeats, newest first, and notify on the first and every fifth', () => {
    let groups = addToGroups([], capture('Read', 'File does not exist.').record).groups
    for (let i = 2; i <= 5; i += 1) {
      const added = addToGroups(groups, { ...capture('Read', 'File does not exist.').record, id: `call-${i}`, endedAtMs: T0 + i })
      groups = added.groups
      expect(shouldNotify(added.group)).toBe(i === 5)
    }
    expect(groups[0]).toMatchObject({ count: 5, ids: ['call-1', 'call-2', 'call-3', 'call-4', 'call-5'] })
    const other = addToGroups(groups, capture('Bash', 'Exit code 1').record)
    expect(other.groups.map(g => g.tool)).toEqual(['Bash', 'Read'])
    expect(shouldNotify(other.group)).toBe(true)
    expect(addToGroups(other.groups, capture('Edit', 'File does not exist.').record, 2).groups).toHaveLength(2)
  })

  test('the report separates confirmed, possible and unknown, with evidence and fixes', () => {
    const { record } = capture('Read', "EACCES: permission denied, open '/w/a.ts'", { file_path: '/w/a.ts' })
    const report = lensReport(record).join('\n')
    expect(report).toContain('✗ Read · access-denied (EACCES)')
    expect(report).toContain('  CONFIRMED')
    expect(report).toContain('  POSSIBLE')
    expect(report).toContain('  UNKNOWN')
    expect(report).toContain("evidence: \"EACCES: permission denied, open '/w/a.ts'\"")
    expect(report).toContain('checks: running')
    expect(report).toContain('  try\n    1. ')
  })
})
