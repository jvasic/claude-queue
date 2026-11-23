# The queue files

All queue state lives in `claude-queue/` at the root of the main working tree. `/queue-init`
creates it and git-ignores it, so worktrees never carry a copy and merges never see it.

| File | Purpose |
| --- | --- |
| `config.json` | Settings. `/queue-options` shows and changes them. |
| `queue.md` | The tasks and their state. Written by the coordinator only. |
| `log.md` | One entry per finished task, written by the coordinator. |
| `merged.md` | Branches already applied by `/queue-merge`. |
| `images/` | Images referenced by tasks (optional). |
| `.running` | The coordinator lock. Never edit. |
| `.runner-session` | The coordinator's session id, for the SessionEnd hook. Never edit. |

## queue.md

The coordinator is the only writer while it holds the lock. Workers report back and it
records the result. Edit the file by hand only when no coordinator runs.

- Tasks are separated by a line containing only `---`. The file starts with `---`.
- The first line of a task is its title. Everything below it is the prompt.
- The title carries the task's state as a tag in square brackets. Untagged means waiting.

  | Tag | Meaning |
  | --- | --- |
  | `[notes]` | The coordinator's own state notes, kept as the first block. Never a task: never started, never cleared, not counted. Read first by every new coordinator. |
  | `[running]` | A worker is on it. |
  | `[question]` | Its worker stopped on a question for the user and waits for the answer. |
  | `[paused]` | Set aside by `/queue-close`, its work saved as a `WIP:` commit. Resumed first by the next coordinator. |
  | `[done]` | Committed on its branch. |
  | `[blocked]` | Could not be done as written; the reason is under the title. |
  | `[failed]` | Checks could not be made green; the output is summarised in `log.md`. |
  | `[held]` | Kept for later. Never started until the user says so, never cleared. |
  | `[skip]` | Cancelled. Not run; `/queue-clear` removes it. |

- Lines starting with `>` right under the title are the coordinator's notes, not part of the
  prompt:

  | Line | Meaning |
  | --- | --- |
  | `> branch: queue/<slug>` | The task's branch. |
  | `> agent: <id>` | The background agent holding the task. |
  | `> question: <text>` / `> answer: <text>` | A worker's question and its answer. An answer the coordinator gave itself ends with `(coordinator)`. |
  | `> merging: batch/<name>` | A merge agent is applying this branch now. |
  | `> merged: batch/<name>` | Applied to that branch. |
  | `> worktree:`, `> done:`, `> remains:` | On a `[paused]` task: where its worktree is, what is finished, what is left. |

- `Also: <text>` lines in a prompt are work added later to a running task.
- Images: paste them into the coordinator chat, or drop them in `claude-queue/images/` and
  name them in the task. Workers read every referenced image before starting.

Example:

```
---
[notes] Coordinator notes (read first; never a task)
Batch billing waits for the user to try it locally.
---
[running] Billing page totals
> branch: queue/billing-page-totals
> agent: a41c9e
Show totals per month on the billing page.
---
[question] Export CSV
> branch: queue/export-csv
> question: All columns or only the visible ones? Recommended: visible ones.
Add a CSV export to the reports table.
---
Fix the date picker on mobile
---
```

## log.md

One entry per finished task, newest last:

```
## 2026-11-23 Billing page totals
- Branch: queue/billing-page-totals. Status: done.
- Summary: one to three lines.
- Files: 4 changed: src/billing/Totals.tsx, ...
- Checks: the RESULT and summary lines the check printed.
- Open: anything left for the user, or none.
```

## merged.md

One line per applied branch:

```
- 2026-11-23: queue/billing-page-totals -> batch/billing. Original: 1a2b3c4. New commit: 5d6e7f8
```

## Slugs

A task's slug comes from its title: lowercase, letters and digits, spaces to dashes, at most
40 characters (`Billing page totals` gives `billing-page-totals`). Its branch is
`<branch_prefix><slug>`, its worktree `.claude/worktrees/queue-<slug>`.
