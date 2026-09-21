import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, FileText, Loader2 } from 'lucide-react'
import { excerptCreate, excerptList, readerStateGet, readerStatePatch, workspaceReadRange } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { KB_READER_STATE_CHANGED, KB_TXT_GOTO_PARA } from '../pdf/pdfEvents'
import { decodeText } from '../../../lib/textDecode'
import { ExcerptCaptureBar } from './ExcerptCaptureBar'
import type { SelectionRect } from '../pdf/TextSelectionBar'
import type { ExcerptItem, ExcerptColor, ExcerptType } from '../../../types'

/**
 * TXT 阅读器（书架升级全格式阅读器一期，方案 bookshelf-reader-upgrade-design §S5）。
 * 与 PdfReaderView 同构：工具栏（最左「← 返回书架」）+ 内部滚动容器；进度落
 * `.knowbase/modules/readerState.json`（readerStatePatch，expectedUpdatedAt 冲突检测）。
 *
 * - 读取：workspaceReadRange 循环 128KB 累积，上限 20MB（超限只读前 20MB + 顶部提示条）。
 * - 解码：decodeText（零依赖 textDecode.ts，契约脚本直接 import 跑用例）——
 *   BOM（UTF-8/UTF-16LE/BE）→ UTF-8 严格模式 → GB18030 兜底。
 * - 分段：连续空行折叠为段落边界；单段超 4000 字内部再切（DOM 高度可控）。
 * - 虚拟化：段落数 > 300 才加 content-visibility（铁律 11：短列表加估值会把滚动高度抬成数倍）。
 * - 进度：滚动节流 200ms 算 pct + 广播 `kb-reader-state-changed`；防抖 400ms 落盘。
 * - Hook 纪律：所有 hook 声明在任何早退 return 之前（React #310 已三犯）。
 */

const CHUNK = 128 * 1024
const MAX_TXT_BYTES = 20 * 1024 * 1024
const PARA_SPLIT = 4000

interface Props {
  rootId: string
  relPath: string
  name: string
  /** 工具栏最左的返回入口（书架阅读态用） */
  backLabel?: string
  onBack?: () => void
}

export function TxtReaderView({ rootId, relPath, name, backLabel, onBack }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [pct, setPct] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 冲突检测基准（铁律 4）：首拉 readerStateGet 时登记，每次 patch 成功后回写 */
  const expectedUpdatedAtRef = useRef<string | undefined>(undefined)
  /** 恢复滚动只做一次（内容首次布局后） */
  const restoredRef = useRef(false)
  const restorePctRef = useRef(0)
  const throttleRef = useRef(0)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // ===== 摘录（摘录先行批次）：列表 + 划选捕获浮条 =====
  const [excerpts, setExcerpts] = useState<ExcerptItem[]>([])
  const [capture, setCapture] = useState<{ rect: SelectionRect; paraIndex: number; start: number; end: number; text: string } | null>(null)
  /** 右栏摘录跳转落点闪烁 */
  const [flashPara, setFlashPara] = useState<number | null>(null)

  // ===== 加载：进度 + 正文 =====
  useEffect(() => {
    let alive = true
    restoredRef.current = false
    setText(null)
    setLoadErr('')
    setPct(0)
    ;(async () => {
      try {
        const st = await readerStateGet(rootId, relPath)
        if (!alive) return
        if (st.ok && st.state) {
          expectedUpdatedAtRef.current = st.state.updatedAt
          restorePctRef.current = st.state.pct
          setPct(st.state.pct)
        } else {
          expectedUpdatedAtRef.current = undefined
          restorePctRef.current = 0
        }
        // 循环 range 读：128KB 一块，上限 20MB
        const chunks: Uint8Array[] = []
        let total = 0
        let fileSize = Number.POSITIVE_INFINITY
        for (;;) {
          const r = await workspaceReadRange(rootId, relPath, total, CHUNK)
          if (!alive) return
          if (!r || r.error) throw new Error(r?.error ?? '读取失败')
          if (Number.isFinite(fileSize)) fileSize = r.size
          const bin = atob(r.data)
          const u8 = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
          chunks.push(u8)
          total += u8.length
          if (u8.length === 0 || total >= fileSize || total >= MAX_TXT_BYTES) break
        }
        const merged = new Uint8Array(Math.min(total, MAX_TXT_BYTES))
        let filled = 0
        for (const c of chunks) {
          if (filled + c.length > merged.length) {
            merged.set(c.subarray(0, merged.length - filled), filled)
            filled = merged.length
            break
          }
          merged.set(c, filled)
          filled += c.length
        }
        if (!alive) return
        setTruncated(total > MAX_TXT_BYTES)
        setText(decodeText(merged))
      } catch (e) {
        if (!alive) return
        setLoadErr(String((e as Error)?.message || e))
      }
    })()
    return () => { alive = false }
  }, [rootId, relPath])

  // ===== 恢复滚动：正文首次布局后按 pct 反算 scrollTop（只做一次） =====
  useEffect(() => {
    if (text === null || restoredRef.current) return
    const el = scrollRef.current
    if (!el) return
    restoredRef.current = true
    const target = restorePctRef.current
    if (target <= 0) return
    requestAnimationFrame(() => {
      const max = el.scrollHeight - el.clientHeight
      el.scrollTop = Math.round(max * target / 100)
    })
  }, [text])

  /** 内容分段：连续空行折叠为段落边界；超 4000 字再切。段落数据稳定（text 变才重算） */
  const paragraphs = useMemo(() => {
    if (text === null) return [] as string[]
    const lines = text.split(/\r?\n/)
    const out: string[] = []
    let buf: string[] = []
    const flush = () => {
      if (buf.length === 0) return
      const para = buf.join('\n')
      buf = []
      if (para.length <= PARA_SPLIT) {
        out.push(para)
        return
      }
      // 单段超 4000 字：优先在换行处切，无换行硬切
      let rest = para
      while (rest.length > PARA_SPLIT) {
        let cut = rest.lastIndexOf('\n', PARA_SPLIT)
        if (cut < PARA_SPLIT / 2) cut = PARA_SPLIT
        out.push(rest.slice(0, cut))
        rest = rest.slice(cut).replace(/^\n/, '')
      }
      if (rest) out.push(rest)
    }
    for (const line of lines) {
      if (line.trim() === '') { flush(); continue }
      buf.push(line)
    }
    flush()
    return out
  }, [text])

  // ===== 进度落盘 + 广播（滚动节流 200ms 计算，防抖 400ms 落盘） =====
  const persistPct = useCallback((p: number) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      void readerStatePatch(rootId, relPath, { pct: p }, expectedUpdatedAtRef.current).then((r) => {
        if (r.ok && r.state) expectedUpdatedAtRef.current = r.state.updatedAt
      }).catch(() => { /* 落盘失败不打扰阅读 */ })
    }, 400)
  }, [rootId, relPath])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const now = Date.now()
    if (now - throttleRef.current < 200) return
    throttleRef.current = now
    const max = el.scrollHeight - el.clientHeight
    if (max <= 0) return
    setCapture(null)
    const p = Math.min(100, Math.max(0, Math.round(el.scrollTop / max * 100)))
    setPct(p)
    try {
      window.dispatchEvent(new CustomEvent(KB_READER_STATE_CHANGED, { detail: { relPath, kind: 'txt', pct: p } }))
    } catch { /* 广播失败不影响阅读 */ }
    persistPct(p)
  }, [relPath, persistPct])

  // 卸载时把最后一次防抖落盘立即冲掉（避免关书丢尾部进度）
  useEffect(() => () => {
    if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null }
  }, [])

  // ===== 摘录列表：挂载/换书拉一次 + excerpt 广播刷新（右栏增删/改备注实时反映为高亮增删） =====
  useEffect(() => {
    let alive = true
    setExcerpts([])
    setCapture(null)
    if (!rootId) return
    void excerptList(rootId, relPath).then((r) => {
      if (alive && r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 摘录读取失败不阻塞阅读 */ })
    return () => { alive = false }
  }, [rootId, relPath])
  useDataChanged('excerpt', () => {
    if (!rootId) return
    void excerptList(rootId, relPath).then((r) => {
      if (r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 忽略 */ })
  })

  /** 段落 → 高亮区间表（txt 摘录且有偏移才参与；重叠区间后来者截断） */
  const highlightMap = useMemo(() => {
    const map = new Map<number, Array<{ start: number; end: number; id: string; note: string; color: ExcerptColor }>>()
    for (const e of excerpts) {
      if (e.kind !== 'txt' || typeof e.paraIndex !== 'number' || typeof e.start !== 'number' || typeof e.end !== 'number') continue
      const arr = map.get(e.paraIndex) ?? []
      arr.push({ start: e.start, end: e.end, id: e.id, note: e.note, color: e.color })
      map.set(e.paraIndex, arr)
    }
    return map
  }, [excerpts])

  // ===== 右栏摘录跳段：滚到段落并闪烁提示 =====
  useEffect(() => {
    const onGoto = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; paraIndex?: number }
      if (d?.relPath !== relPath || typeof d.paraIndex !== 'number') return
      const el = scrollRef.current?.querySelector(`p[data-p="${d.paraIndex}"]`)
      el?.scrollIntoView({ block: 'center' })
      setFlashPara(d.paraIndex)
      setTimeout(() => setFlashPara((cur) => (cur === d.paraIndex ? null : cur)), 1200)
    }
    window.addEventListener(KB_TXT_GOTO_PARA, onGoto)
    return () => window.removeEventListener(KB_TXT_GOTO_PARA, onGoto)
  }, [relPath])

  // ===== 划选捕获（原生 document mouseup——原生监听不受 React 合成事件限制） =====
  useEffect(() => {
    const onUp = () => {
      setTimeout(() => {
        const root = scrollRef.current
        const sel = window.getSelection()
        if (!root || !sel || sel.isCollapsed || sel.rangeCount !== 1) { setCapture(null); return }
        const range = sel.getRangeAt(0)
        const anc = range.commonAncestorContainer
        const pEl = (anc.nodeType === 3 ? anc.parentElement : anc as HTMLElement)?.closest?.('p[data-p]')
        if (!pEl || !root.contains(pEl)) { setCapture(null); return }
        const paraIndex = Number(pEl.getAttribute('data-p'))
        // 段内偏移：遍历段落文本节点累计前缀长度（<mark> 切分后 textContent 不变，口径稳定）
        const walker = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT)
        let pos = 0
        let start = -1
        let end = -1
        let node: Node | null
        while ((node = walker.nextNode())) {
          const len = (node as Text).data.length
          if (node === range.startContainer) start = pos + range.startOffset
          if (node === range.endContainer) end = pos + range.endOffset
          pos += len
        }
        if (start < 0 || end < 0) { setCapture(null); return }
        if (start > end) { const t = start; start = end; end = t }
        if (end - start < 1) { setCapture(null); return }
        const text = (pEl.textContent ?? '').slice(start, end)
        if (!text.trim()) { setCapture(null); return }
        const r = range.getBoundingClientRect()
        setCapture({ rect: { left: r.left, top: r.top, width: r.width, height: r.height }, paraIndex, start, end, text })
      }, 0)
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [])

  const handleCreateExcerpt = useCallback((text: string, color: ExcerptColor, type: ExcerptType, note?: string) => {
    if (!capture || !rootId) return
    void excerptCreate(rootId, relPath, {
      kind: 'txt',
      text,
      paraIndex: capture.paraIndex,
      start: capture.start,
      end: capture.end,
      color,
      type,
      note,
    }).catch(() => { /* 创建失败不打扰阅读 */ })
    setCapture(null)
    window.getSelection()?.removeAllRanges()
  }, [capture, rootId, relPath])

  const virtualize = paragraphs.length > 300

  // ===== 渲染（无早退分支——hook 全部在上方） =====
  const toolbar = (
    <div className="kb-fit kb-fit-pdfread flex shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] text-[var(--text-secondary)]">
      {onBack && (
        <>
          <button onClick={onBack} title={backLabel ?? '返回书架'}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ArrowLeft size={13} /><span className="kb-l1">{backLabel ?? '返回书架'}</span>
          </button>
          <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
        </>
      )}
      <FileText size={13} className="text-[var(--text-tertiary)]" />
      <span className="max-w-[220px] truncate text-[var(--text-primary)]">{name}</span>
      <span className="kb-l3 text-[var(--text-tertiary)]">TXT</span>
      <div className="min-w-0 flex-1" />
      <span className="shrink-0 text-[var(--text-tertiary)]" data-wb="txtPct">{pct}%</span>
    </div>
  )

  return (
    <div data-wb="txtReader" data-sel-float-ignore className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
      {toolbar}
      {truncated && (
        <div className="shrink-0 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-1 text-[11px] text-[var(--text-tertiary)]">
          文件较大，仅加载前 20MB
        </div>
      )}
      {loadErr ? (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-[var(--text-muted)]">{loadErr}</div>
      ) : text === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={22} className="animate-spin text-[var(--accent)]" />
        </div>
      ) : (
        <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[700px] px-6 py-8" style={{ fontFamily: "'Georgia', 'Noto Serif SC', 'Source Han Serif SC', serif", fontSize: 19, lineHeight: 2.05, textAlign: 'justify' }}>
            {paragraphs.map((p, i) => {
              // 高亮分段：摘录区间内包 <mark>（区间来自 excerpt start/end；重叠由构建端按序截断）
              const marks = (highlightMap.get(i) ?? []).filter((m) => m.start < p.length)
              let rendered: ReactNode = p
              if (marks.length > 0) {
                const segs: ReactNode[] = []
                let cur = 0
                for (const m of marks) {
                  if (m.start < cur) continue
                  if (m.start > cur) segs.push(<span key={`s${cur}`}>{p.slice(cur, m.start)}</span>)
                  const segText = p.slice(m.start, Math.min(m.end, p.length))
                  segs.push(
                    <mark key={m.id} data-eid={m.id} data-ehc={m.color} title={m.note || undefined}
                      className={`kb-exc-${m.color} rounded-sm px-0.5 text-[var(--text-primary)]`}>
                      {segText}
                    </mark>,
                  )
                  cur = Math.min(m.end, p.length)
                }
                if (cur < p.length) segs.push(<span key={`s${cur}`}>{p.slice(cur)}</span>)
                rendered = segs
              }
              return (
                <p
                  key={i}
                  data-p={i}
                  style={virtualize ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 96px', whiteSpace: 'pre-wrap' } : { whiteSpace: 'pre-wrap' }}
                  className={`text-[var(--text-primary)] transition-colors ${flashPara === i ? 'rounded bg-[var(--accent)]/10' : ''}`}
                >
                  {rendered}
                </p>
              )
            })}
          </div>
        </div>
      )}
      {capture && (
        <ExcerptCaptureBar
          rect={capture.rect}
          text={capture.text}
          onCreate={handleCreateExcerpt}
          onAsk={(t) => { window.dispatchEvent(new CustomEvent('ai-assistant:selection-action', { detail: { action: 'ask', text: t } })); setCapture(null); window.getSelection()?.removeAllRanges() }}
          onTranslate={(t, r) => {
            window.dispatchEvent(new CustomEvent('ai-assistant:selection-action', { detail: { action: 'translate', text: t, rect: { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height } } }))
            setCapture(null)
            window.getSelection()?.removeAllRanges()
          }}
          onClose={() => setCapture(null)}
        />
      )}
    </div>
  )
}

export default TxtReaderView
