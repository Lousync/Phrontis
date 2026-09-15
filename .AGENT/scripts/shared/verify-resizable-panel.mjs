/**
 * 契约验证：分栏拖拽手柄（`shared/ResizablePanel` + `shared/AssistantPanel` 拖拽条）。
 *
 * 为什么需要它：
 *   v3.2.0 条目 ⑤ 修的是「误触发 / 拖拽丢事件 / 状态卡死」三件事，而这三件事的**修法本身**
 *   又引入了一类不报错的回归风险，静态看代码看不出来：
 *     ① **dead-zone 的位置**：阈值判断必须发生在 `setDragging(true)` **之前**。写在之后
 *        （先置拖拽态、再判阈值）表象与没修一样 —— 误触仍会写盘、仍会闪 cursor。
 *     ② **落盘闸门**：`endDrag` 里的 `persist && d.moved && !d.snapped` 三重条件缺任何一项，
 *        要么误触落盘、要么 snap 关闭时反而把宽度写成半程值。
 *     ③ **收尾路径数**：`pointerup` / `pointercancel` / `lostpointercapture` / 卸载，四条都不能少；
 *        少一条的后果是「`body` 的 user-select / cursor 永久污染全窗口，只能重启」（就是现象③）。
 *     ④ **折叠态边条的双路监听**：边条只有 4~14px 宽，指针一离开就收不到元素级事件；而 capture
 *        期间事件仍会冒泡到 window。**两条路必须同时挂着**（这里真的踩过一次：写了「只挂一边」
 *        的注释，结果两边都没挂 → 拖出展开彻底失效且光标不复位）。
 *     ⑤ **`onSnapCloseRef` 的 ref 转发**：这是 2026-09-09 修过的老坑（内联回调导致监听器反复
 *        重绑 + cursor 闪烁），本次改动明令「不要破坏那次修复」，故设为回归红线。
 *     ⑥ **第四 / 第五套手柄（AI 教学的工件栏分隔条 + 素材库右缘拉出条）**：这两条直接贴着工件栏，
 *        是「HTML 必炸、md 正常」最容易被漏掉的一对 —— 2026-09-15 首轮只改了 ResizablePanel，
 *        开发负责人实机复测后指出「html 的拖拽手柄还是有问题」，才把这两条一并补上 capture。
 *
 * 做法（与 verify-fs-watcher.mjs 同范式）：从 ResizablePanel.tsx 里**切出真实的 `endDrag` /
 *   `applyDrag` 两个箭头函数体**（大括号计数切片 + stripTypeScriptTypes 剥类型 → 临时 .mjs import），
 *   只 stub 副作用依赖（setDragging / setWidth / setSettingRaw / document.body.style / refs）。
 *   验的是真实行为，不是复刻的判定逻辑。其余协议面（四条收尾路径、双路监听、调用方接线）走静态断言。
 *
 * 运行（项目根目录）：
 *   node --no-warnings .AGENT/scripts/shared/verify-resizable-panel.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const REL_PANEL = 'src/components/shared/ResizablePanel.tsx'
const REL_ASSISTANT = 'src/components/shared/AssistantPanel/index.tsx'
const REL_AI_TEACH = 'src/modules/ai-teaching/index.tsx'

const readIfExists = (rel) => {
  const p = path.join(ROOT, rel)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

const src = readIfExists(REL_PANEL)
const assistant = readIfExists(REL_ASSISTANT)
const aiTeach = readIfExists(REL_AI_TEACH)

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

// ------------------------------------------------------------------ 切片工具
/** 从 `anchor` 之后第一个 `=> {` 的 `{` 起做括号计数，返回函数体（不含外层大括号）。 */
const sliceArrowBody = (text, anchor) => {
  const at = text.indexOf(anchor)
  if (at < 0) throw new Error(`找不到锚点：${anchor}`)
  const arrow = text.indexOf('=> {', at)
  if (arrow < 0) throw new Error(`锚点后找不到箭头函数体：${anchor}`)
  const start = text.indexOf('{', arrow + 3)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(start + 1, i)
    }
  }
  throw new Error(`括号不闭合：${anchor}`)
}

const numOf = (re, name) => {
  const m = src.match(re)
  if (!m) throw new Error(`源码里找不到常量：${name}`)
  return Number(m[1])
}
const DEAD_ZONE = numOf(/const DRAG_DEAD_ZONE_PX = (\d+)/, 'DRAG_DEAD_ZONE_PX')
const HIT_WIDTH = numOf(/const HANDLE_HIT_WIDTH_PX = (\d+)/, 'HANDLE_HIT_WIDTH_PX')

// ------------------------------------------------------------------ 静态：协议与接线
check('dead-zone 常量存在且为 4px（与工件栏分隔条同阈值）', DEAD_ZONE === 4, `实际 ${DEAD_ZONE}`)
check('手柄命中热区 5px（原为 2px 的 w-0.5）', HIT_WIDTH === 5, `实际 ${HIT_WIDTH}`)

// ① 主手柄：四条收尾路径 + capture + 双击复位 + 遮罩
const handleBlock = (() => {
  const at = src.indexOf('{visible && showHandle && (')
  return at < 0 ? '' : src.slice(at, at + 1600)
})()
check('主手柄用 pointerdown 而非 mousedown', /onPointerDown=\{onHandlePointerDown\}/.test(handleBlock))
check('主手柄声明 setPointerCapture（根治 iframe 跨文档丢事件）',
  /setPointerCapture\(e\.pointerId\)/.test(src))
check('主手柄 pointerup 走 endDrag', /onPointerUp=\{\(\) => endDrag\(\)\}/.test(handleBlock))
check('主手柄 pointercancel 走 endDrag', /onPointerCancel=\{\(\) => endDrag\(\)\}/.test(handleBlock))
check('主手柄 lostpointercapture 走 endDrag（capture 被系统收走也得收尾）',
  /onLostPointerCapture=\{\(\) => endDrag\(\)\}/.test(handleBlock))
check('主手柄有 pointermove', /onPointerMove=\{\(e\) => applyDrag\(e\.clientX\)\}/.test(handleBlock))
check('主手柄支持双击复位', /onDoubleClick=\{onHandleDoubleClick\}/.test(handleBlock))
check('命中热区与视觉线分离（视觉线单独一层，不再线＝热区）',
  /width: HANDLE_HIT_WIDTH_PX/.test(handleBlock) && /inset-y-0 w-px/.test(handleBlock))
check('拖拽期有覆盖层（第二层保险，防止指针进入工件 iframe）',
  /\{dragging && <div className="fixed inset-0 z-\[60\] cursor-col-resize" \/>\}/.test(src))

// ② 卸载兜底：必须清 body 污染（且不依赖 endDrag 的 setState）
const unmountEffect = (() => {
  const at = src.indexOf('// 卸载兜底：拖拽中组件被卸载')
  return at < 0 ? '' : src.slice(at, at + 700)
})()
check('组件卸载时清 body 污染（第四条收尾路径）',
  /dragRef\.current = null/.test(unmountEffect) &&
  /document\.body\.style\.userSelect = ''/.test(unmountEffect) &&
  /document\.body\.style\.cursor = ''/.test(unmountEffect))

// ③ 回归红线：onSnapCloseRef 的 ref 转发不许被删（2026-09-09 修过的 cursor 闪烁）
check('【红线】onSnapCloseRef ref 转发保留（勿破坏 2026-09-09 的修复）',
  /const onSnapCloseRef = useRef\(onSnapClose\)/.test(src) &&
  /onSnapCloseRef\.current = onSnapClose/.test(src))
check('死配置已清：右栏不再同传 onSnapOpen 与 collapsedWidth={0}',
  !/visible=\{srcVisible\}[\s\S]{0,120}onSnapOpen/.test(aiTeach) &&
  !/aiTeach\.rightWidth[\s\S]{0,120}collapsedWidth=\{0\}/.test(aiTeach))
check('右栏折叠展开仍可用（保底入口：侧边拉出条 + 顶栏按钮）',
  /data-edge-strip="right"/.test(aiTeach) || /toggleSide\('right'\)/.test(aiTeach))

// ④ 折叠态边条：元素级 + window 两条路都要有（踩过的坑）
const edgeBlock = (() => {
  const at = src.indexOf('折叠态「拖出展开」')
  return at < 0 ? '' : src.slice(at, at + 4200)
})()
check('边条：元素级 pointermove/up/cancel/lostcapture 齐备',
  /onPointerMove=\{\(e\) => applyEdgeDrag\(e\.clientX\)\}/.test(src) &&
  /onPointerUp=\{endEdgeDrag\}/.test(src) &&
  /onPointerCancel=\{endEdgeDrag\}/.test(src) &&
  /onLostPointerCapture=\{endEdgeDrag\}/.test(src))
check('边条：window 侧监听同时挂着（边条太窄，指针一离开就收不到元素事件）',
  /window\.addEventListener\('pointermove', onMove\)/.test(edgeBlock) &&
  /window\.addEventListener\('pointerup', endEdgeDrag\)/.test(edgeBlock) &&
  /window\.addEventListener\('pointercancel', endEdgeDrag\)/.test(edgeBlock))
check('边条：展开瞬间卸载也要清 body 光标（effect cleanup 里补一刀）',
  /展开瞬间边条会卸载/.test(edgeBlock) && /document\.body\.style\.cursor = ''/.test(edgeBlock))
check('边条：onSnapOpenRef ref 转发（避免内联回调进依赖数组）',
  /const onSnapOpenRef = useRef\(onSnapOpen\)/.test(src) &&
  /onSnapOpenRef\.current = onSnapOpen/.test(src))

// ⑤ 第三套：AssistantPanel 侧栏拖拽条
check('侧栏拖拽条改用 pointerdown（原 onMouseDown）', /onPointerDown=\{e => \{/.test(assistant))
check('侧栏拖拽条声明 setPointerCapture', /el\.setPointerCapture\(e\.pointerId\)/.test(assistant))
check('侧栏拖拽条 pointercancel 收尾（不只认 pointerup）',
  /window\.addEventListener\('pointercancel', finish\)/.test(assistant))
check('侧栏拖拽条有 4px dead-zone 与 moved 闸门',
  /Math\.abs\(ev\.clientX - startX\) < 4/.test(assistant) && /if \(!moved\) return/.test(assistant))

// ⑥ 第四 / 第五套：AI 教学里的工件栏分隔条与素材库右缘拉出条
//    这两条直接贴着工件栏，而工件栏正文是 `.html` 时走 `kbview://` iframe → 是本条最容易被
//    漏掉的一对。判据：右侧 `.md` 走父文档 DOM、从不犯病；`.html` 一拖就断流。
check('工件栏分隔条用 pointerdown（原 onMouseDown）', /onPointerDown=\{onDividerDown\}/.test(aiTeach))
check('工件栏分隔条声明 setPointerCapture', /e\.currentTarget\.setPointerCapture\(e\.pointerId\)/.test(aiTeach))
check('工件栏分隔条 pointercancel 收尾', /window\.addEventListener\('pointercancel', onUp\)/.test(aiTeach))
check('工件栏分隔条 lostpointercapture 也能收尾（capture 被系统收走时不卡 cursor）',
  /onLostPointerCapture=\{\(\) => dividerEndRef\.current\?\.\(\)\}/.test(aiTeach))
check('工件栏分隔条保留 4px dead-zone（2026-09-09 的修复不许被删）',
  /Math\.abs\(ev\.clientX - startX\) < 4/.test(aiTeach))
check('素材库右缘拉出条用 pointerdown + capture（原 onMouseDown/mousemove）',
  /strip\.setPointerCapture\(e\.pointerId\)/.test(aiTeach) &&
  /window\.addEventListener\('pointercancel', onUp\)/.test(aiTeach))
check('素材库右缘拉出条保留「拖拽展开后抑制 click」逻辑',
  /suppress/.test(aiTeach) && /strip\.addEventListener\('click', suppress, true\)/.test(aiTeach))
check('工件栏 / 拉出条拖拽期挂物理遮罩（不依赖 capture 跨文档语义）',
  /\{artDragMask && <div className="fixed inset-0 z-\[60\] cursor-col-resize" \/>\}/.test(aiTeach))
check('遮罩由收尾路径摘除（不得只认 pointerup）',
  (aiTeach.match(/setArtDragMask\(false\)/g) || []).length >= 2 &&
  /setArtDragMask\(false\)/.test(aiTeach))
check('遮罩等真动了才挂（单击展开不闪遮罩）',
  /let maskOn = false/.test(aiTeach) && /Math\.abs\(ev\.clientX - startX\) >= 4/.test(aiTeach))
check('【全局红线】AI 教学里已无鼠标事件拖拽手柄（不得回退成 mousemove/mouseup）',
  !/addEventListener\('mouse(move|up)'/.test(aiTeach) && !/onMouseDown=\{/.test(aiTeach))
check('【全局红线】迁移后的指针手柄都带 button 守卫（右键/中键不触发拖拽）',
  /if \(e\.button !== 0\) return/.test(src) &&
  /if \(e\.button !== 0\) return/.test(aiTeach) &&
  /if \(e\.button !== 0\) return/.test(assistant))

// ------------------------------------------------------------------ 运行：切片真实 endDrag / applyDrag
const bodyEnd = sliceArrowBody(src, 'const endDrag = useCallback(')
const bodyApply = sliceArrowBody(src, 'const applyDrag = useCallback(')

const harness = stripTypeScriptTypes(
  `
const document = { body: { style: {} } }
let events = []
let persisted = []
let endDragCount = 0
const setDragging = (v) => { events.push(['dragging', v]) }
const setFallbackDrag = (v) => { events.push(['fallbackDrag', v]) }
const setWidth = (v) => { widthRef.current = v; events.push(['width', v]) }
const setSettingRaw = (k, v) => { persisted.push([k, v]) }
const storageKey = 'test.width'
const dragRef = { current: null }
let widthRef = { current: 0 }
let minWidth = 200
let maxWidth = 400
let side = 'left'
const onSnapCloseRef = { current: null }
const DRAG_DEAD_ZONE_PX = ${DEAD_ZONE}
function endDrag(persist = true) { endDragCount++; ${bodyEnd} }
function applyDrag(clientX) { ${bodyApply} }
export const api = {
  applyDrag, endDrag,
  get ended() { return endDragCount },
  reset() { events = []; persisted = [] },
  events: () => events,
  persisted: () => persisted,
  bodyStyle: () => document.body.style,
  dragRef, widthRef,
  setup({ startX = 100, startW = 240, min = 200, max = 400, s = 'left', snap = null } = {}) {
    dragRef.current = { startX, startW, moved: false, snapped: false }
    widthRef.current = startW
    minWidth = min; maxWidth = max; side = s
    onSnapCloseRef.current = snap
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    events = []; persisted = []
  },
}
`,
  { mode: 'transform' }
)

const tmpDir = path.join(ROOT, 'tmp', 'verify-resizable-panel')
fs.mkdirSync(tmpDir, { recursive: true })
const tmpFile = path.join(tmpDir, `hp-${Date.now().toString(36)}.mjs`)
fs.writeFileSync(tmpFile, harness, 'utf8')
const { api } = await import(pathToFileURL(tmpFile).href)

const widthEvents = () => api.events().filter(e => e[0] === 'width').map(e => e[1])
const draggingEvents = () => api.events().filter(e => e[0] === 'dragging').map(e => e[1])

// ① 误触：位移 < dead-zone → 不进入拖拽、不改宽度、不落盘
api.setup({ startX: 100, startW: 240 })
api.applyDrag(101)                                   // 累计 1px
api.applyDrag(103)                                   // 累计 3px
check(`位移 < ${DEAD_ZONE}px 不进入拖拽态`, draggingEvents().length === 0)
check(`位移 < ${DEAD_ZONE}px 不改宽度`, widthEvents().length === 0)
api.endDrag()
check('误触松手不落盘', api.persisted().length === 0, JSON.stringify(api.persisted()))

// ② 越过 dead-zone 的那一帧开始真拖（阈值判断必须发生在 setDragging 之前）
api.setup({ startX: 100, startW: 240 })
api.applyDrag(103)
check('越过阈值前仍未置拖拽态（阈值判断在 setDragging 之前）', draggingEvents().length === 0)
api.applyDrag(104)                                   // 4px
check(`位移 = ${DEAD_ZONE}px 进入拖拽态（边界取「不小于」）`, draggingEvents()[0] === true)
check(`位移 = ${DEAD_ZONE}px 宽度 +${DEAD_ZONE}`, widthEvents()[0] === 240 + DEAD_ZONE)
api.applyDrag(120)                                   // 20px
check('继续拖动跟手（宽度 = 起始 + 位移）', widthEvents().at(-1) === 260)
api.endDrag()
check('真拖后松手落盘一次且值为最终宽度',
  api.persisted().length === 1 && api.persisted()[0][1] === 260, JSON.stringify(api.persisted()))

// ③ right 侧镜像：向左拖 = 变宽
api.setup({ startX: 500, startW: 240, s: 'right' })
api.applyDrag(480)                                   // 向左 20px
check('right 侧向左拖 = 变宽（方向镜像）', widthEvents().at(-1) === 260)

// ④ 夹取
api.setup({ startX: 100, startW: 390 })
api.applyDrag(600)                                   // +500 → 超 max 400
check('超上限夹到 maxWidth', widthEvents().at(-1) === 400)
api.setup({ startX: 300, startW: 210 })
api.applyDrag(240)                                   // -60 → 150：低于 min 但未过半程
check('低于 minWidth 但未过半程 → 夹到 minWidth 而非 snap', widthEvents().at(-1) === 200)

// ⑤ snap 关闭：过半程 → 回调一次、**不落盘**、拖拽态收束
let snapCalls = 0
const snapFn = () => { snapCalls++ }
api.setup({ startX: 500, startW: 240, snap: snapFn })
api.applyDrag(355)                                   // -145 → raw 95 < 200*0.5
check('越过半程触发 snap-close 回调（且只触发一次）', snapCalls === 1, `实际 ${snapCalls}`)
check('snap-close 不落盘（宽度保持原值，收回交给调用方）', api.persisted().length === 0)
check('snap-close 后拖拽会话已收束（dragRef 清空 + 拖拽态置回）',
  api.dragRef.current === null && draggingEvents().at(-1) === false)
const widthAfterSnap = widthEvents().length
api.applyDrag(0)                                     // 会话已结束，再拖不应有反应
check('snap-close 后再拖无效（会话已结束）', widthEvents().length === widthAfterSnap)

// ⑥ endDrag 幂等 + body 污染必清（现象③ 的直接防回归）
api.setup({ startX: 100, startW: 240 })
api.applyDrag(300)
check('拖拽期 body 被禁选中 + 换缩放光标',
  api.bodyStyle().userSelect === 'none' && api.bodyStyle().cursor === 'col-resize',
  JSON.stringify(api.bodyStyle()))
api.endDrag()
check('松手后 body.userSelect 还原', api.bodyStyle().userSelect === '' || api.bodyStyle().userSelect === undefined)
check('松手后 body.cursor 还原', api.bodyStyle().cursor === '' || api.bodyStyle().cursor === undefined)
api.endDrag()
api.endDrag()
check('endDrag 可重复调用不抛错（四路兜底会重复命中）', true)

// ⑦ 未按下就 endDrag（例如 lostpointercapture 先于 pointerdown 抵达）→ 安全返回、不落盘
api.reset()
api.endDrag()
check('未按下时 endDrag 安全（无 dragRef 直接返回）', api.persisted().length === 0)

// ------------------------------------------------------------------ 报告
const failed = checks.filter(c => !c.pass)
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  — ' + c.detail : ''}`)
}
console.log(`\n合计 ${checks.length} 项：PASS ${checks.length - failed.length} / FAIL ${failed.length}`)
try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
process.exit(failed.length === 0 ? 0 : 1)
