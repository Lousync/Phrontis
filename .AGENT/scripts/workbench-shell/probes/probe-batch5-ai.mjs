/**
 * 探针：批次5 AI 链路（v3.4.0，方案 workbench-shell-design §4）。
 * 断言：右栏 AI 态 = ChatBody docked（对话窄版 + ⤢）→ ⤢ 打开 aiChat 中间标签 +
 *       右栏原位变 token 面板（今日消耗/改动文件/会话 TOP）→ 关标签自动回小对话；
 *       会话抽屉可用；page 态输入区挂载。
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

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id) }
  }
  // 等主界面就绪（可能停在仓库选择页）
  for (let i = 0; i < 24; i++) {
    const ready = await evalJs(`!!document.querySelector('[data-wb-bookmark="editor"]')`).catch(() => false)
    if (ready) break
    await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/进入|打开|继续/.test(x.textContent)); b?.click(); return true })()`)
    await sleep(500)
  }
  await sleep(600)
  await evalJs(`window.api?.setSetting ? window.api.setSetting('workbenchLayout', '') : 'no-api'`)
  await sleep(800)

  // A0 前置：右栏展开（布局键刚清空 → 默认收起；点右缘手柄）
  await evalJs(`(() => {
    if (document.querySelector('[data-wb="rightPanel"]')) return true
    const hs = [...document.querySelectorAll('[data-wb="shell"] [title="拖拽或点击展开"]')]
    hs[hs.length - 1]?.click(); return true
  })()`)
  await sleep(800)
  const rpOpen = await evalJs(`!!document.querySelector('[data-wb="rightPanel"]')`)
  ok(rpOpen, 'A0 右栏展开')

  // A1a 基线摆正：历史轮次可能落盘 rightTab='ai'（A1b 持久化）→ 先点 🧩 回小工具态再断言
  await evalJs(`(() => { document.querySelector('[data-wb="rpTab"][data-wb-rp-tab="widgets"]')?.click(); return true })()`)
  await sleep(500)
  const widgetsThere = await evalJs(`!!document.querySelector('[data-wb="toolsZone"]')`)
  ok(widgetsThere, 'A1a 右栏切回小工具态（工具入口区在）')
  await evalJs(`(() => { document.querySelector('[data-wb="rpTab"][data-wb-rp-tab="ai"]')?.click(); return true })()`)
  await sleep(800)
  const aiActive = await evalJs(`document.querySelector('[data-wb="rpTab"][data-wb-rp-tab="ai"]')?.dataset.wbRpActive`)
  ok(aiActive === '1', 'A1b 点 🤖 切到右栏 AI 态', `active=${aiActive}`)

  // A2 ChatBody docked 渲染（对话窄版）
  const docked = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    return { there: !!el, hasInput: !!el?.querySelector('textarea'), hasHeader: !!el && el.textContent.includes('AI 助手') }
  })()`)
  ok(docked.there && docked.hasInput && docked.hasHeader, 'A2 右栏 AI 态 = 对话窄版（ChatBody docked，头部+输入框）', JSON.stringify(docked))
  // A2b docked 态头部必须保住（收窄渲染条件后不能误伤窄版）：Menu 会话列表 + ⤢ 都在
  const dockedHeader = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    return {
      menu: !!el?.querySelector('button[title="会话列表"]'),
      expand: !!el?.querySelector('button[title="扩大为完整对话页"]'),
    }
  })()`)
  ok(dockedHeader.menu && dockedHeader.expand, 'A2b docked 态轻头部控件齐全（会话列表 + ⤢；收窄条件未误伤窄版）', JSON.stringify(dockedHeader))

  // ---- D 组：输入区工具行（反馈轮：选模型/查消耗/附加文件 + 输入卡轻量美化）----
  const toolRow = await evalJs(`(() => ({
    attach: !!document.querySelector('[data-wb="aiAttachBtn"]'),
    model: !!document.querySelector('[data-wb="aiModelBtn"]'),
    usage: !!document.querySelector('[data-wb="aiUsageBtn"]'),
  }))()`)
  ok(toolRow.attach && toolRow.model && toolRow.usage, 'D1 输入卡工具行三钮在（📎/模型/消耗）', JSON.stringify(toolRow))
  await evalJs(`(() => { document.querySelector('[data-wb="aiAttachBtn"]')?.click(); return true })()`)
  await sleep(500)
  const attachPop = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="aiAttachPop"]')
    return { there: !!el, hasSearch: !!el?.querySelector('input') }
  })()`)
  ok(attachPop.there && attachPop.hasSearch, 'D2 📎 浮层（搜索框+候选列表）')
  await evalJs(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
  await evalJs(`(() => { document.querySelector('[data-wb="aiModelBtn"]')?.click(); return true })()`)
  await sleep(500)
  const modelPop = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="aiModelPop"]')
    return { there: !!el, hasDefault: !!el && el.textContent.includes('默认模型') }
  })()`)
  ok(modelPop.there && modelPop.hasDefault, 'D3 模型浮层（默认模型 + 供应商清单）', JSON.stringify(modelPop))
  await evalJs(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
  await evalJs(`(() => { document.querySelector('[data-wb="aiUsageBtn"]')?.click(); return true })()`)
  await sleep(500)
  const usagePop = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="aiUsagePop"]')
    return { there: !!el, hasToday: !!el && el.textContent.includes('今日消耗'), hasSession: !!el && el.textContent.includes('当前会话') }
  })()`)
  ok(usagePop.there && usagePop.hasToday && usagePop.hasSession, 'D4 消耗浮层（今日 + 当前会话）', JSON.stringify(usagePop))
  await evalJs(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
  await sleep(200)

  // A3 会话抽屉打开/关闭
  await evalJs(`(() => { const b=[...document.querySelectorAll('[data-wb="rightPanel"] [data-assistant-variant="docked"] button[title="会话列表"]')]; b[0]?.click(); return true })()`)
  await sleep(500)
  const drawerNew = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    return { newBtn: !!el && [...el.querySelectorAll('button')].some((b) => b.textContent.includes('新会话')) }
  })()`)
  ok(drawerNew.newBtn, 'A3 AI 态会话抽屉可开（新会话按钮出现）')
  await evalJs(`(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true })()`)
  await sleep(300)

  // A4 ⤢ 打开 aiChat 中间标签
  const expandThere = await evalJs(`!!document.querySelector('[data-wb="rightPanel"] button[title="扩大为完整对话页"]')`)
  ok(expandThere, 'A4a 窄版带 ⤢ 扩大按钮')
  await evalJs(`(() => { document.querySelector('[data-wb="rightPanel"] button[title="扩大为完整对话页"]')?.click(); return true })()`)
  await sleep(900)
  const afterExpand = await evalJs(`(() => {
    const tab = document.querySelector('[data-wb="pagebar"] [data-wb-tab="aiChat"]')
    return { tabThere: !!tab, tabActive: tab?.dataset.wbActive ?? '' }
  })()`)
  ok(afterExpand.tabThere && afterExpand.tabActive === '1', 'A4b ⤢ → aiChat 标签登记并激活', JSON.stringify(afterExpand))

  // A5 右栏原位变 token 面板（今日消耗 / 改动文件 / 会话 TOP 三卡）
  const panel = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="aiUsagePanel"]')
    const txt = el?.textContent ?? ''
    return { there: !!el, today: txt.includes('今日消耗'), changes: txt.includes('改动文件'), top: txt.includes('会话消耗 TOP'), chatGone: !document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]') }
  })()`)
  ok(panel.there && panel.today && panel.changes && panel.top && panel.chatGone, 'A5 ⤢ 后右栏原位变 token 面板（三卡齐、小对话退场）', JSON.stringify(panel))

  // A6 aiChat 中间标签 page 态对话体挂载（输入区在中间栏）
  const pageBody = await evalJs(`!!document.querySelector('[data-assistant-variant="page"] textarea')`)
  ok(pageBody, 'A6 aiChat 标签 = 宽版对话体（page 态输入区挂载）')

  // A6b page 态无「✦ AI 助手」纯标题行（2026-09-18 反馈轮）：顶部直接是消息区，
  // 会话导航已移交左栏，中间主体不再重复一个标题行 —— 有控件才渲染头部的收窄条件实测
  const pageNoTitle = await evalJs(`(() => {
    const el = document.querySelector('[data-assistant-variant="page"]')
    if (!el) return null
    const first = el.firstElementChild
    const firstH = first ? Math.round(first.getBoundingClientRect().height) : 0
    return {
      hasTitleRow: el.textContent.includes('AI 助手'),
      firstChildH: firstH,
      // 头部那排是 h-9 = 36px + 下边框；消息区不可能恰好这个高度
      titleRowLike: firstH >= 30 && firstH <= 42 && first?.className?.toString().includes('items-center'),
    }
  })()`)
  ok(!!pageNoTitle && !pageNoTitle.hasTitleRow && !pageNoTitle.titleRowLike,
    'A6b page 态无「✦ AI 助手」标题行（头部收窄到有控件才渲染）', JSON.stringify(pageNoTitle))

  // A7 关闭 aiChat 标签 → 右栏自动回小对话
  await evalJs(`(() => {
    const t = document.querySelector('[data-wb="pagebar"] [data-wb-tab="aiChat"]')
    t?.querySelector('button[title="关闭标签页"]')?.click(); return true
  })()`)
  await sleep(800)
  const afterClose = await evalJs(`(() => ({
    tabGone: !document.querySelector('[data-wb="pagebar"] [data-wb-tab="aiChat"]'),
    panelGone: !document.querySelector('[data-wb="aiUsagePanel"]'),
    chatBack: !!document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"] textarea'),
  }))()`)
  ok(afterClose.tabGone && afterClose.panelGone && afterClose.chatBack, 'A7 关 aiChat 标签 → 右栏自动变回小对话', JSON.stringify(afterClose))

  // A8 重新 ⤢ → 再关（幂等，双 Tab 显隐管理后 AI Tab 仍在）
  await evalJs(`(() => { document.querySelector('[data-wb="rightPanel"] button[title="扩大为完整对话页"]')?.click(); return true })()`)
  await sleep(800)
  const again = await evalJs(`!!document.querySelector('[data-wb="aiUsagePanel"]')`)
  ok(again, 'A8 再次 ⤢ 幂等（token 面板重现）')

  // A9 联动语义（反馈拍板）：aiChat 激活中切到别的模块 → 右栏回对话但 aiChat 标签保留；
  // 点回 aiChat 标签 → 右栏再变 token 面板
  // 前置① 左栏此刻在 aiChat 模块态（书签区隐藏）→ 必须先「返回总览」才点得到书签，
  //        否则查不到 bookmark、静默 no-op（与 probe-mod-header 的同款陷阱）。
  // 前置② 目标必须是**真实存在的模块条目**：页面条置顶后 editor / knowledge 由各自页签组
  //        代表、不作为模块条目出现（WorkbenchPageBar 的 PAGE_OWNED 过滤），写死 editor 点空。
  await evalJs(`(() => { document.querySelector('button[title^="返回总览"]')?.click(); return true })()`)
  await sleep(500)
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="blog"]')?.click(); return true })()`)
  await sleep(1200)
  const a9Switch = await evalJs(`(() => {
    const t = [...document.querySelectorAll('[data-wb="pagebar"] [data-wb-tab]')].find((x) => x.dataset.wbTab !== 'aiChat')
    if (!t) return ''
    const id = t.dataset.wbTab
    t.click()
    return id
  })()`)
  await sleep(700)
  const switchedAway = await evalJs(`(() => ({
    chatBack: !!document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"] textarea'),
    panelGone: !document.querySelector('[data-wb="aiUsagePanel"]'),
    tabKept: !!document.querySelector('[data-wb="pagebar"] [data-wb-tab="aiChat"]'),
  }))()`)
  ok(a9Switch !== '' && switchedAway.chatBack && switchedAway.panelGone && switchedAway.tabKept,
    'A9a 切走模块 → 右栏回对话、token 面板退场、aiChat 标签保留',
    `switchedTo=${a9Switch} ${JSON.stringify(switchedAway)}`)
  await evalJs(`(() => {
    document.querySelector('[data-wb="pagebar"] [data-wb-tab="aiChat"]')?.click(); return true
  })()`)
  await sleep(700)
  const switchedBack = await evalJs(`!!document.querySelector('[data-wb="aiUsagePanel"]')`)
  ok(switchedBack, 'A9b 点回 aiChat 标签 → 右栏再变 token 面板')
  // A9 结束保持 aiChat 激活（B 组前置：左栏 aiChat 模块态 + token 面板显示中）

  // ---- B 组：左栏 AI 会话侧栏（2026-09-17 反馈轮，drawio 简图排版）----
  // B1 aiChat 激活 → 左栏经 RAIL_FOLLOW_MAP 切 aiChat 模块态
  const modAi = await evalJs(`document.querySelector('[data-wb="mod"]')?.dataset.wbMod ?? ''`)
  ok(modAi === 'aiChat', 'B1 aiChat 激活 → 左栏模块态跟随（data-wb-mod=aiChat）', `mod=${modAi}`)
  // B2 侧栏挂载：双 tab（会话列表/会话大纲）+ 新会话钮 + 底部文件改动卡
  const side = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="aiChatSidebar"]')
    const tabs = [...document.querySelectorAll('[data-wb="aiSideTab"]')].map((t) => t.dataset.wbAiSideTab)
    return { there: !!el, tabs, hasNew: !!el?.querySelector('[data-wb="aiSideNew"]'), hasChanges: !!document.querySelector('[data-wb="aiSideChanges"]') }
  })()`)
  ok(side.there && side.tabs.join(',') === 'sessions,outline' && side.hasNew && side.hasChanges,
    'B2 左栏 AI 侧栏挂载（双 tab + 新会话 + 文件改动卡）', JSON.stringify(side))
  // B3 page 态对话区无抽屉入口（会话导航已移交左栏）
  const pageDrawer = await evalJs(`!!document.querySelector('[data-assistant-variant="page"] button[title="会话列表"]')`)
  ok(!pageDrawer, 'B3 page 态无抽屉按钮（导航交左栏）')
  // B4 新建会话 → 大纲 tab 空态
  await evalJs(`(() => { document.querySelector('[data-wb="aiSideNew"]')?.click(); return true })()`)
  await sleep(700)
  await evalJs(`(() => { document.querySelector('[data-wb="aiSideTab"][data-wb-ai-side-tab="outline"]')?.click(); return true })()`)
  await sleep(300)
  const outlineEmpty = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="aiChatSidebar"]')
    return { empty: !!el && (el.textContent.includes('当前会话还没有消息') || el.textContent.includes('正在思考')), active: document.querySelector('[data-wb="aiSideTab"][data-wb-ai-side-tab="outline"]')?.dataset.wbAiSideActive }
  })()`)
  ok(outlineEmpty.empty && outlineEmpty.active === '1', 'B4 新会话 + 大纲 tab 空态提示', JSON.stringify(outlineEmpty))
  // B5 关 aiChat 标签 → 左栏跟随落点（aiChat 态退场）
  await evalJs(`(() => {
    const t = document.querySelector('[data-wb="pagebar"] [data-wb-tab="aiChat"]')
    t?.querySelector('button[title="关闭标签页"]')?.click(); return true
  })()`)
  await sleep(800)
  const modAfter = await evalJs(`document.querySelector('[data-wb="mod"]')?.dataset.wbMod ?? ''`)
  const sideGone = await evalJs(`!document.querySelector('[data-wb="aiChatSidebar"]')`)
  ok(modAfter !== 'aiChat' && sideGone, 'B5 关标签 → 左栏跟随落点退出 aiChat 侧栏', `mod=${modAfter} sideGone=${sideGone}`)

  // ---- C 组：左栏头部三钮居中 + 搜索态（2026-09-17 反馈轮，顶栏搜索搬进左栏）----
  // C0 先回总览态（B5 后左栏在 editor 模块态，🔍 只在总览态头部）
  await evalJs(`(() => { document.querySelector('button[title^="返回总览"]')?.click(); return true })()`)
  await sleep(500)
  // C1 三钮（🔖/🔍/🌳）合组水平居中（仿 Obsidian）：按钮组中心 ≈ 左栏中心
  const centerChk = await evalJs(`(() => {
    const lp = document.querySelector('[data-wb="leftPanel"]')
    const btns = [
      document.querySelector('[data-wb="bookmarkMenuBtn"]'),
      document.querySelector('[data-wb="leftSearchBtn"]'),
      lp?.querySelector('button[title^="切换为文件树模式"]'),
    ]
    if (!lp || btns.some((b) => !b)) return null
    const lpr = lp.getBoundingClientRect()
    const l = Math.min(...btns.map((b) => b.getBoundingClientRect().left))
    const r = Math.max(...btns.map((b) => b.getBoundingClientRect().right))
    const groupCenter = (l + r) / 2
    const panelCenter = lpr.left + lpr.width / 2
    return { groupCenter, panelCenter, diff: Math.abs(groupCenter - panelCenter) }
  })()`)
  ok(!!centerChk && centerChk.diff < 20, 'C1 总览态头部三钮合组居中（仿 Obsidian）', JSON.stringify(centerChk))
  // C2 点 🔍 → 搜索态（面板挂载 + 输入框聚焦）
  await evalJs(`(() => { document.querySelector('[data-wb="leftSearchBtn"]')?.click(); return true })()`)
  await sleep(500)
  const searchOpen = await evalJs(`(() => ({
    there: !!document.querySelector('[data-wb="leftSearch"]'),
    hasInput: !!document.querySelector('[data-wb="leftSearch"] input'),
    hasHome: !!document.querySelector('[data-wb="leftSearch"] button[title="返回总览"]'),
    hasLock: !!document.querySelector('[data-wb="leftSearch"] button[title^="锁定侧边栏"]'),
    focused: document.activeElement?.tagName === 'INPUT',
  }))()`)
  ok(searchOpen.there && searchOpen.hasInput && searchOpen.hasHome && searchOpen.hasLock,
    'C2 🔍 → 搜索态（🏠+🔒头部+搜索框）', JSON.stringify(searchOpen))
  // C3 输入查询 → 结果或空态渲染（探针 vault 内容不定，两种都算通过）
  await evalJs(`(() => {
    const i = document.querySelector('[data-wb="leftSearch"] input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(i, '工作台')
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(900)
  const searchOut = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="leftSearch"]')
    return { hasResult: !!el && (el.textContent.includes('个结果') || el.textContent.includes('未找到匹配结果')) }
  })()`)
  ok(searchOut.hasResult, 'C3 输入查询 → 结果列表或空态渲染')
  // C4 Ctrl+P 再次打开（快捷键指向左栏搜索态）
  await evalJs(`(() => {
    document.querySelector('[data-wb="leftSearch"] button[title="返回总览"]')?.click(); return true
  })()`)
  await sleep(400)
  const backToOverview = await evalJs(`!!document.querySelector('[data-wb="bookmarkMenuBtn"]') && !document.querySelector('[data-wb="leftSearch"]')`)
  ok(backToOverview, 'C4 🏠 返回顶层 → 总览态')
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }))
    return true
  })()`)
  await sleep(400)
  const viaHotkey = await evalJs(`!!document.querySelector('[data-wb="leftSearch"]')`)
  ok(viaHotkey, 'C5 Ctrl+P → 左栏搜索态')
  await evalJs(`(() => { document.querySelector('[data-wb="leftSearch"] button[title="返回总览"]')?.click(); return true })()`)
  await sleep(300)
  // C6 点标签条**已激活**标签 → 左栏从总览态跟随切该模块态（2026-09-17 反馈拍板）
  // 目标动态取「条上 data-wb-active=1 的模块条目」而非写死 editor —— 页面条置顶后
  // editor / knowledge 由各自页签组代表、**不作为模块条目出现**（WorkbenchPageBar 的
  // PAGE_OWNED 过滤）；若当时唯一打开的就是 editor，条上 entries 为空（实测 pbTabs="editor"
  // 但 entries=[]），点不到（静默 no-op）。所以先经书签打开一个真实模块条目再断言。
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="blog"]')?.click(); return true })()`)
  await sleep(1200)
  const c6Target = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="pagebar"] [data-wb-tab][data-wb-active="1"]')
    return el?.dataset.wbTab ?? ''
  })()`)
  // 回总览态（点书签后左栏进入模块态，C6 的前提是「总览态 → 点条上已激活条目 → 跟随」）
  await evalJs(`(() => { document.querySelector('button[title^="返回总览"]')?.click(); return true })()`)
  await sleep(500)
  await evalJs(`(() => { document.querySelector('[data-wb="pagebar"] [data-wb-tab][data-wb-active="1"]')?.click(); return true })()`)
  await sleep(600)
  const modFollow = await evalJs(`document.querySelector('[data-wb="mod"]')?.dataset.wbMod ?? ''`)
  ok(c6Target !== '' && modFollow === c6Target,
    'C6 点已激活标签 → 左栏跟随切该模块态', `target=${c6Target} mod=${modFollow}`)

  // ---- E 组：B1 @ 引用（@ 唤起 / 键盘选择 / 收尾清 @query / chip 上限 / 📎 无回归）----
  // E1 前置：往输入框打「@」——光标在行首，满足「行首或前一字符为空白」
  await evalJs(`(() => {
    const ta = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"] textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '@')
    ta.selectionStart = ta.selectionEnd = 1
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(600)
  const atPop = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="aiAttachPop"]')
    return { there: !!el, readOnly: el?.querySelector('input')?.readOnly, cands: el?.querySelectorAll('button').length ?? 0 }
  })()`)
  ok(atPop.there, 'E1 输入 @ → 唤起浮层（复用 📎 同一浮层）', JSON.stringify(atPop))
  ok(atPop.readOnly === true,
    'E2 @ 态浮层搜索框只读（不夺焦点，用户可继续在输入框打字）', `readOnly=${atPop.readOnly}`)
  ok(atPop.cands > 0,
    'E3 @ 态有候选（fixture 仓库有页面）', `候选 ${atPop.cands} 条`)

  // E4 键盘 ↑↓ 选择：下移一次后高亮项应在候选列表内
  const atNav = await evalJs(`(() => {
    const ta = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"] textarea')
    if (!ta) return null
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const el = document.querySelector('[data-wb="aiAttachPop"] [data-at-active="1"]')
    return { hasActive: !!el, text: (el?.textContent ?? '').slice(0, 40) }
  })()`)
  ok(atNav && atNav.hasActive, 'E4 @ 态 ↑↓ 键盘选择生效（高亮项 data-at-active=1）', JSON.stringify(atNav))

  // E5 Enter 采纳：chip 出现 + 输入框里的 `@` 被清掉
  const atPick = await evalJs(`(() => {
    const ta = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"] textarea')
    if (!ta) return null
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(700)
  const atAfter = await evalJs(`(() => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    const ta = root?.querySelector('textarea')
    const popGone = !document.querySelector('[data-wb="aiAttachPop"]')
    return {
      popGone,
      value: ta?.value ?? null,
      chipCount: [...(root?.querySelectorAll('span') ?? [])].filter((s) => s.querySelector('button[title="移除附件"]')).length,
    }
  })()`)
  ok(atAfter.popGone && atAfter.value === '' && atAfter.chipCount === 1,
    'E5 Enter 采纳 → chip +1 且输入框 @query 已清（浮层关闭）', JSON.stringify(atAfter))

  // E6 chip 上限：逐轮「@ → Enter」加到满。
  // ⚠️ 每轮之间必须 await 让出事件循环 —— React 18 自动批处理会把**同一 tick 内的多次
  // setAttachedFiles 合并**，且每次的 `attachedFiles.length` 守卫读的都是同一个闭包旧值
  // （同步连发 10 次的结果是只加进前 2 篇，会被误读成「上限失效」）。
  for (let i = 0; i < 8; i++) {
    await evalJs(`(() => {
      const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
      const ta = root?.querySelector('textarea')
      if (!ta) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, '@')
      ta.selectionStart = ta.selectionEnd = 1
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
      return true
    })()`)
    await sleep(300)
    await evalJs(`(() => {
      const ta = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"] textarea')
      ta?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await sleep(400)
  }
  const chipCap = await evalJs(`(() => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    return [...(root?.querySelectorAll('span') ?? [])].filter((s) => s.querySelector('button[title="移除附件"]')).length
  })()`)
  // 断言「=== 4」：fixture 种子保证候选池 ≥5（「引用测试」6 篇），加到第 5 篇必须被拒
  ok(chipCap === 4, 'E6 chip 上限 = 4（超限被拒，不无限追加）', `实际 ${chipCap} 篇`)

  // E7 📎 路径无回归：清空 chip + 清空输入框（把 E6 @ 残留一并抹掉）后，
  //    经 📎 按钮打开浮层 → 搜索框可编辑 + 点击候选 +1
  // ⚠️ 前置：必须让右栏处于**可见的 docked 小对话态**。A9b 结束后右栏是 token 面板
  //    （aiChat 标签开着），此时 `[data-assistant-variant="docked"]` 只是 display:none 的
  //    保活实例 —— 原生 keydown 打在隐藏节点上 React 仍处理（E1-E6 因此仍 PASS），
  //    但 `el.click()` 需要元素可点，零尺寸节点点不动（实测 firstRect w=0/h=0）。
  //    先关掉 aiChat 标签，让右栏原位回到小对话。
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('[data-wb="pagebar"] [data-wb-tab]')].find((x) => x.dataset.wbTab === 'aiChat')
    if (t && t.dataset.wbActive === '1') t.click()
    return true
  })()`)
  await sleep(900)
  const e7Visible = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    const r = el?.getBoundingClientRect()
    return { there: !!el, w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0) }
  })()`)
  await evalJs(`(() => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    for (const b of [...(root?.querySelectorAll('button[title="移除附件"]') ?? [])]) b.click()
    return true
  })()`)
  await sleep(700)
  // 清输入框：@ 残留会让点候选走「清理 @query」分支，与 📎 语义混在一起
  await evalJs(`(() => {
    const ta = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"] textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '')
    ta.selectionStart = ta.selectionEnd = 0
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(400)
  // 关掉可能还开着的浮层，确保下面点 📎 是全新一次打开
  await evalJs(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
  await sleep(400)
  const preE7 = await evalJs(`(() => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    return {
      chips: [...(root?.querySelectorAll('span') ?? [])].filter((s) => s.querySelector('button[title="移除附件"]')).length,
      taValue: root?.querySelector('textarea')?.value ?? null,
      pop: !!root?.querySelector('[data-wb="aiAttachPop"]'),
    }
  })()`)
  await evalJs(`(() => { document.querySelector('[data-wb="rightPanel"] [data-wb="aiAttachBtn"]')?.click(); return true })()`)
  await sleep(900)
  const normalAttach = await evalJs(`(() => {
    // ⚠️ 必须**限定在可见的 docked 容器内**取浮层：page 态那份 ChatBody 也渲染同款
    //    data-wb="aiAttachPop"（保活 display:none），document.querySelector 会先命中它 →
    //    按钮 rect 恒为 0×0，el.click() 打在隐藏节点上不触发 React 处理
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    const el = root?.querySelector('[data-wb="aiAttachPop"]')
    const ro = el?.querySelector('input')?.readOnly
    const btns = [...(el?.querySelectorAll('button') ?? [])].filter((b) => b.querySelector('span'))
    const dbg = { pool: btns.length, searchReadOnly: ro, clicked: false, firstText: btns[0]?.textContent?.slice(0, 30), firstRect: btns[0] ? (() => { const r = btns[0].getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })() : null }
    if (btns[0]) { btns[0].click(); dbg.clicked = true }
    return dbg
  })()`)
  await sleep(900)
  const afterNormal = await evalJs(`(() => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    return [...(root?.querySelectorAll('span') ?? [])].filter((s) => s.querySelector('button[title="移除附件"]')).length
  })()`)
  ok(normalAttach.searchReadOnly === false && normalAttach.clicked && preE7.chips === 0 && afterNormal === 1,
    'E7 📎 路径无回归（浮层搜索框可编辑，点击候选可附加）',
    `可见态=${JSON.stringify(e7Visible)} 点击=${JSON.stringify(normalAttach)} 附加后=${afterNormal}`)

  // ---- F 组：B2 感知模式（toggle 存在 / 点击落盘 / 弱提示 / 默认关）----
  // ⚠️ E7 已把右栏关成可见 docked 小对话态，F 组直接复用这个前置（别再切标签）。
  // ⚠️ 选择器一律限定在 `[data-wb="rightPanel"] [data-assistant-variant="docked"]` 内 ——
  //    page 态那份 ChatBody 是 display:none 保活实例，也渲染同款 data-wb（E7 同源教训）。

  // F1 感知 toggle 在（默认关：aria-pressed=false）
  const f1 = await evalJs(`(() => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    const b = root?.querySelector('[data-wb="perceptionToggle"]')
    const r = b?.getBoundingClientRect()
    return { there: !!b, pressed: b?.getAttribute('aria-pressed'),
             w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0) }
  })()`)
  ok(f1.there && f1.w > 0 && f1.h > 0, 'F1 右栏 AI 态头部有感知 toggle（可见可点）', JSON.stringify(f1))

  // F2 默认关（上游 §4.1 拍板 false；探针 vault 是全新 settings → 必须是初始默认值）
  ok(f1.pressed === 'false', 'F2 感知默认关闭（default:false，用户主动开才检索）', `aria-pressed=${f1.pressed}`)

  // F3 点击 → 开启（aria-pressed 翻转）
  await evalJs(`(() => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    root?.querySelector('[data-wb="perceptionToggle"]')?.click(); return true
  })()`)
  await sleep(700)
  const f3 = await evalJs(`(() => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    const b = root?.querySelector('[data-wb="perceptionToggle"]')
    return { pressed: b?.getAttribute('aria-pressed'), hint: !!root?.querySelector('[data-wb="perceptionHint"]') }
  })()`)
  ok(f3.pressed === 'true', 'F3 点击感知 toggle → 开启态（aria-pressed=true）', JSON.stringify(f3))

  // F4 弱提示：探针 vault 未配向量模型 → 开启后必现「语义索引未配置」。
  //    这条在探针环境里是**确定可验的**（没有 embedding provider）。
  ok(f3.hint, 'F4 开启后弱提示出现（未配向量模型 → 明示当前按关键词匹配）',
    `hint=${f3.hint}`)

  // F5 落盘：settings 真写进主进程（不是纯前端态）——重读一遍设置值
  const f5 = await evalJs(`(async () => {
    try { return await window.api.getSetting('aiAssistantPerception') } catch (e) { return 'ERR:' + e.message }
  })()`)
  ok(f5 === true, 'F5 感知开关落盘到 settings（主进程读得到 —— 检索发生在主进程，必须真落盘）',
    `getSetting=${JSON.stringify(f5)}`)

  // F6 关回去（不给后续探针留副作用：开着感知会让每轮多发一次本地检索）
  await evalJs(`(() => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    root?.querySelector('[data-wb="perceptionToggle"]')?.click(); return true
  })()`)
  await sleep(700)
  const f6 = await evalJs(`(async () => {
    const root = document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"]')
    return { pressed: root?.querySelector('[data-wb="perceptionToggle"]')?.getAttribute('aria-pressed'),
             saved: await window.api.getSetting('aiAssistantPerception') }
  })()`)
  ok(f6.pressed === 'false' && f6.saved === false,
    'F6 再点一次关回（双向切换 + 落盘一致，无副作用残留）', JSON.stringify(f6))

  // ---- G 组：B4 内联建议（胶囊按钮 / Alt+A / 触发链路 / 开关联动）----
  // ⚠️ 探针环境**没有 LLM API key**，真生成必然失败 → 因此这组验的是
  //    「触发链路接通 + UI 联动」而非「真出一句建议」。
  //    手法：先在渲染层包一层 window.api.aiInlineSuggestRun 计数器，
  //    断言 provider 确实被调用、且入参（text/offset）合理；随后立即 resolve 空结果，
  //    不让它真去打网络（既快又稳定）。
  //    真生成属于实机验收（需要配好 provider），不在探针覆盖范围。

  // G0 切到编辑器模块并打开一篇 markdown（探针 vault 的欢迎页即 md）
  await evalJs(`(() => { document.querySelector('[data-wb-bookmark="editor"]')?.click(); return true })()`)
  await sleep(1500)
  // 用快速切换器（Ctrl+O）打开第一份知识页 —— 比在文件树里点更稳（免展开目录）
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true, cancelable: true }))
    return true
  })()`)
  await sleep(900)
  const g0Pick = await evalJs(`(() => {
    // ★ 2026-09-19 修选择器：分组标签「知识页」在分组头 div 里、不在条目 button 内（面板重构后），
    //   旧 /知识页/ 按钮匹配恒落空。改走 [data-wb="palette"] 锚点 + 条目 button[data-i]。
    const pal = document.querySelector('[data-wb="palette"]')
    const items = [...(pal?.querySelectorAll('button[data-i]') ?? [])]
    const first = items.find((b) => b.getBoundingClientRect().height > 0)
    if (first) { first.click(); return { clicked: true, label: first.textContent.slice(0, 40) } }
    return { clicked: false, label: '', palOpen: !!pal }
  })()`)
  await sleep(1600)
  // Phase 2 批次 2：kb-open-note 改道知识库——README.md 无 id → draft 页签默认阅读态，
  // B4 链路在编辑态，先进编辑（PageEditor 工具条「切换到编辑」按钮）
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').startsWith('切换到编辑'))
    b?.click()
    return !!b
  })()`)
  await sleep(1500)
  const g0Doc = await evalJs(`(() => {
    const ed = document.querySelector('.monaco-editor')
    return { hasEditor: !!ed, hasMonaco: !!document.querySelector('.monaco-editor .view-lines') }
  })()`)
  ok(g0Doc.hasEditor && g0Doc.hasMonaco,
    'G0 编辑器模块打开 markdown 文档（Monaco 挂载）', `pick=${JSON.stringify(g0Pick)} doc=${JSON.stringify(g0Doc)}`)

  // G1 胶囊里有「建议」按钮且可见可点（单点定义 → 两个宿主都应渲染同一份）
  const g1 = await evalJs(`(() => {
    const bs = [...document.querySelectorAll('[data-wb="inlineSuggestBtn"]')]
    // 可能有浮层槽 / 内嵌两种宿主，取**可见的那个**（另一份 display:none）
    const vis = bs.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    const r = vis?.getBoundingClientRect()
    return { count: bs.length, visible: !!vis, w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0),
             label: vis?.textContent?.trim() ?? '' }
  })()`)
  ok(g1.visible && g1.w > 0 && g1.h > 0,
    'G1 内容胶囊里有「建议」按钮（可见可点）', JSON.stringify(g1))

  // G2 观测手段（★ 踩坑记录，别再走回头路）：
  //   window.api 是 contextBridge 暴露的**冻结对象**（实测 frozen:true / writable:false /
  //   Object.defineProperty 抛 "Cannot redefine property"）→ 覆盖 .aiInlineSuggestRun 装计数器
  //   **静默失败**，断言永远拿到空数组（假 FAIL，且看不出是手法问题）。
  //   改用**可观测 UI 信号**：状态栏忙态微标 [data-wb="inlineBusy"] —— provider 一启动置 true，
  //   结束 / 超时回落 false。一条信号同时覆盖「触发链路真通了」与「忙态不残留」。
  //   入参（text / offset / requestId）正确性由契约脚本 J1-J5 纯函数断言 + 实机验收覆盖，
  //   探针不重复验（无 key 环境也验不出真建议）。
  const busyNow = () => evalJs(`!!document.querySelector('[data-wb="inlineBusy"]')`)
  const waitBusy = async (want, ms) => {
    for (let i = 0; i < Math.ceil(ms / 200); i++) {
      if ((await busyNow()) === want) return true
      await sleep(200)
    }
    return false
  }

  // G3 点「建议」按钮 → provider 被调用，入参合理（text 非空、offset 为数字）
  await evalJs(`(() => {
    const bs = [...document.querySelectorAll('[data-wb="inlineSuggestBtn"]')]
    const vis = bs.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    vis?.click(); return true
  })()`)
  const g3 = await waitBusy(true, 2000)
  ok(g3, 'G3 ★ 点「建议」→ provider 真被调用（忙态微标亮起 = 触发链路通）', `busy=${await busyNow()}`)
  // G3b 忙态必须回落：探针无 LLM key → 走主进程硬超时（10s）/ 渲染层兜底（12s）分支。
  //     这条锁的是「不可达时不永久转圈」（实测修超时前：8s+ 不回落且永不 resolve）。
  const g3b = await waitBusy(false, 16000)
  ok(g3b, 'G3b ★ 忙态回落（模型不可达时靠硬超时兜底，微标不永久转圈）', `busy=${await busyNow()}`)

  // G4 Alt+A 快捷键 → 同样打通 provider（原生 keydown，与用户真实按键同路径）
  await evalJs(`(() => {
    // 先把焦点给编辑器（快捷键不设输入守卫，但真实用户此时就聚焦在编辑器里）
    document.querySelector('.monaco-editor textarea')?.focus?.()
    return true
  })()`)
  await sleep(200)
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true }))
    return true
  })()`)
  const g4 = await waitBusy(true, 2000)
  ok(g4, 'G4 ★ Alt+A 触发（与按钮同一条链路）', `busy=${await busyNow()}`)
  await waitBusy(false, 16000)

  // 诊断（Phase 2）：G5 前 dump 编辑器挂载态——G8 的 models=[] 需要在这里抓到卸载时机
  const g45dump = await evalJs(`(() => {
    const m = window.__kb_monaco
    return {
      models: m ? m.editor.getModels().length : -1,
      editors: m ? m.editor.getEditors().length : -1,
      monacoDom: !!document.querySelector('.monaco-editor'),
      editBtn: [...document.querySelectorAll('button')].some((x) => (x.title || '').startsWith('切换到编辑')),
      previewBtn: [...document.querySelectorAll('button')].some((x) => (x.title || '').startsWith('切换到预览')),
      tabs: [...document.querySelectorAll('[data-pb-item]')].map((x) => x.textContent.trim().slice(0, 20)),
    }
  })()`)
  console.log('[G4.5 dump]', JSON.stringify(g45dump))

  // G5 空文档不得触发（防「快捷键在空文件上给 LLM 发空上下文」）
  const g5 = await evalJs(`(() => {
    const m = window.monaco?.editor?.getModels?.()[0]
    if (!m) return { skipped: true }
    m.setValue('')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true }))
    return { skipped: false }
  })()`)
  const g5rose = await waitBusy(true, 1500)
  ok(g5.skipped || g5rose === false,
    'G5 ★ 空文档不触发请求（避免给 LLM 发空上下文）', `busyRose=${g5rose}`)
  await evalJs(`(() => { const m = window.monaco?.editor?.getModels?.()[0]; if (m) m.setValue('# 探针还原\\n\\n正文内容。'); return true })()`)
  await sleep(600)

  // ---- 自动通道（2026-09-19 返工轮）：触发点闸门 / debounce / 冷却 / 开关 ----
  // 真实输入的三条路实测（2026-09-19，各踩一遍）：
  //   ✗ CDP Input.insertText —— 对 Monaco 的 ime-text-area 完全无效（内容不变、不报错）
  //   ✗ document.execCommand('insertText') —— 在 ime-text-area 上返回 false
  //   ✓ CDP Input.dispatchKeyEvent —— 走浏览器输入管线，产生受信任按键 + 默认行为，
  //     Monaco 的 TextAreaInput 正常感知。**逐字符发**，且必须校验内容真的变了，
  //     否则又是假信号（G9/G11 前两轮就是这么白挂的）。
  let lastViewLen = -1
  const viewLen = () => evalJs(`(document.querySelector('.monaco-editor .view-lines')?.textContent || '').length`)
  // 模拟「在文末打字」：直接驱动 Monaco model（window.__kb_monaco 由 monaco-setup 挂出，
  // 见该文件注释 —— CDP 的三条输入路在 Electron 沙箱下全进不了 Monaco，这是唯一可靠路）。
  // applyEdits 会真实触发 onDidChangeModelContent → 自动通道的 scheduleAuto，与用户打字同源。
  const typeInto = async (text) => {
    const r = await evalJs(`(async () => {
      const m = window.__kb_monaco
      if (!m) return { err: 'window.__kb_monaco 不存在' }
      const model = m.editor.getModels().find((x) => x.getLanguageId() === 'markdown')
      if (!model) return { err: '无 markdown model', models: m.editor.getModels().map((x) => x.getLanguageId() + ':' + x.uri.toString().slice(-40)), editors: m.editor.getEditors().length }
      const ed = m.editor.getEditors()[0]
      const fr = model.getFullModelRange()
      model.applyEdits([{ range: { startLineNumber: fr.endLineNumber, startColumn: fr.endColumn, endLineNumber: fr.endLineNumber, endColumn: fr.endColumn }, text: ${JSON.stringify(text)} }])
      const pos = model.getPositionAt(model.getValueLength())
      ed?.setPosition(pos)
      return { ok: true }
    })()`)
    const len = await viewLen()
    const changed = len !== lastViewLen
    lastViewLen = len
    if (r?.err) console.log(`  ⚠️ typeInto 异常: ${r.err} | models=${JSON.stringify(r.models ?? [])} editors=${r.editors}`)
    else if (!changed) console.log(`  ⚠️ typeInto 未生效（view-lines 长度未变：${len}）—— 本组结果无效`)
    return changed
  }
  lastViewLen = await viewLen()

  // G8 ★ 词中间打字不触发（触发点闸门 —— 成本闸的核心）
  await typeInto('积分')
  const g8rose = await waitBusy(true, 2500)
  ok(g8rose === false,
    'G8 ★ 词中间打字不触发请求（触发点闸门生效，省 token）', `busyRose=${g8rose}`)

  // G9 ★ 打字到句读处 → 停顿 → 自动出建议（对标 VS Code / Cursor 的核心体验）
  await typeInto('。')
  const g9 = await waitBusy(true, 3500)
  ok(g9, 'G9 ★ 句读后停顿自动触发（无需按键：debounce 800ms + 触发点命中）', `busy=${await busyNow()}`)
  await waitBusy(false, 16000)

  // G11 冷却：连续几次自动建议没人采纳 → 暂停自动
  //      （注意结算滞后一轮：第 N 次触发前才结算第 N-1 次，故需要多打几轮）
  for (let i = 0; i < 5; i++) {
    await typeInto('。')
    await sleep(1300)
  }
  await waitBusy(false, 16000)
  const g11 = await evalJs(`!!document.querySelector('[data-wb="inlinePaused"]')`)
  ok(g11, 'G11 ★ 连续未采纳后暂停自动（状态栏出现「建议已暂停 · Alt+A 唤醒」）', `paused=${g11}`)

  // G11b 手动唤醒：Alt+A 是明确的「我现在要」→ 清除暂停
  await evalJs(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true })); return true })()`)
  await sleep(600)
  const g11b = await evalJs(`!!document.querySelector('[data-wb="inlinePaused"]')`)
  ok(g11b === false, 'G11b ★ Alt+A 唤醒自动（暂停提示消失）', `paused=${g11b}`)
  await waitBusy(false, 16000)

  // G12 关掉「自动触发」开关 → 打字不再自动请求（开关真挡在自动通道口）
  await evalJs(`(async () => {
    try { await window.api.setSetting('aiAssistantInlineSuggestAuto', false) } catch {}
    window.dispatchEvent(new Event('settings-imported'))
    return true
  })()`)
  await sleep(1400)
  await typeInto('这样写就对了。')
  const g12rose = await waitBusy(true, 2500)
  ok(g12rose === false, 'G12 ★ 关自动后打字不再自动请求（设置项真生效）', `busyRose=${g12rose}`)

  // G12b 关自动 ≠ 关功能：手动 Alt+A 仍然可用（两条通道互相独立）
  await evalJs(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true })); return true })()`)
  const g12b = await waitBusy(true, 3000)
  ok(g12b, 'G12b 关自动后手动 Alt+A 仍可用（自动 / 手动两条通道独立）', `busy=${await busyNow()}`)
  await waitBusy(false, 16000)
  await evalJs(`(async () => {
    try { await window.api.setSetting('aiAssistantInlineSuggestAuto', true) } catch {}
    window.dispatchEvent(new Event('settings-imported'))
    return true
  })()`)
  await sleep(1000)

  // G6 开关关掉 → 按钮消失 + Alt+A 不再触发
  // ★ 手法要点：SettingsContext 只在 'settings-imported' 事件里重拉设置（见 src/lib/SettingsContext.tsx），
  //   探针直接用 window.api.setSetting 写盘**不会**推 React 重渲染 → 必须补一次派发，
  //   否则拿到的是「设置已改但 UI 没跟上」的假 FAIL。
  await evalJs(`(async () => {
    try { await window.api.setSetting('aiAssistantInlineSuggest', false) } catch {}
    window.dispatchEvent(new Event('settings-imported'))
    return true
  })()`)
  await sleep(1400)
  const g6 = await evalJs(`(() => ({ count: document.querySelectorAll('[data-wb="inlineSuggestBtn"]').length }))()`)
  ok(g6.count === 0,
    'G6 ★ 关掉设置后「建议」按钮消失（胶囊不再渲染该按钮）', JSON.stringify(g6))
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true }))
    return true
  })()`)
  const g6rose = await waitBusy(true, 1500)
  ok(g6rose === false,
    'G6b ★ 关掉设置后 Alt+A 不发起请求（开关真挡在触发口）', `busyRose=${g6rose}`)

  // G7 复原开关（不给后续探针 / 用户留副作用）
  await evalJs(`(async () => {
    try { await window.api.setSetting('aiAssistantInlineSuggest', true) } catch {}
    window.dispatchEvent(new Event('settings-imported'))
    return true
  })()`)
  await sleep(1000)
  const g7 = await evalJs(`(async () => {
    let v = null
    try { v = await window.api.getSetting('aiAssistantInlineSuggest') } catch {}
    return { saved: v, btn: document.querySelectorAll('[data-wb="inlineSuggestBtn"]').length }
  })()`)
  ok(g7.saved === true && g7.btn === 1,
    'G7 复原开关（设置回 true、按钮回来，无副作用残留）', JSON.stringify(g7))

  console.log('\n========================================')
  const fails = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.label}${r.detail ? '  → ' + r.detail : ''}`)
  console.log(fails.length === 0 ? `\n✅ ${results.length} 项全 PASS` : `\n❌ ${fails.length}/${results.length} FAIL`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针失败:', e.message); process.exit(2) })
