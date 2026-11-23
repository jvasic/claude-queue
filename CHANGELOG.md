# Changelog

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
