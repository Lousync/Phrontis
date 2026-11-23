/**
 * 契约验证：AI 教学「结课与资料沉淀」纯函数与摘要口径。
 *
 * 锁的是静默错误：产物误收（素材 / 题单 / 结构文件被当沉淀项）、ready 判定把空章算完、
 * 目标路径把 `..` 或非法字符带进仓库、报告写进绝对路径。
 *
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-course-end.mjs
 * 输出纯 ASCII（禁 emoji）。
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-course-end-'))
const emitted = new Map()
function emit(rel) {
  const key = path.posix.normalize(rel.replace(/\\/g, '/'))
  if (emitted.has(key)) return emitted.get(key)
  const src = read(key)
  let out = stripTypeScriptTypes(src, { mode: 'strip' })
  const deps = []
  out = out.replace(/from '(\.{1,2}\/[^']+)'/g, (_m, p) => {
    const raw = path.posix.normalize(path.posix.join(path.posix.dirname(key), p))
    const dep = /\.ts$/.test(raw) ? raw : `${raw}.ts`
    deps.push(dep)
    return `from '${p}.mjs'`
  })
  const dest = path.join(tmp, key.replace(/\.ts$/, '.mjs'))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, out)
  emitted.set(key, dest)
  for (const dep of deps) emit(dep)
  return dest
}
function load(rel) {
  return import(pathToFileURL(emit(rel)).href)
}

const pure = await load('electron/lib/aiTeachingCourseEndPure.ts')
const summaryMod = await load('electron/lib/aiTeachingCourseSummary.ts')

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\n=== 1. 产物分类 ===')
check('章末复习讲义命中 review', pure.classifyArtifact('第3章 进程/章末复习/复习讲义.md') === 'review')
check('段讲义命中 lecture', pure.classifyArtifact('第3章 进程/段1/讲义·进程与线程.md') === 'lecture')
check('阶段总结命中 summary', pure.classifyArtifact('第3章 进程/段2/总结·重点难点.md') === 'summary')
check('课程助手产物命中 summary', pure.classifyArtifact('课程助手/output/总结·全局复盘.md') === 'summary')
check('导图命中 mindmap', pure.classifyArtifact('第3章 进程/mindmaps/知识结构.json') === 'mindmap')
check('示意图命中 visual', pure.classifyArtifact('第3章 进程/段1/visuals/状态转换.html') === 'visual')
check('测验单独归类为 quiz', pure.classifyArtifact('第1章 概述/测验·随堂测验.md') === 'quiz')
check('素材目录排除', pure.classifyArtifact('SOURCES/1·概述/原件.pdf') === 'excluded')
check('提取稿目录排除', pure.classifyArtifact('SOURCES/_extracts/原件.md') === 'excluded')
check('待整理排除', pure.classifyArtifact('待整理/章末复习/第1章/复习讲义.md') === 'excluded')
check('课程结构文件排除', pure.classifyArtifact('课程.md') === 'excluded')
check('要求 / 画像 / 依据文件排除',
  pure.classifyArtifact('CONSTRAINTS.md') === 'excluded' &&
  pure.classifyArtifact('PROFILE.md') === 'excluded' &&
  pure.classifyArtifact('SOURCE.md') === 'excluded')
check('交接排除', pure.classifyArtifact('第1章 概述/段1/交接.md') === 'excluded')
check('结课报告（含归档名）排除',
  pure.classifyArtifact('结课报告.md') === 'excluded' &&
  pure.classifyArtifact('结课报告·2026-11-16-1000.md') === 'excluded')
check('点目录排除', pure.classifyArtifact('.knowbase/modules/x.md') === 'excluded')
check('普通正文不误收', pure.classifyArtifact('第1章 概述/笔记.md') === 'excluded')

console.log('\n=== 2. 盘点与排序 ===')
const inv = pure.buildArtifactInventory([
  { relInWs: '第2章 调度/章末复习/复习讲义.md', sizeBytes: 20 },
  { relInWs: '第1章 概述/段2/讲义·概述.md', sizeBytes: 30 },
  { relInWs: '第1章 概述/段1/visuals/结构图.html', sizeBytes: 40 },
  { relInWs: '第1章 概述/mindmaps/知识结构.json', sizeBytes: 50 },
  { relInWs: '第1章 概述/测验·随堂测验.md', sizeBytes: 60 },
  { relInWs: '课程.md', sizeBytes: 70 },
  { relInWs: 'SOURCES/1·概述/原件.pdf', sizeBytes: 80 },
])
check('只保留五类产物（4 份）', inv.length === 4, `got ${inv.length}`)
check('题单不进候选', !inv.some((a) => a.relInWs.includes('测验')))
check('排序：章号优先', inv[0].chapterRel === '第1章 概述' && inv[3].chapterRel === '第2章 调度')
check('同章内组顺序 review→lecture→summary→mindmap→visual',
  inv[0].group === 'lecture' && inv[1].group === 'mindmap' && inv[2].group === 'visual',
  inv.map((a) => a.group).join(','))
check('条目带 kind 与 size', inv[0].kind === 'md' && inv[2].kind === 'html' && inv[1].kind === 'json' && inv[0].sizeBytes === 30)
check('章节归属可解析', pure.chapterRelOf('第12章 综合/段1/讲义·综合.md') === '第12章 综合')
check('无章归属返回 null', pure.chapterRelOf('课程助手/output/总结·复盘.md') === null)

console.log('\n=== 3. 目标路径与名称清洗 ===')
check('非法字符替换并折叠', pure.sanitizeTargetSegment('  a/b:c*d?e"f<g>h|i  ') === 'a b c d e f g h i')
check('尾点尾空格清理', pure.sanitizeTargetSegment('结课资料. . ') === '结课资料')
check('`..` 拒绝', pure.sanitizeTargetSegment('..') === '' && pure.sanitizeTargetSegment(' . ') === '')
check('空串拒绝', pure.sanitizeTargetSegment('') === '')
check('超长截 40', pure.sanitizeTargetSegment('x'.repeat(80)).length === 40)
const target = { space: '考研', notebook: '408 操作系统', subfolder: '结课资料', keepChapter: true }
const entry = {
  stageRelInWs: '待整理/章末复习/第3章 进程/复习讲义.md',
  chapterRel: '第3章 进程',
}
check('保留章目录', pure.depositTargetRel(target, entry) === '考研/408 操作系统/结课资料/第3章 进程/复习讲义.md')
check('平铺（不保留章目录）', pure.depositTargetRel({ ...target, keepChapter: false }, entry) === '考研/408 操作系统/结课资料/复习讲义.md')
check('空子文件夹跳过', pure.depositTargetRel({ ...target, subfolder: '  ', keepChapter: false }, entry) === '考研/408 操作系统/复习讲义.md')
check('暂存路径带组与章', pure.stagingRelFor('review', '第3章 进程/章末复习/复习讲义.md') === '待整理/章末复习/第3章 进程/复习讲义.md')
check('归档报告名', /^结课报告·\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(pure.reportArchiveName(new Date('2026-11-16T10:05:00'))))

console.log('\n=== 4. 结课报告 ===')
const report = pure.renderCourseEndReport({
  courseName: '408 操作系统',
  startedAt: '2026-08-15T00:00:00.000Z',
  endedAt: '2026-11-16T10:00:00.000Z',
  chapters: 12,
  total: 140,
  learned: 64,
  segments: 21,
  endedSegments: 18,
  openSegments: 3,
  quizzes: { quizzes: 4, avgScore: 82, wrong: 27, topTags: ['进程同步', '死锁'] },
  missingChapters: ['虚拟内存', '文件系统'],
  deposit: { deposited: 27, targetRel: '考研/408 操作系统/结课资料', kept: 2 },
})
check('含 frontmatter title / course / endedAt',
  report.includes('title: 408 操作系统 · 结课报告') && report.includes('course: 408 操作系统') && report.includes('endedAt: 2026-11-16T10:00:00.000Z'))
check('含基本情况 / 复盘 / 资料处置三段',
  report.includes('## 基本情况') && report.includes('## 复盘') && report.includes('## 资料处置'))
check('写完成度与未收尾段', report.includes('64/140') && report.includes('未收尾段：3 个'))
check('写错题标签与沉淀目标', report.includes('进程同步、死锁') && report.includes('27 份 → 考研/408 操作系统/结课资料'))
check('无绝对路径', !/[A-Za-z]:\\|\/home\/|\/Users\//.test(report))
const noQuiz = pure.renderCourseEndReport({
  ...{
    courseName: '政治', startedAt: null, endedAt: '2026-11-16T10:00:00.000Z', chapters: 6, total: 60,
    learned: 12, segments: 3, endedSegments: 1, openSegments: 2, quizzes: null, missingChapters: [],
  },
  deposit: { deposited: 0, targetRel: null, kept: 0 },
})
check('无测验写 —', noQuiz.includes('- 测验：—'))
check('未沉淀写「未沉淀」', noQuiz.includes('- 已沉淀：未沉淀'))
const sum = pure.extractReportSummary(report)
check('摘要取复盘第一条', sum.startsWith('完成情况：已学 64/140 个知识点'), sum)
check('无复盘段回落 fallback', pure.extractReportSummary('# x\n\n## 其它\n- a', '回退') === '回退')

console.log('\n=== 5. 课程摘要（选择页 / 结课口径） ===')
const outline = {
  title: 'T', goal: '', anchor: '',
  chapters: [
    { id: 'c1', name: '一', units: [{ id: 'u1', name: 'a', goal: '', source: '' }, { id: 'u2', name: 'b', goal: '', source: '' }] },
    { id: 'c2', name: '二', units: [{ id: 'u3', name: 'c', goal: '', source: '' }] },
    { id: 'c3', name: '空章', units: [] },
  ],
}
const ws = {
  units: { u1: { status: 'mastered', mastery: 1, lastCheckedAt: null }, u2: { status: 'mastered', mastery: 1, lastCheckedAt: null }, u3: { status: 'mastered', mastery: 1, lastCheckedAt: null } },
  lessons: {},
  reviews: { c1: { sessionId: 's1', rel: '第1章/x/复习讲义.md' }, c2: { sessionId: 's2', rel: '第2章/x/复习讲义.md' }, c3: { sessionId: 's3', rel: null } },
}
const full = summaryMod.summarizeCourseState(outline, ws)
check('全学完 + 有知识点章都有讲义 = ready', full.ready === true && full.learned === 3 && full.total === 3)
check('空章不阻塞 ready', full.chapters === 3 && full.reviewsDone === 2)
const partial = summaryMod.summarizeCourseState(outline, { ...ws, units: { ...ws.units, u3: { status: 'todo', mastery: 0, lastCheckedAt: null } }, reviews: {} })
check('部分完成不 ready', partial.ready === false && partial.learned === 2 && partial.reviewsDone === 0)
check('未学完的知识点不算（open 段覆盖）',
  summaryMod.summarizeCourseState(outline, { ...ws, lessons: { s9: { unitIds: ['u1'], order: 1, status: 'open', sources: [], handoffRel: null } } }).learned === 2)
check('无大纲返回 null', summaryMod.summarizeCourseState(null, ws) === null)
check('空大纲不 ready', summaryMod.summarizeCourseState({ ...outline, chapters: [] }, ws).ready === false)
const seg = summaryMod.summarizeSegments(outline, {
  lessons: {
    a: { unitIds: ['u1'], order: 1, status: 'ended', sources: [], handoffRel: null },
    b: { unitIds: ['u2'], order: 2, status: 'open', sources: [], handoffRel: null },
    orphan: { unitIds: ['zzz'], order: 1, status: 'open', sources: [], handoffRel: null },
  },
})
check('段统计只算本大纲章节', eq(seg, { segments: 2, ended: 1, open: 1 }), JSON.stringify(seg))
check('完成度文案', pure.completionText(64, 140, 5, 12) === '64/140 · 5/12')

// 读盘包装：progress.json 是仓库级文件，不在工作区文件夹内（回归：曾按工作区路径读，进度恒为 0）
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-course-ws-'))
fs.writeFileSync(path.join(tmpWs, '课程.md'), '# 课程：T\n\n## [c1] 一\n- u1 | a | | \n\n## [c2] 二\n- u2 | b | | \n', 'utf-8')
const progPath = path.join(tmpWs, 'progress.json')
fs.writeFileSync(progPath, JSON.stringify({
  v: 2,
  workspaces: {
    ws1: {
      lessons: {},
      units: { u1: { status: 'mastered', mastery: 1, lastCheckedAt: null }, u2: { status: 'mastered', mastery: 1, lastCheckedAt: null } },
      reviews: { c1: { sessionId: 's1', rel: 'r1.md' }, c2: { sessionId: 's2', rel: 'r2.md' } },
    },
  },
}), 'utf-8')
const diskSummary = summaryMod.summarizeCourseWorkspace(tmpWs, 'ws1', progPath)
check('读盘摘要从仓库级 progress 取数', !!diskSummary && diskSummary.learned === 2 && diskSummary.ready === true, JSON.stringify(diskSummary))
check('无课程.md 返回 null', summaryMod.summarizeCourseWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-course-empty-')), 'ws1', progPath) === null)

console.log('\n=== 6. 文件接线（静态） ===')
const endMain = path.join(ROOT, 'electron/lib/aiTeachingCourseEnd.ts')
check('主进程结课模块存在', fs.existsSync(endMain))
const wsSrc = read('electron/lib/aiTeachingWorkspaces.ts')
check('workspaces.json 有 endedAt', wsSrc.includes('endedAt'))
check('WorkspaceInfo 带课程摘要', wsSrc.includes('course:') && wsSrc.includes('summarizeCourseWorkspace'))
const repo = read('../phrontis-core/src/kbStore/knowledgeVaultRepo.ts')
check('vaultCreatePage 支持 extraFrontmatter', repo.includes('extraFrontmatter') && repo.includes('CREATE_PAGE_RESERVED_FM'))

console.log('\n=== 7. 只读守卫与接线 ===')
const guard = read('electron/lib/aiTeachingCourseEndGuard.ts')
check('守卫导出 assertWorkspaceEditable / 会话守卫', guard.includes('export function assertWorkspaceEditable') && guard.includes('export function assertCourseEditableBySession'))
const courseSrc = read('electron/lib/aiTeachingCourse.ts')
check('大纲 / 段 / 复习写接口有守卫',
  /writeCourseOutline[\s\S]{0,200}assertWorkspaceEditable/.test(courseSrc) &&
  /openSegment[\s\S]{0,300}isCourseEnded/.test(courseSrc) &&
  /endSegment[\s\S]{0,200}assertCourseEditableBySession/.test(courseSrc) &&
  /writeChapterReviewDoc[\s\S]{0,400}assertCourseEditableBySession/.test(courseSrc))
check('复习课结课后只放行已有会话',
  /isCourseEnded\(id\)[\s\S]{0,160}sessionExists\(existing\.sessionId\)/.test(courseSrc))
check('课程注入带结课只读提示', courseSrc.includes('endedNote') && courseSrc.includes('本课程已结课'))
const tools = read('electron/lib/builtinTools.ts')
check('vault 写工具按会话检查结课', /aiTeachingWriteBoundaryError\([^)]*ctx\)/.test(tools) && tools.includes('assertCourseEditableBySession'))
const sources = read('electron/lib/aiTeachingSourceRegistry.ts')
check('素材登记 / 分配 / 提取有守卫', /registerSources[\s\S]{0,250}assertWorkspaceEditable/.test(sources) && /extractSource[\s\S]{0,250}assertWorkspaceEditable/.test(sources))
const preload = read('electron/preload/index.ts')
check('preload 暴露结课 IPC', preload.includes('aiTeachCourse:depositEndArtifacts') && preload.includes('aiTeachCourse:reopenCourse'))
const ipc = read('src/lib/ipc.ts')
check('渲染层 ipc 封装存在', ipc.includes('aiTeachCourseEndCourse') && ipc.includes('aiTeachCourseGetDepositTargets'))
const main = read('electron/main/index.ts')
check('主进程注册结课 handler', main.includes('registerAiTeachingCourseEndHandlers'))
const rail = read('src/modules/ai-teaching/CourseRail.tsx')
check('课程树支持只读', rail.includes('readOnly') && rail.includes('disabled={disabled}'))
const flow = read('src/modules/ai-teaching/CourseEndFlow.tsx')
check('结课流程三步步进 + 直接结课', flow.includes('确认结课') && flow.includes('挑选资料') && flow.includes('整理沉淀') && flow.includes('直接结课'))
check('结课流程无解释性长段文案', !/不会删除任何文件|收集 = |沉淀后课程文件保留|结课后仍可/.test(flow))

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
fs.rmSync(tmp, { recursive: true, force: true })
fs.rmSync(tmpWs, { recursive: true, force: true })
if (failed.length) process.exit(1)
