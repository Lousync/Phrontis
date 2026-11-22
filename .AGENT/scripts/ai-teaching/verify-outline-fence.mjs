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
const tools = read('electron/lib/builtinTools.ts')
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
check('并入 ruleChars 统计（protocols 聚合）', agent.includes('+ outlineRuleHint +'))

// 2026-11-22 批次 2：新生成的大纲要能带 type / requires
const outlineHint = (() => {
  const at = agent.indexOf('const outlineRuleHint')
  const end = agent.indexOf('\n  const ', at + 10)
  return agent.slice(at, end > 0 ? end : at + 4000)
})()
console.log('\n[大纲 v2 产出规则] agentService.ts · outlineRuleHint')
check('提示词说明 type 取值（memory/concept/procedure/design）',
  ['memory', 'concept', 'procedure', 'design'].every((t) => outlineHint.includes(t)), '')
check('提示词说明 requires 为同章先修、无依赖可省略',
  outlineHint.includes('requires') && outlineHint.includes('本章内') && outlineHint.includes('省略'), '')
check('提示词写明先修不改章顺序 / 不产生环 / 不引用不存在',
  outlineHint.includes('不改变章的顺序') && outlineHint.includes('不要产生环') && outlineHint.includes('本章不存在'), '')
check('草稿 JSON 示例带上 type / requires',
  /"units":\[\{[^}]*"type"[^}]*"requires"/.test(outlineHint), '')

const toolAt = tools.indexOf("name: 'course.outline.write'")
const toolEnd = tools.indexOf('registerTool({', toolAt)
const toolBlock = tools.slice(toolAt, toolEnd > 0 ? toolEnd : toolAt + 4000)
const schemaChars = (text) => {
  const at = text.indexOf('inputSchema:')
  if (at < 0) return 0
  const start = text.indexOf('{', at)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1).split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trim()).join('').length
      }
    }
  }
  return 0
}
console.log('\n[工具 schema] builtinTools.ts · course.outline.write')
check('units[] 有 type（enum 四值）与 requires（string[]）',
  toolBlock.includes("enum: ['memory', 'concept', 'procedure', 'design']")
  && /requires:\s*\{\s*type:\s*'array',\s*items:\s*\{\s*type:\s*'string'\s*\},\s*description:\s*'[^']*同章先修/.test(toolBlock), '')
const outlineSchemaChars = schemaChars(toolBlock)
check(`单工具 schema ${outlineSchemaChars} 字符 <= 800（铁律 16）`, outlineSchemaChars > 0 && outlineSchemaChars <= 800, String(outlineSchemaChars))

console.log('\n[append 映射] aiTeachingCourse.ts · writeOutlineFromAssistant')
check('toExisting / newChapters 都带 type 与 requires',
  (course.match(/type: u\.type, requires: u\.requires/g) || []).length === 2, '')
check('create 分支也把 requires 名称转 id（resolveOutlineRequires）', course.includes('resolveOutlineRequires(norm)'), '')

console.log('\n[渲染层] index.tsx')
check('解析 ```outline 围栏', mod.includes('/```outline') && mod.includes('outlineFence'))
check('草稿 JSON 解析 outlineDraft', mod.includes('outlineDraft'))
check('正式生成提交 commitOutlineDraft', mod.includes('commitOutlineDraft') && mod.includes('aiTeachCourseWriteOutlineDraft'))
check('草稿卡含「正式生成」，「继续修改」已删', mod.includes('正式生成') && !mod.includes('>继续修改<'))
check('落盘后转「已落盘 · 课程.md」+「打开课程」', mod.includes('已落盘 · 课程.md') && mod.includes('打开课程') && mod.includes('outlineCommitted'))
check('打开课程跳编辑区（kb-open-note 带 from aiTeaching）', /const openCourseOutline[\s\S]{0,400}kb-open-note[\s\S]{0,120}from: 'aiTeaching'/.test(mod))
check('未展开章显示锁定提示', mod.includes('未展开'))
check('正文剥离 outline 围栏', mod.includes('(profile|plan|ask|outline'))

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
check('writeOutlineFromAssistant 两条分支都回 relPath', /mode: 'append', added: r\.added, droppedRequires: r\.droppedRequires, relPath: rel/.test(course))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
