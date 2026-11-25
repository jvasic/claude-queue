#!/usr/bin/env node
// The task-queue plugin's one script. Run it from anywhere inside the repository, a task
// worktree included: it always works on the main working tree's .claude/queue/ folder.
//
//   queue.mjs root                                  print the main working tree
//   queue.mjs init [--preset none|python|node|mixed]
//   queue.mjs lock status|acquire|refresh|release
//   queue.mjs worktree create --slug <s> [--base <ref>] [--resume]
//   queue.mjs worktree remove|path|link --slug <s> [--kind task|merge]
//   queue.mjs check --worktree <path> [--tests <a,b>] [--base <ref>]
//   queue.mjs check --worktree <path> --full [--wait-minutes <n>]   full suite, in the background
//   queue.mjs check --wait <run id> [--wait-minutes <n>]            wait for it again
//   queue.mjs config show | get <key> | set <key> <value>
//   queue.mjs hook prompt-submit|session-end|pre-tool-use   (reads the hook's JSON on stdin)
import { describe, getPath, loadConfig, parseValue, setSetting } from './lib/config.mjs'
import { check, runFull, waitFull } from './lib/check.mjs'
import { handle, readStdin } from './lib/hooks.mjs'
import { init } from './lib/init.mjs'
import { lock } from './lib/lock.mjs'
import { QueueError, mainRoot } from './lib/repo.mjs'
import { create, link, remove, worktreePath } from './lib/worktree.mjs'

const USAGE = `usage: queue.mjs <command>
  root
  init [--preset none|python|node|mixed]
  lock status|acquire|refresh|release
  worktree create --slug <slug> [--base <ref>] [--resume]
  worktree remove|path|link --slug <slug> [--kind task|merge]
  check --worktree <path> [--tests <a,b>] [--base <ref>]
  check --worktree <path> --full [--wait-minutes <n>]
  check --wait <run id> [--wait-minutes <n>]
  config show | get <key> | set <key> <value>
  hook prompt-submit|session-end|pre-tool-use`

// --name value pairs and bare words. Repeated --tests values accumulate.
function parseArgs(argv) {
  const words = []
  const opts = { tests: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s)
      const flag = ['full', 'test-fallback', 'resume'].includes(k)
      const v = flag ? true : (inline ?? argv[++i])
      if (v === undefined) throw new QueueError(`--${k} needs a value`)
      if (k === 'tests') opts.tests.push(v)
      else opts[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v
    } else words.push(a)
  }
  return { words, opts }
}

async function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'hook') {
    // A hook must never fail the session: swallow everything.
    try {
      const out = handle(rest[0], await readStdin())
      if (out) process.stdout.write(out)
    } catch {}
    return 0
  }
  if (cmd === 'check-run') {
    // The background full-suite process started by check --full.
    runFull(mainRoot(), rest[0])
    return 0
  }
  const { words, opts } = parseArgs(rest)
  const say = lines => {
    for (const l of [].concat(lines)) console.log(l)
  }
  switch (cmd) {
    case 'root':
      say(mainRoot())
      return 0
    case 'init':
      say(init(mainRoot(), { preset: opts.preset ?? 'none' }))
      return 0
    case 'lock': {
      const [line, code] = lock(mainRoot(), words[0])
      say(line)
      return code
    }
    case 'worktree': {
      const root = mainRoot()
      const action = words[0]
      const kind = opts.kind ?? 'task'
      if (action === 'path') {
        say(worktreePath(root, opts.slug, kind))
        return 0
      }
      let r
      if (action === 'create') {
        if (kind !== 'task') throw new QueueError('create is for task worktrees; the queue-merge skill makes merge worktrees with git worktree add, then runs worktree link')
        r = create(root, opts.slug, { base: opts.base, resume: opts.resume === true })
      } else if (action === 'remove') r = remove(root, opts.slug, kind, { testFallback: opts.testFallback === true })
      else if (action === 'link') r = link(root, opts.slug, kind)
      else throw new QueueError(`unknown worktree action: ${action} (create, remove, path, link)`)
      say(r.lines)
      return r.code
    }
    case 'check': {
      const waitMinutes = opts.waitMinutes === undefined ? undefined : Number(opts.waitMinutes)
      if (opts.wait) return waitFull(mainRoot(), opts.wait, { waitMinutes })
      return check(mainRoot(), { worktree: opts.worktree, tests: opts.tests, base: opts.base ?? '', full: opts.full === true, waitMinutes })
    }
    case 'config': {
      const root = mainRoot()
      if (!words[0] || words[0] === 'show') say(describe(root))
      else if (words[0] === 'get') say(JSON.stringify(getPath(loadConfig(root), words[1] ?? ''), null, 2) ?? 'undefined')
      else if (words[0] === 'set') {
        if (words.length < 3) throw new QueueError('config set <key> <value>')
        const value = parseValue(words.slice(2).join(' '))
        setSetting(root, words[1], value)
        say(`SET ${words[1]} = ${JSON.stringify(value)}`)
      } else throw new QueueError(`unknown config action: ${words[0]} (show, get, set)`)
      return 0
    }
    default:
      say(USAGE)
      return cmd ? 2 : 0
  }
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code
  },
  e => {
    if (e instanceof QueueError) {
      console.log(`FAILED ${e.message}`)
      process.exitCode = 1
    } else {
      console.error(e)
      process.exitCode = 2
    }
  },
)
