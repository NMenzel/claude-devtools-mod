# Architecture

Claude DevTools has two layers: a pure TypeScript engine with no Claude Code
dependency, and a thin native Mod layer that runs the engine's decisions.

```text
agent-devtools/
├── .claude-plugin/plugin.json   manifest, userConfig options, "types" contract
├── hooks/hooks.json             { "modules": ["./register.tsx"] }
├── hooks/register.tsx           native layer: every hook, command and $ call
├── types/index.d.ts             data types + the $.state contract (PluginState)
├── src/core/events.ts           normalization, risk labels, summaries
├── src/core/breakpoints.ts      rule language, validation, bounded matchers
├── src/core/controller.ts       pause/step/arm decisions, dialog, outcome classification
├── src/core/simulation.ts       opt-in synthetic results
├── src/core/recorder.ts         ring buffer, export schema, validator, Markdown
├── src/core/suggest.ts          one-press rules a call suggests; tool categories; hit merging
├── src/core/lens.ts             Error Lens: classification, certainty, probe plans and their reading, grouping
├── src/security/redaction.ts    secret redaction
├── src/config/schema.ts         option validation, persisted settings
├── src/ui/pane.tsx              header, legend, tabs: Timeline, Inspector, Breakpoints
├── src/ui/lens.tsx              the Errors tab (Error Lens)
├── src/ui/dashboard.tsx         the flightdeck-style dashboard (wide / compact / mini)
├── src/ui/inline.tsx            transcript gutter and the bar above the prompt
├── src/ui/model.ts, theme.ts    the view model, actions, theme-key colors
└── tests/                       *.test.ts run by `claude plugin test`
```

## Why the native layer is one file

The installed engine only lets a hooks module pass `$` to functions declared
at the top level of the hooks file itself. A `$.state` reference also needs
a literal `{ plugin, key }` written in that file. `claude plugin validate`
enforces both. So every function that touches the API lives in
`hooks/register.tsx`. Everything that decides lives in `src/` and is unit
tested without the engine.

## A tool call, end to end

```text
tool.call ─► loadSettings ─► normalizeCall ─► claimPlan (planCall + atomic arm claim)
              │ mode off: next(e) at once
              ▼
        record "pending"/"running" event (bounded ring)
              │
   plan = pause? ── yes ─► hold(): pending list, status line
              │              ├─ headless ─► policy: reject (deny) | record-only (continue)
              │              ├─ $.tool.check preview (permission verdict, nothing runs)
              │              ├─ $.ui.ask (engine dialog; the wait is free of the hook budget)
              │              ├─ aborted? ─► deny (outcome aborted)
              │              ├─ dismissed ─► deny (user-cancelled)
              │              ├─ Reject / typed text ─► deny (debugger-rejected)
              │              ├─ Simulate ─► synthetic result (never calls next)
              │              └─ Continue / Step (Step arms the next call)
              ▼
        result = await next(e)   ← the only call into permissions + the real tool
              ▼
        afterRun(): classify (tool error / permission denied / blocked / aborted),
                    patch the event, counters,
                    Error Lens capture (failed, denied, suspected),
                    error breakpoints (may arm next call)
              ▼
        return result unchanged
              ┆ $.clock.after(0): Error Lens read-only checks ($.fs.stat), then the record is updated
```

The hook calls `next(e)` at most once, on one path. A refusal or a simulated
result returns without calling it, so the tool never runs.

### Failure handling

`tool.call` carries a `.catch` handler:

- **`re-entry`**: an event raised beneath this hook's own `$` call. The pause
  dialog is a `tool.call` of `AskUserQuestion` raised by `$.ui.ask`, so it
  passes through. Any other nested call is judged from the snapshot and
  refused if a breakpoint would hold it.
- **`next.called`**: replays the settled result. Nothing runs twice.
- **The hook failed before deciding**: `wouldPause()` re-evaluates the call
  against a module-level snapshot (`mirror`) of the last-read settings and
  arm. A call a breakpoint would hold is refused. Every other call proceeds,
  so a recording failure never blocks ordinary work.

### Error Lens

`captureFailure()` runs for every call that ends `failed` or `denied`, for
DevTools' own refusals (`refuse()`) and simulated failures, and for a
success whose output begins like an error (`looksLikeFailure`, never for
shells). It runs whether or not the call was recorded, and not at all in
mode `off` or with `errorLens: off`. The pure `buildLensRecord()` decides:

1. **Outcome first.** DevTools' own outcomes, interruptions, permission
   denials (a `deny` verdict is confirmed, text alone stays possible) and
   hook refusals.
2. **errno codes** in the text (`ENOENT`, `EACCES`, `EPERM`, `EBUSY`, ...).
3. **Known messages** of Claude Code's tools and common programs (stale read,
   not read yet, edit mismatch, timeout, command not found, ...).
4. **Shell exit codes** (124, 126, 127, 130, 137, 143 have known meanings).
5. **MCP**: the server's own message, cause unknown.
6. Otherwise **unknown**, with the original error as the only evidence.

Every cause carries `confirmed`, `possible` or `unknown`, and the evidence it
rests on. The record is appended to `lens` (at most 80) and folded into
`errorGroups` by a signature: tool, category and the headline with quoted
text, paths and numbers masked (at most 50 groups). The event gets
`errorCategory`. A toast goes out for the first of a group and every fifth.

In `probe` mode the plan (target, parent, paths the error names; at most 5;
never globs, UNC paths, or spellings redaction or truncation changed) runs
from `$.clock.after(0)`, after the hook has returned the result. Each path
gets one `$.fs.stat(path, { resolve: true })`. A rejection with `ENOENT`
means missing. Any other rejection is reported as "could not be checked".
`withProbes()` turns the observations into confirmed facts and possible
readings (for example, a Write whose target changed during the call and has
the intended byte size may have landed).

`tool.check` has one observer hook. It records each real call's verdict
(allow/ask/deny and rule) by `tool_use_id` so the trace can say which
permission decision applied. It changes nothing.

## State

| Where | What | Lifetime |
| - | - | - |
| `$.state` `settings` | mode, recording, breakpoint rules | session; survives hot reload; reset by `/clear`, then reloaded from the store |
| `$.state` `hits` | hit count per breakpoint id | session (kept apart from the rules: see UI) |
| `$.state` `arm` | pause-next / step | session |
| `$.state` `trace` | ring buffer of `TraceEvent`, max `maxTimelineEntries` | session |
| `$.state` `pending`, `view`, `session`, `stats` | paused calls, pane view, session facts, counters | session |
| `$.state` `lens`, `errorGroups` | Error Lens records (≤80) and groups (≤50) | session; reset by `/clear` |
| `$.store` `settings.v1` | mode, recording, rules (no hit counts), schema-versioned | across sessions (4 MiB store limit; the rules are tiny) |
| module variables | parsed options, `mirror` snapshot, `tool.check` verdicts (≤200) | until the module reloads |

All concurrent writes go through `update()` (read, apply, write with
`ifVersion`, retry), so parallel tool calls never lose each other's updates.
Pause-next and step are claimed with a version-checked write: of two calls
racing for one step, exactly one pauses.

`session.start` runs again on every hot reload. It re-registers the commands
(registering replaces), keeps the session's settings, and closes any trace
event still `pending` or `running` as `aborted`. No hook from the old module
holds those calls any more.

## UI

Four render hooks:

| Site | Draws | Reads (and so redraws on) |
| - | - | - |
| `Pane` `devtools` | header, legend, the Dashboard and the four tabs (Timeline, Inspector, Breakpoints, Errors) | every atom |
| `ToolUse` | the engine's row (`next(e)`), a red `●` line when a rule covers the call, the `break on` gutter (hover overlay or its own line) | `settings`, `session` only |
| `ToolGroup` | the folded row, one `break on <tool>` per tool in it (not while expanded: its rows are `ToolUse`) | `settings`, `session` |
| `AbovePrompt` | whatever is beneath (`next(e)`), then the bar for the latest call with `t`/`c`/`f`/`d`/`x`, and `e` (why?) when it failed | `settings`, `view`, `trace`, `session` |

Hit counts live in their own `hits` key, so a tool call that hits a rule
never redraws the transcript's rows, which read only the rules. Planning and
the pane merge them back (`withHits`). A gutter or bar press calls
`toggleRule`: it removes the rule the suggestion stands for (same kind,
same match, tools compared unordered) or adds a pause rule built through
`validateBreakpoint`, the same gate as typed rules. The engine renders
nothing for a hidden tree it cannot hover. The hover overlay is an unkeyed
`display: none` box inside the keyed row box.

The dashboard picks a layout from the pane's props: `placement: 'inline'` gives
`mini`, docked from 110 columns gives `wide` (two columns), anything else gives
`compact`. The call strip draws one `Text` per run of equal statuses, never
one element per cell.

`ui.render` on `{ component: 'Pane', requestId: 'devtools' }` reads every
atom it draws from. Each read subscribes the pane, so any state write
redraws it, and nothing calls `$.ui.invalidate`. Handlers write through the
same top-level functions the commands use, and always read fresh state, never
a value captured at draw time. The view adapts to `bodyColumns` and
`scroll.bodyRows`. Rows are truncated, the timeline is paged, and the engine
scrolls the pane body. On surfaces without `Input`/`Select` (mobile), the
breakpoint editor falls back to a mode button and a pointer to
`/devtools-break`.

## Trace schema

`schema: "claude-devtools.trace"`, `schemaVersion: 2`. The export holds the
generator, session id, redaction and raw-capture flags, mode, counters,
breakpoints, events, and the Error Lens `errors` and `errorGroups`
(version 2 added these two). `validateExport()` checks it. The tests run it on
every export they produce. If an export would exceed 3.5 MB (under the 4 MiB
`$.fs.write` limit), the oldest events are dropped and `droppedEvents` says how
many.
