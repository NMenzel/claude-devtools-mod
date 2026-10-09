// The mod loaded by the engine's own host: every tool call goes through its
// real tool.call hook; the "tools" and the pause dialog are stubs beneath it.

import { describe, type Engine, expect, test } from 'claude-code/testing'

import { validateExport, type TraceExport } from '../src/core/recorder.ts'
import { SIMULATED_FAILURE_TAG, SIMULATED_OUTPUT_TAG } from '../src/core/simulation.ts'
import { dialog, start, tools, world, type World } from './kit.ts'

type Dollar = Engine

async function run($: Dollar, command: string, args = ''): Promise<string> {
  const out = await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  return out.text ?? ''
}

/** The session's trace, read the way a person gets it: /devtools-export, then validated. */
async function trace($: Dollar, w: World): Promise<TraceExport> {
  w.writes.clear()
  await run($, 'devtools-export', 'trace.json')
  // The engine hands fs.write an absolute native path (C:\work	race.json on Windows).
  const text = [...w.writes].find(([path]) => /[\\/]work[\\/]trace\.json$/.test(path))?.[1]
  if (text === undefined) throw new Error(`no export written; writes: ${[...w.writes.keys()].join(', ')}`)
  const parsed = JSON.parse(text) as TraceExport
  expect(validateExport(parsed)).toEqual([])
  return parsed
}

const BASH_OK = { result: { stdout: 'ok\n', stderr: '', interrupted: false } }

describe('observing', () => {
  test('a call passes through unchanged and is recorded as completed', async ($, on) => {
    const w = world(on)
    const ran = tools(on)
    dialog(on, [])
    await start($)
    const result = await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(result).toMatchObject(BASH_OK)
    expect(ran).toEqual([{ tool: 'Bash', command: 'ls -la' }])
    const t = await trace($, w)
    expect(t.events).toHaveLength(1)
    expect(t.events[0]).toMatchObject({ tool: 'Bash', status: 'completed', outcome: 'ok', simulated: false, inputSummary: 'ls -la', risk: 'read', sessionId: 'session-test' })
    expect(t.events[0]?.resultSummary).toBe('stdout 1 lines, stderr 0 lines')
    expect(t.stats.observed).toBe(1)
  })

  test('the permission verdict passes through unchanged and is recorded as observed', async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    // Core raises tool.check beneath tool.call; the stubbed tools answer above core, so the test raises it as core would.
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu-1' })).toEqual({ decision: 'ask', reason: 'test rules ask' })
    await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu-1' })
    expect((await trace($, w)).events[0]?.permission).toEqual({ decision: 'ask', reason: 'test rules ask', source: 'observed' })
  })

  test('a failing tool is recorded as a tool error, not a denial', async ($, on) => {
    const w = world(on)
    tools(on, () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1\nnpm ERR! missing script: lint' }))
    dialog(on, [])
    await start($)
    const result = await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
    expect(result).toMatchObject({ isError: true })
    const event = (await trace($, w)).events[0]
    expect(event).toMatchObject({ status: 'failed', outcome: 'tool-error' })
    expect(event?.errorText).toContain('missing script')
  })

  test('an interrupted call is recorded as aborted', async ($, on) => {
    const w = world(on)
    tools(on, () => ({ isError: true, result: 'interrupted', text: '[Request interrupted by user for tool use]' }))
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sleep 100' })
    expect((await trace($, w)).events[0]).toMatchObject({ status: 'failed', outcome: 'aborted' })
  })

  test('secrets never reach the trace', async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'API_KEY=xyzzy-secret-123 curl -H "Authorization: Bearer abcdefghijklmnopqrstu" https://x.dev' })
    await $.tool.call({ tool: 'Write', file_path: '/work/.env', content: 'PASSWORD=hunter2hunter2' })
    await trace($, w)
    const text = [...w.writes.values()].join('')
    for (const secret of ['xyzzy-secret-123', 'abcdefghijklmnopqrstu', 'hunter2hunter2']) expect(text).not.toContain(secret)
    expect(text).toContain('[REDACTED]')
  })

  test('the timeline keeps at most maxTimelineEntries events', { options: { maxTimelineEntries: 10 } }, async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    for (let i = 1; i <= 15; i += 1) await $.tool.call({ tool: 'Bash', command: `echo ${i}` })
    const t = await trace($, w)
    expect(t.events).toHaveLength(10)
    expect(t.events[0]?.inputSummary).toBe('echo 6')
    expect(t.events.at(-1)?.inputSummary).toBe('echo 15')
    expect(t.stats.observed).toBe(15)
  })

  test('concurrent calls keep their own records and results', async ($, on) => {
    // Registered before the generic tool stub, so it is the outer one and answers Read.
    const finished: string[] = []
    let w: World | undefined
    on('tool.call', { tool: 'Read' }, async ($, e) => {
      const path = String((e as { file_path?: string }).file_path)
      await w?.clock.sleep(path.endsWith('slow.txt') ? 2000 : 300)
      finished.push(path)
      return { result: { type: 'text', file: { filePath: path } }, text: `contents of ${path}` } as never
    })
    w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    const slow = $.tool.call({ tool: 'Read', file_path: '/work/slow.txt' })
    const fast = $.tool.call({ tool: 'Read', file_path: '/work/fast.txt' })
    await w.clock.settle()
    await w.clock.advance(300)
    await w.clock.advance(1700)
    const [slowResult, fastResult] = await Promise.all([slow, fast])
    expect(slowResult).toMatchObject({ text: 'contents of /work/slow.txt' })
    expect(fastResult).toMatchObject({ text: 'contents of /work/fast.txt' })
    expect(finished).toEqual(['/work/fast.txt', '/work/slow.txt'])
    const events = (await trace($, w)).events
    const bySummary = new Map(events.map(e => [e.inputSummary, e]))
    expect(bySummary.get('/work/slow.txt')).toMatchObject({ status: 'completed', durationMs: 2000 })
    expect(bySummary.get('/work/fast.txt')).toMatchObject({ status: 'completed', durationMs: 300 })
    expect(new Set(events.map(e => e.id)).size).toBe(2)
  })
})

describe('breakpoints', () => {
  test('a tool breakpoint pauses; Reject keeps the tool from running', async ($, on) => {
    const w = world(on)
    const ran = tools(on)
    const { asked } = dialog(on, ['Reject'])
    await start($)
    expect(await run($, 'devtools-break', 'tool Bash')).toContain('Added bp1')
    const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(ran).toEqual([])
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('rm -rf build')
    expect(asked[0]).toContain('risk destructive')
    expect(result).toMatchObject({ deny: expect.stringContaining('the developer rejected this Bash call') })
    const event = (await trace($, w)).events[0]
    expect(event).toMatchObject({ status: 'denied', outcome: 'debugger-rejected', decision: 'reject', breakpointIds: ['bp1'] })
  })

  test('Continue runs the call exactly once, through the rest of the chain', async ($, on) => {
    const w = world(on)
    const ran = tools(on)
    const { asked } = dialog(on, ['Continue'])
    await start($)
    await run($, 'devtools-break', 'command npm install')
    const result = await $.tool.call({ tool: 'Bash', command: 'npm install lodash' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('permission ask')
    expect(ran).toEqual([{ tool: 'Bash', command: 'npm install lodash' }])
    expect(result).toMatchObject(BASH_OK)
    const event = (await trace($, w)).events[0]
    expect(event).toMatchObject({ status: 'completed', decision: 'continue', permission: { decision: 'ask', source: 'preview' } })
  })

  test('a command breakpoint ignores calls that do not match', async ($, on) => {
    world(on)
    const ran = tools(on)
    const { asked } = dialog(on, [])
    await start($)
    await run($, 'devtools-break', 'command npm install')
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Read', file_path: '/work/package.json' })
    expect(asked).toHaveLength(0)
    expect(ran).toHaveLength(2)
  })

  test('a file breakpoint matches POSIX and Windows paths', async ($, on) => {
    world(on)
    const ran = tools(on)
    const { asked } = dialog(on, ['Continue', 'Continue'])
    await start($)
    await run($, 'devtools-break', 'file src/auth/**')
    await $.tool.call({ tool: 'Read', file_path: '/work/src/auth/session.ts' })
    await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\src\\Auth\\login.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Read', file_path: '/work/src/billing/x.ts' })
    expect(asked).toHaveLength(2)
    expect(ran).toHaveLength(3)
  })

  test('a dismissed dialog rejects the call', async ($, on) => {
    const w = world(on)
    const ran = tools(on)
    dialog(on, ['dismiss'])
    await start($)
    await run($, 'devtools-break', 'tool Bash')
    const result = await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(ran).toEqual([])
    expect(result).toMatchObject({ deny: expect.stringContaining('dismissed') })
    expect((await trace($, w)).events[0]).toMatchObject({ status: 'denied', outcome: 'user-cancelled' })
  })

  test('typed text rejects and reaches Claude as the developer\'s note', async ($, on) => {
    world(on)
    const ran = tools(on)
    dialog(on, ['use pnpm, not npm'])
    await start($)
    await run($, 'devtools-break', 'command npm')
    const result = await $.tool.call({ tool: 'Bash', command: 'npm install' })
    expect(ran).toEqual([])
    expect(result).toMatchObject({ deny: expect.stringContaining('"use pnpm, not npm"') })
  })

  test('Step runs the call, then pauses on the next one', async ($, on) => {
    world(on)
    const ran = tools(on)
    const { asked } = dialog(on, ['Step', 'Continue'])
    await start($)
    await run($, 'devtools-break', 'command deploy')
    await $.tool.call({ tool: 'Bash', command: './deploy.sh staging' })
    await $.tool.call({ tool: 'Read', file_path: '/work/log.txt' })
    await $.tool.call({ tool: 'Read', file_path: '/work/log2.txt' })
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('Paused at step')
    expect(ran).toHaveLength(3)
  })

  test('/devtools-pause arms one pause; /devtools-continue disarms', async ($, on) => {
    world(on)
    tools(on)
    const { asked } = dialog(on, ['Continue'])
    await start($)
    await run($, 'devtools-pause')
    await $.tool.call({ tool: 'Glob', pattern: '**/*.ts' })
    await $.tool.call({ tool: 'Glob', pattern: '**/*.md' })
    expect(asked).toHaveLength(1)
    await run($, 'devtools-pause')
    await run($, 'devtools-continue')
    await $.tool.call({ tool: 'Glob', pattern: '**/*.js' })
    expect(asked).toHaveLength(1)
  })

  test('an error breakpoint surfaces the failure and pauses the next call', async ($, on) => {
    const w = world(on)
    tools(on, e => (e.command === 'npm test' ? { isError: true, result: 'x', text: 'Exit code 1' } : undefined))
    const { asked } = dialog(on, ['Continue'])
    await start($)
    await run($, 'devtools-record', 'off')
    await run($, 'devtools-break', 'error Bash --action pause')
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(asked).toHaveLength(0)
    expect(w.toasts.some(t => t.includes('Bash failed') && t.includes('next tool call will pause'))).toBe(true)
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('after Bash failed')
    const events = (await trace($, w)).events
    expect(events[0]).toMatchObject({ status: 'failed', outcome: 'tool-error', breakpointIds: ['bp1'] })
  })

  test('warn and record actions never pause', async ($, on) => {
    const w = world(on)
    const ran = tools(on)
    const { asked } = dialog(on, [])
    await start($)
    await run($, 'devtools-break', 'tool Bash --action warn --name shell')
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(asked).toHaveLength(0)
    expect(ran).toHaveLength(1)
    expect(w.toasts.some(t => t.includes('shell matched Bash'))).toBe(true)
  })
})

describe('modes', () => {
  test('observe records matches without pausing; off does nothing; enable pauses again', async ($, on) => {
    const w = world(on)
    const ran = tools(on)
    const { asked } = dialog(on, ['Continue'])
    await start($)
    await run($, 'devtools-break', 'tool Bash')
    await run($, 'devtools-disable')
    await $.tool.call({ tool: 'Bash', command: 'echo observed' })
    await run($, 'devtools-disable', 'off')
    await $.tool.call({ tool: 'Bash', command: 'echo invisible' })
    await run($, 'devtools-enable')
    await $.tool.call({ tool: 'Bash', command: 'echo paused' })
    expect(asked).toHaveLength(1)
    expect(ran).toHaveLength(3)
    const summaries = (await trace($, w)).events.map(e => e.inputSummary)
    expect(summaries).toEqual(['echo observed', 'echo paused'])
  })

  test('recording off keeps only breakpoint matches', async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    await run($, 'devtools-record', 'off')
    await run($, 'devtools-break', 'command git --action record')
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect((await trace($, w)).events.map(e => e.inputSummary)).toEqual(['git status'])
  })
})

describe('simulation', () => {
  test('is not offered unless the option is on', async ($, on) => {
    world(on)
    tools(on)
    const options: string[][] = []
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      const q = (e as unknown as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions[0]
      options.push(q?.options.map(o => o.label) ?? [])
      return { result: { questions: [], answers: { [q?.question ?? '']: 'Simulate' } } }
    })
    await start($)
    await run($, 'devtools-break', 'tool Bash')
    const result = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(options[0]).toEqual(['Continue', 'Step', 'Reject'])
    expect(result).toMatchObject({ deny: expect.stringContaining('rejected') })
  })

  test('a simulated failure never runs the tool and is labeled', { options: { simulation: true } }, async ($, on) => {
    const w = world(on)
    const ran = tools(on)
    dialog(on, ['Simulate'])
    await start($)
    await run($, 'devtools-break', 'command npm publish --simulate fail --text "E503 registry unavailable"')
    const result = await $.tool.call({ tool: 'Bash', command: 'npm publish' })
    expect(ran).toEqual([])
    expect(result).toMatchObject({ deny: expect.stringContaining(SIMULATED_FAILURE_TAG) })
    expect(result).toMatchObject({ deny: expect.stringContaining('E503 registry unavailable') })
    const t = await trace($, w)
    expect(t.events[0]).toMatchObject({ status: 'simulated', outcome: 'simulated', simulated: true, decision: 'simulate' })
    expect(t.stats.simulated).toBe(1)
  })

  test('a stubbed output is allowed for read-only commands only', { options: { simulation: true } }, async ($, on) => {
    world(on)
    const ran = tools(on)
    const labels: string[][] = []
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      const q = (e as unknown as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions[0]
      labels.push(q?.options.map(o => o.label) ?? [])
      return { result: { questions: [], answers: { [q?.question ?? '']: 'Simulate' } } }
    })
    await start($)
    await run($, 'devtools-break', 'tool Bash --simulate stub --text "a.txt"')
    const stubbed = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(stubbed).toMatchObject({ result: { stdout: `${SIMULATED_OUTPUT_TAG}\na.txt`, stderr: '', interrupted: false } })
    const refused = await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
    expect(labels[1]).toEqual(['Continue', 'Step', 'Reject'])
    expect(refused).toMatchObject({ deny: expect.stringContaining('rejected') })
    expect(ran).toEqual([])
  })
})

describe('headless sessions', () => {
  test('a pause breakpoint rejects without asking; other calls run', async ($, on) => {
    const w = world(on)
    const ran = tools(on)
    const { asked } = dialog(on, [])
    await start($, false)
    await run($, 'devtools-break', 'command git push')
    const pushed = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(asked).toHaveLength(0)
    expect(pushed).toMatchObject({ deny: expect.stringContaining('headless') })
    expect(ran).toEqual([{ tool: 'Bash', command: 'git status' }])
    expect(w.logs.some(line => line.includes('headless'))).toBe(true)
    expect((await trace($, w)).events[0]).toMatchObject({ status: 'denied', outcome: 'headless-rejected' })
    expect(await run($, 'devtools')).toContain('headless (pause → reject)')
  })

  test('record-only lets gated calls through and records them', { options: { headlessPause: 'record-only' } }, async ($, on) => {
    const w = world(on)
    const ran = tools(on)
    const { asked } = dialog(on, [])
    await start($, false)
    await run($, 'devtools-break', 'command git push')
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    expect(asked).toHaveLength(0)
    expect(ran).toHaveLength(1)
    expect((await trace($, w)).events[0]).toMatchObject({ status: 'completed', breakpointIds: ['bp1'] })
  })
})

describe('reliability', () => {
  test('a guard that fails before deciding refuses gated calls only', async ($, on) => {
    // No mock clock: every $.clock.now in the hook rejects, so the hook fails before next.
    world(on, {}, false)
    const ran = tools(on)
    dialog(on, [])
    on('clock.now', () => ({ deny: 'clock unavailable' }))
    await start($)
    await run($, 'devtools-break', 'command rm -rf')
    const gated = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x' })
    const ordinary = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(gated).toMatchObject({ deny: expect.stringContaining('breakpoint guard failed') })
    expect(ordinary).toMatchObject(BASH_OK)
    expect(ran).toEqual([{ tool: 'Bash', command: 'ls' }])
  })

  test('breakpoints persist in the store and load in a new session', async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    await run($, 'devtools-break', 'file .env* --name secrets')
    await run($, 'devtools-disable')
    const saved = w.store.get('settings.v1') as { mode: string; breakpoints: Array<{ id: string; name: string }> }
    expect(saved.mode).toBe('observe')
    expect(saved.breakpoints).toMatchObject([{ id: 'bp1', name: 'secrets' }])
    expect(JSON.stringify(saved)).not.toContain('hitCount')
  })

  test('saved breakpoints are enforced after a reload', async ($, on) => {
    world(on, {
      'settings.v1': {
        schemaVersion: 1,
        mode: 'active',
        recording: true,
        breakpoints: [
          { id: 'bp7', name: 'secrets', enabled: true, kind: 'file', match: { path: '.env*' }, scope: 'all', action: 'pause' },
          { id: 'evil', kind: 'command', match: { command: 're:(a+)+' }, scope: 'all', action: 'pause' },
        ],
      },
    })
    const ran = tools(on)
    const { asked } = dialog(on, ['Reject'])
    await start($)
    await start($)
    expect(await run($, 'devtools-list')).toContain('bp7')
    expect(await run($, 'devtools-list')).not.toContain('evil')
    await $.tool.call({ tool: 'Read', file_path: '/work/.env.local' })
    expect(asked).toHaveLength(1)
    expect(ran).toEqual([])
  })

  test('a reload registers the commands again without breaking anything', async ($, on) => {
    const w = world(on)
    tools(on)
    dialog(on, [])
    await start($)
    await start($)
    expect(w.commands.filter(name => name === 'devtools')).toHaveLength(2)
    expect(w.commands).toContain('devtools-export')
    expect(await run($, 'devtools-status')).toContain('mode active')
  })
})
