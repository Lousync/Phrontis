/**
 * 「端点内的账号」纯规则（2026-10-13，零依赖）。
 *
 * 为什么单独一个文件：这些规则（迁移 / 取当前账号 / 可用性判定 / 对外脱敏）
 * 是"换账号不用重配、也不该把别人的 Key 用上"的**判据本身**，必须能被契约脚本
 * `真跑` 而不是拿源码文本猜。llmService 里 import 'electron'，裸 node 进不去 ——
 * 同 llmProtocolPure.ts / skillPackPure.ts 的既有做法。
 *
 * 三条不变量（契约负向断言锁的）：
 *   1. 切换 activeAccountId **不触碰** models 与 modelFamilies
 *      —— 模型 spec 是 `providerId:modelId`，指向端点 id，所以切账号不动任何模型槽位；
 *   2. 有账号时取 Key **只认当前账号**，绝不回退到别的账号（否则"切换"是摆设）；
 *   3. 对外形状**永不含密文**（只有 hasKey 这个布尔）。
 */

export interface ProviderAccount {
  id: string
  name: string
  /** 'enc1:' 密文（secretBox 机制），永不出主进程 */
  keyEncrypted: string
  enabled: boolean
  /** 最近一次「测试这个账号」的往返耗时与时间点（界面显示成「412ms · 2 分钟前」） */
  lastLatencyMs?: number
  lastTestedAt?: string
}

/** 账号宿主：只要这几个字段，避免把整个 ProviderConfig 类型拖进来 */
export interface AccountHost {
  type: string
  /** 旧口径的单 Key 字段（迁移来源 + 当前账号的兼容镜像） */
  apiKeyEncrypted: string
  accounts?: ProviderAccount[]
  activeAccountId?: string
}

/**
 * 旧记录迁移：只有 apiKeyEncrypted 的端点 → 生成首个账号并设为当前。
 * 用户拍板「现在没有用户，老记录直接退役都行」，所以只保留这一条保守迁移。
 * 返回是否发生改动（调用方据此决定要不要回写，避免每次读都写盘）。
 */
export function migrateProvider<T extends AccountHost>(p: T, newId: () => string): boolean {
  let changed = false
  if (!Array.isArray(p.accounts)) {
    p.accounts = []
    changed = true
    if (p.apiKeyEncrypted) {
      p.accounts.push({ id: newId(), name: '默认', keyEncrypted: p.apiKeyEncrypted, enabled: true })
    }
  }
  // 当前账号失效（被删 / 从未设）→ 退回第一个
  if (p.accounts.length > 0 && !p.accounts.some(a => a.id === p.activeAccountId)) {
    p.activeAccountId = p.accounts[0].id
    changed = true
  }
  return changed
}

/** 当前生效账号；没有账号时返回 undefined（此时调用方退回旧的单 Key 字段） */
export function activeAccountOf(p: AccountHost): ProviderAccount | undefined {
  const list = p.accounts ?? []
  if (list.length === 0) return undefined
  return list.find(a => a.id === p.activeAccountId) ?? list[0]
}

/**
 * 当前账号的**密文**（解密留在主进程）。
 * 有账号时只认当前账号那把 —— 不回退到别的账号，否则"切换"就成了摆设。
 */
export function activeAccountKeyEnc(p: AccountHost): string {
  const acct = activeAccountOf(p)
  if (acct) return acct.keyEncrypted
  return p.apiKeyEncrypted
}

/** 能在请求里真正拿来用的账号：启用 + 有 Key（本地模型不需要 Key） */
export function usableAccountsOf(p: AccountHost): ProviderAccount[] {
  return (p.accounts ?? []).filter(a => a.enabled && (a.keyEncrypted || p.type === 'ollama'))
}

/**
 * 端点整体可用 = 端点启用 且 至少一个账号可用。
 * 不可用端点的模型**不进入模型选择器** —— 避免"选得到却调不通"（原型里明写了这条因果）。
 * 没有 accounts 的旧记录按单 Key 判定，保证迁移前后行为一致。
 */
export function providerUsable(p: AccountHost & { enabled: boolean }): boolean {
  if (!p.enabled) return false
  if (!p.accounts || p.accounts.length === 0) return !!p.apiKeyEncrypted || p.type === 'ollama'
  return usableAccountsOf(p).length > 0
}

/** 对外形状：**永不含密文**，渲染层只拿得到 hasKey */
export function sanitizeAccountInfo(a: ProviderAccount) {
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    hasKey: !!a.keyEncrypted,
    lastLatencyMs: a.lastLatencyMs,
    lastTestedAt: a.lastTestedAt,
  }
}

/**
 * 新增一个账号并设为当前。用户的意图就是「换成这个账号」，所以直接切过去。
 * 返回新账号（调用方负责落盘）。
 */
export function appendAccount<T extends AccountHost>(
  p: T, payload: { name?: string; keyEncrypted: string }, newId: () => string,
): ProviderAccount {
  const name = String(payload.name ?? '').trim() || `账号 ${(p.accounts?.length ?? 0) + 1}`
  const acct: ProviderAccount = { id: newId(), name, keyEncrypted: payload.keyEncrypted, enabled: true }
  p.accounts = [...(p.accounts ?? []), acct]
  p.activeAccountId = acct.id
  p.apiKeyEncrypted = acct.keyEncrypted // 兼容镜像
  return acct
}

/** 删除一个账号；被删的若是当前账号则退回剩下的第一个。返回是否成功。 */
export function removeAccount<T extends AccountHost>(p: T, accountId: string): boolean {
  const before = p.accounts ?? []
  if (!before.some(a => a.id === accountId)) return false
  p.accounts = before.filter(a => a.id !== accountId)
  if (p.accounts.length > 0 && !p.accounts.some(a => a.id === p.activeAccountId)) {
    p.activeAccountId = p.accounts[0].id
  }
  if (p.accounts.length === 0) p.activeAccountId = undefined
  p.apiKeyEncrypted = activeAccountOf(p)?.keyEncrypted ?? ''
  return true
}
