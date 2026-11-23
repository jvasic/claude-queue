// The plugin's two command hooks. They never block anything and always exit 0.
//   prompt-submit (UserPromptSubmit): when the prompt starts the coordinator (/queue-start,
//     /queue-coordinator, or /queue-init, which starts it after setting up), with or without
//     the plugin prefix, and no other coordinator holds the lock, remember this session as
//     the coordinator. `lock acquire` does the same from CLAUDE_CODE_SESSION_ID; this hook
//     covers builds that do not pass that variable.
//   session-end (SessionEnd): when the coordinator session ends, drop its marker and release
//     the lock.
import fs from 'node:fs'
import path from 'node:path'

import { isFresh, lockPath, markerPath } from './lock.mjs'
import { exists, mainRootFast, queueDir } from './repo.mjs'

const START = /^\/(?:[a-z0-9-]+:)?queue-(?:start|coordinator|init)(?:\s|$)/i

export { markerPath }

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
    // A running coordinator keeps its marker: a second /queue-start finds the lock taken
    // and stops, and its session's end must not release the first one's lock.
    if (START.test(String(input.prompt ?? '').trimStart()) && !isFresh(root)) {
      fs.writeFileSync(marker, input.session_id + '\n')
    }
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
