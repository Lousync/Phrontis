/**
 * AI 教学重构 · 共享类型（P0 冻结面）
 *
 * 为什么单独一个文件：本次重构横跨素材 / 产物 / 大纲 / 模型 / 教学台账 / 查看器六条线，
 * 五条并行开发线都要引用同一批结构。**本文件只由集成方维护**，并行开发线只读不写，
 * 避免同文件并行编辑互相覆盖（AGENTS.md 铁律 21）。
 *
 * 约定：
 * - 纯类型 + 常量，零 import、零运行时副作用；可被 stripTypeScriptTypes 后直接 import；
 * - 不使用 enum / namespace / 装饰器（strip 模式不支持）；
 * - 所有字段可选者都显式写 `?`，不做隐式约定。
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2
 */

/* ============================== 素材 ============================== */

export type SourceKind = 'file' | 'dir' | 'url' | 'note' | 'chat' | 'quiz'

export type SourceMediaType =
  | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'epub'
  | 'md' | 'txt' | 'code' | 'html' | 'image' | 'other'

export type IngestStatus =
  | 'indexed' | 'queued' | 'parsing' | 'ready' | 'partial' | 'failed' | 'stale'

export type TextLayer = 'text' | 'partial' | 'empty'

/** 素材内的定位锚点：页区间 / 章节标签 / 字符区间 / 工作表 */
export interface SourceAnchor {
  kind: 'page' | 'chapter' | 'heading' | 'char' | 'sheet'
  from?: number
  to?: number
  label?: string
}

export interface SourceOutlineItem {
  label: string
  level?: number
  page?: number
  anchor?: SourceAnchor
}

export interface SourceIngestState {
  status: IngestStatus
  engine?: string
  /** 引擎签名（版本 + 参数指纹）；缓存键的第二段 */
  engineSig?: string
  pages?: number
  chars?: number
  textLayer?: TextLayer
  outline?: SourceOutlineItem[]
  /** A8：需要视觉转写的页 */
  needsOcr?: number[]
  warnings?: string[]
  updatedAt?: string
}

export interface SourceAssignment {
  chapterId: string
  unitIds?: string[]
  anchor?: SourceAnchor
}

export interface SourceEntryV2 {
  id: string
  title: string
  kind: SourceKind
  mediaType: SourceMediaType
  /** 仓库内相对路径（原件或引用） */
  rel?: string
  /** 仓库外来源；`absPath` 只在主进程存在，绝不下发渲染层 */
  external?: { absPath: string; copiedRel?: string }
  url?: string
  contentHash?: string
  size?: number
  mtimeMs?: number
  ingest: SourceIngestState
  assignments: SourceAssignment[]
  defaultAnchor?: SourceAnchor
  /** v1 兼容字段：只读，不再新写 */
  type?: string
  extractRel?: string | null
  extracts?: Array<{
    rel: string
    anchor: SourceAnchor
    textLayer?: string
    chars?: number
    createdAt: string
  }>
}

export interface SourcesFileV2 {
  v: 2
  sources: SourceEntryV2[]
}

/** 解析缓存里的页 / 块结构（structure.json） */
export interface SourceBlock {
  t: 'h' | 'p' | 'li' | 'table' | 'code' | 'img'
  text?: string
  page?: number
  assetId?: string
}

export interface SourcePage {
  n: number
  startChar: number
  endChar: number
  blocks: SourceBlock[]
}

export interface SourceStructure {
  v: 1
  pages: SourcePage[]
  assets: Array<{ id: string; path: string; page?: number }>
}

/** 解析缓存元信息（meta.json） */
export interface SourceCacheMeta {
  engine: string
  engineSig: string
  createdAt: string
  textLayer: TextLayer
  needsOcr: number[]
  warnings: string[]
  pages: number
  chars: number
}

/* ============================== 产物 ============================== */

export type ArtifactKind =
  | 'handoff' | 'note' | 'lecture' | 'quiz' | 'review'
  | 'visual' | 'mindmap' | 'image' | 'knowledgecard' | 'lessonplan'

/** 命名作用域：段 / 章末复习 / 课程助手 */
export type ArtifactScope = 'segment' | 'review' | 'assistant'

export interface ArtifactRow {
  id: string
  kind: ArtifactKind
  title: string
  /** 仓库相对路径 */
  rel: string
  chapterId?: string
  unitIds?: string[]
  /** `01-01` / `01` / `00` */
  segmentKey?: string
  createdAt: string
  updatedAt: string
}

export interface ArtifactsFile {
  v: 1
  workspaces: Record<string, ArtifactRow[]>
}

/* ============================== 大纲 ============================== */

export type UnitType = 'memory' | 'concept' | 'procedure' | 'design'

export interface UnitRow {
  id: string
  name: string
  goal: string
  source: string
  type: UnitType
  /** 先修知识点 id */
  requires: string[]
  /** 第 7 列及以后：原样保留，不动 */
  extra: string[]
}

export interface ChapterBlock {
  id: string
  name: string
  /** 「章目标」行；空串 = 未写 */
  objective: string
  units: UnitRow[]
}

export interface CourseOutlineV2 {
  title: string
  goal: string
  anchor: string
  chapters: ChapterBlock[]
}

export type OutlineDiffOp =
  | { op: 'add-chapter'; chapterId: string; name: string }
  | { op: 'remove-chapter'; chapterId: string; name: string }
  | { op: 'rename-chapter'; chapterId: string; from: string; to: string }
  | { op: 'add-unit'; unitId: string; chapterId: string; name: string }
  | { op: 'remove-unit'; unitId: string; chapterId: string; name: string }
  | { op: 'rename-unit'; unitId: string; from: string; to: string }
  | { op: 'move-unit'; unitId: string; fromChapterId: string; toChapterId: string }
  | { op: 'retype-unit'; unitId: string; from: UnitType; to: UnitType }
  | { op: 'requires-change'; unitId: string; from: string[]; to: string[] }
  | { op: 'reorder-units'; chapterId: string }

export interface OutlineValidationIssue {
  code:
    | 'unit-empty-name' | 'bad-type' | 'requires-missing'
    | 'requires-cycle' | 'requires-self' | 'duplicate-unit-id'
  chapterId?: string
  unitId?: string
  detail?: string
}

/* ============================== 模型 ============================== */

export type CapabilityState = 'auto' | 'yes' | 'no'

export type CapabilityKey = 'tools' | 'vision' | 'json' | 'imageGeneration' | 'imageEdit' | 'reasoning'

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high'

export interface ModelEntry {
  id: string
  name: string
  providerId: string
  accountId?: string
  modelId: string
  contextWindow?: number
  maxOutputTokens?: number
  /**
   * 思考（推理）能力判定**以 `capabilities.reasoning` 为准**（三态链：条目显式 → 内置表 → 名称正则）。
   * `supported` 仅兼容旧数据 / 旧读取方：保存条目时由 `capabilities.reasoning === 'yes'` 派生写入，
   * 不要再把它当判定来源（`default` 仍记录用户选的默认档位）。
   */
  reasoning: { supported: boolean; default: ReasoningLevel }
  capabilities: Partial<Record<CapabilityKey, CapabilityState>>
  curated: boolean
  tags?: string[]
  free?: boolean
  source: 'auto' | 'user'
  sortOrder?: number
  lastTest?: { ok: boolean; latencyMs?: number; at: string; error?: string }
  createdAt: string
  updatedAt: string
}

/** 场景槽位（键名沿用现状） */
export type ModelSlotKey =
  | 'defaultChatModel' | 'assistantModelId' | 'aiAssistantInlineSuggestModelId'
  | 'aiTranslateModelId' | 'agentCompressModelId' | 'aiTeachVisionModel'
  | 'aiImageModel' | 'aiImageEditModel'

/* ============================== 教学台账 ============================== */

export interface TeachLedger {
  /** 当前讲到的 unit 与台阶 */
  current?: { unitId: string; step: number; label: string }
  /** 本段已定义术语（避免重复解释） */
  terms: Array<{ term: string; definedAt: string }>
  next?: string
  updatedAt: string
}

/** ` ```teach ` 围栏里模型给出的增量（只写本回答的变化） */
export interface TeachPatch {
  unitId?: string
  step?: number
  label?: string
  newTerms?: string[]
  next?: string
}

/* ============================== 查看器 ============================== */

export type ViewerTabKind =
  | 'web' | 'note' | 'pdf' | 'book' | 'text' | 'image' | 'sidechat'

export interface ViewerTabWeb {
  kind: 'web'
  url: string
  title?: string
  dormant?: boolean
}

export interface ViewerTabFile {
  kind: 'note' | 'pdf' | 'book' | 'text' | 'image'
  rootId: string
  relPath: string
  name: string
  /** 仓库外文件的只读 token；渲染层看不到绝对路径 */
  externalToken?: string
  format?: 'epub' | 'fb2' | 'fbz' | 'cbz'
}

export interface ViewerTabSidechat {
  kind: 'sidechat'
  sessionId: string
}

export type ViewerTab = ViewerTabWeb | ViewerTabFile | ViewerTabSidechat

export interface ViewerState {
  v: 1
  /** key = 会话 id */
  sessions: Record<string, {
    tabs: ViewerTab[]
    activeIndex: number
    /** 面板宽度 px；0 / 缺省 = 默认 */
    width?: number
  }>
}

/* ============================== 旁问 ============================== */

export type SideScope = 'conversation' | 'anchor' | 'selection'

/* ============================== 常量 ============================== */

/** 解析缓存键：`<contentHash>/<engineSig>` */
export const PARSE_CACHE_VERSION = 1

/** 段内素材清单最多行数（超出让模型调 course.material.list） */
export const MATERIAL_MANIFEST_MAX_LINES = 20

/** 台账注入上限（字符） */
export const TEACH_LEDGER_MAX_CHARS = 800

/** 旁问整段模式：总量 / 单条上限（与 DT 对齐） */
export const SIDE_CHAT_TRANSCRIPT_MAX_CHARS = 24_000
export const SIDE_CHAT_MESSAGE_MAX_CHARS = 6_000

/** 侧栏宽度边界（overlay 面板） */
export const VIEWER_PANEL_MIN_W = 360
export const VIEWER_PANEL_MAX_W = 960
export const VIEWER_PANEL_DEFAULT_W = 480
