---
name: queue-options
description: Show and change the task queue settings in .claude/queue/config.json, one line of explanation each - max workers, model rules, branch prefix, base branch, checks, check environment, import checks, worktree links, lock timeout, safety hooks, helpers. Use when the user types /queue-options or asks to change a queue setting.
argument-hint: "[setting value]"
---

`Q` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.mjs"`, run from the repo root. If
`.claude/queue/config.json` does not exist, tell the user to run `/queue-init` first, and stop.

**No arguments:** run `Q config show` and print its output as it is: each setting, its value
and one line on what it does. Then say in one line that `/queue-options <setting> <value>`
changes one, or that they can describe the change in words.

**A change** (`/queue-options max_workers 6`, "use sonnet for workers", "add a lint check"):

- For a single value (`max_workers`, `models.merge`, `branch_prefix`, `base_branch`, `venv`,
  `lock_stale_hours`, `safety_hooks`): `Q config set <key> <value>`. It refuses a value of
  the wrong kind and says what it expects.
- For a list or an object (`model_rules`, `checks.changed`, `checks.full`, `check_env`,
  `import_checks`, `worktree_links`, `one_at_a_time`, `notes`, `helpers`, `safety_allow`):
  edit `.claude/queue/config.json` with the Edit tool, keeping the other entries, then run
  `Q config show`, which fails if the JSON is broken. A model rule is
  `{ "when": "<kind of task>", "model": "<model>" }`, the last one `"when": "default"`. A
  check entry is `{ "name", "when": [patterns], "run", "cwd"?, "default_tests"?,
  "changed_lines_only"?, "timeout_minutes"? }`; a full-suite or import-check entry is
  `{ "name", "run", "cwd"? }`; a helper is `{ "name": "<session name>", "for": "<what to send
  it>" }`. In `run`, `{files}` becomes the matching changed files, `{files_file}` a file
  listing them, and `{tests}` the test paths a worker passes. In `check_env` values,
  `{worktree}` and `{root}` become the worktree and the main tree.
- Show the changed lines of `Q config show` afterwards.

Changing `branch_prefix` or `base_branch` affects only tasks started afterwards. If this
session is not the coordinator and `Q lock status` prints `LOCKED`, say that the running
coordinator reads the new values when told to (it rereads `config.json` on a settings
change).

Change nothing outside `.claude/queue/config.json`.
