/**
 * 页级 DOM 工具（方案 A 迁移，2026-09-21）。
 *
 * 官方 viewer 的页结构是 `div.page[data-page-number] > div.canvasWrapper > canvas` +
 * `div.textLayer` + `div.annotationLayer`（见 `web/pdf_viewer.js` 的 PDFPageView /
 * TextLayerBuilder）。本文件只做「在官方结构上补我方体验」的三件小事，不碰渲染：
 * 1. 行间命中盒补白（拖选落进行间空隙会跳选一大段）；
 * 2. 搜索命中高亮；
 * 3. 摘录叠加框（百分比矩形，与缩放无关）。
 */
import type { ExcerptItem, ExcerptRect } from '../../../types'

/** 官方页元素选择器（页面盒带 data-page-number 属性） */
export const PAGE_SEL = '.page'

/** 从任意页内节点回溯到页码（非页内节点返回 0） */
export function pageNumberOf(el: Element | null | undefined): number {
  const page = el?.closest(PAGE_SEL) as HTMLElement | null
  const n = page ? Number(page.dataset.pageNumber) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 从任意页内节点回溯到文本层元素 */
export function textLayerOf(el: Element | null | undefined): HTMLElement | null {
  return (el?.closest('.textLayer') as HTMLElement | null) ?? null
}

/**
 * 补「行间命中盒」：pdf.js 的 span 盒高 = 字号（≈1em），而正文行距常是它的 2 倍以上
 * （实测样例 PDF：盒 10.5px / 行距 26px → **六成纵向空间没有可命中的文本盒**）。
 * 鼠标落在这段空隙里时，浏览器的「最近文本位置」会跳到很远的节点 ——
 * 表现就是拖选到两行之间会突然选中下面十几行（实测 anchor 在本行行首、extent 落空隙中部时
 * 选区跨 19 行）。修法：量一次相邻行距中位数，每侧往外撑 (行距 − 盒高)/2 再多半像素；
 * CSS 侧用等量 `margin-top` 抵消 padding 对内容的推挤，**字形位置不动**。
 * 只影响命中盒：文字透明无背景，且选区高亮按**文本行盒**绘制、不含 padding，视觉零变化。
 */
export function expandTextLayerHitAreas(host: HTMLElement | null | undefined): void {
  if (!host) return
  try {
    const spans = [...host.querySelectorAll('span')]
    if (spans.length < 4) return
    const tops = [...new Set(spans.map((s) => Math.round(s.getBoundingClientRect().top)))].sort((a, b) => a - b)
    if (tops.length < 4) return
    const deltas = tops.slice(1).map((t, i) => t - tops[i]).filter((d) => d > 2).sort((a, b) => a - b)
    if (deltas.length < 3) return
    const pitch = deltas[Math.floor(deltas.length / 2)]
    const h = spans[Math.floor(spans.length / 2)].getBoundingClientRect().height
    // 撑到「正好铺满行距」再多半像素：相邻行盒轻微交叠也不要留缝（留缝 = 又给浏览器一个跳远的落点）
    const pad = (pitch - h) / 2 + 0.5
    if (!(pad > 0.5)) return
    host.style.setProperty('--kb-hit-pad', `${pad.toFixed(2)}px`)
  } catch { /* 命中盒只是体验优化，量不出来就不补 */ }
}

/** 搜索命中：给本页文本层里包含关键词的 span 打标（幂等；文本层重建后由调用方重跑） */
export function markSearchMatches(layer: HTMLElement | null | undefined, query: string): boolean {
  if (!layer) return false
  const needle = query.trim().toLowerCase()
  layer.querySelectorAll('.kb-pdf-match').forEach((el) => el.classList.remove('kb-pdf-match'))
  if (!needle) return false
  let matched = false
  for (const span of layer.querySelectorAll('span')) {
    if ((span.textContent ?? '').toLowerCase().includes(needle)) {
      span.classList.add('kb-pdf-match')
      matched = true
    }
  }
  return matched
}

/**
 * 摘录叠加：把摘录 rects（**文本层百分比**）画进该页文本层。
 * 幂等：以 data-ehl（`摘录id:序号`）标记去重 + 清陈旧 —— 文本层重建（缩放/翻页/换模式）后
 * 重跑即可补画；滚动不重建文本层，已画的框随层存在，无需每页重跑。
 * 百分比口径成立的前提是「文本层盒 == 画布盒」，见 pdfViewerTheme.css ②（页面边框归零）。
 */
export function paintExcerptOverlays(
  layer: HTMLElement | null | undefined,
  page: number,
  excerpts: ExcerptItem[],
): void {
  if (!layer || !page) return
  const hits = excerpts.filter((e) => e.kind === 'pdf' && e.page === page && e.rects?.length)
  const wanted = new Set<string>()
  for (const e of hits) for (let i = 0; i < (e.rects?.length ?? 0); i++) wanted.add(`${e.id}:${i}`)
  layer.querySelectorAll<HTMLElement>('.kb-excerpt-hl').forEach((d) => {
    if (!wanted.has(d.dataset.ehl ?? '')) d.remove()
  })
  for (const e of hits) {
    (e.rects ?? []).forEach((r: ExcerptRect, idx: number) => {
      const mark = `${e.id}:${idx}`
      if (layer.querySelector(`.kb-excerpt-hl[data-ehl="${mark}"]`)) return
      const d = document.createElement('div')
      d.className = 'kb-excerpt-hl'
      d.dataset.ehl = mark
      d.style.left = `${(r.l * 100).toFixed(3)}%`
      d.style.top = `${(r.t * 100).toFixed(3)}%`
      d.style.width = `${(r.w * 100).toFixed(3)}%`
      d.style.height = `${(r.h * 100).toFixed(3)}%`
      layer.appendChild(d)
    })
  }
}
