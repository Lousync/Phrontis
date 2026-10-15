/**
 * 图片落点的三种非正常态（批 3，2026-10-13，v3.5.0 线）：读取中 / 过大 / 解码失败。
 *
 * 为什么要独立成组件而不是在 `PageEditor` 里写三段 JSX：
 *  ① 三种态共用同一套几何与动作出口（在系统中打开 / 在文件夹中显示），写三遍必漂移；
 *  ② 「过大」卡要**说清是哪一条上限超了** —— 字节超和像素超是完全不同的两件事
 *     （前者是「文件太大」，后者是「压缩后很小但解码要几个 GB」），
 *     一句笼统的「图片过大」会让用户以为换个格式就能绕过；
 *  ③ 尺寸换算只有一处真相（`src/components/shared/FileInfoRows.tsx`，批 3 从元信息卡上移到
 *     shared —— shared 反向依赖 module 是层次倒挂），本组件复用它，不另抄一份 `formatSize`。
 */

import { AlertTriangle, ExternalLink, FolderSearch, ImageOff, Loader2 } from 'lucide-react'
import { FileInfoRows } from '../FileInfoRows'
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, type ImageDims } from '../../../lib/imageFormats'
import type { VaultImageLimit } from './useVaultImage'

interface Props {
  kind: 'loading' | 'toobig' | 'broken'
  /** 文件名（卡片标题） */
  name: string
  path?: string
  sizeBytes?: number
  updatedAt?: string
  dims?: ImageDims | null
  limit?: VaultImageLimit
  error?: string
  onOpenInSystem?: () => void
  onRevealInFolder?: () => void
  onRetry?: () => void
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const mp = (px: number): string => `${Math.round(px / 1e6)} 百万像素`

export function ImageStateCard({
  kind, name, path, sizeBytes, updatedAt, dims, limit, error, onOpenInSystem, onRevealInFolder, onRetry,
}: Props) {
  const secondaryBtn = 'flex flex-1 items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11.5px] rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]'

  if (kind === 'loading') {
    return (
      <div data-wb="imgStateCard" data-kind="loading" className="flex-1 flex items-center justify-center gap-3 p-6 text-[var(--text-muted)]">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-[12px]">正在读取图片{sizeBytes ? ` · ${mb(sizeBytes)}` : ''}…</span>
      </div>
    )
  }

  /** 「过大」的成因说明 —— 两条上限是**独立**的命门，必须说清是哪一条 */
  const bigWhy = limit?.kind === 'pixels'
    ? `像素数超过上限：${dims ? `${dims.w} × ${dims.h}（${mp(dims.w * dims.h)}）` : '未知尺寸'}，上限 ${mp(MAX_IMAGE_PIXELS)}。
       这一条不是字节上限的补充 —— 压缩后只有几 MB 的图，解码成位图可能占几 GB 内存。`
    : `文件大小超过上限：${mb(sizeBytes ?? 0)}，上限 ${mb(limit?.limitBytes ?? MAX_IMAGE_BYTES)}。`

  return (
    <div data-wb="imgStateCard" data-kind={kind} className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
      <div className="w-full max-w-[400px] rounded-xl border border-[var(--border-color)] bg-[var(--card-bg, var(--bg-secondary))] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-lg flex items-center justify-center shrink-0 bg-[var(--bg-tertiary)]">
            {kind === 'toobig'
              ? <AlertTriangle size={20} className="text-[var(--warning)]" />
              : <ImageOff size={20} className="text-[var(--text-muted)]" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-[var(--text-primary)] truncate" title={name}>{name}</div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
              {kind === 'toobig' ? '图片过大，未在应用内打开' : '图片无法显示'}
            </div>
          </div>
        </div>

        <FileInfoRows path={path} sizeBytes={sizeBytes} updatedAt={updatedAt} className="mb-4" />

        <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)] mb-4">
          {kind === 'toobig' ? bigWhy : (error || '图像数据无法解码。')}
        </p>

        <div className="flex items-center gap-2">
          {kind === 'broken' && onRetry && (
            <button data-wb="imgStateRetry" onClick={onRetry} className={secondaryBtn}>重新读取</button>
          )}
          {onOpenInSystem && (
            <button data-wb="imgStateOpenSys" onClick={onOpenInSystem} title="用系统默认程序打开" className={secondaryBtn}>
              <ExternalLink size={12} />在系统中打开
            </button>
          )}
          {onRevealInFolder && (
            <button data-wb="imgStateReveal" onClick={onRevealInFolder} title="在资源管理器中定位" className={secondaryBtn}>
              <FolderSearch size={12} />在文件夹中显示
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
