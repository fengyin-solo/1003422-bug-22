import { checkFirewatchReadings } from './firewatch-rules'
import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// 上一份完好数据的备份：主数据写坏（比如写到一半中断）时从备份恢复，而不是直接回到示例数据。
const BACKUP_KEY = 'forest-fire-patrol:entries-backup'
// 待续办台账：记到一半中断的动作写在这里，恢复后从未完成的步骤继续。
const JOURNAL_KEY = 'forest-fire-patrol:pending-ops'

/** 登记动作在待续办台账里的标记。 */
export const CREATE_OP = '__create__'

export type PendingOp = {
  opId: string
  key: string
  entryId: number
  action: string
  /** 提交时基于的版本；续办时发现版本已变，说明另一监测端已落库，按冲突处理。 */
  expectedRevision: number | null
  /** 校验通过后算好的目标行，续办时直接落库，不重新走校验。 */
  nextRow: EntryRow
  createdAt: string
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!storageAvailable()) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    // 主数据损坏：先尝试备份，备份也坏了才回到示例数据，不能一声不吭把台账清空。
    const backup = window.localStorage.getItem(BACKUP_KEY)
    if (backup) {
      try {
        const parsed = JSON.parse(backup) as Record<string, EntryRow[]>
        return { ...fallback, ...parsed }
      } catch {
        // 备份同样损坏，落到示例数据。
      }
    }
    return fallback
  }
}

/**
 * 修复既有数据（每次读入都跑，幂等）：
 * - 按各模块办结态重算 pending，让台账与处置面板的待办口径一致；
 * - 补齐并发版本号 revision；
 * - 火险监测点缺数 / 读数越界的，保持异常标记，「正常」但读数不全的一律回到待办。
 * 只修派生标记，不改 status 与业务字段：历史火险等级按当时阈值保留。
 */
export function normalizeRows(rows: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const [key, list] of Object.entries(rows)) {
    const meta = MODULE_BY_KEY.get(key)
    if (!meta || !Array.isArray(list)) {
      next[key] = list
      continue
    }
    next[key] = list.map((row) => {
      const status = String(row.status ?? '')
      const settled = meta.settledStatuses.includes(status)
      const repaired: EntryRow = {
        ...row,
        revision: Number(row.revision) >= 1 ? Number(row.revision) : 1,
        pending: !settled,
      }
      if (key === 'firewatch' && !checkFirewatchReadings(repaired).complete) {
        repaired.abnormal = true
        if (settled) {
          // 缺数却挂着「正常」：不能当作已办结，留待现场复检补录。
          repaired.pending = true
        }
      }
      return repaired
    })
  }
  return next
}

/** 落库：先写 localStorage 再换缓存，写失败时内存与磁盘不脱节。 */
function persistAll(next: Record<string, EntryRow[]>): void {
  if (storageAvailable()) {
    const previous = window.localStorage.getItem(STORAGE_KEY)
    if (previous !== null) {
      try {
        window.localStorage.setItem(BACKUP_KEY, previous)
      } catch {
        // 备份写不进去不阻断主流程。
      }
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

function readJournal(): PendingOp[] {
  if (!storageAvailable()) {
    return []
  }
  const raw = window.localStorage.getItem(JOURNAL_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as PendingOp[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeJournal(ops: PendingOp[]): void {
  if (!storageAvailable()) {
    return
  }
  if (ops.length === 0) {
    window.localStorage.removeItem(JOURNAL_KEY)
    return
  }
  window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(ops))
}

/** 动作落库前先记一笔待续办；记录失败就整体放弃，不留半成品。 */
export function recordPendingOp(op: PendingOp): void {
  writeJournal([...readJournal(), op])
}

/** 动作落库完成后销账；销账失败没关系，续办时会幂等地跳过已完成的行。 */
export function completePendingOp(opId: string): void {
  try {
    writeJournal(readJournal().filter((op) => op.opId !== opId))
  } catch {
    // 留待 resumePendingOps 幂等处理。
  }
}

/**
 * 网络 / 存储中断恢复：把待续办台账里没走完的步骤继续走完。
 * - 目标行已是预期结果：幂等跳过；
 * - 目标行还停在提交时的版本：直接把算好的结果落库（从断点继续，不重新校验）；
 * - 版本已被另一监测端推进：冲突，以现场复检（已落库状态）为准，丢弃续办。
 */
export function resumePendingOps(): void {
  const ops = readJournal()
  if (ops.length === 0) {
    return
  }
  const remaining: PendingOp[] = []
  for (const op of ops) {
    try {
      const raw = readStorage()
      const rows = raw[op.key] ?? []
      if (op.action === CREATE_OP) {
        const codeField = MODULE_BY_KEY.get(op.key)?.fields[0]
        const exists =
          codeField !== undefined && rows.some((row) => String(row[codeField]) === String(op.nextRow[codeField]))
        if (!exists) {
          raw[op.key] = [...rows, clone(op.nextRow)]
          persistAll(raw)
        }
        continue
      }
      const index = rows.findIndex((row) => Number(row.id) === op.entryId)
      if (index < 0) {
        continue
      }
      const current = rows[index]
      const currentRevision = Number(current.revision ?? 1)
      const targetRevision = Number(op.nextRow.revision ?? 0)
      if (currentRevision === targetRevision && String(current.status) === String(op.nextRow.status)) {
        continue // 已经落过库，幂等跳过
      }
      if (op.expectedRevision !== null && currentRevision === op.expectedRevision) {
        const next = [...rows]
        next[index] = clone(op.nextRow)
        raw[op.key] = next
        persistAll(raw)
      }
      // 其余情况：另一监测端已更新，冲突以现场复检（已落库状态）为准，丢弃这条续办。
    } catch {
      remaining.push(op) // 仍然写不进去：留在台账里，下次恢复后继续
    }
  }
  try {
    writeJournal(remaining)
  } catch {
    // 台账本身写失败时保持原样，下次再试。
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    resumePendingOps()
    const raw = readStorage()
    const repaired = normalizeRows(raw)
    if (JSON.stringify(repaired) !== JSON.stringify(raw)) {
      try {
        persistAll(repaired)
      } catch {
        // 修复结果写不回去就用内存里的修复版，下次启动再试。
      }
    }
    cache = repaired
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 提交前重读：绕过缓存直接看 localStorage，另一监测端刚写的内容也能看到。 */
export function freshRows(key: string): EntryRow[] {
  return readStorage()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  // 提交前重读再合并：另一监测端写过的其他模块不被旧缓存覆盖。
  const next = { ...readStorage(), [key]: rows }
  persistAll(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = normalizeRows({ [key]: clone(SEED_ROWS[key] ?? []) })[key] ?? []
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 另一监测端（另一个标签页）落了库，或网络恢复：丢掉缓存重读，并把没走完的续办走完。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === JOURNAL_KEY || event.key === null) {
      cache = null
    }
  })
  window.addEventListener('online', () => {
    cache = null
    resumePendingOps()
  })
}
