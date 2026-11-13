import { useEffect, useState } from 'react'
import { pluginGetSettingsSchema, pluginGetSettingValues, pluginSetSettingValue } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import type { PluginSettingItem } from '../../types'

/**
 * 插件声明式设置表单（plugin-phase1-design C5）。
 *
 * schema 来自 manifest contributes.settings（主进程已做类型白名单校验），
 * 值经 plugin:setSettingValue 落插件私有 kb.store（settings.* 前缀）——
 * 插件侧用现有 kb.store.get('settings.<key>') 读取，宿主不新增插件 API。
 * 无 settings 声明时整节不渲染。
 */
export function PluginSettingsForm({ pluginId }: { pluginId: string }) {
  const [schema, setSchema] = useState<PluginSettingItem[]>([])
  const [values, setValues] = useState<Record<string, unknown>>({})

  useEffect(() => {
    let alive = true
    Promise.all([pluginGetSettingsSchema(pluginId), pluginGetSettingValues(pluginId)])
      .then(([s, v]) => { if (alive) { setSchema(s.schema ?? []); setValues(v.values ?? {}) } })
      .catch(() => { /* 主进程未就绪等忽略 */ })
    return () => { alive = false }
  }, [pluginId])

  if (schema.length === 0) return null

  const change = (key: string, value: unknown) => {
    setValues(prev => ({ ...prev, [key]: value })) // 乐观更新，失败回读
    void pluginSetSettingValue(pluginId, key, value)
      .then(r => {
        if (!r.ok) {
          showToast({ type: 'error', message: r.error || '保存失败' })
          void pluginGetSettingValues(pluginId).then(v => setValues(v.values ?? {})).catch(() => null)
        }
      })
      .catch(() => null)
  }

  const optionEntry = (o: Record<string, unknown> | string): { value: string; label: string } =>
    typeof o === 'string' ? { value: o, label: o } : { value: String(o.value ?? ''), label: String(o.label ?? o.value ?? '') }

  return (
    <>
      <h3 className="text-[11px] text-[var(--text-muted)] mb-2.5">插件设置</h3>
      <div className="space-y-2 mb-8">
        {schema.map(it => (
          <div key={it.key} className="flex items-center gap-3 p-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-[var(--text-primary)]">{it.label}</div>
              {it.desc && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{it.desc}</div>}
            </div>
            {it.type === 'boolean' ? (
              <button
                onClick={() => change(it.key, !(values[it.key] ?? it.default ?? false))}
                className={`shrink-0 relative w-9 h-5 rounded-full transition-colors ${values[it.key] ?? it.default ?? false ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)] border border-[var(--border-color)]'}`}
                data-tip={it.label} aria-label={it.label}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${(values[it.key] ?? it.default ?? false) ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
            ) : it.type === 'select' ? (
              <select
                value={String(values[it.key] ?? it.default ?? '')}
                onChange={e => change(it.key, e.target.value)}
                className="shrink-0 w-36 px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              >
                {(it.options ?? []).map((o, i) => {
                  const oe = optionEntry(o)
                  return <option key={`${oe.value}-${i}`} value={oe.value}>{oe.label}</option>
                })}
              </select>
            ) : it.type === 'number' ? (
              <input
                type="number"
                value={String(values[it.key] ?? it.default ?? '')}
                onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) change(it.key, n) }}
                className="shrink-0 w-28 px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] text-right outline-none focus:border-[var(--accent)]"
              />
            ) : (
              <input
                type="text"
                value={String(values[it.key] ?? it.default ?? '')}
                onChange={e => change(it.key, e.target.value)}
                maxLength={200}
                className="shrink-0 w-44 px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            )}
          </div>
        ))}
        <p className="text-[11px] text-[var(--text-muted)]">保存在插件私有存储（kb.store），插件经 kb.store.get("settings.&lt;key&gt;") 读取。</p>
      </div>
    </>
  )
}
