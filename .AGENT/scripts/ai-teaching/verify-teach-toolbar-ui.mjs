#!/usr/bin/env node
/**
 * AI 教学 · 中栏 UI 改版（2026-11-22 A 线）契约。
 *
 * 锁住四条结构性不变量（方案 `tmp/ai-teach-toolbar/PLAN.md` §2 / §3 / §4 / §6）：
 *   1. 顶栏右侧**只有一枚**「打开右侧栏」图标（其余入口全部退役，右栏打开时不渲染）；
 *   2. 输入区「画像 / 要求」两枚 pill 与「思考 / 引用 / 模型」同处**一条抽屉**（整条收起，
 *      `grid-template-rows` 0fr ↔ 1fr 复用 `.kb-collapse`）；抓手在折叠容器**之外**，
 *      带 `aria-expanded` / `aria-controls` 接线，无 `transition-all`；
 *   3. 段上下文条 / 章末复习条「要求」/ 本会话要求行内条 / 560px 模态 / 要求抽屉**零残留**；
 *   4. ```endcourse 围栏全对话**只渲染一张**卡，且结课后不渲染；
 *   5. 工件分栏的折叠/展开开关落在**工件栏页签条右端**（`PanelRightClose/Open` + `aria-expanded`），
 *      顶栏不恢复 chip、贴边条不动（2026-11-23：上一轮收敛顶栏时把唯一可见入口删掉了）。
 *
 * 2026-11-22 随死代码清理更新：`CourseProgress.tsx` / `RequirementsDrawer.tsx` 零 importer，文件已删除；
 * 原先「文件仍在（留作结课报告 / 本模块不再用）」的两条正向断言改为负向断言。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-teach-toolbar-ui.mjs
 * 只读源码做结构断言（不跑 dev / 不跑构建）——与库内其它 verify-*.mjs 同范式。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const mod = read('src/modules/ai-teaching/index.tsx')
const rail = read('src/modules/ai-teaching/CourseRail.tsx')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}
const slice = (src, from, to, label) => {
  const a = src.indexOf(from)
  const b = to ? src.indexOf(to, a) : -1
  if (a < 0 || b < 0 || b <= a) return ''
  return src.slice(a, b)
}
const count = (src, re) => (src.match(re) ?? []).length

/* ───────────────────────── 1. 顶栏：面包屑 + 一枚图标 ───────────────────────── */
console.log('\n[顶栏] 面包屑 + 一枚「打开右侧栏」')
const bar = slice(mod, 'v3.8.0 §二：顶栏瘦身', 'ref={rowRef}', 'top-bar')
check('顶栏片段可定位', bar.length > 200, `len=${bar.length}`)
check('顶栏 button 只有 2 个（面包屑 + 右栏图标）', count(bar, /<button/g) === 2, `实际 ${count(bar, /<button/g)}`)
check('右栏图标是内联 SVG 18×14', bar.includes('width="18" height="14" viewBox="0 0 18 14"'))
check('外框 16×12 起点 (1,1) rx=4', bar.includes('<rect x="1" y="1" width="16" height="12" rx="4"'))
check('分隔线 x=10.9', bar.includes('M10.9 1v12'))
check('描边 1.8', bar.includes('strokeWidth="1.8"'))
check('命中区 p-1 + data-tip 气泡', /className="p-1 [^"]*"[^>]*data-tip="打开右侧栏（Ctrl\+Alt\+B）"/.test(bar)
  || /data-tip="打开右侧栏（Ctrl\+Alt\+B）"[\s\S]{0,200}className="p-1 /.test(bar))
check('右栏打开时不渲染（!srcVisible 包裹）', /\{!srcVisible && \([\s\S]{0,400}viewBox="0 0 18 14"/.test(bar))
for (const gone of ['收尾本段', '课程进度', '工件分栏', '本会话约束', '本会话要求', '结课报告', '重新开课']) {
  check(`顶栏不再有「${gone}」按钮`, !bar.includes(`>${gone}`))
}
check('不再用 lucide PanelRightOpen（顶栏）', !mod.includes('PanelRightOpen'))

/* ───────────────────────── 2. 工具条：整条抽屉（.kb-collapse）+ 抓手 ───────────────────────── */
console.log('\n[工具条] 画像 / 要求与思考 / 引用 / 模型同处一条抽屉；抓手在折叠容器之外')
const pills = slice(mod, '输入区「画像 / 要求」pill（2026-11-22 A 线', 'const composerFooter', 'pills')
const tray = slice(mod, '{/* 卡下控件抽屉（2026-11-20', '{heroMode && (', 'tray')
const css = read('src/styles/index.css')
check('docPills 定义可定位', pills.length > 200)
check('pill 文案 = 画像 / 要求', pills.includes('画像') && pills.includes('要求'))
check('两枚 pill 都是 button', count(pills, /<button/g) === 2)
check('pill 有 aria-pressed（按下态）', count(pills, /aria-pressed=/g) === 2)
check('画像 pill 带待确认圆点（原顶栏圆点已迁入）', pills.includes('profPending') && pills.includes('rounded-full bg-[var(--warning)]'))
check('画像走 aiTeachProfileEnsureSession', pills.includes('aiTeachProfileEnsureSession'))
check('要求走冻结接口 aiTeachEnsureConstraints', pills.includes('aiTeachEnsureConstraints('))
check('打开方式 = 右栏笔记页签（requestViewer tab notes）', /requestViewer\(\{ tab: 'notes', relPath: r\.relPath/.test(pills))
check('会话夹未建立时给指引而非静默失败', pills.includes('先发一条消息，会话文件夹建立后再编辑'))
check('没有层选择 UI（无 ReqLayer / 层 chip）', !pills.includes('ReqLayer') && !pills.includes('layer'))

check('托盘片段可定位', tray.length > 300, `len=${tray.length}`)
check('折叠状态仍用 trayOpen（不新造状态）', tray.includes('trayOpen'))
check('折叠记忆键 aiTeach.composerTray 仍在', mod.includes("localStorage.getItem('aiTeach.composerTray')"))
const foldAt = tray.indexOf('kb-collapse${trayOpen')
const handleAt = tray.indexOf('className="kb-tray-handle"')
check('抽屉整体（含两枚 pill）收在一个 .kb-collapse 容器内', foldAt >= 0 && tray.indexOf('{docPills}') > foldAt, `fold@${foldAt}`)
check('折叠容器带 id = aiTeachComposerTray（aria-controls 的落点）', tray.includes('id="aiTeachComposerTray"'))
check('抓手在折叠容器之外（DOM 里先抓手、后折叠组）', handleAt >= 0 && foldAt > handleAt, `handle@${handleAt} / fold@${foldAt}`)
check('抓手是原生 button + aria-expanded 随 trayOpen', /<button[\s\S]{0,400}aria-expanded=\{trayOpen\}/.test(tray))
check('抓手 aria-controls 指向折叠容器 id', tray.includes('aria-controls="aiTeachComposerTray"'))
check('抓手有中文 aria-label / data-tip（两态各一句）', tray.includes("data-tip={trayOpen ? '收起控件条' : '展开控件条'}")
  && tray.includes("aria-label={trayOpen ? '收起控件条' : '展开控件条'}"))
check('折叠只走 .kb-collapse 令牌（不写内联 height / max-height 过渡）',
  !/transition-\[[^\]]*(?:height|max-height)/.test(tray) && !/max-h-\[34/.test(tray))
check('工具条无 transition-all', !tray.includes('transition-all'))
check('托盘条淡出走 opacity（不再用 translate-y 位移折叠）', tray.includes('transition-opacity') && !/translate-y-\[12px\]/.test(tray))
check('抓手脉冲 .kb-tray-hint 落在 index.css（只动 transform）',
  /\.kb-tray-grip\.kb-tray-hint \{ animation: kb-tray-hint/.test(css)
  && !/@keyframes kb-tray-hint[\s\S]{0,300}(?:height|width)\s*:/.test(css))
check('reduced-motion 关闭抓手过渡与脉冲',
  /prefers-reduced-motion: reduce[\s\S]{0,900}\.kb-tray-grip \{ transition: none; \}/.test(css)
  && /prefers-reduced-motion: reduce[\s\S]{0,900}\.kb-tray-grip\.kb-tray-hint \{ animation: none; \}/.test(css))
check('思考四档带 aria-pressed', count(tray, /aria-pressed=\{convoEffort === e\}/g) === 1)
check('引用按钮带 aria-pressed', count(tray, /aria-pressed=\{quotesOpen && quotes\.length > 0\}/g) === 1)
check('模型仍在最右（flex-1 占位后）', /<span className="flex-1" \/>[\s\S]{0,400}openModelMenu/.test(tray))

/* ───────────────────────── 3. 段条 / 行内要求条：零残留 ───────────────────────── */
console.log('\n[删除] 段条 / 复习条「要求」/ 行内要求条 / 560px 模态 / 要求抽屉')
check('段上下文条整块已删（无「个知识点 · 当前：」）', !mod.includes('个知识点 · 当前：'))
check('段条注释已改写（写明去向）', mod.includes('段上下文条（章名 · 第N段 · N 个知识点 · 收尾 · 要求 · 进度）已于 2026-11-22 整块退役'))
check('行内要求条已删（无「本会话要求：」）', !mod.includes('本会话要求：'))
check('560px「本会话约束」模态已删', !mod.includes('本会话约束') && !mod.includes('w-[560px]'))
check('openRequirements 已删', !mod.includes('openRequirements'))
check('reqOpen / reqLayer 已删', !mod.includes('setReqOpen') && !mod.includes('reqLayer') && !mod.includes('setReqLayer'))
check('RequirementsDrawer 引用已删', !mod.includes('RequirementsDrawer'))
check('CourseProgress 挂载与 import 已删', !mod.includes("from './CourseProgress'") && !mod.includes('<CourseProgress'))
check('AnchoredLayer import 已删（进度浮层退役）', !mod.includes('AnchoredLayer'))
check('进度浮层状态已删', !mod.includes('progressOpen') && !mod.includes('progressAnchorRef'))
// 2026-11-22：零 importer，文件已删除（进度由左栏课程树承载 / 要求走右栏笔记页签）
check('CourseProgress.tsx 已删除（不再留作结课报告）', !existsSync(join(ROOT, 'src/modules/ai-teaching/CourseProgress.tsx')))
check('RequirementsDrawer.tsx 已删除（本模块不再用）', !existsSync(join(ROOT, 'src/modules/ai-teaching/RequirementsDrawer.tsx')))

console.log('\n[收尾] 左栏 ✓ + ```wrapup 围栏卡，行内两段式')
check('index 向 CourseRail 传 segmentEndable', mod.includes('segmentEndable={!!activeSegment && activeId === activeSegmentSid && segmentStatus === \'open\' && !courseEnded}'))
check('index 传 endConfirmOpen / 三回调', mod.includes('endConfirmOpen={endConfirm === \'rail\'}')
  && mod.includes("onEndRequest={() => setEndConfirm('rail')}")
  && mod.includes('onEndCancel={() => setEndConfirm(null)}')
  && mod.includes('onEndConfirm={() => { setEndConfirm(null); void courseEndSegment() }}'))
check('CourseRail 暴露四个收尾 props', ['segmentEndable?: boolean', 'endConfirmOpen?: boolean', 'onEndRequest?: () => void', 'onEndConfirm?: () => void'].every((s) => rail.includes(s)))
check('段行右侧 ✓（18×18 命中区）', /w-\[18px\] h-\[18px\][\s\S]{0,400}<Check size=\{12\}/.test(rail))
check('✓ 只给进行中且当前的一段', rail.includes("const endable = segmentEndable && row.sessionId === activeSegmentId && row.status === 'open'"))
check('左栏确认条 = 收尾后只读 + 取消 / 收尾', rail.includes('收尾后只读') && rail.includes('>取消<') && rail.includes('>收尾<'))
check('收尾卡文案「本段学完了？」仍在（换了渲染位置）', mod.includes('本段学完了？') && mod.includes('收尾后本段冻结为只读'))
check('收尾卡两段式（确认收尾本段？）', mod.includes('确认收尾本段？') && mod.includes("setEndConfirm('card')"))
check('已收尾行 = 交接.md', mod.includes('本段已收尾 ·') && mod.includes('交接.md'))
check('已结课卡（结课报告 / 重新开课）', mod.includes('本课已结课') && mod.includes('>结课报告<') && mod.includes('>重新开课<'))
check('收尾不再一键冻结（无裸 onClick，只有两处确认回调）', !/onClick=\{\(\) => void courseEndSegment\(\)\}/.test(mod) && count(mod, /void courseEndSegment\(\)/g) === 2, `实际 ${count(mod, /void courseEndSegment\(\)/g)}`)
check('Esc 链含取消收尾确认', /if \(endConfirm\) \{ setEndConfirm\(null\); return \}/.test(mod))

/* ───────────── 3b. 收尾卡围栏驱动（2026-11-23：不再每轮常驻） ───────────── */
console.log('\n[收尾卡] ```wrapup 围栏驱动 —— 全对话至多一张，不再每轮都挂')
const agent = read('electron/lib/agentService.ts')
const stripRe = slice(mod, 'body: raw.body.replace(', 'jumps: raw.jumps', 'strip')
check('正文剥离片段可定位', stripRe.length > 40, `len=${stripRe.length}`)
check('正文剥离正则含 wrapup', /```[^\n]*wrapup/.test(stripRe), stripRe.trim())
const wf = slice(mod, 'const wrapupFence = useMemo', '}, [messages])', 'wrapup')
check('wrapupFence memo 存在', wf.length > 200, `len=${wf.length}`)
check('wrapupFence 倒序扫全部 assistant，取最后一条', /for \(let i = messages\.length - 1; i >= 0; i--\)[\s\S]{0,400}if \(mt\) return \{ idx: i/.test(wf) && wf.includes('```wrapup'))
check('卡片只在产生围栏的那条回复里渲染（idx === idx 只出现一次）', count(mod, /wrapupFence\?\.idx === idx/g) === 1, `实际 ${count(mod, /wrapupFence\?\.idx === idx/g)}`)
check('围栏卡守卫：当前段会话 + 段进行中 + 未结课', /wrapupFence\?\.idx === idx && activeSegment && activeId === activeSegmentSid && segmentStatus === 'open' && !courseEnded/.test(mod))
// 负向：流末尾那块不能再渲染收尾卡 —— 否则又会变成「每轮都挂着」
const tail = slice(mod, '流末尾收尾行 / 结课卡（2026-11-22 A 线', '{courseEnded && activeWs', 'tail')
check('流末尾片段可定位', tail.length > 100, `len=${tail.length}`)
check('负向：流末尾不再渲染「本段学完了？」卡', !tail.includes('>本段学完了？<') && !tail.includes("setEndConfirm('card')"))
check('负向：流末尾不再用 messages.length 决定是否出卡', !tail.includes('messages.length'))
check('流末尾只留已收尾行（本段已收尾 · 交接.md）', tail.includes('本段已收尾 ·') && tail.includes('交接.md') && tail.includes("segmentStatus === 'ended'"))
check('负向：全文件没有「按消息条数出卡」的残留', !mod.includes('messages.length > 0 || segmentStatus'))
check('左栏 ✓ 入口未受影响（仍不依赖围栏）', rail.includes('onEndRequest') && !rail.includes('wrapup'))

console.log('\n[收尾协议] 段会话提示词：只有明确收尾意图才吐围栏')
check('提示词有【段收尾协议（AI教学）】', agent.includes('【段收尾协议（AI教学）】'))
check('协议写明只在明确收尾意图 / 用户确认后输出', agent.includes('明确**表达收尾本段的意思') && agent.includes('或你建议收尾且用户已经确认'))
check('协议写明**不要每轮输出**、不主动催促', agent.includes('**不要每轮输出**') && agent.includes('主动催促收尾'))
check('协议与结课区分（收尾本段不是结课）', agent.includes('「收尾本段」不是结课') && agent.includes('结课用 endcourse'))
check('协议注入串与计费口径都含 wrapupRuleHint', count(agent, /wrapupRuleHint/g) === 3, `实际 ${count(agent, /wrapupRuleHint/g)}`)
check('围栏语言明写 wrapup（反引号转义口径）', agent.includes('```wrapup'))
check('只注入未收尾的段会话（已收尾 / 已结课 / 侧支线不注入）', /sessionLessonBrief && !sessionLessonBrief\.ended && !courseEndedForHint/.test(agent))

/* ───────────────────────── 4. endcourse：全对话一张卡 ───────────────────────── */
console.log('\n[结课] ```endcourse 围栏 → 唯一行内卡')
const ec = slice(mod, '/**\n   * AI 结课建议（2026-11-22）', '/** 落盘态', 'endcourse')
// 2026-11-23：正则后续追加了 `|teach`（教学指令围栏），断言改成「含 endcourse 起手」而非死等整串
check('正文剥离正则含 endcourse', /body\.replace\(\/```\((?:[^)]*\|)?endcourse[^)]*\)/.test(mod))
check('endCourseFence memo 存在', mod.includes('const endCourseFence = useMemo'))
check('memo 倒序扫全部 assistant，取最后一条', /for \(let i = messages\.length - 1; i >= 0; i--\)[\s\S]{0,400}if \(mt\) return \{ idx: i/.test(ec))
check('渲染点全局唯一（idx === idx 只出现一次）', count(mod, /endCourseFence\?\.idx === idx/g) === 1, `实际 ${count(mod, /endCourseFence\?\.idx === idx/g)}`)
check('守卫：有工作区 + 未结课', /endCourseFence\?\.idx === idx && activeWs && activeWs !== '__none__' && !courseEnded/.test(mod))
check('按钮文案「开始结课流程」', mod.includes('开始结课流程'))
check('点击进现有结课流程 startEndFlow(activeWs, 1)', mod.includes('startEndFlow(activeWs, 1)'))
check('卡片进对话流（不 sticky、跟随消息滚动）', !/endCourseFence\?\.idx === idx[\s\S]{0,300}sticky/.test(mod))
check('不新增 AI 工具（builtinTools 未动）', !read('electron/lib/builtinTools.ts').includes('endcourse'))

/* ───────────────────── 5. 工件分栏折叠开关（2026-11-23 补回可见出口） ───────────────────── */
console.log('\n[工件栏] 页签条右端一枚折叠/展开开关（顶栏不恢复 chip）')
const pane = read('src/modules/ai-teaching/ArtifactsPane.tsx')
const strip = slice(pane, '{/* 页签条：icon+名称+✕', '{/* 工具条：落盘路径', 'art-strip')
check('页签条片段可定位', strip.length > 400, `len=${strip.length}`)
check('导入 lucide 两态图标 PanelRightClose / PanelRightOpen',
  /import \{[^}]*PanelRightClose[^}]*\} from 'lucide-react'/.test(pane) && /import \{[^}]*PanelRightOpen[^}]*\} from 'lucide-react'/.test(pane))
const toggle = slice(pane, '{/* 分栏折叠/展开（2026-11-23）', '{/* 全部页签下拉（F-3 P1）', 'art-toggle')
check('开关片段可定位', toggle.length > 200, `len=${toggle.length}`)
check('开关在页签条内（✕ 页签之后、工具条之前）', strip.includes('onToggleOpen(!open)'))
check('点击 = onToggleOpen(!open)（沿用宿主 applyArtOpen）', strip.includes('onClick={() => onToggleOpen(!open)}'))
check('aria-expanded 接 open', strip.includes('aria-expanded={!!open}'))
check('两态图标：展开时 PanelRightClose、收起时 PanelRightOpen',
  /\{open \? <PanelRightClose size=\{11\} \/> : <PanelRightOpen size=\{11\} \/>\}/.test(strip))
check('图标 11px（< 16px）+ p-1 命中区 + 与 ⤢ 同语言（rounded-md / transition-colors）',
  /p-1 rounded-md transition-colors/.test(toggle) && !toggle.includes('transition-all'))
check('两态 data-tip 各一句（收起 / 展开）',
  strip.includes("data-tip={open ? '收起工件分栏（页签保留，可再点展开）' : '展开工件分栏'}")
  && strip.includes("aria-label={open ? '收起工件分栏（页签保留，可再点展开）' : '展开工件分栏'}"))
check('props 只追加可选（open? / onToggleOpen?）',
  pane.includes('open?: boolean') && pane.includes('onToggleOpen?: (v: boolean) => void'))
check('无 onToggleOpen 时不渲染（全宽阅读实例不需要收起分栏）', /\{onToggleOpen && \(/.test(toggle))
check('index 分栏实例接线 open={artOpen} / onToggleOpen={applyArtOpen}',
  mod.includes('open={artOpen}') && count(mod, /onToggleOpen=\{applyArtOpen\}/g) === 1,
  `实际 ${count(mod, /onToggleOpen=\{applyArtOpen\}/g)}`)
check('applyArtOpen 仍持久化 aiTeach.artOpen', mod.includes("localStorage.setItem('aiTeach.artOpen'"))
check('负向：顶栏没有恢复「工件分栏」chip', !bar.includes('工件分栏') && !bar.includes('onToggleOpen') && !bar.includes('<PanelRight'))
check('负向：页签条之外没有第二处开关（onToggleOpen 只出现在该 button + 签名）',
  count(pane, /onToggleOpen/g) === 4, `实际 ${count(pane, /onToggleOpen/g)}`)

console.log(`\n[OK] ${pass} PASS / [FAIL] ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
