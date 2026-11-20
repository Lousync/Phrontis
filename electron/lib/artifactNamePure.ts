/**
 * AI 教学重构 P0 · 产物命名纯函数（唯一真相源）
 *
 * 契约面：
 * - `buildArtifactName` —— 文件名生成（段 / 章末复习 / 课程助手三种作用域）；
 * - `parseArtifactName` —— 反解（与 build 往返一致，用于旧产物扫描与列表分组）；
 * - `sortKeyFor` —— 文件管理器同序的排序键（章号 → 段号 → 课程助手垫底）；
 * - `isOverwriteKind` —— 同名是否允许原地覆盖（测验除外，铁律 19 版本递增由调用方处理）。
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.4、
 *       `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` §38.5。
 *
 * 命名规则（改动必须同步 `.AGENT/scripts/ai-teaching/verify-artifact-naming.mjs`）：
 * ```text
 * 01-01 讲义·进程调度.md      段：{章2}-{段2} {类型}·{标题}{ext}（无标题省略 ·标题）
 * 01 章末复习·讲义.md         章末复习：{章2} 章末复习·{类型}{ext}（忽略标题）
 * 00 课程助手·讲义·xxx.md     课程助手：00 课程助手·{类型}·{标题}{ext}
 * ```
 *
 * 取舍说明：
 * - **标题里的 `|` 按非法字符清洗为 `_`**（Windows 文件名非法集 + 控制字符同一处理）；
 *   首尾空白直接裁掉（Windows 文件名首尾空格不可见且会被系统裁掉），不补 `_`。
 * - 标题超过 40 字时截断为 31 字 + `-` + 8 位标题哈希，**总长仍为 40**：
 *   只截断不加哈希会让「同前缀的长标题」生成同名文件而互相覆盖。
 * - 排序：章号 / 段号补到 4 位参与比较，章级文件（章末复习）用段号 `9999` 排在
 *   本章所有段之后；章号 `00`（课程助手）与解析不出前缀的文件统一以 `zz-` 开头垫底，
 *   课程助手排 `zz-00-`、不可解析排 `zz-zz-`。即 `01-01 < 01-02 < 02 < 00`。
 *
 * 纯函数、零运行时依赖（只允许 `import type`）；可被 stripTypeScriptTypes 后直接 import。
 */

import type { ArtifactKind, ArtifactScope } from './aiTeachingTypesPure'

/** 类型中文标签（文件名用；顺序即 `ArtifactKind` 联合顺序） */
export const KIND_LABELS: Record<ArtifactKind, string> = {
  handoff: '交接',
  note: '笔记',
  lecture: '讲义',
  quiz: '测验',
  review: '复习',
  visual: '图',
  mindmap: '导图',
  image: '图片',
  knowledgecard: '知识点卡',
  lessonplan: '备课稿',
}

/** 缺省扩展名：md 类正文 / 图是单文件 html / 导图 json / 图片 png */
export const DEFAULT_EXT_BY_KIND: Record<ArtifactKind, string> = {
  handoff: '.md',
  note: '.md',
  lecture: '.md',
  quiz: '.md',
  review: '.md',
  visual: '.html',
  mindmap: '.json',
  image: '.png',
  knowledgecard: '.md',
  lessonplan: '.md',
}

/** 标题长度上限（含截断时追加的哈希后缀） */
const MAX_TITLE_LEN = 40

/** Windows / 文件名非法字符 + 控制字符 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g

/** FNV-1a 32 位：截断长标题时给稳定短哈希，避免同前缀标题撞名（纯、零依赖） */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 标题清洗：非法字符 / 控制字符 → `_`；空白折叠为单个空格；首尾空白裁掉；超长截断 */
function cleanTitle(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(s)
  if (chars.length <= MAX_TITLE_LEN) return s
  const head = chars.slice(0, MAX_TITLE_LEN - 9).join('').replace(/[_\s]+$/, '')
  return `${head}-${shortHash(s)}`
}

/** 章 / 段号：两位补零；非数字（含 undefined）按 1 处理 */
function pad2(v: unknown): string {
  const n = Number(v)
  const i = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 1
  return String(i).padStart(2, '0')
}

/** 扩展名归一：缺省取类型默认值；保证以 `.` 开头；只留字母数字 */
function normalizeExt(ext: unknown, kind: ArtifactKind): string {
  const raw = String(ext ?? '').trim().replace(/^\.+/, '').replace(/[^A-Za-z0-9]/g, '')
  return raw ? `.${raw}` : DEFAULT_EXT_BY_KIND[kind]
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 生成产物文件名（不含目录）。
 * `scope:'review'` 忽略 `title`；`scope:'assistant'` 章段恒为 `00`。
 */
export function buildArtifactName(input: {
  scope: ArtifactScope
  kind: ArtifactKind
  chapterIndex?: number
  segmentIndex?: number
  title?: string
  ext?: string
}): string {
  const kind = input.kind
  const label = KIND_LABELS[kind] ?? String(kind)
  const ext = normalizeExt(input.ext, kind)
  const title = cleanTitle(input.title)

  if (input.scope === 'review') {
    return `${pad2(input.chapterIndex ?? 1)} 章末复习·${label}${ext}`
  }
  if (input.scope === 'assistant') {
    return `00 课程助手·${label}${title ? `·${title}` : ''}${ext}`
  }
  return `${pad2(input.chapterIndex ?? 1)}-${pad2(input.segmentIndex ?? 1)} ${label}${title ? `·${title}` : ''}${ext}`
}

/**
 * 反解产物文件名（与 `buildArtifactName` 往返一致）。类型标签对不上返回 `null`。
 * `title` 是 build 清洗 / 截断后的形态（无法还原截断前的原文）。
 */
export function parseArtifactName(name: string, kind: ArtifactKind): {
  scope: ArtifactScope
  chapterIndex?: number
  segmentIndex?: number
  title?: string
  ext: string
} | null {
  const label = KIND_LABELS[kind]
  if (!label) return null
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  if (!base) return null

  const extMatch = /(\.[A-Za-z0-9]+)$/.exec(base)
  const ext = extMatch ? extMatch[1] : ''
  const stem = ext ? base.slice(0, -ext.length) : base

  const assistant = new RegExp(`^00 课程助手·${escapeRe(label)}(?:·(.+))?$`).exec(stem)
  if (assistant) {
    return { scope: 'assistant', ext, ...(assistant[1] ? { title: assistant[1] } : {}) }
  }

  const review = new RegExp(`^(\\d{2,}) 章末复习·${escapeRe(label)}$`).exec(stem)
  if (review) {
    return { scope: 'review', chapterIndex: Number(review[1]), ext }
  }

  const segment = new RegExp(`^(\\d{2,})-(\\d{2,}) ${escapeRe(label)}(?:·(.+))?$`).exec(stem)
  if (segment) {
    return {
      scope: 'segment',
      chapterIndex: Number(segment[1]),
      segmentIndex: Number(segment[2]),
      ext,
      ...(segment[3] ? { title: segment[3] } : {}),
    }
  }

  return null
}

/**
 * 排序键：`<章4>-<段4>\0<文件名>`；章级文件段位取 `9999`（排在本章各段之后）。
 * 章号 `00`（课程助手）→ `zz-00-…`；解析不出前缀 → `zz-zz-…`，二者恒排在普通章段之后。
 */
export function sortKeyFor(row: { rel: string }): string {
  const base = String(row?.rel ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const m = /^(\d{2,})(?:-(\d{2,}))?/.exec(base)
  if (!m) return `zz-zz-${base}`
  const chapter = Number(m[1])
  if (chapter === 0) return `zz-00-${base}`
  const chapterKey = String(chapter).padStart(4, '0')
  const segmentKey = m[2] === undefined ? '9999' : String(Number(m[2])).padStart(4, '0')
  return `${chapterKey}-${segmentKey}\u0000${base}`
}

/** 同名是否允许原地覆盖：测验按版本递增，其余一律原地改（铁律 19） */
export function isOverwriteKind(kind: ArtifactKind): boolean {
  return kind !== 'quiz'
}
