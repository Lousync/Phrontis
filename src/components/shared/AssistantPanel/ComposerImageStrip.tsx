import type { ComposerImage } from '../../../lib/useComposerImages'

/**
 * 输入区上方的图片胶囊（P2 多模态）：统一助手与 AI 教学共用。
 * 只负责展示与移除；粘贴 / 拖入 / 选文件在 `useComposerImages`。
 */
export function ComposerImageStrip({ images, onRemove, disabled = false }: {
  images: ComposerImage[]
  onRemove: (id: string) => void
  disabled?: boolean
}) {
  if (images.length === 0) return null
  return (
    <div data-wb="composerImages" className="kb-item-in mb-1.5 flex flex-wrap gap-1.5">
      {images.map((im) => (
        <div key={im.id} className="group/img relative h-[58px] w-[58px] overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <img src={im.dataUrl} alt={im.name || '待发送图片'} className="h-full w-full object-cover" />
          {!disabled && (
            <button
              type="button"
              onClick={() => onRemove(im.id)}
              title="移除图片" aria-label="移除图片"
              className="absolute right-1 top-1 grid h-[18px] w-[18px] place-items-center rounded-full bg-black/65 text-[12px] leading-none text-white opacity-0 transition-opacity hover:bg-[var(--danger)] group-hover/img:opacity-100"
            >×</button>
          )}
        </div>
      ))}
    </div>
  )
}
