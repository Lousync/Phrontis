/**
 * 终端决胜探针（第 8 发）：等 Tab 真正可见（防启动竞态）→ CDP 真实键盘 →
 * 读 window.__kbTermDbg（onData 是否 fire）+ rows + 截图。
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui8.mjs --no-sandbox --disable-gpu
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
  await sleep(4000) // 等工作台完全 settle（启动 Tab 恢复等）

  let opened = false
  for (let i = 0; i < 5 && !opened; i++) {
    await act('ui.click', { target: 'text=终端' })
    for (let j = 0; j < 8; j++) {
      await sleep(800)
      const vis = await evalMain(`(() => { const x = document.querySelector('.xterm'); return x ? !!(x.offsetWidth || x.offsetHeight) : false })()`)
      if (vis === true) { opened = true; break }
    }
  }
  if (!opened) throw new Error('终端 Tab 未成功打开（5 次重试后仍不可见）')
  console.log('[OK] .xterm 可见')
  await sleep(2500) // 等 shell 提示符

  console.log('[DBG-PRE]', await evalMain(`JSON.stringify(window.__kbTermDbg ?? null)`))

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

  console.log('--- CDP 真实键盘 d i r + Enter')
  for (const ch of ['d', 'i', 'r']) {
    const vk = ch.toUpperCase().charCodeAt(0)
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: ch, unmodifiedText: ch })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await sleep(80)
  }
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await sleep(2000)

  console.log('[DBG]', await evalMain(`JSON.stringify(window.__kbTermDbg ?? null)`))
  console.log('[ROWS]', await evalMain(`document.querySelector('.xterm-rows').innerText.slice(0, 300)`))
  await shot('70-cdp-typed')

  console.log('PASS —— 决胜探针跑完')
  try { ws.close() } catch { /* ignore */ }
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
