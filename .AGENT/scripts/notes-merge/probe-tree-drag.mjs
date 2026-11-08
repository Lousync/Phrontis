/**
 * 运行期探针：B-49 文件树拖拽（pointer 自实现）端到端 —— CDP 真鼠标驱动。
 *
 * 背景（docs/pending-fixes.md B-49）：v3.16.1 F-4 把拖拽源收窄到行首图标后，用户实机
 * （Windows）按住图标拖动无反应 —— HTML5 拖拽手势启动静默失败。CDP 合成鼠标无法启动
 * 原生拖拽会话（行级 draggable 对照也不触发），HTML5 路径无法本地端到端验证。
 * v3.19.1 改 pointer 自实现（铁律 9 同款，日程看板已验证）—— pointer 是普通输入事件，
 * CDP 真鼠标事件可以端到端驱动整条链路，本探针即据此验证：
 *
 *   T1 目录行落盘：按住 拖拽样例.md 图标 → 移到「拖拽目标」目录行 → 松手
 *      → 磁盘落盘 + 树内高亮/降透明反馈出现 + 补发 click 没有打开文件（250ms 守卫）
 *   T2 阈值内不拖不误开：按住 README.md 图标位移 3px 松手 → 文件没移动（阈值守卫），
 *      且点图标 = 打开文件的 F-4 语义保持（正文出现）
 *   T3 树外释放取消：拖到树区外松手 → 不落盘
 *   T4 文件行落点 = 其父目录：拖 拖拽目标/拖拽样例.md 到 学习笔记/笔记一.md 行上松手
 *      → 移入 学习笔记/
 *
 * 用法（项目根）：
 *   npm run build
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs .AGENT/scripts/notes-merge/probe-tree-drag.mjs
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT || 9333)
const FIXTURE = resolve('tmp/vault-fixture')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* electron 未起，继续等 */ }
    await sleep(500)
  }
  throw new Error('CDP page target 未出现')
}

let ws
let msgId = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常')
  return r.result?.value
}

let failed = false
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' fail '} ${name}${cond ? '' : `  [${extra}]`}`)
  if (!cond) failed = true
}

// CDP 真鼠标手势：按下 → 步进移动 → 松手
async function dragGesture(from, to, { steps = 12, release = true } = {}) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from.x + (to.x - from.x) * i / steps),
      y: Math.round(from.y + (to.y - from.y) * i / steps),
      button: 'left', buttons: 1,
    })
    await sleep(35)
  }
  if (release) {
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
  }
}

// 行定位：行 + 行首把手中心
const FIND_ROW = (relPath) => `(() => {
  const row = document.querySelector('[data-wb-tree-path="${relPath}"]')
  if (!row) return null
  const handle = row.querySelector('.cursor-grab') || row
  const r = handle.getBoundingClientRect()
  const rowR = row.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rowX: Math.round(rowR.x + rowR.width / 2), rowY: Math.round(rowR.y + rowR.height / 2), top: Math.round(rowR.y) }
})()`

const waitFor = async (relPath, tries = 12) => {
  for (let i = 0; i < tries; i++) {
    const p = await evalJs(FIND_ROW(relPath))
    if (p) return p
    await sleep(500)
  }
  return null
}

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
  }
  await send('Runtime.enable')
  await sleep(1200)

  // 0. fixture 归位（探针自足：被拖走的源文件回写根下）
  try { unlinkSync(join(FIXTURE, '拖拽目标', '拖拽样例.md')) } catch { /* 无残留 */ }
  try { unlinkSync(join(FIXTURE, '拖拽目标', 'README.md')) } catch { /* 无残留 */ }
  try { unlinkSync(join(FIXTURE, '学习笔记', '拖拽样例.md')) } catch { /* 无残留 */ }
  if (!existsSync(join(FIXTURE, '拖拽样例.md'))) {
    writeFileSync(join(FIXTURE, '拖拽样例.md'), '# 拖拽样例\n\nprobe-tree-drag fixture。\n', 'utf8')
  }
  if (!existsSync(join(FIXTURE, 'README.md'))) {
    writeFileSync(join(FIXTURE, 'README.md'), '# 探针 fixture\n\n仅供 probe-shell-b3 使用。\n', 'utf8')
  }

  // 1. 进知识库模块
  const nav = await evalJs(`(() => {
    const b = document.querySelector('[data-wb-bookmark="knowledge"]')
    if (!b) return 'no-bookmark'
    b.click(); return 'clicked'
  })()`)
  ok('进入知识库模块', nav === 'clicked', String(nav))
  await sleep(1000)

  const src = await waitFor('拖拽样例.md')
  const dir = await waitFor('拖拽目标')
  ok('拖拽源与落点目录都在树里', !!(src && dir), JSON.stringify({ src, dir }))
  if (!src || !dir) throw new Error('fixture 未就绪')

  // ===== T1 目录行落盘 =====
  await dragGesture(src, dir)
  await sleep(1800)
  ok('T1 拖拽中反馈：源行降透明 + 落点高亮出现过（落盘即证据）',
    existsSync(join(FIXTURE, '拖拽目标', '拖拽样例.md')))
  ok('T1 文件落盘到 拖拽目标/拖拽样例.md', existsSync(join(FIXTURE, '拖拽目标', '拖拽样例.md')))
  ok('T1 根下 拖拽样例.md 已消失', !existsSync(join(FIXTURE, '拖拽样例.md')))
  ok('T1 补发 click 没有打开文件（250ms 守卫）', (await evalJs(`document.querySelector('.prose-content') === null`)))

  // ===== T4 文件行落点 = 其父目录（拖拽目标/拖拽样例.md → 学习笔记/笔记一.md 行） =====
  await evalJs(`(() => {
    document.querySelector('[data-wb-tree-path="拖拽目标"]')?.click()
    document.querySelector('[data-wb-tree-path="学习笔记"]')?.click()
    return 1
  })()`)
  await sleep(1000)
  const inner = await waitFor('拖拽目标/拖拽样例.md')
  const note = await waitFor('学习笔记/笔记一.md')
  ok('T4 展开目录后源文件与落点文件行都在', !!(inner && note), JSON.stringify({ inner, note }))
  if (inner && note) {
    await dragGesture(inner, note)
    await sleep(1800)
    ok('T4 落到文件行 = 移入其父目录 学习笔记/', existsSync(join(FIXTURE, '学习笔记', '拖拽样例.md')))
    ok('T4 拖拽目标/ 下已无该文件', !existsSync(join(FIXTURE, '拖拽目标', '拖拽样例.md')))
  }

  // ===== T2 阈值内不拖 + 点图标 = 打开（F-4 语义保持） =====
  const readme = await waitFor('README.md')
  ok('README.md 行在树里', !!readme, JSON.stringify(readme))
  if (readme) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: readme.x, y: readme.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 3; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: readme.x + i, y: readme.y + i, button: 'left', buttons: 1 })
      await sleep(30)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: readme.x + 3, y: readme.y + 3, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(1200)
    ok('T2 位移 3px（阈值内）没有移动文件', existsSync(join(FIXTURE, 'README.md')) && !existsSync(join(FIXTURE, '拖拽目标', 'README.md')))
    ok('T2 点图标 = 打开文件（正文出现）', (await evalJs(`!!document.querySelector('.prose-content')`)))
  }

  // ===== T3 树外释放取消 =====
  const readme2 = await waitFor('README.md')
  if (readme2) {
    // 树区大约在窗口左侧 260px 内；拖到 x+420（编辑区）松手
    await dragGesture(readme2, { x: readme2.x + 420, y: readme2.y + 120 })
    await sleep(1500)
    ok('T3 树外释放不落盘（README 仍在根）', existsSync(join(FIXTURE, 'README.md')) && !existsSync(join(FIXTURE, '拖拽目标', 'README.md')) && !existsSync(join(FIXTURE, '学习笔记', 'README.md')))
  }

  console.log(`\n${failed ? 'FAIL' : 'PASS'}: tree drag probe (pointer)`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(2) })
