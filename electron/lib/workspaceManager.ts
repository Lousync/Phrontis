import { ipcMain, BrowserWindow, dialog, app, shell } from 'electron'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, openSync, readSync, closeSync } from 'fs'
import { basename, join, relative, resolve, sep, extname, dirname, isAbsolute } from 'path'
import { cp } from 'fs/promises'
import { randomUUID } from 'crypto'
import { setCurrentVault, ensureKbRoot, readCurrentVaultId, getCurrentVault, ATTACHMENTS_DIR, readRecentVaults, forgetRecentVault, markRecentDeleted, clearRecentDeleted, setVaultMetaName } from './kbStore/vaultContext'
import { writeWelcomeDocOnce, importWelcomeDoc, getWelcomeDocState, WELCOME_DOC_FILENAME } from './kbStore/welcomeDoc'
import { invalidateKnowledgeIndex, getKnowledgeIndex } from './kbStore/knowledgeIndex'
import { invalidateGraphIndex } from './kbStore/graphIndex'
import { emitPluginEvent } from './pluginEvents'
import { IGNORE_FILE_NAME } from './kbStore/ignoreFile'
import { parseMarkdown, serializeMarkdown } from './kbStore/mdStore'
import { broadcastDataChanged } from '../main/windowBus'
import { syncVaultWatcher, markSelfWrite } from './fsWatcher'
import { bookMetaPruneOrphans } from './kbStore/vaultBookMetaRepo'
import { globalReadJson, globalWriteJson } from './globalJsonStore'
import { isAllowedClearRoot, trashVaultFolder } from './vaultDelete'
import { rootDirName } from './aiTeachingFolders'

/**
 * 编辑器工作区（Vault 仓库）文件服务。
 *
 * 设计对标 Obsidian 的 Vault + FileSystemAdapter：
 * - 任何磁盘文件夹经系统对话框授权后登记为仓库（rootId），后续所有操作
 *   只接受 { rootId, relPath } —— 渲染层永不接触绝对路径，路径合法性由主进程单向保证。
 * - 核心逻辑（resolveSafe / listDirEntries / readWorkspaceFile / writeWorkspaceFile）
 *   为纯函数，供 tmp/smoke 冒烟脚本直接断言。
 * - 删除一律走系统回收站（trash 包），绝不 rm；符号链接全路径拒绝，防逃逸。
 */

const MAX_EDIT_SIZE = 10 * 1024 * 1024 // >10MB 拒绝编辑（只读）
const MAX_OPEN_SIZE = 50 * 1024 * 1024 // >50MB 拒绝打开
const MAX_PASTE_ITEMS = 500 // 单次粘贴条目上限（超出部分记为 skipped，不静默丢弃）
const BINARY_NUL_RATIO = 0.05 // 前 512 字节 NUL 占比 >5% 判二进制
const HIDDEN_DIRS = new Set([
  '.git', 'node_modules', 'out', 'dist', '.obsidian', '__pycache__',
  '.vscode', '.idea', '.claude', '.turbo', '.next', 'build',
])

/** 应用内部目录（去库化/迁移器约定）：文件树对用户隐藏，避免与软件数据混淆
 *  注1：根级 .attachments 因「.」前缀天然隐藏（listDirEntries），无需登记
 *  注2：D3（P4）后 'blog' 不再是内部目录——博客已收进 .knowbase/blog/ */
const APP_INTERNAL_DIRS = new Set(['_attachments', '_inbox'])

/** 软件生成项沉底（2026-09-08 用户拍板）：.ignore 等非用户内容不与用户目录混排，固定沉在文件树根列表最下。
 *  新增软件生成文件/目录时登记进此集合即可（AI教学 产物根按设置动态传入，见 ws:listDir）。 */
const SOFT_ENTRY_NAMES = new Set(['.ignore'])

interface RootInfo {
  id: string
  name: string
  rootPath: string
}

const roots = new Map<string, RootInfo>()

// ===== 纯逻辑（可单测）=====

/** 目标绝对路径是否位于根目录内（Windows 大小写不敏感） */
export function isInside(rootPath: string, target: string): boolean {
  const base = resolve(rootPath).toLowerCase()
  const abs = resolve(target).toLowerCase()
  const baseWithSep = base.endsWith(sep) ? base : base + sep
  return abs === base || abs.startsWith(baseWithSep)
}

/**
 * 把 { rootId, relPath } 安全解析为根内绝对路径。
 * 空字符串 = 根本身（枚举根目录）。
 * 拒绝：非字符串、盘符绝对路径、UNC、POSIX/Windows 绝对路径、`..` 越出根、
 * 路径任意一段是符号链接（防 symlink 逃逸读/写根外文件）。
 * 非法输入返回 null。
 */
export function resolveSafe(rootPath: string, relPath: unknown): string | null {
  if (typeof relPath !== 'string') return null
  if (relPath.length === 0) return resolve(rootPath) // 根本身
  if (/^[a-zA-Z]:[\\/]/.test(relPath)) return null
  if (relPath.startsWith('\\\\') || relPath.startsWith('//')) return null
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return null
  const target = resolve(rootPath, relPath)
  if (!isInside(rootPath, target)) return null
  const rel = relative(rootPath, target)
  if (rel === '') return target // 根本身
  const parts = rel.split(sep).filter(Boolean)
  let cur = resolve(rootPath)
  for (const p of parts) {
    cur = join(cur, p)
    try {
      if (lstatSync(cur).isSymbolicLink()) return null
    } catch {
      break // 目标或其祖先尚不存在（新建场景），后续段也不再存在
    }
  }
  return target
}

/** 二进制检测：前 512 字节 NUL 占比 > 5% */
export function detectBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 512)
  if (n === 0) return false
  let nul = 0
  for (let i = 0; i < n; i++) if (buf[i] === 0) nul++
  return nul / n > BINARY_NUL_RATIO
}

export interface WorkspaceEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  mtime: number
}

/** 枚举目录：跳过符号链接与隐藏目录，文件夹优先 + 中文友好字典序。
 *  软件生成项（.ignore / AI教学 产物根等）不在此隐藏/排序——由 ws:listDir 附 softNames，
 *  渲染层在文件树底部以「软件文件」折叠节分组呈现（2026-09-08 用户拍板，VS Code 时间线式） */
export function listDirEntries(absPath: string): WorkspaceEntry[] {
  const out: WorkspaceEntry[] = []
  let names: string[] = []
  try {
    names = readdirSync(absPath)
  } catch {
    return out
  }
  for (const name of names) {
    const full = join(absPath, name)
    try {
      const lst = lstatSync(full)
      if (lst.isSymbolicLink()) continue
      if (lst.isDirectory()) {
        if (name.startsWith('.') || HIDDEN_DIRS.has(name.toLowerCase()) || APP_INTERNAL_DIRS.has(name.toLowerCase())) continue
        out.push({ name, type: 'dir', size: 0, mtime: lst.mtimeMs })
      } else if (lst.isFile()) {
        out.push({ name, type: 'file', size: lst.size, mtime: lst.mtimeMs })
      }
    } catch {
      /* skip 瞬时不可读条目 */
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
  return out
}

/**
 * 给定候选名 baseName，若父目录已存在则自动加后缀返回首个不冲突名。
 * 例："新建.md" 已存在 → "新建(1).md" / "新建(2).md" …；无扩展名同样加 (1)。
 * 上限 10k 防意外死循环。纯逻辑（不依赖 electron），node 可冒烟。
 */
export function uniqueFileName(parentAbs: string, baseName: string): string {
  if (!existsSync(join(parentAbs, baseName))) return baseName
  const ext = extname(baseName)
  const stem = baseName.slice(0, baseName.length - ext.length)
  for (let i = 1; i < 10_000; i++) {
    const next = `${stem}(${i})${ext}`
    if (!existsSync(join(parentAbs, next))) return next
  }
  return baseName // 兜底（理论不可达）
}

/**
 * VS Code 风格重名递增（粘贴外部文件专用，与 `uniqueFileName` 的 `(N)` 口径**故意不同**）：
 * `a.md` → `a copy.md` → `a copy 2.md` → `a copy 3.md`；无扩展名的目录同规则（`subdir copy`）。
 *
 * 为什么要两套口径：`uniqueFileName` 服务于「新建文件撞名」，`a(1).md` 是系统惯例；
 * 而「粘贴」是对标 VS Code/资源管理器的复制语义，用户看到 `xxx copy.md` 才知道这是副本。
 * 两者都是**纯函数**（只读 existsSync），供契约脚本直接断言。
 */
export function vscodeCopyName(parentAbs: string, baseName: string): string {
  if (!existsSync(join(parentAbs, baseName))) return baseName
  const ext = extname(baseName)
  const stem = baseName.slice(0, baseName.length - ext.length)
  for (let i = 0; i < 10_000; i++) {
    const next = i === 0 ? `${stem} copy${ext}` : `${stem} copy ${i + 1}${ext}`
    if (!existsSync(join(parentAbs, next))) return next
  }
  return baseName // 兜底（理论不可达）
}

export interface ReadFileResult {
  content: string
  binary: boolean
  size: number
  editable: boolean
  truncated: boolean
  /** 磁盘 mtime（毫秒）：作为保存冲突检测的基线 */
  mtimeMs: number
  /** 探测到 PDF 头（%PDF-）：即使 NUL 检测不敏感也要按二进制处理，避免全量文本过 IPC */
  pdf?: boolean
}

/** %PDF- 头探测（PDF 前 5 字节为 ASCII，NUL 检测不敏感会误判成文本） */
function isPdfHeader(buf: Buffer): boolean {
  return buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d
}

/** 读文件：大小门槛 + 二进制/PDF 检测（不返回内容，避免乱码/大文件全量跨 IPC） */
export function readWorkspaceFile(absPath: string): ReadFileResult {
  const st = statSync(absPath)
  if (st.size > MAX_OPEN_SIZE) {
    return { content: '', binary: false, size: st.size, editable: false, truncated: true, mtimeMs: st.mtimeMs }
  }
  const buf = readFileSync(absPath)
  if (detectBinary(buf) || isPdfHeader(buf)) {
    return { content: '', binary: true, size: buf.length, editable: false, truncated: false, mtimeMs: st.mtimeMs, pdf: isPdfHeader(buf) }
  }
  return {
    content: buf.toString('utf-8'),
    binary: false,
    size: buf.length,
    editable: buf.length <= MAX_EDIT_SIZE,
    truncated: false,
    mtimeMs: st.mtimeMs,
  }
}

// ===== 二进制范围读取（PDF 阅读器懒加载通道，plugin-pdf-reader-design §4）=====

/** 范围读取白名单扩展名：范围通道 = 二进制放行口，只允许可视化文档类型（防变成任意二进制窃取口）。
 *  ★ 扩容属**安全面变更**（提交信息须写明理由）：
 *  - txt = 一期（2026-09-20）：TxtReaderView 经 range 分块读 .books 样书（20MB 上限由渲染层限）
 *  - epub = B 段（2026-09-21）：EpubReaderView 整份取字节后交 foliate 解包（zip 需从头读中央目录）；
 *    只读不写、仍受 pathGuard 与「仅当前仓库内」约束。
 *  - fb2 | fbz = 阶段 2a（2026-09-22）：同一 foliate 阅读器（EpubReaderView）接管 fb2/fbz ——
 *    fbz 是 zip 封装，同 epub 需整份读；fb2 是纯 XML，本可走 loadFile，但阅读器只有一条整本读路径，
 *    且两类书都受 128MB 上限与「只读」约束，风险面与 epub 完全一致。
 *  - cbz = 阶段 2b（2026-09-22）：zip 封装的图片漫画，同 fbz 需整份读（中央目录在尾部）。
 *    同上受 128MB 上限与「只读」约束；**页图只能靠整份 zip 解包**，无更窄的读法。 */
const RANGE_EXT_WHITELIST = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'txt', 'epub', 'fb2', 'fbz', 'cbz']

export interface ReadRangeResult {
  /** base64 编码的 [offset, offset+len) 段数据（不足段取到文件尾） */
  data: string
  /** 本段实际起始字节偏移 */
  offset: number
  /** 文件总字节数（pdf.js 据此知道全貌，配合 range 懒加载） */
  size: number
  /** 本段是否截断（end < size） */
  truncated: boolean
}

export interface ReadRangeBytesResult {
  /** [offset, offset+len) 段的原始字节（不足段取到文件尾） */
  bytes: Uint8Array
  /** 本段实际起始字节偏移 */
  offset: number
  /** 文件总字节数 */
  size: number
  /** 本段是否截断（end < size） */
  truncated: boolean
}

/**
 * 范围读取：open+read 精确读段（不整文件载入内存），仅白名单扩展名放行。
 * 纯逻辑可冒烟（不依赖 electron）。
 */
export function readWorkspaceRange(absPath: string, offset: unknown, length: unknown): ReadRangeResult | { error: string } {
  const r = readRangeBuffer(absPath, offset, length)
  if ('error' in r) return r
  return { data: r.buf.toString('base64'), offset: r.offset, size: r.size, truncated: r.truncated }
}

/**
 * `readWorkspaceRange` 的**字节**版本（B-16 · 2026-09-22）：同一个读段实现，只是不做 base64。
 *
 * 为什么值得单开一个通道：整本取字节的阅读器（foliate 系）原先拿 base64 再在渲染侧
 * `atob` + 逐字节解码，实测 96MB 里解码占 ~660ms（总读取链路 1.5s）。改传 `Uint8Array` 后
 * 这一段**整段消失**，而 IPC 传输本身不变（实测两种载荷同为 ~160MB/s，那是 V8 结构化克隆的天花板，
 * 换载荷换不动它）。PDF 侧仍走 base64 老通道 —— pdf.js 要的是可 range 的字符串分片，不动它。
 *
 * ★ 白名单 / 偏移 / 越界逻辑只有 `readRangeBuffer` 一份：两个出口共用，别在这里复制条件。
 */
export function readWorkspaceRangeBytes(absPath: string, offset: unknown, length: unknown): ReadRangeBytesResult | { error: string } {
  const r = readRangeBuffer(absPath, offset, length)
  if ('error' in r) return r
  // 视图而非拷贝：Buffer.alloc 出来的底层 ArrayBuffer 就是这一段（byteOffset/byteLength 已在其中），
  // 而结构化克隆会由 Electron 自己把字节复制出去 ⇒ 这里再复制一次纯属浪费（8MB ≈ 2ms，但白花的）。
  return { bytes: new Uint8Array(r.buf.buffer, r.buf.byteOffset, r.buf.byteLength), offset: r.offset, size: r.size, truncated: r.truncated }
}

/** 读段的唯一实现（白名单 / 偏移归一 / 越界截断）。返回原始 Buffer，由两个出口各自决定怎么过 IPC。 */
function readRangeBuffer(absPath: string, offset: unknown, length: unknown): { buf: Buffer; offset: number; size: number; truncated: boolean } | { error: string } {
  try {
    const ext = extname(absPath).slice(1).toLowerCase()
    // 白名单扩展名；无扩展名文件按 %PDF- 头探测放行（知识库旧附件丢扩展名的 PDF）
    if (!RANGE_EXT_WHITELIST.includes(ext)) {
      if (ext !== '') return { error: `文件类型不支持范围读取: .${ext}` }
      const fd0 = openSync(absPath, 'r')
      let pdfByHeader = false
      try {
        const head = Buffer.alloc(8)
        const n = readSync(fd0, head, 0, 8, 0)
        pdfByHeader = n >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d
      } finally { closeSync(fd0) }
      if (!pdfByHeader) return { error: '未知文件类型，无法范围读取' }
    }
    const st = statSync(absPath)
    const start = Math.max(0, Math.floor(Number(offset) || 0))
    const want = Math.max(0, Math.floor(Number(length) || 0))
    const end = Math.min(st.size, start + want)
    if (start >= st.size) {
      return { buf: Buffer.alloc(0), offset: start, size: st.size, truncated: false }
    }
    const fd = openSync(absPath, 'r')
    try {
      const buf = Buffer.alloc(end - start)
      readSync(fd, buf, 0, buf.length, start)
      return { buf, offset: start, size: st.size, truncated: end < st.size }
    } finally {
      closeSync(fd)
    }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/**
 * 保存前冲突检测（对标 VS Code 的 FILE_MODIFIED_SINCE）。
 *
 * 渲染层打开文件时记录磁盘 mtime 作为"基线"，保存时把基线传回主进程：
 * 若磁盘 mtime 已变化（被其它程序改过），拒绝写入并回报磁盘现状，
 * 由渲染层提示用户三选（重新加载 / 覆盖磁盘 / 取消），避免静默覆盖外部改动。
 *
 * 未传基线（expectedMtimeMs 为空）视为不校验，直接放行（兼容旧调用路径）。
 */
export interface ConflictCheck {
  conflict: boolean
  diskMtimeMs?: number
  diskSize?: number
  missing?: boolean
}

export function detectConflict(absPath: string, expectedMtimeMs: number | null | undefined): ConflictCheck {
  if (typeof expectedMtimeMs !== 'number' || expectedMtimeMs <= 0) return { conflict: false }
  try {
    const st = statSync(absPath)
    // 容差 2ms：部分文件系统 mtime 精度有限，避免同一时刻的误判
    if (Math.abs(st.mtimeMs - expectedMtimeMs) > 2) {
      return { conflict: true, diskMtimeMs: st.mtimeMs, diskSize: st.size }
    }
    return { conflict: false, diskMtimeMs: st.mtimeMs, diskSize: st.size }
  } catch {
    return { conflict: true, missing: true }
  }
}

/** 原子写：临时文件 + rename 覆盖（对标数据库写盘策略，防半写损坏） */
export function writeWorkspaceFile(absPath: string, content: string): void {
  // v3.2.0 条目 ④：落盘前登记「这条路径的变更出自我自己」——fsWatcher 命中即跳过，
  // 否则应用内保存会被监听器当成外部修改，弹「文件已被外部修改」冲突三选（自打自脸）
  markSelfWrite(absPath)
  const real = absPath
  const tmp = join(real, `..`, `.kb-tmp-${randomUUID()}`)
  try {
    writeFileSync(tmp, content, 'utf-8')
    try {
      renameSync(tmp, real)
    } catch {
      // Windows 目标被占用/已存在时：先移除目标再改名
      if (existsSync(real)) unlinkSync(real)
      renameSync(tmp, real)
    }
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

// ===== 仓库登记与持久化（R6 去库化：原 sqlite vaults 表 → userData/data/vaults.json） =====

interface VaultRegistryRow { id: string; name: string; path: string; created_at: string; updated_at: string }

function readVaultRegistry(): VaultRegistryRow[] {
  return globalReadJson<VaultRegistryRow[]>('vaults.json', [])
}

function writeVaultRegistry(rows: VaultRegistryRow[]): void {
  globalWriteJson('vaults.json', rows)
}

function registryNow(): string {
  return new Date().toISOString()
}

/**
 * S6 元数据自愈：清理 `.meta.json` 中磁盘已不存在的孤儿条目与孤儿封面。
 * 幂等、失败不阻塞、无新 IPC / 无新 UI。触发点 = 仓库打开（启动恢复 / 换库 / 按 id 打开），
 * 覆盖「应用关闭期间用户在文件管理器删了书」；运行期删书由 fsWatcher 节流兜底。
 */
function pruneOrphanBookMetaQuiet(): void {
  try {
    const result = bookMetaPruneOrphans()
    if (!result.ok && result.error) console.warn('[bookMetaPruneOrphans] 扫描失败:', result.error)
  } catch (e) {
    console.warn('[bookMetaPruneOrphans] 扫描异常:', (e as Error).message)
  }
}

function loadVaults(): void {
  // P8 设备级自愈：settings.json.recentVaults 有而登记表没有的条目（库缺/损坏），
  // 磁盘上确实存在且含 .knowbase → 回登记（最近列表即第二注册表）。
  try {
    // 含墓碑（deleted）条目：用户从系统回收站恢复目录后，这里自动复活登记并清标记
    // （2026-09-08 用户需求：删除仓库 → 回收站恢复 → 重启回到仓库切换列表）
    for (const rv of readRecentVaults(true)) {
      if (roots.has(rv.rootId)) continue
      if (existsSync(rv.path) && existsSync(join(rv.path, '.knowbase'))) {
        roots.set(rv.rootId, { id: rv.rootId, name: rv.name, rootPath: rv.path })
        upsertVault(rv.rootId, rv.name, rv.path)
        if (rv.deleted) clearRecentDeleted(rv.rootId)
      }
    }
  } catch { /* ignore */ }
  try {
    // 从 JSON 登记表恢复全部已授权仓库（磁盘上已不存在的跳过）
    for (const row of readVaultRegistry()) {
      if (roots.has(row.id)) continue
      if (existsSync(row.path)) roots.set(row.id, { id: row.id, name: row.name, rootPath: row.path })
    }
    // 恢复当前仓库上下文（settings.json 记忆的 currentVaultId）
    const curId = readCurrentVaultId()
    const cur = curId ? roots.get(curId) : undefined
    if (cur) {
      setCurrentVault({ rootId: cur.id, name: cur.name, rootPath: cur.rootPath })
      ensureKbRoot(cur.name)
      // 启动恢复也过一遍一次性布局迁移（P4 博客收拢；幂等）
      runLayoutMigrations(cur.rootPath)
      // v3.2.0 条目 ④：启动即给当前仓库挂上文件监听
      syncVaultWatcher()
      pruneOrphanBookMetaQuiet()
    }
  } catch {
    /* 登记表未就绪等：忽略，openDir 时重新登记 */
  }
}

function findVaultIdByPath(path: string): string | null {
  return readVaultRegistry().find((r) => r.path === path)?.id ?? null
}

function upsertVault(id: string, name: string, path: string): void {
  try {
    const rows = readVaultRegistry()
    const now = registryNow()
    const row = rows.find((r) => r.path === path)
    if (row) {
      row.id = id
      row.name = name
      row.updated_at = now
    } else {
      rows.push({ id, name, path, created_at: now, updated_at: now })
    }
    writeVaultRegistry(rows)
  } catch {
    /* ignore */
  }
}

function removeVault(id: string): void {
  try {
    writeVaultRegistry(readVaultRegistry().filter((r) => r.id !== id))
  } catch {
    /* ignore */
  }
}

function listRecentVaults(): Array<{ rootId: string; name: string; path: string; updatedAt: string }> {
  try {
    return readVaultRegistry()
      .slice()
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .map((r) => ({ rootId: r.id, name: r.name, path: r.path, updatedAt: r.updated_at }))
  } catch {
    return []
  }
}

// ===== IPC =====

function requireRoot(rootId: string): RootInfo {
  const r = roots.get(rootId)
  if (!r) throw new Error('未授权的工作区')
  return r
}

/**
 * D7（P1）：对话框选中、但顶层无 .knowbase 的目录——暂存待用户确认「初始化为仓库」。
 * 路径只存主进程，渲染层用 ws:initPendingVault(accept) 表态，维持「渲染层不接触绝对路径」原则。
 */
let pendingVaultPath: string | null = null

/** 把目录登记为仓库 + 设为当前 + 初始化 .knowbase（openDir 确认初始化与 createVault 复用） */
function adoptVaultDirectory(rootPath: string, name?: string): { rootId: string; name: string; path: string } {
  const id = findVaultIdByPath(rootPath) ?? randomUUID()
  const vaultName = name ?? basename(rootPath)
  roots.set(id, { id, name: vaultName, rootPath })
  upsertVault(id, vaultName, rootPath)
  setCurrentVault({ rootId: id, name: vaultName, rootPath })
  // 首次初始化（meta.json 尚不存在）→ 落一份欢迎文档到仓库根：已登记仓库重开/删除后重开均不复活
  const isFirstInit = !existsSync(join(rootPath, '.knowbase', 'meta.json'))
  ensureKbRoot(vaultName)
  if (isFirstInit) writeWelcomeDocOnce(rootPath)
  runLayoutMigrations(rootPath)
  // v3.2.0 条目 ④：仓库（换）了 → 文件监听对准它
  syncVaultWatcher()
  pruneOrphanBookMetaQuiet()
  return { rootId: id, name: vaultName, path: rootPath }
}

/** P6 导入收尾用：把已落盘内容的目录登记为仓库（与 openDir 确认流同一实现） */
export function adoptImportedVault(rootPath: string, name?: string): { rootId: string; name: string; path: string } {
  return adoptVaultDirectory(rootPath, name)
}

/** 递归删空目录（自底向上，只删空——冲突保留件所在的非空目录绝不触碰） */
function cleanupEmptyDirsDeep(dir: string): void {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    const p = join(dir, n)
    try { if (statSync(p).isDirectory()) cleanupEmptyDirsDeep(p) } catch { /* ignore */ }
  }
  try { rmdirSync(dir) } catch { /* 非空/占用 → 原地保留 */ }
}

/**
 * D3（P4）：博客整体迁入 .knowbase/blog/（幂等，frontmatter id 不变）。
 * 原实现含 sqlite 附件落盘与 attachment:// 链接改写，随 connection.ts 删除一并移除；
 * 现仅保留目录迁移：根 blog/*.md → .knowbase/blog/（目标已存在 = 迁过/重名 → 跳过，幂等可重跑）。
 */
function migrateBlogLayoutIntoKnowbase(rootPath: string): void {
  const srcRoot = join(rootPath, 'blog')
  const dstRoot = join(rootPath, '.knowbase', 'blog')
  try {
    if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) return
    const files: string[] = []
    const collect = (dir: string): void => {
      let names: string[] = []
      try { names = readdirSync(dir) } catch { return }
      for (const n of names) {
        const p = join(dir, n)
        try {
          if (statSync(p).isDirectory()) collect(p)
          else if (n.toLowerCase().endsWith('.md')) files.push(p)
        } catch { /* ignore */ }
      }
    }
    collect(srcRoot)
    let conflicts = 0
    for (const f of files) {
      const target = join(dstRoot, relative(srcRoot, f))
      if (existsSync(target)) { conflicts++; continue }
      try {
        mkdirSync(dirname(target), { recursive: true })
        renameSync(f, target)
      } catch { /* 单文件失败原地保留 */ }
    }
    // 无冲突即清理空残留（只删空目录；重跑 moved=0 也能收掉上次留下的空壳）
    if (conflicts === 0) cleanupEmptyDirsDeep(srcRoot)
  } catch { /* 目录不可读：跳过 */ }
}

/** 打开/创建/恢复仓库时的一次性布局迁移（P4 起 = 博客收拢；失败不阻断进入） */
function runLayoutMigrations(rootPath: string): void {
  try {
    migrateBlogLayoutIntoKnowbase(rootPath)
  } catch (e) {
    console.warn('[vault-layout] Blog layout migration failed (non-blocking):', (e as Error)?.message || e)
  }
}

// ===== 附件落盘（P3 编辑器插图：选图/粘贴共用；D1 目标 = 仓库根 .attachments/<年-月>/）=====

const IMAGE_EXT_WHITELIST = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
const MAX_STAGE_IMAGE = 30 * 1024 * 1024

function yearMonthDir(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 文件名净化：Windows 非法字符与控制符 → `_`（导出供 Web 剪藏标题净化复用，全应用同一口径） */
export function sanitizeFileName(name: string): string {
  const n = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  return n || 'image'
}

/** 原名去重：冲突时加时间戳后缀（D1 命名约定） */
function uniqueAttachmentName(dirAbs: string, fileName: string): string {
  if (!existsSync(join(dirAbs, fileName))) return fileName
  const ext = extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  return `${stem}-${Date.now()}${ext}`
}

/** 图片字节流入附件区：.attachments/<年-月>/<名>.<ext>；返回仓库根相对 POSIX 路径（md 相对链接用） */
export function stageImageBytes(rootPath: string, fileName: string, data: Buffer): { name: string; relPath: string } {
  const safe = sanitizeFileName(fileName)
  const ext = extname(safe).slice(1).toLowerCase()
  if (!IMAGE_EXT_WHITELIST.has(ext)) throw new Error(`不支持的图片类型：.${ext || '?'}`)
  if (data.length === 0 || data.length > MAX_STAGE_IMAGE) throw new Error('图片为空或超过 30MB')
  const ym = yearMonthDir()
  const dirAbs = join(rootPath, ATTACHMENTS_DIR, ym)
  mkdirSync(dirAbs, { recursive: true })
  const name = uniqueAttachmentName(dirAbs, safe)
  writeFileSync(join(dirAbs, name), data)
  return { name, relPath: `${ATTACHMENTS_DIR}/${ym}/${name}` }
}

function requireInside(rootId: string, relPath: unknown): string {
  const r = requireRoot(rootId)
  const abs = resolveSafe(r.rootPath, relPath)
  if (!abs) throw new Error('路径越界或非法')
  return abs
}

/** 知识索引失效：仅当被改动的根就是当前仓库时才有缓存可失效（P0 懒重建，只删缓存 JSON）。
 *  ws:writeFile/ws:createFile 与 AI vault.write/edit 共用——任何 .md 落盘后必须过这里，
 *  否则知识列表/图谱/反链读到旧缓存（AI 写页 UI 不可见的根因，2026-09 修复）。 */
export function invalidateIndexIfCurrentVault(rootId: string): void {
  if (getCurrentVault()?.rootId !== rootId) return
  invalidateKnowledgeIndex()
  invalidateGraphIndex()
}

/** 保存的 .md 命中知识页 → 发 knowledge:pageSaved（plugin-phase1-design C4）。
 *  索引只有 byId 映射，这里 O(n) 路径扫描——保存是低频用户动作，可接受。 */
function emitKnowledgePageSaved(relPath: string): void {
  try {
    const norm = relPath.replace(/\\/g, '/')
    const byId = getKnowledgeIndex().byId
    for (const entry of Object.values(byId)) {
      if (entry.path.replace(/\\/g, '/') === norm) {
        emitPluginEvent('knowledge:pageSaved', { pageId: entry.id, title: entry.title })
        return
      }
    }
  } catch { /* 索引未就绪等忽略 */ }
}

/** 知识索引敏感文件：知识页 .md 与过滤规则 .ignore（docs/ignore-filter-design.md）。
 *  .ignore 规则一变，知识索引的可见集（列表/搜索/图谱/AI 检索）整体变化，必须与 .md 同等失效。 */
function isKnowledgeIndexSensitive(relPath: string): boolean {
  const name = relPath.replace(/\\/g, '/').split('/').pop() ?? ''
  const lower = name.toLowerCase()
  return lower.endsWith('.md') || lower === IGNORE_FILE_NAME
}

/**
 * md 归档双态核心（ws:setMdStatus 与 ws:setArchiveStatus 共用）——随归档能力于 2026-09-20 退役。
 */
/** 重命名/移动（跨目录；ws:rename 与 AI vault.rename 共用同一语义，成功后失效索引） */
export function renameWorkspacePath(rootId: string, oldRel: string, newRel: string): void {
  const from = requireInside(rootId, oldRel)
  const to = requireInside(rootId, newRel)
  if (!existsSync(from)) throw new Error('源文件不存在')
  if (existsSync(to)) throw new Error('目标已存在')
  // 目标父目录缺失时自动补建父链（renameSync 不建父目录）——移动语义的 mkdir -p，
  // 与「新建目录」的 ws:mkdir（重名自动加后缀）严格区分，绝不产生 (1) 镜像目录
  mkdirSync(dirname(to), { recursive: true })
  // v3.2.0 条目 ④：应用内改名/移动同样登记自写（否则监听器会把「我自己刚改的」当成外部改动，
  // 正在编辑的文件会误弹三选）；新旧两条路径都登记
  markSelfWrite(from)
  markSelfWrite(to)
  renameSync(from, to)
  invalidateIndexIfCurrentVault(rootId)
}

/** 移入系统回收站（绝不 rm；ws:trash 与 AI vault.trash 共用同一语义） */
export async function trashWorkspacePath(rootId: string, relPath: string): Promise<void> {
  const abs = requireInside(rootId, relPath)
  if (!existsSync(abs)) throw new Error('文件不存在')
  // v3.2.0 条目 ④：应用内删除登记自写（正被编辑的文件由编辑器自己关闭标签，
  // 不该再走「文件已在磁盘上被删除」三选——那是给外部删除准备的）
  markSelfWrite(abs)
  const trash = (await import('trash')).default
  await trash([abs])
  invalidateIndexIfCurrentVault(rootId)
}

export function registerWorkspaceHandlers(getSetting?: (key: string) => unknown): void {
  loadVaults()

  // 打开/登记仓库：系统对话框授权（用户意图的唯一来源）
  ipcMain.handle('ws:openDir', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择工作区文件夹（仓库）',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const rootPath = result.filePaths[0]
    // .knowbase 等隐藏目录是仓库内部数据目录，不是仓库根——选中时拒绝并引导选父目录
    if (basename(rootPath).startsWith('.')) {
      return { error: '「. 开头」的隐藏目录是仓库内部数据目录，不能作为仓库根，请选择它的父目录' }
    }
    // P5a 嵌套防护：路径任一段为 .knowbase = 某仓库内部（如 .knowbase\cache\proj），拒绝再登记为仓库根
    if (rootPath.split(sep).some((s) => s.toLowerCase() === '.knowbase')) {
      return { error: '该路径位于 .knowbase 数据目录内部，一个仓库最多一个 .knowbase，请选择仓库根目录' }
    }
    pendingVaultPath = null
    // D7：顶层无 .knowbase → 该文件夹不是仓库。返回 notVault，待渲染层确认后走 ws:initPendingVault，
    // 不再静默自动建（原行为：直接 ensureKbRoot 建骨架）
    if (!existsSync(join(rootPath, '.knowbase'))) {
      pendingVaultPath = rootPath
      return { notVault: true, name: basename(rootPath), path: rootPath }
    }
    return adoptVaultDirectory(rootPath)
  })

  // D7 确认表态：accept=true → 初始化并进入；false → 放弃（清暂存路径）。返回 ok=false 表示无暂存/已取消
  ipcMain.handle('ws:initPendingVault', (_e, accept: unknown) => {
    const p = pendingVaultPath
    pendingVaultPath = null
    if (accept !== true || !p) return { ok: false }
    try {
      return { ok: true, ...adoptVaultDirectory(p) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 创建仓库（首启引导 Obsidian 式流程）：名称 + 位置 → mkdir + 登记 + 设为当前。
  // parentPath 缺省/'__default__' = 用户文档目录（快速开始路径）；目录已存在且为目录 → 直接登记复用（幂等）
  ipcMain.handle('ws:createVault', async (_e, name: string, parentPath?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return { error: '请输入仓库名称' }
    if (/[\\/:*?"<>|]/.test(trimmed)) return { error: '名称不能包含 \\ / : * ? " < > | 等字符' }
    if (trimmed.startsWith('.')) return { error: '名称不能以 . 开头（隐藏目录是仓库内部数据目录）' }

    let parent = parentPath && parentPath !== '__default__' ? parentPath : ''
    if (!parent) {
      if (parentPath !== '__default__') {
        // 未指定位置且非快速开始 → 弹系统对话框选位置（渲染层通常已先经 openDirDialog 选好传入）
        if (!win) return { error: '无可交互窗口' }
        const result = await dialog.showOpenDialog(win, {
          title: '选择新仓库的存放位置',
          properties: ['openDirectory', 'createDirectory'],
        })
        if (result.canceled || result.filePaths.length === 0) return null
        parent = result.filePaths[0]
      } else {
        parent = app.getPath('documents')
      }
    }

    const rootPath = join(parent, trimmed)
    if (existsSync(rootPath)) {
      if (!statSync(rootPath).isDirectory()) return { error: `同名文件已存在于 ${parent}` }
    } else {
      try {
        mkdirSync(rootPath, { recursive: true })
      } catch (e) {
        return { error: `创建文件夹失败：${(e as Error).message}` }
      }
    }
    // 复用统一登记路径（含 D3 布局迁移；空目录时为空操作，幂等）
    return adoptVaultDirectory(rootPath, trimmed)
  })

  // 枚举目录
  ipcMain.handle('ws:listDir', (_e, rootId: string, relPath: string) => {
    try {
      const abs = requireInside(rootId, relPath ?? '')
      const entries = listDirEntries(abs)
      // 软件生成项名单（2026-09-08）：仅仓库根层返回——SOFT_ENTRY_NAMES 固定项（.ignore 等，
      // 新增软件生成文件登记此集合）+ AI教学 产物根（aiTeachRootDir 设置动态）。渲染层据
      // softNames 在文件树底部渲染「软件文件」折叠节（默认收起）；子目录不受影响
      const atRoot = !relPath || relPath === '' || relPath === '.' || relPath === './'
      let softNames: string[] | undefined
      if (atRoot) {
        const sink = new Set<string>([...SOFT_ENTRY_NAMES, ...(getSetting ? [rootDirName(getSetting).toLowerCase()] : [])])
        softNames = entries.filter((e) => sink.has(e.name.toLowerCase())).map((e) => e.name)
      }
      return { entries, softNames }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // 读文件
  ipcMain.handle('ws:readFile', (_e, rootId: string, relPath: string) => {
    try {
      const abs = requireInside(rootId, relPath)
      return readWorkspaceFile(abs)
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // 二进制读图（vault 附件相对路径解析 → data:URI；附件白名单防越界）
  ipcMain.handle('ws:readImage', (_e, rootId: string, relPath: string) => {
    try {
      const abs = requireInside(rootId, relPath)
      // 白名单：根级 .attachments/（D1 新附件区）+ 历史 .knowbase/_attachments/ + 二进制扩展
      const lower = abs.toLowerCase()
      if (!lower.includes(`${sep}.attachments${sep}`) && !lower.includes(`${sep}.knowbase${sep}_attachments${sep}`)) {
        return { error: '路径不在附件白名单' }
      }
      const buf = readFileSync(abs)
      const ext = abs.toLowerCase().split('.').pop() || ''
      const mime =
        ext === 'svg' ? 'image/svg+xml' :
        ext === 'png' ? 'image/png' :
        ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
        ext === 'gif' ? 'image/gif' :
        ext === 'webp' ? 'image/webp' :
        'application/octet-stream'
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // P3：选图入附件区——对话框在主进程，复制落 .attachments/<年-月>/，返回仓库根相对链接（渲染层不接触绝对路径）
  ipcMain.handle('ws:pickImagesToAttachments', async (_e, rootId: string) => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) return { ok: false, error: '无可交互窗口' }
      const r = await dialog.showOpenDialog(win, {
        title: '选择插图',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
      })
      if (r.canceled || r.filePaths.length === 0) return { ok: false }
      const root = requireRoot(rootId).rootPath
      const images: { name: string; relPath: string }[] = []
      for (const srcAbs of r.filePaths) {
        try {
          const ext = extname(srcAbs).slice(1).toLowerCase()
          if (!IMAGE_EXT_WHITELIST.has(ext)) continue
          const st = statSync(srcAbs)
          if (!st.isFile() || st.size === 0 || st.size > MAX_STAGE_IMAGE) continue
          const out = stageImageBytes(root, basename(srcAbs), readFileSync(srcAbs))
          images.push(out)
        } catch { /* 单个不可读跳过，不中断 */ }
      }
      return images.length > 0 ? { ok: true, images } : { ok: false, error: '没有可导入的图片（类型不支持或过大）' }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // P3：剪贴板粘贴截图 → base64 过 IPC 落附件区（同 stageImageBytes 规则）
  ipcMain.handle('ws:saveImageToAttachments', (_e, rootId: string, payload: { fileName: unknown; dataBase64: unknown }) => {
    try {
      const root = requireRoot(rootId).rootPath
      const b64 = typeof payload?.dataBase64 === 'string' ? payload.dataBase64 : ''
      if (b64.length === 0 || b64.length > Math.ceil(MAX_STAGE_IMAGE / 3) * 4) return { ok: false, error: '图片为空或超过 30MB' }
      const buf = Buffer.from(b64, 'base64')
      const out = stageImageBytes(root, typeof payload?.fileName === 'string' ? payload.fileName : 'image.png', buf)
      return { ok: true, ...out }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 二进制范围读取（PDF 阅读器懒加载）：白名单扩展名 + 精确读段，复用 resolveSafe 防穿越
  ipcMain.handle('ws:readRange', (_e, rootId: string, relPath: string, offset: unknown, length: unknown) => {
    try {
      const abs = requireInside(rootId, relPath)
      return readWorkspaceRange(abs, offset, length)
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // 同上的**字节**版本（B-16）：foliate 系阅读器整本取字节，免掉渲染侧 base64 解码那 ~660ms/96MB。
  // 与 ws:readRange 共用 readRangeBuffer，白名单与防穿越语义完全一致。
  ipcMain.handle('ws:readRangeBytes', (_e, rootId: string, relPath: string, offset: unknown, length: unknown) => {
    try {
      const abs = requireInside(rootId, relPath)
      return readWorkspaceRangeBytes(abs, offset, length)
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // 写文件（原子写 + 保存冲突检测）
  // expectedMtimeMs 为打开文件时记录的磁盘 mtime；不一致说明被外部改过 → 拒绝写入，交渲染层决策
  ipcMain.handle('ws:writeFile', (_e, rootId: string, relPath: string, content: string, expectedMtimeMs?: number) => {
    try {
      if (typeof content !== 'string') throw new Error('内容必须是文本')
      const abs = requireInside(rootId, relPath)
      const chk = detectConflict(abs, expectedMtimeMs)
      if (chk.conflict) {
        return { ok: false, conflict: true, diskMtimeMs: chk.diskMtimeMs, diskSize: chk.diskSize, missing: chk.missing === true }
      }
      writeWorkspaceFile(abs, content)
      if (isKnowledgeIndexSensitive(relPath)) {
        invalidateIndexIfCurrentVault(rootId)
        if (relPath.toLowerCase().endsWith('.md')) emitKnowledgePageSaved(relPath)
      }
      const st = statSync(abs)
      return { ok: true, mtimeMs: st.mtimeMs, size: st.size }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 新建文件（content 可选：编辑器「新建知识页」一步写入 frontmatter 模板）
  ipcMain.handle('ws:createFile', (_e, rootId: string, relPath: string, content?: string) => {
    try {
      const requestedAbs = requireInside(rootId, relPath)
      const dir = dirname(requestedAbs)
      const requestedName = basename(requestedAbs)
      // 重名自动加后缀（对标 VS Code/常见文件管理器）—— 不弹失败而是创建"新建.md(1).md"等
      const finalName = uniqueFileName(dir, requestedName)
      const finalAbs = join(dir, finalName)
      if (typeof content === 'string' && content.length > 0) {
        writeWorkspaceFile(finalAbs, content)
      } else {
        writeFileSync(finalAbs, '', 'utf-8')
      }
      if (isKnowledgeIndexSensitive(finalAbs)) invalidateIndexIfCurrentVault(rootId)
      const finalRel = finalName === requestedName ? relPath : relPath.replace(/[^\\/]+$/, finalName)
      return { ok: true, relPath: finalRel, renamed: finalName !== requestedName }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 新建目录（重名自动加后缀；父链缺失自动补建——FileTree 在懒建的工作区子层下新建时父目录尚不存在）
  ipcMain.handle('ws:mkdir', (_e, rootId: string, relPath: string) => {
    try {
      const requestedAbs = requireInside(rootId, relPath)
      const dir = dirname(requestedAbs)
      const requestedName = basename(requestedAbs)
      mkdirSync(dir, { recursive: true })
      const finalName = uniqueFileName(dir, requestedName)
      const finalAbs = join(dir, finalName)
      mkdirSync(finalAbs, { recursive: false })
      const finalRel = finalName === requestedName ? relPath : relPath.replace(/[^\\/]+$/, finalName)
      return { ok: true, relPath: finalRel, renamed: finalName !== requestedName }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  /**
   * 粘贴系统剪贴板里的外部文件/目录到仓库内某个目录（v3.2.0 条目 ③）。
   *
   * **路径来源为什么在渲染层**：主进程侧唯一的读法是 `clipboard.readBuffer('FileNameW')`，
   * 实测（2026-09-15 探针，Electron 33.2.0 / win32）它**只能拿到第一条路径**、且载荷里没有
   * DROPFILES 头——同一次剪贴板，PS 回读 3/3、渲染层 paste 事件 3/3、主进程只得 1/3，
   * 即多选会**静默丢文件**。故改由渲染层 `paste` 事件 + `webUtils.getPathForFile` 取全量路径
   * （Electron 32+ 官方路线，File.path 已移除），本通道只负责落盘。
   *
   * 因而 `srcPaths` 是**不可信输入**，逐条校验（绝对路径 / 真实存在 / 非符号链接）；
   * 目标目录仍由 requireInside 单向守——渲染层永远只说 `{ rootId, relDir }`，不接触落盘绝对路径。
   */
  ipcMain.handle('ws:pasteExternal', async (_e, rootId: string, relDir: string, srcPaths: unknown) => {
    const skipped: Array<{ path: string; reason: string }> = []
    const pasted: string[] = []
    try {
      const destDir = requireInside(rootId, relDir)
      const list = Array.isArray(srcPaths)
        ? srcPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
        : []
      if (list.length === 0) return { ok: false, reason: 'empty', pasted, skipped }
      if (!statSync(destDir).isDirectory()) return { ok: false, reason: 'notdir', pasted, skipped }

      for (let i = 0; i < list.length; i++) {
        const src = list[i]
        if (i >= MAX_PASTE_ITEMS) { skipped.push({ path: src, reason: `超出单次上限 ${MAX_PASTE_ITEMS}` }); continue }
        try {
          if (!isAbsolute(src)) { skipped.push({ path: src, reason: '不是绝对路径' }); continue }
          const lst = lstatSync(src) // lstat：不跟随符号链接，避免把仓库外内容链进来
          if (lst.isSymbolicLink()) { skipped.push({ path: src, reason: '符号链接' }); continue }
          const name = basename(src)
          if (!name) { skipped.push({ path: src, reason: '无法解析文件名' }); continue }
          // 把某目录粘进它自己（或其子孙）会无限递归；把仓库根粘进仓库同理
          if (isInside(src, destDir)) { skipped.push({ path: src, reason: '目标位于源目录内' }); continue }
          const finalName = vscodeCopyName(destDir, name)
          await cp(src, join(destDir, finalName), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
          pasted.push(finalName)
        } catch (err) {
          skipped.push({ path: src, reason: (err as Error).message })
        }
      }
      if (pasted.some((n) => /\.md$/i.test(n))) invalidateIndexIfCurrentVault(rootId)
      return { ok: pasted.length > 0, pasted, skipped }
    } catch (e) {
      return { ok: false, reason: 'error', error: (e as Error).message, pasted, skipped }
    }
  })

  // 归档能力于 2026-09-20 整体退役（阶段三，docs/note-identity-unify-design.md §3）：
  // `ws:setMdStatus` / `ws:setArchiveStatus` / `ws:getArchiveEntries` 三条通道与 `archivedFilesRepo` 一并删除。
  // 想隐藏 = 写 .ignore；想分层 = 挪进目录（目录即分类）。

  // 重命名/移动（新旧路径都必须在根内；实现见模块级 renameWorkspacePath）
  ipcMain.handle('ws:rename', (_e, rootId: string, oldRel: string, newRel: string) => {
    try {
      renameWorkspacePath(rootId, oldRel, newRel)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 删除 → 系统回收站（绝不 rm；实现见模块级 trashWorkspacePath）
  ipcMain.handle('ws:trash', async (_e, rootId: string, relPath: string) => {
    try {
      await trashWorkspacePath(rootId, relPath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 用系统默认程序打开仓库内文件 / 在资源管理器中定位（B-3 归档元信息卡）
  // ★ 信任边界与 ws:trash 一致：只收 rootId + relPath，绝对路径一律经 requireInside 解析，
  //   渲染层无法借此打开仓库外的任意文件。通用的 app:openExternal 只放行 userData 内的路径，
  //   仓库文件会被它的安全拦截挡掉，故必须单开这条通道。
  ipcMain.handle('ws:openInSystem', async (_e, rootId: string, relPath: string, reveal?: boolean) => {
    try {
      const abs = requireInside(rootId, relPath)
      if (!existsSync(abs)) return { ok: false, error: '文件不存在（可能已被移动或删除）' }
      if (reveal === true) {
        shell.showItemInFolder(abs)
        return { ok: true }
      }
      const err = await shell.openPath(abs)
      return err ? { ok: false, error: err } : { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 文件信息（打开前校验）
  ipcMain.handle('ws:stat', (_e, rootId: string, relPath: string) => {
    try {
      const abs = requireInside(rootId, relPath)
      const st = statSync(abs)
      return { size: st.size, mtime: st.mtimeMs, isDir: st.isDirectory() }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // 最近仓库
  ipcMain.handle('ws:getRecent', () => listRecentVaults())

  // 恢复最近仓库：按 rootId 从 JSON 登记表取回路径（该根已获授权，无需重新弹框）
  ipcMain.handle('ws:openById', (_e, rootId: string) => {
    try {
      if (typeof rootId !== 'string' || !rootId) throw new Error('非法工作区 id')
      if (!roots.has(rootId)) {
        const row = readVaultRegistry().find((r) => r.id === rootId)
        if (row && existsSync(row.path)) {
          roots.set(row.id, { id: row.id, name: row.name, rootPath: row.path })
        }
      }
      const r = roots.get(rootId)
      if (!r) throw new Error('工作区不存在或已被移除')
      setCurrentVault({ rootId: r.id, name: r.name, rootPath: r.rootPath })
      ensureKbRoot(r.name)
      runLayoutMigrations(r.rootPath)
      // 切换仓库后失效新仓库缓存（多仓库陈旧兜底，与 ws:openDir 同策略）
      invalidateIndexIfCurrentVault(r.id)
      invalidateGraphIndex()
      // v3.2.0 条目 ④：切仓库 → 监听跟随（旧仓库的改动不再触发刷新）
      syncVaultWatcher()
      pruneOrphanBookMetaQuiet()
      return { rootId: r.id, name: r.name, path: r.rootPath }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // 当前仓库（应用启动引导 / 模块数据定位）
  ipcMain.handle('ws:getCurrent', () => {
    const cur = getCurrentVault()
    return cur ? { rootId: cur.rootId, name: cur.name, path: cur.rootPath } : null
  })

  // 在系统文件管理器中打开当前仓库文件夹（资源管理器/Finder；标题栏仓库菜单入口）
  ipcMain.handle('ws:revealVault', async () => {
    const cur = getCurrentVault()
    if (!cur) return { ok: false, error: '当前没有打开的仓库' }
    if (!existsSync(cur.rootPath)) return { ok: false, error: '仓库文件夹不存在（可能已被移动或删除）' }
    const err = await shell.openPath(cur.rootPath)
    return err ? { ok: false, error: err } : { ok: true }
  })

  // 设置 → 关于 → 新手引导：把《欢迎》导览页（HTML）重新导入仓库根并收录进知识库。
  // 解耦于「首次初始化才落盘」的 writeWelcomeDocOnce —— 误删后恢复、或想拿最新版导览时手动触发。
  // force=false 且仓库根已有同名文件时**不写盘**，只回报 exists，由渲染层弹应用内确认再带 force 重来
  // （欢迎页是用户可自由改写的普通文件，静默覆盖会吃掉用户的编辑）。
  ipcMain.handle('ws:importWelcomeDoc', (_e, force: unknown) => {
    const cur = getCurrentVault()
    if (!cur) return { ok: false, error: '当前没有打开的仓库' }
    if (!existsSync(cur.rootPath)) return { ok: false, error: '仓库文件夹不存在（可能已被移动或删除）' }
    const before = getWelcomeDocState(cur.rootPath)
    if (before.hasHtml && force !== true) return { ok: false, exists: true, hasLegacyMd: before.hasLegacyMd }
    const r = importWelcomeDoc(cur.rootPath)
    if (!r.ok) return { ok: false, error: `导入失败：${r.error}` }
    invalidateKnowledgeIndex()
    invalidateGraphIndex()
    return {
      ok: true,
      created: !before.hasHtml,
      // 旧版 欢迎.md（09-08~09-09 窗口期产物）会让知识库列表出现两条「欢迎」，提示用户自行取舍
      hasLegacyMd: before.hasLegacyMd,
      relPath: WELCOME_DOC_FILENAME,
    }
  })

  // 移除授权（从 roots 内存与 JSON 登记表）
  ipcMain.handle('ws:forget', (_e, rootId: string) => {
    roots.delete(rootId)
    removeVault(rootId)
    return { ok: true }
  })

  // P8（D8）：重命名当前仓库——改展示名（roots 内存 + JSON 登记表 + .knowbase/meta.json + 最近列表），
  // 不动文件夹名（路径即身份；改磁盘目录名会破坏全部登记，风险不对称）
  ipcMain.handle('ws:renameVault', (_e, name: unknown) => {
    const cur = getCurrentVault()
    if (!cur) return { error: '当前没有打开的仓库' }
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return { error: '请输入仓库名称' }
    if (/[\\/:*?"<>|]/.test(trimmed) || trimmed.startsWith('.')) return { error: '名称不能含 \\ / : * ? " < > | 且不能以 . 开头' }
    const r = roots.get(cur.rootId)
    if (r) r.name = trimmed
    upsertVault(cur.rootId, trimmed, cur.rootPath)
    setCurrentVault({ ...cur, name: trimmed })
    setVaultMetaName(cur.rootPath, trimmed)
    return { ok: true, name: trimmed }
  })

  // P7（D6）：删除仓库 = 整仓进 OS 回收站（不弹提醒窗；注册表移除与当前态清理由本 handler 完成）
  // 入口在设置深处（R4）；护栏 isAllowedClearRoot 防配置损坏误删整盘；回收站可还原兜底。
  ipcMain.handle('ws:deleteVault', async (_e, rootId: string) => {
    const r = roots.get(rootId)
    if (!r) return { error: '仓库不存在或已被移除' }
    if (!isAllowedClearRoot(r.rootPath)) return { error: '仓库路径校验失败，已中止（未删除任何内容）' }
    try {
      await trashVaultFolder(r.rootPath)
    } catch (e) {
      return { error: (e as Error).message }
    }
    roots.delete(rootId)
    try { removeVault(rootId) } catch { /* 登记表行可能已不在，忽略 */ }
    // 2026-09-08 墓碑：保留最近列表记录并标记 deleted（用户从回收站恢复目录后重启自动复活登记）
    markRecentDeleted(rootId)
    const wasCurrent = getCurrentVault()?.rootId === rootId
    if (wasCurrent) {
      setCurrentVault(null)
      invalidateKnowledgeIndex()
      invalidateGraphIndex()
      // v3.2.0 条目 ④：当前仓库被删 → 关掉监听（目录已进回收站）
      syncVaultWatcher()
    }
    return { ok: true, deletedCurrent: wasCurrent }
  })

  // 退出当前仓库（2026-09-08 dev「模拟新用户」用；语义 = 回到未进入状态，仓库数据/登记不动）：
  // 清内存与 settings 的 currentVaultId → 渲染层重载后 workspaceGetCurrent 为空 → 走欢迎/选择仓库页
  ipcMain.handle('ws:clearCurrentVault', () => {
    const was = getCurrentVault()?.rootId ?? null
    setCurrentVault(null)
    invalidateKnowledgeIndex()
    invalidateGraphIndex()
    // v3.2.0 条目 ④：退出仓库 → 关掉监听
    syncVaultWatcher()
    return { ok: true, cleared: was }
  })

  /**
   * v3.2.0 条目 ④ 保底机制：手动「刷新资源管理器」（口径 (b) 全量）。
   *
   * 语义对齐 VS Code 的 `workbench.action.files.refreshExplorer`，但本项目「文件树」与
   * 「知识索引 / 归档清单」是两套缓存 → 全量口径 = 文件树（渲染层重扫已加载目录，见
   * `src/modules/editor/index.tsx`）+ 知识索引/图谱失效 + 归档清单僵尸条目清理，
   * 避免「树刷新了、知识库还是旧的」这种半刷新态。
   *
   * 主进程侧**不需要读目录**：`ws:listDir` 没有缓存（每次实时 readdir），所以这个按钮
   * 从定义上就读不到旧值、不存在「假刷新」——这也正是它能当真保底的根本原因。
   */
  ipcMain.handle('ws:refreshVault', () => {
    const cur = getCurrentVault()
    if (!cur) return { ok: false, error: '当前没有打开的仓库' }
    if (!existsSync(cur.rootPath)) return { ok: false, error: '仓库文件夹不存在（可能已被移动或删除）' }
    invalidateKnowledgeIndex()
    invalidateGraphIndex()
    // 归档清单 prune（gcArchiveEntries）随归档退役一并移除（2026-09-20 §3）
    broadcastDataChanged('knowledge')
    return { ok: true, pruned: 0 }
  })
}

/**
 * 全局重置（db:clearAllData，P7 语义替换 rmSync 直删）：把全部已登记仓库逐个送 OS 回收站
 * 并移除注册。校验失败/删除失败的仓库跳过并回报错误（绝不半途强删）。
 */
export async function trashAllRegisteredVaults(): Promise<{ trashed: number; errors: string[] }> {
  const errors: string[] = []
  let trashed = 0
  for (const [id, r] of [...roots.entries()]) {
    if (!isAllowedClearRoot(r.rootPath)) { errors.push(`${r.name}：路径校验失败，已跳过`); continue }
    try {
      await trashVaultFolder(r.rootPath)
      trashed++
      roots.delete(id)
      try { removeVault(id) } catch { /* ignore */ }
      forgetRecentVault(id)
    } catch (e) {
      errors.push(`${r.name}：${(e as Error).message}`)
    }
  }
  setCurrentVault(null)
  invalidateKnowledgeIndex()
  invalidateGraphIndex()
  // v3.2.0 条目 ④：全部仓库已进回收站 → 关掉监听
  syncVaultWatcher()
  return { trashed, errors }
}

/** 全局重置兜底：清空 JSON 登记表（回首启引导重新选/建仓库） */
export function clearVaultRegistry(): void {
  writeVaultRegistry([])
}
