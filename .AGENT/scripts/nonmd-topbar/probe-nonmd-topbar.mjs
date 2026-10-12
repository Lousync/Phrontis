/**
 * 批 2 实机探针（dev bridge 版，**只读 + 只按键，不写盘**）
 * 设计：`docs/nonmd-topbar-design.md` · 契约：`verify-nonmd-topbar.mjs`（54 项）
 *
 * 为什么要有它：契约只能证明**源码接线**是对的，证不了「真跑起来是不是真的只有一条顶栏」。
 * 批 2 的核心恰恰是**形态**（两套按钮 → 一套、书名出现两次 → 一次、沉浸时顶栏跟不跟着走），
 * 这些只有真机 DOM 才说得清。
 *
 * 与 `.AGENT/scripts/notes-surface/probe-note-surface.mjs` 的区别：
 *   那条走「隔离实例 + CDP + out/ 产物」（需要先 `npm run build`），本机沙箱起不了 Electron；
 *   本条走 **dev bridge**（`npm run dev` 时主进程在 7465 上开的调试桥），只要 dev 在跑就能用。
 *
 * 用法：
 *   1) 另开一个终端：`npm run dev`（端口 7173；启动前删掉 ELECTRON_RUN_AS_NODE）
 *   2) `node .AGENT/scripts/nonmd-topbar/probe-nonmd-topbar.mjs`
 *
 * ★ 本探针**不模拟打字、不写盘**：唯一注入的按键是 `Escape`（用来验 §2 的沉浸退出），
 *   它不会把任何字符写进你的文件。会打开若干页签（停在最后一个），看完手动关掉即可。
 */
const PORT = Number(process.env.BRIDGE_PORT ?? 7465)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
const fails = []
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

async function evalJs(codeStr) {
  const r = await action('ui.eval', { code: codeStr })
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

/** 点某个选择器（真鼠标事件）；找不到返回 false，让调用方 **SKIP 而不是 FAIL** */
async function clickSel(sel, waitMs = 700) {
  const r = await rectOf(sel)
  if (!r) return false
  await action('ui.click', { x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await sleep(waitMs)
  return true
}

/** 主栏可见范围内的顶栏形态 —— 全部是稳定 DOM 事实，不依赖文案 */
const TOPSTATE = `JSON.stringify((function () {
  var panes = [].slice.call(document.querySelectorAll('[data-pane="main"]'));
  var scope = panes.filter(function (el) { return el.getClientRects().length > 0; })[0] || document;
  var q = function (s) { return scope.querySelector(s) };
  var readerBar = q('.kb-fit-pdfread');
  return {
    topbar: !!q('[data-wb="noteTopBar"]'),
    title: (q('[data-wb="noteTopTitle"]') || {}).textContent || '',
    subtitle: (q('[data-wb="noteTopSubtitle"]') || {}).textContent || null,
    saveDot: !!q('[data-wb="noteSaveDot"]'),
    viewToggle: !!q('[data-wb="noteTopViewToggle"]'),
    more: !!q('[data-wb="noteTopMore"]'),
    floatBar: document.querySelectorAll('[data-wb="floatBar"]').length,
    slot: !!document.getElementById('editor-toolbar-slot'),
    pdf: !!q('.kb-pdf-scope'),
    readerBarText: readerBar ? (readerBar.textContent || '') : null,
    monaco: scope.querySelectorAll('.monaco-editor').length,
    tabs: [].slice.call(document.querySelectorAll('[data-wb="pagebar"] [data-tab-id]')).length
  };
})())`

async function topState() {
  const raw = await evalJs(TOPSTATE)
  try { return JSON.parse(raw) } catch { return { parseError: String(raw).slice(0, 160) } }
}

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
  return await topState()
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
  console.log(`  仓库内非 md 文件 ${parsed.total} 个，扩展名：${Object.keys(by).sort().join(', ') || '（无）'}`)

  console.log('\n§2 PDF：一条顶栏 + 阅读器那条只留阅读控件 + 沉浸时顶栏跟着走')
  const pdfRel = pick(by, ['pdf'])
  if (!pdfRel) {
    console.log('  [SKIP] PDF：仓库里没有 .pdf 文件（放一本进仓库再跑，或用批 1 的播种脚本）')
  } else {
    const s1 = await openByRel(pdfRel)
    ok(s1.pdf === true, `打开了 PDF 阅读器（${pdfRel}）`, JSON.stringify({ pdf: s1.pdf, kind: s1.monaco }))
    ok(s1.floatBar === 0 && s1.slot === false,
      'T1 悬浮胶囊与工具栏单例槽都已退役（floatBar / #editor-toolbar-slot 双双为 0）',
      JSON.stringify({ floatBar: s1.floatBar, slot: s1.slot }))
    ok(s1.topbar === true, 'T2 PDF 也挂统一顶栏（批 2 前这里只有一颗几乎空的胶囊）')
    ok(/页$/.test(s1.subtitle || ''), 'T3 顶栏中段带「N 页」（合并公共部分：页数上移）', String(s1.subtitle))
    ok(s1.saveDot === false, 'T4 保存点隐藏（PDF 没有保存动作，恒亮「已保存」是假信号）')
    ok(s1.viewToggle === false, 'T5 不给「阅读切换」钮（PDF 无预览态 ⇒ 给了是假按钮）')
    ok(!!s1.readerBarText && s1.title.length > 0 && s1.readerBarText.indexOf(s1.title) === -1,
      'T6 ★ 书名只出现一次（阅读器那条栏里**没有**书名 —— 「合并公共部分」做全了）',
      JSON.stringify({ title: s1.title, readerBar: (s1.readerBarText || '').slice(0, 60) }))

    // ---- 沉浸：顶栏必须一起消失；Esc 退出后回来，且页面不能被关掉 ----
    const tabsBefore = s1.tabs
    const clicked = await clickSel('.kb-pdf-scope .kb-fit-pdfread button[title^="沉浸阅读"]', 900)
    if (!clicked) {
      console.log('  [SKIP] 点不到阅读器的「沉浸」钮（选择器未命中，可能文案变了）')
    } else {
      const s2 = await topState()
      ok(s2.topbar === false, 'T7 ★ 进沉浸后顶栏一起消失（正文占满）—— 不补 onImmersiveChange 就会「正文沉浸、顶栏还挂着」',
        JSON.stringify({ topbar: s2.topbar }))
      await action('ui.key', { key: 'Escape' })
      await sleep(900)
      const s3 = await topState()
      ok(s3.topbar === true, 'T8 Esc 退出沉浸后顶栏回来')
      ok(s3.pdf === true && s3.tabs >= tabsBefore,
        'T9 ★★ Esc **只**退出沉浸，不把页面一起关掉（批 2 顺带修的 Esc 冲突，见设计 §4.4）',
        JSON.stringify({ pdf: s3.pdf, tabsBefore: tabsBefore, tabsAfter: s3.tabs }))
    }
  }

  console.log('\n§3 文本类：顶栏 + 绿点 + ⋮ 里是批 1 那五项，且**没有**「文件格式」')
  const textRel = pick(by, ['py', 'js', 'ts', 'txt', 'csv', 'log', 'json'])
  if (!textRel) {
    console.log('  [SKIP] 文本类：仓库里没有这类文件')
  } else {
    const s = await openByRel(textRel)
    ok(s.topbar === true, `文本类也挂统一顶栏（${textRel}）`)
    ok(s.floatBar === 0, 'T10 文本类的悬浮胶囊已退役')
    ok(s.saveDot === true, 'T11 ★ 保存点显示（批 2 拍板①：文本类有真实防抖自动保存 ⇒ 绿点是真信号）')
    ok(s.viewToggle === false, 'T12 不给「阅读切换」钮')
    if (await clickSel('[data-wb="noteTopMore"]')) {
      const menu = await evalJs(`JSON.stringify((function () {
        var q = function (s) { return !!document.querySelector(s) };
        var btns = [].slice.call(document.querySelectorAll('[data-wb="noteTopMoreMenu"] button'));
        return {
          info: q('[data-wb="peFileInfo"]'),
          openSys: q('[data-wb="peOpenInSystem"]'),
          reveal: q('[data-wb="peRevealInFolder"]'),
          copy: q('[data-wb="peCopyRelPath"]'),
          htmlSrc: q('[data-wb="peHtmlSource"]'),
          hasFmt: btns.some(function (b) { return (b.textContent || '').indexOf('文件格式') >= 0 })
        };
      })())`)
      let m = null
      try { m = JSON.parse(menu) } catch { /* 下面按 null 报 */ }
      ok(!!(m && m.info && m.openSys && m.reveal && m.copy),
        'T13 ⋮ 里「文件」组四项齐（批 1 的锚点原样搬进顶栏，探针可复用）', JSON.stringify(m))
      ok(!!m && m.htmlSrc === false, 'T14 文本类不出现「看源码」（html 专有）')
      ok(!!m && m.hasFmt === false,
        'T15 ★ 非 md 的 ⋮ **没有**「文件格式」（只改内存不落盘 + 扩展名来自文件名 ⇒ 重启即失效的假按钮）')
      await clickSel('[data-wb="noteTopMore"]', 300)   // 收起菜单
    } else {
      console.log('  [SKIP] 点不到顶栏 ⋮（选择器未命中）')
    }
  }

  console.log('\n§4 图片 / 二进制：顶栏在、绿点不在（批 3 之前仍是元信息卡）')
  for (const [label, rel] of [
    ['图片', pick(by, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])],
    ['二进制', pick(by, ['zip', '7z', 'exe', 'dat', 'bin'])],
  ]) {
    if (!rel) { console.log(`  [SKIP] ${label}：仓库里没有这类文件`); continue }
    const s = await openByRel(rel)
    ok(s.topbar === true, `${label}也挂统一顶栏（${rel}）`, JSON.stringify({ monaco: s.monaco }))
    ok(s.saveDot === false, `T16 ${label} 保存点隐藏（无保存动作）`)
    ok(s.floatBar === 0, `T17 ${label} 的悬浮胶囊已退役`)
  }

  console.log('\n§5 需要在真机上手点的（探针刻意不做）')
  console.log('  · 分屏：把非 md 拖到副栏 → **两栏各挂各的顶栏**（与 Obsidian 同款），互不抢槽')
  console.log('  · 写通道（批 1）：打开 .py/.txt 改一个字 → **顶栏中段绿点**转橙再转绿 → 关掉再打开，改动还在')
  console.log('  · PDF 合并观感：顶栏中段「书名 + N 页」，阅读器那条只剩 模式/翻页/缩放/大纲/搜索/书签/护眼/沉浸/百分比')

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
