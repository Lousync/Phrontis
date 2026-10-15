// 契约脚本：AI 回复代码块卡片（形态 B 悬浮胶囊）—— docs/code-block-card-plan.md
//
// 规矩（同 verify-input-bubble.mjs）：只读取真实源码做断言，不复刻实现逻辑；
// 负向 / 计数断言**先剥注释**，剥注释感知字符串字面量（否则 `'https://…'` 里的 `//` 会截断整行）。
//
// 为什么几何类条款这里只能验「公式与结构」：折叠 12 行的精确性已在原型
// （tmp/ai-code-card-proto / tmp/ai-chat-experience-proto，无头 Edge 实测）上量过；
// 生产侧只要保证「同一套公式 + 同一条优先级关系」就等价，而这两件事都是静态可验的。
// 真机几何回归见方案 §5。
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
  md: 'src/components/shared/MarkdownPreview.tsx',
  css: 'src/styles/index.css',
  settings: 'src/lib/settings.ts',
  teach: 'src/modules/ai-teaching/index.tsx',
  side: 'src/modules/ai-teaching/SideLanePanel.tsx',
  artifacts: 'src/modules/ai-teaching/ArtifactsPane.tsx',
  list: 'src/components/shared/AssistantPanel/MessageList.tsx',
  stream: 'src/components/shared/AssistantPanel/StreamBubble.tsx',
}

const raw = {}
const code = {}
for (const [k, rel] of Object.entries(FILES)) {
  raw[k] = readFileSync(resolve(ROOT, rel), 'utf8')
  code[k] = stripComments(raw[k])
}

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) pass++
  else { fail++; fails.push(name + (extra ? ` — ${extra}` : '')) }
}
const count = (s, sub) => s.split(sub).length - 1
const has = (k, sub) => code[k].includes(sub)

// ── ① 开关：默认档零变化（19 处消费者不动）──────────────────────────────────────
ok('MarkdownPreview 新增 codeBlockChrome，默认 plain',
  has('md', "codeBlockChrome?: 'plain' | 'card'") && has('md', "codeBlockChrome = 'plain'"))
ok('MarkdownPreview 新增 streaming，默认 false',
  has('md', 'streaming?: boolean') && has('md', 'streaming = false'))
ok('components memo 依赖补齐 codeBlockChrome / streaming',
  /\}\), \[[^\]]*codeBlockChrome[^\]]*streaming[^\]]*\]\)/.test(code.md))

// ── ② 只挂 pre 兜底分支：特殊围栏一个都不能被卡片吃掉 ─────────────────────────────
const preStart = code.md.indexOf('pre({ children })')
const preEnd = code.md.indexOf('// Override ul/ol')
const preBody = code.md.slice(preStart, preEnd)
const idxOf = (s) => preBody.indexOf(s)
ok('pre 覆写里 spoiler/anim 早退仍在', idxOf("/language-(spoiler|anim)/") !== -1)
ok('pre 覆写里 quiz/json 早退仍在', idxOf("/language-(quiz|json)/") !== -1)
ok('pre 覆写里 schedule-preview 早退仍在', idxOf('language-schedule-preview') !== -1)
ok('pre 覆写里 mermaid 早退仍在', idxOf("fenceLang === 'mermaid'") !== -1)
ok('pre 覆写里插件渲染器早退仍在', idxOf('fenceRenderers.get(fenceLang)') !== -1)
const iCard = idxOf("if (codeBlockChrome === 'card') {")
const iPlain = idxOf('return <pre>{children}</pre>')
ok('卡片分支存在', iCard !== -1)
ok('卡片分支在兜底 <pre> 之前（且晚于全部特殊围栏）',
  iCard !== -1 && iPlain !== -1 && iCard < iPlain
  && idxOf('language-schedule-preview') < iCard && idxOf('fenceRenderers.get(fenceLang)') < iCard)
ok('卡片只由 pre 兜底分支产生', count(code.md, '<CodeBlockCard') === 1)

// ── ③ code 覆写：卡片档只跳过最后那段；spoiler / anim / 行内分支必须保留 ───────────
const codeStart = code.md.indexOf('code({ className, children, node, ...props })')
const codeEnd = code.md.indexOf('// Convert [[wiki links]]')
const codeBody = code.md.slice(codeStart, codeEnd)
ok('code 覆写里 spoiler 分支仍在', codeBody.includes('language-spoiler'))
ok('code 覆写里 anim 分支仍在', codeBody.includes('language-anim@'))
ok('code 覆写里行内 !isBlock 分支仍在', codeBody.includes('if (!isBlock) {'))
const iBare = codeBody.indexOf("if (codeBlockChrome === 'card') {")
const iWrap = codeBody.indexOf('<div className="relative group">')
ok('卡片档返回裸 <code>', iBare !== -1 && codeBody.slice(iBare, iBare + 140).includes('<code className={className} {...props}>{children}</code>'))
ok('裸 <code> 分支在 relative 包裹之前（卡片档才不会多一个语言标签）', iBare !== -1 && iWrap !== -1 && iBare < iWrap)
ok('非卡片档逐字保持现状（relative group + 语言标签）',
  codeBody.includes('<span className="absolute top-1 right-2 text-[10px] text-[var(--text-muted)] opacity-40 select-none">'))

// ── ④ 卡片组件：折叠阈值 / 复制 / 自动换行 都走既有真源 ────────────────────────────
ok('折叠阈值常量 = 20 / 12', has('md', 'const FOLD_OVER_LINES = 20') && has('md', 'const FOLD_SHOWN_LINES = 12'))
ok('折叠触发用 > FOLD_OVER_LINES（20 行不折）', has('md', 'lines > FOLD_OVER_LINES'))
ok('折叠行数由 JS 单点喂给 CSS 变量', has('md', "'--kb-card-fold-lines': FOLD_SHOWN_LINES"))
ok('流式档不出折叠', has('md', 'const foldable = !streaming && lines > FOLD_OVER_LINES'))
ok('流式档不出自动换行按钮', /\{!streaming && \([\s\S]{0,400}?自动换行/.test(code.md))
ok('源码取 extractText（复用现成纯函数，不另写一份）', has('md', 'source={extractText(children)}'))
ok('复制走 copyText', has('md', 'await copyText') || has('md', 'void copyText(src).then'))
ok('复制成功不弹 Toast（就地变 ✓），失败才走 showToast', has('md', "showToast({ type: 'error', message: '复制失败' })"))
ok('自动换行读 useSettings（不是异步 getSetting）',
  has('md', 'const { s, update } = useSettings()') && has('md', 'const wrap = s.codeBlockWordWrap === true'))
ok('自动换行切换写回 settings', has('md', "update('codeBlockWordWrap', !wrap)"))
ok('卡片内不出现 getSetting(', !has('md', 'getSetting('))
ok('语言标签 lang || txt', count(code.md, "lang || 'txt'") >= 2)
ok('细滚动条复用既有 .kb-thin-scroll', has('md', '<pre className="kb-thin-scroll">'))

// ── ⑤ settings：默认关、不进设置页搜索（入口在卡片胶囊上）──────────────────────────
ok('settings 新增 codeBlockWordWrap，默认 false',
  /codeBlockWordWrap: \{ default: false/.test(code.settings))
ok('该键不进设置页搜索（ui: false + 无 anchor）',
  /codeBlockWordWrap: \{[^}]*ui: false[^}]*\}/.test(code.settings)
  && !/codeBlockWordWrap: \{[^}]*anchor:/.test(code.settings))

// ── ⑥ CSS：卡片 chrome 在外层，pre 抵掉基础规则（否则框中框）──────────────────────
// 取「单条规则」的正文：`*?` 到第一个 `}` 为止。⚠️ 不能用 `[\s\S]{0,N}?` 跨规则找 ——
// `.kb-code-card__body {` 之后紧跟着的就是 `.kb-code-card__body pre {`，会假阳性。
const ruleOf = (sel) => new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[\\s\\S]*?\\r?\\n\\}').exec(code.css)?.[0] ?? ''
const cardRule = ruleOf('.kb-code-card')
const bodyRule = ruleOf('.kb-code-card__body')
const preRule = ruleOf('.kb-code-card__body pre')
const foldRule = ruleOf('.kb-code-card.is-folded .kb-code-card__body')
const actsRule = ruleOf('.kb-code-card__acts')
ok('卡片外层有底色 / 描边 / 圆角 / 投影',
  cardRule.includes('background: var(--bg-primary)')
  && cardRule.includes('border: 1px solid var(--border-color)')
  && cardRule.includes('border-radius: var(--radius-card)')
  && cardRule.includes('box-shadow: var(--shadow-card)'))
ok('卡片内的 pre 抵掉了基础规则的 5 条（背景 / 边框 / 圆角 / 投影 / 外边距）',
  preRule.includes('margin: 0;') && preRule.includes('background: transparent;')
  && preRule.includes('border: 0;') && preRule.includes('border-radius: 0;')
  && preRule.includes('box-shadow: none;'))
ok('横向滚动容器在 pre 上、不在 __body 上',
  preRule.includes('overflow-x: auto;') && !bodyRule.includes('overflow-x'))
ok('卡片内字号不写死 px（跟随 --md-code-size）',
  bodyRule.includes('font-size: var(--md-code-size);'))
ok('卡片内 pre/code 字号 inherit（避免二次缩放）',
  has('css', '.kb-code-card__body pre code { background: none; padding: 0; font-size: inherit; font-family: inherit; }'))

// ── ⑦ 折叠几何：公式含形态补偿，不含滚动条补偿 ────────────────────────────────────
ok('折叠 max-height 由「行数 × 行高 × 字号 + 上内边距 + 形态补偿」算出',
  foldRule.includes('var(--kb-card-fold-lines, 12)')
  && foldRule.includes('var(--kb-code-line-h)')
  && foldRule.includes('var(--md-pre-pad)')
  && foldRule.includes('var(--kb-card-head-extra)'))
ok('折叠高度不含任何「滚动条 px 补偿」（实测两头都错）',
  !/\d+px/.test(foldRule) && foldRule.includes('overflow: hidden'))
ok('形态 B 的胶囊带 = 20px（36px 上内边距 − 16px --md-pre-pad）',
  has('css', '--kb-card-head-extra: 20px') && preRule.includes('padding-top: 36px;'))
ok('折叠态不给横滚（长行右侧截断）',
  has('css', '.kb-code-card.is-folded .kb-code-card__body pre { overflow-x: hidden; }'))
ok('行高显式给出（normal 进不了 calc）', /--kb-code-line-h: [\d.]+;/.test(bodyRule))

// ── ⑧ 胶囊显隐 / 纯图标 / 键盘可达 ──────────────────────────────────────────────
ok('胶囊隐藏态用 opacity（不用 visibility / display）',
  actsRule.includes('opacity: 0;') && !actsRule.includes('visibility') && !actsRule.includes('display: none'))
ok('胶囊 :hover / :focus-within 显现',
  has('css', '.kb-code-card:hover .kb-code-card__acts,')
  && has('css', '.kb-code-card:focus-within .kb-code-card__acts { opacity: 1; }'))
ok('没有「换行开着就常显」那一档（第二轮回拍板否掉）',
  !/is-wrap[^{]*\.kb-code-card__acts/.test(code.css))
ok('纯图标：按钮内的 span 隐藏',
  has('css', '.kb-code-card__act span { display: none; }'))
ok('纯图标下 title / aria-label 齐全（语义唯一来源）',
  has('md', 'aria-label="复制代码"') && has('md', 'aria-label={wrap ?') && has('md', 'title="复制纯代码（不含围栏与高亮标记）"'))

// ── ⑨ 优先级：卡片规则必须在基础 pre 规则之后 ─────────────────────────────────────
const iBase = code.css.indexOf(':is(.prose-content, .kb-md-atom) pre {')
const iCardCss = code.css.indexOf('.kb-code-card {')
ok('基础 pre 规则仍在（第 340 行那条，一个字都不动）',
  has('css', ':is(.prose-content, .kb-md-atom) pre {')
  && has('css', 'padding: var(--md-pre-pad); border-radius: var(--radius-card); overflow-x: auto;'))
ok('卡片规则位于基础 pre 规则之后（特异性同为 1 类 + 1 元素，靠后来者胜）',
  iBase !== -1 && iCardCss !== -1 && iBase < iCardCss)

// ── ⑩ 动效：铁律 13（只动 transform / opacity）+ reduced-motion 兜底 ──────────────
ok('卡片动画只动 transform / opacity（无 transition-all）',
  !/\.kb-code-card[^{]*\{[^}]*transition-all/.test(code.css))
// 取**含 .kb-code-card 的那一段** reduced-motion 块。原先写的是「取最后一段」——那假设
// 本方案的块永远是文件末尾最后一块；后续方案继续往末尾追加自己的块（2026-10-14 生图卡 K 段）
// 就会让这条断言误判。改成按内容找：块边界用大括号配平，不依赖"谁在后面"。
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
const rmBlock = rmStarts.map(s => cssBlockAt(s)).find(b => b.includes('.kb-code-card')) ?? ''
ok('卡片过渡带 prefers-reduced-motion 兜底',
  rmBlock.includes('.kb-code-card__acts'))

// ── ⑪ 生效面：三面开卡片、工件栏不开 ────────────────────────────────────────────
ok('AI 教学中栏传 codeBlockChrome="card"', has('teach', 'codeBlockChrome="card"'))
ok('AI 教学侧车传 codeBlockChrome="card"', has('side', 'codeBlockChrome="card"'))
ok('全局面板 MessageList 传 codeBlockChrome="card"', has('list', 'codeBlockChrome="card"'))
ok('流式面传 card + streaming', has('stream', 'codeBlockChrome="card" streaming'))
ok('工件栏不传（md 页签按文档渲染）', !has('artifacts', 'codeBlockChrome'))
ok('知识库 / 阅读态等处不传（默认档零变化）',
  count(code.md, 'codeBlockChrome') > 0 && !has('css', '.prose-content .kb-code-card'))

// ── ⑫ 去气泡（改后 B）：助手侧与 AI 教学统一，且四样防线一个都不能丢 ──────────────
const listAssistant = code.list.slice(code.list.indexOf("{m.role === 'assistant' ? ("), code.list.indexOf(') : ('))
ok('助手容器不再有气泡的 5 个类',
  !listAssistant.includes('bg-[var(--bg-secondary)]')
  && !listAssistant.includes('rounded-lg')
  && !listAssistant.includes('px-3 py-2')
  && !listAssistant.includes('mr-6')
  && !/border border-\[var\(--border-color\)\]/.test(listAssistant))
ok('助手容器保留 select-text（body 全局 user-select:none）', listAssistant.includes('select-text'))
ok('助手容器保留宽内容安全网',
  listAssistant.includes('[&_pre]:overflow-x-auto [&_pre]:max-w-full')
  && listAssistant.includes('[&_table]:block [&_table]:overflow-x-auto'))
ok('外层 group/msg 宿主仍在（操作条 group-hover/msg 依赖）', has('list', 'className="group/msg"'))
ok('data-msg-id 定位属性仍在', has('list', 'data-msg-id={m.id ?? undefined}'))
ok('用户气泡换成 AI 教学那套（accent 底 + 右对齐 + 小尾角 + max-w-86%）',
  has('list', 'bg-[var(--accent)] text-white rounded-xl rounded-br-sm')
  && has('list', 'max-w-[86%]')
  && has('list', '<div className="flex justify-end">'))
ok('用户气泡旧样式已消失（bg-selected + ml-6 + rounded-lg）',
  !has('list', 'bg-[var(--bg-selected)]') && !has('list', 'ml-6 px-3 py-2 rounded-lg'))
ok('助手操作条去掉 mr-6（否则与正文左缘错开 24px）',
  /justify-start -ml-1\.5/.test(code.list) && !/justify-start mr-6/.test(code.list))
ok('助手操作条仍按行区分（user 右 / assistant 左）',
  has('list', "m.role === 'user' ? 'justify-end' : 'justify-start -ml-1.5'"))

console.log(`\nverify-code-block-card: ${pass} PASS / ${fail} FAIL`)
if (fail) { console.log('\n失败项：'); for (const f of fails) console.log('  x ' + f) }
process.exit(fail ? 1 : 0)
