import { useCallback, useEffect, useState, type Ref } from 'react'
import type { ShareCardData, ShareCardStyle, ShareCardTexts } from '../../types'
import { CARD_H, CARD_SCALE, CARD_W, type SlotKey } from './shareCardStyles'
import { renderShareCard } from './renderShareCard'
import { renderRichTextImage, type RichTextImage } from './shareCardRichText'

interface Props {
  data: ShareCardData
  texts: ShareCardTexts
  style: ShareCardStyle
  theme: 'light' | 'dark'
  /** 题目区内容（Markdown 行内语法 + LaTeX）；空则不画该块 */
  prompt: string
  /** 显示宽度（CSS px）；高宽比恒为 540:960 */
  width: number
  /** 正在编辑（输入层显示文字）的槽位：本层跳过绘制，避免双重显示 */
  hideSlots?: readonly SlotKey[]
  /** 需要导出能力时传入（复制图片 / 另存 PNG） */
  canvasRef?: Ref<HTMLCanvasElement>
  className?: string
}

/**
 * 分享卡片的 canvas 宿主（2026-09-29）。
 *
 * 固定 1080×1920 物理像素，按 `width` 等比缩到 CSS 尺寸显示 —— 右栏小图与编辑浮层大图
 * 用的是**同一个组件、同一份绘制**，所以两处绝不可能长得不一样。
 * 二维码与题目区（LaTeX）都是**异步排版成图**后再重绘一次：首次绘制先出托板/空白，
 * 不留洞也不阻塞。
 */
export function ShareCardCanvas({ data, texts, style, theme, prompt, width, hideSlots, canvasRef, className }: Props) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [qr, setQr] = useState<HTMLImageElement | null>(null)
  const [promptImg, setPromptImg] = useState<RichTextImage | null>(null)

  const setRef = useCallback((el: HTMLCanvasElement | null) => {
    setCanvas(el)
    if (typeof canvasRef === 'function') canvasRef(el)
    else if (canvasRef && typeof canvasRef === 'object') {
      (canvasRef as { current: HTMLCanvasElement | null }).current = el
    }
  }, [canvasRef])

  useEffect(() => {
    let alive = true
    if (!data.qrDataUrl) { setQr(null); return }
    const img = new Image()
    img.onload = () => { if (alive) setQr(img) }
    img.onerror = () => { if (alive) setQr(null) }
    img.src = data.qrDataUrl
    return () => { alive = false }
  }, [data.qrDataUrl])

  // 题目区：异步排版成图（KaTeX + 字体内联，见 shareCardRichText 头注）
  useEffect(() => {
    let alive = true
    if (!prompt.trim()) { setPromptImg(null); return }
    void renderRichTextImage(prompt, theme, style, { scale: CARD_SCALE })
      .then((r) => { if (alive) setPromptImg(r) })
      .catch(() => { if (alive) setPromptImg(null) })
    return () => { alive = false }
  }, [prompt, theme, style])

  useEffect(() => {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    renderShareCard(
      ctx,
      { data, texts, style, theme, prompt },
      { hideSlots, qr, promptImage: promptImg?.img ?? null, promptSize: promptImg ? { w: promptImg.w, h: promptImg.h } : null },
    )
  }, [canvas, data, texts, style, theme, prompt, hideSlots, qr, promptImg])

  return (
    <canvas
      ref={setRef}
      width={CARD_W * CARD_SCALE}
      height={CARD_H * CARD_SCALE}
      style={{ width, height: (width * CARD_H) / CARD_W }}
      className={className}
    />
  )
}

