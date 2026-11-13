import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Search, X, Shield, User, Key, AtSign, Copy, Check, Plus, Pin, PinOff, Eye, EyeOff, ArrowLeft, RefreshCw } from 'lucide-react'
import type { PasswordEntry } from '../../../types'
import { notifyDataChanged, useDataChanged } from '../../../lib/dataChanged'
import { genPassword } from '../../../lib/passwordGen'

export function FillPopup() {
  document.documentElement.className = `theme-${window.api.fillPopupTheme}`

  const [entries, setEntries] = useState<PasswordEntry[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState('') // field name that was just copied
  const searchRef = useRef<HTMLInputElement>(null)

  // 置顶开关（默认 true：小密码本要盖在所有窗口之上）
  const [pinned, setPinned] = useState(true)
  // 新增条目表单
  const [showNew, setShowNew] = useState(false)
  const [fTitle, setFTitle] = useState('')
  const [fAccount, setFAccount] = useState('')
  const [fUsername, setFUsername] = useState('')
  const [fPassword, setFPassword] = useState('')
  const [fUrl, setFUrl] = useState('')
  const [fShowPwd, setFShowPwd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const loadEntries = useCallback(() => {
    setLoading(true)
    window.api.fillPopupGetEntries().then((e: PasswordEntry[]) => {
      setEntries(e); setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    const unsub = window.api.onFillPopupRefresh(() => {
      setSelectedId(null); setSearchQuery(''); setCopied(''); loadEntries()
    })
    loadEntries()
    // 置顶状态以设置为准（首次打开默认 true）
    window.api.getSetting?.('fillPopupAlwaysOnTop').then((v: unknown) => {
      setPinned(v !== false)
    }).catch(() => { /* 读不到就保持默认置顶 */ })
    setTimeout(() => searchRef.current?.focus(), 100)
    return unsub
  }, [loadEntries])

  // 跨窗口同步：主窗口「密码本」新增/删除条目时本弹窗同步刷新
  useDataChanged('passwords', loadEntries)

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(e =>
      e.title.toLowerCase().includes(q) || e.account.toLowerCase().includes(q) ||
      e.username.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)
    )
  }, [entries, searchQuery])

  const selected = entries.find(e => e.id === selectedId) || null

  const handleCopy = useCallback((field: string, value: string) => {
    if (!value) return
    window.api.fillPopupCopy(field, value)
    setCopied(field)
    setTimeout(() => setCopied(''), 1500)
  }, [])

  const handleHide = useCallback(() => window.api.fillPopupHide(), [])

  const togglePin = useCallback(() => {
    const next = !pinned
    setPinned(next)
    void window.api.fillPopupSetAlwaysOnTop(next)
    void window.api.setSetting?.('fillPopupAlwaysOnTop', next)
  }, [pinned])

  const openNew = useCallback(() => {
    setErr(''); setShowNew(true)
    setFTitle(''); setFAccount(''); setFUsername(''); setFPassword(''); setFUrl(''); setFShowPwd(false)
    setTimeout(() => {
      const el = document.getElementById('fp-new-title') as HTMLInputElement | null
      el?.focus()
    }, 50)
  }, [])

  const closeNew = useCallback(() => { setShowNew(false); setErr(''); setSaving(false) }, [])

  const submitNew = useCallback(async () => {
    const title = fTitle.trim()
    if (!title) { setErr('请填写名称'); return }
    setSaving(true); setErr('')
    try {
      const created = await window.api.fillPopupCreateEntry({
        title,
        account: fAccount.trim(),
        username: fUsername.trim(),
        password: fPassword,
        url: fUrl.trim(),
      })
      setShowNew(false)
      setSaving(false)
      // 立即入列表并选中，省一次往返
      setEntries(prev => [...prev, created])
      setSelectedId(created.id)
      setSearchQuery('')
      // 跨窗口同步：主窗口的「密码本」模块据此重新拉取
      notifyDataChanged('passwords')
    } catch (e) {
      setSaving(false)
      setErr(`保存失败：${String((e as Error)?.message || e)}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fTitle, fAccount, fUsername, fPassword, fUrl])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (showNew) { closeNew(); return }
      if (searchQuery) { setSearchQuery(''); return }
      handleHide(); return
    }
    if (showNew) return
    if (e.key === 'ArrowDown') { e.preventDefault(); const idx = filtered.findIndex(en => en.id === selectedId); if (idx < filtered.length - 1) setSelectedId(filtered[idx + 1].id) }
    if (e.key === 'ArrowUp') { e.preventDefault(); const idx = filtered.findIndex(en => en.id === selectedId); if (idx > 0) setSelectedId(filtered[idx - 1].id) }
  }, [searchQuery, filtered, selectedId, handleHide, showNew, closeNew])

  const inputCls = 'w-full px-2 py-1 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]'

  return (
    <div className="flex flex-col h-screen bg-[var(--bg-primary)] overflow-hidden" onKeyDown={handleKeyDown} tabIndex={-1}>
      {/* Title bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex items-center gap-2"><Shield size={14} className="text-[var(--accent)]" /><span className="text-[12px] font-semibold text-[var(--text-primary)]">Phrontis 填充</span></div>
        <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={togglePin}
            data-tip={pinned ? '已置顶（点击取消置顶）' : '未置顶（点击置顶）'} aria-label={pinned ? '已置顶（点击取消置顶）' : '未置顶（点击置顶）'}
            className={`p-0.5 rounded transition-colors ${pinned ? 'text-[var(--accent)] hover:bg-[var(--bg-hover)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}
          >
            {pinned ? <Pin size={13} /> : <PinOff size={13} />}
          </button>
          <button
            onClick={openNew}
            data-tip="新增密码条目" aria-label="新增密码条目"
            className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <Plus size={14} />
          </button>
          <button onClick={handleHide} className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"><X size={14} /></button>
        </div>
      </div>

      {/* Search */}
      {!showNew && (
        <div className="px-3 py-2 shrink-0">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input ref={searchRef} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="搜索..."
              className="w-full pl-7 pr-3 py-1.5 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
          </div>
        </div>
      )}

      {/* Body: 新增表单 or 条目列表 */}
      {showNew ? (
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]">
            <button onClick={closeNew} className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]" data-tip="返回列表" aria-label="返回列表"><ArrowLeft size={13} /></button>
            新增密码条目
          </div>
          <div>
            <div className="mb-0.5 text-[10.5px] text-[var(--text-muted)]">名称 <span className="text-[var(--danger)]">*</span></div>
            <input id="fp-new-title" value={fTitle} onChange={e => setFTitle(e.target.value)} placeholder="如：GitHub"
              className={inputCls} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
          </div>
          <div>
            <div className="mb-0.5 text-[10.5px] text-[var(--text-muted)]">账号（手机/邮箱）</div>
            <input value={fAccount} onChange={e => setFAccount(e.target.value)} placeholder="登录用的账号"
              className={inputCls} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
          </div>
          <div>
            <div className="mb-0.5 text-[10.5px] text-[var(--text-muted)]">用户名</div>
            <input value={fUsername} onChange={e => setFUsername(e.target.value)} placeholder="可与账号相同"
              className={inputCls} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
          </div>
          <div>
            <div className="mb-0.5 flex items-center justify-between">
              <span className="text-[10.5px] text-[var(--text-muted)]">密码</span>
              <button type="button" onClick={() => { setFPassword(genPassword()); setFShowPwd(true) }}
                className="flex items-center gap-0.5 text-[10.5px] text-[var(--accent)] hover:underline">
                <RefreshCw size={9} />生成
              </button>
            </div>
            <div className="flex items-center gap-1">
              <input value={fPassword} onChange={e => setFPassword(e.target.value)} type={fShowPwd ? 'text' : 'password'} placeholder="留空则稍后补填"
                className={`${inputCls} font-mono`} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
              <button type="button" onClick={() => setFShowPwd(v => !v)} data-tip={fShowPwd ? '隐藏' : '显示'} aria-label={fShowPwd ? '隐藏' : '显示'}
                className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] shrink-0">
                {fShowPwd ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
          </div>
          <div>
            <div className="mb-0.5 text-[10.5px] text-[var(--text-muted)]">网址</div>
            <input value={fUrl} onChange={e => setFUrl(e.target.value)} placeholder="https://"
              className={inputCls} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
          </div>
          {err && <div className="text-[10.5px] text-[var(--danger)]">{err}</div>}
          <div className="flex items-center gap-2 pt-0.5 pb-1">
            <button onClick={submitNew} disabled={saving}
              className="flex-1 py-1.5 rounded bg-[var(--accent)] text-white text-[12px] font-medium hover:opacity-90 disabled:opacity-50">
              {saving ? '保存中...' : '保存'}
            </button>
            <button onClick={closeNew} className="px-3 py-1.5 rounded border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {loading ? <div className="flex items-center justify-center py-8 text-[11px] text-[var(--text-muted)]">加载中...</div>
          : filtered.length === 0 ? <div className="flex flex-col items-center justify-center py-8 text-[11px] text-[var(--text-muted)] gap-1"><Shield size={20} className="opacity-20 mb-1" /><p>{entries.length === 0 ? '密码本为空' : '无匹配结果'}</p>
              {entries.length === 0 && <button onClick={openNew} className="mt-1 text-[11px] text-[var(--accent)] hover:underline">+ 新增一条</button>}
            </div>
          : <div className="py-0.5">{filtered.map(e => (
            <div key={e.id} onClick={() => setSelectedId(e.id)}
              className={`px-3 py-1.5 cursor-pointer transition-colors border-l-[3px] ${selectedId === e.id ? 'bg-[var(--bg-selected)] border-l-[var(--accent)]' : 'border-l-transparent hover:bg-[var(--bg-hover)]'}`}>
              <div className="text-[12px] text-[var(--text-primary)] font-medium truncate">{e.title || '未命名'}</div>
              <div className="flex items-center gap-2 mt-0.5 text-[10px]">
                {e.account && <span className="text-[var(--text-muted)]"><AtSign size={9} />{e.account}</span>}
                {e.username && <span className="text-[var(--text-muted)]"><User size={9} />{e.username}</span>}
              </div>
            </div>
          ))}</div>}
        </div>
      )}

      {/* Detail panel with copy buttons */}
      {selected && !showNew && (
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div className="px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] truncate border-b border-[var(--border-color)]">{selected.title || '未命名'}</div>
          {selected.account && (
            <div className="flex items-center justify-between px-3 py-1 hover:bg-[var(--bg-hover)]">
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><AtSign size={11} /><span className="text-[var(--text-primary)]">{selected.account}</span></div>
              <button onClick={() => handleCopy('account', selected.account)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-selected)]">
                {copied === 'account' ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              </button>
            </div>
          )}
          {selected.username && (
            <div className="flex items-center justify-between px-3 py-1 hover:bg-[var(--bg-hover)]">
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><User size={11} /><span className="text-[var(--text-primary)]">{selected.username}</span></div>
              <button onClick={() => handleCopy('username', selected.username)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-selected)]">
                {copied === 'username' ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
              </button>
            </div>
          )}
          <div className="flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-hover)] border-t border-[var(--border-color)]">
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><Key size={11} /><span className="text-[var(--text-primary)] font-mono">••••••••</span></div>
            <button onClick={() => handleCopy('password', selected.password)} className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-selected)]">
              {copied === 'password' ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
