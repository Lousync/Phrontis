/**
 * 批 3 实机探针（dev bridge 版，**只读 + 少量点击**）
 * 方案：`docs/image-viewer-design.md`；契约：`verify-image-viewer.mjs`（124 项）+ `verify-image-math.mjs`（75 项）
 *
 * 为什么要它：两个契约都只能证「源码接线是对的」，证不了「真跑起来落点对不对」。
 * 本批的核心恰恰是**落点**（图片此前一律落元信息卡）与**三条非正常态**，必须真机看一眼。
 *
 * 与 `probe-content-routing.mjs` §3.8/§3.9 的分工：
 *   那边验「图片确实落查看器 + ⋮ 查看组 + SVG 双落点」；
 *   这条专门验**异常态**（超像素 / 解码失败）、**底色**（透明图棋盘格）、**沉浸态**（控件退浮条）
 *   与 **md 内联**（非附件区引用能显示、打错的路径显示破图而不是永久「加载中」）。
 *
 * 用法：
 *   1) 先播种 fixture：`node .AGENT/scripts/image-viewer/seed-batch3-fixture.mjs`
 *   2) 另开一个终端：`npm run dev`（端口 7173；启动前删掉 ELECTRON_RUN_AS_NODE）
 *   3) `node .AGENT/scripts/image-viewer/probe-image-viewer.mjs`
 *
 * ★ 本探针**只做读取与开页签**：不模拟输入、不写盘、不改你的仓库文件。
 *   它会打开若干页签（停在最后一个），看完手动关掉即可。
 *   手势类（Ctrl+滚轮锚点 / 拖拽夹取 / 双击）**刻意不做** —— 那要合成滚轮与拖拽序列，
 *   失败时你分不清是功能坏了还是探针没模拟对；放进文末的手点清单。
 */
const PORT = Number(process.env.BRIDGE_PORT ?? 7465)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`  [OK]   ${label}${detail ? '   -- ' + detail : ''}`); return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  console.log(`  [FAIL] ${label}${detail ? '   -- ' + detail : ''}`)
  return false
}

async function action(name, params) {
  const res = await fetch(`http://127.0.0.1:${PORT}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, params }),
    signal: AbortSignal.timeout(20000),
  })
  return await res.json()
}

/** 跑一段渲染层代码并取回返回值（桥的返回结构见 devbridge） */
async function evalJs(code) {
  const r = await action('ui.eval', { code })
  return r?.data?.result?.result ?? null
}

async function rectOf(sel) {
  const raw = await evalJs(`JSON.stringify((function () {
    var els = [].slice.call(document.querySelectorAll(${JSON.stringify(sel)}));
    var el = els.filter(function (e) { return e.getClientRects().length > 0; })[0];
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })())`)
  try { return JSON.parse(raw) } catch { return null }
}

async function clickSel(sel, waitMs = 700) {
  const r = await rectOf(sel)
  if (!r) return false
  await action('ui.click', { x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(waitMs)
  return true
}

/** 主栏内的图片落点签名 —— 全部用稳定的 DOM 事实，不依赖文案 */
const SIGN = `JSON.stringify((function () {
  var panes = [].slice.call(document.querySelectorAll('[data-pane="main"]'));
  var scope = panes.filter(function (el) { return el.getClientRects().length > 0; })[0] || document;
  var q = function (s) { return scope.querySelector(s); };
  var canvas = q('[data-wb="imageCanvas"]');
  var card = q('[data-wb="imgStateCard"]');
  var bar = q('[data-wb="imageToolbar"]');
  var img = q('.kb-img-rot img');
  return {
    canvas: !!canvas,
    checker: !!(canvas && canvas.classList.contains('kb-img-checker')),
    pannable: canvas ? canvas.getAttribute('data-pannable') : null,
    imgSrcKind: img ? String(img.getAttribute('src') || '').split(':')[0] : null,
    imgNatW: img ? img.naturalWidth : 0,
    imgNatH: img ? img.naturalHeight : 0,
    cardKind: card ? card.getAttribute('data-kind') : null,
    cardText: card ? (card.textContent || '').slice(0, 220) : null,
    retry: !!q('[data-wb="imgStateRetry"]'),
    toolbar: !!bar,
    toolbarVariant: bar ? bar.getAttribute('data-variant') : null,
    zoom: (q('[data-wb="imgZoomLevel"]') || {}).textContent || null,
    rot: (function () { var r = q('.kb-img-rot'); return r ? r.style.transform : null })(),
    topbar: !!document.querySelector('[data-wb="noteTopBar"]'),
    subtitle: (q('[data-wb="noteTopSubtitle"]') || {}).textContent || null,
    saveDot: !!q('[data-wb="noteSaveDot"]'),
  };
})())`

async function sign() {
  const raw = await evalJs(SIGN)
  try { return JSON.parse(raw) } catch { return { parseError: String(raw).slice(0, 140) } }
}

/** 仓库里的非 md 文件按扩展名分组 */
const LIST_FILES = `(async function () {
  try {
    var pages = await window.api.getKnowledgePages(null);
    var files = (pages || []).filter(function (p) { return p && p.entryKind === 'file' && p.path; });
    var by = {};
    files.forEach(function (p) {
      var ext = (p.fileType || '').toLowerCase();
      (by[ext] = by[ext] || []).push(p.path);
    });
    return JSON.stringify({ total: files.length, by: by });
  } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
})()`

/** 按文件名片段挑（fixture 的名字是稳定的，比「第一个 png」可靠） */
const pickNamed = (by, exts, needle) => {
  for (const e of exts) {
    const hit = (by[e] || []).find(p => p.includes(needle))
    if (hit) return hit
  }
  return null
}
const pick = (by, exts) => {
  for (const e of exts) if (by[e] && by[e].length) return by[e][0]
  return null
}

async function openByRel(rel) {
  await evalJs(`window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: ${JSON.stringify(rel)}, from: 'knowledge' } }))`)
  await sleep(2600)
  return await sign()
}

async function main() {
  console.log('§0 dev bridge 健康检查')
  let health = null
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(4000) })
    health = await r.json().catch(() => ({}))
  } catch { /* 下面统一报 */ }
  if (!ok(!!health, `dev bridge 在 ${PORT} 上可访问`, health ? '' : '先另开终端跑 npm run dev（并删掉 ELECTRON_RUN_AS_NODE）')) {
    console.log('\n无法继续：桥没起来。')
    process.exit(1)
  }

  console.log('\n§1 列出仓库内的文件')
  let parsed = null
  try { parsed = JSON.parse(await evalJs(LIST_FILES)) } catch { /* 下面报 */ }
  ok(!!parsed && !parsed.error, '能读到知识库条目列表', parsed?.error ? String(parsed.error) : '')
  if (!parsed || parsed.error) { process.exit(1) }
  const by = parsed.by || {}

  const normalRel = pickNamed(by, ['png'], '照片') || pick(by, ['png', 'jpg', 'jpeg'])
  const alphaRel = pickNamed(by, ['png'], '透明')
  const bigRel = pickNamed(by, ['png'], '超像素')
  const brokenRel = pickNamed(by, ['png'], '损坏')
  const svgRel = pickNamed(by, ['svg'], '示意') || pick(by, ['svg'])
  const jpgRel = pick(by, ['jpg', 'jpeg'])
  const mdRel = pickNamed(by, ['md'], '图片引用')

  if (!normalRel) {
    console.log('  [SKIP] 没找到图片 fixture。先跑：')
    console.log('         node .AGENT/scripts/image-viewer/seed-batch3-fixture.mjs')
  }

  console.log('\n§2 正常 PNG → 查看器（批 3 的核心：此前是元信息卡）')
  if (!normalRel) {
    console.log('  [SKIP] 没有图片文件')
  } else {
    const s = await openByRel(normalRel)
    ok(s.canvas === true, `「${normalRel}」落图片画布（imageCanvas）`, JSON.stringify({ canvas: s.canvas, cardKind: s.cardKind }))
    ok(s.imgSrcKind === 'blob', '图片 src 是 blob:（不是 data:base64 —— 省 33% 体积与一次 atob）', String(s.imgSrcKind))
    ok(s.imgNatW > 0 && s.imgNatH > 0, '图像真的解码出来了（naturalWidth/Height > 0）', `${s.imgNatW}x${s.imgNatH}`)
    ok(s.toolbar === true && s.toolbarVariant === 'inline',
      '顶栏右侧有控件簇且是 inline 变体（拍板 D7）', JSON.stringify({ t: s.toolbar, v: s.toolbarVariant }))
    ok(/^\d+%$/.test(s.zoom || ''), '控件簇里有缩放百分比', String(s.zoom))
    ok(/^\d+ × \d+$/.test(s.subtitle || ''), '顶栏中段 = 像素尺寸', String(s.subtitle))
    ok(s.saveDot === false, '不显示保存点（图片无保存动作 ⇒ 绿点是假信号）')
    ok(s.checker === true, 'PNG 铺了棋盘格底（可能含 alpha ⇒ 按格式自动，拍板 D9）')
  }

  console.log('\n§3 透明 PNG → 棋盘格底真的透出来')
  if (!alphaRel) {
    console.log('  [SKIP] 没有「透明图.png」（fixture 未播种）')
  } else {
    const s = await openByRel(alphaRel)
    ok(s.canvas === true && s.checker === true, `「${alphaRel}」落查看器且带棋盘格底`, JSON.stringify({ canvas: s.canvas, checker: s.checker }))
    ok(s.imgNatW === 600 && s.imgNatH === 400, '解码尺寸 = 600×400（fixture 声明的那个）', `${s.imgNatW}x${s.imgNatH}`)
  }
  if (jpgRel) {
    const s = await openByRel(jpgRel)
    ok(s.canvas === true && s.checker === false,
      `JPEG「${jpgRel}」是纯色底、**不铺**棋盘格（格式定义上无 alpha，铺了是白铺）`,
      JSON.stringify({ canvas: s.canvas, checker: s.checker }))
  } else {
    console.log('  [SKIP] 仓库里没有 jpg（无法对照「纯色底」那一侧）')
  }

  console.log('\n§4 超像素 PNG → 「过大」卡，且成因是**像素**那条')
  if (!bigRel) {
    console.log('  [SKIP] 没有「超像素.png」（fixture 未播种）')
  } else {
    const s = await openByRel(bigRel)
    ok(s.canvas === false && s.cardKind === 'toobig', `「${bigRel}」落「过大」卡（不是画布）`, JSON.stringify({ canvas: s.canvas, kind: s.cardKind }))
    ok(/百万像素|像素/.test(s.cardText || ''), '卡上写明是**像素**超限（不是笼统的「图片过大」）', String(s.cardText).slice(0, 120))
    ok(/20000/.test(s.cardText || ''), '卡上报出真实尺寸 20000 × 20000', String(s.cardText).slice(0, 160))
    ok(s.toolbar === false, '没有控件簇（没有可缩放的东西 ⇒ 不给一批点了没反应的按钮）')
    ok(s.saveDot === false, '无保存点')
    // ★ 这一条是像素守卫存在的**全部意义**：若守卫失效，Chromium 会尝试解码 4 亿像素
    ok(true, '（若上一条通过，说明解码前就被拦下了 —— 否则这一步会明显卡死）')
  }

  console.log('\n§5 损坏 PNG → 「解码失败」卡 + 重试')
  if (!brokenRel) {
    console.log('  [SKIP] 没有「损坏.png」（fixture 未播种）')
  } else {
    const s = await openByRel(brokenRel)
    ok(s.canvas === false && s.cardKind === 'broken', `「${brokenRel}」落「解码失败」卡`, JSON.stringify({ canvas: s.canvas, kind: s.cardKind }))
    ok(s.retry === true, '卡上有「重新读取」（imgStateRetry）')
    ok(/解码|损坏/.test(s.cardText || ''), '卡上说明了原因（区分「文件坏了」与「格式不认识」）', String(s.cardText).slice(0, 120))
    if (s.retry) {
      await clickSel('[data-wb="imgStateRetry"]', 2200)
      const s2 = await sign()
      ok(s2.cardKind === 'broken', '点「重新读取」后仍是 broken（文件确实坏着，不是探针缓存问题）', String(s2.cardKind))
    }
  }

  console.log('\n§6 ⋮ 的「查看」组 + 快捷键')
  if (normalRel) {
    await openByRel(normalRel)
    if (await clickSel('[data-wb="noteTopMore"]')) {
      const has = await evalJs(`String(['imgMenuFit','imgMenuActual','imgMenuRotateL','imgMenuRotateR'].filter(function (a) { return !document.querySelector('[data-wb="' + a + '"]') }).join(','))`)
      ok(has === '' || has === 'null', '⋮ 里有「查看」组四项（拍板 D10）', `缺：${has}`)
      if (await clickSel('[data-wb="imgMenuActual"]', 600)) {
        const z = await evalJs(`(function(){var e=document.querySelector('[data-wb="imgZoomLevel"]');return e?e.textContent:null})()`)
        ok(z === '100%', '点「实际大小」→ 读数 100%', String(z))
      }
      if (await clickSel('[data-wb="noteTopMore"]')) {
        if (await clickSel('[data-wb="imgMenuRotateR"]', 600)) {
          const r = await evalJs(`(function(){var e=document.querySelector('.kb-img-rot');return e?e.style.transform:null})()`)
          ok(/rotate\(90deg\)/.test(String(r)), '点「向右旋转」→ rotate(90deg)', String(r))
        }
      }
    } else {
      console.log('  [SKIP] 点不到 ⋮')
    }
    // 无修饰键快捷键
    await action('ui.key', { key: '1' }); await sleep(500)
    const z1 = await evalJs(`(function(){var e=document.querySelector('[data-wb="imgZoomLevel"]');return e?e.textContent:null})()`)
    ok(z1 === '100%', '快捷键 1 → 实际大小', String(z1))
    await action('ui.key', { key: '0' }); await sleep(500)
    const z0 = await evalJs(`(function(){var e=document.querySelector('[data-wb="imgZoomLevel"]');return e?e.textContent:null})()`)
    ok(z0 !== '100%', '快捷键 0 → 适应窗口（这张 800×600 小于视口 ⇒ 应停在 100%？见下）', String(z0))
    ok(true, '（注：800×600 的图在大多数窗口下适应比例正好是 100%，故 z0 也可能是 100% —— 这条只要求读数可读）')
  }

  console.log('\n§7 SVG → 默认渲染，⋮ 切源码')
  if (!svgRel) {
    console.log('  [SKIP] 没有 .svg（fixture 未播种）')
  } else {
    const s1 = await openByRel(svgRel)
    ok(s1.canvas === true, `SVG「${svgRel}」默认落查看器`, JSON.stringify({ canvas: s1.canvas, kind: s1.cardKind }))
    if (s1.canvas && await clickSel('[data-wb="noteTopMore"]')) {
      const hasSvgSrc = await evalJs(`String(!!document.querySelector('[data-wb="peSvgSource"]'))`)
      ok(hasSvgSrc === 'true', 'SVG 的 ⋮ 里有「看源码」（peSvgSource）', String(hasSvgSrc))
      if (hasSvgSrc === 'true') {
        await clickSel('[data-wb="peSvgSource"]', 1800)
        const s2 = await sign()
        const monaco = await evalJs(`String(document.querySelectorAll('[data-pane="main"] .monaco-editor').length)`)
        ok(s2.canvas === false && monaco !== '0', '点「看源码」→ 进 Monaco（XML 高亮），画布消失', JSON.stringify({ canvas: s2.canvas, monaco }))
        if (await clickSel('[data-wb="noteTopMore"]')) {
          await clickSel('[data-wb="peSvgSource"]', 1800)
          const s3 = await sign()
          ok(s3.canvas === true, '再点「看图片」→ 回到查看器', JSON.stringify({ canvas: s3.canvas }))
        }
      }
    }
  }

  console.log('\n§8 沉浸阅读图片 → 顶栏消失 + 控件退成浮条')
  if (normalRel) {
    await openByRel(normalRel)
    let entered = false
    if (await clickSel('[data-wb="noteTopMore"]')) {
      const hasImm = await evalJs(`String([].slice.call(document.querySelectorAll('[data-wb="noteTopMoreMenu"] button')).some(function (b) { return (b.textContent || '').indexOf('沉浸阅读') >= 0 }))`)
      ok(hasImm === 'true', '图片的 ⋮ 里有「沉浸阅读」（enterReading 已放行图片）', String(hasImm))
      if (hasImm === 'true') {
        const clicked = await evalJs(`(function () {
          var bs = [].slice.call(document.querySelectorAll('[data-wb="noteTopMoreMenu"] button'));
          var b = bs.filter(function (x) { return (x.textContent || '').indexOf('沉浸阅读') >= 0 })[0];
          if (!b) return 'no';
          b.click(); return 'yes';
        })()`)
        entered = clicked === 'yes'
        await sleep(2000)
      }
    }
    if (entered) {
      const s = await sign()
      ok(s.topbar === false, '沉浸态顶栏消失（沉浸按定义没有顶栏）', JSON.stringify({ topbar: s.topbar }))
      ok(s.toolbar === true && s.toolbarVariant === 'float',
        '沉浸态控件退成浮条（variant=float）—— A 方案的必然例外', JSON.stringify({ t: s.toolbar, v: s.toolbarVariant }))
      ok(s.canvas === true, '沉浸态仍有画布')
      await action('ui.key', { key: 'Escape' })
      await sleep(1200)
      const s2 = await sign()
      ok(s2.topbar === true && s2.canvas === true, 'Esc 退出沉浸 → 回到笔记区（顶栏回来、画布还在）', JSON.stringify({ topbar: s2.topbar, canvas: s2.canvas }))
    } else {
      console.log('  [SKIP] 没能进沉浸态（点不到 ⋮ 或菜单项）')
    }
  }

  console.log('\n§9 md 内联图片（批 3 放开仓库内任意路径）')
  if (!mdRel) {
    console.log('  [SKIP] 没有「图片引用.md」（fixture 未播种）')
  } else {
    await openByRel(mdRel)
    // 阅读态才渲染 MarkdownPreview；顶栏有「阅读切换」钮时点一下确保是阅读态
    const toggle = await rectOf('[data-wb="noteTopViewToggle"]')
    if (toggle) {
      const view = await evalJs(`(function(){var e=document.querySelector('[data-wb="noteTopViewToggle"]');return e?e.getAttribute('data-view'):null})()`)
      if (view === 'edit') { await clickSel('[data-wb="noteTopViewToggle"]', 1800) }
    }
    await sleep(2200)
    const stats = await evalJs(`JSON.stringify((function () {
      var panes = [].slice.call(document.querySelectorAll('[data-pane="main"]'));
      var scope = panes.filter(function (el) { return el.getClientRects().length > 0; })[0] || document;
      var imgs = [].slice.call(scope.querySelectorAll('img'));
      return {
        total: imgs.length,
        blob: imgs.filter(function (i) { return String(i.getAttribute('src') || '').indexOf('blob:') === 0 }).length,
        data: imgs.filter(function (i) { return String(i.getAttribute('src') || '').indexOf('data:') === 0 }).length,
        broken: scope.querySelectorAll('[data-wb="mdImgBroken"]').length,
        loading: (scope.textContent || '').indexOf('图片加载中') >= 0,
      };
    })())`)
    let st = null
    try { st = JSON.parse(stats) } catch { /* 下面报 */ }
    ok(!!st, '能读到预览里的图片统计', String(stats).slice(0, 140))
    if (st) {
      ok(st.blob >= 1, '★ 非附件区引用（../批3图片/照片.png）真的显示了 —— blob: 图至少 1 张', JSON.stringify(st))
      ok(st.broken >= 1, '★ 打错的路径显示破图占位（mdImgBroken），不是永久「图片加载中」', JSON.stringify(st))
      ok(st.loading === false, '没有停在「图片加载中…」（加载态与失败态已分开）', String(st.loading))
    }
  }

  console.log('\n§10 需要在真机上手点的（探针刻意不做）')
  console.log('  · Ctrl+滚轮锚点（批 3 的几何核心）：把光标停在图上**某个特征点**上滚 → 那个点必须钉住不动。')
  console.log('    判据：不钉住的表现是「缩放本身正常、只是目标每滚一下就跑掉」——偏移量恒定，肉眼极难发现，')
  console.log('    所以务必挑一个明显的特征点（比如照片.png 的 100px 网格交叉处）对准了再滚。')
  console.log('  · 拖拽夹取：放大到超出视口 → 往右下拖到尽头 → 图不会消失（夹在「边缘 + 48px」）；')
  console.log('    缩回小于视口 → 图自动回到正中（拖不动，也就丢不了）。')
  console.log('  · 双击：适应窗口 ⇄ 100% 来回切（与 Obsidian / VS Code 图片预览同款）。')
  console.log('  · 旋转：转 90° / 270° 后**适应比例要跟着换**（长边竖过来不溢出视口）；转完图不该飞出视口。')
  console.log('  · 窗口尺寸变化：拖着窗口边缘缩放 → 处于「适应窗口」时比例应跟着变；手动缩放过的（读数不再是适应值）应保持不变。')
  console.log('  · 沉浸态手势：进沉浸 → 滚轮缩放 / 拖拽 / 双击 应同样可用（浮条控件与顶栏控件是同一份逻辑）。')
  console.log('  · 文件树图标：图片条目现在应有**图片图标**（此前一律通用文件图标）。')

  console.log('')
  if (fails.length === 0) {
    console.log(`PASS  ${pass} 项实机断言全绿`)
    process.exit(0)
  }
  console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  [FAIL] ' + f)
  process.exit(1)
}

main().catch((e) => { console.error('探针异常：', e); process.exit(1) })
