import type { EntryRow } from './types'

// 火险监测读数规则：缺数、越界与合法降级的边界统一收在这里，
// 服务层（local-service）与存储修复（local-store）共用一份，页面不再各自判断。

/** 蒲福风级有效上限（0–17 级）。 */
export const WIND_LEVEL_MAX = 17
/** 相对湿度有效范围（%）。 */
export const HUMIDITY_MIN = 0
export const HUMIDITY_MAX = 100
/** 合法降级阈值：风力不超过 4 级且相对湿度不低于 40%，才允许降回「正常」。 */
export const SETTLE_WIND_MAX = 4
export const SETTLE_HUMIDITY_MIN = 40

export type ReadingCheck = {
  wind: number | null
  humidity: number | null
  /** 缺数 / 无法识别 / 越界 的问题描述；为空表示读数齐全有效。 */
  problems: string[]
  /** 读数齐全且在有效范围内。 */
  complete: boolean
  /** 齐全且低于预警阈值，满足合法降级条件。 */
  safe: boolean
}

/** 解析风力等级：接受「3」「3级」「3 级」，其余视为无法识别。 */
export function parseWindLevel(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null
  }
  const text = String(raw).trim()
  if (!text) {
    return null
  }
  const matched = text.match(/^(-?\d+(?:\.\d+)?)\s*级?$/)
  return matched ? Number(matched[1]) : null
}

/** 解析相对湿度：接受「45」「45%」「45％」，其余视为无法识别。 */
export function parseHumidity(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null
  }
  const text = String(raw).trim()
  if (!text) {
    return null
  }
  const matched = text.match(/^(-?\d+(?:\.\d+)?)\s*[%％]?$/)
  return matched ? Number(matched[1]) : null
}

/** 检查监测点读数：缺数、无法识别、越界都会记进 problems。 */
export function checkFirewatchReadings(row: EntryRow | Record<string, unknown>): ReadingCheck {
  const problems: string[] = []

  const windRaw = (row as Record<string, unknown>)['风力等级']
  const wind = parseWindLevel(windRaw)
  if (wind === null) {
    problems.push(
      String(windRaw ?? '').trim() === '' ? '缺少风力数据' : `风力等级读数「${String(windRaw)}」无法识别`,
    )
  } else if (wind < 0 || wind > WIND_LEVEL_MAX) {
    problems.push(`风力等级 ${wind} 级超出 0–${WIND_LEVEL_MAX} 级有效范围`)
  }

  const humidityRaw = (row as Record<string, unknown>)['相对湿度']
  const humidity = parseHumidity(humidityRaw)
  if (humidity === null) {
    problems.push(
      String(humidityRaw ?? '').trim() === '' ? '缺少湿度读数' : `相对湿度读数「${String(humidityRaw)}」无法识别`,
    )
  } else if (humidity < HUMIDITY_MIN || humidity > HUMIDITY_MAX) {
    problems.push(`相对湿度 ${humidity}% 超出 ${HUMIDITY_MIN}–${HUMIDITY_MAX}% 有效范围`)
  }

  const complete = problems.length === 0
  const safe =
    complete && wind !== null && humidity !== null && wind <= SETTLE_WIND_MAX && humidity >= SETTLE_HUMIDITY_MIN
  return { wind, humidity, problems, complete, safe }
}
