// Synthetic results: opt-in, allowlisted, always labeled, and never claiming
// that a side effect happened. A simulated call never reaches the real tool.

import type { Breakpoint, SimulationKind } from '../../types'
import { SHELL_TOOLS, type NormalizedCall } from './events.ts'

/** Tools whose calls may be answered with a simulated failure. */
export const SIMULATION_TOOLS: readonly string[] = [
  'Bash',
  'PowerShell',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
]

export const SIMULATED_FAILURE_TAG = '[Claude DevTools · SIMULATED FAILURE]'
export const SIMULATED_OUTPUT_TAG = '[Claude DevTools · SIMULATED OUTPUT: the command was NOT executed]'

export type SimulationCheck = { ok: true; kind: SimulationKind; text?: string } | { ok: false; reason: string }

/**
 * Whether 'Simulate' may be offered for this call: simulation switched on,
 * an allowlisted tool, and for a stubbed output a shell command classified
 * read-only, so a canned output can never stand in for a write, migration,
 * deployment or other consequential operation.
 */
export function checkSimulation(isEnabled: boolean, bp: Breakpoint | undefined, call: NormalizedCall): SimulationCheck {
  if (!isEnabled) return { ok: false, reason: 'simulation is off (devtools option "simulation")' }
  const kind = bp?.simulate?.kind ?? 'fail'
  if (!SIMULATION_TOOLS.includes(call.tool) && !call.tool.startsWith('mcp__')) {
    return { ok: false, reason: `${call.tool} is not on the simulation allowlist` }
  }
  if (kind === 'stub' && !(SHELL_TOOLS.includes(call.tool) && call.risk === 'read')) {
    return { ok: false, reason: 'a stubbed output is allowed only for read-only shell commands' }
  }
  return { ok: true, kind, ...(bp?.simulate?.text !== undefined ? { text: bp.simulate.text } : {}) }
}

export type SyntheticResult =
  | { deny: string }
  | { result: { stdout: string; stderr: string; interrupted: false } }

/** The answer a simulated call returns in place of running the tool. */
export function synthesize(kind: SimulationKind, call: NormalizedCall, text?: string): SyntheticResult {
  if (kind === 'stub') {
    return { result: { stdout: `${SIMULATED_OUTPUT_TAG}\n${text ?? ''}`.trimEnd(), stderr: '', interrupted: false } }
  }
  const detail = text ?? 'A tool failure was injected by the developer to test recovery.'
  return { deny: `${SIMULATED_FAILURE_TAG} ${detail} The ${call.tool} call was NOT executed, so nothing changed.` }
}
