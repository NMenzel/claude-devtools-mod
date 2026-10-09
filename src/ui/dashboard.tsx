// The dashboard: every part of the debugger at a glance, in bordered panels
// (paused calls, breakpoints, the call strip, errors, the timeline). Two columns when
// docked wide, stacked when narrow, a three-line summary inline above the prompt.

import type { RenderElement } from 'claude-code'

import type { TraceEvent, TraceStatus } from '../../types'
import { describeBreakpoint } from '../core/breakpoints.ts'
import { truncate } from '../core/events.ts'
import { formatDuration, statusIcon } from '../core/recorder.ts'
import { CATEGORIES, familyOf, findCategoryRule } from '../core/suggest.ts'
import type { PaneActions, PaneModel, Table } from './model.ts'
import { C, LEGEND, NEXT_MODE, STATUS_COLOR } from './theme.ts'

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19)
}

export function timelineLine(event: TraceEvent, width: number): string {
  const agent = event.agentId === undefined ? '' : ' [sub]'
  const tool = event.tool.length > 12 ? `${event.tool.slice(0, 11)}…` : event.tool.padEnd(12)
  const head = `${event.startedAt.slice(11, 19)} ${statusIcon(event.status)} ${tool} ${formatDuration(event.durationMs).padStart(6)} `
  const tail = `${event.simulated ? 'SIMULATED ' : ''}${event.inputSummary}${agent}`
  return truncate(head + tail, Math.max(20, width))
}

/** A titled, round-bordered panel; `inner` is the width its children get. */
function panel(els: Table, key: string, title: string, color: string, width: number, right: string | undefined, children: RenderElement[]): RenderElement {
  const { Box, Text } = els
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={color} bold>
          {title}
        </Text>
        {right !== undefined && <Text dimColor>{right}</Text>}
      </Box>
      {children}
    </Box>
  )
}

/** Runs of colored cells, one per call, oldest first: one Text per run, never one per cell. */
function strip(els: Table, events: readonly TraceEvent[], cells: number): RenderElement {
  const { Box, Text } = els
  const shown = events.slice(-Math.max(1, cells))
  const runs: Array<{ status: TraceStatus; count: number }> = []
  for (const event of shown) {
    const last = runs.at(-1)
    if (last !== undefined && last.status === event.status) last.count += 1
    else runs.push({ status: event.status, count: 1 })
  }
  if (runs.length === 0) return <Text dimColor>{'·'.repeat(Math.max(1, Math.min(cells, 24)))}</Text>
  return (
    <Box flexDirection="row">
      {runs.map((run, i) => (
        <Text key={`run-${i}`} color={STATUS_COLOR[run.status]}>
          {'■'.repeat(run.count)}
        </Text>
      ))}
    </Box>
  )
}

export function categoryRow(els: Table, m: PaneModel, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="row" columnGap={1} flexWrap="wrap">
      <Text dimColor>pause on</Text>
      {CATEGORIES.map(category => {
        const rule = findCategoryRule(m.settings.breakpoints, category)
        const isOn = rule?.enabled === true
        return <Button key={`cat-${category.id}`} plain dimColor={!isOn} label={`${isOn ? '■' : '□'} ${category.label}`} onPress={() => act.toggleCategory(category)} />
      })}
    </Box>
  )
}


function pausedPanel(els: Table, m: PaneModel, act: PaneActions, width: number): RenderElement | null {
  const { Text, Button } = els
  const isArmed = m.arm.pauseNext || m.arm.step
  if (m.pending.length === 0 && !isArmed) return null
  const inner = width - 4
  const rows: RenderElement[] = []
  for (const p of m.pending) {
    rows.push(
      <Text key={`pending-${p.id}`} color={C.paused} bold wrap="truncate-end">
        {truncate(`⏸ ${p.tool}  ${p.inputSummary}`, inner)}
      </Text>,
      <Text key={`pending-why-${p.id}`} dimColor wrap="truncate-end">
        {truncate(`  ${p.reason}${p.agentId !== undefined ? ` · subagent ${p.agentId}` : ''} · since ${clock(p.sinceMs)}`, inner)}
      </Text>,
    )
  }
  if (m.pending.length > 0) rows.push(<Text key="pending-hint" dimColor>Answer in the DevTools question above the prompt.</Text>)
  if (isArmed) {
    rows.push(
      <Text key="armed" color={C.paused} wrap="truncate-end">
        {truncate(`◆ the next tool call pauses${m.arm.step ? ' (step)' : ''}${m.arm.reason !== undefined ? ` · ${m.arm.reason}` : ''}`, inner)}
      </Text>,
      <Button key="arm" hotkey="p" plain label="Disarm" onPress={() => act.togglePauseNext()} />,
    )
  }
  return panel(els, 'panel-paused', m.pending.length > 0 ? 'PAUSED' : 'ARMED', C.paused, width, m.pending.length > 0 ? `${m.pending.length} held` : undefined, rows)
}

function breakpointsPanel(els: Table, m: PaneModel, act: PaneActions, width: number, maxRules: number): RenderElement {
  const { Box, Text, Button } = els
  const bps = m.settings.breakpoints
  const on = bps.filter(bp => bp.enabled).length
  const hits = bps.reduce((sum, bp) => sum + bp.hitCount, 0)
  const inner = width - 4
  const shown = bps.slice(0, maxRules)
  const rows: RenderElement[] = [categoryRow(els, m, act)]
  if (bps.length === 0) {
    rows.push(<Text key="none" dimColor wrap="wrap">No breakpoints. Tick a category, or use "break on" under a tool call in the transcript.</Text>)
  }
  for (const bp of shown) {
    rows.push(
      <Box key={`rule-${bp.id}`} flexDirection="row" columnGap={1}>
        <Text color={bp.enabled ? C.breakpoints : C.faint}>{bp.enabled ? '●' : '○'}</Text>
        <Button
          key={`rule-toggle-${bp.id}`}
          plain
          dimColor={!bp.enabled}
          label={truncate(`${bp.id} ${bp.name} · ${describeBreakpoint(bp)} · ${bp.hitCount} hits`, inner - 2)}
          onPress={() => act.toggleBreakpoint(bp.id)}
        />
      </Box>,
    )
  }
  if (bps.length > shown.length) rows.push(<Text key="more" dimColor>{`… ${bps.length - shown.length} more · b: all breakpoints`}</Text>)
  return panel(els, 'panel-breakpoints', 'BREAKPOINTS', C.breakpoints, width, `${on} on · ${bps.length - on} off · ${hits} hits`, rows)
}

function callsPanel(els: Table, m: PaneModel, width: number): RenderElement {
  const { Box, Text } = els
  const s = m.stats
  const inner = width - 4
  const families = new Map<string, number>()
  for (const event of m.trace) families.set(familyOf(event.tool), (families.get(familyOf(event.tool)) ?? 0) + 1)
  const familyText = [...families].map(([family, n]) => `${family} ${n}`).join(' · ')
  const counts: Record<string, number> = { completed: s.completed, failed: s.failed, denied: s.denied, simulated: s.simulated, pending: m.pending.length }
  return panel(els, 'panel-calls', 'CALLS', C.calls, width, `${s.observed} observed`, [
    strip(els, m.trace, inner),
    <Box key="totals" flexDirection="row" columnGap={2} flexWrap="wrap">
      {LEGEND.map(([status, label]) => (
        <Box key={`total-${status}`} flexDirection="row">
          <Text color={STATUS_COLOR[status]}>■ </Text>
          <Text>{`${counts[status] ?? 0} ${label}`}</Text>
        </Box>
      ))}
    </Box>,
    <Text key="families" dimColor wrap="truncate-end">
      {truncate(familyText === '' ? (m.settings.recording ? 'no calls yet' : 'recording off: only breakpoint matches are kept') : familyText, inner)}
    </Text>,
  ])
}

/** Error Lens at a glance: the latest kinds of failure, each one press from its diagnosis. */
function errorsPanel(els: Table, m: PaneModel, act: PaneActions, width: number, maxRows: number): RenderElement | null {
  const { Button } = els
  if (m.groups.length === 0 || m.options.errorLens === 'off') return null
  const inner = width - 4
  const rows = m.groups.slice(0, maxRows).map((group, i) => (
    <Button
      key={`err-${i}`}
      plain
      label={truncate(`✗ ${group.count > 1 ? `${group.count}× ` : ''}${group.tool} · ${group.category} · ${group.headline}`, inner)}
      onPress={() => act.openLens(group.ids.at(-1) ?? '')}
    />
  ))
  return panel(els, 'panel-errors', 'ERRORS', 'error', width, `${m.lens.length} kept · e: Error Lens`, rows)
}

function timelinePanel(els: Table, m: PaneModel, act: PaneActions, width: number, maxRows: number): RenderElement {
  const { Text, Button } = els
  const inner = width - 4
  const events = [...m.trace].reverse().slice(0, Math.max(1, maxRows))
  const rows: RenderElement[] =
    events.length === 0
      ? [<Text key="empty" dimColor>Tool calls appear here as Claude makes them.</Text>]
      : events.map(event => (
          <Button
            key={`ev-${event.id}`}
            plain
            dimColor={event.status === 'completed'}
            label={timelineLine(event, inner)}
            onPress={() => act.inspect(event.id)}
          />
        ))
  return panel(els, 'panel-timeline', 'TIMELINE', C.timeline, width, `${m.trace.length} kept · t: all`, rows)
}

function actions(els: Table, m: PaneModel, act: PaneActions): RenderElement {
  const { Box, Button } = els
  const isArmed = m.arm.pauseNext || m.arm.step
  return (
    <Box key="actions" flexDirection="row" columnGap={2} flexWrap="wrap">
      {!isArmed && <Button key="arm" hotkey="p" plain label="Pause next call" onPress={() => act.togglePauseNext()} />}
      <Button key="rec" hotkey="r" plain label={m.settings.recording ? 'Stop recording' : 'Record'} onPress={() => act.toggleRecording()} />
      <Button key="mode" hotkey="m" plain label={`Mode → ${NEXT_MODE[m.settings.mode]}`} onPress={() => act.setMode(NEXT_MODE[m.settings.mode])} />
      <Button key="export" hotkey="s" plain label="Export" onPress={() => act.exportTrace()} />
    </Box>
  )
}

function mini(els: Table, m: PaneModel, act: PaneActions, width: number): RenderElement {
  const { Box, Text } = els
  const s = m.stats
  const on = m.settings.breakpoints.filter(bp => bp.enabled).length
  const pending = m.pending[0]
  const isArmed = m.arm.pauseNext || m.arm.step
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={pending !== undefined ? C.paused : C.faint} paddingX={1} width={width}>
      {pending !== undefined ? (
        <Text color={C.paused} bold wrap="truncate-end">
          {truncate(`⏸ ${pending.tool} ${pending.inputSummary} · ${pending.reason}`, width - 4)}
        </Text>
      ) : (
        <Text dimColor wrap="truncate-end">
          {`${on} breakpoint${on === 1 ? '' : 's'} on${isArmed ? ' · ◆ next call pauses' : ''} · ${s.observed} calls`}
        </Text>
      )}
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>calls</Text>
        {strip(els, m.trace, Math.max(8, Math.min(40, width - 40)))}
        <Text dimColor wrap="truncate-end">{`${s.completed} ok · ${s.failed} failed · ${s.denied} denied${s.simulated > 0 ? ` · ${s.simulated} simulated` : ''}`}</Text>
      </Box>
      {actions(els, m, act)}
    </Box>
  )
}

export function dashboard(els: Table, m: PaneModel, act: PaneActions, width: number): RenderElement {
  const { Box } = els
  if (m.layout === 'mini') return mini(els, m, act, width)
  if (m.layout === 'wide') {
    const left = Math.floor((width - 1) / 2)
    const right = width - left - 1
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Box flexDirection="column" width={left}>
            {pausedPanel(els, m, act, left)}
            {breakpointsPanel(els, m, act, left, 8)}
            {callsPanel(els, m, left)}
          </Box>
          <Box flexDirection="column" width={right}>
            {errorsPanel(els, m, act, right, 3)}
            {timelinePanel(els, m, act, right, Math.max(5, m.rows - 8 - (m.groups.length > 0 ? Math.min(3, m.groups.length) + 3 : 0)))}
          </Box>
        </Box>
        {actions(els, m, act)}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {pausedPanel(els, m, act, width)}
      {errorsPanel(els, m, act, width, 3)}
      {breakpointsPanel(els, m, act, width, 5)}
      {callsPanel(els, m, width)}
      {timelinePanel(els, m, act, width, Math.max(3, Math.min(8, m.rows - 22)))}
      {actions(els, m, act)}
    </Box>
  )
}
