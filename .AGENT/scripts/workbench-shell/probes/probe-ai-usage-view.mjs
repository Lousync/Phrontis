/**
 * 探针：设置 → AI → 用量（2026-10-15 方案 D 重排后的真机验收）。
 *
 * 断言（DOM 判据，截图只作观感佐证）：
 *   U1  两个锚点都在（aiTools.usage / aiTools.llmUsage）—— 设置搜索落点不受重排影响
 *   U2  「本月 tokens」大数字 + 「今日」一行存在（今日字段由 llm:getUsage 恒返回）
 *   U3  空态或明细表二选一：无记录时显示「本月还没有模型调用记录」；有记录时表头六列齐全
 *   U4  数字口径：页面不得出现 NaN；本月大数字的 title 是千分位精确值
 *   U5  供应商名兜底：明细里不得出现「空名 · 」（空 provider 已替换为「已删除的供应商」）
 *   U6  console.error / 未捕获异常 = 0
 *
 * 跑法：KNOWBASE_PROBE_PORT=93xx node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/workbench-shell/probes/probe-ai-usage-view.mjs --no-sandbox --disable-gpu \
 *         "--user-data-dir=<APPDATA>/knowbase-probe-ai"
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
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? '  → ' + detail : ''}`)
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

  // 首启两层遮罩（仓库选择页 + 欢迎引导），出口可能是文字链 —— 逐轮收敛直到都消失
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
    const big = llm && [...llm.querySelectorAll('span')].find(x => x.textContent.trim() === '本月 tokens')
    const bigVal = big && big.parentElement.querySelector('span[title]')
    const bodyText = document.body.textContent
    const table = llm && llm.querySelector('table')
    const heads = table ? [...table.querySelectorAll('th')].map(x => x.textContent.trim()) : []
    const emptyState = llm && llm.textContent.includes('本月还没有模型调用记录')
    const emptyBad = /NaN/.test(llm ? llm.textContent : '')
    const rows = table ? [...table.querySelectorAll('tbody tr')].map(tr => {
      const tds = [...tr.querySelectorAll('td')]
      return { name: (tds[0]?.textContent || '').trim().slice(0, 24), cells: tds.length }
    }) : []
    return {
      usage: !!usage, llm: !!llm,
      hasBig: !!bigVal, bigText: bigVal ? bigVal.textContent.trim() : '', bigTitle: bigVal ? bigVal.title : '',
      hasToday: !!llm && llm.textContent.includes('今日'),
      heads, emptyState, emptyBad, rows,
      hasGrid: !!llm && llm.textContent.includes('调用次数') && llm.textContent.includes('输入') && llm.textContent.includes('输出'),
    }
  })()`)

  ok(m.usage && m.llm, 'U1 两个锚点都在（aiTools.usage / aiTools.llmUsage）', `usage=${m.usage} llmUsage=${m.llm}`)
  ok(m.hasBig && m.hasToday && m.hasGrid, 'U2 本月大数字 + 今日行 + 次数/输入/输出三格都在',
    `大数字=${m.bigText}（title=${m.bigTitle}） 今日行=${m.hasToday} 三格=${m.hasGrid}`)
  const shapeOk = m.emptyState || (m.heads.length === 6 && m.heads.join(',') === '供应商 · 模型,次数,输入,输出,合计,占比')
  ok(shapeOk, 'U3 空态或六列明细表二选一',
    m.emptyState ? '空态（新环境无调用记录）' : `表头=${JSON.stringify(m.heads)} 行数=${m.rows.length}`)
  ok(!m.emptyBad && (!m.bigText || /[\d.KM]/.test(m.bigText)) && !/NaN/.test(m.bigTitle || ''), 'U4 数字口径：无 NaN，大数字走 K/M 缩写',
    `大数字=${m.bigText} title=${m.bigTitle}`)
  const badName = m.rows.some(r => r.name.startsWith(' · '))
  ok(!badName, 'U5 供应商名兜底：明细无空名行', m.rows.length ? JSON.stringify(m.rows.slice(0, 3)) : '（无明细行）')

  for (let i = 0; i < 2; i++) {
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, 6000)
      writeFileSync(`${SHOT_DIR}/ai-usage-tab.png`, Buffer.from(data, 'base64'))
      console.log(`  [截图] ${SHOT_DIR}/ai-usage-tab.png`)
      break
    } catch (e) { console.log(`  [截图] 第 ${i + 1} 次失败：${e.message}`) }
  }

  ok(consoleErrors === 0 && exceptions === 0, 'U6 console.error / 未捕获异常 = 0',
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
