// Configuration: the manifest's userConfig options, validated at load, and
// the persisted settings (mode, recording, breakpoint rules) in $.store.

import type { BreakpointScope, DevtoolsMode, DevtoolsSettings } from '../../types'
import { SCOPES, validateBreakpoint } from '../core/breakpoints.ts'

export type HeadlessPolicy = 'reject' | 'record-only'
export type InlineControls = 'hover' | 'always' | 'off'
/** Error Lens: diagnose failures with read-only file checks, from the result alone, or not at all. */
export type ErrorLensMode = 'probe' | 'classify' | 'off'

export type DevtoolsOptions = {
  recording: boolean
  maxTimelineEntries: number
  maxSummaryChars: number
  defaultScope: BreakpointScope
  headlessPause: HeadlessPolicy
  simulation: boolean
  redaction: boolean
  captureRaw: boolean
  persistBreakpoints: boolean
  inlineControls: InlineControls
  openOnStart: boolean
  errorLens: ErrorLensMode
  errorToasts: boolean
}

export const DEFAULT_OPTIONS: DevtoolsOptions = {
  recording: true,
  maxTimelineEntries: 500,
  maxSummaryChars: 160,
  defaultScope: 'all',
  headlessPause: 'reject',
  simulation: false,
  redaction: true,
  captureRaw: false,
  persistBreakpoints: true,
  inlineControls: 'always',
  openOnStart: true,
  errorLens: 'probe',
  errorToasts: true,
}

export type ParsedOptions = { options: DevtoolsOptions; warnings: string[] }

/**
 * The engine validates userConfig against the manifest before `register`
 * runs; this second pass keeps the module safe when it is handed something
 * else (a test, an older manifest) and reports what it replaced.
 */
export function parseOptions(raw: Readonly<Record<string, unknown>> | undefined): ParsedOptions {
  const source = raw ?? {}
  const warnings: string[] = []
  const options: DevtoolsOptions = { ...DEFAULT_OPTIONS }
  const bool = (key: keyof DevtoolsOptions & string): void => {
    const value = source[key]
    if (value === undefined) return
    if (typeof value === 'boolean') (options as Record<string, unknown>)[key] = value
    else warnings.push(`option ${key} must be true or false; using ${String(DEFAULT_OPTIONS[key])}`)
  }
  const number = (key: 'maxTimelineEntries' | 'maxSummaryChars', min: number, max: number): void => {
    const value = source[key]
    if (value === undefined) return
    if (typeof value === 'number' && Number.isFinite(value)) options[key] = Math.min(max, Math.max(min, Math.round(value)))
    else warnings.push(`option ${key} must be a number; using ${DEFAULT_OPTIONS[key]}`)
    if (typeof value === 'number' && (value < min || value > max)) warnings.push(`option ${key} clamped to ${min}-${max}`)
  }
  bool('recording')
  bool('simulation')
  bool('redaction')
  bool('captureRaw')
  bool('persistBreakpoints')
  bool('openOnStart')
  bool('errorToasts')
  number('maxTimelineEntries', 10, 5000)
  number('maxSummaryChars', 40, 2000)
  if (source.defaultScope !== undefined) {
    if (SCOPES.includes(source.defaultScope as BreakpointScope)) options.defaultScope = source.defaultScope as BreakpointScope
    else warnings.push(`option defaultScope must be all, main or subagents; using ${DEFAULT_OPTIONS.defaultScope}`)
  }
  if (source.headlessPause !== undefined) {
    if (source.headlessPause === 'reject' || source.headlessPause === 'record-only') options.headlessPause = source.headlessPause
    else warnings.push('option headlessPause must be reject or record-only; using reject')
  }
  if (source.inlineControls !== undefined) {
    if (source.inlineControls === 'hover' || source.inlineControls === 'always' || source.inlineControls === 'off') options.inlineControls = source.inlineControls
    else warnings.push('option inlineControls must be always, hover or off; using always')
  }
  if (source.errorLens !== undefined) {
    if (source.errorLens === 'probe' || source.errorLens === 'classify' || source.errorLens === 'off') options.errorLens = source.errorLens
    else warnings.push('option errorLens must be probe, classify or off; using probe')
  }
  return { options, warnings }
}

export const STORE_KEY = 'settings.v1'
export const SETTINGS_SCHEMA_VERSION = 1
const MODES: readonly DevtoolsMode[] = ['active', 'observe', 'off']
const MAX_BREAKPOINTS = 200

export type PersistedSettings = {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION
  mode: DevtoolsMode
  recording: boolean
  breakpoints: unknown[]
}

export function defaultSettings(options: DevtoolsOptions): DevtoolsSettings {
  return { mode: 'active', recording: options.recording, breakpoints: [] }
}

/** Reads what the store held: anything invalid is dropped with a warning, never trusted. */
export function parsePersisted(raw: unknown, options: DevtoolsOptions): { settings: DevtoolsSettings; warnings: string[] } {
  const settings = defaultSettings(options)
  if (raw === undefined || raw === null) return { settings, warnings: [] }
  if (typeof raw !== 'object') return { settings, warnings: ['saved settings were not an object; starting fresh'] }
  const r = raw as Record<string, unknown>
  if (r.schemaVersion !== SETTINGS_SCHEMA_VERSION) return { settings, warnings: [`saved settings have schema ${String(r.schemaVersion)}; starting fresh`] }
  const warnings: string[] = []
  if (MODES.includes(r.mode as DevtoolsMode)) settings.mode = r.mode as DevtoolsMode
  if (typeof r.recording === 'boolean') settings.recording = r.recording
  const seen = new Set<string>()
  for (const item of Array.isArray(r.breakpoints) ? r.breakpoints.slice(0, MAX_BREAKPOINTS) : []) {
    const checked = validateBreakpoint(item)
    if (!checked.ok) {
      warnings.push(`dropped a saved breakpoint: ${checked.error}`)
      continue
    }
    if (seen.has(checked.breakpoint.id)) continue
    seen.add(checked.breakpoint.id)
    settings.breakpoints.push({ ...checked.breakpoint, hitCount: 0 })
  }
  return { settings, warnings }
}

export function toPersisted(settings: DevtoolsSettings): PersistedSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    mode: settings.mode,
    recording: settings.recording,
    breakpoints: settings.breakpoints.map(({ hitCount: _hits, ...rest }) => rest),
  }
}
