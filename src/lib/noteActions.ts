/**
 * 写作面动作表 —— 双写作面方案 `docs/note-surface-dual-engine-design.md`。
 *
 * **一份定义、两档共用**：源码档（Monaco）与即时渲染档（CM6）共用同一棵右键菜单树与同一套
 * 动作实现（只经 `NoteEngineHandle` 契约下达），因此不存在「两档菜单/行为各写一份、慢慢漂移」。
 *
 * 设计纪律：
 * - 本文件只依赖 `noteEngine` 的类型与 `./ipc` 的剪贴板通道，**不碰 DOM / React**，
 *   以便契约脚本直接 import 做纯函数断言；
 * - 失败不弹窗，返回 `{ ok:false, message }` 由菜单组件转 Toast（本文件不引 UI 层）。
 */

import type { NoteEngineHandle, NoteBlockContext, NoteSelection } from './noteEngine'

/**
 * 文件格式动作的 id 空间（2026-10-11 拍板 C2：⋮ 与编辑器右键菜单两处都有「文件格式」）。
 *
 * 为什么用模板字面量而不是给每个扩展名列一个成员：格式清单的真源是
 * `src/lib/fileTypes.ts` 的 FILE_LANG_OPTIONS，加一种语言不该来改本文件的联合类型。
 *
 * ⚠️ **执行权不在本文件**：改格式要动 PageEditor 的渲染态、还要把类型回报父级与状态栏，
 * 而本文件只经 NoteEngineHandle 做事（且刻意保持零加载期依赖，便于契约脚本直接 import）。
 * 所以 NoteContextMenu 见到 `fmt-ext:` 前缀的动作会转交宿主的 onFileType，不进 runNoteAction。
 * ⚠️ 清单本身也**不由本文件导入**（那会给本文件加一条静态依赖，破坏上面那条契约）。
 */
export type FileTypeActionId = `fmt-ext:${string}`

export const fileTypeActionId = (ext: string): FileTypeActionId => `fmt-ext:${ext}`

/** 取格式动作里的扩展名；不是格式动作则 null */
export function fileTypeOfAction(id: string | undefined): string | null {
  if (!id || !id.startsWith('fmt-ext:')) return null
  return id.slice('fmt-ext:'.length)
}

export type NoteActionId =
  // 链接
  | 'link-wiki'
  | 'link-external'
  // 文本格式
  | 'fmt-bold'
  | 'fmt-italic'
  | 'fmt-strike'
  | 'fmt-code'
  | 'fmt-highlight'
  // 段落设置
  | 'para-text'
  | 'para-h1'
  | 'para-h2'
  | 'para-h3'
  | 'para-h4'
  | 'para-h5'
  | 'para-h6'
  | 'para-quote'
  | 'para-ul'
  | 'para-ol'
  | 'para-task'
  // 插入
  | 'ins-footnote'
  | 'ins-table'
  | 'ins-callout'
  | 'ins-hr'
  | 'ins-code'
  | 'ins-math'
  | 'ins-quiz'
  // 剪贴板
  | 'edit-cut'
  | 'edit-copy'
  | 'edit-paste'
  | 'edit-paste-plain'
  | 'edit-select-all'

export interface NoteMenuNode {
  /** 分隔线节点：只有 sep */
  sep?: boolean
  label?: string
  /** 普通写作动作，或文件格式动作（后者由菜单组件转交宿主，见 fileTypeOfAction） */
  action?: NoteActionId | FileTypeActionId
  children?: NoteMenuNode[]
  /** lucide 图标名（组件侧映射，数据层不引图标库） */
  icon?: string
  /** 右侧快捷键提示 */
  hint?: string
}

/**
 * 右键菜单树（顺序对齐 Obsidian 编辑器右键菜单）。
 *
 * 「新建数据库」**不做** —— 我们没有 Bases 的对标物；本项目的自有围栏是题目围栏，
 * 因此在这里以「题目围栏」占这一位（见方案文档 §2 菜单映射表）。
 */
export const NOTE_MENU: NoteMenuNode[] = [
  { label: '新增链接', action: 'link-wiki', icon: 'Link2' },
  { label: '新增外部链接', action: 'link-external', icon: 'ExternalLink' },
  { sep: true },
  {
    label: '文本格式', icon: 'Type',
    children: [
      { label: '加粗', action: 'fmt-bold', icon: 'Bold', hint: 'Ctrl+B' },
      { label: '斜体', action: 'fmt-italic', icon: 'Italic', hint: 'Ctrl+I' },
      { label: '删除线', action: 'fmt-strike', icon: 'Strikethrough' },
      { label: '行内代码', action: 'fmt-code', icon: 'Code' },
      { label: '高亮', action: 'fmt-highlight', icon: 'Highlighter' },
    ],
  },
  {
    label: '段落设置', icon: 'Pilcrow',
    children: [
      { label: '正文', action: 'para-text' },
      { label: '标题 1', action: 'para-h1' },
      { label: '标题 2', action: 'para-h2' },
      { label: '标题 3', action: 'para-h3' },
      { label: '标题 4', action: 'para-h4' },
      { label: '标题 5', action: 'para-h5' },
      { label: '标题 6', action: 'para-h6' },
      { sep: true },
      { label: '引用', action: 'para-quote', icon: 'Quote' },
      { label: '无序列表', action: 'para-ul', icon: 'List' },
      { label: '有序列表', action: 'para-ol', icon: 'ListOrdered' },
      { label: '任务列表', action: 'para-task', icon: 'ListChecks' },
    ],
  },
  {
    label: '插入', icon: 'Plus',
    children: [
      { label: '脚注', action: 'ins-footnote', icon: 'StickyNote' },
      { label: '表格', action: 'ins-table', icon: 'Table' },
      { label: '标注', action: 'ins-callout', icon: 'MessageSquareQuote' },
      { label: '分隔线', action: 'ins-hr', icon: 'Minus' },
      { label: '代码块', action: 'ins-code', icon: 'SquareCode' },
      { label: '数学块', action: 'ins-math', icon: 'Sigma' },
      { label: '题目围栏', action: 'ins-quiz', icon: 'ListChecks' },
    ],
  },
  { sep: true },
  { label: '剪切', action: 'edit-cut', icon: 'Scissors', hint: 'Ctrl+X' },
  { label: '复制', action: 'edit-copy', icon: 'Copy', hint: 'Ctrl+C' },
  { label: '粘贴', action: 'edit-paste', icon: 'ClipboardPaste', hint: 'Ctrl+V' },
  { label: '以纯文本形式粘贴', action: 'edit-paste-plain', icon: 'ClipboardType' },
  { label: '全选', action: 'edit-select-all', icon: 'SquareDashedMousePointer', hint: 'Ctrl+A' },
]

/** 动作结果：失败只回报文案（由 UI 层转 Toast），数据层不引 UI */
export type NoteActionResult = { ok: true } | { ok: false; message: string }

const OK: NoteActionResult = { ok: true }
const fail = (message: string): NoteActionResult => ({ ok: false, message })

// ===== 菜单项可用性（灰显判定，两档共用）=====

/** 需要「单行非空选区」的动作（脚注 / 格式化在有选区时才包裹，无选区则插占位 —— 都可用） */
export function isNoteActionEnabled(id: NoteActionId | FileTypeActionId, ctx: NoteBlockContext | null): boolean {
  if (fileTypeOfAction(id) !== null) return true
  if (id === 'ins-footnote') {
    const s = ctx?.selection
    return Boolean(s && s.text.trim() && !s.text.includes('\n'))
  }
  return true
}

// ===== 动作实现 =====

/** 行前缀改写：保留光标在行内的相对列（夹取到新行长） */
function rewriteLine(
  engine: NoteEngineHandle,
  ctx: NoteBlockContext,
  transform: (line: string) => string,
): void {
  const caretInLine = Math.max(0, ctx.selection.from - ctx.lineFrom)
  const next = transform(ctx.lineText)
  engine.replaceRange(ctx.lineFrom, ctx.lineTo, next)
  engine.setCursorOffset(ctx.lineFrom + Math.min(caretInLine, next.length))
}

/** 行内包裹：有选中就包住（并保持选中），没选中就插占位并选中占位 */
function wrapInline(engine: NoteEngineHandle, marker: string, placeholder: string): NoteActionResult {
  const sel = engine.getSelection()
  if (!sel) return fail('编辑器尚未就绪')
  const inner = sel.text || placeholder
  const text = `${marker}${inner}${marker}`
  engine.replaceRange(sel.from, sel.to, text, marker.length, marker.length + inner.length)
  return OK
}

/**
 * 块级插入的落点规则（四条，覆盖「插完就能打」的全部场景，且保证 Markdown 解析结果正确）：
 * - 有非空选区 → 替换选区（用户圈了范围就是要替换）；
 * - 光标在空行、上一行也是空行 → 替换整行（不留多余空行）；
 * - 光标在空行、上一行有内容 → **保留那个空行**、另起一行插（否则 `---` 会变成上一段的标题下划线）；
 * - 光标在非空行 → 空一行再插（同理：紧贴段落会让 `---` 变成 setext 标题下划线）。
 *
 * `selectText` 给定时选中这段文本（表格首格 / 代码块空行等）。
 * 返回值额外带 `at` = 插入块在文档里的起点：即时渲染档的表格 widget 靠它交接焦点（见 `focusBlockCell`）。
 */
type InsertBlockResult = { ok: true; at: number } | { ok: false; message: string }

function insertBlock(
  engine: NoteEngineHandle,
  ctx: NoteBlockContext,
  text: string,
  selectText?: string,
): InsertBlockResult {
  const hasSel = ctx.selection.from !== ctx.selection.to
  const onEmptyLine = ctx.lineText.trim() === ''
  let from: number
  let to: number
  let body: string
  if (hasSel) {
    from = ctx.selection.from
    to = ctx.selection.to
    body = text
  } else if (onEmptyLine) {
    from = ctx.prevLineEmpty ? ctx.lineFrom : ctx.lineTo
    to = ctx.prevLineEmpty ? ctx.lineTo : ctx.lineTo
    body = ctx.prevLineEmpty ? text : `\n${text}`
  } else {
    from = ctx.lineTo
    to = ctx.lineTo
    body = `\n\n${text}`
  }
  const at = selectText ? body.indexOf(selectText) : -1
  if (at >= 0 && selectText) {
    engine.replaceRange(from, to, body, at, at + selectText.length)
  } else {
    engine.replaceRange(from, to, body)
  }
  return { ok: true, at: from + Math.max(0, body.indexOf(text)) }
}

const LEADING_MARKS = /^(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)+/

const TABLE_TPL = [
  '| 列 1 | 列 2 | 列 3 |',
  '| --- | --- | --- |',
  '|  |  |  |',
].join('\n')

const QUIZ_TPL = [
  '```quiz',
  '{"no":1,"points":"","question":"题干","options":[{"key":"A","text":"选项 A"},{"key":"B","text":"选项 B"}],"answer":"A","explanation":""}',
  '```',
].join('\n')

/**
 * 执行一个菜单动作。返回失败原因（成功 = `{ ok: true }`）。
 *
 * 剪贴板类动作走主进程通道（`./ipc` 的 copyText / readClipboardText）——与本项目既有口径一致：
 * 渲染层不直连 `navigator.clipboard`，避免多开一个权限面。
 */
export function runNoteAction(id: NoteActionId, engine: NoteEngineHandle): NoteActionResult | Promise<NoteActionResult> {
  const ctx = engine.getBlockContext()
  if (!ctx) return fail('编辑器尚未就绪')

  switch (id) {
    // ---- 链接 ----
    case 'link-wiki': {
      const sel = ctx.selection
      const text = sel.text.trim() ? `[[${sel.text}]]` : '[['
      engine.replaceRange(sel.from, sel.to, text, sel.text.trim() ? 2 : 2, sel.text.trim() ? 2 + sel.text.length : 2)
      // 唤起 `[[` 候选（两档各自的建议通道；未实现也不影响链接插入本身）
      engine.triggerWikiSuggest?.()
      return OK
    }
    case 'link-external': {
      const sel = ctx.selection
      const label = sel.text.trim() || '链接文字'
      const text = `[${label}](https://)`
      const urlAt = text.length - 1
      if (sel.text.trim()) engine.replaceRange(sel.from, sel.to, text, 1, 1 + label.length)
      else engine.replaceRange(sel.from, sel.to, text, urlAt, urlAt)
      return OK
    }
    // ---- 文本格式 ----
    case 'fmt-bold': return wrapInline(engine, '**', '加粗')
    case 'fmt-italic': return wrapInline(engine, '*', '斜体')
    case 'fmt-strike': return wrapInline(engine, '~~', '删除线')
    case 'fmt-code': return wrapInline(engine, '`', '代码')
    case 'fmt-highlight': return wrapInline(engine, '==', '高亮')
    // ---- 段落设置 ----
    case 'para-text':
      rewriteLine(engine, ctx, (l) => l.replace(LEADING_MARKS, ''))
      return OK
    case 'para-h1': case 'para-h2': case 'para-h3':
    case 'para-h4': case 'para-h5': case 'para-h6': {
      const level = Number(id.slice(-1))
      rewriteLine(engine, ctx, (l) => `${'#'.repeat(level)} ${l.replace(LEADING_MARKS, '')}`)
      return OK
    }
    case 'para-quote':
      rewriteLine(engine, ctx, (l) => (/^>\s?/.test(l) ? l.replace(/^>\s?/, '') : `> ${l}`))
      return OK
    case 'para-ul':
      rewriteLine(engine, ctx, (l) => (/^[-*+]\s+/.test(l) && !/^[-*+]\s+\[/.test(l) ? l.replace(/^[-*+]\s+/, '') : `- ${l.replace(LEADING_MARKS, '')}`))
      return OK
    case 'para-ol':
      rewriteLine(engine, ctx, (l) => (/^\d+\.\s+/.test(l) ? l.replace(/^\d+\.\s+/, '') : `1. ${l.replace(LEADING_MARKS, '')}`))
      return OK
    case 'para-task':
      rewriteLine(engine, ctx, (l) => (/^[-*+]\s+\[[ xX]\]\s+/.test(l) ? l.replace(/^[-*+]\s+\[[ xX]\]\s+/, '') : `- [ ] ${l.replace(LEADING_MARKS, '')}`))
      return OK
    // ---- 插入 ----
    case 'ins-footnote': {
      const sel = ctx.selection
      if (!sel.text.trim() || sel.text.includes('\n')) return fail('请先选中要标注的单词或短语（单行）')
      const base = sel.text.trim().replace(/\^\[[^\]]*\]$/, '')
      const text = `${base}^[注释]`
      engine.replaceRange(sel.from, sel.to, text, text.length - 3, text.length - 1)
      return OK
    }
    // 表格：即时渲染档里表格是**渲染态 widget**（单元格就地编辑），所以不选源码文本，
    // 而是把焦点交给首格（`focusBlockCell`，源码档不实现 → 仍是「插完选中首格」的旧行为）。
    case 'ins-table': {
      const r = insertBlock(engine, ctx, TABLE_TPL)
      if (r.ok) engine.focusBlockCell?.(r.at)
      return r
    }
    case 'ins-callout': return insertBlock(engine, ctx, '> [!note] 标注标题\n> 正文', '标注标题')
    case 'ins-hr': return insertBlock(engine, ctx, '---')
    case 'ins-code': return insertBlock(engine, ctx, '```\n\n```', '\n')
    case 'ins-math': return insertBlock(engine, ctx, '$$\n\n$$', '\n')
    case 'ins-quiz': return insertBlock(engine, ctx, QUIZ_TPL, '题干')
    // ---- 剪贴板 ----
    case 'edit-select-all':
      engine.selectAll()
      return OK
    case 'edit-copy': {
      const sel = ctx.selection
      if (!sel.text) return fail('没有可复制的内容')
      return copyToClipboard(sel.text).then(() => OK)
    }
    case 'edit-cut': {
      const sel = ctx.selection
      if (!sel.text) return fail('没有可剪切的内容')
      return copyToClipboard(sel.text).then((r) => {
        if (r.ok) engine.replaceRange(sel.from, sel.to, '')
        return r
      })
    }
    case 'edit-paste':
    case 'edit-paste-plain': {
      const sel = ctx.selection
      const from = sel.from
      const to = sel.to
      return readClipboard().then((r) => {
        if (!r.ok) return r as NoteActionResult
        if (!r.text) return fail('剪贴板里没有文本')
        engine.replaceRange(from, to, r.text)
        return OK
      })
    }
  }
}

type ClipResult = { ok: true; text: string } | { ok: false; message: string }

/** 写剪贴板：主进程通道（`src/lib/ipc.ts` copyText）——渲染层不直连 navigator.clipboard */
async function copyToClipboard(text: string): Promise<NoteActionResult> {
  const { copyText } = await import('./ipc')
  const ok = await copyText(text)
  return ok ? OK : fail('写入剪贴板失败')
}

/** 读剪贴板文本：主进程通道（`clipboard:readText`） */
async function readClipboard(): Promise<ClipResult> {
  const { readClipboardText } = await import('./ipc')
  try {
    const text = await readClipboardText()
    return { ok: true, text: text ?? '' }
  } catch {
    return { ok: false, message: '读取剪贴板失败' }
  }
}

/** 供 UI 层判断某动作是否属于「需要选区」的一类（灰显文案用） */
export function noteActionRequiresSelection(id: NoteActionId): boolean {
  return id === 'ins-footnote' || id === 'edit-cut' || id === 'edit-copy'
}

/** 选区文本（菜单外用于展示） */
export function selectionSummary(sel: NoteSelection | null): string {
  if (!sel || !sel.text) return ''
  const one = sel.text.replace(/\s+/g, ' ').trim()
  return one.length > 18 ? `${one.slice(0, 18)}…` : one
}
