/**
 * B-11 取证探针：鼠标点击「滚动容器」会不会给它画聚焦框？（2026-09-22）
 *
 * 要回答的问题（B-11 主推定位 A 的判据）：
 *   点击滚动宿主空白处后，宿主是否成为 activeElement、是否命中 :focus-visible、
 *   以及 computed outline 是什么样式 —— **虚线 or 实线** 这个 B-11 的「待确认」项即由此定案，
 *   不必再回问用户「你看到的虚线还是实线」。
 *
 * 为什么不能只看 CSS：全仓（含上游 pdf_viewer.css）**没有任何 dashed 的 outline/border** 落在页面边缘
 *   （已 grep：`src/**` 里 dashed 全是拖拽提示框 / 树引导线；上游只有 altTextDialog 内部有 focus-ring）。
 *   → 若确有虚线，只能来自 **UA 默认焦点环**（不在任何样式表里，`outline: auto`），
 *     即「滚动容器可获得焦点」这条 Chromium 行为。本探针就是去证伪/证实它。
 *
 * 手法要点：**必须用 CDP Input 派真鼠标事件**（`Runtime.evaluate` 里 el.click() 不移动焦点，
 *   会得到「无焦点」的假阴性）；坐标用 getBoundingClientRect 的视口坐标。
 *
 * 用法（必须先 electron-vite build）：
 *   KNOWBASE_PROBE_PORT=9333 node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b11-scroll-focus.mjs
 * 零副作用：只读 + 点击，不写任何设置 / 模块数据。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = join(process.cwd(), 'tmp', 'probe-shots')

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* electron 未起，继续等 */ }
    await sleep(500)
  }
  throw new Error('CDP page target 未出现')
}

let ws
let msgId = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}
async function shot(name) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOT_DIR, name + '.png'), Buffer.from(r.data, 'base64'))
  } catch { /* 尽力 */ }
}
/** CDP 真鼠标点击（合成 click() 不会移动焦点 → 假阴性） */
async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
}

/** 扫描可滚动宿主（overflow auto/scroll 且真的能滚，且可见） */
const JS_HOSTS = `(() => {
  const out = []
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    if (!/(auto|scroll)/.test(cs.overflowY)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 120 || r.height < 120) continue
    if (el.scrollHeight <= el.clientHeight + 8 && el.scrollWidth <= el.clientWidth + 8) continue
    out.push({
      cls: (el.className || '').toString().slice(0, 70),
      tag: el.tagName,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      scrollH: el.scrollHeight, clientH: el.clientHeight,
      kbPdf: el.classList.contains('kb-pdf-scroll'),
    })
  }
  return out
})()`

/** 焦点环取证：谁拿到焦点 + outline 三件套 + :focus-visible */
const JS_FOCUS = `(() => {
  const a = document.activeElement
  if (!a || a === document.body) return { none: true, active: a ? a.tagName : null }
  const cs = getComputedStyle(a)
  return {
    none: false,
    tag: a.tagName,
    cls: (a.className || '').toString().slice(0, 70),
    isPdfScroll: a.classList.contains('kb-pdf-scroll'),
    focus: a.matches(':focus'),
    focusVisible: a.matches(':focus-visible'),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
    outlineOffset: cs.outlineOffset,
    boxShadow: cs.boxShadow.slice(0, 60),
  }
})()`

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')

  for (let i = 0; i < 30; i++) {
    const n = await evalJs(`document.querySelector('#root')?.children.length ?? 0`)
    if (n > 0) break
    await sleep(500)
  }
  await evalJs(`(() => {
    const txt = document.body.textContent || ''
    if (!txt.includes('选择要进入的仓库')) return 'no-picker'
    const pick = (label) => {
      const c = [...document.querySelectorAll('button,a,div,span')].filter(el => (el.textContent || '').trim() === label)
      const t = c.find(el => el.tagName === 'BUTTON') || c[c.length - 1]
      if (t) t.click(); return !!t
    }
    pick('跳过，直接进入上次使用的仓库'); return 'skip'
  })()`)
  await sleep(1500)

  const hosts = await evalJs(JS_HOSTS)
  console.log('\n=== 候选滚动宿主（可见且真能滚），共', hosts.length, '个 ===')
  for (const h of hosts.slice(0, 8)) console.log(`  ${h.tag}.${h.cls}  ${h.w}x${h.h} scrollH=${h.scrollH}/${h.clientH}${h.kbPdf ? '  ← kb-pdf-scroll' : ''}`)
  if (hosts.length === 0) {
    // 诊断：为什么一个都没扫到（是没滚动容器、还是当前根本不在工作台）
    const diag = await evalJs(`(() => {
      const all = [...document.querySelectorAll('*')]
      const scrollable = all.filter(el => /(auto|scroll)/.test(getComputedStyle(el).overflowY))
      return {
        total: all.length,
        overflowCount: scrollable.length,
        picker: !!document.querySelector('.vault-picker-step'),
        onboarding: !!document.querySelector('.onboarding-step'),
        textHead: (document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 160),
        sample: scrollable.slice(0, 6).map(el => {
          const r = el.getBoundingClientRect()
          return { cls: (el.className || '').toString().slice(0, 50), w: Math.round(r.width), h: Math.round(r.height), sh: el.scrollHeight, ch: el.clientHeight }
        }),
      }
    })()`)
    console.log('[诊断]', JSON.stringify(diag, null, 1))
  }

  const results = []
  for (const h of hosts.slice(0, 6)) {
    await evalJs(`(() => { document.activeElement?.blur?.(); return true })()`)
    await sleep(150)
    const before = await evalJs(JS_FOCUS)
    await realClick(h.x, h.y)
    await sleep(350)
    const after = await evalJs(JS_FOCUS)
    const gotFocus = !after.none && after.cls === h.cls
    results.push({ host: h, before, after, gotFocus })
    console.log(`\n--- 点 ${h.tag}.${h.cls} @(${h.x},${h.y})`)
    console.log(`   before: ${before.none ? '无焦点(doc)' : before.tag + '.' + before.cls}`)
    console.log(`   after : ${after.none ? '无焦点(doc)' : `${after.tag}.${after.cls} | :focus=${after.focus} :focus-visible=${after.focusVisible} | outline=${after.outlineStyle} ${after.outlineWidth} ${after.outlineColor} offset=${after.outlineOffset} | shadow=${after.boxShadow}`}`)
  }
  await shot('b11-after-click-scroll-host')

  // 对照：键盘 Tab 进来的滚动宿主是否 :focus-visible（若「点=可见环、Tab=不可见环」那就是反的，需一并报）
  await evalJs(`(() => { document.activeElement?.blur?.(); return true })()`)
  for (let i = 0; i < 6; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await sleep(150)
    const f = await evalJs(JS_FOCUS)
    if (!f.none && f.focusVisible) {
      console.log(`\n[对照] Tab 第 ${i + 1} 次落到 ${f.tag}.${f.cls} | :focus-visible=${f.focusVisible} outline=${f.outlineStyle} ${f.outlineWidth}`)
      break
    }
    if (i === 5) console.log('\n[对照] Tab 6 次未落到带 :focus-visible 的元素')
  }

  // ── 合成对照宿主（关键一步）────────────────────────────────────────
  // 应用内不一定有「内容长到溢出」的滚动容器（当前仓库只有几个笔记，4 个 overflow 元素全是 sh==ch）。
  // 于是注入一个**最小可滚 div**（overflow-y:auto + 内容两倍高），用真鼠标点它 ——
  // 这直接回答「这个 Electron/Chromium 版本里，点滚动容器会不会给它画焦点环、是什么样式」，
  // 与具体是哪个模块无关（`.kb-pdf-scroll` 就是同一种 `overflow:auto` 的 div）。
  await evalJs(`(() => {
    const d = document.createElement('div')
    d.id = '__b11_probe'
    d.style.cssText = 'position:fixed;left:40px;top:80px;width:220px;height:240px;overflow-y:auto;z-index:2147483000;background:#0b3d91;color:#fff'
    d.innerHTML = '<div style="height:900px">probe scroll host</div>'
    // 插到 body 首位 → 令其成为**第一个 Tab 停留点**（否则要按几十次 Tab 才轮到它）
    document.body.insertBefore(d, document.body.firstChild)
    return true
  })()`)
  await sleep(250)
  const synthRect = await evalJs(`(() => { const r = document.getElementById('__b11_probe').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  const readActive = `(() => {
    const a = document.activeElement
    const cs = a ? getComputedStyle(a) : null
    const p = document.getElementById('__b11_probe')
    return {
      active: a?.id === '__b11_probe' ? '__b11_probe' : (a?.tagName || '') + '.' + ((a?.className || '').toString().slice(0, 34)),
      isSynth: a?.id === '__b11_probe',
      focus: !!a?.matches?.(':focus'), focusVisible: !!a?.matches?.(':focus-visible'),
      outlineStyle: cs?.outlineStyle, outlineWidth: cs?.outlineWidth, outlineColor: cs?.outlineColor,
      outlineOffset: cs?.outlineOffset,
      scrolled: p ? p.scrollTop : -1,
      canScroll: p ? p.scrollHeight > p.clientHeight : false,
    }
  })()`
  const tabOnce = async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await sleep(220)
    return await evalJs(readActive)
  }

  // (1) 鼠标点击：是否把焦点给滚动宿主（上一轮已知：否）
  await evalJs(`(() => { document.activeElement?.blur?.(); document.getElementById('__b11_probe').scrollTop = 0; return true })()`)
  await sleep(150)
  await realClick(synthRect.x, synthRect.y)
  await sleep(300)
  const clickRes = await evalJs(readActive)
  await shot('b11-synth-after-mouse-click')

  // (2) ★ 键盘：点击后再按 PageDown / 方向键（用户「在读 PDF 时用键盘滚动」的真实路径）
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 })
  await sleep(300)
  const pageDownRes = await evalJs(readActive)
  await shot('b11-synth-after-pagedown')

  // (3) ★ Tab 是否把滚动容器当停留点（Chromium 127+ 让滚动容器可键盘聚焦）
  await evalJs(`(() => { document.activeElement?.blur?.(); document.getElementById('__b11_probe').scrollTop = 0; return true })()`)
  await sleep(150)
  let tabRes = null
  for (let i = 0; i < 3; i++) {
    tabRes = await tabOnce()
    if (tabRes.isSynth) break
  }
  await shot('b11-synth-after-tab')

  console.log('\n[合成对照] 点击      →', JSON.stringify(clickRes))
  console.log('[合成对照] 点击+PageDown →', JSON.stringify(pageDownRes))
  console.log('[合成对照] Tab       →', JSON.stringify(tabRes))
  await evalJs(`(() => { document.getElementById('__b11_probe')?.remove(); return true })()`)

  const clicked = results.filter((r) => r.gotFocus)
  console.log('\n===== B-11 取证结论 =====')
  console.log(`合成滚动宿主：点击后焦点=${clickRes.isSynth} | PageDown 后焦点=${pageDownRes.isSynth} 滚动量=${pageDownRes.scrolled} | Tab 后焦点=${tabRes?.isSynth}`)
  for (const [k, r] of [['点击', clickRes], ['点击+PageDown', pageDownRes], ['Tab', tabRes]]) {
    if (r && r.isSynth) console.log(`  · ${k}：:focus-visible=${r.focusVisible} outline=${r.outlineStyle} ${r.outlineWidth} ${r.outlineColor} offset=${r.outlineOffset}`)
  }
  console.log(`被点击后拿到焦点的滚动宿主：${clicked.length}/${results.length}`)
  for (const r of clicked) {
    console.log(`  · ${r.host.tag}.${r.host.cls} → :focus-visible=${r.after.focusVisible} outline=${r.after.outlineStyle} ${r.after.outlineWidth} ${r.after.outlineColor}`)
  }
  console.log(`kb-pdf-scroll 是否在场：${results.some((r) => r.host.kbPdf) ? '在' : '不在（未打开 PDF 阅读器）'}`)
  process.exit(0)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
