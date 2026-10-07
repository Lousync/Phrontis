/**
 * B-26 探针：阅读器划词「问 AI」的落点 = 工作台右栏 AI 对话（不是悬浮侧栏）。
 *
 * 断言链（任一失败 exit 1）：
 *   1) 夹具自证：epub 开书成功、内容帧可选；★ 右栏与 AI Tab 先收敛到**已知起始态**
 *      （折叠 + AI Tab 可见）——右栏折叠态与 ⋯ 显隐都是**持久化设置**，上一轮跑挂会留下来，
 *      不收敛就会出现「这一轮所有断言都在另一个前提下跑」的假象（踩过）
 *   2) 划选 → 浮条出现（真鼠标事件走既有的 mouseup→capture 链）
 *   3) ★ 点「问 AI」后：`#assistant-panel-root`（悬浮侧栏）**不存在**
 *   4) ★ 右栏 AI Tab 激活 + 右栏从**折叠**变**展开**（width > 60）——默认折叠，这一条同时证明
 *      「点一下会把右栏拉开」，不是「改了 state 但用户看不见」
 *   5) ★ 选段落进右栏 docked 输入框（引用形式，不自动发送）
 *   6) ★ 会话不分裂：路由前后主进程会话集合逐字不变（用户原始抱怨的形状 = 弹出另一个 AI 侧栏
 *      / 另开一个对话；右栏与悬浮侧栏本就共用主进程同一份会话真源，这里锁住「没另开」）
 *   7) ★ 负向「回退不破」：把 AI Tab 用 ⋯ 菜单藏掉 → 再点「问 AI」⇒ 悬浮侧栏**必须出现**
 *      （不许静默无反应）；勾回来后再点一次 ⇒ 又回到右栏（回退是双向的，不是一次性旁路）
 *   收尾：无论成败都把右栏与 AI Tab 复位（否则污染下一轮）
 *
 * 用法（隔离实例，勿与用户 dev 抢单实例锁）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books
 *   KNOWBASE_PROBE_PORT=9333 node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-b26-ask-ai-routing.mjs --no-sandbox --disable-gpu
 *
 * ★ 划选手法：内容帧在 closed shadow root 里，`window.frames` / `querySelector` 都数不到它，
 *   只能走 CDP 取帧（`visibleCtxs()`）。选区用**程序化 Range + 派发 mouseup**：阅读器那条链
 *   （EpubReaderView 的 `onUp`）只读 `doc.getSelection()` + 取 CFI，不要求事件由真人产生
 *   —— 而浮条本身渲染在**宿主文档**里，所以「点浮条」是真 CDP 鼠标点击，不是 `.click()`。
 */
import { connect } from './lib/reader-probe-kit.mjs'

const K = await connect()
const { evalJs, evalIn, visibleCtxs, clickAt, openBookshelf, openBook, resetFixtureState, sleep } = K

let failed = false
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' fail '} ${name}${cond ? '' : `  [${extra}]`}`)
  if (!cond) failed = true
}
const note = (n, e = '') => console.log(`  --   ${n}  [${e}]`)

/** 悬浮侧栏根节点（`{open && …}` 条件渲染 ⇒ 存在即可见） */
const floatPanel = () => evalJs(`!!document.querySelector('#assistant-panel-root')`)
const rightPanel = () => evalJs(`(() => {
  const p = document.querySelector('[data-wb="rightPanel"]')
  const tab = document.querySelector('[data-wb-rp-tab="ai"]')
  const ta = document.querySelector('[data-assistant-variant="docked"] textarea')
  const chip = document.querySelector('[data-assistant-variant="docked"] button[title*="引用片段"]')
  return { w: p ? Math.round(p.getBoundingClientRect().width) : -1,
    ai: tab ? tab.getAttribute('data-wb-rp-active') : null,
    input: ta ? ta.value : null,
    chip: chip ? chip.textContent : null } })()`)
/** 主进程会话集合（唯一真源）：按 id 排序后比对，顺序与时间戳都不参与判据 */
const sessionSet = async () => {
  const rows = await evalJs(`window.api.agentSessions().then(r => (r ?? []).map(x => x.id).sort())`)
  return Array.isArray(rows) ? rows : `ERR:${JSON.stringify(rows)}`
}

/** 右栏收敛到指定折叠态（折叠/展开都能双向切；`[data-wb="rightPanel"]` 只在展开时渲染） */
async function setRightCollapsed(collapsed) {
  const st = await evalJs(`(() => {
    const strips = [...document.querySelectorAll('[title="拖拽或点击展开"]')]
      .map(e => e.getBoundingClientRect()).filter(r => r.width > 0).sort((a, b) => b.left - a.left)
    return { expanded: !!document.querySelector('[data-wb="rightPanel"]'),
      sx: strips[0] ? Math.round(strips[0].left + strips[0].width / 2) : null,
      sy: strips[0] ? Math.round(strips[0].top + strips[0].height / 2) : null } })()`)
  if (st.expanded === !collapsed) return true
  if (collapsed) {
    const sep = await evalJs(`(() => {
      const rs = [...document.querySelectorAll('[role="separator"]')]
        .map(e => e.getBoundingClientRect()).filter(r => r.width > 0).sort((a, b) => b.left - a.left)
      return rs[0] ? { x: Math.round(rs[0].left + rs[0].width / 2), y: Math.round(rs[0].top + 120) } : null })()`)
    if (!sep) return false
    await clickAt(sep.x, sep.y)          // 手柄单击 = 折叠（ResizablePanel onHandleClick）
  } else {
    if (st.sx === null) return false
    await clickAt(st.sx, Math.min(st.sy, 300))
  }
  await sleep(450)
  return true
}

/** ⋯ 菜单里把 AI Tab 设成 show（真点击 checkbox：委托监听的是 change 事件）。
 *  ★ 菜单只在**没开**时才去点 ⋯ —— 它是 toggle，无条件点一下会把上一次留下的开着的菜单关掉
 *  （踩过：第二次调用变成「关菜单 + 找不到 checkbox」→ 复位静默失败）。 */
async function setAiTabVisible(show) {
  const menuOpen = () => evalJs(`!!document.querySelector('[data-wb="panelTabMenu"]')`)
  if (!(await menuOpen())) {
    const more = await evalJs(`(() => {
      const b = [...document.querySelectorAll('[data-wb="rightPanel"] button')].find(x => x.title === '管理面板 Tab')
      const r = b?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null })()`)
    if (!more) return false
    await clickAt(more.x, more.y)
    await sleep(350)
  }
  const box = await evalJs(`(() => {
    const i = document.querySelector('input[data-pt-tab-id="ai"]')
    if (!i) return null
    const r = i.getBoundingClientRect()
    return { checked: i.checked, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  if (!box) return false
  if (box.checked === show) return true
  await clickAt(box.x, box.y)
  await sleep(450)
  return true
}

/** 收起悬浮侧栏（它从右侧滑出，会**盖住**右栏的 ⋯ 按钮 —— 不关掉下一步就点空了，踩过） */
async function closeFloatPanel() {
  if (!(await floatPanel())) return true
  const b = await evalJs(`(() => {
    const x = [...document.querySelectorAll('#assistant-panel-root button')].find(e => (e.title || '').startsWith('收起'))
    const r = x?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null })()`)
  if (!b) return false
  await clickAt(b.x, b.y)
  await sleep(400)
  return (await floatPanel()) === false
}

/** 划选一段（帧内程序化 Range）→ 返回选中的文本；失败返回 null */
async function selectInFrame() {
  const ctxs = await visibleCtxs()
  if (!ctxs.length) return null
  return await evalIn(ctxs[0].ctx, `(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n = null
    while ((n = w.nextNode())) if (n.nodeValue && n.nodeValue.trim().length > 12) break
    if (!n) return null
    const r = document.createRange()
    r.setStart(n, 0); r.setEnd(n, 12)
    const s = document.getSelection(); s.removeAllRanges(); s.addRange(r)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return s.toString() })()`)
}
/** 等浮条出现，返回「问 AI」按钮的点击坐标（宿主文档坐标系 = 输入事件坐标系） */
async function askButtonPos() {
  for (let i = 0; i < 20; i++) {
    const p = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '问 AI')
      if (!b) return null
      const r = b.getBoundingClientRect()
      if (r.width <= 0) return null
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    if (p) return p
    await sleep(150)
  }
  return null
}
/** 划选 → 点「问 AI」（返回选段文本；浮条没出现则返回 null） */
async function askViaFloatBar() {
  const text = await selectInFrame()
  if (!text) return null
  await sleep(250)
  const pos = await askButtonPos()
  if (!pos) return null
  await clickAt(pos.x, pos.y)
  await sleep(500)
  return text
}

// ===== 夹具 + 起始态自证 =====
await resetFixtureState()
await openBookshelf()
await openBook('探针样书.epub')
await sleep(2200)
const ctxs = await visibleCtxs()
ok('夹具前提：epub 已开书且内容帧可见', ctxs.length > 0, `ctxs=${ctxs.length}`)
if (!ctxs.length) { console.log('\n夹具不成立，中止'); process.exit(1) }

await setRightCollapsed(false)
const aiTab = await setAiTabVisible(true) && (await evalJs(`!!document.querySelector('[data-wb-rp-tab="ai"]')`))
await setRightCollapsed(true)
ok('夹具前提：右栏已折到已知起始态且 AI Tab 可见', aiTab === true && (await evalJs(`!document.querySelector('[data-wb="rightPanel"]')`)) === true)

// ===== ① 主路径：落点该是右栏 =====
const sessions0 = await sessionSet()
note('会话集合（路由前）', `${Array.isArray(sessions0) ? sessions0.length : '?'} 条`)
const picked = await askViaFloatBar()
ok('划选后浮条出现且点到了「问 AI」', !!picked, '浮条/按钮没找到')
note('选段', JSON.stringify(picked))
const rp1 = await rightPanel()
ok('★ 悬浮侧栏**没有**出现（不再从右侧滑出浮层盖住阅读区）', (await floatPanel()) === false)
ok('★ 右栏 AI Tab 激活', rp1.ai === '1', JSON.stringify(rp1))
ok('★ 右栏从折叠被拉开（width > 60）', rp1.w > 60, JSON.stringify(rp1))
ok('★ 选段落进右栏引用胶囊（不是明文写入输入框）', !!picked && String(rp1.chip || '').includes('对话引用'), JSON.stringify({ chip: rp1.chip, picked }))
const sessions1 = await sessionSet()
ok('★ 会话不分裂：路由前后主进程会话集合逐字不变', JSON.stringify(sessions0) === JSON.stringify(sessions1), `${JSON.stringify(sessions0)?.slice(0, 60)} → ${JSON.stringify(sessions1)?.slice(0, 60)}`)

// ===== ② 负向：AI Tab 被藏 ⇒ 放手回退悬浮侧栏（不许静默无反应）=====
const hid = await setAiTabVisible(false)
ok('⋯ 菜单把 AI Tab 藏掉了（负向前提）', hid === true && (await evalJs(`!document.querySelector('[data-wb-rp-tab="ai"]')`)) === true)
const picked2 = await askViaFloatBar()
const floated = await floatPanel()
ok('★ 回退不破：AI Tab 藏掉后点「问 AI」⇒ 悬浮侧栏出现', !!picked2 && floated === true, JSON.stringify({ picked: !!picked2, floated }))
const sessions2 = await sessionSet()
ok('回退路径同样没有另开会话', JSON.stringify(sessions0) === JSON.stringify(sessions2))

// ===== ③ 勾回来 ⇒ 又回到右栏（回退是双向的）=====
await closeFloatPanel()
await setAiTabVisible(true)
const picked3 = await askViaFloatBar()
const rp3 = await rightPanel()
ok('★ 勾回 AI Tab 后再点「问 AI」⇒ 又落回右栏（不是一次性旁路）',
  !!picked3 && (await floatPanel()) === false && rp3.ai === '1' && rp3.w > 60, JSON.stringify({ picked: !!picked3, rp3 }))

// ===== 收尾：复位（失败也要复位，否则污染下一轮）=====
await closeFloatPanel()
await setAiTabVisible(true)
await setRightCollapsed(true)

console.log(`\n${failed ? '存在失败断言' : '全部通过'}`)
console.log('[eval 竞态失败数]', K.evalFailures())
process.exit(failed ? 1 : 0)
