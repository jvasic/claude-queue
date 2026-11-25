This repository uses the task queue (task-queue plugin). A coordinator session may be running; ListAgents shows it as "Queue Coordinator <nickname>".
- Only the coordinator writes .claude/queue/ (queue.md, log.md, the lock files). Do not edit them.
- To add work, send it to the coordinator with SendMessage, or use /qw <task>, which forwards it. With no coordinator running, /queue-start makes a session the coordinator.
- Leave .claude/worktrees/ and the queue/* and batch/* branches alone unless the user asks.
