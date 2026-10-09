# Verified features and known limitations

## Verified

Every line below is covered by `claude plugin test .`. That suite has 143
tests: 80 on the pure engine, and 63 that load the mod into the engine's own
test host and drive its real hooks.

- A Bash call matching a breakpoint pauses. **Reject** keeps the tool from running, and Claude reads why.
- **Continue** runs the call exactly once, through the rest of the chain, and returns its result unchanged.
- Tool, command, file (POSIX and Windows paths), error and conditional breakpoints. Scope, hit thresholds, enable/disable.
- Non-matching calls are untouched. **Warn** and **record** actions never pause.
- Step, pause-next, `/devtools-continue`. Error breakpoints arm the next call.
- Dismissed dialogs and typed answers reject. Interrupted results are recorded as `aborted`.
- Simulation: off unless enabled. A simulated failure and a read-only stub never run the tool and are labeled. Stubs are refused for risky commands.
- Headless: pause breakpoints reject without asking (or record-only), and other calls run.
- Concurrent calls keep separate records and results.
- A failing guard refuses only calls a breakpoint would hold.
- Secrets are absent from exports.
- The ring buffer bound holds.
- Persisted rules reload, and invalid stored rules are dropped.
- Reloads re-register commands safely.
- JSON exports pass the schema validator. The Markdown report is generated.
- The dashboard draws on the terminal and desktop element tables, compact and wide (two columns): header, legend, PAUSED and ARMED, BREAKPOINTS, the CALLS strip and counts, TIMELINE. Inline placement draws the mini summary.
- Tabs, timeline paging, the inspector and its break-on buttons, adding, toggling and deleting rules, category toggles, the mode picker, arming, recording and export all work. A narrow width truncates, and mobile falls back.
- Transcript gutter: Bash rows offer tool and command, Read rows their path relative to the project, folded groups one toggle per tool. A press sets a rule (and the red mark appears), and a second press removes it. `inlineControls` always and off behave as described. Nothing draws while the mode is off.
- The bar above the prompt shows the latest call with `t`/`c`/`f` toggles, opens the pane, hides, and yields to surveys.
- Error Lens: a successful call leaves no record. Each of these is classified with the right certainty: a failed Read, Write or Edit, a permission denial, a hook refusal, an ambiguous failure, a suspected MCP success, and DevTools' own refusal. In every case the result Claude gets is unchanged and the tool ran once. Read-only checks find a missing parent folder and a write that landed despite its error. Repeats are grouped and announced on the first and every fifth. `errorLens` `off` and `classify` and `errorToasts` off behave as described. Recording off still diagnoses. Secrets are redacted in records and exports. The Errors tab, the ERRORS panel, the timeline's ` why?`, the Inspector's `w` and the bar's `e` all reach it.

**Real-session smoke tests** (`claude -p --plugin-dir`, Claude Code 2.1.294, Windows):

- The module loads in a worker with all its hooks (tool.call, tool.check, session.start, classic.SessionStart, command.run, and ui.render on Pane, ToolUse, ToolGroup and AbovePrompt), and the 11 commands register.
- `/devtools-help`, `/devtools-break` and `/devtools-list` answer without a model call. Rules persist across separate sessions.
- The model's real `Bash` call `echo devtools-smoke-marker` hit breakpoint `smoke`, did not run, and Claude received the headless refusal text verbatim.
- `/devtools-errors` registers and answers in a real `-p` session. Error Lens on a real failing tool call is covered by the test kit only. A `-p` run cannot show its toast, and `$.state` does not outlive the process for a second command to read.
- `npx tsc -p .` passes against the engine-laid `.claude-plugin/types`.

**Not verified by hand:** the interactive pause dialog, the dashboard, the
hover gutter and the bar in a live terminal or in Claude Desktop. Those paths
are covered only by the test kit (the real hooks, `$.ui.ask` answered by a
stub, and trees validated against each surface's element table, which caught
one invalid hover tree that has since been fixed). How they look is not
tested. Try it after installing it (see the README).

## Limitations

- **Tool level only.** No reasoning, token or model-internal stepping, because the Mods API does not expose them.
- **The dialog is the control for a held call.** No command can release a call another hook holds, so `/devtools-continue` affects only future calls.
- **Several held calls.** If parallel calls each match a pause rule, each raises its own question. The engine's dialog decides the order. DevTools does not serialize them, because a wait on its own promise would count against the hook's 10-second budget.
- **Permission answers are inferred.** The `tool.check` verdict (allow/ask/deny and rule) is exact. Whether the person rejected the permission *prompt* is inferred from the error text (`doesn't want to proceed`, …).
- **Shell matching is textual.** Command patterns and path words in shell commands do not parse the shell. Quoting, variables and aliases can hide a match.
- **Globs:** `**`, `*` and `?` are supported. Brace expansion (`{a,b}`) and negation are not.
- **Risk labels** are coarse regex heuristics for display and stub eligibility. They are not a security decision.
- **Hit counts** are per session. They are not persisted.
- **Duration** is the tool's own run time, from release to result. Time spent paused is not included.
- **Recording overhead.** With recording on, each call costs about a dozen host round trips (state reads and versioned writes, two clock reads). An open pane and the bar redraw on each call. Transcript rows read only the rules and redraw only when a rule changes, because hit counts live in their own state key. Mode `off` costs one state read per call.
- **Fail-closed needs one read.** The `.catch` handler judges from the last settings the module read. If the guard fails before the module has read its settings even once (its very first call after a load), the handler has no rules to apply and lets the call through.
- **Re-entry.** A tool call raised beneath DevTools' own pause (another mod acting inside the dialog) is judged from a settings snapshot and refused if a breakpoint would hold it.
- **Reload while paused.** A hot reload discards the old module. The paused event is closed as `aborted`, and what happens to the held call is the engine's business.
- **The gutter needs a pointer.** Hover and clicks on transcript rows reach the mod only where the surface reports them (the fullscreen terminal, Claude Desktop). On the main-screen terminal, use the bar above the prompt (ctrl+x tab, then `t`/`c`/`f`), the Inspector or `/devtools-break`. In `hover` mode the controls lay over the row's top-right corner while hovered, and can cover the end of a long first line.
- **The gutter suggests, it does not edit.** It sets a pause rule on the tool, the program and subcommand (`npm test`), or the exact path. For a wider or narrower rule, use the rule language.
- **Surfaces.** The pane draws in the terminal and Claude Desktop. In VS Code's chat panel, `claude -p` and the SDK, the hooks run and nothing draws, so use the commands. Mobile has no input fields.
- **Error Lens sees what a mod sees.** `$.fs.stat` reports no permission bits, owner, ACL, attribute or lock, and no mod can see which process holds or changed a file. Those causes stay `POSSIBLE` or `UNKNOWN`.
- **Error Lens checks happen after the failure.** A file can change between the failure and the check, and each fact says it was observed afterwards. "Modified during the call" allows 2 seconds of clock skew. "The write may have landed" compares the byte size alone, never the contents.
- **Error Lens classification is pattern-based.** It matches errno codes, Claude Code's own tool messages, common program messages and shell exit codes. A message in another language or a new wording falls to `unknown`, with the original error shown. Paths named in free text are found by a heuristic (quoted, absolute, or `./`-relative).
- **Suspected failures** (a success whose output begins with `Error:`, `failed`, …) apply to MCP tools only and are never counted as failures.
- **Notifications** are text. A toast cannot carry a button, so it names `/devtools-errors`, and the bar above the prompt offers `e`.
- **Simulation** never fakes a successful write, migration or deployment. `stub` is limited to read-only shell commands, and `fail` is a refusal.
