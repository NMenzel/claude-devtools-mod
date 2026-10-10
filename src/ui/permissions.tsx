// The Permissions tab: each refused call with who refused it (a rule and its
// settings file, the mode, you at the prompt, a settings hook, another mod,
// DevTools) and its reason, then the permission rules as the settings files
// hold them. Pure view; reading the settings happens in the native layer.

import type { RenderElement } from 'claude-code'

import type { PermissionRuleRow } from '../../types'
import { truncate } from '../core/events.ts'
import { describeRefusal, SOURCE_LABEL } from '../core/permissions.ts'
import type { PaneActions, PaneModel, Table } from './model.ts'
import { C } from './theme.ts'

const BEHAVIOR = {
  deny: { mark: '✗', color: 'error' },
  ask: { mark: '?', color: 'warning' },
  allow: { mark: '✓', color: 'success' },
} as const satisfies Record<PermissionRuleRow['behavior'], { mark: string; color: string }>

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19)
}

export function permissionsView(els: Table, m: PaneModel, act: PaneActions, width: number): RenderElement {
  const { Box, Text, Button } = els
  const p = m.permissions
  const maxDenials = Math.max(1, Math.min(6, Math.floor((m.rows - 6) / 4)))
  const maxRules = Math.max(3, m.rows - 8 - Math.min(m.denials.length, maxDenials) * 3)
  const rows: RenderElement[] = []

  rows.push(
    <Text key="den-title" bold>
      {m.denials.length === 0 ? 'REFUSED CALLS · none this session' : `REFUSED CALLS · ${m.denials.length}, newest first`}
    </Text>,
  )
  for (const denial of [...m.denials].reverse().slice(0, maxDenials)) {
    const sure = denial.refusal.certainty === 'confirmed'
    rows.push(
      <Button
        key={`den-${denial.id}`}
        plain
        label={truncate(`✗ ${clock(denial.atMs)} ${denial.tool}${denial.inputSummary !== '' ? ` ${denial.inputSummary}` : ''}`, width - 2)}
        onPress={() => act.openDenial(denial.id)}
      />,
      <Text key={`den-by-${denial.id}`} color={sure ? 'success' : 'warning'} wrap="truncate-end">
        {truncate(`  ${sure ? '✔' : '?'} by ${describeRefusal(denial.refusal, p)}`, width)}
      </Text>,
      <Text key={`den-why-${denial.id}`} dimColor wrap="truncate-end">
        {truncate(`  "${denial.refusal.reason.replace(/\s*\n\s*/g, ' ')}"`, width)}
      </Text>,
    )
  }
  if (m.denials.length > maxDenials) {
    rows.push(
      <Text key="den-more" dimColor wrap="truncate-end">
        {truncate(`  … ${m.denials.length - maxDenials} older (/devtools-permissions lists all)`, width)}
      </Text>,
    )
  }

  const mode = p.defaultMode === undefined ? 'default (not set)' : `${p.defaultMode.mode} (${SOURCE_LABEL[p.defaultMode.source]})`
  rows.push(
    <Text key="rules-title" bold wrap="truncate-end">
      {truncate(p.readAtMs === 0 ? 'RULES · not read yet' : `RULES · ${p.rules.length} · default mode ${mode} · read ${clock(p.readAtMs)}`, width)}
    </Text>,
  )
  if (p.readAtMs !== 0 && p.rules.length === 0) {
    rows.push(
      <Text key="rules-none" dimColor wrap="truncate-end">
        {truncate('  No allow, ask or deny rules in any settings file.', width)}
      </Text>,
    )
  }
  for (const [i, rule] of p.rules.slice(0, maxRules).entries()) {
    const style = BEHAVIOR[rule.behavior]
    // Narrow panes name the file by its short source name.
    const where = `${width < 70 ? rule.source : SOURCE_LABEL[rule.source]}${rule.source === 'policy' ? ' 🔒' : ''}`
    rows.push(
      <Box key={`rule-${i}`} flexDirection="row" columnGap={1}>
        <Text color={style.color}>{` ${style.mark}`}</Text>
        <Text wrap="truncate-end">{truncate(`${rule.behavior.padEnd(5)} ${rule.rule}`, Math.max(8, width - where.length - 6))}</Text>
        <Text dimColor wrap="truncate-end">{where}</Text>
      </Box>,
    )
  }
  if (p.rules.length > maxRules) {
    rows.push(
      <Text key="rules-more" dimColor wrap="truncate-end">
        {truncate(`  … ${p.rules.length - maxRules} more (/devtools-permissions lists all)`, width)}
      </Text>,
    )
  }
  if (p.directories.length > 0) {
    rows.push(
      <Text key="dirs" dimColor wrap="truncate-end">
        {truncate(`  extra directories: ${p.directories.map(dir => dir.path).join(', ')}`, width)}
      </Text>,
    )
  }
  for (const [i, error] of p.errors.entries()) {
    rows.push(
      <Text key={`perr-${i}`} color={C.paused} wrap="truncate-end">
        {truncate(`  not read: ${error}`, width)}
      </Text>,
    )
  }
  rows.push(
    <Box key="perm-nav" flexDirection="row" columnGap={2} flexWrap="wrap" marginTop={1}>
      <Button key="perm-reload" hotkey="r" plain label="Reload rules" onPress={() => act.reloadPermissions()} />
      <Button key="perm-clear" hotkey="c" plain dimColor label="Clear refused" onPress={() => act.clearDenials()} />
      {m.layout !== 'mini' && (
        <Text dimColor wrap="truncate-end">
          {truncate('✔ confirmed · ? possible · press a call for its detail', width)}
        </Text>
      )}
    </Box>,
  )
  return <Box flexDirection="column">{rows}</Box>
}
