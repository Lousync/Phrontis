/**
 * 探针：AI 模型页布局（2026-10-15，宽度对齐 + 「单次 maxTokens 上限」整组删除）。
 *
 * 断言（全部基于 DOM getBoundingClientRect，不用截图量几何 —— skill §②）：
 *   L1  外壳就位且首启遮罩已关（遮罩不拦 .click()，必须单独复查 —— skill §①）
 *   L2  设置 → AI → 模型 打开（走 App.tsx 的 settings:open 通道，与「去配置模型」同一条路）
 *   L3  ★ 核心几何：「场景分配」组头宽 === 场景表内容卡宽（本轮改动：组头加 max-w-md）
 *   L4  同列其它 max-w-md 块与内容卡等宽（整页成一条列）
 *   L5  「高级」组与「单次 maxTokens 上限」不复存在（设置项已整体移除）
 *   L6  场景表 7 行完好（改动没碰行的结构）
 *   L7  console.error / 未捕获异常 = 0
 *
 * 跑法：KNOWBASE_PROBE_PORT=93xx node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/workbench-shell/probes/probe-ai-models-layout.mjs --no-sandbox --disable-gpu \
 *         "--user-data-dir=<APPDATA>/knowbase-probe-ai"     ← 独立 userData：不抢 dev 实例锁（skill §⑦）
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const SHOT_DIR = 'tmp/probe-ai-models-layout'
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
  // 事件监听必须在 enable 之前挂好（skill §二）
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

  // ---- L1 等外壳挂载：CDP target 出现 ≠ 渲染层挂完（bundle 大）；期间顺带关首启遮罩 ----
  let shell = null
  for (let i = 0; i < 30 && !(shell && shell.pagebar && !shell.overlay); i++) {
    shell = await evalJs(`(() => ({
      pagebar: !!document.querySelector('[data-wb="pagebar"]'),
      // 首启有两层：①仓库选择页「暂不设置，稍后在编辑区打开仓库」②欢迎引导「跳过引导」——两层都要关
      overlay: document.body.textContent.includes('稍后在编辑区打开仓库')
        || document.body.textContent.includes('欢迎使用 Phrontis'),
      btns: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 12),
      bodyHead: document.body.innerText.trim().slice(0, 140),
    }))()`)
    if (shell.pagebar && !shell.overlay) break
    // 首启遮罩：只点「跳过 / 暂不设置」类出口，绝不点「打开本地仓库」这类会拉系统对话框的（skill §①）
    const clicked = await evalJs(`(() => {
      let cands = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter(b => /跳过|暂不设置|知道了|直接进入/.test(b.textContent || ''))
      if (!cands.length) {
        // 出口可能只是文字链（无 button/role）→ 找**最内层**的叶子元素
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
  ok(!!shell && shell.pagebar && !shell.overlay, 'L1 外壳就位且首启遮罩已关',
    `pagebar=${!!(shell && shell.pagebar)} 仓库选择页残留=${!!(shell && shell.overlay)}`)
  if (!shell || !shell.pagebar || shell.overlay) {
    console.log('  [诊断] buttons=' + JSON.stringify(shell?.btns))
    console.log('  [诊断] body=' + JSON.stringify(shell?.bodyHead))
    console.log('外壳未就位或遮罩未关，后续证据无效')
    return
  }

  // L2 走 App.tsx 的 settings:open 通道（与应用内「去配置模型」同一条路）
  await evalJs(`window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'models' } }))`)
  await sleep(1400)

  // 展开场景分配组：SettingsGroup 默认收起，且收起时内层子树**不挂载**（懒语义）——
  // 不先点开，内容卡与 7 行根本不在 DOM 里（首轮实测：card=-1、rows=0，假 FAIL）
  await evalJs(`(() => {
    const header = document.querySelector('[data-setting-anchor="aiTools.scenes"] > div > div:first-child')
    const btn = header && header.querySelector('button')
    if (btn) btn.click()
    return !!btn
  })()`)
  await sleep(800) // kb-collapse 220ms + 挂载余量

  // 几何量测（判据只用 DOM；只量**已知布局块**，不扫全部 .max-w-md —— 悬浮 ⓘ 卡也挂这个类，会污染集合）
  const m = await evalJs(`(() => {
    const r = (el) => { if (!el) return -1; const b = el.getBoundingClientRect(); return Math.round(b.width) }
    const anchor = document.querySelector('[data-setting-anchor="aiTools.scenes"]')
    if (!anchor) return { anchor: false }
    const group = anchor.firstElementChild                 // SettingsGroup 根（本轮加了 max-w-md）
    const header = group.firstElementChild                 // 组头那条带框的长条
    const card = anchor.querySelector('.max-w-md.rounded-lg') // 场景表内容卡
    // 供应商小节头（SectionHead + 「添加供应商」按钮那一行）
    const provRow = [...document.querySelectorAll('.max-w-md')].find(el => (el.textContent || '').includes('添加供应商'))
    const rows = [...anchor.querySelectorAll('.kb-collapse .kb-hoveronly-host')]
    return {
      anchor: true,
      colW: r(anchor.parentElement && anchor.parentElement.parentElement),
      headerW: r(header),
      cardW: r(card),
      provRowW: r(provRow),
      hasAdv: [...document.querySelectorAll('h3')].some(h => h.textContent.trim() === '高级'),
      hasMaxCopy: document.body.textContent.includes('单次 maxTokens 上限'),
      rows: rows.length,
      labels: rows.map(x => (x.textContent || '').trim().slice(0, 8)),
    }
  })()`)

  ok(m.anchor, 'L2 设置 → AI → 模型 已打开', `场景分配锚点在=${m.anchor}`)
  if (!m.anchor) return

  // L3 ★ 核心：组头与内容卡等宽（容差 2px，圆角/边框渲染差）
  const d3 = Math.abs(m.headerW - m.cardW)
  ok(m.headerW > 0 && m.cardW > 0 && d3 <= 2, 'L3 ★ 场景分配组头宽 === 场景表卡宽',
    `组头=${m.headerW}px 卡=${m.cardW}px 供应商行=${m.provRowW}px 差=${d3}px（内容列=${m.colW}px）`)

  // L4 同列三个已知布局块等宽（组头 / 内容卡 / 供应商小节头）
  const set4 = [...new Set([m.headerW, m.cardW, m.provRowW].filter(x => x > 0))]
  ok(set4.length === 1, 'L4 组头 / 内容卡 / 供应商行 等宽（整页一条列）',
    `宽度集合=${JSON.stringify(set4)}`)

  // L5 高级组与 maxTokens 文案不复存在
  ok(!m.hasAdv && !m.hasMaxCopy, 'L5 「高级」组与「单次 maxTokens 上限」已整体移除',
    `高级组在=${m.hasAdv} 文案在=${m.hasMaxCopy}`)

  // L6 场景表 7 行完好
  ok(m.rows === 7, 'L6 场景表仍是 7 行（改动没碰行的结构）',
    `rows=${m.rows} 行首=${JSON.stringify(m.labels)}`)

  // 截图（短超时 + 少重试，失败不拦断言 —— skill §⑥）
  for (let i = 0; i < 2; i++) {
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, 6000)
      writeFileSync(`${SHOT_DIR}/ai-models-tab.png`, Buffer.from(data, 'base64'))
      console.log(`  [截图] ${SHOT_DIR}/ai-models-tab.png`)
      break
    } catch (e) { console.log(`  [截图] 第 ${i + 1} 次失败：${e.message}`) }
  }

  ok(consoleErrors === 0 && exceptions === 0, 'L7 console.error / 未捕获异常 = 0',
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
