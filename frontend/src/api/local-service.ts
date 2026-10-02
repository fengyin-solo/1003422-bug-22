import {
  SETTLE_HUMIDITY_MIN,
  SETTLE_WIND_MAX,
  checkFirewatchReadings,
} from '@/data/firewatch-rules'
import {
  CREATE_OP,
  allRows,
  completePendingOp,
  freshRows,
  listRows,
  recordPendingOp,
  resetRows,
  saveRows,
  type PendingOp,
} from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

/**
 * 火险监测点降回「正常」前的边界校验（解除预警 / 登记为正常共用）：
 * 缺数、读数无法识别、越界一律不许降；读数齐全但仍达预警条件也不许降。
 * 只有读数齐全且风力、湿度都回到安全线以下，才算合法降级。
 */
function canSettleFirewatch(meta: ModuleMeta, row: EntryRow, verb: string): ActionResult {
  const check = checkFirewatchReadings(row)
  if (check.problems.length > 0) {
    return {
      ok: false,
      message: `${meta.entity}${check.problems.join('，')}，不能${verb}，请补录读数并现场复检`,
    }
  }
  if (!check.safe) {
    return {
      ok: false,
      message: `${meta.entity}当前风力 ${check.wind} 级、相对湿度 ${check.humidity}% 仍达预警条件（风力 ≤${SETTLE_WIND_MAX} 级且相对湿度 ≥${SETTLE_HUMIDITY_MIN}% 才允许${verb}）`,
    }
  }
  return { ok: true, message: '' }
}

function newOpId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * 状态流转。整个动作只在全部校验通过、待续办记录成功后才落库：
 * - 基于提交前重读的最新数据判断，expectedRevision 对不上说明另一监测端已改过，按冲突拒绝；
 * - 失败不写任何状态，重试同样的动作得到的还是同一个结果；
 * - 落库途中中断（网络 / 存储故障）会把算好的结果记进待续办台账，恢复后从未完成的步骤继续。
 */
export function runAction(key: string, id: number, action: string, expectedRevision?: number): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = freshRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]
  if (
    expectedRevision !== undefined &&
    expectedRevision >= 1 &&
    Number(current.revision ?? 1) !== expectedRevision
  ) {
    return {
      ok: false,
      message: `该${meta.entity}已被另一监测端更新为「${String(current.status)}」，冲突时以现场复检结果为准，请刷新后重试`,
    }
  }
  if (String(current.status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (key === 'firewatch' && target === '正常') {
    const gate = canSettleFirewatch(meta, current, '降回正常')
    if (!gate.ok) {
      return gate
    }
  }
  const settled = meta.settledStatuses.includes(target)
  const updated: EntryRow = {
    ...current,
    status: target,
    pending: !settled,
    // 异常标记只增不悄没声地丢：回到办结态才清除，普通流转保持原样。
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
      ? true
      : settled
        ? false
        : Boolean(current.abnormal),
    revision: Number(current.revision ?? 1) + 1,
  }
  if (key === 'firewatch' && !settled && !checkFirewatchReadings(updated).complete) {
    updated.abnormal = true // 缺数 / 越界的监测点，台账上始终保持异常标记
  }
  const next = [...rows]
  next[index] = updated
  const op: PendingOp = {
    opId: newOpId(),
    key,
    entryId: id,
    action,
    expectedRevision: Number(current.revision ?? 1),
    nextRow: updated,
    createdAt: new Date().toISOString(),
  }
  try {
    recordPendingOp(op)
  } catch {
    return { ok: false, message: `${meta.entity}「${action}」未能登记待续办记录，为免状态错位本次未执行，请重试` }
  }
  try {
    saveRows(key, next)
  } catch {
    return {
      ok: false,
      message: `${meta.entity}「${action}」写入失败（可能网络中断或存储不可用），已记录待续办，恢复后将从未完成的步骤继续`,
    }
  }
  completePendingOp(op.opId)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 登记新记录。业务编号（第一个字段）必填且全库唯一：
 * 两个监测端同时登记同一编号时，提交前重读能发现对方已落库，只保留一条。
 */
export function createEntry(
  key: string,
  values: Record<string, string>,
  initialStatus?: string,
): ActionResult {
  const meta = moduleMeta(key)
  const codeField = meta.fields[0]
  const code = String(values[codeField] ?? '').trim()
  if (!code) {
    return { ok: false, message: `${meta.entity}登记失败：${codeField}不能为空` }
  }
  const status = initialStatus && meta.statuses.includes(initialStatus) ? initialStatus : meta.statuses[0]
  const rows = freshRows(key)
  if (rows.some((row) => String(row[codeField]) === code)) {
    return {
      ok: false,
      message: `${codeField}「${code}」已登记在册（另一监测端可能已提交），同类记录只落库一条，请现场复检核对`,
    }
  }
  const draft: EntryRow = {
    id: rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
    status,
    pending: !meta.settledStatuses.includes(status),
    abnormal: false,
    revision: 1,
  }
  for (const field of meta.fields) {
    draft[field] = String(values[field] ?? '').trim()
  }
  if (key === 'firewatch') {
    if (status === '正常') {
      const gate = canSettleFirewatch(meta, draft, '登记为正常')
      if (!gate.ok) {
        return gate
      }
    }
    if (!checkFirewatchReadings(draft).complete) {
      draft.abnormal = true
    }
  }
  const op: PendingOp = {
    opId: newOpId(),
    key,
    entryId: Number(draft.id),
    action: CREATE_OP,
    expectedRevision: null,
    nextRow: draft,
    createdAt: new Date().toISOString(),
  }
  try {
    recordPendingOp(op)
  } catch {
    return { ok: false, message: `${meta.entity}登记未能写入待续办记录，为免重复落库本次未执行，请重试` }
  }
  try {
    saveRows(key, [...rows, draft])
  } catch {
    return {
      ok: false,
      message: `${meta.entity}登记写入失败（可能网络中断或存储不可用），已记录待续办，恢复后将从未完成的步骤继续`,
    }
  }
  completePendingOp(op.opId)
  return { ok: true, message: `${meta.entity}已登记，${codeField} ${code}，当前状态「${status}」` }
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
    const entries = rows[meta.key] ?? []
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
  ]
  return { cards, modules }
}
