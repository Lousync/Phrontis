/**
 * AI 文件策略（纯逻辑，零 electron / fs 依赖）—— P0-A 的唯一准入裁判。
 *
 * 为什么要有这一层：此前读写判定散在 `isAiReadableFile` / `isAiWritableFile` 两处硬编码
 * （读 28 种代码扩展名、写只有 .md/.txt），于是「界面能编辑 json/yml，AI 却不能」，
 * 「AI 自己能写进 .knowbase/_inbox，却再也读不回来」。策略层把规则收成一份可测的纯函数，
 * 仓库级覆盖（`.knowbase/config.json#aiPolicy`）只能**收窄**，不能放宽到这里定义的硬边界。
 *
 * 契约脚本：`.AGENT/scripts/ai-harness/verify-ai-file-policy.mjs`（直接 import 本文件）。
 * 注意：本文件不要 import node 内置模块，也不要 import electron —— 脚本用类型剥离直接跑。
 */

import { TEXT_VIEWABLE_EXTS } from '../../src/lib/aiTextExts'
import { AI_PRESET_LABELS, AI_PRESET_WRITE_EXTS, type AiFilePreset } from '../../src/lib/aiFilePolicyShared'

export type { AiFilePreset } from '../../src/lib/aiFilePolicyShared'
export { AI_PRESET_LABELS, AI_PRESET_WRITE_EXTS } from '../../src/lib/aiFilePolicyShared'

export interface AiFilePolicy {
  /** 预设；`custom` 时看 writeExts */
  preset: AiFilePreset
  /** 可写扩展名（不含点、小写）。仅 preset='custom' 时由用户显式给出，其余由预设派生 */
  writeExts: string[]
  /** 额外拒绝的相对路径前缀或基名（仓库策略只能收窄；如 "草稿/"、"legacy.json"） */
  denyPaths: string[]
  /** 允许的点目录名白名单（.git / .ssh / .aws / .knowbase 永远拒） */
  allowDotDirs: string[]
  /** 单文件读取上限（字节） */
  maxReadBytes: number
  /** 单文件写入上限（字节） */
  maxWriteBytes: number
}

export const AI_DEFAULT_READ_MAX_BYTES = 10 * 1024 * 1024
export const AI_DEFAULT_WRITE_MAX_BYTES = 2 * 1024 * 1024
/** pdf / pptx 文本提取沿用 docsReader 的 80MB 上限 */
export const AI_DOC_MAX_BYTES = 80 * 1024 * 1024

export const AI_READ_DOC_EXTS: readonly string[] = ['pdf', 'pptx']

function uniq(list: readonly string[]): string[] {
  return [...new Set(list.map((x) => x.toLowerCase().replace(/^\./, '')).filter(Boolean))]
}

/** 可读扩展名：全部可查看文本 + pdf/pptx（文本提取） */
export const AI_READ_EXTS: readonly string[] = uniq([...TEXT_VIEWABLE_EXTS, ...AI_READ_DOC_EXTS])

/** 点目录硬拒绝：无论白名单怎么写都不放开 */
export const AI_HARD_DENY_DOT_DIRS: readonly string[] = [
  '.git', '.hg', '.svn', '.ssh', '.aws', '.gnupg', '.knowbase', '.attachments', '.books', '.trash',
]

/**
 * 允许的点目录白名单默认值：保守为空。
 * 需要改 `.github/workflows` 的仓库在 `.knowbase/config.json#aiPolicy.allowDotDirs` 里显式加。
 */
export const AI_DEFAULT_ALLOW_DOT_DIRS: readonly string[] = []

export const DEFAULT_AI_FILE_POLICY: AiFilePolicy = {
  preset: 'all-text',
  writeExts: [],
  denyPaths: [],
  allowDotDirs: [],
  maxReadBytes: AI_DEFAULT_READ_MAX_BYTES,
  maxWriteBytes: AI_DEFAULT_WRITE_MAX_BYTES,
}

/** 密钥 / 凭据类文件名：读也拒（避免模型把私钥内容发进上下文） */
const SECRET_BASENAME_PATTERNS: RegExp[] = [
  /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /^credentials?(\.[a-z0-9]+)?$/i,
  /^secrets?(\.[a-z0-9]+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|ppk)$/i,
]

export function relToPosix(rel: unknown): string {
  return String(rel ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export function baseNameOfRel(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

export function extOfRel(rel: string): string {
  const base = baseNameOfRel(rel)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** 第一个点开头的路径段（不含 `.` / `..`）；null = 无点目录 */
export function firstDotSegment(rel: string): string | null {
  for (const seg of relToPosix(rel).split('/')) {
    if (seg && seg !== '.' && seg !== '..' && seg.startsWith('.')) return seg
  }
  return null
}

export function isSecretBasename(rel: string): boolean {
  const base = baseNameOfRel(relToPosix(rel))
  return SECRET_BASENAME_PATTERNS.some((re) => re.test(base))
}

/** 把仓库覆盖合并到默认策略上（仓库只能收窄：扩展名取交集，拒绝清单取并集） */
export function resolveAiFilePolicy(overrides?: Partial<AiFilePolicy> | null): AiFilePolicy {
  const src = overrides ?? {}
  const preset: AiFilePreset = src.preset === 'notes' || src.preset === 'notes+code' || src.preset === 'custom'
    ? src.preset
    : src.preset === 'all-text'
      ? 'all-text'
      : DEFAULT_AI_FILE_POLICY.preset
  const presetExts = preset === 'custom' ? [] : AI_PRESET_WRITE_EXTS[preset]
  const customExts = Array.isArray(src.writeExts) ? uniq(src.writeExts) : []
  // custom 预设必须显式给名单；缺省回落到默认预设（不静默变成「全可写」）
  if (preset === 'custom' && customExts.length === 0) {
    return resolveAiFilePolicy({ ...src, preset: DEFAULT_AI_FILE_POLICY.preset })
  }
  const clampBytes = (v: unknown, fallback: number): number => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    preset,
    writeExts: preset === 'custom' ? customExts : [...presetExts],
    denyPaths: Array.isArray(src.denyPaths) ? src.denyPaths.map(relToPosix).filter(Boolean) : [],
    allowDotDirs: Array.isArray(src.allowDotDirs)
      ? [...new Set(src.allowDotDirs.map((d) => String(d).trim().toLowerCase()).filter((d) => d.startsWith('.') && !AI_HARD_DENY_DOT_DIRS.includes(d)))]
      : [...AI_DEFAULT_ALLOW_DOT_DIRS],
    maxReadBytes: clampBytes(src.maxReadBytes, AI_DEFAULT_READ_MAX_BYTES),
    maxWriteBytes: clampBytes(src.maxWriteBytes, AI_DEFAULT_WRITE_MAX_BYTES),
  }
}

/** 生效的可写扩展名集合 */
export function writableExtsOf(policy: AiFilePolicy): Set<string> {
  return new Set(policy.preset === 'custom' ? uniq(policy.writeExts) : AI_PRESET_WRITE_EXTS[policy.preset] ?? [])
}

export function isWritableExt(ext: string, policy: AiFilePolicy): boolean {
  return writableExtsOf(policy).has(ext.toLowerCase())
}

export function isReadableExt(ext: string, policy: AiFilePolicy): boolean {
  const e = ext.toLowerCase()
  if (AI_READ_EXTS.includes(e)) return true
  return writableExtsOf(policy).has(e)
}

function matchesDenyPath(rel: string, denyPaths: string[]): boolean {
  if (denyPaths.length === 0) return false
  const base = baseNameOfRel(rel)
  return denyPaths.some((p) => {
    if (!p) return false
    if (p.endsWith('/')) return rel === p.slice(0, -1) || rel.startsWith(p)
    return rel === p || base === p || rel.startsWith(`${p}/`)
  })
}

/** 未分类收件箱：AI 自己建的页必须读得回来（唯一放行的 .knowbase 子树） */
export function isInboxRel(rel: string): boolean {
  return rel === '.knowbase/_inbox' || rel.startsWith('.knowbase/_inbox/')
}

export type AiFileOp = 'read' | 'write'

export interface AiFileDecision {
  allow: boolean
  /** 拒绝原因（给模型看的短句；allow=true 时为 undefined） */
  reason?: string
  ext: string
}

export interface AiFileProbe {
  /** 仓库相对路径（posix） */
  rel: string
  op: AiFileOp
  /** 文件字节数（不存在 = undefined，按新建处理） */
  size?: number
  /** lstat 判定（resolveSafe 已挡一层，这里再兜一次） */
  isSymlink?: boolean
  /** 前 512 字节含 NUL（调用方探测后传入；纯逻辑不读盘） */
  binary?: boolean
}

const DENY_DOT = '点目录 / 隐藏路径对 AI 关闭（可在仓库策略里放行特定点目录）'
const DENY_SECRET = '疑似密钥 / 凭据文件，禁止 AI 读写'

/**
 * 准入判定（纯函数）。所有 AI 文件工具必须先过这里，再走 fs。
 *
 * 顺序固定：路径合法性 → 点目录策略 → 密钥名 → 扩展名 → 大小 → 二进制。
 * 顺序固定是为了让错误提示稳定（同一路径每次得到同一句拒绝原因）。
 */
export function evaluateAiFile(probe: AiFileProbe, policy: AiFilePolicy): AiFileDecision {
  const rel = relToPosix(probe.rel)
  const ext = extOfRel(rel)
  const deny = (reason: string): AiFileDecision => ({ allow: false, reason, ext })

  if (!rel) return deny('路径为空')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return deny('只接受仓库相对路径（不能是绝对路径）')
  if (rel.split('/').some((s) => s === '..')) return deny('路径不能包含 ..')
  if (probe.isSymlink) return deny('符号链接一律不读写（可能越出仓库）')
  if (matchesDenyPath(rel, policy.denyPaths)) return deny('该路径被当前仓库策略拒绝')

  // .knowbase 内部：只放行收件箱读写与 modules/json 只读
  if (rel === '.knowbase' || rel.startsWith('.knowbase/')) {
    if (isInboxRel(rel)) {
      if (!['md', 'markdown', 'txt', 'text'].includes(ext)) return deny('未分类收件箱只放行 Markdown / 纯文本')
      if (probe.size !== undefined && probe.size > policy.maxWriteBytes && probe.op === 'write') {
        return deny(`文件过大（${probe.size} 字节 > ${policy.maxWriteBytes} 上限）`)
      }
      return { allow: true, ext }
    }
    if (probe.op === 'read' && rel.startsWith('.knowbase/modules/') && ext === 'json') return { allow: true, ext }
    return deny('.knowbase 内部数据对 AI 只读且仅限 modules/*.json 与 _inbox')
  }

  const dotSeg = firstDotSegment(rel)
  if (dotSeg) {
    const allowed = policy.allowDotDirs.map((d) => d.toLowerCase()).includes(dotSeg.toLowerCase())
    if (!allowed) return deny(DENY_DOT)
  }

  if (isSecretBasename(rel)) return deny(DENY_SECRET)

  if (probe.op === 'read') {
    if (!isReadableExt(ext, policy)) return deny(`该文件类型不可读（可读类型见策略；当前预设 ${policy.preset}）`)
    const limit = AI_READ_DOC_EXTS.includes(ext) ? AI_DOC_MAX_BYTES : policy.maxReadBytes
    if (probe.size !== undefined && probe.size > limit) {
      return deny(`文件过大（${probe.size} 字节 > ${limit} 上限），拒绝读取`)
    }
  } else {
    if (!isWritableExt(ext, policy)) return deny(`该文件类型不可写（当前预设 ${policy.preset}；可在 设置 → AI → 权限 → 当前工作区 调整）`)
    if (probe.size !== undefined && probe.size > policy.maxWriteBytes) {
      return deny(`文件过大（${probe.size} 字节 > ${policy.maxWriteBytes} 上限），拒绝写入`)
    }
  }

  if (probe.binary) return deny('检测到二进制内容（含 NUL 字节），AI 只处理文本文件')
  return { allow: true, ext }
}

/** 预设中文名在 src/lib/aiFilePolicyShared.ts（主进程与渲染层同源），此处不再重复声明 */

/** 目录操作（mkdir / 整目录移入回收站）准入：只看路径语义，不看扩展名 */
export function evaluateAiDir(relRaw: unknown, policy: AiFilePolicy): { allow: boolean; rel: string; reason?: string } {
  const rel = relToPosix(relRaw)
  const deny = (reason: string) => ({ allow: false, rel, reason })
  if (!rel) return deny('路径为空')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return deny('只接受仓库相对路径')
  if (rel.split('/').some((s) => s === '..')) return deny('路径不能包含 ..')
  if (rel === '.knowbase' || rel.startsWith('.knowbase/')) return deny('.knowbase 内部数据对 AI 只读')
  if (matchesDenyPath(rel, policy.denyPaths)) return deny('该路径被当前仓库策略拒绝')
  const dotSeg = firstDotSegment(rel)
  if (dotSeg && !policy.allowDotDirs.map((d) => d.toLowerCase()).includes(dotSeg.toLowerCase())) {
    return deny(DENY_DOT)
  }
  return { allow: true, rel }
}
