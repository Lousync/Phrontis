/**
 * 右侧查看器 · 笔记页签的纯函数层（零运行时依赖，只有 `import type` 才允许出现）。
 *
 * 为什么单独一层：文件筛选 / 重名推导 / 时间文案 / 保存状态这几件事都是「输入决定输出」，
 * 放在组件里就只能靠读屏与手点验证。抽到这里后契约脚本
 * `.AGENT/scripts/ai-teaching/verify-notes-pane.mjs` 可以 strip 类型后直接 import 跑真值。
 *
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/ai-teaching-right-viewer-plan.md` §6.2（D1 笔记可写）。
 */

/** 列表项：仓库相对路径 + 磁盘 mtime（毫秒） */
export interface NoteFileRef {
  relPath: string
  mtimeMs: number
}

/** 保存状态（组件内单值；文案见 `saveStateLabel`） */
export type NoteSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict'

const SLASH = /[\\/]/

function baseName(relPath: string): string {
  const parts = relPath.split(SLASH)
  return parts[parts.length - 1] ?? ''
}

/** 去目录、去扩展名：`AI教学/x/笔记.md` → `笔记`；无扩展名原样返回 */
export function noteNameOf(relPath: string): string {
  const base = baseName(relPath || '')
  const dot = base.lastIndexOf('.')
  // dot <= 0：无扩展名，或 `.gitignore` 这类点开头文件（不把整个名字吃掉）
  return dot > 0 ? base.slice(0, dot) : base
}

/** 笔记 = md / txt（大小写不敏感）；PDF / 无扩展名 / `md.bak` 都不算 */
export function isNoteFile(relPath: string): boolean {
  return /\.(md|txt)$/i.test((relPath || '').trim())
}

/**
 * 按 mtime 倒序取前 `limit` 条笔记。
 * 只读入参：filter + map 生成新数组，调用方的列表不会被就地排序（组件里还要按原顺序渲染）。
 */
export function pickNoteFiles(files: Array<{ relPath: string; mtimeMs: number }>, limit = 12): NoteFileRef[] {
  const lim = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 12
  return files
    .filter((f) => !!f && typeof f.relPath === 'string' && isNoteFile(f.relPath))
    .map((f) => ({ relPath: f.relPath, mtimeMs: Number.isFinite(f.mtimeMs) ? f.mtimeMs : 0 }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.relPath.localeCompare(b.relPath))
    .slice(0, lim)
}

/** 路径比较键：统一分隔符 + 小写（Windows 文件系统大小写不敏感，宁可多让一个名字） */
function pathKey(relPath: string): string {
  return (relPath || '').replace(/\\/g, '/').toLowerCase()
}

/**
 * 重名推导：`产物/笔记.md` → `产物/笔记-2.md` → `产物/笔记-3.md`（跳过已占用的序号）。
 * `existing` 传**完整相对路径**，不是文件名。
 */
export function uniqueNotePath(existing: string[], baseRel: string): string {
  const used = new Set((existing || []).map(pathKey))
  if (!used.has(pathKey(baseRel))) return baseRel
  const slash = Math.max(baseRel.lastIndexOf('/'), baseRel.lastIndexOf('\\'))
  const dir = slash >= 0 ? baseRel.slice(0, slash + 1) : ''
  const base = slash >= 0 ? baseRel.slice(slash + 1) : baseRel
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 2; i < 10000; i++) {
    const candidate = `${dir}${stem}-${i}${ext}`
    if (!used.has(pathKey(candidate))) return candidate
  }
  return `${dir}${stem}-${Date.now()}${ext}`
}

function dayIndex(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000
}

/**
 * 列表里的相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / MM-DD。
 * 先按**时间差**分档（跨过零点但不足一小时的仍是「30 分钟前」），跨天才退到日历口径。
 */
export function relativeTime(now: number, mtimeMs: number): string {
  if (!Number.isFinite(now) || !Number.isFinite(mtimeMs) || mtimeMs <= 0) return '—'
  const diff = now - mtimeMs
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(mtimeMs)
  if (dayIndex(now) - dayIndex(mtimeMs) === 1) return '昨天'
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 动作行右侧的保存状态文案（`at` = `HH:MM`；clean 且没保存过就只说「已保存」） */
export function saveStateLabel(state: NoteSaveState, at?: string): string {
  if (state === 'dirty') return '未保存'
  if (state === 'saving') return '保存中…'
  if (state === 'conflict') return '冲突'
  return at ? `已保存 · ${at}` : '已保存'
}

/**
 * 写盘结果 → 本地基线。三种落点：
 *   · `conflict`：磁盘被外部改过，**基线保持原值**（调用方随后重读磁盘再决定新基线）；
 *   · `saved`：回填磁盘刚给的 mtime（拿不到就沿用旧值，下一轮仍按原基线检测）；
 *   · `error`：基线不动，脏标记保留，等用户再编辑或手动重试。
 */
export function mergeSaveResult(
  prev: { mtimeMs?: number },
  r: { ok: boolean; mtimeMs?: number; conflict?: boolean },
): { state: 'saved' | 'conflict' | 'error'; mtimeMs?: number } {
  if (r?.conflict) return { state: 'conflict', mtimeMs: prev?.mtimeMs }
  if (!r?.ok) return { state: 'error', mtimeMs: prev?.mtimeMs }
  const next = typeof r.mtimeMs === 'number' && r.mtimeMs > 0 ? r.mtimeMs : prev?.mtimeMs
  return { state: 'saved', mtimeMs: next }
}
