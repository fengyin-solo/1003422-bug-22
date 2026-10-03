import type { EntryRow } from './types'

// 火险监测读数校验与等级评估规则。
// 阈值带版本号：每次调整阈值只升版本，评估动作把当前版本盖到记录上；
// 历史记录按行内留存的「阈值版本」保留当时等级，任何迁移都不回算（历史火险等级按当时阈值保留）。
export const THRESHOLD_VERSION = '2026-09'

export const FIREWATCH_STATUSES = ['正常', '蓝色预警', '黄色预警', '橙色预警', '红色预警'] as const
export type FirewatchStatus = (typeof FIREWATCH_STATUSES)[number]

export type ReadingField = '风力等级' | '相对湿度' | '气温读数'

export type ReadingInspection = {
  wind: number | null
  humidity: number | null
  temperature: number | null
  /** 缺数：空值或读不出合法数值 */
  missing: ReadingField[]
  /** 越界：读得出数值，但超出站点合理量程 */
  outOfRange: ReadingField[]
}

// 各读数的合理量程，越界读数一律不参与评估、直接退回人工核对。
export const READING_RANGES: Record<ReadingField, [number, number]> = {
  风力等级: [0, 12],
  相对湿度: [0, 100],
  气温读数: [-50, 50],
}

// 降级/解除前必须齐套的读数；气温允许缺测，但越界仍拦截。
export const REQUIRED_FOR_DOWNGRADE: ReadingField[] = ['风力等级', '相对湿度']

function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') {
      return null
    }
    const value = Number(text)
    return Number.isFinite(value) ? value : null
  }
  return null
}

export function inspectReadings(row: EntryRow): ReadingInspection {
  const fields = Object.keys(READING_RANGES) as ReadingField[]
  const values = {
    风力等级: parseNumber(row.风力等级),
    相对湿度: parseNumber(row.相对湿度),
    气温读数: parseNumber(row.气温读数),
  }
  const missing: ReadingField[] = []
  const outOfRange: ReadingField[] = []
  for (const field of fields) {
    const value = values[field]
    if (value === null) {
      missing.push(field)
      continue
    }
    const [min, max] = READING_RANGES[field]
    if (value < min || value > max) {
      outOfRange.push(field)
    }
  }
  return {
    wind: values.风力等级,
    humidity: values.相对湿度,
    temperature: values.气温读数,
    missing,
    outOfRange,
  }
}

function windScore(wind: number): number {
  if (wind >= 7) return 8
  if (wind >= 6) return 6
  if (wind >= 4) return 2
  return 0
}

function humidityScore(humidity: number): number {
  if (humidity < 20) return 8
  if (humidity < 25) return 6
  if (humidity < 40) return 4
  if (humidity < 55) return 2
  return 0
}

function temperatureScore(temperature: number): number {
  if (temperature >= 35) return 4
  if (temperature >= 30) return 4
  if (temperature >= 20) return 2
  return 0
}

// 只在读数齐套且不越界时调用：评估出来的就是当前阈值下该落的等级。
export function evaluateStatus(inspection: ReadingInspection): FirewatchStatus {
  const wind = inspection.wind ?? 0
  const humidity = inspection.humidity ?? 100
  const temperature = inspection.temperature ?? 0
  const score = windScore(wind) + humidityScore(humidity) + temperatureScore(temperature)
  if (score >= 18) return '红色预警'
  if (score >= 12) return '橙色预警'
  if (score >= 8) return '黄色预警'
  if (score >= 4) return '蓝色预警'
  return '正常'
}

export function levelIndex(status: string): number {
  return FIREWATCH_STATUSES.indexOf(status as FirewatchStatus)
}

// 缺数/越界的统一拦截口径：风力、湿度缺一不可，气温可缺测但不能越界。
export function blockingIssue(inspection: ReadingInspection): string | null {
  const missingRequired = inspection.missing.filter((field) =>
    REQUIRED_FOR_DOWNGRADE.includes(field),
  )
  if (missingRequired.length > 0) {
    return `缺少${missingRequired.join('、')}读数`
  }
  if (inspection.outOfRange.length > 0) {
    return `${inspection.outOfRange.join('、')}超出合理量程`
  }
  return null
}

export function describeIssues(inspection: ReadingInspection): string[] {
  const notes: string[] = []
  for (const field of inspection.missing) {
    notes.push(`缺${field.replace('等级', '').replace('读数', '')}读数`)
  }
  for (const field of inspection.outOfRange) {
    const [min, max] = READING_RANGES[field]
    notes.push(`${field}越界（应在 ${min}~${max}）`)
  }
  return notes
}
