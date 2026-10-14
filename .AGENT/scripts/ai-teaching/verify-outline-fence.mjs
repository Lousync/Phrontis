#!/usr/bin/env node
/**
 * 对话驱动建课 Phase 3 契约：```outline 草稿围栏 + 卡片 + IPC 四层。
 * 跑法：node .AGENT/scripts/ai-teaching/verify-outline-fence.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const agent = read('electron/lib/agentService.ts')
const mod = read('src/modules/ai-teaching/index.tsx')
const preload = read('electron/preload/index.ts')
const ipc = read('src/lib/ipc.ts')
const types = read('src/types/index.ts')
const course = read('electron/lib/aiTeachingCourse.ts')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

console.log('\n[协议注入] agentService.ts')
check('新增 outlineRuleHint（```outline 草稿协议）', agent.includes('outlineRuleHint') && agent.includes('大纲草稿协议'))
check('并入 system 拼接', /baseSystem[\s\S]{0,400}outlineRuleHint/.test(agent))
check('并入 ruleChars 统计', agent.includes('outlineRuleHint.length'))

console.log('\n[渲染层] index.tsx')
check('解析 ```outline 围栏', mod.includes('/```outline') && mod.includes('outlineFence'))
check('草稿 JSON 解析 outlineDraft', mod.includes('outlineDraft'))
check('正式生成提交 commitOutlineDraft', mod.includes('commitOutlineDraft') && mod.includes('aiTeachCourseWriteOutlineDraft'))
check('草稿卡含「正式生成」，「继续修改」已删', mod.includes('正式生成') && !mod.includes('>继续修改<'))
check('落盘后转「已落盘 · 课程.md」+「打开课程」', mod.includes('已落盘 · 课程.md') && mod.includes('打开课程') && mod.includes('outlineCommitted'))
check('打开课程跳编辑区（kb-open-note 带 from aiTeaching）', /const openCourseOutline[\s\S]{0,400}kb-open-note[\s\S]{0,120}from: 'aiTeaching'/.test(mod))
check('未展开章显示锁定提示', mod.includes('未展开'))
check('正文剥离 outline 围栏', mod.includes('(profile|plan|ask|outline)'))

// 2026-10-14：草稿卡从「输入区带子」挪进**产生它的那条回复**里（docs/ai-outline-inline-plan.md）
console.log('\n[草稿卡内联] index.tsx')
check('按消息下标挂在对应那条回复里', mod.includes('outlineFence?.idx === idx'))
check('卡居中且与输入区同宽（max-w-[820px] mx-auto px-3）', /mt-2 w-full max-w-\[820px\] mx-auto px-3">[\s\S]{0,420}课程大纲草稿/.test(mod))
check('章节列表不再内部滚动（旧 220px 内滚已删）', !mod.includes('flex flex-col gap-1 max-h-[220px] overflow-auto'))
check('已从输入区带子移走（旧带子外壳后不再跟草稿卡标题）', !/shrink-0 w-full max-w-\[820px\] mx-auto px-3[\s\S]{0,80}课程大纲草稿/.test(mod))
check('落盘态按草稿内容比对（内容一变退回未落盘）', mod.includes('outlineDone.fence === outlineFence.raw'))

console.log('\n[IPC 四层] writeOutlineDraft')
check('主进程 handler', course.includes("ipcMain.handle('aiTeachCourse:writeOutlineDraft'"))
check('preload 暴露', preload.includes('aiTeachCourseWriteOutlineDraft'))
check('types 声明', types.includes('aiTeachCourseWriteOutlineDraft'))
check('ipc.ts 封装', ipc.includes('export const aiTeachCourseWriteOutlineDraft'))
// 「打开课程」需要落盘路径：append 分支此前只回 added（2026-10-14 补 relPath）
check('writeOutlineFromAssistant 两条分支都回 relPath', course.includes("mode: 'append', added: r.added, relPath: rel"))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
