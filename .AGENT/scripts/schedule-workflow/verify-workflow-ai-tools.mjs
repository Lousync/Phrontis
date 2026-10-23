#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ''}`) }
}

const tools = read('electron/lib/builtinTools.ts')
const agent = read('electron/lib/agentService.ts')
const names = [
  'builtin.schedule.list-workflows',
  'builtin.schedule.get-workflow',
  'builtin.schedule.create-workflow',
  'builtin.schedule.update-workflow',
  'builtin.schedule.delete-workflow',
  'builtin.schedule.mutate-stage',
  'builtin.schedule.reorder-stages',
  'builtin.schedule.mutate-checkpoint',
]

console.log('\n[注册] 工作流工具')
for (const name of names) check(`注册 ${name}`, tools.includes(`name: '${name}'`))
for (const name of names) check(`日程白名单 ${name}`, agent.includes(`'${name}'`))
for (const name of names) check(`tool.request 清单 ${name}`, tools.includes(name.replace('builtin.', '')))

const writeTools = names.filter(n => !n.endsWith('list-workflows') && !n.endsWith('get-workflow'))
for (const name of writeTools) {
  const idx = tools.indexOf(`name: '${name}'`)
  const block = tools.slice(idx, idx + 2600)
  check(`写权限 ${name}`, block.includes("requires: 'write'"))
  check(`ondemand ${name}`, block.includes("tier: 'ondemand'"))
  check(`广播 ${name}`, block.includes("broadcastDataChanged('schedule')"))
}
for (const name of ['builtin.schedule.list-workflows', 'builtin.schedule.get-workflow']) {
  const idx = tools.indexOf(`name: '${name}'`)
  const block = tools.slice(idx, idx + 1800)
  check(`只读 ${name}`, block.includes('readOnly: true'))
  check(`ondemand ${name}`, block.includes("tier: 'ondemand'"))
}

console.log('\n[任务工具] 预计时长 / 收集箱')
check('create-todo 支持 estimateMin', tools.includes('estimateMin: { type: \'number\', description: \'预计分钟\' }'))
check('create-todo 支持空日期收集箱', tools.includes("args.date !== undefined && rawDate === ''"))
check('update-todo 支持 estimateMin', tools.includes("estimateMin: { type: 'number', description: '预计时长（分钟），null=清除' }"))
check('normalizeTodoPatch 校验 estimateMin', tools.includes('estimateMin 必须是 1..10080'))

console.log('\n[AI 人设与上下文]')
check('人设包含工作流规则', agent.includes('工作流：用户说') && agent.includes('reorder-stages'))
check('人设说明工具自动归一化日期', agent.includes('工具会自动归一化并顺延'))
check('删除任务级联说明', agent.includes('删除任务会级联删除其工作流'))
check('日程上下文注册', read('src/modules/schedule/index.tsx').includes('registerAssistantContext'))
check('上下文含选中工作流', read('src/modules/schedule/index.tsx').includes("type: 'schedule.workflow'"))
check('已删除拆解指令', !read('src/lib/chatCommands.ts').includes("name: '拆解'"))

console.log('\n[右栏] 三 Tab 与 AI')
const panel = read('src/modules/schedule/ScheduleRightPanel.tsx')
check('右栏任务 / 工作流 / AI', panel.includes("id: 'task'") && panel.includes("id: 'workflow'") && panel.includes("id: 'ai'"))
check('复用 ScheduleAssistantPanel', panel.includes('<ScheduleAssistantPanel />'))
check('无 AI 拆阶段按钮', !read('src/modules/schedule/components/WorkflowPanel.tsx').includes('AI 拆阶段'))

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
