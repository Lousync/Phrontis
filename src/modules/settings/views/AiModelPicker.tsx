import { useRef, useState } from 'react'
import { Search, Star } from 'lucide-react'
import { AnchoredLayer } from '../../../components/shared/AnchoredLayer'
import type { LlmProviderInfo, LlmProviderType, LlmModelFamily } from '../../../types'
import { prettyModelName } from '../../../lib/modelNames'

/**
 * 可搜索的模型选择器（2026-10-13，按原型 tmp/ai-settings-proto 的 pickerHTML 落地）。
 *
 * 一个控件、五处复用（对话默认 / AI 助手 / 编辑器续写 / 长对话压缩 / 图片视觉转写）——
 * 原型里那句「同一套控件复用在 4 个场景上（原来这段 UI 在代码里写了两遍）」就是它。
 *
 * 三条口径：
 *   · **只列可用端点的模型**（端点启用 + 至少一个账号可用）：避免"选得到却调不通"；
 *   · 按供应商分组，组头写出当前账号名 —— 让你知道选了它之后会用哪把 Key；
 *   · ☆ 直接标记免费（原来的「手填 ID 列表」改成点星）。
 * 组的头部还会显示每个模型实际走哪条协议（chat / messages / responses），
 * 因为那是"能不能调通"的判据，而它只写在官方端点表里、用户无从得知。
 */

/** 供应商 type → 默认协议族（与主进程 FAMILY_BY_TYPE 同口径；ollama 无协议族概念） */
export const FAMILY_BY_TYPE: Partial<Record<LlmProviderType, LlmModelFamily>> = {
  'openai-compatible': 'chat',
  'openai-responses': 'responses',
  anthropic: 'messages',
}

export const TYPE_LABEL: Record<LlmProviderType, string> = {
  'openai-compatible': 'OpenAI 兼容',
  ollama: 'Ollama 本地',
  anthropic: 'Anthropic',
  'openai-responses': 'OpenAI Responses',
}

export const FAMILY_LABEL: Record<LlmModelFamily, string> = {
  chat: '对话补全',
  messages: 'Messages',
  responses: 'Responses',
}

/** 某模型实际走哪个协议：逐模型覆盖优先，其次跟随供应商默认 */
export function effectiveFamily(p: LlmProviderInfo, model: string): LlmModelFamily | null {
  return p.modelFamilies?.[model] ?? FAMILY_BY_TYPE[p.type] ?? null
}

function FamilyChip({ family }: { family: LlmModelFamily | null }) {
  if (!family) return null
  const tone = family === 'chat' ? '' : family === 'messages' ? 'border-[var(--accent)]/40 text-[var(--accent)]' : 'border-amber-500/40 text-amber-400'
  return <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${tone || 'border-[var(--border-color)] text-[var(--text-muted)]'}`}>{FAMILY_LABEL[family]}</span>
}

export function AiModelPicker({ value, onChange, providers, freeSet, onToggleFree, placeholder, onlySpecs }: {
  value: string
  onChange: (spec: string) => void
  providers: LlmProviderInfo[]
  freeSet: Set<string>
  onToggleFree: (modelId: string) => void
  placeholder: string
  /** 只允许这些 spec（图片视觉转写那行用它把候选收窄到"疑似支持图片"的模型） */
  onlySpecs?: Set<string>
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  // 下拉面板走 AnchoredLayer（portal + fixed）：这个选择器在「模型」页的场景分配表里用，
  // 而那张表已折叠成一组 —— 就地 absolute 的下拉会被折叠容器的 overflow:hidden 裁掉大半。
  const btnRef = useRef<HTMLButtonElement | null>(null)

  // 当前值的展示：供应商名 · 账号名 / 模型名（找不到就照原样显示 spec，别装作没选）
  const cur = (() => {
    if (!value) return null
    const i = value.indexOf(':')
    const pid = value.slice(0, i), mid = value.slice(i + 1)
    const p = providers.find(x => x.id === pid)
    const acct = p?.accounts.find(a => a.id === p.activeAccountId)
    return { pname: p?.name ?? pid, acct: acct?.name ?? '', model: mid, free: /(^|[-._])free([-._]|$)/i.test(mid) || freeSet.has(mid) }
  })()

  const ql = q.trim().toLowerCase()
  const groups = providers
    .filter(p => p.usable && p.models.length > 0)
    .map(p => ({
      p,
      models: p.models.filter(m => {
        if (onlySpecs && !onlySpecs.has(`${p.id}:${m}`)) return false
        if (!ql) return true
        return m.toLowerCase().includes(ql) || p.name.toLowerCase().includes(ql)
      }),
    }))
    .filter(g => g.models.length > 0)
  const total = groups.reduce((n, g) => n + g.models.length, 0)

  return (
    <div className="relative">
      <button ref={btnRef} onClick={() => { setOpen(v => !v); setQ('') }} aria-expanded={open}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-left text-[12px] hover:border-[var(--accent)]/50 transition-colors">
        <span className="min-w-0 flex-1 truncate">
          {cur
            ? <>
                {cur.free && <span className="mr-1.5 text-[10px] px-1 py-0.5 rounded border border-amber-500/40 text-amber-400">免费</span>}
                <span className="text-[var(--text-primary)]">{prettyModelName(cur.model)}</span>
                <span className="ml-1.5 font-mono text-[10.5px] text-[var(--text-muted)]">{cur.model}</span>
              </>
            : <span className="text-[var(--text-disabled)]">{placeholder}</span>}
        </span>
        <span className="shrink-0 text-[var(--text-muted)]">▾</span>
      </button>

      <AnchoredLayer anchorRef={btnRef} open={open} onClose={() => setOpen(false)} matchWidth
        className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--border-color)]">
          <Search size={12} className="text-[var(--text-muted)] shrink-0" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="搜索模型"
            className="flex-1 min-w-0 bg-transparent text-[12px] outline-none text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]" />
        </div>
        <div className="max-h-[280px] overflow-y-auto py-1">
          {groups.map(({ p, models }) => {
            const acct = p.accounts.find(a => a.id === p.activeAccountId)
            return (
              <div key={p.id}>
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] text-[var(--text-muted)] sticky top-0 bg-[var(--bg-primary)] kb-scroll-edge kb-scroll-edge--on">
                  <span className="truncate">{p.name}</span>
                  <span className="text-[var(--accent)] shrink-0">{acct ? acct.name : '无可用账号'}</span>
                  <span className="text-[var(--text-disabled)] shrink-0">· {models.length}</span>
                </div>
                {models.map(m => {
                  const spec = `${p.id}:${m}`
                  const isCur = value === spec
                  const free = freeSet.has(m) || /(^|[-._])free([-._]|$)/i.test(m)
                  return (
                    <div key={spec} title={spec}
                      className={`flex items-center gap-1.5 px-2.5 py-1 text-[12px] cursor-pointer transition-colors ${isCur ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-hover)]'}`}
                      onClick={() => { onChange(spec); setOpen(false) }}>
                      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{prettyModelName(m)}</span>
                      {free && <span className="shrink-0 text-[10px] px-1 py-0.5 rounded border border-amber-500/40 text-amber-400">免费</span>}
                      <FamilyChip family={effectiveFamily(p, m)} />
                      <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-muted)] max-w-[38%] truncate">{m}</span>
                      <button onClick={e => { e.stopPropagation(); onToggleFree(m) }}
                        title={free ? '取消免费标记' : '标记为免费模型'}
                        className={`shrink-0 p-0.5 rounded transition-colors ${free ? 'text-amber-400' : 'text-[var(--text-disabled)] hover:text-amber-400'}`}>
                        <Star size={11} className={free ? 'fill-amber-400' : ''} />
                      </button>
                      {isCur && <span className="shrink-0 text-[var(--accent)] text-[11px]">✓</span>}
                    </div>
                  )
                })}
              </div>
            )
          })}
          {total === 0 && (
            <div className="px-2.5 py-3 text-[11.5px] text-[var(--text-muted)]">
              {ql ? `没有匹配「${q}」的模型` : '暂无可选模型：端点均已停用、账号未配置 Key，或尚未获取模型清单'}
            </div>
          )}
        </div>
        <div className="px-2.5 py-1.5 border-t border-[var(--border-color)] flex items-center justify-between gap-2 text-[10.5px] text-[var(--text-muted)]">
          <span>☆ 标记为免费模型</span>
          <span className="shrink-0">{total} 个可选</span>
        </div>
      </AnchoredLayer>
    </div>
  )
}
