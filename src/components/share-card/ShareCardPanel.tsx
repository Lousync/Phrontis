import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { ShareCardStyle, ShareCardState, ShareCardTexts } from '../../types'
import { copyImageUrlToClipboard, shareCardSavePng } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { useSettings } from '../../lib/SettingsContext'
import { ShareCardCanvas } from './ShareCardCanvas'
import { ShareCardEditor } from './ShareCardEditor'
import { CARD_H, CARD_W, SHARE_CARD_STYLES, STYLE_LABEL, parseShareCardStyle, type SlotKey } from './shareCardStyles'
import { PROMPT_MAX_CHARS } from './shareCardRichText'
import { DEFAULT_TEXTS, isTemplateDirty, newTemplateId, sanitizeShareCardState } from './shareCardTemplates'
import { useShareCardData } from './useShareCardData'

/**
 * 右栏「分享」态（2026-09-29）。
 *
 * 三件需求都在这一个面板里：① 卡片预览与出口；② 文字编辑入口（浮层里图上直改）；
 * ③ 我的模板（整套快照：风格 + 卡片明暗 + 三处文案）。
 *
 * 状态存**全局设置**单键 `shareCard`（换库跟着走），写入做 400ms 防抖 ——
 * 逐字改文案不该每敲一下写一次盘。
 */
export function ShareCardPanel() {
  const { s, ready, update } = useSettings()
  const { data, error } = useShareCardData()

  const [state, setState] = useState<ShareCardState | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [tplName, setTplName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [k, setK] = useState(0.5)

  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const timer = useRef<number | null>(null)
  const pending = useRef<ShareCardState | null>(null)

  // 设置是异步加载的（ready 之前 s 全是默认值）→ 必须等 ready 再取一次作为本地草稿
  useEffect(() => {
    if (!ready || state !== null) return
    setState(sanitizeShareCardState(s.shareCard))
  }, [ready, s.shareCard, state])

  const flush = useCallback(() => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    const p = pending.current
    pending.current = null
    if (p) update('shareCard', JSON.stringify(p))
  }, [update])

  const persist = useCallback((next: ShareCardState) => {
    pending.current = next
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, 400)
  }, [flush])

  // ★ 卸载时**补写**而不是丢弃：改完文案立刻切 Tab，防抖窗口里的最后一次编辑不能丢
  useEffect(() => flush, [flush])

  const mutate = useCallback((fn: (cur: ShareCardState) => ShareCardState) => {
    setState((cur) => {
      if (!cur) return cur
      const next = fn(cur)
      persist(next)
      return next
    })
  }, [persist])

  /* ---- 预览等比缩放 ---- */
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width < 10 || r.height < 10) return
      setK(Math.max(0.08, Math.min(r.width / CARD_W, r.height / CARD_H)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [state === null])

  const patchText = useCallback((key: SlotKey, value: string) => {
    mutate((cur) => ({ ...cur, current: { ...cur.current, texts: { ...cur.current.texts, [key]: value } } }))
  }, [mutate])

  const resetText = useCallback((key: SlotKey) => {
    mutate((cur) => ({ ...cur, current: { ...cur.current, texts: { ...cur.current.texts, [key]: DEFAULT_TEXTS[key] } } }))
  }, [mutate])

  /** 题目区：**不属于模板**，改它不碰 current.tplId（所以模板的「已修改」标记不会因换题而亮） */
  const setPrompt = useCallback((v: string) => {
    mutate((cur) => ({ ...cur, prompt: v.slice(0, PROMPT_MAX_CHARS) }))
  }, [mutate])

  const setStyle = useCallback((style: ShareCardStyle) => {
    mutate((cur) => ({ ...cur, current: { ...cur.current, style } }))
  }, [mutate])

  const setCardTheme = useCallback((theme: 'light' | 'dark') => {
    mutate((cur) => ({ ...cur, current: { ...cur.current, theme } }))
  }, [mutate])

  const applyTemplate = useCallback((id: string) => {
    mutate((cur) => {
      const t = cur.templates.find((x) => x.id === id)
      if (!t) return cur
      return {
        ...cur,
        current: { style: t.style, theme: t.theme, texts: { ...DEFAULT_TEXTS, ...t.texts }, tplId: t.id },
      }
    })
  }, [mutate])

  const saveTemplate = useCallback(() => {
    const name = tplName.trim()
    if (!name) return
    mutate((cur) => {
      const id = newTemplateId()
      const t = { id, name: name.slice(0, 16), style: cur.current.style, theme: cur.current.theme, texts: { ...cur.current.texts } }
      return { ...cur, templates: [...cur.templates, t], current: { ...cur.current, tplId: id } }
    })
    setTplName('')
    showToast({ type: 'success', message: `已存为模板「${name.slice(0, 16)}」` })
  }, [mutate, tplName])

  const renameTemplate = useCallback((id: string) => {
    const cur = state?.templates.find((x) => x.id === id)
    if (!cur) return
    setRenamingId(id)
    setRenameVal(cur.name)
  }, [state])

  const commitRename = useCallback(() => {
    const id = renamingId
    const name = renameVal.trim().slice(0, 16)
    setRenamingId(null)
    if (!id || !name) return
    mutate((c) => ({ ...c, templates: c.templates.map((t) => (t.id === id ? { ...t, name } : t)) }))
  }, [renamingId, renameVal, mutate])

  const deleteTemplate = useCallback((id: string) => {
    mutate((c) => {
      const templates = c.templates.filter((t) => t.id !== id)
      // 允许删到**空库**：模板只是版式快照，当前卡片配置（风格 / 明暗 / 文案）独立于模板存在，
      // 删光不会让卡片不可用（钝解析那边也保证空数组原样保留，不会自己长回来）
      const tplId = c.current.tplId === id ? (templates[0]?.id ?? null) : c.current.tplId
      return { ...c, templates, current: { ...c.current, tplId } }
    })
  }, [mutate])

  /* ---- 出口 ---- */
  const copyImage = useCallback(async () => {
    const cv = canvasRef.current
    if (!cv) return
    try {
      const ok = await copyImageUrlToClipboard(cv.toDataURL('image/png'))
      if (ok) showToast({ type: 'success', message: '已复制图片', detail: '去微信窗口 Ctrl+V 直接粘贴' })
      else showToast({ type: 'error', message: '复制失败' })
    } catch (e) {
      showToast({ type: 'error', message: '复制失败', detail: String((e as Error)?.message ?? e) })
    }
  }, [])

  const savePng = useCallback(async () => {
    const cv = canvasRef.current
    if (!cv || !data) return
    const bytes = await new Promise<Uint8Array | null>((res) => {
      cv.toBlob(async (b) => res(b ? new Uint8Array(await b.arrayBuffer()) : null), 'image/png')
    })
    if (!bytes) { showToast({ type: 'error', message: '出图失败' }); return }
    const r = await shareCardSavePng(bytes, `Phrontis打卡-${data.date.replace(/-/g, '')}.png`)
    if (r.ok) showToast({ type: 'success', message: '已另存为 PNG', detail: r.path })
    else if (!r.cancelled) showToast({ type: 'error', message: r.error ?? '另存失败' })
  }, [data])

  const dirty = useMemo(() => (state ? isTemplateDirty(state) : false), [state])

  if (!state) {
    return <div className="flex flex-1 items-center justify-center text-[11.5px] text-[var(--text-muted)]">正在读取卡片设置…</div>
  }

  const texts: ShareCardTexts = state.current.texts

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-2.5">
      {/* 预览（点击进编辑浮层） */}
      <div
        ref={boxRef}
        onClick={() => data && setEditorOpen(true)}
        title={data ? '点击放大编辑文字' : ''}
        className="group relative mt-2.5 flex h-[404px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)]"
      >
        {data ? (
          <ShareCardCanvas
            data={data}
            texts={texts}
            style={state.current.style}
            theme={state.current.theme}
            prompt={state.prompt}
            width={CARD_W * k}
            canvasRef={canvasRef}
            className="block rounded-[6px] shadow-lg"
          />
        ) : (
          <span className="px-4 text-center text-[11.5px] text-[var(--text-muted)]">
            {error ? `卡片数据读取失败：${error}` : '正在生成卡片…'}
          </span>
        )}
        {data && (
          <span className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-black/75 px-3 py-1 text-[11.5px] text-white backdrop-blur-sm">
              <Pencil size={11} /> 编辑文字
            </span>
          </span>
        )}
      </div>

      {/* 主视觉 */}
      <Section title="主视觉">
        <div className="flex gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-[3px]">
          {SHARE_CARD_STYLES.map((id) => (
            <button
              key={id}
              data-share-style={id}
              onClick={() => setStyle(parseShareCardStyle(id))}
              className={`flex-1 rounded-md py-1 text-[12px] transition-colors ${
                state.current.style === id
                  ? 'bg-[var(--bg-hover)] font-semibold text-[var(--accent)] shadow-[inset_0_0_0_1px_var(--border-color)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {STYLE_LABEL[id]}
            </button>
          ))}
        </div>
      </Section>

      {/* 卡片明暗 */}
      <Section title="卡片明暗">
        <div className="flex gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-[3px]">
          {(['light', 'dark'] as const).map((id) => (
            <button
              key={id}
              data-share-theme={id}
              onClick={() => setCardTheme(id)}
              className={`flex-1 rounded-md py-1 text-[12px] transition-colors ${
                state.current.theme === id
                  ? 'bg-[var(--bg-hover)] font-semibold text-[var(--accent)] shadow-[inset_0_0_0_1px_var(--border-color)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {id === 'light' ? '浅色' : '深色'}
            </button>
          ))}
        </div>
      </Section>

      {/* 我的模板 */}
      <Section title="我的模板" extra={<span className="text-[10px] text-[var(--text-muted)]">{state.templates.length} 套</span>}>
        <div className="flex flex-col">
          {state.templates.map((t) => {
            const active = t.id === state.current.tplId
            return (
              <div
                key={t.id}
                data-share-tpl={t.id}
                onClick={() => applyTemplate(t.id)}
                className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-[12px] transition-colors ${
                  active ? 'border-[var(--border-color)] bg-[var(--bg-tertiary)]' : 'border-transparent hover:bg-[var(--bg-hover)]'
                }`}
              >
                {renamingId === t.id ? (
                  <input
                    autoFocus
                    type="text"
                    value={renameVal}
                    maxLength={16}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                      if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
                    }}
                    className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg-primary)] px-1.5 py-0.5 text-[12px] outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                )}
                {active && dirty && (
                  <span className="shrink-0 rounded border border-[color-mix(in_srgb,#d79a3a_45%,transparent)] px-1 py-px text-[9.5px] text-[#d79a3a]">已修改</span>
                )}
                {t.builtin && (
                  <span className="shrink-0 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1 py-px text-[9.5px] text-[var(--text-muted)]">内置</span>
                )}
                <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                  {!t.builtin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); renameTemplate(t.id) }}
                      title="重命名"
                      className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      <Pencil size={11} />
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteTemplate(t.id) }}
                    title={t.builtin ? '删除这个内置模板' : '删除'}
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              </div>
            )
          })}
          {state.templates.length === 0 && (
            <p className="rounded-md border border-dashed border-[var(--border-color)] px-2 py-2.5 text-center text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
              模板已全部删除。当前卡片配置仍在，可随时「存为模板」再建一个。
            </p>
          )}
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <input
            type="text"
            value={tplName}
            maxLength={16}
            placeholder="新模板名，如「考研打卡」"
            onChange={(e) => setTplName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveTemplate() }}
            className="min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={saveTemplate}
            disabled={!tplName.trim()}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40 disabled:hover:border-[var(--border-color)] disabled:hover:text-[var(--text-secondary)]"
          >
            <Plus size={11} /> 存为模板
          </button>
        </div>
        <button
          onClick={() => { resetText('quote'); resetText('slogan'); resetText('signature') }}
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
        >
          <RotateCcw size={10} /> 三处文案全部还原默认
        </button>
      </Section>

      {/* 出口 */}
      <div className="sticky bottom-0 mt-3 flex gap-2 bg-gradient-to-b from-transparent to-[var(--bg-secondary)] pt-2.5">
        <button
          onClick={() => void copyImage()}
          disabled={!data}
          className="flex-1 rounded-lg bg-[var(--accent)] py-2 text-[12.5px] font-semibold text-white transition-[filter] hover:brightness-110 disabled:opacity-40"
        >
          复制图片
        </button>
        <button
          onClick={() => void savePng()}
          disabled={!data}
          className="flex-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] py-2 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
        >
          另存 PNG
        </button>
      </div>

      {data && (
        <ShareCardEditor
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          data={data}
          texts={texts}
          style={state.current.style}
          theme={state.current.theme}
          prompt={state.prompt}
          onChangeText={patchText}
          onResetText={resetText}
          onChangePrompt={setPrompt}
        />
      )}
    </div>
  )
}

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-3 shrink-0">
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] tracking-wide text-[var(--text-muted)]">
        {title}
        <span className="ml-auto">{extra}</span>
      </div>
      {children}
    </div>
  )
}
