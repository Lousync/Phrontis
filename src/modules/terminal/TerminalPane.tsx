/**
 * 终端单会话的 xterm 宿主（docs/terminal-module-design.md §2）。
 *
 * 生命周期（v2，修 ConPTY 重印乱码）：
 *  1. 挂载即建 xterm 并 fit 出**真实 cols/rows**；无会话时（boot pane）先把尺寸报给模块，
 *     由模块以真实尺寸创建 pty —— 严禁先 80×24 起进程再 resize：ConPTY 会全屏重印，
 *     与 PSReadLine（5.1 自带 2.0，CJK 宽字符宽度跟踪有 bug）叠加产生重复字符垃圾
 *     （xtermjs#2798/#2459、PSReadLine#779；官方口径：spawn 前对齐尺寸 + resize 去抖）。
 *  2. 有会话时 attach 回放 backlog；live 数据在 attach 快照回放完成前排队的，回放后按序 flush。
 *  3. resize 只在 cols/rows 真变化时发，且 120ms 去抖。
 * 会话真源在主进程：本组件卸载/重挂不杀 pty，只重放 backlog。
 */
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css' // ★ 没有它：字符测量元素可见（boot 屏 >>>> 乱码行）、光标/行布局/反色全坏
import * as ipc from '../../lib/ipc'
import type { TerminalSessionInfo } from '../../types'

/** sRGB 相对亮度（0-1）：终端配色以背景亮度自动选黑/白字，保证任意主题下都有对比 */
function hexLuminance(hex: string): number {
  const m = hex.trim().replace('#', '')
  const n = m.length === 3 ? m.split('').map(c => c + c).join('') : m
  if (n.length < 6) return 0
  const f = (c: string) => {
    const v = parseInt(c, 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(n.slice(0, 2)) + 0.7152 * f(n.slice(2, 4)) + 0.0722 * f(n.slice(4, 6))
}

/**
 * 跟随应用主题的 xterm 配色。★ 对比度硬保证：前景不直接取 --text-primary
 * （自定义主题可能没定义它，落到浅色兜底 = 浅底浅字），而是按背景亮度二选一：
 * 浅底 → 深字，深底 → 浅字。主题切换由 MutationObserver 监听 html 的 class 变化重算
 * （本应用的主题机制是 html.theme-<id>，不是 data-theme）。
 */
function readXtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fb: string) => (cs.getPropertyValue(name).trim() || fb)
  const bg = v('--bg-primary', '#1e1e1e')
  const light = hexLuminance(bg) > 0.4
  return {
    background: bg,
    foreground: light ? '#1f2328' : '#d4d4d4',
    cursor: light ? '#005fb8' : '#4fc1ff',
    cursorAccent: bg,
    selectionBackground: light ? '#add6ff' : '#094771',
    black: light ? '#3b3b3b' : '#000000',
    brightBlack: light ? '#8a8a8a' : '#666666',
    white: light ? '#5a5a5a' : '#e5e5e5',
    brightWhite: light ? '#1f1f1f' : '#ffffff',
    red: '#c7384a',
    green: '#14934a',
    yellow: '#9a6700',
    blue: '#1f6fd0',
    magenta: '#a133a8',
    cyan: '#0e7c94',
    brightRed: '#e35555',
    brightGreen: '#23d18b',
    brightYellow: '#d7a92c',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
  }
}

export interface TerminalDims { cols: number; rows: number }

/** xterm 的 ConPTY 兼容开关（VS Code 在 Windows 上必设）：告知对端是 ConPTY，
 *  xterm 换用 ConPTY 兼容的 BufferLine 实现，否则空单元格/宽字符怪癖会画成乱码。 */
export interface TerminalWinPty { backend: 'conpty'; buildNumber: number }

interface Props {
  /** null = boot 态：只量尺寸并回调 onCreate，由模块以真实尺寸创建会话 */
  session: TerminalSessionInfo | null
  active: boolean
  fontSize: number
  /** 自增信号：变化且本会话处于激活态时清屏 */
  clearSignal: number
  /** Windows ConPTY 兼容选项（来自主进程 windowsBuildNumber()，晚于首挂到达时走 options 更新） */
  windowsPty?: TerminalWinPty
  /** boot 态首次量得真实尺寸时回调（模块据此创建 pty，带真实 cols/rows） */
  onCreate?: (dims: TerminalDims) => void
  /** 每次量得尺寸上报（模块为后续「新建会话」取最新尺寸） */
  onDims?: (dims: TerminalDims) => void
  /** 仅 boot 态：量得尺寸到创建 pty 之间容器仍是空的，给个占位提示 */
  booting?: boolean
}

const RESIZE_DEBOUNCE_MS = 120

export default function TerminalPane({ session, active, fontSize, clearSignal, windowsPty, onCreate, onDims, booting }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastClearRef = useRef(clearSignal)
  // 回调经 ref 转发：挂载 effect 只跑一次，不因回调身份变化重建 Terminal
  const cbRef = useRef({ onCreate, onDims })
  cbRef.current = { onCreate, onDims }
  const sessionRef = useRef<TerminalSessionInfo | null>(session)
  const attachedIdRef = useRef<string | null>(null)
  const createRequestedRef = useRef(false)
  const lastSentSizeRef = useRef('')
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ===== 挂载：建 Terminal + fit + 观察者（一次） =====
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontSize,
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
      cursorBlink: true,
      scrollback: 3000,
      theme: readXtermTheme(),
      ...(windowsPty ? { windowsPty } : {}),
    })
    // F-9：Ctrl+B 交回工作台（收展左栏）——xterm 不处理该键，也就不会作为 ^B 透传给 shell；
    // 事件继续冒泡到 window 的 Ctrl+B 处理器（该处理器对 .xterm 显式豁免 isEditingInput）。
    term.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b'))
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    // 诊断暴露：终端输入链路排查用（探针 probe-terminal-ui* 读 __kbTerm）
    ;(window as unknown as { __kbTerm?: unknown }).__kbTerm = term

    const sendResize = (cols: number, rows: number) => {
      const cur = sessionRef.current
      if (!cur) return
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        // 变更门放在**去抖回调里**（fire 时再查）：schedule 到 fire 之间基线可能才就位，
        // 否则启动期的等值 resize 会溜出去触发一次 ConPTY 重绘（boot 屏乱码来源之一）
        const key = `${cols}x${rows}`
        if (key === lastSentSizeRef.current) return
        lastSentSizeRef.current = key
        ipc.termResize(cur.id, cols, rows)
      }, RESIZE_DEBOUNCE_MS)
    }
    const measure = () => {
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return // 隐藏态不可量尺寸
      try { fit.fit() } catch { return }
      cbRef.current.onDims?.({ cols: term.cols, rows: term.rows })
      if (!sessionRef.current && !createRequestedRef.current && term.cols >= 4 && term.rows >= 3) {
        createRequestedRef.current = true
        cbRef.current.onCreate?.({ cols: term.cols, rows: term.rows })
      }
      if (sessionRef.current) {
        const key = `${term.cols}x${term.rows}`
        if (!lastSentSizeRef.current) {
          // 首测即基线：pty 本就以当前视口尺寸创建，等值 resize 不发
          lastSentSizeRef.current = key
        } else {
          sendResize(term.cols, term.rows)
        }
      }
    }
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    measure()
    const themeMo = new MutationObserver(() => { term.options.theme = readXtermTheme() })
    // 本应用主题切换 = html.theme-<id> class 翻转（不是 data-theme），class 必须在监听列表里
    themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    return () => {
      ro.disconnect()
      themeMo.disconnect()
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // fontSize 走独立 effect；回调经 cbRef 转发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 会话到达：attach 回放 + 订阅 live 数据（快照回放期间到达的先排队，回放后按序 flush） =====
  useEffect(() => {
    sessionRef.current = session
    if (!session || attachedIdRef.current === session.id) return
    attachedIdRef.current = session.id
    const term = termRef.current
    if (!term) return
    // ★ 键盘上行：xterm onData → pty（v2 重写时曾丢失这行 = 终端无法输入的根因）
    term.onData(data => {
      // 诊断钩子： onData 是否 fire（探针 probe-terminal-ui* 读 __kbTermDbg）
      const w = window as unknown as { __kbTermDbg?: { fired: number; last: string; sid: string; at: number } }
      w.__kbTermDbg = { fired: (w.__kbTermDbg?.fired ?? 0) + 1, last: data.slice(0, 20), sid: session.id.slice(0, 8), at: Date.now() }
      ipc.termWrite(session.id, data)
    })
    const queue: string[] = []
    let snapshotDone = false
    const offData = ipc.onTermData(({ id, data }) => {
      if (id !== session.id) return
      if (!snapshotDone) { queue.push(data); return }
      termRef.current?.write(data)
    })
    void ipc.termAttach(session.id)
      .then(r => { if (r?.backlog) term.write(r.backlog) })
      .catch(() => { /* 会话已不存在 */ })
      .finally(() => {
        snapshotDone = true
        for (const d of queue.splice(0)) termRef.current?.write(d)
      })
    return () => { offData() }
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    requestAnimationFrame(() => { try { fitRef.current?.fit() } catch { /* 隐藏态 */ } })
  }, [fontSize])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try { fitRef.current?.fit() } catch { /* 隐藏态 */ }
      termRef.current?.focus()
      termRef.current?.scrollToBottom()
    })
  }, [active])

  useEffect(() => {
    if (clearSignal === lastClearRef.current) return
    lastClearRef.current = clearSignal
    if (active) termRef.current?.clear()
  }, [clearSignal, active])

  return (
    <div
      className={active ? 'absolute inset-0 overflow-hidden' : 'hidden'}
      onClick={() => { if (active) termRef.current?.focus() }}
    >
      <div ref={hostRef} className="h-full w-full px-2 py-1" />
      {session?.exited && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)]/70">
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--card-bg)] px-4 py-3 text-center text-[12px] text-[var(--text-secondary)]">
            会话已结束{session.exitCode != null && session.exitCode !== 0 ? `（退出码 ${session.exitCode}）` : ''}
            <div className="mt-1 text-[11px] text-[var(--text-muted)]">用工具栏「新建会话」开一个新终端</div>
          </div>
        </div>
      )}
      {!session && booting && (
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-6">
          <span className="text-[11.5px] text-[var(--text-muted)]">正在启动 shell…</span>
        </div>
      )}
    </div>
  )
}
