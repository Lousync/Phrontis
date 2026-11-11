#!/usr/bin/env node
/**
 * 契约验证：手机伴侣同步协议 v1.1（phoneCompanion）。
 *
 * 为什么需要它：这一层的失败模式全是「两端各自认为对、连起来才发现错」——
 * 配对码一次性语义、LWW 合并方向、CORS 预检、拉取游标、分域路由、墓碑删除，
 * 任何一环错了表象都只是「手机上点同步没反应」，桌面上没有任何报错。
 *
 * 验证方式：不启 Electron，直接以内存依赖驱动 createCompanionServer（与生产同一份代码），
 * 打真 HTTP 请求过完整链路：
 *   §1 协议纯函数（校验 / 规范化 / LWW 裁决 / schedule 负载 / 墓碑判定）
 *   §2 配对（配对码一次性 / 过期 / 设备落库 / 限频外语义）
 *   §3 鉴权（无令牌 / 错令牌 / 对令牌）
 *   §4 同步（新条目并入 / 旧更新冲突 / 新更新覆盖 / 非法负载 / 未支持域 / 拉取与游标）
 *   §4b schedule 域（合法并入 / 非法负载 / LWW / 拉取）
 *   §4c 墓碑（上行删除 / 幂等 / 旧删除拒收回 conflict / pull 按时间过滤）
 *   §4d notes 域与内容 API（v1.2 上行 + tree/content）
 *   §4e 笔记 U 盘模式（v1.6 纯函数 + push LWW + pull 三域 + 兼容矩阵）
 *   §8 实时长轮询（v1.7 wait / waitSupported / pokeSync / 顶掉 / 断连清理）
 *   §5 CORS（预检 204 + 放行 authorization）
 *   §6 协议文档契约（design.md §2.1 与端点常量一致）
 *   §9 组播发现应答器（UDP 发现：与手机端 Java 常量对表 / ping 应答构型 / 非 ping 不应答 / stop 生效 / 入参跟随）
 *   §10 地址推荐与状态视图（WP1/WP7：orderLanAddresses 排序 / urls 不嵌过期码 / 过期请求过滤 /
 *        /api/unpair 双向解除 / revokeDevice 运行中失效 / onClientSeen 来源上报）
 *   §11 文件通道 v1（iPad 交接 / 批注回传：命名 / 过滤 / 魔数 / tree / content / upload /
 *        重名不覆盖 / 413 / 415 / 中断清理 / 符号链接逃逸 / features 能力位）
 *   §12 lanShare 公共 multipart 解析器回归（抽取核心后收件箱命名行为不变）
 *
 * 运行（主仓根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/phone-companion/verify-companion-protocol.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import http from 'node:http'

import { createCompanionServer } from '../../../electron/lib/phoneCompanion/server.ts'
import {
  SYNC_DOMAINS, PROTOCOL_VERSION, DEFAULT_PORT, PULL_WAIT_CAP_MS, COMPANION_FEATURES,
  normalizeLedgerData, normalizeScheduleData, normalizeNoteData, isTombstoneData,
  normalizeHabitData, normalizeHabitRecordData, habitRecordId, parseHabitRecordId,
  shouldApplyIncoming, buildPairUrl, parsePairInput, pairingCapabilities,
} from '../../../electron/lib/phoneCompanion/protocol.ts'
import {
  ANNOTATED_DIR, MAX_PDF_UPLOAD_BYTES,
  annotatedPdfName, pickAnnotatedPdfName, isPdfMagic, isHandoffPdfPage, listHandoffPdfs,
  resolvePdfAbs, saveAnnotatedPdfUpload,
} from '../../../electron/lib/phoneCompanion/fileTransfer.ts'
import { parseMultipartUpload } from '../../../electron/lib/lanShare/multipart.ts'
import {
  sanitizeNoteStem, deviceFolderName, pickNoteFileName, parseNoteFrontmatter,
  bumpNoteFrontmatterUpdated, notePushDecision, isMobileNotesRel,
} from '../../../electron/lib/phoneCompanion/notesUsb.ts'
import {
  startDiscoverResponder, stopDiscoverResponder, DISCOVER_GROUPS, DISCOVER_PORT, DISCOVER_PING,
} from '../../../electron/lib/phoneCompanion/discover.ts'
import { orderLanAddresses, isVirtualIface, ipv4Prefix24 } from '../../../electron/lib/lanShare/addresses.ts'
import { buildStatusView } from '../../../electron/lib/phoneCompanion/statusView.ts'
import dgram from 'node:dgram'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
// 手机仓目录名大小写跨机不一致（Windows 不敏感 / Linux 敏感）：双拼写探测
const DESIGN_CANDIDATES = ['Phrontis-mobile', 'phrontis-mobile'].map((d) => join(ROOT, '..', d, 'docs', 'design.md'))
const DESIGN_FILE = DESIGN_CANDIDATES.find((p) => { try { return statSync(p).isFile() } catch { return false } }) ?? DESIGN_CANDIDATES[0]
const JAVA_CANDIDATES = ['Phrontis-mobile', 'phrontis-mobile'].map((d) =>
  join(ROOT, '..', d, 'android', 'app', 'src', 'main', 'java', 'com', 'lousync', 'phrontis', 'PhrontisDiscover.java'))
const JAVA_FILE = JAVA_CANDIDATES.find((p) => { try { return statSync(p).isFile() } catch { return false } }) ?? JAVA_CANDIDATES[0]

let failures = 0
let checks = 0
const ok = (m) => console.log('  [OK] ' + m)
const bad = (m) => { failures++; console.error('  [FAIL] ' + m) }
const check = (m, cond, detail) => { checks++; cond ? ok(m) : bad(detail ? m + ' —— ' + detail : m) }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const CODE = '12345678'

/** 内存依赖 + 起一只真服务器；返回 { port, url, setCode, store, scheduleStore, tombstones } */
async function boot({ code = CODE, expiresAt = Date.now() + 60_000, pairRequest = true, filesRoot = null, pdfPages = [], pdfMaxBytes = 0 } = {}) {
  let devices = []
  const pairRequests = [] // v1.5：{ view, approve, reject }（模拟渲染层确认框留下的手柄）
  const store = new Map() // id -> { id, updatedAt, data }（ledger）
  const scheduleStore = new Map() // id -> { id, updatedAt, data }（schedule）
  const notesStore = new Map() // id -> { id, updatedAt, data }（notes）
  const habitStore = new Map() // id -> { id, updatedAt, data }（habit 定义）
  const habitRecordStore = new Map() // id -> { id, updatedAt, data }（habit 记录，id=hr:...）
  const notesPulls = [] // v1.6：listNotesSince 调用记录 { device, sinceMs }
  let notesPullChanges = [] // v1.6：下一次 pull 的 changes.notes 注入值
  const noteTree = [
    { id: 'p-1', title: 'AI教学模块笔记', path: '学习/AI教学模块笔记.md', categoryId: 'c1', mtimeMs: 1730419200000, sizeBytes: 100 },
  ]
  const tombstones = [] // { domain, id, deletedAt }
  const clientSeens = [] // §10：onClientSeen 来源 IP 上报记录（discover / pair/request / ping）
  let pairCode = code ? { code, expiresAt } : null
  /** 2026-11-09：无仓 fail-closed 契约开关（pull 409 / push reason:'no-vault'） */
  let hasVault = true
  const upsert = (dom, map, item) => {
    // 与生产 repo 同规则：已墓碑的 id 收到不早于墓碑的 upsert → 拒绝复活（vaultScheduleSyncUpsert / vaultAccountingSyncUpsert 内同款）
    const ts = tombstones.find(t => t.domain === dom && t.id === item.id)
    if (ts && !(item.updatedAt > ts.deletedAt)) return { applied: false, reason: 'tombstoned' }
    const cur = map.get(item.id)
    if (cur && !(item.updatedAt > cur.updatedAt)) return { applied: false, conflict: true, reason: 'server-newer' }
    map.set(item.id, item)
    return { applied: true }
  }
  const server = createCompanionServer({
    loadDevices: () => devices,
    saveDevices: (l) => { devices = l.slice() },
    hasVault: () => hasVault,
    getPairCode: () => pairCode,
    consumePairCode: () => { pairCode = null },
    applyLedger: (item) => upsert('ledger', store, item),
    applySchedule: (item) => upsert('schedule', scheduleStore, item),
    // v1.6：mock 与生产同规则做 LWW（同刻桌面赢 → conflict，手机以服务端版本收敛）
    applyNote: (item) => upsert('notes', notesStore, item),
    applyHabit: (item) => item.data.kind === 'habit' ? upsert('habit', habitStore, item) : upsert('habit', habitRecordStore, item),
    applyDelete: (domain, id, deletedAt) => {
      if (domain === 'habit') {
        if (String(id).startsWith('hr:')) {
          const cur = habitRecordStore.get(id)
          if (cur && !(deletedAt > cur.updatedAt)) return { applied: false, conflict: true, reason: 'server-newer' }
          habitRecordStore.delete(id)
          tombstones.push({ domain, id, deletedAt })
          return { applied: true }
        }
        const cur = habitStore.get(id)
        if (cur && !(deletedAt > cur.updatedAt)) return { applied: false, conflict: true, reason: 'server-newer' }
        habitStore.delete(id)
        for (const [rid, r] of [...habitRecordStore]) {
          if (r.data.habitId === id) { habitRecordStore.delete(rid); tombstones.push({ domain, id: rid, deletedAt }) }
        }
        tombstones.push({ domain, id, deletedAt })
        return { applied: true }
      }
      // v1.6：notes 墓碑同样合法（手机清空标题保存 = 删除）——三分域统一走本 mock
      const map = domain === 'schedule' ? scheduleStore : domain === 'notes' ? notesStore : store
      const cur = map.get(id)
      if (cur && !(deletedAt > cur.updatedAt)) return { applied: false, conflict: true, reason: 'server-newer' }
      map.delete(id)
      const i = tombstones.findIndex(t => t.domain === domain && t.id === id)
      if (i >= 0) tombstones.splice(i, 1)
      tombstones.push({ domain, id, deletedAt })
      return { applied: true }
    },
    listLedgerSince: (sinceMs) => [...store.values()].filter(x => Date.parse(x.updatedAt) > sinceMs),
    listScheduleSince: (sinceMs) => [...scheduleStore.values()].filter(x => Date.parse(x.updatedAt) > sinceMs),
    listHabitChangesSince: (sinceMs) => [...habitStore.values(), ...habitRecordStore.values()].filter(x => Date.parse(x.updatedAt) > sinceMs),
    listNotesSince: (device, sinceMs) => {
      notesPulls.push({ device, sinceMs })
      return notesPullChanges
    },
    listTombstonesSince: (sinceMs) => tombstones.filter(t => Date.parse(t.deletedAt) > sinceMs),
    listNoteTree: () => noteTree,
    readNoteContent: (id) => id === 'p-1'
      ? { title: 'AI教学模块笔记', updatedAt: '2026-11-01T00:00:00.000Z', body: '# AI教学模块笔记\n\n正文', truncated: undefined }
      : null,
    // §11 文件通道：用真实 fs 触达层（临时 vault），路由与实现一起测
    listPdfFiles: () => (filesRoot ? listHandoffPdfs(pdfPages) : []),
    openPdfFile: (id) => {
      const page = filesRoot ? pdfPages.find(p => p.id === id) : null
      if (!page || !isHandoffPdfPage(page)) return { ok: false, status: 404 }
      const absPath = resolvePdfAbs(filesRoot, page.path)
      if (!absPath) return { ok: false, status: 403 }
      try {
        return { ok: true, absPath, name: page.path.split('/').pop(), size: statSync(absPath).size }
      } catch {
        return { ok: false, status: 404 }
      }
    },
    savePdfUpload: async (req) => {
      if (!filesRoot) return { ok: false, status: 409, error: '电脑端尚未打开仓库' }
      try {
        const file = await saveAnnotatedPdfUpload(filesRoot, req, pdfMaxBytes ? { maxBytes: pdfMaxBytes } : undefined)
        return { ok: true, file }
      } catch (e) {
        return { ok: false, status: e?.status ?? 500, error: e?.message ?? '上传处理失败' }
      }
    },
    pcName: () => 'TEST-PC',
    onClientSeen: (ip) => { clientSeens.push(ip) },
    ...(pairRequest ? { onPairRequest: (view, handlers) => pairRequests.push({ view, approve: handlers.approve, reject: handlers.reject }) } : {}),
  })
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res) })
  const port = server.address().port
  return {
    port,
    server,
    base: 'http://127.0.0.1:' + port,
    store,
    scheduleStore,
    notesStore,
    habitStore,
    habitRecordStore,
    notesPulls,
    clientSeens,
    setNotesPullChanges: (v) => { notesPullChanges = v },
    tombstones,
    devices: () => devices,
    pairRequests,
    setCode: (c) => { pairCode = c },
    setHasVault: (v) => { hasVault = !!v },
    post: (path, body, headers) => fetch('http://127.0.0.1:' + port + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
    }),
    get: (path, headers) => fetch('http://127.0.0.1:' + port + path, { headers: headers || {} }),
    close: () => new Promise(res => { server.closeAllConnections(); server.close(res) }),
  }
}

const iso = (ms) => new Date(ms).toISOString()
const t0 = Date.parse('2026-10-31T08:00:00.000Z')

/* ------------------------------------------------------------------ §1 */
console.log('\n§1 协议纯函数（校验 / 规范化 / LWW 裁决）')

const good = normalizeLedgerData({ date: '2026-10-31', time: '12:34', type: 'expense', amount: 30, category: '餐饮', payment: '微信', merchant: '午饭', note: '' })
check('合法负载通过校验', !!good && good.amount === 30 && good.type === 'expense' && good.category === '餐饮')
check('缺分类回落「其他」', normalizeLedgerData({ date: '2026-10-31', type: 'income', amount: 5 })?.category === '其他')
check('金额四舍五入到分', normalizeLedgerData({ date: '2026-10-31', type: 'expense', amount: 10.005 })?.amount === 10.01)
check('坏 type 拒绝', normalizeLedgerData({ date: '2026-10-31', type: 'transfer', amount: 5 }) === null, 'v1 转账不上行')
check('金额 <= 0 拒绝', normalizeLedgerData({ date: '2026-10-31', type: 'expense', amount: 0 }) === null)
check('缺日期拒绝', normalizeLedgerData({ type: 'expense', amount: 5 }) === null)

check('LWW：incoming 新 → 应用', shouldApplyIncoming(iso(t0), iso(t0 + 1)) === true)
check('LWW：incoming 旧 → 不应用', shouldApplyIncoming(iso(t0), iso(t0 - 1)) === false)
check('LWW：相同 → 桌面赢（不应用）', shouldApplyIncoming(iso(t0), iso(t0)) === false)

check('配对链接拼装', buildPairUrl('192.168.1.5', 8770, '12345678') === 'http://192.168.1.5:8770/pair#12345678')
check('手机解析：整条链接', eq(parsePairInput('http://192.168.1.5:8770/pair#12345678', ''), { host: '192.168.1.5:8770', code: '12345678' }))
check('手机解析：host + 码分开填', eq(parsePairInput('192.168.1.5:8770', '87654321'), { host: '192.168.1.5:8770', code: '87654321' }))
check('手机解析：https 头与路径可带', eq(parsePairInput('https://192.168.1.5:8770/', '87654321'), { host: '192.168.1.5:8770', code: '87654321' }))
check('手机解析：无端口拒绝', parsePairInput('192.168.1.5', '12345678') === null)
check('手机解析：两处都没有码拒绝', parsePairInput('192.168.1.5:8770', '') === null)

const sched = { date: '2026-11-01', title: '写周报', type: 'deadline', time: '09:30', done: false, parentId: null, schedStart: 570, schedEnd: 610 }
const goodSched = normalizeScheduleData(sched)
check('schedule 合法负载通过校验', !!goodSched && goodSched.title === '写周报' && goodSched.schedStart === 570)
check('schedule 缺标题拒绝', normalizeScheduleData({ ...sched, title: '  ' }) === null)
check('schedule 坏 type 拒绝', normalizeScheduleData({ ...sched, type: 'habit' }) === null)
check('schedule 缺日期拒绝', normalizeScheduleData({ ...sched, date: '11-01' }) === null)
check('schedule 排期越界回落 null', normalizeScheduleData({ ...sched, schedStart: 9999 })?.schedStart === null)
check('schedule 空串排期视为未排期', normalizeScheduleData({ ...sched, schedStart: '', schedEnd: null })?.schedStart === null)
check('schedule parentId 规范化', normalizeScheduleData({ ...sched, parentId: '  ' })?.parentId === null)

check('墓碑判定：{deleted:true} 是删除', isTombstoneData({ deleted: true }) === true)
check('墓碑判定：普通负载不是删除', isTombstoneData({ date: '2026-11-01' }) === false)
check('墓碑判定：null / 数组不是删除', isTombstoneData(null) === false && isTombstoneData([1]) === false)

check('notes 合法负载（仅正文无标题）通过', eq(normalizeNoteData({ title: '', body: '想到什么记什么' }), { title: '', body: '想到什么记什么' }))
check('notes 标题截 120、正文截 10 万', normalizeNoteData({ title: 'x'.repeat(200), body: 'y'.repeat(200000) }).body.length === 100000)
check('notes 标题与正文都空拒绝', normalizeNoteData({ title: '  ', body: '  ' }) === null)
check('notes 非对象拒绝', normalizeNoteData('md') === null)

/* ------------------------------------------------------------------ §2 */
console.log('\n§2 配对（配对码一次性 / 过期 / 设备落库）')
{
  const s = await boot()
  const wrong = await s.post('/api/pair', { code: '00000000', deviceName: '测试机' })
  check('错码 401', wrong.status === 401)
  check('错码不落设备', s.devices().length === 0)

  const good1 = await s.post('/api/pair', { code: CODE, deviceName: '测试机' })
  const body1 = await good1.json()
  check('对码 200 且返回令牌', good1.status === 200 && typeof body1.deviceToken === 'string' && body1.deviceToken.length > 10)
  check('协议版本与域清单', body1.protocol === PROTOCOL_VERSION && eq(body1.domains, [...SYNC_DOMAINS]) && body1.pc.name === 'TEST-PC')
  check('设备落库（含令牌与名字）', s.devices().length === 1 && s.devices()[0].name === '测试机' && !!s.devices()[0].token)

  const again = await s.post('/api/pair', { code: CODE, deviceName: '第二台' })
  check('配对码一次性：用后即作废', again.status === 401 && s.devices().length === 1)
  await s.close()
}
{
  const s = await boot({ code: CODE, expiresAt: Date.now() - 1000 })
  const expired = await s.post('/api/pair', { code: CODE, deviceName: '测试机' })
  check('过期码 401', expired.status === 401)
  const noCode = await boot({ code: null })
  const nc = await noCode.post('/api/pair', { code: CODE, deviceName: '测试机' })
  check('未出示配对码 401', nc.status === 401)
  await s.close(); await noCode.close()
}

/* ------------------------------------------------------------------ §2b */
console.log('\n§2b 配对握手 v1.5（发现 / 请求 / 双屏 4 位码 / 桌面确认 / 拒绝）')

{
  const s = await boot()
  try {
    const d = await (await s.get('/api/discover')).json()
    check('发现端点回电脑名与协议版本', d.ok === true && d.pc.name === 'TEST-PC' && d.protocol === 1)
    check('发现端点声明支持请求式配对', Array.isArray(d.pairing) && d.pairing.includes('request'))

    const r1 = await (await s.post('/api/pair/request', { deviceName: '志岩的手机' })).json()
    check('发起请求回 requestId 与 4 位码', r1.ok === true && typeof r1.requestId === 'string' && /^\d{4}$/.test(r1.code))
    check('请求进入待确认列表（确认框数据源）', s.pairRequests.length === 1 && s.pairRequests[0].view.deviceName === '志岩的手机')
    check('请求记录来源 IP', s.pairRequests[0].view.ip === '127.0.0.1')

    const st1 = await (await s.get('/api/pair/status?id=' + r1.requestId)).json()
    check('未确认前 pending 且不发令牌', st1.status === 'pending' && !st1.deviceToken)

    const ap = s.pairRequests[0].approve()
    check('桌面点允许 → 发令牌成功', ap.ok === true)
    const st2 = await (await s.get('/api/pair/status?id=' + r1.requestId)).json()
    check('确认后 approved 并回令牌与电脑名',
      st2.status === 'approved' && typeof st2.deviceToken === 'string' && st2.deviceToken.length > 20 && st2.pc.name === 'TEST-PC')
    check('设备落库且名字来自请求', s.devices().length === 1 && s.devices()[0].name === '志岩的手机')

    const ping = await s.get('/api/ping', { authorization: 'Bearer ' + st2.deviceToken })
    check('新令牌可直接打 ping', ping.status === 200)

    const r2 = await (await s.post('/api/pair/request', { deviceName: '同网陌生人' })).json()
    s.pairRequests[1].reject()
    const st3 = await (await s.get('/api/pair/status?id=' + r2.requestId)).json()
    check('拒绝后 rejected 且不发令牌', st3.status === 'rejected' && !st3.deviceToken)
    check('被拒设备不落库', s.devices().length === 1)
    check('同一请求二次处理被拒', s.pairRequests[1].approve().ok === false)

    const st404 = await s.get('/api/pair/status?id=nope')
    check('未知请求 id → 404', st404.status === 404)
  } finally { await s.close() }
}

{
  const s = await boot({ pairRequest: false })
  try {
    const r = await s.post('/api/pair/request', { deviceName: 'x' })
    check('电脑未接确认框 → 501（旧客户端继续走配对码）', r.status === 501)
    const d = await (await s.get('/api/discover')).json()
    check('未接确认框时 discover 只声明 code', Array.isArray(d.pairing) && d.pairing.length === 1 && d.pairing[0] === 'code')
  } finally { await s.close() }
}

/* ------------------------------------------------------------------ §3 */
console.log('\n§3 鉴权（无令牌 / 错令牌 / 对令牌）')
{
  const s = await boot()
  const pair = await (await s.post('/api/pair', { code: CODE, deviceName: '测试机' })).json()
  const token = pair.deviceToken

  const bare = await s.get('/api/ping')
  check('无令牌 401', bare.status === 401)
  const wrong = await s.get('/api/ping', { authorization: 'Bearer garbage' })
  check('错令牌 401', wrong.status === 401)
  const right = await s.get('/api/ping', { authorization: 'Bearer ' + token })
  const rightBody = await right.json()
  check('对令牌 200 且带协议版本', right.status === 200 && rightBody.ok === true && rightBody.protocol === PROTOCOL_VERSION)
  await s.close()
}

/* ------------------------------------------------------------------ §4 */
console.log('\n§4 同步（并入 / 冲突 / 覆盖 / 非法 / 未支持域 / 拉取游标）')
{
  const s = await boot()
  const token = (await (await s.post('/api/pair', { code: CODE, deviceName: '测试机' })).json()).deviceToken
  const auth = { authorization: 'Bearer ' + token }
  const push = (changes) => s.post('/api/sync/push', { deviceId: 'd1', changes }, auth)

  const r1 = await (await push([{ domain: 'ledger', id: 'tx-a', updatedAt: iso(t0), data: { date: '2026-10-31', time: '12:00', type: 'expense', amount: 30, category: '餐饮', payment: '微信', merchant: '午饭', note: '' } }])).json()
  check('新条目 applied', r1.results[0].applied === true && s.store.has('tx-a'))

  const r2 = await (await push([{ domain: 'ledger', id: 'tx-a', updatedAt: iso(t0 - 5000), data: { date: '2026-10-31', time: '11:00', type: 'expense', amount: 99, category: '餐饮', payment: '微信', merchant: '旧更新', note: '' } }])).json()
  check('旧更新 conflict 不应用', r2.results[0].applied === false && r2.results[0].conflict === true && r2.results[0].reason === 'server-newer')
  check('服务端数据未被旧更新覆盖', s.store.get('tx-a').data.merchant === '午饭')

  const r3 = await (await push([{ domain: 'ledger', id: 'tx-a', updatedAt: iso(t0 + 5000), data: { date: '2026-10-31', time: '13:00', type: 'expense', amount: 31, category: '餐饮', payment: '微信', merchant: '新更新', note: '' } }])).json()
  check('新更新覆盖 applied', r3.results[0].applied === true && s.store.get('tx-a').data.merchant === '新更新')

  const r4 = await (await push([{ domain: 'ledger', id: 'tx-b', updatedAt: iso(t0), data: { date: '2026-10-31', type: 'expense', amount: -3 } }])).json()
  check('非法负载 invalid-data', r4.results[0].applied === false && r4.results[0].reason === 'invalid-data' && !s.store.has('tx-b'))

  const r5 = await (await push([{ domain: 'habits', id: 'h-1', updatedAt: iso(t0), data: { name: 'x' } }])).json()
  check('未支持域 unsupported-domain（留在队列的依据）', r5.results[0].applied === false && r5.results[0].reason === 'unsupported-domain')

  const r6 = await (await push([{ domain: 'ledger', updatedAt: iso(t0), data: { date: '2026-10-31', type: 'expense', amount: 5 } }])).json()
  check('缺 id invalid-change', r6.results[0].applied === false && r6.results[0].reason === 'invalid-change')

  const pull1 = await (await s.post('/api/sync/pull', { since: { ledger: 0 } }, auth)).json()
  check('全量拉取含已并入条目', pull1.changes.ledger.length === 1 && pull1.changes.ledger[0].id === 'tx-a')
  check('游标返回（push 后 phone 据此推进）', typeof pull1.cursor.ledger === 'number')
  const pull2 = await (await s.post('/api/sync/pull', { since: { ledger: Date.now() + 5000 } }, auth)).json()
  check('since 之后无新增 → 空增量', pull2.changes.ledger.length === 0)
  await s.close()
}

/* ------------------------------------------------------------------ §4b */
console.log('\n§4b schedule 域（合法并入 / 非法负载 / LWW / 拉取）')
{
  const s = await boot()
  const token = (await (await s.post('/api/pair', { code: CODE, deviceName: '测试机' })).json()).deviceToken
  const auth = { authorization: 'Bearer ' + token }
  const push = (changes) => s.post('/api/sync/push', { deviceId: 'd1', changes }, auth)

  const schedData = { date: '2026-11-02', title: '写周报', type: 'deadline', time: '09:30', done: false, parentId: null, schedStart: 570, schedEnd: 610 }
  const s1 = await (await push([{ domain: 'schedule', id: 'td-a', updatedAt: iso(t0), data: schedData }])).json()
  check('schedule 新条目 applied', s1.results[0].applied === true && s.scheduleStore.has('td-a'))
  check('schedule 负载原样入存储', s.scheduleStore.get('td-a').data.title === '写周报' && s.scheduleStore.get('td-a').data.schedStart === 570)

  const s2 = await (await push([{ domain: 'schedule', id: 'td-a', updatedAt: iso(t0 - 5000), data: { ...schedData, title: '旧更新' } }])).json()
  check('schedule 旧更新 conflict 不应用', s2.results[0].applied === false && s2.results[0].conflict === true && s2.results[0].reason === 'server-newer')
  check('schedule 数据未被旧更新覆盖', s.scheduleStore.get('td-a').data.title === '写周报')

  const s3 = await (await push([{ domain: 'schedule', id: 'td-a', updatedAt: iso(t0 + 5000), data: { ...schedData, done: true } }])).json()
  check('schedule 新更新覆盖 applied', s3.results[0].applied === true && s.scheduleStore.get('td-a').data.done === true)

  const s4 = await (await push([{ domain: 'schedule', id: 'td-b', updatedAt: iso(t0), data: { date: '2026-11-02', type: 'plan' } }])).json()
  check('schedule 非法负载 invalid-data', s4.results[0].applied === false && s4.results[0].reason === 'invalid-data' && !s.scheduleStore.has('td-b'))

  // 子任务行与顶层行同机制（parentId 只是负载字段）
  const s5 = await (await push([{ domain: 'schedule', id: 'td-a-1', updatedAt: iso(t0), data: { ...schedData, title: '列提纲', parentId: 'td-a', schedStart: null, schedEnd: null } }])).json()
  check('schedule 子任务行按条目并入', s5.results[0].applied === true && s.scheduleStore.get('td-a-1').data.parentId === 'td-a')

  const sp = await (await s.post('/api/sync/pull', { since: { schedule: 0, ledger: Date.now() + 99999 } }, auth)).json()
  check('pull 分域：schedule 有增量、ledger 过滤后为空', sp.changes.schedule.length === 2 && sp.changes.ledger.length === 0)
  check('pull 游标双域返回', typeof sp.cursor.schedule === 'number' && typeof sp.cursor.ledger === 'number')
  await s.close()
}

/* ------------------------------------------------------------------ §4f */
console.log('\n§4b2 无仓 fail-closed（2026-11-09：pull 不返回 cursor / push reason:no-vault）')
{
  const s = await boot()
  const token = (await (await s.post('/api/pair', { code: CODE, deviceName: '测试机' })).json()).deviceToken
  const auth = { authorization: 'Bearer ' + token }
  const schedData = { date: '2026-11-02', title: '无仓测试', type: 'plan', time: '', done: false, parentId: null, schedStart: null, schedEnd: null }

  s.setHasVault(false)
  const pullRes = await s.post('/api/sync/pull', { since: { ledger: 0, schedule: 0, notes: 0 } }, auth)
  check('无仓 pull 拒绝（409）', pullRes.status === 409)
  const pullBody = await pullRes.json()
  check('无仓 pull 不带 cursor（手机不推进游标）', !('cursor' in pullBody))

  const pushBody = await (await s.post('/api/sync/push', { deviceId: 'd1', changes: [{ domain: 'schedule', id: 'td-nv', updatedAt: iso(t0), data: schedData }] }, auth)).json()
  check('无仓 push 回 no-vault', pushBody.results[0].applied === false && pushBody.results[0].reason === 'no-vault')
  check('无仓 push 不落库', !s.scheduleStore.has('td-nv'))

  s.setHasVault(true)
  const okPull = await (await s.post('/api/sync/pull', { since: { ledger: 0, schedule: 0, notes: 0 } }, auth)).json()
  check('恢复仓库后 pull 正常返回 cursor', typeof okPull.cursor.schedule === 'number')
  await s.close()
}

/* ------------------------------------------------------------------ §4c */
console.log('\n§4b3 habit 域（定义 + 记录 + 墓碑 + 全量）')
{
  const s = await boot()
  const token = (await (await s.post('/api/pair', { code: CODE, deviceName: '测试机' })).json()).deviceToken
  const auth = { authorization: 'Bearer ' + token }
  const push = (changes) => s.post('/api/sync/push', { deviceId: 'd1', changes }, auth)

  const hd = normalizeHabitData({ kind: 'habit', name: '背单词', color: '#f00', target: 9, remind: 480, archived: false })
  check('habit 定义规范化（target 夹取 1..7 / remind 保留）', hd?.name === '背单词' && hd.target === 7 && hd.remind === 480)
  check('habit 缺名称拒绝', normalizeHabitData({ kind: 'habit', name: ' ' }) === null)
  check('habit remind 越界回落 null', normalizeHabitData({ kind: 'habit', name: 'x', remind: 9999 })?.remind === null)
  const rd = normalizeHabitRecordData({ kind: 'record', habitId: 'h1', date: '2026-11-09' })
  check('habit 记录规范化', rd?.habitId === 'h1' && rd.date === '2026-11-09')
  check('habit 记录坏日期拒绝', normalizeHabitRecordData({ kind: 'record', habitId: 'h1', date: '11-09' }) === null)
  check('habitRecordId / parseHabitRecordId 互逆', parseHabitRecordId(habitRecordId('h1', '2026-11-09'))?.habitId === 'h1')

  const habitData = { kind: 'habit', name: '背单词', color: '#3B82F6', target: 3, remind: null, archived: false }
  const r1 = await (await push([{ domain: 'habit', id: 'h1', updatedAt: iso(t0), data: habitData }])).json()
  check('habit 定义上行 applied', r1.results[0].applied === true && s.habitStore.has('h1'))

  const recId = habitRecordId('h1', '2026-11-09')
  const r2 = await (await push([{ domain: 'habit', id: recId, updatedAt: iso(t0 + 1000), data: { kind: 'record', habitId: 'h1', date: '2026-11-09' } }])).json()
  check('habit 记录上行 applied', r2.results[0].applied === true && s.habitRecordStore.has(recId))

  const p1 = await (await s.post('/api/sync/pull', { since: { ledger: 0, schedule: 0, notes: 0, habit: 0 } }, auth)).json()
  check('habit pull 全量含定义 + 记录、cursor.habit', p1.changes.habit.length === 2 && typeof p1.cursor.habit === 'number')

  const r3 = await (await push([{ domain: 'habit', id: recId, updatedAt: iso(t0 + 2000), data: { deleted: true } }])).json()
  check('habit 取消打卡 applied', r3.results[0].applied === true && !s.habitRecordStore.has(recId))
  const p2 = await (await s.post('/api/sync/pull', { since: { ledger: 0, schedule: 0, notes: 0, habit: 0 } }, auth)).json()
  check('habit 记录墓碑下行', p2.tombstones.some(t => t.domain === 'habit' && t.id === recId))

  const r4 = await (await push([{ domain: 'habit', id: 'h1', updatedAt: iso(t0 + 3000), data: { deleted: true } }])).json()
  check('habit 删除 applied', r4.results[0].applied === true && !s.habitStore.has('h1'))
  await s.close()
}

/* ------------------------------------------------------------------ §4c */
console.log('\n§4c 墓碑（上行删除 / 幂等 / 旧删除拒收 / pull 过滤）')
{
  const s = await boot()
  const token = (await (await s.post('/api/pair', { code: CODE, deviceName: '测试机' })).json()).deviceToken
  const auth = { authorization: 'Bearer ' + token }
  const push = (changes) => s.post('/api/sync/push', { deviceId: 'd1', changes }, auth)

  // 预置：ledger tx-del@t0、schedule td-del@t0
  await push([
    { domain: 'ledger', id: 'tx-del', updatedAt: iso(t0), data: { date: '2026-11-01', time: '10:00', type: 'expense', amount: 10, category: '日用', payment: '', merchant: '纸巾', note: '' } },
    { domain: 'schedule', id: 'td-del', updatedAt: iso(t0), data: { date: '2026-11-01', title: '要删的待办', type: 'daily', time: '', done: false, parentId: null, schedStart: null, schedEnd: null } },
  ])

  const d1 = await (await push([{ domain: 'ledger', id: 'tx-del', updatedAt: iso(t0 + 1000), data: { deleted: true } }])).json()
  check('ledger 上行删除 applied 且条目移除', d1.results[0].applied === true && !s.store.has('tx-del'))
  check('墓碑落库', s.tombstones.some(t => t.domain === 'ledger' && t.id === 'tx-del' && t.deletedAt === iso(t0 + 1000)))

  const d2 = await (await push([{ domain: 'ledger', id: 'tx-del', updatedAt: iso(t0 + 1000), data: { deleted: true } }])).json()
  check('重复删除幂等 applied', d2.results[0].applied === true)

  const d3 = await (await push([{ domain: 'schedule', id: 'td-del', updatedAt: iso(t0 - 9999), data: { deleted: true } }])).json()
  check('比行内 updatedAt 旧的删除 → 拒收回 conflict', d3.results[0].applied === false && d3.results[0].conflict === true && d3.results[0].reason === 'server-newer')
  check('拒删后条目仍在', s.scheduleStore.has('td-del'))

  // 墓碑阻挡复活：已删除 id 收到更旧的 upsert → tombstoned（不标 conflict——手机端直接出队即可）
  const z1 = await (await push([{ domain: 'ledger', id: 'tx-del', updatedAt: iso(t0), data: { date: '2026-11-01', time: '10:00', type: 'expense', amount: 10, category: '日用', payment: '', merchant: '幽灵复活', note: '' } }])).json()
  check('墓碑阻挡更旧的 upsert', z1.results[0].applied === false && z1.results[0].reason === 'tombstoned' && z1.results[0].conflict === undefined)
  check('墓碑阻挡后条目未复活', !s.store.has('tx-del'))

  const p1 = await (await s.post('/api/sync/pull', { since: { ledger: 0, schedule: 0 } }, auth)).json()
  check('pull 返回墓碑列表', Array.isArray(p1.tombstones) && p1.tombstones.some(t => t.domain === 'ledger' && t.id === 'tx-del'))
  const p2 = await (await s.post('/api/sync/pull', { since: { ledger: Date.now() + 99999, schedule: 0 } }, auth)).json()
  check('pull 墓碑按 min(各域游标) 过滤：任一域未看过仍返回', p2.tombstones.length === 1)
  const p3 = await (await s.post('/api/sync/pull', { since: { ledger: Date.now() + 99999, schedule: Date.now() + 99999, notes: Date.now() + 99999 } }, auth)).json()
  check('三域游标都越过 → 墓碑不再重复下发', p3.tombstones.length === 0)
  await s.close()
}

/* ------------------------------------------------------------------ §4d */
console.log('\n§4d notes 域与内容 API（v1.2：上行 + tree/content）')
{
  const s = await boot()
  const token = (await (await s.post('/api/pair', { code: CODE, deviceName: '测试机' })).json()).deviceToken
  const auth = { authorization: 'Bearer ' + token }
  const push = (changes) => s.post('/api/sync/push', { deviceId: 'd1', changes }, auth)

  const n1 = await (await push([{ domain: 'notes', id: 'nt-1', updatedAt: iso(t0), data: { title: '咖啡馆随想', body: '想到什么记什么' } }])).json()
  check('notes 上行 applied', n1.results[0].applied === true && s.notesStore.has('nt-1'))
  const n2 = await (await push([{ domain: 'notes', id: 'nt-2', updatedAt: iso(t0), data: { title: '  ', body: '' } }])).json()
  check('notes 空负载 invalid-data', n2.results[0].applied === false && n2.results[0].reason === 'invalid-data')
  const n3 = await (await push([{ domain: 'notes', id: 'nt-3', updatedAt: iso(t0), data: { deleted: true } }])).json()
  // v1.6：手机清空标题保存 = 墓碑删除（取代 v1.2「notes 无删除语义」）
  check('notes 墓碑 applied 且记墓碑（v1.6 删除语义）', n3.results[0].applied === true && s.tombstones.some(t => t.domain === 'notes' && t.id === 'nt-3'))

  // tree / content（需令牌）
  const bareTree = await s.get('/api/notes/tree')
  check('tree 无令牌 401', bareTree.status === 401)
  const tree = await (await s.get('/api/notes/tree', auth)).json()
  check('tree 返回平表', tree.ok === true && Array.isArray(tree.pages) && tree.pages[0].id === 'p-1' && typeof tree.pages[0].mtimeMs === 'number')
  const bareContent = await s.get('/api/notes/content?id=p-1')
  check('content 无令牌 401', bareContent.status === 401)
  const content = await (await s.get('/api/notes/content?id=p-1', auth)).json()
  check('content 按 id 返回正文', content.ok === true && content.id === 'p-1' && content.body.includes('正文'))
  const missing = await s.get('/api/notes/content?id=nope', auth)
  check('content 未知 id 404', missing.status === 404)
  const noId = await s.get('/api/notes/content', auth)
  check('content 缺 id 404', noId.status === 404)
  await s.close()
}

/* ------------------------------------------------------------------ §4e */
console.log('\n§4e 笔记 U 盘模式 v1.6（纯函数 + push LWW + pull 三域 + 兼容矩阵）')
{
  // ---- 纯函数（notesUsb.ts）----
  check('文件名 sanitize：非法字符换全角', sanitizeNoteStem('a/b\\c:d*e?f"g<h>i|j') === 'a／b＼c：d＊e？f＂ghij', sanitizeNoteStem('a/b\\c:d*e?f"g<h>i|j'))
  check('文件名 sanitize：空标题兜底「无标题」', sanitizeNoteStem('   ') === '无标题')
  check('文件名 sanitize：尾部点去除', sanitizeNoteStem('购物清单.') === '购物清单')
  check('设备文件夹：不重名用原名', deviceFolderName('Phrontis 手机', 'uuid-aaaa-bbbb', ['Phrontis 手机']) === 'Phrontis 手机')
  check('设备文件夹：重名加 deviceId 前 4 位', deviceFolderName('手机', 'a1b2c3d4-5678', ['手机', '手机']) === '手机-a1b2')
  check('重名文件 (2) 后缀', pickNoteFileName(new Set(['购物清单.md']), '购物清单') === '购物清单(2).md')
  check('重名文件跳过已有后缀', pickNoteFileName(new Set(['清单.md', '清单(2).md', '清单(3).md']), '清单') === '清单(4).md')
  const fmOk = '---\nid: n-1\nupdated: 2026-11-08T00:00:00.000Z\ntags: [手机]\n---\n正文'
  check('frontmatter 轻解析：id + updated', eq(parseNoteFrontmatter(fmOk), { id: 'n-1', updated: '2026-11-08T00:00:00.000Z' }))
  check('frontmatter 缺 updated → null', parseNoteFrontmatter('---\nid: n-1\n---\n正文') === null)
  check('非 frontmatter 文件 → null', parseNoteFrontmatter('# 普通笔记\n正文') === null)
  const bumped = bumpNoteFrontmatterUpdated(fmOk, '2026-11-09T00:00:00.000Z')
  check('写钩子：updated 被替换、id/tags 不动', bumped.includes('updated: 2026-11-09T00:00:00.000Z') && bumped.includes('id: n-1') && bumped.includes('tags: [手机]'))
  check('写钩子：无 updated 行则插入', bumpNoteFrontmatterUpdated('---\nid: n-1\ntags: [手机]\n---\n正文', 'X').includes('updated: X'))
  check('写钩子：无 id 的普通 md 不被碰', bumpNoteFrontmatterUpdated('---\ntitle: 日常\n---\n正文', 'X') === '---\ntitle: 日常\n---\n正文')
  check('push LWW：桌面没见过 → apply', notePushDecision(undefined, iso(t0)) === 'apply')
  check('push LWW：incoming 更新 → apply', notePushDecision(iso(t0), iso(t0 + 1)) === 'apply')
  check('push LWW：相同 → conflict（同刻桌面赢）', notePushDecision(iso(t0), iso(t0)) === 'conflict')
  check('push LWW：更旧 → conflict', notePushDecision(iso(t0), iso(t0 - 1)) === 'conflict')
  check('移动端前缀判定', isMobileNotesRel('移动端/手机/购物清单.md') === true && isMobileNotesRel('移动端') === true && isMobileNotesRel('学习/笔记.md') === false)

  // ---- push 语义（走真服务器 + mock deps）----
  const s = await boot()
  const token = (await (await s.post('/api/pair', { code: CODE, deviceName: '测试机' })).json()).deviceToken
  const auth = { authorization: 'Bearer ' + token }
  const push = (changes) => s.post('/api/sync/push', { changes }, auth)

  const c1 = await (await push([{ domain: 'notes', id: 'nt-9', updatedAt: iso(t0), data: { title: '新笔记', body: '内容' } }])).json()
  check('push upsert 应用并带设备身份', c1.results[0].applied === true && !!s.notesStore.get('nt-9')?.deviceId && s.notesStore.get('nt-9')?.deviceName === '测试机')
  const c2 = await (await push([{ domain: 'notes', id: 'nt-9', updatedAt: iso(t0), data: { title: '同刻冲突', body: '' } }])).json()
  check('push 同刻 → conflict（桌面赢，手机以服务端版本收敛）', c2.results[0].applied === false && c2.results[0].conflict === true && s.notesStore.get('nt-9').data.title === '新笔记')
  const c3 = await (await push([{ domain: 'notes', id: 'nt-8', updatedAt: iso(t0 + 9), data: { deleted: true } }])).json()
  check('push 墓碑路由 applyDelete(notes) 且 applied', c3.results[0].applied === true && s.tombstones.some(t => t.domain === 'notes' && t.id === 'nt-8' && t.deletedAt === iso(t0 + 9)))

  // ---- pull：changes.notes + since/cursor 三域 + 兼容矩阵 ----
  s.setNotesPullChanges([{ id: 'nt-7', updatedAt: iso(t0), data: { title: '桌面改的', body: '正文' } }])
  const p1 = await (await s.post('/api/sync/pull', { since: { ledger: 0, schedule: 0, notes: 0 } }, auth)).json()
  check('pull changes.notes 透传', Array.isArray(p1.changes.notes) && p1.changes.notes[0].id === 'nt-7')
  check('pull cursor 三域', typeof p1.cursor.ledger === 'number' && typeof p1.cursor.schedule === 'number' && typeof p1.cursor.notes === 'number')
  check('listNotesSince 收到设备身份', s.notesPulls.at(-1)?.device?.deviceId === s.devices()[0]?.deviceId && s.notesPulls.at(-1)?.device?.deviceName === '测试机')
  const p2 = await (await s.post('/api/sync/pull', { since: { ledger: 0, schedule: 0 } }, auth)).json()
  check('兼容矩阵：旧手机不传 since.notes → 缺省 0（全量）', s.notesPulls.at(-1)?.sinceMs === 0 && Array.isArray(p2.changes.notes))
  const p3 = await (await s.post('/api/sync/pull', { since: { ledger: 0, schedule: 0, notes: 1731045600000 } }, auth)).json()
  check('since.notes 增量透传', s.notesPulls.at(-1)?.sinceMs === 1731045600000)
  s.tombstones.push({ domain: 'notes', id: 'nt-6', deletedAt: iso(t0 + 5) })
  const p4 = await (await s.post('/api/sync/pull', { since: { ledger: Date.now() + 99999, schedule: Date.now() + 99999, notes: 0 } }, auth)).json()
  check('墓碑过滤含 notes 游标：min(三域) 未越过仍返回 notes 墓碑', p4.tombstones.some(t => t.domain === 'notes' && t.id === 'nt-6'))
  const p5 = await (await s.post('/api/sync/pull', { since: { ledger: Date.now() + 99999, schedule: Date.now() + 99999, notes: Date.now() + 99999 } }, auth)).json()
  check('三域游标都越过 → 墓碑不再下发', p5.tombstones.length === 0)
  await s.close()
}
/* ------------------------------------------------------------------ §8 */
console.log('\n§8 实时长轮询 v1.7（wait / waitSupported / pokeSync / 顶掉 / 断连清理）')
{
  // ---- 纯逻辑：封顶常量（真等 25s 太久，封顶行为由常量与 Math.min 路径锁定，方案 §5-5）----
  check('PULL_WAIT_CAP_MS = 25000（方案 §2.3-3）', PULL_WAIT_CAP_MS === 25000)

  const s = await boot()
  const token = (await (await s.post('/api/pair', { code: CODE, deviceName: '测试机' })).json()).deviceToken
  s.setCode({ code: '87654321', expiresAt: Date.now() + 60_000 })
  const token2 = (await (await s.post('/api/pair', { code: '87654321', deviceName: '第二台' })).json()).deviceToken
  const pullWith = (tk, body) => s.post('/api/sync/pull', body, { authorization: 'Bearer ' + tk })
  const wait600 = Date.now() + 99999

  // 1. 旧客户端兼容：不传 wait → 立即返回且不带 waitSupported（手机据此探测旧桌面）
  const t0s = Date.now()
  const p0 = await (await pullWith(token, { since: { ledger: 0 } })).json()
  check('不传 wait 立即返回且无 waitSupported（旧客户端兼容）', Date.now() - t0s < 500 && p0.waitSupported === undefined)

  // 2. wait 非法值（0 / 负数 / 非数字）→ 同旧行为
  for (const badWait of [0, -5, 'abc']) {
    const tb = Date.now()
    const pb = await (await pullWith(token, { since: { ledger: 0 }, wait: badWait })).json()
    check('wait 非法值(' + JSON.stringify(badWait) + ')立即返回', Date.now() - tb < 500 && pb.waitSupported === undefined)
  }

  // 3. 挂满超时 → waitSupported: true + 空变更（信号没来，醒来现扫就是空）
  const t1 = Date.now()
  const p1 = await (await pullWith(token, { since: { ledger: wait600 }, wait: 300 })).json()
  const took1 = Date.now() - t1
  check('挂满超时返回且带 waitSupported', p1.waitSupported === true && took1 >= 280, 'took=' + took1)
  check('超时空返回 changes 为空数组', Array.isArray(p1.changes.ledger) && p1.changes.ledger.length === 0)

  // 4. pokeSync 唤醒：请求 <1s 内返回，注册表清空
  const pending1 = pullWith(token, { since: { ledger: wait600 }, wait: 5000 })
  await new Promise(r => setTimeout(r, 200))
  check('挂起期间注册表 1 个', s.server.pendingPullDeviceIds().length === 1)
  const tPoke = Date.now()
  s.server.pokeSync()
  const p2 = await (await pending1).json()
  const took2 = Date.now() - tPoke
  check('pokeSync 唤醒挂起请求（<1s）', p2.waitSupported === true && took2 < 1000, 'took=' + took2)
  check('唤醒后注册表清空', eq(s.server.pendingPullDeviceIds(), []))

  // 5. 信号是通知不是数据：唤醒后现扫，返回挂起前已存在的数据
  await (await s.post('/api/sync/push', { changes: [{ domain: 'ledger', id: 'tx-wait', updatedAt: iso(t0), data: { date: '2026-11-08', time: '09:00', type: 'expense', amount: 5, category: '日用', payment: '', merchant: '长轮询验证', note: '' } }] }, { authorization: 'Bearer ' + token })).json()
  const p3req = pullWith(token, { since: { ledger: 0 }, wait: 5000 })
  await new Promise(r => setTimeout(r, 200))
  s.server.pokeSync()
  const p3 = await (await p3req).json()
  check('唤醒后现扫：数据照常按 since 过滤返回', p3.changes.ledger.some(x => x.id === 'tx-wait'))

  // 6. 同设备第二个 pull 顶掉第一个（第一个提前返回，第二个继续挂）
  const first = pullWith(token, { since: { ledger: wait600 }, wait: 5000 })
  await new Promise(r => setTimeout(r, 200))
  const tPre = Date.now()
  const second = pullWith(token, { since: { ledger: wait600 }, wait: 5000 })
  const firstBody = await (await first).json()
  const tookPre = Date.now() - tPre
  check('第一个被顶掉提前返回（waitSupported）', firstBody.waitSupported === true && tookPre < 2000, 'took=' + tookPre)
  check('第二个仍在挂（注册表 1 个）', s.server.pendingPullDeviceIds().length === 1)
  s.server.pokeSync()
  const secondBody = await (await second).json()
  check('第二个可被唤醒且带 waitSupported', secondBody.waitSupported === true && eq(s.server.pendingPullDeviceIds(), []))

  // 7. poke 放行全部挂起（多设备同时醒）
  const pa = pullWith(token, { since: { ledger: wait600 }, wait: 5000 })
  const pb = pullWith(token2, { since: { ledger: wait600 }, wait: 5000 })
  await new Promise(r => setTimeout(r, 200))
  check('两台设备同时挂起', s.server.pendingPullDeviceIds().length === 2)
  s.server.pokeSync()
  const [ra, rb] = await Promise.all([pa, pb])
  const ja = await ra.json()
  const jb = await rb.json()
  check('poke 放行全部挂起', ja.waitSupported === true && jb.waitSupported === true && eq(s.server.pendingPullDeviceIds(), []))

  // 8. 挂起中客户端断连 → 注册表清理，服务端不受影响（下一个 pull 正常）
  const ac = new AbortController()
  const dying = fetch(s.base + '/api/sync/pull', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ since: { ledger: wait600 }, wait: 5000 }),
    signal: ac.signal,
  })
  await new Promise(r => setTimeout(r, 200))
  check('断连前注册表 1 个', s.server.pendingPullDeviceIds().length === 1)
  ac.abort()
  await dying.catch(() => { /* abort 的 fetch 必然 reject，吞掉即可 */ })
  await new Promise(r => setTimeout(r, 100))
  check('断连后注册表清理（不留死等）', eq(s.server.pendingPullDeviceIds(), []))
  const after = await (await pullWith(token, { since: { ledger: 0 } })).json()
  check('断连后下一个 pull 正常', after.ok === true && after.waitSupported === undefined)

  await s.close()
}

console.log('\n§5 CORS（手机 WebView 与本服务不同源）')
{
  const s = await boot()
  const pre = await fetch(s.base + '/api/ping', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } })
  check('预检 204', pre.status === 204)
  check('预检放行 authorization 头', (pre.headers.get('access-control-allow-headers') || '').includes('authorization'))
  const any = await s.get('/api/ping')
  check('普通响应带 allow-origin *', any.headers.get('access-control-allow-origin') === '*')
  await s.close()
}

/* ------------------------------------------------------------------ §6 */
console.log('\n§6 协议文档契约（design.md §2.1 与实现一致）')
{
  let design = ''
  try { design = readFileSync(DESIGN_FILE, 'utf-8') } catch { /* 读不到在下面报 */ }
  check('手机仓 design.md 存在', design.length > 0, DESIGN_FILE)
  check('§2.1 记录 /api/pair', design.includes('/api/pair'))
  check('§2.1 记录 /api/sync/push 与 /api/sync/pull', design.includes('/api/sync/push') && design.includes('/api/sync/pull'))
  check('§2.1 记录默认端口 8770', design.includes('8770'))
  check('DEFAULT_PORT=8770 与文档一致', DEFAULT_PORT === 8770)
  check('协议域清单非空', SYNC_DOMAINS.length >= 1)
  // v1.1 契约
  check('§2.1 v1.1 域范围含 schedule', design.includes('`ledger` + `schedule`（日程）'))
  check('SYNC_DOMAINS = [ledger, schedule, notes, habit]', eq([...SYNC_DOMAINS], ['ledger', 'schedule', 'notes', 'habit']))
  check('§2.1 记录墓碑上行负载 { deleted: true }', design.includes('{ deleted: true }'))
  check('§2.1 记录墓碑存储路径', design.includes('phoneCompanion/tombstones.json'))
  check('§2.1 记录游标只在 pull 后推进', design.includes('只在 pull 完成后推进'))
  check('§2.1 记录 tombstoned 防复活', design.includes("reason: 'tombstoned'"))  // v1.2 契约
  check('§2.1 v1.2 记录 notes 上行域与无条件应用', design.includes('v1.2 笔记') && design.includes('无条件应用'))
  check('§2.1 记录内容 API 端点', design.includes('/api/notes/tree') && design.includes('/api/notes/content'))
  check('§2.1 记录按 id 服务端解析路径', design.includes('按 id 服务端解析路径'))
  // v1.3 契约
  check('§2.1 端点表已移除 AI 中继（电脑档 2026-11-06 下线）', !design.includes('| `POST /api/ai/chat`'))
  check('§6 决策记录标注电脑档已移除', design.includes('电脑档已于 2026-11-06 整体移除'))
  // v1.7 契约（实时同步 · 长轮询）
  check('§2.1 v1.7 记录 wait / waitSupported', design.includes('waitSupported') && design.includes('`wait`'))
  check('§2.1 v1.7 记录服务端 25s 封顶', design.includes('25'))
  check('§2.1 v1.7 记录同设备顶掉语义', design.includes('顶掉'))
  // 双向解除契约（2026-11-08 配对链路修复）
  check('§2.2 记录 /api/unpair 双向解除端点', design.includes('/api/unpair'))
  // v1.9 文件通道契约（design.md §2.3，2026-11-10）
  check('§2.3 记录文件通道三端点', design.includes('/api/files/tree') && design.includes('/api/files/content') && design.includes('/api/files/upload'))
  check('§2.3 记录回传目录 iPad 批注/', design.includes('iPad 批注'))
  check('§2.3 记录只列 PDF + 副本不覆盖', design.includes('只列 `.pdf`') && design.includes('不覆盖'))
  check('§2.3 记录 features 能力位', design.includes('features') && design.includes('files'))
  check('COMPANION_FEATURES = [files]', eq([...COMPANION_FEATURES], ['files']))
  check('文件通道上限 200MB', MAX_PDF_UPLOAD_BYTES === 200 * 1024 * 1024)
  check('回传目录名与文档一致', ANNOTATED_DIR === 'iPad 批注')
}

/* ------------------------------------------------------------------ §9 */
console.log('\n§9 组播发现应答器（UDP 发现：手机喊 PHRONDIS v1 → 桌面单播回发现负载）')
{
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  /** 发一条 UDP 并等应答；超时无应答 resolve null */
  const sendRecv = ({ host = '127.0.0.1', port, payload, waitMs = 900 }) => new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    let timer = null
    const done = (msg, rinfo) => {
      clearTimeout(timer)
      try { sock.close() } catch { /* 忽略 */ }
      resolve(msg ? { text: msg.toString('utf8'), from: rinfo.address + ':' + rinfo.port } : null)
    }
    sock.on('message', (msg, rinfo) => done(msg, rinfo))
    sock.bind(() => {
      sock.send(Buffer.from(payload, 'utf8'), port, host, () => { timer = setTimeout(() => done(null), waitMs) })
    })
  })

  const PC_NAME = '契约测试电脑'
  const HTTP_PORT = DEFAULT_PORT
  const PAIRING_FULL = pairingCapabilities(true)

  // 配对能力清单单一推导（HTTP /api/discover 与组播应答共用，勿各自写死）
  check('§9 pairingCapabilities(true) = [request, code]', eq(PAIRING_FULL, ['request', 'code']))
  check('§9 pairingCapabilities(false) = [code]', eq(pairingCapabilities(false), ['code']))

  // 线路常量与手机端 Java 插件对表——两端各写一份，「两端各自认为对、连起来才发现错」的典型面
  let java = ''
  try { java = readFileSync(JAVA_FILE, 'utf-8') } catch { /* 读不到在下面报 */ }
  check('§9 手机端 PhrontisDiscover.java 存在', java.length > 0, JAVA_FILE)
  const javaStr = (name) => { const m = java.match(new RegExp(name + ' = "([^"]*)"')); return m ? m[1].replace(/\\n/g, '\n') : null }
  const javaNum = (name) => { const m = java.match(new RegExp(name + ' = (\\d+)')); return m ? Number(m[1]) : null }
  check('§9 ping 文本两端一致（PHRONDIS v1）', javaStr('PING') !== null && javaStr('PING').trim() === DISCOVER_PING.trim(),
    '桌面="' + DISCOVER_PING.trim() + '" 手机=' + String(javaStr('PING')))
  // 组播组对表：Java GROUPS 数组 ↔ 桌面 DISCOVER_GROUPS（224 = LocalSend 同款主组，239 = 旧手机过渡兼容）
  const javaGroups = (() => {
    const m = java.match(/GROUPS\s*=\s*\{([^}]*)\}/)
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : null
  })()
  check('§9 组播组两端一致（224 主组 + 239 过渡组）',
    Array.isArray(javaGroups) && eq([...DISCOVER_GROUPS], javaGroups),
    '桌面=' + JSON.stringify([...DISCOVER_GROUPS]) + ' 手机=' + JSON.stringify(javaGroups))
  check('§9 手机自知 IP（selfIpv4）存在——扫自己网段是组播被 AP 整类丢弃后的唯一兜底', /selfIpv4\(\)/.test(java))
  check('§9 组播端口两端一致（8771）', javaNum('PORT') === DISCOVER_PORT, '桌面=' + DISCOVER_PORT + ' 手机=' + String(javaNum('PORT')))

  // 环境隔离预探：真 app 的伴侣服务在跑时，其应答器也绑 UDP 8771（SO_REUSEADDR 双绑共存），
  // 应答会串台——组播回环按首包断言、stop 断言全被外部应答污染（2026-11-08 实测 2 项假 FAIL）。
  // 预探有应答 = 外部应答器存在 → 本节改绑私有端口执行（断言语义不变），组播回环退化为 WARN。
  const preProbe = await sendRecv({ port: DISCOVER_PORT, payload: DISCOVER_PING, waitMs: 500 })
  const foreign = !!preProbe
  const udpPort = foreign ? 50000 + (process.pid % 10000) : DISCOVER_PORT
  if (foreign) {
    console.log('  [WARN] 检测到外部应答器（真 app 的伴侣服务在跑），UDP 断言改用私有端口 ' + udpPort + ' 隔离执行')
  }

  startDiscoverResponder(HTTP_PORT, () => PC_NAME, PAIRING_FULL, udpPort)
  await sleep(200) // 等 bind + addMembership

  // 组播回环：向组地址发包、加入组的本端应收到并单播应答。环境依赖（容器 / 某些网络禁组播，
  // 外部应答器抢答同理），只在干净环境跑，收不到/串台只警告不判 FAIL——应答逻辑由下面的单播路径硬断言覆盖。
  if (!foreign) {
    const mcast = await sendRecv({ host: DISCOVER_GROUPS[0], port: DISCOVER_PORT, payload: DISCOVER_PING, waitMs: 700 })
    if (mcast) {
      check('§9 组播 ping 收到单播应答', JSON.parse(mcast.text).port === HTTP_PORT, mcast.text)
    } else {
      console.log('  [WARN] 组播回环无应答（本机网络禁组播则属正常），该路径跳过——单播路径已覆盖应答构型')
    }
  }

  // 单播到绑定端口（确定性路径）：ping → 应答构型（与 GET /api/discover 同构 + port）。
  // 私有端口上只有本测试的应答器，外部实例无法串台。
  const reply = await sendRecv({ port: udpPort, payload: DISCOVER_PING })
  check('§9 ping 收到单播应答', !!reply)
  const body = reply ? JSON.parse(reply.text) : null
  check('§9 应答构型 ok/protocol/pc.name/port/pairing',
    !!body && body.ok === true && body.protocol === PROTOCOL_VERSION && body.pc?.name === PC_NAME
      && body.port === HTTP_PORT && eq(body.pairing, PAIRING_FULL), reply && reply.text)
  check('§9 应答来自绑定端口 ' + udpPort, !!reply && reply.from.endsWith(':' + udpPort), reply && reply.from)

  const noise = await sendRecv({ port: udpPort, payload: 'HELLO WORLD\n', waitMs: 400 })
  check('§9 非 ping 文本不应答', noise === null, noise && noise.text)

  stopDiscoverResponder()
  await sleep(50)
  const afterStop = await sendRecv({ port: udpPort, payload: DISCOVER_PING, waitMs: 400 })
  check('§9 stop 后不再应答（跟随伴侣服务生命周期）', afterStop === null, afterStop && afterStop.text)

  // 勿写死：pcName / httpPort / pairing 全部来自入参（重启一次用另一组入参验证）
  startDiscoverResponder(9999, () => '另起的电脑名', pairingCapabilities(false), udpPort)
  await sleep(200)
  const reply2 = await sendRecv({ port: udpPort, payload: DISCOVER_PING })
  const body2 = reply2 ? JSON.parse(reply2.text) : null
  check('§9 重启后入参跟随（port/pc.name/pairing）',
    !!body2 && body2.port === 9999 && body2.pc?.name === '另起的电脑名' && eq(body2.pairing, ['code']), reply2 && reply2.text)
  stopDiscoverResponder()

  // 协议文档契约：手机仓 design.md 决策记录了组播发现与交接文档
  let design = ''
  try { design = readFileSync(DESIGN_FILE, 'utf-8') } catch { /* 读不到在下面报 */ }
  check('§9 design.md 记录组播发现（239.255.42.42:8771）', design.includes('239.255.42.42:8771'))
  check('§9 design.md 记录桌面应答端交接文档', design.includes('handoff-multicast-discovery-desktop.md'))
}

/* ------------------------------------------------------------------ §10 */
console.log('\n§10 地址推荐与状态视图（WP1/WP7：docker 网桥不推荐 / urls 不嵌过期码 / 过期请求过滤 / 双向解除）')
{
  const c = (iface, addr) => ({ iface, addr })

  // ---- orderLanAddresses 纯函数（排序规格：clientIp 同 /24 → defaultIp → 真实网卡 → 虚拟 → link-local）----
  const base = [
    c('br-e105861832a4', '172.18.0.1'),
    c('docker0', '172.17.0.1'),
    c('veth9c2e1a0', '172.18.0.2'),
    c('tailscale0', '100.101.0.3'),
    c('wlp4s0', '192.168.43.10'),
    c('eth0', '10.116.216.100'),
    c('wlp4s0', '169.254.3.4'),
  ]
  const plain = orderLanAddresses(base, {})
  check('§10 真实网卡排最前且无线优先', plain[0].addr === '192.168.43.10' && plain[1].addr === '10.116.216.100',
    JSON.stringify(plain.map(x => x.iface + '/' + x.addr)))
  check('§10 docker 网桥 / veth / tailscale 排真实网卡之后',
    plain.findIndex(x => x.addr === '172.18.0.1') > 1 && plain.findIndex(x => x.addr === '172.18.0.2') > 1
      && plain.findIndex(x => x.addr === '100.101.0.3') > 1)
  check('§10 link-local 最末（比虚拟网卡还没用）', plain[plain.length - 1].addr === '169.254.3.4')
  const withDefault = orderLanAddresses(base, { defaultIp: '10.116.216.100' })
  check('§10 defaultIp（默认路由出口）排第二优先级', withDefault[0].addr === '10.116.216.100' && withDefault[1].addr === '192.168.43.10')
  const withClient = orderLanAddresses(base, { defaultIp: '10.116.216.100', clientIp: '192.168.43.77' })
  check('§10 clientIp 同 /24 排第一（手机刚来过，几乎必然可达）',
    withClient[0].addr === '192.168.43.10' && withClient[1].addr === '10.116.216.100')
  check('§10 重复地址去重（保留排名最高）',
    orderLanAddresses([c('br-xyz', '192.168.1.5'), c('wlp4s0', '192.168.1.5'), c('eth0', '10.0.0.1')], {}).length === 2)
  check('§10 isVirtualIface 识别 br-/veth/docker/utun，不误伤 wlp/eth',
    isVirtualIface('br-e105861832a4') === true && isVirtualIface('veth9c2e1a0') === true
      && isVirtualIface('docker0') === true && isVirtualIface('utun3') === true
      && isVirtualIface('wlp4s0') === false && isVirtualIface('eth0') === false)
  check('§10 ipv4Prefix24 取前三段', ipv4Prefix24('192.168.43.10') === '192.168.43' && ipv4Prefix24('bad') === '')

  // ---- buildStatusView 纯函数（urls 绝不嵌过期码是硬约束）----
  const NOW = 1_700_000_000_000
  const candidates = [c('br-e105861832a4', '172.18.0.1'), c('wlp4s0', '192.168.43.10'), c('eth0', '10.116.216.100')]
  const pending = (requestId, expiresAt) => ({ requestId, code: '0000', deviceName: 'x', ip: '192.168.43.1', createdAt: NOW, expiresAt })

  const vOk = buildStatusView({
    running: true, port: 8770, candidates,
    pairCode: { code: '12345678', expiresAt: NOW + 1000 },
    pendingPairs: [pending('r1', NOW + 1000)],
    clientIp: '192.168.43.1', now: NOW,
  })
  check('§10 推荐位 = 手机来源同 /24 的地址（热点场景不再推 docker 网桥）',
    vOk.recommendedUrl === 'http://192.168.43.10:8770/pair#12345678', vOk.recommendedUrl)
  check('§10 urls 全量输出且带有效码', vOk.urls.length === 3 && vOk.urls.every(u => u.endsWith('#12345678')))
  check('§10 addresses 推荐标记首位、虚拟标记正确',
    vOk.addresses[0].recommended === true && vOk.addresses[0].virtual === false
      && vOk.addresses.find(a => a.ip === '172.18.0.1')?.virtual === true)
  check('§10 有效码时 pairCode / pairCodeExpiresAt 原样透出', vOk.pairCode === '12345678' && vOk.pairCodeExpiresAt === NOW + 1000)
  check('§10 未过期 pending 保留', vOk.pendingPairs.length === 1 && vOk.pendingPairs[0].requestId === 'r1')

  const vExpired = buildStatusView({
    running: true, port: 8770, candidates,
    pairCode: { code: '12345678', expiresAt: NOW - 1 },
    pendingPairs: [pending('r2', NOW - 1)], now: NOW,
  })
  check('§10 过期码 → urls 不嵌码（hash 为空，WP7 10.2 硬约束）',
    vExpired.urls.length === 3 && vExpired.urls.every(u => u.endsWith('/pair#')), JSON.stringify(vExpired.urls))
  check('§10 过期码 → pairCode 空串、recommendedUrl 不含旧码', vExpired.pairCode === '' && !vExpired.recommendedUrl.includes('12345678'))
  check('§10 过期 pair request 不出现在 pendingPairs（WP7 10.3）', vExpired.pendingPairs.length === 0)

  const vStop = buildStatusView({ running: false, port: 0, candidates, pairCode: null, pendingPairs: [], now: NOW })
  check('§10 未运行 → urls / addresses / recommendedUrl 全空', vStop.urls.length === 0 && vStop.addresses.length === 0 && vStop.recommendedUrl === '')

  // ---- /api/unpair + revokeDevice + onClientSeen（真 HTTP 走完整链路）----
  const s = await boot()
  try {
    await s.get('/api/discover')
    check('§10b discover 上报来源 IP（onClientSeen）', s.clientSeens.includes('127.0.0.1'))

    const p1 = await (await s.post('/api/pair', { code: CODE, deviceName: '手机A' })).json()
    const auth1 = { authorization: 'Bearer ' + p1.deviceToken }
    check('§10b 配对后 ping 200', (await s.get('/api/ping', auth1)).status === 200)

    // 面板运行中删除设备：内存令牌立即失效（此前只删文件，tokenIndex 还认旧 token，手机等不来 401）
    check('§10b revokeDevice 命中', s.server.revokeDevice(s.devices()[0].deviceId) === true)
    check('§10b revoke 后旧令牌 ping 401（不等重启）', (await s.get('/api/ping', auth1)).status === 401)

    // 双向解除：手机侧解除配对 best-effort 调用（design.md §2.2）
    s.setCode({ code: '87654321', expiresAt: Date.now() + 60_000 })
    const p2 = await (await s.post('/api/pair', { code: '87654321', deviceName: '手机B' })).json()
    const auth2 = { authorization: 'Bearer ' + p2.deviceToken }
    check('§10b 第二台配对后 ping 200', (await s.get('/api/ping', auth2)).status === 200)
    const up = await s.post('/api/unpair', {}, auth2)
    check('§10b unpair 200', up.status === 200 && (await up.json()).ok === true)
    check('§10b unpair 后该设备移出设备表（另一台不受牵连）',
      s.devices().length === 1 && s.devices()[0].name === '手机A')
    check('§10b unpair 后 ping 401', (await s.get('/api/ping', auth2)).status === 401)
    const upBad = await s.post('/api/unpair', {}, { authorization: 'Bearer garbage' })
    check('§10b 无效令牌 unpair 401', upBad.status === 401)
    // 上报点 = discover / pair/request / 成功 ping（401 在鉴权层就被拒，到不了上报）
    check('§10b ping 也上报来源（持续修正推荐）', s.clientSeens.filter(x => x === '127.0.0.1').length >= 3)
  } finally { await s.close() }
}

/* ------------------------------------------------------------------ §11 */
console.log('\n§11 文件通道 v1（iPad 交接 / 批注回传，design.md §2.3）')
{
  // ---- 纯函数：命名 / 魔数 / 过滤 ----
  check('回传命名：追加（批注）', annotatedPdfName('讲义 03.pdf') === '讲义 03（批注）.pdf')
  check('回传命名：已带全角（批注）不重复', annotatedPdfName('讲义 03（批注）.pdf') === '讲义 03（批注）.pdf')
  check('回传命名：已带半角(批注)不重复且强制小写 .pdf', annotatedPdfName('讲义 03(批注).PDF') === '讲义 03(批注).pdf')
  check('回传命名：非 pdf 扩展强转 .pdf', annotatedPdfName('笔记.docx') === '笔记（批注）.pdf')
  check('回传命名：路径与 Windows 非法字符清理', (() => {
    const n = annotatedPdfName('../../a:b*c?"<>|.pdf')
    return !/[\\/:*?"<>|]/.test(n) && n.endsWith('（批注）.pdf')
  })())
  check('回传命名：空名兜底', annotatedPdfName('   ') === '未命名（批注）.pdf')
  check('回传命名：Windows 保留名加前缀', annotatedPdfName('CON.pdf') === '_CON（批注）.pdf')
  check('重名 (2) 后缀', pickAnnotatedPdfName(new Set(['讲义 03（批注）.pdf']), '讲义 03.pdf') === '讲义 03（批注） (2).pdf')
  const crowded = new Set(['x（批注）.pdf'])
  for (let i = 2; i <= 100; i++) crowded.add(`x（批注） (${i}).pdf`)
  check('重名 100 次仍冲突 → null（调用方 409）', pickAnnotatedPdfName(crowded, 'x.pdf') === null)
  check('PDF 魔数：%PDF- 通过', isPdfMagic(Buffer.from('%PDF-1.7')))
  check('PDF 魔数：PNG / 过短拒绝', !isPdfMagic(Buffer.from('PNG\x00')) && !isPdfMagic(Buffer.from('%PD')))

  const page = (over = {}) => ({
    id: 'auto:x.pdf', title: 'x', path: 'x.pdf', categoryId: null, tags: [], starred: false,
    sortOrder: 0, fileType: 'pdf', attachmentId: '', createdAt: '', updatedAt: '',
    mtimeMs: 1, outgoingTitles: [], frontmatter: {}, entryKind: 'file', sizeBytes: 1, ...over,
  })
  check('过滤：pdf file 条目入选', isHandoffPdfPage(page()))
  check('过滤：md doc 排除', !isHandoffPdfPage(page({ entryKind: 'doc', fileType: 'md', path: 'a.md' })))
  check('过滤：非 pdf 文件排除', !isHandoffPdfPage(page({ fileType: 'txt', path: 'a.txt' })))
  check('过滤：移动端子树排除', !isHandoffPdfPage(page({ path: '移动端/手机/x.pdf' })))
  check('过滤：系统 / 隐藏段排除',
    !isHandoffPdfPage(page({ path: '.knowbase/x.pdf' }))
    && !isHandoffPdfPage(page({ path: '.attachments/x.pdf' }))
    && !isHandoffPdfPage(page({ path: '_attachments/x.pdf' }))
    && !isHandoffPdfPage(page({ path: '_inbox/x.pdf' })))
  check('过滤：.. 段排除（路径穿越）', !isHandoffPdfPage(page({ path: '../x.pdf' })))

  // ---- 临时 vault（真 fs 触达层）----
  const root = mkdtempSync(join(tmpdir(), 'phrontis-handoff-'))
  const pdfDir = join(root, '课程', '线性代数')
  mkdirSync(pdfDir, { recursive: true })
  const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n' + 'a'.repeat(300))
  const originalAbs = join(pdfDir, '讲义 03.pdf')
  writeFileSync(originalAbs, pdfBytes)
  writeFileSync(join(pdfDir, '讲义 03.txt'), 'plain text, not a pdf')
  writeFileSync(join(pdfDir, '笔记.md'), '# md')
  mkdirSync(join(root, '移动端', '手机'), { recursive: true })
  writeFileSync(join(root, '移动端', '手机', '手机里的.pdf'), pdfBytes)
  mkdirSync(join(root, '.knowbase'), { recursive: true })
  writeFileSync(join(root, '.knowbase', '隐藏.pdf'), pdfBytes)

  const originalStat = statSync(originalAbs)
  const pdfPages = [
    page({ id: 'auto:课程/线性代数/讲义 03.pdf', title: '讲义 03', path: '课程/线性代数/讲义 03.pdf', sizeBytes: pdfBytes.length, mtimeMs: originalStat.mtimeMs }),
    page({ id: 'auto:课程/线性代数/笔记.md', title: '笔记', path: '课程/线性代数/笔记.md', fileType: 'md', entryKind: 'doc' }),
    page({ id: 'auto:课程/线性代数/讲义 03.txt', title: '讲义 03.txt', path: '课程/线性代数/讲义 03.txt', fileType: 'txt' }),
    page({ id: 'auto:移动端/手机/手机里的.pdf', title: '手机里的', path: '移动端/手机/手机里的.pdf', sizeBytes: pdfBytes.length }),
    page({ id: 'auto:.knowbase/隐藏.pdf', title: '隐藏', path: '.knowbase/隐藏.pdf' }),
    page({ id: 'auto:_attachments/旧.pdf', title: '旧', path: '_attachments/旧.pdf' }),
    page({ id: 'auto:../逃逸.pdf', title: '逃逸', path: '../逃逸.pdf' }),
  ]
  const listed = listHandoffPdfs(pdfPages)
  check('清单只含可交接 PDF（中文路径保留）',
    listed.length === 1 && listed[0].path === '课程/线性代数/讲义 03.pdf' && listed[0].sizeBytes === pdfBytes.length,
    JSON.stringify(listed.map(x => x.path)))

  const sha = (buf) => createHash('sha256').update(buf).digest('hex')
  const annotatedDir = join(root, ANNOTATED_DIR)
  const tmpFiles = () => (existsSync(annotatedDir) ? readdirSync(annotatedDir).filter(n => n.startsWith('.kb-tmp-')) : [])
  const form = (name, bytes) => {
    const fd = new FormData()
    fd.append('file', new Blob([bytes], { type: 'application/pdf' }), name)
    return fd
  }

  const s = await boot({ filesRoot: root, pdfPages })
  const token = (await (await s.post('/api/pair', { code: CODE, deviceName: 'iPad' })).json()).deviceToken
  const auth = { authorization: 'Bearer ' + token }
  const upload = (name, bytes) => fetch(s.base + '/api/files/upload', { method: 'POST', headers: auth, body: form(name, bytes) })
  try {
    check('files 端点无令牌 401', (await s.get('/api/files/tree')).status === 401)

    const ping = await (await s.get('/api/ping', auth)).json()
    check('ping 带 features: [files]', Array.isArray(ping.features) && ping.features.includes('files'))

    const tree = await (await s.get('/api/files/tree', auth)).json()
    check('files/tree 返回 generatedAt + 只有 PDF',
      tree.ok === true && typeof tree.generatedAt === 'number'
      && tree.files.length === 1 && tree.files[0].path === '课程/线性代数/讲义 03.pdf'
      && tree.files[0].fileType === 'pdf' && typeof tree.files[0].mtimeMs === 'number')

    const id = pdfPages[0].id
    const dl = await s.get('/api/files/content?id=' + encodeURIComponent(id), auth)
    const dlBytes = Buffer.from(await dl.arrayBuffer())
    check('content 200 + application/pdf', dl.status === 200 && dl.headers.get('content-type') === 'application/pdf')
    check('content 与磁盘 sha256 一致', sha(dlBytes) === sha(pdfBytes))
    check('content-length 正确', Number(dl.headers.get('content-length')) === pdfBytes.length)
    check('中文 Content-Disposition 正确',
      dl.headers.get('content-disposition') === `attachment; filename*=UTF-8''${encodeURIComponent('讲义 03.pdf')}`)
    check('content nosniff + no-store',
      dl.headers.get('x-content-type-options') === 'nosniff' && dl.headers.get('cache-control') === 'no-store')
    check('content 未知 id 404', (await s.get('/api/files/content?id=nope', auth)).status === 404)
    check('content 非 PDF 404', (await s.get('/api/files/content?id=' + encodeURIComponent(pdfPages[2].id), auth)).status === 404)
    check('content 缺 id 404', (await s.get('/api/files/content', auth)).status === 404)
    check('content 路径穿越条目 404（.. 被过滤）', (await s.get('/api/files/content?id=' + encodeURIComponent(pdfPages[6].id), auth)).status === 404)

    // 上传：中文名 → iPad 批注/<原名>（批注）.pdf；原文件不动
    const up1 = await upload('讲义 03.pdf', pdfBytes)
    const up1Body = await up1.json()
    check('upload 200 且落到 iPad 批注/原名（批注）.pdf',
      up1.status === 200 && up1Body.file.name === '讲义 03（批注）.pdf'
      && up1Body.file.path === 'iPad 批注/讲义 03（批注）.pdf',
      JSON.stringify(up1Body))
    check('回传副本字节与原文件一致',
      readFileSync(join(root, up1Body.file.path)).equals(pdfBytes) && up1Body.file.size === pdfBytes.length)
    check('原文件内容与 mtime 未被改动',
      readFileSync(originalAbs).equals(pdfBytes) && statSync(originalAbs).mtimeMs === originalStat.mtimeMs)

    const up2 = await upload('讲义 03.pdf', pdfBytes)
    const up2Body = await up2.json()
    check('重名生成 (2) 且不覆盖', up2.status === 200 && up2Body.file.name === '讲义 03（批注） (2).pdf')
    check('两份副本都在', readFileSync(join(root, 'iPad 批注/讲义 03（批注）.pdf')).equals(pdfBytes)
      && readFileSync(join(root, 'iPad 批注/讲义 03（批注） (2).pdf')).equals(pdfBytes))

    const up3 = await upload('设计心理学（批注）.pdf', pdfBytes)
    const up3Body = await up3.json()
    check('已带（批注）后缀不重复追加', up3.status === 200 && up3Body.file.name === '设计心理学（批注）.pdf')

    const bad = await upload('伪装.pdf', Buffer.from('PNG\x00 definitely not a pdf'))
    check('非 PDF（魔数不对）415', bad.status === 415)
    check('415 后无 .kb-tmp 残留', tmpFiles().length === 0, JSON.stringify(tmpFiles()))

    const empty = await upload('空.pdf', Buffer.alloc(0))
    check('空文件 400', empty.status === 400)
    check('空文件后无 .kb-tmp 残留', tmpFiles().length === 0)

    const notMultipart = await s.post('/api/files/upload', { hello: 1 }, auth)
    check('非 multipart 400', notMultipart.status === 400)

    // 上传中断（真实半包 socket）：handler 必须结算并清掉临时文件
    await new Promise((done) => {
      const rq = http.request({
        host: '127.0.0.1', port: s.port, path: '/api/files/upload', method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'multipart/form-data; boundary=XBOUND',
          'content-length': '1000000',
        },
      })
      rq.on('error', () => done())
      rq.write('--XBOUND\r\nContent-Disposition: form-data; name="file"; filename="中断.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\npartial')
      setTimeout(() => { rq.destroy(); done() }, 120)
    })
    await new Promise(r => setTimeout(r, 400))
    check('中断上传后无 .kb-tmp 残留', tmpFiles().length === 0, JSON.stringify(tmpFiles()))

    // 符号链接逃逸（平台不支持建链时跳过）
    const outsideDir = mkdtempSync(join(tmpdir(), 'phrontis-outside-'))
    writeFileSync(join(outsideDir, 'secret.pdf'), Buffer.from('%PDF-1.7 secret'))
    let linkMade = false
    try { symlinkSync(join(outsideDir, 'secret.pdf'), join(pdfDir, '链接.pdf')); linkMade = true } catch { /* Windows 需要特权 */ }
    if (linkMade) check('符号链接逃逸：resolvePdfAbs 拒绝', resolvePdfAbs(root, '课程/线性代数/链接.pdf') === null)
    else ok('符号链接逃逸：平台不支持建链，跳过')
    rmSync(outsideDir, { recursive: true, force: true })
  } finally { await s.close() }

  // 超限：按注入上限缩小（200MB 真文件不进契约脚本）
  const sBig = await boot({ filesRoot: root, pdfPages, pdfMaxBytes: 1024 })
  const tBig = (await (await sBig.post('/api/pair', { code: CODE, deviceName: 'iPad-大文件' })).json()).deviceToken
  try {
    const bigBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 0x41)])
    const big = await fetch(sBig.base + '/api/files/upload', {
      method: 'POST', headers: { authorization: 'Bearer ' + tBig }, body: form('大文件.pdf', bigBytes),
    })
    check('超过单文件上限 413', big.status === 413)
    check('413 后无 .kb-tmp 残留', tmpFiles().length === 0, JSON.stringify(tmpFiles()))
  } finally { await sBig.close() }

  rmSync(root, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ §12 */
console.log('\n§12 lanShare 公共解析器回归（抽取 multipart 核心后行为不变）')
{
  const dir = mkdtempSync(join(tmpdir(), 'phrontis-lanshare-'))
  const srv = http.createServer((req, res) => {
    void (async () => {
      try {
        const files = await parseMultipartUpload(req, { targetDir: dir })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(files.map(f => ({ originalName: f.originalName, savedName: f.savedName, size: f.size }))))
      } catch (e) {
        res.writeHead(e?.status ?? 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: e?.message ?? 'failed' }))
      }
    })()
  })
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '127.0.0.1', res) })
  const base = 'http://127.0.0.1:' + srv.address().port
  try {
    const fd = new FormData()
    fd.append('note', '非文件字段应被忽略')
    fd.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), '购物清单.txt')
    const r = await fetch(base, { method: 'POST', body: fd })
    const files = await r.json()
    check('lanShare：只收文件 part、忽略普通字段', r.status === 200 && files.length === 1 && files[0].originalName === '购物清单.txt')
    const onDisk = readdirSync(dir)
    check('lanShare：默认命名 <时间戳>-<净化名>（行为不回退）',
      onDisk.length === 1 && /^\d+-购物清单\.txt$/.test(onDisk[0]) && files[0].size === 5, JSON.stringify(onDisk))
    check('lanShare：落盘到目标目录', existsSync(join(dir, onDisk[0])))
  } finally {
    await new Promise(res => { srv.closeAllConnections?.(); srv.close(res) })
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n' + (failures === 0 ? 'PASS (' + checks + ' checks)' : 'FAIL (' + failures + '/' + checks + ')'))
process.exit(failures === 0 ? 0 : 1)
