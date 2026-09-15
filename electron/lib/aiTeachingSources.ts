import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'fs'
import { join, basename, isAbsolute, relative } from 'path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { getCurrentVault } from './kbStore/vaultContext'
import { broadcastTreeRefresh, ensureSessionFolder, ensureWriteOwnerFolder, rootDirName, sanitizeTitle, sessionFolder, sourceTemplateText } from './aiTeachingFolders'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { listWorkspaces, workspaceFolderRel } from './aiTeachingWorkspaces'
import { uniqueFileName } from './workspaceManager'
import { extractPdfRange, extractPptxPages } from './docsReader'
import { visionChat, findVisionModel } from './llmService'
import { convertToPdf, probeSoffice, resetSofficeCache } from './sofficeConvert'
import { probeWeb, crawlQueue, type ProbeResult, type TocChapter } from './webCrawler'
import { appendAudit, countMonthVisionTokens, countMonthVisionPages } from './pluginAudit'
import { getAgentSession } from './agentSessionRepo'
// 素材类型识别的代码扩展名清单与 AI 读白名单同源（v3.2.0 条目 9 三处合一）：
// 连带效果 = 素材库不再把 json/yml/yaml/toml/ini 五个配置类识别为 code（拍板④ 配置类不放开）
import { AI_TEXT_CODE_EXTS } from '../../src/lib/aiTextExts'

/**
 * AI教学模块 · 素材库（总纲 docs/ai-teaching-module-rework.md §3.13 结构 v3，P6）
 *
 * 权威结构（v3.1.1 起：**素材归属上移工作区层**）：
 * - 主登记库 = **工作区级** `SOURCES/SOURCE.md`（工作区层 = 会话文件夹的父目录；未归一=产物根层）。
 *   教材/讲义是课程资产，天然跨对话复用——之前登记在对话级，导致新建对话即空手，
 *   每开一个「教我学」都从「资料还没登记」开始。
 * - 对话级 `SOURCES/{对话夹名}/SOURCE.md` **降级为「对话私有补充」**（路径与格式不变，
 *   存量数据原地保留）；读接口把两层**合并**呈现并统一重编号，「存量迁移 = 合并读展示」。
 * - 素材原件（3-22「已入库」）+ 区间提取稿 `{素材名}-p{起}-{终}.md`（3-30 命名拍板）
 *   跟各自素材夹同层存放；`visuals/`（visual.html 工具产物）v3.1.2 起落**会话文件夹**内——它是本对话的
 *   产物（不是素材），不再占 SOURCES/（2026-09-14 条目10 落点纪律）。
 * - SOURCE.md = YAML frontmatter + 条目小节（3-28 拍板）：`### N. 名称` + 固定字段行
 *   （类型/路径/页码区间/存放方式/已提取/备注），程序按小节解析——三种录入方式（3-19 表单/对话 AI 登记/
 *   直接编辑文件）都收敛到同一份文件的解析与重写；
 * - 「已提取」程序维护（3-26），✓ 防重复提取；对话改名/删除联动在 aiTeachingFolders（3-31 跟随同设置），
 *   **工作区库不受对话改名/删除影响**（这正是上移的目的）；
 * - 提取稿是 .md 且在仓库内 → AI 用现有 vault 读工具即可读（3-20 区间指定经目录注入达成，无新读取通道）。
 */

const SOURCE_FILE = 'SOURCE.md'
const SOURCES_DIR = 'SOURCES'

/**
 * 素材库作用域：
 * - `workspace` 工作区级主库 → `{工作区层}/SOURCES/SOURCE.md`（跨对话共用，默认）
 * - `session` 对话私有补充 → `{工作区层}/SOURCES/{对话夹名}/SOURCE.md`（存量保留，不再作为登记入口）
 */
export type SourcesScope = 'workspace' | 'session'

const TYPE_ENUM = ['url', 'pptx', 'pdf', 'docx', 'image', 'md', 'code', 'dir', 'other'] as const
export type SourceType = (typeof TYPE_ENUM)[number]

export interface SourceEntry {
  no: number
  name: string
  type: SourceType | string
  /** 素材地址：./文件名（已入库）/ 仓库内相对路径 / 绝对路径 / URL */
  path: string
  /** 页码区间原样字符串（'12-34' / '12' / '-'） */
  range: string
  /** 已入库 | 仅引用 */
  storage: string
  /** '-' 或 '✓ → 文件名' */
  extracted: string
  note: string
}

export interface SourcesResult {
  ok: boolean
  /** 工作区主库 `SOURCE.md` 的仓库相对路径（登记入口落这里） */
  relPath?: string | null
  /** 合并后的条目（带 scope / dirRel / origNo，见 MergedSource） */
  entries?: MergedSource[]
  /** 条目5.3：手编/AI 直写的异常统计（缺编号的小节、编号重复被丢弃数、缺路径未登记数） */
  anomalies?: { unnamed: number; dupNo: number; noPath?: number }
  /** 两层各自的文件路径（渲染层展示「登记文件在哪」用；对话级无文件时为 null） */
  workspaceRel?: string | null
  sessionRel?: string | null
  error?: string
}

interface SourcesLayout {
  rootPath: string
  rootId: string
  /** 素材文件夹仓库相对路径与绝对路径 */
  dirRel: string
  dirAbs: string
  /** SOURCE.md 相对路径 */
  fileRel: string
  /** 会话夹名（=素材子夹名）；工作区级库为空串 */
  convName: string
  /** 工作区段名（未归一为空串） */
  wsName: string
  scope: SourcesScope
}

/** 工作区段名：`{rootDir}/X/...` → X；根层 → '' */
function wsNameOf(parentRel: string, rootDir: string): string {
  return parentRel !== rootDir && parentRel.startsWith(`${rootDir}/`) ? parentRel.slice(rootDir.length + 1) : ''
}

/**
 * 工作区层相对路径。**无会话也要能定位**（工作区级库要支持开局即登记），三级回退：
 * ① 会话夹实际父目录（最可靠：兼容「扁平 {root}/{会话}」与「两层 {root}/{工作区}/{会话}」两种落点，
 *    且不依赖 meta 与磁盘一致）；② meta 的 `lastWorkspaceId`（无会话/会话夹尚未创建时）；
 * ③ 产物根层（未归一层，此时工作区库 = `{rootDir}/SOURCES/SOURCE.md`）。
 */
function parentRelOf(sessionId: string, getSetting: (key: string) => unknown): { rootPath: string; rootId: string; parentRel: string; wsName: string } | { error: string } {
  const vault = getCurrentVault()
  if (!vault) return { error: '尚未打开仓库' }
  const rootDir = rootDirName(getSetting)
  const sid = String(sessionId ?? '').trim()
  if (sid) {
    const rel = sessionFolder(sid, getSetting).relPath
    if (rel) {
      const lastSlash = rel.lastIndexOf('/')
      const parentRel = lastSlash > 0 ? rel.slice(0, lastSlash) : rootDir
      return { rootPath: vault.rootPath, rootId: vault.rootId, parentRel, wsName: wsNameOf(parentRel, rootDir) }
    }
  }
  const lastWs = listWorkspaces(getSetting).lastWorkspaceId
  const wsRel = lastWs ? workspaceFolderRel(lastWs, getSetting) : null
  const parentRel = wsRel ?? rootDir
  return { rootPath: vault.rootPath, rootId: vault.rootId, parentRel, wsName: wsNameOf(parentRel, rootDir) }
}

/**
 * v3.1.2 条目11：把「支线会话」折算回它的**归属主线会话**（素材继承 α 方案）。
 *
 * 支线不 assign 工作区、也没有自己的会话夹（`aiTeachAssignSession` 只在新建主会话时调用），
 * 若直接拿支线 id 走 `parentRelOf`，会话夹探测必然落空、一路掉到 `lastWorkspaceId`
 * ——那是「最后进过的工作区」，跟这条支线挂在哪条主线上可能毫无关系。
 *
 * 统一先折算成主线 id → 支线自然继承主线的「工作区主库 + 该对话私有补充」，
 * 与「支线 = 主线某条回答的分叉」语义一致。
 */
function ownerSessionId(sessionId: string): string {
  const sid = String(sessionId ?? '').trim()
  if (!sid) return ''
  try {
    const row = getAgentSession(sid)
    return row?.parentSessionId ? row.parentSessionId : sid
  } catch { return sid }
}

/**
 * 由会话 id 解析素材夹布局。
 * - `scope='workspace'`（默认）：`{工作区层}/SOURCES/SOURCE.md`，sessionId 只用于定位工作区，可为空
 * - `scope='session'`：`{工作区层}/SOURCES/{对话夹名}/SOURCE.md`（对话私有补充，需有效会话）
 * create=true 懒建目录（工作区级只建 SOURCES/；对话级沿用会话夹懒建）；false 只探测，不产生副作用。
 */
function layout(sessionId: string, getSetting: (key: string) => unknown, create: boolean, scope: SourcesScope = 'workspace'): SourcesLayout | { error: string } {
  if (scope === 'workspace') {
    const p = parentRelOf(sessionId, getSetting)
    if ('error' in p) return p
    const dirRel = `${p.parentRel}/${SOURCES_DIR}`
    return {
      rootPath: p.rootPath, rootId: p.rootId,
      dirRel, dirAbs: join(p.rootPath, dirRel),
      fileRel: `${dirRel}/${SOURCE_FILE}`,
      convName: '', wsName: p.wsName, scope,
    }
  }
  const sid = String(sessionId ?? '').trim()
  if (!sid) return { error: '尚未选择对话' }
  const vault = getCurrentVault()
  if (!vault) return { error: '尚未打开仓库' }
  const probe = create ? ensureSessionFolder(sid, getSetting) : sessionFolder(sid, getSetting)
  const rel = probe.relPath
  if (!rel) return { error: probe.ok ? '会话文件夹不存在' : (probe.error ?? '会话文件夹不可用') }
  const lastSlash = rel.lastIndexOf('/')
  const rootDir = rootDirName(getSetting)
  const parentRel = lastSlash > 0 ? rel.slice(0, lastSlash) : rootDir
  const convName = lastSlash > 0 ? rel.slice(lastSlash + 1) : rel
  const dirRel = `${parentRel}/${SOURCES_DIR}/${convName}`
  return { rootPath: vault.rootPath, rootId: vault.rootId, dirRel, dirAbs: join(vault.rootPath, dirRel), fileRel: `${dirRel}/${SOURCE_FILE}`, convName, wsName: wsNameOf(parentRel, rootDir), scope }
}

/** 懒建兜底模板：唯一真相源 = aiTeachingFolders.sourceTemplateText（2026-09-09 收尾合并，勿在此内联） */
function emptyTemplate(l: SourcesLayout): string {
  // 工作区级库的 frontmatter 用「（工作区级）」标出归属——文件里一眼能区分主库与对话私有补充
  return sourceTemplateText(l.wsName, l.convName || '（工作区级·跨对话共用）')
}

function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 解析 SOURCE.md → 条目数组（宽容：缺字段回退默认，编号重复保留先到者）
 *  UI 优化条目5.3 容错加强（AI 直接登记/用户手编的三种真实坏形）：
 *  ①小节标题层级与 # 后空格不规范（`#编号. 名称` / `## 3. 名称`）；②字段行漏掉前导 `- `；
 *  ③值被反引号包裹（`` `./a.pdf` ``）——三种都在解析层吸收，重写时归一化回模板形状。 */
export function parseSourceMd(text: string): SourceEntry[] {
  const out: SourceEntry[] = []
  const seen = new Set<number>()
  let cur: SourceEntry | null = null
  // 【】开头 = 填空模板占位（SOURCE.md 模板预置的空位条目），与未填完的手编小节一并跳过：
  // 路径是登记的必要信息，无路径条目（无论占位还是手编漏填）都不进素材库——
  // 用户填上路径的瞬间条目即生效；表单登记第一条时 rewrite 会连带清掉占位小节
  const isPlaceholder = (e: SourceEntry) => e.name.startsWith('【') || !e.path.trim()
  const flush = () => { if (cur && !seen.has(cur.no) && !isPlaceholder(cur)) { seen.add(cur.no); out.push(cur) } cur = null }
  const clean = (v: string) => v.trim().replace(/^`+|`+$/g, '').trim()
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^#{1,6}\s*(\d+)\s*[.、]\s*(.+?)\s*$/.exec(raw)
    if (head) {
      flush()
      cur = { no: parseInt(head[1], 10), name: clean(head[2]), type: 'other', path: '', range: '-', storage: '仅引用', extracted: '-', note: '' }
      continue
    }
    if (/^#{1,6}\s/.test(raw)) { flush(); continue } // 其他标题结束当前小节
    if (!cur) continue
    // 条目5.3 容错加强：分隔符支持「：」「:」与裸空格（手常打漏冒号是最常见写法，如 `- 已提取:未提取`）；
    // 条目10 容错：code 素材手写「行号区间」（或裸「区间」）与「页码区间」同义，落盘仍统一写「页码区间」
    const m = /^[-*]?\s*(类型|路径|页码区间|行号区间|区间|存放方式|已提取|备注)(?:\s*[：:]\s*|\s+)(.*)$/.exec(raw.trim())
    if (!m) continue
    const val = clean(m[2])
    if (m[1] === '类型') cur.type = val.toLowerCase() || 'other'
    else if (m[1] === '路径') cur.path = val
    else if (m[1] === '页码区间' || m[1] === '行号区间' || m[1] === '区间') cur.range = val || '-'
    else if (m[1] === '存放方式') cur.storage = val
    else if (m[1] === '已提取') cur.extracted = val
    else if (m[1] === '备注') cur.note = val
  }
  flush()
  return out.sort((a, b) => a.no - b.no)
}

/** 手编/AI 直写 SOURCE.md 的异常统计（UI 优化条目5.3）：
 *  `unnamed`=缺「编号.」的小节标题（整节不会被登记）、`dupNo`=编号重复被丢弃的节数。
 *  仅统计（不改动文件），供右栏一行提示——否则用户只会看到「列表没变化」而无处排查。
 *  noPath = 手编小节缺「路径：」非空值（路径是登记必要信息，缺失即不登记）；模板【】占位小节不计。 */
export function sourceAnomalies(text: string): { unnamed: number; dupNo: number; noPath: number } {
  let unnamed = 0
  let numbered = 0
  let noPath = 0
  let fmCount = 0
  let inFm = false
  let curNo = 0
  let curPlaceholder = false
  let curPath = ''
  const closeSection = (): void => {
    if (curNo && !curPlaceholder && !curPath) noPath++
    curNo = 0
    curPlaceholder = false
    curPath = ''
  }
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line === '---') { fmCount++; inFm = fmCount % 2 === 1; continue }
    if (inFm) continue
    const head = /^#{1,6}\s*(\d+)\s*[.、]/.exec(line)
    if (head) {
      closeSection()
      curNo = parseInt(head[1], 10)
      curPlaceholder = line.includes('【')
      if (!curPlaceholder) numbered++ // 占位小节不进 dupNo 分母（parse 同样排除，否则虚报编号重复）
      continue
    }
    if (/^#{1,6}\s*素材来源登记/.test(line)) continue // 前缀豁免：模板 H1「素材来源登记（填空即用）」带后缀，精确匹配会把标题本身误计为缺编号小节
    if (/^#{1,6}\s*\S/.test(line)) { closeSection(); unnamed++; continue }
    if (curNo) {
      const m = /^[-*]?\s*路径(?:\s*[：:]\s*|\s+)(.*)$/.exec(line)
      if (m && !curPath) curPath = m[1].trim().replace(/^`+|`+$/g, '')
    }
  }
  closeSection()
  return { unnamed, dupNo: Math.max(0, numbered - parseSourceMd(text).length), noPath }
}

function entryToBlock(e: SourceEntry): string {
  return [
    `### ${e.no}. ${e.name}`,
    `- 类型: ${e.type}`,
    `- 路径: ${e.path || '-'}`,
    `- 页码区间: ${e.range || '-'}`,
    `- 存放方式: ${e.storage}`,
    `- 已提取: ${e.extracted || '-'}`,
    `- 备注: ${e.note || '-'}`,
    '',
  ].join('\n')
}

/** 重写所有条目小节（保留 frontmatter 与标题段，updated 刷新），并广播树刷新 */
function rewriteEntries(l: SourcesLayout, entries: SourceEntry[]): { ok: boolean; error?: string } {
  try {
    const fileAbs = join(l.rootPath, l.fileRel)
    const old = existsSync(fileAbs) ? readFileSync(fileAbs, 'utf-8') : emptyTemplate(l)
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(old)
    let head = '---\n' + (fm ? fm[1].split('\n').map(x => x.startsWith('updated:') ? `updated: ${today()}` : x).join('\n') : `workspace: ${l.wsName || '（未归一层）'}\nconversation: ${l.convName || '（工作区级·跨对话共用）'}\nupdated: ${today()}`) + '\n---\n'
    const body = entries.map(entryToBlock).join('\n')
    mkdirSync(l.dirAbs, { recursive: true })
    writeFileSync(fileAbs, `${head}\n# 素材来源登记\n\n${body}`, 'utf-8')
    broadcastTreeRefresh(l.dirRel)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function readEntries(l: SourcesLayout): SourceEntry[] {
  const p = join(l.rootPath, l.fileRel)
  if (!existsSync(p)) return []
  try { return parseSourceMd(readFileSync(p, 'utf-8')) } catch { return [] }
}

// ===== 两层合并（v3.1.1：工作区主库 + 对话私有补充）=====

/** 合并读的条目：带来源作用域与所属素材夹（提取稿/原件都相对该目录），并保留重编号前的原编号 */
export interface MergedSource extends SourceEntry {
  scope: SourcesScope
  /** 该条目所属素材夹的仓库相对路径（拼提取稿 / 原件路径用） */
  dirRel: string
  /** 在所属 SOURCE.md 内的原始编号（写操作按它定位小节） */
  origNo: number
}

interface MergedRead {
  entries: MergedSource[]
  ws: SourcesLayout | null
  conv: SourcesLayout | null
}

/**
 * 合并两层登记，**统一重编号 1..N**（工作区主库在前、本对话存量在后）。
 *
 * 为什么要重编号而不是各留各的：条目编号是 AI 引用（`[2] p.15`）与右栏按钮定位的唯一键。
 * 两层各自编号必然撞车，撞车之后「提取第 2 条」这类操作就有了歧义。重编号让编号全局唯一，
 * 写操作再用 `origNo` 反查回所属那一层（见 locateByNo）——这也是「存量迁移 = 合并读展示」的落地：
 * 对话里的历史登记原地不动，读出来即与新登记的条目共处同一编号空间。
 *
 * sessionId 为空 = 只读工作区主库（无对话也能浏览素材库）。
 */
function readMerged(sessionId: string, getSetting: (key: string) => unknown): MergedRead {
  const flat: MergedSource[] = []
  let ws: SourcesLayout | null = null
  let conv: SourcesLayout | null = null
  const seen = new Set<string>()
  const key = (e: SourceEntry): string => `${e.name}\u0000${e.path}`
  const wl = layout(sessionId, getSetting, false, 'workspace')
  if (!('error' in wl)) {
    ws = wl
    for (const e of readEntries(wl)) {
      flat.push({ ...e, scope: 'workspace', dirRel: wl.dirRel, origNo: e.no })
      seen.add(key(e))
    }
  }
  if (String(sessionId ?? '').trim()) {
    const cl = layout(sessionId, getSetting, false, 'session')
    if (!('error' in cl)) {
      conv = cl
      for (const e of readEntries(cl)) {
        // 已上收（或手工重复登记）的同名同路径条目不再重复列出
        if (seen.has(key(e))) continue
        flat.push({ ...e, scope: 'session', dirRel: cl.dirRel, origNo: e.no })
      }
    }
  }
  return { entries: flat.map((e, i) => ({ ...e, no: i + 1 })), ws, conv }
}

/** 按合并后的编号反查「条目 + 它所属的那一层」；编号不存在返回 null（写操作前必查） */
function locateByNo(sessionId: string, no: number, getSetting: (key: string) => unknown): { l: SourcesLayout; entry: SourceEntry } | null {
  const m = readMerged(sessionId, getSetting)
  const hit = m.entries.find(e => e.no === Number(no))
  if (!hit) return null
  const l = hit.scope === 'workspace' ? m.ws : m.conv
  if (!l) return null
  const entry = readEntries(l).find(e => e.no === hit.origNo)
  return entry ? { l, entry } : null
}

// ===== 对外能力 =====

/**
 * 读素材登记：**工作区主库 + 本对话存量合并**（主库不存在则懒建空模板）。
 * sessionId 可为空 —— 无对话时读到的是工作区主库，这是「素材库面板脱离对话常驻」的前提。
 * entries 带 `scope` / `dirRel`（渲染层按各自素材夹拼提取稿与原件路径），`relPath` = 工作区主库路径。
 */
export function readSources(sessionId: string, getSetting: (key: string) => unknown): SourcesResult {
  try {
    const ws = layout(sessionId, getSetting, false, 'workspace')
    if ('error' in ws) return { ok: false, error: ws.error }
    const fileAbs = join(ws.rootPath, ws.fileRel)
    if (!existsSync(fileAbs)) {
      mkdirSync(ws.dirAbs, { recursive: true })
      writeFileSync(fileAbs, emptyTemplate(ws), 'utf-8')
      broadcastTreeRefresh(ws.dirRel)
    }
    let anomalies: SourcesResult['anomalies']
    try {
      const a = sourceAnomalies(readFileSync(fileAbs, 'utf-8'))
      if (a.unnamed || a.dupNo) anomalies = a
    } catch { /* 统计失败不影响列表 */ }
    const m = readMerged(sessionId, getSetting)
    return {
      ok: true, relPath: ws.fileRel, entries: m.entries, anomalies,
      workspaceRel: ws.fileRel, sessionRel: m.conv?.fileRel ?? null,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 扩展名 → 素材类型（类型纠错依据）：登记时选错类型（pptx 选了 pdf 等）会导致区间提取
 *  用错解析器（误导性报错）、原件阅读器分派错误、AI 注入描述失真——按扩展名自动纠正 */
const EXT_TYPE_MAP: Record<string, SourceType> = {
  pdf: 'pdf', pptx: 'pptx', ppt: 'pptx', docx: 'docx', doc: 'docx',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
  md: 'md', markdown: 'md', txt: 'md',
}
const CODE_EXTS = new Set<string>(AI_TEXT_CODE_EXTS)

/** 由文件名/路径推断素材类型；无法识别返回 null（保留用户所选） */
function inferTypeFromPath(p: string): SourceType | null {
  const m = /\.([A-Za-z0-9]+)\s*$/.exec(p.trim())
  if (!m) return null
  const ext = m[1].toLowerCase()
  if (EXT_TYPE_MAP[ext]) return EXT_TYPE_MAP[ext]
  if (CODE_EXTS.has(ext)) return 'code'
  return null
}

export interface AddSourceInput {
  name: string
  /** 可选（2026-09-08 用户拍板：类型全自动检测，用户不再手选）。缺省/'auto' = 按 URL/扩展名
   *  自动识别；显式传入（AI 登记等既有调用方）仍尊重并保留扩展名纠错兜底 */
  type?: string
  /** 仅引用=直接存（URL/仓库相对/绝对路径）；已入库=作为素材文件的来源绝对路径 */
  path: string
  rangeFrom?: string
  rangeTo?: string
  storage: '已入库' | '仅引用'
  note?: string
}

/** 添加素材：已入库先拷贝原件进素材夹，再按模板追加条目（3-28「程序解析模板后写入」，非前端拼串） */
export function addSource(sessionId: string, input: AddSourceInput, getSetting: (key: string) => unknown): SourcesResult & { no?: number; corrected?: { from: string; to: string } } {
  try {
    const name = String(input?.name ?? '').trim()
    if (!name) return { ok: false, error: '素材名称必填' }
    const explicitType = input?.type && input.type !== 'auto'
      ? (TYPE_ENUM.includes((input?.type ?? '') as SourceType) ? String(input.type).toLowerCase() : 'other')
      : null
    let type: SourceType | string = explicitType ?? 'other'
    const storage = input?.storage === '已入库' ? '已入库' : '仅引用'
    // v3.1.1：登记一律落**工作区主库**（教材/讲义是课程资产，跨对话复用）；
    // sessionId 只用于定位工作区层，可为空 —— 无对话也能登记，解开「导素材要先建对话」的冷启动死结
    const l = layout(sessionId, getSetting, true, 'workspace')
    if ('error' in l) return { ok: false, error: l.error }
    mkdirSync(l.dirAbs, { recursive: true })
    let path = String(input.path ?? '').trim()
    // 类型纠错（2026-09-08 用户提问落码）：本地文件路径可按扩展名推断真实类型——
    // 与所选 type 不符时自动纠正并回传 corrected 提示（url / 未知扩展不纠，尊重用户选择）
    let corrected: { from: string; to: string } | undefined
    if (storage === '已入库') {
      if (!path) return { ok: false, error: '入库失败：未选择素材文件' }
      const srcAbs = isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) ? path : join(l.rootPath, path)
      if (!existsSync(srcAbs)) return { ok: false, error: `入库失败：找不到文件 ${path}` }
      const copied = uniqueFileName(l.dirAbs, basename(srcAbs))
      copyFileSync(srcAbs, join(l.dirAbs, copied))
      path = `./${copied}`
    }
    if (!explicitType) {
      // 全自动检测（用户不再选类型）：URL → url；仓库内/绝对路径的**目录** → dir（目录素材，
      // 注入时自动展开文件清单，2026-09-08 用户需求）；文件按扩展名映射；未知 → other
      if (/^https?:\/\//i.test(path)) type = 'url'
      else {
        try {
          const probeAbs = isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) ? path : join(l.rootPath, path)
          if (existsSync(probeAbs) && statSync(probeAbs).isDirectory()) type = 'dir'
        } catch { /* 探测失败按文件处理 */ }
        if (type !== 'dir') {
          const inferred = inferTypeFromPath(path)
          if (inferred) type = inferred
        }
      }
    } else if (type !== 'url' && !/^https?:\/\//i.test(path)) {
      const inferred = inferTypeFromPath(path)
      if (inferred && inferred !== type) {
        corrected = { from: type, to: inferred }
        type = inferred
      }
    }
    const rf = parseInt(String(input.rangeFrom ?? ''), 10)
    const rt = parseInt(String(input.rangeTo ?? ''), 10)
    const range = Number.isFinite(rf) ? (Number.isFinite(rt) && rt >= rf ? `${rf}-${rt}` : `${rf}`) : '-'
    const entries = readEntries(l)
    const no = entries.reduce((m, e) => Math.max(m, e.no), 0) + 1
    const e: SourceEntry = { no, name, type, path, range, storage, extracted: '-', note: String(input.note ?? '').trim() }
    const w = rewriteEntries(l, [...entries, e])
    if (!w.ok) return { ok: false, error: w.error }
    const m = readMerged(sessionId, getSetting)
    // no = 主库内的条目编号（供「再加区间」等场景定位原件）；entries 回合并视图供渲染层直接刷新
    return { ok: true, relPath: l.fileRel, entries: m.entries, no, corrected, workspaceRel: m.ws?.fileRel ?? null, sessionRel: m.conv?.fileRel ?? null }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 删除条目（按合并编号定位到所属层；只删该小节、其余编号不动）。返回合并后的完整列表供渲染层直接刷新 */
export function removeSource(sessionId: string, no: number, getSetting: (key: string) => unknown): SourcesResult {
  try {
    const hit = locateByNo(sessionId, no, getSetting)
    if (!hit) return { ok: false, error: `没有编号为 ${no} 的素材条目` }
    const { l, entry } = hit
    const next = readEntries(l).filter(e => e.no !== entry.no)
    const w = rewriteEntries(l, next)
    if (!w.ok) return { ok: false, error: w.error }
    const m = readMerged(sessionId, getSetting)
    return { ok: true, relPath: l.fileRel, entries: m.entries, workspaceRel: m.ws?.fileRel ?? null, sessionRel: m.conv?.fileRel ?? null }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** visual.html 工具产物：
 *  写 `{会话夹}/visuals/<slug>.html`（v3.1.2 条目10：从 `SOURCES/{对话夹}/visuals/` 迁出——
 *  SOURCES 是给 AI 读的素材目录，产物一律落会话文件夹）；重名不覆盖（-v2/-v3 递增）。
 *  slug 白名单校验（kebab 英文数字，拒 `..`/分隔符/盘符——pathGuard 同口径的入参面收敛），
 *  落盘路径全程由本函数拼装，AI 参数无法越出会话 visuals/ 目录。不登记 SOURCE.md、不参与素材注入 */
export function writeVisual(
  sessionId: string, slug: string, html: string,
  getSetting: (key: string) => unknown,
): { ok: boolean; relPath?: string; lines?: number; error?: string } {
  try {
    const s = String(slug ?? '').trim()
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,60}[a-z0-9])?$/.test(s) || s.includes('..')) {
      return { ok: false, error: `slug 不合法（要求 kebab-case 小写英文/数字，如 parabola-open-width）：${s.slice(0, 40)}` }
    }
    const body = String(html ?? '')
    if (!body.trim()) return { ok: false, error: 'html 参数为空' }
    if (body.length > 512 * 1024) return { ok: false, error: 'html 超过 512KB，拒绝写入' }
    // v3.1.2 条目10：示意图是**本对话**的产物、不是课程素材 —— 落会话文件夹 `{会话夹}/visuals/`，
    // 不再踩 `SOURCES/`（SOURCES 是给 AI 读的素材目录，不放产物）。会话夹不存在 = 懒建。
    // 条目11：支线跟随主线会话夹（`{主线夹}/支线·{标题}/visuals/`），不新建自己的夹。
    const probe = ensureWriteOwnerFolder(sessionId, getSetting)
    if (!probe.ok || !probe.relPath) return { ok: false, error: probe.error ?? '会话文件夹不可用' }
    const vault = getCurrentVault()
    if (!vault) return { ok: false, error: '尚未打开仓库' }
    const sessionRel = probe.relPath
    const visualsAbs = join(vault.rootPath, sessionRel, 'visuals')
    mkdirSync(visualsAbs, { recursive: true })
    let fname = `${s}.html`
    for (let v = 2; existsSync(join(visualsAbs, fname)) && v <= 99; v++) fname = `${s}-v${v}.html`
    writeFileSync(join(visualsAbs, fname), body, 'utf-8')
    broadcastTreeRefresh(sessionRel)
    const lines = body.replace(/\r\n/g, '\n').split('\n').length
    return { ok: true, relPath: `${sessionRel}/visuals/${fname}`, lines }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 解析条目路径 → 素材原件绝对路径（./名=素材夹；绝对路径原样；其余按仓库相对）。
 *  只依赖素材夹与仓库根 —— 注入侧对合并条目只有这两个信息也能复用 */
function resolveMaterialAbs(l: { dirAbs: string; rootPath: string }, p: string): string {
  const clean = p.trim()
  if (clean.startsWith('./')) return join(l.dirAbs, clean.slice(2))
  if (isAbsolute(clean) || /^[a-zA-Z]:[\\/]/.test(clean)) return clean
  return join(l.rootPath, clean)
}

/** 区间解析：`12-34` / 单页 `12`；也容忍 `L100-250`、`行100-250`、全角横线与波浪线（条目10：源码用行号区间同一机制） */
/** 文本读取编码兜底（条目10）：utf-8 解出替换符（U+FFFD）则按 GBK 系再解一次（国内老源码常见） */
function readTextSmart(abs: string): string {
  const buf = readFileSync(abs)
  const utf8 = buf.toString('utf-8')
  if (!utf8.includes('\uFFFD')) return utf8
  try { return new TextDecoder('gbk').decode(buf) } catch { return utf8 }
}

function parseRange(r: string): { from: number; to: number } | null {
  const m = /^(?:[Ll]|行)?\s*(\d+)\s*(?:[-–~]\s*(?:[Ll]|行)?\s*(\d+))?$/.exec(r.trim())
  if (!m) return null
  const from = parseInt(m[1], 10)
  const to = m[2] ? parseInt(m[2], 10) : from
  if (!Number.isFinite(from) || from < 1 || to < from) return null
  return { from, to }
}

/**
 * 区间提取（3-26 防重复：已 ✓ 直接返回现有提取稿）：pdf/pptx 文本层逐页提取，
 * 生成 `{素材名}-p{起}-{终}.md`（3-30 命名拍板，与 SOURCE.md 同级、可编辑修正），回写「已提取」字段。
 * 公式/图表以文本层为准——视觉转写（3-21 手动）为后续增强，提取稿可编辑是其兜底。
 * UI 优化条目10：code 类型按**行号区间**提取（同「页码区间」字段，`{素材名}-L{起}-{终}.md`）。
 */
export async function extractRange(sessionId: string, no: number, getSetting: (key: string) => unknown): Promise<{ ok: boolean; relPath?: string; error?: string }> {
  try {
    // v3.1.1：按合并编号定位到条目所属的那一层（工作区主库 / 对话私有），提取稿与「已提取」都写回该层
    const hit = locateByNo(sessionId, no, getSetting)
    if (!hit) return { ok: false, error: `没有编号为 ${no} 的素材条目` }
    const { l, entry: e } = hit
    const entries = readEntries(l)
    // 3-26 程序防重复：已 ✓ 直接返回现有提取稿（UI 也不出提取按钮，双保险）
    const ext = /^✓\s*→\s*(.+)$/.exec(e.extracted)
    if (ext) return { ok: true, relPath: `${l.dirRel}/${ext[1].trim()}` }
    if (e.type !== 'pdf' && e.type !== 'pptx' && e.type !== 'docx' && e.type !== 'code') return { ok: false, error: '仅 pdf / pptx / docx / code 支持区间提取' }
    const abs = resolveMaterialAbs(l, e.path)
    if (!e.path || e.path === '-' || !existsSync(abs)) return { ok: false, error: `素材原件不可用：${e.path || '（未登记路径）'}` }
    const rg = parseRange(e.range)
    if (!rg) return { ok: false, error: '区间未登记或格式非法（应为 起-止，如 12-34）' }
    if (e.type === 'code') {
      // 条目10：文本源码按行号区间抽取（超大文件截 2000 行提示）
      const raw = readTextSmart(abs)
      const lines = raw.replace(/\r\n/g, '\n').split('\n')
      const from = Math.min(rg.from, Math.max(1, lines.length))
      const to = Math.min(rg.to, lines.length)
      const capped = to - from > 2000
      const takeEnd = capped ? from + 2000 : to
      const fence = /\.([A-Za-z0-9]+)$/.exec(e.path)?.[1]?.toLowerCase() ?? ''
      const extractName = uniqueFileName(l.dirAbs, `${sanitizeTitle(e.name)}-L${from}-${takeEnd}.md`)
      const body = [
        `# ${e.name} · 第 ${from}-${takeEnd} 行提取稿`,
        '',
        `> 来源：${SOURCE_FILE} 素材 #${e.no}（${e.path}） · 提取于 ${today()} · 按行号区间抽取${capped ? '（超 2000 行已截断，可缩小区间重新登记提取）' : ''}`,
        '> 本页**可直接编辑修正**（删减无关段落、加注释），AI 后续按修正版引用。',
        '',
        '```' + fence,
        ...lines.slice(from - 1, takeEnd),
        '```',
        '',
      ].join('\n')
      writeFileSync(join(l.dirAbs, extractName), body, 'utf-8')
      const w = rewriteEntries(l, entries.map(x => x.no === e.no ? { ...x, extracted: `✓ → ${extractName}` } : x))
      if (!w.ok) return { ok: false, error: w.error }
      broadcastTreeRefresh(l.dirRel)
      return { ok: true, relPath: `${l.dirRel}/${extractName}` }
    }
    // v3.1.2 条目5：docx/doc 无原生解析，先经 soffice 无头转 PDF 再走 pdf 文本层提取
    // （与 pptx 视觉转写同源基建；soffice 缺失时 convertToPdf 返回带指引的 error）
    let docAbs = abs
    if (e.type === 'docx') {
      const conv = await convertToPdf(abs, getSetting('sofficePath'))
      if (!conv.ok || !conv.pdfPath) return { ok: false, error: conv.error ?? 'Word 文档转 PDF 失败' }
      docAbs = conv.pdfPath
    }
    const pages: { n: number; text: string }[] = e.type === 'pdf' || e.type === 'docx'
      ? (await extractPdfRange(docAbs, rg.from, rg.to)).pages
      : extractPptxPages(abs).filter(p => p.n >= rg.from && p.n <= rg.to)
    if (pages.length === 0) return { ok: false, error: '区间内没有可提取的页（扫描件/图片型内容请走视觉转写或手工整理，提取稿可直接编辑补录）' }
    const extractName = uniqueFileName(l.dirAbs, `${sanitizeTitle(e.name)}-p${rg.from}-${rg.to}.md`)
    const body = [
      `# ${e.name} · 第 ${rg.from}-${rg.to} 页提取稿`,
      '',
      `> 来源：${SOURCE_FILE} 素材 #${e.no}（${e.path}） · 提取于 ${today()} · 由文本层自动抽取（页码为 PDF/幻灯片自身物理页序，非书页印刷页码）`,
      '> 公式/图形以文本层为准可能失真；本页**可直接编辑修正**，AI 后续按修正版引用。',
      '',
      ...pages.flatMap(p => [`## p${p.n}`, '', p.text || '（本页无可提取文本）', '']),
    ].join('\n')
    writeFileSync(join(l.dirAbs, extractName), body, 'utf-8')
    const w = rewriteEntries(l, entries.map(x => x.no === e.no ? { ...x, extracted: `✓ → ${extractName}` } : x))
    if (!w.ok) return { ok: false, error: w.error }
    broadcastTreeRefresh(l.dirRel)
    return { ok: true, relPath: `${l.dirRel}/${extractName}` }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * ── 3-21 视觉转写（手动档，后续增强）──────────────────────────────
 * 页位图由渲染层 pdf.js 栅格化（主进程无 canvas），主进程负责：
 * ① 把已入库/引用的 pdf 原件字节交给渲染层（pptx 先经 soffice 无头转 PDF，2026-09-09）；
 * ② 逐页喂视觉模型转写；③ **非破坏式并入提取稿**
 *（已有 `## p{n}` 文本小节保留，转写块追补在文末「视觉转写」节；无提取稿则以转写新建并回写 已提取 ✓）。
 */
export async function readSourceBytes(sessionId: string, no: number, getSetting: (key: string) => unknown): Promise<{ ok: boolean; base64?: string; error?: string }> {
  try {
    const hit = locateByNo(sessionId, no, getSetting)
    if (!hit) return { ok: false, error: `没有编号为 ${no} 的素材条目` }
    const { l, entry: e } = hit
    if (e.type !== 'pdf' && e.type !== 'pptx' && e.type !== 'docx') return { ok: false, error: '视觉转写支持 pdf / pptx / docx 原件（其余类型请走文本提取/手工整理）' }
    const abs = resolveMaterialAbs(l, e.path)
    if (!e.path || e.path === '-' || !existsSync(abs)) return { ok: false, error: `素材原件不可用：${e.path || '（未登记路径）'}` }
    const st = statSync(abs)
    if (st.size > 80 * 1024 * 1024) return { ok: false, error: `原件过大（${Math.round(st.size / 1048576)}MB > 80MB），请缩小区间` }
    if (e.type === 'pdf') return { ok: true, base64: readFileSync(abs).toString('base64') }
    // pptx / docx（docx 为 v3.1.2 条目5 扩展）：soffice 无头转 PDF 后交渲染层——pdf.js 栅格化链路原样复用；
    // 未装 LibreOffice 时 convertToPdf 返回带指引的 error（渲染层 toast），不影响 pdf 转写
    const conv = await convertToPdf(abs, getSetting('sofficePath'))
    if (!conv.ok || !conv.pdfPath) return { ok: false, error: conv.error ?? `${e.type === 'docx' ? 'Word 文档' : 'pptx'} 转 PDF 失败` }
    return { ok: true, base64: readFileSync(conv.pdfPath).toString('base64') }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

const VISION_SYSTEM = '你是教材视觉转写助手。把你收到的教材页面图片**逐元素忠实转写**为结构化 Markdown：'
  + '公式一律用 LaTeX（行内 $…$，独立公式 $$…$$）；表格转 Markdown 表格；图片/几何图给一句【图：…】客观描述；'
  '保留标题层级与题号。只转写页面上实际可见的内容，看不清就标注（不清晰），**严禁编造或补全**。直接输出该页 Markdown，不要任何开场白或评论。'

/** 逐页转写并并入提取稿。pages = 渲染层栅格化的 {n 页码, dataUrl}（≤12 页，单页失败不中断其余）。
 *  断点续转（2026-09-08 分批流水线）：提取稿中已有的 p{n} 自动跳过不重复调用视觉模型——
 *  渲染层按 12 页/批逐批发送，中断后重发同区间即可续转，已完成批次零消耗。 */
export async function transcribeVision(sessionId: string, no: number, pages: { n: number; dataUrl: string }[], getSetting: (key: string) => unknown, modelSpec?: string): Promise<{ ok: boolean; relPath?: string; model?: string; done?: number[]; skipped?: number[]; failed?: number[]; error?: string }> {
  try {
    const hit = locateByNo(sessionId, no, getSetting)
    if (!hit) return { ok: false, error: `没有编号为 ${no} 的素材条目` }
    const { l, entry: e } = hit
    const entries = readEntries(l)
    // 提取稿与「已提取」都写回条目所属的那一层（提取可能由对话内按钮触发，但条目可能已在工作区主库）
    // 断点续转：提取稿里已有的 p{n}（新建模式 `## p{n}` / 追加模式 `### p{n}`）不再重转
    const already = new Set<number>()
    const extPtr = /^✓\s*→\s*(.+)$/.exec(e.extracted)
    if (extPtr) {
      try {
        const old = readFileSync(join(l.dirAbs, extPtr[1].trim()), 'utf-8')
        for (const m of old.matchAll(/^#{2,3}\s*p(\d+)\s*$/gm)) already.add(parseInt(m[1], 10))
      } catch { /* 提取稿读取失败视作无历史 */ }
    }
    const list = (Array.isArray(pages) ? pages : []).filter(p => Number.isFinite(p.n) && typeof p.dataUrl === 'string' && p.dataUrl.startsWith('data:image/') && !already.has(p.n)).slice(0, 12)
    const skippedAll = (Array.isArray(pages) ? pages : []).filter(p => Number.isFinite(p.n) && already.has(p.n)).map(p => p.n)
    if (list.length === 0) {
      // 本批全部已转：零消耗幂等返回（断点续转收敛/重发同区间时命中）
      const extNow = /^✓\s*→\s*(.+)$/.exec(e.extracted)
      return { ok: true, relPath: extNow ? `${l.dirRel}/${extNow[1].trim()}` : undefined, model: '-', done: [], skipped: skippedAll, failed: [] }
    }
    const done: { n: number; md: string }[] = []
    const failed: number[] = []
    let model = ''
    let failedReason = ''
    let visionTokens = 0
    for (const p of list) {
      const r = await visionChat({ system: VISION_SYSTEM, prompt: `这是教材第 ${p.n} 页，请转写整页。`, images: [p.dataUrl], modelSpec })
      const t = (r.text ?? '').trim()
      if (r.ok && t) { done.push({ n: p.n, md: t }); model = r.model ?? model; visionTokens += (r as { tokens?: number }).tokens ?? 0 }
      else { failed.push(p.n); if (!failedReason && r.error) failedReason = r.error }
    }
    if (done.length === 0) {
      // 保留 visionChat 的原始失败原因（含「未找到视觉模型」等配置指引），不再包装截断
      const firstErr = failedReason || (failed.length ? `全部页转写失败（视觉模型不可用或不支持图片输入）：${model || ''}` : '转写失败')
      return { ok: false, failed, error: firstErr }
    }
    // 并入提取稿：已有则文末追补「视觉转写」节（保留文本层与用户手工修正）；没有则以转写新建提取稿并回写 ✓ 指针
    const ext = /^✓\s*→\s*(.+)$/.exec(e.extracted)
    let extName = ext ? ext[1].trim() : ''
    const block = ['', `## 视觉转写（${model} · ${today()} · 3-21）`, '', ...done.flatMap(d => [`### p${d.n}`, '', d.md, ''])].join('\n')
    if (extName && existsSync(join(l.dirAbs, extName))) {
      const old = readFileSync(join(l.dirAbs, extName), 'utf-8')
      writeFileSync(join(l.dirAbs, extName), `${old.replace(/\s+$/, '')}\n\n${block}`, 'utf-8')
    } else {
      const rg = { from: Math.min(...done.map(d => d.n)), to: Math.max(...done.map(d => d.n)) }
      extName = uniqueFileName(l.dirAbs, `${sanitizeTitle(e.name)}-p${rg.from}-${rg.to}.md`)
      const body = [
        `# ${e.name} · 第 ${rg.from}-${rg.to} 页提取稿（视觉转写）`,
        '',
        `> 来源：${SOURCE_FILE} 素材 #${e.no}（${e.path}） · ${today()} · 由视觉模型逐页转写（3-21），文本层缺失/失真时的忠实版`,
        '> 本页**可直接编辑修正**，AI 后续按修正版引用。',
        '',
        ...done.flatMap(d => [`## p${d.n}`, '', d.md, '']),
      ].join('\n')
      writeFileSync(join(l.dirAbs, extName), body, 'utf-8')
      const w = rewriteEntries(l, entries.map(x => x.no === e.no ? { ...x, extracted: `✓ → ${extName}` } : x))
      if (!w.ok) return { ok: false, error: w.error }
    }
    // 视觉转写用量审计（与回答模型 llm.invoke 分开：llm.vision）——按批记录 tokens 与页数
    try { appendAudit('aiTeaching', 'llm.vision', { tokens: visionTokens, pages: done.length, model }) } catch { /* 审计失败不阻断 */ }
    broadcastTreeRefresh(l.dirRel)
    return { ok: true, relPath: `${l.dirRel}/${extName}`, model, done: done.map(d => d.n), skipped: skippedAll, failed }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ===== 网页素材目录展开与批量抓取（.claude/plans/ai-teaching-web-source-crawl.md P2）=====
// 纯程序流水线零 LLM token；清洗复用剪藏管线；落盘进 SOURCES/{会话}/web/{slug}/，
// 回写「已提取 ✓ → web/{slug}/」后由注入层展开章节清单（见 resolveSourcesForInjection）。

const crawlAborts = new Map<string, AbortController>()

/** 进度广播（渲染层订阅 aiTeach:web-crawl-progress，不轮询） */
function broadcastWebProgress(payload: { sessionId: string; no: number; done: number; total: number; current: string }): void {
  broadcast(BROADCAST_CHANNEL.aiTeachWebCrawlProgress, payload)
}

/** 文件名段取 URL 末段去 .html（稳定可续抓：同一 URL 重爬命中 exists 跳过） */
function urlStemName(u: string): string {
  try {
    const p = new URL(u).pathname
    const seg = decodeURIComponent(p.slice(p.lastIndexOf('/') + 1)).replace(/\.html?$/i, '')
    return sanitizeTitle(seg).replace(/\s+/g, '-').slice(0, 40)
  } catch { return '' }
}

/** 探测：门户（候选锚点）/ 目录（章节清单）/ 单文章 三形态；anchorUrl=用户点选候选后二次探测 */
export async function webProbeSource(sessionId: string, no: number, getSetting: (key: string) => unknown, anchorUrl?: string): Promise<ProbeResult> {
  try {
    const hit = locateByNo(sessionId, no, getSetting)
    if (!hit) return { ok: false, error: `没有编号为 ${no} 的素材条目` }
    const { entry: e } = hit
    if (e.type !== 'url') return { ok: false, error: '仅 url 类型素材支持展开网页' }
    const target = String(anchorUrl ?? '').trim() || e.path
    if (!target || target === '-') return { ok: false, error: '素材未登记网址' }
    return await probeWeb(target, `${e.name} ${e.note}`)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 批量抓取勾选章节 → 落盘 web/{slug}/NN-*.md + 00-目录.md → 回写「已提取」。断点续抓=已存在文件跳过 */
export async function webCrawlSource(sessionId: string, no: number, urls: unknown, getSetting: (key: string) => unknown): Promise<{ ok: boolean; dirRel?: string; done?: number; failed?: Array<{ url: string; title: string; reason: string }>; skipped?: number; error?: string }> {
  try {
    const hit = locateByNo(sessionId, no, getSetting)
    if (!hit) return { ok: false, error: `没有编号为 ${no} 的素材条目` }
    const { l, entry: e } = hit
    if (e.type !== 'url') return { ok: false, error: '仅 url 类型素材支持批量抓取' }
    const abortKey = String(sessionId ?? '').trim() || '__workspace__' // 空会话（工作区级抓取）也要有独立的中止槽，避免互相误取消
    const list = (Array.isArray(urls) ? urls : []).map(u => String(u).trim()).filter(u => /^https?:\/\//i.test(u)).slice(0, 200)
    if (list.length === 0) return { ok: false, error: '没有要抓取的页面（请先在勾选清单选择章节）' }
    const slug = sanitizeTitle(e.name) || `url-${e.no}`
    const webRel = `web/${slug}`
    const webAbs = join(l.dirAbs, 'web', slug)
    if (!existsSync(webAbs)) mkdirSync(webAbs, { recursive: true })
    const maxPages = Math.max(1, Math.min(Number(getSetting('webCrawlMaxPages')) || 80, 200))
    const delayMs = Math.max(0, Number(getSetting('webCrawlDelayMs')) || 300)
    const chapters: TocChapter[] = list.map((u, i) => ({ no: i + 1, title: '', url: u, group: '', defaultChecked: true }))
    const abort = new AbortController()
    crawlAborts.set(abortKey, abort)
    let outcome
    try {
      outcome = await crawlQueue(chapters, {
        maxPages, delayMs, signal: abort.signal,
        fileName: ch => `${String(ch.no).padStart(2, '0')}-${urlStemName(ch.url) || `p${ch.no}`}.md`,
        exists: rel => existsSync(join(webAbs, rel)),
        write: (_ch, rel, md) => { writeFileSync(join(webAbs, rel), md, 'utf-8') },
        onProgress: info => broadcastWebProgress({ sessionId, no, done: info.done, total: info.total, current: info.current }),
      })
    } finally {
      crawlAborts.delete(abortKey)
    }
    // 00-目录.md：列全部已落盘章节（含历史续抓），标题/源链从文件头解析；失败项如实列出
    const filesNow = readdirSync(webAbs).filter(f => /\.md$/i.test(f) && f !== '00-目录.md').sort()
    const rows = filesNow.map(f => {
      let title = f.replace(/\.md$/i, '').replace(/^\d+-/, '').replace(/-/g, ' ')
      let src = ''
      try {
        const head = readFileSync(join(webAbs, f), 'utf-8')
        const t = /^#\s+(.+)$/m.exec(head); if (t) title = t[1].trim()
        const s = /^>\s*来源：(\S+)/m.exec(head); if (s) src = s[1]
      } catch { /* 保留文件名推导 */ }
      return `| ${f.replace(/\.md$/i, '').split('-')[0]} | ${title} | ${webRel}/${f} | ${src || '-'} | ✓ |`
    })
    const failedRows = (outcome.failed ?? []).map(x => `| - | ${x.title || x.url} | - | ${x.url} | ✗ ${x.reason} |`)
    const tocMd = [
      `# ${e.name} · 网页抓取目录`,
      '',
      `> 来源条目：SOURCE.md #${e.no}（${e.path}） · 更新：${today()} · 抓取工具：Defuddle 正文清洗`,
      '> 每章一个 md 可直接编辑修正；AI 按「提取稿」清单读章节文件。',
      '',
      '| 章 | 标题 | 本地文件 | 源 URL | 状态 |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      ...failedRows,
      '',
    ].join('\n')
    writeFileSync(join(webAbs, '00-目录.md'), tocMd, 'utf-8')
    const entries = readEntries(l)
    const w = rewriteEntries(l, entries.map(x => x.no === e.no ? { ...x, extracted: `✓ → ${webRel}/` } : x))
    if (!w.ok) return { ok: false, error: w.error }
    return { ok: true, dirRel: `${l.dirRel}/${webRel}`, done: outcome.done.length, failed: outcome.failed, skipped: outcome.skipped.length }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 取消当前会话进行中的网页抓取 */
export function webCrawlCancel(sessionId: string): { ok: boolean; error?: string } {
  const a = crawlAborts.get(String(sessionId ?? '').trim() || '__workspace__')
  if (!a) return { ok: false, error: '没有进行中的抓取' }
  a.abort()
  return { ok: true }
}

/**
 * AgentRunner 注入（每轮重读，与 CONSTRAINTS 同哲学）：素材目录 + 编号制引用规则（3-29）。
 * 无登记文件/零条目 → 空串（零注入，存量会话不受扰）。
 * dir 条目（2026-09-08 用户需求）自动展开目录内文件清单：文本文件 AI 直接按路径读；
 * 非文本（扫描 pdf/图片等）标注「读取会得到空内容，先询问用户处理方式」。
 */
/** 文本扩展名集合（目录素材清单的二进制粗判；无法识别的扩展名一律按非文本标注） */
const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'yml', 'yaml', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'c', 'h', 'cpp', 'java', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'sql', 'vue'])
const DIR_LIST_LIMIT = 120
const DIR_LIST_DEPTH = 4

function listDirFilesRecursive(dirAbs: string, out: { rel: string; bin: boolean }[], relBase = '', depth = 0): void {
  if (depth > DIR_LIST_DEPTH || out.length >= DIR_LIST_LIMIT) return
  let names: import('fs').Dirent[]
  try { names = readdirSync(dirAbs, { withFileTypes: true }) } catch { return }
  for (const de of names) {
    if (out.length >= DIR_LIST_LIMIT) return
    if (de.name.startsWith('.') || de.name === 'SOURCE.md') continue
    const abs = join(dirAbs, de.name)
    const rel = relBase ? `${relBase}/${de.name}` : de.name
    if (de.isDirectory()) listDirFilesRecursive(abs, out, rel, depth + 1)
    else if (de.isFile()) {
      const ext = (/[.]([A-Za-z0-9]+)$/.exec(de.name)?.[1] ?? '').toLowerCase()
      out.push({ rel, bin: !TEXT_EXTS.has(ext) })
    }
  }
}

/**
 * AgentRunner 注入（每轮重读，与 CONSTRAINTS 同哲学）：素材目录 + 编号制引用规则（3-29）。
 * v3.1.1：**工作区主库 + 本对话私有补充合并注入**（readMerged 统一编号）——新建对话也能看到
 * 工作区已登记的教材，不再「每次都喊没素材」；零条目 → 空串（零注入）。
 * dir 条目（2026-09-08 用户需求）自动展开目录内文件清单：文本文件 AI 直接按路径读；
 * 非文本（扫描 pdf/图片等）标注「读取会得到空内容，先询问用户处理方式」。
 */
export function resolveSourcesForInjection(sessionId: string, getSetting: (key: string) => unknown): string {
  try {
    // v3.1.2 条目11：支线按**主线**解析素材（工作区主库 + 主线对话私有补充）——支线自己既无
    // 工作区归属也无会话夹，直接解析会掉到 lastWorkspaceId 兜底，读到的是一个无关工作区。
    const m = readMerged(ownerSessionId(sessionId), getSetting)
    if (m.entries.length === 0) return ''
    const rootPath = m.ws?.rootPath ?? m.conv?.rootPath
    if (!rootPath) return ''
    const renderOne = (e: MergedSource): string => {
      // 每个条目按**自己所属素材夹**拼路径（工作区库与对话补充的提取稿/原件不同目录）
      const dirAbs = join(rootPath, e.dirRel)
      const bits = [`类型 ${e.type}`, `路径 ${e.path || '-'}`]
      if (e.range && e.range !== '-') bits.push(`${e.type === 'code' ? '行号区间' : '页码区间'} ${e.range}`)
      const ext = /^✓\s*→\s*(.+)$/.exec(e.extracted)
      bits.push(ext ? `**提取稿 ${e.dirRel}/${ext[1].trim()}（优先读此文件）**` : '未提取')
      const base = `- [${e.no}] ${e.name}（${bits.join(' · ')}）${e.note ? ` 备注：${e.note}` : ''}`
      // 网页素材（P2）：url 且已提取 → web/{slug}/ 目录；展开章节文件清单，AI 按需 vault.read 单章
      if (e.type === 'url' && ext && ext[1].trim().startsWith('web/')) {
        const relDir = ext[1].trim()
        const webAbs = join(dirAbs, relDir)
        const files: { rel: string; bin: boolean }[] = []
        try { listDirFilesRecursive(webAbs, files) } catch { return `${base}\n  ⚠ 抓取目录不可读：${relDir}` }
        const chapters = files.filter(f => !f.bin && !/00-目录/.test(f.rel)).sort((a, b) => a.rel.localeCompare(b.rel))
        if (chapters.length === 0) return base
        const shown = chapters.slice(0, 120)
        const items = shown.map(f => `  - ${e.dirRel}/${relDir}${f.rel}`)
        if (chapters.length > shown.length) items.push(`  - …（其余 ${chapters.length - shown.length} 章，见 00-目录.md）`)
        return `${base}\n  章节清单（${chapters.length} 章，路径相对仓库根，按需读单章，勿一次读全部）：\n${items.join('\n')}`
      }
      // 未提取的 url 条目：给 AI 行为指引（可在线读单页；遇目录页提示用户走「展开网页」）
      if (e.type === 'url' && !ext) {
        return `${base}\n  提示：可用 builtin.web.read 在线读该页；若读到的是目录/导航页，建议提示用户在右栏素材库点「展开网页」批量入库后再引用`
      }
      // 目录素材：展开文件清单（文本可读；非文本标注需询问用户），上限 120 条防注入爆炸
      if (e.type === 'dir' && e.path && e.path !== '-') {
        const matAbs = resolveMaterialAbs({ dirAbs, rootPath }, e.path)
        const files: { rel: string; bin: boolean }[] = []
        try { listDirFilesRecursive(matAbs, files) } catch { return `${base}\n  ⚠ 目录不可读或不存在：${e.path}` }
        if (files.length === 0) return `${base}\n  （目录为空）`
        // f.rel 相对素材目录本身；给 AI 的路径要拼成仓库相对（否则 vault 读工具按仓库根解析会落空——
        // 旧版直接给 f.rel 却声称「相对仓库根」，是同一处隐藏 bug，本次一并修）
        const matRel = relative(rootPath, matAbs).replace(/\\/g, '/')
        if (matRel.startsWith('..')) return `${base}\n  ⚠ 目录在仓库外（${matAbs}），vault 读工具无法访问；建议用户把目录拷入仓库后重新登记`
        const shown = files.slice(0, 120)
        const items = shown.map(f => `  - ${matRel}/${f.rel}${f.bin ? '（非文本：直接读会得到空内容，需要内容时先询问用户是否转写/整理）' : ''}`)
        if (files.length > shown.length) items.push(`  - …（其余 ${files.length - shown.length} 个文件，可用读取工具按需列出）`)
        return `${base}\n  目录内 ${files.length} 个文件，路径均相对仓库根，可直接读取：\n${items.join('\n')}`
      }
      return base
    }
    const wsOnes = m.entries.filter(e => e.scope === 'workspace').slice(0, 60)
    const convOnes = m.entries.filter(e => e.scope === 'session').slice(0, 20)
    const hint = [
      '【素材目录（实时读取；方括号编号即引用键）】用户登记的素材如下。需要使用素材内容时：',
      '有「提取稿」的条目优先 vault 读提取稿（文本已按页码/行号区间抽取、可编辑）；未提取的 pdf/pptx（按页码区间）或 code（按行号区间）可提示用户',
      '在右栏「素材库」点提取，或仅按登记信息回答；code 素材未提取时也可按登记路径与行号区间直接读文件。',
      '引用素材内容时行内标注编号与页码/行号，形如 [1] p.15（code 写作 [1] L120）；',
      '每条回答末尾附「本次引用素材」清单（仅列实际用到的：编号. 名称 · 页码/URL）。',
      `工作区素材库（跨对话共用；登记文件 ${m.ws?.fileRel ?? ''}）：`,
      ...(wsOnes.length ? wsOnes.map(renderOne) : ['（尚无条目）']),
    ]
    if (convOnes.length) {
      hint.push(`本对话私有补充（仅本对话可见；登记文件 ${m.conv?.fileRel ?? ''}）：`, ...convOnes.map(renderOne))
    }
    // 登记指引只指向工作区主库（新素材默认是课程资产）；编号是合并视图编号，直接按它改文件会对不上，
    // 所以要求 AI「新增条目接着文件内现有最大编号 +1」，不要试图按注入编号去改既有小节
    hint.push(`用户要求登记素材时：默认登记进工作区素材库——按模板直接编辑 ${m.ws?.fileRel ?? ''}（### 编号. 名称 + 固定字段行，编号接着文件内现有最大值 +1），登记后其内容下一轮注入即可见。`)
    const full = hint.join('\n')
    return full.length > 3500 ? full.slice(0, 3500) + '\n…（素材目录过长已截断，全量见 SOURCE.md）' : full
  } catch {
    return ''
  }
}

// ===== 存量上收（v3.1.1 可选项的落地）=====

/** 递归复制文件/目录到目标目录下（名字冲突自动加 (n)；源不动 —— 与「移除登记不删文件」同一口径） */
function copyInto(srcAbs: string, dstDir: string): { name: string; error?: string } {
  try {
    const name = uniqueFileName(dstDir, basename(srcAbs))
    const target = join(dstDir, name)
    if (statSync(srcAbs).isDirectory()) {
      mkdirSync(target, { recursive: true })
      const walk = (from: string, to: string): void => {
        for (const de of readdirSync(from, { withFileTypes: true })) {
          const f = join(to, de.name)
          if (de.isDirectory()) { mkdirSync(f, { recursive: true }); walk(join(from, de.name), f) }
          else copyFileSync(join(from, de.name), f)
        }
      }
      walk(srcAbs, target)
    } else {
      copyFileSync(srcAbs, target)
    }
    return { name }
  } catch (e) {
    return { name: '', error: (e as Error).message }
  }
}

/**
 * 存量上收：把某对话登记的素材条目搬进工作区主库（原件/提取稿一并**复制**过去，
 * 对话夹原样保留 —— 失败可重来，且「登记 ≠ 文件」的项目口径不变）。
 * 上收成功的条目从对话级 SOURCE.md 移除（合并视图里已由主库承载，留着会重复）；
 * 原件缺失等异常条目原地保留。未提取的 URL/引用条目只迁登记、零文件操作。
 */
export function promoteSessionSources(sessionId: string, getSetting: (key: string) => unknown): SourcesResult & { promoted?: number } {
  try {
    const cl = layout(sessionId, getSetting, false, 'session')
    if ('error' in cl) return { ok: false, error: cl.error }
    const convEntries = readEntries(cl)
    if (convEntries.length === 0) return { ok: true, promoted: 0 }
    const ws = layout(sessionId, getSetting, true, 'workspace')
    if ('error' in ws) return { ok: false, error: ws.error }
    mkdirSync(ws.dirAbs, { recursive: true })
    const wsEntries = readEntries(ws)
    let no = wsEntries.reduce((m, e) => Math.max(m, e.no), 0)
    const promoted: SourceEntry[] = []
    const kept: SourceEntry[] = []
    for (const e of convEntries) {
      let path = e.path
      let extracted = e.extracted
      let ok = true
      // ① 已入库原件：./名 → 复制进主库（唯一名），登记改为新层内相对路径
      if (path.startsWith('./')) {
        const srcAbs = join(cl.dirAbs, path.slice(2))
        if (existsSync(srcAbs)) {
          const c = copyInto(srcAbs, ws.dirAbs)
          if (c.error) ok = false
          else path = `./${c.name}`
        }
        // 原件缺失：登记照迁（用户可后续改路径），不因此放弃
      }
      // ② 提取稿指针：文件/网页目录一并复制，指针指向主库内新位置
      const ext = /^✓\s*→\s*(.+)$/.exec(e.extracted)
      if (ok && ext) {
        const rel = ext[1].trim()
        if (rel.startsWith('web/')) {
          const srcAbs = join(cl.dirAbs, rel)
          if (existsSync(srcAbs)) {
            const c = copyInto(srcAbs, join(ws.dirAbs, 'web'))
            if (c.error) ok = false
            else extracted = `✓ → web/${c.name}/`
          }
        } else {
          const srcAbs = join(cl.dirAbs, rel)
          if (existsSync(srcAbs)) {
            const c = copyInto(srcAbs, ws.dirAbs)
            if (c.error) ok = false
            else extracted = `✓ → ${c.name}`
          }
        }
      }
      if (ok) promoted.push({ ...e, no: ++no, path, extracted })
      else kept.push(e)
    }
    if (promoted.length > 0) {
      const w = rewriteEntries(ws, [...wsEntries, ...promoted])
      if (!w.ok) return { ok: false, error: w.error }
      // 全部上收成功才清对话级小节；有失败项时保留原状（合并视图仍可见，重试即可）
      if (kept.length === 0) {
        const wc = rewriteEntries(cl, [])
        if (!wc.ok) return { ok: false, error: `主库已迁入，但清理对话级登记失败：${wc.error}` }
      } else {
        const wc = rewriteEntries(cl, kept)
        if (!wc.ok) return { ok: false, error: `主库已迁入，但清理对话级登记失败：${wc.error}` }
      }
    }
    const m = readMerged(sessionId, getSetting)
    return {
      ok: true, promoted: promoted.length, relPath: ws.fileRel, entries: m.entries,
      workspaceRel: m.ws?.fileRel ?? null, sessionRel: m.conv?.fileRel ?? null,
      ...(kept.length > 0 ? { error: `${kept.length} 条因文件异常留在对话级（可重试）` } : {}),
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** IPC 注册（main/index.ts settingsCache 注入） */
export function registerAiTeachingSourceHandlers(getSetting: (key: string) => unknown): void {
  // v3.1.1：sessionId 允许为空 —— 空会话 = 工作区级主库（素材库面板脱离对话常驻的前提）
  ipcMain.handle('aiTeachSrc:read', (_e, sessionId: string) => readSources(String(sessionId ?? ''), getSetting))
  ipcMain.handle('aiTeachSrc:add', (_e, sessionId: string, input: AddSourceInput) => addSource(String(sessionId ?? ''), input, getSetting))
  ipcMain.handle('aiTeachSrc:remove', (_e, sessionId: string, no: number) => removeSource(String(sessionId ?? ''), Number(no), getSetting))
  ipcMain.handle('aiTeachSrc:extract', (_e, sessionId: string, no: number) => extractRange(String(sessionId ?? ''), Number(no), getSetting))
  // LibreOffice 探测（设置页「检测」按钮）：先清缓存再重探 —— 保证「刚装好 / 刚改路径」立刻拿到真值
  // （旧行为是进程级钉死 null，装完不重启永远找不到，见 sofficeConvert.ts 的 TTL 注释）
  ipcMain.handle('aiTeachSrc:sofficeProbe', (_e, settingPath?: string) => {
    resetSofficeCache()
    return probeSoffice(typeof settingPath === 'string' && settingPath.trim() ? settingPath : getSetting('sofficePath'))
  })
  // 3-21 视觉转写（手动档）：原件字节交给渲染层栅格化；转写结果并入提取稿
  ipcMain.handle('aiTeachSrc:pdfBytes', (_e, sessionId: string, no: number) => readSourceBytes(String(sessionId ?? ''), Number(no), getSetting))
  ipcMain.handle('aiTeachSrc:transcribe', async (_e, sessionId: string, no: number, pages: { n: number; dataUrl: string }[], modelSpec?: string) => {
    const list = Array.isArray(pages) ? pages.map(p => ({ n: Number(p?.n), dataUrl: String(p?.dataUrl ?? '') })) : []
    return transcribeVision(String(sessionId ?? ''), Number(no), list, getSetting, modelSpec ? String(modelSpec) : undefined)
  })
  // 网页素材：探测（门户/目录/单文章）/ 批量抓取（进度经 aiTeach:web-crawl-progress 推送）/ 取消
  ipcMain.handle('aiTeachSrc:webProbe', (_e, sessionId: string, no: number, anchorUrl?: string) =>
    webProbeSource(String(sessionId ?? ''), Number(no), getSetting, anchorUrl ? String(anchorUrl) : undefined))
  ipcMain.handle('aiTeachSrc:webCrawl', (_e, sessionId: string, no: number, urls: string[]) =>
    webCrawlSource(String(sessionId ?? ''), Number(no), urls, getSetting))
  ipcMain.handle('aiTeachSrc:webCancel', (_e, sessionId: string) => webCrawlCancel(String(sessionId ?? '')))
  // 存量上收：对话级登记（含原件/提取稿复制）迁入工作区主库
  ipcMain.handle('aiTeachSrc:promote', (_e, sessionId: string) => promoteSessionSources(String(sessionId ?? ''), getSetting))
  // 入库浏览：系统文件选择器（表单「已入库」用；返回绝对路径给 add 拷贝）
  ipcMain.handle('aiTeachSrc:pick', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const r = await dialog.showOpenDialog(win, {
      title: '选择要入库的素材文件',
      properties: ['openFile'],
      filters: [
        { name: '素材（文档/演示/图片/文本）', extensions: ['pdf', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'md', 'txt', 'docx'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    return r.canceled || r.filePaths.length === 0 ? { ok: true, path: null } : { ok: true, path: r.filePaths[0] }
  })
  // 视觉转写预检（2026-09-08）：转写前先确认有可用视觉模型——避免渲染层白跑栅格化后才失败，
  // 且把配置指引完整带回（此前错误被包装截断，用户看不到「去哪配模型」）
  ipcMain.handle('aiTeachSrc:visionCheck', () => {
    const v = findVisionModel()
    return v ? { ok: true, model: `${v.provider.name}:${v.model}` } : { ok: false, error: '未找到可用的视觉模型：请到 设置 → AI 模型 添加支持图片的模型（如 qwen-vl / glm-4v / gpt-4o / kimi-latest，OpenAI 兼容类型），再回来转写' }
  })
  // 登记仓库目录为素材（2026-09-08）：系统对话框选目录 → 必须在当前仓库内 → 返回仓库相对路径
  ipcMain.handle('aiTeachSrc:pickDir', async () => {
    const vault = getCurrentVault()
    if (!vault) return { ok: false, error: '尚未打开仓库' }
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const r = await dialog.showOpenDialog(win, { title: '选择仓库内要登记为素材的目录', properties: ['openDirectory'] })
    if (r.canceled || r.filePaths.length === 0) return { ok: true, path: null }
    const rel = relative(vault.rootPath, r.filePaths[0]).replace(/\\/g, '/')
    if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, error: '所选目录必须在当前仓库内' }
    if (!rel) return { ok: false, error: '不能登记仓库根目录本身' }
    return { ok: true, path: rel }
  })
}
