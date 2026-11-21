import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, ArrowRightLeft, Check, ChevronRight, Copy, Import, Loader2, Plus, Search, Star, Trash2, X, Zap,
} from 'lucide-react'
import { SLOT_LABEL, entryLabel, useModelCatalog } from '../../../lib/modelCatalog'
import { showToast } from '../../../lib/toast'
import {
  copyText, llmCatalogAdoptRefs, llmCatalogList, llmCatalogMigrate, llmCatalogRemove, llmCatalogSave,
  llmCatalogSetDefault, llmCatalogTest, llmListProviders, setSettingRaw,
} from '../../../lib/ipc'
import { Collapsible } from '../../../components/shared/Collapsible'
import { HelpHint } from '../../../components/shared/HelpHint'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import {
  MODEL_NAME_MAX, MODEL_SLOT_KEYS, contextWindowTitle, contextWindowToK, entriesCountText, filterEntries,
  nextCapabilityState, parseContextWindowK, planSlotRewrite, refsText, rewriteSummary, sortEntries,
  testPillLabel, testTimeText, validateSaveInput,
} from './modelCatalogUiPure'
import type { CatalogTestOutcome, SlotRewritePlan, SlotScanResult } from './modelCatalogUiPure'
import type { LlmCapabilityKey, LlmCapabilityState, LlmModelEntry, LlmProviderInfo } from '../../../types'

/** 能力定义：条目行要显示**全部六种**三态，所以不能复用 capabilityChips（它只回显式 yes/no） */
const CAP_DEFS: Array<{ key: LlmCapabilityKey; label: string }> = [
  { key: 'tools', label: '工具' },
  { key: 'vision', label: '视觉' },
  { key: 'json', label: 'JSON' },
  { key: 'imageGeneration', label: '生图' },
  { key: 'imageEdit', label: '改图' },
  { key: 'reasoning', label: '思考' },
]

/**
 * 设置 → AI → 模型 → 模型条目（2026-11-20 按已确认原型重排版）。
 *
 * 这一节回答的是「有哪些模型可以选」，与下面的「场景分配」（哪个场景用它）分开：
 * 条目是命名 + 能力 + 上下文窗口的容器，槽位只是引用它。
 *
 * 三条硬口径（本次重做**不动**）：
 *   · 测试**不写回**条目（B11）—— 结果只在行内显示，目录里不会凭空多出 lastTest；
 *   · 删除被引用的条目**先改派再删**（B12）—— 拒绝时把引用处逐条列出来，行内选目标即可；
 *   · 反馈一律 Toast / 行内，不用 window.confirm（铁律 25）。
 *
 * 本次只改观感与信息层级：条目行拆成「名称行 / 身份行 / 属性行」三层，
 * 长 model id 换行而不省略号截断，上下文窗口按千 token 展示，测试结果收成行尾胶囊。
 */
export function ModelCatalogSection() {
  const { entries, snapshot, loading, reload } = useModelCatalog()
  const [providers, setProviders] = useState<LlmProviderInfo[]>([])
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [migrating, setMigrating] = useState(false)

  useEffect(() => {
    let alive = true
    void llmListProviders()
      .then((r) => { if (alive) setProviders(r.providers ?? []) })
      .catch(() => { if (alive) setProviders([]) })
    return () => { alive = false }
  }, [])

  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id
  const visible = useMemo(() => sortEntries(filterEntries(entries, query)), [entries, query])

  const migrate = async () => {
    if (migrating) return
    setMigrating(true)
    try {
      const r = await llmCatalogMigrate()
      showToast(r.created > 0
        ? { type: 'info', message: `新建 ${r.created} 条` }
        : { type: 'info', message: '没有需要导入的旧配置' })
      await reload()
    } catch {
      showToast({ type: 'error', message: '导入失败' })
    } finally { setMigrating(false) }
  }

  const setDefault = async (id: string) => {
    await llmCatalogSetDefault(id)
    await reload()
  }

  /* ---------------- 统一为条目 id（显式迁移，不自动改用户配置） ---------------- */

  const [rewriteOpen, setRewriteOpen] = useState(false)
  const [rewritePlan, setRewritePlan] = useState<SlotRewritePlan[]>([])
  const [rewriteSkipped, setRewriteSkipped] = useState<SlotScanResult['skipped']>([])
  const [rewriteFails, setRewriteFails] = useState<Array<{ slot: string; slotLabel: string; reason: string }>>([])
  const [rewriteBusy, setRewriteBusy] = useState(false)

  /**
   * 扫槽位。旧 `pid:mid` 匹配不到条目时先幂等导入一次旧配置（`llmCatalogMigrate`）
   * 再重扫 —— 否则用户得先点「从现有配置导入」才看得见能改什么。
   * `m_` 开头但找不到条目的槽位不触发导入：那是条目被删掉的残留，导入救不回来。
   */
  const scanSlots = async (): Promise<SlotScanResult> => {
    const first = planSlotRewrite({
      slots: snapshot?.slots ?? {},
      entries,
      slotLabels: SLOT_LABEL,
      allowed: MODEL_SLOT_KEYS,
    })
    const staleSpec = first.skipped.some((s) => s.reason === 'no-entry' && !s.from.startsWith('m_'))
    if (!staleSpec) return first
    try {
      await llmCatalogMigrate()
      const fresh = await llmCatalogList()
      void reload()
      return planSlotRewrite({
        slots: fresh?.slots ?? {},
        entries: fresh?.catalog ?? [],
        slotLabels: SLOT_LABEL,
        allowed: MODEL_SLOT_KEYS,
      })
    } catch {
      return first
    }
  }

  const openRewrite = async () => {
    if (rewriteBusy) return
    if (!snapshot) {
      showToast({ type: 'info', message: '模型目录还在读取，稍后再试' })
      return
    }
    setRewriteBusy(true)
    setRewriteFails([])
    try {
      const r = await scanSlots()
      if (r.plan.length === 0) {
        setRewriteOpen(false)
        setRewritePlan([])
        const stuck = r.skipped.filter((s) => s.reason === 'no-entry').length
        showToast({
          type: 'info',
          message: stuck > 0 ? `已经都是条目 id 了（${stuck} 个旧配置在条目里找不到）` : '已经都是条目 id 了',
        })
        return
      }
      setRewritePlan(r.plan)
      setRewriteSkipped(r.skipped)
      setRewriteOpen(true)
    } catch {
      showToast({ type: 'error', message: '读取场景槽位失败' })
    } finally { setRewriteBusy(false) }
  }

  const applyRewrite = async () => {
    if (rewriteBusy || rewritePlan.length === 0) return
    setRewriteBusy(true)
    setRewriteFails([])
    const fails: Array<{ slot: string; slotLabel: string; reason: string }> = []
    let done = 0
    for (const item of rewritePlan) {
      try {
        // settings:set 对未知键 / 类型不符**静默返回 false**，不抛错 —— 这里必须当真失败
        const res: unknown = await setSettingRaw(item.slot, item.to)
        if (res === false) {
          fails.push({ slot: item.slot, slotLabel: item.slotLabel, reason: '设置写入被拒绝（键或值类型不合法）' })
          continue
        }
        done += 1
      } catch (e) {
        fails.push({ slot: item.slot, slotLabel: item.slotLabel, reason: e instanceof Error ? e.message : '写入失败' })
      }
    }
    setRewriteBusy(false)
    await reload()
    if (fails.length > 0) {
      // 只留下没写成的：重试不会再去碰已经改好的槽位
      setRewritePlan(rewritePlan.filter((p) => fails.some((f) => f.slot === p.slot)))
      setRewriteFails(fails)
      showToast({
        type: 'error',
        message: done > 0 ? `${fails.length} 个槽位改写失败（已改写 ${done} 个）` : '槽位改写失败',
      })
      return
    }
    setRewriteOpen(false)
    setRewritePlan([])
    setRewriteSkipped([])
    showToast({ type: 'success', message: `已改写 ${done} 个槽位` })
  }

  const clearQuery = () => setQuery('')

  return (
    <div className="min-w-0">
      {/* 标题行：标题 + 总数徽标 + 三个动作。flex-wrap 是 320 宽不溢出的前提（按钮会换行） */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-[15px] font-medium text-[var(--text-primary)]">模型条目</h2>
          <span
            className="shrink-0 inline-flex items-center h-[17px] px-1.5 rounded-full bg-[var(--bg-hover)] text-[10.5px] tabular-nums text-[var(--text-muted)]"
            aria-label={`共 ${entries.length} 条模型条目`}
          >
            {entries.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => { void openRewrite() }}
            disabled={rewriteBusy || migrating || loading || !snapshot}
            data-tip="把 8 个场景槽位里的旧「供应商:模型」值改写成模型条目 id（先看清单再确认）"
            aria-label="统一为条目 id"
            className="flex items-center gap-1 whitespace-nowrap h-7 px-2 rounded-[7px] text-[11.5px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
          >
            {rewriteBusy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRightLeft size={12} />} 统一为条目 id
          </button>
          <button
            type="button"
            onClick={() => { void migrate() }}
            disabled={migrating}
            aria-label="从现有配置导入"
            className="flex items-center gap-1 whitespace-nowrap h-7 px-2 rounded-[7px] text-[11.5px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
          >
            {migrating ? <Loader2 size={12} className="animate-spin" /> : <Import size={12} />} 从现有配置导入
          </button>
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            aria-expanded={addOpen}
            className="flex items-center gap-1 whitespace-nowrap h-7 px-2.5 rounded-[7px] text-[11.5px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
          >
            <Plus size={12} /> 添加条目
          </button>
        </div>
      </div>
      <p className="mt-1.5 mb-3 max-w-[540px] text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        给模型起个名字、标清能力与上下文窗口；下面的场景分配从这里挑。
      </p>

      {/* 显式迁移：行内确认卡（不用中央模态、不用 window.confirm，铁律 25） */}
      <Collapsible open={rewriteOpen} innerClassName="">
        {() => (
          <SlotRewriteCard
            plan={rewritePlan}
            skipped={rewriteSkipped}
            failures={rewriteFails}
            busy={rewriteBusy}
            onCancel={() => { if (!rewriteBusy) { setRewriteOpen(false); setRewriteFails([]) } }}
            onApply={() => { void applyRewrite() }}
          />
        )}
      </Collapsible>

      <Collapsible open={addOpen} innerClassName="">
        {() => (
          <AddEntryForm
            providers={providers}
            onCancel={() => setAddOpen(false)}
            onDone={async () => { setAddOpen(false); await reload() }}
          />
        )}
      </Collapsible>

      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-2.5">
          {/* B 形态：外壳唯一一道框，内部控件归零（docs/input-field-pattern.md §3） */}
          <div className="kb-field kb-field-strong flex h-9 min-w-0 flex-1 basis-[200px] max-w-[360px] items-center gap-[7px] rounded-lg px-2.5">
            <Search size={14} className="shrink-0 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                if (query) setQuery('')
                else e.currentTarget.blur()
              }}
              placeholder="搜索名称或模型 id"
              aria-label="搜索模型条目"
              spellCheck={false}
              autoComplete="off"
              className="kb-field-control min-w-0 flex-1 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); }}
                data-tip="清除（Esc）"
                aria-label="清除条目搜索"
                className="shrink-0 grid place-items-center w-[22px] h-[22px] rounded-[5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <X size={12} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2.5 ml-auto">
            <span className="text-[11px] tabular-nums text-[var(--text-muted)]" aria-live="polite">
              {entriesCountText(visible.length, entries.length, query)}
            </span>
            <HelpHint
              label="条目行说明"
              width={300}
              text={(
                <>
                  能力标签点一下切换三态：虚线 = 跟随内置判断，实线绿 = 支持，删除线 = 不支持。
                  上下文按千 token 计（128 = 128,000），留空 = 跟随全局判断。
                  ★ = 免费模型；「精选」会置顶到模型选择器。
                </>
              )}
            />
          </div>
        </div>
      )}

      {visible.length > 0 ? (
        <div
          role="radiogroup"
          aria-label="模型条目"
          className="rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden"
        >
          {visible.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              entries={entries}
              providerNameOf={providerName}
              isDefault={!!snapshot?.defaultEntryId && snapshot.defaultEntryId === entry.id}
              onSetDefault={() => { void setDefault(entry.id) }}
              onChanged={reload}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1.5 px-4 py-8 rounded-[10px] border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)]/60 text-center">
          <span className="mb-0.5 grid place-items-center w-[34px] h-[34px] rounded-full bg-[var(--bg-hover)] text-[var(--text-muted)]">
            <Search size={16} />
          </span>
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            {loading && entries.length === 0
              ? '读取中…'
              : query.trim()
                ? `没有匹配「${query.trim()}」的条目`
                : '还没有模型条目'}
          </p>
          <p className="text-[11px] text-[var(--text-muted)]">
            {query.trim() ? '换个名称或模型 id 试试；Esc 可以清空搜索。' : '点右上角「添加条目」从供应商模型里挑一个。'}
          </p>
          {query.trim() && (
            <button
              type="button"
              onClick={clearQuery}
              className="mt-1.5 h-7 px-2.5 rounded-[7px] border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              清空搜索
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ============================== 条目行 ============================== */

const CAP_STATE_TEXT: Record<LlmCapabilityState, string> = {
  auto: '跟随内置判断',
  yes: '支持',
  no: '不支持',
}

function EntryRow({ entry, entries, providerNameOf, isDefault, onSetDefault, onChanged }: {
  entry: LlmModelEntry
  entries: LlmModelEntry[]
  providerNameOf: (providerId: string) => string
  isDefault: boolean
  onSetDefault: () => void
  onChanged: () => Promise<void>
}) {
  const [name, setName] = useState(entry.name)
  const [win, setWin] = useState(contextWindowToK(entry.contextWindow))
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null)
  const [out, setOut] = useState<CatalogTestOutcome | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [refs, setRefs] = useState<Array<{ entryId: string; where: string }> | null>(null)
  const [adoptTo, setAdoptTo] = useState('')

  // 外部（迁移 / 另一个窗口 / 保存后 reload）改了值：草稿跟着走，别让旧草稿盖回去
  useEffect(() => { setName(entry.name) }, [entry.name])
  useEffect(() => { setWin(contextWindowToK(entry.contextWindow)) }, [entry.contextWindow])
  useEffect(() => { setRefs(null); setAdoptTo(''); setOut(null); setDetailOpen(false) }, [entry.id])

  const others = entries.filter((e) => e.id !== entry.id)

  /** 保存一个补丁：providerId / modelId 必须带（主进程更新按它们定位同 spec 冲突） */
  const save = async (patch: Partial<{
    name: string
    /** null = 显式清空（主进程按 hasOwnProperty 区分「没给」与「给空」） */
    contextWindow: number | null
    curated: boolean
    free: boolean
    capabilities: Partial<Record<LlmCapabilityKey, LlmCapabilityState>>
  }>) => {
    setBusy('save')
    try {
      const r = await llmCatalogSave({
        id: entry.id,
        providerId: entry.providerId,
        modelId: entry.modelId,
        ...patch,
      })
      if (!r.ok) { showToast({ type: 'error', message: r.error ?? '保存失败' }); return false }
      await onChanged()
      return true
    } finally { setBusy(null) }
  }

  const commitName = async () => {
    const next = name.trim()
    if (!next) {
      showToast({ type: 'error', message: '名称不能为空' })
      setName(entry.name)
      return
    }
    if (next === entry.name) return
    const err = validateSaveInput({ name: next, providerId: entry.providerId, modelId: entry.modelId })
    if (err) { showToast({ type: 'error', message: err }); setName(entry.name); return }
    const ok = await save({ name: next })
    if (!ok) setName(entry.name)
  }

  const commitWindow = async () => {
    const parsed = parseContextWindowK(win)
    if (!parsed.ok) {
      showToast({ type: 'error', message: parsed.reason })
      setWin(contextWindowToK(entry.contextWindow))
      return
    }
    if (parsed.tokens === null) {
      // 留空 = 清空（回到「跟随全局判断」）；主进程已改成按「有没有传这个字段」区分，不再吞掉清空
      if (entry.contextWindow) await save({ contextWindow: null })
      return
    }
    const err = validateSaveInput({ providerId: entry.providerId, modelId: entry.modelId, contextWindow: parsed.tokens })
    if (err) { showToast({ type: 'error', message: err }); setWin(contextWindowToK(entry.contextWindow)); return }
    if (parsed.tokens === entry.contextWindow) return
    await save({ contextWindow: parsed.tokens })
  }

  /**
   * 能力三态（B10）：跟随 → 支持 → 不支持 → 跟随。
   *
   * 为什么做成可点的 chip 而不是下拉：条目行已经很密，再挂一个「能力」菜单等于多一层；
   * 而三态只有在「生图 / 改图」这类槽位上是硬判据 —— 看不到当前状态就没法排查
   * 「为什么这个模型选不上」。auto 用虚线表示「跟随内置判断 / 名称规则」，不丢信息也不喧哗。
   */
  const cycleCapability = async (key: LlmCapabilityKey, cur: LlmCapabilityState) => {
    await save({ capabilities: { ...entry.capabilities, [key]: nextCapabilityState(cur) } })
  }

  /** 测试只读：结果留在行内，不写回条目（B11）。失败直接展开详情（原因要当场看得见） */
  const runTest = async () => {
    if (busy) return
    setBusy('test')
    try {
      const r = await llmCatalogTest(entry.id)
      const at = Date.now()
      if (r.ok) {
        setOut({ ok: true, latencyMs: r.latencyMs ?? 0, at })
      } else {
        setOut({ ok: false, error: r.error || '测试失败', at })
        setDetailOpen(true)
      }
    } catch {
      setOut({ ok: false, error: '测试失败', at: Date.now() })
      setDetailOpen(true)
    } finally { setBusy(null) }
  }

  const copyTestError = async () => {
    if (!out || out.ok) return
    const ok = await copyText(out.error || '测试失败')
    showToast(ok
      ? { type: 'info', message: '错误信息已复制' }
      : { type: 'error', message: '复制失败', detail: out.error })
  }

  const askRemove = async () => {
    if (busy) return
    setBusy('remove')
    try {
      const r = await llmCatalogRemove(entry.id)
      if (r.ok) {
        showToast({ type: 'info', message: `已删除「${entry.name}」` })
        await onChanged()
        return
      }
      if (r.refs?.length) { setRefs(r.refs); setAdoptTo(''); return }
      showToast({ type: 'error', message: r.error ?? '删除失败' })
    } finally { setBusy(null) }
  }

  /** 改派引用到目标条目，然后再删（B12 的显式路径） */
  const adoptAndRemove = async () => {
    const to = adoptTo
    if (!to || busy) return
    const target = entries.find((e) => e.id === to)
    setBusy('remove')
    try {
      const a = await llmCatalogAdoptRefs(entry.id, to)
      if (!a.ok) { showToast({ type: 'error', message: a.error ?? '改派失败' }); return }
      const r = await llmCatalogRemove(entry.id)
      if (!r.ok) { showToast({ type: 'error', message: r.error ?? '删除失败' }); await onChanged(); return }
      showToast({
        type: 'info',
        message: `已把 ${a.changed} 处引用改到「${target?.name ?? to}」，并删除条目`,
      })
      await onChanged()
    } finally { setBusy(null) }
  }

  const pillTone = out?.ok
    ? 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-400'
    : 'border-red-500/40 bg-red-500/[0.08] text-red-400'

  return (
    <article className="flex items-start gap-[9px] px-3 py-[11px] border-t border-[var(--border-color)] first:border-t-0 kb-item-in hover:bg-[var(--bg-hover)]/55 transition-colors">
      <button
        type="button"
        role="radio"
        aria-checked={isDefault}
        aria-label={`把「${entry.name}」设为全局默认`}
        data-tip={isDefault ? '当前全局默认' : '设为全局默认'}
        onClick={onSetDefault}
        className={`mt-[5px] shrink-0 grid place-items-center w-3.5 h-3.5 rounded-full border transition-colors ${
          isDefault
            ? 'border-[var(--accent)] bg-[var(--accent)]'
            : 'border-[var(--text-disabled)] hover:border-[var(--accent)]'
        }`}
      >
        {isDefault ? <span className="w-[6px] h-[6px] rounded-full bg-[var(--bg-secondary)]" /> : null}
      </button>

      <div className="min-w-0 flex-1">
        {/* 第一层：名称 / 免费 / 精选 / 删除 */}
        <div className="flex items-center gap-1 min-w-0">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { void commitName() }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
            maxLength={MODEL_NAME_MAX}
            aria-label={`条目名称 ${entry.name}`}
            placeholder={entry.modelId}
            spellCheck={false}
            className="kb-inline-input min-w-0 flex-[1_1_130px] h-[26px] rounded-md px-1.5 text-[13px] font-medium text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none transition-colors"
          />
          <button
            type="button"
            onClick={() => { void save({ free: !entry.free }) }}
            data-tip={entry.free ? '取消免费标记' : '标记为免费模型'}
            aria-label={entry.free ? '取消免费标记' : '标记为免费模型'}
            aria-pressed={!!entry.free}
            className={`shrink-0 grid place-items-center w-[26px] h-[26px] rounded-md transition-colors ${
              entry.free ? 'text-amber-400' : 'text-[var(--text-disabled)] hover:text-amber-400 hover:bg-[var(--bg-hover)]'
            }`}
          >
            <Star size={13} className={entry.free ? 'fill-amber-400' : ''} />
          </button>
          <span className="shrink-0 flex items-center gap-1 pl-0.5">
            <span className="hidden min-[420px]:inline text-[10.5px] text-[var(--text-muted)]">精选</span>
            <SettingSwitch
              size="sm"
              checked={entry.curated}
              onChange={(next) => { void save({ curated: next }) }}
              aria-label={`精选 ${entry.name}`}
            />
          </span>
          <button
            type="button"
            onClick={() => { void askRemove() }}
            disabled={busy === 'remove'}
            data-tip="删除条目"
            aria-label={`删除条目 ${entry.name}`}
            className="shrink-0 grid place-items-center w-[26px] h-[26px] rounded-md text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
          >
            {busy === 'remove' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          </button>
        </div>

        {/* 第二层：供应商 · 真实 model id（换行而不是省略号 —— 长 id 本身就是排查线索） */}
        <div className="mt-0.5 ml-[7px] flex flex-wrap items-baseline gap-x-[5px] gap-y-0 min-w-0 text-[11px] text-[var(--text-muted)]">
          <span className="text-[var(--text-secondary)]">{providerNameOf(entry.providerId)}</span>
          <span className="text-[var(--text-disabled)]" aria-hidden="true">·</span>
          <code
            title={entry.modelId}
            className="min-w-0 font-mono text-[11px] text-[var(--text-secondary)] [overflow-wrap:anywhere] break-words"
          >
            {entry.modelId}
          </code>
        </div>

        {/* 第三层：能力 / 上下文 / 测试 */}
        <div className="mt-[7px] ml-[7px] flex flex-wrap items-center gap-x-1.5 gap-y-1.5 min-w-0">
          <div role="group" aria-label="能力" className="flex flex-wrap items-center gap-1 min-w-0">
            {CAP_DEFS.map(({ key, label }) => {
              const state: LlmCapabilityState = entry.capabilities?.[key] ?? 'auto'
              const stateText = CAP_STATE_TEXT[state]
              /** 「思考」不止是展示：支持后对话里才能调思考强度（四档），所以提示里要说清后果 */
              const reasoningHint = key === 'reasoning' ? '；支持后对话里可调思考强度' : ''
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => { void cycleCapability(key, state) }}
                  disabled={busy === 'save'}
                  data-tip={`「${label}」当前：${stateText}。点击切换：跟随 → 支持 → 不支持${reasoningHint}`}
                  aria-label={`${label}能力：${stateText}${reasoningHint}`}
                  className={`shrink-0 h-5 px-1.5 rounded-[5px] border text-[10.5px] leading-none transition-colors disabled:opacity-50 ${
                    state === 'yes'
                      ? 'border-emerald-500/45 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15'
                      : state === 'no'
                        ? 'border-[var(--border-color)] text-[var(--text-disabled)] line-through hover:bg-[var(--bg-hover)]'
                        : 'border-dashed border-[var(--border-color)] text-[var(--text-disabled)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>

          {/* 右侧三件套（上下文 / 测试 / 结果胶囊）收进同一右对齐簇：
              窄宽时整簇换行，簇内再换行也不会各自为政；长错误只进胶囊的 title 与详情，
              可见文案只有「失败」，不会把卡片撑破。 */}
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <div
              className="kb-field kb-field-strong kb-field-sm flex items-center w-[78px] min-[420px]:w-[86px] shrink-0"
              title={contextWindowTitle(entry.contextWindow)}
            >
              <input
                value={win}
                onChange={(e) => setWin(e.target.value.replace(/[^\d.]/g, ''))}
                onBlur={() => { void commitWindow() }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
                inputMode="decimal"
                placeholder="跟随"
                aria-label={`上下文窗口 ${entry.name}（千 token）`}
                className="kb-field-control min-w-0 flex-1 text-right text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
              />
              {win.trim() ? <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">K</span> : null}
            </div>

            {busy === 'test' ? (
              <span className="inline-flex shrink-0 items-center gap-1 h-[22px] px-[7px] rounded-full border border-[var(--border-color)] text-[10.5px] text-[var(--text-muted)]">
                <Loader2 size={11} className="animate-spin" /> 测试中
              </span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => { void runTest() }}
                  disabled={busy !== null}
                  data-tip="发一次最小请求，只测连通性与延迟（不写入条目）"
                  aria-label={`测试条目 ${entry.name}`}
                  className="inline-flex shrink-0 items-center gap-1 h-6 px-2 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
                >
                  <Zap size={11} /> 测试
                </button>
                {out && (
                  <button
                    type="button"
                    onClick={() => setDetailOpen((v) => !v)}
                    aria-expanded={detailOpen}
                    aria-label={out.ok ? `测试结果：延迟 ${out.latencyMs ?? 0}ms` : `测试失败：${out.error ?? '未知错误'}`}
                    data-tip={out.ok ? `可用 · 延迟 ${out.latencyMs ?? 0}ms` : `失败：${out.error ?? '未知错误'}`}
                    className={`inline-flex min-w-0 items-center gap-1 h-[22px] px-[7px] rounded-full border text-[10.5px] max-w-[148px] transition-colors hover:bg-[var(--bg-hover)] ${pillTone}`}
                  >
                    <span className="w-[5px] h-[5px] rounded-full bg-current shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{testPillLabel(out)}</span>
                    <ChevronRight size={11} className={`kb-chevron shrink-0 ${detailOpen ? 'rotate-90' : ''}`} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* 测试详情：结果只在本会话存在（测试不写回条目） */}
        <Collapsible open={detailOpen} innerClassName="">
          {() => out && (
            <div
              role={out.ok ? 'status' : 'alert'}
              className={`mt-2 px-2.5 py-2 rounded-lg border ${
                out.ok
                  ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
                  : 'border-red-500/35 bg-red-500/[0.06]'
              }`}
            >
              <div className={`flex items-center gap-1.5 text-[11px] ${out.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {out.ok ? <Check size={12} /> : <AlertTriangle size={12} />}
                {out.ok ? '连接正常' : '测试失败'}
                <span className="ml-auto text-[10.5px] text-[var(--text-disabled)]">{testTimeText(out.at, Date.now())}</span>
              </div>
              <p className="mt-1 font-mono text-[10.5px] leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere] break-words">
                {out.ok
                  ? `延迟 ${out.latencyMs ?? 0}ms · 模型 ${entry.modelId} · 测试不写回条目`
                  : out.error || '未知错误'}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => { void runTest() }}
                  disabled={busy !== null}
                  className="h-[22px] px-2 rounded-[5px] border border-[var(--border-color)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
                >
                  {out.ok ? '重测' : '重试'}
                </button>
                {!out.ok && (
                  <button
                    type="button"
                    onClick={() => { void copyTestError() }}
                    className="inline-flex items-center gap-1 h-[22px] px-2 rounded-[5px] text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Copy size={10} /> 复制错误
                  </button>
                )}
              </div>
            </div>
          )}
        </Collapsible>

        {/* 删除被引用的条目：行内确认卡（不用模态、不用 window.confirm） */}
        <Collapsible open={!!refs} innerClassName="">
          {() => refs && (
            <div className="mt-2 px-2.5 py-2 rounded-lg border border-red-500/40 bg-[var(--bg-primary)]/55 kb-item-in">
              <div className="flex gap-[7px] text-[11px] leading-relaxed text-[var(--text-secondary)]">
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--warning)]" />
                <p>
                  删除「<b className="font-medium text-[var(--text-primary)]">{entry.name}</b>」？
                  它还被 <b className="font-medium text-[var(--text-primary)]">{refs.length} 处</b>
                  引用（{refsText(refs).join('、')}），删除后这些场景会退回未指定。
                </p>
              </div>
              {others.length > 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-[var(--text-muted)]">改派到</span>
                  <select
                    value={adoptTo}
                    onChange={(e) => setAdoptTo(e.target.value)}
                    aria-label="把引用改派到"
                    className="kb-field-input min-w-0 max-w-[220px] h-[26px] px-1.5 rounded-md bg-[var(--input-bg)] text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  >
                    <option value="">选择另一个条目</option>
                    {others.map((e) => (
                      <option key={e.id} value={e.id}>{entryLabel(e, providerNameOf(e.providerId))}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => { void adoptAndRemove() }}
                    disabled={!adoptTo || busy !== null}
                    className="h-[22px] px-2 rounded-[5px] border border-red-500/50 text-[10.5px] text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                  >
                    改派并删除
                  </button>
                  <button
                    type="button"
                    onClick={() => setRefs(null)}
                    className="h-[22px] px-2 rounded-[5px] text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-[var(--text-muted)]">目录里没有可改派的其他条目，先添加一个再删。</span>
                  <button
                    type="button"
                    onClick={() => setRefs(null)}
                    className="h-[22px] px-2 rounded-[5px] text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          )}
        </Collapsible>
      </div>
    </article>
  )
}

/* ============================== 统一为条目 id ============================== */

/**
 * 改写清单（行内确认卡）。
 * 只展示「槽位 → 条目」，最多 8 行（8 个槽位就是上限，留折叠是防以后加槽位撑爆版面）；
 * 失败逐个点名，绝不汇总成一句「部分失败」。
 */
function SlotRewriteCard({ plan, skipped, failures, busy, onCancel, onApply }: {
  plan: SlotRewritePlan[]
  skipped: SlotScanResult['skipped']
  failures: Array<{ slot: string; slotLabel: string; reason: string }>
  busy: boolean
  onCancel: () => void
  onApply: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  const LIMIT = 8
  const shown = showAll ? plan : plan.slice(0, LIMIT)
  const hidden = plan.length - shown.length
  const noEntry = skipped.filter((s) => s.reason === 'no-entry')

  return (
    <div
      role="group"
      aria-label="统一为条目 id 确认"
      className="mt-2 mb-3 px-3 py-2.5 rounded-[10px] border border-[var(--accent)]/40 bg-[color-mix(in_srgb,var(--accent)_4%,var(--bg-secondary))] kb-pop"
    >
      <p className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
        这些场景还在用旧写法（供应商:模型）。改写后它们指向同名条目，之后改名 / 调上下文窗口只改一处：
      </p>

      <div className="mt-1.5 rounded-[7px] border border-[var(--border-color)] bg-[var(--bg-primary)] overflow-hidden">
        {shown.map((p) => (
          <div
            key={p.slot}
            className="flex flex-wrap items-center gap-2 px-2 py-1 border-t border-[var(--border-color)] first:border-t-0 min-w-0 kb-item-in"
          >
            <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">{p.slotLabel}</span>
            <span className="min-w-0 flex-1 basis-[120px] font-mono text-[10.5px] text-[var(--text-disabled)] [overflow-wrap:anywhere]" data-tip={p.from}>
              {p.from}
            </span>
            <ArrowRightLeft size={10} className="shrink-0 text-[var(--text-disabled)]" />
            <span className="min-w-0 max-w-[45%] truncate text-[11px] text-[var(--text-primary)]" data-tip={p.to}>
              {p.entryName}
            </span>
          </div>
        ))}
      </div>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          还有 {hidden} 个槽位…
        </button>
      )}

      {noEntry.length > 0 && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
          {noEntry.length} 个槽位在条目里找不到对应模型，保持原样：
          <span className="font-mono break-words"> {noEntry.map((s) => s.from).join('、')}</span>
        </p>
      )}

      {failures.length > 0 && (
        <div role="alert" className="mt-1.5 rounded-[7px] border border-red-500/40 bg-[var(--bg-primary)] px-2 py-1.5 kb-item-in">
          {failures.map((f) => (
            <p key={f.slot} className="text-[11px] leading-relaxed text-red-400">
              {f.slotLabel} 改写失败：{f.reason}
            </p>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={busy || plan.length === 0}
          className="flex items-center gap-1 h-7 px-2.5 rounded-[7px] text-[11.5px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          {busy && <Loader2 size={11} className="animate-spin" />} {rewriteSummary(plan)}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-7 px-2.5 rounded-[7px] text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
        >
          取消
        </button>
      </div>
    </div>
  )
}

/* ============================== 添加条目 ============================== */

function AddEntryForm({ providers, onDone, onCancel }: {
  providers: LlmProviderInfo[]
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const usable = providers.filter((p) => p.enabled)
  const [pid, setPid] = useState(usable[0]?.id ?? '')
  const provider = usable.find((p) => p.id === pid) ?? null
  const [mid, setMid] = useState(provider?.models[0] ?? '')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  // 供应商清单是异步来的：表单先挂上时补一次默认选项（不覆盖用户已经点过的选择）
  useEffect(() => {
    if (pid) return
    const first = providers.find((p) => p.enabled)
    if (!first) return
    setPid(first.id)
    setMid(first.models[0] ?? '')
  }, [pid, providers])

  /** 换供应商 → 模型候选与已选模型一起换（别留下上一个端点的 model id） */
  const changeProvider = (nextId: string) => {
    setPid(nextId)
    setMid(usable.find((p) => p.id === nextId)?.models[0] ?? '')
  }

  const save = async () => {
    const err = validateSaveInput({ name, providerId: pid, modelId: mid })
    if (err) { showToast({ type: 'error', message: err }); return }
    setSaving(true)
    try {
      const r = await llmCatalogSave({ providerId: pid, modelId: mid, name: name.trim() || undefined })
      if (!r.ok) { showToast({ type: 'error', message: r.error ?? '添加失败' }); return }
      showToast({ type: 'info', message: `已添加「${r.entry?.name ?? mid}」` })
      setName('')
      await onDone()
    } finally { setSaving(false) }
  }

  return (
    <div
      role="group"
      aria-label="添加模型条目"
      className="mt-2 mb-3 px-3 py-2.5 rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] kb-pop"
    >
      {usable.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
          还没有启用的供应商 —— 先在「供应商」里添加并启用一个，再回来挑模型。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 flex-1 basis-[140px] min-w-0">
              <span className="text-[10.5px] text-[var(--text-muted)]">供应商</span>
              <select
                value={pid}
                onChange={(e) => changeProvider(e.target.value)}
                aria-label="选择供应商"
                className="kb-field-input w-full min-w-0 h-8 px-2 rounded-lg bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              >
                {usable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 flex-1 basis-[140px] min-w-0">
              <span className="text-[10.5px] text-[var(--text-muted)]">模型</span>
              <select
                value={mid}
                onChange={(e) => setMid(e.target.value)}
                aria-label="选择模型"
                disabled={!provider || provider.models.length === 0}
                className="kb-field-input w-full min-w-0 h-8 px-2 rounded-lg bg-[var(--input-bg)] text-[12px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-40"
              >
                {(provider?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 flex-1 basis-[140px] min-w-0">
              <span className="text-[10.5px] text-[var(--text-muted)]">名称（可留空）</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MODEL_NAME_MAX}
                placeholder="例如 写作模型"
                aria-label="条目名称"
                className="kb-field-input w-full min-w-0 h-8 px-2 rounded-lg bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-[var(--accent)]"
              />
            </label>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { void save() }}
              disabled={saving || !mid}
              className="flex items-center gap-1 h-7 px-2.5 rounded-[7px] text-[11.5px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {saving && <Loader2 size={12} className="animate-spin" />} 保存
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="h-7 px-2.5 rounded-[7px] text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              取消
            </button>
          </div>

          {provider && provider.models.length === 0 && (
            <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
              该供应商还没有模型清单：先在「供应商」里展开它，点「获取可用模型」。
            </p>
          )}
        </>
      )}
    </div>
  )
}
