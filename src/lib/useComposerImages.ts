import { useCallback, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type RefObject } from 'react'
import { showToast } from './toast'
import type { AgentImageInput } from '../types'

/**
 * 对话图片输入（P2 多模态）共用逻辑：粘贴 / 拖入 / 选文件 → 压缩 → data URL。
 *
 * 统一助手与 AI 教学共用同一份，避免两边压缩参数、数量上限、提示文案漂移。
 * 输出只含 data URL（不落盘）：发送时随 agentChat 交给主进程写进
 * `.knowbase/agent/images/<sessionId>/`，之后消息行只保留相对路径。
 */

export const MAX_COMPOSER_IMAGES = 4
export const MAX_IMAGE_DIMENSION = 2048
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export interface ComposerImage extends AgentImageInput {
  id: string
}

function extOfMime(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  return 'jpg'
}

function bytesOfDataUrl(dataUrl: string): number {
  const i = dataUrl.indexOf(',')
  if (i < 0) return 0
  const b64 = dataUrl.slice(i + 1)
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)
}

async function loadBitmap(file: File): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(file)
    return {
      width: bmp.width,
      height: bmp.height,
      draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h),
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('图片解码失败'))
      el.src = url
    })
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<string> {
  return canvas.toDataURL('image/jpeg', quality)
}

/** 单文件 → 压缩后的 data URL（最长边 ≤2048，JPEG；仍超 2MB 再降质量） */
async function fileToComposerImage(file: File): Promise<ComposerImage> {
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) throw new Error('只支持 PNG / JPEG / WebP 图片')
  const bmp = await loadBitmap(file)
  if (!bmp.width || !bmp.height) throw new Error('图片尺寸非法')
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('图片处理失败')
  bmp.draw(ctx, w, h)
  let dataUrl = await encodeJpeg(canvas, 0.82)
  let bytes = bytesOfDataUrl(dataUrl)
  for (const q of [0.65, 0.5]) {
    if (bytes <= MAX_IMAGE_BYTES) break
    dataUrl = await encodeJpeg(canvas, q)
    bytes = bytesOfDataUrl(dataUrl)
  }
  if (bytes > MAX_IMAGE_BYTES) throw new Error('图片压缩后仍超过 2MB，请换一张更小的图')
  const mime = dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : `image/${extOfMime(file.type)}`
  return {
    id: crypto.randomUUID(),
    name: file.name || '粘贴的图片',
    mime,
    dataUrl,
    w,
    h,
    bytes,
  }
}

export interface ComposerImagesApi {
  images: ComposerImage[]
  /** 追加文件（自动压缩；超过上限 / 非图片给出 toast） */
  addFiles: (files: File[] | FileList) => Promise<void>
  removeImage: (id: string) => void
  clearImages: () => void
  /** 图片区是否处于拖入高亮态 */
  dragging: boolean
  openPicker: () => void
  fileInputRef: RefObject<HTMLInputElement | null>
  onFileInputChange: (e: ChangeEvent<HTMLInputElement>) => void
  onPaste: (e: ClipboardEvent) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  /** 当前是否可以发送图片（有图 + 模型已由调用方校验） */
  hasImages: boolean
}

export function useComposerImages(): ComposerImagesApi {
  const [images, setImages] = useState<ComposerImage[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepth = useRef(0)

  const addFiles = useCallback(async (files: File[] | FileList) => {
    const list = Array.from(files).filter((f) => f && f.type.startsWith('image/'))
    if (list.length === 0) return
    const remain = Math.max(0, MAX_COMPOSER_IMAGES - images.length)
    if (remain === 0) {
      showToast({ type: 'info', message: `每条消息最多 ${MAX_COMPOSER_IMAGES} 张图片` })
      return
    }
    const picked = list.slice(0, remain)
    if (list.length > remain) showToast({ type: 'info', message: `每条消息最多 ${MAX_COMPOSER_IMAGES} 张图片，已取前 ${remain} 张` })
    const results: ComposerImage[] = []
    for (const f of picked) {
      try {
        results.push(await fileToComposerImage(f))
      } catch (e) {
        showToast({ type: 'error', message: (e as Error).message })
      }
    }
    if (results.length > 0) setImages((prev) => [...prev, ...results].slice(0, MAX_COMPOSER_IMAGES))
  }, [images.length])

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((im) => im.id !== id))
  }, [])

  const clearImages = useCallback(() => setImages([]), [])

  const openPicker = useCallback(() => {
    if (images.length >= MAX_COMPOSER_IMAGES) {
      showToast({ type: 'info', message: `每条消息最多 ${MAX_COMPOSER_IMAGES} 张图片` })
      return
    }
    fileInputRef.current?.click()
  }, [images.length])

  const onFileInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) void addFiles(files)
    e.target.value = '' // 允许连续选同一张
  }, [addFiles])

  const onPaste = useCallback((e: ClipboardEvent) => {
    const files = e.clipboardData?.files
    if (!files || files.length === 0) return
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (imgs.length === 0) return
    e.preventDefault()
    void addFiles(imgs)
  }, [addFiles])

  const onDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback((e: DragEvent) => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void addFiles(files)
  }, [addFiles])

  // 进入拖入态：统一在 dragOver 里计数（dragenter 与 dragleave 成对，避免子元素闪烁）
  const onDragOverWithEnter = useCallback((e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    if (!dragging) { dragDepth.current = 1; setDragging(true) }
    onDragOver(e)
  }, [dragging, onDragOver])

  return {
    images,
    addFiles,
    removeImage,
    clearImages,
    dragging,
    openPicker,
    fileInputRef,
    onFileInputChange,
    onPaste,
    onDragOver: onDragOverWithEnter,
    onDragLeave,
    onDrop,
    hasImages: images.length > 0,
  }
}
