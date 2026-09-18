/**
 * @ 引用 / 附加文件的**骨架装配纯函数区**（v3.4.0 批次 B1）—— 零依赖：
 * 不 import electron、不碰磁盘、不读时钟。
 *
 * 单独成文件的理由（同 `releaseNotes/judge.ts` 的哲学）：
 * ① 契约脚本 `.AGENT/scripts/ai-assistant/verify-perception.mjs` 要**直接 import 这里**
 *    做断言。若留在 `agentService.ts`，脚本拿不到 —— 那个文件顶部
 *    `import { app } from 'electron'`，裸 node 解析具名导出会当场失败。
 * ② 「预算截断」是静默出错高发区：多切一个字符不报错、少切一段不报错，
 *    只有把输入顶到边界才看得见。做成纯函数 = 边界可穷举。
 *
 * 所以：**任何新的截断分支都加在这里，并同步补 verify 脚本的用例表**；
 * `agentService.buildSystemPrompt` 只负责「读文件 → 调这里 → 拼注入段」。
 */

/** 附加文件引用（渲染层 chip 的数据形态，与 `useAssistantChat.attachedFiles` 一致） */
export interface RefInput {
  title: string
  path: string
  /** 文件正文；读取失败时为 undefined（该篇降级为「仅路径」） */
  raw?: string
}

export interface RefSkeleton {
  title: string
  /** frontmatter 标量摘要（`k=v` 列表）；无 frontmatter 为空数组 */
  frontmatter: string[]
  /** 标题骨架行（`^#{1,6}` 原文，含 `#` 号） */
  hashes: string[]
  /** 首段正文（跳过 frontmatter / 标题 / 空行） */
  firstPara: string
  /** 组装后的成品文本（≤ REF_SKELETON_TOTAL_LIMIT） */
  text: string
}

/** 标题骨架段上限（字符） */
export const REF_SKELETON_HEAD_LIMIT = 160
/** 首段上限（字符） */
export const REF_SKELETON_PARA_LIMIT = 200
/** 单篇骨架总上限（字符）—— 上游 §3.2 拍板值 */
export const REF_SKELETON_TOTAL_LIMIT = 600
/** 注入段总上限（字符）—— 与 buildSystemPrompt 既有 6000 截断口径一致 */
export const ATTACHED_INJECTION_LIMIT = 6000
/** chip 上限（篇）—— 上游 §3.1 拍板值；契约脚本读此常量，避免字面量再抄一份 */
export const MAX_ATTACHED_REFS = 4

/**
 * 提取 frontmatter 标量摘要。只认文件**开头**的 `---` 围栏块。
 *
 * 口径：只收 `key: value` 标量（value 单行）；`key:` 后为空的（嵌套对象/数组起始）
 * 跳过；数组形式的 `key: [a, b]` 原样收一行。无 frontmatter 或未闭合返回空数组。
 */
export function parseFrontmatter(raw: string): string[] {
  const text = String(raw ?? '')
  if (!text.startsWith('---')) return []
  const lines = text.split(/\r?\n/)
  // 第 0 行是开围栏，从第 1 行找闭合
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end === -1) return []
  const out: string[] = []
  for (let i = 1; i < end; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line)
    if (!m) continue
    const value = m[2].trim()
    if (!value) continue
    out.push(`${m[1]}=${value}`)
  }
  return out
}

/**
 * 标题骨架：摘出 `^#{1,6}\s` 开头的行（保留 `#` 号与文字）。
 * frontmatter 块内的行不参与（否则 `#` 注释会被误收）。
 */
export function extractHashes(raw: string): string[] {
  const text = String(raw ?? '')
  const fmEnd = frontmatterEndIndex(text)
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (let i = fmEnd; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s+/.test(line)) out.push(line.trim())
  }
  return out
}

/**
 * 首段：跳过 frontmatter、标题行、空行、以及代码围栏行，
 * 取第一段连续正文（遇到空行或下一个标题即止）。
 */
export function extractFirstPara(raw: string): string {
  const text = String(raw ?? '')
  const fmEnd = frontmatterEndIndex(text)
  const lines = text.split(/\r?\n/)
  const buf: string[] = []
  let started = false
  let inFence = false
  for (let i = fmEnd; i < lines.length; i++) {
    const line = lines[i]
    // 围栏块整体跳过（含围栏行与其中内容）——不能只跳围栏行，否则块内代码被当成正文首段
    if (/^```/.test(line.trim())) { inFence = !inFence; if (started) break; continue }
    if (inFence) continue
    const isHeading = /^#{1,6}\s+/.test(line)
    if (isHeading) { if (started) break; continue }
    if (!line.trim()) { if (started) break; continue }
    started = true
    buf.push(line.trim())
  }
  return buf.join(' ')
}

/** frontmatter 闭合行之后的行号（无 frontmatter 返回 0） */
function frontmatterEndIndex(text: string): number {
  if (!text.startsWith('---')) return 0
  const lines = text.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return i + 1
  }
  return 0
}

/** 按字符上限截断，超限时尾部补省略号（省略号计入总长） */
function clampTail(s: string, limit: number): string {
  const src = String(s ?? '')
  if (limit <= 0) return ''
  if (src.length <= limit) return src
  if (limit <= 1) return src.slice(0, limit)
  return src.slice(0, limit - 1) + '…'
}

/**
 * 组装单篇骨架。
 *
 * 截断顺序（**硬上限是总字符，不是每段独立**）：超限时按
 * 「首段尾部 → 标题骨架尾部 → frontmatter 尾部」逆序砍，
 * **标题行（首行）永远保留** —— 它是最高价值信息。
 *
 * 幂等：同输入必定同输出（不打散 prompt cache，铁律 17）。
 */
export function buildRefSkeleton(input: RefInput): RefSkeleton {
  const title = String(input?.title ?? '').trim()
  const raw = String(input?.raw ?? '')
  const frontmatter = raw ? parseFrontmatter(raw) : []
  const hashes = raw ? extractHashes(raw) : []
  const firstPara = raw ? extractFirstPara(raw) : ''

  const headText = clampTail(hashes.join('\n'), REF_SKELETON_HEAD_LIMIT)
  const paraText = clampTail(firstPara, REF_SKELETON_PARA_LIMIT)

  const parts: string[] = []
  if (frontmatter.length > 0) parts.push(`frontmatter: ${frontmatter.join('; ')}`)
  if (headText) parts.push(`标题骨架:\n${headText}`)
  if (paraText) parts.push(`首段: ${paraText}`)

  let text = parts.join('\n')
  if (text.length > REF_SKELETON_TOTAL_LIMIT) {
    // 逆序砍：先砍首段，再砍标题骨架尾部，最后才动 frontmatter；标题首行始终在
    const budget = REF_SKELETON_TOTAL_LIMIT
    const fmLine = frontmatter.length > 0 ? `frontmatter: ${frontmatter.join('; ')}` : ''
    const headLines = headText ? headText.split('\n') : []
    const firstHead = headLines[0] ?? ''

    // ① 只留 frontmatter + 标题首行
    const minimal = [fmLine, firstHead ? `标题骨架:\n${firstHead}` : ''].filter(Boolean).join('\n')
    if (minimal.length >= budget) {
      // ② 连最小集都超：优先保标题首行，再砍 frontmatter 尾部
      const headOnly = firstHead ? `标题骨架:\n${firstHead}` : ''
      if (headOnly.length >= budget) {
        text = clampTail(headOnly, budget)
      } else {
        const room = budget - headOnly.length - 1
        const fmClamped = clampTail(fmLine, Math.max(0, room))
        text = [fmClamped, headOnly].filter(Boolean).join('\n')
      }
    } else {
      // ③ 在最小集基础上，把余量还给首段（不给标题骨架——标题已保住首行）
      const room = budget - minimal.length - 1
      const paraClamped = room > 8 ? clampTail(paraText, room) : ''
      text = [minimal, paraClamped ? `首段: ${paraClamped}` : ''].filter(Boolean).join('\n')
    }
  }

  return { title, frontmatter, hashes, firstPara, text }
}

/**
 * 组装多篇注入段（供 `buildSystemPrompt` 调用）。
 *
 * 逐篇 `buildRefSkeleton` 拼接，**总预算 ≤ ATTACHED_INJECTION_LIMIT**：
 * 超限时从**末篇**开始丢整篇（不切半篇——半篇骨架会误导模型），
 * 保留的篇目按原顺序。零篇返回空串（调用方据此退回现状行为）。
 */
export function buildAttachedRefsInjection(refs: readonly RefInput[]): string {
  const list = Array.isArray(refs) ? refs : []
  if (list.length === 0) return ''
  const header = '【附加笔记骨架】用户为本轮对话引用了以下知识库笔记（正文未全量注入）：'
  const footer = '以上仅为骨架摘要；需要全文时用文件读取工具按 path 读取。'

  const blocks: string[] = []
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const sk = buildRefSkeleton(r)
    const lines: string[] = [`— ${i + 1}. 《${sk.title || r.path}》（${r.path}）`]
    if (sk.text) lines.push(sk.text.split('\n').map((l) => `  ${l}`).join('\n'))
    blocks.push(lines.join('\n'))
  }

  // 从末篇开始丢，直到 header + 保留块 + footer 落进预算
  let kept = blocks.slice()
  const sizeOf = (bs: string[]) => [header, ...bs, footer].join('\n\n').length
  while (kept.length > 0 && sizeOf(kept) > ATTACHED_INJECTION_LIMIT) kept.pop()

  const omitted = list.length - kept.length
  // 全丢光但确实有引用：不能返回空串（调用方会当「无引用」退回现状 → 用户引用的文件被静默忽略）。
  // 返回「只报篇数 + 提示按需读取」的最小形态，保证引用事实不丢。
  if (kept.length === 0) {
    const minimal = list.map((r) => `— 《${r.title || r.path}》（${r.path}）`).join('\n')
    const text = [header, minimal, footer].join('\n\n')
    return text.length <= ATTACHED_INJECTION_LIMIT ? text : header + '\n' + footer
  }

  const tail = omitted > 0 ? `\n（另 ${omitted} 篇因预算上限未展开，可按需用文件读取工具读取）` : ''
  return [header, ...kept, footer + tail].join('\n\n')
}
