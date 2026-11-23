import { describe, expect, test } from 'claude-code/testing'

import { parseListing, parseQueue } from './register'

const QUEUE = [
  '---',
  '[running] Billing page totals',
  '> branch: queue/billing-page-totals',
  '> agent: a1',
  'Show totals per month.',
  '---',
  '[question] Export CSV',
  '> question: All columns or only visible ones?',
  'Add CSV export.',
  '---',
  '[question] Answered one',
  '> question: Old?',
  '> answer: yes',
  '---',
  '[done] Old task',
  '> merged: batch/one',
  '---',
  'Plain waiting task',
  'body',
  '',
].join('\n')

describe('parseQueue', () => {
  test('reads titles, tags and notes', async () => {
    const tasks = parseQueue(QUEUE)
    expect(tasks.map(t => t.tag)).toEqual(['running', 'question', 'question', 'done', ''])
    expect(tasks[0]?.title).toBe('Billing page totals')
    expect(tasks[0]?.agent).toBe('a1')
    expect(tasks[0]?.branch).toBe('queue/billing-page-totals')
    expect(tasks[1]?.question).toBe('All columns or only visible ones?')
    expect(tasks[2]?.question).toBeUndefined()
    expect(tasks[3]?.merged).toBe('batch/one')
    expect(tasks[4]?.title).toBe('Plain waiting task')
  })

  test('handles CRLF and an empty file', async () => {
    expect(parseQueue(QUEUE.replace(/\n/g, '\r\n')).length).toBe(5)
    expect(parseQueue('')).toEqual([])
  })
})

test('the pane draws with no workers on the terminal', async ($, on) => {
  on('agent.list', () => ({ value: [] }))
  const ui = await $.ui.mount({
    plugin: 'task-queue',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'queue',
    props: {
      title: 'Queue',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
    } as never,
  })
  expect(await ui.find({ type: 'Text', text: /none running/ })).toBeDefined()
  await ui.unmount()
})

test('subagents hang under the worker that started them, in columns when wide', async ($, on) => {
  on('agent.list', () => ({
    value: [
      { id: 'w1', description: 'Terms page', type: 'general-purpose', status: 'waiting' },
      { id: 's1', description: 'Find ADRs', type: 'Explore', status: 'running', parentId: 'w1' },
    ] as never,
  }))
  const ui = await $.ui.mount({
    plugin: 'task-queue',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'queue',
    props: { title: 'Queue', isFocused: false, bodyColumns: 160, placement: 'inline' } as never,
  })
  expect(await ui.find({ type: 'Text', text: /Workers 1\/4/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 subagent$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Find ADRs/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Sessions/ })).toBeDefined()
  await ui.unmount()
})

test('outside the terminal a small bodyColumns does not cut a long title', async ($, on) => {
  const title = 'A worker title that is much longer than forty characters and keeps going on'
  on('agent.list', () => ({
    value: [{ id: 'w1', description: title, type: 'general-purpose', status: 'running' }] as never,
  }))
  const ui = await $.ui.mount({
    plugin: 'task-queue',
    surface: 'vscode',
    component: 'Pane',
    requestId: 'queue',
    props: { title: 'Queue', isFocused: false, bodyColumns: 40, placement: 'inline' } as never,
  })
  expect(await ui.find({ type: 'Text', text: new RegExp(title) })).toBeDefined()
  await ui.unmount()
})

test('parseListing reads every session line of the ListAgents text', async () => {
  const dot = '\u00b7'
  const text = [
    'This session is Queue Coordinator Cobalt [f5361f] - the name other sessions use.',
    '',
    'Peer sessions (6):',
    `  Docs rewrite [f656c2]  ${dot}  interactive  ${dot}  idle  ${dot}  started 4h ago`,
    `  API client [df8ec4]  ${dot}  interactive  ${dot}  idle  ${dot}  started 5h ago`,
    `  Main chat [c315e2]  ${dot}  interactive  ${dot}  busy  ${dot}  started 6h ago`,
    `  Release prep [be3724]  ${dot}  interactive  ${dot}  idle  ${dot}  started 6h ago`,
    `  my-repo-6d [01cfe4]  ${dot}  interactive  ${dot}  idle  ${dot}  started 6h ago`,
    `  Ops (servers) [081d87]  ${dot}  interactive  ${dot}  idle  ${dot}  started 1h ago`,
  ].join('\n')
  const peers = parseListing(text)
  expect(peers.map(p => p.name)).toEqual([
    'Docs rewrite',
    'API client',
    'Main chat',
    'Release prep',
    'my-repo-6d',
    'Ops (servers)',
  ])
  expect(peers[2]?.status).toBe('busy')
  expect(peers[0]?.kind).toBe('Peer sessions')
})

test('a held task is its own tag, not waiting', async () => {
  const tasks = parseQueue(['---', '[held] Package upgrades', 'later', '---', 'Plain task', ''].join('\n'))
  expect(tasks.map(t => t.tag)).toEqual(['held', ''])
  expect(tasks.filter(t => t.tag === '').length).toBe(1)
})

test('the [notes] block is not a task', async () => {
  const text = [
    '---',
    '[notes] RESUME NOTES (coordinator; read first, not a task)',
    '> waits: package upgrades after deploy',
    'Batch billing merged; push waits for the user.',
    '---',
    '[held] Package upgrades',
    '---',
    'Plain task',
    '',
  ].join('\n')
  const tasks = parseQueue(text)
  expect(tasks.map(t => t.tag)).toEqual(['held', ''])
  expect(tasks.some(t => t.title.startsWith('RESUME NOTES'))).toBe(false)
})

test('a paused task is its own tag, not waiting', async () => {
  const tasks = parseQueue(['---', '[paused] Resume me', '> done: x', '---', 'Plain task', ''].join('\n'))
  expect(tasks.map(t => t.tag)).toEqual(['paused', ''])
})
