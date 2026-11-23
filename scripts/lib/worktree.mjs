// Task and merge worktrees under .claude/worktrees/.
//   task:  .claude/worktrees/queue-<slug>, on branch <branch_prefix><slug>
//   merge: .claude/worktrees/merge-<slug>, made by the queue-merge skill with git worktree add
// create links each worktree_links entry from the main tree: a folder as a junction (Windows)
// or symlink, a file as a copy. remove unlinks those links first, refuses to delete anything
// while any link is left inside the worktree, and so never deletes through a link into the
// main tree. The branch is always kept.
import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from './config.mjs'
import { QueueError, WORKTREE_DIR, exists, git } from './repo.mjs'

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

// Links the configured entries into an existing worktree. Returns the lines to print.
export function linkInto(root, wt, links) {
  const out = []
  for (const raw of links) {
    const rel = safeRel(raw)
    const src = path.join(root, rel)
    const dst = path.join(wt, rel)
    if (!exists(src) || exists(dst)) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    if (fs.statSync(src).isDirectory()) {
      fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir')
      out.push(`linked ${raw}`)
    } else {
      fs.copyFileSync(src, dst)
      out.push(`copied ${raw}`)
    }
  }
  return out
}

export function create(root, slug, { base } = {}) {
  const cfg = loadConfig(root)
  const wt = worktreePath(root, slug, 'task')
  if (exists(wt)) return { lines: [`EXISTS ${wt}`], code: 0 }
  const branch = `${cfg.branch_prefix}${slug}`
  const has = git(['branch', '--list', branch], root).out !== ''
  const r = has
    ? git(['worktree', 'add', wt, branch], root)
    : git(['worktree', 'add', '-b', branch, wt, base || cfg.base_branch], root)
  if (r.code !== 0) return { lines: [`FAILED git worktree add: ${r.err || r.out}`], code: 1 }
  const lines = linkInto(root, wt, cfg.worktree_links)
  lines.push(`CREATED ${wt} on ${branch}`)
  return { lines, code: 0 }
}

export function link(root, slug, kind) {
  const cfg = loadConfig(root)
  const wt = worktreePath(root, slug, kind)
  if (!exists(wt)) return { lines: [`FAILED no worktree at ${wt}`], code: 1 }
  const lines = linkInto(root, wt, cfg.worktree_links)
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

export function remove(root, slug, kind = 'task', { testFallback = false } = {}) {
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
