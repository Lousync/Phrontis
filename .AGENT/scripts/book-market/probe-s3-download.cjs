/**
 * 书市 S3 探针 —— 在真实 electron 主进程里跑**真实的下载器实现**，只认磁盘字节、队列状态与
 * 服务端看到了什么请求。
 *
 * 为什么必须有它（三件事只有在这儿才验得动）：
 *   ① **半截文件不上架**：`scanVaultBooks` 按扩展名收书 ⇒ 直接写 `{作者} - {书名}.epub` 的话，
 *      下一半的书会挂上书架、点开必崩。本探针在下载**进行中**断言目标文件不存在、
 *      扫描清单里没有它、`.meta.json` 里也没有它。
 *   ② **`Range` 续传**：只有真发请求才能看见 `Range: bytes=N-` 与 206。
 *   ③ **并发恒 1**：★ 必须**跨 origin** 量 —— S2 已实测 chromium 把**同一 origin** 的并发
 *      `net.request` 串行化（4 个同发，服务端只见 1 个在飞），所以单 origin 的 mock
 *      量不出「我们的池子是 1」还是「传输层把它串成了 1」。这里让三本书各占一个端口。
 *      判据以**客户端侧**为主（任一时刻 `down` 的任务 ≤ 1），服务端侧看**窗口重叠时长**
 *      （服务端的 `finish` 比客户端收完最后一个字节晚 ~20ms，瞬时计数会假报 2 —— 见 ⑩ 段）。
 *
 * 跑法（两步；Electron 33 = Node 20，不能 strip-types，所以先把真实实现打包）：
 *   node_modules/.bin/esbuild tmp/s3-probe-entry.ts --bundle --platform=node \
 *     --format=cjs --external:electron --outfile=tmp/s3-downloader.cjs
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe .AGENT/scripts/book-market/probe-s3-download.cjs --no-sandbox --disable-gpu
 *
 * ★ 声明：**不碰用户的开发数据目录**。启动即把 userData 改到系统临时目录，仓库用临时目录里的
 *   假 vault；临时目录**不删**（便于人工复核），路径打在输出里。
 * ★ 凭据负向：标记值只出现在本文件与 mock 的校验里；stdout、队列快照、失败文案、
 *   落盘字节里一个字节都不许有。
 *
 * 产物：stdout 一份 JSON + tmp/book-market-s3-download.json（留档）
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const http = require('node:http')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const BASE = mkdtempSync(join(tmpdir(), 'kb-probe-s3-'))
const USER_DATA = join(BASE, 'userData')
const VAULT = join(BASE, 'vault')
// ★ 必须在 app ready 之前改：晚了 settings.json 已经按真实 userData 算好路径（会写进开发数据目录）
app.setPath('userData', USER_DATA)

const BOOKS = join(VAULT, '.books')
const META_FILE = join(BOOKS, '.meta.json')
const LEAK = { USER: 'LEAKUSER7c41', PASS: 'LEAKPASS7c41', TOKEN: 'LEAKTOKEN7c41' }
const BASIC_EXPECTED = 'Basic ' + Buffer.from(`${LEAK.USER}:${LEAK.PASS}`, 'utf-8').toString('base64')

const results = []
let pass = true
// 全量 stdout 留档：**凭据负向**要断言「打印出来的东西里一个标记值都没有」，
// 所以先攒下来再一起打（S2 同款做法）
const CAPTURED = []
const rawLog = console.log.bind(console)
console.log = (...args) => { CAPTURED.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); rawLog(...args) }

function check(name, ok, extra = '') {
  if (!ok) pass = false
  results.push({ name, ok: !!ok, extra: String(extra) })
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
}
/** 只记录、不作判据（平台事实 / 定型缺口之类「知道就行」的观察） */
function info(name, extra = '') {
  console.log(`  --  ${name}${extra ? `  [${extra}]` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ★ 探针自己不许抛：文件不在就判 fail，别让 readFileSync 把整条断言链打断
//   （打断的后果是「后面一条断言都没跑，进程挂到超时」—— 一次假绿的温床）
function bytesOf(p) { try { return readFileSync(p) } catch { return null } }
function sameBytes(p, buf) { const b = bytesOf(p); return !!b && b.length === buf.length && Buffer.compare(b, buf) === 0 }
process.on('unhandledRejection', (e) => check('探针自身未抛异常（unhandledRejection）', false, (e && e.message) || String(e)))
process.on('uncaughtException', (e) => check('探针自身未抛异常（uncaughtException）', false, (e && e.message) || String(e)))

// ===== 全局在飞计数（★ 跨 origin 才有意义，见文件头注 ③） =====
const GLOBAL = { all: 0, max: 0 }
/** 所有 origin 的请求时间区间（`[t, endT]`）：并发判据靠**区间重叠**，不靠瞬时计数 ——
 *  服务端的 `finish` 记账比客户端「拿到最后一个字节」晚几个 tick（见 ⑩ 段注释） */
const ALLHITS = []
/** 跨 origin 的最长重叠时长（ms）：两端都记账完才消失，故正常应为 0 或个位数毫秒。
 *  `endT === 0` = 这条请求到探针结束都没记账（响应没结束），按「一直开着」算。 */
function maxOverlapMs() {
  if (!ALLHITS.length) return 0
  const horizon = Math.max(...ALLHITS.map((h) => h.t)) + 1
  const endOf = (h) => h.endT || horizon
  let worst = 0
  for (let i = 0; i < ALLHITS.length; i++) {
    for (let j = i + 1; j < ALLHITS.length; j++) {
      const a = ALLHITS[i]; const b = ALLHITS[j]
      if (a.tag === b.tag) continue
      const ov = Math.min(endOf(a), endOf(b)) - Math.max(a.t, b.t)
      if (ov > worst) worst = ov
    }
  }
  return worst
}

/** 确定性字节体（**逐字节可比**：全填同一个值的话，偏移错一位也照样「相等」） */
function bodyOf(n, seed) {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 17) & 0xff
  return b
}

const RANGE_RE = /^bytes=(\d+)-$/

function sendFile(req, res, buf, type) {
  const m = RANGE_RE.exec(String(req.headers.range || ''))
  if (m) {
    const off = Number(m[1])
    if (off >= buf.length) { res.writeHead(416); res.end(); return }
    const seg = buf.subarray(off)
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': String(seg.length),
      'Content-Range': `bytes ${off}-${buf.length - 1}/${buf.length}`,
      'Accept-Ranges': 'bytes',
    })
    res.end(seg)
    return
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(buf.length), 'Accept-Ranges': 'bytes' })
  res.end(buf)
}

/** 涓流：给暂停/取消/并发测量留出足够长的在飞窗口 */
function sendSlow(req, res, buf, type, chunk, delayMs) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(buf.length) })
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

/** 一个 origin = 一个 mock 服务（测并发必须多个 origin） */
function mkSrv(tag, routes) {
  const s = { tag, hits: [], inflight: 0, max: 0, origin: '' }
  s.srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    s.inflight++
    GLOBAL.all++
    if (GLOBAL.all > GLOBAL.max) GLOBAL.max = GLOBAL.all
    if (s.inflight > s.max) s.max = s.inflight
    const hit = {
      tag, path: u.pathname,
      auth: String(req.headers.authorization || ''),
      range: String(req.headers.range || ''),
      ua: String(req.headers['user-agent'] || ''),
      t: Date.now(), endT: 0,
    }
    s.hits.push(hit)
    ALLHITS.push(hit)
    let over = false
    const finish = () => { if (over) return; over = true; hit.endT = Date.now(); s.inflight--; GLOBAL.all-- }
    res.on('finish', finish)
    res.on('close', finish)
    res.on('error', () => { /* 客户端中止是常态（暂停/取消/体积闸），别让 mock 自己炸 */ })
    const route = routes[u.pathname]
    if (!route) { res.writeHead(404); res.end('nope'); return }
    try { route(req, res) } catch { try { res.destroy() } catch { /* 见上 */ } }
  })
  s.listen = () => new Promise((r) => s.srv.listen(0, '127.0.0.1', () => { s.origin = `http://127.0.0.1:${s.srv.address().port}`; r(s) }))
  s.hitsOn = (p) => s.hits.filter((h) => h.path === p)
  s.reset = () => { s.hits = []; s.max = 0 }
  s.close = () => new Promise((r) => s.srv.close(r))
  return s
}

function resetGlobal() { GLOBAL.all = 0; GLOBAL.max = 0; ALLHITS.length = 0 }

app.whenReady().then(async () => {
  mkdirSync(join(VAULT, '.knowbase'), { recursive: true })
  writeFileSync(join(VAULT, '.knowbase', 'meta.json'), JSON.stringify({ schemaVersion: 1, name: 'probe' }), 'utf-8')

  const D = require(join(process.cwd(), 'tmp', 's3-downloader.cjs'))
  const { setCurrentVault } = D
  const ROOT = 'probe-vault'
  setCurrentVault({ rootId: ROOT, name: 'probe-vault', rootPath: VAULT })

  // ===== mock 数据 =====
  const B1 = bodyOf(700 * 1024, 1)
  const B2 = bodyOf(700 * 1024, 2)
  const B3 = bodyOf(700 * 1024, 3)
  const SLOW = bodyOf(400 * 1024, 4)
  const COVER = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bodyOf(3000, 9)])
  /** 第二个封面：**内容与 URL 都不同**（用来量「换封面 ⇒ 旧封面回收」） */
  const COVER2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bodyOf(2048, 11)])

  let flakyHits = 0
  const A = await mkSrv('A', {
    '/ok/1.epub': (req, res) => sendFile(req, res, B1, 'application/epub+zip'),
    '/ok/2.epub': (req, res) => sendFile(req, res, B2, 'application/epub+zip'),
    '/ok/3.epub': (req, res) => sendFile(req, res, B3, 'application/epub+zip'),
    '/slow.epub': (req, res) => sendSlow(req, res, SLOW, 'application/epub+zip', 8 * 1024, 40),
    '/flaky.epub': (req, res) => {
      flakyHits++
      if (flakyHits === 1) { res.writeHead(500); res.end('boom'); return }
      sendFile(req, res, B2, 'application/epub+zip')
    },
    '/auth.epub': (req, res) => {
      if (String(req.headers.authorization || '') !== BASIC_EXPECTED) { res.writeHead(401); res.end('need auth'); return }
      sendFile(req, res, B1, 'application/epub+zip')
    },
    '/404.epub': (req, res) => { res.writeHead(404); res.end('gone') },
    '/html.epub': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>登录页</html>') },
    '/toobig.epub': (req, res) => {
      // 头里报一个超上限的体积，但只吐一点点字节：下载器必须在**消费 body 之前**就拒掉
      res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': String(D.MAX_BOOK_BYTES + 1) })
      res.write(bodyOf(1024, 7))
    },
    '/cover/ok.png': (req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(COVER) },
    '/cover/ok2.png': (req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(COVER2) },
    '/cover/text.png': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not an image') },
    '/cover/slow.png': (req, res) => sendSlow(req, res, COVER, 'image/png', 512, 10),
  }).listen()
  const B = await mkSrv('B', { '/ok/b.epub': (req, res) => sendSlow(req, res, B2, 'application/epub+zip', 16 * 1024, 25) }).listen()
  const C = await mkSrv('C', { '/ok/c.epub': (req, res) => sendSlow(req, res, B3, 'application/epub+zip', 16 * 1024, 25) }).listen()
  const Dd = await mkSrv('D', { '/ok/d.epub': (req, res) => sendSlow(req, res, B1, 'application/epub+zip', 16 * 1024, 25) }).listen()
  info('mock origins', `A=${A.origin} B=${B.origin} C=${C.origin} D=${Dd.origin}`)

  // ===== 广播观察窗（隐藏窗口 + preload 把主进程推来的事件转回主进程） =====
  // ★ 为什么要开真窗口：`windowBus.broadcast` 遍历 `BrowserWindow.getAllWindows()`，
  //   一个窗口都没有时它**静默什么都不做** —— 那时探针只能验「载荷来源」（队列快照），
  //   验不到「渲染层真的收得到」，而后者才是铁律 18 那个「下完了书架里没有」的失败模式。
  const PRELOAD = join(BASE, 'probe-preload.cjs')
  writeFileSync(PRELOAD, [
    "const { ipcRenderer } = require('electron')",
    "ipcRenderer.on('bookMarket:download-progress', (_e, p) => ipcRenderer.send('probe:progress', p))",
    "ipcRenderer.on('kb:data-changed', (_e, p) => ipcRenderer.send('probe:datachanged', p))",
    "ipcRenderer.send('probe:ready')",
  ].join('\n'), 'utf-8')
  const progressEvents = []
  const dataChangedEvents = []
  let preloadReady = false
  ipcMain.on('probe:progress', (_e, p) => progressEvents.push(p))
  ipcMain.on('probe:datachanged', (_e, p) => dataChangedEvents.push(p))
  ipcMain.on('probe:ready', () => { preloadReady = true })
  const win = new BrowserWindow({ show: false, webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true } })
  await win.loadURL('about:blank')
  const readyOk = await (async () => {
    for (let i = 0; i < 100 && !preloadReady; i++) await sleep(50)
    return preloadReady
  })()
  check('广播观察窗就绪（preload 握手）', readyOk)

  const out = { when: new Date().toISOString(), electron: process.versions.electron, base: BASE, vault: VAULT, checks: results }
  const q = () => D.listDownloadQueue(ROOT)
  const byId = (id) => q().find((t) => t.id === id)
  const dest = (name) => join(BOOKS, name)
  async function waitState(id, want, ms = 15000) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const t = byId(id)
      if (t && want.includes(t.state)) return t
      await sleep(40)
    }
    return byId(id)
  }
  async function waitIdle(ms = 15000) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (q().every((t) => t.state === 'done' || t.state === 'fail')) return true
      await sleep(40)
    }
    return false
  }

  // ===== 书源（凭据注入用） =====
  const srcCreated = D.bookSourceUpsert(ROOT, { name: 'mock 源', kind: 'opds', url: A.origin, auth: { type: 'basic', ref: '' } })
  const SRC_ID = srcCreated.source?.id
  D.bookSourceSaveCredential(ROOT, SRC_ID, { type: 'basic', username: LEAK.USER, password: LEAK.PASS })
  check('测试书源就绪（带 basic 凭据）', !!SRC_ID && D.bookSourceList(ROOT).find((s) => s.id === SRC_ID)?.auth?.ref === SRC_ID)

  console.log('--- ⓪ 平台事实 / 定型缺口（只记录）---')
  info('MAX_BOOK_BYTES', `${D.MAX_BOOK_BYTES}（= 128MB，需与 EpubReaderView 同值，由 verify-downloader.mjs 静态锁）`)
  check('MAX_BOOK_BYTES 就是 128MB', D.MAX_BOOK_BYTES === 128 * 1024 * 1024)
  // 定型缺口实测：electron.d.ts 说 IncomingMessage 只 extends NodeEventEmitter，运行时到底有没有 Readable 的那几个成员？
  await new Promise((resolve) => {
    const req = require('electron').net.request({ method: 'GET', url: `${A.origin}/ok/1.epub`, session: require('electron').session.fromPartition('bookmarket') })
    req.on('response', (r) => {
      info('net 响应的运行时形状', `destroy=${typeof r.destroy} resume=${typeof r.resume} pipe=${typeof r.pipe} on=${typeof r.on}`)
      try { r.destroy?.() } catch { /* 见上 */ }
      resolve()
    })
    req.on('error', () => { info('net 响应的运行时形状', '请求失败，未测到'); resolve() })
    req.end()
  })

  // ===== ① 格式闸（拍板 ②）=====
  console.log('--- ① 格式闸：不在 BOOK_EXTS 里的一律拒（扫不到 = 静默失败）---')
  A.reset()
  let r = D.startDownload(ROOT, { title: '手机书', ext: 'mobi', downloadUrl: `${A.origin}/ok/1.epub` })
  check('mobi 被拒', r.ok === false && r.error.includes('暂不支持'), r.error || '')
  r = D.startDownload(ROOT, { title: '无扩展名', ext: '', downloadUrl: `${A.origin}/ok/1.epub` })
  check('认不出扩展名被拒', r.ok === false && r.error.includes('暂不支持'), r.error || '')
  r = D.startDownload(ROOT, { title: '', ext: 'epub', downloadUrl: `${A.origin}/ok/1.epub` })
  check('空书名被拒', r.ok === false && r.error.includes('书名'), r.error || '')
  r = D.startDownload(ROOT, { title: '协议不对', ext: 'epub', downloadUrl: 'kbview://x/1.epub' })
  check('非 http(s) 地址被拒', r.ok === false && r.error.includes('地址'), r.error || '')
  check('rootId 不匹配被拒（另起一个仓）', D.startDownload('other-vault', { title: 'x', ext: 'epub', downloadUrl: `${A.origin}/ok/1.epub` }).ok === false)
  check('★ 被拒的入队**一个请求都没发**', A.hits.length === 0, `hits=${A.hits.length}`)
  check('被拒后队列里没有残留', q().length === 0)

  // ===== ② 体积闸（§4.3-2）=====
  console.log('--- ② 体积闸：预检（源给的体积）+ 复核（响应 Content-Length）---')
  A.reset()
  r = D.startDownload(ROOT, { title: '巨书', ext: 'epub', downloadUrl: `${A.origin}/ok/1.epub`, sizeBytes: D.MAX_BOOK_BYTES + 1 })
  check('源给的体积超上限 → 同步拒（不发请求）', r.ok === false && r.error.includes('上限'), r.error || '')
  check('同上：零请求', A.hits.length === 0, `hits=${A.hits.length}`)
  r = D.startDownload(ROOT, { title: '撒谎的源', author: '乙', ext: 'epub', downloadUrl: `${A.origin}/toobig.epub`, sizeBytes: 0 })
  check('体积未知时入队（复核交给响应头）', r.ok === true, r.error || '')
  const bigTask = await waitState(r.task.id, ['fail'], 10000)
  check('★ 响应头一说超上限就中止（不是下完才报）', bigTask?.state === 'fail' && String(bigTask.error).includes('上限'), `${bigTask?.state} ${bigTask?.error}`)
  check('★ 中止后连 `.part` 都没留下（body 一个字节没消费）', !existsSync(dest('乙 - 撒谎的源.epub.part')))
  check('也没落成正式文件', !existsSync(dest('乙 - 撒谎的源.epub')))

  // ===== ③ 命名闸（拍板 ⑩）=====
  console.log('--- ③ 命名闸：{作者} - {书名}.{ext} + 非法字符替换 ---')
  A.reset()
  r = D.startDownload(ROOT, { title: '含/非法:字符*的?书"名<>,|', author: '作者/甲', ext: 'EPUB', downloadUrl: `${A.origin}/ok/1.epub` })
  check('入队成功（大写扩展名照收）', r.ok === true, r.error || '')
  const weird = byId(r.task.id)
  // 标题里的 `/ : * ? " < > |` 换 `_`；逗号是**合法**文件名字符，不该误伤
  check('非法字符全换成 `_`（逗号不误伤）', weird.relPath === '.books/作者_甲 - 含_非法_字符_的_书_名__,_.epub', weird.relPath)
  check('扩展名归一小写', weird.relPath.endsWith('.epub'))
  r = D.startDownload(ROOT, { title: '只书名', ext: 'epub', downloadUrl: `${A.origin}/ok/2.epub` })
  check('作者为空 → 只留书名', byId(r.task.id).relPath === '.books/只书名.epub', byId(r.task.id).relPath)
  await waitIdle()
  if (q().some((t) => t.state !== 'done')) info('③ 段队列现场', JSON.stringify(q()))
  check('两本都下完了', q().filter((t) => t.state === 'done').length === 2, JSON.stringify(q().map((t) => `${t.title}:${t.state}`)))
  check('落盘字节与 mock **逐字节相同**', sameBytes(dest('只书名.epub'), B2))

  // ===== ④ 重名闸：覆盖 / 另存副本（拍板 ⑩：不静默）=====
  console.log('--- ④ 重名闸：先问，再按决定落盘 ---')
  A.reset()
  // ★ 判据是「队列长度**没变**」而不是「等于 2」：③ 段还留下一个 ② 段失败的项（`撒谎的源`），
  //   写死数字就等于把前面各段的历史一起断言进来 —— 动一段就红一片（这条曾经就是这么误报的）
  const qLenBefore = q().length
  r = D.startDownload(ROOT, { title: '只书名', ext: 'epub', downloadUrl: `${A.origin}/ok/3.epub` })
  check('重名且未表态 → 返回 conflict', r.ok === false && r.conflict === true, JSON.stringify(r))
  check('冲突时**不入队**（队列长度不变）', q().length === qLenBefore, `${qLenBefore} → ${q().length}`)
  check('★ 冲突时**零请求**（没白下一遍再问）', A.hits.length === 0, `hits=${A.hits.length}`)
  check('conflict 带回目标名（渲染层据此弹窗）', r.relPath === '.books/只书名.epub' && r.fileName === '只书名.epub', `${r.relPath}`)
  r = D.startDownload(ROOT, { title: '只书名', ext: 'epub', downloadUrl: `${A.origin}/ok/3.epub` }, 'copy')
  check('选「另存副本」→ 名字加 (2)', r.ok === true && byId(r.task.id).relPath === '.books/只书名 (2).epub', byId(r.task.id)?.relPath)
  await waitState(r.task.id, ['done'])
  check('副本字节是新内容、原文件没被动', sameBytes(dest('只书名 (2).epub'), B3) && sameBytes(dest('只书名.epub'), B2))
  r = D.startDownload(ROOT, { title: '只书名', ext: 'epub', downloadUrl: `${A.origin}/ok/3.epub` }, 'copy')
  check('再来一次 → (3)', byId(r.task.id).relPath === '.books/只书名 (3).epub', byId(r.task.id)?.relPath)
  await waitState(r.task.id, ['done'])
  r = D.startDownload(ROOT, { title: '只书名', ext: 'epub', downloadUrl: `${A.origin}/ok/1.epub` }, 'overwrite')
  check('选「覆盖」→ 用原名重新入队', r.ok === true && byId(r.task.id).relPath === '.books/只书名.epub', byId(r.task.id)?.relPath)
  await waitState(r.task.id, ['done'])
  check('★ 覆盖真的换了内容（新字节已落盘）', sameBytes(dest('只书名.epub'), B1))

  // ===== ⑤ 正常下载：落盘 + 封面 + 元数据 + 广播 =====
  console.log('--- ⑤ 上架链路：文件 → 封面 → .meta.json → 广播 ---')
  progressEvents.length = 0
  dataChangedEvents.length = 0
  A.reset()
  r = D.startDownload(ROOT, {
    sourceId: SRC_ID, sourceName: 'mock 源', title: '呐喊', author: '鲁迅', ext: 'epub',
    downloadUrl: `${A.origin}/ok/1.epub`, coverUrl: `${A.origin}/cover/ok.png`,
  })
  check('入队成功', r.ok === true, r.error || '')
  const t5 = await waitState(r.task.id, ['done'], 15000)
  check('队列状态 → done', t5?.state === 'done', `${t5?.state} ${t5?.error || ''}`)
  // ★ 本条断言的书**带凭据源**（`sourceId: SRC_ID`）⇒ Authorization 一定非空；
  //   要验的是 UA（`openBookRequest` 统一挂）—— 写成 `auth === ''` 是条自相矛盾的断言，
  //   而 mock 当时根本没记 UA，于是「名字说 UA、身体查 auth」永远红（已修）
  check('HTTP 头带书市 UA', /KnowledgeRecorder|Phrontis|knowbase/i.test(A.hitsOn('/ok/1.epub')[0]?.ua || ''), A.hitsOn('/ok/1.epub')[0]?.ua)
  check('received === total === 文件大小', t5?.received === B1.length && t5?.total === B1.length, `${t5?.received}/${t5?.total}`)
  const bookPath = dest('鲁迅 - 呐喊.epub')
  check('正式文件已落盘且字节一致', sameBytes(bookPath, B1))
  check('★ `.part` 已消失（rename 而不是留着）', !existsSync(`${bookPath}.part`))
  const meta = D.bookMetaGet('.books/鲁迅 - 呐喊.epub')
  check('元数据写入 title/author', meta?.title === '呐喊' && meta?.author === '鲁迅', JSON.stringify(meta))
  check('元数据写入 sourceId/sourceName/size', meta?.sourceId === SRC_ID && meta?.sourceName === 'mock 源' && meta?.size === B1.length, JSON.stringify(meta))
  check('元数据 downloadedAt 非空', !!meta?.downloadedAt)
  const coverRel = meta?.coverRel || ''
  check('封面落到 `.books/.covers/<hash>.jpg`', /^\.books\/\.covers\/[a-z0-9]+\.jpg$/.test(coverRel), coverRel)
  check('封面字节与 mock 一致', sameBytes(join(VAULT, coverRel), COVER))
  check('★ 书在扫描清单里（书架看得见）', D.scanVaultBooks().some((b) => b.relPath === '.books/鲁迅 - 呐喊.epub'))
  check('★ 书架上出现且 meta 书名作者齐（S3 出口判据）', D.scanVaultBooks().some((b) => b.relPath === '.books/鲁迅 - 呐喊.epub' && D.bookMetaGet(b.relPath)?.title === '呐喊'))
  check('★ 渲染层收到 bookMarket:download-progress（载荷 = { rootId, tasks }）',
    progressEvents.length > 0 && progressEvents.every((p) => p && p.rootId === ROOT && Array.isArray(p.tasks)),
    `events=${progressEvents.length}`)
  check('★ 渲染层收到 kb:data-changed scope=bookMarket',
    dataChangedEvents.some((p) => p && p.scope === 'bookMarket'),
    JSON.stringify(dataChangedEvents.slice(0, 3)))
  check('进度事件里有终态 done', progressEvents.some((p) => p.tasks.some((t) => t.state === 'done')))

  // 封面两种不健康形态：不是图片 / 太大 → 书照样上架，只是没封面
  A.reset()
  r = D.startDownload(ROOT, { title: '无封面甲', ext: 'epub', downloadUrl: `${A.origin}/ok/2.epub`, coverUrl: `${A.origin}/cover/text.png` })
  await waitState(r.task.id, ['done'])
  check('封面不是图片 → 书照上架、coverRel 为空', D.bookMetaGet('.books/无封面甲.epub')?.coverRel === '')
  r = D.startDownload(ROOT, { title: '无封面乙', ext: 'epub', downloadUrl: `${A.origin}/ok/3.epub`, coverUrl: `${A.origin}/cover/slow.png` })
  await waitState(r.task.id, ['done'])
  check('封面抓取本身不阻塞上架', D.bookMetaGet('.books/无封面乙.epub')?.title === '无封面乙')

  // ===== ⑥ Range 续传 =====
  console.log('--- ⑥ 续传：`.part` 现存字节 → `Range: bytes=N-` → 206 ---')
  A.reset()
  const halfPath = dest('鲁迅 - 呐喊.epub')
  const HALF = 300 * 1024
  // 造一个「上次下到一半」的现场：截断成前 N 字节
  writeFileSync(`${halfPath}.part`, B1.subarray(0, HALF))
  r = D.startDownload(ROOT, { title: '呐喊', author: '鲁迅', ext: 'epub', downloadUrl: `${A.origin}/ok/1.epub` }, 'overwrite')
  check('重下已存在的书（覆盖）入队成功', r.ok === true, r.error || '')
  const t6 = await waitState(r.task.id, ['done'])
  const hits6 = A.hitsOn('/ok/1.epub')
  check('服务端收到 `Range: bytes=307200-`', hits6[0]?.range === `bytes=${HALF}-`, hits6[0]?.range)
  check('只请求了 1 次（续传而不是重下）', hits6.length === 1, `hits=${hits6.length}`)
  check('★ 续传后文件**逐字节完整**（接缝没错位）', sameBytes(halfPath, B1))
  check('received 从续传点起算（= 全长）', t6?.received === B1.length && t6?.total === B1.length, `${t6?.received}/${t6?.total}`)

  // ===== ⑥b 换封面：URL 变 ⇒ hash 变 ⇒ 旧文件无人引用，要回收（`.covers/` 不留孤儿）=====
  console.log('--- ⑥b 换封面：新封面落盘 + 旧封面回收 ---')
  const oldCover = D.bookMetaGet('.books/鲁迅 - 呐喊.epub')?.coverRel || ''
  const oldCoverAbs = oldCover ? join(VAULT, oldCover) : ''
  check('⑥ 段重下**没**把已有封面抹掉（抓图失败不该动上一版）', /^\.books\/\.covers\/.+\.jpg$/.test(oldCover), oldCover)
  A.reset()
  r = D.startDownload(ROOT, {
    title: '呐喊', author: '鲁迅', ext: 'epub',
    downloadUrl: `${A.origin}/ok/1.epub`, coverUrl: `${A.origin}/cover/ok2.png`,
  }, 'overwrite')
  await waitState(r.task.id, ['done'])
  const newCover = D.bookMetaGet('.books/鲁迅 - 呐喊.epub')?.coverRel || ''
  check('换封面后 meta 指向新文件', newCover !== '' && newCover !== oldCover, `${oldCover} → ${newCover}`)
  check('新封面字节与 mock 一致', sameBytes(join(VAULT, newCover), COVER2))
  check('★ 旧封面文件被回收（无孤儿）', !!oldCoverAbs && !existsSync(oldCoverAbs), oldCoverAbs)

  // ===== ⑦ 半截文件不上架（S3 最要紧的负向保证）=====
  console.log('--- ⑦ 半截文件绝不上架：`.part` 接不上 BOOK_EXTS，扫描天然跳过 ---')
  A.reset()
  r = D.startDownload(ROOT, { title: '慢慢来', author: '丙', ext: 'epub', downloadUrl: `${A.origin}/slow.epub` })
  const tid = r.task.id
  const started = await (async () => {
    for (let i = 0; i < 200; i++) { if ((byId(tid)?.received || 0) > 0) return true; await sleep(25) }
    return false
  })()
  check('慢速下载已开始（有字节在动）', started, JSON.stringify(byId(tid)))
  const mid = byId(tid)
  check('下载中：状态是 down 且有进度', mid?.state === 'down' && mid.received > 0 && mid.total === SLOW.length, `${mid?.state} ${mid?.received}/${mid?.total}`)
  check('★ 下载中：目标文件**不存在**（只写 .part）', !existsSync(dest('丙 - 慢慢来.epub')))
  check('★ 下载中：`.part` 存在（就在那儿攒着）', existsSync(dest('丙 - 慢慢来.epub.part')))
  check('★ 下载中：扫描清单里**没有**它', !D.scanVaultBooks().some((b) => b.relPath.includes('慢慢来')))
  check('★ 下载中：`.meta.json` 里也**没有**它', !D.bookMetaGet('.books/丙 - 慢慢来.epub'))

  // ===== ⑧ 暂停 / 继续 / 取消 =====
  console.log('--- ⑧ 队列逐项控制：pause / resume / cancel ---')
  D.controlDownload(ROOT, tid, 'pause')
  const paused = await waitState(tid, ['paused'], 8000)
  check('暂停后状态 → paused', paused?.state === 'paused', paused?.state)
  const at = paused?.received || 0
  await sleep(400)
  check('★ 暂停后字节**不再增长**（真停了，不是还在偷偷下）', (byId(tid)?.received || 0) === at, `${at} → ${byId(tid)?.received}`)
  check('暂停保留 `.part`（续传靠它）', existsSync(dest('丙 - 慢慢来.epub.part')) && statSync(dest('丙 - 慢慢来.epub.part')).size === at)
  D.controlDownload(ROOT, tid, 'resume')
  const t8 = await waitState(tid, ['done'], 20000)
  check('继续后下完', t8?.state === 'done', `${t8?.state} ${t8?.error || ''}`)
  check('★ 继续是**续传**（服务端收到 Range）', A.hitsOn('/slow.epub').some((h) => h.range.startsWith('bytes=')), JSON.stringify(A.hitsOn('/slow.epub').map((h) => h.range)))
  check('下载后文件字节完整', sameBytes(dest('丙 - 慢慢来.epub'), SLOW))

  A.reset()
  r = D.startDownload(ROOT, { title: '要取消', ext: 'epub', downloadUrl: `${A.origin}/slow.epub` })
  const cid = r.task.id
  for (let i = 0; i < 200; i++) { if ((byId(cid)?.received || 0) > 0) break; await sleep(25) }
  D.controlDownload(ROOT, cid, 'cancel')
  const gone = await (async () => { for (let i = 0; i < 100; i++) { if (!byId(cid)) return true; await sleep(30) } return false })()
  check('取消后队列项消失', gone)
  check('取消顺手删掉 `.part`（不留半截）', !existsSync(dest('要取消.epub.part')) && !existsSync(dest('要取消.epub')))

  // 批量与清空
  A.reset()
  const bulk = [
    D.startDownload(ROOT, { title: '批量一', ext: 'epub', downloadUrl: `${A.origin}/slow.epub` }),
    D.startDownload(ROOT, { title: '批量二', ext: 'epub', downloadUrl: `${A.origin}/slow.epub` }),
  ]
  D.controlDownload(ROOT, '', 'pause-all')
  const allPaused = await (async () => { for (let i = 0; i < 100; i++) { if (bulk.every((x) => byId(x.task.id)?.state === 'paused')) return true; await sleep(30) } return false })()
  check('全部暂停生效', allPaused, JSON.stringify(bulk.map((x) => byId(x.task.id)?.state)))
  D.controlDownload(ROOT, '', 'resume-all')
  check('全部开始生效', await waitIdle(30000))
  D.controlDownload(ROOT, '', 'clear-done')
  check('清除已完成：done 项被清掉、失败项保留（失败要让人看得见）', q().every((t) => t.state !== 'done'))
  check('未知 action 明确报错', D.controlDownload(ROOT, '', 'nonsense').ok === false)

  // ===== ⑨ 失败分档与重试（凭据类不空转）=====
  console.log('--- ⑨ 重试策略：5xx/超时重试一次；401/403 与 4xx **不重试** ---')
  A.reset(); flakyHits = 0
  r = D.startDownload(ROOT, { title: '抖一下', ext: 'epub', downloadUrl: `${A.origin}/flaky.epub` })
  const t9 = await waitState(r.task.id, ['done', 'fail'], 15000)
  check('500 一次后自动重试成功', t9?.state === 'done', `${t9?.state} ${t9?.error || ''}`)
  check('自动重试计数 = 1', t9?.retry === 1, String(t9?.retry))
  check('服务端命中 2 次（确实重试了）', A.hitsOn('/flaky.epub').length === 2, `hits=${A.hitsOn('/flaky.epub').length}`)

  A.reset()
  r = D.startDownload(ROOT, { title: '要凭据', ext: 'epub', downloadUrl: `${A.origin}/auth.epub`, sourceId: 'no-such-source' })
  const t401 = await waitState(r.task.id, ['fail'], 10000)
  check('无凭据 → 401 失败，文案是「需要凭据」', t401?.state === 'fail' && String(t401.error).includes('需要凭据'), `${t401?.state} ${t401?.error}`)
  check('★ 凭据类失败**只打一次**（不空转重试）', A.hitsOn('/auth.epub').length === 1, `hits=${A.hitsOn('/auth.epub').length}`)
  check('重试计数仍是 0', t401?.retry === 0, String(t401?.retry))

  A.reset()
  r = D.startDownload(ROOT, { title: '带凭据', ext: 'epub', downloadUrl: `${A.origin}/auth.epub`, sourceId: SRC_ID })
  const t9b = await waitState(r.task.id, ['done'], 15000)
  check('★ 源配了凭据 → 注入 `Authorization: Basic ...` 且下成功', t9b?.state === 'done' && A.hitsOn('/auth.epub')[0]?.auth === BASIC_EXPECTED, `${t9b?.state} ${A.hitsOn('/auth.epub')[0]?.auth}`)
  check('★ 凭据**不进 URL**（请求行里没有）', !A.hits.some((h) => h.path.includes(LEAK.USER) || h.path.includes(LEAK.PASS)))

  A.reset()
  r = D.startDownload(ROOT, { title: '找不到', ext: 'epub', downloadUrl: `${A.origin}/404.epub` })
  const t404 = await waitState(r.task.id, ['fail'], 10000)
  check('404 → 失败且**不重试**', t404?.state === 'fail' && A.hitsOn('/404.epub').length === 1, `hits=${A.hitsOn('/404.epub').length} ${t404?.error}`)

  A.reset()
  r = D.startDownload(ROOT, { title: '错误页', ext: 'epub', downloadUrl: `${A.origin}/html.epub` })
  const tHtml = await waitState(r.task.id, ['fail'], 10000)
  check('200 但返回网页 → 判失败（别存成一本打不开的书）', tHtml?.state === 'fail' && String(tHtml.error).includes('网页'), `${tHtml?.state} ${tHtml?.error}`)
  check('且没留下任何文件', !existsSync(dest('错误页.epub')) && !existsSync(dest('错误页.epub.part')))

  // ===== ⑩ 并发恒 1（★ 跨 origin 才量得出来）=====
  console.log('--- ⑩ 并发恒 1：三本书各占一个 origin，再看全局在飞峰值 ---')
  resetGlobal(); A.reset(); B.reset(); C.reset(); Dd.reset()
  const trio = [
    D.startDownload(ROOT, { title: '并发一', ext: 'epub', downloadUrl: `${B.origin}/ok/b.epub` }),
    D.startDownload(ROOT, { title: '并发二', ext: 'epub', downloadUrl: `${C.origin}/ok/c.epub` }),
    D.startDownload(ROOT, { title: '并发三', ext: 'epub', downloadUrl: `${Dd.origin}/ok/d.epub` }),
  ]
  check('三本全部入队', trio.every((x) => x.ok), JSON.stringify(trio.map((x) => x.error || 'ok')))
  // ★ 并发判据分两层，因为两层量的东西不一样：
  //   ① **客户端侧（主判据）**：任一时刻处于 `down` 的任务数 ≤ 1 —— 这是我们队列自己的语义，
  //      与任何服务端记账无关；每 10ms 采一次取峰值（三本书各拖 ~1s，必然采得到）。
  //   ② **服务端侧（跨 origin，S2 那条脸的延续）**：三个 origin 的在飞**窗口**两两重叠时长。
  //      不能判瞬时计数：服务端的 `finish` 记账比「客户端收完最后一个字节」晚 ~20ms（实测），
  //      于是交接处瞬时计数会假报 2（曾据此误报「并发 = 2」）。判**重叠时长**就分得开：
  //      真并发（比如以后有人把 pump 改成并发下）是**百毫秒 ~ 千毫秒级**，这个毛边是 20ms 级。
  let downMax = 0
  const sampler = setInterval(() => {
    const n = q().filter((t) => t.state === 'down').length
    if (n > downMax) downMax = n
  }, 10)
  const idled = await waitIdle(30000)
  clearInterval(sampler)
  const overlap = maxOverlapMs()
  check('★ 客户端侧：任一时刻「下载中」的任务 ≤ 1（并发恒 1）', idled && downMax === 1, `峰值=${downMax}`)
  check('★ 服务端侧：三个 origin 的在飞窗口无真实重叠（传输层不替我们串行）', overlap < 50,
    `overlapMs=${overlap.toFixed(1)} 瞬时峰值=${GLOBAL.max} A=${A.max} B=${B.max} C=${C.max} D=${Dd.max}`)
  check('三本都真的下完了', trio.every((x) => byId(x.task.id)?.state === 'done'), JSON.stringify(trio.map((x) => byId(x.task.id)?.state)))

  // ===== ⑪ 凭据负向：任何出得去的东西里都不许有标记值 =====
  console.log('--- ⑪ 凭据负向：队列快照 / 失败文案 / 落盘 / stdout ---')
  const qJson = JSON.stringify(q())
  check('队列快照里无凭据明文字段名', !/"(password|token|username)"/.test(qJson))
  check('队列快照里无标记值', !qJson.includes('LEAK'))
  const srcBytes = String(bytesOf(join(VAULT, '.knowbase', 'modules', 'bookSources.json')) || '')
  check('书源落盘字节里无凭据', !srcBytes.includes(LEAK.PASS) && !srcBytes.includes(LEAK.USER))
  check('书源落盘字节里连字段名都没有', !/"(username|password|token)"\s*:/.test(srcBytes))

  // ===== ⑫ 库房卫生 =====
  console.log('--- ⑫ 库房卫生：不留 `.part` / 封面不留垃圾 ---')
  const leftovers = readdirSync(BOOKS).filter((n) => n.endsWith('.part'))
  check('跑完没有残留的 `.part`', leftovers.length === 0, leftovers.join(','))
  const metaAll = D.bookMetaReadAll()
  const coverRefs = Object.values(metaAll.books).map((b) => b.coverRel).filter(Boolean)
  const coverFiles = existsSync(join(BOOKS, '.covers')) ? readdirSync(join(BOOKS, '.covers')) : []
  check('封面目录里的文件都被 meta 引用（无孤儿封面）', coverFiles.every((f) => coverRefs.some((c) => c.endsWith(`/${f}`))), `${coverFiles.length} files / ${coverRefs.length} refs`)
  check('meta 的键与扫描清单一致（键 = relPath 口径）', (() => {
    const scanned = new Set(D.scanVaultBooks().map((b) => b.relPath))
    return Object.keys(metaAll.books).every((k) => scanned.has(k))
  })(), JSON.stringify(Object.keys(metaAll.books)))

  // ===== 收尾 =====
  out.checks = results
  out.summary = { total: results.length, pass: results.filter((x) => x.ok).length, fail: results.filter((x) => !x.ok).length }
  out.overall = pass ? 'PASS（S3 下载与上架契约全部成立）' : '需人工判读 —— 见 checks'
  // 凭据负向最后一道：**整个 stdout**（含所有 check 的 extra 与 JSON 留档）里一个标记值都不许有
  const stdoutText = CAPTURED.join('\n')
  check('★ 全量 stdout 里无凭据标记值', !stdoutText.includes('LEAK'), stdoutText.includes('LEAK') ? 'FOUND' : 'clean')
  out.checks = results
  out.summary = { total: results.length, pass: results.filter((x) => x.ok).length, fail: results.filter((x) => !x.ok).length }
  out.overall = pass ? 'PASS（S3 下载与上架契约全部成立）' : '需人工判读 —— 见 checks'

  console.log('\n========================================')
  console.log(pass ? `✅ S3 契约全部通过：${out.summary.pass}/${out.summary.total}` : `❌ ${out.summary.fail} 项 FAIL（另有 ${out.summary.pass} 项 PASS）`)
  console.log(`临时目录（留档，可人工复核）：${BASE}`)
  console.log(JSON.stringify(out, null, 2))
  try { writeFileSync(join(process.cwd(), 'tmp', 'book-market-s3-download.json'), JSON.stringify(out, null, 2)) } catch { /* 落盘不影响 stdout */ }

  try { win.destroy() } catch { /* ignore */ }
  await Promise.all([A.close(), B.close(), C.close(), Dd.close()])
  app.exit(pass ? 0 : 1)
})
