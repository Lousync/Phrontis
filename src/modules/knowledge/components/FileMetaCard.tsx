import { Archive, Eye, FolderSearch, HardDrive, ExternalLink } from 'lucide-react'
import { FileIcon } from '../../../components/shared/FileIcon'
import { FileInfoRows } from '../../../components/shared/FileInfoRows'
import { getFileTypeInfo } from '../../../lib/fileTypes'

/**
 * 归档非 md 文件的元信息卡（docs/vault-archive-all-files-design.md §7，D1 拍板）。
 *
 * 知识库阅读器的非 md 落点：html 走沙箱 iframe、文本类可切「查看内容」（只读），
 * 其余只给元信息。html 分支由 PageEditor / 沉浸阅读分支直接走 WelcomeHtmlView，不经此卡。
 *
 * 2026-09-21 修正（B-3）：原卡上「在编辑器打开」派发 `kb-open-note` → 转发 `kb-open-note-rel`
 * → 知识库 `openByRelPath` 命中**同一条目** → 只 setActivePageId(自己) = **零可见变化**（自环）；
 * 且 `paneDoc` 当时排除 `entryKind === 'file'`，归档文件根本没有内容视图可落。
 * 且编辑区模块退役后「编辑器」已不存在——那是个没有承接方的空承诺。
 * 现改为三件**真实存在**的动作：查看内容（文本类，就地只读）/ 在系统中打开 / 在文件夹中显示。
 */

/**
 * 文件信息行已上移到 `src/components/shared/FileInfoRows.tsx`（批 3，2026-10-13）。
 *
 * 为什么上移：批 3 的图片异常态卡（`src/components/shared/image/ImageStateCard.tsx`）也要用它，
 * 而 shared 反向依赖 module 是层次倒挂。`formatSize` 一并搬走（它原本只服务本行）。
 * ★ 批 1 抽它的那条理由仍然成立且更强了：现在有三个消费者
 * （本卡 / ⋮ 的文件信息弹层 / 图片异常态卡），更要只留一处。
 */

export function FileMetaCard({ title, fileType, path, updatedAt, sizeBytes, viewable = false, onView, onOpenInSystem, onRevealInFolder }: {
  title: string
  fileType: string
  path?: string
  updatedAt?: string
  sizeBytes?: number
  /** 该扩展名可在应用内按文本查看（来源 TEXT_VIEWABLE_EXT_SET）——为真才出现「查看内容」 */
  viewable?: boolean
  /** 查看内容：切到只读文本视图（由 PageEditor 承接） */
  onView?: () => void
  /** 用系统默认程序打开该文件 */
  onOpenInSystem?: () => void
  /** 在系统资源管理器中定位该文件 */
  onRevealInFolder?: () => void
}) {
  const fi = getFileTypeInfo(fileType)
  const hasPath = !!path
  const secondaryBtn = 'flex flex-1 items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11.5px] rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--border-color)] disabled:hover:text-[var(--text-secondary)]'
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

        <FileInfoRows path={path} sizeBytes={sizeBytes} updatedAt={updatedAt} className="mb-5" />

        {/* 主按钮：仅文本类出现（二进制无处可「查看」） */}
        {viewable && (
          <button
            data-wb="metaViewContent"
            onClick={onView}
            disabled={!hasPath}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[12.5px] rounded-lg bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Eye size={13} />
            查看内容
          </button>
        )}

        {/* 兜底动作：对二进制/未知类型也成立 */}
        <div className={`flex items-center gap-2 ${viewable ? 'mt-2' : ''}`}>
          <button
            data-wb="metaOpenInSystem"
            onClick={onOpenInSystem}
            disabled={!hasPath}
            title="用系统默认程序打开"
            className={secondaryBtn}
          >
            <ExternalLink size={12} />
            在系统中打开
          </button>
          <button
            data-wb="metaRevealInFolder"
            onClick={onRevealInFolder}
            disabled={!hasPath}
            title="在资源管理器中定位"
            className={secondaryBtn}
          >
            <FolderSearch size={12} />
            在文件夹中显示
          </button>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)] text-center">
          该文件不是 markdown 知识页，知识库中仅展示元信息
          {viewable ? '；「查看内容」以只读方式打开' : '；可用系统程序打开或定位'}
        </p>
      </div>
    </div>
  )
}
