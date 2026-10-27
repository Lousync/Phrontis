/**
 * 契约验证：AI教学 3.14 段模型（progress v2 / 复习解锁 / 开段预检 / 课程树）。
 *
 * 纯函数真实实现执行（strip-types import），不复制逻辑。
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-course-segments.mjs .
 * 全部 PASS 时 exit=0；输出纯 ASCII 标记，禁 emoji。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai314-'))
async function load(rel, name) {
  const src = read(rel)
  check(`${rel} 零 import`, !/^\s*import\s/m.test(src), '')
  const file = path.join(tmp, `${name}.mjs`)
  fs.writeFileSync(file, stripTypeScriptTypes(src, { mode: 'strip' }))
  return import(pathToFileURL(file).href)
}

const coursePure = await load('electron/lib/aiTeachingCoursePure.ts', 'coursePure')
const progressPure = await load('src/lib/aiTeachingProgressPure.ts', 'progressPure')
const sourcesPure = await load('src/lib/aiTeachingSourcesPure.ts', 'sourcesPure')
const rail = await load('src/modules/ai-teaching/courseRail.ts', 'courseRail')

// ---------------------------------------------------------------- 1. 课程.md 章 ID
console.log('\n=== 1. 课程.md 稳定章 ID ===')
const md = '# 课程：测试\n- 目标: 跑通\n\n## [c7] 第七章 进程\n- u1 | 进程 | 理解进程 | 教材\n\n## 第八章 内存\n- u2 | 分页 | 理解分页 | 教材\n'
const outline = coursePure.parseCourseMd(md)
check('显式 [c7] 被保留', outline.chapters[0].id === 'c7', outline.chapters[0].id)
check('旧格式无 ID 按位置补 c2', outline.chapters[1].id === 'c2', outline.chapters[1].id)
const rewritten = coursePure.rewriteCourseMd(outline)
check('重写写回 [c7]', rewritten.includes('## [c7] 第七章 进程'), rewritten.split('\n')[3] || '')
const round = coursePure.parseCourseMd(rewritten)
check('重写往返章 ID / 名称 / 知识点不丢', JSON.stringify(round) === JSON.stringify(outline), JSON.stringify(round))

// ---------------------------------------------------------------- 2. progress v1 -> v2
console.log('\n=== 2. progress v1 -> v2 ===')
const v1 = {
  v: 1,
  workspaces: {
    w1: {
      enabled: true,
      sourceBaseline: [{ key: 'x' }],
      sessions: { s1: 'u1' },
      lessons: { s2: { unitId: 'u2', order: 2, kind: '精讲', status: 'ended' } },
      units: { u1: { status: 'learning', mastery: 0.3, lastCheckedAt: null }, u2: { status: 'mastered', mastery: 1, lastCheckedAt: '2026-10-01' } },
      reviews: { c1: { sessionId: 'r1', rel: 'AI教学/x/复习讲义.md' } },
      assistantSessionId: 'a1',
    },
  },
}
const n1 = coursePure.normalizeProgressFile(v1)
check('输出 v:2', n1.file.v === 2, String(n1.file.v))
check('标记 migrated', n1.migrated === true)
const w = n1.file.workspaces.w1
check('sessions → lessons（s1）', w.lessons.s1?.unitIds?.[0] === 'u1', JSON.stringify(w.lessons.s1))
check('旧 unitId → unitIds（s2）', Array.isArray(w.lessons.s2.unitIds) && w.lessons.s2.unitIds[0] === 'u2', JSON.stringify(w.lessons.s2))
check('段补 sources=[] / handoffRel=null', Array.isArray(w.lessons.s2.sources) && w.lessons.s2.handoffRel === null, JSON.stringify(w.lessons.s2))
check('enabled / sourceBaseline 已丢弃', !('enabled' in w) && !('sourceBaseline' in w), JSON.stringify(Object.keys(w)))
check('u2 有 ended 段 → finished=true', w.units.u2.finished === true, JSON.stringify(w.units.u2))
check('reviews / assistantSessionId 保留', w.reviews.c1.rel.includes('复习讲义') && w.assistantSessionId === 'a1', JSON.stringify({ r: w.reviews, a: w.assistantSessionId }))
const n2 = coursePure.normalizeProgressFile(n1.file)
check('归一化幂等（二次 migrated=false）', n2.migrated === false, String(n2.migrated))
check('幂等结果一致', JSON.stringify(n2.file) === JSON.stringify(n1.file), '')

// ---------------------------------------------------------------- 3. 复习解锁
console.log('\n=== 3. 复习解锁 ===')
const units = ['u1', 'u2']
const lessons = {
  s1: { unitIds: ['u1', 'u2'], order: 1, status: 'open' },
  s0: { unitIds: ['u1'], order: 1, status: 'ended' },
}
const progress0 = { u1: { status: 'mastered', finished: true }, u2: { status: 'learning' } }
check('有 open 段覆盖 → 未学完', progressPure.unitLearned('u2', progress0, lessons) === false)
check('open 段覆盖时即使 finished=true 也算未学完（回炉）', progressPure.unitLearned('u1', { u1: { status: 'mastered', finished: true } }, lessons) === false)
const ended = { s1: { unitIds: ['u1', 'u2'], order: 1, status: 'ended' } }
const progress1 = { u1: { status: 'mastered', finished: true }, u2: { status: 'mastered', finished: true } }
check('本章全部学完 → 解锁', progressPure.reviewState('c1', units, progress1, ended, {}).state === 'unlocked')
check('一个没学完 → 锁定且 remaining=1', progressPure.reviewState('c1', units, { u1: { finished: true }, u2: { finished: false } }, ended, {}).state === 'locked' && progressPure.reviewState('c1', units, { u1: { finished: true }, u2: { finished: false } }, ended, {}).remaining === 1)
check('有讲义 rel → done（历史产物优先）', progressPure.reviewState('c1', units, {}, {}, { c1: { sessionId: 'r', rel: 'x.md' } }).state === 'done')
check('空章不解锁', progressPure.reviewState('c1', [], {}, {}, {}).state === 'locked')
check('上一段取同章 order 最大的 ended', progressPure.prevSegmentOf({ a: { unitIds: ['u1'], order: 1, status: 'ended' }, b: { unitIds: ['u2'], order: 2, status: 'ended' }, c: { unitIds: ['u2'], order: 3, status: 'ended' } }, 'c', units)?.sessionId === 'b')

// ---------------------------------------------------------------- 4. 开段预检 B→A
console.log('\n=== 4. 开段预检 B→A ===')
const src = {
  id: 's1', title: '基础讲义', type: 'md', rel: 'x.md', extractRel: null, anchor: { kind: 'whole' }, status: 'ready', createdAt: '',
  index: [
    { label: '集合', anchor: { kind: 'headings', from: '集合' } },
    { label: '映射', anchor: { kind: 'headings', from: '映射' } },
    { label: '极限', anchor: { kind: 'headings', from: '极限' } },
  ],
}
const asg = [{ sourceId: 's1', label: '第一章', anchor: { kind: 'headings', from: '第一章' }, addedAt: '' }]
const pu = [{ id: 'u1', name: '集合' }, { id: 'u2', name: '映射' }, { id: 'u3', name: '极限' }]
const exact = sourcesPure.buildPreflight({ units: pu, assignments: asg, sources: [src], clickedUnitId: 'u1', selectedUnitIds: ['u1', 'u2'] })
check('精确：两个标题都命中', exact.candidates[0]?.mode === 'exact', JSON.stringify(exact.candidates[0]))
check('精确：区间收窄到 集合–映射', exact.candidates[0]?.anchor.from === '集合' && exact.candidates[0]?.anchor.to === '映射', JSON.stringify(exact.candidates[0]?.anchor))
const narrow = sourcesPure.buildPreflight({ units: pu, assignments: asg, sources: [src], selectedUnitIds: ['u1', 'u2', 'u3'] })
check('缩窄：3 个命中仍 exact（全命中）', narrow.candidates[0]?.mode === 'exact', narrow.candidates[0]?.mode)
const miss = sourcesPure.buildPreflight({ units: [{ id: 'u9', name: '完全不存在' }], assignments: asg, sources: [src], selectedUnitIds: ['u9'] })
check('匹配失败 → fallback 且用章级 anchor', miss.candidates[0]?.mode === 'fallback' && miss.candidates[0]?.anchor.from === '第一章', JSON.stringify(miss.candidates[0]))
check('未匹配知识点被列出', miss.unmatchedUnitIds.includes('u9'))
const def = sourcesPure.defaultUnitSelection([{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }, { id: 'u3', name: 'C' }, { id: 'u4', name: 'D' }], 'u1', 3)
check('默认选点最多 3 个连续未学', def.join(',') === 'u1,u2,u3', def.join(','))
const def2 = sourcesPure.defaultUnitSelection([{ id: 'u1', name: 'A', learned: true }, { id: 'u2', name: 'B' }], 'u1', 3)
check('已学点不可选', def2.length === 0, JSON.stringify(def2))
check('anchorLabel 页码', sourcesPure.anchorLabel({ kind: 'pages', from: 3, to: 9 }) === '第 3–9 页', sourcesPure.anchorLabel({ kind: 'pages', from: 3, to: 9 }))
check('anchorLabel 标题', sourcesPure.anchorLabel({ kind: 'headings', from: '1.1', to: '1.2' }) === '标题 1.1–1.2', sourcesPure.anchorLabel({ kind: 'headings', from: '1.1', to: '1.2' }))

// ---------------------------------------------------------------- 5. 课程树
console.log('\n=== 5. 课程树 ===')
const railCh = [
  { id: 'c1', name: '第一章 基础', units: [{ id: 'u1', name: '集合', learned: true, active: false, inSegment: false }, { id: 'u2', name: '映射', learned: false, active: true, inSegment: true }], review: { state: 'unlocked', remaining: 0, total: 2, learned: 1 } },
  { id: 'c2', name: '第二章 进阶', units: [{ id: 'u3', name: '极限', learned: false, active: false, inSegment: false }], review: { state: 'locked', remaining: 1, total: 1, learned: 0 } },
]
check('空搜索返回全量', rail.buildCourseRail(railCh).length === 2)
check('章名命中保留整章', rail.buildCourseRail(railCh, '进阶')[0]?.units.length === 1)
check('知识点命中只留命中行', rail.buildCourseRail(railCh, '映射')[0]?.units.length === 1 && rail.buildCourseRail(railCh, '映射')[0]?.units[0].id === 'u2')
check('无命中返回空', rail.buildCourseRail(railCh, '不存在').length === 0)
check('activeChapterId 优先当前章', rail.activeChapterId(railCh, 'c2') === 'c2')
check('reviewLabel 文案', rail.reviewLabel({ state: 'locked', remaining: 2, total: 4, learned: 2 }) === '还差 2 个' && rail.reviewLabel({ state: 'done', remaining: 0, total: 4, learned: 4 }) === '已生成讲义')

// ---------------------------------------------------------------- 汇总
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
process.exit(failed.length ? 1 : 0)
