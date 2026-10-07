/**
 * FB2 / FBZ 阅读器端到端探针（B 段 · 阶段 2a）。
 * 用法（先 seed 再跑）：
 *   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books
 *   node .AGENT/scripts/workbench-shell/probes/run-probe.mjs .AGENT/scripts/workbench-shell/probes/probe-fb2-reader.mjs --no-sandbox --disable-gpu
 *
 * 为什么 fb2/fbz 值得单独一个探针（而不是「参数化 epub 那个」）：
 *   epub / fb2 / fbz 共用同一个阅读器组件与同一个引擎（`ENGINE_BY_EXT` 三者都映到 'foliate'），
 *   于是**通用链路**（挂载 / 分页 / 划选摘录 / 进度落盘 / CFI 恢复）已被 probe-epub-reader 覆盖；
 *   本探针要打的是**三者不一样的地方**：
 *     ① File 的 name/type 决定 foliate 选哪个解码器（`view.js:13-21` 全是**大小写敏感 endsWith**，
 *        不看魔数）—— 后缀给错就是 UnsupportedTypeError / 被当 EPUB 解包炸掉；
 *     ② FB2 的样式表是**内建**的（上游走 blob: 被宿主 CSP 拦）—— KB PATCH ④ 改内联，
 *        本探针的排版断言就是这条 patch 的验收靶（改回去 = 全部静默失效、无任何报错）；
 *     ③ FB2 的 TOC **href 形状与 EPUB 不同**（`fb2.js:339` 是 `String(index)`，不是文件路径），
 *        而左栏点目录走的是同一条 `view.goTo(href)` —— 这是「格式不同、链路相同」的接缝；
 *     ④ FB2 的图片自带 base64（`<binary>` → `data:`），与 EPUB 的「子资源改写」是两条通道；
 *     ⑤ 恶意载荷的**证据形态与 EPUB 相反**：EPUB 是「进得了 DOM、执行不了」，FB2 是白名单转换器
 *        「根本进不了 DOM」（`fb2.js:129` 未知节点名直接 return null）——照抄 EPUB 的断言必假失败。
 *
 * 覆盖：
 *   1) 点「探针样书.fb2」→ 阅读器 ready（引擎解析成功 = File 名/type 分派正确）
 *   2) 正文渲染 + ★ PATCH ④ 生效（章标题居中、第二段缩进 1em）+ 图片（`<binary>` → data:）+ 帧 sandbox
 *   3) 左栏目录三章齐（FB2 的 href 是 `String(index)`，与 EPUB 路径形状不同）
 *   4) 第一章划选 → 摘录：kind='fb2' + cfi + chapter='第一章 …'；Overlayer 高亮真的画上
 *   5) 目录跳第二章 → 再摘一条（chapter 应为第二章）→ 目录跳第三章（进度真的变大 = 真分页）
 *   6) 进度落盘：readerState.json 该书 pct > 0 且 locator 是 epubcfi(...)（FB2 也用 CFI 定位）
 *   7) ★ 导出按章节分组端到端：右栏导出 → 收件箱「读书笔记」页里 `## 第一章` / `## 第二章` 各成一组，
 *      且**不得**出现 `## 第 1 段`（落到 txt 分支的静默错法）
 *   8) 返回书架 → 重开 → 从 CFI 恢复到第三章
 *   9) FBZ（同样是 foliate 引擎、同样一本内容，只是装在 zip 里）→ 能开、能渲染、目录齐
 *   10) ★ 恶意样书.fb2 负向：三种载荷**一个都没进 DOM**（脚本节点 0 个、onerror 属性 0 个），
 *       而同节的标记段落**在**（正向对照，排除「其实没打开对的那一节」）+ 宿主 window 清白
 *
 * ★ 取内容帧 / 高亮 / 真输入 / fixture 读写的手法与踩坑全在 `./lib/reader-probe-kit.mjs`
 *   （CDP 穿透 closed shadow root 的原因见 `probe-epub-reader.mjs` 头注 —— 两个探针共用同一套取证）。
 */
import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { connect, createAssertions } from './lib/reader-probe-kit.mjs'

const { ok, note, assertNotFailed, finish } = createAssertions()
const K = await connect()
const {
  evalJs, evalIn, visibleCtxs, ctxWithText, pierceAttrs, hostPct, hostLabel,
  resetFixtureState, stateOf, excerptsOf, openBookshelf, openBook, backToShelf, sleep,
} = K

const FB2 = '探针样书.fb2'
const FBZ = '探针样书.fbz'
const EVIL = '恶意样书.fb2'
const INBOX = join(K.FIXTURE, '.knowbase', '_inbox')

/** 在内容帧里划选第一段 ≥24 字的 p，并派发 mouseup（复用 epub 探针的手法） */
const SELECT = `(() => {
  const p = [...document.querySelectorAll('p')].find((x) => (x.textContent || '').trim().length >= 24)
  if (!p || !p.firstChild) return 'no-p'
  const tn = p.firstChild
  const r = document.createRange()
  r.setStart(tn, 0)
  r.setEnd(tn, Math.min(24, tn.data.length))
  const s = getSelection()
  s.removeAllRanges(); s.addRange(r)
  p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  return 'ok:' + s.toString().slice(0, 16)
})()`

/** 点阅读器浮条上的「存为摘录」并等落盘 */
async function createExcerpt(label) {
  const [c] = await visibleCtxs()
  if (!c) { ok(`${label}：内容帧可读`, false); return null }
  const sel = await evalIn(c.ctx, SELECT)
  ok(`${label}：内容帧内程序化划选 + mouseup`, String(sel).startsWith('ok:'), String(sel))
  await sleep(500)
  const clicked = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '').startsWith('存为摘录'))
    if (!b) return false
    b.click(); return true
  })()`)
  ok(`${label}：浮条出现并可点「存为摘录」`, clicked === true)
  await sleep(1200)
  return clicked === true
}

/** 点左栏目录里的某一章，等 toolbar 章节标签跟上 */
async function gotoChapter(want) {
  const clicked = await evalJs(`(() => {
    const p = document.querySelector('[data-wb="epubRailPanel"]')
    if (!p) return 'no-panel'
    const b = [...p.querySelectorAll('button')].find((x) => (x.textContent || '').includes(${JSON.stringify(want)}))
    if (!b) return 'no-item'
    b.click(); return 'ok'
  })()`)
  if (clicked !== 'ok') return { clicked, label: null }
  let label = null
  for (let i = 0; i < 16; i++) {
    label = await hostLabel()
    if (label && label.includes(want)) break
    await sleep(300)
  }
  return { clicked, label }
}

async function main() {
  const hostBase = await evalJs(`({ title: document.title })`)
  console.log('[宿主基线]', JSON.stringify(hostBase))
  const PWNED = `({ inline: window.__kbProbePwnedInline ?? null, parent: window.__kbProbePwnedParent ?? null, onerror: window.__kbProbePwnedOnerror ?? null, parentOnerror: window.__kbProbePwnedParentOnerror ?? null })`

  // ===== 0) fixture 复位（必须在开书前；见 probe-epub-reader 头注）=====
  //   导出产生的「读书笔记」页也一并清：本探针第 7 步要断言收件箱里**恰好一篇**，
  //   留着上一轮的会直接数错（不清则必须每次先跑 seed —— 探针自带复位更省事）。
  const staleNotes = (() => {
    try { return readdirSync(INBOX).filter((f) => f.startsWith('读书笔记 · ')) } catch { return [] }
  })()
  for (const f of staleNotes) { try { unlinkSync(join(INBOX, f)) } catch { /* 忽略 */ } }
  note('fixture 复位（删除跨轮残留）', [...resetFixtureState(), ...staleNotes].join(' ') || '（无残留）')

  // ===== 1) 打开 FB2 → 阅读器 ready =====
  await openBookshelf()
  ok('打开 .fb2 → epubReader 挂载且 state=ready（File 名/type 分派正确）', await openBook(FB2))
  assertNotFailed()
  await sleep(1200)
  const pct0 = await hostPct()

  // ===== 2) 渲染 + ★ PATCH ④（FB2 内建样式表）=====
  const ctxs = await visibleCtxs()
  ok('内容帧可经 CDP 定位（closed shadow root 内）', ctxs.length > 0, `${ctxs.length}`)
  assertNotFailed()
  const ctx0 = ctxs[0].ctx
  const body = await evalIn(ctx0, `(document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 140)`)
  const typo = await evalIn(ctx0, `(() => {
    const h1 = document.querySelector('h1')
    const ps = [...document.querySelectorAll('p')]
    const cs = (el) => el ? getComputedStyle(el) : null
    return {
      h1Align: cs(h1)?.textAlign ?? null,
      h1Text: (h1?.textContent || '').slice(0, 20),
      p0Indent: cs(ps[0])?.textIndent ?? null,
      p1Indent: cs(ps[1])?.textIndent ?? null,
      p0Margin: cs(ps[0])?.marginTop ?? null,
      img: (() => { const i = document.querySelector('img'); return i ? { nw: i.naturalWidth, src: (i.getAttribute('src') || '').slice(0, 24) } : null })(),
    }
  })()`)
  console.log('[排版诊断]', JSON.stringify(typo))
  console.log('[渲染诊断]', JSON.stringify({ body }))
  ok('正文文本进入内容帧（FB2 解析 + 排版）', typeof body === 'string' && body.includes('这一段用于验证'), String(body).slice(0, 60))
  ok('★ PATCH ④ 生效：章标题居中（内建样式表 `.title h1 { text-align: center }`）',
    typo?.h1Align === 'center', `${typo?.h1Align} · ${typo?.h1Text}`)
  ok('★ PATCH ④ 生效：正文段 margin 归零（`p { margin: 0 }` 而非 UA 默认 16px）',
    typo?.p0Margin === '0px', String(typo?.p0Margin))
  ok('★ PATCH ④ 生效：第二段行首缩进 1em（首段命中 `:not(p) + p` 规则被归零，故看第二段）',
    typo?.p1Indent && typo.p1Indent !== '0px', `p0=${typo?.p0Indent} p1=${typo?.p1Indent}`)
  ok('FB2 内嵌图片已解码（<binary> base64 → data: 通道）', (typo?.img?.nw ?? 0) > 0, JSON.stringify(typo?.img))
  const sandbox = await evalIn(ctx0, `(() => { const fe = window.frameElement; return fe ? fe.getAttribute('sandbox') : 'frameElement=null' })()`)
  ok('★★ 内容帧 sandbox = allow-same-origin（不含 allow-scripts）', sandbox === 'allow-same-origin', String(sandbox))

  // ===== 3) 左栏目录（FB2 的 href 是 String(index)）=====
  const rail = await evalJs(`(() => {
    const p = document.querySelector('[data-wb="epubRailPanel"]')
    return {
      epubRail: !!p, state: p?.getAttribute('data-wb-state') ?? null,
      pdfRail: !!document.querySelector('[data-wb="pdfRailPanel"]'),
      list: !!document.querySelector('[data-wb="bookshelfSideList"]'),
      labels: p ? [...p.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean) : [],
      hrefs: p ? [...p.querySelectorAll('button')].map((b) => b.getAttribute('title') || '') : [],
    }
  })()`)
  console.log('[左栏诊断]', JSON.stringify(rail))
  ok('.fb2 在读 → 左栏挂 epubRailPanel 且 ready（按**引擎**而非扩展名分发）', rail.epubRail && rail.state === 'ready', JSON.stringify(rail))
  ok('.fb2 在读 → 不挂 PDF 三件套 / 不挂书目列表', !rail.pdfRail && !rail.list)
  ok('目录三章齐（来源是 FB2 的 <section><title>，不是 EPUB nav）',
    ['第一章', '第二章', '第三章'].every((t) => rail.labels.some((l) => l.includes(t))), JSON.stringify(rail.labels))
  ok('★ FB2 目录 href 是序号串（`String(index)`）—— 与 EPUB 的路径形状不同，但同走 view.goTo()',
    rail.hrefs.some((h) => /^\d+$/.test(h)), JSON.stringify(rail.hrefs))

  // ===== 4) 第一章摘录 =====
  await createExcerpt('第 1 条（第一章）')
  let exList = excerptsOf(FB2).filter((e) => e.kind === 'fb2')
  ok('摘录落盘且 kind=fb2（不得记成 epub）', exList.length >= 1, JSON.stringify(exList).slice(0, 200))
  ok('摘录带 CFI（FB2 也有文本层，定位精度与 EPUB 同级）',
    !!exList[0]?.cfi && String(exList[0].cfi).startsWith('epubcfi('), String(exList[0]?.cfi))
  ok('摘录带 chapter（导出分组用，来自 relocate 的 tocItem.label）',
    String(exList[0]?.chapter ?? '').includes('第一章'), String(exList[0]?.chapter))
  let marks = []
  for (let i = 0; i < 12; i++) {
    marks = (await pierceAttrs('g', 'fill')) ?? []
    if (marks.length > 0) break
    await sleep(300)
  }
  ok('Overlayer 高亮真的画上了（draw-annotation → <g fill> 落 #efb84c）',
    marks.includes('#efb84c'), JSON.stringify(marks))

  // ===== 5) 目录跳第二章 → 再摘一条；再跳第三章（进度须变大 = 真分页）=====
  const g2 = await gotoChapter('第二章')
  ok('目录跳「第二章」生效（toolbar 章节标签跟上）', g2.clicked === 'ok' && String(g2.label).includes('第二章'), JSON.stringify(g2))
  await sleep(600)
  await createExcerpt('第 2 条（第二章）')
  exList = excerptsOf(FB2).filter((e) => e.kind === 'fb2')
  const ch2Ex = exList.find((e) => String(e.chapter ?? '').includes('第二章'))
  ok('第二条摘录的 chapter = 第二章（章节标签跟着 relocate 走，不是写死首章）', !!ch2Ex, JSON.stringify(exList.map((e) => e.chapter)))
  const g3 = await gotoChapter('第三章')
  ok('目录跳「第三章」生效', g3.clicked === 'ok' && String(g3.label).includes('第三章'), JSON.stringify(g3))
  const ch3Ctx = await ctxWithText('第三章 收尾')
  ok('内容帧真的换到第三章那一节', !!ch3Ctx, ch3Ctx ? ch3Ctx.url : 'null')
  const pct3 = await hostPct()
  ok('★ 进度真的变大（Fraction 走完全书，不是单页恒 0 = 分页器真的在跑）', pct3 > pct0, `${pct0}% → ${pct3}%`)

  // ===== 6) 进度落盘（pct + CFI 双轨）=====
  await sleep(1800)
  const st1 = stateOf(FB2)
  console.log('[readerState 诊断]', JSON.stringify(st1))
  ok('readerState.json 有该书状态', !!st1)
  ok('进度已落盘且 > 0', (st1?.pct ?? 0) > 0, `pct=${st1?.pct}`)
  ok('locator 为 CFI 串（FB2 的定位与 EPUB 同格式）',
    typeof st1?.locator === 'string' && st1.locator.startsWith('epubcfi('), String(st1?.locator))

  // ===== 7) ★ 导出按章节分组（端到端）=====
  {
    // 右栏切到「阅读」Tab（导出入口在书卡头里；锚点与 probe-excerpt-export 同一套）
    const tabOk = await evalJs(`(() => {
      const t = document.querySelector('[data-wb-rp-tab="reading"]')
      if (!t) return false
      t.click(); return true
    })()`)
    let panelW = 0
    for (let i = 0; i < 20; i++) {
      panelW = await evalJs(`(() => { const el = document.querySelector('[data-wb="readingPanel"]'); return el ? Math.round(el.getBoundingClientRect().width) : 0 })()`)
      if (panelW > 0) break
      await sleep(300)
    }
    ok('右栏「阅读」Tab 可点且面板可见', tabOk && panelW > 0, `tab=${tabOk} w=${panelW}`)
    const btn = await evalJs(`(() => {
      const b = document.querySelector('[data-wb="excerptExportBtn"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { visible: r.width > 0 && r.height > 0, disabled: !!b.disabled }
    })()`)
    ok('书卡头有「导出为笔记」按钮且可用', !!btn?.visible && !btn?.disabled, JSON.stringify(btn))
    await evalJs(`(() => { document.querySelector('[data-wb="excerptExportBtn"]')?.click(); return true })()`)
    await sleep(2500)
    const notes = readdirSync(INBOX).filter((f) => f.startsWith('读书笔记 · '))
    console.log('[收件箱]', JSON.stringify(notes))
    ok('收件箱出现「读书笔记」页文件', notes.length === 1, JSON.stringify(notes))
    const md = notes.length === 1 ? readFileSync(join(INBOX, notes[0]), 'utf8') : ''
    const heads = md.split('\n').filter((l) => l.startsWith('## ')).join(' / ')
    console.log('[导出分组]', heads)
    ok('★ 导出按章节分组（## 第一章 / ## 第二章 各成一组）',
      md.includes('## 第一章') && md.includes('## 第二章'), heads)
    ok('★ 没落到 txt 分支（FB2 摘录没有 paraIndex，套 txt 模板会把全书并成「## 第 1 段」）',
      !md.includes('## 第 1 段'), heads)
    ok('导出 md 含该书两条摘录的 kbloc 链接', (md.match(/kbloc:/g) || []).length === 2, `实际 ${(md.match(/kbloc:/g) || []).length}`)
    ok('导出 md 的链接指向 .fb2 书键', md.includes('.books/探针样书.fb2#'))
  }

  // ===== 8) 返回书架 → 重开 → 从 CFI 恢复 =====
  ok('点「返回书架」退出阅读', await backToShelf())
  const railBack = await evalJs(`({ reader: !!document.querySelector('[data-wb="epubReader"]'), list: !!document.querySelector('[data-wb="bookshelfSideList"]') })`)
  ok('退出后阅读器卸载、左栏回到书目列表', !railBack.reader && railBack.list, JSON.stringify(railBack))
  const pctBefore = st1?.pct ?? 0
  ok('重开 .fb2 → 回到 ready', await openBook(FB2))
  await sleep(1500)
  const restored = await evalJs(`({ pct: document.querySelector('[data-wb="epubPct"]')?.textContent ?? null, chapter: document.querySelector('[data-wb="epubChapter"]')?.textContent ?? null })`)
  const backCtx = await ctxWithText('第三章 收尾')
  console.log('[恢复诊断]', JSON.stringify(restored), '落盘 pct =', pctBefore, '第三章帧 =', !!backCtx)
  const uiPct = parseInt(String(restored.pct).replace('%', ''), 10)
  ok('重开后进度回到落盘值附近（CFI 恢复生效）', Number.isFinite(uiPct) && Math.abs(uiPct - pctBefore) <= 5, `ui=${restored.pct} disk=${pctBefore}`)
  ok('重开后停在第三章（不是回首页）', !!backCtx, String(restored.chapter))
  // ★ FB2 的 section 基础 CFI 是**伪造的**（`view.js:418` `CFI.fake.fromIndex(index)` —— fb2.js 不提供
  //   section 级 cfi），但**范围部分是真实的**（`CFI.joinIndir(base, CFI.fromRange(range))`）。
  //   于是关键问题是：回跳到底精确到原处，还是退化到章首？判据 = 重开后的落盘 locator 是否与关书前
  //   逐字相同（章首回落会写出**另一个** CFI 串）。这条同时证伪/证实上游方案 §三 陷阱 2 的旧结论。
  await sleep(1800)
  const st2 = stateOf(FB2)
  ok('★ 重开后的 locator 与关书前逐字相同（= 精确回到原处，而非回落到章首）',
    !!st2?.locator && st2.locator === st1?.locator, `${st1?.locator} → ${st2?.locator}`)

  // ===== 9) FBZ：同一本内容装在 zip 里 =====
  ok('点「返回书架」准备开 .fbz', await backToShelf())
  ok('打开 .fbz → ready（zip 里按 .fb2 后缀挑条目 → makeFB2）', await openBook(FBZ))
  await sleep(1200)
  const zCtxs = await visibleCtxs()
  ok('.fbz 内容帧可读', zCtxs.length > 0, `${zCtxs.length}`)
  const zBody = zCtxs.length ? await evalIn(zCtxs[0].ctx, `(document.body.textContent || '').slice(0, 80)`) : null
  ok('.fbz 正文渲染（与 .fb2 同源内容）', typeof zBody === 'string' && zBody.includes('这一段用于验证'), String(zBody).slice(0, 60))
  const zRail = await evalJs(`(() => {
    const p = document.querySelector('[data-wb="epubRailPanel"]')
    return { ready: p?.getAttribute('data-wb-state') === 'ready', labels: p ? [...p.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) : [] }
  })()`)
  ok('.fbz 目录三章齐（FBZ 与 FB2 的目录构造完全同源）',
    zRail.ready && ['第一章', '第二章', '第三章'].every((t) => zRail.labels.some((l) => l.includes(t))), JSON.stringify(zRail.labels))

  // ===== 10) ★ 恶意书负向（FB2 白名单转换器：载荷根本进不了 DOM）=====
  ok('点「返回书架」准备开恶意书', await backToShelf())
  ok('恶意 .fb2 能正常渲染（不崩、不白屏）', await openBook(EVIL))
  await sleep(1500)
  // 先留一份磁盘证据：载荷确实在**源文件**里（否则下面的空 DOM 什么也证明不了）
  const evilSrc = readFileSync(join(K.FIXTURE, '.books', EVIL), 'utf8')
  ok('fixture 源文件确实含三种载荷（故「DOM 里没有」是转换器丢的，不是样本里本来就没有）',
    /<script\s+src="evil\.js"/.test(evilSrc) && /__kbProbePwnedInline/.test(evilSrc) && /onerror=/.test(evilSrc),
    `len=${evilSrc.length}`)
  const EVIL_CASES = [
    { toc: '第一章', marker: '本页含外部 script 标签', desc: '外部 <script src>（子资源）', sel: 'script' },
    { toc: '第二章', marker: '本页含内联 script 标签', desc: '内联 <script>', sel: 'script' },
    { toc: '第三章', marker: '本页含 onerror 属性', desc: 'onerror 属性', sel: 'image' },
  ]
  for (const c of EVIL_CASES) {
    const g = await gotoChapter(c.toc)
    if (g.clicked !== 'ok') { ok(`恶意书目录跳到「${c.toc}」`, false, String(g.clicked)); continue }
    let ctx = null
    for (let i = 0; i < 12; i++) {
      ctx = await ctxWithText(c.marker)
      if (ctx) break
      await sleep(300)
    }
    if (!ctx) { ok(`定位「${c.desc}」那一节（标记段落 ${c.marker}）`, false); continue }
    const probe = await evalIn(ctx.ctx, `({
      marker: (document.body.textContent || '').includes(${JSON.stringify(c.marker)}),
      scripts: document.querySelectorAll('script').length,
      onerrorAttr: document.querySelectorAll('[onerror]').length,
      imgCount: document.querySelectorAll('img').length,
      markers: ${PWNED},
    })`)
    console.log(`[载荷诊断 ${c.desc}]`, JSON.stringify(probe))
    ok(`「${c.desc}」同节的标记段落在 DOM 里（正向对照：确实打开了那一节）`, probe?.marker === true, JSON.stringify(probe))
    ok(`★「${c.desc}」载荷**根本没进 DOM**（白名单转换器在转换期丢弃，与 EPUB 的「进 DOM 但不执行」不同形态）`,
      probe?.scripts === 0 && probe?.onerrorAttr === 0, JSON.stringify(probe))
    if (c.sel === 'image') {
      // 正向对照：`<image>` 元素**本身过了**白名单（imgCount=1），被丢掉的只有 onerror 属性 ——
      // 否则「DOM 里没有 onerror」也可能只是「整个 image 都没渲染出来」，证据就弱了。
      ok('★ 对照：<image> 元素本身在 DOM 里（丢的是**属性**，不是整个元素）', probe?.imgCount === 1, `imgCount=${probe?.imgCount}`)
    }
    ok(`★「${c.desc}」未执行（该帧标志位全 null）`,
      Object.values(probe?.markers ?? { x: 1 }).every((v) => v === null), JSON.stringify(probe?.markers))
  }
  const hostAfter = await evalJs(`({ title: document.title, pwned: ${PWNED} })`)
  console.log('[宿主终态]', JSON.stringify(hostAfter))
  ok('★ 宿主 window 未被污染（标志位全 null）', Object.values(hostAfter.pwned).every((v) => v === null), JSON.stringify(hostAfter.pwned))
  ok('★ 宿主 document.title 未被改写', hostAfter.title === hostBase.title && hostAfter.title !== 'PWNED-INLINE', `${hostBase.title} → ${hostAfter.title}`)
  // B-21（`ResizeObserver loop completed with undelivered notifications`，foliate `View` 的观察者
  // 被留在已脱离的帧上）**此处不作断言，只报数** —— 不是「与本条无关」，而是这条判据在本探针的
  // 时序下**会假通过**：2026-09-22 拿故意改回上游门的构建实测，本探针读 0 条、`probe-ro-noise.mjs`
  // （同构建）读 341 条 ⇒ 条数受卸载时机/GC 影响（这正是它当年「时有时无」的原因）。
  // 回归位只在 `probe-ro-noise.mjs`（判据是「帧内 window 已消失却仍被观察」，不受时机影响）。
  const rawErrs = (await evalJs(`(window.__errs ?? []).slice(0, 60)`)) ?? []
  const roErrs = rawErrs.filter((e) => /ResizeObserver loop/.test(e))
  note('ResizeObserver 环告警条数（**不作断言**：读 0 不代表没漏，见本段注释与 probe-ro-noise.mjs）',
    `${roErrs.length} 条`)
  const errs = rawErrs.filter((e) => !/ResizeObserver loop/.test(e)).slice(0, 6)
  note('渲染层错误（RO 环告警单列在上一条，此处只列其余）', JSON.stringify(errs))
  note('CDP 求值竞态失败次数（帧被替换瞬间求值，非断言失败）', String(K.evalFailures()))

  finish()
}
main().catch((e) => { console.error('FB2 阅读器探针失败:', e.message); process.exit(2) })
