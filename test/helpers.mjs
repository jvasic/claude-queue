// Throwaway git repositories for the tests.
import { spawnSync } from 'node:child_process'
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

export function cli(args, cwd, input) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', input })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

// A repo on main with one commit and a claude-queue/config.json holding the given settings.
export function makeRepo(config = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-')))
  sh(['init', '-q', '-b', 'main'], root)
  fs.writeFileSync(path.join(root, 'README.md'), 'test\n')
  fs.writeFileSync(path.join(root, '.gitignore'), '/claude-queue/\n/.claude/worktrees/\n.venv/\nnode_modules/\n.env\n')
  sh(['add', '-A'], root)
  sh(['commit', '-q', '-m', 'init'], root)
  fs.mkdirSync(path.join(root, 'claude-queue'))
  fs.writeFileSync(path.join(root, 'claude-queue', 'config.json'), JSON.stringify({ base_branch: 'main', ...config }, null, 2))
  return root
}

export function cleanup(root) {
  process.chdir(os.tmpdir())
  try {
    sh(['worktree', 'prune'], root)
  } catch {}
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
