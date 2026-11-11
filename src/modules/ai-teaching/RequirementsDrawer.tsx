import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import {
  aiTeachReadConstraints, aiTeachScopeEnsure, aiTeachScopeRead, aiTeachScopeWriteText, aiTeachWriteConstraints,
} from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { CONSTRAINT_INJECT_MAX_CHARS, CONSTRAINT_INJECT_MAX_ITEMS, exceedsConstraintInjectLimit } from './constraintsParse'

/** 3.14 要求抽屉：全局 / 本课程 / 本知识点 / 本段（CONSTRAINTS.md，四层注入不变）。 */

export type ReqLayer = 'global' | 'workspace' | 'unit' | 'segment'

interface Props {
  wsId: string
  wsName: string
  unitId?: string | null
  segmentSessionId?: string | null
  /** 外部写入（AI 工具 / 编辑器保存）后的重读信号；变化时重新拉当前层 */
  reloadKey?: number
  layer: ReqLayer
  onLayer: (l: ReqLayer) => void
  onClose: () => void
}

const LAYERS: Array<{ key: ReqLayer; label: string }> = [
  { key: 'global', label: '全局' },
  { key: 'workspace', label: '本课程' },
  { key: 'unit', label: '知识点（可选）' },
  { key: 'segment', label: '本段' },
]

export function RequirementsDrawer(props: Props) {
  const { wsId, wsName, unitId, segmentSessionId, reloadKey, layer, onLayer, onClose } = props
  const [text, setText] = useState('')
  const [relPath, setRelPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 当前层 / 未保存草稿：外部写盘触发 reloadKey 时不覆盖正在编辑的内容 */
  const lastContextRef = useRef('')
  const dirtyRef = useRef(false)

  const canUse = (l: ReqLayer): boolean => (l !== 'unit' || !!unitId) && (l !== 'segment' || !!segmentSessionId)

  const load = useCallback(async () => {
    const contextKey = `${wsId}|${unitId ?? ''}|${segmentSessionId ?? ''}|${layer}`
    const contextChanged = lastContextRef.current !== contextKey
    // 外部写盘触发重读时，用户有未保存草稿 → 不覆盖（切层 / 换会话仍照常载入）
    if (!contextChanged && dirtyRef.current) { setLoading(false); return }
    lastContextRef.current = contextKey
    setLoading(true); setText(''); setRelPath(null)
    try {
      if (layer === 'segment') {
        if (!segmentSessionId) { setLoading(false); return }
        const r = await aiTeachReadConstraints(segmentSessionId).catch(() => null)
        setText(r?.ok ? (r.text ?? '') : '')
        setRelPath(r?.relPath ?? null)
      } else {
        if (layer === 'unit' && !unitId) { setLoading(false); return }
        const r = await aiTeachScopeRead({ wsId, level: layer, unitId: layer === 'unit' ? unitId : null }).catch(() => null)
        setText(r?.ok ? (r.text ?? '') : '')
        setRelPath(r?.relPath ?? null)
      }
      dirtyRef.current = false
    } finally { setLoading(false) }
  }, [layer, wsId, unitId, segmentSessionId, reloadKey])

  useEffect(() => { void load() }, [load])

  // 一行内联轻提示：只在当前内容会被注入层截断时出现（与主进程 cutScopeLayer 同口径）
  const overInjectLimit = !loading && exceedsConstraintInjectLimit(text)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      if (layer === 'segment') {
        if (!segmentSessionId) return
        const r = await aiTeachWriteConstraints(segmentSessionId, text).catch(() => null)
        if (!r?.ok) { showToast({ type: 'error', message: r?.error ?? '保存失败' }); return }
        setRelPath(r.relPath ?? relPath)
      } else {
        const ref = { wsId, level: layer, unitId: layer === 'unit' ? unitId : null } as const
        await aiTeachScopeEnsure(ref).catch(() => null)
        const r = await aiTeachScopeWriteText(ref, text).catch(() => null)
        if (!r?.ok) { showToast({ type: 'error', message: r?.error ?? '保存失败' }); return }
        setRelPath(r.relPath ?? relPath)
      }
      dirtyRef.current = false
      showToast({ type: 'success', message: '要求已保存' })
    } finally { setSaving(false) }
  }

  return (
    <div className="absolute inset-y-0 right-0 z-30 w-[340px] max-w-[88vw] flex flex-col border-l border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl kb-view-in">
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border-color)]">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">要求</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-muted)]">{wsName} · CONSTRAINTS.md</span>
        <button onClick={onClose} className="p-1 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><X size={12} /></button>
      </div>
      <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border-color)]">
        {LAYERS.map((l) => (
          <button key={l.key} onClick={() => onLayer(l.key)} disabled={!canUse(l.key)}
            title={l.key === 'unit' ? '可选层：不会自动创建；保存后才落盘，存在时自动注入' : l.key === 'segment' ? '本段要求：只在保存后落盘，存在时自动注入' : undefined}
            className={`px-2 py-0.5 rounded text-[10.5px] transition-colors ${layer === l.key ? 'bg-[var(--bg-selected)] text-[var(--accent)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'} disabled:opacity-30`}>
            {l.label}
          </button>
        ))}
      </div>
      {relPath && <div className="shrink-0 px-3 pt-1.5 text-[9.5px] text-[var(--text-muted)] truncate" title={relPath}>{relPath}</div>}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]"><Loader2 size={16} className="animate-spin" /></div>
      ) : (
        <textarea
          value={text}
          onChange={(e) => { dirtyRef.current = true; setText(e.target.value) }}
          spellCheck={false}
          placeholder={layer === 'unit' && !unitId ? '先选一个知识点' : '把这一层的要求写在这里，例如：\n· 只用中文回答\n· 先给结论再展开\n（留空保存 = 清除）'}
          className="flex-1 min-h-0 m-2 px-2.5 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[11.5px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)] resize-none"
        />
      )}
      {overInjectLimit && (
        <div
          title={`每层注入上限 ${CONSTRAINT_INJECT_MAX_ITEMS} 条 / ${CONSTRAINT_INJECT_MAX_CHARS} 字符；超出部分不会进入 AI 上下文`}
          className="shrink-0 px-3 pb-1 text-[9.5px] leading-snug text-[var(--text-muted)] truncate"
        >
          超出注入上限（{CONSTRAINT_INJECT_MAX_ITEMS} 条 / {CONSTRAINT_INJECT_MAX_CHARS} 字符），超出部分不会注入
        </div>
      )}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-t border-[var(--border-color)]">
        <span className="text-[9.5px] text-[var(--text-muted)]">分层注入：全局 → 本课程 → 本知识点 → 本段</span>
        <div className="flex-1" />
        <button onClick={() => void save()} disabled={saving || loading}
          className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1 text-[11px] text-white disabled:opacity-40">
          {saving && <Loader2 size={10} className="animate-spin" />}保存
        </button>
      </div>
    </div>
  )
}
