# Contributing

Issues and pull requests are welcome.

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/` | The plugin manifest and the marketplace file (this repo is both). |
| `skills/` | One folder per command. The text Claude follows. |
| `docs/` | The queue file formats and the worker's instructions, read at run time. |
| `scripts/queue.mjs`, `scripts/lib/` | The one script: lock, worktrees, checks, setup, config, hooks. Node built-ins only, no dependencies. |
| `hooks/hooks.json` | The SessionStart, UserPromptSubmit, SessionEnd and PreToolUse command hooks, and the pane module. |
| `hooks/register.tsx`, `types/` | The queue pane (a Claude Code mod) and its state types. |
| `templates/` | The notes the SessionStart hook prints, and the example configs `/queue-init` uses. |
| `test/` | Tests for the script. |

## Running from a checkout

```
claude --plugin-dir /path/to/claude-queue
```

loads the plugin for that session only.

## Tests

```
npm test                          # the script, against throwaway git repositories
claude plugin test .              # the pane
claude plugin validate .          # manifest, marketplace, hooks and skills
```

Run all three before a pull request, on your platform. Worktree and link handling differs
between Windows and the rest, so say which platform you tested on.

## Guidelines

- Keep the script free of dependencies; Node 18 or later.
- Skills read like instructions to a careful colleague: short, concrete, no project-specific
  rules. Project rules belong in the user's `CLAUDE.md` or `config.json` notes.
- The safety rules (no push, no main tree changes, no `git stash`, stop on a refused tool
  call) are instructions first. The safety hook enforces some of them, for queue workers
  only and behind `safety_hooks`; never extend it to the user's own sessions.
- Keep hooks cheap: each starts with a shell file test, so a repository without a queue never
  starts Node.
- Never write to a tracked file of the user's repository; the queue lives in `.claude/queue/`,
  kept out of git through `.git/info/exclude`.
- Add a line to `CHANGELOG.md` for anything a user would notice.
