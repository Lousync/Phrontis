#!/usr/bin/env node
/**
 * 对话驱动建课 Phase 4/5 契约：流程改造（撤建课向导 / 助手驱动 / 删知识点 / 分批提示）。
 * 跑法：node .AGENT/scripts/ai-teaching/verify-conversational-flow.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const mod = read('src/modules/ai-teaching/index.tsx')
const cm = read('src/modules/ai-teaching/CourseMode.tsx')
const course = read('electron/lib/aiTeachingCourse.ts')
const preload = read('electron/preload/index.ts')
const ipc = read('src/lib/ipc.ts')
const types = read('src/types/index.ts')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

console.log('\n[流程改造] index.tsx')
check('课程态恒开（不再依赖 courseState.enabled 开关）', mod.includes('const courseEnabled = !!activeWs && activeWs !== ') && !mod.includes('const courseEnabled = !!courseState?.enabled'))
check('进入工作区自动开启课程态', mod.includes('aiTeachCourseSetEnabled(ws, true)'))
check('CourseHome 传 onGoChat（跳回对话）', mod.includes("onGoChat={() => setCourseView('chat')}"))

console.log('\n[课程主页] CourseMode.tsx')
check('新增 onGoChat prop', cm.includes('onGoChat?: () => void'))
check('无大纲态指向教学助手（不再进建课向导）', cm.includes('去和教学助手聊聊') && !cm.includes("setView('wizard')"))
check('移除「＋ 修订大纲」按钮（并入助手）', !cm.includes('＋ 修订大纲'))
check('底部改为「展开下一章」提示', cm.includes('展开下一章'))
check('知识点删除按钮 + 已学守卫', cm.includes('doRemoveUnit') && cm.includes("st !== 'todo'") && cm.includes('整理归档'))

console.log('\n[IPC 四层] removeUnit')
check('主进程 handler', course.includes("ipcMain.handle('aiTeachCourse:removeUnit'"))
check('preload 暴露', preload.includes('aiTeachCourseRemoveUnit'))
check('types 声明', types.includes('aiTeachCourseRemoveUnit'))
check('ipc.ts 封装', ipc.includes('export const aiTeachCourseRemoveUnit'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
