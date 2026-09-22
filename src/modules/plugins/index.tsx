import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Search, FolderOpen, Download, Loader2,
  CheckCircle2, AlertTriangle, ArrowLeft, ShieldCheck, ShieldAlert, Shield, Boxes,
  History, Trash2, ScrollText, Package } from 'lucide-react'
import { PluginIcon } from '../../components/shared/ModuleIcons'
import {
  pluginFetchRegistry, pluginInstall, pluginInstallFromFile,
  pluginListInstalled, pluginSetEnabled, pluginUninstall, pluginGetContribution,
  pluginSetGranted, pluginAuditList, pluginAuditClear, pluginAuditWrite,
  pluginGetAllowedLevels, pluginSetAllowedLevels,
  createHabit, createBookmarkCategory, createBookmarkItem, bookmarkGetAll,
  knowledgePackGetState, knowledgePackImport, onKnowledgePackProgress,
} from '../../lib/ipc'
import { useSettings } from '../../lib/SettingsContext'
import { showToast } from '../../lib/toast'
import { startBackgroundPluginInstall } from '../../lib/pluginDownloadBus'
import { PluginIconImg } from '../../components/shared/PluginIconImg'
import { PluginSettingsForm } from './PluginSettingsForm'
import type { PluginSummary, PluginRegistryEntry, PluginAuditEntry, PluginRiskLevel } from '../../types'

/**
 * 插件管理模块 —— 对标 VS Code 扩展市场布局 + S/A/B 安全分级:
 * 左侧面板(已安装 / 市场 + 搜索 + 等级筛选),右侧详情页(等级徽章 / 能力与授权 / 最近活动)。
 */

const CONTRIBUTION_LABELS: Record<string, string> = {
  blogTemplates: '博客模板',
  theme: '主题',
  habitPresets: '习惯预设',
  bookmarkPresets: '网址包',
  pomodoroPresets: '番茄钟预设',
  helpDocs: '帮助文档',
  tools: '工具卡片',
  automationRule: '自动化规则',
  knowledgePages: '知识内容',
  skills: 'Skill',
}

const CONTRIBUTION_HINTS: Record<string, string> = {
  blogTemplates: '写博工具栏「模板」弹层中可见',
  theme: '设置 → 外观 的主题列表中可选',
  habitPresets: '点击导入后进入「习惯打卡」',
  bookmarkPresets: '点击导入后进入「网址导航」,自动去重',
  pomodoroPresets: '番茄钟面板的预设按钮组中可见',
  helpDocs: '帮助模块侧栏「插件」分类中可见',
  tools: '工具箱「插件工具」区可见',
  automationRule: '自动化规则(Tier1 预留)',
  knowledgePages: '导入到知识库(创建空间/笔记本/章节/页面)',
  skills: '提示词技能,设置 → AI 工具 → Skill 中查看、停用与独立安装',
}
const CAPABILITY_LABELS: Record<string, string> = {
  clipboard: '剪贴板写入',
  theme: '主题变量注入',
  data: '自有数据表读写',
  knowledge: '知识库访问与重刷',
  navigation: '导航跳转',
  files: '本地文件读取',
  'vault:read': '知识库检索(只读)',
  'vault:write': '仓库文件写入',
}

const CAPABILITY_DESCS: Record<string, string> = {
  clipboard: '允许插件将内容(如生成的密码)复制到系统剪贴板',
  theme: '允许插件临时调整应用配色变量(关闭即恢复)',
  data: '允许插件读写它自己的数据表(plugin_<id>_*，无法访问其他插件或宿主库表)',
  knowledge: '允许插件打开宿主刷题器等知识功能(判题写入插件自己的数据表)',
  navigation: '允许插件请求跳转到指定页面',
  files: '允许插件弹系统对话框挑文件并读取其内容(每次经你手动确认,不会静默访问磁盘)',
  'vault:read': '允许插件检索与读取知识库笔记的元数据(标题/标签/属性/链接/搜索,只读,不能修改任何内容)',
  'vault:write': '允许插件写入或删除仓库内的普通 .md/.txt 文件(受插件声明目录范围与保护区规则约束,不涉及 .knowbase 内部数据)',
}

const DATA_TARGETS: Record<string, string> = {
  habitPresets: '习惯打卡(写入习惯与预设)',
  bookmarkPresets: '网址导航(写入分类与书签)',
  automationRule: '自动化(写入规则配置)',
  knowledgePages: '知识库(创建空间与页面,可随更新维护)',
}

const LEVEL_META: Record<PluginRiskLevel, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  S: { label: '内容', color: 'var(--success)', bg: 'var(--success)', icon: <ShieldCheck size={11} /> },
  A: { label: '数据写入', color: 'var(--warning)', bg: 'var(--warning)', icon: <ShieldAlert size={11} /> },
  B: { label: '增强能力', color: 'var(--danger)', bg: 'var(--danger)', icon: <Shield size={11} /> },
  C: { label: '模块', color: '#7f77dd', bg: '#7f77dd', icon: <Boxes size={11} /> },
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  install: '安装', update: '更新', grant: '授权变更', deny: '已拒绝可疑调用',
  import: '数据导入', run: '执行', uninstall: '卸载',
}

function LevelBadge({ level, size = 'sm' }: { level: PluginRiskLevel; size?: 'sm' | 'lg' }) {
  const meta = LEVEL_META[level]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-medium shrink-0 ${size === 'lg' ? 'px-2 py-0.5 text-[11px]' : 'px-1.5 py-px text-[10px]'}`}
      style={{ color: meta.color, border: `1px solid ${meta.color}55`, background: `${meta.color}14` }}
      title={`安全等级 ${level} · ${meta.label}`}
    >
      {meta.icon}{meta.label}
    </span>
  )
}

type MarketSelection = { kind: 'installed'; plugin: PluginSummary } | { kind: 'market'; plugin: PluginRegistryEntry & { iconUrl?: string; riskLevel?: PluginRiskLevel; contributions?: string[]; capabilities?: string[] } }

interface ConsentState {
  entry: PluginRegistryEntry & { riskLevel?: PluginRiskLevel; contributions?: string[]; capabilities?: string[] }
  isUpdate: boolean
  level: PluginRiskLevel
  newContributions: string[]
  newCapabilities: string[]
  granted: string[]
}

export function PluginsModule() {
  const { s, update } = useSettings()
  const [tab, setTab] = useState<'installed' | 'market'>('installed')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [installed, setInstalled] = useState<PluginSummary[]>([])
  const [market, setMarket] = useState<PluginRegistryEntry[]>([])
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketError, setMarketError] = useState('')
  const [selected, setSelected] = useState<MarketSelection | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [importedKeys, setImportedKeys] = useState<Set<string>>(new Set())
  const [consent, setConsent] = useState<ConsentState | null>(null)
  const [consentPackInfo, setConsentPackInfo] = useState<{ spaceName?: string; notebookCount?: number; totalPages?: number } | null>(null)

  useEffect(() => {
    setConsentPackInfo(null)
    if (consent && (consent.entry.contributions || []).includes('knowledgePages')) {
      knowledgePackGetState(consent.entry.id).then(r => {
        if (r.ok) setConsentPackInfo({ spaceName: r.spaceName, notebookCount: r.notebookCount, totalPages: r.totalPages })
      }).catch(() => { /* ignore */ })
    }
  }, [consent])
  const [auditRows, setAuditRows] = useState<PluginAuditEntry[]>([])

  // 内容型插件(knowledgePages)导入状态
  const [kpState, setKpState] = useState<{ state: string; chapters?: number; totalPages?: number; newPages?: number; changedPages?: number; lastImportedAt?: string } | null>(null)
  const [kpNotebook, setKpNotebook] = useState('')
  const [kpBusy, setKpBusy] = useState(false)
  const [kpProgress, setKpProgress] = useState<{ current: number; total: number; title: string } | null>(null)
  const [kpConfirm, setKpConfirm] = useState<{ overwrite: boolean } | null>(null)
  // 冲突管理面板:本次导入因"本地已修改"等被跳过的页面清单 + 勾选强制覆盖
  const [kpConflicts, setKpConflicts] = useState<{ title: string; reason: string; externalId: string }[] | null>(null)
  const [kpForceSel, setKpForceSel] = useState<Set<string>>(new Set())

  const refreshInstalled = useCallback(async () => {
    try { setInstalled(await pluginListInstalled()) } catch { /* 忽略 */ }
  }, [])

  useEffect(() => { refreshInstalled() }, [refreshInstalled])

  /** C 级模块插件白名单（pluginAllowedLevels） */
  const [allowedLevels, setAllowedLevels] = useState<string[]>(['S', 'A', 'B'])
  useEffect(() => {
    pluginGetAllowedLevels().then(setAllowedLevels).catch(() => { /* ignore */ })
  }, [])
  const toggleLevelC = async (on: boolean) => {
    const next = on
      ? Array.from(new Set([...allowedLevels, 'C']))
      : allowedLevels.filter(x => x !== 'C')
    const r = await pluginSetAllowedLevels(next)
    if (r.success) {
      setAllowedLevels(next)
      showToast({ type: 'info', message: on ? '已允许 C 级模块插件（可读写自有数据表）' : '已关闭 C 级模块插件许可' })
    } else {
      showToast({ type: 'error', message: r.message || '设置失败' })
    }
  }

  const loadMarket = useCallback(async (force = false) => {
    setMarketLoading(true); setMarketError('')
    const r = await pluginFetchRegistry()
    if (r.ok) setMarket(r.plugins)
    else setMarketError(r.message || '插件仓库暂时不可用')
    setMarketLoading(false)
  }, [])

  useEffect(() => { if (tab === 'market' && market.length === 0 && !marketError) loadMarket() }, [tab, market.length, marketError, loadMarket])

  // 选中已安装插件时加载其最近活动
  useEffect(() => {
    if (selected?.kind === 'installed' && !selected.plugin.broken) {
      pluginAuditList(selected.plugin.id).then(setAuditRows).catch(() => setAuditRows([]))
    } else setAuditRows([])
  }, [selected])

  // 内容型插件:加载导入状态
  useEffect(() => {
    if (selected?.kind === 'installed' && selected.plugin.contributions.includes('knowledgePages') && !selected.plugin.broken) {
      knowledgePackGetState(selected.plugin.id).then(r => setKpState(r.ok ? { state: r.state!, chapters: r.chapters, totalPages: r.totalPages, newPages: r.newPages, changedPages: r.changedPages, lastImportedAt: r.lastImportedAt } : null)).catch(() => setKpState(null))
      pluginGetContribution(selected.plugin.id, 'knowledgePages').then(r => {
        const nb = (r.data as { notebook?: unknown } | undefined)?.notebook
        setKpNotebook(typeof nb === 'string' ? nb : '')
      }).catch(() => setKpNotebook(''))
    } else { setKpState(null); setKpNotebook('') }
  }, [selected])

  useEffect(() => onKnowledgePackProgress(p => {
    if (selected?.kind === 'installed' && selected.plugin.id === p.pluginId) {
      setKpProgress({ current: p.current, total: p.total, title: p.title })
    }
  }), [selected])

  // ---------- 安装(含分级授权流程) ----------

  const beginInstall = (p: PluginRegistryEntry & { riskLevel?: PluginRiskLevel; contributions?: string[]; capabilities?: string[] }) => {
    const level: PluginRiskLevel = p.riskLevel || 'S'
    const existing = installed.find(x => x.id === p.id)
    const isUpdate = Boolean(existing)

    if (level === 'B' || level === 'C') {
      // B/C 级:逐能力勾选(更新时默认勾选既有授权,新增能力需手动勾)
      const prev = existing?.grantedCapabilities || []
      const declared = p.capabilities || []
      const initial = isUpdate ? declared.filter(c => prev.includes(c)) : declared
      const newCaps = declared.filter(c => !prev.includes(c))
      setConsent({ entry: p, isUpdate, level, newContributions: [], newCapabilities: newCaps, granted: initial })
      return
    }

    if (level === 'A') {
      const dataKeys = (p.contributions || []).filter(k => k === 'habitPresets' || k === 'bookmarkPresets' || k === 'automationRule')
      const newKeys = isUpdate ? dataKeys.filter(k => !(existing?.contributions || []).includes(k)) : []
      // 更新且没有新增数据写入能力 → 免重新确认(沿用既有授权)
      if (isUpdate && newKeys.length === 0) { doInstall(p, undefined); return }
      setConsent({ entry: p, isUpdate, level, newContributions: newKeys, newCapabilities: [], granted: [] })
      return
    }

    // S 级:免授权直接装
    doInstall(p, undefined)
  }

  const doInstall = (p: PluginRegistryEntry, granted?: string[]) => {
    // 后台安装:立即返回,下载/解压经总线分发进度,切页不中断(全局 StatusBar 有指示)
    setConsent(null)
    startBackgroundPluginInstall({
      url: p.downloadUrl,
      name: p.name,
      granted,
      invoke: (url, g) => pluginInstall(url, g),
      onSettled: r => {
        if (r.success) {
          showToast({ type: 'success', message: `「${p.name}」安装成功` })
          window.dispatchEvent(new CustomEvent('plugins-changed'))
          void refreshInstalled()
        } else {
          showToast({ type: 'error', message: r.message || '安装失败' })
        }
      },
    })
  }

  const handleInstallFromFile = async () => {
    setBusy(true)
    const r = await pluginInstallFromFile()
    setBusy(false)
    if (r.success) {
      showToast({ type: 'success', message: '插件安装成功' })
      window.dispatchEvent(new CustomEvent('plugins-changed'))
      await refreshInstalled()
      setTab('installed')
    } else if (r.message && r.message !== '已取消') {
      showToast({ type: 'error', message: r.message })
    }
  }

  const handleToggle = async (p: PluginSummary) => {
    // A/B 级禁用后重新启用 = 沿用既有授权,即时生效(授权在安装时已确认)
    setBusy(true)
    const r = await pluginSetEnabled(p.id, !p.enabled)
    setBusy(false)
    if (r.success) {
      await refreshInstalled()
      setSelected(s => s?.kind === 'installed' ? { kind: 'installed', plugin: { ...s.plugin, enabled: !p.enabled } } : s)
      // 知识包插件的导入状态随启停联动(禁用 → 锁定不可导入/更新)
      if (p.contributions.includes('knowledgePages')) {
        knowledgePackGetState(p.id).then(rs => setKpState(rs.ok ? { state: rs.state!, chapters: rs.chapters, totalPages: rs.totalPages, newPages: rs.newPages, changedPages: rs.changedPages, lastImportedAt: rs.lastImportedAt } : null)).catch(() => {})
      }
      import('../../lib/pluginService').then(m => m.ensurePluginThemeStyles()).catch(() => {})
      window.dispatchEvent(new CustomEvent('plugins-changed'))
      showToast({ type: 'success', message: p.enabled ? '插件已禁用' : '插件已启用' })
    } else showToast({ type: 'error', message: r.message || '操作失败' })
  }

  const handleUninstall = async (p: PluginSummary) => {
    if (confirmDeleteId !== p.id) { setConfirmDeleteId(p.id); setTimeout(() => setConfirmDeleteId(id => id === p.id ? null : id), 3000); return }
    setBusy(true)
    const r = await pluginUninstall(p.id)
    setBusy(false)
    setConfirmDeleteId(null)
    if (r.success) {
      showToast({ type: 'success', message: p.riskLevel === 'A' ? '插件已卸载(已导入的数据保留)' : '插件已卸载' })
      setSelected(null)
      window.dispatchEvent(new CustomEvent('plugins-changed'))
      await refreshInstalled()
      import('../../lib/pluginService').then(m => m.ensurePluginThemeStyles()).catch(() => {})
    } else showToast({ type: 'error', message: r.message || '卸载失败' })
  }

  const handleSetGranted = async (p: PluginSummary, caps: string[]) => {
    setBusy(true)
    const r = await pluginSetGranted(p.id, caps)
    setBusy(false)
    if (r.success) {
      await refreshInstalled()
      setSelected(s => s?.kind === 'installed' ? { kind: 'installed', plugin: { ...s.plugin, grantedCapabilities: caps } } : s)
      showToast({ type: 'info', message: caps.length ? `已授权:${caps.map(c => CAPABILITY_LABELS[c] || c).join('、')}` : '已撤销全部能力授权' })
    } else showToast({ type: 'error', message: r.message || '操作失败' })
  }

  // ---------- 预设导入(A 级数据写入,记审计) ----------

  const markImported = (id: string, key: string) => setImportedKeys(prev => new Set(prev).add(`${id}:${key}`))

  const importHabitPresets = async (p: PluginSummary) => {
    setBusy(true)
    const r = await pluginGetContribution(p.id, 'habitPresets')
    if (!r.ok || !Array.isArray(r.data)) {
      setBusy(false); showToast({ type: 'error', message: r.message || '读取预设失败' }); return
    }
    let ok = 0
    for (const raw of r.data as Record<string, unknown>[]) {
      if (typeof raw?.name !== 'string' || !raw.name.trim()) continue
      try {
        await createHabit({
          name: raw.name.trim(),
          color: typeof raw.color === 'string' ? raw.color : undefined,
          ruleType: raw.ruleType === 'weekdays' || raw.ruleType === 'flexible' ? raw.ruleType : 'daily',
          ruleDays: Array.isArray(raw.ruleDays) ? (raw.ruleDays as number[]) : undefined,
          weeklyTarget: typeof raw.weeklyTarget === 'number' ? raw.weeklyTarget : undefined,
        })
        ok++
      } catch { /* 单条失败继续 */ }
    }
    setBusy(false)
    pluginAuditWrite(p.id, 'import', { type: 'habitPresets', count: ok })
    if (ok > 0) { showToast({ type: 'success', message: `已导入 ${ok} 个习惯` }); markImported(p.id, 'habitPresets') }
    else showToast({ type: 'error', message: '没有可导入的预设' })
  }

  const importBookmarkPresets = async (p: PluginSummary) => {
    setBusy(true)
    const r = await pluginGetContribution(p.id, 'bookmarkPresets')
    if (!r.ok || !Array.isArray(r.data)) {
      setBusy(false); showToast({ type: 'error', message: r.message || '读取网址包失败' }); return
    }
    let existing = new Set<string>()
    try {
      const all = await bookmarkGetAll()
      existing = new Set((all?.bookmarks || []).map((b: { url: string }) => b.url.toLowerCase()))
    } catch { /* 忽略,不去重 */ }
    let catOk = 0, bmOk = 0, skipped = 0
    for (const group of r.data as Record<string, unknown>[]) {
      const catName = typeof group?.name === 'string' && group.name.trim() ? group.name.trim() : '插件导入'
      const color = typeof group?.color === 'string' ? group.color : undefined
      if (!Array.isArray(group?.bookmarks) || group.bookmarks.length === 0) continue
      try {
        const cat = await createBookmarkCategory({ name: catName, color })
        catOk++
        for (const b of group.bookmarks as Record<string, unknown>[]) {
          if (typeof b?.title !== 'string' || typeof b?.url !== 'string' || !b.title.trim() || !b.url.trim()) { skipped++; continue }
          const normalized = b.url.trim()
          if (existing.has(normalized.toLowerCase())) { skipped++; continue }
          try {
            await createBookmarkItem({ title: b.title.trim(), url: normalized, description: typeof b.description === 'string' ? b.description : undefined, categoryId: cat.id })
            existing.add(normalized.toLowerCase())
            bmOk++
          } catch { skipped++ }
        }
      } catch { /* 单组失败继续 */ }
    }
    setBusy(false)
    pluginAuditWrite(p.id, 'import', { type: 'bookmarkPresets', categories: catOk, bookmarks: bmOk, skipped })
    if (bmOk > 0) {
      showToast({ type: 'success', message: `已导入 ${catOk} 个分类、${bmOk} 个书签${skipped > 0 ? `,跳过重复 ${skipped} 个` : ''}` })
      markImported(p.id, 'bookmarkPresets')
    } else showToast({ type: 'error', message: '没有可导入的书签' })
  }

  const doImportPack = async (overwrite: boolean, forceIds?: string[]) => {
    if (selected?.kind !== 'installed') return
    const p = selected.plugin
    setKpBusy(true); setKpConfirm(null); setKpConflicts(null); setKpForceSel(new Set()); setKpProgress({ current: 0, total: kpState?.totalPages || 0, title: '' })
    const r = await knowledgePackImport(p.id, overwrite, forceIds)
    setKpBusy(false); setKpProgress(null)
    if (r.ok) {
      const conflictNote = (forceIds?.length || 0) > 0 ? `,已覆盖所选 ${forceIds!.length} 页` : ''
      showToast({ type: 'success', message: `导入完成:新建 ${r.created || 0} 页,更新 ${r.updated || 0} 页${r.skipped ? `,跳过 ${r.skipped}` : ''}${conflictNote}` })
      // 冲突清单可视化:有被保护性跳过的页面时弹出独立面板
      if (r.conflicts && r.conflicts.length > 0) {
        setKpConflicts(r.conflicts)
        setKpForceSel(new Set(r.conflicts.map(c => c.externalId)))
      }
      // 通知知识库模块刷新目录(模块常驻挂载,不会自行感知导入结果)
      window.dispatchEvent(new CustomEvent('data-imported', { detail: { module: 'knowledge' } }))
      knowledgePackGetState(p.id).then(s => setKpState(s.ok ? { state: s.state!, chapters: s.chapters, totalPages: s.totalPages, newPages: s.newPages, changedPages: s.changedPages, lastImportedAt: s.lastImportedAt } : null)).catch(() => {})
      pluginAuditList(p.id).then(setAuditRows).catch(() => {})
    } else {
      showToast({ type: 'error', message: r.message || '导入失败' })
    }
  }

  /** 冲突面板:仅覆盖勾选的页面(不带全局 overwrite) */
  const overwriteSelected = async () => {
    if (kpForceSel.size === 0) { setKpConflicts(null); return }
    await doImportPack(false, [...kpForceSel])
  }

  // ---------- 派生与筛选 ----------

  const installedIds: Record<string, string> = Object.fromEntries(installed.map(p => [p.id, p.version]))
  const q = search.trim().toLowerCase()
  const matchText = (name: string, desc: string | undefined, id: string) =>
    !q || name.toLowerCase().includes(q) || (desc || '').toLowerCase().includes(q) || id.includes(q)
  const filteredInstalled = installed.filter(p => matchText(p.name, p.description, p.id))
  const filteredMarket = market.filter(p => matchText(p.name, p.description, p.id) && (!categoryFilter || (p.category || '其他') === categoryFilter))

  // ---------- 列表项 ----------

  const listItem = (key: string, active: boolean, onClick: () => void, node: React.ReactNode) => (
    <button
      key={key}
      onClick={onClick}
      className={`w-full flex items-start gap-2.5 px-2 py-1.5 text-left border-l-2 transition-colors ${
        active ? 'bg-[var(--bg-hover)] border-l-[var(--accent)]' : 'border-l-transparent hover:bg-[var(--bg-hover)]'
      }`}
    >
      {node}
    </button>
  )

  const installedItem = (p: PluginSummary) => {
    const active = selected?.kind === 'installed' && selected.plugin.id === p.id
    return listItem(`in-${p.id}`, active, () => setSelected({ kind: 'installed', plugin: p }), (
      <>
        <PluginIconImg src={p.icon} size={15} className={`shrink-0 mt-0.5 ${p.enabled && !p.broken ? 'text-[var(--accent)]' : 'text-[var(--text-disabled)]'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-[13px] font-medium truncate ${p.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{p.name}</span>
            <span className="text-[10px] text-[var(--text-disabled)] font-mono shrink-0">v{p.version}</span>
            {p.builtin && <span className="text-[9px] px-1 py-px rounded bg-[var(--accent)]/10 text-[var(--accent)] shrink-0">内置</span>}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
            {p.broken ? '⚠ 数据损坏' : !p.enabled ? '已禁用' : (p.description || p.id)}
          </div>
        </div>
      </>
    ))
  }

  const marketItem = (p: PluginRegistryEntry) => {
    const active = selected?.kind === 'market' && selected.plugin.id === p.id
    const installedVer = installedIds[p.id]
    return listItem(`mk-${p.id}`, active, () => setSelected({ kind: 'market', plugin: p }), (
      <>
        <PluginIconImg src={p.iconUrl} size={15} className="shrink-0 mt-0.5 text-[var(--accent)]" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">{p.name}</span>
            <span className="text-[10px] text-[var(--text-disabled)] font-mono shrink-0">v{p.version}</span>
            {installedVer && <span className="text-[10px] text-[var(--success)] shrink-0">✓</span>}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
            {p.category && <span className="text-[10px] text-[var(--accent)] mr-1">{p.category}</span>}
            {p.description || p.id}
          </div>
        </div>
      </>
    ))
  }

  // ---------- 授权确认弹窗 ----------

  const renderConsent = () => {
    if (!consent) return null
    const { entry, level, isUpdate, newContributions, newCapabilities, granted } = consent
    const dataTargets = (entry.contributions || []).filter(k => DATA_TARGETS[k])
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 kb-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setConsent(null) }}>
        <div className="w-[440px] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--border-color)]">
            <div className="flex items-center gap-2 mb-1">
              <ShieldAlert size={15} className="text-[var(--warning)]" />
              <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                {isUpdate ? '更新需要重新确认' : '安装前请确认'}
              </h3>
            </div>
            <p className="text-[12px] text-[var(--text-muted)]">
              「{entry.name}」v{entry.version} · 安全等级 <LevelBadge level={level} />
            </p>
          </div>
          <div className="px-5 py-4 space-y-3 text-[12px] text-[var(--text-secondary)] leading-relaxed">
            {level === 'A' && (
              <>
                {(entry.contributions || []).includes('knowledgePages') && (
                  <p className="p-2.5 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--text-primary)]">
                    将在知识库<strong>新建学习空间</strong>
                    {consentPackInfo?.spaceName ? <>《{consentPackInfo.spaceName}》</> : null}
                    {consentPackInfo ? <>(含 {consentPackInfo.notebookCount ?? 1} 笔记本 · {consentPackInfo.totalPages ?? '?'} 页)</> : null}
                    ，卸载后内容保留。
                  </p>
                )}
                <p>该插件的数据导入功能将写入以下模块:</p>
                <ul className="space-y-1">
                  {dataTargets.map(k => (
                    <li key={k} className="flex items-center gap-2">
                      <AlertTriangle size={12} className="text-[var(--warning)] shrink-0" />
                      {DATA_TARGETS[k]}
                    </li>
                  ))}
                </ul>
                {isUpdate && newContributions.length > 0 && (
                  <p className="text-[var(--warning)]">
                    本次更新新增了写入能力({newContributions.map(k => CONTRIBUTION_LABELS[k] || k).join('、')}),需重新确认。
                  </p>
                )}
                <p className="text-[11px] text-[var(--text-muted)]">已导入数据在卸载后保留。</p>
              </>
            )}
            {level === 'B' && (
              <>
                <p>请勾选允许该插件使用的能力:</p>
                <div className="space-y-2">
                  {(entry.capabilities || []).map(c => (
                    <label key={c} className="flex items-start gap-2.5 p-2.5 rounded-md border border-[var(--border-color)] cursor-pointer hover:bg-[var(--bg-hover)]">
                      <input
                        type="checkbox"
                        checked={granted.includes(c)}
                        onChange={e => setConsent(v => v ? { ...v, granted: e.target.checked ? [...v.granted, c] : v.granted.filter(x => x !== c) } : v)}
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      <span>
                        <span className="block text-[12px] font-medium text-[var(--text-primary)]">{CAPABILITY_LABELS[c] || c}</span>
                        <span className="block text-[11px] text-[var(--text-muted)]">{CAPABILITY_DESCS[c] || ''}</span>
                      </span>
                    </label>
                  ))}
                  {newCapabilities.length > 0 && (
                    <p className="text-[var(--warning)] text-[11px]">
                      新增能力:{newCapabilities.map(c => CAPABILITY_LABELS[c] || c).join('、')}，需重新授权。
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="px-5 py-3 border-t border-[var(--border-color)] flex justify-end gap-2">
            <button onClick={() => setConsent(null)} className="px-3.5 py-2 text-[12px] text-[var(--text-secondary)] border border-[var(--border-color)] rounded-md hover:bg-[var(--bg-hover)] transition-colors">
              取消
            </button>
            <button
              onClick={() => doInstall(entry, (level === 'B' || level === 'C') ? granted : undefined)}
              disabled={busy}
              className="px-4 py-2 text-[12px] font-medium text-white bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : isUpdate ? '确认更新' : '确认安装'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ---------- 右侧详情 ----------

  const renderDetail = () => {
    if (!selected) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
          <PluginIcon size={40} strokeWidth={1.2} className="text-[var(--text-disabled)]" />
          <p className="text-[13px]">选择一个插件查看详情</p>
        </div>
      )
    }

    if (selected.kind === 'market') {
      const p = selected.plugin
      const level = (p.riskLevel || 'S') as PluginRiskLevel
      const installedVer = installedIds[p.id]
      const updatable = installedVer && installedVer !== p.version
      return (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-6 py-4">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-14 h-14 rounded-xl bg-[var(--accent)]/10 flex items-center justify-center shrink-0">
                <PluginIconImg src={p.iconUrl} size={34} className="text-[var(--accent)]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-[15px] font-medium text-[var(--text-primary)] leading-tight">{p.name}</h2>
                  <LevelBadge level={level} />
                </div>
                <div className="text-[12px] text-[var(--text-muted)] mt-1">
                  {p.author || '未知作者'} · v{p.version}
                  {p.size ? ` · ${(p.size / 1024).toFixed(1)} KB` : ''}
                </div>
              </div>
              <div className="shrink-0">
                {busy ? <Loader2 size={16} className="animate-spin text-[var(--accent)] mt-2" /> : updatable ? (
                  <button onClick={() => beginInstall(p)} className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium text-white bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] transition-colors">
                    <Download size={13} />更新
                  </button>
                ) : installedVer ? (
                  <span className="flex items-center gap-1.5 text-[12px] text-[var(--success)] px-2 py-2"><CheckCircle2 size={14} />已安装</span>
                ) : (
                  <button onClick={() => beginInstall(p)} className="flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium text-white bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] transition-colors">
                    <Download size={13} />安装
                  </button>
                )}
              </div>
            </div>

            {p.description && <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed mb-6">{p.description}</p>}

            <SectionTitle>更多信息</SectionTitle>
            <div className="text-[12px] space-y-1.5 text-[var(--text-muted)]">
              <div className="flex"><span className="w-24 shrink-0">插件 ID</span><span className="font-mono text-[var(--text-secondary)]">{p.id}</span></div>
              <div className="flex"><span className="w-24 shrink-0">安全等级</span><span>{level} · {LEVEL_META[level].label}</span></div>
              {level === 'B' && <div className="flex"><span className="w-24 shrink-0">能力</span><span>{(p.capabilities || []).map(c => CAPABILITY_LABELS[c] || c).join('、') || '无'}</span></div>}
              <div className="flex"><span className="w-24 shrink-0">版本</span><span className="font-mono text-[var(--text-secondary)]">v{p.version}</span></div>
              {p.updatedAt && <div className="flex"><span className="w-24 shrink-0">最近更新</span><span>{p.updatedAt}</span></div>}
            </div>
          </div>
        </div>
      )
    }

    // 已安装详情
    const p = selected.plugin
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className="flex items-start gap-4 mb-5">
            <div className={`w-14 h-14 rounded-xl flex items-center justify-center shrink-0 ${p.enabled && !p.broken ? 'bg-[var(--accent)]/10' : 'bg-[var(--bg-tertiary)]'}`}>
              <PluginIconImg src={p.icon} size={34} className={p.enabled && !p.broken ? 'text-[var(--accent)]' : 'text-[var(--text-disabled)]'} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-medium text-[var(--text-primary)] leading-tight">{p.name}</h2>
                <LevelBadge level={p.riskLevel} size="lg" />
                {p.builtin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)]">内置</span>}
              </div>
              <div className="text-[12px] text-[var(--text-muted)] mt-1">
                {p.author || '未知作者'} · v{p.version} · 安装于 {p.installedAt.slice(0, 10)}
              </div>
              {p.broken && (
                <div className="flex items-center gap-1.5 text-[12px] text-[var(--danger)] mt-1">
                  <AlertTriangle size={13} />插件数据损坏,建议卸载后重新安装
                </div>
              )}
              {p.legacyGrant && (
                <div className="text-[11px] text-[var(--text-muted)] mt-1">沿用旧版权限，更新时重新确认。</div>
              )}
            </div>
            <button
              onClick={() => handleToggle(p)}
              disabled={busy || p.broken}
              className={`shrink-0 relative w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${p.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)] border border-[var(--border-color)]'}`}
              title={p.enabled ? '点击禁用' : '点击启用'}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${p.enabled ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>

          {p.description && <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed mb-6">{p.description}</p>}

          {/* 能力与授权(B/C 级可执行插件: ui 与 code 均可声明能力) */}
          {(p.type === 'ui' || p.type === 'code') && !p.broken && (
            <>
              <SectionTitle>能力与授权</SectionTitle>
              <div className="space-y-2 mb-8">
                {p.capabilities.length === 0 ? (
                  <div className="text-[12px] text-[var(--text-muted)]">该插件未申请任何能力(零能力运行)。</div>
                ) : p.capabilities.map(c => {
                  const granted = p.grantedCapabilities.includes(c)
                  return (
                    <div key={c} className="flex items-center gap-3 p-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                      {granted ? <CheckCircle2 size={14} className="text-[var(--success)] shrink-0" /> : <Shield size={14} className="text-[var(--text-disabled)] shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-medium text-[var(--text-primary)]">{CAPABILITY_LABELS[c] || c}</div>
                        <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{CAPABILITY_DESCS[c] || ''}</div>
                      </div>
                      <button
                        onClick={() => handleSetGranted(p, granted ? p.grantedCapabilities.filter(x => x !== c) : [...p.grantedCapabilities, c])}
                        disabled={busy}
                        className={`shrink-0 px-2.5 py-1 text-[11px] rounded transition-colors ${
                          granted
                            ? 'text-[var(--text-secondary)] border border-[var(--border-color)] hover:bg-[var(--bg-hover)]'
                            : 'text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)]'
                        }`}
                      >
                        {granted ? '撤销' : '授权'}
                      </button>
                    </div>
                  )
                })}
                <p className="text-[11px] text-[var(--text-muted)]">撤销后对应操作将被拒绝。</p>
              </div>
            </>
          )}

          {/* 声明式设置（plugin-phase1-design C5）：schema 驱动表单，值落插件私有 kb.store */}
          {p.enabled && !p.broken && <PluginSettingsForm pluginId={p.id} />}

          <SectionTitle>提供的内容</SectionTitle>
          <div className="space-y-2 mb-8">
            {p.broken ? (
              <div className="text-[12px] text-[var(--text-muted)]">无法读取</div>
            ) : p.contributions.length === 0 ? (
              <div className="text-[12px] text-[var(--text-muted)]">无</div>
            ) :             p.contributions.map(key => {
              const imported = importedKeys.has(`${p.id}:${key}`)
              const importable = key === 'habitPresets' || key === 'bookmarkPresets'
              // 内容型插件:专属导入 UI(状态/进度/确认)
              if (key === 'knowledgePages') {
                const st = kpState?.state
                return (
                  <div key={key} className="p-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 size={14} className="text-[var(--accent)] shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-medium text-[var(--text-primary)]">
                          知识内容{kpState ? ` · ${kpState.chapters || 0} 章 · ${kpState.totalPages || 0} 页` : ''}
                        </div>
                        <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                          {kpBusy && kpProgress
                            ? `正在导入 ${kpProgress.current}/${kpProgress.total}${kpProgress.title ? `:${kpProgress.title}` : ''}`
                            : st === 'disabled' ? '插件已禁用,启用后才能导入与更新'
                            : st === 'not-imported' ? '未导入,导入后成为知识库中的完整笔记本'
                            : st === 'update-available' ? `有可用更新(新增 ${kpState?.newPages || 0} 页,变化 ${kpState?.changedPages || 0} 页)`
                            : st === 'imported' ? `已导入${kpState?.lastImportedAt ? ` · ${kpState.lastImportedAt}` : ''}`
                            : CONTRIBUTION_HINTS[key] || ''}
                        </div>
                      </div>
                      {kpBusy ? (
                        <Loader2 size={14} className="animate-spin text-[var(--accent)] shrink-0" />
                      ) : (
                        <div className="flex items-center gap-1.5 shrink-0">
                          {st !== 'not-imported' && st !== 'disabled' && (
                            <button
                              onClick={() => window.dispatchEvent(new CustomEvent('knowledge:open'))}
                              className="px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-colors"
                              title="打开知识库模块"
                            >
                              去知识库查看
                            </button>
                          )}
                          <button
                            onClick={() => setKpConfirm({ overwrite: false })}
                            disabled={st === 'disabled'}
                            className="px-3 py-1.5 text-[11px] font-medium text-white bg-[var(--accent)] rounded hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            title={st === 'disabled' ? '启用插件后可导入' : undefined}
                          >
                            {st === 'disabled' ? '已禁用' : st === 'not-imported' ? '导入到知识库' : st === 'update-available' ? '检查更新' : '重新导入'}
                          </button>
                        </div>
                      )}
                    </div>
                    {kpBusy && kpProgress && kpProgress.total > 0 && (
                      <div className="mt-2">
                        <div className="h-1.5 bg-[var(--bg-tertiary)] rounded overflow-hidden">
                          <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${Math.round((kpProgress.current / kpProgress.total) * 100)}%` }} />
                        </div>
                      </div>
                    )}
                  </div>
                )
              }
              return (
                <div key={key} className="flex items-center gap-3 p-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                  <CheckCircle2 size={14} className="text-[var(--accent)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-[var(--text-primary)]">{CONTRIBUTION_LABELS[key] || key}</div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{CONTRIBUTION_HINTS[key] || ''}</div>
                  </div>
                  {importable && (
                    <button
                      onClick={() => key === 'habitPresets' ? importHabitPresets(p) : importBookmarkPresets(p)}
                      disabled={busy || imported}
                      className="shrink-0 px-3 py-1.5 text-[11px] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-colors text-[var(--text-primary)] disabled:opacity-50"
                    >
                      {imported ? '已导入' : '导入'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <SectionTitle>更多信息</SectionTitle>
          <div className="text-[12px] space-y-1.5 text-[var(--text-muted)] mb-8">
            <div className="flex"><span className="w-24 shrink-0">插件 ID</span><span className="font-mono text-[var(--text-secondary)]">{p.id}</span></div>
            <div className="flex"><span className="w-24 shrink-0">安全等级</span><span>{p.riskLevel} · {LEVEL_META[p.riskLevel].label}</span></div>
            <div className="flex"><span className="w-24 shrink-0">类型</span><span>{p.builtin ? '内置(随应用分发)' : p.type === 'ui' ? 'UI 插件(带界面)' : p.type === 'code' ? '代码插件(后台运行)' : '声明式插件(纯内容)'}</span></div>
            <div className="flex"><span className="w-24 shrink-0">状态</span><span className={p.enabled ? 'text-[var(--success)]' : ''}>{p.enabled ? '已启用' : '已禁用'}</span></div>
          </div>

          {/* 最近活动 */}
          <SectionTitle>最近活动</SectionTitle>
          <div className="mb-8">
            {auditRows.length === 0 ? (
              <div className="text-[12px] text-[var(--text-muted)]">暂无记录</div>
            ) : (
              <div className="space-y-1 mb-2">
                {auditRows.map(row => (
                  <div key={row.id} className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] px-2 py-1 rounded hover:bg-[var(--bg-hover)]">
                    <ScrollText size={11} className="shrink-0" />
                    <span className="font-mono shrink-0">{row.createdAt}</span>
                    <span className={`shrink-0 ${row.action === 'deny' ? 'text-[var(--warning)]' : ''}`}>{AUDIT_ACTION_LABELS[row.action] || row.action}</span>
                    <span className="truncate">{(() => { try { const d = JSON.parse(row.detail); return Object.keys(d).length ? JSON.stringify(d) : '' } catch { return '' } })()}</span>
                  </div>
                ))}
              </div>
            )}
            {auditRows.length > 0 && (
              <button
                onClick={async () => { await pluginAuditClear(p.id); setAuditRows([]) }}
                className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-[var(--text-muted)] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-colors"
              >
                <Trash2 size={11} />清空活动记录
              </button>
            )}
          </div>

          {/* 卸载(内置插件不可卸载,仅可禁用) */}
          <div className="mt-4 pt-5 border-t border-[var(--border-color)]">
            {p.builtin ? (
              <p className="text-[11px] text-[var(--text-muted)]">官方内置插件不可卸载，可禁用。</p>
            ) : (
              <>
                <button
                  onClick={() => handleUninstall(p)}
                  disabled={busy}
                  className={`flex items-center gap-1.5 px-3.5 py-2 text-[12px] rounded-md transition-colors ${
                    confirmDeleteId === p.id
                      ? 'text-white bg-[var(--danger)]'
                      : 'text-[var(--danger)] border border-[var(--danger)]/40 hover:bg-[var(--danger)]/10'
                  }`}
                >
                  <AlertTriangle size={12} />
                  {confirmDeleteId === p.id ? '再点一次确认卸载' : '卸载插件'}
                </button>
                <p className="text-[11px] text-[var(--text-muted)] mt-2">
                  {p.riskLevel === 'A' ? '卸载仅删除插件文件，已导入数据保留。' : '卸载将删除插件文件与全部授权。'}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full bg-[var(--bg-primary)]">
      {/* 左侧面板 */}
      <div className="w-[280px] shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] flex flex-col">
        <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
          <PluginIcon size={12} />
          插件
        </div>

        <div className="flex p-2 gap-1 shrink-0">
          {(['installed', 'market'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 px-2 py-0.5 text-[11.5px] rounded-md transition-colors ${
                tab === t ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {t === 'installed' ? `已安装 (${installed.length})` : '市场'}
            </button>
          ))}
        </div>

        <div className="px-2 pb-2 flex gap-1.5 shrink-0">
          <div className="flex-1 flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-md">
            <Search size={12} className="text-[var(--text-disabled)] shrink-0" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={tab === 'installed' ? '搜索已安装插件' : '搜索市场插件'}
              className="flex-1 bg-transparent outline-none text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
            />
          </div>
          {tab === 'market' ? (
            <button onClick={() => loadMarket(true)} disabled={marketLoading} className="p-2 rounded-md border border-[var(--border-color)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors" title="刷新市场">
              <RefreshCw size={12} className={marketLoading ? 'animate-spin' : ''} />
            </button>
          ) : (
            <button onClick={handleInstallFromFile} disabled={busy} className="p-2 rounded-md border border-[var(--border-color)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors" title="从本地 ZIP 安装">
              <FolderOpen size={12} />
            </button>
          )}
        </div>

        {/* C 级白名单（错题本插件版退役后保留通用 C 级开关） */}
        {tab === 'installed' && (
          <div className="px-3 py-1.5 flex flex-col gap-1 text-[10px] text-[var(--text-muted)] border-b border-[var(--border-color)]/60">
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allowedLevels.includes('C')}
                onChange={e => void toggleLevelC(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              允许 C 级模块插件
            </label>
          </div>
        )}

        {/* 分类筛选(市场):外观 / 工具 / 知识包 / 学习 / Skill */}
        {tab === 'market' && (
          <div className="px-2 pb-2 flex flex-wrap gap-1 shrink-0">
            <button
              onClick={() => setCategoryFilter('')}
              className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
                categoryFilter === '' ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-color)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              全部分类
            </button>
            {(['外观', '工具', '知识包', '学习', 'Skill'] as const).map(c => (
              <button
                key={c}
                onClick={() => setCategoryFilter(categoryFilter === c ? '' : c)}
                className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
                  categoryFilter === c ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border-color)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {/* 列表（tab 切换重放进场，见 docs/ui-animation-plan.md A 类） */}
        <div key={tab} className="kb-view-in flex-1 overflow-y-auto">
          {tab === 'installed' ? (
            <div>
              {filteredInstalled.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-[var(--text-muted)]">
                  {q ? '没有匹配的插件' : '暂无插件，可前往市场安装'}
                </div>
              ) : filteredInstalled.map(installedItem)}
            </div>
          ) : marketLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-[var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" />正在获取…
            </div>
          ) : marketError ? (
            <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)] leading-relaxed">
              <AlertTriangle size={16} className="mx-auto mb-2 text-[var(--warning)]" />
              {marketError}
              <div><button onClick={() => loadMarket(true)} className="text-[var(--accent)] hover:underline mt-1">重试</button></div>
            </div>
          ) : filteredMarket.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-[var(--text-muted)]">{q ? '没有匹配的插件' : '插件仓库还没有上架任何插件'}</div>
          ) : filteredMarket.map(marketItem)}
        </div>

        <div className="px-3 py-2 border-t border-[var(--border-color)] shrink-0">
          <span className="text-[10px] text-[var(--text-disabled)]">插件来自 GitHub · Lousync/Phrontis-plugins</span>
        </div>
      </div>

      {/* 右侧详情 */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected && (
          <div className="px-4 py-2 border-b border-[var(--border-color)]">
            <button onClick={() => setSelected(null)} className="flex items-center gap-1 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
              <ArrowLeft size={13} />返回列表
            </button>
          </div>
        )}
        {renderDetail()}
      </div>

      {renderConsent()}

      {/* 内容型插件导入确认(A 级知情授权) */}
      {kpConfirm && selected?.kind === 'installed' && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 kb-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setKpConfirm(null) }}>
          <div className="w-[440px] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--border-color)]">
              <div className="flex items-center gap-2 mb-1">
                <ShieldAlert size={15} className="text-[var(--warning)]" />
                <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                  {kpState?.state === 'not-imported' ? '导入到知识库' : kpState?.state === 'update-available' ? '插件内容更新' : '重新导入'}
                </h3>
              </div>
              <p className="text-[12px] text-[var(--text-muted)]">来源:{selected.plugin.id} v{selected.plugin.version} · 安全等级 <LevelBadge level={selected.plugin.riskLevel} /></p>
            </div>
            <div className="px-5 py-4 space-y-2 text-[12px] text-[var(--text-secondary)] leading-relaxed">
              <p>
                将在知识库中创建空间《<span className="text-[var(--text-primary)] font-medium">{kpNotebook || selected.plugin.name}</span>》
                (含 {kpState?.chapters || 0} 章 · {kpState?.totalPages || 0} 页),并可随插件更新维护这些页面。
              </p>
              {kpState?.state === 'update-available' && (
                <>
                  <p>检测到内容变化:新增 {kpState.newPages || 0} 页,内容变化 {kpState.changedPages || 0} 页。</p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={kpConfirm.overwrite}
                      onChange={e => setKpConfirm({ overwrite: e.target.checked })}
                      className="accent-[var(--accent)]"
                    />
                    强制覆盖我本地已修改的页面(默认跳过)
                  </label>
                </>
              )}
              <p className="text-[11px] text-[var(--text-muted)]">导入全程单事务执行,失败自动回滚;卸载插件后已导入的页面保留。</p>
            </div>
            <div className="px-5 py-3 border-t border-[var(--border-color)] flex justify-end gap-2">
              <button onClick={() => setKpConfirm(null)} className="px-3.5 py-2 text-[12px] text-[var(--text-secondary)] border border-[var(--border-color)] rounded-md hover:bg-[var(--bg-hover)] transition-colors">取消</button>
              <button
                onClick={() => doImportPack(kpConfirm.overwrite)}
                disabled={kpBusy}
                className="px-4 py-2 text-[12px] font-medium text-white bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
              >
                {kpBusy ? <Loader2 size={12} className="animate-spin" /> : '确认导入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 冲突管理面板:导入跳过清单可视化 */}
      {kpConflicts && !kpBusy && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-6" onClick={() => setKpConflicts(null)}>
          <div
            className="w-[520px] max-w-full max-h-[80vh] bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-xl shadow-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 pt-4 pb-3 border-b border-[var(--border-color)]">
              <div className="flex items-center gap-2">
                <AlertTriangle size={15} className="text-[var(--warning)] shrink-0" />
                <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">{kpConflicts.length} 个页面已跳过</h3>
              </div>
              <p className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed">
                这些页面在知识库中被你修改过或读取失败,导入时默认跳过以保护本地内容。勾选需要放弃本地改动、以插件内容覆盖的页面。
              </p>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-2">
              {kpConflicts.map(c => (
                <label key={c.externalId} className="flex items-center gap-2.5 py-1.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={kpForceSel.has(c.externalId)}
                    onChange={() => {
                      const next = new Set(kpForceSel)
                      if (next.has(c.externalId)) next.delete(c.externalId)
                      else next.add(c.externalId)
                      setKpForceSel(next)
                    }}
                    className="accent-[var(--accent)] shrink-0"
                  />
                  <span className="text-[12.5px] text-[var(--text-primary)] truncate flex-1 min-w-0" title={c.title}>{c.title}</span>
                  <span className={`shrink-0 text-[10px] px-1.5 py-px rounded ${c.reason === '本地已修改' ? 'bg-[var(--warning)]/10 text-[var(--warning)]' : 'bg-[var(--danger)]/10 text-[var(--danger)]'}`}>{c.reason}</span>
                </label>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-[var(--border-color)] flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={kpForceSel.size > 0 && kpForceSel.size === kpConflicts.length}
                  onChange={() => setKpForceSel(kpForceSel.size === kpConflicts.length ? new Set() : new Set(kpConflicts.map(c => c.externalId)))}
                  className="accent-[var(--accent)]"
                />
                {kpForceSel.size === kpConflicts.length ? '取消全选' : '全选'}
              </label>
              <div className="flex gap-2">
                <button onClick={() => setKpConflicts(null)} className="px-3.5 py-2 text-[12px] text-[var(--text-secondary)] border border-[var(--border-color)] rounded-md hover:bg-[var(--bg-hover)] transition-colors">保留我的修改</button>
                <button
                  onClick={() => { void overwriteSelected() }}
                  disabled={kpForceSel.size === 0 || kpBusy}
                  className="px-4 py-2 text-[12px] font-medium text-white bg-[var(--warning)] rounded-md hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  覆盖所选({kpForceSel.size})
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] text-[var(--text-muted)] mb-2.5">{children}</h3>
  )
}
