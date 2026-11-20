#!/usr/bin/env node
/**
 * 契约验证：划词浮层的定位口径（`src/lib/floatingPlacement.ts` 的纯函数部分）。
 *
 * 为什么需要它：这套算法错了**不会报任何错**，只会「看起来有点怪」——
 * ① 只按窗口右缘夹 → 浮条右半截滑进悬浮 AI 侧栏底下（用户反馈：右侧按钮像被盖住、点不到）；
 * ② 按挂载那刻量的高度摆位 → 词典 / AI 结果长出来后被窗口底缘截断（用户反馈：划靠下的词看不全）。
 * 两条都是「定位口径」错，不是渲染错，所以只能靠纯函数用例锁住。
 *
 * 用例表：
 *   §1 clampFloatingLeft —— 贴锚点 / 右缘出界 / 左缘出界 / 比可用宽度还宽
 *   §2 placeFloatingVertically —— 下方宽松 / 靠底部翻上方 / 首选项 = 上方（浮条）/ 两侧都挤
 *   §3 回归：用户报的两張截图几何（窗口底部划词 / 侧栏占掉右半边）
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/selection-popover/verify-placement.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import {
  FLOAT_GAP, clampFloatingLeft, placeFloatingVertically,
} from '../../../src/lib/floatingPlacement.ts'

let failures = 0
const pass = (m) => console.log(`  [OK] ${m}`)
const fail = (m) => { failures += 1; console.log(`  [FAIL] ${m}`) }
const ok = (m, cond, extra) => (cond ? pass(m) : fail(`${m}${extra ? ` (${extra})` : ''}`))
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol
const box = (left, top, right, bottom) => ({ left, top, right, bottom })

console.log('\n§1 clampFloatingLeft')

{
  const bounds = box(0, 0, 1600, 900)
  ok('宽松区：与锚点左缘对齐', near(clampFloatingLeft(400, 380, bounds), 400))
}
{
  const bounds = box(0, 0, 1600, 900)
  // 锚点 1500 + 宽 380 → 右缘 1880 出界，应右对齐到 1600 - 8 - 380
  ok('右侧出界：右缘贴边界', near(clampFloatingLeft(1500, 380, bounds), 1600 - FLOAT_GAP - 380))
}
{
  const bounds = box(56, 0, 1600, 900)
  ok('左侧出界：左缘贴边界', near(clampFloatingLeft(0, 380, bounds), 56 + FLOAT_GAP))
}
{
  const bounds = box(0, 0, 300, 900)
  ok('比可用宽度还宽：贴左缘（交给 maxWidth 换行）', near(clampFloatingLeft(120, 380, bounds), FLOAT_GAP))
}
{
  // 阅读面被侧栏挤窄：浮条必须整体落在阅读面里
  const bounds = box(0, 0, 640, 900)
  const left = clampFloatingLeft(600, 380, bounds)
  ok('阅读面 640 宽：右缘不出阅读面', near(left + 380, 640 - FLOAT_GAP), `left=${left}`)
}

console.log('\n§2 placeFloatingVertically')

{
  const bounds = box(0, 0, 1600, 900)
  const v = placeFloatingVertically({ anchorTop: 200, anchorBottom: 220, bounds, cap: 560 })
  ok('下方宽松：走下方', v.side === 'below', v.side)
  ok('下方宽松：top = 选区下缘 + 间距', near(v.top, 220 + FLOAT_GAP))
  ok('下方宽松：高度封顶 = cap', near(v.maxHeight, 560))
}
{
  const bounds = box(0, 0, 1600, 900)
  // 选区几乎贴窗口底：下方只有 ~30px —— 这正是词典卡被截断的场景
  const v = placeFloatingVertically({ anchorTop: 840, anchorBottom: 860, bounds, cap: 560, minUsable: 220 })
  ok('贴底部：翻到上方', v.side === 'above', v.side)
  ok('贴底部：底缘贴选区上方（绝对 y = 选区顶 - 间距）', near(v.bottomEdge, 840 - FLOAT_GAP), String(v.bottomEdge))
  ok('贴底部：高度不超过上方可用空间', v.maxHeight <= 840 - FLOAT_GAP - FLOAT_GAP + 1e-6, String(v.maxHeight))
}
{
  const bounds = box(0, 0, 1600, 900)
  // 浮条首选项 = 上方：选区在页面中部 → 上方
  const v = placeFloatingVertically({ anchorTop: 500, anchorBottom: 520, bounds, cap: 360, prefer: 'above', minUsable: 46 })
  ok('浮条默认在上方', v.side === 'above', v.side)
}
{
  const bounds = box(0, 0, 1600, 900)
  // 选区贴着工具栏（上方 20px）→ 浮条翻到下方
  const v = placeFloatingVertically({ anchorTop: 20, anchorBottom: 40, bounds, cap: 360, prefer: 'above', minUsable: 46 })
  ok('上方不够：浮条翻到下方', v.side === 'below', v.side)
  ok('上方不够：top = 选区下缘 + 间距', near(v.top, 40 + FLOAT_GAP))
}
{
  const bounds = box(0, 0, 1200, 400)
  // 两侧都很挤（小窗口 / 大卡片）：取空间更大的一侧，且高度必须收进那段空间
  const v = placeFloatingVertically({ anchorTop: 180, anchorBottom: 200, bounds, cap: 560 })
  const space = v.side === 'below'
    ? bounds.bottom - FLOAT_GAP - (200 + FLOAT_GAP)
    : 180 - FLOAT_GAP - (bounds.top + FLOAT_GAP)
  ok('两侧都挤：高度收进所选空间', v.maxHeight <= space + 1e-6, `${v.maxHeight} > ${space}`)
  ok('两侧都挤：不会低到 0（保留最小可读高度）', v.maxHeight >= 48, String(v.maxHeight))
}

console.log('\n§3 回归：用户报的两张截图几何')

{
  // 截图 1：阅读页 900 高，选中的词下缘 780（下方只剩 ~112px），词典卡本来要 560 高
  const bounds = box(0, 0, 1400, 900)
  const v = placeFloatingVertically({ anchorTop: 760, anchorBottom: 780, bounds, cap: 560, minUsable: 220 })
  ok('划靠下的词：卡片翻到选区上方（不再被窗口底缘截断）', v.side === 'above', v.side)
  ok('卡片底缘落在窗口内（且不压住选区）', v.bottomEdge <= 760 - FLOAT_GAP + 1e-6, String(v.bottomEdge))
  ok('卡片顶缘不会出窗口', (v.bottomEdge ?? 0) - v.maxHeight >= bounds.top - 1e-6,
    `top=${(v.bottomEdge ?? 0) - v.maxHeight} maxH=${v.maxHeight}`)
}
{
  // 截图 2：1600 宽窗口，悬浮 AI 侧栏占掉右侧 420 → 安全右缘 1180
  const bounds = box(0, 0, 1180, 900)
  const barW = 380
  const left = clampFloatingLeft(1100, barW, bounds)
  ok('选区靠右：浮条右缘不进侧栏', left + barW <= bounds.right - FLOAT_GAP + 1e-6, `right=${left + barW}`)
  ok('选区靠右：浮条仍与阅读面左缘留出间距', left >= bounds.left + FLOAT_GAP)
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
