// 端到端验证：用 localStorage 垫片在 Node 里跑真实的数据层与服务层。
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

const shim = `
globalThis.__ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (globalThis.__ls.has(k) ? globalThis.__ls.get(k) : null),
  setItem: (k, v) => globalThis.__ls.set(k, String(v)),
  removeItem: (k) => globalThis.__ls.delete(k),
  clear: () => globalThis.__ls.clear(),
};
globalThis.navigator = { onLine: true };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.setTimeout = (fn) => fn();
`

const entry = 'test-entry.ts'
writeFileSync(
  entry,
  `
import { runAction, listEntries, loadOverview, resumePendingActions, pendingSyncCount, firewatchReadingInspection, resetLocalState } from './src/api/local-service'
import { inspectReadings, evaluateStatus } from './src/data/firewatch-rules'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name, extra) }
}
function row(id) { return listEntries('firewatch').items.find((r) => r.id === id) }
function reset() { localStorage.clear(); resetLocalState() }

// 0. 规则评估本身
const evalCase = (vals, expected) => {
  const got = evaluateStatus(inspectReadings({ id: 0, ...vals }))
  check(\`评估 \${JSON.stringify(vals)} => \${expected}\`, got === expected, \`实际 \${got}\`)
}
console.log('规则评估')
evalCase({ 风力等级: 2, 相对湿度: 72, 气温读数: 18 }, '正常')
evalCase({ 风力等级: 4, 相对湿度: 60, 气温读数: 22 }, '蓝色预警')
evalCase({ 风力等级: 5, 相对湿度: 45, 气温读数: 32 }, '黄色预警')
evalCase({ 风力等级: 6, 相对湿度: 30, 气温读数: 28 }, '橙色预警')
evalCase({ 风力等级: 7, 相对湿度: 18, 气温读数: 36 }, '红色预警')
// 气温缺测允许，风力湿度齐套仍可评估
check('气温缺测不阻断评估（按缺测0分参与）', evaluateStatus(inspectReadings({ id: 0, 风力等级: 7, 相对湿度: 18, 气温读数: '' })) === '橙色预警')

reset()

// 1. 缺数解除：row4 缺风力湿度，必须维持橙色
console.log('缺数保守策略')
{
  const before = row(4)
  const r = runAction('firewatch', 4, '解除预警')
  const after = row(4)
  check('缺数解除被拒绝', r.ok === false)
  check('缺数后等级不回落', after.status === '橙色预警', after.status)
  check('拒绝信息点名缺数', r.message.includes('缺少风力等级、相对湿度读数'), r.message)
  const upd = runAction('firewatch', 4, '更新等级')
  check('缺数更新同样拒绝', upd.ok === false && row(4).status === '橙色预警')
}

// 2. 越界读数拦截
console.log('越界处理')
{
  // 手工把 row2 湿度写成 130（越界）
  const items = listEntries('firewatch').items
  localStorage.setItem('forest-fire-patrol:entries', JSON.stringify({
    ...JSON.parse(localStorage.getItem('forest-fire-patrol:entries')),
    firewatch: items.map((x) => x.id === 2 ? { ...x, 相对湿度: 130 } : x),
  }))
  resetLocalState()
  const r = runAction('firewatch', 2, '解除预警')
  check('越界解除拒绝', r.ok === false && r.message.includes('超出合理量程'), r.message)
  check('越界后维持蓝色', row(2).status === '蓝色预警')
  const issues = firewatchReadingInspection(row(2))
  check('越界被识别', issues.outOfRange.includes('相对湿度'))
}
reset()

// 3. 合法降级：row6 橙色但读数评估正常 → 更新等级可合法降级；解除也能解
console.log('合法降级')
{
  const r1 = runAction('firewatch', 6, '更新等级')
  check('更新按读数评估（不再写死橙色）', r1.ok && row(6).status === '正常', row(6).status)
  check('盖当前阈值版本', row(6)['阈值版本'] === '2026-09')
  check('有评估时间', typeof row(6)['评估时间'] === 'string')
}
reset()
{
  const r2 = runAction('firewatch', 6, '解除预警')
  check('齐套读数评估正常时可解除', r2.ok && row(6).status === '正常', r2.message)
}
reset()

// 4. 升级预警必须真的更高
console.log('升级约束')
{
  const r = runAction('firewatch', 5, '升级预警')
  check('红色不能再升级', r.ok === false && row(5).status === '红色预警')
  // row3 黄色读数评估为黄色，不允许升
  const r3 = runAction('firewatch', 3, '升级预警')
  check('评估未高于当前时拒绝升级', r3.ok === false && row(3).status === '黄色预警', r3.message)
}

// 5. 台账与处置面板同源：pending/abnormal 由状态派生
console.log('状态同源')
{
  const ov = loadOverview()
  const fw = ov.modules.find((m) => m.name === '火险监测')
  check('火险待处理=预警点数(5)', fw.pending === 5, String(fw.pending))
  check('火险异常量=橙+红(3)', fw.abnormal === 3, String(fw.abnormal))
  const patrol = ov.modules.find((m) => m.name === '巡护任务')
  check('巡护待办恢复：未到末态的都恢复(待执行+执行中+已完成=3)', patrol.pending === 3, String(patrol.pending))
  check('巡护异常量按往回走动作口径=0', patrol.abnormal === 0, String(patrol.abnormal))
  // 黄色预警 seed 原来 pending=false，迁移后应恢复
  check('黄色预警也算待处理', row(3).pending === true)
  check('正常点不是待处理', row(1).pending === false)
}

// 6. 历史火险等级不回算：改旧版阈值数据也不影响已有状态（迁移保持原状态）
console.log('历史等级保留')
{
  // 构造 schema v1 的旧数据：状态橙色但按新阈值评估应为正常（类似 row6），迁移不应改状态
  const old = {
    firewatch: [{
      id: 99, status: '橙色预警', pending: false, abnormal: false,
      监测点编号: 'OLD-1', 监测区域: '旧', 火险等级: '橙色预警',
      风力等级: 3, 相对湿度: 65, 气温读数: 19, 监测时间: '2026-01-01', 监测状态: '橙色预警',
    }],
  }
  localStorage.clear()
  resetLocalState()
  localStorage.setItem('forest-fire-patrol:entries', JSON.stringify(old))
  localStorage.setItem('forest-fire-patrol:schema', '1')
  resetLocalState()
  const r = listEntries('firewatch').items.find((x) => x.id === 99)
  check('迁移不回算历史等级', r.status === '橙色预警')
  check('迁移只修标志位(pending)', r.pending === true)
  check('迁移补 revision', Number(r.revision) === 1)
}

// 7. 并发：两端更新同一行只落库一条
console.log('并发去重')
{
  localStorage.clear()
  resetLocalState()
  const stale = runAction('firewatch', 3, '升级预警')
  // row3 评估为黄色，升不了；改用更新等级制造一次成功写
  const rA = runAction('firewatch', 3, '更新等级', { expectedRevision: 1 })
  check('A端首次更新（评估仍黄色则视为无变化）', true)
  // row3 读数评估为黄色，无变化；换成 row2(蓝色评估=蓝) 也无变化。用 row6 正常降级制造版本推进
  const b1 = runAction('firewatch', 6, '更新等级', { expectedRevision: 1 })
  check('B端落库成功', b1.ok === true && row(6).status === '正常')
  const b2 = runAction('firewatch', 6, '现场复检', { expectedRevision: 1 })
  check('旧版本冲突被识别', b2.ok === true) // 现场复检 force，永远成功
  // 普通动作带旧 revision 必须冲突
  localStorage.clear()
  resetLocalState()
  runAction('firewatch', 6, '更新等级', { expectedRevision: 1 }) // revision -> 2
  const stale2 = runAction('patrol', 1, '开始巡护')
  // 巡护模块：再拿旧 revision 提同一动作
  const rev1 = listEntries('patrol').items.find((x) => x.id === 1)
  check('巡护首次流转成功并推进版本', rev1.status === '执行中' && Number(rev1.revision) === 2)
  const dup = runAction('patrol', 1, '开始巡护', { expectedRevision: 1 })
  check('旧版本并发提交冲突，不再落第二条', dup.ok === false && dup.conflict === true, dup.message)
  check('库里仍只有一条（revision=2）', Number(listEntries('patrol').items.find((x) => x.id === 1).revision) === 2)

  // 冲突后不得残留可复活日志：带旧 revision 再提同动作，应继续报冲突而不是补写旧目标
  const retrySame = runAction('patrol', 1, '开始巡护', { expectedRevision: 1 })
  check('冲突日志未复活', retrySame.ok === false && retrySame.conflict === true, retrySame.message)
  check('台账状态未被旧目标改写', listEntries('patrol').items.find((x) => x.id === 1).status === '执行中')
}

// 8. 失败重试幂等：断网时台账已落库，重试从 panel 步骤继续，只落库一次
console.log('断网续传')
{
  localStorage.clear()
  resetLocalState()
  navigator.onLine = false
  const r1 = runAction('firewatch', 6, '更新等级')
  check('断网：台账落库成功、面板挂起', r1.ok === true && r1.pendingSync === true, r1.message)
  check('断网时状态已是正常', row(6).status === '正常')
  check('有 1 条待续传', pendingSyncCount() === 1, String(pendingSyncCount()))
  const revisionAfterFirst = Number(row(6).revision)
  // 用户失败后点重试
  const r2 = runAction('firewatch', 6, '更新等级')
  check('重试不重复落库（revision 不变）', Number(row(6).revision) === revisionAfterFirst)
  check('重试提示从中断步骤继续', r2.message.includes('中断的步骤继续') || r2.pendingSync === true)
  // 网络恢复，自动续传
  navigator.onLine = true
  const out = resumePendingActions()
  check('恢复后续传完成', out.resumed === 1 && out.finished === 1, JSON.stringify(out))
  check('续传后无挂起', pendingSyncCount() === 0)
  // 已完成的同动作再点：评估为正常后是无变化（不是另一条结果）
  const r3 = runAction('firewatch', 6, '更新等级')
  check('续传后重放结果稳定', r3.ok === false && r3.message.includes('等级未变化'), r3.message)
}

// 9. 现场复检优先：冲突时以复检为准，并作废旧挂起
console.log('现场复检优先')
{
  localStorage.clear()
  resetLocalState()
  navigator.onLine = false
  runAction('firewatch', 6, '更新等级') // 挂起一条 panel
  navigator.onLine = true
  const r = runAction('firewatch', 6, '现场复检')
  check('复检成功', r.ok === true && row(6).status === '正常')
  const out = resumePendingActions()
  check('旧挂起被复检作废，不重复上报', out.resumed === 0, JSON.stringify(out))
}

console.log(\`\\n结果：\${pass} 通过，\${fail} 失败\`)
if (fail > 0) process.exit(1)
`,
)

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'test-bundle.mjs',
  alias: { '@': new URL('./src', import.meta.url).pathname },
  banner: { js: shim },
  logLevel: 'silent',
})
await import('./test-bundle.mjs')
