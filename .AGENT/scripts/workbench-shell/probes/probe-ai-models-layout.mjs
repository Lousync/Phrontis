/**
 * 探针：AI 模型页布局（2026-10-15 建；2026-11-20 按「设置模型页重做」更新口径）。
 *
 * 断言（全部基于 DOM getBoundingClientRect / getComputedStyle，不用截图量几何）：
 *   L1  外壳就位且首启遮罩已关
 *   L2  设置 → AI → 模型 打开（走 App.tsx 的 settings:open 通道）
 *   L3  ★ 整页一条内容列：场景组头 === 场景卡 === 供应商行 === 条目卡（不再有 max-w-md 收窄）
 *   L4  场景表 8 行（重做未改槽位结构）
 *   L5  条目行三层：5 个能力标签 / 上下文千 token 带 K / 名称默认无框
 *   L6  ★ 框线可见：--field-border 已定义，且搜索框边框色 ≠ 输入底色（深色下尤其）
 *   L7  ★ 320px 视口无横向溢出（设置根节点与文档 scrollWidth === clientWidth）
 *   L8  console.error / 未捕获异常 = 0
 *
 * 跑法（Linux dev）：
 *   ./node_modules/electron/dist/electron . --remote-debugging-port=9333 --no-sandbox --disable-gpu \
 *     --user-data-dir=/tmp/opencode/kb-probe-models &
 *   KNOWBASE_PROBE_PORT=9333 node .AGENT/scripts/workbench-shell/probes/probe-ai-models-layout.mjs
 * Windows 用 run-probe.mjs 宿主（见文件尾注释）。
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

async function shot(name) {
  for (let i = 0; i < 2; i++) {
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, 6000)
      writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(data, 'base64'))
      console.log(`  [截图] ${SHOT_DIR}/${name}.png`)
      return
    } catch (e) { console.log(`  [截图] 第 ${i + 1} 次失败：${e.message}`) }
  }
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

  // ---- L1 等外壳挂载：CDP target 出现 ≠ 渲染层挂完；期间顺带关首启遮罩 ----
  let shell = null
  for (let i = 0; i < 30 && !(shell && shell.ready && !shell.overlay); i++) {
    shell = await evalJs(`(() => ({
      ready: document.body.innerText.trim().length > 0,
      pagebar: !!document.querySelector('[data-wb="pagebar"]'),
      overlay: document.body.textContent.includes('稍后在编辑区打开仓库')
        || document.body.textContent.includes('欢迎使用 Phrontis'),
      btns: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 12),
      bodyHead: document.body.innerText.trim().slice(0, 140),
    }))()`)
    if (shell.ready && !shell.overlay) break
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
  ok(!!shell && shell.ready && !shell.overlay, 'L1 外壳就位且首启遮罩已关',
    `pagebar=${!!(shell && shell.pagebar)} 仓库选择页残留=${!!(shell && shell.overlay)}`)
  if (!shell || !shell.ready || shell.overlay) {
    console.log('  [诊断] buttons=' + JSON.stringify(shell?.btns))
    console.log('  [诊断] body=' + JSON.stringify(shell?.bodyHead))
    console.log('外壳未就位或遮罩未关，后续证据无效')
    return
  }

  // L2 走 App.tsx 的 settings:open 通道（与应用内「去配置模型」同一条路）
  await evalJs(`window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'models' } }))`)
  await sleep(1400)

  // 展开场景分配组（默认收起且内层懒挂载）
  await evalJs(`(() => {
    const header = document.querySelector('[data-setting-anchor="aiTools.scenes"] > div > div:first-child')
    const btn = header && header.querySelector('button')
    if (btn) btn.click()
    return !!btn
  })()`)
  await sleep(800)

  const m = await evalJs(`(() => {
    const r = (el) => { if (!el) return -1; const b = el.getBoundingClientRect(); return Math.round(b.width) }
    const anchor = document.querySelector('[data-setting-anchor="aiTools.scenes"]')
    if (!anchor) return { anchor: false }
    const column = anchor.parentElement && anchor.parentElement.parentElement
    const group = anchor.firstElementChild
    const header = group && group.firstElementChild
    const card = anchor.querySelector('[class*="rounded-[10px]"]')
    const provBtn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('添加供应商'))
    const provRow = provBtn && provBtn.parentElement
    const entries = document.querySelector('[role="radiogroup"][aria-label="模型条目"]')
    const sceneRows = [...anchor.querySelectorAll('.kb-collapse .kb-hoveronly-host')]
    return {
      anchor: true,
      colW: r(column),
      headerW: r(header),
      cardW: r(card),
      provRowW: r(provRow),
      entriesW: r(entries),
      sceneRows: sceneRows.length,
      sceneLabels: sceneRows.map(x => (x.textContent || '').trim().slice(0, 8)),
    }
  })()`)

  ok(m.anchor, 'L2 设置 → AI → 模型 已打开', `场景分配锚点在=${m.anchor}`)
  if (!m.anchor) return

  // L3 ★ 整页一条内容列（重做取消了 max-w-md）
  const widths = [m.colW, m.headerW, m.cardW, m.provRowW, m.entriesW].filter(w => w > 0)
  const maxDiff = Math.max(...widths) - Math.min(...widths)
  ok(widths.length === 5 && maxDiff <= 2, 'L3 ★ 组头 / 场景卡 / 供应商行 / 条目卡 与内容列等宽',
    `内容列=${m.colW} 组头=${m.headerW} 场景卡=${m.cardW} 供应商行=${m.provRowW} 条目卡=${m.entriesW} 最大差=${maxDiff}px`)

  // L4 场景表 8 行
  ok(m.sceneRows === 8, 'L4 场景表仍是 8 行', `rows=${m.sceneRows} 行首=${JSON.stringify(m.sceneLabels)}`)

  // L5 条目行三层
  const entry = await evalJs(`(() => {
    const row = document.querySelector('[role="radiogroup"][aria-label="模型条目"] article')
    if (!row) return { row: false }
    const caps = [...row.querySelectorAll('[role="group"][aria-label="能力"] button')]
    const name = row.querySelector('input[aria-label^="条目名称"]')
    const ctxField = row.querySelector('.kb-field-sm')
    const ctxInput = ctxField && ctxField.querySelector('input')
    const cs = name ? getComputedStyle(name) : null
    return {
      row: true,
      caps: caps.length,
      nameBorder: cs ? cs.borderTopColor : '',
      ctxK: !!ctxField,
      ctxSuffix: !!(ctxField && [...ctxField.querySelectorAll('span')].some(s => s.textContent.trim() === 'K')),
      ctxValue: ctxInput ? ctxInput.value : '',
    }
  })()`)
  ok(entry.row && entry.caps === 5, 'L5a 条目行常显 5 个能力标签', `caps=${entry.caps}`)
  ok(entry.ctxK, 'L5b 上下文窗口是 .kb-field-sm 组合框', `ctx=${entry.ctxK}`)
  ok(entry.nameBorder === 'rgba(0, 0, 0, 0)' || entry.nameBorder === 'transparent',
    'L5c 名称默认无框（透明边框）', `border=${entry.nameBorder}`)

  // L6 深色框线可见（临时摘掉浅色/昼夜主题类与内联变量，回到 :root 深色默认）
  const dark = await evalJs(`(() => {
    const html = document.documentElement
    const savedClass = html.className
    const savedStyle = html.getAttribute('style')
    html.className = savedClass.replace(/\\btheme-(light|daycycle)\\b/g, '')
    html.removeAttribute('style')
    // 用一个临时元素把 color-mix 令牌解析成真实颜色（直接读正在过渡的控件会拿到中间色）
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;border:1px solid var(--field-border);background:var(--input-bg)'
    document.body.appendChild(probe)
    const cs = getComputedStyle(probe)
    const border = cs.borderTopColor
    const bg = cs.backgroundColor
    const token = cs.getPropertyValue('--field-border').trim()
    probe.remove()
    html.className = savedClass
    if (savedStyle == null) html.removeAttribute('style'); else html.setAttribute('style', savedStyle)
    return { token, border, bg, saved: savedClass }
  })()`)
  ok(!!dark.token, 'L6a --field-border 令牌已生效', `值=${dark.token}`)
  ok(!!dark.border && dark.border !== dark.bg, 'L6b 深色下框线颜色 ≠ 输入底色（框可见）',
    `边框=${dark.border} 底色=${dark.bg}（主题类=${dark.saved}）`)
  await shot('ai-models-dark')

  // L7 320px 无横向溢出
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
  const narrow = await evalJs(`(() => {
    const root = document.querySelector('.kb-theme-surface')
    const doc = document.documentElement
    const offenders = []
    if (root) {
      for (const el of root.querySelectorAll('*')) {
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
          offenders.push((el.className && String(el.className).slice(0, 48)) || el.tagName)
          if (offenders.length >= 5) break
        }
      }
    }
    return {
      docOverflow: doc.scrollWidth - doc.clientWidth,
      rootOverflow: root ? root.scrollWidth - root.clientWidth : -1,
      navVisible: !!root && !!root.querySelector('.w-48') && root.querySelector('.w-48').getBoundingClientRect().width > 0,
      offenders,
    }
  })()`)
  ok(narrow.docOverflow <= 0 && narrow.rootOverflow <= 0, 'L7 ★ 320px 下无横向溢出',
    `doc溢出=${narrow.docOverflow} 根溢出=${narrow.rootOverflow} 左导航可见=${narrow.navVisible} 候选=${JSON.stringify(narrow.offenders)}`)
  await shot('ai-models-320')
  await send('Emulation.clearDeviceMetricsOverride')

  ok(consoleErrors === 0 && exceptions === 0, 'L8 console.error / 未捕获异常 = 0',
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
