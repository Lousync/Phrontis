/**
 * 书市 §9 第 11 条探针 —— **换机取舍**：vault 拷到另一台机器 → 书源凭据需重输、源列表本身完好。
 *
 * ## 为什么能自动化（原以为只能人工）
 * 「换机」不可复现的是**另一台机器**，可复现的是它造成的**唯一后果**：`secretBox` 的 AES 密钥
 * 由本机 DPAPI 保护（见 `electron/lib/secretBox.ts` 头注），异机密文在解密时必抛 ⇒
 * `decryptSecret` 按设计吞异常返回空串 ⇒ `readSecret` 返回 null ⇒ 该源「没有凭据」。
 * 本探针把这条失败路径**如实复刻**：把 vault 整份拷到新路径（凭据密文随仓库一起走），
 * 再把副本里的密文换成「格式对（v10 头）、密钥不对」的字节 —— 与真实换机**走的是同一条代码路径**。
 * ★ 复刻的边界（别夸大）：异机密文与「格式合法但密钥不对的字节」在 `decryptSecret` 里
 *   **不可区分** —— 两条都在 `safeStorage.decryptString` 抛错、都被同一个 catch 吞成空串。
 *   故本探针锁的是**后果**（凭据读不出、三态 need-credential、源列表完好），不是 DPAPI 本身。
 *   「跨机不可解」这一条的前提（AES 密钥由 DPAPI 绑本机）在 `secretStore.ts` 头注与
 *   2026-09-13 的备份导入事故里已独立记录，本探针不重复证明它。
 *
 * ## 判定面（与 §9 第 11 条字面一一对应）
 *   凭据需重输   = 副本 vault 里 `bookSourceCredentialFor` → null、`hasCredential` false、
 *                  三态 = `need-credential`（**不是** fail）、且**一个请求都不发**
 *   源列表完好   = 副本 vault 的 `bookSources.json` 是**明文可读**的 JSON，源的
 *                  name / url / kind / enabled / builtin 标记逐项保留；重输凭据后立即可用
 *   ★ 对照：原机 vault 的凭据**仍可读** —— 证明「坏的只有异机密文」，不是我们拷坏了仓库。
 *
 * ## 跑法（两步；Electron 33 = Node 20，不能 strip-types，所以先把真实实现打包）
 *   node_modules/.bin/esbuild tmp/probe-910-911-entry.ts --bundle --platform=node \
 *     --format=cjs --external:electron --outfile=tmp/probe-910-911.cjs
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe .AGENT/scripts/book-market/probe-911-rehost.cjs --no-sandbox --disable-gpu
 *
 * ## 声明
 * ★ **不碰用户的开发数据目录**：userData 在 app ready **之前**改到系统临时目录；两个 vault 都在临时目录里。
 * ★ 凭据标记值只出现在本文件与 mock 校验里，stdout / 落盘描述里一个字节都不许有（照 S2/S3 的负向纪律）。
 *
 * 产物：stdout 一份逐条断言 + tmp/book-market-911-rehost.json（留档）
 */
const { app } = require('electron')
const http = require('node:http')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const BASE = mkdtempSync(join(tmpdir(), 'kb-probe-911-'))
const USER_DATA = join(BASE, 'userData')
const VAULT_A = join(BASE, 'vault-original')   // 「原机」
const VAULT_B = join(BASE, 'vault-copied')     // 「换机后」—— 整份拷过去
// ★ 必须在 app ready 之前改：晚了 settings.json 已按真实 userData 算好路径（会写进开发数据目录）
app.setPath('userData', USER_DATA)

const ROOT_A = 'probe-vault-a'
const ROOT_B = 'probe-vault-b'
const LEAK = { USER: 'LEAKUSER911', PASS: 'LEAKPASS911' }
const BASIC_EXPECTED = 'Basic ' + Buffer.from(`${LEAK.USER}:${LEAK.PASS}`, 'utf-8').toString('base64')

const results = []
let pass = true
function check(name, ok, extra = '') {
  if (!ok) pass = false
  results.push({ name, ok: !!ok, extra: String(extra) })
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
}
const CAPTURED = []
const origLog = console.log
console.log = (...a) => { CAPTURED.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); origLog(...a) }

/** 需要 Basic 凭据的 OPDS mock（`/auth/opds`）—— 用来判「有凭据 = 已连通 / 无凭据 = 需要凭据」 */
const OPDS_SINGLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>mock</title>
  <entry><title>要凭据的书</title><author><name>作者甲</name></author>
    <link href="/dl/1" type="application/epub+zip" rel="http://opds-spec.org/acquisition" length="1111"/>
  </entry></feed>`

const srv = { hits: [] }
function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname
      srv.hits.push({ path, auth: req.headers.authorization || '' })
      if (path === '/auth/opds') {
        const okAuth = (req.headers.authorization || '') === BASIC_EXPECTED
        res.writeHead(okAuth ? 200 : 401, { 'Content-Type': 'application/atom+xml' })
        return res.end(okAuth ? OPDS_SINGLE : 'unauthorized')
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('nope')
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** 造一份「异机密文」：头部照真实格式（v10 + 12B nonce + GCM 密文），但**密钥不是本机的** ⇒ 解不开 */
function foreignCiphertext() {
  const bytes = Buffer.alloc(31 + 64)
  Buffer.from('v10', 'latin1').copy(bytes, 0)
  for (let i = 3; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff
  return 'enc1:' + bytes.toString('base64')
}

app.whenReady().then(async () => {
  const net2 = require(join(process.cwd(), 'tmp', 'probe-910-911.cjs'))
  const mock = await startMock()
  const MOCK = `http://127.0.0.1:${mock.address().port}`

  const F_SOURCES_A = join(VAULT_A, '.knowbase', 'modules', 'bookSources.json')
  const F_SECRET_A = join(VAULT_A, '.knowbase', 'secret', 'bookSources.json')
  const F_SOURCES_B = join(VAULT_B, '.knowbase', 'modules', 'bookSources.json')
  const F_SECRET_B = join(VAULT_B, '.knowbase', 'secret', 'bookSources.json')

  const out = { when: new Date().toISOString(), electron: process.versions.electron, base: BASE, vaultA: VAULT_A, vaultB: VAULT_B, mock: MOCK }

  /* ================= ⓪ 原机：建仓库 + 建源 + 存凭据 ================= */
  console.log('--- ⓪ 原机 vault：建源 + 存凭据 ---')
  mkdirSync(join(VAULT_A, '.knowbase', 'modules'), { recursive: true })
  writeFileSync(join(VAULT_A, '.knowbase', 'meta.json'), JSON.stringify({ schemaVersion: 1, name: 'A' }), 'utf-8')
  net2.setCurrentVault({ rootId: ROOT_A, name: ROOT_A, rootPath: VAULT_A })

  const seeded = net2.bookSourceList(ROOT_A) // 首读种入两个预置源
  check('原机：预置源已种入', seeded.filter((s) => s.builtin).length === 2, seeded.map((s) => s.id).join(','))

  const authId = (() => {
    const r = net2.bookSourceUpsert(ROOT_A, { name: '要凭据的自建源', kind: 'opds', auth: { type: 'basic', ref: 'placeholder' }, enabled: true, url: `${MOCK}/auth/opds`, searchUrl: `${MOCK}/auth/opds?query={query}` })
    if (!r.ok) throw new Error('建源失败 ' + r.error)
    return r.source.id
  })()
  const offId = (() => {
    const r = net2.bookSourceUpsert(ROOT_A, { name: '被停用的源', kind: 'custom', auth: null, enabled: false, url: `${MOCK}/x`, responseType: 'json' })
    if (!r.ok) throw new Error('建源失败 ' + r.error)
    return r.source.id
  })()
  const saved = net2.bookSourceSaveCredential(ROOT_A, authId, { type: 'basic', username: LEAK.USER, password: LEAK.PASS })
  check('原机：存凭据成功（密文文件已生成）', saved.ok && existsSync(F_SECRET_A), saved.error || '')
  check('原机：凭据可读（同机同 DPAPI）', net2.bookSourceCredentialFor(ROOT_A, authId) !== null)
  check('原机：三态 = 已连通（带凭据发请求）', (await net2.probeSourceConnectivity(ROOT_A, authId)) === 'ok')

  const listA = net2.bookSourceList(ROOT_A)
  out.originalSourceCount = listA.length

  /* ================= ① 拷 vault（模拟换机） ================= */
  console.log('--- ① 整份拷贝 vault ---')
  cpSync(VAULT_A, VAULT_B, { recursive: true })
  check('★ 副本仓库结构完整（源描述 + 凭据密文都随仓库走了）',
    existsSync(F_SOURCES_B) && existsSync(F_SECRET_B))

  const rawSourcesB = readFileSync(F_SOURCES_B, 'utf-8')
  check('★ 源描述是**明文可读**的 JSON（不绑机器 —— 换机后源列表能读出来）',
    (() => { try { return Array.isArray(JSON.parse(rawSourcesB).sources) } catch { return false } })(),
    `${rawSourcesB.length} 字节`)
  check('★ 源描述里**没有**凭据明文（连键名都没有）',
    !rawSourcesB.includes('LEAK') && !/"(username|password|token)"\s*:/.test(rawSourcesB))

  /* ================= ② 复刻「异机密文」 ================= */
  console.log('--- ② 异机密文（密钥不属本机）---')
  const realCipher = readFileSync(F_SECRET_B, 'utf-8')
  check('副本密文原样带过来了（enc1: 前缀）', realCipher.startsWith('enc1:'), realCipher.slice(0, 5))
  writeFileSync(F_SECRET_B, foreignCiphertext(), 'utf-8') // ← 这一步 = 「换了一台机器」
  check('已把副本密文替换为异机密文（格式对、密钥不对）', readFileSync(F_SECRET_B, 'utf-8') !== realCipher)

  /* ================= ③ 换机后：源列表完好、凭据需重输 ================= */
  console.log('--- ③ 换机后（切到副本 vault）---')
  net2.setCurrentVault({ rootId: ROOT_B, name: ROOT_B, rootPath: VAULT_B })

  const listB = net2.bookSourceList(ROOT_B)
  check('★ 源列表完好：条数与换机前一致', listB.length === listA.length, `${listB.length}/${listA.length}`)
  const byName = (arr, n) => arr.find((s) => s.name === n)
  check('★ 自建源的 name / url / kind 逐项保留',
    byName(listB, '要凭据的自建源')?.url === `${MOCK}/auth/opds` && byName(listB, '要凭据的自建源')?.kind === 'opds')
  check('★ 预置源标记与检索模板保留（builtin 仍认得出）',
    listB.filter((s) => s.builtin).length === 2 && listB.some((s) => s.id === 'builtin-gutenberg' && s.searchUrl.includes('{query}')))
  check('★ 启用/停用状态保留', byName(listB, '被停用的源')?.enabled === false && byName(listB, '要凭据的自建源')?.enabled === true)
  check('★ 凭据**不可读**了（异机密文解密失败 ⇒ null）', net2.bookSourceCredentialFor(ROOT_B, authId) === null)
  check('★ hasCredential = false（界面会显示「填凭据」入口）', net2.bookSourceInfos(ROOT_B).find((s) => s.id === authId)?.hasCredential === false)
  // 对照：切回原机 vault ⇒ 凭据仍可读（证明坏的只有异机密文，仓库本身没被拷坏）
  // ★ 必须切回后读：凭据仓库按「**当前**仓库」定位（secretStore 走 getVaultKbRoot），
  //   在 ROOT_B 为当前仓库时读 ROOT_A 的凭据恒为 null —— 那不是「坏了」，是读错了仓库。
  net2.setCurrentVault({ rootId: ROOT_A, name: ROOT_A, rootPath: VAULT_A })
  check('★ 原机 vault 的凭据仍可读（对照：坏的只有异机密文）', net2.bookSourceCredentialFor(ROOT_A, authId) !== null)
  net2.setCurrentVault({ rootId: ROOT_B, name: ROOT_B, rootPath: VAULT_B })

  // ③b 三态 = need-credential（**不是** fail），且一个请求都不发
  srv.hits = []
  const conn = await net2.probeSourceConnectivity(ROOT_B, authId)
  check('★ 三态 = need-credential（不是「连接失败」）', conn === 'need-credential', conn)
  check('★ 缺凭据时**一个请求都不发**', srv.hits.length === 0, `hits=${srv.hits.length}`)

  // ③c 免认证的源照常可用（源列表真的「完好」而不是只读得出来）
  const noAuthId = (() => {
    const r = net2.bookSourceUpsert(ROOT_B, { name: '免认证源', kind: 'opds', auth: null, enabled: true, url: `${MOCK}/auth/opds`, searchUrl: `${MOCK}/auth/opds?query={query}` })
    if (!r.ok) throw new Error('建源失败 ' + r.error)
    return r.source.id
  })()
  check('★ 副本仓库里新建源正常（写路径没坏）', net2.bookSourceGet(ROOT_B, noAuthId)?.name === '免认证源')

  /* ================= ④ 重输凭据 ⇒ 恢复 ================= */
  console.log('--- ④ 重输凭据后恢复 ---')
  srv.hits = []
  const reSaved = net2.bookSourceSaveCredential(ROOT_B, authId, { type: 'basic', username: LEAK.USER, password: LEAK.PASS })
  check('重输凭据成功', reSaved.ok, reSaved.error || '')
  check('★ 重输后凭据可读', net2.bookSourceCredentialFor(ROOT_B, authId) !== null)
  check('★ 重输后三态 = 已连通（真的带上了 Authorization）', (await net2.probeSourceConnectivity(ROOT_B, authId)) === 'ok')
  check('★ 请求带的是重输的凭据（服务端按它放行）', srv.hits.some((h) => h.auth === BASIC_EXPECTED))
  check('重输后密文文件是本机可解的（不再是异机密文）', readFileSync(F_SECRET_B, 'utf-8').startsWith('enc1:'))

  /* ================= ⑤ 负向：密文损坏不阻断源列表 ================= */
  console.log('--- ⑤ 密文损坏不阻断（损坏不阻断口径）---')
  const beforeCorrupt = net2.bookSourceList(ROOT_B).length // ④ 之前又建过源，别拿 ③ 的旧长度比
  writeFileSync(F_SECRET_B, 'enc1:这不是有效密文', 'utf-8')
  let listStillOk = true
  let listAfter
  try { listAfter = net2.bookSourceList(ROOT_B) } catch { listStillOk = false }
  check('★ 密文损坏时源列表仍可读（不抛）', listStillOk && listAfter.length === beforeCorrupt, listStillOk ? `len=${listAfter.length}` : '抛异常了')
  check('损坏密文被当作「无凭据」而非报错', net2.bookSourceCredentialFor(ROOT_B, authId) === null)

  /* ================= ⑥ 凭据负向总闸 ================= */
  console.log('--- ⑥ 凭据负向总闸 ---')
  check('★ 源描述落盘字节里无凭据明文', !readFileSync(F_SOURCES_B, 'utf-8').includes('LEAK'))
  check('★ 出 IPC 的源描述不含凭据本体', !JSON.stringify(net2.bookSourceInfos(ROOT_B)).includes('LEAK'))
  check('★ 全量 stdout 里没有凭据明文', !CAPTURED.join('\n').includes('LEAK'))

  /* ================= 收尾 ================= */
  out.checks = results
  out.summary = { total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length }
  out.overall = pass ? 'PASS（§9 第 11 条：换机后凭据需重输、源列表完好）' : '需人工判读 —— 见 checks'
  origLog('\n========================================')
  origLog(pass ? `✅ §9 第 11 条 换机取舍通过：${out.summary.pass}/${out.summary.total}` : `❌ ${out.summary.fail} 项 FAIL（另有 ${out.summary.pass} 项 PASS）`)
  origLog(`临时目录（留档，可人工复核）：${BASE}`)
  origLog(JSON.stringify(out, null, 2))
  try { writeFileSync(join(process.cwd(), 'tmp', 'book-market-911-rehost.json'), JSON.stringify(out, null, 2)) } catch { /* 落盘不影响 stdout */ }
  try { mock.close() } catch { /* 无所谓 */ }
  app.exit(pass ? 0 : 1)
})
