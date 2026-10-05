/**
 * 终端断点分流探针（第 2 发）：
 *   A. 真实键盘事件逐字输入（ui.key char 事件 = 用户真打字路径）
 *   B. ui.eval 直读 xterm DOM 状态（activeElement / textarea 值 / xterm-rows 文本）
 *   C. 对照实验：绕过输入路径，window.api.termWrite 直接写 pty ——
 *      若 C 回显而 A 不回显 => 断点在 xterm 输入路径；若 C 也不回显 => 断点在 pty→渲染。
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui2.mjs --no-sandbox --disable-gpu
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
async function shot(label) {
  const r = await api('/ui/screenshot')
  console.log(`[SHOT] ${label} -> ${r.file}`)
  return r.file
}
const readTerm = () => act('ui.eval', { code: `JSON.stringify({
  active: document.activeElement ? document.activeElement.className.slice(0, 60) : null,
  ta: document.querySelector('.xterm-helper-textarea') ? document.querySelector('.xterm-helper-textarea').value : '(no textarea)',
  rows: (document.querySelector('.xterm-rows') ? document.querySelector('.xterm-rows').innerText : '(no rows)').slice(0, 240),
  xtermScreen: !!document.querySelector('.xterm-screen'),
})` }).then(r => console.log('[EVAL]', r.result))

async function typeChars(text) {
  for (const ch of text) {
    if (ch === ' ') await act('ui.key', { key: 'Space' })
    else await act('ui.key', { key: ch })
    await sleep(40)
  }
}

async function main() {
  let up = false
  for (let i = 0; i < 60; i++) { try { await api('/health'); up = true; break } catch { await sleep(1000) } }
  if (!up) throw new Error('devbridge 未就绪')
  await sleep(2500)

  await act('ui.click', { target: 'text=终端' })
  await act('ui.wait', { target: '.xterm', timeoutMs: 20000 })
  await sleep(3500)
  await shot('10-boot')
  await readTerm()

  console.log('--- A. 真实键盘逐字输入: ver + Enter')
  await typeChars('ver')
  await act('ui.key', { key: 'Enter' })
  await sleep(2000)
  await shot('11-typed-ver')
  await readTerm()

  console.log('--- C. 对照：绕过输入路径直接 termWrite')
  await act('ui.eval', { code: `window.api.termList().then(l => { window.api.termWrite(l.sessions[0].id, 'echo DIRECT_PTY_OK_9137\\r'); return 'written to ' + l.sessions.length + ' session(s)' })` })
  await sleep(2500)
  await shot('12-direct-write')
  await readTerm()

  console.log('--- B. insertText 路径（ui.type）对照')
  await act('ui.type', { target: '.xterm-helper-textarea', text: 'echo INSERT_TEXT_OK' })
  await act('ui.key', { key: 'Enter' })
  await sleep(2000)
  await shot('13-insert-text')
  await readTerm()

  const errs = await api('/errors')
  const list = errs.items ?? errs.errors ?? []
  console.log(`[INFO] 渲染层错误 ${list.length} 条`)
  for (const e of list.slice(0, 5)) console.log(`  [ERR] ${String(e.message ?? '').slice(0, 160)}`)
  console.log('PASS —— 分流探针跑完')
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
