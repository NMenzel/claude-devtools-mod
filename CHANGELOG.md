# Changelog

## 0.2.1

- A call refused by a mod seated before DevTools now shows its command (`✗ 12:35:33 Bash rm -rf /tmp/junk`), read from the conversation when the refusal arrives. Before, the row named the tool alone.
- DevTools' own guard refusals are recorded: in the Permissions tab as DevTools' own, confirmed, and in the timeline and Error Lens when the call was recorded. Before, they appeared nowhere. The guard answers with each call's own plan, so a call another parallel call's count moved is neither refused nor let through by mistake. A refusal at a pause is kept even when the clock fails, and your Reject and its note reach Claude even when clearing the pause fails. Headless with `record-only`, a call let through stays let through.
- Every DevTools command is refused unless you started it (typed, Remote Control, the SDK host, your Slack ping, or a follow-up to your own action in the UI): another session, a channel, a schedule or another mod cannot switch off your breakpoints, open the pane under your typing, or read your rules and refused calls. A refusal points to the prompt and the pane, which always work.
- Times say they are UTC (they always were): once in a list's header, or after a time on its own. One shared helper formats them.
- Hit thresholds hold under parallel calls: each call counts its hit in one atomic write and plans with that count, so a `--after N` rule starts acting exactly on the Nth hit (and on every hit after it). Error rules with `--after N` now count every failure; before, they never reached N.
- Exports (schema version 3) carry the refused calls and the permission rules, read again at export time, in the JSON and in a Markdown "Permissions" section. Exported breakpoints carry their real hit counts; before, always 0.
- A settings file that cannot be read is named with its error redacted; before, the error was kept as is.
- The dashboard has a REFUSED panel: the latest three refused calls and who refused each, one press from the detail.
- Redaction catches Stripe keys (`sk_live_…`, `rk_test_…`, `pk_live_…`), Slack refresh tokens (`xoxe.…`) and Twilio API keys (`SK` + 32 hex).
- A hot reload no longer misreads a recorded call already in flight as refused before DevTools: a call in the timeline counts as seen. With recording off, a call no breakpoint matched is not in the timeline, so this still happens to it. The verdict table drops its oldest entry when full instead of emptying.
- Documented: installed mods all sit in the `user` tier and cannot set their order, so a mod like Blast Radius can sit before DevTools, where its refusals are named as possible only.
- An MCP tool's timeline summary dropped no `password`, `token` or `api_key` argument (it was redacted by shape only); it is now redacted by key, as its stored input is.
- Summaries cut a huge command or error at 64 KB before redaction, and join lines in linear time: a long run of spaces or blank lines no longer stalls a call.
- New call: `$.session.messages`, read only when a mod before DevTools refuses a call, for that call's input.
- 195 tests.

## 0.2.0

- **Permissions tab** (`a`): each refused call, newest first, with who refused it and the exact reason Claude was given. The refuser can be a permission rule (with the settings file that holds it), the permission mode, you at the permission prompt, a `PreToolUse` settings hook, another mod (by name and tier), or Claude DevTools itself. Below the calls: your allow, ask and deny rules from each settings file (managed policy 🔒, `--settings`, local, project, user), the default mode and extra directories. Rules are read at session start, when the tab opens and on Reload (`r`), and never written.
- **Works with other mods.** A mod beneath DevTools that refuses a call (Blast Radius, a guard) is named from Claude Code's call chain, confirmed. A mod seated before DevTools is caught from the stored tool result and named as possible, from its refusal's leading `name:`. A mod whose `tool.check` hook changed the verdict is named too.
- Error Lens names the mod that refused a call instead of "unknown", and a `PreToolUse` hook's deny as such.
- `/devtools-permissions [clear]`, short `/bpp`: the same as text, every rule and every refused call with its evidence; works headless.
- New hook: `session.append`, matched to tool results only. It passes every row on unchanged. New call: `$.settings.read`, read-only.
- 174 tests.

## 0.1.4

- File breakpoints under your home folder fire on macOS and Linux too: `~/`, `$HOME/` and `%USERPROFILE%\` match the real home path (`/home/<user>/`, `/Users/<user>/`, `C:\Users\<user>\`) and the other way round. Before, `file ~/.ssh/**` never matched a Read of `/home/me/.ssh/id_rsa`.
- `/devtools-export ~/t.json` (or `$HOME/...`, `%USERPROFILE%\...`) is refused with a message. Before, it wrote into a folder literally named `~` under the working directory.
- Error Lens treats a path from `/` as POSIX: a backslash there is part of a file name, not a separator, so `/home/me/a\b.txt` no longer gets a wrong parent folder or the Windows line-ending hint.
- 150 tests.

## 0.1.3

- The `tool.check` hook returns the permission check's own result unchanged and reads the verdict from the chain's trace, so the plugin directory can confirm the decision stays with the user. It still records the verdict in the timeline.
- `/devtools-export` refuses hidden files and folders other than `.claude-devtools/` (`.claude/`, `.mcp.json`, ...), instructions files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`), and, outside `.claude-devtools/`, any file that already exists. It can no longer overwrite a build, settings or instructions file.
- No `package.json` or lockfile: installing the plugin runs no package install. Type-check with `npx -p typescript@5 tsc -p .`.
- A plugin icon (`.claude-plugin/icon.png`).
- Directory listing links in `plugin.json`: documentation (the README), support (GitHub issues) and privacy (`docs/SECURITY.md`).
- README: what each hook does, and what the mod reads, writes and stores.
- 148 tests.

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
