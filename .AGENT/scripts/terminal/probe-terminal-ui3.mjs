/**
 * 终端输入事件探针（第 3 发）：给 xterm 的 helper textarea 装事件监听，
 * 精确回答「按键事件到底到没到 textarea、到的是什么事件」。
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui3.mjs --no-sandbox --disable-gpu
 */
const BASE = 'http://127.0.0.1:7465'
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
const evalJs = async (code) => (await act('ui.eval', { code })).result
async function shot(label) {
  const r = await api('/ui/screenshot')
  console.log(`[SHOT] ${label} -> ${r.file}`)
}

const SPY_INSTALL = `(() => {
  const ta = document.querySelector('.xterm-helper-textarea')
  if (!ta) return 'NO_TEXTAREA'
  window.__kbSpy = []
  for (const t of ['keydown','keypress','input','compositionstart','compositionupdate','compositionend','focus','blur','paste']) {
    ta.addEventListener(t, (e) => window.__kbSpy.push(t + ':' + String(e.key ?? '') + ':' + String(e.data ?? '').slice(0, 24)))
  }
  ta.focus()
  return 'spy-installed, active=' + (document.activeElement === ta ? 'textarea' : document.activeElement?.className?.slice(0, 40))
})()`

async function main() {
  let up = false
  for (let i = 0; i < 60; i++) { try { await api('/health'); up = true; break } catch { await sleep(1000) } }
  if (!up) throw new Error('devbridge 未就绪')
  await sleep(2500)

  await act('ui.click', { target: 'text=终端' })
  await act('ui.wait', { target: '.xterm', timeoutMs: 20000 })
  await sleep(3500)
  await shot('20-boot')

  console.log('[INSTALL]', await evalJs(SPY_INSTALL))

  console.log('--- 真实按键 a, b')
  await act('ui.key', { key: 'a' })
  await sleep(150)
  await act('ui.key', { key: 'b' })
  await sleep(400)
  console.log('[SPY]', await evalJs('JSON.stringify(window.__kbSpy)'))
  console.log('[ROWS]', await evalJs(`document.querySelector('.xterm-rows').innerText.slice(0, 200)`))
  await shot('21-key-ab')

  console.log('--- insertText: 你好')
  await act('ui.type', { target: '.xterm-helper-textarea', text: '你好' })
  await sleep(500)
  console.log('[SPY]', await evalJs('JSON.stringify(window.__kbSpy)'))
  console.log('[ROWS]', await evalJs(`document.querySelector('.xterm-rows').innerText.slice(0, 200)`))
  await shot('22-insert')

  console.log('--- 主动 focus 后再打: x, y')
  await evalJs(`document.querySelector('.xterm-helper-textarea').focus(); 'focused'`)
  await act('ui.key', { key: 'x' })
  await sleep(150)
  await act('ui.key', { key: 'y' })
  await sleep(400)
  console.log('[SPY]', await evalJs('JSON.stringify(window.__kbSpy)'))
  console.log('[ROWS]', await evalJs(`document.querySelector('.xterm-rows').innerText.slice(0, 240)`))
  await shot('23-focus-xy')

  console.log('PASS —— 输入事件探针跑完')
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
