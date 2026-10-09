# Changelog

## 0.1.0

First public release.

- **Breakpoints** on tools, shell commands (words with `*`, or `re:` regexes), file paths (globs, POSIX and Windows), errors, and combined conditions. Actions pause, record or warn; scope, hit thresholds, enable and disable. Rules persist across sessions.
- **Pause dialog** in Claude Code's own question UI: Continue, Step, Reject, a typed note, and an opt-in, labeled Simulate. Claude Code's permission checks still run after Continue.
- **Headless policy**: in `claude -p` and the SDK, a pause breakpoint rejects with an explanation, or only records (`headlessPause`).
- **Dashboard pane**: paused and armed calls, breakpoints with category toggles, a call strip, errors and the timeline, plus Timeline, Inspector, Breakpoints and Errors tabs.
- **Breakpoints where the calls are**: a "break on" gutter on transcript rows, and a keyboard bar above the prompt.
- **Error Lens**: every failed tool call is classified (ENOENT, EACCES, EPERM, timeouts, permission denials, hook refusals, MCP errors, unknown, and more). Causes are marked confirmed, possible or unknown, each with its evidence. Read-only file checks run after the failure. Repeats are grouped, notifications are throttled, and nothing about the call changes.
- **Sanitized exports**: versioned JSON (schema `claude-devtools.trace` v2) with a validator, and a Markdown report. Secrets are redacted and file contents omitted.
- 143 tests: the pure engine, and the real hooks and UI through `claude-code/testing`.
