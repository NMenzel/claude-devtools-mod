// Breakpoints set where the calls are, Chrome DevTools style: a gutter on
// each tool row in the transcript (hover it, press "break on"), a red mark on
// rows a breakpoint covers, and a bar above the prompt for the latest call
// that the keyboard reaches (ctrl+x tab, then its hotkeys).

import type { RenderElement } from 'claude-code'

import type { Breakpoint, TraceEvent } from '../../types'
import { truncate } from '../core/events.ts'
import { statusIcon } from '../core/recorder.ts'
import type { Suggestion } from '../core/suggest.ts'
import type { Table } from './model.ts'
import { C, STATUS_COLOR } from './theme.ts'

/** A suggestion as drawn: its element key, and the rule it stands for when one is set. */
export type Offer = Suggestion & { key: string; rule?: Breakpoint }

export type InlineMode = 'hover' | 'always'

function offerLabel(offer: Offer): string {
  return `${offer.rule !== undefined ? '●' : '○'} ${offer.label}`
}

/**
 * The transcript row with a gutter: the engine's own drawing first, a red
 * line naming the breakpoints that cover the call, then the "break on"
 * controls. `hover` lays them over the row's top right, shown only while the
 * pointer is over the row, so nothing moves; `always` gives them a line.
 */
export function renderGutter(els: Table, drawn: RenderElement, matched: readonly Breakpoint[], offers: readonly Offer[], mode: InlineMode, onToggle: (offer: Offer) => void): RenderElement {
  const { Box, Text, Button } = els
  const buttons = offers.map(offer => <Button key={offer.key} plain dimColor={offer.rule === undefined} label={offerLabel(offer)} onPress={() => onToggle(offer)} />)
  return (
    <Box key="devtools-row" flexDirection="column">
      {drawn}
      {matched.length > 0 && (
        <Text key="devtools-mark" color={C.breakpoints} wrap="truncate-end">
          {`  ● breakpoint ${matched.map(bp => `${bp.id} ${bp.name} → ${bp.action}`).join(' · ')}`}
        </Text>
      )}
      {mode === 'hover' ? (
        <Box position="absolute" top={0} right={0} flexDirection="row" columnGap={1} display="none" hover={{ display: 'flex' }}>
          <Text color={C.breakpoints}>break on</Text>
          {buttons}
        </Box>
      ) : (
        <Box key="devtools-gutter" flexDirection="row" columnGap={1} marginLeft={2}>
          <Text dimColor>break on</Text>
          {buttons}
        </Box>
      )}
    </Box>
  )
}

const BAR_HOTKEY: Record<Suggestion['id'], string> = { tool: 't', command: 'c', path: 'f' }

/** The bar above the prompt: the latest call, one-key breakpoints for it, and its Error Lens when it failed. */
export function renderBar(
  els: Table,
  below: RenderElement,
  event: TraceEvent,
  offers: readonly Offer[],
  width: number,
  on: { toggle: (offer: Offer) => void; open: () => void; hide: () => void; lens: () => void },
): RenderElement {
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="column">
      {below}
      <Box key="devtools-bar" flexDirection="row" columnGap={1} flexWrap="wrap" width={Math.max(24, width)}>
        <Text color={C.brand} bold>
          DevTools
        </Text>
        <Text color={STATUS_COLOR[event.status]}>{statusIcon(event.status)}</Text>
        <Text dimColor wrap="truncate-end">
          {truncate(`${event.tool} ${event.inputSummary}`, Math.max(16, Math.floor(width / 3)))}
        </Text>
        <Text dimColor>· break on</Text>
        {offers.map(offer => (
          <Button key={`bar-${offer.id}`} hotkey={BAR_HOTKEY[offer.id]} plain dimColor={offer.rule === undefined} label={offerLabel(offer)} onPress={() => on.toggle(offer)} />
        ))}
        {event.errorCategory !== undefined && <Button key="bar-lens" hotkey="e" plain label={`✗ why? (${event.errorCategory})`} onPress={() => on.lens()} />}
        <Button key="bar-open" hotkey="d" plain dimColor label="DevTools" onPress={() => on.open()} />
        <Button key="bar-hide" hotkey="x" plain dimColor label="hide" onPress={() => on.hide()} />
      </Box>
    </Box>
  )
}
