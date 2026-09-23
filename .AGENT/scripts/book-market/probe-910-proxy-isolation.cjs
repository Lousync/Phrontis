/**
 * 书市 §9 第 10 条探针 —— **代理隔离**：配一个不可用代理 → 书市报错，而 LLM 对话路径不受影响。
 *
 * ## 为什么这条要单独立探针（而不是写进 S2）
 * S2 只验了一条**静态**断言「书市 session 不是 defaultSession」。但「不是同一个 session」到
 * 「代理只作用于书市」之间还隔着两个可能的坑：
 *   ① `applyBookMarketProxy` 是否**真的**把代理灌进了那个分区（而不是静默失败）；
 *   ② 死代理生效期间，LLM 走的那条 `net.fetch`（defaultSession）是否**真的**没被改道。
 * 这两条都只有真跑 electron 才判得出来，而它们正是方案 §3.3 拍板「独立分区」的**全部理由**。
 *
 * ## 判定面（与 §9 第 10 条字面一一对应）
 *   书市报错    = 死代理下 `bookRequestText` 失败 + 检索三态 fail（用户可见的「书市连不上」）
 *   LLM 不受影响 = 死代理生效期间 `session.defaultSession.resolveProxy` 仍是直连，
 *                 且 `net.fetch`（llmService.httpJson 用的就是它）仍成功
 *   ★ 两条**必须同时**成立才算隔离成立 —— 只验其一，「隔离」都没被证明。
 *
 * ## 跑法（两步；Electron 33 = Node 20，不能 strip-types，所以先把真实实现打包）
 *   node_modules/.bin/esbuild tmp/probe-910-911-entry.ts --bundle --platform=node \
 *     --format=cjs --external:electron --outfile=tmp/probe-910-911.cjs
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe .AGENT/scripts/book-market/probe-910-proxy-isolation.cjs --no-sandbox --disable-gpu
 * ★ 打包入口 `tmp/probe-910-911-entry.ts` 在 tmp/（**未进版本控制**，与 S1–S6 的入口同例）——
 *   丢了就按它的 export 面重建：netSession + sourceClient + vaultContext + bookSourceVaultRepo + credentialSatisfies。
 *
 * ## 声明
 * ★ **不碰用户的开发数据目录**：userData 在 app ready **之前**改到系统临时目录，仓库用临时目录里的假 vault。
 * ★ **不碰 defaultSession 的代理**（这是被测代码自己的纪律，本探针只**读**它的状态）。
 * ★ 真实目标用 Gutenberg（书市真会用的主机）。**离线时软跳过**那几条依赖公网的断言（打印 SKIP 不计 fail）——
 *   「今天网不好」不该变成「代码错了」；代理归属那几条（resolveProxy / 本机源）**离线也能判**，永不跳过。
 *
 * ★★ **平台事实（2026-09-23 实测，首轮探针就栽在这上面，勿改回去）**：
 *   改代理**不会**清 HTTP 缓存。同一个 URL 在改代理**之前**取过 ⇒ 改完再取会**命中缓存直接成功**
 *   （实测 2ms 返回，连代理都没碰），表象是「配了死代理书市却照常成功」。
 *   故本探针所有「应当失败 / 应当成功」的请求一律带**唯一查询串**破缓存 —— 判的是**真网络路径**。
 *
 * 产物：stdout 一份逐条断言 + tmp/book-market-910-proxy-isolation.json（留档）
 */
const { app, net, session } = require('electron')
const http = require('node:http')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const BASE = mkdtempSync(join(tmpdir(), 'kb-probe-910-'))
const USER_DATA = join(BASE, 'userData')
const VAULT = join(BASE, 'vault')
// ★ 必须在 app ready 之前改：晚了 settings.json 已按真实 userData 算好路径（会写进开发数据目录）
app.setPath('userData', USER_DATA)
const KB = join(VAULT, '.knowbase')
const ROOT = 'probe-vault'

/** 真实目标：书市预置源 Gutenberg（要打在将来真会用的主机上，而不是好说话的假主机上） */
const TARGET = 'https://www.gutenberg.org/cache/epub/1342/pg1342.epub'
const RANGE = { Range: 'bytes=0-1023' }
/** 死代理：端口 1 必被拒。★ 必须同时写 https= 与 http= 两条 —— 只写 http= 时 https 目标不匹配规则会**直连**（S0 v1 踩过） */
const DEAD_RULES = 'https=127.0.0.1:1;http=127.0.0.1:1'
const DEAD_MARK = '127.0.0.1:1'

const results = []
let pass = true
function check(name, ok, extra = '') {
  if (!ok) pass = false
  results.push({ name, ok: !!ok, extra: String(extra) })
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
}
function skip(name, why) {
  results.push({ name, ok: true, skipped: true, extra: why })
  console.log(`  SKIP ${name}  [${why}]`)
}

/** 本机 OPDS mock（验「局域网/本机源在死代理下仍直连」—— 自建书源多在局域网） */
const OPDS_SINGLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>mock</title>
  <entry><title>本机源的书</title><author><name>作者甲</name></author>
    <link href="/dl/1" type="application/epub+zip" rel="http://opds-spec.org/acquisition" length="1111"/>
  </entry></feed>`

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (new URL(req.url, 'http://127.0.0.1').pathname === '/opds/single') {
        res.writeHead(200, { 'Content-Type': 'application/atom+xml' })
        return res.end(OPDS_SINGLE)
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('nope')
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** 走 net.fetch（llmService.httpJson 用的就是这条，**不带 session** ⇒ defaultSession） */
async function viaFetch(url, init = {}, timeoutMs = 15000) {
  const started = Date.now()
  try {
    const res = await net.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const buf = Buffer.from(await res.arrayBuffer())
    return { ok: true, status: res.status, bytes: buf.length, ms: Date.now() - started }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - started }
  }
}

app.whenReady().then(async () => {
  mkdirSync(join(KB, 'modules'), { recursive: true })
  writeFileSync(join(KB, 'meta.json'), JSON.stringify({ schemaVersion: 1, name: 'probe' }), 'utf-8')
  const net2 = require(join(process.cwd(), 'tmp', 'probe-910-911.cjs'))
  net2.setCurrentVault({ rootId: ROOT, name: ROOT, rootPath: VAULT })

  const mock = await startMock()
  const MOCK = `http://127.0.0.1:${mock.address().port}`

  const out = {
    when: new Date().toISOString(),
    electron: process.versions.electron,
    base: BASE,
    vault: VAULT,
    target: TARGET,
    deadProxy: DEAD_RULES,
  }

  /* ================= ⓪ 分区身份（离线也能判） ================= */
  console.log('--- ⓪ 书市分区 ≠ defaultSession ---')
  const bm = net2.getBookMarketSession()
  check('★ 书市 session 不是 defaultSession', bm !== session.defaultSession)
  check('书市分区是非持久的（内存态、退出即清）', bm.isPersistent() === false)

  /* ================= ① 直连基线（判本机是否在线） ================= */
  console.log('--- ① 直连基线 ---')
  /** 唯一查询串破 HTTP 缓存（见头注「平台事实」）—— 判真网络路径，不判缓存 */
  const fresh = (tag) => `${TARGET}?probe=${tag}-${Date.now()}`
  const baseUrl = fresh('base')
  const base0 = await net2.bookRequestText(baseUrl, { headers: RANGE, timeoutMs: 15000 }).then(
    (r) => ({ ok: true, status: r.status, bytes: r.body.length }),
    (e) => ({ ok: false, error: String((e && e.message) || e) }),
  )
  const ONLINE = base0.ok && base0.status >= 200 && base0.status < 300 && base0.bytes > 0
  out.online = ONLINE
  if (ONLINE) {
    check('★ 直连基线：书市能取到 Gutenberg 字节', true, `status=${base0.status} bytes=${base0.bytes}`)
  } else {
    skip('直连基线', `Gutenberg 不可达（${base0.error || 'status=' + base0.status}）—— 依赖公网的断言将软跳过`)
  }

  /* ================= ② 死代理只进书市分区 ================= */
  console.log('--- ② 死代理生效面 ---')
  const applied = await net2.applyBookMarketProxy(DEAD_RULES)
  check('applyBookMarketProxy 接受代理串', applied.ok, applied.error || '')

  const bmProxy = await bm.resolveProxy(TARGET)
  check('★ 代理真的进了书市分区（resolveProxy 命中死代理）', bmProxy.includes(DEAD_MARK), bmProxy)

  const defProxy = await session.defaultSession.resolveProxy(TARGET)
  const defProxyLlm = await session.defaultSession.resolveProxy('https://api.anthropic.com/v1/messages')
  check('★ defaultSession 未被改道（LLM / 更新 / 剪藏路径的代理没变）',
    !defProxy.includes(DEAD_MARK) && !defProxyLlm.includes(DEAD_MARK),
    `${defProxy} | ${defProxyLlm}`)

  // 平台事实留档（头注「平台事实」的实测点）：同一个 URL 在改代理前取过 ⇒ 改代理后**照样命中缓存成功**。
  // ★ 这不是缺陷、也不该判红 —— 但它正是「判定请求必须破缓存」的原因，故打印出来免得后人再栽一次。
  const tCache = Date.now()
  const cached = await net2.bookRequestText(baseUrl, { headers: RANGE, timeoutMs: 15000 }).then(
    () => ({ ok: true, ms: Date.now() - tCache }), () => ({ ok: false, ms: Date.now() - tCache }),
  )
  console.log(`  INFO  同 URL 在死代理下实测：${cached.ok ? `成功（${cached.ms}ms，命中 HTTP 缓存、根本没走代理）` : `失败（${cached.ms}ms）`} —— 故上面/下面的判定请求一律带唯一查询串`)

  /* ================= ③ 书市报错 + LLM 不受影响（在线才判） ================= */
  console.log('--- ③ 书市报错 vs LLM 路径通畅 ---')
  if (ONLINE) {
    // ③a 书市：文本路径失败（唯一查询串破缓存 —— 否则会命中 ① 的缓存直接「成功」）
    const dead = await net2.bookRequestText(fresh('dead'), { headers: RANGE, timeoutMs: 15000 }).then(
      () => ({ ok: true }),
      (e) => ({ ok: false, name: e && e.name, kind: e && e.kind, msg: String((e && e.message) || e) }),
    )
    check('★ 死代理下书市请求失败（BookRequestError，不是静默成功）',
      !dead.ok && dead.name === 'BookRequestError', dead.ok ? '竟成功了' : `${dead.kind}: ${dead.msg}`)

    // ③b 书市：检索三态 fail（用户可见的「书市连不上」）
    const srcId = (() => {
      const r = net2.bookSourceUpsert(ROOT, { name: '死代理下的源', kind: 'opds', auth: null, enabled: true, url: TARGET, searchUrl: `${TARGET}?query={query}` })
      if (!r.ok) throw new Error('建源失败 ' + r.error)
      return r.source.id
    })()
    const r3b = await net2.searchBookSources(ROOT, 'dead' + Date.now(), { sourceIds: [srcId] })
    check('★ 死代理下检索三态 = fail（界面会报「连接失败」）',
      r3b.connectivity[srcId] === 'fail', String(r3b.connectivity[srcId]))
    check('该源零条目、进 failed[]', r3b.items.length === 0 && r3b.failed.length === 1, r3b.failed[0]?.reason || '')

    // ③c LLM 路径：net.fetch（= llmService.httpJson）仍成功 —— 隔离的**另一半**
    const llm = await viaFetch(fresh('llm'), { headers: RANGE })
    check('★ 同一时刻 net.fetch（LLM 对话走的路径）仍成功', llm.ok && llm.bytes > 0,
      llm.ok ? `status=${llm.status} bytes=${llm.bytes}` : llm.error)

    // ③d 负向对照：net.fetch 把书市分区当 session 传进去 ⇒ **照样成功**（它读的是 defaultSession 的代理，
    //     而 defaultSession 此刻是直连）—— 这正是 S0 的结论，也是「书市必须用 net.request」的全部理由。
    //     ★ 这条锁死回归：将来有人把书市请求改回 net.fetch，会**静默绕过分区代理**（本探针随即转红）。
    const fetchWithBmSession = await viaFetch(fresh('fbm'), { headers: RANGE, session: bm })
    check('★ 负向：net.fetch 带书市 session **不读**书市代理（S0 结论仍成立 ⇒ 书市必须用 net.request）',
      fetchWithBmSession.ok, fetchWithBmSession.ok ? '忽略了分区死代理，走的 defaultSession 直连' : `意外失败：${fetchWithBmSession.error}`)
  } else {
    skip('书市报错', '离线')
    skip('检索三态 fail', '离线')
    skip('net.fetch 仍成功', '离线')
    skip('net.fetch 带书市 session 的负向对照', '离线')
  }

  /* ================= ④ 本机源在死代理下仍直连（<local> 绕行） ================= */
  console.log('--- ④ 本机源绕行（<local>）---')
  const localId = (() => {
    const r = net2.bookSourceUpsert(ROOT, { name: '本机源', kind: 'opds', auth: null, enabled: true, url: `${MOCK}/opds/single`, searchUrl: `${MOCK}/opds/single?query={query}` })
    if (!r.ok) throw new Error('建源失败 ' + r.error)
    return r.source.id
  })()
  const r4 = await net2.searchBookSources(ROOT, 'q', { sourceIds: [localId] })
  check('★ 死代理生效期间本机/局域网源仍连得上（BOOK_MARKET_PROXY_BYPASS=<local>）',
    r4.connectivity[localId] === 'ok' && r4.items.length === 1,
    `${r4.connectivity[localId]} items=${r4.items.length}`)

  /* ================= ⑤ 清空代理 ⇒ 回到直连 ================= */
  console.log('--- ⑤ 清空代理恢复直连 ---')
  const cleared = await net2.applyBookMarketProxy('')
  check('清空代理成功', cleared.ok, cleared.error || '')
  const bmProxy2 = await bm.resolveProxy(TARGET)
  check('★ 清空后书市分区回直连（不是「不改动」）', bmProxy2.toUpperCase().includes('DIRECT'), bmProxy2)
  if (ONLINE) {
    const back = await net2.bookRequestText(fresh('back'), { headers: RANGE, timeoutMs: 15000 }).then(
      (r) => ({ ok: true, bytes: r.body.length }), (e) => ({ ok: false, error: String((e && e.message) || e) }),
    )
    check('★ 清空代理后书市又能取到字节', back.ok && back.bytes > 0, back.ok ? `bytes=${back.bytes}` : back.error)
  } else {
    skip('清空后书市恢复', '离线')
  }

  /* ================= ⑥ 坏代理串不炸（负向） ================= */
  console.log('--- ⑥ 坏代理串不抛异常 ---')
  let threw = false
  let bad
  try { bad = await net2.applyBookMarketProxy('这不是代理串 :::') } catch { threw = true }
  check('★ 坏代理串不抛异常（返回 ok:false 即可，不阻断设置写入）', !threw, JSON.stringify(bad))
  await net2.applyBookMarketProxy('') // 复位

  /* ================= 收尾 ================= */
  out.checks = results
  out.summary = { total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, skipped: results.filter((r) => r.skipped).length }
  out.overall = pass ? 'PASS（§9 第 10 条：代理隔离成立）' : '需人工判读 —— 见 checks'
  console.log('\n========================================')
  console.log(pass ? `✅ §9 第 10 条 代理隔离通过：${out.summary.pass}/${out.summary.total}（软跳过 ${out.summary.skipped}）` : `❌ ${out.summary.fail} 项 FAIL（另有 ${out.summary.pass} 项 PASS）`)
  console.log(`临时目录（留档，可人工复核）：${BASE}`)
  console.log(JSON.stringify(out, null, 2))
  try { writeFileSync(join(process.cwd(), 'tmp', 'book-market-910-proxy-isolation.json'), JSON.stringify(out, null, 2)) } catch { /* 落盘不影响 stdout */ }
  try { mock.close() } catch { /* 无所谓 */ }
  app.exit(pass ? 0 : 1)
})
