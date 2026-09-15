/**
 * 契约验证：AI 教学「画像更新建议」横幅的「预览 / 忽略」两处缺陷修复（v3.2.0 条目 ⑦）。
 *
 * 为什么需要它：
 *   这条缺陷的**两个根因各自都是「一眼看不出坏」的写法**，回归时也一样静默：
 *     ① **样式根因**：两个控件一行 className 之差（有/无边框）。少一个边框类就退回
 *        「前三个是按钮、后两个是灰字」的老现象，而 TS 与构建都不会报一声。
 *     ② **功能根因**：`onClick` 里那次滚动定位是**能执行、不报错、也没效果**的空操作
 *        （横幅在消息滚动容器之外，是输入区上方的页脚带，最近可滚动祖先为零 → 浏览器什么也不做）。
 *        修完若不钉住，很容易被后续重构「顺手退回」成滚动定位。
 *     ③ 受控化之后真正的风险是**退化成单向开关**（置 true 而非取反）——那样按钮点一次就
 *        再也收不起来，而验证 ② 要求的正是「再点 → 收起」。
 *
 * 做法：本条是**纯交互 UI**（无可抽的纯函数），故以**结构断言**为主（同 verify-ask-collapse.mjs 的先例）；
 *   另用**切片真实代码**补两处只有真跑才看得出的判定 —— ① 真正二态切换的 updater（从源码里抽出
 *   表达式再求值，而不是重打一遍字面量）；② 重置 effect 确实重置的是 `profPreviewOpen`
 *   （它与 `profDismissed` 的 effect 依赖数组相同、都写 `[messages]`，交换了也不会报错）。
 *
 * ⚠️ 本脚本的头号坑（上个条目刚踩过、这里又踩了一次）：**所有负向与计数断言都必须先剥注释** ——
 *   修复代码旁边的说明注释里就**引用**了旧写法的 `scrollIntoView` / `data-profile-document` 等字面量，
 *   不剥注释就会把「注释里的旧写法」当成「代码里还有旧写法」而**假失败**。
 *   注意剥注释必须**感知字符串**（否则 `'https://…'` 里的 `//` 会把整行截断，反而漏掉真问题）。
 *
 * 运行（项目根目录）：
 *   node --no-warnings .AGENT/scripts/ai-teaching/verify-profile-banner.mjs [仓库路径]
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
const raw = fs.readFileSync(path.join(ROOT, REL), 'utf8')

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

/** 感知字符串字面量的注释剥离（保偏移不变是不可能的——注释被删了，故定位一律在剥离后的文本上做）。 */
const stripComments = (s) => {
  let out = ''
  let i = 0
  let mode = null // null | "'" | '"' | '`' | '//' | '/*'
  while (i < s.length) {
    const c = s[i]
    const n = s[i + 1]
    if (mode === null) {
      if (c === '/' && n === '/') { mode = '//'; i += 2; continue }
      if (c === '/' && n === '*') { mode = '/*'; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { mode = c; out += c; i++; continue }
      out += c; i++; continue
    }
    if (mode === '//') { if (c === '\n') { mode = null; out += c } i++; continue }
    if (mode === '/*') { if (c === '*' && n === '/') { mode = null; i += 2 } else i++; continue }
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue }
    if (c === mode) mode = null
    out += c; i++
  }
  return out
}

/** 按依赖数组 (+ 可选函数体特征) 定位第一个匹配的 useEffect。 */
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
  throw new Error(`找不到依赖匹配 ${depsRe} 的 useEffect`)
}

// ------------------------------------------------------------------ 剥注释后再定位（负向断言的前提）
const src = stripComments(raw)
check('剥注释后源码显著变短（说明注释确实被剥掉了，负向断言才有意义）',
  src.length < raw.length, `raw=${raw.length} stripped=${src.length}`)

const BS = src.indexOf('{profileSuggestion && !profDismissed && (')
// 结束边界 = 紧随其后的「输入区外壳」开标签。⚠️ 这个锚点是**样式类**，会随输入区改版而失效
//（条目 ⑧ 气泡化把外壳从 `border-t … p-2 bg-secondary` 换成了 `px-3 pb-2.5 pt-2`），
// 故同时列出新旧两种写法，取落在 BS 之后的第一个，避免下次改版又整段断言假失败。
const SHELL_ANCHORS = [
  '<div className="shrink-0 px-3 pb-2.5 pt-2">',
  '<div className="shrink-0 border-t border-[var(--border-color)] p-2 bg-[var(--bg-secondary)]">',
]
const BE = SHELL_ANCHORS
  .map((s) => src.indexOf(s, BS))
  .filter((i) => i > BS)
  .sort((a, b) => a - b)[0] ?? -1
check('能定位到横幅区块（锚点：profileSuggestion 条件 + 紧随其后的输入区）', BS > -1 && BE > BS,
  `BS=${BS} BE=${BE}`)
const banner = BS > -1 && BE > BS ? src.slice(BS, BE) : ''

// ------------------------------------------------------------------ 根因 1：按钮样式
console.log('\n[根因 1：两个控件没有按钮样式]')
/** 按「按钮正文文字或 onClick 特征」取出一个 <button …>…</button> 片段。 */
const grabButton = (needle) => {
  const at = banner.indexOf(needle)
  if (at < 0) return ''
  const start = banner.lastIndexOf('<button', at)
  const end = banner.indexOf('</button>', at)
  return start < 0 || end < 0 ? '' : banner.slice(start, end + 9)
}
const btnIgnore = grabButton('>忽略</button>')
const btnPreview = grabButton('setProfPreviewOpen(v => !v)')
check('能定位到「忽略」「预览」两个按钮', !!btnIgnore && !!btnPreview,
  `ignore=${btnIgnore.length}B preview=${btnPreview.length}B`)
check('【红线】「预览」有描边（border border-[var(--border-color)]）',
  /border border-\[var\(--border-color\)\]/.test(btnPreview), btnPreview.slice(0, 200))
check('【红线】「忽略」有描边 —— 不再像禁用灰字',
  /border border-\[var\(--border-color\)\]/.test(btnIgnore), btnIgnore.slice(0, 200))
check('两者都有真 hover 反馈（hover:bg-[var(--bg-hover)]）',
  /hover:bg-\[var\(--bg-hover\)\]/.test(btnPreview) && /hover:bg-\[var\(--bg-hover\)\]/.test(btnIgnore))
check('两者都是真 <button type="button">（不会被当成 submit）',
  /<button type="button"/.test(btnPreview) && /<button type="button"/.test(btnIgnore))
check('保留小尺寸 px-1.5 py-0.5（不与主操作「接受」抢视觉权重）',
  /px-1\.5 py-0\.5/.test(btnPreview) && /px-1\.5 py-0\.5/.test(btnIgnore))
check('「忽略」观感仍弱于「预览」（次级中的次级）：正文色用 --text-muted',
  /text-\[var\(--text-muted\)\]/.test(btnIgnore) && !/text-\[var\(--text-muted\)\]/.test(btnPreview))
check('【红线】旧的无描边写法不得回退（`rounded-md text-[11px] text-[var(--text-muted)] hover:bg-…`）',
  !/rounded-md text-\[11px\] text-\[var\(--text-muted\)\] hover:bg-\[var\(--bg-hover\)\]/.test(banner))
const acceptWs = (banner.match(/border border-\[var\(--accent\)\]\/50/g) || []).length
check('同排「接受（工作区/全局）」仍是 accent 描边（对照组存在，故不是把全排都涂成灰底）',
  acceptWs >= 2, `found ${acceptWs}`)

// ------------------------------------------------------------------ 根因 2：预览的动作
console.log('\n[根因 2：「预览」原本是空操作]')
const SCROLL_API = 'scrollIntoView'
const DQ = 'document.querySelector'
const HOOK = 'data-profile-' + 'suggestion'
check('【红线】横幅里不再有滚动定位调用（零可滚动祖先上它什么也不做）',
  !banner.includes(SCROLL_API))
check('【红线】横幅里不再有全文档查找（跨组件脆弱点）', !banner.includes(DQ))
const scrollCount = (src.match(/scrollIntoView/g) || []).length
check('全文件滚动定位调用只剩锚点跳转一处（原为 2 处）', scrollCount === 1, `实际 ${scrollCount} 处`)
check('那个只为旧查找服务的 data 钩子已随之删除', !src.includes(HOOK))
check('不再依赖原生折叠元素（受控 state 才能让按钮文案与展开态一致）',
  !/<details/.test(banner) && !/<summary/.test(banner))

// ------------------------------------------------------------------ 受控展开
console.log('\n[受控展开 / 收起]')
check('新增受控 state profPreviewOpen（与 profDismissed 同款重置写法）',
  /const \[profPreviewOpen, setProfPreviewOpen\] = useState\(false\)/.test(src) &&
  /const \[profDismissed, setProfDismissed\] = useState\(false\)/.test(src))
check('按钮 onClick 走 setProfPreviewOpen（不再是滚动定位）',
  /onClick=\{\(\) => setProfPreviewOpen\(/.test(banner))
check('有 aria-expanded 暴露展开态', /aria-expanded=\{profPreviewOpen\}/.test(banner))
check('展开内容走 Collapsible（.kb-collapse 封装，铁律 13 的面板开合令牌）',
  /<Collapsible open=\{profPreviewOpen\}/.test(banner))
check('折叠子树用**函数**形式传入（Collapsible 契约：收起态不挂载子树）',
  /<Collapsible open=\{profPreviewOpen\}[^>]*>\s*\{\(\) => \(/.test(banner))
check('【红线】展开内容不得写成 {profPreviewOpen && …}（那样展开动画没有起始态可过渡）',
  !/\{profPreviewOpen && \(/.test(banner))
check('未另造过渡：横幅里不出现 transition-all / 手写 grid-template-rows 过渡',
  !banner.includes('transition-all') && !banner.includes('transition-[grid-template-rows]'))
check('内容仍是 max-h-40 内滚的 pre（长画像不撑高页脚带）',
  banner.includes('max-h-40 overflow-y-auto') && banner.includes('<pre'))
check('长文案「建议内容全文」未丢失（铁律 12：文案只收不删，收进 title）',
  banner.includes('建议内容全文'))

// ------------------------------------------------------------------ 行为切片
console.log('\n[行为：真二态切换 与 重置 effect]')
const um = banner.match(/setProfPreviewOpen\(([^;]*?)\)\}\s*aria-expanded/)
check('能从源码里抽出「预览」的 updater 表达式', !!um, um ? um[1] : '(未匹配)')
const updater = um ? new Function(`return (${um[1]})`)() : null
check('【红线】「预览」是真二态切换（再点能收起，不是单向置 true）',
  typeof updater === 'function' && updater(false) === true && updater(true) === false)

// 只认「按钮正文位置」的文案三元 —— title 里也有一个同形状的三元，不锚定 </button> 会抓错那个
// 捕获组：1 = 整个三元表达式，2 = 展开态文案，3 = 收起态文案
const lm = banner.match(/>\{(profPreviewOpen \? '([^']+)' : '([^']+)')\}<\/button>/)
check('按钮文案随展开态切换（收起 ↔ 预览）',
  !!lm && lm[2] === '收起' && lm[3] === '预览', lm ? `${lm[2]} / ${lm[3]}` : '(未匹配)')

const reset = sliceEffect(src, /^},\s*\[messages\]\)$/, /setProfPreviewOpen\(false\)/)
check('重置 effect 的依赖确实是 [messages]', /\[messages\]/.test(reset.deps), reset.deps)
// 真跑一遍：把「重置的是哪个 state」钉死 —— 两条 effect 依赖同名，交换了不会报错
const harness = stripTypeScriptTypes(
  `
let called = []
const setProfPreviewOpen = (v) => called.push(['profPreviewOpen', v])
const setProfDismissed = (v) => called.push(['profDismissed', v])
export const api = { run() { called = []; ${reset.body}; return called } }
`,
  { mode: 'transform' }
)
const tmpDir = path.join(ROOT, 'tmp', 'verify-profile-banner')
fs.mkdirSync(tmpDir, { recursive: true })
const tmpFile = path.join(tmpDir, `pb-${Date.now().toString(36)}.mjs`)
fs.writeFileSync(tmpFile, harness, 'utf8')
const { api } = await import(pathToFileURL(tmpFile).href)
const effectCalls = api.run()
check('重置 effect 真调用的是 setProfPreviewOpen(false)（两条同名依赖的 effect 没被写反）',
  effectCalls.length === 1 && effectCalls[0][0] === 'profPreviewOpen' && effectCalls[0][1] === false,
  JSON.stringify(effectCalls))

// ------------------------------------------------------------------ 报告
const failed = checks.filter(c => !c.pass)
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  — ' + c.detail : ''}`)
}
console.log(`\n合计 ${checks.length} 项：PASS ${checks.length - failed.length} / FAIL ${failed.length}`)
try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
try { fs.rmdirSync(tmpDir) } catch { /* ignore */ }
process.exit(failed.length === 0 ? 0 : 1)
