/**
 * Plugin Host Gateway（v2 协议，v3 沙箱统一出口）—— 主进程唯一裁决点。
 *
 * v2 诊断的三处错层问题在此收口：
 *   - 裁决点单一化：渲染层 PluginFrame 不再做 grantedRef.includes(...) 判断，一切
 *     postMessage → `host:rpc` → 本模块裁决 → 执行。
 *   - token 标识身份：iframe/Worker 走宿主 ipcRenderer，sender 无法区分插件；一次性
 *     bridge token（32 字节随机）绑定 pluginId + 能力快照，伪造即 EBRIDGE。
 *   - 并发配对：请求带 `id`，回包同 id，杜绝 v1 同名 action 串台。
 *
 * 纯逻辑模块（不 import electron/pluginRegistry），依赖全部由 createGateway 注入：
 *   - sessionState(id)      → { enabled, capabilities } | null    判断安装/启用/授权
 *   - methodTable           → 方法路由表（命名空间 → capability → 执行函数）
 *   - audit(id, action, detail)                                  审计钩子
 * 这样可直接 node 冒烟（对标 resolveSafe/mergeSimulation 写法），
 * 也便于将来 v3 的 code 插件 Worker 通道复用同一会话与裁决链。
 */

/** 请求报文的 method 语义：`kb.<ns>.<action>`，ns 决定所需 capability */
export interface GatewayMethodDef {
  /** 执行所需 capability（与 manifest.capabilities / grantedCapabilities 匹配）。
   *  空串 = 免授权方法（如 toast，对齐 v1 无需授权语义）。 */
  capability: string
  /** 方法执行器。params 为已通过基础类型校验的参数对象。 */
  run: (ctx: GatewayCtx, params: unknown) => Promise<unknown> | unknown
}

export interface GatewayCtx {
  /** 由 token 解析出的真实插件 id（插件自报一律不信） */
  pluginId: string
  /** 会话期能力快照（open 时刻） */
  capabilities: string[]
  /** manifest.vaultScope 快照（写路径收敛前缀；未声明 = 全库可写） */
  vaultScope?: string[]
}

export interface GatewaySession {
  token: string
  pluginId: string
  capabilities: string[]
  vaultScope?: string[]
  createdAt: number
}

export interface GatewayDeps {
  /** 查插件当前安装/启用/授权状态；未安装返回 null */
  sessionState(pluginId: string): { enabled: boolean; capabilities: string[]; vaultScope?: string[] } | null
  /** 方法路由表：`kb.data.query` → { capability:'data', run } 等 */
  methods: Record<string, GatewayMethodDef>
  /** 审计钩子（写 plugin_audit_log） */
  audit?(pluginId: string, action: string, detail: Record<string, unknown>): void
  /** token 生成器（默认 randomBytes；测试可注入固定值） */
  generateToken?(): string
  /** 会话终结钩子（plugin-phase1-design C4）：close/重开替换/全清时通知（事件订阅清理用） */
  onSessionClosed?(pluginId: string): void
}

export type RpcResult =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string }

/** rpc 可能异步返回（async 方法执行器） */
export type RpcResultLike = RpcResult | Promise<RpcResult>

const TOKEN_RE = /^[0-9a-f]{64}$/

export function createGateway(deps: GatewayDeps) {
  const sessions = new Map<string, GatewaySession>()
  const generateToken = deps.generateToken ?? (() => randomToken())

  /** 打开会话：校验插件状态 → 发 token（幂等：同插件旧 token 失效，防悬挂会话） */
  function open(pluginId: string): { ok: true; token: string } | { ok: false; code: string; message: string } {
    if (!pluginId || !/^[a-z0-9][a-z0-9._-]*$/.test(pluginId)) return { ok: false, code: 'EPARAM', message: '插件 id 非法' }
    const state = deps.sessionState(pluginId)
    if (!state) return { ok: false, code: 'ENOTFOUND', message: '插件未安装' }
    if (!state.enabled) return { ok: false, code: 'EDISABLED', message: '插件已禁用' }
    // 同插件重开：清旧会话（frame 意外未 close 的场景兜底）
    for (const [t, s] of sessions) {
      if (s.pluginId === pluginId) {
        sessions.delete(t)
        deps.onSessionClosed?.(pluginId)
      }
    }
    const token = generateToken()
    sessions.set(token, { token, pluginId, capabilities: state.capabilities, vaultScope: state.vaultScope, createdAt: Date.now() })
    return { ok: true, token }
  }

  /** 关闭会话（frame 卸载/宿主重启全清走 closeAll） */
  function close(token: string): void {
    const s = sessions.get(token)
    sessions.delete(token)
    if (s) deps.onSessionClosed?.(s.pluginId)
  }

  /** 宿主重启/应用退出时全清 */
  function closeAll(): void {
    const closed = [...sessions.values()]
    sessions.clear()
    for (const s of closed) deps.onSessionClosed?.(s.pluginId)
  }

  /** 会话数量（测试/诊断） */
  function sessionCount(): number { return sessions.size }

  /** token → 会话；无效返回 null（含格式非法） */
  function resolve(token: unknown): GatewaySession | null {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null
    return sessions.get(token) ?? null
  }

  /**
   * 裁决链（任一失败短路，对照 v2 文档 §7.1）：
   * token 有效 → 会话存在 → 插件仍启用（实时复查，防装后禁用）→ method 存在
   *   → method 所需 capability 在会话能力快照中 → 执行
   */
  function rpc(token: unknown, method: unknown, params: unknown): RpcResultLike {
    const session = resolve(token)
    if (!session) return { ok: false, code: 'EBRIDGE', message: '无效或过期的会话 token' }
    // 实时复查插件仍启用（session 是快照，禁用后能力即收回）
    const live = deps.sessionState(session.pluginId)
    if (!live || !live.enabled) {
      sessions.delete(session.token)
      return { ok: false, code: 'EDISABLED', message: '插件已禁用' }
    }
    if (typeof method !== 'string' || !method.startsWith('kb.')) return { ok: false, code: 'EPARAM', message: 'method 需为 kb.<ns>.<action>' }
    const def = deps.methods[method]
    if (!def) return { ok: false, code: 'EPARAM', message: `未知方法: ${method}` }
    if (def.capability && !session.capabilities.includes(def.capability)) {
      deps.audit?.(session.pluginId, 'deny', { method, code: 'ECAPABILITY', need: def.capability })
      return { ok: false, code: 'ECAPABILITY', message: `缺少能力: ${def.capability}` }
    }
    try {
      const ctx: GatewayCtx = { pluginId: session.pluginId, capabilities: session.capabilities, vaultScope: session.vaultScope }
      const result = def.run(ctx, params)
      // 同步/异步统一：同步直接返回，异步则补 then（错误转 RpcResult）
      if (result instanceof Promise) {
        return result.then(
          (r): RpcResult => {
            deps.audit?.(session.pluginId, method, { ok: true })
            return { ok: true, result: r }
          },
          (err): RpcResult => rpcError(session.pluginId, deps, method, err),
        )
      }
      deps.audit?.(session.pluginId, method, { ok: true })
      return { ok: true, result }
    } catch (err) {
      return rpcError(session.pluginId, deps, method, err)
    }
  }

  return { open, close, closeAll, sessionCount, resolve, rpc }
}

function rpcError(pluginId: string, deps: GatewayDeps, method: string, err: unknown): RpcResult {
  const code = (err as { code?: string })?.code || 'EINTERNAL'
  const message = code === 'EINTERNAL'
    ? '宿主内部错误'
    : String((err as Error)?.message || err)
  deps.audit?.(pluginId, method, { ok: false, code })
  return { ok: false, code, message }
}

export function randomToken(): string {
  // 主进程可注入 crypto；此处动态 require 保持模块纯逻辑可测（node 环境注入见 smoke）
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.randomBytes(32).toString('hex')
}

export type Gateway = ReturnType<typeof createGateway>

