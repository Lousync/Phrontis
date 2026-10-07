/**
 * B-11 第六轮取证：直接动真的那条规则（CSSOM），并上品红鉴别（2026-09-22）
 *
 * 第四、五轮的硬结论：
 *   · 复现成立：竖条 = 物理 x=497..502（CSS 331.3..334.7，页面左缘 331）、y 物理 159..275
 *     （CSS 106..183）。
 *   · **颜色对得上**：把页面底色 F7F7F3 与本应用的 `rgba(0,120,255,.35)` 做 0.35 叠加、
 *     再走护眼滤镜 sepia(.32) brightness(.97) saturate(.92) 的近似 → (191,212,227)，
 *     实测浅带 #C4D5E2=(196,213,226)；叠两层 → (142,181,219)，实测深带 #90B4D6=(144,180,214)。
 *     ⇒ 上色用的**就是** `.kb-pdf-scope .pdfViewer .textLayer ::selection { rgba(0,120,255,.35) }`。
 *   · `br{visibility:hidden}`（T5）→ 竖条消失（0 个蓝像素）⇒ 竖条长在 br 的行盒上。
 *   · 但**注入** `br::selection{background:transparent!important}`（T1）与
 *     `.textLayer ::selection{background:transparent!important}`（T2）都**没能**去掉它。
 *     注入的 <style> 在 head 末尾、特异度不低于、还带 !important —— 理论上必胜，却没生效。
 *
 * 所以本轮两手：
 *   A) 不再注入覆盖，直接经 CSSOM **删掉那条真规则**（`deleteRule`），看竖条是否消失，
 *      再 `insertRule` 放回去，看是否复现 —— 排除「覆盖没生效」的一切借口。
 *   B) 品红鉴别：把 br 的 ::selection 改成 `magenta !important`、
 *      再把 `*::selection` 改成品红 —— 若竖条不变色，说明这条高亮**根本不是按 ::selection 上色的**。
 *
 * 补丁序列（每步一张图）：
 *   P0 基线
 *   P1 CSSOM 删除 `.textLayer ::selection{rgba(0,120,255,.35)}` → 预期竖条消失
 *   P2 CSSOM 放回该规则                                → 预期竖条回来
 *   P3 注入 `*::selection{background:magenta !important}` → 竖条若变品红 = 受 ::selection 管辖
 *   P4 注入 `br::selection{background:magenta !important}` → 同上，且定位到 br
 *   P5 移除注入、改 `br{user-select:none !important}`    → 候选修法（需另议是否影响换行复制）
 *
 * 用法：
 *   KNOWBASE_PROBE_PORT=9333 KNOWBASE_PROBE_VAULT=演示 node \
 *     .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b11-cssom.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const EXPECT_VAULT = process.env.KNOWBASE_PROBE_VAULT ?? '演示'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = join(process.cwd(), 'tmp', 'probe-shots')

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
      const page = (await res.json()).find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* electron 未起 */ }
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
    return 'tmp/probe-shots/' + name + '.png'
  } catch (e) { return 'shot 失败 ' + e.message }
}
async function realDrag(x1, y1, x2, y2) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 1 })
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: Math.round(x1 + (x2 - x1) * i / steps), y: Math.round(y1 + (y2 - y1) * i / steps),
    })
    await sleep(35)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(400)
}

const setStyle = (id, css) => `(() => {
  document.getElementById('${id}')?.remove()
  ${css ? `const s = document.createElement('style'); s.id = '${id}'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s)` : ''}
  return !!document.getElementById('${id}')
})()`

/** 经 CSSOM 找那条真规则（按颜色文本匹配，避免误伤自己注入的测试样式） */
const JS_FIND = `(() => {
  const hits = []
  for (let si = 0; si < document.styleSheets.length; si++) {
    const ss = document.styleSheets[si]
    let rules; try { rules = ss.cssRules } catch (e) { continue }
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]
      if (r.selectorText && r.style && /rgba\\(0,\\s*120,\\s*255,\\s*0\\.35\\)/.test(r.style.cssText || '')) {
        hits.push({ si, i, sel: r.selectorText, css: r.cssText,
                    href: ss.href || (ss.ownerNode && ss.ownerNode.id) || '(inline style tag)' })
      }
    }
  }
  return hits
})()`

/** 删/放回：按上面找到的位置操作 */
const JS_DELETE = `(() => {
  for (const ss of document.styleSheets) {
    let rules; try { rules = ss.cssRules } catch (e) { continue }
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]
      if (r.selectorText && r.style && /rgba\\(0,\\s*120,\\s*255,\\s*0\\.35\\)/.test(r.style.cssText || '')) {
        const css = r.cssText
        window.__b11saved = { css, ss, i }
        ss.deleteRule(i)
        return { deleted: r.selectorText, at: i }
      }
    }
  }
  return { deleted: null }
})()`

const JS_RESTORE = `(() => {
  const s = window.__b11saved
  if (!s) return { restored: false }
  s.ss.insertRule(s.css, s.i)
  return { restored: true, css: s.css.slice(0, 120) }
})()`

/** 当前竖条该有的“计算色”：br / textLayer 的 ::selection */
const JS_SELBG = `(() => {
  const layer = document.querySelector('.kb-pdf-scope .textLayer')
  const br = layer && layer.querySelector('br')
  const span = layer && layer.querySelector('span')
  const g = (el) => { try { return getComputedStyle(el, '::selection').backgroundColor } catch (e) { return 'throw' } }
  return { br: g(br), span: g(span), layer: g(layer), styleTags: [...document.querySelectorAll('style[id^=b11]')].map(s => s.id) }
})()`

async function step(tag, name, extra = '') {
  await sleep(650)
  const c = await evalJs(JS_SELBG)
  console.log(`\n===== ${tag} =====`)
  if (extra) console.log('  ' + extra)
  console.log('  ::selection 计算色  br=' + c.br + '  span=' + c.span + '  textLayer=' + c.layer)
  console.log('  截图:', await shot(name))
}

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    }
  }
  await send('Runtime.enable'); await send('Page.enable')
  for (let i = 0; i < 30; i++) {
    const n = await evalJs(`document.querySelector('#root')?.children.length ?? 0`)
    if (n > 0) break
    await sleep(500)
  }
  await evalJs(`(() => {
    const txt = document.body.textContent || ''
    if (!txt.includes('选择要进入的仓库')) return 'no-picker'
    const c = [...document.querySelectorAll('button,a,div,span')].filter(el => (el.textContent || '').trim() === '跳过，直接进入上次使用的仓库')
    const t = c.find(el => el.tagName === 'BUTTON') || c[c.length - 1]
    if (t) t.click(); return 'skip'
  })()`)
  await sleep(1500)
  const vaultName = await evalJs(`(async () => { try { const c = await window.api.workspaceGetCurrent(); return c?.name ?? null } catch { return null } })()`)
  console.log('[实例自证] vault =', vaultName)
  if (vaultName !== EXPECT_VAULT) { console.error('不是目标仓库 → 终止'); process.exit(3) }

  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="bookshelf"]')?.click(); return true })()`)
  await sleep(1500)
  const picked = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('main button')].filter(b => (b.getAttribute('title') || '').toLowerCase().endsWith('.pdf'))
    const card = cards.find(b => /Reader Sample|样书|Sample/i.test(b.getAttribute('title') || '')) || cards[0]
    if (!card) return { ok: false }
    card.click(); return { ok: true, title: card.getAttribute('title') }
  })()`)
  console.log('[打开样书]', JSON.stringify(picked))
  if (!picked?.ok) process.exit(3)
  let spans = 0
  for (let i = 0; i < 40; i++) {
    spans = await evalJs(`document.querySelectorAll('.kb-pdf-scope .textLayer span').length`).catch(() => 0)
    if (spans > 30) break
    await sleep(800)
  }
  console.log('[文本层] span =', spans)
  await sleep(1200)

  console.log('\n[规则清点] 含 rgba(0,120,255,0.35) 的规则：')
  for (const h of await evalJs(JS_FIND)) console.log('   ·', h.sel, ' @', h.href, ' #' + h.i)

  const geo = await evalJs(`(() => {
    const page = document.querySelector('.kb-pdf-scope .pdfViewer .page')
    const pr = page.getBoundingClientRect()
    const lines = [...document.querySelectorAll('.kb-pdf-scope .textLayer span')]
      .filter(el => (el.textContent || '').trim().length > 12)
      .map(el => { const r = el.getBoundingClientRect()
        return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), cy: Math.round(r.top + r.height / 2) } })
      .filter(v => v.cy > 0 && v.cy < window.innerHeight)
    return { pageLeft: Math.round(pr.left), pageTop: Math.round(pr.top), lines: lines.slice(0, 12) }
  })()`)
  console.log('[几何] 页面 left', geo.pageLeft, 'top', geo.pageTop)
  const L = geo.lines
  if (L.length < 6) { console.error('正文行不足'); process.exit(3) }

  await evalJs(`(() => { document.getSelection()?.removeAllRanges(); return true })()`)
  await realDrag(L[0].l + 2, L[0].cy, L[4].r - 2, L[4].cy)
  console.log('[选区]', JSON.stringify(await evalJs(`String(document.getSelection()||'').slice(0,40)`)))

  await step('P0 基线', 'b11p6-P0')

  console.log('\n[P1] CSSOM 删除真规则 →', JSON.stringify(await evalJs(JS_DELETE)))
  await step('P1 已删除 .textLayer ::selection{rgba(0,120,255,.35)}', 'b11p6-P1')

  console.log('\n[P2] CSSOM 放回该规则 →', JSON.stringify(await evalJs(JS_RESTORE)))
  await step('P2 规则已放回（应同 P0）', 'b11p6-P2')

  await evalJs(setStyle('b11-p', '*::selection{background:magenta !important}'))
  await step('P3 注入 `*::selection{magenta!important}`', 'b11p6-P3')

  await evalJs(setStyle('b11-p', '.kb-pdf-scope .pdfViewer .textLayer br::selection{background:magenta !important}'))
  await step('P4 注入 `br::selection{magenta!important}`', 'b11p6-P4')

  await evalJs(setStyle('b11-p', '.kb-pdf-scope .pdfViewer .textLayer br{user-select:none !important}'))
  await step('P5 注入 `br{user-select:none!important}`（候选修法）', 'b11p6-P5')

  await evalJs(setStyle('b11-p', ''))
  await step('P6 清空补丁（应同 P0）', 'b11p6-P6')

  console.log('\n[提示] 图片交 E:/tmp/scan-b11-p6.ps1 逐像素比对（竖条带 + 正文带各自计数）。')
  console.log('===== 探针结束 =====')
  process.exit(0)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
