#!/usr/bin/env node
/**
 * 契约验证：命令面板的模糊匹配与排序（src/lib/fuzzy.ts）。
 *
 * 为什么需要它：排序规则全是「错了也不报错」的那类 ——
 *   · 排序不稳定 → 同一个查询两次打开面板，结果顺序会跳（用户只会觉得"怪"，不会当 bug 报）；
 *   · 升级排序时**丢了召回** → 原本搜得到的东西搜不到了，且没有任何报错（本次改造最大的风险面）；
 *   · 多词查询退化成 OR → 输「打开 设置」会把十一条「打开 X」全排到前面。
 * 所以这里锁的是三条性质：不丢召回、顺序确定、多词是 AND。用例表里每条都是判据。
 *
 * 用法：node .AGENT/scripts/commands/verify-palette-fuzzy.mjs
 */

import { filterAndRank, scoreItem, scoreToken, subsequence } from '../../../src/lib/fuzzy.ts'

let pass = 0
const fails = []
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  return false
}

/** 用例集：贴近真实面板条目（含键位 / 插件 hint / 分组） */
const ITEMS = [
  { id: 'open-settings', label: '打开 设置', group: '打开模块' },
  { id: 'open-knowledge', label: '打开 笔记', hint: '阅读 / 编辑 / 导航', group: '打开模块' },
  { id: 'open-toolbox', label: '打开 工具箱', group: '打开模块' },
  { id: 'open-wb', label: '打开 Workbench 外壳（实验）', group: '打开模块' },
  { id: 'open-help', label: '打开 帮助', group: '打开模块' },
  { id: 'sidebar', label: '折叠 / 展开侧栏', group: '界面', keys: [['Ctrl', 'B']] },
  { id: 'zoom-in', label: '界面放大', group: '界面', keys: [['Ctrl', '=']] },
  { id: 'zoom-out', label: '界面缩小', group: '界面', keys: [['Ctrl', '-']] },
  { id: 'zen', label: '布局：禅模式（全屏沉浸）', group: '界面设置' },
  { id: 'plug', label: '生成日报', hint: '螃蟹吉祥物', group: '插件命令' },
]
const rank = (q) => filterAndRank(ITEMS, q).map((i) => i.id)

// ---------------------------------------------------------------- §1 空查询与排序确定

console.log('\n§1 空查询 / 排序确定性')

ok(rank('').length === ITEMS.length, '§1 空查询原样返回全部（面板自己决定插不插「最近使用」）', `${rank('').length}`)
ok(rank('   ').length === ITEMS.length, '§1 纯空白也算空查询')
ok(JSON.stringify(rank('')) === JSON.stringify(ITEMS.map((i) => i.id)), '§1 空查询保持输入顺序')
ok(JSON.stringify(rank('界面')) === JSON.stringify(rank('界面')), '§1 同一查询两次结果一致（排序确定）')

// ---------------------------------------------------------------- §2 标题命中与排序

console.log('\n§2 标题命中与优先级')

ok(rank('打开 设置')[0] === 'open-settings', '§2 精确标题排第 1', rank('打开 设置').join(','))
ok(rank('设置')[0] === 'open-settings', '§2 子串命中排第 1', rank('设置').join(','))
ok(rank('打开').length === 5, '§2 「打开」命中 5 条（不误伤其它条目）', rank('打开').join(','))
ok(!rank('打开').includes('sidebar'), '§2 「打开」不命中侧栏')
// 前缀命中要压过中段命中：'界面放大' 与 '界面缩小' 都含「界面」且都在词首 → 同分靠稳定排序；
// ★ 首版这里写错成「『界面』不该命中禅模式」——实际命中的是它的**分组名**「界面设置」（320 档），
//   那是正确行为（按分组名搜得到本组命令）。断言改成下面这种有意义的形态。
ok(rank('界面').includes('zen'), '§2 「界面」经分组名「界面设置」命中禅模式', rank('界面').join(','))
ok(rank('界面').includes('sidebar'), '§2 「界面」经分组名命中侧栏', rank('界面').join(','))
ok(rank('界面设置')[0] === 'zen', '§2 精确分组名把该组命令排前', rank('界面设置').join(','))

// 前缀 vs 中段：'缩小' 命中「界面缩小」（词尾）应存在；构造前缀更优的对比
ok(scoreToken({ label: '设置面板' }, '设置') > scoreToken({ label: '高级设置' }, '设置'),
  '§2 前缀命中分数 > 中段命中')

// ---------------------------------------------------------------- §3 键位命中（面板此前不知道键位）

console.log('\n§3 键位命中（真源带来的新能力）')

ok(rank('ctrl b')[0] === 'sidebar', '§3 「ctrl b」命中折叠侧栏', rank('ctrl b').join(','))
ok(rank('ctrlb')[0] === 'sidebar', '§3 「ctrlb」拍平写法也命中')
ok(rank('ctrl+b')[0] === 'sidebar', '§3 「ctrl+b」加号写法也命中')
ok(rank('ctrl -')[0] === 'zoom-out', '§3 「ctrl -」命中界面缩小（`-` 是真键位，不能被当分隔符吃掉）', rank('ctrl -').join(','))
ok(rank('ctrl')[0] !== undefined && rank('ctrl').length === 3, '§3 「ctrl」命中带 ctrl 键位的 3 条', rank('ctrl').join(','))

// ---------------------------------------------------------------- §4 多词 AND

console.log('\n§4 多词查询是 AND（不是 OR）')

ok(JSON.stringify(rank('打开 设置')) === JSON.stringify(['open-settings']),
  '§4 「打开 设置」只留一条（OR 会把所有「打开 X」都放进来）', rank('打开 设置').join(','))
ok(rank('界面 放大')[0] === 'zoom-in', '§4 「界面 放大」命中放大', rank('界面 放大').join(','))
ok(rank('打开 禅模式').length === 0, '§4 两个词分属不同条目 → 无命中（AND 的必然结果）')

// ---------------------------------------------------------------- §5 hint / group / 子序列

console.log('\n§5 hint、分组与子序列兜底')

ok(rank('螃蟹吉祥物')[0] === 'plug', '§5 按插件名（hint）搜得到插件命令', rank('螃蟹吉祥物').join(','))
ok(rank('插件命令')[0] === 'plug', '§5 按分组名搜得到', rank('插件命令').join(','))
ok(rank('wb')[0] === 'open-wb', '§5 子序列兜底：wb 命中「Workbench」', rank('wb').join(','))
// ★ 首版这里也比错了：拿 'wb' 对 'Workbench' 两处都是**子序列**（'wb' 不是 'workbench' 的连续子串），
//   自然同分。要比就得拿一个真子串来比。
ok(scoreToken({ label: 'Workbench' }, 'work') > scoreToken({ label: '打开 Workbench 外壳（实验）' }, 'wb'),
  '§5 子串分（1000 档）高于子序列分（180）')
ok(rank('zzzz').length === 0, '§5 无命中返回空数组')
ok(rank('设置 设置')[0] === 'open-settings', '§5 重复词不致命（同一词元加两次分）')

// 子序列纯函数直接断言
console.log('\n§5b subsequence 纯函数')
ok(subsequence('workbench', 'wb') === true, '§5b workbench ⊇ wb')
ok(subsequence('workbench', 'bw') === false, '§5b workbench ⊉ bw（顺序必须是正序）')
ok(subsequence('abc', '') === true, '§5b 空 needle 恒真')
ok(subsequence('', 'a') === false, '§5b 空 haystack 只有空 needle 为真')

// ---------------------------------------------------------------- §6 不丢召回（本次改造最大的风险面）

console.log('\n§6 不丢召回：旧口径（label/hint/group includes）能命中的，新口径必须也命中')

const LEGACY_QUERIES = [
  '设置', '笔记', '工具箱', '帮助', '打开', '侧栏', '放大', '缩小', '禅模式',
  '插件', '螃蟹', '阅读', '导航', '界面', '布局', 'gen', 'wb', 'lab', 'AI', '打开 ',
]
const lost = []
for (const it of ITEMS) {
  for (const q of LEGACY_QUERIES) {
    const qq = q.toLowerCase()
    const legacyHit = [it.label, it.hint ?? '', it.group ?? ''].some((s) => s.toLowerCase().includes(qq))
    if (legacyHit && scoreItem(it, q) <= 0) lost.push(`${it.id} ← "${q}"`)
  }
}
ok(lost.length === 0, '§6 零召回丢失', lost.slice(0, 6).join(' | '))

// 反向：新口径命中集合必须是旧口径的超集（键位命中是新增的那部分）
const extra = []
for (const it of ITEMS) {
  for (const q of ['ctrl b', 'ctrl+b', 'ctrlb']) {
    const qq = q.toLowerCase()
    const legacyHit = [it.label, it.hint ?? '', it.group ?? ''].some((s) => s.toLowerCase().includes(qq))
    if (!legacyHit && scoreItem(it, q) > 0) extra.push(`${it.id} ← "${q}"`)
  }
}
ok(extra.includes('sidebar ← "ctrl b"'), '§6 新增的命中确实来自键位（sidebar ← ctrl b）', extra.join(' | '))

// ---------------------------------------------------------------- 收尾

console.log('')
if (fails.length === 0) {
  console.log(`PASS  命令面板模糊匹配：${pass} 项断言（不丢召回 / 排序确定 / 多词 AND）`)
  process.exit(0)
}
console.log(`FAIL  ${fails.length} 项未通过（PASS ${pass}）：`)
for (const f of fails) console.log('  - ' + f)
process.exit(1)
