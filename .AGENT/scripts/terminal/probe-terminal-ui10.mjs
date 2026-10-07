/**
 * 终端 OS 级真键盘探针（第 10 发）：WScript.Shell SendKeys 注入 OS 真键盘消息
 * （等价人手打字的最终验证），激活目标用 electron 进程 PID（与正式版 Phrontis.exe 隔离）。
 * 运行：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/terminal/probe-terminal-ui10.mjs --no-sandbox --disable-gpu
 */
import { execSync } from 'node:child_process'
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

  // 点击视口拿焦点（devbridge 鼠标可用）
  await act('ui.eval', { code: `(() => { const r = document.querySelector('.xterm').getBoundingClientRect(); window.__cx = Math.round(r.x + r.width / 2); window.__cy = Math.round(r.y + 100); return JSON.stringify({ x: window.__cx, y: window.__cy }) })()` })
  const rect = JSON.parse(await evalMain(`JSON.stringify({ x: window.__cx, y: window.__cy })`))
  await act('ui.eval', { code: 'true' })
  // 用 CDP 不可用时的替代：devbridge ui.click 点视口中心
  await act('ui.click', { target: '.xterm' })
  await sleep(500)

  // OS 级真键盘
  console.log('[SENDKEYS]', execSync(
    `powershell -NoProfile -Command "$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1; if (-not $p) { 'NO_ELECTRON_WINDOW'; exit 1 }; $ws = New-Object -ComObject WScript.Shell; $ok = $ws.AppActivate($p.Id); if (-not $ok) { 'ACTIVATE_FAIL'; exit 1 }; Start-Sleep -Milliseconds 400; $ws.SendKeys('dir~'); 'SENT to pid ' + $p.Id"`,
    { encoding: 'utf8' },
  ).trim())
  await sleep(2500)

  console.log('[ROWS]', await evalMain(`document.querySelector('.xterm-rows').innerText.slice(0, 400)`))
  console.log('[DBG]', await evalMain(`JSON.stringify(window.__kbTermDbg ?? null)`))
  await shot('90-sendkeys')

  // 再来一发中文（OS 级 SendKeys 对 CJK 依赖 IME，多数环境不可靠 —— 只试 ASCII 输出链）
  console.log('PASS —— OS 级键盘探针跑完')
}

main().catch((e) => { console.error('[FAIL]', e.message); process.exit(1) })
