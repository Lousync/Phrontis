import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, FileText, Loader2, Paperclip, Plus, RefreshCw, Repeat, Trash2, X } from 'lucide-react'
import type { AiTeachCourseOutline, AiTeachCourseUnitProgress, AiTeachCourseUnitStatus, AiTeachLessonInfo, AiTeachScopedSourcesResult, AiTeachSourceEntry } from '../../types'
import {
  aiTeachCourseRemoveUnit, aiTeachCourseSetUnitProgress,
  aiTeachScopeEnsure, aiTeachScopeRead, aiTeachScopeWriteText, aiTeachSourceAddScoped, aiTeachSourcesReadScoped,
} from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { FLOW_ST_LABEL } from './flow/flowStatus'
import { applyConstraintEdits, parseConstraintItems } from './constraintsParse'
import type { FlowScope } from './flow/flowLayout'

/**
 * AI教学 · 右栏「层级」面（课程模式的学习流选中层详情）。
 *
 * 方案：`E:\Projects\KnowledgeRecorder\.AGENT\.claude\plans\ai-teaching-flow-v2-impl.md` §三-1
 * 原型：`E:\Projects\KnowledgeRecorder\tmp\aiteach-flow-proto-v2\index.html`（`renderRight`）
 *
 * 三个页签：**推进 / 要求 / 素材**。
 *   · 推进（仅知识点层）：状态段选 · 掌握度**只读** · 课时 · 产物 · 收尾自测 · 删除知识点（**行内确认**，铁律 25）
 *   · 要求：本层条目化编辑（`constraintsParse` 行级增删改，非条目行原文只读）+ 继承层只读
 *   · 素材：本层 + 继承（工作区主库）
 *
 * 分层口径（§二-16 / §三-3）：
 *   · 可写层只有 **工作区 / 知识点** 两层；**章层本层不做** —— 章层只显示「本层未启用」+ 继承 + 本章进度，
 *     绝不给一个点了没反应的假按钮。
 *   · 掌握度只读（§15）：只由练习判分与 AI 建议更新，这里**不接** `aiTeachCourseSetUnitProgress` 的 mastery。
 */

export type ScopeTab = 'drive' | 'req' | 'src'

interface Props {
  wsId: string
  wsName: string
  scope: FlowScope
  outline: AiTeachCourseOutline | null
  progress: Record<string, AiTeachCourseUnitProgress>
  lessons: Record<string, AiTeachLessonInfo>
  /** 收尾自测（index.tsx 出题 → 作答 → 生成总结篇） */
  onFinishQuiz: (unitId: string) => void
  /** 章末复习课 */
  onOpenChapterReview: (chapterId: string) => void
  /** 开新课（= 开始学该知识点） */
  onStartUnit: (unitId: string) => void
  /** 删掉知识点后回到工作区层（该层已经不在了） */
  onScopeGone: () => void
  /** 选中态被外部改（例如点面包屑） */
  onSelectScope: (scope: FlowScope) => void
  /** 数据变更后让上层重拉课程态（删除 / 状态改写都会广播，这里只做兜底刷新） */
  onReload: () => void
}

const ST_ORDER: AiTeachCourseUnitStatus[] = ['todo', 'learning', 'check', 'mastered', 'review']

export function ScopeDetail(props: Props) {
  const { wsId, wsName, scope, outline, progress, lessons, onFinishQuiz, onOpenChapterReview, onStartUnit, onScopeGone, onSelectScope, onReload } = props
  const level = scope.level
  const unitId = level === 'unit' ? scope.unitId ?? null : null
  const chapterId = scope.chapterId ?? (unitId ? findChapterOf(outline, unitId) : null)

  const unit = useMemo(() => {
    if (!unitId) return null
    for (const c of outline?.chapters ?? []) for (const u of c.units) if (u.id === unitId) return u
    return null
  }, [outline, unitId])
  const chapter = useMemo(
    () => (chapterId ? (outline?.chapters ?? []).find((c) => c.id === chapterId) ?? null : null),
    [outline, chapterId],
  )

  const [tab, setTab] = useState<ScopeTab>(level === 'unit' ? 'drive' : 'req')
  /** 换层：知识点 → 默认「推进」；章 / 工作区层没有推进面 → 「要求」 */
  useEffect(() => { setTab(level === 'unit' ? 'drive' : 'req') }, [level, unitId, chapterId])

  const [loading, setLoading] = useState(false)
  const [unitReq, setUnitReq] = useState<{ text: string; relPath: string | null } | null>(null)
  const [wsReq, setWsReq] = useState<{ text: string; relPath: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [newItem, setNewItem] = useState('')
  const [srcs, setSrcs] = useState<AiTeachScopedSourcesResult | null>(null)
  const [pendingDel, setPendingDel] = useState(false)
  const [addingSrc, setAddingSrc] = useState(false)
  const [srcName, setSrcName] = useState('')
  const [srcPath, setSrcPath] = useState('')

  const load = useCallback(async () => {
    if (!wsId) return
    setLoading(true)
    // 本层要求：只有 工作区 / 知识点 两层可写；章层故意不发请求（本层未启用）
    const unitRef = unitId ? await aiTeachScopeRead({ wsId, level: 'unit', unitId }).catch(() => null) : null
    const wsRef = await aiTeachScopeRead({ wsId, level: 'workspace' }).catch(() => null)
    setUnitReq(unitRef?.ok ? { text: unitRef.text ?? '', relPath: unitRef.relPath ?? null } : null)
    setWsReq(wsRef?.ok ? { text: wsRef.text ?? '', relPath: wsRef.relPath ?? null } : null)
    const scoped = await aiTeachSourcesReadScoped(wsId, unitId ?? null).catch(() => null)
    setSrcs(scoped && scoped.ok ? scoped : null)
    setLoading(false)
  }, [wsId, unitId])

  useEffect(() => { void load() }, [load])

  /** 本层（知识点 / 工作区）当前的「要求」文档 —— 章层没有本层 */
  const editable = level === 'unit' || level === 'workspace'
  const localReq = level === 'unit' ? unitReq : level === 'workspace' ? wsReq : null
  const items = useMemo(() => (localReq ? parseConstraintItems(localReq.text) : []), [localReq])

  const writeItems = useCallback(async (edits: Parameters<typeof applyConstraintEdits>[1]) => {
    if (!editable || !localReq) return
    const next = applyConstraintEdits(localReq.text, edits)
    if (next === localReq.text) return
    setBusy(true)
    const ref = level === 'unit' && unitId
      ? ({ wsId, level: 'unit', unitId } as const)
      : ({ wsId, level: 'workspace' } as const)
    const r = await aiTeachScopeWriteText(ref, next).catch(() => null)
    setBusy(false)
    if (!r?.ok) { showToast({ type: 'error', message: `要求写入失败（${r?.error ?? '未知错误'}）` }); return }
    // 乐观更新（写盘成功后主进程会广播，画布上的「要求 N」跟着变）
    if (level === 'unit') setUnitReq({ text: next, relPath: r.relPath ?? localReq.relPath })
    else setWsReq({ text: next, relPath: r.relPath ?? localReq.relPath })
  }, [editable, localReq, level, unitId, wsId])

  const openDoc = useCallback(async () => {
    if (!editable) return
    const ref = level === 'unit' && unitId
      ? ({ wsId, level: 'unit', unitId } as const)
      : ({ wsId, level: 'workspace' } as const)
    // ensure：缺文件就按骨架建出来再开 —— 「打开文档」不该在文件不存在时变成一句 Toast
    const r = await aiTeachScopeEnsure(ref).catch(() => null)
    if (r?.ok && r.relPath) {
      window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: r.relPath, from: 'aiTeaching' } }))
      if (r.created) showToast({ type: 'info', message: '这一层的要求文档已按骨架创建', detail: '保存后本层会话下一轮生效' })
      void load()
      return
    }
    showToast({ type: 'error', message: `要求文档打开失败（${r?.error ?? '未知错误'}）` })
  }, [editable, level, unitId, wsId, load])

  const setStatus = useCallback(async (st: AiTeachCourseUnitStatus) => {
    if (!unitId) return
    const r = await aiTeachCourseSetUnitProgress(wsId, unitId, { status: st }).catch(() => null)
    if (!r?.ok) showToast({ type: 'warning', message: `状态写入失败（${r?.error ?? '未知错误'}）` })
  }, [wsId, unitId])

  const removeUnit = useCallback(async () => {
    if (!unitId) return
    setBusy(true)
    const r = await aiTeachCourseRemoveUnit(wsId, unitId).catch(() => null)
    setBusy(false)
    setPendingDel(false)
    if (!r?.ok) { showToast({ type: 'error', message: `删除失败（${r?.error ?? '未知错误'}）` }); return }
    showToast({ type: 'info', message: `已删除知识点 ${unitId}`, detail: '它的课时与产物退回「零散对话」，进度记录一并删除' })
    onScopeGone()
    onReload()
  }, [wsId, unitId, onScopeGone, onReload])

  const addSource = useCallback(async () => {
    if (!unitId) return
    const name = srcName.trim(), p = srcPath.trim()
    if (!name || !p) { showToast({ type: 'warning', message: '名称与路径都要填' }); return }
    setBusy(true)
    const r = await aiTeachSourceAddScoped(wsId, unitId, { name, path: p, storage: '仅引用' }).catch(() => null)
    setBusy(false)
    if (!r?.ok) { showToast({ type: 'error', message: `素材登记失败（${r?.error ?? '未知错误'}）` }); return }
    setAddingSrc(false); setSrcName(''); setSrcPath('')
    await load()          // 分层视图整份重读（addScoped 只回单层结果）
    onReload()
  }, [wsId, unitId, srcName, srcPath, onReload, load])

  /* ---------------------------------------------------------------- 面包屑 */

  const crumb = useMemo(() => {
    const parts: Array<{ label: string; scope: FlowScope }> = []
    parts.push({ label: '工作区', scope: { level: 'workspace' } })
    if (chapter && level !== 'workspace') parts.push({ label: chapter.name.split(' · ')[0], scope: { level: 'chapter', chapterId: chapter.id } })
    if (unit && level === 'unit') parts.push({ label: unit.id, scope: { level: 'unit', unitId: unit.id, chapterId: chapter?.id } })
    return parts
  }, [chapter, unit, level])

  const title = level === 'unit' ? `${unit?.id ?? ''} ${unit?.name ?? ''}`.trim()
    : level === 'chapter' ? chapter?.name ?? '本章'
      : '工作区要求'
  const relPath = level === 'unit' ? unitReq?.relPath ?? null : level === 'workspace' ? wsReq?.relPath ?? null : null

  const doneCount = chapter ? chapter.units.filter((u) => progress[u.id]?.status === 'mastered').length : 0

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* 页签：章 / 工作区层没有「推进」面（那不是知识点） */}
      <div className="shrink-0 flex items-center gap-1 border-b border-[var(--border-color)] px-1.5 py-1 bg-[var(--bg-secondary)]">
        {level === 'unit' && <TabBtn on={tab === 'drive'} onClick={() => setTab('drive')}>推进</TabBtn>}
        <TabBtn on={tab === 'req'} onClick={() => setTab('req')}>要求</TabBtn>
        <TabBtn on={tab === 'src'} onClick={() => setTab('src')}>素材</TabBtn>
        <span className="flex-1" />
        <button onClick={() => void load()} title="重新读取这一层"
          className="px-1.5 py-1 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <RefreshCw size={11} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2">
        {/* 面包屑 */}
        <div className="flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] flex-wrap">
          {crumb.map((c, i) => (
            <span key={`${c.label}-${i}`} className="flex items-center gap-1">
              {i > 0 && <span className="opacity-40">›</span>}
              <button onClick={() => onSelectScope(c.scope)}
                className={i === crumb.length - 1 ? 'text-[var(--text-secondary)]' : 'hover:text-[var(--text-primary)]'}>{c.label}</button>
            </span>
          ))}
        </div>
        <div className="mt-1 text-[13px] font-semibold text-[var(--text-primary)] leading-snug break-words">{title || '未选中'}</div>
        {relPath && <div className="mt-0.5 text-[10.5px] text-[var(--text-muted)] break-all">{relPath}</div>}

        {loading && !localReq && (
          <div className="mt-4 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><Loader2 size={12} className="animate-spin" />读取中…</div>
        )}

        {/* ---------------- 推进（仅知识点层） ---------------- */}
        {tab === 'drive' && level === 'unit' && unit && (
          <div className="mt-3 space-y-3">
            <Group title="状态">
              <div className="flex flex-wrap gap-1">
                {ST_ORDER.map((st) => {
                  const on = (progress[unit.id]?.status ?? 'todo') === st
                  return (
                    <button key={st} onClick={() => void setStatus(st)}
                      className={`px-2 py-0.5 rounded-md border text-[11px] kb-press ${on ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>
                      {FLOW_ST_LABEL[st] ?? st}
                    </button>
                  )
                })}
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-[17px] font-semibold text-[var(--text-primary)] tabular-nums">{Math.round((progress[unit.id]?.mastery ?? 0) * 100)}%</span>
                <span className="text-[10.5px] text-[var(--text-muted)]">掌握度 · 只读</span>
              </div>
              <div className="mt-0.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">只由练习判分与 AI 建议更新；这里不接写入（§15）。</div>
            </Group>

            <Group title={`课时（${Object.values(lessons ?? {}).filter((l) => l.unitId === unit.id).length}）`}
              right={<button onClick={() => onStartUnit(unit.id)} className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"><Plus size={10} />开新课</button>}>
              {(() => {
                const ls = Object.values(lessons ?? {}).filter((l) => l.unitId === unit.id).sort((a, b) => a.order - b.order)
                if (!ls.length) return <Row muted>这节课还没开过：点卡片上的「开始学」或这里「开新课」</Row>
                return ls.map((l) => (
                  <Row key={`${unit.id}-${l.kind}-${l.order}`}>
                    <span className="text-[9.5px] px-1 rounded-[8px] bg-[var(--bg-hover)] text-[var(--text-muted)] shrink-0">课时{l.order}</span>
                    <span className="flex-1 min-w-0 truncate text-[11.5px]">{l.kind}</span>
                    <span className="text-[10px] text-[var(--text-muted)] shrink-0">{l.status === 'ended' ? '已结束' : '进行中'}</span>
                  </Row>
                ))
              })()}
            </Group>

            <Group title="产物">
              {progress[unit.id]?.summaryRel
                ? <Row><FileText size={11} className="shrink-0 text-[var(--text-muted)]" /><span className="flex-1 min-w-0 truncate text-[11.5px]">总结篇</span>
                  <span className="text-[10px] text-[var(--text-muted)] shrink-0 truncate max-w-[120px]">{progress[unit.id]?.summaryRel}</span></Row>
                : <Row muted>暂无产物（收尾自测后生成总结篇）</Row>}
            </Group>

            <Group title="收尾">
              <button onClick={() => onFinishQuiz(unit.id)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--success)]/40 text-[var(--success)] text-[11.5px] hover:bg-[var(--success)]/10 kb-press">
                <ArrowRight size={11} />结束本知识点（收尾自测）
              </button>
              <div className="mt-1 text-[10.5px] leading-relaxed text-[var(--text-muted)]">先出题 → 作答 → 再生成总结篇。课时全部结束后才有意义。</div>
            </Group>

            <Group title="危险操作">
              {!pendingDel ? (
                <button onClick={() => setPendingDel(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--danger)]/50 text-[var(--danger)] text-[11.5px] hover:bg-[var(--danger)]/10 kb-press">
                  <Trash2 size={11} />删除这个知识点
                </button>
              ) : (
                <div className="rounded-md border border-[var(--danger)]/40 px-2 py-1.5">
                  <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    <AlertTriangle size={12} className="shrink-0 mt-0.5 text-[var(--danger)]" />
                    <span>删除知识点 {unit.id}？它的课时与产物会退回「零散对话」，进度记录一并删除。</span>
                  </div>
                  <div className="mt-1.5 flex justify-end gap-1.5">
                    <button onClick={() => setPendingDel(false)} className="px-2 py-0.5 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
                    <button disabled={busy} onClick={() => void removeUnit()}
                      className="px-2 py-0.5 rounded-md bg-[var(--danger)] text-white text-[11px] disabled:opacity-50">确认删除</button>
                  </div>
                </div>
              )}
            </Group>
          </div>
        )}

        {/* ---------------- 章层：只有继承 + 本章进度（本层未启用） ---------------- */}
        {tab === 'req' && level === 'chapter' && chapter && (
          <div className="mt-3 space-y-3">
            <Group title="本章知识点">
              <div className="text-[11.5px] text-[var(--text-secondary)]">{chapter.units.length} 个 · 已掌握 <b className="text-[var(--text-primary)]">{doneCount}</b></div>
            </Group>
            <Group title="本层 · 本章">
              <Row muted>本层未启用 —— 章层本层的「要求」不做（§二-16 / §三-3）。想把本章的要求写下来，请写到工作区层或具体知识点上。</Row>
            </Group>
            <Group title="继承 · 工作区（只读）">
              {wsReq?.relPath && <div className="text-[10px] text-[var(--text-muted)] break-all mb-0.5">{wsReq.relPath}</div>}
              <ReqItems text={wsReq?.text ?? ''} emptyHint={`${wsName || '本工作区'} 还没有工作区级要求`} />
            </Group>
            <Group title="章末">
              <button onClick={() => onOpenChapterReview(chapter.id)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--accent)]/40 text-[var(--accent)] text-[11.5px] hover:bg-[var(--accent)]/10 kb-press">
                <Repeat size={11} />进入章末复习课
              </button>
            </Group>
          </div>
        )}

        {/* ---------------- 要求（知识点 / 工作区层可写） ---------------- */}
        {tab === 'req' && editable && (
          <div className="mt-3 space-y-3">
            <Group title={level === 'unit' ? '本层 · 本知识点' : '本层 · 工作区'}
              right={<button onClick={() => void openDoc()} className="text-[11px] text-[var(--accent)] hover:underline">打开文档</button>}>
              {!localReq && <Row muted>这一层的要求文档读不到（可能还没建立）。点「打开文档」会按骨架创建。</Row>}
              {localReq && items.length === 0 && <Row muted>还没有条目。加一条之后，AI 每轮都会读到它。</Row>}
              {items.map((it, i) => (
                <div key={`${i}-${it.line}`} className="flex items-start gap-1.5 py-0.5 group">
                  <span className="shrink-0 text-[var(--text-muted)] leading-relaxed">◦</span>
                  <input defaultValue={it.text} disabled={busy}
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      if (v === it.text) return
                      if (!v) { void writeItems([{ op: 'remove', index: i }]); return }
                      void writeItems([{ op: 'update', index: i, text: v }])
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    className="flex-1 min-w-0 bg-transparent text-[11.5px] leading-relaxed text-[var(--text-secondary)] border-b border-transparent focus:border-[var(--accent)] focus:text-[var(--text-primary)] outline-none" />
                  <button title="删除这条" disabled={busy} onClick={() => void writeItems([{ op: 'remove', index: i }])}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--danger)] transition-opacity"><X size={11} /></button>
                </div>
              ))}
              <div className="mt-1 flex items-center gap-1">
                <input value={newItem} onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    const v = newItem.trim()
                    if (!v) return
                    void writeItems([{ op: 'add', text: v }])
                    setNewItem('')
                  }}
                  placeholder="＋ 加一条（回车提交）"
                  className="flex-1 min-w-0 bg-transparent text-[11.5px] px-1 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]" />
              </div>
              {/* 非条目行只读：说清「你写的说明段落我们没动」 */}
              {items.length > 0 && (
                <div className="mt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">只编辑 `- ` 开头的条目行；文档里的标题与说明段落原文保留，不会被这里改写。</div>
              )}
            </Group>
            {level === 'unit' && (
              <Group title="继承 · 工作区（只读）">
                {wsReq?.relPath && <div className="text-[10px] text-[var(--text-muted)] break-all mb-0.5">{wsReq.relPath}</div>}
                <ReqItems text={wsReq?.text ?? ''} emptyHint={`${wsName || '本工作区'} 还没有工作区级要求`} />
              </Group>
            )}
            {level === 'unit' && (
              <Group title="继承 · 全局">
                <Row muted>全局要求在上方顶栏「要求」入口编辑（跨工作区共享）。</Row>
              </Group>
            )}
            {level === 'unit' && (
              <Group title="继承 · 章">
                <Row muted>章层本层的要求不做（§二-16）；本章只提供进度与复习课入口。</Row>
              </Group>
            )}
          </div>
        )}

        {/* ---------------- 素材 ---------------- */}
        {tab === 'src' && (
          <div className="mt-3 space-y-3">
            <Group title={level === 'unit' ? '本层 · 本知识点' : '工作区主库'}
              right={level === 'unit'
                ? <button onClick={() => setAddingSrc((v) => !v)} className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"><Plus size={10} />加素材</button>
                : undefined}>
              {addingSrc && level === 'unit' && (
                <div className="mb-1.5 rounded-md border border-[var(--border-color)] p-1.5 space-y-1">
                  <input value={srcName} onChange={(e) => setSrcName(e.target.value)} placeholder="名称（例：课件 · 动态规划）"
                    className="w-full bg-transparent text-[11.5px] px-1 py-0.5 rounded border border-[var(--border-color)] outline-none focus:border-[var(--accent)]" />
                  <input value={srcPath} onChange={(e) => setSrcPath(e.target.value)} placeholder="路径 / URL（仅引用，不复制）"
                    className="w-full bg-transparent text-[11.5px] px-1 py-0.5 rounded border border-[var(--border-color)] outline-none focus:border-[var(--accent)]" />
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => setAddingSrc(false)} className="px-2 py-0.5 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)]">取消</button>
                    <button disabled={busy} onClick={() => void addSource()} className="px-2 py-0.5 rounded-md bg-[var(--accent)] text-white text-[11px] disabled:opacity-50">登记</button>
                  </div>
                </div>
              )}
              <SrcList entries={level === 'unit' ? srcs?.unit ?? [] : srcs?.workspace ?? []} emptyHint="本层还没有素材" />
            </Group>
            {level === 'unit' && (
              <Group title="继承 · 工作区主库">
                <SrcList entries={srcs?.workspace ?? []} emptyHint="工作区主库还没有素材" />
              </Group>
            )}
            {level === 'chapter' && <Group title="本层 · 本章"><Row muted>本层未启用（§二-16）</Row></Group>}
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 小组件 */

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center justify-center px-2 py-1 rounded-md text-[11.5px] transition-colors ${on ? 'bg-[var(--bg-primary)] text-[var(--accent)] font-medium shadow-sm' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
      {children}
    </button>
  )
}

function Group({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-[var(--text-muted)] mb-1">
        <span className="min-w-0 truncate">{title}</span>
        <span className="flex-1" />
        {right}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function Row({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-1 py-0.5 rounded ${muted ? 'text-[10.5px] leading-relaxed text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}>
      {children}
    </div>
  )
}

function SrcList({ entries, emptyHint }: { entries: AiTeachSourceEntry[]; emptyHint: string }) {
  if (!entries.length) return <Row muted>{emptyHint}</Row>
  return (
    <>
      {entries.map((e) => (
        <Row key={`${e.no}-${e.name}`}>
          <Paperclip size={10} className="shrink-0 text-[var(--text-muted)]" />
          <span className="text-[9.5px] px-1 rounded-[8px] bg-[var(--bg-hover)] text-[var(--text-muted)] shrink-0">{e.type}</span>
          <span className="flex-1 min-w-0 truncate text-[11.5px]" title={e.path}>{e.no}. {e.name}</span>
          <span className="text-[10px] text-[var(--text-muted)] shrink-0">{e.range && e.range !== '-' ? e.range : ''}{e.extracted && e.extracted !== '-' ? ' · 有正文' : ''}</span>
        </Row>
      ))}
    </>
  )
}

/** 继承层的条目（只读）：只渲染 `- ` 条目，不提供任何编辑入口 */
function ReqItems({ text, emptyHint }: { text: string; emptyHint: string }) {
  const items = parseConstraintItems(text)
  if (!items.length) return <Row muted>{emptyHint}</Row>
  return (
    <>
      {items.map((it, i) => (
        <div key={`${i}-${it.line}`} className="flex items-start gap-1.5 px-1 py-0.5">
          <span className="shrink-0 text-[var(--text-muted)] leading-relaxed">◦</span>
          <span className="flex-1 min-w-0 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{it.text}</span>
        </div>
      ))}
    </>
  )
}

function findChapterOf(outline: AiTeachCourseOutline | null, unitId: string): string | null {
  for (const c of outline?.chapters ?? []) if (c.units.some((u) => u.id === unitId)) return c.id
  return null
}

export default ScopeDetail
