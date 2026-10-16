/**
 * 契约验证：AI教学·课程模式（docs/ai-teaching-course-mode-plan.md）。
 *
 * 两类断言：
 *  A. 纯函数真实实现执行 —— 直接 strip-types import `electron/lib/aiTeachingCoursePure.ts`（零依赖），
 *     验证 `课程.md` 解析/重写往返、模型 JSON 容错解析（不复刻逻辑）。
 *  B. IPC 四件套 + 注入接线静态断言 —— 防止「加了口子忘了接线」（本模块此类漏接是静默的：
 *     通道名写错一个字符，界面就只是「点了没反应」，没有任何报错）。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/ai-teaching/verify-course-mode.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const count = (s, sub) => s.split(sub).length - 1

// ---------------------------------------------------------------- A. 纯函数真实实现
const PURE_REL = 'electron/lib/aiTeachingCoursePure.ts'
const pureSrc = read(PURE_REL)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-verify-'))
const tmpFile = path.join(tmpDir, 'aiTeachingCoursePure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const { parseCourseMd, rewriteCourseMd, parseOutlineJson, balancedJsonObjects, cleanField, sourceKey, sourceSnapshot, mergeOutlineAdditions, moveUnitInOutline } = await import(pathToFileURL(tmpFile).href)

console.log('\n=== 1. parseCourseMd：解析章/知识点/来源 ===')
const sample = [
  '# 课程：408 操作系统',
  '- 目标: 三轮过完',
  '- 依据: 考研 408 考纲',
  '',
  '## 二、进程与处理器',
  '- u1 | 进程与线程 | 状态转换 | 考纲 §2.1',
  '- u2 | 调度算法 | RR 取舍 | 考纲 §2.2',
  '',
  '## 三、内存管理',
  '- u3 | 虚拟内存 | 页表 | 考纲 §3.2',
  '',
].join('\n')
const p = parseCourseMd(sample)
check('标题解析', p.title === '408 操作系统', p.title)
check('目标解析', p.goal === '三轮过完', p.goal)
check('依据解析', p.anchor === '考研 408 考纲', p.anchor)
check('章数量 = 2', p.chapters.length === 2, String(p.chapters.length))
check('第二章名解析', p.chapters[0].name === '二、进程与处理器', p.chapters[0]?.name)
check('第一章知识点 = 2', p.chapters[0].units.length === 2, String(p.chapters[0].units.length))
check('知识点字段（id/name/goal/source）全解析', p.chapters[0].units[1].id === 'u2' && p.chapters[0].units[1].name === '调度算法' && p.chapters[0].units[1].goal === 'RR 取舍' && p.chapters[0].units[1].source === '考纲 §2.2', JSON.stringify(p.chapters[0].units[1]))

console.log('\n=== 2. rewriteCourseMd / parseCourseMd 往返一致 ===')
const outline = {
  title: '408 操作系统', goal: '三轮过完', anchor: '考研 408 考纲',
  chapters: [
    { id: 'c1', name: '一、概述', units: [{ id: 'u1', name: '功能与结构', goal: '', source: '考纲 §1.1' }] },
    { id: 'c2', name: '二、进程', units: [
      { id: 'u2', name: '进程与线程', goal: '状态转换', source: '考纲 §2.1' },
      { id: 'u3', name: '调度算法', goal: 'RR 取舍', source: 'AI 补充' },
    ] },
  ],
}
const round = parseCourseMd(rewriteCourseMd(outline))
check('往返后与原文等值', JSON.stringify(round) === JSON.stringify(outline), JSON.stringify(round))

console.log('\n=== 3. cleanField：换行 / 竖线不破坏行格式 ===')
check('竖线换全角', cleanField('a|b') === 'a／b', cleanField('a|b'))
check('换行折空格', cleanField('a\nb') === 'a b', cleanField('a\nb'))
const dirty = { ...outline, title: 'A|B', chapters: [{ id: 'c1', name: 'ch\n1', units: [{ id: 'u1', name: 'x|y', goal: '', source: '' }] }] }
const dirtyRound = parseCourseMd(rewriteCourseMd(dirty))
check('脏字段重写后仍可被解析（章数不丢）', dirtyRound.chapters.length === 1 && dirtyRound.chapters[0].units.length === 1, JSON.stringify(dirtyRound))

console.log('\n=== 4. parseOutlineJson：容错围栏与前后杂字 ===')
const good = '```json\n{"title":"T","goal":"G","anchor":"A","chapters":[{"name":"C1","units":[{"name":"k1","goal":"g1","source":"考纲 §1"},{"name":"k2","goal":"","source":"AI 补充"}]}]}\n```'
const g = parseOutlineJson(good)
check('围栏 JSON 可解析', g !== null && g.chapters[0].units.length === 2, JSON.stringify(g))
check('知识点 id 顺序生成 u1/u2', g.chapters[0].units[0].id === 'u1' && g.chapters[0].units[1].id === 'u2', JSON.stringify(g.chapters[0].units.map(u => u.id)))
const noisy = '好的，这是大纲：\n{"title":"T2","chapters":[{"name":"C","units":[{"name":"k"}]}]}\n希望有帮助。'
check('前后杂字可解析（取首尾大括号）', parseOutlineJson(noisy)?.title === 'T2', JSON.stringify(parseOutlineJson(noisy)))
check('空 units 的章被丢弃', parseOutlineJson('{"chapters":[{"name":"C","units":[]}]}') === null, '')
check('非法文本返回 null', parseOutlineJson('not json at all') === null, '')
const reasoning = '先想一下 {"草稿":"含 {大括号} 的推理片段","ok":false} 嗯……最终答案：\n```json\n{"title":"T3","chapters":[{"name":"C","units":[{"name":"k"}]}]}\n```\n以上。'
check('思考噪声 + 含大括号推理片段可解析（取答案）', parseOutlineJson(reasoning)?.title === 'T3', JSON.stringify(parseOutlineJson(reasoning)))
const twoObjs = '{"a":{"b":1}} 中间 {"title":"T4","chapters":[{"name":"C","units":[{"name":"k"}]}]}'
check('多候选从后往前取（后者为大纲）', parseOutlineJson(twoObjs)?.title === 'T4', JSON.stringify(parseOutlineJson(twoObjs)))
check('balancedJsonObjects 配对扫描出 2 个顶层对象', balancedJsonObjects('{"a":{"b":1}} tail {"c":2}').length === 2, '')

console.log('\n=== 4b. 课程增补纯函数：SOURCE 快照 / 只增补合并 ===')
// 2026-10-11：修订抽屉与其流式「增补 JSON」解析（diffSources / normalizeAdditions）随三条死通道一并删除
// （无渲染入口；修订走提示词 + 工具 course.outline.write(append=true)）。此处只覆盖仍在用的纯函数。
const base = sourceSnapshot([
  { no: 1, name: '概念.pdf', path: './a.pdf', extracted: '-' },
  { no: 2, name: '考纲.md', path: './b.md', extracted: '✓ → b-p1-9.md' },
])
check('sourceSnapshot：键取 name+path（重编号不影响）', base.length === 2 && base[0].key === sourceKey('概念.pdf', './a.pdf'), JSON.stringify(base[0]))
check('sourceSnapshot：原样保留 no/name/path/extracted', base[1].no === 2 && base[1].name === '考纲.md' && base[1].path === './b.md' && base[1].extracted === '✓ → b-p1-9.md', JSON.stringify(base[1]))
check('sourceSnapshot：空输入 → 空数组', sourceSnapshot([]).length === 0 && sourceSnapshot(undefined).length === 0, '')

const baseOutline = { title: 'T', goal: '', anchor: '', chapters: [
  { id: 'c1', name: '一', units: [{ id: 'u1', name: 'a', goal: '', source: '' }] },
  { id: 'c2', name: '二', units: [{ id: 'u2', name: 'b', goal: '', source: '' }] },
] }
const merged = mergeOutlineAdditions(baseOutline, {
  toExisting: [
    { chapterId: 'c2', name: 'b' },
    { chapterId: 'c2', name: 'c', source: 'AI 补充' },
    { chapterId: '不存在', name: 'x' },
  ],
  newChapters: [{ name: '三', units: [{ name: 'd' }] }],
})
check('merge：现有 id 全保留', merged.outline.chapters[0].units[0].id === 'u1' && merged.outline.chapters[1].units[0].id === 'u2', '')
check('merge：同名去重 + 定位不到现有章丢弃 → added=2', merged.added === 2, String(merged.added))
check('merge：新 id 递增 u3/u4', merged.outline.chapters[1].units.some((u) => u.id === 'u3') && merged.outline.chapters[2].units[0].id === 'u4', JSON.stringify(merged.outline.chapters.map((c) => c.units.map((u) => u.id))))
check('merge：新章追加在末尾', merged.outline.chapters.length === 3 && merged.outline.chapters[2].name === '三', '')
check('merge：新条目 source 缺省=AI 增补', merged.outline.chapters[2].units[0].source === 'AI 增补', merged.outline.chapters[2].units[0].source)

console.log('\n=== 4c. moveUnitInOutline：画布拖拽重排（id 必须保留）===')
// 2026-10-16：学习流画布拖拽跨章/同章搬移 —— 走 moveUnitInOutline 而不是 writeOutlineDraft，
// 后者按章重建会重编号，而 progress.json 以 unit id 为键 → 重排即丢进度。
const mv = { title: 'T', goal: '', anchor: '', chapters: [
  { id: 'c1', name: '一', units: [{ id: 'u1', name: 'a', goal: 'g1', source: 's1' }, { id: 'u2', name: 'b', goal: '', source: '' }, { id: 'u3', name: 'c', goal: '', source: '' }] },
  { id: 'c2', name: '二', units: [{ id: 'u4', name: 'd', goal: '', source: '' }] },
] }
const into = moveUnitInOutline(mv, 'u1', 'c2', 'u4')
check('跨章：移到目标章首位', into.ok && into.outline.chapters[1].units.map((u) => u.id).join(',') === 'u1,u4', JSON.stringify(into.outline.chapters.map((c) => c.units.map((u) => u.id))))
check('跨章：源章移除该项', into.outline.chapters[0].units.map((u) => u.id).join(',') === 'u2,u3', '')
check('跨章：字段原样保留（name/goal/source）', JSON.stringify(into.outline.chapters[1].units[0]) === JSON.stringify({ id: 'u1', name: 'a', goal: 'g1', source: 's1' }), JSON.stringify(into.outline.chapters[1].units[0]))
check('不改动入参', mv.chapters[0].units.length === 3 && mv.chapters[1].units.length === 1, '')
const end = moveUnitInOutline(mv, 'u1', 'c1', null)
check('同章：beforeUnitId=null → 追加到章末', end.ok && end.outline.chapters[0].units.map((u) => u.id).join(',') === 'u2,u3,u1', JSON.stringify(end.outline.chapters[0].units.map((u) => u.id)))
const reorder = moveUnitInOutline(mv, 'u3', 'c1', 'u1')
check('同章：拖到首位', reorder.ok && reorder.outline.chapters[0].units.map((u) => u.id).join(',') === 'u3,u1,u2', JSON.stringify(reorder.outline.chapters[0].units.map((u) => u.id)))
check('拖到自己前面 = 无操作（返回原引用）', moveUnitInOutline(mv, 'u2', 'c1', 'u2').ok && moveUnitInOutline(mv, 'u2', 'c1', 'u2').outline === mv, '')
check('找不到知识点 → 失败且不改动', moveUnitInOutline(mv, 'u9', 'c1', null).ok === false, '')
check('目标章不存在 → 失败', moveUnitInOutline(mv, 'u1', 'c9', null).ok === false, '')
check('目标位置不存在 → 失败', moveUnitInOutline(mv, 'u1', 'c1', 'u9').ok === false, '')
const movedRound = parseCourseMd(rewriteCourseMd(into.outline))
check('重排后可往返落盘（id 稳定）', JSON.stringify(movedRound) === JSON.stringify(into.outline), JSON.stringify(movedRound))

// ---------------------------------------------------------------- B. 接线静态断言
console.log('\n=== 5. IPC 四件套 + 注入接线（剥注释后）===')
const main = stripComments(read('electron/lib/aiTeachingCourse.ts'))
const mainIndex = stripComments(read('electron/main/index.ts'))
const preload = stripComments(read('electron/preload/index.ts'))
const types = stripComments(read('src/types/index.ts'))
const ipc = stripComments(read('src/lib/ipc.ts'))
const agent = stripComments(read('electron/lib/agentService.ts'))
const bus = stripComments(read('electron/main/windowBus.ts'))

const channels = ['aiTeachCourse:getState', 'aiTeachCourse:setEnabled', 'aiTeachCourse:writeOutlineDraft', 'aiTeachCourse:removeUnit', 'aiTeachCourse:moveUnit', 'aiTeachCourse:setUnitProgress', 'aiTeachCourse:openUnit', 'aiTeachCourse:endLesson', 'aiTeachCourse:finalizeLesson', 'aiTeachCourse:finishUnit', 'aiTeachCourse:readPrevHandoff', 'aiTeachCourse:makeUnitQuiz', 'aiTeachCourse:openAssistant', 'aiTeachCourse:openChapterReview']
check('主进程注册全部 14 个 handler', channels.every((c) => main.includes(c)), channels.filter((c) => !main.includes(c)).join(','))
// 负向（2026-10-11 后续）：一次性 / 流式大纲生成 + 保存三条死通道已删（零渲染调用点）；
// 建课活路径 = 对话里 ```outline 草稿 → 「正式生成」→ writeOutlineDraft。
check('主进程不再注册大纲生成/保存三通道', !main.includes('aiTeachCourse:saveOutline') && !main.includes('aiTeachCourse:generateOutline'), '')
// 负向（2026-10-11）：修订三通道已删——无渲染入口；修订能力走提示词 + 工具 course.outline.write(append=true)
check('主进程不再注册修订三通道', !main.includes('aiTeachCourse:getSourceChanges') && !main.includes('aiTeachCourse:reviseOutlineStream') && !main.includes('aiTeachCourse:applyAdditions'), '')
check('主进程导出 registerAiTeachingCourseHandlers', main.includes('export function registerAiTeachingCourseHandlers'), '')
check('main/index.ts import 了注册器', mainIndex.includes('registerAiTeachingCourseHandlers'), '')
check('main/index.ts 调用了注册器', /registerAiTeachingCourseHandlers\(/.test(mainIndex), '')
check('windowBus 新增课程广播通道', bus.includes("aiTeachCourseRefresh: 'aiTeach:course-refresh'"), '')
check('windowBus 不再有生成过程通道（死链已删）', !bus.includes('aiTeachCourseGenProgress') && !bus.includes('course-gen-progress'), '')
check('课程模块不再有一次性 / 流式大纲生成（死链已删）', !main.includes('invokeLlmStreamInternal') && !main.includes('function generateCourseOutline') && !main.includes('function buildOutlinePrompt'), '')
check('agentService import 了 buildCourseInjection', agent.includes('buildCourseInjection'), '')
check('agentService 把 courseHint 拼进 systemFull', agent.includes('+ courseHint +'), '')

const apiMethods = ['aiTeachCourseGetState', 'aiTeachCourseSetEnabled', 'aiTeachCourseWriteOutlineDraft', 'aiTeachCourseRemoveUnit', 'aiTeachCourseMoveUnit', 'aiTeachCourseSetUnitProgress', 'aiTeachCourseOpenUnit', 'aiTeachCourseEndLesson', 'aiTeachCourseFinalizeLesson', 'aiTeachCourseFinishUnit', 'aiTeachCourseReadPrevHandoff', 'aiTeachCourseMakeUnitQuiz', 'onAiTeachCourseRefresh', 'aiTeachCourseOpenAssistant', 'aiTeachCourseOpenChapterReview']
for (const m of apiMethods) {
  const okPreload = preload.includes(m)
  const okTypes = types.includes(m)
  const okIpc = ipc.includes(m)
  check(`IPC 三层一致：${m}`, okPreload && okTypes && okIpc, `preload=${okPreload} types=${okTypes} ipc=${okIpc}`)
}

console.log('\n=== 6. 前端接线：课程入口与检验写回 ===')
const mod = stripComments(read('src/modules/ai-teaching/index.tsx'))
check('模块 import 了 CourseHome', mod.includes("from './CourseMode'"), '')
check('模块渲染 CourseHome 覆盖层', mod.includes('<CourseHome'), '')
check('模块用 onAiTeachCourseRefresh 订阅刷新', mod.includes('onAiTeachCourseRefresh('), '')
check('检验完成回写知识点掌握度', mod.includes('aiTeachCourseSetUnitProgress(') && mod.includes('courseUnit'), '')
check('开课走 openUnit（自动续课）', mod.includes('aiTeachCourseOpenUnit('), '')
check('结束课时接线', mod.includes('aiTeachCourseEndLesson(') && mod.includes('aiTeachCourseFinalizeLesson('), '')
check('知识点收尾接线', mod.includes('aiTeachCourseFinishUnit('), '')
check('上节交接界面条接线', mod.includes('aiTeachCourseReadPrevHandoff(') && mod.includes('prevHandoff'), '')
check('回炉复习接线', mod.includes('courseReopenUnit('), '')
check('课程主页组件存在', fs.existsSync(path.join(ROOT, 'src/modules/ai-teaching/CourseMode.tsx')), '')
const course = stripComments(read('src/modules/ai-teaching/CourseMode.tsx'))
// 负向断言（2026-10-11）：无渲染入口的平行实现——「修订大纲」抽屉与「建课向导」已整体删除。
// 修订能力保留在**提示词 + 工具**里：用户跟课程助手说「改大纲 / 展开下一章」→ course.outline.write(append=true)。
check('CourseMode 已删无入口的 ReviseDrawer', !course.includes('function ReviseDrawer'), '')
check('CourseMode 已删无入口的 Wizard（建课向导）', !course.includes('function Wizard'), '')
check('CourseMode 不再直调修订三通道', !course.includes('aiTeachCourseGetSourceChanges(') && !course.includes('aiTeachCourseReviseOutlineStream(') && !course.includes('aiTeachCourseApplyAdditions('), '')
check('主进程保留 applyOutlineAdditions（活路径：course.outline.write append=true）', main.includes('function applyOutlineAdditions'), '')
check('主进程已删修订三函数', !main.includes('function getSourceChanges') && !main.includes('function buildRevisePrompt') && !main.includes('function reviseCourseOutlineStream'), '')
// 负向（2026-10-11 后续）：建课向导已删 → 一次性生成专用的「按勾选素材拼依据 + 直读素材正文」
// （buildMaterialsAnchor / outlineMaterials / readSourceEntryBody / readTextDirBody / DIR_BODY_LIMIT）整体下线；
// 素材库 aiTeachSrc:* 与 resolveSourcesForInjection 的目录清单注入仍是活路径（见下条）。
check('主进程已删按勾选素材拼依据（buildMaterialsAnchor / outlineMaterials）', !main.includes('buildMaterialsAnchor') && !main.includes('outlineMaterials'), '')
check('工作区素材直读函数存在（SOURCE 快照 / 清单仍用）', read('electron/lib/aiTeachingSources.ts').includes('export function readWorkspaceSourceEntries'), '')
const sources = read('electron/lib/aiTeachingSources.ts')
check('已删一次性生成专用正文读取器（readSourceEntryBody / readTextDirBody / DIR_BODY_LIMIT）', !main.includes('readSourceEntryBody') && !sources.includes('readSourceEntryBody') && !sources.includes('readTextDirBody') && !sources.includes('DIR_BODY_LIMIT'), '')
check('目录素材清单仍递归读取（resolveSourcesForInjection 活路径）', sources.includes('function listDirFilesRecursive') && sources.includes("e.type === 'dir' && e.path"), '')
// 粒度 / 元信息两条规则由已删的 buildOutlinePrompt **搬进活路径**的 outlineRuleHint（```outline 草稿协议，agentService.ts），
// 按围栏协议口径锁住，防再次丢失。
check('outlineRuleHint 含知识点粒度要求（一个可独立讲解的最小概念 / 不要一整节压成一个）', agent.includes('知识点粒度：拆到「一个可独立讲解、可出题检验的最小概念」为止') && agent.includes('**不要**把一整节压成一个'), '')
check('outlineRuleHint 排除导语/教学目标等元信息', agent.includes('**不要**把章节导语、教学目标、考试目标 / 考情分析、重难点提示、学习要求、知识结构总览、复习建议这类元信息当作知识点'), '')

console.log('\n=== 6b. 课程助手（整门课唯一会话 · 顾问注入）===')
check('主进程导出 openCourseAssistant 并使用 assistantSessionId', main.includes('export function openCourseAssistant') && main.includes('assistantSessionId'), '')
  check('助手注入分支存在（教学助手 / 不逐点开讲 / 建课工具指引）', main.includes('教学助手') && main.includes('逐知识点开讲') && main.includes('course.outline.write'), '')
check('顾问注入无大纲也可用（不提前 return）', main.includes('!hasOutline && !isAssistant'), '')
check('渲染层第三档「课程助手」+ assistantSid 视图 + 打开函数', mod.includes('课程助手') && mod.includes('assistantSid') && mod.includes('courseOpenAssistant'), '')

console.log('\n=== 6c. 章末复习课（每章一个 · 讨论产出落盘）===')
check('CourseState/接口增 reviews', main.includes('export interface ChapterReview') && main.includes('reviews: Record<string, ChapterReview>'))
check('openChapterReview 导出（懒建/复用会话）', main.includes('export function openChapterReview') && main.includes('复习课·${chapter.name}'))
check('writeChapterReviewDoc 导出（写章目录 + 记 rel）', main.includes('export function writeChapterReviewDoc') && main.includes("'复习讲义.md'"))
check('chapterFolderRel 章级文件夹 {章号}·{章名}', main.includes('export function chapterFolderRel') && main.includes('`${wsFolder}/${no}·${safe(name)}`'))
check('lessonFolderRel 复习分支落章目录', main.includes('revChapter') && main.includes('chapterFolderRel(wsId, revChapter, getSetting)'))
check('getSessionUnitFolderRel 复习课返 null', main.includes('if (findReviewBySession(sessionId)) return null'))
check('buildCourseInjection 复习分支（人设 + 落盘工具）', main.includes('reviewHit') && main.includes('course.review.write') && main.includes('章末复习'))
check('IPC aiTeachCourse:openChapterReview', main.includes("ipcMain.handle('aiTeachCourse:openChapterReview'"))
check('preload 通道 aiTeachCourseOpenChapterReview', preload.includes('aiTeachCourseOpenChapterReview:'))
const typesSrc = stripComments(read('src/types/index.ts'))
check('types: AiTeachChapterReview + state.reviews + API', typesSrc.includes('export interface AiTeachChapterReview') && typesSrc.includes('reviews: Record<string, AiTeachChapterReview>') && typesSrc.includes('aiTeachCourseOpenChapterReview:'))
check('ipc.ts 封装', stripComments(read('src/lib/ipc.ts')).includes('export const aiTeachCourseOpenChapterReview'))
const bt = stripComments(read('electron/lib/builtinTools.ts'))
check('工具 course.review.write + 进 request 清单', bt.includes("name: 'course.review.write'") && bt.includes('course.review.write）默认不在工具列表中'))
check('画布章框复习课入口（onOpenChapterReview）', stripComments(read('src/modules/ai-teaching/flow/FlowCanvas.tsx')).includes('onOpenChapterReview') && stripComments(read('src/modules/ai-teaching/flow/FlowCanvas.tsx')).includes('复习课'))
check('index.tsx: 打开函数 + 复习课态左栏', mod.includes('courseOpenChapterReview') && mod.includes('courseReviewChapter') && mod.includes('复习课'))

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
