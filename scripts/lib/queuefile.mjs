// Reading .claude/queue/queue.md: tasks separated by "---" lines, the first line the title
// with an optional [tag], "> key: value" lines under it the coordinator's notes. The pane
// parses the same format in hooks/register.tsx.
import fs from 'node:fs'
import path from 'node:path'

import { queueDir } from './repo.mjs'

export function parseQueue(text) {
  const found = []
  let block = []
  const flush = () => {
    const lines = block.map(l => l.trim()).filter(l => l !== '')
    block = []
    const head = lines.find(l => !l.startsWith('>'))
    if (head === undefined) return
    const m = /^\[([a-z ]+)\]\s*(.*)$/i.exec(head)
    const task = { title: m?.[2] ?? head, tag: m?.[1]?.toLowerCase() ?? '', notes: {} }
    for (const line of lines) {
      const note = /^>\s*([a-z-]+):\s*(.*)$/i.exec(line)
      if (note) (task.notes[note[1].toLowerCase()] ??= []).push(note[2].trim())
    }
    if (task.tag !== 'notes') found.push(task)
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '---') flush()
    else block.push(line)
  }
  flush()
  return found
}

export function readQueue(root) {
  try {
    return parseQueue(fs.readFileSync(path.join(queueDir(root), 'queue.md'), 'utf8'))
  } catch {
    return []
  }
}

// The first value of a note, or undefined.
export function note(task, key) {
  return task.notes[key]?.[0]
}
