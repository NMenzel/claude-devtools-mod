# Changelog

## 0.1.2

- Short aliases: `/bp <rule>` (= `/devtools-break`; `/bp` alone lists the breakpoints), `/bpl`, `/bpn`, `/bpc`, `/bpe`.
- The bar above the prompt never wraps. On a narrow line the hint, the call's summary, `DevTools` and `hide` give way in that order; the breakpoint keys and `why?` stay. The hint is now `/bp <rule> · /devtools-help`.
- `/devtools-break` with no rule lists the breakpoints above the usage.
- README: a demo recording.

## 0.1.1

- The "break on" controls show by default as one dim line under every tool row (`inlineControls` now defaults to `always`; `hover` is still available). An installed copy keeps the value it saved, so set it in `/config`.
- The bar above the prompt ends in a dim hint, `/devtools-break <rule> · /devtools-help`, shortened to fit its line. Before the first tool call the bar shows the hint alone.

## 0.1.0

First public release.

- **Breakpoints** on tools, shell commands (words with `*`, or `re:` regexes), file paths (globs, POSIX and Windows), errors, and combined conditions. Actions pause, record or warn; scope, hit thresholds, enable and disable. Rules persist across sessions.
- **Pause dialog** in Claude Code's own question UI: Continue, Step, Reject, a typed note, and an opt-in, labeled Simulate. Claude Code's permission checks still run after Continue.
- **Headless policy**: in `claude -p` and the SDK, a pause breakpoint rejects with an explanation, or only records (`headlessPause`).
- **Dashboard pane**: paused and armed calls, breakpoints with category toggles, a call strip, errors and the timeline, plus Timeline, Inspector, Breakpoints and Errors tabs.
- **Breakpoints where the calls are**: a dim "break on" line under every transcript row, and a keyboard bar above the prompt with a hint to `/devtools-break` and `/devtools-help`.
- **Error Lens**: every failed tool call is classified (ENOENT, EACCES, EPERM, timeouts, permission denials, hook refusals, MCP errors, unknown, and more). Causes are marked confirmed, possible or unknown, each with its evidence. Read-only file checks run after the failure. Repeats are grouped, notifications are throttled, and nothing about the call changes.
- **Sanitized exports**: versioned JSON (schema `claude-devtools.trace` v2) with a validator, and a Markdown report. Secrets are redacted and file contents omitted.
- 145 tests: the pure engine, and the real hooks and UI through `claude-code/testing`.
