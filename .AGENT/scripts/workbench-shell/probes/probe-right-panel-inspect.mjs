/**
 * 右栏样式探查探针（常备；2026-09-17 第三轮反馈建）
 * 用法：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs .AGENT/scripts/workbench-shell/probes/probe-right-panel-inspect.mjs --no-sandbox --disable-gpu
 * 用途：量三栏外壳/右栏三段的实际计算样式（底色/圆角/边框/margin）+ 番茄钟向上 DOM 链的带边框层数
 *
 * 原一次性样式探查探针：量三栏容器的实际计算样式（底色/圆角/边框/阴影）+ 右栏下段嵌套层级。
 * 用法：node .AGENT/scripts/workbench-shell/probes/run-probe.mjs tmp/probe-inspect.mjs --no-sandbox --disable-gpu
 */
const DEBUG_PORT = Number(process.env.KB_CDP_PORT || 9222) // 端口可覆盖（见 run-probe.mjs）：默认 9222 不变
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* 等 electron */ }
    await sleep(500)
  }
  throw new Error('CDP page target 未出现')
}

let ws
let msgId = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常')
  return r.result?.value
}

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
  }
  for (let i = 0; i < 24; i++) {
    const ready = await evalJs(`!!document.querySelector('[data-wb-bookmark="editor"]')`).catch(() => false)
    if (ready) break
    await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/进入|打开|继续/.test(x.textContent)); b?.click(); return true })()`)
    await sleep(500)
  }
  await sleep(800)
  await evalJs(`(() => {
    if (document.querySelector('[data-wb="toolsZone"]')) return true
    const hs = [...document.querySelectorAll('[data-wb="shell"] [title="拖拽或点击展开"]')]
    hs[hs.length - 1]?.click(); return true
  })()`)
  await sleep(900)

  // 1) 三栏容器样式（右栏 vs 左栏 vs 中间栏）
  const styles = await evalJs(`(() => {
    const info = (el, tag) => {
      if (!el) return { tag, missing: true }
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { tag, cls: el.className.slice(0, 90), bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor,
        radius: cs.borderTopLeftRadius, shadow: cs.boxShadow.slice(0, 110), margin: cs.margin, pad: cs.padding,
        rect: Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) }
    }
    const shell = document.querySelector('[data-wb="shell"]')
    const kids = shell ? [...shell.children] : []
    return {
      leftPanelWrap: info(kids[0], '左栏 ResizablePanel 外壳'),
      rightPanelWrap: info(kids[kids.length - 1], '右栏 ResizablePanel 外壳'),
      rightCard: info(document.querySelector('[data-wb="rightPanel"]'), '右栏卡片(data-wb=rightPanel)'),
      toolsZone: info(document.querySelector('[data-wb="toolsZone"]'), '上段 入口区'),
      recent: info(document.querySelector('[data-wb="recentEdited"]'), '中段 最近编辑'),
      bottomCard: info(document.querySelector('[data-wb="widgetBrief"]')?.parentElement, '下段 控件卡(widgetBrief 父)'),
      brief: info(document.querySelector('[data-wb="widgetBrief"]'), '简略视图容器'),
      pomoCard: info(document.querySelector('[data-wb="pomoMain"]')?.closest('div.rounded-2xl'), '番茄钟自带卡片'),
    }
  })()`)
  console.log('=== 三栏与右栏分段计算样式 ===')
  for (const s of Object.values(styles)) console.log(JSON.stringify(s))

  // 2) 中间栏卡片样式（main 内主内容卡）
  const center = await evalJs(`(() => {
    const el = [...document.querySelectorAll('main div')].find((d) => d.className.includes('rounded-xl') && d.className.includes('shadow-[inset_0_1px_0_var(--glass-edge)'))
    if (!el) return { missing: true, tried: 'glass-card selector' }
    const cs = getComputedStyle(el)
    return { tag: '中间栏卡片', cls: el.className.slice(0, 120), bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow.slice(0, 110) }
  })()`)
  console.log(JSON.stringify(center))

  // 3) 右栏下段 DOM 嵌套层级（从下段卡到番茄钟按钮的链路）
  const chain = await evalJs(`(() => {
    const btn = document.querySelector('[data-wb="pomoMain"]')
    if (!btn) return 'no pomoMain'
    const out = []
    let el = btn
    while (el && el !== document.body) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      out.push({
        tag: el.tagName.toLowerCase() + (el.dataset?.wb ? '[data-wb=' + el.dataset.wb + ']' : ''),
        cls: String(el.className || '').slice(0, 70),
        bg: cs.backgroundColor, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius,
        h: Math.round(r.height),
      })
      el = el.parentElement
    }
    return out
  })()`)
  console.log('=== 番茄钟按钮向上的 DOM 链（每层底色/边框/圆角/高度） ===')
  for (const c of chain) console.log(JSON.stringify(c))

  // 4) 右栏现存的按钮与图标清单（核对「中间这个图标」指哪个）
  const buttons = await evalJs(`[...document.querySelectorAll('[data-wb="rightPanel"] button')].map((b) => ({
    title: b.getAttribute('title') || '', text: (b.textContent || '').trim().slice(0, 12),
    wb: b.dataset.wb || '', svg: !!b.querySelector('svg'), box: Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height),
  }))`)
  console.log('=== 右栏现存按钮清单 ===')
  for (const b of buttons) console.log(JSON.stringify(b))
  process.exit(0)
}
main().catch((e) => { console.error('探查探针失败:', e.message); process.exit(2) })
