/**
 * 一次性探针：用无头 Edge + CDP 真实跑一遍桌面控件原型。
 *
 * 目的不是"看一眼"，而是拿到四样东西：
 *   1. 运行时异常 / console error —— 静态语法检查抓不到的那些；
 *   2. 关键 DOM 断言 —— 磁贴是否按 span 落位、圆点是不是真圆、热力图空格子是否可见；
 *   3. 内容适配量 —— 日程面板三档尺寸各自 scrollHeight vs clientHeight，用来定默认尺寸；
 *   4. 截图 —— 人眼要看的那部分。
 *
 * 依赖：只用 Node 22 内置的全局 WebSocket，不装任何包。
 * 用法：node --experimental-strip-types .AGENT/scripts/desktop/probes/probe-toolbar-prototype.mjs
 * 产物：tmp/probe-toolbar/*.png（gitignored）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9333 + Math.floor(Math.random() * 400)
const PAGE = 'file:///E:/Projects/KnowledgeRecorder/outputs/desk-toolbar-prototype.html'
const OUT = 'E:/Projects/KnowledgeRecorder/tmp/probe-toolbar'

if (!existsSync(EDGE)) { console.error('找不到 Edge：' + EDGE); process.exit(1) }
mkdirSync(OUT, { recursive: true })

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1400,1130',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + OUT.replace(/\//g, '\\') + '\\profile',
  PAGE,
], { stdio: 'ignore' })

let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(300)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const page = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) wsUrl = page.webSocketDebuggerUrl
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { child.kill(); console.error('CDP 没起来'); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let seq = 0
const pending = new Map()
const errors = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    errors.push('EXCEPTION: ' + (d.exception?.description || d.text))
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    errors.push(msg.params.type.toUpperCase() + ': ' + msg.params.args.map((a) => a.value ?? a.description).join(' '))
  }
}
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log('  截图 -> tmp/probe-toolbar/' + name + '.png')
}
/** 局部特写：整窗截图里磁贴只有几百像素高，细节全靠这个才看得出。
 *  ⚠️ getBoundingClientRect() 返回的**已经是** transform 之后的视觉坐标，
 *  再乘一次缩放系数会把裁切框缩小一半（右侧与底部被切掉）。直接用即可。
 *  extraBottom 用来把「挂在磁贴外的浮层」（如搜索下拉）也框进来。 */
const shotTile = async (name, key, pad = 10, extraBottom = 0) => {
  const r = await evaluate(`(() => {
    const el = document.querySelector('[data-tile="${key}"]').getBoundingClientRect();
    return { x: Math.max(0, el.left - ${pad}), y: Math.max(0, el.top - ${pad}),
      w: el.width + ${pad * 2}, h: el.height + ${pad * 2} + ${extraBottom} };
  })()`)
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h), scale: 2 } })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'))
  console.log(`  特写 ${key} -> tmp/probe-toolbar/${name}.png（2x）`)
}
/** 关掉搜索下拉再截图 —— 不然浮层会正好盖住工具条底部的模块坞 */
const closePop = async () => { await evaluate(`(() => { const i=document.getElementById('q'); i.value=''; i.dispatchEvent(new Event('input')); i.blur(); })()`); await sleep(260) }
/**
 * 解析 getComputedStyle 的颜色。必须同时认三种写法，否则会静默算出垃圾值：
 *   rgb(45, 45, 45)              —— 不透明
 *   rgba(45, 45, 45, 0.5)        —— 带 alpha
 *   color(srgb 0.42 0.42 0.42 / 0.24)  —— color-mix() 的结果（Chrome 走这条）
 * 返回值已把 srgb 分量换算到 0~255，并保留 alpha 供合成。
 */
function parseColor(s) {
  let m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/)
  if (m) return { c: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] }
  m = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/)
  if (m) return { c: [+m[1] * 255, +m[2] * 255, +m[3] * 255], a: m[4] === undefined ? 1 : +m[4] }
  return null
}
/** 把带 alpha 的前景色合成到背景上，得到"实际看到的颜色" */
function over(fg, bg) {
  return fg.c.map((v, i) => v * fg.a + bg.c[i] * (1 - fg.a))
}
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: PAGE })
await sleep(2200)

console.log('\n=== 1. 结构断言（暗色默认态） ===')
const probe = await evaluate(`(() => {
  const tiles = [...document.querySelectorAll('.desk-tile')].map(t => ({
    key: t.getAttribute('data-tile') || 'add',
    col: getComputedStyle(t).gridColumn,
    w: Math.round(t.getBoundingClientRect().width),
    h: Math.round(t.getBoundingClientRect().height),
  }));
  const dots = [...document.querySelectorAll('.hb-dot')].slice(0, 4).map(d => {
    const r = d.getBoundingClientRect();
    return { w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
  });
  const head = document.querySelector('[data-tile="toolbar"] .tile-head');
  // 工具条磁贴底部的模块坞：既要有按钮，也要真的有盒子高度 ——
  // 只数按钮不够，SVG 出来但容器塌成 0 高时按钮数照样是对的。
  const dockBtns = [...document.querySelectorAll('.dock .dock-btn')];
  const dockBox = document.querySelector('.dock');
  const dockSvg = dockBtns.map(b => b.querySelector('svg')).filter(Boolean);
  const dockRect = dockBox ? dockBox.getBoundingClientRect() : null;
  return {
    tiles, dots, scale: +getComputedStyle(document.getElementById('stage')).transform.split(',')[0].replace(/matrix\\(/,''),
    cells: document.querySelectorAll('.cal-cell[data-day]').length,
    wks: document.querySelectorAll('.cal-wk').length,
    cards: document.querySelectorAll('.db-card').length,
    toolbarHasHead: !!head,
    dock: { n: dockBtns.length, withSvg: dockSvg.length,
      h: dockRect ? Math.round(dockRect.height) : 0,
      lastBottom: dockBtns.length ? Math.round(dockBtns[dockBtns.length - 1].getBoundingClientRect().bottom) : 0,
      tileBottom: Math.round(document.querySelector('[data-tile="toolbar"]').getBoundingClientRect().bottom) },
  };
})()`)
for (const t of probe.tiles) console.log(`  磁贴 ${t.key.padEnd(9)} ${t.col.padEnd(18)} ${t.w}×${t.h}`)
console.log(`  日历可点日期 ${probe.cells} 个 / 周号列 ${probe.wks} 个 / 卡片 ${probe.cards} 张`)
console.log(`  缩放 ${probe.scale.toFixed(3)}｜打卡圆点 ${JSON.stringify(probe.dots)}（w 必须等于 h = 真圆）`)
console.log(`  工具条磁贴是否隐藏磁贴头 = ${!probe.toolbarHasHead}`)
const dk = probe.dock
const dockOverflow = dk.lastBottom - dk.tileBottom
console.log(`  模块坞 ${dk.n} 个按钮（带图标 ${dk.withSvg} 个）｜坞高 ${dk.h}px｜末按钮底 ${dk.lastBottom} vs 磁贴底 ${dk.tileBottom} → ` +
  (dk.n === 0 ? '⚠ 没渲染' : dk.h === 0 ? '⚠ 塌成 0 高' : dk.withSvg !== dk.n ? '⚠ 有按钮没画图标' : dockOverflow > 0 ? `⚠ 溢出磁贴 ${dockOverflow}px` : 'ok 全在磁贴内'))

/* 载体自检：原型窗口必须装得下整块栅格，否则截出来的是"被裁一半"，看着像设计崩了 */
const carrier = await evaluate(`(() => {
  const win = document.getElementById('win'), grid = document.getElementById('grid');
  const gb = grid.getBoundingClientRect(), wb = win.getBoundingClientRect();
  return { winH: Math.round(wb.height), gridBottom: Math.round(gb.bottom - wb.top), slack: Math.round(wb.bottom - gb.bottom), clipped: gb.bottom > wb.bottom };
})()`)
console.log(`  载体：窗口高 ${carrier.winH}，栅格底部 ${carrier.gridBottom}，余量 ${carrier.slack}px → ` +
  (carrier.clipped ? '⚠ 栅格被窗口裁掉，截图会像设计崩了' : 'ok 完整容得下'))

console.log('\n=== 2. 搜索下拉是否逃出磁贴裁切 ===')
await evaluate(`(() => { const i=document.getElementById('q'); i.focus(); i.value='数'; i.dispatchEvent(new Event('input')); })()`)
await sleep(350)
const pop = await evaluate(`(() => {
  const p = document.querySelector('.search-pop'), i = document.getElementById('q'), t = document.querySelector('[data-tile="toolbar"]');
  if (!p) return { open:false };
  const pr = p.getBoundingClientRect(), ir = i.getBoundingClientRect(), tr = t.getBoundingClientRect();
  return { open: p.classList.contains('is-open'), rows: p.querySelectorAll('.search-row').length,
    gap: Math.round(pr.top - ir.bottom), wMatch: Math.round(pr.width) === Math.round(ir.width),
    parent: p.parentElement.id, escapesTile: pr.bottom > tr.top };
})()`)
console.log('  ' + JSON.stringify(pop))
console.log('  容器 #' + pop.parent + ' → ' + (pop.parent === 'stage' ? '不在磁贴内，不会被 overflow:hidden 裁掉' : '⚠ 仍在磁贴内'))
console.log('  下拉到输入框间距 ' + pop.gap + 'px（期望 6）｜宽度一致 = ' + pop.wMatch + '｜命中 ' + pop.rows + ' 行')

console.log('\n=== 3. 打卡交互：点一下圆点，进度填充与计数是否重算 ===')
const hbBefore = await evaluate(`(() => { const r = document.querySelectorAll('.hb-row')[0];
  return { fill: r.querySelector('.hb-fill').style.width, cnt: r.querySelector('.hb-cnt').textContent }; })()`)
// 进度条的形态必须锁死：细线贴底，不能是整行高的色块。
// 整行高色块在 60% 时右边缘正好切在文字上，读起来像「文字被选中」—— 这正是旧版的毛病。
const hbShape = await evaluate(`(() => {
  const r = document.querySelectorAll('.hb-row')[0];
  const f = r.querySelector('.hb-fill').getBoundingClientRect();
  const t = r.querySelector('.hb-track').getBoundingClientRect();
  const rb = r.getBoundingClientRect();
  return { h: +f.height.toFixed(2), trackH: +t.height.toFixed(2),
    fillBottomGap: +(rb.bottom - f.bottom).toFixed(2), rowH: +rb.height.toFixed(2) };
})()`)
console.log(`  形态：行高 ${hbShape.rowH}｜轨道高 ${hbShape.trackH}｜填充高 ${hbShape.h}｜填充底距行底 ${hbShape.fillBottomGap}px → ` +
  (hbShape.h <= 4 && hbShape.fillBottomGap <= 5 ? 'ok 细线贴底（不是整行色块）' : '⚠ 又变回整行色块了，会像文字被选中'))
await evaluate(`document.querySelectorAll('.hb-dot')[0].click()`)
await sleep(320)
const hbAfter = await evaluate(`(() => { const r = document.querySelectorAll('.hb-row')[0];
  return { fill: r.querySelector('.hb-fill').style.width, cnt: r.querySelector('.hb-cnt').textContent }; })()`)
console.log('  点前 ' + JSON.stringify(hbBefore) + ' → 点后 ' + JSON.stringify(hbAfter))
console.log('  ' + (hbBefore.cnt !== hbAfter.cnt ? 'ok 进度与计数同步重算' : '⚠ 点了没反应'))
await evaluate(`document.querySelectorAll('.hb-dot')[0].click()`)
await sleep(250)

console.log('\n=== 4. 日程面板三档尺寸：内容装得下吗（决定默认尺寸的依据） ===')
for (const [btn, label] of [['btn-db-25', '2×5'], ['btn-db-36', '3×6'], ['btn-db-46', '4×6']]) {
  await evaluate(`document.getElementById('${btn}').click()`)
  await sleep(420)
  const m = await evaluate(`(() => {
    const scroll = document.querySelector('.db-scroll');
    const tile = document.querySelector('[data-tile="daybook"]');
    const cards = [...document.querySelectorAll('.db-card')].map(c => Math.round(c.getBoundingClientRect().height));
    const last = document.querySelectorAll('.db-card')[3].getBoundingClientRect();
    return { tileW: Math.round(tile.getBoundingClientRect().width), tileH: Math.round(tile.getBoundingClientRect().height),
      scrollH: scroll.scrollHeight, clientH: scroll.clientHeight, overflow: scroll.scrollHeight - scroll.clientHeight,
      cards, lastCut: last.bottom > tile.getBoundingClientRect().bottom };
  })()`)
  console.log(`  ${label}: 磁贴 ${m.tileW}×${m.tileH}｜内容 ${m.scrollH} vs 可视 ${m.clientH} → 溢出 ${m.overflow}px` +
    `｜卡片高 [${m.cards.join(', ')}]｜最后一张被切 = ${m.lastCut}`)
}

console.log('\n=== 5. 卡片层与热力图空格子在两种主题下是否读得出（合成后的实际色差） ===')
const contrast = async (label) => {
  const c = await evaluate(`(() => {
    const tile = document.querySelector('[data-tile="daybook"]');
    const card = document.querySelector('.db-card');
    const empty = document.querySelector('[data-tile="heat"] .tile-body span');
    const cs = getComputedStyle(card);
    return { tile: getComputedStyle(tile).backgroundColor, card: cs.backgroundColor,
      border: cs.borderTopColor, empty: getComputedStyle(empty).backgroundColor };
  })()`)
  const t = parseColor(c.tile), card = parseColor(c.card), empty = parseColor(c.empty)
  const bd = parseColor(c.border)
  if (!t || !card || !empty) { console.log(`  ${label}: 解析失败`); return }
  // shown() 要同时吃得下「通道数组」和 parseColor 的 {c,a} 两种形状：
  // over() 返回的是纯数组，而磁贴底色 t 是 {c,a} 包装对象，混着传会 TypeError。
  const shown = (x) => '#' + (Array.isArray(x) ? x : x.c).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  const cardReal = over(card, t), emptyReal = over(empty, t)
  const tileRgb = t.c
  const dCard = lum(cardReal) - lum(tileRgb)    // 有符号：正 = 卡片更亮 = 浮起
  const dEmpty = Math.abs(lum(emptyReal) - lum(tileRgb))
  // 「卡片自成一层」的判据不能只看填充亮度：亮色主题磁贴底已是 #f9f9f9，
  // 往上的亮度空间天然只有 6 个点，靠填充永远"读不出"。
  // 真正的边界信号是描边 —— 填充差 ≥8 或 描边差 ≥15，满足其一即可。
  const dBorder = bd ? Math.abs(lum(bd.c) - lum(tileRgb)) : 0
  const okCard = Math.abs(dCard) >= 8 || dBorder >= 15
  console.log(`  ${label}: 磁贴底 ${shown(t)}`)
  console.log(`         卡片底 ${shown(cardReal)} → ${dCard >= 0 ? '比磁贴亮' : '比磁贴暗'} ${Math.abs(dCard).toFixed(1)}｜描边 ${shown(bd)} 差 ${dBorder.toFixed(1)} → ` +
    (okCard ? `ok 分得出是一层（${Math.abs(dCard) >= 8 ? '靠填充' : '靠描边'}）` : '⚠ 与磁贴糊在一起'))
  console.log(`         热力图空格 ${shown(emptyReal)} → 亮度差 ${dEmpty.toFixed(1)} ` + (dEmpty >= 8 ? 'ok 看得见' : '⚠ 同色，格看不见'))
  return { dCard, dEmpty, dBorder }
}
await contrast('dark ')
await evaluate(`document.getElementById('btn-theme').click()`); await sleep(350)
await contrast('light')
await evaluate(`document.getElementById('btn-theme').click()`); await sleep(350)

console.log('\n=== 6. 截图 ===')
await closePop()
await evaluate(`document.getElementById('btn-db-25').click()`); await sleep(400)
await shot('01-dark-2x5')
await evaluate(`document.getElementById('btn-db-36').click()`); await sleep(450)
await shot('02-dark-3x6')
await shotTile('02b-dark-toolbar', 'toolbar')
await shotTile('02c-dark-daybook', 'daybook')
await evaluate(`document.getElementById('btn-theme').click()`); await sleep(400)
await shot('03-light-3x6')
await shotTile('03b-light-toolbar', 'toolbar')
await shotTile('03c-light-daybook', 'daybook')
await evaluate(`document.getElementById('btn-theme').click()`); await sleep(320)
await evaluate(`document.getElementById('btn-tw-4').click()`); await sleep(420)
await shot('04-dark-toolbar-4col')
await evaluate(`document.getElementById('btn-tw-full').click()`); await sleep(400)
// 搜索下拉展开态：单独来一张，因为它是浮层、会盖住模块坞
await evaluate(`(() => { const i=document.getElementById('q'); i.focus(); i.value='数'; i.dispatchEvent(new Event('input')); })()`)
await sleep(380)
await shotTile('06-search-pop', 'toolbar', 26, 150)
await closePop()
await evaluate(`document.getElementById('notes-head').click()`); await sleep(300)
const notes = await evaluate(`(() => { const b = document.getElementById('notes-body');
  return { shown: b.style.display !== 'none', h: Math.round(b.getBoundingClientRect().height), scrollH: b.scrollHeight }; })()`)
console.log('  说明面板展开后高 ' + notes.h + 'px，内容 ' + notes.scrollH + 'px → ' + (notes.scrollH > notes.h ? '内部滚动（不再遮住设计）' : '一屏放完'))
await sleep(200)
await shot('05-dark-notes-open')

console.log('\n=== 7. 运行时错误 ===')
if (errors.length === 0) console.log('  无异常、无 console error ✅')
else errors.forEach((e) => console.log('  ' + e))

ws.close(); child.kill(); await sleep(300)
console.log('\n完成。')
