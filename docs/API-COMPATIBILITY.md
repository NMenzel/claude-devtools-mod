# API compatibility report

Assessed against **Claude Code 2.1.294** on Windows 10. The source was the
declarations this build writes (`claude-code.d.ts`, ~21,000 lines, and the
per-mod `.claude-plugin/types/`), cross-checked with the online docs at
code.claude.com/docs/en/plugins/mods/* (they describe v2.1.290). Where the
two differ, the installed declarations win.

## Verified and used

| Need | API used | Evidence |
| - | - | - |
| Intercept every tool call before permissions | `on('tool.call', hook)`. `next(e)` runs later hooks, then core (permission prompt, then the tool) | d.ts `EngineEventOf['tool.call']`; docs "Guard or change a tool call" |
| Refuse without running | return `{ deny: string }` without calling `next` | d.ts `ToolCallResult`; integration tests assert the tool stub never runs |
| Hold a call while the person decides | `$.ui.ask(question, { options, header })` inside the hook. The wait is a `$` call, so it does not count against the 10 s hook budget | d.ts `ui.ask`, `HookBudget`; docs "Hold a tool call until the user decides" |
| Ask rejects when dismissed or headless | `$.ui.ask` rejects on dismiss, *Chat about this*, and in `-p` | d.ts doc comment; real `claude -p` smoke run |
| Know whether anyone can answer | `session.start` input `isInteractive` | d.ts `SessionStartInput` |
| Fail closed | `on(...).catch(handler)` with `next.called` / `next.error.kind` (`throw`, `timeout`, `re-entry`) | d.ts `Caught`, `HookFailure`; `claude plugin validate` lists `gating hook with .catch: tool.call` |
| Interrupted turn | `next.signal` (`AbortSignal`) | d.ts `Next.signal` |
| Permission verdict | `on('tool.check')` observes `{ decision, rule, reason, hook }` per `tool_use_id`; `onward.trace` shows a mod beneath that changed it. `$.tool.check({ tool, input })` previews without running | d.ts `ToolCheckResult`, `EventCalls.tool.check`, `TraceEntry` |
| Who refused a call | `next.trace` after `next(e)` in `tool.call`: each link's `plugin`, `tier` and `returned`; the innermost `{ deny }` is the refuser (`engine` / `core` is Claude Code) | d.ts `TraceEntry`, `Tier`; tested with inline plugins in the `prepend` and `append` tiers |
| Refusals above DevTools | `on('session.append', { door: 'tool-result' })`: the stored tool_result blocks (`tool_use_id`, `is_error`, `content`), `origin.tool` | d.ts `SessionAppendInput`, `SessionAppendOrigin` |
| Permission rules | `$.settings.read({ source })` for `policy`, `flag`, `local`, `project`, `user`: each file's `permissions` (`allow`, `ask`, `deny`, `defaultMode`, `additionalDirectories`) | d.ts `SettingsReadArgs`, `SettingsSource`, `Settings` |
| Subagent identity | `e.agentId` (absent on the main loop) | d.ts `AgentLoop` |
| Commands | `$.command.register({ name, description, argumentHint, immediate })` in `session.start`; `command.run` matcher with literal names | d.ts `CommandSpec`; validate: `answers its own command` |
| Pane | `$.ui.open({ id, title, focus })` + `ui.render` on `{ component: 'Pane', requestId }`; props `bodyColumns`, `placement`, `scroll.bodyRows` | d.ts `RenderPropsOf.Pane`, `PaneOpenArgs` |
| Elements | `Box` (`borderStyle: 'round'`, `position: 'absolute'`, `hover`), `Text`, `Button` (`hotkey`, `plain`, `dimColor`), `Input` (`onSubmit`), `Select` (`onSelect`), `Code` | d.ts `Elements`, `*Props` |
| Transcript gutter | `ui.render` on `ToolUse` (`tool_use_id`, `tool`, `input`) and `ToolGroup` (`calls`, `isExpanded`): `next(e)` is the engine's row, wrapped | d.ts `RenderPropsOf` |
| Bar above the prompt | `ui.render` on `AbovePrompt` (`hasSurvey`, `bodyColumns`), composed with `next(e)` so other bands still draw | d.ts `RenderPropsOf.AbovePrompt` |
| Open on start | `$.ui.open` unasked from `session.start`: seated from 144 columns, waits below | d.ts `ui.open` doc |
| Session state | `$.state` with `atom` / `read` / `update`; contract in `types/index.d.ts` | validate lists every state read and write against the contract |
| Persistence | `$.store` get/set (JSON, 4 MiB total) | d.ts `store` |
| Export | `$.fs.write(path, text)` (4 MiB per file); `$.fs.exists(path)` before replacing a file; `$.session.cwd()` | d.ts `fs.write`, `fs.exists` |
| Options | manifest `userConfig` (`boolean`, `number` with `min`/`max`, `string` with `options`) → `register(on, options)` | docs manifest reference; validate passes |
| Error Lens checks | `$.fs.stat(path, { resolve: true })`: kind, size, mtimeMs, isLink, realPath; rejects `ENOENT` when missing. No permission bits, owner or lock state | d.ts `FsStat`, `fs.stat` |
| Work after the hook returns | `$.clock.after(0, fn)`: `fn` runs in the plugin's environment once the wait resolves | d.ts `clock.after`, `TimerCall` |
| Toasts | `$.ui.toast(text, { timeoutMs })`: text only, no buttons | d.ts `ToastOptions` |
| Tests | `claude-code/testing`: `test`, `expect`, `mock.clock`, stubs via the test's `on`, `$.ui.mount` per surface | d.ts `declare module 'claude-code/testing'`; 174 tests pass |

## Constraints discovered (all handled)

1. **`$` may only be passed to top-level functions of the hooks file.** Found by `claude plugin validate`. All API-touching helpers live in `hooks/register.tsx`.
2. **State refs must be literal `{ plugin, key }` consts in the hooks file.** They cannot be imported from another file. Moved there.
3. **Element tables are completed across surfaces.** On mobile, `'Input' in table` is true, but the element draws nothing. The pane decides from `e.surface`.
4. **`$.ui.ask` is a nested `AskUserQuestion` tool call.** The `tool.call` `.catch` handler is asked for it with `re-entry`. It must pass that call on, or every pause would deny its own dialog.
5. **`$.fs.write` receives native absolute paths.** `/work/x` becomes `C:\work\x` on Windows.
6. **`$.state` is reset by `/clear`, and no `session.start` follows.** Settings lazy-load from the store on first use. `classic.SessionStart` refreshes the session id.
7. **`$.state.set` refuses `undefined`.** View updates drop undefined keys.
8. **Git Bash** rewrites `/command` arguments to paths. Use `MSYS_NO_PATHCONV=1` (docs only).
9. **A hover reveal must sit inside a visible keyed Box.** A keyed Box drawn `display: "none"` is its own hover scope, and the pointer can never be over it. The engine refuses that tree and draws its own row. The gutter's hidden box is unkeyed inside the keyed row.
10. **Transcript buttons are pointer-only.** The band and panes take the keyboard (ctrl+x tab), and transcript rows do not. So the gutter has a keyboard twin: the bar above the prompt.

## Not available, and the narrower fallback used

| Asked for | Status | Fallback |
| - | - | - |
| Hidden reasoning, model-internal or token-level stepping | Not exposed | Tool-level stepping only (Step = run this call, pause on the next) |
| A command that releases a held call | The question dialog holds the keyboard while a call is held. No API resolves another hook's pending `ask` | The dialog is the control. `/devtools-continue` disarms pause-next and step for later calls |
| Pausing a call after it completed | Impossible by design | Error breakpoints arm a pause on the **next** call |
| The person's answer to the permission prompt itself | Not reported separately | The `tool.check` verdict (allow/ask/deny + rule) is recorded. A rejected prompt is inferred from the error text (documented heuristic) |
| The session's live permission mode (after Shift+Tab) | No API reads it | The Permissions tab shows the settings' `defaultMode`; a refusal by the mode is named from the verdict's reason |
| Which mod refused a call when it sits before DevTools in the chain | Its refusal never reaches DevTools' `tool.call` hook, and a stored tool result names no plugin | Caught from the stored tool result; the mod is marked possible, read from the refusal's leading `name:` |
| Synthetic *successful* results for writes or other side effects | Disallowed by policy | `fail` for allowlisted tools; `stub` only for read-only shell commands |
| Drawing in the VS Code chat panel or `claude -p` | Hooks run, nothing draws | Text commands |
| A notification with an "Inspect" button | `$.ui.toast` takes text only | The toast names `/devtools-errors`; the bar above the prompt gets `e` (why?) for a failed latest call |
| File permission bits, owners, locks, which process holds or changed a file | `$.fs.stat` reports none of them | Error Lens states them as `UNKNOWN`, never as a cause |
| Glob/Grep on native macOS/Linux builds | Those builds do not register them | Tool names are compared as strings; the generic path still records any tool |

## Anthropic mods reviewed

- **`diff`** (built in): a pane with keybound buttons and its own scrolling. It informed the pane layout. DevTools does not show diffs.
- **`blast-radius`** (playground): holds risky Bash commands and shows their impact. It holds the call by polling `$.process.run(['sleep', '0.25'])` until a button sets a decision. DevTools holds with `$.ui.ask` instead, as the docs recommend, with no polling and no budget risk. It also generalizes holding to configurable breakpoints on any tool.
- **`replay-theater`** (playground): replays the last turn's edits. DevTools records a sanitized timeline of every tool call and exports it, and does not replay edits.
