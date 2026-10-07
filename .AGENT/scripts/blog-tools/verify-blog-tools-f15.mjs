/**
 * 契约验证：博客 AI 工具（正式版台账 F-15，docs/v3.4.0-feedback.md `F-15`）。
 *
 * A. 纯函数真实执行 —— strip-types import `electron/lib/blogToolsPure.ts`（零依赖）：
 *      normalizeBlogDate 日期容错归一 / nearestEntryDates 扑空提示附近日期 / blogHitExcerpt 命中窗口摘录
 * B. 接线静态断言 —— builtinTools.ts：blog.read 注册（readOnly / ondemand / module blog /
 *      schema 红线 / 零副作用 / id+date 双路 / maxChars 截断）、blog.search 增强
 *      （wordCount + blogHitExcerpt）、import 接线、builtin.tool.request 清单（铁律 18）、
 *      术语表指路（assistantConstraints.ts）、纯模块零依赖
 *
 * 运行（项目根目录）：node .AGENT/scripts/blog-tools/verify-blog-tools-f15.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------- A. 纯函数
const PURE_REL = 'electron/lib/blogToolsPure.ts'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-tools-verify-'))
const tmpFile = path.join(tmpDir, 'blogToolsPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(read(PURE_REL), { mode: 'strip' }))
const P = await import(pathToFileURL(tmpFile).href)

console.log('\n=== 1. normalizeBlogDate：全格式归一为 YYYY-MM-DD ===')
const T = '2026-10-07'
for (const [input, want] of [
  ['2026-10-05', '2026-10-05'],
  ['2026/10/5', '2026-10-05'],
  ['2026.10.05', '2026-10-05'],
  ['2026年10月5日', '2026-10-05'],
]) {
  check(`归一：${input}`, P.normalizeBlogDate(input, T) === want, String(P.normalizeBlogDate(input, T)))
}
console.log('\n=== 2. normalizeBlogDate：缺年补 today 年份 ===')
check('缺年：10月5日', P.normalizeBlogDate('10月5日', T) === '2026-10-05', String(P.normalizeBlogDate('10月5日', T)))
check('缺年：10-05', P.normalizeBlogDate('10-05', T) === '2026-10-05', String(P.normalizeBlogDate('10-05', T)))
console.log('\n=== 3. normalizeBlogDate：非法输入拒绝 ===')
for (const t of ['2026-13-01', '2026-10-32', '随便', '2026-10', '']) {
  check(`拒绝：${t || '(空)'}`, P.normalizeBlogDate(t, T) === null, String(P.normalizeBlogDate(t, T)))
}
console.log('\n=== 4. nearestEntryDates：按距离取 n 个、时间正序输出 ===')
{
  const got = P.nearestEntryDates('2026-10-05', ['2026-09-20', '2026-10-01', '2026-10-04', '2026-12-01', '2025-10-05'], 3)
  check('取最近 3 个（时间正序输出）', JSON.stringify(got) === JSON.stringify(['2026-09-20', '2026-10-01', '2026-10-04']), JSON.stringify(got))
  check('空日期表 → 空数组', P.nearestEntryDates('2026-10-05', [], 5).length === 0, '')
  check('非法 target → 空数组', P.nearestEntryDates('xx', ['2026-10-04'], 5).length === 0, '')
}
console.log('\n=== 5. blogHitExcerpt：命中窗口 ===')
{
  const body = '开头引子。' + '垫'.repeat(200) + '目标关键词在这里' + '尾'.repeat(200)
  const got = P.blogHitExcerpt(body, '目标关键词')
  check('正文命中：摘录含命中词', got.includes('目标关键词'), got)
  check('正文命中：带省略号边界', got.startsWith('…') && got.endsWith('…'), got)
  check('正文命中：不再是开头 120 字', !got.startsWith('开头引子'), got.slice(0, 30))
  const head = P.blogHitExcerpt('只有标题命中的正文', '查无此词')
  check('仅标题命中：回落开头（无前省略号）', head.startsWith('只有标题命中的正文') && !head.startsWith('…'), head)
  check('空正文：空串', P.blogHitExcerpt('', 'x') === '', P.blogHitExcerpt('', 'x'))
  const long = P.blogHitExcerpt('短文', 'x'.repeat(500))
  check('超长查询：窗口不撑爆（≤200 字符）', long.length <= 200, String(long.length))
}

// ---------------------------------------------------------------- B. 接线静态断言
console.log('\n=== 6. builtinTools.ts：blog.read 注册与红线 ===')
const tools = stripComments(read('electron/lib/builtinTools.ts'))
const lines = tools.split(/\r?\n/)
const blocks = []
lines.forEach((l, i) => { if (/^\s{2}registerTool\(\{/.test(l)) blocks.push(i) })
const blockOf = (name) => {
  const nameLine = lines.findIndex((l) => l.includes(`name: '${name}'`))
  if (nameLine < 0) return null
  let start = -1
  for (const s of blocks) { if (s < nameLine) start = s }
  if (start < 0) return null
  let end = lines.length - 1
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\}\);?\s*$/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end + 1).join('\n')
}

const block = blockOf('builtin.blog.read')
check('blog.read 已注册', block !== null, '')
if (block) {
  check('readOnly: true（纯只读）', /readOnly:\s*true/.test(block), '')
  check("tier: 'ondemand'（铁律 16 默认折叠）", /tier:\s*'ondemand'/.test(block), '')
  check("module: 'blog'", /module:\s*'blog'/.test(block), '')
  check("无 requires:'write'", !/requires:\s*'write'/.test(block), '')
  check('handler 无 broadcastDataChanged（查询零副作用，铁律 18）', !/broadcastDataChanged/.test(block), '')
  check('id 与 date 双路（id 缺失回落 date）', /vaultGetEntryById/.test(block) && /vaultListEntries\(\{ date \}\)/.test(block), '')
  check('date 归一 + 扑空回附近日期', /normalizeBlogDate/.test(block) && /nearestEntryDates/.test(block), '')
  check('maxChars 截断（上限保护）', /contentMd\.slice\(0,\s*maxChars\)/.test(block) && /truncated/.test(block), '')

  // schema 红线：从 inputSchema: 起按大括号配平，去换行/缩进后计字符（量法与 measure-tool-schema.mjs 一致）
  const at = block.indexOf('inputSchema:')
  const start = block.indexOf('{', at)
  let depth = 0, schema = ''
  for (let i = start; i < block.length; i++) {
    if (block[i] === '{') depth++
    else if (block[i] === '}') { depth--; if (depth === 0) { schema = block.slice(start, i + 1); break } }
  }
  const chars = schema.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trim()).join('').length
  check(`schema ${chars} 字符 ≤ 800（铁律 16 红线）`, chars <= 800, String(chars))
}

console.log('\n=== 7. builtinTools.ts：blog.search 增强与 import 接线 ===')
const searchBlock = blockOf('builtin.blog.search')
check('blog.search 返回 wordCount', !!searchBlock && /wordCount:\s*e\.wordCount/.test(searchBlock), '')
check('blog.search 摘录走命中窗口 blogHitExcerpt', !!searchBlock && /excerpt:\s*blogHitExcerpt\(e\.contentMd,\s*q\)/.test(searchBlock), '')
check('blog.search description 指路 blog.read', !!searchBlock && /builtin\.blog\.read/.test(searchBlock), '')
check('import 补 vaultGetEntryById / vaultListEntries',
  /import\s*\{[^}]*vaultGetEntryById[^}]*vaultListEntries[^}]*\}\s*from\s*'\.\/kbStore\/blogVaultRepo'/.test(tools), '')
check('import blogToolsPure', /import\s*\{\s*normalizeBlogDate,\s*nearestEntryDates,\s*blogHitExcerpt\s*\}\s*from\s*'\.\/blogToolsPure'/.test(tools), '')

console.log('\n=== 8. builtin.tool.request 清单 + 术语表指路（铁律 18） ===')
const reqAt = tools.indexOf("name: 'builtin.tool.request'")
const reqDesc = reqAt >= 0 ? tools.slice(reqAt, reqAt + 1400) : ''
check('tool.request 清单已补 blog.read', /blog\.read/.test(reqDesc), '')

const constraints = stripComments(read('electron/lib/assistantConstraints.ts'))
check("术语表博客行含 builtin.blog.read", /alias:\s*'博客 \/ 日志 \/ 日记'[^}]*builtin\.blog\.read/.test(constraints), '')

console.log('\n=== 9. 纯模块零依赖（manualChannelPure 同款约定） ===')
check('blogToolsPure.ts 无 import', !/^import\s/m.test(read(PURE_REL)), '')

const fails = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ' —— ' + c.detail}`)
console.log(fails.length ? `\n${fails.length} FAIL` : `\nALL PASS (${checks.length}/${checks.length})`)
process.exit(fails.length ? 1 : 0)
