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
 *   4. ```endcourse 围栏全对话**只渲染一张**卡，且结课后不渲染。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-teach-toolbar-ui.mjs
 * 只读源码做结构断言（不跑 dev / 不跑构建）——与库内其它 verify-*.mjs 同范式。
 */
import { readFileSync } from 'node:fs'
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
check('不再用 lucide PanelRightOpen', !mod.includes('PanelRightOpen'))

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
check('CourseProgress.tsx 文件仍在（留作结课报告）', read('src/modules/ai-teaching/CourseProgress.tsx').length > 0)
check('RequirementsDrawer.tsx 文件仍在（本模块不再用）', read('src/modules/ai-teaching/RequirementsDrawer.tsx').length > 0)

console.log('\n[收尾] 左栏 ✓ + 流末尾卡，行内两段式')
check('index 向 CourseRail 传 segmentEndable', mod.includes('segmentEndable={!!activeSegment && activeId === activeSegmentSid && segmentStatus === \'open\' && !courseEnded}'))
check('index 传 endConfirmOpen / 三回调', mod.includes('endConfirmOpen={endConfirm === \'rail\'}')
  && mod.includes("onEndRequest={() => setEndConfirm('rail')}")
  && mod.includes('onEndCancel={() => setEndConfirm(null)}')
  && mod.includes('onEndConfirm={() => { setEndConfirm(null); void courseEndSegment() }}'))
check('CourseRail 暴露四个收尾 props', ['segmentEndable?: boolean', 'endConfirmOpen?: boolean', 'onEndRequest?: () => void', 'onEndConfirm?: () => void'].every((s) => rail.includes(s)))
check('段行右侧 ✓（18×18 命中区）', /w-\[18px\] h-\[18px\][\s\S]{0,400}<Check size=\{12\}/.test(rail))
check('✓ 只给进行中且当前的一段', rail.includes("const endable = segmentEndable && row.sessionId === activeSegmentId && row.status === 'open'"))
check('左栏确认条 = 收尾后只读 + 取消 / 收尾', rail.includes('收尾后只读') && rail.includes('>取消<') && rail.includes('>收尾<'))
check('流末尾段卡「本段学完了？」', mod.includes('本段学完了？'))
check('流末尾卡两段式（确认收尾本段？）', mod.includes('确认收尾本段？') && mod.includes("setEndConfirm('card')"))
check('流末尾已收尾行 = 交接.md', mod.includes('本段已收尾 ·') && mod.includes('交接.md'))
check('已结课卡（结课报告 / 重新开课）', mod.includes('本课已结课') && mod.includes('>结课报告<') && mod.includes('>重新开课<'))
check('收尾不再一键冻结（无裸 onClick，只有两处确认回调）', !/onClick=\{\(\) => void courseEndSegment\(\)\}/.test(mod) && count(mod, /void courseEndSegment\(\)/g) === 2, `实际 ${count(mod, /void courseEndSegment\(\)/g)}`)
check('Esc 链含取消收尾确认', /if \(endConfirm\) \{ setEndConfirm\(null\); return \}/.test(mod))

/* ───────────────────────── 4. endcourse：全对话一张卡 ───────────────────────── */
console.log('\n[结课] ```endcourse 围栏 → 唯一行内卡')
const ec = slice(mod, '/**\n   * AI 结课建议（2026-11-22）', '/** 落盘态', 'endcourse')
check('正文剥离正则含 endcourse', mod.includes('```(profile|plan|ask|outline|endcourse)'))
check('endCourseFence memo 存在', mod.includes('const endCourseFence = useMemo'))
check('memo 倒序扫全部 assistant，取最后一条', /for \(let i = messages\.length - 1; i >= 0; i--\)[\s\S]{0,400}if \(mt\) return \{ idx: i/.test(ec))
check('渲染点全局唯一（idx === idx 只出现一次）', count(mod, /endCourseFence\?\.idx === idx/g) === 1, `实际 ${count(mod, /endCourseFence\?\.idx === idx/g)}`)
check('守卫：有工作区 + 未结课', /endCourseFence\?\.idx === idx && activeWs && activeWs !== '__none__' && !courseEnded/.test(mod))
check('按钮文案「开始结课流程」', mod.includes('开始结课流程'))
check('点击进现有结课流程 startEndFlow(activeWs, 1)', mod.includes('startEndFlow(activeWs, 1)'))
check('卡片进对话流（不 sticky、跟随消息滚动）', !/endCourseFence\?\.idx === idx[\s\S]{0,300}sticky/.test(mod))
check('不新增 AI 工具（builtinTools 未动）', !read('electron/lib/builtinTools.ts').includes('endcourse'))

console.log(`\n[OK] ${pass} PASS / [FAIL] ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
