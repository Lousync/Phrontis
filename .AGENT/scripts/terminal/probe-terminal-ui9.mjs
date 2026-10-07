/**
 * 终端输入对照探针（第 9 发）：
 *   A. 合成 KeyboardEvent（绕过输入管线，直打 textarea）→ onData 是否 fire
 *   B. CDP 真实点击视口（用户路径拿焦点）→ CDP 真实键盘 → onData 是否 fire
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui9.mjs --no-sandbox --disable-gpu
 */
const BASE = 'http://127.0.0.1:7465'
const CDP_PORT = process.env.KNOWBASE_PROBE_PORT ?? '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  const j = await res.json()
  if (!j.ok) throw new Error(`${path} -> ${JSON.stringify(j.error).slice(0, 200)}`)
  return j.data ?? j
}
const act = (name, params) => api('/action', { name, params })
const evalMain = async (code) => {
  const r = await act('ui.eval', { code })
  return r?.result?.result ?? r?.result ?? r
}
async function shot(label) {
  const r = await api('/ui/screenshot')
  console.log(`[SHOT] ${label} -> ${r.file}`)
}

async function main() {
  let up = false
  for (let i = 0; i < 60; i++) { try { await api('/health'); up = true; break } catch { await sleep(1000) } }
  if (!up) throw new Error('devbridge 未就绪')
  await sleep(4000)

  let opened = false
  for (let i = 0; i < 5 && !opened; i++) {
    await act('ui.click', { target: 'text=终端' })
    for (let j = 0; j < 8; j++) {
      await sleep(800)
      const vis = await evalMain(`(() => { const x = document.querySelector('.xterm'); return x ? !!(x.offsetWidth || x.offsetHeight) : false })()`)
      if (vis === true) { opened = true; break }
    }
  }
  if (!opened) throw new Error('终端 Tab 未打开')
  await sleep(2500)
  console.log('[DBG0]', await evalMain(`JSON.stringify(window.__kbTermDbg ?? null)`))

  console.log('--- A. 合成 keydown+keypress 直打 textarea')
  console.log('[SYN]', await evalMain(`(() => {
    const ta = document.querySelector('.xterm-helper-textarea')
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }))
    ta.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', charCode: 97, keyCode: 97, bubbles: true, cancelable: true }))
    return 'ok, active=' + (document.activeElement === ta)
  })()`))
  await sleep(800)
  console.log('[DBG-A]', await evalMain(`JSON.stringify(window.__kbTermDbg ?? null)`))
  console.log('[ROWS-A]', await evalMain(`document.querySelector('.xterm-rows').innerText.slice(0, 120)`))

  console.log('--- B. CDP 真实点击视口 + 真实键盘')
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(r => r.json())
  const page = targets.find(t => t.type === 'page' && !/devtools/.test(t.url))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws 超时')), 5000)
    ws.onopen = () => { clearTimeout(t); res() }
    ws.onerror = () => { clearTimeout(t); rej(new Error('ws 失败')) }
  })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const i = ++seq
    pending.set(i, res)
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('CDP 超时 ' + method)) } }, 8000)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  await cdp('Runtime.enable')
  const rect = JSON.parse(await cdpEvalRect(cdp))
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await sleep(400)
  console.log('[FOCUS]', await evalMain(`'active=' + (document.activeElement === document.querySelector('.xterm-helper-textarea') ? 'textarea' : String(document.activeElement?.className).slice(0, 40)) + ' hasFocus=' + document.hasFocus()`))
  for (const ch of ['w', 'h', 'o']) {
    const vk = ch.toUpperCase().charCodeAt(0)
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: ch, unmodifiedText: ch })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await sleep(80)
  }
  await sleep(800)
  console.log('[DBG-B]', await evalMain(`JSON.stringify(window.__kbTermDbg ?? null)`))
  console.log('[ROWS-B]', await evalMain(`document.querySelector('.xterm-rows').innerText.slice(0, 160)`))
  await shot('80-final')

  console.log('PASS —— 对照探针跑完')
  try { ws.close() } catch { /* ignore */ }
}

function cdpEvalRect(cdp) {
  // 返回 Promise<string>：视口中心点坐标 JSON
  return cdp('Runtime.evaluate', {
    expression: `JSON.stringify((r => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height, 300) / 2) }))(document.querySelector('.xterm').getBoundingClientRect()))`,
    returnByValue: true,
  }).then(m => m.result?.result?.value)
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
