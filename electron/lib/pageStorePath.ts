/**
 * 页面数据（page store）的**路径与内容校验** —— 零依赖纯函数。
 *
 * 为什么单独一个文件：契约脚本（`.AGENT/scripts/page-store/verify-page-store.mjs`）要直接
 * `import` 这些规则真跑一遍。混进 `fs` / `electron` 就 import 不了（裸 node 解析不了无扩展名
 * 的依赖链），规则也就没法被验证 —— 与 `releaseNotes/judge.ts` 同一个理由。
 *
 * 边界（2026-11-26 拍板，见 `docs/html-page-store.md`）：
 * - 只开一个命名空间：`.knowbase/pagesdata/`，**不接受** `.knowbase/modules/**`、
 *   `.knowbase/meta.json` 之类核心数据 —— 页面脚本碰不到密码本、日程、错题本。
 * - 只收 `.json`，最多 3 层子目录，单文件 1MB。
 * - 内容必须是 JSON 对象/数组（不许存裸字符串、数字），这样 AI 侧与页面侧都按结构读写。
 */

/** 页面数据根目录（相对仓库根）。与 jsonStore 的 module 名一致：`.knowbase/<module>/<key>` */
export const PAGE_STORE_MODULE = 'pagesdata'
export const PAGE_STORE_DIR = `.knowbase/${PAGE_STORE_MODULE}`

/** 单文件上限：看板类数据正常 <50KB，1MB 足够且有上限保护 */
export const PAGE_STORE_MAX_BYTES = 1024 * 1024

/** pagesdata 下最多允许的目录层数（`a/b/c.json` = 2 层目录） */
export const PAGE_STORE_MAX_DIR_DEPTH = 3

/** Windows 非法字符 + 控制字符；`:` 一并禁（防 NTFS 数据流写法）；`%` 禁（防 `%2e%2e` 编码穿越当文件名） */
const ILLEGAL_CHARS = /[\u0000-\u001f<>:"|?*%]/

function hasIllegalSegments(segs: string[]): boolean {
  return segs.some(s => s === '' || s === '.' || s === '..')
}

/**
 * 归一化并校验一个页面数据相对路径。
 * 合法返回 `.knowbase/pagesdata/a/b.json` 形式；非法返回 null（调用方一律拒绝）。
 *
 * 刻意不「修正」输入（不 trim 掉奇怪字符、不自动加后缀）—— 拒绝比猜测安全，
 * 因为这条路径的落点是一个可写目录。
 */
export function normalizePageStoreRel(input: unknown): string | null {
  if (typeof input !== 'string') return null
  if (input.length === 0 || input.length > 260) return null
  const rel = input.replace(/\\/g, '/')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null
  if (ILLEGAL_CHARS.test(rel)) return null
  const segs = rel.split('/')
  if (hasIllegalSegments(segs)) return null
  if (segs.length < 3) return null
  if (segs[0] !== '.knowbase' || segs[1] !== PAGE_STORE_MODULE) return null
  const inner = segs.slice(2)
  if (inner.length > PAGE_STORE_MAX_DIR_DEPTH + 1) return null
  const file = inner[inner.length - 1]
  if (!/\.json$/i.test(file) || file.length <= '.json'.length) return null
  return ['.knowbase', PAGE_STORE_MODULE, ...inner].join('/')
}

/** 归一化路径 → jsonStore 的 key（`a/b.json`）；非法返回 null */
export function pageStoreKey(rel: unknown): string | null {
  const norm = normalizePageStoreRel(rel)
  if (!norm) return null
  return norm.split('/').slice(2).join('/')
}

export type PageStorePayloadResult =
  | { ok: true; text: string; bytes: number }
  | { ok: false; error: string }

/**
 * 序列化 + 校验待写入内容。
 * 序列化口径必须与 `jsonStore.writeJson` 完全一致（`JSON.stringify(data, null, 2)`），
 * 否则这里算出的字节数/去写盘的字节数会对不上，rev（sha1）也就对不上。
 */
export function measurePageStorePayload(data: unknown): PageStorePayloadResult {
  if (data === null || typeof data !== 'object') {
    return { ok: false, error: '页面数据必须是 JSON 对象或数组' }
  }
  let text: string
  try {
    text = JSON.stringify(data, null, 2)
  } catch {
    return { ok: false, error: '页面数据无法序列化为 JSON（可能含循环引用或函数）' }
  }
  if (typeof text !== 'string') return { ok: false, error: '页面数据无法序列化为 JSON' }
  const bytes = Buffer.byteLength(text, 'utf-8')
  if (bytes > PAGE_STORE_MAX_BYTES) {
    return { ok: false, error: `页面数据过大（${Math.round(bytes / 1024)}KB，上限 ${PAGE_STORE_MAX_BYTES / 1024}KB）` }
  }
  return { ok: true, text, bytes }
}

/**
 * 冲突判定（乐观锁）。
 *
 * `expectedRev` 为 `undefined` / `null` = **强制写**（AI 工具、页面首次建档）。
 * 给了 rev 就必须与磁盘一致：磁盘上文件不存在视为 `''`，因此「页面以为自己是新建」
 * 遇到「文件已被别人建了」同样会撞冲突，而不是静默覆盖。
 */
export function pageStoreConflict(diskRev: string | null, expectedRev: unknown): boolean {
  if (expectedRev === undefined || expectedRev === null) return false
  if (typeof expectedRev !== 'string') return true
  return (diskRev ?? '') !== expectedRev
}
