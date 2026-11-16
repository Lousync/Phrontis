import { useEffect, useState } from 'react'
import { loadVaultImage } from '../../../lib/attachmentImage'
import type { AgentImageRef } from '../../../types'

/** 单张消息图片：乐观消息用 dataUrl 直出；落库消息按仓库相对路径读回（走既有图片通道/缓存） */
function ChatImageThumb({ image }: { image: AgentImageRef }) {
  const [url, setUrl] = useState<string | null>(image.dataUrl ?? null)
  useEffect(() => {
    if (image.dataUrl) { setUrl(image.dataUrl); return }
    let alive = true
    if (image.relPath) {
      void loadVaultImage(image.relPath).then((u) => { if (alive) setUrl(u) })
    }
    return () => { alive = false }
  }, [image.dataUrl, image.relPath])
  return url
    ? <img src={url} alt={image.name || '图片'} title={image.name || undefined} data-wb="chatImageThumb"
        className="h-[72px] w-[72px] rounded-lg border border-[var(--border-color)] object-cover" />
    : <div data-wb="chatImageThumb" className="h-[72px] w-[72px] animate-pulse rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]" />
}

/** 用户消息里的图片缩略图（P2 多模态）：统一助手与 AI 教学共用 */
export function ChatImageThumbs({ images, right = true }: { images?: AgentImageRef[]; right?: boolean }) {
  if (!images || images.length === 0) return null
  return (
    <div className={`mb-1 flex flex-wrap gap-1.5 ${right ? 'justify-end' : ''}`}>
      {images.map((im, i) => <ChatImageThumb key={`${im.relPath || 'tmp'}-${i}`} image={im} />)}
    </div>
  )
}
