/**
 * 契约验证：AI 教学对话区「贴底跟随 + 回到底部」滚动状态机（v3.2.0 条目 ⑥）。
 *
 * 为什么需要它：
 *   本条的三条规则里，**两条都是「不做某事」**，而这类回归是静默的、TS 与静态 grep 都看不见：
 *     ① **规则 3（用户上滚就不许再跟随）**：只要 `stickRef` 的判定写错一点，
 *        表现就是那个经典投诉——「我往上读，流式输出一直把我拽回底部」。修错方向反而是「没有 bug 的样子」。
 *     ② **程序滚动的自我污染**：程序赋值 `scrollTop` 同样会触发 scroll 事件。若判定写成
 *        「收到 scroll 就当用户上滚」，那自己滚的自己会立刻把贴底标记打掉 → 跟随只生效一帧。
 *        本脚本用「滚底后补投一次 scroll 事件」把这条钉死（贴底判定必须是纯几何的）。
 *     ③ **规则 1（发送无条件滚底）的位置**：必须在把用户消息推进列表**之后、`await agentChat` 之前**。
 *        放到 await 之后 = AI 答完才滚（用户干等）；放到 setMessages 之前 = 滚的是旧高度。
 *     ④ **规则 2 的 instant**：`smooth` 在 60ms 一次的流式节奏下会互相打断、表现为滚动抽搐。
 *        所以断言「全文件里 smooth 只出现在锚点跳转 / 画像预览，不在滚底路径上」。
 *     ⑤ **顺带①的旧实现**：`if (t > 0)` 才恢复 —— 看着无害，实则**从不置 0**，切新会话会沿用上个会话的位置。
 *        这里用「旧值 500 → 切会话 → 读回 0」的真实调用把这条钉住（不是 grep 注释）。
 *
 * 做法（同 verify-resizable-panel.mjs 范式）：从 `src/modules/ai-teaching/index.tsx` **切出真实的
 * `onConvScroll` / `jumpToBottom` 两个 useCallback 体 + 三个 useEffect 体**（大括号计数切片 +
 * stripTypeScriptTypes → 临时 .mjs import），只 stub React 的 setState / ref / requestAnimationFrame
 * 与一个**带夹取语义的假滚动容器**（`scrollTop` setter 按真实 DOM 夹到 `scrollHeight - clientHeight`）。
 * 验的是真实实现，不是复刻的判定逻辑。
 *
 * 运行（项目根目录）：
 *   node --no-warnings .AGENT/scripts/ai-teaching/verify-sticky-bottom.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const REL = 'src/modules/ai-teaching/index.tsx'
const aiTeach = fs.readFileSync(path.join(ROOT, REL), 'utf8')

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

/** 负向断言前先剥注释 —— 本文件里就有注释**引用**了旧写法的 `if (t > 0)`，不剥会假失败。 */
const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

// ------------------------------------------------------------------ 切片工具
/** 从 `anchor` 之后第一个 `=> {` 的 `{` 起做括号计数，返回函数体（不含外层大括号）。 */
const sliceArrowBody = (text, anchor) => {
  const at = text.indexOf(anchor)
  if (at < 0) throw new Error(`找不到锚点：${anchor}`)
  const arrow = text.indexOf('=> {', at)
  if (arrow < 0) throw new Error(`锚点后找不到箭头函数体：${anchor}`)
  const start = text.indexOf('{', arrow + 3)
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(start + 1, i)
    }
  }
  throw new Error(`括号不闭合：${anchor}`)
}

/** 找出依赖数组匹配 `depsRe`（可选再匹配函数体 `bodyRe`）的第一个 `useEffect(() => { ... })`。 */
const sliceEffect = (text, depsRe, bodyRe = null) => {
  const re = /useEffect\(\(\) => \{/g
  let m
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length - 1
    let depth = 0
    let end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end < 0) continue
    const nl = text.indexOf('\n', end)
    const deps = text.slice(end, nl < 0 ? end + 80 : nl).trim()
    if (!depsRe.test(deps)) continue
    const body = text.slice(start + 1, end)
    if (bodyRe && !bodyRe.test(body)) continue
    return { body, deps }
  }
  throw new Error(`找不到依赖匹配 ${depsRe}${bodyRe ? ` 且函数体匹配 ${bodyRe}` : ''} 的 useEffect`)
}

// ------------------------------------------------------------------ 静态：协议与接线
console.log('\n[规则 1：发送路径]')
const sendWindow = (() => {
  const a = aiTeach.indexOf('const sendText = useCallback(')
  const b = aiTeach.indexOf('const doSend = useCallback(')
  return a < 0 || b < 0 ? '' : aiTeach.slice(a, b)
})()
check('sendText 里调用了 jumpToBottom()', /jumpToBottom\(\)/.test(sendWindow))
check('滚底发生在「推进用户消息之后」（不是先滚再推）',
  sendWindow.indexOf('setMessages(') > -1 &&
  sendWindow.indexOf('setMessages(') < sendWindow.indexOf('jumpToBottom()'))
check('滚底发生在 `await agentChat` 之前（否则要等 AI 答完才滚）',
  sendWindow.indexOf('jumpToBottom()') > -1 &&
  sendWindow.indexOf('jumpToBottom()') < sendWindow.indexOf('await agentChat'))
check('sendText 依赖数组含 jumpToBottom（stale closure 防护）',
  /}, \[refreshMessages, beginStream, endStream, jumpToBottom\]\)/.test(aiTeach))
check('jumpToBottom 定义在 sendText 之前（否则 deps 求值时 TDZ 抛 ReferenceError）',
  aiTeach.indexOf('const jumpToBottom = useCallback(') > -1 &&
  aiTeach.indexOf('const jumpToBottom = useCallback(') < aiTeach.indexOf('const sendText = useCallback('))

console.log('\n[规则 2 / 3：跟随与浮标]')
const rule2 = sliceEffect(aiTeach, /^},\s*\[messages, pending, draftSig\]\)$/)
check('规则 2 的 effect 依赖含 messages / pending / draftSig', /\[messages, pending, draftSig\]/.test(rule2.deps))
const draftSigExpr = (aiTeach.match(/const draftSig = ([^\n]+)\n/) || [])[1]
check('draftSig 是流式草稿的纯签名（文本 + 条目 + 思考三段都入签）',
  !!draftSigExpr && /text\.length/.test(draftSigExpr) && /items\.length/.test(draftSigExpr) && /thinking/.test(draftSigExpr),
  draftSigExpr || '(未找到)')
check('浮标由 jumpBottom 条件渲染', /\{jumpBottom && \(/.test(aiTeach))
check('浮标点击走 jumpToBottom', /onClick=\{jumpToBottom\}/.test(aiTeach))
const floatBtn = (() => {
  const at = aiTeach.indexOf('{jumpBottom && (')
  return at < 0 ? '' : aiTeach.slice(at, at + 700)
})()
check('浮标进场走既有动效令牌 .kb-pop（铁律 13：不另造过渡）', /kb-pop/.test(floatBtn))
check('浮标为白底圆形：bg-[var(--bg-primary)] + rounded-full + 无 border',
  /bg-\[var\(--bg-primary\)\]/.test(floatBtn) && /rounded-full/.test(floatBtn) && !/\bborder\b/.test(floatBtn),
  floatBtn.replace(/\s+/g, ' ').slice(0, 160))
check('浮标直径落在 32~36px（w-9/h-9 = 36px）', /w-9 h-9/.test(floatBtn))
check('浮标箭头为细线 ArrowDown size 16', /<ArrowDown size=\{16\}/.test(floatBtn) && /strokeWidth=\{1\.[0-9]+\}/.test(floatBtn))
check('浮标浮在对话区右下角内侧', /absolute right-3 bottom-3/.test(floatBtn))

console.log('\n[不遮最后一行 / instant / 死代码]')
check('滚动容器底部留 48px 给浮标占位（不遮最后一行文字）', /pt-3 pb-12/.test(aiTeach) && !/pr-8 py-3/.test(aiTeach))
const smoothCtx = [...aiTeach.matchAll(/behavior: 'smooth'/g)].map(m => aiTeach.slice(Math.max(0, m.index - 120), m.index + 60))
check('滚底路径上不出现 smooth（流式下会互相打断、表现为抽搐）',
  smoothCtx.length > 0 && smoothCtx.every(c => !/scrollHeight/.test(c)),
  `smooth 使用点 ${smoothCtx.length} 处`)
check('输入框 rows 已固定（不再随输入行数抖动消息区高度）',
  /rows=\{3\}/.test(aiTeach) && !/input\.split\('\\n'\)\.length/.test(aiTeach))
check('bottomRef 死锚点已随本次实现移除', !/bottomRef/.test(aiTeach.replace(/\/\/[^\n]*bottomRef[^\n]*\n/g, '')))

console.log('\n[顺带① ②：两个生命周期 effect]')
// 注意：`[activeId]` 这个依赖在文件里出现两次（上面还有个同步 activeIdRef 的 effect），
// 故必须再用函数体特征（setActiveAnchor(0)）把切会话那条拎出来。
const resetEffect = sliceEffect(aiTeach, /^},\s*\[activeId\]\)$/, /setActiveAnchor\(0\)/)
const restoreEffect = sliceEffect(aiTeach, /^},\s*\[midView, activeId, isActive\]\)$/)
const resetBody = stripComments(resetEffect.body)
check('切会话 effect 无条件把 convScrollTop 归零（不再只有 if (t > 0) 恢复）',
  /convScrollTop\.current = 0/.test(resetBody) && !/if \(t > 0\)/.test(resetBody))
check('切会话同时解除贴底（否则新会话载入即被规则 2 拉到底）', /stickRef\.current = false/.test(resetBody))
check('恢复 effect 依赖含 isActive（Tab 保活切回后位置不丢）', /isActive/.test(restoreEffect.deps))
check('恢复 effect 不早退于 t = 0（旧 `if (t > 0)` 正是顺带① 的成因）',
  /const t = convScrollTop\.current/.test(restoreEffect.body) && !/if \(t/.test(stripComments(restoreEffect.body)))

// ------------------------------------------------------------------ 运行：切片真实实现
const bodyScroll = sliceArrowBody(aiTeach, 'const onConvScroll = useCallback(')
const bodyJump = sliceArrowBody(aiTeach, 'const jumpToBottom = useCallback(')

const harness = stripTypeScriptTypes(
  `
let isActive = true
let midView = 'chat'
let anchors = []
let stickRef = { current: true }
let convScrollTop = { current: 0 }
let jumpBottom = false
let activeAnchor = -1
const rafQueue = []
function requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length }
function setJumpBottom(v) { jumpBottom = v }
function setActiveAnchor(v) { activeAnchor = v }
// 假滚动容器：scrollTop 带真实 DOM 的夹取语义（0 ~ scrollHeight - clientHeight）
const el = {
  scrollHeight: 0,
  clientHeight: 0,
  _top: 0,
  get scrollTop() { return el._top },
  set scrollTop(v) { el._top = Math.max(0, Math.min(v, Math.max(0, el.scrollHeight - el.clientHeight))) },
  getBoundingClientRect: () => ({ top: 0 }),
  querySelector: () => null,
}
const scrollRef = { current: el }
function onConvScroll() { ${bodyScroll} }
function jumpToBottom() { ${bodyJump} }
function rule2Follow() { ${rule2.body} }
function sessionReset() { ${resetEffect.body} }
function restorePos() { ${restoreEffect.body} }
export const api = {
  onConvScroll, jumpToBottom, rule2Follow, sessionReset, restorePos,
  flushRaf() { const q = rafQueue.splice(0); q.forEach(f => f()) },
  clearRaf() { rafQueue.length = 0 },
  setView({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, active = true, mid = 'chat', anchorList = [] } = {}) {
    el.scrollHeight = scrollHeight; el.clientHeight = clientHeight
    el._top = scrollTop
    isActive = active; midView = mid; anchors = anchorList
    // 注意：这里**不清** rafQueue —— 否则「补帧前改高度、补帧后才 flush」这类用例会被自己的夹具清空。
    // 需要干净队列的地方显式调 api.clearRaf()。
  },
  setStick(v) { stickRef.current = v },
  setConvScrollTop(v) { convScrollTop.current = v },
  setElScrollTop(v) { el.scrollTop = v },
  state() { return { stick: stickRef.current, jump: jumpBottom, convScrollTop: convScrollTop.current, scrollTop: el._top, activeAnchor } },
}
`,
  { mode: 'transform' }
)

const tmpDir = path.join(ROOT, 'tmp', 'verify-sticky-bottom')
fs.mkdirSync(tmpDir, { recursive: true })
const tmpFile = path.join(tmpDir, `sb-${Date.now().toString(36)}.mjs`)
fs.writeFileSync(tmpFile, harness, 'utf8')
const { api } = await import(pathToFileURL(tmpFile).href)

const S = () => api.state()

// ① 贴底判定：48px 容差
console.log('\n[行为：贴底判定]')
api.setView({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })   // 距底 0
api.onConvScroll()
check('滚到最底 → 贴底、不显示浮标', S().stick === true && S().jump === false, JSON.stringify(S()))

api.setView({ scrollTop: 660, scrollHeight: 1000, clientHeight: 300 })   // 距底 40 < 48
api.onConvScroll()
check('距底 40px（容差内）仍算贴底', S().stick === true && S().jump === false, JSON.stringify(S()))

api.setView({ scrollTop: 640, scrollHeight: 1000, clientHeight: 300 })   // 距底 60 > 48
api.onConvScroll()
check('距底 60px（容差外）→ 停止跟随并显示浮标', S().stick === false && S().jump === true, JSON.stringify(S()))

api.setView({ scrollTop: 640, scrollHeight: 1000, clientHeight: 300, active: false })
api.setConvScrollTop(4242)
api.onConvScroll()
check('Tab 隐藏期间早退：不冲掉位置记忆', S().convScrollTop === 4242, JSON.stringify(S()))
check('Tab 隐藏期间早退：也不乱动贴底态与浮标', S().stick === false && S().jump === true)

api.setView({ scrollTop: 500, scrollHeight: 1000, clientHeight: 300, anchorList: [] })
api.onConvScroll()
check('无锚点时提前返回不抛错（只是不做高亮）', S().stick === false && S().jump === true)

// ② 规则 3 + 程序滚动不自我污染
console.log('\n[行为：规则 3 · 程序滚动不自我污染]')
api.setView({ scrollTop: 620, scrollHeight: 1000, clientHeight: 300 })   // 距底 80 → 上滚
api.onConvScroll()
check('用户上滚后处于「不贴底」', S().stick === false)
api.setElScrollTop(100)                                                  // 用户继续往上读
api.onConvScroll()
check('继续上滚仍不贴底、浮标保持', S().stick === false && S().jump === true)

api.jumpToBottom()
check('点浮标 → 立即滚到底 + 恢复贴底 + 浮标消失',
  S().scrollTop === 700 && S().stick === true && S().jump === false, JSON.stringify(S()))
// 程序赋值同样会触发 scroll 事件：补投一次，贴底判定必须仍是「贴底」（纯几何判定）
api.onConvScroll()
check('【红线】程序滚底后补投 scroll 事件仍判为贴底（不会把跟随打掉）',
  S().stick === true && S().jump === false, JSON.stringify(S()))

// ③ 规则 2：仅贴底才跟随
console.log('\n[行为：规则 2 · 仅贴底才跟随]')
api.setView({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
api.onConvScroll()
api.setView({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
api.rule2Follow()
check('贴底时内容增长 → 跟随到底（instant 直接赋值）', S().scrollTop === 700, JSON.stringify(S()))

api.setView({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
api.onConvScroll()
api.setView({ scrollTop: 300, scrollHeight: 1000, clientHeight: 300 })
api.setStick(false)
api.rule2Follow()
check('【红线】不贴底时内容增长 → 一动不动（用户阅读不被打断）',
  S().scrollTop === 300, JSON.stringify(S()))

// ④ 规则 1 的「补一帧」：乐观消息尚未提交 DOM
console.log('\n[行为：规则 1 · 补帧]')
api.clearRaf()
api.setView({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
api.onConvScroll()
check('前置：贴底', S().stick === true)
api.jumpToBottom()
check('补帧前：已按旧高度滚到旧底', S().scrollTop === 700)
// 模拟「乐观消息此刻才提交 DOM」→ 内容变高（**不清 raf 队列**，否则就测不到补帧了）
api.setView({ scrollTop: 700, scrollHeight: 1300, clientHeight: 300 })
api.flushRaf()
check('补帧后：按新高度再滚一次（不会停在旧底、少看最后一条）',
  S().scrollTop === 1000, JSON.stringify(S()))

// ⑤ 顺带①②：切会话归零 / 恢复含 t = 0
console.log('\n[行为：顺带① ②]')
api.setView({ scrollTop: 500, scrollHeight: 1000, clientHeight: 300 })
api.setConvScrollTop(500)
api.setStick(true)
api.sessionReset()
check('切会话 → convScrollTop 归零（旧实现只做 if (t > 0) 恢复、从不置 0）',
  S().convScrollTop === 0, JSON.stringify(S()))
check('切会话 → 解除贴底 + 清浮标（新会话从顶部开始）', S().stick === false && S().jump === false)
api.rule2Follow()
check('切会话后新消息载入不会把视图拉到底（stick 已解除）', S().scrollTop === 500, JSON.stringify(S()))

api.clearRaf()
api.setView({ scrollTop: 500, scrollHeight: 1000, clientHeight: 300 })
api.setConvScrollTop(0)
api.restorePos()
api.flushRaf()
check('恢复 effect 对 t = 0 也无条件应用（旧 `if (t > 0)` 正是顺带① 的成因）',
  S().scrollTop === 0, JSON.stringify(S()))

api.clearRaf()
api.setView({ scrollTop: 0, scrollHeight: 1300, clientHeight: 300 })
api.setConvScrollTop(640)
api.restorePos()
check('恢复 effect 是「下一帧」应用（此刻还没动）', S().scrollTop === 0, JSON.stringify(S()))
api.flushRaf()
check('下一帧按 convScrollTop 恢复位置', S().scrollTop === 640, JSON.stringify(S()))

api.clearRaf()
api.setView({ scrollTop: 120, scrollHeight: 1000, clientHeight: 300, mid: 'quiz' })
api.setConvScrollTop(640)
api.restorePos()
api.flushRaf()
check('非对话视图（题目页）不强制恢复滚动', S().scrollTop === 120, JSON.stringify(S()))

// ⑥ draftSig 真实求值：三段都必须入签
console.log('\n[行为：draftSig 签名]')
const draftSigOf = new Function('streamDraft', `return (${draftSigExpr})`)
check('无草稿 → 空签名', draftSigOf(null) === '')
const d0 = { text: 'abc', items: [1], thinking: 'xy' }
check('同一草稿 → 同一签名（纯函数，不每帧乱抖）', draftSigOf(d0) === draftSigOf({ text: 'abc', items: [1], thinking: 'xy' }))
check('正文增长 → 签名变化（流式正文能触发跟随）', draftSigOf(d0) !== draftSigOf({ text: 'abcd', items: [1], thinking: 'xy' }))
check('工具条目增长 → 签名变化（工具阶段也能跟随）', draftSigOf(d0) !== draftSigOf({ text: 'abc', items: [1, 2], thinking: 'xy' }))
check('思考段增长 → 签名变化（思考阶段也能跟随）',
  draftSigOf(d0) !== draftSigOf({ text: 'abc', items: [1], thinking: 'xyz' }))
check('思考段缺失不抛错（thinking 可选）', draftSigOf({ text: 'a', items: [] }) === '1|0|0')

// ------------------------------------------------------------------ 报告
const failed = checks.filter(c => !c.pass)
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  — ' + c.detail : ''}`)
}
console.log(`\n合计 ${checks.length} 项：PASS ${checks.length - failed.length} / FAIL ${failed.length}`)
try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
process.exit(failed.length === 0 ? 0 : 1)
