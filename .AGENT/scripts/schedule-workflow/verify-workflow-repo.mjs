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

const repo = read('electron/lib/kbStore/scheduleWorkflowVaultRepo.ts')
console.log('\n[repo] 工作流真相源')
for (const name of [
  'vaultWorkflowsAll', 'vaultWorkflowsSave', 'vaultWorkflowById', 'vaultWorkflowByTask',
  'vaultWorkflowsByTaskIds', 'vaultCreateWorkflow', 'vaultUpdateWorkflow', 'vaultRestoreWorkflow', 'vaultDeleteWorkflow',
  'vaultDeleteWorkflowsByTask', 'vaultAddWorkflowStage', 'vaultUpdateWorkflowStage',
  'vaultDeleteWorkflowStage', 'vaultReorderWorkflowStages', 'vaultAddWorkflowCheckpoint',
  'vaultUpdateWorkflowCheckpoint', 'vaultDeleteWorkflowCheckpoint',
]) check(`导出 ${name}`, repo.includes(`export function ${name}`))
check('使用 workflows.json', repo.includes("const FILE = 'workflows.json'"))
check('写盘走 writeJsonOrThrow', repo.includes('writeJsonOrThrow'))
check('写前 normalizeWorkflow', repo.includes('normalizeWorkflow'))
check('任务 1:1 校验', repo.includes('任务已绑定工作流'))
check('冲突码 WORKFLOW_CONFLICT', repo.includes('WORKFLOW_CONFLICT'))
check('创建时校验数据', repo.includes('validateWorkflow(flow)'))

console.log('\n[任务 repo] 查询与级联')
const taskRepo = read('electron/lib/kbStore/scheduleVaultRepo.ts')
check('vaultTodosAllTopLevel 导出', taskRepo.includes('export function vaultTodosAllTopLevel'))
check('删除任务级联工作流', taskRepo.includes('vaultDeleteWorkflowsByTask(id)'))
check('日视图排除空日期 plan', taskRepo.includes("str(r.date) !== '' && r.task_type === 'plan'"))
check('月视图排除空日期 plan', taskRepo.includes('vaultMonthTodos') && taskRepo.includes("str(r.date) !== ''"))
check('逾期排除空日期', taskRepo.includes("str(r.date) !== '' && str(r.date) < today"))
check('estimate_min 列可写', taskRepo.includes("'estimate_min'"))

console.log('\n[IPC] handlers 与桥接')
const ipc = read('electron/database/repositories/scheduleRepo.ts')
for (const channel of [
  'schedule:getAllTodos', 'schedule:listWorkflows', 'schedule:getWorkflow', 'schedule:getWorkflowByTask',
  'schedule:createWorkflow', 'schedule:updateWorkflow', 'schedule:restoreWorkflow', 'schedule:deleteWorkflow',
  'schedule:addWorkflowStage', 'schedule:updateWorkflowStage', 'schedule:deleteWorkflowStage',
  'schedule:reorderWorkflowStages', 'schedule:addWorkflowCheckpoint',
  'schedule:updateWorkflowCheckpoint', 'schedule:deleteWorkflowCheckpoint',
]) check(`handler ${channel}`, ipc.includes(`'${channel}'`))
check('任务写操作广播 schedule', ipc.includes("broadcastDataChanged('schedule')"))
check('删除任务走级联 repo', ipc.includes('V.vaultDeleteTodoCascade(id)'))
check('任务更新冲突检测', ipc.includes('TASK_CONFLICT'))

const preload = read('electron/preload/index.ts')
for (const name of [
  'getAllScheduleTodos', 'listScheduleWorkflows', 'createScheduleWorkflow', 'updateScheduleWorkflow',
  'restoreScheduleWorkflow', 'deleteScheduleWorkflow', 'addScheduleWorkflowStage', 'updateScheduleWorkflowStage',
  'deleteScheduleWorkflowStage', 'reorderScheduleWorkflowStages', 'addScheduleWorkflowCheckpoint',
  'updateScheduleWorkflowCheckpoint', 'deleteScheduleWorkflowCheckpoint',
]) check(`preload ${name}`, preload.includes(`${name}:`))

const ipcClient = read('src/lib/ipc.ts')
for (const name of [
  'getAllScheduleTodos', 'listScheduleWorkflows', 'createScheduleWorkflow', 'updateScheduleWorkflow',
  'restoreScheduleWorkflow', 'deleteScheduleWorkflow', 'addScheduleWorkflowStage', 'updateScheduleWorkflowStage',
  'deleteScheduleWorkflowStage', 'reorderScheduleWorkflowStages', 'addScheduleWorkflowCheckpoint',
  'updateScheduleWorkflowCheckpoint', 'deleteScheduleWorkflowCheckpoint',
]) check(`ipc.ts ${name}`, ipcClient.includes(`export const ${name}`))

const types = read('src/types/index.ts')
check('ScheduleWorkflow 类型', types.includes('export interface ScheduleWorkflow'))
check('阶段 / 检查点类型', types.includes('export interface ScheduleWorkflowStage') && types.includes('export interface ScheduleWorkflowCheckpoint'))
check('ScheduleExportData 含 workflows', types.includes('workflows: ScheduleWorkflow[]'))
check('Todo 含 estimateMin', types.includes('estimateMin?: number | null'))

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
