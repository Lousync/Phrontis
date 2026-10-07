import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Database, Download, Trash2, RefreshCw, FolderOpen, AlertTriangle, CheckCircle2, Star, BookMarked, Layers, StickyNote, Tag, CalendarClock, Sparkles } from 'lucide-react'
import type { QuizDataStats } from '../../../types'
import { quizDataStats, quizDataExport, quizDataClearMastered, quizDataClearAll } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'

/**
 * 错题本「数据」面板。
 *
 * 前身是 QuizMigratePanel——展示「主表 ⇄ 插件命名空间表」迁移状态，满屏
 * 表名（records / record_collections …）和 plugin_knowbase_quizbook_* 术语，
 * 且错题本内置化后那套桶已成死数据，面板恒显示 0 行。现改为直接读 vault 错题数据：
 * - 用业务语言给结论：题目 / 待复习 / 已掌握 / 收藏 / 今日新增错题 / 重刷正确率
 * - 分布按「书（科目·知识点）」与「错次档位」两维展示，和书架、分档一一对应
 * - 操作用户化：导出备份 / 清空已掌握 / 清空全部（后者内联二次确认 + 先导出入口）
 * - 动效走全局基建（kb-item-in 逐项入场、transform 生长的进度条、kb-collapse 确认条）
 */
export function QuizDataPanel({ spaceName, onClose, onDataChanged }: {
  /** 当前学习空间名；不传 = 全部知识空间 */
  spaceName?: string
  onClose: () => void
  /** 数据被清理后回调宿主刷新错题列表与统计 */
  onDataChanged?: () => void
}) {
  const [stats, setStats] = useState<QuizDataStats | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** 内联二次确认：'mastered' 清空已掌握 / 'all' 清空全部 */
  const [confirming, setConfirming] = useState<'mastered' | 'all' | null>(null)
  /** 上次操作结果（导出路径这类长信息需要留痕，toast 转瞬即逝） */
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  /** 进度条生长开关：挂载后置 true，让 scaleX 从 0 过渡到目标值 */
  const [grown, setGrown] = useState(false)

  const scope = spaceName ?? ''

  const refresh = useCallback(async () => {
    try { setStats(await quizDataStats(scope ? { sourceSpace: scope } : undefined)) } catch { /* ignore */ }
  }, [scope])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const t = window.setTimeout(() => setGrown(true), 40)
    return () => window.clearTimeout(t)
  }, [])
  // 数据每次刷新后重跑生长动画（清空后条形要跟着缩）
  useEffect(() => { setGrown(false); const t = window.setTimeout(() => setGrown(true), 40); return () => window.clearTimeout(t) }, [stats])

  const runExport = async () => {
    setBusy('export')
    try {
      const r = await quizDataExport(scope ? { sourceSpace: scope } : undefined)
      if (r.ok) {
        setResult({ ok: true, text: `已导出 ${r.count ?? 0} 条错题记录到：${r.path}` })
        showToast({ type: 'info', message: '备份已导出' })
      } else {
        setResult({ ok: false, text: `导出失败：${r.error ?? '未知错误'}` })
      }
    } catch (e) { setResult({ ok: false, text: `导出异常：${String(e)}` }) }
    setBusy(null)
  }

  const runClear = async (which: 'mastered' | 'all') => {
    setBusy(which)
    try {
      const r = which === 'mastered'
        ? await quizDataClearMastered(scope ? { sourceSpace: scope } : undefined)
        : await quizDataClearAll(scope ? { sourceSpace: scope } : undefined)
      if (r.ok) {
        setResult({ ok: true, text: which === 'mastered' ? `已清空 ${r.removed} 条已掌握记录` : `已清空 ${r.removed} 条错题记录` })
        showToast({ type: 'info', message: which === 'mastered' ? '已清空已掌握' : '已清空全部' })
        onDataChanged?.()
      } else {
        setResult({ ok: false, text: `清理失败：${r.error ?? '未知错误'}` })
      }
    } catch (e) { setResult({ ok: false, text: `清理异常：${String(e)}` }) }
    setBusy(null)
    setConfirming(null)
    await refresh()
  }

  /** 概览卡片（6 张：题目 / 待复习 / 已掌握 / 收藏 / 备注 / 今日错） */
  const cards = useMemo(() => {
    if (!stats) return []
    return [
      { key: 'total', label: '题目总数', value: stats.total, hint: '本错题本已收录', icon: BookMarked, tone: 'var(--text-primary)' },
      { key: 'wrong', label: '待复习', value: stats.wrong, hint: '连续答对 2 次即掌握', icon: AlertTriangle, tone: 'var(--danger)' },
      { key: 'mastered', label: '已掌握', value: stats.mastered, hint: '已移出错题本', icon: CheckCircle2, tone: 'var(--success)' },
      { key: 'fav', label: '收藏', value: stats.favorite, hint: '星标好题', icon: Star, tone: 'var(--warning)' },
      { key: 'notes', label: '写了备注', value: stats.notes, hint: '自己的理解', icon: StickyNote, tone: 'var(--text-secondary)' },
      { key: 'today', label: '今日答错', value: stats.todayWrong, hint: '今天新增的错题', icon: CalendarClock, tone: 'var(--danger)' },
    ]
  }, [stats])

  const maxBand = Math.max(1, ...(stats?.byBand ?? []).map(b => b.count))
  const maxBook = Math.max(1, ...(stats?.byBook ?? []).map(b => b.total))
  const bandTone = (key: string) => key === 'stubborn' ? 'var(--danger)' : key === 'mid' ? 'var(--warning)' : 'var(--success)'

  return (
    <div className="kb-overlay absolute inset-0 z-[60] bg-[var(--bg-primary)]/60 backdrop-blur-[2px] flex items-center justify-center p-6" role="dialog" aria-label="错题本数据">
      <div className="w-full max-w-[760px] max-h-full flex flex-col rounded-xl overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-2xl">
        {/* 顶栏 */}
        <div className="shrink-0 flex items-center gap-2.5 px-4 h-11 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <Database size={14} className="text-[var(--accent)]" />
          <span className="text-[13px] font-medium text-[var(--text-primary)]">错题本数据</span>
          <span className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[10.5px] text-[var(--text-secondary)]">{spaceName || '全部知识空间'}</span>
          <div className="flex-1" />
          <button onClick={() => void refresh()} title="刷新" className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
          </button>
          <button onClick={onClose} className="flex items-center gap-1 px-2 py-1 rounded text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            <X size={14} />
            关闭
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {!stats ? (
            <div className="py-16 text-center text-[12px] text-[var(--text-muted)]">正在读取…</div>
          ) : (
            <>
              {/* 概览：6 张卡，kb-item-in 逐项入场 */}
              <section>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {cards.map((c, i) => (
                    <div
                      key={c.key}
                      className="kb-item-in rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5"
                      style={{ animationDelay: `${i * 30}ms` }}
                    >
                      <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                        <c.icon size={12} style={{ color: c.tone }} />
                        {c.label}
                      </div>
                      <div className="mt-1 flex items-baseline gap-1.5">
                        <span className="text-[20px] font-medium leading-none" style={{ color: c.tone }}>{c.value}</span>
                        <span className="text-[10.5px] text-[var(--text-muted)]">{c.hint}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11.5px] text-[var(--text-secondary)]">
                  <span className="inline-flex items-center gap-1"><Sparkles size={11} className="text-[var(--accent)]" />重刷正确率 <b className="text-[var(--accent)]">{stats.correctRate}%</b></span>
                  <span className="inline-flex items-center gap-1"><Tag size={11} />标签 {stats.tags} 个</span>
                  <span className="inline-flex items-center gap-1"><Layers size={11} />自定义分组 {stats.collections} 个</span>
                </div>
              </section>

              {/* 分布：错次档位 + 按书（科目 / 知识点） */}
              <section>
                <h3 className="mb-2 text-[12px] font-medium text-[var(--text-secondary)]">错题分布</h3>
                <div className="grid gap-4 md:grid-cols-2">
                  {/* 错次档位 */}
                  <div className="rounded-lg border border-[var(--border-color)] overflow-hidden">
                    <div className="px-3 py-1.5 bg-[var(--bg-secondary)] text-[11px] text-[var(--text-muted)]">按错次档位</div>
                    <div className="px-3 py-2.5 space-y-2.5">
                      {stats.byBand.map((b, i) => (
                        <div key={b.key} className="kb-item-in" style={{ animationDelay: `${i * 40}ms` }}>
                          <div className="flex items-center justify-between text-[11.5px]">
                            <span className="text-[var(--text-secondary)]">{b.label}</span>
                            <span className="font-medium text-[var(--text-primary)]">{b.count} 题</span>
                          </div>
                          <div className="mt-1 h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                            <span
                              className="block h-full rounded-full origin-left"
                              style={{
                                background: bandTone(b.key),
                                transform: `scaleX(${grown ? b.count / maxBand : 0})`,
                                transition: `transform var(--dur-large) var(--ease-kb) ${i * 40}ms`,
                              }}
                            />
                          </div>
                        </div>
                      ))}
                      {stats.wrong === 0 && (
                        <div className="text-[11.5px] text-[var(--text-muted)]">暂无待复习错题</div>
                      )}
                    </div>
                  </div>

                  {/* 按书 */}
                  <div className="rounded-lg border border-[var(--border-color)] overflow-hidden">
                    <div className="px-3 py-1.5 bg-[var(--bg-secondary)] text-[11px] text-[var(--text-muted)]">按知识点（学科分册）</div>
                    <div className="px-3 py-2.5 space-y-2.5">
                      {stats.byBook.length === 0 && <div className="text-[11.5px] text-[var(--text-muted)]">暂无数据</div>}
                      {stats.byBook.map((b, i) => (
                        <div key={b.name} className="kb-item-in" style={{ animationDelay: `${i * 40}ms` }}>
                          <div className="flex items-center justify-between text-[11.5px]">
                            <span className="truncate text-[var(--text-secondary)]" title={b.name}>{b.name}</span>
                            <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                              <b className="text-[var(--text-primary)]">{b.total}</b> 题 · 错 <b className="text-[var(--danger)]">{b.wrong}</b>
                              {b.mastered > 0 && <> · 掌握 <b className="text-[var(--success)]">{b.mastered}</b></>}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                            <span
                              className="block h-full rounded-full origin-left bg-[var(--accent)]"
                              style={{
                                transform: `scaleX(${grown ? b.total / maxBook : 0})`,
                                transition: `transform var(--dur-large) var(--ease-kb) ${i * 40}ms`,
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* 存储位置 */}
              <section>
                <h3 className="mb-2 text-[12px] font-medium text-[var(--text-secondary)]">存储位置</h3>
                <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
                  <div className="flex items-start gap-1.5 text-[11.5px] text-[var(--text-primary)]">
                    <FolderOpen size={12} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
                    <span className="break-all font-mono">{stats.vaultRoot || '（未打开仓库）'}\.knowbase\modules\quiz\</span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
                    错题记录、分组、标签都以明文 JSON 存在当前仓库里，随仓库一起拷贝 / 备份 / 版本管理。
                    换一个仓库就是另一本错题本，互不影响。
                  </p>
                </div>
              </section>

              {/* 数据操作 */}
              <section>
                <h3 className="mb-2 text-[12px] font-medium text-[var(--text-secondary)]">数据操作</h3>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void runExport()}
                    disabled={busy !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
                  >
                    <Download size={13} /> 导出备份
                  </button>
                  <button
                    onClick={() => setConfirming(confirming === 'mastered' ? null : 'mastered')}
                    disabled={busy !== null || stats.mastered === 0}
                    title={stats.mastered === 0 ? '暂无已掌握记录' : '删除连续答对 ≥ 2 次的记录'}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
                  >
                    <CheckCircle2 size={13} /> 清空已掌握
                  </button>
                  <button
                    onClick={() => setConfirming(confirming === 'all' ? null : 'all')}
                    disabled={busy !== null || stats.total === 0}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--danger)]/40 text-[12px] text-[var(--danger)] hover:bg-[var(--danger)]/10 disabled:opacity-40 transition-colors"
                  >
                    <Trash2 size={13} /> 清空全部
                  </button>
                </div>

                {/* 内联二次确认条（kb-collapse 高度动画） */}
                <div className={'kb-collapse' + (confirming ? ' open' : '')}>
                  <div>
                    <div className="pt-2">
                      {confirming && (
                        <div className="kb-item-in flex flex-wrap items-center gap-2 rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/5 px-3 py-2">
                          <AlertTriangle size={13} className="shrink-0 text-[var(--danger)]" />
                          <span className="flex-1 min-w-[220px] text-[11.5px] leading-relaxed text-[var(--text-primary)]">
                            {confirming === 'mastered'
                              ? <>确认清空 <b>{stats.mastered}</b> 条已掌握记录？它们会从错题本彻底删除，不可恢复。</>
                              : <>确认清空 <b>{stats.total}</b> 条错题记录？{scope ? '仅限当前空间，' : ''}此操作不可撤销，建议先导出备份。</>}
                          </span>
                          <button
                            onClick={() => void runExport()}
                            disabled={busy !== null}
                            className="shrink-0 px-2 py-1 rounded border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
                          >
                            先导出备份
                          </button>
                          <button
                            onClick={() => void runClear(confirming)}
                            disabled={busy !== null}
                            className="shrink-0 px-2.5 py-1 rounded bg-[var(--danger)] text-[11.5px] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
                          >
                            {busy === confirming ? '清理中…' : '确认清空'}
                          </button>
                          <button
                            onClick={() => setConfirming(null)}
                            className="shrink-0 px-2 py-1 rounded text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                          >
                            取消
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 上次操作结果 */}
                <div className={'kb-collapse' + (result ? ' open' : '')}>
                  <div>
                    <div className="pt-2">
                      {result && (
                        <div
                          className={`kb-item-in flex items-start gap-1.5 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed ${
                            result.ok ? 'border-[var(--success)]/40 bg-[var(--success)]/5 text-[var(--text-primary)]'
                              : 'border-[var(--danger)]/40 bg-[var(--danger)]/5 text-[var(--text-primary)]'
                          }`}
                        >
                          {result.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-[var(--success)]" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--danger)]" />}
                          <span className="break-all">{result.text}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
