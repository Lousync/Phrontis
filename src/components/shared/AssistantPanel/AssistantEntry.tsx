import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ScrollText, SlidersHorizontal, FileJson, MessagesSquare, Plus, FolderTree, Flag } from 'lucide-react'
import {
  assistantConstraintsEnsureGlobal, assistantConstraintsEnsureSession, assistantConstraintsEnsureGlossary,
  assistantCommandsCreate, assistantCommandsEnsureDir, assistantHooksEnsure,
} from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { useAnchoredMenu } from '../../../lib/useAnchoredMenu'
import { SIDEBAR_HEADER_ICON } from '../sidebarHeaderIcon'

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
  /** 主菜单 / 新建指令表单（同一弹层内切换，不弹中央模态） */
  const [view, setView] = useState<'main' | 'new'>('main')
  const [cmdName, setCmdName] = useState('')
  const [creating, setCreating] = useState(false)
  const [cmdError, setCmdError] = useState('')

  const closeMenu = () => {
    close()
    setView('main')
    setCmdName('')
    setCmdError('')
  }

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

  const openCommandsDir = async () => {
    const r = await assistantCommandsEnsureDir().catch(() => null)
    if (!r?.ok || !r.relPath) { showToast({ type: 'error', message: `打开失败${r?.error ? `：${r.error}` : ''}` }); return }
    closeMenu()
    window.dispatchEvent(new CustomEvent('kb-reveal-tree', { detail: { relPath: r.relPath } }))
  }

  const openHooks = async () => {
    const r = await assistantHooksEnsure().catch(() => null)
    if (!r?.ok || !r.relPath) { showToast({ type: 'error', message: `打开失败${r?.error ? `：${r.error}` : ''}` }); return }
    closeMenu()
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: r.relPath, from: 'aiChat' } }))
    showToast({ type: 'info', message: `已在知识库打开${r.created ? '（已创建骨架）' : ''} · 保存后下一轮对话生效` })
  }

  const nameValid = (() => {
    const n = cmdName.trim()
    return n.length >= 1 && n.length <= 24 && /^[\p{L}\p{N}_-]+$/u.test(n) && !n.startsWith('-') && !n.startsWith('.')
  })()

  const submitCommand = async () => {
    const name = cmdName.trim()
    if (!name || !nameValid || creating) return
    setCreating(true)
    const r = await assistantCommandsCreate(name).catch(() => null)
    setCreating(false)
    if (!r?.ok || !r.relPath) { setCmdError(r?.error || '创建失败'); return }
    window.dispatchEvent(new CustomEvent('assistant-commands-changed'))
    closeMenu()
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: r.relPath, from: 'aiChat' } }))
    showToast({ type: 'info', message: `${r.created ? '已创建' : '已存在'} .assistant/commands/${name}.md · 写入正文即提示词` })
  }

  const itemCls = 'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => {
          if (open) { closeMenu(); return }
          setView('main')
          setCmdName('')
          setCmdError('')
          toggle()
        }}
        data-tip="助手定制（.assistant/）" aria-label="助手定制（.assistant/）"
        data-wb="assistantEntryBtn"
        aria-expanded={open}
        className={`p-1.5 rounded-md transition-colors ${open
          ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}
      >
        <SlidersHorizontal {...SIDEBAR_HEADER_ICON} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          data-wb="assistantEntryMenu"
          style={pos}
          className="kb-pop fixed z-50 w-60 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-1 shadow-xl"
        >
          {view === 'main' ? (
            <>
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
                data-tip={activeId ? '只对本会话生效，优先于全局要求' : '开始对话后可用'} aria-label={activeId ? '只对本会话生效，优先于全局要求' : '开始对话后可用'}>
                <MessagesSquare size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block text-[12px] text-[var(--text-primary)]">会话要求 · 仅本会话</span>
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
              <div className="my-1 border-t border-[var(--border-color)]" />
              <button onClick={() => { setView('new'); setCmdError('') }} className={itemCls}>
                <Plus size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block text-[12px] text-[var(--text-primary)]">新建自定义指令</span>
                  <span className="block truncate text-[10px] text-[var(--text-disabled)]">.assistant/commands/&lt;名字&gt;.md</span>
                </span>
              </button>
              <button onClick={() => { void openCommandsDir() }} className={itemCls}
                data-tip="在知识库左栏文件树展开 .assistant/commands" aria-label="在知识库左栏文件树展开 .assistant/commands">
                <FolderTree size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block text-[12px] text-[var(--text-primary)]">自定义指令文件夹</span>
                  <span className="block truncate text-[10px] text-[var(--text-disabled)]">在文件树定位 .assistant/commands</span>
                </span>
              </button>
              <button onClick={() => { void openHooks() }} className={itemCls}>
                <Flag size={13} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block text-[12px] text-[var(--text-primary)]">钩子 · 提示型</span>
                  <span className="block truncate text-[10px] text-[var(--text-disabled)]">.assistant/hooks.json（预填可改）</span>
                </span>
              </button>
            </>
          ) : (
            <div className="px-2 pb-2 pt-1.5">
              <label htmlFor="assistant-cmd-name" className="block text-[10.5px] text-[var(--text-muted)]">命令名（文件名即命令名）</label>
              <input
                id="assistant-cmd-name"
                value={cmdName}
                onChange={(e) => { setCmdName(e.target.value); setCmdError('') }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameValid && !creating) { e.preventDefault(); void submitCommand() }
                  if (e.key === 'Escape') { e.preventDefault(); setView('main') }
                }}
                placeholder="如：周报、复盘"
                autoFocus
                className="mt-1 w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <div className="mt-1 truncate text-[10px] text-[var(--text-disabled)]">
                {cmdName.trim() ? `将创建 .assistant/commands/${cmdName.trim()}.md` : '中文 / 字母 / 数字 / _ / -，最多 24 字'}
              </div>
              {cmdError && <div className="mt-1 text-[10.5px] text-[var(--danger)]">{cmdError}</div>}
              <div className="mt-2 flex justify-end gap-1.5">
                <button onClick={() => setView('main')} className="rounded-md border border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">取消</button>
                <button
                  onClick={() => { void submitCommand() }}
                  disabled={!nameValid || creating}
                  className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--bg-primary)] disabled:opacity-40"
                >{creating ? '创建中…' : '创建并打开'}</button>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
