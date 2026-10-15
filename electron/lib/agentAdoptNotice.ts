import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { globalDataDir, globalReadJson, globalWriteJson } from './globalJsonStore'

/**
 * 存量会话认领的**一次性告知**（2026-10-13：AI 会话改为随仓库走）。
 *
 * 为什么不做成「主进程当场广播 Toast」：认领发生在「仓库成为当前仓库」那一刻，而切换仓库
 * 的渲染层收尾是 `location.reload()`（见 src/components/shared/VaultSwitcher.tsx 的
 * `reloadInto`，350ms 后整窗重载）。当场广播的 Toast 会被这次重载直接抹掉 —— 用户什么也看不到。
 *
 * 所以落成 userData/data 下的**待取文件**：主进程认领完写一次，渲染层启动后主动取一次、
 * 取走即删。文件里留着内容直到被取走，跨重载、跨重启都不丢。
 *
 * 同理不用 `broadcast()` 一遍了事：`windowBus` 的广播没有「窗口还没起来」的兜底，
 * 而本机制只在**有人来取**时才消失 —— 与 releaseNotes 的「页面成功展示后才推进基线」同一取向。
 *
 * 文件名与载荷形状的唯一真相源在这里，读端（agentService 的 IPC）不得另写一份。
 */

const NOTICE_FILE = 'agent-adopt-notice.json'

export interface AdoptNotice {
  /** 认领的会话条数 */
  sessions: number
  /** 认领的消息条数 */
  messages: number
  /** 落点仓库展示名（Toast 里点名，用户才知道搬到哪了） */
  vaultName: string
  /** 认领时间（ISO） */
  at: string
}

/** 写待取告知（覆盖写：同一进程只可能认领一次，多次调用以最后一次为准） */
export function writeAdoptNotice(info: Omit<AdoptNotice, 'at'>): void {
  globalWriteJson(NOTICE_FILE, { ...info, at: new Date().toISOString() })
}

/** 取走告知（**取走即删**，只会被展示一次）；没有则返回 null */
export function takeAdoptNotice(): AdoptNotice | null {
  const raw = globalReadJson<AdoptNotice | null>(NOTICE_FILE, null)
  if (!raw) return null
  try {
    const p = join(globalDataDir(), NOTICE_FILE)
    if (existsSync(p)) unlinkSync(p)
  } catch {
    // 删不掉就留着：下次启动会再展示一次（宁可重复一次，也不要谎报「已告知」）
  }
  return raw
}
