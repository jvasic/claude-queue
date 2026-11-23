---
name: queue-init
description: Set this repository up for the task queue. Creates claude-queue/ with config.json, queue.md and log.md, git-ignores it and the task worktrees, appends a short note to CLAUDE.md, and fits the checks and worktree links to this repo. Use when the user types /queue-init.
argument-hint: "[none | python | node | mixed]"
---

`Q` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs"`, run from the repo root.

1. **The repo.** `Q root` must print the main working tree; if it fails, this is not a git
   repository: say so and stop. `git log -1` must show a commit (worktrees need one); if
   there is none, tell the user to make a first commit, and stop.
2. **Pick a preset**, unless the user named one: `python` for a Python repo (a
   `pyproject.toml`, `requirements*.txt` or `setup.py` at the root), `node` for a Node repo
   (a `package.json` at the root), `mixed` when Python and Node code sit in separate
   subfolders, else `none`. Say which and why in one line.
3. **Create.** `Q init --preset <preset>`. It never overwrites a file that is already there.
4. **Fit the config to this repo.** The presets are examples. Read the repo's own commands
   (`package.json` scripts, `pyproject.toml`, `Makefile`, the CI workflow, `CLAUDE.md`) and
   edit `claude-queue/config.json` so that:
   - `checks.changed` runs this repo's linters and tests on changed files, each with `when`
     patterns for the files it covers, `cwd` where the command must run, `{files}` where it
     takes file paths and `{tests}` where it takes test paths. Use `changed_lines_only` for a
     linter that reports old errors the repo carries.
   - `checks.full` runs the whole test suite (and a build, if CI runs one).
   - `worktree_links` lists the ignored folders a fresh checkout needs to run those checks
     (dependency folders such as `node_modules` or `.venv`, and ignored config files such as
     `.env`), only those that exist.
   - `base_branch` is the branch new work starts from.
   Keep commands that need a running service or a database out of `checks` unless the repo's
   tests set that up themselves. Then run `Q config show`; it fails if the JSON is broken.
5. **Report**, short: the files created or kept, the settings as `Q config show` prints
   them, and three notes:
   - `.gitignore` and `CLAUDE.md` changed in the working tree and are not committed; commit
     them when convenient. Do not commit them yourself.
   - Repo rules for workers (test policy, migrations, areas not to touch) belong in
     `CLAUDE.md` or in `notes` in `config.json`; `/queue-options` changes the settings.
   - Start with `/queue-start`, in auto mode (Shift+Tab) or with permission rules that let
     background workers edit files and run the checks without asking.

Change nothing else in the repo.
