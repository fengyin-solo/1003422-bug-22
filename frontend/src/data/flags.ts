import { MODULE_BY_KEY } from './modules'
import { FIREWATCH_STATUSES } from './firewatch-rules'
import type { EntryRow } from './types'

// 会写进数据的「往回走」动作：命中目标态就按异常态统计，与 local-service 原有口径一致。
export const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// pending / abnormal 不再各自存一份：统一由当前状态派生，台账与处置面板读同一口径，杜绝错位。
function abnormalStatuses(key: string): Set<string> {
  const meta = MODULE_BY_KEY.get(key)
  const statuses = new Set<string>()
  if (meta) {
    for (const [action, target] of Object.entries(meta.actionTargets)) {
      if (NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))) {
        statuses.add(target)
      }
    }
  }
  // 火险点：橙色、红色预警视为异常量。
  if (key === 'firewatch') {
    statuses.add('橙色预警')
    statuses.add('红色预警')
  }
  return statuses
}

export function derivePending(key: string, status: string): boolean {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta || meta.statuses.length === 0) {
    return false
  }
  // 末态（各模块状态表最后一个）之外都算待处理；火险点只有「正常」是末态。
  return status !== meta.statuses[meta.statuses.length - 1]
}

export function deriveAbnormal(key: string, status: string): boolean {
  return abnormalStatuses(key).has(status)
}

// 火险点特殊：预警态（含蓝色/黄色）都要跟进，只有正常不算待处理。
export function normalizeFlags(key: string, row: EntryRow): EntryRow {
  const status = String(row.status)
  if (key === 'firewatch') {
    return {
      ...row,
      status,
      pending: status !== FIREWATCH_STATUSES[0],
      abnormal: status === '橙色预警' || status === '红色预警',
    }
  }
  return {
    ...row,
    status,
    pending: derivePending(key, status),
    abnormal: deriveAbnormal(key, status),
  }
}
