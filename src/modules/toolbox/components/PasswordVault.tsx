import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react'
import {
  ArrowLeft, Search, Eye, EyeOff, Copy, Plus, Trash2, ExternalLink, X, Check, Shield, Globe, User, Key,
  FileText, AtSign, Star, Folder, FolderOpen, Layers, ChevronRight, ArrowUp, ArrowDown, ChevronsUpDown, RefreshCw,
} from 'lucide-react'
import type { PasswordEntry } from '../../../types'
import { getPasswordEntries, getPasswordEntryById, createPasswordEntry, updatePasswordEntry, deletePasswordEntry, openExternal } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { useDataChanged, notifyDataChanged } from '../../../lib/dataChanged'
import { genPassword } from '../../../lib/passwordGen'

interface Props {
  onBack: () => void
}

/** 每页条数（滚动到底自动追加，避免条目多时一次性渲染上千行） */
const PAGE = 50
const FAV_GROUP = '__fav__'
const NO_GROUP = '__none__'

type SortKey = 'updated' | 'title'
type SortDir = 'asc' | 'desc'
type View = { kind: 'list' } | { kind: 'detail'; id: string }

/** 详情页可编辑字段的快照（保存时与条目 id 原子绑定，杜绝跨条目串写） */
type Snap = {
  title: string; account: string; username: string
  password: string; url: string; notes: string
  group: string; favorite: boolean
}
/** 一次待保存作业：id 与 content 取自同一瞬间 */
type SaveJob = { id: string; snap: Snap }

export function PasswordVault({ onBack }: Props) {
  const [entries, setEntries] = useState<PasswordEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('updated')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [groupMode, setGroupMode] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [visibleCount, setVisibleCount] = useState(PAGE)

  // 视图：list = 全部条目总览；detail = 单条详情/编辑（返回时恢复列表滚动位置）
  const [view, setView] = useState<View>({ kind: 'list' })
  const scrollTopRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Edit fields（详情页）
  const [title, setTitle] = useState('')
  const [account, setAccount] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [url, setUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [group, setGroup] = useState('')
  const [favorite, setFavorite] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copiedAccount, setCopiedAccount] = useState(false)
  const [copiedUser, setCopiedUser] = useState(false)
  const [copiedPass, setCopiedPass] = useState(false)
  // 总览页每行独立的「明文/掩码」状态
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState('')

  // New entry form
  const [showNewForm, setShowNewForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newAccount, setNewAccount] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [newNotes, setNewNotes] = useState('')

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedRef = useRef<string | null>(null)
  /**
   * 待保存作业（id + 内容快照原子绑定）。
   * 关键：不再依赖「调用时读 selectedRef、回调时读 refs」——那两者取自不同时刻，
   * 只要 IPC 往返期间切换了条目，旧条目就会被写成新条目的内容。
   */
  const pendingRef = useRef<SaveJob | null>(null)
  /** 每条目「客户端已知的 updatedAt」版本号，随保存成功推进；用于后端乐观锁校验 */
  const versionsRef = useRef<Map<string, string>>(new Map())
  /** 保存串行链：保证同一时刻只有一次落盘在飞，避免版本号推进与校验错位 */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const titleRef = useRef(title)
  const accountRef = useRef(account)
  const usernameRef = useRef(username)
  const passwordRef = useRef(password)
  const urlRef = useRef(url)
  const notesRef = useRef(notes)
  const groupRef = useRef(group)
  const favoriteRef = useRef(favorite)
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { titleRef.current = title }, [title])
  useEffect(() => { accountRef.current = account }, [account])
  useEffect(() => { usernameRef.current = username }, [username])
  useEffect(() => { passwordRef.current = password }, [password])
  useEffect(() => { urlRef.current = url }, [url])
  useEffect(() => { notesRef.current = notes }, [notes])
  useEffect(() => { groupRef.current = group }, [group])
  useEffect(() => { favoriteRef.current = favorite }, [favorite])

  // Load entries
  const loadEntries = useCallback(() => {
    getPasswordEntries().then(e => {
      setEntries(e); setLoading(false)
      // 磁盘为真相源：同步各条目版本号（悬浮窗刚改过的条目，避免乐观锁误拒我们自己的下一次保存）
      const m = versionsRef.current
      e.forEach(en => { if (en.updatedAt) m.set(en.id, en.updatedAt) })
    }).catch(() => setLoading(false))
  }, [])
  useEffect(() => { loadEntries() }, [loadEntries])
  // 跨窗口同步（2026-09-10）：悬浮小密码本新增/删除条目后本列表自动刷新
  useDataChanged('passwords', loadEntries)

  useEffect(() => {
    return () => {
      if (clipboardTimer.current) clearTimeout(clipboardTimer.current)
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  // 搜索/排序/分组模式变化 → 回到第一页（否则会残留上一轮的长列表）
  useEffect(() => { setVisibleCount(PAGE) }, [searchQuery, sortKey, sortDir, groupMode])

  // 返回列表时恢复滚动位置（列表切到详情会被卸载，位置存在 ref 里）
  useLayoutEffect(() => {
    if (view.kind !== 'list') return
    const top = scrollTopRef.current
    if (!top) return
    const raf = requestAnimationFrame(() => { listRef.current?.scrollTo({ top }) })
    return () => cancelAnimationFrame(raf)
  }, [view])

  const selected = useMemo(
    () => entries.find(e => e.id === (view.kind === 'detail' ? view.id : null)) || null,
    [entries, view],
  )
  useEffect(() => { selectedRef.current = selected?.id ?? null }, [selected])

  // 已有分组（供详情页输入建议 / 统计）
  const groupNames = useMemo(() => {
    const s = new Set<string>()
    entries.forEach(e => { const g = (e.group || '').trim(); if (g) s.add(g) })
    return [...s].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [entries])

  // Filter + sort（收藏恒置顶；其次按 sortKey）
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const base = !q
      ? entries
      : entries.filter(e =>
        e.title.toLowerCase().includes(q) ||
        e.account.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q) ||
        e.url.toLowerCase().includes(q) ||
        (e.group || '').toLowerCase().includes(q))
    const dir = sortDir === 'asc' ? 1 : -1
    return base.slice().sort((a, b) => {
      const fav = Number(b.favorite) - Number(a.favorite)
      if (fav) return fav
      if (sortKey === 'title') return (a.title || '').localeCompare(b.title || '', 'zh-CN') * dir
      return (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) * dir
    })
  }, [entries, searchQuery, sortKey, sortDir])

  // 分组折叠视图：收藏组置顶 → 具名分组 → 未分组
  const groups = useMemo(() => {
    const favs = filtered.filter(e => e.favorite)
    const buckets = new Map<string, PasswordEntry[]>()
    filtered.forEach(e => {
      if (e.favorite) return
      const key = (e.group || '').trim() || NO_GROUP
      const arr = buckets.get(key)
      if (arr) arr.push(e); else buckets.set(key, [e])
    })
    const named = [...buckets.entries()]
      .filter(([k]) => k !== NO_GROUP)
      .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
      .map(([key, items]) => ({ key, name: key, items }))
    const out: { key: string; name: string; items: PasswordEntry[]; fav?: boolean }[] = []
    if (favs.length) out.push({ key: FAV_GROUP, name: '收藏', items: favs, fav: true })
    out.push(...named)
    const none = buckets.get(NO_GROUP)
    if (none?.length) out.push({ key: NO_GROUP, name: '未分组', items: none })
    return out
  }, [filtered])

  /** 分页：分组模式下按组依次发放配额，保证每个组头都可见 */
  const pagedGroups = useMemo(() => {
    if (!groupMode) return null
    let left = visibleCount
    return groups.map(g => {
      const isCollapsed = collapsed.has(g.key)
      const take = isCollapsed ? 0 : Math.max(0, Math.min(left, g.items.length))
      left -= take
      return { ...g, total: g.items.length, visibleItems: g.items.slice(0, take), isCollapsed }
    })
  }, [groupMode, groups, collapsed, visibleCount])

  const visibleFlat = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])
  const totalCount = filtered.length

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'title' ? 'asc' : 'desc') }
  }
  const toggleGroup = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // ---------- 详情 / 编辑 ----------

  const readSnap = useCallback((): Snap => ({
    title: titleRef.current,
    account: accountRef.current,
    username: usernameRef.current,
    password: passwordRef.current,
    url: urlRef.current,
    notes: notesRef.current,
    group: groupRef.current,
    favorite: favoriteRef.current,
  }), [])

  /** 清掉防抖定时器并复位（不留 truthy 残值，否则每次进出条目都会触发一次「幽灵保存」） */
  const clearSaveTimer = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
  }, [])

  /**
   * 落盘。作业在调用瞬间被同步取走（一条 pending 只发一次），随后进串行链，
   * 保证「版本号推进」与「乐观锁校验」不会互相错位。
   */
  const doSave = useCallback((): Promise<void> => {
    const job = pendingRef.current
    if (!job) return saveChainRef.current
    pendingRef.current = null
    saveChainRef.current = saveChainRef.current.then(async () => {
      setSaving(true)
      try {
        const saved = await updatePasswordEntry(job.id, {
          ...job.snap,
          expectedUpdatedAt: versionsRef.current.get(job.id) || undefined,
        })
        if (saved?.updatedAt) versionsRef.current.set(job.id, saved.updatedAt)
        // 回写内存行用的是作业自带快照 —— 绝不在此之后读 ref（那时可能已切到别的条目）
        setEntries(prev => prev.map(e => e.id === job.id
          ? { ...e, ...job.snap, updatedAt: saved?.updatedAt || e.updatedAt }
          : e))
      } catch (e) {
        const msg = String((e as Error)?.message || e)
        if (msg.includes('PASSWORD_CONFLICT')) {
          // 别处已改过：同步最新版本号与内容，本次改动不覆盖对方
          try {
            const fresh = await getPasswordEntryById(job.id)
            if (fresh) {
              if (fresh.updatedAt) versionsRef.current.set(job.id, fresh.updatedAt)
              setEntries(prev => prev.map(e => (e.id === job.id ? { ...e, ...fresh } : e)))
            }
          } catch { /* 拿不到最新就保持原样，用户下次编辑会再试 */ }
          showToast({ type: 'warning', message: '该条目已在别处被修改，已同步最新版本' })
        } else {
          console.error(e)
          showToast({ type: 'error', message: '保存失败' })
        }
      } finally {
        // 队列里还有待保存作业时保持「未保存」态
        if (!pendingRef.current) setSaving(false)
      }
    })
    return saveChainRef.current
  }, [])

  /** 输入时调用：把「当前条目 id + 当前表单内容」原子快照成一次待保存作业 */
  const scheduleSave = useCallback(() => {
    const id = selectedRef.current
    if (!id) return
    pendingRef.current = { id, snap: readSnap() }
    setSaving(true)
    clearSaveTimer()
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void doSave() }, 1000)
  }, [doSave, readSnap, clearSaveTimer])

  /** 离开当前编辑上下文前调用：有作业就立即落盘 */
  const flushIfPending = useCallback(() => {
    clearSaveTimer()
    void doSave()
  }, [clearSaveTimer, doSave])

  const openDetail = useCallback((entry: PasswordEntry) => {
    flushIfPending() // 先把上一条的待保存作业落盘（作业自带 id，不会串到本条）
    if (entry.updatedAt) versionsRef.current.set(entry.id, entry.updatedAt)
    scrollTopRef.current = listRef.current?.scrollTop ?? 0
    setShowPassword(false)
    setCopiedAccount(false); setCopiedUser(false); setCopiedPass(false)
    setTitle(entry.title)
    setAccount(entry.account || '')
    setUsername(entry.username)
    setPassword(entry.password)
    setUrl(entry.url)
    setNotes(entry.notes)
    setGroup(entry.group || '')
    setFavorite(!!entry.favorite)
    setView({ kind: 'detail', id: entry.id })
  }, [flushIfPending])

  const backToList = useCallback(() => {
    flushIfPending()
    setView({ kind: 'list' })
  }, [flushIfPending])

  // ---------- 新建 / 删除 / 复制 ----------

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    try {
      const entry = await createPasswordEntry({
        title: newTitle.trim(),
        account: newAccount.trim(),
        username: newUsername.trim(),
        password: newPassword,
        url: newUrl.trim(),
        group: newGroup.trim(),
        notes: newNotes.trim(),
      })
      setEntries(prev => [entry, ...prev])
      notifyDataChanged('passwords') // 同步悬浮小密码本等其它窗口
      setShowNewForm(false)
      setNewTitle(''); setNewAccount(''); setNewUsername(''); setNewPassword(''); setNewUrl(''); setNewGroup(''); setNewNotes('')
      openDetail(entry)
      showToast({ type: 'info', message: '已添加密码条目' })
    } catch (e) { console.error(e); showToast({ type: 'error', message: '添加失败' }) }
  }

  const handleCopyText = (text: string, type: 'account' | 'user' | 'pass', id?: string) => {
    navigator.clipboard.writeText(text).then(() => {
      if (id) { setCopiedId(id); setTimeout(() => setCopiedId(''), 1500) }
      if (type === 'account') { setCopiedAccount(true); setTimeout(() => setCopiedAccount(false), 2000) }
      else if (type === 'user') { setCopiedUser(true); setTimeout(() => setCopiedUser(false), 2000) }
      else {
        setCopiedPass(true); setTimeout(() => setCopiedPass(false), 2000)
        if (clipboardTimer.current) clearTimeout(clipboardTimer.current)
        // 30 秒后仅当剪贴板仍是该密码时才清空(不覆盖用户后续复制的内容)
        clipboardTimer.current = setTimeout(() => { window.api?.clearClipboardIfEqual(text) }, 30000)
      }
      const label = type === 'account' ? '账号已复制' : type === 'user' ? '用户名已复制' : '密码已复制（30秒后自动清除）'
      showToast({ type: 'info', message: label })
    }).catch(() => showToast({ type: 'error', message: '复制失败' }))
  }

  const handleOpenUrl = (u: string) => {
    if (!u) return
    const href = u.startsWith('http://') || u.startsWith('https://') ? u : `https://${u}`
    openExternal(href)
  }

  /** 收藏开关：乐观更新 + 失败回滚（列表行与详情页共用） */
  const setFavoriteFor = useCallback(async (id: string, next: boolean) => {
    setEntries(prev => prev.map(e => (e.id === id ? { ...e, favorite: next } : e)))
    // 该条目若还有未落盘的编辑，同步其中的 favorite，免得旧快照把刚点的收藏又改回去
    if (pendingRef.current?.id === id) pendingRef.current.snap.favorite = next
    try {
      const saved = await updatePasswordEntry(id, {
        favorite: next,
        expectedUpdatedAt: versionsRef.current.get(id) || undefined,
      })
      if (saved?.updatedAt) versionsRef.current.set(id, saved.updatedAt)
      notifyDataChanged('passwords')
    } catch {
      setEntries(prev => prev.map(e => (e.id === id ? { ...e, favorite: !next } : e)))
      if (pendingRef.current?.id === id) pendingRef.current.snap.favorite = !next
      showToast({ type: 'error', message: '收藏失败' })
    }
  }, [])

  const handleDelete = async (id: string) => {
    setDeleteTarget(null)
    try {
      await deletePasswordEntry(id)
      setEntries(prev => prev.filter(e => e.id !== id))
      versionsRef.current.delete(id)
      if (pendingRef.current?.id === id) pendingRef.current = null // 已删除，别再拿它去落盘
      notifyDataChanged('passwords')
      if (view.kind === 'detail' && view.id === id) setView({ kind: 'list' })
      showToast({ type: 'info', message: '已移至回收站' })
    } catch (e) { console.error(e); showToast({ type: 'error', message: '删除失败' }) }
  }

  const toggleReveal = (id: string) => {
    setRevealed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 160) return
    setVisibleCount(c => (c >= totalCount ? c : Math.min(c + PAGE, totalCount)))
  }

  // ---------- 渲染：行 ----------

  const renderRow = (e: PasswordEntry) => {
    const isRevealed = revealed.has(e.id)
    return (
      <div
        key={e.id}
        onClick={() => openDetail(e)}
        onContextMenu={ev => { ev.preventDefault(); setDeleteTarget(e.id) }}
        className="grid items-center gap-2 px-3 py-1.5 border-b border-[var(--border-color)] cursor-pointer hover:bg-[var(--bg-hover)] transition-colors group"
        style={{ gridTemplateColumns: '24px minmax(140px,2fr) minmax(110px,1.4fr) 148px 116px 72px' }}
      >
        {/* 收藏 */}
        <button
          onClick={ev => { ev.stopPropagation(); void setFavoriteFor(e.id, !e.favorite) }}
          title={e.favorite ? '取消收藏' : '收藏并置顶'}
          className={`flex items-center justify-center rounded transition-colors ${e.favorite ? 'text-[var(--warning)]' : 'text-[var(--text-disabled)] hover:text-[var(--text-muted)]'}`}
        >
          <Star key={e.favorite ? 'on' : 'off'} size={13} className="kb-micro-pop" fill={e.favorite ? 'currentColor' : 'none'} />
        </button>

        {/* 名称 */}
        <div className="flex items-center gap-2 min-w-0">
          <Avatar title={e.title} />
          <div className="min-w-0">
            <div className="text-[12px] text-[var(--text-primary)] font-medium truncate">{e.title || '未命名'}</div>
            {!groupMode && e.group && (
              <div className="text-[9.5px] text-[var(--text-disabled)] truncate">{e.group}</div>
            )}
          </div>
        </div>

        {/* 账号 */}
        <div className="text-[11.5px] text-[var(--text-secondary)] truncate" title={e.account || e.username}>
          {e.account || e.username || <span className="text-[var(--text-disabled)]">—</span>}
        </div>

        {/* 密码（默认掩码） */}
        <div className="flex items-center gap-1 min-w-0">
          <span className={`flex-1 truncate font-mono text-[11.5px] ${isRevealed ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)] tracking-wider'}`}>
            {isRevealed ? (e.password || '—') : '••••••••'}
          </span>
          <button
            onClick={ev => { ev.stopPropagation(); toggleReveal(e.id) }}
            title={isRevealed ? '隐藏' : '显示明文'}
            className="shrink-0 p-0.5 rounded text-[var(--text-disabled)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-selected)]"
          >
            {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
          <button
            onClick={ev => { ev.stopPropagation(); if (e.password) handleCopyText(e.password, 'pass', e.id) }}
            disabled={!e.password}
            title="复制密码"
            className="shrink-0 p-0.5 rounded text-[var(--text-disabled)] hover:text-[var(--accent)] hover:bg-[var(--bg-selected)] disabled:opacity-30"
          >
            {copiedId === e.id ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
          </button>
        </div>

        {/* 更新时间 */}
        <div className="text-[10.5px] text-[var(--text-muted)] truncate">{e.updatedAt ? fmtDate(new Date(e.updatedAt)) : '—'}</div>

        {/* 操作 */}
        <div className="flex items-center justify-end gap-0.5">
          <button
            onClick={ev => { ev.stopPropagation(); handleOpenUrl(e.url) }}
            disabled={!e.url}
            title={e.url ? '打开网址' : '未填写网址'}
            className="p-0.5 rounded text-[var(--text-disabled)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-selected)] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ExternalLink size={12} />
          </button>
          <button
            onClick={ev => { ev.stopPropagation(); setDeleteTarget(e.id) }}
            title="删除"
            className="p-0.5 rounded text-[var(--text-disabled)] hover:text-[var(--danger)] hover:bg-[var(--bg-selected)]"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    )
  }

  const renderEmptyState = () => {
    if (loading) {
      return (
        <div className="py-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5 border-b border-[var(--border-color)]">
              <div className="w-5 h-5 rounded bg-[var(--bg-tertiary)] animate-pulse" />
              <div className="h-3 rounded bg-[var(--bg-tertiary)] animate-pulse" style={{ width: `${140 - i * 12}px` }} />
              <div className="flex-1" />
              <div className="h-3 w-24 rounded bg-[var(--bg-tertiary)] animate-pulse" />
            </div>
          ))}
          <div className="py-6 text-center text-[11px] text-[var(--text-muted)]">加载中...</div>
        </div>
      )
    }
    if (entries.length === 0) {
      return (
        <div className="h-full flex flex-col items-center justify-center py-16 px-6">
          <Shield size={40} className="text-[var(--text-disabled)] opacity-25 mb-3" />
          <p className="text-[13px] text-[var(--text-primary)] mb-4">密码本还是空的</p>
          <button
            onClick={() => setShowNewForm(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
          >
            <Plus size={13} /> 新建密码条目
          </button>
        </div>
      )
    }
    if (totalCount === 0) {
      return (
        <div className="h-full flex flex-col items-center justify-center py-14 px-6">
          <Search size={26} className="text-[var(--text-disabled)] opacity-30 mb-2" />
          <p className="text-[12px] text-[var(--text-muted)]">没有匹配「{searchQuery}」的条目</p>
          <button onClick={() => setSearchQuery('')} className="mt-2 text-[11.5px] text-[var(--accent)] hover:underline">清除搜索</button>
        </div>
      )
    }
    return null
  }

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ChevronsUpDown size={10} className="opacity-40" />
    return sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />
  }

  /**
   * 空态（首条录入 / 无匹配）需要整块在滚动区正中，而不是贴在顶沿。
   * 空态块内的 h-full 必须有一个「有确定高度」的父级才生效 —— 由外层 min-w 容器按此标记撑满高度。
   * 非空态一律不加，避免把列表的滚动高度锁死成视口高度。
   */
  const centeredEmpty = !loading && (entries.length === 0 || totalCount === 0)

  const listBody = () => {
    const empty = renderEmptyState()
    if (empty) return empty
    return (
      <>
        {pagedGroups ? (
          pagedGroups.map(g => (
            <div key={g.key}>
              <button
                onClick={() => toggleGroup(g.key)}
                className="sticky top-0 z-[1] w-full flex items-center gap-1.5 px-3 py-1 bg-[var(--bg-tertiary)] border-y border-[var(--border-color)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                {g.isCollapsed ? <Folder size={11} /> : <FolderOpen size={11} />}
                <span className="font-medium">{g.name}</span>
                <span className="text-[var(--text-disabled)]">{g.total}</span>
                <ChevronRight size={12} className={`kb-chevron ml-auto ${g.isCollapsed ? '' : 'rotate-90'}`} />
              </button>
              {!g.isCollapsed && g.visibleItems.map(renderRow)}
              {!g.isCollapsed && g.visibleItems.length < g.total && (
                <button
                  onClick={() => setVisibleCount(c => c + PAGE)}
                  className="w-full py-1 text-[10.5px] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)]"
                >
                  展开更多（{g.total - g.visibleItems.length} 条）
                </button>
              )}
            </div>
          ))
        ) : (
          visibleFlat.map(renderRow)
        )}
        {visibleCount < totalCount && (
          <button
            onClick={() => setVisibleCount(c => Math.min(c + PAGE, totalCount))}
            className="w-full py-2 text-center text-[10.5px] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)]"
          >
            继续加载更多（{visibleCount}/{totalCount}）
          </button>
        )}
        {!loading && visibleCount >= totalCount && totalCount > PAGE && (
          <div className="py-2 text-center text-[10.5px] text-[var(--text-disabled)]">已显示全部 {totalCount} 条</div>
        )}
      </>
    )
  }

  return (
    <div className="kb-theme-surface flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0">
        <button
          onClick={() => { flushIfPending(); onBack() }}
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          title="返回工具箱"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-[11.5px] font-medium text-[var(--text-muted)]">密码本</span>
        <span className="text-[11px] text-[var(--text-disabled)]">
          {searchQuery ? `${totalCount} / ${entries.length} 条` : `${entries.length} 条`}
        </span>
        <button
          onClick={() => setShowNewForm(true)}
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
        >
          <Plus size={12} /> 新建
        </button>
      </div>

      {view.kind === 'list' ? (
        <>
          {/* 工具条：搜索 / 分组折叠 */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0">
            <div className="relative flex-1 max-w-[320px]">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索名称 / 账号 / 网址..."
                className="w-full pl-7 pr-7 py-1 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                  <X size={11} />
                </button>
              )}
            </div>
            <button
              onClick={() => setGroupMode(v => !v)}
              title={groupMode ? '切换为平铺列表' : '按分组折叠展示'}
              className={`flex items-center gap-1 px-1.5 py-1 rounded-md text-[11.5px] border transition-colors ${groupMode ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
            >
              <Layers size={12} /> 分组
            </button>
            {/* 分组模式下没有表头，排序入口移到工具条 */}
            {groupMode && (
              <div className="flex items-center gap-1 ml-auto text-[11px] text-[var(--text-secondary)]">
                <button onClick={() => toggleSort('title')} className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] ${sortKey === 'title' ? 'text-[var(--accent)]' : ''}`}>
                  名称 <SortIcon k="title" />
                </button>
                <button onClick={() => toggleSort('updated')} className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] ${sortKey === 'updated' ? 'text-[var(--accent)]' : ''}`}>
                  更新时间 <SortIcon k="updated" />
                </button>
              </div>
            )}
          </div>

          {/* 表头 */}
          {!loading && totalCount > 0 && !groupMode && (
            <div
              className="grid items-center gap-2 px-3 py-1 bg-[var(--bg-tertiary)] border-b border-[var(--border-color)] text-[10.5px] text-[var(--text-secondary)] shrink-0 select-none"
              style={{ gridTemplateColumns: '24px minmax(140px,2fr) minmax(110px,1.4fr) 148px 116px 72px' }}
            >
              <span />
              <button onClick={() => toggleSort('title')} className="flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors">
                名称 <SortIcon k="title" />
              </button>
              <span>账号</span>
              <span>密码</span>
              <button onClick={() => toggleSort('updated')} className="flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors">
                更新时间 <SortIcon k="updated" />
              </button>
              <span className="text-right">操作</span>
            </div>
          )}

          {/* 列表（总览） */}
          <div ref={listRef} onScroll={onListScroll} className="flex-1 overflow-y-auto min-w-0">
            <div className={`min-w-[660px] ${centeredEmpty ? 'h-full' : ''}`}>
              {listBody()}
            </div>
          </div>
        </>
      ) : (
        /* ---------- 详情 / 编辑 ---------- */
        <div className="flex-1 overflow-y-auto">
          <div className="px-8 py-5 mx-auto space-y-4" style={{ maxWidth: '760px' }}>
            <div className="flex items-center gap-2">
              <button onClick={backToList} className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                <ArrowLeft size={12} /> 全部条目
              </button>
              <span className={`ml-auto flex items-center gap-1.5 text-[11px] ${saving ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>
                <span className={`w-2 h-2 rounded-full ${saving ? 'bg-[var(--warning)]' : 'bg-green-500'}`} />
                {saving ? '未保存' : '已保存'}
              </span>
              <button
                onClick={() => { const next = !favorite; setFavorite(next); favoriteRef.current = next; void setFavoriteFor(view.kind === 'detail' ? view.id : '', next) }}
                title={favorite ? '取消收藏' : '收藏并置顶'}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] border transition-colors ${favorite ? 'border-[var(--warning)] text-[var(--warning)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
              >
                <Star key={favorite ? 'on' : 'off'} size={12} className="kb-micro-pop" fill={favorite ? 'currentColor' : 'none'} /> {favorite ? '已收藏' : '收藏'}
              </button>
            </div>

            {selected ? (
              <>
                {/* 名称 */}
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                    <Globe size={12} /> 名称
                  </label>
                  <input
                    value={title}
                    onChange={e => { setTitle(e.target.value); scheduleSave() }}
                    placeholder="网站 / 应用名称"
                    className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[15px] text-[var(--text-primary)] font-semibold outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                  />
                </div>

                {/* 分组 */}
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                    <Folder size={12} /> 分组
                  </label>
                  <input
                    value={group}
                    onChange={e => { setGroup(e.target.value); scheduleSave() }}
                    list="pv-group-suggest"
                    placeholder="留空 = 未分组（如：工作 / 金融 / 社交）"
                    className="w-full px-3 py-1.5 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                  />
                  <datalist id="pv-group-suggest">
                    {groupNames.map(g => <option key={g} value={g} />)}
                  </datalist>
                </div>

                {/* 账号 + 用户名 */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                      <AtSign size={12} /> 账号
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        value={account}
                        onChange={e => { setAccount(e.target.value); scheduleSave() }}
                        placeholder="邮箱 / 手机号"
                        className="flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                      />
                      <button
                        onClick={() => account && handleCopyText(account, 'account')}
                        disabled={!account}
                        className="shrink-0 p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                        title="复制账号"
                      >
                        {copiedAccount ? <Check size={15} /> : <Copy size={15} />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                      <User size={12} /> 用户名
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        value={username}
                        onChange={e => { setUsername(e.target.value); scheduleSave() }}
                        placeholder="显示名称"
                        className="flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                      />
                      <button
                        onClick={() => username && handleCopyText(username, 'user')}
                        disabled={!username}
                        className="shrink-0 p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                        title="复制用户名"
                      >
                        {copiedUser ? <Check size={15} /> : <Copy size={15} />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* 密码 */}
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                    <Key size={12} /> 密码
                  </label>
                  <div className="flex gap-1.5">
                    <div className="flex-1 flex items-center bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md overflow-hidden">
                      <input
                        value={showPassword ? password : (password ? '••••••••' : '')}
                        onChange={e => { setPassword(e.target.value); scheduleSave() }}
                        readOnly={!showPassword}
                        onClick={() => { if (!showPassword) { setShowPassword(true); requestAnimationFrame(() => { const inp = document.activeElement as HTMLInputElement | null; if (inp) { inp.focus(); inp.select() } }) } }}
                        className={`flex-1 px-3 py-2 bg-transparent text-[13px] text-[var(--text-primary)] outline-none font-mono ${!showPassword ? 'cursor-pointer select-none' : ''}`}
                        placeholder="密码"
                      />
                      <button
                        onClick={() => setShowPassword(v => !v)}
                        className="shrink-0 p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        title={showPassword ? '隐藏' : '显示'}
                      >
                        {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <button
                      onClick={() => { const p = genPassword(); setPassword(p); setShowPassword(true); scheduleSave() }}
                      className="shrink-0 p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                      title="生成强密码"
                    >
                      <RefreshCw size={15} />
                    </button>
                    <button
                      onClick={() => password && handleCopyText(password, 'pass')}
                      disabled={!password}
                      className="shrink-0 p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                      title="复制密码"
                    >
                      {copiedPass ? <Check size={15} /> : <Copy size={15} />}
                    </button>
                  </div>
                </div>

                {/* 网址 */}
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                    <ExternalLink size={12} /> 网址
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      value={url}
                      onChange={e => { setUrl(e.target.value); scheduleSave() }}
                      placeholder="example.com"
                      className="flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                    />
                    <button
                      onClick={() => handleOpenUrl(url)}
                      disabled={!url}
                      className="shrink-0 p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                      title="打开网址"
                    >
                      <ExternalLink size={15} />
                    </button>
                  </div>
                </div>

                {/* 备注 */}
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide">
                    <FileText size={12} /> 备注
                  </label>
                  <textarea
                    value={notes}
                    onChange={e => { setNotes(e.target.value); scheduleSave() }}
                    placeholder="备注信息..."
                    rows={4}
                    className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)] resize-none"
                  />
                </div>

                {/* Meta + Delete */}
                <div className="pt-3 border-t border-[var(--border-color)] flex items-end justify-between">
                  <div className="text-[10px] text-[var(--text-muted)] space-y-0.5">
                    <p>创建：{selected.createdAt ? fmtDate(new Date(selected.createdAt)) : '—'}</p>
                    <p>修改：{selected.updatedAt ? fmtDate(new Date(selected.updatedAt)) : '—'}</p>
                  </div>
                  <button
                    onClick={() => setDeleteTarget(selected.id)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--danger)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Trash2 size={12} /> 删除此条目
                  </button>
                </div>
              </>
            ) : (
              <div className="py-16 text-center text-[12px] text-[var(--text-muted)]">条目不存在或已被删除</div>
            )}
          </div>
        </div>
      )}

      {/* 新建弹窗的分组建议（根级：与详情页的 pv-group-suggest 区分，避免同名 id） */}
      <datalist id="pv-group-suggest-new">
        {groupNames.map(g => <option key={g} value={g} />)}
      </datalist>

      {/* New Entry Modal */}
      {showNewForm && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 kb-overlay" onClick={() => setShowNewForm(false)}>
          <div
            className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-2xl flex flex-col"
            style={{ width: '460px' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
              <span className="text-[13px] font-semibold text-[var(--text-primary)]">新建密码条目</span>
              <button onClick={() => setShowNewForm(false)} className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[var(--text-secondary)] block mb-1">名称 <span className="text-[var(--danger)]">*</span></label>
                  <input
                    autoFocus
                    value={newTitle}
                    onChange={e => setNewTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowNewForm(false) }}
                    placeholder="网站 / 应用"
                    className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[var(--text-secondary)] block mb-1">网址</label>
                  <input
                    value={newUrl}
                    onChange={e => setNewUrl(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
                    placeholder="example.com"
                    className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[var(--text-secondary)] block mb-1">账号</label>
                  <input
                    value={newAccount}
                    onChange={e => setNewAccount(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
                    placeholder="邮箱 / 手机号"
                    className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[var(--text-secondary)] block mb-1">用户名</label>
                  <input
                    value={newUsername}
                    onChange={e => setNewUsername(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
                    placeholder="显示名称"
                    className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-[var(--text-secondary)] block mb-1">密码</label>
                <div className="flex gap-1.5">
                  <input
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
                    placeholder="密码"
                    className="flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)] font-mono"
                  />
                  <button
                    onClick={() => setNewPassword(genPassword())}
                    title="生成强密码"
                    className="shrink-0 px-2 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-[var(--text-secondary)] block mb-1">分组</label>
                <input
                  value={newGroup}
                  onChange={e => setNewGroup(e.target.value)}
                  list="pv-group-suggest-new"
                  placeholder="留空 = 未分组"
                  className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                />
              </div>

              <div>
                <label className="text-[11px] font-medium text-[var(--text-secondary)] block mb-1">备注</label>
                <textarea
                  value={newNotes}
                  onChange={e => setNewNotes(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setShowNewForm(false) }}
                  placeholder="备注信息..."
                  rows={2}
                  className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-md text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)] resize-none"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border-color)]">
              <button onClick={() => setShowNewForm(false)} className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">取消</button>
              <button onClick={handleCreate} disabled={!newTitle.trim()} className="flex items-center px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">添加</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 kb-overlay" onClick={() => setDeleteTarget(null)}>
          <div
            className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-2xl p-5"
            style={{ width: '360px' }}
            onClick={e => e.stopPropagation()}
          >
            <p className="text-[13px] text-[var(--text-primary)] mb-1 font-medium">确认删除</p>
            <p className="text-[11px] text-[var(--text-muted)] mb-4">此操作不可撤销，确定要删除此密码条目吗？</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">取消</button>
              <button onClick={() => handleDelete(deleteTarget)} className="px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--danger)] text-white hover:opacity-90 transition-colors">删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 条目名首字母色块（颜色由名称哈希决定，稳定不跳色） */
function Avatar({ title }: { title: string }) {
  const t = title || '?'
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360
  const ch = t.trim().charAt(0).toUpperCase()
  return (
    <div
      className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-semibold shrink-0"
      style={{ background: `hsl(${h} 60% 50% / 0.16)`, color: `hsl(${h} 65% 45%)` }}
    >
      {ch}
    </div>
  )
}

function fmtDate(d: Date): string {
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
