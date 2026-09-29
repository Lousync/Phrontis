import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { RotateCcw } from 'lucide-react'
import type { ShareCardData, ShareCardStyle, ShareCardTexts } from '../../types'
import { ModalShell } from '../shared/ModalShell'
import { ShareCardCanvas } from './ShareCardCanvas'
import {
  CARD_H, CARD_W, PAD, SLOT_LABEL, SLOT_ORDER, TEXT_LIMITS, palette, slotRects,
  type SlotKey,
} from './shareCardStyles'
import { promptRect, PROMPT_MAX_CHARS } from './shareCardRichText'
import { DEFAULT_TEXTS } from './shareCardTemplates'

interface Props {
  open: boolean
  onClose: () => void
  data: ShareCardData
  texts: ShareCardTexts
  style: ShareCardStyle
  theme: 'light' | 'dark'
  prompt: string
  onChangeText: (key: SlotKey, value: string) => void
  onResetText: (key: SlotKey) => void
  onChangePrompt: (value: string) => void
}

/** 把 `ctx.font` 串里的字号按显示比例缩放（`20px Georgia…` → `14.5px Georgia…`） */
function scaledFont(font: string, k: number): string {
  return font.replace(/(\d+(?:\.\d+)?)px/, (_, n: string) => `${(Number(n) * k).toFixed(2)}px`)
}

/**
 * 分享卡片编辑浮层（2026-09-29）。
 *
 * **图上直接改字**的做法：canvas 之上盖一层与槽位矩形**同源**的透明输入框
 * （矩形来自 `shareCardStyles.slotRects`，绘制层与这里共用同一份常量 → 不会漂移）。
 * 输入框平时 `color: transparent`（字由 canvas 画），聚焦时才显形、同时 canvas 跳过该槽位
 * —— 否则中文输入法**组字期间**候选字只存在于输入框里，透明了就看不见。
 */
export function ShareCardEditor({ open, onClose, data, texts, style, theme, prompt, onChangeText, onResetText, onChangePrompt }: Props) {
  const [k, setK] = useState(0.7)
  const [focused, setFocused] = useState<SlotKey | null>(null)
  /** 题目区编辑态：编辑期间在图上盖一块源码小面板（公式源码无法与渲染结果逐字对齐，见下注） */
  const [promptEditing, setPromptEditing] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

  // 舞台尺寸 → 卡片显示比例（等比 fit）
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width < 10 || r.height < 10) return
      setK(Math.max(0.15, Math.min(r.width / CARD_W, r.height / CARD_H)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  const rects = useMemo(() => slotRects(style), [style])
  const pr = useMemo(() => promptRect(style), [style])
  const p = useMemo(() => palette(theme), [theme])
  const hideSlots = useMemo<readonly SlotKey[]>(() => (focused ? [focused] : []), [focused])

  const slotColor = useCallback((key: SlotKey) => {
    if (key === 'quote') return theme === 'dark' ? '#e6e3f5' : p.ink
    return key === 'signature' ? p.ink2 : p.ink3
  }, [p, theme])

  const boxStyle = useCallback((key: SlotKey): CSSProperties => {
    const r = rects[key]
    return {
      left: r.x * k,
      top: r.y * k,
      width: r.w * k,
      height: r.h * k,
      font: scaledFont(r.font, k),
      lineHeight: `${r.lineH * k}px`,
      color: focused === key ? slotColor(key) : 'transparent',
      caretColor: slotColor(key),
    }
  }, [rects, k, focused, slotColor])

  const slotClass = 'absolute m-0 rounded-[3px] border-0 bg-transparent p-0 outline-none ' +
    'transition-shadow hover:shadow-[0_0_0_2px_rgba(83,74,183,.28)] ' +
    'focus:shadow-[0_0_0_2px_rgba(83,74,183,.6)] focus:bg-[rgba(83,74,183,.06)]'

  const commonInputProps = (key: SlotKey) => ({
    value: texts[key],
    maxLength: TEXT_LIMITS[key],
    spellCheck: false,
    autoComplete: 'off' as const,
    onFocus: () => setFocused(key),
    onBlur: () => setFocused(cur => (cur === key ? null : cur)),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChangeText(key, e.target.value),
    'data-share-slot': key,
  })

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-6"
      panelClassName="flex h-[min(880px,90vh)] w-[min(1080px,94vw)] flex-col overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl"
      exitMs={200}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-4 text-[12.5px]">
        <span className="font-semibold">编辑卡片文字</span>
        <span className="text-[11.5px] text-[var(--text-muted)]">直接在图上改，或改右侧表单 —— 两边同步</span>
        <button
          onClick={onClose}
          className="ml-auto rounded-md px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          完成
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：卡片 + 透明输入层 */}
        <div ref={stageRef} className="flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[var(--bg-primary)] p-4">
          <div className="relative" style={{ width: CARD_W * k, height: CARD_H * k }}>
            <ShareCardCanvas
              data={data}
              texts={texts}
              style={style}
              theme={theme}
              prompt={prompt}
              width={CARD_W * k}
              hideSlots={hideSlots}
              className="block rounded-[10px] shadow-2xl"
            />

            {/*
              题目区编辑态：在图上**原位盖一块源码面板**（矩形取自 panelLayout，与画出来的块同源）。
              为什么不照其它槽位做「透明输入层」：那段文本里既有 Markdown 又有 LaTeX，
              渲染后（公式被 KaTeX 重排）与源码的字符位置完全没有对应关系 ——
              透明输入层不可能对齐，光标会飘到公式图形之外。所以编辑期间**换成源码视图**，
              失焦即恢复渲染结果（用户已确认接受这个交互）。
            */}
            {promptEditing && (
              <div
                className="absolute rounded-[6px] border border-[var(--accent)] bg-[var(--bg-primary)]/95 p-2 shadow-lg backdrop-blur-sm"
                style={{
                  left: pr.x * k,
                  top: pr.y * k,
                  width: pr.w * k,
                  height: pr.h * k,
                }}
              >
                <textarea
                  data-share-prompt-editor
                  autoFocus
                  value={prompt}
                  maxLength={PROMPT_MAX_CHARS}
                  spellCheck={false}
                  placeholder={'$x^2$ · **粗** · *斜*'}
                  onFocus={() => setPromptEditing(true)}
                  onBlur={() => setPromptEditing(false)}
                  onChange={(e) => onChangePrompt(e.target.value)}
                  className="h-full w-full resize-none bg-transparent font-mono text-[12px] leading-[1.7] text-[var(--text-primary)] outline-none"
                />
              </div>
            )}
            {!promptEditing && (
              <button
                onMouseDown={(e) => { e.preventDefault(); setPromptEditing(true) }}
                title="编辑题目"
                className="absolute cursor-text rounded-[6px] border border-transparent transition-[border-color,background-color] hover:border-[var(--accent)] hover:bg-[rgba(83,74,183,.06)]"
                style={{
                  left: pr.x * k,
                  top: pr.y * k,
                  width: pr.w * k,
                  height: pr.h * k,
                }}
              />
            )}
            {SLOT_ORDER.map((key) => (
              key === 'quote' ? (
                <textarea
                  key={key}
                  {...commonInputProps(key)}
                  style={{ ...boxStyle(key), resize: 'none', overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  className={slotClass}
                  aria-label={SLOT_LABEL[key]}
                />
              ) : (
                <input
                  key={key}
                  {...commonInputProps(key)}
                  style={boxStyle(key)}
                  className={slotClass}
                  aria-label={SLOT_LABEL[key]}
                />
              )
            ))}
          </div>
        </div>

        {/* 右：同步表单 —— **与图上可编辑项一一对齐**：三个文案槽位 + 题目区，共 4 项。
            早先漏了题目区（图上能改、右侧没有），数量对不上。 */}
        <div className="flex w-[300px] shrink-0 flex-col gap-1 overflow-y-auto border-l border-[var(--border-color)] p-4">
          {SLOT_ORDER.map((key) => (
            <div key={key} className="border-b border-dashed border-[var(--border-color)] py-2 last:border-b-0">
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
                {SLOT_LABEL[key]}
                <button
                  onClick={() => onResetText(key)}
                  disabled={texts[key] === DEFAULT_TEXTS[key]}
                  title="还原默认"
                  className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)] disabled:opacity-30 disabled:hover:text-[var(--text-muted)]"
                >
                  <RotateCcw size={11} /> 还原
                </button>
              </div>
              <input
                type="text"
                value={texts[key]}
                maxLength={TEXT_LIMITS[key]}
                placeholder={DEFAULT_TEXTS[key] || '（留空则不显示）'}
                onFocus={() => setFocused(key)}
                onBlur={() => setFocused(cur => (cur === key ? null : cur))}
                onChange={(e) => onChangeText(key, e.target.value)}
                className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12.5px] outline-none focus:border-[var(--accent)]"
              />
              <div className="mt-1 text-right text-[10px] text-[var(--text-muted)]">
                {texts[key].length}/{TEXT_LIMITS[key]}
              </div>
            </div>
          ))}

          {/* 第 4 项：题目区（与图上那块对应） */}
          <div className="border-b border-dashed border-[var(--border-color)] py-2 last:border-b-0">
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
              题目（支持公式）
              <button
                onClick={() => onChangePrompt('')}
                disabled={!prompt}
                title="清空"
                className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)] disabled:opacity-30 disabled:hover:text-[var(--text-muted)]"
              >
                <RotateCcw size={11} /> 清空
              </button>
            </div>
            <textarea
              data-share-prompt-form
              value={prompt}
              maxLength={PROMPT_MAX_CHARS}
              rows={3}
              spellCheck={false}
              placeholder={'$x^2$ · **粗** · *斜*'}
              onFocus={() => setPromptEditing(true)}
              onBlur={() => setPromptEditing(false)}
              onChange={(e) => onChangePrompt(e.target.value)}
              className="w-full resize-none rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1 font-mono text-[12px] leading-[1.7] outline-none focus:border-[var(--accent)]"
            />
            <div className="mt-1 text-right text-[10px] text-[var(--text-muted)]">
              {prompt.length}/{PROMPT_MAX_CHARS}
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}
