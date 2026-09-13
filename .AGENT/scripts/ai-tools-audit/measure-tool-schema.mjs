/**
 * 度量 AI 内置工具 schema 的装载体积（静态源码统计，不依赖 electron 运行时）。
 *
 * 背景：buildToolsPayload() 把 tier!=='ondemand' 的工具（缺省 core）全量注入每轮
 * LLM 请求的 tools 字段；agent loop 每轮重复携带。工具数量增长的代价有两处：
 *   1) token —— 每轮 input 线性增长（多轮对话按轮数累积）
 *   2) 选择准确率 —— 候选工具越多，模型选错/漏选概率上升
 *
 * 本脚本给出客观基线：core / ondemand 各多少、各占多少 schema 字符。
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-tools-audit/measure-tool-schema.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(
  process.argv[2] ?? 'E:/Projects/KnowledgeRecorder/electron/lib/builtinTools.ts',
)

const src = fs.readFileSync(SRC, 'utf8')
const lines = src.split(/\r?\n/)

// 定位每个 registerTool({ ... }) 块的起点
const starts = []
lines.forEach((l, i) => {
  if (/^\s{2}registerTool\(\{/.test(l)) starts.push(i)
})

/**
 * 块尾必须精确落在 registerTool({...}) 的闭合行（缩进 2 空格的 `})`），
 * 而不是下一个 registerTool 的起点 —— 否则块间注释、共享辅助函数会被
 * 误算进上一个工具的 schema 体积（曾把 schedule.list-todos 尾部注释算入、
 * 把 visual.html 前面的共享 helper 算入）。
 */
const findClose = (from) => {
  for (let i = from + 1; i < lines.length; i++) {
    if (/^ {2}\}\);?\s*$/.test(lines[i])) return i
  }
  return lines.length - 1
}

/**
 * 单工具 inputSchema 的**真实发包体积**（去掉换行/缩进/注释行后的字符数）。
 * AGENTS.md#16 的铁律是「单工具 schema ≤800 字符」—— 量的应是发给模型的 inputSchema，
 * 而不是源码块：源码块含 handler 实现，动辄上千字符，拿它当尺子红线就成了摆设。
 * 注释行必须剔除：schema 里的 `//` 说明不会进 payload，若算进去会冤枉合规的工具。
 * 从 `inputSchema:` 起按大括号配平取到 schema 结束（描述串里没有裸大括号）。
 */
const schemaChars = (text) => {
  const at = text.indexOf('inputSchema:')
  if (at < 0) return 0
  const start = text.indexOf('{', at)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
          .split(/\r?\n/)
          .filter((l) => !/^\s*\/\//.test(l))
          .map((l) => l.trim())
          .join('').length
      }
    }
  }
  return 0
}

const blocks = starts.map((s) => {
  const end = findClose(s)
  const text = lines.slice(s, end + 1).join('\n')
  const pick = (re) => (text.match(re) || [])[1]
  return {
    name: pick(/name:\s*'([^']+)'/) ?? '(unknown)',
    tier: pick(/tier:\s*'(\w+)'/) ?? 'core', // 缺省 core：每轮常驻
    requires: pick(/requires:\s*'(\w+)'/) ?? 'read',
    module: pick(/module:\s*'([^']+)'/) ?? '-',
    chars: text.length,
    schema: schemaChars(text),
    cjk: (text.match(/[\u4e00-\u9fa5]/g) || []).length,
  }
})

/** 粗估 token：中文 1 字 ≈ 1 token，非中文 ≈ 4 char/token（含 JSON key/标点） */
const estTokens = (b) => Math.round(b.cjk * 1.0 + (b.chars - b.cjk) / 4)

const sum = (arr, f) => arr.reduce((a, b) => a + f(b), 0)
const core = blocks.filter((b) => b.tier === 'core')
const ondemand = blocks.filter((b) => b.tier === 'ondemand')

/** 铁律（AGENTS.md#16）：单工具 schema ≤800 字符 —— 超线意味着每次装载都在为这一个工具多付 token */
const SCHEMA_CHAR_LIMIT = 800
const overLimit = blocks.filter((b) => b.schema > SCHEMA_CHAR_LIMIT).sort((a, b) => b.schema - a.schema)
const biggest = blocks.slice().sort((a, b) => b.schema - a.schema)[0]

const rows = [
  `源文件: ${SRC}`,
  `工具总数: ${blocks.length}`,
  '',
  `【core —— 每轮常驻注入】${core.length} 个`,
  ...core
    .sort((a, b) => b.chars - a.chars)
    .map((b) => `  ${b.name.padEnd(34)} ${String(b.chars).padStart(5)} 字符  ~${String(estTokens(b)).padStart(4)} tok  schema ${String(b.schema).padStart(4)}  [${b.requires}/${b.module}]`),
  `  小计: ${sum(core, (b) => b.chars)} 字符  ~${sum(core, estTokens)} tok`,
  '',
  `【ondemand —— 默认折叠，tool.request 后才注入】${ondemand.length} 个`,
  ...ondemand
    .sort((a, b) => b.chars - a.chars)
    .map((b) => `  ${b.name.padEnd(34)} ${String(b.chars).padStart(5)} 字符  ~${String(estTokens(b)).padStart(4)} tok  schema ${String(b.schema).padStart(4)}  [${b.requires}/${b.module}]`),
  `  小计: ${sum(ondemand, (b) => b.chars)} 字符  ~${sum(ondemand, estTokens)} tok`,
  '',
  `合计若全部装载: ~${sum(blocks, estTokens)} tok`,
  `实际常驻(默认权限 read 态): ~${sum(core, estTokens)} tok / 轮`,
  '',
  `【单工具 schema 红线（≤${SCHEMA_CHAR_LIMIT} 字符，AGENTS.md#16 铁律）】`,
  overLimit.length
    ? `  ⚠️ 超线 ${overLimit.length} 个：` + overLimit.map((b) => `${b.name} ${b.schema}`).join('；')
    : `  全部合规（最大 ${biggest.schema} 字符：${biggest.name}）`,
  '',
  '注：字符数含 TS 源码语法噪声（缩进/逗号/类型标注），实际 JSON payload 略小；',
  '    token 为估算值，用于横向比较而非精确计费；',
  `    红线一节量的是 inputSchema 去换行/缩进后的真实发包字符数（不含 name/description）。`,
]

const out = rows.join('\n')
const dst = path.join(path.dirname(SRC), '../../.AGENT/scripts/ai-tools-audit/out-schema-baseline.txt')
fs.mkdirSync(path.dirname(dst), { recursive: true })
fs.writeFileSync(dst, out, 'utf8')
console.log(out)
