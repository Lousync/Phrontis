import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Languages, RefreshCw } from 'lucide-react'
import type { VocabDayRecord, VocabSessionInput } from '../../types'
import { vocabGetDay, vocabRecordSession } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { useDataChanged } from '../../lib/dataChanged'
import { registerAssistantContext } from '../../lib/assistantContext'

/**
 * 背单词模块（v3.17.0）。
 *
 * 形态：工作台内模块（左栏书签进），中央整块 iframe 加载 qwerty-learner 静态构建产物。
 * 数据：iframe 自己的 Dexie/IndexedDB 存明细；每章结束 / pagehide 经 postMessage 上报
 * 会话摘要，宿主写入 Vault（.knowbase/modules/vocab/days/YYYY-MM-DD.json），供 AI 造句复习。
 *
 * 为什么用 iframe 而不是原生移植：上游是 React 18 + Tailwind 3 + jotai + Dexie + react-router，
 * 与主仓 React 19 + Tailwind 4 直接混编的改造成本远高于「独立 origin + 协议承载」。
 * iframe 加 allow-same-origin 只为让 qwerty-learner 的 IndexedDB/localStorage 可用；
 * vocab:// 与宿主不同源，脚本碰不到主窗口 DOM。
 */

const CHANNEL = 'phrontis-vocab'

function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function isDark(): boolean {
  // Phrontis 用 theme-dark / theme-light 类（不是 Tailwind 的 dark 类）
  return document.documentElement.classList.contains('theme-dark')
}

function makeNonce(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* 老 Chromium / 非安全上下文兜底 */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function VocabSidebar({ day, onRefresh }: { day: VocabDayRecord | null; onRefresh: () => void }) {
  const words = day?.words ?? []
  return (
    <div className="flex h-full min-h-0 flex-col" data-wb="vocabSidebar">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3">
        <Languages size={14} className="text-[var(--accent)]" />
        <span className="text-[12.5px] font-medium text-[var(--text-primary)]">今日词表</span>
        <span className="ml-auto text-[11px] tabular-nums text-[var(--text-muted)]">{words.length}</span>
        <button
          onClick={onRefresh}
          className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          data-tip="刷新今日词表" aria-label="刷新今日词表"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {words.length === 0 ? (
          <div className="px-2 py-3 text-[12px] leading-5 text-[var(--text-muted)]">
            今天还没有背诵记录。完成一章后会自动出现在这里。
          </div>
        ) : (
          words.map((w) => (
            <div key={`${w.dict}:${w.word}`} className="rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--bg-hover)]">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{w.word}</span>
                {w.wrongCount > 0 && (
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-[var(--money-out,#e06c4f)]">错 {w.wrongCount}</span>
                )}
              </div>
              <div className="truncate text-[11px] text-[var(--text-muted)]">{w.trans || '—'}</div>
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--border-color)] px-3 py-2 text-[11px] leading-4 text-[var(--text-muted)]">
        AI 造句：在全局助手里说「用今天背的单词造句复习」。
      </div>
    </div>
  )
}

export function VocabModule({ isActive = true, sidebarEl = null }: {
  isActive?: boolean
  sidebarEl?: HTMLElement | null
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const nonceRef = useRef<string>(makeNonce())
  const dayRef = useRef<VocabDayRecord | null>(null)
  const [day, setDay] = useState<VocabDayRecord | null>(null)
  const [ready, setReady] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [reloadSeq, setReloadSeq] = useState(0)

  const src = useMemo(
    () => `vocab://app/index.html?embed=1&nonce=${encodeURIComponent(nonceRef.current)}&theme=${isDark() ? 'dark' : 'light'}&r=${reloadSeq}`,
    [reloadSeq],
  )

  const refresh = useCallback(async () => {
    try {
      const next = await vocabGetDay(todayLocal())
      dayRef.current = next
      setDay(next)
      return next
    } catch {
      return null
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useDataChanged('vocab', () => { void refresh() })

  // 给全局 AI 助手「边看边问」的今日词表上下文（仅模块激活时注册，避免覆盖其它模块的上下文）
  useEffect(() => {
    if (!isActive) return
    return registerAssistantContext(() => {
      const d = dayRef.current
      if (!d || d.words.length === 0) return null
      return {
        type: 'vocab.today',
        label: `今日背单词 ${d.words.length} 个`,
        data: {
          date: d.date,
          words: d.words.slice(0, 50).map((w) => ({
            word: w.word,
            trans: w.trans,
            phonetic: w.phonetic,
            dict: w.dict,
            chapter: w.chapter,
            correctCount: w.correctCount,
            wrongCount: w.wrongCount,
          })),
          sessions: d.sessions.map((s) => ({
            dict: s.dict,
            chapter: s.chapter,
            wordCount: s.wordCount,
            correctCount: s.correctCount,
            wrongCount: s.wrongCount,
          })),
        },
      }
    })
  }, [isActive])

  // 宿主 → iframe：初始化 / 日数据 / 主题
  const send = useCallback((type: string, payload?: unknown) => {
    iframeRef.current?.contentWindow?.postMessage({ channel: CHANNEL, v: 1, type, payload }, '*')
  }, [])

  // iframe → 宿主：ready / session
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const d = e.data as
        | { channel?: string; v?: number; nonce?: string; type?: string; payload?: unknown }
        | undefined
      if (!d || d.channel !== CHANNEL || d.nonce !== nonceRef.current) return

      if (d.type === 'ready') {
        setReady(true)
        setTimedOut(false)
        send('init', { dark: isDark(), day: dayRef.current })
        return
      }

      if (d.type === 'session') {
        const input = (d.payload as { session?: VocabSessionInput } | undefined)?.session
        if (!input) return
        try {
          const next = await vocabRecordSession(input)
          dayRef.current = next
          setDay(next)
          send('day', next)
        } catch (err) {
          showToast({
            type: 'error',
            message: '背单词记录保存失败',
            detail: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [send])

  // 主题切换跟随宿主（qwerty-learner 内部也允许用户自己切）
  useEffect(() => {
    const obs = new MutationObserver(() => send('theme', { dark: isDark() }))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [send])

  // 构建产物缺失时给一个可操作的提示，而不是永远白屏
  useEffect(() => {
    if (ready) return
    const t = window.setTimeout(() => setTimedOut(true), 8000)
    return () => window.clearTimeout(t)
  }, [ready])

  const sidebarInner = <VocabSidebar day={day} onRefresh={() => { void refresh() }} />
  const sidebarNode = sidebarEl ? createPortal(sidebarInner, sidebarEl) : null

  return (
    <div className="flex h-full min-h-0 w-full">
      {sidebarNode}
      <div className="relative flex h-full min-h-0 flex-1 flex-col bg-[var(--bg-primary)]" data-wb="vocab">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3 text-[11.5px] text-[var(--text-muted)]">
        <Languages size={14} className="text-[var(--accent)]" />
        <span className="font-medium">背单词</span>
        <span className="text-[var(--text-disabled)]">qwerty-learner</span>
        <div className="flex-1" />
        <button
          onClick={() => { setReady(false); setTimedOut(false); setReloadSeq((n) => n + 1); void refresh() }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          data-tip="重新加载" aria-label="重新加载"
        >
          <RefreshCw size={12} />
          刷新
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <iframe
          ref={iframeRef}
          title="背单词"
          src={src}
          className="h-full w-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          allow="clipboard-write"
        />

        {!ready && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)]/80">
            <div className="max-w-md rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-5 py-4 text-center shadow-sm">
              <div className="text-[13px] font-medium text-[var(--text-primary)]">正在加载背单词…</div>
              {timedOut ? (
                <div className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">
                  加载超时。请先在仓库根执行
                  <code className="mx-1 rounded bg-[var(--bg-hover)] px-1 py-0.5 text-[11px]">npm run build:vocab</code>
                  生成 resources/vocab 后再试。
                </div>
              ) : (
                <div className="mt-2 text-[12px] text-[var(--text-muted)]">首次加载需要几秒</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* isActive 仅用于保活语义：模块切走后 iframe 仍挂载，回来不丢当前章节 */}
      <span className="hidden" data-active={isActive ? '1' : '0'} />
      </div>
    </div>
  )
}
