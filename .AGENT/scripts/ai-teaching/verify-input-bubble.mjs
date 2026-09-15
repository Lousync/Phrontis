// 契约脚本：条目 ⑧「AI 输入区气泡化」结构性断言（静态可验部分）
// 对应 docs/ai-input-bubble-design.md 第六节「验证」中可静态化的条款。
//
// 规矩：只读取真实源码做断言，不复刻实现逻辑。
// 负向 / 计数断言必须**先剥注释**，且剥注释要**感知字符串字面量**
// （否则 `'https://…'` 里的 `//` 会把整行截断、反而漏掉真问题）。
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
    // 字符串字面量内部：原样保留，处理转义与闭合
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
  teach: 'src/modules/ai-teaching/index.tsx',
  side: 'src/modules/ai-teaching/SideLanePanel.tsx',
  assistant: 'src/components/shared/AssistantPanel/index.tsx',
  learn: 'src/components/shared/AiLearn/index.tsx',
}

const raw = {}
const code = {} // 剥注释后的源码
for (const [k, rel] of Object.entries(FILES)) {
  raw[k] = readFileSync(resolve(ROOT, rel), 'utf8')
  code[k] = stripComments(raw[k])
}

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) { pass++ } else { fail++; fails.push(name + (extra ? ` — ${extra}` : '')) }
}
const count = (s, sub) => s.split(sub).length - 1
const has = (k, sub) => code[k].includes(sub)

// ── ① 合规提示：4 个源文件各 1 处（= 5 处 UI，因为 Composer 同时服务 #3/#4）──────────
const COMPLIANCE = 'AI 生成内容，请注意甄别'
for (const k of Object.keys(FILES)) {
  ok(`合规提示在 ${k} 恰 1 处`, count(code[k], COMPLIANCE) === 1, `实际 ${count(code[k], COMPLIANCE)}`)
}
ok('合规提示源文件数 = 4（= 5 处 UI）', Object.keys(FILES).filter(k => count(code[k], COMPLIANCE) === 1).length === 4)
ok('合规提示带 title 披露', code.teach.includes('title="AI 生成内容可能存在错误，请自行核实"')
  && code.assistant.includes('title="AI 生成内容可能存在错误，请自行核实"')
  && code.learn.includes('title="AI 生成内容可能存在错误，请自行核实"')
  && code.side.includes('title="AI 生成内容可能存在错误，请自行核实"'))

// ── ② 外壳：不贴底留白（pb-2.5 pt-2）且去掉分割线 / 灰底 ────────────────────────────
for (const k of ['teach', 'side', 'assistant', 'learn']) {
  ok(`${k} 外壳含「不贴底」留白 pb-2.5 pt-2`, has(k, 'pb-2.5 pt-2'))
}
ok('teach 旧外壳（灰底 p-2 bg-secondary）已消失', !has('teach', 'p-2 bg-[var(--bg-secondary)]'))
ok('assistant 旧输入容器（border-t p-2.5 space-y-1.5）已消失',
  !has('assistant', 'border-t border-[var(--border-color)] p-2.5') && !has('assistant', 'p-2.5 shrink-0 border-t'))
ok('learn 旧容器（items-end gap-2 border-t bg-secondary）已消失',
  !has('learn', 'items-end gap-2 border-t border-[var(--border-color)] bg-[var(--bg-secondary)]'))
ok('side 旧输入框小卡片（rounded-lg + bg-input-bg px-2.5 py-1.5）已消失',
  !has('side', 'rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] px-2.5 py-1.5'))
ok('side 旧外壳（border-t p-2.5）已消失', !has('side', 'shrink-0 border-t border-[var(--border-color)] p-2.5'))

// ── ③ 气泡本体：rounded-xl + shadow-lg + focus-within 落在卡片上 ───────────────────
const BUBBLE = 'rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg px-3 pt-2.5 pb-2 focus-within:border-[var(--accent)]/60'
for (const k of ['teach', 'side', 'assistant', 'learn']) {
  ok(`${k} 气泡外壳类名完整`, has(k, BUBBLE))
}

// ── ④ textarea：自身无边框、无底色；焦点上移 ────────────────────────────────────────
for (const k of ['teach', 'side', 'assistant', 'learn']) {
  ok(`${k} textarea 已去自身边框/底色`, has(k, 'rounded-none border-0 bg-transparent'))
}
for (const k of ['teach', 'side', 'assistant', 'learn']) {
  ok(`${k} 保留 rows={2}（自适应高度不在本次范围）`, has(k, 'rows={2}'))
}
ok('side 无意义的三元 rows 已化简', !has('side', 'rows={wide ? 2 : 2}'))

// ── ⑤ 圆形发送键；方块停止只在 #1 / #5 ─────────────────────────────────────────────
for (const k of ['teach', 'side', 'assistant', 'learn']) {
  ok(`${k} 含圆形图标键（w-8 h-8 rounded-full）`, has(k, 'w-8 h-8') && has(k, 'rounded-full'))
}
const SQUARE = 'w-2.5 h-2.5 rounded-[2px] bg-current'
ok('teach 停止键 = 圆内方块（恰 1）', count(code.teach, SQUARE) === 1, `实际 ${count(code.teach, SQUARE)}`)
ok('side 停止键 = 圆内方块（恰 1）', count(code.side, SQUARE) === 1, `实际 ${count(code.side, SQUARE)}`)
ok('assistant pending 不是停止键（维持转圈 + 禁用）', !has('assistant', SQUARE))
ok('learn pending 不是停止键（维持转圈 + 禁用）', !has('learn', SQUARE))
// 原停止键用的是 <X size={13} />。改后 composer 里只剩方块；全文 <X size={13} /> 仍应**恰 1 处**
//（L227 消息关闭键，绝不能删）—— 若变成 2 处即「停止键退回 ✕」。
ok('side 停止键已不是 ✕（全文 <X size={13}> 恰 1 处 = 消息关闭键）',
  count(code.side, '<X size={13}') === 1, `实际 ${count(code.side, '<X size={13}')}`)
ok('学/侧栏 pending 仍转圈', has('assistant', 'animate-spin') && has('learn', 'animate-spin'))

// ── ⑥ 死引用清理 / 不能误删的引用 ────────────────────────────────────────────────
for (const k of ['teach', 'side', 'learn']) {
  ok(`${k} 已无 Send 引用（死引用清理）`, !/\bSend\b/.test(code[k]))
}
ok('assistant 本地 SendIcon 已删', !code.assistant.includes('SendIcon'))
ok('side 的 X 仍在（关闭键在用，绝不能删）',
  /import \{[^}]*\bX\b[^}]*\} from 'lucide-react'/.test(code.side) && /<X\s/.test(code.side))
for (const k of ['teach', 'side', 'assistant', 'learn']) {
  ok(`${k} 已导入 ArrowUp`, /import \{[^}]*\bArrowUp\b[^}]*\} from 'lucide-react'/.test(code[k]))
}

// ── ⑦ 行为面未被动（只换外观）────────────────────────────────────────────────────
ok('assistant pending 语义未变（转圈 + 三条件禁用）',
  has('assistant', 'disabled={pending || compressing || !input.trim()}'))
ok('side 的 disabled={stopped} 仍在', has('side', 'disabled={stopped}'))
ok('side Escape / Enter 键位未变',
  has('side', "e.key === 'Escape'") && has('side', "e.key === 'Enter' && !e.shiftKey"))
ok('side max-h-32 内部滚动未变', has('side', 'max-h-32'))
ok('side 上方「升格为会话」动作条未变', has('side', '升格为会话'))
ok('learn compact 左右边距差异保留（px-3 / px-4）',
  has('learn', "compact ? 'px-3' : 'px-4'"))
ok('learn 自带草稿 state 保留', has('learn', 'const [draft, setDraft] = useState'))

// ── ⑧ 铁律 13：不新增动画令牌（animate-* 只允许 animate-spin）─────────────────────
for (const k of ['teach', 'side', 'assistant', 'learn']) {
  // 允许集 = 改前就存在的令牌：spin 无处不在；pulse 见 ai-teaching 的步骤指示点与进度条
  //（均非本次引入）。出现其它 animate-* 即视为违反铁律 13（不新增形状类动效）。
  const ALLOWED_ANIM = new Set(['spin', 'pulse'])
  const anims = [...code[k].matchAll(/\banimate-([a-z-]+)/g)].map(m => m[1])
  const bad = [...new Set(anims)].filter(a => !ALLOWED_ANIM.has(a))
  ok(`${k} 未新增动画令牌`, bad.length === 0, `发现 ${bad.join(',')}`)
}

// ── ⑨ 文案保全（只收不删）────────────────────────────────────────────────────────
ok('teach 发送/停止 title 保留', has('teach', 'title="发送"') && has('teach', '停止生成（已完成的轮次保留）'))
ok('side 追问 placeholder 保留', has('side', '就这一点追问…'))
ok('teach 合规提示上方旧占位注释语义保留（合规提示行仍在 footer 内）',
  has('teach', COMPLIANCE) && has('teach', 'composerFooter'))

console.log(`\nverify-input-bubble: ${pass} PASS / ${fail} FAIL`)
if (fail) { console.log('\n失败项：'); for (const f of fails) console.log('  ✗ ' + f) }
process.exit(fail ? 1 : 0)
