/**
 * 终端模块（v3.5.0，docs/terminal-module-design.md）。
 *
 * 工作台内 Tab：真 pty（主进程 terminalService）+ xterm.js；会话条多会话 + 「AI 执行记录」签页。
 * 模块根节点 h-full（铁律 11）；确认一律行内，仅高危命令弹严重警告（铁律 25 + ui-interaction-patterns）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eraser, Info, Plus, X } from 'lucide-react'
import * as ipc from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { ModalShell } from '../../components/shared/ModalShell'
import type { TerminalAiRecord, TerminalSessionInfo } from '../../types'
import TerminalPane, { type TerminalDims, type TerminalWinPty } from './TerminalPane'
import AiRecordList from './AiRecordList'

const MAX_SESSIONS = 4

interface Props {
  active: boolean
  /** 工作台左栏模块态 slot（railModule === 'terminal' 时托管会话列表） */
  sidebarEl: HTMLElement | null
}

export default function TerminalModule({ active, sidebarEl }: Props) {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showAi, setShowAi] = useState(false)
  const [records, setRecords] = useState<TerminalAiRecord[]>([])
  const [shellLabel, setShellLabel] = useState('')
  const [cwd, setCwd] = useState('')
  const [fontSize, setFontSize] = useState(13)
  const [clearSignal, setClearSignal] = useState(0)
  const loadedRef = useRef(false)
  const pendingSeen = useRef(new Set<string>())
  /** 最近一次量得的视口尺寸：创建 pty 必须用它（先 80×24 再 resize 会触发 ConPTY 重印乱码） */
  const dimsRef = useRef<TerminalDims>({ cols: 100, rows: 30 })
  // xterm 的 ConPTY 兼容选项（VS Code 同款）。Windows 上等主进程报回构建号再挂 pane ——
  // 该选项必须在 Terminal 构造时就位，晚设只对新增行生效
  const [winPty, setWinPty] = useState<TerminalWinPty | undefined>(undefined)
  const [winPtyReady, setWinPtyReady] = useState(!navigator.userAgent.includes('Windows'))

  const aliveCount = sessions.filter(s => !s.exited).length
  const pendingRec = records.find(r => r.status === 'pending')
  const riskyPending = records.find(r => r.status === 'pending' && r.risky)

  // 首挂：拉会话 / AI 记录 / shell 标签 / 字号；空则建首个会话
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    void (async () => {
      try {
        const [list, recs, shell, fs] = await Promise.all([
          ipc.termList(),
          ipc.termAiRecords(),
          ipc.termDefaultShell(),
          ipc.getSetting('terminalFontSize'),
        ])
        setRecords(recs.records)
        setShellLabel(shell.label)
        setFontSize(fs)
        if (shell.windowsBuildNumber) setWinPty({ backend: 'conpty', buildNumber: shell.windowsBuildNumber })
        setWinPtyReady(true)
        if (list.sessions.length === 0) {
          // 无会话：不在这里创建 —— 等 boot pane 量出真实尺寸后由 onCreate 创建（避免 80×24 起进程）
          setActiveId(null)
        } else {
          setSessions(list.sessions)
          setActiveId(list.sessions.find(x => !x.exited)?.id ?? null)
        }
      } catch (e) {
        showToast({ type: 'error', message: '终端初始化失败', detail: (e as Error).message })
      }
    })()
  }, [])

  useEffect(() => {
    void ipc.workspaceGetCurrent().then(v => { if (v) setCwd(v.path) }).catch(() => { /* 无仓库 */ })
  }, [])

  // 会话退出 + AI 记录广播（pending 首现 = 新的确认请求：Toast 提醒，不抢焦点不切签页）
  useEffect(() => {
    const offExit = ipc.onTermExit(({ id, exitCode }) => {
      setSessions(prev => prev.map(s => (s.id === id ? { ...s, exited: true, exitCode } : s)))
    })
    const offRec = ipc.onTermAiRecord(({ record }) => {
      setRecords(prev => {
        const i = prev.findIndex(r => r.reqId === record.reqId)
        if (i >= 0) { const next = [...prev]; next[i] = record; return next }
        return [record, ...prev].slice(0, 50)
      })
      if (record.status === 'pending' && !pendingSeen.current.has(record.reqId)) {
        pendingSeen.current.add(record.reqId)
        showToast({
          type: 'warning',
          message: record.risky ? 'AI 请求执行高危命令' : 'AI 请求执行终端命令',
          detail: `${record.cmd}（到终端模块「AI 执行记录」确认）`,
        })
      }
    })
    return () => { offExit(); offRec() }
  }, [])

  // 激活会话被删/退出时回落
  useEffect(() => {
    if (showAi) return
    if (activeId && !sessions.some(s => s.id === activeId && !s.exited)) {
      setActiveId(sessions.find(s => !s.exited)?.id ?? null)
    }
  }, [sessions, activeId, showAi])

  const createSession = useCallback(async (dims?: TerminalDims) => {
    if (aliveCount >= MAX_SESSIONS) {
      showToast({ type: 'warning', message: `最多同时 ${MAX_SESSIONS} 个终端会话` })
      return
    }
    const d = dims ?? dimsRef.current
    try {
      const s = await ipc.termCreate({ cols: d.cols, rows: d.rows })
      setSessions(prev => [...prev, s])
      setShowAi(false)
      setActiveId(s.id)
    } catch (e) {
      showToast({ type: 'error', message: '新建会话失败', detail: (e as Error).message })
    }
  }, [aliveCount])

  const killSession = useCallback(async (id: string) => {
    try { await ipc.termKill(id) } catch { /* 已退出 */ }
    setSessions(prev => prev.filter(s => s.id !== id))
  }, [])

  const respond = useCallback((reqId: string, approved: boolean) => {
    void ipc.termAiRespond(reqId, approved)
    setShowAi(true) // 决定后留在「AI 执行记录」看结果（状态由主进程广播回推）
  }, [])

  // 会话名渲染序：shell 标签 + 序号（随列表位置）
  const sessName = (s: TerminalSessionInfo) => `${s.shell} ${sessions.indexOf(s) + 1}`

  // 左栏模块态侧栏：会话列表 + AI 执行记录入口
  const sidebar = sidebarEl
    ? createPortal(
        <div className="flex h-full flex-col">
          <div className="flex-1 overflow-auto px-2 py-2">
            <div className="mb-1 px-1 text-[11px] font-medium text-[var(--text-muted)]">会话 {aliveCount}/{MAX_SESSIONS}</div>
            {sessions.map(s => (
              <div key={s.id}>
                <button
                  className={`group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                    !showAi && s.id === activeId ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                  onClick={() => { setShowAi(false); setActiveId(s.id) }}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.exited ? 'bg-[var(--text-disabled)]' : 'bg-[var(--accent)]'}`} />
                  <span className="min-w-0 flex-1 truncate">{sessName(s)}{s.exited ? '（已结束）' : ''}</span>
                  {sessions.length > 1 && (
                    <span
                      role="button"
                      tabIndex={-1}
                      className="hidden shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--terminal-err,#f48771)] hover:text-white group-hover:block"
                      onClick={e => { e.stopPropagation(); void killSession(s.id) }}
                    ><X size={11} /></span>
                  )}
                </button>
              </div>
            ))}
            <button
              className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
              onClick={() => void createSession()}
            ><Plus size={12} /> 新建会话</button>
            <div className="my-2 border-t border-[var(--border-color)]" />
            <button
              className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                showAi ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
              onClick={() => setShowAi(true)}
            >
              AI 执行记录
              {pendingRec && <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--terminal-warn,#e5c07b)]" />}
            </button>
          </div>
          {/* 底部信息：swap-bar（docs/help-disclosure-pattern.md A）—— 默认只显 ⓘ，悬停父条说明淡入 */}
          <div className="group relative h-7 shrink-0 border-t border-[var(--border-color)]">
            <span className="absolute inset-0 flex items-center justify-center text-[var(--text-disabled)] transition-opacity duration-300 group-hover:opacity-0">
              <Info size={13} />
            </span>
            <span className="absolute inset-0 flex items-center overflow-hidden whitespace-nowrap px-3 text-[10.5px] text-[var(--text-disabled)] text-ellipsis opacity-0 translate-y-[3px] transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
              {shellLabel || '…'}<span className="mx-1.5 opacity-60">·</span>{cwd || '（未打开仓库）'}
            </span>
          </div>
        </div>,
        sidebarEl,
        'terminal-sidebar',
      )
    : null

  return (
    <div className="kb-view-in flex h-full flex-col bg-[var(--bg-primary)]">
      {sidebar}
      {/* 工具栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5">
        <span className="rounded-full border border-[var(--border-color)] bg-[var(--card-bg)] px-2.5 py-0.5 text-[11px] text-[var(--text-secondary)]">
          shell <span className="font-mono text-[var(--text-primary)]">{shellLabel || '…'}</span>
        </span>
        <span className="min-w-0 truncate rounded-full border border-[var(--border-color)] bg-[var(--card-bg)] px-2.5 py-0.5 text-[11px] text-[var(--text-secondary)]">
          cwd <span className="font-mono text-[var(--text-primary)]">{cwd || '（未打开仓库）'}</span>
        </span>
        <span className="flex-1" />
        <button
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
          disabled={showAi || !activeId}
          title="清屏（当前会话）"
          onClick={() => setClearSignal(n => n + 1)}
        ><Eraser size={13} /> 清屏</button>
        {/* 创建入口只在会话条「＋」与左栏，此处不再放第三份 */}
      </div>
      {/* 会话条 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-color)] bg-[var(--bg-primary)] px-2">
        <div className="flex items-center gap-1 overflow-x-auto">
          {sessions.map(s => (
            <div
              key={s.id}
              className={`flex h-6 cursor-pointer items-center gap-1.5 rounded border px-2.5 text-[11.5px] transition-colors ${
                !showAi && s.id === activeId
                  ? 'border-[var(--border-color)] bg-[var(--bg-selected)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
              onClick={() => { setShowAi(false); setActiveId(s.id) }}
            >
              <span className="whitespace-nowrap">{sessName(s)}{s.exited ? '（已结束）' : ''}</span>
              {sessions.length > 1 && (
                <span
                  role="button"
                  tabIndex={-1}
                  className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--terminal-err,#f48771)] hover:text-white"
                  onClick={e => { e.stopPropagation(); void killSession(s.id) }}
                ><X size={10} /></span>
              )}
            </div>
          ))}
        </div>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          title="新建会话"
          onClick={() => void createSession()}
        ><Plus size={13} /></button>
        <div
          className={`ml-1 flex h-6 cursor-pointer items-center gap-1.5 rounded border px-2.5 text-[11.5px] transition-colors ${
            showAi
              ? 'border-[var(--border-color)] bg-[var(--bg-selected)] text-[var(--text-primary)]'
              : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
          }`}
          onClick={() => setShowAi(true)}
        >
          <span className="rounded bg-[var(--terminal-ok,#4ec9b0)]/15 px-1 py-px font-mono text-[10px] text-[var(--terminal-ok,#4ec9b0)]">AI</span>
          AI 执行记录
          {pendingRec && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--terminal-warn,#e5c07b)]" />}
        </div>
        <span className="flex-1" />
        {/* 保活说明按 swap-bar 收进 ⓘ（铁律 12 文案只收不删）：悬停淡入，默认只有一个灰 ⓘ */}
        <div className="group relative flex h-full w-5 shrink-0 items-center justify-center">
          <span className="absolute text-[var(--text-disabled)] transition-opacity duration-300 group-hover:opacity-0">
            <Info size={12} />
          </span>
          <span className="absolute right-1 whitespace-nowrap text-[10.5px] text-[var(--text-disabled)] opacity-0 translate-y-[3px] transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
            会话随 Tab 保活，关闭应用即回收
          </span>
        </div>
      </div>
      {/* 视口：会话 pane 全体常驻（display:none 保活），AI 记录覆盖其上 */}
      <div className="relative min-h-0 flex-1">
        {winPtyReady && (sessions.length === 0 ? (
          // boot 态：pane 量出真实尺寸后回调创建（pty 必须以真实 cols/rows 启动）
          <TerminalPane
            session={null}
            active={!showAi}
            fontSize={fontSize}
            clearSignal={clearSignal}
            windowsPty={winPty}
            booting
            onCreate={d => void createSession(d)}
            onDims={d => { dimsRef.current = d }}
          />
        ) : sessions.map(s => (
          <TerminalPane
            key={s.id}
            session={s}
            active={!showAi && s.id === activeId}
            fontSize={fontSize}
            clearSignal={clearSignal}
            windowsPty={winPty}
            onDims={d => { dimsRef.current = d }}
          />
        )))}
        {showAi && <AiRecordList records={records} onRespond={respond} />}
        {/* 高危命令：严重警告弹窗（铁律 25 允许的唯一中央弹窗形态）；必须显式选择，遮罩不可点 */}
        <ModalShell
          open={!!riskyPending}
          overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
          panelClassName="w-[520px] rounded-xl border border-[var(--terminal-err,#f48771)] bg-[var(--bg-secondary)] p-4"
        >
          <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold text-[var(--terminal-err,#f48771)]">
            严重警告 —— AI 请求执行高危命令
          </div>
          <p className="mb-3 text-[12px] leading-5 text-[var(--text-secondary)]">
            按交互规范，只有这类高危命令才允许弹窗打断。确认后果后再放行。
          </p>
          {riskyPending && (
            <>
              <div className="mb-3 rounded-lg border border-[var(--terminal-err,#f48771)] bg-[var(--bg-primary)] p-3">
                <div className="mb-1 text-[10.5px] text-[var(--text-muted)]">命令 · cwd {riskyPending.cwd}</div>
                <code className="break-all font-mono text-[13px] text-[var(--text-primary)]">{riskyPending.cmd}</code>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  className="rounded-md border border-[var(--border-color)] px-4 py-1.5 text-[12.5px] transition-colors hover:bg-[var(--bg-hover)]"
                  onClick={() => respond(riskyPending.reqId, false)}
                >拒绝</button>
                <button
                  className="rounded-md border border-[var(--terminal-err,#f48771)] px-4 py-1.5 text-[12.5px] text-[var(--terminal-err,#f48771)] transition-colors hover:bg-[var(--terminal-err,#f48771)] hover:text-white"
                  onClick={() => respond(riskyPending.reqId, true)}
                >允许执行</button>
              </div>
            </>
          )}
        </ModalShell>
      </div>
    </div>
  )
}
