// 操作持久化日志：动作拆成「校验 → 台账落库 → 面板上报」顺序步骤。
// 每完成一步就把进度写进 localStorage；网络中断后再次提交同一动作时，
// 从未完成的步骤继续，不会重复落库（两个监测端并发更新时只落库一条）。

export type OutboxEntry = {
  /** 业务幂等键：模块 + 记录 + 动作，同一动作的失败重试天然命中同一条 */
  key: string
  module: string
  id: number
  action: string
  /** 动作发起时评估出的目标状态：续跑时不依赖当前台账反推 */
  target: string
  createdAt: string
  updatedAt: string
  /** 顺序步骤：ledger=监测台账落库，panel=处置面板状态上报 */
  steps: { name: string; done: boolean; at?: string }[]
  /** 已被现场复检等更新动作作废的陈旧待办 */
  superseded: boolean
  resultMessage: string
}

const OUTBOX_KEY = 'forest-fire-patrol:outbox'
const KEEP_DONE = 50

function nowIso(): string {
  return new Date().toISOString()
}

function readAll(): OutboxEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(OUTBOX_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as OutboxEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(entries: OutboxEntry[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries))
}

export function naturalKey(module: string, id: number, action: string): string {
  return `${module}:${id}:${action}`
}

export function findPending(key: string): OutboxEntry | undefined {
  return readAll().find((entry) => entry.key === key && !isFinished(entry) && !entry.superseded)
}

export function isFinished(entry: OutboxEntry): boolean {
  return entry.steps.length > 0 && entry.steps.every((step) => step.done)
}

export function createEntry(input: {
  module: string
  id: number
  action: string
  target: string
  resultMessage: string
}): OutboxEntry {
  const entries = readAll()
  // 新动作开始时先清掉同键的历史完成记录，保留窗口内其它动作的完成记录。
  const retained = entries.filter((entry) => entry.key !== naturalKey(input.module, input.id, input.action))
  const stamp = nowIso()
  const entry: OutboxEntry = {
    key: naturalKey(input.module, input.id, input.action),
    module: input.module,
    id: input.id,
    action: input.action,
    target: input.target,
    createdAt: stamp,
    updatedAt: stamp,
    steps: [
      { name: 'ledger', done: false },
      { name: 'panel', done: false },
    ],
    superseded: false,
    resultMessage: input.resultMessage,
  }
  writeAll([entry, ...retained].slice(0, KEEP_DONE))
  return entry
}

export function markStep(entry: OutboxEntry, stepName: string): OutboxEntry {
  const entries = readAll()
  const index = entries.findIndex((item) => item.key === entry.key)
  const target = (index >= 0 ? entries[index] : entry) as OutboxEntry
  const updated: OutboxEntry = {
    ...target,
    updatedAt: nowIso(),
    steps: target.steps.map((step) =>
      step.name === stepName && !step.done ? { ...step, done: true, at: nowIso() } : step,
    ),
  }
  if (index >= 0) {
    entries[index] = updated
    writeAll(entries)
  }
  return updated
}

export function updateMessage(key: string, resultMessage: string): void {
  const entries = readAll()
  const index = entries.findIndex((item) => item.key === key)
  if (index >= 0) {
    entries[index] = { ...entries[index], resultMessage, updatedAt: nowIso() }
    writeAll(entries)
  }
}

// 同一行出现更新的现场结论时，此前未上报完的旧动作直接作废，不再向处置面板推陈旧状态。
export function supersedeRow(module: string, id: number, exceptKey?: string): void {
  const entries = readAll()
  let changed = false
  for (const entry of entries) {
    if (
      entry.module === module &&
      entry.id === id &&
      !isFinished(entry) &&
      entry.key !== exceptKey
    ) {
      entry.superseded = true
      entry.updatedAt = nowIso()
      changed = true
    }
  }
  if (changed) {
    writeAll(entries)
  }
}

// 台账落库就失败（如并发冲突）时，本次操作日志整体作废，重试必须重新走完整校验。
export function voidEntry(key: string): void {
  const entries = readAll()
  const index = entries.findIndex((item) => item.key === key)
  if (index >= 0) {
    entries[index] = { ...entries[index], superseded: true, updatedAt: nowIso() }
    writeAll(entries)
  }
}

export function pruneFinished(): void {
  const entries = readAll()
  const pending = entries.filter((entry) => !isFinished(entry) && !entry.superseded)
  const done = entries.filter((entry) => isFinished(entry) || entry.superseded)
  writeAll([...pending, ...done.slice(0, KEEP_DONE - pending.length)])
}

export function pendingEntries(): OutboxEntry[] {
  return readAll().filter((entry) => !isFinished(entry) && !entry.superseded)
}

export function pendingCount(): number {
  return pendingEntries().length
}

// 断网恢复后：从第一条未完成日志的未完成步骤继续跑，已完成的步骤不重复执行。
export function resumeAll(
  runStep: (entry: OutboxEntry, stepName: string) => void,
): { resumed: number; finished: number } {
  const pending = pendingEntries()
  let finished = 0
  for (const entry of pending) {
    for (const step of entry.steps) {
      if (!step.done) {
        runStep(entry, step.name)
      }
    }
    const latest = findPending(entry.key)
    if (!latest || isFinished(latest)) {
      finished += 1
    }
  }
  if (pending.length > 0) {
    pruneFinished()
  }
  return { resumed: pending.length, finished }
}
