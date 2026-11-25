import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { cleanup, cli, gitTry, makeRepo, q, sh, writeQueue } from './helpers.mjs'

const repos = []
after(() => repos.forEach(cleanup))

// A repo whose main tree has a .venv folder, a nested node_modules folder and a .env file, all
// ignored, and a secrets.json that is not.
function setup() {
  const root = makeRepo({ worktree_links: ['.venv', 'web/node_modules', '.env', 'secrets.json', 'missing'] })
  repos.push(root)
  fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, '.venv', 'bin', 'keep.txt'), 'main venv')
  fs.mkdirSync(path.join(root, 'web', 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'node_modules', 'pkg', 'index.js'), 'main pkg')
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n')
  fs.writeFileSync(path.join(root, 'secrets.json'), '{"key":"x"}\n')
  return root
}

const wtOf = (root, slug) => path.join(root, '.claude', 'worktrees', `queue-${slug}`)
const isLink = p => fs.lstatSync(p).isSymbolicLink()
const mainIntact = root => {
  assert.equal(fs.readFileSync(path.join(root, '.venv', 'bin', 'keep.txt'), 'utf8'), 'main venv')
  assert.equal(fs.readFileSync(path.join(root, 'web', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'main pkg')
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'A=1\n')
}

test('create links what git ignores, refuses what it does not, records the base; remove keeps the branch', () => {
  const root = setup()
  const r = cli(['worktree', 'create', '--slug', 'billing-totals'], root)
  assert.equal(r.code, 0, r.out)
  const wt = wtOf(root, 'billing-totals')
  assert.match(r.out, /CREATED .* on queue\/billing-totals/)
  assert.match(r.out, /not linked: secrets\.json \(git does not ignore it/)
  assert.match(r.out, /BASE [0-9a-f]{40} \(main\)/)
  assert.match(r.out, /commit guard on/)
  assert.ok(isLink(path.join(wt, '.venv')))
  assert.ok(isLink(path.join(wt, 'web', 'node_modules')))
  assert.ok(!isLink(path.join(wt, '.env')))
  assert.equal(fs.existsSync(path.join(wt, 'secrets.json')), false)
  assert.equal(fs.readFileSync(path.join(wt, '.venv', 'bin', 'keep.txt'), 'utf8'), 'main venv')
  const record = JSON.parse(fs.readFileSync(q(root, 'tasks', 'billing-totals.json'), 'utf8'))
  assert.equal(record.base, sh(['rev-parse', 'main'], root))
  assert.equal(cli(['worktree', 'path', '--slug', 'billing-totals'], root).out, wt)

  // Uncommitted work is never deleted without --discard.
  fs.writeFileSync(path.join(wt, 'feature.txt'), 'work')
  fs.appendFileSync(path.join(wt, 'README.md'), 'more\n')
  let rm = cli(['worktree', 'remove', '--slug', 'billing-totals'], root)
  assert.equal(rm.code, 1)
  assert.match(rm.out, /has uncommitted changes, nothing deleted/)
  assert.match(rm.out, /^ {2}\?\? feature\.txt$/m)
  assert.match(rm.out, /^ {2} M README\.md$/m)
  assert.ok(fs.existsSync(path.join(wt, 'feature.txt')))
  sh(['checkout', '--', 'README.md'], wt)
  sh(['add', 'feature.txt'], wt)
  sh(['commit', '-q', '-m', 'work'], wt)

  rm = cli(['worktree', 'remove', '--slug', 'billing-totals'], root)
  assert.equal(rm.code, 0, rm.out)
  assert.match(rm.out, /unlinked \.venv/)
  assert.match(rm.out, /REMOVED .*branch queue\/billing-totals kept/)
  assert.equal(fs.existsSync(wt), false)
  assert.equal(sh(['branch', '--list', 'queue/billing-totals'], root), 'queue/billing-totals')
  mainIntact(root)
  assert.equal(cli(['worktree', 'remove', '--slug', 'billing-totals'], root).out, 'ABSENT')
})

test('an existing branch is reused only with --resume, for the task whose branch it is', () => {
  const root = setup()
  cli(['worktree', 'create', '--slug', 'export'], root)
  const wt = wtOf(root, 'export')
  fs.writeFileSync(path.join(wt, 'feature.txt'), 'work')
  sh(['add', 'feature.txt'], wt)
  sh(['commit', '-q', '-m', 'WIP: export'], wt)
  cli(['worktree', 'remove', '--slug', 'export'], root)
  const base = JSON.parse(fs.readFileSync(q(root, 'tasks', 'export.json'), 'utf8')).base

  let r = cli(['worktree', 'create', '--slug', 'export'], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /branch queue\/export already exists. A new task needs a title that differs/)
  r = cli(['worktree', 'create', '--slug', 'export', '--resume'], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /no task in queue\.md has "> branch: queue\/export"/)

  writeQueue(root, ['[paused] Export', '> branch: queue/export', 'Export it.'])
  r = cli(['worktree', 'create', '--slug', 'export', '--resume'], root)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /RESUMED .* on queue\/export/)
  assert.match(r.out, new RegExp(`BASE ${base}`), 'the recorded base is kept')
  assert.equal(fs.readFileSync(path.join(wt, 'feature.txt'), 'utf8'), 'work')
  assert.match(cli(['worktree', 'create', '--slug', 'export', '--resume'], root).out, /^EXISTS /m)
})

test('the commit guard refuses .env files and linked files, and runs the repo\'s own hook', () => {
  const root = setup()
  const ran = path.join(root, 'repo-hook-ran.txt')
  const own = path.join(root, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(own, `#!/bin/sh\necho ran > "${ran.replace(/\\/g, '/')}"\nexit 0\n`)
  fs.chmodSync(own, 0o755)
  cli(['worktree', 'create', '--slug', 'guard'], root)
  const wt = wtOf(root, 'guard')

  sh(['add', '-f', '.env'], wt)
  let c = gitTry(['commit', '-m', 'oops'], wt)
  assert.notEqual(c.code, 0)
  assert.match(c.err, /refused to commit \.env files or files linked from the main tree/)
  assert.match(c.err, /^ {2}\.env$/m)
  sh(['restore', '--staged', '.env'], wt)

  fs.mkdirSync(path.join(wt, 'conf'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'conf', '.env.production'), 'SECRET=1\n')
  sh(['add', '-f', 'conf/.env.production'], wt)
  c = gitTry(['commit', '-m', 'oops'], wt)
  assert.notEqual(c.code, 0)
  assert.match(c.err, /conf\/\.env\.production/)
  sh(['restore', '--staged', 'conf/.env.production'], wt)

  fs.writeFileSync(path.join(wt, '.env.example'), 'SECRET=\n')
  fs.writeFileSync(path.join(wt, 'feature.txt'), 'work\n')
  sh(['add', '-f', '.env.example', 'feature.txt'], wt)
  c = gitTry(['commit', '-m', 'feature'], wt)
  assert.equal(c.code, 0, c.err)
  assert.ok(fs.existsSync(ran), "the repository's own pre-commit hook ran")

  // The main tree keeps its own hooks and no guard.
  assert.equal(gitTry(['config', '--get', 'core.hooksPath'], root).out, '')
})

test('the fallback delete (git skipped) removes the folder without reaching through links', () => {
  const root = setup()
  cli(['worktree', 'create', '--slug', 'fallback'], root)
  const wt = wtOf(root, 'fallback')
  fs.writeFileSync(path.join(wt, 'readonly.txt'), 'x')
  fs.chmodSync(path.join(wt, 'readonly.txt'), 0o444)
  const rm = cli(['worktree', 'remove', '--slug', 'fallback', '--test-fallback', '--discard'], root)
  assert.equal(rm.code, 0, rm.out)
  assert.match(rm.out, /deleted /)
  assert.equal(fs.existsSync(wt), false)
  assert.ok(!sh(['worktree', 'list'], root).includes('queue-fallback'), 'git forgot the worktree')
  mainIntact(root)
})

test('safety gate: a link that is not in worktree_links stops the remove, nothing deleted', () => {
  const root = setup()
  cli(['worktree', 'create', '--slug', 'gate'], root)
  const wt = wtOf(root, 'gate')
  const stray = path.join(wt, 'deep', 'stray-link')
  fs.mkdirSync(path.dirname(stray), { recursive: true })
  fs.symlinkSync(path.join(root, '.venv'), stray, process.platform === 'win32' ? 'junction' : 'dir')
  const rm = cli(['worktree', 'remove', '--slug', 'gate', '--discard'], root)
  assert.equal(rm.code, 1)
  assert.match(rm.out, /FAILED safety gate/)
  assert.ok(fs.existsSync(path.join(wt, 'README.md')), 'worktree left in place')
  mainIntact(root)
  // Once the stray link is gone, remove works.
  fs.unlinkSync(stray)
  assert.equal(cli(['worktree', 'remove', '--slug', 'gate', '--discard'], root).code, 0)
  mainIntact(root)
})

test('remove --discard throws uncommitted work away; a missing --slug says so', () => {
  const root = setup()
  cli(['worktree', 'create', '--slug', 'scratch'], root)
  fs.writeFileSync(path.join(wtOf(root, 'scratch'), 'tmp.txt'), 'x')
  const rm = cli(['worktree', 'remove', '--slug', 'scratch', '--discard'], root)
  assert.equal(rm.code, 0, rm.out)
  assert.match(rm.out, /discarding 1 uncommitted change/)
  assert.equal(fs.existsSync(wtOf(root, 'scratch')), false)
  const r = cli(['worktree', 'create', 'multiply-helper'], root)
  assert.equal(r.code, 1)
  assert.equal(r.out, 'FAILED worktree create needs --slug <slug> (write --slug multiply-helper)')
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
  const wt = wtOf(root, 'inside')
  assert.equal(cli(['root'], wt).out, root)
  assert.equal(cli(['lock', 'acquire'], wt, undefined, { CLAUDE_CODE_SESSION_ID: 'w1' }).out, 'ACQUIRED')
  assert.ok(fs.existsSync(q(root, '.running')))
  // The hooks find the main tree without git, through the worktree's .git file.
  cli(['hook', 'session-end'], root, JSON.stringify({ cwd: path.join(wt, 'web'), session_id: 'w1' }))
  assert.equal(fs.existsSync(q(root, '.running')), false)
})
