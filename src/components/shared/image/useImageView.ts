/**
 * 图片视图态控制器（批 3，2026-10-13，v3.5.0 线）。
 *
 * 为什么要抽成 hook 而不是把 state 摊在 `PageEditor` 里：图片有**两个宿主** ——
 * 笔记区（控件在顶栏槽里，批 3 拍板 D7）与沉浸阅读（没有顶栏，控件退成浮条）。
 * 两处各持一份 state + 五个回调，必然会漂移（本项目已因「同一份逻辑各写一遍」吃过多次）。
 * 几何算式一律来自 `src/lib/imageView.ts`（纯函数、有契约脚本），本文件只做「接线 + 生命周期」。
 */

import { useCallback, useEffect, useState } from 'react'
import { clampPan, initialImageView, reflow, rotateBy, withFitMode, zoomAbout, type ImageViewState, type ViewBox } from '../../../lib/imageView'

export interface ImageViewController {
  view: ImageViewState
  /** 画布视口尺寸（由 `ImageViewer` 的 ResizeObserver 上报） */
  viewport: ViewBox
  /** ★ 稳定引用：`ImageViewer` 的 ResizeObserver 以它为依赖，每次渲染换身份就会重建 observer */
  onViewport: (box: ViewBox) => void
  zoom: (k: number, anchor?: { x: number; y: number }) => void
  fit: (mode: 'fit' | 'width' | 'actual') => void
  rotate: (delta: number) => void
  pan: (tx: number, ty: number) => void
  /** 双击：适应窗口 ⇄ 100% */
  doubleClick: () => void
  reset: () => void
}

/**
 * @param nat      自然尺寸（`<img>` 解码后的权威值）。null = 还没解码出来，此时所有动作都是空操作
 * @param resetKey 换这个键就复位视图态（传文件路径即可）——缩放/旋转/平移是「这一张图」的状态，
 *                 换到别的图还留着，表象就是「打开新图先看到上一张的缩放比例」
 */
export function useImageView(nat: ViewBox | null, resetKey?: string | null): ImageViewController {
  const [view, setView] = useState<ImageViewState>(() => initialImageView())
  const [viewport, setViewport] = useState<ViewBox>({ w: 0, h: 0 })

  useEffect(() => { setView(initialImageView()) }, [resetKey])

  /** 尺寸变化（窗口缩放 / 左右栏开合 / 沉浸态进出）与解码完成后重算。
   *  仍在适应模式就重算比例；自由态只夹平移，不动比例（不夺用户的手动缩放）。 */
  useEffect(() => {
    if (!nat) return
    setView(v => reflow(v, nat, viewport))
  }, [nat, viewport])

  const onViewport = useCallback((b: ViewBox) => {
    setViewport(prev => (prev.w === b.w && prev.h === b.h ? prev : b))
  }, [])
  const zoom = useCallback((k: number, anchor?: { x: number; y: number }) => {
    setView(v => (nat ? zoomAbout(v, nat, viewport, k, anchor) : v))
  }, [nat, viewport])
  const fit = useCallback((mode: 'fit' | 'width' | 'actual') => {
    setView(v => (nat ? withFitMode(v, nat, viewport, mode) : v))
  }, [nat, viewport])
  const rotate = useCallback((delta: number) => {
    setView(v => (nat ? rotateBy(v, nat, viewport, delta) : v))
  }, [nat, viewport])
  const pan = useCallback((tx: number, ty: number) => {
    setView(v => (nat ? { ...v, ...clampPan({ ...v, tx, ty }, nat, viewport) } : v))
  }, [nat, viewport])
  const doubleClick = useCallback(() => {
    setView(v => (nat ? withFitMode(v, nat, viewport, v.fit === 'fit' ? 'actual' : 'fit') : v))
  }, [nat, viewport])
  const reset = useCallback(() => setView(initialImageView()), [])

  return { view, viewport, onViewport, zoom, fit, rotate, pan, doubleClick, reset }
}
