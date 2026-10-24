// 契约脚本：AI 回复「生成态」v3.10.0 事件流（A 思考按轮 + B 工具过程可见）
// —— proto/ai-process-redesign/plan.md 的验收口径。
//
// 规矩（同 verify-input-bubble.mjs）：结构 / 口径断言只读取真实源码，不复刻实现逻辑；
// 负向 / 计数断言**先剥注释**，剥注释感知字符串字面量。纯函数行为用真实 agentStreamCore.ts
// （stripTypeScriptTypes + data URL）跑，不另写一份复刻品。
import { existsSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
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
  rail: 'src/components/shared/AssistantPanel/ProcessRail.tsx',
  proc: 'src/components/shared/AssistantPanel/ProcessSummary.tsx',
  core: 'src/lib/agentStreamCore.ts',
  labels: 'src/lib/toolLabels.ts',
  use: 'src/components/shared/AssistantPanel/useAgentStream.ts',
  store: 'src/lib/assistantRunStore.ts',
  list: 'src/components/shared/AssistantPanel/MessageList.tsx',
  chatbody: 'src/components/shared/AssistantPanel/ChatBody.tsx',
  learn: 'src/components/shared/AiLearn/index.tsx',
  teach: 'src/modules/ai-teaching/index.tsx',
  side: 'src/modules/ai-teaching/SideLanePanel.tsx',
  agent: 'electron/lib/agentService.ts',
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

// ── ① A：思考按 LLM 轮次分段，正文/工具开始收口 ───────────────────────────────
ok('ProcessItem 增加 think 段（带 round / active / startedAt）',
  has('core', "kind: 'think'") && has('core', 'round: number') && has('core', "state: 'active' | 'done'")
  && has('core', 'startedAt: number'))
ok('StreamDraft 改为 rev 版本号（不再有单个 thinking 字符串）',
  has('core', 'rev: number') && !/\bthinking:\s*string\b/.test(code.core) && has('core', 'rev: 0'))
ok('thinking 事件在同轮续写、跨轮新建思考段',
  has('core', 'cur.round !== d.round') && has('core', 'd.items.push(cur)'))
ok('正文开始 / 工具开始 / 新一轮都会收口 active 思考',
  has('core', 'finishActiveThink(d)') && count(code.core, 'finishActiveThink(d)') >= 3)
ok('completeThink 用 thinkingMs 补权威时长',
  has('core', 'export function completeThink') && has('core', 'step.thinkingMs')
  && has('core', "state: 'done', durationMs: step.thinkingMs"))
ok('两条流式订阅链都调用 completeThink',
  has('use', 'completeThink(d, step)') && has('store', 'completeThink(b.draft, step)'))
ok('两处 draftSig 改用 rev（思考/工具增量也能触发贴底）',
  has('list', 'draft.rev') && has('teach', 'streamDraft.rev'))

// ── ② B：生成中渲染工具行，但仍是事件流不是表格 ──────────────────────────────
ok('StreamBubble 渲染 ThinkEvent / ToolEvent（工具过程重新可见）',
  has('stream', '<ThinkEvent') && has('stream', '<ToolEvent'))
ok('StreamBubble 按 items 原序渲染事件流',
  has('stream', 'visible.map(it =>') && has('stream', "it.kind === 'think'") && has('stream', "it.kind === 'narr'"))
ok('生成中长过程只显示最近 10 步 + 查看前面 N 步',
  has('rail', 'export const LIVE_EVENT_CAP = 10') && has('stream', 'LIVE_EVENT_CAP')
  && has('stream', '查看前面 {hidden} 步'))
ok('工具行耗时内联（不在右对齐列）',
  has('rail', 'kb-ev-tool__dur') && !ruleOf(code.css, '.kb-ev-tool__dur').includes('margin-left: auto')
  && !ruleOf(code.css, '.kb-ev-tool').includes('tabular-nums'))
ok('运行中工具只做 opacity 呼吸（不转圈）',
  has('rail', 'is-running') && has('css', 'animation: kb-soft-pulse')
  && has('css', '@keyframes kb-soft-pulse') && !has('stream', 'animate-spin'))
ok('事件流是左细线 + 小节点，不是外框盒子',
  has('css', '.kb-ev-rail::before') && has('css', '.kb-ev::before')
  && !has('stream', 'bg-[var(--bg-secondary)]') && !has('stream', 'rounded-lg'))

// ── ③ R2 同一时刻只有一个状态标签 ─────────────────────────────────────────────
for (const k of ['stream', 'list', 'teach', 'side']) {
  ok(`${k} 的 .stage-label 恰 1 处`, count(code[k], 'stage-label') === 1, `实际 ${count(code[k], 'stage-label')}`)
}
ok('StreamBubble 只有一处「思考中…」（思考头不重复写状态）',
  count(code.stream, '思考中…') === 1 && !has('rail', '思考中…'))
ok('思考头写「思考 · Ns」，不写第二套状态文案',
  has('rail', '思考 · {') && has('rail', 'fmtThinkSec'))

// ── ④ 完成态：过程摘要默认收起、不截断、0/0 不出现 ─────────────────────────────
ok('旧 ToolSummary 已退役（文件删除、两处改用 ProcessSummary）',
  !existsSync(resolve(ROOT, 'src/components/shared/AssistantPanel/ToolSummary.tsx'))
  && existsSync(resolve(ROOT, 'src/components/shared/AssistantPanel/ProcessSummary.tsx'))
  && has('list', '<ProcessSummary rows={traceRows(m.trace)} />')
  && has('teach', '<ProcessSummary rows={traceRows(m.trace)} />'))
ok('完成态摘要默认收起（useState(false)，无自动展开）',
  has('proc', 'const [open, setOpen] = useState(false)') && !has('proc', 'useEffect'))
ok('完成态展开显示全部步骤（不再 5 步截断 / 还有 M 步）',
  !has('proc', 'MAX_TOOL_STEPS_SHOWN') && !has('proc', 'rows.slice') && !has('proc', '还有 {'))
ok('0 思考 + 0 工具时不出现摘要行', has('proc', 'if (visible.length === 0) return null'))
ok('摘要文案 = 过程 · 思考 Ns · N 个工具',
  has('proc', 'const head = `过程') && has('proc', '思考 ${fmtThinkSec(thinkMs)}')
  && has('proc', '${toolCount} 个工具'))
ok('完成态思考行只有时长（reasoning 不落库）',
  has('proc', '<ThinkEvent key={r.key} durationMs={r.durationMs} />'))
ok('完成态展开体复用事件流（不是旧表格）',
  has('proc', 'kb-ev-rail') && !has('proc', 'kb-toolsum'))
ok('完成态也受 aiShowThinking 设置约束', has('proc', 's.aiShowThinking !== false'))
ok('两处旧的「调用轨迹（N 步）」入口已消失', !has('list', '调用轨迹') && !has('teach', '调用轨迹'))
ok('摘要行放在正文之前',
  code.list.indexOf('<ProcessSummary rows={traceRows(m.trace)} />') < code.list.indexOf('codeBlockChrome="card"')
  && code.teach.indexOf('<ProcessSummary rows={traceRows(m.trace)} />') < code.teach.indexOf('codeBlockChrome="card"'))

// ── ⑤ 工具标签唯一真源 ────────────────────────────────────────────────────────
ok('toolLabels 提供唯一标签表 + 回退函数',
  has('labels', 'export const TOOL_ACTION_LABELS') && has('labels', 'export function toolActionLabel'))
ok('主进程 agentService 改用共享标签表（不再自留一份）',
  has('agent', "import { toolActionLabel } from '../../src/lib/toolLabels'")
  && !has('agent', 'const TOOL_ACTION_LABELS') && has('agent', 'label: toolActionLabel(realName)'))
ok('两个完成态渲染面都用共享标签',
  has('list', 'toolActionLabel') && has('teach', 'toolActionLabel'))
ok('完成态思考时长读 thinkingMs（不是整轮 durationMs）',
  has('list', 'st.thinkingMs') && has('teach', 'st.thinkingMs'))

// ── ⑥ R5 耗时是安静的：>3 秒才出现、每秒一次、不 render 时算 ─────────────────────
ok('耗时阈值常量 = 3000ms', has('stream', 'const DUR_VISIBLE_AFTER_MS = 3000'))
ok('耗时只在跨过阈值后才插入', has('stream', '{showDur && <span ref={durRef} className="kb-stage-dur" />}'))
ok('刷新间隔 1000ms', has('stream', '}, 1000)'))
ok('耗时文本靠改 DOM、不在 render 里算',
  has('stream', 'durRef.current.textContent') && !/kb-stage-dur[^%]{0,80}toFixed/.test(code.stream))
ok('耗时弱色', has('css', '.kb-stage-dur { margin-left: auto; flex: none; font-size: 10.5px; color: var(--text-disabled); }'))

// ── ⑦ R3 下滑条：纯 transform，无动效例外 ────────────────────────────────────
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
ok('reduced-motion 关闭工具图标呼吸',
  rmStarts.map(s => cssBlockAt(s)).some(b => b.includes('.kb-ev-tool.is-running svg { animation: none;')))
ok('状态行容器「文字在上、轨道在下」且同宽', ruleOf(code.css, '.kb-stage').includes('flex-direction: column;'))

// ── ⑧ R6 思考行不是二级盒子 ──────────────────────────────────────────────────
const thinkBody = ruleOf(code.css, '.kb-think__body')
ok('思考展开体改左细线（不是圆角描边盒子）',
  thinkBody.includes('border-left: 1px solid var(--border-color);') && !thinkBody.includes('border-radius'))
ok('思考体保留 max-height 截断', thinkBody.includes('max-height: 72px;') && thinkBody.includes('overflow: hidden;'))
ok('思考行折叠走 .kb-collapse', has('rail', 'kb-collapse'))
ok('生成态思考行仍受 aiShowThinking 设置约束', has('stream', 's.aiShowThinking !== false'))

// ── ⑨ R7 停止入口：状态区零个、输入区一个 ─────────────────────────────────────
ok('StreamBubble 不再接收 / 渲染停止按钮', !has('stream', 'onAbort') && !has('stream', 'title="停止'))
ok('两处兜底状态行也没有停止按钮', !has('list', '停止生成'))
const SQUARE = 'w-2.5 h-2.5 rounded-[2px] bg-current'
for (const k of ['teach', 'side', 'chatbody', 'learn']) {
  ok(`${k} 输入区恰 1 个停止键（R7 单入口）`, count(code[k], SQUARE) === 1, `实际 ${count(code[k], SQUARE)}`)
}
ok('MessageList 不再有 onAbort prop（职责收敛到输入区）', !has('list', 'onAbort'))

// ── ⑩ 失败只在事件流里标红 ───────────────────────────────────────────────────
ok('失败事件用 fail 态（不新增行内错误气泡）',
  has('rail', "state === 'fail'") && has('css', '.kb-ev-tool.is-fail') && has('css', '.kb-ev.is-fail::before'))

// ── ⑪ 纯函数行为（真实 agentStreamCore.ts）───────────────────────────────────
const coreJs = stripTypeScriptTypes(readFileSync(resolve(ROOT, FILES.core), 'utf8'))
const core = await import('data:text/javascript;base64,' + Buffer.from(coreJs).toString('base64'))
{
  const d = core.createDraft()
  core.applyStreamEvent(d, { kind: 'round-start', round: 1 })
  core.applyStreamEvent(d, { kind: 'thinking', delta: '甲' })
  core.applyStreamEvent(d, { kind: 'text', delta: '旁白' })
  core.applyStreamEvent(d, { kind: 'tool-start', name: 'builtin.vault.read', label: '读取文件', target: 'a.md' })
  core.completeThink(d, { kind: 'llm', ok: true, durationMs: 120, thinkingMs: 1500 })
  core.completeTool(d, { kind: 'tool', name: 'builtin.vault.read', ok: true, durationMs: 80 })
  core.applyStreamEvent(d, { kind: 'round-start', round: 2 })
  core.applyStreamEvent(d, { kind: 'thinking', delta: '乙' })
  core.applyStreamEvent(d, { kind: 'text', delta: '答案' })
  core.completeThink(d, { kind: 'llm', ok: true, durationMs: 90, thinkingMs: 900 })

  ok('纯函数：两轮思考各自成段，顺序 think→narr→tool→think',
    d.items.map(i => i.kind).join(',') === 'think,narr,tool,think')
  ok('纯函数：第一轮思考补到 thinkingMs',
    d.items[0].kind === 'think' && d.items[0].durationMs === 1500 && d.items[0].state === 'done')
  ok('纯函数：旁白从中间轮正文折出，最终正文留在 d.text',
    d.items[1].kind === 'narr' && d.items[1].text === '旁白' && d.text === '答案')
  ok('纯函数：工具完成态与耗时正确配对',
    d.items[2].kind === 'tool' && d.items[2].state === 'done' && d.items[2].durationMs === 80)
  ok('纯函数：第二轮思考补到 thinkingMs 且已收口',
    d.items[3].kind === 'think' && d.items[3].durationMs === 900 && d.items[3].state === 'done')
  ok('纯函数：rev 随事件递增', d.rev > 0)
}

{
  const d = core.createDraft()
  core.applyStreamEvent(d, { kind: 'round-start', round: 1 })
  core.applyStreamEvent(d, { kind: 'thinking', delta: 'x'.repeat(core.MAX_THINKING + 500) })
  ok('纯函数：单段思考按 MAX_THINKING 截尾',
    d.items[0].kind === 'think' && d.items[0].text.length === core.MAX_THINKING)
}

console.log(`\nverify-reply-loading: ${pass} PASS / ${fail} FAIL`)
if (fail) { console.log('\n失败项：'); for (const f of fails) console.log('  x ' + f) }
process.exit(fail ? 1 : 0)
