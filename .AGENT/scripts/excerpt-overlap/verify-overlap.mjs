#!/usr/bin/env node
/**
 * 契约验证：「摘录重叠不混色」的几何纯函数。
 *
 * 为什么需要它：这套逻辑错了**不会报任何错** ——
 * ① 扣错了方向，屏幕上只是「颜色多一块 / 少一块」，没人会想到是几何算错；
 * ② eps 单位给错（px 与百分比混用），要么碎片多到肉眼看不见的细条，要么整块被吞掉；
 * ③ TXT 的「新的赢」写反成「老的赢」，表象只是「点了新摘录却弹出旧备注」。
 *
 * 验证的是**口径**，不是「代码能跑」：
 *   §1 subtractRect 基础（不相交 / 贴边 / 全覆盖 / 四向切分）
 *   §2 visibleRects 多覆盖链（后建的盖住先建的）
 *   §3 单位与 eps（px 与 0..1 百分比同式）
 *   §4 newestMarkAt（TXT 字符区间：新的赢）
 *   §5 与实际调用参数对齐（EPUB 0.5px / PDF 0.0005）
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/excerpt-overlap/verify-overlap.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import {
  intersectRect, subtractRect, visibleRects, newestMarkAt,
} from '../../../src/components/shared/excerptOverlap.ts'

let failures = 0
const pass = (m) => console.log(`  [OK] ${m}`)
const fail = (m) => { failures += 1; console.log(`  [FAIL] ${m}`) }
const ok = (m, cond, extra) => (cond ? pass(m) : fail(`${m}${extra ? ` (${extra})` : ''}`))

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol
const rect = (left, top, right, bottom) => ({ left, top, right, bottom })
const same = (a, b) => near(a.left, b.left) && near(a.top, b.top) && near(a.right, b.right) && near(a.bottom, b.bottom)
const includes = (list, target) => list.some((r) => same(r, target))
const area = (r) => (r.right - r.left) * (r.bottom - r.top)
const sumArea = (list) => list.reduce((s, r) => s + area(r), 0)

console.log('\n§1 subtractRect 基础')

{
  const base = rect(10, 10, 110, 30)
  const out = subtractRect(base, rect(200, 200, 300, 300))
  ok('不相交 → 原样返回一块', out.length === 1 && same(out[0], base), JSON.stringify(out))
}
{
  const base = rect(10, 10, 110, 30)
  const out = subtractRect(base, rect(110, 10, 210, 30))
  ok('贴边（right == left）不算相交 → 原样', out.length === 1 && same(out[0], base))
}
{
  const base = rect(10, 10, 110, 30)
  const out = subtractRect(base, rect(0, 0, 200, 200))
  ok('完全覆盖 → 空', out.length === 0, JSON.stringify(out))
}
{
  // 覆盖矩形落在 base 正中间（不贴边）→ 上下左右 4 块
  const base = rect(0, 0, 100, 40)
  const cover = rect(20, 10, 60, 30)
  const out = subtractRect(base, cover)
  ok('中间开洞 → 4 块', out.length === 4, JSON.stringify(out))
  ok('4 块面积之和 = 原面积 - 交面积', near(sumArea(out), area(base) - area(cover), 1e-6),
    `${sumArea(out)} vs ${area(base) - area(cover)}`)
  ok('洞的位置不再被任何碎片覆盖', out.every((r) => !intersectRect(r, cover)))
}
{
  const base = rect(0, 0, 100, 40)
  const out = subtractRect(base, rect(40, -10, 200, 60))
  ok('覆盖右半 → 只剩左块', out.length === 1 && same(out[0], rect(0, 0, 40, 40)), JSON.stringify(out))
}
{
  const out = subtractRect(rect(0, 0, 1, 1), rect(0, 0, 0.9999, 1), 0.0005)
  ok('剩余细条 < eps → 丢弃', out.length === 0, JSON.stringify(out))
}

console.log('\n§2 visibleRects：后建的盖住先建的')
{
  // 同一行文字：老的横贯整行，新的在中间
  const oldRect = rect(0, 0, 400, 20)
  const newRect = rect(150, 0, 250, 20)
  const vis = visibleRects([oldRect], [newRect])
  ok('老条目只剩左右两块', vis.length === 2, JSON.stringify(vis))
  ok('老条目的可见区不与新条目相交', vis.every((r) => !intersectRect(r, newRect)))
  ok('新条目自身不受影响（无更新覆盖）', visibleRects([newRect], []).length === 1)
}
{
  // 三链：A 被 B 覆盖左段，B 被 C 覆盖中段
  const a = rect(0, 0, 300, 20)
  const b = rect(100, 0, 300, 20)
  const c = rect(150, 0, 200, 20)
  const visA = visibleRects([a], [b, c])
  const visB = visibleRects([b], [c])
  ok('A 只剩 [0,100]', visA.length === 1 && near(visA[0].left, 0) && near(visA[0].right, 100), JSON.stringify(visA))
  ok('B 剩左右两块', visB.length === 2, JSON.stringify(visB))
  ok('A/B 的可见区都与 C 不相交', [...visA, ...visB].every((r) => !intersectRect(r, c)))
}
{
  // 多行摘录（每行一块 rect）只被新条目压住其中一行
  const lines = [rect(0, 0, 300, 20), rect(0, 24, 120, 44)]
  const cover = rect(100, 0, 200, 20)
  const vis = visibleRects(lines, [cover])
  ok('只有被压住的那一行被切开', vis.length === 3, JSON.stringify(vis))
  ok('第二行原样保留', includes(vis, lines[1]))
}
{
  // 多次覆盖不应把整条吃掉（错误的「整条隐藏」实现会返回 0 块）
  const base = rect(0, 0, 100, 20)
  const vis = visibleRects([base], [rect(0, 0, 1, 20), rect(99, 0, 100, 20)])
  ok('首尾各被吃掉 1px → 中间仍在', vis.length === 1 && near(vis[0].left, 1) && near(vis[0].right, 99), JSON.stringify(vis))
}

console.log('\n§3 单位一致性（px 与 0..1 百分比同式）')
{
  const pxOld = rect(0, 0, 600, 30)
  const pxNew = rect(200, 0, 400, 30)
  const pctOld = rect(0, 0, 1, 0.03)
  const pctNew = rect(1 / 3, 0, 2 / 3, 0.03)
  const a = visibleRects([pctOld], [pctNew], 0.0005)
  // 页面 600×1000：百分比 × (600, 1000) 还原成像素后两边必须逐块相同
  const b = visibleRects([pxOld], [pxNew], 0.5).map((r) => rect(r.left / 600, r.top / 1000, r.right / 600, r.bottom / 1000))
  ok('百分比与像素得到同样的两块', a.length === b.length && a.every((r, i) => same(r, b[i])),
    `${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
}
{
  // 百分比下用 px 的 eps（0.5）会把整页都判成「不可见」
  const pct = rect(0, 0, 0.01, 0.01)
  const withPxEps = visibleRects([pct], [rect(0.009, 0, 0.02, 0.01)], 0.5)
  const withPctEps = visibleRects([pct], [rect(0, 0, 0.02, 0.01)], 0.0005)
  ok('百分比必须用小 eps（大 eps 会吞掉整块）', withPxEps.length === 0)
  ok('百分比被完全覆盖 → 空', withPctEps.length === 0)
}

console.log('\n§4 newestMarkAt：TXT 字符区间新的赢')
{
  const marks = [
    { id: 'old', start: 0, end: 10 },
    { id: 'new', start: 2, end: 8 },
  ]
  ok('区间内取最后一条', newestMarkAt(marks, 3, 6)?.id === 'new')
  ok('只在老条目里 → 取老条目', newestMarkAt(marks, 0, 1)?.id === 'old')
  ok('无人覆盖 → undefined', newestMarkAt(marks, 20, 30) === undefined)
  ok('空洞（老条目里的新条目之外）→ 老条目', newestMarkAt(marks, 8, 10)?.id === 'old')
}
{
  // 三条同起点：最后一条（最晚创建）必须赢
  const marks = [{ id: 'a', start: 0, end: 5 }, { id: 'b', start: 0, end: 5 }, { id: 'c', start: 0, end: 5 }]
  ok('完全重叠取最晚创建的一条', newestMarkAt(marks, 0, 5)?.id === 'c')
}

console.log('\n§5 与真实调用参数对齐')
{
  // EpubReaderView：px，0.5 阈值；pdfPageTools：百分比，0.0005 阈值
  const epubVis = visibleRects([rect(100, 100, 200, 120)], [rect(100, 100, 150, 120)], 0.5)
  ok('EPUB px 口径：左半被盖 → 右半 100→200', epubVis.length === 1 && near(epubVis[0].left, 150) && near(epubVis[0].right, 200),
    JSON.stringify(epubVis))
  const pdfVis = visibleRects([rect(0.1, 0.1, 0.5, 0.12)], [rect(0.1, 0.1, 0.3, 0.12)], 0.0005)
  ok('PDF 百分比口径：左半被盖 → 右半 0.3→0.5', pdfVis.length === 1 && near(pdfVis[0].left, 0.3) && near(pdfVis[0].right, 0.5),
    JSON.stringify(pdfVis))
}

console.log('')
if (failures > 0) {
  console.log(`FAIL: ${failures} 项不通过`)
  process.exit(1)
}
console.log('PASS: 摘录重叠口径全部通过')
