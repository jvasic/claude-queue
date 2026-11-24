# task-queue

https://github.com/user-attachments/assets/74719dc8-bba2-48fd-b7fe-ead69ee3eb26

*27 s. Music: J. S. Bach,
Fugue No. 5 in D major (BWV 850), played by Kimiko Ishizaka, CC0. Made with
[fframes](https://github.com/dmtrKovalenko/fframes), following the method in
[promo-vid-but-sweet](https://github.com/mrsladoje/promo-vid-but-sweet). Task names beyond the
README's own examples are illustrative.*

A simple Claude Code plugin that turns one session into a **queue coordinator**. 

You can prompt the coordinator continuously, and it starts background Claude workers and manages them for you. The coordinator
itself stays free, so you don't need to wait before queuing the next task on your mind. 

With this plugin, you also don't need to juggle multiple sessions anymore, as the coordinator simply gets everything back to you. 

You just describe the tasks; the coordinator writes them to a queue, runs up to four (customizable) background Claude workers at once, 
each on its own branch in its own git worktree, brings their questions to you, and
merges finished branches into batch branches. Your main working tree is never
modified, and nothing is pushed unless you say so.

Works on Windows, macOS and Linux. Needs git 2.31 or later, and Node 18 or later on `PATH`: the plugin's
script and hooks run with `node`.

## Quickstart (60 seconds)

1. Install the plugin. At the prompt of a Claude Code session:

   ```
   /plugin marketplace add jvasic/claude-queue
   /plugin install task-queue@claude-queue
   ```

   Or from a shell: `claude plugin install task-queue --marketplace jvasic/claude-queue`.

2. Switch to auto mode (Shift+Tab), so background workers can edit files and run checks
   without stopping for permission prompts. Then, in your repository, set it up once:

   ```
   /queue-init
   ```

   It creates `claude-queue/` (settings and the queue, git-ignored), adds two lines to
   `.gitignore`, appends a short note to `CLAUDE.md`, fits the checks to your repo, shows a
   short quickstart and starts the coordinator in this session.

3. Next time, start the coordinator with:

   ```
   /queue-start
   ```

4. Describe a task: "Add a CSV export to the reports table." The coordinator queues it,
   starts a worker, and tells you when it is done or has a question.

Each command also has a full name with the plugin prefix, such as `/task-queue:queue-start`.
The short names work as long as no other command uses them.

## Commands

| Command | What it does |
| --- | --- |
| `/queue-init` | Sets the repository up: `claude-queue/` with `config.json`, `queue.md`, `log.md`; `.gitignore` lines; a note in `CLAUDE.md`; checks fitted to the repo. Then starts the coordinator. In a repository that is already set up it changes nothing. |
| `/queue-start` | Makes the session the coordinator. `/queue-coordinator` is the same. |
| `/qw <task>` | Starts a worker on the task now, ahead of the waiting ones. `/qw N <task>` splits the work between N workers. `/qw <session>: <task>` sends it to another open session and relays the answer. |
| `/queue-merge <target> [branches]` | Applies finished branches onto the target, one commit each, runs the full suite once, deletes the applied branches. The coordinator normally does this for you through a merge agent. |
| `/queue-clear [all]` | Removes merged and cancelled tasks from the queue, keeping their history in `log.md`. |
| `/queue-close` | Closes the coordinator safely: workers commit their work as `WIP:` commits, tasks are marked `[paused]`, the next `/queue-start` resumes them. |
| `/queue-options [setting value]` | Shows the settings with a line on each, and changes them. |
| `/queue-panel` | Opens the live queue pane. |
| `/queue-help` | Prints a short help. |

Talking to the coordinator works too: "status", "keep the export task for later", "cancel
it", "merge everything done", "use 6 workers", "use the ops session for server work".

## How it works

```
you ──> coordinator session ──> claude-queue/queue.md
             │
             ├── worker 1: branch queue/csv-export   in .claude/worktrees/queue-csv-export
             ├── worker 2: branch queue/date-picker  in .claude/worktrees/queue-date-picker
             └── merge agent: queue/* ──> batch/<name>   (one at a time)
```

- **The coordinator** keeps `claude-queue/queue.md`, one block per task with its state as a tag
  (`[running]`, `[question]`, `[done]`, `[held]`, `[paused]`, ...). It holds a lock
  (`claude-queue/.running`) so only one coordinator runs per repository; a lock older than
  `lock_stale_hours` is ignored, and the lock is released when the coordinator's session ends.
  It does not write code itself, which keeps its own context small.
- **Workers** are background subagents. Each creates its worktree with the plugin's script
  (linking `worktree_links` such as `.venv` or `node_modules` from the main tree), implements,
  reviews its own diff, runs the configured checks on its changed files until they pass,
  commits, removes the worktree and keeps the branch. When a decision is yours, it commits what
  it has and stops with a question; the coordinator answers small implementation questions
  itself and brings product, design and scope questions to you.
- **Merging.** When you ask, or when a task depends on finished work, a merge agent applies
  finished branches onto a `batch/<name>` branch in its own worktree, one commit per task,
  resolves conflicts, and runs the full suite once per round. Merging a batch into your main
  branch and pushing are yours.
- **Closing.** `/queue-close` has every running worker save a `WIP:` commit and report what is
  done and what remains. The next `/queue-start` resumes those tasks first.
- **Helpers.** Your other open sessions can take work the workers should not have access for,
  such as server work. Tell the coordinator which session is for what.
- **The pane** (`/queue-panel`, opened by `/queue-start`) shows the counts per tag, each worker
  with its running time and last tool call, open questions, the next tasks, and your other
  sessions. It names the coordinator session `Queue Coordinator <nickname>` so other sessions
  can find it. It draws in the terminal, the desktop app and the VS Code panel.

The file formats are in [docs/queue-format.md](docs/queue-format.md), the worker's
instructions in [docs/worker.md](docs/worker.md).

## Configuration

`claude-queue/config.json`, created by `/queue-init`. `/queue-options` shows and changes it.

| Key | Default | Meaning |
| --- | --- | --- |
| `max_workers` | `4` | Workers running at once (1 to 20). |
| `models.worker` | `"opus"` | Model for a normal worker. |
| `models.small_task` | `"sonnet"` | Model for small, clearly scoped tasks. |
| `models.merge` | `"opus"` | Model for the merge agent. |
| `branch_prefix` | `"queue/"` | Prefix of every task branch. |
| `base_branch` | the branch checked out at init | Branch new task branches start from. |
| `checks.changed` | `[]` | Checks a worker runs on its changed files (below). |
| `checks.full` | `[]` | Commands run once per merge round: the full suite. |
| `worktree_links` | `[]` | Folders linked (junctions on Windows, symlinks elsewhere) and files copied from the main tree into each worktree. |
| `venv` | `".venv"` | Python virtualenv whose `bin` (`Scripts` on Windows) is put first on `PATH` for checks; `""` for none. |
| `lock_stale_hours` | `4` | A coordinator lock older than this is ignored. |
| `one_at_a_time` | `[]` | Kinds of task that never run two at once, e.g. `"tasks that add a database migration"`. |
| `notes` | `[]` | Repo rules passed to every worker and merge agent. |
| `helpers` | `[]` | `[{ "name": "<session name>", "for": "<what to send it>" }]`. |

### Checks

```json
"checks": {
  "changed": [
    { "name": "ruff",   "when": ["backend/**/*.py"], "cwd": "backend", "run": "ruff check {files}", "changed_lines_only": true },
    { "name": "pytest", "when": ["backend/**/*.py"], "cwd": "backend", "run": "python -m pytest -q {tests}" },
    { "name": "eslint", "when": ["frontend/**/*.{ts,tsx}"], "cwd": "frontend", "run": "npx eslint {files}" }
  ],
  "full": [
    { "name": "pytest", "cwd": "backend", "run": "python -m pytest -q" }
  ]
}
```

- A check runs when one of the worker's changed files (committed, uncommitted or new, against
  the branch the main tree has checked out) matches a `when` pattern. A pattern without `/`
  matches the file name in any folder.
- `{files}` becomes the matching changed files, relative to `cwd`. `{tests}` becomes the test
  paths the worker passes with `--tests`, else `default_tests`, else nothing. A test path that
  does not exist fails the check.
- `changed_lines_only: true` fails only on `path:line:` output lines that sit on changed lines,
  for linters in a codebase that carries old errors.
- `timeout_minutes` (default 30) limits one command.

Examples for a Python, a Node and a mixed repository are in
[templates/examples/](templates/examples/); `/queue-init` starts from the one that fits.

### Repo rules

The plugin has no rules about your project. Put them where every session reads them: in
`CLAUDE.md` (test policy, migrations, areas not to touch, release steps), or as short strings in
`notes`. Use `one_at_a_time` for work that must not run in parallel.

## Safety rules

These are instructions every coordinator, worker and merge agent follows. They are not
enforced by hooks.

- **Never push** unless you ask.
- **Never touch the main working tree** unless you ask. Work happens in worktrees under
  `.claude/worktrees/`; merges go to batch branches in their own worktrees.
- **Never `git stash`.**
- **A refused tool call means stop and report.** Nothing works around a permission you denied.

The scripts add a few guarantees of their own:

- Removing a worktree first unlinks the linked folders, then refuses to delete anything while
  any link is left inside it, so a delete can never reach through a link into your main tree.
- A slug is lowercase letters, digits and dashes only, so it can never name a path outside
  `.claude/worktrees/`.
- `/queue-init` changes nothing in a repository that is already set up.

## The script

Everything the skills run goes through one Node script, which you can also run by hand from
anywhere in the repository (a worktree included):

```
node <plugin folder>/scripts/queue.mjs lock status            # LOCKED or UNLOCKED
node <plugin folder>/scripts/queue.mjs lock release           # clear a stuck lock
node <plugin folder>/scripts/queue.mjs check --worktree .claude/worktrees/queue-<slug>
node <plugin folder>/scripts/queue.mjs check --worktree . --full
node <plugin folder>/scripts/queue.mjs config show
```

`claude plugin list` shows where the plugin is installed.

## Limits

- The coordinator works while its session is open. Close it with `/queue-close`; a new
  `/queue-start` picks up from `queue.md`.
- Workers share your machine: CPU, databases, ports and services. Keep `max_workers` at what
  your machine and your test setup can run side by side.
- The pane needs a Claude Code build with mods (2.1.287 or later); everything else works
  without it.

## License

MIT. See [LICENSE](LICENSE).
