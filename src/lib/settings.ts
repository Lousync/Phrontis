/**
 * 集中式 Settings Schema —— 所有设置 key、默认值、类型，以及 UI 选项列表统一在此定义。
 * 新增一个 setting 只需在这里加一行，前后端自动获得类型安全。
 */

// ===== 选项列表（供 UI 渲染） =====

export const THEME_OPTIONS = [
  { id: 'dark',  label: '深色' },
  { id: 'light', label: '浅色' },
] as const

/**
 * Apply a theme class to <html> — clears any previous theme-* class, adds the new one.
 *  Call this whenever the user switches themes. New themes only need a new THEME_OPTIONS entry
 *  and a matching `html.theme-<id>` CSS block.
 *
 *  动效（docs/ui-animation-plan.md §五 F 类）：
 *  主题切换的视觉是「整屏换色」，用通配选择器做过渡会让每帧对全文档做样式重算 + 颜色插值
 *  （实测 4290 节点下单帧 133ms、界面冻结），故改用 View Transition —— 截两张快照做交叉淡化，
 *  逐节点成本为零（实测与瞬时切换帧分布一致），过渡时长/缓动在 index.css 的
 *  ::view-transition-old/new(root) 里统一配置。
 *  首次应用主题（页面上还没有 theme-* 类）不启用过渡，避免首屏白白淡入一次。
 */
export function applyThemeClass(themeId: string): void {
  const root = document.documentElement
  const apply = (): void => {
    root.className = root.className
      .split(/\s+/)
      .filter(c => !c.startsWith('theme-'))
      .join(' ')
    root.classList.add(`theme-${themeId}`)
  }

  const hasTheme = /(^|\s)theme-/.test(root.className)
  const reduce = typeof window !== 'undefined' && !!window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (hasTheme && !reduce && typeof document.startViewTransition === 'function') {
    try {
      document.startViewTransition(apply)
      return
    } catch {
      // 快照失败（如文档不可见）时退回瞬时切换
    }
  }
  apply()
}

export const FONT_OPTIONS = [
  { id: 'system',    label: '系统默认',   sample: 'System UI' },
  { id: 'yahei',     label: '微软雅黑',   sample: 'Microsoft YaHei' },
  { id: 'dengxian',  label: '等线',       sample: 'DengXian' },
  { id: 'heiti',     label: '黑体',       sample: 'SimHei' },
  { id: 'noto',      label: '思源黑体',   sample: 'Noto Sans SC' },
  { id: 'notoserif', label: '思源宋体',   sample: 'Noto Serif SC' },
  { id: 'songti',    label: '宋体',       sample: 'SimSun' },
  { id: 'fangsong',  label: '仿宋',       sample: 'FangSong' },
  { id: 'kaiti',     label: '楷体',       sample: 'KaiTi' },
  { id: 'lxgw',      label: '霞鹜文楷',   sample: 'LXGW WenKai' },
  { id: 'times',     label: '西文衬线',   sample: 'Times New Roman' },
  { id: 'mono',      label: '等宽字体',   sample: 'Cascadia Code' },
] as const

/** 字体 ID → CSS font-family（链条末端的兜底保证任何机器都可用） */
export const FONT_CSS_MAP: Record<string, string> = {
  system:    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  yahei:     "'Microsoft YaHei', '微软雅黑', sans-serif",
  dengxian:  "'DengXian', '等线', 'Microsoft YaHei', sans-serif",
  heiti:     "'SimHei', '黑体', 'Microsoft YaHei', sans-serif",
  noto:      "'Source Han Sans SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif",
  notoserif: "'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif",
  songti:    "'SimSun', '宋体', 'Noto Serif SC', serif",
  fangsong:  "'FangSong', '仿宋', 'SimSun', serif",
  kaiti:     "'KaiTi', '楷体', 'SimSun', serif",
  lxgw:      "'LXGW WenKai', '霞鹜文楷', 'KaiTi', '楷体', serif",
  times:     "'Times New Roman', Georgia, 'SimSun', serif",
  mono:      "'Cascadia Code', 'Fira Code', 'Consolas', 'Microsoft YaHei', monospace",
}

export const ENCODING_OPTIONS = [
  { id: 'utf-8',   label: 'UTF-8',   desc: '国际通用' },
  { id: 'gbk',     label: 'GBK',     desc: 'Windows 默认' },
  { id: 'gb2312',  label: 'GB2312',  desc: '简体中文' },
] as const

export const ICON_SIZE_OPTIONS = [
  { id: 's', label: '小' },
  { id: 'm', label: '中' },
  { id: 'l', label: '大' },
] as const

export const BLOG_SIZE_OPTIONS = [
  { id: 's', label: '紧凑' },
  { id: 'm', label: '标准' },
  { id: 'l', label: '宽松' },
] as const

/** 知识库侧边栏条目大小（树行密度：行高 + 字号） */
export const KNOWLEDGE_SIDEBAR_SIZE_OPTIONS = [
  { id: 's', label: '紧凑' },
  { id: 'm', label: '标准' },
  { id: 'l', label: '宽松' },
] as const

/** 知识库侧边栏条目大小 → CSS 变量（--kb-row-py 树行内边距 / --kb-row-py-lg 章节行内边距 / --kb-row-fs 行字号）。
 *  三档必须拉开足够差距，否则切换时视觉几乎无变化（用户会以为设置无效）。
 *  字号对齐全应用侧栏规格（资源管理器/博客树 12~12.5px）：紧凑 11.5 / 标准 12.5 / 宽松 16。 */
export const KNOWLEDGE_SIDEBAR_ITEM_VARS: Record<string, Record<string, string>> = {
  s: { '--kb-row-py': '0px', '--kb-row-py-lg': '2px', '--kb-row-fs': '11.5px' },
  m: { '--kb-row-py': '3px', '--kb-row-py-lg': '5px', '--kb-row-fs': '12.5px' },
  l: { '--kb-row-py': '9px', '--kb-row-py-lg': '12px', '--kb-row-fs': '16px' },
}

export const FONT_SIZE_OPTIONS = [
  { id: 12, label: '12px' },
  { id: 13, label: '13px' },
  { id: 14, label: '14px' },
  { id: 15, label: '15px' },
  { id: 16, label: '16px' },
  { id: 18, label: '18px' },
  { id: 20, label: '20px' },
] as const

// ===== 设置定义 =====

export const SETTINGS = {
  theme: { default: 'dark', type: 'select', label: '应用主题', group: '主题', desc: '深色 / 浅色配色，以及插件提供的主题包', keywords: ['主题', 'theme', '深色', '浅色', 'dark', 'light', '夜间', '配色'], section: 'appearance', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'appearance.theme' },
  editorFont: { default: 'system', type: 'select', label: '字体样式', group: '字体', desc: '编辑器正文使用的字体', keywords: ['字体', 'font', '字体样式', '字型', 'typeface'], section: 'editor', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'editor.font' },
  deleteFxSkin: { default: 'builtin', type: 'select', label: '删除动画皮肤', group: '主题与皮肤', desc: '知识库删除条目时的吞噬特效外观；插件可贡献自定义皮肤', keywords: ['删除动画', '删除特效', '吞噬', '火焰', '进度条', '皮肤', 'fx', 'delete'], section: 'appearance', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'appearance.deleteFx' },
  showLineNumbers: { default: true, type: 'toggle', label: '显示行号', group: '显示', desc: '编辑器左侧是否显示行号', keywords: ['行号', '显示行号', 'linenumber', 'line numbers', 'gutter'], section: 'editor', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'editor.lineNumbers' },
  editorFontSize: { default: 13, type: 'number', label: '字号', group: '字号', desc: '编辑器正文字号（可直接输入数字）', keywords: ['字号', '字体大小', '大小', 'fontsize', 'font size'], section: 'editor', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'editor.fontSize', min: 10, max: 40, step: 1, unit: 'px' },
  zoom: { default: 1.0, type: 'number', label: '界面缩放', group: '缩放', desc: '整体界面缩放比例（可直接输入百分比）', keywords: ['缩放', 'zoom', '放大', '缩小', '重置', '比例', '界面大小'], section: 'general', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'advanced.zoom', min: 85, max: 150, step: 5, unit: '%' },
  markdownDim: { default: true, type: 'toggle', label: 'Markdown 标记淡化', group: '显示', desc: '弱化版所见即所得：编辑时淡化 Markdown 标记，光标行保留原始标记', keywords: ['markdown', '淡化', '标记', 'md', 'dim', '弱化'], section: 'editor', ui: true, scope: 'global', level: 'normal', affects: 'live' , anchor: 'editor.markdownDim' },
  sidebarTreeGuides: { default: 'line', type: 'select', label: '侧栏层级参考线', group: '显示', desc: '编辑器 / 知识库 / AI教学 左栏多层树的层级竖线样式：实线 / 虚线 / 关闭', keywords: ['树', '层级', '参考线', '竖线', '缩进', '指南线', 'tree', 'guide', 'indent'], section: 'editor', ui: false, scope: 'global', level: 'normal', affects: 'live', anchor: 'editor.treeGuides' },
  folderFocusStyle: { default: 'skeleton', type: 'select', label: '目录聚焦样式', group: '显示', desc: '目录聚焦开启时（编辑器/知识库侧栏准星按钮），非当前路径分支的呈现方式：骨架条（悬停显原名）/ 直接隐藏', keywords: ['目录聚焦', '聚焦', '骨架', '沉浸文件夹', '隐藏', 'folder', 'focus', 'skeleton'], section: 'editor', ui: false, scope: 'global', level: 'normal', affects: 'live', anchor: 'editor.folderFocus' },
  editorFolderFocus: { default: false, type: 'toggle', label: '编辑器目录聚焦', group: '显示', desc: '文件树只显示当前打开文件所在目录链；侧栏「准星」按钮同款开关，重启保留', keywords: ['目录聚焦', '聚焦', '文件树', '沉浸', 'focus'], section: 'editor', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  knowledgeFolderFocus: { default: false, type: 'toggle', label: '知识库目录聚焦', group: '显示', desc: '知识库树只显示当前页面所在目录链；侧栏「准星」按钮同款开关，重启保留', keywords: ['目录聚焦', '聚焦', '知识库', '沉浸', 'focus'], section: 'editor', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  exportEncoding: { default: 'utf-8', type: 'select', label: '默认编码', group: '导出', desc: '导出文件的默认字符编码', keywords: ['编码', 'encoding', 'utf', 'utf8', 'utf-8', 'gbk', 'gb2312', 'bom', '乱码'], section: 'data', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'export.encoding' },
  skipDeleteConfirm_blog: { default: false, type: 'toggle', label: '博客删除确认', group: '删除确认', desc: '跳过博客文章删除确认', keywords: ['删除确认', '博客', '跳过', 'confirm'], section: 'security', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  skipDeleteConfirm_knowledge: { default: false, type: 'toggle', label: '知识库页面删除确认', group: '删除确认', desc: '跳过知识库页面删除确认', keywords: ['删除确认', '页面', '知识库', '跳过', 'confirm'], section: 'security', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  skipDeleteConfirm_knowledgeCategory: { default: false, type: 'toggle', label: '目录/笔记本删除确认', group: '删除确认', desc: '跳过目录/笔记本删除确认', keywords: ['删除确认', '目录', '笔记本', '跳过', 'confirm'], section: 'security', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  skipDeleteConfirm_chapter: { default: false, type: 'toggle', label: '章节删除确认', group: '删除确认', desc: '跳过章节删除确认', keywords: ['删除确认', '章节', '跳过', 'confirm'], section: 'security', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  trashExportDir: { default: '', type: 'text', label: '回收站导出目录', group: '回收站', desc: '回收站文件导出的目标目录', keywords: ['回收站', '导出', '目录', 'trash', 'export'], section: 'data', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  recycleBinRetentionDays: { default: 30, type: 'number', label: '回收站保留天数', group: '回收站', desc: '回收站内文件保留的天数，过期自动清除', keywords: ['回收站', '保留', '天数', 'retention', '清理'], section: 'data', ui: true, scope: 'global', level: 'normal', affects: 'live', min: 1, max: 3650, step: 1, unit: '天', anchor: 'data.recycleDays' },
  pdfReaderMode: { default: 'builtin', type: 'select', label: 'PDF 阅读方式', group: 'PDF 阅读', desc: 'builtin=内置阅读器，external=本地工具打开', keywords: ['pdf', '阅读', '阅读器', 'external', '内置'], section: 'editor', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  scheduleIconSize: { default: 'm', type: 'segmented', label: '日程图标大小', group: '密度与尺寸', desc: '日程模块图标大小（小/中/大）', keywords: ['日程', '图标', '大小', 'schedule', 'icon'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  blogCardSize: { default: 'm', type: 'segmented', label: '博客卡片大小', group: '密度与尺寸', desc: '博客列表卡片的尺寸密度（可直接输入像素）', keywords: ['卡片大小', '博客卡片', '卡片', '密度', 'card', '布局'], section: 'appearance', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'appearance.blogCardSize' },
  knowledgeSidebarItemSize: { default: 'm', type: 'segmented', label: '知识库侧边栏条目大小', group: '密度与尺寸', desc: '侧边栏树形条目的行高与字号（可直接输入像素）', keywords: ['侧边栏条目', '行高', '条目大小', '树形', '紧凑', '宽松'], section: 'appearance', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'appearance.knowledgeSidebarItemSize' },
  sidebarWidth_blog: { default: 240, type: 'number', label: '博客边栏宽度', group: '边栏宽度', desc: '博客模块侧边栏宽度', keywords: ['边栏', '宽度', 'sidebar', 'width', '博客'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: 'px' },
  sidebarWidth_schedule: { default: 240, type: 'number', label: '日程边栏宽度', group: '边栏宽度', desc: '日程模块侧边栏宽度', keywords: ['边栏', '宽度', 'sidebar', 'width', '日程'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: 'px' },
  sidebarWidth_knowledgeCat: { default: 240, type: 'number', label: '知识库分类栏宽度', group: '边栏宽度', desc: '知识库分类栏宽度', keywords: ['边栏', '宽度', '分类栏', 'sidebar', 'width', '知识库'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: 'px' },
  sidebarWidth_knowledgePages: { default: 240, type: 'number', label: '知识库页面栏宽度', group: '边栏宽度', desc: '知识库页面栏宽度', keywords: ['边栏', '宽度', '页面栏', 'sidebar', 'width', '知识库'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: 'px' },
  sidebarWidth_knowledgeChapters: { default: 240, type: 'number', label: '知识库章节栏宽度', group: '边栏宽度', desc: '知识库章节栏宽度', keywords: ['边栏', '宽度', '章节栏', 'sidebar', 'width', '知识库'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: 'px' },
  sidebarWidth_devtools: { default: 176, type: 'number', label: '开发者工具边栏宽度', group: '边栏宽度', desc: '开发者工具模块边栏宽度', keywords: ['边栏', '宽度', 'devtools', 'sidebar', 'width'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: 'px' },
  sidebarWidth_devtoolsDocs: { default: 208, type: 'number', label: '帮助文档列表栏宽度', group: '边栏宽度', desc: '开发者工具帮助文档列表栏宽度', keywords: ['边栏', '宽度', '帮助文档', 'sidebar', 'width'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: 'px' },
  autoSaveDebounceMs: { default: 2000, type: 'number', label: '自动保存延迟', group: '保存', desc: '停止输入后自动保存的延迟时间（可直接输入毫秒）', keywords: ['自动保存', '保存', '防抖', 'autosave', '延迟', 'debounce'], section: 'general', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'advanced.autosave', min: 100, max: 30000, step: 100, unit: 'ms' },
  exportStatusClearMs: { default: 5000, type: 'number', label: '导出成功提示时长', group: '导出', desc: '导出成功提示停留时间', keywords: ['导出', '提示', '停留', 'status', '毫秒'], section: 'data', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: 'ms' },
  skipDeleteConfirm_toolboxScript: { default: false, type: 'toggle', label: '工具箱脚本删除确认', group: '删除确认', desc: '跳过工具箱脚本删除确认', keywords: ['删除确认', '工具箱', '脚本', '跳过'], section: 'security', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  /** v3.2.0 第 20 项：画像更新建议里「删除类条目」的二次确认（默认要确认） */
  skipProfileDeleteConfirm: { default: false, type: 'toggle', label: '画像更新删除确认', group: '删除确认', desc: '跳过「画像更新建议」里删除类条目的二次确认', keywords: ['删除确认', '画像', 'AI教学', '学习者画像', '跳过', 'confirm', 'profile'], section: 'security', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  zoomMin: { default: 0.85, type: 'number', label: '缩放下限', group: '缩放', desc: '界面缩放下限（约束，勿手改）', keywords: ['缩放', '下限', 'zoom'], section: 'general', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  zoomMax: { default: 1.5, type: 'number', label: '缩放上限', group: '缩放', desc: '界面缩放上限（约束，勿手改）', keywords: ['缩放', '上限', 'zoom'], section: 'general', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  zoomStep: { default: 0.05, type: 'number', label: '缩放步进', group: '缩放', desc: '界面缩放步进（约束，勿手改）', keywords: ['缩放', '步进', 'zoom'], section: 'general', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  // ⚠️ 默认值里**不能出现**不在活动栏图标位上的 id。这里曾混着 `export`（模块早已不存在）与
  // `recycle`（回收站已移进底部设置菜单）—— `recycle` 那次是真出过事故：启动兜底会沿着这张顺序表
  // 找"第一个没被隐藏的模块"，而 recycle 永远隐藏不掉，于是把侧边栏模块全隐藏后重启就开回收站。
  // 存量用户的活动栏顺序由 ActivityBar 的归一逻辑自行补齐（desktop 顶首位 / 缺失模块追加），
  // 所以这里只保留图标位模块、相对次序不动即可。
  activityBarOrder: { default: '["editor","blog","schedule","knowledge","moments","toolbox","plugins"]', type: 'json', label: '活动栏图标顺序', group: '活动栏', desc: '活动栏模块图标顺序（JSON）', keywords: ['活动栏', '顺序', '图标', 'activitybar', 'order'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  activityBarHidden: { default: '[]', type: 'json', label: '活动栏隐藏模块', group: '活动栏', desc: '活动栏隐藏的模块（JSON）', keywords: ['活动栏', '隐藏', '模块', 'activitybar', 'hidden'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  // 布局（VS Code Customize Layout 同款）：整条活动栏显隐。与上面 activityBarHidden（逐模块显隐）互不干扰——
  // 本键关的是「活动栏这个容器本身」，标题栏那枚「布局」按钮与命令面板「布局：隐藏活动栏」是它的两个入口。
  // ui:false 与同组两键一致：入口在布局菜单/命令面板，不在设置页（避免与「显示/隐藏模块」混淆）
  activityBarVisible: { default: true, type: 'toggle', label: '显示活动栏', group: '活动栏', desc: '关闭后隐藏最左侧模块活动栏（标题栏「布局」按钮可随时调回）', keywords: ['活动栏', '布局', '隐藏', '侧边栏', 'activitybar', 'visible', 'layout'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  toolboxHiddenTools: { default: '[]', type: 'json', label: '工具箱隐藏工具', group: '工具箱', desc: '工具箱画廊中隐藏的工具 id 列表（JSON，内置工具用 id，插件工具用 pluginId:toolId）', keywords: ['工具箱', '隐藏', '工具', '显示', 'toolbox', 'hidden'], section: 'modules', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  startupTab: { default: 'blog', type: 'select', label: '启动时默认显示', group: '启动', desc: '每次打开应用时自动进入的模块', keywords: ['启动', '默认模块', '首页', 'startup', '默认显示', '初始模块'], section: 'general', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'appearance.startupTab' },
  startupVaultPicker: { default: true, type: 'toggle', label: '每次启动选择仓库', group: '启动', desc: '开启后每次进入应用先显示仓库选择页（已有仓库一键进入）；关闭则直连上次的仓库', keywords: ['启动', '仓库', '选择', '进入', 'vault', 'startup', '切库'], section: 'general', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'startup.vaultPicker' },
  summaryWeeklyDay: { default: 0, type: 'select', label: '周总结日', group: '周期总结', desc: '每周在哪一天生成周总结', keywords: ['周总结', '总结日', '每周', '星期', '周几', 'weekly', '周报'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'blog.summaryWeeklyDay' },
  summaryMonthlyMode: { default: 'last', type: 'select', label: '月总结规则', group: '周期总结', desc: '每月总结规则：第一天 / 最后一天 / 固定日', keywords: ['月总结', '总结日', '每月', '月末', '月初', 'monthly', '月报'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'blog.summaryMonthlyMode' },
  summaryMonthlyFixedDay: { default: 1, type: 'number', label: '固定日期', group: '周期总结', desc: '固定日模式下，每月哪一天为月总结日', keywords: ['固定日期', '固定日', '几号', '月总结'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'blog.summaryMonthlyFixedDay', min: 1, max: 28, step: 1 },
  sidebarIconStyle: { default: 'default', type: 'select', label: '侧边栏图标风格', group: '图标', desc: '活动栏模块图标风格；安装带图标包的插件后自动追加', keywords: ['侧边栏图标', '图标包', '图标', '活动栏', 'icon', 'sidebar'], section: 'appearance', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'appearance.sidebarIcons' },
  checkinReminderEnabled: { default: true, type: 'toggle', label: '启用打卡提醒', group: '打卡提醒', desc: '到点提醒当天未打卡的习惯', keywords: ['打卡', '提醒', '启用', '开关', 'checkin', '通知'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'reminder.enable' },
  checkinReminderTime: { default: '20:00', type: 'time', label: '提醒时间', group: '打卡提醒', desc: '每天触发打卡提醒的时间点', keywords: ['时间', '提醒时间', '几点', '打卡时间', '20:00'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'reminder.time' },

  // ---- 日程截止（DDL）提醒：系统通知主通道；逻辑见 electron/lib/scheduleReminder.ts ----
  scheduleReminderEnabled: { default: true, type: 'toggle', label: '启用截止提醒', group: '截止提醒', desc: '任务临近截止时通过系统通知提醒（应用需在运行）', keywords: ['截止', '提醒', '系统通知', '通知', 'ddl', 'reminder', 'notification', '临近'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'reminder.ddlEnable' },
  scheduleReminderLead: { default: '30', type: 'select', label: '提前多久提醒', group: '截止提醒', desc: '在截止时刻之前多久发出提醒（绝对时刻，与软件是否打开无关）', keywords: ['提前', '提前量', '提前多久', 'lead', '几分钟', '提醒时间', 'ddl'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'reminder.ddlLead' },
  scheduleReminderOverdueRepeat: { default: false, type: 'toggle', label: '逾期后重复提醒', group: '截止提醒', desc: '任务已过截止时间仍未完成时，继续在后续巡检中提醒；默认只在到点前后提醒一次', keywords: ['逾期', '过期', '重复', '再提醒', 'overdue', 'ddl', '超时'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'reminder.ddlOverdue' },
  scheduleReminderQuietStart: { default: '22:30', type: 'time', label: '免打扰开始', group: '截止提醒', desc: '进入该时刻后不再发送提醒（跨天区间，如 22:30 ~ 次日 07:30）', keywords: ['免打扰', '静默', '勿扰', '夜里', 'quiet', '安静'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'reminder.ddlQuiet' },
  scheduleReminderQuietEnd: { default: '07:30', type: 'time', label: '免打扰结束', group: '截止提醒', desc: '越过该时刻后恢复提醒；免打扰期间错过的提醒会在结束后补发一次', keywords: ['免打扰', '静默', '勿扰', '早晨', 'quiet', '恢复'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'reminder.ddlQuiet' },
  scheduleReminderExternalPush: { default: false, type: 'toggle', label: '同时推送外部通道', group: '截止提醒', desc: '除系统通知外，另通过「远程监督」已配置的 webhook 推送；需先在远程监督中完成配置', keywords: ['外部', '推送', 'webhook', '远程监督', '手机', 'external', 'push'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'reminder.ddlExternal' },
  lanShareAutoStopMinutes: { default: 15, type: 'number', label: '设备传输自动关闭', group: '设备互联', desc: '设备传输无连接自动关闭分钟数', keywords: ['设备传输', '传输', '自动关闭', '超时', 'lanshare'], section: 'modules', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: '分钟' },
  onboardingDone: { default: false, type: 'toggle', label: '新手引导完成', group: '引导', desc: '是否已完成新手引导（由引导流程维护）', keywords: ['引导', '新手', 'onboarding'], section: 'about', ui: false, scope: 'global', level: 'normal', affects: 'live' },

  // ---- 更新说明（VS Code 式 tab）：清单由 CHANGELOG 生成，阅读记录落仓库 .knowbase/modules/release-notes/ ----
  // 详见 docs/release-notes-design.md
  releaseNotesAutoOpen: { default: true, type: 'toggle', label: '新版本时自动打开更新说明', group: '更新说明', desc: '中间版本号（x.y）变化后的首次启动，自动打开一页更新说明；修正版（x.y.z）不打扰', keywords: ['更新说明', '更新日志', '发布说明', '新版本', '自动打开', 'release notes', 'changelog'], section: 'about', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'advanced.releaseNotes' },
  releaseNotesKeepHistory: { default: true, type: 'toggle', label: '在仓库中保留更新说明存档', group: '更新说明', desc: '把当前版本的更新说明与阅读记录写进仓库 .knowbase/modules/release-notes/，换电脑拷走仓库一并带走', keywords: ['更新说明', '存档', '保留', '阅读记录', 'release notes', 'knowbase'], section: 'about', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'advanced.releaseNotes' },
  badgeEggActivated: { default: false, type: 'toggle', label: '角标彩蛋', group: '彩蛋', desc: '彩蛋：标题栏角标变为 YHAz（外观页输入 YHAz 激活）', keywords: ['彩蛋', '角标', 'YHAz', 'badge'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  aiToolMonthlyLimit: { default: 0, type: 'number', label: '月度调用上限', group: '工具调用', desc: '每月最多调用次数，0 表示不限制', keywords: ['上限', '限制', '每月', '调用上限', 'limit', '额度', '配额'], section: 'aiTools', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'aiTools.monthlyLimit', aiTab: 'builtin', min: 0, max: 1000000, step: 10 },
  aiSkillDisabled: { default: '[]', type: 'json', label: '停用 Skill', group: 'Skill', desc: '停用的 Skill 注册名列表（JSON）', keywords: ['skill', '停用', '禁用', '技能'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live', aiTab: 'skill' },
  modelProviders: { default: '', type: 'json', label: '模型供应商', group: '模型', desc: 'LLM 供应商列表（加密存储，渲染层不可解）', keywords: ['模型', '供应商', 'provider', 'llm'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live', aiTab: 'models' },
  defaultChatModel: { default: '', type: 'text', label: '默认对话模型', group: '模型', desc: '默认对话模型（格式 providerId:modelId）', keywords: ['模型', '默认', 'chat', 'model'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live', aiTab: 'models' },
  llmMaxTokens: { default: 4096, type: 'number', label: '单次 maxTokens 上限', group: '模型', desc: '单次调用 maxTokens 上限', keywords: ['token', 'maxTokens', '上限', '输出长度'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live', aiTab: 'models', min: 128, max: 131072, step: 256 },
  aiStreamEnabled: { default: true, type: 'toggle', label: '流式输出', group: '对话输出', desc: 'AI 回复逐字输出并实时显示工具调用过程；关闭后退回一次性返回（供应商不支持流式时也会自动回退）', keywords: ['流式', '逐字', '打字机', 'stream', '输出', '过程', '时间线'], section: 'aiTools', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'aiTools.stream', aiTab: 'models' },
  agentMaxRounds: { default: 16, type: 'number', label: '最大推理轮数', group: 'Agent 循环', desc: '单次请求内 LLM 决策轮数上限，耗尽后自动做一次总结收场（不会丢弃已获取的信息）；复杂任务可调大', keywords: ['轮数', '推理', 'agent', '上限', '循环', '迭代'], section: 'aiTools', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'aiTools.agentLoop', aiTab: 'builtin', min: 2, max: 64, step: 1 },
  agentRunTokenBudget: { default: 500000, type: 'number', label: '单次请求 token 预算', group: 'Agent 循环', desc: '各轮累计 token 达到此值即进入总结收场（防止失控循环烧费用），0 表示不限制', keywords: ['token', '预算', '费用', '上限', '失控'], section: 'aiTools', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'aiTools.agentLoop', aiTab: 'builtin', min: 0, max: 10000000, step: 50000 },
  agentContextBudgetTokens: { default: 24000, type: 'number', label: '历史上下文预算', group: 'Agent 循环', desc: '注入模型的历史消息按 token 预算裁剪（保首尾、中间轮丢弃），0 表示不裁剪', keywords: ['上下文', '历史', '裁剪', 'token', '预算'], section: 'aiTools', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'aiTools.agentLoop', aiTab: 'builtin', min: 0, max: 200000, step: 2000 },
  agentCompressionEnabled: { default: true, type: 'toggle', label: '历史自动压缩', group: 'Agent 循环', desc: '上下文达到触发线时自动把较早的对话折叠为持久化纪要（代替直接丢弃），也可随时输入 /compress 手动触发；关闭后退回裁剪', keywords: ['压缩', '纪要', 'compact', 'compress', '上下文', '历史'], section: 'aiTools', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'aiTools.agentLoop', aiTab: 'builtin' },
  agentCompressAtPercent: { default: 80, type: 'number', label: '自动压缩触发线(%)', group: 'Agent 循环', desc: '上下文估算达到历史预算的该百分比时自动压缩（80 = 预算用到八成先压再发）；越低压得越早、压缩调用越频繁，范围 50-100', keywords: ['压缩', '触发', '阈值', '百分比', 'compress', 'threshold'], section: 'aiTools', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'aiTools.agentLoop', aiTab: 'builtin', min: 50, max: 100, step: 5 },
  agentCompressModelId: { default: '', type: 'text', label: '压缩专用模型', group: 'Agent 循环', desc: '生成压缩纪要的模型（格式 providerId:modelId），留空用当前会话模型；可指定便宜模型降低压缩成本', keywords: ['压缩', '纪要', '模型', '成本', 'compress', 'model'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live', anchor: 'aiTools.agentLoop', aiTab: 'builtin' },
  aiShowThinking: { default: true, type: 'toggle', label: '显示思考过程', group: '对话输出', desc: '推理模型返回的思考链以折叠区实时显示；普通模型没有思考链，此项无效果（自动不出现）', keywords: ['思考', '思考链', '推理', 'thinking', 'reasoning', '过程'], section: 'aiTools', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'aiTools.thinking', aiTab: 'models' },
  sofficePath: { default: '', type: 'text', label: 'LibreOffice 路径', group: '模型', desc: 'pptx 视觉转写用的 soffice 可执行文件绝对路径（留空=自动探测：注册表 / 常见安装位 / PATH）', keywords: ['libreoffice', 'soffice', 'pptx', '视觉转写', '转换', '路径', '路径设置'], section: 'aiTools', ui: true, scope: 'global', level: 'normal', affects: 'live', aiTab: 'models', anchor: 'aiTools.sofficePath' },
  webCrawlMaxPages: { default: 80, type: 'number', label: '网页抓取页数上限', group: '模型', desc: '单次「展开网页」批量抓取的最大章节数（防超大站失控）', keywords: ['网页', '抓取', 'crawl', '上限', '素材'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live', aiTab: 'models', min: 1, max: 200, step: 1 },
  webCrawlDelayMs: { default: 300, type: 'number', label: '网页抓取页间隔(ms)', group: '模型', desc: '批量抓取每页间隔（礼貌抓取，单位毫秒）', keywords: ['网页', '抓取', '间隔', 'delay', 'crawl'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live', aiTab: 'models', min: 0, max: 5000, step: 50 },
  aiModulePermissions: { default: '{"knowledge":"read","blog":"read","schedule":"read","checkin":"read","pomodoro":"read","quiz":"read"}', type: 'json', label: 'AI 模块权限', group: '权限', desc: 'AI 按模块权限：off=禁止 read=只读 write=可读写（JSON）', keywords: ['权限', 'permission', '授权', '模块'], section: 'aiTools', ui: false, scope: 'global', level: 'danger', affects: 'live', aiTab: 'perms' },
  assistantWidth: { default: 380, type: 'number', label: 'AI 助手侧栏宽度', group: 'AI 助手', desc: 'AI 助手侧栏宽度', keywords: ['助手', '侧栏', '宽度', 'assistant'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live', unit: 'px' },
  learnProgress: { default: '{"done":[],"last":1}', type: 'json', label: 'AI 学堂学习进度', group: 'AI 助手', desc: '上手路径已完成步骤与当前所在步骤（JSON）', keywords: ['ai 学堂', '上手', '教程', '进度', 'learn'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  dayPanelState: { default: '', type: 'json', label: '日程打卡小窗状态', group: '小窗', desc: '日程打卡小窗位置大小（主进程直写）', keywords: ['小窗', '打卡', 'daypanel', '悬浮'], section: 'modules', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  // ---- 工作台三栏外壳（v3.4.0）：布局状态单键（方案 §3.5）。左右栏宽度由 ResizablePanel 各自持久化（wb.leftWidth / wb.rightWidth），不进本键 ----
  workbenchLayout: { default: '', type: 'json', label: '工作台布局', group: '工作台', desc: '三栏外壳布局状态（JSON：左右栏收起/左栏模式与锁定/右栏Tab/控件排序选显/分屏比例；空=默认）', keywords: ['工作台', '三栏', '布局', '左栏', '右栏', '书签', '控件', 'workbench', 'layout'], section: 'appearance', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  scheduleFeedbackLevel: { default: 'medium', type: 'select', label: '任务完成反馈', group: '日程任务', desc: '勾选任务时的反馈动效强度：light=勾选动画 / medium=+粒子与位移 / heavy=+音效与全清庆祝', keywords: ['日程', '任务', '完成', '反馈', '动效', '动画', '勾选', '音效', '反馈感', 'schedule', 'feedback'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'schedule.feedback' },
  scheduleQuadrantIcon: { default: 'bars', type: 'select', label: '四象限图标', group: '日程任务', desc: '四象限选项的图标样式：bars=信号格 / flame=火焰 / step=上升阶梯 / grid=迷你象限', keywords: ['四象限', '象限', '图标', '紧迫', '信号格', '火焰', '阶梯', 'quadrant', 'icon'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'schedule.quadrantIcon' },
  scheduleQuadrantOrder: { default: 'ladder', type: 'select', label: '四象限排序', group: '日程任务', desc: 'ladder=按紧迫度从左到右递增（默认）/ legacy=原顺序（紧急重要·重要不紧急·紧急不重要·不紧急不重要）', keywords: ['四象限', '象限', '排序', '顺序', '紧迫', '阶梯', 'quadrant', 'order'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'schedule.quadrantOrder' },
  scheduleQuadrantText: { default: 'show', type: 'select', label: '四象限文字', group: '日程任务', desc: '四象限选项是否显示文字标签：show=图标+文字 / hide=纯图标（悬停查看含义）', keywords: ['四象限', '象限', '文字', '标签', '图标', '显示', 'quadrant', 'text'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'schedule.quadrantText' },

  // ---- 日程表（周视图）----
  scheduleViewMode: { default: 'week', type: 'select', label: '日程默认视图', group: '日程表', desc: '打开日程模块时停留的视图（记住上次选择）', keywords: ['日程', '视图', '默认', '周日程', 'schedule', 'viewmode'], section: 'modules', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  scheduleTimetableGranularity: { default: '30', type: 'segmented', label: '日程表粒度', group: '日程表', desc: '时间轴的刻度细分与拖拽吸附步长（15 分钟 / 30 分钟 / 1 小时）', keywords: ['日程表', '时间轴', '粒度', '刻度', '吸附', '网格', '15分钟', '30分钟', 'timetable', 'granularity'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'schedule.timetableGranularity' },
  scheduleTimetableRowHeight: { default: 60, type: 'number', label: '日程表行高', group: '日程表', desc: '时间轴每小时占用的纵向高度（px）。在日程表里按 Ctrl+滚轮 或 Ctrl+加减号 可随时连续缩放；预设对应 紧凑 44 / 舒适 60 / 宽松 78', keywords: ['日程表', '行高', '密度', '高度', '缩放', 'ctrl滚轮', '放大', '缩小', 'timetable', 'rowheight', 'zoom'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'schedule.timetableRowHeight', min: 24, max: 160, step: 2, unit: 'px' },
  scheduleTimetableStartHour: { default: '7', type: 'select', label: '日程表起始时间', group: '日程表', desc: '时间轴每天从几点开始显示；范围外的时段不占纵向空间', keywords: ['日程表', '起始', '开始时间', '范围', '时间轴', 'timetable', 'starthour'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'schedule.timetableStartHour' },
  scheduleTimetableEndHour: { default: '23', type: 'select', label: '日程表终止时间', group: '日程表', desc: '时间轴每天到几点结束显示；需比起始时间至少晚 4 小时', keywords: ['日程表', '终止', '结束时间', '范围', '时间轴', 'timetable', 'endhour'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live', anchor: 'schedule.timetableEndHour' },
  fillPopupAlwaysOnTop: { default: true, type: 'toggle', label: '小密码本始终置顶', group: '小窗', desc: '悬浮小密码本（Ctrl+Alt+P）默认盖在所有窗口之上；关闭后退化为普通窗口可被遮挡', keywords: ['小密码本', '置顶', '顶层', 'fill', 'popup', '密码', '悬浮'], section: 'modules', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  aiTeachRootDir: { default: 'AI教学', type: 'text', label: 'AI教学产物根目录', group: 'AI教学', desc: '会话文件夹所在仓库根目录名；改名会把已有目录一并重命名迁移（占用/权限失败则保留原目录）', keywords: ['AI教学', '教学', '目录', '根目录', '文件夹', '产物', 'aiteach'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live' },
  aiTeachDeleteSessionFolder: { default: 'ask', type: 'select', label: '删除会话时文件夹处理', group: 'AI教学', desc: 'ask=每次询问 / keep=保留文件夹 / delete=会话文件夹一并移入系统回收站', keywords: ['AI教学', '删除', '会话', '文件夹', '回收站', '产物'], section: 'modules', ui: true, scope: 'global', level: 'normal', affects: 'live' },
  aiTeachUsageDetail: { default: 'compact', type: 'select', label: '输入区用量指示档位', group: 'AI教学', desc: 'off=隐藏 / compact=上下文占用圆环（点击看详情）/ detailed=圆环+文字摘要（UI 优化条目9）', keywords: ['AI教学', '用量', 'token', '上下文', '圆环', '预算'], section: 'modules', ui: false, scope: 'global', level: 'normal', affects: 'live' },
  aiTeachCtxWindow: { default: 0, type: 'number', label: '模型上下文窗口（token）', group: 'AI教学', desc: '0=未设置（用量指示退化为纯数字）；设置后圆环按 上下文占用/窗口 比例分档着色（UI 优化条目9）', keywords: ['AI教学', '上下文', '窗口', 'context', '128k', '圆环'], section: 'modules', ui: false, scope: 'global', level: 'normal', affects: 'live', min: 0, max: 4000000, step: 1000 },
  // R6 D9：storageKnowledge / storageData / storageBlog 三键已随去库化收官全部退役
  // （知识库/博客/结构化模块恒 vault 文件，无读源分支残留）。
  uiWorkbench: { default: false, type: 'toggle', label: 'Workbench 布局', group: '外壳', desc: '实验性 VS Code 外壳；开启后编辑器文件树移到全局侧栏', keywords: ['workbench', '外壳', '布局', '侧栏', '编辑器组', '状态栏', 'vscode', '活动栏', 'shell', 'layout'], section: 'general', ui: true, scope: 'global', level: 'experimental', affects: 'live', anchor: 'advanced.workbench' },
  zenLevel: { default: 0, type: 'number', label: '禅模式档位', group: '外壳', desc: '上次禅模式档位（仅记录，进入编辑器不自动禅）', keywords: ['禅', 'zen', '专注', '档位'], section: 'general', ui: false, scope: 'global', level: 'experimental', affects: 'live', min: 0, max: 2, step: 1 },
  zenWidth: { default: 860, type: 'number', label: '禅模式正文宽度', group: '外壳', desc: '禅模式正文限宽（px，600-1400）', keywords: ['禅', 'zen', '宽度', '限宽', '写作'], section: 'general', ui: true, scope: 'global', level: 'experimental', affects: 'live', min: 600, max: 1400, step: 20, anchor: 'advanced.workbench' },
  zenShowCount: { default: true, type: 'toggle', label: '禅模式字数统计', group: '外壳', desc: '悬浮信息条显示字数与保存状态', keywords: ['禅', 'zen', '字数', '统计', '写作'], section: 'general', ui: true, scope: 'global', level: 'experimental', affects: 'live', anchor: 'advanced.workbench' },
  zenTypewriter: { default: false, type: 'toggle', label: '禅模式打字机滚动', group: '外壳', desc: '光标行始终垂直居中（iA Writer/Typora 式；默认关）', keywords: ['禅', 'zen', '打字机', '滚动', '居中', 'typewriter'], section: 'general', ui: true, scope: 'global', level: 'experimental', affects: 'live', anchor: 'advanced.workbench' },
  zenPaper: { default: true, type: 'toggle', label: '禅模式纸感氛围', group: '外壳', desc: '禅模式下背景过渡为暖纸白/墨夜色（跟随明暗主题；XMind ZEN 式氛围）', keywords: ['禅', 'zen', '纸', '氛围', '背景', '纸感'], section: 'general', ui: true, scope: 'global', level: 'experimental', affects: 'live', anchor: 'advanced.workbench' },
  zenFullscreen: { default: true, type: 'toggle', label: '禅模式系统全屏', group: '外壳', desc: 'Z2+ 进入 OS 级全屏隐藏任务栏（退出还原原窗口状态）', keywords: ['禅', 'zen', '全屏', '任务栏', 'fullscreen'], section: 'general', ui: true, scope: 'global', level: 'experimental', affects: 'live', anchor: 'advanced.workbench' },
  aiFreeModelIds: { default: '[]', type: 'json', label: '免费模型标记', group: '模型', desc: '手动标记为免费的模型 ID 列表（JSON）', keywords: ['免费', '模型', '标记', 'free'], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live', aiTab: 'models' },
  pluginAllowedLevels: { default: 'S,A,B', type: 'text', label: '插件安全等级', group: '插件安全', desc: '允许安装/启用的插件安全等级（S/A/B 逗号分隔）', keywords: ['插件', '安全', '等级', 'plugin', 'S', 'A', 'B'], section: 'security', ui: true, scope: 'global', level: 'normal', affects: 'live' , anchor: 'security.pluginLevels' },
  pluginRequireSignature: { default: false, type: 'toggle', label: '插件强制签名', group: '插件安全', desc: '市场插件强制签名校验', keywords: ['插件', '签名', '校验', 'signature'], section: 'security', ui: true, scope: 'global', level: 'danger', affects: 'live' , anchor: 'security.pluginSignature' },
  pluginTrustedKeys: { default: '', type: 'text', label: '受信公钥 keyring', group: '插件安全', desc: '受信签名公钥 keyring（JSON 或 keyId=公钥）', keywords: ['插件', '公钥', 'keyring', '签名', '信任'], section: 'security', ui: true, scope: 'global', level: 'danger', affects: 'live' , anchor: 'security.pluginKeys' },
  updateMirror: { default: 'https://gh-proxy.com', type: 'text', label: '下载镜像', group: '更新', desc: 'GitHub 加速代理前缀，留空直连', keywords: ['镜像', '加速', '代理', 'github', 'proxy', '下载', 'cdn'], section: 'about', ui: true, scope: 'global', level: 'normal', affects: 'reload', anchor: 'advanced.mirror' },
  aiVaultFilePerm: { default: 'read', type: 'select', label: 'AI vault 文件权限', group: '权限', desc: 'AI vault.* 工具访问仓库文件：off=禁止 read=只读 write=预留', keywords: ['vault', '文件', '权限', '仓库', 'ai', '读写'], section: 'aiTools', ui: false, scope: 'global', level: 'danger', affects: 'live', aiTab: 'perms' },

  // ---- 桌面外壳（自定义磁贴工作台）----
  // 布局刻意存**全局**、不进 `.knowbase/`：桌面怎么摆是「这台机器上我怎么用」，
  // 不是某份资料的一部分；换仓库不该换桌面。详见 src/modules/desktop/layout.ts 顶部说明。
  desktopPresets: { default: '', type: 'json', label: '桌面布局预设', group: '桌面外壳', desc: '桌面磁贴布局（多套预设 JSON；留空=首次进入时种入默认三套）', keywords: ['桌面', '外壳', '磁贴', '布局', '预设', 'desktop', 'shell', 'tile', '工作台'], section: 'appearance', ui: false, scope: 'global', level: 'experimental', affects: 'live' },
  desktopActivePreset: { default: 'study', type: 'text', label: '当前桌面预设', group: '桌面外壳', desc: '当前生效的桌面预设 id', keywords: ['桌面', '预设', '当前', 'desktop', 'preset'], section: 'appearance', ui: false, scope: 'global', level: 'experimental', affects: 'live' },
}

// ===== 边栏面板约束（组件 default/min/max，非用户可改，集中引用） =====

export const PANEL_CONSTRAINTS = {
  sidebarWidth_blog:              { default: 224, min: 160, max: 450 },
  sidebarWidth_schedule:          { default: 280, min: 220, max: 450 },
  sidebarWidth_knowledgeCat:      { default: 240, min: 180, max: 400 },
  sidebarWidth_knowledgePages:    { default: 240, min: 180, max: 400 },
  sidebarWidth_knowledgeChapters: { default: 240, min: 180, max: 400 },
  sidebarWidth_devtools:          { default: 176, min: 140, max: 320 },
  sidebarWidth_devtoolsDocs:      { default: 208, min: 160, max: 360 },
} as const

// ===== 类型工具 =====

/** 设置页左栏能力域（S2 起：按能力域分组，业务模块并入 modules 待 S4 自动表单细化） */
export type SettingsSection =
  | 'appearance' | 'editor' | 'general' | 'data' | 'security'
  | 'aiTools' | 'shortcuts' | 'modules' | 'about'

/** AI 工具大项内部的页签 */
export type AiTab = 'builtin' | 'mcp' | 'skill' | 'models' | 'perms'

/** 所有设置 key 的联合类型 */
export type SettingsKey = keyof typeof SETTINGS

/** 单个 key 对应的值类型 */
export type SettingsValue<K extends SettingsKey> = typeof SETTINGS[K]['default']

/** 完整的设置对象类型 */
export type AppSettings = { [K in SettingsKey]: SettingsValue<K> }

/** 所有设置的默认值 */
export const SETTINGS_DEFAULTS: AppSettings = Object.fromEntries(
  Object.entries(SETTINGS).map(([k, v]) => [k, (v as { default: unknown }).default])
) as AppSettings
