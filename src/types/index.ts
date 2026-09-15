// ===== 共享类型 =====

import type { DictLookupResult, DictStatus, DictWordEntry, DictExchange, TranslateMode, TranslateInvokeRequest, TranslateInvokeResult } from '../lib/translateTypes'
import type { GraphIndexData, GraphViewConfig } from '../lib/graphTypes'

export type { DictLookupResult, DictStatus, DictWordEntry, DictExchange, TranslateMode, TranslateInvokeRequest, TranslateInvokeResult }

export interface Entry {
  id: string; title: string; contentMd: string; contentHtml: string
  date: string; createdAt: string; updatedAt: string
  isPinned: boolean; isStarred: boolean; wordCount: number; tags?: Tag[]
  states: string
}
export interface EntryFilter { date?: string; tagId?: string; pinnedOnly?: boolean; starredOnly?: boolean; limit?: number; offset?: number }
export interface CreateEntryDTO { title?: string; contentMd?: string; contentHtml?: string; date: string; tags?: string[]; states?: string }
export interface UpdateEntryDTO { title?: string; contentMd?: string; contentHtml?: string; date?: string; isPinned?: boolean; isStarred?: boolean; tags?: string[]; states?: string }
export interface Tag { id: string; name: string; color: string }
export type TabName = 'blog' | 'schedule' | 'knowledge' | 'moments' | 'recycle' | 'settings' | 'help' | 'user' | 'toolbox' | 'plugins' | 'devtools' | 'editor' | 'aiTeaching' | 'releaseNotes'

// ===== 更新说明（release notes）=====
// 主进程侧的同一份契约见 electron/lib/releaseNotes/types.ts
// （两个 tsconfig 互不可见，沿用本仓「跨线类型各侧各声明一次」的做法）

export type ReleaseNoteKind = 'feature' | 'ux' | 'fix' | 'internal' | 'other'

export interface ReleaseNoteItem {
  /** `- **标题**：正文` 里的粗体标题；没有粗体前缀时为空串 */
  lead: string
  /** 条目正文（已剥掉 Markdown 粗体标记，反引号保留给渲染层做行内 code） */
  rest: string
  /** 缩进子项（已拍平为纯文本） */
  sub: string[]
}

export interface ReleaseNoteGroup {
  title: string
  kind: ReleaseNoteKind
  items: ReleaseNoteItem[]
}

export interface ReleaseNote {
  /** 不带前导 v，如 `3.0.0` */
  version: string
  /** CHANGELOG 原文里的日期，缺省为空串（老版本多数没写） */
  date: string
  summary: string
  groups: ReleaseNoteGroup[]
}

/** 与 electron/lib/releaseNotes/types.ts 镜像（跨线各声明一次的既有做法）。 */
export interface ReleaseHighlightLink {
  label: string
  href?: string
}

/** 右侧动效演示区（可重播；只动 transform/opacity） */
export type ReleaseHighlightDemo =
  | { kind: 'notify'; title: string; message: string; caption?: string }
  | { kind: 'compare'; caption?: string; rows: { label: string; display: string; width: number; after?: boolean }[] }
  | { kind: 'dist'; caption?: string; rows: { label: string; display: string; width: number }[] }
  | { kind: 'mini-list'; caption?: string; items: { text: string; done?: boolean }[] }

export interface ReleaseNoteHighlight {
  version: string
  /** 分节名（日程 / AI 助手 / 错题本 / 界面…） */
  section: string
  title: string
  desc: string
  detail?: string
  /** 顶部摘要行（粗体引导词 + 短句）；缺省不进摘要行 */
  briefLead?: string
  briefRest?: string
  /** 标题旁的小标签（如「新增」） */
  tag?: string
  links?: ReleaseHighlightLink[]
  /** 卡片内可折叠的「全部改动（N 条）」 */
  changes?: string[]
  demo?: ReleaseHighlightDemo
}

export interface ReleaseNoteListEntry {
  version: string
  date: string
  summary: string
  itemCount: number
}

export interface ReleaseNotesState {
  currentVersion: string
  hasNotes: boolean
  shouldAutoOpen: boolean
}

// toolbox
export interface ToolboxScript {
  id: string; name: string; description: string; content: string
  language: string; sortOrder: number
  createdAt: string; updatedAt: string
}
// blog template
export interface BlogTemplate {
  id: string; name: string; contentMd: string
  sortOrder: number; createdAt: string; updatedAt: string
}

// quiz records (收藏 + 错题本，全知识包通用)
export interface QuizOptionDto { key: string; text: string }
export interface QuizSnapshotDto {
  no: number
  question: string
  options: QuizOptionDto[]
  answer: string
  explanation: string
}
export interface QuizRecordDto {
  id: string
  pageId: string
  quizNo: number
  pageTitle: string
  isFavorite: boolean
  wrongCount: number
  correctCount: number
  lastResult: number | null
  /** 连续答对次数：>= 2 视为已掌握（从错题本列表移出） */
  streakCorrect: number
  /** 个人备注（卡片展开区可编辑） */
  note: string
  snapshot: QuizSnapshotDto | null
  sourceSpace: string
  sourceNotebook: string
  /** 题目所在页面的章节路径（笔记本以下 folder 层级，如"树 › 遍历"） */
  sourceChapter: string
  collectionIds: string[]
  tagIds: string[]
  createdAt: string
  updatedAt: string
}
/** 题目标签：kind = topic 考点 / type 题型 / difficulty 难度 / custom 关键词 */
export interface QuizTagDto {
  id: string
  name: string
  kind: string
  color: string
  sortOrder: number
  createdAt: string
  count: number
}
export interface QuizStatsDto {
  wrong: number
  mastered: number
  todayWrong: number
  correctRate: number
}
/** 错题本插件数据通道（JSON 版）状态；主表迁移语义已随 sql.js 退役 */
export interface QuizBookStat {
  /** 书 = 来源笔记本（空间内按知识点分书） */
  name: string
  total: number
  wrong: number
  mastered: number
  favorite: number
}
export interface QuizDataStats {
  /** 统计范围：'' = 全部知识空间；否则为空间名 */
  scope: string
  /** 当前仓库根路径（面板展示"存在哪"） */
  vaultRoot: string
  total: number
  wrong: number
  mastered: number
  favorite: number
  notes: number
  todayWrong: number
  correctRate: number
  tags: number
  collections: number
  byBook: QuizBookStat[]
  byBand: Array<{ key: string; label: string; count: number }>
}
export interface QuizCollectionDto {
  id: string
  name: string
  sortOrder: number
  createdAt: string
  count: number
}
export interface CreateToolboxScriptDTO { name?: string; description?: string; content?: string; language?: string }
export interface UpdateToolboxScriptDTO { name?: string; description?: string; content?: string; language?: string; sortOrder?: number }

// password vault
export interface PasswordEntry {
  id: string; title: string; url: string; username: string; account: string; password: string; notes: string
  sortOrder: number; createdAt: string; updatedAt: string
  /** 收藏（总览页置顶常用条目） */
  favorite: boolean
  /** 分组名（总览页折叠展示）；空 = 未分组 */
  group: string
}
export interface CreatePasswordEntryDTO { title?: string; url?: string; username?: string; account?: string; password?: string; notes?: string; favorite?: boolean; group?: string }
export interface UpdatePasswordEntryDTO {
  title?: string; url?: string; username?: string; account?: string; password?: string; notes?: string
  sortOrder?: number; favorite?: boolean; group?: string
  /**
   * 乐观锁：客户端持有的 updatedAt 版本。传入且与磁盘不一致时后端拒写（抛 PASSWORD_CONFLICT）。
   * 不传 = 不做校验（局部更新如「收藏」用）。
   */
  expectedUpdatedAt?: string
}

// moments
export interface MomentsAlbum {
  id: string
  name: string
  photoCount: number
  cover: string
  coverPostId: string
  coverIndex: number
  createdAt: string
  updatedAt: string
}
export interface AttachmentMeta {
  id: string
  name: string
  url: string
  thumbUrl: string
  mime: string
  size: number
  position: number
}
export interface CreateMomentsPostDTO { contentMd?: string; contentHtml?: string; imageDataUrls?: string[]; attachmentIds?: string[]; tags?: string[]; albumId?: string; isPinned?: boolean; showInTimeline?: boolean }
export interface UpdateMomentsPostDTO { contentMd?: string; contentHtml?: string; imageDataUrls?: string[]; attachmentIds?: string[]; tags?: string[]; albumId?: string; isPinned?: boolean; showInTimeline?: boolean }

export interface MomentsPost {
  id: string
  contentMd: string
  contentHtml: string
  imageDataUrls: string[]
  attachmentIds: string[]
  attachments: AttachmentMeta[]
  tags: string[]
  albumId: string
  isPinned: boolean
  /** false = 仅归档到相册，不在时间线显示 */
  showInTimeline: boolean
  createdAt: string
  updatedAt: string
}
// ---- 打卡模块 ----
export type HabitRuleType = 'daily' | 'weekdays' | 'flexible'
/** 自动打卡来源（跨模块联动），指标现值由主进程从各源表按业务日期反查 */
export type HabitLinkSource = 'blog' | 'pomodoro' | 'schedule' | 'knowledge'
export interface HabitLink {
  source: HabitLinkSource
  /** 达标阈值：博客=字数，其余=当天累计次数 */
  threshold: number
  enabled: boolean
}
export interface Habit {
  id: string
  name: string
  color: string
  ruleType: HabitRuleType
  /** weekdays 规则的计划日，JS getDay() 数字，0=周日 */
  ruleDays: number[]
  /** flexible 规则的每周目标次数 */
  weeklyTarget: number
  sortOrder: number
  archived: boolean
  createdAt: string
  /** 自动完成联动规则；null = 未绑定 */
  link?: HabitLink | null
}
export interface HabitRecord { id: string; habitId: string; date: string; source?: 'manual' | 'auto' }
/** 自动打卡事件（主进程 → 渲染层轻提示） */
export type HabitAutoCheckin = { habitId: string; habitName: string; date: string }
export interface CreateHabitDTO {
  name: string; color?: string; ruleType?: HabitRuleType
  ruleDays?: number[]; weeklyTarget?: number; sortOrder?: number
}
export interface UpdateHabitDTO {
  name?: string; color?: string; ruleType?: HabitRuleType
  ruleDays?: number[]; weeklyTarget?: number
  sortOrder?: number; archived?: boolean
}

// ---- 网址导航 ----
export interface BookmarkCategory { id: string; name: string; color: string; sortOrder: number; createdAt: string }
export interface BookmarkItem {
  id: string
  /** '' = 未分类 */
  categoryId: string
  title: string
  url: string
  description: string
  sortOrder: number
  createdAt: string
}

// ---- 远程监督 ----
export type SupervisePlatform = 'serverchan' | 'wecom' | 'dingtalk' | 'custom'
export interface SuperviseConfig {
  enabled: boolean
  platform: SupervisePlatform
  /** serverchan 存 SendKey，其余存完整 webhook 地址 */
  webhookUrl: string
  /** 仅钉钉加签 */
  secret: string
  instantPush: boolean
  dailyPush: boolean
  /** HH:mm */
  dailyTime: string
  /** 免打扰起止 HH:mm，空 = 不启用 */
  quietStart: string
  quietEnd: string
}
export interface SuperviseLog {
  id: number
  pushType: 'instant' | 'daily'
  habitId: string | null
  title: string
  content: string
  status: 'success' | 'failed' | 'pending'
  retryCount: number
  errorMessage: string | null
  createdAt: string
  pushedAt: string | null
}

// user
export interface UserProfile {
  username: string
  avatarPath: string
  hasPassword: boolean
  createdAt: string
  updatedAt: string
}
export interface UserStats {
  blogCount: number
  knowledgePages: number
  scheduleTodos: number
  blogTags: number
  knowledgeTags: number
  scheduleTags: number
  consecutiveDays: number
  totalWords: number
  totalCategories: number
}
export interface UserExportData {
  username: string
  avatarPath: string
  avatarBase64: string | null
  passwordHash: string
}
export interface UserImportData {
  username?: string
  avatarPath?: string
  avatarBase64?: string | null
  passwordHash?: string
}
export type { AppSettings, SettingsKey, SettingsValue } from '../lib/settings'

// schedule
export interface ScheduleTodo {
  id: string; title: string; description: string; date: string
  time: string | null; quadrant: number
  taskType: 'deadline' | 'plan' | 'daily'; tagId: string | null
  status: 'pending' | 'done'; sortOrder: number
  endCriteria: string; parentId: string | null
  /**
   * 日程表排期时段（当天分钟数，540 = 09:00；null = 未排期）。
   * 与 `time`（截止时刻，仅 deadline 类）语义分离 —— 一个是「排到哪个时段」，一个是「几点前必须完成」。
   */
  scheduledStart: number | null
  scheduledEnd: number | null
  /**
   * 提醒「稍后」（snooze）：在此时间之前不再提醒该任务，ISO 字符串（'YYYY-MM-DD HH:mm'）。
   * 缺省 / null = 未打盹。本轮日程改造新增的唯一字段。
   */
  snoozeUntil?: string | null
  createdAt: string; updatedAt: string
  tag?: ScheduleTag | null
  subtasks?: ScheduleTodo[]
}
export interface ScheduleTag { id: string; name: string; color: string }
export interface CreateScheduleTodoDTO {
  title: string; description?: string; date: string; time?: string
  quadrant?: number; taskType?: 'deadline' | 'plan' | 'daily'; tagId?: string
  endCriteria?: string; parentId?: string
  scheduledStart?: number | null; scheduledEnd?: number | null
}
export interface UpdateScheduleTodoDTO {
  title?: string; description?: string; date?: string; time?: string | null
  quadrant?: number; taskType?: 'deadline' | 'plan' | 'daily'; tagId?: string | null
  status?: string; endCriteria?: string; parentId?: string | null
  scheduledStart?: number | null; scheduledEnd?: number | null
  /** 提醒「稍后」目标时间；传 null 表示清除打盹 */
  snoozeUntil?: string | null
}

// knowledge
export interface KnowledgeCategory {
  id: string; name: string; parentId: string | null; sortOrder: number
  categoryType: 'notebook' | 'folder' | 'space'
  createdAt: string; updatedAt: string
  /** vault 读源：仓库内相对目录路径（如 学习空间/C++教学）——图谱目录 scope 用 */
  path?: string
  children?: KnowledgeCategory[]
}
export interface KnowledgePage {
  id: string; title: string; contentMd: string; contentHtml: string
  annotationMd?: string
  categoryId: string | null; isStarred: boolean; sortOrder: number
  fileType: string
  attachmentId: string
  createdAt: string; updatedAt: string
  tags?: KnowledgeTag[]
  backlinks?: KnowledgePage[]
  /** 搜索命中摘录（仅 searchPages 结果携带） */
  excerpt?: string
  /** vault 读源模式：仓库内相对路径（「在编辑器中打开」跳转用，仅 vault 模式携带） */
  path?: string
  /** frontmatter attachments：仓库内相对路径数组（附件面板/路由阅读器用） */
  attachments?: string[]
  /** 页面状态：draft=草稿（知识库正式列表不显示，编辑器侧/图谱虚化可见）；published=归档（默认） */
  status?: 'draft' | 'published'
  /** 条目种类：file=清单归档的非 md 文件（元信息卡/沙箱渲染，不参与正文/双链）；缺省=md 知识页 */
  entryKind?: 'doc' | 'file'
  /** 文件大小（字节；元信息卡展示） */
  sizeBytes?: number
}
/** 反链条目（带引用上下文摘录） */
export interface KnowledgeBacklinkItem {
  id: string; title: string; fileType: string
  updatedAt: string
  excerpt: string
}
/** 相似笔记条目（编辑器右栏「相关笔记」，A3-3；via=命中方式 keyword/semantic/hybrid） */
export interface SimilarPageHit {
  pageId: string; title: string; path: string
  excerpt: string
  via: 'keyword' | 'semantic' | 'hybrid'
  score: number
}
export interface KnowledgeTag { id: string; name: string; color: string }
export interface CreateKnowledgeCategoryDTO { name: string; parentId?: string | null; categoryType?: 'notebook' | 'folder' | 'space' }
export interface UpdateKnowledgeCategoryDTO { name?: string; parentId?: string | null; sortOrder?: number; categoryType?: 'notebook' | 'folder' | 'space' }
export interface CreateKnowledgePageDTO { title?: string; contentMd?: string; contentHtml?: string; categoryId?: string | null; fileType?: string; filePath?: string; tags?: string[] }
export interface UpdateKnowledgePageDTO { title?: string; contentMd?: string; contentHtml?: string; annotationMd?: string; categoryId?: string | null; fileType?: string; filePath?: string; tags?: string[] }

// import
export interface ImportFileResult {
  path: string
  baseName: string
  content: string
  fileType: string
  error?: string
}

// recycle bin
export interface RecycleBinItem {
  id: string
  originalId: string
  module: 'blog' | 'knowledge' | 'knowledge_category' | 'passwordVault' | 'moments'
  title: string
  data: any
  deletedAt: string
}

// export
export interface BlogExportData { entries: (Entry & { tags: Tag[] })[]; tags: Tag[] }
export interface ScheduleExportData { todos: (ScheduleTodo & { tag: ScheduleTag | null })[]; tags: ScheduleTag[] }
export interface KnowledgeExportData { categories: KnowledgeCategory[]; pages: (KnowledgePage & { tags: KnowledgeTag[]; backlinks: string[] })[]; tags: KnowledgeTag[] }
export interface PasswordVaultExportData { entries: PasswordEntry[] }
export interface MomentsExportData { posts: MomentsPost[]; albums: MomentsAlbum[] }
export interface HabitExport {
  id: string; name: string; color: string; icon: string
  ruleType: HabitRuleType; ruleDays: number[]; weeklyTarget: number
  sortOrder: number; archived: boolean; createdAt: string; updatedAt: string
}
export interface HabitRecordExport { id: string; habitId: string; date: string; source?: 'manual' | 'auto' }
export interface HabitLinkExport { habitId: string; source: HabitLinkSource; threshold: number; enabled: boolean }
export interface CheckinExportData { habits: HabitExport[]; records: HabitRecordExport[]; links?: HabitLinkExport[] }
export interface BookmarkNavExportData { categories: BookmarkCategory[]; bookmarks: BookmarkItem[] }
export interface AllExportData {
  exportVersion: string; exportedAt: string
  user?: UserExportData & { settings: Record<string, unknown>; stats: UserStats }
  blog: BlogExportData; schedule: ScheduleExportData; knowledge: KnowledgeExportData
  passwordVault?: PasswordVaultExportData
  moments?: MomentsExportData
  checkin?: CheckinExportData
  bookmarkNav?: BookmarkNavExportData
}

export interface ExportFileResult { filePath: string; size: number }
export interface ExportMarkdownProgress { current: number; total: number; currentFile: string; phase: string }
export interface ExportMarkdownResult { fileCount: number; totalSize: number; files: { relPath: string; size: number }[] }

export interface PluginRegistryEntry {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  downloadUrl: string
  iconUrl?: string
  category?: string
  riskLevel?: PluginRiskLevel
  contributions?: string[]
  capabilities?: string[]
  size?: number
  checksum?: string
  updatedAt?: string
}

export type PluginRiskLevel = 'S' | 'A' | 'B' | 'C'

/** 删除动画皮肤（插件 contributes.deleteFx，纯数据） */
export interface DeleteFxSkin {
  pluginId?: string
  id?: string
  name?: string
  /** SVG 片段（注入 <svg> 内，禁脚本/事件） */
  dragonSvg?: string
  /** 粒子颜色（#RRGGBB 等） */
  particleColors?: string[]
  /** 吞噬遮罩颜色 */
  wipeColor?: string
  /** 动画时长 ms（300-2000） */
  durationMs?: number
}

/** 插件视图挂载点贡献（C 级模块插件 contributes.views） */
export interface PluginViewContribution {
  pluginId: string
  name: string
  entry: string
  /** 挂载槽位，如 knowledge.sidebar */
  slot: string
  title: string
  /** fullscreen 覆盖层 / panel 面板 */
  mode: string
  icon?: string
  granted: string[]
}

/** 插件命令（plugin-phase1-design C3；plugin:listCommands 行结构） */
export interface PluginCommandInfo {
  pluginId: string
  name: string
  /** 插件内命令 id；全局名 = `<pluginId>.<id>` */
  id: string
  title: string
  desc?: string
  /** 插件首个 view 的槽位（ui 插件才有）：宿主执行时切模块并激活该视图 */
  viewSlot?: string
  type: 'declarative' | 'ui' | 'code'
}

/** 插件声明式设置项（plugin-phase1-design C5；contributes.settings 条目） */
export interface PluginSettingItem {
  key: string
  label: string
  type: 'boolean' | 'number' | 'string' | 'select'
  default?: unknown
  /** select 专供：{value,label} 或字符串数组 */
  options?: Array<Record<string, unknown> | string>
  desc?: string
}

/** 插件 fenced-code 渲染器（plugin-phase1-design C6；plugin:listRenderers 行结构） */
export interface PluginRendererInfo {
  pluginId: string
  name: string
  lang: string
  entry: string
  height?: number
  title?: string
}

export interface PluginSummary {
  id: string
  name: string
  version: string
  engineVersion?: string
  author?: string
  description?: string
  type: string
  entry?: string
  icon?: string
  category?: string
  riskLevel: PluginRiskLevel
  capabilities: string[]
  grantedCapabilities: string[]
  legacyGrant?: boolean
  enabled: boolean
  installedAt: string
  builtin?: boolean
  contributions: string[]
  broken?: boolean
}

// ===== AI 工具（ToolRegistry，方案见 .claude/plans/agent-tools-foundation.md） =====

export interface AgentToolInfo {
  /** 全局唯一：builtin.knowledge.search / mcp.<serverId>.<toolName> / skill.<id>.<name> */
  name: string
  title: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, {
      type: 'string' | 'number' | 'boolean'
      description?: string
      minimum?: number
      maximum?: number
      enum?: string[]
    }>
    required?: string[]
  }
  source: 'builtin' | 'mcp' | 'skill'
  enabled: boolean
  readOnly: boolean
  /** 所属业务模块（按模块控制 AI 权限） */
  module?: string
  /** 调用所需最低权限 */
  requires?: 'read' | 'write'
}

export interface AiToolUsage {
  used: number
  /** 0 = 不限 */
  limit: number
}

export type AiToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'TOOL_DISABLED'
  | 'INVALID_ARGS'
  | 'LIMIT_EXCEEDED'
  | 'EXEC_ERROR'

export type AiToolInvokeResult = {
  ok: true
  data: unknown
} | {
  ok: false
  code: AiToolErrorCode
  message: string
}

export interface AiToolsListResult {
  tools: AgentToolInfo[]
  usage: AiToolUsage
}

export interface AuditEntryInfo {
  id: string
  pluginId: string
  action: string
  detail: string
  createdAt: string
}

/** 插件审计条目（与 AI 工具审计同构，别名导出供插件模块消费） */
export type PluginAuditEntry = AuditEntryInfo

// ===== MCP 外部服务器（M2） =====

export interface McpToolPreview {
  name: string
  description: string
}

export interface McpServerInfo {
  id: string
  name: string
  transport: 'stdio' | 'sse' | 'http'
  /** stdio=命令行拼接预览 / sse·http=URL */
  endpointPreview: string
  /** 环境变量键名列表（值永不回传渲染层） */
  envKeys: string[]
  enabled: boolean
  status: 'untested' | 'ok' | 'error'
  lastError: string
  toolCount: number
  maxConnections: number
}

/** 添加/编辑/连通性测试共用草稿 */
export interface McpServerDraft {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  commandArgs?: string[]
  url?: string
  env?: Record<string, string>
  /** stdio 双重确认：未确认时主进程拒绝保存与测试 */
  confirmCommand?: boolean
}

export interface McpTestResult {
  ok: boolean
  latencyMs: number
  tools: McpToolPreview[]
  error?: string
}

// ===== Skill 提示词资产（M3） =====

export interface SkillInfo {
  /** 来源：插件贡献 / 独立安装（设置页拖入 zip） */
  source: 'plugin' | 'standalone'
  pluginId: string
  pluginName: string
  /** 注册表内名称 skill.<pluginId>.<skillId> 或 skill.standalone.<id> */
  registryName: string
  id: string
  title: string
  description: string
  variables: string[]
  /** 声明依赖的工具（展示用途） */
  tools: string[]
  /** 用户是否在设置页停用了该 Skill（停用后 AI 工具列表不可见，文件保留） */
  disabled: boolean
}

export interface SkillInstallResult {
  success: boolean
  message?: string
  skill?: SkillInfo
}

// ===== 模型网关 + AI 对话 =====

export type LlmProviderType = 'openai-compatible' | 'ollama' | 'anthropic'

/** 脱敏后的供应商信息（Key 相关字段永不回传） */
export interface LlmProviderInfo {
  id: string
  name: string
  type: LlmProviderType
  baseUrl: string
  enabled: boolean
  hasKey: boolean
  models: string[]
  headers?: Record<string, string>
  /** 嵌入模型名（空串=未配置；知识语义检索用） */
  embeddingModel: string
  isDefault: boolean
}

export interface LlmVisionModelInfo { spec: string; providerName: string; model: string }

export interface LlmProviderDraft {
  id?: string
  name: string
  type: LlmProviderType
  baseUrl: string
  /** 仅新增/更换时传入；编辑留空保留旧密文 */
  apiKey?: string
  enabled?: boolean
  /** 自定义请求头（opencode 等网关要求 x-opencode-session 之类路由头时在此配置） */
  headers?: Record<string, string>
  /** 嵌入模型名（知识语义索引用）；不配 = 该供应商不参与嵌入 */
  embeddingModel?: string
}

export interface LlmTestResultInfo {
  ok: boolean
  latencyMs: number
  models?: string[]
  error?: string
}

// 模型级可用性测试结果(真实最小补全,区别于供应商探活)
export interface LlmModelTestResultInfo {
  ok: boolean
  latencyMs: number
  replyPreview?: string
  error?: string
}

export interface LlmUsageInfo {
  monthTokens: number
  /** 本月输入 tokens（↑）——与 monthTokens 同源审计聚合，供用量 UI 展示拆分 */
  monthPromptTokens?: number
  /** 本月输出 tokens（↓） */
  monthCompletionTokens?: number
  /** 月度预算上限（已随 faf1b0f 移除限额概念；可选保留兼容沉浸面板） */
  budget?: number
  /** 视觉转写月度 tokens（与回答模型分开统计，2026-09-08） */
  visionMonthTokens?: number
  /** 视觉转写月度页数 */
  visionPages?: number
}

/** 本月用量细分（网关补强：审计聚合，按供应商/模型） */
export interface LlmUsageBreakdownEntry {
  providerId: string
  provider: string
  model: string
  calls: number
  tokens: number
  promptTokens: number
  completionTokens: number
}

// ===== CC Switch 一键导入 =====

export interface CcSwitchItem {
  id: string
  name: string
  type: LlmProviderType
  baseUrl: string
  /** 打码预览（前6+***+后4），明文永不离开主进程 */
  keyPreview: string
}

export interface CcSwitchScanResult {
  found: boolean
  source: string
  items: CcSwitchItem[]
}

export interface CcSwitchImportResult {
  imported: number
  skipped: number
  errors: string[]
}

export interface AgentTraceStep {
  kind: 'llm' | 'tool'
  name?: string
  ok: boolean
  durationMs: number
  tokens?: number
  /** 拆分用量（llm step；prompt=本次上下文输入，completion=本次生成） */
  promptTokens?: number
  completionTokens?: number
  /** 命中提示缓存的输入 token 数（观测用，已含在 promptTokens 内） */
  cachedTokens?: number
  summary?: string
  /** visual.html「生成中」实时事件（agent:step 专用，不落库）：{slug,title} */
  args?: Record<string, unknown>
  /** visual.html 成功产物（落库随消息 trace）：对话流工件卡数据源 */
  artifact?: { rel: string; title: string; lines: number; slug: string }
  /** 过程旁白（落库）：带工具轮次里模型输出的说明文本，历史回看用 */
  processText?: string
  /** 思考耗时 ms（落库；reasoning 全文不落库） */
  thinkingMs?: number
}

/**
 * 流式增量事件（agent:stream，与 agent:step 分工）：
 * step 承载「步骤完成」（落库），stream 承载「增量与进行中」（不落库）。两者合起来才是完整过程时间线。
 */
export type AgentStreamEvent =
  | { kind: 'round-start'; round: number }
  | { kind: 'thinking'; delta: string }
  | { kind: 'text'; delta: string }
  | { kind: 'tool-start'; name: string; label: string; target?: string }

export interface AgentChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AgentContextInfo {
  type: string
  label: string
  data?: Record<string, unknown>
}

/** 会话来源：把「通用 AI 助手」（侧栏 / AI 学堂）与「AI 教学」的会话列表互相隔离。
 *  二者同表存储、同一套 AgentRunner，仅列表展示分流。与主进程 agentSessionRepo 同构。 */
export type AgentSessionSource = 'assistant' | 'aiTeaching'

export interface AgentSessionInfo {
  id: string
  title: string
  /** 来源（缺省=assistant） */
  source?: AgentSessionSource
  /** 会话级全局要求（仅本会话生效；空串/缺省=无） */
  instructions?: string
  createdAt: string
  updatedAt: string
  /** 支线旁问（v3.1.2 条目11）：挂靠的主线会话 id（缺省=非支线）。与主线物理隔离 */
  parentSessionId?: string
  /** 支线旁问：分叉点的主线消息 id */
  branchFromMessageId?: string
  /** 支线旁问：'side' 默认不进左栏列表；缺省/'main' 可见（升格后置 'main'） */
  lane?: 'main' | 'side'
  /** 支线旁问：固化上下文快照（分叉回答 + 主线前 K 轮） */
  sideContext?: string
}

/** 建支线结果（agent:createSideLane）：只装上下文不调 LLM */
export interface AgentSideLaneCreateResult {
  ok: boolean
  laneSessionId?: string
  title?: string
  /** 就地装载并展示给用户核对的上下文快照 */
  snapshotText?: string
  /** 实际采用的轮数（1/3/5 夹取后） */
  turns?: number
  error?: string
}

/** P5 工作区（AI教学两层结构；主进程 aiTeachingWorkspaces.ts 同构） */
export interface AiTeachWorkspaceInfo {
  id: string
  name: string
  createdAt: string
  sessionCount: number
  docCount: number
  folderRel: string
  lastActive: string | null
}

/** P6 素材库：SOURCE.md 解析条目（§3.13 模板 v2，字段行与模板一一对应） */
export interface AiTeachSourceEntry {
  no: number
  name: string
  /** url / pptx / pdf / docx / image / md / code / dir / other（3-27 枚举；docx 为 v3.1.2 条目5 新增） */
  type: string
  /** ./文件名（已入库）/ 仓库相对 / 绝对路径 / URL */
  path: string
  /** '12-34' | '12' | '-' */
  range: string
  /** 已入库 | 仅引用（3-22） */
  storage: string
  /** '-' 或 '✓ → 提取稿文件名'（3-26 程序维护） */
  extracted: string
  note: string
  /** v3.1.1：条目所属层 —— workspace=工作区主库（跨对话共用），session=对话私有补充（存量） */
  scope?: 'workspace' | 'session'
  /** v3.1.1：条目所属素材夹的仓库相对路径（提取稿/原件都相对它；两层合并后必须逐条目携带） */
  dirRel?: string
  /** v3.1.1：所属 SOURCE.md 内的原始编号（合并视图编号 ≠ 层内编号时，写操作按它定位） */
  origNo?: number
}

/** P6 素材库：登记表单入参（storage=已入库 时 path 为待拷贝原件的来源路径） */
export interface AiTeachSourceInput {
  name: string
  /** 可选：缺省 = 主进程按 URL/扩展名自动检测类型（2026-09-08 用户拍板不再手选）；显式传入用于 AI 登记等 */
  type?: string
  path: string
  rangeFrom?: string
  rangeTo?: string
  storage: '已入库' | '仅引用'
  note?: string
}

export interface AiTeachSourcesResult {
  ok: boolean
  /** 工作区主库 SOURCE.md 的仓库相对路径（登记入口落这里） */
  relPath?: string | null
  entries?: AiTeachSourceEntry[]
  no?: number
  /** v3.1.1：两层各自的文件路径（对话级无文件时为 null） */
  workspaceRel?: string | null
  sessionRel?: string | null
  /** v3.1.1：aiTeachSrcPromote 的结果（上收到主库的条目数） */
  promoted?: number
  /** UI 优化条目5.3：手编/AI 直写 SOURCE.md 的形状异常统计（unnamed=缺编号的小节，dupNo=编号重复被丢弃数） */
  anomalies?: { unnamed: number; dupNo: number }
  error?: string
}

/** 网页素材目录展开：章节条目（probe 返回，渲染层勾选） */
export interface WebCrawlChapter {
  no: number
  title: string
  url: string
  group: string
  defaultChecked: boolean
}

/** 网页探测结果：portal=门户需选锚点 / toc=目录含章节 / article=单文章 */
export interface WebProbeResult {
  ok: boolean
  error?: string
  kind?: 'portal' | 'toc' | 'article'
  anchor?: string
  title?: string
  chapters?: WebCrawlChapter[]
  candidates?: Array<{ title: string; url: string }>
}

/** 网页批量抓取结果 */
export interface WebCrawlResult {
  ok: boolean
  dirRel?: string
  done?: number
  failed?: Array<{ url: string; title: string; reason: string }>
  skipped?: number
  error?: string
}

/** 会话内消息（trace 仅 assistant 消息携带） */
export interface AgentStoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** JSON 字符串（原始行格式），前端自行解析 */
  traceJson?: string | null
  createdAt: string
}

/** 单次请求对用户数据的写改动（UI 改动清单用） */
export interface AgentChange {
  tool: string
  /** 人类可读动作（修改文件/新建知识页…） */
  action: string
  /** 目标：relPath / 标题 / 日期 */
  target: string
  /** 可点击直达编辑器的仓库内文件 relPath（仅 vault 文件写类工具） */
  file?: string
}

export interface AgentChatResult {
  ok: boolean
  sessionId?: string
  reply?: string
  error?: string
  code?: string
  trace: AgentTraceStep[]
  /** 本次真实发生的写改动 */
  changes?: AgentChange[]
  /** UI 优化条目9②：AI教学本轮 system 注入分段字符数（上下文构成摘要；其它来源无此字段） */
  injection?: AiTeachInjectionStats
  /** 触达轮数/token 预算上限：本次回答来自强制总结轮（渲染层可提示） */
  hitCap?: boolean
  /** 本次请求前自动压缩了历史（会话压缩 §6.1；渲染层据此 toast 告知） */
  compressed?: { covered: number; digestChars: number }
}

/** 会话压缩结果（agent:compressSession；AgentCompressResult 的渲染层镜像） */
export interface AgentCompressResult {
  ok: boolean
  skipped?: 'nothing-to-compress'
  covered?: number
  digestChars?: number
  slices?: number
  error?: string
}

/** AI教学 system 注入分段字符数（基础人设 / CONSTRAINTS / 三层画像 / SOURCE 目录 / 教学规则） */
export interface AiTeachInjectionStats {
  systemChars: number
  constraintChars: number
  profileChars: number
  sourcesChars: number
  ruleChars: number
}

// ===== PDF 工具箱 =====
export type PdfOpResult = { ok: true; data: Uint8Array } | { ok: false; error: string; cancelled?: boolean }
export type PdfExportResult = { ok: true; path: string } | { ok: false; error?: string; cancelled?: boolean }

// 设备传输（lanShare，工具箱）
export interface LanShareStatus {
  running: boolean
  port: number
  urls: string[]
  remainingMs: number
  startedAt: number
}
// Web 剪藏服务状态（工具箱「网页剪藏」面板）
export interface ClipperStatus {
  running: boolean
  port: number
  portDrifted: boolean
  error: string
  token: string
  tokenHint: string
  vault: { name: string; saveDir: string } | null
  extensionDir: string
  clips: { available: boolean; dir: string; items: Array<{ name: string; size: number; mtimeMs: number }> }
}
export interface LanShareInboxFile {
  name: string
  size: number
  path: string
  receivedAt: number
}
export interface LanShareOutboxFile {
  name: string
  size: number
  path: string
  downloaded: boolean
}

// 编辑器工作区（Vault 仓库）
export interface WorkspaceEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  mtime: number
}
export interface WorkspaceReadResult {
  content: string
  binary: boolean
  size: number
  editable: boolean
  truncated: boolean
  /** 磁盘 mtime（保存冲突检测基线） */
  mtimeMs: number
  /** 探测到 PDF 头（%PDF-）——按二进制处理不返回内容，阅读器走 ws:readRange */
  pdf?: boolean
}
/** 二进制范围读取结果（PDF 阅读器懒加载；data 为 base64 段） */
export interface WorkspaceRangeResult {
  data: string
  offset: number
  size: number
  truncated: boolean
}
/** 写文件结果：conflict=true 表示磁盘已被外部修改（或已删除），需用户决策 */
export interface WorkspaceWriteResult {
  ok: boolean
  error?: string
  conflict?: boolean
  diskMtimeMs?: number
  diskSize?: number
  missing?: boolean
  mtimeMs?: number
  size?: number
}
export interface WorkspaceRecent {
  rootId: string
  name: string
  path: string
  updatedAt: string
}
/** ws:openDir 返回（D7）：成功登记 / 选中目录不是仓库（待确认初始化）/ 错误 */
export type VaultOpenResult =
  | { rootId: string; name: string; path: string }
  | { notVault: true; name: string; path: string }
  | { error: string }
/** P3 插图：图片入附件区后的落点描述（relPath = 仓库根相对 POSIX 路径） */
export interface VaultStagedImage {
  name: string
  relPath: string
}
/** P6 整仓归档：冲突项（zip 内路径 + 两侧尺寸）与逐条决策 */
export interface VaultArchiveConflictItem {
  relPath: string
  zipSize: number
  existingSize: number
}
export interface VaultArchiveDecision {
  relPath: string
  action: 'overwrite' | 'skip' | 'rename'
}
/** P6 导入第一步返回：直接完成，或返回冲突列表等待逐条决策（pending） */
export type VaultArchiveImportResult =
  | { pending: true; target: string; totalFiles: number; conflicts: VaultArchiveConflictItem[] }
  | { pending?: false; ok?: boolean; canceled?: boolean; written?: number; skipped?: number; renamed?: number; registered?: string; rootId?: string; name?: string; path?: string; error?: string }

export interface ElectronAPI {
  getPathForFile: (file: File) => string
  copyImage: (src: { path?: string; dataUrl?: string }) => Promise<boolean>
  clearClipboardIfEqual: (text: string) => Promise<boolean>
  copyText: (text: string) => Promise<boolean>
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  resizeForSidebar: (width: number, animate?: boolean) => Promise<{ applied: boolean; reason?: string }>
  onMaximizeChange: (cb: (v: boolean) => void) => void
  setFullscreen: (flag: boolean) => Promise<void>
  onFullscreenChange: (cb: (v: boolean) => void) => void
  setAlwaysOnTop: (onTop: boolean) => Promise<boolean>
  isAlwaysOnTop: () => Promise<boolean>
  /** UI 优化条目1.7：最大化边缘拖拽恢复（edge = 四边/四角/move） */
  edgeResizeStart: (edge: string) => Promise<{ ok: boolean }>
  edgeResizeEnd: () => Promise<{ ok: boolean }>
  getSetting: (key: string) => Promise<unknown>
  getAllSettings: () => Promise<Record<string, unknown>>
  setSetting: (key: string, value: unknown) => Promise<void>
  openDirDialog: () => Promise<string | null>
  reloadWindow: () => Promise<void>
  clearAllData: () => Promise<{ success: boolean; error?: string }>
  getEntries: (f: EntryFilter) => Promise<Entry[]>
  getEntryById: (id: string) => Promise<(Entry & { tags: Tag[] }) | null>
  createEntry: (d: CreateEntryDTO) => Promise<Entry>
  updateEntry: (id: string, d: UpdateEntryDTO) => Promise<Entry>
  toggleEntryStar: (id: string) => Promise<(Entry & { tags: Tag[] }) | null>
  deleteEntry: (id: string) => Promise<void>
  searchEntries: (q: string) => Promise<Entry[]>
  getTags: () => Promise<Tag[]>
  createTag: (n: string, c?: string) => Promise<Tag>
  deleteTag: (id: string) => Promise<void>
  getScheduleTodos: (date: string) => Promise<ScheduleTodo[]>
  getScheduleDates: (yearMonth: string) => Promise<string[]>
  getScheduleMonthTodos: (yearMonth: string) => Promise<ScheduleTodo[]>
  getScheduleOverdue: (today: string) => Promise<ScheduleTodo[]>
  getScheduleDeadlineCounts: (yearMonth: string) => Promise<Record<string, number>>
  getScheduleSubtasks: (parentId: string) => Promise<ScheduleTodo[]>
  getScheduleUnscheduledTodos: () => Promise<ScheduleTodo[]>
  getScheduleWeekTodos: (weekStart: string, weekEnd: string) => Promise<ScheduleTodo[]>
  createScheduleTodo: (d: CreateScheduleTodoDTO) => Promise<ScheduleTodo>
  updateScheduleTodo: (id: string, d: UpdateScheduleTodoDTO) => Promise<ScheduleTodo>
  deleteScheduleTodo: (id: string) => Promise<void>
  getScheduleTags: () => Promise<ScheduleTag[]>
  createScheduleTag: (n: string, c?: string) => Promise<ScheduleTag>
  deleteScheduleTag: (id: string) => Promise<void>
  /** 日程截止提醒的系统通知被点击 → 主窗口切到日程模块 */
  onScheduleReminderClick: (cb: () => void) => () => void
  // knowledge (Scheme A)
  getKnowledgeCategories: () => Promise<KnowledgeCategory[]>
  createKnowledgeCategory: (d: CreateKnowledgeCategoryDTO) => Promise<KnowledgeCategory>
  updateKnowledgeCategory: (id: string, d: UpdateKnowledgeCategoryDTO) => Promise<KnowledgeCategory>
  deleteKnowledgeCategory: (id: string) => Promise<void>
  getKnowledgePages: (categoryId?: string | null) => Promise<KnowledgePage[]>
  /** 知识索引 warnings（.ignore 坏行/规则未命中磁盘条目等）；空数组 = 无警告 */
  getKnowledgeIndexWarnings: () => Promise<string[]>
  getKnowledgePageById: (id: string) => Promise<KnowledgePage | null>
  createKnowledgePage: (d: CreateKnowledgePageDTO) => Promise<KnowledgePage>
  updateKnowledgePage: (id: string, d: UpdateKnowledgePageDTO) => Promise<KnowledgePage>
  deleteKnowledgePage: (id: string) => Promise<void>
  searchKnowledgePages: (q: string) => Promise<KnowledgePage[]>
  getKnowledgeBacklinks: (pageId: string) => Promise<KnowledgePage[]>
  getKnowledgeBacklinkContext: (pageId: string) => Promise<KnowledgeBacklinkItem[]>
  getKnowledgeSimilarPages: (pageId: string) => Promise<{ hits: SimilarPageHit[]; semantic?: { enabled: boolean; reason?: string } }>
  getKnowledgeManualLinks: (pageId: string) => Promise<KnowledgePage[]>
  addKnowledgeManualLink: (pageId: string, targetId: string) => Promise<{ ok: boolean }>
  removeKnowledgeManualLink: (a: string, b: string) => Promise<{ ok: boolean }>
  updateKnowledgeLinks: (pageId: string, linkedTitles: string[]) => Promise<void>
  getKnowledgeTags: () => Promise<KnowledgeTag[]>
  getKnowledgeGraph: () => Promise<GraphIndexData>
  getGraphViewConfig: () => Promise<GraphViewConfig>
  updateGraphViewConfig: (patch: Partial<GraphViewConfig>) => Promise<GraphViewConfig>
  createKnowledgeTag: (n: string, c?: string) => Promise<KnowledgeTag>
  deleteKnowledgeTag: (id: string) => Promise<void>
  toggleKnowledgeStar: (id: string) => Promise<KnowledgePage>
  getKnowledgeStarredPages: () => Promise<KnowledgePage[]>
  moveKnowledgePage: (id: string, direction: 'up' | 'down') => Promise<void>
  reorderKnowledgePage: (id: string, targetIndex: number) => Promise<void>
  moveKnowledgeCategory: (id: string, direction: 'up' | 'down') => Promise<void>
  duplicateKnowledgePage: (data: { pageId: string; targetCategoryId?: string | null }) => Promise<unknown>
  duplicateKnowledgeCategory: (data: { categoryId: string; targetParentId?: string | null }) => Promise<unknown>
  // import
  showImportOpenDialog: () => Promise<string[]>
  readImportFiles: (paths: string[]) => Promise<ImportFileResult[]>
  importPdf: (base64: string, fileName: string) => Promise<{ id?: string; title?: string; fileType?: string; error?: string }>
  importPdfFile: (filePath: string) => Promise<{ id?: string; title?: string; fileType?: string; error?: string }>
  importBinary: (base64: string, fileName: string, fileType: string) => Promise<{ id?: string; title?: string; fileType?: string; error?: string }>
  importBinaryFile: (filePath: string, fileType: string) => Promise<{ id?: string; title?: string; fileType?: string; error?: string }>
  showFolderDialog: () => Promise<string[] | null>
  importFolder: (folderPath: string, parentCategoryId: string | null) => Promise<{ error?: string; name?: string; fileCount?: number; folderCount?: number } | null>
  openExternal: (filePath: string) => Promise<void>
  getAppVersion: () => Promise<string>
  checkForUpdate: () => Promise<{ ok: boolean; hasUpdate: boolean; currentVersion: string; latestVersion: string; releaseUrl: string; notes: string; asset: { name: string; url: string; size: number } | null; message?: string }>
  downloadUpdate: (url: string, name: string, size?: number) => Promise<{ success: boolean; filePath?: string; message?: string; paused?: boolean; cancelled?: boolean; receivedBytes?: number; reason?: 'size-mismatch' | 'sha512-mismatch' | 'network' | 'stalled' | 'channel-all-failed' | 'cancelled' | 'unknown'; step?: 'download' | 'verify' | 'sha512'; metaMissing?: boolean }>
  installUpdate: (filePath: string) => Promise<{ success: boolean; message?: string }>
  updatePauseDownload: () => Promise<{ ok: boolean; message?: string }>
  updateCancelDownload: () => Promise<{ ok: boolean; removedPartial?: boolean; message?: string }>
  onUpdateDownloadProgress: (cb: (p: { percent: number; receivedBytes: number; totalBytes: number }) => void) => () => void
  onUpdateDownloadStage: (cb: (p: { stage: 'downloading' | 'verifying' | 'switching' }) => void) => () => void
  // 更新说明（VS Code 式 tab）
  getReleaseNotesState: () => Promise<ReleaseNotesState>
  markReleaseNotesShown: (version: string) => Promise<{ ok: boolean; error?: string }>
  getReleaseNote: (version: string) => Promise<{ note: ReleaseNote | null; highlights: ReleaseNoteHighlight[] }>
  listReleaseNotes: () => Promise<ReleaseNoteListEntry[]>
  pluginFetchRegistry: () => Promise<{ ok: boolean; plugins: PluginRegistryEntry[]; updatedAt?: string; message?: string }>
  pluginInstall: (url: string, grantedCapabilities?: string[]) => Promise<{ success: boolean; message?: string }>
  onPluginDownloadProgress: (cb: (p: { key: string; received: number; total: number; percent: number; host?: string }) => void) => () => void
  /** 插件集合变化（安装/卸载/启停/内置落位）——后台 code 宿主与插件页监听 */
  onPluginInstalledChanged: (cb: () => void) => () => void
  /** AI vault 写工具落盘后的外部变更通知（payload {relPath, mtimeMs}） */
  onWsExternalChange: (cb: (p: { relPath: string; mtimeMs?: number }) => void) => () => void
  pluginInstallFromFile: (grantedCapabilities?: string[]) => Promise<{ success: boolean; message?: string }>
  pluginInstallBundledSample: (filename: string, grantedCapabilities?: string[]) => Promise<{ success: boolean; message?: string }>
  pluginListInstalled: () => Promise<PluginSummary[]>
  pluginSetEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean; message?: string }>
  pluginUninstall: (id: string) => Promise<{ success: boolean; message?: string }>
  pluginGetContribution: (id: string, key: string) => Promise<{ ok: boolean; data?: unknown; message?: string }>
  pluginListViews: (slot?: string) => Promise<PluginViewContribution[]>
  pluginListCommands: () => Promise<PluginCommandInfo[]>
  pluginListRenderers: () => Promise<PluginRendererInfo[]>
  pluginGetSettingsSchema: (id: string) => Promise<{ schema: PluginSettingItem[] }>
  pluginGetSettingValues: (id: string) => Promise<{ values: Record<string, unknown> }>
  pluginSetSettingValue: (id: string, key: string, value: unknown) => Promise<{ ok: boolean; error?: string }>
  onPluginEvent: (cb: (p: { pluginId: string; event: string; payload: unknown; dropped?: number }) => void) => () => void
  pluginDataQuery: (pluginId: string, table: string, opts?: { where?: Array<{ column: string; op?: string; value: unknown }>; orderBy?: string; desc?: boolean; limit?: number }) => Promise<Record<string, unknown>[]>
  pluginDataInsert: (pluginId: string, table: string, row: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>
  pluginDataUpdate: (pluginId: string, table: string, rowId: string | number, patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  pluginDataDelete: (pluginId: string, table: string, rowId: string | number) => Promise<{ ok: boolean; error?: string }>
  pluginListDeleteFxSkins: () => Promise<DeleteFxSkin[]>
  // v2 协议: Plugin Host Gateway（token 会话 + 主进程单点裁决）
  hostBridgeOpen: (pluginId: string) => Promise<{ ok: boolean; token?: string; hostVersion?: string; code?: string; message?: string }>
  hostBridgeClose: (token: string) => Promise<{ ok: boolean }>
  hostRpc: (msg: { token: string; id: string; method: string; params?: unknown }) => Promise<{ id?: string; ok: boolean; result?: unknown; code?: string; message?: string }>
  pluginSetGranted: (id: string, caps: string[]) => Promise<{ success: boolean; message?: string }>
  pluginAuditList: (id?: string) => Promise<PluginAuditEntry[]>
  pluginAuditClear: (id?: string) => Promise<{ success: boolean }>
  pluginAuditWrite: (id: string, action: string, detail?: unknown) => Promise<{ success: boolean }>
  pluginGetAllowedLevels: () => Promise<string[]>
  pluginSetAllowedLevels: (levels: string[]) => Promise<{ success: boolean; message?: string }>
  knowledgePackGetState: (pluginId: string) => Promise<{ ok: boolean; state?: 'not-imported' | 'imported' | 'update-available' | 'disabled'; version?: string; chapters?: number; totalPages?: number; newPages?: number; changedPages?: number; lastImportedAt?: string; spaceId?: string | null; notebookCount?: number; spaceName?: string; message?: string }>
  knowledgePackImport: (pluginId: string, overwriteModified: boolean, forceExternalIds?: string[]) => Promise<{ ok: boolean; created?: number; updated?: number; skipped?: number; conflicts?: { title: string; reason: string; externalId: string }[]; spaceId?: string | null; message?: string }>
  onKnowledgePackProgress: (cb: (p: { pluginId: string; current: number; total: number; title: string }) => void) => () => void
  getAttachmentsPath: () => Promise<string>
  showImportDataDialog: () => Promise<string[]>
  readImportFile: (filePath: string) => Promise<string | null>
  executeImport: (data: object) => Promise<{ success: boolean; imported: number; skipped: number; message: string }>
  importDb: (srcPath: string) => Promise<{ success: boolean; message: string }>
  previewUserFromDb: (filePath: string) => Promise<{ profile?: { username: string; avatar_path: string; password_hash: string }; stats?: { blogCount: number; scheduleCount: number; knowledgeCount: number }; error?: string }>
  // recycle bin
  getRecycleBinItems: () => Promise<RecycleBinItem[]>
  restoreRecycleBinItem: (id: string) => Promise<void>
  permanentlyDeleteRecycleBinItem: (id: string) => Promise<void>
  restoreRecycleBinPartial: (id: string, path: string) => Promise<void>
  trashRecycleBinItem: (id: string) => Promise<void>
  trashAllRecycleBin: () => Promise<void>
  trashRecycleBinPartial: (id: string, path: string) => Promise<void>
  emptyRecycleBin: () => Promise<void>
  purgeExpiredRecycleBinItems: () => Promise<void>
  // user
  getUserProfile: () => Promise<UserProfile | null>
  setUserUsername: (username: string) => Promise<{ success: boolean }>
  setUserPassword: (password: string) => Promise<{ success: boolean }>
  verifyUserPassword: (password: string) => Promise<boolean>
  verifyImportPassword: (password: string, storedHash: string) => Promise<boolean>
  hasUserPassword: () => Promise<boolean>
  changeUserPassword: (oldPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>
  clearUserPassword: (password: string) => Promise<{ success: boolean; error?: string }>
  pickAvatarFile: () => Promise<string | null>
  saveAvatar: (sourcePath: string) => Promise<{ success: boolean; path: string }>
  getAvatarBase64: () => Promise<string | null>
  getUserStats: () => Promise<UserStats>
  getUserExportData: () => Promise<UserExportData | null>
  restoreUserFromImport: (data: UserImportData) => Promise<{ success: boolean }>
  showExportSaveDialog: (opts: { defaultName: string; filters: { name: string; extensions: string[] }[] }) => Promise<{ filePath: string | null }>
  writeExportTextFile: (filePath: string, content: string, encoding?: string) => Promise<ExportFileResult>
  // toolbox
  getToolboxScripts: () => Promise<ToolboxScript[]>
  getToolboxScriptById: (id: string) => Promise<ToolboxScript | null>
  createToolboxScript: (d: CreateToolboxScriptDTO) => Promise<ToolboxScript>
  updateToolboxScript: (id: string, d: UpdateToolboxScriptDTO) => Promise<ToolboxScript>
  deleteToolboxScript: (id: string) => Promise<void>
  reorderToolboxScripts: (ids: string[]) => Promise<void>
  // password vault
  getPasswordEntries: () => Promise<PasswordEntry[]>
  getPasswordEntryById: (id: string) => Promise<PasswordEntry | null>
  createPasswordEntry: (d: CreatePasswordEntryDTO) => Promise<PasswordEntry>
  updatePasswordEntry: (id: string, d: UpdatePasswordEntryDTO) => Promise<PasswordEntry>
  deletePasswordEntry: (id: string) => Promise<void>
  // moments
  getMomentsPosts: () => Promise<MomentsPost[]>
  getMomentsPostById: (id: string) => Promise<MomentsPost | null>
  createMomentsPost: (d: CreateMomentsPostDTO) => Promise<MomentsPost>
  updateMomentsPost: (id: string, d: UpdateMomentsPostDTO) => Promise<MomentsPost>
  deleteMomentsPost: (id: string) => Promise<void>
  toggleMomentsPin: (id: string) => Promise<MomentsPost>
  getMomentsAlbums: () => Promise<MomentsAlbum[]>
  createMomentsAlbum: (name: string) => Promise<MomentsAlbum | null>
  renameMomentsAlbum: (id: string, name: string) => Promise<MomentsAlbum | null>
  deleteMomentsAlbum: (id: string) => Promise<void>
  setMomentsPostAlbum: (postId: string, albumId: string) => Promise<MomentsPost | null>
  setMomentsAlbumCover: (albumId: string, postId: string, index: number) => Promise<MomentsAlbum | null>
  // attachments
  uploadAttachments: (data: { ownerType?: string; ownerId?: string; files: { name?: string; mime?: string; dataUrl?: string; base64?: string; thumbDataUrl?: string }[] }) => Promise<AttachmentMeta[]>
  uploadAttachmentFromPath: (data: { ownerType?: string; ownerId?: string; filePath: string }) => Promise<AttachmentMeta | null>
  // device transfer (lanShare, toolbox)
  lanShareStart: (opts?: { port?: number; autoStopMinutes?: number }) => Promise<LanShareStatus>
  lanShareStop: () => Promise<{ ok: boolean }>
  lanShareStatus: () => Promise<LanShareStatus>
  lanShareLanAddresses: () => Promise<string[]>
  lanShareQr: (text: string) => Promise<string>
  lanShareListInbox: () => Promise<LanShareInboxFile[]>
  lanShareListOutbox: () => Promise<LanShareOutboxFile[]>
  lanShareRemoveInbox: (name: string) => Promise<{ ok: boolean }>
  lanShareRemoveOutbox: (name: string) => Promise<{ ok: boolean }>
  lanShareAddToOutbox: (data: { path: string }) => Promise<{ ok: boolean; name: string }>
  lanShareClearOutbox: () => Promise<{ ok: boolean }>
  // 编辑器工作区（Vault 仓库）：文件服务
  // D7：选中目录顶层无 .knowbase 时返回 notVault（待确认初始化），不静默建仓库
  workspaceOpenDir: () => Promise<VaultOpenResult | null>
  workspaceInitPendingVault: (accept: boolean) => Promise<{ ok: boolean; rootId?: string; name?: string; path?: string; error?: string }>
  workspaceCreateVault: (name: string, parentPath?: string) => Promise<({ rootId: string; name: string; path: string } & { error?: string }) | null>
  workspaceListDir: (rootId: string, relPath?: string) => Promise<{ entries?: WorkspaceEntry[]; softNames?: string[]; error?: string }>
  workspaceReadFile: (rootId: string, relPath: string) => Promise<WorkspaceReadResult & { error?: string }>
  workspaceReadImage: (rootId: string, relPath: string) => Promise<{ dataUrl?: string; error?: string }>
  workspacePickImages: (rootId: string) => Promise<{ ok: boolean; images?: VaultStagedImage[]; error?: string }>
  workspaceSaveImage: (rootId: string, payload: { fileName: string; dataBase64: string }) => Promise<{ ok: boolean; name?: string; relPath?: string; error?: string }>
  workspaceReadRange: (rootId: string, relPath: string, offset: number, length: number) => Promise<WorkspaceRangeResult & { error?: string }>
  workspaceWriteFile: (rootId: string, relPath: string, content: string, expectedMtimeMs?: number) => Promise<WorkspaceWriteResult>
  workspaceSetMdStatus: (rootId: string, relPath: string, draft: boolean) => Promise<{ ok: boolean; error?: string }>
  /** 全类型归档（docs/vault-archive-all-files-design.md）：md 分流 frontmatter 双态，非 md/目录走清单 */
  workspaceSetArchiveStatus: (rootId: string, relPath: string, archive: boolean) => Promise<{ ok: boolean; count?: number; error?: string }>
  workspaceGetArchiveEntries: (rootId: string) => Promise<{ ok: boolean; entries?: Array<{ id: string; path: string; type: 'file' | 'dir'; archivedAt: string }>; error?: string }>
  workspaceCreateFile: (rootId: string, relPath: string, content?: string) => Promise<{ ok: boolean; error?: string; relPath?: string; renamed?: boolean }>
  workspaceMkdir: (rootId: string, relPath: string) => Promise<{ ok: boolean; error?: string; relPath?: string; renamed?: boolean }>
  workspaceRename: (rootId: string, oldRel: string, newRel: string) => Promise<{ ok: boolean; error?: string }>
  workspaceTrash: (rootId: string, relPath: string) => Promise<{ ok: boolean; error?: string }>
  workspaceStat: (rootId: string, relPath: string) => Promise<{ size: number; mtime: number; isDir: boolean } & { error?: string }>
  workspaceGetRecent: () => Promise<WorkspaceRecent[]>
  workspaceOpenById: (rootId: string) => Promise<{ rootId: string; name: string; path: string } & { error?: string }>
  workspaceGetCurrent: () => Promise<{ rootId: string; name: string; path: string } | null>
  // 在系统文件管理器中打开当前仓库文件夹（标题栏仓库菜单入口）
  workspaceRevealVault: () => Promise<{ ok: boolean; error?: string }>
  // 设置 → 新手引导：把《欢迎》导览页（HTML）导入仓库根并收录进知识库
  // （force=false 且已存在同名文件时返回 exists=true 而不写盘，由渲染层确认后带 force 重来）
  workspaceImportWelcomeDoc: (force?: boolean) => Promise<{ ok: boolean; created?: boolean; exists?: boolean; hasLegacyMd?: boolean; relPath?: string; error?: string }>
  // P8（D8）：重命名当前仓库展示名（roots/登记表/meta.json/最近列表同步，不动磁盘目录名）
  workspaceRenameVault: (name: string) => Promise<{ ok?: boolean; name?: string; error?: string }>
  workspaceForget: (rootId: string) => Promise<{ ok: boolean }>
  workspaceDeleteVault: (rootId: string) => Promise<{ ok?: boolean; deletedCurrent?: boolean; error?: string }>
  workspaceClearCurrentVault: () => Promise<{ ok: boolean; cleared?: string | null }>
  // P6 整仓归档（zip 全量导出/导入；冲突逐条决策：覆盖/跳过/重命名）
  vaultArchiveExport: () => Promise<{ ok?: boolean; canceled?: boolean; path?: string; files?: number; bytes?: number; error?: string }>
  vaultArchiveImportStart: () => Promise<VaultArchiveImportResult>
  vaultArchiveImportDecide: (decisions: VaultArchiveDecision[]) => Promise<{ ok?: boolean; written?: number; skipped?: number; renamed?: number; registered?: string; canceled?: boolean; error?: string }>
  vaultArchiveImportCancel: () => Promise<{ ok: boolean }>
  // Web 剪藏（工具箱「网页剪藏」面板）
  clipperStatus: () => Promise<{
    running: boolean
    port: number
    portDrifted: boolean
    error: string
    token: string
    tokenHint: string
    vault: { name: string; saveDir: string } | null
    extensionDir: string
    clips: { available: boolean; dir: string; items: Array<{ name: string; size: number; mtimeMs: number }> }
  }>
  clipperResetToken: () => Promise<{ ok: boolean; token: string }>
  clipperOpenFolder: () => Promise<{ ok: boolean; error?: string }>
  clipperSelfPing: () => Promise<{ ok: boolean; status?: number; vault?: string | null; error?: string }>
  clipperCheckToken: (candidate: string) => Promise<{ ok: boolean }>
  getAttachmentsByOwner: (ownerType: string, ownerId: string) => Promise<AttachmentMeta[]>
  deleteAttachment: (id: string) => Promise<void>
  getAttachmentPath: (id: string) => Promise<string | null>
  readAttachmentBase64: (id: string) => Promise<string | null>
  readAttachmentBase64ByFileName: (fileName: string) => Promise<string | null>
  cleanupOrphanAttachments: () => Promise<{ removed: number }>
  importBackupPackage: (srcPath: string) => Promise<{ success: boolean; imported: number; skipped: number; attachments: number; message: string }>
  vaultBackupExportToZip: (zipPath: string) => Promise<{ ok: boolean; fileCount: number; zipPath: string }>
  vaultBackupPickArchive: () => Promise<string | null>
  vaultBackupRestoreArchive: (archivePath: string) => Promise<{ ok: boolean; target?: string; written?: number; message?: string }>
  // checkin
  habitGetAll: () => Promise<{ habits: Habit[]; records: HabitRecord[] }>
  createHabit: (d: CreateHabitDTO) => Promise<Habit>
  updateHabit: (id: string, d: UpdateHabitDTO) => Promise<Habit>
  deleteHabit: (id: string) => Promise<void>
  toggleHabitCheck: (habitId: string, date: string) => Promise<{ checked: boolean }>
  reorderHabits: (orderedIds: string[]) => Promise<void>
  habitLinkSave: (habitId: string, link: HabitLink | null) => Promise<void>
  habitLinkRemove: (habitId: string) => Promise<void>
  onHabitAutoChecked: (cb: (items: HabitAutoCheckin[]) => void) => () => void
  // bookmark nav
  bookmarkGetAll: () => Promise<{ categories: BookmarkCategory[]; bookmarks: BookmarkItem[] }>
  createBookmarkCategory: (d: { name: string; color?: string }) => Promise<BookmarkCategory>
  updateBookmarkCategory: (id: string, d: { name?: string; color?: string }) => Promise<BookmarkCategory | null>
  deleteBookmarkCategory: (id: string) => Promise<void>
  reorderBookmarkCategories: (orderedIds: string[]) => Promise<void>
  createBookmarkItem: (d: { title: string; url: string; description?: string; categoryId?: string }) => Promise<BookmarkItem>
  updateBookmarkItem: (id: string, d: { title?: string; url?: string; description?: string; categoryId?: string | null }) => Promise<BookmarkItem | null>
  deleteBookmarkItem: (id: string) => Promise<void>
  openBookmarkUrl: (url: string) => Promise<void>
  pickBookmarkImportFile: () => Promise<string | null>
  // remote supervise
  superviseGetConfig: () => Promise<SuperviseConfig>
  superviseSaveConfig: (partial: Partial<SuperviseConfig>) => Promise<SuperviseConfig>
  superviseTest: () => Promise<{ ok: boolean; error?: string }>
  superviseGetHistory: (limit?: number) => Promise<SuperviseLog[]>
  superviseRetry: (id: number) => Promise<SuperviseLog | null>
  superviseRetryAllFailed: () => Promise<{ total: number; ok: number }>
  superviseSendDailyNow: () => Promise<{ ok: boolean; skipped?: string; error?: string }>
  superviseClearHistory: () => Promise<void>
  // period summary (weekly / monthly)
  createPomodoroSession: (minutes: number) => Promise<boolean>
  getBlogPeriodStats: (start: string, end: string) => Promise<{
    checkins: number
    blogEntries: number
    knowledgePages: number
    pomodoroMinutes: number
    scheduleDone: number
  }>
  // blog templates
  listBlogTemplates: () => Promise<BlogTemplate[]>
  createBlogTemplate: (d: { name: string; contentMd?: string }) => Promise<BlogTemplate | null>
  updateBlogTemplate: (id: string, d: { name?: string; contentMd?: string }) => Promise<BlogTemplate | null>
  deleteBlogTemplate: (id: string) => Promise<void>
  // quiz records (收藏 + 错题本)
  quizRecordGetByPage: (pageId: string) => Promise<QuizRecordDto[]>
  quizRecordReport: (pageId: string, quizNo: number, correct: boolean, meta: { pageTitle?: string; snapshot?: QuizSnapshotDto }) => Promise<QuizRecordDto | null>
  quizRecordToggleFavorite: (pageId: string, quizNo: number, meta: { pageTitle?: string; snapshot?: QuizSnapshotDto }) => Promise<QuizRecordDto>
  quizRecordList: (opts?: { kind?: 'favorite' | 'wrong' | 'all'; sourceSpace?: string; collectionId?: string }) => Promise<QuizRecordDto[]>
  quizRecordRemove: (pageId: string, quizNo: number) => Promise<void>
  quizRecordSetCollections: (recordId: string, collectionIds: string[]) => Promise<void>
  quizRecordSetNote: (recordId: string, note: string) => Promise<void>
  quizRecordSetTags: (recordId: string, tagIds: string[]) => Promise<void>
  quizRecordAddTags: (recordIds: string[], tagIds: string[]) => Promise<void>
  quizRecordStats: (opts?: { sourceSpace?: string }) => Promise<QuizStatsDto>
  quizTagList: () => Promise<QuizTagDto[]>
  quizTagCreate: (name: string, kind?: string) => Promise<QuizTagDto>
  quizTagDelete: (tagId: string) => Promise<void>
  quizCollectionList: () => Promise<QuizCollectionDto[]>
  quizCollectionCreate: (name: string) => Promise<QuizCollectionDto>
  quizCollectionRename: (id: string, name: string) => Promise<QuizCollectionDto>
  quizCollectionDelete: (id: string) => Promise<void>
  // quiz plugin data（JSON 通道）
  quizDataStats: (opts?: { sourceSpace?: string }) => Promise<QuizDataStats>
  quizDataExport: (opts?: { sourceSpace?: string }) => Promise<{ ok: boolean; path?: string; count?: number; error?: string }>
  quizDataClearMastered: (opts?: { sourceSpace?: string }) => Promise<{ ok: boolean; removed: number; error?: string }>
  quizDataClearAll: (opts?: { sourceSpace?: string }) => Promise<{ ok: boolean; removed: number; error?: string }>
  // fill popup
  isFillPopup: boolean
  isDayPanel: boolean
  // 日程与打卡侧边栏（内嵌 + 可脱离；独立态支持三种桌面互动模式）
  dayPanelGetState: () => Promise<{ detached: boolean; mode: string; collapsed: boolean; widgetInteractive: boolean }>
  dayPanelPopout: () => Promise<boolean>
  dayPanelDockBack: () => Promise<boolean>
  dayPanelToggle: () => Promise<boolean>
  dayPanelSetMode: (m: string) => Promise<string>
  dayPanelTopdockExpand: () => Promise<void>
  dayPanelTopdockCollapseIntent: () => Promise<void>
  dayPanelTopdockCancelCollapse: () => Promise<void>
  dayPanelWidgetInteractive: (active: boolean) => Promise<boolean>
  /** 渲染层报告 document 所需尺寸（用于独立窗口高度自适应） */
  dayPanelReportContentSize: (width: number, height: number) => void
  onDayPanelStateChanged: (cb: (s: { detached: boolean; mode: string; collapsed: boolean; widgetInteractive: boolean }) => void) => () => void
  onDayPanelModeChanged: (cb: (s: { mode: string }) => void) => () => void
  onDayPanelCollapsedChanged: (cb: (s: { collapsed: boolean }) => void) => () => void
  onDayPanelWidgetInteractiveChanged: (cb: (s: { interactive: boolean }) => void) => () => void
  onDayPanelToggleVisibility: (cb: () => void) => () => void
  dayPanelOpenInMain: (tab: string, tool?: string) => void
  onMainCommand: (cb: (payload: { type: string; tab?: string; tool?: string }) => void) => () => void
  dataNotify: (payload: { scope: string }) => void
  onDataChanged: (cb: (payload: { scope: string }) => void) => () => void
  fillPopupTheme: string
  fillPopupGetEntries: () => Promise<PasswordEntry[]>
  fillPopupCopy: (field: string, value: string) => Promise<void>
  fillPopupHide: () => Promise<void>
  /** 悬浮小密码本内直接新增条目（返回带明文密码的新条目） */
  fillPopupCreateEntry: (data: { title?: string; url?: string; username?: string; account?: string; password?: string; notes?: string }) => Promise<PasswordEntry>
  /** 切换小密码本置顶（同时由渲染层写入 settings.fillPopupAlwaysOnTop 持久化） */
  fillPopupSetAlwaysOnTop: (on: boolean) => Promise<boolean>
  onFillPopupRefresh: (cb: () => void) => () => void
  // AI tools (ToolRegistry)
  aiToolsList: () => Promise<AiToolsListResult>
  aiToolsInvoke: (name: string, args?: unknown) => Promise<AiToolInvokeResult>
  aiToolsGetUsage: () => Promise<AiToolUsage>
  aiToolsGetRecentAudit: (limit?: number) => Promise<AuditEntryInfo[]>
  // MCP servers
  mcpListServers: () => Promise<McpServerInfo[]>
  mcpAddServer: (draft: McpServerDraft) => Promise<McpServerInfo>
  mcpUpdateServer: (id: string, patch: Partial<McpServerDraft>) => Promise<McpServerInfo | null>
  mcpRemoveServer: (id: string) => Promise<boolean>
  mcpToggleServer: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string } & Partial<McpServerInfo>>
  mcpListTools: (id: string) => Promise<{ tools: McpToolPreview[] }>
  mcpRefreshTools: (id: string) => Promise<{ ok: boolean; error?: string; tools: McpToolPreview[] }>
  mcpTestConnection: (draft: McpServerDraft) => Promise<McpTestResult>
  // Skills
  aiToolsListSkills: () => Promise<{ skills: SkillInfo[] }>
  aiToolsCopySkillPrompt: (pluginId: string, skillId: string) => Promise<boolean>
  aiToolsInstallSkill: (data: Uint8Array, fileName?: string) => Promise<SkillInstallResult>
  aiToolsInstallSkillFromFile: () => Promise<SkillInstallResult>
  aiToolsUninstallSkill: (id: string) => Promise<SkillInstallResult>
  aiToolsToggleSkill: (registryName: string, enabled: boolean) => Promise<SkillInstallResult & { disabled?: boolean }>
  // Model gateway + agent
  llmListProviders: () => Promise<{ providers: LlmProviderInfo[]; defaultChatModel: string }>
  llmSaveProvider: (draft: LlmProviderDraft) => Promise<{ ok: boolean; id?: string; error?: string }>
  llmRemoveProvider: (id: string) => Promise<{ ok: boolean }>
  llmToggleProvider: (id: string, enabled: boolean) => Promise<{ ok: boolean }>
  llmTestConnection: (draft: { type: LlmProviderType; baseUrl: string; apiKey?: string; id?: string; headers?: Record<string, string> }) => Promise<LlmTestResultInfo>
  llmVisionModels: () => Promise<{ models: LlmVisionModelInfo[] }>
  llmRefreshModels: (id: string) => Promise<{ ok: boolean; models: string[]; error?: string }>
  llmAddModel: (id: string, model: string) => Promise<{ ok: boolean; models: string[]; error?: string }>
  llmSetDefaultModel: (value: string) => Promise<{ ok: boolean }>
  llmTestModel: (providerId: string, model: string) => Promise<LlmModelTestResultInfo>
  llmGetUsage: () => Promise<LlmUsageInfo>
  llmUsageBreakdown: () => Promise<{ month: string; entries: LlmUsageBreakdownEntry[] }>
  // 划词翻译 / 离线词典
  dictLookup: (word: string) => Promise<DictLookupResult>
  dictStatus: () => Promise<DictStatus>
  translateInvoke: (req: TranslateInvokeRequest) => Promise<TranslateInvokeResult>
  // 番茄钟状态跨窗口同步（主进程权威快照，所有 BrowserWindow 共享）
  pomodoroUpdateState: (snapshot: { visible: boolean; display: string; running: boolean; phase: string; done: boolean; expanded: boolean; progress: number }) => void
  pomodoroGetState: () => Promise<{ visible: boolean; display: string; running: boolean; phase: string; done: boolean; expanded: boolean; progress: number }>
  onPomodoroState: (cb: (snapshot: { visible: boolean; display: string; running: boolean; phase: string; done: boolean; expanded: boolean; progress: number }) => void) => () => void
  // PDF 工具箱
  pdfMerge: (files: Array<{ name: string; data: Uint8Array }>) => Promise<PdfOpResult>
  pdfOrganize: (payload: { data: Uint8Array; pages: number[]; rotations?: Record<string, number> }) => Promise<PdfOpResult>
  pdfExport: (payload: { data: Uint8Array; defaultName: string; kind?: 'pdf' | 'txt' }) => Promise<PdfExportResult>
  /** 界面逐页阅读：当前仓库内 .pptx → [{n,text}] */
  docsPptxPages: (relPath: string) => Promise<{ ok: boolean; pages?: Array<{ n: number; text: string }>; total?: number; error?: string }>
  agentChat: (req: { sessionId: string; message: string; context?: AgentContextInfo; chatId?: string; source?: string; modelId?: string; effort?: 'off' | 'low' | 'medium' | 'high'; skillName?: string }) => Promise<AgentChatResult>
  agentRegenerate: (req: { sessionId: string; context?: AgentContextInfo; chatId?: string }) => Promise<AgentChatResult>
  agentStartScene: (req: { sessionId: string; context?: AgentContextInfo; chatId?: string; source?: string; modelId?: string }) => Promise<AgentChatResult>
  agentEditMessage: (req: { sessionId: string; messageId: string; message: string; context?: AgentContextInfo; chatId?: string }) => Promise<AgentChatResult>
  agentDeleteMessage: (sessionId: string, messageId: string) => Promise<boolean>
  /** 会话压缩（/compress 指令 + 自动预检共用）：折叠检查点后旧轮为纪要并推进检查点 */
  agentCompressSession: (req: { sessionId: string; modelId?: string; providerId?: string; effort?: string }) => Promise<AgentCompressResult>
  agentAbort: (chatId: string) => Promise<boolean>
  /** AgentRunner 实时过程步骤（llm/tool 每步完成即推送，payload {chatId, step}） */
  onAgentStep: (cb: (p: { chatId: string; step: AgentTraceStep }) => void) => () => void
  /** AgentRunner 流式增量（思考链 / 正文 / 工具进行中；主进程已合批，payload {chatId, event}） */
  onAgentStream: (cb: (p: { chatId: string; event: AgentStreamEvent }) => void) => () => void
  agentSessions: () => Promise<AgentSessionInfo[]>
  agentNewSession: (title?: string, source?: AgentSessionSource) => Promise<AgentSessionInfo>
  agentMessages: (sessionId: string) => Promise<AgentStoredMessage[]>
  agentRenameSession: (id: string, title: string) => Promise<boolean>
  agentSetSessionInstructions: (id: string, instructions: string) => Promise<{ ok: boolean; error?: string }>
  agentDeleteSession: (id: string) => Promise<boolean>
  // ===== v3.1.2 条目11：支线旁问（createSideLane 只装上下文、不调 LLM）=====
  agentCreateSideLane: (payload: { parentSessionId: string; anchorMessageId: string; contextTurns?: number }) => Promise<AgentSideLaneCreateResult>
  /** 列某主线下的支线（含已升格）；删除前计数亦用它 */
  agentListSideLanes: (parentSessionId: string) => Promise<AgentSessionInfo[]>
  /** 升格支线为正式会话（单向） */
  agentPromoteSideLane: (laneSessionId: string) => Promise<boolean>
  // ===== AI教学 P1：会话 ⇄ 文件夹绑定（docs/ai-teaching-module-rework.md §二）=====
  aiTeachEnsureSessionFolder: (id: string) => Promise<{ ok: boolean; relPath?: string | null; error?: string }>
  aiTeachSessionFolder: (id: string) => Promise<{ ok: boolean; relPath?: string | null; error?: string }>
  aiTeachRenameSessionFolder: (id: string, title: string) => Promise<{ ok: boolean; relPath?: string | null; error?: string }>
  aiTeachDeleteSessionFolder: (id: string) => Promise<{ ok: boolean; relPath?: string | null; error?: string }>
  aiTeachReadConstraints: (id: string) => Promise<{ ok: boolean; text?: string; relPath?: string | null; error?: string }>
  aiTeachGlobalEnsureConstraints: () => Promise<{ ok: boolean; text?: string; relPath?: string | null; created?: boolean; error?: string }>
  /** v3.1.2 条目6：工作区约束文档（{工作区}/CONSTRAINTS.md）——ensure 落骨架并返回 relPath 跳编辑区；本工作区会话每轮注入 */
  aiTeachWorkspaceEnsureConstraints: (wsId: string) => Promise<{ ok: boolean; text?: string; relPath?: string | null; created?: boolean; error?: string }>
  aiTeachWriteConstraints: (id: string, text: string) => Promise<{ ok: boolean; text?: string; relPath?: string | null; error?: string }>
  aiTeachOrganizeDoc: (id: string, title: string, content: string, prefix?: string) => Promise<{ ok: boolean; relPath?: string | null; error?: string }>
  // P5 工作区两层（§3.2-6；元数据入 .knowbase/modules/aiTeaching/workspaces.json）
  aiTeachListWorkspaces: () => Promise<{ workspaces: AiTeachWorkspaceInfo[]; sessionWs: Record<string, string>; unassignedCount: number; lastWorkspaceId: string | null }>
  aiTeachCreateWorkspace: (name: string) => Promise<{ ok: boolean; workspace?: AiTeachWorkspaceInfo; error?: string }>
  aiTeachRenameWorkspace: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>
  aiTeachDeleteWorkspace: (id: string) => Promise<{ ok: boolean; error?: string }>
  aiTeachAssignSession: (id: string, wsId: string) => Promise<{ ok: boolean; error?: string }>
  aiTeachUnassignSession: (id: string) => Promise<{ ok: boolean; error?: string }>
  aiTeachSetLastWorkspace: (wsId: string | null) => Promise<{ ok: boolean; error?: string }>
  aiTeachSrcRead: (id: string) => Promise<AiTeachSourcesResult>
  aiTeachSrcAdd: (id: string, input: AiTeachSourceInput) => Promise<AiTeachSourcesResult>
  aiTeachSrcRemove: (id: string, no: number) => Promise<AiTeachSourcesResult>
  aiTeachSrcExtract: (id: string, no: number) => Promise<{ ok: boolean; relPath?: string; error?: string }>
  aiTeachSrcPick: () => Promise<{ ok: boolean; path: string | null; error?: string }>
  aiTeachSrcPickDir: () => Promise<{ ok: boolean; path: string | null; error?: string }>
  aiTeachSrcVisionCheck: () => Promise<{ ok: boolean; model?: string; error?: string }>
  /** LibreOffice 探测（设置页「检测」按钮）；source 说明路径命中来源，便于给用户可读解释 */
  aiTeachSrcSofficeProbe: (settingPath?: string) => Promise<{ ok: boolean; path?: string; source?: string }>
  aiTeachSrcPdfBytes: (id: string, no: number) => Promise<{ ok: boolean; base64?: string; error?: string }>
  aiTeachSrcTranscribe: (id: string, no: number, pages: { n: number; dataUrl: string }[], modelSpec?: string) => Promise<{ ok: boolean; relPath?: string; model?: string; done?: number[]; skipped?: number[]; failed?: number[]; error?: string }>
  aiTeachSrcWebProbe: (id: string, no: number, anchorUrl?: string) => Promise<WebProbeResult>
  aiTeachSrcWebCrawl: (id: string, no: number, urls: string[]) => Promise<WebCrawlResult>
  aiTeachSrcWebCancel: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** v3.1.1：把对话级登记（含原件/提取稿复制）上收到工作区主库 */
  aiTeachSrcPromote: (id: string) => Promise<AiTeachSourcesResult>
  aiTeachProfileReadGlobal: () => Promise<{ ok: boolean; text?: string; relPath?: string | null; skeleton?: string; error?: string }>
  aiTeachProfileWriteGlobal: (text: string) => Promise<{ ok: boolean; error?: string }>
  aiTeachProfileReadSession: (id: string) => Promise<{ ok: boolean; text?: string; relPath?: string | null; skeleton?: string; error?: string }>
  aiTeachProfileWriteSession: (id: string, text: string) => Promise<{ ok: boolean; relPath?: string | null; error?: string }>
  aiTeachProfileReadWorkspace: (id: string) => Promise<{ ok: boolean; text?: string; relPath?: string | null; skeleton?: string; error?: string }>
  aiTeachProfileWriteWorkspace: (id: string, text: string) => Promise<{ ok: boolean; relPath?: string | null; error?: string }>
  aiTeachProfileEnsureGlobal: () => Promise<{ ok: boolean; relPath?: string; created?: boolean; error?: string }>
  aiTeachProfileEnsureSession: (id: string) => Promise<{ ok: boolean; relPath?: string; created?: boolean; error?: string }>
  aiTeachProfileEnsureWorkspace: (id: string) => Promise<{ ok: boolean; relPath?: string; created?: boolean; error?: string }>
  llmReasoningCapable: (model: string) => Promise<boolean>
  onAiTeachTreeRefresh: (cb: (p: { dirRel: string }) => void) => () => void
  onAiTeachWebProgress: (cb: (p: { sessionId: string; no: number; done: number; total: number; current: string }) => void) => () => void
  onAiTeachNotice: (cb: (msg: string) => void) => () => void
  llmCcSwitchList: () => Promise<CcSwitchScanResult>
  llmCcSwitchImport: (ids: string[]) => Promise<CcSwitchImportResult>
}

// 开发者工具(仅 DEV 构建暴露,正式版 window.devtoolsApi 为 undefined)
export interface DevtoolsHelpDocMeta {
  fileName: string
  title: string
  category: string
  icon: string
}

export interface DevtoolsAPI {
  helpDocsList: () => Promise<{ docs: DevtoolsHelpDocMeta[]; dirty: string[] }>
  helpDocsRead: (fileName: string) => Promise<DevtoolsHelpDocMeta & { body: string; dirty: boolean; error?: string }>
  helpDocsWrite: (doc: { fileName: string; title: string; category: string; icon: string; body: string }) => Promise<{ ok?: boolean; fileName?: string; error?: string }>
  helpDocsDelete: (fileName: string) => Promise<{ ok?: boolean; error?: string }>
}

declare global { interface Window { api: ElectronAPI; devtoolsApi?: DevtoolsAPI } }
