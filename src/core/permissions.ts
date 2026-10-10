// Permissions: who refused a tool call and why, from the evidence the engine
// gives (the permission check's verdict, the call chain's trace, the refusal
// text), and the permission rules as the settings files hold them. Pure.
// An attribution is `confirmed` only when the verdict or the trace names it;
// one read from the refusal's own words is `possible`.

import type { Denial, PermissionInfo, PermissionRuleRow, PermissionsSnapshot, Refusal, SettingsSourceName, TraceOutcome } from '../../types'
import { truncate } from './events.ts'

/** The settings files, the one that wins first (managed policy, then --settings, local, project, user). */
export const SOURCES: readonly SettingsSourceName[] = ['policy', 'flag', 'local', 'project', 'user']
const BEHAVIORS = ['deny', 'ask', 'allow'] as const
export const MAX_DENIALS = 80
const MAX_REASON = 600
const MAX_RULES_PER_LIST = 200
const MAX_RULE = 500

export const SOURCE_LABEL: Readonly<Record<SettingsSourceName, string>> = {
  policy: 'managed policy',
  flag: '--settings',
  local: '.claude/settings.local.json',
  project: '.claude/settings.json',
  user: '~/.claude/settings.json',
}

/** One link of a chain as `next.trace` lists it, reduced to what attribution reads. */
export type Link = { index: number; plugin: string; tier: string; returned?: unknown }

type Verdict = { decision: 'allow' | 'ask' | 'deny'; rule?: string; reason?: string; hook?: string }

function isVerdict(value: unknown): value is Verdict {
  const decision = (value as { decision?: unknown } | undefined)?.decision
  return decision === 'allow' || decision === 'ask' || decision === 'deny'
}

/** Claude Code's own link (its rules, mode and settings hooks), not a mod. */
export const isEngine = (link: { plugin: string; tier: string }): boolean => link.plugin === 'engine' || link.tier === 'core'

/**
 * The verdict a call reached beneath DevTools' tool.check hook, and the mod
 * that set it when a mod's hook changed what was beneath it. The innermost
 * link is the baseline (Claude Code's rules, mode and settings hooks).
 */
export function checkVerdict(trace: readonly Link[]): PermissionInfo | undefined {
  const settled = trace.filter(link => isVerdict(link.returned)).sort((a, b) => a.index - b.index)
  const top = settled[0]
  if (top === undefined) return undefined
  let decider: Link | undefined
  for (let i = settled.length - 2; i >= 0; i -= 1) {
    const link = settled[i] as Link
    if ((link.returned as Verdict).decision !== ((settled[i + 1] as Link).returned as Verdict).decision) decider = link
  }
  const verdict = top.returned as Verdict
  return {
    decision: verdict.decision,
    ...(verdict.rule !== undefined ? { rule: verdict.rule } : {}),
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    ...(verdict.hook !== undefined ? { hook: verdict.hook } : {}),
    ...(decider !== undefined && !isEngine(decider) ? { decidedBy: { plugin: decider.plugin, tier: decider.tier } } : {}),
    source: 'observed',
  }
}

/** The link that refused a call: the innermost one that returned a deny (those above it passed it on). */
export function callDenier(trace: readonly Link[]): { plugin: string; tier: string } | undefined {
  const denied = trace
    .filter(link => typeof (link.returned as { deny?: unknown } | null | undefined)?.deny === 'string')
    .sort((a, b) => b.index - a.index)[0]
  return denied === undefined ? undefined : { plugin: denied.plugin, tier: denied.tier }
}

const DEVTOOLS_OUTCOMES: readonly TraceOutcome[] = ['debugger-rejected', 'user-cancelled', 'headless-rejected', 'guard-failed']
const USER_REJECTED = /doesn't want to proceed|tool use was rejected|user (?:rejected|denied|declined)/i
const MODE = /\bmode\b/i

export type RefusalInput = {
  outcome: TraceOutcome
  /** The refusal as Claude read it, already redacted. */
  text: string
  permission?: PermissionInfo
  /** Who returned the deny in the tool.call chain beneath DevTools. */
  denier?: { plugin: string; tier: string }
  /** False when the call was refused before DevTools' tool.call hook ran. */
  seen: boolean
}

/** Who refused a call, most certain evidence first: DevTools' own record, the chain's trace, the verdict, the text. */
export function explainRefusal(input: RefusalInput): Refusal {
  const reason = truncate(input.text.trim(), MAX_REASON)
  const made = (by: Refusal['by'], certainty: Refusal['certainty'], evidence: string, extra: Partial<Refusal> = {}): Refusal => ({ by, ...extra, reason, certainty, evidence })
  const { permission: p, denier } = input

  if (DEVTOOLS_OUTCOMES.includes(input.outcome)) return made('devtools', 'confirmed', 'Claude DevTools recorded its own decision')
  if (denier !== undefined && !isEngine(denier)) {
    return made('mod', 'confirmed', `call chain: ${denier.plugin} (${denier.tier} tier) returned the refusal`, { plugin: denier.plugin, tier: denier.tier })
  }
  if (p?.decision === 'deny') {
    if (p.decidedBy !== undefined) {
      return made('mod', 'confirmed', `permission check: ${p.decidedBy.plugin} (${p.decidedBy.tier} tier) changed the verdict to deny`, { ...p.decidedBy })
    }
    if (p.hook !== undefined) return made('settings-hook', 'confirmed', `permission check: deny from the ${p.hook} hook`, { hook: p.hook })
    if (p.rule !== undefined) return made('rule', 'confirmed', `permission check: deny by the rule ${p.rule}`, { rule: p.rule })
    const said = p.reason ?? ''
    return made('mode', MODE.test(said) ? 'confirmed' : 'possible', `permission check: deny with no rule${said !== '' ? `: ${truncate(said, 160)}` : ''}`)
  }
  if (USER_REJECTED.test(input.text)) return made('prompt', 'confirmed', 'the refusal says the permission prompt was answered no')
  if (input.outcome === 'permission-denied' && p?.decision === 'ask') return made('prompt', 'possible', 'permission check: ask, and the call was refused after it')
  if (!input.seen) {
    const plugin = guessPlugin(input.text)
    if (plugin !== undefined) return made('mod', 'possible', `refused before Claude DevTools' hook ran; the refusal starts with "${plugin}"`, { plugin })
    return made('unknown', 'possible', "refused before Claude DevTools saw the call: a mod seated above it, a managed hook or Claude Code itself")
  }
  if (denier !== undefined) return made('settings-hook', 'possible', 'Claude Code itself refused it, not a mod; a PreToolUse settings hook is the usual cause')
  if (input.outcome === 'permission-denied') return made('unknown', 'possible', 'the refusal reads like a permission denial; no verdict was observed for this call')
  return made('unknown', 'possible', 'nothing observed names who refused it')
}

const NOT_A_NAME = /^(?:error|warning|fatal|note|hint|info|exception|failed|denied)$/i

/** A mod's name as its refusal starts: `name: ...`, `[name] ...`, or `Two Words held|blocked|refused ...`. */
export function guessPlugin(text: string): string | undefined {
  const found = /^\s*(?:\[([a-z0-9][\w.-]{1,40})\]|([a-z0-9][a-z0-9._-]{1,40}):\s)/.exec(text) ?? /^\s*([A-Z][\w-]*(?: [A-Z][\w-]*){1,3}) (?:held|blocked|refused|denied|stopped|rejected)\b/.exec(text)
  const name = found?.[1] ?? found?.[2] ?? found?.[3]
  return name === undefined || NOT_A_NAME.test(name) ? undefined : name
}

const NOT_A_REFUSAL = /InputValidationError|No such tool|is not available|\[Request interrupted|interrupted by (?:the )?user/i

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('\n')
}

/** Error results, in a tool-result row, for calls DevTools' hook never saw: refused above it. */
export function unseenRefusals(content: readonly unknown[], isSeen: (toolUseId: string) => boolean): Array<{ toolUseId: string; text: string }> {
  const out: Array<{ toolUseId: string; text: string }> = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
    if (b.type !== 'tool_result' || b.is_error !== true || typeof b.tool_use_id !== 'string' || isSeen(b.tool_use_id)) continue
    const text = resultText(b.content).replace(/<\/?tool_use_error>/g, '').trim()
    if (text === '' || NOT_A_REFUSAL.test(text)) continue
    out.push({ toolUseId: b.tool_use_id, text })
  }
  return out
}

function strings(value: unknown, redact: (text: string) => string): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, MAX_RULES_PER_LIST).map(item => truncate(redact(item.trim()), MAX_RULE))
}

/** The permission settings from each file, as `$.settings.read({ source })` answered; malformed values are skipped. */
export function readPermissions(
  bySource: Partial<Record<SettingsSourceName, unknown>>,
  errors: readonly string[],
  readAtMs: number,
  redact: (text: string) => string = text => text,
): PermissionsSnapshot {
  const rules: PermissionRuleRow[] = []
  const directories: PermissionsSnapshot['directories'] = []
  let defaultMode: PermissionsSnapshot['defaultMode']
  for (const behavior of BEHAVIORS) {
    for (const source of SOURCES) {
      const permissions = (bySource[source] as { permissions?: Record<string, unknown> } | undefined)?.permissions
      if (permissions === null || typeof permissions !== 'object') continue
      for (const rule of new Set(strings(permissions[behavior], redact))) rules.push({ behavior, rule, source })
    }
  }
  for (const source of SOURCES) {
    const permissions = (bySource[source] as { permissions?: Record<string, unknown> } | undefined)?.permissions
    if (permissions === null || typeof permissions !== 'object') continue
    if (defaultMode === undefined && typeof permissions.defaultMode === 'string') defaultMode = { mode: permissions.defaultMode, source }
    for (const path of strings(permissions.additionalDirectories, redact)) directories.push({ path, source })
  }
  return { readAtMs, ...(defaultMode !== undefined ? { defaultMode } : {}), rules, directories, errors: [...errors] }
}

/** The file that holds a rule, the one that wins first. */
export function ruleSource(snapshot: PermissionsSnapshot, rule: string, behavior?: PermissionRuleRow['behavior']): SettingsSourceName | undefined {
  return snapshot.rules.find(row => row.rule === rule && (behavior === undefined || row.behavior === behavior))?.source
}

/** Who refused, in a few words. */
export function describeRefusal(refusal: Refusal, snapshot: PermissionsSnapshot): string {
  const maybe = refusal.certainty === 'confirmed' ? '' : 'probably '
  switch (refusal.by) {
    case 'rule': {
      const source = refusal.rule === undefined ? undefined : ruleSource(snapshot, refusal.rule, 'deny') ?? ruleSource(snapshot, refusal.rule)
      return `rule ${refusal.rule ?? '?'}${source !== undefined ? ` in ${SOURCE_LABEL[source]}` : ''}`
    }
    case 'mode':
      return refusal.certainty === 'confirmed' ? 'the permission mode' : "the permission mode or the tool's own check"
    case 'prompt':
      return `${maybe}you, at the permission prompt`
    case 'settings-hook':
      return `${maybe}a ${refusal.hook ?? 'PreToolUse'} settings hook`
    case 'mod':
      return refusal.plugin === undefined ? `${maybe}a mod` : `${maybe}mod ${refusal.plugin}${refusal.tier !== undefined ? ` (${refusal.tier} tier)` : ''}`
    case 'devtools':
      return 'Claude DevTools (your breakpoint)'
    default:
      return 'not determinable'
  }
}

/** Keeps the newest refusals, one per call. */
export function addDenial(list: readonly Denial[], denial: Denial): Denial[] {
  return [...list.filter(one => one.id !== denial.id), denial].slice(-MAX_DENIALS)
}

const BEHAVIOR_MARK = { deny: '✗', ask: '?', allow: '✓' } as const

/** The rules and the refused calls as text: the command's output. */
export function permissionsReport(snapshot: PermissionsSnapshot, denials: readonly Denial[]): string[] {
  const out = [`Default mode: ${snapshot.defaultMode === undefined ? 'default (not set)' : `${snapshot.defaultMode.mode} (${SOURCE_LABEL[snapshot.defaultMode.source]})`}`]
  for (const behavior of BEHAVIORS) {
    const rows = snapshot.rules.filter(row => row.behavior === behavior)
    out.push(`${behavior[0]?.toUpperCase()}${behavior.slice(1)} rules: ${rows.length === 0 ? 'none' : rows.length}`)
    for (const row of rows) out.push(`  ${BEHAVIOR_MARK[behavior]} ${behavior.padEnd(5)} ${row.rule}  · ${SOURCE_LABEL[row.source]}${row.source === 'policy' ? ' 🔒' : ''}`)
  }
  if (snapshot.directories.length > 0) out.push(`Extra directories: ${snapshot.directories.map(dir => `${dir.path} (${SOURCE_LABEL[dir.source]})`).join(', ')}`)
  for (const error of snapshot.errors) out.push(`Not read: ${error}`)
  out.push('', denials.length === 0 ? 'Refused calls: none this session.' : `Refused calls (${denials.length}), newest first:`)
  for (const denial of [...denials].reverse()) {
    out.push(`  ✗ ${new Date(denial.atMs).toISOString().slice(11, 19)} ${denial.tool} ${denial.inputSummary}`.trimEnd())
    out.push(`    refused by ${describeRefusal(denial.refusal, snapshot)} (${denial.refusal.certainty})`)
    out.push(`    reason: ${denial.refusal.reason}`)
    out.push(`    evidence: ${denial.refusal.evidence}`)
  }
  return out
}
