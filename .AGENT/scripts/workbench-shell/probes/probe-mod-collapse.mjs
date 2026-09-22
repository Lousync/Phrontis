/**
 * 回归探针：左栏收起时模块侧栏绝不回落渲染到中间主体（2026-09-17 用户报障）。
 * 场景：进入 knowledge 模块态（portal 挂左栏 slot）→ 单击手柄收起左栏 →
 *       断言 slot 卸载且模块容器内无侧栏特征节点（修复前 = ResizablePanel 回落中间）→
 *       展开左栏 → 断言 portal 恢复。
 * 特征元素 = knowledge 侧栏底部「图谱」入口按钮（sidebarInner 内，portal 与内嵌两形态都渲染）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = Number(process.env.KB_CDP_PORT || 9222) // 端口可覆盖（见 run-probe.mjs）：默认 9222 不变
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 40; i++) {
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
const consoleErrors = []
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

const results = []
function ok(pass, label, detail = '') {
  results.push({ pass, label, detail })
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? '  → ' + detail : ''}`)
}

const GRAPH_BTN = `(() => {
  const btns = [...document.querySelectorAll('button')]
  return btns.filter(b => b.textContent?.trim() === '图谱').length
})()`

const JS_STATE = `(() => {
  const slot = document.querySelector('[data-wb="modSlot"]')
  return { slot: !!slot, filled: !!slot && slot.children.length > 0 }
})()`

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'exception'].includes(m.params.type)) {
      consoleErrors.push(m.params.args?.map(a => a.value ?? a.description).join(' '))
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description || 'exception')
    }
  }
  await send('Runtime.enable')
  await sleep(800)

  // 1. 总览态点知识库书签 → 模块态 + portal 挂 slot
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="knowledge"]')?.click(); return true })()`)
  await sleep(600)
  const st1 = await evalJs(JS_STATE)
  ok(st1.slot && st1.filled, 'M1 knowledge 模块态 → 侧栏 portal 进 slot')

  // 2. 修复前基线：此时中间主体不应有侧栏内容（portal 已迁走）
  const before0 = await evalJs(GRAPH_BTN)
  ok(before0 === 1, 'M2 portal 后「图谱」入口仅存在 1 处（slot 内）', `count=${before0}`)

  // 3. 单击手柄收起左栏
  await evalJs(`(() => {
    const h = document.querySelector('div[role="separator"][title="拖拽调整宽度，双击复位"]')
    ;(h || window).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    return 'DOWN'
  })()`)
  await sleep(150)
  await evalJs(`(() => {
    const h = document.querySelector('div[role="separator"][title="拖拽调整宽度，双击复位"]')
    ;(h || window).dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    return 'UP'
  })()`)
  await sleep(600)

  // 4. 核心断言：收起后左栏卸载 + 全 DOM 无「图谱」入口（修复前 = 回落中间 → count=1）
  const leftGone = await evalJs(`!document.querySelector('[data-wb="leftPanel"]')`)
  ok(leftGone, 'M3 左栏收起 → leftPanel 卸载')
  const cnt = await evalJs(GRAPH_BTN)
  ok(cnt === 0, 'M4 收起后模块侧栏不回落中间（图谱入口 0 处）', `count=${cnt}`)

  // 5. 展开恢复：边缘条点击 → slot 重挂 → portal 回来
  await evalJs(`(() => { const e=document.querySelector('div[title="拖拽或点击展开"]'); e?.click(); return !!e })()`)
  await sleep(700)
  const cnt2 = await evalJs(GRAPH_BTN)
  const st2 = await evalJs(JS_STATE)
  ok(cnt2 === 1 && st2.slot && st2.filled, 'M5 展开后 portal 恢复（图谱入口回到 slot）', `count=${cnt2} slot=${st2.slot}`)

  const fails = results.filter((r) => !r.pass)
  console.log('\n========================================')
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.label}${r.detail ? '  → ' + r.detail : ''}`)
  console.log(fails.length === 0 ? `\n✅ ${results.length} 项全 PASS` : `\n❌ ${fails.length}/${results.length} FAIL`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针失败:', e.message); process.exit(2) })
