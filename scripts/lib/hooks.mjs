// The plugin's command hooks. hooks/hooks.json starts Node for them only in a repository with
// a queue (a cheap file test in the shell comes first), and they always exit 0.
//   prompt-submit (UserPromptSubmit): in the coordinator's session, refresh the lock.
//   session-end (SessionEnd): when the coordinator's session ends, drop its marker and release
//     the lock.
//   pre-tool-use (PreToolUse, safety_hooks): for a queue worker only (a subagent whose id is a
//     task's "> agent:" in queue.md, without a "> free:" line), refuse git push, git stash,
//     staging everything, git changes outside its worktree, and file writes outside its
//     worktree, the temp folders, .claude/queue/research/ and safety_allow. The user's own
//     sessions and every other subagent are never touched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from './config.mjs'
import { lockPath, markerPath } from './lock.mjs'
import { readQueue } from './queuefile.mjs'
import { exists, isInside, mainRootFast, queueDir } from './repo.mjs'
import { worktreePath } from './worktree.mjs'

export { markerPath }

function heldBy(root, session) {
  try {
    return fs.readFileSync(markerPath(root), 'utf8').trim() === session
  } catch {
    return false
  }
}

// Returns what the hook prints (a JSON decision for pre-tool-use), or ''.
export function handle(event, input) {
  if (!input || typeof input.session_id !== 'string' || input.session_id === '') return ''
  let root
  try {
    root = mainRootFast(input.cwd || process.cwd())
  } catch {
    return ''
  }
  // Only a repository set up with /queue-init.
  if (!exists(path.join(queueDir(root), 'config.json'))) return ''
  if (event === 'prompt-submit') {
    if (heldBy(root, input.session_id) && exists(lockPath(root))) {
      fs.writeFileSync(lockPath(root), new Date().toISOString() + '\n')
    }
  } else if (event === 'session-end') {
    if (heldBy(root, input.session_id)) {
      fs.rmSync(markerPath(root), { force: true })
      fs.rmSync(lockPath(root), { force: true })
    }
  } else if (event === 'pre-tool-use') {
    const why = refusal(root, input)
    if (why) {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `task-queue safety: ${why} Stop and report this as a refused tool call in your report; do not work around it. If the user wants this task to do it, the coordinator adds a "> free:" line to the task.`,
        },
      })
    }
  }
  return ''
}

const MUTATING_GIT = /^(?:checkout|switch|reset|commit|merge|rebase|cherry-pick|revert|clean|restore|rm|mv|am|apply|pull)$/
const BRANCH_CHANGE = /^(?:-d|-D|--delete|-m|-M|--move|-f|--force)$/

// The dirs a worker may write in.
function allowedDirs(root, cfg, wt) {
  const dirs = [wt, os.tmpdir(), path.join(queueDir(root), 'research')]
  for (const k of ['TEMP', 'TMP', 'TMPDIR']) if (process.env[k]) dirs.push(process.env[k])
  for (const p of cfg.safety_allow ?? []) dirs.push(path.resolve(root, p))
  return dirs.filter(Boolean)
}

// Each simple command of a shell line, with the folder it runs in as far as "cd x &&" says.
function commands(line, cwd) {
  const out = []
  let dir = cwd
  for (const part of line.split(/&&|\|\||;|\||\r?\n/)) {
    const words = part.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    const unq = words.map(w => w.replace(/^["']|["']$/g, ''))
    if (unq[0] === 'cd' || unq[0] === 'Set-Location' || unq[0] === 'pushd') {
      if (unq[1]) dir = path.resolve(dir, unq[1])
      continue
    }
    out.push({ words: unq, dir })
  }
  return out
}

function gitRefusal(words, dir, allowed) {
  const i = words.findIndex(w => /(^|[\\/])git(\.exe)?$/i.test(w))
  if (i < 0) return ''
  let where = dir
  let j = i + 1
  while (j < words.length && words[j].startsWith('-')) {
    if (words[j] === '-C' && words[j + 1]) {
      where = path.resolve(where, words[j + 1])
      j += 2
    } else if (words[j] === '-c') j += 2
    else j += 1
  }
  const sub = words[j] ?? ''
  const args = words.slice(j + 1)
  if (sub === 'push') return 'workers never push.'
  if (sub === 'stash') return 'workers never use git stash.'
  if (sub === 'add' && args.some(a => a === '-A' || a === '--all' || a === '.' || a === '-u' || a === '--update' || a === ':/')) {
    return 'stage the files you changed by name (git add <paths>), never everything.'
  }
  if (sub === 'branch' && args.some(a => BRANCH_CHANGE.test(a))) {
    return 'workers never delete, move or reset branches.'
  }
  if (MUTATING_GIT.test(sub) && !allowed.some(d => isInside(where, d))) {
    return `git ${sub} would change ${where}, outside your worktree.`
  }
  return ''
}

export function refusal(root, input) {
  if (typeof input.agent_id !== 'string' || input.agent_id === '') return ''
  let cfg
  try {
    cfg = loadConfig(root)
  } catch {
    return ''
  }
  if (cfg.safety_hooks === false) return ''
  const task = readQueue(root).find(t => (t.notes.agent ?? []).includes(input.agent_id))
  if (!task || task.notes.free) return ''
  const branch = task.notes.branch?.[0] ?? ''
  const prefix = cfg.branch_prefix
  let wt = null
  try {
    if (branch.startsWith(prefix)) wt = worktreePath(root, branch.slice(prefix.length))
  } catch {}
  const allowed = allowedDirs(root, cfg, wt)
  const cwd = input.cwd || root
  const ti = input.tool_input ?? {}
  const tool = input.tool_name
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const file = ti.file_path ?? ti.notebook_path
    if (typeof file !== 'string') return ''
    const abs = path.resolve(cwd, file)
    if (!allowed.some(d => isInside(abs, d))) {
      return `${abs} is outside your worktree${wt ? ` (${wt})` : ''}.`
    }
    return ''
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    for (const c of commands(String(ti.command ?? ''), cwd)) {
      const why = gitRefusal(c.words, c.dir, allowed)
      if (why) return why
    }
  }
  return ''
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
