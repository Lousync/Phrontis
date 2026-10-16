/**
 * 探针：用量整窗模块（v3.9.0 步骤 3/4 真机验收）。
 *
 * 断言（DOM 判据；截图只作观感佐证）：
 *   W0  外壳就位且两层首启遮罩已关
 *   W1  图标条有「用量」按钮，点击后模块挂载（[data-wb="usage"]）
 *   W2  模块根 `h-full` 生效：根节点高度接近可视区（不是塌成 0 / 只占内容高）
 *   W3  账户额度区在场（「账户额度」标题 + 刷新按钮）
 *   W4  空数据时给出空态文案，或渲染四块（总消耗 / 趋势 / 热力图 / 拆分）
 *   W5  页面无 NaN
 *   W6  console.error / 未捕获异常 = 0
 *
 * 跑法：KNOWBASE_PROBE_PORT=9333 node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *         .AGENT/scripts/usage-dashboard/probe-usage-module.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const SHOT_DIR = 'tmp/probe-usage-module'
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
  ok(!!shell && shell.pagebar && !shell.overlay, 'W0 外壳就位且两层首启遮罩已关',
    `pagebar=${!!(shell && shell.pagebar)} 遮罩残留=${!!(shell && shell.overlay)}`)
  if (!shell || !shell.pagebar || shell.overlay) return

  // 点图标条「用量」按钮
  const clicked = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === '用量')
    if (!b) return 'no-btn'
    b.click(); return 'ok'
  })()`)
  ok(clicked === 'ok', 'W1a 图标条有「用量」按钮', clicked)

  let mounted = false
  for (let i = 0; i < 40; i++) {
    mounted = await evalJs(`!!document.querySelector('[data-wb="usage"]')`)
    if (mounted) break
    await sleep(150)
  }
  ok(mounted, 'W1b 点击后用量模块挂载（[data-wb="usage"]）')

  const m = await evalJs(`(() => {
    const root = document.querySelector('[data-wb="usage"]')
    if (!root) return { root: false }
    const cs = getComputedStyle(root)
    const bodyText = root.textContent || ''
    const hasQuota = bodyText.includes('账户额度')
    const hasRefresh = [...root.querySelectorAll('button')].some(b => (b.textContent || '').includes('刷新'))
    const hasEmpty = bodyText.includes('还没有用量记录')
    const hasBlocks = bodyText.includes('总消耗') && bodyText.includes('趋势') && bodyText.includes('活动热力图') && bodyText.includes('拆分')
    const nan = /NaN/.test(bodyText)
    return {
      root: true,
      height: root.getBoundingClientRect().height,
      overflowY: cs.overflowY,
      hasQuota, hasRefresh, hasEmpty, hasBlocks, nan,
      blocksSample: hasBlocks ? '四块齐' : '缺块',
    }
  })()`)

  ok(m.root && m.height > 300, 'W2 模块根 h-full 生效（高度接近可视区，不塌）', `高度=${Math.round(m.height || 0)}px overflowY=${m.overflowY}`)
  ok(m.hasQuota && m.hasRefresh, 'W3 账户额度区在场（标题 + 刷新按钮）', `额度=${m.hasQuota} 刷新=${m.hasRefresh}`)

  // 额度是远程拉取：等它从「查询中…」落到终态（窗口百分比 / 余额 / 失败原因任一）
  let quotaSettled = false
  let quotaText = ''
  for (let i = 0; i < 60; i++) {
    quotaText = await evalJs(`(() => { const r = document.querySelector('[data-wb="usage"]'); return r ? (r.textContent || '') : '' })()`)
    if (quotaText.includes('账户额度') && !quotaText.includes('查询中…') && !quotaText.includes('未查询')) { quotaSettled = true; break }
    await sleep(250)
  }
  ok(quotaSettled, 'W3b 额度卡落到终态（不再是「查询中…/未查询」）', quotaSettled ? '已落定' : quotaText.slice(0, 80))

  ok(m.hasEmpty || m.hasBlocks, 'W4 空态文案或四块看板二选一', m.hasEmpty ? '空态（新环境无调用记录）' : m.blocksSample)
  ok(!m.nan, 'W5 页面无 NaN')

  for (let i = 0; i < 2; i++) {
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, 6000)
      writeFileSync(`${SHOT_DIR}/usage-module.png`, Buffer.from(data, 'base64'))
      console.log(`  [截图] ${SHOT_DIR}/usage-module.png`)
      break
    } catch (e) { console.log(`  [截图] 第 ${i + 1} 次失败：${e.message}`) }
  }

  ok(consoleErrors === 0 && exceptions === 0, 'W6 console.error / 未捕获异常 = 0',
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
