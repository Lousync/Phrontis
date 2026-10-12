/**
 * 批 1 实机探针（dev bridge 版，**只读**）
 * 方案：`docs/knowledge-content-routing-design.md`；契约：`verify-content-routing.mjs`（64 项）
 *
 * 为什么要有它：契约只能证明**源码接线**是对的，证不了「真跑起来落点对不对」。
 * 这个项目的既有教训（2026-10-12 页面分屏）：40 条源码断言全绿，真机上副栏塌成横条。
 * 批 1 的核心恰恰是「落点」——必须真机看一眼。
 *
 * 与 `.AGENT/scripts/notes-surface/probe-note-surface.mjs` 的区别：
 *   那条走「隔离实例 + CDP + out/ 产物」（需要先 `npm run build`），本机沙箱起不了 Electron；
 *   本条走 **dev bridge**（`npm run dev` 时主进程在 7465 上开的调试桥），只要 dev 在跑就能用。
 *
 * 用法：
 *   1) 另开一个终端：`npm run dev`（端口 7173；启动前删掉 ELECTRON_RUN_AS_NODE）
 *   2) `node .AGENT/scripts/knowledge-content-routing/probe-content-routing.mjs`
 *
 * ★ 本探针**只做读取与开页签**：不模拟输入、不写盘、不改你的仓库文件。
 *   它会打开若干页签（停在最后一个），看完手动关掉即可。
 *   写入往返（改一个字 → 自动保存 → 读回 → 还原）刻意**没有**做：那需要模拟键盘输入，
 *   焦点一旦落错就会把垃圾打进你的真实文件。要验写通道请手点（见文件末尾的清单）。
 */
const PORT = Number(process.env.BRIDGE_PORT ?? 7465)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
const fails = []
const info = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`  [OK]   ${label}${detail ? '  —— ' + detail : ''}`); return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  console.log(`  [FAIL] ${label}${detail ? '  —— ' + detail : ''}`)
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

/** 跑一段渲染层代码并取回它的返回值（桥的返回结构见 devbridge） */
async function evalJs(code) {
  const r = await action('ui.eval', { code })
  return r?.data?.result?.result ?? null
}

/** 取某选择器**首个可见**元素的中心坐标（桥的 `ui.click` 要坐标，不是选择器） */
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

/** 点某个选择器（真鼠标事件，非合成 DOM 事件）；找不到就返回 false，让调用方 **SKIP 而不是 FAIL** */
async function clickSel(sel, waitMs = 700) {
  const r = await rectOf(sel)
  if (!r) return false
  await action('ui.click', { x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(waitMs)
  return true
}

/** ⋮ 菜单开合后的锚点在场情况（组 C/D 的判据） */
const MENU_STATE = `JSON.stringify((function () {
  var has = function (s) { return !!document.querySelector(s) };
  return {
    more: has('[data-wb="noteTopMore"]'),
    info: has('[data-wb="peFileInfo"]'),
    openSys: has('[data-wb="peOpenInSystem"]'),
    reveal: has('[data-wb="peRevealInFolder"]'),
    copy: has('[data-wb="peCopyRelPath"]'),
    htmlSrc: has('[data-wb="peHtmlSource"]'),
    /* 批 3（2026-10-13）新增 */
    svgSrc: has('[data-wb="peSvgSource"]'),
    menuFit: has('[data-wb="imgMenuFit"]'),
    menuActual: has('[data-wb="imgMenuActual"]'),
    menuRotL: has('[data-wb="imgMenuRotateL"]'),
    menuRotR: has('[data-wb="imgMenuRotateR"]'),
    infoCard: has('[data-wb="peFileInfoCard"]'),
  };
})())`

async function menuState() {
  const raw = await evalJs(MENU_STATE)
  try { return JSON.parse(raw) } catch { return null }
}

/** 当前可见主栏内的落点签名 —— 全部用稳定的 DOM 事实，不依赖文案 */
const SIGNATURE = `JSON.stringify((function () {
  var panes = [].slice.call(document.querySelectorAll('[data-pane="main"]'));
  var scope = panes.filter(function (el) { return el.getClientRects().length > 0; })[0] || document;
  var q = function (s) { return scope.querySelector(s); };
  var monaco = scope.querySelectorAll('.monaco-editor').length;
  var banner = !!q('[data-wb="archiveViewBanner"]');
  var topbar = !!q('[data-wb="noteTopBar"]');
  /* 批 2（2026-10-12）适配：顶栏现在对**所有非导图类型**都挂（非 md 的悬浮胶囊已退役）
     ⇒ **不能再用「有顶栏」当 md 的判据**。换成顶栏里的「阅读切换」钮 ——
     它的门槛是 showViewToggle = isMdNote，只有 md 有。 */
  var isMd = topbar && !!q('[data-wb="noteTopViewToggle"]');
  var pdf = !!q('.kb-pdf-scope');
  var meta = !!q('[data-wb="metaOpenInSystem"]');
  /* 图片（批 3，2026-10-13）：真渲染出来是 imageCanvas；过大 / 解码失败落 imgStateCard。
     两者都是「图片落点」，但必须分开报 —— 混成一个 kind 就分不清
     「查看器没接上」和「这张图确实超限了」。 */
  var imgCanvas = !!q('[data-wb="imageCanvas"]');
  var imgCard = q('[data-wb="imgStateCard"]');
  var frame = q('iframe[src^="kbview://"]');
  var kind = 'unknown';
  if (pdf) kind = 'pdf-reader';
  else if (imgCanvas) kind = 'image-viewer';
  else if (imgCard) kind = 'image-blocked';
  else if (meta) kind = 'meta-card';
  else if (frame) kind = 'html-sandbox';
  else if (monaco > 0) kind = isMd ? 'md-editor' : (banner ? 'text-oversize-readonly' : 'text-editable');
  return {
    kind: kind, monaco: monaco, banner: banner, topbar: topbar, isMd: isMd,
    pdf: pdf, meta: meta, iframe: !!frame,
    imageCanvas: imgCanvas,
    imageBlocked: imgCard ? (imgCard.getAttribute('data-kind') || '1') : null,
    imgToolbar: !!q('[data-wb="imageToolbar"]'),
    imgToolbarVariant: (q('[data-wb="imageToolbar"]') || {}).getAttribute
      ? (q('[data-wb="imageToolbar"]') || {}).getAttribute('data-variant') : null,
    imgZoom: (q('[data-wb="imgZoomLevel"]') || {}).textContent || null,
    title: (q('[data-wb="noteTopTitle"]') || {}).textContent || null,
    subtitle: (q('[data-wb="noteTopSubtitle"]') || {}).textContent || null,
    saveDot: !!q('[data-wb="noteSaveDot"]'),
    viewToggle: !!q('[data-wb="noteTopViewToggle"]'),
    floatBar: document.querySelectorAll('[data-wb="floatBar"]').length,
  };
})())`

/** 列出仓库里的非 md 文件（entryKind:'file'）—— 按扩展名分类 */
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

async function openByRel(rel) {
  await evalJs(`window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: ${JSON.stringify(rel)}, from: 'knowledge' } }))`)
  await sleep(2600)
  const raw = await evalJs(SIGNATURE)
  try { return JSON.parse(raw) } catch { return { kind: 'unknown', parseError: String(raw).slice(0, 120) } }
}

const pick = (by, exts) => {
  for (const e of exts) if (by[e] && by[e].length) return by[e][0]
  return null
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

  console.log('\n§1 列出仓库内的非 md 文件（entryKind:file）')
  const listed = await evalJs(LIST_FILES)
  let parsed = null
  try { parsed = JSON.parse(listed) } catch { /* 下面报 */ }
  ok(!!parsed && !parsed.error, '能读到知识库条目列表', parsed?.error ? String(parsed.error) : '')
  if (!parsed || parsed.error) { process.exit(1) }

  const by = parsed.by || {}
  const exts = Object.keys(by).sort()
  info.push(`仓库内非 md 文件 ${parsed.total} 个，扩展名：${exts.join(', ') || '（无）'}`)
  console.log(`  ${info[info.length - 1]}`)

  const targets = [
    ['PDF', pick(by, ['pdf']), 'pdf-reader', '★ 本轮核心：此前被归档兜底遮蔽，只会出现元信息卡'],
    ['文本类', pick(by, ['py', 'js', 'ts', 'txt', 'csv', 'json', 'log', 'md']), 'text-editable', '★ 本轮核心：此前是「元信息卡 → 查看内容」两跳 + 只读'],
    ['HTML', pick(by, ['html']), 'html-sandbox', '归档 html 走沙箱渲染'],
  ]

  console.log('\n§2 逐个打开并核对落点')
  const opened = []
  for (const [label, rel, expect, why] of targets) {
    if (!rel) {
      console.log(`  [SKIP] ${label}：仓库里没有这类文件（换一个有 pdf/py/txt/csv/html 的仓库再跑）`)
      continue
    }
    const sig = await openByRel(rel)
    opened.push(`${label}: ${rel} → ${sig.kind}`)
    ok(sig.kind === expect, `${label}「${rel}」落点 = ${expect}`, `实际 ${sig.kind}${why ? ' · ' + why : ''}`)
  }

  console.log('\n§3 图片应落查看器、二进制仍落元信息卡')
  /* 批 3（2026-10-13）改了这一条：此前图片期望 meta-card，现在真渲染。
     若这张图超过 32MB 或 1 亿像素，落点会是 image-blocked（那是对的，不是回归）——
     故下面把两种都接受，但要求「至少不是 meta-card」。 */
  const imgRel = pick(by, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'])
  const binRel = pick(by, ['zip', '7z', 'exe', 'dat', 'bin'])
  if (imgRel) {
    const sig = await openByRel(imgRel)
    opened.push(`图片: ${imgRel} → ${sig.kind}`)
    ok(sig.kind === 'image-viewer' || sig.kind === 'image-blocked',
      `图片「${imgRel}」落点 = 图片查看器（批 3；超限/损坏时落 image-blocked）`,
      `实际 ${sig.kind}${sig.imageBlocked ? '（data-kind=' + sig.imageBlocked + '）' : ''}`)
    if (sig.kind === 'image-viewer') {
      ok(sig.imgToolbar === true, '图片顶栏里有控件簇（imageToolbar）')
      ok(sig.imgToolbarVariant === 'inline', '笔记区控件簇是 inline 变体（拍板 D7 顶栏内联）', String(sig.imgToolbarVariant))
      ok(/^\d+%$/.test(sig.imgZoom || ''), '控件簇里有缩放百分比读数', String(sig.imgZoom))
      ok(/^\d+ × \d+$/.test(sig.subtitle || ''), '顶栏中段是「宽 × 高」像素尺寸', String(sig.subtitle))
      ok(sig.saveDot === false, '图片不显示保存点（无保存动作 ⇒ 绿点是假信号）')
    }
  } else {
    console.log('  [SKIP] 图片：仓库里没有图片文件（换一个有 png/jpg 的仓库再跑）')
  }
  if (binRel) {
    const sig = await openByRel(binRel)
    opened.push(`二进制: ${binRel} → ${sig.kind}`)
    ok(sig.kind === 'meta-card', `二进制「${binRel}」落点 = meta-card`, `实际 ${sig.kind}`)
  } else {
    console.log('  [SKIP] 二进制：仓库里没有这类文件')
  }

  console.log('\n§3.5 ⋮「文件」组（非 md 才有；自动点开菜单核对）')
  {
    const textRel = pick(by, ['py', 'js', 'ts', 'txt', 'csv', 'json'])
    if (!textRel) {
      console.log('  [SKIP] 文本类：仓库里没有这类文件')
    } else {
      await openByRel(textRel)
      const menuOpened = await clickSel('[data-wb="noteTopMore"]')
      if (!menuOpened) {
        console.log('  [SKIP] 点不到 ⋮（找不到可见的 [data-wb="noteTopMore"]）—— 当前页很可能不是非 md 落点')
      } else {
        const m = await menuState()
        ok(!!m, 'C1 能读到 ⋮ 菜单状态', String(m))
        ok(!!(m?.info && m?.openSys && m?.reveal && m?.copy),
          'C2 ⋮ 里有「文件」组四项（文件信息 / 在系统中打开 / 在文件夹中显示 / 复制相对路径）',
          JSON.stringify(m))
        ok(!!m && !m.htmlSrc, 'C3 文本类不该出现「看源码」（那是 html 专有）')
        if (m?.info) {
          const clicked = await clickSel('[data-wb="peFileInfo"]')
          const m2 = await menuState()
          ok(clicked && !!m2?.infoCard, 'C4 点「文件信息」→ 小卡出现（peFileInfoCard）')
          await clickSel('[data-wb="peFileInfoCard"] button', 300)   // 关闭小卡
        }
      }
    }
  }

  console.log('\n§3.6 html 源码 ⇄ 渲染（自动点）')
  {
    const htmlRel = pick(by, ['html'])
    if (!htmlRel) {
      console.log('  [SKIP] HTML：仓库里没有 .html 文件')
    } else {
      const sig1 = await openByRel(htmlRel)
      ok(sig1.kind === 'html-sandbox', `D1 html 默认落沙箱渲染（${htmlRel}）`, `实际 ${sig1.kind}`)
      const menuOpened = await clickSel('[data-wb="noteTopMore"]')
      const m = menuOpened ? await menuState() : null
      ok(!!m?.htmlSrc, 'D2 ⋮ 里有「看源码」（peHtmlSource）')
      if (m?.htmlSrc) {
        await clickSel('[data-wb="peHtmlSource"]', 1600)
        let p2 = null
        try { p2 = JSON.parse(await evalJs(SIGNATURE)) } catch { /* 下面按 null 报 */ }
        ok(p2?.kind === 'text-editable', 'D3 点「看源码」→ 进可编辑源码（Monaco，无沙箱 iframe）', `实际 ${p2?.kind}`)
        const reopened = await clickSel('[data-wb="noteTopMore"]')
        if (reopened) {
          await clickSel('[data-wb="peHtmlSource"]', 1800)
          let p3 = null
          try { p3 = JSON.parse(await evalJs(SIGNATURE)) } catch { /* 同上 */ }
          ok(p3?.kind === 'html-sandbox', 'D4 再点「看渲染」→ 回到沙箱渲染', `实际 ${p3?.kind}`)
        }
      }
    }
  }

  console.log('\n§3.7 批 2 统一顶栏（非 md 也挂顶栏 + 胶囊退役 + 保存点条件）')
  {
    const cases = [
      ['PDF', pick(by, ['pdf']), true, '批 2「合并公共部分」：页数上移顶栏中段'],
      ['文本类', pick(by, ['py', 'js', 'ts', 'txt', 'csv', 'log']), false, '有真实防抖自动保存 ⇒ 绿点保留'],
      ['HTML', pick(by, ['html']), false, '沙箱渲染，无保存动作'],
      ['图片', imgRel, false, '批 3：真渲染进查看器，无保存动作'],
      ['二进制', binRel, false, '无保存动作'],
    ]
    for (const [label, rel, expectPages, why] of cases) {
      if (!rel) { console.log(`  [SKIP] ${label}：仓库里没有这类文件`); continue }
      const sig = await openByRel(rel)
      ok(sig.floatBar === 0, `T ${label} 悬浮胶囊已退役（floatBar 计数 0）`, `实际 ${sig.floatBar}`)
      ok(sig.topbar === true, `T ${label} 非 md 也挂统一顶栏（noteTopBar）`,
        JSON.stringify({ kind: sig.kind, topbar: sig.topbar }))
      ok(sig.viewToggle === false, `T ${label} 不给「阅读切换」钮（非 md 无预览态 ⇒ 给了是点了没反应的假按钮）`)
      const expectDot = sig.kind === 'text-editable'
      ok(sig.saveDot === expectDot,
        `T ${label} 保存点${expectDot ? '显示' : '隐藏'}（批 2 拍板①：只对有真实保存动作的类型显示）· ${why}`,
        JSON.stringify({ kind: sig.kind, saveDot: sig.saveDot }))
      if (expectPages) ok(/页$/.test(sig.subtitle || ''), `T ${label} 顶栏中段带「N 页」`, String(sig.subtitle))
    }
    // ⋮ 里**不给**「文件格式」（批 2 的范围锁）
    const fmtRel = pick(by, ['py', 'js', 'ts', 'txt', 'csv', 'log'])
    if (fmtRel) {
      await openByRel(fmtRel)
      if (await clickSel('[data-wb="noteTopMore"]')) {
        const hasFmt = await evalJs(`String([].slice.call(document.querySelectorAll('[data-wb="noteTopMoreMenu"] button')).some(function (b) { return (b.textContent || '').indexOf('文件格式') >= 0 }))`)
        ok(hasFmt === 'false' || hasFmt === false,
          'T 非 md 的 ⋮ 不给「文件格式」（只改内存不落盘 + 扩展名来自文件名 ⇒ 重启即失效的假按钮）',
          String(hasFmt))
      }
    }
  }

  console.log('\n§3.8 批 3 图片查看器（⋮ 查看组 / 缩放 / SVG 源码态）')
  {
    if (!imgRel) {
      console.log('  [SKIP] 图片：仓库里没有图片文件')
    } else {
      const sig = await openByRel(imgRel)
      if (sig.kind !== 'image-viewer') {
        console.log(`  [SKIP] 「${imgRel}」落点是 ${sig.kind}（超限或解码失败）—— 查看器交互无法验`)
      } else {
        // ⋮ 里的「查看」组（拍板 D10）
        if (await clickSel('[data-wb="noteTopMore"]')) {
          const m = await menuState()
          ok(!!(m?.menuFit && m?.menuActual && m?.menuRotL && m?.menuRotR),
            'I1 ⋮ 里有「查看」组四项（适应窗口 / 实际大小 / 向左旋转 / 向右旋转）', JSON.stringify(m))
          ok(!!m && !m.svgSrc, 'I2 非 SVG 的图片不该出现「看源码」')
          // 点「实际大小」→ 缩放读数应变成 100%
          if (m?.menuActual) {
            await clickSel('[data-wb="imgMenuActual"]', 700)
            const z = await evalJs(`(function(){var e=document.querySelector('[data-wb="imgZoomLevel"]');return e?e.textContent:null})()`)
            ok(z === '100%', 'I3 点「实际大小」→ 缩放读数 = 100%', String(z))
            if (await clickSel('[data-wb="noteTopMore"]')) {
              await clickSel('[data-wb="imgMenuFit"]', 700)
              const z2 = await evalJs(`(function(){var e=document.querySelector('[data-wb="imgZoomLevel"]');return e?e.textContent:null})()`)
              ok(z2 !== null && z2 !== '100%', 'I4 点「适应窗口」→ 读数不再停在 100%（这张图大于视口）', String(z2))
            }
          }
          // 旋转：画布上的旋转层 transform 应变成 rotate(90deg)
          if (await clickSel('[data-wb="noteTopMore"]')) {
            if (await clickSel('[data-wb="imgMenuRotateR"]', 600)) {
              const rot = await evalJs(`(function(){var e=document.querySelector('.kb-img-rot');return e?e.style.transform:null})()`)
              ok(/rotate\(90deg\)/.test(String(rot)), 'I5 点「向右旋转」→ 旋转层 transform = rotate(90deg)', String(rot))
            }
          }
        } else {
          console.log('  [SKIP] 点不到 ⋮')
        }
        // 快捷键：0 适应窗口 / 1 实际大小（无修饰键）
        await action('ui.key', { key: '1' })
        await sleep(500)
        const z3 = await evalJs(`(function(){var e=document.querySelector('[data-wb="imgZoomLevel"]');return e?e.textContent:null})()`)
        ok(z3 === '100%', 'I6 快捷键 1 → 实际大小 100%（无修饰键，不占应用级 UI 缩放）', String(z3))
        await action('ui.key', { key: '0' })
        await sleep(500)
        const z4 = await evalJs(`(function(){var e=document.querySelector('[data-wb="imgZoomLevel"]');return e?e.textContent:null})()`)
        ok(z4 !== '100%', 'I7 快捷键 0 → 适应窗口', String(z4))
      }
    }
  }

  console.log('\n§3.9 批 3 SVG 双落点（默认渲染 + ⋮ 切源码）')
  {
    const svgRel = pick(by, ['svg'])
    if (!svgRel) {
      console.log('  [SKIP] SVG：仓库里没有 .svg 文件')
    } else {
      const s1 = await openByRel(svgRel)
      ok(s1.kind === 'image-viewer' || s1.kind === 'image-blocked',
        `SVG 默认落图片查看器（${svgRel}）`, `实际 ${s1.kind}`)
      if (s1.kind === 'image-viewer' && await clickSel('[data-wb="noteTopMore"]')) {
        const m = await menuState()
        ok(!!m?.svgSrc, 'J1 SVG 的 ⋮ 里有「看源码」（peSvgSource）')
        if (m?.svgSrc) {
          await clickSel('[data-wb="peSvgSource"]', 1800)
          let s2 = null
          try { s2 = JSON.parse(await evalJs(SIGNATURE)) } catch { /* 下面按 null 报 */ }
          ok(s2?.kind === 'text-editable', 'J2 点「看源码」→ 进可编辑 Monaco（XML 高亮）', `实际 ${s2?.kind}`)
          if (await clickSel('[data-wb="noteTopMore"]')) {
            await clickSel('[data-wb="peSvgSource"]', 1800)
            let s3 = null
            try { s3 = JSON.parse(await evalJs(SIGNATURE)) } catch { /* 同上 */ }
            ok(s3?.kind === 'image-viewer', 'J3 再点「看图片」→ 回到查看器', `实际 ${s3?.kind}`)
          }
        }
      }
    }
  }

  console.log('\n§4 落点汇总')
  for (const o of opened) console.log('  · ' + o)

  console.log('\n§5 需要在真机上手点的（探针刻意不做）')
  console.log('  · 写通道（批 1）：打开一个 .py/.txt，改一个字 → **顶栏中段绿点**转橙再转绿 → 关掉再打开，改动还在')
  console.log('    （判定依据：保存走 ws:writeFile，非 md 不注入 frontmatter —— 打开文件确认没有多出 --- 头）')
  console.log('  · 沉浸阅读（批 1）：打开仓库里的 .txt → 顶栏 ⋮ → 沉浸阅读 → 应显示只读正文，**不是**「该文件不是 markdown 知识页」的卡')
  console.log('  · PDF 沉浸（批 2）：打开仓库里的 PDF → 阅读器那条栏点「沉浸」→ **顶栏也要一起消失**（正文占满）；Esc 退出后顶栏回来，且**页面页签不该被关掉**（批 2 顺带修的 Esc 冲突，见设计 §4.4）')
  console.log('  · PDF 合并（批 2）：同页核对「书名只出现一次」—— 顶栏中段是书名 + N 页，阅读器那条只剩阅读控件')
  console.log('  · 分屏（批 2）：把非 md 拖到副栏 → **两栏各挂各的顶栏**（与 Obsidian 同款），互不抢槽')
  console.log('  · 图片手势（批 3）：打开一张 png → Ctrl+滚轮在图上滚 → **光标下那个像素钉住不动**（不是整体平移）；')
  console.log('    拖拽到边缘 → 图不会丢（夹在「边缘 + 48px」）；双击 → 适应窗口 ⇄ 100% 来回切；')
  console.log('    [ ] 旋转 → 90/270 时适应比例跟着换（长边竖过来不溢出）；png 的透明区应露出**棋盘格**底，jpg 则是纯色')
  console.log('  · 图片沉浸（批 3）：图片 → ⋮ → 沉浸阅读 → 控件退成右下角浮条（沉浸态没有顶栏）；Esc 退出后回到笔记区')
  console.log('  · md 内联图片（批 3）：在一个 .md 里写 `![](图片/你的图.png)`（**非** .attachments/ 路径）→ 阅读态应能显示；')
  console.log('    引用一个不存在的路径 → 应显示破图占位而不是把整页搞坏')

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
