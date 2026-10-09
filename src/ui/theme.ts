// Colors as theme keys, so light, dark and color-blind themes all read.

import type { DevtoolsMode, TraceStatus } from '../../types'

export const C = {
  brand: 'claude',
  paused: 'warning',
  breakpoints: 'error',
  calls: 'suggestion',
  timeline: 'subtle',
  faint: 'inactive',
} as const

export const MODE_COLOR: Record<DevtoolsMode, string> = { active: 'success', observe: 'warning', off: 'inactive' }
export const NEXT_MODE: Record<DevtoolsMode, DevtoolsMode> = { active: 'observe', observe: 'off', off: 'active' }

export const STATUS_COLOR: Record<TraceStatus, string> = {
  pending: 'warning',
  running: 'suggestion',
  completed: 'success',
  failed: 'error',
  denied: 'autoAccept',
  simulated: 'planMode',
}

/** The legend under the header, in the order the strip reads. */
export const LEGEND: ReadonlyArray<readonly [TraceStatus, string]> = [
  ['completed', 'ok'],
  ['failed', 'failed'],
  ['denied', 'denied'],
  ['simulated', 'simulated'],
  ['pending', 'paused'],
]
