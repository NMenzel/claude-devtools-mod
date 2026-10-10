// Claude DevTools (devtools): the plugin's type contract.
// Every value the mod keeps in $.state is declared here, and the pure engine
// under src/ imports its data types from this file, so they are written once.

/** How much the debugger does: intercept, observe only, or nothing at all. */
export type DevtoolsMode = 'active' | 'observe' | 'off'

export type BreakpointKind = 'tool' | 'command' | 'file' | 'error' | 'conditional'
export type BreakpointAction = 'pause' | 'record' | 'warn'
export type BreakpointScope = 'all' | 'main' | 'subagents'
export type SimulationKind = 'fail' | 'stub'

/** Criteria a call must meet; every criterion given must match (AND). */
export type BreakpointMatch = {
  /** Exact tool names (`Bash`, `mcp__github__create_issue`). */
  tools?: string[]
  /** Shell command pattern: words with `*` wildcards, or `re:<regex>`. */
  command?: string
  /** Path glob: `src/auth/**`, `.env*`, `C:\repo\secrets\*`. */
  path?: string
}

export type Breakpoint = {
  id: string
  name: string
  enabled: boolean
  kind: BreakpointKind
  match: BreakpointMatch
  scope: BreakpointScope
  action: BreakpointAction
  /** Matches seen this session (reset when settings load from the store). */
  hitCount: number
  /** Act only once hitCount reaches this; absent acts on every hit. */
  hitThreshold?: number
  /** What 'Simulate' answers at this breakpoint, when simulation is enabled. */
  simulate?: { kind: SimulationKind; text?: string }
}

/** The runtime settings a person changes from the pane or commands. */
export type DevtoolsSettings = {
  mode: DevtoolsMode
  recording: boolean
  breakpoints: Breakpoint[]
}

/** Tool-level stepping: pause the next eligible call. */
export type ArmState = {
  pauseNext: boolean
  /** Set by Step: the pause comes from stepping rather than an explicit arm. */
  step: boolean
  reason?: string
}

export type RiskLevel = 'read' | 'write' | 'exec' | 'network' | 'destructive' | 'unknown'

export type TraceStatus = 'pending' | 'running' | 'completed' | 'failed' | 'denied' | 'simulated'

/** Why a call ended the way it did: never every failure labeled a tool error. */
export type TraceOutcome =
  | 'ok'
  | 'tool-error'
  | 'permission-denied'
  | 'blocked-by-hook'
  | 'debugger-rejected'
  | 'user-cancelled'
  | 'headless-rejected'
  | 'simulated'
  | 'timeout'
  | 'aborted'
  | 'guard-failed'

export type PauseDecision = 'continue' | 'step' | 'reject' | 'simulate'

export type PermissionInfo = {
  decision: 'allow' | 'ask' | 'deny'
  rule?: string
  reason?: string
  /** The classic hook event that decided (`PreToolUse`), as the verdict names it. */
  hook?: string
  /** A mod whose tool.check hook beneath DevTools changed the verdict to this one. */
  decidedBy?: { plugin: string; tier: string }
  /** `preview`: $.tool.check before running; `observed`: the verdict tool.check reached for this call. */
  source: 'preview' | 'observed'
}

export type TraceEvent = {
  id: string
  seq: number
  sessionId: string
  toolUseId?: string
  tool: string
  agentId?: string
  scope: 'main' | 'subagent'
  status: TraceStatus
  outcome?: TraceOutcome
  startedAt: string
  startedAtMs: number
  durationMs?: number
  risk: RiskLevel
  inputSummary: string
  /** The tool's arguments, redacted and truncated (file contents omitted unless raw capture is on). */
  input?: Record<string, unknown>
  paths?: string[]
  resultSummary?: string
  errorText?: string
  breakpointIds?: string[]
  decision?: PauseDecision
  permission?: PermissionInfo
  isReadOnly?: boolean
  simulated: boolean
  /** Raw capture, only with the captureRaw option. */
  raw?: { input?: string; result?: string }
  /** Set when Error Lens recorded this call's failure: its classification. */
  errorCategory?: ErrorCategory
}

// ---------------------------------------------------------------- Error Lens

/** What kind of failure, decided deterministically from the result, the tool and the outcome. */
export type ErrorCategory =
  | 'not-found'
  | 'access-denied'
  | 'not-permitted'
  | 'is-directory'
  | 'not-directory'
  | 'already-exists'
  | 'busy'
  | 'no-space'
  | 'read-only-fs'
  | 'too-many-files'
  | 'name-too-long'
  | 'stale-read'
  | 'not-read-yet'
  | 'edit-mismatch'
  | 'input-invalid'
  | 'too-large'
  | 'timeout'
  | 'exit-code'
  | 'command-not-found'
  | 'network'
  | 'mcp'
  | 'permission-denied'
  | 'blocked-by-hook'
  | 'debugger'
  | 'simulated'
  | 'interrupted'
  | 'suspected'
  | 'unknown'

/** How sure a stated cause is: shown by evidence, plausible but unproven, or not determinable. */
export type Certainty = 'confirmed' | 'possible' | 'unknown'

export type LensCause = {
  certainty: Certainty
  text: string
  /** What the statement rests on: quoted error text, a verdict, a file system fact. */
  evidence: string[]
}

/** One read-only file system observation ($.fs.stat), made after the failure. */
export type LensProbe = {
  path: string
  role: 'target' | 'parent' | 'mentioned'
  /** null when the stat failed for another reason than "missing" (see error). */
  exists: boolean | null
  kind?: 'file' | 'dir' | 'other'
  size?: number
  mtimeMs?: number
  isLink?: boolean
  realPath?: string
  error?: string
}

export type LensRecord = {
  /** The trace event's id (the tool_use_id when there is one). */
  id: string
  seq: number
  tool: string
  agentId?: string
  startedAtMs: number
  endedAtMs: number
  durationMs: number
  status: TraceStatus
  outcome: TraceOutcome
  /** The tool reported success, but its output reads like an error. */
  suspected?: boolean
  category: ErrorCategory
  /** An errno-style code found in the error (ENOENT, EACCES, ...). */
  code?: string
  exitCode?: number
  /** The first meaningful line of the error. */
  headline: string
  /** The original error as Claude read it: redacted, at most 3000 characters. */
  message: string
  /** Groups repeats: tool, category and the headline with paths and numbers masked. */
  signature: string
  /** The tool's arguments, sanitized as the timeline keeps them. */
  args: Record<string, unknown>
  paths: string[]
  permission?: PermissionInfo
  /** For Write: the UTF-8 bytes Claude meant to write. */
  contentBytes?: number
  causes: LensCause[]
  fixes: string[]
  probes: LensProbe[]
  probeState: 'pending' | 'done' | 'off' | 'none'
}

/** Repeated failures with one signature. */
export type ErrorGroup = {
  signature: string
  tool: string
  category: ErrorCategory
  headline: string
  count: number
  firstMs: number
  lastMs: number
  /** The latest occurrences' ids, newest last. */
  ids: string[]
}

// ---------------------------------------------------------------- Permissions

/** A settings file, by the name `$.settings.read` gives it. */
export type SettingsSourceName = 'user' | 'project' | 'local' | 'flag' | 'policy'

export type PermissionRuleRow = { behavior: 'allow' | 'ask' | 'deny'; rule: string; source: SettingsSourceName }

/** The permission settings as each settings file holds them: read, never written. */
export type PermissionsSnapshot = {
  /** When they were read; 0 before the first read. */
  readAtMs: number
  /** The mode a session starts in, from the file that wins. */
  defaultMode?: { mode: string; source: SettingsSourceName }
  /** Deny first, then ask, then allow; within each, the file that wins first. */
  rules: PermissionRuleRow[]
  directories: Array<{ path: string; source: SettingsSourceName }>
  /** Files that could not be read, and why. */
  errors: string[]
}

/** Who refused a call. */
export type RefusalSource = 'rule' | 'mode' | 'prompt' | 'settings-hook' | 'mod' | 'devtools' | 'unknown'

/** Who refused a call and why, as far as the evidence shows. */
export type Refusal = {
  by: RefusalSource
  /** The mod that refused (`by: 'mod'`). */
  plugin?: string
  /** That mod's tier, when the engine named it (`user`, `prepend`, ...). */
  tier?: string
  /** The settings rule as written (`by: 'rule'`). */
  rule?: string
  /** The classic hook event (`by: 'settings-hook'`). */
  hook?: string
  /** The refusal as Claude read it: redacted, at most 600 characters. */
  reason: string
  certainty: Certainty
  /** What the attribution rests on. */
  evidence: string
}

/** A refused call, kept for the Permissions tab whether or not the timeline records. */
export type Denial = {
  /** The trace event's id (the tool_use_id when there is one). */
  id: string
  tool: string
  agentId?: string
  atMs: number
  inputSummary: string
  outcome: TraceOutcome
  refusal: Refusal
}

/** A call held at a breakpoint, shown on the Overview whether or not recording is on. */
export type PendingCall = {
  id: string
  tool: string
  inputSummary: string
  reason: string
  sinceMs: number
  agentId?: string
}

export type DevtoolsTab = 'dashboard' | 'timeline' | 'inspector' | 'breakpoints' | 'errors' | 'permissions'

export type ViewState = {
  tab: DevtoolsTab
  selectedId?: string
  /** Timeline page, 0 = newest. */
  page: number
  /** One line of feedback from the last action in the pane (an add that failed, ...). */
  notice?: string
  /** The breakpoint bar above the prompt was hidden for this session. */
  barHidden?: boolean
  /** The failure Error Lens shows (an event id); the latest when absent. */
  lensId?: string
}

export type SessionInfo = {
  sessionId: string
  isInteractive: boolean
  cwd: string
  surface: string | null
}

export type DevtoolsStats = {
  observed: number
  completed: number
  failed: number
  denied: number
  simulated: number
  paused: number
}

declare module 'claude-code' {
  interface PluginState {
    'devtools': {
      settings: DevtoolsSettings
      /** Hit counts by breakpoint id, kept apart so a hit never redraws what reads only the rules. */
      hits: Record<string, number>
      arm: ArmState
      trace: TraceEvent[]
      pending: PendingCall[]
      /** Error Lens: the latest failures, diagnosed (bounded). */
      lens: LensRecord[]
      /** Error Lens: repeated failures grouped by signature (bounded). */
      errorGroups: ErrorGroup[]
      /** Permissions: the latest refused calls, with who refused them (bounded). */
      denials: Denial[]
      /** Permissions: the permission settings, as last read. */
      permissions: PermissionsSnapshot
      view: ViewState
      session: SessionInfo
      stats: DevtoolsStats
    }
  }
}
