/**
 * 仓库内图片的取回 —— 阅读态（`MarkdownPreview`）与即时渲染档（CM6 图片 widget）**共用一处真相**。
 *
 * 背景：md 里形如 `![x](.attachments/2026-09/x.png)` 的链接，渲染进程没有文件系统 http 服务，
 * 必须统一经主进程解析。原先这段逻辑内嵌在 `MarkdownPreview` 的 `VaultRelImg` 里；
 * 抽出来是为了让编辑器内的内联图片和阅读态用同一套路径归一化规则与同一份缓存
 * （否则两处规则迟早漂移）。
 *
 * ## 批 3（2026-10-13）改了这条通道，两件事
 *
 * **① 从 `ws:readImage` 换成 `ws:readRangeBytes`。**
 * 老通道的白名单是**附件区**（`.attachments/` 等），于是 `![](图片/照片.png)` 这种
 * 「仓库里任意位置」的引用必然是破图 —— 只能先经「插入图片」把图复制进附件区。
 * 新通道按**扩展名**放行（`electron/lib/workspaceManager.ts:235`），
 * PDF / TXT / foliate 三个阅读器都在用，**主进程零改动**（批 3 只往那份名单补了 `avif`）。
 * 不走「扩 `ws:readImage` 白名单」那条路：那等于再开一扇能力相同的门。
 *
 * **② data:URI 换成 Blob objectURL。**
 * base64 多 33% 体积，还要一次 `atob` 全量解码（20MB 的图白多 7MB 字符串）。
 * Blob 让 Chromium 自己决定何时回收解码后的位图。
 * 代价是**必须自己管生命周期**：objectURL 被 URL 表持有，不 revoke 就不会被 GC
 * （表象是「翻了几十张图的笔记之后内存一路涨」），故下面配了有上限的 LRU + 逐出即 revoke。
 *
 * ★ 两个消费者（`MarkdownPreview.tsx:357` 的 `VaultRelImg` 与 `LiveMarkdownPane.tsx:112`
 *  的 `ImageWidget`）**一行都没改** —— 它们只调本文件导出的三个函数。
 */

import { workspaceGetCurrent, workspaceReadRangeBytes } from './ipc'
import { MAX_IMAGE_BYTES, imageMime, isRenderableImageExt } from './imageFormats'

/** 缓存条目上限。一首笔记里的插图通常个位数，120 足够覆盖来回切换而不至于攒下几百 MB blob */
const MAX_CACHE = 120

interface CacheEntry { url: string; rootId: string }

/** key = 仓库根相对路径（见 `getCachedVaultImage` 里为什么不是复合键） */
const cache = new Map<string, CacheEntry>()
/** 最近一次已知的当前仓库 id —— 用来识别「换了仓库」，以及让**同步**读取器能判失效 */
let lastRootId: string | null = null

/** 换仓库就整表清掉并 revoke：同一路径在两个仓库里是**两张不同的图** */
function adoptRoot(rootId: string): void {
  if (lastRootId === rootId) return
  lastRootId = rootId
  for (const e of cache.values()) URL.revokeObjectURL(e.url)
  cache.clear()
}

function put(rel: string, entry: CacheEntry): void {
  cache.delete(rel)
  cache.set(rel, entry)
  while (cache.size > MAX_CACHE) {
    // Map 保持插入序 ⇒ 第一个就是最久未用的
    const oldest = cache.keys().next()
    if (oldest.done) break
    const victim = cache.get(oldest.value)
    if (victim) URL.revokeObjectURL(victim.url)
    cache.delete(oldest.value)
  }
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function extOf(rel: string): string {
  const m = /\.([^./\\]+)$/.exec(rel)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 把 md 里的 `src` 归一化成**仓库根相对路径**；不是「仓库内的图片」就返回 null。
 *
 * 批 3 放宽了准入面（原先只认 `.attachments/` / `.knowbase/_attachments/` / `_attachments/`
 * 三个前缀，其余一律 null ⇒ 用户自己放进仓库的图在笔记里引用必然破图）。
 * 仍然拒绝的四类，一条都不能松：
 *   · 带 scheme 的（`data:` / `kbview:` / `https:` …）—— 那不该走仓库取回；
 *   · 绝对路径与协议相对（`/x` `//host/x` `C:\x`）；
 *   · 剥掉前导 `./` `../` 之后**仍含 `..` 段**的 —— 剥前导是为了兼容「相对笔记写链接」的
 *     习惯写法（老行为），但剥完还剩 `..` 就说明它本来指向仓库外，不认；
 *   · 扩展名不在可渲染图片集合里的 —— 主进程的 range 通道也会拒，
 *     在这里就返回 null 可以让调用方直接走破图占位，不必白跑一次 IPC。
 */
export function normalizeVaultRel(src: string): string | null {
  let s = (src || '').trim()
  if (!s) return null
  try { s = decodeURIComponent(s) } catch { /* 含 % 的原始名按字面处理 */ }
  s = s.replace(/\\/g, '/')
  if (SCHEME_RE.test(s)) return null
  if (s.startsWith('/')) return null
  for (let guard = 0; guard < 10; guard++) {
    if (s.startsWith('../')) { s = s.slice(3); continue }
    if (s.startsWith('./')) { s = s.slice(2); continue }
    break
  }
  if (!s) return null
  if (s.split('/').some(seg => seg === '..')) return null
  if (!isRenderableImageExt(extOf(s))) return null
  return s
}

/**
 * 已缓存的 objectURL（同步取，命中即免闪一下「加载中」）。
 *
 * 为什么缓存键是**纯路径**而不是 `rootId + 路径`：本函数是**同步**的
 * （`VaultRelImg` 用它做 `useState` 初值），拿不到 rootId。改为拿 `lastRootId` 做**校验**：
 * 条目记着自己属于哪个仓库，与当前仓库不一致就当未命中。
 * 这样换仓库后同一个 `图片/照片.png` 不会再命中**上一个仓库的图**（老实现只按路径缓存，
 * 这是个一直存在的潜伏 bug）。
 */
export function getCachedVaultImage(rel: string): string | null {
  const e = cache.get(rel)
  if (!e || !lastRootId || e.rootId !== lastRootId) return null
  // LRU：命中即移到队尾
  cache.delete(rel)
  cache.set(rel, e)
  return e.url
}

/** 探测 1 字节拿真实大小，再整份读 —— 省掉一次 `stat`，也避免为一张超大图白读 32MB */
async function fetchVaultImage(rootId: string, rel: string): Promise<string | null> {
  const probe = await workspaceReadRangeBytes(rootId, rel, 0, 1)
  if (probe.error || typeof probe.size !== 'number') return null
  if (probe.size <= 0 || probe.size > MAX_IMAGE_BYTES) return null
  const full = await workspaceReadRangeBytes(rootId, rel, 0, probe.size)
  if (full.error || full.truncated) return null
  const blob = new Blob([full.bytes as unknown as BlobPart], { type: imageMime(extOf(rel)) })
  return URL.createObjectURL(blob)
}

/**
 * 取回并缓存 objectURL；失败返回 null（调用方决定破图占位）。
 *
 * ★ 刻意**不缓存** `workspaceGetCurrent()` 的 Promise：老实现缓存了它，
 * 换仓库后永远拿到旧 rootId —— 与本文件上面那个缓存键 bug 是同一个根因的两个面。
 */
export async function loadVaultImage(rel: string): Promise<string | null> {
  const hit = getCachedVaultImage(rel)
  if (hit) return hit
  try {
    const cur = await workspaceGetCurrent()
    const rootId = cur?.rootId ?? null
    if (!rootId) return null
    adoptRoot(rootId)   // 换仓库会整表清掉，故下面要再查一次
    const again = cache.get(rel)
    if (again && again.rootId === rootId) return again.url
    const url = await fetchVaultImage(rootId, rel)
    if (!url) return null
    put(rel, { url, rootId })
    return url
  } catch { /* 取回失败：调用方保持可见的破图/加载态，不崩 */ }
  return null
}
