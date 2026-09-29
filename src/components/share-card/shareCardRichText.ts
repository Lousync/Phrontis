/**
 * 分享卡片题目区：Markdown 行内语法 + LaTeX 的**离屏图**排版器（2026-09-29）。
 *
 * ## 为什么走「离屏图」而不是在 canvas 上直接排
 *
 * 卡片的铁律是「**canvas 唯一绘制**」——预览与导出必须是同一张画布，否则必然跑版。
 * 但 LaTeX 排版无法在 canvas 上手工实现：KaTeX 的输出是**CSS 驱动**的几千个 class
 * （`.mop` / `.vlist` / `.frac-line` …），字号、字体、分数线全在 `katex.min.css` 里。
 *
 * 解法：把 KaTeX 排好的 HTML 整块塞进 SVG 的 `<foreignObject>`，让它当矢量图载入，
 * 再 `drawImage` 到卡片 canvas 上。**排版由浏览器做，落地仍然是像素** ——
 * 单源铁律不破，公式也能随卡片一起导出。
 *
 * 代价与约束：
 * - 需要 KaTeX 的字体。字体是 woff2，**必须内联成 `@font-face` 的 data URL** 才能进
 *   `foreignObject`（外部 URL 在 SVG 转图时会被当作跨源拒掉）。字体按需缓存，只做一次。
 * - 需要一次 DOM（造容器量尺寸、造 `<img>`）。所以**本文件是渲染层专属**，
 *   不在主进程或契约脚本的裸 Node 环境里跑；纯函数约束（`renderShareCard` 不碰 DOM）
 *   靠「排版结果作为参数传进去」来保住 —— 见 `renderShareCard` 的 `opts.promptImage`。
 * - KaTeX 用 **动态 import**：`manualChunks` 已把它切成独立 chunk，动态引入不改变首屏闭包。
 */

import { CARD_W, PAD, PROMPT_MAX_CHARS, PROMPT_MAX_LINES, palette, panelLayout } from './shareCardStyles'
import type { ShareCardStyle } from '../../types'

/**
 * 题目区几何**全部从 `shareCardStyles.panelLayout()` 取**（不再在本文件手抄常量）。
 *
 * 教训（2026-09-29）：先前这里写死 `PROMPT_BLOCK_TOP = 566`，而布局函数算出的实际位置是 654
 * —— 错位 88px，表现为「公式渲染跑到框外、编辑占位框与画出来的块对不上」。
 * 手抄同一份几何必然漂移，所以现在只留一个转发函数。
 */
export function promptRect(style: ShareCardStyle) {
  return panelLayout(style).prompt
}

/** 题目区可用文本宽（块内左右各留 26） */
export function promptTextWidth(style: ShareCardStyle): number {
  return promptRect(style).w - 26 - 8
}

/** 题目区限行 / 限字（真源在 shareCardStyles，这里只做转出，避免调用方多引一个模块） */
export { PROMPT_MAX_LINES, PROMPT_MAX_CHARS } from './shareCardStyles'

/* ================= 行内语法解析 =================
 *
 * ★ 这一整段（到 `richPlainText` 结束）是**纯函数、零依赖**：调用方只传字符串。
 *   契约脚本要能直接装载它来验语法 —— 但本文件后面那半段要 DOM（造容器量尺寸、
 *   造 `<img>` 载图），且顶部 `import { palette } from './shareCardStyles'` 是**值导入**，
 *   而 Node 的 strip-types 不解析无扩展名的相对导入。
 *   所以契约脚本改用**切片装载**：只截取本文件这一段，去 import，包成临时模块再 import。
 *   改动这段时请保持「不引用任何本文件之外的东西」——否则契约会以加载失败的形式报错。
 */

export type RichSeg =
  | { kind: 'text'; text: string; bold?: boolean; italic?: boolean; code?: boolean }
  | { kind: 'math'; tex: string; display: boolean }

/**
 * 极简行内解析：`**粗**` `*斜*` `` `代码` `` `$行内公式$` `$$显示公式$$`。
 *
 * 刻意**不做块级 Markdown**（标题 / 列表 / 表格 / 引用）—— 题目区是一个定高的小块，
 * 块级语法在那儿既排不开也没有意义。解析保持可预期：认不出的语法原样当文本。
 */
export function parseRichText(src: string): RichSeg[] {
  const out: RichSeg[] = []
  let buf = ''

  const flush = () => { if (buf) { out.push({ kind: 'text', text: buf }); buf = '' } }

  let i = 0
  const s = String(src ?? '').replace(/\r\n?/g, '\n')
  while (i < s.length) {
    const rest = s.slice(i)

    // $$显示公式$$（先于 $ 判断，否则会被当成两个行内公式）
    if (rest.startsWith('$$')) {
      const end = s.indexOf('$$', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ kind: 'math', tex: s.slice(i + 2, end), display: true })
        i = end + 2
        continue
      }
    }
    // $行内公式$
    if (rest.startsWith('$')) {
      const end = s.indexOf('$', i + 1)
      if (end > i + 1 && !s.slice(i + 1, end).includes('\n')) {
        flush()
        out.push({ kind: 'math', tex: s.slice(i + 1, end), display: false })
        i = end + 1
        continue
      }
    }
    // `代码`
    if (rest.startsWith('`')) {
      const end = s.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ kind: 'text', text: s.slice(i + 1, end), code: true })
        i = end + 1
        continue
      }
    }
    // **粗体**
    if (rest.startsWith('**')) {
      const end = s.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ kind: 'text', text: s.slice(i + 2, end), bold: true })
        i = end + 2
        continue
      }
    }
    // *斜体*（避开 ** 已处理的情形）
    if (rest.startsWith('*') && !rest.startsWith('**')) {
      const end = s.indexOf('*', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ kind: 'text', text: s.slice(i + 1, end), italic: true })
        i = end + 1
        continue
      }
    }

    buf += s[i]
    i += 1
  }
  flush()
  return out
}

/** 去掉语法记号后的可见文本（给「有没有内容」判定与限字用） */
export function richPlainText(segs: RichSeg[]): string {
  return segs.map((s) => (s.kind === 'text' ? s.text : s.tex)).join('')
}

/* ================= 字体与 KaTeX 装载（按需 + 缓存） ================= */

let fontsReady: Promise<void> | null = null

/**
 * KaTeX 的 woff2 内联成 `@font-face`。
 *
 * 用 Vite 的 `?url` 让打包器把字体文件带出来（构建后是 `assets/KaTeX_*.woff2`），
 * 再 fetch 成 data URL —— 直接写 `url(...)` 相对路径在 `foreignObject` 里会被当跨源拒掉。
 * 只装载公式真正会用到的几族（Main / Math / Size / AMS），其余留给以后按需加。
 */
/**
 * 字体 URL → `@font-face` 里能用的 data URL。
 *
 * ★ 已经是 `data:` 的就直接返回，**不要 fetch**（2026-09-29 修）：Vite 会把小于内联阈值的
 * 资源编译成 `data:font/woff2;base64,…`（实测 `KaTeX_Size3-Regular.woff2` 约 3.6KB），
 * 而 `fetch(data:…)` 会被 `index.html` 的 CSP 拒掉（未列 `connect-src` → 回退 `default-src 'self'`）。
 * dev 下字体走 http、不内联，所以正常；**打包后才坏** —— 表现为题目区在打包版里画不出来
 * （`probe-share-card.mjs` case 12 抓的就是这一条）。其余（未内联的）才需要取字节转 base64。
 */
async function inlineFont(url: string): Promise<string> {
  if (url.startsWith('data:')) return url
  const buf = await (await fetch(url)).arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k])
  return `data:font/woff2;base64,${btoa(bin)}`
}

async function ensureKatexFonts(): Promise<void> {
  if (fontsReady) return fontsReady
  fontsReady = (async () => {
    const mods = await Promise.all([
      import('katex/dist/fonts/KaTeX_Main-Regular.woff2?url'),
      import('katex/dist/fonts/KaTeX_Main-Bold.woff2?url'),
      import('katex/dist/fonts/KaTeX_Main-Italic.woff2?url'),
      import('katex/dist/fonts/KaTeX_Math-Italic.woff2?url'),
      import('katex/dist/fonts/KaTeX_Size1-Regular.woff2?url'),
      import('katex/dist/fonts/KaTeX_Size2-Regular.woff2?url'),
      import('katex/dist/fonts/KaTeX_Size3-Regular.woff2?url'),
      import('katex/dist/fonts/KaTeX_Size4-Regular.woff2?url'),
      import('katex/dist/fonts/KaTeX_AMS-Regular.woff2?url'),
    ])
    const names = ['KaTeX_Main', 'KaTeX_Main', 'KaTeX_Main', 'KaTeX_Math', 'KaTeX_Size1', 'KaTeX_Size2', 'KaTeX_Size3', 'KaTeX_Size4', 'KaTeX_AMS']
    const styles = ['normal', 'bold', 'italic', 'italic', '', '', '', '', '']
    const faces: string[] = []
    for (let i = 0; i < mods.length; i++) {
      const url = (mods[i] as { default: string }).default
      const family = `${names[i]}-${styles[i] || 'Regular'}`
      faces.push(`@font-face{font-family:"${family}";src:url(${await inlineFont(url)}) format('woff2');font-display:block}`)
    }
    const st = document.createElement('style')
    st.setAttribute('data-share-card-fonts', '1')
    st.textContent = faces.join('\n')
    document.head.appendChild(st)
    await document.fonts.ready
  })()
  return fontsReady
}

let katexCssReady: Promise<void> | null = null

/** `katex.min.css` 注入一次（用 Vite 的 `?inline` 拿到 CSS 文本，避免再发一次请求） */
async function ensureKatexCss(): Promise<void> {
  if (katexCssReady) return katexCssReady
  katexCssReady = (async () => {
    const mod = await import('katex/dist/katex.min.css?inline')
    const css = (mod as { default: string }).default
    const st = document.createElement('style')
    st.setAttribute('data-share-card-katex-css', '1')
    st.textContent = css
    document.head.appendChild(st)
  })()
  return katexCssReady
}

/* ================= 排版 → 离屏图 ================= */

export interface RichTextImage {
  img: HTMLImageElement
  /** 逻辑坐标下的绘制尺寸（宽 = 内容宽，高按实际排版） */
  w: number
  h: number
}

/** 一段文本按行内段位拼成 HTML（公式走 KaTeX，其余走 span + 行内样式） */
function segmentsToHtml(segs: RichSeg[], katex: { renderToString: (t: string, o?: unknown) => string }): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const parts: string[] = []
  for (const seg of segs) {
    if (seg.kind === 'math') {
      try {
        const html = katex.renderToString(seg.tex, { output: 'html', throwOnError: false, displayMode: seg.display })
        parts.push(seg.display ? `<div style="text-align:center;margin:6px 0">${html}</div>` : html)
      } catch {
        parts.push(`<span style="color:#c00">${esc(seg.tex)}</span>`)
      }
      continue
    }
    let t = esc(seg.text)
    if (seg.code) t = `<code style="font-family:'Cascadia Code',Consolas,monospace;background:rgba(127,127,127,.14);padding:0 3px;border-radius:3px">${t}</code>`
    if (seg.italic) t = `<i>${t}</i>`
    if (seg.bold) t = `<b>${t}</b>`
    parts.push(t)
  }
  return parts.join('')
}

/**
 * 把题目文本排版成一张离屏图。
 *
 * `scale` = 逻辑坐标 → 图的像素倍率（传 `CARD_SCALE` 就是导出精度，缩放到卡片上仍清晰）。
 * 返回 `null` 表示无内容（调用方据此跳过整个块）。
 */
export async function renderRichTextImage(
  source: string,
  theme: 'light' | 'dark',
  style: ShareCardStyle,
  opts: { scale: number; maxLines?: number; maxChars?: number; fontSize?: number } = { scale: 2 },
): Promise<RichTextImage | null> {
  const raw = String(source ?? '').trim()
  if (!raw) return null

  const textW = promptTextWidth(style)
  const maxLines = opts.maxLines ?? PROMPT_MAX_LINES
  const maxChars = opts.maxChars ?? PROMPT_MAX_CHARS
  const fontSize = opts.fontSize ?? 17
  const scale = opts.scale

  const [{ default: katex }] = await Promise.all([
    import('katex'),
    ensureKatexFonts(),
    ensureKatexCss(),
  ])

  const pal = palette(theme)
  const segs = parseRichText(raw.slice(0, maxChars))
  const inner = segmentsToHtml(segs, katex as unknown as { renderToString: (t: string, o?: unknown) => string })

  const host = document.createElement('div')
  host.style.cssText = [
    'position:fixed', 'left:-10000px', 'top:0',
    `width:${textW}px`,
    `font-size:${fontSize}px`,
    `line-height:${Math.round(fontSize * 1.7)}px`,
    `color:${pal.ink}`,
    'font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif',
    'word-break:break-word', 'overflow-wrap:anywhere',
  ].join(';')
  host.innerHTML = inner

  // `.katex` 默认字号是 1.21em，题目区里调回 1em 让公式与正文同高，避免行距跳变
  const st = document.createElement('style')
  st.textContent = '.share-card-prompt .katex{font-size:1em}'
  host.className = 'share-card-prompt'
  document.body.appendChild(host)
  host.appendChild(st)

  try {
    await document.fonts.ready
    const lh = Math.round(fontSize * 1.7)
    const w = host.scrollWidth
    const fullH = host.scrollHeight
    const h = Math.min(fullH, lh * maxLines)
    const clipped = fullH > h + 1

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      '<foreignObject width="100%" height="100%">' +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;font-size:${fontSize}px;line-height:${lh}px;color:${pal.ink};font-family:'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI',system-ui,sans-serif;word-break:break-word;overflow:hidden">` +
      inner +
      (clipped ? '<div style="position:absolute;right:0;bottom:0;background:' + pal.paper + ';">…</div>' : '') +
      '</div></foreignObject></svg>'

    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    const img = new Image()
    const ok = await new Promise<boolean>((res) => {
      img.onload = () => res(true)
      img.onerror = () => res(false)
      img.src = url
    })
    if (!ok) return null
    // 离屏图按 scale 放大重绘一次，保证贴到 1080×1920 上仍然锐利
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(w * scale))
    cv.height = Math.max(1, Math.round(h * scale))
    const ctx = cv.getContext('2d')
    if (!ctx) return null
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    const out = new Image()
    const outOk = await new Promise<boolean>((res) => {
      out.onload = () => res(true)
      out.onerror = () => res(false)
      out.src = cv.toDataURL('image/png')
    })
    if (!outOk) return null
    return { img: out, w, h }
  } finally {
    host.remove()
  }
}

/**
 * 同步的高度估算（给布局预留用）。
 * 公式的实际高度只有排版完才知道，所以这里给保守上界；真正的裁剪在 `renderRichTextImage` 里。
 */
export function richTextHeight(_segs: RichSeg[], fontSize = 17, maxLines = PROMPT_MAX_LINES): number {
  return Math.round(fontSize * 1.7) * maxLines
}

/** 保持导出面：绘制层不需要自己画富文本（图已排好），但保留这两个导出便于契约脚本静态检查 */
export function drawRichText(): void { /* 由 renderRichTextImage 的离屏图承担，见文件头注 */ }
