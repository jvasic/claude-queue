---
name: queue-init
description: Set this repository up for the task queue, then start the queue coordinator. Creates .claude/queue/ with config.json, queue.md and log.md, keeps it and the task worktrees out of git through .git/info/exclude (no tracked file is changed), fits the checks and worktree links to this repo, shows a short quickstart, and starts the coordinator. Moves a queue set up by task-queue 0.1 (claude-queue/) to the new place. In a repository that is already set up it changes nothing. Use when the user types /queue-init.
argument-hint: "[none | python | node | mixed]"
---

`Q` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs"`, run from the repo root.

Init never creates or edits a tracked file: no `.gitignore`, no `CLAUDE.md`, no `AGENTS.md`.
Sessions learn about the queue from the plugin's SessionStart hook. Do not add a note to any
of those files yourself either.

1. **The repo.** `Q root` must print the main working tree; if it fails, this is not a git
   repository: say so and stop. `git log -1` must show a commit (worktrees need one); if
   there is none, tell the user to make a first commit, and stop.
2. **Already set up?** If `.claude/queue/config.json` exists, run `Q init` anyway: it changes
   nothing and prints `ALREADY INITIALIZED` with a `missing ...` line for any part that is
   gone and a `left as is: ...` line for leftovers of an older version. Tell the user the
   repository is already set up and that nothing was changed; list those lines for them to
   handle by hand. Point to `/queue-options` for the settings. Then `Q lock status`: if it
   prints `LOCKED`, a coordinator is already running in another session; say so and that work
   goes to it. Otherwise ask whether to start the coordinator now; if they say yes, do step 6
   and end with its usual short start summary. Stop here either way.
3. **An older queue?** If `claude-queue/config.json` exists (task-queue 0.1), run `Q init`: it
   moves `claude-queue/` to `.claude/queue/` with the queue, log, settings and research kept,
   adds the two folders to `.git/info/exclude`, and prints `MIGRATED`. If it fails because a
   coordinator holds the old lock, tell the user to run `/queue-close` in that session first,
   and stop. Its `left as is:` lines name the `/claude-queue/` line in `.gitignore` and the
   queue section in `CLAUDE.md`, which are no longer needed: tell the user they can remove
   them, and do not remove them yourself. Then go to step 5 to add the settings 0.2 brought
   (`check_env`, `import_checks`; the others have defaults), and on to step 6.
4. **A new setup.** Pick a preset, unless the user named one: `python` for a Python repo (a
   `pyproject.toml`, `requirements*.txt` or `setup.py` at the root), `node` for a Node repo
   (a `package.json` at the root), `mixed` when Python and Node code sit in separate
   subfolders, else `none`. Say which and why in one line. Then `Q init --preset <preset>`.
   It prints a line per file created and what it added to `.git/info/exclude`.
5. **Fit the config to this repo.** The presets are examples. Read the repo's own commands
   (`package.json` scripts, `pyproject.toml`, `Makefile`, the CI workflow, `CLAUDE.md`,
   `AGENTS.md`) and edit `.claude/queue/config.json` with the Edit tool (never with a shell
   script or heredoc) so that:
   - `checks.changed` runs this repo's linters and tests on changed files, each with `when`
     patterns for the files it covers, `cwd` where the command must run, `{files}` where it
     takes file paths and `{tests}` where it takes test paths. A check with `{tests}` runs
     only when a worker names tests; it never falls back to the whole suite. Use
     `changed_lines_only` for a linter that reports old errors the repo carries. Make sure
     `{tests}` narrows the run: a script that already names its own files (`npm test`
     running `node --test "test/*.js"`) would run them all plus the given ones, so call the
     runner directly there.
   - `checks.full` runs the whole test suite (and a build, if CI runs one). It runs only
     with `--full`, in the background.
   - `check_env` and `import_checks` make the checks test the worktree's code, not the main
     tree's. A Python package installed in editable mode (`pip install -e`) imports from the
     main tree even inside a worktree: set `"check_env": { "PYTHONPATH": "{worktree}/<the
     folder holding the package>" }` and add an import check that prints where it imports
     from, `{ "name": "<package>", "run": "python -c \"import <package>, os;
     print(os.path.dirname(<package>.__file__))\"" }`. Do the same for any language whose
     tooling resolves the code through an installed or linked copy.
   - `worktree_links` lists the ignored folders a fresh checkout needs to run those checks
     (dependency folders such as `node_modules` or `.venv`, and ignored config files such as
     `.env`), only those that exist. Only what git ignores is linked; the script says so for
     any other entry.
   - `base_branch` is the branch new work starts from.
   Keep commands that need a running service or a database out of `checks` unless the repo's
   tests set that up themselves. Then run `Q config show`; it fails if the JSON is broken.
   If an `import_checks` entry was added, run
   `Q check --worktree .` once and make sure the import check line passes from the main tree.
6. **Start the coordinator.** Load the `task-queue:queue-start` skill with the Skill tool
   (if that fails, read `${CLAUDE_PLUGIN_ROOT}/skills/queue-start/SKILL.md`, where the
   CLAUDE_PLUGIN_ROOT placeholder means the plugin folder named above) and follow its Start
   steps: from here on this session is the coordinator. Do not send its start summary as a
   message of its own; step 7 replaces it. If its lock is taken by another coordinator, the
   setup is still done: say so in step 7 instead of the welcome.
7. **Your last message** of this turn is the report and then the welcome, in this order,
   nothing after it:
   - **Report**, short: the preset (or that the queue was moved), what was created, the
     checks in one line each, and two notes: no tracked file was changed, the queue lives in
     `.claude/queue/` and git ignores it through `.git/info/exclude`; repo rules for workers
     (test policy, migrations, areas not to touch) belong in `CLAUDE.md` or `AGENTS.md`, or in
     `notes` in `config.json`, and `/queue-options` changes the settings. If the coordinator
     resumed or started anything, one line on that.
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
