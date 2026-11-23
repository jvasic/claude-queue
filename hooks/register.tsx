import type { AgentInfo, EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { PeerSession, QueueTask, ToolSeen } from '../types'

// Live pane for the session that runs /queue-start. Reads claude-queue/queue.md and
// config.json every few seconds, lists this session's background agents (the workers),
// remembers each worker's last tool call, and lists the user's other sessions as ListAgents
// shows them.

const PANE = 'queue'
const QUEUE = 'claude-queue/queue.md'
const CONFIG = 'claude-queue/config.json'
const MARKER = 'claude-queue/.runner-session'
const ENDED = ['completed', 'failed', 'killed']

const isActive = { plugin: 'task-queue', key: 'isActive' } as const
const tasks = { plugin: 'task-queue', key: 'tasks' } as const
const maxWorkers = { plugin: 'task-queue', key: 'maxWorkers' } as const
const lastTool = { plugin: 'task-queue', key: 'lastTool' } as const
const firstSeen = { plugin: 'task-queue', key: 'firstSeen' } as const
const now = { plugin: 'task-queue', key: 'now' } as const
const nickname = { plugin: 'task-queue', key: 'nickname' } as const
const sessions = { plugin: 'task-queue', key: 'sessions' } as const

// ListAgents is asked every SESSION_EVERY refreshes (3 s each), not every refresh.
const SESSION_EVERY = 5
let ticks = 0

// The rows the last drawing needed, and the rows last asked of the pane. The timer asks
// the pane for a new height when they differ, so the inline pane grows and shrinks with
// its tallest column instead of staying at a third of the screen.
const MIN_ROWS = 4
let wantedRows = 0
let askedRows = 0

const NICKNAMES = [
  'Otter', 'Falcon', 'Maple', 'Comet', 'Badger', 'Juniper', 'Pebble', 'Heron', 'Cobalt',
  'Lynx', 'Saffron', 'Quartz', 'Willow', 'Kestrel', 'Ember', 'Fjord', 'Marten', 'Basil',
]

export function parseQueue(text: string): QueueTask[] {
  const found: QueueTask[] = []
  let block: string[] = []
  const flush = (): void => {
    const lines = block.map(l => l.trim()).filter(l => l !== '')
    block = []
    const head = lines.find(l => !l.startsWith('>'))
    if (head === undefined) return
    const m = /^\[([a-z ]+)\]\s*(.*)$/i.exec(head)
    const task: QueueTask = { title: m?.[2] ?? head, tag: m?.[1]?.toLowerCase() ?? '' }
    let openQuestion: string | undefined
    for (const line of lines) {
      const note = /^>\s*([a-z]+):\s*(.*)$/i.exec(line)
      if (!note) continue
      const [, key, value] = note
      if (key === 'branch') task.branch = value
      if (key === 'agent') task.agent = value
      if (key === 'merged') task.merged = value
      if (key === 'question') openQuestion = value
      if (key === 'answer') openQuestion = undefined
    }
    if (task.tag === 'question') task.question = openQuestion
    // The [notes] block is the coordinator's own notes, never a task: not listed, not counted.
    if (task.tag !== 'notes') found.push(task)
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '---') flush()
    else block.push(line)
  }
  flush()
  return found
}

function describeCall(e: ToolCallInput): string {
  const short = (s: string): string => (s.length > 90 ? s.slice(0, 89) + '...' : s)
  const base = (p: string): string => p.split(/[\\/]/).pop() ?? p
  if (e.tool === 'Bash') return 'Bash ' + short(e.description ?? e.command)
  if (e.tool === 'PowerShell') return 'PowerShell ' + short(e.description ?? e.command)
  if (e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write') return `${e.tool} ${base(e.file_path)}`
  if (e.tool === 'Grep' || e.tool === 'Glob') return `${e.tool} ${short(e.pattern)}`
  return e.tool
}

async function refresh($: EngineInterface): Promise<void> {
  if ((await $.state.get(isActive)).value !== true) return
  try {
    const text = await $.fs.read(QUEUE)
    await $.state.set(tasks, parseQueue(text))
  } catch {
    // A missing or half-written file keeps the last good list.
  }
  try {
    const cfg = JSON.parse(await $.fs.read(CONFIG)) as { max_workers?: number }
    if (typeof cfg.max_workers === 'number') await $.state.set(maxWorkers, cfg.max_workers)
  } catch {
    // Keep the last value.
  }
  const t = await $.clock.now()
  const agents = await $.agent.list()
  const seen: Record<string, number> = { ...((await $.state.get(firstSeen)).value ?? {}) }
  for (const a of agents) if (seen[a.id] === undefined) seen[a.id] = t
  await $.state.set(firstSeen, seen)
  await $.state.set(now, t)
  if (ticks++ % SESSION_EVERY === 0) await refreshSessions($, agents)
  await fitHeight($)
}

// Other sessions, from the ListAgents tool: every row except this session's own agents,
// which the pane shows as workers.
// Reads the text listing ListAgents prints, one line per session under a "<Kind> (<n>):"
// header:  "  MAIN CHAT [c315e2]  \u00b7  interactive  \u00b7  idle  \u00b7  started 6h ago".
// The structured sections can hold fewer rows than the listing, so they are only a fallback.
export function parseListing(text: string): PeerSession[] {
  const found: PeerSession[] = []
  let kind = ''
  for (const line of text.split(/\r?\n/)) {
    const header = /^(\S.*?)\s*\(\d+\):\s*$/.exec(line)
    if (header) {
      kind = header[1] ?? ''
      continue
    }
    const row = /^\s+(.+?)\s+\[[0-9a-z]+\]\s*(.*)$/i.exec(line)
    if (!row || kind === '') continue
    const fields = (row[2] ?? '').split('\u00b7').map(f => f.trim()).filter(f => f !== '')
    found.push({ name: row[1] ?? '', status: fields[1] ?? fields[0] ?? '', kind })
  }
  return found
}

// Other sessions, from the ListAgents tool: every entry except this session's own agents,
// which the pane shows as workers.
async function refreshSessions($: EngineInterface, agents: AgentInfo[]): Promise<void> {
  try {
    const r = await $.tool.call({ tool: 'ListAgents' })
    const own = new Set(agents.flatMap(a => [a.id, a.name ?? '']).filter(x => x !== ''))
    const result = r.result as
      | {
          listing?: string
          sections?: { kind: string; rows: { name?: string; id?: string; status?: string }[] }[]
        }
      | undefined
    let found = parseListing(result?.listing ?? '')
    if (found.length === 0) {
      for (const section of result?.sections ?? []) {
        for (const row of section.rows) {
          const name = row.name ?? row.id ?? ''
          if (name !== '') found.push({ name, status: row.status ?? '', kind: section.kind })
        }
      }
    }
    found = found.filter(p => !own.has(p.name))
    await $.state.set(sessions, found)
  } catch {
    // ListAgents unavailable or refused: keep the last list.
  }
}

// Names the session "Queue Coordinator <nickname>" with the built-in /rename, once the
// session is idle. The nickname is kept for the session, so a second /queue-coordinator
// keeps the same name.
async function rename($: EngineInterface): Promise<void> {
  let name = (await $.state.get(nickname)).value
  if (name === undefined) {
    name = NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)] ?? 'Otter'
    await $.state.set(nickname, name)
  }
  try {
    await $.command.run({ command: 'rename', args: `Queue Coordinator ${name}` })
  } catch {
    // No /rename in this build, or the run was refused: keep the session's name.
  }
}

async function recordTool($: EngineInterface, agentId: string, text: string): Promise<void> {
  if ((await $.state.get(isActive)).value !== true) return
  const seen: ToolSeen = { text, at: await $.clock.now() }
  const all = (await $.state.get(lastTool)).value ?? {}
  await $.state.set(lastTool, { ...all, [agentId]: seen })
}

async function activate($: EngineInterface): Promise<void> {
  await $.state.set(isActive, true)
  await refresh($)
  askedRows = Math.max(MIN_ROWS, wantedRows)
  void $.ui.open({ id: PANE, title: 'Queue', rows: askedRows })
}

async function fitHeight($: EngineInterface): Promise<void> {
  if (wantedRows === 0 || wantedRows === askedRows) return
  if ((await $.state.get(isActive)).value !== true) return
  askedRows = Math.max(MIN_ROWS, wantedRows)
  await $.ui.open({ id: PANE, title: 'Queue', rows: askedRows })
}

function minutes(ms: number): string {
  const m = Math.floor(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'queue-panel', description: 'Show the queue coordinator pane' })
    $.clock.every(3000, () => void refresh($))
    try {
      const marker = (await $.fs.read(MARKER)).trim()
      if (marker !== '' && marker === (await $.session.id())) await activate($)
    } catch {
      // No coordinator marker: stay quiet until /queue-start, /queue-coordinator or /queue-panel.
    }
    return next(e)
  })

  on('command.run', { command: 'queue-panel' }, async $ => {
    await activate($)
    return { text: 'Queue pane opened.' }
  })

  on('prompt.submit', ($, e, next) => {
    // The skills load as /task-queue:queue-start, or as /queue-start where no other command
    // has that name.
    const name = e.command?.name.split(':').pop()
    if (name === 'queue-coordinator' || name === 'queue-start') {
      void activate($).catch(() => {})
      $.clock.after(1000, () => void rename($).catch(() => {}))
    }
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    // Fire and forget: the pane's bookkeeping never holds up or fails a tool call.
    if (e.agentId !== undefined) void recordTool($, e.agentId, describeCall(e)).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = (await $.state.get(tasks)).value ?? []
    const t = (await $.state.get(now)).value ?? 0
    const seen = (await $.state.get(firstSeen)).value ?? {}
    const tools = (await $.state.get(lastTool)).value ?? {}
    const cap = (await $.state.get(maxWorkers)).value ?? 4
    const peers = (await $.state.get(sessions)).value ?? []
    const agents: AgentInfo[] = (await $.agent.list()).filter(a => !ENDED.includes(a.status))
    // Outside the terminal bodyColumns is only a guess (far too small in the VS Code panel),
    // so there the columns stack, nothing is cut here, and each row truncates at the real edge.
    const native = e.surface !== 'terminal'
    const cut = (s: string, n: number): string =>
      native || s.length <= n ? s : s.slice(0, Math.max(1, n - 3)) + '...'

    // Workers are the agents this session started; the rest hang under the agent that
    // started them.
    const ids = new Set(agents.map(a => a.id))
    const workers = agents.filter(a => a.parentId === undefined || !ids.has(a.parentId))
    const childrenOf = (id: string): AgentInfo[] => agents.filter(a => a.parentId === id)
    const subagents = agents.length - workers.length

    const count = (tag: string): number => list.filter(x => x.tag === tag).length
    const untagged = list.filter(x => x.tag === '')
    // Paused tasks resume first, so they head the Next list.
    const waiting = [...list.filter(x => x.tag === 'paused'), ...untagged]
    const questions = list.filter(x => x.tag === 'question')
    const merged = list.filter(x => x.tag === 'done' && x.merged !== undefined).length
    const unmerged = list.filter(x => x.tag === 'done' && x.merged === undefined).length
    const parts: [number, string][] = [
      [untagged.length, 'waiting'],
      [count('paused'), 'paused'],
      [count('running'), 'running'],
      [questions.length, questions.length === 1 ? 'question' : 'questions'],
      [merged, 'done (merged)'],
      [unmerged, 'done (not merged)'],
      [count('held'), 'held'],
      [count('blocked'), 'blocked'],
      [count('failed'), 'failed'],
    ]
    const summary =
      parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(', ') || 'empty'
    const byAgent = new Map(list.filter(x => x.agent).map(x => [x.agent as string, x]))

    // Columns side by side when the pane is wide enough: workers, then questions and next
    // tasks, then sessions. Narrow panes stack them.
    const body = Math.max(30, e.props.bodyColumns)
    const hasTasks = questions.length > 0 || waiting.length > 0
    const columns = native ? 1 : Math.min(hasTasks ? 3 : 2, body >= 150 ? 3 : body >= 100 ? 2 : 1)
    const colWidth = Math.floor(body / columns) - 2
    const boxWidth = native ? undefined : colWidth

    // Green: running a turn. Yellow: waiting on its own subagents or other background work.
    // Gray: pending or idle.
    const dot = (a: AgentInfo): string =>
      a.status === 'running' ? 'success' : a.status === 'waiting' ? 'warning' : 'inactive'
    const age = (a: AgentInfo): string => {
      const start = seen[a.id]
      return t && start !== undefined ? minutes(t - start) : ''
    }

    const agentRows = (a: AgentInfo, depth: number): JSX.Element[] => {
      const indent = '  '.repeat(depth)
      const task = byAgent.get(a.id) ?? (a.name ? byAgent.get(a.name) : undefined)
      const title = task?.title ?? a.description
      const tool = tools[a.id]?.text ?? ''
      const ageText = age(a)
      const room = colWidth - indent.length - 2 - ageText.length - 1
      const rows: JSX.Element[] = [
        <Text wrap="truncate-end">
          {indent}
          <Text color={dot(a)}>{depth === 0 ? '\u25CF ' : '\u2514 '}</Text>
          {depth === 0 ? <Text bold>{cut(title, room)}</Text> : cut(title, room)}{' '}
          <Text dimColor>{ageText}</Text>
        </Text>,
      ]
      if (tool !== '') {
        rows.push(<Text dimColor wrap="truncate-end">{indent + '    ' + cut(tool, colWidth - indent.length - 4)}</Text>)
      }
      for (const child of childrenOf(a.id)) rows.push(...agentRows(child, depth + 1))
      return rows
    }

    const workerColumn = (
      <Box flexDirection="column" width={boxWidth}>
        <Text>
          <Text bold>Workers {workers.length}/{cap}</Text>
          {subagents > 0 && <Text dimColor> + {subagents} {subagents === 1 ? 'subagent' : 'subagents'}</Text>}
        </Text>
        {workers.length === 0 && <Text dimColor>  none running</Text>}
        {workers.flatMap(w => agentRows(w, 0))}
      </Box>
    )

    const tasksColumn = (
      <Box flexDirection="column" width={boxWidth}>
        {questions.length > 0 && <Text bold>Questions</Text>}
        {questions.map(q => (
          <Text wrap="truncate-end">
            <Text color="warning">? </Text>
            {cut(`${q.title}: ${q.question ?? ''}`, colWidth - 2)}
          </Text>
        ))}
        {waiting.length > 0 && <Text bold>Next</Text>}
        {waiting.slice(0, 5).map(w => (
          <Text dimColor wrap="truncate-end">  {cut(w.title, colWidth - 2)}</Text>
        ))}
        {waiting.length > 5 && <Text dimColor>  and {waiting.length - 5} more</Text>}
      </Box>
    )

    const sessionsColumn = (
      <Box flexDirection="column" width={boxWidth}>
        <Text bold>Sessions</Text>
        {peers.length === 0 && <Text dimColor>  none found</Text>}
        {peers.map(p => (
          <Text wrap="truncate-end">
            {'  '}
            {cut(p.name, colWidth - 14)} <Text dimColor>{cut(p.status, 11)}</Text>
          </Text>
        ))}
      </Box>
    )

    const workerRows = workers.flatMap(w => agentRows(w, 0)).length || 1
    const tasksRows =
      (questions.length > 0 ? 1 + questions.length : 0) +
      (waiting.length > 0 ? 1 + Math.min(5, waiting.length) + (waiting.length > 5 ? 1 : 0) : 0)
    const sessionRows = 1 + Math.max(1, peers.length)
    const tallest =
      columns === 3
        ? Math.max(1 + workerRows, tasksRows, sessionRows)
        : columns === 2
          ? Math.max(1 + workerRows, tasksRows + sessionRows)
          : 1 + workerRows + tasksRows + sessionRows
    wantedRows = 1 + tallest

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>Queue </Text>
          <Text dimColor>{cut(summary, body - 8)}</Text>
        </Text>
        {columns === 3 && (
          <Box flexDirection="row" columnGap={2}>
            {workerColumn}
            {tasksColumn}
            {sessionsColumn}
          </Box>
        )}
        {columns === 2 && (
          <Box flexDirection="row" columnGap={2}>
            {workerColumn}
            <Box flexDirection="column" width={boxWidth}>
              {hasTasks && tasksColumn}
              {sessionsColumn}
            </Box>
          </Box>
        )}
        {columns === 1 && (
          <Box flexDirection="column">
            {workerColumn}
            {hasTasks && tasksColumn}
            {sessionsColumn}
          </Box>
        )}
      </Box>
    )
  })
}
