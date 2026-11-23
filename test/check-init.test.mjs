import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { globToRegExp, matches } from '../scripts/lib/check.mjs'
import { cleanup, cli, makeRepo, sh } from './helpers.mjs'

const repos = []
const repo = config => {
  const r = makeRepo(config)
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
for (const f of process.argv.slice(2)) {
  fs.readFileSync(f, 'utf8').split(/\\r?\\n/).forEach((l, i) => {
    if (l.includes('BAD')) { console.log(f + ':' + (i + 1) + ': BAD found'); bad++ }
  })
}
process.exit(bad ? 1 : 0)
`
const TESTS = `console.log('ran: ' + process.argv.slice(2).join(' ')); process.exit(process.env.FAIL_TESTS ? 1 : 0)`

function checkRepo(extra = {}) {
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
  })
  fs.mkdirSync(path.join(root, 'tools'))
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'tests'))
  fs.writeFileSync(path.join(root, 'tools', 'lint.js'), LINT)
  fs.writeFileSync(path.join(root, 'tools', 'tests.js'), TESTS)
  fs.writeFileSync(path.join(root, 'tests', 'a.test.js'), '')
  fs.writeFileSync(path.join(root, 'src', 'old.js'), 'line1\nBAD old error\nline3\n')
  sh(['add', '-A'], root)
  sh(['commit', '-q', '-m', 'base'], root)
  cli(['worktree', 'create', '--slug', 'work'], root)
  return { root, wt: path.join(root, '.claude', 'worktrees', 'queue-work') }
}

test('check: nothing changed passes and says so', () => {
  const { root, wt } = checkRepo()
  const r = cli(['check', '--worktree', wt], root)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /base: main \(main tree's branch\)/)
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

test('check: --base and a branch off another branch count only their own changes', () => {
  const { root, wt } = checkRepo()
  fs.appendFileSync(path.join(wt, 'src', 'old.js'), 'BAD x\n')
  sh(['add', '-A'], wt)
  sh(['commit', '-q', '-m', 'bad'], wt)
  const r = cli(['check', '--worktree', wt, '--base', 'queue/work'], root)
  assert.match(r.out, /base: queue\/work \(--base\)/)
  assert.match(r.out, /changed: 0 files/)
  assert.equal(r.code, 0)
})

test('check --full runs the full suite commands', () => {
  const { root, wt } = checkRepo()
  let r = cli(['check', '--worktree', wt, '--full'], root)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /suite\s+PASS/)
})

test('check without configured checks passes and says how to add them', () => {
  const root = repo()
  const r = cli(['check', '--worktree', root], root)
  assert.match(r.out, /no checks configured/)
  assert.equal(r.code, 0)
})

test('init: dry run on a fresh repo, then a second run keeps everything', () => {
  const root = repo()
  fs.rmSync(path.join(root, 'claude-queue'), { recursive: true })
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/')
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Project\n\nRules.')
  const r = cli(['init', '--preset', 'mixed'], root)
  assert.equal(r.code, 0, r.out)
  const q = path.join(root, 'claude-queue')
  const cfg = JSON.parse(fs.readFileSync(path.join(q, 'config.json'), 'utf8'))
  assert.equal(cfg.max_workers, 4)
  assert.equal(cfg.base_branch, 'main')
  assert.equal(cfg.checks.changed[0].name, 'ruff')
  assert.ok(cfg.worktree_links.includes('frontend/node_modules'))
  assert.match(fs.readFileSync(path.join(q, 'queue.md'), 'utf8'), /^---\n\[notes\]/)
  assert.ok(fs.existsSync(path.join(q, 'log.md')))
  assert.ok(fs.existsSync(path.join(q, 'merged.md')))
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  assert.match(gi, /^node_modules\/\n/)
  assert.match(gi, /\/claude-queue\//)
  assert.match(gi, /\/\.claude\/worktrees\//)
  const md = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')
  assert.match(md, /^# Project\n\nRules\.\n\n## Task queue/)

  fs.writeFileSync(path.join(q, 'queue.md'), 'kept\n')
  const again = cli(['init'], root)
  assert.match(again.out, /kept claude-queue\/config\.json/)
  assert.equal(fs.readFileSync(path.join(q, 'queue.md'), 'utf8'), 'kept\n')
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), md)
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), gi)
  assert.equal(sh(['status', '--porcelain', '--', 'claude-queue'], root), '', 'claude-queue/ is ignored')
})

test('init refuses an unknown preset', () => {
  const root = repo()
  fs.rmSync(path.join(root, 'claude-queue'), { recursive: true })
  const r = cli(['init', '--preset', 'cobol'], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /unknown preset/)
})
