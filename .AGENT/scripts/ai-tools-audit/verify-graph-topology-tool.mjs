/**
 * 契约：builtin.knowledge.graph-topology（DP v3.4.0 第 9 项，2026-09-28）。
 *
 * 静态源码断言（handler 依赖 electron vault 运行时，纯源码口径）：
 *   1. 工具已注册，readOnly: true 且无 requires:'write'（纯只读，无权限面）
 *   2. tier: 'ondemand'（铁律 16：新工具默认折叠，零常驻 token）
 *   3. 单工具 inputSchema ≤800 字符（铁律 16 红线，量法与 measure-tool-schema.mjs 一致）
 *   4. handler 块内无 broadcastDataChanged（查询工具不得有副作用，铁律 18）
 *   5. builtin.tool.request 的 description 清单已补本工具（铁律 18）
 *   6. suggest：候选检索 excludePageIds 排除自身 + 已有连线页
 *   7. overview：断链 hint 只走 keyword 检索（不依赖嵌入模型即可用）
 *   8. import getGraphIndex（数据源 = 图谱索引现成字段，不重算链接）
 *
 * 用法：node .AGENT/scripts/ai-tools-audit/verify-graph-topology-tool.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'electron/lib/builtinTools.ts'))
const src = fs.readFileSync(SRC, 'utf8')
const lines = src.split(/\r?\n/)

const fails = []
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`PASS  ${label}`)
  else { console.log(`FAIL  ${label}${extra ? ' —— ' + extra : ''}`); fails.push(label) }
}

// ---- 抽工具块：name 行之前最近的 registerTool({ 起点，块尾 = 其后首个缩进 2 的 }) ----
// （不能用「起点后 N 行内含名字」匹配：前一个工具的窗口会覆盖到本工具的 name 行，2026-09-28 实测）
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

const block = blockOf('builtin.knowledge.graph-topology')
ok(block !== null, '1 工具已注册 builtin.knowledge.graph-topology')
if (block) {
  ok(/readOnly:\s*true/.test(block), '2a readOnly: true（纯只读）')
  ok(!/requires:\s*'write'/.test(block), '2b 不带 requires:write（无写权限面）')
  ok(/tier:\s*'ondemand'/.test(block), '2c tier: ondemand（铁律 16，默认折叠）')

  // schema 红线：从 inputSchema: 起按大括号配平，去换行/缩进/注释行后计字符
  const at = block.indexOf('inputSchema:')
  const start = block.indexOf('{', at)
  let depth = 0, schema = ''
  for (let i = start; i < block.length; i++) {
    if (block[i] === '{') depth++
    else if (block[i] === '}') { depth--; if (depth === 0) { schema = block.slice(start, i + 1); break } }
  }
  const chars = schema.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trim()).join('').length
  ok(chars <= 800, `3 schema ${chars} 字符 ≤ 800（铁律 16 红线）`)

  ok(!/broadcastDataChanged/.test(block), '4 handler 无 broadcastDataChanged（查询零副作用）')
  ok(/excludePageIds:\s*\[page\.id,\s*\.\.\.linked\]/.test(block),
    '6 suggest 候选排除自身 + 已有连线页')
  ok(/mode:\s*'keyword'/.test(block), '7 断链 hint 走 keyword-only 检索（无嵌入模型也可用）')
}

ok(/getGraphIndex/.test(src) && /import\s*\{\s*getGraphIndex\s*\}\s*from\s*'\.\/kbStore\/graphIndex'/.test(src),
  '8 import getGraphIndex（数据源 = 图谱索引现成字段）')

// 铁律 18：builtin.tool.request description 清单
const reqAt = src.indexOf("name: 'builtin.tool.request'")
const reqDesc = reqAt >= 0 ? src.slice(reqAt, reqAt + 1200) : ''
ok(/knowledge\.graph-topology/.test(reqDesc), '5 builtin.tool.request 清单已补 graph-topology（铁律 18）')

console.log(fails.length ? `\n${fails.length} FAIL` : '\nALL PASS')
process.exit(fails.length ? 1 : 0)
