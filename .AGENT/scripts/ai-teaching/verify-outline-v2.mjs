#!/usr/bin/env node
/**
 * 契约验证：AI 教学重构 P0「课程大纲 v2」纯函数（`electron/lib/courseOutlinePure.ts`）
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.5
 *       `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` §39
 *
 * 断言口径（全部跑真实实现，strip 类型后直接 import）：
 *   · 4 列旧格式可读且**逐字原样重写**（不补 `concept` / 空 requires 列、无章 id 也保留）；
 *   · 6 列 v2：type / requires（中英文逗号）/ 第 7 列起 extra 往返；
 *   · 结构化克隆（IPC / JSON，丢解析期 Symbol）后重写仍不丢 type / requires / 章目标；
 *   · 运行时形状（无 type / requires 字段）写 4 列，不产生 `undefined` / 无端 `concept` 列；
 *   · 非法先修（缺失 / 自引用 / 环）**不阻断读取**，只由 validateOutline 报告，重写不改数据；
 *   · 单列 `- ` 手写说明行不当知识点（与旧 4 列实现同口径）；
 *   · `- 章目标:` 归章、绝不当知识点；
 *   · 负向：空名称 / 非法 type / 先修缺失 / 自引用 / 环 / 重复 id；
 *   · diff 五种最小变更各自只产出对应的 op（不多造）；
 *   · `protectLearned` 拦删除 / 改名已学点；
 *   · `topoOrderUnits` 合法输入按先修排序，非法输入原样返回不抛错
 *     （`stableTopo` 算法已在 `src/lib/courseOutlineTopo.ts`，本模块 import + re-export）。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-outline-v2.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import path from 'node:path'
import { makeStager } from './strip-load.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

const REL = 'electron/lib/courseOutlinePure.ts'
// 大纲纯函数现在从 src/lib/courseOutlineTopo.ts 取 stableTopo（单一真相源），
// 装载器递归 stage 相对 import；stableTopo 仍经本模块 re-export 验证。
const stager = makeStager(ROOT)
const {
  parseCourseMd,
  rewriteCourseMd,
  validateOutline,
  diffOutlines,
  protectLearned,
  topoOrderUnits,
  stableTopo,
} = await stager.load(REL)

// 增补合并（append 路径）也在这里验：纯函数同源，经共享 stager 装载
const { mergeOutlineAdditions, resolveOutlineRequires } = await stager.load('electron/lib/aiTeachingCoursePure.ts')

/** 构造 CourseOutlineV2 测试对象（字段缺省 filler，保持共享类型形状） */
const mk = (chapters) => ({
  title: 'T',
  goal: '',
  anchor: '',
  chapters: chapters.map((c, i) => ({
    id: c.id ?? `c${i + 1}`,
    name: c.name ?? `第${i + 1}章`,
    objective: c.objective ?? '',
    units: (c.units ?? []).map((u) => ({
      id: u.id,
      name: u.name ?? `知识点${u.id}`,
      goal: u.goal ?? '',
      source: u.source ?? '',
      type: u.type ?? 'concept',
      requires: u.requires ?? [],
      extra: u.extra ?? [],
    })),
  })),
})
const clone = (o) => JSON.parse(JSON.stringify(o))
const codes = (issues) => issues.map((x) => x.code)
const opsOf = (ops, op) => ops.filter((x) => x.op === op)

const LEGACY = [
  '# 课程：操作系统',
  '- 目标: 三轮过完 408 操作系统',
  '- 依据: 考研 408 考纲',
  '',
  '## [c1] 第一章 计算机概述',
  '- u1 | 总线与接口 | 理解三类总线 | 教材 §1.1',
  '- u2 | I/O 编址方式 | 区分独立/统一编址 | 教材 §1.2',
  '',
  '## [c2] 第二章 进程',
  '- u3 | 进程状态 | 说明三态转换 | 教材 §2.1',
  '',
].join('\n')

const V2 = [
  '# 课程：操作系统',
  '- 目标: 三轮过完 408 操作系统',
  '- 依据: 考研 408 考纲',
  '',
  '## [c1] 第一章 计算机概述',
  '- 章目标: 学完本章能说明计算机的基本组成与三类总线',
  '- u1 | 总线与接口 | 理解三类总线 | 教材 §1.1 | concept |',
  '- u2 | I/O 编址方式 | 区分独立/统一编址 | 教材 §1.2 | concept | u1',
  '- u3 | 页表 | 说明页表项 | 教材 §3.1 | memory | u1, u2 | 备用一 | 备用二',
  '',
  '## [c2] 第二章 进程',
  '- u4 | 进程状态 | 说明三态转换 | 教材 §2.1 | procedure | u1，u3',
  '',
].join('\n')

console.log('\n=== 1. 4 列旧格式：可读 + 逐字原样重写 ===')
const legacy = parseCourseMd(LEGACY)
check('标题 / 目标 / 依据 解析', legacy.title === '操作系统' && legacy.goal === '三轮过完 408 操作系统' && legacy.anchor === '考研 408 考纲', JSON.stringify({ t: legacy.title, g: legacy.goal, a: legacy.anchor }))
check('两章 / 三个知识点', legacy.chapters.length === 2 && legacy.chapters[0].units.length === 2 && legacy.chapters[1].units.length === 1, `${legacy.chapters.length}`)
check('知识点四列（id / 名称 / 目标 / 出处）', legacy.chapters[0].units[0].id === 'u1' && legacy.chapters[0].units[0].name === '总线与接口' && legacy.chapters[0].units[0].goal === '理解三类总线' && legacy.chapters[0].units[0].source === '教材 §1.1', JSON.stringify(legacy.chapters[0].units[0]))
check('缺列：type 缺省 concept、requires 空、extra 空', legacy.chapters[0].units[0].type === 'concept' && legacy.chapters[0].units[0].requires.length === 0 && legacy.chapters[0].units[0].extra.length === 0, JSON.stringify(legacy.chapters[0].units[0]))
check('★ 4 列旧格式重写逐字一致（不补 concept / 空列）', rewriteCourseMd(legacy) === LEGACY && !rewriteCourseMd(legacy).includes('concept'), JSON.stringify(rewriteCourseMd(legacy)))
check('旧格式二次往返仍稳定（幂等）', rewriteCourseMd(parseCourseMd(rewriteCourseMd(legacy))) === rewriteCourseMd(legacy), '')
check('CRLF 输入不崩且行尾归一', rewriteCourseMd(parseCourseMd(LEGACY.replace(/\n/g, '\r\n'))) === LEGACY, '')

const IDLESS = ['# 课程：无号课', '', '## 第一章', '- u1 | a | b | c', '', '## 第二章', '- u2 | d | e | f', ''].join('\n')
check('无章 id 的旧文件重写也保留 `## 章名`（不擅自补 [cN]）', rewriteCourseMd(parseCourseMd(IDLESS)) === IDLESS, JSON.stringify(rewriteCourseMd(parseCourseMd(IDLESS))))

console.log('\n=== 2. 6 列 v2：type / requires / extra 往返 ===')
const v2 = parseCourseMd(V2)
const c1 = v2.chapters[0]
check('第 5 列 type 解析（memory）', c1.units[2].type === 'memory', JSON.stringify(c1.units[2]))
check('第 6 列 requires 解析（英文逗号）', JSON.stringify(c1.units[2].requires) === JSON.stringify(['u1', 'u2']), JSON.stringify(c1.units[2].requires))
check('第 6 列中文逗号也认（u1，u3）', JSON.stringify(v2.chapters[1].units[0].requires) === JSON.stringify(['u1', 'u3']), JSON.stringify(v2.chapters[1].units[0].requires))
check('第 7 列起进 extra（两条）', JSON.stringify(c1.units[2].extra) === JSON.stringify(['备用一', '备用二']), JSON.stringify(c1.units[2].extra))
check('★ v2 全文重写逐字一致（含行尾空列 / extra）', rewriteCourseMd(v2) === V2, JSON.stringify(rewriteCourseMd(v2)))
check('章目标行解析到章', c1.objective === '学完本章能说明计算机的基本组成与三类总线', JSON.stringify(c1.objective))
check('章目标不被当成知识点（c1 仍 3 条）', c1.units.length === 3, String(c1.units.length))
check('非法 type 原样保留 + validate 报 bad-type', (() => {
  const bad = parseCourseMd(['# 课程：x', '', '## [c1] 甲', '- u1 | a | b | c | weird |', ''].join('\n'))
  return bad.chapters[0].units[0].type === 'weird'
    && rewriteCourseMd(bad).includes('| weird |')
    && codes(validateOutline(bad)).includes('bad-type')
})(), '')
check('空 requires 列不产生先修', c1.units[0].requires.length === 0, JSON.stringify(c1.units[0].requires))

console.log('\n=== 3. validateOutline 负向 ===')
check('空名称 -> unit-empty-name', codes(validateOutline(mk([{ units: [{ id: 'u1', name: '  ' }] }]))).includes('unit-empty-name'), '')
check('先修不存在 -> requires-missing', codes(validateOutline(mk([{ units: [{ id: 'u1', requires: ['uX'] }] }]))).includes('requires-missing'), '')
check('自引用 -> requires-self', codes(validateOutline(mk([{ units: [{ id: 'u1', requires: ['u1'] }] }]))).includes('requires-self'), '')
check('环 -> requires-cycle（u1<->u2）', codes(validateOutline(mk([{ units: [{ id: 'u1', requires: ['u2'] }, { id: 'u2', requires: ['u1'] }] }]))).includes('requires-cycle'), '')
check('重复 id -> duplicate-unit-id', codes(validateOutline(mk([{ units: [{ id: 'u1' }, { id: 'u1' }] }]))).includes('duplicate-unit-id'), '')
check('合法 v2 大纲零问题', validateOutline(v2).length === 0, JSON.stringify(validateOutline(v2)))

console.log('\n=== 4. diffOutlines：最小变更只产出对应 op ===')
const base = mk([{ id: 'c1', units: [{ id: 'u1', name: '甲' }, { id: 'u2', name: '乙' }] }])

const renamed = clone(base)
renamed.chapters[0].units[0].name = '甲2'
const renameOps = diffOutlines(base, renamed)
check('只改名 -> 1 条 rename-unit', renameOps.length === 1 && renameOps[0].op === 'rename-unit' && renameOps[0].from === '甲' && renameOps[0].to === '甲2', JSON.stringify(renameOps))

const moved = mk([{ id: 'c1', units: [{ id: 'u1' }, { id: 'u2' }] }, { id: 'c2', units: [] }])
const movedAfter = clone(moved)
movedAfter.chapters[1].units.push(movedAfter.chapters[0].units.shift())
const moveOps = diffOutlines(moved, movedAfter)
check('只挪章 -> 1 条 move-unit（不误报重排）', moveOps.length === 1 && moveOps[0].op === 'move-unit' && moveOps[0].fromChapterId === 'c1' && moveOps[0].toChapterId === 'c2', JSON.stringify(moveOps))

const retyped = clone(base)
retyped.chapters[0].units[0].type = 'memory'
const retypeOps = diffOutlines(base, retyped)
check('只改 type -> 1 条 retype-unit', retypeOps.length === 1 && retypeOps[0].op === 'retype-unit' && retypeOps[0].from === 'concept' && retypeOps[0].to === 'memory', JSON.stringify(retypeOps))

const reordered = clone(base)
reordered.chapters[0].units.reverse()
const reorderOps = diffOutlines(base, reordered)
check('只调章内顺序 -> 1 条 reorder-units', reorderOps.length === 1 && reorderOps[0].op === 'reorder-units' && reorderOps[0].chapterId === 'c1', JSON.stringify(reorderOps))

const grown = clone(base)
grown.chapters.push({ id: 'c2', name: '第二章', objective: '', units: [{ id: 'u3', name: '丙', goal: '', source: '', type: 'concept', requires: [], extra: [] }] })
const growOps = diffOutlines(base, grown)
check('加章 + 加点 -> add-chapter / add-unit', opsOf(growOps, 'add-chapter').length === 1 && opsOf(growOps, 'add-unit').length === 1, JSON.stringify(growOps))
check('删点 + 删章 -> remove-unit / remove-chapter', (() => {
  const ops = diffOutlines(grown, base)
  return opsOf(ops, 'remove-unit').length === 1 && opsOf(ops, 'remove-chapter').length === 1
})(), '')
check('完全相同 -> 空 diff', diffOutlines(base, clone(base)).length === 0, JSON.stringify(diffOutlines(base, clone(base))))

console.log('\n=== 5. protectLearned：已学点拒绝删除 / 改名 ===')
const guardDiff = [
  { op: 'remove-unit', unitId: 'u1', chapterId: 'c1', name: '甲' },
  { op: 'rename-unit', unitId: 'u2', from: '乙', to: '乙2' },
  { op: 'add-unit', unitId: 'u3', chapterId: 'c1', name: '丙' },
  { op: 'retype-unit', unitId: 'u4', from: 'concept', to: 'design' },
]
const guarded = protectLearned(guardDiff, ['u1', 'u2'])
check('删除 / 改名已学点进 blocked（2 条）', guarded.blocked.length === 2 && guarded.blocked.every((x) => x.op === 'remove-unit' || x.op === 'rename-unit'), JSON.stringify(guarded.blocked))
check('其余 op 放行（2 条）', guarded.allowed.length === 2 && guarded.allowed.every((x) => x.op === 'add-unit' || x.op === 'retype-unit'), JSON.stringify(guarded.allowed))
check('空 learned 集合全部放行', protectLearned(guardDiff, []).blocked.length === 0, '')

console.log('\n=== 6. topoOrderUnits：合法重排 / 非法原样返回 ===')
const unsorted = mk([{ units: [{ id: 'u3', requires: ['u2'] }, { id: 'u2', requires: ['u1'] }, { id: 'u1' }] }])
const sorted = topoOrderUnits(unsorted)
check('u2(requires u1) 排到 u1 之后', JSON.stringify(sorted.chapters[0].units.map((u) => u.id)) === JSON.stringify(['u1', 'u2', 'u3']), JSON.stringify(sorted.chapters[0].units.map((u) => u.id)))
check('重排不改 id 与字段', sorted.chapters[0].units.length === 3 && sorted.chapters[0].units[2].requires[0] === 'u2', '')
check('已有序输入保持原序', JSON.stringify(topoOrderUnits(sorted).chapters[0].units.map((u) => u.id)) === JSON.stringify(['u1', 'u2', 'u3']), '')

const cyclic = mk([{ units: [{ id: 'u1', requires: ['u2'] }, { id: 'u2', requires: ['u1'] }] }])
const cyclicOut = topoOrderUnits(cyclic)
check('有环 -> 原样返回（不抛错、顺序不变）', JSON.stringify(cyclicOut.chapters[0].units.map((u) => u.id)) === JSON.stringify(['u1', 'u2']), '')

const missing = mk([{ units: [{ id: 'u1', requires: ['uX'] }, { id: 'u2' }] }])
const missingOut = topoOrderUnits(missing)
check('先修缺失 -> 原样返回', JSON.stringify(missingOut.chapters[0].units.map((u) => u.id)) === JSON.stringify(['u1', 'u2']), '')
check('跨章先修不触发重排（章顺序由大纲决定）', (() => {
  const o = mk([{ id: 'c1', units: [{ id: 'u2', requires: ['u1'] }, { id: 'u3' }] }, { id: 'c2', units: [{ id: 'u1' }] }])
  const r = topoOrderUnits(o)
  return JSON.stringify(r.chapters[0].units.map((u) => u.id)) === JSON.stringify(['u2', 'u3'])
})(), '')
// stableTopo 的唯一实现在 src/lib/courseOutlineTopo.ts；本模块只 import + re-export
check('stableTopo 经 courseOutlinePure re-export（单一真相源）',
  typeof stableTopo === 'function' &&
    stableTopo([{ id: 'u2', requires: ['u1'] }, { id: 'u1' }]).map((u) => u.id).join(',') === 'u1,u2',
  typeof stableTopo)

console.log('\n=== 7. 运行时读写保真（结构化克隆 / 缺省字段） ===')
/** JSON 克隆 ≈ IPC 结构化克隆：解析期 Symbol（列形态）全部丢失，字段本身保留 */
const handV2 = parseCourseMd(V2)
const clonedV2 = clone(handV2)
const clonedText = rewriteCourseMd(clonedV2)
const reparsedV2 = parseCourseMd(clonedText)
const unitsOf = (o) => o.chapters.flatMap((c) => c.units)
const semantic = (o) => unitsOf(o).map((u) => [u.id, u.type ?? 'concept', (u.requires ?? []).join('>'), (u.extra ?? []).join('>')])
check('克隆后重写再解析：type / requires / extra 语义不变', JSON.stringify(semantic(reparsedV2)) === JSON.stringify(semantic(handV2)), JSON.stringify(semantic(reparsedV2)))
check('克隆后重写：章目标（真实字段）也留住', reparsedV2.chapters[0].objective === handV2.chapters[0].objective && reparsedV2.chapters[0].objective !== '', reparsedV2.chapters[0].objective)
check('克隆后重写不出现 undefined 列', !clonedText.includes('undefined'), clonedText.split('\n').slice(3, 6).join(' / '))

const legacyClone = clone(parseCourseMd(LEGACY))
check('★ 4 列旧文件经结构化克隆后重写仍逐字一致（最小列，不补 concept）', rewriteCourseMd(legacyClone) === LEGACY && !rewriteCourseMd(legacyClone).includes('concept'), JSON.stringify(rewriteCourseMd(legacyClone)))

/** 运行时新建的知识点（normalizeOutline 产物：只有 id/name/goal/source） */
const runtimePlain = { title: 'T', goal: '', anchor: '', chapters: [{ id: 'c1', name: '甲', units: [{ id: 'u1', name: 'a', goal: 'b', source: 'c' }] }] }
check('运行时无 type / requires 的知识点写 4 列', rewriteCourseMd(runtimePlain) === ['# 课程：T', '', '## [c1] 甲', '- u1 | a | b | c', ''].join('\n'), JSON.stringify(rewriteCourseMd(runtimePlain)))

/** 运行时里手工带上 type / requires（模型给了就写进第 5 / 6 列） */
const runtimeTyped = { title: 'T', goal: '', anchor: '', chapters: [{ id: 'c1', name: '甲', units: [{ id: 'u1', name: 'a', goal: 'b', source: 'c', type: 'memory', requires: ['u0'] }] }] }
check('运行时 type / requires 真的落到第 5 / 6 列', rewriteCourseMd(runtimeTyped).includes('- u1 | a | b | c | memory | u0'), JSON.stringify(rewriteCourseMd(runtimeTyped)))

console.log('\n=== 8. 非法先修不阻断读取 / 单列说明行 ===')
const BROKEN = [
  '# 课程：坏先修',
  '',
  '## [c1] 甲',
  '- u1 | a | b | c | concept | uX, u2',
  '- u2 | d | e | f | concept | u1',
  '',
].join('\n')
const broken = parseCourseMd(BROKEN)
check('先修缺失 / 成环也照常解析出全部知识点', broken.chapters.length === 1 && broken.chapters[0].units.length === 2, String(broken.chapters[0]?.units?.length))
check('先修原文照常落到字段（uX / u2）', JSON.stringify(broken.chapters[0].units[0].requires) === JSON.stringify(['uX', 'u2']), JSON.stringify(broken.chapters[0].units[0].requires))
check('非法先修只由 validateOutline 报告（missing + cycle）', (() => {
  const cs = codes(validateOutline(broken))
  return cs.includes('requires-missing') && cs.includes('requires-cycle')
})(), JSON.stringify(codes(validateOutline(broken))))
check('含非法先修的文件重写逐字一致（不静默改数据）', rewriteCourseMd(broken) === BROKEN, JSON.stringify(rewriteCourseMd(broken)))

const PROSE = ['# 课程：手写', '', '## [c1] 甲', '- 本章要点见教材第 3 章', '- u1 | a | b | c', ''].join('\n')
const prose = parseCourseMd(PROSE)
check('单列手写说明行不当知识点（与旧 4 列实现同口径）', prose.chapters[0].units.length === 1 && prose.chapters[0].units[0].id === 'u1', JSON.stringify(prose.chapters[0].units.map((u) => u.id)))

console.log('\n=== 9. append 增补：type / requires（名称->id / 本章范围 / 失败只丢该条） ===')
const appendBase = mk([
  { id: 'c1', name: '甲章', units: [{ id: 'u1', name: '基础' }, { id: 'u2', name: '进阶' }] },
  { id: 'c2', name: '乙章', units: [{ id: 'u3', name: '别章点' }] },
])
const mergedRes = mergeOutlineAdditions(appendBase, {
  toExisting: [
    { chapterId: 'c1', name: '应用', type: 'memory', requires: ['基础', 'u2', '不存在'] },
    { chapterId: 'c1', name: '前向引用', type: 'concept', requires: ['后置点'] },
    { chapterId: 'c1', name: '后置点', type: 'procedure' },
    { chapterId: 'c2', name: '跨章', requires: ['基础'] },
    { chapterId: 'c1', name: '自引用', requires: ['自引用'] },
  ],
  newChapters: [{ name: '丙章', units: [{ name: '新点', type: 'design', requires: ['新点2'] }, { name: '新点2' }] }],
})
const mergedUnits = mergedRes.outline.chapters.flatMap((c) => c.units)
const unitNamed = (n) => mergedUnits.find((u) => u.name === n)
check('toExisting 带上 type（memory）', unitNamed('应用')?.type === 'memory', JSON.stringify(unitNamed('应用')))
check('requires 名称 -> 本章 id，id 原样保留', JSON.stringify(unitNamed('应用')?.requires) === JSON.stringify(['u1', 'u2']), JSON.stringify(unitNamed('应用')?.requires))
check('同一批增补里的前向名称引用也能解析（后置点 -> u6）', JSON.stringify(unitNamed('前向引用')?.requires) === JSON.stringify(['u6']), JSON.stringify(unitNamed('前向引用')?.requires))
check('跨章名称不解析（只认本章）', unitNamed('跨章')?.requires === undefined, JSON.stringify(unitNamed('跨章')?.requires))
check('自引用被丢弃', unitNamed('自引用')?.requires === undefined, JSON.stringify(unitNamed('自引用')?.requires))
check('新章内名称 -> 新 id（新点2 -> u10）', JSON.stringify(unitNamed('新点')?.requires) === JSON.stringify(['u10']) && unitNamed('新点')?.type === 'design', JSON.stringify(unitNamed('新点')))
check('丢弃条数被计数（3 条：不存在 / 跨章 / 自引用）', mergedRes.droppedRequires === 3, String(mergedRes.droppedRequires))
check('不整批失败：7 条增补全部落位', mergedRes.added === 7 && mergedRes.outline.chapters.length === 3, `${mergedRes.added}/${mergedRes.outline.chapters.length}`)
check('原有知识点 id / 字段不动', (() => {
  const u1 = mergedRes.outline.chapters[0].units[0]
  return u1.id === 'u1' && u1.name === '基础' && u1.type === 'concept' && u1.requires.length === 0
})(), '')
const badTypeAdd = mergeOutlineAdditions(appendBase, { toExisting: [{ chapterId: 'c1', name: '错类型', type: 'skill' }], newChapters: [] })
check('非法 type 被丢弃（不写坏数据，缺省 concept）', (() => {
  const u = badTypeAdd.outline.chapters[0].units.find((x) => x.name === '错类型')
  return !!u && u.type === undefined && badTypeAdd.added === 1
})(), JSON.stringify(badTypeAdd.outline.chapters[0].units.find((x) => x.name === '错类型')))

// 首次生成（create 分支）：normalizeOutline 已分配 id，requires 里的名称也要转 id
const createdRes = resolveOutlineRequires(mk([{
  id: 'c1',
  units: [
    { id: 'u1', name: '基础' },
    { id: 'u2', name: '应用', type: 'memory', requires: ['基础', '不存在', 'u1'] },
    { id: 'u3', name: '自引用', requires: ['自引用'] },
  ],
}]))
const createdUnits = createdRes.outline.chapters[0].units
check('首次生成：名称 -> 本章 id', JSON.stringify(createdUnits[1].requires) === JSON.stringify(['u1']), JSON.stringify(createdUnits[1]))
check('首次生成：自引用 / 不存在丢弃并计数（2 条）', createdUnits[2].requires.length === 0 && createdRes.droppedRequires === 2, String(createdRes.droppedRequires))
check('首次生成：type 原样保留', createdUnits[1].type === 'memory', JSON.stringify(createdUnits[1]))

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

stager.cleanup()
process.exit(failed.length === 0 ? 0 : 1)
