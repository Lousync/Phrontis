/**
 * 网页素材「展开网页」对话框（.claude/plans/ai-teaching-web-source-crawl.md P3）
 *
 * 三形态：portal（门户选锚点）→ toc（章节勾选+搜索+分组）/ article（单篇确认）→ 抓取进度 → 汇总/重试。
 * 反馈走 showToast（项目规范禁 alert/confirm）；进度由主进程事件驱动不轮询；取消即时。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Globe, Loader2, X, Search, Square, RotateCcw } from 'lucide-react'
import type { WebProbeResult, WebCrawlChapter, WebCrawlResult } from '../../../types'
import { aiTeachSrcWebProbe, aiTeachSrcWebCrawl, aiTeachSrcWebCancel, onAiTeachWebProgress } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'

interface Props {
  sessionId: string
  entry: { no: number; name: string; path: string }
  onClose: () => void
  /** 抓取有产出时回调（父级刷新素材列表） */
  onDone: (result: WebCrawlResult) => void
}

type Phase = 'probing' | 'portal' | 'toc' | 'article' | 'crawling' | 'done'

export function WebSourceDialog({ sessionId, entry, onClose, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('probing')
  const [probe, setProbe] = useState<WebProbeResult | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [result, setResult] = useState<WebCrawlResult | null>(null)
  const [error, setError] = useState('')

  const doProbe = useCallback(async (anchorUrl?: string) => {
    setPhase('probing'); setError('')
    const r = await aiTeachSrcWebProbe(sessionId, entry.no, anchorUrl).catch(e => ({ ok: false, error: (e as Error).message } as WebProbeResult))
    if (!r.ok) { setError(r.error ?? '探测失败'); return }
    setProbe(r)
    if (r.kind === 'portal') { setPhase('portal'); return }
    if (r.kind === 'article') { setPhase('article'); return }
    setChecked(new Set((r.chapters ?? []).filter(c => c.defaultChecked).map(c => c.url)))
    setPhase('toc')
  }, [sessionId, entry.no])

  useEffect(() => { void doProbe() }, [doProbe])

  // 进度事件（只认本条目）
  useEffect(() => {
    const off = onAiTeachWebProgress(p => {
      if (p.sessionId !== sessionId || p.no !== entry.no) return
      setProgress({ done: p.done, total: p.total, current: p.current })
    })
    return off
  }, [sessionId, entry.no])

  const startCrawl = useCallback(async (urls: string[], label: string) => {
    if (urls.length === 0) { showToast({ type: 'warning', message: '没有选中的页面' }); return }
    setPhase('crawling'); setProgress({ done: 0, total: urls.length, current: label })
    const r = await aiTeachSrcWebCrawl(sessionId, entry.no, urls).catch(e => ({ ok: false, error: (e as Error).message } as WebCrawlResult))
    setResult(r)
    setPhase('done')
    if (!r.ok) showToast({ type: 'error', message: `抓取失败：${r.error ?? ''}` })
    else showToast({ type: 'info', message: ` 抓取完成：成功 ${r.done ?? 0} · 跳过 ${r.skipped ?? 0} · 失败 ${(r.failed ?? []).length}` })
    if (r.ok && (r.done ?? 0) + (r.skipped ?? 0) > 0) onDone(r)
  }, [sessionId, entry.no, onDone])

  const groups = useMemo(() => {
    const list = (probe?.chapters ?? []).filter(c => !query.trim() || c.title.toLowerCase().includes(query.trim().toLowerCase()) || c.url.toLowerCase().includes(query.trim().toLowerCase()))
    const map = new Map<string, WebCrawlChapter[]>()
    for (const c of list) { const g = c.group || ''; if (!map.has(g)) map.set(g, []); map.get(g)!.push(c) }
    return [...map.entries()]
  }, [probe, query])
  const visibleUrls = groups.flatMap(([, cs]) => cs.map(c => c.url))
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="fixed inset-0 z-[130] bg-black/45 flex items-center justify-center kb-overlay" onClick={phase === 'crawling' ? undefined : onClose}>
      <div className="w-[560px] max-h-[78vh] flex flex-col bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* 头 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-color)] shrink-0">
          <Globe size={14} className="text-[var(--accent)] shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">展开网页 · {entry.name}</div>
            <div className="text-[10.5px] text-[var(--text-muted)] truncate">{probe?.anchor ?? entry.path}</div>
          </div>
          {phase === 'crawling'
            ? <button onClick={() => { void aiTeachSrcWebCancel(sessionId) }} className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--text-secondary)] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] transition-colors"><Square size={10} />停止</button>
            : <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors" data-tip="关闭" aria-label="关闭"><X size={14} /></button>}
        </div>

        {/* 体 */}
        <div className="flex-1 overflow-y-auto">
          {phase === 'probing' && (
            <div className="flex items-center gap-2 px-4 py-8 justify-center text-[12px] text-[var(--text-muted)]"><Loader2 size={13} className="animate-spin" /> 探测页面结构（零 token，纯程序）…</div>
          )}
          {error && phase !== 'crawling' && (
            <div className="m-4 px-3 py-2 rounded-lg border border-red-400/40 bg-red-400/10 text-[11.5px] text-red-400 leading-relaxed">
              {error}
              <button onClick={() => void doProbe()} className="ml-2 underline underline-offset-2 hover:opacity-80">重试</button>
            </div>
          )}
          {phase === 'portal' && (
            <div className="px-4 py-3">
              <div className="text-[11.5px] text-[var(--text-secondary)] mb-2">这是门户/导航页，选择一个教程入口继续：</div>
              <div className="rounded-lg border border-[var(--border-color)] divide-y divide-[var(--border-color)] overflow-hidden">
                {(probe?.candidates ?? []).map(c => (
                  <button key={c.url} onClick={() => void doProbe(c.url)} className="w-full text-left px-3 py-2 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors truncate" data-tip={c.url} aria-label={c.url}>
                    {c.title} <span className="text-[10px] text-[var(--text-muted)]">{c.url}</span>
                  </button>
                ))}
                {(probe?.candidates ?? []).length === 0 && <div className="px-3 py-3 text-[11.5px] text-[var(--text-muted)]">没找到教程入口候选，请直接把素材路径改成教程目录页再展开。</div>}
              </div>
            </div>
          )}
          {phase === 'article' && (
            <div className="px-4 py-5 text-[12px] text-[var(--text-secondary)] leading-relaxed">
              检测到<b className="text-[var(--text-primary)]">单篇文章</b>（非目录页）。将抓取为提取稿（Defuddle 正文清洗，可直接编辑修正）：
              <div className="mt-3 flex gap-2">
                <button onClick={() => void startCrawl([probe?.anchor ?? entry.path], entry.name)} className="px-4 py-1.5 rounded-md text-[12px] font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors">抓取此页</button>
                <button onClick={onClose} className="px-4 py-1.5 rounded-md text-[12px] text-[var(--text-secondary)] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
              </div>
            </div>
          )}
          {phase === 'toc' && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border-color)] shrink-0">
                <div className="relative flex-1 min-w-0">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`搜索 ${probe?.chapters?.length ?? 0} 章…`} className="w-full pl-7 pr-2 py-1 rounded-md bg-[var(--input-bg)] border border-[var(--border-color)] text-[11.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                </div>
                <button onClick={() => setChecked(prev => new Set([...prev, ...visibleUrls]))} className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0">全选可见</button>
                <button onClick={() => setChecked(prev => { const n = new Set(prev); for (const u of visibleUrls) { if (n.has(u)) n.delete(u); else n.add(u) } return n })} className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0">反选</button>
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                {groups.map(([g, cs]) => (
                  <div key={g || 'default'}>
                    {g && <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{g}</div>}
                    {cs.map(c => (
                      <label key={c.url} className="flex items-center gap-2 px-4 py-1 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors">
                        <input type="checkbox" checked={checked.has(c.url)} className="accent-[var(--accent)]"
                          onChange={() => setChecked(prev => { const n = new Set(prev); if (n.has(c.url)) n.delete(c.url); else n.add(c.url); return n })} />
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-primary)]" data-tip={c.url} aria-label={c.url}>{c.title}</span>
                      </label>
                    ))}
                  </div>
                ))}
                {groups.length === 0 && <div className="px-4 py-6 text-center text-[11.5px] text-[var(--text-muted)]">无匹配章节</div>}
              </div>
              <div className="px-4 py-2.5 border-t border-[var(--border-color)] shrink-0">
                <button onClick={() => void startCrawl((probe?.chapters ?? []).filter(c => checked.has(c.url)).map(c => c.url), entry.name)}
                  disabled={checked.size === 0}
                  className="w-full py-2 rounded-md text-[12.5px] font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
                  开始抓取（{checked.size} 章 · 零 token 纯程序流水线）
                </button>
              </div>
            </div>
          )}
          {phase === 'crawling' && progress && (
            <div className="px-4 py-6">
              <div className="flex items-center justify-between text-[11.5px] text-[var(--text-secondary)] mb-2">
                <span className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />正在抓取 {progress.done + 1}/{progress.total}…</span>
                <span>{pct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-[var(--bg-primary)] overflow-hidden"><div className="h-full bg-[var(--accent)] transition-all duration-300" style={{ width: `${pct}%` }} /></div>
              <div className="mt-2 text-[10.5px] text-[var(--text-muted)] truncate">当前：{progress.current}</div>
              <div className="mt-1 text-[10.5px] text-[var(--text-muted)]">已存在章节自动跳过（断点续抓）；停止后重开可继续。</div>
            </div>
          )}
          {phase === 'done' && result && (
            <div className="px-4 py-3 text-[11.5px]">
              {result.ok ? (
                <>
                  <div className="text-[var(--text-primary)] mb-1">完成：成功 <b className="text-[var(--accent)]">{result.done ?? 0}</b> · 跳过 {result.skipped ?? 0} · 失败 {(result.failed ?? []).length}</div>
                  <div className="text-[var(--text-muted)] mb-2">落盘 <code className="px-1 rounded bg-[var(--bg-primary)]">{result.dirRel}</code>（00-目录.md + 每章一文件，可编辑）</div>
                  {(result.failed ?? []).length > 0 && (
                    <div className="rounded-lg border border-[var(--border-color)] divide-y divide-[var(--border-color)] overflow-hidden max-h-44 overflow-y-auto">
                      {result.failed!.map(f => (
                        <div key={f.url} className="flex items-center gap-2 px-3 py-1.5">
                          <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]" data-tip={`${f.url}\n${f.reason}`} aria-label={`${f.url}\n${f.reason}`}>{f.title || f.url} <span className="text-[10px] text-[var(--text-muted)]">— {f.reason}</span></span>
                        </div>
                      ))}
                      <div className="px-3 py-2">
                        <button onClick={() => void startCrawl(result.failed!.filter(f => /^https?:/.test(f.url)).map(f => f.url), '重试失败项')} className="flex items-center gap-1 px-3 py-1 rounded-md text-[11px] text-[var(--text-secondary)] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] transition-colors">
                          <RotateCcw size={10} />重试失败项（{result.failed!.filter(f => /^https?:/.test(f.url)).length}）
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-red-400">抓取失败：{result.error}</div>
              )}
              <div className="mt-3 text-right"><button onClick={onClose} className="px-4 py-1.5 rounded-md text-[12px] text-[var(--text-primary)] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] transition-colors">关闭</button></div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
