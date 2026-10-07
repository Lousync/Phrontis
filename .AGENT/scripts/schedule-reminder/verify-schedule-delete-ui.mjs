/**
 * 日程删除入口 · 静态契约验证（2026-09-13 新增，对应更新计划第 4 项）
 *
 * 背景：删除入口原先只存在于**日视图**列表项（TodoItem.tsx），周视图全链路无删除 ——
 * `TaskTray` 卡片只能拖/点开编辑、网格卡片只能拖、编辑弹窗只能删子任务，
 * 于是建错或过期的任务只要在周视图看到就删不掉，必须切到日视图找到那一天。
 *
 * 本脚本守住这次补齐的三处入口不退化，重点守**两条易犯且表象迷惑的错**：
 *   ① 删除钮漏 `stopPropagation` → 点删除会「顺手」弹出编辑弹窗 / 误起拖拽。
 *      根源是 pointer 手势结束后浏览器会补发 click（AGENTS.md#9），
 *      以及卡片 onPointerDown 会注册起拖监听；
 *   ② 退场动效时长与 `.kb-item-out` 的 CSS 过渡时长脱钩 → 动画播到一半卡片被移除，
 *      表现为「删除时闪一下」。故本脚本把 EXIT_MS 与 CSS 的 calc 结果做数值对账。
 *
 * 跑法：node .AGENT/scripts/schedule-reminder/verify-schedule-delete-ui.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败（CI/手动门禁可据此拦截）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

const tray = read('src/modules/schedule/components/TaskTray.tsx')
const grid = read('src/modules/schedule/views/TimetableView.tsx')
const modal = read('src/modules/schedule/components/TodoEditModal.tsx')
const host = read('src/modules/schedule/index.tsx')
const css = read('src/styles/index.css')

let pass = 0
const failures = []
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { failures.push(`${label}${detail ? ` —— ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`) }
}

/** 按大括号配平切出从 `from` 起的一段（用于隔离「某一个按钮」的 JSX，避免跨按钮误匹配） */
function sliceBalanced(text, from, { overlap = 160 } = {}) {
  const head = text.slice(from, from + overlap)
  const at = head.indexOf('>')
  const bodyStart = at >= 0 ? from + at : from
  const open = text.indexOf('<button', from)
  const anchor = open >= 0 && open < bodyStart + 40 ? open : bodyStart
  const start = text.indexOf('>', anchor)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '<') {
      if (/^<\/button/i.test(text.slice(i, i + 9))) { depth--; if (depth <= 0) return text.slice(from, i + 9) }
      else if (/^<button/i.test(text.slice(i, i + 7))) depth++
      else if (/^<\w/i.test(text.slice(i, i + 2)) && !/\/>$/.test(text.slice(i, i + 40).split('\n')[0])) depth++
      else if (text.slice(i, i + 2) === '/>') depth--
    }
  }
  return text.slice(from, text.length)
}

/** 取包含 `anchorText` 的那个 JSX 元素块的起点（往回找最近的 `<button`） */
function buttonBlockOf(text, anchorText) {
  const at = text.indexOf(anchorText)
  if (at < 0) return ''
  const open = text.lastIndexOf('<button', at)
  if (open < 0) return ''
  return sliceBalanced(text, open)
}

console.log('\n日程删除入口 · 静态契约\n')

/* ---------- ① 三处入口都真的存在 ---------- */
console.log('① 删除入口存在性')
const trayBtn = buttonBlockOf(tray, 'handleDelete(todo, e)')
const gridBtn = buttonBlockOf(grid, 'onDelete(todo)')
const modalBtn = buttonBlockOf(modal, 'onDelete()')
check('TaskTray 卡片有删除钮', trayBtn.includes('Trash2'))
check('网格卡片（Block）有删除钮', gridBtn.includes('Trash2'))
check('编辑弹窗有主任务删除钮', modalBtn.includes('Trash2'))

/* ---------- ② 事件阻断（最易退化的一条） ---------- */
console.log('\n② 事件阻断（防误触/误起拖）')
check('TaskTray 删除钮 onClick 内 stopPropagation',
  /onClick=\{e\s*=>\s*handleDelete\(todo,\s*e\)\}/.test(trayBtn) && tray.includes('e.stopPropagation()'),
  '点删除会同时触发卡片的 onClick（打开编辑窗）')
check('TaskTray 删除钮 onPointerDown 阻断起拖',
  /onPointerDown=\{e\s*=>\s*e\.stopPropagation\(\)\}/.test(trayBtn),
  '按下时会冒泡到卡片 handleCardPointerDown，位移后误起拖')
check('网格删除钮 onClick 内 stopPropagation',
  /onClick=\{e\s*=>\s*\{\s*e\.stopPropagation\(\);\s*onDelete\(todo\)\s*\}\}/.test(gridBtn),
  '点删除会触发 Block 的 onClick 打开编辑窗')
check('网格删除钮 onMouseDown 阻断',
  /onMouseDown=\{e\s*=>\s*\{\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\)\s*\}\}/.test(gridBtn))
check('网格删除钮位于 Block 内（受 `.closest(".rz, button")` 起拖白名单覆盖）',
  grid.includes("closest('.rz, button')"),
  'Block 的 onPointerDown 靠 .closest 放行按钮，缺了会拖起来')

/* ---------- ③ 退场动效：类名条件 + 时长对账 ---------- */
console.log('\n③ 退场动效（.kb-item-out）')
check('TaskTray 卡片按 deletingId 挂 kb-item-out',
  /\$\{deletingId === todo\.id \? 'kb-item-out' : ''\}/.test(tray))
check('网格卡片按 deleting 挂 kb-item-out',
  /\$\{deleting \? 'kb-item-out' : ''\}/.test(grid))
check('两处都「先播动画、后落盘」',
  tray.includes('setDeletingId(null)') && tray.includes('onDelete(todo)') &&
  grid.includes('setDeletingId(null)') && grid.includes('onDeleteTodo(t)'))

// 时长对账：.kb-item-out ≈ calc(var(--dur-std) * 0.82)
const durStd = Number((css.match(/--dur-std:\s*(\d+)ms/) || [])[1])
const cssFactor = Number((css.match(/\.kb-item-out\s*\{[\s\S]*?opacity\s+calc\(var\(--dur-std\)\s*\*\s*([\d.]+)\)/) || [])[1])
const expectMs = durStd * cssFactor
const trayExit = Number((tray.match(/const EXIT_MS = (\d+)/) || [])[1])
const gridExit = Number((grid.match(/const EXIT_MS = (\d+)/) || [])[1])
check('CSS 令牌可解析', Number.isFinite(durStd) && Number.isFinite(cssFactor),
  `dur-std=${durStd} factor=${cssFactor}`)
check(`EXIT_MS 与 CSS 过渡时长一致（期望 ≈${expectMs.toFixed(1)}ms）`,
  Math.abs(trayExit - expectMs) <= 1 && Math.abs(gridExit - expectMs) <= 1,
  `TaskTray=${trayExit}ms Grid=${gridExit}ms`)

/* ---------- ④ 接线完整（漏一处 = 按钮不出现，且无任何报错） ---------- */
console.log('\n④ 宿主接线（index.tsx）')
check('TaskTray 收到 onDelete', /<TaskTray[\s\S]*?onDelete=\{todo => \{ void handleDelete\(todo\.id\) \}\}/.test(host))
check('TimetableView 收到 onDeleteTodo', /onDeleteTodo=\{todo => \{ void handleDelete\(todo\.id\) \}\}/.test(host))
check('TodoEditModal 收到 onDelete', /onDelete=\{editTarget \? \(\) => \{ void handleDelete\(editTarget\.id\) \} : undefined\}/.test(host))

/* ---------- ⑤ 口径与门控 ---------- */
console.log('\n⑤ 删除口径与出现条件')
check('删除走 schedule:deleteTodo（级联删子任务、无回收站）',
  host.includes('await deleteScheduleTodo(id)'))
check('删除前统计子任务数并 Toast（级联是静默的）',
  /getScheduleSubtasks\(id\)\)\.length/.test(host) && /已删除（含 \$\{subCount\} 条子任务）/.test(host))
check('TodoEditModal 删除钮仅编辑已有任务时出现（新建不出删除）',
  /\{onDelete && initial\.title && \(/.test(modal))
check('已完成（done）卡片删除钮同样可用（清历史高频）',
  !/done\s*\?\s*null\s*:\s*onDelete/.test(tray) && !/done && onDelete/.test(tray),
  '删除钮不应被 done 状态门控')

console.log(`\n断言: ${pass} PASS / ${failures.length} FAIL`)
if (failures.length) {
  console.log('\n失败明细:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
