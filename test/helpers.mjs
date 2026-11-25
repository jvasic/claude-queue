// Throwaway git repositories for the tests.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'Queue Test'
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'queue-test@example.invalid'

export const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'queue.mjs')

export function sh(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// git that may fail: { code, out, err }.
export function gitTry(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

function baseEnv(env) {
  const base = { ...process.env }
  delete base.CLAUDE_CODE_SESSION_ID
  return { ...base, ...env }
}

// Runs the script without the calling session's CLAUDE_CODE_SESSION_ID, unless env sets one.
export function cli(args, cwd, input, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', input, env: baseEnv(env) })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

// The same, without waiting: resolves when the process ends. For races.
export function cliAsync(args, cwd, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: baseEnv(env) })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.on('close', code => resolve({ code, out: out.trim() }))
  })
}

// The queue folder of a test repo, or a file in it.
export function q(root, ...parts) {
  return path.join(root, '.claude', 'queue', ...parts)
}

// A repo on main with one commit: a tracked .gitignore for .venv, node_modules and .env, and
// nothing of the queue.
export function plainRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-')))
  sh(['init', '-q', '-b', 'main'], root)
  fs.writeFileSync(path.join(root, 'README.md'), 'test\n')
  fs.writeFileSync(path.join(root, '.gitignore'), '.venv/\nnode_modules/\n.env\n')
  sh(['add', '-A'], root)
  sh(['commit', '-q', '-m', 'init'], root)
  return root
}

// A plain repo set up as init leaves it: .claude/queue/config.json holding the given settings,
// and both queue folders in .git/info/exclude.
export function makeRepo(config = {}) {
  const root = plainRepo()
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/.claude/queue/\n/.claude/worktrees/\n')
  fs.mkdirSync(q(root), { recursive: true })
  fs.writeFileSync(q(root, 'config.json'), JSON.stringify({ base_branch: 'main', ...config }, null, 2))
  return root
}

// Writes queue.md from task blocks, each an array of lines.
export function writeQueue(root, ...tasks) {
  fs.writeFileSync(q(root, 'queue.md'), ['---', ...tasks.flatMap(t => [...t, '---'])].join('\n') + '\n')
}

export function cleanup(root) {
  process.chdir(os.tmpdir())
  try {
    sh(['worktree', 'prune'], root)
  } catch {}
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
