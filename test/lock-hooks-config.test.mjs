import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { cleanup, cli, cliAsync, makeRepo, q, writeQueue } from './helpers.mjs'

const repos = []
const repo = config => {
  const r = makeRepo(config)
  repos.push(r)
  return r
}
after(() => repos.forEach(cleanup))

const age = (file, hours) => {
  const t = new Date(Date.now() - hours * 3600 * 1000)
  fs.utimesSync(file, t, t)
}

test('lock: acquire, refuse while fresh, take over when stale, release', () => {
  const root = repo({ lock_stale_hours: 1 })
  assert.equal(cli(['lock', 'status'], root).out, 'UNLOCKED')
  assert.deepEqual(cli(['lock', 'acquire'], root), { code: 0, out: 'ACQUIRED', err: '' })
  const second = cli(['lock', 'acquire'], root)
  assert.equal(second.out, 'LOCKED')
  assert.equal(second.code, 1)
  const lock = q(root, '.running')
  age(lock, 2)
  assert.equal(cli(['lock', 'status'], root).out, 'UNLOCKED')
  assert.equal(cli(['lock', 'acquire'], root).out, 'ACQUIRED')
  assert.equal(cli(['lock', 'status'], root).out, 'LOCKED')
  assert.equal(cli(['lock', 'release'], root).out, 'RELEASED')
  assert.equal(fs.existsSync(lock), false)
  assert.deepEqual(fs.readdirSync(q(root)).filter(f => f.startsWith('.running')), [], 'no stale copies left')
})

test('lock: of many sessions acquiring at once, exactly one wins, also over a stale lock', async () => {
  const root = repo({ lock_stale_hours: 1 })
  for (const stale of [false, true]) {
    if (stale) {
      fs.writeFileSync(q(root, '.running'), 'old\n')
      age(q(root, '.running'), 2)
    }
    const results = await Promise.all(Array.from({ length: 8 }, () => cliAsync(['lock', 'acquire'], root)))
    assert.equal(results.filter(r => r.out === 'ACQUIRED').length, 1, JSON.stringify(results))
    assert.equal(results.filter(r => r.out === 'LOCKED').length, 7)
    cli(['lock', 'release'], root)
  }
})

test('lock refresh only refreshes a held lock', () => {
  const root = repo()
  assert.deepEqual(cli(['lock', 'refresh'], root), { code: 1, out: 'NOT HELD', err: '' })
  assert.equal(fs.existsSync(q(root, '.running')), false, 'a refresh after a release does not lock again')
  cli(['lock', 'acquire'], root)
  age(q(root, '.running'), 3)
  assert.equal(cli(['lock', 'refresh'], root).out, 'REFRESHED')
  assert.ok(Date.now() - fs.statSync(q(root, '.running')).mtimeMs < 60_000)
})

test('lock works from inside a subfolder, on the main tree', () => {
  const root = repo()
  assert.equal(cli(['lock', 'acquire'], q(root)).out, 'ACQUIRED')
  assert.equal(cli(['lock', 'status'], root).out, 'LOCKED')
})

test('lock acquire records the session from CLAUDE_CODE_SESSION_ID; only its end releases', () => {
  const root = repo()
  const marker = q(root, '.runner-session')
  const end = session => cli(['hook', 'session-end'], root, JSON.stringify({ cwd: root, session_id: session }))
  assert.equal(cli(['lock', 'acquire'], root).out, 'ACQUIRED')
  assert.equal(fs.existsSync(marker), false, 'no variable, no marker')
  cli(['lock', 'release'], root)
  assert.equal(cli(['lock', 'acquire'], root, undefined, { CLAUDE_CODE_SESSION_ID: 'abc' }).out, 'ACQUIRED')
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'abc')
  assert.equal(cli(['lock', 'acquire'], root, undefined, { CLAUDE_CODE_SESSION_ID: 'other' }).out, 'LOCKED')
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'abc', 'a refused acquire keeps the marker')
  end('other')
  assert.equal(cli(['lock', 'status'], root).out, 'LOCKED', 'another session ending keeps the lock')
  end('abc')
  assert.equal(cli(['lock', 'status'], root).out, 'UNLOCKED')
  assert.equal(fs.existsSync(marker), false)
})

test("the prompt hook refreshes the coordinator's lock and never takes it", () => {
  const root = repo()
  const send = (session, prompt) => cli(['hook', 'prompt-submit'], root, JSON.stringify({ cwd: root, session_id: session, prompt }))
  send('s1', '/queue-start')
  assert.equal(fs.existsSync(q(root, '.runner-session')), false, 'a start prompt writes no marker')
  assert.equal(fs.existsSync(q(root, '.running')), false)
  cli(['lock', 'acquire'], root, undefined, { CLAUDE_CODE_SESSION_ID: 's1' })
  age(q(root, '.running'), 3)
  send('s2', 'hello')
  assert.ok(Date.now() - fs.statSync(q(root, '.running')).mtimeMs > 3600_000, "another session's prompt changes nothing")
  send('s1', 'status')
  assert.ok(Date.now() - fs.statSync(q(root, '.running')).mtimeMs < 60_000, "the coordinator's prompt refreshes it")
})

test('hooks never fail: bad JSON, no repo, no config', () => {
  const root = repo()
  assert.equal(cli(['hook', 'prompt-submit'], root, 'not json').code, 0)
  fs.rmSync(q(root, 'config.json'))
  const r = cli(['hook', 'pre-tool-use'], root, JSON.stringify({ cwd: root, session_id: 'x', agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'git push' } }))
  assert.deepEqual(r, { code: 0, out: '', err: '' })
  assert.equal(cli(['hook', 'session-end'], os.tmpdir(), JSON.stringify({ cwd: os.tmpdir(), session_id: 'x' })).code, 0)
})

test('config: show, set with validation, get, model_rules', () => {
  const root = repo({ max_workers: 4 })
  const show = cli(['config', 'show'], root).out
  assert.match(show, /max_workers = 4/)
  assert.match(show, /model_rules = sonnet for small, clearly scoped work.*; opus for everything else/)
  assert.match(show, /safety_hooks = true/)
  assert.equal(cli(['config', 'set', 'max_workers', '6'], root).code, 0)
  assert.equal(cli(['config', 'get', 'max_workers'], root).out, '6')
  const bad = cli(['config', 'set', 'max_workers', '0'], root)
  assert.equal(bad.code, 1)
  assert.match(bad.out, /1 to 20/)
  assert.match(cli(['config', 'set', 'models.worker', 'sonnet'], root).out, /model_rules/)
  assert.equal(cli(['config', 'set', 'model_rules', '[{"when":"docs only","model":"haiku"}]'], root).code, 1, 'default must be last')
  assert.equal(cli(['config', 'set', 'model_rules', '[{"when":"docs only","model":"haiku"},{"when":"default","model":"opus"}]'], root).code, 0)
  assert.equal(cli(['config', 'set', 'check_env', '{"PYTHONPATH":"{worktree}/src"}'], root).code, 0)
  assert.equal(cli(['config', 'set', 'safety_hooks', 'false'], root).code, 0)
  assert.equal(cli(['config', 'set', 'safety_hooks', 'maybe'], root).code, 1)
  assert.equal(cli(['config', 'set', 'worktree_links', '[".venv","node_modules"]'], root).code, 0)
  assert.equal(cli(['config', 'set', 'nonsense', '1'], root).code, 1)
  const raw = JSON.parse(fs.readFileSync(q(root, 'config.json'), 'utf8'))
  assert.deepEqual(raw.worktree_links, ['.venv', 'node_modules'])
  assert.equal(raw.safety_hooks, false)
  assert.equal(raw.base_branch, 'main', 'other keys are kept')
})

test('config: a 0.1 config with models.worker and models.small_task reads as model rules', () => {
  const root = repo({ models: { worker: 'opus', small_task: 'haiku', merge: 'sonnet' } })
  const rules = JSON.parse(cli(['config', 'get', 'model_rules'], root).out)
  assert.deepEqual(rules.map(r => r.model), ['haiku', 'opus'])
  assert.equal(rules[1].when, 'default')
  assert.equal(cli(['config', 'get', 'models.merge'], root).out, '"sonnet"')
})

test('commands outside an initialized repo say how to start', () => {
  const root = repo()
  fs.rmSync(q(root), { recursive: true })
  const r = cli(['lock', 'status'], root)
  assert.equal(r.code, 1)
  assert.match(r.out, /queue-init/)
})

// ---- The safety hook ----------------------------------------------------------------------

function safetyRepo(config = {}) {
  const root = repo({ branch_prefix: 'queue/', ...config })
  writeQueue(
    root,
    ['[running] Billing totals', '> branch: queue/billing-totals', '> agent: a1', 'Do it.'],
    ['[running] Release', '> branch: queue/release', '> agent: a2', '> free: the user asked this task to push', 'Push it.'],
  )
  return root
}

// The test repos live in the system temp folder, where workers may write; the hook gets a
// temp folder of its own instead.
const fakeTemp = root => path.join(path.dirname(root), `${path.basename(root)}-tmp`)

function ask(root, input) {
  const t = fakeTemp(root)
  const env = { TEMP: t, TMP: t, TMPDIR: t }
  const r = cli(['hook', 'pre-tool-use'], root, JSON.stringify({ session_id: 's', cwd: root, ...input }), env)
  assert.equal(r.code, 0)
  if (r.out === '') return 'allow'
  const d = JSON.parse(r.out).hookSpecificOutput
  assert.equal(d.permissionDecision, 'deny')
  return d.permissionDecisionReason
}

test('safety: a worker cannot push, stash, stage everything or change git outside its worktree', () => {
  const root = safetyRepo()
  const wt = path.join(root, '.claude', 'worktrees', 'queue-billing-totals')
  const bash = (command, cwd = root) => ask(root, { agent_id: 'a1', cwd, tool_name: 'Bash', tool_input: { command } })
  assert.match(bash('git push origin queue/billing-totals'), /never push/)
  assert.match(bash(`git -C "${wt}" stash`), /stash/)
  assert.match(bash(`cd "${wt}" && git add -A`), /by name/)
  assert.match(bash('git add .', wt), /by name/)
  assert.match(bash('git checkout main'), /outside your worktree/)
  assert.match(bash(`git -C "${root}" reset --hard`, wt), /outside your worktree/)
  assert.match(bash('git branch -D queue/other', wt), /branches/)
  assert.equal(bash(`git -C "${wt}" add src/a.js && git -C "${wt}" commit -m "Billing totals"`), 'allow')
  assert.equal(bash(`cd "${wt}" && git commit -m x`), 'allow')
  assert.equal(bash('git status && git log --oneline -3 && git branch --show-current'), 'allow')
  assert.equal(bash(`node queue.mjs worktree remove --slug billing-totals`), 'allow')
})

test('safety: the hook reads variables, nested shells and Git Bash paths', () => {
  const root = safetyRepo()
  const wt = path.join(root, '.claude', 'worktrees', 'queue-billing-totals')
  const rel = '.claude/worktrees/queue-billing-totals'
  const bash = (command, cwd = root) => ask(root, { agent_id: 'a1', cwd, tool_name: 'Bash', tool_input: { command } })
  // A worktree path kept in a variable is the worktree, not a folder named $W.
  assert.equal(bash(`cd "${root}" && W=${rel} && git -C $W add src/a.js && git -C "$W" commit -m "Billing totals"`), 'allow')
  assert.equal(bash(`export W="${wt}"; git -C \${W} commit -m x`), 'allow')
  assert.equal(ask(root, { agent_id: 'a1', tool_name: 'PowerShell', tool_input: { command: `$wt = "${wt}"; git -C $wt commit -m x` } }), 'allow')
  assert.match(bash(`W=${root} && git -C $W checkout main`), /outside your worktree/)
  // A variable the line does not set is unknown: not refused for where it points.
  assert.equal(bash('git -C $SOMEWHERE commit -m x'), 'allow')
  assert.match(bash('git -C $SOMEWHERE push'), /never push/)
  // Commands inside bash -c / powershell -Command are read too.
  assert.match(bash('bash -c "git push origin queue/x"'), /never push/)
  assert.match(bash(`powershell -Command "git -C '${root}' reset --hard"`), /outside your worktree/)
  assert.match(bash('echo ok && sh -c \'git stash\''), /stash/)
  // Refs and worktrees are never changed by hand.
  assert.match(bash('git update-ref refs/heads/main HEAD', wt), /refs by hand/)
  assert.match(bash('git worktree add ../elsewhere', wt), /queue script/)
  assert.equal(bash('git worktree list', wt), 'allow')
  if (process.platform === 'win32') {
    const msys = root.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
    assert.match(bash(`cd ${msys} && git checkout main`, wt), /outside your worktree/)
    assert.equal(bash(`cd ${msys}/${rel} && git commit -m x`), 'allow')
  }
})

test('safety: a worker writes only in its worktree, the temp folders, research/ and safety_allow', () => {
  const root = safetyRepo({ safety_allow: ['docs/shared'] })
  const wt = path.join(root, '.claude', 'worktrees', 'queue-billing-totals')
  const write = (file, tool = 'Write') => ask(root, { agent_id: 'a1', tool_name: tool, tool_input: { file_path: file, content: 'x' } })
  assert.equal(write(path.join(wt, 'src', 'a.js')), 'allow')
  assert.equal(write(path.join(wt, 'src', 'a.js'), 'Edit'), 'allow')
  assert.equal(write(path.join(fakeTemp(root), 'scratch', 'notes.md')), 'allow')
  assert.equal(write(q(root, 'research', 'findings.md')), 'allow')
  assert.equal(write(path.join(root, 'docs', 'shared', 'x.md')), 'allow')
  assert.match(write(path.join(root, 'src', 'a.js')), /outside your worktree/)
  assert.match(write(q(root, 'queue.md'), 'Edit'), /outside your worktree/)
  assert.match(write(path.join(root, '.claude', 'worktrees', 'queue-other', 'a.js')), /outside your worktree/)
})

test('safety: only workers are held to it, a "> free:" task and safety_hooks false are exempt', () => {
  const root = safetyRepo()
  const push = input => ask(root, { tool_name: 'Bash', tool_input: { command: 'git push' }, ...input })
  assert.equal(push({}), 'allow', 'no agent_id: the user\'s own session')
  assert.equal(push({ agent_id: 'some-explore-agent' }), 'allow', 'a subagent that is not a queue worker')
  assert.equal(push({ agent_id: 'a2' }), 'allow', 'the task has a > free: line')
  assert.match(push({ agent_id: 'a1' }), /never push/)
  cli(['config', 'set', 'safety_hooks', 'false'], root)
  assert.equal(push({ agent_id: 'a1' }), 'allow')
})
