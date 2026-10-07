/**
 * Markdown 标记淡化（编辑器"弱化版 Live Preview"，档 A）。
 *
 * 思路：Monaco 无法做块级渲染（行高不可变），但可以给非光标行加 inline decoration——
 * 把 **、#、-、[text](url) 等"标记符号"淡化（opacity 低），把被包裹的语义内容
 * 用 CSS 强调（加粗/斜体/代码底/链接色）。光标所在行保留全部原始标记，编辑不受干扰。
 *
 * 纯逻辑、无依赖，可在 node 冒烟。
 *
 * 坐标系：单行文本内的字符偏移统一 0-based [start, end)。
 */

/** decoration 类别 → CSS 类：标记符号淡化 / 语义内容强调 */
export type DimCls =
  | 'dim'          // 标记符号：**、#、- 、`、[]()、~~、[[ ]] —— 淡化
  | 'strong'       // **加粗**
  | 'em'           // *斜体*
  | 'del'          // ~~删除线~~
  | 'code'         // `行内代码`
  | 'link'         // [文本](url) 的"文本"部分
  | 'wiki'         // [[双链]] 的"标题"部分

export interface DimSpan {
  cls: DimCls
  /** 0-based，[start, end) */
  start: number
  end: number
}

/** 行首结构（标题/列表/引用/分隔线）——只产生 'dim' */
const LINE_PREFIX_PATTERNS: RegExp[] = [
  /^ {0,3}#{1,6}\s+/,             // ATX 标题
  /^ {0,3}(?:[-*+]|\d+[.)])\s+/,  // 无序/有序列表
  /^ {0,3}>+[ \t]?/,               // 引用块
  /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, // 分隔线
]

/**
 * 行内 token：三捕获组 (prefix)(content)(suffix)。
 * 链接因不对称（[text](url)）单独处理。
 */
interface TokenDef {
  cls: DimCls
  re: RegExp
}

const TOKEN_DEFS: TokenDef[] = [
  { cls: 'code', re: /(`)([^`\n]+)(`)/g },                    // `code`
  { cls: 'wiki', re: /(\[\[)([^\]\n]+)(\]\])/g },            // [[x]]
  { cls: 'strong', re: /(\*\*)([^*\n]+)(\*\*)/g },           // **x**
  { cls: 'strong', re: /(__)([^_\n]+)(__)/g },               // __x__
  { cls: 'del', re: /(~~)([^~\n]+)(~~)/g },                  // ~~x~~
  { cls: 'em', re: /(?<![*\w])(\*)([^*\n]+?)(\*)(?!\*)/g },  // *x*（避免与 ** 粘连）
  { cls: 'em', re: /(?<![_\w])(_)([^_\n]+?)(_)(?!_)/g },     // _x_
]

interface ParsedToken {
  cls: DimCls
  start: number
  contentStart: number
  contentEnd: number
  end: number
}

/** 解析单行行内 token（不含行首结构）。*/
function parseInline(line: string): ParsedToken[] {
  const tokens: ParsedToken[] = []
  const LINK_RE = /(\[)([^\]\n]+)(\]\([^)\n]+\))/g
  let m: RegExpExecArray | null
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(line)) !== null) {
    tokens.push({
      cls: 'link', start: m.index,
      contentStart: m.index + m[1].length,
      contentEnd: m.index + m[1].length + m[2].length,
      end: m.index + m[0].length,
    })
  }
  for (const def of TOKEN_DEFS) {
    def.re.lastIndex = 0
    while ((m = def.re.exec(line)) !== null) {
      tokens.push({
        cls: def.cls, start: m.index,
        contentStart: m.index + m[1].length,
        contentEnd: m.index + m[1].length + m[2].length,
        end: m.index + m[0].length,
      })
    }
  }
  // 重叠过滤：start 升序，同 start 长者优先；与已保留段重叠则丢弃（code/wiki/strong 先声明先占）
  tokens.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: ParsedToken[] = []
  for (const tk of tokens) {
    const prev = kept[kept.length - 1]
    if (prev && tk.start < prev.end) continue
    kept.push(tk)
  }
  return kept
}

/**
 * 单行淡化计算。activeLine=true（光标所在行）→ 空（编辑不受干扰）。
 */
/**
 * 单行装饰：
 * - 'dim'（标记淡显）只作用于非光标行——纯 opacity 不改字宽，光标行还原「原始标记可见」；
 * - 'strong'/'em'/'code' 是**改字宽类**（粗体/斜体/等宽+padding），必须跨行恒定：
 *   若随光标进出切换，该行会在粗体↔正常间重排版，光标视觉上左右「漂移」（2026-09-09 修复）。
 *   内容强调在所有行一致渲染，光标行仅少一层标记淡显，不多一份宽度变化。
 */
const WIDTH_STABLE: Set<DimCls> = new Set(['strong', 'em', 'code'])

export function dimMarkdownLine(line: string, activeLine: boolean): DimSpan[] {
  if (line.length === 0) return []
  const out: DimSpan[] = []

  if (!activeLine) {
    for (const re of LINE_PREFIX_PATTERNS) {
      const m = re.exec(line)
      if (m && m[0].length > 0) {
        out.push({ cls: 'dim', start: 0, end: m[0].length })
        break
      }
    }
  }

  for (const tk of parseInline(line)) {
    if (tk.contentEnd <= tk.contentStart) continue
    // 内容去首尾空白后仍非空才强调
    let cs = tk.contentStart
    let ce = tk.contentEnd
    while (cs < ce && /\s/.test(line[cs])) cs++
    while (ce > cs && /\s/.test(line[ce - 1])) ce--
    if (!activeLine) out.push({ cls: 'dim', start: tk.start, end: cs })
    if (ce > cs && (!activeLine || WIDTH_STABLE.has(tk.cls))) out.push({ cls: tk.cls, start: cs, end: ce })
    if (!activeLine) out.push({ cls: 'dim', start: ce, end: tk.end })
  }

  out.sort((a, b) => a.start - b.start)
  return out
}

/** 整文计算（Monaco 坐标：行/列均 1-based，含 endCol） */
export interface DimDecoration {
  line: number
  cls: DimCls
  startCol: number
  endCol: number
}

export function dimMarkdownText(lines: string[], activeLine1Based: number): DimDecoration[] {
  const decos: DimDecoration[] = []
  for (let i = 0; i < lines.length; i++) {
    // 不再整行跳过光标行：宽度稳定类（strong/em/code）全行恒定渲染，
    // 仅 dim 由 dimMarkdownLine 内部按 activeLine 关闭（光标不漂移，标记仍还原）
    for (const s of dimMarkdownLine(lines[i], i + 1 === activeLine1Based)) {
      if (s.end <= s.start) continue
      decos.push({ line: i + 1, cls: s.cls, startCol: s.start + 1, endCol: s.end + 1 })
    }
  }
  return decos
}

/** 抽取单行内的 [[双链]] 内容区间（不含两侧标记，供 accent 高亮复用） */
export function wikiSpans(line: string): DimSpan[] {
  const out: DimSpan[] = []
  for (const tk of parseInline(line)) {
    if (tk.cls !== 'wiki') continue
    if (tk.contentEnd <= tk.contentStart) continue
    let cs = tk.contentStart
    let ce = tk.contentEnd
    while (cs < ce && /\s/.test(line[cs])) cs++
    while (ce > cs && /\s/.test(line[ce - 1])) ce--
    if (ce > cs) out.push({ cls: 'wiki', start: cs, end: ce })
  }
  return out
}

/**
 * 双链常驻高亮（与淡化开关解耦）：无论光标在哪一行、淡化是否开启，
 * `[[内容]]` 都以 accent 强调——双链是结构信息，写作时始终可见。
 */
export function markdownWikiHighlights(lines: string[]): DimDecoration[] {
  const decos: DimDecoration[] = []
  for (let i = 0; i < lines.length; i++) {
    for (const s of wikiSpans(lines[i])) {
      if (s.end <= s.start) continue
      decos.push({ line: i + 1, cls: 'wiki', startCol: s.start + 1, endCol: s.end + 1 })
    }
  }
  return decos
}

/** 从 wiki 内容（含 `[[别名|目标]]` 形式）解析「目标页标题/文件名」 */
export function wikiTargetTitle(content: string): string {
  // 取 | 之前的部分（Obsidian 别名语法：[[目标|别名]]）
  return content.split('|')[0].trim()
}
