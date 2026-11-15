/**
 * 仓库内查找（glob / 深度）纯逻辑 —— P0-A §4.2 `builtin.vault.find`。
 *
 * 此前模型只能一层层 `vault.list`（默认 200 条）来「找文件」，稍大的仓库几轮就把预算烧光。
 * 这里把 glob 语义与深度规则收敛成纯函数，fs 遍历由调用方负责，契约脚本可直接跑边界。
 *
 * 契约：`.AGENT/scripts/ai-harness/verify-vault-find.mjs`
 */

/** 单次 find 的结果上限（再多也没有阅读价值，只会撑爆上下文） */
export const MAX_FIND_LIMIT = 2000
export const DEFAULT_FIND_LIMIT = 500
export const DEFAULT_FIND_DEPTH = 8
export const MAX_FIND_DEPTH = 20

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/**
 * glob → 正则。支持 `**`（跨目录）、`*`（段内）、`?`（单字符）。
 * 大小写不敏感（Windows 语义；跨平台结果一致更好解释）。
 */
export function globToRegExp(pattern: string): RegExp {
  const p = String(pattern ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` 吃掉任意层目录（含零层）；裸 `**` 匹配任意字符
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += escapeRe(c)
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

/** 模式是否带目录段（不带则只匹配文件名） */
export function isBasenamePattern(pattern: string): boolean {
  return !String(pattern ?? '').replace(/\\/g, '/').includes('/')
}

export interface MatchTarget {
  /** 仓库相对路径（posix） */
  rel: string
  type: 'file' | 'dir'
}

/**
 * 命中判定：
 * - 模式为空 → 全命中（= 只按深度/上限列树）；
 * - 尾部 `/` → 只匹配目录；
 * - 不含 `/` → 只比对文件名（`*.ts` 等价于 `**\/*.ts`）；
 * - 含 `/` → 与整条相对路径比对。
 */
export function matchesFindPattern(target: MatchTarget, pattern: string): boolean {
  const raw = String(pattern ?? '').trim()
  if (!raw) return true
  const dirOnly = raw.endsWith('/')
  if (dirOnly && target.type !== 'dir') return false
  const pat = dirOnly ? raw.slice(0, -1) : raw
  const subject = isBasenamePattern(pat) ? target.rel.slice(target.rel.lastIndexOf('/') + 1) : target.rel
  return globToRegExp(pat).test(subject)
}

/** 深度钳制：1 = 只看当前目录条目，省略 = 8 层 */
export function clampFindDepth(raw: unknown, fallback = DEFAULT_FIND_DEPTH): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, MAX_FIND_DEPTH)
}

export function clampFindLimit(raw: unknown, fallback = DEFAULT_FIND_LIMIT): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, MAX_FIND_LIMIT)
}

/** 仓库相对路径的父目录（'' = 根） */
export function parentDirOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/** 相对某目录的层数（'a/b.md' 相对 'a' = 1） */
export function depthUnder(dirRel: string, rel: string): number {
  const rest = dirRel && rel.startsWith(`${dirRel}/`) ? rel.slice(dirRel.length + 1) : rel
  return rest.split('/').length
}
