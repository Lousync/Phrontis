/**
 * 笔记区顶栏（2026-10-11 对齐 Obsidian，拍板记录见 tmp/note-topbar-proto 与方案）。
 *
 * 三段式：左 `← →` 页面历史 / 中 文件名 + 保存点 / 右 ✨AI 续写 + 阅读切换 + `⋮`。
 *
 * 为什么本组件是「纯展示 + 槽」而不自己取数据：
 *   fileType / saving / preview / AI 四态的真源在 `PageEditor`，历史栈的真源在 `KnowledgeModule`。
 *   这里只负责几何与三段布局，业务状态一律由调用方传入 —— 避免出现第二个真源，
 *   也让它能被契约脚本按锚点做静态断言。
 *
 * 锚点纪律（`.AGENT/scripts` 下的探针依赖，改名会让断言失配）：
 *   · 新增：noteTopBar / noteTopBack / noteTopForward / noteTopTitle / noteTopSubtitle / noteSaveDot /
 *     noteTopMore / noteTopMoreMenu
 *   · **从旧悬浮胶囊原样搬来**：inlineSuggestBtn / inlineBusy / inlinePaused / inlineOffSlash
 *     （那颗胶囊已于批 2 整条退役，见 docs/nonmd-topbar-design.md；锚点名字保持不变）
 *   · `noteSaveDot` / `noteTopMore` 是**条件锚点**（批 2）：前者只对有保存动作的类型出现，
 *     后者在 `showMore={false}` 时整个不渲染 —— 探针断言它们时必须先断言适用前提。
 *
 * 视觉口径（拍板）：40px 高、**不画分隔线**、不设底色（继承主题底，与正文连成一整片）。
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, MoreHorizontal, PenLine, Sparkles } from 'lucide-react'

export interface NoteTopBarProps {
  /** 文档名（拍板 B2：只显示文件名，不带扩展名） */
  title: string
  /** 悬停提示（给完整路径） */
  titleHint?: string
  /** 中段次要文本（批 2：PDF 的「N 页」）。锚点 noteTopSubtitle */
  subtitle?: string
  /** 保存中（绿点 → 橙闪） */
  saving: boolean
  /** 是否显示中段保存点（默认 true）。批 2 口径：只有「有真实保存动作」的类型才显示 ——
   *  可编辑文本类有防抖自动保存 ⇒ 保留；PDF / 图片 / 二进制 / 导图 / 超限只读文本 ⇒ 隐藏。
   *  理由：绿点在无保存动作的类型上是**假信号**（见 docs/nonmd-topbar-design.md §三·①）。 */
  showSaveDot?: boolean
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  /** 当前是阅读视图；图标语义对齐 Obsidian：编辑态给「书」、阅读态给「笔」 */
  preview: boolean
  onToggleView: () => void
  /** 是否显示阅读/编辑切换钮（默认 true）。批 2：非 md 现状没有预览态（`isArchiveFile` 恒 true
   *  把胶囊那颗钮挡掉了）⇒ 传 false，免得点了没反应。 */
  showViewToggle?: boolean
  /** 是否显示 ✨ 常驻钮：阅读态与即时渲染档不显示（那里没有 ghost text，显示等于点不动） */
  showInline?: boolean
  /**
   * 右簇中、`⋮` 之前的内联槽（批 3，2026-10-13）：图片的缩放/旋转控件走这里。
   *
   * 为什么是「槽」而不是让图片组件自己渲染控件：控件必须**物理上**长在顶栏里（拍板 D7），
   * 而顶栏在图片视图**上方** —— 组件没法往祖先的槽里塞东西，除非 portal；
   * 批 2 已拍板顶栏「行内渲染、不 portal」（走 portal 等于再造一个真源）。
   * 所以图片的视图状态上提到 `PageEditor`，这里只收一个已经渲染好的节点。
   *
   * ★ 与已退役的 `#editor-toolbar-slot`（悬浮胶囊的 portal 槽，批 2 删）**无关** ——
   * 那个是 portal 到主栏单例槽，这个是行内 JSX，真源仍在调用方。
   * 名字刻意不叫 `toolbarSlot`，免得与那段历史混淆。
   */
  rightSlot?: ReactNode
  /** AI 续写四态（拍板 C1：常驻钮，不放进菜单） */
  inlineOn: boolean
  inlineBusy: boolean
  inlinePaused: boolean
  onToggleInline: () => void
  /** `⋮` 是否渲染（默认 true）。批 2 拍板：菜单无内容时**整个不渲染**（不是渲染成禁用态）。
   *  ★ 现状下这是**潜伏守卫**：非 md 的「文件」组恒有 4 项、md 的「沉浸阅读」恒在 ⇒ 实际不会触发。
   *  将来 ⋮ 项被收窄时它自动生效（见 docs/nonmd-topbar-design.md §三·②）。 */
  showMore?: boolean
  /** `⋮` 菜单开合（内容由 PageEditor 以 moreMenu 传入，本组件不关心菜单里有啥） */
  moreOpen: boolean
  onToggleMore: () => void
  onCloseMore: () => void
  moreMenu: ReactNode
}

export function NoteTopBar({
  title, titleHint, subtitle, saving, showSaveDot = true, canBack, canForward, onBack, onForward,
  preview, onToggleView, showViewToggle = true,
  showInline = true,
  rightSlot,
  inlineOn, inlineBusy, inlinePaused, onToggleInline,
  showMore = true, moreOpen, onToggleMore, onCloseMore, moreMenu,
}: NoteTopBarProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 菜单外点 / Esc 关闭（捕获阶段：不依赖菜单内部按钮的冒泡顺序）
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current?.contains(e.target as Node)) return
      onCloseMore()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCloseMore() }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [moreOpen, onCloseMore])

  const iconBtn = 'rounded p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'

  // AI 续写四态配色（沿用 B-6 拍板：开=绿常亮 / 生成中=绿闪 / 暂停=黄 / 关=红降一级 + 斜杠兜底）
  const inlineStateClass = inlineBusy
    ? 'text-[var(--success)]'
    : !inlineOn
      ? 'text-[var(--danger)] opacity-70 hover:opacity-100'
      : inlinePaused
        ? 'text-[var(--warning)]'
        : 'text-[var(--success)]'

  return (
    <div ref={rootRef} data-wb="noteTopBar" className="relative flex h-10 shrink-0 select-none items-center gap-1 px-2">
      {/* 左：页面访问历史（历史栈在模块层，这里只消费 can/on 四件） */}
      <div className="flex items-center gap-0.5">
        <button data-wb="noteTopBack" onClick={onBack} disabled={!canBack} title="后退 (Alt+←)" className={iconBtn}>
          <ChevronLeft size={17} />
        </button>
        <button data-wb="noteTopForward" onClick={onForward} disabled={!canForward} title="前进 (Alt+→)" className={iconBtn}>
          <ChevronRight size={17} />
        </button>
      </div>

      {/* 中：文件名 + 保存点。绝对居中（两侧宽度变化时不漂）；点击无操作（拍板 B2）→ 整块不吃事件 */}
      <div className="pointer-events-none absolute left-1/2 top-0 flex h-full min-w-0 max-w-[calc(100%-210px)] -translate-x-1/2 items-center gap-2">
        <span data-wb="noteTopTitle" title={titleHint} className="truncate text-[13.5px] font-medium text-[var(--text-primary)]">
          {title}
        </span>
        {subtitle && (
          <span data-wb="noteTopSubtitle" className="shrink-0 text-[11.5px] text-[var(--text-muted)]">{subtitle}</span>
        )}
        {showSaveDot && (
          <span
            data-wb="noteSaveDot"
            title={saving ? '保存中…' : '已保存'}
            className={`h-[7px] w-[7px] shrink-0 rounded-full ${saving ? 'animate-pulse bg-[var(--warning)]' : 'bg-[var(--success)]'}`}
          />
        )}
      </div>

      {/* 右：常驻 ✨ / 阅读切换 / ⋮ */}
      <div className="ml-auto flex items-center gap-0.5">
        {showInline && inlineBusy && <span data-wb="inlineBusy" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--success)]" title="AI 续写请求中…" />}
        {showInline && (
        <button
          data-wb="inlineSuggestBtn"
          {...(inlineOn ? {} : { 'data-wb-inline-off': '1' })}
          onClick={onToggleInline}
          title={inlineBusy ? 'AI 续写建议：生成中…' : inlineOn ? 'AI 续写建议：已开启 · 点击关闭（单次要一条按 Alt+A）' : 'AI 续写建议：已关闭 · 点击开启'}
          className={`relative rounded p-1.5 transition-colors hover:bg-[var(--bg-hover)] ${inlineStateClass}`}
        >
          <Sparkles size={17} className={inlineBusy ? 'animate-pulse' : ''} />
          {/* 关闭态的形状差异（色盲兜底）：静态旋转，不走 transition-transform —— 铁律 13 的
              `.kb-chevron` 约束针对的是「要动画的 rotate-*」，此处不需要动画。 */}
          {!inlineOn && (
            <span
              aria-hidden
              data-wb="inlineOffSlash"
              className="pointer-events-none absolute left-0 right-0 top-1/2 h-[1.5px] rounded-full bg-current"
              style={{ transform: 'rotate(-45deg)' }}
            />
          )}
          {/* 暂停角标：配色刻意中立（按钮本身已变黄表达「暂停」，角标再黄就糊成一团） */}
          {inlinePaused && inlineOn && <span data-wb="inlinePaused" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--text-disabled)]" />}
        </button>
        )}

        {/* 阅读/编辑切换：同一个钮双向切换。`data-view` 是给探针的**状态锚点** ——
            按 title 文案找按钮会在改文案时静默假红（2026-10-11 顶栏改版后
            「切换到预览」变成「切换到阅读视图」，两个探针各红了一片）。 */}
        {showViewToggle && (
          <button data-wb="noteTopViewToggle" data-view={preview ? 'preview' : 'edit'} onClick={onToggleView} title={preview ? '切换到编辑 (Ctrl+E / Ctrl+/)' : '切换到阅读视图 (Ctrl+E / Ctrl+/)'} className={iconBtn}>
            {preview ? <PenLine size={17} /> : <BookOpen size={17} />}
          </button>
        )}

        {/* 调用方内联槽（批 3：图片的缩放/旋转控件）。位置在「控件在前、溢出在后」的常规次序上：
            阅读切换之后、⋮ 之前。图片态下 showViewToggle / showInline 皆为假 ⇒ 这里是零新增行高。 */}
        {rightSlot}

        {showMore && (
        <div className="relative">
          <button
            data-wb="noteTopMore"
            onClick={onToggleMore}
            aria-expanded={moreOpen}
            title="更多操作"
            className={`rounded p-1.5 transition-colors ${moreOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
          >
            <MoreHorizontal size={17} />
          </button>
          {moreOpen && (
            <div
              data-wb="noteTopMoreMenu"
              className="kb-pop absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-xl"
            >
              {moreMenu}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
