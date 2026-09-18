/**
 * 分屏运行时探针 —— v6「副栏准入收窄 + 跨栏保活」（2026-09-18 第十二轮）
 *
 * 本轮改动（对应 docs/workbench-split-scope-design.md）：
 *   ① 副栏准入收窄为 `SPLIT_ELIGIBLE = ['editor','knowledge']`（三个入口同口径）
 *   ② 副段模块名 chip 由 ⌄ 菜单降为**纯标识**（SplitPaneMenu 已删）
 *   ③ ★ 跨栏保活：模块容器改挂**单一父节点**的常驻兄弟槽，pane 只改样式
 *
 * 断言分组：
 *   S1 入口与初始态
 *   S2 开分屏 + 顶栏副段形态（纯标识 chip、无 ⌄）
 *   S3 ★ 跨栏保活：知识库带页签/激活页 → 搬到副栏 → 状态**不丢**
 *   S4 ★ 搬回主栏同样保活（完整往返）
 *   S5 副栏准入：Ctrl+\ 在主栏非准入模块时不开副栏 + 出提示
 *   S6 单实例：副栏模块不在主栏数组里重复渲染
 *   S7 console 零 error
 *
 * 用法（必须先 electron-vite build）：
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-split.mjs
 * 前置：先跑 seed-probe-vault.mjs（需要 fixture 仓库里有个可打开的文件）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOT_DIR = join('E:/Projects/KnowledgeRecorder', 'tmp', 'probe-shots')

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

/**
 * 状态快照。跨栏保活的关键读数 = 知识库页签组的条目数与激活页 id：
 *   · 搬迁前 items=N / active=<id>
 *   · 若丢掉状态 → items=0 / active=''（旧缺陷的可观测症状）
 */
const JS_STATE = `(() => {
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const bar = q('[data-wb="pagebar"]')
  const secwrap = q('[data-pb-slot-wrap="secondary"]')
  const pane = q('[data-wb="splitPane"]')
  const groups = qa('[data-pb-group]').map((g) => ({
    owner: g.dataset.pbGroup,
    paneActive: g.dataset.paneActive,
    items: g.querySelectorAll('[data-pb-item]').length,
    activeId: g.querySelector('[data-pb-item][data-tab-id]')?.dataset.tabId
      ?? g.querySelector('[data-pb-item]')?.dataset.tabId ?? '',
    rel: g.querySelector('[data-pb-item]')?.dataset.tabRel ?? '',
  }))
  const kbGroup = groups.find((g) => g.owner === 'knowledge')
  const edGroup = groups.find((g) => g.owner === 'editor')
  const pr = pane?.getBoundingClientRect()
  const sr = secwrap?.getBoundingClientRect()
  return {
    splitState: bar?.dataset.pbSplit ?? '',
    hasSplitBtn: !!q('[data-pb-split-btn]'),
    pane: !!pane,
    paneModule: pane?.dataset.paneModule ?? '',
    paneLeft: pr ? Math.round(pr.left) : -1,
    secWrapLeft: sr ? Math.round(sr.left) : -1,
    groups,
    kbItems: kbGroup ? kbGroup.items : -1,
    kbActiveId: kbGroup ? kbGroup.activeId : '',
    edItems: edGroup ? edGroup.items : -1,
    /* 副段 chip 是否纯标识（本轮收窄）：应该是 SPAN、无 data-pb-panemenu、无 ChevronDown */
    chipTag: secwrap?.querySelector('[data-pb-pane-chip]')?.tagName ?? '',
    chipHasMenu: !!secwrap?.querySelector('[data-pb-panemenu]'),
    chipCursor: secwrap?.querySelector('[data-pb-pane-chip]')
      ? getComputedStyle(secwrap.querySelector('[data-pb-pane-chip]')).cursor : '',
    /* 单实例哨兵：同一模块的容器出现次数（应恒为 0 或 1） */
    kbContainers: qa('[data-pb-group="knowledge"]').length,
    /* 副栏模块容器是否在主栏区域里（应为 false） */
    secContainerInMain: !!pane && !!pane.closest('[data-wb="mainPane"]'),
    /* 模块容器所在的父节点链（用于核验「单一父节点」） */
    containerParents: qa('[data-pb-group]').map((g) => {
      const host = g.closest('[data-pane]')
      return { owner: g.dataset.pbGroup, pane: host?.dataset.pane ?? '', key: host?.getAttribute('key') ?? '' }
    }),
    toastText: (document.body.textContent || '').includes('分屏仅支持编辑区 / 知识库'),
  }
})()`

/** 点页面条上的模块条目 */
const clickBarTab = (id) => evalJs(`(() => {
  const el = document.querySelector('[data-wb="pagebar"] [data-wb-tab="${id}"]')
  el?.click(); return !!el
})()`)

/** 打开知识库并打开一个页面（产生页签 → 有可观测的模块内状态） */
const openKbPage = (rel) => evalJs(`(() => {
  const el = document.querySelector('[data-page-id="${rel}"]')
  if (el) { el.click(); return 'by-rel' }
  return 'not-found'
})()`)

async function main() {
  const page = await waitPage()
  console.log('page target:', page.url?.slice(0, 60))
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
    const n = await evalJs(`document.querySelector('#root')?.children.length ?? 0`)
    if (n > 0) break
    await sleep(500)
  }

  // 仓库选择浮层（VaultPicker 启动形态）盖在工作台之上且**不阻止 .click()** → 断言会假通过。
  // 先点「跳过，直接进入上次使用的仓库」；**绝不点「打开本地仓库」**（原生对话框会卡死探针）。
  const dismissPicker = `(() => {
    if (!(document.body.textContent || '').includes('选择要进入的仓库')) return 'no-picker'
    const cands = [...document.querySelectorAll('button,a,div,span')]
      .filter((el) => (el.textContent || '').trim() === '跳过，直接进入上次使用的仓库')
    const target = cands.find((el) => el.tagName === 'BUTTON') || cands[cands.length - 1]
    if (!target) return 'not-found'
    target.click()
    return 'skip'
  })()`
  const p1 = await evalJs(dismissPicker)
  if (p1 !== 'no-picker') console.log('[前置] 仓库选择浮层:', p1)
  for (let i = 0; i < 24; i++) {
    const st = await evalJs(JS_STATE)
    if (st.hasSplitBtn || st.splitState === '1') break
    await sleep(500)
  }
  const p2 = await evalJs(dismissPicker)
  if (p2 !== 'no-picker') { console.log('[前置] 仓库选择浮层(补):', p2); await sleep(1000) }
  console.log('[前置] 仓库选择浮层已关闭:', await evalJs(`!document.body.textContent.includes('选择要进入的仓库')`))

  // ---- S1 初始态 ----
  const st0 = await evalJs(JS_STATE)
  ok(st0.hasSplitBtn && st0.splitState === '0', 'S1a 未分屏时分屏开关在主段尾部', `btn=${st0.hasSplitBtn} state=${st0.splitState}`)
  ok(!st0.pane, 'S1b 初始无副栏')

  // ---- S3 ★ 跨栏保活：先让知识库在主栏攒出状态（页签 + 激活页）----
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(400)
  await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
  await sleep(1800)
  // 展开第一个目录（页面行只在目录展开后渲染）
  await evalJs(`document.querySelector('.kb-chevron')?.closest('span')?.click()`)
  await sleep(900)
  const opened = await openKbPage('probe-note-1')
  await sleep(1600)
  const before = await evalJs(JS_STATE)
  ok(before.kbItems >= 1, 'S3a 知识库在主栏打开页面后有页签（基线状态非零）',
    `items=${before.kbItems} active=${before.kbActiveId} opened=${opened}`)

  // ---- S2 开分屏 + 副段形态 ----
  await evalJs(`document.querySelector('[data-pb-split-btn]')?.click()`)
  await sleep(1400)
  const st1 = await evalJs(JS_STATE)
  ok(st1.pane && st1.splitState === '1', 'S2a 点分屏开关 → 副栏渲染', `state=${st1.splitState}`)
  ok(st1.paneModule === 'editor', 'S2b 主栏知识库 → 副栏编辑器（准入内两模块互为对方）', st1.paneModule)
  ok(st1.chipTag === 'SPAN' && !st1.chipHasMenu,
    'S2c 副段模块名 chip 是纯标识（SPAN、无 ⌄ 菜单）', `tag=${st1.chipTag} menu=${st1.chipHasMenu}`)
  ok(st1.chipCursor === 'default', 'S2d chip 光标为 default（不暗示可点）', st1.chipCursor)
  const dLeft = Math.abs(st1.secWrapLeft - st1.paneLeft)
  ok(dLeft <= 2, 'S2e 分界对齐：副段左缘 ≈ 副栏左缘（±2px）', `secWrap=${st1.secWrapLeft} pane=${st1.paneLeft} Δ=${dLeft}`)

  // ---- S3b ★ 把知识库搬进副栏（用命令面板的真实路径不好驱动，这里用「副栏聚焦 + 点条目」的既有语义）----
  // 更直接的路径：主栏换成博客 → 知识库从主栏数组移到副栏需要显式切。
  // 用「主栏切到博客（知识库落到保活隐藏态）」+「开分屏时选知识库」两步替代：
  //   ① Ctrl+\ 关闭分屏
  //   ② 主栏切博客
  //   ③ 用命令面板/直接开副栏 → 知识库
  // 但本探针不驱动命令面板（脆），改走**确定性路径**：直接点页面条模块条目把主栏占用，
  // 再用分屏按钮（此时主栏为博客/非准入 → 应给提示而不是开副栏）。
  // 因此 S3b 用「已在副栏」的既有 way：先把知识库放进副栏 —— 主栏编辑器 + 副栏知识库。
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', ctrlKey: true, bubbles: true }))
    return 'close'
  })()`)
  await sleep(900)
  // 主栏切到编辑器（准入模块），再开分屏 → 副栏自动放知识库
  await evalJs(`window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: 'README.md' } }))`)
  await sleep(2000)
  await evalJs(`document.querySelector('[data-pb-split-btn]')?.click()`)
  await sleep(1600)
  const st2 = await evalJs(JS_STATE)
  ok(st2.pane && st2.paneModule === 'knowledge', 'S3b 主栏编辑器 → 副栏放知识库', st2.paneModule)
  ok(st2.kbItems === before.kbItems && st2.kbActiveId === before.kbActiveId,
    '★ S3c 跨栏保活：知识库搬到副栏后页签数与激活页**不变**（搬迁前 ' + before.kbItems + ' / ' + before.kbActiveId + '）',
    `items ${before.kbItems}→${st2.kbItems}  active ${before.kbActiveId}→${st2.kbActiveId}`)
  ok(st2.kbContainers === 1, 'S6 单实例：知识库容器只渲染一份', `count=${st2.kbContainers}`)
  ok(!st2.secContainerInMain, 'S6b 副栏容器不在主栏区域内', `inMain=${st2.secContainerInMain}`)
  const shotSplit = await shot('split-v6-01-kb-in-secondary')

  // ---- S4 ★ 搬回主栏（完整往返）----
  await evalJs(`window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: 'README.md' } }))`)
  await sleep(1600)
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', ctrlKey: true, bubbles: true }))
    return 'close'
  })()`)
  await sleep(900)
  await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
  await sleep(1600)
  const st3 = await evalJs(JS_STATE)
  ok(st3.kbItems === before.kbItems && st3.kbActiveId === before.kbActiveId,
    '★ S4 搬回主栏后状态仍保持（完整往返零丢失）',
    `items ${before.kbItems}→${st3.kbItems}  active ${before.kbActiveId}→${st3.kbActiveId}`)
  const shotBack = await shot('split-v6-02-kb-back-in-main')

  // ---- S5 准入：主栏切到非准入模块（博客）后按 Ctrl+\ → 不开副栏 + 提示 ----
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(400)
  await evalJs(`document.querySelector('[data-wb-bookmark="blog"]')?.click()`)
  await sleep(1500)
  const stBefore5 = await evalJs(JS_STATE)
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', ctrlKey: true, bubbles: true }))
    return 'sent'
  })()`)
  await sleep(1200)
  const st4 = await evalJs(JS_STATE)
  ok(!st4.pane, 'S5a 主栏是博客（非准入）时按 Ctrl+\\ → 不开副栏', `pane=${st4.pane} mainModule=${stBefore5.splitState}`)
  ok(st4.toastText, 'S5b 给出「分屏仅支持编辑区 / 知识库」提示', `toast=${st4.toastText}`)

  ok(consoleErrors.length === 0, 'S7 console 零 error', consoleErrors.slice(0, 3).join(' | '))

  console.log('\n截图：', shotSplit, '|', shotBack)
  console.log('\n========================================')
  const fails = results.filter((r) => !r.pass)
  const pass = results.length - fails.length
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.pass ? '' : '   → ' + r.detail}`)
  console.log('========================================')
  if (fails.length === 0) console.log(`✅ 全部通过：${pass} 项断言 PASS`)
  else console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  try { ws.close() } catch { /* 收尾 */ }
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针异常:', e.message); process.exit(2) })
