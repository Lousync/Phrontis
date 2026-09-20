import { watch, type FSWatcher } from 'fs'
import { relative } from 'path'
import { getCurrentVault } from './kbStore/vaultContext'
import { invalidateKnowledgeIndex } from './kbStore/knowledgeIndex'
import { invalidateGraphIndex } from './kbStore/graphIndex'
import { broadcast, broadcastDataChanged, BROADCAST_CHANNEL } from '../main/windowBus'

/**
 * 仓库级文件系统监听（v3.2.0 条目 ④）——对标 VS Code 的 file watcher。
 *
 * 目标：资源管理器 / 外部编辑器 / git 切分支对仓库目录做的增删改名，编辑器文件树与
 * AI 教学右栏能**及时**反映，不需要重启应用、也不需要先做一次应用内操作才看得到。
 *
 * 三条设计决定（细节见 DP `Phrontis/更新计划/v3.2.0.md` 条目 4）：
 *
 * 1. **只取「有东西变了」这一个信号，拉取式刷新**。不解析事件类型、不维护文件树 diff、
 *    不做逐项增删动效。理由：`ws:listDir` 在 workspaceManager 侧**没有任何缓存**（每次调用
 *    实时 readdir），所以「刷新」= 让渲染层按已加载目录重拉一次即可，主进程侧无需失效逻辑。
 *    这也是本功能成本低的最大原因。
 *
 * 2. **Node 原生 `fs.watch({ recursive: true })`，不引 chokidar**。Windows 上原生映射到
 *    `ReadDirectoryChangesW`（OS 原生变更通知，不是轮询）且支持 recursive；本项目要的只是
 *    「变了」这一位信息，用不到精确的 add/unlink 语义，原生足够。
 *    平台行为已实测（探针 `.AGENT/scripts/editor/probes/probe-fs-watch-recursive.cjs`，2026-09-15）：
 *      · recursive 可用；`filename` 是**仓库根相对路径**（反斜杠，深层带完整链路，如 `notes\deep\a.md`）；
 *      · 目录变更**也会**以目录自身为 filename 上报（`notes\deep`），故忽略与抑制都按段匹配；
 *      · 原子写形成事件对：`.kb-tmp-*` 的 rename/change + 目标文件的 rename + 父目录 change
 *        → `.kb-tmp-*` 必须忽略、目标文件必须自写抑制（父目录那条不会命中冲突判定，属无害重复重扫）；
 *      · `.knowbase/` 内部写入**照样发事件** → 忽略规则必须自己过滤，不能指望平台不发。
 *
 * 3. **自写抑制必须有**。应用内写盘（编辑器保存 / AI 写工具 / 归档双态）同样会触发 watcher；
 *    不抑制时最刺眼的后果是「自己保存 → 弹『文件已被外部修改』三选」这种自打自脸误报。
 *    批量重扫本身幂等（多做一次 readdir 无害），所以抑制的唯一硬需求就是**保护冲突三选不被误触发**。
 *
 * 失败降级：仓库根被外部删除 / 移走 / 不可读，或 UNC 网络盘上 fs.watch 整体不工作时，
 * 这里只关掉 watcher 并如实上报一次，**绝不掀翻主进程**；渲染层仍保留「窗口聚焦回读」与
 * 「手动刷新资源管理器」两层兜底。
 */

/** 防抖窗口：jsonStore 原子写与编辑器保存会成对产生事件，窗口太短会重复刷、太长会「看起来不实时」 */
const DEBOUNCE_MS = 300

/** 自写抑制的存活时长：覆盖一次落盘（临时文件写入 + rename 覆盖）到事件抵达主进程的时延 */
const SELF_WRITE_TTL_MS = 1500

/** 不监听任何名字命中这些规则的路径（**不用 .ignore 规则过滤** —— 那是知识库扫描语义，铁律 6） */
const IGNORED_SEGMENTS = new Set(['.knowbase', '.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

let watcher: FSWatcher | null = null
let watchedRootPath: string | null = null
let watchedRootId: string | null = null
let flushTimer: NodeJS.Timeout | null = null
let degradedNoticeSent = false
const pending = new Set<string>()
const selfWritePaths = new Map<string, number>()

/** 忽略判定：路径任一段命中忽略集，或是原子写的临时物（`.kb-tmp-*` / `*.tmp`） */
function isIgnoredRel(rel: string): boolean {
  if (!rel) return true
  for (const seg of rel.split('/')) {
    if (!seg) continue
    if (IGNORED_SEGMENTS.has(seg)) return true
    if (seg.startsWith('.kb-tmp-')) return true
    if (seg.toLowerCase().endsWith('.tmp')) return true
  }
  return false
}

/** 仓库内 posix 相对路径；不在仓库内（或算不出）时返回 '' */
function relOf(rootPath: string, absPath: string): string {
  const rel = relative(rootPath, absPath).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return ''
  return rel
}

/**
 * 应用内写盘登记（workspaceManager.writeWorkspaceFile 落盘前调用）。
 *
 * 语义 = 「这条路径上即将发生/刚刚发生的变更出自我自己」。watcher 命中且未过期即跳过，
 * 于是不会走广播 → 渲染层不会把「自己保存」误判成「外部修改」而弹冲突三选。
 */
export function markSelfWrite(absPath: string): void {
  const cur = getCurrentVault()
  if (!cur) return
  const rel = relOf(cur.rootPath, absPath)
  if (!rel) return
  const now = Date.now()
  selfWritePaths.set(rel, now + SELF_WRITE_TTL_MS)
  // 顺手清过期项（Map 常态是个位数，超过阈值才扫，避免每次写盘都遍历）
  if (selfWritePaths.size > 200) {
    for (const [key, expireAt] of selfWritePaths) {
      if (expireAt <= now) selfWritePaths.delete(key)
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flush, DEBOUNCE_MS)
  // watcher 与定时器都不该拖住进程退出（退出路径另有 closeVaultWatcher 兜底）
  flushTimer.unref?.()
}

function flush(): void {
  flushTimer = null
  const cur = getCurrentVault()
  // 切仓库窗口期到达的旧仓库事件：直接丢弃，避免串味
  if (!cur || cur.rootId !== watchedRootId) {
    pending.clear()
    return
  }
  const relPaths = [...pending]
  pending.clear()
  // 副作用：知识索引 / 图谱失效 + 知识库刷新。口径 (b) 全量、一期无条件失效（简单可控；
  // 若大仓库实测卡顿，再收窄为「本次确有 .md 变动才失效」）。知识库已有 useDataChanged 消费端。
  try {
    invalidateKnowledgeIndex()
    invalidateGraphIndex()
  } catch {
    /* 索引未就绪等：忽略，不因缓存的副作用影响刷新 */
  }
  // 归档清单僵尸条目的 GC 随归档退役移除（2026-09-20 阶段三，docs/note-identity-unify-design.md §3）
  broadcastDataChanged('knowledge')
  broadcast(BROADCAST_CHANNEL.wsFsChanged, { relPaths })
}

function onFsEvent(filename: string | Buffer | null): void {
  if (!watchedRootPath || !watchedRootId) return
  const cur = getCurrentVault()
  if (!cur || cur.rootId !== watchedRootId) return
  if (filename != null) {
    const rel = String(filename).replace(/\\/g, '/')
    if (isIgnoredRel(rel)) return
    const expireAt = selfWritePaths.get(rel)
    if (expireAt && expireAt > Date.now()) return
    pending.add(rel)
  }
  scheduleFlush()
}

/** 失败降级：关掉 watcher、如实上报一次，剩下的交给焦点兜底与手动刷新 */
function degrade(reason: string): void {
  try {
    watcher?.close()
  } catch {
    /* ignore */
  }
  watcher = null
  watchedRootPath = null
  watchedRootId = null
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending.clear()
  if (degradedNoticeSent) return
  degradedNoticeSent = true
  try {
    broadcast(BROADCAST_CHANNEL.wsFsChanged, { relPaths: [], watcherError: reason || 'unknown' })
  } catch {
    /* ignore */
  }
}

/** 关闭当前 watcher（退出应用 / 离开仓库 / 重挂前） */
export function closeVaultWatcher(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending.clear()
  if (watcher) {
    try {
      watcher.close()
    } catch {
      /* ignore */
    }
    watcher = null
  }
  watchedRootPath = null
  watchedRootId = null
}

/**
 * 让 watcher 对准**当前**仓库（幂等）。
 *
 * 调用点：仓库登记（adoptVaultDirectory）、按 id 打开（ws:openById）、启动恢复（loadVaults）、
 * 以及删除/退出仓库之后（此时 getCurrentVault() 已为 null → 自动关闭）。
 * 因为函数读的是「当前状态」而非参数，即使某处漏调，后续任何一处调用都会自我纠正。
 */
export function syncVaultWatcher(): void {
  const cur = getCurrentVault()
  const nextPath = cur?.rootPath ?? null
  const nextId = cur?.rootId ?? null
  if (nextPath === watchedRootPath && nextId === watchedRootId && (!nextPath || watcher)) return
  closeVaultWatcher()
  if (!cur || !nextPath) return
  try {
    watcher = watch(nextPath, { recursive: true, persistent: false })
    // 事件入口：filename 在 Windows 上是「仓库根相对路径」（反斜杠分隔），拼不出时为 null
    watcher.on('change', (_eventType: string, filename: string | Buffer | null) => onFsEvent(filename))
    watcher.on('error', (err: Error) => degrade(err?.message ?? String(err)))
    watchedRootPath = nextPath
    watchedRootId = cur.rootId
  } catch (e) {
    degrade((e as Error).message)
  }
}
