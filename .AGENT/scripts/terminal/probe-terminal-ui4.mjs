/**
 * 终端 backlog 取证探针（第 4 发）：打开终端后直接从主进程取 backlog 原始流，
 * 回答「boot 屏的 >>>> 重复字符是 pty 发出来的，还是 xterm 渲染出来的」。
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui4.mjs --no-sandbox --disable-gpu
 */
import { writeFileSync } from 'node:fs'

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
const evalJs = async (code) => {
  const r = await act('ui.eval', { code })
  const v = r?.result ?? r
  return typeof v === 'string' ? v : (v?.result ?? JSON.stringify(v))
}

async function main() {
  let up = false
  for (let i = 0; i < 60; i++) { try { await api('/health'); up = true; break } catch { await sleep(1000) } }
  if (!up) throw new Error('devbridge 未就绪')
  await sleep(2500)

  await act('ui.click', { target: 'text=终端' })
  await act('ui.wait', { target: '.xterm', timeoutMs: 20000 })
  await sleep(4000)

  const backlog = await evalJs(`window.api.termList().then(l => window.api.termAttach(l.sessions[0].id)).then(r => r.backlog)`)
  writeFileSync('tmp/terminal-probe-backlog.txt', String(backlog))
  console.log(`[BACKLOG] 已写 tmp/terminal-probe-backlog.txt（长度 ${String(backlog).length}）`)
  const rows = await evalJs(`JSON.stringify(document.querySelector('.xterm-rows').innerText.slice(0, 300))`)
  console.log('[ROWS]', rows)
  const live = await evalJs(`(() => {
    const hits = []
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      const t = String(el.textContent ?? '').trim()
      if (/^[>?]{5,}$/.test(t)) {
        hits.push({ tag: el.tagName, cls: String(el.className ?? '').slice(0, 90),
          where: el.closest('.xterm') ? 'in-xterm' : 'outside-xterm',
          parentCls: String(el.parentElement?.className ?? '').slice(0, 70) })
      }
    }
    return JSON.stringify(hits)
  })()`)
  console.log('[GT-EL]', live)
  console.log('PASS')
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
