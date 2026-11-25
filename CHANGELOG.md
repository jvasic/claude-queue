# Changelog

## 0.2.0 - 2026-11-25

The queue moves and never touches a tracked file.

- Queue state lives in `.claude/queue/` (worktrees stay in `.claude/worktrees/`); both are
  kept out of git through `.git/info/exclude`. `/queue-init` no longer edits `.gitignore` or
  `CLAUDE.md`, and moves a 0.1 `claude-queue/` folder to the new place. The old `.gitignore`
  line and `CLAUDE.md` section are left for you to remove.
- Sessions in a repository with a queue get a short note at start from a SessionStart hook;
  sessions in other repositories get nothing.
- Safety hooks (`safety_hooks`, on by default): queue workers cannot push, stash, stage
  everything, or change git or write files outside their worktree. A task with a `> free:`
  line is exempt; `safety_allow` adds folders. Your own sessions are never held.
- Each task worktree has a commit guard that refuses `.env` files and linked files; only what
  git ignores is linked into a worktree; workers stage files by name.
- Checks: `check_env` and `import_checks` make sure the worktree's code is what gets tested; a
  check with no tests named runs none and says so; the full suite runs only with `--full`, in
  the background with a log, and `check --wait` waits for it; long file lists are split to
  fit the Windows command line, and `{files_file}` passes them as a file; changes are measured
  from the commit each task started from.
- A new task never reuses an existing branch: names differ by title, and `--resume` is only
  for the task that owns the branch. A task that depends on merged work starts from its batch.
- `model_rules` replaces `models.worker` and `models.small_task` (old configs still read).
- The lock is created atomically, refreshed every minute and on each prompt, and the pane
  opens and the session is renamed only after the lock is taken. In other sessions the pane
  runs no timer, and the hooks do not start Node in a repository without a queue.

## 0.1.1 - 2026-11-25

- The queue pane finds `claude-queue/` from the session's project root, not from the shell's
  current folder, so it keeps updating after the coordinator `cd`s into a subfolder. A session
  started in a subfolder of the repository finds it in the nearest parent folder that has one.
- When the queue file cannot be read, the pane marks the list `(stale)` and says why, with the
  path it tried, instead of quietly showing the last list it read.

## 0.1.0 - 2026-11-23

First public release.

- `/queue-start` (or `/queue-coordinator`) makes a session the queue coordinator: it keeps
  `claude-queue/queue.md`, runs up to `max_workers` background workers (4 by default), each on
  its own branch and git worktree, brings their questions to you and merges finished branches
  into batch branches.
- `/qw`, `/queue-merge`, `/queue-clear`, `/queue-close` and `/queue-help`.
- `/queue-init` sets a repository up, shows a short quickstart and starts the coordinator; in a
  repository already set up it changes nothing. `/queue-options` shows and changes the settings.
- `/queue-panel` opens a live pane with workers, questions, next tasks and other sessions.
- Checks, worktree links, worker models, branch prefix and repo rules are configured in
  `claude-queue/config.json`, with examples for Python, Node and mixed repositories.
- One Node script for the lock, worktrees, checks and setup, on Windows, macOS and Linux.
