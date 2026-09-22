import { createHash, randomUUID } from 'node:crypto'
import {
  createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync,
  type WriteStream,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ClientRequest } from 'electron'
import { broadcast, broadcastDataChanged, BROADCAST_CHANNEL } from '../../main/windowBus'
import { getCurrentVault } from '../kbStore/vaultContext'
import { bookExtOf, type BookExt } from '../kbStore/bookFormats'
import { BOOKS_DIR, bookCoverRelFor, safeBookFileName } from '../kbStore/bookMarketSchema'
import { bookSourceCredentialFor, bookSourceGet } from '../kbStore/bookSourceVaultRepo'
import {
  bookCoverDelete, bookMetaGet, bookMetaReadAll, bookMetaUpsert, ensureBookCoversDir,
} from '../kbStore/vaultBookMetaRepo'
import { openBookRequest } from './netSession'
import { authHeaderFor } from './sourceClient'

/**
 * 书市 · 下载与上架（方案 §4.1–§4.3 / 拍板 ⑩⑪⑬）。
 *
 * 职责：队列（并发恒 1）→ 流式下载（`Range` 续传）→ 落盘 → 封面 → 元数据 → 广播。
 *
 * ★★ 五条不许破的线：
 *   ① **绝不碰 defaultSession 的代理**：所有请求（含封面）都走 `openBookRequest`，
 *      那是书市分区的唯一入口（`netSession.ts` 头注解释得很清楚）。
 *   ② **凭据只进 `Authorization` 头**：`authHeaderFor` 是凭据唯一的读取点
 *      （从 `sourceClient` 复用，**不在这里再写一份 base64 拼装**）。
 *      错误文案一律只拼 hostname + 状态码 —— 绝不带 URL 全量 / 请求头。
 *   ③ **落盘先写 `.part`，成功了才 `rename` 到书名**：`scanVaultBooks` 是按**扩展名**收书的
 *      （`bookKindOf`），半截的 `.epub` 会被当成一本真书挂上书架、点开必崩。
 *      `.part` 结尾接不上任何 `BOOK_EXTS` ⇒ 扫描天然跳过；顺带它就是**续传的锚点**
 *      （`Range: bytes=<.part 大小>-`）。
 *   ④ **三道闸在下载前判**（§4.3）：格式（`BOOK_EXTS`，不在列直接拒）/ 体积
 *      （`sizeBytes` 预检 + 响应 `Content-Length` 复核）/ 重名（`.books/` 里已有 → 交回渲染层
 *      让用户选「覆盖 / 另存副本」，**不静默覆盖**）。
 *   ⑤ **队列是内存态**（拍板 ⑬）：重启即清，不入盘；并发**恒为 1**。
 *
 * ★ 失败自动重试**仅 1 次**，且**凭据类失败不重试**（401/403 重试一万次还是 401，
 *   只会让用户多等 —— 与 `sourceClient.fetchFeedRetry` 同一口径，`DownloadError.kind` 分档）。
 */

/**
 * 整本落盘上限。
 * ★ 它与渲染层的引擎硬上限**同值**（`src/components/shared/epub/EpubReaderView.tsx` 的
 *   `MAX_BOOK_BYTES`：foliate 的 zip 解包要全量字节，超限那边直接抛错）。
 *   渲染层不引主进程模块（主进程也不引 src），故这是**两处同值**、改动必须成对 ——
 *   `.AGENT/scripts/book-market/verify-downloader.mjs` 有静态断言锁这条。
 *   在这里挡住的收益：别下完 200MB 才在阅读器里报错。
 */
export const MAX_BOOK_BYTES = 128 * 1024 * 1024

/** 封面是缩略图级别的资源：超过这个数基本可以断定抓到的不是封面（可能是整个 HTML 页） */
export const MAX_COVER_BYTES = 4 * 1024 * 1024

/** 进度节流（与 `updateService` 同一口径：字节增量 ≥256KB 或 距上次 ≥200ms 才推一个事件） */
const PROGRESS_MIN_BYTES = 256 * 1024
const PROGRESS_MIN_INTERVAL_MS = 200

/** 等响应头的超时（连接建不起来就别耗着用户） */
const CONNECT_TIMEOUT_MS = 20_000
/** 空闲看门狗：这么久一个字节都没来 ⇒ 判停滞失败（不是「慢」，是「死了」） */
const IDLE_TIMEOUT_MS = 30_000

/** 自动重试上限（拍板 ⑬：失败自动重试 1 次） */
const RETRY_LIMIT = 1
/** 「另存副本 (n)」往上找的上限，超了改用时间戳后缀（避免为一个名字转 1000 圈） */
const COPY_SUFFIX_MAX = 99

// ===== 错误分档（重试策略与文案都看它） =====

type FailKind =
  /** 401/403 —— **不重试**（拍板 ⑬） */
  | 'credential'
  /** 其它非 2xx；5xx 重试，4xx 不重试 */
  | 'http'
  | 'network'
  | 'timeout'
  | 'stalled'
  | 'too-big'
  | 'not-a-file'
  | 'too-long'

export class DownloadError extends Error {
  constructor(message: string, readonly kind: FailKind, readonly status = 0) {
    super(message)
    this.name = 'DownloadError'
  }
}

/** 控制流信号（暂停 / 取消）走异常展开 —— 与 `updateService` 的 `MIRROR_CHANGED` 同一手法 */
class ControlError extends Error {
  constructor(readonly kind: 'paused' | 'cancelled') {
    super(kind)
    this.name = 'ControlError'
  }
}

/** 值得自动重试的档位：5xx / 网络中断 / 超时 / 停滞。**凭据与体积档绝不重试** */
function isRetryable(e: unknown): boolean {
  if (!(e instanceof DownloadError)) return false
  if (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'stalled') return true
  return e.kind === 'http' && e.status >= 500
}

// ===== 对外 DTO（与 src/types/index.ts 的 BookDownloadTask 同形） =====

export type BookDownloadState = 'queued' | 'down' | 'paused' | 'done' | 'fail'

export interface BookDownloadTask {
  id: string
  sourceId: string
  sourceName: string
  title: string
  url: string
  relPath: string
  state: BookDownloadState
  received: number
  total: number
  retry: number
  error?: string
}

export interface BookDownloadRequest {
  sourceId?: string
  sourceName?: string
  title: string
  author?: string
  downloadUrl: string
  coverUrl?: string
  /** 扩展名（带点优先，不带点也收 —— `bookExtOf` 会自动补点） */
  ext?: string
  /** 检索时源给的体积（0 / 缺省 = 未知）—— 先用它挡一次，省一个必然失败的请求 */
  sizeBytes?: number
}

export type DownloadStartResult =
  | { ok: true; task: BookDownloadTask }
  /** 重名闸：**不静默**，交回渲染层弹「覆盖 / 另存副本」（拍板 ⑩） */
  | { ok: false; conflict: true; relPath: string; fileName: string; error: string }
  | { ok: false; error: string }

export type DownloadAction =
  | 'pause' | 'resume' | 'cancel' | 'retry'
  | 'pause-all' | 'resume-all' | 'clear-done'

// ===== 队列（内存态） =====

interface Task extends BookDownloadTask {
  rootId: string
  destAbs: string
  partAbs: string
  coverUrl: string
  author: string
  /** 正在跑的那次流；`paused` / `cancelled` 由它把异常展开到 `streamToFile` 外 */
  ctl: { abort: (kind: 'paused' | 'cancelled') => void } | null
}

const tasks: Task[] = []
let pumping = false

function toDto(t: Task): BookDownloadTask {
  return {
    id: t.id, sourceId: t.sourceId, sourceName: t.sourceName, title: t.title, url: t.url,
    relPath: t.relPath, state: t.state, received: t.received, total: t.total, retry: t.retry, error: t.error,
  }
}

/** 当前仓库的队列快照（**不含别的仓库的** —— 换仓后旧队列既不该跑也不该显示） */
export function listDownloadQueue(rootId: string): BookDownloadTask[] {
  // 顺带推一把泵：换仓回来时，上一轮 `queued` 的任务（或任何因故没跑起来的）在这里被捡起
  if (getCurrentVault()?.rootId === rootId) pump()
  return tasks.filter((t) => t.rootId === rootId).map(toDto)
}

function pushProgress(): void {
  const cur = getCurrentVault()
  if (!cur) return
  broadcast(BROADCAST_CHANNEL.bookMarketDownloadProgress, { rootId: cur.rootId, tasks: listDownloadQueue(cur.rootId) })
}

// ===== 队列泵（并发恒 1） =====

function pump(): void {
  if (pumping) return
  const cur = getCurrentVault()
  if (!cur) return
  // ★ 只跑**当前仓库**的任务：任务记着自己属于哪个仓库，换仓后旧任务既不跑也不报错
  const next = tasks.find((t) => t.state === 'queued' && t.rootId === cur.rootId)
  if (!next) return
  pumping = true
  void runTask(next).finally(() => { pumping = false; pump() })
}

async function runTask(task: Task): Promise<void> {
  if (task.state !== 'queued') return
  task.state = 'down'
  task.error = undefined
  pushProgress()
  try {
    await downloadBook(task)
    // ★ 顺序不许换：先 rename 再写 meta —— meta 是「书上架了」的标记，
    //   提前写会让书架在文件还没到位时列出这本书（点开必然崩）
    renameSync(task.partAbs, task.destAbs)
    const prevCover = bookMetaGet(task.relPath)?.coverRel || ''
    const coverRel = task.coverUrl ? await fetchCover(task.rootId, task.coverUrl, task.sourceId) : ''
    let size = 0
    try { size = statSync(task.destAbs).size } catch { /* 拿不到就留 0，不影响上架 */ }
    // ★ 封面抓失败（`coverRel === ''`）时**不写这个字段**（`?? ` 合并会保住旧值）：
    //   上一版封面仍然是这本书的图。写成 '' 的表象是「重下一本书，书架上它的封面凭空没了」，
    //   而用户除了再下一次没有任何修复手段 —— 抓图失败不该有这个后果。
    bookMetaUpsert(task.relPath, {
      author: task.author,
      ...(coverRel ? { coverRel } : {}),
      sourceId: task.sourceId,
      sourceName: task.sourceName,
      size,
    }, task.title)
    // 换了封面（URL 变 ⇒ hash 变）⇒ 旧文件此刻已无人引用，顺手回收（否则 `.covers/` 里留孤儿）
    if (coverRel && prevCover && prevCover !== coverRel) {
      const stillUsed = Object.values(bookMetaReadAll().books).some((b) => b.coverRel === prevCover)
      if (!stillUsed) bookCoverDelete(prevCover)
    }
    task.state = 'done'
    task.received = size || task.received
    pushProgress()
    // 铁律 1：写盘后必须广播，否则表象是「下完了书架里没有」
    broadcastDataChanged('bookMarket')
  } catch (e) {
    if (e instanceof ControlError) {
      if (e.kind === 'paused') {
        task.state = 'paused'
        pushProgress()
      } else {
        // 取消：连半截文件一起清掉（留着只会占地方，且下次同名下载会毫无理由地续传旧字节）
        try { unlinkSync(task.partAbs) } catch { /* 本来就没有 */ }
        const i = tasks.indexOf(task)
        if (i >= 0) tasks.splice(i, 1)
        pushProgress()
      }
      return
    }
    const msg = e instanceof DownloadError ? e.message : '下载失败'
    // 重试上限只在**自动**重试上算数；手动重试（controlDownload 的 retry）会把计数清零
    if (isRetryable(e) && task.retry < RETRY_LIMIT) {
      task.retry++
      task.state = 'queued'
      task.error = msg
      pushProgress()
      return
    }
    task.state = 'fail'
    task.error = msg
    pushProgress()
  } finally {
    task.ctl = null
  }
}

// ===== 单本下载（流式 + Range 续传） =====

function normalizeExt(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return ''
  return s.startsWith('.') ? s : `.${s}`
}

function isHttpUrl(u: unknown): boolean {
  try {
    const p = new URL(String(u))
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

/** 书名侧非法字符已在 schema 的 `safeBookFileName` 处理；这里只做「往哪落」的拼接 */
function destFor(vaultRoot: string, author: string, title: string, ext: BookExt): { relPath: string; destAbs: string; partAbs: string; fileName: string } {
  const fileName = safeBookFileName(author, title, ext)
  const relPath = `${BOOKS_DIR}/${fileName}`
  const destAbs = join(vaultRoot, BOOKS_DIR, fileName)
  return { relPath, destAbs, partAbs: `${destAbs}.part`, fileName }
}

/**
 * 重名闸的「另存副本」分支：`作者 - 书名 (2).epub`，`(3)`、`(4)`……
 * 与资源管理器的「副本」同一读法（**加在扩展名之前**，否则改完名字就不像同一本书了）。
 */
function copyNameFor(vaultRoot: string, author: string, title: string, ext: BookExt): { relPath: string; destAbs: string; partAbs: string; fileName: string } {
  const stem = safeBookFileName(author, title, ext).slice(0, -ext.length)
  for (let n = 2; n <= COPY_SUFFIX_MAX; n++) {
    const fileName = `${stem} (${n})${ext}`
    const destAbs = join(vaultRoot, BOOKS_DIR, fileName)
    if (!existsSync(destAbs)) return { relPath: `${BOOKS_DIR}/${fileName}`, destAbs, partAbs: `${destAbs}.part`, fileName }
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const fileName = `${stem} (${stamp})${ext}`
  const destAbs = join(vaultRoot, BOOKS_DIR, fileName)
  return { relPath: `${BOOKS_DIR}/${fileName}`, destAbs, partAbs: `${destAbs}.part`, fileName }
}

/** 建队列项（三道闸全在这里判 —— 过了这关才允许发请求） */
export function startDownload(rootId: string, req: unknown, conflict?: 'overwrite' | 'copy'): DownloadStartResult {
  const cur = getCurrentVault()
  if (!cur || cur.rootId !== rootId) return { ok: false, error: '当前仓库不匹配' }
  const r = (req ?? {}) as BookDownloadRequest

  const title = String(r.title ?? '').trim()
  if (!title) return { ok: false, error: '书名不能为空' }

  // 闸 ①：格式 —— 不在 `BOOK_EXTS` 里的一律拒。
  // ★ 为什么必须拒（不是「提示一下还能下」）：`scanVaultBooks` 对未收录格式**直接跳过**
  //   （`knowledgeIndex` 的 `if (!kind) continue`）⇒ 下载了也不会出现在书架，等于静默失败。
  const ext = bookExtOf(normalizeExt(r.ext))
  if (!ext) return { ok: false, error: '暂不支持该格式' }

  const url = String(r.downloadUrl ?? '')
  if (!isHttpUrl(url)) return { ok: false, error: '下载地址无效' }

  // 闸 ②：体积（先用源给的体积挡一次；响应头到了还有一次复核）
  const known = Number(r.sizeBytes)
  if (Number.isFinite(known) && known > MAX_BOOK_BYTES) {
    return { ok: false, error: `文件超过 ${Math.floor(MAX_BOOK_BYTES / 1024 / 1024)}MB 上限，已拒绝下载` }
  }

  const author = String(r.author ?? '').trim()
  const first = destFor(cur.rootPath, author, title, ext)

  // 同一本书已经在队列里（含暂停）⇒ 拒绝重复入队：
  // 两个任务共用同一个 `.part` 会互相踩字节（各自按 Range 续传到同一个文件）。
  if (tasks.some((t) => t.rootId === rootId && t.destAbs === first.destAbs && t.state !== 'done' && t.state !== 'fail')) {
    return { ok: false, error: '这本书已在下载队列中' }
  }

  // 闸 ③：重名（拍板 ⑩：弹「覆盖 / 另存副本」，**不静默**）
  let target = first
  const exists = existsSync(first.destAbs)
  if (exists && conflict !== 'overwrite') {
    if (conflict === 'copy') {
      target = copyNameFor(cur.rootPath, author, title, ext)
    } else {
      // 没带决定 ⇒ 原地返回冲突，由渲染层问用户（**队列里不留任何痕迹**）
      return { ok: false, conflict: true, relPath: first.relPath, fileName: first.fileName, error: '同名书籍已存在' }
    }
  }

  try {
    mkdirSync(join(cur.rootPath, BOOKS_DIR), { recursive: true })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  const task: Task = {
    id: randomUUID(),
    rootId,
    sourceId: String(r.sourceId ?? ''),
    // 源名冗余存一份（同 meta 的口径）：源被删掉后队列项仍能显示「来自哪儿」
    sourceName: String(r.sourceName ?? ''),
    title,
    author,
    url,
    relPath: target.relPath,
    destAbs: target.destAbs,
    partAbs: target.partAbs,
    coverUrl: isHttpUrl(r.coverUrl) ? String(r.coverUrl) : '',
    state: 'queued',
    received: 0,
    total: Number.isFinite(known) && known > 0 ? Math.floor(known) : 0,
    retry: 0,
    ctl: null,
  }
  tasks.push(task)
  pushProgress()
  pump()
  return { ok: true, task: toDto(task) }
}

/** 逐项 / 批量控制（S4 的面板按钮都走这里：头部「全部暂停·开始」「清除已完成」也复用） */
export function controlDownload(rootId: string, id: string, action: unknown): { ok: boolean; error?: string } {
  const cur = getCurrentVault()
  if (!cur || cur.rootId !== rootId) return { ok: false, error: '当前仓库不匹配' }
  const act = String(action ?? '') as DownloadAction
  const mine = tasks.filter((t) => t.rootId === rootId)

  switch (act) {
    case 'pause': {
      const t = mine.find((x) => x.id === id)
      if (!t) return { ok: false, error: '任务不存在' }
      if (t.state === 'down') t.ctl?.abort('paused')
      else if (t.state === 'queued') { t.state = 'paused'; pushProgress() }
      return { ok: true }
    }
    case 'resume': {
      const t = mine.find((x) => x.id === id)
      if (!t) return { ok: false, error: '任务不存在' }
      if (t.state === 'paused') {
        // 续传靠 `.part`：`streamToFile` 按它的现存大小发 `Range`
        t.state = 'queued'
        pushProgress()
        pump()
      }
      return { ok: true }
    }
    case 'retry': {
      const t = mine.find((x) => x.id === id)
      if (!t) return { ok: false, error: '任务不存在' }
      if (t.state === 'fail' || t.state === 'paused') {
        // 手动重试 = 用户明确要求再试一次 ⇒ 自动重试额度重置（否则第二次失败会直接被判死）
        t.retry = 0
        t.state = 'queued'
        pushProgress()
        pump()
      }
      return { ok: true }
    }
    case 'cancel': {
      const t = mine.find((x) => x.id === id)
      if (!t) return { ok: false, error: '任务不存在' }
      if (t.state === 'down') t.ctl?.abort('cancelled')
      else {
        try { unlinkSync(t.partAbs) } catch { /* 本来就没有 */ }
        const i = tasks.indexOf(t)
        if (i >= 0) tasks.splice(i, 1)
        pushProgress()
      }
      return { ok: true }
    }
    case 'pause-all': {
      for (const t of mine) {
        if (t.state === 'down') t.ctl?.abort('paused')
        else if (t.state === 'queued') t.state = 'paused'
      }
      pushProgress()
      return { ok: true }
    }
    case 'resume-all': {
      for (const t of mine) if (t.state === 'paused') t.state = 'queued'
      pushProgress()
      pump()
      return { ok: true }
    }
    case 'clear-done': {
      // 只清「已完成」：失败的留着让用户看得见（静默丢失败项 = 用户以为下过了）
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (tasks[i].rootId === rootId && tasks[i].state === 'done') tasks.splice(i, 1)
      }
      pushProgress()
      return { ok: true }
    }
    default:
      return { ok: false, error: '未知操作' }
  }
}

/** 流的中止把手（`streamToFile` 之外也能按）*/
interface StreamCtl {
  abort: (kind: 'paused' | 'cancelled') => void
}

/**
 * `net.request` 的响应**在运行时是 Node Readable**（S0 实测：`pipe` / `destroy` / `on('data')` 都在，
 * 所以 `updateService` 里那句 `Readable.fromWeb` 才能删掉），但 Electron 33 的 `electron.d.ts`
 * 把它声明成 `class IncomingMessage extends NodeEventEmitter` —— **定型缺口**。
 * 这里显式收敛成「只用得到的那几个成员」，转一次就够。
 *
 * ★ `destroy` / `resume` 标可选是**故意的**：它们是清理期的便利，缺了不影响正确性 ——
 *   真正的中止靠 `req.abort()`（S2 的超时路径就是这么干的）。探针会**记录**它们到底在不在
 *   （INFO 行，不作判据），免得「定型里有」被当成「运行时真有」。
 */
type NetReadable = {
  destroy?: () => void
  resume?: () => void
}

/** 尽力让响应体流干（不 drain 会占着连接）；没有 `resume` 就交给 `req.abort()` 兜底 */
function drainBody(r: unknown): void {
  try { (r as NetReadable).resume?.() } catch { /* 已经结束 */ }
}

/**
 * 单本下载：`Range` 续传到 `.part`（骨架照 `updateService.downloadOne`，两处按 S0 实测替换：
 * `net.request({session})` 替 `net.fetch`、响应即 Readable 故**不要** `Readable.fromWeb`）。
 *
 * ★ 与 `updateService` 的两处**故意不同**（书市没有镜像候选，不需要那一套）：
 *   ① 没有「换通道」——失败要么重试要么报错，`ctl` 只服务暂停/取消；
 *   ② 看门狗判的是**停死**（空闲无字节）而非「慢」（慢通道对书市不算故障，用户能暂停）。
 */
async function downloadBook(task: Task): Promise<void> {
  const headers: Record<string, string> = {}
  // 凭据：只进 Authorization 头。源被删了 / 没配凭据 ⇒ 头就没有（免认证源照常下）
  const source = task.sourceId ? bookSourceGet(task.rootId, task.sourceId) : null
  if (source?.auth) {
    const h = authHeaderFor(bookSourceCredentialFor(task.rootId, source.auth.ref))
    if (h) headers.Authorization = h
  }

  // 续传锚点：`.part` 的现存大小
  let offset = 0
  try { offset = statSync(task.partAbs).size } catch { offset = 0 }
  if (offset >= MAX_BOOK_BYTES) {
    // 半截文件本身已超上限（上次下到一半改了策略 / 换了源）⇒ 别接着续，从头来
    try { unlinkSync(task.partAbs) } catch { /* 见上 */ }
    offset = 0
  }

  // 进度节流**在调用方**（推事件的那一侧），不在 `streamToFile` 里 —— 理由是一条真实的表象：
  // 若节流也管住内存里的计数，则**小于 256KB 的书全程 received 恒 0**（一个节流窗口都填不满），
  // 书架上的队列行会从头到尾显示 0%。所以：每个 chunk 都更新 `task.received`，
  // 只有**广播**受节流限制。`total` 在响应头到达时立刻就有（那也是第一次强制推送）。
  task.received = offset
  let lastPushAt = 0
  let lastPushBytes = offset
  pushProgress()

  const total = await streamToFile({
    url: task.url,
    headers,
    offset,
    destAbs: task.partAbs,
    // 占位把手：`streamToFile` 一进来就会把它替换成真的（同步替换，故外面按下去时一定按得到）
    ctl: { abort: () => { /* 见上 */ } },
    onTaskCtl: (ctl) => { task.ctl = ctl },
    onProgress: (received, tot) => {
      task.received = received
      if (tot > 0) task.total = tot
      const now = Date.now()
      if (received - lastPushBytes < PROGRESS_MIN_BYTES && now - lastPushAt < PROGRESS_MIN_INTERVAL_MS) return
      lastPushAt = now
      lastPushBytes = received
      pushProgress()
    },
  })

  // 兜底校验：服务器提前断流 / chunked 无 Content-Length 时，size 是唯一的真相
  const written = (() => { try { return statSync(task.partAbs).size } catch { return 0 } })()
  if (total > 0 && written !== total) {
    throw new DownloadError(`文件大小不符（期望 ${total}，实际 ${written}），服务器可能未传完整`, 'network')
  }
  if (written > MAX_BOOK_BYTES) {
    throw new DownloadError(`文件超过 ${Math.floor(MAX_BOOK_BYTES / 1024 / 1024)}MB 上限`, 'too-big')
  }
  task.received = written
  task.total = total > 0 ? total : written
}

interface StreamOptions {
  url: string
  headers: Record<string, string>
  offset: number
  /** 落盘目标 = `.part`（**永不直接写书名**，见文件头注 ③） */
  destAbs: string
  ctl: StreamCtl
  /** 把真正的中止把手交给调用方（队列项）*/
  onTaskCtl: (ctl: StreamCtl) => void
  onProgress: (received: number, total: number) => void
}

/** 返回**整本**字节数（含续传前已有的 offset） */
function streamToFile(opts: StreamOptions): Promise<number> {
  const host = (() => { try { return new URL(opts.url).hostname } catch { return '下载地址' } })()
  return new Promise<number>((resolve, reject) => {
    let settled = false
    let req: ClientRequest | null = null
    let res: NetReadable | null = null
    let out: WriteStream | null = null
    let idle: NodeJS.Timeout | null = null
    let connect: NodeJS.Timeout | null = null
    let received = 0
    let total = 0
    let startOffset = opts.offset

    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (idle) clearTimeout(idle)
      if (connect) clearTimeout(connect)
      fn()
    }
    const cleanup = (): void => {
      try { res?.destroy?.() } catch { /* 已关 */ }
      try { req?.abort() } catch { /* 已结束 */ }
      try { out?.destroy() } catch { /* 已关 */ }
    }
    const fail = (e: Error): void => done(() => { cleanup(); reject(e) })

    // 中止把手：暂停 / 取消都从这里展开（`updateService` 的 signal 等价物）
    opts.ctl.abort = (kind) => fail(new ControlError(kind))
    opts.onTaskCtl(opts.ctl)

    try {
      // ★ `Range` 在这里拼、**不在** `downloadBook` 里拼：`offset` 是 `streamToFile` 的入参，
      //   而且只有它知道「服务器是否真的支持续传」（非 206 时上面会把 offset 归零重下）。
      //   曾经这里漏了这行 —— 表象极具迷惑性：`.part` 攒着字节、`received` 也接着数，
      //   但传输层从头传了一遍，落盘时被 `startOffset > 0 && status !== 206` 分支归零后覆盖重写，
      //   于是**文件是对的、字节数是对的、只有「白下了一遍」看不出来**（探针看 Range 头才逮住）。
      const reqHeaders: Record<string, string> = { ...opts.headers }
      if (startOffset > 0) {
        reqHeaders.Range = `bytes=${startOffset}-`
        // 续传的字节偏移必须落在**原始文件**上；若传输层替我们解压过，`.part` 的接缝就会错位
        reqHeaders['Accept-Encoding'] = 'identity'
      }
      req = openBookRequest(opts.url, { headers: reqHeaders })
    } catch {
      fail(new DownloadError(`${host} 请求无法发起`, 'network'))
      return
    }
    connect = setTimeout(() => fail(new DownloadError(`${host} 连接超时`, 'timeout')), CONNECT_TIMEOUT_MS)
    connect.unref?.()

    const armIdle = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => fail(new DownloadError(`${host} 下载停滞（${Math.round(IDLE_TIMEOUT_MS / 1000)}s 无数据）`, 'stalled')), IDLE_TIMEOUT_MS)
      idle.unref?.()
    }

    req.on('response', (r) => {
      if (connect) { clearTimeout(connect); connect = null }
      res = r as unknown as NetReadable
      const status = r.statusCode ?? 0
      const headers = (r.headers ?? {}) as Record<string, string | string[]>
      const ctype = headerOf(headers, 'content-type')
      const segTotal = Number(headerOf(headers, 'content-length')) || 0

      if (status === 401 || status === 403) {
        fail(new DownloadError(`${host} 需要凭据（HTTP ${status}）`, 'credential', status))
        return
      }
      if (status < 200 || status >= 300) {
        fail(new DownloadError(`${host} HTTP ${status}`, 'http', status))
        return
      }
      // 200 且要过 Range ⇒ 服务器不支持续传，只能从头写（`.part` 用 'w' 覆盖）
      if (startOffset > 0 && status !== 206) startOffset = 0
      total = status === 206 ? startOffset + segTotal : segTotal

      // 体积闸（复核）：这是**权威**的那个 Content-Length —— 源在检索时给的体积可以撒谎
      if (total > MAX_BOOK_BYTES) {
        fail(new DownloadError(`文件超过 ${Math.floor(MAX_BOOK_BYTES / 1024 / 1024)}MB 上限，已中止`, 'too-big'))
        return
      }
      // 200 却回了个网页 ⇒ 多半是登录页 / 错误页，落盘就是一本打不开的「书」
      if (/text\/html/i.test(ctype)) {
        fail(new DownloadError(`${host} 返回的是网页而非文件`, 'not-a-file'))
        return
      }
      received = startOffset
      try {
        mkdirSync(dirname(opts.destAbs), { recursive: true })
        // 续传走 'a'（**追加**到 `.part` 现有字节之后）；不支持 Range 时（上面已把 startOffset 归零）走 'w'
        out = createWriteStream(opts.destAbs, { flags: startOffset > 0 ? 'a' : 'w' })
      } catch (e) {
        fail(new DownloadError((e as Error).message, 'network'))
        return
      }
      out.on('error', (e) => fail(new DownloadError(`写入失败：${(e as Error).message}`, 'network')))
      armIdle()
      // 头一到就报一次：`total` 此刻已知 ⇒ 队列行的百分比从这一瞬间起才是有意义的
      // （节流由调用方管，见 `downloadBook` 的注释）
      opts.onProgress(received, total)
      r.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > MAX_BOOK_BYTES) {
          fail(new DownloadError(`文件超过 ${Math.floor(MAX_BOOK_BYTES / 1024 / 1024)}MB 上限，已中止`, 'too-big'))
          return
        }
        armIdle()
        // ★ 落盘：**必须真的写**（曾经这里只累加计数没写文件，表象是「下完了、字节数是满的、
        //   磁盘上是 0 字节」，然后被大小校验逮住 —— 校验兜住了，但别把校验当实现）
        const writable = out?.write(chunk)
        if (writable === false) {
          // 背压：写盘跟不上网络时先把响应暂停，`drain` 再放行（`pause`/`resume` 缺失时
          // 只是少了背压保护，不致命 —— 见 NetReadable 的头注）
          const rr = r as unknown as { pause?: () => void; resume?: () => void }
          try { rr.pause?.() ; out?.once('drain', () => rr.resume?.()) } catch { /* 已结束 */ }
        }
        opts.onProgress(received, total)
      })
      r.on('error', () => fail(new DownloadError(`${host} 响应读取中断`, 'network')))
      r.on('end', () => {
        // ★ 必须等**写盘 flush 完**（`end(cb)` 的回调 = 'finish'）再 resolve ——
        //   否则调用方紧接着 `rename`，可能把还没落完的文件搬成正式书名（截断的书）
        try { out?.end(() => done(() => resolve(received))) } catch { done(() => resolve(received)) }
      })
    })

    req.on('error', (e: Error) => {
      const msg = String(e?.message ?? '')
      const kind: FailKind = /timed? ?out|ETIMEDOUT/i.test(msg) ? 'timeout' : 'network'
      fail(new DownloadError(`${host} ${kind === 'timeout' ? '连接超时' : '连接失败'}`, kind))
    })
    req.end()
  })
}

function headerOf(headers: Record<string, string | string[]>, name: string): string {
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue
    return Array.isArray(v) ? (v[0] ?? '') : String(v ?? '')
  }
  return ''
}

// ===== 封面（拍板 ⑪） =====

/**
 * 抓封面 → `.books/.covers/<hash>.jpg`，返回**相对引用**（`coverRel`）。
 *
 * ★ 三条口径：
 *   ① **尽力而为**：封面抓不到绝不让整本书失败（书已经落盘了，为一张图把它判失败是本末倒置）；
 *   ② 文件名一律 `.jpg`（拍板 ⑪ 写死的路径口径就是 `<hash>.jpg`）—— 内容可能是 png/webp，
 *      浏览器按魔数嗅探，`<img>` 照常显示；改扩展名会让它与 §2.2 的口径脱钩；
 *   ③ hash 取**封面 URL**（不是书名）：同源同封面自然合并成一个文件，
 *      `bookCoverDeleteUnreferenced` 按引用计数回收，共享不会误删。
 */
async function fetchCover(rootId: string, coverUrl: string, sourceId: string): Promise<string> {
  const dir = ensureBookCoversDir()
  if (!dir) return ''
  try {
    const headers: Record<string, string> = {}
    const source = sourceId ? bookSourceGet(rootId, sourceId) : null
    if (source?.auth) {
      const h = authHeaderFor(bookSourceCredentialFor(rootId, source.auth.ref))
      if (h) headers.Authorization = h
    }
    const buf = await fetchBinary(coverUrl, headers, MAX_COVER_BYTES)
    const hash = createHash('sha256').update(coverUrl).digest('hex').slice(0, 16)
    const coverRel = bookCoverRelFor(hash)
    if (!coverRel) return ''
    writeFileSync(join(dir, basename(coverRel)), buf)
    return coverRel
  } catch {
    return ''
  }
}

/** 小体积二进制取回（**只给封面用**）。文本路径请用 `bookRequestText` —— 它会把字节按 utf-8 解码，二进制会被毁掉 */
function fetchBinary(url: string, headers: Record<string, string>, maxBytes: number): Promise<Buffer> {
  const host = (() => { try { return new URL(url).hostname } catch { return '封面地址' } })()
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false
    let req: ClientRequest | null = null
    let timer: NodeJS.Timeout | null = null
    const done = (fn: () => void): void => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn() }
    timer = setTimeout(() => {
      try { req?.abort() } catch { /* 已结束 */ }
      done(() => reject(new DownloadError(`${host} 请求超时`, 'timeout')))
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()
    try {
      req = openBookRequest(url, { headers })
    } catch {
      done(() => reject(new DownloadError(`${host} 请求无法发起`, 'network')))
      return
    }
    req.on('response', (r) => {
      const status = r.statusCode ?? 0
      const ctype = headerOf((r.headers ?? {}) as Record<string, string | string[]>, 'content-type')
      if (status < 200 || status >= 300) {
        drainBody(r)
        done(() => reject(new DownloadError(`${host} HTTP ${status}`, 'http', status)))
        return
      }
      // 只要图片：HTML 错误页存成 .jpg 会在书卡上碎成一块，不如没有封面
      if (ctype && !/^image\//i.test(ctype)) {
        drainBody(r)
        done(() => reject(new DownloadError(`${host} 不是图片`, 'not-a-file')))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      r.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          try { req?.abort() } catch { /* 见上 */ }
          done(() => reject(new DownloadError(`${host} 封面过大`, 'too-long')))
          return
        }
        chunks.push(chunk)
      })
      r.on('end', () => done(() => resolve(Buffer.concat(chunks))))
      r.on('error', () => done(() => reject(new DownloadError(`${host} 响应读取中断`, 'network'))))
    })
    req.on('error', () => done(() => reject(new DownloadError(`${host} 连接失败`, 'network'))))
    req.end()
  })
}
