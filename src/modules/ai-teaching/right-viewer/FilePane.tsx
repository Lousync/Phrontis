/**
 * 右侧查看器 · 文件页签（一个页签 = 一个非文本文件）。
 *
 * 方案：`docs/ai-teaching-right-viewer-unify-plan.md` §5 / §12.5 D。
 * 内部按 `fileKind` 分派到既有查看器，本组件只做「文件级」的事：
 *   · 动作行（文件名 / 重读 / 复制路径；html 额外「在编辑器中打开」）
 *     —— **导图例外**：MindMapView 自带单行工具条（标题 / 节点数 / 撤销 / 折叠 / 导出 / 重读 / 复制），
 *        这里再渲染一行就是两条标题 + 两套重读复制，380 宽下白占 32px。
 *   · AI 生成中的安静骨架（不读盘，禁关由壳负责）
 *   · pptx 逐页阅读 + 「讲解此页」（只上报页信息，发送逻辑留在宿主）
 *   · 外部写入后自己 bump 重读序号，不依赖壳
 *
 * 渲染器不在这里重写：html / 导图 / 图片各自复用工作台同一份组件
 * （`ArtHtmlView` / `MindMapView` / `ImmersiveImageView`），两处各写一遍必然漂移。
 * 异常态走行内卡（铁律 25），不弹全局 Toast；文案靠 `data-tip` 解释（铁律 26）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Copy,
  ExternalLink,
  FileCode2,
  Image as ImageIcon,
  Network,
  Presentation,
  RefreshCw,
} from 'lucide-react'
import type { FilePaneKind, FilePaneProps } from './paneContracts'
import { docsPptxPages, onWsExternalChange, workspaceStat } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { ArtHtmlView } from '../ArtHtmlView'
import { MindMapView } from '../../../components/shared/MindMapView'
import { ImmersiveImageView } from '../../../components/shared/image/ImmersiveImageView'
import { baseName, pathKey } from './viewerTabs'

/* ============================== 小件 ============================== */

/** 生成中占位的文案（html=示意图、mindmap=思维导图、image=图片、pptx=课件） */
const GEN_LABEL: Record<FilePaneKind, string> = {
  html: '示意图',
  mindmap: '思维导图',
  image: '图片',
  pptx: '课件',
}

function KindIcon({ kind, size = 12 }: { kind: FilePaneKind; size?: number }) {
  const Icon =
    kind === 'html'
      ? FileCode2
      : kind === 'mindmap'
        ? Network
        : kind === 'pptx'
          ? Presentation
          : ImageIcon
  return <Icon size={size} className="shrink-0 opacity-65" />
}

/** 行内错误卡：文件被删 / 读取失败时只影响本页签（「重试」= 本地 bump 重读） */
function FileErrorCard({ relPath, onRetry }: { relPath: string; onRetry: () => void }) {
  return (
    <div className="kb-view-fade flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-[12.5px] text-[var(--text-primary)]">文件不存在或已被移动</div>
      <div
        className="max-w-[80%] truncate text-[11px] text-[var(--text-muted)]"
        data-tip={relPath}
        aria-label={relPath}
      >
        {relPath}
      </div>
      <button
        type="button"
        onClick={onRetry}
        data-tip="重新读取磁盘文件"
        aria-label="重新读取磁盘文件"
        className="kb-press mt-1 flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        <RefreshCw size={11} />
        重试
      </button>
    </div>
  )
}

/* ============================== 组件 ============================== */

export function FilePane(props: FilePaneProps) {
  const {
    rootId,
    initialRelPath,
    fileKind,
    generating,
    rev,
    page,
    displayName,
    onTitleChange,
    onPageChange,
    onOpenInEditor,
    onOpenFileRef,
    onTalkPage,
  } = props

  const relPath = String(initialRelPath ?? '').replace(/\\/g, '/')
  const isGen = generating === true
  const name = (displayName ?? '').trim() || baseName(relPath) || '文件'

  /** 本地重读序号：动作行「重读」与外部变更都 bump 它；与壳给的 `rev` 相加成为统一令牌 */
  const [localSeq, setLocalSeq] = useState(0)
  const reloadSeq = (rev ?? 0) + localSeq
  const retry = useCallback(() => setLocalSeq((n) => n + 1), [])

  // pptx：逐页文本
  const [pages, setPages] = useState<Array<{ n: number; text: string }>>([])
  const [pptxErr, setPptxErr] = useState('')
  const [pptxLoading, setPptxLoading] = useState(false)
  const [curLocal, setCurLocal] = useState(() => (typeof page === 'number' ? page : 0))
  /** 文件被删 / 读取失败（非 pptx 走这条探测；pptx 由 docsPptxPages 报错） */
  const [missing, setMissing] = useState(false)

  /** 回调身份不稳定时不进依赖，避免把壳推进重渲染环 */
  const pageCbRef = useRef(onPageChange)
  pageCbRef.current = onPageChange
  const talkCbRef = useRef(onTalkPage)
  talkCbRef.current = onTalkPage

  /* 换文件（生成中占位原地 commit / 壳改 relPath）：本地状态归零 */
  const pathRef = useRef(relPath)
  useEffect(() => {
    if (pathRef.current === relPath) return
    pathRef.current = relPath
    setLocalSeq(0)
    setPages([])
    setPptxErr('')
    setPptxLoading(false)
    setCurLocal(typeof page === 'number' ? page : 0)
    setMissing(false)
    // page 只在换文件这一刻取初值；后续跟随由下面的同步 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relPath])

  /* 标题上报：文件名 → 页签条（生成中由壳自己写「生成中…」，不抢） */
  const reportedRef = useRef('')
  useEffect(() => {
    if (isGen || !relPath) return
    const key = `${relPath}\u0000${name}`
    if (reportedRef.current === key) return
    reportedRef.current = key
    onTitleChange?.(name)
  }, [isGen, relPath, name, onTitleChange])

  /* 存在性探测：给 html / 导图 / 图片补一张统一口径的行内错误卡 */
  useEffect(() => {
    if (isGen || !relPath || fileKind === 'pptx' || !rootId) {
      setMissing(false)
      return
    }
    let alive = true
    void workspaceStat(rootId, relPath)
      .then((r) => {
        if (alive) setMissing(!!r?.error)
      })
      .catch(() => {
        /* 探测失败不等于文件没了：交给子组件自己的异常态 */
        if (alive) setMissing(false)
      })
    return () => {
      alive = false
    }
  }, [isGen, relPath, fileKind, rootId, reloadSeq])

  /* pptx：挂载 / 换页 / rev 变化 / 外部改动后重新取页 */
  useEffect(() => {
    if (isGen || fileKind !== 'pptx' || !relPath) {
      setPages([])
      setPptxErr('')
      setPptxLoading(false)
      return
    }
    let alive = true
    setPptxLoading(true)
    setPptxErr('')
    void docsPptxPages(relPath)
      .then((r) => {
        if (!alive) return
        setPptxLoading(false)
        if (!r || !r.ok) {
          setPages([])
          setPptxErr(r?.error || '读取失败')
          return
        }
        setPages(Array.isArray(r.pages) ? r.pages : [])
      })
      .catch((e: unknown) => {
        if (!alive) return
        setPptxLoading(false)
        setPages([])
        setPptxErr(String((e as Error)?.message ?? e))
      })
    return () => {
      alive = false
    }
  }, [isGen, fileKind, relPath, reloadSeq])

  /* 壳写回 page → 本地页码跟随 */
  useEffect(() => {
    if (typeof page === 'number' && Number.isFinite(page)) setCurLocal(page)
  }, [page])

  const pageCount = pages.length
  const cur = pageCount ? Math.min(Math.max(0, curLocal), pageCount - 1) : 0

  /* 页数变少（换文件 / 重读后页数缩短）时把越界页码收回来 */
  useEffect(() => {
    if (!pageCount) return
    if (curLocal > pageCount - 1) {
      const next = pageCount - 1
      setCurLocal(next)
      pageCbRef.current?.(next)
    }
  }, [pageCount, curLocal])

  const goPage = useCallback(
    (target: number) => {
      const max = Math.max(0, pages.length - 1)
      const next = Math.min(Math.max(0, target), max)
      setCurLocal(next)
      pageCbRef.current?.(next)
    },
    [pages.length],
  )

  const talkCur = useCallback(() => {
    const p = pages[cur]
    if (!p) return
    talkCbRef.current?.({ name, page: cur, n: p.n, text: p.text ?? '' })
  }, [pages, cur, name])

  /* 外部写入 → 本地重读（pptx 重新取页）；卸载时清监听 */
  useEffect(() => {
    if (isGen || !relPath) return
    const key = pathKey(relPath)
    const hit = (p: unknown): boolean => typeof p === 'string' && p !== '' && pathKey(p) === key
    const bump = (): void => setLocalSeq((n) => n + 1)
    const offExternal = onWsExternalChange((p) => {
      if (hit(p?.relPath)) bump()
    })
    const onSaved = (e: Event): void => {
      const detail = (e as CustomEvent<{ relPath?: string }>).detail
      if (hit(detail?.relPath)) bump()
    }
    window.addEventListener('kb:file-saved', onSaved)
    return () => {
      offExternal?.()
      window.removeEventListener('kb:file-saved', onSaved)
    }
  }, [isGen, relPath])

  const copyPath = useCallback(() => {
    if (!relPath) return
    void navigator.clipboard
      .writeText(relPath)
      .then(() => showToast({ type: 'info', message: '已复制路径' }))
      .catch(() => {
        /* 剪贴板不可用时静默：辅助动作，不该打断阅读 */
      })
  }, [relPath])

  /* ------------------------------------------------------------ 生成中：安静骨架，不读盘 */
  if (isGen) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-file-pane="generating">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6">
          <div
            className="w-full max-w-[300px] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4"
            aria-hidden="true"
          >
            <div className="space-y-2.5">
              <div className="h-2.5 w-3/5 animate-pulse rounded-full bg-[var(--bg-hover)] motion-reduce:animate-none" />
              <div className="h-2.5 w-4/5 animate-pulse rounded-full bg-[var(--bg-hover)] motion-reduce:animate-none" />
              <div className="h-2.5 w-1/2 animate-pulse rounded-full bg-[var(--bg-hover)] motion-reduce:animate-none" />
            </div>
          </div>
          <div className="text-[12px] text-[var(--text-muted)]">正在生成{GEN_LABEL[fileKind]}…</div>
        </div>
      </div>
    )
  }

  /* ------------------------------------------------------------ 正常态 */
  const showError = missing || (fileKind === 'pptx' && !!pptxErr)
  const curText = pageCount ? (pages[cur]?.text ?? '') : ''

  return (
    <div className="flex h-full min-h-0 flex-col" data-file-pane={fileKind}>
      {/* 动作行：32px，与 NotesPane 同密度；文件名常显，其余动作靠 data-tip 解释。
          导图页签不渲染这一行 —— 让 MindMapView 的工具条成为唯一一条（见文件头注）。 */}
      {fileKind !== 'mindmap' && (
        <div data-pane-action-row className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-1.5">
          <span className="shrink-0 text-[var(--text-muted)]">
            <KindIcon kind={fileKind} />
          </span>
          <span
            className="min-w-0 truncate text-[11.5px] text-[var(--text-primary)]"
            data-tip={relPath}
            aria-label={relPath}
          >
            {name}
          </span>
          <span className="min-w-0 flex-1" />

          {fileKind === 'html' && onOpenInEditor && (
            <button
              type="button"
              onClick={() => onOpenInEditor(relPath)}
              data-tip="在编辑器中打开"
              aria-label="在编辑器中打开"
              className="kb-press shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <ExternalLink size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={retry}
            data-tip="重读磁盘文件"
            aria-label="重读磁盘文件"
            className="kb-press shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            onClick={copyPath}
            data-tip="复制仓库相对路径"
            aria-label="复制路径"
            className="kb-press shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Copy size={12} />
          </button>
        </div>
      )}

      {/* 内容区：每类渲染器自己铺满；换文件时按 key 重建，避免残留上一份状态 */}
      <div key={`${fileKind}:${relPath}`} className="flex min-h-0 flex-1 flex-col">
        {showError ? (
          <FileErrorCard relPath={relPath} onRetry={retry} />
        ) : fileKind === 'html' ? (
          <div className="kb-view-in relative min-h-0 flex-1">
            <ArtHtmlView relPath={relPath} reloadSeq={reloadSeq} fit />
          </div>
        ) : fileKind === 'mindmap' ? (
          <div className="kb-view-in min-h-0 flex-1">
            <MindMapView
              relPath={relPath}
              reloadSeq={reloadSeq}
              showExport
              showSource
              onRef={onOpenFileRef}
            />
          </div>
        ) : fileKind === 'image' ? (
          <div className="kb-view-in flex min-h-0 min-w-0 flex-1 flex-col">
            <ImmersiveImageView relPath={relPath} name={name} reloadSeq={reloadSeq} />
          </div>
        ) : (
          /* pptx：逐页文本（页码即内容） */
          <div className="kb-view-in flex min-h-0 flex-1 flex-col">
            {pptxLoading && pageCount === 0 ? (
              <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">
                打开中…
              </div>
            ) : pageCount === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-[var(--text-muted)]">
                课件没有可读的文字内容
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto max-w-[720px] px-4 py-3">
                    <div className="min-h-[200px] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3">
                      <div className="mb-2.5 inline-flex items-center gap-1 rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)]">
                        第 {cur + 1} / {pageCount} 页 · 原文编号 {pages[cur]?.n}
                      </div>
                      {curText.trim() ? (
                        <pre className="whitespace-pre-wrap break-words font-[var(--font-sans)] text-[12.5px] leading-relaxed">
                          {curText}
                        </pre>
                      ) : (
                        <div className="text-[12px] text-[var(--text-muted)]">（本页无文字内容——多为图表演示页）</div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border-color)] px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => goPage(cur - 1)}
                    disabled={cur <= 0}
                    className="kb-press rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
                  >
                    ← 上一页
                  </button>
                  {onTalkPage && (
                    <button
                      type="button"
                      onClick={talkCur}
                      data-tip="把当前页发给对话讲解"
                      aria-label="把当前页发给对话讲解"
                      className="kb-press rounded-md bg-[var(--accent)] px-2 py-0.5 text-[11.5px] text-white transition-colors hover:bg-[var(--accent-hover)]"
                    >
                      讲解此页
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => goPage(cur + 1)}
                    disabled={cur >= pageCount - 1}
                    className="kb-press rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
                  >
                    下一页 →
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
