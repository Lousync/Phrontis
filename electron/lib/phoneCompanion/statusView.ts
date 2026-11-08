import { buildPairUrl } from './protocol.ts'
import { orderLanAddresses, isVirtualIface, type LanAddressCandidate } from '../lanShare/addresses.ts'
import type { CompanionPairRequestView } from './server.ts'

/* 相对导入显式带 .ts：契约脚本以 node --experimental-strip-types 直跑本文件（零 electron 依赖）。 */

/**
 * CompanionStatus 的纯视图构建器（2026-11-08，配对链路修复 WP1/WP7）。
 *
 * 为什么抽出来：status() 的 urls / addresses / pairCode 三者有一致性约束——
 * 「urls 绝不嵌过期配对码」（旧实现 code?.code 不看 expiresAt，码过期后二维码仍显示旧码，
 * 手机扫了必然 401）。约束放主进程闭包里契约测不到，抽成纯函数直接喂输入断言输出。
 *
 * 规格冻结于 Phrontis-mobile 仓 docs/handoff-pairing-hotspot-repair.md §4.3 第四步 / §10。
 */

/** 地址明细（面板「手机可访问的地址」列表数据源） */
export interface CompanionAddressInfo {
  ip: string
  iface: string
  /** 虚拟网卡（docker / br- / veth / vmnet / tun …），手机通常不可达 */
  virtual: boolean
  /** 推荐位（排序第一名且服务运行中） */
  recommended: boolean
}

export interface StatusViewInput {
  running: boolean
  port: number
  /** 本机候选地址（原始收集，排序在此内做） */
  candidates: LanAddressCandidate[]
  /** 当前配对码；null / 已过期均不进 urls */
  pairCode: { code: string; expiresAt: number } | null
  /** 待确认配对请求视图（过期项被过滤） */
  pendingPairs: CompanionPairRequestView[]
  /** 默认路由出口 IP（可选，第二优先级） */
  defaultIp?: string
  /** 最近一次手机来源 IP（可选，同 /24 第一优先级） */
  clientIp?: string
  now?: number
}

export interface StatusView {
  /** 全部可用地址的配对链接，按推荐顺序；无有效配对码时 hash 为空（**绝不嵌过期码**） */
  urls: string[]
  /** = urls[0]，二维码 / 默认选中用 */
  recommendedUrl: string
  addresses: CompanionAddressInfo[]
  /** 8 位配对码；过期 / 未运行为空串 */
  pairCode: string
  /** 原始过期时刻（保留旧口径：过期后面板倒计时归零显示「已过期」） */
  pairCodeExpiresAt: number
  /** 过滤后的待确认请求 */
  pendingPairs: CompanionPairRequestView[]
}

export function buildStatusView(input: StatusViewInput): StatusView {
  const now = input.now ?? Date.now()
  const validCode = input.pairCode && input.pairCode.expiresAt > now ? input.pairCode.code : ''
  const ordered = input.running
    ? orderLanAddresses(input.candidates, { defaultIp: input.defaultIp, clientIp: input.clientIp })
    : []
  const urls = ordered.map(c => buildPairUrl(c.addr, input.port, validCode))
  return {
    urls,
    recommendedUrl: urls[0] ?? '',
    addresses: ordered.map((c, i) => ({
      ip: c.addr,
      iface: c.iface,
      virtual: isVirtualIface(c.iface),
      recommended: input.running && i === 0,
    })),
    pairCode: validCode,
    pairCodeExpiresAt: input.pairCode?.expiresAt ?? 0,
    pendingPairs: input.pendingPairs.filter(p => p.expiresAt > now),
  }
}
