// The coordinator lock: .claude/queue/.running. It stops two coordinators from running at
// once. The coordinator refreshes it (each edit, each prompt, and every minute from the pane);
// one not refreshed for lock_stale_hours is ignored. The SessionEnd hook releases it.
//
// .claude/queue/.runner-session names the coordinator's session, so that its end (and only its
// end) releases the lock. `lock acquire` writes it from CLAUDE_CODE_SESSION_ID, which Claude
// Code passes to the commands it runs; the pane writes it too when it sees its own session's
// acquire succeed, for builds without that variable.
import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from './config.mjs'
import { queueDir } from './repo.mjs'

export function lockPath(root) {
  return path.join(queueDir(root), '.running')
}

export function markerPath(root) {
  return path.join(queueDir(root), '.runner-session')
}

function maxAge(root) {
  return Number(loadConfig(root).lock_stale_hours) * 3600 * 1000
}

export function isFresh(root, now = Date.now()) {
  try {
    return now - fs.statSync(lockPath(root)).mtimeMs < maxAge(root)
  } catch {
    return false
  }
}

// Creates the lock file only if no file is there: of two sessions acquiring at once, one wins.
function create(p) {
  try {
    fs.writeFileSync(p, new Date().toISOString() + '\n', { flag: 'wx' })
    return true
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
}

// A stale lock is moved aside by rename, which only one process can do to a given file. If
// the file moved aside turns out not to be the stale one (another session replaced it in
// between), it is put back and the lock counts as taken.
function takeOverStale(root, p) {
  let seen
  try {
    seen = fs.statSync(p).mtimeMs
  } catch {
    return create(p)
  }
  if (Date.now() - seen < maxAge(root)) return false
  const aside = `${p}.stale-${process.pid}-${Date.now()}`
  try {
    fs.renameSync(p, aside)
  } catch {
    return false
  }
  if (fs.statSync(aside).mtimeMs !== seen) {
    try {
      fs.renameSync(aside, p)
    } catch {}
    return false
  }
  fs.rmSync(aside, { force: true })
  return create(p)
}

// Returns [line to print, exit code].
export function lock(root, action, env = process.env) {
  loadConfig(root) // fails with how to set the repository up
  const p = lockPath(root)
  switch (action) {
    case 'status':
      return isFresh(root) ? ['LOCKED', 1] : ['UNLOCKED', 0]
    case 'acquire': {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      if (!create(p) && !takeOverStale(root, p)) return ['LOCKED', 1]
      const session = env.CLAUDE_CODE_SESSION_ID ?? ''
      if (session !== '') fs.writeFileSync(markerPath(root), session + '\n')
      else fs.rmSync(markerPath(root), { force: true })
      return ['ACQUIRED', 0]
    }
    case 'refresh':
      // Only a held lock is refreshed: a refresh after a release must not take the lock again.
      if (!fs.existsSync(p)) return ['NOT HELD', 1]
      fs.writeFileSync(p, new Date().toISOString() + '\n')
      return ['REFRESHED', 0]
    case 'release':
      fs.rmSync(p, { force: true })
      fs.rmSync(markerPath(root), { force: true })
      return ['RELEASED', 0]
    default:
      return [`unknown lock action: ${action} (status, acquire, refresh, release)`, 2]
  }
}
