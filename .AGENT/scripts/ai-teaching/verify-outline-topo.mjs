#!/usr/bin/env node
/**
 * 契约验证：AI 教学「大纲先修 · 批次 3」—— 章内拓扑序（`src/lib/courseOutlineTopo.ts`）
 * 与开段预检默认选点按拓扑序推进（`src/lib/aiTeachingSourcesPure.ts`）。
 *
 * 断言口径（全部跑真实实现，strip 类型后 import）：
 *   · stableTopo：无 requires / 正常链 / 菱形 / 有环 / 缺先修 / 自引用 / 已合法顺序不动 /
 *     不修改入参；跨章（不在本组内）先修视为已满足；
 *   · 选点：起点在中间、起点之后有已学、起点不存在、只有 1 个未学、起点已学、max 边界；
 *   · ★ 段内顺序（`orderSelectedUnits`，开段确认后的讲解顺序）：正常链 / 菱形 / 无 requires 原样 /
 *     有环原样 / 缺先修原样 / 先修未选中视为已满足 / 只重排不增删；
 *   · ★ 老课程（无 requires）与改造前实现**输出完全一致**（脚本内保留旧算法做对照，
 *     含随机生成的 120 组章节 × 起点 × max，段内顺序另有 80 组行序对照）；
 *   · 静态接线：index.tsx 的预检入参不丢 requires；Preflight 确认时用 orderSelectedUnits；
 *     stableTopo / orderSelectedUnits 只有一份实现（re-export 验证）。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-outline-topo.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import { makeStager } from './strip-load.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const stager = makeStager(ROOT)
const topoMod = await stager.load('src/lib/courseOutlineTopo.ts')
const { stableTopo, orderSelectedUnits } = topoMod
const sourcesPure = await stager.load('src/lib/aiTeachingSourcesPure.ts')
// stableTopo 经 electron 侧 re-export 必须仍是同一个函数（单一真相源）
const outlinePure = await stager.load('electron/lib/courseOutlinePure.ts')
const select = sourcesPure.defaultUnitSelection

const ids = (list) => list.map((u) => u.id).join(',')
const u = (id, extra = {}) => ({ id, name: id, ...extra })

/** 改造前的选点实现（逐字抄自 git 历史；只用于对照，不参与产线） */
function legacySelection(units, clickedUnitId, max = 3) {
  const idx = units.findIndex((x) => x.id === clickedUnitId)
  if (idx < 0 || units[idx]?.learned) return []
  const out = []
  for (let i = idx; i < units.length && out.length < Math.max(1, max); i++) {
    if (units[i].learned) break
    out.push(units[i].id)
  }
  return out
}

// ---------------------------------------------------------------- 1. stableTopo
console.log('\n=== 1. stableTopo 章内拓扑序 ===')
const plain = [u('u1'), u('u2'), u('u3')]
check('无 requires -> 原序', ids(stableTopo(plain)) === 'u1,u2,u3', ids(stableTopo(plain)))
check('空列表 -> 空列表', stableTopo([]).length === 0)
check('单条 -> 原样', ids(stableTopo([u('only')])) === 'only')

const chain = [u('u3', { requires: ['u2'] }), u('u2', { requires: ['u1'] }), u('u1')]
check('正常链：u3<-u2<-u1 重排为 u1,u2,u3', ids(stableTopo(chain)) === 'u1,u2,u3', ids(stableTopo(chain)))
check('排序不丢对象引用 / 字段', (() => {
  const out = stableTopo(chain)
  return out.length === 3 && out[0] === chain[2] && out[2].requires[0] === 'u2'
})(), '')

const diamond = [
  u('d', { requires: ['b', 'c'] }),
  u('b', { requires: ['a'] }),
  u('c', { requires: ['a'] }),
  u('a'),
]
check('菱形依赖：a 先出，b / c 原序，d 最后', ids(stableTopo(diamond)) === 'a,b,c,d', ids(stableTopo(diamond)))
const diamondStable = [u('a'), u('c', { requires: ['a'] }), u('b', { requires: ['a'] }), u('d', { requires: ['b', 'c'] })]
check('菱形：原序已合法时一律不动（c 不因 b 让位）', ids(stableTopo(diamondStable)) === 'a,c,b,d', ids(stableTopo(diamondStable)))

const cyclic = [u('x', { requires: ['y'] }), u('y', { requires: ['z'] }), u('z', { requires: ['x'] })]
check('有环 -> 原样返回', ids(stableTopo(cyclic)) === 'x,y,z', ids(stableTopo(cyclic)))
check('部分有环（前有可排项）-> 整体原样返回', ids(stableTopo([u('a'), u('x', { requires: ['y'] }), u('y', { requires: ['x'] })])) === 'a,x,y', ids(stableTopo([u('a'), u('x', { requires: ['y'] }), u('y', { requires: ['x'] })])))
check('自引用 -> 原样返回（当作环）', ids(stableTopo([u('a', { requires: ['a'] }), u('b')])) === 'a,b', ids(stableTopo([u('a', { requires: ['a'] }), u('b')])))

const missing = [u('u1', { requires: ['uX'] }), u('u2')]
check('缺先修（不在本组）-> 原序（忽略该先修）', ids(stableTopo(missing)) === 'u1,u2', ids(stableTopo(missing)))
check('跨章先修（不在本组）不触发重排', ids(stableTopo([u('b', { requires: ['a'] }), u('c')])) === 'b,c', ids(stableTopo([u('b', { requires: ['a'] }), u('c')])))
check('已合法顺序是幂等的', ids(stableTopo(stableTopo(chain))) === 'u1,u2,u3', ids(stableTopo(stableTopo(chain))))

const mutateProbe = [u('u3', { requires: ['u2'] }), u('u2', { requires: ['u1'] }), u('u1')]
const before = JSON.stringify(mutateProbe)
stableTopo(mutateProbe)
check('不修改入参数组', JSON.stringify(mutateProbe) === before, JSON.stringify(mutateProbe))
check('stableTopo 返回新数组', stableTopo(mutateProbe) !== mutateProbe)

// ---------------------------------------------------------------- 2. 老课程逐字一致
console.log('\n=== 2. 老课程（无 requires）与旧实现逐字一致 ===')
const legCases = [
  { units: [u('A'), u('B'), u('C'), u('D')], click: 'A', max: 3, want: 'A,B,C' },
  { units: [u('A'), u('B'), u('C'), u('D')], click: 'B', max: 3, want: 'B,C,D' },
  { units: [u('A'), u('B'), u('C'), u('D')], click: 'D', max: 3, want: 'D' },
  { units: [u('A'), u('B'), u('C'), u('D'), u('E')], click: 'C', max: 5, want: 'C,D,E' },
  { units: [u('A', { learned: true }), u('B'), u('C')], click: 'A', max: 3, want: '' },
  { units: [u('A'), u('B', { learned: true }), u('C')], click: 'A', max: 3, want: 'A' },
  { units: [u('A'), u('B'), u('C')], click: 'ZZ', max: 3, want: '' },
  { units: [u('A'), u('B'), u('C')], click: 'A', max: 0, want: 'A' },
  { units: [], click: 'A', max: 3, want: '' },
]
for (const c of legCases) {
  const got = select(c.units, c.click, c.max)
  const old = legacySelection(c.units, c.click, c.max)
  check(`无 requires：click=${c.click} max=${c.max} -> [${c.want}]（旧实现同值）`,
    got.join(',') === c.want && old.join(',') === got.join(','), `new=${got.join(',')} old=${old.join(',')}`)
}

/** 确定性伪随机：连续 120 组「无 requires 章节 × 起点 × max」逐字对照旧实现 */
let seed = 20261122
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % n
}
let legacyMismatch = 0
let legacyCases = 0
for (let t = 0; t < 120; t++) {
  const size = 1 + rnd(7)
  const units = []
  for (let i = 0; i < size; i++) units.push(u(`u${i + 1}`, rnd(4) === 0 ? { learned: true } : {}))
  const click = rnd(3) === 0 ? 'ghost' : `u${1 + rnd(size)}`
  const max = rnd(6)
  legacyCases++
  if (select(units, click, max).join(',') !== legacySelection(units, click, max).join(',')) legacyMismatch++
}
check(`无 requires 随机 ${legacyCases} 组：新实现输出与旧实现完全一致`, legacyMismatch === 0, `mismatch=${legacyMismatch}`)
check('无 requires 时拓扑序 = 原行序（随机 60 组）', (() => {
  let s = 7
  for (let t = 0; t < 60; t++) {
    s = (s * 1103515245 + 12345) % 2147483648
    const units = Array.from({ length: 1 + (s % 6) }, (_, i) => u(`v${i + 1}`))
    if (ids(stableTopo(units)) !== ids(units)) return false
  }
  return true
})(), '')

// ---------------------------------------------------------------- 3. 拓扑序选点
console.log('\n=== 3. 选点按章内拓扑序 ===')
const chainU = [u('u3', { requires: ['u2'] }), u('u2', { requires: ['u1'] }), u('u1')]
check('起点在中间：click u2 -> 拓扑序 [u1,u2,u3] 上取 u2,u3',
  select(chainU, 'u2', 3).join(',') === 'u2,u3', select(chainU, 'u2', 3).join(','))
check('同上与旧实现不同（旧实现按行序会给 u2,u1）',
  legacySelection(chainU, 'u2', 3).join(',') === 'u2,u1', legacySelection(chainU, 'u2', 3).join(','))
check('起点是链尾：click u1 -> u1,u2,u3',
  select(chainU, 'u1', 3).join(',') === 'u1,u2,u3', select(chainU, 'u1', 3).join(','))

const learnedAfter = [u('b', { requires: ['a'] }), u('a'), u('c', { learned: true }), u('d')]
check('起点之后有已学 -> 遇已学即停（b 后是已学的 c）',
  select(learnedAfter, 'b', 3).join(',') === 'b', select(learnedAfter, 'b', 3).join(','))
const learnedBefore = [u('b', { requires: ['a'] }), u('a', { learned: true }), u('c')]
check('已学点排到起点之前 -> 不阻断后续（a 已学，click b 仍得 b,c）',
  select(learnedBefore, 'b', 3).join(',') === 'b,c', select(learnedBefore, 'b', 3).join(','))
check('起点本身已学 -> 空（与旧实现一致）',
  select([u('a', { learned: true }), u('b')], 'a', 3).length === 0)
check('起点不存在 -> 完全退化为旧逻辑（空）',
  select(chainU, 'ghost', 3).join(',') === legacySelection(chainU, 'ghost', 3).join(','),
  select(chainU, 'ghost', 3).join(','))
check('只有 1 个未学 -> 只取 1 个',
  select([u('b', { requires: ['a'] }), u('a')], 'b', 3).join(',') === 'b',
  select([u('b', { requires: ['a'] }), u('a')], 'b', 3).join(','))
check('max=1 只取起点',
  select(chainU, 'u1', 1).join(',') === 'u1', select(chainU, 'u1', 1).join(','))
check('选取数量不超过 max',
  select(chainU, 'u1', 2).join(',') === 'u1,u2', select(chainU, 'u1', 2).join(','))

const cyclicU = [u('x', { requires: ['y'] }), u('y', { requires: ['x'] }), u('z')]
check('有环课程 -> 原行序选点（与旧实现一致）',
  select(cyclicU, 'y', 3).join(',') === legacySelection(cyclicU, 'y', 3).join(','),
  select(cyclicU, 'y', 3).join(','))
const missingU = [u('a', { requires: ['uX'] }), u('b'), u('c')]
check('缺先修课程 -> 原行序选点（与旧实现一致）',
  select(missingU, 'a', 3).join(',') === legacySelection(missingU, 'a', 3).join(','),
  select(missingU, 'a', 3).join(','))

/** 有 requires 的场景不比较旧值，只钉连通性不变量：起点必在首位、全部出现在拓扑序里且相邻 */
const topoU = [u('e', { requires: ['d'] }), u('c', { requires: ['b'] }), u('d', { requires: ['c'] }), u('b', { requires: ['a'] }), u('a')]
for (const [click, want] of [['a', 'a,b,c'], ['c', 'c,d,e'], ['e', 'e'], ['b', 'b,c,d']]) {
  const got = select(topoU, click, 3)
  check(`长链 click=${click} -> [${want}]`, got.join(',') === want, got.join(','))
}
check('拓扑序里的连续性是「排序后相邻」，不是原行序相邻', (() => {
  const order = stableTopo(topoU).map((x) => x.id)
  const got = select(topoU, 'a', 3)
  const at = order.indexOf('a')
  return got.join(',') === order.slice(at, at + 3).join(',')
})(), ids(stableTopo(topoU)))

// ---------------------------------------------------------------- 4. buildPreflight 接线
console.log('\n=== 4. buildPreflight 默认选点 ===')
const pf = sourcesPure.buildPreflight({ units: chainU, assignments: [], sources: [], clickedUnitId: 'u2' })
check('buildPreflight 未传 selectedUnitIds 时按拓扑序选点',
  pf.selectedUnitIds.join(',') === 'u2,u3', pf.selectedUnitIds.join(','))
const pfOld = sourcesPure.buildPreflight({ units: [u('A'), u('B'), u('C'), u('D')], assignments: [], sources: [], clickedUnitId: 'B' })
check('buildPreflight 无 requires 时与旧行为一致（B,C,D）',
  pfOld.selectedUnitIds.join(',') === legacySelection([u('A'), u('B'), u('C'), u('D')], 'B', 3).join(','),
  pfOld.selectedUnitIds.join(','))
check('显式 selectedUnitIds 仍然优先（不被拓扑序改写）',
  sourcesPure.buildPreflight({ units: chainU, assignments: [], sources: [], clickedUnitId: 'u2', selectedUnitIds: ['u3'] }).selectedUnitIds.join(',') === 'u3')

// ---------------------------------------------------------------- 4b. 段内顺序（开段确认后的讲解顺序）
console.log('\n=== 4b. 段内顺序 orderSelectedUnits ===')

/** 改造前的段内顺序实现（逐字保留：大纲行序过滤选中集合）——段内顺序的对照基准 */
function legacySegmentOrder(units, selectedIds) {
  const want = new Set(selectedIds)
  return units.filter((x) => want.has(x.id)).map((x) => x.id)
}

const seg = (list, sel) => orderSelectedUnits(list, sel).map((x) => x.id).join(',')

check('无 requires：选中项按大纲行序（顺序不变）',
  seg([u('A'), u('B'), u('C'), u('D')], ['A', 'B']) === 'A,B', seg([u('A'), u('B'), u('C'), u('D')], ['A', 'B']))
check('无 requires：勾选顺序不影响输出（基准是大纲行序，不是点击序）',
  seg([u('A'), u('B'), u('C')], ['C', 'A']) === 'A,C', seg([u('A'), u('B'), u('C')], ['C', 'A']))
check('空选中 -> 空段', orderSelectedUnits([u('A')], []).length === 0)
check('跨章 / 不存在的 id 被忽略（不增条目）',
  seg([u('A'), u('B')], ['A', 'ZZ', 'B']) === 'A,B', seg([u('A'), u('B')], ['A', 'ZZ', 'B']))

const segChain = [u('u3', { requires: ['u2'] }), u('u2', { requires: ['u1'] }), u('u1')]
check('正常链：全选 -> 讲序 u1,u2,u3（大纲行序是 u3,u2,u1）',
  seg(segChain, ['u3', 'u2', 'u1']) === 'u1,u2,u3', seg(segChain, ['u3', 'u2', 'u1']))
check('正常链：与改造前行序不同（旧实现讲成 u3,u2,u1，先修倒着讲）',
  legacySegmentOrder(segChain, ['u3', 'u2', 'u1']).join(',') === 'u3,u2,u1',
  legacySegmentOrder(segChain, ['u3', 'u2', 'u1']).join(','))
check('正常链：部分选中（u3,u2）仍按拓扑 -> u2,u3',
  seg(segChain, ['u3', 'u2']) === 'u2,u3', seg(segChain, ['u3', 'u2']))
check('正常链：只选 u3 -> 先修未选中视为已满足 -> u3',
  seg(segChain, ['u3']) === 'u3', seg(segChain, ['u3']))

const segDiamond = [u('d', { requires: ['b', 'c'] }), u('b', { requires: ['a'] }), u('c', { requires: ['a'] }), u('a')]
check('菱形：全选 -> a,b,c,d', seg(segDiamond, ['d', 'b', 'c', 'a']) === 'a,b,c,d', seg(segDiamond, ['d', 'b', 'c', 'a']))
check('菱形：已合法行序不被扰动（[a,c(<-a),b(<-a),d] -> a,c,b,d）',
  seg([u('a'), u('c', { requires: ['a'] }), u('b', { requires: ['a'] }), u('d', { requires: ['b', 'c'] })], ['a', 'c', 'b', 'd']) === 'a,c,b,d',
  seg([u('a'), u('c', { requires: ['a'] }), u('b', { requires: ['a'] }), u('d', { requires: ['b', 'c'] })], ['a', 'c', 'b', 'd']))

const segCyclic = [u('x', { requires: ['y'] }), u('y', { requires: ['z'] }), u('z', { requires: ['x'] })]
check('有环：原样（大纲行序）', seg(segCyclic, ['x', 'y', 'z']) === 'x,y,z', seg(segCyclic, ['x', 'y', 'z']))
check('有环：与旧实现逐字一致', seg(segCyclic, ['x', 'y', 'z']) === legacySegmentOrder(segCyclic, ['x', 'y', 'z']).join(','), '')
check('缺先修（指向不存在的 id）：原样', seg([u('b', { requires: ['ghost'] }), u('a')], ['b', 'a']) === 'b,a', seg([u('b', { requires: ['ghost'] }), u('a')], ['b', 'a']))
check('自引用：原样（当作环）', seg([u('a', { requires: ['a'] }), u('b')], ['a', 'b']) === 'a,b', seg([u('a', { requires: ['a'] }), u('b')], ['a', 'b']))
check('已合法顺序幂等', seg(segChain, orderSelectedUnits(segChain, ['u3', 'u2', 'u1']).map((x) => x.id)) === 'u1,u2,u3', '')

check('只重排不增删：输出集合 = 选中集合（有 requires 时也一样）', (() => {
  const a = orderSelectedUnits(segChain, ['u3', 'u2']).map((x) => x.id).sort().join(',')
  return a === 'u2,u3' && orderSelectedUnits(segChain, ['u3', 'u2']).length === 2
})(), '')
check('返回新数组 / 不修改入参顺序', (() => {
  const input = [u('u3', { requires: ['u2'] }), u('u2', { requires: ['u1'] }), u('u1')]
  const before = JSON.stringify(input)
  const out = orderSelectedUnits(input, ['u3', 'u2', 'u1'])
  return out !== input && JSON.stringify(input) === before && out[0].id === 'u1'
})(), '')

/** 无 requires 的段内顺序必须与改造前实现逐字一致（确定性伪随机 80 组 × 随机勾选集合） */
let segSeed = 20261123
const segRnd = (n) => {
  segSeed = (segSeed * 1103515245 + 12345) % 2147483648
  return segSeed % n
}
let segMismatch = 0
let segCases = 0
for (let t = 0; t < 80; t++) {
  const size = 1 + segRnd(8)
  const units = Array.from({ length: size }, (_, i) => u(`s${i + 1}`))
  const picked = units.filter(() => segRnd(3) !== 0).map((x) => x.id)
  const shuffled = picked.slice().sort(() => (segRnd(2) ? 1 : -1)) // 勾选序与行序无关
  segCases++
  if (seg(units, shuffled) !== legacySegmentOrder(units, shuffled).join(',')) segMismatch++
}
check(`无 requires 随机 ${segCases} 组：段内顺序与旧实现逐字一致`, segMismatch === 0, `mismatch=${segMismatch}`)

// ---------------------------------------------------------------- 5. 静态接线 / 单一真相源
console.log('\n=== 5. 静态接线 ===')
const topoSrc = read('src/lib/courseOutlineTopo.ts')
const outlineSrc = read('electron/lib/courseOutlinePure.ts')
const sourcesSrc = read('src/lib/aiTeachingSourcesPure.ts')
const idxSrc = read('src/modules/ai-teaching/index.tsx')
const preflightSrc = read('src/modules/ai-teaching/Preflight.tsx')
const courseSrc = read('electron/lib/aiTeachingCourse.ts')

check('courseOutlineTopo.ts 零运行时 import（真正零依赖）', !/^\s*import\s/m.test(topoSrc))
check('courseOutlinePure.ts 不再自己实现 stableTopo', !/function\s+stableTopo/.test(outlineSrc), '')
check('courseOutlinePure.ts 从 src/lib/courseOutlineTopo import 并 re-export',
  outlineSrc.includes("from '../../src/lib/courseOutlineTopo'") && outlineSrc.includes('export { stableTopo }'))
check('re-export 的 stableTopo 与共享实现是同一个函数', outlinePure.stableTopo === stableTopo, String(outlinePure.stableTopo === stableTopo))
check('aiTeachingSourcesPure 用共享拓扑序', sourcesSrc.includes("from './courseOutlineTopo'") && sourcesSrc.includes('stableTopo(units)'))
check('PreflightUnit 带 requires 字段', /interface PreflightUnit[\s\S]*?requires\?: string\[\]/.test(sourcesSrc))
check('index.tsx 预检入参把 requires 带上（丢了会静默退化为行序）',
  /requires:\s*u\.requires/.test(idxSrc), '')
check('Preflight 从共享模块取 orderSelectedUnits（不自己实现排序）',
  /import\s*\{[^}]*orderSelectedUnits[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/courseOutlineTopo'/.test(preflightSrc), '')
check('Preflight 确认时把选中集合交给 orderSelectedUnits（段内顺序 = 拓扑序）',
  /orderSelectedUnits\(chapter\.units,\s*selectedUnits\)/.test(preflightSrc), '')
check('Preflight 不再用「大纲行序直接过滤」当段内顺序（负向）',
  !/chapter\.units\.map\(\(u\)\s*=>\s*u\.id\)\.filter\(/.test(preflightSrc), '')
check('当前聚焦 = 拓扑序第一个（index.tsx 用返回的 unitIds[0]）',
  /setActiveUnitId\(unitIds\[0\] \?\? null\)/.test(idxSrc), '')
check('主进程 openSegment 不自作主张重排（顺序只认传入的 unitIds）',
  !/stableTopo|topoOrderUnits/.test(courseSrc), '')

// ---------------------------------------------------------------- 汇总
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

stager.cleanup()
process.exit(failed.length === 0 ? 0 : 1)
