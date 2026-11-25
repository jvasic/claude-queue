// Task and merge worktrees under .claude/worktrees/.
//   task:  .claude/worktrees/queue-<slug>, on branch <branch_prefix><slug>
//   merge: .claude/worktrees/merge-<slug>, made by the queue-merge skill with git worktree add
//
// create refuses a branch that already exists unless --resume says the task owns it (its
// "> branch:" line in queue.md names it), records the commit the task starts from in
// .claude/queue/tasks/<slug>.json (check diffs against it), links each worktree_links entry
// that git ignores (a folder as a junction on Windows or a symlink elsewhere, a file as a
// copy), and installs the commit guard. remove unlinks those links first, refuses to delete
// anything while any link is left inside the worktree, and so never deletes through a link
// into the main tree. The branch is always kept.
import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from './config.mjs'
import { readQueue } from './queuefile.mjs'
import { QueueError, WORKTREE_DIR, exists, git, isIgnored, queueDir, toPosix } from './repo.mjs'

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/

export function checkSlug(slug) {
  // The slug names a folder that remove deletes: lowercase letters, digits and dashes only, so
  // it can never be empty, "..", a path or absolute.
  if (typeof slug !== 'string' || !SLUG.test(slug)) throw new QueueError(`bad slug: '${slug}'`)
}

export function worktreePath(root, slug, kind = 'task') {
  checkSlug(slug)
  if (kind !== 'task' && kind !== 'merge') throw new QueueError(`bad kind: ${kind} (task or merge)`)
  return path.join(root, WORKTREE_DIR, `${kind === 'merge' ? 'merge-' : 'queue-'}${slug}`)
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

// Every link under root, never following one.
export function findLinks(root) {
  if (!exists(root)) return []
  if (isLink(root)) return [root]
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isSymbolicLink() || isLink(full)) found.push(full)
      else if (e.isDirectory()) stack.push(full)
    }
  }
  return found
}

function safeRel(rel) {
  const norm = path.normalize(rel)
  if (path.isAbsolute(norm) || norm.split(path.sep).includes('..') || norm === '.') {
    throw new QueueError(`worktree_links entry must be a path inside the repo: '${rel}'`)
  }
  return norm
}

// Links the configured entries into an existing worktree. Only what git ignores is linked or
// copied: a tracked or unignored file (a .env someone forgot to ignore) could otherwise be
// committed from the worktree. Returns the lines to print and the paths linked.
export function linkInto(root, wt, links) {
  const out = []
  const linked = []
  for (const raw of links) {
    const rel = safeRel(raw)
    const src = path.join(root, rel)
    const dst = path.join(wt, rel)
    if (!exists(src)) continue
    if (!isIgnored(root, rel)) {
      out.push(`not linked: ${raw} (git does not ignore it, so a worker could commit it; ignore it first)`)
      continue
    }
    linked.push(toPosix(rel))
    if (exists(dst)) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    if (fs.statSync(src).isDirectory()) {
      fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir')
      out.push(`linked ${raw}`)
    } else {
      fs.copyFileSync(src, dst)
      out.push(`copied ${raw}`)
    }
  }
  return { lines: out, linked }
}

// ---- The commit guard ----------------------------------------------------------------------
// Each task worktree gets its own core.hooksPath (a per-worktree setting, which needs
// extensions.worktreeConfig) pointing at .claude/queue/git-hooks/. Its pre-commit refuses
// .env files and anything linked from the main tree; every hook then runs the repository's
// own hook of the same name, so a repo's hooks (husky and the like) still run.

const HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'post-rewrite', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc',
]

const CHAIN = `orig=$(git config --get queue.originalhooks)
[ -n "$orig" ] || orig="$(git rev-parse --git-common-dir)/hooks"
hook="$orig/$(basename "$0")"
if [ -f "$hook" ] && [ -x "$hook" ]; then exec "$hook" "$@"; fi
exit 0
`

const GUARD = `links=$(git config --get-all queue.link)
bad=$(git diff --cached --name-only --diff-filter=ACMRT -z | tr '\\0' '\\n' | while IFS= read -r f; do
  name=\${f##*/}
  case "$name" in
    .env.example|.env.sample|.env.template|.env.dist) ;;
    .env|.env.*) printf '%s\\n' "$f"; continue ;;
  esac
  printf '%s\\n' "$links" | while IFS= read -r l; do
    [ -n "$l" ] || continue
    case "$f" in "$l"|"$l"/*) printf '%s\\n' "$f" ;; esac
  done
done)
if [ -n "$bad" ]; then
  echo "task-queue: refused to commit .env files or files linked from the main tree:" >&2
  printf '%s\\n' "$bad" | sed 's/^/  /' >&2
  echo "Unstage them (git restore --staged <path>) and stage only the files you changed." >&2
  exit 1
fi
`

function hookScript(name) {
  const head = '#!/bin/sh\n# Written by the task-queue plugin for its task worktrees. Do not edit.\n'
  return head + (name === 'pre-commit' ? GUARD : '') + CHAIN
}

export function hooksDir(root) {
  return path.join(queueDir(root), 'git-hooks')
}

function writeHooks(root) {
  const dir = hooksDir(root)
  fs.mkdirSync(dir, { recursive: true })
  for (const name of HOOK_NAMES) {
    const p = path.join(dir, name)
    const text = hookScript(name)
    if (!exists(p) || fs.readFileSync(p, 'utf8') !== text) fs.writeFileSync(p, text)
    try {
      fs.chmodSync(p, 0o755)
    } catch {}
  }
}

// Returns a line saying what was set up, or why not.
export function installGuard(root, wt, linked) {
  if (git(['config', '--get', 'core.worktree'], root).out !== '') {
    return 'no commit guard: core.worktree is set in this repository'
  }
  // The repository's own hooks folder, read before this worktree gets its own setting.
  const original = git(['config', '--get', 'core.hooksPath'], root).out
  if (git(['config', '--get', 'extensions.worktreeConfig'], root).out !== 'true') {
    const r = git(['config', 'extensions.worktreeConfig', 'true'], root)
    if (r.code !== 0) return `no commit guard: could not turn on extensions.worktreeConfig: ${r.err}`
  }
  writeHooks(root)
  const set = (...args) => git(['config', '--worktree', ...args], wt)
  set('core.hooksPath', toPosix(hooksDir(root)))
  if (original !== '') set('queue.originalhooks', original)
  set('--unset-all', 'queue.link')
  for (const l of linked) set('--add', 'queue.link', l)
  return 'commit guard on: .env files and linked paths cannot be committed'
}

// ---- Task base records ---------------------------------------------------------------------

export function recordPath(root, slug) {
  return path.join(queueDir(root), 'tasks', `${slug}.json`)
}

export function readRecord(root, slug) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(root, slug), 'utf8'))
  } catch {
    return null
  }
}

function writeRecord(root, slug, record) {
  fs.mkdirSync(path.dirname(recordPath(root, slug)), { recursive: true })
  fs.writeFileSync(recordPath(root, slug), JSON.stringify(record, null, 2) + '\n')
}

// The slug of a task worktree from its path, or null for any other folder.
export function slugOf(root, wt) {
  const rel = path.relative(path.join(root, WORKTREE_DIR), path.resolve(wt))
  const m = /^queue-([a-z0-9][a-z0-9-]*)$/.exec(rel)
  return m ? m[1] : null
}

// ---- Commands ------------------------------------------------------------------------------

export function create(root, slug, { base, resume = false } = {}) {
  const cfg = loadConfig(root)
  const wt = worktreePath(root, slug, 'task')
  const branch = `${cfg.branch_prefix}${slug}`
  const has = git(['branch', '--list', branch], root).out !== ''
  if (has && !resume) {
    return {
      lines: [`FAILED branch ${branch} already exists. A new task needs a title that differs from earlier ones; pass --resume only to continue this task's own branch.`],
      code: 1,
    }
  }
  if (has && !readQueue(root).some(t => (t.notes.branch ?? []).includes(branch))) {
    return { lines: [`FAILED --resume: no task in queue.md has "> branch: ${branch}", so the branch is not this task's`], code: 1 }
  }
  const lines = []
  if (exists(wt)) lines.push(`EXISTS ${wt}`)
  else {
    const r = has
      ? git(['worktree', 'add', wt, branch], root)
      : git(['worktree', 'add', '-b', branch, wt, base || cfg.base_branch], root)
    if (r.code !== 0) return { lines: [`FAILED git worktree add: ${r.err || r.out}`], code: 1 }
  }

  let record = readRecord(root, slug)
  if (!has || record?.branch !== branch) {
    const from = has ? git(['merge-base', base || cfg.base_branch, branch], root) : git(['rev-parse', 'HEAD'], wt)
    record = { branch, base: from.out, base_ref: base || cfg.base_branch, created: new Date().toISOString() }
    writeRecord(root, slug, record)
  }
  const linked = linkInto(root, wt, cfg.worktree_links)
  lines.push(...linked.lines)
  lines.push(installGuard(root, wt, linked.linked))
  lines.push(`BASE ${record.base} (${record.base_ref})`)
  lines.push(`${has ? 'RESUMED' : 'CREATED'} ${wt} on ${branch}`)
  return { lines, code: 0 }
}

export function link(root, slug, kind) {
  const cfg = loadConfig(root)
  const wt = worktreePath(root, slug, kind)
  if (!exists(wt)) return { lines: [`FAILED no worktree at ${wt}`], code: 1 }
  const { lines } = linkInto(root, wt, cfg.worktree_links)
  lines.push(`LINKED ${wt}`)
  return { lines, code: 0 }
}

function makeWritable(dir) {
  // OneDrive and some tools mark files read-only; Windows then refuses to delete them. Safe
  // here: the caller found no link to follow.
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()
    try {
      fs.chmodSync(d, 0o777)
    } catch {}
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {}
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(full)
      else {
        try {
          fs.chmodSync(full, 0o666)
        } catch {}
      }
    }
  }
}

export function remove(root, slug, kind = 'task', { testFallback = false, discard = false } = {}) {
  const lines = []
  const cfg = loadConfig(root)
  const wt = worktreePath(root, slug, kind)
  const wtRoot = path.join(root, WORKTREE_DIR)
  // Never stand in the folder being deleted.
  process.chdir(root)
  if (!exists(wt)) {
    git(['worktree', 'prune'], root)
    return { lines: ['ABSENT'], code: 0 }
  }

  // 0. Work that is not committed would be lost with the folder: refuse, unless asked to
  //    throw it away.
  // --branch puts a "## ..." line first, so the trimmed output keeps each file line's columns.
  const status = git(['-c', 'core.quotePath=false', 'status', '--porcelain', '--branch'], wt)
  const dirty = status.code === 0 ? status.out.split(/\r?\n/).filter(l => l.trim() !== '' && !l.startsWith('##')) : []
  if (status.code !== 0 && !discard) {
    return { lines: [`FAILED could not read git status in ${wt}: ${status.err}; nothing deleted`], code: 1 }
  }
  if (dirty.length > 0 && !discard) {
    lines.push(`FAILED ${wt} has uncommitted changes, nothing deleted. Commit them first, or pass --discard to throw them away:`)
    for (const l of dirty.slice(0, 20)) lines.push(`  ${l}`)
    if (dirty.length > 20) lines.push(`  ... ${dirty.length - 20} more`)
    return { lines, code: 1 }
  }
  if (dirty.length > 0) lines.push(`discarding ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}`)

  // 1. Unlink the links create made. Only the link goes, never what it points at.
  for (const raw of cfg.worktree_links) {
    let rel
    try {
      rel = safeRel(raw)
    } catch {
      continue
    }
    const dst = path.join(wt, rel)
    if (!isLink(dst)) continue
    try {
      fs.unlinkSync(dst)
    } catch {
      try {
        fs.rmdirSync(dst)
      } catch (e) {
        lines.push(`FAILED unlink ${raw}: ${e.message}`)
        continue
      }
    }
    lines.push(`unlinked ${raw}`)
  }

  // 2. Safety gate: no link may be left anywhere in the worktree, or a delete could reach
  //    through it into the main tree.
  const left = findLinks(wt)
  if (left.length > 0) {
    lines.push('FAILED safety gate: links still in the worktree, nothing deleted:')
    for (const l of left) lines.push(`  ${l}`)
    return { lines, code: 1 }
  }

  // 3. Let git remove it.
  let gone = false
  if (!testFallback) {
    const r = git(['worktree', 'remove', '--force', wt], root)
    gone = r.code === 0 && !exists(wt)
    if (!gone) lines.push(`git worktree remove failed, deleting the folder directly: ${r.err || r.out}`)
  }

  // 4. Fallback: delete exactly .claude/worktrees/<name>, only if it sits directly in that
  //    folder, is not a link and holds no link; then let git forget it.
  if (!gone && exists(wt)) {
    if (path.dirname(wt) !== wtRoot || isLink(wt) || isLink(wtRoot)) {
      lines.push(`FAILED refused to delete outside its root: ${wt}`)
      return { lines, code: 1 }
    }
    if (findLinks(wt).length > 0) {
      lines.push(`FAILED safety gate: links in ${wt}, nothing deleted`)
      return { lines, code: 1 }
    }
    makeWritable(wt)
    try {
      fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 })
    } catch {}
    if (exists(wt)) {
      let n = 0
      try {
        n = fs.readdirSync(wt).length
      } catch {}
      if (n > 0) {
        lines.push(`FAILED could not delete ${wt}: ${n} entries left`)
        return { lines, code: 1 }
      }
      // Only the empty folder is left: a process still has its working directory in it,
      // usually the shell that called this script. The next remove deletes it.
      lines.push(`NOTE empty folder left, still in use by a process: ${wt}`)
    } else {
      lines.push(`deleted ${wt}`)
    }
  }
  git(['worktree', 'prune'], root)
  const kept = kind === 'merge' ? 'target branch kept' : `branch ${cfg.branch_prefix}${slug} kept`
  lines.push(`REMOVED ${wt} (${kept})`)
  return { lines, code: 0 }
}
