/**
 * 段会话错题回流纯函数（零依赖，Node 契约脚本可直接 import）。
 *
 * 要解决的问题：答题记录（`.knowbase/modules/quiz/records.json`）知道哪题答错，
 * 结课报告也统计错题，但**段会话本身不知道**——讲到同一知识点时不会回头补。
 *
 * 归属口径（不按标题模糊匹配）：
 *   题单由 `archiveOrganizedPage` 写进**本段产物夹**（`resolveWriteOwnerRel`：段层
 *   `AI教学/{工作区}/第N章 章名/段N`，支线夹在其下 `支线·{标题}/`），因此
 *   **页面仓库相对路径落在 `ownerRel + '/'` 前缀下**即属本段；
 *   页面 id = frontmatter `id`，缺省回退知识索引同口径的 `auto:<仓库相对路径>`。
 *
 * 输出只取 `lastResult === 0`（最近一次作答答错）的题，按 `updated_at` 时间倒序取最近 N 条；
 * 无错题 → 空串（调用方据此完全跳过，注入逐字不变）。
 */

/** 请求级注入标题（逐字；契约脚本锁定） */
export const SEGMENT_WRONG_HEADER = '【本段错题（答错过的题，讲到这里时优先回头补）】'

/** 默认只列最近 5 条（更旧的错题意义衰减，且每轮都进上下文） */
export const SEGMENT_WRONG_MAX_ITEMS = 5

/** 整块（含标题）字数上限：超了从最旧的丢 */
export const SEGMENT_WRONG_MAX_CHARS = 600

/** 题干截断上限（含省略号） */
export const SEGMENT_WRONG_QUESTION_MAX = 40

/** 知识点 / 题单标签截断上限 */
export const SEGMENT_WRONG_LABEL_MAX = 14

/** 答案 / 解析截断上限 */
export const SEGMENT_WRONG_ANSWER_MAX = 28

/** 本段候选题单页（主进程扫描本段产物夹得出；`relPath` 是仓库相对路径，正斜杠） */
export interface SegmentQuizPage {
  pageId: string
  relPath?: string
  /** 题单标题（缺省由调用方给文件名去 `.md`） */
  title?: string
}

/** 作答记录投影（`VaultQuizRecordRow` 的零依赖子集；快照按 JSON 串传入，解析容错在纯函数内） */
export interface SegmentQuizRecord {
  pageId: string
  quizNo?: number
  pageTitle?: string
  lastResult?: number | null
  updatedAt?: string
  snapshotJson?: string
}

export interface SegmentWrongItem {
  pageId: string
  quizNo: number
  label: string
  question: string
  answer: string
  updatedAt: string
}

interface SnapshotLoose {
  type?: string
  question?: string
  options?: Array<{ key?: string; text?: string }>
  answer?: string
  explanation?: string
  referenceAnswer?: string
}

function charLen(s: string): number {
  return Array.from(s).length
}

/** 按字符（code point）截断，超长时末位换成 `…`，保证结果 ≤ max */
function clipRaw(raw: unknown, max: number): string {
  const s = String(raw ?? '')
  const n = Math.max(0, Math.floor(Number(max) || 0))
  if (!n) return ''
  const chars = Array.from(s)
  return chars.length <= n ? s : chars.slice(0, Math.max(0, n - 1)).join('') + '…'
}

/** 单行文本截断：折叠空白后按字符截断 */
export function clipText(raw: unknown, max: number): string {
  return clipRaw(String(raw ?? '').replace(/\s+/g, ' ').trim(), max)
}

/** 仓库相对路径归一：反斜杠转正斜杠、去首尾斜杠 */
export function normalizeRelPath(raw: unknown): string {
  return String(raw ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/** 归属判定：页面相对路径必须落在本段产物夹前缀下（`段1` 不匹配 `段10`，也不匹配兄弟段） */
export function pageBelongsToSegment(relPath: unknown, ownerRel: unknown): boolean {
  const rel = normalizeRelPath(relPath)
  const owner = normalizeRelPath(ownerRel)
  if (!rel || !owner) return false
  return rel.startsWith(`${owner}/`)
}

/** 只保留本段产物夹内的题单页（跨段 / 无路径的一律不算） */
export function filterSegmentQuizPages(pages: SegmentQuizPage[], ownerRel: unknown): SegmentQuizPage[] {
  const list = Array.isArray(pages) ? pages : []
  return list.filter((p) => !!p && typeof p === 'object' && !!p.pageId && pageBelongsToSegment(p.relPath, ownerRel))
}

function parseSnapshot(raw: unknown): SnapshotLoose | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const v = JSON.parse(raw) as SnapshotLoose
    if (!v || typeof v !== 'object') return null
    return v
  } catch {
    return null
  }
}

/**
 * 解析首句（不带句末标点堆叠）：中文句号 / 问号 / 叹号 / 分号 / 换行都算断句。
 *
 * ASCII `.` 只在**句末**才算：后跟空白或行尾，且不是常见缩写（Dr. / e.g. / etc. …）。
 * 不能直接按 `.` 切 —— 否则 `1.5` 变 `1`、`https://a.b/c` 变 `https://a`、`Dr. Smith` 变 `Dr`。
 */
const DOT_ABBREVIATION = /(?:^|[\s(])(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i

function firstSentence(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const re = /[。．!！?？；;\n]|\.(?=\s|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '.' && DOT_ABBREVIATION.test(s.slice(0, m.index + 1))) continue
    return s.slice(0, m.index).trim()
  }
  return s.trim()
}

function pageLabel(page: SegmentQuizPage | undefined, record: SegmentQuizRecord | undefined): string {
  const raw = String(page?.title || record?.pageTitle || '').replace(/\.md$/i, '')
  // 题单文件名常是「测验·知识点」：去掉前缀当知识点标签，短、好认
  const cleaned = raw.replace(/^\s*测验\s*[·・\-–—]\s*/, '').trim()
  return clipText(cleaned || '本段题单', SEGMENT_WRONG_LABEL_MAX)
}

/** 优先给正确答案（选择题带选项文本 / 简答题给参考答案），拿不到才退回解析首句 */
function answerTextOf(snap: SnapshotLoose | null): string {
  if (!snap) return ''
  const reference = String(snap.referenceAnswer ?? '').trim()
  const key = String(snap.answer ?? '').trim()
  if (reference && (snap.type === 'short' || !key)) {
    return `参考答案：${clipText(firstSentence(reference), SEGMENT_WRONG_ANSWER_MAX)}`
  }
  if (key) {
    const options = Array.isArray(snap.options) ? snap.options : []
    const hit = options.find((o) => String(o?.key ?? '').trim().toUpperCase() === key.toUpperCase())
    // 快照里的 answer 不在选项 key 里（旧数据 / 模型写错）：不要硬写「正确答案：Z」，退回参考答案 / 解析
    if (hit) {
      const optText = clipText(hit.text, 18)
      return `正确答案：${key}${optText ? `. ${optText}` : ''}`
    }
  }
  if (reference) return `参考答案：${clipText(firstSentence(reference), SEGMENT_WRONG_ANSWER_MAX)}`
  const exp = firstSentence(snap.explanation)
  return exp ? `解析：${clipText(exp, SEGMENT_WRONG_ANSWER_MAX)}` : ''
}

export interface SegmentWrongInput {
  pages?: SegmentQuizPage[]
  records?: SegmentQuizRecord[]
  /** 本段产物夹相对路径；给了就必须通过归属判定（跨段同名题单不算） */
  ownerRel?: string
  maxItems?: number
  maxChars?: number
}

/**
 * 挑出本段最近答错的题（时间倒序，最多 N 条）。
 * 只认 `lastResult === 0`；`lastResult` 为 null（从没作答过）/ 1（最近答对）一律不算。
 */
export function collectSegmentWrongItems(input?: SegmentWrongInput): SegmentWrongItem[] {
  const pages = Array.isArray(input?.pages) ? input!.pages! : []
  const records = Array.isArray(input?.records) ? input!.records! : []
  const owner = normalizeRelPath(input?.ownerRel)
  const byId = new Map<string, SegmentQuizPage>()
  for (const p of pages) {
    if (p && typeof p === 'object' && p.pageId) byId.set(String(p.pageId), p)
  }
  const limit = Math.max(0, Math.floor(Number(input?.maxItems ?? SEGMENT_WRONG_MAX_ITEMS) || 0))
  if (!limit) return []

  const items: SegmentWrongItem[] = []
  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    const pageId = String(r.pageId ?? '')
    const page = byId.get(pageId)
    if (!page) continue
    // 归属：给了 owner 就必须落在本段产物夹内（防跨段同名题单被算进来）
    if (owner && !pageBelongsToSegment(page.relPath, owner)) continue
    if (r.lastResult !== 0) continue
    const snap = parseSnapshot(r.snapshotJson)
    items.push({
      pageId,
      quizNo: Math.max(0, Math.floor(Number(r.quizNo) || 0)),
      label: pageLabel(page, r),
      question: clipText(snap?.question, SEGMENT_WRONG_QUESTION_MAX) || '（题干未留存）',
      answer: answerTextOf(snap),
      updatedAt: String(r.updatedAt ?? ''),
    })
  }
  items.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    if (a.pageId !== b.pageId) return a.pageId < b.pageId ? -1 : 1
    return a.quizNo - b.quizNo
  })
  return items.slice(0, limit)
}

/**
 * 渲染请求级注入块。无错题 → 空串（调用方必须让 system 与请求级逐字保持现状）。
 * 超 `maxChars` 时从**最旧**的条目开始丢（不是截中间），只留最近几条。
 */
export function renderSegmentWrongRequestBlock(input?: SegmentWrongInput): string {
  const items = collectSegmentWrongItems(input)
  if (!items.length) return ''
  const rawMax = Number(input?.maxChars ?? SEGMENT_WRONG_MAX_CHARS)
  const maxChars = Math.max(charLen(SEGMENT_WRONG_HEADER) + 1, Math.floor(Number.isFinite(rawMax) && rawMax > 0 ? rawMax : SEGMENT_WRONG_MAX_CHARS))

  // 题号缺失（旧记录 quizNo 为 0）时不显示「第0题」，直接省略题号
  const lines = items.map((it) => `- ${it.label}${it.quizNo > 0 ? ` · 第${it.quizNo}题` : ''}：${it.question}${it.answer ? ` → ${it.answer}` : ''}`)
  const blockOf = (ls: string[]): string => [SEGMENT_WRONG_HEADER, ...ls].join('\n')
  while (lines.length > 1 && charLen(blockOf(lines)) > maxChars) lines.pop()
  const block = blockOf(lines)
  return charLen(block) <= maxChars ? block : clipRaw(block, maxChars)
}
