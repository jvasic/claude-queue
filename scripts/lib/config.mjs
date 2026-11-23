// config.json: defaults, reading, the settings /queue-options shows, and validated writes.
import fs from 'node:fs'
import path from 'node:path'

import { QueueError, queueDir } from './repo.mjs'

export const DEFAULTS = {
  base_branch: 'main',
  branch_prefix: 'queue/',
  max_workers: 4,
  lock_stale_hours: 4,
  models: { worker: 'opus', small_task: 'sonnet', merge: 'opus' },
  worktree_links: [],
  venv: '.venv',
  checks: { changed: [], full: [] },
  one_at_a_time: [],
  notes: [],
  helpers: [],
}

// The settings /queue-options lists, in order, each with its one-line explanation.
export const SETTINGS = [
  ['max_workers', 'Workers running at once (1 to 20).'],
  ['models.worker', 'Model for a normal worker.'],
  ['models.small_task', 'Model for small, clearly scoped tasks.'],
  ['models.merge', 'Model for the merge agent.'],
  ['branch_prefix', 'Prefix of every task branch, e.g. queue/ gives queue/<slug>.'],
  ['base_branch', 'Branch new task branches start from.'],
  ['checks.changed', 'Checks run on a worker\'s changed files, each with file patterns and a command.'],
  ['checks.full', 'Commands run once per merge round (the full test suite).'],
  ['worktree_links', 'Folders linked (files copied) from the main tree into each worktree, e.g. .venv, node_modules, .env.'],
  ['venv', 'Python virtualenv folder whose bin directory is put first on PATH for checks; "" for none.'],
  ['lock_stale_hours', 'A coordinator lock older than this many hours is ignored.'],
  ['one_at_a_time', 'Kinds of task that never run two at once, e.g. "tasks that add a database migration".'],
  ['notes', 'Repo rules passed to every worker and merge agent, one string each.'],
  ['helpers', 'Other open sessions and what to send them: [{ "name": ..., "for": ... }].'],
]

export function configPath(root) {
  return path.join(queueDir(root), 'config.json')
}

export function readRaw(root) {
  const p = configPath(root)
  let text
  try {
    text = fs.readFileSync(p, 'utf8')
  } catch {
    throw new QueueError(`no ${p}: run /queue-init in this repository first`)
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    throw new QueueError(`${p} is not valid JSON: ${e.message}`)
  }
}

export function loadConfig(root) {
  const raw = readRaw(root)
  return {
    ...DEFAULTS,
    ...raw,
    models: { ...DEFAULTS.models, ...(raw.models ?? {}) },
    checks: { ...DEFAULTS.checks, ...(raw.checks ?? {}) },
  }
}

export function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function setPath(obj, key, value) {
  const parts = key.split('.')
  let o = obj
  for (const k of parts.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {}
    o = o[k]
  }
  o[parts[parts.length - 1]] = value
}

const isStringList = v => Array.isArray(v) && v.every(x => typeof x === 'string')

// Returns an error message, or '' when the value fits the key.
export function validate(key, value) {
  switch (key) {
    case 'max_workers':
      return Number.isInteger(value) && value >= 1 && value <= 20 ? '' : 'a whole number from 1 to 20'
    case 'lock_stale_hours':
      return typeof value === 'number' && value > 0 ? '' : 'a number above 0'
    case 'branch_prefix':
      return typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('/')
        ? ''
        : 'a branch name prefix such as queue/ (letters, digits, . _ - /)'
    case 'base_branch':
      return typeof value === 'string' && value.trim() !== '' && !/\s/.test(value) ? '' : 'a branch name'
    case 'models.worker':
    case 'models.small_task':
    case 'models.merge':
      return typeof value === 'string' && value.trim() !== '' ? '' : 'a model name such as opus or sonnet'
    case 'venv':
      return typeof value === 'string' ? '' : 'a folder name, or "" for none'
    case 'worktree_links':
    case 'one_at_a_time':
    case 'notes':
      return isStringList(value) ? '' : 'a list of strings'
    case 'checks.changed':
      return Array.isArray(value) && value.every(checkShape) ? '' : 'a list of { name, when, run } checks'
    case 'checks.full':
      return Array.isArray(value) && value.every(c => typeof c?.name === 'string' && typeof c?.run === 'string')
        ? ''
        : 'a list of { name, run } commands'
    case 'helpers':
      return Array.isArray(value) && value.every(h => typeof h?.name === 'string' && typeof h?.for === 'string')
        ? ''
        : 'a list of { "name": ..., "for": ... }'
    default:
      return `unknown setting; known: ${SETTINGS.map(s => s[0]).join(', ')}`
  }
}

function checkShape(c) {
  return typeof c?.name === 'string' && typeof c?.run === 'string' && isStringList(c?.when)
}

// The value as typed: JSON when it parses, else the plain string.
export function parseValue(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function setSetting(root, key, value) {
  const problem = validate(key, value)
  if (problem) throw new QueueError(`${key}: expected ${problem}`)
  const raw = readRaw(root)
  setPath(raw, key, value)
  fs.writeFileSync(configPath(root), JSON.stringify(raw, null, 2) + '\n')
  return raw
}

export function describe(root) {
  const cfg = loadConfig(root)
  const lines = []
  for (const [key, why] of SETTINGS) {
    const v = getPath(cfg, key)
    let shown
    if (key === 'checks.changed' || key === 'checks.full') {
      shown = v.length === 0 ? '(none)' : v.map(c => c.name).join(', ')
    } else if (key === 'helpers') {
      shown = v.length === 0 ? '(none)' : v.map(h => `${h.name} (${h.for})`).join('; ')
    } else if (Array.isArray(v)) {
      shown = v.length === 0 ? '(none)' : v.join(', ')
    } else {
      shown = JSON.stringify(v)
    }
    lines.push(`${key} = ${shown}`)
    lines.push(`    ${why}`)
  }
  return lines.join('\n')
}
