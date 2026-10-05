/**
 * 终端内部体检探针（第 11 发）：暴露 __kbTerm 后直读 xterm 内部状态，
 * 并用带 keyCode 的合成 keydown（Object.defineProperty 注入）+ CDP 真实键做终局对照。
 */
const BASE = 'http://127.0.0.1:7465'
const CDP_PORT = process.env.KNOWBASE_PROBE_PORT ?? '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(path, body) {
  const res = await fetch(BASE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const j = await res.json()
  if (!j.ok) throw new Error(`${path} -> ${JSON.stringify(j.error).slice(0, 200)}`)
  return j.data ?? j
}
const evalMain = async (code) => { const r = await api('/action', { name: 'ui.eval', params: { code } }); return r?.result?.result ?? r?.result ?? r }
async function shot(label) { const r = await api('/ui/screenshot'); console.log(`[SHOT] ${label} -> ${r.file}`) }

async function main() {
  let up = false
  for (let i = 0; i < 60; i++) { try { await api('/health'); up = true; break } catch { await sleep(1000) } }
  if (!up) throw new Error('devbridge 未就绪')
  await sleep(4000)
  let opened = false
  for (let i = 0; i < 5 && !opened; i++) {
    await api('/action', { name: 'ui.click', params: { target: 'text=终端' } })
    for (let j = 0; j < 8; j++) {
      await sleep(800)
      if (await evalMain(`(() => { const x = document.querySelector('.xterm'); return x ? !!(x.offsetWidth || x.offsetHeight) : false })()`) === true) { opened = true; break }
    }
  }
  if (!opened) throw new Error('终端 Tab 未打开')
  await sleep(2500)

  console.log('[ALIVE]', await evalMain(`(() => {
    const w = window; if (!w.__kbTerm) return 'NO __kbTerm（onData 从未 fire，钩子未挂）'
    w.__kbProbe = null
    w.__kbTerm.onData(d => { w.__kbProbe = d })
    w.__kbTerm.write('X')
    return 'term-alive, write X done'
  })()`))
  await sleep(300)
  console.log('[ROWS-1]', await evalMain(`document.querySelector('.xterm-rows').innerText.slice(0, 80)`))
  console.log('[STATE]', await evalMain(`(() => { const c = window.__kbTerm._core; return JSON.stringify({
    isComposing: c._compositionHelper?._isComposing ?? 'n/a',
    isSending: c._compositionHelper?._isSendingComposition ?? 'n/a',
  }) })()`))

  console.log('--- 合成 keydown（keyCode=68 注入）')
  console.log('[SYN]', await evalMain(`(() => {
    const ta = document.querySelector('.xterm-helper-textarea')
    ta.focus()
    const ev = new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'keyCode', { value: 68 }); Object.defineProperty(ev, 'which', { value: 68 })
    ta.dispatchEvent(ev)
    return 'dispatched'
  })()`))
  await sleep(500)
  console.log('[PROBE-DATA]', await evalMain(`JSON.stringify(window.__kbProbe)`))
  console.log('[DBG]', await evalMain(`JSON.stringify(window.__kbTermDbg ?? null)`))
  console.log('[ROWS-2]', await evalMain(`document.querySelector('.xterm-rows').innerText.slice(0, 120)`))

  console.log('--- CDP 真实键盘 d')
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(r => r.json())
  const page = targets.find(t => t.type === 'page' && !/devtools/.test(t.url))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws 超时')), 5000); ws.onopen = () => { clearTimeout(t); res() }; ws.onerror = () => { clearTimeout(t); rej(new Error('ws 失败')) } })
  let seq = 0; const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const cdp = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pending.set(i, res); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('CDP 超时')) } }, 8000); ws.send(JSON.stringify({ id: i, method, params })) })
  await cdp('Runtime.enable')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68, text: 'd', unmodifiedText: 'd' })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 })
  await sleep(800)
  console.log('[PROBE-DATA]', await evalMain(`JSON.stringify(window.__kbProbe)`))
  console.log('[DBG]', await evalMain(`JSON.stringify(window.__kbTermDbg ?? null)`))
  console.log('[ROWS-3]', await evalMain(`document.querySelector('.xterm-rows').innerText.slice(0, 160)`))
  await shot('110-final')
  console.log('PASS')
  try { ws.close() } catch {}
}
main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
