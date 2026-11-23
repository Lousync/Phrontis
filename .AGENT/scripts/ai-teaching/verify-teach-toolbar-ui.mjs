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
 *   5. 工件分栏：展开时页签条右端一枚 `PanelRightClose` 负责收起；**收起态**的展开入口
 *      必须挂在折叠容器（ResizablePanel / 其 display:none 子树）**之外**——中栏右缘贴边按钮，
 *      `PanelRightOpen` + `aria-expanded={false}` + `aria-label="展开工件分栏"`（2026-11-23 可达性修复：
 *      收起后页签条整棵 display:none，原来那枚展开图标永远看不见）；顶栏仍不恢复 chip；
 *      查看器打开时该按钮跟随查看器左缘（transform 让位），Toast 文案指向的就是它。
 *   6. 抽屉贴底跟随（2026-11-23 竞态修复）：钉底循环**每帧复检** `stickRef`，用户 wheel / pointerdown
 *      立即打断（`cancelTrayPin`）；钉底期间 `onConvScroll` 跳过贴底重算（否则程序化滚到底的几何
 *      恒为贴底，会把用户上翻重新钉回 true）；`trayAnimating` 关窗与钉底窗口共用
 *      `TRAY_ANIM_SETTLE_MS`，不再各写 +40 / +80。
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
check('顶栏不再用 lucide PanelRightOpen（展开入口不在顶栏）', !bar.includes('PanelRightOpen'))

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
check('思考四档带 aria-pressed（宽态四档 + 窄态气泡各一份）', count(tray, /aria-pressed=\{convoEffort === e\}/g) === 2)
check('引用按钮带 aria-pressed', count(tray, /aria-pressed=\{quotesOpen && quotes\.length > 0\}/g) === 1)
check('抽屉不再放模型入口（与底部 openModelMenu 重复，2026-11-23 去重）', !tray.includes('openModelMenu'))
check('模型入口仍在输入卡底部', mod.slice(mod.indexOf('const composerFooter')).includes('openModelMenu'))

/* ─────────── 2c. 窄态自动图标化（2026-11-23 用户拍板） ─────────── */
console.log('\n[图标化] 抽屉可用宽 < 360px 时整体收成图标（不藏入口、不换行）；宽了自动还原')
check('抽屉行是容器查询容器（container-type: inline-size）',
  tray.includes('kb-tray-row') && /\.kb-tray-row \{ container-type: inline-size/.test(css))
check('断点 @container composer-tray (max-width: 360px)',
  /@container composer-tray \(max-width: 360px\)/.test(css))
check('容器查询里：文字隐藏、图标显示',
  /@container composer-tray \(max-width: 360px\)[\s\S]{0,700}\.kb-tray-opt-label \{ display: none; \}/.test(css)
  && /\.kb-tray-opt-icon \{ display: block; \}/.test(css))
check('窄态按钮压成 24px 方图标（不换行）',
  /\.kb-tray-opt \{\s*width: 24px;/.test(css))
check('画像 / 要求：文字 + 图标两套都渲染（docPills 里）',
  pills.includes('kb-tray-opt-label') && count(pills, /kb-tray-opt-icon/g) === 2)
check('引用：文字版 + 图标版 + 数量',
  tray.includes('kb-tray-quote-text') && tray.includes('kb-tray-quote-icon')
  && tray.includes('{quotes.length > 0 && <span'))
check('思考宽态四档在 kb-tray-effort-seg 容器里',
  /kb-tray-effort-seg[\s\S]{0,1200}EFFORT_LABEL\[e\]/.test(tray))
check('思考窄态是一枚「脑图标 + 当前档」，点击开气泡',
  tray.includes('kb-tray-effort-compact')
  && tray.includes('ref={effortMenuTriggerRef}')
  && tray.includes('onClick={effortMenu.toggle}')
  && /EFFORT_LABEL\[convoEffort\]/.test(tray)
  && tray.includes('aria-label={`思考强度：${EFFORT_LABEL[convoEffort]}`}'))
check('思考气泡：fixed 锚定 + 四档 + 选中勾 + 点外部/Esc 关闭（useAnchoredMenu）',
  tray.includes('data-wb="aiTeachEffortMenu"')
  && /role="dialog" aria-label="思考强度"/.test(tray)
  && count(tray, /pickEffort\(e\); effortMenu\.close\(\)/g) === 1
  && mod.includes('useAnchoredMenu(effortMenuTriggerRef, effortMenuRef'))
check('引用窄态带完整 aria-label（图标没有可见文字）',
  tray.includes("aria-label={quotes.length ? `查看本轮引用（${quotes.length} 条）` : '本轮还没有引用'}"))
check('图标化不引入 transition-all / 新动效令牌',
  !tray.includes('transition-all') && !/kb-tray-(?:opt|effort|quote)[a-z-]* \{[^}]*(?:animation|transition)/.test(css))

/* ─────────── 2b. 抽屉贴底跟随：每帧复检 + 用户输入打断（2026-11-23 竞态修复） ─────────── */
console.log('\n[贴底跟随] 钉底循环每帧复检；wheel / pointerdown 打断；时间窗同源')
const cancelFn = slice(mod, 'const cancelTrayPin = useCallback', 'const pinTrayBottom = useCallback', 'cancel-pin')
const pin = slice(mod, 'const pinTrayBottom = useCallback', '/** 收起瞬间的一次性加宽脉冲', 'pin-tray')
const conv = slice(mod, 'const onConvScroll = useCallback', 'const jumpToTurn = useCallback', 'conv-scroll')
const trayToggle = slice(mod, 'const toggleTray = useCallback', '/** 条目9', 'toggle-tray')
const scrollTag = (mod.match(/<div ref=\{scrollRef\}[^>]*>/) ?? [''])[0]
check('取消函数片段可定位', cancelFn.length > 150, `len=${cancelFn.length}`)
check('取消函数：cancelAnimationFrame + 置 0 + stickRef=false + 浮标出现',
  /cancelAnimationFrame\(trayPinRaf\.current\)/.test(cancelFn)
  && /trayPinRaf\.current = 0/.test(cancelFn)
  && /stickRef\.current = false/.test(cancelFn)
  && /setJumpBottom\(true\)/.test(cancelFn))
check('滚动容器挂着 onWheel / onPointerDown = cancelTrayPin',
  scrollTag.length > 100 && scrollTag.includes('onWheel={cancelTrayPin}') && scrollTag.includes('onPointerDown={cancelTrayPin}'))
check('打断不阻止默认行为（无 preventDefault）',
  !scrollTag.includes('preventDefault') && !cancelFn.includes('preventDefault'))
check('pin 片段可定位', pin.length > 200, `len=${pin.length}`)
const stepAt = pin.indexOf('const step = (): void => {')
const recheckAt = pin.indexOf('if (!stickRef.current) { trayPinRaf.current = 0; return }')
const writeAt = pin.indexOf('c.scrollTop = c.scrollHeight')
check('step 每帧复查 stickRef（且在写 scrollTop 之前）',
  stepAt >= 0 && recheckAt > stepAt && writeAt > recheckAt, `step@${stepAt} / recheck@${recheckAt} / write@${writeAt}`)
check('onConvScroll 在钉底期间跳过贴底判定（trayPinRaf 守卫）',
  /if \(!trayPinRaf\.current\) \{/.test(conv) && conv.indexOf('if (!trayPinRaf.current)') < conv.indexOf('stickRef.current = near'))
check('位置记忆 / 轮次测量仍在守卫之外',
  conv.indexOf('convScroll.current.set(activeIdRef.current, c.scrollTop)') < conv.indexOf('if (!trayPinRaf.current)')
  && conv.indexOf('remeasureTops()') > conv.indexOf('if (!trayPinRaf.current)'))
check('两个时间窗同源：TRAY_ANIM_SETTLE_MS = COMPOSER_TRAY_ANIM_MS + 80',
  mod.includes('const TRAY_ANIM_SETTLE_MS = COMPOSER_TRAY_ANIM_MS + 80'))
check('贴底窗口用 TRAY_ANIM_SETTLE_MS', pin.includes('performance.now() + TRAY_ANIM_SETTLE_MS'))
check('trayAnimating 关窗也用它', trayToggle.includes('}, TRAY_ANIM_SETTLE_MS)'))
check('负向：不再有 +40 / +80 两个不同字面',
  count(mod, /COMPOSER_TRAY_ANIM_MS \+ 40/g) === 0 && count(mod, /COMPOSER_TRAY_ANIM_MS \+ 80/g) === 1,
  `40×${count(mod, /COMPOSER_TRAY_ANIM_MS \+ 40/g)} / 80×${count(mod, /COMPOSER_TRAY_ANIM_MS \+ 80/g)}`)
check('卸载 cleanup 仍 cancel 钉底 raf',
  /if \(trayPinRaf\.current\) cancelAnimationFrame\(trayPinRaf\.current\)\n  \}, \[\]\)/.test(mod))

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

/* ─────────── 5b. 收起态入口：折叠容器之外（2026-11-23 可达性修复） ─────────── */
console.log('\n[工件栏·收起态] 折叠容器之外的贴边展开入口 + 焦点 + Toast')
const panelEnd = mod.indexOf('</ResizablePanel>', mod.indexOf('storageKey="aiTeachArtWidth"'))
const edge = slice(mod, '{/* 收起态展开入口（2026-11-23 可达性修复）', '{/* ⤢ 全宽阅读', 'art-edge')
check('收起态入口片段可定位', edge.length > 300, `len=${edge.length}`)
check('入口在折叠容器之外（ResizablePanel 闭合标签之后）',
  panelEnd > 0 && mod.indexOf('{/* 收起态展开入口') > panelEnd)
check('渲染条件包含 !artOpen（收起态才出现）', /\{artExpanded && !artOpen && !artZoom && \(/.test(edge))
check('入口不在 visible={...} 的子树里', !edge.includes('visible={') && !edge.includes('<ResizablePanel'))
check('图标 = PanelRightOpen（与页签条那枚同语言）', edge.includes('<PanelRightOpen size={12} />'))
check('aria-expanded={false} + aria-label="展开工件分栏"',
  edge.includes('aria-expanded={false}') && edge.includes('aria-label="展开工件分栏"'))
check('点击展开 = applyArtOpen(true)，且查看器占右侧时先让它让位',
  /onClick=\{\(\) => \{[\s\S]{0,260}if \(srcVisible\) toggleSide\('right'\)[\s\S]{0,120}applyArtOpen\(true\)/.test(edge))
check('窄贴边：w-3.5 + 右缘定位 + 竖向居中', edge.includes('w-3.5') && edge.includes('right-0') && edge.includes('top-1/2'))
check('查看器让位用 transform + viewerW（不新增 CSS 令牌 / 不写 transition-all）',
  edge.includes('viewerW') && edge.includes('transform:') && !edge.includes('transition-all'))
check('动效有 prefers-reduced-motion 降级', edge.includes('artReducedMotion'))
check('收起时焦点从被隐藏的页签条挪到贴边入口（同 toggleTray 口径）',
  /artFocusToEdgeRef/.test(mod) && /artEdgeBtnRef\.current\?\.focus\(\)/.test(mod))
check('焦点判据锚在工件子树根节点（data-ai-teach-art-pane）',
  mod.includes("closest('[data-ai-teach-art-pane]')") && pane.includes('data-ai-teach-art-pane'))
check('Toast 指向真实入口（中栏右缘「展开工件分栏」按钮）',
  mod.includes('点中栏右缘的「展开工件分栏」按钮即可再打开（会先收起查看器）'))
check('负向：Toast 不再指向不存在的「页签条右端展开按钮」',
  !mod.includes('页签条右端的展开按钮'))
check('负向：顶栏没有第二处开关（入口文案不出现在顶栏）',
  !bar.includes('展开工件分栏') && !bar.includes('PanelRightOpen') && !bar.includes('artOpen'))


console.log(`\n[OK] ${pass} PASS / [FAIL] ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
