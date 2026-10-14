import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 存量「全局 AI 会话」→ 仓库的一次性认领（2026-10-13 拍板：会话随仓库走）。
 *
 * 背景：AI 会话原本存 `userData/data/`（去库化前是全局 `knowledge.db` 的一张表），
 * 于是「一个应用一份会话」，切仓库仍看得到别的仓库的对话。拍板改为随仓库：
 * `<仓库>/.knowbase/agent/sessions.json` + `messages/<sessionId>.jsonl`。
 * 本模块负责把升级前攒在全局目录里的会话**不丢地**搬进仓库。
 *
 * 设计要点：
 * - **零相对 import**（只用 `fs` / `path`）。这不是洁癖：契约脚本用
 *   `node --experimental-strip-types` 直接 import 本文件，而 node 的 ESM 不做扩展名补全，
 *   内部一旦出现 `./xxx`（无扩展名）就 ERR_MODULE_NOT_FOUND（同 `releaseNotes/judge.ts` 的理由）。
 *   因此路径也一律由调用方注入，不在模块内 import 任何 app 级模块。
 * - **幂等**：认领成功的标志是全局 `agent-sessions.json` 被改名。改名后再次调用直接返回
 *   `{ adopted: false }` —— 所以**不会**给第二个仓库复制一份。
 * - **原文件不删**：全局侧一律改名 `*.migrated.json` 留存（对齐 `agentMessageStore` 的
 *   v1 迁移先例），出错时原文件原封不动。
 * - **不解析消息正文**（正常路径）：jsonl 逐文件按字节拷贝 + 校验 size 相等。
 *   只有「目标已存在、需要按 id 合并」这条重试路径才解析，且解析失败**抛错**而不是跳行
 *   —— 跳过损坏行等于事后把源文件改名，那条消息就永久消失了。
 * - v1 的 `agent-messages.json`（全体消息一个文件）**原样拷进**仓库目录，交给既有的
 *   `agentMessageStore.migrateLegacyMessages()` 拆分，不在此重复实现一遍拆分与校验逻辑。
 *
 * 会话来源（source）与支线（lane / sideContext）等字段原样搬运，不做任何改写。
 */

const SESSIONS_SRC = 'agent-sessions.json'
const SESSIONS_DST = 'sessions.json'
const MESSAGES_DIR_SRC = 'agent-messages'
const MESSAGES_DIR_DST = 'messages'
/** v1 全量消息文件（与本模块同层；拷贝后由 migrateLegacyMessages 拆分） */
const LEGACY_V1 = 'agent-messages.json'

export interface AdoptResult {
  /** 本次是否真的搬了东西（false = 没有可认领的存量，或出错） */
  adopted: boolean
  /** 认领的会话条数 */
  sessions: number
  /** 认领的消息条数（正常路径由各 jsonl 行数累加；行数不解析、按换行计） */
  messages: number
  /** 出错原因；无值且 adopted=false = 本来就没有存量数据 */
  error?: string
}

/** 统计 jsonl 行数（不解析内容；空行不计） */
function countLines(path: string): number {
  const body = readFileSync(path, 'utf-8')
  let n = 0
  for (const line of body.split('\n')) if (line.trim()) n++
  return n
}

/** 读 JSON 数组；结构不对返回 null（调用方决定是抛错还是跳过） */
function readArray(path: string): unknown[] | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

/** 改名留存：目标已存在时先删目标再改名（Windows rename 不覆盖） */
function renameAside(src: string, dst: string): void {
  try {
    renameSync(src, dst)
  } catch {
    if (existsSync(dst)) {
      try { unlinkSync(dst) } catch { /* 旧留存文件删不掉不阻断（下一步 rename 会再报错） */ }
    }
    renameSync(src, dst)
  }
}

/**
 * 把全局会话目录里的存量搬进仓库 `agentDir`。
 * 调用方负责提供绝对路径（`globalDataDir()` 与 `<仓库>/.knowbase/agent`），
 * 主进程侧由 `vaultContext.setCurrentVault()` 触发，脚本侧直接构造临时目录。
 */
export function adoptLegacyGlobalAgentStore(opts: { globalDir: string; vaultAgentDir: string }): AdoptResult {
  const { globalDir, vaultAgentDir } = opts
  const srcSessions = join(globalDir, SESSIONS_SRC)
  // 幂等闸门：没有全局会话索引 = 已经认领过（或从未有过会话）
  if (!existsSync(srcSessions)) return { adopted: false, sessions: 0, messages: 0 }

  const srcRows = readArray(srcSessions)
  if (!srcRows) {
    // 损坏的索引绝不能「搬过去+改名」——那等于把数据搬没了。抛错，原文件原封不动。
    throw new Error(`全局会话索引解析失败，拒绝认领（原文件保留）：${srcSessions}`)
  }

  mkdirSync(vaultAgentDir, { recursive: true })
  const dstSessions = join(vaultAgentDir, SESSIONS_DST)
  const dstMessagesDir = join(vaultAgentDir, MESSAGES_DIR_DST)

  // ---- 1. 会话索引：目标已存在则按 id 合并（重试路径），否则直接拷 ----
  if (!existsSync(dstSessions)) {
    copyFileSync(srcSessions, dstSessions)
  } else {
    const dstRows = readArray(dstSessions)
    if (!dstRows) throw new Error(`仓库会话索引损坏，拒绝合并（原文件保留）：${dstSessions}`)
    const idOf = (r: unknown): string =>
      r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string' ? (r as { id: string }).id : ''
    const seen = new Set(srcRows.map(idOf).filter(Boolean))
    const merged = [...srcRows, ...dstRows.filter((r) => !seen.has(idOf(r)))]
    writeFileSync(dstSessions, JSON.stringify(merged, null, 2), 'utf-8')
  }

  // 校验：源里每一条会话都必须出现在落盘结果里（缺一条即失败，全局侧不动）
  const written = readArray(dstSessions)
  if (!written) throw new Error(`认领后校验失败：仓库会话索引不可读 ${dstSessions}`)
  const writtenIds = new Set(
    written
      .map((r) => (r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string' ? (r as { id: string }).id : ''))
      .filter(Boolean),
  )
  for (const r of srcRows) {
    const id = r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string' ? (r as { id: string }).id : ''
    if (!id || !writtenIds.has(id)) throw new Error(`认领校验失败：会话 ${id || '(无 id)'} 未落盘`)
  }

  // ---- 2. 消息：逐会话 jsonl 拷贝（已存在则按 id 合并） ----
  let messages = 0
  const srcMessagesDir = join(globalDir, MESSAGES_DIR_SRC)
  if (existsSync(srcMessagesDir)) {
    mkdirSync(dstMessagesDir, { recursive: true })
    for (const name of readdirSafe(srcMessagesDir)) {
      if (!name.endsWith('.jsonl')) continue
      const src = join(srcMessagesDir, name)
      const dst = join(dstMessagesDir, name)
      if (!existsSync(dst)) {
        copyFileSync(src, dst)
        // 不解析正文，用字节数校验「没拷丢」
        if (statSync(src).size !== statSync(dst).size) {
          throw new Error(`消息文件拷贝校验失败（大小不一致）：${name}`)
        }
        messages += countLines(dst)
        continue
      }
      messages += mergeJsonl(src, dst, name)
    }
  }

  // ---- 3. v1 全量消息文件：原样拷入，交给 agentMessageStore.migrateLegacyMessages 拆分 ----
  const srcLegacy = join(globalDir, LEGACY_V1)
  if (existsSync(srcLegacy)) {
    const dstLegacy = join(vaultAgentDir, LEGACY_V1)
    if (!existsSync(dstLegacy)) copyFileSync(srcLegacy, dstLegacy)
  }

  // ---- 4. 全部校验通过，才把全局侧改名留存 ----
  renameAside(srcSessions, join(globalDir, `${SESSIONS_SRC}.migrated.json`))
  if (existsSync(srcLegacy)) renameAside(srcLegacy, join(globalDir, 'agent-messages.migrated.json'))
  if (existsSync(srcMessagesDir)) {
    const dstDir = join(globalDir, 'agent-messages.migrated')
    try {
      if (existsSync(dstDir)) {
        for (const n of readdirSafe(dstDir)) {
          try { unlinkSync(join(dstDir, n)) } catch { /* 逐个清，清不掉的让 rename 去报错 */ }
        }
      }
      renameSync(srcMessagesDir, dstDir)
    } catch {
      // 目录改名失败不致命：索引已改名 ⇒ 幂等闸门已关，不会重复认领；
      // 残留目录只是留了份副本（正是「不删用户数据」的取向）。
    }
  }

  return { adopted: true, sessions: srcRows.length, messages }
}

/** 目标已存在时的按 id 合并（重试路径）；损坏行抛错，不静默丢消息 */
function mergeJsonl(src: string, dst: string, name: string): number {
  const parse = (path: string): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = []
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        throw new Error(`消息文件存在损坏行，拒绝合并以免丢消息：${name}`)
      }
      if (obj && typeof obj === 'object') out.push(obj as Record<string, unknown>)
    }
    return out
  }
  const srcRows = parse(src)
  const dstRows = parse(dst)
  const idOf = (r: Record<string, unknown>): string => (typeof r.id === 'string' ? r.id : '')
  const seen = new Set(srcRows.map(idOf).filter(Boolean))
  const merged = [...srcRows, ...dstRows.filter((r) => !seen.has(idOf(r)))]
  writeFileSync(dst, merged.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
  return merged.length
}

/** readdir 的容错包装（目录不可读视为空，不阻断认领） */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
