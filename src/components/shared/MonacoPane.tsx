import { useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { forwardRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { bindEditorTheme, applyEditorTheme, setEditorThemeVariant } from '../../lib/editorTheme'
// Monaco 运行时装配（worker 注册 + loader 本地化）下沉到宿主组件：不随应用入口进首屏 chunk（性能 2026-09-10）
import '../../lib/monaco-setup'
import { dimMarkdownText, markdownWikiHighlights, wikiTargetTitle, type DimCls } from '../../lib/markdownDim'
import { getKnowledgePages, aiInlineSuggestRun, aiInlineSuggestCancel } from '../../lib/ipc'
// B4 自动触发闸门（纯函数：触发点判定 / 冷却记账 / 常量；零依赖便于契约脚本 import）
import { AUTO_DEBOUNCE_MS, INITIAL_AUTO_STATE, afterAutoResult, canAutoRequest, isTriggerPoint, type AutoState } from '../../lib/inlineSuggestTrigger'
import { MonacoErrorBoundary } from './MonacoErrorBoundary'
import type { KnowledgePage } from '../../types/index'

/**
 * 全仓共享 Monaco 编辑宿主（笔记合并 Phase 1 P1b，docs/notes-merge-phase1-design.md §1.2）。
 * 从 editor 模块上移：编辑区（EditorDoc）与知识库就地编辑（PageEditor）共用同一份
 * Monaco 装配 / [[ 补全 / B4 内联建议 / 淡化装饰 / 禅模式 / 图片粘贴拦截。
 *
 * 文档以**结构化 PaneDoc** 传入（EditorDoc 天然满足），共享层不依赖任何模块内部类型。
 */

/** 结构化文档：编辑器的 EditorDoc 与知识库的就地编辑文档都满足此形状 */
export interface PaneDoc {
  /** 相对路径（onChange 回传键、内联建议日志）。模型 URI 见 modelPath */
  relPath: string
  /** 模型 URI 路径覆盖：跨模块防 Monaco model 共享（同名文件在编辑区与知识库同时打开时，
   *  共享 model 会让 onChange/外部变更监听互相打架）——传 `kb://knowledge/<relPath>` 这类命名空间路径。 */
  modelPath?: string
  content: string
  language: string
  binary: boolean
  editable: boolean
  truncated: boolean
  size: number
}

interface Props {
  doc: PaneDoc | null
  onChange: (relPath: string, value: string) => void
  /** Markdown 标记淡化（设置 markdownDim 透传；默认开）。关闭时仅保留 [[双链]] accent 高亮 */
  dimEnabled?: boolean
  /** 布局刷新键：变化时显式触发 editor.layout()（禅模式隐壳后容器尺寸变化，§6-3） */
  layoutKey?: number
  /** 禅模式：非光标行整行淡化（iA Writer 式聚焦）+ 隐藏行号/大留白 */
  zen?: boolean
  /** 打字机滚动：光标行始终垂直居中（独立开关，默认关） */
  typewriter?: boolean
  /** 纸感氛围：编辑器底透明，容器承载暖纸白/墨夜色（设置 zenPaper） */
  zenPaper?: boolean
  /** 字号覆盖（知识库随缩放系数缩放；缺省 13 = 编辑器模块现行为） */
  fontSize?: number
  /** Monaco options 覆盖（合并到默认值之后；placeholder / 字体族等调用方差异从这里进） */
  editorOptions?: Monaco.editor.IStandaloneEditorConstructionOptions
  /** P3 插图：粘贴图片拦截（返回要插入的 md 文本；null = 放弃）。仅 markdown 文档传入 */
  onPasteImage?: (file: File) => Promise<string | null>
  /** 拖拽图片落稿（知识库就地编辑需要；语义同 onPasteImage，光标落在松手位置） */
  onDropImage?: (file: File) => Promise<string | null>
  /** B4 内联建议开关（设置 aiAssistantInlineSuggest；关时快捷键不发起请求） */
  inlineSuggestEnabled?: boolean
  /** B4 自动触发开关（设置 aiAssistantInlineSuggestAuto；关 = 仅手动 Alt+A / 胶囊按钮） */
  inlineSuggestAuto?: boolean
  /** B4 请求态回调（true = 正在生成），供编辑器状态栏微标 */
  onInlineSuggestBusy?: (busy: boolean) => void
  /** B4 自动暂停态回调（连续若干次建议没被采纳 → 暂停自动，直到手动唤醒） */
  onInlineSuggestPaused?: (paused: boolean) => void
}

export interface MonacoPaneHandle {
  /** 大纲跳转：滚动到指定行并聚焦 */
  revealLine(line: number): void
  /** P3 插图：在光标处插入文本（多张图依次调用），插入后聚焦 */
  insertAtCursor(text: string): void
  /** B4 手动触发一次内联建议（Alt+A）。返回 false = 未触发（无编辑器 / 文档不支持 / 开关关闭） */
  triggerInlineSuggest(): boolean
  /** 聚焦编辑器（知识库就地编辑：进入编辑态即聚焦） */
  focus(): void
  /** 取原始编辑器实例（脚注选区操作等少数高级用法；慎用，勿存引用） */
  getEditor(): Monaco.editor.IStandaloneCodeEditor | null
}

/** DimCls → inlineClassName（CSS 类定义见 src/styles/index.css） */
const DIM_PREFIX: Record<DimCls, string> = {
  dim: 'kb-md-dim',
  strong: 'kb-md-strong',
  em: 'kb-md-em',
  del: 'kb-md-del',
  code: 'kb-md-code',
  link: 'kb-md-link',
  wiki: 'kb-md-wiki',
}

// ---- [[ 补全数据源缓存：仓库全部知识页（title→用于匹配）----
// 30s 内复用；换文档/换仓库经 onDidChangeModel 触发失效由 installCompletion 的失效钩子处理。
let pageCache: { at: number; pages: KnowledgePage[] } | null = null
const PAGE_CACHE_TTL = 30_000

async function getPagesCached(): Promise<KnowledgePage[]> {
  const now = Date.now()
  if (pageCache && now - pageCache.at < PAGE_CACHE_TTL) return pageCache.pages
  try {
    const pages = await getKnowledgePages()
    pageCache = { at: now, pages }
    return pages
  } catch {
    return pageCache?.pages ?? []
  }
}

/** 编辑器面板级错误边界已提升为全仓共享 MonacoErrorBoundary（V-7：blog/knowledge 两处
 *  Editor 同暴露面，见 src/components/shared/MonacoErrorBoundary.tsx） */

/** 编辑器「大纲」导航句柄透传 */
export const MonacoPane = forwardRef<MonacoPaneHandle, Props>(function MonacoPane(
  { doc, onChange, dimEnabled = true, layoutKey = 0, zen = false, typewriter = false, zenPaper = true, fontSize, editorOptions, onPasteImage, onDropImage, inlineSuggestEnabled = true, inlineSuggestAuto = true, onInlineSuggestBusy, onInlineSuggestPaused },
  ref,
) {
  const hostRef = useRef<MonacoPaneHandle | null>(null)
  useImperativeHandle(ref, () => ({
    revealLine: (line: number) => hostRef.current?.revealLine(line),
    insertAtCursor: (text: string) => hostRef.current?.insertAtCursor(text),
    triggerInlineSuggest: () => hostRef.current?.triggerInlineSuggest() ?? false,
    focus: () => hostRef.current?.focus(),
    getEditor: () => hostRef.current?.getEditor() ?? null,
  }), [])

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-muted)]">
        从左侧选择文件打开
      </div>
    )
  }
  if (doc.binary) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]">
        <span>二进制文件，不支持编辑</span>
        <span className="text-[12px] text-[var(--text-tertiary)]">{doc.size.toLocaleString()} bytes</span>
      </div>
    )
  }
  if (doc.truncated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]">
        <span>文件超过 50MB，拒绝打开</span>
      </div>
    )
  }
  return <MonacoHost ref={hostRef} doc={doc} onChange={onChange} dimEnabled={dimEnabled} layoutKey={layoutKey} zen={zen} typewriter={typewriter} zenPaper={zenPaper} fontSize={fontSize} editorOptions={editorOptions} onPasteImage={onPasteImage} onDropImage={onDropImage} inlineSuggestEnabled={inlineSuggestEnabled} inlineSuggestAuto={inlineSuggestAuto} onInlineSuggestBusy={onInlineSuggestBusy} onInlineSuggestPaused={onInlineSuggestPaused} />
})

/** model → relPath（内联建议的 relPath 参数取真实 relPath，不受命名空间 modelPath 影响） */
const relPathByModel = new WeakMap<Monaco.editor.ITextModel, string>()

/** 有效文档的 Monaco 宿主；hooks 集中在子组件，doc 为 null 时父组件卸载它（满足 hooks 规则） */
const MonacoHost = forwardRef<MonacoPaneHandle, { doc: PaneDoc; onChange: Props['onChange']; dimEnabled: boolean; layoutKey: number; zen: boolean; typewriter: boolean; zenPaper: boolean; fontSize?: number; editorOptions?: Props['editorOptions']; onPasteImage?: Props['onPasteImage']; onDropImage?: Props['onDropImage']; inlineSuggestEnabled: boolean; inlineSuggestAuto: boolean; onInlineSuggestBusy?: Props['onInlineSuggestBusy']; onInlineSuggestPaused?: Props['onInlineSuggestPaused'] }>(
  function MonacoHost({ doc, onChange, dimEnabled, layoutKey, zen, typewriter, zenPaper = true, fontSize, editorOptions, onPasteImage, onDropImage, inlineSuggestEnabled = true, inlineSuggestAuto = true, onInlineSuggestBusy, onInlineSuggestPaused }, ref) {
    const dimEnabledRef = useRef(dimEnabled)
    dimEnabledRef.current = dimEnabled
    /** P3 粘贴/拖拽拦截回调透传（监听器只挂一次，不随 prop 变化重挂） */
    const pasteImageRef = useRef<Props['onPasteImage']>(onPasteImage)
    pasteImageRef.current = onPasteImage
    const dropImageRef = useRef<Props['onDropImage']>(onDropImage)
    dropImageRef.current = onDropImage
    /** 禅聚焦淡化 + 打字机（ref 透传进 onMount 闭包） */
    const zenDimRef = useRef(zen)
    zenDimRef.current = zen
    const typewriterRef = useRef(typewriter)
    typewriterRef.current = typewriter
    /** onMount 内注册的整文重算（供 dimEnabled/zen 开关即时触发） */
    const applyFnRef = useRef<(() => void) | null>(null)
    const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
    const lastFileRef = useRef<string>(doc.relPath)
    /** 打字机留白去重（同一 pad 不重复 updateOptions，防 layout 事件循环） */
    const padRef = useRef(0)
    /** 平滑滚动动画句柄（光标移动时重启） */
    const smoothRafRef = useRef(0)
    /** B4 内联建议：开关 + 请求态回调透传（onMount 闭包只注册一次，读 ref 拿最新值） */
    const inlineOnRef = useRef(inlineSuggestEnabled)
    inlineOnRef.current = inlineSuggestEnabled
    const inlineBusyRef = useRef<Props['onInlineSuggestBusy']>(onInlineSuggestBusy)
    inlineBusyRef.current = onInlineSuggestBusy
    // 自动通道开关 + 暂停态回调：模块级状态（provider/debounce 闭包读不到 React 闭包）
    setInlineAutoMode(inlineSuggestAuto)
    const inlinePausedRef = useRef<Props['onInlineSuggestPaused']>(onInlineSuggestPaused)
    inlinePausedRef.current = onInlineSuggestPaused
    /** B4 触发入口（onMount 内装配，供 handle.triggerInlineSuggest 调用） */
    const triggerInlineRef = useRef<(() => boolean) | null>(null)
    /** 多宿主监听注销句柄（编辑区 keep-alive + 知识库就地编辑可能同时挂着两个宿主） */
    const busyDisposeRef = useRef<(() => void) | null>(null)
    const pausedDisposeRef = useRef<(() => void) | null>(null)

    /** 打字机留白：上下各 ~40% 视口高 → 文首/文尾行也能真正居中（iA Writer/Typora 式） */
    const applyZenPadding = useCallback((ed: Monaco.editor.IStandaloneCodeEditor): void => {
      const pad = Math.max(140, Math.round(ed.getLayoutInfo().height * 0.4))
      if (Math.abs(pad - padRef.current) < 8) return
      padRef.current = pad
      ed.updateOptions({ padding: { top: pad, bottom: pad } })
    }, [])

    /** 平滑滚动至光标行垂直居中：瞬跳读目标 scrollTop → 回滚 → rAF 缓动（easeOutCubic 180ms） */
    const smoothCenterLine = useCallback((ed: Monaco.editor.IStandaloneCodeEditor, line: number): void => {
      const s0 = ed.getScrollTop()
      ed.revealLineInCenter(line)
      const s1 = ed.getScrollTop()
      ed.setScrollTop(s0)
      if (Math.abs(s1 - s0) < 2) return
      cancelAnimationFrame(smoothRafRef.current)
      const t0 = performance.now()
      const step = (t: number): void => {
        const p = Math.min(1, (t - t0) / 180)
        ed.setScrollTop(Math.round(s0 + (s1 - s0) * (1 - Math.pow(1 - p, 3))))
        if (p < 1) smoothRafRef.current = requestAnimationFrame(step)
      }
      smoothRafRef.current = requestAnimationFrame(step)
    }, [])

    useImperativeHandle(ref, () => ({
      revealLine: (line: number) => {
        const editor = editorRef.current
        if (!editor) return
        const model = editor.getModel()
        if (!model) return
        const total = model.getLineCount()
        const target = Math.max(1, Math.min(line, total))
        editor.revealLineInCenter(target)
        editor.setPosition({ lineNumber: target, column: 1 })
        editor.focus()
      },
      insertAtCursor: (text: string) => {
        const editor = editorRef.current
        if (!editor) return
        const pos = editor.getPosition()
        if (!pos) return
        const range = { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }
        editor.executeEdits('kb-insert', [{ range, text, forceMoveMarkers: true }])
        editor.focus()
      },
      triggerInlineSuggest: () => triggerInlineRef.current?.() ?? false,
      focus: () => editorRef.current?.focus(),
      getEditor: () => editorRef.current,
    }), [])

    const onMount = useCallback<OnMount>((editor, monaco) => {
      editorRef.current = editor
      relPathByModel.set(editor.getModel()!, doc.relPath)
      // 禅模式在挂载时即生效（[zen] effect 跑在 Monaco 异步挂载完成前，editorRef 尚为 null）
      if (zenDimRef.current) {
        editor.updateOptions({ lineNumbers: 'off', fontSize: 14 })
        if (typewriterRef.current) applyZenPadding(editor)
        else editor.updateOptions({ padding: { top: 28, bottom: 180 } })
      }
      // @monaco-editor/react 的 theme prop 重挂载时会强制 knowbase-auto；
      // 若主题变体已被切到 knowbase-zen（纸感透明底），按当前 variant 恢复
      applyEditorTheme()
      // 窗口/容器尺寸变化时重算打字机留白（padRef 去重防循环）
      editor.onDidLayoutChange(() => {
        if (typewriterRef.current) applyZenPadding(editor)
      })
      const collection = editor.createDecorationsCollection([])
      let scheduled = false
      let alive = true

      /** 整文重算：markdown 才有淡化/高亮；开关只决定淡化是否参与（wiki 高亮常驻） */
      const realApply = (): void => {
        if (!alive) return
        const model = editor.getModel()
        const isMd = model?.getLanguageId() === 'markdown'
        if (!isMd || !model) { collection.set([]); return }
        const pos = editor.getPosition()
        const lines = model.getValue().split('\n')
        const cursorLine = pos ? pos.lineNumber : -1
        // 淡化开启：整文淡化（光标行保留原始标记，双链内容 accent）；
        // 淡化关闭：仍保留 [[双链]] accent 高亮——双链是结构信息，写作时始终可见。
        const sources = dimEnabledRef.current ? dimMarkdownText(lines, cursorLine) : markdownWikiHighlights(lines)
        const decos: Monaco.editor.IModelDeltaDecoration[] = []
        for (const d of sources) {
          if (d.startCol >= d.endCol) continue
          decos.push({
            range: new monaco.Range(d.line, d.startCol, d.line, d.endCol),
            options: { inlineClassName: DIM_PREFIX[d.cls] },
          })
        }
        // 禅聚焦淡化（iA Writer 式渐进）：按与光标行的距离分 3 档降透明——
        // 近处保留上下文可读，远处退场，视线自然锚定当前行
        if (zenDimRef.current && isMd && cursorLine > 0) {
          for (let ln = 1; ln <= lines.length; ln++) {
            const d = Math.abs(ln - cursorLine)
            if (d === 0) continue
            const cls = d <= 1 ? 'zen-dim-1' : d <= 4 ? 'zen-dim-2' : 'zen-dim-3'
            decos.push({
              range: new monaco.Range(ln, 1, ln, 1),
              options: { className: cls, isWholeLine: true },
            })
          }
        }
        collection.set(decos)
      }
      applyFnRef.current = realApply

      const schedule = (): void => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          realApply()
        })
      }

      // 换文档时先清掉旧 model 的 decoration，再对新 model 重算；同时失效补全缓存 + 记账 relPath
      editor.onDidChangeModel(() => {
        collection.set([])
        pageCache = null
        const m = editor.getModel()
        if (m) relPathByModel.set(m, doc.relPath)
        schedule()
      })
      editor.onDidChangeModelContent(() => schedule())
      editor.onDidChangeCursorPosition((e) => {
        schedule()
        // 打字机滚动（iA Writer/Typora 式）：平滑滚动至光标行垂直居中
        if (typewriterRef.current) {
          const line = e.position?.lineNumber ?? 0
          if (line > 0) smoothCenterLine(editor, line)
        }
      })
      schedule()

      // ---- [[ 双链自动补全（数据源：仓库知识页索引，经缓存）----
      // Monaco language 级 provider 注册一次即可（编辑器实例单例）；重复调用会叠加，
      // 因此模块级 guard 只注册一次（schema 全局共享）。
      installWikiCompletion(monaco)

      // ---- B4 内联建议（AI 续写 ghost text）----
      // provider 注册一次（language 级，同 installWikiCompletion）；触发入口按编辑器实例装配。
      installInlineCompletion(monaco)
      // 触发入口：Alt+A / 胶囊按钮 / 自动通道 → 走 Monaco 内建命令 editor.action.inlineSuggest.trigger。
      // 该命令的 precondition 只有 EditorContextKeys.writable（已核实产物 monaco-lFGDj3sW.js
      // 的 TriggerInlineSuggestionAction），不要求 inlineSuggestionVisible → 手动触发可行。
      // explicit 默认 true：显式请求的 ghost text 在打字/移光标时自动消失，不必自己管生命周期。
      const fireInlineTrigger = (): boolean => {
        if (!inlineOnRef.current) return false
        const model = editor.getModel()
        if (!model || model.getLanguageId() !== 'markdown') return false
        if (!model.getValue().trim()) return false
        // 破缓存 → 点火 → 触发，三步顺序不能换（见 installInlineCompletion 注释）：
        // 重注册让 providers 集合变化，点火让 provider 放行本次请求，最后才 trigger。
        installInlineCompletion(monaco, true)
        armInlineSuggest()
        void Promise.resolve(editor.trigger('kb-inline', 'editor.action.inlineSuggest.trigger', null))
          .catch(() => { /* 触发失败静默：不打断写作 */ })
        return true
      }
      // 手动入口（Alt+A / 胶囊按钮）：显式「我现在要」→ 唤醒自动 + 重置冷却计数，
      // 且**不看触发点判定**（用户说了才算）。
      triggerInlineRef.current = (): boolean => {
        settleAutoOutcome()
        inlineAutoState = { ...INITIAL_AUTO_STATE }
        inlinePausedListeners.forEach((fn) => fn(false))
        return fireInlineTrigger()
      }

      // ---- 自动通道：停顿 → 触发点判定 → 冷却检查 → 触发 ----
      // 为什么不用 Monaco 自己的 Automatic 触发：那个没有 debounce 与断点概念，
      // 每敲一键都算一次「该续写」，会把成本闸整个绕过（provider 侧仍会挡掉它）。
      let autoTimer: ReturnType<typeof setTimeout> | null = null
      const scheduleAuto = (): void => {
        if (autoTimer) clearTimeout(autoTimer)
        autoTimer = setTimeout(() => {
          autoTimer = null
          if (!inlineOnRef.current || !inlineAutoMode) return
          settleAutoOutcome()                          // 先结算上一次自动建议的采纳情况
          if (!canAutoRequest(inlineAutoState)) return  // 冷却中：连续没人采纳，别再打扰
          const model = editor.getModel()
          if (!model || model.getLanguageId() !== 'markdown') return
          const text = model.getValue()
          if (!text.trim()) return
          const pos = editor.getPosition()
          if (!pos) return
          const verdict = isTriggerPoint(text, model.getOffsetAt(pos))
          if (!verdict.hit) return
          inlineAutoPending = true                     // 标记「这次自动请求待结算」
          fireInlineTrigger()
        }, AUTO_DEBOUNCE_MS)
      }
      const contentSub = editor.onDidChangeModelContent(() => { scheduleAuto() })

      // 请求态 → 宿主回调（状态栏微标）。多宿主广播（编辑区 keep-alive + 知识库就地编辑共存），
      // 挂载时注册、卸载时按句柄注销——不再覆盖别人的注册。
      busyDisposeRef.current?.()
      busyDisposeRef.current = addInlineSuggestBusyListener((busy) => inlineBusyRef.current?.(busy))
      // 自动暂停态 → 宿主回调（状态栏「已暂停 · Alt+A 唤醒」提示）
      pausedDisposeRef.current?.()
      pausedDisposeRef.current = addInlinePausedListener((paused) => inlinePausedRef.current?.(paused))
      editor.onDidDispose(() => {
        if (autoTimer) clearTimeout(autoTimer)
        contentSub.dispose()
        triggerInlineRef.current = null
        busyDisposeRef.current?.()
        busyDisposeRef.current = null
        pausedDisposeRef.current?.()
        pausedDisposeRef.current = null
        cancelInlineSuggestInFlight()
      })

      // P3 插图 / 拖图落稿：容器捕获阶段拦截——剪贴板/拖拽含图片文件时走回调落附件区并插入
      // md 链接（Monaco 隐藏 textarea 收不到被吞的事件）；纯文本粘贴不受影响。
      const domNode = editor.getDomNode()
      const insertDropped = (files: File[]): void => {
        const cb = dropImageRef.current
        if (!cb) return
        void (async () => {
          const parts: string[] = []
          for (const f of files) {
            const snippet = await cb(f)
            if (snippet) parts.push(snippet)
          }
          if (parts.length === 0) return
          const pos = editor.getPosition()
          if (!pos) return
          const range = { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }
          editor.executeEdits('kb-drop-image', [{ range, text: parts.join('\n') + '\n', forceMoveMarkers: true }])
          editor.focus()
        })().catch(() => { /* 失败提示由调用方 toast */ })
      }
      if (domNode) {
        const onPasteCapture = (ev: Event): void => {
          const e = ev as ClipboardEvent
          const cb = pasteImageRef.current
          if (!cb) return
          const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
          if (files.length === 0) return
          e.preventDefault()
          e.stopPropagation()
          void (async () => {
            const parts: string[] = []
            for (const f of files) {
              const snippet = await cb(f)
              if (snippet) parts.push(snippet)
            }
            if (parts.length === 0) return
            const pos = editor.getPosition()
            if (!pos) return
            const range = { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }
            editor.executeEdits('kb-paste-image', [{ range, text: parts.join('\n') + '\n', forceMoveMarkers: true }])
            editor.focus()
          })().catch(() => { /* 失败提示由调用方 toast */ })
        }
        const onDragOverCapture = (ev: Event): void => {
          const e = ev as DragEvent
          if (!dropImageRef.current) return
          if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
        }
        const onDropCapture = (ev: Event): void => {
          const e = ev as DragEvent
          if (!dropImageRef.current) return
          const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
          if (files.length === 0) return
          e.preventDefault()
          e.stopPropagation()
          const target = editor.getTargetAtClientPoint(e.clientX, e.clientY)
          if (target?.position) editor.setPosition(target.position)
          editor.focus()
          insertDropped(files)
        }
        domNode.addEventListener('paste', onPasteCapture, true)
        domNode.addEventListener('dragover', onDragOverCapture, true)
        domNode.addEventListener('drop', onDropCapture, true)
        editor.onDidDispose(() => {
          domNode.removeEventListener('paste', onPasteCapture, true)
          domNode.removeEventListener('dragover', onDragOverCapture, true)
          domNode.removeEventListener('drop', onDropCapture, true)
        })
      }

      editor.onDidDispose(() => {
        alive = false
        applyFnRef.current = null
        editorRef.current = null
        triggerInlineRef.current = null
        collection.clear()
        cancelAnimationFrame(smoothRafRef.current)
      })
    }, [applyZenPadding, smoothCenterLine, doc.relPath])

    // dimEnabled/zen 开关：即时清空或重算（无需等下一次击键/光标移动）。
    // zen 退出必须重算，否则禅淡化装饰残留（markdownDim 常开时 dimEnabled 不变，不重跑）
    useEffect(() => {
      const apply = applyFnRef.current
      if (apply) apply()
    }, [dimEnabled, zen])

    // 禅模式开关：隐藏行号 + 字号微增；打字机开 → 动态大留白（首尾行可居中），关 → 固定大留白
    useEffect(() => {
      const ed = editorRef.current
      if (!ed) return
      ed.updateOptions(zen
        ? { lineNumbers: 'off', fontSize: 14 }
        : { lineNumbers: 'on', padding: { top: 8, bottom: 16 }, fontSize: 13 })
      if (zen) {
        if (typewriter) applyZenPadding(ed)
        else {
          padRef.current = 0
          ed.updateOptions({ padding: { top: 28, bottom: 180 } })
        }
      } else {
        padRef.current = 0
      }
      ed.layout()
    }, [zen, typewriter, applyZenPadding])

    // 纸感氛围：zen+zenPaper → knowbase-zen（编辑器底透明，容器 .zen-paper-bg 承载纸色，
    // CSS 300ms 过渡）；退出时延迟恢复 knowbase-auto，等容器底色过渡完再换回不透明底，避免闪跳
    useEffect(() => {
      if (zen && zenPaper) {
        setEditorThemeVariant('zen')
        return undefined
      }
      const t = window.setTimeout(() => setEditorThemeVariant('auto'), 340)
      return () => window.clearTimeout(t)
    }, [zen, zenPaper])

    // 文件切换：更新 lastFileRef（大纲/跳转按当前文档解释行号）
    useEffect(() => { lastFileRef.current = doc.relPath }, [doc.relPath])

    // 禅模式档位切换：容器尺寸变化后显式 layout 一次（automaticLayout 已有 ResizeObserver，双保险 §7-1）
    useEffect(() => {
      const t = window.setTimeout(() => editorRef.current?.layout(), 60)
      return () => window.clearTimeout(t)
    }, [layoutKey])

    return (
      <MonacoErrorBoundary>
        <Editor
          path={doc.modelPath ?? doc.relPath}
          language={doc.language}
          value={doc.content}
          theme="knowbase-auto"
          beforeMount={bindEditorTheme}
          onMount={onMount}
          onChange={(v) => onChange(doc.relPath, v ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: fontSize ?? 13,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            renderLineHighlight: 'line',
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            padding: { top: 8 },
            ...(editorOptions ?? {}),
          }}
        />
      </MonacoErrorBoundary>
    )
  },
)

let completionInstalled = false

/** 注册 [[ 补全 provider（幂等：整 app 一次；markdown 语言共享） */
function installWikiCompletion(monaco: typeof Monaco): void {
  if (completionInstalled) return
  completionInstalled = true
  monaco.languages.registerCompletionItemProvider('markdown', {
    triggerCharacters: ['['],
    provideCompletionItems: async (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
      // 取光标到行首文本，判断是否处于未闭合 [[ 内
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      })
      // 注意：必须匹配整段 '[[' 的起点，而不是单个 '['。
      // lastIndexOf('[') 对 "[[你" 返回第二个 '[' 的位置（1），
      // 导致下方 slice(lastOpen + 2) 吃掉 query 首字符 → 过滤退化（ISS-2026-09-04-01）。
      const lastOpen = linePrefix.lastIndexOf('[[')
      const lastClose = linePrefix.lastIndexOf(']]')
      if (lastOpen === -1 || lastClose > lastOpen) return { suggestions: [] }

      const query = linePrefix.slice(lastOpen + 2).trim()
      const pages = await getPagesCached()
      const lower = query.toLowerCase()
      const matches = pages
        .filter((p) => !lower || p.title.toLowerCase().includes(lower))
        // 显式按最近更新排序，保证候选顺序稳定可预期（不依赖索引内部顺序）
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, 10)

      return {
        suggestions: matches.map((p) => ({
          label: p.title,
          kind: monaco.languages.CompletionItemKind.Reference,
          insertText: `${p.title}]]`,
          detail: p.path ? `知识页 · ${p.title}` : '知识页',
          range: {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: lastOpen + 3, // 保留 [[ 前缀，替换已输入的部分
            endColumn: position.column,
          },
        })),
      }
    },
  })
}

export type { OnMount }

// ===== B4 内联建议 provider =====

let inlineCompletionInstalled = false
/** provider 注册句柄（重注册时用；见 installInlineCompletion 的破缓存说明） */
let inlineProviderHandle: Monaco.IDisposable | null = null
/** 在途请求 id（新请求顶替 / 编辑器卸载时取消前次；同一时刻只允许一条在途） */
let inlineInFlightId: string | null = null
/**
 * 「点火」时间戳：只有手动触发（Alt+A / 胶囊按钮）才置位。
 *
 * 为什么需要：Monaco 在打字 / 移光标时也会自动调 provider（InlineCompletionTriggerKind.Automatic），
 * 那不是本功能的设计（「仅手动触发，零常驻开销」）→ 未点火一律返回空，绝不给 LLM 发请求。
 * 用时间戳而非布尔：若 trigger 命令因 precondition 不满足而最终没调到 provider，
 * 残留的点火会在窗口外自然失效，不会误放行下一次自动触发。
 */
let inlineArmedAt = 0
const INLINE_ARM_WINDOW_MS = 500
/** 渲染层 UI 兜底超时：必须 ≥ 主进程 INLINE_SUGGEST_TIMEOUT_MS（契约 J7b 断言） */
const INLINE_UI_TIMEOUT_MS = 12000

/** 手动触发前调用：给 provider 一次性点火许可 */
function armInlineSuggest(): void {
  inlineArmedAt = Date.now()
}

/**
 * 自动触发状态（成本优化 ③ 冷却）与记账位。
 *
 * 语义：**每一次自动请求在被下一次自动请求「结算」时**，看它有没有被采纳；
 * 连续 AUTO_PAUSE_STREAK 次没人采纳 → 暂停自动（这个时段显然不需要它），
 * 直到用户手动 Alt+A / 点胶囊按钮（那是明确的「我现在要」）才唤醒。
 * 手动请求不进这套账（用户主动要的，不该被冷却影响）。
 */
let inlineAutoState: AutoState = { ...INITIAL_AUTO_STATE }
/** 上一次自动请求是否待结算 */
let inlineAutoPending = false
/** 上一次建议是否被采纳（由 provider 的 handleEndOfLifetime 写入） */
let inlineLastAccepted = false
/** 自动模式开关（宿主每次渲染同步进来） */
let inlineAutoMode = true

/** 宿主同步自动模式开关（关 = 仅手动） */
export function setInlineAutoMode(on: boolean): void {
  inlineAutoMode = on
}

/**
 * 多宿主广播表：编辑区 MonacoPane（keep-alive 常驻）与知识库就地编辑 MonacoPane 可能同时挂载，
 * 单槽覆盖会让先挂载者的微标失灵 → 改为注册表广播，挂载注册 / 卸载按句柄注销。
 */
const inlineBusyListeners = new Set<(busy: boolean) => void>()
const inlinePausedListeners = new Set<(paused: boolean) => void>()

/** 多宿主注册 busy 监听，返回注销句柄 */
export function addInlineSuggestBusyListener(fn: (busy: boolean) => void): () => void {
  inlineBusyListeners.add(fn)
  return () => { inlineBusyListeners.delete(fn) }
}
/** 多宿主注册暂停态监听，返回注销句柄 */
export function addInlinePausedListener(fn: (paused: boolean) => void): () => void {
  inlinePausedListeners.add(fn)
  return () => { inlinePausedListeners.delete(fn) }
}
/** 单槽兼容入口（清空后只注册自己）：旧调用方语义不变 */
export function setInlineSuggestBusyListener(fn: ((busy: boolean) => void) | null): void {
  inlineBusyListeners.clear()
  if (fn) inlineBusyListeners.add(fn)
}
export function setInlinePausedListener(fn: ((paused: boolean) => void) | null): void {
  inlinePausedListeners.clear()
  if (fn) inlinePausedListeners.add(fn)
}

/** 结算上一次自动请求的采纳结果（自动触发前 / 手动触发前调用） */
function settleAutoOutcome(): void {
  if (!inlineAutoPending) return
  inlineAutoPending = false
  inlineAutoState = afterAutoResult(inlineAutoState, inlineLastAccepted)
  inlineLastAccepted = false
  inlinePausedListeners.forEach((fn) => fn(inlineAutoState.paused))
}
/**
 * 请求态广播（模块级）：provider 是模块级函数、拿不到 React 闭包，
 * 故用回调注册表把「开始 / 结束」播给当前挂载的宿主（编辑器状态栏微标消费）。
 */

/**
 * 注册内联建议 provider（幂等：整 app 一次；markdown 语言共享）。
 *
 * 设计要点：
 * - provider **不主动**发起请求，只在 Monaco 收到 trigger 命令时被调用（手动触发模式，
 *   无常驻 token 成本）。因此这里无需 debounce / 缓存。
 * - 只对 markdown 生效（与 [[ 补全同语言）；非 md 不注册 provider 就不会被调。
 * - 返回单条 ghost text：Moanco 的 items 数组只放一项，`insertText` 即建议正文。
 */
/**
 * 注册 provider（reinstall=true 时先注销再注册）。
 *
 * ★ 为什么要「每次手动触发前重注册」——破 Monaco 的请求级缓存：
 *   InlineCompletionsSource.fetch() 命中缓存就不再调 provider，
 *   判据 `UpdateRequest.satisfies()` 只比 position / versionId / triggerKind / **providers 集合**
 *   （源码：node_modules/monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/model/
 *          inlineCompletionsSource.js 的 fetch + satisfies）。
 *   于是「同光标 + 内容未变 + 上次是 Explicit」时第二次 trigger 直接返回缓存，
 *   provider 不被调用 —— 实测后果：点一次没出结果（超时 / 建议为空），
 *   不动光标再点一次 **永远没反应**。这是真实用户高频动作（「再来一次」），必须支持。
 *   重注册会让 providers 集合里换成新注册项（对象引用不同）→ satisfies 为假 → 强制重拉。
 *   Monaco 没给公开的「清缓存」命令能替代：hide 命令的 precondition 要求建议可见，
 *   而空结果时它不成立；provider 的 onDidChangeInlineCompletions 也只重放 trigger，不清缓存。
 */
function installInlineCompletion(monaco: typeof Monaco, reinstall = false): void {
  if (inlineCompletionInstalled && !reinstall) return
  inlineCompletionInstalled = true
  inlineProviderHandle?.dispose()
  inlineProviderHandle = monaco.languages.registerInlineCompletionsProvider('markdown', {
    provideInlineCompletions: async (
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
    ): Promise<Monaco.languages.InlineCompletions> => {
      // 非手动点火（Monaco 自动触发）→ 一律不发请求，零开销返回
      const armed = inlineArmedAt > 0 && Date.now() - inlineArmedAt < INLINE_ARM_WINDOW_MS
      inlineArmedAt = 0
      if (!armed) return { items: [] }

      const text = model.getValue()
      // Monaco 的 offset：Position → offset 用 getOffsetAt（0-based 字符偏移）
      const offset = model.getOffsetAt(position)
      // relPath 取记账的真实值（命名空间 modelPath 不影响主进程日志）
      const relPath = relPathByModel.get(model) ?? model.uri.path.replace(/^\//, '')

      // 新请求顶替前次：先取消在途（渲染层同一时刻只允许一条）
      if (inlineInFlightId) {
        void aiInlineSuggestCancel(inlineInFlightId).catch(() => { /* 主进程无此 id 时静默 */ })
        inlineInFlightId = null
      }
      const requestId = `is_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      inlineInFlightId = requestId
      inlineBusyListeners.forEach((fn) => fn(true))

      try {
        const r = await Promise.race([
          aiInlineSuggestRun({ requestId, text, offset, relPath }),
          // UI 兜底：主进程已有硬超时，这里是双保险 —— IPC 异常 / 主进程卡死时
          // 也不让状态栏微标永久转圈（探针实测无 provider 时请求永不 resolve）
          new Promise<null>((res) => { setTimeout(() => res(null), INLINE_UI_TIMEOUT_MS) }),
        ])
        // 已被新请求顶替 / 用户取消 → 不呈现
        if (inlineInFlightId !== requestId) return { items: [] }
        // 兜底超时命中 → 顺手取消主进程那一条，别让它白跑
        if (!r) {
          void aiInlineSuggestCancel(requestId).catch(() => { /* 静默 */ })
          return { items: [] }
        }
        if (!r?.ok || !r.text) return { items: [] }
        return {
          items: [{
            insertText: r.text,
            range: new monaco.Range(
              position.lineNumber, position.column,
              position.lineNumber, position.column,
            ),
          }],
        }
      } catch {
        return { items: [] }
      } finally {
        if (inlineInFlightId === requestId) {
          inlineInFlightId = null
          inlineBusyListeners.forEach((fn) => fn(false))
        }
      }
    },
    // 接口要求（0.56）：disposeInlineCompletions 为**必填**方法（不是可选的 free*）
    disposeInlineCompletions: () => { /* 无额外资源需释放 */ },
    /**
     * 建议「生命终结」时被调用 —— 唯一可靠的采纳信号（0.56 接口）。
     * Accepted=0 / Rejected=1 / Ignored=2；只认 Accepted，供冷却记账（见 inlineAutoState）。
     */
    handleEndOfLifetime: (_c, _i, reason) => {
      if (reason?.kind === monaco.languages.InlineCompletionEndOfLifeReasonKind.Accepted) inlineLastAccepted = true
    },
  })
}

/** 取消在途内联建议请求（编辑器卸载 / 切文档时由宿主调用） */
export function cancelInlineSuggestInFlight(): void {
  if (!inlineInFlightId) return
  const id = inlineInFlightId
  inlineInFlightId = null
  void aiInlineSuggestCancel(id).catch(() => { /* 静默 */ })
}

/** 供外部（大纲/提示）判断当前文档是否处于 [[ 补全上下文 */
export function wikiContextTarget(text: string): string | null {
  const lastOpen = text.lastIndexOf('[[')
  const lastClose = text.lastIndexOf(']]')
  if (lastOpen === -1 || lastClose > lastOpen) return null
  return text.slice(lastOpen + 2).trim()
}

export { wikiTargetTitle }
