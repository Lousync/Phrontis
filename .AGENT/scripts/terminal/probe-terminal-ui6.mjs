/**
 * 终端输入深挖探针（第 6 发）：
 *   A. 合成 KeyboardEvent 直发 textarea —— 区分「事件没送到」vs「xterm 收到不处理」
 *   B. 给 Event.prototype 的 stopPropagation / stopImmediatePropagation / preventDefault
 *      打补丁记录调用栈 + window/document/textarea 三层事件记录 —— 找出吞键者
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui6.mjs --no-sandbox --disable-gpu
 */
const BASE = 'http://127.0.0.1:7465'
const CDP_PORT = process.env.KNOWBASE_PROBE_PORT ?? '9333'
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
  await sleep(2500)

  await act('ui.click', { target: 'text=终端' })
  await sleep(1200)
  const st = await api('/state')
  console.log('[STATE-AFTER-CLICK]', JSON.stringify(st?.data?.app ?? st?.app ?? st).slice(0, 220))
  await shot('49-after-click')
  try {
    await act('ui.wait', { target: '.xterm', timeoutMs: 20000 })
  } catch (e) {
    console.log('[WARN] wait 超时：', String(e.message).slice(0, 120))
    const tree = await api('/ui/tree')
    for (const it of (tree.items ?? []).slice(0, 30)) console.log(`  #${it.i} <${it.tag}> v=${it.visible ?? '?'} ${String(it.text).slice(0, 30)}`)
    await shot('50-wait-fail')
  }
  await sleep(3500)

  // 安装仪器
  console.log('[INSTALL]', await evalMain(`(() => {
    const ta = document.querySelector('.xterm-helper-textarea')
    if (!ta) return 'NO_TEXTAREA'
    window.__kbLog = []
    window.addEventListener('keydown', (e) => window.__kbLog.push(['win-capture', e.key, e.target?.tagName, e.defaultPrevented]), true)
    document.addEventListener('keydown', (e) => window.__kbLog.push(['doc-capture', e.key, e.target?.tagName]), true)
    document.addEventListener('keydown', (e) => window.__kbLog.push(['doc-bubble', e.key, e.target?.tagName]))
    for (const t of ['keydown','keypress','input']) ta.addEventListener(t, (e) => window.__kbLog.push(['ta', t, e.key ?? '', String(e.data ?? '').slice(0, 12)]))
    for (const m of ['stopPropagation', 'stopImmediatePropagation', 'preventDefault']) {
      const orig = Event.prototype[m]
      Event.prototype[m] = function (...a) {
        if (this.type === 'keydown' || this.type === 'keypress' || this.type === 'input') {
          window.__kbLog.push([m, this.type, this.key ?? '', String(new Error().stack.split('\\n')[2] ?? '').trim().slice(0, 120)])
        }
        return orig.apply(this, a)
      }
    }
    ta.focus()
    return 'ok, hasFocus=' + document.hasFocus() + ', active=ta'
  })()`))

  console.log('--- A. 合成 KeyboardEvent 直发 textarea（不走输入管线）')
  console.log('[SYN]', await evalMain(`(() => {
    const ta = document.querySelector('.xterm-helper-textarea')
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }))
    ta.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', bubbles: true, cancelable: true }))
    return 'dispatched'
  })()`))
  await sleep(600)
  console.log('[LOG]', await evalMain(`JSON.stringify(window.__kbLog)`))
  console.log('[ROWS]', await evalMain(`document.querySelector('.xterm-rows').innerText.slice(0, 200)`))
  await shot('50-synthetic')

  console.log('--- B. CDP 真实键盘 a（走 Chromium 输入管线）')
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
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: 'a', unmodifiedText: 'a' })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await sleep(600)
  console.log('[LOG]', await evalMain(`JSON.stringify(window.__kbLog)`))
  console.log('[ROWS]', await evalMain(`document.querySelector('.xterm-rows').innerText.slice(0, 200)`))
  await shot('51-cdp-key')

  console.log('PASS —— 深挖探针跑完')
  try { ws.close() } catch { /* ignore */ }
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
