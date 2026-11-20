#!/usr/bin/env node
/**
 * 契约验证：AI 教学重构 P0「课程大纲 v2」纯函数（`electron/lib/courseOutlinePure.ts`）
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.5
 *       `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` §39
 *
 * 断言口径（全部跑真实实现，strip 类型后直接 import）：
 *   · 4 列旧格式可读且**逐字原样重写**（不补 `concept` / 空 requires 列、无章 id 也保留）；
 *   · 6 列 v2：type / requires（中英文逗号）/ 第 7 列起 extra 往返；
 *   · `- 章目标:` 归章、绝不当知识点；
 *   · 负向：空名称 / 非法 type / 先修缺失 / 自引用 / 环 / 重复 id；
 *   · diff 五种最小变更各自只产出对应的 op（不多造）；
 *   · `protectLearned` 拦删除 / 改名已学点；
 *   · `topoOrderUnits` 合法输入按先修排序，非法输入原样返回不抛错。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-outline-v2.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

const REL = 'electron/lib/courseOutlinePure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-v2-'))
const tmpFile = path.join(tmpDir, 'courseOutlinePure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const {
  parseCourseMd,
  rewriteCourseMd,
  validateOutline,
  diffOutlines,
  protectLearned,
  topoOrderUnits,
} = await import(pathToFileURL(tmpFile).href)

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

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
