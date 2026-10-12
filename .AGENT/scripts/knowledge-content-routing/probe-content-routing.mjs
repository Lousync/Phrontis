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
    more: has('[data-wb="peMore"]'),
    info: has('[data-wb="peFileInfo"]'),
    openSys: has('[data-wb="peOpenInSystem"]'),
    reveal: has('[data-wb="peRevealInFolder"]'),
    copy: has('[data-wb="peCopyRelPath"]'),
    htmlSrc: has('[data-wb="peHtmlSource"]'),
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
  var pdf = !!q('.kb-pdf-scope');
  var meta = !!q('[data-wb="metaOpenInSystem"]');
  var frame = q('iframe[src^="kbview://"]');
  var kind = 'unknown';
  if (pdf) kind = 'pdf-reader';
  else if (meta) kind = 'meta-card';
  else if (frame) kind = 'html-sandbox';
  else if (monaco > 0) kind = topbar ? 'md-editor' : (banner ? 'text-oversize-readonly' : 'text-editable');
  return {
    kind: kind, monaco: monaco, banner: banner, topbar: topbar,
    pdf: pdf, meta: meta, iframe: !!frame,
    title: (q('[data-wb="noteTopTitle"]') || {}).textContent || null,
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

  console.log('\n§3 图片与二进制应仍落元信息卡（批 3 之前的行为）')
  const imgRel = pick(by, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
  const binRel = pick(by, ['zip', '7z', 'exe', 'dat', 'bin'])
  for (const [label, rel] of [['图片', imgRel], ['二进制', binRel]]) {
    if (!rel) { console.log(`  [SKIP] ${label}：仓库里没有这类文件`); continue }
    const sig = await openByRel(rel)
    opened.push(`${label}: ${rel} → ${sig.kind}`)
    ok(sig.kind === 'meta-card', `${label}「${rel}」落点 = meta-card（批 3 会把图片改成渲染）`, `实际 ${sig.kind}`)
  }

  console.log('\n§3.5 ⋮「文件」组（非 md 才有；自动点开菜单核对）')
  {
    const textRel = pick(by, ['py', 'js', 'ts', 'txt', 'csv', 'json'])
    if (!textRel) {
      console.log('  [SKIP] 文本类：仓库里没有这类文件')
    } else {
      await openByRel(textRel)
      const menuOpened = await clickSel('[data-wb="peMore"]')
      if (!menuOpened) {
        console.log('  [SKIP] 点不到 ⋮（找不到可见的 [data-wb="peMore"]）—— 当前页很可能不是非 md 落点')
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
      const menuOpened = await clickSel('[data-wb="peMore"]')
      const m = menuOpened ? await menuState() : null
      ok(!!m?.htmlSrc, 'D2 ⋮ 里有「看源码」（peHtmlSource）')
      if (m?.htmlSrc) {
        await clickSel('[data-wb="peHtmlSource"]', 1600)
        let p2 = null
        try { p2 = JSON.parse(await evalJs(SIGNATURE)) } catch { /* 下面按 null 报 */ }
        ok(p2?.kind === 'text-editable', 'D3 点「看源码」→ 进可编辑源码（Monaco，无沙箱 iframe）', `实际 ${p2?.kind}`)
        const reopened = await clickSel('[data-wb="peMore"]')
        if (reopened) {
          await clickSel('[data-wb="peHtmlSource"]', 1800)
          let p3 = null
          try { p3 = JSON.parse(await evalJs(SIGNATURE)) } catch { /* 同上 */ }
          ok(p3?.kind === 'html-sandbox', 'D4 再点「看渲染」→ 回到沙箱渲染', `实际 ${p3?.kind}`)
        }
      }
    }
  }

  console.log('\n§4 落点汇总')
  for (const o of opened) console.log('  · ' + o)

  console.log('\n§5 需要在真机上手点的两条（探针刻意不做）')
  console.log('  · 写通道：打开一个 .py/.txt，改一个字 → 右上绿点转橙再转绿 → 关掉再打开，改动还在')
  console.log('    （判定依据：保存走 ws:writeFile，非 md 不注入 frontmatter —— 打开文件确认没有多出 --- 头）')
  console.log('  · 沉浸阅读：打开仓库里的 .txt → 胶囊 ⋮ → 沉浸阅读 → 应显示只读正文，**不是**「该文件不是 markdown 知识页」的卡')

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
