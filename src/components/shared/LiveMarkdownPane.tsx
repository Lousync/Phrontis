/**
 * 即时渲染档写作面（CodeMirror 6）—— 双写作面方案 `docs/note-surface-dual-engine-design.md`。
 *
 * 语义（对齐 Obsidian Live Preview）：
 * - 文档模型始终是 **Markdown 原文**（真相源不变，`.md` 仍是唯一落盘形态）；
 * - 非光标所在块**按排版渲染**：标题级差、加粗/斜体/行内代码/链接、列表与复选框、引用条、
 *   代码块底色、表格（只读渲染）、图片（内联，走 `attachmentImage` 的附件白名单）、
 *   行内与块级公式（KaTeX）；
 * - **光标/选区所在的块回源码**（`#` `**` `> ` 等标记可见）——这是「所见即所得」不失控的关键；
 * - 一期显式不渲染：mermaid、`quiz`/`ask`/`profile` 等项目自定义围栏、HTML 块、脚注气泡
 *   （保持源码文本，避免在编辑器里再跑一条重渲染管线）；
 * - 与源码档共用：`NoteEngineHandle` 契约、`wikiLinkSuggest` 候选、`inlineSuggestTrigger` 触发点、
 *   `attachmentImage` 图片取回、右键菜单（`NoteContextMenu`）。
 *
 * 本组件**只负责编辑面**：保存 / 冲突检测 / 广播刷新仍走 PageEditor 的既有链路（引擎只吐 onChange）。
 */

import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import { EditorState, Prec, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import {
  EditorView, Decoration, WidgetType, keymap, drawSelection, dropCursor, highlightSpecialChars,
  rectangularSelection, crosshairCursor, type DecorationSet, ViewPlugin, type ViewUpdate,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxTree, foldGutter, foldKeymap, indentOnInput, bracketMatching } from '@codemirror/language'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion } from '@codemirror/autocomplete'
import katex from 'katex'
// 代码块语法高亮：与阅读态预览**同一个库、同一套配色**（预览侧 rehype-highlight 底层就是 highlight.js），
// 于是「即时渲染档的代码卡片」与预览逐色一致。`lib/common` 是官方「常用语言」入口（约 37 种，
// 远小于全量构建），且本文件本身是 lazy chunk，不进首屏静态闭包（铁律 20）。
import hljs from 'highlight.js/lib/common'
import { loadWikiTargets } from '../../lib/wikiLinkSuggest'
import { getCachedVaultImage, loadVaultImage, normalizeVaultRel } from '../../lib/attachmentImage'
import { runNoteAction, type NoteActionId } from '../../lib/noteActions'
import type { NoteBlockContext, NoteEngineHandle, NoteSelection } from '../../lib/noteEngine'

export interface LiveMarkdownPaneProps {
  /** 文档内容（外部同步用；外部变更按最小 diff 落进模型，保光标） */
  content: string
  /** 内容变更回调（relPath 由宿主回填） */
  onChange: (value: string) => void
  /** 粘贴/拖拽图片：返回要插入的 md 文本（null = 放弃）；仅 markdown 文档传入 */
  onPasteImage?: (file: File) => Promise<string | null>
  onDropImage?: (file: File) => Promise<string | null>
  /** 右键菜单：宿主接管（两档同一份菜单） */
  onContextMenu?: (e: MouseEvent, api: LiveContextApi) => void
  /** 光标偏移变化（切档记忆：宿主按「文件 × 档位」记账） */
  onCursorOffset?: (offset: number) => void
  /** 首次挂载要落的光标位置（切档记忆；`undefined` = 不动，落在文首） */
  initialCursorOffset?: number
}

/** 右键菜单需要的最小上下文（宿主把它转成 NoteContextMenu 的 props） */
export interface LiveContextApi {
  clientX: number
  clientY: number
  selectionText: string
  insert: (text: string) => void
}

// ===== 右侧 `[[` 候选：与源码档共用 wikiLinkSuggest 的候选规则 =====

async function wikiCompletionSource(ctx: { state: EditorState; pos: number; matchBefore: (re: RegExp) => { from: number; to: number; text: string } | null; explicit: boolean }) {
  const before = ctx.matchBefore(/\[\[[^\]\n]*$/)
  if (!before && !ctx.explicit) return null
  const query = before ? before.text.slice(2) : ''
  const from = before ? before.from + 2 : ctx.pos
  const items = await loadWikiTargets(query)
  return {
    from,
    options: items.map((it) => ({
      label: it.title,
      detail: it.path,
      type: 'text',
      apply: `${it.title}]]`,
    })),
    validFor: /^[^\]\n]*$/,
  }
}

// ===== 装饰：非光标块渲染 / 光标块回源码 =====

/** 纯隐藏节点（语法标记） */
const HIDE_NODES = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'QuoteMark', 'ListMark', 'CodeInfo', 'URL'])

/** 行内容器 → 样式类（其子节点逐个上类，避免与隐藏装饰重叠） */
const INLINE_CLASS: Record<string, string> = {
  StrongEmphasis: 'kb-live-strong',
  Emphasis: 'kb-live-em',
  Strikethrough: 'kb-live-strike',
  InlineCode: 'kb-live-code',
  Link: 'kb-live-link',
}

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: 'kb-live-h1', ATXHeading2: 'kb-live-h2', ATXHeading3: 'kb-live-h3',
  ATXHeading4: 'kb-live-h4', ATXHeading5: 'kb-live-h5', ATXHeading6: 'kb-live-h6',
  // setext 形态（`标题` + 下一行 `===` / `---`）也要有级差，否则那段文字会渲染成「无样式标题」
  SetextHeading1: 'kb-live-h1', SetextHeading2: 'kb-live-h2',
}

/** 空隐藏装饰：替换为空（不可见，且天然成为原子的跳过单元） */
const HIDE = Decoration.replace({})

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly rel: string | null) { super() }
  eq(o: ImageWidget): boolean { return o.src === this.src && o.alt === this.alt && o.rel === this.rel }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    // 尺寸/圆角走 `.kb-md-atom img` 共用规则（与预览同一套），这里只管行内布局
    wrap.className = 'kb-live-img kb-md-atom'
    const img = document.createElement('img')
    img.alt = this.alt
    img.loading = 'lazy'
    if (this.rel) {
      const cached = getCachedVaultImage(this.rel)
      if (cached) img.src = cached
      else {
        img.classList.add('kb-live-img-loading')
        void loadVaultImage(this.rel).then((url) => {
          if (url) { img.src = url; img.classList.remove('kb-live-img-loading') }
          else img.classList.add('kb-live-img-broken')
        })
      }
    } else {
      img.src = this.src
    }
    wrap.appendChild(img)
    return wrap
  }
  ignoreEvent(): boolean { return false }
}

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) { super() }
  eq(o: MathWidget): boolean { return o.tex === this.tex && o.display === this.display }
  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'kb-live-math-block' : 'kb-live-math'
    try {
      // KaTeX 输出可信（内部转义输入）；其余用户内容一律不进 innerHTML
      el.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false, strict: false })
    } catch {
      el.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`
    }
    return el
  }
}

class HrWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'kb-live-hr'
    return el
  }
}

class BulletWidget extends WidgetType {
  constructor(readonly text: string) { super() }
  eq(o: BulletWidget): boolean { return o.text === this.text }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'kb-live-bullet'
    el.textContent = this.text
    return el
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super() }
  eq(o: CheckboxWidget): boolean { return o.checked === this.checked }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'kb-live-task'
    box.checked = this.checked
    // 点勾选框不该把光标塞进被替换的原子区：拦下 mousedown，click 时按**当前位置**改源文本
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('click', () => {
      const pos = view.posAtDOM(box)
      const line = view.state.doc.lineAt(pos)
      const m = /\[([ xX])\]/.exec(line.text)
      if (!m) return
      const at = line.from + m.index + 1
      view.dispatch({ changes: { from: at, to: at + 1, insert: m[1] === ' ' ? 'x' : ' ' } })
    })
    return box
  }
  ignoreEvent(): boolean { return false }
}

/** GFM 表格 → 只读渲染（光标进入表格时整块回源码） */
class TableWidget extends WidgetType {
  constructor(readonly src: string) { super() }
  eq(o: TableWidget): boolean { return o.src === this.src }
  toDOM(): HTMLElement {
    const rows = this.src.split('\n').filter((l) => l.trim())
    const cells = (line: string) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
    const wrap = document.createElement('div')
    // `kb-md-atom`：与阅读态预览**共用同一条 CSS**（`:is(.prose-content, .kb-md-atom) table/th/td`），
    // 所以这里不再自己写一遍宽度/内边距/表头底色 —— 数值只有一处，改预览即改写作面。
    wrap.className = 'kb-live-table-wrap kb-md-atom'
    const table = document.createElement('table')
    table.className = 'kb-live-table'
    if (rows.length >= 1) {
      const aligns = rows.length >= 2 ? cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : '')) : []
      const head = document.createElement('thead')
      const tr = document.createElement('tr')
      cells(rows[0]).forEach((c, i) => {
        const th = document.createElement('th')
        th.textContent = c
        if (aligns[i]) th.style.textAlign = aligns[i]
        tr.appendChild(th)
      })
      head.appendChild(tr)
      table.appendChild(head)
      const body = document.createElement('tbody')
      for (const line of rows.slice(2)) {
        const trb = document.createElement('tr')
        cells(line).forEach((c, i) => {
          const td = document.createElement('td')
          td.textContent = c
          if (aligns[i]) td.style.textAlign = aligns[i]
          trb.appendChild(td)
        })
        body.appendChild(trb)
      }
      table.appendChild(body)
    }
    wrap.appendChild(table)
    return wrap
  }
}

/**
 * 围栏代码块 → 只读卡片（光标进入整块回源码，与表格同一套语义）。
 *
 * 为什么用 widget 而不是「给代码行上类 + CM6 语法高亮」：预览的代码块是 `<pre>` 卡片 + highlight.js
 * 着色，编辑器若自己接 CM6 高亮，**配色与语言集都和预览不是同一套**（markdown 语言不带嵌套语言解析，
 * 还得另装 @codemirror/language-data）。这里直接产出与预览**同构的 DOM**并挂 `.kb-md-atom`，
 * 两边共用同一条 CSS 与同一个 highlight.js —— 一致性由构造保证，不靠人工对齐数值。
 */
class CodeBlockWidget extends WidgetType {
  constructor(readonly code: string, readonly lang: string) { super() }
  eq(o: CodeBlockWidget): boolean { return o.code === this.code && o.lang === this.lang }
  toDOM(): HTMLElement {
    const outer = document.createElement('div')
    outer.className = 'kb-md-atom'
    const pre = document.createElement('pre')
    const inner = document.createElement('div')
    inner.className = 'kb-live-codecard-inner'
    if (this.lang) {
      const tag = document.createElement('span')
      tag.className = 'kb-live-codecard-lang'
      tag.textContent = this.lang
      inner.appendChild(tag)
    }
    const code = document.createElement('code')
    code.className = this.lang ? `hljs language-${this.lang}` : 'hljs'
    if (this.lang && hljs.getLanguage(this.lang)) {
      // highlight.js 输出的是**已转义**的 HTML（只含 <span class="hljs-*">），与预览侧同源同色
      code.innerHTML = hljs.highlight(this.code, { language: this.lang, ignoreIllegals: true }).value
    } else {
      code.textContent = this.code
    }
    inner.appendChild(code)
    pre.appendChild(inner)
    outer.appendChild(pre)
    return outer
  }
}

/** 解析 `![alt](src)` / alt 与 src（src 可能是仓库相对附件） */
function parseImage(node: { from: number; to: number }, text: string): { alt: string; src: string } | null {
  const raw = text.slice(node.from, node.to)
  const m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(raw)
  if (!m) return null
  return { alt: m[1], src: m[2] }
}

/**
 * 生成一帧装饰。规则一句话：**光标/选区所在的行回源码，其余行渲染**。
 *
 * 实现纪律（踩过才知道的两条）：
 * ① 替换类装饰之间不得重叠、替换与插入也不得重叠 —— 故所有 hide/replace 都过一遍区间去重闸；
 * ② 行内容器**逐个给直接子节点上类**（而不是给整个容器上类 + 内部再隐藏标记），
 *    否则 mark 会横跨 replace，触发 CM6 的区间规则。
 */
function buildDecorations(state: EditorState, areas: readonly { from: number; to: number }[]): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const hides: { from: number; to: number }[] = []
  const replaces: { from: number; to: number }[] = []
  const doc = state.doc
  const sel = state.selection

  const activeLines = new Set<number>()
  for (const r of sel.ranges) {
    const a = doc.lineAt(r.from).number
    const b = doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) activeLines.add(n)
  }
  const hitsActiveLine = (from: number, to: number): boolean => {
    const a = doc.lineAt(from).number
    const b = doc.lineAt(Math.max(from, to)).number
    for (let n = a; n <= b; n++) if (activeLines.has(n)) return true
    return false
  }
  const containsCursor = (from: number, to: number): boolean =>
    sel.ranges.some((r) => r.from <= to && r.to >= from)

  const overlaps = (list: { from: number; to: number }[], from: number, to: number): boolean =>
    list.some((r) => from < r.to && to > r.from)

  const addHide = (from: number, to: number): void => {
    if (from >= to) return
    if (overlaps(hides, from, to) || overlaps(replaces, from, to)) return
    hides.push({ from, to })
    ranges.push(HIDE.range(from, to))
  }
  const addReplace = (from: number, to: number, widget: WidgetType): void => {
    if (from >= to) return
    if (overlaps(replaces, from, to) || overlaps(hides, from, to)) return
    replaces.push({ from, to })
    ranges.push(Decoration.replace({ widget }).range(from, to))
  }
  const addMark = (from: number, to: number, cls: string): void => {
    if (from >= to) return
    ranges.push(Decoration.mark({ class: cls }).range(from, to))
  }
  const addLine = (pos: number, cls: string): void => {
    ranges.push(Decoration.line({ class: cls }).range(pos))
  }

  const tree = syntaxTree(state)
  for (const visible of areas) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        const name = node.name
        // 行级样式（不隐藏任何东西，光标行也保留：引用条 / 代码块底色 / 标题级差）
        if (HEADING_CLASS[name]) {
          addLine(doc.lineAt(node.from).from, HEADING_CLASS[name])
          return
        }
        if (name === 'Blockquote') {
          const a = doc.lineAt(node.from).number
          const b = doc.lineAt(node.to).number
          for (let n = a; n <= b; n++) addLine(doc.line(n).from, 'kb-live-quote')
          return
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          if (containsCursor(node.from, node.to)) {
            // 光标进入 → 整块回源码；底色帮辨认块范围（渲染态由下面的代码卡片接管）
            const a = doc.lineAt(node.from).number
            const b = doc.lineAt(node.to).number
            for (let n = a; n <= b; n++) addLine(doc.line(n).from, 'kb-live-codeblock')
          } else {
            const info = node.node.getChild('CodeInfo')
            const codeText = node.node.getChild('CodeText')
            const lang = info ? state.sliceDoc(info.from, info.to).trim() : ''
            const code = codeText ? state.sliceDoc(codeText.from, codeText.to) : state.sliceDoc(node.from, node.to)
            addReplace(node.from, node.to, new CodeBlockWidget(code, lang))
          }
          return false
        }
        if (name === 'ListItem') return  // 交给 ListMark / TaskMarker 各自处理
        // 块级渲染（替换）：光标进入就不替，整块回源码
        if (name === 'Table') {
          if (!containsCursor(node.from, node.to)) addReplace(node.from, node.to, new TableWidget(state.sliceDoc(node.from, node.to)))
          return false
        }
        if (name === 'HorizontalRule') {
          if (!hitsActiveLine(node.from, node.to)) addReplace(node.from, node.to, new HrWidget())
          return false
        }
        if (name === 'Image') {
          if (!containsCursor(node.from, node.to)) {
            const img = parseImage(node, state.doc.toString())
            if (img) addReplace(node.from, node.to, new ImageWidget(img.src, img.alt, normalizeVaultRel(img.src)))
          }
          return false
        }
        if (name === 'TaskMarker') {
          if (!containsCursor(node.from, node.to)) {
            const raw = state.sliceDoc(node.from, node.to)
            addReplace(node.from, node.to, new CheckboxWidget(/[xX]/.test(raw)))
          }
          return false
        }
        if (name === 'ListMark') {
          const line = doc.lineAt(node.from)
          // 嵌套层级由**行首缩进**推出（不用遍历深度：视口切片会让「父列表在视口外」的项算成 0 层）
          const indent = (/^[ \t]*/.exec(line.text)?.[0] ?? '').replace(/\t/g, '    ').length
          const depth = Math.min(2, Math.floor(indent / 2))
          const rest = line.text.slice(indent)
          const raw = state.sliceDoc(node.from, node.to)
          if (/^[-*+]\s+\[[ xX]\]/.test(rest)) {
            // 任务行由复选框充当标记，不能再画项目符号（此前是「• ☐ 文本」双标记；预览侧同步修）
            const lead = /^[-*+]\s+/.exec(rest)?.[0] ?? ''
            if (!hitsActiveLine(node.from, node.to)) addHide(node.from, node.from + lead.length)
            return false
          }
          if (!hitsActiveLine(node.from, node.to)) {
            // 与预览的 disc / circle / square 同层同形；有序列表沿用源里的序号（预览会重编号，另条）
            const marker = /^\d/.test(raw) ? raw.trim() : (['•', '○', '▪'][depth] ?? '•')
            addReplace(node.from, node.to, new BulletWidget(marker))
          }
          return false
        }
        if (INLINE_CLASS[name]) {
          // ★ 行内容器的**正文是子节点之间的空隙**（`**加粗**` 的语法树里只有两个 EmphasisMark，
          //   文字本身不是节点）—— 所以不能「给子节点上类」，要把子节点**排除后取补集**当正文。
          //   排除项：语法标记（隐藏）、嵌套行内容器与图片（各自分支处理自己的正文）。
          const cls = INLINE_CLASS[name]
          const skip = hitsActiveLine(node.from, node.to)
          let at = node.from
          for (let ch = node.node.firstChild; ch; ch = ch.nextSibling) {
            // 先补上「这个子节点之前的那段正文」，再处理子节点本身（顺序不能反：
            // 两个 EmphasisMark 之间的文字正是夹在第二次迭代之前的那段空隙）
            if (!skip && ch.from > at) addMark(at, ch.from, cls)
            if (HIDE_NODES.has(ch.name) && !skip) addHide(ch.from, ch.to)
            at = Math.max(at, ch.to)
          }
          if (!skip && at < node.to) addMark(at, node.to, cls)
          return
        }
        if (HIDE_NODES.has(name)) {
          if (!hitsActiveLine(node.from, node.to)) addHide(node.from, node.to)
          return
        }
      },
    })

    // 公式：lezer 的 markdown 解析器不含数学语法（项目里数学是 remark-math 的扩展），
    // 故这里按可见区间做一次正则扫描；代码区间跳过（避免把代码里的 $ 当公式）。
    const text = state.sliceDoc(visible.from, visible.to)
    const scan = (re: RegExp, display: boolean): void => {
      for (const m of text.matchAll(re)) {
        if (m.index === undefined) continue
        const from = visible.from + m.index
        const to = from + m[0].length
        if (containsCursor(from, to) || hitsActiveLine(from, to)) continue
        if (isInsideCode(tree, from, to)) continue
        addReplace(from, to, new MathWidget(display ? m[1] : m[1], display))
      }
    }
    scan(/\$\$([\s\S]*?)\$\$/g, true)
    scan(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, false)
  }

  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
  return Decoration.set(ranges, true)
}

/** 该区间是否落在代码里（行内代码 / 围栏代码） */
function isInsideCode(tree: ReturnType<typeof syntaxTree>, from: number, to: number): boolean {
  let hit = false
  tree.iterate({
    from, to,
    enter: (n) => {
      if (/Code/.test(n.name)) { hit = true; return false }
      return undefined
    },
  })
  return hit
}

/**
 * 可见区间投递：StateField 拿不到 viewport，故由这个小 ViewPlugin 在挂载 / 滚动时
 * 把可见区间作为 effect 送进去（**只投递数据、不提供装饰** —— 跨行替换必须走 StateField）。
 */
const setLiveAreas = StateEffect.define<readonly { from: number; to: number }[]>()

interface LiveDecoValue {
  deco: DecorationSet
  areas: readonly { from: number; to: number }[]
}

const livePreviewField = StateField.define<LiveDecoValue>({
  create: (state) => {
    const areas = [{ from: 0, to: Math.min(state.doc.length, 2000) }]
    return { deco: buildDecorations(state, areas), areas }
  },
  update(value, tr) {
    let areas = value.areas
    let dirty = tr.docChanged || tr.selection !== undefined
    for (const e of tr.effects) {
      if (e.is(setLiveAreas)) { areas = e.value; dirty = true }
    }
    if (!dirty) return { deco: value.deco.map(tr.changes), areas }
    return { deco: buildDecorations(tr.state, areas), areas }
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
})

/** 视口变化 → 投递可见区间（同区间不重复投，避免自激循环） */
const liveViewportPlugin = ViewPlugin.fromClass(
  class {
    last: string
    constructor(view: EditorView) {
      this.last = ''
      this.report(view)
    }
    update(u: ViewUpdate): void {
      if (u.viewportChanged || u.docChanged) this.report(u.view)
    }
    report(view: EditorView): void {
      const areas = view.visibleRanges.map((r) => ({ from: r.from, to: r.to }))
      const key = areas.map((a) => a.from + ':' + a.to).join(',')
      if (key === this.last) return
      this.last = key
      // ★ 不能在 update 过程中调 dispatch（CM6 直接抛
      //   `Calls to EditorView.update are not allowed while an update is in progress`
      //   并被判为「plugin crashed」→ 装饰整帧失效）。推到下一帧再投。
      requestAnimationFrame(() => {
        try { view.dispatch({ effects: setLiveAreas.of(areas) }) } catch { /* 视图已销毁 */ }
      })
    }
  },
)

/** 主题：字号 / 字体 / 选中色跟随应用 token（渲染态用正文字体，代码用等宽）
 *  ★ 字号 = `1rem`（根字号，`App.tsx` 把缩放写成 `html{font-size}`）—— 与阅读态预览同一基准、
 *    随 Ctrl +/- 同步缩放。**不再跟随「编辑器字号」设置**（那只作用于源码档 Monaco）：
 *    2026-10-11 拍板「即时渲染档与预览像素级一致」优先于「写作字号自选」。 */
function liveTheme(): Extension {
  return EditorView.theme({
    '&': {
      fontSize: '1rem',
      fontFamily: 'var(--font-sans, system-ui, sans-serif)',
      color: 'var(--text-primary)',
      backgroundColor: 'transparent',
      height: '100%',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.75', overflow: 'auto' },
    '.cm-content': { padding: '10px 0 40vh', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 16px' },
    '.cm-cursor': { borderLeftColor: 'var(--text-primary)', borderLeftWidth: '1.5px' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--bg-selected, rgba(120,150,255,.28))' },
    '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--bg-selected, rgba(120,150,255,.32))' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--text-disabled)' },
    '.cm-tooltip-autocomplete': {
      border: '1px solid var(--border-color)',
      backgroundColor: 'var(--bg-secondary)',
      borderRadius: '6px',
      boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,.28))',
      fontSize: '12px',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--bg-selected)', color: 'var(--text-primary)' },
  })
}

/** 外部文本同步：算公共前后缀，只替换真正变动的中段 —— 与源码档 `applyTextDiff` 同一策略（保光标、不打断输入法） */
function applyTextDiff(view: EditorView, next: string): void {
  const prev = view.state.doc.toString()
  if (prev === next) return
  let start = 0
  const minLen = Math.min(prev.length, next.length)
  while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) start++
  let endPrev = prev.length
  let endNext = next.length
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--
    endNext--
  }
  view.dispatch({ changes: { from: start, to: endPrev, insert: next.slice(start, endNext) } })
}

/** 立即把外部文本落进模型（组合输入期间由调用方延后） */
export const LiveMarkdownPane = forwardRef<NoteEngineHandle, LiveMarkdownPaneProps>(function LiveMarkdownPane(
  { content, onChange, onPasteImage, onDropImage, onContextMenu, onCursorOffset, initialCursorOffset }, ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange
  const pasteRef = useRef(onPasteImage); pasteRef.current = onPasteImage
  const dropRef = useRef(onDropImage); dropRef.current = onDropImage
  const menuRef = useRef(onContextMenu); menuRef.current = onContextMenu
  const cursorRef = useRef(onCursorOffset); cursorRef.current = onCursorOffset
  const composingRef = useRef(false)
  const pendingRef = useRef<string | null>(null)

  // 契约实现与快捷键共用同一份（`makeCmHandle`）——见文件末尾的说明
  useImperativeHandle(ref, () => makeCmHandle(() => viewRef.current), [])

  const buildExtensions = useCallback((): Extension[] => {
    return [
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      foldGutter(),
      EditorState.allowMultipleSelections.of(true),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, addKeymap: true }),
      autocompletion({ override: [wikiCompletionSource as never], activateOnTyping: true, closeOnBlur: true }),
      livePreviewField,
      liveViewportPlugin,
      // 字号固定 1rem（= 根字号）：不再随「编辑器字号」设置变化，故不需要 Compartment 重配置
      liveTheme(),
      Prec.high(keymap.of([
        // 编辑器内组合键：两档语义一致（源码档同键位见 MonacoPane 的 addCommand），
        // 且都经同一份动作表下达 —— 不会出现「菜单能加粗、快捷键行为不一样」
        { key: 'Mod-b', run: (v) => { runCmAction(v, 'fmt-bold'); return true } },
        { key: 'Mod-i', run: (v) => { runCmAction(v, 'fmt-italic'); return true } },
        { key: 'Mod-k', run: (v) => { runCmAction(v, 'link-external'); return true } },
        { key: 'Mod-Alt-1', run: (v) => { runCmAction(v, 'para-h1'); return true } },
        { key: 'Mod-Alt-2', run: (v) => { runCmAction(v, 'para-h2'); return true } },
        { key: 'Mod-Alt-3', run: (v) => { runCmAction(v, 'para-h3'); return true } },
        { key: 'Mod-Alt-0', run: (v) => { runCmAction(v, 'para-text'); return true } },
      ])),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
      // 图片粘贴 / 拖拽（复用宿主的 editorImage 业务函数）
      EditorView.domEventHandlers({
        paste: (e, view) => {
          const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
          const cb = pasteRef.current
          if (!cb || files.length === 0) return false
          e.preventDefault()
          void insertImageFiles(view, files, cb)
          return true
        },
        dragover: (e) => {
          if (dropRef.current && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); return true }
          return false
        },
        drop: (e, view) => {
          const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
          const cb = dropRef.current
          if (!cb || files.length === 0) return false
          e.preventDefault()
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
          view.dispatch({ selection: { anchor: pos } })
          view.focus()
          void insertImageFiles(view, files, cb)
          return true
        },
        contextmenu: (e, view) => {
          const host = menuRef.current
          if (!host) return false
          e.preventDefault()
          const r = view.state.selection.main
          host(e, {
            clientX: e.clientX,
            clientY: e.clientY,
            selectionText: view.state.sliceDoc(r.from, r.to),
            insert: (text: string) => { view.dispatch({ changes: { from: r.from, to: r.to, insert: text } }); view.focus() },
          })
          return true
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        if (u.selectionSet || u.docChanged) cursorRef.current?.(u.state.selection.main.head)
      }),
    ]
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions: buildExtensions() }),
      parent: host,
    })
    viewRef.current = view
    // 探针调试钩子（与 `window.__kbTerm` / `window.__kb_inline_trigger` 同范式）：
    // 即时渲染档的文档模型在 CM6 内部，CDP 只能靠它读到「菜单动作到底改没改到文档」。
    ;(window as unknown as Record<string, unknown>).__kbLive = view
    // 切档记忆：首次挂载把上次的光标位置还回去（在这里做才没有「等挂载」竞态）
    if (initialCursorOffset !== undefined) {
      const pos = Math.max(0, Math.min(initialCursorOffset, view.state.doc.length))
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'nearest' }) })
    }
    // 组合输入期间不落外部文本（源码档同款纪律：否则会打断输入法候选）
    const onCompStart = (): void => { composingRef.current = true }
    const onCompEnd = (): void => {
      composingRef.current = false
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending !== null) applyTextDiff(view, pending)
    }
    view.contentDOM.addEventListener('compositionstart', onCompStart, true)
    view.contentDOM.addEventListener('compositionend', onCompEnd, true)
    return () => {
      view.contentDOM.removeEventListener('compositionstart', onCompStart, true)
      view.contentDOM.removeEventListener('compositionend', onCompEnd, true)
      view.destroy()
      viewRef.current = null
      const w = window as unknown as Record<string, unknown>
      if (w.__kbLive === view) delete w.__kbLive
    }
    // 只挂一次：content 的后续同步走下面的 effect（重建会丢光标与撤销栈）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部内容变更 → 最小 diff 落进模型（保光标）
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (composingRef.current) { pendingRef.current = content; return }
    applyTextDiff(view, content)
  }, [content])

  // 换文件（同一实例被复用）时把该文件上次的光标位置还回去
  useEffect(() => {
    const view = viewRef.current
    if (!view || initialCursorOffset === undefined) return
    const pos = Math.max(0, Math.min(initialCursorOffset, view.state.doc.length))
    view.dispatch({ selection: { anchor: pos } })
  }, [initialCursorOffset])

  return <div ref={hostRef} className="kb-live-pane h-full w-full" />
})

// ===== 编辑器内组合键：与右键菜单**同一份实现** =====
//
// 早先这里各写了一份 wrapInlineCm / insertExternalLinkCm / setHeadingCm —— 那就是「同一动作两份实现」，
// 改一处漏一处只是时间问题。现在统一经 `runNoteAction` 下达（与源码档 Monaco 的 Ctrl+B/I/K 同源）。
function runCmAction(view: EditorView, id: NoteActionId): void {
  const out = runNoteAction(id, makeCmHandle(() => view))
  if (out instanceof Promise) void out
}

/**
 * CM6 侧的写作面契约实现。抽成工厂的理由与源码档 `buildHandle` 相同：
 * **命令式句柄**与**快捷键**共用同一份实现，避免「菜单能做的事快捷键做得不一样」。
 */
function makeCmHandle(getView: () => EditorView | null): NoteEngineHandle {
  return {
    insertAtCursor: (text: string) => {
      const view = getView()
      if (!view) return
      const sel = view.state.selection.main
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } })
      view.focus()
    },
    revealLine: (line: number) => {
      const view = getView()
      if (!view) return
      const n = Math.max(1, Math.min(line, view.state.doc.lines))
      const pos = view.state.doc.line(n).from
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
      view.focus()
    },
    focus: () => getView()?.focus(),
    getSelection: () => {
      const view = getView()
      if (!view) return null
      const r = view.state.selection.main
      return { text: view.state.sliceDoc(r.from, r.to), from: r.from, to: r.to }
    },
    replaceRange: (from: number, to: number, text: string, selectFrom?: number, selectTo?: number) => {
      const view = getView()
      if (!view) return
      const max = view.state.doc.length
      const f = Math.max(0, Math.min(from, max))
      const t = Math.max(f, Math.min(to, max))
      const spec: Parameters<EditorView['dispatch']>[0] = { changes: { from: f, to: t, insert: text } }
      if (selectFrom !== undefined && selectTo !== undefined) {
        spec.selection = { anchor: f + selectFrom, head: f + selectTo }
      } else {
        spec.selection = { anchor: f + text.length }
      }
      view.dispatch(spec)
      view.focus()
    },
    getBlockContext: (): NoteBlockContext | null => {
      const view = getView()
      if (!view) return null
      const r = view.state.selection.main
      const line = view.state.doc.lineAt(r.from)
      return {
        lineText: line.text,
        lineFrom: line.from,
        lineTo: line.to,
        prevLineEmpty: line.number <= 1 || view.state.doc.line(line.number - 1).text.trim() === '',
        selection: { text: view.state.sliceDoc(r.from, r.to), from: r.from, to: r.to },
      }
    },
    getCursorOffset: () => getView()?.state.selection.main.head ?? 0,
    setCursorOffset: (offset: number) => {
      const view = getView()
      if (!view) return
      const pos = Math.max(0, Math.min(offset, view.state.doc.length))
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'nearest' }) })
    },
    selectAll: () => {
      const view = getView()
      if (!view) return
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
      view.focus()
    },
    getRaw: () => getView(),
    triggerWikiSuggest: () => {
      const view = getView()
      if (view) startCompletion(view)
    },
  }
}

/** 依次上传并插入（多张图按顺序落行） */
async function insertImageFiles(view: EditorView, files: File[], cb: (f: File) => Promise<string | null>): Promise<void> {
  const parts: string[] = []
  for (const f of files) {
    const snippet = await cb(f)
    if (snippet) parts.push(snippet)
  }
  if (parts.length === 0) return
  const r = view.state.selection.main
  const insert = parts.join('\n') + '\n'
  view.dispatch({ changes: { from: r.from, to: r.to, insert } })
  view.focus()
}
