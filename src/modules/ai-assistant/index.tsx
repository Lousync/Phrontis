import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, Square, ArrowUp, GitCompareArrows, Bot, ChevronRight, Zap } from 'lucide-react'
import type { AiScopeSuggestion, LlmProviderInfo } from '../../types'
import { workspaceGetCurrent, aiAssistantScopeSuggest, llmListProviders, llmReasoningCapable } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { useAnchoredMenu } from '../../lib/useAnchoredMenu'
import { BOOKMARK_COLORS } from '../../lib/workbenchLayout'
import { MessageList } from '../../components/shared/AssistantPanel/MessageList'
import { AiAssistantIcon } from '../../components/shared/AiAssistantIcon'
import { SessionRunMark } from '../../components/shared/AssistantPanel/SessionRunMark'
import { useInputShell } from '../../components/shared/AssistantPanel/inputShells'
import { useAiAssistant, type Effort } from './useAiAssistant'
import { prunePrefixes } from './scopeSetPure'
import { ScopePane } from './ScopePane'

/** Monaco 差异预览只在有待确认变更时按需加载 */
const ReviewPane = lazy(() => import('./ReviewPane').then(m => ({ default: m.ReviewPane })))

/**
 * AI助手模块（v3.9.0，工作台内 Tab，形态同笔记 / 日程）。
 *
 * 左栏 = 作用域圈选（上）+ 任务列表（下，底部「新建任务」）；
 * 中央 = 任务流（共享 MessageList：AI 去气泡 + 工具摘要 + 用户带尾角气泡）+ **常驻底部输入框**
 *   （外框走 `useInputShell()`，与 AI教学 / 侧栏 AI助手 同一套样式；工具条 = 合规提示 + 模型/强度 + 发送/停止）。
 * v3.11.0 起与右侧栏、AI 对话页共用同一批会话（source='assistant'）：本文件只是完整视图宿主，
 * 状态机在 `useAssistantChat`；运行态与消息渲染复用共享资产（assistantRunStore / MessageList）。
 * 主链路（文件作用域 / 先预览 / 整任务回滚）见 `.claude/plans/unified-ai-assistant-v311.md`。
 */
const EFFORT_LABEL: Record<Effort, string> = { off: '关闭', low: '低', medium: '中', high: '高' }

/**
 * 需要作用域才能跑的动作 —— 四条入口（发送 / 重新生成 / 编辑重发 / 继续）共用同一道守卫
 * （2026-10-16 拍板）。原因：主进程侧 `scopeOf()` 对**空数组返回 undefined = 不设限**
 * （`aiAssistantScope.ts:17`），只拦首次发送等于给「继续 / 重新生成」留了一条全库读写的路。
 */
type PendingRun =
  | { kind: 'send'; text: string }
  | { kind: 'regenerate' }
  | { kind: 'resume' }
  | { kind: 'edit'; id: string; content: string }

/** 「建议作用域」卡：候选 + 勾选集 + 采用后要续跑的那件事 */
interface ScopeCardState {
  query: string
  candidates: AiScopeSuggestion[]
  accepted: Set<string>
  run: PendingRun
}

/** 建议卡主按钮文案按「圈完要跑哪件事」变（同一个守卫拦四种入口，措辞不能写死「发送」） */
const ADOPT_LABEL: Record<PendingRun['kind'], string> = {
  send: '采用并发送',
  regenerate: '采用并重新生成',
  resume: '采用并继续',
  edit: '采用并重发',
}

interface Props {
  isActive?: boolean
  sidebarEl?: HTMLElement | null
  sidebarHosted?: boolean
}

export function AiAssistantModule({ isActive = true, sidebarEl = null, sidebarHosted = false }: Props) {
  const shell = useInputShell()
  const api = useAiAssistant(isActive)
  const [draft, setDraft] = useState('')
  const [rootId, setRootId] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewWidth, setReviewWidth] = useState(520)
  const [scopeCard, setScopeCard] = useState<ScopeCardState | null>(null)
  /** 作用域卡折叠（只存本地 UI 状态，不写 Vault） */
  const [scopeCollapsed, setScopeCollapsed] = useState(() => {
    try { return localStorage.getItem('phrontis.ai.scopeCollapsed') === '1' } catch { return false }
  })
  const toggleScopeCollapsed = useCallback(() => {
    setScopeCollapsed(v => {
      const next = !v
      try { localStorage.setItem('phrontis.ai.scopeCollapsed', next ? '1' : '0') } catch { /* 本地状态失败不阻断 */ }
      return next
    })
  }, [])
  /** 任务条目改名（双击进内联输入框；与 AI 教学左栏会话行同一手法） */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [providerList, setProviderList] = useState<LlmProviderInfo[]>([])
  // 模型 / 思考强度菜单：必须 portal + 实测锚点（F-1，2026-10-16）。裸 absolute 的包含块是触发按钮，
  // w-[280px] 会被 max-w-full 压成按钮宽的竖条；useAnchoredMenu 按视口翻折与 clamp，与宿主窄宽无关。
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const modelMenu = useAnchoredMenu(modelTriggerRef, modelMenuRef, 280)
  const [modelCapable, setModelCapable] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const dragGuardRef = useRef(0)
  const layoutRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void (async () => {
      try { setRootId((await workspaceGetCurrent())?.rootId ?? null) } catch { setRootId(null) }
    })()
  }, [])

  useEffect(() => {
    if (!isActive) return
    void llmListProviders().then((r) => setProviderList(r.providers ?? [])).catch(() => null)
  }, [isActive])

  // 思考强度门槛（与 AI 教学同口径）：所选模型不支持推理 → 强制回落关闭
  const effModelBare = api.modelId.includes(':') ? api.modelId.slice(api.modelId.indexOf(':') + 1) : api.modelId
  useEffect(() => {
    if (!effModelBare) { setModelCapable(false); return }
    void llmReasoningCapable(effModelBare).then(setModelCapable).catch(() => setModelCapable(false))
  }, [effModelBare])
  useEffect(() => {
    if (!modelCapable && api.effort !== 'off') api.setEffort('off')
  }, [modelCapable, api.effort, api])

  // 出现待确认变更时自动展开审阅面板（0 → 有 的边沿）
  const prevPendingRef = useRef(0)
  useEffect(() => {
    if (prevPendingRef.current === 0 && api.pendingCount > 0) setReviewOpen(true)
    prevPendingRef.current = api.pendingCount
  }, [api.pendingCount])

  const hasPlan = (api.plan?.ops.length ?? 0) > 0
  /** 空对话（无消息且未在生成）：空态不滚、不留滚动条，也不挂「回到底部」浮标宿主 */
  const chatEmpty = api.messages.length === 0 && !api.pending

  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const host = layoutRef.current
    if (!host) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const total = host.getBoundingClientRect().width
    const move = (ev: PointerEvent): void => {
      const next = Math.round(total - (ev.clientX - host.getBoundingClientRect().left))
      setReviewWidth(Math.max(320, Math.min(next, total - 360)))
    }
    const up = (): void => {
      dragGuardRef.current = performance.now() + 250
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  /** 最后一条用户消息（未圈定时用它做建议范围的匹配语料；重新生成 / 继续都靠它） */
  const lastUserText = useMemo(() => {
    for (let i = api.messages.length - 1; i >= 0; i--) {
      const m = api.messages[i]
      if (m.role === 'user' && m.content.trim()) return m.content
    }
    return api.active?.title ?? ''
  }, [api.messages, api.active])

  /** 真正开跑（作用域已就绪时才会被调用） */
  const execRun = useCallback((run: PendingRun) => {
    if (run.kind === 'send') { setDraft(''); void api.send(run.text); return }
    if (run.kind === 'regenerate') { void api.onRegenerate(); return }
    if (run.kind === 'resume') { void api.onResume(); return }
    void api.onEditSubmit(run.id, run.content)
  }, [api])

  /**
   * 统一守卫：已圈定 → 直接跑；未圈定 → 先用描述匹配「建议作用域卡」（§3.5），采用后再跑。
   * 四条入口都必须过这里（空 scope 在主进程侧 = 不设限，见 PendingRun 注释）。
   */
  const runGuarded = useCallback((run: PendingRun, query: string) => {
    if (api.pending) return
    // 整仓 / 已选文件 / 普通提问（不读文件）都直接跑；
    // 只有「继续 / 重新生成 / 编辑重发」在空选时先给建议范围（它们需要落到具体文件）。
    if (api.scopeAll || api.scope.length > 0 || run.kind === 'send') { execRun(run); return }
    void (async () => {
      try {
        const cands = await aiAssistantScopeSuggest(query, 8)
        if (cands.length === 0) {
          showToast({ type: 'info', message: '没匹配到相关内容', detail: '请在左栏手动圈定作用域，或换个说法' })
          return
        }
        setScopeCard({ query, candidates: cands, accepted: new Set(cands.map((c) => c.relPath)), run })
      } catch (e) {
        showToast({ type: 'error', message: '作用域建议失败', detail: String(e) })
      }
    })()
  }, [api.pending, api.scope.length, execRun])

  const handleSend = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    runGuarded({ kind: 'send', text }, text)
  }, [draft, runGuarded])

  const toggleScopeCard = useCallback((relPath: string) => {
    setScopeCard((prev) => {
      if (!prev) return prev
      const next = new Set(prev.accepted)
      if (next.has(relPath)) next.delete(relPath); else next.add(relPath)
      return { ...prev, accepted: next }
    })
  }, [])

  /** 采用建议范围：先落进本任务的作用域，再续跑卡片记下的那件事 */
  const adoptScopeCard = useCallback((runNow: boolean) => {
    if (!scopeCard) return
    const paths = Array.from(scopeCard.accepted)
    if (paths.length === 0) return
    const { run } = scopeCard
    api.setScope(prunePrefixes(paths))
    setScopeCard(null)
    if (runNow) execRun(run)
  }, [scopeCard, api, execRun])

  /** 提交改名（双击入口）：乐观更新在 hook 内做，这里只管草稿与退出编辑态 */
  const commitRename = useCallback(async (id: string) => {
    const t = renameDraft.trim().slice(0, 40)
    setRenamingId(null)
    const row = api.sessions.find((s) => s.id === id)
    if (!t || !row || t === row.title) return
    await api.renameSession(id, t)
  }, [renameDraft, api])

  const pickModel = useCallback((val: string) => {
    api.setModelId(val)
    modelMenu.close()
  }, [api, modelMenu.close])

  const sidebar = (
    <div className="flex h-full flex-col">
      {/* 作用域（上）：段头 + 搜索 + 摘要行 + 目录树三态勾选。运行中锁定（本轮已按快照跑完，改了下轮才生效） */}
      <div className={`flex min-h-0 flex-col ${scopeCollapsed ? 'shrink-0' : ''}`} style={{ maxHeight: scopeCollapsed ? undefined : '56%' }}>
        {/* 56% 限高保留：chip 行已删、段高恒定，不再存在「chip 每长一行从树上割一块」；限高是为了让树不吞掉下方任务段 */}
        <div className="flex shrink-0 items-center justify-between px-3 py-2">
          <button
            type="button"
            onClick={toggleScopeCollapsed}
            className="flex min-w-0 items-center gap-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            title={scopeCollapsed ? '展开作用域' : '折叠作用域'}
          >
            <ChevronRight size={11} className={`kb-chevron shrink-0 ${scopeCollapsed ? '' : 'is-open'}`} />
            作用域
            <span className="normal-case tracking-normal text-[var(--text-disabled)]">
              {api.scopeAll ? '· 整个仓库' : api.scope.length ? `· ${api.scope.length} 项` : '· 未选择文件'}
            </span>
          </button>
          {/* 计数与空态在 ScopePane 的摘要行（选择态只有一处表达），段头只报锁定状态 */}
          {api.pending && (
            <span className="text-[11px] text-[var(--text-muted)]" title="本轮已在运行：作用域已锁定，改动要等这一轮跑完">运行中 · 已锁定</span>
          )}
        </div>
        {!scopeCollapsed && (
          <div className="kb-item-in flex min-h-0 flex-1 flex-col">
            <ScopePane
              rootId={rootId}
              scope={api.scope}
              scopeAll={api.scopeAll}
              onChange={api.setScope}
              onScopeAllChange={api.setScopeAll}
              disabled={api.pending}
            />
          </div>
        )}
      </div>

      {/* 任务（下）：段头（含新建）+ 列表；新建入口在段头，不占列表尾部 */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--border-color)]">
        <div className="flex shrink-0 items-center justify-between gap-1 px-3 py-2">
          <span className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">会话</span>
          <span className="flex items-center gap-0.5">
            <span className="text-[11px] text-[var(--text-muted)]">{api.sessions.length}</span>
            <button
              type="button"
              onClick={() => void api.newSession()}
              className="kb-micro-pop flex h-5 w-5 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              title="新建会话"
            >
              <Plus size={13} />
            </button>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {api.sessions.length === 0 ? (
            <p className="px-2 py-4 text-center text-[12px] text-[var(--text-muted)]">暂无会话</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {api.sessions.map((s) => (
                <li key={s.id} className="group flex items-center gap-1">
                  {renamingId === s.id ? (
                    /* 改名：双击条目名进内联输入框（Enter 提交 / Esc 取消 / 移开焦点提交），与 AI 教学左栏同款 */
                    <input
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      value={renameDraft}
                      maxLength={40}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => void commitRename(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.id) }
                        else if (e.key === 'Escape') { e.stopPropagation(); setRenamingId(null) }
                      }}
                      className="min-w-0 flex-1 rounded-md border border-[var(--accent)] bg-[var(--input-bg)] px-2 py-1 text-[12.5px] text-[var(--text-primary)] outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => api.setActiveId(s.id)}
                      title={s.title || '未命名会话'}
                      className={`kb-item-in flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12.5px] ${
                        api.activeId === s.id ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      <span
                        className="truncate"
                        onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(s.id); setRenameDraft(s.title || '') }}
                      >{s.title || '未命名会话'}</span>
                      <span className="flex-1" />
                      <SessionRunMark mark={api.activeId === s.id ? api.runMark : null} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void api.deleteSession(s.id)}
                    className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--danger)] group-hover:flex"
                    title="删除会话"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <>
      {sidebarHosted && sidebarEl ? createPortal(sidebar, sidebarEl) : null}

      <div ref={layoutRef} className="flex h-full min-w-0 bg-[var(--bg-primary)]">
        <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
          <span className="flex min-w-0 items-center gap-2">
            <AiAssistantIcon size={13} style={{ color: BOOKMARK_COLORS.aiAssistant.fg }} />
            <span className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{api.active?.title || 'AI助手'}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {(api.usage.in + api.usage.out) > 0 && (
              <span
                className="kb-micro-pop rounded-md bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--text-muted)]"
                title={`本任务消耗：输入 ${api.usage.in.toLocaleString()} · 输出 ${api.usage.out.toLocaleString()} tokens`}
              >
                {fmtTokens(api.usage.in + api.usage.out)} tok
              </span>
            )}
            <button
              type="button"
              onClick={() => setReviewOpen((v) => !v)}
              disabled={!hasPlan}
              className={`kb-micro-pop flex items-center gap-1 rounded-md px-2 py-1 text-[12px] disabled:opacity-40 ${
                reviewOpen && hasPlan ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
              title="查看变更方案"
            >
              <GitCompareArrows size={13} />
              变更
              {api.pendingCount > 0 && (
                <span className="kb-micro-pop ml-0.5 rounded-full bg-[var(--accent)] px-1.5 text-[10px] leading-4 text-white">{api.pendingCount}</span>
              )}
            </button>
          </span>
        </div>

        {/* 对话列（消息 + 输入卡 + 作用域建议卡）统一 820 限宽居中 —— 与 AI 教学 / aiChat page 态同一口径 */}
        <div className="mx-auto min-h-0 w-full max-w-[820px] flex-1">
          <MessageList
            messages={api.messages}
            pending={api.pending}
            liveSteps={api.liveSteps}
            draft={api.draft}
            editing={api.editing}
            setEditing={api.setEditing}
            copiedIdx={api.copiedIdx}
            setCopiedIdx={api.setCopiedIdx}
            onRegenerate={() => runGuarded({ kind: 'regenerate' }, lastUserText)}
            resumeInfo={api.resumeInfo}
            onResume={() => runGuarded({ kind: 'resume' }, lastUserText)}
            onEditSubmit={(id, content) => runGuarded({ kind: 'edit', id, content }, content)}
            onDeleteMessage={(id) => void api.onDeleteMessage(id)}
            className={chatEmpty ? 'h-full overflow-hidden px-4' : 'h-full overflow-y-auto px-4 py-4 space-y-3'}
            jumpBottom={!chatEmpty}
            emptyHint={(
              /* 空态只留一个图标（2026-10-16 用户拍板：删掉两行引导文案，只留图标本身）。
                 容器 + 图标色都指向模块色，与工作台书签同色。 */
              <div className="flex h-full items-center justify-center">
                {/* 图标色取模块书签色真源（BOOKMARK_COLORS），不写死色值 */}
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--bg-hover)]" style={{ color: BOOKMARK_COLORS.aiAssistant.fg }}>
                  <AiAssistantIcon size={20} />
                </div>
              </div>
            )}
          />
        </div>

        {scopeCard && (
          <div className="mx-auto w-full max-w-[820px] shrink-0 px-4 pb-1">
          <div className="kb-item-in rounded-xl border border-[var(--accent)] bg-[var(--bg-secondary)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                建议作用域（{scopeCard.accepted.size}/{scopeCard.candidates.length}）
              </span>
              <button
                type="button"
                onClick={() => setScopeCard(null)}
                className="kb-micro-pop rounded-md px-1.5 py-0.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                取消
              </button>
            </div>
            <ul className="max-h-[180px] overflow-y-auto">
              {scopeCard.candidates.map((c) => (
                <li key={c.relPath}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-[var(--bg-hover)]">
                    <input
                      type="checkbox"
                      checked={scopeCard.accepted.has(c.relPath)}
                      onChange={() => toggleScopeCard(c.relPath)}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="truncate text-[var(--text-secondary)]">{c.title}</span>
                    <span className="ml-auto truncate text-[11px] text-[var(--text-muted)]">{c.relPath}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => adoptScopeCard(false)}
                disabled={scopeCard.accepted.size === 0}
                className="kb-micro-pop rounded-md border border-[var(--border-color)] px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
              >
                仅圈选
              </button>
              <button
                type="button"
                onClick={() => adoptScopeCard(true)}
                disabled={scopeCard.accepted.size === 0}
                className="kb-micro-pop rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] text-white disabled:opacity-40"
              >
                {ADOPT_LABEL[scopeCard.run.kind]}
              </button>
            </div>
          </div>
          </div>
        )}

        <div className="shrink-0">
          <div className="mx-auto w-full max-w-[820px] px-4 pb-2.5 pt-2">
            <div className={`relative px-2.5 pt-2 pb-2 ${shell.wrap}`}>
            <textarea
              ref={composerRef}
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              rows={2}
              placeholder={api.scopeAll || api.scope.length ? '描述要整理的内容…（Enter 发送）' : '未选择文件：本轮 AI 不会读写仓库文件…'}
              className={`w-full appearance-none px-0.5 py-1 text-[13px] resize-none outline-none bg-transparent! border-0! rounded-none! ${shell.ta ?? ''}`}
            />
            {/* 工具条：合规提示（左空白）→ 模型/思考强度菜单 → 发送/停止（与 AI教学同一口径） */}
            <div className="relative flex items-center gap-2 mt-0.5">
              <span className="flex-1 min-w-0 truncate text-[10.5px] text-[var(--text-disabled)] select-none" title="AI 生成内容可能存在错误，请自行核实">AI 生成内容，请注意甄别</span>
              <>
                <button
                  type="button"
                  onClick={() => api.setWriteMode(api.writeMode === 'confirm' ? 'direct' : 'confirm')}
                  disabled={api.pending}
                  className={`flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition-colors disabled:opacity-40 ${
                    api.writeMode === 'confirm'
                      ? 'text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                  }`}
                  title={api.writeMode === 'confirm'
                    ? '先预览：写操作等确认后应用（点击切直接执行）'
                    : '直接执行：写操作立即落盘（点击切先预览）'}
                >
                  <Zap size={11} />
                  {api.writeMode === 'confirm' ? '先预览' : '直接执行'}
                </button>
                <button
                  ref={modelTriggerRef}
                  type="button"
                  onClick={modelMenu.toggle}
                  aria-expanded={modelMenu.open}
                  className={`flex items-center gap-1 h-7 px-2 rounded-md text-[11px] transition-colors ${
                    modelMenu.open ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                  }`}
                  title="本任务模型与思考强度（仅本任务生效，默认跟随设置→AI 默认模型）"
                >
                  <Bot size={11} />
                  <span className="max-w-[140px] truncate">{effModelBare || '默认'}</span>
                  {api.effort !== 'off' && <span className="text-[var(--accent)]">· 🧠{EFFORT_LABEL[api.effort]}</span>}
                  <ChevronRight size={10} className="-rotate-90 shrink-0" />
                </button>
                {modelMenu.open && modelMenu.pos && createPortal(
                  <div
                    ref={modelMenuRef}
                    style={modelMenu.pos}
                    className="kb-pop fixed z-50 w-[280px] rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl overflow-hidden select-none"
                  >
                    <div className="px-3 py-1.5 text-[10.5px] text-[var(--text-muted)] bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">回答模型 · 仅本任务生效</div>
                    <div className="max-h-[300px] overflow-y-auto py-1">
                      <button
                        onClick={() => pickModel('')}
                        className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-[11.5px] hover:bg-[var(--bg-hover)] transition-colors ${!api.modelId ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}
                      >
                        <span className="truncate flex-1">跟随设置默认</span>
                        {!api.modelId && <span className="shrink-0">✓</span>}
                      </button>
                      {providerList.filter((p) => p.enabled && p.models.length > 0).flatMap((p) =>
                        p.models.map((mm) => {
                          const val = `${p.id}:${mm}`
                          const sel = api.modelId === val
                          return (
                            <button key={val} onClick={() => pickModel(val)}
                              className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-[11.5px] hover:bg-[var(--bg-hover)] transition-colors ${sel ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                              <span className="text-[9.5px] text-[var(--text-muted)] shrink-0">{p.name}</span>
                              <span className="truncate flex-1">{mm}</span>
                              {sel && <span className="shrink-0">✓</span>}
                            </button>
                          )
                        }))}
                      {providerList.filter((p) => p.enabled && p.models.length > 0).length === 0 && (
                        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">尚无启用的供应商（设置 → AI 模型中添加）</div>
                      )}
                    </div>
                    <div className="px-3 pt-1.5 flex items-center justify-between border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
                      <span className="text-[10.5px] text-[var(--text-muted)]">思考强度</span>
                      {!modelCapable && <span className="text-[10px] text-[var(--text-muted)]">当前模型不支持</span>}
                    </div>
                    <div className={`flex gap-1 px-3 py-2 bg-[var(--bg-secondary)] ${modelCapable ? '' : 'opacity-40 pointer-events-none'}`}>
                      {(['off', 'low', 'medium', 'high'] as const).map((e) => (
                        <button key={e} onClick={() => api.setEffort(e)}
                          className={`flex-1 px-1 py-0.5 rounded-md text-[11px] transition-colors ${api.effort === e ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>
                          {EFFORT_LABEL[e]}
                        </button>
                      ))}
                    </div>
                  </div>,
                  document.body,
                )}
              </>
              {api.pending ? (
                <button
                  type="button"
                  onClick={() => void api.stop()}
                  className="kb-micro-pop h-7 w-7 shrink-0 rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] flex items-center justify-center hover:opacity-80 transition-opacity"
                  title="停止生成（已完成的轮次保留）"
                >
                  <Square size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!draft.trim()}
                  className="kb-micro-pop h-7 w-7 shrink-0 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-opacity"
                  title="发送"
                >
                  <ArrowUp size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
        </div>
        </div>

        {reviewOpen && hasPlan && api.plan ? (
          <>
            <div
              onPointerDown={startResize}
              className="kb-draggable w-1 shrink-0 cursor-col-resize bg-[var(--border-color)] hover:bg-[var(--accent)]"
              title="拖动调整宽度"
            />
            <div style={{ width: reviewWidth, maxWidth: '100%' }} className="h-full min-w-0 max-w-full shrink-0 border-l border-[var(--border-color)]">
              <Suspense fallback={<div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">正在载入差异预览…</div>}>
                <ReviewPane
                  plan={api.plan}
                  busy={api.pending}
                  compact={reviewWidth < 720}
                  onApply={(ids) => { if (performance.now() < dragGuardRef.current) return; void api.applyAccepted(ids) }}
                  onReject={() => void api.rejectPlan()}
                  onRollback={() => void api.rollbackTask()}
                />
              </Suspense>
            </div>
          </>
        ) : null}
      </div>
    </>
  )
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
