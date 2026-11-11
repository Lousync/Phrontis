/**
 * 主题明暗判定 —— 代码块色板选亮/暗两套的唯一入口。
 *
 * 为什么不直接用 `html.theme-light` / `theme-daycycle` 类名：
 * 插件主题是运行时注入的 `html.theme-plugin-*`，类名无法枚举；按 `--bg-primary`
 * 的实际亮度判定，任意主题（含以后新增的插件包）都能自动落到正确的代码色板。
 *
 * 阈值与 `editorTheme.ts` 里 Monaco 的判定保持一致（感知亮度 > 140 = 浅色）。
 * 这里独立成零依赖文件：既供渲染层的 applyThemeClass 调用，也能被契约脚本直接 import。
 */

/** 把 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() 解析成 [r, g, b]；无法解析返回 null。 */
export function parseCssRgb(raw: string): [number, number, number] | null {
  const s = String(raw ?? '').trim()
  if (!s) return null

  const hex = /^#([0-9a-f]{3,8})$/i.exec(s)
  if (hex) {
    const h = hex[1]
    if (h.length === 3) {
      return [0, 1, 2].map(i => parseInt(h[i] + h[i], 16)) as [number, number, number]
    }
    if (h.length === 6 || h.length === 8) {
      const n = parseInt(h.slice(0, 6), 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    return null
  }

  const rgb = /^rgba?\((.*)\)$/i.exec(s)
  if (!rgb) return null
  const body = rgb[1].replace(/\//g, ' ')
  const parts = body.split(/[\s,]+/).filter(Boolean)
  if (parts.length < 3) return null
  const channel = (v: string): number | null => {
    const pct = /^([\d.]+)%$/.exec(v)
    if (pct) {
      const n = Number(pct[1])
      return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n * 2.55))) : null
    }
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null
  }
  const r = channel(parts[0])
  const g = channel(parts[1])
  const b = channel(parts[2])
  return r === null || g === null || b === null ? null : [r, g, b]
}

/** 感知亮度判定：与 editorTheme.ts 的 isLightColor 同阈值（> 140 = 浅色）。 */
export function isLightRgb(rgb: [number, number, number]): boolean {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 140
}

/**
 * 主题应用后调用：按 `--bg-primary` 实际亮度给 <html> 挂 `data-code-tone`。
 * 解析失败时退回内置主题类名，保证至少有确定值，不沿用上一个主题的 tone。
 */
export function applyCodeTone(root: HTMLElement): void {
  if (typeof getComputedStyle !== 'function') return
  const raw = getComputedStyle(root).getPropertyValue('--bg-primary').trim()
  const rgb = parseCssRgb(raw)
  const light = rgb
    ? isLightRgb(rgb)
    : /(^|\s)theme-(light|daycycle)\b/.test(root.className)
  root.dataset.codeTone = light ? 'light' : 'dark'
}
