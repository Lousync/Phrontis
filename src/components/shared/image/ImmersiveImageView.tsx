/**
 * 沉浸阅读态的图片视图（批 3，2026-10-13，v3.5.0 线）。
 *
 * 为什么要一个独立组件、而不是在 `KnowledgeModule` 里再摊一份 state：
 * 沉浸态**没有顶栏**（批 2 的 `pdfImmersive` 就是把顶栏藏掉），所以控件只能退成浮条
 * —— 而浮条长在图片视图**自己的子树里**，没有「往祖先的槽里塞东西」那个问题。
 * 于是这里可以自带状态，模块侧只留一行 JSX。
 *
 * 视图态与快捷键仍走两个共用 hook（`useImageView` / `useImageViewKeys`），
 * 与笔记区**同一份**逻辑 —— 两处各写一遍必然会漂移（改键位时漏一处，表象是「沉浸态按 0 没反应」）。
 */

import { useEffect, useMemo, useState } from 'react'
import { ImageViewer } from './ImageViewer'
import { ImageToolbar } from './ImageToolbar'
import { ImageStateCard } from './ImageStateCard'
import { useVaultImage } from './useVaultImage'
import { useImageView } from './useImageView'
import { useImageViewKeys } from './useImageViewKeys'
import { imageMayHaveAlpha } from '../../../lib/imageFormats'
import { workspaceGetCurrent } from '../../../lib/ipc'
import type { ViewBox } from '../../../lib/imageView'

interface Props {
  /** 不传则自己解析当前仓库（与 `attachmentImage.ts` 同一条 `workspaceGetCurrent` 口径）。
   *  这样模块侧只留一行 JSX，不必为「沉浸态要看图」专门加一个 vaultRootId state。 */
  rootId?: string | null
  relPath: string
  name: string
  sizeBytes?: number
  updatedAt?: string
  onOpenInSystem?: () => void
  onRevealInFolder?: () => void
}

export function ImmersiveImageView({ rootId, relPath, name, sizeBytes, updatedAt, onOpenInSystem, onRevealInFolder }: Props) {
  const [root, setRoot] = useState<string | null>(rootId ?? null)
  useEffect(() => {
    if (rootId) { setRoot(rootId); return }
    let alive = true
    void workspaceGetCurrent()
      .then(c => { if (alive) setRoot(c?.rootId ?? null) })
      .catch(() => { /* 解析失败即停在 idle，卡片会显示读取中 */ })
    return () => { alive = false }
  }, [rootId])

  const img = useVaultImage(root, relPath)
  const natW = img.dims?.w ?? 0
  const natH = img.dims?.h ?? 0
  const nat = useMemo<ViewBox | null>(() => (natW > 0 && natH > 0 ? { w: natW, h: natH } : null), [natW, natH])
  const ready = img.status === 'ready' && !!img.url && !!nat
  const iv = useImageView(nat, relPath)
  useImageViewKeys(ready, iv.fit, iv.rotate)

  if (ready) {
    return (
      <div className="relative flex flex-1 min-h-0 min-w-0 flex-col">
        <ImageViewer
          url={img.url}
          nat={nat}
          view={iv.view}
          checker={imageMayHaveAlpha(relPath.split('.').pop() || '')}
          onViewport={iv.onViewport}
          onPan={iv.pan}
          onZoom={iv.zoom}
          onDoubleClick={iv.doubleClick}
          onDecoded={img.onDecoded}
          onDecodeError={img.onDecodeError}
        />
        <ImageToolbar
          variant="float"
          scale={iv.view.scale}
          fit={iv.view.fit}
          rot={iv.view.rot}
          onZoom={iv.zoom}
          onFit={iv.fit}
          onRotate={iv.rotate}
        />
      </div>
    )
  }

  return (
    <ImageStateCard
      kind={img.status === 'toobig' ? 'toobig' : img.status === 'broken' ? 'broken' : 'loading'}
      name={name}
      path={relPath}
      sizeBytes={img.sizeBytes || sizeBytes}
      updatedAt={updatedAt}
      dims={img.dims}
      limit={img.limit}
      error={img.error}
      onOpenInSystem={onOpenInSystem}
      onRevealInFolder={onRevealInFolder}
      onRetry={img.reload}
    />
  )
}
