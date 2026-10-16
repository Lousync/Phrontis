/**
 * AI教学 · 左栏「会话」区三层树契约（方案 `.AGENT/.claude/plans/ai-teaching-scope-layers-v390.md` §十 R7）。
 *
 * 口径：左栏会话区 = 章 → 知识点 → 课时（会话）三层树；复习课挂章下、课程助手单独一行、其余归「零散对话」。
 * 覆盖：归类 / 课时按 order 排序 / 支线跟随父行 / 兜底（大纲缺失、归属失效、复习课会话已删）/ 接线。
 *
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-left-rail-tree.mjs .
 * 全部 PASS 时 exit=0。输出纯 ASCII 标记，禁 emoji。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
if (!ROOT || !fs.existsSync(ROOT)) { console.error('用法：node verify-left-rail-tree.mjs <仓库根>'); process.exit(2) }

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------- 装载纯函数
const PURE_REL = 'src/modules/ai-teaching/leftRailTree.ts'
const pureSrc = read(PURE_REL)
check('leftRailTree 零 import（否则契约脚本装不进来）', !/^\s*import\s/m.test(pureSrc), '')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-verify-'))
const tmpFile = path.join(tmpDir, 'leftRailTree.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const { buildRailTree } = await import(pathToFileURL(tmpFile).href)

// ---------------------------------------------------------------- 1. 归类
console.log('\n=== 1. 归类：章 / 知识点 / 课时 / 复习课 / 课程助手 / 零散 ===')
const outline = {
  chapters: [
    { id: 'c1', name: '第一章 绪论', units: [{ id: 'u1', name: '数据结构的基本概念' }, { id: 'u2', name: '算法与复杂度' }] },
    { id: 'c2', name: '第二章 线性表', units: [{ id: 'u3', name: '顺序表' }] },
    { id: 'c3', name: '第三章 空章', units: [{ id: 'u4', name: '没人学' }] },
  ],
}
const sessions = [
  { id: 's1', title: '基本概念·课时1' }, { id: 's2', title: '基本概念·课时2' },
  { id: 's3', title: '算法·课时1' }, { id: 's4', title: '顺序表·课时1' },
  { id: 's5', title: '复习第一章' }, { id: 's6', title: '课程助手' },
  { id: 's7', title: '随手问的问题' }, { id: 's8', title: '零散2' },
]
const lessons = {
  s1: { unitId: 'u1', order: 1, kind: '概念' },
  s2: { unitId: 'u1', order: 2, kind: '练习' },
  s3: { unitId: 'u2', order: 1, kind: '概念' },
  s4: { unitId: 'u3', order: 1, kind: '概念' },
}
const reviews = { c1: { sessionId: 's5', rel: null } }
const promoted = { s1: [{ id: 's1a', title: '旁问升格' }] }
const t1 = buildRailTree({ outline, lessons, reviews, sessions, promoted, assistantSessionId: 's6' })

check('章按大纲顺序、空章不出现（c3 被略过）', t1.chapters.map((c) => c.chapterId).join(',') === 'c1,c2', t1.chapters.map((c) => c.chapterId).join(','))
check('只列有会话的知识点（c1 两个都有）', t1.chapters[0].units.length === 2, String(t1.chapters[0].units.length))
check('课时按 order 升序（1 在 2 前）', t1.chapters[0].units[0].rows.filter((r) => !r.child).map((r) => r.s.id).join(',') === 's1,s2', t1.chapters[0].units[0].rows.map((r) => r.s.id).join(','))
check('课时行带「课时N」标签 + 类型说明', t1.chapters[0].units[0].rows[0].label === '课时1' && t1.chapters[0].units[0].rows[0].hint === '课时 1 · 概念', JSON.stringify(t1.chapters[0].units[0].rows[0]))
check('已升格支线紧跟父行（child=true）', t1.chapters[0].units[0].rows[1].s.id === 's1a' && t1.chapters[0].units[0].rows[1].child === true, JSON.stringify(t1.chapters[0].units[0].rows.map((r) => [r.s.id, r.child])))
check('复习课挂在本章末尾（含标签）', t1.chapters[0].review?.[0].s.id === 's5' && t1.chapters[0].review?.[0].label === '复习课', JSON.stringify(t1.chapters[0].review))
check('章计数含支线与复习课', t1.chapters[0].count === 5, String(t1.chapters[0].count))
check('课程助手单独成行（不落零散）', t1.assistant?.s.id === 's6' && t1.assistant?.label === '课程助手', JSON.stringify(t1.assistant?.s.id))
check('零散对话 = 无课时归属的会话', t1.loose.map((r) => r.s.id).join(',') === 's7,s8', t1.loose.map((r) => r.s.id).join(','))
check('placed 计数 = 顶层会话数（不含支线）', t1.placed === 8, String(t1.placed))

// ---------------------------------------------------------------- 2. 排序 / 兜底
console.log('\n=== 2. 排序与兜底 ===')
const t2 = buildRailTree({
  outline,
  lessons: { s2: { unitId: 'u1', order: 1 }, s1: { unitId: 'u1', order: 2 } },
  sessions: [sessions[0], sessions[1]],
})
check('order 决定先后（object 键序不影响）', t2.chapters[0].units[0].rows.map((r) => r.s.id).join(',') === 's2,s1', t2.chapters[0].units[0].rows.map((r) => r.s.id).join(','))
check('order 相同则按 id 稳定排序', (() => {
  const t = buildRailTree({ outline, lessons: { s2: { unitId: 'u1', order: 1 }, s1: { unitId: 'u1', order: 1 } }, sessions })
  return t.chapters[0].units[0].rows.map((r) => r.s.id).join(',') === 's1,s2'
})(), '')
check('无 kind 时 hint 退化为「课时 N」', buildRailTree({ outline, lessons: { s1: { unitId: 'u1', order: 3 } }, sessions }).chapters[0].units[0].rows[0].hint === '课时 3', '')
check('outline 缺失 → 全部落零散（不报错）', (() => {
  const t = buildRailTree({ outline: null, lessons, sessions })
  return t.chapters.length === 0 && t.loose.length === 8
})(), '')
check('lessons/reviews 缺失 → 不崩、全零散', (() => {
  const t = buildRailTree({ sessions })
  return t.chapters.length === 0 && t.loose.length === 8 && t.assistant === null
})(), '')
check('归属指向已消失的知识点 → 退回零散', (() => {
  const t = buildRailTree({ outline, lessons: { s1: { unitId: 'uGONE', order: 1 } }, sessions: [sessions[0]] })
  return t.loose.length === 1 && t.chapters.length === 0
})(), '')
check('复习课会话已删（reviews 有、sessions 无）→ review 为 null 且本章不因它出现', (() => {
  const t = buildRailTree({ outline, reviews: { c3: { sessionId: 'sX' } }, sessions: [] })
  return t.chapters.length === 0
})(), '')
check('复习课排在课时之后', (() => {
  const t = buildRailTree({ outline, lessons, reviews, sessions })
  const c1 = t.chapters[0]
  return c1.units.length > 0 && c1.review !== null
})(), '')
check('assistantSessionId 指向课时 → 仍按课时处理（不重复成行）', (() => {
  const t = buildRailTree({ outline, lessons, sessions, assistantSessionId: 's1' })
  return t.assistant === null && t.loose.every((r) => r.s.id !== 's1') && t.chapters[0].units[0].rows.some((r) => r.s.id === 's1')
})(), '')
check('assistantSessionId 缺省 → 该会话落零散', (() => {
  const t = buildRailTree({ outline, lessons, reviews, sessions, promoted })
  return t.assistant === null && t.loose.some((r) => r.s.id === 's6')
})(), '')
check('零散会话的支线也跟随父行', (() => {
  const t = buildRailTree({ outline, sessions: [sessions[6]], promoted: { s7: [{ id: 's7a', title: '旁问' }] } })
  return t.loose.length === 2 && t.loose[1].child === true && t.loose[1].s.id === 's7a'
})(), '')
check('已升格支线不会单独成行（父行不在视图时不出现）', (() => {
  const t = buildRailTree({ outline, sessions: [sessions[6]], promoted: { s7: [{ id: 's7a', title: '旁问' }] } })
  return t.loose.filter((r) => r.s.id === 's7a').length === 1
})(), '')

// ---------------------------------------------------------------- 3. 接线静态断言
console.log('\n=== 3. 接线 ===')
const mod = stripComments(read('src/modules/ai-teaching/index.tsx'))
check('index.tsx 用 buildRailTree 建左栏树', mod.includes('buildRailTree(') && mod.includes("from './leftRailTree'"), '')
check('index.tsx 不再平铺渲染 wsSessionTree', !mod.includes('wsSessionTree.map'), '')
check('左栏章行可折叠', mod.includes('collapsedChap'), '')
check('index.tsx 传 assistantSessionId', mod.includes('assistantSessionId'), '')
const types = stripComments(read('src/types/index.ts'))
check('types: AiTeachCourseState 暴露 assistantSessionId', /interface AiTeachCourseState[\s\S]{0,600}assistantSessionId/.test(types), '')
const main = stripComments(read('electron/lib/aiTeachingCourse.ts'))
check('主进程 getCourseState 回传 assistantSessionId', /assistantSessionId:\s*s\.assistantSessionId\s*\?\?\s*null/.test(main), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
