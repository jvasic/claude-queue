import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { cleanup, cli, makeRepo } from './helpers.mjs'

const repos = []
const repo = config => {
  const r = makeRepo(config)
  repos.push(r)
  return r
}
after(() => repos.forEach(cleanup))

test('lock: acquire, refuse while fresh, ignore when stale, release', () => {
  const root = repo({ lock_stale_hours: 1 })
  assert.equal(cli(['lock', 'status'], root).out, 'UNLOCKED')
  assert.deepEqual(cli(['lock', 'acquire'], root), { code: 0, out: 'ACQUIRED', err: '' })
  const second = cli(['lock', 'acquire'], root)
  assert.equal(second.out, 'LOCKED')
  assert.equal(second.code, 1)
  const lock = path.join(root, 'claude-queue', '.running')
  const old = new Date(Date.now() - 2 * 3600 * 1000)
  fs.utimesSync(lock, old, old)
  assert.equal(cli(['lock', 'status'], root).out, 'UNLOCKED')
  assert.equal(cli(['lock', 'acquire'], root).out, 'ACQUIRED')
  assert.equal(cli(['lock', 'release'], root).out, 'RELEASED')
  assert.equal(fs.existsSync(lock), false)
})

test('lock works from inside a subfolder, on the main tree', () => {
  const root = repo()
  const sub = path.join(root, 'claude-queue')
  assert.equal(cli(['lock', 'acquire'], sub).out, 'ACQUIRED')
  assert.equal(cli(['lock', 'status'], root).out, 'LOCKED')
})

test('hooks: the coordinator session is remembered and its end releases the lock', () => {
  const root = repo()
  const marker = path.join(root, 'claude-queue', '.runner-session')
  const send = (event, body) => cli(['hook', event], root, JSON.stringify({ cwd: root, ...body }))

  send('prompt-submit', { session_id: 's1', prompt: 'fix the login page' })
  assert.equal(fs.existsSync(marker), false)
  send('prompt-submit', { session_id: 's1', prompt: '/task-queue:queue-start' })
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 's1')
  send('prompt-submit', { session_id: 's2', prompt: '/queue-coordinator now' })
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 's2')

  cli(['lock', 'acquire'], root)
  send('session-end', { session_id: 's1' })
  assert.equal(cli(['lock', 'status'], root).out, 'LOCKED', 'another session ending keeps the lock')
  send('session-end', { session_id: 's2' })
  assert.equal(cli(['lock', 'status'], root).out, 'UNLOCKED')
  assert.equal(fs.existsSync(marker), false)
})

test('hooks never fail: bad JSON, no repo, no config', () => {
  const root = repo()
  assert.equal(cli(['hook', 'prompt-submit'], root, 'not json').code, 0)
  fs.rmSync(path.join(root, 'claude-queue', 'config.json'))
  const r = cli(['hook', 'prompt-submit'], root, JSON.stringify({ cwd: root, session_id: 'x', prompt: '/queue-start' }))
  assert.equal(r.code, 0)
  assert.equal(fs.existsSync(path.join(root, 'claude-queue', '.runner-session')), false)
})

test('config: show, set with validation, get', () => {
  const root = repo({ max_workers: 4 })
  assert.match(cli(['config', 'show'], root).out, /max_workers = 4/)
  assert.equal(cli(['config', 'set', 'max_workers', '6'], root).code, 0)
  assert.equal(cli(['config', 'get', 'max_workers'], root).out, '6')
  const bad = cli(['config', 'set', 'max_workers', '0'], root)
  assert.equal(bad.code, 1)
  assert.match(bad.out, /1 to 20/)
  assert.equal(cli(['config', 'set', 'models.worker', 'sonnet'], root).code, 0)
  assert.equal(cli(['config', 'get', 'models.small_task'], root).out, '"sonnet"')
  assert.equal(cli(['config', 'set', 'worktree_links', '[".venv","node_modules"]'], root).code, 0)
  assert.equal(cli(['config', 'set', 'nonsense', '1'], root).code, 1)
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'claude-queue', 'config.json'), 'utf8'))
  assert.deepEqual(raw.worktree_links, ['.venv', 'node_modules'])
  assert.equal(raw.base_branch, 'main', 'other keys are kept')
})

test('commands outside an initialized repo say how to start', () => {
  const root = repo()
  fs.rmSync(path.join(root, 'claude-queue'), { recursive: true })
  const r = cli(['lock', 'status'], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /queue-init/)
})
