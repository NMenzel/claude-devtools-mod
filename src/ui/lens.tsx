// The Errors tab: Error Lens. One failure at a time, as evidence: the
// original error, what is confirmed, what is only possible, what cannot be
// known from here, the read-only checks, and what to try. Repeats are grouped.

import type { RenderElement } from 'claude-code'

import type { Certainty, LensRecord } from '../../types'
import { truncate } from '../core/events.ts'
import { describeProbe } from '../core/lens.ts'
import { formatDuration } from '../core/recorder.ts'
import type { PaneActions, PaneModel, Table } from './model.ts'
import { C } from './theme.ts'

export const CERTAINTY_STYLE: Record<Certainty, { label: string; color: string }> = {
  confirmed: { label: '✔ CONFIRMED', color: 'success' },
  possible: { label: '? POSSIBLE', color: 'warning' },
  unknown: { label: '· UNKNOWN', color: C.faint },
}

const MESSAGE_LINES = 8

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19)
}

/** The record the tab shows: the one asked for, else the latest. */
export function selectedLens(m: Pick<PaneModel, 'lens' | 'view'>): LensRecord | undefined {
  return m.lens.find(record => record.id === m.view.lensId) ?? m.lens.at(-1)
}

export function lensTitle(record: LensRecord): string {
  const code = record.code !== undefined ? ` (${record.code})` : record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ''
  const verb = record.suspected === true ? 'may have failed' : record.status === 'denied' ? 'denied' : 'failed'
  return `✗ ${record.tool} ${verb} · ${record.category}${code} · ${clock(record.endedAtMs)} · ${formatDuration(record.durationMs)}`
}

export function errorsView(els: Table, m: PaneModel, act: PaneActions, width: number): RenderElement {
  const { Box, Text, Button, Code } = els
  if (m.options.errorLens === 'off') return <Text dimColor>Error Lens is off (the devtools option errorLens).</Text>
  const record = selectedLens(m)
  if (record === undefined) return <Text dimColor>No failed tool calls yet. A failure appears here with its probable cause and evidence.</Text>
  const index = m.lens.indexOf(record)
  const older = m.lens[index - 1]
  const newer = m.lens[index + 1]
  const inTrace = m.trace.some(event => event.id === record.id)
  const message = record.message.split(/\r?\n/)
  const shownMessage = message.slice(0, MESSAGE_LINES).join('\n') + (message.length > MESSAGE_LINES ? `\n… ${message.length - MESSAGE_LINES} more lines` : '')
  const repeated = m.groups.filter(group => group.count > 1)
  const rows: RenderElement[] = []

  if (repeated.length > 0) {
    rows.push(<Text key="rep-title" bold>REPEATED</Text>)
    repeated.slice(0, 4).forEach((group, i) => {
      const latest = group.ids.at(-1) ?? ''
      rows.push(
        <Button
          key={`grp-${i}`}
          plain
          dimColor={!group.ids.includes(record.id)}
          label={truncate(`${group.count}× ${group.tool} · ${group.category} · ${group.headline}`, width - 2)}
          onPress={() => act.openLens(latest)}
        />,
      )
    })
  }

  rows.push(
    <Text key="title" bold color="error" wrap="truncate-end">
      {truncate(lensTitle(record), width)}
    </Text>,
    <Text key="where" dimColor wrap="truncate-end">
      {truncate(`#${record.seq} ${record.id}${record.agentId !== undefined ? ` · subagent ${record.agentId}` : ''} · ${index + 1} of ${m.lens.length}`, width)}
    </Text>,
    <Text key="orig-title" bold>
      Original error
    </Text>,
    <Code key="orig" language="text" source={shownMessage === '' ? '(no error text)' : shownMessage} wrap="truncate-end" />,
  )

  for (const certainty of ['confirmed', 'possible', 'unknown'] as const) {
    const causes = record.causes.filter(one => one.certainty === certainty)
    if (causes.length === 0) continue
    const style = CERTAINTY_STYLE[certainty]
    rows.push(
      <Text key={`c-${certainty}`} bold color={style.color}>
        {style.label}
      </Text>,
    )
    causes.forEach((one, i) => {
      rows.push(
        <Text key={`c-${certainty}-${i}`} wrap="wrap">
          {`  • ${one.text}`}
        </Text>,
      )
      one.evidence.forEach((item, j) => {
        rows.push(
          <Text key={`c-${certainty}-${i}-e${j}`} dimColor wrap="truncate-end">
            {truncate(`    evidence: ${item}`, width)}
          </Text>,
        )
      })
    })
  }

  rows.push(<Text key="checks-title" bold>Checks (read-only, after the failure)</Text>)
  if (record.probes.length > 0) {
    record.probes.forEach((probe, i) => {
      rows.push(
        <Text key={`probe-${i}`} wrap="truncate-end" color={probe.exists === null ? 'warning' : undefined}>
          {truncate(`  ${describeProbe(probe)}`, width)}
        </Text>,
      )
    })
  } else {
    const why = { pending: 'running…', off: 'off (errorLens is classify)', none: 'none apply to this failure', done: 'none' }[record.probeState]
    rows.push(
      <Text key="probe-none" dimColor>
        {`  ${why}`}
      </Text>,
    )
  }

  if (record.fixes.length > 0) {
    rows.push(<Text key="fix-title" bold>Try</Text>)
    record.fixes.forEach((fix, i) => {
      rows.push(
        <Text key={`fix-${i}`} wrap="wrap">
          {`  ${i + 1}. ${fix}`}
        </Text>,
      )
    })
  }

  const permission = record.permission === undefined ? '—' : `${record.permission.decision}${record.permission.rule !== undefined ? ` by ${record.permission.rule}` : ''} (${record.permission.source})`
  rows.push(
    <Text key="perm" wrap="truncate-end" dimColor>
      {truncate(`permission ${permission} · outcome ${record.outcome}`, width)}
    </Text>,
    <Text key="args" wrap="truncate-end" dimColor>
      {truncate(`arguments  ${JSON.stringify(record.args)}`, width)}
    </Text>,
    <Box key="lens-nav" flexDirection="row" columnGap={2} flexWrap="wrap" marginTop={1}>
      <Button key="lens-older" hotkey="h" plain dimColor={older === undefined} label="Older failure" onPress={() => older !== undefined && act.openLens(older.id)} />
      <Button key="lens-newer" hotkey="l" plain dimColor={newer === undefined} label="Newer failure" onPress={() => newer !== undefined && act.openLens(newer.id)} />
      {inTrace && <Button key="lens-inspect" hotkey="o" plain label="Open in Inspector" onPress={() => act.inspect(record.id)} />}
      <Button key="lens-clear" hotkey="c" plain dimColor label="Clear errors" onPress={() => act.clearErrors()} />
    </Box>,
  )
  return <Box flexDirection="column">{rows}</Box>
}
