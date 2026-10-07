/**
 * 验证「日程 AI 写工具」的参数归一化契约（builtinTools.ts + scheduleVaultRepo.ts 的**真实实现**）。
 *
 * 为什么需要它：`schedule.update-todo` 是 AI 唯一能改待办的入口，它把模型给的自由参数
 * 收敛成 repo 白名单 patch。这里最容易出的事故不是崩溃，而是**静默丢弃**——
 * patch 里写了个白名单外的 key（如 parentId / updatedAt），vaultUpdateTodo 会一声不响地忽略它，
 * 工具照样返回 ok:true，而用户看到的是「AI 说改好了，界面上没变」（AGENTS.md#14 的同型坑）。
 *
 * 所以本脚本做两层断言：
 *   A) 归一化本身：接受 / 拒绝 / 裁剪 / 语义级联（非 deadline 清 time 等不变量）
 *   B) 端到端契约：normalizeTodoPatch 产出的 patch 喂给真 vaultUpdateTodo，**逐字段必须落地**
 *      （而不是被列白名单吃掉），且不得凭空多写列
 *
 * 做法与 verify-snooze-persist.mjs 一致：抽取**真实实现**（只 stub 掉磁盘读写
 * vaultTodosAll / vaultTodosSave），沙箱 data: URL 执行，验的不是复刻品。
 *
 * ⚠️ 抽取已知坑（两处都踩过，2026-09-13）：
 *   1) 起点必须含 `export` 前缀 —— 从 `function xxx` 开始切片会让函数静默不导出；
 *   2) 不能「参数表后第一个 '{' 即函数体」—— 返回类型是对象字面量时（summarizeDeletedTodos 就是）
 *      会切出无函数体的残块，且 import 阶段不报错、导出键直接消失。
 *   所以这里**先整体剥类型再切**：返回类型被替换为空白，参数表后的第一个 '{' 才是函数体。
 *
 * 用法：node .AGENT/scripts/schedule-reminder/verify-ai-schedule-tools.mjs [repo路径]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

// 默认仓库推导自脚本位置（勿写死盘符：在 worktree 里跑会静默校验主仓 → 假 PASS）
const REPO = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const TOOLS_SRC = path.resolve(REPO, 'electron/lib/builtinTools.ts')
const REPO_SRC = path.resolve(REPO, 'electron/lib/kbStore/scheduleVaultRepo.ts')
const toolsSrc = stripTypeScriptTypes(fs.readFileSync(TOOLS_SRC, 'utf8'), { mode: 'strip', sourceMap: false })
const repoSrc = stripTypeScriptTypes(fs.readFileSync(REPO_SRC, 'utf8'), { mode: 'strip', sourceMap: false })

/** 从「已剥类型」的文本里切出 `export function <name>` 的完整定义（配平参数表后再取函数体） */
function sliceFn(text, from) {
  let i = text.indexOf('(', from)
  if (i < 0) throw new Error('未找到参数表起始括号')
  let paren = 0
  for (; i < text.length; i++) {
    if (text[i] === '(') paren++
    else if (text[i] === ')') { paren--; if (paren === 0) { i++; break } }
  }
  const bodyAt = text.indexOf('{', i)
  if (bodyAt < 0) throw new Error('未找到函数体起始大括号')
  let depth = 0
  for (let j = bodyAt; j < text.length; j++) {
    if (text[j] === '{') depth++
    else if (text[j] === '}') {
      depth--
      if (depth === 0) return text.slice(from, j + 1)
    }
  }
  throw new Error('大括号未配平')
}

// ---- repo 侧：列白名单 + vaultUpdateTodo ----
// 注意：类型已先被剥掉（`type TodoColumn` 声明随之消失），所以起点取 `const TODO_COLUMNS`
const colAt = repoSrc.indexOf('const TODO_COLUMNS')
const updAt = repoSrc.indexOf('export function vaultUpdateTodo')
if (colAt < 0 || updAt < 0) throw new Error('scheduleVaultRepo.ts 结构变了：未找到 TODO_COLUMNS / vaultUpdateTodo')
const repoSlice = repoSrc.slice(colAt, updAt) + sliceFn(repoSrc, updAt)

// ---- 工具侧：归一化纯函数块（标记注释 → summarizeDeletedTodos 结束） ----
const MARK = '// ---- 日程 AI 写工具的参数归一化'
const markAt = toolsSrc.indexOf(MARK)
const sumAt = toolsSrc.indexOf('export function summarizeDeletedTodos')
if (markAt < 0 || sumAt < 0) throw new Error('builtinTools.ts 结构变了：未找到归一化工具块')
const toolSlice = toolsSrc.slice(markAt, sumAt) + sliceFn(toolsSrc, sumAt)

// 归一化块依赖 builtinTools 里的两个单行工具函数，按真实定义抽取（不用复刻品）
const strLine = toolsSrc.match(/^const str = .*$/m)?.[0]
const clampLine = toolsSrc.match(/^const clamp = .*$/m)?.[0]
if (!strLine || !clampLine) throw new Error('builtinTools.ts 结构变了：未找到 str / clamp 定义')

const stubs = `
let __rows = []
function vaultTodosAll() { return __rows }
function vaultTodosSave(rows) { __rows = rows }
export function __seed(rows) { __rows = rows }
export function __dump() { return __rows }
`
const js = `${stubs}${repoSlice}\n${strLine}\n${clampLine}\n${toolSlice}`
const mod = await import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`)
for (const fn of ['normalizeTodoPatch', 'summarizeDeletedTodos', 'vaultUpdateTodo']) {
  if (typeof mod[fn] !== 'function') throw new Error(`抽取失败：${fn} 未被导出（见文件头「抽取已知坑」）`)
}

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
/** 期望抛错（参数非法必须在落盘前被拦住） */
const rejects = (name, fn, expectWord) => {
  let err = null
  try { fn() } catch (e) { err = e }
  const msg = err ? String(err.message) : ''
  check(name, !!err && (!expectWord || msg.includes(expectWord)), err ? msg : '未抛错（危险：非法参数被放行）')
}
const accepts = (name, fn, expect) => {
  let out
  try { out = fn() } catch (e) { check(name, false, `意外抛错：${e.message}`); return null }
  const ok = JSON.stringify(out) === JSON.stringify(expect)
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(out)}`)
  return out
}

const NOW = '2026-09-13T07:00:00.000Z'
const baseRow = () => ({
  id: 'todo-1', title: '原标题', description: '', date: '2026-09-13',
  time: null, quadrant: 1, task_type: 'deadline', tag_id: null, status: 'pending',
  sort_order: 0, end_criteria: '', parent_id: null,
  scheduled_start: null, scheduled_end: null, snooze_until: null,
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
})
const subRow = (id, parentId) => ({ ...baseRow(), id, parent_id: parentId, title: `子任务 ${id}` })

// ---------- A. 归一化：合法输入被正确裁剪 ----------
accepts('title 去首尾空格', () => mod.normalizeTodoPatch({ title: '  改后标题  ' }, 'plan'), { title: '改后标题' })
accepts('description 允许空串（= 清空）', () => mod.normalizeTodoPatch({ description: '' }, 'plan'), { description: '' })
accepts('quadrant 越界被 clamp 到 3', () => mod.normalizeTodoPatch({ quadrant: 9 }, 'plan'), { quadrant: 3 })
accepts('quadrant 负数被 clamp 到 0', () => mod.normalizeTodoPatch({ quadrant: -5 }, 'plan'), { quadrant: 0 })
accepts('tagId 空串 = 清空标签', () => mod.normalizeTodoPatch({ tagId: '' }, 'plan'), { tagId: null })
accepts('tagId null = 清空标签', () => mod.normalizeTodoPatch({ tagId: null }, 'plan'), { tagId: null })
accepts('status done 放行', () => mod.normalizeTodoPatch({ status: 'done' }, 'plan'), { status: 'done' })
accepts('排期分钟数 0..1440 放行（1440 = 24:00 收尾）',
  () => mod.normalizeTodoPatch({ scheduledStart: 0, scheduledEnd: 1440 }, 'plan'),
  { scheduledStart: 0, scheduledEnd: 1440 })
accepts('排期 null = 取消排期',
  () => mod.normalizeTodoPatch({ scheduledStart: null, scheduledEnd: null }, 'plan'),
  { scheduledStart: null, scheduledEnd: null })

// ---------- A2. 归一化：非法输入必须在落盘前抛错 ----------
rejects('空 patch 被拒（防 AI 空调用）', () => mod.normalizeTodoPatch({}, 'plan'), '没有可修改的字段')
rejects('白名单外字段单独传被拒', () => mod.normalizeTodoPatch({ parentId: 'x' }, 'plan'), '没有可修改的字段')
rejects('title 全空格被拒', () => mod.normalizeTodoPatch({ title: '   ' }, 'plan'), 'title')
rejects('date 格式错被拒', () => mod.normalizeTodoPatch({ date: '2026/09/13' }, 'plan'), 'YYYY-MM-DD')
rejects('status 打字错误被拒（complete）', () => mod.normalizeTodoPatch({ status: 'complete' }, 'plan'), 'status')
rejects('taskType 非法值被拒', () => mod.normalizeTodoPatch({ taskType: 'todo' }, 'plan'), 'taskType')
rejects('quadrant 非数字被拒', () => mod.normalizeTodoPatch({ quadrant: '2' }, 'plan'), 'quadrant')
rejects('排期起点越界被拒', () => mod.normalizeTodoPatch({ scheduledStart: 1441 }, 'plan'), 'scheduledStart')
rejects('排期起点非整数被拒', () => mod.normalizeTodoPatch({ scheduledStart: 540.5 }, 'plan'), 'scheduledStart')
rejects('排期终点负数被拒', () => mod.normalizeTodoPatch({ scheduledEnd: -30 }, 'plan'), 'scheduledEnd')
rejects('time 只给 HH:mm 被拒（列值要求完整时刻）', () => mod.normalizeTodoPatch({ time: '23:30' }, 'plan'), 'time')
rejects('description 非字符串被拒', () => mod.normalizeTodoPatch({ description: 123 }, 'plan'), 'description')

// ---------- A3. time 的语义不变量（只属于 deadline 类） ----------
accepts('deadline 行 + 传 time：保留',
  () => mod.normalizeTodoPatch({ time: '2026-12-31 23:30' }, 'deadline'), { time: '2026-12-31 23:30' })
accepts('分隔符 T 被归一化为空格',
  () => mod.normalizeTodoPatch({ time: '2026-12-31T23:30' }, 'deadline'), { time: '2026-12-31 23:30' })
accepts('plan 行 + 误传 time：丢弃为 null（同 create-todo 口径）',
  () => mod.normalizeTodoPatch({ time: '2026-12-31 23:30' }, 'plan'), { time: null })
accepts('time 空串 = 清除截止时刻',
  () => mod.normalizeTodoPatch({ time: '' }, 'deadline'), { time: null })
accepts('改成 plan 时顺带清掉残留 DDL',
  () => mod.normalizeTodoPatch({ taskType: 'plan' }, 'deadline'), { taskType: 'plan', time: null })
accepts('改成 deadline 且传 time：保留',
  () => mod.normalizeTodoPatch({ taskType: 'deadline', time: '2026-12-31 23:30' }, 'plan'),
  { taskType: 'deadline', time: '2026-12-31 23:30' })
accepts('只改 status 不碰 time（deadline 行）',
  () => mod.normalizeTodoPatch({ status: 'done' }, 'deadline'), { status: 'done' })

// ---------- B. 端到端契约：patch 逐字段必须真的落地 ----------
const PATCHABLE_KEYS = ['title', 'description', 'date', 'time', 'quadrant', 'taskType', 'tagId',
  'status', 'endCriteria', 'scheduledStart', 'scheduledEnd']
{
  const full = {
    title: '  改后标题  ', description: '改后备注', date: '2026-12-31', time: '2026-12-31 23:30',
    quadrant: 3, taskType: 'deadline', tagId: 'tag-9', status: 'done', endCriteria: '写完即完成',
    scheduledStart: 540, scheduledEnd: 600,
  }
  const patch = mod.normalizeTodoPatch(full, 'plan')
  check('归一化产出的 key 全部在可写集合内（无白名单外泄漏）',
    Object.keys(patch).every((k) => PATCHABLE_KEYS.includes(k)), Object.keys(patch).join(','))

  mod.__seed([baseRow()])
  const before = JSON.stringify(mod.__dump())
  const out = mod.vaultUpdateTodo('todo-1', patch, NOW)
  const row = mod.__dump()[0]
  const EXPECT = {
    title: '改后标题', description: '改后备注', date: '2026-12-31', time: '2026-12-31 23:30',
    quadrant: 3, task_type: 'deadline', tag_id: 'tag-9', status: 'done', end_criteria: '写完即完成',
    scheduled_start: 540, scheduled_end: 600, updated_at: NOW,
  }
  for (const [col, want] of Object.entries(EXPECT)) {
    const ok = row[col] === want
    check(`端到端落地 ${col}`, ok, ok ? '' : `${JSON.stringify(row[col])} ≠ ${JSON.stringify(want)}`)
  }
  check('端到端：返回行 = 持久化行（不是只改内存副本）', JSON.stringify(out) === JSON.stringify(row))
  check('端到端：未新增/未丢失列（列集合不变）',
    JSON.stringify(Object.keys(row).sort()) === JSON.stringify(Object.keys(baseRow()).sort()),
    Object.keys(row).join(','))
  check('端到端：确实发生写入', JSON.stringify(mod.__dump()) !== before)
}
// id 不存在：不建行、不改数据（AI 传错 id 时不能凭空造待办）
{
  mod.__seed([baseRow()])
  const before = JSON.stringify(mod.__dump())
  const out = mod.vaultUpdateTodo('not-exist', mod.normalizeTodoPatch({ status: 'done' }, 'plan'), NOW)
  check('id 不存在：返回 null 且不建行', out === null && JSON.stringify(mod.__dump()) === before)
}

// ---------- C. 删除摘要（删除前算，供 AI 回执与误删重建） ----------
{
  const rows = [baseRow(), subRow('sub-1', 'todo-1'), subRow('sub-2', 'todo-1'), { ...baseRow(), id: 'other' }]
  const s = mod.summarizeDeletedTodos(rows[0], rows)
  check('摘要：标题/日期带出', s.title === '原标题' && s.date === '2026-09-13', JSON.stringify(s))
  check('摘要：子任务计数 = 2（级联删除范围要对用户可见）', s.subtasks === 2, String(s.subtasks))
  check('摘要：time 缺省为空串而非 null', s.time === '', JSON.stringify(s.time))
  check('摘要：排期缺省为 null', s.scheduledStart === null && s.scheduledEnd === null)
  const scheduled = { ...baseRow(), scheduled_start: 540, scheduled_end: 600, time: '2026-09-13 09:00' }
  const s2 = mod.summarizeDeletedTodos(scheduled, [scheduled])
  check('摘要：有排期时原样带出', s2.scheduledStart === 540 && s2.scheduledEnd === 600 && s2.time === '2026-09-13 09:00',
    JSON.stringify(s2))
  check('摘要：无子任务时为 0', s2.subtasks === 0)
}

// ---------- 汇总 ----------
const failed = checks.filter((c) => !c.pass)
console.log(`\n=== verify-ai-schedule-tools ===`)
console.log(`源文件: ${TOOLS_SRC}`)
console.log(`        ${REPO_SRC}`)
console.log(`断言: ${checks.length - failed.length} PASS / ${failed.length} FAIL（共 ${checks.length}）\n`)
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  → ' + c.detail : ''}`)
}
if (failed.length) {
  console.log(`\nFAILED: ${failed.map((c) => c.name).join(' | ')}`)
  process.exit(1)
}
console.log('\n全部通过')
