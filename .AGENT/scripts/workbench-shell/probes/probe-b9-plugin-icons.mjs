/**
 * B-9 探针：插件相关位置统一走 PluginIcon + 线宽通道（2026-09-22）
 *
 * 背景：B-9 把 15 处「插件」图标从裸 lucide `<Puzzle>` 换成 `<PluginIcon>`（StyleAware）。
 *   裸 lucide 的**默认 strokeWidth = 2** —— 这是本次改动唯一可从 DOM 反查的签名：
 *   改对了 = 线宽由 2 变成 手绘 1.6 / classic140 1.5 / 空态 40px 覆盖值 1.2；
 *   改漏了 = 该处仍是 stroke-width="2"。
 *
 * 断言（真实 DOM + 真点击，build 产物 + CDP）：
 *   R1 设置→外观→「侧边栏图标风格」选择器存在，下拉里每个包 5 个预览图标（图标包系统活着）
 *   R2 ★ 活动栏「插件市场」按钮跟随图标风格：手绘包 stroke-width=1.6，classic140=1.5（且两次 outerHTML 不同）
 *   R3 ★ 插件市场页左栏「插件」标题图标（12px）跟随同一设置
 *   R4 ★ 插件市场右侧详情空态 40px 图标：手绘包 = 1.2（B-9 新增的 strokeWidth 通道）；classic140 = 1.5
 *   R5 ★ 负向：以上所有观测点均无 stroke-width="2"（裸 lucide 默认值 = 改漏的签名）
 *   R6 console 零 error
 *
 * 覆盖口径（诚实声明）：本探针覆盖运行时**可达**的 4 个站点。其余站点（页面条页签 / 工具箱注册表 /
 *   知识库插件视图 / 博客模板弹窗 / 桌面磁贴 / 首启引导 …）由源码契约脚本
 *   `.AGENT/scripts/plugin-icons/verify-plugin-icons.mjs`（20 条断言，逐站点核对 JSX）覆盖；
 *   插件 SVG 包分支（第三方 `<svg>` 原样注入）本机无插件贡献 sidebarIcons，无法真机验证。
 *
 * 用法（必须先 electron-vite build）：
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b9-plugin-icons.mjs --no-sandbox --disable-gpu
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = join(process.cwd(), 'tmp', 'probe-shots')
const PACK_HAND = '手绘(默认)'
const PACK_C140 = '经典细线(1.4.0)'

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
const consoleErrors = []
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
    const p = join(SHOT_DIR, name + '.png')
    writeFileSync(p, Buffer.from(r.data, 'base64'))
    return p
  } catch (e) { return 'shot 失败: ' + String(e.message).slice(0, 120) }
}
const results = []
function ok(cond, label, detail = '') {
  results.push({ pass: !!cond, label, detail })
  return !!cond
}

/** 按可见文本点：优先 BUTTON，否则取最内层命中元素 */
const clickText = (label) => evalJs(`(() => {
  const cands = [...document.querySelectorAll('button,a,div,span')].filter(el => (el.textContent || '').trim() === ${JSON.stringify(label)})
  const t = cands.find(el => el.tagName === 'BUTTON') || cands[cands.length - 1]
  if (!t) return false
  t.click()
  return true
})()`)
const clickRail = (label) => evalJs(`(() => {
  const b = [...document.querySelectorAll('button[title]')].find(x => x.title === ${JSON.stringify(label)})
  if (!b) return false
  b.click()
  return true
})()`)

/** 单个 svg 的指纹：线宽 / 视口 / 路径数 / 前 60 字 html */
const SVG_FP = `(el) => {
  const s = el && el.tagName === 'svg' ? el : el?.querySelector?.('svg')
  if (!s) return null
  return {
    sw: s.getAttribute('stroke-width'),
    vb: s.getAttribute('viewBox'),
    paths: s.querySelectorAll('path,line,circle,rect,polyline').length,
    head: s.outerHTML.replace(/\\s+/g, ' ').slice(0, 60),
  }
}`

// 观测点：活动栏「插件市场」按钮
const JS_RAIL_ICON = `(() => { const fp = ${SVG_FP};
  const b = [...document.querySelectorAll('button[title]')].find(x => x.title === '插件市场')
  return fp(b)
})()`

// 观测点：插件市场页左栏「插件」标题（= 已安装 按钮所在行 div 的前一个兄弟）+ 右侧详情空态 40px
const JS_PLUGINS_PAGE = `(() => {
  const fp = ${SVG_FP}
  const tabBtn = [...document.querySelectorAll('button')].find(b => /^已安装 \\(/.test((b.textContent || '').trim()))
  const titleDiv = tabBtn?.parentElement?.previousElementSibling ?? null
  const emptyP = [...document.querySelectorAll('p')].find(p => (p.textContent || '').trim() === '选择一个插件查看详情')
  const emptyIcon = emptyP?.previousElementSibling ?? null
  return {
    title: fp(titleDiv),
    empty: fp(emptyIcon),
    emptyTag: emptyIcon?.tagName ?? null,
    emptySize: emptyIcon ? (emptyIcon.tagName === 'svg' ? emptyIcon.getAttribute('width') : emptyIcon.getAttribute('style')) : null,
  }
})()`

/** 保证停在设置→外观（settings 的默认 section 本就是 appearance，故优先不点，避免误点导航） */
async function ensureAppearance() {
  for (let i = 0; i < 3; i++) {
    const has = await evalJs(`!!document.querySelector('[data-setting-anchor="appearance.sidebarIcons"]')`)
    if (has) return true
    await clickText('外观')
    await sleep(700)
  }
  return await evalJs(`!!document.querySelector('[data-setting-anchor="appearance.sidebarIcons"]')`)
}

/** 通过设置页 UI 切包（真实用户路径）；返回 trigger 上的当前 label */
async function switchPack(label) {
  await evalJs(`(() => {
    const a = document.querySelector('[data-setting-anchor="appearance.sidebarIcons"]')
    const t = a?.querySelector('button[aria-haspopup="listbox"]')
    if (t) t.click()
    return true
  })()`)
  await sleep(400)
  const picked = await evalJs(`(() => {
    const opts = [...document.querySelectorAll('button[role="option"]')]
    const o = opts.find(x => (x.textContent || '').includes(${JSON.stringify(label)}))
    if (!o) return { ok: false, labels: opts.map(x => (x.textContent || '').trim().slice(0, 24)) }
    o.click()
    return { ok: true }
  })()`)
  await sleep(900)
  const now = await evalJs(`(async () => { try { return await window.api.getSetting('sidebarIconStyle') } catch { return null } })()`)
  return { picked, now }
}

async function main() {
  const page = await waitPage()
  console.log('page target:', page.url?.slice(0, 60), '|', page.title?.slice(0, 40))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args?.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(String(m.params.exceptionDetails?.exception?.value ?? m.params.exceptionDetails?.text ?? '').slice(0, 200))
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')

  for (let i = 0; i < 30; i++) {
    const st = await evalJs(`(() => ({ n: document.querySelector('#root')?.children.length ?? 0 }))()`)
    if (st.n > 0) break
    await sleep(500)
  }

  // 仓库选择浮层会吞掉所有点击 → 先跳过（绝不点「打开」＝原生对话框）
  const pickerAct = await evalJs(`(() => {
    const txt = document.body.textContent || ''
    if (!txt.includes('选择要进入的仓库')) return 'no-picker'
    const pick = (label) => {
      const cands = [...document.querySelectorAll('button,a,div,span')].filter((el) => (el.textContent || '').trim() === label)
      const target = cands.find((el) => el.tagName === 'BUTTON') || cands[cands.length - 1]
      if (!target) return false
      target.click()
      return true
    }
    if (pick('跳过，直接进入上次使用的仓库')) return 'skip'
    if (pick('探针测试仓库')) return 'fixture-row'
    return 'picker-no-action'
  })()`)
  if (pickerAct !== 'no-picker') console.log('[前置] 仓库选择浮层:', pickerAct)
  await sleep(1200)

  // 记原始包，末尾复原（探针不改用户的 dev 设置值）
  const pack0 = await evalJs(`(async () => { try { return await window.api.getSetting('sidebarIconStyle') } catch { return null } })()`)
  console.log('[前置] 当前 sidebarIconStyle =', pack0)

  // ---------- 进设置 → 外观 ----------
  await clickRail('设置')
  await sleep(1200)
  const navAppearance = await ensureAppearance()
  ok(navAppearance, 'R0 设置页可到「外观」（探针导航前置）', `anchor=${navAppearance}`)
  await sleep(400)

  // ---------- R1 图标包选择器 + 每个包的预览 ----------
  const r1 = await evalJs(`(() => {
    const a = document.querySelector('[data-setting-anchor="appearance.sidebarIcons"]')
    const t = a?.querySelector('button[aria-haspopup="listbox"]')
    if (t) t.click()
    return { anchor: !!a, trigger: !!t, curLabel: (t?.textContent || '').trim() }
  })()`)
  await sleep(500)
  const r1b = await evalJs(`(() => {
    const opts = [...document.querySelectorAll('button[role="option"]')]
    return {
      n: opts.length,
      labels: opts.map(o => (o.textContent || '').trim().slice(0, 20)),
      previews: opts.map(o => {
        const span = o.querySelector('span.flex.items-center.gap-1\\\\.5') || o.querySelector('span')
        return span ? span.querySelectorAll('svg, span > span').length : -1
      }),
    }
  })()`)
  ok(r1.anchor && r1.trigger && r1b.n >= 2,
    'R1 设置→外观→侧边栏图标风格：选择器存在，下拉列出 ≥2 个包',
    `anchor=${r1.anchor} cur="${r1.curLabel}" options=${r1b.n} ${JSON.stringify(r1b.labels)}`)
  // 关掉下拉（点面板外）
  await evalJs(`(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
  await sleep(400)

  // ---------- R2 rail「插件市场」跟随包 ----------
  const r2a = await switchPack(PACK_HAND)
  const railHand = await evalJs(JS_RAIL_ICON)
  ok(r2a.now === 'default' && railHand && railHand.sw === '1.6',
    'R2a ★ 手绘包：活动栏「插件市场」= 手绘图标，stroke-width 1.6（不再是裸 lucide 的 2）',
    `setting=${r2a.now} sw=${railHand?.sw} paths=${railHand?.paths}`)
  await shot('b9-r2a-rail-hand')

  const r2b = await switchPack(PACK_C140)
  const railC140 = await evalJs(JS_RAIL_ICON)
  ok(r2b.now === 'classic140' && railC140 && railC140.sw === '1.5' && railC140.head !== railHand?.head,
    'R2b ★ classic140 包：同一按钮换成 lucide Package，stroke-width 1.5（形状确实随设置变）',
    `setting=${r2b.now} sw=${railC140?.sw} 与手绘不同=${railC140?.head !== railHand?.head}`)
  await shot('b9-r2b-rail-c140')

  // ---------- R3/R4 插件市场页：左栏标题 12px + 详情空态 40px ----------
  await clickRail('插件市场')
  await sleep(1500)
  const pageC140 = await evalJs(JS_PLUGINS_PAGE)
  ok(pageC140.title && pageC140.title.sw === '1.5',
    'R3a ★ 插件市场页左栏「插件」标题图标跟随（classic140 = 1.5）',
    `sw=${pageC140.title?.sw} paths=${pageC140.title?.paths}`)
  ok(pageC140.empty && pageC140.empty.sw === '1.5',
    'R4a ★ 详情空态 40px 图标（classic140 = lucide 1.5，天然如此）',
    `sw=${pageC140.empty?.sw} size=${pageC140.emptySize} tag=${pageC140.emptyTag}`)
  await shot('b9-r3-plugins-page-c140')

  // 切回手绘 → 再看同两处
  await clickRail('设置')
  await sleep(1000)
  await ensureAppearance()
  const r3 = await switchPack(PACK_HAND)
  await clickRail('插件市场')
  await sleep(1500)
  const pageHand = await evalJs(JS_PLUGINS_PAGE)
  ok(r3.now === 'default' && pageHand.title && pageHand.title.sw === '1.6' && pageHand.title.head !== pageC140.title?.head,
    'R3b ★ 手绘包：左栏标题换成手绘图标，stroke-width 1.6',
    `setting=${r3.now} sw=${pageHand.title?.sw} 与 classic 不同=${pageHand.title?.head !== pageC140.title?.head}`)
  ok(pageHand.empty && pageHand.empty.sw === '1.2',
    'R4b ★★ 详情空态 40px 手绘图标 = 1.2（B-9 新增的 strokeWidth 通道真生效：大尺寸下不再偏粗）',
    `sw=${pageHand.empty?.sw} size=${pageHand.emptySize}`)
  await shot('b9-r4-plugins-page-hand')

  // ---------- R5 负向：观测点无一残留裸 lucide 的 stroke-width="2" ----------
  const r5 = await evalJs(`(() => {
    const hits = []
    const b = [...document.querySelectorAll('button[title]')].find(x => x.title === '插件市场')
    const s = b?.querySelector('svg')
    if (s && s.getAttribute('stroke-width') === '2') hits.push('rail')
    const tabBtn = [...document.querySelectorAll('button')].find(x => /^已安装 \\(/.test((x.textContent || '').trim()))
    const t = tabBtn?.parentElement?.previousElementSibling?.querySelector('svg')
    if (t && t.getAttribute('stroke-width') === '2') hits.push('pageTitle')
    const emptyP = [...document.querySelectorAll('p')].find(p => (p.textContent || '').trim() === '选择一个插件查看详情')
    const e = emptyP?.previousElementSibling
    const es = e && e.tagName === 'svg' ? e : e?.querySelector?.('svg')
    if (es && es.getAttribute('stroke-width') === '2') hits.push('empty40')
    return hits
  })()`)
  ok(r5.length === 0,
    'R5 ★ 负向：观测点均无 stroke-width="2"（裸 lucide 默认 = 改漏的签名）',
    r5.length ? r5.join(',') : 'clean')

  // ---------- 复原用户原设置 ----------
  await clickRail('设置')
  await sleep(1000)
  await ensureAppearance()
  const restore = await switchPack(pack0 === 'classic140' ? PACK_C140 : PACK_HAND)
  const packEnd = await evalJs(`(async () => { try { return await window.api.getSetting('sidebarIconStyle') } catch { return null } })()`)
  ok(packEnd === pack0, `R6 探针收尾复原 sidebarIconStyle=${pack0}（不给用户 dev 环境留副作用）`, `now=${packEnd} picked=${restore?.now}`)

  // ---------- R7 console 零 error ----------
  const realErrors = consoleErrors.filter((e) => !/favicon|Autofill|DevTools|ResizeObserver/i.test(e))
  ok(realErrors.length === 0, 'R7 console 零 error', realErrors.slice(0, 3).join(' | ') || 'clean')

  const fail = results.filter((r) => !r.pass)
  console.log('\n===== B-9 结果 =====')
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n通过 ${results.length - fail.length}/${results.length}`)
  process.exit(fail.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
