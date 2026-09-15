/**
 * 产物字符串探针：确认「启动落点 = 桌面兜底 / 模块清单唯一真相源」真的进了包。
 *
 * ⚠️ 硬规矩（本项目踩过一次假结论）：**只扫 `out/renderer/index.html` 真正引用的 chunk**
 * （`<script src>` + `<link rel="modulepreload">` + stylesheet）。
 * `out/renderer/assets/` 因 `emptyOutDir:false` 会跨构建累积旧代 chunk，
 * 把整个 assets/ 拼起来 grep，任何旧字符串都会命中 → 伪造出「改动没生效」的假结论。
 *
 * 用法：node .AGENT/scripts/startup-tab/probe-bundle-strings.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const OUT = path.join(ROOT, 'out/renderer')

const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8')
const refs = new Set()
for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.add(m[1])
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]*href="([^"]+)"/g)) refs.add(m[1])
for (const m of html.matchAll(/<link[^>]+href="([^"]+)"[^>]*rel="modulepreload"/g)) refs.add(m[1])
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
console.log(`index.html 引用 ${files.length} 个文件；闭包合计 ${(blob.length / 1024 / 1024).toFixed(2)} MB`)
if (missing.length) console.log(`⚠️ 引用但不存在：${missing.join(', ')}`)

/** 把 id 序列拼成「数组字面量味道」的正则：只用引号/逗号/空白相连，不跨到别的 token */
const seq = (ids) => new RegExp(ids.map((s) => `['"\`]${s}['"\`]`).join('\\s*,\\s*'))
const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

// —— 负向：旧的手抄清单必须从包里消失 ——
const OLD_CANDIDATES = ['blog', 'schedule', 'knowledge', 'editor', 'moments', 'toolbox', 'plugins', 'recycle', 'help']
check('旧启动候选表已从产物中消失（含 recycle/help 的那张）', !seq(OLD_CANDIDATES).test(blob))
const OLD_ALLOWLIST = ['blog', 'schedule', 'knowledge', 'moments', 'toolbox', 'plugins', 'recycle', 'help', 'settings', 'user']
check('旧小窗 switch-tab 白名单已从产物中消失', !seq(OLD_ALLOWLIST).test(blob))
check('旧活动栏默认顺序（带 export/recycle）已消失',
  !seq(['plugins', 'export', 'recycle']).test(blob) && !seq(['toolbox', 'plugins', 'export']).test(blob))

// —— 正向：新口径进包 ——
check('活动栏默认顺序已去掉陈年 id',
  seq(['editor', 'blog', 'schedule', 'knowledge', 'moments', 'toolbox', 'plugins']).test(blob))
// 15 个模块的中文名（开发者工具 = 本次进真相源的新标签；桌面 = 新兜底落点）
const LABELS = ['桌面', '编辑器', '知识库', '博客', '日程', '说说', 'AI教学', '工具箱', '插件',
  '回收站', '帮助', '账户', '更新说明', '设置', '开发者工具']
const missLabels = LABELS.filter((l) => !blob.includes(l))
check('15 个模块的中文名都在包里（含新标签「开发者工具」）', missLabels.length === 0, missLabels.join(','))

// —— 报告 ——
let bad = 0
for (const c of checks) {
  if (!c.pass) bad++
  console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? '  → ' + c.detail : ''}`)
}
console.log(bad === 0 ? `\n✅ 产物探针全部通过（${checks.length} 项）` : `\n❌ ${bad} 项 FAIL`)
process.exit(bad === 0 ? 0 : 1)
