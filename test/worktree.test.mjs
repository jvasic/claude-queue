import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { cleanup, cli, makeRepo, sh } from './helpers.mjs'

const repos = []
after(() => repos.forEach(cleanup))

// A repo whose main tree has a .venv folder, a nested node_modules folder and a .env file.
function setup() {
  const root = makeRepo({ worktree_links: ['.venv', 'web/node_modules', '.env', 'missing'] })
  repos.push(root)
  fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, '.venv', 'bin', 'keep.txt'), 'main venv')
  fs.mkdirSync(path.join(root, 'web', 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'node_modules', 'pkg', 'index.js'), 'main pkg')
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n')
  return root
}

const isLink = p => fs.lstatSync(p).isSymbolicLink()
const mainIntact = root => {
  assert.equal(fs.readFileSync(path.join(root, '.venv', 'bin', 'keep.txt'), 'utf8'), 'main venv')
  assert.equal(fs.readFileSync(path.join(root, 'web', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'main pkg')
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'A=1\n')
}

test('create links folders, copies files, skips missing ones; remove keeps the branch and the main tree', () => {
  const root = setup()
  const r = cli(['worktree', 'create', '--slug', 'billing-totals'], root)
  assert.equal(r.code, 0, r.out)
  const wt = path.join(root, '.claude', 'worktrees', 'queue-billing-totals')
  assert.match(r.out, /CREATED .* on queue\/billing-totals/)
  assert.ok(isLink(path.join(wt, '.venv')))
  assert.ok(isLink(path.join(wt, 'web', 'node_modules')))
  assert.ok(!isLink(path.join(wt, '.env')))
  assert.equal(fs.readFileSync(path.join(wt, '.venv', 'bin', 'keep.txt'), 'utf8'), 'main venv')

  assert.match(cli(['worktree', 'create', '--slug', 'billing-totals'], root).out, /^EXISTS /)
  assert.equal(cli(['worktree', 'path', '--slug', 'billing-totals'], root).out, wt)

  fs.writeFileSync(path.join(wt, 'feature.txt'), 'work')
  sh(['add', 'feature.txt'], wt)
  sh(['commit', '-q', '-m', 'work'], wt)

  const rm = cli(['worktree', 'remove', '--slug', 'billing-totals'], root)
  assert.equal(rm.code, 0, rm.out)
  assert.match(rm.out, /unlinked \.venv/)
  assert.match(rm.out, /REMOVED .*branch queue\/billing-totals kept/)
  assert.equal(fs.existsSync(wt), false)
  assert.equal(sh(['branch', '--list', 'queue/billing-totals'], root), 'queue/billing-totals')
  mainIntact(root)
  assert.equal(cli(['worktree', 'remove', '--slug', 'billing-totals'], root).out, 'ABSENT')

  // Recreating reuses the kept branch and its commit.
  assert.equal(cli(['worktree', 'create', '--slug', 'billing-totals'], root).code, 0)
  assert.equal(fs.readFileSync(path.join(wt, 'feature.txt'), 'utf8'), 'work')
})

test('the fallback delete (git skipped) removes the folder without reaching through links', () => {
  const root = setup()
  cli(['worktree', 'create', '--slug', 'fallback'], root)
  const wt = path.join(root, '.claude', 'worktrees', 'queue-fallback')
  fs.writeFileSync(path.join(wt, 'readonly.txt'), 'x')
  fs.chmodSync(path.join(wt, 'readonly.txt'), 0o444)
  const rm = cli(['worktree', 'remove', '--slug', 'fallback', '--test-fallback'], root)
  assert.equal(rm.code, 0, rm.out)
  assert.match(rm.out, /deleted /)
  assert.equal(fs.existsSync(wt), false)
  assert.ok(!sh(['worktree', 'list'], root).includes('queue-fallback'), 'git forgot the worktree')
  mainIntact(root)
})

test('safety gate: a link that is not in worktree_links stops the remove, nothing deleted', () => {
  const root = setup()
  cli(['worktree', 'create', '--slug', 'gate'], root)
  const wt = path.join(root, '.claude', 'worktrees', 'queue-gate')
  const stray = path.join(wt, 'deep', 'stray-link')
  fs.mkdirSync(path.dirname(stray), { recursive: true })
  fs.symlinkSync(path.join(root, '.venv'), stray, process.platform === 'win32' ? 'junction' : 'dir')
  const rm = cli(['worktree', 'remove', '--slug', 'gate'], root)
  assert.equal(rm.code, 1)
  assert.match(rm.out, /FAILED safety gate/)
  assert.ok(fs.existsSync(path.join(wt, 'README.md')), 'worktree left in place')
  mainIntact(root)
  // Once the stray link is gone, remove works.
  fs.unlinkSync(stray)
  assert.equal(cli(['worktree', 'remove', '--slug', 'gate'], root).code, 0)
  mainIntact(root)
})

test('bad slugs and bad link entries are refused', () => {
  const root = setup()
  for (const slug of ['', '../x', 'A-b', 'a/b', '-x', 'a'.repeat(61)]) {
    const r = cli(['worktree', 'create', '--slug', slug], root)
    assert.equal(r.code, 1, `slug '${slug}'`)
    assert.match(r.out, /FAILED/)
  }
  cli(['config', 'set', 'worktree_links', '["../outside"]'], root)
  const r = cli(['worktree', 'create', '--slug', 'escape'], root)
  assert.match(r.out, /must be a path inside the repo/)
})

test('merge worktrees: create is refused, link and remove work on one made with git', () => {
  const root = setup()
  assert.equal(cli(['worktree', 'create', '--slug', 'batch-x', '--kind', 'merge'], root).code, 1)
  const wt = path.join(root, '.claude', 'worktrees', 'merge-batch-x')
  sh(['worktree', 'add', '-q', '-b', 'batch/x', wt, 'main'], root)
  assert.equal(cli(['worktree', 'link', '--slug', 'batch-x', '--kind', 'merge'], root).code, 0)
  assert.ok(isLink(path.join(wt, '.venv')))
  const rm = cli(['worktree', 'remove', '--slug', 'batch-x', '--kind', 'merge'], root)
  assert.equal(rm.code, 0, rm.out)
  assert.match(rm.out, /target branch kept/)
  assert.equal(sh(['branch', '--list', 'batch/x'], root), 'batch/x')
  mainIntact(root)
})

test('called from inside a task worktree, commands still use the main tree', () => {
  const root = setup()
  cli(['worktree', 'create', '--slug', 'inside'], root)
  const wt = path.join(root, '.claude', 'worktrees', 'queue-inside')
  assert.equal(cli(['root'], wt).out, root)
  // The hooks find the main tree without git, through the worktree's .git file.
  const sub = path.join(wt, 'web')
  cli(['hook', 'prompt-submit'], root, JSON.stringify({ cwd: sub, session_id: 'w1', prompt: '/queue-start' }))
  assert.equal(fs.readFileSync(path.join(root, 'claude-queue', '.runner-session'), 'utf8').trim(), 'w1')
  assert.equal(cli(['lock', 'acquire'], wt).out, 'ACQUIRED')
  assert.ok(fs.existsSync(path.join(root, 'claude-queue', '.running')))
  cli(['hook', 'session-end'], root, JSON.stringify({ cwd: sub, session_id: 'w1' }))
  assert.equal(fs.existsSync(path.join(root, 'claude-queue', '.running')), false)
})
