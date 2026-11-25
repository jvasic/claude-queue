// check: runs the configured checks on a worktree and prints a short summary, never full logs.
//
// "Changed" means committed on the branch plus uncommitted plus untracked, against the commit
// the task started from (recorded by `worktree create`). Without a record (a merge worktree,
// a branch made by hand) it is the merge base with --base, else with the branch checked out
// in the main tree, else with base_branch.
//
// Before any check, import_checks run: each prints where the code under test is imported
// from, and a path outside the worktree fails everything at once (a package installed in
// editable mode from the main tree would otherwise be what the tests exercise).
//
// checks.changed entries:
//   name                text shown in the summary
//   when                file patterns; the check runs when a changed file matches one
//   run                 the command, run through the shell. Placeholders:
//                         {files}       the matching changed files that still exist, relative
//                                       to cwd; a list too long for one command line is split
//                                       over several runs
//                         {files_file}  a file listing those files, one per line
//                         {tests}       the --tests paths, else default_tests. With neither,
//                                       the check does not run and says "no tests run"
//   cwd                 folder to run in, relative to the worktree (default ".")
//   default_tests       what {tests} becomes when --tests is not given
//   changed_lines_only  true: fail only on "path:line:" output lines that sit on changed
//                       lines, for linters in repos that carry old errors
//   timeout_minutes     default 30
// checks.full entries (only with --full): name, run, cwd, timeout_minutes. The full suite runs
// in the background, writing to .claude/queue/runs/<id>.log; the command waits for it up to
// --wait-minutes (default 8, below the shell tool's limit) and, if it is still running, says
// how to wait again: `check --wait <id>`.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from './config.mjs'
import { QueueError, currentBranch, exists, git, isInside, queueDir, toPosix } from './repo.mjs'
import { readRecord, slugOf } from './worktree.mjs'

const DETAIL_LINES = 40
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'queue.mjs')
// cmd.exe takes at most 8,191 characters; leave room for what the shell adds.
const MAX_COMMAND = process.platform === 'win32' ? 7000 : 100000

// Glob to RegExp. A pattern without "/" matches the file name in any folder, as in .gitignore.
export function globToRegExp(pattern) {
  let p = pattern.replace(/\\/g, '/')
  if (!p.includes('/')) p = '**/' + p
  if (p.startsWith('/')) p = p.slice(1)
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = p.indexOf('}', i)
      if (end === -1) re += '\\{'
      else {
        re += '(?:' + p.slice(i + 1, end).split(',').map(escape).join('|') + ')'
        i = end
      }
    } else re += escape(c)
  }
  return new RegExp('^' + re + '$')
}

function escape(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

export function matches(file, patterns) {
  return patterns.some(p => globToRegExp(p).test(file))
}

// Changed files and the changed line numbers per file, against the base commit.
export function changes(wt, mergeBase) {
  const lines = s => s.split(/\r?\n/).filter(x => x !== '')
  const diffNames = lines(git(['-c', 'core.quotePath=false', 'diff', '--name-only', mergeBase], wt).out)
  const untracked = lines(
    git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], wt).out,
  )
  const files = [...new Set([...diffNames, ...untracked])].sort()
  const changedLines = new Map()
  let current = null
  for (const l of git(['-c', 'core.quotePath=false', 'diff', '-U0', mergeBase], wt).out.split(/\r?\n/)) {
    const head = /^\+\+\+ b\/(.+)$/.exec(l)
    if (head) {
      current = head[1]
      if (!changedLines.has(current)) changedLines.set(current, new Set())
      continue
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l)
    if (current && hunk) {
      const start = Number(hunk[1])
      const n = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let i = start; i < start + n; i++) changedLines.get(current).add(i)
    }
  }
  return { files, untracked: new Set(untracked), changedLines }
}

function quote(arg) {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`
}

// The environment checks run in: the venv's bin first on PATH, then check_env with {worktree}
// and {root} replaced.
export function checkEnv(root, wt, cfg) {
  const env = { ...process.env }
  if (cfg.venv) {
    for (const base of [wt, root]) {
      const dir = path.join(base, cfg.venv)
      const bin = path.join(dir, process.platform === 'win32' ? 'Scripts' : 'bin')
      if (exists(bin)) {
        const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
        env[key] = bin + path.delimiter + (env[key] ?? '')
        env.VIRTUAL_ENV = dir
        break
      }
    }
  }
  for (const [k, v] of Object.entries(cfg.check_env ?? {})) {
    env[k] = String(v).replaceAll('{worktree}', wt).replaceAll('{root}', root)
  }
  return env
}

function run(command, cwd, env, timeoutMinutes) {
  const started = Date.now()
  const r = spawnSync(command, {
    cwd,
    env,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: (timeoutMinutes ?? 30) * 60 * 1000,
    windowsHide: true,
  })
  const secs = Math.round((Date.now() - started) / 1000)
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const out = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (r.error) out.push(`could not run: ${r.error.message}`)
  return { code: r.error ? -1 : (r.status ?? -1), secs, out }
}

// Runs a command with its output going straight into the log file, so the log can be followed
// while it runs. Returns the output lines it wrote.
function runToLog(command, cwd, env, timeoutMinutes, log) {
  const started = Date.now()
  const from = fs.statSync(log).size
  const fd = fs.openSync(log, 'a')
  let r
  try {
    r = spawnSync(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', fd, fd],
      timeout: (timeoutMinutes ?? 30) * 60 * 1000,
      windowsHide: true,
    })
  } finally {
    fs.closeSync(fd)
  }
  const secs = Math.round((Date.now() - started) / 1000)
  const text = fs.readFileSync(log).subarray(from).toString('utf8')
  const out = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (r.error) out.push(`could not run: ${r.error.message}`)
  return { code: r.error ? -1 : (r.status ?? -1), secs, out }
}

// Runs a command whose {files} list may not fit one command line: split into as many runs as
// needed, each with as many files as fit. The results are joined.
function runWithFiles(template, files, cwd, env, timeoutMinutes) {
  const quoted = files.map(quote)
  const room = MAX_COMMAND - template.replaceAll('{files}', '').length
  const chunks = [[]]
  let used = 0
  for (const q of quoted) {
    const cur = chunks[chunks.length - 1]
    if (cur.length > 0 && used + q.length + 1 > room) {
      chunks.push([])
      used = 0
    }
    chunks[chunks.length - 1].push(q)
    used += q.length + 1
  }
  const total = { code: 0, secs: 0, out: [], runs: chunks.length }
  for (const c of chunks) {
    const r = run(template.replaceAll('{files}', c.join(' ')), cwd, env, timeoutMinutes)
    total.secs += r.secs
    total.out.push(...r.out)
    if (r.code !== 0 && total.code === 0) total.code = r.code
  }
  return total
}

// "path:line:" at the start of an output line, a Windows drive letter allowed.
const LOCATION = /^\s*((?:[A-Za-z]:)?[^:\s][^:]*):(\d+)[:,\s]/

function onChangedLine(line, cwdAbs, wt, ch) {
  const m = LOCATION.exec(line)
  if (!m) return null
  const rel = toPosix(path.relative(wt, path.resolve(cwdAbs, m[1])))
  const n = Number(m[2])
  return ch.untracked.has(rel) || (ch.changedLines.get(rel)?.has(n) ?? false)
}

function show(print, name, state, note, detail = []) {
  print(`${name.padEnd(12)} ${state}  ${note}`)
  for (const l of detail.slice(0, DETAIL_LINES)) print(`    ${l}`)
  if (detail.length > DETAIL_LINES) print(`    ... ${detail.length - DETAIL_LINES} more lines`)
}

// A test named by path (with an optional pytest "::name"), or by dotted module name as
// unittest takes it (tests.test_api, tests.test_api.TestX.test_y): some prefix of the dots
// must name a folder or a .py file.
function testExists(cwdAbs, name) {
  const file = name.split('::')[0]
  if (exists(path.resolve(cwdAbs, file))) return true
  if (/[\\/]/.test(file) || !file.includes('.')) return false
  // The longest prefix that is a module file wins (the rest are a class and a method); a
  // folder counts only as the whole name (a package).
  const parts = file.split('.')
  if (exists(path.resolve(cwdAbs, ...parts))) return true
  for (let n = parts.length; n > 0; n--) {
    if (exists(`${path.resolve(cwdAbs, ...parts.slice(0, n))}.py`)) return true
  }
  return false
}

function splitTests(tests) {
  return (tests ?? [])
    .flatMap(t => String(t).split(/[,\s]+/))
    .map(t => t.replace(/^['"]|['"]$/g, ''))
    .filter(t => t !== '')
}

// Runs import_checks. Returns false (after printing why) when one fails or points outside.
export function importsInside(cfg, wt, env, print) {
  let ok = true
  for (const c of cfg.import_checks ?? []) {
    const cwdAbs = path.resolve(wt, c.cwd ?? '.')
    const r = run(c.run, cwdAbs, env, c.timeout_minutes ?? 5)
    const where = r.out[r.out.length - 1]?.trim() ?? ''
    if (r.code !== 0 || where === '') {
      ok = false
      show(print, c.name, 'FAIL', `import check could not run (exit ${r.code})`, r.out.slice(-10))
      continue
    }
    const resolved = path.resolve(cwdAbs, where)
    if (isInside(resolved, wt)) {
      show(print, c.name, 'PASS', `imports from the worktree: ${toPosix(path.relative(wt, resolved)) || '.'}`)
    } else {
      ok = false
      show(print, c.name, 'FAIL', 'IMPORTS RESOLVE OUTSIDE THE WORKTREE', [
        `imported from: ${resolved}`,
        `worktree:      ${wt}`,
        'The tests would exercise that code, not this branch. Set check_env so the worktree comes',
        'first (for Python: "PYTHONPATH": "{worktree}/<folder holding the package>").',
      ])
    }
  }
  return ok
}

// The commit the worktree's changes are measured from, and where it came from.
function findBase(root, wt, base, cfg) {
  if (base) {
    const mb = git(['merge-base', base, 'HEAD'], wt)
    return mb.code === 0 && mb.out ? { sha: mb.out, from: `--base ${base}` } : { error: `--base ${base}: no merge base with HEAD` }
  }
  const slug = slugOf(root, wt)
  const record = slug ? readRecord(root, slug) : null
  const branch = currentBranch(wt)
  if (record && record.branch === branch && record.base) {
    if (git(['merge-base', '--is-ancestor', record.base, 'HEAD'], wt).code === 0) {
      return { sha: record.base, from: `recorded when the task started, from ${record.base_ref}` }
    }
  }
  const b = currentBranch(root)
  const ref = b || cfg.base_branch
  const mb = git(['merge-base', ref, 'HEAD'], wt)
  if (mb.code !== 0 || !mb.out) return { error: `${ref}: no merge base with HEAD` }
  return { sha: mb.out, from: b ? "the main tree's branch" : 'config base_branch, main tree detached' }
}

// Runs the changed-file checks; print receives each output line. Returns the exit code.
export function check(root, { worktree, tests = [], base = '', full = false, waitMinutes, print = console.log }) {
  const cfg = loadConfig(root)
  if (!worktree) throw new QueueError('--worktree is required')
  const wt = path.resolve(worktree)
  if (!exists(wt)) throw new QueueError(`no such worktree: ${wt}`)
  if (full) return startFull(root, wt, { waitMinutes, print })
  const env = checkEnv(root, wt, cfg)

  const b = findBase(root, wt, base, cfg)
  if (b.error) {
    print(`base: ${b.error}`)
    print('RESULT FAIL')
    return 1
  }
  print(`base: ${b.sha.slice(0, 9)} (${b.from})`)
  const ch = changes(wt, b.sha)
  print(`changed: ${ch.files.length} file${ch.files.length === 1 ? '' : 's'}`)

  if (!importsInside(cfg, wt, env, print)) {
    print('RESULT FAIL')
    return 1
  }

  const testList = splitTests(tests)
  const list = cfg.checks.changed ?? []
  if (list.length === 0) print('no checks configured: add some under checks.changed in .claude/queue/config.json')
  let ran = 0
  let noTests = false
  let failed = false
  for (const c of list) {
    const hit = ch.files.filter(f => matches(f, c.when ?? []))
    if (hit.length === 0) continue
    ran++
    const cwdAbs = path.resolve(wt, c.cwd ?? '.')
    let command = c.run
    if (command.includes('{tests}')) {
      const t = testList.length > 0 ? testList : splitTests([c.default_tests ?? ''])
      if (t.length === 0) {
        noTests = true
        show(print, c.name, 'SKIP', 'no tests run: none named (pass --tests; the full suite runs only with --full)')
        continue
      }
      const missing = t.filter(p => !testExists(cwdAbs, p))
      if (missing.length > 0) {
        failed = true
        show(print, c.name, 'FAIL', 'not run: path not found', missing.map(m => `path not found (relative to ${c.cwd ?? '.'}): ${m}`))
        continue
      }
      command = command.replaceAll('{tests}', t.map(quote).join(' '))
    }
    const present = hit.filter(f => exists(path.join(wt, f))).map(f => toPosix(path.relative(cwdAbs, path.join(wt, f))))
    if ((command.includes('{files}') || command.includes('{files_file}')) && present.length === 0) {
      show(print, c.name, 'SKIP', 'the matching changed files were deleted')
      continue
    }
    let listFile = null
    if (command.includes('{files_file}')) {
      listFile = path.join(os.tmpdir(), `queue-files-${process.pid}-${Date.now()}.txt`)
      fs.writeFileSync(listFile, present.join('\n') + '\n')
      command = command.replaceAll('{files_file}', quote(listFile))
    }
    const r = command.includes('{files}')
      ? runWithFiles(command, present, cwdAbs, env, c.timeout_minutes)
      : run(command, cwdAbs, env, c.timeout_minutes)
    if (listFile) fs.rmSync(listFile, { force: true })
    const runs = r.runs > 1 ? ` in ${r.runs} runs` : ''
    if (c.changed_lines_only) {
      const located = r.out.filter(l => onChangedLine(l, cwdAbs, wt, ch) !== null)
      const hits = located.filter(l => onChangedLine(l, cwdAbs, wt, ch))
      if (r.code !== 0 && located.length === 0) {
        failed = true
        show(print, c.name, 'FAIL', `exit ${r.code} with no file:line output (did it run?), ${r.secs}s${runs}`, r.out.slice(-10))
      } else {
        if (hits.length > 0) failed = true
        show(print, c.name, hits.length === 0 ? 'PASS' : 'FAIL', `${hits.length} on changed lines, ${located.length - hits.length} elsewhere, ${r.secs}s${runs}`, hits)
      }
    } else {
      const ok = r.code === 0
      if (!ok) failed = true
      show(print, c.name, ok ? 'PASS' : 'FAIL', `${hit.length} changed file${hit.length === 1 ? '' : 's'}, ${r.secs}s${runs}${ok ? '' : `, exit ${r.code}`}`, ok ? [] : r.out.slice(-DETAIL_LINES))
    }
  }
  if (list.length > 0 && ran === 0) print('nothing to check: no changed file matches a check')
  if (noTests) print('NOTE no tests run')
  print(failed ? 'RESULT FAIL' : 'RESULT PASS')
  return failed ? 1 : 0
}

// ---- The full suite, in the background ------------------------------------------------------

function runsDir(root) {
  return path.join(queueDir(root), 'runs')
}

function runFiles(root, id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new QueueError(`bad run id: ${id}`)
  const base = path.join(runsDir(root), id)
  return { spec: `${base}.json`, log: `${base}.log`, summary: `${base}.summary`, exit: `${base}.exit` }
}

function startFull(root, wt, { waitMinutes, print }) {
  const id = `full-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${process.pid}`
  const f = runFiles(root, id)
  fs.mkdirSync(runsDir(root), { recursive: true })
  fs.writeFileSync(f.spec, JSON.stringify({ root, worktree: wt, started: new Date().toISOString() }, null, 2))
  fs.writeFileSync(f.log, '')
  const child = spawn(process.execPath, [SCRIPT, 'check-run', id], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  print(`full suite started in the background: ${id}`)
  print(`log: ${f.log}`)
  return waitFull(root, id, { waitMinutes, print })
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Waits for a background full-suite run. Exit code: its result, or 3 while it still runs.
export function waitFull(root, id, { waitMinutes = 8, print = console.log } = {}) {
  const f = runFiles(root, id)
  if (!exists(f.spec)) throw new QueueError(`no full-suite run ${id}`)
  const until = Date.now() + Number(waitMinutes) * 60 * 1000
  while (!exists(f.exit) && Date.now() < until) sleep(2000)
  if (!exists(f.exit)) {
    print(`RUNNING ${id}: still going after ${waitMinutes} min; log: ${f.log}`)
    print(`Wait again with: node "${SCRIPT}" check --wait ${id}`)
    return 3
  }
  const code = Number(fs.readFileSync(f.exit, 'utf8').trim())
  for (const l of fs.readFileSync(f.summary, 'utf8').split(/\r?\n/)) if (l !== '') print(l)
  print(`log: ${f.log}`)
  print(code === 0 ? 'RESULT PASS' : 'RESULT FAIL')
  return code === 0 ? 0 : 1
}

// The background process itself: runs import_checks and checks.full, writing every command's
// output to the log and a short summary beside it, then the exit code.
export function runFull(root, id) {
  const f = runFiles(root, id)
  const { worktree: wt } = JSON.parse(fs.readFileSync(f.spec, 'utf8'))
  const summary = []
  const say = l => summary.push(l)
  let failed = false
  try {
    const cfg = loadConfig(root)
    const env = checkEnv(root, wt, cfg)
    const list = cfg.checks.full ?? []
    say(`full suite: ${list.length} command${list.length === 1 ? '' : 's'}`)
    if (list.length === 0) say('nothing to run: checks.full is empty in .claude/queue/config.json')
    if (!importsInside(cfg, wt, env, say)) failed = true
    else {
      for (const c of list) {
        const cwdAbs = path.resolve(wt, c.cwd ?? '.')
        fs.appendFileSync(f.log, `\n===== ${c.name}: ${c.run} (in ${cwdAbs})\n`)
        const r = runToLog(c.run, cwdAbs, env, c.timeout_minutes ?? 120, f.log)
        fs.appendFileSync(f.log, `\n===== ${c.name}: exit ${r.code}, ${r.secs}s\n`)
        const ok = r.code === 0
        if (!ok) failed = true
        show(say, c.name, ok ? 'PASS' : 'FAIL', `${r.secs}s${ok ? '' : `, exit ${r.code}`}`, ok ? [] : r.out.slice(-DETAIL_LINES))
      }
    }
  } catch (e) {
    failed = true
    say(`could not run the full suite: ${e.message}`)
  }
  fs.writeFileSync(f.summary, summary.join('\n') + '\n')
  fs.writeFileSync(f.exit, failed ? '1\n' : '0\n')
}
