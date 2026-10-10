// The DevTools pane: a header and legend, then the Dashboard, Timeline,
// Inspector, Breakpoints, Errors and Permissions tabs. Pure view: it draws from a model and calls
// the actions it is handed; every write happens in the native layer.

import type { RenderElement } from 'claude-code'

import type { DevtoolsMode, DevtoolsTab, TraceEvent } from '../../types'
import { describeBreakpoint } from '../core/breakpoints.ts'
import { truncate } from '../core/events.ts'
import { formatDuration, statusIcon } from '../core/recorder.ts'
import { findRule, suggestBreakpoints } from '../core/suggest.ts'
import { categoryRow, dashboard, timelineLine } from './dashboard.tsx'
import { errorsView } from './lens.tsx'
import { permissionsView } from './permissions.tsx'
import type { PaneActions, PaneModel, Table } from './model.ts'
import { C, LEGEND, MODE_COLOR, NEXT_MODE, STATUS_COLOR } from './theme.ts'

export { timelineLine }
export type { PaneActions, PaneModel }

const TABS: ReadonlyArray<readonly [DevtoolsTab, string, string]> = [
  ['dashboard', 'Dashboard', 'd'],
  ['timeline', 'Timeline', 't'],
  ['inspector', 'Inspector', 'i'],
  ['breakpoints', 'Breakpoints', 'b'],
  ['errors', 'Errors', 'e'],
  ['permissions', 'Permissions', 'a'],
]

/** The newest-first page of the timeline the Timeline tab shows. */
export function timelinePage(trace: readonly TraceEvent[], page: number, size: number): { items: TraceEvent[]; page: number; pages: number } {
  const newest = [...trace].reverse()
  const pages = Math.max(1, Math.ceil(newest.length / size))
  const at = Math.min(Math.max(0, page), pages - 1)
  return { items: newest.slice(at * size, at * size + size), page: at, pages }
}

function header(els: Table, m: PaneModel): RenderElement {
  const { Box, Text } = els
  const on = m.settings.breakpoints.filter(bp => bp.enabled).length
  return (
    <Box key="header" flexDirection="column">
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text bold>CLAUDE DEVTOOLS</Text>
        <Text dimColor>·</Text>
        <Text color={MODE_COLOR[m.settings.mode]} bold>{`● ${m.settings.mode}`}</Text>
        <Text dimColor>·</Text>
        <Text color={m.settings.recording ? C.breakpoints : C.faint}>{m.settings.recording ? '⏺ recording' : '○ not recording'}</Text>
        <Text dimColor>·</Text>
        <Text color={C.breakpoints}>{`${on} breakpoint${on === 1 ? '' : 's'}`}</Text>
        {m.pending.length > 0 && <Text dimColor>·</Text>}
        {m.pending.length > 0 && <Text color={C.paused} bold>{`⏸ ${m.pending.length} paused`}</Text>}
        {m.options.simulation && <Text color="planMode">· simulation</Text>}
        {m.options.captureRaw && <Text color="error">· RAW CAPTURE</Text>}
        {!m.session.isInteractive && <Text color={C.paused}>· headless</Text>}
      </Box>
      {m.layout !== 'mini' && (
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {LEGEND.map(([status, label]) => (
            <Box key={`legend-${status}`} flexDirection="row">
              <Text color={STATUS_COLOR[status]}>■ </Text>
              <Text dimColor>{label}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

export function renderPane(els: Table, m: PaneModel, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els
  const width = Math.max(24, m.columns)
  return (
    <Box flexDirection="column" width={width}>
      {header(els, m)}
      <Box flexDirection="row" columnGap={2} flexWrap="wrap" marginBottom={m.layout === 'mini' ? 0 : 1}>
        {TABS.map(([tab, label, hotkey]) => (
          <Button
            key={`tab-${tab}`}
            label={tab === 'errors' && m.lens.length > 0 ? `${label} ${m.lens.length}` : tab === 'permissions' && m.denials.length > 0 ? `${label} ${m.denials.length}` : label}
            hotkey={hotkey}
            plain
            dimColor={m.view.tab !== tab}
            onPress={() => act.setTab(tab)}
          />
        ))}
      </Box>
      {m.view.tab === 'dashboard' && dashboard(els, m, act, width)}
      {m.view.tab === 'timeline' && timeline(els, m, act, width)}
      {m.view.tab === 'inspector' && inspector(els, m, act, width)}
      {m.view.tab === 'breakpoints' && breakpoints(els, m, act, width)}
      {m.view.tab === 'errors' && errorsView(els, m, act, width)}
      {m.view.tab === 'permissions' && permissionsView(els, m, act, width)}
      {m.view.notice !== undefined && (
        <Text key="notice" color={C.paused} wrap="truncate-end">
          {m.view.notice}
        </Text>
      )}
    </Box>
  )
}

function timeline(els: Table, m: PaneModel, act: PaneActions, width: number): RenderElement {
  const { Box, Text, Button } = els
  const size = Math.max(3, m.rows - 7)
  const { items, page, pages } = timelinePage(m.trace, m.view.page, size)
  return (
    <Box flexDirection="column">
      {items.length === 0 && (
        <Text dimColor>{m.settings.recording ? 'No tool calls recorded yet.' : 'Recording is off: only breakpoint matches are kept.'}</Text>
      )}
      {items.map(e => (
        <Box key={`row-${e.id}`} flexDirection="row">
          <Text color={STATUS_COLOR[e.status]}>{e.breakpointIds !== undefined ? '●' : ' '}</Text>
          <Button key={`ev-${e.id}`} plain dimColor={e.status === 'completed'} label={timelineLine(e, width - (e.errorCategory !== undefined ? 9 : 2))} onPress={() => act.inspect(e.id)} />
          {e.errorCategory !== undefined && <Button key={`why-${e.id}`} plain label=" why?" onPress={() => act.openLens(e.id)} />}
        </Box>
      ))}
      <Box flexDirection="row" columnGap={2} flexWrap="wrap" marginTop={1}>
        <Button key="newer" hotkey="k" plain dimColor={page === 0} label="Newer" onPress={() => act.page(-1)} />
        <Button key="older" hotkey="j" plain dimColor={page >= pages - 1} label="Older" onPress={() => act.page(1)} />
        <Button key="clear" hotkey="x" plain dimColor label="Clear" onPress={() => act.clearTimeline()} />
        <Text dimColor>{`page ${page + 1}/${pages} · ${m.trace.length} events · ● matched a breakpoint`}</Text>
      </Box>
    </Box>
  )
}

function field(els: Table, label: string, value: string, width: number, color?: string): RenderElement {
  const { Text } = els
  return (
    <Text key={`f-${label}`} wrap="truncate-end" color={color}>
      {truncate(`${label.padEnd(11)}${value}`, width)}
    </Text>
  )
}

const SUGGESTION_HOTKEY = { tool: '1', command: '2', path: '3' } as const

function inspector(els: Table, m: PaneModel, act: PaneActions, width: number): RenderElement {
  const { Box, Text, Button, Code } = els
  const event = m.trace.find(e => e.id === m.view.selectedId) ?? m.trace.at(-1)
  if (event === undefined) return <Text dimColor>No event to inspect yet. Events appear as Claude calls tools.</Text>
  const index = m.trace.indexOf(event)
  const older = m.trace[index - 1]
  const newer = m.trace[index + 1]
  const bpNames = (event.breakpointIds ?? []).map(id => m.settings.breakpoints.find(bp => bp.id === id)?.name ?? id)
  const permission =
    event.permission === undefined
      ? '—'
      : `${event.permission.decision}${event.permission.rule !== undefined ? ` by ${event.permission.rule}` : ''} (${event.permission.source})`
  const suggestions = suggestBreakpoints(event.tool, event.input, m.session.cwd)
  return (
    <Box flexDirection="column">
      <Text bold color={STATUS_COLOR[event.status]} wrap="truncate-end">
        {`${statusIcon(event.status)} ${event.tool} · ${event.status}${event.outcome !== undefined ? ` · ${event.outcome}` : ''}${event.simulated ? ' · SIMULATED (tool did not run)' : ''}`}
      </Text>
      {field(els, 'event', `#${event.seq}  ${event.id}`, width)}
      {field(els, 'session', event.sessionId || 'unknown', width)}
      {field(els, 'agent', event.agentId ?? 'main', width)}
      {field(els, 'started', event.startedAt, width)}
      {field(els, 'duration', formatDuration(event.durationMs), width)}
      {field(els, 'risk', event.risk, width, event.risk === 'destructive' ? 'error' : undefined)}
      {field(els, 'permission', permission, width)}
      {field(els, 'breakpoint', bpNames.length > 0 ? `${bpNames.join(', ')}${event.decision !== undefined ? ` → ${event.decision}` : ''}` : '—', width)}
      {field(els, 'synthetic', event.simulated ? 'yes: a simulated result, not the real tool' : 'no', width)}
      {field(els, 'result', event.resultSummary ?? '—', width)}
      {event.errorText !== undefined && field(els, 'error', event.errorText, width, 'error')}
      {event.errorCategory !== undefined && (
        <Box key="lens-link" flexDirection="row" columnGap={1}>
          <Text color="error">{`${'diagnosis'.padEnd(10)} ${event.errorCategory}`}</Text>
          <Button key="open-lens" hotkey="w" plain label="Why it failed (Error Lens)" onPress={() => act.openLens(event.id)} />
        </Box>
      )}
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text dimColor>break on</Text>
        {suggestions.map(s => {
          const rule = findRule(m.settings.breakpoints, s.kind, s.match)
          return (
            <Button
              key={`sug-${s.id}`}
              hotkey={SUGGESTION_HOTKEY[s.id]}
              plain
              dimColor={rule === undefined}
              label={`${rule !== undefined ? '●' : '○'} ${s.label}`}
              onPress={() => act.toggleSuggestion(s)}
            />
          )
        })}
      </Box>
      <Text bold>Input</Text>
      <Code key="input" language="json" source={JSON.stringify(event.input ?? { summary: event.inputSummary }, null, 2)} wrap="truncate-end" />
      {event.raw !== undefined && <Text color="warning">Raw capture (may contain file contents)</Text>}
      {event.raw !== undefined && <Code key="raw" language="text" source={`${event.raw.input ?? ''}\n---\n${event.raw.result ?? ''}`} wrap="truncate-end" />}
      <Box flexDirection="row" columnGap={2} flexWrap="wrap" marginTop={1}>
        <Button key="prev" hotkey="h" plain dimColor={older === undefined} label="Older" onPress={() => older !== undefined && act.inspect(older.id)} />
        <Button key="next" hotkey="l" plain dimColor={newer === undefined} label="Newer" onPress={() => newer !== undefined && act.inspect(newer.id)} />
        <Button key="back" hotkey="x" plain label="Back to timeline" onPress={() => act.setTab('timeline')} />
      </Box>
    </Box>
  )
}

function breakpoints(els: Table, m: PaneModel, act: PaneActions, width: number): RenderElement {
  const { Box, Text, Button } = els
  const Input = m.hasFields && 'Input' in els ? els.Input : undefined
  const Select = m.hasFields && 'Select' in els ? els.Select : undefined
  return (
    <Box flexDirection="column">
      {Select !== undefined ? (
        <Select
          key="mode"
          label="Mode "
          value={m.settings.mode}
          options={[
            { value: 'active', label: 'active: pause on breakpoints' },
            { value: 'observe', label: 'observe: record only, never pause' },
            { value: 'off', label: 'off: debugger does nothing' },
          ]}
          onSelect={value => act.setMode(value as DevtoolsMode)}
        />
      ) : (
        <Button key="mode" plain label={`Mode: ${m.settings.mode} → ${NEXT_MODE[m.settings.mode]}`} onPress={() => act.setMode(NEXT_MODE[m.settings.mode])} />
      )}
      {categoryRow(els, m, act)}
      {m.settings.breakpoints.length === 0 && <Text dimColor>No breakpoints yet.</Text>}
      {m.settings.breakpoints.map(bp => (
        <Box key={`bp-${bp.id}`} flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text color={bp.enabled ? C.breakpoints : C.faint}>{bp.enabled ? '●' : '○'}</Text>
          <Text wrap="truncate-end">{truncate(`${bp.id} ${bp.name}: ${describeBreakpoint(bp)} · hits ${bp.hitCount}`, Math.max(20, width - 22))}</Text>
          <Button key={`bp-toggle-${bp.id}`} plain dimColor label={bp.enabled ? 'Disable' : 'Enable'} onPress={() => act.toggleBreakpoint(bp.id)} />
          <Button key={`bp-delete-${bp.id}`} plain dimColor label="Delete" onPress={() => act.deleteBreakpoint(bp.id)} />
        </Box>
      ))}
      {Input !== undefined ? (
        <Input key="add" label="Add " placeholder="command npm install   ·   file .env*   ·   tool Write" submitLabel="add rule" onSubmit={value => act.addBreakpoint(value)} />
      ) : (
        <Text dimColor>Add rules with /devtools-break on this surface.</Text>
      )}
      <Text dimColor wrap="truncate-end">
        {'Rules: tool <Name> · command <words|re:regex> · file <glob> · error [Tool] · when tool=.. path=..  (--action pause|record|warn)'}
      </Text>
    </Box>
  )
}
