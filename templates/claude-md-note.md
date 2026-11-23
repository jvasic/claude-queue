## Task queue (task-queue plugin)

A queue coordinator session may be running in this repository. It keeps
`claude-queue/queue.md` and runs background workers on task branches (`queue/<slug>` by default), each in
its own worktree under `.claude/worktrees/`.

- Only the coordinator writes `claude-queue/queue.md` and `log.md`. To add work while one runs
  (`/queue-start` holds the lock), send it to the session named `Queue Coordinator <nickname>`,
  or use `/qw <task>`, which forwards it.
- Do not touch `claude-queue/.running` or `claude-queue/.runner-session`.
- Do not edit, remove or check out the worktrees under `.claude/worktrees/` or the task
  and `batch/*` branches unless the user asks. Their linked folders point at this tree.
- Workers share this machine's CPU, databases and services. If tests behave oddly, check whether
  workers are running.
