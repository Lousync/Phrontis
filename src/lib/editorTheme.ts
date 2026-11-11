import type * as Monaco from 'monaco-editor'
import { isLightRgb, parseCssRgb } from './themeTone'

/**
 * 编辑器主题桥 —— 让 Monaco 跟随应用主题（含插件主题）。
 *
 * 背景：Monaco 有独立的配色体系（defineTheme），不吃 CSS 变量；此前 PageEditor / MarkdownEditor
 * 用 `s.theme === 'light' ? 'vs' : 'vs-dark'` 硬编码，任何插件主题下编辑器都强制深色，
 * 与周围界面配色割裂。
 *
 * 方案：从 computed style 读取应用 CSS 变量，动态合成 knowbase-auto 主题；
 * 监听 html.class 变化（切换主题 = 换类名）实时重定义，所有已挂载编辑器即时刷新。
 */

let monacoRef: typeof Monaco | null = null
let observerInstalled = false
/** 上次合成主题签名：颜色与变体都没变就不 define/setTheme——setTheme 是全局广播，
 *  html class 的无关变化（非主题类）反复广播会放大 monaco dispose 竞态的残留错误（V-7） */
let lastThemeSig = ''

/** css 颜色 → Monaco 接受的 #rrggbb / #rrggbbaa；无法解析返回 null */
function toHex(raw: string): string | null {
  const s = raw.trim()
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return s
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).split('').map(c => c + c).join('')
  const m = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (m) {
    const parts = m[1].split(',').map(x => parseFloat(x.trim()))
    if (parts.length >= 3 && parts.slice(0, 3).every(n => Number.isFinite(n))) {
      const [r, g, b] = parts.map(n => Math.max(0, Math.min(255, Math.round(n))))
      const hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')
      if (parts.length >= 4 && Number.isFinite(parts[3])) {
        const a = Math.round(Math.max(0, Math.min(1, parts[3])) * 255)
        return `#${hex}${a.toString(16).padStart(2, '0')}`
      }
      return `#${hex}`
    }
  }
  return null
}

/** 相对亮度判断明暗基座（与代码块色板共用同一阈值，见 themeTone.ts） */
function isLightColor(hex: string): boolean {
  const rgb = parseCssRgb(hex)
  return rgb ? isLightRgb(rgb) : false
}

export function applyEditorTheme(): void {
  if (!monacoRef) return
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => toHex(cs.getPropertyValue(name)) ?? fallback

  const bg = v('--bg-primary', '#1e1e1e')
  const bgSecondary = v('--bg-secondary', '#252526')
  const fg = v('--text-primary', '#cccccc')
  const muted = v('--text-muted', '#8a8a8a')
  const border = v('--border-color', '#333333')
  const accent = v('--accent', '#007acc')
  const selected = v('--bg-selected', '#094771')
  const light = isLightColor(bg)

  const colors: Record<string, string> = {
    'editor.background': bg,
    'editor.foreground': fg,
    'editorGutter.background': bg,
    'editorLineNumber.foreground': muted,
    'editorLineNumber.activeForeground': fg,
    'editor.lineHighlightBackground': bgSecondary,
    'editor.selectionBackground': selected,
    'editorIndentGuide.background1': border,
    'editorIndentGuide.activeBackground1': muted,
    'editorWidget.background': bgSecondary,
    'editorWidget.border': border,
    'editorSuggestWidget.background': bgSecondary,
    'editorSuggestWidget.border': border,
    'editorSuggestWidget.selectedBackground': selected,
    'scrollbarSlider.background': `${border}80`,
    'scrollbarSlider.hoverBackground': `${muted}80`,
    'editorBracketMatch.border': accent,
  }

  // 纸感氛围色跟随「实际主题明暗」（按 --bg-primary 亮度判定，任意主题 id 均正确，
  // 不依赖 theme-light 类名）。容器 .zen-paper-bg 消费该变量，CSS 过渡出入场
  document.documentElement.style.setProperty('--zen-paper', light ? '#f6f1e7' : '#211d18')

  // 幂等闸：签名（颜色+变体）未变则跳过 define/setTheme，避免无关 class 变化触发全局广播
  const sig = JSON.stringify({ light, colors, themeVariant })
  if (sig === lastThemeSig) return
  lastThemeSig = sig

  monacoRef.editor.defineTheme('knowbase-auto', {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors,
  })

  // 禅模式纸感变体（XMind ZEN 式氛围）：编辑器底色全透明 → 露出容器 .zen-paper-bg
  // 的暖纸白/墨夜色（CSS 300ms 过渡入出场），行高亮用纸色加深一档
  monacoRef.editor.defineTheme('knowbase-zen', {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      ...colors,
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      'editor.lineHighlightBackground': light ? '#efe7d6' : '#2a241d',
    },
  })

  monacoRef.editor.setTheme(themeVariant === 'zen' ? 'knowbase-zen' : 'knowbase-auto')
}

/** 当前主题变体：auto=常规（不透明底），zen=禅纸感（透明底，容器承载纸色） */
let themeVariant: 'auto' | 'zen' = 'auto'

/** 切换主题变体（禅模式纸感氛围）。同值幂等；切换即时生效（含已挂载编辑器） */
export function setEditorThemeVariant(v: 'auto' | 'zen'): void {
  if (themeVariant === v) return
  themeVariant = v
  applyEditorTheme()
}

/** Monaco 实例就绪后调用（beforeMount）；重复调用安全 */
export function bindEditorTheme(monaco: typeof Monaco): void {
  monacoRef = monaco
  applyEditorTheme()
  if (!observerInstalled && typeof MutationObserver !== 'undefined') {
    observerInstalled = true
    new MutationObserver(applyEditorTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
  }
}
