/**
 * 写作面（Note Surface）契约 —— 双写作面方案 `docs/note-surface-dual-engine-design.md`。
 *
 * 笔记正文有两个对等的写作面：
 * - `source` 源码档（Monaco，既有实现）：显示 Markdown 原文 + 标记淡化；
 * - `live`   即时渲染档（CodeMirror 6）：非光标块按排版渲染，光标所在块回源码。
 *
 * 两档共用同一份「契约 + 动作表 + 右键菜单 + 保存链路」，由宿主 `NoteSurface` 二选一挂载。
 * **本文件零依赖**（只带类型与一个内存表），便于契约脚本直接 import 做纯函数断言。
 */

export type NoteEngineId = 'source' | 'live'

/** 选区（字符偏移，0-based；from === to 表示光标） */
export interface NoteSelection {
  text: string
  from: number
  to: number
}

/** 光标所在块的上下文（右键菜单与段落类动作的输入） */
export interface NoteBlockContext {
  /** 光标所在行（不含换行符） */
  lineText: string
  /** 该行在文档中的字符区间起点 */
  lineFrom: number
  /** 该行在文档中的字符区间终点（= lineFrom + lineText.length） */
  lineTo: number
  /** 光标上一行是否为空行（首行视为空）。块级插入靠它决定要不要补空行 ——
   *  `---` 紧跟段落会被 Markdown 解析成**标题下划线**（setext），补空行才是分隔线。 */
  prevLineEmpty: boolean
  /** 当前选区（无选区时为光标处的空区间） */
  selection: NoteSelection
}

/**
 * 引擎句柄：`MonacoPaneHandle` 与 `LiveMarkdownPane` 都实现它。
 *
 * ★ 只放「两档都能做、且动作表需要」的最小面。AI 续写（Monaco 的 InlineCompletionsProvider）
 * 这类单档能力**不进契约** —— 硬塞进来会让源码档为了迁就抽象而退化。
 */
export interface NoteEngineHandle {
  /** 在光标处插入文本（多张图依次调用） */
  insertAtCursor(text: string): void
  /** 滚动到指定行并聚焦（大纲跳转） */
  revealLine(line: number): void
  focus(): void
  /** 当前选区；引擎未就绪返回 null */
  getSelection(): NoteSelection | null
  /**
   * 用 `text` 替换 `[from, to)`；给出 `selectFrom` / `selectTo`（相对 `text` 的偏移）时选中该区间，
   * 便于「插入占位再选中占位」（脚注的「注释」二字即走这条）。
   */
  replaceRange(from: number, to: number, text: string, selectFrom?: number, selectTo?: number): void
  /** 光标所在块的上下文（段落类动作的行前缀改写都基于它） */
  getBlockContext(): NoteBlockContext | null
  /** 光标字符偏移（切档记忆用） */
  getCursorOffset(): number
  /** 恢复光标到字符偏移；引擎未就绪或越界时静默夹取 */
  setCursorOffset(offset: number): void
  selectAll(): void
  /** 原始引擎实例（Monaco editor / CM6 EditorView；勿存引用） */
  getRaw(): unknown
  /**
   * 唤起一次 `[[` 候选建议（源码档 = Monaco 建议；即时渲染档 = CM6 补全）。
   * 可选：菜单的「新增链接」在插完 `[[` 后调它；未实现则只插语法，不影响可用性。
   */
  triggerWikiSuggest?(): void
}

// ===== 切档光标记忆（按「文件 × 档位」各记一个字符偏移）=====
//
// 两个引擎的撤销栈不能合并，跨档搬运只能做到「位置」这一层：切档时先落盘，
// 再按目标档记住的偏移落光标。不存这个表的话，来回切一次就回到文首。
const cursorMemory = new Map<string, Partial<Record<NoteEngineId, number>>>()

/** 记下某文件在某档的光标偏移（切档 / 关页签前调用） */
export function rememberCursor(relPath: string, engine: NoteEngineId, offset: number): void {
  if (!relPath || !Number.isFinite(offset) || offset < 0) return
  const rec = cursorMemory.get(relPath) ?? {}
  rec[engine] = Math.floor(offset)
  cursorMemory.set(relPath, rec)
}

/** 取某文件在某档上次的光标偏移（无记录返回 undefined） */
export function recallCursor(relPath: string, engine: NoteEngineId): number | undefined {
  return cursorMemory.get(relPath)?.[engine]
}

/** 换仓库 / 文件被删时清记录（防内存表跟着会话无限长） */
export function forgetCursor(relPath: string): void {
  cursorMemory.delete(relPath)
}
