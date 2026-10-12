/**
 * 图片态快捷键（批 3，2026-10-13，v3.5.0 线）。
 *
 * 抽出来是因为有两个宿主（笔记区 / 沉浸阅读），键位表只能有一份 ——
 * 两处各写一遍，改键位时必然漏一处（表象是「沉浸态按 0 没反应」）。
 *
 * ★ 只用**无修饰键**四个：`0` 适应窗口 / `1` 实际大小 / `[` 向左旋转 / `]` 向右旋转。
 *   刻意不占 `Ctrl+=` / `Ctrl+-` / `Ctrl+0` / `Ctrl+1` —— 那是应用级 UI 缩放的地盘，
 *   抢过来代价远大于收益（见 docs/image-viewer-design.md §9）。
 *   缩放走 `Ctrl+滚轮`（在 `ImageViewer` 里用原生监听实现，React 的 onWheel 是 passive 的）。
 */

import { useEffect } from 'react'
import { isEditingInput } from '../../../lib/shortcuts'

export function useImageViewKeys(
  enabled: boolean,
  fit: (mode: 'fit' | 'width' | 'actual') => void,
  rotate: (delta: number) => void,
): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // 正在输入框 / 可编辑区里打字时不要抢键（`[` `]` 是常见输入字符）
      if (isEditingInput(e)) return
      switch (e.key) {
        case '0': e.preventDefault(); fit('fit'); break
        case '1': e.preventDefault(); fit('actual'); break
        case '[': e.preventDefault(); rotate(-90); break
        case ']': e.preventDefault(); rotate(90); break
        default: break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, fit, rotate])
}
