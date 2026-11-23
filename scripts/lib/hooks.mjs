// The plugin's two command hooks. They never block anything and always exit 0.
//   prompt-submit (UserPromptSubmit): when the prompt is /queue-start or /queue-coordinator,
//     with or without the plugin prefix, remember this session as the coordinator.
//   session-end (SessionEnd): when the coordinator session ends, drop its marker and release
//     the lock.
import fs from 'node:fs'
import path from 'node:path'

import { lockPath } from './lock.mjs'
import { exists, mainRootFast, queueDir } from './repo.mjs'

const START = /^\/(?:[a-z0-9-]+:)?queue-(?:start|coordinator)(?:\s|$)/i

export function markerPath(root) {
  return path.join(queueDir(root), '.runner-session')
}

export function handle(event, input) {
  if (!input || typeof input.session_id !== 'string' || input.session_id === '') return
  let root
  try {
    root = mainRootFast(input.cwd || process.cwd())
  } catch {
    return
  }
  // Only a repository set up with /queue-init.
  if (!exists(path.join(queueDir(root), 'config.json'))) return
  const marker = markerPath(root)
  if (event === 'prompt-submit') {
    if (START.test(String(input.prompt ?? '').trimStart())) fs.writeFileSync(marker, input.session_id + '\n')
  } else if (event === 'session-end') {
    let held = ''
    try {
      held = fs.readFileSync(marker, 'utf8').trim()
    } catch {
      return
    }
    if (held === input.session_id) {
      fs.rmSync(marker, { force: true })
      fs.rmSync(lockPath(root), { force: true })
    }
  }
}

export async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
