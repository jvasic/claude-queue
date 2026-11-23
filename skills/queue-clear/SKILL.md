---
name: queue-clear
description: Remove finished tasks from claude-queue/queue.md - merged [done] tasks and cancelled [skip] tasks - keeping their history in log.md. [held] tasks always stay. Usage /queue-clear, or /queue-clear all to also remove [done] tasks that are not merged yet.
argument-hint: "[all]"
---

`Q` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs"`, run from the repo root. The file
formats are in `${CLAUDE_PLUGIN_ROOT}/docs/queue-format.md`.

1. **Who may write.** `queue.md` has one writer at a time. If this session is not the queue
   coordinator and `Q lock status` prints `LOCKED`, do not edit: tell the user to ask the
   coordinator to clear the queue, and stop.
2. **Pick.** Read `claude-queue/queue.md`. Remove:
   - `[done]` tasks with a `> merged:` line,
   - `[skip]` tasks (cancelled),
   - with the argument `all`, also `[done]` tasks without a `> merged:` line.

   Keep everything else: untagged, `[held]`, `[running]`, `[question]`, `[paused]`,
   `[blocked]`, `[failed]`, the `[notes]` block, and any task with a `> merging:` line.
   `[held]` tasks and the `[notes]` block are never removed, not even with `all`. Without
   `all`, list the unmerged `[done]` tasks that were kept and why: their branch still waits to
   be merged, and the coordinator finds it through `queue.md`.
3. **Keep the history.** For each task to remove, make sure `claude-queue/log.md` has an entry
   for it (search by title or branch). If not, append one first: date, title, tag, branch,
   `> merged:` target if any, and the prompt's first line.
4. **Remove.** Delete each picked task with its separator line, one targeted edit per task
   with the Edit tool (never `sed` or other shell edits), never rewriting the whole file. The file keeps the form `---`, task, `---`, task, ... and
   keeps its leading `---`. If an edit fails because the file changed, read it again and redo
   it.
5. **Report** one line per removed task (tag and title), then the count left by tag.

Never delete branches, worktrees or `log.md` / `merged.md` entries.
