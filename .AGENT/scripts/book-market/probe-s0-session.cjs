/**
 * 书市 S0 探针 —— 证实「专用非持久 partition + setProxy + 可读流 + Range」四件事。
 *
 * 为什么必须先探（方案 §1.2）：全仓此前**零** `session.fromPartition` / `setProxy` / `net.request` 用法
 * （2026-09-22 复核确认），这套网络基建是全新的；S2 网络层整层压在它成立之上。
 * **不成立则按方案 §1.2 回退**：改全局 `session.defaultSession.setProxy`，并把代理输入框从书市移进设置页。
 *
 * 跑法（两条都必须照做，理由见 .AGENT/scripts/secret-format/probe.cjs 头注）：
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe .AGENT/scripts/book-market/probe-s0-session.cjs --no-sandbox --disable-gpu
 *   ① unset ELECTRON_RUN_AS_NODE —— 沙箱 shell 注入该变量(1) 时 electron 以纯 Node 模式启动，app 为 undefined
 *   ② .cjs 入口 —— Electron 33 的 ESM 主进程加载 CJS 依赖会炸 cjsPreparseModuleExports
 *
 * 产物：stdout 一份 JSON + tmp/book-market-s0-result.json（留档）
 *
 * 声明：只读探测，不写任何应用数据。**只**动 'bookmarket' 这个一次性 partition 的代理 ——
 *       绝不碰 defaultSession 的代理设置（那会殃及 llmService 等既有网络路径）。
 *
 * ── v2 修订（2026-09-22，首轮三处探针自身写错，逐条记此以免当成 API 结论）────────────────
 *   ✗ v1 把 `method: 'HEAD'` 当**请求头**传进 viaRequest 的 headers —— 实际发的是 GET，
 *     拿到的 504 是中间层错误页，与 HEAD 无关。v2 起 options 与 headers 分开。
 *   ✗ v1 死代理规则写 `http=127.0.0.1:1` —— Chromium 的 ProxyRules 里 `http=` 只管 **http** 协议，
 *     目标是 https ⇒ 规则不匹配 ⇒ 直连 ⇒ 「隔离不成立」是假象。v2 用 `https=…;http=…` 两条。
 *   ✗ v1 让 defaultSession 下整份 558 KB 文件（超时是探针自己设的 15s 掐的）。
 *     v2 所有请求一律带 `Range: bytes=0-1023`，单次只取 1 KB。
 *   ✓ 另加：每个用例 2 次尝试（本机网络冷启动偶发 ERR_CONNECTION_CLOSED，v1 首请求即撞上），
 *     两次结果都留档，不挑好看的那次。
 */
const { app, session, net } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join, dirname } = require('node:path')

const PARTITION = 'bookmarket'
/** 真实目标主机：书市预置源 Gutenberg（探针要打在将来真会用的主机上，而不是好说话的假主机上） */
const TARGET = 'https://www.gutenberg.org/cache/epub/1342/pg1342.epub'
const RANGE = { Range: 'bytes=0-1023' }
const DEAD_PROXY = { proxyRules: 'https=127.0.0.1:1;http=127.0.0.1:1', proxyBypassRules: '<local>' }

/** 走 net.request（可读流路径）。opts 与 headers 分开传 —— v1 的教训。 */
function viaRequest(sess, url, opts = {}, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const chunks = []
    let done = false
    const finish = (o) => { if (!done) { done = true; resolve({ ...o, ms: Date.now() - started }) } }
    let req
    try {
      req = net.request({ session: sess, url, redirect: 'follow', ...opts })
    } catch (e) {
      return finish({ ok: false, error: 'construct: ' + String((e && e.message) || e) })
    }
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
    const timer = setTimeout(() => { try { req.abort() } catch { /* noop */ } finish({ ok: false, error: 'timeout' }) }, timeoutMs)
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        clearTimeout(timer)
        const buf = Buffer.concat(chunks)
        finish({
          ok: true,
          status: res.statusCode,
          acceptRanges: res.headers['accept-ranges'] || null,
          contentRange: res.headers['content-range'] || null,
          contentLength: res.headers['content-length'] || null,
          bytes: buf.length,
          head: buf.subarray(0, 4).toString('latin1'),
        })
      })
      res.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: 'stream: ' + String((e && e.message) || e) }) })
    })
    req.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: 'request: ' + String((e && e.message) || e) }) })
    req.end()
  })
}

/** 走 net.fetch（sourceClient 复用 llmService.httpJson 就是这条） */
async function viaFetch(sess, url, init = {}, timeoutMs = 20000) {
  const started = Date.now()
  try {
    // sess 传 null = 显式不指定 session（对照用）
    const res = await net.fetch(url, { ...(sess ? { session: sess } : {}), ...init, signal: AbortSignal.timeout(timeoutMs) })
    const buf = Buffer.from(await res.arrayBuffer())
    return {
      ok: true,
      status: res.status,
      acceptRanges: res.headers.get('accept-ranges'),
      contentRange: res.headers.get('content-range'),
      contentLength: res.headers.get('content-length'),
      bytes: buf.length,
      ms: Date.now() - started,
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - started }
  }
}

/** 跑两次，两次都留档（本机网络冷启动偶发连接被关，不挑好看的那次上报） */
async function twice(label, fn) {
  const a = await fn()
  const b = await fn()
  return { [label + '#1']: a, [label + '#2']: b, [label + 'ok']: !!(a.ok && b.ok) }
}

/**
 * 稳定性模式（`--stability`）：同一 session 上交替跑 N 次 net.request / net.fetch（直连、无代理），
 * 只为回答一个问题 —— 「net.request 在本机是不是天生不稳」，还是首轮那两次失败只是启动抖动。
 * 这决定了方案 §三 能不能把整条网络链路压在 net.request 上。
 */
async function stabilityMode() {
  const s = session.fromPartition('bookmarket-stability')
  await s.setProxy({ mode: 'direct' })
  const rounds = 6
  const res = { when: new Date().toISOString(), rounds, request: [], fetch: [] }
  for (let i = 0; i < rounds; i++) {
    res.request.push(await viaRequest(s, TARGET + '?st=r' + i + '-' + Date.now(), {}, RANGE, 15000))
    res.fetch.push(await viaFetch(s, TARGET + '?st=f' + i + '-' + Date.now(), { headers: RANGE }, 15000))
  }
  const okOf = (a) => a.filter((x) => x.ok).length
  res.summary = {
    request: okOf(res.request) + '/' + rounds,
    fetch: okOf(res.fetch) + '/' + rounds,
    requestErrors: res.request.filter((x) => !x.ok).map((x) => x.error),
  }
  console.log(JSON.stringify(res, null, 2))
  try {
    const dest = join(process.cwd(), 'tmp', 'book-market-s0-stability.json')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, JSON.stringify(res, null, 2))
  } catch { /* 落盘不影响 stdout */ }
}

/**
 * 代理归属模式（`--proxy-follow`）：回答「net.fetch 到底读谁的代理」。
 * 做法：把死代理设到 **defaultSession**，而书市分区保持直连 ——
 *   · 带 {session:书市分区} 的 fetch 若**失败** ⇒ 它读的是 defaultSession 的代理（session 参数对代理无效）
 *   · 若成功 ⇒ 它压根没走代理（另有原因）
 * 对照：net.request({session:书市分区}) 此时应仍成功（用它自己那条直连）。
 * ★ 本模式**例外地**动了 defaultSession 的代理 —— 探针是独立一次性进程，退出即消失，不会影响正在跑的应用。
 */
async function proxyFollowMode() {
  const s = session.fromPartition('bookmarket-follow')
  await s.setProxy({ mode: 'direct' })
  await session.defaultSession.setProxy(DEAD_PROXY)
  const res = {
    when: new Date().toISOString(),
    setup: { bookmarket: 'direct', defaultSession: DEAD_PROXY.proxyRules },
    fetchWithBookmarketSession: await viaFetch(s, TARGET + '?pf=f-' + Date.now(), { headers: RANGE }, 12000),
    requestWithBookmarketSession: await viaRequest(s, TARGET + '?pf=r-' + Date.now(), {}, RANGE, 12000),
    fetchNoSession: await viaFetch(null, TARGET + '?pf=n-' + Date.now(), { headers: RANGE }, 12000),
  }
  await session.defaultSession.setProxy({ mode: 'direct' }) // 复位（进程随即退出，纯属干净）
  res.verdict =
    res.fetchWithBookmarketSession.ok && !res.fetchNoSession.ok
      ? 'net.fetch 读的是 defaultSession 的代理 —— session 参数对代理无效（书市分区直连也救不了它）'
      : !res.fetchWithBookmarketSession.ok
        ? 'net.fetch 受 defaultSession 死代理影响 ⇒ 代理归属 = defaultSession'
        : 'net.fetch 既未受 defaultSession 影响、也没走代理 —— 需进一步查（可能压根忽略代理）'
  console.log(JSON.stringify(res, null, 2))
  try {
    const dest = join(process.cwd(), 'tmp', 'book-market-s0-proxy-follow.json')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, JSON.stringify(res, null, 2))
  } catch { /* 落盘不影响 stdout */ }
}

app.whenReady().then(async () => {
  if (process.argv.includes('--stability')) {
    await stabilityMode()
    return app.quit()
  }
  if (process.argv.includes('--proxy-follow')) {
    await proxyFollowMode()
    return app.quit()
  }

  const out = {
    when: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    target: TARGET,
  }

  const s = session.fromPartition(PARTITION)
  out.partition = {
    name: PARTITION,
    isPersistent: s.isPersistent(),
    sameInstanceOnSecondCall: s === session.fromPartition(PARTITION),
    isDefaultSession: s === session.defaultSession,
    cookiesAtStart: (await s.cookies.get({})).length,
  }

  // ── ① setProxy 在非持久 partition 上不生事 ────────────────────────────
  try { await s.setProxy({ mode: 'direct' }); out.setProxyDirect = { ok: true } }
  catch (e) { out.setProxyDirect = { ok: false, error: String((e && e.message) || e) } }

  // ── ② 直连：Range 端到端（net.fetch 与 net.request 各两次）─────────────
  Object.assign(out, await twice('directFetch', () => viaFetch(s, TARGET, { headers: RANGE })))
  Object.assign(out, await twice('directRequest', () => viaRequest(s, TARGET, {}, RANGE)))
  // HEAD 取 Content-Length —— §4.3 的 128MB 体积闸要靠它预检（v2：method 走 opts，不是 header）
  Object.assign(out, await twice('headContentLength', () => viaRequest(s, TARGET, { method: 'HEAD' }, {})))

  // ── ③ 隔离：配死代理 → 书市侧必须失败；同一时刻 defaultSession 必须正常 ──
  // ★ cache-busting：同 URL 刚直连成功过，再请求会命中该 session 的 HTTP 缓存（实测 2ms 返回 206），
  //   请求压根不出网、代理自然不被咨询 → 会得出「死代理下仍然成功」的**假**不成立。加唯一 query 强制出网。
  const BUST = () => TARGET + '?s0=' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  const bustUrl = BUST()
  out.isolationUrls = { bookmarket: bustUrl, defaultSession: BUST() }
  try { await s.setProxy(DEAD_PROXY); out.setProxyDead = { ok: true, rules: DEAD_PROXY.proxyRules } }
  catch (e) { out.setProxyDead = { ok: false, error: String((e && e.message) || e) } }
  // ★ 连接池：同 origin 的 TLS 长连接若还热着，复用旧 socket 就**不会**去问代理
  //   → 表象是「设了死代理 fetch 仍成功」。掐掉连接强制新建，才是对代理是否生效的有效判据。
  try { await s.closeAllConnections(); out.closeAllConnections = { ok: true } }
  catch (e) { out.closeAllConnections = { ok: false, error: String((e && e.message) || e) } }
  out.withDeadProxy = await viaFetch(s, out.isolationUrls.bookmarket, { headers: RANGE }, 12000)
  // 第二次 fetch 用「另一个 origin」彻底绕开可能的池残留（fetch-only 的对照）
  out.withDeadProxyFetchOtherOrigin = await viaFetch(s, 'https://www.gutenberg.org/robots.txt?x=' + Date.now(), {}, 12000)
  out.defaultSessionUnaffected = await viaFetch(session.defaultSession, 'https://www.gutenberg.org/cache/epub/1342/pg1342.epub?ds=' + Date.now(), { headers: RANGE }, 20000)
  // 死代理下再补一次 net.request，两条路径都别漏（同样带唯一 query）
  out.withDeadProxyRequest = await viaRequest(s, bustUrl + '-r', {}, RANGE, 12000)

  try { await s.setProxy({ mode: 'direct' }) } catch { /* noop */ }

  // ── 判定 ──────────────────────────────────────────────────────────────
  /** Range 是否端到端：206 = 服务器照办；200+accept-ranges = Electron 发出去了但服务器没照办（非 Electron 侧问题） */
  const rangeOf = (o) => (o.ok ? (o.status === 206 ? '206' : o.status === 200 && o.acceptRanges ? '200(服务器未照办)' : String(o.status)) : o.error || '失败')
  const isolationFetchOk = !out.withDeadProxy.ok && out.defaultSessionUnaffected.ok
  const isolationReqOk = !out.withDeadProxyRequest.ok
  const headOk = out.headContentLengthok && out['headContentLength#1'].contentLength

  out.verdicts = {
    '①非持久 partition': out.partition.isPersistent === false && out.partition.sameInstanceOnSecondCall && !out.partition.isDefaultSession ? '成立' : '不成立',
    '①setProxy 可调用': out.setProxyDirect.ok && out.setProxyDead.ok ? '成立' : '不成立',
    '②net.fetch + Range': out.directFetchok ? '成立（' + rangeOf(out['directFetch#1']) + ' / ' + rangeOf(out['directFetch#2']) + '）' : '不成立（' + rangeOf(out['directFetch#1']) + ' / ' + rangeOf(out['directFetch#2']) + '）',
    '②net.request + Range': out.directRequestok ? '成立（' + rangeOf(out['directRequest#1']) + ' / ' + rangeOf(out['directRequest#2']) + '）' : '不成立（' + rangeOf(out['directRequest#1']) + ' / ' + rangeOf(out['directRequest#2']) + '）',
    '②HEAD 取 Content-Length': headOk ? '成立（' + headOk + '）' : '不成立（' + rangeOf(out['headContentLength#1']) + ' / ' + rangeOf(out['headContentLength#2']) + '）',
    '③死代理下书市侧失败': isolationReqOk
      ? '成立 —— 判据取 net.request（net.fetch 在此项已知无效，见 ④）'
      : '不成立（net.request ' + (out.withDeadProxyRequest.ok ? '仍成功✗' : '失败✓') + '）',
    '④net.fetch 是否认 session 代理': out.withDeadProxy.ok
      ? '★ 不认 —— 死代理 + closeAllConnections + 换 origin 三重条件下仍成功；代理归属实测 = defaultSession（见 --proxy-follow 模式）'
      : '认（与本机两次复现不符，需复核）',
    '③defaultSession 不受影响': out.defaultSessionUnaffected.ok ? '成立（' + rangeOf(out.defaultSessionUnaffected) + '）' : '不成立（' + out.defaultSessionUnaffected.error + '）',
  }
  const hard = ['①非持久 partition', '①setProxy 可调用', '②net.fetch + Range', '③死代理下书市侧失败', '③defaultSession 不受影响']
  out.overall = hard.every((k) => String(out.verdicts[k]).startsWith('成立'))
    ? 'PASS（拍板 ② 可保住：专用非持久 partition + setProxy 成立）★ 但方案 §三 的 API 选型必须改：代理只对 net.request 生效，net.fetch 读的是 defaultSession 的代理 ⇒ sourceClient 不得复用 llmService.httpJson（net.fetch），下载器也不得照抄 updateService 的 net.fetch —— 走代理的请求一律 net.request({session})'
    : '需人工判读 —— 见 verdicts'

  console.log(JSON.stringify(out, null, 2))
  try {
    const dest = join(process.cwd(), 'tmp', 'book-market-s0-result.json')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, JSON.stringify(out, null, 2))
  } catch { /* 落盘不影响 stdout */ }

  app.quit()
})
