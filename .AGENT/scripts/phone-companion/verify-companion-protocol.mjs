#!/usr/bin/env node
/**
 * 契约验证：手机伴侣同步协议 v1（phoneCompanion）。
 *
 * 为什么需要它：这一层的失败模式全是「两端各自认为对、连起来才发现错」——
 * 配对码一次性语义、LWW 合并方向、CORS 预检、拉取游标，任何一环错了
 * 表象都只是「手机上点同步没反应」，桌面上没有任何报错。
 *
 * 验证方式：不启 Electron，直接以内存依赖驱动 createCompanionServer（与生产同一份代码），
 * 打真 HTTP 请求过完整链路：
 *   §1 协议纯函数（校验 / 规范化 / LWW 裁决）
 *   §2 配对（配对码一次性 / 过期 / 设备落库 / 限频外语义）
 *   §3 鉴权（无令牌 / 错令牌 / 对令牌）
 *   §4 同步（新条目并入 / 旧更新冲突 / 新更新覆盖 / 非法负载 / 未支持域 / 拉取与游标）
 *   §5 CORS（预检 204 + 放行 authorization）
 *   §6 协议文档契约（design.md §2.1 与端点常量一致）
 *
 * 运行（主仓根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/phone-companion/verify-companion-protocol.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCompanionServer } from '../../../electron/lib/phoneCompanion/server.ts'
import {
  SYNC_DOMAINS, PROTOCOL_VERSION, DEFAULT_PORT,
  normalizeLedgerData, shouldApplyIncoming, buildPairUrl, parsePairInput,
} from '../../../electron/lib/phoneCompanion/protocol.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const DESIGN_FILE = join(ROOT, '..', 'Phrontis-mobile', 'docs', 'design.md')

let failures = 0
let checks = 0
const ok = (m) => console.log('  [OK] ' + m)
const bad = (m) => { failures++; console.error('  [FAIL] ' + m) }
const check = (m, cond, detail) => { checks++; cond ? ok(m) : bad(detail ? m + ' —— ' + detail : m) }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const CODE = '12345678'

/** 内存依赖 + 起一只真服务器；返回 { port, url, setCode, store } */
async function boot({ code = CODE, expiresAt = Date.now() + 60_000 } = {}) {
  let devices = []
  const store = new Map() // id -> { id, updatedAt, data }
  let pairCode = code ? { code, expiresAt } : null
  const server = createCompanionServer({
    loadDevices: () => devices,
    saveDevices: (l) => { devices = l.slice() },
    getPairCode: () => pairCode,
    consumePairCode: () => { pairCode = null },
    applyLedger: (item) => {
      const cur = store.get(item.id)
      if (cur && !(item.updatedAt > cur.updatedAt)) return { applied: false, conflict: true }
      store.set(item.id, item)
      return { applied: true }
    },
    listLedgerSince: (sinceMs) => [...store.values()].filter(x => Date.parse(x.updatedAt) > sinceMs),
    pcName: () => 'TEST-PC',
  })
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res) })
  const port = server.address().port
  return {
    port,
    base: 'http://127.0.0.1:' + port,
    store,
    devices: () => devices,
    setCode: (c) => { pairCode = c },
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

  const r5 = await (await push([{ domain: 'schedule', id: 't-1', updatedAt: iso(t0), data: {} }])).json()
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

/* ------------------------------------------------------------------ §5 */
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
}

console.log('\n' + (failures === 0 ? 'PASS (' + checks + ' checks)' : 'FAIL (' + failures + '/' + checks + ')'))
process.exit(failures === 0 ? 0 : 1)
