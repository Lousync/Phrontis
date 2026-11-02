/**
 * 契约：共享文件树的拖拽源必须收窄到行首图标（v3.16.1 F-4）。
 *
 * 失败模式：整行 `draggable` + 整行 `onClick` 共用一个手势起点，浏览器约 4–5px 就进入拖拽，
 * 用户「点一下文件夹」手稍抖就变成移动文件，且没有任何确认。修法是把 `draggable` 从行
 * 收窄到图标把手，行恢复纯点击；三处宿主（AI 教学 / 工作台 / 笔记区）共用 VaultTree，一处改全修。
 *
 * 本脚本锁：行不再可拖、把手仍可拖且带 `.kb-draggable`、拖拽态有视觉反馈。
 *
 * 跑法：node .AGENT/scripts/notes-merge/verify-tree-drag-handle.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => stripComments(readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n'))

const tree = read('src/components/shared/VaultTree.tsx')
const teach = read('src/modules/ai-teaching/AiTeachFileTree.tsx')
const workbench = read('src/components/workbench/WorkbenchFileTree.tsx')
const knowledge = read('src/modules/knowledge/index.tsx')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. 行不再作为拖拽源 ===')
ok(!/data-wb-tree-file="1"[\s\S]{0,120}?\bdraggable\b/.test(tree), 'A1 文件行没有 draggable')
ok(!/data-wb-tree-dir="1"[\s\S]{0,120}?\bdraggable\b/.test(tree), 'A2 目录行没有 draggable')
ok(!/onDragStart=\{\(ev\) => startDrag\(ev, e\.relPath\)\}/.test(tree), 'A3 文件行的 onDragStart 已移除')
ok(!/onDragStart=\{\(e\) => startDrag\(e, relPath\)\}/.test(tree), 'A4 目录行的 onDragStart 已移除')

console.log('\n=== B. 行首图标是唯一拖拽把手 ===')
ok((tree.match(/^\s*draggable$/gm) ?? []).length === 2, 'B1 全文件只剩 2 个 draggable 属性（文件图标 + 文件夹图标）')
ok((tree.match(/onDragStart=/g) ?? []).length === 2, 'B2 只剩 2 个 onDragStart（与把手一一对应）')
ok((tree.match(/className="kb-draggable inline-flex shrink-0 cursor-grab"/g) ?? []).length === 2,
  'B3 两个把手都带 .kb-draggable + cursor-grab（铁律 9：body 的 user-drag:none 会继承）')
ok(/title="拖动移动"/.test(tree), 'B4 把手有「拖动移动」提示（可发现性）')
ok(/setDragImage\(row, 12, 14\)/.test(tree), 'B5 拖拽影像用整行而不是 15px 图标（可见性）')

console.log('\n=== C. 拖拽态反馈 ===')
ok(/const \[dragPath, setDragPath\] = useState<string \| null>\(null\)/.test(tree), 'C1 dragPath 状态')
ok(/dragPath === e\.relPath \? ' opacity-40' : ''/.test(tree), 'C2 文件源行拖动中降透明度')
ok(/dragPath === relPath \? ' opacity-40' : ''/.test(tree), 'C3 目录源行拖动中降透明度')
ok(/onDragEnd=\{endDrag\}/.test(tree), 'C4 dragend 清理拖拽态')

console.log('\n=== D. 三处宿主仍共用同一个树（改一处全修）===')
ok(/<VaultTree/.test(teach) && /<VaultTree/.test(workbench) && /<VaultTree/.test(knowledge),
  'D1 AI 教学 / 工作台 / 笔记区都渲染 VaultTree')
ok(!/draggable/.test(teach) && !/draggable/.test(workbench), 'D2 宿主没有再给整行补 draggable')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
