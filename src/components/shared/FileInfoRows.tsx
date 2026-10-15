/**
 * 文件信息行（路径 / 尺寸 / 修改时间）—— 批 1 从元信息卡里抽出，批 3 上移到 shared。
 *
 * 为什么上移：批 3 的 `ImageStateCard`（`src/components/shared/image/`）也要用它，
 * 而它原先住在 `src/modules/knowledge/components/FileMetaCard.tsx` ——
 * shared 反向依赖 module 是层次倒挂（shared 是给各模块用的，不该认识任何一个模块）。
 *
 * 为什么只有这一份：批 1 抽它的理由就是「元信息卡与 ⋮ 弹层两处各写一份必然漂移」。
 * 现在有三个消费者（元信息卡 / ⋮ 文件信息弹层 / 图片异常态卡），更要只留一处。
 *
 * `formatSize` 保持模块私有：外部要展示尺寸一律走本组件，不另抄一份换算。
 */

import { Archive, HardDrive } from 'lucide-react'

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function FileInfoRows({ path, sizeBytes, updatedAt, className = '' }: {
  path?: string
  sizeBytes?: number
  updatedAt?: string
  className?: string
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
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
  )
}
