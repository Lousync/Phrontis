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

  // D6 图标条功能 = 与工作台平级的模块（第五轮拍板修正）：点回收站 → 整窗独占
  //（左栏与标签条隐藏，同 aiTeaching），不产生标签
  await evalJs(`(() => { document.querySelector('button[title="回收站"]')?.click(); return true })()`)
  await sleep(700)
  st = await evalJs(JS_TABS)
  ok(st.tabs.length === 0, 'D6 回收站整窗：无标签可见（不产生标签，标签条整体隐藏）', JSON.stringify(st.tabs))
  const fwLeftGone = await evalJs(`!document.querySelector('[data-wb="leftPanel"]')`)
  ok(fwLeftGone, 'D6b 回收站整窗形态：左栏隐藏（平级模块，非工作台子模块）')
  const fwTabbarGone = await evalJs(`!document.querySelector('[data-wb="tabbar"]')`)
  ok(fwTabbarGone, 'D6c 整窗形态下标签条隐藏')
  // D6e 整窗形态下左右栏**连折叠边条一并退场**（2026-09-17 bug 修复轮）：
  // 「拖拽或点击展开」边缘条 = ResizablePanel 折叠残留物，suppressSides 下不得存在
  const fwEdgeGone = await evalJs(`!document.querySelector('[data-wb="shell"] [title="拖拽或点击展开"]')`)
  ok(fwEdgeGone, 'D6e 整窗形态无残留折叠边条（标签条旁的「手柄」已清除）')
  // D6d 图标条顶部「工作台」按钮 → 回到工作台（schedule 标签恢复显示）
  //（2026-09-17 bug 修复轮：右上角浮动「返回工作台」钮删除，入口收敛到 ActivityBar 顶部）
  const wbBtnThere = await evalJs(`!!document.querySelector('button[title="工作台"]')`)
  ok(wbBtnThere, 'D6d-0 整窗态下图标条顶部有「工作台」按钮')
  await evalJs(`(() => { document.querySelector('button[title="工作台"]')?.click(); return true })()`)
  await sleep(700)
  st = await evalJs(JS_TABS)
  ok(st.tabs.length === 1 && st.tabs[0]?.id === 'schedule' && st.tabs[0]?.active === '1',
    'D6d 返回工作台 → schedule 标签恢复', JSON.stringify(st.tabs))

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

  // D10 工具侧栏适配左栏（2026-09-17 右栏优化轮）：pdf-toolkit 标签激活 → 左栏模块态
  // data-wb-mod=pdf-toolkit，侧栏（文件列表）portal 进 slot；关标签 → 回原模块态。
  //（先退出模块态到总览，排除 railModule 残留干扰；pdf-toolkit 为 lazy chunk，多等加载）
  await evalJs(`(() => { document.querySelector('button[title^="返回总览"]')?.click(); return true })()`)
  await sleep(400)
  // 入口区在右栏内 → 先确保右栏展开（布局键刚被清空，rightCollapsed 必为默认收起）
  await evalJs(`(() => {
    if (document.querySelector('[data-wb="toolsZone"]')) return true
    const hs = [...document.querySelectorAll('[data-wb="shell"] [title="拖拽或点击展开"]')]
    hs[hs.length - 1]?.click(); return true
  })()`)
  await sleep(800)
  const rpReady = await evalJs(`!!document.querySelector('[data-wb="toolsZone"]')`)
  ok(rpReady, 'D10-0 右栏展开、工具入口区就绪（打开入口的前置条件）')
  // 打开工具标签：右栏入口区「PDF 工具箱」条目
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll('[data-wb="toolsZone"] button')]
    const hit = btns.find((b) => b.textContent?.includes('PDF 工具箱'))
    hit?.click(); return true
  })()`)
  await sleep(1800)
  const toolMod = await evalJs(`document.querySelector('[data-wb="mod"]')?.dataset.wbMod ?? ''`)
  ok(toolMod === 'pdf-toolkit', 'D10 PDF 工具箱标签激活 → 左栏切工具侧栏态（data-wb-mod=pdf-toolkit）', `mod=${toolMod}`)
  const slotHasSidebar = await evalJs(`!!document.querySelector('[data-wb="modSlot"] > div')`)
  ok(slotHasSidebar, 'D10b 工具侧栏 portal 进左栏 slot（文件列表挂载）')
  // 关工具标签（标签条 ✕）→ railTool 清空；落点 = 上一个文档标签（landingAfterClose 语义），
  // 左栏 RAIL_FOLLOW_MAP 跟随落点模块态 —— 关键断言：railTool 不滞留（mod ≠ pdf-toolkit）
  await evalJs(`(() => {
    const tabs = [...document.querySelectorAll('[data-wb="tabbar"] [data-wb-tab]')]
    const t = tabs.find((x) => x.dataset.wbTab === 'tool:pdf-toolkit')
    t?.querySelector('button[title="关闭标签页"]')?.click(); return true
  })()`)
  await sleep(700)
  const afterClose = await evalJs(`document.querySelector('[data-wb="mod"]')?.dataset.wbMod ?? ''`)
  ok(afterClose !== 'pdf-toolkit', 'D10c 关工具标签 → railTool 清空不滞留（左栏跟随落点标签）', `mod=${afterClose}`)

  // D11 右栏下段（2026-09-17 反馈轮）：控件切换条按原型恢复（一排彩色图标 + ⋯）
  // + 番茄钟专注态变环形进度 + 按钮随状态变。（右栏已由 D10 展开）
  const rpOpen = await evalJs(`!!document.querySelector('[data-wb="rightPanel"]')`)
  ok(rpOpen, 'D11a 右栏展开可用（承接 D10 状态）')
  // D11-0 基线摆正：历史轮次可能落盘过 widgetsHidden（控件选显）→ 打开 ⋯ 菜单把 5 项全勾上。
  // 走 UI 而不写 settings（实测 setSetting('workbenchLayout','') 清空对渲染不生效），
  // 顺带验证菜单项的原生事件委托通道可用。
  await evalJs(`(() => { document.querySelector('[data-wb="wsMore"]')?.click(); return true })()`)
  await sleep(400)
  const menuTotal = await evalJs(`document.querySelectorAll('[data-wb="widgetMenu"] input[data-ws-widget-id]').length`)
  ok(menuTotal === 5, 'D11-0 ⋯ 选显菜单列出 5 个控件（原型清单，原生委托可驱动）', 'total=' + menuTotal)
  // 逐个勾上（逐个派发 change 并等重渲染；已验证菜单勾选链路本身能一轮勾完全部）
  for (let i = 0; i < 6; i++) {
    const turned = await evalJs(`(() => {
      const off = [...document.querySelectorAll('[data-wb="widgetMenu"] input[data-ws-widget-id]')].filter((x) => !x.checked)
      if (!off.length) return 0
      off[0].checked = true
      off[0].dispatchEvent(new Event('change', { bubbles: true }))
      return 1
    })()`)
    if (!turned) break
    await sleep(200)
  }
  await sleep(300)
  await evalJs(`(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true })()`)
  await sleep(300)
  const bar = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('[data-wb="wsBtn"]')]
    return { n: btns.length, labels: btns.map((b) => b.getAttribute('title')), hasMore: !!document.querySelector('[data-wb="wsMore"]') }
  })()`)
  ok(bar.n === 5 && bar.hasMore, 'D11b 控件切换条 = 5 个控件图标 + ⋯（原型形态，非空列表）', JSON.stringify(bar))
  const firstActive = await evalJs(`document.querySelector('[data-wb="wsBtn"][data-ws-widget="task"]')?.className.includes('bg-[var(--bg-hover)]') ?? false`)
  const briefIsTask = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="widgetBrief"]')
    return !!el && el.textContent.includes('今天')
  })()`)
  ok(firstActive && briefIsTask, 'D11b2 默认激活首个控件（今日任务），简略视图随动', `active=${firstActive} task=${briefIsTask}`)
  const subGone = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="widgetBrief"]')
    return !!el && !el.textContent.includes('与工具箱同源')
  })()`)
  ok(subGone, 'D11c 简略视图内无「与工具箱同源」副说明')
  // 切到番茄钟（第 3 个图标）→ 就绪态无环
  await evalJs(`(() => { document.querySelector('[data-wb="wsBtn"][data-ws-widget="pomo"]')?.click(); return true })()`)
  await sleep(600)
  const titleGone = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="widgetBrief"]')
    return !!el && !el.textContent.includes('番茄钟')
  })()`)
  ok(titleGone, 'D11d 简略视图内无文字标题（切换条选中图标即控件标识，去冗余说明）')
  const ringBefore = await evalJs(`!!document.querySelector('[data-wb="pomoRing"]')`)
  ok(!ringBefore, 'D11e 就绪态无环（保持横条）')
  // 点「开始」→ 专注态：环出现 + 重置钮出现（按钮随状态变）+ 主钮文案变「暂停」
  await evalJs(`(() => { document.querySelector('[data-wb="pomoMain"]')?.click(); return true })()`)
  await sleep(1200)
  const ringAfter = await evalJs(`!!document.querySelector('[data-wb="pomoRing"]')`)
  const resetShown = await evalJs(`!!document.querySelector('[data-wb="pomoReset"]')`)
  const mainTxt = await evalJs(`document.querySelector('[data-wb="pomoMain"]')?.textContent ?? ''`)
  ok(ringAfter, 'D11f 专注态出现环形进度（环围着倒计时）')
  ok(resetShown && mainTxt === '暂停', 'D11g 按钮随状态变（专注中 = 暂停 + 重置）', `main=${mainTxt} reset=${resetShown}`)
  // 收尾：暂停 + 重置（不留运行中的计时器）
  await evalJs(`(() => { document.querySelector('[data-wb="pomoMain"]')?.click(); return true })()`)
  await sleep(400)
  await evalJs(`(() => { document.querySelector('[data-wb="pomoReset"]')?.click(); return true })()`)
  await sleep(400)

  // D12 底层 UI 统一（2026-09-17 第三轮反馈）：右栏外壳对齐左栏 + 番茄钟层级收敛 + 标题图标
  const align = await evalJs(`(() => {
    const shell = document.querySelector('[data-wb="shell"]')
    const kids = shell ? [...shell.children] : []
    const l = kids[0], r = kids[kids.length - 1]
    if (!l || !r) return null
    const pick = (el) => { const c = getComputedStyle(el); return c.margin + '|' + c.borderTopLeftRadius + '|' + c.borderTopWidth + '|' + c.backgroundColor }
    return { left: pick(l), right: pick(r) }
  })()`)
  ok(!!align && align.left === align.right, 'D12 右栏外壳与左栏同款卡片（margin/圆角/边框/底色逐项一致）', JSON.stringify(align))
  const layers = await evalJs(`(() => {
    const btn = document.querySelector('[data-wb="pomoMain"]')
    if (!btn) return -1
    let n = 0, el = btn
    while (el && el !== document.body) {
      const c = getComputedStyle(el)
      if (parseFloat(c.borderTopWidth) > 0 && parseFloat(c.borderTopLeftRadius) > 0) n++
      el = el.parentElement
    }
    return n
  })()`)
  ok(layers === 2, 'D12b 番茄钟只余两层带边框容器（外壳卡 + 下段容器；卡中卡已消除）', 'layers=' + layers)
  const briefTone = await evalJs(`getComputedStyle(document.querySelector('[data-wb="widgetBrief"]')).backgroundColor`)
  const cardTone = await evalJs(`getComputedStyle(document.querySelector('[data-wb="shell"] > div:last-child')).backgroundColor`)
  ok(briefTone !== cardTone, 'D12c 下段内容层与外壳卡底色分层（bg-primary vs bg-secondary）', briefTone + ' vs ' + cardTone)
  const titleIcon = await evalJs(`(() => {
    const brief = document.querySelector('[data-wb="widgetBrief"]')
    const sw = document.querySelector('[data-wb="widgetSwitch"]')
    if (!brief || !sw) return 'missing'
    const cs = getComputedStyle(brief)
    return parseFloat(cs.borderTopWidth) === 0 ? 'ok' : 'brief-has-border'
  })()`)
  ok(titleIcon === 'ok', 'D12d 简略视图自身不画边框（切换条在段容器内，避免卡中卡）', titleIcon)

  console.log('\n========================================')
  const fails = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.label}${r.detail ? '  → ' + r.detail : ''}`)
  console.log(fails.length === 0 ? `\n✅ ${results.length} 项全 PASS` : `\n❌ ${fails.length}/${results.length} FAIL`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针失败:', e.message); process.exit(2) })
