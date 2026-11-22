/**
 * 契约验证：AI 教学 · 右缘「轮次导航」（方案 tmp/ai-teach-anchor-rail/PLAN.md §七-⑦）。
 *
 * 为什么需要它：这套东西错起来**全是静默的** ——
 *   - 收起态采样重复/丢尾 → 只是少露一条短横，没有报错；
 *   - 贴底不特判 → 最后一轮永远当不上「当前」（原型复现过）；
 *   - 轮次判定退回每帧 querySelector → 功能照常、只是卡；
 *   - 旧「定高圆点轨道」残留 → 两套刻度同时出现在右缘。
 * 所以这里把纯逻辑用例 + 源码/CSS 结构不变量一起钉住。
 *
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-turn-rail.mjs [仓库路径]
 * 输出纯 ASCII 标记（PASS / FAIL / [OK] / [FAIL]），禁 emoji。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadTsModule } from '../shared/ts-module.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const has = (rel, s) => read(rel).includes(s)

const PURE_REL = 'src/modules/ai-teaching/turnRailPure.ts'
const RAIL_REL = 'src/modules/ai-teaching/TurnRail.tsx'
const INDEX_REL = 'src/modules/ai-teaching/index.tsx'
const CSS_REL = 'src/styles/index.css'

// ---------------------------------------------------------------- 0. 载入真实纯函数
const { mod: pure } = await loadTsModule(path.join(ROOT, PURE_REL))
const { turnTitle, dashIndexes, dashActiveIndex, pickTurn, clampTurn, moveSelection } = pure

console.log('\n=== 1. dashIndexes：收起态采样（n=1/6/11/12/60/120）===')
for (const n of [1, 6, 11, 12, 60, 120]) {
  const d = dashIndexes(n)
  const expect = Math.min(n, 11)
  const increasing = d.every((v, i) => i === 0 || v > d[i - 1])
  const unique = new Set(d).size === d.length
  check(`n=${n} → 条数 = min(n,11) = ${expect}`, d.length === expect, `got ${d.length}`)
  check(`n=${n} → 首 0 / 尾 n-1`, d[0] === 0 && d[d.length - 1] === n - 1, JSON.stringify(d))
  check(`n=${n} → 严格递增且不重复`, increasing && unique, JSON.stringify(d))
  check(`n=${n} → 全部落在 [0,n-1]`, d.every(v => v >= 0 && v <= n - 1), JSON.stringify(d))
}
check('n=0 → 空数组', JSON.stringify(dashIndexes(0)) === '[]', JSON.stringify(dashIndexes(0)))
check('n=-3 → 空数组', JSON.stringify(dashIndexes(-3)) === '[]', JSON.stringify(dashIndexes(-3)))

console.log('\n=== 2. dashActiveIndex：当前轮映射到唯一一条短横 ===')
for (const n of [1, 6, 12, 60, 120]) {
  const d = dashIndexes(n)
  const nearest = (active) => {
    let best = 0
    for (let i = 1; i < d.length; i++) if (Math.abs(d[i] - active) < Math.abs(d[best] - active)) best = i
    return best
  }
  const allOk = Array.from({ length: n }, (_, a) => dashActiveIndex(d, a) === nearest(a)).every(Boolean)
  check(`n=${n} → 每个当前轮都落在最近的一条上`, allOk, '')
}
{
  const d = dashIndexes(120)
  check('当前轮 = 0 → 第 1 条', dashActiveIndex(d, 0) === 0, String(dashActiveIndex(d, 0)))
  check('当前轮 = 119 → 最后一条', dashActiveIndex(d, 119) === d.length - 1, String(dashActiveIndex(d, 119)))
  check('超出上界也不越界（夹住）', dashActiveIndex(d, 999) === d.length - 1, String(dashActiveIndex(d, 999)))
}

console.log('\n=== 3. pickTurn：顶部 / 阈值边界 / 贴底强制最后一轮 ===')
{
  const tops = [12, 500, 1000, 1500]
  check('顶部：scrollTop 0 → 第 1 轮', pickTurn(tops, 0, 90, 3000) === 0, String(pickTurn(tops, 0, 90, 3000)))
  check('阈值边界：scrollTop 410（=500-90）→ 第 2 轮', pickTurn(tops, 410, 90, 3000) === 1, String(pickTurn(tops, 410, 90, 3000)))
  check('阈值内：scrollTop 409 → 仍第 1 轮', pickTurn(tops, 409, 90, 3000) === 0, String(pickTurn(tops, 409, 90, 3000)))
  check('阈值外：scrollTop 911 → 第 3 轮', pickTurn(tops, 911, 90, 3000) === 2, String(pickTurn(tops, 911, 90, 3000)))
  check('空 tops → 0（导航刚挂上、还没测到）', pickTurn([], 100, 90, 3000) === 0, String(pickTurn([], 100, 90, 3000)))
  check('内容比视口矮（maxScroll=0）→ 第 1 轮', pickTurn(tops, 0, 90, 0) === 0, String(pickTurn(tops, 0, 90, 0)))
}
{
  // 真实场景：最后一轮顶部 5000，但最多只能滚到 3000 —— 只按阈值会停在倒数第二轮
  const tops = [0, 1000, 2000, 5000]
  check('贴底：scrollTop 3000 = maxScroll → 强制最后一轮', pickTurn(tops, 3000, 90, 3000) === 3, String(pickTurn(tops, 3000, 90, 3000)))
  check('贴底容差：2997（maxScroll-3）→ 仍算最后一轮', pickTurn(tops, 2997, 90, 3000) === 3, String(pickTurn(tops, 2997, 90, 3000)))
  check('未贴底：2900 → 按阈值仍是第 3 轮（贴底判定不扩散）', pickTurn(tops, 2900, 90, 3000) === 2, String(pickTurn(tops, 2900, 90, 3000)))
}

console.log('\n=== 4. turnTitle：四种回落 + 截断 ===')
check('markdown 标题：# 剥掉', turnTitle('# 导数的几何意义\n正文段落', 1) === '导数的几何意义', turnTitle('# 导数的几何意义\n正文', 1))
check('前面有空行：取首个非空行并 trim', turnTitle('\n\n   第二个问题   \n更多', 2) === '第二个问题', turnTitle('\n\n   第二个问题   \n更多', 2))
check('引用式 > 剥掉', turnTitle('> 引用里的提问', 3) === '引用里的提问', turnTitle('> 引用里的提问', 3))
check('纯空白 → 第 N 轮（图片）', turnTitle('   \n\t\n  ', 7) === '第 7 轮（图片）', turnTitle('   \n\t\n  ', 7))
check('空串（只发图片）→ 第 N 轮（图片）', turnTitle('', 2) === '第 2 轮（图片）', turnTitle('', 2))
check('只有图片语法 → 第 N 轮（图片）', turnTitle('![](a.png)', 5) === '第 5 轮（图片）', turnTitle('![](a.png)', 5))
check('超长截 40 字', turnTitle('问'.repeat(60), 1).length === 40, String(turnTitle('问'.repeat(60), 1).length))

console.log('\n=== 5. moveSelection / clampTurn ===')
check('ArrowDown +1', moveSelection(3, 'ArrowDown', 10) === 4, String(moveSelection(3, 'ArrowDown', 10)))
check('ArrowUp 到下界夹住', moveSelection(0, 'ArrowUp', 10) === 0, String(moveSelection(0, 'ArrowUp', 10)))
check('PageDown +5', moveSelection(2, 'PageDown', 20) === 7, String(moveSelection(2, 'PageDown', 20)))
check('PageUp 到上界夹住', moveSelection(3, 'PageUp', 20) === 0, String(moveSelection(3, 'PageUp', 20)))
check('Home → 0', moveSelection(9, 'Home', 20) === 0, String(moveSelection(9, 'Home', 20)))
check('End → n-1', moveSelection(0, 'End', 20) === 19, String(moveSelection(0, 'End', 20)))
check('非导航键 → null', moveSelection(0, 'a', 20) === null, String(moveSelection(0, 'a', 20)))
check('clampTurn 越界夹住', clampTurn(99, 4) === 3 && clampTurn(-5, 4) === 0, `${clampTurn(99, 4)} / ${clampTurn(-5, 4)}`)

// ---------------------------------------------------------------- 6. 源码 / CSS 结构不变量
console.log('\n=== 6. 源码接线（纯函数 / 组件 / 数据源）===')
const indexRaw = read(INDEX_REL)
const railRaw = read(RAIL_REL)
const cssRaw = read(CSS_REL)

check('TurnRail 组件存在且被 index.tsx 使用', railRaw.length > 0 && indexRaw.includes("from './TurnRail'") && indexRaw.includes('<TurnRail '), '')
check('纯函数模块被 index.tsx 引入（turnTitle / pickTurn / ACTIVE_THRESHOLD）',
  /from '\.\/turnRailPure'/.test(indexRaw) && /\bturnTitle\b/.test(indexRaw) && /\bpickTurn\b/.test(indexRaw) && /\bACTIVE_THRESHOLD\b/.test(indexRaw), '')
check('数据源 = 用户提问（role !== \'user\' 直接跳过）',
  /role !== 'user'\) return[\s\S]{0,200}?turnTitle\(m\.content/.test(indexRaw), '')
check('旧「每条 AI 回答一个刻度」的 anchors 已清除', !/\banchors\b/.test(indexRaw) && !/\bjumpToAnchor\b/.test(indexRaw), '')
check('msgAnchorTitle 仍保留（「整理成文档」取文件名）',
  /function msgAnchorTitle\(/.test(indexRaw) && /const title = msgAnchorTitle\(content, idx\)/.test(indexRaw), '')
check('旧定高圆点轨道（h-1.5 / h-3 圆点 + tooltip）已清除',
  !/h-1\.5 bg-\[var\(--border-color\)\]/.test(indexRaw) && !/w-1\.5 rounded-full transition-all/.test(indexRaw), '')
check('显示门限 = 2 轮起', /turns\.length >= 2 && \(/.test(indexRaw), '')
check('data-msg-idx 仍在（滚动定位与测量的唯一锚点）', /data-msg-idx=\{idx\}/.test(indexRaw), '')
check('本版不做 +N 折叠（TurnRail 内零命中）', !/\+N/.test(railRaw), '')

{
  const from = indexRaw.indexOf('const onConvScroll = useCallback')
  const to = indexRaw.indexOf('const jumpToTurn = useCallback')
  const body = from >= 0 && to > from ? indexRaw.slice(from, to) : ''
  check('onConvScroll 里不再逐帧 querySelector（改为缓存 + 二分）',
    body.length > 0 && !body.includes('querySelector') && body.includes('readActiveTurn'), `body=${body.length}chars`)
  check('onConvScroll 走 rAF 合并（每帧只算一次）', /requestAnimationFrame/.test(body), '')
  check('测量用 offsetTop 缓存 + ResizeObserver 失效重测',
    /measureTurns/.test(indexRaw) && /new ResizeObserver/.test(indexRaw) && /offsetTop/.test(indexRaw), '')
  check('跳转不再用 scrollIntoView', !indexRaw.includes('.scrollIntoView(') && /c\.scrollTo\(\{ top: target/.test(indexRaw), '')
  check('贴底特判在纯函数里（pickTurn）+ 调用方传 maxScroll', /pickTurn\(/.test(indexRaw) && /scrollHeight - c\.clientHeight/.test(indexRaw), '')
  check('闪烁层按 seq 重挂（同一行连点也能重播）', /key=\{`flash-\$\{flash\.seq\}`\}/.test(indexRaw), '')
  check('reduced-motion 下不挂闪烁层（不是只关动画）', /if \(!prefersReducedMotion\(\)\)/.test(indexRaw), '')
}

console.log('\n=== 7. TurnRail 形态（收起态 / 展开态 / 交互）===')
check('收起态用 .kb-turn-rail（一列短横）', /className="kb-turn-rail"/.test(railRaw) && /className="kb-turn-dash"/.test(railRaw), '')
check('收起态条数来自 dashIndexes（≤11）', /dashIndexes\(turns\.length\)/.test(railRaw), '')
check('展开卡片：宽 min(300, 中栏-44)',
  /width: 'min\(300px, calc\(100% - 44px\)\)'/.test(railRaw), '')
check('展开卡片：max-height 封顶 + 内部滚动',
  /max-h-\[min\(300px,calc\(100%_-_20px\)\)\]/.test(railRaw) && /overflow-y-auto/.test(railRaw) && /kb-hide-scrollbar/.test(railRaw), '')
check('行 = 右对齐首句 + 行尾 12x2 短横', /justify-end gap-2\.5/.test(railRaw) && /h-0\.5 w-3/.test(railRaw) && /truncate/.test(railRaw), '')
check('hover 0ms 展开 / 离开 240ms 收起', /pointerType !== 'mouse'/.test(railRaw) && /CLOSE_DELAY = 240/.test(railRaw), '')
check('卡片与短横列之间移动不收起（指针在卡片矩形内不排关闭）', /cardRef\.current\?\.getBoundingClientRect\(\)/.test(railRaw), '')
check('触摸 / 笔点 → 展开并钉住', /onClick=\{\(\) => openRail\(true\)\}/.test(railRaw) && /if \(pin\) setPinned\(true\)/.test(railRaw), '')
check('Esc / 点外部 → 关闭并解除钉住', /closeRail\(true\)/.test(railRaw) && /addEventListener\('pointerdown'/.test(railRaw), '')
check('Esc 不落到模块既有 Esc 链（捕获阶段 stopPropagation）',
  /addEventListener\('keydown', onKey, true\)/.test(railRaw) && /stopPropagation\(\)/.test(railRaw), '')
check('键盘：↑↓ / Home / End / PgUp / PgDn / Enter', /moveSelection\(sel, e\.key, turns\.length\)/.test(railRaw) && /onJump\(sel\)/.test(railRaw), '')
check('打开时把当前轮滚进卡片视野', /scrollRowIntoView\(focusMode \? sel : active\)/.test(railRaw), '')
check('键盘选择与滚动位置双向同步', /if \(focusMode\) setSel\(active\)/.test(railRaw), '')

console.log('\n=== 8. CSS 基建（.kb-turn-flash / .kb-turn-rail）===')
const ruleBody = (src, selector) => {
  const i = src.indexOf(selector)
  if (i < 0) return null
  const open = src.indexOf('{', i)
  const close = src.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return src.slice(open + 1, close)
}
const decl = (body, prop) => {
  if (!body) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`, 'i').exec(body)
  return m ? m[1].trim() : null
}
const flash = ruleBody(cssRaw, '.kb-turn-flash {')
check('.kb-turn-flash 规则存在', flash !== null, '')
check('.kb-turn-flash 只动 opacity 的绝对覆盖层',
  decl(flash, 'position') === 'absolute' && decl(flash, 'pointer-events') === 'none' && String(decl(flash, 'opacity')) === '0', '')
check('.kb-turn-flash 动画 1.8s + 既有缓动令牌',
  /^kb-turn-flash\s+1\.8s\s+var\(--ease-kb\)/.test(String(decl(flash, 'animation'))), String(decl(flash, 'animation')))
check('@keyframes kb-turn-flash 存在', /@keyframes kb-turn-flash\s*\{/.test(cssRaw), '')
const flashRm = cssRaw.slice(cssRaw.indexOf('.kb-turn-flash {'))
check('reduced-motion 下闪烁层 display:none', /@media \(prefers-reduced-motion: reduce\) \{\s*\.kb-turn-flash \{ display: none; \}/.test(flashRm), '')

const railBox = ruleBody(cssRaw, '.kb-turn-rail {')
check('.kb-turn-rail 规则存在', railBox !== null, '')
check('.kb-turn-rail 垂直 55% 居中（不贯穿全高）',
  String(decl(railBox, 'top')) === '55%' && String(decl(railBox, 'transform')) === 'translateY(-50%)', `${decl(railBox, 'top')} / ${decl(railBox, 'transform')}`)
check('.kb-turn-rail 没有任何纵向铺满（无 inset-y / bottom）',
  decl(railBox, 'bottom') === null && !/inset-y/.test(railBox) && decl(railBox, 'height') === null, String(decl(railBox, 'bottom')))
check('.kb-turn-rail 命中区外扩（::before）', /\.kb-turn-rail::before \{[^}]*inset:\s*-16px -14px/.test(cssRaw), '')
const dashCur = ruleBody(cssRaw, ".kb-turn-dash[data-cur='1'] {")
check('当前条 = 14x2 + --accent', String(decl(dashCur, 'width')) === '14px' && String(decl(dashCur, 'background')) === 'var(--accent)', `${decl(dashCur, 'width')} / ${decl(dashCur, 'background')}`)
check('非当前条 12x2、muted 45%', /\.kb-turn-dash \{[^}]*width:\s*12px[\s\S]*?height:\s*2px[\s\S]*?text-muted\) 45%/.test(cssRaw), '')

console.log('\n=== 9. 文档同步（铁律 13）===')
check('docs/ui-animation-plan.md 收录 .kb-turn-flash', has('docs/ui-animation-plan.md', '.kb-turn-flash'), '')
check('docs/ui-updates.md 有本次流水', has('docs/ui-updates.md', '右缘轮次导航'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)
process.exit(failed.length === 0 ? 0 : 1)
