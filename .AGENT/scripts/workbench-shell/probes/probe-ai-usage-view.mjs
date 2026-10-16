/**
 * 探针：设置 → AI → 用量（v3.9.0 收敛后的真机验收）。
 *
 * 收敛后本页**只留工具调用量**，token / 费用 / 额度整体移交整窗「用量」模块（方案 §6.1）。
 *
 * 断言（DOM 判据，截图只作观感佐证）：
 *   U1  锚点 aiTools.usage 在；旧的 aiTools.llmUsage 已消失（明细唯一由看板承担）
 *   U2  「本月调用」+ 上限输入在场
 *   U3  「打开用量看板」按钮在场；点击后 `[data-wb="usage"]` 挂载（tab:open 通道打通）
 *   U4  页面无 NaN
 *   U5  console.error / 未捕获异常 = 0
 *
 * 跑法：KNOWBASE_PROBE_PORT=93xx node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/workbench-shell/probes/probe-ai-usage-view.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const SHOT_DIR = 'tmp/probe-ai-usage-view'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* electron 未起，继续等 */ }
    await sleep(500)
  }
  throw new Error(`CDP page target 未出现（PORT=${PORT}）`)
}

let ws
let msgId = 0
const pending = new Map()
let consoleErrors = 0
let exceptions = 0

function send(method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) }, timeoutMs)
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常')
  return r.result?.value
}

const results = []
function ok(pass, label, detail = '') {
  results.push({ pass, label, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? '  -> ' + detail : ''}`)
}

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')) })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') exceptions++
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors++
  }
  await send('Runtime.enable')
  await send('Page.enable')
  mkdirSync(SHOT_DIR, { recursive: true })

  // 首启两层遮罩（仓库选择页 + 欢迎引导），逐轮收敛直到都消失
  let shell = null
  for (let i = 0; i < 30 && !(shell && shell.pagebar && !shell.overlay); i++) {
    shell = await evalJs(`(() => ({
      pagebar: !!document.querySelector('[data-wb="pagebar"]'),
      overlay: document.body.textContent.includes('稍后在编辑区打开仓库')
        || document.body.textContent.includes('欢迎使用 Phrontis'),
    }))()`)
    if (shell.pagebar && !shell.overlay) break
    const clicked = await evalJs(`(() => {
      let cands = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(b => /跳过|暂不设置|知道了|直接进入/.test(b.textContent || ''))
      if (!cands.length) {
        cands = [...document.querySelectorAll('body *')]
          .filter(el => !el.children.length && /暂不设置|跳过|稍后/.test(el.textContent || ''))
      }
      if (!cands.length) return null
      const el = cands.find(b => b.tagName === 'BUTTON') || cands[cands.length - 1]
      const t = el.textContent.trim().slice(0, 24)
      el.click(); return t
    })()`)
    if (clicked) console.log(`  [遮罩] 点了「${clicked}」`)
    await sleep(700)
  }
  ok(!!shell && shell.pagebar && !shell.overlay, 'U0 外壳就位且两层首启遮罩已关',
    `pagebar=${!!(shell && shell.pagebar)} 遮罩残留=${!!(shell && shell.overlay)}`)
  if (!shell || !shell.pagebar || shell.overlay) return

  // 打开用量页签（与应用内跳转同一条 settings:open 通道）
  await evalJs(`window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'usage' } }))`)
  await sleep(1400)

  const m = await evalJs(`(() => {
    const q = (s) => document.querySelector(s)
    const usage = q('[data-setting-anchor="aiTools.usage"]')
    const llm = q('[data-setting-anchor="aiTools.llmUsage"]')
    const body = usage ? (usage.textContent || '') : ''
    const limit = q('[data-setting-anchor="aiTools.monthlyLimit"]')
    const boardBtn = usage ? [...usage.querySelectorAll('button')].find(b => /打开用量看板/.test(b.textContent || '')) : null
    return {
      usage: !!usage, llm: !!llm,
      hasMonth: body.includes('本月调用'),
      hasLimit: !!limit,
      hasBoard: !!boardBtn,
      nan: /NaN/.test(body),
    }
  })()`)

  ok(m.usage && !m.llm, 'U1 锚点 aiTools.usage 在、旧 aiTools.llmUsage 已消失', `usage=${m.usage} llmUsage=${m.llm}`)
  ok(m.hasMonth && m.hasLimit, 'U2 「本月调用」+ 月度上限输入在场', `本月=${m.hasMonth} 上限=${m.hasLimit}`)
  ok(m.hasBoard, 'U3a 「打开用量看板」按钮在场')
  ok(!m.nan, 'U4 页面无 NaN')

  // 点「打开用量看板」→ 走 tab:open → 用量模块挂载
  if (m.hasBoard) {
    await evalJs(`(() => {
      const usage = document.querySelector('[data-setting-anchor="aiTools.usage"]')
      const b = [...usage.querySelectorAll('button')].find(x => /打开用量看板/.test(x.textContent || ''))
      if (b) b.click()
    })()`)
    let mounted = false
    for (let i = 0; i < 40; i++) {
      mounted = await evalJs(`!!document.querySelector('[data-wb="usage"]')`)
      if (mounted) break
      await sleep(150)
    }
    ok(mounted, 'U3b 点击后用量模块挂载（tab:open 通道打通）')
  }

  for (let i = 0; i < 2; i++) {
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, 6000)
      writeFileSync(`${SHOT_DIR}/ai-usage-tab.png`, Buffer.from(data, 'base64'))
      console.log(`  [截图] ${SHOT_DIR}/ai-usage-tab.png`)
      break
    } catch (e) { console.log(`  [截图] 第 ${i + 1} 次失败：${e.message}`) }
  }

  ok(consoleErrors === 0 && exceptions === 0, 'U5 console.error / 未捕获异常 = 0',
    `console.error=${consoleErrors} exceptions=${exceptions}`)
}

try {
  await main()
} catch (e) {
  console.error('[探针异常]', e?.message ?? e)
  results.push({ pass: false, label: '探针自身异常', detail: String(e?.message ?? e) })
} finally {
  const fail = results.filter(r => !r.pass).length
  console.log(`\n断言: ${results.length - fail} PASS, ${fail} FAIL`)
  try { ws && ws.close() } catch { /* 尽力收尾 */ }
  process.exit(fail > 0 ? 1 : 0)
}
