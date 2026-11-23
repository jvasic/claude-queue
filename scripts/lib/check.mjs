// check: runs the configured checks on a worktree and prints a short summary, never full logs.
//
// "Changed" means committed on the branch plus uncommitted plus untracked, against
// git merge-base <base> HEAD. The base defaults to the branch checked out in the main tree
// (the integration branch), so a branch off a batch is judged only on what it adds to that
// batch; when the main tree is detached, base_branch is used.
//
// checks.changed entries:
//   name                text shown in the summary
//   when                file patterns; the check runs when a changed file matches one
//   run                 the command, run through the shell. Placeholders:
//                         {files}  the matching changed files that still exist, relative to cwd
//                         {tests}  the --tests paths, else default_tests, else nothing
//   cwd                 folder to run in, relative to the worktree (default ".")
//   default_tests       what {tests} becomes when --tests is not given
//   changed_lines_only  true: fail only on "path:line:" output lines that sit on changed
//                       lines, for linters in repos that carry old errors
//   timeout_minutes     default 30
// checks.full entries (run with --full, once per merge round): name, run, cwd, timeout_minutes.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from './config.mjs'
import { QueueError, currentBranch, exists, git, toPosix } from './repo.mjs'

const DETAIL_LINES = 40

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

// Changed files and the changed line numbers per file, against the merge base.
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

function venvEnv(root, wt, venv) {
  const env = { ...process.env }
  if (!venv) return env
  for (const base of [wt, root]) {
    const dir = path.join(base, venv)
    const bin = path.join(dir, process.platform === 'win32' ? 'Scripts' : 'bin')
    if (exists(bin)) {
      const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
      env[key] = bin + path.delimiter + (env[key] ?? '')
      env.VIRTUAL_ENV = dir
      return env
    }
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
  })
  const secs = Math.round((Date.now() - started) / 1000)
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const out = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (r.error) out.push(`could not run: ${r.error.message}`)
  return { code: r.error ? -1 : (r.status ?? -1), secs, out }
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

function splitTests(tests) {
  return (tests ?? [])
    .flatMap(t => String(t).split(/[,\s]+/))
    .map(t => t.replace(/^['"]|['"]$/g, ''))
    .filter(t => t !== '')
}

// Runs the checks; print receives each output line. Returns the exit code.
export function check(root, { worktree, tests = [], base = '', full = false, print = console.log }) {
  const cfg = loadConfig(root)
  if (!worktree) throw new QueueError('--worktree is required')
  const wt = path.resolve(worktree)
  if (!exists(wt)) throw new QueueError(`no such worktree: ${wt}`)
  const env = venvEnv(root, wt, cfg.venv)
  let failed = false

  if (full) {
    const list = cfg.checks.full ?? []
    print(`full suite: ${list.length} command${list.length === 1 ? '' : 's'}`)
    if (list.length === 0) print('nothing to run: checks.full is empty in claude-queue/config.json')
    for (const c of list) {
      const cwdAbs = path.resolve(wt, c.cwd ?? '.')
      const r = run(c.run, cwdAbs, env, c.timeout_minutes)
      const ok = r.code === 0
      if (!ok) failed = true
      show(print, c.name, ok ? 'PASS' : 'FAIL', `${r.secs}s${ok ? '' : `, exit ${r.code}`}`, ok ? [] : r.out.slice(-DETAIL_LINES))
    }
    print(failed ? 'RESULT FAIL' : 'RESULT PASS')
    return failed ? 1 : 0
  }

  let from = '--base'
  if (!base) {
    const b = currentBranch(root)
    if (b) {
      base = b
      from = "main tree's branch"
    } else {
      base = cfg.base_branch
      from = 'config base_branch, main tree detached'
    }
  }
  const mb = git(['merge-base', base, 'HEAD'], wt)
  if (mb.code !== 0 || !mb.out) {
    print(`base: ${base} (${from}): no merge base with HEAD`)
    print('RESULT FAIL')
    return 1
  }
  print(`base: ${base} (${from}), merge base ${mb.out.slice(0, 9)}`)
  const ch = changes(wt, mb.out)
  print(`changed: ${ch.files.length} file${ch.files.length === 1 ? '' : 's'}`)

  const testList = splitTests(tests)
  const list = cfg.checks.changed ?? []
  if (list.length === 0) print('no checks configured: add some under checks.changed in claude-queue/config.json')
  let ran = 0
  for (const c of list) {
    const hit = ch.files.filter(f => matches(f, c.when ?? []))
    if (hit.length === 0) continue
    ran++
    const cwdAbs = path.resolve(wt, c.cwd ?? '.')
    let command = c.run
    if (command.includes('{files}')) {
      const present = hit
        .filter(f => exists(path.join(wt, f)))
        .map(f => toPosix(path.relative(cwdAbs, path.join(wt, f))))
      if (present.length === 0) {
        show(print, c.name, 'SKIP', 'the matching changed files were deleted')
        continue
      }
      command = command.replaceAll('{files}', present.map(quote).join(' '))
    }
    if (command.includes('{tests}')) {
      const t = testList.length > 0 ? testList : splitTests([c.default_tests ?? ''])
      const missing = t.filter(p => !exists(path.resolve(cwdAbs, p.split('::')[0])))
      if (missing.length > 0) {
        failed = true
        show(print, c.name, 'FAIL', 'not run: path not found', missing.map(m => `path not found (relative to ${c.cwd ?? '.'}): ${m}`))
        continue
      }
      command = command.replaceAll('{tests}', t.map(quote).join(' '))
    }
    const r = run(command, cwdAbs, env, c.timeout_minutes)
    if (c.changed_lines_only) {
      const located = r.out.filter(l => onChangedLine(l, cwdAbs, wt, ch) !== null)
      const hits = located.filter(l => onChangedLine(l, cwdAbs, wt, ch))
      if (r.code !== 0 && located.length === 0) {
        failed = true
        show(print, c.name, 'FAIL', `exit ${r.code} with no file:line output (did it run?), ${r.secs}s`, r.out.slice(-10))
      } else {
        if (hits.length > 0) failed = true
        show(print, c.name, hits.length === 0 ? 'PASS' : 'FAIL', `${hits.length} on changed lines, ${located.length - hits.length} elsewhere, ${r.secs}s`, hits)
      }
    } else {
      const ok = r.code === 0
      if (!ok) failed = true
      show(print, c.name, ok ? 'PASS' : 'FAIL', `${hit.length} changed file${hit.length === 1 ? '' : 's'}, ${r.secs}s${ok ? '' : `, exit ${r.code}`}`, ok ? [] : r.out.slice(-DETAIL_LINES))
    }
  }
  if (list.length > 0 && ran === 0) print('nothing to check: no changed file matches a check')
  print(failed ? 'RESULT FAIL' : 'RESULT PASS')
  return failed ? 1 : 0
}
