/**
 * 指令表真源（L1，2026-10-13，v3.5.0 线）。
 *
 * ★ 本文件是「键位与命令信息」的**唯一真源**。在它之前，同一批键位在四个地方各写一遍，
 *   并且已经开始互相漂移（实证见 docs/ui-updates.md §44：Ctrl+Shift+S 是死键却长期挂在表里、
 *   Ctrl+Shift+F 代码里存在而表里整条缺失、密码本声称「可在设置改键」但该设置项不存在）：
 *     ① src/modules/settings/views/ShortcutsView.tsx   —— 设置 → 快捷键页（手写行）
 *     ② src/modules/settings/sections.tsx              —— 设置搜索索引（手写 9 条，组名要与 ① 对齐）
 *     ③ resources/help/键盘快捷键.md                    —— AI 手册（builtin.help.search 的语料）
 *     ④ src/App.tsx 的 buildCommandItems / buildEmptyHints —— 命令面板与空态三条
 *   方案：docs/command-registry-plan.md。
 *
 * ★ 硬约束一：**零依赖**。不 import React / DOM / electron / 任何业务模块（只允许 `import type`），
 *   因为契约脚本与手册生成器要直接 import 本文件。本仓 42 个契约脚本已经用
 *   `node --experimental-strip-types` 直接 import `.ts`（见 .AGENT/scripts/release-notes/verify-release-notes.mjs:17,28-32），
 *   走这条路就不需要 esbuild、不需要打包 —— 本机沙箱里 esbuild 拉子进程会 EPERM，绕开它是实打实的收益。
 *
 * ★ 硬约束二：**只能写可擦除语法**。不得出现 enum / namespace / 构造函数参数属性 / 装饰器，
 *   否则 strip-types 直接抛错、契约脚本连 import 都过不去。
 *
 * ★ 命名：不要叫 shortcuts.ts —— `src/lib/shortcuts.ts` 已存在，是运行期按键闸门纯函数
 *   （isEditingInput / allowsWorkbenchShortcut），不是清单。也不要叫 commands.ts（与
 *   `src/lib/chatCommands.ts` 的聊天斜杠命令语义冲突）。
 *
 * ★ `sources` 的口径：对账当时的**行锚**，会随后续重构漂移。契约只保证「文件存在 + 行号在范围内 +
 *   该行非空」，精确的内容判据由 .AGENT/scripts/settings/verify-shortcuts-table.mjs 的 8 组断言守着。
 *   不要在`sources`里表达「这条命令的行为是什么」——行为判据一律进契约脚本。
 *
 * ★ `run` 刻意不进本文件：动作需要 React 状态。真源只说「有这么条命令、可以从面板执行」
 *   （palette: true），App 侧留一张 `id → run` 绑定表，契约做双射检查（§2，随 P3 落地）。
 *
 * ★ `palette` 的现状口径（P0 阶段）：只给**无条件下都成立的全局动作**标 true。带模块前提的
 *   （新建知识页 / 新建今日文章…）留 false —— 面板的上下文门控方案（A1：列出全部 + 声明式门控、
 *   不满足时隐藏）定案后由 P3 逐条开启，届时补 `requires` 字段与契约 §2。
 */

/** 生效范围。用途有两处：① 撞车判定（同 scope 同键 = 真撞车）② 面板门控（P3）。 */
export type CommandScope =
  | 'global'    // 与当前模块无关（含系统级 globalShortcut）
  | 'note'      // 知识库 / 笔记模块内
  | 'pdf'       // PDF / EPUB 阅读器内
  | 'image'     // 图片查看器内
  | 'blog'      // 博客模块内
  | 'schedule'  // 日程模块内

export interface CommandGroup {
  /** 组 id（内部用） */
  id: string
  /** 设置页与手册的组标题 */
  label: string
  /** 设置搜索的锚点 id（ShortcutsView 的 data-setting-anchor / sections.tsx 的 entry id） */
  anchor: string
}

export interface CommandDef {
  /** 稳定 id：App 侧绑定表、面板 recents、契约都用它 */
  id: string
  /** 命令面板里的短名（沿用对账前的现文案，不趁机改词） */
  label: string
  /** 指令表里的说明列（同上：现文案原文） */
  desc: string
  /** 逐枚键帽；多组 = 同效（对应 ShortcutsView 的 Row.alts） */
  keys: string[][]
  /** → CommandGroup.id */
  group: string
  scope: CommandScope
  /** 是否作为可执行命令出现在命令面板（P0 只标全局动作，见文件头注） */
  palette: boolean
  /**
   * 面板门控（拍板 A1）：**不满足时隐藏**这条命令。字段缺省 = 该维度不构成前提。
   * 只写声明式条件（可被契约用上下文矩阵穷举），不要写成函数 —— 函数会藏状态、也测不全。
   * `tabs` = 只在列出的模块激活时出现（跨模块同键命令靠它区分：Ctrl+N 在笔记/博客/日程都有）。
   */
  requires?: { workbench?: boolean; fullWindowTab?: boolean; tabs?: string[] }
  /**
   * 与别的命令共用同一组键时的仲裁说明（短句）。
   * 契约 §6 会强制：凡参与「被两条以上命令共用」的键位，本字段必须非空 —— 也就是说
   * 谁先接管、什么条件下归谁，必须写成数据，不能只活在某个 handler 的 if 里。
   */
  conflictNote?: string
  /** 代码锚（对账当时的行号）。只存在于手册、代码里没有独立处理器的写 'doc' */
  sources: string[]
  /** 已知取舍 / 待办（原样保留 §44 头注里的判据） */
  note?: string
}

export const COMMAND_GROUPS: CommandGroup[] = [
  { id: 'global', label: '全局', anchor: 'shortcuts.global' },
  { id: 'kbEditor', label: '知识库 — 编辑器', anchor: 'shortcuts.kbEditor' },
  { id: 'kbWriting', label: '知识库 — 写作面', anchor: 'shortcuts.kbWriting' },
  { id: 'kbSidebar', label: '知识库 — 侧栏', anchor: 'shortcuts.kbSidebar' },
  { id: 'kbTabs', label: '知识库 — Tab 管理', anchor: 'shortcuts.kbTabs' },
  { id: 'kbReading', label: '知识库 — 阅读', anchor: 'shortcuts.kbReading' },
  // 组名 2026-10-13 由「PDF 阅读器」改为「电子书阅读器」：翻页那几枚键 PDF 与电子书（EPUB）
  // 两个阅读器都吃，只叫 PDF 名不副实。anchor 与命令 id 仍是 pdfKeys / pdf-*（内部标识，
  // 跟着改会牵动设置搜索锚点、深链与契约，且对用户不可见，故不动）。
  { id: 'pdfKeys', label: '电子书阅读器', anchor: 'shortcuts.pdfKeys' },
  { id: 'imageKeys', label: '图片查看器', anchor: 'shortcuts.imageKeys' },
  { id: 'blogKeys', label: '博客', anchor: 'shortcuts.blogKeys' },
  { id: 'scheduleKeys', label: '日程', anchor: 'shortcuts.scheduleKeys' },
  { id: 'passwordKeys', label: '密码本', anchor: 'shortcuts.passwordKeys' },
]

export const COMMANDS: CommandDef[] = [
  // ---------------------------------------------------------------- 全局
  {
    id: 'sidebar', label: '折叠 / 展开侧栏', desc: '展开 / 折叠侧栏',
    keys: [['Ctrl', 'B']], group: 'global', scope: 'global', palette: true,
    conflictNote: '编辑器（Monaco / LiveMarkdown）内归「加粗」，App 侧靠 isEditingInput 对 .monaco-editor 让位（src/lib/shortcuts.ts）',
    sources: ['src/App.tsx:1377 @ if (e.ctrlKey && !e.altKey && e.key ==='],
  },
  {
    id: 'escape', label: '关闭弹窗 / 返回列表', desc: '关闭弹窗 / 返回列表',
    keys: [['Escape']], group: 'global', scope: 'global', palette: false,
    conflictNote: '多层共用：弹窗 > 模块内视图 > 返回列表，由各层自行判优先级',
    sources: ['doc'],
  },
  {
    id: 'palette', label: '命令面板', desc: '命令面板',
    keys: [['Ctrl', 'Shift', 'P']], group: 'global', scope: 'global', palette: false,
    note: '刻意不进命令面板自身（自指）——buildEmptyHints / buildCommandItems 都遵守这条',
    sources: ['src/App.tsx:299 @ if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e'],
  },
  {
    id: 'quick-open', label: '快速打开文件', desc: '快速打开文件（按标题 / 路径搜仓库页面）',
    keys: [['Ctrl', 'O']], group: 'global', scope: 'global', palette: true,
    note: '2026-10-13 博客大纲改键 Ctrl+Alt+O 让位给本键（原先两条 window 监听都会跑）',
    sources: ['src/App.tsx:315 @ if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !'],
  },
  {
    id: 'global-search', label: '全局搜索', desc: '全局搜索（左栏搜索态：标题、正文、目录、标签）',
    keys: [['Ctrl', 'P'], ['Ctrl', '`'], ['Ctrl', 'Shift', 'F']], group: 'global', scope: 'global', palette: true,
    note: '三个键同效、都指向左栏搜索态（App.tsx:304 与 :309 同一去向）。原表把这仨拆散且 Ctrl+P 错挂在「知识库 — 阅读」下',
    sources: ['src/App.tsx:305 @ if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !', 'src/App.tsx:310 @ if (e.ctrlKey && e.shiftKey && !e.altKey && (e.k'],
  },
  {
    id: 'ai-side', label: 'AI 助手', desc: 'AI 助手开关（工作台右栏；整窗模块下为悬浮助手）',
    keys: [['Ctrl', 'J']], group: 'global', scope: 'global', palette: true,
    sources: ['src/App.tsx:1470 @ if (!(e.ctrlKey && !e.shiftKey && !e.altKey && e', 'src/components/shared/AssistantPanel/index.tsx:164 @ if (e.ctrlKey && !e.shiftKey && !e.altKey && k ='],
  },
  {
    id: 'ai-full', label: 'AI 助手 · 全屏学堂', desc: 'AI 助手：进入全屏学堂',
    keys: [['Ctrl', 'Shift', 'J']], group: 'global', scope: 'global', palette: false,
    note: '对账时表里整条缺失（H8 缺口之一）。**不进面板**：动作在 AssistantPanel 组件内部（expandToFull，还带 aiShortcutDisabled / suspendShortcut 两道闸），没有对外通道，硬塞要新拉一根事件线，属新功能',
    sources: ['src/components/shared/AssistantPanel/index.tsx:156 @ if (e.ctrlKey && e.shiftKey && !e.altKey && k =='],
  },
  {
    id: 'right-panel', label: '切换工作台右栏', desc: '切换工作台右栏（折叠 / 展开）',
    keys: [['Ctrl', 'Alt', 'B']], group: 'global', scope: 'global', palette: true,
    // 整窗模块下左右栏本就退场（handler 里 fullWindowTab 早退，App.tsx:1395）⇒ 面板里也隐藏，
    // 否则会列出一条「点了没反应」的命令
    requires: { workbench: true, fullWindowTab: false },
    note: '整窗模块下左右栏本就退场，handler 里 fullWindowTab 早退（App.tsx:1395）',
    sources: ['src/App.tsx:1442 @ if (e.ctrlKey && e.altKey && e.key.toLowerCase()'],
  },
  {
    id: 'undo', label: '撤销文件操作', desc: '撤销上一文件操作（重命名 / 删除 / 移动）',
    keys: [['Ctrl', 'Z']], group: 'global', scope: 'global', palette: true,
    note: '对账时表里整条缺失（H8 缺口之一）',
    sources: ['src/lib/fileOpHistory.ts:158 @ const isUndo = k ==='],
  },
  {
    id: 'redo', label: '重做文件操作', desc: '重做文件操作',
    keys: [['Ctrl', 'Shift', 'Z'], ['Ctrl', 'Y']], group: 'global', scope: 'global', palette: true,
    sources: ['src/lib/fileOpHistory.ts:157 @ && e.shiftKey) || k ==='],
  },
  {
    id: 'zoom-in', label: '界面放大', desc: '界面放大',
    keys: [['Ctrl', '=']], group: 'global', scope: 'global', palette: true,
    conflictNote: '书架里读 PDF 时让位给阅读器页面缩放（作用域仲裁，src/App.tsx:1356）',
    sources: ['src/App.tsx:1357 @ NumpadAdd'],
  },
  {
    id: 'zoom-out', label: '界面缩小', desc: '界面缩小',
    keys: [['Ctrl', '-']], group: 'global', scope: 'global', palette: true,
    conflictNote: '同上：PDF 阅读态让位给阅读器（src/App.tsx:1356）',
    sources: ['src/App.tsx:1362 @ NumpadSubtract'],
  },
  {
    id: 'sys-day', label: '日程与打卡小窗开关', desc: '日程与打卡小窗开关（系统级）',
    keys: [['Ctrl', 'Alt', 'S']], group: 'global', scope: 'global', palette: false,
    sources: ['electron/main/dayPanelWindow.ts:436 @ , () => { togglePanel() })'],
  },

  // ---------------------------------------------------------------- 知识库 — 编辑器（页面级）
  {
    id: 'kb-save', label: '立即保存', desc: '立即保存当前页面',
    keys: [['Ctrl', 'S']], group: 'kbEditor', scope: 'note', palette: false,
    conflictNote: '按当前激活模块分发：handler 首行 getGlobalActiveTab() !== 本模块就 return（src/lib/activeTab.ts）',
    sources: ['src/modules/knowledge/components/PageEditor.tsx:1010 @ if (e.ctrlKey && e.key ==='],
  },
  {
    id: 'kb-preview', label: '阅读 ⇄ 编辑切换', desc: '阅读 ⇄ 编辑切换（仅 md / txt 文件）',
    keys: [['Ctrl', '/'], ['Ctrl', 'E']], group: 'kbEditor', scope: 'note', palette: false,
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门），与博客的 Ctrl+/ 各管各的',
    sources: ['src/modules/knowledge/components/PageEditor.tsx:1020 @ ) || (e.ctrlKey && (e.key ==='],
  },
  {
    id: 'kb-editor-esc', label: '返回页面列表', desc: '关闭弹窗后返回页面列表',
    keys: [['Escape']], group: 'kbEditor', scope: 'note', palette: false,
    conflictNote: '沉浸阅读态让位给「退出沉浸」；其余情况才是返回页面列表',
    sources: ['doc'],
  },
  {
    id: 'kb-back', label: '页面历史：后退', desc: '页面历史：后退（笔记区顶栏最左那颗箭头）',
    keys: [['Alt', '←']], group: 'kbEditor', scope: 'note', palette: false,
    note: '对账原型曾把本键锚到 PageEditor 里 Alt+A 那一行（不再写行号 —— 它随代码漂），真实判据在 knowledge/index.tsx',
    sources: ['src/modules/knowledge/index.tsx:1639 @ if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.'],
  },
  {
    id: 'kb-fwd', label: '页面历史：前进', desc: '页面历史：前进',
    keys: [['Alt', '→']], group: 'kbEditor', scope: 'note', palette: false,
    sources: ['src/modules/knowledge/index.tsx:1639 @ if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.'],
  },
  {
    id: 'kb-ai-inline', label: 'AI 内联续写建议', desc: 'AI 内联续写建议：立即要一条（Tab 采纳 / Esc 拒绝；平时停顿会自动出）',
    keys: [['Alt', 'A']], group: 'kbEditor', scope: 'note', palette: false,
    note: '原表把它挂在已退役的「编辑器模块」组下；实际判定在 PageEditor.tsx:779（笔记编辑态）',
    sources: ['src/modules/knowledge/components/PageEditor.tsx:791 @ if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.'],
  },
  {
    id: 'kb-image', label: '插入图片', desc: '插入图片（顶栏 ⋮ 里也有）',
    keys: [['Ctrl', 'Shift', 'I']], group: 'kbEditor', scope: 'note', palette: false,
    sources: ['src/modules/knowledge/components/PageEditor.tsx:1160 @ if (e.ctrlKey && e.shiftKey && !e.altKey && (e.k'],
  },
  {
    id: 'kb-footnote', label: '插入脚注', desc: '插入脚注（先选中词语；顶栏 ⋮ 里也有）',
    keys: [['Ctrl', 'Alt', 'F']], group: 'kbEditor', scope: 'note', palette: false,
    sources: ['src/modules/knowledge/components/PageEditor.tsx:1165 @ if (e.ctrlKey && e.altKey && !e.shiftKey && (e.k'],
  },

  // ---------------------------------------------------------------- 知识库 — 写作面
  // 两个写作档位键位一致：源码档 = Monaco addCommand（MonacoPane.tsx:447-453），
  // 即时渲染档 = CodeMirror keymap（LiveMarkdownPane.tsx:1023-1029）。
  // 这 8 键此前**从未进过设置页**（H9 缺口），但手册《键盘快捷键》的「编辑器内（写作面）」一节一直有。
  {
    id: 'ed-bold', label: '加粗', desc: '加粗（编辑器内是加粗，不是折叠侧栏）',
    keys: [['Ctrl', 'B']], group: 'kbWriting', scope: 'note', palette: false,
    conflictNote: '与全局「折叠 / 展开侧栏」同键：写作面内由 Monaco / CodeMirror 接管，窗口级监听靠 isEditingInput 跳过',
    sources: ['src/components/shared/MonacoPane.tsx:447 @ editor.addCommand(monaco.KeyMod.CtrlCmd | monaco', 'src/components/shared/LiveMarkdownPane.tsx:1023 @ fmt-bold'],
  },
  {
    id: 'ed-italic', label: '斜体', desc: '斜体',
    keys: [['Ctrl', 'I']], group: 'kbWriting', scope: 'note', palette: false,
    sources: ['src/components/shared/MonacoPane.tsx:448 @ editor.addCommand(monaco.KeyMod.CtrlCmd | monaco', 'src/components/shared/LiveMarkdownPane.tsx:1024 @ fmt-italic'],
  },
  {
    id: 'ed-link', label: '新增外部链接', desc: '新增外部链接',
    keys: [['Ctrl', 'K']], group: 'kbWriting', scope: 'note', palette: false,
    sources: ['src/components/shared/MonacoPane.tsx:449 @ editor.addCommand(monaco.KeyMod.CtrlCmd | monaco', 'src/components/shared/LiveMarkdownPane.tsx:1025 @ link-external'],
  },
  {
    id: 'ed-h1', label: '标题 1', desc: '标题 1',
    keys: [['Ctrl', 'Alt', '1']], group: 'kbWriting', scope: 'note', palette: false,
    sources: ['src/components/shared/MonacoPane.tsx:450 @ editor.addCommand(monaco.KeyMod.CtrlCmd | monaco', 'src/components/shared/LiveMarkdownPane.tsx:1026 @ Mod-Alt-1'],
  },
  {
    id: 'ed-h2', label: '标题 2', desc: '标题 2',
    keys: [['Ctrl', 'Alt', '2']], group: 'kbWriting', scope: 'note', palette: false,
    sources: ['src/components/shared/MonacoPane.tsx:451 @ editor.addCommand(monaco.KeyMod.CtrlCmd | monaco', 'src/components/shared/LiveMarkdownPane.tsx:1027 @ Mod-Alt-2'],
  },
  {
    id: 'ed-h3', label: '标题 3', desc: '标题 3',
    keys: [['Ctrl', 'Alt', '3']], group: 'kbWriting', scope: 'note', palette: false,
    sources: ['src/components/shared/MonacoPane.tsx:452 @ editor.addCommand(monaco.KeyMod.CtrlCmd | monaco', 'src/components/shared/LiveMarkdownPane.tsx:1028 @ Mod-Alt-3'],
  },
  {
    id: 'ed-p', label: '正文（取消标题）', desc: '正文（取消标题）',
    keys: [['Ctrl', 'Alt', '0']], group: 'kbWriting', scope: 'note', palette: false,
    sources: ['src/components/shared/MonacoPane.tsx:453 @ editor.addCommand(monaco.KeyMod.CtrlCmd | monaco', 'src/components/shared/LiveMarkdownPane.tsx:1029 @ para-text'],
  },
  {
    id: 'ed-find', label: '查找', desc: '查找（源码档是 Monaco 查找框，即时渲染档是内置查找面板；Ctrl+G / F3 下一个、Esc 关闭）',
    keys: [['Ctrl', 'F']], group: 'kbWriting', scope: 'note', palette: false,
    conflictNote: '与 PDF 阅读器的 Ctrl+F 同键：焦点在哪边归哪边（写作面走 Monaco / 内置面板，PDF 走 PdfReaderView）',
    sources: ['doc'],
  },

  // ---------------------------------------------------------------- 知识库 — 侧栏
  {
    id: 'sb-rename', label: '重命名选中项', desc: '重命名选中的目录 / 笔记本 / 章节',
    keys: [['F2']], group: 'kbSidebar', scope: 'note', palette: false,
    sources: ['src/modules/knowledge/components/NotebookList.tsx:297 @ window.addEventListener('],
  },
  {
    id: 'sb-delete', label: '删除选中项', desc: '删除选中的目录 / 笔记本 / 章节',
    keys: [['Delete']], group: 'kbSidebar', scope: 'note', palette: false,
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门），与博客的 Delete 各管各的',
    sources: ['doc'],
  },
  {
    id: 'sb-copy', label: '复制选中项', desc: '复制选中的页面 / 目录到内部剪贴板（非输入框时）',
    keys: [['Ctrl', 'C']], group: 'kbSidebar', scope: 'note', palette: false,
    sources: ['src/modules/knowledge/index.tsx:1687 @ // Ctrl+C — copy selected item to internal clipb'],
  },
  {
    id: 'sb-cut', label: '剪切选中项', desc: '剪切选中的页面 / 目录（非输入框时）',
    keys: [['Ctrl', 'X']], group: 'kbSidebar', scope: 'note', palette: false,
    sources: ['src/modules/knowledge/index.tsx:1700 @ // Ctrl+X — cut selected item'],
  },
  {
    id: 'sb-paste', label: '粘贴到选中目标', desc: '粘贴内部剪贴板到选中目标（非输入框时）',
    keys: [['Ctrl', 'V']], group: 'kbSidebar', scope: 'note', palette: false,
    sources: ['src/modules/knowledge/index.tsx:1713 @ // Ctrl+V — paste internal clipboard'],
  },

  // ---------------------------------------------------------------- 知识库 — Tab 管理
  {
    id: 'kb-new', label: '新建知识页', desc: '新建知识页（文件树内联命名，落点跟随选中目录）',
    keys: [['Ctrl', 'N']], group: 'kbTabs', scope: 'note', palette: true,
    // 只在笔记模块激活时出现：Ctrl+N 在笔记 / 博客 / 日程都有，靠 tabs 区分（A1 的门控）
    requires: { tabs: ['knowledge'] },
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门）：笔记 / 博客 / 日程都占 Ctrl+N，各管各的',
    sources: ['src/modules/knowledge/index.tsx:1650 @ if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.'],
  },
  {
    id: 'kb-close-tab', label: '关闭当前 Tab', desc: '关闭当前打开的 Tab 页',
    keys: [['Ctrl', 'W']], group: 'kbTabs', scope: 'note', palette: true,
    // 模块内命令进面板（L2 第三批）：只在笔记模块激活时出现
    requires: { tabs: ['knowledge'] },
    sources: ['src/modules/knowledge/index.tsx:1662 @ // Ctrl+W — close current tab'],
  },
  {
    id: 'kb-next-tab', label: '下一个 Tab', desc: '切换到下一个 Tab',
    keys: [['Ctrl', 'Tab']], group: 'kbTabs', scope: 'note', palette: false,
    sources: ['src/modules/knowledge/index.tsx:1670 @ // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs'],
  },
  {
    id: 'kb-prev-tab', label: '上一个 Tab', desc: '切换到上一个 Tab',
    keys: [['Ctrl', 'Shift', 'Tab']], group: 'kbTabs', scope: 'note', palette: false,
    sources: ['src/modules/knowledge/index.tsx:1670 @ // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs'],
  },

  // ---------------------------------------------------------------- 知识库 — 阅读
  {
    id: 'kb-immersive', label: '沉浸阅读进出', desc: '沉浸阅读进出',
    keys: [['Ctrl', 'Shift', 'R']], group: 'kbReading', scope: 'note', palette: true,
    // 模块内命令进面板（L2 第三批）：只在笔记模块激活时出现
    requires: { tabs: ['knowledge'] },
    sources: ['src/modules/knowledge/index.tsx:1656 @ if (e.ctrlKey && e.shiftKey && (e.key ==='],
  },
  {
    id: 'kb-immersive-esc', label: '沉浸阅读退出', desc: '沉浸阅读退出',
    keys: [['Escape']], group: 'kbReading', scope: 'note', palette: false,
    conflictNote: '仅沉浸阅读态接管 Escape；非沉浸态归「返回页面列表」',
    sources: ['src/modules/knowledge/index.tsx:1656 @ if (e.ctrlKey && e.shiftKey && (e.key ==='],
  },

  // ---------------------------------------------------------------- 电子书阅读器（PDF + EPUB）
  {
    id: 'pdf-find', label: 'PDF 内搜索', desc: 'PDF 阅读器内搜索',
    keys: [['Ctrl', 'F']], group: 'pdfKeys', scope: 'pdf', palette: false,
    conflictNote: '与写作面的 Ctrl+F 同键：焦点在 PDF 阅读器时归阅读器自处理',
    sources: ['src/components/shared/pdf/PdfReaderView.tsx:1199 @ && (e.ctrlKey || e.metaKey)) {'],
  },
  {
    id: 'pdf-next', label: 'PDF 下一页', desc: 'PDF 下一页',
    keys: [['PageDown'], ['空格'], ['→']], group: 'pdfKeys', scope: 'pdf', palette: false,
    note: '三枚键两个阅读器都吃（PDF: PdfReaderView.tsx:1193；电子书: EpubReaderView.tsx:625）',
    sources: ['src/components/shared/pdf/PdfReaderView.tsx:1193 @ && !immersive)) { e.preventDefault(); stepPage(1', 'src/components/shared/epub/EpubReaderView.tsx:625 @ ) { void v.next(); return true }'],
  },
  {
    id: 'pdf-prev', label: 'PDF 上一页', desc: 'PDF 上一页',
    keys: [['PageUp'], ['←']], group: 'pdfKeys', scope: 'pdf', palette: false,
    note: '同上（PDF: PdfReaderView.tsx:1194；电子书: EpubReaderView.tsx:624）',
    sources: ['src/components/shared/pdf/PdfReaderView.tsx:1194 @ ) { e.preventDefault(); stepPage(-1) }', 'src/components/shared/epub/EpubReaderView.tsx:624 @ ) { void v.prev(); return true }'],
  },
  {
    id: 'pdf-zoom-in', label: 'PDF 放大', desc: 'PDF 放大',
    keys: [['Ctrl', '=']], group: 'pdfKeys', scope: 'pdf', palette: false,
    conflictNote: '与全局「界面放大」同键：PDF 阅读态接管，全局缩放在 App.tsx:1356 让位',
    sources: ['src/components/shared/pdf/PdfReaderView.tsx:1196 @ ) && (e.ctrlKey || e.metaKey)) { e.preventDefaul'],
  },
  {
    id: 'pdf-zoom-out', label: 'PDF 缩小', desc: 'PDF 缩小',
    keys: [['Ctrl', '-']], group: 'pdfKeys', scope: 'pdf', palette: false,
    conflictNote: '与全局「界面缩小」同键：同上，PDF 阅读态接管',
    sources: ['src/components/shared/pdf/PdfReaderView.tsx:1197 @ ) && (e.ctrlKey || e.metaKey)) { e.preventDefaul'],
  },
  {
    id: 'pdf-zoom-fit', label: 'PDF 适应窗口', desc: 'PDF 适应窗口',
    keys: [['Ctrl', '0']], group: 'pdfKeys', scope: 'pdf', palette: true,
    // 门控 = 阅读器可能挂载的两个 Tab（书架里读书 / 笔记里打开的 PDF 附件）。
    // 面板这条命令另有一层「只让当前可见的那个实例响应」的兜底 —— 见下面第二个锚与
    // src/components/shared/pdf/pdfEvents.ts 的 KB_PDF_ZOOM_FIT 头注。
    requires: { tabs: ['knowledge', 'bookshelf'] },
    note: '三条 PDF 缩放键此前从未进过设置页，手册《键盘快捷键》也没有 PDF 一节（P2 生成时一并补）。本条 2026-10-13 进面板；与它同键的 pdf-zoom-in / pdf-zoom-out **不进** —— 面板里已经有全局「界面放大 / 缩小」（zoom-in / zoom-out），再加一对同名近义命令会互相干扰（也用不着：阅读器里 Ctrl+= / Ctrl+- 本来就生效）',
    sources: [
      'src/components/shared/pdf/PdfReaderView.tsx:1198 @ && (e.ctrlKey || e.metaKey)) { e.preventDefault(',
      'src/components/shared/pdf/PdfReaderView.tsx:1245 @ window.addEventListener(KB_PDF_ZOOM_FIT, onZoomFit)',
    ],
  },

  // ---------------------------------------------------------------- 图片查看器
  // 宿主两处（笔记区 / 沉浸阅读）共用 useImageViewKeys，键位表本来就只有一份 ——
  // 该文件头注写的就是本方案的同一条理由：「键位表只能有一份，两处各写一遍改键位时必然漏一处」。
  {
    id: 'img-fit', label: '适应窗口', desc: '适应窗口（比窗口小的图不放大）',
    keys: [['0']], group: 'imageKeys', scope: 'image', palette: false,
    note: '四键刻意不带修饰键：Ctrl+= / Ctrl+- / Ctrl+0 是应用级 UI 缩放的地盘，不抢（useImageViewKeys 头注）',
    sources: ['src/components/shared/image/useImageViewKeys.ts:28 @ : e.preventDefault(); fit('],
  },
  {
    id: 'img-actual', label: '实际大小 1:1', desc: '实际大小 1:1',
    keys: [['1']], group: 'imageKeys', scope: 'image', palette: false,
    sources: ['src/components/shared/image/useImageViewKeys.ts:29 @ : e.preventDefault(); fit('],
  },
  {
    id: 'img-rotl', label: '向左旋转 90°', desc: '向左旋转 90°',
    keys: [['[']], group: 'imageKeys', scope: 'image', palette: false,
    sources: ['src/components/shared/image/useImageViewKeys.ts:30 @ : e.preventDefault(); rotate(-90); break'],
  },
  {
    id: 'img-rotr', label: '向右旋转 90°', desc: '向右旋转 90°',
    keys: [[']']], group: 'imageKeys', scope: 'image', palette: false,
    sources: ['src/components/shared/image/useImageViewKeys.ts:31 @ : e.preventDefault(); rotate(90); break'],
  },

  // ---------------------------------------------------------------- 博客
  {
    id: 'blog-new', label: '新建 / 打开今日文章', desc: '新建 / 打开今日文章',
    keys: [['Ctrl', 'N']], group: 'blogKeys', scope: 'blog', palette: true,
    // 只在博客模块激活时出现（同 kb-new：Ctrl+N 三个模块都有，靠 tabs 区分）
    requires: { tabs: ['blog'] },
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门），与笔记 / 日程的 Ctrl+N 各管各的',
    sources: ['src/modules/blog/index.tsx:218 @ if (e.ctrlKey && e.key ==='],
  },
  {
    id: 'blog-save', label: '保存并关闭', desc: '保存并关闭编辑器',
    keys: [['Ctrl', 'S']], group: 'blogKeys', scope: 'blog', palette: false,
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门），与笔记的 Ctrl+S 各管各的',
    sources: ['src/modules/blog/components/MarkdownEditor.tsx:218 @ ) { e.preventDefault(); handleSaveAndClose() }'],
  },
  {
    id: 'blog-preview', label: '切换预览', desc: '切换 Markdown 预览',
    keys: [['Ctrl', '/']], group: 'blogKeys', scope: 'blog', palette: false,
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门），与笔记的 Ctrl+/ 各管各的',
    sources: ['src/modules/blog/components/MarkdownEditor.tsx:217 @ ) { e.preventDefault(); setShowPreview(v => !v) '],
  },
  {
    id: 'blog-outline', label: '切换大纲', desc: '切换大纲（编辑器 / 详情态）',
    keys: [['Ctrl', 'Alt', 'O']], group: 'blogKeys', scope: 'blog', palette: false,
    note: '2026-10-13 改键：原为 Ctrl+O，与全局「快速打开文件」撞车（两条 window 监听都会跑）',
    sources: ['src/modules/blog/index.tsx:329 @ if (e.ctrlKey && e.altKey && !e.shiftKey && e.ke'],
  },
  {
    id: 'blog-back', label: '返回列表', desc: '从编辑器 / 详情返回列表',
    keys: [['Escape']], group: 'blogKeys', scope: 'blog', palette: false,
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门）；非列表视图才接管',
    sources: ['doc'],
  },
  {
    id: 'blog-delete', label: '删除文章', desc: '删除当前查看的文章',
    keys: [['Delete']], group: 'blogKeys', scope: 'blog', palette: false,
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门），与笔记侧栏的 Delete 各管各的',
    sources: ['doc'],
  },

  // ---------------------------------------------------------------- 日程
  {
    id: 'sch-new', label: '新建任务', desc: '打开新建任务弹窗',
    keys: [['Ctrl', 'N']], group: 'scheduleKeys', scope: 'schedule', palette: true,
    // 只在日程模块激活时出现（第三条模块内命令；同 kb-new / blog-new）
    requires: { tabs: ['schedule'] },
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门），与笔记 / 博客的 Ctrl+N 各管各的',
    sources: ['src/modules/schedule/index.tsx:628 @ if (e.ctrlKey && e.key ==='],
  },
  {
    id: 'sch-close', label: '关闭弹窗', desc: '关闭弹窗（编辑 / 四象限 / 标签管理）',
    keys: [['Escape']], group: 'scheduleKeys', scope: 'schedule', palette: false,
    conflictNote: '按当前激活模块分发（getGlobalActiveTab 闸门）',
    sources: ['doc'],
  },
  {
    id: 'sys-dock', label: '日程侧栏置顶停靠', desc: '日程侧栏置顶停靠（系统级）',
    keys: [['Ctrl', 'Alt', 'Up']], group: 'scheduleKeys', scope: 'global', palette: false,
    sources: ['electron/main/dayPanelWindow.ts:437 @ globalShortcut.register('],
  },
  {
    id: 'sys-widget', label: '日程侧栏切为桌面小组件', desc: '日程侧栏切为桌面小组件（系统级）',
    keys: [['Ctrl', 'Alt', 'Down']], group: 'scheduleKeys', scope: 'global', palette: false,
    sources: ['electron/main/dayPanelWindow.ts:438 @ globalShortcut.register('],
  },

  // ---------------------------------------------------------------- 密码本
  {
    id: 'sys-pwdfill', label: '密码填充弹窗开关', desc: '密码填充弹窗开关（系统级）',
    keys: [['Ctrl', 'Alt', 'P']], group: 'passwordKeys', scope: 'global', palette: false,
    note: '原表写「可在设置改键」—— src/lib/settings.ts 里没有这个设置项，passwordFiller.ts:143 是直接读 settings.json 的裸键 fillPopupShortcut。改成真可改键属新功能，未做',
    sources: ['electron/main/passwordFiller.ts:143 @ const shortcutKey = (settings.fillPopupShortcut '],
  },
]

/** 某组内的命令（保持声明顺序） */
export function commandsOfGroup(groupId: string): CommandDef[] {
  return COMMANDS.filter((c) => c.group === groupId)
}

/** 面板门控的输入（由 App 计算后传入；纯数据，可被契约用上下文矩阵穷举） */
export interface PaletteContext {
  /** 是否启用了 Workbench 外壳 */
  workbench: boolean
  /** 当前激活的是否整窗模块（左右栏退场） */
  fullWindowTab: boolean
  /** 当前激活的模块标签（工具标签 / 空态时为 null） */
  activeTab: string | null
}

/** 单条命令在给定上下文下是否可用（字段缺省 = 该维度不构成前提） */
export function gateAllows(c: CommandDef, ctx: PaletteContext): boolean {
  const r = c.requires
  if (!r) return true
  if (r.workbench !== undefined && r.workbench !== ctx.workbench) return false
  if (r.fullWindowTab !== undefined && r.fullWindowTab !== ctx.fullWindowTab) return false
  if (r.tabs !== undefined && !(ctx.activeTab !== null && r.tabs.includes(ctx.activeTab))) return false
  return true
}

/** 面板应列出的命令：palette:true 且门控通过，保持真源顺序 */
export function paletteCommands(ctx: PaletteContext): CommandDef[] {
  return COMMANDS.filter((c) => c.palette && gateAllows(c, ctx))
}

export function commandById(id: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.id === id)
}

/** 组 id → 组标题（面板按它分组，与设置页同名）。未知 id 原样返回，便于契约发现打错的 id。 */
export function groupLabelOf(groupId: string): string {
  return COMMAND_GROUPS.find((g) => g.id === groupId)?.label ?? groupId
}

/**
 * 组合键 → 纯文本，如 `Ctrl+Alt+1`。命令面板显示键帽用。
 * 注意键帽里已有 `←` / `空格` 这类非 ASCII 名，它们本身就是展示名，不做映射。
 */
export function chordToText(chord: string[]): string {
  return chord.join('+')
}

/**
 * 组合键 → Markdown 键帽（手册用），如 `` `Ctrl` `Alt` `1` ``。
 *
 * ★ 反引号这一枚键帽要**特殊处理**：给它包一层单反引号会拼出三个连续反引号，
 *   而 Markdown 把连续三个反引号当**代码围栏**（那一行连同后续内容直接烂掉）。
 *   手册里一律写成「反引号」这个词 —— 这也是本页生成之前手写时的既有写法。
 */
export function chordToMarkdown(chord: string[]): string {
  return chord.map((k) => (k === '`' ? '反引号' : '`' + k + '`')).join(' ')
}

/** 多组同效键 → Markdown，组间用 ` / `（手册里「三选一」的写法） */
export function altsToMarkdown(alts: string[][]): string {
  return alts.map(chordToMarkdown).join(' / ')
}
