/**
 * 视觉核对：拖动中「抬起 + 让位」在**真实构建产物 CSS** 下长什么样。
 *
 * 为什么还要这一步：契约脚本能钉住「transform 写成什么」，钉不住「看起来对不对」——
 * 比如抬了 z-index 投影却被后画的磁贴盖住、`opacity` 让磁贴像被删掉、边框还是虚线。
 * 做法：内联 `out/renderer/index.html` 真正引用的那份 index-*.css，类名逐字照抄真机，
 * 只手动摆出「拖到一半」的状态（无头没法真拖），浅/深主题各截一张。
 *
 * 用法：node .AGENT/scripts/desktop/probes/probe-drag-visual.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const OUT = path.join(ROOT, 'out/renderer')
const TMP = path.join(ROOT, 'tmp/desk-check')
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p))

// 只取 index.html 真正引用的那份应用样式表（assets/ 里还有旧代残留，别乱挑）
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8')
const cssHref = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)]
  .map((m) => m[1]).find((h) => /index-.*\.css$/.test(h))
if (!cssHref) throw new Error('index.html 里没找到应用样式表')
const appCss = fs.readFileSync(path.join(OUT, cssHref.replace(/^\.?\//, '')), 'utf8')
console.log('using css:', cssHref, appCss.length + ' bytes')

const ico = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" style="width:14px;height:14px"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/></svg>'
const rows = (n) => Array.from({ length: n }, (_, i) =>
  '<div style="display:flex;align-items:center;gap:6px;padding:2px 0">' +
  '<span style="width:12px;height:12px;border-radius:3px;background:var(--bg-tertiary);flex:none"></span>' +
  '<span style="height:7px;border-radius:3px;background:var(--bg-tertiary);width:' + (48 + ((i * 19) % 40)) + '%"></span>' +
  '</div>').join('')

/** 一块磁贴；extra 里塞「拖动中 / 被让位」的内联 transform */
const tile = (name, w, h, extra = '') =>
  '<div data-desk-id="' + name + '" class="desk-tile' + (extra.includes('is-dragging') ? ' is-dragging' : '') + '"' +
  ' style="grid-column: span ' + w + '; grid-row: span ' + h + (extra ? '; ' + extra : '') + '">' +
  '<div class="desk-tile-head"><span class="desk-tile-ico">' + ico + '</span>' +
  '<span class="desk-tile-name">' + name + '</span></div>' +
  '<div class="desk-tile-body">' + rows(h === 1 ? 2 : 3) + '</div>' +
  '<button class="desk-del" data-desk-del><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="width:10px;height:10px"><path d="M5 5l14 14M19 5L5 19"/></svg></button>' +
  '<button class="desk-size" data-desk-resize><span class="desk-size-lbl">' + w + '×' + h + '</span></button>' +
  '</div>'

// 摆一个「把 A 拖到 B 上」的中途状态：
//   A 抬起（is-dragging）+ 跟手位移；B 被让位到 A 腾出的格子
// ⚠️ 位移别给太大：`.desk-scroll` 是 `overflow-y:auto`，拖出可视区会被裁掉（真机同理），
//    夹具里被裁就看不到抬起样式了。
const A_DRAG = 'transform: translate(200px, 118px) scale(1.06)'
const B_SHIFT = 'transform: translate(-252px, 0px)'

const page = (theme) => `<!DOCTYPE html>
<html lang="zh-CN"${theme === 'light' ? ' class="theme-light"' : ''}>
<head>
<meta charset="utf-8">
<style>
${appCss}
</style>
<style>
/* 探针自己的页面层：底色/文字色必须自己写（主题 token 靠 html.theme-light，
   而 body 上那些 tailwind 任意值类不一定进了产物） */
html, body { height: 100%; margin: 0; overflow: hidden; background: var(--bg-primary); color: var(--text-primary) }
.pv-cap { font: 11px var(--font-mono); color: var(--text-muted); padding: 6px 0 }
/* 按真机的算式还原宽度：6 列 ≈ 6*108 + 5*12 = 708，取 760 让 2×2 磁贴 ≈ 245px */
.pv-pane { width: 760px; margin: 10px 14px }
</style>
</head>
<body>
<div class="pv-pane">
  <div class="pv-cap">拖动中：A（时钟）抬起并跟手 · B（今日待办）已让位到 A 腾出的格子</div>
  <div class="desk flex flex-col is-editing" style="height: 480px">
    <div class="desk-scroll">
      <div class="desk-grid" style="--desk-cols: 6">
        ${tile('时钟', 2, 2, A_DRAG)}
        ${tile('今日待办', 2, 2, B_SHIFT)}
        ${tile('月历', 2, 2)}
        ${tile('打卡轨迹', 2, 1)}
        ${tile('最近文档', 2, 1)}
        ${tile('知识库统计', 2, 1)}
      </div>
    </div>
  </div>
</div>
</body>
</html>`

fs.mkdirSync(TMP, { recursive: true })
const results = []
for (const theme of ['light', 'dark']) {
  const htmlPath = path.join(TMP, `drag-visual-${theme}.html`)
  const pngPath = path.join(TMP, `drag-visual-${theme}.png`)
  fs.writeFileSync(htmlPath, page(theme), 'utf8')
  if (!EDGE) { results.push(`${theme}: 未找到 Edge，已生成 html：${htmlPath}`); continue }
  const r = spawnSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=820,540',
    `--user-data-dir=${path.join(TMP, 'edge-profile-' + theme + '-' + Date.now())}`,
    `--screenshot=${pngPath}`,
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ], { encoding: 'utf8' })
  results.push(`${theme}: ${fs.existsSync(pngPath) ? pngPath : '截图失败 ' + (r.stderr || '')}`)
}
console.log(results.join('\n'))
