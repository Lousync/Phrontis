import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FileText, Loader2 } from 'lucide-react'
import { readerStateGet, readerStatePatch, workspaceReadRange } from '../../../lib/ipc'
import { KB_READER_STATE_CHANGED } from '../pdf/pdfEvents'
import { decodeText } from '../../../lib/textDecode'

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
    <div data-wb="txtReader" className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
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
            {paragraphs.map((p, i) => (
              <p
                key={i}
                data-p={i}
                style={virtualize ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 96px', whiteSpace: 'pre-wrap' } : { whiteSpace: 'pre-wrap' }}
                className="text-[var(--text-primary)]"
              >
                {p}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default TxtReaderView
