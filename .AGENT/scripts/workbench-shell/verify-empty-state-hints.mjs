/**
 * 契约脚本：工作台空态指令提示（v3.5.0，2026-10-13）
 *
 * 覆盖的缺陷面：
 *   ① **动作实现被抄第二份** —— 空态三条（打开命令面板 / 快速打开文件 / AI 助手）各自的
 *      动作本来就有别的调用方（前两条 = 全局快捷键监听，第三条 = Ctrl+J 路由）。若哪天有人
 *      图省事把 `update('workbenchLayout', …)` 或 `setPalette(…)` 内联进提示的 run 里，
 *      快捷键与提示就会各自演化、权重与折叠判定必然漂移。故这里既断正向调用，也断
 *      **负向内联**（内联翻转必须全文件恰 1 次 = 那个 useCallback 内部）。
 *   ② 三条提示混进重复入口 —— 判据是「界面上看不见的能力」；「打开 笔记 / AI教学 / 日程」
 *      在活动栏、左栏书签、右栏磁贴区已有三处可见入口，进空态只是噪音。负向锁住。
 *      同理「打开命令面板」不许进命令面板自身（自指）。
 *   ③ 空态图标口径被顺手改掉 —— 44px / strokeWidth 1.2 是 2026-09-19 拍板的外观基线，
 *      本次只是「图标下加三行」，不是重画空态。
 *   ④ 自造动效 —— 必须复用 `.kb-item-in`（其 reduced-motion 兜底已在 styles/index.css
 *      的统一清单里）；禁 `transition-all`、禁组件内自建 keyframes。
 *   ⑤ **总空态变死角**（2026-10-13 实测发现）—— 提示只在总空态挂，而笔记模块是 `PAGE_OWNED`
 *      （无页面时页面条上**不出现条目**），左上角「工作台」按钮在工作台内模块态又是幂等 no-op
 *      ⇒ 关掉最后一个页面后就**再也回不到总空态**，那三条提示等于长期看不到。E 组断言锁住
 *      「笔记模块空态必有『回工作台』出口」这条接线，以及「PAGE_OWNED 仍只有 knowledge」
 *      这一前提（多一个模块变成 PAGE_OWNED 就得同步补同样的出口）。
 *
 * 用法：
 *   node .AGENT/scripts/workbench-shell/verify-empty-state-hints.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 仓库根按脚本自身位置解析（不写死绝对路径 —— 写死会把「在 worktree 里跑」变成静默校验主仓）
const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  return false
}

/** 只剥注释、保留字符串字面量（与 verify-workbench-shell 同一份状态机实现，负向断言依赖它） */
function stripComments(src) {
  let out = ''
  let st = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (st === 'code') {
      if (c === '/' && n === '/') { st = 'line'; i++; out += '  '; continue }
      if (c === '/' && n === '*') { st = 'block'; i++; out += '  '; continue }
      if (c === "'") st = 'sq'; else if (c === '"') st = 'dq'; else if (c === '`') st = 'tpl'
      out += c; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c } else out += ' '; continue }
    if (st === 'block') { if (c === '*' && n === '/') { st = 'code'; i++; out += '  ' } else out += c === '\n' ? '\n' : ' '; continue }
    if (st === 'sq' || st === 'dq' || st === 'tpl') {
      if (c === '\\') { out += c + (n ?? ''); i++; continue }
      if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) st = 'code'
      out += c; continue
    }
  }
  return out
}
const count = (src, ident) => (src.match(new RegExp(`\\b${ident}\\b`, 'g')) || []).length

const srcAppRaw = read('src/App.tsx')
const srcApp = stripComments(srcAppRaw)
const srcEmpty = stripComments(read('src/components/workbench/WorkbenchEmptyState.tsx'))
const srcCss = read('src/styles/index.css')

/* ================= A. 空态组件（纯展示 + 外观基线） ================= */
console.log('\n=== A. WorkbenchEmptyState 组件面 ===')
ok(/export function WorkbenchEmptyState\(\{ hints \}: Props\)/.test(srcEmpty),
  'A1 组件按 hints 注入渲染（同 CommandPalette 收 items 的范式）')
ok(!/\buse(State|Effect|Callback|Ref|Memo)\b/.test(srcEmpty),
  'A2 负向：组件是纯展示 —— 不持状态、不接快捷键、不做 memo')
ok(!/Ctrl/.test(srcEmpty),
  'A3 负向：键位文案不在组件里（由 App 的 buildEmptyHints 注入，避免两处各记一套键）')
ok(/<button[\s\S]{0,500}?className="kb-item-in/.test(srcEmpty),
  'A4 提示行是真的 <button>（可点击 / 可聚焦 / 可键盘触达），且挂 kb-item-in')
ok(/animationDelay: `\$\{i \* 70\}ms`/.test(srcEmpty),
  'A5 三条逐条错开入场（animationDelay = i * 70ms）')
ok(/min-h-0 max-h-full[\s\S]{0,80}?overflow-hidden/.test(srcEmpty) && /shrink-0 text-\[var\(--text-disabled\)\]/.test(srcEmpty),
  'A6 矮中心区兜底 = min-h-0 + max-h-full + overflow-hidden，且图标 shrink-0（只裁提示底部，图标恒在）')
ok(/data-wb="empty"[\s\S]{0,220}?"absolute inset-y-0 left-0 z-20 flex w-full flex-col items-center justify-center/.test(srcEmpty),
  'A7 外层保持绝对定位铺满主栏（不参与 flex 流，加三行不挤动两栏几何）')
ok(/<AppWindow size=\{44\} strokeWidth=\{1\.2\}/.test(srcEmpty),
  'A8 空态图标沿用 2026-09-19 基线（44px / strokeWidth 1.2），本次没重画空态')
ok(/data-wb="emptyHints"/.test(srcEmpty) && /data-wb-hint=\{h\.id\}/.test(srcEmpty),
  'A9 探针锚点在场：emptyHints（提示块）+ data-wb-hint（逐条）')
ok(/h\.keys\.map\(\(k\) => \([\s\S]{0,200}?<kbd/.test(srcEmpty),
  'A10 键帽逐枚渲染（Ctrl / Shift / P 各自一枚，不是一串文本）')
ok(!/@keyframes|<style/.test(srcEmpty) && !/transition-all/.test(srcEmpty),
  'A11 负向：不自造动效、不用 transition-all 凑（复用既有令牌）')
// ★ 2026-10-13 放宽一次（口径不变、名单加一项）：本条要防的是「牵入别的**动效**令牌类」，
//   而键帽现在走 .kb-kbd —— 它是颜色基线类（对比度修复，见 theme-contrast 契约），不是动效。
const tokenCls = (srcEmpty.match(/kb-(?!item-in\b)(?!kbd\b)[a-z-]+/g) || [])
ok(tokenCls.length === 0,
  'A12 负向：组件只消费 kb-item-in（动效）与 kb-kbd（键帽颜色基线）两个令牌类，不牵入其它', tokenCls.join(','))

/* ================= B. App 接线（动作唯一真相源） ================= */
console.log('\n=== B. App.tsx 接线 ===')
for (const fn of ['openCommandPalette', 'openQuickOpen', 'toggleWorkbenchAi']) {
  ok(new RegExp(`const ${fn} = useCallback\\(`).test(srcApp),
    `B1 ${fn} 以 useCallback 定义（唯一真相源）`)
  ok(count(srcApp, fn) >= 3,
    `B2 ${fn} 至少 3 处引用（定义 + 快捷键/路由 + 空态提示）`, `实际 ${count(srcApp, fn)}`)
}
// 负向内联：面板翻转只能各有 1 处（= 那两个 useCallback 内部）
const inlinePalette = (srcApp.match(/setPalette\(\(p\) => \(p === '(command|file)' \? null : '\1'\)\)/g) || []).length
ok(inlinePalette === 2,
  'B3 负向：命令面板 / 快速切换器的 setPalette 翻转全文件恰 2 处（都在 useCallback 里，快捷键与提示不再各写一份）',
  `实际 ${inlinePalette}`)
const inlineAiOpen = (srcApp.match(/const open = !wbLayout\.rightCollapsed && wbLayout\.rightTab === 'ai'/g) || []).length
ok(inlineAiOpen === 1,
  'B4 负向：右栏 AI 开合判定全文件恰 1 处（Ctrl+J 路由只剩「拦默认 + 调函数」）', `实际 ${inlineAiOpen}`)
// Ctrl+J 路由 effect 的窗口：锚在按键判定那行（注释已被剥掉，不能拿注释定位）
const jIdx = srcApp.indexOf("e.key.toLowerCase() === 'j'")
const jEffect = jIdx === -1 ? '' : srcApp.slice(Math.max(0, jIdx - 300), jIdx + 600)
ok(/if \(fullWindowTab\) return/.test(jEffect) && /toggleWorkbenchAi\(\)/.test(jEffect)
  && !/update\('workbenchLayout'/.test(jEffect) && !/ai-assistant:close/.test(jEffect),
  'B5 Ctrl+J effect 只做路由（整窗模块让位 + 拦默认），动作本体与 ai-assistant:close 全在 toggleWorkbenchAi 里')
ok(/\}, \[fullWindowTab, toggleWorkbenchAi\]\)/.test(srcApp),
  'B5b Ctrl+J effect 依赖数组只剩 [fullWindowTab, toggleWorkbenchAi]（不再订阅 wbLayout）')
ok(/openCommandPalette\(\)/.test(srcApp) && /openQuickOpen\(\)/.test(srcApp)
  && /palette, changeZen, openCommandPalette, openQuickOpen\]/.test(srcApp),
  'B6 全局快捷键监听改调这两个动作，且依赖数组同步')
ok(/<WorkbenchEmptyState hints=\{buildEmptyHints\(\)\} \/>/.test(srcApp),
  'B7 空态渲染换成 <WorkbenchEmptyState hints={buildEmptyHints()} />')
ok(!/<AppWindow/.test(srcApp),
  'B8 负向：图标已搬进组件，App.tsx 不再直接渲染 AppWindow（不留两套空态外观）')
ok(/import \{ WorkbenchEmptyState, type WorkbenchHint \} from '\.\/components\/workbench\/WorkbenchEmptyState'/.test(srcApp),
  'B9 组件与 WorkbenchHint 类型同源引入（App 组装时受类型约束）')

/* ================= C. 三条内容（文案 / 键位 / 动作绑对） ================= */
console.log('\n=== C. 三条提示的内容与绑定 ===')
const hintRows = [
  ['palette', '打开命令面板', "\\['Ctrl', 'Shift', 'P'\\]", 'Command', 'openCommandPalette'],
  ['quick-open', '快速打开文件', "\\['Ctrl', 'O'\\]", 'FileSearch', 'openQuickOpen'],
  ['ai-assistant', 'AI 助手', "\\['Ctrl', 'J'\\]", 'Bot', 'toggleWorkbenchAi'],
]
for (const [id, label, keys, icon, run] of hintRows) {
  const re = new RegExp(`id: '${id}', label: '${label}', keys: ${keys}, icon: <${icon} size=\\{15\\} />, run: ${run}`)
  ok(re.test(srcApp), `C1 ${label} = ${keys.replace(/[\\[\]]/g, '').replace(/'/g, '')} -> ${run}（文案/键位/图标/动作四项绑对）`)
}
const bhAt = srcApp.indexOf('const buildEmptyHints = ')
const bhBody = bhAt === -1 ? '' : srcApp.slice(bhAt, srcApp.indexOf('const buildCommandItems'))
ok(bhBody.length > 0 && (bhBody.match(/id: '/g) || []).length === 3,
  'C2 buildEmptyHints 恰三条（不多不少）', `实际 ${(bhBody.match(/id: '/g) || []).length}`)
ok(!/label: '打开 /.test(bhBody),
  'C3 负向：不放模块跳转项（「打开 笔记 / AI教学 / 日程」已有图标条 + 左栏书签 + 右栏磁贴三处入口，进空态是重复噪音）')
const bcAt = srcApp.indexOf('const buildCommandItems = ')
const bcBody = bcAt === -1 ? '' : srcApp.slice(bcAt, bcAt + 4000)
ok(!/打开命令面板|快速打开文件|AI 助手/.test(bcBody),
  'C4 负向：这三条不进命令面板清单（面板里出现「打开命令面板」是自指）')

/* ================= D. 动效基建复用（不新增 CSS） ================= */
console.log('\n=== D. 动效基建复用 ===')
const rmIdx = srcCss.indexOf('/* --- 统一 reduced-motion 兜底 --- */')
const rmBlock = rmIdx === -1 ? '' : srcCss.slice(rmIdx, rmIdx + 700)
ok(/\.kb-item-in/.test(rmBlock),
  'D1 .kb-item-in 在 styles/index.css 的统一 reduced-motion 兜底清单内（本功能一行 CSS 不加）')
ok(/@keyframes kb-item-in/.test(srcCss) && /\.kb-item-in \{ animation: kb-item-in var\(--dur-std\) var\(--ease-kb\) backwards/.test(srcCss),
  'D2 .kb-item-in 仍走 --dur-std / --ease-kb 令牌（backwards 填充没被改成 both）')
ok(!/kb-empty/.test(srcCss),
  'D3 负向：没有为本次新增专用类（空态提示只组合既有工具类与 Tailwind 原子类）')

/* ================= E. 笔记模块空态的「回工作台」出口（离开死角的唯一路径） ================= */
console.log('\n=== E. 笔记模块空态的出口 ===')
const srcKnowledge = stripComments(read('src/modules/knowledge/index.tsx'))
const srcPageBar = stripComments(read('src/components/workbench/WorkbenchPageBar.tsx'))
ok(/export const PAGE_OWNED: readonly string\[\] = \['knowledge'\]/.test(srcPageBar),
  'E1 前提仍然成立：PAGE_OWNED 仍只有 knowledge（多一个模块变成 PAGE_OWNED 就得补同样的出口）',
  'PAGE_OWNED 变了 —— 请同步给该模块空态加「回工作台」并更新本文断言')
ok(/<FileText size=\{48\} className="opacity-25" \/>[\s\S]{0,700}?onBackToWorkbench/.test(srcKnowledge),
  'E2 笔记模块空态（无活动页面分支）里挂了「回工作台」按钮')
ok(/onBackToWorkbench &&/.test(srcKnowledge) && /<House size=\{14\} \/>[\s\S]{0,80}?回工作台/.test(srcKnowledge),
  'E3 按钮 = House 图标 + 「回工作台」文案，且 prop 缺失时整块不渲染（可选 prop 不影响它用）')
ok((srcKnowledge.match(/回工作台/g) || []).length === 1,
  'E4 负向：该入口只出现一次（不在有页面时也渲染）', `实际 ${(srcKnowledge.match(/回工作台/g) || []).length}`)
ok(!/WorkbenchEmptyState|打开命令面板/.test(srcKnowledge),
  'E5 负向：笔记模块空态**不挂**那三条提示（2026-10-13 口径：提示只属于总空态）')
ok(/onBackToWorkbench=\{\(\) => \{ setActiveToolTab\(null\); setActiveTab\(null\); setRailModule\(null\) \}\}/.test(srcApp),
  'E6 App 传的出口 = 与「工作台」按钮同口径的三态落 null（不顺手解锁左栏）')
ok(/className="kb-item-in flex items-center gap-1\.5 rounded-md[\s\S]{0,200}?transition-colors/.test(srcKnowledge),
  'E7 按钮复用既有令牌（kb-item-in 入场 + transition-colors hover），不新造动效')

/* ================= 汇总 ================= */
console.log('\n========================================')
if (fails.length === 0) {
  console.log(`PASS  全部通过：${pass} 项断言`)
  process.exit(0)
}
console.log(`FAIL  ${fails.length} 项未通过（PASS ${pass}）：`)
for (const f of fails) console.log('  - ' + f)
process.exit(1)
