/**
 * 契约验证：AI教学 3.14 课程模式静态接线（结构 / 入口 / 注入 / 工具 / 迁移）。
 *
 * 纯函数行为见 `verify-course-segments.mjs`；本脚本只钉「文件与接线没漏」：
 * 这类漏接在应用里是静默的（按钮点了没反应 / AI 说改好了界面没变）。
 *
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-course-mode.mjs .
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

const idx = read('src/modules/ai-teaching/index.tsx')
const course = read('electron/lib/aiTeachingCourse.ts')
const pure = read('electron/lib/aiTeachingCoursePure.ts')
const registry = read('electron/lib/aiTeachingSourceRegistry.ts')
const agent = read('electron/lib/agentService.ts')
const tools = read('electron/lib/builtinTools.ts')
const main = read('electron/main/index.ts')
const rail = read('src/modules/ai-teaching/CourseRail.tsx')
const preflight = read('src/modules/ai-teaching/Preflight.tsx')
const progress = read('src/modules/ai-teaching/CourseProgress.tsx')
const sources = read('src/modules/ai-teaching/CourseSources.tsx')
const req = read('src/modules/ai-teaching/RequirementsDrawer.tsx')
const scopePrompt = read('electron/lib/scopePrompt.ts')

console.log('\n=== 1. 旧模型已下线 ===')
for (const f of [
  'src/modules/ai-teaching/CourseMode.tsx',
  'src/modules/ai-teaching/ScopeDetail.tsx',
  'src/modules/ai-teaching/UnitQuizModal.tsx',
  'src/modules/ai-teaching/prepPolicy.ts',
  'src/modules/ai-teaching/leftRailTree.ts',
  'src/modules/ai-teaching/flow/FlowCanvas.tsx',
]) check(`旧文件已删除：${f}`, !exists(f))
check('index 不再 import 旧模型', !/from '\.\/(CourseMode|ScopeDetail|UnitQuizModal|prepPolicy|leftRailTree|flow\/)/.test(idx))
check('index 不再有准备态 / 学习流 / 层级页签', !/prepStarted|prepTemplate|midView|flowScope|ScopeDetail|CourseHome/.test(idx))
check('index 不再有升格入口', !/agentPromoteSideLane|promoteLane/.test(idx) && !/onPromote=/.test(idx))

console.log('\n=== 2. 新组件接线 ===')
check('index import CourseRail', idx.includes("from './CourseRail'"))
check('index import Preflight', idx.includes("from './Preflight'"))
check('index import CourseProgress', idx.includes("from './CourseProgress'"))
check('index import CourseSources', idx.includes("from './CourseSources'"))
check('index import RequirementsDrawer', idx.includes("from './RequirementsDrawer'"))
check('左栏渲染 CourseRail', idx.includes('<CourseRail') && rail.includes('课程助手') && rail.includes('章末复习'))
check('中栏渲染 Preflight', idx.includes('<Preflight') && preflight.includes('buildPreflight'))
check('右栏进度渲染 CourseProgress', idx.includes('<CourseProgress') && progress.includes('reviewState'))
check('右栏素材渲染 CourseSources', idx.includes('<CourseSources') && sources.includes('aiTeachCourseGetSources'))
check('右栏素材不依赖大纲即可打开', idx.includes('outline={courseState?.outline ?? null}') && !/courseState\?\.outline\s*&&[\s\S]{0,160}<CourseSources/.test(idx))
check('CourseSources 支持无大纲', sources.includes('outline: AiTeachCourseOutline | null') && sources.includes('const hasOutline = chapters.length > 0'))
check('课程助手注入改为左栏开段 + 大纲后终止', course.includes('开讲由用户在左栏点知识点') && course.includes('大纲落盘后的终止规则'))
check('大纲工具结果带 nextStep 引导', course.includes('const OUTLINE_NEXT_STEP') && course.includes('nextStep: OUTLINE_NEXT_STEP'))
check('课程助手 ask 坏开讲选项有客户端兜底', idx.includes('sanitizeCourseAssistantAsk') && idx.includes('去左栏开第 1 段（先做素材预检）') && idx.includes('/开讲|直接讲|继续讲|开始讲/'))
check('course.outline.write 描述禁止落盘后开讲', tools.includes('落盘/更新成功即终止建课流程') && tools.includes('不要问「开讲第 N 章」'))
check('ask 协议禁止大纲后开讲选项', agent.includes('禁止「开讲第 N 章」') && agent.includes('只允许「去左栏开第 1 段」'))
check('outline 协议声明落盘后终止', agent.includes('落盘 / 更新成功即终止建课流程'))
check('大纲落盘卡提供去左栏开段入口', idx.includes('goCourseRailFirstChapter') && idx.includes('去左栏开段'))
check('无大纲素材页提示可先登记', sources.includes('还没有课程大纲。可以先登记素材'))
check('未分配只认当前大纲的有效章', sources.includes('validChapterIds') && sources.includes('.filter(([cid]) => validChapterIds.has(cid))'))
check('右栏三页签 = 进度 / 素材 / 支线', /useState<'progress' \| 'sources' \| 'lanes'>/.test(idx) && idx.includes("setRailTab('progress')") && idx.includes("setRailTab('sources')") && idx.includes("setRailTab('lanes')"))
check('要求抽屉四层（全局 / 本课程 / 本知识点 / 本段）', req.includes("'global'") && req.includes("'workspace'") && req.includes("'unit'") && req.includes("'segment'"))

console.log('\n=== 3. 段 / 复习接线 ===')
check('主进程导出 openSegment / setActiveUnit / endSegment / finalizeSegment', ['openSegment', 'setActiveUnit', 'endSegment', 'finalizeSegment'].every((n) => new RegExp(`export (async )?function ${n}\\(`).test(course)))
check('openSegment 拒绝跨章', course.includes('一段只能覆盖同一章的知识点'))
check('同章只允许一个 open 段', course.includes('本章还有一段没收尾'))
check('endSegment 写 finished=true + mastered', course.includes("finished: true, status: 'mastered'"))
check('openSegment 回炉 finished=false', course.includes("finished: false, status: 'learning'"))
check('readPrevHandoff 用同章 prevSegmentOf', course.includes('prevSegmentOf(') && course.includes('readPrevHandoff'))
check('openChapterReview 用 reviewState 门控', course.includes('reviewState(') && course.includes('学完自动解锁'))
check('index 开段走 aiTeachCourseOpenSegment', idx.includes('aiTeachCourseOpenSegment('))
check('index 收尾走 aiTeachCourseEndSegment + FinalizeSegment', idx.includes('aiTeachCourseEndSegment(') && idx.includes('aiTeachCourseFinalizeSegment('))
check('index 复习走 reviewState 门控提示', idx.includes('reviewState(') && idx.includes('学完自动解锁'))

console.log('\n=== 4. 素材注册表 ===')
check('注册表文件存在', exists('electron/lib/aiTeachingSourceRegistry.ts'))
check('sources.json 路径 = modules/aiTeaching/sources.json', registry.includes("const KEY = 'sources.json'") && registry.includes("const MODULE = 'modules/aiTeaching'"))
check('登记 / 分配 / 提取 / 删除四类业务函数', ['registerSources', 'assignSources', 'extractSource', 'removeSource'].every((n) => new RegExp(`export (async )?function ${n}\\(`).test(registry)))
check('迁移读 SOURCE.md 且不删原文件', registry.includes('parseSourceMd') && !registry.includes('unlinkSync') && !registry.includes('rmSync'))
check('不存绝对路径（rel/url 字段）', registry.includes('toVaultRel') && registry.includes('copyIntoWorkspace') && !registry.includes('absolutePath:'))
check('主进程注册素材注册表 handler', main.includes('registerAiTeachingSourceRegistryHandlers'))
check('index 用 getSources / register / assign / extract', idx.includes('aiTeachCourseGetSources(') && sources.includes('aiTeachCourseRegisterSources(') && sources.includes('aiTeachCourseAssignSources(') && sources.includes('aiTeachCourseExtractSource('))

console.log('\n=== 5. 注入 ===')
check('agentService 用 buildAiTeachSourcesHint', agent.includes('buildAiTeachSourcesHint'))
check('agentService 不再 import resolveSourcesForInjection', !agent.includes('resolveSourcesForInjection'))
check('课程注入要求全量大纲', course.includes('生成**全量**大纲') && agent.includes('一次给全量章'))
check('无段会话不再注入教学推进（buildCourseInjection 有 curLesson 早退）', /const curLesson = s\.lessons\[sessionId\][\s\S]{0,120}if \(!curLesson\) return ''/.test(course))
check('scopePrompt 最细层标题 = 本段要求', scopePrompt.includes('本段要求'))
check('段素材注入只读快照（renderSourcesHint）', course.includes('resolveSegmentSources(') && registry.includes('renderSourcesHint'))

console.log('\n=== 6. 工具 / 数据 ===')
for (const name of ['course.sources.register', 'course.sources.assign', 'course.sources.extract']) {
  check(`工具已注册：${name}`, tools.includes(`name: '${name}'`))
}
check('builtin.tool.request 清单含三个新工具', tools.includes('course.sources.register / course.sources.assign / course.sources.extract'))
check('course.outline.write 描述改为全量', tools.includes('一次给全量章→知识点'))
check('progress 归一化 v1→v2 导出', pure.includes('export function normalizeProgressFile'))
check('课程.md 章 ID 可选解析 + 重写', pure.includes('[A-Za-z0-9_-]') && pure.includes('## [${cid}]'))
check('openSegment 段快照写 sources', course.includes('sources: Array.isArray(sources) ? sources : []'))

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`)
console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
process.exit(failed.length ? 1 : 0)
