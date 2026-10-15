#!/usr/bin/env node
/**
 * 契约验证：页面条横向溢出（台账 F-16，docs/v3.4.0-feedback.md）。
 *
 * 与 verify-workbench-shell.mjs 的分工：那份锁**接线**（哪个容器可滚、哪个槽让宽、行容器
 * 不许变滚动容器），这份锁**行为** —— 边沿渐隐什么时候亮、激活条目该滚到哪、滚轮要不要劫持。
 *
 * 行为判据全在 `src/components/workbench/stripScrollPure.ts` 里，是**零相对 import 的纯模块**
 * （只用算术），所以 node 可以直接加载 `.ts`（Node 24 原生类型剥离；node 的 ESM 不做扩展名
 * 补全，内部一旦出现 `./xxx` 就 ERR_MODULE_NOT_FOUND —— 这也是当初坚持零 import 的原因，
 * 同 electron/lib/releaseNotes/judge.ts 的口径）。
 *
 * 为什么这几条值得单独立契约（而不是只看截图）：
 *   ① 渐隐的开关条件是 `scrollLeft` 与 `scrollWidth - clientWidth` 的比较，亚像素残差下
 *      朴素写法会「明明滚到头了右侧还常亮」—— 探针与肉眼都难察觉；
 *   ② 激活条目的目标位移带 10px 留白（让开 8px 内凹弧），差 1px 就是「页签缺个角」；
 *   ③ 滚轮劫持的四种放行条件（无溢出 / Shift / 横向手势 / 无纵向分量）错一条，
 *      要么吞掉本不该吞的滚轮，要么双倍速 —— 都只在真机上偶发。
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/workbench-shell/verify-strip-overflow.mjs
 * 期望：末行 PASS 且 exit=0
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { stripEdges, stripMaxScroll, stripReveal, stripWheelDelta } from '../../../src/components/workbench/stripScrollPure.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass++
    console.log(`[OK]   ${label}`)
  } else {
    fails.push(label + (detail ? '  → ' + detail : ''))
    console.log(`[FAIL] ${label}${detail ? '  → ' + detail : ''}`)
  }
  return !!cond
}

const m = (scrollLeft, clientWidth, scrollWidth) => ({ scrollLeft, clientWidth, scrollWidth })

// ===== 1. 边沿渐隐的开关 =====
console.log('=== 1. stripEdges：还有藏起来的条目那一侧才亮 ===')
ok(JSON.stringify(stripEdges(m(0, 300, 900))) === JSON.stringify({ left: false, right: true }),
  '未滚动 + 有溢出：只亮右侧（左侧本来就没东西藏）')
ok(JSON.stringify(stripEdges(m(300, 300, 900))) === JSON.stringify({ left: true, right: true }),
  '滚在中间：两侧都亮')
ok(JSON.stringify(stripEdges(m(600, 300, 900))) === JSON.stringify({ left: true, right: false }),
  '滚到最右：右侧熄灭（可见内容已到末尾，再亮就是骗人）')
ok(JSON.stringify(stripEdges(m(0, 300, 300))) === JSON.stringify({ left: false, right: false }),
  '无溢出：两侧都不亮（外观与修前一致，不凭空多出渐隐）')
ok(JSON.stringify(stripEdges(m(0.2, 300, 300.4))) === JSON.stringify({ left: false, right: false }),
  '亚像素残差（scrollWidth 300.4 / scrollLeft 0.2）不误判成可滚 —— 朴素 < 比较会右侧常亮')
ok(stripMaxScroll(m(600, 300, 900)) === 600 && stripMaxScroll(m(0, 300, 280)) === 0,
  'stripMaxScroll：无溢出时归零（不出现负位移）')

// ===== 2. 激活条目滚到哪 =====
console.log('=== 2. stripReveal：激活条目滚入视野（带留白，够不到就滚） ===')
ok(stripReveal(m(0, 300, 900), { start: 100, end: 200 }) === null,
  '条目已完整可见（两侧都有余量）→ 返回 null，一次都不动（多触发也不会抖）')
ok(stripReveal(m(0, 300, 900), { start: 400, end: 500 }) === 210,
  '条目在右侧视野外 → 滚到「末边 + 留白 - 视口宽」= 210', String(stripReveal(m(0, 300, 900), { start: 400, end: 500 })))
ok(stripReveal(m(300, 300, 900), { start: 10, end: 110 }) === 0,
  '条目在左侧视野外 → 滚回 0（并夹到 0，不出现负 scrollLeft）')
ok(stripReveal(m(300, 300, 900), { start: 850, end: 890 }) === 600,
  '目标位移超过最大可滚量 → 夹到 max（不会滚出一片空白）')
ok(stripReveal(m(0, 300, 280), { start: 400, end: 500 }) === null,
  '容器没有横向溢出 → 一律 null（内容宽于容器的场景由外层负责）')
{
  const withPad = stripReveal(m(0, 300, 900), { start: 280, end: 340 }, 10)
  const noPad = stripReveal(m(0, 300, 900), { start: 280, end: 340 }, 0)
  ok(withPad === 50 && noPad === 40 && withPad - noPad === 10,
    '留白真的加在目标位移上（10px 留白 = 让开 8px 内凹弧，贴边会把弧裁掉）', `pad10=${withPad} pad0=${noPad}`)
}

// ===== 3. 滚轮 → 横向 =====
console.log('=== 3. stripWheelDelta：纵向滚轮横滚，四种情况交回原生 ===')
ok(stripWheelDelta({ deltaX: 0, deltaY: 100, shiftKey: false }, m(0, 300, 900)) === 100,
  '有溢出 + 纵向滚轮 → 原样取用（鼠标用户唯一够得到的手段）')
ok(stripWheelDelta({ deltaX: 0, deltaY: -100, shiftKey: false }, m(0, 300, 900)) === -100,
  '向上滚 → 负增量（往回滚）')
ok(stripWheelDelta({ deltaX: 0, deltaY: 100, shiftKey: false }, m(0, 300, 300)) === 0,
  '无横向溢出 → 0，绝不吞掉滚轮（否则整条行上的滚动都被吃掉）')
ok(stripWheelDelta({ deltaX: 0, deltaY: 100, shiftKey: true }, m(0, 300, 900)) === 0,
  'Shift + 滚轮 → 0（Chromium 原生就是横滚，再叠加会变双倍速）')
ok(stripWheelDelta({ deltaX: 80, deltaY: 10, shiftKey: false }, m(0, 300, 900)) === 0,
  '触控板横向手势（|deltaX| > |deltaY|）→ 0，交回原生')
ok(stripWheelDelta({ deltaX: 0, deltaY: 0, shiftKey: false }, m(0, 300, 900)) === 0,
  '无纵向分量 → 0')

// ===== 4. DOM 侧接线（纯算法对了、接错了等于没修）=====
console.log('=== 4. DOM 接线：非 passive 滚轮 / 观察 portal 内容 / 渐隐基建 ===')
const hookSrc = read('src/components/workbench/useStripScroll.tsx')
const pureSrc = read('src/components/workbench/stripScrollPure.ts')
const css = read('src/styles/index.css')
const stripSrc = read('src/components/workbench/PageTabStrip.tsx')
const pageBarSrc = read('src/components/workbench/WorkbenchPageBar.tsx')

ok(/addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(hookSrc),
  '滚轮监听必须非 passive —— React 的 onWheel 是 passive 代理，preventDefault 会被吞掉（白名单静默失效）')
ok(/new MutationObserver\(sync\)/.test(hookSrc),
  '溢出状态跟随内容增删 —— 知识库页签是从别的模块 portal 进来的，本组件不重渲染，只有 MutationObserver 察觉得到')
ok(/new ResizeObserver\(sync\)/.test(hookSrc),
  '溢出状态跟随容器尺寸（分屏拖动 / 窗口缩放会改行宽）')
ok(/ACTIVE_SEL = '\[data-wb-active="1"\]'/.test(hookSrc),
  '「激活条目」用页面条既有的属性契约 data-wb-active="1"（两个渲染器同口径，不新造通道）')
ok(!/scrollIntoView/.test(hookSrc) && /stripReveal\(/.test(hookSrc),
  '滚入视野走 stripReveal（可测、带留白），不用 scrollIntoView（贴边裁弧 + 测不了）')
ok(/useStripScroll\(/.test(stripSrc) && !/useStripScroll\(\)/.test(stripSrc)
  && /useStripScroll\(/.test(pageBarSrc) && !/useStripScroll\(\)/.test(pageBarSrc),
  '两个渲染器都把「激活 id | 条目数」当触发键传进去（不传就只在挂载时滚一次）')
// 两份分居两个文件的数字必须对得上（对不上 = 「页签缺一个角」）：留白 ≥ 内凹弧宽。
// 正则一律用 \s* 跨行（本仓是 CRLF，写字面量 \n 会静默不匹配 —— 断言恒 NaN 却不报错的那种）。
const pad = Number((pureSrc.match(/stripReveal\(m: StripMetrics, item: StripItemBox, pad = (\d+)\)/) ?? [])[1])
const arc = Number((css.match(/\.kb-edge-tab-active::before,\s*\.kb-edge-tab-active::after \{[\s\S]{0,200}?width: (\d+)px/) ?? [])[1])
const PX2 = 8 // Tailwind px-2 = 2 × 0.25rem = 8px

ok(/\.kb-strip-fade \{[\s\S]{0,200}?position: absolute/.test(css)
  && /\.kb-strip-fade \{[\s\S]{0,200}?pointer-events: none/.test(css),
  '渐隐是绝对定位的纯覆盖层（不占宽、不吃点击）')
ok(/\.kb-strip-fade\[data-on='1'\] \{ opacity: 1; \}/.test(css)
  && /\.kb-strip-fade \{[\s\S]{0,260}?transition: opacity/.test(css),
  '渐隐靠 data-on 切 opacity（常驻 DOM 才有出现/消失的过渡 —— 铁律 13 状态变更要有动效）')
ok(/\.kb-strip-fade-l \{ left: 0; background: linear-gradient\(to right, var\(--bg-secondary\)/.test(css)
  && /\.kb-strip-fade-r \{ right: 0; background: linear-gradient\(to left, var\(--bg-secondary\)/.test(css),
  '渐隐由页面条底色（--bg-secondary）渐变到透明，左右方向相反')
ok(/@media \(prefers-reduced-motion: reduce\) \{ \.kb-strip-fade \{ transition: none; \} \}/.test(css),
  '渐隐带 prefers-reduced-motion 兜底（铁律 13 硬约束①）')
ok(/\.kb-edge-strip \{ scrollbar-width: none; \}/.test(css)
  && /\.kb-edge-strip::-webkit-scrollbar \{ display: none; \}/.test(css),
  '新滚动容器走 .kb-edge-strip 藏原生滚动条（横向滚动条占 4px 盒高，会把激活条目从行底顶起来）')
ok(Number.isFinite(pad) && Number.isFinite(arc) && pad >= arc,
  `滚入视野的留白(${pad}px) ≥ 内凹弧宽(${arc}px) —— 两份数字分居两个文件，对不上就是「页签缺个角」`, `pad=${pad} arc=${arc}`)
ok(/overflow-x-auto px-2 -ml-2/.test(stripSrc) && /overflow-x-auto px-2 -ml-2/.test(pageBarSrc)
  && Number.isFinite(arc) && PX2 >= arc,
  `两个滚动容器都留了 px-2（${PX2}px）容纳内凹弧(${arc}px) —— 滚动容器会裁掉条目外侧的弧，不留位置就是首尾条目缺角`,
  `strip=${/overflow-x-auto px-2 -ml-2/.test(stripSrc)} bar=${/overflow-x-auto px-2 -ml-2/.test(pageBarSrc)}`)

console.log('')
console.log('========================================')
if (fails.length === 0) {
  console.log(`PASS  页面条横向溢出契约 ${pass}/${pass}`)
  process.exit(0)
}
for (const f of fails) console.log(`FAIL  ${f}`)
console.log(`FAIL  页面条横向溢出契约：${fails.length} 项未过（另 ${pass} 项通过）`)
process.exit(1)
