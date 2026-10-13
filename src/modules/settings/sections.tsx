import { Palette, Type, SlidersHorizontal, Database, ShieldCheck, Bot, Keyboard, Boxes, Info } from 'lucide-react'
import { SETTINGS } from '../../lib/settings'
import type { AiTab, SettingsSection } from '../../lib/settings'

/**
 * 设置模块的大项 / 小项定义与搜索索引（S1 起 schema 单源化）。
 * - key 类小项（有 default 的存储设置）：由 src/lib/settings.ts 的 SETTINGS 元数据自动生成，
 *   新增设置只改 schema 一处，索引自动覆盖（消灭手写双源）。
 * - 功能页入口（模板管理 / MCP / Skill / 快捷键组等无存储 key 的页面直达）：
 *   保留少量手写 ENTRY_ITEMS，锚点直达对应视图区块。
 * 搜索逻辑（打分/分词/锚点广播）沿用原实现。
 */

export type { AiTab, SettingsSection }

/** Schema 中某项的元数据类型（settings.ts 内联） */
export interface SchemaItemMeta {
  type: string
  label: string
  group: string
  desc: string
  keywords: string[]
  section: SettingsSection
  ui: boolean
  scope: string
  level: string
  affects: string
  anchor?: string
  aiTab?: AiTab
}

/** 读取 schema 某项（SETTINGS 为异构字面量，经统一接口访问） */
function metaOf(key: string): SchemaItemMeta {
  const raw = SETTINGS as unknown as Record<string, SchemaItemMeta & { default: unknown }>
  const m = raw[key]
  if (!m) throw new Error(`[settings] 未知设置 key: ${key}`)
  return m
}

export interface SectionDef {
  id: SettingsSection
  label: string
  icon: React.ReactNode
  /** 大项级别的别名（搜这些词时该大项下所有小项都会被召回） */
  keywords: string[]
}

export interface SettingItem {
  /** 唯一 id，同时作为 DOM 锚点 data-setting-anchor 的值（schema 项=anchor；入口项=自身 id） */
  id: string
  section: SettingsSection
  /** 所属分组小标题，用于面包屑显示 */
  group: string
  /** 小项名称 */
  label: string
  /** 一句话说明 */
  desc?: string
  /** 中英文别名，用于扩大召回 */
  keywords: string[]
  /** 仅 AI 工具大项需要：该小项所在的内部页签 */
  aiTab?: AiTab
}

export const SECTIONS: SectionDef[] = [
  { id: 'appearance', label: '外观',   icon: <Palette size={16} />,            keywords: ['外观', '主题', 'theme', '界面', '样式', '皮肤', '布局', '图标', '密度', '删除动画'] },
  { id: 'editor',     label: '编辑器与阅读', icon: <Type size={16} />,         keywords: ['编辑器', 'editor', '阅读', 'pdf', '编写', '输入', '字体', '行号', '自动保存'] },
  { id: 'general',    label: '通用与行为', icon: <SlidersHorizontal size={16} />, keywords: ['通用', '行为', '启动', '缩放', 'zoom', '外壳', 'workbench', '界面'] },
  { id: 'data',       label: '数据与仓库', icon: <Database size={16} />,       keywords: ['数据', '仓库', '存储', '备份', '导出', '回收站', 'vault', '博客读源'] },
  { id: 'security',   label: '安全与隐私', icon: <ShieldCheck size={16} />,   keywords: ['安全', '隐私', '删除确认', '插件安全', '签名', '密钥'] },
  { id: 'aiTools',    label: 'AI 工具',   icon: <Bot size={16} />,            keywords: ['AI', '工具', 'agent', '智能体', 'ai', '助手', '模型', 'mcp', 'skill'] },
  { id: 'shortcuts',  label: '快捷键',    icon: <Keyboard size={16} />,       keywords: ['快捷键', 'shortcut', '键盘', 'keyboard', '按键'] },
  { id: 'modules',    label: '模块设置',  icon: <Boxes size={16} />,          keywords: ['模块', '博客', 'blog', '日程', '提醒', '打卡', '导出', '错题', '高级', 'AI教学'] },
  { id: 'about',      label: '关于',      icon: <Info size={16} />,           keywords: ['关于', '更新', '版本', '升级', '镜像', '引导', 'about', 'update'] },
]

export const SECTION_MAP: Record<SettingsSection, SectionDef> =
  SECTIONS.reduce((acc, s) => { acc[s.id] = s; return acc }, {} as Record<SettingsSection, SectionDef>)

/**
 * 从 schema 生成"有设置页落点"的 key 项（ui:true 且声明了 anchor）。
 * 无 anchor / ui:false 的 key（含功能页内 UI、模块内 UI、约束类）暂不进设置页搜索，
 * S2/S4 按域重排与自动表单逐批显形。
 */
function schemaKeyItems(): SettingItem[] {
  const out: SettingItem[] = []
  for (const key of Object.keys(SETTINGS)) {
    const m = metaOf(key)
    if (!m.ui || !m.anchor) continue
    out.push({
      id: m.anchor,
      section: m.section,
      group: m.group,
      label: m.label,
      desc: m.desc,
      keywords: m.keywords,
      aiTab: m.aiTab,
    })
  }
  return out
}

/**
 * 功能页入口（无存储 key，直达管理界面/区块），维持原手写清单。
 * S2 按域重排时随视图迁移归属。
 */
const ENTRY_ITEMS: SettingItem[] = [
  // ===== 博客 =====
  { id: 'blog.templates', section: 'modules', group: '博客模板', label: '博客模板',
    desc: '写日记时一键套用的 Markdown 模板', keywords: ['模板', '博客模板', '新建模板', 'template', '套用', 'markdown'] },
  // ===== AI 工具 =====
  { id: 'aiTools.usage', section: 'aiTools', group: '工具调用量', label: '工具调用量',
    desc: '本自然月 AI 工具累计调用次数', keywords: ['用量', '调用量', '额度', '统计', 'usage', '次数', '本月'] },
  { id: 'aiTools.builtin', section: 'aiTools', group: '内置工具', label: '内置工具清单', aiTab: 'builtin',
    desc: '官方内置只读工具，不可关闭', keywords: ['内置工具', '工具', 'tool', '注册表', '只读'] },
  { id: 'aiTools.audit', section: 'aiTools', group: '最近调用', label: '最近调用记录', aiTab: 'builtin',
    desc: '最近 10 条调用审计记录', keywords: ['审计', '日志', '记录', 'audit', '调用记录', '历史'] },
  { id: 'aiTools.mcp', section: 'aiTools', group: 'MCP 服务器', label: 'MCP 服务器', aiTab: 'mcp',
    desc: '连接外部 Model Context Protocol 服务器', keywords: ['mcp', '服务器', '外部工具', 'server', 'sse', 'stdio', '连接'] },
  { id: 'aiTools.skill', section: 'aiTools', group: 'Skill 技能', label: 'Skill 技能', aiTab: 'skill',
    desc: '插件提供的声明式提示词资产', keywords: ['skill', '技能', '提示词', 'prompt', '资产'] },
  { id: 'aiTools.models', section: 'aiTools', group: '模型', label: '模型配置', aiTab: 'models',
    desc: 'AI 模型与 API 密钥配置', keywords: ['模型', 'model', 'api', 'key', '密钥', '大模型', 'llm', '配置模型'] },
  { id: 'aiTools.perms', section: 'aiTools', group: '权限', label: '调用权限', aiTab: 'perms',
    desc: 'AI 工具调用的权限控制', keywords: ['权限', 'permission', '授权', '允许', '拒绝', '安全'] },
  // ===== 高级 =====
  { id: 'advanced.update', section: 'about', group: '关于与更新', label: '检查更新',
    desc: '当前版本号与在线更新', keywords: ['更新', '升级', '版本', '检查更新', 'update', 'version', '新版本'] },
  { id: 'advanced.deleteConfirm', section: 'security', group: '删除确认', label: '删除确认',
    desc: '博客 / 知识库 / 目录 / 章节删除时是否弹确认框', keywords: ['删除确认', '确认', '对话框', '弹窗', '跳过', 'confirm'] },
  { id: 'advanced.onboarding', section: 'about', group: '新手引导', label: '新手引导',
    desc: '重新查看新手引导', keywords: ['引导', '新手', '教程', 'onboarding', '向导', '引导页'] },
  { id: 'advanced.welcomeImport', section: 'about', group: '新手引导', label: '导入《欢迎》页面',
    desc: '把欢迎导览页(欢迎.html)写回仓库并收录进知识库', keywords: ['欢迎', '欢迎页', '导入', '恢复', '导览', 'welcome', 'html', '知识库', '误删'] },
  { id: 'advanced.storage', section: 'data', group: '备份与恢复', label: '整仓备份',
    desc: '整仓备份恢复（.knowbase 整包 zip）与数据导出', keywords: ['仓库', 'vault', '备份', '恢复', '导出', 'storage', '存储'] },
  // ===== 快捷键 =====
  // ★ 2026-10-13 L1 真源化之后：这 11 条的 id / group 必须与 src/lib/commandRegistry.ts 的
  //   COMMAND_GROUPS 一一对应（组数、组名、顺序三者对齐），否则设置搜索会跳到错的组或空锚
  //   —— 契约 §5 断言这个双射。desc / keywords 仍**手写**：它们是检索排序的第一杠杆
  //   （见 docs/ui-updates.md §44 记的「keywords 也会抢别人的分」），不随真源生成。
  { id: 'shortcuts.global', section: 'shortcuts', group: '全局', label: '全局快捷键',
    desc: '侧栏折叠、命令面板、快速打开、全局搜索（左栏搜索态）、缩放、AI 助手与小窗、撤销重做', keywords: ['全局', '侧栏', '折叠', 'escape', 'esc', '关闭弹窗', 'ctrl b', '命令面板', 'ctrl shift p', '快速打开', 'ctrl o', 'ctrl p', 'ctrl shift f', '反引号', '缩放', 'ctrl j', 'ai 助手', '全局搜索', '全屏学堂', 'ctrl shift j', '右栏', 'ctrl alt b', '撤销', '重做', 'ctrl z', 'ctrl y'] },
  { id: 'shortcuts.kbEditor', section: 'shortcuts', group: '知识库 — 编辑器', label: '知识库编辑器快捷键',
    desc: '保存、阅读编辑切换、页面历史、AI 内联续写、插图脚注', keywords: ['保存', '预览', 'ctrl s', 'markdown 预览', 'ctrl /', 'ctrl e', '页面历史', 'alt', '后退', '前进', '内联建议', '续写', 'alt a', '插图', '脚注', 'ctrl shift i', 'ctrl alt f'] },
  // 真源新增组（B1 收录范围）：写作面这 8 键此前只在手册里，设置页从来没有
  { id: 'shortcuts.kbWriting', section: 'shortcuts', group: '知识库 — 写作面', label: '知识库写作面快捷键',
    desc: '加粗、斜体、链接、标题档与正文、查找', keywords: ['写作面', '编辑器内', '加粗', '斜体', '链接', '标题', '正文', '查找', 'markdown', 'ctrl b', 'ctrl i', 'ctrl k', 'ctrl alt 1', 'ctrl alt 0', 'ctrl f'] },
  { id: 'shortcuts.kbSidebar', section: 'shortcuts', group: '知识库 — 侧栏', label: '知识库侧栏快捷键',
    desc: '重命名、删除、复制剪切粘贴选中项', keywords: ['重命名', 'f2', '删除', '侧栏', 'rename', '复制', '剪切', '粘贴', 'ctrl c', 'ctrl x', 'ctrl v'] },
  { id: 'shortcuts.kbTabs', section: 'shortcuts', group: '知识库 — Tab 管理', label: '知识库 Tab 快捷键',
    desc: '新建 / 关闭 / 切换标签页', keywords: ['tab', '标签页', '新建页面', '新建知识页', '关闭', '切换', 'ctrl w', 'ctrl tab'] },
  { id: 'shortcuts.kbReading', section: 'shortcuts', group: '知识库 — 阅读', label: '知识库阅读快捷键',
    desc: '沉浸阅读进出', keywords: ['沉浸阅读', 'ctrl shift r', 'escape', '阅读'] },
  // 原 id 为 shortcuts.editorModule —— 该模块 2026-09-20 已物理退役，组内只剩 PDF 那几行是真的，
  // 故改组。2026-10-13 组名再由「PDF 阅读器」改为「电子书阅读器」（翻页键 PDF 与 EPUB 都吃）；
  // anchor id 仍是 shortcuts.pdfKeys（内部标识，跟着改会牵动深链与契约，对用户不可见）。
  { id: 'shortcuts.pdfKeys', section: 'shortcuts', group: '电子书阅读器', label: '电子书阅读器快捷键',
    desc: 'PDF 内搜索、翻页、缩放，翻页键电子书同样适用', keywords: ['pdf', 'pdf 搜索', 'ctrl f', '翻页', 'pageup', 'pagedown', '下一页', '上一页', '空格', '缩放', 'ctrl 0', 'ctrl =', '电子书', 'epub', '阅读器'] },
  // 真源新增组：图片查看器四键（都不带修饰键）此前只在手册里
  { id: 'shortcuts.imageKeys', section: 'shortcuts', group: '图片查看器', label: '图片查看器快捷键',
    desc: '适应窗口、实际大小、左右旋转', keywords: ['图片', '看图', '查看图片', '适应窗口', '实际大小', '旋转', '向左旋转', '向右旋转', '0', '1'] },
  { id: 'shortcuts.blogKeys', section: 'shortcuts', group: '博客', label: '博客快捷键',
    desc: '新建今日文章、保存并关闭、预览、大纲', keywords: ['博客快捷键', '新建文章', 'ctrl n', '保存并关闭', '大纲', 'ctrl alt o'] },
  { id: 'shortcuts.scheduleKeys', section: 'shortcuts', group: '日程', label: '日程快捷键',
    desc: '新建任务、关闭弹窗、置顶停靠、桌面小组件', keywords: ['日程快捷键', '新建任务', '任务', 'ctrl n', 'ctrl alt s', '置顶停靠', '桌面小组件', 'ctrl alt up', 'ctrl alt down'] },
  { id: 'shortcuts.passwordKeys', section: 'shortcuts', group: '密码本', label: '密码本快捷键',
    desc: '密码填充弹窗开关（系统级）', keywords: ['密码', '密码填充', '填充弹窗', 'ctrl alt p', 'password', 'fill'] },

  // ===== 提醒 =====
    { id: 'reminder.enable', section: 'modules', group: '打卡提醒', label: '启用打卡提醒',
    desc: '到点提醒当天未打卡的习惯', keywords: ['打卡', '提醒', '启用', '开关', 'checkin', '通知'] },
    { id: 'reminder.time', section: 'modules', group: '打卡提醒', label: '提醒时间',
    desc: '每天触发打卡提醒的时间点', keywords: ['时间', '提醒时间', '几点', '打卡时间', '20:00'] },
]

/** 搜索/推荐使用的小项全集：schema 生成（20 key 项，顺序=文件序）+ 功能入口（18） */
export const SETTING_ITEMS: SettingItem[] = [...schemaKeyItems(), ...ENTRY_ITEMS]

/** 空查询时展示的热门推荐项 */
export const RECOMMENDED_IDS = [
  'editor.font',
  'appearance.theme',
  'editor.lineNumbers',
  'advanced.zoom',
  'reminder.enable',
  'export.encoding',
  'aiTools.models',
  'shortcuts.global',
]

export const RECOMMENDED_ITEMS: SettingItem[] = RECOMMENDED_IDS
  .map(id => SETTING_ITEMS.find(i => i.id === id))
  .filter((i): i is SettingItem => !!i)

// ===== 检索 =====

export interface SearchHit {
  item: SettingItem
  score: number
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')

const ASCII_RE = /^[\x20-\x7e]+$/

/** 子序列匹配：用于英文拼写容错（"lne" → "line numbers"） */
function isSubsequence(hay: string, needle: string): boolean {
  if (!needle) return false
  let i = 0
  for (let k = 0; k < hay.length && i < needle.length; k++) {
    if (hay[k] === needle[i]) i++
  }
  return i === needle.length
}

/** 单字段打分：0 表示未命中 */
function scoreField(field: string, token: string, base: { exact: number; starts: number; contains: number; fuzzy: number }): number {
  if (!field) return 0
  if (field === token) return base.exact
  if (field.startsWith(token)) return base.starts
  if (field.includes(token)) return base.contains
  if (ASCII_RE.test(token) && token.length >= 2 && isSubsequence(field, token)) return base.fuzzy
  return 0
}

const W_LABEL = { exact: 120, starts: 100, contains: 80, fuzzy: 26 }
const W_KEYWORD = { exact: 80, starts: 66, contains: 56, fuzzy: 22 }
const W_GROUP = { exact: 62, starts: 54, contains: 46, fuzzy: 18 }
const W_SECTION = { exact: 72, starts: 64, contains: 56, fuzzy: 18 }
const W_DESC = { exact: 0, starts: 0, contains: 32, fuzzy: 0 }

/**
 * 按空格/常见分隔符切词（先切再压空格），
 * 保证 "ctrl n" 不会被压成 "ctrln" 而让 "ln" 之类的短词误命中。
 */
function toWords(s: string): string[] {
  return s.toLowerCase()
    .split(/[\s,，、/·—]+/)
    .map(w => w.trim())
    .filter(Boolean)
}

/** 单个英文字母/数字：只认前缀匹配，避免 "a" 命中 20+ 项噪音 */
const SINGLE_CHAR_RE = /^[a-z0-9]$/
const strict = (w: typeof W_LABEL) => ({ exact: w.exact, starts: w.starts, contains: 0, fuzzy: 0 })

function bestFieldScore(words: string[], token: string, w: typeof W_LABEL): number {
  let best = 0
  for (const word of words) {
    const sc = scoreField(word, token, w)
    if (sc > best) best = sc
    if (best >= w.exact) break
  }
  return best
}

/** 把查询串切成 token；多词查询按空格分词后逐个参与 AND 匹配 */
function tokenize(q: string): string[] {
  const parts = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return parts
  // 多词时不再额外加入"拼接整体"，否则 "ai 模型" 会因 "ai模型" 无法命中而被整体判负
  return parts
}

/**
 * 检索设置项。多个 token 时要求全部命中（AND），得分为各 token 累加。
 */
export function searchSettings(query: string, limit?: number): SearchHit[] {
  const q = query.trim()
  if (!q) return []
  const tokens = tokenize(q)
  const hits: SearchHit[] = []

  for (const item of SETTING_ITEMS) {
    const section = SECTION_MAP[item.section]
    const labelWords = toWords(item.label)
    const keywordWords = item.keywords.flatMap(k => toWords(k))
    const groupWords = toWords(item.group)
    const sectionWords = [section.label, ...section.keywords].flatMap(k => toWords(k))
    const desc = norm(item.desc ?? '')

    let total = 0
    let ok = true
    for (const tk of tokens) {
      const single = SINGLE_CHAR_RE.test(tk)
      const wLabel = single ? strict(W_LABEL) : W_LABEL
      const wKeyword = single ? strict(W_KEYWORD) : W_KEYWORD
      const wGroup = single ? strict(W_GROUP) : W_GROUP
      const wSection = single ? strict(W_SECTION) : W_SECTION

      let best = 0
      best = Math.max(best, bestFieldScore(labelWords, tk, wLabel))
      if (best < wLabel.exact) best = Math.max(best, bestFieldScore(keywordWords, tk, wKeyword))
      if (best < wKeyword.exact) best = Math.max(best, bestFieldScore(groupWords, tk, wGroup))
      if (best < wGroup.exact) best = Math.max(best, bestFieldScore(sectionWords, tk, wSection))
      if (!single && best < W_DESC.contains) best = Math.max(best, scoreField(desc, tk, W_DESC))
      if (best === 0) { ok = false; break }
      total += best
    }
    if (!ok) continue
    hits.push({ item, score: total })
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const ia = SECTIONS.findIndex(s => s.id === a.item.section)
    const ib = SECTIONS.findIndex(s => s.id === b.item.section)
    if (ia !== ib) return ia - ib
    return SETTING_ITEMS.indexOf(a.item) - SETTING_ITEMS.indexOf(b.item)
  })

  return limit && limit > 0 ? hits.slice(0, limit) : hits
}

/** 命中项在小项列表中的数量（用于左侧大项角标） */
export function countBySection(hits: SearchHit[]): Record<string, number> {
  const acc: Record<string, number> = {}
  for (const h of hits) acc[h.item.section] = (acc[h.item.section] ?? 0) + 1
  return acc
}

// ===== 跳转锚点广播 =====
// 搜索跳转的目标锚点除用于滚动高亮外，还广播给各视图：
// 若目标落在默认收起的 CollapseList 分组内，视图据此自动展开。

type AnchorListener = (id: string | null) => void
let pendingAnchor: string | null = null
const anchorListeners = new Set<AnchorListener>()

/** 记录并广播待跳转锚点（jumpTo 时调用） */
export function setPendingAnchor(id: string | null) {
  pendingAnchor = id
  anchorListeners.forEach(l => l(id))
}

/** 视图挂载/更新时消费：锚点归属本组则返回 true 并清除 */
export function consumePendingAnchor(id: string): boolean {
  if (pendingAnchor === id) { pendingAnchor = null; return true }
  return false
}

/** 订阅后续跳转（视图已挂载时二次跳转走这里），返回退订函数 */
export function subscribePendingAnchor(l: AnchorListener): () => void {
  anchorListeners.add(l)
  return () => { anchorListeners.delete(l) }
}

/**
 * 输入补齐：返回可直接补全到输入框尾部的文本。
 * 只在候选项中存在"以当前输入开头且更长"的小项名称时返回。
 */
export function completionFor(query: string, candidates: SettingItem[]): string {
  const raw = query.trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  for (const c of candidates) {
    const label = c.label
    if (label.length > raw.length && label.toLowerCase().startsWith(lower)) {
      return label.slice(raw.length)
    }
  }
  return ''
}
