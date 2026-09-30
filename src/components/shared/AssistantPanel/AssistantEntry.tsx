import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { ScrollText, SlidersHorizontal, FileJson, MessagesSquare } from 'lucide-react'
import { assistantConstraintsEnsureGlobal, assistantConstraintsEnsureSession, assistantConstraintsEnsureGlossary } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { useAnchoredMenu } from '../../../lib/useAnchoredMenu'

/**
 * AI 助手面板头部常驻入口（v3.4.0 台账 N-5/N-7，2026-09-24 拍板④⑤：原型 A）。
 *
 * 点击弹条目层 → 点哪个跳哪个：跳**知识库** draft 页签打开对应文件（不内联编辑），
 * 靠 N-4 恢复的「← 返回 AI对话」chip 回跳（from: 'aiChat'）。三处宿主共用本组件：
 * 悬浮侧栏头部 / 右栏 AI 态轻头部 / aiChat 标签左栏会话侧栏。
 *
 * F-2（2026-09-30）：菜单原先裸 `absolute` → 被宿主面板 / 中栏的 `overflow-hidden` 裁剪。
 * 改用 `useAnchoredMenu`（锚点翻折 + clamp）+ **portal 到 body**，彻底脱离裁剪祖先。
 */
export function AssistantEntryButton({ activeId }: { activeId: string | null }) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const { open, pos, toggle, close } = useAnchoredMenu(triggerRef, menuRef, 240)

  /** ensure → 派 kb-open-note（from: 'aiChat'，吃 N-4 的返回 chip 链）→ toast */
  const openItem = async (kind: 'global' | 'session' | 'glossary') => {
    if (kind === 'session' && !activeId) {
      showToast({ type: 'warning', message: '会话要求随对话存放：先选择或新建一个对话' })
      return
    }
    const r = kind === 'global' ? await assistantConstraintsEnsureGlobal().catch(() => null)
      : kind === 'session' ? await assistantConstraintsEnsureSession(activeId!).catch(() => null)
      : await assistantConstraintsEnsureGlossary().catch(() => null)
    if (!r?.ok || !r.relPath) { showToast({ type: 'error', message: `打开失败${r?.error ? `：${r.error}` : ''}` }); return }
    close()
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: r.relPath, from: 'aiChat' } }))
    showToast({ type: 'info', message: `已在知识库打开（${r.created ? '已创建' : '已有文件'}）· 保存后下一轮对话生效` })
  }

  const itemCls = 'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        title="助手要求与术语表（.assistant/）"
        data-wb="assistantEntryBtn"
        aria-expanded={open}
        className={`p-1.5 rounded-md transition-colors ${open
          ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}
      >
        <SlidersHorizontal size={14} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          data-wb="assistantEntryMenu"
          style={{ left: pos.left, top: pos.top }}
          className="kb-pop fixed z-50 w-60 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-1 shadow-xl"
        >
          <div className="px-2 pb-1 pt-1.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            助手定制 · 存于仓库 .assistant/，AI 每轮读取
          </div>
          <button onClick={() => { void openItem('global') }} className={itemCls}>
            <ScrollText size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
            <span className="min-w-0">
              <span className="block text-[12px] text-[var(--text-primary)]">助手要求 · 所有对话</span>
              <span className="block truncate text-[10px] text-[var(--text-disabled)]">.assistant/CONSTRAINTS.md</span>
            </span>
          </button>
          <button onClick={() => { void openItem('session') }} disabled={!activeId} className={itemCls}
            title={activeId ? '只对本对话生效，优先于全局要求' : '开始对话后可用'}>
            <MessagesSquare size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
            <span className="min-w-0">
              <span className="block text-[12px] text-[var(--text-primary)]">会话要求 · 仅当前对话</span>
              <span className="block truncate text-[10px] text-[var(--text-disabled)]">
                {activeId ? '按需升格，覆盖全局要求' : '先选择或新建一个对话'}
              </span>
            </span>
          </button>
          <div className="my-1 border-t border-[var(--border-color)]" />
          <button onClick={() => { void openItem('glossary') }} className={itemCls}>
            <FileJson size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
            <span className="min-w-0">
              <span className="block text-[12px] text-[var(--text-primary)]">术语表 · 命名对照</span>
              <span className="block truncate text-[10px] text-[var(--text-disabled)]">.assistant/glossary.json（预填可改）</span>
            </span>
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}
