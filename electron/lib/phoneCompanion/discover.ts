import dgram from 'node:dgram'
import os from 'node:os'
import { PROTOCOL_VERSION } from './protocol.ts'

/* 相对导入显式带 .ts：契约脚本以 node --experimental-strip-types 直跑本文件（零 electron 依赖）。 */

/**
 * 组播发现应答器（2026-11-08，借鉴 LocalSend 的 UDP 发现；规格冻结于
 * Phrontis-mobile 仓 docs/handoff-multicast-discovery-desktop.md）。
 *
 * 为什么：手机 WebView 拿不到本机 IP，扫段只能按经验清单枚举网段，电脑活在清单外
 * （实测 10.116.216.x）就永远搜不到。组播发现不猜网段：手机往组播组喊一声（每组 3 声
 * "PHRONDIS v1"，间隔 250ms 抗丢包），本端加入组收 ping 后**向来源地址单播**回发现
 * 负载（与 GET /api/discover 同构 + port 字段），任意子网 <1s 命中。port 为伴侣 HTTP
 * 实际端口——电脑改端口时组播路径自动跟随，扫段路径做不到。
 *
 * 双组收包（2026-11-08 修订）：224.0.0.167 是 LocalSend 同款链路本地组（RFC 4541 要求 AP
 * 无条件泛洪，最被善待）；239.255.42.42 为初版组地址，保留是对旧手机 APK 的过渡兼容。
 * 组播只是加速器——实测本网络 AP 整类丢弃客户端组播（224/239 双组零到达），手机侧真正的
 * 兜底是「自知 IP 扫自己网段」（PhrontisDiscover.java selfIpv4），组播通不通它都工作。
 *
 * 加组按接口 IP 逐个来（LocalSend 同款）：不带接口的 addMembership 走内核默认选择，
 * 实测 Linux 上会 EINVAL（多网卡机器不可靠），按接口 IP 加组稳；每个接口独立 try，
 * 任一成功即生效。30s 重加组自愈 Wi-Fi 漫游 / DHCP 换址后成员关系失效的静默断链。
 *
 * 失败语义：组播不可用的网络（AP 隔离等）静默降级为扫段/手动，伴侣服务本身不受影响。
 */

/** 收包组清单：[0] = LocalSend 同款 224 组（新手机主发），[1] = 初版 239 组（旧手机过渡兼容） */
export const DISCOVER_GROUPS = ['224.0.0.167', '239.255.42.42'] as const
export const DISCOVER_PORT = 8771
/** 手机侧 ping 文本（PhrontisDiscover.java PING 常量，带换行；应答端按 trim 后比对） */
export const DISCOVER_PING = 'PHRONDIS v1\n'

const REJOIN_MS = 30_000

let socket: dgram.Socket | null = null
let rejoinTimer: NodeJS.Timeout | null = null

/** 本机全部非内部 IPv4 地址（按接口 IP 加组用；没有则回退不带接口加一次） */
function ipv4Addresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list ?? []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address)
    }
  }
  return out
}

function joinGroup(s: dgram.Socket): void {
  const ips = ipv4Addresses()
  let joined = false
  for (const ip of ips) {
    for (const group of DISCOVER_GROUPS) {
      try {
        s.addMembership(group, ip)
        joined = true
      } catch { /* 接口恰在切换 / 不支持组播：跳过，其余接口照试 */ }
    }
  }
  if (!joined) {
    for (const group of DISCOVER_GROUPS) {
      try {
        s.addMembership(group)
      } catch { /* 全部失败：发现降级为扫段/手动，服务不受影响 */ }
    }
  }
}

/**
 * 启动应答器（跟随伴侣服务生命周期：start 时调，stop / before-quit 配 stopDiscoverResponder）。
 * pcName 与 pairing 取现有 deps.pcName() / 配对能力传入，勿在此写死。
 * udpPort 仅契约脚本注入私有端口做隔离测试用（真 app 在跑时 UDP 8771 被占，应答会串台）；
 * 生产一律缺省绑定冻结口 8771。
 */
export function startDiscoverResponder(httpPort: number, pcName: () => string, pairing: readonly string[], udpPort: number = DISCOVER_PORT): void {
  stopDiscoverResponder()
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  socket = s
  s.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== DISCOVER_PING.trim()) return
    console.log('[companion] discover ping from', `${rinfo.address}:${rinfo.port}`, '→ 单播回 port', httpPort)
    const reply = Buffer.from(JSON.stringify({
      ok: true,
      protocol: PROTOCOL_VERSION,
      pc: { name: pcName() },
      port: httpPort,
      pairing: [...pairing],
    }))
    s.send(reply, rinfo.port, rinfo.address)
  })
  s.on('error', () => {
    /* 组播不可用的网络（AP 隔离等）：发现降级为扫段/手动，服务不受影响 */
  })
  s.bind(udpPort, () => {
    console.log('[companion] discover responder on UDP', udpPort, '接口:', ipv4Addresses().join(', ') || '(无 IPv4 接口)')
    joinGroup(s)
    rejoinTimer = setInterval(() => joinGroup(s), REJOIN_MS)
  })
}

/** 停止应答器（服务关闭即停；未启动时为空操作） */
export function stopDiscoverResponder(): void {
  if (rejoinTimer) {
    clearInterval(rejoinTimer)
    rejoinTimer = null
  }
  if (!socket) return
  const s = socket
  socket = null
  try {
    s.close()
  } catch { /* 已关/未 bind：忽略 */ }
}
