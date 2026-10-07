/**
 * 书市 S5 探针 —— 两枚 AI 工具（`builtin.booksource.list` / `builtin.booksource.draft`）与
 * 「草案 → 预填表单」那一跳的**实机**验收（真 electron + 真主进程 + 真渲染层 + CDP）。
 *
 * ## 覆盖（施工方案 §13.5 ② 的两段，都在本文件里）
 *   【主进程段】工具在册与元数据 · 权限两档拦得住（read 拦写 / write 放行）· 入参校验的
 *              五条错误路径 · 凭据字段进不来（AI 侧永远拿不到凭据）
 *   【渲染层段】草案到达 ⇒ 自动切书市 + 打开「新建书源」表单 + 字段预填（含 7 行映射）·
 *              凭据三框恒为空 · 取消即弃草案（下次点「新增书源」不带出旧草案）·
 *              点「添加并测试」⇒ 真落库 ⇒ 源清单出现该源且状态「已连通」
 *
 * ## 为什么不照 S1–S3 那样在主进程里跑
 * S1/S2/S3 验的是磁盘字节 / 网络请求 / 队列状态，主进程里跑最直接。S5 验的是**一条跨进程的
 * 用户可见链路**：工具 → 广播 → App 切模块 → 模块开表单。这条路上有一半是渲染层的，
 * 主进程里跑只能验到「广播发出去了」，验不到「表单真的开了、字段真的填对了」。
 *
 * ## ★ 与拍板 ②「加 dev-only 钩子」的关系（一句，别误读）
 * 钩子（`window.__kbBookSourceDraft`，`import.meta.env.DEV` 守卫）**仍然在**，但本探针**不用它**
 * 触发那一跳 —— 本探针走的是**更真**的路：渲染层直接 `window.api.aiToolsInvoke('builtin.booksource.draft', …)`，
 * 与手动在 AI 面板里点这个工具**完全同一条链路**（`aiTools:invoke` → 同一个 `invokeTool`：
 * 同一套 validateArgs / checkModulePermission / 月度上限 / handler）。钩子降级为「人工调试用」，
 * 它的 DEV 守卫由契约脚本 `verify-book-market-tools.mjs` 静态锁（⑦ 段），另见本文件 ⑨ 段那条
 * 生产负向断言（`npm run build` 的产物里 window 上不留这个口子）。
 *
 * ## 隔离与副作用（照 S1/S3/S4 的约定）
 * ★ **不碰用户的仓库数据**：探针自己 `workspaceCreateVault` 建一个临时仓库（系统临时目录里），
 *   书源增删全落在它里面；结束后把「当前仓库」还原回探针开始时那一个。
 * ★ **会改 dev 的全局设置**（`aiModulePermissions`）——权限两档必须真改才验得动。
 *   开场记原值、收尾**原样还原**（连字符串形态一起还原，不做 JSON 归一化重写）。
 * ★ userData 走应用的 dev 隔离分支（`%APPDATA%/knowbase (dev <检出目录名>)`）—— 与正式数据无关。
 * ★ 临时目录**不删**（便于人工复核），路径打在输出里。
 * ★ 不碰公网：伪造源只有本机 mock origin 一个；预置源（Gutenberg / Standard Ebooks）全程不参与
 *   （本探针不做检索，只做「添加并测试」这一次单源探测，打到的是 mock）。
 *
 * 跑法（两步；先 build，`electron .` 读的是 `out/main/index.js`）：
 *   npm run build
 *   KNOWBASE_PROBE_PORT=9325 node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/book-market/probe-s5-tools.mjs
 *
 * ★ 换端口不是洁癖：9222 是 CDP 默认端口，会被本机常驻的其它 electron（dev 实例 / WorkBuddy）
 *   占住；占住之后 `/json/list` 仍会返回**别人**的 page target（见下方「身份闸」）。
 * ★ 必须 `npm run build`（生产构建）：⑨ 段那条「DEV 钩子不在生产产物里」只有生产构建才成立。
 *
 * 产物：stdout 一份逐条断言 + `tmp/book-market-s5-tools.json`（留档）
 */

import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createAssertions } from '../workbench-shell/probes/lib/reader-probe-kit.mjs'

const A = createAssertions()
const { ok, note } = A

const BASE = mkdtempSync(join(tmpdir(), 'kb-probe-s5-'))
const VAULT_PARENT = join(BASE, 'vaults')
const VAULT_NAME = '书市S5探针仓库'
mkdirSync(VAULT_PARENT, { recursive: true })
const VAULT = join(VAULT_PARENT, VAULT_NAME)
/** 书源描述落库文件（`bookSourceVaultRepo` 的 F_SOURCES）—— 「草案不落库」那条断言读它 */
const SOURCES_FILE = join(VAULT, '.knowbase', 'modules', 'bookSources.json')

const DRAFT_APP = 'builtin.booksource.draft'
const DRAFT_LIST = 'builtin.booksource.list'

/** 凭据负向的标记值：整轮 stdout / 返回值 / 落盘字节里一个都不许出现 */
const LEAK = { USER: 'LEAKUSERs5d19', PASS: 'LEAKPASSs5d19', TOKEN: 'LEAKTOKENs5d19' }

// ===== mock 源（一个 origin 就够：本探针不验并发，只验「添加并测试」打得到）=====
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** 一个合法 OPDS feed（`/opds` 路由恒返回它，不管 query 是什么 —— 探测词是主进程定的 'test'） */
const OPDS_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc('S5 探针 mock 源')}</title>
  <link rel="self" href="/opds" type="application/atom+xml;profile=opds-catalog"/>
  <entry><title>${esc('探针书')}</title><author><name>${esc('探针作者')}</name></author>
    <link href="/dl/1" type="application/epub+zip" rel="http://opds-spec.org/acquisition" length="1024"/></entry>
</feed>`
/** 一段样例 JSON 响应（custom 源的形状；本探针只把它当「响应样例」写进 mappingJson，不真去解析搜索） */
const SAMPLE_JSON = { data: { books: [{ title: '探针书', author: '探针作者', files: [{ url: 'http://x/1.epub', format: 'epub' }] }] } }

const srv = { hits: [], origin: '' }
srv.srv = createServer((req, res) => {
  srv.hits.push({ path: new URL(req.url, 'http://x').pathname, auth: String(req.headers.authorization || '') })
  if (req.url.startsWith('/opds') || req.url.startsWith('/json')) {
    const body = req.url.startsWith('/opds') ? OPDS_FEED : JSON.stringify(SAMPLE_JSON)
    res.writeHead(200, { 'Content-Type': req.url.startsWith('/opds') ? 'application/atom+xml;profile=opds-catalog' : 'application/json' })
    res.end(body)
    return
  }
  res.writeHead(404)
  res.end('nope')
})
await new Promise((r) => srv.srv.listen(0, '127.0.0.1', r))
srv.origin = `http://127.0.0.1:${srv.srv.address().port}`
const closeSrv = () => new Promise((r) => srv.srv.close(r))

// ===== 连接 CDP =====
const K = await connect({ readySelector: 'button[title="书市"]' })
const { evalJs, sleep } = K

/**
 * ★★ 身份闸（照 S4 逐字搬运）：**先确认连上的是本检出的应用，再开始断言**。
 *
 * 为什么必须有：CDP 端口是「先到先得」的 —— 端口被**别的** electron 实例占住时，`/json/list`
 * 照样返回一个可连的 page target，于是探针连上了**另一个应用**：表象是一串莫名其妙的断言失败，
 * 更危险的是**反向**（驱动了别的目标却恰好全绿 = 一次假 PASS）。所以地址对不上就**当场停**。
 */
{
  const expectHref = `file:///${process.cwd().replace(/\\/g, '/')}/out/renderer/index.html`
  const href = String(await evalJs(`location.href`) ?? '')
  const apiOk = await evalJs(`typeof (window.api && window.api.aiToolsInvoke)`) === 'function'
  const formOk = await evalJs(`typeof (window.api && window.api.bookMarketUpsertSource)`) === 'function'
  if (href !== expectHref || !apiOk || !formOk) {
    console.error('\n★ 身份闸未通过 —— CDP 连上的不是本检出的应用，探针立即中止（不做业务断言）。')
    console.error(`  期望页面：${expectHref}`)
    console.error(`  实际页面：${href || '(空)'}`)
    console.error(`  window.api.aiToolsInvoke 是函数：${apiOk} / bookMarketUpsertSource 是函数：${formOk}`)
    console.error('  多半是 CDP 端口被别的 electron 占住了；换端口重跑：')
    console.error('    KNOWBASE_PROBE_PORT=9325 node .AGENT/scripts/workbench-shell/probes/run-probe.mjs <本探针>')
    A.finish()
  }
  ok('身份闸：连上的是本检出构建的渲染层（file:///<cwd>/out/renderer/index.html）', true, href)
  ok('身份闸：window.api 上 AI 工具与书市这批通道在位', apiOk && formOk)
}

const results = []
const checks = []
const myOk = (name, cond, extra = '') => { checks.push({ name, ok: !!cond, extra: String(extra) }); ok(name, cond, extra) }

/** 等一个判据成真（轮询）；探针里所有「等界面反应」都走它，不用裸 sleep 赌 */
async function until(fn, ms = 8000, step = 60) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > ms) return false
    await sleep(step)
  }
}

// ===== 渲染层读数小工具 =====
const bodyText = () => evalJs(`document.body.innerText || ''`)
/** 模块是否**可见**（Tab 保活：挂载了也可能 display:none —— 只判存在会假绿） */
const modVisible = async () => (await evalJs(`(() => {
  const el = document.querySelector('[data-wb="bookMarket"]')
  return !!el && el.offsetParent !== null && el.clientHeight > 0
})()`)) === true
/** 左栏「书市」图标是否高亮（高亮标记 = 按钮内那个 `left-` 定位的小条，照 S4） */
const railMarked = async () => (await evalJs(`(() => {
  const b = [...document.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === '书市' && x.closest('div[class*="w-11"]'))
  return !!b && !!b.querySelector('div[class*="left-"]')
})()`)) === true
const clickRailBookMarket = () => evalJs(`(() => {
  const b = [...document.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === '书市' && x.closest('div[class*="w-11"]'))
  if (!b) return 'no-rail'
  b.click()
  return 'ok'
})()`)
/**
 * 离开书市：点同一根图标条上**别的**模块。
 * 为什么需要它：启动时停在哪个 Tab 取决于上次退出时那一页（可能是书市），那样
 * 「草案到达才切过去」这条就验不出来了（本来就在）。所以开场先主动挪开，把前置条件做成确定的。
 */
const leaveBookMarket = () => evalJs(`(() => {
  const self = [...document.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === '书市' && x.closest('div[class*="w-11"]'))
  const strip = self && self.closest('div[class*="w-11"]')
  if (!strip) return 'no-rail'
  const b = [...strip.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') !== '书市')
  if (!b) return 'no-other'
  b.click()
  return b.getAttribute('title')
})()`)

/**
 * 弹层作用域：书市四个弹层共用 `Sheet` 壳（ModalShell → `.kb-overlay` 遮罩），**没有 data-wb 锚点**，
 * 所以按「遮罩里含某段文案」定位（照 S4）。
 * ★ 为什么按钮必须在作用域里找：书源页自己也有一个「保存」（代理那行），而弹层是**就地渲染**的
 *   （不是 portal），document 顺序上代理那个「保存」在前 ⇒ 全局 `find(/保存/)` 点到的是它。
 */
const sheetScope = (needle) => `(() => {
  const ov = [...document.querySelectorAll('[class*="kb-overlay"]')].find((o) => (o.textContent || '').includes(${JSON.stringify(needle)}))
  return ov || null
})()`
/** 表单弹层是否开稳（排除退场态 `kb-overlay-out`） */
const formOpen = async () => (await evalJs(`(() => {
  const ov = ${sheetScope('新增书源')}
  return !!ov && !ov.className.includes('kb-overlay-out') && !!ov.querySelector('h3')
})()`)) === true
const sheetTitle = () => evalJs(`(() => { const ov = ${sheetScope('新增书源')}; return ov ? (ov.querySelector('h3')?.textContent ?? '') : null })()`)
const sheetBtn = (label) => evalJs(`(() => {
  const ov = ${sheetScope('新增书源')}
  if (!ov) return 'no-sheet'
  const b = [...ov.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
  if (!b) return 'no-btn'
  b.click()
  return 'ok'
})()`)
/** 弹层内全部输入框的 value，按 DOM 顺序 —— 表单的 DOM 顺序是稳定的：名称 / 地址 / 检索模板 / 7 行映射 / 用户名 / 密码 */
const sheetInputs = () => evalJs(`(() => {
  const ov = ${sheetScope('新增书源')}
  return ov ? [...ov.querySelectorAll('input')].map((i) => i.value) : null
})()`)
const sheetInputMeta = () => evalJs(`(() => {
  const ov = ${sheetScope('新增书源')}
  return ov ? [...ov.querySelectorAll('input')].map((i) => ({ v: i.value, type: i.type, ph: i.placeholder })) : null
})()`)
/** 模块栏的 pill 按钮（「新增书源」/「下载」）—— 只在模块作用域里找，别全局捞 */
const moduleBtn = (label) => evalJs(`(() => {
  const m = document.querySelector('[data-wb="bookMarket"]')
  if (!m) return 'no-module'
  const b = [...m.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
  if (!b) return 'no-btn'
  b.click()
  return 'ok'
})()`)
/**
 * 「书源」视图是否是当前视图。
 * 判据用启停开关（`role="switch"`）：它只在书源行里出现，而书源 ≥ 2 条是**预置源**保证的
 * （Gutenberg / Standard Ebooks），所以只要视图切对了就一定有 —— 不需要草案里的那个源已落库。
 */
const sourcesViewActive = async () => (await evalJs(`!!document.querySelector('[data-wb="bookMarket"] [role="switch"]')`)) === true

/** 书源行：每行**最后**一个子元素是启停开关（`role="switch"`），它的父节点就是行（照 S4） */const srcRow = (name) => `(() => {
  const rows = [...document.querySelectorAll('[data-wb="bookMarket"] [role="switch"]')].map((sw) => sw.parentElement)
  const row = rows.find((r) => r && (r.textContent || '').includes(${JSON.stringify(name)}))
  return row || null
})()`
const rowState = (name) => evalJs(`(() => {
  const row = ${srcRow(name)}
  if (!row) return null
  const cell = row.querySelector('span[class*="58px"]')
  const t = (cell ? cell.textContent : row.textContent) || ''
  const m = t.match(/已连通|需要凭据|连接失败|未测试/)
  return m ? m[0] : null
})()`)

/** 调一枚 AI 工具（走渲染层 IPC —— 与 AI 面板/agent 完全同一条 invokeTool 链路） */
const invoke = (name, args) => evalJs(`(async () => {
  try { return await window.api.aiToolsInvoke(${JSON.stringify(name)}, ${JSON.stringify(args ?? {})}) }
  catch (e) { return { __ipcErr: String(e) } }
})()`)
const sourcesFileRaw = () => { try { return readFileSync(SOURCES_FILE, 'utf8') } catch { return null } }

// ===== ① 前置：临时仓库 + 记原设置 =====
console.log('\n--- ① 前置：临时仓库 + 记录待改的全局设置 ---')
const before = await evalJs(`(async () => { try { return await window.api.workspaceGetCurrent() } catch (e) { return { __err: String(e) } } })()`)
note('探针开始时的当前仓库', before?.name ?? '(无)')
const rootId0 = before?.rootId ?? null
const created = await evalJs(`(async () => {
  try { return await window.api.workspaceCreateVault(${JSON.stringify(VAULT_NAME)}, ${JSON.stringify(VAULT_PARENT)}) }
  catch (e) { return { error: String(e) } }
})()`)
myOk('临时仓库建好了', !!created?.rootId && !created?.error, created?.error || created?.path || '')
myOk('临时仓库落在临时目录里（不碰用户数据）', String(created?.path ?? '').startsWith(VAULT_PARENT), created?.path ?? '')
note('mock origin', srv.origin)

/** 原权限串（收尾原样还原；**不做 JSON 归一化重写**，免得把用户手写的格式改掉） */
const perm0 = await evalJs(`(async () => { try { return await window.api.getSetting('aiModulePermissions') } catch (e) { return { __err: String(e) } } })()`)
note('aiModulePermissions（原值，收尾还原）', typeof perm0 === 'string' ? perm0 : JSON.stringify(perm0))

/**
 * 改模块权限。**只动 bookMarket 这一键**，其余键原样保留（合并后再写回）——
 * 直接覆写整串会把别的模块的授权顺手清掉，那才是真的污染用户环境。
 */
const setPerm = async (level) => {
  const raw = typeof perm0 === 'string' && perm0 ? perm0 : '{}'
  let obj
  try { obj = JSON.parse(raw) } catch { obj = {} }
  obj.bookMarket = level
  const next = JSON.stringify(obj)
  const r = await evalJs(`(async () => { try { await window.api.setSetting('aiModulePermissions', ${JSON.stringify(next)}); return 'ok' } catch (e) { return String(e) } })()`)
  if (r !== 'ok') return r
  // 读回确认（设置写入是异步落盘的，后面立刻断言会读到旧值）
  return await until(async () => (await evalJs(`(async () => { try { const v = await window.api.getSetting('aiModulePermissions'); return typeof v === 'string' ? JSON.parse(v).bookMarket : '' } catch { return '' } })()`)) === level, 4000) ? 'ok' : 'not-applied'
}

// ===== ② 工具在册（清单来自真主进程）=====
console.log('\n--- ② 工具在册与元数据（主进程侧清单）---')
const toolList = await evalJs(`(async () => { try { const r = await window.api.aiToolsList(); return r.tools ?? [] } catch { return [] } })()`) || []
myOk('工具清单读得回（aiTools:list）', Array.isArray(toolList) && toolList.length > 10, `共 ${toolList.length} 枚`)
const byName = new Map(toolList.map((t) => [t.name, t]))
const T_LIST = byName.get(DRAFT_LIST)
const T_DRAFT = byName.get(DRAFT_APP)
myOk('两枚工具都在主进程注册表里', !!T_LIST && !!T_DRAFT, `清单共 ${toolList.length} 枚`)
myOk(`${DRAFT_LIST} = bookMarket / read / ondemand / readOnly`, !!T_LIST && T_LIST.module === 'bookMarket' && T_LIST.requires === 'read' && T_LIST.tier === 'ondemand' && T_LIST.readOnly === true, JSON.stringify(T_LIST && { m: T_LIST.module, r: T_LIST.requires, t: T_LIST.tier, ro: T_LIST.readOnly }))
myOk(`${DRAFT_APP} = bookMarket / write / ondemand / 非 readOnly`, !!T_DRAFT && T_DRAFT.module === 'bookMarket' && T_DRAFT.requires === 'write' && T_DRAFT.tier === 'ondemand' && T_DRAFT.readOnly === false, JSON.stringify(T_DRAFT && { m: T_DRAFT.module, r: T_DRAFT.requires, t: T_DRAFT.tier, ro: T_DRAFT.readOnly }))
myOk('★ 两枚都是 ondemand（不是 core）：书源配置是低频动作，常驻等于每轮白付 token',
  T_LIST?.tier === 'ondemand' && T_DRAFT?.tier === 'ondemand')
myOk('★ 可达性：draft 的 description 指了 list（tool.request 清单只提写工具，只读工具无人提及就进不了视野）',
  /booksource\.list/.test(String(T_DRAFT?.description ?? '')))

// ===== ③ 权限两档 =====
console.log('\n--- ③ 模块权限两档：read 拦写 / write 放行 ---')
// 同一枚工具、同一个入参（**故意给个非法地址**）：唯一变量是模块授权档位。
// 用非法地址是因为「write 放行」这一档若真放行了就会走到 handler，而 handler 对非法地址要么
// 报错（本工具的明确口径）要么开表单 —— 前者不污染界面，所以这条负向参数同时是「不开表单」的判据。
const PROBE_ARGS = { name: '权限探针源', url: 'ftp://not-http.example', kind: 'opds' }
const setRead = await setPerm('read')
myOk('aiModulePermissions 已置为 bookMarket=read', setRead === 'ok', setRead)
const listUnderRead = await invoke(DRAFT_LIST)
myOk('★ read 档：只读工具放行（list 返回 ok）', listUnderRead?.ok === true, JSON.stringify(listUnderRead).slice(0, 160))
const draftUnderRead = await invoke(DRAFT_APP, PROBE_ARGS)
myOk('★ read 档：写工具被硬校验拦下（MODULE_READONLY，不是「悄悄降级」）',
  draftUnderRead?.ok === false && draftUnderRead?.code === 'MODULE_READONLY', JSON.stringify(draftUnderRead).slice(0, 200))
myOk('（负向）被拦下时没有弹层被打开', (await formOpen()) === false)

const setWrite = await setPerm('write')
myOk('aiModulePermissions 已置为 bookMarket=write', setWrite === 'ok', setWrite)
const draftUnderWrite = await invoke(DRAFT_APP, PROBE_ARGS)
myOk('★ write 档：同一入参这次穿过权限闸，落到 handler 的业务报错（地址必须 http/https）',
  draftUnderWrite?.ok === false && draftUnderWrite?.code === 'EXEC_ERROR' && /http\/https/.test(String(draftUnderWrite?.message ?? '')),
  JSON.stringify(draftUnderWrite).slice(0, 200))

// ===== ④ 入参校验五条（都在写权限下）=====
console.log('\n--- ④ 入参校验：五条错误路径（错了就明确报错，不许静默降级）---')
const goodMapping = { list: 'data.books[*]', title: 'title', author: 'author', cover: 'cover_url', summary: 'summary', download: 'files[0].url', format: 'files[0].format' }
const V = {
  nameEmpty: await invoke(DRAFT_APP, { name: '', url: `${srv.origin}/json`, kind: 'custom', mappingJson: JSON.stringify(goodMapping) }),
  nameMissing: await invoke(DRAFT_APP, { url: `${srv.origin}/json` }),
  urlBad: await invoke(DRAFT_APP, { name: '校验源', url: 'ftp://x' }),
  kindBad: await invoke(DRAFT_APP, { name: '校验源', url: `${srv.origin}/json`, kind: 'html' }),
  noMapping: await invoke(DRAFT_APP, { name: '校验源', url: `${srv.origin}/json`, kind: 'custom' }),
  badJson: await invoke(DRAFT_APP, { name: '校验源', url: `${srv.origin}/json`, kind: 'custom', mappingJson: '{不是 JSON' }),
  thinMapping: await invoke(DRAFT_APP, { name: '校验源', url: `${srv.origin}/json`, kind: 'custom', mappingJson: JSON.stringify({ list: 'data.books[*]', title: 'title' }) }),
}
myOk('name 空串按缺失拒（schema required；空表单点不出去）', V.nameEmpty?.code === 'INVALID_ARGS', JSON.stringify(V.nameEmpty).slice(0, 140))
myOk('name 整个不给也拒', V.nameMissing?.code === 'INVALID_ARGS', JSON.stringify(V.nameMissing).slice(0, 140))
myOk('url 非 http/https → 明确报错（不静默接受）', V.urlBad?.code === 'EXEC_ERROR' && /http\/https/.test(String(V.urlBad?.message ?? '')), String(V.urlBad?.message ?? ''))
myOk('kind 不在枚举里 → schema 层就挡（INVALID_ARGS）', V.kindBad?.code === 'INVALID_ARGS', String(V.kindBad?.message ?? ''))
myOk('custom 源缺 mappingJson → 报「必须给出 mappingJson」', V.noMapping?.code === 'EXEC_ERROR' && /mappingJson/.test(String(V.noMapping?.message ?? '')), String(V.noMapping?.message ?? ''))
myOk('mappingJson 不是合法 JSON → 报「不是合法 JSON」', V.badJson?.code === 'EXEC_ERROR' && /JSON/.test(String(V.badJson?.message ?? '')), String(V.badJson?.message ?? ''))
myOk('★ 映射缺 list/title/download 任一条 → 拒（这是 §4.1 的痛点：半份映射的源搜不出东西）',
  V.thinMapping?.code === 'EXEC_ERROR' && /list \/ title \/ download/.test(String(V.thinMapping?.message ?? '')), String(V.thinMapping?.message ?? ''))
myOk('（负向）七条失败路径没有一条打开过弹层', (await formOpen()) === false)

// ===== ⑤ 主路径：草案 → 自动切模块 + 预填（模块**冷挂载**：本探针此前没进过书市）=====
console.log('\n--- ⑤ 主路径：草案到达 ⇒ 自动切书市 + 打开预填表单 ---')
// 先挪开：把「草案到达才切过去」的前置条件做成确定的（启动停在哪一页取决于上次退出时那页）
const left = await leaveBookMarket()
note('开场挪到别的模块', left)
await sleep(400)
const mountedBefore = await evalJs(`!!document.querySelector('[data-wb="bookMarket"]')`)
note('调用前书市模块是否已挂载', mountedBefore === true ? '已挂载（走事件路径）' : '未挂载（走暂存路径 —— 正是「广播早于挂载」那条）')
myOk('（前提）此刻书市没被激活：左栏无高亮', (await railMarked()) === false)
myOk('（前提）此刻书市不可见（Tab 保活下「存在」不等于「可见」）', (await modVisible()) === false)

const rawBefore = sourcesFileRaw()
const DRAFT1 = {
  name: '我家 Calibre', url: `${srv.origin}/json`, kind: 'custom',
  searchUrl: `${srv.origin}/json?q={query}&page={page}`,
  responseType: 'json', authType: 'basic',
  mappingJson: JSON.stringify(goodMapping),
}
const r1 = await invoke(DRAFT_APP, DRAFT1)
myOk('草案工具返回 ok:true + 草案原文', r1?.ok === true && !!r1?.data?.draft, JSON.stringify(r1).slice(0, 200))
// ★ toast 先读：默认 5s 就过期了，夹在后面的等待里会读不到
myOk('★ toast 说明了界面为什么跳（不然用户不知道屏幕怎么自己换了）',
  await until(async () => (await bodyText()).includes('AI 起草了一份书源配置'), 3000), await (async () => { const t = await bodyText(); const i = t.indexOf('AI 起草'); return i < 0 ? '(没找到)' : t.slice(i, i + 60) })())
myOk('★ 自动切到书市：模块出现且**可见**（Tab 保活机制下「存在」不等于「可见」）', await until(modVisible))
myOk('★ 左栏高亮跟着切过去', await until(railMarked))
myOk('跳到「书源」视图（草案说的是「去配一个源」，落到检索页等于白跳）', await until(sourcesViewActive))
myOk('弹开了「新建书源」表单', await until(formOpen))
myOk('表单标题是「新增书源」（不是「编辑」——草案永远走新增态）', (await sheetTitle()) === '新增书源', String(await sheetTitle()))

const inputs = await sheetInputMeta()
note('表单输入框（DOM 顺序）', JSON.stringify((inputs ?? []).map((i) => ({ t: i.type, v: i.v.slice(0, 28), ph: i.ph.slice(0, 18) }))))
const vals = (inputs ?? []).map((i) => i.v)
myOk('名称已预填', vals[0] === DRAFT1.name, String(vals[0]))
myOk('地址已预填', vals[1] === DRAFT1.url, String(vals[1]))
myOk('检索模板已预填', vals[2] === DRAFT1.searchUrl, String(vals[2]))
const MAP_KEYS = ['list', 'title', 'author', 'cover', 'summary', 'download', 'format']
myOk('★ 七行字段映射全部按草案预填（custom 源的主战场；顺序 = MAP_ROWS）',
  JSON.stringify(vals.slice(3, 10)) === JSON.stringify(MAP_KEYS.map((k) => goodMapping[k])),
  JSON.stringify(vals.slice(3, 10)))
myOk('认证档位跟着草案切到 Basic（草案带 authType）',
  (inputs ?? []).some((i) => i.type === 'password'), JSON.stringify((inputs ?? []).map((i) => i.type)))
myOk('★★ 凭据框恒为空：用户名空', vals[10] === '' || vals[10] === undefined, String(vals[10]))
myOk('★★ 凭据框恒为空：密码空', vals[11] === '' || vals[11] === undefined, String(vals[11]))
myOk('★★ 凭据负向：草案的返回值里也没有任何凭据键',
  !/(username|password|passwd|token|secret|credential)/i.test(JSON.stringify(r1?.data?.draft ?? {})))
myOk('★ 草案**不落库**：书源文件此刻还没被写过（用户点「添加」才算配好）',
  sourcesFileRaw() === rawBefore, sourcesFileRaw() === rawBefore ? '文件未变' : '文件已被改写')

// ===== ⑥ 取消即弃 + 不复现 =====
console.log('\n--- ⑥ 取消即弃草案（下次点「新增书源」不许带出旧草案）---')
myOk('点「取消」', (await sheetBtn('取消')) === 'ok')
myOk('弹层关掉了', await until(async () => (await formOpen()) === false))
await sleep(300)
myOk('点模块栏「新增书源」', (await moduleBtn('新增书源')) === 'ok')
myOk('弹层又开了', await until(formOpen))
const emptyVals = await sheetInputs()
myOk('★ 是**空**表单：名称 / 地址都是空（草案已被丢弃）',
  Array.isArray(emptyVals) && emptyVals[0] === '' && emptyVals[1] === '',
  JSON.stringify((emptyVals ?? []).slice(0, 3)))
myOk('（负向）也没有残留的映射行（kind 回到默认 OPDS ⇒ 自定义块收起、子树不挂载）',
  Array.isArray(emptyVals) && emptyVals.length === 2, `输入框 ${(emptyVals ?? []).length} 个`)
myOk('关掉空表单', (await sheetBtn('取消')) === 'ok')

// ===== ⑦ 二次草案（模块已挂载 → 事件路径）+ 真保存 =====
console.log('\n--- ⑦ 第二份草案（模块已挂载：走 window 事件那条路）⇒ 添加并测试 ⇒ 真落库 ---')
const DRAFT2 = { name: '探针 OPDS 源', url: `${srv.origin}/opds`, kind: 'opds' }
const r2 = await invoke(DRAFT_APP, DRAFT2)
myOk('第二份草案（OPDS）返回 ok', r2?.ok === true, JSON.stringify(r2).slice(0, 160))
myOk('表单再次打开且预填了第二份草案',
  await until(formOpen) && (await sheetInputs())?.[0] === DRAFT2.name, JSON.stringify((await sheetInputs())?.slice(0, 2)))
myOk('★ 模块**已挂载**时也切到「书源」视图（这条走的是 window 事件，不是暂存）', await until(sourcesViewActive))
const rawBefore2 = sourcesFileRaw()
myOk('点「添加并测试」', (await sheetBtn('添加并测试')) === 'ok')
myOk('★ 真落库：书源文件被改写了，且新源在里面',
  await until(() => { const s = sourcesFileRaw(); return !!s && s !== rawBefore2 && s.includes(DRAFT2.name) }, 12000),
  (sourcesFileRaw() ?? '').includes(DRAFT2.name) ? '已在文件里' : '文件里没有')
myOk('弹层自动关闭（保存成功即收）', await until(async () => (await formOpen()) === false, 8000))
myOk('★ 源清单出现该源 + 连通性「已连通」（真发了一次请求，打到 mock OPDS）',
  await until(async () => (await rowState(DRAFT2.name)) === '已连通', 15000), String(await rowState(DRAFT2.name)))
myOk('mock 源真的收到了那次探测请求', srv.hits.some((h) => h.path === '/opds'), srv.hits.map((h) => h.path).join(','))
const after = await invoke(DRAFT_LIST)
myOk('★ list 工具看得到新源（工具与界面读同一份数据）',
  (after?.data?.sources ?? []).some((s) => s.name === DRAFT2.name), (after?.data?.sources ?? []).map((s) => s.name).join(','))
myOk('list 只回「凭据是否已存」布尔，不回凭据内容',
  (after?.data?.sources ?? []).every((s) => typeof s.hasCredential === 'boolean' && !/(username|password|passwd|token|secret)/i.test(JSON.stringify(s))))
myOk('list 的返回里零凭据标记值', !JSON.stringify(after ?? {}).includes(LEAK.USER) && !JSON.stringify(after ?? {}).includes(LEAK.TOKEN))

// ===== ⑧ 凭据负向（放最后：它会开一次表单，先把前面几跳的时序保住）=====
console.log('\n--- ⑧ 凭据负向：AI 永远拿不到凭据（多给的字段进不来）---')
const r3 = await invoke(DRAFT_APP, {
  ...DRAFT1, name: '凭据负向源',
  username: LEAK.USER, password: LEAK.PASS, token: LEAK.TOKEN,
})
myOk('多给的凭据字段不会让调用失败（schema 忽略未知键，不会「报错让人以为不支持」）', r3?.ok === true, JSON.stringify(r3).slice(0, 160))
const d3 = r3?.data?.draft
myOk('★★ 草案里没有 username/password/token 任何一个键（白名单拷贝，不是过滤）',
  !!d3 && !Object.keys(d3).some((k) => /user|pass|token|secret|credential/i.test(k)), JSON.stringify(Object.keys(d3 ?? {})))
myOk('★★ 草案返回值的字节里一个凭据标记值都没有', !JSON.stringify(r3 ?? {}).includes(LEAK.USER) && !JSON.stringify(r3 ?? {}).includes(LEAK.PASS) && !JSON.stringify(r3 ?? {}).includes(LEAK.TOKEN))
const i3 = await sheetInputMeta()
const v3 = (i3 ?? []).map((i) => i.v)
myOk('★★ 预填表单里也没有任何一格被写上凭据（名称/地址以外全是映射或空）',
  v3.every((v) => !v.includes(LEAK.USER) && !v.includes(LEAK.PASS) && !v.includes(LEAK.TOKEN)), JSON.stringify(v3.map((v) => v.slice(0, 20))))
myOk('（负向）该源此刻还没被写进书源文件（草案不落库这条对每一次调用都成立）',
  !(sourcesFileRaw() ?? '').includes('凭据负向源'))
await sheetBtn('取消')

// ===== ⑨ 生产构建负向：DEV 钩子不留在产物里 =====
console.log('\n--- ⑨ dev-only 钩子：生产产物里 window 上不留口子（拍板 ② 的负向锁）---')
{
  const hook = await evalJs(`typeof window.__kbBookSourceDraft`)
  myOk('★ `npm run build` 的产物里 window.__kbBookSourceDraft 不存在（`import.meta.env.DEV` 已被静态替换 ⇒ 整段被消除）',
    hook === 'undefined', String(hook))
}

// ===== 收尾 =====
const errs = await evalJs(`(window.__errs || []).slice(0, 8)`)
myOk('渲染层无未捕获错误 / 未处理 rejection（含 CSP 违规与 React 报错）',
  Array.isArray(errs) && errs.length === 0, JSON.stringify(errs))

// 还原权限串（原样写回；置不回去就明说，不静默）
if (typeof perm0 === 'string') {
  const back = await evalJs(`(async () => { try { await window.api.setSetting('aiModulePermissions', ${JSON.stringify(perm0)}); return 'ok' } catch (e) { return String(e) } })()`)
  note('aiModulePermissions 已还原', back === 'ok' ? 'ok' : `失败：${back}`)
} else {
  note('aiModulePermissions 原本读不出来，未还原', JSON.stringify(perm0))
}

// 还原当前仓库（不要把用户的 dev 现状留在探针仓库上）
if (rootId0) {
  const back = await evalJs(`(async () => { try { return await window.api.workspaceOpenById(${JSON.stringify(rootId0)}) } catch (e) { return { error: String(e) } } })()`)
  note('当前仓库已还原', back?.name ?? JSON.stringify(back))
} else {
  note('探针开始时没有当前仓库，故不还原', '')
}

const out = { when: new Date().toISOString(), electron: process.versions.electron, base: BASE, vault: VAULT, mock: srv.origin, checks, console: { errors: errs } }
try {
  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true })
  writeFileSync(join(process.cwd(), 'tmp', 'book-market-s5-tools.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log('\n留档：tmp/book-market-s5-tools.json')
} catch (e) {
  console.log('留档失败：', String(e))
}
console.log(`临时仓库留档（人工复核用）：${VAULT}`)
await closeSrv()
A.finish()
