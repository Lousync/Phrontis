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
const { parseCourseMd, rewriteCourseMd, parseOutlineJson, balancedJsonObjects, cleanField, sourceSnapshot, diffSources, normalizeAdditions, mergeOutlineAdditions } = await import(pathToFileURL(tmpFile).href)

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

console.log('\n=== 4b. 课程修订纯函数：SOURCE 快照 diff / 增补解析 / 只增补合并 ===')
const base = sourceSnapshot([
  { no: 1, name: '概念.pdf', path: './a.pdf', extracted: '-' },
  { no: 2, name: '考纲.md', path: './b.md', extracted: '✓ → b-p1-9.md' },
])
const differ = diffSources(base, [
  { no: 1, name: '概念.pdf', path: './a.pdf', extracted: '-' },
  { no: 2, name: '考纲.md', path: './b.md', extracted: '✓ → b-p1-20.md' },
  { no: 3, name: '实验.md', path: './c.md', extracted: '-' },
])
check('diffSources：未变=null', differ[0].change === null, JSON.stringify(differ[0]))
check('diffSources：提取指针变=updated', differ[1].change === 'updated', JSON.stringify(differ[1]))
check('diffSources：键不存在=new', differ[2].change === 'new', JSON.stringify(differ[2]))
check('diffSources：无快照时全为 new', diffSources([], differ).every((d) => d.change === 'new'), '')

const addRaw = '```json\n{"toExisting":[{"chapterId":"c2","name":"MLFQ","goal":"多级队列","source":"素材#4","why":"调度偏薄"},{"name":"","chapter":"c2"}],"newChapters":[{"name":"三、虚拟内存","units":[{"name":"页面置换","why":"细虚存"}]}]}\n```'
const add = normalizeAdditions(addRaw)
check('normalizeAdditions：围栏 JSON 可解析', add !== null && add.toExisting.length === 1 && add.newChapters.length === 1, JSON.stringify(add))
check('normalizeAdditions：空 name 项被丢弃', add.toExisting.length === 1, '')
check('normalizeAdditions：非增补文本返回 null', normalizeAdditions('没有增补') === null, '')
const noisyAdd = '推理一下 {"x":1} 最终：{"toExisting":[{"chapterName":"二","name":"新点"}],"newChapters":[]} 完。'
check('normalizeAdditions：思考噪声取答案', normalizeAdditions(noisyAdd)?.toExisting[0]?.name === '新点', '')

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

// ---------------------------------------------------------------- B. 接线静态断言
console.log('\n=== 5. IPC 四件套 + 注入接线（剥注释后）===')
const main = stripComments(read('electron/lib/aiTeachingCourse.ts'))
const mainIndex = stripComments(read('electron/main/index.ts'))
const preload = stripComments(read('electron/preload/index.ts'))
const types = stripComments(read('src/types/index.ts'))
const ipc = stripComments(read('src/lib/ipc.ts'))
const agent = stripComments(read('electron/lib/agentService.ts'))
const bus = stripComments(read('electron/main/windowBus.ts'))

const channels = ['aiTeachCourse:getState', 'aiTeachCourse:setEnabled', 'aiTeachCourse:saveOutline', 'aiTeachCourse:setUnitProgress', 'aiTeachCourse:generateOutline', 'aiTeachCourse:generateOutlineStream', 'aiTeachCourse:openUnit', 'aiTeachCourse:endLesson', 'aiTeachCourse:finalizeLesson', 'aiTeachCourse:finishUnit', 'aiTeachCourse:readPrevHandoff', 'aiTeachCourse:makeUnitQuiz', 'aiTeachCourse:getSourceChanges', 'aiTeachCourse:reviseOutlineStream', 'aiTeachCourse:applyAdditions', 'aiTeachCourse:openAssistant']
check('主进程注册全部 16 个 handler', channels.every((c) => main.includes(c)), channels.filter((c) => !main.includes(c)).join(','))
check('主进程导出 registerAiTeachingCourseHandlers', main.includes('export function registerAiTeachingCourseHandlers'), '')
check('main/index.ts import 了注册器', mainIndex.includes('registerAiTeachingCourseHandlers'), '')
check('main/index.ts 调用了注册器', /registerAiTeachingCourseHandlers\(/.test(mainIndex), '')
check('windowBus 新增课程广播通道', bus.includes("aiTeachCourseRefresh: 'aiTeach:course-refresh'"), '')
check('windowBus 新增生成过程通道', bus.includes("aiTeachCourseGenProgress: 'aiTeach:course-gen-progress'"), '')
check('生成走流式（invokeLlmStreamInternal）', main.includes('invokeLlmStreamInternal'), '')
check('agentService import 了 buildCourseInjection', agent.includes('buildCourseInjection'), '')
check('agentService 把 courseHint 拼进 systemFull', agent.includes('+ courseHint +'), '')

const apiMethods = ['aiTeachCourseGetState', 'aiTeachCourseSetEnabled', 'aiTeachCourseSaveOutline', 'aiTeachCourseSetUnitProgress', 'aiTeachCourseGenerateOutline', 'aiTeachCourseGenerateOutlineStream', 'aiTeachCourseOpenUnit', 'aiTeachCourseEndLesson', 'aiTeachCourseFinalizeLesson', 'aiTeachCourseFinishUnit', 'aiTeachCourseReadPrevHandoff', 'aiTeachCourseMakeUnitQuiz', 'onAiTeachCourseGenProgress', 'onAiTeachCourseRefresh', 'aiTeachCourseGetSourceChanges', 'aiTeachCourseReviseOutlineStream', 'aiTeachCourseApplyAdditions', 'aiTeachCourseOpenAssistant']
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
check('课程主页有「修订大纲」入口 + 抽屉组件', course.includes('修订大纲') && course.includes('function ReviseDrawer'), '')
check('修订抽屉调三层 IPC', course.includes('aiTeachCourseGetSourceChanges(') && course.includes('aiTeachCourseReviseOutlineStream(') && course.includes('aiTeachCourseApplyAdditions('), '')
check('主进程实现修订三函数', main.includes('function getSourceChanges') && main.includes('function reviseCourseOutlineStream') && main.includes('function applyOutlineAdditions'), '')
check('主进程按勾选素材拼依据（buildMaterialsAnchor + sourceKeys）', main.includes('buildMaterialsAnchor') && main.includes('sourceKeys'), '')
check('工作区素材直读函数存在', read('electron/lib/aiTeachingSources.ts').includes('export function readWorkspaceSourceEntries'), '')
check('向导用勾选表（sourceKeys 回传 + 有正文标记）', course.includes('sourceKeys') && course.includes('有正文'), '')
check('主进程读素材正文含「md/文本素材自身文件」', main.includes('readSourceEntryBody') && read('electron/lib/aiTeachingSources.ts').includes('export function readSourceEntryBody'), '')
const sources = read('electron/lib/aiTeachingSources.ts')
check('主进程读素材正文支持「目录素材」（readTextDirBody + dir 分支）', sources.includes('function readTextDirBody') && sources.includes("e.type === 'dir'"), '')
check('目录素材正文递归读文本文件', sources.includes('listDirFilesRecursive') && sources.includes('DIR_BODY_LIMIT'), '')
check('大纲 prompt 含知识点粒度要求（不要一整节压成一个）', main.includes('一个可独立讲解') && main.includes('不要'), '')
check('大纲 prompt 排除导语/教学目标等元信息', main.includes('教学目标') && main.includes('知识结构总览') && main.includes('元信息'), '')

console.log('\n=== 6b. 课程助手（整门课唯一会话 · 顾问注入）===')
check('主进程导出 openCourseAssistant 并使用 assistantSessionId', main.includes('export function openCourseAssistant') && main.includes('assistantSessionId'), '')
check('顾问注入分支存在（课程顾问 / 只读约束 / 不逐点开讲）', main.includes('课程顾问') && main.includes('只读约束') && main.includes('不要逐知识点开讲'), '')
check('顾问注入无大纲也可用（不提前 return）', main.includes('!hasOutline && !isAssistant'), '')
check('渲染层第三档「课程助手」+ assist 视图 + 打开函数', mod.includes('课程助手') && mod.includes("courseView === 'assist'") && mod.includes('courseOpenAssistant'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
