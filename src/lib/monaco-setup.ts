import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
// Vite 官方 Monaco 配方：显式注册各语言 worker（?worker 语法交给 Vite 打包）。
// 缺这段时 Monaco 每次初始化都 throw「You must define MonacoEnvironment.getWorker」，
// dev 下主线程回退链断裂 → 编辑器挂不起来（表现为点开文件后不能编辑）。
// monaco 0.56 起 package.json 新增 exports（"./*" → "./esm/vs/*"），旧深路径
// `monaco-editor/esm/vs/...` 不再命中任何子路径（V-1 白屏根因），改用新约定导入。
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json': return new JsonWorker()
      case 'css': case 'scss': case 'less': return new CssWorker()
      case 'html': case 'handlebars': case 'razor': return new HtmlWorker()
      case 'typescript': case 'javascript': return new TsWorker()
      default: return new EditorWorker()
    }
  },
}

// Electron 环境下必须从本地 node_modules 加载，禁用 CDN
loader.config({ monaco })

// 探针/诊断入口：把 monaco 实例挂到 window（同一模块实例的引用，零成本、无副作用）。
// 为什么必须挂：CDP 的 Input.insertText / dispatchKeyEvent / execCommand 三条路在
// Electron 沙箱下都进不了 Monaco 的 ime-text-area（2026-09-19 实测三种全失败、且不报错），
// 探针要模拟"用户打字"只能直接驱动 model —— 而 monaco 实例在 React 组件内部，不挂出来拿不到。
;(window as unknown as Record<string, unknown>).__kb_monaco = monaco

function hexLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const n = parseInt(m[1], 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : fallback
}

let lastPluginKey = ''

/**
 * 应用主题 → Monaco 主题名。
 * 内置主题映射官方基色;插件主题读取当前生效的 CSS 变量动态生成配色,
 * 保证 MD/代码编辑区与周围界面同色系。
 */
export function monacoThemeFor(themeId: string): string {
  if (themeId === 'light') return 'vs'
  if (themeId === 'dark') return 'vs-dark'
  try {
    const bg = cssVar('--bg-primary', '#1e1e1e')
    const fg = cssVar('--text-primary', '#cccccc')
    const accent = cssVar('--accent', '#4a9eff')
    const border = cssVar('--border-color', '#3c3c3c')
    const muted = cssVar('--text-muted', '#6e7681')
    const key = `${themeId}|${bg}|${fg}|${accent}`
    if (key !== lastPluginKey) {
      monaco.editor.defineTheme('knowbase-plugin', {
        base: hexLuminance(bg) > 0.5 ? 'vs' : 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': bg,
          'editor.foreground': fg,
          'editorLineNumber.foreground': muted,
          'editorLineNumber.activeForeground': fg,
          'editor.selectionBackground': accent + '55',
          'editor.lineHighlightBackground': border + '40',
          'editorCursor.foreground': accent,
          'editorIndentGuide.background': border + '80',
          'editorWidget.background': bg,
          'editorWidget.border': border,
        },
      })
      lastPluginKey = key
    }
    return 'knowbase-plugin'
  } catch {
    return 'vs-dark'
  }
}
