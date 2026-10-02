// 冒烟测试：在 node 里模拟 localStorage，验证火险监测边界、并发冲突、待续办恢复与台账修复。
// 运行：node /tmp/smoke/run.mjs（先由 esbuild 打包 test/smoke.ts 生成）

const store = new Map<string, string>()
const failKeys = new Set<string>()

const localStorageMock = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => {
    if (failKeys.has(key)) {
      throw new Error(`模拟写入失败: ${key}`)
    }
    store.set(key, String(value))
  },
  removeItem: (key: string) => {
    store.delete(key)
  },
}
;(globalThis as Record<string, unknown>).window = {
  localStorage: localStorageMock,
  addEventListener: () => {},
}

const STORAGE_KEY = 'forest-fire-patrol:entries'
const JOURNAL_KEY = 'forest-fire-patrol:pending-ops'

async function main() {
  const service = await import('../src/api/local-service')
  const storeApi = await import('../src/data/local-store')

  let passed = 0
  let failed = 0
  function check(name: string, cond: boolean, detail = '') {
    if (cond) {
      passed += 1
      console.log(`  ok  ${name}`)
    } else {
      failed += 1
      console.log(`FAIL  ${name} ${detail}`)
    }
  }
  function rowsOf(key: string) {
    return (JSON.parse(store.get(STORAGE_KEY) ?? '{}') as Record<string, { status: string; pending: boolean; abnormal: boolean; revision?: number }[]>)[key] ?? []
  }

  console.log('— 台账修复（其余模块待办跟着恢复，历史状态保留）—')
  service.listEntries('firewatch')
  const fw = rowsOf('firewatch')
  check('缺数监测点被标异常', fw[1]?.abnormal === true)
  check('缺数监测点仍在待办', fw[1]?.pending === true)
  check('正常监测点不算待办', fw[0]?.pending === false)
  check('黄色预警算待办（修复前 seed 里是不算）', fw[2]?.pending === true)
  check('历史火险等级/状态原样保留', fw[2]?.status === '黄色预警' && fw[0]?.status === '正常')
  check('补齐了并发版本号', Number(fw[0]?.revision) >= 1)
  const patrol = rowsOf('patrol')
  check('巡护模块待办跟着恢复：待执行/执行中算待办', patrol[0]?.pending === true && patrol[1]?.pending === true)
  check('巡护模块待办跟着恢复：已完成不再待办', patrol[2]?.pending === false)

  console.log('— 缺数 / 越界不许降回正常 —')
  const r1 = service.runAction('firewatch', 2, '解除预警', Number(fw[1]?.revision ?? 1))
  check('缺风力数据时解除预警被拒', !r1.ok && r1.message.includes('风力'), r1.message)
  const afterFail = rowsOf('firewatch')
  check('失败后状态原地不动', afterFail[1]?.status === '蓝色预警')
  const r1retry = service.runAction('firewatch', 2, '解除预警', Number(fw[1]?.revision ?? 1))
  check('失败重试得到同一个结果（不变成另一条）', !r1retry.ok && r1retry.message === r1.message)
  const r2 = service.runAction('firewatch', 3, '解除预警', Number(afterFail[2]?.revision ?? 1))
  check('风大湿度低仍达预警条件，不许降回正常', !r2.ok && r2.message.includes('仍达预警条件'), r2.message)
  const badCreate = service.createEntry('firewatch', { 监测点编号: 'FIRE-9001', 风力等级: '20级', 相对湿度: '45%' }, '正常')
  check('风力越界不能登记为正常', !badCreate.ok && badCreate.message.includes('有效范围'), badCreate.message)

  console.log('— 合法降级 —')
  const c1 = service.createEntry(
    'firewatch',
    { 监测点编号: 'FIRE-9002', 监测区域: '南洼四号点', 风力等级: '3级', 相对湿度: '52%', 监测时间: '2026-10-02' },
    '蓝色预警',
  )
  check('读数齐全可登记为预警', c1.ok, c1.message)
  const created = rowsOf('firewatch').find((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9002') as { id: number; revision?: number }
  const r3 = service.runAction('firewatch', Number(created.id), '解除预警', Number(created.revision ?? 1))
  check('风力湿度回到安全线以下允许降回正常', r3.ok, r3.message)
  const settled = rowsOf('firewatch').find((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9002')
  check('降回正常后不再待办、不算异常', settled?.pending === false && settled?.abnormal === false)

  console.log('— 两个监测端并发更新只落库一条 —')
  const before = rowsOf('firewatch').find((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9002') as { id: number; revision?: number }
  const firstWin = service.runAction('firewatch', Number(before.id), '更新等级', Number(before.revision ?? 1))
  check('先提交的一端落库成功', firstWin.ok, firstWin.message)
  const stale = service.runAction('firewatch', Number(before.id), '升级预警', Number(before.revision ?? 1))
  check('基于旧版本的提交按冲突拒绝', !stale.ok && stale.message.includes('现场复检'), stale.message)
  const conflictRow = rowsOf('firewatch').find((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9002')
  check('冲突后只保留先落库的结果', conflictRow?.status === '橙色预警' && Number(conflictRow?.revision) === Number(before.revision ?? 1) + 1)
  const dup = service.createEntry('firewatch', { 监测点编号: 'FIRE-9002', 风力等级: '2级', 相对湿度: '60%' }, '正常')
  check('同编号重复登记只落库一条', !dup.ok && rowsOf('firewatch').filter((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9002').length === 1, dup.message)

  console.log('— 网络中断后从未完成的步骤继续 —')
  const target = rowsOf('firewatch').find((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9002') as { id: number; revision?: number }
  failKeys.add(STORAGE_KEY) // 模拟主数据写不进去（网络中断）
  const interrupted = service.runAction('firewatch', Number(target.id), '升级预警', Number(target.revision ?? 1))
  check('中断时动作报告失败并说明有待续办', !interrupted.ok && interrupted.message.includes('待续办'), interrupted.message)
  check('中断期间主数据没被写花', rowsOf('firewatch').find((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9002')?.status === '橙色预警')
  check('待续办台账里留着这一步', (JSON.parse(store.get(JOURNAL_KEY) ?? '[]') as unknown[]).length === 1)
  failKeys.delete(STORAGE_KEY) // 网络恢复
  storeApi.resumePendingOps()
  const resumed = rowsOf('firewatch').find((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9002')
  check('恢复后从未完成的步骤继续并落库', resumed?.status === '红色预警')
  check('续办完成后台账销账', (JSON.parse(store.get(JOURNAL_KEY) ?? '[]') as unknown[]).length === 0)
  storeApi.resumePendingOps()
  check('重复恢复幂等，不重复落库', rowsOf('firewatch').filter((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9002').length === 1)

  console.log('— 登记中断后续办 / 两端同时登记只落一条 —')
  failKeys.add(STORAGE_KEY)
  const c2 = service.createEntry('firewatch', { 监测点编号: 'FIRE-9003', 风力等级: '1级', 相对湿度: '66%' }, '正常')
  check('登记写一半中断：报告失败并留待续办', !c2.ok && c2.message.includes('待续办'), c2.message)
  check('中断期间新点未落库', !rowsOf('firewatch').some((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9003'))
  failKeys.delete(STORAGE_KEY)
  storeApi.resumePendingOps()
  check('恢复后登记从断点继续落库', rowsOf('firewatch').some((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9003'))
  // 模拟另一监测端在恢复前已登记同编号：续办发现后不再重复落库
  failKeys.add(STORAGE_KEY)
  const c3 = service.createEntry('firewatch', { 监测点编号: 'FIRE-9004', 风力等级: '2级', 相对湿度: '61%' }, '正常')
  check('又一笔登记中断留待续办', !c3.ok)
  failKeys.delete(STORAGE_KEY)
  const rawNow = JSON.parse(store.get(STORAGE_KEY) ?? '{}') as Record<string, unknown[]>
  ;(rawNow['firewatch'] as unknown[]).push({ id: 999, status: '正常', pending: false, abnormal: false, revision: 1, 监测点编号: 'FIRE-9004' })
  store.set(STORAGE_KEY, JSON.stringify(rawNow)) // 另一监测端先落库了同编号
  storeApi.resumePendingOps()
  check('另一监测端已落库同编号时续办不重复落库', rowsOf('firewatch').filter((r) => (r as Record<string, unknown>)['监测点编号'] === 'FIRE-9004').length === 1)

  console.log('— 概览口径与台账一致 —')
  const overview = service.loadOverview()
  const fwOverview = overview.modules.find((m) => m.name === '火险监测')
  const fwRows = rowsOf('firewatch')
  check(
    '处置面板待办数与台账一致',
    fwOverview?.pending === fwRows.filter((r) => r.pending).length &&
      fwOverview?.abnormal === fwRows.filter((r) => r.abnormal).length,
  )

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
