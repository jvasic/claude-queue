---
name: queue-merge
description: Review queue branches, apply each on top of the given local branch as one local commit, run the full suite once, then delete the applied branches. Usage /queue-merge <target>, or /queue-merge batch/billing queue/a queue/b to merge only the named branches.
argument-hint: "<target branch> [queue branches...]"
---

`Q` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs"`, run from the repo root (the main
working tree). The file formats are in `${CLAUDE_PLUGIN_ROOT}/docs/queue-format.md`.

The first argument is the target branch. Without one, ask for it. Further arguments are the
queue branches to merge; without them, every branch starting with `branch_prefix` (from
`.claude/queue/config.json`) is merged. A target that does not exist yet is created from
`base_branch`. `.claude/queue/` is git-ignored and lives in the main tree only: read and write
its files there, whichever tree the merge runs in. Follow the repo notes in `config.json` and
the repo's `CLAUDE.md` and `AGENTS.md`.

1. **Where to work.**
   - If the target is the branch checked out in the main tree, work in the main tree, but only
     when the user named that target themselves (a merge agent never works in the main tree;
     it reports this instead). `git status --porcelain` there must be empty. If not, stop and
     tell the user what is uncommitted.
   - If the target is checked out in another worktree (`git worktree list`), stop and say
     which.
   - Otherwise create a merge worktree and work there, so the main tree is never switched. Its
     slug is the target with slashes as dashes, lowercase letters, digits and dashes only
     (`batch/billing` gives `batch-billing`):
     `git worktree add .claude/worktrees/merge-<slug> <target>`, or
     `git worktree add -b <target> .claude/worktrees/merge-<slug> <base_branch>` when the
     target does not exist yet. Then `Q worktree link --kind merge --slug <slug>` links the
     folders the checks need. Never copy or delete through those links; step 7 unlinks them.
2. **Lock.** `Q lock status` must print `UNLOCKED`, unless this session is the queue
   coordinator holding it, or you are a merge agent it started. If another session holds it,
   stop.
3. **List.** The named branches, or else `git branch --list "<branch_prefix>*"`. Drop any
   branch already listed in `.claude/queue/merged.md` and say so. A named branch that does not
   exist is an error: stop. If nothing is left, say so and stop.
4. **Review.** For each branch show `git log --oneline <target>..<branch>` and
   `git diff --stat <target>...<branch>`, and read the matching `log.md` entry. Print a one
   line summary per branch: title, files, checks noted in the log, anything the log left
   open. Flag any two branches that touch the same files.
5. **Apply and commit**, one branch at a time, in the tree chosen in step 1, in the order they
   were named, or else in the order they appear in `queue.md`:
   - `git cherry-pick -n <merge base of target and branch>..<branch>` (the merge base from
     `git merge-base <target> <branch>`). This stages the changes without leaving a merge in
     progress.
   - If it applied without conflict, commit it as one local commit on the target:
     `git commit -m "<task title>" -m "From <branch>: <short hashes>"`, ending the message
     with the attribution lines from your instructions, if any.
   - On a conflict, as a merge agent started by the queue coordinator: resolve it. Read both
     sides and the two tasks' `log.md` entries, keep what each task meant to do, and remove
     the conflict markers. Then `git cherry-pick --quit`, run
     `Q check --worktree <this tree> --base <target head before this branch>` and fix until it
     prints `RESULT PASS`, and commit as above, adding `Resolved: <files and how>` to the
     message. If the two tasks contradict each other so that one has to lose, or the checks
     cannot be made to pass, undo that branch (`git cherry-pick --quit`, then
     `git reset --hard HEAD`; the tree was clean before this branch), report it as not merged
     with the question, and continue with the next branch.
   - On a conflict otherwise (run by hand), stop immediately: leave the tree as is, list the
     conflicting files and which branch caused it, and tell the user where the tree is and how
     to continue (resolve, then `git cherry-pick --quit` and commit, or
     `git checkout -- . && git reset` to discard that branch's changes). Branches committed
     before it stay committed.
6. **Full suite, once per round.** After the last branch, if any branch was committed:
   `Q check --worktree <this tree> --full`. It runs in the background and writes a log under
   `.claude/queue/runs/`; the command waits up to 8 minutes. If it prints `RUNNING <id>`
   (exit code 3), run `Q check --wait <id>` again, as often as needed, until it prints a
   `RESULT` line. Never rerun `--full` to wait. If it fails and the cause is plainly an
   interaction between merged branches, fix it as a merge agent and commit
   `Fix after merging <branches>`; otherwise report the failing lines. Never revert committed
   branches on your own.
7. **Record and clean up.** For each branch committed in step 5: append it to
   `.claude/queue/merged.md` (date, branch, target, its original commit hashes, the new commit
   hash), then delete it with `git branch -D <branch>` (force is required because the
   cherry-picked commits are not the branch's own). Skip deletion for any branch that still
   has a worktree in `git worktree list`; report it instead. Never record or delete a branch
   that was not committed. If a merge worktree was created and no conflict is left in it,
   `cd` to the main repo root (never stand inside the tree you remove), then
   `Q worktree remove --kind merge --slug <slug>`. It unlinks the links without touching their
   targets, refuses to delete while any link is left, and deletes the folder itself when git
   cannot. Never remove a merge worktree with `git worktree remove`, `rm` or `rmdir` directly.
   The target branch stays. If it prints `FAILED`, report that line and leave the tree.
8. **Report.** `git log --oneline <old target head>..<target>`, one line per branch
   (committed and deleted, resolved and committed, conflicted, or not reached), and the full
   suite result. On a conflict, the path of the tree left with it.

Commit only on the target branch, and only in steps 5 and 6. One merge at a time: never run
two merges into any branch at once. Never push, never `git stash`, never check out another
branch in the main tree. Delete only `<branch_prefix>*` branches, and only in step 7. A
refused tool call means stop and report it; never work around it. Resolve conflicts with the
Edit and Write tools, not with shell redirection or heredocs, which permission checks often
refuse.
