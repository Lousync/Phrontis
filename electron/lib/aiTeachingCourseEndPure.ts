/**
 * AI教学 · 结课 / 资料沉淀 —— 纯函数与类型（**零 fs / electron / 第三方依赖**，契约脚本直接 import）。
 *
 * 主进程实现（读盘 / 复制 / 建页 / IPC）在 `aiTeachingCourseEnd.ts`。
 * 本文件只做：产物分类、盘点、报告文本、目标路径推导、名称清洗。
 */

export type EndArtifactGroup = 'review' | 'lecture' | 'summary' | 'mindmap' | 'visual'
export type EndArtifactKind = 'md' | 'json' | 'html'

/** 选择页 / 流程第 2 步的候选产物；id 直接用工作区相对路径（稳定、可读、无需 hash） */
export interface EndArtifact {
  id: string
  group: EndArtifactGroup
  title: string
  relInWs: string
  chapterRel: string | null
  kind: EndArtifactKind
  sizeBytes: number
}

/** 暂存清单条目（`.manifest.json`） */
export interface StagingEntry {
  id: string
  group: EndArtifactGroup
  title: string
  /** 课程原件（工作区相对路径，不随工作区改名失效） */
  sourceRelInWs: string
  /** 暂存副本（工作区相对路径） */
  stageRelInWs: string
  /** 章目录段（`第3章 进程`）；无章归属为 null */
  chapterRel: string | null
  kind: EndArtifactKind
  /** 字节数 */
  size: number
}

export interface StagingManifest {
  v: 1
  wsId: string
  createdAt: string
  entries: StagingEntry[]
}

/** 沉淀目标（名称，不含路径；路径由主进程解析） */
export interface EndTarget {
  space: string
  notebook: string
  /** 笔记本下的子文件夹；空串 = 直接放笔记本根 */
  subfolder: string
  keepChapter: boolean
}

/** 沉淀清单（`.knowbase/modules/aiTeaching/deposits.json`） */
export interface DepositRecord {
  pageId: string
  targetRel: string
  kind: EndArtifactKind
  depositedAt: string
}

export interface DepositWorkspaceRecord {
  lastTarget: EndTarget | null
  /** 按课程产物的工作区相对路径幂等 */
  entries: Record<string, DepositRecord>
}

export interface DepositFile {
  v: 1
  workspaces: Record<string, DepositWorkspaceRecord>
}

export const STAGING_FOLDER_NAME = '待整理'
export const STAGING_MANIFEST_FILE = '.manifest.json'
export const END_REPORT_FILE = '结课报告.md'
export const DEFAULT_SUBFOLDER = '结课资料'

export const GROUP_FOLDER_NAME: Record<EndArtifactGroup, string> = {
  review: '章末复习',
  lecture: '段讲义',
  summary: '阶段总结',
  mindmap: '思维导图',
  visual: '示意图',
}

export const GROUP_LABEL: Record<EndArtifactGroup, string> = {
  review: '章末复习讲义',
  lecture: '段讲义',
  summary: '阶段总结',
  mindmap: '思维导图',
  visual: '示意图',
}

const GROUP_ORDER: Record<EndArtifactGroup, number> = { review: 1, lecture: 2, summary: 3, mindmap: 4, visual: 5 }

const EXCLUDED_DIRS = new Set(['sources', '待整理', '_templates', 'node_modules', '教材', '_extracts'])
const STRUCT_FILES = new Set(['课程.md', 'constraints.md', 'profile.md', 'source.md', '交接.md', '.session.json'])

/** 当前文件名上方的目录段（去掉文件名） */
function dirSegments(relInWs: string): string[] {
  const parts = String(relInWs ?? '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(0, -1)
}

function baseName(relInWs: string): string {
  const parts = String(relInWs ?? '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

/** `第3章 进程` → 3；无法解析返回 null */
export function chapterNumberOf(segment: string | null | undefined): number | null {
  const m = /^第(\d+)章[\s·:：.．\-—_]/u.exec(String(segment ?? ''))
  return m ? Number(m[1]) : null
}

/** 产物所属章目录（第一个 `第N章 …` 段）；无章归属返回 null */
export function chapterRelOf(relInWs: string): string | null {
  for (const seg of dirSegments(relInWs)) {
    if (chapterNumberOf(seg) !== null) return seg
  }
  return null
}

/**
 * 单文件分类。
 * 明确排除：素材（SOURCES）/ 暂存区 / 模板 / 结构文件 / 结课报告 / 隐藏目录。
 * `quiz` 单独返回：不进候选，但计入「留在课程内」与错题统计。
 */
export function classifyArtifact(relInWs: string): EndArtifactGroup | 'quiz' | 'excluded' {
  const rel = String(relInWs ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel) return 'excluded'
  const segs = rel.split('/').filter(Boolean)
  if (!segs.length) return 'excluded'
  for (const seg of segs.slice(0, -1)) {
    if (seg.startsWith('.')) return 'excluded'
    if (EXCLUDED_DIRS.has(seg)) return 'excluded'
    if (EXCLUDED_DIRS.has(seg.toLowerCase())) return 'excluded'
  }
  const name = segs[segs.length - 1]
  if (name.startsWith('.')) return 'excluded'
  if (STRUCT_FILES.has(name) || STRUCT_FILES.has(name.toLowerCase())) return 'excluded'
  if (/^结课报告(·.*)?\.md$/i.test(name)) return 'excluded'
  const ext = extOf(name)
  const dirs = segs.slice(0, -1)
  if (ext === 'md' && /^测验[·-]/.test(name)) return 'quiz'

  if (ext === 'md' && /^复习讲义.*\.md$/i.test(name) && dirs.includes('章末复习')) return 'review'
  if (ext === 'md' && /^讲义·.*\.md$/.test(name) && dirs.some((s) => /^段\d+$/.test(s))) return 'lecture'
  if (ext === 'md' && /^总结[·-]?.*\.md$/.test(name) && (dirs.some((s) => /^段\d+$/.test(s)) || dirs.includes('课程助手') || dirs.some((s) => chapterNumberOf(s) !== null))) return 'summary'
  if (ext === 'json' && dirs.includes('mindmaps')) return 'mindmap'
  if (ext === 'html' && dirs.includes('visuals')) return 'visual'
  return 'excluded'
}

function kindOf(relInWs: string): EndArtifactKind {
  const ext = extOf(baseName(relInWs))
  if (ext === 'json') return 'json'
  if (ext === 'html') return 'html'
  return 'md'
}

/** 文件名去扩展名作为展示标题（目录信息靠路径行表达，不加前缀标签） */
export function artifactTitle(relInWs: string): string {
  return baseName(relInWs).replace(/\.[A-Za-z0-9]+$/, '')
}

/**
 * 盘点：由「路径 + 字节数」列表生成候选产物。
 * 排序：章号 → 组 → 文件名（无章归属排最后）。
 */
export function buildArtifactInventory(entries: ReadonlyArray<{ relInWs: string; sizeBytes: number }>): EndArtifact[] {
  const out: EndArtifact[] = []
  for (const e of entries) {
    const rel = String(e.relInWs ?? '').replace(/\\/g, '/')
    const group = classifyArtifact(rel)
    if (group === 'excluded' || group === 'quiz') continue
    out.push({
      id: rel,
      group,
      title: artifactTitle(rel),
      relInWs: rel,
      chapterRel: chapterRelOf(rel),
      kind: kindOf(rel),
      sizeBytes: Math.max(0, Number(e.sizeBytes) || 0),
    })
  }
  return out.sort((a, b) => {
    const ca = chapterNumberOf(a.chapterRel) ?? 9999
    const cb = chapterNumberOf(b.chapterRel) ?? 9999
    if (ca !== cb) return ca - cb
    const ga = GROUP_ORDER[a.group]
    const gb = GROUP_ORDER[b.group]
    if (ga !== gb) return ga - gb
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
  })
}

export function countArtifacts(entries: ReadonlyArray<EndArtifact>): number {
  return entries.length
}

export function countQuizDocs(relPaths: ReadonlyArray<string>): number {
  return relPaths.filter((r) => classifyArtifact(r) === 'quiz').length
}

/** 暂存副本路径：`待整理/{组}/{章?}/{文件名}` */
export function stagingRelFor(group: EndArtifactGroup, relInWs: string): string {
  const chapter = chapterRelOf(relInWs)
  const name = baseName(relInWs)
  const parts = [STAGING_FOLDER_NAME, GROUP_FOLDER_NAME[group]]
  if (chapter) parts.push(chapter)
  parts.push(name)
  return parts.join('/')
}

/** 目标文件夹段清洗：非法字符→空格、折叠空白、截 40、去尾点尾空格；非法返回空串 */
export function sanitizeTargetSegment(v: unknown): string {
  const cleaned = String(v ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .replace(/[. ]+$/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return ''
  return cleaned
}

/**
 * 目标路径（仓库相对）：`空间/笔记本/子文件夹/[章目录/]文件名`。
 * 空段自动跳过（子文件夹可空 = 直接放笔记本根）。
 */
export function depositTargetRel(target: EndTarget, entry: Pick<StagingEntry, 'stageRelInWs' | 'chapterRel'>): string {
  const space = sanitizeTargetSegment(target.space)
  const notebook = sanitizeTargetSegment(target.notebook)
  const sub = sanitizeTargetSegment(target.subfolder)
  const parts = [space, notebook]
  if (sub) parts.push(sub)
  if (target.keepChapter && entry.chapterRel) {
    const chapter = sanitizeTargetSegment(entry.chapterRel)
    if (chapter) parts.push(chapter)
  }
  parts.push(baseName(entry.stageRelInWs))
  return parts.filter(Boolean).join('/')
}

/** 暂存清单条目（盘点结果 → 复制计划） */
export function toStagingEntry(a: EndArtifact): StagingEntry {
  return {
    id: a.id,
    group: a.group,
    title: a.title,
    sourceRelInWs: a.relInWs,
    stageRelInWs: stagingRelFor(a.group, a.relInWs),
    chapterRel: a.chapterRel,
    kind: a.kind,
    size: a.sizeBytes,
  }
}

/** 报告归档名：`结课报告·YYYY-MM-DD-HHmm.md`（本地时间） */
export function reportArchiveName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `结课报告·${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.md`
}

/** 报告 frontmatter + 正文（人读档案；不写 id，AI教学根不进知识索引） */
export function renderCourseEndReport(input: EndReportInput): string {
  const fm = [
    '---',
    `title: ${oneLine(input.courseName)} · 结课报告`,
    `course: ${oneLine(input.courseName)}`,
    `endedAt: ${input.endedAt}`,
    '---',
    '',
  ]
  return fm.join('\n') + renderCourseEndReportBody(input)
}

export interface EndReportQuizSummary {
  quizzes: number
  avgScore: number
  wrong: number
  topTags: string[]
}

export interface EndReportDeposit {
  deposited: number
  targetRel: string | null
  kept: number
}

export interface EndReportInput {
  courseName: string
  /** 课程创建时间（ISO）；缺省时学习跨度只显示结课日 */
  startedAt: string | null
  endedAt: string
  chapters: number
  total: number
  learned: number
  segments: number
  endedSegments: number
  openSegments: number
  quizzes: EndReportQuizSummary | null
  /** 未学完 / 未展开的章名 */
  missingChapters: string[]
  deposit: EndReportDeposit
}

function oneLine(v: unknown): string {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim()
}

function dayOf(iso: string | null | undefined): string {
  const s = String(iso ?? '')
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

function daysBetween(startIso: string | null, endIso: string): number | null {
  const a = Date.parse(String(startIso ?? ''))
  const b = Date.parse(endIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const days = Math.floor((b - a) / 86400000)
  return days >= 0 ? days : null
}

export function renderCourseEndReportBody(input: EndReportInput): string {
  const start = dayOf(input.startedAt)
  const end = dayOf(input.endedAt)
  const days = daysBetween(input.startedAt, input.endedAt)
  const span = start && end ? `${start} – ${end}${days !== null ? `（${days} 天）` : ''}` : end || '—'
  const coverage = `${input.chapters} 章 / ${input.learned}/${input.total} 个知识点 / ${input.segments} 个学习段`
  const lines: string[] = []
  lines.push(`# ${oneLine(input.courseName)} · 结课报告`, '')
  lines.push('## 基本情况')
  lines.push(`- 学习跨度：${span}`)
  lines.push(`- 覆盖范围：${coverage}`)
  if (input.quizzes && input.quizzes.quizzes > 0) {
    lines.push(`- 测验：${input.quizzes.quizzes} 次，平均 ${input.quizzes.avgScore} 分；${input.quizzes.wrong} 道错题`)
  } else {
    lines.push('- 测验：—')
  }
  if (input.openSegments > 0) lines.push(`- 未收尾段：${input.openSegments} 个（课程保持只读，重新开课可继续）`)
  lines.push('')

  lines.push('## 复盘')
  if (input.learned >= input.total && input.total > 0) {
    lines.push('- 完成情况：全部知识点已学完，章末复习讲义已生成。')
  } else {
    lines.push(`- 完成情况：已学 ${input.learned}/${input.total} 个知识点。`)
  }
  if (input.missingChapters.length) {
    lines.push(`- 尚未展开：${input.missingChapters.map(oneLine).join('、')}`)
  }
  if (input.quizzes && input.quizzes.quizzes > 0) {
    if (input.quizzes.topTags.length) lines.push(`- 错题集中：${input.quizzes.topTags.map(oneLine).join('、')}（共 ${input.quizzes.wrong} 道）`)
    else lines.push(`- 错题：${input.quizzes.wrong} 道，暂无标签归类。`)
    lines.push('- 建议：二轮先做错题集中章节的专项，再回看章末复习讲义。')
  } else {
    lines.push('- 建议：先完成一轮章末复习，再按错题分布安排二轮。')
  }
  lines.push('')

  lines.push('## 资料处置')
  if (input.deposit.deposited > 0 && input.deposit.targetRel) {
    lines.push(`- 已沉淀：${input.deposit.deposited} 份 → ${input.deposit.targetRel}`)
  } else {
    lines.push('- 已沉淀：未沉淀')
  }
  lines.push(`- 留在课程内：${input.deposit.kept} 份（题单与错题本，答题记录不迁移）`)
  lines.push('')
  return lines.join('\n')
}

/** 预览用摘要：取 `## 复盘` 的第一条非空内容；没有则退回 `已沉淀 N 份`（调用方传 fallback） */
export function extractReportSummary(markdown: string, fallback = ''): string {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n')
  const section = /^##\s*复盘\s*$/m.exec(text)
  if (!section) return fallback
  const rest = text.slice(section.index + section[0].length)
  const next = /^##\s+/m.exec(rest)
  const body = (next ? rest.slice(0, next.index) : rest)
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
  const first = body[0] ?? ''
  return first ? first.replace(/\*\*/g, '') : fallback
}

/** 完课判定用的完成度文案（`64/140 · 5/12`，界面只读数据，不加解释） */
export function completionText(learned: number, total: number, reviewsDone: number, chapters: number): string {
  return `${learned}/${total} · ${reviewsDone}/${chapters}`
}
