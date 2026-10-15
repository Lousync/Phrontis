/**
 * 图片控件簇（批 3，2026-10-13，v3.5.0 线）。
 *
 * 纯展示 + 受控：一个视图 state 都不持有，全部动作回传调用方。
 *
 * 两个 `variant`（拍板 D7 = 顶栏内联）：
 *   · `inline` —— 塞进 `NoteTopBar` 的 `rightSlot`，即笔记区主路径。
 *     图片态下顶栏的 `showViewToggle` / `showInline` / `showSaveDot` 三者全为假，
 *     右侧本来只剩 `⋮` ⇒ 这一簇是**零新增行高**，这是选 A 方案的全部理由。
 *   · `float` —— 沉浸阅读态。那里按定义**没有顶栏**（批 2 的 `pdfImmersive` 就是把它藏掉），
 *     没有槽可放，故退成右下角浮条。这是 A 方案的必然例外，不是口径分裂 ——
 *     与 PDF 沉浸态「藏掉顶栏、阅读器自己的栏留下」同一个处理。
 */

import { Maximize, MoveHorizontal, RotateCcw, RotateCw, Square, ZoomIn, ZoomOut } from 'lucide-react'
import type { ImageFitMode } from '../../../lib/imageView'

interface Props {
  variant: 'inline' | 'float'
  scale: number
  fit: ImageFitMode
  rot: number
  onZoom: (k: number) => void
  onFit: (mode: 'fit' | 'width' | 'actual') => void
  onRotate: (delta: number) => void
}

export function ImageToolbar({ variant, scale, fit, rot, onZoom, onFit, onRotate }: Props) {
  const inline = variant === 'inline'
  const btn = inline
    ? 'flex h-[26px] items-center justify-center rounded px-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
    : 'flex h-[26px] items-center justify-center rounded px-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
  /** 当前所处模式的按钮高亮 —— 用户要知道「现在是适应窗口还是 1:1」 */
  const on = 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
  const sep = <span className="mx-0.5 h-4 w-px shrink-0 bg-[var(--border-color)]" aria-hidden />

  return (
    <div
      data-wb="imageToolbar"
      data-variant={variant}
      className={inline ? 'flex items-center gap-0.5' : 'kb-img-toolbar-float flex items-center gap-0.5'}
    >
      <button data-wb="imgZoomOut" className={`${btn} w-[26px]`} title="缩小 (Ctrl+滚轮)" onClick={() => onZoom(1 / 1.25)}>
        <ZoomOut size={15} />
      </button>
      <button
        data-wb="imgZoomLevel"
        className={`${btn} min-w-[46px] tabular-nums`}
        title="点击回到 100%"
        onClick={() => onFit('actual')}
      >
        {Math.round(scale * 100)}%
      </button>
      <button data-wb="imgZoomIn" className={`${btn} w-[26px]`} title="放大 (Ctrl+滚轮)" onClick={() => onZoom(1.25)}>
        <ZoomIn size={15} />
      </button>

      {sep}

      <button data-wb="imgFit" className={`${btn} w-[26px] ${fit === 'fit' ? on : ''}`} title="适应窗口 (0)" onClick={() => onFit('fit')}>
        <Maximize size={15} />
      </button>
      <button data-wb="imgFitWidth" className={`${btn} w-[26px] ${fit === 'width' ? on : ''}`} title="适应宽度" onClick={() => onFit('width')}>
        <MoveHorizontal size={15} />
      </button>
      <button data-wb="imgActual" className={`${btn} w-[26px] ${fit === 'actual' ? on : ''}`} title="实际大小 1:1 (1)" onClick={() => onFit('actual')}>
        <Square size={14} />
      </button>

      {sep}

      <button data-wb="imgRotateL" className={`${btn} w-[26px]`} title="向左旋转 ([)" onClick={() => onRotate(-90)}>
        <RotateCcw size={15} />
      </button>
      <button data-wb="imgRotateR" className={`${btn} w-[26px]`} title="向右旋转 (])" onClick={() => onRotate(90)}>
        <RotateCw size={15} />
      </button>
      {/* rot 只用于断言可读性：旋转态在画布上已可见，这里不再画角标 */}
      <span className="sr-only" data-wb="imgRotState">{rot}</span>
    </div>
  )
}
