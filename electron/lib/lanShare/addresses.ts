import { networkInterfaces } from 'os'
import dgram from 'node:dgram'
import { isPrivateAddress } from './auth.ts'

/* 相对导入显式带 .ts：契约脚本以 node --experimental-strip-types 直跑本文件（零 electron 依赖）。 */

/**
 * 局域网地址候选与推荐排序（2026-11-08，配对链路修复 WP1）。
 *
 * 为什么：旧行为按「是否虚拟 + 接口名 localeCompare」排序，docker 网桥 `br-e105861832a4`
 * 既不被 VIRTUAL_IFACE_RE 识别、又按字典序排在 `wlp4s0` 前 —— 手机扫二维码拿到的是
 * `172.18.0.1`（无路由必失败），而真正可达的热点地址 `192.168.43.x` 被埋在后面。
 * 机制与排序规格冻结于 Phrontis-mobile 仓 docs/handoff-pairing-hotspot-repair.md §4。
 *
 * 排序分数（越小越优先）：
 *   0 与 clientIp 同 /24（手机刚来过，几乎必然可达）
 *   1 defaultIp（默认路由出口）
 *   2 真实无线/有线网卡（wlan× / wlp× / wifi× / en× / eth× 前缀）
 *   3 其他真实网卡
 *   4 虚拟网卡（docker/br-/veth/vmnet/tun/tap/wg…）
 *   5 link-local 169.254.*（最没用，无论接口名是什么）
 * 同分时无线优先于有线，再按接口名（码点序，不用 localeCompare——跨机器/locale 结果要稳定可测）。
 */

export interface LanAddressCandidate {
  iface: string
  addr: string
}

export interface LanAddressOptions {
  /** 默认路由出口 IP（非必须；start 时由 defaultRouteIp() 异步取得后传入缓存值） */
  defaultIp?: string
  /** 最近一次手机请求的来源 IP（非必须，用于同 /24 优先） */
  clientIp?: string
}

/**
 * 虚拟网卡特征。宁可误伤真实 bridge 排后，也不能让手机拿到 docker 地址 ——
 * 真网桥场景极少，且面板会展示全部地址供用户自选（排序只影响推荐位）。
 * 在旧 VIRTUAL_IFACE_RE 基础上补：br- / veth / virbr / podman / cni / flannel / utun / awdl / llw。
 */
const VIRTUAL_IFACE_RE = /br-|veth|virbr|podman|cni|flannel|docker|vmnet|vboxnet|vmware|virtualbox|vethernet|wsl|hyper[- ]?v|radmin|tailscale|zerotier|wireguard|wg[0-9]|tun|tap|utun|awdl|llw|loopback|virtual/i

export function isVirtualIface(name: string): boolean {
  return VIRTUAL_IFACE_RE.test(name)
}

/** 常见无线接口名（tie-break 用；只影响同分类内的先后，判错无实害） */
function isWirelessIface(name: string): boolean {
  return /^(wl|wlan|wlp|wifi)/i.test(name) || /wi-?fi/i.test(name)
}

/** IPv4 前三段（/24 网段）；非法输入返回空串 */
export function ipv4Prefix24(ip: string): string {
  const parts = ip.split('.')
  if (parts.length !== 4) return ''
  return parts.slice(0, 3).join('.')
}

function isLinkLocal(ip: string): boolean {
  return ip.startsWith('169.254.')
}

function scoreOf(c: LanAddressCandidate, opts: LanAddressOptions): number {
  if (opts.clientIp && ipv4Prefix24(c.addr) === ipv4Prefix24(opts.clientIp) && ipv4Prefix24(c.addr) !== '') return 0
  if (opts.defaultIp && c.addr === opts.defaultIp) return 1
  if (isLinkLocal(c.addr)) return 5
  if (isVirtualIface(c.iface)) return 4
  if (/^(wl|wlan|wlp|wifi|en|eth)/i.test(c.iface)) return 2
  return 3
}

/** 排序 + 按地址去重（同地址保留排名最高的一条） */
export function orderLanAddresses(list: LanAddressCandidate[], opts: LanAddressOptions = {}): LanAddressCandidate[] {
  const scored = list.map(c => ({ c, s: scoreOf(c, opts) }))
  scored.sort((a, b) =>
    a.s - b.s
    || (isWirelessIface(a.c.iface) ? 0 : 1) - (isWirelessIface(b.c.iface) ? 0 : 1)
    || (a.c.iface < b.c.iface ? -1 : a.c.iface > b.c.iface ? 1 : 0))
  const seen = new Set<string>()
  return scored.map(x => x.c).filter(c => (seen.has(c.addr) ? false : (seen.add(c.addr), true)))
}

/** 本机全部可作配对地址的 IPv4 候选（非内部 + 私网；去重交给 orderLanAddresses） */
export function getLanAddressCandidates(): LanAddressCandidate[] {
  const out: LanAddressCandidate[] = []
  for (const [iface, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (!isPrivateAddress(info.address)) continue
      out.push({ iface, addr: info.address })
    }
  }
  return out
}

/**
 * 默认路由出口 IP：UDP connect 只定路由不发包，address() 取源地址。
 * 注意 connect 是异步的，不能 connect 后同步 address()，必须等回调（否则拿到 0.0.0.0）。
 * 失败/离线 resolve undefined——调用方降级为无 defaultIp 的排序，不阻塞。
 */
export function defaultRouteIp(): Promise<string | undefined> {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4')
    let settled = false
    const done = (ip?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      try { s.close() } catch { /* 已关 */ }
      resolve(ip && ip !== '0.0.0.0' ? ip : undefined)
    }
    const guard = setTimeout(() => done(), 1500)
    s.once('error', () => done())
    s.connect(53, '8.8.8.8', () => {
      try { done(s.address().address) } catch { done() }
    })
  })
}
