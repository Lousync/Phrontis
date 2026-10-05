/**
 * CDP 真实键盘注入探针（第 5 发）：devbridge 的 sendInputEvent 按键进不了 DOM（ui3 实测），
 * 换 CDP Input.dispatchKeyEvent —— Chromium 输入管线，与真实键盘等价。
 * 复现「终端无法输入」：注入前装 textarea 事件监听，注入后读监听结果 + xterm 缓冲。
 *
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui5.mjs --no-sandbox --disable-gpu
 * 前提：run-probe 自带 --remote-debugging-port（KNOWBASE_PROBE_PORT，默认 9222）。
 */
const BASE = 'http://127.0.0.1:7465'
const CDP_PORT = process.env.KNOWBASE_PROBE_PORT ?? '9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  const j = await res.json()
  if (!j.ok) throw new Error(`${path} -> ${JSON.stringify(j.error).slice(0, 300)}`)
  return j.data ?? j
}
const act = (name, params) => api('/action', { name, params })
const evalMain = async (code) => (await act('ui.eval', { code })).result?.result ?? (await act('ui.eval', { code }))
async function shot(label) {
  const r = await api('/ui/screenshot')
  console.log(`[SHOT] ${label} -> ${r.file}`)
}

const SPY = `(() => {
  const ta = document.querySelector('.xterm-helper-textarea')
  if (!ta) return 'NO_TEXTAREA'
  window.__kbSpy = []
  for (const t of ['keydown','keypress','input','compositionend','focus']) {
    ta.addEventListener(t, (e) => window.__kbSpy.push(t + ':' + String(e.key ?? '') + ':' + String(e.data ?? '').slice(0, 24)))
  }
  ta.focus()
  return 'active=' + (document.activeElement === ta ? 'textarea' : String(document.activeElement?.className).slice(0, 40))
})()`
const READ = `JSON.stringify({ spy: window.__kbSpy ?? null, rows: (document.querySelector('.xterm-rows')?.innerText ?? '(none)').slice(0, 260) })`

async function main() {
  let up = false
  for (let i = 0; i < 60; i++) { try { await api('/health'); up = true; break } catch { await sleep(1000) } }
  if (!up) throw new Error('devbridge 未就绪')
  await sleep(2500)

  // CDP 连页
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(r => r.json())
  const page = targets.find(t => t.type === 'page' && !/devtools/.test(t.url)) ?? targets.find(t => t.type === 'page')
  if (!page) throw new Error('CDP 无 page target: ' + JSON.stringify(targets.map(t => ({ type: t.type, url: t.url })).slice(0, 5)))
  console.log('[CDP] target:', page.url.slice(0, 80))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws open 超时')), 5000)
    ws.onopen = () => { clearTimeout(t); res() }
    ws.onerror = (e) => { clearTimeout(t); rej(new Error('ws 打开失败')) }
  }).catch((e) => { try { ws.close() } catch { /* ignore */ } ; throw e })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const i = ++seq
    pending.set(i, (m) => res(m))
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`CDP ${method} 超时`)) } }, 10000)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const cdpEval = async (expr) => {
    const m = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return m.result?.result?.value
  }
  await cdp('Runtime.enable')

  const typeChar = async (ch) => {
    const vk = ch.toUpperCase().charCodeAt(0)
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: ch, unmodifiedText: ch })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  }
  const pressEnter = async () => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  }

  // 打开终端
  await act('ui.click', { target: 'text=终端' })
  await act('ui.wait', { target: '.xterm', timeoutMs: 20000 })
  await sleep(3500)
  await shot('30-boot')

  console.log('[SPY-INSTALL]', await cdpEval(SPY))

  console.log('--- CDP 真实键盘: d i r (不点击, eval focus 后)')
  for (const ch of ['d', 'i', 'r']) { await typeChar(ch); await sleep(60) }
  await sleep(500)
  console.log('[STATE]', await cdpEval(READ))
  await shot('31-cdp-typed')

  console.log('--- CDP Enter')
  await pressEnter()
  await sleep(2000)
  console.log('[STATE]', await cdpEval(READ))
  await shot('32-cdp-enter')

  console.log('--- CDP 鼠标点击视口中心后再输入 v e r')
  const rect = await cdpEval(`JSON.stringify((r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.querySelector('.xterm').getBoundingClientRect()))`)
  const { x, y } = JSON.parse(rect)
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(300)
  for (const ch of ['v', 'e', 'r']) { await typeChar(ch); await sleep(60) }
  await sleep(500)
  console.log('[STATE]', await cdpEval(READ))
  await shot('33-cdp-click-type')

  console.log('--- 双主题对比度截图')
  await act('ui.eval', { code: `window.api.setSetting('theme', 'light').then(() => 'light-set')` })
  await sleep(800)
  await shot('40-theme-light')
  await act('ui.eval', { code: `window.api.setSetting('theme', 'dark').then(() => 'dark-set')` })
  await sleep(800)
  await shot('41-theme-dark')

  console.log('PASS —— CDP 键盘探针跑完')
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
