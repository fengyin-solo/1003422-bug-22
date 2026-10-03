import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  getRow,
  invalidateCache,
  listRows,
  resetRows,
  saveRows,
  updateRow,
} from '@/data/local-store'
import { normalizeFlags, NEGATIVE_ACTIONS } from '@/data/flags'
import {
  blockingIssue,
  evaluateStatus,
  inspectReadings,
  levelIndex,
  THRESHOLD_VERSION,
  type ReadingInspection,
} from '@/data/firewatch-rules'
import {
  createEntry,
  findPending,
  markStep,
  naturalKey,
  pendingCount as outboxPendingCount,
  resumeAll,
  supersedeRow,
  updateMessage,
  voidEntry,
  type OutboxEntry,
} from '@/data/outbox'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 处置面板同步：纯前端环境没有真实后端，用 localStorage 可达性模拟网络通道；
// 断网时抛错，由操作日志保证下一次从这一步续传，而不是重做台账落库。
function syncToPanel(entry: OutboxEntry): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('处置面板通道不可用')
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('网络中断，处置面板暂不可达')
  }
  const row = getRow(entry.module, entry.id)
  if (row) {
    const synced = String(row.status ?? '')
    updateMessage(
      entry.key,
      `${MODULE_BY_KEY.get(entry.module)?.entity ?? '记录'}已${entry.action}，当前状态「${synced}」`,
    )
  }
}

type FirewatchDecision =
  | { ok: true; target: string; force: boolean; patch: Partial<EntryRow>; message: string }
  | { ok: false; message: string }

// 火险点动作的唯一业务口径：缺数不能降级、越界必须退回核对、合法降级按当前阈值评估。
function resolveFirewatchAction(
  meta: ModuleMeta,
  action: string,
  row: EntryRow,
): FirewatchDecision {
  const inspection = inspectReadings(row)
  const current = String(row.status)
  const stamp = new Date().toISOString()

  if (action === '解除预警') {
    if (current === '正常') {
      return { ok: false, message: `${meta.entity}已经是「正常」，不用重复解除` }
    }
    // 边界处理落在服务层：缺风力/湿度读数时保持原预警，不允许靠入口隐藏放过去。
    const issue = blockingIssue(inspection)
    if (issue) {
      return {
        ok: false,
        message: `${meta.entity}${issue}，按缺数保守策略维持「${current}」，补齐读数并现场复检后再解除`,
      }
    }
    const target = evaluateStatus(inspection)
    if (target !== '正常') {
      return {
        ok: false,
        message: `${meta.entity}当前读数评估仍为「${target}」，不满足解除条件，预警维持不变`,
      }
    }
    // 齐套读数评估确为正常，属于合法降级，可以解除。
    return {
      ok: true,
      target,
      force: false,
      message: `${meta.entity}读数齐套且评估为正常，预警已合法解除`,
      patch: {
        火险等级: target,
        监测状态: target,
        评估时间: stamp,
        阈值版本: THRESHOLD_VERSION,
      },
    }
  }

  if (action === '更新等级') {
    const issue = blockingIssue(inspection)
    if (issue) {
      return {
        ok: false,
        message: `${meta.entity}${issue}，无法重新评估，等级维持「${current}」`,
      }
    }
    const target = evaluateStatus(inspection)
    if (target === current) {
      return { ok: false, message: `${meta.entity}按当前阈值评估仍为「${target}」，等级未变化` }
    }
    return {
      ok: true,
      target,
      force: false,
      message: `${meta.entity}按当前阈值重新评估为「${target}」（${THRESHOLD_VERSION} 版阈值）`,
      patch: {
        火险等级: target,
        监测状态: target,
        评估时间: stamp,
        阈值版本: THRESHOLD_VERSION,
      },
    }
  }

  if (action === '升级预警') {
    const issue = blockingIssue(inspection)
    if (issue) {
      return {
        ok: false,
        message: `${meta.entity}${issue}，不能仅凭操作升级预警，请补齐现场读数`,
      }
    }
    const target = evaluateStatus(inspection)
    if (levelIndex(target) <= levelIndex(current)) {
      return {
        ok: false,
        message: `${meta.entity}当前读数评估为「${target}」，未高于「${current}」，不能升级`,
      }
    }
    return {
      ok: true,
      target,
      force: false,
      message: `${meta.entity}读数评估升级为「${target}」`,
      patch: {
        火险等级: target,
        监测状态: target,
        评估时间: stamp,
        阈值版本: THRESHOLD_VERSION,
      },
    }
  }

  if (action === '现场复检') {
    // 冲突时以现场复检为准：同样要校验读数，但允许带 force 覆盖过期版本。
    const issue = blockingIssue(inspection)
    if (issue) {
      return {
        ok: false,
        message: `${meta.entity}${issue}，复检结论不成立，请先补测风力、湿度后再提交`,
      }
    }
    const target = evaluateStatus(inspection)
    return {
      ok: true,
      target,
      force: true,
      message: `${meta.entity}现场复检完成，结论「${target}」，覆盖此前冲突状态`,
      patch: {
        火险等级: target,
        监测状态: target,
        评估时间: stamp,
        阈值版本: THRESHOLD_VERSION,
        复检时间: stamp,
      },
    }
  }

  return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
}

export type RunActionOptions = {
  expectedRevision?: number
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: RunActionOptions = {},
): ActionResult {
  const meta = moduleMeta(key)
  const row = getRow(key, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  const opKey = naturalKey(key, id, action)

  // 失败重试优先于一切业务前置校验：首次提交后等级可能已按读数落库，
  // 重试的唯一职责是把未完成的步骤跑完，业务规则不得把它挡在门外。
  const pendingEntry = findPending(opKey)
  if (pendingEntry) {
    return continueEntry(pendingEntry, options.expectedRevision)
  }

  // 乐观锁前置校验：显式带了旧版本号且已被他人推进时，直接判冲突，
  // 不能被「已经是该状态」之类的幂等提示吞掉（两个监测端并发只落库一条）。
  if (options.expectedRevision !== undefined) {
    const currentRevision = Number(row.revision ?? 1)
    const isForcedRecheck = key === 'firewatch' && action === '现场复检'
    if (!isForcedRecheck && options.expectedRevision !== currentRevision) {
      return {
        ok: false,
        conflict: true,
        message: `${meta.entity}已被另一监测端更新为「${String(row.status)}」，本次更新未落库；如确认现场结论，请执行「现场复检」`,
      }
    }
  }

  // 业务校验：火险点走读数规则，其它模块走登记的静态流转。
  let target: string
  let force = false
  let patch: Partial<EntryRow> = {}
  if (key === 'firewatch') {
    const decision = resolveFirewatchAction(meta, action, row)
    if (!decision.ok) {
      return { ok: false, message: decision.message }
    }
    target = decision.target
    force = decision.force
    patch = decision.patch
  } else {
    const mapped = meta.actionTargets[action]
    if (!mapped) {
      return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
    }
    target = mapped
    if (String(row.status) === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
  }

  const entry = createEntry({
    module: key,
    id,
    action,
    target,
    resultMessage: '',
  })

  // 第二步（台账落库）：条件更新，并发提交同一行时只有一条能写进去。
  const saveOutcome = updateRow(
    key,
    id,
    { ...patch, status: target },
    force ? undefined : options.expectedRevision ?? Number(row.revision ?? 1),
    force,
  )
  if (saveOutcome.ok === false) {
    if (saveOutcome.reason === 'conflict') {
      const currentStatus = String(saveOutcome.current.status)
      // 未落库的日志作废，避免重试绕过读数校验把旧目标补写进去。
      voidEntry(opKey)
      return {
        ok: false,
        conflict: true,
        message: `${meta.entity}已被另一监测端更新为「${currentStatus}」，本次更新未落库；如确认现场结论，请执行「现场复检」`,
      }
    }
    voidEntry(opKey)
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  markStep(entry, 'ledger')
  // 现场复检结论优先：同行此前未上报完的旧动作作废，处置面板只收到最新结论。
  supersedeRow(key, id, opKey)

  // 第三步（处置面板上报）：断网时保留进度，恢复网络后从这一步继续。
  return finishPanel(entry)
}

function continueEntry(entry: OutboxEntry, expectedRevision?: number): ActionResult {
  const meta = moduleMeta(entry.module)
  const row = getRow(entry.module, entry.id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${entry.id} 的${meta.entity}` }
  }
  // 台账步骤若没完成（极端情况下重试发生在落库瞬间），用日志里的目标状态补做一次。
  if (!entry.steps.find((step) => step.name === 'ledger')?.done) {
    const target = entry.target
    if (!target) {
      return { ok: false, message: `${meta.entity}操作「${entry.action}」缺少目标状态，请重新发起` }
    }
    const saveOutcome = updateRow(entry.module, entry.id, { status: target }, expectedRevision)
    if (saveOutcome.ok === false && saveOutcome.reason === 'conflict') {
      voidEntry(entry.key)
      return {
        ok: false,
        conflict: true,
        message: `${meta.entity}已被另一监测端更新，挂起的操作已作废，请刷新后以现场复检为准`,
      }
    }
    markStep(entry, 'ledger')
  }
  const result = finishPanel(findPending(entry.key) ?? entry)
  return {
    ...result,
    message: result.ok
      ? `${result.message}（已从上次中断的步骤继续，未重复落库）`
      : result.message,
  }
}

function finishPanel(entry: OutboxEntry): ActionResult {
  const latest = findPending(entry.key) ?? entry
  const panelStep = latest.steps.find((step) => step.name === 'panel')
  if (panelStep?.done) {
    return { ok: true, message: latest.resultMessage || '操作已完成' }
  }
  try {
    syncToPanel(latest)
    const done = markStep(latest, 'panel')
    return { ok: true, message: done.resultMessage || '操作已完成' }
  } catch {
    const afterLedger = findPending(entry.key) ?? latest
    return {
      ok: true,
      pendingSync: true,
      message: `台账已落库为「${statusOf(afterLedger)}」，处置面板上报因网络中断挂起，恢复网络后从未完成步骤继续`,
    }
  }
}

function statusOf(entry: OutboxEntry): string {
  return String(getRow(entry.module, entry.id)?.status ?? '未知状态')
}

// 断网恢复/手动触发：续跑所有挂起的面板上报，已落库步骤不重做。
export function resumePendingActions(): { resumed: number; finished: number } {
  return resumeAll((entry, stepName) => {
    if (stepName === 'panel') {
      try {
        syncToPanel(entry)
        markStep(entry, stepName)
      } catch {
        // 仍未恢复：保留在日志里，等下一次网络恢复。
      }
    }
  })
}

export function pendingSyncCount(): number {
  return outboxPendingCount()
}

// 清空 localStorage 后调用：强制下次读盘并重新播种，供测试与排障使用。
export function resetLocalState(): void {
  invalidateCache()
}

export function firewatchReadingInspection(row: EntryRow): ReadingInspection {
  return inspectReadings(row)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = (rows[meta.key] ?? []).map((row) => normalizeFlags(meta.key, row))
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '处置面板待续传', value: outboxPendingCount() },
  ]
  return { cards, modules }
}
