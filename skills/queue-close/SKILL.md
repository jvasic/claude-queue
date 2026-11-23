---
name: queue-close
description: Close the queue coordinator safely. Stops starting workers, has each running worker commit its work as a WIP commit and report what is done and what remains, records unfinished tasks as [paused] in claude-queue/queue.md, updates the notes and log, and releases the lock. Use when the user types /queue-close.
---

Used in the coordinator session, before the user closes it. `Q` means
`node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs"`, run from the repo root.

If this session is not the coordinator, or `Q lock status` prints `UNLOCKED`, say so in one
line and do nothing else. If another session holds the lock, tell the user to run
`/queue-close` there.

1. **Stop starting workers.** From now on, start no worker, answer no worker's question with a
   resume, and start no merge agent. A merge agent already running is left to finish; wait for
   its report and record it as usual.
2. **Running workers.** For each task tagged `[running]`, send its worker a message
   (SendMessage to its `> agent:` id): commit what you have as a work-in-progress commit on
   your branch, with a message starting `WIP:`; keep the worktree; end your report with what
   is done and what remains; then stop. Wait for each to answer. Do not poll: workers report
   back. A worker that cannot be reached is recorded as unreachable.
3. **Record each unfinished task** in `queue.md`. Tag it `[paused]` and add these lines under
   the title, from the worker's answer:
   - `> branch: <branch>`
   - `> worktree: <path>` (only if it still exists; with forward slashes)
   - `> done: <what is finished>`
   - `> remains: <what is left>`

   Drop its `> agent:` line. For an unreachable worker, look at the branch and its worktree
   (`git -C <worktree> log --oneline <base>..`, `git -C <worktree> status --short`) and write
   `> done:` and `> remains:` from that, saying it was unreachable. A `[question]` task keeps
   its question and answer lines and is tagged `[paused]` too, so the next coordinator asks
   again. A task that finished while you waited is handled as usual (`[done]`, log entry).
4. **Notes and log.** Update the `[notes]` block: the state, what is paused, what waits on the
   user (open questions, unmerged `[done]` branches). Append a `log.md` entry: date, "closed",
   and one line per paused task with its branch.
5. **Release the lock:** `Q lock release`.
6. **Tell the user** it is safe to close, in one line: how many tasks are paused and that
   `/queue-start` resumes them.

Edit `queue.md` and `log.md` with the Edit tool only, never from the shell (`sed`, heredocs,
`cat >>`): text with backslashes, such as a Windows path, comes out mangled. Never push, never
`git stash`, never remove a worktree or branch of a paused task.
