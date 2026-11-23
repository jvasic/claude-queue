// The coordinator lock: claude-queue/.running. It stops two coordinators from running at
// once. A lock older than lock_stale_hours is ignored; the SessionEnd hook releases it.
//
// claude-queue/.runner-session names the coordinator's session, so that its end (and only
// its end) releases the lock. `lock acquire` writes it from CLAUDE_CODE_SESSION_ID, which
// Claude Code passes to the commands it runs; the UserPromptSubmit hook writes it too, for
// builds without that variable.
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
export function lock(root, action, env = process.env) {
  const p = lockPath(root)
  switch (action) {
    case 'status':
      return isFresh(root) ? ['LOCKED', 1] : ['UNLOCKED', 0]
    case 'acquire': {
      if (isFresh(root)) return ['LOCKED', 1]
      fs.writeFileSync(p, new Date().toISOString() + '\n')
      const session = env.CLAUDE_CODE_SESSION_ID ?? ''
      if (session !== '') fs.writeFileSync(markerPath(root), session + '\n')
      return ['ACQUIRED', 0]
    }
    case 'refresh':
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
