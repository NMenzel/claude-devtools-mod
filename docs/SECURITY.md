# Security and privacy

Claude DevTools is local-first. It makes **no network calls and no model
calls**, and it sends no telemetry. It calls none of `$.http`, `$.model` or
`$.process`. Error Lens diagnoses failures with fixed rules, never a model. Run `claude plugin validate .` to confirm the full list of calls
it makes.

## What it can and cannot do to a tool call

- It **never approves** anything. Continue calls `next(e)`. Claude Code's
  permission rules, settings hooks, sandbox and the permission prompt still
  decide afterwards. DevTools has no `tool.check` hook that changes a
  verdict; its only `tool.check` hook observes.
- It **never runs a call after you reject it**. Reject, a dismissed dialog,
  an interrupted turn and a headless pause all return `{ deny }` without
  calling `next`.
- It **never runs a call twice**. The hook calls `next` once. Its `.catch`
  handler replays a settled result instead of running again.
- **It fails closed where it promised to hold.** If its own hook fails before
  deciding, a call a pause breakpoint would hold is refused. Other calls
  proceed.
- It does not alter results. The value `next(e)` returned is handed back
  unchanged. Only an explicit **Simulate** replaces a result, and that is
  opt-in, allowlisted and labeled.
- **It cannot weaken managed policy.** Managed `PreToolUse` hooks run before
  any mod. Organization mods (`prependPlugins`) sit outside it. It does not
  touch settings.

**The mod is not a sandbox.** It is a debugger. Tool-name and path
matching are best effort. Shell commands are matched as text without full
shell parsing, and a path can be spelled in ways a glob does not foresee
(symlinks, `..`, environment variables). Use permission rules, sandboxing and
managed settings for enforcement.

## Error Lens

- It is **passive**. It never retries a call, changes a result, or
  interrupts. A failed call returns after a few in-memory state writes, the
  same cost as recording it, and the file checks run after the result has
  gone back to Claude.
- Its checks are **read-only metadata**: one `$.fs.stat` per path (exists,
  kind, size, modification time, link target). It never reads, opens for
  writing, creates or deletes a file. At most 5 paths per failure: the
  target, its parent folder and paths the error message names. Network
  (`\\server\share`) paths, globs and redacted or truncated spellings are
  never checked. Set `errorLens` to `classify` for no file system access at all.
- What it keeps follows the timeline's rules: the error text and the
  arguments are redacted (with redaction on), file contents are omitted (a
  Write keeps only its byte count), and the error is truncated to 3,000
  characters. Records live in `$.state` for the session (at most 80) and
  appear in exports.

## What it records

By default every event keeps a **summary**:

- tool name, ids, agent, timestamps, duration, status and outcome, risk label, permission verdict, breakpoint and decision
- an input summary, plus the arguments as JSON with:
  - **file contents omitted**: `Write.content`, `Edit.old_string` and `new_string`, `NotebookEdit.new_source` become `<N chars omitted>`
  - strings truncated to `maxSummaryChars × 4`
- a result summary that **never holds output contents**: line and character counts, `numFiles`, an interrupted flag. Error text is kept (redacted and truncated) because it is the point of debugging.

Redaction (on by default) applies to every summary, input, path, error and
export. It covers:

- private keys, `Bearer` and `Basic` credentials, Anthropic/OpenAI-style `sk-` keys, GitHub tokens (`ghp_`, `github_pat_`), GitLab, Slack, AWS access keys, Google API keys, npm tokens and JWTs
- passwords in URLs (`scheme://user:[REDACTED]@host`)
- every inline environment assignment value (`KEY=…`, `export KEY=…`, PowerShell `$env:KEY = …`)
- secret CLI flags (`--password`, `--token`, `--api-key`, …) and secret headers
- object keys named like secrets (`password`, `apiKey`, `client_secret`, `Authorization`, `cookie`, …)

Redaction is pattern-based. It reduces exposure, and it cannot guarantee a
string holds no secret.

### Raw capture (opt-in, off by default)

Setting `captureRaw` also keeps the raw input and result text, truncated to
20,000 characters and still redacted unless `redaction` is off. **This can
capture file contents and command output.** The pane, `/devtools-status`
and the exports all show that raw capture is on.

## Where data lives

| Data | Location | Lifetime |
| - | - | - |
| Timeline, pending calls, counters, Error Lens records | `$.state` (host memory) | the session; lost on exit and on `/clear` |
| Breakpoint rules and mode (no hit counts, no events) | `$.store`, a JSON file of the plugin's own under your Claude Code config directory | until you clear it (`/devtools-break clear`) or turn off `persistBreakpoints` |
| Exports | only where you run `/devtools-export`. The default is `.claude-devtools/` in the working directory, so add it to `.gitignore` | until you delete them |

Export paths are validated: only `.json` or `.md` names, no `..` segments,
no control characters. A relative path resolves under the session's working
directory.

## Patterns as input

Rules come from you, but stored rules are still re-validated when they load.
Matchers are bounded so a rule cannot stall a tool call:

- word patterns match by `indexOf`, not regex, and scan at most 8 KB
- `re:` regexes: at most 200 characters, no backreferences, no quantified groups (`(a+)+`), at most 3 unbounded quantifiers, and at most 2 KB of input scanned
- globs: at most 512 characters and 12 wildcards, paths at most 1 KB

## Reporting a vulnerability

If you find a way Claude DevTools could leak data or weaken a permission
decision, for example a credential format the redaction misses or a call
that runs after a Reject, please report it privately. Use GitHub's
**Security → Report a vulnerability** on
[this repository](https://github.com/NMenzel/claude-devtools-mod/security),
not a public issue.
