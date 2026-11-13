import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X, Copy, Check, Loader2, Sparkles, BookOpen, Languages, Volume2 } from 'lucide-react'
import { showToast } from '../../../lib/toast'
import { speak } from '../../../lib/tts'
import { copyText, dictLookup, translateInvoke } from '../../../lib/ipc'
import type { DictLookupResult, TranslateMode } from '../../../lib/translateTypes'
import { MarkdownPreview } from '../MarkdownPreview'

/**
 * 划词翻译卡片：选中英文后在选区旁弹出。
 * 单词 → 离线词典即时出卡（音标/考纲标签/释义/词形），可再点「AI 精讲」；
 * 句子/段落 → 自动走 LLM 翻译（考研风格：译文 + 长难句拆解 + 核心词）。
 * 关闭方式：Esc / 点击卡片外 / 滚动。
 */

interface TranslateCardProps {
  /** 选区矩形（viewport 坐标），卡片据此定位：优先放选区下方，放不下放上方，且不遮住选中的原文 */
  rect: { left: number; top: number; right: number; bottom: number }
  text: string
  onClose: () => void
}

const TAG_LABELS: Record<string, string> = {
  cet4: '四级', cet6: '六级', ky: '考研',
  toefl: '托福', ielts: '雅思', gre: 'GRE', gk: '高考', zk: '中考',
}
type ExchangeKey = 'past' | 'pp' | 'ing' | 's3' | 'plural' | 'er' | 'est'
const EXCHANGE_LABELS: [ExchangeKey, string][] = [
  ['past', '过去式'], ['pp', '过去分词'], ['ing', '现在分词'],
  ['s3', '三单'], ['plural', '复数'], ['er', '比较级'], ['est', '最高级'],
]

function isSingleWord(text: string): boolean {
  return /^[A-Za-z][A-Za-z''-]*$/.test(text.trim())
}

export function TranslateCard({ rect, text, onClose }: TranslateCardProps) {
  const mode: TranslateMode = isSingleWord(text) ? 'word' : 'sentence'
  const [dict, setDict] = useState<DictLookupResult | null>(null)
  const [aiMd, setAiMd] = useState<string>('')
  const [aiModel, setAiModel] = useState<string>('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string>('')
  const [aiStarted, setAiStarted] = useState(mode === 'sentence') // 句子模式挂载即翻译
  const [cached, setCached] = useState(false)
  const [copied, setCopied] = useState(false)
  const reqSeqRef = useRef(0)

  // 单词模式：立即查离线词典
  useEffect(() => {
    if (mode !== 'word') return
    dictLookup(text).then(setDict).catch(() => setDict({ found: false }))
  }, [mode, text])

  const runAi = useCallback(async () => {
    const seq = ++reqSeqRef.current
    setAiStarted(true)
    setAiLoading(true)
    setAiError('')
    try {
      const r = await translateInvoke({ text, mode, ai: mode === 'word' })
      if (seq !== reqSeqRef.current) return
      if (r.ok) {
        setAiMd(r.markdown)
        setAiModel(r.model)
        setCached(r.cached)
        if (r.dict && r.dict.found) setDict(r.dict)
      } else {
        setAiError(r.error)
        if (r.code === 'NO_DEFAULT_MODEL') {
          showToast({ type: 'info', message: '请先在设置中配置模型供应商' })
          window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'aiTools', aiTab: 'models' } }))
        }
      }
    } catch (err) {
      if (seq === reqSeqRef.current) setAiError(String((err as Error)?.message ?? err))
    } finally {
      if (seq === reqSeqRef.current) setAiLoading(false)
    }
  }, [mode, text])

  useEffect(() => {
    if (mode === 'sentence') void runAi()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 关闭交互：Esc / 点击卡片外 / 滚动（与划词浮钮一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (t?.closest?.('[data-translate-card]')) return
      onClose()
    }
    const onScroll = (e: Event) => {
      // 滚动卡片自身的内容区不算"页面滚动"，不关闭
      const t = e.target
      if (t instanceof Element && t.closest('[data-translate-card]')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  const handleCopy = async () => {
    const content = aiMd || dict?.entry?.translationLines.join('\n') || text
    if (await copyText(content)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else showToast({ type: 'error', message: '复制失败' })
  }

  // ===== 智能定位：先渲染量高，再"先量后摆"，避免溢出屏幕或盖住选中的原文 =====
  const CARD_W = 400
  const cardRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 320
    const vw = window.innerWidth
    const vh = window.innerHeight
    const M = 8 // 视口边距
    // 垂直：优先选区下方，放不下放上方，都放不下则取最大可视高度
    let top: number
    if (rect.bottom + M + h <= vh - M) top = rect.bottom + M
    else if (rect.top - M - h >= M) top = rect.top - M - h
    else top = Math.max(M, Math.min(vh - M - h, rect.bottom + M))
    // 水平：与选区左缘对齐并夹进视口
    let left = Math.max(M, Math.min(rect.left, vw - CARD_W - M))
    // 若仍与选区纵向重叠（上下都放不下的兜底），横移到选区侧旁避免盖住原文
    const vOverlap = top < rect.bottom && top + h > rect.top
    if (vOverlap && left < rect.right && left + CARD_W > rect.left) {
      if (rect.right + M + CARD_W <= vw - M) left = rect.right + M
      else if (rect.left - M - CARD_W >= M) left = rect.left - M - CARD_W
    }
    setPlace({ left, top })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const entry = dict?.found ? dict.entry : undefined
  const examTags = entry?.tags.filter(t => t === 'cet4' || t === 'cet6' || t === 'ky') ?? []
  const otherTags = entry?.tags.filter(t => !(t === 'cet4' || t === 'cet6' || t === 'ky')) ?? []

  // 划词浮钮进出场（E 类）：卡片本就靠内联 opacity + transition 做显隐，
  // 因此不能挂 .kb-pop（both 填充会长期压制内联 opacity=0 导致关不掉）——
  // 改走同一套 transition，补一个 scale 让「出现/消失」有方向感，origin 对准锚点
  return (
    <div
      ref={cardRef}
      data-translate-card
      className={`fixed z-50 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-2xl flex flex-col overflow-hidden origin-top-left transition-[opacity,scale] ${place ? '' : 'scale-95'}`}
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999, width: CARD_W, maxHeight: 'min(70vh, 560px)', opacity: place ? 1 : 0 }}
    >
      {/* 头部 */}
      <div className="shrink-0 h-8 px-2.5 flex items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
        {mode === 'word' ? <BookOpen size={12} className="text-[var(--accent)]" /> : <Languages size={12} className="text-[var(--accent)]" />}
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">{mode === 'word' ? '词典' : '翻译'}</span>
        {cached && <span className="text-[10px] text-[var(--text-disabled)]">已缓存</span>}
        <button onClick={handleCopy} data-tip="复制结果" aria-label="复制结果"
          className="ml-auto p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
        </button>
        <button onClick={onClose} data-tip="关闭 (Esc)" aria-label="关闭 (Esc)"
          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5 select-text">
        {/* 原文（句子模式展示，过长折叠） */}
        {mode === 'sentence' && (
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)] border-l-2 border-[var(--border-color)] pl-2 mb-2.5 break-words"
            style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {text}
          </p>
        )}

        {/* 单词模式：词典区 */}
        {mode === 'word' && (
          <div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <button onClick={() => speak(entry?.word ?? text)} data-tip="点击发音" aria-label="点击发音"
                className="text-[17px] font-semibold text-[var(--text-primary)] break-all hover:text-[var(--accent)] transition-colors">
                {entry?.word ?? text}
              </button>
              <button onClick={() => speak(entry?.word ?? text)} data-tip="发音" aria-label="发音"
                className="text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors self-center">
                <Volume2 size={13} />
              </button>
              {entry?.phonetic && <span className="text-[12px] text-[var(--text-muted)]">/{entry.phonetic.replace(/^\/|\/$/g, '')}/</span>}
              {entry?.inflectedFrom && (
                <span className="text-[10px] text-[var(--text-disabled)]">「{entry.inflectedFrom}」的词形还原</span>
              )}
            </div>

            {entry && (
              <>
                {/* 考纲与词频徽章 */}
                {(examTags.length > 0 || otherTags.length > 0 || entry.collins > 0 || entry.oxford > 0 || entry.frq > 0) && (
                  <div className="flex items-center gap-1 flex-wrap mt-1">
                    {examTags.map(t => (
                      <span key={t} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--accent)]/15 text-[var(--accent)]">{TAG_LABELS[t] ?? t}</span>
                    ))}
                    {otherTags.map(t => (
                      <span key={t} className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-hover)] text-[var(--text-muted)]">{TAG_LABELS[t] ?? t}</span>
                    ))}
                    {entry.collins > 0 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-hover)] text-amber-500" data-tip="柯林斯星级" aria-label="柯林斯星级">{'★'.repeat(entry.collins)}</span>
                    )}
                    {entry.oxford > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-hover)] text-[var(--text-muted)]">牛津核心</span>}
                    {(entry.frq > 0 && entry.frq <= 20000) && <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-hover)] text-[var(--text-muted)]">高频词</span>}
                  </div>
                )}

                {/* 释义 */}
                {entry.translationLines.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {entry.translationLines.slice(0, 6).map((line, i) => (
                      <li key={i} className="text-[12.5px] leading-relaxed text-[var(--text-primary)] break-words">{line}</li>
                    ))}
                  </ul>
                )}
                {entry.definition && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)] break-words">{entry.definition}</p>
                )}

                {/* 词形变化 */}
                {EXCHANGE_LABELS.some(([k]) => entry.exchange[k]) && (
                  <div className="flex items-center gap-1 flex-wrap mt-2">
                    {EXCHANGE_LABELS.filter(([k]) => entry.exchange[k]).map(([k, label]) => (
                      <span key={k} className="px-1.5 py-0.5 rounded text-[10px] border border-[var(--border-color)] text-[var(--text-secondary)]">
                        {label} <span className="text-[var(--text-primary)]">{entry.exchange[k]}</span>
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
            {dict !== null && !dict.found && (
              <p className="mt-1.5 text-[12px] text-[var(--text-muted)]">离线词典未收录，可用 AI 精讲查询。</p>
            )}
          </div>
        )}

        {/* AI 区（句子翻译 / 单词精讲） */}
        {aiStarted && (
          <div className={mode === 'word' ? 'mt-2.5 pt-2.5 border-t border-[var(--border-color)]' : ''}>
            {aiLoading && (
              <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)] py-1">
                <Loader2 size={13} className="animate-spin" />
                {mode === 'word' ? 'AI 精讲生成中…' : '翻译中…'}
              </div>
            )}
            {!aiLoading && aiError && (
              <div className="text-[12px] text-red-400 leading-relaxed">
                {mode === 'word' ? 'AI 精讲失败：' : '翻译失败：'}{aiError}
                <button onClick={() => void runAi()} className="ml-2 underline underline-offset-2 hover:text-[var(--text-primary)]">重试</button>
              </div>
            )}
            {!aiLoading && aiMd && <MarkdownPreview content={aiMd} />}
            {!aiLoading && !aiMd && !aiError && null}
          </div>
        )}
      </div>

      {/* 底部操作：单词模式未开启精讲时显示按钮 */}
      {mode === 'word' && !aiStarted && (
        <div className="shrink-0 px-3 py-2 border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <button onClick={() => void runAi()}
            className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">
            <Sparkles size={12} /> AI 精讲（例句 · 词根词缀 · 记忆法 · 易混词）
          </button>
        </div>
      )}
      {/* AI 结果的模型标注（翻译/精讲完成后） */}
      {aiStarted && aiMd && aiModel && (
        <div className="shrink-0 px-3 py-1.5 border-t border-[var(--border-color)] text-[10px] text-[var(--text-disabled)] truncate">
          {mode === 'word' ? 'AI 精讲' : 'AI 翻译'} · {aiModel}
        </div>
      )}
    </div>
  )
}
