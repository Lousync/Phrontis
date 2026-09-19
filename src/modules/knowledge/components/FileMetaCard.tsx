import { Archive, ExternalLink, HardDrive } from 'lucide-react'
import { FileIcon } from '../../../components/shared/FileIcon'
import { getFileTypeInfo } from '../../../lib/fileTypes'
import { showToast } from '../../../lib/toast'

/**
 * 归档非 md 文件的元信息卡（docs/vault-archive-all-files-design.md §7，D1 拍板）。
 *
 * 知识库阅读器的非 md 落点：不渲染内容（html 走沙箱 iframe，其余只给元信息），
 * 提供「在编辑器打开」跳转（kb-open-note 闭环已有）。html 分支由 PageEditor /
 * 沉浸阅读分支直接走 WelcomeHtmlView，不经此卡。
 */

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function FileMetaCard({ title, fileType, path, updatedAt, sizeBytes }: {
  title: string
  fileType: string
  path?: string
  updatedAt?: string
  sizeBytes?: number
}) {
  const fi = getFileTypeInfo(fileType)
  const openInEditor = () => {
    if (!path) {
      showToast({ type: 'warning', message: '该条目没有关联的仓库文件' })
      return
    }
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: path, from: 'knowledge' } }))
  }
  return (
    <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
      <div className="w-full max-w-[380px] rounded-xl border border-[var(--border-color)] bg-[var(--card-bg, var(--bg-secondary))] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: fi.color + '20' }}>
            <FileIcon ext={fileType} size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-[var(--text-primary)] truncate" title={title}>{title}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              {fi.badge && (
                <span className="text-[9px] px-1.5 py-px rounded font-medium"
                  style={{ backgroundColor: fi.color + '20', color: fi.color }}>
                  {fi.badge}
                </span>
              )}
              <span className="text-[11px] text-[var(--text-muted)] uppercase">{fileType || 'file'}</span>
            </div>
          </div>
        </div>

        <div className="space-y-1.5 mb-5">
          {path && (
            <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)] min-w-0">
              <Archive size={12} className="shrink-0 text-[var(--text-muted)]" />
              <span className="truncate" title={path}>{path}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
            <HardDrive size={12} className="shrink-0 text-[var(--text-muted)]" />
            <span>{formatSize(sizeBytes)}</span>
            {updatedAt && <span className="text-[var(--text-muted)]">· 修改于 {new Date(updatedAt).toLocaleString()}</span>}
          </div>
        </div>

        <button
          onClick={openInEditor}
          disabled={!path}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[12.5px] rounded-lg bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ExternalLink size={13} />
          在编辑器打开
        </button>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)] text-center">
          该文件不是 markdown 知识页，知识库中仅展示元信息{fileType === 'html' ? '' : '；内容请到编辑器查看'}
        </p>
      </div>
    </div>
  )
}
