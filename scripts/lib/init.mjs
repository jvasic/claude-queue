// init: sets a repository up for the queue. Creates .claude/queue/ with config.json, queue.md,
// log.md and merged.md, and keeps .claude/queue/ and .claude/worktrees/ out of git through
// .git/info/exclude. It never creates or edits a tracked file: no .gitignore, no CLAUDE.md, no
// AGENTS.md. Sessions learn about the queue from the plugin's SessionStart hook instead.
//
// A repository set up by 0.1 (claude-queue/ at the root) is migrated: the folder is moved to
// .claude/queue/ and the old .gitignore lines and CLAUDE.md note are left for the user.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS } from './config.mjs'
import {
  LEGACY_QUEUE_DIR,
  QUEUE_DIR,
  QueueError,
  WORKTREE_DIR,
  currentBranch,
  excludeFile,
  exists,
  isIgnored,
  legacyQueueDir,
  queueDir,
  toPosix,
} from './repo.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PRESETS = ['none', 'python', 'node', 'mixed']
const LEGACY_NOTE_HEADING = '## Task queue (task-queue plugin)'

// Each folder git must ignore, with a path inside it to ask git about.
const KEEP_OUT = [
  { line: `/${toPosix(QUEUE_DIR)}/`, probe: path.join(QUEUE_DIR, 'config.json') },
  { line: `/${toPosix(WORKTREE_DIR)}/`, probe: path.join(WORKTREE_DIR, 'queue-probe', 'file') },
]

function readPreset(name) {
  if (!PRESETS.includes(name)) throw new QueueError(`unknown preset: ${name} (${PRESETS.join(', ')})`)
  if (name === 'none') return {}
  const p = path.join(PLUGIN_ROOT, 'templates', 'examples', `${name}.json`)
  const preset = JSON.parse(fs.readFileSync(p, 'utf8'))
  delete preset._comment
  return preset
}

export function buildConfig(root, preset) {
  const p = readPreset(preset)
  return {
    _comment: 'Settings for the task-queue plugin. /queue-options shows and changes them; the README lists every key.',
    ...DEFAULTS,
    base_branch: currentBranch(root) || DEFAULTS.base_branch,
    ...p,
    checks: { ...DEFAULTS.checks, ...(p.checks ?? {}) },
  }
}

function writeIfMissing(file, text, lines, label) {
  if (exists(file)) {
    lines.push(`kept ${label} (already there)`)
    return
  }
  fs.writeFileSync(file, text)
  lines.push(`created ${label}`)
}

const STATE_FILES = {
  'queue.md': '---\n[notes] Coordinator notes (read first; never a task)\nNothing yet.\n---\n',
  'log.md': '# Queue log\n\nOne entry per finished task, written by the coordinator, newest last.\n',
  'merged.md': '# Merged branches\n\nBranches applied by /queue-merge, newest last.\n',
}

// Creates the queue's state files that are not there yet.
function writeStateFiles(q, lines) {
  for (const [name, text] of Object.entries(STATE_FILES)) {
    writeIfMissing(path.join(q, name), text, lines, `${toPosix(QUEUE_DIR)}/${name}`)
  }
}

// Asks git, by all its rules, whether each folder is ignored; adds the ones that are not to
// .git/info/exclude. With dryRun, only reports what is missing.
export function keepOut(root, { dryRun = false } = {}) {
  const missing = KEEP_OUT.filter(k => !isIgnored(root, k.probe))
  if (missing.length === 0) return []
  if (dryRun) return missing.map(k => `missing ${k.line} in .git/info/exclude (git does not ignore it)`)
  const file = excludeFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const current = exists(file) ? fs.readFileSync(file, 'utf8') : ''
  const sep = current === '' || current.endsWith('\n') ? '' : '\n'
  fs.appendFileSync(file, `${sep}# task-queue plugin: queue state and task worktrees\n${missing.map(k => k.line).join('\n')}\n`)
  return [`added to .git/info/exclude: ${missing.map(k => k.line).join(' ')}`]
}

// What 0.1 left in tracked files, for the user to remove by hand.
function leftovers(root) {
  const lines = []
  const gi = path.join(root, '.gitignore')
  if (exists(gi) && fs.readFileSync(gi, 'utf8').split(/\r?\n/).some(l => l.trim().replace(/^\//, '') === `${LEGACY_QUEUE_DIR}/`)) {
    lines.push(`left as is: the /${LEGACY_QUEUE_DIR}/ line in .gitignore (no longer needed; remove it when convenient)`)
  }
  const md = path.join(root, 'CLAUDE.md')
  if (exists(md) && fs.readFileSync(md, 'utf8').includes(LEGACY_NOTE_HEADING)) {
    lines.push(`left as is: the "${LEGACY_NOTE_HEADING.replace(/^## /, '')}" section in CLAUDE.md (the plugin now tells sessions itself; remove it when convenient)`)
  }
  return lines
}

// A repository already set up: change nothing, say so, and name any part that is missing.
function already(root, q) {
  const lines = [`ALREADY INITIALIZED ${q}`]
  for (const f of ['queue.md', 'log.md', 'merged.md']) {
    if (!exists(path.join(q, f))) lines.push(`missing ${toPosix(QUEUE_DIR)}/${f}`)
  }
  lines.push(...keepOut(root, { dryRun: true }))
  if (exists(path.join(legacyQueueDir(root), 'config.json'))) {
    lines.push(`left as is: ${LEGACY_QUEUE_DIR}/ from 0.1 next to ${toPosix(QUEUE_DIR)}/; nothing reads it, remove it when convenient`)
  }
  lines.push(...leftovers(root))
  return lines
}

function migrate(root, legacy, q) {
  const lock = path.join(legacy, '.running')
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8'))
    const hours = Number(cfg.lock_stale_hours ?? DEFAULTS.lock_stale_hours)
    if (Date.now() - fs.statSync(lock).mtimeMs < hours * 3600 * 1000) {
      throw new QueueError(`a coordinator holds the lock in ${LEGACY_QUEUE_DIR}/: close it with /queue-close first, then run /queue-init again`)
    }
  } catch (e) {
    if (e instanceof QueueError) throw e
  }
  fs.mkdirSync(path.dirname(q), { recursive: true })
  try {
    fs.renameSync(legacy, q)
  } catch (e) {
    throw new QueueError(`could not move ${LEGACY_QUEUE_DIR}/ to ${toPosix(QUEUE_DIR)}/: ${e.message} (close programs that have files in it open, then run /queue-init again)`)
  }
  for (const f of ['.running', '.runner-session']) fs.rmSync(path.join(q, f), { force: true })
  const lines = [`moved ${LEGACY_QUEUE_DIR}/ to ${toPosix(QUEUE_DIR)}/ (queue, log, settings and research kept)`]
  writeStateFiles(q, lines)
  lines.push(...keepOut(root))
  lines.push(...leftovers(root))
  lines.push(`MIGRATED ${q}`)
  return lines
}

export function init(root, { preset = 'none' } = {}) {
  readPreset(preset)
  const q = queueDir(root)
  if (exists(path.join(q, 'config.json'))) return already(root, q)
  const legacy = legacyQueueDir(root)
  if (exists(path.join(legacy, 'config.json')) && !exists(q)) return migrate(root, legacy, q)

  const lines = []
  fs.mkdirSync(q, { recursive: true })
  const dir = toPosix(QUEUE_DIR)
  writeIfMissing(path.join(q, 'config.json'), JSON.stringify(buildConfig(root, preset), null, 2) + '\n', lines, `${dir}/config.json (preset ${preset})`)
  writeStateFiles(q, lines)
  const kept = keepOut(root)
  lines.push(...(kept.length > 0 ? kept : ['kept .git/info/exclude (git already ignores both folders)']))
  lines.push(`INITIALIZED ${q}`)
  return lines
}
