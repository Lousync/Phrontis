import { Focus } from 'lucide-react'
import { SIDEBAR_HEADER_ICON } from './sidebarHeaderIcon'

/**
 * 目录聚焦开关（编辑器文件树 / 知识库侧栏共用）。
 * 开启后树只显示「当前打开项所在目录链 + 同级项」，其余骨架化/隐藏（样式见 folderFocusStyle 设置）。
 * 开关状态走 settings（editorFolderFocus / knowledgeFolderFocus），重启保留。
 */
export function FolderFocusButton({ on, onToggle, className = '', size = SIDEBAR_HEADER_ICON.size }: {
  on: boolean
  onToggle: () => void
  className?: string
  size?: number
}) {
  return (
    <button
      onClick={onToggle}
      title={on ? '目录聚焦：已开启（点击关闭）' : '目录聚焦：只显示当前打开项所在目录链'}
      aria-pressed={on}
      className={`p-1 rounded-md transition-colors shrink-0 ${className} ${
        on
          ? 'bg-[var(--accent)]/30 text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      }`}
    >
      <Focus size={size} strokeWidth={SIDEBAR_HEADER_ICON.strokeWidth} />
    </button>
  )
}
