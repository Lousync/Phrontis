/**
 * AI 教学产物「原地修改」的纯函数（零 Electron / fs 依赖）。
 *
 * 2026-11-17 用户拍板：AI 改示意图 / 导图 / 讲义时不再另建 `-v2`，直接改原文件；
 * 旧版不保留。这里只做**路径边界**与**文本补丁**，落盘与广播留在 `aiTeachingSources`。
 * 单独拆出来是为了让 `.AGENT/scripts/ai-teaching/verify-artifact-inplace.mjs` 能直接
 * import 跑用例 —— 边界判定靠读源码正则锁不住（改一处少一处就漏）。
 */

import { extname } from 'path'

/** 允许局部修改的产物扩展名（文本类才谈得上「改一段」） */
export const ARTIFACT_EDIT_EXTS = ['html', 'json', 'md'] as const
/** artifact.edit 的文件大小上限（产物都是单文件，1MB 足够） */
export const MAX_ARTIFACT_EDIT_BYTES = 1024 * 1024
/** 单次调用最多几组替换（防模型一次塞几百条） */
export const MAX_ARTIFACT_EDITS = 10

export interface ArtifactEdit { oldText?: unknown; newText?: unknown }

/** 产物路径归一：只认仓库相对路径，拒绝对路径、`..`、点目录与只读素材目录。 */
export function normalizeArtifactRel(raw: unknown): { rel: string } | { error: string } {
  const s = String(raw ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!s) return { error: '缺少产物路径' }
  if (/^[a-zA-Z]:/.test(s)) return { error: '只接受仓库相对路径（不能是绝对路径）' }
  const segs = s.split('/').filter(Boolean)
  if (!segs.length || segs.some((x) => x === '.' || x === '..')) return { error: '产物路径不合法（不能包含 . / ..）' }
  if (segs.some((x) => x.startsWith('.'))) return { error: '不能修改隐藏目录 / 点文件' }
  if (segs.some((x) => x.toUpperCase() === 'SOURCES')) return { error: 'SOURCES/ 是只读素材目录' }
  return { rel: segs.join('/') }
}

/** 产物目录内的直接文件（visuals/ mindmaps/ outputs/）：带 relPath 的工具只许改这一层。 */
export function resolveProductFileRel(
  sessionRel: string, raw: unknown, dir: string, exts: readonly string[],
): { rel: string } | { error: string } {
  const n = normalizeArtifactRel(raw)
  if ('error' in n) return n
  const prefix = `${sessionRel}/${dir}/`
  if (!n.rel.startsWith(prefix)) return { error: `只能修改本会话 ${dir}/ 目录内的产物：${n.rel}` }
  const rest = n.rel.slice(prefix.length)
  if (!rest || rest.includes('/')) return { error: `${dir}/ 只认直接文件，不支持子目录：${n.rel}` }
  const ext = extname(rest).slice(1).toLowerCase()
  if (!exts.includes(ext)) return { error: `只支持 ${exts.map((e) => `.${e}`).join(' / ')} 产物：${n.rel}` }
  return { rel: n.rel }
}

/** 在文本上应用多段替换 + 末尾追加。
 *  - 每组 oldText 必须**唯一命中**（0 处 = 没找到，2 处以上 = 不够精确）；
 *  - **全部校验通过才返回新文本**（全有或全无），调用方不会落半成品；
 *  - newText 空串 = 删除该片段；append 追加前统一去掉文末空白。 */
export function applyArtifactEdits(
  text: string, edits: ArtifactEdit[], append: string,
): { ok: true; next: string; changed: number } | { ok: false; error: string } {
  const list = Array.isArray(edits) ? edits : []
  const tail = String(append ?? '')
  if (!list.length && !tail.trim()) return { ok: false, error: '至少要给 edits 或 append' }
  if (list.length > MAX_ARTIFACT_EDITS) return { ok: false, error: `一次最多 ${MAX_ARTIFACT_EDITS} 组替换` }
  let next = text
  let changed = 0
  for (let i = 0; i < list.length; i++) {
    const oldText = String(list[i]?.oldText ?? '')
    const newText = String(list[i]?.newText ?? '')
    if (!oldText) return { ok: false, error: `edits[${i}].oldText 不能为空` }
    const first = next.indexOf(oldText)
    if (first < 0) return { ok: false, error: `第 ${i + 1} 组未找到原文（截取前 60 字符）：${oldText.slice(0, 60)}…` }
    if (next.indexOf(oldText, first + oldText.length) >= 0) {
      return { ok: false, error: `第 ${i + 1} 组原文出现多处，请给更长更精确的 oldText` }
    }
    next = next.slice(0, first) + newText + next.slice(first + oldText.length)
    changed++
  }
  if (tail.trim()) {
    next = next.replace(/\s*$/, '') + '\n' + tail + '\n'
    changed++
  }
  return { ok: true, next, changed }
}
