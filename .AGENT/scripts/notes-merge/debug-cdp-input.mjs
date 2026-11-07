// 一次性诊断：CDP Input.dispatchMouseEvent 是否到达页面 DOM（pointerdown/click 记录器）
const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT || 9333)
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

async function main() {
  const page = await waitPage()
  console.log('page url:', page.url)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
  }
  await send('Runtime.enable')
  await sleep(1200)

  const all = await send('Target.getTargets')
  console.log('targets:', (all.targetInfos || []).map(t => `${t.type}:${t.url.slice(0, 60)}`))

  await evalJs(`(() => {
    window.__inLog = []
    window.__bubLog = []
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'click']) {
      document.addEventListener(t, (e) => window.__inLog.push(t + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY)), true)
    }
    // 冒泡链分层探针：target → row → root → document(bubble)
    document.addEventListener('click', (e) => {
      const row = e.target && e.target.closest ? e.target.closest('[data-wb-tree-node]') : null
      window.__bubLog.push('doc-bubble: target=' + (e.target && e.target.tagName) + '.' + String(e.target && e.target.className).slice(0, 30)
        + ' row=' + (row ? row.getAttribute('data-wb-tree-path') : 'none')
        + ' defaultPrevented=' + e.defaultPrevented)
    }, false)
    const rootEl = document.getElementById('root')
    rootEl.addEventListener('click', () => window.__bubLog.push('root-bubble: reached'), false)
    return 1
  })()`)

  // 进知识库模块拿一个可点目标
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="knowledge"]')?.click(); return 1 })()`)
  await sleep(1800)
  const pos = await evalJs(`(() => {
    const row = document.querySelector('[data-wb-tree-path="README.md"]')
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  console.log('row center:', JSON.stringify(pos))

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none', buttons: 0 })
  await sleep(150)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(900)

  const log = await evalJs(`JSON.stringify(window.__inLog)`)
  const bub = await evalJs(`JSON.stringify(window.__bubLog)`)
  const opened = await evalJs(`!!document.querySelector('.prose-content')`)
  console.log('input log:', log)
  console.log('bubble log:', bub)
  console.log('page opened after CDP click:', opened)

  // 对照：同一行改用合成 el.click()
  await evalJs(`(() => {
    window.__inLog.push('---synthetic---')
    const row = document.querySelector('[data-wb-tree-path="README.md"]')
    row?.click(); return 1
  })()`)
  await sleep(1200)
  const opened2 = await evalJs(`!!document.querySelector('.prose-content')`)
  console.log('page opened after synthetic row.click():', opened2)

  // 再对照：CDP click 打目录行（展开行为）
  await evalJs(`window.__inLog = []`)
  const dir = await evalJs(`(() => {
    const row = document.querySelector('[data-wb-tree-path="学习笔记"]')
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (dir) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dir.x, y: dir.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(80)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dir.x, y: dir.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(900)
    const expanded = await evalJs(`!!document.querySelector('[data-wb-tree-path="学习笔记/笔记一.md"]')`)
    console.log('dir expanded after CDP click:', expanded)
  }
  process.exit(0)
}

main().catch((e) => { console.error('DEBUG ERROR:', e); process.exit(2) })
