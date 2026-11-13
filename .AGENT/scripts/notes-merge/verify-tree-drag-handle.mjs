/**
 * 契约：共享文件树的拖拽 = 行首图标 pointer 自实现（v3.16.1 F-4 收窄定位 + B-49 换实现）。
 *
 * 历史：
 *   v3.16.1 F-4  —— 拖拽源从整行收窄到行首图标（HTML5 draggable），修「手一抖就移动文件」；
 *   v3.19.1 B-49 —— 用户实机（Windows）按住图标拖动毫无反应（HTML5 拖拽手势启动静默失败），
 *                  CDP 合成鼠标也无法启动原生拖拽会话（行级 draggable 对照不触发），手势层
 *                  无法本地复现 → 按铁律 9 的既定结论（日程看板同款）改 pointer 自实现：
 *                  图标 pointerdown 捕获 → 位移 >6px 进入拖拽 → elementFromPoint 找落点目录
 *                  → pointerup 落盘 onMove；落点后 250ms 时间窗拦掉补发 click。
 *
 * 本脚本锁：树内无任何 HTML5 拖拽残留、两枚图标把手带 pointer 手势与视觉反馈、
 * 手势关键结构（捕获 / 阈值 / 落点解析 / click 守卫）齐全、三处宿主仍共用同一棵树。
 * 运行期端到端断言在 probe-tree-drag.mjs（CDP 真鼠标）。
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

console.log('=== A. HTML5 拖拽零残留（B-49：手势启动层静默失败，整条弃用） ===')
ok(!/\bdraggable\b/.test(tree), 'A1 树内没有 draggable 属性（文件行/目录行/图标都不可 HTML5 拖）')
ok(!/onDragStart=/.test(tree), 'A2 没有 onDragStart')
ok(!/onDragOver=/.test(tree) && !/onDrop=/.test(tree), 'A3 目录行 / 根容器没有 onDragOver / onDrop')
ok(!/DRAG_MIME/.test(tree), 'A4 自定义 MIME 常量已删')
ok(!/setDragImage/.test(tree), 'A5 没有 setDragImage')
ok(!/DataTransfer|DragEvent/.test(tree), 'A6 不再构造拖拽事件对象')

console.log('\n=== B. 行首图标 = pointer 拖拽把手（文件 + 文件夹两枚） ===')
ok((tree.match(/onPointerDown=\{\(e\) => handlePointerDown\(e, relPath\)\}/g) ?? []).length === 1,
  'B1 目录图标把手接 handlePointerDown')
ok((tree.match(/onPointerDown=\{\(e[vv]?\) => handlePointerDown\(e[vv]?, e\.relPath\)\}/g) ?? []).length === 1,
  'B2 文件图标把手接 handlePointerDown')
ok((tree.match(/onPointerMove=\{handlePointerMove\}/g) ?? []).length === 2, 'B3 两枚把手都接 move')
ok((tree.match(/onPointerUp=\{handlePointerUp\}/g) ?? []).length === 2, 'B4 两枚把手都接 up')
ok((tree.match(/touch-none/g) ?? []).length === 2, 'B5 把手带 touch-none（指针手势不被浏览器接管）')
ok((tree.match(/cursor-grab/g) ?? []).length === 2, 'B6 把手 cursor-grab')
ok((tree.match(/data-tip="拖动移动"/g) ?? []).length === 2, 'B7 把手有「拖动移动」提示')
ok(/onClick=\{\(e[vv]?\) => \{ if \(Date\.now\(\) - dragEndAtRef\.current < 250\) e[vv]?\.stopPropagation\(\) \}\}/.test(tree),
  'B8 把手 click 守卫：拖拽后 250ms 内拦掉补发 click')

console.log('\n=== C. 手势结构（阈值 / 捕获 / 落点 / 落盘） ===')
ok(/setPointerCapture\(e\.pointerId\)/.test(tree), 'C1 pointerdown 捕获指针（出把手范围仍收 move/up）')
ok(/Math\.hypot\(e\.clientX - d\.startX, e\.clientY - d\.startY\) < 6/.test(tree), 'C2 位移阈值 6px（F-4 防误拖保持）')
ok(/document\.elementFromPoint\(x, y\)/.test(tree), 'C3 落点用 elementFromPoint')
ok(/data-wb-tree-dir'\) === '1' \? path : parentDirOf\(path\)/.test(tree), 'C4 目录行 → 目录；文件行 → 其父目录')
ok(/if \(root && !root\.contains\(el\)\) return null/.test(tree), 'C5 树外 = null（取消，不落盘）')
ok(/return ''/.test(tree), "C6 树内空白 = 根（''，对齐旧版 drop-to-root）")
ok(/dirRel !== null && dirRel !== d\.relPath && dirRel !== parentDirOf\(d\.relPath\)/.test(tree),
  'C7 落盘守卫：树外 / 自身 / 原目录不触发 onMove')
ok(/onPointerCancel=\{pointerDragEnd\}/.test(tree) && (tree.match(/onPointerCancel=\{pointerDragEnd\}/g) ?? []).length === 2,
  'C8 两枚把手都接 cancel（清理拖拽态）')

console.log('\n=== D. 拖拽态视觉反馈（F-4 视觉语言保持） ===')
ok(/const \[dragPath, setDragPath\] = useState<string \| null>\(null\)/.test(tree), 'D1 dragPath 状态')
ok(/dragPath === e\.relPath \? ' opacity-40' : ''/.test(tree), 'D2 文件源行拖动中降透明度')
ok(/dragPath === relPath \? ' opacity-40' : ''/.test(tree), 'D3 目录源行拖动中降透明度')
ok(/dragOver === relPath \? 'bg-\[var\(--accent\)\]\/15 ring-1 ring-inset ring-\[var\(--accent\)\]\/40' : ''/.test(tree),
  'D4 落点目录行高亮')
ok(/dragOver === '' \? 'bg-\[var\(--accent\)\]\/10' : ''/.test(tree), 'D5 根容器空白落点高亮')

console.log('\n=== E. 三处宿主仍共用同一个树（改一处全修）===')
ok(/<VaultTree/.test(teach) && /<VaultTree/.test(workbench) && /<VaultTree/.test(knowledge),
  'E1 AI 教学 / 工作台 / 笔记区都渲染 VaultTree')
ok(!/draggable/.test(teach) && !/draggable/.test(workbench), 'E2 宿主没有自行补拖拽源')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
