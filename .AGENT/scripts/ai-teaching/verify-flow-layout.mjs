/**
 * 契约验证：AI教学「学习流」画布（docs 方案见 .AGENT/.claude/plans/ai-teaching-flow-view-v390.md）。
 *
 * 两类断言：
 *  A. 纯函数真实实现执行 —— 直接 strip-types import `src/modules/ai-teaching/flow/flowLayout.ts`
 *     （零依赖），验证章框包围盒 / 推进链 / 命中 / 自动整理（不复刻逻辑）。
 *  B. 接线静态断言 —— 画布组件存在、CourseHome 挂上它、中栏 chip 已改名（这类漏接是静默的：
 *     组件没被渲染 = 界面「点了没反应」，没有任何报错）。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/ai-teaching/verify-flow-layout.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------- A. 纯函数真实实现
const PURE_REL = 'src/modules/ai-teaching/flow/flowLayout.ts'
const pureSrc = read(PURE_REL)
check('flowLayout 零 import（否则契约脚本装不进来）', !/^\s*import\s/m.test(pureSrc), '')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-verify-'))
const tmpFile = path.join(tmpDir, 'flowLayout.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const F = await import(pathToFileURL(tmpFile).href)
const {
  NODE_W, NODE_H, GRID, ZONE_PAD, ZONE_HEAD, ROW_H, UNIT_GAP_X, UNIT_X0, ROW_Y0, OUTER_PAD,
  zoneRect, sortChapter, chainEdges, edgePath, bounds, zoneAtWorld, arrangePositions, appendSlot, snapValue, clamp, screenToWorld, outerRect,
} = F

console.log('\n=== 1. zoneRect：章框 = 子节点包围盒 ===')
const uA = { id: 'a', x: 40, y: 60 }
const uB = { id: 'b', x: 336, y: 60 }
const r = zoneRect({ units: [uA, uB], index: 0 })
check('宽 = 两卡 + 两侧留白', r.w === (uB.x + NODE_W) - uA.x + ZONE_PAD * 2, String(r.w))
check('高 = 卡高 + 顶部标题条 + 底部留白', r.h === NODE_H + ZONE_HEAD + ZONE_PAD, String(r.h))
check('左上角各留出 ZONE_PAD / ZONE_HEAD', r.x === uA.x - ZONE_PAD && r.y === uA.y - ZONE_HEAD, JSON.stringify({ x: r.x, y: r.y }))

console.log('\n=== 2. zoneRect：折叠 / 空章 / excludeId ===')
const rc = zoneRect({ units: [uA, uB], index: 2, collapsed: true })
check('折叠态：固定占位宽高', rc.w === 320 && rc.h === ZONE_HEAD, JSON.stringify(rc))
check('折叠态：y 按章序号 = ROW_Y0 + index*ROW_H', rc.y === ROW_Y0 + 2 * ROW_H, String(rc.y))
const re = zoneRect({ units: [], index: 0 })
check('空章：等同折叠占位', re.w === 320 && re.h === ZONE_HEAD, JSON.stringify(re))
const r1 = zoneRect({ units: [uA, uB], index: 0 })
const r2 = zoneRect({ units: [uA, uB], index: 0, excludeId: 'b' })
check('excludeId：源章框按剩余节点收缩（不被被拖卡撑大）', r2.w < r1.w && r2.x === uA.x - ZONE_PAD, JSON.stringify({ r1w: r1.w, r2w: r2.w }))
const r3 = zoneRect({ units: [uA], index: 0, excludeId: 'a' })
const r3base = zoneRect({ units: [uA], index: 0 })
check('excludeId 排空 → 保留原章框（不收缩成占位）', r3.w === r3base.w && r3.x === uA.x - ZONE_PAD, JSON.stringify(r3))

console.log('\n=== 3. sortChapter / chainEdges ===')
const scattered = [{ id: 'x', x: 336, y: 60 }, { id: 'y', x: 40, y: 60 }, { id: 'z', x: 188, y: 60 }]
check('sortChapter 按 x 升序', sortChapter(scattered).map((u) => u.id).join('') === 'yzx', sortChapter(scattered).map((u) => u.id).join(''))
check('sortChapter 不改变原数组（返回新数组）', scattered[0].id === 'x', scattered[0].id)
const chapters = [
  { id: 'c1', units: [{ id: 'a', x: 40, y: 60 }, { id: 'b', x: 336, y: 60 }, { id: 'c', x: 632, y: 60 }] },
  { id: 'c2', units: [{ id: 'd', x: 40, y: 310 }, { id: 'e', x: 336, y: 310 }] },
]
const edges = chainEdges(chapters, new Set())
check('chainEdges：章内相邻链条数 = Σ(n-1)', edges.length === (3 - 1) + (2 - 1), String(edges.length))
check('chainEdges：前→后方向正确', edges[0].fromId === 'a' && edges[0].toId === 'b' && edges[1].fromId === 'b' && edges[1].toId === 'c', JSON.stringify(edges[0]))
check('chainEdges：跨章不连线（第 3 条落在 c2 章）', edges[2].chapterId === 'c2' && edges[2].fromId === 'd', JSON.stringify(edges[2]))
check('chainEdges：折叠的章不产生连线', chainEdges(chapters, new Set(['c1'])).every((e) => e.chapterId === 'c2'), '')
check('chainEdges：空章无连线', chainEdges([{ id: 'c0', units: [] }], new Set()).length === 0, '')

console.log('\n=== 4. edgePath / bounds / zoneAtWorld ===')
const p = edgePath(uA, uB)
check('edgePath：以 M 起、C 三次贝塞尔', /^M[-0-9., ]+C/.test(p), p)
check('edgePath：起点在 a 卡右缘中线', p.startsWith(`M${uA.x + NODE_W},${uA.y + NODE_H / 2}`), p)
const bb = bounds(chapters, new Set())
check('bounds：包含所有章框', bb.x <= 40 - ZONE_PAD && bb.w > 0 && bb.h > 0, JSON.stringify(bb))
check('bounds：空输入 → 兜底矩形', JSON.stringify(bounds([], new Set())) === JSON.stringify({ x: 0, y: 0, w: 800, h: 600 }), '')
check('zoneAtWorld：命中卡所在章', zoneAtWorld(chapters, new Set(), 100, 90) === 'c1', String(zoneAtWorld(chapters, new Set(), 100, 90)))
check('zoneAtWorld：第二行的点命中 c2', zoneAtWorld(chapters, new Set(), 100, 340) === 'c2', String(zoneAtWorld(chapters, new Set(), 100, 340)))
check('zoneAtWorld：空白处返回 null', zoneAtWorld(chapters, new Set(), 5000, 5000) === null, '')

console.log('\n=== 5. arrangePositions / appendSlot / 工具 ===')
const ap = arrangePositions(chapters)
check('arrange：章内 x 依次为 40 / 336 / 632', ap.a.x === UNIT_X0 && ap.b.x === UNIT_X0 + UNIT_GAP_X && ap.c.x === UNIT_X0 + 2 * UNIT_GAP_X, JSON.stringify([ap.a, ap.b, ap.c]))
check('arrange：第 2 章整体下移 ROW_H', ap.d.y === ROW_Y0 + ROW_H && ap.e.y === ROW_Y0 + ROW_H, String(ap.d.y))
const slot = appendSlot(1, 3)
check('appendSlot：追加到目标章末尾（第 4 个位置）', slot.x === UNIT_X0 + 3 * UNIT_GAP_X && slot.y === ROW_Y0 + ROW_H, JSON.stringify(slot))
check('snapValue：对齐到 GRID 整数倍', snapValue(31) === 40 && snapValue(29) === 20 && snapValue(30) === 40, `${snapValue(31)},${snapValue(29)}`)
check('clamp 边界', clamp(5, 0, 10) === 5 && clamp(-1, 0, 10) === 0 && clamp(99, 0, 10) === 10, '')
const sw = screenToWorld(200, 150, 50, 50, { x: 0, y: 0, k: 2 })
check('screenToWorld：反推世界坐标', sw.x === (200 - 50) / 2 && sw.y === (150 - 50) / 2, JSON.stringify(sw))

console.log('\n=== 6. outerRect：最外层「全局 / 工作区」框 ===')
const or = outerRect(chapters, new Set())
check('外框 = 全部章框包围盒 + OUTER_PAD', or.x === bb.x - OUTER_PAD && or.w === bb.w + OUTER_PAD * 2, JSON.stringify({ or, bb }))
check('外框顶部额外留出标题条高度', or.y === bb.y - ZONE_HEAD - OUTER_PAD && or.h === bb.h + ZONE_HEAD + OUTER_PAD * 2, JSON.stringify(or))
check('外框完整包住所有章框', or.x <= 40 - ZONE_PAD && or.y < ROW_Y0 && or.x + or.w >= 632 + NODE_W + ZONE_PAD, JSON.stringify(or))
const orEmpty = outerRect([], new Set())
check('无章时外框按 bounds 兜底矩形（不崩）', orEmpty.w === 800 + OUTER_PAD * 2 && orEmpty.h === 600 + ZONE_HEAD + OUTER_PAD * 2, JSON.stringify(orEmpty))
const collapsedAll = outerRect(chapters, new Set(['c1', 'c2']))
check('有折叠章时外框随之收缩', collapsedAll.w < or.w, JSON.stringify({ collapsedW: collapsedAll.w, openW: or.w }))

// ---------------------------------------------------------------- B. 接线静态断言
console.log('\n=== 7. 组件与接线 ===')
const canvasPath = 'src/modules/ai-teaching/flow/FlowCanvas.tsx'
check('FlowCanvas 组件存在', fs.existsSync(path.join(ROOT, canvasPath)), '')
const canvas = stripComments(read(canvasPath))
check('画布用 Pointer Events（HTML5 拖放会静默失败）', canvas.includes('onPointerDown') || canvas.includes("addEventListener('pointerdown'"), '')
check('画布拖拽期间禁用文本选取', canvas.includes("classList.add('dragging')") || canvas.includes('dragging') || canvas.includes('userSelect'), '')
check('画布 import 了 flowLayout', /from '\.\/flowLayout'/.test(read(canvasPath)), '')
const course = stripComments(read('src/modules/ai-teaching/CourseMode.tsx'))
check('CourseMode 导入并渲染 FlowCanvas', course.includes("from './flow/FlowCanvas'") && course.includes('<FlowCanvas'), '')
check('CourseHome 保留既有 props（onStartUnit/onOpenChapterReview/onFinishUnit）', course.includes('onStartUnit') && course.includes('onOpenChapterReview') && course.includes('onFinishUnit'), '')
const mod = stripComments(read('src/modules/ai-teaching/index.tsx'))
check('中栏 chip 改名「学习流」', mod.includes('学习流'), '')
// P1 拖拽（2026-10-16）：卡片拖拽 + 网格吸附 + 跨章落点 + 主进程 moveUnit 写盘
check('画布节点拖拽（onNodeDown + 窗口级 pointermove）', canvas.includes('onNodeDown') && canvas.includes("addEventListener('pointermove'"), '')
check('拖拽默认按网格吸附（Alt 临时自由）', canvas.includes('snapValue(') && canvas.includes('ev.altKey'), '')
check('跨章落点高亮', canvas.includes('dropZoneId') && canvas.includes('kb-drop'), '')
check('落点未变则不调 moveUnit', canvas.includes('drop?.changed'), '')
check('pointer 松手补发 click 的 dragGuard', /guardRef\.current\s*=\s*Date\.now\(\)\s*\+\s*250/.test(canvas) && canvas.includes('Date.now() < guardRef.current'), '')
check('FlowCanvas 声明 onMoveUnit prop 并调用', canvas.includes('onMoveUnit') && canvas.includes('onMoveUnit(unitId'), '')
check('CourseMode 接线 onMoveUnit → aiTeachCourseMoveUnit', course.includes('onMoveUnit') && course.includes('aiTeachCourseMoveUnit('), '')
check('CSS 有拖拽/落点样式', read('src/styles/index.css').includes('.kb-flow-node.kb-dragging') && read('src/styles/index.css').includes('.kb-flow-zone.kb-drop'), '')
// 节点是章框 div 的子元素 → 必须按章框**相对**坐标渲染，否则叠加两次 zr 偏移（卡片盖住章框底注、连线错位）
check('节点按章框相对坐标渲染（防双重偏移）', canvas.includes('nx - zr.x') && canvas.includes('ny - zr.y'), '')

// L0 作用域分层（2026-10-16，方案 ai-teaching-scope-layers-v390.md）：三层框 + 选层
check('画布渲染最外层框（outerRect + data-outer）', canvas.includes('outerRect(') && canvas.includes('data-outer'), '')
check('画布选层口径 = selScope / onSelectScope（不再是 selectedId）', canvas.includes('selScope') && canvas.includes('onSelectScope') && !canvas.includes('selectedId'), '')
check('框选中态样式类 kb-on 同时用于外层框与章框', read('src/styles/index.css').includes('.kb-flow-outer') && read('src/styles/index.css').includes('.kb-flow-zone.kb-on'), '')
check('卡片点击 stopPropagation（不冒泡到章框覆盖选中）', /onClick=\{\(e\) => \{ e\.stopPropagation\(\); if \(Date\.now\(\) < guardRef\.current\) return; selectScope/.test(canvas), '')
check('章框 header 按钮 stopPropagation（复习课 / 折叠不误选章）', (canvas.match(/e\.stopPropagation\(\); (toggleCollapse|onOpenChapterReview)/g) || []).length === 2, '')
check('CourseMode 持有 selScope 并上报 onSelectScope', course.includes('selScope') && course.includes('onSelectScope'), '')
check('index.tsx 接线「编辑这一层」onOpenScopeDoc', mod.includes('onOpenScopeDoc') && mod.includes('openScopeDoc'))

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
