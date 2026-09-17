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
    const tab = document.querySelector('[data-wb="tabbar"] [data-wb-tab="aiChat"]')
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

  // A7 关闭 aiChat 标签 → 右栏自动回小对话
  await evalJs(`(() => {
    const t = document.querySelector('[data-wb="tabbar"] [data-wb-tab="aiChat"]')
    t?.querySelector('button[title="关闭标签页"]')?.click(); return true
  })()`)
  await sleep(800)
  const afterClose = await evalJs(`(() => ({
    tabGone: !document.querySelector('[data-wb="tabbar"] [data-wb-tab="aiChat"]'),
    panelGone: !document.querySelector('[data-wb="aiUsagePanel"]'),
    chatBack: !!document.querySelector('[data-wb="rightPanel"] [data-assistant-variant="docked"] textarea'),
  }))()`)
  ok(afterClose.tabGone && afterClose.panelGone && afterClose.chatBack, 'A7 关 aiChat 标签 → 右栏自动变回小对话', JSON.stringify(afterClose))

  // A8 重新 ⤢ → 再关（幂等，双 Tab 显隐管理后 AI Tab 仍在）
  await evalJs(`(() => { document.querySelector('[data-wb="rightPanel"] button[title="扩大为完整对话页"]')?.click(); return true })()`)
  await sleep(800)
  const again = await evalJs(`!!document.querySelector('[data-wb="aiUsagePanel"]')`)
  ok(again, 'A8 再次 ⤢ 幂等（token 面板重现）')

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
    const t = document.querySelector('[data-wb="tabbar"] [data-wb-tab="aiChat"]')
    t?.querySelector('button[title="关闭标签页"]')?.click(); return true
  })()`)
  await sleep(800)
  const modAfter = await evalJs(`document.querySelector('[data-wb="mod"]')?.dataset.wbMod ?? ''`)
  const sideGone = await evalJs(`!document.querySelector('[data-wb="aiChatSidebar"]')`)
  ok(modAfter !== 'aiChat' && sideGone, 'B5 关标签 → 左栏跟随落点退出 aiChat 侧栏', `mod=${modAfter} sideGone=${sideGone}`)

  console.log('\n========================================')
  const fails = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.label}${r.detail ? '  → ' + r.detail : ''}`)
  console.log(fails.length === 0 ? `\n✅ ${results.length} 项全 PASS` : `\n❌ ${fails.length}/${results.length} FAIL`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针失败:', e.message); process.exit(2) })
