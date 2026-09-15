/**
 * 产物字符串探针：确认「新建按钮改跳编辑器」+「拖拽手感」这两处改动真的进了包。
 *
 * ⚠️ 硬规矩（本项目踩过一次假结论）：**必须只扫 `out/renderer/index.html` 真正引用的 chunk**
 * （`<script src>` + 全部 `<link rel="modulepreload">`）。
 * `out/renderer/assets/` 因 `emptyOutDir:false` 会跨构建累积旧代 chunk（实测 105 个 / 55.8 MB），
 * 把整个 assets/ 拼起来 grep，任何旧字符串都会命中 → 伪造出「改动没生效」或「旧代码还在」的假结论。
 *
 * 用法：node .AGENT/scripts/desktop/probes/probe-bundle-strings.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const OUT = path.join(ROOT, 'out/renderer')

const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8')
const refs = new Set()
for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.add(m[1])
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]*href="([^"]+)"/g)) refs.add(m[1])
// 兜底：href 与 rel 顺序可能相反
for (const m of html.matchAll(/<link[^>]+href="([^"]+)"[^>]*rel="modulepreload"/g)) refs.add(m[1])
// 样式表（应用自身那份 index-*.css 也是 index.html 直接引用的）
for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)) refs.add(m[1])
for (const m of html.matchAll(/<link[^>]+href="([^"]+)"[^>]*rel="stylesheet"/g)) refs.add(m[1])

const files = [...refs].map((r) => r.replace(/^\.?\//, ''))
if (files.length === 0) throw new Error('index.html 里没解析到任何 script/modulepreload 引用')

let blob = ''
const missing = []
for (const f of files) {
  const p = path.join(OUT, f)
  if (!fs.existsSync(p)) { missing.push(f); continue }
  blob += fs.readFileSync(p, 'utf8')
}

console.log(`index.html 引用的 chunk：${files.length} 个`)
files.forEach((f) => console.log(`  ${f}`))
if (missing.length) console.log(`⚠️ 引用但不存在：${missing.join(', ')}`)

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

// ---- 改动点 ①：新建按钮改跳编辑器 ----
check('新：按钮 title「新建知识页（在编辑器中）」已进包', blob.includes('新建知识页（在编辑器中）'))
check('新：按钮跳转复用 kb-editor-new-page 通道（同文件内可见）', blob.includes('kb-editor-new-page'))
check('旧：按钮 title「去知识库新建」已不在包里', !blob.includes('去知识库新建'),
  '若命中，先确认是不是命中了旧代 chunk —— 本探针已限定到 index.html 引用集合')

// ---- 改动点 ②：拖拽手感 ----
check('新：落位 FLIP 的收尾 transform 字面量进包', blob.includes('translate(0px, 0px) scale(1)'))
check('新：让位/落位缓动 curve 进包', blob.includes('cubic-bezier(.2, .9, .3, 1)'))
check('旧：命中判定不再用 elementFromPoint', !/elementFromPoint/.test(blob),
  '拖动块抬了 z-index，elementFromPoint 只会命中它自己')

// ---- CSS 侧（同一次构建产出的 index-*.css，也在 index.html 的引用里）----
const cssFile = files.find((f) => /(^|\/)index-.*\.css$/.test(f))
check('index.html 引用了应用样式表', !!cssFile, cssFile || '(未引用)')
if (cssFile) {
  const css = fs.readFileSync(path.join(OUT, cssFile), 'utf8')
  const dragBlock = /\.is-dragging\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
  check('CSS：.is-dragging 抬了 z-index', /z-index:\s*30/.test(dragBlock), dragBlock.slice(0, 120))
  check('CSS：.is-dragging 不再靠降透明度表达「拿起」', !/opacity:\s*\.9\b/.test(dragBlock), dragBlock.slice(0, 120))
  check('CSS：.is-dragging 带大投影', /box-shadow/.test(dragBlock))
  check('CSS：is-over 规则已移除（让位取代了描边目标）', !/\.is-over\b/.test(css))
}

console.log('')
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `   ← ${c.detail}`}`)
const failed = checks.filter((c) => !c.pass).length
console.log(`\n结论: ${failed === 0 ? 'PASS' : `FAIL（${failed} 项）`} —— ${checks.length} 项断言`)
process.exitCode = failed === 0 ? 0 : 1
