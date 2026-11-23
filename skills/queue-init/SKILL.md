---
name: queue-init
description: Set this repository up for the task queue, then start the queue coordinator. Creates claude-queue/ with config.json, queue.md and log.md, git-ignores it and the task worktrees, appends a short note to CLAUDE.md, fits the checks and worktree links to this repo, shows a short quickstart, and starts the coordinator. In a repository that is already set up it changes nothing. Use when the user types /queue-init.
argument-hint: "[none | python | node | mixed]"
---

`Q` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs"`, run from the repo root.

1. **The repo.** `Q root` must print the main working tree; if it fails, this is not a git
   repository: say so and stop. `git log -1` must show a commit (worktrees need one); if
   there is none, tell the user to make a first commit, and stop.
2. **Already set up?** If `claude-queue/config.json` exists, run `Q init` anyway: it changes
   nothing and prints `ALREADY INITIALIZED` with a `missing ...` line for any part that is
   gone. Tell the user the repository is already set up and that nothing was changed; list
   the missing parts, if any, for them to restore by hand. Point to `/queue-options` for
   the settings. Then `Q lock status`: if it prints `LOCKED`, a coordinator is already
   running in another session; say so and that work goes to it. Otherwise ask whether to
   start the coordinator now; if they say yes, do step 6 and end with its usual short start
   summary. Stop here either way: steps 3 to 7 are for a new setup.
3. **Pick a preset**, unless the user named one: `python` for a Python repo (a
   `pyproject.toml`, `requirements*.txt` or `setup.py` at the root), `node` for a Node repo
   (a `package.json` at the root), `mixed` when Python and Node code sit in separate
   subfolders, else `none`. Say which and why in one line.
4. **Create.** `Q init --preset <preset>`. It prints a line per file created.
5. **Fit the config to this repo.** The presets are examples. Read the repo's own commands
   (`package.json` scripts, `pyproject.toml`, `Makefile`, the CI workflow, `CLAUDE.md`) and
   edit `claude-queue/config.json` with the Edit tool so that:
   - `checks.changed` runs this repo's linters and tests on changed files, each with `when`
     patterns for the files it covers, `cwd` where the command must run, `{files}` where it
     takes file paths and `{tests}` where it takes test paths. Use `changed_lines_only` for a
     linter that reports old errors the repo carries. Make sure `{tests}` narrows the run: a
     script that already names its own files (`npm test` running `node --test "test/*.js"`)
     would run them all plus the given ones, so call the runner directly there.
   - `checks.full` runs the whole test suite (and a build, if CI runs one).
   - `worktree_links` lists the ignored folders a fresh checkout needs to run those checks
     (dependency folders such as `node_modules` or `.venv`, and ignored config files such as
     `.env`), only those that exist.
   - `base_branch` is the branch new work starts from.
   Keep commands that need a running service or a database out of `checks` unless the repo's
   tests set that up themselves. Then run `Q config show`; it fails if the JSON is broken.
6. **Start the coordinator.** Load the `task-queue:queue-start` skill with the Skill tool
   (if that fails, read `${CLAUDE_PLUGIN_ROOT}/skills/queue-start/SKILL.md`, where the
   CLAUDE_PLUGIN_ROOT placeholder means the plugin folder named above) and follow its Start
   steps: from here on this session is the coordinator. Do not send its start summary as a
   message of its own; step 7 replaces it. If its lock is taken by another coordinator, the
   setup is still done: say so in step 7 instead of the welcome.
7. **Your last message** of this turn is the report and then the welcome, in this order,
   nothing after it:
   - **Report**, short: the preset, the files created, the checks in one line each, and two
     notes: `.gitignore` and `CLAUDE.md` changed in the working tree and are not committed
     (commit them when convenient; do not commit them yourself); repo rules for workers
     (test policy, migrations, areas not to touch) belong in `CLAUDE.md` or in `notes` in
     `config.json`, and `/queue-options` changes the settings. If the coordinator resumed
     or started anything, one line on that.
   - **Welcome**, exactly this text, with <max_workers> replaced by the number in the config:

   > **The task queue is ready.** This session is now the queue coordinator. Describe work
   > in plain words and it becomes a task; up to <max_workers> background workers each do
   > one on its own branch, in its own worktree, while your working tree stays as it is.
   >
   > - **Add work:** just describe it, one message or many. `/qw <task>` starts one right
   >   away, ahead of the line.
   > - **Status:** ask "status". Workers' questions come to you here.
   > - **Merge:** "merge everything done" puts finished work on a `batch/<name>` branch for
   >   you to try. Merging into your main branch and pushing stay yours.
   > - **Before closing this session:** `/queue-close`. Running work is saved and resumes
   >   with the next `/queue-start`.
   > - **More:** `/queue-help`.
   >
   > Run this session in auto mode (Shift+Tab), or with permission rules that let workers
   > edit files and run checks, so they do not stop for prompts.

Change nothing else in the repo.
