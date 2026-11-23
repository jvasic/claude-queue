// init: sets a repository up for the queue. Creates claude-queue/ with config.json, queue.md,
// log.md and merged.md, adds the .gitignore lines, and appends a short note to CLAUDE.md.
// Existing files are kept, never overwritten.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS } from './config.mjs'
import { QUEUE_DIR, QueueError, currentBranch, exists, queueDir } from './repo.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PRESETS = ['none', 'python', 'node', 'mixed']
export const NOTE_HEADING = '## Task queue (task-queue plugin)'
const IGNORE = [`/${QUEUE_DIR}/`, '/.claude/worktrees/']

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

// A repository that already has claude-queue/config.json is set up: change nothing, say so,
// and name any part that is missing, for the user to restore by hand.
function already(root, q) {
  const lines = [`ALREADY INITIALIZED ${q}`]
  for (const f of ['queue.md', 'log.md', 'merged.md']) {
    if (!exists(path.join(q, f))) lines.push(`missing ${QUEUE_DIR}/${f}`)
  }
  const gi = path.join(root, '.gitignore')
  const have = new Set((exists(gi) ? fs.readFileSync(gi, 'utf8') : '').split(/\r?\n/).map(l => l.trim()))
  for (const l of IGNORE) {
    if (!have.has(l) && !have.has(l.replace(/^\//, ''))) lines.push(`missing .gitignore line ${l}`)
  }
  const md = path.join(root, 'CLAUDE.md')
  if (!(exists(md) && fs.readFileSync(md, 'utf8').includes(NOTE_HEADING))) lines.push('missing the queue note in CLAUDE.md')
  return lines
}

export function init(root, { preset = 'none' } = {}) {
  readPreset(preset)
  const q = queueDir(root)
  if (exists(path.join(q, 'config.json'))) return already(root, q)
  const lines = []
  fs.mkdirSync(q, { recursive: true })
  writeIfMissing(path.join(q, 'config.json'), JSON.stringify(buildConfig(root, preset), null, 2) + '\n', lines, `${QUEUE_DIR}/config.json (preset ${preset})`)
  writeIfMissing(
    path.join(q, 'queue.md'),
    '---\n[notes] Coordinator notes (read first; never a task)\nNothing yet.\n---\n',
    lines,
    `${QUEUE_DIR}/queue.md`,
  )
  writeIfMissing(path.join(q, 'log.md'), '# Queue log\n\nOne entry per finished task, written by the coordinator.\n', lines, `${QUEUE_DIR}/log.md`)
  writeIfMissing(path.join(q, 'merged.md'), '# Merged branches\n\nBranches applied by /queue-merge.\n', lines, `${QUEUE_DIR}/merged.md`)

  const gi = path.join(root, '.gitignore')
  const current = exists(gi) ? fs.readFileSync(gi, 'utf8') : ''
  const have = new Set(current.split(/\r?\n/).map(l => l.trim()))
  const missing = IGNORE.filter(l => !have.has(l) && !have.has(l.replace(/^\//, '')))
  if (missing.length > 0) {
    const sep = current === '' || current.endsWith('\n') ? '' : '\n'
    fs.appendFileSync(gi, `${sep}\n# task-queue plugin: queue state and task worktrees\n${missing.join('\n')}\n`)
    lines.push(`added to .gitignore: ${missing.join(' ')}`)
  } else lines.push('kept .gitignore (lines already there)')

  const md = path.join(root, 'CLAUDE.md')
  const mdText = exists(md) ? fs.readFileSync(md, 'utf8') : ''
  if (mdText.includes(NOTE_HEADING)) lines.push('kept CLAUDE.md (note already there)')
  else {
    const note = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'claude-md-note.md'), 'utf8')
    const sep = mdText === '' ? '' : mdText.endsWith('\n') ? '\n' : '\n\n'
    fs.writeFileSync(md, mdText + sep + note)
    lines.push(mdText === '' ? 'created CLAUDE.md with the queue note' : 'appended the queue note to CLAUDE.md')
  }
  lines.push(`INITIALIZED ${q}`)
  return lines
}
