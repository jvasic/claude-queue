export type QueueTask = {
  title: string
  tag: string
  branch?: string
  agent?: string
  question?: string
  merged?: string
}

export type ToolSeen = { text: string; at: number }

export type PeerSession = { name: string; status: string; kind: string }

declare module 'claude-code' {
  interface PluginState {
    'task-queue': {
      isActive: boolean
      tasks: QueueTask[]
      maxWorkers: number
      lastTool: Record<string, ToolSeen>
      firstSeen: Record<string, number>
      now: number
      nickname: string
      sessions: PeerSession[]
    }
  }
}
