/**
 * 仓库根相对附件的图片取回 —— 阅读态（MarkdownPreview）与即时渲染档（CM6 图片 widget）**共用一处真相**。
 *
 * 背景：md 里形如 `![x](.attachments/2026-09/x.png)` 的链接，渲染进程没有文件系统 http 服务，
 * 必须统一经 `ws:readImage`（主进程附件白名单 + resolveSafe 越界防护）解析成 data:URI，进程内缓存。
 * 原先这段逻辑内嵌在 `MarkdownPreview` 的 `VaultRelImg` 里；抽出来是为了让编辑器内的内联图片
 * 和阅读态用同一套路径归一化规则与同一份缓存（否则两处规则迟早漂移）。
 */

import { workspaceGetCurrent, workspaceReadImage } from './ipc'

const vaultRelImgCache = new Map<string, string>()
let vaultRelRootIdPromise: Promise<string | null> | null = null

/** 相对路径归一化：去 `./` 与 `../` 前缀，只认三种附件区写法（D1 起为 `.attachments/`） */
export function normalizeVaultRel(src: string): string | null {
  let s = src
  try { s = decodeURIComponent(s) } catch { /* 含 % 的原始名按字面处理 */ }
  for (let guard = 0; guard < 10; guard++) {
    if (s.startsWith('../')) { s = s.slice(3); continue }
    if (s.startsWith('./')) { s = s.slice(2); continue }
    break
  }
  if (/^\.attachments\//i.test(s) || /^\.knowbase\/_attachments\//i.test(s) || /^_attachments\//i.test(s)) return s
  return null
}

/** 已缓存的 data:URI（同步取，命中即免闪一下「加载中」） */
export function getCachedVaultImage(rel: string): string | null {
  return vaultRelImgCache.get(rel) ?? null
}

/** 取回并缓存 data:URI；失败返回 null（调用方决定破图占位） */
export async function loadVaultImage(rel: string): Promise<string | null> {
  const cached = vaultRelImgCache.get(rel)
  if (cached) return cached
  try {
    if (!vaultRelRootIdPromise) vaultRelRootIdPromise = workspaceGetCurrent().then((cur) => cur?.rootId ?? null)
    const rootId = await vaultRelRootIdPromise
    if (!rootId) return null
    const res = await workspaceReadImage(rootId, rel)
    if (res.dataUrl) {
      vaultRelImgCache.set(rel, res.dataUrl)
      return res.dataUrl
    }
  } catch { /* 取回失败：调用方保持可见的破图/加载态，不崩 */ }
  return null
}
