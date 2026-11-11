#!/usr/bin/env node
/**
 * 契约：AI 教学讲课口径（小步引导 / 整段精讲）+ 画图 Skill 资产。
 *
 * 背景：基础人设的「简洁直接」会让讲课退化成总结；而旧版 teachStyleHint 又要求一条回答
 * 写完整篇小讲义，模型只能一次倒完。2026-11-10 拍板默认改成「小步引导」：
 *   - 一条回答只推进一个台阶，讲完给一个具体检查问题并停下等学生回答；
 *   - 设置 aiTeachLectureStyle 可切回「整段精讲」（旧行为）；
 *   - 完整教材 / 讲义仍一次性落盘，但对话里不贴全文；
 *   - 文案在零依赖 pure 文件 teachStylePrompt.ts，本脚本 strip 类型后直接跑真实实现。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-teach-style.mjs
 * 输出纯 ASCII（禁 emoji）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`)
  }
}

// ---------------------------------------------------------------- 1. 纯函数真实实现
console.log('\n[讲课口径] electron/lib/teachStylePrompt.ts')
const PURE_REL = 'electron/lib/teachStylePrompt.ts'
const pureSrc = read(PURE_REL)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-style-'))
const tmpFile = path.join(tmpDir, 'teachStylePrompt.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const mod = await import(pathToFileURL(tmpFile).href)
const { buildTeachStyleHint, normalizeTeachStyleMode, DEFAULT_TEACH_STYLE_MODE } = mod

check('默认模式 = stepwise', DEFAULT_TEACH_STYLE_MODE === 'stepwise', String(DEFAULT_TEACH_STYLE_MODE))
check('expanded 原样保留', normalizeTeachStyleMode('expanded') === 'expanded', '')
check('非法值回落 stepwise', normalizeTeachStyleMode('nonsense') === 'stepwise', '')
check('undefined 回落 stepwise', normalizeTeachStyleMode(undefined) === 'stepwise', '')

const step = buildTeachStyleHint('stepwise')
check('小步：一条回答只推进一个台阶', step.includes('一条回答只推进一个台阶'))
check('小步：正文 300–500 字上限', step.includes('300–500 字'))
check('小步：讲完立刻停下等回答', step.includes('讲完立刻停下') && step.includes('等待学生回答'))
check('小步：禁止自问自答', step.includes('不要自问自答'))
check('小步：答错只纠正当前这一步', step.includes('只纠正当前这一步'))
check('小步：禁止一次给完定义+推导+例题+总结', step.includes('定义 + 推导 + 例题 + 总结'))
check('小步：检查问题用正文，不用 ask 卡', step.includes('`ask` 只用于需要学生做选择/确认的场合'))
check('小步：quiz 快检只在完整知识点后', step.includes('`quiz` 快检只在讲完一个完整知识点后'))
check('小步：例外=用户明确要求一次讲完', step.includes('一次讲完') && step.includes('整段精讲') && step.includes('直接说不用互动'))
check('小步：教材落盘但对话不贴全文', step.includes('不要把全文贴进对话'))
check('小步：旧版手册冲突以本条为准', step.includes('以本条为准'))
check('小步：保留素材不足 / AI 补充', step.includes('素材不足') && step.includes('AI 补充'))

const expanded = buildTeachStyleHint('expanded')
check('整段精讲：保留旧八步结构', expanded.includes('问题/场景') && expanded.includes('最后才总结'))
check('整段精讲：不含小步要求（负向）', !expanded.includes('一条回答只推进一个台阶'))
check('两种模式文案不同', step !== expanded)

// ---------------------------------------------------------------- 2. agentService 接线
console.log('\n[接线] electron/lib/agentService.ts')
const agent = stripComments(read('electron/lib/agentService.ts'))
check('导入 buildTeachStyleHint', agent.includes('buildTeachStyleHint'))
check('导入 normalizeTeachStyleMode', agent.includes('normalizeTeachStyleMode'))
check('读取 aiTeachLectureStyle', agent.includes("('aiTeachLectureStyle')"))
check('只对 aiTeaching 注入', /const teachStyleHint = source === 'aiTeaching'/.test(agent))
check('systemFull 拼入 teachStyleHint', agent.includes('+ courseHint + teachStyleHint +'))
check('ruleChars 统计 teachStyleHint', agent.includes('teachStyleHint.length'))
check('旧硬编码长文案已下线（负向）', !agent.includes('讲知识点必须展开：问题/场景'))

// ---------------------------------------------------------------- 3. 设置 schema
console.log('\n[设置] src/lib/settings.ts')
const settings = read('src/lib/settings.ts')
check('定义 aiTeachLectureStyle', settings.includes('aiTeachLectureStyle:'))
check('默认 stepwise', /aiTeachLectureStyle:\s*\{[^}]*default:\s*'stepwise'/.test(settings))
check('anchor = aiTeach.lectureStyle', settings.includes("anchor: 'aiTeach.lectureStyle'"))
check('aiTab = teach', /aiTeachLectureStyle:\s*\{[^}]*aiTab:\s*'teach'/.test(settings))

// ---------------------------------------------------------------- 4. 设置 UI
console.log('\n[UI] src/modules/settings/views/AiTeachingView.tsx')
const ui = read('src/modules/settings/views/AiTeachingView.tsx')
check('教学页有讲课节奏行', ui.includes('data-setting-anchor="aiTeach.lectureStyle"'))
check('有 stepwise 选项', ui.includes('value="stepwise"'))
check('有 expanded 选项', ui.includes('value="expanded"'))

// ---------------------------------------------------------------- 5. 段会话纪律
console.log('\n[段会话纪律] electron/lib/aiTeachingCourse.ts')
const course = stripComments(read('electron/lib/aiTeachingCourse.ts'))
check('纪律引用 system 讲课口径', course.includes('讲课节奏以 system 的讲课口径为准'))
check('单个台阶检查用正文一句话', course.includes('单个台阶的检查用正文一句话'))
check('quiz 快检只在完整知识点后', course.includes('quiz 快检只在讲完一个完整知识点后'))

// ---------------------------------------------------------------- 6. 帮助文档
console.log('\n[帮助文档] resources/help')
const helpPerm = read('resources/help/AI 权限与工具边界.md')
check('权限页列出讲课节奏', helpPerm.includes('讲课节奏'))
const helpCourse = read('resources/help/AI 教学 · 课程模式.md')
check('课程模式页说明小步引导', helpCourse.includes('小步引导') && helpCourse.includes('一个台阶'))
check('课程模式页补检索关键词', helpCourse.includes('讲课节奏, 小步引导'))

// ---------------------------------------------------------------- 7. 画图 Skill 资产
console.log('\n[画图 Skill] resources/skills')
const skills = [
  ['resources/skills/stem-diagram/SKILL.md', 'stem-diagram', '理工科示意图'],
  ['resources/skills/math-plot/SKILL.md', 'math-plot', '数学函数图'],
]
for (const [rel, id, title] of skills) {
  const abs = path.join(ROOT, rel)
  check(`${rel} 存在`, fs.existsSync(abs))
  if (!fs.existsSync(abs)) continue
  const text = read(rel)
  check(`${id} frontmatter id`, new RegExp(`^id:\\s*${id}\\s*$`, 'm').test(text))
  check(`${id} frontmatter title`, text.includes(`title: ${title}`))
  check(`${id} 提示词 <= 6000 字符（显式注入上限）`, text.length <= 6000, `actual=${text.length}`)
  check(`${id} 引用 visual.html`, text.includes('visual.html'))
  check(`${id} 禁止自由摆坐标/手画`, text.includes('不要手画') || text.includes('不要自由摆坐标'))
}

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
