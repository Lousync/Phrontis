/**
 * CBZ 阅读器端到端探针（B 段 · 阶段 2b：固定版式 / 图片漫画）。
 * 用法（先 seed 再跑；`electron/` 或 `src/` 有改动时**先 build**）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
 *     .AGENT/scripts/workbench-shell/probes/probe-cbz-reader.mjs --no-sandbox --disable-gpu
 *
 * 为什么必须单独一个探针（而不是「参数化 fb2 那个」）：
 *   cbz 与文本系（epub / fb2 / fbz）**共用阅读器组件**，但引擎完全不同
 *   （`ENGINE_BY_EXT` 是判据：前三个 → 'foliate' 的重排分页器，cbz → `fixed-layout.js`）。
 *   形状差异导致**同一条链路长出了不同的断言**：
 *     ① **一页 = 一个 zip 条目**（`comic-book.js:6-8`），不是「一个章节文档」⇒ 没有文本层；
 *     ② **单页 / 对开**是 `book.rendition.spread` 决定的（宿主改 `'none'`）⇒ 「可见内容帧恰好 1 个」
 *        是这条拍板的唯一可观测证据（对开会是 2）；
 *     ③ **缩放**只认 renderer 元素自己的 `zoom` 属性（`fixed-layout.js:35/64-72`，`view.js` 全文不转发）
 *        ⇒ 断言要读**元素属性 + 实际几何**，读不到「字号」那种 CSS 变量；
 *     ④ **页序**由 `comic-book.js` 的排序决定（KB PATCH ⑤-a：上游裸 `.sort()` 是字典序）⇒
 *        全书页名**故意不补零**（`page_2` vs `page_10`），字典序在此处当场红；
 *     ⑤ **缩略图**是本批唯一的新基建（反向按需：面板要 → 阅读器做）⇒ 断言「按需」比断言「能出图」更重要；
 *     ⑥ **摘录在格式层面不存在**（无文本层）⇒ 断言是**负向**的：不冒浮层、不落库、右栏没有阅读 Tab。
 *
 * 覆盖（对应 .claude/plans/b-stage2b-cbz.md §六 步 0-11）：
 *   0) fixture 复位（readerState / excerpts 清空 —— 否则上一轮的进度会让「开在第 1 页」假失败）
 *   1) 打开 cbz → 阅读器 ready；左栏出**缩略图网格**（不是目录树），tile 数 = CBZ_PAGES
 *   2) ★ 页序**自然序**：tile 标题依次等于 fixture 的 pageNames()（字典序会在这里红）
 *   3) ★ **单页**：帧树里 blob: 内容帧恰好 1 个（对开会是 2）
 *   4) ★ **缩放两档**：fit-page = 整页内接（帧宽=min(容器宽比,高比)×页宽）、fit-width = 宽度贴合容器
 *   5) 翻 3 页 → 工具栏「第 4 / 60 页」；readerState.json 的 pct > 0 且 locator 形如 `epubcfi(`
 *   6) ★ **缩略图按需**：可见格出图（且颜色 = 该页主色 ⇒ 页号↔图映射正确）、末尾页**没预生成**、
 *      滚动到末尾后才出图
 *   7) 点第 9 格 → 工具栏变「第 9 / 60 页」+ 该格高亮
 *   8) 返回书架重开 → 回到原页（工具栏页号一致；磁盘 locator 未被 reopen 写花）
 *   9) 左右边缘点击各翻一页（真输入事件）；点正中不翻页（负向）
 *   10) ★ 安全负向：恶意 cbz（SVG 内联 <script> + onerror）→ 宿主标志位全 null、帧 sandbox 无
 *       allow-scripts、页内 script 节点 0；正向对照 = 同一份载荷在正确 MIME 下可解码却仍不执行。
 *       ★ 另含 **B-18 的实机判据**：该恶意页（`page_2.svg`）现在必须**解码出 800×1120**
 *       （patch ⑦ 补 MIME 之前这里恒为破图 `naturalWidth = 0`，当年只能拿「正确 MIME 下可解码」
 *        间接对照 —— 补 MIME 不打开新攻击面，标志位仍全 null 这条断言同时锁住了它）
 *   11) ★ 摘录负向：划选不冒摘录浮层、excerpts.json 不落条、右栏**没有**「阅读」Tab
 *
 * ★ 取内容帧 / 真输入 / fixture 读写的手法与踩坑全在 `./lib/reader-probe-kit.mjs`
 *   （CDP 穿透 closed shadow root 的原因见 `probe-epub-reader.mjs` 头注）。
 * ★ fixture 的页表与页色由 `./make-cbz.mjs` 导出，本探针**直接 import**（同一真相源）——
 *   页序与「第 i 格该是什么颜色」都不在这里手抄第二份。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, createAssertions } from './lib/reader-probe-kit.mjs'
import { CBZ_PAGES, EVIL_SVG, pageColor, pageNames, pageSize } from './make-cbz.mjs'

const { ok, note, assertNotFailed, finish } = createAssertions()
const K = await connect()
const {
  evalJs, evalIn, blobFrames, visibleCtxs, pierceAttrs, hostLabel, hostPct,
  resetFixtureState, stateOf, excerptsOf, openBookshelf, openBook, backToShelf, frameBox, clickAt, sleep,
} = K

const BOOK = '探针样书.cbz'
const EVIL = '恶意样书.cbz'
const NAMES = pageNames()
const NEXT = '[data-wb="epubNext"]'
const ZOOM = '[data-wb="epubZoom"]'
const HOST_PWNED = `({ svg: window.__kbProbePwnedSvg ?? null, parentSvg: window.__kbProbePwnedParentSvg ?? null, onerror: window.__kbProbePwnedOnerror ?? null, parentOnerror: window.__kbProbePwnedParentOnerror ?? null })`

/** 工具栏页号（`· 第 N / M 页` → {cur,total}）；文本系返回 null */
async function pageLabel() {
  const raw = String((await hostLabel()) || '')
  const m = /(\d+)\s*\/\s*(\d+)\s*页/.exec(raw)
  return m ? { cur: Number(m[1]), total: Number(m[2]), raw } : { cur: null, total: null, raw }
}
const clickHost = (sel) => evalJs(`(() => { const b = document.querySelector('${sel}'); if (!b) return false; b.click(); return true })()`)
/** 等工具栏页号变成 want（翻页是异步的：relocate 落定才更新） */
async function waitPage(want, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const l = await pageLabel()
    if (l.cur === want) return l
    await sleep(250)
  }
  return await pageLabel()
}

/** 左栏网格快照：tile 标题/序号/缩略图状态/可见 index */
const tileInfo = () => evalJs(`(() => {
  const grid = document.querySelector('[data-wb="cbzGrid"]')
  const panel = document.querySelector('[data-wb="epubRailPanel"]')
  if (!grid) return { grid: false, state: panel ? panel.getAttribute('data-wb-state') : null, count: 0, titles: [], labels: [], thumbs: {}, visible: [] }
  const gr = grid.getBoundingClientRect()
  const tiles = [...grid.querySelectorAll('[data-cbz-page]')]
  const thumbs = {}
  const visible = []
  for (const t of tiles) {
    const i = Number(t.dataset.cbzPage)
    const img = t.querySelector('img')
    if (img) thumbs[i] = { src: String(img.getAttribute('src') || '').slice(0, 16), nw: img.naturalWidth }
    const r = t.getBoundingClientRect()
    if (r.bottom > gr.top && r.top < gr.bottom) visible.push(i)
  }
  return {
    grid: true, state: panel ? panel.getAttribute('data-wb-state') : null,
    count: tiles.length, titles: tiles.map((t) => t.getAttribute('title') || ''),
    // ★ 只取**最后一个** span：格子内有两个 span —— 首 span 是缩略图框（图没就绪时里面还有
    //   一个页码占位 span（内容就是 i+1），见 EpubRailPanel.tsx:192-201），末 span 才是页号标签。
    //   读整个 textContent 会把占位号与标签号**粘在一起**（「2323」），页号断言从 index 22 起全红。
    labels: tiles.map((t) => { const ss = t.querySelectorAll('span'); return ss.length ? (ss[ss.length - 1].textContent || '').trim() : '' }),
    thumbs, visible,
    scrollTop: Math.round(grid.scrollTop), scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight,
  }
})()`)

/** 第 i 格的缩略图平均色（画进 canvas 采样；纯色页 + JPEG q0.72 ≈ 原色） */
const avgColorOfTile = (i) => evalJs(`(async () => {
  const t = document.querySelector('[data-cbz-page="${i}"]')
  const img = t && t.querySelector('img')
  if (!img || !img.complete || !img.naturalWidth) return null
  const cv = document.createElement('canvas')
  cv.width = img.naturalWidth; cv.height = img.naturalHeight
  const cx = cv.getContext('2d')
  cx.drawImage(img, 0, 0)
  const d = cx.getImageData(0, 0, cv.width, cv.height).data
  let r = 0, g = 0, b = 0
  for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2] }
  const n = d.length / 4
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
})()`)

/**
 * 缩放几何（在内容帧内读 —— 帧在 closed shadow root 里，宿主查不到）：
 *  · `frameElement` 的矩形 = 渲染后的真实尺寸（`fixed-layout.js` 用 `transform: scale()`，
 *    `getBoundingClientRect` 已含变换）；
 *  · `frameElement.getRootNode().host` = `foliate-fxl` 渲染器元素本身（帧挂在它的 shadow root 里）
 *    ⇒ 直接读它的 `zoom` 属性（这条 patch 的作用面）与它的盒子（= 缩放公式里的 width/height）。
 *
 * ★ 容器尺寸报**两个口径**，因为 `#render` 用的是 `getBoundingClientRect()`（**含**滚动条槽），
 *   而 `clientWidth` 会把它减掉：切到 fit-width 后页变高 → `:host{overflow:auto}` 冒出 17px
 *   纵向滚动条 → `clientWidth` 掉到 639，帧却仍按 656 缩放 —— 拿 `clientWidth` 当基准会报出
 *   「帧宽比容器宽 17px」的假失败（2026-09-22 实测）。断言一律用 `rectW / rectH`。
 */
async function zoomGeo() {
  const [c] = await visibleCtxs()
  if (!c) return null
  return await evalIn(c.ctx, `(() => {
    const fr = frameElement
    if (!fr) return null
    const r = fr.getBoundingClientRect()
    const root = fr.getRootNode()
    const el = root && root.host ? root.host : null
    const er = el ? el.getBoundingClientRect() : null
    const img = document.querySelector('img')
    return {
      frameW: Math.round(r.width), frameH: Math.round(r.height),
      frameLeft: Math.round(r.left), frameTop: Math.round(r.top),
      rendererTag: el ? el.tagName : null,
      rectW: er ? Math.round(er.width) : null, rectH: er ? Math.round(er.height) : null,
      clientW: el ? el.clientWidth : null, clientH: el ? el.clientHeight : null,
      zoomAttr: el ? el.getAttribute('zoom') : null,
      imgW: img ? img.naturalWidth : null, imgH: img ? img.naturalHeight : null,
    }
  })()`)
}

async function main() {
  const hostBase = await evalJs(`({ title: document.title })`)
  console.log('[宿主基线]', JSON.stringify(hostBase))

  // 先确认 fixture 里真有这两本书：少了就是没跑 seed，早点报清楚比等到 openBook 超时省事
  for (const f of [BOOK, EVIL]) {
    ok(`fixture 含 .books/${f}（缺则先跑 seed-probe-vault.mjs --add-books）`,
      existsSync(join(K.FIXTURE, '.books', f)))
  }
  assertNotFailed()

  // ===== 0) fixture 复位（必须在开书前；见 probe-epub-reader 头注）=====
  note('fixture 复位（删除跨轮残留）', resetFixtureState(['readerState.json', 'excerpts.json']).join(' ') || '（无残留）')

  // ===== 1) 打开 cbz → ready + 左栏缩略图网格 =====
  await openBookshelf()
  ok('打开 .cbz → epubReader 挂载且 state=ready（File 名/type 分派 + zip 解析成功）', await openBook(BOOK))
  assertNotFailed()
  await sleep(1500)
  let info = await tileInfo()
  for (let i = 0; i < 20 && (!info.grid || info.count === 0); i++) { await sleep(400); info = await tileInfo() }
  console.log('[左栏诊断]', JSON.stringify({ ...info, thumbs: Object.keys(info.thumbs).length, titles: info.titles.slice(0, 4) }))
  ok('.cbz 在读 → 左栏挂 epubRailPanel 且 state=comic（按**引擎**分发，出网格不出目录树）',
    info.state === 'comic', String(info.state))
  ok(`tile 数 = ${CBZ_PAGES}（= 图片条目数：\`.txt\` 诱饵被扩展名过滤掉；多一个少一个都说明过滤出错）`,
    info.count === CBZ_PAGES, `${info.count}`)
  assertNotFailed()

  // ===== 2) ★ 页序自然序 =====
  //  字典序在这里当场红：`page_10` 会排到 `page_2` 前面（fixture 的页名**故意不补零**）。
  //  同时比对 tile 下方显示的页码 1..N（证明「显示序号」与「zip 内页序」绑定正确）。
  const orderOk = info.titles.length === NAMES.length && info.titles.every((t, i) => t === NAMES[i])
  ok('★★ 页序 = 自然序（`page_1 … page_60`，`page_2` 在 `page_10` 之前；字典序会红）',
    orderOk, `首 6 项 ${JSON.stringify(info.titles.slice(0, 6))} · 末项 ${info.titles[info.titles.length - 1]}`)
  ok('tile 下标注的页码依次为 1..N（显示序号与页序同源）',
    info.labels.length === CBZ_PAGES && info.labels.every((l, i) => l === String(i + 1)),
    JSON.stringify(info.labels.slice(0, 5)))
  ok('大写扩展名条目也在（`.PNG` 被整包丢掉时页码会跳号）',
    info.titles.some((t) => t.endsWith('.PNG')), JSON.stringify(info.titles.filter((t) => t.endsWith('.PNG')).slice(0, 4)))

  // ===== 3) ★ 单页（不是对开）=====
  const frames = await blobFrames()
  const vis = await visibleCtxs()
  console.log('[帧诊断]', JSON.stringify({ blobFrames: frames.length, visible: vis.length, urls: frames.map((f) => f.url.slice(0, 14)) }))
  ok('★★ 帧树里 blob: 内容帧**恰好 1 个**（`spread:none` ⇒ 一节一跨页；对开会是 2）',
    frames.length === 1, `${frames.length}`)
  ok('可见内容帧恰好 1 个（无隐藏预载帧混进来）', vis.length === 1, `${vis.length}`)

  // ===== 4) ★ 缩放两档 =====
  {
    const g0 = await zoomGeo()
    console.log('[缩放诊断 fit-page]', JSON.stringify(g0))
    ok('默认档 = fit-page（`data-wb-zoom` 与 renderer 元素的 `zoom` 属性一致）',
      (await evalJs(`document.querySelector('${ZOOM}')?.getAttribute('data-wb-zoom') ?? null`)) === 'fit-page'
      && g0?.zoomAttr === 'fit-page', JSON.stringify({ attr: g0?.zoomAttr }))
    ok('renderer 是 foliate-fxl（缩放属性的作用面；文本系是 foliate-paginator）', g0?.rendererTag === 'FOLIATE-FXL', String(g0?.rendererTag))
    // fit-page 语义 = 整页内接：scale = min(容器宽/页宽, 容器高/页高) ⇒ 两个方向都不溢出
    const expectPage = Math.min(g0.rectW / g0.imgW, g0.rectH / g0.imgH) * g0.imgW
    ok('★ fit-page = 整页内接（帧宽 = min(容器宽比, 容器高比) × 页宽，±2px）',
      Math.abs(g0.frameW - expectPage) <= 2, `实测 ${g0.frameW} · 期望 ${Math.round(expectPage)} · 容器 ${g0.rectW}×${g0.rectH} · 页 ${g0.imgW}×${g0.imgH}`)
    ok('fit-page 下帧高不超容器高（整页可见）', g0.frameH <= g0.rectH + 1, `${g0.frameH} vs ${g0.rectH}`)

    ok('点缩放按钮可切档', await clickHost(ZOOM))
    await sleep(700)
    const g1 = await zoomGeo()
    console.log('[缩放诊断 fit-width]', JSON.stringify(g1))
    ok('★ 切到 fit-width（`data-wb-zoom` 与 renderer `zoom` 属性同步换档）',
      (await evalJs(`document.querySelector('${ZOOM}')?.getAttribute('data-wb-zoom') ?? null`)) === 'fit-width'
      && g1?.zoomAttr === 'fit-width', JSON.stringify({ attr: g1?.zoomAttr }))
    ok('★ fit-width = 宽度贴合容器（帧宽 = 容器**边框盒**宽，±2px；不用 clientWidth，见 zoomGeo 头注）',
      Math.abs(g1.frameW - g1.rectW) <= 2, `实测 ${g1.frameW} · 容器 rect=${g1.rectW} client=${g1.clientW}`)
    ok('★ 换档后几何真的变了（fit-width 的帧面积 > fit-page）',
      g1.frameW * g1.frameH > g0.frameW * g0.frameH,
      `${g0.frameW}×${g0.frameH}=${g0.frameW * g0.frameH} → ${g1.frameW}×${g1.frameH}=${g1.frameW * g1.frameH}`)
    ok('可切回 fit-page（两档来回）', await clickHost(ZOOM))
    await sleep(700)
    const g2 = await zoomGeo()
    ok('★ 切回 fit-page 后帧宽与首次一致', Math.abs(g2.frameW - g0.frameW) <= 1, `${g0.frameW} → ${g2.frameW}`)
  }

  // ===== 5) 翻 3 页 → 工具栏页号 + 进度落盘 =====
  const pct0 = await hostPct()
  const l0 = await pageLabel()
  ok('打开即定位首页（工具栏「第 1 / N 页」）', l0.cur === 1 && l0.total === CBZ_PAGES, JSON.stringify(l0.raw))
  for (let i = 0; i < 3; i++) { await clickHost(NEXT); await sleep(700) }
  const l3 = await waitPage(4)
  ok('★ 翻 3 页 → 工具栏「第 4 / 60 页」（页号来自 `section.current`，不是文件名）',
    l3.cur === 4 && l3.total === CBZ_PAGES, `cur=${l3.cur} raw=${l3.raw}`)
  ok('工具栏章标签不再是文件名（`tocItem.label` 对 cbz 是 `page_4.png`）',
    !/\.(png|PNG|jpe?g|webp|gif|bmp|svg|avif|jxl)$/.test(String(l3.raw)), String(l3.raw))
  await sleep(1600)
  const st1 = stateOf(BOOK)
  console.log('[readerState 诊断]', JSON.stringify(st1))
  ok('readerState.json 有该书状态', !!st1)
  ok('进度已落盘且 > 0（字节加权累计位置；`fixed-layout` 自身报 0，是 `view.js` 重算的）',
    (st1?.pct ?? 0) > 0, `pct=${st1?.pct}（开书时 ${pct0}%）`)
  ok('locator 为 foliate 的假 CFI（`CFI.fake.fromIndex`，形如 `epubcfi(/6/8!)`）',
    typeof st1?.locator === 'string' && st1.locator.startsWith('epubcfi('), String(st1?.locator))

  // ===== 6) ★ 缩略图按需 =====
  {
    let t = await tileInfo()
    for (let i = 0; i < 60 && Object.keys(t.thumbs).length < t.visible.length; i++) { await sleep(500); t = await tileInfo() }
    const made = Object.keys(t.thumbs).map(Number)
    console.log('[缩略图诊断]', JSON.stringify({
      ready: made.length, visible: t.visible.length, visibleIdx: `${t.visible[0]}..${t.visible[t.visible.length - 1]}`,
      min: Math.min(...made), max: Math.max(...made), sample: t.thumbs[made[0]],
    }))
    ok('可见格都出了缩略图（data: URL）', made.length >= t.visible.length && t.visible.every((i) => !!t.thumbs[i]),
      `ready=${made.length} visible=${t.visible.length}`)
    ok('缩略图是 data: URL 且已下采样到 96px 宽（不是原图直接塞格子）',
      made.every((i) => t.thumbs[i].src.startsWith('data:image/')) && t.thumbs[made[0]].nw === 96,
      JSON.stringify(t.thumbs[made[0]]))
    ok(`★ 末尾页没预生成（index ${CBZ_PAGES - 1} 无图）且总量 < ${CBZ_PAGES}（= 没整本预生成）`,
      !(CBZ_PAGES - 1 in t.thumbs) && made.length < CBZ_PAGES,
      `ready=${made.length} max=${Math.max(...made)} last=${CBZ_PAGES - 1 in t.thumbs}`)

    // ★ 页号 ↔ 图映射：fixture 每页主色由 pageColor(i) 定，纯色页 + JPEG q0.72 可反查
    const pairs = [t.visible[0], t.visible[t.visible.length - 1]].filter((i) => i !== undefined)
    for (const i of pairs) {
      const got = await avgColorOfTile(i)
      const want = pageColor(i)
      const near = !!got && got.every((v, k) => Math.abs(v - want[k]) <= 16)
      ok(`★ 第 ${i + 1} 格的图 = 第 ${i + 1} 页（平均色 ≈ pageColor(${i})，±16）`, near,
        `实测 ${JSON.stringify(got)} · 期望 ${JSON.stringify(want)}`)
    }

    // 滚到末尾 → 末尾页按需补图（不是一次性全要，但滚到了就得给）
    const before = made.length
    await evalJs(`(() => { const g = document.querySelector('[data-wb="cbzGrid"]'); g.scrollTop = g.scrollHeight; return true })()`)
    let t2 = await tileInfo()
    for (let i = 0; i < 60 && !(CBZ_PAGES - 1 in t2.thumbs); i++) { await sleep(500); t2 = await tileInfo() }
    console.log('[滚动后缩略图]', JSON.stringify({ scrollTop: t2.scrollTop, ready: Object.keys(t2.thumbs).length, visibleIdx: t2.visible.slice(0, 3) }))
    ok('★ 滚动到末尾后末尾页才出图（证明是滚动驱动的按需补图，不是开机整本生成）',
      t2.scrollTop > 0 && (CBZ_PAGES - 1 in t2.thumbs), `scrollTop=${t2.scrollTop} last=${CBZ_PAGES - 1 in t2.thumbs}`)
    ok('新补的图没有把旧的丢掉（缓存是累积的）', Object.keys(t2.thumbs).length > before,
      `${before} → ${Object.keys(t2.thumbs).length}`)

    // 滚回顶部，便于下一步点第 9 格
    await evalJs(`(() => { const g = document.querySelector('[data-wb="cbzGrid"]'); g.scrollTop = 0; return true })()`)
    await sleep(400)
  }

  // ===== 7) 点第 9 格 → 跳页 + 高亮 =====
  {
    await evalJs(`(() => { const b = document.querySelector('[data-cbz-page="8"]'); if (b) b.click(); return true })()`)
    const l9 = await waitPage(9)
    ok('★ 点第 9 格 → 工具栏「第 9 / 60 页」（href = zip 内文件名，走 view.goTo）',
      l9.cur === 9, `cur=${l9.cur} raw=${l9.raw}`)
    await sleep(800)
    const hl = await evalJs(`(() => {
      const tile = document.querySelector('[data-cbz-page="8"]')
      const other = document.querySelector('[data-cbz-page="20"]')
      const box = (t) => t ? t.querySelector('span') : null
      return {
        active: box(tile) ? box(tile).className.includes('border-[var(--accent)]') : null,
        other: box(other) ? box(other).className.includes('border-[var(--accent)]') : null,
        activeHref: tile ? tile.getAttribute('title') : null,
      }
    })()`)
    console.log('[高亮诊断]', JSON.stringify(hl))
    ok('★ 当前页格子高亮（其余格子不亮）', hl.active === true && hl.other === false, JSON.stringify(hl))
    const contentOk = await ctxHasPage(8)
    ok('★ 正文真的换到第 9 页（该页主色 = pageColor(8) 的 blob 图）', contentOk, String(contentOk))
  }

  // ===== 8) 返回书架 → 重开 → 回原位 =====
  {
    const before = (await stateOf(BOOK))?.locator ?? ''
    const labelBefore = (await pageLabel()).cur
    ok('点「返回书架」退出阅读', await backToShelf())
    ok('重开 .cbz → 回到 ready', await openBook(BOOK))
    await sleep(1800)
    const back = await pageLabel()
    const after = (await stateOf(BOOK))?.locator ?? ''
    console.log('[恢复诊断]', JSON.stringify({ labelBefore, back: back.raw, locatorBefore: before, locatorAfter: after }))
    ok('★ 重开回到原来那一页（假 CFI 经 `CFI.fake.toIndex` 还原 index）',
      back.cur === labelBefore, `${labelBefore} → ${back.cur}`)
    // 注：恢复期间的 relocate 被 `restoringRef` 挡住不落盘，故这条断言证明的是「重开没把旧位置写花」
    //     （真正的回位由上一行工具栏页号证）。见 EpubReaderView 的 persist 守卫。
    ok('★ 重开未写花落盘的 locator（逐字相同）', !!before && before === after, `${before} → ${after}`)
  }

  // ===== 9) 边缘点击翻页（真输入事件）=====
  {
    // 注：**本步以前**每翻一页终端都会回显一条 `[Renderer] Uncaught TypeError: Cannot read
    // properties of null (reading 'width')`（fixed-layout 的 RO 空帧竞态，当年是「明明页面正常
    // 却满屏红字」）。patch ⑥ 落码后这条**必须消失** —— 本文件末尾把它从「定点过滤」改成了
    // **硬断言**（零条），所以这里不再有噪声提示。
    // `ResizeObserver loop completed with undelivered notifications` 循环告警（B-21，patch ⑧）
    // **不从列表里滤掉**，但也不作断言（会假通过，理由见文件末尾那条 note）。
    const from = (await pageLabel()).cur
    // ★ 先切 fit-width：fit-page 下帧居中、左右留白，帧左边缘离宿主盒左边缘可能超过热区宽
    await evalJs(`(() => { const b = document.querySelector('${ZOOM}'); if (b && b.getAttribute('data-wb-zoom') === 'fit-page') b.click(); return true })()`)
    await sleep(700)
    const box = await frameBox()
    const host = await evalJs(`(() => { const h = document.querySelector('[data-wb="epubHost"]'); if (!h) return null; const r = h.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, height: r.height } })()`)
    ok('读到内容帧与宿主阅读盒（热区坐标基准）', !!box && box.width > 0 && !!host, JSON.stringify({ box, host }))
    if (box && host) {
      const midY = box.top + box.height * 0.5
      // 左边缘：取「宿主机盒左 +12」与「帧左 +12」的较大者（帧可能比宿主盒往左探出，见 epub 探针踩坑）
      const leftX = Math.max(host.left + 12, box.left + 12)
      const rightX = Math.min(host.right - 20, box.left + box.width - 20)
      const midX = Math.round(host.left + (host.right - host.left) / 2)
      await clickAt(leftX, midY)
      const lPrev = await waitPage(from - 1)
      ok('★ 点左边缘 → 上一页', lPrev.cur === from - 1, `${from} → ${lPrev.cur}（点击 x=${Math.round(leftX)}）`)
      await clickAt(rightX, midY)
      const lNext = await waitPage(from)
      ok('★ 点右边缘 → 下一页', lNext.cur === from, `${lPrev.cur} → ${lNext.cur}（点击 x=${Math.round(rightX)}）`)
      await clickAt(midX, midY)
      await sleep(800)
      const lMid = await pageLabel()
      ok('★ 负向：点正中不翻页（中间留给划选/图片操作）', lMid.cur === from, `${from} → ${lMid.cur}`)
    }
  }

  // ===== 10) ★ 摘录负向（格式层面不存在）+ 右栏无阅读 Tab =====
  {
    const [c] = await visibleCtxs()
    ok('内容帧可经 CDP 定位（closed shadow root 内）', !!c)
    if (c) {
      // 程序化选中整页（页体只有一个 <img>）并派发 mouseup —— 走的是与文字书完全相同的
      // 选区处理链（`bindDoc` 的 onUp）。文字书此处会冒浮条，cbz 必须不冒。
      const selRes = await evalIn(c.ctx, `(() => {
        const img = document.querySelector('img')
        if (!img) return 'no-img'
        const r = document.createRange()
        r.selectNode(img)
        const s = getSelection()
        s.removeAllRanges(); s.addRange(r)
        img.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return 'sel:' + s.toString().length
      })()`)
      await sleep(900)
      const pop = await evalJs(`!![...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').startsWith('存为摘录'))`)
      note('程序化选区结果（`sel:0` = 页内无文本可选中，这正是格式层面的原因）', String(selRes))
      ok('★ 打开 cbz 不冒摘录浮条（无文本层 ⇒ 选区拿不到 text，handler 直接收摊）', pop === false, String(pop))
      const marks = await pierceAttrs('g', 'fill')
      ok('★ 正文无高亮节点（`create-overlay` 对 fixed-layout 根本不发）',
        !(marks ?? []).some((f) => ['#efb84c', '#7fb844', '#5d9bdc', '#e0709a', '#9188e8'].includes(String(f))),
        JSON.stringify(marks))
      ok('★ excerpts.json 不落条（cbz 摘录在 schema 层被显式拒绝：合法 kind 但无定位分支）',
        (excerptsOf(BOOK) ?? []).length === 0, JSON.stringify(excerptsOf(BOOK)))
    }
    // 右栏「阅读」Tab 是条件性入口（App.tsx 对 cbz 传 null）—— 拍板①：不支持的入口不出现
    const rp = await evalJs(`({
      readingTab: !!document.querySelector('[data-wb-rp-tab="reading"]'),
      otherTabs: [...document.querySelectorAll('[data-wb="rpTab"]')].map((b) => b.getAttribute('data-wb-rp-tab')),
    })`)
    console.log('[右栏诊断]', JSON.stringify(rp))
    ok('★ 右栏**没有**「阅读」Tab（cbz 有进度但无摘录无书签，侧栏是空壳 ⇒ 不出入口）',
      rp.readingTab === false, JSON.stringify(rp))
  }

  // ===== 11) ★ 恶意 cbz 负向 =====
  {
    ok('点「返回书架」准备开恶意书', await backToShelf())
    ok('恶意 .cbz 能正常渲染（不崩、不白屏）', await openBook(EVIL))
    await sleep(1500)
    // 磁盘证据：载荷确实在**源文件**里（zip 是 STORED，可直接在字节里找到），
    // 否则「帧里没有」什么也证明不了
    const src = readFileSync(join(K.FIXTURE, '.books', EVIL))
    ok('fixture 源文件确实含 <script> + onerror 载荷（故「没执行」不是样本里本来就没有）',
      src.includes(Buffer.from('<script')) && src.includes(Buffer.from('onerror=')) && src.includes(Buffer.from('__kbProbePwnedSvg')),
      `len=${src.length}`)
    // 第 2 页 = 恶意页（page_2.svg）→ 点第 2 格
    await evalJs(`(() => { const b = document.querySelector('[data-cbz-page="1"]'); if (b) b.click(); return true })()`)
    const lp = await waitPage(2)
    ok('跳到第 2 页（SVG 那一页）', lp.cur === 2, String(lp.raw))
    await sleep(1200)
    const [ec] = await visibleCtxs()
    ok('恶意页内容帧可读', !!ec)
    if (ec) {
      const probe = await evalIn(ec.ctx, `(() => {
        const img = document.querySelector('img')
        const fe = frameElement
        return {
          scripts: document.querySelectorAll('script').length,
          onerrorAttr: document.querySelectorAll('[onerror]').length,
          imgNw: img ? img.naturalWidth : null, imgNh: img ? img.naturalHeight : null,
          imgSrc: img ? String(img.getAttribute('src') || '').slice(0, 5) : null,
          sandbox: fe ? fe.getAttribute('sandbox') : 'frameElement=null',
          markers: ${HOST_PWNED},
        }
      })()`)
      console.log('[载荷诊断]', JSON.stringify(probe))
      ok('★ 该帧解的就是恶意页那张图（`<img>` 指向 blob: URL —— 字节确实被喂进了解码器）',
        probe?.imgSrc === 'blob:', String(probe?.imgSrc))
      ok('★ 页内 script 节点 0 个、onerror 属性 0 个（载荷进的是 <img> 的解码器，不是文档 DOM）',
        probe?.scripts === 0 && probe?.onerrorAttr === 0, JSON.stringify(probe))
      ok('★★ 内容帧 sandbox = allow-same-origin（永不含 allow-scripts）', probe?.sandbox === 'allow-same-origin', String(probe?.sandbox))
      ok('★ 该帧内标志位全 null（SVG 作为图片加载时不执行脚本）',
        Object.values(probe?.markers ?? { x: 1 }).every((v) => v === null), JSON.stringify(probe?.markers))
      // ★ B-18 已修（patch ⑦）：此处**以前**只能做「两步对照」而不报正面断言 —— 因为
      //   `imgNw` 当时**恒为 0**（cbz 的 SVG 页破图：`loadBlob(name)` 不带 MIME ⇒ Blob type=''
      //   ⇒ Chromium 拒解；PNG/JPEG 靠内容嗅探照常，所以「别的页都好」掩盖了它）。
      //   现在取消该豁免，正面断言直接压在上行的 `imgNw` 上。
      //   下面两步安全对照**仍保留** —— 它们证的是「防线①本身成立」，与 MIME 无关：
      //   ①同一份载荷（import 自 make-cbz.mjs，逐字相同）在**正确 MIME** 下确实可解码
      //     —— 排除「没执行只是因为载荷是废文本」；
      //   ②而它解码后标志位仍全 null —— 直接证伪「SVG 走 <img> 会执行脚本」，即防线①本身。
      ok('★★ B-18：该帧的 SVG 页**确实解码了**（`naturalWidth = 800 × 1120`）'
        + '—— patch ⑦ 之前这里恒为 0；补齐 MIME **不打开新攻击面**，见下一条',
        probe?.imgNw === 800 && probe?.imgNh === 1120, `imgNw=${probe?.imgNw} imgNh=${probe?.imgNh}`)
      const decodable = await evalJs(`(async () => {
        const im = new Image()
        const v = await new Promise((res) => {
          im.onload = () => res('ok:' + im.naturalWidth + 'x' + im.naturalHeight)
          im.onerror = () => res('error')
          im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(EVIL_SVG)})
          setTimeout(() => res('timeout'), 4000)
        })
        return { v, pwned: ${HOST_PWNED} }
      })()`)
      ok('★★ 正向对照：同一份载荷在正确 MIME 下**确实可解码**（800×1120）——「没执行」不是因为载荷是废文本',
        decodable?.v === 'ok:800x1120', String(decodable?.v))
      ok('★★ 而它解码后标志位依然全 null（防线① = `<img>` 里的 SVG 不执行脚本，与 MIME 无关）',
        Object.values(decodable?.pwned ?? { x: 1 }).every((v) => v === null), JSON.stringify(decodable?.pwned))
      // 这条 note 以前记的是「已知产品缺口：cbz 的 .svg 页破图（`img.naturalWidth` 实测 0）」，
      // B-18 修掉后已升级为上行硬断言；留一行说明避免后人以为断言被悄悄删了。
      note('★ B-18 的旧「已知缺口」记录已撤销 —— `.svg` 页从破图改为硬断言（patch ⑦ 补 MIME）',
        `imgNw=${probe?.imgNw}（旧记录恒为 0）· PNG/JPEG 页断言不变`)
    }
    const hostAfter = await evalJs(`({ title: document.title, pwned: ${HOST_PWNED} })`)
    console.log('[宿主终态]', JSON.stringify(hostAfter))
    ok('★★ 宿主 window 未被污染（标志位全 null）', Object.values(hostAfter.pwned).every((v) => v === null), JSON.stringify(hostAfter.pwned))
    ok('★ 宿主 document.title 未被改写', hostAfter.title === hostBase.title, `${hostBase.title} → ${hostAfter.title}`)
  }

  // ★ B-17 的**实机判据**：以前这里把 `Cannot read properties of null (reading 'width')` 当噪声
  //   定点滤掉（当年确实修不了），patch ⑥ 落码后改为**硬断言零条** —— 一条都不能有。
  //   留着过滤就等于把这条修的验证也一起滤掉了（「不报错」类修复必须这么锁）。
  const rawErrs = (await evalJs(`(window.__errs ?? []).slice(0, 60)`)) ?? []
  const widthErrs = rawErrs.filter((e) => /reading 'width'/.test(e) || /Cannot read properties of null/.test(e))
  ok('★ B-17：全程零「Cannot read properties of null (reading \'width\')」'
    + '（fixed-layout `#render` 空帧竞态，patch ⑥ 的 `if (!right) return`；本步连翻多页 + 进出多轮）',
    widthErrs.length === 0, `实得 ${widthErrs.length} 条${widthErrs.length ? ' · ' + widthErrs[0].slice(0, 120) : ''}`)
  // B-21（`ResizeObserver loop completed with undelivered notifications`，foliate `View` 的观察者
  // 被留在已脱离的帧上）**此处不作断言，只报数** —— 理由不是「与本条无关」，而是这条判据在本探针
  // 的时序下**会假通过**：2026-09-22 拿故意改回上游门的构建实测，本探针某轮读 **0 条**、而
  // `probe-ro-noise.mjs`（同构建、同一批书）读 **341 条** ⇒ 告警条数受卸载时机/GC 影响，本就
  // 「时有时无」（这正是它当年难查的原因）。回归位只在 `probe-ro-noise.mjs`，那里用
  // 「帧内的 window 已消失却仍被观察」这一条**不受时机影响**的判据。
  const roErrs = rawErrs.filter((e) => /ResizeObserver loop/.test(e))
  note('ResizeObserver 环告警条数（**不作断言**：读 0 不代表没漏，见本段注释与 probe-ro-noise.mjs）',
    `${roErrs.length} 条`)
  const errs = rawErrs.filter((e) => !/ResizeObserver loop/.test(e)).slice(0, 6)
  note('渲染层错误（B-17 已硬断言见上行；RO 环告警单列在上一条，此处只列其余）', JSON.stringify(errs))
  note('CDP 求值竞态失败次数（帧被替换瞬间求值，非断言失败）', String(K.evalFailures()))
  note('回归：epub / fb2 / pdf / txt / reading-panel / excerpt-export 五条探针另跑（本探针只覆盖 cbz）', '见 §六 步 11')

  finish()
}

/**
 * 「正文真的换到第 i 页了吗」的判据：当前可见帧里 `<img>` 的**自然尺寸** = fixture 的
 * `pageSize(i)`。取尺寸而不是颜色 —— 尺寸是 `getViewport` 的返回（同一份数据决定缩放基准），
 * 顺带也就证明了「缩放公式拿到的页尺寸」与 fixture 一致。
 */
async function ctxHasPage(i) {
  const [c] = await visibleCtxs()
  if (!c) return 'no-frame'
  const got = await evalIn(c.ctx, `(() => { const im = document.querySelector('img'); return im ? [im.naturalWidth, im.naturalHeight] : null })()`)
  if (!got) return 'no-img'
  const want = pageSize(i)
  return Math.abs(got[0] - want[0]) <= 1 && Math.abs(got[1] - want[1]) <= 1 ? 'ok' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`
}

main().catch((e) => { console.error('CBZ 阅读器探针失败:', e.message); process.exit(2) })
