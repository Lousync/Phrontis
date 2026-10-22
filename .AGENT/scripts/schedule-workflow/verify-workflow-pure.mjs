#!/usr/bin/env node
import {
  addWorkflowCheckpoint,
  buildWorkflowFromTask,
  normalizeWorkflow,
  reorderWorkflowStages,
  splitRangeIntoStages,
  stageDuration,
  updateWorkflowCheckpoint,
  updateWorkflowStage,
  validateWorkflow,
  workflowProgress,
} from '../../../src/modules/schedule/workflowPure.ts'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ''}`)
  }
}

const stage = (id, title, start, end, status = 'planned') => ({
  id,
  title,
  start,
  end,
  status,
  milestone: false,
  checkpoints: [],
})

const flow = () => normalizeWorkflow({
  id: 'wf1',
  title: '测试工作流',
  taskId: 'task1',
  tagId: null,
  color: '#888888',
  start: '2026-10-01',
  end: '2026-10-20',
  stages: [
    stage('a', '准备', '2026-10-01', '2026-10-05', 'done'),
    stage('b', '执行', '2026-10-06', '2026-10-12', 'doing'),
    stage('c', '收尾', '2026-10-13', '2026-10-20'),
  ],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
})

const noOverlap = (stages) => stages.every((s, i) => i === 0 || stages[i - 1].end < s.start)

console.log('\n[splitRangeIntoStages]')
const oneDay = splitRangeIntoStages('2026-10-01', '2026-10-01', 3)
check('1 天拆 3 阶段仍有 3 阶段', oneDay.length === 3)
check('1 天拆 3 阶段无重叠', noOverlap(oneDay))
check('1 天拆 3 阶段各至少 1 天', oneDay.every((s) => stageDuration(s) >= 1))
const crossMonth = splitRangeIntoStages('2026-01-30', '2026-02-03', 3)
check('跨月拆分连续无重叠', noOverlap(crossMonth) && crossMonth[0].start === '2026-01-30' && crossMonth[2].end === '2026-02-03')
const crossYear = splitRangeIntoStages('2026-12-30', '2027-01-02', 2)
check('跨年拆分连续无重叠', noOverlap(crossYear) && crossYear[0].start === '2026-12-30' && crossYear[1].end === '2027-01-02')

console.log('\n[reorderWorkflowStages]')
const original = flow()
const reordered = reorderWorkflowStages(original, ['c', 'a', 'b'])
const durations = original.stages.map(stageDuration).sort((a, b) => a - b)
check('重排后顺序正确', reordered.stages.map((s) => s.id).join(',') === 'c,a,b')
check('重排后无重叠', noOverlap(reordered.stages))
check('重排后总时长不变', reordered.stages.map(stageDuration).sort((a, b) => a - b).join(',') === durations.join(','))
check('重排从工作流开始日排列', reordered.stages[0].start === original.start)
check('重排非法 id 集合不改顺序', reorderWorkflowStages(original, ['a', 'b']).stages.map((s) => s.id).join(',') === 'a,b,c')

console.log('\n[updateWorkflowStage]')
const moveIntoPrev = updateWorkflowStage(original, 'b', { start: '2026-10-02' })
check('开始日落入上一阶段时被夹出', moveIntoPrev.stages[1].start === '2026-10-06')
check('后续阶段自动顺延且无重叠', noOverlap(moveIntoPrev.stages))
const badEnd = updateWorkflowStage(original, 'b', { end: '2026-10-03' })
check('结束日早于开始日时按原时长修正', badEnd.stages[1].end === '2026-10-12')
const pushed = updateWorkflowStage(original, 'a', { end: '2026-10-08' })
check('拉长当前阶段后后续顺延', pushed.stages[1].start === '2026-10-09' && noOverlap(pushed.stages))

console.log('\n[检查点与进度]')
const withCheckpoint = addWorkflowCheckpoint(original, 'b', { title: '中期', start: '2026-09-01', end: '2026-12-01' })
check('检查点被夹进父阶段', withCheckpoint.stages[1].checkpoints[0].start >= withCheckpoint.stages[1].start
  && withCheckpoint.stages[1].checkpoints[0].end <= withCheckpoint.stages[1].end)
const movedCheckpoint = updateWorkflowCheckpoint(withCheckpoint, 'b', withCheckpoint.stages[1].checkpoints[0].id, { start: '2026-10-11' })
check('更新检查点仍在父阶段内', movedCheckpoint.stages[1].checkpoints[0].start === '2026-10-11')
check('进度只统计正式阶段', workflowProgress({ ...withCheckpoint, stages: withCheckpoint.stages.map((s, i) => ({ ...s, status: i === 0 ? 'done' : 'planned' })) }).pct === 33)

console.log('\n[边界与校验]')
const empty = normalizeWorkflow({ ...flow(), stages: [] })
check('0 阶段工作流可接受', empty.stages.length === 0)
check('0 阶段进度为 0', workflowProgress(empty).pct === 0)
const built = buildWorkflowFromTask({ id: 't1', title: '写报告', date: '2026-10-10', time: '2026-10-15 18:00' }, { id: 'tag1', color: '#123456' }, '2026-10-01T00:00:00.000Z')
check('任务建流绑定 taskId/tagId', built.taskId === 't1' && built.tagId === 'tag1' && built.color === '#123456')
check('任务建流 3 阶段且无重叠', built.stages.length === 3 && noOverlap(built.stages))
check('合法工作流校验通过', validateWorkflow(original).ok)
const broken = updateWorkflowStage(original, 'b', { start: '2026-10-07' })
broken.stages[1].start = '2026-10-01'
check('重叠工作流校验失败', !validateWorkflow(broken).ok)

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
