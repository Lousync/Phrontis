// 契约脚本：AI 回复「生成态」改造（方案 C 极简光标 + 纯 transform 下滑条）
// —— docs/ai-reply-loading-plan.md §8 的验收口径。
//
// 规矩（同 verify-input-bubble.mjs）：只读取真实源码做断言，不复刻实现逻辑；
// 负向 / 计数断言**先剥注释**，剥注释感知字符串字面量。
//
// 几何 / 观感类条款已在原型（tmp/ai-chat-experience-proto，11 场景 / 647 条浏览器断言）上量过；
// 这里锁的是「结构与口径」——它们才是回退时最先被破坏的东西。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

/** 逐字符状态机剥注释（感知 ' " ` 三种字符串字面量，含模板串） */
function stripComments(src) {
  let out = ''
  let state = 'code' // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i++; continue }
      if (c === '/' && n === '*') { state = 'block'; i++; continue }
      if (c === "'") { state = 'sq'; out += c; continue }
      if (c === '"') { state = 'dq'; out += c; continue }
      if (c === '`') { state = 'tpl'; out += c; continue }
      out += c
      continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } continue }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i++ } continue }
    if (c === '\\') { out += c + (n ?? ''); i++; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'
      out += c
      continue
    }
    out += c
  }
  return out
}

const FILES = {
  stream: 'src/components/shared/AssistantPanel/StreamBubble.tsx',
  toolsum: 'src/components/shared/AssistantPanel/ToolSummary.tsx',
  list: 'src/components/shared/AssistantPanel/MessageList.tsx',
  chatbody: 'src/components/shared/AssistantPanel/ChatBody.tsx',
  learn: 'src/components/shared/AiLearn/index.tsx',
  teach: 'src/modules/ai-teaching/index.tsx',
  side: 'src/modules/ai-teaching/SideLanePanel.tsx',
  css: 'src/styles/index.css',
}

const code = {}
for (const [k, rel] of Object.entries(FILES)) code[k] = stripComments(readFileSync(resolve(ROOT, rel), 'utf8'))

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) pass++
  else { fail++; fails.push(name + (extra ? ` — ${extra}` : '')) }
}
const count = (s, sub) => s.split(sub).length - 1
const has = (k, sub) => code[k].includes(sub)
const ruleOf = (src, sel) =>
  new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[\\s\\S]*?\\r?\\n\\}').exec(src)?.[0] ?? ''

// ── ① R1 状态是一条线不是一个盒子：生成态不画外框 ──────────────────────────────
ok('StreamBubble 不再有外框（原 mr-6 + bg-secondary + border + rounded-lg 那一层）',
  !has('stream', 'bg-[var(--bg-secondary)]') && !has('stream', 'rounded-lg')
  && !has('stream', 'border border-[var(--border-color)]'))
ok('StreamBubble 根节点是 Fragment（内容直接落进消息流）',
  /return \(\s*<>\s*\{?\/\*[\s\S]{0,200}?kb-gen-row/.test(code.stream) || /return \(\s*<>\r?\n\s*\{?/.test(code.stream))
ok('三处兜底状态行同样不画盒子',
  !has('list', 'rounded-lg bg-[var(--bg-secondary)] border')
  && !has('teach', 'rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] px-3.5 py-2.5')
  && !has('side', '思考中…'))

// ── ② R2 同一时刻只有一个状态标签 ─────────────────────────────────────────────
for (const k of ['stream', 'list', 'teach', 'side']) {
  ok(`${k} 的 .stage-label 恰 1 处`, count(code[k], 'stage-label') === 1, `实际 ${count(code[k], 'stage-label')}`)
}
ok('StreamBubble 只有一处「思考中…」（思考行只说「已思考 N 秒」，两处都写就是毛病 2 复发）',
  count(code.stream, '思考中…') === 1 && has('stream', '已思考 {Math.max(1, Math.round(secs))} 秒'))

// ── ③ R3/R8 生成中完全不渲染工具行 ────────────────────────────────────────────
ok('StreamBubble 不再渲染过程时间线', !has('stream', 'ProcessTimeline') && !has('stream', 'kb-toolsum'))
ok('StreamBubble 不引用工具摘要组件（工具展示留到完成后）',
  !has('stream', 'ToolSummary') && !has('stream', 'ToolStep'))
ok('StreamBubble 的 draft.items 只用于派生状态（不再渲染成行）',
  count(code.stream, 'draft.items') === 2 && has('stream', 'lastRunning(draft.items)')
  && has('stream', 'draft.items.length === 0'))
ok('StreamBubble 无转圈（滑动本身就是指示器）', !has('stream', 'animate-spin'))

// ── ④ R8 完成后：工具摘要行默认收起、最多 5 步、0 工具不出现 ─────────────────────
ok('ToolSummary 展开体上限 = 5（模块内常量，不进设置项）', has('toolsum', 'const MAX_TOOL_STEPS_SHOWN = 5'))
ok('ToolSummary 默认收起（useState(false)，无自动展开）',
  has('toolsum', 'const [open, setOpen] = useState(false)') && !has('toolsum', 'useEffect'))
ok('超出步数折成「还有 M 步」', has('toolsum', '还有 {rest} 步') && has('toolsum', 'rows.slice(0, MAX_TOOL_STEPS_SHOWN)'))
ok('0 个工具时不出现摘要行', has('toolsum', 'if (toolCount === 0) return null'))
ok('摘要行文案 = 用了 N 个工具（+ 总耗时）',
  /用了 \{toolCount\} 个工具/.test(code.toolsum) && /总耗时 \$\{\(totalMs \/ 1000\)\.toFixed\(1\)\}s/.test(code.toolsum))
ok('展开/收起走既有 .kb-collapse（不另造高度补间）',
  has('toolsum', 'kb-collapse') && has('toolsum', ' open'))
ok('两个完成态渲染面都接上了摘要行',
  has('list', '<ToolSummary rows={traceRows(m.trace)} />') && has('teach', '<ToolSummary rows={traceRows(m.trace)} />'))
ok('两处旧的「调用轨迹（N 步）」入口已消失（避免同一信息两个入口）',
  !has('list', '调用轨迹') && !has('teach', '调用轨迹'))
ok('摘要行放在正文之前（与状态行的视觉连续性一致）',
  code.list.indexOf('<ToolSummary rows={traceRows(m.trace)} />') < code.list.indexOf('codeBlockChrome="card"')
  && code.teach.indexOf('<ToolSummary rows={traceRows(m.trace)} />') < code.teach.indexOf('codeBlockChrome="card"'))

// ── ⑤ R5 耗时是安静的：>3 秒才出现、每秒一次、不 render 时算 ─────────────────────
ok('耗时阈值常量 = 3000ms', has('stream', 'const DUR_VISIBLE_AFTER_MS = 3000'))
ok('耗时只在跨过阈值后才插入', has('stream', '{showDur && <span ref={durRef} className="kb-stage-dur" />}'))
ok('刷新间隔 1000ms（不是旧版那种 100ms 跳）',
  has('stream', 'window.setInterval(tick, 1000)') || has('stream', '}, 1000)'))
ok('耗时文本靠改 DOM、不在 render 里算（否则每次 flush 都会重算 = 秒表回来）',
  has('stream', 'durRef.current.textContent') && !/kb-stage-dur[^%]{0,80}toFixed/.test(code.stream))
ok('耗时弱色', has('css', '.kb-stage-dur { margin-left: auto; flex: none; font-size: 10.5px; color: var(--text-disabled); }'))

// ── ⑥ R3 下滑条：纯 transform，无动效例外 ────────────────────────────────────
const sweepRule = ruleOf(code.css, '.kb-sweep')
const sweepAfter = code.css.slice(code.css.indexOf('.kb-sweep::after'), code.css.indexOf('@keyframes kb-sweep'))
const keyframes = code.css.slice(code.css.indexOf('@keyframes kb-sweep'), code.css.indexOf('@keyframes kb-sweep') + 200)
ok('轨道 2px + 圆角 + border 底色 + 裁剪', sweepRule.includes('height: 2px;')
  && sweepRule.includes('border-radius: 1px;') && sweepRule.includes('background: var(--border-color);')
  && sweepRule.includes('overflow: hidden;'))
ok('短条 34% 宽 + accent', sweepAfter.includes('width: 34%;') && sweepAfter.includes('background: var(--accent);'))
ok('keyframes 只动 transform: translateX', keyframes.includes('transform: translateX(0)')
  && keyframes.includes('transform: translateX(194%)'))
ok('全文件没有任何 background-position 动画（文字流光的标志）',
  !has('css', 'background-position:') || !/animation[^;]*background-position/.test(code.css))
ok('下滑条时长 1.15s + alternate', sweepAfter.includes('animation: kb-sweep 1.15s ease-in-out infinite alternate;'))
// 取**含 .kb-sweep 的那一段** reduced-motion 块。原先写的是「取最后一段」——
// 那假设本方案的块永远是文件末尾最后一块；后续方案继续往末尾追加块（2026-10-14 生图卡 K 段）
// 就会让这条断言误判。改成按内容找，块边界用大括号配平，不依赖"谁在后面"。
const rmStarts = [...code.css.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)].map(m => m.index)
const cssBlockAt = (start) => {
  const open = code.css.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < code.css.length; i++) {
    if (code.css[i] === '{') depth++
    else if (code.css[i] === '}') { depth--; if (depth === 0) return code.css.slice(start, i + 1) }
  }
  return code.css.slice(start)
}
const sweepRM = rmStarts.map(s => cssBlockAt(s)).find(b => b.includes('.kb-sweep::after')) ?? ''
ok('reduced-motion 降级成静态满格下划线',
  sweepRM.includes('.kb-sweep::after { animation: none; transform: none; width: 100%; }'))
ok('状态行容器「文字在上、轨道在下」且同宽', ruleOf(code.css, '.kb-stage').includes('flex-direction: column;'))

// ── ⑦ R6 思考行不是二级盒子 ──────────────────────────────────────────────────
const thinkBody = ruleOf(code.css, '.kb-think__body')
ok('思考展开体改左细线（不是圆角描边盒子）',
  thinkBody.includes('border-left: 1px solid var(--border-color);') && !thinkBody.includes('border-radius'))
ok('思考体保留 max-height 72px 截断', thinkBody.includes('max-height: 72px;') && thinkBody.includes('overflow: hidden;'))
ok('思考行折叠也走 .kb-collapse', has('stream', 'kb-collapse'))
ok('思考行仍受 aiShowThinking 设置约束', has('stream', "s.aiShowThinking !== false"))

// ── ⑧ R7 停止入口：状态区零个、输入区一个 ─────────────────────────────────────
ok('StreamBubble 不再接收 / 渲染停止按钮', !has('stream', 'onAbort') && !has('stream', 'title="停止'))
ok('两处兜底状态行也没有停止按钮（含原先带按钮的全局面板那版）',
  !has('list', '停止生成') && !has('teach', 'kb-gen-row') === false)
const SQUARE = 'w-2.5 h-2.5 rounded-[2px] bg-current'
for (const k of ['teach', 'side', 'chatbody', 'learn']) {
  ok(`${k} 输入区恰 1 个停止键（R7 单入口）`, count(code[k], SQUARE) === 1, `实际 ${count(code[k], SQUARE)}`)
}
ok('MessageList 不再有 onAbort prop（职责收敛到输入区）', !has('list', 'onAbort'))

// ── ⑨ 错误仍只走 Toast（不新增行内错误气泡）──────────────────────────────────
ok('StreamBubble / 思考行 / 摘要行都不画错误样式',
  !has('stream', 'danger') && !has('toolsum', 'danger'))
ok('失败步只在展开清单里标红点',
  has('toolsum', 'is-fail') && has('css', '.kb-toolsum__dot.is-fail { background: var(--danger); }'))

console.log(`\nverify-reply-loading: ${pass} PASS / ${fail} FAIL`)
if (fail) { console.log('\n失败项：'); for (const f of fails) console.log('  x ' + f) }
process.exit(fail ? 1 : 0)
