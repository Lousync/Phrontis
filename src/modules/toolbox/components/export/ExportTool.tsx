import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Upload, FileText, Database, Check, Settings, History, FileArchive, XCircle, Loader2, Shield, Sparkles, CalendarCheck2, Globe, ArrowLeft } from 'lucide-react'
import { SETTINGS_DEFAULTS } from '../../../../lib/settings'
import type { ToolSidebarProps } from '../../../../components/workbench/toolRegistry'
import { ProgressPanel } from './ProgressPanel'

// ---- types ----
interface ModuleOption {
  id: 'blog' | 'schedule' | 'knowledge' | 'passwordVault' | 'moments' | 'checkin' | 'bookmarkNav'
  label: string
  icon: React.ReactNode
  count: string
}

interface ExportRecord {
  date: string
  modules: string
  format: string
  success: boolean
}

const MODULES: ModuleOption[] = [
  { id: 'blog', label: '博客', icon: <FileText size={16} />, count: '文章 + 标签' },
  { id: 'schedule', label: '日程', icon: <Database size={16} />, count: '待办 + 四象限' },
  { id: 'knowledge', label: '知识库', icon: <FileArchive size={16} />, count: '页面 + 分类 + 链接' },
  { id: 'passwordVault', label: '密码本', icon: <Shield size={16} />, count: '加密密码条目' },
  { id: 'moments', label: '说说', icon: <Sparkles size={16} />, count: '本地时间线 + 置顶' },
  { id: 'checkin', label: '打卡', icon: <CalendarCheck2 size={16} />, count: '习惯 + 打卡记录' },
  { id: 'bookmarkNav', label: '网址导航', icon: <Globe size={16} />, count: '分类 + 书签' },
]

const FORMAT_LABEL = '备份包（含附件）'

type ExportStatus = 'idle' | 'loading' | 'success' | 'error'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

interface ExportResult {
  cancelled: boolean
  filePath?: string | null
  fileCount?: number
  totalSize?: number
}

// R6 去库化收尾：按模块的 JSON+附件备份包导出（export:backupToZip）已随 sql.js
// 基础设施退役。数据已随仓库文件夹（.knowbase/）保存，全量备份请使用
// 设置 → 数据与仓库 的「导出整仓备份（zip）」（vaultBackup:exportToZip）。
// 通道与入口暂保留，执行时返回弃用提示，避免渲染层崩。
async function runBackupExport(_moduleIds: string[]): Promise<ExportResult> {
  throw new Error('已弃用：数据已随仓库文件夹保存（.knowbase/），按模块备份包导出不再支持。请使用 设置 → 数据与仓库 的「导出整仓备份（zip）」')
}

export function ExportTool({ onBack, sidebarEl, sidebarHosted }: { onBack: () => void } & ToolSidebarProps) {
  const [selectedModules, setSelectedModules] = useState<Set<string>>(new Set(['blog', 'schedule', 'knowledge', 'moments']))
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [history, setHistory] = useState<ExportRecord[]>([])

  const allChecked = selectedModules.size === MODULES.length

  const toggleAll = () => {
    if (allChecked) setSelectedModules(new Set())
    else setSelectedModules(new Set(MODULES.map(m => m.id)))
  }

  const toggleModule = (id: string) => {
    setSelectedModules(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const handleExport = useCallback(async () => {
    if (selectedModules.size === 0 || status === 'loading') return
    setStatus('loading')
    setStatusMessage('正在打包数据与附件...')
    try {
      const result = await runBackupExport([...selectedModules])
      if (result.cancelled) {
        setStatus('idle')
        setStatusMessage('')
        return
      }

      const sizeText = result.totalSize != null ? formatFileSize(result.totalSize) : ''
      const countText = result.fileCount != null && result.fileCount > 1 ? `${result.fileCount} 个文件` : ''
      const detail = [countText, sizeText].filter(Boolean).join('，')

      setStatus('success')
      setStatusMessage(`导出成功${detail ? `（${detail}）` : ''}：${(result.filePath || '').slice(-40)}`)

      const moduleLabel = selectedModules.size === MODULES.length
        ? '全部模块'
        : MODULES.filter(m => selectedModules.has(m.id)).map(m => m.label).join('+')
      setHistory(prev => [{
        date: new Date().toISOString().slice(0, 10),
        modules: moduleLabel,
        format: FORMAT_LABEL,
        success: true
      }, ...prev.slice(0, 9)])

      setTimeout(() => { setStatus('idle'); setStatusMessage('') }, SETTINGS_DEFAULTS.exportStatusClearMs)
    } catch (e: unknown) {
      setStatus('error')
      setStatusMessage(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [selectedModules, status])

  const statusIcon = status === 'loading' ? <Loader2 size={16} className="animate-spin" />
    : status === 'success' ? <Check size={16} />
    : status === 'error' ? <XCircle size={16} />
    : null

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          title="返回"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-[11.5px] font-medium text-[var(--text-muted)]">数据导出</span>
      </div>
      <div className="flex flex-1 min-h-0">
      {/* Left: Config panel。2026-09-17 右栏优化轮：标签页语境 sidebarEl 非空时 portal 进
          工作台左栏模块态 slot（挂载点迁移，状态留在本组件）；槽未就绪渲染 null 等槽。 */}
      {(() => {
        const sidebarInner = (
          <>
        <div className="px-4 py-3 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <Settings size={14} />
            <span className="font-semibold uppercase tracking-wide">导出配置</span>
          </div>
        </div>

        {/* Module checkboxes */}
        <div className="px-3 py-3 border-b border-[var(--border-color)]">
          <label className="flex items-center gap-2 py-1 text-[12px] cursor-pointer text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} className="accent-[var(--accent)]" />
            全选
          </label>
          <div className="my-1 border-t border-[var(--bg-tertiary)]" />
          {MODULES.map(m => (
            <label key={m.id} className="flex items-center gap-2 py-1.5 text-[12px] cursor-pointer text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              <input type="checkbox" checked={selectedModules.has(m.id)} onChange={() => toggleModule(m.id)} className="accent-[var(--accent)]" />
              <span className="text-[var(--text-secondary)]">{m.icon}</span>
              <div className="flex flex-col">
                <span className="text-[var(--text-primary)] text-[13px]">{m.label}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{m.count}</span>
              </div>
            </label>
          ))}
        </div>
          </>
        )
        return sidebarEl
          ? createPortal(<div className="flex h-full w-full min-h-0 flex-col overflow-y-auto bg-[var(--bg-secondary)]">{sidebarInner}</div>, sidebarEl)
          : sidebarHosted
            ? null
            : <div className="w-56 shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] flex flex-col overflow-y-auto">{sidebarInner}</div>
      })()}

      {/* Right: Content area */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-y-auto">
          {status === 'loading' ? (
            <div className="h-full flex flex-col items-center justify-center gap-6 px-8">
              <ProgressPanel progress={null} format="backup" />
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-6 px-8">
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 w-full max-w-sm">
                <div className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-3">导出预览</div>
                <div className="space-y-2 text-[13px]">
                  <div className="flex justify-between">
                    <span className="text-[var(--text-secondary)]">选中模块</span>
                    <span className="text-[var(--text-primary)] text-right max-w-[60%]">
                      {selectedModules.size === MODULES.length
                        ? '全部模块'
                        : MODULES.filter(m => selectedModules.has(m.id)).map(m => m.label).join('、') || '未选择'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Export button + status (sticky footer area) */}
        <div className="flex flex-col items-center gap-3 py-4 px-8 border-t border-[var(--border-color)]">
          <button
            disabled={selectedModules.size === 0 || status === 'loading'}
            onClick={handleExport}
            className="flex items-center gap-2 px-8 py-3 bg-[var(--accent)] text-white text-[14px] font-medium rounded-lg hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {status === 'loading' ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
            {status === 'loading' ? '导出中...' : '执行导出'}
          </button>

          {statusMessage && (
            <div className={`flex items-center gap-2 text-[12px] px-3 py-1.5 rounded border ${
              status === 'success' ? 'text-[var(--success)] bg-[var(--success)]/10 border-[var(--success)]/30'
              : status === 'error' ? 'text-[var(--danger)] bg-[var(--danger)]/10 border-[var(--danger)]/30'
              : 'text-[var(--accent)] bg-[var(--accent)]/10 border-[var(--accent)]/30'
            }`}>
              {statusIcon}
              <span className="truncate max-w-[300px]">{statusMessage}</span>
            </div>
          )}
        </div>

        {/* History footer */}
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-6 py-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
            <History size={13} />
            导出历史
          </div>
          {history.length === 0 ? (
            <p className="text-[11px] text-[var(--text-disabled)] py-2">暂无导出记录</p>
          ) : (
            <div className="space-y-0.5">
              {history.map((h, i) => (
                <div key={i} className="flex items-center justify-between text-[12px] py-1">
                  <div className="flex items-center gap-2">
                    <Check size={12} className={h.success ? 'text-[var(--success)]' : 'text-[var(--danger)]'} />
                    <span className="text-[var(--text-primary)]">{h.modules}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[var(--text-muted)]">
                    <span>{h.format}</span>
                    <span>{h.date}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
