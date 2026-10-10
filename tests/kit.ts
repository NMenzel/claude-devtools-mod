// Shared stubs for the engine-level tests: everything Claude Code would answer
// beneath the mod, answered from memory so no tool, file or model is touched.

import type { On } from 'claude-code'
import { type Engine, mock, type MockClock } from 'claude-code/testing'

export type World = {
  clock: MockClock
  store: Map<string, unknown>
  toasts: string[]
  logs: string[]
  statuses: Array<string | undefined>
  writes: Map<string, string>
  commands: string[]
  opened: string[]
  checks: number
  /** What $.fs.stat finds, by path suffix (the engine hands stat a native absolute path); anything else is missing. */
  files: Map<string, { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }>
  /** Every path $.fs.stat was asked about. */
  statted: string[]
  /** What $.settings.read answers, by source (`user`, `project`, ...); a missing source reads as {}. */
  settings: Record<string, unknown>
  /** What the permission check (tool.check) answers. */
  verdict: { decision: 'allow' | 'ask' | 'deny'; rule?: string; reason?: string; hook?: string }
}

/**
 * Registers every stub the mod's hooks call. Call before the test's first `$`
 * call. `withClock: false` leaves `$.clock` to the test (to make it fail).
 */
export function world(on: On, seed: Record<string, unknown> = {}, withClock = true): World {
  const w: World = {
    clock: withClock ? mock.clock(on, { now: Date.UTC(2026, 9, 8, 12, 0, 0) }) : (undefined as unknown as MockClock),
    store: new Map(Object.entries(seed)),
    toasts: [],
    logs: [],
    statuses: [],
    writes: new Map(),
    commands: [],
    opened: [],
    checks: 0,
    files: new Map(),
    statted: [],
    settings: {},
    verdict: { decision: 'ask', reason: 'test rules ask' },
  }
  on('settings.read', ($, e) => ({ value: (w.settings[e.source ?? 'merged'] ?? {}) as Record<string, unknown> }))
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', ($, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.id', () => ({ value: 'session-test' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.write', ($, e) => {
    w.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.writes.has(e.path) }))
  on('fs.stat', ($, e) => {
    w.statted.push(e.path)
    const asked = e.path.replace(/\\/g, '/')
    const found = [...w.files].find(([path]) => asked === path || asked.endsWith(path))
    if (found === undefined) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    return { value: { ...found[1], isLink: false, realPath: e.path } }
  })
  on('tool.check', () => {
    w.checks += 1
    return { ...w.verdict }
  })
  on('session.start', () => ({ cwd: '/work' }))
  return w
}

/** The answer the person gives in the pause dialog, or `dismiss` to close it. */
export type Answer = string | 'dismiss'

/** Answers the pause dialog ($.ui.ask) with the next answer in the list. */
export function dialog(on: On, answers: Answer[]): { asked: string[] } {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = String((e as { questions?: Array<{ question: string }> }).questions?.[0]?.question ?? '')
    asked.push(question)
    const answer = answers.shift() ?? 'dismiss'
    if (answer === 'dismiss') return { deny: 'The user dismissed the question.' }
    return { result: { questions: [], answers: { [question]: answer } } }
  })
  return { asked }
}

export type Ran = { tool: string; command?: string; file_path?: string }

/** The real tools, stubbed: records every call that reached them. */
export function tools(on: On, answer?: (e: Ran) => unknown): Ran[] {
  const ran: Ran[] = []
  on('tool.call', { tool: /^(?!AskUserQuestion$)/ }, ($, e) => {
    const call = e as unknown as Ran
    ran.push({ tool: call.tool, ...(call.command !== undefined ? { command: call.command } : {}), ...(call.file_path !== undefined ? { file_path: call.file_path } : {}) })
    return (answer?.(call) ?? { result: { stdout: 'ok\n', stderr: '', interrupted: false } }) as never
  })
  return ran
}

/** Stands for what Claude Code draws at the sites the mod wraps (tool rows, the band above the prompt). */
export function engineDraws(on: On): void {
  on('ui.render', { component: ['ToolUse', 'ToolGroup', 'AbovePrompt'] }, () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
}

export async function start($: Engine, isInteractive = true): Promise<void> {
  await $.session.start({ surface: isInteractive ? 'terminal' : null, isInteractive, cwd: '/work' })
}
