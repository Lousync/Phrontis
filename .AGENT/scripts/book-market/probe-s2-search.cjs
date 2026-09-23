/**
 * 书市 S2 网络层探针 —— 在真实 electron 主进程里跑**真实的 sourceClient / netSession 实现**。
 *
 * 为什么必须有它：`verify-opds-parse.mjs` 只能验零依赖的解析器；sourceClient 要 electron 的
 * `net.request` + 分区 session + 凭据密文，只有真跑才算数。而 S2 最要紧的三条保证 ——
 *   ① **凭据只进 Authorization 头**（不进 URL / 日志 / 错误文案）
 *   ② **三态**（缺凭据 ⇒ 「需要凭据」且**一个请求都不发**；不是「连接失败」）
 *   ③ **全局并发 ≤2**（两级展开的子请求与各源请求共用额度）
 * —— 全都要看「服务端实际收到了什么 / 同时收到了几个」才判得出来。
 *
 * 跑法（两步；Electron 33 = Node 20，不能 strip-types，所以先把真实实现打包）：
 *   node_modules/.bin/esbuild tmp/s2-probe-entry.ts --bundle --platform=node \
 *     --format=cjs --external:electron --outfile=tmp/s2-net.cjs
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe .AGENT/scripts/book-market/probe-s2-search.cjs --no-sandbox --disable-gpu
 *
 * ★ 声明：**不碰用户的开发数据目录**。userData 在 app ready **之前**改到系统临时目录
 *   （晚了 settings.json 已按真实 userData 算好路径），仓库用临时目录里的假 vault。
 *   临时目录**不删**（便于人工复核），路径打在输出里。
 *
 * ★ 网络：本机 `node:http` mock 覆盖确定性场景（单级 OPDS / JSON 自定义源 / 401 / 500 /
 *   死端口 / 两级展开 / 子 feed 失败 / 重试 / 条目上限），另加**真实 Gutenberg** 一次检索。
 *   真实那一段连不上时**软跳过**（打印醒目提示、不计 fail）—— 本机对 gutenberg.org 实测不稳，
 *   不该让「今天网不好」变成「代码错了」。
 *
 * ★★ **平台事实（一次性实测，结论写在这里免得后人误改回去）**：
 *   chromium 把**同一 origin** 上的并发 `net.request` 串行化 —— 4 个同时发出去，服务端只见到
 *   **1 个在飞**（Electron 33.2.0 / 明文 HTTP / keep-alive 服务端，重复测 3 次全一样）；
 *   **跨 origin** 才是真并发（各 1 个 → 全局 2）。故「并发 ≤2」这条**必须跨 origin 量**：
 *   本探针的 ⑦ 段让每个源各占一个端口，再看**全局**在飞峰值。
 *   → 别把「同 origin 只见到 1」当成池子卡死：那不是我们的代码，是传输层。
 *
 * 产物：stdout 一份 JSON + tmp/book-market-s2-search.json（留档）
 */
const { app, session } = require('electron')
const http = require('node:http')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const BASE = mkdtempSync(join(tmpdir(), 'kb-probe-s2-'))
const USER_DATA = join(BASE, 'userData')
const VAULT = join(BASE, 'vault')
// ★ 必须在 app ready 之前改：晚了 settings.json 已经按真实 userData 算好路径（会写进开发数据目录）
app.setPath('userData', USER_DATA)

const KB = join(VAULT, '.knowbase')
const F_SOURCES = join(KB, 'modules', 'bookSources.json')
const F_SECRET = join(KB, 'secret', 'bookSources.json')

// 凭据标记：**这些串绝不许出现在 stdout / 错误文案 / 请求 URL 里**。
// 故意不含 `_` / `-` 之类会被各种编码搅乱的东西，保证「出现过」判得干净。
const LEAK = { USER: 'LEAKUSER7c41', PASS: 'LEAKPASS7c41', TOKEN: 'LEAKTOKEN7c41' }
const BASIC_EXPECTED = 'Basic ' + Buffer.from(`${LEAK.USER}:${LEAK.PASS}`, 'utf-8').toString('base64')

const results = []
let pass = true
function check(name, ok, extra = '') {
  if (!ok) pass = false
  results.push({ name, ok: !!ok, extra: String(extra) })
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
}

// 全量 stdout 捕获：用于「凭据不进日志」的负向断言（断言点在打印留档 JSON **之前**）
const CAPTURED = []
const origLog = console.log
console.log = (...a) => {
  CAPTURED.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
  origLog(...a)
}

// ===== mock 服务端：记录「收到了什么」与「同时有几个」 =====
/**
 * **全局**在飞计数（所有 mock 服务端共用）—— 并发断言只能看它。
 * ★ 为什么不用单台服务的计数：chromium 把同 origin 的请求串行化了（见文件头注），
 *   单台服务上永远只见到 1，量不出池子的额度。跨 origin 才看得见 2。
 */
const GLOBAL = { all: 0, max: 0 }
const bumpIn = () => {
  GLOBAL.all++
  if (GLOBAL.all > GLOBAL.max) GLOBAL.max = GLOBAL.all
}
const bumpOut = () => { GLOBAL.all-- }

const srv = {
  hits: [],
  inflight: 0,
  maxInflight: 0,
  /** 路径 → 剩余「先失败一次再成功」次数（验重试） */
  failOnce: new Map(),
  delayMs: 0,
}
function resetSrv() {
  srv.hits = []
  srv.inflight = 0
  srv.maxInflight = 0
  srv.failOnce = new Map()
  srv.delayMs = 0
  GLOBAL.all = 0
  GLOBAL.max = 0
}
const hitsOn = (p) => srv.hits.filter((h) => h.path === p)

/** 单级 OPDS：entry 直接带 acquisition，且**直链故意不以扩展名结尾**（只有 MIME 判得出可读） */
const OPDS_SINGLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Mock 单级</title>
  <link rel="self" href="/opds/single" type="application/atom+xml;profile=opds-catalog"/>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">2</opensearch:totalResults>
  <entry>
    <title>单级甲</title><author><name>作者甲</name></author>
    <summary>简介甲</summary>
    <link href="/dl/1" type="application/epub+zip" rel="http://opds-spec.org/acquisition" length="1111"/>
    <link href="/dl/1.mobi" type="application/x-mobipocket-ebook" rel="http://opds-spec.org/acquisition" length="2222"/>
    <link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="/c/1.jpg"/>
  </entry>
  <entry>
    <title>单级乙</title>
    <link href="/dl/2.nope" type="application/pdf" rel="http://opds-spec.org/acquisition" length="3333"/>
  </entry>
</feed>`

/** 两级 OPDS：第一级是三个指针（能展开 / 导航 / 子 feed 挂）+ 一条本级就有 acquisition 的 + 一条光秃秃的 */
const OPDS_TWOLEVEL = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Mock 两级</title>
  <entry>
    <title>指针甲（能展开）</title>
    <link rel="subsection" type="application/atom+xml;profile=opds-catalog" href="/opds/child-ok"/>
  </entry>
  <entry>
    <title>Authors</title>
    <link rel="subsection" type="application/atom+xml;profile=opds-catalog" href="/opds/child-nav"/>
  </entry>
  <entry>
    <title>指针丙（子 feed 挂了）</title>
    <link rel="subsection" type="application/atom+xml;profile=opds-catalog" href="/opds/child-500"/>
  </entry>
  <entry>
    <title>两级丁（本级就有 acquisition）</title>
    <link href="/dl/direct" type="application/epub+zip" rel="http://opds-spec.org/acquisition" length="4444"/>
  </entry>
  <entry><title>光秃秃的条目（无任何 link）</title></entry>
</feed>`

/** 子 feed：两条 entry，第一条才是书（`pickAcquisitionFromChildFeed` 取**第一条带 acquisition 的**） */
const CHILD_OK = `<?xml version="1.0"?><feed><title>子 feed</title>
  <entry><title>子 feed 里的书</title><author><name>作者甲</name></author>
    <link href="/dl/child" type="application/epub+zip" rel="http://opds-spec.org/acquisition" length="5555"/>
  </entry>
  <entry><title>子 feed 里的第二条</title>
    <link href="/dl/child2" type="application/epub+zip" rel="http://opds-spec.org/acquisition" length="6666"/>
  </entry></feed>`

/** 导航型子 feed：entry 全无 acquisition ⇒ 该条必须被丢掉（不能把作者名当书名） */
const CHILD_NAV = `<?xml version="1.0"?><feed><title>作者列表</title>
  <entry><title>某位作者</title></entry><entry><title>另一位作者</title></entry></feed>`

/** 70 条 entry：验 MAX_ITEMS_PER_SOURCE 截断 */
function manyEntries(n) {
  let s = '<?xml version="1.0"?><feed><title>很多</title>'
  for (let i = 0; i < n; i++) {
    s += `<entry><title>第 ${i} 本</title><link href="/dl/${i}" type="application/epub+zip" rel="http://opds-spec.org/acquisition" length="${100 + i}"/></entry>`
  }
  return s + '</feed>'
}

const JSON_BODY = JSON.stringify({
  data: { books: [
    { title: 'JSON 甲', author: '作者甲', cover: '/c/j1.jpg', desc: '简介甲', files: [{ format: 'epub', url: '/dl/j1' }] },
    { title: 'JSON 乙', files: [{ format: 'mobi', url: '/dl/j2.mobi' }] },
    { author: '没有书名' },
  ] },
})

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const path = url.pathname
      const auth = req.headers.authorization || ''
      srv.hits.push({
        path,
        url: req.url,
        auth,
        ua: req.headers['user-agent'] || '',
        query: url.searchParams.get('query') || '',
      })
      srv.inflight++
      if (srv.inflight > srv.maxInflight) srv.maxInflight = srv.inflight
      bumpIn()
      const finish = (status, type, body) => {
        res.writeHead(status, { 'Content-Type': type })
        res.end(body)
        srv.inflight--
        bumpOut()
      }
      const reply = () => {
        // 「先失败一次再成功」：验重试。★ 只对 5xx 生效（4xx 不该被重试）
        const left = srv.failOnce.get(path) || 0
        if (left > 0) {
          srv.failOnce.set(path, left - 1)
          return finish(503, 'text/plain', 'flaky')
        }
        switch (path) {
          case '/opds/single': return finish(200, 'application/atom+xml', OPDS_SINGLE)
          case '/opds/twolevel': return finish(200, 'application/atom+xml', OPDS_TWOLEVEL)
          case '/opds/child-ok': return finish(200, 'application/atom+xml', CHILD_OK)
          case '/opds/child-nav': return finish(200, 'application/atom+xml', CHILD_NAV)
          case '/opds/child-500': return finish(500, 'text/plain', 'boom')
          case '/opds/many': return finish(200, 'application/atom+xml', manyEntries(70))
          case '/opds/garbage': return finish(200, 'application/atom+xml', '这不是 XML 也不是 Atom 更不是 JSON {{{')
          case '/opds/html': return finish(200, 'text/html', '<html><body>假装是 feed 的错误页</body></html>')
          case '/opds/500': return finish(500, 'text/plain', 'server error')
          case '/opds/404': return finish(404, 'text/plain', 'nope')
          case '/auth/opds':
            // 只有带上正确凭据才放行 —— 拿它验「凭据确实注入了」
            return auth === BASIC_EXPECTED
              ? finish(200, 'application/atom+xml', OPDS_SINGLE)
              : finish(401, 'text/plain', 'unauthorized')
          case '/json/search': return finish(200, 'application/json', JSON_BODY)
          default: return finish(404, 'text/plain', 'not found')
        }
      }
      // 只在测并发时统一开延迟（其余场景瞬回，免得整轮跑慢）
      if (srv.delayMs > 0) setTimeout(reply, srv.delayMs)
      else reply()
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/**
 * 只服务「并发测量」的极简 mock：**自己的端口**（= 自己的 origin），每条请求延迟 `delayMs`，
 * 返回一份可解析的单级 feed。多个实例 → 多 origin → 才量得出池子的额度（见文件头注）。
 */
function startDelayMock(delayMs) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      bumpIn()
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/atom+xml' })
        res.end(OPDS_SINGLE)
        bumpOut()
      }, delayMs)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** 起一个监听又立刻关掉的端口 → 后续连接必被拒（确定性「连不上」） */
function deadPort() {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

app.whenReady().then(async () => {
  mkdirSync(KB, { recursive: true })
  writeFileSync(join(KB, 'meta.json'), JSON.stringify({ schemaVersion: 1, name: 'probe' }), 'utf-8')
  const net2 = require(join(process.cwd(), 'tmp', 's2-net.cjs'))
  const ROOT = 'probe-vault'
  net2.setCurrentVault({ rootId: ROOT, name: 'probe-vault', rootPath: VAULT })

  const mock = await startMock()
  const MOCK = `http://127.0.0.1:${mock.address().port}`
  const GONE = `http://127.0.0.1:${await deadPort()}`
  const out = { when: new Date().toISOString(), electron: process.versions.electron, base: BASE, vault: VAULT, mock: MOCK, checks: results }

  /** 建源并返回 id（mock 地址都合法；upsert 只校验 url，searchUrl 由 resolveSearchUrl 兜底） */
  const mk = (patch) => {
    const r = net2.bookSourceUpsert(ROOT, { kind: 'opds', auth: null, enabled: true, ...patch })
    if (!r.ok) throw new Error(`建源失败 ${patch.name}: ${r.error}`)
    return r.source.id
  }
  const search = (ids, q = 'q') => net2.searchBookSources(ROOT, q, { sourceIds: ids })

  console.log('--- ⓪ 首启种入 / 会话隔离 ---')
  // 第一次读清单就会把预置源种进盘（拍板 ⑥「删了下次还会回来」靠的就是这条路）
  const seeded = net2.bookSourceList(ROOT)
  check('首启种入两个预置源（拍板 ⑦）', seeded.filter((s) => s.builtin).length === 2, seeded.map((s) => s.id).join(','))
  check('预置源已落盘', existsSync(F_SOURCES) && JSON.parse(readFileSync(F_SOURCES, 'utf-8')).sources.length === 2)
  check('★ 书市 session 不是 defaultSession（代理不会殃及 LLM 对话 / 更新 / 剪藏）',
    net2.getBookMarketSession() !== session.defaultSession)
  check('★ 预置源的名字与检索模板都在盘上（不是只种了 id）',
    seeded.some((s) => s.id === 'builtin-gutenberg' && s.searchUrl.includes('{query}')))

  // ===== ① 单级 OPDS：MIME 判可读 / 封面 / 简介 / 编码 / UA =====
  console.log('\n--- ① 单级 OPDS 源 ---')
  resetSrv()
  const single = mk({ name: '单级源', url: `${MOCK}/opds/single`, searchUrl: `${MOCK}/opds/single?query={query}` })
  const r1 = await search([single], '图灵 测试')
  check('连得上（三态 ok）', r1.connectivity[single] === 'ok', r1.connectivity[single])
  check('零失败源', r1.failed.length === 0)
  check('两条条目', r1.items.length === 2, `got ${r1.items.length}`)
  const a1 = r1.items.find((i) => i.title === '单级甲')
  check('★ 直链不以 .epub 结尾也判得出可读（走 link 的 MIME）', a1.ext === '.epub' && a1.readable === true, `${a1.ext}/${a1.readable}`)
  check('★ 体积取被选中那条候选（跳过 mobi 那条）', a1.sizeBytes === 1111, String(a1.sizeBytes))
  check('下载链接是 MIME 可读的那条', a1.downloadUrl === `${MOCK}/dl/1`)
  check('封面相对地址解析成绝对', a1.coverUrl === `${MOCK}/c/1.jpg`, a1.coverUrl)
  check('作者 / 简介取到', a1.author === '作者甲' && a1.summary === '简介甲')
  check('源名带进条目（书卡显示「来自哪儿」）', a1.sourceName === '单级源')
  check('★ 检索词发出去前 encodeURIComponent（中文不编码必炸）', hitsOn('/opds/single')[0].query === '图灵 测试', hitsOn('/opds/single')[0].query)
  check('★ 请求带可识别 UA（方案 §三「礼貌抓取」）',
    /^Knowbase-BookMarket\//.test(hitsOn('/opds/single')[0].ua), hitsOn('/opds/single')[0].ua)
  const b1 = r1.items.find((i) => i.title === '单级乙')
  check('第二条靠 MIME 判成 pdf（直链末尾是 .nope）', b1.ext === '.pdf' && b1.readable === true, b1.ext)

  // ===== ② 凭据：只进 Authorization 头 + 三态「缺凭据」 =====
  console.log('\n--- ② 凭据注入（只进 Authorization 头）---')
  resetSrv()
  // ②a 声明了 auth 但**没存**凭据 ⇒ 必须是「需要凭据」，且**一个请求都不发**
  // ★ 这里必须给 `ref`：`coerceAuth` 要求 ref 非空（无 ref 的 auth 会被整条丢掉 ⇒ 源变成免认证，
  //   表象是「白白发了一个必然 401 的请求」）。真实写入路径（改源 / 存凭据）里 ref 恒 = 源 id
  //   （`bookSourceUpsert` 会改写），故这里给个占位串即可。
  const needCred = mk({ name: '要凭据的源', url: `${MOCK}/auth/opds`, searchUrl: `${MOCK}/auth/opds?query={query}`, auth: { type: 'basic', ref: 'placeholder' } })
  check('★ 建源后 auth 真的落住了（ref 由 upsert 改写成源 id）',
    net2.bookSourceGet(ROOT, needCred)?.auth?.type === 'basic' && net2.bookSourceGet(ROOT, needCred)?.auth?.ref === needCred)
  const r2a = await search([needCred])
  check('★ 缺凭据 → 三态 need-credential（不是连接失败）', r2a.connectivity[needCred] === 'need-credential', r2a.connectivity[needCred])
  check('★ 缺凭据时**一个请求都没发**（不发必然 401 的请求出去）', hitsOn('/auth/opds').length === 0, `hits=${hitsOn('/auth/opds').length}`)
  check('失败原因文案是「需要凭据」', r2a.failed[0]?.reason === '需要凭据', r2a.failed[0]?.reason)
  check('该源不产出条目', r2a.items.length === 0)

  // ②b 存上凭据 ⇒ 请求必须带上正确的 Authorization 头，服务端因此放行
  // ★ 先清计数：这段要断言「恰好 1 次请求」，②a 那次（若有）不能混进来
  resetSrv()
  const savedCred = net2.bookSourceSaveCredential(ROOT, needCred, { type: 'basic', username: LEAK.USER, password: LEAK.PASS })
  check('存凭据成功（密文文件已生成）', savedCred.ok && existsSync(F_SECRET), savedCred.error || '')
  const r2b = await search([needCred])
  check('★ 带上凭据后连通（三态 ok）', r2b.connectivity[needCred] === 'ok', r2b.connectivity[needCred])
  check('产出两条条目', r2b.items.length === 2)
  const h2 = hitsOn('/auth/opds')
  check('★ 凭据确实注入到了 Authorization 头（服务端按它放行）', h2.length === 1 && h2[0].auth === BASIC_EXPECTED,
    h2[0]?.auth ? `Basic <${h2[0].auth.length} 字节>` : '(无)')
  check('★ 凭据**不在** URL 里（查询串 / 路径都不许带）',
    h2.every((h) => !h.url.includes('LEAK') && !h.url.includes(LEAK.USER)))

  // ②c bearer 走同一个头
  resetSrv()
  const bearerSrc = mk({ name: 'bearer 源', url: `${MOCK}/auth/opds`, searchUrl: `${MOCK}/auth/opds?query={query}`, auth: { type: 'bearer' } })
  net2.bookSourceSaveCredential(ROOT, bearerSrc, { type: 'bearer', token: LEAK.TOKEN })
  const r2c = await search([bearerSrc])
  check('bearer 也注入 Authorization（bearer 类型对 basic 服务端不认）',
    hitsOn('/auth/opds').length === 1 && hitsOn('/auth/opds')[0].auth === `Bearer ${LEAK.TOKEN}`)
  check('服务端 401 ⇒ 三态 need-credential', r2c.connectivity[bearerSrc] === 'need-credential', r2c.connectivity[bearerSrc])
  check('★ 401 **不重试**（重试一万次还是 401，只让用户多等）', hitsOn('/auth/opds').length === 1, `hits=${hitsOn('/auth/opds').length}`)

  // ===== ③ 三态其余两态 + 重试 =====
  console.log('\n--- ③ 三态 / 重试 / 4xx 不重试 ---')
  resetSrv()
  const gone = mk({ name: '连不上的源', url: `${GONE}/opds`, searchUrl: `${GONE}/opds?query={query}` })
  const r3a = await search([gone])
  check('★ 连不上 → 三态 fail', r3a.connectivity[gone] === 'fail', r3a.connectivity[gone])
  check('原因文案是「连接失败」', r3a.failed[0]?.reason === '连接失败', r3a.failed[0]?.reason)

  resetSrv()
  const noUrl = mk({ name: '地址不合法', url: `${MOCK}/`, searchUrl: 'javascript:alert(1)?q={query}' })
  const r3b = await search([noUrl])
  check('★ 模板展开后不是 http(s) → 「未配置检索地址」（不是「连接失败」）', r3b.failed[0]?.reason === '未配置检索地址', r3b.failed[0]?.reason)
  check('★ 这种源一个请求都不发', srv.hits.length === 0, `hits=${srv.hits.length}`)

  resetSrv()
  const s500 = mk({ name: '500 源', url: `${MOCK}/opds/500`, searchUrl: `${MOCK}/opds/500?query={query}` })
  const r3c = await search([s500])
  check('500 → 三态 fail + 文案带状态码', r3c.connectivity[s500] === 'fail' && r3c.failed[0]?.reason === 'HTTP 500', r3c.failed[0]?.reason)
  check('★ 5xx 重试一次（共 2 次请求）', hitsOn('/opds/500').length === 2, `hits=${hitsOn('/opds/500').length}`)

  resetSrv()
  const s404 = mk({ name: '404 源', url: `${MOCK}/opds/404`, searchUrl: `${MOCK}/opds/404?query={query}` })
  const r3d = await search([s404])
  check('404 → fail + 文案带状态码', r3d.failed[0]?.reason === 'HTTP 404', r3d.failed[0]?.reason)
  check('★ 4xx **不重试**（「你问错了」重试没意义）', hitsOn('/opds/404').length === 1, `hits=${hitsOn('/opds/404').length}`)

  resetSrv()
  const flaky = mk({ name: '抖一下的源', url: `${MOCK}/opds/single`, searchUrl: `${MOCK}/opds/single?query={query}` })
  srv.failOnce.set('/opds/single', 1)
  const r3e = await search([flaky])
  check('★ 先 503 后成功 ⇒ 重试救回来（三态 ok）', r3e.connectivity[flaky] === 'ok' && r3e.items.length === 2,
    `${r3e.connectivity[flaky]}/${r3e.items.length}`)
  check('确实打了两次', hitsOn('/opds/single').length === 2, `hits=${hitsOn('/opds/single').length}`)

  resetSrv()
  const garbage = mk({ name: '垃圾响应源', url: `${MOCK}/opds/garbage`, searchUrl: `${MOCK}/opds/garbage?query={query}` })
  const htmlSrc = mk({ name: 'HTML 错误页源', url: `${MOCK}/opds/html`, searchUrl: `${MOCK}/opds/html?query={query}` })
  const r3f = await search([garbage, htmlSrc])
  check('解析不出 feed → fail + 「响应无法解析」', r3f.failed.length === 2 && r3f.failed.every((f) => f.reason === '响应无法解析'),
    r3f.failed.map((f) => f.reason).join(','))
  check('★ HTML 错误页不当成 Atom 硬解（不按内容猜解析器）→ 零条目', r3f.items.length === 0)

  // ===== ④ 部分源失败不整页报错（拍板 ⑦）=====
  console.log('\n--- ④ 部分源失败隔离 / 停用源不参与 ---')
  resetSrv()
  // 先清掉 ②b 存的凭据，让 needCred 回到「缺凭据」—— 顺便验清凭据这条路
  const cleared = net2.bookSourceClearCredential(ROOT, needCred)
  check('清凭据成功（源保留、只掉凭据）', cleared.ok && net2.bookSourceCredentialFor(ROOT, needCred) === null)
  check('清掉后 info 的 hasCredential 变 false', net2.bookSourceInfos(ROOT).find((s) => s.id === needCred)?.hasCredential === false)
  const mix = await search([single, gone, needCred, s500])
  check('好源照常出条目', mix.items.length === 2, `got ${mix.items.length}`)
  check('★ 坏源只进 failed[]，不吞掉好源（拍板 ⑦）', mix.failed.length === 3, `failed=${mix.failed.length}: ${mix.failed.map((f) => f.reason).join(',')}`)
  check('failed 里带源 id + 源名 + 原因', mix.failed.every((f) => f.sourceId && f.name && f.reason))
  check('三态图逐源正确',
    mix.connectivity[single] === 'ok' && mix.connectivity[gone] === 'fail' && mix.connectivity[needCred] === 'need-credential',
    `${mix.connectivity[single]}/${mix.connectivity[gone]}/${mix.connectivity[needCred]}`)

  net2.bookSourceSetEnabled(ROOT, s500, false)
  resetSrv()
  const r4b = await search([s500, single])
  check('★ 停用的源完全不参与（三态图里都没有它）', r4b.connectivity[s500] === undefined)
  check('★ 停用的源连请求都不发', hitsOn('/opds/500').length === 0, `hits=${hitsOn('/opds/500').length}`)
  check('同批的好源照常有结果', r4b.items.length === 2)

  // ===== ⑤ 两级展开（拍板 ⑥）=====
  console.log('\n--- ⑤ 两级展开（Gutenberg 式）---')
  resetSrv()
  const two = mk({ name: '两级源', url: `${MOCK}/opds/twolevel`, searchUrl: `${MOCK}/opds/twolevel?query={query}` })
  const r5 = await search([two])
  const titles = r5.items.map((i) => i.title).sort()
  check('★ 展开一层拿到真书条目（第一条指针展开得 1 条 + 本级直链 1 条）', r5.items.length === 2,
    `got ${r5.items.length} :: ${titles.join('|')}`)
  check('本级就有 acquisition 的那条直接产出', titles.includes('两级丁（本级就有 acquisition）'))
  check('★ 子 feed 里的书拿到，书名来自**子 feed 的 entry**（不是第一级的指针名）',
    titles.includes('子 feed 里的书') && !titles.some((t) => t.includes('指针甲')))
  check('★ 一条指针只出**一本书**（子 feed 的后续 entry 不入库）',
    !titles.some((t) => t.includes('子 feed 里的第二条')))
  check('★ 导航型子 feed 被丢掉（不能把作者名当书名）', !titles.some((t) => t.includes('作者')))
  check('无 link 的秃条目不入库', !titles.some((t) => t.includes('光秃秃')))
  check('★ 子 feed 挂掉只丢那一条，**不进 failed**（那是整源失败的口径）、三态仍 ok',
    r5.failed.length === 0 && r5.connectivity[two] === 'ok', `failed=${r5.failed.length}`)
  check('★ 子 feed 的 500 也重试了一次', hitsOn('/opds/child-500').length === 2, `hits=${hitsOn('/opds/child-500').length}`)
  check('子 feed 的书体积取到（5555）', r5.items.find((i) => i.title === '子 feed 里的书')?.sizeBytes === 5555)
  check('两级展开后每条都可读', r5.items.every((i) => i.readable === true))

  // ===== ⑥ JSON 自定义源 =====
  console.log('\n--- ⑥ JSON 自定义源（mapping + responseType:json）---')
  resetSrv()
  const jsonSrc = mk({
    name: 'JSON 源', kind: 'custom', url: `${MOCK}/json/search`, responseType: 'json',
    searchUrl: `${MOCK}/json/search?query={query}`,
    mapping: { list: 'data.books[*]', title: 'title', author: 'author', cover: 'cover', summary: 'desc', download: 'files[0].url', format: 'files[0].format' },
  })
  const r6 = await search([jsonSrc])
  check('连得上', r6.connectivity[jsonSrc] === 'ok', r6.connectivity[jsonSrc])
  check('★ 只产出有书名的条目（无书名的丢掉）', r6.items.length === 2, `got ${r6.items.length}`)
  const j1 = r6.items[0]
  check('★ mapping.format 决定可读性（直链 /dl/j1 无扩展名）', j1.ext === '.epub' && j1.readable === true, `${j1.ext}/${j1.readable}`)
  check('相对下载直链按源 base 解析成绝对', j1.downloadUrl === `${MOCK}/dl/j1`, j1.downloadUrl)
  check('相对封面解析成绝对', j1.coverUrl === `${MOCK}/c/j1.jpg`)
  check('作者 / 简介按映射取到', j1.author === '作者甲' && j1.summary === '简介甲')
  check('★ format:mobi ⇒ 不可读（书卡标「暂不支持」+ 禁用下载）',
    r6.items[1].readable === false && r6.items[1].ext === '', `${r6.items[1].ext}/${r6.items[1].readable}`)
  check('JSON 源也走同一 session（免认证 ⇒ 无 Authorization 头）', hitsOn('/json/search')[0].auth === '')

  // ===== ⑦ 全局并发 ≤2（含两级展开）=====
  console.log('\n--- ⑦ 全局并发上限 2（拍板 ⑦）---')
  // ★ 每个源占**自己的 origin**（见文件头注：同 origin 会被 chromium 串行化，量不出额度）
  resetSrv()
  srv.delayMs = 120 // 主 mock 也延迟（`two` 源与它的子 feed 都落在它上面）
  const d1 = await startDelayMock(120)
  const d2 = await startDelayMock(120)
  const d3 = await startDelayMock(120)
  const origins = [d1, d2, d3].map((s) => `http://127.0.0.1:${s.address().port}`)
  const c1 = mk({ name: '并发1', url: `${origins[0]}/opds/single`, searchUrl: `${origins[0]}/opds/single?query={query}` })
  const c2 = mk({ name: '并发2', url: `${origins[1]}/opds/single`, searchUrl: `${origins[1]}/opds/single?query={query}` })
  const c3 = mk({ name: '并发3', url: `${origins[1]}/opds/single`, searchUrl: `${origins[1]}/opds/single?query={query}` })
  const c4 = mk({ name: '并发4', url: `${origins[2]}/opds/single`, searchUrl: `${origins[2]}/opds/single?query={query}` })
  const r7 = await search([c1, c2, c3, c4])
  check('四个源全部成功', r7.items.length === 8 && r7.failed.length === 0, `items=${r7.items.length} failed=${r7.failed.length}`)
  check('★ 跨 origin 峰值并发恰为 2（四个源同时排队，池子只放两个出去）', GLOBAL.max === 2, `max=${GLOBAL.max}`)
  check('四个源各自都出了 2 条（排队不丢任务）',
    [c1, c2, c3, c4].every((id) => r7.items.filter((i) => i.sourceId === id).length === 2),
    [c1, c2, c3, c4].map((id) => r7.items.filter((i) => i.sourceId === id).length).join('/'))
  // 同 origin 会被 chromium 串行化 —— 这是**平台事实**，不是我们的代码，故只打印不判红
  resetSrv()
  const sameOrigin = await search([c2, c3])
  console.log(`  INFO  同 origin 两个源实测峰值 = ${GLOBAL.max}（本机 33.2.0 恒 1：chromium 串行化同 origin 请求，故并发只能跨 origin 量）`)
  check('同 origin 两个源照样都出结果（串行化不影响正确性）', sameOrigin.items.length === 4, `got ${sameOrigin.items.length}`)
  resetSrv()
  srv.delayMs = 120
  const r7b = await search([two, c1, c2, c3])
  check('★ 两级展开的子请求与各源**共用**同一额度（仍恰为 2，不超）', GLOBAL.max === 2, `max=${GLOBAL.max}`)
  check('混跑结果仍然正确（两级 2 条 + 三个单级源各 2 条）', r7b.items.length === 8, `got ${r7b.items.length}`)
  srv.delayMs = 0
  for (const s of [d1, d2, d3]) { try { s.close() } catch { /* 无所谓 */ } }

  // ===== ⑧ 条目上限 =====
  console.log('\n--- ⑧ 单源条目上限 ---')
  resetSrv()
  const many = mk({ name: '很多条目的源', url: `${MOCK}/opds/many`, searchUrl: `${MOCK}/opds/many?query={query}` })
  const r8 = await search([many])
  check('★ 70 条被截到 60（别把渲染层淹掉）', r8.items.length === 60, `got ${r8.items.length}`)

  // ===== ⑨ 连通性探测入口 =====
  console.log('\n--- ⑨ probeSourceConnectivity（S4 书源列表三态用）---')
  resetSrv()
  check('mock 源 → ok', (await net2.probeSourceConnectivity(ROOT, single)) === 'ok')
  check('缺凭据源 → need-credential', (await net2.probeSourceConnectivity(ROOT, needCred)) === 'need-credential')
  check('连不上源 → fail', (await net2.probeSourceConnectivity(ROOT, gone)) === 'fail')
  check('不存在的源 → fail', (await net2.probeSourceConnectivity(ROOT, 'nope')) === 'fail')
  check('★ 探测是**真发请求**（否则「地址配了但服务器挂了」会被误报成已连通）', hitsOn('/opds/single').length > 0)
  check('★ 缺凭据的源探测时也不发请求', hitsOn('/auth/opds').length === 0, `hits=${hitsOn('/auth/opds').length}`)

  // ===== ⑩ 真实 Gutenberg（软跳过）=====
  console.log('\n--- ⑩ 真实 Project Gutenberg 检索（连不上则软跳过）---')
  const gutenberg = { reachable: false, items: 0, note: '' }
  try {
    const r10 = await net2.searchBookSources(ROOT, 'turing', { sourceIds: ['builtin-gutenberg'] })
    gutenberg.reachable = r10.connectivity['builtin-gutenberg'] === 'ok'
    gutenberg.items = r10.items.length
    gutenberg.note = r10.failed.map((f) => f.reason).join(',')
    if (gutenberg.reachable) {
      check('★ 真实两级源跑通', r10.items.length > 0, `items=${r10.items.length}`)
      check('★ 展开后每条都有真下载链接', r10.items.every((i) => i.downloadUrl.startsWith('https://')))
      check('★ 展开后拿到真封面（第一级的 data: 内联已被丢弃）',
        r10.items.some((i) => i.coverUrl.startsWith('https://')), `${r10.items.filter((i) => i.coverUrl).length}/${r10.items.length}`)
      check('★ 有可读条目（不可读格式不进 readable）', r10.items.filter((i) => i.readable).length > 0,
        `${r10.items.filter((i) => i.readable).length}/${r10.items.length}`)
      check('★ 导航条目（Authors / Subjects）被丢掉、书名是真书名',
        !r10.items.some((i) => i.title === 'Authors' || i.title === 'Subjects'), r10.items[0]?.title || '(无)')
      check('★ 真源条目带作者（Gutenberg 藏在 content type=text 里）', r10.items.some((i) => i.author !== ''), r10.items[0]?.author || '(空)')
      check('真源每条都带源名', r10.items.every((i) => i.sourceName === 'Project Gutenberg'))
      check('★ 可读条目的扩展名都在六种之内', r10.items.filter((i) => i.readable).every((i) => ['.epub', '.pdf', '.txt', '.fb2', '.fbz', '.cbz'].includes(i.ext)),
        [...new Set(r10.items.map((i) => i.ext))].join('/'))
    } else {
      console.log(`  SKIP  真实 Gutenberg 不可达（${gutenberg.note || '未知原因'}）—— 不计 fail；上面 mock 已覆盖同一代码路径`)
    }
  } catch (e) {
    gutenberg.note = String(e && e.message)
    console.log(`  SKIP  真实 Gutenberg 探测抛错：${gutenberg.note}（不计 fail）`)
  }
  out.gutenberg = gutenberg

  // ===== ⑪ 凭据负向总闸（头号断言）=====
  console.log('\n--- ⑪ 凭据负向：输出 / 错误文案 / 落盘描述 ---')
  const rawSources = existsSync(F_SOURCES) ? readFileSync(F_SOURCES, 'utf-8') : ''
  const rawSecret = existsSync(F_SECRET) ? readFileSync(F_SECRET, 'utf-8') : ''
  check('★ 书源描述落盘字节里无凭据明文', !rawSources.includes('LEAK'), rawSources.length ? '已读' : '文件不存在')
  check('★ 书源描述里连凭据字段名都没有', !/"(username|password|token)"\s*:/.test(rawSources))
  check('凭据密文文件已生成', rawSecret.length > 0)
  check('★ 密文文件是密文（enc1: 前缀）', rawSecret.startsWith('enc1:'), rawSecret.slice(0, 5))
  check('★ 服务端收到的 URL 里没有凭据', srv.hits.every((h) => !h.url.includes('LEAK')))
  check('★ 出 IPC 的源描述不含凭据本体', !JSON.stringify(net2.bookSourceInfos(ROOT)).includes('LEAK'))
  check('★ 全量 stdout 里没有凭据明文（含所有错误文案 / failed.reason / 断言附注）', !CAPTURED.join('\n').includes('LEAK'))

  out.summary = { total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length }
  out.overall = pass ? 'PASS（S2 网络层契约全部成立）' : '需人工判读 —— 见 checks'
  origLog('\n========================================')
  origLog(pass ? `✅ S2 网络层契约全部通过：${out.summary.pass}/${out.summary.total}` : `❌ ${out.summary.fail} 项 FAIL（另有 ${out.summary.pass} 项 PASS）`)
  origLog(`临时目录（留档，可人工复核）：${BASE}`)
  origLog(JSON.stringify(out, null, 2))
  try {
    writeFileSync(join(process.cwd(), 'tmp', 'book-market-s2-search.json'), JSON.stringify(out, null, 2))
  } catch { /* 落盘不影响 stdout */ }
  try { mock.close() } catch { /* 无所谓 */ }
  app.exit(pass ? 0 : 1)
})
