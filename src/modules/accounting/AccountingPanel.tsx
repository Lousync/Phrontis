import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, X } from 'lucide-react'
import type { AccountingType, AccountingParseOutcome, AccountingTransaction } from '../../types'
import { accountingCreate, accountingUpdate, accountingParseJson, accountingImportJson } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { catColor, money, todayStr, useAccountingData } from './shared'

/**
 * 右栏「记账」面板（条件性 Tab，仅记账模块激活时出现）。
 *
 * 两块：① 快捷「记一笔」表单（中央流水点编辑时回填）② 手机 AI JSON 粘贴 / 解析预览 / 确认导入。
 * 与中央模块通过 window 事件通信（ACCOUNTING_EDIT_EVENT / ACCOUNTING_NEW_EVENT）；
 * 数据读写走 IPC（主进程 repo，与 AI 工具同一实现）。
 */

const PHONE_PROMPT = [
  '你是一个记账助手。每当我告诉你一笔花销或收入，你只输出一份 JSON，不要任何解释文字、不要 Markdown 代码围栏。格式如下：',
  '',
  '{',
  '  "version": 1,',
  '  "transactions": [',
  '    {',
  '      "date": "YYYY-MM-DD",',
  '      "type": "expense",',
  '      "amount": 28.5,',
  '      "category": "餐饮",',
  '      "payment": "微信",',
  '      "merchant": "沙县小吃",',
  '      "note": "午饭"',
  '    }',
  '  ]',
  '}',
  '',
  '规则：',
  '- type 只能是 expense（支出）或 income（收入）；',
  '- amount 为正数，单位元，可带小数；',
  '- date 省略则按当天；',
  '- category / payment / merchant / note 没有就省略；',
  '- 我一句话里有多笔就放多条。',
  '- 当我让你「汇总 / 整理一下」时：不要计算总额，把我前面说过的每一笔原样放进同一个 transactions 数组一次性给我（方便我一次导入多笔），不要合并成一笔、也不要给合计。',
  '',
  '常用分类（可自拟）：餐饮、交通、购物、学习、居住、娱乐、医疗、人情 / 生活费、工资、奖金、其他。',
].join('\n')

export function AccountingPanel({ pendingEdit = null, onConsumeEdit }: {
  pendingEdit?: string | 'new' | null
  onConsumeEdit?: () => void
}) {
  const { transactions, categories, accounts, reload } = useAccountingData()
  const [editId, setEditId] = useState<string | null>(null)
  const [type, setType] = useState<AccountingType>('expense')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayStr())
  const [category, setCategory] = useState('')
  const [payment, setPayment] = useState('微信')
  const [merchant, setMerchant] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const [json, setJson] = useState('')
  const [preview, setPreview] = useState<AccountingParseOutcome | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)

  const formRef = useRef<HTMLDivElement | null>(null)
  const amountRef = useRef<HTMLInputElement | null>(null)
  // 流水镜像 ref：供 pendingEdit effect 读取，避免把 transactions 放进依赖导致 effect 反复触发
  const txRef = useRef<AccountingTransaction[]>(transactions)
  txRef.current = transactions

  const catsForType = useMemo(
    () => categories.filter((c) => c.kind === type || c.kind === 'both'),
    [categories, type],
  )

  const clearForm = useCallback(() => {
    setEditId(null); setType('expense'); setAmount(''); setDate(todayStr())
    setCategory(''); setPayment('微信'); setMerchant(''); setNote('')
  }, [])

  // App 投递的「记一笔 / 编辑某笔」→ 回填表单（展开右栏与切 Tab 已由 App 完成）
  useEffect(() => {
    if (!pendingEdit) return
    if (pendingEdit === 'new') {
      clearForm()
    } else {
      const t = txRef.current.find((x) => x.id === pendingEdit)
      if (t) {
        setEditId(t.id); setType(t.type); setAmount(String(t.amount)); setDate(t.date)
        setCategory(t.category); setPayment(t.payment); setMerchant(t.merchant); setNote(t.note)
      }
    }
    requestAnimationFrame(() => { formRef.current?.scrollIntoView({ block: 'start' }); amountRef.current?.focus() })
    onConsumeEdit?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEdit])

  // 切换类型后，若已选分类不属于新类型则清空
  useEffect(() => {
    if (category && !catsForType.some((c) => c.name === category)) setCategory('')
  }, [catsForType, category])

  const save = async (): Promise<void> => {
    const amt = parseFloat(amount)
    if (!Number.isFinite(amt) || amt <= 0) { showToast({ type: 'warning', message: '金额要大于 0' }); return }
    setSaving(true)
    try {
      if (editId) {
        await accountingUpdate(editId, { type, amount: amt, date, category, payment, merchant, note })
        showToast({ type: 'info', message: '已更新这一笔' })
      } else {
        await accountingCreate({ type, amount: amt, date, category: category || undefined, payment, merchant, note, source: 'manual' })
        showToast({ type: 'success', message: type === 'expense' ? `已记支出 ${money(amt)}` : `已记收入 ${money(amt)}` })
      }
      clearForm(); await reload()
    } catch (e) {
      showToast({ type: 'error', message: '保存失败', detail: String(e) })
    } finally { setSaving(false) }
  }

  const doParse = async (): Promise<void> => {
    try { setPreview(await accountingParseJson(json)) } catch (e) { showToast({ type: 'error', message: '解析失败', detail: String(e) }) }
  }
  const doImport = async (): Promise<void> => {
    try {
      const res = await accountingImportJson(json)
      if (res.error) { showToast({ type: 'error', message: res.error }); return }
      showToast({ type: 'success', message: `已导入 ${res.added} 笔`, detail: res.skipped || res.invalid ? `跳过重复 ${res.skipped} · 无效 ${res.invalid}` : undefined })
      setJson(''); setPreview(null); await reload()
    } catch (e) { showToast({ type: 'error', message: '导入失败', detail: String(e) }) }
  }

  const inputCls = 'h-8 w-full rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div ref={formRef}>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{editId ? '编辑这一笔' : '记一笔'}</div>
        <div className="mb-2 flex gap-2">
          <button
            onClick={() => setType('expense')}
            className={'h-8 flex-1 rounded-md border text-[12.5px] transition-colors ' + (type === 'expense' ? 'border-[var(--money-out,#e06c4f)] bg-[color-mix(in_srgb,var(--money-out,#e06c4f)_14%,transparent)] font-semibold text-[var(--money-out,#e06c4f)]' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]')}
          >支出</button>
          <button
            onClick={() => setType('income')}
            className={'h-8 flex-1 rounded-md border text-[12.5px] transition-colors ' + (type === 'income' ? 'border-[var(--money-in,#2b9e8f)] bg-[color-mix(in_srgb,var(--money-in,#2b9e8f)_14%,transparent)] font-semibold text-[var(--money-in,#2b9e8f)]' : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]')}
          >收入</button>
        </div>
        <div className="mb-2 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1"><span className="text-[11px] text-[var(--text-secondary)]">金额（元）</span>
            <input ref={amountRef} type="number" step="0.01" min="0" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1"><span className="text-[11px] text-[var(--text-secondary)]">日期</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </label>
        </div>
        <label className="mb-2 flex flex-col gap-1"><span className="text-[11px] text-[var(--text-secondary)]">分类</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
            <option value="">未分类</option>
            {catsForType.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <div className="mb-2 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1"><span className="text-[11px] text-[var(--text-secondary)]">支付方式</span>
            <select value={payment} onChange={(e) => setPayment(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1"><span className="text-[11px] text-[var(--text-secondary)]">商户 / 对象</span>
            <input type="text" placeholder="可选" value={merchant} onChange={(e) => setMerchant(e.target.value)} className={inputCls} />
          </label>
        </div>
        <label className="mb-2 flex flex-col gap-1"><span className="text-[11px] text-[var(--text-secondary)]">备注</span>
          <input type="text" placeholder="可选" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
        </label>
        <div className="flex gap-2">
          <button onClick={() => { void save() }} disabled={saving} className="h-8 flex-1 rounded-md bg-[var(--accent)] text-[12.5px] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50">保存</button>
          {editId && <button onClick={() => clearForm()} className="h-8 rounded-md border border-[var(--border-color)] px-3 text-[12.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">取消</button>}
        </div>
      </div>

      <div className="mt-5 border-t border-[var(--border-color)] pt-4">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">导入手机 AI 的 JSON</div>
        <textarea
          value={json}
          onChange={(e) => { setJson(e.target.value); setPreview(null) }}
          placeholder='{ "version":1, "transactions":[ { "date":"2026-10-05", "type":"expense", "amount":28.5, "category":"餐饮", "payment":"微信", "merchant":"沙县小吃", "note":"午饭" } ] }'
          spellCheck={false}
          className="h-[104px] w-full resize-y rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
          最少只要 <b>amount</b> + <b>type</b>，date 省略按今天算。
          <button className="ml-1 text-[var(--accent)] hover:underline" onClick={() => setShowPrompt(true)}>手机端指令模板</button>
        </div>
        <div className="mt-2 flex gap-2">
          <button onClick={() => { void doParse() }} className="h-8 flex-1 rounded-md border border-[var(--border-color)] text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">解析预览</button>
          <button onClick={() => { void doImport() }} disabled={!preview || !!preview.error || preview.ok === 0} className="h-8 flex-1 rounded-md bg-[var(--accent)] text-[12.5px] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40">确认导入</button>
        </div>
        {preview && (
          <div className="mt-2.5 overflow-hidden rounded-md border border-[var(--border-color)]">
            <div className="flex items-center gap-1.5 bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)]">
              <span>解析预览</span>
              {preview.error
                ? <span className="text-[var(--danger)]">{preview.error}</span>
                : <>
                  <span className="rounded-full bg-[color-mix(in_srgb,var(--money-in,#2b9e8f)_16%,transparent)] px-2 py-px text-[10px] text-[var(--money-in,#2b9e8f)]">可导入 {preview.ok}</span>
                  {preview.dup > 0 && <span className="rounded-full bg-[color-mix(in_srgb,var(--warning)_20%,transparent)] px-2 py-px text-[10px] text-[var(--warning)]">重复 {preview.dup}</span>}
                  {preview.bad > 0 && <span className="rounded-full bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] px-2 py-px text-[10px] text-[var(--danger)]">无效 {preview.bad}</span>}
                </>}
            </div>
            {!preview.error && preview.items.map((it, i) => (
              <div key={i} className={'flex items-center gap-2 border-t border-[var(--border-color)] px-2.5 py-1.5 text-[11.5px] ' + (it.invalid || it.dup ? 'opacity-50' : '')}>
                {it.invalid
                  ? <span className="flex-1 truncate text-[var(--text-muted)]">{it.reason}</span>
                  : <>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: catColor(categories, it.category) }} />
                    <span className="flex-1 truncate text-[var(--text-secondary)]">{it.date.slice(5)} · {it.merchant || it.category}{it.dup ? '（重复）' : ''}</span>
                    <span className={'font-semibold tabular-nums ' + (it.type === 'expense' ? 'text-[var(--money-out,#e06c4f)]' : 'text-[var(--money-in,#2b9e8f)]')}>{it.type === 'expense' ? '-' : '+'}{money(it.amount).replace('¥', '')}</span>
                  </>}
              </div>
            ))}
          </div>
        )}
      </div>

      {showPrompt && createPortal(
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 kb-overlay" onClick={() => setShowPrompt(false)}>
          <div className="w-[560px] max-w-[92vw] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex h-12 items-center gap-2 border-b border-[var(--border-color)] px-4 text-[14px] font-semibold text-[var(--text-primary)]">
              手机端 AI 指令模板
              <button onClick={() => setShowPrompt(false)} className="ml-auto rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={14} /></button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-4">
              <p className="mb-2.5 text-[12.5px] leading-7 text-[var(--text-secondary)]">每次消费/收入后，把下面这段连同「我花了 28 块 5 吃午饭，微信」一起发给手机 AI（DeepSeek 等），它就会只回一份可导入的 JSON。</p>
              <pre className="select-text whitespace-pre-wrap rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--text-primary)]">{PHONE_PROMPT}</pre>
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--border-color)] px-4 py-3">
              <button onClick={() => setShowPrompt(false)} className="rounded-md px-3 py-1 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">关闭</button>
              <button
                onClick={() => { navigator.clipboard.writeText(PHONE_PROMPT).then(() => showToast({ type: 'success', message: '已复制指令模板' })).catch(() => showToast({ type: 'error', message: '复制失败，请手动全选' })) }}
                className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1 text-[12.5px] text-white hover:bg-[var(--accent-hover)]"
              ><Copy size={12} /> 复制模板</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
