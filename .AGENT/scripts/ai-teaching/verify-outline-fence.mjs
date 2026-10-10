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
check('草稿卡含「继续修改 / 正式生成」', mod.includes('继续修改') && mod.includes('正式生成'))
check('未展开章显示锁定提示', mod.includes('未展开'))
check('正文剥离 outline 围栏', mod.includes('(profile|plan|ask|outline)'))

console.log('\n[IPC 四层] writeOutlineDraft')
check('主进程 handler', course.includes("ipcMain.handle('aiTeachCourse:writeOutlineDraft'"))
check('preload 暴露', preload.includes('aiTeachCourseWriteOutlineDraft'))
check('types 声明', types.includes('aiTeachCourseWriteOutlineDraft'))
check('ipc.ts 封装', ipc.includes('export const aiTeachCourseWriteOutlineDraft'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
