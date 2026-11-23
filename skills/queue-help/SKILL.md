---
name: queue-help
description: Print a short help for using the task queue. No tools, no changes. Use when the user types /queue-help or asks how the queue works.
---

Print the text below as it is, then stop. Use no tools and change nothing.

```
THE QUEUE
A coordinator session keeps a list of tasks (claude-queue/queue.md) and runs background
workers on them, each on its own branch and worktree. You describe work; it gets done and
waits for you.

SET UP     /queue-init once per repo; it also starts the coordinator. /queue-options shows
           and changes the settings.
START      /queue-start (or /queue-coordinator). Auto mode (Shift+Tab) lets workers run
           without stopping for permission prompts.
ADD WORK   Just describe it. Or /qw <task> (start now), /qw N <task> (split between N
           workers), /qw <session>: <task> (send to another open session).
ANSWER     The coordinator brings workers' questions to you; reply in the chat.
STATUS     Ask "status". /queue-panel opens the live pane.
HOLD       "Keep it for later" holds a task. "Cancel it" skips it.
MERGE      Say "merge everything done" (goes into a batch branch), or /queue-merge <branch>.
CLEAR      /queue-clear (merged and cancelled tasks). /queue-clear all also takes unmerged.
CLOSE      /queue-close before you close the session: workers save their work, tasks are
           marked [paused], and the next /queue-start resumes them.

The full command names carry the plugin's prefix (/task-queue:queue-start); the short
names work when no other command uses them.

RULES      Nothing is pushed unless you say so.
           Workers use their own branches and worktrees, never your main working tree.
           A refused permission stops the work and comes to you; nothing works around it.
           Close the session with /queue-close, not by just closing it.
```
