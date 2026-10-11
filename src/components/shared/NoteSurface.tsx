/**
 * 写作面宿主 —— 双写作面方案 `docs/note-surface-dual-engine-design.md`。
 *
 * 按设置 `editorWritingMode` 在**源码档**（Monaco，既有实现）与**即时渲染档**（CodeMirror 6）
 * 之间二选一挂载，并统一承担三件事：
 *
 * 1. **契约转发**：向上暴露 `NoteSurfaceHandle`（= `NoteEngineHandle` + 源码档专属的 AI 续写入口），
 *    调用方（PageEditor）不再直接依赖某个引擎；
 * 2. **右键菜单**：两档共用 `NoteContextMenu`（菜单树与动作在 `src/lib/noteActions.ts`），
 *    引擎只把 `contextmenu` 事件转成坐标交上来；
 * 3. **切档光标记忆**：按「文件 × 档位」记字符偏移，切回来落到上次位置（撤销栈跨引擎无法合并，只能做到位置）。
 *
 * ★ 单写者纪律：同一 `relPath` 同一时刻只挂一个引擎 —— 挂载由 `mode` 单值决定，
 *   不存在「两个引擎同时持有同一文件」的窗口（那会互相覆盖保存）。
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef, lazy, Suspense } from 'react'
import { MonacoPane, cancelInlineSuggestInFlight, type MonacoPaneHandle, type PaneDoc } from './MonacoPane'
import { NoteContextMenu } from './NoteContextMenu'
import { recallCursor, rememberCursor, type NoteEngineHandle, type NoteEngineId } from '../../lib/noteEngine'
import type * as Monaco from 'monaco-editor'

/**
 * 即时渲染档**惰性加载**：CodeMirror 6 只在用户真正切到该档时才下载（铁律 20 —— 大依赖不进首屏静态闭包）。
 * 源码档用户（默认）全程不付这份体积；Monaco 那侧同理早就是独立 chunk。
 */
const LiveMarkdownPane = lazy(() => import('./LiveMarkdownPane').then((m) => ({ default: m.LiveMarkdownPane })))

export type { PaneDoc }

export interface NoteSurfaceHandle extends NoteEngineHandle {
  /** 源码档专属：原始 Monaco 编辑器（AI 续写状态 / 旧调用点兜底）。即时渲染档返回 null */
  getEditor(): Monaco.editor.IStandaloneCodeEditor | null
  /** 源码档专属：手动要一条 AI 续写建议。即时渲染档返回 false */
  triggerInlineSuggest(): boolean
  /** 源码档专属：收起 ghost text（总开关关闭时调用） */
  hideInlineSuggest(): void
  /** 当前实际生效的档位（markdown 之外的文档强制源码档） */
  getMode(): NoteEngineId
}

interface Props {
  doc: PaneDoc | null
  onChange: (relPath: string, value: string) => void
  /** 写作模式设置值。非 markdown 文档一律按 'source' 处理（即时渲染只对 Markdown 有意义） */
  mode: NoteEngineId
  fontSize?: number
  editorOptions?: Monaco.editor.IStandaloneEditorConstructionOptions
  onPasteImage?: (file: File) => Promise<string | null>
  onDropImage?: (file: File) => Promise<string | null>
  inlineSuggestEnabled?: boolean
  inlineSuggestAuto?: boolean
  onInlineSuggestBusy?: (busy: boolean) => void
  onInlineSuggestPaused?: (paused: boolean) => void
  layoutKey?: number
}

export const NoteSurface = forwardRef<NoteSurfaceHandle, Props>(function NoteSurface(
  { doc, onChange, mode, fontSize, editorOptions, onPasteImage, onDropImage, inlineSuggestEnabled, inlineSuggestAuto, onInlineSuggestBusy, onInlineSuggestPaused, layoutKey },
  ref,
) {
  const monacoRef = useRef<MonacoPaneHandle | null>(null)
  const liveRef = useRef<NoteEngineHandle | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; engine: NoteEngineHandle } | null>(null)

  const relPath = doc?.relPath ?? ''
  // 即时渲染只对 Markdown 生效：代码 / txt / 其他可编辑文本一律回落源码档
  const active: NoteEngineId = mode === 'live' && doc?.language === 'markdown' ? 'live' : 'source'

  const engine = useCallback((): NoteEngineHandle | null =>
    active === 'live' ? liveRef.current : monacoRef.current, [active])

  /** 光标偏移记账（两个引擎都在选区变化时回调，落进按「文件 × 档位」的备忘表） */
  const noteCursor = useCallback((which: NoteEngineId, offset: number) => {
    if (relPath) rememberCursor(relPath, which, offset)
  }, [relPath])

  // 切档 / 换文件：光标位置由引擎**首挂时**自己落（`initialCursorOffset`）——
  // 不在宿主 effect 里 setTimeout 补，那条路有「引擎还没挂好」的竞态。
  const initialOffset = relPath ? recallCursor(relPath, active) : undefined

  // 离开源码档时掐掉在途的 AI 续写请求（切档后没人接它的结果）
  useEffect(() => {
    if (active !== 'source') cancelInlineSuggestInFlight()
  }, [active])

  useImperativeHandle(ref, (): NoteSurfaceHandle => ({
    insertAtCursor: (text) => engine()?.insertAtCursor(text),
    revealLine: (line) => engine()?.revealLine(line),
    focus: () => engine()?.focus(),
    getSelection: () => engine()?.getSelection() ?? null,
    replaceRange: (from, to, text, selectFrom, selectTo) => engine()?.replaceRange(from, to, text, selectFrom, selectTo),
    getBlockContext: () => engine()?.getBlockContext() ?? null,
    getCursorOffset: () => engine()?.getCursorOffset() ?? 0,
    setCursorOffset: (offset) => engine()?.setCursorOffset(offset),
    selectAll: () => engine()?.selectAll(),
    getRaw: () => engine()?.getRaw() ?? null,
    triggerWikiSuggest: () => engine()?.triggerWikiSuggest?.(),
    getEditor: () => monacoRef.current?.getEditor() ?? null,
    triggerInlineSuggest: () => (active === 'source' ? monacoRef.current?.triggerInlineSuggest() ?? false : false),
    hideInlineSuggest: () => { if (active === 'source') monacoRef.current?.hideInlineSuggest() },
    getMode: () => active,
  }), [active, engine])

  const openMenu = useCallback((x: number, y: number) => {
    const eng = engine()
    if (!eng) return
    setMenu({ x, y, engine: eng })
  }, [engine])

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-muted)]">
        从左侧选择文件打开
      </div>
    )
  }

  return (
    <>
      {active === 'live' ? (
        <Suspense fallback={<div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">即时渲染档加载中…</div>}>
          <LiveMarkdownPane
            key={`live:${relPath}`}
            ref={liveRef}
            content={doc.content}
            onChange={(v) => onChange(relPath, v)}
            onPasteImage={onPasteImage}
            onDropImage={onDropImage}
            onCursorOffset={(off) => noteCursor('live', off)}
            initialCursorOffset={initialOffset}
            onContextMenu={(e) => openMenu(e.clientX, e.clientY)}
          />
        </Suspense>
      ) : (
        <MonacoPane
          ref={monacoRef}
          doc={doc}
          onChange={onChange}
          fontSize={fontSize}
          editorOptions={editorOptions}
          onPasteImage={onPasteImage}
          onDropImage={onDropImage}
          inlineSuggestEnabled={inlineSuggestEnabled}
          inlineSuggestAuto={inlineSuggestAuto}
          onInlineSuggestBusy={onInlineSuggestBusy}
          onInlineSuggestPaused={onInlineSuggestPaused}
          onCursorOffset={(off) => noteCursor('source', off)}
          initialCursorOffset={initialOffset}
          onContextMenu={(e) => openMenu(e.clientX, e.clientY)}
          layoutKey={layoutKey}
        />
      )}
      {menu && (
        <NoteContextMenu x={menu.x} y={menu.y} engine={menu.engine} onClose={() => setMenu(null)} />
      )}
    </>
  )
})
