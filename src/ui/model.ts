// What the pane draws from and what it can ask for.

import type { Elements, RenderSurface } from 'claude-code'

import type {
  ArmState,
  DevtoolsMode,
  DevtoolsSettings,
  DevtoolsStats,
  DevtoolsTab,
  ErrorGroup,
  LensRecord,
  PendingCall,
  SessionInfo,
  TraceEvent,
  ViewState,
} from '../../types'
import type { DevtoolsOptions } from '../config/schema.ts'
import type { Category, Suggestion } from '../core/suggest.ts'

export type Table = Elements[RenderSurface]

/** `wide`: two columns, docked from 110 cells; `compact`: stacked; `mini`: inline above the prompt. */
export type Layout = 'wide' | 'compact' | 'mini'

export type PaneModel = {
  /** Rules with this session's hit counts merged in. */
  settings: DevtoolsSettings
  arm: ArmState
  trace: readonly TraceEvent[]
  pending: readonly PendingCall[]
  view: ViewState
  session: SessionInfo
  stats: DevtoolsStats
  /** Error Lens: diagnosed failures, oldest first. */
  lens: readonly LensRecord[]
  /** Error Lens: failures grouped by signature, most recent first. */
  groups: readonly ErrorGroup[]
  options: DevtoolsOptions
  /** Cells across the pane body. */
  columns: number
  /** Rows the body may show at once. */
  rows: number
  layout: Layout
  /**
   * Whether the surface draws Input and Select. Element tables are completed
   * across surfaces (mobile's Input draws nothing), so this comes from the surface.
   */
  hasFields: boolean
}

export type PaneActions = {
  setTab: (tab: DevtoolsTab) => void
  inspect: (id: string) => void
  page: (delta: number) => void
  toggleBreakpoint: (id: string) => void
  deleteBreakpoint: (id: string) => void
  addBreakpoint: (spec: string) => void
  toggleCategory: (category: Category) => void
  toggleSuggestion: (suggestion: Suggestion) => void
  setMode: (mode: DevtoolsMode) => void
  toggleRecording: () => void
  togglePauseNext: () => void
  clearTimeline: () => void
  exportTrace: () => void
  /** Shows one failure in the Errors tab. */
  openLens: (id: string) => void
  clearErrors: () => void
}
