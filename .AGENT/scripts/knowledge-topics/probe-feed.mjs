/**
 * 笔记流 / 虚拟主题运行时探针（v3.27.0，docs/knowledge-feed-topics-plan.md）。
 *
 * 断言（真实 DOM，build 产物 + CDP）：
 *   K1 知识库左栏渲染新侧栏（[data-wb="kbFeedSidebar"]），默认停在「最近」视图
 *   K2 三视图分段 = 最近 / 主题 / 结构
 *   K3 页面条最左是总览固定标签（不可关闭：无关闭按钮）
 *   K4 「最近」视图有笔记行；点总览标签 → 中间渲染总览（不是空白 / 不是编辑器）
 *   K5 切到「主题」→ 空态主题墙；行内新建主题（输入 + Enter）→ 卡片出现
 *   K6 主题落盘到 .knowbase/modules/knowledge/topics.json（且不写页面 frontmatter）
 *   K7 打开 Markdown 笔记 → 左栏自动切大纲；点「返回列表」回笔记流
 *   K8 console 零 error
 *
 * 用法（先 npm run build，再 seed）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs \
 *     .AGENT/scripts/knowledge-topics/probe-feed.mjs
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEBUG_PORT = Number(process.env.KNOWBASE_PROBE_PORT ?? 9333)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const TOPICS_FILE = join(ROOT, 'tmp', 'vault-fixture', '.knowbase', 'modules', 'knowledge', 'topics.json')
const TEST_TOPIC = '探针主题'

async function waitPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/.test(t.url || ''))
      if (page && page.webSocketDebuggerUrl) return page
    } catch { /* 继续等 */ }
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
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(join(ROOT, 'tmp', 'probe-shots'), { recursive: true })
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ROOT, 'tmp', 'probe-shots', `${name}.png`), Buffer.from(r.data, 'base64'))
  } catch { /* 截图失败不影响断言 */ }
}
const results = []
function ok(cond, label, detail = '') {
  results.push({ pass: !!cond, label, detail })
  return !!cond
}
const JS_SIDEBAR = `(() => {
  const el = document.querySelector('[data-wb="kbFeedSidebar"]')
  const views = [...document.querySelectorAll('[data-wb^="kbFeedView-"]')].map((b) => b.dataset.wb.replace('kbFeedView-', ''))
  const homeTab = document.querySelector('[data-tab-id="__kb_home__"]')
  return {
    hasSidebar: !!el,
    view: el?.dataset.kbSidebarView ?? '',
    views,
    homeTab: !!homeTab,
    homeCloseBtn: homeTab ? homeTab.querySelectorAll('button').length : -1,
    noteRows: document.querySelectorAll('[data-kb-note-row]').length,
    hasHome: !!document.querySelector('[data-wb="kbNoteHome"]'),
    hasWall: !!document.querySelector('[data-wb="kbTopicWall"]'),
    hasTree: document.querySelectorAll('[data-wb-tree-node]').length > 0,
    outline: !!document.querySelector('[data-wb="kbOutlineMode"]'),
    search: !!document.querySelector('[data-wb="kbFeedSidebar"] .kb-field input'),
    expandBtn: !!document.querySelector('[data-wb="kbTreeSubtreeBtn"]'),
    treeSearchRows: document.querySelectorAll('[data-kb-tree-search-result]').length,
    inlineCreate: !!document.getElementById('kb-inline-create'),
  }
})()`

async function main() {
  const page = await waitPage()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
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

  // 仓库选择浮层：只点「跳过」
  const dismiss = `(() => {
    const txt = document.body.textContent || ''
    if (!txt.includes('选择要进入的仓库')) return 'no-picker'
    const cands = [...document.querySelectorAll('button,a,div,span')].filter((el) => (el.textContent || '').trim() === '跳过，直接进入上次使用的仓库')
    const target = cands.find((el) => el.tagName === 'BUTTON') || cands[cands.length - 1]
    if (target) { target.click(); return 'skip' }
    return 'picker-no-action'
  })()`
  await evalJs(dismiss)
  await sleep(1200)

  // 清掉上一次探针留下的主题
  await evalJs(`window.api.getKnowledgeTopics().then((ts) => Promise.all(ts.map((t) => window.api.deleteKnowledgeTopic(t.id))))`).catch(() => null)
  if (existsSync(TOPICS_FILE)) rmSync(TOPICS_FILE, { force: true })

  // 进笔记模块
  await evalJs(`document.querySelector('[data-wb-bookmark="knowledge"]')?.click()`)
  await sleep(2000)

  let st = await evalJs(JS_SIDEBAR)
  ok(st.hasSidebar, 'K1 知识库左栏渲染新侧栏（kbFeedSidebar）')
  ok(st.hasSidebar && ['recent', 'topics', 'tree'].includes(st.view), 'K1b 左栏停在三视图之一（读设置持久化）', st.view)
  ok(st.views.length === 3 && ['recent', 'topics', 'tree'].every((v) => st.views.includes(v)),
    'K2 三视图分段 = 最近 / 主题 / 结构', JSON.stringify(st.views))
  ok(st.homeTab, 'K3 页面条最左是总览固定标签')
  ok(st.homeTab && st.homeCloseBtn >= 0 && st.homeCloseBtn <= 0, 'K3b 总览标签没有关闭 / 固定按钮（不可关）', `buttons=${st.homeCloseBtn}`)
  // 视图是持久化的：先显式回「最近」，再断言笔记行
  await evalJs(`document.querySelector('[data-wb="kbFeedView-recent"]')?.click()`)
  await sleep(500)
  st = await evalJs(JS_SIDEBAR)
  ok(st.noteRows > 0, 'K4 最近视图有笔记行', `rows=${st.noteRows}`)
  await shot('feed-01-recent')

  // 总览
  await evalJs(`document.querySelector('[data-tab-id="__kb_home__"]')?.click()`)
  await sleep(600)
  st = await evalJs(JS_SIDEBAR)
  ok(st.hasHome, 'K4b 点总览标签 → 中间渲染总览')
  await shot('feed-02-home')

  // 左栏交互收口：搜索三视图常驻；结构专属按钮只在结构出现
  await evalJs(`document.querySelector('[data-wb="kbFeedView-recent"]')?.click()`)
  await sleep(400)
  st = await evalJs(JS_SIDEBAR)
  ok(st.search, 'K4c 最近视图有搜索框')
  ok(!st.expandBtn, 'K4d 最近视图没有「展开 / 收起」按钮（结构专属）')
  await evalJs(`document.querySelector('[data-wb="kbFeedView-tree"]')?.click()`)
  await sleep(700)
  st = await evalJs(JS_SIDEBAR)
  ok(st.view === 'tree' && st.search, 'K4e 结构视图搜索框仍在（不再消失）')
  ok(st.expandBtn, 'K4f 结构视图有「展开 / 收起」按钮')
  await evalJs(`(() => { const q=document.querySelector('[data-wb="kbFeedSidebar"] .kb-field input'); q && q.focus(); })()`)
  await send('Input.insertText', { text: 'README' })
  await sleep(700)
  st = await evalJs(JS_SIDEBAR)
  ok(st.treeSearchRows > 0, 'K4g 结构搜索出平铺结果（查找并定位）', `rows=${st.treeSearchRows}`)
  await shot('feed-02b-tree-search')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(500)
  st = await evalJs(JS_SIDEBAR)
  ok(st.treeSearchRows === 0 && st.hasTree, 'K4h Esc 清空 → 回到目录树', `rows=${st.treeSearchRows}`)

  // 主题视图 + 内联新建
  await evalJs(`document.querySelector('[data-wb="kbFeedView-topics"]')?.click()`)
  await sleep(500)
  st = await evalJs(JS_SIDEBAR)
  ok(st.hasWall && st.view === 'topics', 'K5 切到「主题」渲染主题墙', st.view)
  const clicked = await evalJs(`(() => {
    const wall = document.querySelector('[data-wb="kbTopicWall"]')
    const btn = [...(wall?.querySelectorAll('button') || [])].find((b) => (b.textContent || '').includes('新建主题'))
    if (!btn) return false
    btn.click(); return true
  })()`)
  ok(clicked, 'K5b 主题墙「新建主题」可点')
  await sleep(300)
  const focused = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="kbTopicWall"] input')
    if (!el) return false
    el.focus(); return true
  })()`)
  ok(focused, 'K5c 内联命名输入框出现并聚焦')
  await send('Input.insertText', { text: TEST_TOPIC })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(1200)
  const created = await evalJs(`(() => {
    const wall = document.querySelector('[data-wb="kbTopicWall"]')
    return { text: wall?.textContent || '', cards: wall?.querySelectorAll('[data-topic-drop]').length ?? 0 }
  })()`)
  ok(created.text.includes(TEST_TOPIC) && created.cards >= 1, 'K5d 新建主题 → 卡片出现', `cards=${created.cards}`)
  await shot('feed-03-topics')

  // ＋ → 新建笔记：列表视图内联命名，不切视图
  await evalJs(`document.querySelector('[data-wb="treeNewBtn"]')?.click()`)
  await sleep(350)
  const picked = await evalJs(`(() => {
    const item = document.querySelector('[data-wb="treeNewItem-knowledge"]')
    if (!item) return false
    item.click(); return true
  })()`)
  await sleep(500)
  st = await evalJs(JS_SIDEBAR)
  ok(picked && st.inlineCreate && st.view === 'topics',
    'K5e ＋ → 新建笔记在列表顶部内联命名，视图不跳', `view=${st.view}`)
  await shot('feed-03b-inline-create')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(400)

  // 落盘
  await sleep(400)
  let disk = null
  try { disk = JSON.parse(readFileSync(TOPICS_FILE, 'utf8')) } catch { /* 缺文件 */ }
  const diskTopic = disk?.topics?.find((t) => t.name === TEST_TOPIC)
  ok(!!diskTopic, 'K6 主题落盘到 topics.json', TOPICS_FILE)
  const readme = join(ROOT, 'tmp', 'vault-fixture', 'README.md')
  const readmeText = existsSync(readme) ? readFileSync(readme, 'utf8') : ''
  ok(!readmeText.includes(TEST_TOPIC), 'K6b 不写页面 frontmatter / 正文（README 不含主题名）')

  // 加成员 → 主题详情 → 移除成员 → 删除主题（笔记保留）
  const added = await evalJs(`(async () => {
    const ts = await window.api.getKnowledgeTopics()
    const t = ts.find((x) => x.name === '${TEST_TOPIC}')
    const pages = await window.api.getKnowledgePages()
    const page = pages.find((p) => (p.fileType || '') === 'md' && p.path)
    if (!t || !page) return null
    await window.api.patchKnowledgeTopicMembers(t.id, { add: [page.id] })
    return { title: page.title, id: page.id }
  })()`)
  ok(!!added, 'K9 通过 IPC 加成员成功（模拟拖拽落点）')
  await sleep(900)
  const openedDetail = await evalJs(`(() => {
    const head = document.querySelector('[data-topic-drop] button[data-tip="打开主题"]')
    if (!head) return false
    head.click(); return true
  })()`)
  await sleep(900)
  const detail = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="kbTopicDetail"]')
    return { has: !!el, text: el?.textContent || '' }
  })()`)
  ok(openedDetail && detail.has && detail.text.includes(TEST_TOPIC), 'K9b 主题卡 → 主题详情页（临时标签）')
  ok(!!added && detail.text.includes(added.title), 'K9c 详情页按目录分组列出成员', added?.title)
  await shot('feed-04-topic-detail')

  const removed = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="kbTopicDetail"]')
    const btn = el?.querySelector('button[data-tip*="从主题移除"]')
    if (!btn) return false
    btn.click(); return true
  })()`)
  await sleep(900)
  const afterRemove = await evalJs(`document.querySelector('[data-wb="kbTopicDetail"]')?.textContent || ''`)
  ok(removed && !!added && !afterRemove.includes(added.title), 'K9d 从主题移除成员（只解散关系）')

  await evalJs(`(() => {
    const el = document.querySelector('[data-wb="kbTopicDetail"]')
    const btn = [...(el?.querySelectorAll('button') || [])].find((b) => (b.textContent || '').includes('删除主题'))
    btn?.click(); return !!btn
  })()`)
  await sleep(300)
  const confirmed = await evalJs(`(() => {
    const el = document.querySelector('[data-wb="kbTopicDetail"]')
    const btn = [...(el?.querySelectorAll('button') || [])].find((b) => (b.textContent || '').includes('确认删除'))
    btn?.click(); return !!btn
  })()`)
  await sleep(900)
  const afterDelete = await evalJs(`({
    detail: !!document.querySelector('[data-wb="kbTopicDetail"]'),
    topics: document.querySelectorAll('[data-topic-drop]').length,
  })`)
  ok(confirmed && !afterDelete.detail, 'K10 删除主题走行内确认 → 主题关闭')
  const pageStillThere = await evalJs(`(async () => {
    const pages = await window.api.getKnowledgePages()
    return pages.some((p) => p.id === ${JSON.stringify(added?.id ?? '')})
  })()`)
  ok(pageStillThere, 'K10b 删除主题不删笔记（页面仍在索引）')

  // 重新建一个主题给 K5 之后的流程留空（后续步骤不依赖主题）

  // 打开 md → 自动大纲
  await evalJs(`window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: 'README.md' } }))`)
  let out = null
  for (let i = 0; i < 12; i++) {
    await sleep(600)
    out = await evalJs(JS_SIDEBAR)
    if (out.outline) break
  }
  ok(out?.outline && out.view === 'outline', 'K7 打开 Markdown 笔记 → 左栏自动切大纲', out?.view)
  await shot('feed-05-outline')
  const back = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('[data-wb="kbFeedSidebar"] button')].find((b) => (b.textContent || '').includes('返回列表'))
    if (!btn) return false
    btn.click(); return true
  })()`)
  ok(back, 'K7b 大纲态有「返回列表」')
  await sleep(500)
  out = await evalJs(JS_SIDEBAR)
  ok(out.view !== 'outline' && !out.outline, 'K7c 返回列表 → 回三视图列表（回到进入前那一栏）', out.view)

  // 收尾：删掉探针主题 + 视图设置复位（下一次探针从「最近」开始）
  await evalJs(`window.api.getKnowledgeTopics().then((ts) => Promise.all(ts.filter((t) => t.name === '${TEST_TOPIC}').map((t) => window.api.deleteKnowledgeTopic(t.id))))`).catch(() => null)
  await evalJs(`window.api.setSetting('knowledgeFeedView', 'recent')`).catch(() => null)
  await sleep(600)

  ok(consoleErrors.length === 0, 'K8 console 零 error', consoleErrors.slice(0, 2).join(' | '))

  const failed = results.filter((r) => !r.pass)
  for (const r of results) console.log(`${r.pass ? '  ok  ' : ' FAIL '} ${r.label}${r.detail ? `  [${r.detail}]` : ''}`)
  console.log(`\n${failed.length ? `FAIL ${failed.length} 项` : 'PASS 全部通过'}（${results.length - failed.length}/${results.length}）`)
  try { ws.close() } catch { /* ignore */ }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
