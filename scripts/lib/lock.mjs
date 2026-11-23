// The coordinator lock: claude-queue/.running. It stops two coordinators from running at
// once. A lock older than lock_stale_hours is ignored; the SessionEnd hook releases it.
import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from './config.mjs'
import { queueDir } from './repo.mjs'

export function lockPath(root) {
  return path.join(queueDir(root), '.running')
}

export function isFresh(root, now = Date.now()) {
  const cfg = loadConfig(root)
  try {
    const age = now - fs.statSync(lockPath(root)).mtimeMs
    return age < Number(cfg.lock_stale_hours) * 3600 * 1000
  } catch {
    return false
  }
}

// Returns [line to print, exit code].
export function lock(root, action) {
  const p = lockPath(root)
  switch (action) {
    case 'status':
      return isFresh(root) ? ['LOCKED', 1] : ['UNLOCKED', 0]
    case 'acquire':
      if (isFresh(root)) return ['LOCKED', 1]
      fs.writeFileSync(p, new Date().toISOString() + '\n')
      return ['ACQUIRED', 0]
    case 'refresh':
      fs.writeFileSync(p, new Date().toISOString() + '\n')
      return ['REFRESHED', 0]
    case 'release':
      fs.rmSync(p, { force: true })
      return ['RELEASED', 0]
    default:
      return [`unknown lock action: ${action} (status, acquire, refresh, release)`, 2]
  }
}
