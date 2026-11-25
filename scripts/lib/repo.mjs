// Finding the main repository and running git, shared by every command.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Queue state lives in .claude/queue/, worktrees in .claude/worktrees/. Both are kept out of
// git through .git/info/exclude, never through a tracked file. claude-queue/ is where 0.1
// kept the state; init moves it.
export const QUEUE_DIR = path.join('.claude', 'queue')
export const LEGACY_QUEUE_DIR = 'claude-queue'
export const WORKTREE_DIR = path.join('.claude', 'worktrees')

export class QueueError extends Error {}

export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new QueueError(`could not run git: ${r.error.message}`)
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

export function gitOk(args, cwd) {
  const r = git(args, cwd)
  if (r.code !== 0) throw new QueueError(`git ${args.join(' ')} failed: ${r.err || r.out}`)
  return r.out
}

// The main working tree, also when called from inside a linked worktree: the parent of the
// common .git directory.
export function mainRoot(cwd = process.cwd()) {
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  if (r.code !== 0) throw new QueueError(`not inside a git repository: ${cwd}`)
  const common = path.resolve(r.out)
  if (path.basename(common) !== '.git') {
    throw new QueueError(`unsupported repository layout (bare or separate git dir): ${common}`)
  }
  return path.dirname(common)
}

// The same answer without starting git, for the hooks, which must finish fast: walk up to the
// first .git; a folder is the main tree's, a file points into .git/worktrees/<name>, whose
// commondir names the main .git. Falls back to mainRoot when the layout is anything else.
export function mainRootFast(cwd) {
  let dir = path.resolve(cwd)
  for (;;) {
    const dotGit = path.join(dir, '.git')
    let st = null
    try {
      st = fs.statSync(dotGit)
    } catch {}
    if (st?.isDirectory()) return dir
    if (st?.isFile()) {
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))
        const gitdir = path.resolve(dir, m[1].trim())
        const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())
        if (path.basename(common) === '.git') return path.dirname(common)
      } catch {}
      return mainRoot(cwd)
    }
    const up = path.dirname(dir)
    if (up === dir) return mainRoot(cwd)
    dir = up
  }
}

export function queueDir(root) {
  return path.join(root, QUEUE_DIR)
}

export function legacyQueueDir(root) {
  return path.join(root, LEGACY_QUEUE_DIR)
}

// .git/info/exclude of the main repository: local ignore rules, never committed.
export function excludeFile(root) {
  return path.join(root, '.git', 'info', 'exclude')
}

// Whether git ignores the path (relative to root) by any of its rules: .gitignore files,
// .git/info/exclude, core.excludesFile. A tracked path is never ignored.
export function isIgnored(root, rel) {
  return git(['check-ignore', '-q', '--', toPosix(rel)], root).code === 0
}

// Whether the path is inside dir (or is dir), comparing resolved paths, case-insensitively
// on Windows and macOS.
export function isInside(child, dir) {
  const fold = s => (process.platform === 'linux' ? s : s.toLowerCase())
  const rel = path.relative(fold(path.resolve(dir)), fold(path.resolve(child)))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function currentBranch(cwd) {
  const r = git(['branch', '--show-current'], cwd)
  return r.code === 0 ? r.out : ''
}

export function exists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

export function toPosix(p) {
  return p.split(path.sep).join('/')
}
