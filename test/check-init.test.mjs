import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { globToRegExp, matches } from '../scripts/lib/check.mjs'
import { cleanup, cli, makeRepo, plainRepo, q, sh } from './helpers.mjs'

const repos = []
const repo = config => {
  const r = makeRepo(config)
  repos.push(r)
  return r
}
const bare = () => {
  const r = plainRepo()
  repos.push(r)
  return r
}
after(() => repos.forEach(cleanup))

test('globs', () => {
  assert.ok(matches('a/b/c.py', ['*.py']))
  assert.ok(matches('c.py', ['*.py']))
  assert.ok(matches('backend/app/x.py', ['backend/**/*.py']))
  assert.ok(matches('backend/x.py', ['backend/**/*.py']))
  assert.ok(!matches('frontend/x.py', ['backend/**/*.py']))
  assert.ok(matches('src/a.tsx', ['*.{ts,tsx}']))
  assert.ok(!matches('src/a.js', ['*.{ts,tsx}']))
  assert.ok(matches('docs/a.md', ['docs/**']))
  assert.ok(!globToRegExp('a?.js').test('a/.js'))
})

// The checks are small node scripts in the repo, so the commands run the same in cmd and sh.
const LINT = `
const fs = require('fs')
let bad = 0
const files = process.argv.slice(2)
if (files[0] === '--list') files.splice(0, 2, ...fs.readFileSync(files[1], 'utf8').split(/\\r?\\n/).filter(Boolean))
for (const f of files) {
  fs.readFileSync(f, 'utf8').split(/\\r?\\n/).forEach((l, i) => {
    if (l.includes('BAD')) { console.log(f + ':' + (i + 1) + ': BAD found'); bad++ }
  })
}
console.log('linted ' + files.length)
process.exit(bad ? 1 : 0)
`
const TESTS = `console.log('ran: ' + process.argv.slice(2).join(' ')); process.exit(process.env.FAIL_TESTS ? 1 : 0)`
const SLOW = `setTimeout(() => { console.log('slow done'); process.exit(0) }, 4000)`

function checkRepo(extra = {}, config = {}) {
  const root = repo({
    checks: {
      changed: [
        { name: 'lint', when: ['src/**/*.js'], run: 'node ../tools/lint.js {files}', cwd: 'src' },
        { name: 'lint-new', when: ['src/**/*.js'], run: 'node tools/lint.js {files}', changed_lines_only: true },
        { name: 'tests', when: ['src/**'], run: 'node tools/tests.js {tests}', default_tests: 'tests' },
        { name: 'docs', when: ['docs/*.md'], run: 'node -e "process.exit(1)"' },
      ],
      full: [{ name: 'suite', run: 'node tools/tests.js everything' }],
      ...extra,
    },
    ...config,
  })
  fs.mkdirSync(path.join(root, 'tools'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'tests'))
  fs.writeFileSync(path.join(root, 'tools', 'lint.js'), LINT)
  fs.writeFileSync(path.join(root, 'tools', 'tests.js'), TESTS)
  fs.writeFileSync(path.join(root, 'tools', 'slow.js'), SLOW)
  fs.writeFileSync(path.join(root, 'tests', 'a.test.js'), '')
  fs.writeFileSync(path.join(root, 'src', 'old.js'), 'line1\nBAD old error\nline3\n')
  sh(['add', '-A'], root)
  sh(['commit', '-q', '-m', 'base'], root)
  cli(['worktree', 'create', '--slug', 'work'], root)
  return { root, wt: path.join(root, '.claude', 'worktrees', 'queue-work') }
}

test('check: nothing changed passes and says so, measured from the recorded base', () => {
  const { root, wt } = checkRepo()
  const r = cli(['check', '--worktree', wt], root)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /base: [0-9a-f]{9} \(recorded when the task started, from main\)/)
  assert.match(r.out, /nothing to check/)
  assert.match(r.out, /RESULT PASS/)
})

test('check: runs only matching checks, on changed files, untracked included', () => {
  const { root, wt } = checkRepo()
  fs.writeFileSync(path.join(wt, 'src', 'new.js'), 'ok\n')
  const r = cli(['check', '--worktree', wt], root)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /lint\s+PASS/)
  assert.match(r.out, /tests\s+PASS/)
  assert.doesNotMatch(r.out, /docs/)
})

test('check: a plain check fails on exit code and prints the output', () => {
  const { root, wt } = checkRepo()
  fs.appendFileSync(path.join(wt, 'src', 'old.js'), 'more\n')
  const r = cli(['check', '--worktree', wt], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /lint\s+FAIL/)
  assert.match(r.out, /old\.js:2: BAD found/)
  assert.match(r.out, /RESULT FAIL/)
})

test('check: changed_lines_only ignores old errors and catches new ones', () => {
  const { root, wt } = checkRepo({})
  fs.appendFileSync(path.join(wt, 'src', 'old.js'), 'fine\n')
  let r = cli(['check', '--worktree', wt], root)
  assert.match(r.out, /lint-new\s+PASS\s+0 on changed lines, 1 elsewhere/)
  fs.appendFileSync(path.join(wt, 'src', 'old.js'), 'BAD new\n')
  r = cli(['check', '--worktree', wt], root)
  assert.match(r.out, /lint-new\s+FAIL\s+1 on changed lines, 1 elsewhere/)
  assert.match(r.out, /old\.js:5: BAD found/)
})

test('check: {tests} takes --tests, falls back to default_tests, fails on a missing path', () => {
  const { root, wt } = checkRepo()
  fs.writeFileSync(path.join(wt, 'src', 'x.js'), 'ok\n')
  let r = cli(['check', '--worktree', wt, '--tests', 'tests/a.test.js'], root)
  assert.match(r.out, /tests\s+PASS/)
  r = cli(['check', '--worktree', wt, '--tests', 'tests/a.test.js,tests/nope.js'], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /path not found \(relative to \.\): tests\/nope\.js/)
})

test('check: with no tests named, a test check runs nothing and says "no tests run"', () => {
  const { root, wt } = checkRepo({
    changed: [{ name: 'tests', when: ['src/**'], run: 'node tools/tests.js {tests}' }],
  })
  fs.writeFileSync(path.join(wt, 'src', 'x.js'), 'ok\n')
  const r = cli(['check', '--worktree', wt], root, undefined, { FAIL_TESTS: '1' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /tests\s+SKIP\s+no tests run: none named/)
  assert.match(r.out, /NOTE no tests run/)
  assert.doesNotMatch(r.out, /ran:/)
})

test('check: --base and a branch off another branch count only their own changes', () => {
  const { root, wt } = checkRepo()
  fs.appendFileSync(path.join(wt, 'src', 'old.js'), 'BAD x\n')
  sh(['add', '-A'], wt)
  sh(['commit', '-q', '-m', 'bad'], wt)
  const r = cli(['check', '--worktree', wt, '--base', 'queue/work'], root)
  assert.match(r.out, /base: [0-9a-f]{9} \(--base queue\/work\)/)
  assert.match(r.out, /changed: 0 files/)
  assert.equal(r.code, 0)
})

test('check: a task started on a batch branch is measured from where it started', () => {
  const { root } = checkRepo()
  sh(['branch', 'batch/one', 'main'], root)
  const batch = path.join(root, '.claude', 'worktrees', 'merge-one')
  sh(['worktree', 'add', '-q', batch, 'batch/one'], root)
  fs.writeFileSync(path.join(batch, 'src', 'batch.js'), 'BAD from the batch\n')
  sh(['add', '-A'], batch)
  sh(['commit', '-q', '-m', 'batch work'], batch)
  sh(['worktree', 'remove', batch], root)
  assert.match(cli(['worktree', 'create', '--slug', 'dependent', '--base', 'batch/one'], root).out, /BASE [0-9a-f]+ \(batch\/one\)/)
  const wt = path.join(root, '.claude', 'worktrees', 'queue-dependent')
  fs.writeFileSync(path.join(wt, 'src', 'mine.js'), 'ok\n')
  const r = cli(['check', '--worktree', wt], root)
  assert.match(r.out, /from batch\/one/)
  assert.match(r.out, /changed: 1 file\b/, 'the batch commit is not counted as this task\'s change')
  assert.equal(r.code, 0, r.out)
})

test('check: check_env reaches every check, with {worktree} and {root} replaced', () => {
  const { root, wt } = checkRepo(
    { changed: [{ name: 'env', when: ['src/**'], run: 'node -e "console.log(process.env.QX); process.exit(1)"' }] },
    { check_env: { QX: '{worktree}/src|{root}' } },
  )
  fs.writeFileSync(path.join(wt, 'src', 'x.js'), 'ok\n')
  const r = cli(['check', '--worktree', wt], root)
  assert.ok(r.out.includes(`${wt}/src|${root}`), r.out)
})

test('check: an import check that resolves outside the worktree fails loudly, before any check', () => {
  const where = 'node -e "console.log(process.env.PKG_HOME || require(\'path\').resolve(\'../../..\', \'src\'))"'
  const { root, wt } = checkRepo({}, { import_checks: [{ name: 'package', run: where, cwd: 'src' }] })
  fs.writeFileSync(path.join(wt, 'src', 'x.js'), 'ok\n')
  let r = cli(['check', '--worktree', wt], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /package\s+FAIL\s+IMPORTS RESOLVE OUTSIDE THE WORKTREE/)
  assert.doesNotMatch(r.out, /lint\s+PASS/, 'no check ran')
  cli(['config', 'set', 'check_env', '{"PKG_HOME":"{worktree}/src"}'], root)
  r = cli(['check', '--worktree', wt], root)
  assert.match(r.out, /package\s+PASS\s+imports from the worktree: src/)
  assert.equal(r.code, 0, r.out)
})

test('check: a long {files} list is split over several runs, {files_file} gets a list file', () => {
  const { root, wt } = checkRepo({
    changed: [
      { name: 'lint', when: ['src/**/*.js'], run: 'node tools/lint.js {files}' },
      { name: 'lint-list', when: ['src/**/*.js'], run: 'node tools/lint.js --list {files_file}' },
    ],
  })
  fs.mkdirSync(path.join(wt, 'src', 'many'))
  const n = 300
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(wt, 'src', 'many', `a-rather-long-file-name-number-${i}.js`), 'ok\n')
  const r = cli(['check', '--worktree', wt], root)
  assert.equal(r.code, 0, r.out)
  if (process.platform === 'win32') assert.match(r.out, /lint\s+PASS\s+\d+ changed files, \d+s in \d+ runs/)
  assert.match(r.out, /lint-list\s+PASS/)
})

test('check --full runs the full suite in the background and reports it', () => {
  const { root, wt } = checkRepo()
  const r = cli(['check', '--worktree', wt, '--full'], root)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /full suite started in the background: full-/)
  assert.match(r.out, /suite\s+PASS/)
  const log = /log: (.+\.log)/.exec(r.out)[1]
  assert.match(fs.readFileSync(log, 'utf8'), /ran: everything/)
})

test('check --full that outlasts the wait says how to wait again, and --wait gets the result', () => {
  const { root, wt } = checkRepo({ full: [{ name: 'slow', run: 'node tools/slow.js' }] })
  const r = cli(['check', '--worktree', wt, '--full', '--wait-minutes', '0.02'], root)
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /RUNNING full-/)
  const id = /check --wait (full-[0-9-]+)/.exec(r.out)[1]
  const done = cli(['check', '--wait', id], root)
  assert.equal(done.code, 0, done.out)
  assert.match(done.out, /slow\s+PASS/)
})

test('check without configured checks passes and says how to add them', () => {
  const root = repo()
  const r = cli(['check', '--worktree', root], root)
  assert.match(r.out, /no checks configured/)
  assert.equal(r.code, 0)
})

// ---- init --------------------------------------------------------------------------------

const exclude = root => fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8')

test('init: creates .claude/queue/, writes only .git/info/exclude, changes no tracked file', () => {
  const root = bare()
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n')
  sh(['add', 'AGENTS.md'], root)
  sh(['commit', '-q', '-m', 'agents'], root)
  const r = cli(['init', '--preset', 'mixed'], root)
  assert.equal(r.code, 0, r.out)
  const cfg = JSON.parse(fs.readFileSync(q(root, 'config.json'), 'utf8'))
  assert.equal(cfg.max_workers, 4)
  assert.equal(cfg.base_branch, 'main')
  assert.equal(cfg.safety_hooks, true)
  assert.equal(cfg.checks.changed[0].name, 'ruff')
  assert.ok(cfg.worktree_links.includes('frontend/node_modules'))
  assert.match(fs.readFileSync(q(root, 'queue.md'), 'utf8'), /^---\n\[notes\]/)
  assert.ok(fs.existsSync(q(root, 'log.md')))
  assert.ok(fs.existsSync(q(root, 'merged.md')))
  assert.match(exclude(root), /^\/\.claude\/queue\/$/m)
  assert.match(exclude(root), /^\/\.claude\/worktrees\/$/m)
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false, 'no CLAUDE.md is created')
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.venv/\nnode_modules/\n.env\n')
  assert.equal(sh(['status', '--porcelain'], root), '', 'nothing for git to see')

  // A second run, even with another preset, changes nothing at all.
  fs.writeFileSync(q(root, 'queue.md'), 'kept\n')
  const cfgText = fs.readFileSync(q(root, 'config.json'), 'utf8')
  const ex = exclude(root)
  for (let i = 0; i < 2; i++) {
    const again = cli(['init', '--preset', 'node'], root)
    assert.equal(again.code, 0, again.out)
    assert.equal(again.out, `ALREADY INITIALIZED ${q(root)}`)
  }
  assert.equal(fs.readFileSync(q(root, 'config.json'), 'utf8'), cfgText)
  assert.equal(fs.readFileSync(q(root, 'queue.md'), 'utf8'), 'kept\n')
  assert.equal(exclude(root), ex)
})

test('init asks git: folders already ignored by any rule are not added again', () => {
  const root = bare()
  fs.appendFileSync(path.join(root, '.gitignore'), '.claude/\n')
  sh(['commit', '-q', '-am', 'ignore .claude'], root)
  const before = exclude(root)
  const r = cli(['init'], root)
  assert.match(r.out, /kept \.git\/info\/exclude \(git already ignores both folders\)/)
  assert.equal(exclude(root), before)
})

test('init in a set-up repo names what is missing and restores none of it', () => {
  const root = bare()
  fs.mkdirSync(q(root), { recursive: true })
  fs.writeFileSync(q(root, 'config.json'), '{}')
  const r = cli(['init'], root)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.out.split(/\r?\n/), [
    `ALREADY INITIALIZED ${q(root)}`,
    'missing .claude/queue/queue.md',
    'missing .claude/queue/log.md',
    'missing .claude/queue/merged.md',
    'missing /.claude/queue/ in .git/info/exclude (git does not ignore it)',
    'missing /.claude/worktrees/ in .git/info/exclude (git does not ignore it)',
  ])
  assert.deepEqual(fs.readdirSync(q(root)), ['config.json'])
  assert.doesNotMatch(exclude(root), /claude/)
})

test('init moves a 0.1 claude-queue/ to .claude/queue/ and leaves the tracked files alone', () => {
  const root = bare()
  const legacy = path.join(root, 'claude-queue')
  fs.mkdirSync(path.join(legacy, 'research-1'), { recursive: true })
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ models: { worker: 'opus', small_task: 'sonnet' } }))
  fs.writeFileSync(path.join(legacy, 'queue.md'), '---\n[held] Keep me\n---\n')
  fs.writeFileSync(path.join(legacy, 'research-1', 'notes.md'), 'found it')
  fs.writeFileSync(path.join(legacy, '.running'), 'old\n')
  const t = new Date(Date.now() - 10 * 3600 * 1000)
  fs.utimesSync(path.join(legacy, '.running'), t, t)
  fs.appendFileSync(path.join(root, '.gitignore'), '/claude-queue/\n')
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Rules\n\n## Task queue (task-queue plugin)\n\nOld note.\n')
  sh(['add', '-A'], root)
  sh(['commit', '-q', '-m', 'old setup'], root)
  const tracked = ['.gitignore', 'CLAUDE.md'].map(f => fs.readFileSync(path.join(root, f), 'utf8'))

  const r = cli(['init'], root)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /moved claude-queue\/ to \.claude\/queue\//)
  assert.match(r.out, /left as is: the \/claude-queue\/ line in \.gitignore/)
  assert.match(r.out, /left as is: the "Task queue \(task-queue plugin\)" section in CLAUDE\.md/)
  assert.match(r.out, /MIGRATED/)
  assert.equal(fs.existsSync(legacy), false)
  assert.equal(fs.readFileSync(q(root, 'queue.md'), 'utf8'), '---\n[held] Keep me\n---\n')
  assert.equal(fs.readFileSync(q(root, 'research-1', 'notes.md'), 'utf8'), 'found it')
  assert.equal(fs.existsSync(q(root, '.running')), false, 'the old lock is not carried over')
  assert.deepEqual(['.gitignore', 'CLAUDE.md'].map(f => fs.readFileSync(path.join(root, f), 'utf8')), tracked)
  assert.equal(sh(['status', '--porcelain'], root), '')
  assert.match(cli(['init'], root).out, /^ALREADY INITIALIZED/)
})

test('init does not move a 0.1 queue while its coordinator holds the lock', () => {
  const root = bare()
  const legacy = path.join(root, 'claude-queue')
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, 'config.json'), '{}')
  fs.writeFileSync(path.join(legacy, '.running'), 'now\n')
  const r = cli(['init'], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /holds the lock.*queue-close/)
  assert.ok(fs.existsSync(path.join(legacy, 'config.json')))
  assert.equal(fs.existsSync(q(root)), false)
})

test('init refuses an unknown preset', () => {
  const root = bare()
  const r = cli(['init', '--preset', 'cobol'], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /unknown preset/)
})
