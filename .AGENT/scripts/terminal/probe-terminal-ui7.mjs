/**
 * 终端事实收集探针（第 7 发）：一次性取清 —— textarea 数量（有没有多 pane 并存）、
 * 会话列表、错误尾巴、activeElement 归属、每个 pane 的可见性。
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui7.mjs --no-sandbox --disable-gpu
 */
const BASE = 'http://127.0.0.1:7465'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  const j = await res.json()
  if (!j.ok) throw new Error(`${path} -> ${JSON.stringify(j.error).slice(0, 200)}`)
  return j.data ?? j
}
const evalMain = async (code) => {
  const r = await api('/action', { name: 'ui.eval', params: { code } })
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

  const act = (name, params) => api('/action', { name, params })
  await act('ui.click', { target: 'text=终端' })
  await sleep(5000)

  console.log('[FACTS]', await evalMain(`JSON.stringify({
    textareaCount: document.querySelectorAll('.xterm-helper-textarea').length,
    xtermCount: document.querySelectorAll('.xterm').length,
    activeCls: document.activeElement ? String(document.activeElement.className).slice(0, 50) : null,
    panes: Array.from(document.querySelectorAll('.xterm')).map((x, i) => ({
      i,
      visible: !!(x.offsetWidth || x.offsetHeight),
      inHidden: !!x.closest('.hidden'),
    })),
  })`))

  console.log('[SESSIONS]', await evalMain(`window.api.termList().then(l => JSON.stringify(l.sessions.map(s => ({ id: s.id.slice(0, 8), exited: s.exited, cols: s.cols, rows: s.rows }))))`))

  console.log('[ERRORS]', (() => 'via bridge next')())
  const errs = await api('/errors')
  const list = errs.items ?? errs.errors ?? []
  console.log(`count=${list.length}`)
  for (const e of list.slice(0, 8)) console.log(`  [ERR] ${String(e.message ?? '').slice(0, 200)}`)

  await shot('60-facts')
  console.log('PASS —— 事实收集完成')
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
