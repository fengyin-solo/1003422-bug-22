import { SEED_ROWS } from './seed'
import { MODULE_BY_KEY } from './modules'
import { normalizeFlags } from './flags'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
const SCHEMA_KEY = 'forest-fire-patrol:schema'
const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedData(): Record<string, EntryRow[]> {
  // 示例数据里的 pending/abnormal 也走同源派生，避免播种口径和台账口径不一致。
  const seeded = clone(SEED_ROWS)
  for (const key of Object.keys(seeded)) {
    seeded[key] = seeded[key].map((row) => normalizeFlags(key, row))
  }
  return seeded
}

// 迁移只修「状态派生标志」和并发版本号，绝不按新阈值重算历史火险等级。
function migrate(parsed: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  for (const key of Object.keys(parsed)) {
    if (!MODULE_BY_KEY.has(key)) {
      continue
    }
    parsed[key] = (parsed[key] ?? []).map((row) => {
      const normalized = normalizeFlags(key, row)
      return { ...normalized, revision: Number(row.revision ?? 1) }
    })
  }
  return parsed
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = seedData()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const storedVersion = Number(window.localStorage.getItem(SCHEMA_KEY) ?? '1')
    const merged = { ...fallback, ...parsed }
    const result = storedVersion < SCHEMA_VERSION ? migrate(merged) : merged
    if (storedVersion < SCHEMA_VERSION) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(result))
      window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
    }
    return result
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function getRow(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

export type SaveOutcome =
  | { ok: true; rows: EntryRow[] }
  // 乐观锁冲突：另一个监测端已经先落库，当前 revision 过期（冲突以现场复检为准时 force 覆盖）。
  | { ok: false; reason: 'conflict'; current: EntryRow }
  | { ok: false; reason: 'missing' }

// 条件更新：revision 对得上才落库，两个监测端并发提交同一行时只有一条能成功。
export function updateRow(
  key: string,
  id: number,
  patch: Partial<EntryRow>,
  expectedRevision?: number,
  force = false,
): SaveOutcome {
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, reason: 'missing' }
  }
  const current = rows[index]
  const baseRevision = Number(current.revision ?? 1)
  if (!force && expectedRevision !== undefined && expectedRevision !== baseRevision) {
    return { ok: false, reason: 'conflict', current }
  }
  const nextRow = normalizeFlags(key, {
    ...current,
    ...patch,
    revision: baseRevision + 1,
  })
  const nextRows = [...rows]
  nextRows[index] = nextRow
  persist(nextRows, key)
  return { ok: true, rows: nextRows }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const normalized = rows.map((row) => normalizeFlags(key, row))
  persist(normalized, key)
}

function persist(rows: EntryRow[], changedKey: string): void {
  const next = { ...allRows(), [changedKey]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 另一个监测端（标签页）落库后，本端缓存直接失效重读，避免拿旧 revision 再覆盖。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function invalidateCache(): void {
  cache = null
}

export function resetRows(key: string): EntryRow[] {
  const rows = seedData()[key] ?? []
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
