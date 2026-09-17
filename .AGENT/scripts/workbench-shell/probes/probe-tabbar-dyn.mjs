/**
 * 探针：标签条文档标签式动态形态（2026-09-17 第三轮反馈拍板落码回归）。
 * 断言：启动只有启动落点 1 个标签（模块按钮不上标签栏）→ 书签开新标签 →
 *       ✕ 关闭激活标签落右邻居 → 全关空态（tabbar 提示 + 内容区空态页）→ 空态恢复。
 * 拖拽重排沿用 4c0c7a6 批次3 版实现（HTML5 dnd，当时已经探针验证），此处不重复断言。
 */
const DEBUG_PORT = 9222
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
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
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

const JS_TABS = `(() => ({
  tabs: [...document.querySelectorAll('[data-wb="tab"]')].map((t) => ({ id: t.dataset.wbTab, active: t.dataset.wbActive })),
  bookmarks: [...document.querySelectorAll('[data-wb="bookmarks"] [data-wb-bookmark]')].map((b) => b.dataset.wbBookmark),
  tabbarEmpty: !!document.querySelector('[data-wb="tabbar"]')?.textContent.includes('没有打开的标签页'),
  emptyPage: [...document.querySelectorAll('div')].some((d) => d.textContent?.trim() === '所有标签页已关闭' && d.children.length === 0),
  closeBtns: document.querySelectorAll('[data-wb="tab"] button[title="关闭标签页"]').length,
}))()`
const clickBookmark = (key) => evalJs(`(() => { document.querySelector('[data-wb-bookmark="${key}"]')?.click(); return true })()`)
const clickClose = (key) => evalJs(`(() => { const b=document.querySelector('[data-wb="tab"][data-wb-tab="${key}"] button[title="关闭标签页"]'); b?.click(); return !!b })()`)

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
  }
  // 等主界面就绪：可能停在仓库选择页 → 点「进入/打开/继续」，再轮询书签区（最长 12s；
  // 实测选仓页进入后主界面懒加载偶发慢于固定 sleep）
  for (let i = 0; i < 24; i++) {
    const ready = await evalJs(`!!document.querySelector('[data-wb-bookmark="editor"]')`).catch(() => false)
    if (ready) break
    await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/进入|打开|继续/.test(x.textContent)); b?.click(); return true })()`)
    await sleep(500)
  }
  await sleep(600)
  // 状态复位：上轮 D8 可能落盘 bookmarksHidden / leftCollapsed 残留 → 本次启动基线被污染（同 b3 口径）。
  // 清空 workbenchLayout（空串走默认：书签全显、左栏展开总览），等 debounce flush 后再断言。
  await evalJs(`window.api?.setSetting ? window.api.setSetting('workbenchLayout', '') : 'no-api'`)
  await sleep(800)

  // D1 启动态：只有启动落点 1 个标签（不再 14 个固定全集）
  let st = await evalJs(JS_TABS)
  ok(st.tabs.length === 1 && st.tabs[0]?.id === 'editor' && st.tabs[0]?.active === '1',
    'D1 启动只有启动落点 1 个标签', JSON.stringify(st.tabs))
  ok(st.closeBtns === 1, 'D1b 标签带 ✕（悬停显形，DOM 常驻）', `closeBtns=${st.closeBtns}`)

  // D2 点知识库书签 → 追加第 2 个标签并激活
  await clickBookmark('knowledge')
  await sleep(900)
  st = await evalJs(JS_TABS)
  ok(st.tabs.length === 2 && st.tabs[1]?.id === 'knowledge' && st.tabs[1]?.active === '1',
    'D2 书签开新标签（追加+激活）', JSON.stringify(st.tabs))

  // D3 ✕ 关闭激活的 knowledge → 落右邻居语义退左邻居 editor
  await clickClose('knowledge')
  await sleep(600)
  st = await evalJs(JS_TABS)
  ok(st.tabs.length === 1 && st.tabs[0]?.id === 'editor' && st.tabs[0]?.active === '1',
    'D3 ✕ 关闭激活标签 → 落点 editor', JSON.stringify(st.tabs))

  // D4 关掉最后一个 → tabbar 空态提示 + 内容区空态页
  await clickClose('editor')
  await sleep(600)
  st = await evalJs(JS_TABS)
  ok(st.tabs.length === 0 && st.tabbarEmpty, 'D4a 全关 → tabbar 空态提示')
  ok(st.emptyPage, 'D4b 内容区空态页（所有标签页已关闭）')

  // D5 空态恢复：返回总览（D4 后左栏仍停在 editor 模块态，书签区不可见）→ 点书签 → 标签重现
  await evalJs(`(() => { document.querySelector('button[title^="返回总览"]')?.click(); return true })()`)
  await sleep(400)
  await clickBookmark('schedule')
  await sleep(900)
  st = await evalJs(JS_TABS)
  ok(st.tabs.length === 1 && st.tabs[0]?.id === 'schedule' && st.tabs[0]?.active === '1',
    'D5 空态后点书签恢复', JSON.stringify(st.tabs))

  // D6 图标条功能不登记为标签（第四轮拍板②）：点回收站 → openTabs 不变
  await evalJs(`(() => { document.querySelector('button[title="回收站"]')?.click(); return true })()`)
  await sleep(600)
  st = await evalJs(JS_TABS)
  ok(st.tabs.length === 1 && st.tabs[0]?.id === 'schedule', 'D6 图标条功能不产生标签', JSON.stringify(st.tabs))

  // D7 vaultBar 只在总览态显示（第四轮拍板④）：模块态无、返回总览后有
  const modVb = await evalJs(`!!document.querySelector('[data-wb="vaultBar"]')`)
  ok(!modVb, 'D7a 模块态下 vaultBar 不显示')
  await evalJs(`(() => { document.querySelector('button[title^="返回总览"]')?.click(); return true })()`)
  await sleep(400)
  const ovVb = await evalJs(`!!document.querySelector('[data-wb="vaultBar"]')`)
  ok(ovVb, 'D7b 总览态下 vaultBar 显示')

  // D8 🔖 书签选显菜单（第四轮拍板⑤）：总览态打开 → 隐藏书架 → 书签区 5 项 → 勾回 6 项
  await evalJs(`(() => { document.querySelector('[data-wb="bookmarkMenuBtn"]')?.click(); return true })()`)
  await sleep(400)
  const menuOpen = await evalJs(`!!document.querySelector('[data-wb="bookmarkMenu"]')`)
  ok(menuOpen, 'D8a 🔖 菜单打开（总览态头部）')
  await evalJs(`(() => { document.querySelector('[data-wb="bookmarkMenu"] [data-wb-menu-item="bookshelf"]')?.click(); return true })()`)
  await sleep(500)
  st = await evalJs(JS_TABS)
  ok(!st.bookmarks.includes('bookshelf') && st.bookmarks.length === 5, 'D8b 隐藏书架 → 书签区 5 项', JSON.stringify(st.bookmarks))
  await evalJs(`(() => { document.querySelector('[data-wb="bookmarkMenu"] [data-wb-menu-item="bookshelf"]')?.click(); return true })()`)
  await sleep(500)
  st = await evalJs(JS_TABS)
  ok(st.bookmarks.length === 6, 'D8c 重新勾选 → 书签区恢复 6 项（菜单保持打开，允许多选）', JSON.stringify(st.bookmarks))

  // D9 书签点击幂等（第四轮拍板①）：再点当前高亮书签 → 模块态保持（不退回总览）
  await clickBookmark('editor')
  await sleep(700)
  const mod1 = await evalJs(`document.querySelector('[data-wb="mod"]')?.dataset.wbMod ?? ''`)
  await clickBookmark('editor')
  await sleep(500)
  const mod2 = await evalJs(`document.querySelector('[data-wb="mod"]')?.dataset.wbMod ?? ''`)
  ok(mod1 === 'editor' && mod2 === 'editor', 'D9 再点同书签不退出模块态', `mod1=${mod1} mod2=${mod2}`)

  console.log('\n========================================')
  const fails = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.label}${r.detail ? '  → ' + r.detail : ''}`)
  console.log(fails.length === 0 ? `\n✅ ${results.length} 项全 PASS` : `\n❌ ${fails.length}/${results.length} FAIL`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针失败:', e.message); process.exit(2) })
