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

export const BAR_HINT = '/bp <rule> · /devtools-help'
/** Longest first: the bar shows the longest that still fits on its line. */
const HINTS = [BAR_HINT, '/bp <rule>']
/** A plain Button with a hotkey draws `t: label`. */
const BUTTON_EXTRA = 3
/** Cells the engine keeps at the band's right edge (its `[−]` fold control). */
const EDGE = 4
const BREAK_ON = '· break on'

/** What the bar shows, so that it always fits one line. */
export type BarFit = { summary?: string; offers: number; lens: boolean; hide: boolean; open: boolean; hint?: string }

/**
 * Lays the bar out on one line, never wrapping: the brand and status first,
 * then each part in order of importance (the breakpoint keys, the Error Lens
 * key, hide, open, the call's summary, the hint), each only if the rest of the
 * line still has room for it.
 */
export function fitBar(width: number, summary: string, offerLabels: readonly string[], lens: string | undefined): BarFit {
  let room = width - EDGE - 'DevTools'.length - 2
  const take = (cells: number): boolean => (cells <= room ? ((room -= cells), true) : false)
  const button = (label: string): number => 1 + BUTTON_EXTRA + label.length
  let offers = 0
  if (offerLabels.length > 0 && take(1 + BREAK_ON.length)) {
    for (const label of offerLabels) {
      if (!take(button(label))) break
      offers += 1
    }
    // "break on" with no key after it says nothing.
    if (offers === 0) room += 1 + BREAK_ON.length
  }
  const showLens = lens !== undefined && take(button(lens))
  const hide = take(button('hide'))
  const open = take(button('DevTools'))
  // The summary gets what is left, at most a third of the line; cut below 12 cells it tells nothing.
  const cells = Math.min(summary.length, Math.floor(width / 3), room - 1)
  const shown = cells > 0 && cells >= Math.min(12, summary.length) ? truncate(summary, cells) : undefined
  if (shown !== undefined) room -= 1 + shown.length
  const hint = HINTS.find(text => take(3 + text.length))
  return { offers, lens: showLens, hide, open, ...(shown !== undefined ? { summary: shown } : {}), ...(hint !== undefined ? { hint } : {}) }
}

/**
 * The bar above the prompt: the latest call, one-key breakpoints for it, its
 * Error Lens when it failed, and a dim hint. Before the first call, the hint alone.
 */
export function renderBar(
  els: Table,
  below: RenderElement,
  event: TraceEvent | undefined,
  offers: readonly Offer[],
  width: number,
  on: { toggle: (offer: Offer) => void; open: () => void; hide: () => void; lens: () => void },
): RenderElement {
  const { Box, Text, Button } = els
  const cells = Math.max(24, width)
  if (event === undefined) {
    return (
      <Box flexDirection="column">
        {below}
        <Box key="devtools-bar" flexDirection="row" columnGap={1} width={cells}>
          <Text color={C.brand} dimColor>
            DevTools
          </Text>
          <Text dimColor wrap="truncate-end">
            {truncate(`· press "break on" under any tool call, or ${BAR_HINT}`, cells - EDGE - 9)}
          </Text>
        </Box>
      </Box>
    )
  }
  const lens = event.errorCategory !== undefined ? `✗ why? (${event.errorCategory})` : undefined
  const fit = fitBar(cells, `${event.tool} ${event.inputSummary}`, offers.map(offerLabel), lens)
  const keys = offers.slice(0, fit.offers)
  return (
    <Box flexDirection="column">
      {below}
      <Box key="devtools-bar" flexDirection="row" columnGap={1} width={cells}>
        <Text color={C.brand} bold>
          DevTools
        </Text>
        <Text color={STATUS_COLOR[event.status]}>{statusIcon(event.status)}</Text>
        {fit.summary !== undefined && <Text dimColor>{fit.summary}</Text>}
        {keys.length > 0 && <Text dimColor>{BREAK_ON}</Text>}
        {keys.map(offer => (
          <Button key={`bar-${offer.id}`} hotkey={BAR_HOTKEY[offer.id]} plain dimColor={offer.rule === undefined} label={offerLabel(offer)} onPress={() => on.toggle(offer)} />
        ))}
        {fit.lens && lens !== undefined && <Button key="bar-lens" hotkey="e" plain label={lens} onPress={() => on.lens()} />}
        {fit.open && <Button key="bar-open" hotkey="d" plain dimColor label="DevTools" onPress={() => on.open()} />}
        {fit.hide && <Button key="bar-hide" hotkey="x" plain dimColor label="hide" onPress={() => on.hide()} />}
        {fit.hint !== undefined && <Text dimColor>{`· ${fit.hint}`}</Text>}
      </Box>
    </Box>
  )
}
