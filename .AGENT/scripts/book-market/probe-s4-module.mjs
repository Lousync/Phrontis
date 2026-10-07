/**
 * 书市 S4 探针 —— 模块 UI 的**实机**验收（真 electron + 真渲染层 + 本地 mock 书源 + CDP）。
 *
 * ## 为什么是 CDP 驱动，而不是像 S1/S2/S3 那样在 electron 主进程里跑
 * S1–S3 验的是「磁盘字节 / 网络请求 / 队列状态」，主进程里跑最直接。S4 验的是**界面**：
 * 模块挂不挂得上、左栏高亮对不对、切走切回状态还在不在、书卡标没标「暂不支持」、
 * 详情抽屉里的下载钮是不是真禁用、书架那三行字是不是真来自 meta —— 这些只有渲染层里看得见。
 * 所以本探针是**驱动方**（node 侧连 CDP），electron 是被驱动的真应用。宿主用既有的
 * `workbench-shell/probes/run-probe.mjs`（spawn `electron .` + CDP 端口 + 收尾），
 * CDP 管道复用 `reader-probe-kit.mjs` 的 `connect()`（阅读器探针那套，已冻结）。
 *
 * ★ 与方案 §11.6 的字面差异（一句）：方案写的是 `probe-s4-module.cjs`「复用 S3 探针骨架」。
 *   实测这条走不通 —— S3 骨架是**主进程内**跑真实实现（`require` 打包产物），而 UI 必须在
 *   渲染层里测；`reader-probe-kit` 是 ESM，`.cjs` 只能靠动态 `import()` 绕（更难读）。
 *   故按 .mjs 写、复用阅读器探针宿主。**验的是同一件事，没减项**。
 *
 * ## 覆盖（方案 §八 7 / 8 / 9 / 10 / 14 + §11.4 的书架收口正向断言）
 *   ① 前置：临时仓库 + 两个 mock 书源（**停用两个预置源**，见下「探针纪律」）
 *   ② 模块挂载与左栏高亮（§八 7 前半）
 *   ③ 检索 + 分页去重 + 切视图 / 切走再切回的状态保持（§八 7 后半；铁律：Tab 首挂后保活）
 *   ④ 格式闸：只给 `.mobi` 的条目书卡标「暂不支持」+ 详情里下载钮 `disabled` 带原因（§八 14）
 *   ⑤ 端到端：检索 → 详情 → 下载 → 上架 → 书架出现该书，且**书名/作者/封面三项真值来自 meta**
 *      （§八 8 + §11.4；这项直接锁死「渲染层自己再推一遍书名」那类回归）
 *   ⑥ 同名冲突：第二次下载同一本 → 弹「覆盖 / 另存副本」→ 另存副本落 ` (2)`（§八 11）
 *   ⑦ 下载队列：并发恒 1 · 暂停后排队项接管 · 取消 · 全部暂停/开始 · 清除已完成（§八 10）
 *   ⑧ 三态连通性：已连通 / 需要凭据 / 填凭据后已连通（§八 9）+ 凭据负向（含一条正向）
 *
 * ## 探针纪律：三条（都来自首轮踩坑，改动前先读）
 *   1. **不碰公网**：预置源（Gutenberg / Standard Ebooks）默认启用且真会发外部请求 ——
 *      不关掉它们，判定就取决于本机网速，结果集里还会混进真书名。开场即 `setSourceEnabled(false)`。
 *   2. **结果卡只在结果网格里捞**（模块栏那个「下载」pill 也带 title），**采样前先等检索结束**
 *      （检索中结果区是骨架屏）。判据与理由见下方「界面操作小工具」。
 *   3. **点按钮一律在作用域里找**：书源页自己也有个「保存」（代理行），弹层是就地渲染的，
 *      document 顺序上它在前面 —— 全局 `find(/保存/)` 点的是它。同理三态标签只读行内那个
 *      58px 的格子（往上走一层就串到别的源的行里去了）。
 *
 * ## 本轮逮到的**产品缺陷**（不是探针缺陷，已随 S4 修，见 commit）
 *   界面新建源送的是 `auth: { type, ref: '' }`（id 由主进程 randomUUID 生成，界面给不出），
 *   而 schema 的 `coerceAuth` 早期要求 ref 非空才收 ⇒ 勾了 Basic/Bearer 的源被**静默降级**成
 *   `auth: null`：源行显示「无需登录」、没有「填凭据」入口、检索也不带 Authorization。
 *   修法：ref 不参与判定（它恒由 `bookSourceUpsert` 改写成源 id）。
 *
 * ## 隔离与副作用（照 S1/S3 的约定）
 * ★ **不碰用户的仓库数据**：探针自己 `workspaceCreateVault` 建一个**临时仓库**（在系统临时目录里），
 *   下载、上架、扫描全落在它里面；结束后把「当前仓库」还原回探针开始时那一个。
 * ★ userData 走应用的 dev 隔离分支（`%APPDATA%/knowbase (dev <检出目录名>)`）—— 与正式数据无关。
 * ★ 临时目录**不删**（便于人工复核），路径打在输出里。
 *
 * 跑法（两步；先 build，`electron .` 读的是 `out/main/index.js`）：
 *   npm run build
 *   KNOWBASE_PROBE_PORT=9322 node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/book-market/probe-s4-module.mjs
 *
 * ★ 换端口不是洁癖：9222 是 CDP 默认端口，会被本机常驻的其它 electron（dev 实例 / WorkBuddy）
 *   占住；占住之后 `/json/list` 仍会返回**别人**的 page target，探针就连到别的应用上去了
 *   （见下方「身份闸」）。宿主与探针读同一个 `KNOWBASE_PROBE_PORT`，两处必须一致。
 *
 * 产物：stdout 一份逐条断言 + `tmp/book-market-s4-module.json`（留档）
 */

import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createAssertions } from '../workbench-shell/probes/lib/reader-probe-kit.mjs'

const A = createAssertions()
const { ok, note } = A

const BASE = mkdtempSync(join(tmpdir(), 'kb-probe-s4-'))
const VAULT_PARENT = join(BASE, 'vaults')
const VAULT_NAME = '书市探针仓库'
mkdirSync(VAULT_PARENT, { recursive: true })

/** 落盘后的书籍绝对路径（只在探针侧判磁盘字节，不走界面） */
const VAULT = join(VAULT_PARENT, VAULT_NAME)
const BOOKS = join(VAULT, '.books')
const META_FILE = join(BOOKS, '.meta.json')

/** 上架目标：`作者甲 - 书名甲.epub`（`safeBookFileName` 的口径，由 verify-downloader.mjs 静态锁） */
const MAIN_TITLE = '书名甲'
const MAIN_AUTHOR = '作者甲'
const MAIN_REL = `.books/${MAIN_AUTHOR} - ${MAIN_TITLE}.epub`
const MAIN_ABS = join(BOOKS, `${MAIN_AUTHOR} - ${MAIN_TITLE}.epub`)
/** 另存副本的落盘名（下载器 `copyNameFor` 的规则：扩展名前插 ` (2)`） */
const COPY_ABS = join(BOOKS, `${MAIN_AUTHOR} - ${MAIN_TITLE} (2).epub`)
/** 格式闸那条：源只给 mobi 收敛（`application/x-mobipocket-ebook`）⇒ `bookExtFromMime` 认不出 ⇒ 不可读 */
const MOBI_TITLE = '莫比书'

// ===== 字节体（逐字节可比：全填同一个值的话，偏移错一位也照样「相等」）=====
function bodyOf(n, seed) {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 17) & 0xff
  return b
}
const EPUB_MAIN = bodyOf(700 * 1024, 1)
const EPUB_SLOW1 = bodyOf(2 * 1024 * 1024, 5)
const EPUB_SLOW2 = bodyOf(2 * 1024 * 1024, 6)
const EPUB_SLOW3 = bodyOf(2 * 1024 * 1024, 7)
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), bodyOf(4000, 9)])
const LEAK = { USER: 'LEAKUSERs4c41', PASS: 'LEAKPASSs4c41' }
const BASIC_EXPECTED = 'Basic ' + Buffer.from(`${LEAK.USER}:${LEAK.PASS}`, 'utf-8').toString('base64')

const RANGE_RE = /^bytes=(\d+)-$/

function sendBuf(req, res, buf, type) {
  const m = RANGE_RE.exec(String(req.headers.range || ''))
  if (m) {
    const off = Number(m[1])
    if (off >= buf.length) { res.writeHead(416); res.end(); return }
    const seg = buf.subarray(off)
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': String(seg.length),
      'Content-Range': `bytes ${off}-${buf.length - 1}/${buf.length}`, 'Accept-Ranges': 'bytes',
    })
    res.end(seg)
    return
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(buf.length), 'Accept-Ranges': 'bytes' })
  res.end(buf)
}

/** 涓流：给「下载中 / 暂停 / 排队接管」留出足够长的在飞窗口 */
function sendSlow(req, res, buf, type, chunk, delayMs) {
  if (RANGE_RE.test(String(req.headers.range || ''))) {
    const off = Number(RANGE_RE.exec(String(req.headers.range))[1])
    if (off >= buf.length) { res.writeHead(416); res.end(); return }
    const seg = buf.subarray(off)
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': String(seg.length),
      'Content-Range': `bytes ${off}-${buf.length - 1}/${buf.length}`, 'Accept-Ranges': 'bytes',
    })
    trickle(res, seg, chunk, delayMs)
    return
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(buf.length), 'Accept-Ranges': 'bytes' })
  trickle(res, buf, chunk, delayMs)
}
function trickle(res, buf, chunk, delayMs) {
  let off = 0
  const tick = () => {
    if (res.writableEnded || res.destroyed) return
    if (off >= buf.length) { res.end(); return }
    res.write(buf.subarray(off, off + chunk))
    off += chunk
    setTimeout(tick, delayMs)
  }
  tick()
}

// ===== OPDS feed =====
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** 一条 entry：acquisition（可带 cover 链接、summary、length） */
function entry(e, origin) {
  const links = [`<link href="${origin}${e.dl}" type="${e.type}" rel="http://opds-spec.org/acquisition" length="${e.len ?? 1024}"/>`]
  if (e.cover) links.push(`<link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="${origin}${e.cover}"/>`)
  return `<entry><title>${esc(e.title)}</title>${e.author ? `<author><name>${esc(e.author)}</name></author>` : ''}${e.summary ? `<summary>${esc(e.summary)}</summary>` : ''}${links.join('')}</entry>`
}
function feed(entries, origin) {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>探针 mock 源</title>
  <link rel="self" href="${origin}/opds/search" type="application/atom+xml;profile=opds-catalog"/>
  ${entries.map((e) => entry(e, origin)).join('\n  ')}
</feed>`
}

/** mock 源（一个 origin = 一个源；测并发必须多个 origin，见 probe-s3 头注 ③） */
function mkSrv(tag, routes) {
  const s = { tag, hits: [], origin: '' }
  s.srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    s.hits.push({
      path: u.pathname, search: u.search, page: u.searchParams.get('page') || '',
      query: u.searchParams.get('query') || '', auth: String(req.headers.authorization || ''),
    })
    const route = routes[u.pathname]
    if (!route) { res.writeHead(404); res.end('nope'); return }
    try { route(req, res, u) } catch { try { res.destroy() } catch { /* 客户端中止是常态 */ } }
  })
  s.listen = () => new Promise((r) => s.srv.listen(0, '127.0.0.1', () => { s.origin = `http://127.0.0.1:${s.srv.address().port}`; r(s) }))
  s.hitsOn = (p) => s.hits.filter((h) => h.path === p)
  s.close = () => new Promise((r) => s.srv.close(r))
  return s
}

const SRC_A = '源甲'
const SRC_B = '源乙需凭据'

const srvA = await mkSrv('A', {
  // 检索：page 1 → 三本（书甲可读 + pdf + **只给 mobi 的那本**，见下）；page 2 → 新的一本；
  // page ≥3 → 又发同一本（模拟「源不认 page 参数」）→ 界面必须收掉「加载更多」
  //
  // ★ mobi 必须是**独立一条 entry**：解析器每条 entry 只选一条 acquisition（`toBookMarketItems`
  //   取第一条可读的候选），把 epub 与 mobi 挂在同一条 entry 上，解析出来永远只有那条 epub ——
  //   首轮就是这么写的，于是「暂不支持」的书卡压根没出现过。
  '/opds/search': (req, res, u) => {
    const page = Number(u.searchParams.get('page') || '1')
    const origin = srvA.origin
    let list
    if (page <= 1) {
      list = [
        { title: MAIN_TITLE, author: MAIN_AUTHOR, summary: '简介甲：用于断言详情抽屉与上架后的元数据自愈。', dl: '/dl/1', type: 'application/epub+zip', len: EPUB_MAIN.length, cover: '/c/1.jpg' },
        { title: '第二本', author: '作者乙', dl: '/dl/3', type: 'application/pdf', len: 4096 },
        { title: MOBI_TITLE, author: '作者丁', dl: '/dl/2.mobi', type: 'application/x-mobipocket-ebook', len: 2222 },
      ]
    } else if (page === 2) {
      list = [{ title: '第二页的书', author: '作者戊', dl: '/dl/p2', type: 'application/epub+zip', len: 2048 }]
    } else {
      list = [{ title: '第二页的书', author: '作者戊', dl: '/dl/p2', type: 'application/epub+zip', len: 2048 }]
    }
    res.writeHead(200, { 'Content-Type': 'application/atom+xml;profile=opds-catalog' })
    res.end(feed(list, origin))
  },
  '/dl/1': (req, res) => sendBuf(req, res, EPUB_MAIN, 'application/epub+zip'),
  '/dl/3': (req, res) => sendBuf(req, res, Buffer.from('%PDF-1.4 probe'), 'application/pdf'),
  '/dl/p2': (req, res) => sendBuf(req, res, bodyOf(2048, 8), 'application/epub+zip'),
  '/dl/slow1': (req, res) => sendSlow(req, res, EPUB_SLOW1, 'application/epub+zip', 16 * 1024, 30),
  '/dl/slow2': (req, res) => sendSlow(req, res, EPUB_SLOW2, 'application/epub+zip', 16 * 1024, 30),
  '/dl/slow3': (req, res) => sendSlow(req, res, EPUB_SLOW3, 'application/epub+zip', 16 * 1024, 30),
  '/c/1.jpg': (req, res) => sendBuf(req, res, JPEG, 'image/jpeg'),
}).listen()

const srvB = await mkSrv('B', {
  '/auth/opds': (req, res) => {
    if (String(req.headers.authorization || '') !== BASIC_EXPECTED) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="probe"' }); res.end('need auth'); return }
    res.writeHead(200, { 'Content-Type': 'application/atom+xml;profile=opds-catalog' })
    res.end(feed([{ title: '凭据源的书', author: '作者己', dl: '/dl/b1', type: 'application/epub+zip', len: 1024 }], srvB.origin))
  },
  '/dl/b1': (req, res) => sendBuf(req, res, bodyOf(1024, 3), 'application/epub+zip'),
}).listen()

note('mock origins', `A=${srvA.origin} B=${srvB.origin}`)
note('临时仓库父目录', VAULT_PARENT)

// ===== 连接 CDP =====
const K = await connect({ readySelector: 'button[title="书市"]' })
const { evalJs, sleep } = K

/**
 * ★★ 身份闸：**先确认连上的是本检出的应用，再开始断言**。
 *
 * 为什么必须有：CDP 端口是「先到先得」的 —— 2026-09-22 实测踩到一次，9222 已被**别的**
 * electron 实例占住，`/json/list` 照样返回一个可连的 page target，于是探针连上了**另一个应用**，
 * 表象是一串莫名其妙的断言失败（`window.api.bookMarketUpsertSource is not a function`、
 * 左栏没有「书市」按钮）。这类失败不但浪费时间，更危险的是**反向**：驱动了别的目标却恰好全绿，
 * 就是一次假 PASS。所以地址对不上就**当场停**，不做任何业务断言。
 *
 * 端口撞车仍可能发生 → 宿主支持 `KNOWBASE_PROBE_PORT` 覆盖（探针读同一个环境变量）。
 */
{
  const expectHref = `file:///${process.cwd().replace(/\\/g, '/')}/out/renderer/index.html`
  const href = String(await evalJs(`location.href`) ?? '')
  const apiOk = await evalJs(`typeof (window.api && window.api.bookMarketUpsertSource)`) === 'function'
  if (href !== expectHref || !apiOk) {
    console.error('\n★ 身份闸未通过 —— CDP 连上的不是本检出的应用，探针立即中止（不做业务断言）。')
    console.error(`  期望页面：${expectHref}`)
    console.error(`  实际页面：${href || '(空)'}`)
    console.error(`  window.api.bookMarketUpsertSource 是函数：${apiOk}`)
    console.error('  多半是 CDP 端口被别的 electron 占住了；换端口重跑：')
    console.error('    KNOWBASE_PROBE_PORT=9322 node .AGENT/scripts/workbench-shell/probes/run-probe.mjs <本探针>')
    A.finish()
  }
  ok('身份闸：连上的是本检出构建的渲染层（file:///<cwd>/out/renderer/index.html）', true, href)
  ok('身份闸：window.api 上这批书市通道在位', apiOk)
}

/** 渲染层里点一个 title= 的按钮（左栏图标条 / 书架卡片 / 队列图标钮都用它） */
const clickTitle = (title, scope = 'document') => `(() => {
  const b = [...${scope}.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === ${JSON.stringify(title)})
  if (!b) return 'no-btn'
  b.scrollIntoView({ block: 'nearest' })
  b.click()
  return 'ok'
})()`
/** 按可见文本点按钮（分段控件 / 「检索」/「知道了」这类无 title 的） */
const clickText = (text, scope = 'document') => `(() => {
  const b = [...${scope}.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(text)})
  if (!b) return 'no-btn'
  b.click()
  return 'ok'
})()`
/** React 受控输入：必须走原生 setter + input 事件，直接改 value 不会触发 onChange */
const setInput = (sel, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return 'no-el'
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`
const txt = (sel) => evalJs(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '')`)
const qty = (sel) => evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`)
/** 等一个判据成真（轮询），返回最终是否成真 —— 探针里所有「等界面反应」都走它，不用裸 sleep 赌 */
async function until(fn, ms = 8000, step = 60) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > ms) return false
    await sleep(step)
  }
}

const results = []
const checks = []
const myOk = (name, cond, extra = '') => { checks.push({ name, ok: !!cond, extra: String(extra) }); ok(name, cond, extra) }

// ===== 界面操作小工具 =====
//
// ★★ 三条**踩过的坑**都收在这里（S4 首轮三条全踩了一遍，表象都是「明明看得见那个按钮却点不到/判错」）：
//
//   ① **结果卡不能全局捞 `button[title]`**：模块栏那个「下载」pill 也带 title（=「下载队列」），
//      会被当成一张书卡混进结果集 —— 首轮「去重」断言看到的卡就是 `["下载队列"]`。
//      结果网格有稳定类名（`grid-cols-[repeat(auto-fill,minmax(148px,1fr))]`），只在该容器里捞。
//   ② **检索中时整个结果区被骨架屏替换**（DiscoverView 的 `loading ? <Skeleton/> : …`），
//      那一刻捞卡必然捞到空 —— 采样前一律先等「检索中…」消失，别跟加载态抢。
//   ③ **抽屉是「再点一次就收起」的切换**（`onSelect` 里写的是 `prev === key ? null : key`）：
//      切走再切回后 `selKey` 还在 ⇒ 再点一下是**关掉**它，而退场动画期间元素还在 DOM 里
//      （`usePresence` 延迟卸载），顺手点「重新下载」就点进了正在消失的抽屉。
//      `openDrawer()` 会等它真开稳（class 不是 `kb-drawer-out`），必要时再点一次。
const GRID = '[data-wb="bookMarket"] [class*="auto-fill"]'
const DRAWER = '[data-wb="bookMarketDetail"]'
const cardsOf = () => evalJs(`[...document.querySelectorAll('${GRID} button[title]')].map((b) => b.getAttribute('title'))`)
const cardText = (t) => evalJs(`(() => { const b = [...document.querySelectorAll('${GRID} button[title]')].find((x) => x.getAttribute('title') === ${JSON.stringify(t)}); return b ? b.textContent : null })()`)
/** 结果区是否还在「检索中」（骨架屏态） */
const searching = async () => (await evalJs(`(document.querySelector('[data-wb="bookMarket"]')?.textContent ?? '').includes('检索中')`)) === true
const waitSearchIdle = async (ms = 20000) => await until(async () => (await searching()) === false, ms)
const clickCard = (title) => evalJs(`(() => {
  const b = [...document.querySelectorAll('${GRID} button[title]')].find((x) => x.getAttribute('title') === ${JSON.stringify(title)})
  if (!b) return 'no-card'
  b.scrollIntoView({ block: 'nearest' })
  b.click()
  return 'ok'
})()`)
/** 打开详情抽屉并等它开稳（见上文 ③；返回 'ok' / 'no-card' / 'unstable'） */
async function openDrawer(title) {
  for (let i = 0; i < 3; i++) {
    const c = await clickCard(title)
    if (c !== 'ok') return c
    const present = await until(async () => (await evalJs(`!!document.querySelector('${DRAWER}')`)) === true, 4000)
    const settled = present && await until(async () => (await evalJs(`(() => { const d = document.querySelector('${DRAWER}'); return !!d && !d.className.includes('kb-drawer-out') })()`)) === true, 4000)
    if (settled) return 'ok'
  }
  return 'unstable'
}
const drawerBtn = (label) => evalJs(`(() => {
  const d = document.querySelector('${DRAWER}')
  if (!d) return 'no-drawer'
  const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
  if (!b) return 'no-btn'
  b.click(); return 'ok'
})()`)

/**
 * 弹层作用域：书市四个弹层共用 `Sheet` 壳（ModalShell → `.kb-overlay` 遮罩），**没有 data-wb 锚点**，
 * 所以按「遮罩里含某段文案」定位。
 *
 * ★ 为什么按钮必须在作用域里找：书源页自己也有一个「保存」（代理那行），而弹层是**就地渲染**的
 *   （不是 portal），document 顺序上代理那个「保存」在前 ⇒ 全局 `find(/保存/)` 点到的是它。
 *   首轮就是这么假 PASS 的：凭据压根没存，界面却因为「连通性标签读错行」显示成了「已连通」。
 */
const sheetScope = (needle) => `(() => {
  const ov = [...document.querySelectorAll('[class*="kb-overlay"]')].find((o) => (o.textContent || '').includes(${JSON.stringify(needle)}))
  return ov || null
})()`
const sheetText = (needle) => evalJs(`(() => { const ov = ${sheetScope(needle)}; return ov ? ov.textContent : null })()`)
const sheetBtn = (needle, label) => evalJs(`(() => {
  const ov = ${sheetScope(needle)}
  if (!ov) return 'no-sheet'
  const b = [...ov.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
  if (!b) return 'no-btn'
  b.click(); return 'ok'
})()`)

/**
 * 书源行：每行**最后**一个子元素是启停开关（`role="switch"`），它的父节点就是行 ——
 * 这是唯一稳定的行锚点（按类名找会踩 Tailwind 的方括号类名，按文本找会串到外层容器）。
 */
const srcRow = (name) => `(() => {
  const rows = [...document.querySelectorAll('[data-wb="bookMarket"] [role="switch"]')].map((sw) => sw.parentElement)
  const row = rows.find((r) => r && (r.textContent || '').includes(${JSON.stringify(name)}))
  return row || null
})()`
/**
 * 三态标签：只读行内那个 `w-[58px]` 的标签格。
 * ★ 不能在整行文本里正则找：行里还有一枚认证标签（「需要凭据」/「凭据已存」），且字符串往上
 *   走一层就串进了**别的源的行**（首轮就是拿模块根容器匹配的 ⇒ 源乙被判成源甲的「已连通」）。
 */
const rowState = (name) => evalJs(`(() => {
  const row = ${srcRow(name)}
  if (!row) return null
  const cell = row.querySelector('span[class*="58px"]')
  const t = (cell ? cell.textContent : row.textContent) || ''
  const m = t.match(/已连通|需要凭据|连接失败|未测试/)
  return m ? m[0] : null
})()`)
const rowBtn = (name, label) => evalJs(`(() => {
  const row = ${srcRow(name)}
  if (!row) return 'no-row'
  const b = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
  if (!b) return 'no-btn'
  b.click(); return 'ok'
})()`)

// ===== ① 前置：建临时仓库 + 造两个 mock 书源 =====
console.log('\n--- ① 前置：临时仓库 + mock 书源（全部走渲染层 IPC，即界面自己那条路）---')
const before = await evalJs(`(async () => { try { return await window.api.workspaceGetCurrent() } catch (e) { return { __err: String(e) } } })()`)
note('探针开始时的当前仓库', before?.name ?? '(无)')
const rootId0 = before?.rootId ?? null
const created = await evalJs(`(async () => {
  try { return await window.api.workspaceCreateVault(${JSON.stringify(VAULT_NAME)}, ${JSON.stringify(VAULT_PARENT)}) }
  catch (e) { return { error: String(e) } }
})()`)
myOk('临时仓库建好了', !!created?.rootId && !created?.error, created?.error || created?.path || '')
const ROOT = created?.rootId
myOk('临时仓库落在临时目录里（不碰用户数据）', String(created?.path ?? '').startsWith(VAULT_PARENT), created?.path ?? '')

const up1 = await evalJs(`(async () => { try { return await window.api.bookMarketUpsertSource(${JSON.stringify(ROOT)}, {
  name: ${JSON.stringify(SRC_A)}, kind: 'opds', url: ${JSON.stringify(srvA.origin)},
  searchUrl: ${JSON.stringify(`${srvA.origin}/opds/search?query={query}&page={page}`)},
  responseType: 'atom', auth: null,
  mapping: { list: '', title: '', author: '', cover: '', summary: '', download: '', format: '' },
}) } catch (e) { return { error: String(e) } } })()`)
myOk('mock 源甲（无需登录）已建', up1?.ok === true, up1?.error || up1?.source?.id || '')
const SRC_A_ID = up1?.source?.id

const up2 = await evalJs(`(async () => { try { return await window.api.bookMarketUpsertSource(${JSON.stringify(ROOT)}, {
  name: ${JSON.stringify(SRC_B)}, kind: 'opds', url: ${JSON.stringify(srvB.origin)},
  searchUrl: ${JSON.stringify(`${srvB.origin}/auth/opds?query={query}`)},
  responseType: 'atom', auth: { type: 'basic', ref: '' },
  mapping: { list: '', title: '', author: '', cover: '', summary: '', download: '', format: '' },
}) } catch (e) { return { error: String(e) } } })()`)
myOk('mock 源乙（需凭据）已建', up2?.ok === true, up2?.error || '')
const SRC_B_ID = up2?.source?.id

// ★★ 把两个预置源**停用**：这是本探针能重复跑的前提，不是洁癖。
//   预置源（Project Gutenberg / Standard Ebooks）默认启用，且**真的会走公网** ——
//   首轮探针没关它们，于是「检索」发出的是一轮真实的 Gutenberg 请求：结果集里混进了
//   真书名（`Surgical Instruments in Greek and Roman Times`、`Voyage to Jupiter`…），
//   检索慢到采样时还在骨架屏态，两条断言（去重 / 切回来结果还在）因此全红。
//   探针的契约是「只看我们自己那台 mock 服务器」——公网在不在、快不快都不该影响判定。
const PRESETS = ['builtin-gutenberg', 'builtin-standardebooks']
for (const id of PRESETS) {
  const off = await evalJs(`(async () => { try { return await window.api.bookMarketSetSourceEnabled(${JSON.stringify(ROOT)}, ${JSON.stringify(id)}, false) } catch (e) { return { error: String(e) } } })()`)
  myOk(`预置源 ${id} 已停用（探针不碰公网，判定只看 mock 源）`, off?.ok === true && off?.source?.enabled === false, off?.error || '')
}
const listed = await evalJs(`(async () => { try { return await window.api.bookMarketListSources(${JSON.stringify(ROOT)}) } catch (e) { return { error: String(e) } } })()`)
myOk('源清单读得回两条（预置源 + 我们自己加的）', (listed?.sources ?? []).filter((s) => s.name === SRC_A || s.name === SRC_B).length === 2,
  (listed?.sources ?? []).map((s) => s.name).join(','))
myOk('★ 此刻参与检索的只剩我们的两个 mock 源（预置源都停用了）',
  (listed?.sources ?? []).filter((s) => s.enabled).length === 2,
  (listed?.sources ?? []).filter((s) => s.enabled).map((s) => s.name).join(','))
// ★ 这条锁的是**真 bug**（S4 首轮逮到）：界面新建源时送的是 `auth: { type, ref: '' }`
//   （id 由主进程 randomUUID 生成，界面给不出），而 schema 早期要求 ref 非空才收 ⇒ 认证被静默
//   吞掉：源行显示「无需登录」、没有「填凭据」入口、检索也不带 Authorization。
//   断言放在**建源之后立刻**读 IPC 清单：数据层就错的话，后面那些界面断言全是连锁反应。
const srcB0 = (listed?.sources ?? []).find((s) => s.name === SRC_B)
myOk('★ 声明了 auth 的源，authType 原样落库（空入参 ref 不能把认证整条吞掉）',
  srcB0?.authType === 'basic' && srcB0?.hasCredential === false,
  JSON.stringify(srcB0 && { authType: srcB0.authType, hasCredential: srcB0.hasCredential }))

// ===== ② 模块挂载 + 左栏高亮（§八 7 前半）=====
console.log('\n--- ② 模块挂载与左栏高亮 ---')
const railState = `(() => {
  const b = [...document.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === '书市' && x.closest('div[class*="w-11"]'))
  if (!b) return { found: false }
  return { found: true, marked: !!b.querySelector('div[class*="left-"]') }
})()`
const railBefore = await evalJs(railState)
myOk('左栏图标条上有「书市」按钮', railBefore?.found === true)
myOk('未激活时没有高亮标记（负向基线）', railBefore?.marked === false)

const clicked = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === '书市' && x.closest('div[class*="w-11"]'))
  if (!b) return 'no-rail'
  b.click(); return 'ok'
})()`)
myOk('点击左栏「书市」', clicked === 'ok', clicked)
myOk('模块挂载：出现 [data-wb="bookMarket"]', await until(() => evalJs(`!!document.querySelector('[data-wb="bookMarket"]')`)))
const railAfter = await evalJs(railState)
myOk('左栏高亮标记出现在「书市」上', railAfter?.marked === true)
myOk('模块根是 h-full 而非 flex-1（铁律 11：flex-1 在块级槽位里是死属性 ⇒ 滚轮没反应）',
  (await evalJs(`(() => { const e = document.querySelector('[data-wb="bookMarket"]'); return e ? (e.className.includes('h-full') && !e.className.includes('flex-1')) : null })()`)) === true)
myOk('提示条在（首启 C 形态）且文案是订正后的口径',
  (await txt('[data-wb="bookMarket"]')).includes('只下载书架打得开的格式') && !(await txt('[data-wb="bookMarket"]')).includes('二期'))

// ===== ③ 检索态：检索 → 分页去重（§八 7 后半的「状态保持」一并验）=====
console.log('\n--- ③ 检索 + 分页去重 + 切视图/切走切回状态保持 ---')
const SEARCH_INPUT = '[data-wb="bookMarket"] input[placeholder="搜书名或作者"]'
await evalJs(setInput(SEARCH_INPUT, 'probe'))
await evalJs(clickText('检索', `document.querySelector('[data-wb="bookMarket"]')`))
myOk('检索出结果（mock 源甲第一页三本都在）',
  await until(async () => { await waitSearchIdle(); return (await cardsOf())?.includes(MAIN_TITLE) }, 15000), JSON.stringify(await cardsOf()))
myOk('书卡上作者与来源都在', String(await cardText(MAIN_TITLE) ?? '').includes(MAIN_AUTHOR) && String(await cardText(MAIN_TITLE) ?? '').includes(SRC_A))
myOk('结果集里只有 mock 源给的条目（预置源已停用 ⇒ 没有公网结果混进来）',
  (await cardsOf()).every((t) => [MAIN_TITLE, '第二本', MOBI_TITLE].includes(t)), JSON.stringify(await cardsOf()))

// 分页：page2 带来新条目 → 还有「加载更多」；page3 不带来新条目 → 按钮自己收掉
const hasMoreBtn = async () => (await evalJs(`[...document.querySelectorAll('[data-wb="bookMarket"] button')].some((b) => b.textContent.trim() === '加载更多')`)) === true
myOk('首屏有「加载更多」', await until(hasMoreBtn))
await evalJs(clickText('加载更多', `document.querySelector('[data-wb="bookMarket"]')`))
myOk('加载更多带来第二页的新条目', await until(async () => { await waitSearchIdle(); return (await cardsOf())?.includes('第二页的书') }))
myOk('第二页有新条目 ⇒ 「加载更多」还在', await hasMoreBtn())
await evalJs(clickText('加载更多', `document.querySelector('[data-wb="bookMarket"]')`))
myOk('第三页无新条目 ⇒ 「加载更多」自己收掉（留着 = 一个点了没反应的按钮）',
  await until(async () => (await hasMoreBtn()) === false))
myOk('去重：第三页重复的那本没有被追加第二遍',
  (await cardsOf())?.filter((t) => t === '第二页的书').length === 1, JSON.stringify(await cardsOf()))
// 分页真的发出去了（服务端侧看得见 query 与 page）：只认「同一个 query、至少两个不同 page」
const searchHits = srvA.hitsOn('/opds/search')
myOk('★ mock 源真的收到了 query=probe 的检索请求',
  searchHits.some((h) => h.query === 'probe'), searchHits.slice(0, 3).map((h) => h.search).join(' '))
myOk('★ 分页真的发出去了（同一 query 下至少两个不同 page）',
  new Set(searchHits.filter((h) => h.query === 'probe').map((h) => h.page)).size >= 2,
  [...new Set(searchHits.filter((h) => h.query === 'probe').map((h) => h.page))].join(','))
note('礼貌抓取（UA / 限并发）', '不在本探针重复验：S2 探针实测过 UA 与跨 origin 限并发 2')

// 切到「书源」再切回「发现」：检索结果与关键词都不能丢
await waitSearchIdle()
const cardsBeforeSwitch = await cardsOf()
await evalJs(clickText('书源', `document.querySelector('[data-wb="bookMarket"]')`))
await until(async () => (await evalJs(`document.querySelectorAll('[data-wb="bookMarket"] [role="switch"], [data-wb="bookMarket"] input[placeholder="http://127.0.0.1:7890"]').length`)) > 0)
myOk('切到「书源」页后书源行在（源甲 / 源乙都在）',
  String(await txt('[data-wb="bookMarket"]')).includes(SRC_A) && String(await txt('[data-wb="bookMarket"]')).includes(SRC_B))
await evalJs(clickText('发现', `document.querySelector('[data-wb="bookMarket"]')`))
myOk('切回「发现」：关键词还在', (await evalJs(`document.querySelector(${JSON.stringify(SEARCH_INPUT)})?.value`)) === 'probe')
myOk('切回「发现」：检索结果还在（切视图不丢结果）',
  JSON.stringify(await cardsOf()) === JSON.stringify(cardsBeforeSwitch),
  `${JSON.stringify(cardsBeforeSwitch)} → ${JSON.stringify(await cardsOf())}`)

// 切走（去书架）再切回「书市」：Tab 保活，状态同样不能丢
await evalJs(clickTitle('工作台'))
await sleep(700)
myOk('切到工作台后书市只是隐藏（保活，不卸载）', await evalJs(`!!document.querySelector('[data-wb="bookMarket"]')`))
await evalJs(`(() => { const b = [...document.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === '书市' && x.closest('div[class*="w-11"]')); if (b) { b.click(); return 'ok' } return 'no-rail' })()`)
await sleep(600)
myOk('切回来：检索结果仍在', JSON.stringify(await cardsOf()) === JSON.stringify(cardsBeforeSwitch),
  JSON.stringify(await cardsOf()))

// ===== ④ 格式闸：mobi 条目（§八 14）=====
console.log('\n--- ④ 格式闸：不可读格式标「暂不支持」且下载钮禁用 ---')
// 源甲第一页那第三条 entry 只给了 `application/x-mobipocket-ebook` 一个 acquisition ——
// 解析器按 MIME 判格式，认不出的那条落成 ext='' 的条目（verify-reader-formats 已锁负例）。
const mobiCard = await cardText(MOBI_TITLE)
myOk('出现了格式不可读的书卡并标「暂不支持」', String(mobiCard ?? '').includes('暂不支持'), String(mobiCard))
if (mobiCard !== null) {
  myOk('打开不可读那本的详情抽屉', (await openDrawer(MOBI_TITLE)) === 'ok')
  const drawer = await txt(DRAWER)
  myOk('详情抽屉里标了「暂不支持」', String(drawer).includes('暂不支持'))
  const disabled = await evalJs(`(() => {
    const d = document.querySelector('[data-wb="bookMarketDetail"]')
    const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === '下载')
    return b ? { found: true, disabled: b.disabled, title: b.title } : { found: false }
  })()`)
  myOk('详情里的下载钮是禁用的（不是「点了没反应」）', disabled?.found === true && disabled?.disabled === true, JSON.stringify(disabled))
  myOk('禁用钮带了原因（title）', String(disabled?.title ?? '').includes('打不开'), disabled?.title ?? '')
  await evalJs(clickTitle('关闭', `document.querySelector('[data-wb="bookMarketDetail"]')`))
  myOk('详情抽屉关得掉', await until(async () => (await evalJs(`!!document.querySelector('[data-wb="bookMarketDetail"]')`)) === false))
}

// ===== ⑤ 端到端：检索 → 详情 → 下载 → 上架（§八 8 + §11.4 书架收口正向断言）=====
console.log('\n--- ⑤ 端到端：详情 → 下载 → 上架 → 书架显示 meta 书名/作者/封面 ---')
myOk('上架前 .books/ 里没有这本书（负向基线）', !existsSync(MAIN_ABS))
myOk('打开可读那本的详情抽屉', (await openDrawer(MAIN_TITLE)) === 'ok')
const drawerTxt = String(await txt(DRAWER))
myOk('详情里书名 / 作者 / 来源 / 体积 / 保存为 都在',
  drawerTxt.includes(MAIN_TITLE) && drawerTxt.includes(MAIN_AUTHOR) && drawerTxt.includes(SRC_A) && drawerTxt.includes(MAIN_REL), '')
myOk('详情里显示了简介（mapping.summary 有值）', drawerTxt.includes('简介甲'))
myOk('点「下载」', (await drawerBtn('下载')) === 'ok')
myOk('下载队列面板自动浮出', await until(() => evalJs(`!!document.querySelector('[data-wb="bookMarketQueue"]')`)))
myOk('★ 下载完成、书名文件落盘（半截文件不上架：只有 rename 后才出现）',
  await until(() => existsSync(MAIN_ABS), 20000))
myOk('落盘字节与源给的一致（逐字节）',
  existsSync(MAIN_ABS) && Buffer.compare(readFileSync(MAIN_ABS), EPUB_MAIN) === 0)
myOk('书卡状态行变成「已上架」',
  await until(async () => String(await cardText(MAIN_TITLE) ?? '').includes('已上架'), 12000),
  String(await cardText(MAIN_TITLE)))
// meta.json：书名 / 作者 / 封面相对引用
let meta = null
try { meta = JSON.parse(readFileSync(META_FILE, 'utf8')) } catch { /* 下面断言会记账 */ }
const metaEntry = meta && (meta.books?.[MAIN_REL] ?? meta[MAIN_REL])
myOk('meta.json 里有这本书的条目', !!metaEntry, Object.keys(meta?.books ?? meta ?? {}).slice(0, 4).join(','))
myOk('meta 记的书名/作者就是源给的那份', metaEntry?.title === MAIN_TITLE && metaEntry?.author === MAIN_AUTHOR, JSON.stringify(metaEntry && { t: metaEntry.title, a: metaEntry.author }))
myOk('meta 记了封面相对引用', typeof metaEntry?.coverRel === 'string' && metaEntry.coverRel.startsWith('.books/.covers/'), metaEntry?.coverRel ?? '')
myOk('封面文件真的落盘了（不是只写了引用）', !!metaEntry?.coverRel && existsSync(join(VAULT, metaEntry.coverRel)), metaEntry?.coverRel ?? '')

// 书架：DTO 三字段真值 + 界面渲染
const dto = await evalJs(`(async () => { try { return await window.api.pdfReaderListBooks() } catch (e) { return { error: String(e) } } })()`)
const item = (dto?.books ?? []).find((b) => b.relPath === MAIN_REL)
myOk('DTO 里有这本书', !!item)
myOk('★ displayName = meta 书名（不是「作者 - 书名」那种文件名推导）',
  item?.displayName === MAIN_TITLE, `displayName=${item?.displayName}`)
myOk('★ author = meta 作者', item?.author === MAIN_AUTHOR, `author=${item?.author}`)
myOk('★ coverRef = meta 里的封面相对引用', item?.coverRef === metaEntry?.coverRel, `coverRef=${item?.coverRef}`)
// 去书架：走模块自己的「去书架」按钮（它调 handleTabChange('bookshelf')）
const goShelf = await drawerBtn('去书架')
myOk('详情里出现「去书架」（已上架态）', goShelf === 'ok', goShelf)
const shelfCard = `button[title="${MAIN_REL}"]`
myOk('书架里出现这本书（title = relPath）', await until(async () => (await evalJs(`!!document.querySelector(${JSON.stringify(shelfCard)})`)) === true, 12000))
const shelfTxt = String(await txt(shelfCard) ?? '')
myOk('★ 书架卡上显示的是 meta 书名（不是文件名），且作者另起一行',
  shelfTxt.includes(MAIN_TITLE) && !shelfTxt.includes(`${MAIN_AUTHOR} - ${MAIN_TITLE}`) && shelfTxt.includes(MAIN_AUTHOR), shelfTxt)
myOk('★ 书架卡上显示的是书市下到的真封面（data: 图，不是纯色书卡）',
  await until(async () => (await evalJs(`(() => {
    const c = document.querySelector(${JSON.stringify(shelfCard)})
    const img = c && c.querySelector('img')
    return !!img && String(img.getAttribute('src') || '').startsWith('data:')
  })()`)) === true, 12000))
// 回书市
await evalJs(`(() => { const b = [...document.querySelectorAll('button[title]')].find((x) => x.getAttribute('title') === '书市' && x.closest('div[class*="w-11"]')); if (b) { b.click(); return 'ok' } return 'no' })()`)
await until(() => evalJs(`!!document.querySelector('[data-wb="bookMarket"]')`))

// ===== ⑥ 同名冲突：覆盖 / 另存副本（模块弹层）=====
console.log('\n--- ⑥ 同名冲突：第二次下载同一本 → 问一句再落盘 ---')
// ★ 这里必须用 openDrawer 而不是裸点卡片：切走再切回后 `selKey` 还指着这本书，
//   直接再点一下是**关掉**抽屉（切换语义），首轮就是这么让后面的「重新下载」点空的。
myOk('回到书市后重开这本书的抽屉（已上架态）', (await openDrawer(MAIN_TITLE)) === 'ok')
// DuplicateSheet 的原话是「此书已存在」，两个选项是「覆盖」/「另存副本」（src/modules/bookmarket/DuplicateSheet.tsx）
myOk('点「重新下载」', (await drawerBtn('重新下载')) === 'ok')
myOk('第二次下载弹出了「此书已存在」的询问（不静默决定）',
  await until(async () => String(await sheetText('已存在') ?? '').includes('此书已存在'), 8000))
const dupeTxt = String(await sheetText('已存在') ?? '')
myOk('弹层里写明了原文件名与两种选择（覆盖 / 另存副本），不静默决定',
  dupeTxt.includes(MAIN_REL) && dupeTxt.includes('覆盖') && dupeTxt.includes('另存副本'), dupeTxt.slice(0, 80))
myOk('点「另存副本」', (await sheetBtn('已存在', '另存副本')) === 'ok')
myOk('★ 副本按「另存」落盘（文件名插 ` (2)`），原文件不动',
  await until(() => existsSync(COPY_ABS), 20000))
myOk('原文件与副本内容都对', existsSync(MAIN_ABS) && existsSync(COPY_ABS)
  && Buffer.compare(readFileSync(MAIN_ABS), EPUB_MAIN) === 0 && Buffer.compare(readFileSync(COPY_ABS), EPUB_MAIN) === 0)

// ===== ⑦ 队列控制（§八 10）=====
console.log('\n--- ⑦ 下载队列：并发恒 1 · 暂停接管 · 取消 · 全部暂停/开始 · 清除已完成 ---')
const qNow = async () => await evalJs(`(async () => { try { const r = await window.api.bookMarketListQueue(${JSON.stringify(ROOT)}); return r.ok ? r.tasks : { __err: r.error } } catch (e) { return { __err: String(e) } } })()`)
/** 让队列先干净：清掉已完成的（也验了「清除已完成」） */
await evalJs(`(() => { const q = document.querySelector('[data-wb="bookMarketQueue"]'); if (!q) return 'no-q'; const b = [...q.querySelectorAll('button[title="清除已完成"]')][0]; if (b) { b.click(); return 'ok' } return 'no-btn' })()`)
myOk('清除已完成：队列里不再有 done 任务', await until(async () => ((await qNow()) ?? []).every((t) => t.state !== 'done')))

// 入队两个慢任务（并发恒 1）
const enq = async (title, url) => await evalJs(`(async () => {
  try { return await window.api.bookMarketDownload(${JSON.stringify(ROOT)}, { sourceId: ${JSON.stringify(SRC_A_ID)}, sourceName: ${JSON.stringify(SRC_A)}, title: ${JSON.stringify(title)}, author: '作者丙', downloadUrl: ${JSON.stringify(`${srvA.origin}${url}`)}, coverUrl: '', ext: '.epub', sizeBytes: ${EPUB_SLOW1.length} }) }
  catch (e) { return { ok: false, error: String(e) } }
})()`)
const r1 = await enq('慢书一', '/dl/slow1')
await sleep(300)
const r2 = await enq('慢书二', '/dl/slow2')
await sleep(300)
const r3 = await enq('慢书三', '/dl/slow3')
myOk('三本都入队成功', r1?.ok === true && r2?.ok === true && r3?.ok === true, [r1?.error, r2?.error, r3?.error].filter(Boolean).join('|'))

// 采样并发：任一时刻 down ≤ 1，且至少见到过 queued
let maxDown = 0
let sawQueued = false
for (let i = 0; i < 40; i++) {
  const ts = (await qNow()) ?? []
  const d = ts.filter((t) => t.state === 'down').length
  if (d > maxDown) maxDown = d
  if (ts.some((t) => t.state === 'queued')) sawQueued = true
  await sleep(90)
}
myOk('★ 并发恒 1（任一时刻最多一个 down）', maxDown <= 1, `maxDown=${maxDown}`)
myOk('★ 其余排队等待（见到过 queued）', sawQueued === true)

// 暂停正在下的那个 → 排队项接管
const paused = await evalJs(`(() => {
  const q = document.querySelector('[data-wb="bookMarketQueue"]')
  if (!q) return 'no-queue'
  const b = q.querySelector('button[title="暂停"]')
  if (!b) return 'no-pause-btn'
  b.click(); return 'ok'
})()`)
myOk('队列面板上有「暂停」钮（下载中的那条）', paused === 'ok', paused)
myOk('暂停生效（出现 paused）', await until(async () => ((await qNow()) ?? []).some((t) => t.state === 'paused'), 6000))
myOk('★ 暂停后排队项接管（仍有 down 在跑）', await until(async () => ((await qNow()) ?? []).some((t) => t.state === 'down'), 8000))
// 取消排队里的那一条
const beforeCancel = ((await qNow()) ?? []).length
await evalJs(`(() => {
  const q = document.querySelector('[data-wb="bookMarketQueue"]')
  if (!q) return 'no-queue'
  const b = q.querySelector('button[title="取消下载"]')
  if (!b) return 'no-btn'
  b.click(); return 'ok'
})()`)
myOk('取消一条：队列长度 -1 且它不在了（不是「点了没反应」）',
  await until(async () => ((await qNow()) ?? []).length === beforeCancel - 1, 8000), `${beforeCancel} → ${((await qNow()) ?? []).length}`)
// 全部暂停 / 全部开始
const allPausedBtn = await evalJs(`(() => {
  const q = document.querySelector('[data-wb="bookMarketQueue"]')
  if (!q) return 'no-q'
  const b = q.querySelector('button[title="全部暂停"]')
  if (b) { b.click(); return 'paused-all' }
  const b2 = q.querySelector('button[title="全部开始"]')
  if (b2) { b2.click(); return 'resumed-all' }
  return 'no-btn'
})()`)
myOk('「全部暂停」按下去 → 没有 down / queued 了（按钮文案会翻成「全部开始」）',
  allPausedBtn === 'paused-all' ? await until(async () => ((await qNow()) ?? []).every((t) => t.state === 'paused' || t.state === 'fail' || t.state === 'done'), 8000)
    : allPausedBtn === 'resumed-all' ? await until(async () => ((await qNow()) ?? []).some((t) => t.state === 'down'), 8000) : false,
  allPausedBtn)
const allGo = await evalJs(`(() => {
  const q = document.querySelector('[data-wb="bookMarketQueue"]')
  if (!q) return 'no-q'
  const b = q.querySelector('button[title="全部开始"]') || q.querySelector('button[title="全部暂停"]')
  if (!b) return 'no-btn'
  b.click(); return b.getAttribute('title')
})()`)
note('二级控制钮', String(allGo))
myOk('「全部开始」后队列重新动起来', await until(async () => ((await qNow()) ?? []).some((t) => t.state === 'down' || t.state === 'done'), 8000))
// 等干净 → 清除已完成
await until(async () => ((await qNow()) ?? []).every((t) => t.state === 'done' || t.state === 'fail'), 30000)
const doneN = ((await qNow()) ?? []).filter((t) => t.state === 'done').length
myOk('慢书真的下完了（至少一本 done）', doneN >= 1, `done=${doneN}`)
if (doneN > 0) {
  await evalJs(`(() => { const q = document.querySelector('[data-wb="bookMarketQueue"]'); if (!q) return 'no-q'; const b = q.querySelector('button[title="清除已完成"]'); if (b) { b.click(); return 'ok' } return 'no-btn' })()`)
  myOk('清除已完成：done 全没了', await until(async () => ((await qNow()) ?? []).every((t) => t.state !== 'done'), 8000))
}

// ===== ⑧ 三态连通性（§八 9）=====
console.log('\n--- ⑧ 三态连通性：已连通 / 需要凭据 / 填凭据后已连通 ---')
const SRC_MOD_FILE = join(VAULT, '.knowbase', 'modules', 'bookSources.json')
const SECRET_FILE = join(VAULT, '.knowbase', 'secret', 'bookSources.json')
await evalJs(clickText('书源', `document.querySelector('[data-wb="bookMarket"]')`))
await until(async () => String(await txt('[data-wb="bookMarket"]')).includes(SRC_A))
myOk('源甲显示「已连通」（检索顺手带回的连通性，不必再点测试）',
  await until(async () => (await rowState(SRC_A)) === '已连通', 8000), await rowState(SRC_A))
myOk('源乙一开始显示「需要凭据」（声明了 auth 但没存凭据）',
  (await rowState(SRC_B)) === '需要凭据', await rowState(SRC_B))
myOk('源乙那一行还标着「需要凭据」的认证标签、按钮是「填凭据」',
  await evalJs(`(() => { const row = ${srcRow(SRC_B)}; return !!row && row.textContent.includes('需要凭据') && row.textContent.includes('填凭据') })()`))
const credClicked = await rowBtn(SRC_B, '填凭据')
myOk('点「填凭据」打开凭据弹层', credClicked === 'ok' && await until(() => evalJs(`!!document.querySelector('input[type="password"]')`)), credClicked)
// 填表**限定在弹层作用域内**：书源页也有一个 text 输入框（代理那行），全局 find 会拿错
const filled = await evalJs(`(() => {
  const ov = ${sheetScope('凭据')}
  if (!ov) return 'no-sheet'
  const ins = [...ov.querySelectorAll('input')]
  const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
  const u = ins.find((i) => i.type === 'text')
  const p = ins.find((i) => i.type === 'password')
  if (!u || !p) return 'no-input'
  set(u, ${JSON.stringify(LEAK.USER)})
  set(p, ${JSON.stringify(LEAK.PASS)})
  return 'ok'
})()`)
myOk('凭据弹层里填上用户名与密码', filled === 'ok', filled)
// ★ 保存钮的原话是「保存并测试」（存完立刻探一次 → 三态直接更新，不用用户再点「测试」）。
//   必须按全名点：全局 `/保存/` 会命中书源页代理那行的「保存」（弹层是就地渲染，它在 document 顺序上更靠前）。
myOk('点「保存并测试」', (await sheetBtn('凭据', '保存并测试')) === 'ok')
myOk('★ 填完凭据后源乙变成「已连通」',
  await until(async () => (await rowState(SRC_B)) === '已连通', 15000), await rowState(SRC_B))
myOk('★ 源乙那一行的认证标签翻成「凭据已存」（按钮也变成「改凭据」）',
  await evalJs(`(() => { const row = ${srcRow(SRC_B)}; return !!row && row.textContent.includes('凭据已存') && !row.textContent.includes('填凭据') })()`))
// ── 凭据负向 ──
// ★ 先给一条**正向**：「存进去了」这件事本身必须看得见。否则三条负向全是空转 ——
//   首轮凭据压根没存（点错了按钮），三条负向却照样全绿。
/** 保存后重新从 IPC 读清单（别再拿保存前那份 `listed` 断言：那份本来就不可能含 marker） */
const listedAfter = await evalJs(`(async () => { try { return await window.api.bookMarketListSources(${JSON.stringify(ROOT)}) } catch (e) { return { error: String(e) } } })()`)
const srcBInfo = (listedAfter?.sources ?? []).find((s) => s.name === SRC_B)
myOk('★ 保存后重读清单：源乙 hasCredential 翻真（凭据确实进去了）',
  srcBInfo?.hasCredential === true, JSON.stringify(srcBInfo && { name: srcBInfo.name, hasCredential: srcBInfo.hasCredential }))
myOk('★ 凭据负向：源描述（出 IPC 的 info）里一个 marker 字节都没有',
  (listedAfter?.sources ?? []).length > 0 &&
  !JSON.stringify(listedAfter).includes(LEAK.USER) && !JSON.stringify(listedAfter).includes(LEAK.PASS))
myOk('★ 凭据负向：源描述落盘文件里没有 marker（且文件真在、真记着源乙）', (() => {
  try {
    const all = readFileSync(SRC_MOD_FILE, 'utf8')
    return all.includes(SRC_B) && !all.includes(LEAK.USER) && !all.includes(LEAK.PASS)
  } catch { return false }
})())
myOk('★ 凭据负向：密文文件里没有明文 marker（加密后才落盘）', (() => {
  try {
    const all = readFileSync(SECRET_FILE, 'utf8')
    return all.length > 2 && !all.includes(LEAK.USER) && !all.includes(LEAK.PASS)
  } catch { return false }
})())
myOk('★ 凭据负向：整个 .knowbase 里没有明文 marker（兜底扫一遍）', (() => {
  try {
    const walk = (d, depth = 0) => {
      if (depth > 3) return ''
      let out = ''
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        try { if (statSync(p).isDirectory()) out += walk(p, depth + 1); else if (statSync(p).size < 200000) out += readFileSync(p, 'utf8') } catch { /* 二进制/权限 */ }
      }
      return out
    }
    const all = walk(join(VAULT, '.knowbase'))
    return all.length > 0 && !all.includes(LEAK.USER) && !all.includes(LEAK.PASS)
  } catch { return false }
})())

// ===== 收尾 =====
const errs = await evalJs(`(window.__errs || []).slice(0, 8)`)
myOk('渲染层无未捕获错误 / 未处理 rejection（含 CSP 违规与 React 报错）',
  Array.isArray(errs) && errs.length === 0, JSON.stringify(errs))

// 还原当前仓库（不要把用户的 dev 现状留在探针仓库上）
if (rootId0) {
  const back = await evalJs(`(async () => { try { return await window.api.workspaceOpenById(${JSON.stringify(rootId0)}) } catch (e) { return { error: String(e) } } })()`)
  note('当前仓库已还原', back?.name ?? JSON.stringify(back))
} else {
  note('探针开始时没有当前仓库，故不还原', '')
}

const out = {
  when: new Date().toISOString(),
  electron: process.versions.electron,
  base: BASE,
  vault: VAULT,
  mockA: srvA.origin,
  mockB: srvB.origin,
  checks,
  console: { errors: errs },
}
try {
  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true })
  writeFileSync(join(process.cwd(), 'tmp', 'book-market-s4-module.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log('\n留档：tmp/book-market-s4-module.json')
} catch (e) {
  console.log('留档失败：', String(e))
}
console.log(`临时仓库留档（人工复核用）：${VAULT}`)
await srvA.close()
await srvB.close()
A.finish()
