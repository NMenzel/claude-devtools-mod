# Contributing

Issues and pull requests are welcome.

## Set up

```sh
git clone https://github.com/NMenzel/claude-devtools-mod
cd claude-devtools-mod
npm install                      # local TypeScript only
claude --plugin-dir .
```

Edits to `hooks/` and `src/` hot-reload in that session when Claude's turn ends.

## Before a pull request

```sh
claude plugin validate . --strict
claude plugin test .
npx tsc -p .
```

All three must pass. The type check needs `.claude-plugin/types/`, which
Claude Code writes the first time it loads the mod. To write it without an
interactive session, run `claude -p --plugin-dir . "/devtools-help"` once.

## Ground rules

- **Decide in `src/`, act in `hooks/register.tsx`.** Rules, classification and layout are pure functions with tests. The engine only lets `$` reach top-level functions of the hooks file, so every API call lives there.
- **Never approve, never run twice.** A hook calls `next(e)` at most once. A refusal returns `{ deny }` without calling it. Permission rules always decide after DevTools.
- **Evidence, not guesses.** An Error Lens cause is `confirmed` only when the result, a permission verdict or a file check shows it. Anything else is `possible` or `unknown`.
- **No secrets, no contents.** Everything stored from a tool call goes through the redaction in `src/security/redaction.ts`, and file contents are omitted unless `captureRaw` is on.
- **Narrow panes.** Check a drawing change at 40, 80 and 130 columns, and on the mobile element table.

When you report a bug, include `claude --version` and any `agent-devtools:` line from `claude --debug`.
