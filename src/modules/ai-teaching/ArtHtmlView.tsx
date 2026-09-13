import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, WheelEvent as ReactWheelEvent } from 'react'
import { workspaceGetCurrent, workspaceReadFile } from '../../lib/ipc'
import { collectThemeVars } from './htmlShell'

/**
 * 工件栏 HTML 页签（docs/ai-teaching-artifacts-pane-design.md §4.2-§4.4，2026-09-09 实修裁决）：
 * 载体 = 主进程 kbview://vault/<rel> 协议（electron/lib/kbVisualProtocol.ts）——
 * srcdoc 子框架会**继承父文档 CSP**（index.html `script-src 'self'`），示意图内联脚本与宿主量高脚本全被拦；
 * blob: 又被 sandbox（无 allow-same-origin → opaque）拒载。跨 scheme 正常导航两者都绕开，且响应头 CSP 由主进程统一裁决。
 * 主题/高度/错误壳：协议注入量高与主题监听脚本，宿主经 postMessage 下发 CSS 变量（图随明暗主题即时走）。
 * fit（工件栏 ⤢ 放大态）：fit-to-window 缩放循环——沙箱上报 {内容高 h, 横溢 sw>vw?}，
 * 宿主对 iframe 施加 CSS zoom（矢量/文字无损放大），步进逼近「高度撑满且横向不溢出」；非 fit 时 k=1、iframe=内容高+居中。
 * 安全红线不变：sandbox="allow-scripts" 绝不加 allow-same-origin。
 *
 * 布局（2026-09-09 三修后的四修）：wrap = relative h-full 直接子用 absolute inset-0，
 * iframe 始终填满分栏高度，不再依赖 iframe-container 自适应；沙箱内 body{min-height:100% !important}
 * + flex 垂直居中让图矮于画布时居中、高于画布时正常滚动；警告条 absolute 叠在顶部，不挤压 iframe 高度。
 */
export function ArtHtmlView({ relPath, reloadSeq, fit = false, manualZoom = null, onManualZoom, onEffectiveZoom }: {
  relPath: string
  reloadSeq: number
  fit?: boolean
  /** 手动缩放（v3.1.1 条目11）：null = 跟随 fit 自动铺满；数值 = 用户手动值覆盖 fit（0.5..6） */
  manualZoom?: number | null
  onManualZoom?: (z: number | null) => void
  /** 有效缩放上报（fit 变化/容器尺寸变化都会带动），工具条百分比展示用 */
  onEffectiveZoom?: (z: number) => void
}) {
  const [doc, setDoc] = useState<{ content: string; mtimeMs: number } | null>(null)
  const [readErr, setReadErr] = useState('')
  const [frameErr, setFrameErr] = useState('')
  const [showSrc, setShowSrc] = useState(false)
  const [box, setBox] = useState<{ h: number; sw: number; vw: number } | null>(null)
  const [themeTick, setThemeTick] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState({ w: 0, h: 0 })

  // 明暗主题切换 → 向沙箱内壳重发 CSS 变量（§4.4，不重挂 iframe）
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick(t => t + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    return () => mo.disconnect()
  }, [])

  // 可用空间（fit 判定基准）：跟随栏宽拖拽 / 放大收缩 / 窗口 resize
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAvail({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setAvail({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [fit, relPath, !!doc]) // doc 加载前 wrap 未渲染（早退分支），加载后需补挂观测

  useEffect(() => {
    let alive = true
    setReadErr('')
    void (async () => {
      try {
        const cur = await workspaceGetCurrent().catch(() => null)
        const rootId = (cur as { rootId?: string } | null)?.rootId
        if (!rootId) throw new Error('尚未打开仓库')
        const r = await workspaceReadFile(rootId, relPath)
        if (!alive) return
        if (!r || typeof r.content !== 'string') throw new Error('读取文件失败')
        setDoc({ content: r.content, mtimeMs: Number(r.mtimeMs ?? 0) })
      } catch (e) {
        if (alive) setReadErr(String((e as Error)?.message ?? e))
      }
    })()
    return () => { alive = false }
  }, [relPath, reloadSeq])

  const frameUrl = useMemo(() => {
    if (!doc) return ''
    const seg = relPath.split('/').map(s => encodeURIComponent(s)).join('/')
    return `kbview://vault/${seg}?v=${Math.round(doc.mtimeMs)}-${reloadSeq}`
  }, [doc, relPath, reloadSeq])

  /** fit 缩放（2026-09-09 二修）：zoom 必须做在**沙箱内部 documentElement**上——
   *  宿主 iframe 元素 zoom 会等比缩小内部视口，宽度驱动的等比 SVG 视觉高度恒不变（放大空转，一版踩坑）。
   *  内层 zoom 把内容物理放大：fit 态 iframe 直接铺满可用区，内容由壳内 zoom 撑到 ~92% 高（上限 4×），横向超出时图内可拖动；
   *  基准高 = k=1 首帧自然高。 */
  const [baseH, setBaseH] = useState(0)
  const fitKRef = useRef(1)
  useEffect(() => { setBaseH(0); fitKRef.current = 1 }, [frameUrl])
  useEffect(() => { if (box && !baseH) setBaseH(box.h) }, [box, baseH])
  const fitK = useMemo(() => {
    const k = fit && baseH > 0 && avail.h > 0 ? Math.max(1, Math.min(4, (avail.h * 0.92) / baseH)) : 1
    fitKRef.current = k
    return k
  }, [fit, baseH, avail.h])

  // 手动缩放（条目11）：有效值 = 手动覆盖 ?? fit；上报给工具条展示
  const effZoom = manualZoom ?? fitK
  const effZoomRef = useRef(effZoom)
  effZoomRef.current = effZoom
  useEffect(() => { onEffectiveZoom?.(effZoom) }, [effZoom, onEffectiveZoom])

  /** 缩放请求统一入口：宿主键控与沙箱转报共用；手动值 clamp 0.5..6，reset 回 fit（null） */
  const applyZoomReq = useCallback((req: { kind: 'in' | 'out' | 'reset' | 'wheel'; dy?: number }, ov?: number) => {
    if (!onManualZoom) return
    if (req.kind === 'reset') { onManualZoom(null); return }
    const cur = ov ?? effZoomRef.current
    let next = cur
    if (req.kind === 'wheel') next = cur * ((req.dy ?? 0) > 0 ? 1 / 1.1 : 1.1)
    else if (req.kind === 'in') next = cur * 1.25
    else next = cur / 1.25
    next = Math.round(Math.max(0.5, Math.min(6, next)) * 100) / 100
    if (Math.abs(next - cur) > 0.001) onManualZoom(next)
  }, [onManualZoom])

  // 宿主侧键控（焦点在宿主时；焦点在 iframe 内由沙箱壳捕获转报，onMsg 消费）
  const onWrapKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoomReq({ kind: 'in' }) }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); applyZoomReq({ kind: 'out' }) }
    else if (e.key === '0') { e.preventDefault(); applyZoomReq({ kind: 'reset' }) }
  }, [applyZoomReq])
  const onWrapWheel = useCallback((e: ReactWheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    applyZoomReq({ kind: 'wheel', dy: e.deltaY })
  }, [applyZoomReq])

  const pushEnv = useCallback(() => {
    try { frameRef.current?.contentWindow?.postMessage({ __kbArtTheme: collectThemeVars(), __kbArtZoom: effZoomRef.current }, '*') } catch { /* iframe 未就绪 */ }
  }, [])
  useEffect(() => { pushEnv() }, [themeTick, pushEnv, effZoom, frameUrl]) // 明暗/缩放/文档变化重发（未 ready 帧由 __kbArtReady 补）

  // 宿主消息：仅采信本 iframe 源（§4.3 劫持防护）；保留 box 量高供 fit 用；沙箱转报的手动缩放请求在此消费
  const onMsg = useCallback((e: MessageEvent) => {
    const d = e.data as Record<string, unknown> | null
    if (!d || e.source !== frameRef.current?.contentWindow) return
    if (d.__kbArtBox && typeof d.__kbArtBox === 'object') {
      const b = d.__kbArtBox as { h?: number; sw?: number; vw?: number }
      if (typeof b.h === 'number') setBox({ h: Math.max(1, b.h), sw: Math.max(0, b.sw ?? 0), vw: Math.max(1, b.vw ?? 1) })
    }
    if (d.__kbArtZoomReq === 'in' || d.__kbArtZoomReq === 'out' || d.__kbArtZoomReq === 'reset') {
      applyZoomReq({ kind: d.__kbArtZoomReq })
      return
    }
    const zw = d.__kbArtZoomWheel as { dy?: number } | undefined
    if (zw && typeof zw.dy === 'number') { applyZoomReq({ kind: 'wheel', dy: zw.dy }); return }
    if (typeof d.__kbArtErr === 'string') setFrameErr(d.__kbArtErr)
    else if (d.__kbArtReady === true) pushEnv()
  }, [pushEnv, applyZoomReq])
  useEffect(() => {
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [onMsg])

  const lines = useMemo(() => (doc ? doc.content.split('\n').length : 0), [doc])

  if (readErr) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-[12.5px] text-[var(--text-secondary)]">示意图文件读取失败</div>
        <div className="text-[11px] text-[var(--text-muted)] break-all">{readErr}</div>
      </div>
    )
  }
  if (!doc) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-[var(--text-muted)]">加载示意图…</div>
    )
  }
  return (
    <div ref={wrapRef} className="relative h-full" onKeyDown={onWrapKeyDown} onWheel={onWrapWheel}>
      {lines > 150 && !fit && (
        <div className="absolute top-0 left-0 right-0 z-10 px-3 py-1.5 bg-[var(--warning-bg)] border-b border-[var(--warning)]/30 text-[11px] text-[var(--warning)]">
          ⚠ 共 {lines} 行，超出产物约束（≤150 行），渲染可能不佳
        </div>
      )}
      {frameErr && !showSrc ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="text-[12.5px] text-[var(--text-primary)]">示意图脚本运行出错</div>
          <div className="mt-1 text-[11px] text-[var(--text-muted)] break-all">{frameErr}</div>
          <button onClick={() => setShowSrc(true)} className="mt-3 px-2.5 py-1 rounded-md border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">查看源码</button>
        </div>
      ) : showSrc ? (
        <div className="absolute inset-0 overflow-y-auto px-3 py-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10.5px] text-[var(--text-muted)]">HTML 源码（只读）</span>
            <button onClick={() => setShowSrc(false)} className="ml-auto text-[10.5px] px-1.5 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">← 返回渲染</button>
          </div>
          <pre className="whitespace-pre-wrap break-all rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)] font-[var(--font-mono,var(--font-family))]">{doc.content}</pre>
        </div>
      ) : (
        <iframe
          ref={frameRef}
          key={frameUrl}
          src={frameUrl}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={relPath}
          className="absolute inset-0 w-full h-full"
          style={{
            border: 'none',
            background: 'var(--bg-primary)',
            display: 'block',
          }}
        />
      )}
    </div>
  )
}
