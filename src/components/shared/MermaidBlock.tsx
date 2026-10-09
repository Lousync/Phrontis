import { useEffect, useRef, useState } from 'react'

/**
 * Mermaid 代码块渲染（思维导图导出笔记的 ` ```mermaid ` 块等）。
 * - **动态 import**：mermaid 体积大，Vite 自动切独立 chunk，不进首屏静态闭包（铁律 20）。
 * - **安全**：`securityLevel:'strict'`（禁用 HTML 标签 / 点击回调），产物是受净化 SVG。
 * - **回退**：加载失败 / 渲染超时 → 原样显示代码块（对标 FenceWithFallback）。
 * - **主题**：跟随应用主题（`html.theme-light` = 浅色），并监听 class 变化重渲染。
 */

let mermaidPromise: Promise<unknown> | null = null
function loadMermaid(): Promise<unknown> {
  if (!mermaidPromise) mermaidPromise = import('mermaid')
  return mermaidPromise
}

function isLight(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('theme-light')
}

let seq = 0

export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState('')
  const [failed, setFailed] = useState(false)
  const [light, setLight] = useState(isLight())
  const idRef = useRef('kb-mermaid-' + (seq++))

  // 主题跟随：html class 变化（theme-* 翻转）即重渲染
  useEffect(() => {
    const mo = new MutationObserver(() => setLight(isLight()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    setFailed(false)
    const timer = setTimeout(() => { if (alive) setFailed(true) }, 8000)
    void (async () => {
      try {
        const mod = (await loadMermaid()) as { default?: unknown }
        const mermaid = (mod.default ?? mod) as {
          initialize: (o: unknown) => void
          render: (id: string, text: string) => Promise<{ svg: string }>
        }
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: light ? 'default' : 'dark',
          fontFamily: 'inherit',
        })
        const { svg: out } = await mermaid.render(idRef.current, code)
        if (alive) { clearTimeout(timer); setSvg(out) }
      } catch {
        if (alive) { clearTimeout(timer); setFailed(true) }
      }
    })()
    return () => { alive = false; clearTimeout(timer) }
  }, [code, light])

  if (failed || !svg) {
    return (
      <pre className="my-2 overflow-x-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
        <code>{code}</code>
      </pre>
    )
  }
  return (
    <div
      className="kb-art-in my-2 flex justify-center overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
