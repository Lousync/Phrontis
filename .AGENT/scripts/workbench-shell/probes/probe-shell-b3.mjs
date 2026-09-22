/**
 * 批次3 左栏书签双态运行时探针：electron 产物 + CDP（Node 22 内置 WebSocket）
 * 断言：外壳 DOM / 书签 6 项 / 书签↔标签联动 / 模块态 slot+portal / 跟随与锁定 /
 *       树模式 / vaultBar / workbenchLayout 落盘 / console 零 error
 * 前置：electron 不设 KNOWBASE_SHARED_DATA 启动（走 dev 隔离，userData=%APPDATA%/knowbase (dev KnowledgeRecorder)）
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DEBUG_PORT = Number(process.env.KB_CDP_PORT || 9222) // 端口可覆盖（见 run-probe.mjs）：默认 9222 不变
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
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
const results = []
function ok(cond, label, detail = '') {
  results.push({ pass: !!cond, label, detail })
  return !!cond
}

const JS_STATE = `(() => {
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  return {
    rootChildren: q('#root')?.children.length ?? 0,
    shell: !!q('[data-wb="shell"]'),
    tabbar: !!q('[data-wb="pagebar"]'),
    // 2026-09-18 页面条置顶：编辑器 / 知识库不再占模块条目（由各自页签组代表），
    // 模块级状态改从页面条的 data-pb-tabs（openTabs 全量）读
    openTabs: (q('[data-wb="pagebar"]')?.dataset.pbTabs ?? '').split(',').filter(Boolean),
    bookmarks: qa('[data-wb="bookmarks"] [data-wb-bookmark]').map((b) => b.dataset.wbBookmark),
    bookmarkActive: qa('[data-wb="bookmarks"] [data-wb-bookmark][data-wb-active="1"]').map((b) => b.dataset.wbBookmark),
    modSlot: !!q('[data-wb="modSlot"]'),
    modSlotFilled: !!q('[data-wb="modSlot"]') && q('[data-wb="modSlot"]').children.length > 0,
    // 2026-09-16 第二轮 UI 反馈：模块态头部文字装饰已删，模块态改读 data-wb-mod（模块 key）
    modTitle: q('[data-wb="mod"]')?.dataset.wbMod ?? '',
    treeMode: !!q('[data-wb="treeMode"]'),
    treeDirs: qa('[data-wb="treeMode"] div').filter((d) => d.textContent && !d.querySelector('button')).length,
    vaultBar: !!q('[data-wb="vaultBar"]'),
    tabs: qa('[data-wb="tab"]').map((t) => ({ id: t.dataset.wbTab, active: t.dataset.wbActive })),
    lockTitle: q('button[title^="锁定侧边栏"], button[title^="已锁定"]')?.title ?? '',
  }
})()`

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
  for (let i = 0; i < 30; i++) {
    const st = await evalJs(`(() => ({ n: document.querySelector('#root')?.children.length ?? 0 }))()`)
    if (st.n > 0) break
    await sleep(500)
  }
  let st0 = await evalJs(JS_STATE)
  if (!st0.shell) {
    // 仓库选择页 → 进入
    await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/进入|打开|继续/.test(x.textContent)); b?.click(); return !!b })()`)
  }
  // 等主界面就绪（书签区 6 项渲染）：进入仓库 + 懒加载可能慢于固定 sleep（实测选仓页进入
  // 偶发慢于 1.5s → S3/S4/T1b 假失败），轮询最长 12s
  for (let i = 0; i < 24; i++) {
    st0 = await evalJs(JS_STATE)
    if (st0.shell && st0.bookmarks.length === 6) break
    await sleep(500)
  }

  // 状态复位：上次运行的 S13 可能落盘了 leftCollapsed=true → 本次启动左栏直接收起，S3 假失败。
  // 清空 workbenchLayout（parseWorkbenchLayout 对空串走默认值），等 debounce flush 后再断言。
  await evalJs(`window.api?.setSetting ? window.api.setSetting('workbenchLayout', '') : 'no-api'`)
  await sleep(800)
  // 复位后左栏若曾收起会自动展开（layout.leftCollapsed=false），重取一次状态
  st0 = await evalJs(JS_STATE)

  ok(st0.shell, 'S1 三栏外壳渲染')
  ok(st0.tabbar, 'S2 中间页面条渲染（v3.4.0 页面条置顶：原标签条）')
  ok(st0.bookmarks.join(',') === 'editor,knowledge,schedule,bookshelf,blog,quiz', 'S3 书签 6 项按 v15 定稿渲染', st0.bookmarks.join(','))
  ok(st0.vaultBar, 'S4 底部仓库切换 vaultBar 渲染')
  ok(st0.openTabs.length >= 1, 'S5 openTabs 已登记（data-pb-tabs）', st0.openTabs.join(','))

  // T1 书签点击 → 标签打开 + 左栏进模块态（模块态=独立视图，书签区隐藏——原型 lpModView 同款）
  await evalJs(`document.querySelector('[data-wb-bookmark="editor"]')?.click()`)
  await sleep(1200)
  const st1 = await evalJs(JS_STATE)
  ok(st1.openTabs.includes('editor'), 'T1 点编辑区书签 → openTabs 登记 editor（页签由编辑器组代表）', st1.openTabs.join(','))
  ok(st1.modSlot, 'T1b 左栏进入模块态（modSlot 渲染）')
  ok(st1.modSlotFilled, 'T1c editor 文件树 portal 进左栏 slot', st1.modSlotFilled ? '' : 'slot 空——检查 sidebarEl 接线/仓库是否打开')
  ok(st1.modTitle === 'editor', 'T1d 模块态 = 编辑区（data-wb-mod）', `mod=${st1.modTitle}`)

  // T2 ‹ 返回总览 = 退出模块态（原型 lpBack：书签区只在总览可见，「再点书签退出」经返回钮达成）
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  const st2 = await evalJs(JS_STATE)
  ok(!st2.modSlot, 'T2 返回总览 = 退出模块态')
  ok(st2.bookmarks.length === 6, 'T2b 总览书签区恢复')

  // T3 知识库书签 → 模块态 + 标签；标签条点 editor（已开）→ 跟随（标题变编辑区）
  await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
  await sleep(1200)
  const st3 = await evalJs(JS_STATE)
  ok(st3.modSlot && st3.modTitle === 'knowledge', 'T3 点知识库书签 → 模块态 = knowledge', `mod=${st3.modTitle}`)
  ok(st3.modSlotFilled, 'T3b knowledge 侧栏 portal 进左栏 slot')
  // T3c 页面条点模块条目 → 左栏自动跟随。2026-09-18 页面条置顶后编辑器 / 知识库不再占模块条目，
  // 故改用「博客」条目验证同一条链路（先返回总览 → 开博客 → 再返回总览 → 点条目）。
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb-bookmark="blog"]')?.click()`)
  await sleep(1200)
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb="tab"][data-wb-tab="blog"]')?.click()`)
  await sleep(700)
  const st4 = await evalJs(JS_STATE)
  ok(st4.modTitle === 'blog', 'T3c 页面条点博客条目 → 左栏自动跟随', `mod=${st4.modTitle}`)

  // T4 锁定：📌 后点条目不跟随；解锁恢复（两个条目：博客 / 日程）
  // 注意：模块态下书签区隐藏，必须先「返回总览」才能点书签把日程登记进 openTabs
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb-bookmark="schedule"]')?.click()`)
  await sleep(1000)
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb="tab"][data-wb-tab="blog"]')?.click()`)
  await sleep(700)
  const st4b = await evalJs(JS_STATE)
  const lockBtn = st4b.lockTitle
  ok(!!lockBtn, 'T4 模块态头部有锁定钮', lockBtn)
  await evalJs(`document.querySelector('button[title^="锁定侧边栏"]')?.click()`)
  await sleep(400)
  await evalJs(`document.querySelector('[data-wb="tab"][data-wb-tab="schedule"]')?.click()`)
  await sleep(700)
  const st5 = await evalJs(JS_STATE)
  ok(st5.modTitle === 'blog', 'T4b 锁定后点条目不跟随（仍博客）', `mod=${st5.modTitle}`)
  await evalJs(`document.querySelector('button[title^="已锁定"]')?.click()`)
  await sleep(400)
  await evalJs(`document.querySelector('[data-wb="tab"][data-wb-tab="schedule"]')?.click()`)
  await sleep(700)
  const st6 = await evalJs(JS_STATE)
  ok(st6.modTitle === 'schedule', 'T4c 解锁后点条目恢复跟随（日程）', `mod=${st6.modTitle}`)

  // T5 错题本书签：先返回总览（模块态无书签区），再点错题本 → knowledge 标签 + 模块态标题「错题本」
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('[data-wb-bookmark="quiz"]')?.click()`)
  await sleep(1200)
  const st7 = await evalJs(JS_STATE)
  ok(st7.openTabs.includes('knowledge'), 'T5 错题本书签 → openTabs 登记 knowledge', st7.openTabs.join(','))
  ok(st7.modTitle === 'quiz', 'T5b 模块态 = quiz（错题本复用 knowledge 侧栏）', `mod=${st7.modTitle}`)

  // T6 树模式：返回总览 → 点 🌳 → treeMode；返回总览（树模式返回钮 title 恰为「返回总览」）
  await evalJs(`document.querySelector('button[title^="返回总览"]')?.click()`)
  await sleep(500)
  await evalJs(`document.querySelector('button[title="切换为文件树模式（仓库顶层目录）"]')?.click()`)
  await sleep(600)
  const st8 = await evalJs(JS_STATE)
  ok(st8.treeMode, 'T6 🌳 进入文件树模式')
  await evalJs(`document.querySelector('button[title="返回总览"]')?.click()`)
  await sleep(400)
  const st9 = await evalJs(JS_STATE)
  ok(!st9.treeMode && st9.bookmarks.length === 6, 'T6b 树模式返回总览')

  // S13 落盘链路：单击左栏手柄收起 → flush → workbenchLayout 键落盘
  const collapseJs = `(() => {
    const h = document.querySelector('div[role="separator"][title="拖拽调整宽度，双击复位"]')
    if (!h) return 'NO_HANDLE'
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }))
    return 'DOWN'
  })()`
  await evalJs(collapseJs)
  await sleep(150)
  await evalJs(`(() => {
    const h = document.querySelector('div[role="separator"][title="拖拽调整宽度，双击复位"]')
    ;(h || window).dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }))
    return 'UP'
  })()`)
  await sleep(400)
  const stC = await evalJs(JS_STATE)
  ok(!stC.shell || stC.bookmarks.length === 0, 'S13a 单击手柄 → 左栏收起', `bookmarks=${stC.bookmarks.length}`)
  await sleep(1200)
  // userData = %APPDATA%/knowbase (dev KnowledgeRecorder)——不设 KNOWBASE_SHARED_DATA 时
  // main/index.ts L86 在正式目录名后加 " (dev <检出目录名>)" 后缀（与正式数据隔离）
  const settingsPath = join(process.env.APPDATA || '', 'knowbase (dev KnowledgeRecorder)', 'settings.json')
  let persisted = null
  let readErr = ''
  try {
    if (!existsSync(settingsPath)) readErr = 'settings.json 不存在'
    else persisted = JSON.parse(readFileSync(settingsPath, 'utf8')).workbenchLayout
  } catch (e) { readErr = String(e.message || e) }
  let parsed = null
  try { parsed = JSON.parse(persisted ?? 'null') } catch { /* null */ }
  ok(parsed?.leftCollapsed === true, 'S13b workbenchLayout.leftCollapsed=true 落盘', persisted == null ? readErr : JSON.stringify(parsed))
  // 恢复展开
  await evalJs(`(() => { const e=document.querySelector('div[title="拖拽或点击展开"]'); e?.click(); return !!e })()`)
  await sleep(700)
  const stR = await evalJs(JS_STATE)
  ok(stR.bookmarks.length === 6, 'S14 边缘条点击 → 左栏重挂恢复', `bookmarks=${stR.bookmarks.length}`)

  ok(consoleErrors.length === 0, 'S12 console 零 error', consoleErrors.slice(0, 3).join(' | '))

  const fails = results.filter((r) => !r.pass)
  console.log('\n========================================')
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.label}${r.detail ? '  → ' + r.detail : ''}`)
  console.log(fails.length === 0 ? `\n✅ ${results.length} 项全 PASS` : `\n❌ ${fails.length}/${results.length} FAIL`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针失败:', e.message); process.exit(2) })
