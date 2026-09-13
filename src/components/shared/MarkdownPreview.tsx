import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Copy } from 'lucide-react'
import { showToast } from '../../lib/toast'
import { copyImageUrlToClipboard, workspaceGetCurrent, workspaceReadImage } from '../../lib/ipc'
import { preprocessContent, parseQuizFence, parseQuizFenceLoose } from './QuizParser'
import { QuizCard } from './QuizCard'
import { PluginFenceRenderer } from './PluginFenceRenderer'
import { pluginListRenderers } from '../../lib/ipc'
import type { PluginRendererInfo } from '../../types'
import { normalizeAnswerLayout } from '../../lib/answerLayout'

// Same ID generation as parseHeadings() in OutlinePanel — must match for outline navigation
function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Allow the app's local schemes (attachment://, data:, file:, blob:) alongside
 * react-markdown's default safe protocols. The default urlTransform would strip
 * `attachment://id/` to an empty string, breaking inline images.
 */
function safeUrlTransform(value: string): string {
  if (/^(https?|ircs?|mailto|xmpp|attachment|data|file|blob):/i.test(value)) return value
  const colon = value.indexOf(':')
  const questionMark = value.indexOf('?')
  const numberSign = value.indexOf('#')
  const slash = value.indexOf('/')
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign)
  ) return value
  return ''
}

interface Props {
  content: string
  /** Called when a [[wiki link]] is clicked. If omitted, wiki links render as plain text. */
  onWikiLink?: (title: string) => void
  /** Called when a standard markdown link [text](href) is clicked. Default: open in browser/system. */
  onLinkClick?: (href: string) => void
  /** 已存在的页面标题集合：不在其中的 wiki 链接渲染为「空链接」虚线样式 */
  knownWikiTitles?: Set<string>
  /** 草稿页标题集合（status: draft = 修改中）：命中渲染半透明「虚化」样式（非正式可点） */
  draftWikiTitles?: Set<string>
  /** 来源页面 ID（传入后，页面内选择题启用收藏 + 错题上报） */
  pageId?: string
  /** 来源页面标题（用于错题本快照） */
  pageTitle?: string
  /** quiz 围栏解析失败重试（v3.1.1 条目13）：传入后失败占位卡显示「让 AI 重出新题」按钮 */
  onQuizRetry?: () => void
}

/** Unified markdown preview component. Links open via system handler (files → system app, URLs → browser). */
/** 折叠块(kb-import-408.md 2.2 节):```spoiler-answer 围栏 → 答案/解析默认收起,内部走完整 Markdown 管线 */
function SpoilerBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  // 大题解析排版优化：小问编号（1、/ (1) / 1) 等）自动断行，每个小问单独一行
  const layoutContent = useMemo(() => normalizeAnswerLayout(content), [content])
  return (
    <div className="my-2.5">
      <button
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border text-[11px] transition-colors select-none ${
          open
            ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10'
            : 'border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]'
        }`}
      >
        {open ? '收起答案 ▴' : '显示答案 ▸'}
      </button>
      {open && (
        <div className="mt-1.5 px-3 py-2 rounded-md border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <MarkdownPreview content={layoutContent} />
        </div>
      )}
    </div>
  )
}

/** remark/rehype 插件链：提为模块级常量。原先每次渲染新建数组，react-markdown 会视为新配置 */
const REMARK_PLUGINS: any = [remarkGfm, remarkMath]
const REHYPE_PLUGINS: any = [rehypeHighlight, [rehypeKatex, { throwOnError: false, strict: false }]]
type MdComponents = NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>

/** 插件围栏渲染（带回退）：加载失败 / 3 秒未就绪 → 回退普通代码块 */
function FenceWithFallback({ info, code, pageId, pageTitle, children }: {
  info: PluginRendererInfo
  code: string
  pageId?: string
  pageTitle?: string
  children: React.ReactNode
}) {
  const [failed, setFailed] = useState(false)
  if (failed) return <pre>{children}</pre>
  return (
    <PluginFenceRenderer
      pluginId={info.pluginId}
      entry={info.entry}
      height={info.height}
      code={code}
      pageId={pageId}
      pageTitle={pageTitle}
      onFailed={() => setFailed(true)}
    />
  )
}

/** quiz 围栏解析失败占位卡（条目13）：不再裸显原始 JSON，可一键让 AI 重出 */
function QuizFailCard({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="my-2.5 px-3 py-2.5 rounded-lg border border-dashed border-[var(--warning)]/40 bg-[var(--bg-secondary)] flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
      <span className="min-w-0 flex-1">题目数据解析失败（AI 输出的 JSON 格式有误，已隐藏原始内容）</span>
      {onRetry && (
        <button onClick={onRetry}
          className="shrink-0 px-2 py-0.5 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
          让 AI 重出新题
        </button>
      )}
    </div>
  )
}

function MarkdownPreviewInner({ content, onWikiLink, onLinkClick, knownWikiTitles, draftWikiTitles, pageId, pageTitle, onQuizRetry }: Props) {
  // 旧 408 选择题格式 → ```quiz 围栏（供 pre 组件渲染判题卡片）；非选择题块原样保留
  const processedContent = useMemo(() => preprocessContent(content), [content])

  // 插件 fenced-code 渲染器（plugin-phase1-design C6）：lang → 渲染器映射（挂载时拉一次）
  const [fenceRenderers, setFenceRenderers] = useState<Map<string, PluginRendererInfo>>(new Map())
  useEffect(() => {
    let alive = true
    pluginListRenderers().then(list => {
      if (!alive) return
      const m = new Map<string, PluginRendererInfo>()
      for (const r of list ?? []) m.set(r.lang, r)
      setFenceRenderers(m)
    }).catch(() => null)
    return () => { alive = false }
  }, [])

  const handleLinkClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault()
    if (onLinkClick) {
      onLinkClick(href)
    } else {
      // Default: use window.open → intercepted by Electron's setWindowOpenHandler
      if (/^https?:\/\//i.test(href) || /^file:\/\//i.test(href)) {
        window.open(href, '_blank')
      } else {
        // Relative/absolute file path → open with system app
        if (window.api) {
          window.api.openExternal(href)
        }
      }
    }
  }, [onLinkClick])

  // components 稳定化：依赖未变即复用同一对象。正文变化时若该对象被重建，React 会因
  // 「组件类型变了」卸载重建整棵节点树；保持引用稳定可让 React 只 patch 真正变化的节点。
  const components = useMemo<MdComponents>(() => ({
    // 折叠块/动画/选择题围栏不包 <pre>
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children
      const cls = (React.isValidElement(child) && ((child.props as { className?: string }).className || '')) || ''
      if (/language-(spoiler|anim)/.test(cls)) return <>{children}</>
      // ```quiz 围栏（新规范或旧格式预处理产物）→ 判题卡片；宽容修复仍失败 → 占位卡（条目13，不再裸显 JSON）
      if (/language-(quiz|json)/.test(cls)) {
        const src = extractText(children)
        const quiz = parseQuizFence(src)
        if (quiz) return <QuizCard quiz={quiz} pageId={pageId} pageTitle={pageTitle} />
        if (/language-quiz/.test(cls)) {
          const fixed = parseQuizFenceLoose(src)
          if (fixed) return <QuizCard quiz={fixed} pageId={pageId} pageTitle={pageTitle} />
          return <QuizFailCard onRetry={onQuizRetry} />
        }
      }
      // 插件渲染器（plugin-phase1-design C6）：命中 lang 且插件已启用 → 内容只读沙箱；失败回退普通代码块
      const langMatch = cls.match(/language-([a-z0-9-]+)/i)
      const fenceLang = langMatch?.[1]?.toLowerCase()
      if (fenceLang) {
        const r = fenceRenderers.get(fenceLang)
        if (r) {
          return <FenceWithFallback info={r} code={extractText(children)} pageId={pageId} pageTitle={pageTitle}>{children}</FenceWithFallback>
        }
      }
      return <pre>{children}</pre>
    },
    // Override ul/ol to restore list-style killed by Tailwind reset
    ul({ children }) {
      return <ul className="list-disc pl-6 my-1.5">{children}</ul>
    },
    ol({ children }) {
      return <ol className="list-decimal pl-6 my-1.5">{children}</ol>
    },
    // Custom link handler — intercept all <a> clicks to avoid Electron navigation blocks
    a({ href, children, ...props }) {
      return (
        <a
          href={href}
          {...props}
          className="text-[var(--accent)] hover:underline cursor-pointer"
          onClick={e => href ? handleLinkClick(e, href) : undefined}
        >
          {children}
        </a>
      )
    },
    // Images: add a hover "copy to clipboard" affordance
    img({ src, alt, ...props }) {
      // P3/D1：仓库根相对附件链接（.attachments/…，含旧 _attachments 形态）→ 经主进程白名单取 data:URI
      const vaultRel = typeof src === 'string' ? normalizeVaultRel(src) : null
      if (vaultRel) return <VaultRelImg rel={vaultRel} alt={alt} {...props} />
      // 包内容缺陷降级：源 md 把图引用写死成 `图片资源缺失:undefined` 等占位（408 包 5 处，
      // 见 docs/verification-issues-20260904.md ISS-2026-09-04-03）→ 不渲染破图，改为显式占位
      if (typeof src === 'string' && /图片资源缺失|undefined|null/i.test(src)) {
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 my-1 rounded border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-muted)]">
            <span>📷</span>
            <span>图片缺失{alt ? `：${alt}` : ''}</span>
          </span>
        )
      }
      return (
        <span className="inline-block relative max-w-full align-bottom group/img">
          <img src={src} alt={alt} {...props} />
          {src && (
            <button
              onClick={() => {
                void copyImageUrlToClipboard(src).then(ok => {
                  showToast({ type: ok ? 'info' : 'error', message: ok ? '图片已复制到剪贴板' : '复制失败' })
                })
              }}
              className="absolute top-1.5 right-1.5 p-1 rounded bg-black/55 text-white opacity-0 group-hover/img:opacity-100 hover:bg-black/80 transition-opacity"
              title="复制图片"
            >
              <Copy size={14} />
            </button>
          )}
        </span>
      )
    },
    code({ className, children, node, ...props }) {
      // 内容包折叠块 fence:spoiler-answer → 答案/解析默认收起(内部递归完整管线)
      if (/(?:^|\s)language-spoiler/.test(className || '')) {
        return <SpoilerBlock content={String(children).replace(/\n$/, '')} />
      }
      // 内容包动画 fence:anim@<pluginId>:<blockId> → 沙箱 iframe 播放器
      // (rehype-highlight 会在 className 前加 "hljs ",故不用锚定匹配)
      const anim = /language-anim@([a-z0-9][a-z0-9._-]*):([A-Za-z0-9._-]+)/.exec(className || '')
      if (anim) return <AnimEmbed pluginId={anim[1]} animId={anim[2]} label={String(children).trim().split('\n')[0]} />
      const match = /language-(\w+)/.exec(className || '')
      const lang = match ? match[1] : ''
      const isBlock = node?.tagName === 'code' && className?.includes('language-')
      if (!isBlock) {
        return <code className={className} {...props}>{children}</code>
      }
      return (
        <div className="relative group">
          {lang && (
            <span className="absolute top-1 right-2 text-[10px] text-[var(--text-muted)] opacity-40 select-none">
              {lang}
            </span>
          )}
          <code className={className} {...props}>{children}</code>
        </div>
      )
    },
    // Convert [[wiki links]] + 脚注（word^[标注]） in paragraph text to interactive spans
    p({ children }) {
      return <p>{renderInlineExtras(children, onWikiLink, knownWikiTitles, draftWikiTitles)}</p>
    },
    // Also handle wiki links in list items, headings, etc.
    li({ children }) {
      return <li>{renderInlineExtras(children, onWikiLink, knownWikiTitles, draftWikiTitles)}</li>
    },
    h1({ children }) {
      const text = extractText(children)
      return <h1 id={headingId(text)}>{renderInlineExtras(children, onWikiLink, knownWikiTitles, draftWikiTitles)}</h1>
    },
    h2({ children }) {
      const text = extractText(children)
      return <h2 id={headingId(text)}>{renderInlineExtras(children, onWikiLink, knownWikiTitles, draftWikiTitles)}</h2>
    },
    h3({ children }) {
      const text = extractText(children)
      return <h3 id={headingId(text)}>{renderInlineExtras(children, onWikiLink, knownWikiTitles, draftWikiTitles)}</h3>
    },
    h4({ children }) {
      const text = extractText(children)
      return <h4 id={headingId(text)}>{renderInlineExtras(children, onWikiLink, knownWikiTitles, draftWikiTitles)}</h4>
    },
    h5({ children }) {
      const text = extractText(children)
      return <h5 id={headingId(text)}>{renderInlineExtras(children, onWikiLink, knownWikiTitles, draftWikiTitles)}</h5>
    },
    h6({ children }) {
      const text = extractText(children)
      return <h6 id={headingId(text)}>{renderInlineExtras(children, onWikiLink, knownWikiTitles, draftWikiTitles)}</h6>
    },
  }), [handleLinkClick, onWikiLink, knownWikiTitles, draftWikiTitles, pageId, pageTitle, fenceRenderers, onQuizRetry])

  return (
    <div className="prose-content">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={safeUrlTransform}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  )
}

/** memo 包装：props 引用未变时跳过整个重渲染（连带跳过 react-markdown 的解析与节点重建） */
export const MarkdownPreview = React.memo(MarkdownPreviewInner)

const WIKI_RE = /\[\[([^\]]+)\]\]/

// ===== P3：仓库根相对路径图片解析（D1 附件区 .attachments/，兼容旧 .knowbase/_attachments/ 与根 _attachments/）=====
// md 中形如 `![x](.attachments/2026-09/x.png)` 的链接对渲染进程不可直接取回（无文件系统 http 服务），
// 统一经 ws:readImage（主进程附件白名单 + resolveSafe 越界防护）解析为 data:URI，进程内缓存。
const vaultRelImgCache = new Map<string, string>()
let vaultRelRootIdPromise: Promise<string | null> | null = null

function normalizeVaultRel(src: string): string | null {
  let s = src
  try { s = decodeURIComponent(s) } catch { /* 含 % 的原始名按字面处理 */ }
  for (let guard = 0; guard < 10; guard++) {
    if (s.startsWith('../')) { s = s.slice(3); continue }
    if (s.startsWith('./')) { s = s.slice(2); continue }
    break
  }
  if (/^\.attachments\//i.test(s) || /^\.knowbase\/_attachments\//i.test(s) || /^_attachments\//i.test(s)) return s
  return null
}

function VaultRelImg({ rel, alt, ...props }: { rel: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const cached = vaultRelImgCache.get(rel) ?? null
  const [dataUrl, setDataUrl] = useState<string | null>(cached)
  useEffect(() => {
    if (dataUrl) return
    let alive = true
    void (async () => {
      try {
        if (!vaultRelRootIdPromise) vaultRelRootIdPromise = workspaceGetCurrent().then((cur) => cur?.rootId ?? null)
        const rootId = await vaultRelRootIdPromise
        if (!rootId) return
        const res = await workspaceReadImage(rootId, rel)
        if (res.dataUrl && alive) {
          vaultRelImgCache.set(rel, res.dataUrl)
          setDataUrl(res.dataUrl)
        }
      } catch { /* 取回失败保持原生渲染（破图可见，不崩预览） */ }
    })()
    return () => { alive = false }
  }, [rel, dataUrl])
  if (!dataUrl) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-1 my-1 rounded border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-muted)]">
        <span>🖼️</span><span>图片加载中…</span>
      </span>
    )
  }
  return <img src={dataUrl} alt={alt} {...props} />
}

/** Extract plain text from React children for heading ID generation */
function extractText(children: React.ReactNode): string {
  return React.Children.toArray(children).map(c => {
    if (typeof c === 'string') return c
    if (typeof c === 'number') return String(c)
    if (React.isValidElement(c)) return extractText((c.props as any)?.children)
    return ''
  }).join('')
}

/** Recursively scan React children for `[[wiki links]]` in text nodes and replace them with clickable spans. */
// ===== 脚注：`word^[标注]`（Pandoc 风格行内脚注）=====
// 阅读时点击带虚线下划线的词展开自己的标注；语法在编辑器用「脚注」按钮或手写生成

const FOOTNOTE_RE = /([\w一-鿿''-]+)\^\[([^\]]+)\]/

/** 单个脚注词：虚线下划线 + 上标「注」，点击弹出标注气泡 */
function FootnoteWord({ word, note }: { word: string; note: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <span ref={ref} className="relative inline-block">
      <span
        className="border-b border-dashed border-[var(--accent)] cursor-help hover:bg-[var(--accent)]/10 transition-colors"
        title="点击查看脚注"
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
      >
        {word}
        <sup className="ml-0.5 text-[9px] text-[var(--accent)]">注</sup>
      </span>
      {open && (
        <span
          className="absolute left-0 top-full z-40 mt-1.5 w-72 max-w-[80vw] block px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl text-[12px] leading-relaxed text-[var(--text-primary)] whitespace-normal text-left"
          onClick={e => e.stopPropagation()}
        >
          <span className="block text-[10px] text-[var(--text-disabled)] mb-0.5">脚注 · {word}</span>
          {note}
        </span>
      )}
    </span>
  )
}

/** 在文本节点中扫描 `word^[标注]` 并替换为脚注组件 */
function renderFootnotes(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, child => {
    if (typeof child === 'string') {
      if (!child.includes('^[')) return child
      const parts: React.ReactNode[] = []
      let remaining = child
      let key = 0
      while (remaining.length > 0) {
        const m = FOOTNOTE_RE.exec(remaining)
        if (!m) { parts.push(remaining); break }
        if (m.index > 0) parts.push(remaining.slice(0, m.index))
        parts.push(<FootnoteWord key={key++} word={m[1]} note={m[2]} />)
        remaining = remaining.slice(m.index + m[0].length)
      }
      return <>{parts}</>
    }
    if (React.isValidElement(child) && (child.props as any)?.children) {
      return React.cloneElement(child, {
        ...(child.props as any),
        children: renderFootnotes((child.props as any).children),
      } as any)
    }
    return child
  })
}

/** 行内扩展统一入口：先脚注，后双链（脚注词不被双链二次处理） */
function renderInlineExtras(children: React.ReactNode, onWikiLink?: (title: string) => void, knownWikiTitles?: Set<string>, draftWikiTitles?: Set<string>): React.ReactNode {
  return renderWikiLinks(renderFootnotes(children), onWikiLink, knownWikiTitles, draftWikiTitles)
}

function renderWikiLinks(children: React.ReactNode, onWikiLink?: (title: string) => void, knownWikiTitles?: Set<string>, draftWikiTitles?: Set<string>): React.ReactNode {
  if (!onWikiLink) return children
  return React.Children.map(children, child => {
    if (typeof child === 'string') {
      const parts: React.ReactNode[] = []
      let remaining = child
      let key = 0
      while (remaining.length > 0) {
        const match = WIKI_RE.exec(remaining)
        if (!match) {
          parts.push(remaining)
          break
        }
        // Text before the match
        if (match.index > 0) {
          parts.push(remaining.slice(0, match.index))
        }
        // The wiki link
        const display = match[1].split('|')[0].trim()
        const exists = knownWikiTitles ? knownWikiTitles.has(display) : true
        const isDraft = !exists && draftWikiTitles ? draftWikiTitles.has(display) : false
        parts.push(
          <span
            key={key++}
            className={
              isDraft
                ? 'text-[var(--accent)]/55 cursor-pointer border-b border-dotted border-[var(--accent)]/45'
                : exists
                  ? 'text-[var(--accent)] cursor-pointer hover:underline'
                  : 'text-[var(--text-muted)]/70 cursor-pointer hover:text-[var(--accent)] border-b border-dashed border-[var(--text-muted)]/50'
            }
            title={isDraft ? `「${display}」为草稿（修改中），归档后方可阅读` : exists ? display : `创建页面「${display}」`}
            onClick={() => onWikiLink(display)}
          >
            {display}
          </span>
        )
        remaining = remaining.slice(match.index + match[0].length)
      }
      return <>{parts}</>
    }
    if (React.isValidElement(child) && (child.props as any)?.children) {
      return React.cloneElement(child, {
        ...(child.props as any),
        children: renderWikiLinks((child.props as any).children, onWikiLink, knownWikiTitles, draftWikiTitles),
      } as any)
    }
    return child
  })
}

/** 内容包分步动画播放器(plugin:// 沙箱 iframe,manim-web 单运行时) */
function AnimEmbed({ pluginId, animId, label }: { pluginId: string; animId: string; label: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className="my-3 px-3 py-2.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-muted)]">
        【交互式动画】{label || animId}(播放器加载失败,插件可能已被卸载)
      </div>
    )
  }
  return (
    <figure className="my-3">
      <iframe
        src={`plugin://${pluginId}/anims/player.html?id=${encodeURIComponent(animId)}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        title={label || animId}
        onError={() => setFailed(true)}
        style={{ width: '100%', aspectRatio: '16 / 10', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-card)', background: '#fff' }}
      />
      <figcaption className="text-[11px] text-[var(--text-muted)] mt-1 text-center select-none">
        分步动画{label ? ` · ${label}` : ''}(使用下方控件逐步播放)
      </figcaption>
    </figure>
  )
}
