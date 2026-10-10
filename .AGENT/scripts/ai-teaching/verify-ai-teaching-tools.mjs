#!/usr/bin/env node
/**
 * 对话驱动建课 Phase 2 契约：教学助手工具接线。
 * 静态断言为主（aiTeachingCourse 依赖 electron，无法在纯 Node 直接跑）。
 * 跑法：node .AGENT/scripts/ai-teaching/verify-ai-teaching-tools.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const course = read('electron/lib/aiTeachingCourse.ts')
const tools = read('electron/lib/builtinTools.ts')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

console.log('\n[业务函数] aiTeachingCourse.ts')
check('导出 inventoryWorkspaceSource', course.includes('export function inventoryWorkspaceSource'))
check('导出 writeOutlineFromAssistant', course.includes('export function writeOutlineFromAssistant'))
check('导出 removeCourseUnit', course.includes('export function removeCourseUnit'))
check('导出 archiveOrganizedPage', course.includes('export function archiveOrganizedPage'))
check('清点仅支持 dir 素材（单个 pdf/pptx 提示先转写）', course.includes("e.type !== 'dir'") && course.includes('先转写为 md'))
check('大纲写入支持 append 增补', course.includes("mode: 'append'") && course.includes('applyOutlineAdditions'))
check('删除已学知识点 → needOrganize 拒绝', course.includes("status !== 'todo'") && course.includes('needOrganize: true'))
check('归档返回绝对路径 absPath', course.includes('absPath: join(dirAbs, fname)'))
check('归档默认落会话 write-owner（助手 output/）', course.includes('resolveWriteOwnerRel(String(sessionId'))
check('归档拒绝写入隐藏/点目录', course.includes("s.startsWith('.')"))

console.log('\n[工具注册] builtinTools.ts')
check('注册 inventory', tools.includes("name: 'inventory'"))
check('注册 course.outline.write', tools.includes("name: 'course.outline.write'"))
check('注册 course.outline.remove-unit', tools.includes("name: 'course.outline.remove-unit'"))
check('注册 course.organize.archive', tools.includes("name: 'course.organize.archive'"))
check('四工具 requires:write + tier:ondemand', (tools.match(/requires: 'write', tier: 'ondemand'/g) || []).length >= 4)
check('工作区解析走 getWorkspaceOfSession', tools.includes('requireAiTeachWs') && tools.includes('getWorkspaceOfSession(sid)'))
check('builtin.tool.request 清单含新工具', tools.includes('course.outline.write / course.outline.remove-unit / course.organize.archive'))

console.log('\n[权限放行] 课程助手注入')
check('不再有「只读约束」', !course.includes('【只读约束】'))
check('注入说明含建课工具指引', course.includes('course.outline.write') && course.includes('course.organize.archive') && course.includes('inventory'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
