/**
 * 契约验证：AI教学「学习流」画布 v2（折行泳道）。
 *
 * 方案：`E:\Projects\KnowledgeRecorder\.AGENT\.claude\plans\ai-teaching-flow-v2-impl.md`
 * 原型：`E:\Projects\KnowledgeRecorder\tmp\aiteach-flow-proto-v2\index.html`（已验收）
 *
 * 两类断言：
 *  A. 纯函数真实实现执行 —— 直接 strip-types import `src/modules/ai-teaching/flow/flowLayout.ts`
 *     与 `src/modules/ai-teaching/constraintsParse.ts`（两者零依赖），验证折行列数 / 折行坐标 /
 *     阅读顺序 / 落点解析 / 主干锚点 / 当前章与「继续学」判定（不复刻逻辑）。
 *  B. 接线静态断言 —— 画布组件存在、拖拽锁与插入位接了、位置持久化确实退役、右栏「层级」面接上
 *     （这类漏接是静默的：组件没被渲染 = 界面「点了没反应」，没有任何报错）。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/ai-teaching/verify-flow-layout.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-verify-'))
/** strip 类型后 import 真实实现（零依赖文件才装得进来） */
const loadPure = async (rel, name) => {
  const src = read(rel)
  check(`${name} 零 import（否则契约脚本装不进来）`, !/^\s*import\s/m.test(src), '')
  const f = path.join(tmpDir, `${name}.mjs`)
  fs.writeFileSync(f, stripTypeScriptTypes(src, { mode: 'strip' }))
  return import(pathToFileURL(f).href)
}

// ---------------------------------------------------------------- A. 纯函数真实实现
const F = await loadPure('src/modules/ai-teaching/flow/flowLayout.ts', 'flowLayout')
const {
  NODE_W, NODE_H, GAP_X, GAP_Y, ZONE_PAD, ZONE_HEAD, ZONE_FOOT, ROW_GAP, X0, Y0, MAX_COLS, COLLAPSED_MIN_W,
  colsForWidth, layoutLanes, sortReadingOrder, wrapOrder, resolveDropIndex, dropBarRect,
  chainEdges, spineEdges, edgePath, spinePath, bounds, frameAt, applyDragToChapters,
  pickActiveChapter, pickNextUnit, fitViewport, snapValue, clamp, screenToWorld,
} = F

const ch = (id, ids) => ({ id, units: ids.map((u) => ({ id: u, x: 0, y: 0 })) })

console.log('\n=== 1. colsForWidth：折行列数必须由画布宽度反算 ===')
check('1000px 中栏 → 3 列', colsForWidth(1000) === 3, String(colsForWidth(1000)))
check('640px 窄中栏 → 2 列', colsForWidth(640) === 2, String(colsForWidth(640)))
check('320px 极窄 → 1 列（不返回 0 / 负数）', colsForWidth(320) === 1, String(colsForWidth(320)))
check('4000px 超宽 → 夹到 MAX_COLS', colsForWidth(4000) === MAX_COLS, String(colsForWidth(4000)))
check('width=0（首帧还没量到）→ 1 列，不崩', colsForWidth(0) === 1, String(colsForWidth(0)))
// 固定阈值口径的反例：4 列在 1000px 下算出的章框必须超出画布 —— 这正是「等于没折行」的判据
const fourColW = 4 * NODE_W + 3 * GAP_X + ZONE_PAD * 2
check('按「宽屏 4 列」的固定阈值会超出 1000px 画布（反例成立）', fourColW > 1000, String(fourColW))

console.log('\n=== 2. layoutLanes：折行泳道坐标与章框 ===')
const ch2 = [ch('c1', ['a', 'b', 'c', 'd']), ch('c2', ['e', 'f']), ch('c3', [])]
const lay = layoutLanes({ chapters: ch2, cols: 2, closedIds: new Set(['c3']) })
check('章框数 = 章数', lay.frames.length === 3, String(lay.frames.length))
check('每章 2 列：第 1 行 y 相同、x 差 = NODE_W + GAP_X', lay.pos.a.y === lay.pos.b.y && lay.pos.b.x - lay.pos.a.x === NODE_W + GAP_X, JSON.stringify({ a: lay.pos.a, b: lay.pos.b }))
check('第 2 行回到第 1 列（阅读顺序折行）', lay.pos.c.x === lay.pos.a.x && lay.pos.d.x === lay.pos.b.x, JSON.stringify({ c: lay.pos.c, d: lay.pos.d }))
check('行距 = NODE_H + GAP_Y', lay.pos.c.y - lay.pos.a.y === NODE_H + GAP_Y, String(lay.pos.c.y - lay.pos.a.y))
check('首列 / 首行落在 X0 / Y0', lay.pos.a.x === X0 && lay.pos.a.y === Y0, JSON.stringify(lay.pos.a))
const f1 = lay.frames[0]
check('章框左/上各留 ZONE_PAD / ZONE_HEAD', f1.rect.x === X0 - ZONE_PAD && f1.rect.y === Y0 - ZONE_HEAD, JSON.stringify(f1.rect))
check('展开章框宽 = 列宽 + 两侧留白（落在画布内）', f1.rect.w === 2 * NODE_W + GAP_X + ZONE_PAD * 2 && f1.rect.w < 1000, String(f1.rect.w))
check('展开章框高 = 标题条 + 折行内容 + 注记带', f1.rect.h === ZONE_HEAD + (2 * NODE_H + GAP_Y) + ZONE_FOOT, String(f1.rect.h))
check('章框完整包住自己的卡片', f1.rect.x < lay.pos.a.x && f1.rect.x + f1.rect.w >= lay.pos.b.x + NODE_W && f1.rect.y + f1.rect.h >= lay.pos.c.y + NODE_H, JSON.stringify(f1.rect))
check('章自上而下堆叠（下一章框 y 更大）', lay.frames[1].rect.y > f1.rect.y, JSON.stringify([f1.rect.y, lay.frames[1].rect.y]))
check('章间距 = ROW_GAP', lay.frames[1].rect.y - (f1.rect.y + f1.rect.h) === ROW_GAP, String(lay.frames[1].rect.y - (f1.rect.y + f1.rect.h)))
check('折叠章 = 标题条高的条（不是零高）', lay.frames[2].rect.h === ZONE_HEAD + ZONE_PAD, String(lay.frames[2].rect.h))
check('空章宽 = COLLAPSED_MIN_W（不留 -64 的负宽）', lay.frames[2].rect.w === COLLAPSED_MIN_W, JSON.stringify(lay.frames[2].rect))
check('折叠章的卡片不进 pos（没有坐标可画）', !lay.pos.g && !('g' in lay.pos), JSON.stringify(Object.keys(lay.pos)))
check('frames.per / rows 记录本章实际列行数', f1.per === 2 && f1.rows === 2, JSON.stringify({ per: f1.per, rows: f1.rows }))
const layNarrow = layoutLanes({ chapters: ch2, cols: 1, closedIds: new Set() })
check('cols=1（窄中栏）：4 张卡竖排成一列', layNarrow.pos.b.x === layNarrow.pos.a.x && layNarrow.pos.b.y - layNarrow.pos.a.y === NODE_H + GAP_Y, JSON.stringify([layNarrow.pos.a, layNarrow.pos.b]))
check('cols=1：章框宽 = 单卡 + 留白', layNarrow.frames[0].rect.w === NODE_W + ZONE_PAD * 2, String(layNarrow.frames[0].rect.w))

console.log('\n=== 2b. 章框底部注记带：最下排卡片不许压住注记 ===')
// 注记 = `bottom-2`（内缩 8）+ `text-[10.5px]`（继承 line-height 1.5 ⇒ 行盒 15.75）
const footClearance = ZONE_FOOT - 8 - 10.5 * 1.5
check('注记带容得下注记（行盒 + 内缩不溢出）', ZONE_FOOT > 8 + 10.5 * 1.5, `${ZONE_FOOT} vs ${8 + 10.5 * 1.5}`)
check('注记与最下排卡片之间留净空（≥8px）', footClearance >= 8, String(footClearance))

console.log('\n=== 3. 阅读顺序（先按行 y、再按列 x）===')
const scattered = [{ id: 'x', x: 348, y: 64 }, { id: 'y', x: 44, y: 218 }, { id: 'z', x: 44, y: 64 }]
check('sortReadingOrder：行优先（y 小的先）', sortReadingOrder(scattered).map((u) => u.id).join('') === 'zxy', sortReadingOrder(scattered).map((u) => u.id).join(''))
check('sortReadingOrder 不改原数组', scattered[0].id === 'x', scattered[0].id)
check('wrapOrder：跨章拼成一维（章序 × 章内行优先）', wrapOrder(ch2).join(',') === 'a,b,c,d,e,f', wrapOrder(ch2).join(','))

console.log('\n=== 4. resolveDropIndex：落点 → 目标章 + 章内序号 ===')
const dragBase = layoutLanes({ chapters: ch2, cols: 2, closedIds: new Set() })
const baseCh = dragBase.chapters
const dropAt = (dragId, x, y) => resolveDropIndex({ chapters: baseCh, cols: 2, closedIds: new Set(), dragId, cx: x, cy: y })
const p = dragBase.pos
// 把第 4 张（d，第 2 行第 2 列）拖到第 1 张（a）的中心：应插到第 0 位
const r0 = dropAt('d', p.a.x + NODE_W / 2, p.a.y + NODE_H / 2)
check('落点在第 1 槽 → index 0', r0 && r0.chapterId === 'c1' && r0.index === 0, JSON.stringify(r0))
check('顺序变了 → changed=true', r0 && r0.changed === true, JSON.stringify(r0))
check('beforeUnitId = 原第 1 张（a）', r0 && r0.beforeUnitId === 'a', JSON.stringify(r0))
// 同一张卡拖回原槽（第 2 行第 2 列）：顺序没变 → 不写盘
const rSelf = dropAt('d', p.d.x + NODE_W / 2, p.d.y + NODE_H / 2)
check('拖回原位 → changed=false（顺序未变不写盘）', rSelf && rSelf.changed === false, JSON.stringify(rSelf))
// 第 1 张拖到第 4 槽：追加到章末
const rEnd = dropAt('a', p.d.x + NODE_W / 2, p.d.y + NODE_H / 2)
check('拖到最后一槽 → index = 其它卡片数（追加）', rEnd && rEnd.index === 3 && rEnd.beforeUnitId === null, JSON.stringify(rEnd))
check('拖到最后一槽 → 新顺序以 a 结尾', rEnd && rEnd.changed === true, JSON.stringify(rEnd))
// 跨章：c1 的卡拖进 c2 的区域
const f2 = dragBase.frames.find((f) => f.id === 'c2')
const rCross = dropAt('a', f2.rect.x + ZONE_PAD + NODE_W / 2, f2.rect.y + ZONE_HEAD + NODE_H / 2)
check('跨章：目标章 = 命中的章框', rCross && rCross.chapterId === 'c2', JSON.stringify(rCross))
check('跨章：章内序号按落点算（第 0 槽）', rCross && rCross.index === 0, JSON.stringify(rCross))
check('跨章 → changed=true', rCross && rCross.changed === true, JSON.stringify(rCross))
// 拖到空白处（谁的框都不命中）→ 回落源章
const rBlank = dropAt('a', 9000, 9000)
check('落点在所有章框之外 → 回落源章（不丢卡）', rBlank && rBlank.chapterId === 'c1', JSON.stringify(rBlank))
check('不存在的 dragId → null（不崩）', dropAt('nope', 100, 100) === null, '')

console.log('\n=== 4b. dropBarRect：插入位指示条 ===')
const bar = dropBarRect(baseCh, dragBase.frames, 2, r0)
check('插入位条落在目标章内容区内', bar && bar.x >= f1.rect.x && bar.x <= f1.rect.x + f1.rect.w, JSON.stringify(bar))
check('插入位条高度 = 单行卡高（不再拉满整章）', bar && bar.h === NODE_H, JSON.stringify(bar))
const barEmptyCh = dropBarRect(dragBase.chapters, dragBase.frames, 2, { chapterId: 'c1', index: 0, beforeUnitId: null, changed: true })
check('第 0 槽也落在章框内（不飘到框外）', barEmptyCh && barEmptyCh.x >= f1.rect.x, JSON.stringify(barEmptyCh))

console.log('\n=== 5. chainEdges / spineEdges / edgePath ===')
const ce = chainEdges(baseCh, new Set())
check('章内相邻链条数 = Σ(n-1)', ce.length === 3 + 1, String(ce.length))
check('章内链条方向 = 阅读顺序（a→b→c→d）', ce.slice(0, 3).map((e) => `${e.fromId}${e.toId}`).join(',') === 'ab,bc,cd', ce.slice(0, 3).map((e) => `${e.fromId}${e.toId}`).join(','))
check('折叠的章不产生章内连线', chainEdges(baseCh, new Set(['c1'])).length === 1, String(chainEdges(baseCh, new Set(['c1'])).length))
const se = spineEdges(dragBase.frames)
check('章间主干数 = 章数 - 1', se.length === dragBase.frames.length - 1, String(se.length))
check('主干锚在上一章框底边中点', se[0].from.x === f1.rect.x + f1.rect.w / 2 && se[0].from.y === f1.rect.y + f1.rect.h, JSON.stringify(se[0].from))
check('主干锚在下一章框顶边中点', se[0].to.x === dragBase.frames[1].rect.x + dragBase.frames[1].rect.w / 2 && se[0].to.y === dragBase.frames[1].rect.y, JSON.stringify(se[0].to))
// 折叠态仍要连线（原型实测踩过的坑：锚卡片则章一折叠连线全被跳过）
const seClosed = spineEdges(layoutLanes({ chapters: ch2, cols: 2, closedIds: new Set(['c1']) }).frames)
check('章折叠时主干连线仍在（所以锚章框不是锚卡片）', seClosed.length === 2, String(seClosed.length))
const ep = edgePath(p.a, p.b)
check('edgePath 起点在卡片右缘中线', ep.startsWith(`M${p.a.x + NODE_W},${p.a.y + NODE_H / 2}`), ep)
check('edgePath 是三次贝塞尔', /^M[-0-9., ]+C/.test(ep), ep)
check('spinePath 起点即章框底中（竖线）', spinePath(se[0].from, se[0].to).startsWith(`M${se[0].from.x},${se[0].from.y}`), spinePath(se[0].from, se[0].to))

console.log('\n=== 6. bounds / frameAt ===')
const bb = bounds(dragBase.frames)
check('bounds 包住所有章框', bb.x <= f1.rect.x && bb.y <= f1.rect.y && bb.x + bb.w >= dragBase.frames[1].rect.x + dragBase.frames[1].rect.w, JSON.stringify(bb))
check('bounds 空输入 → 兜底矩形', JSON.stringify(bounds([])) === JSON.stringify({ x: 0, y: 0, w: 800, h: 600 }), '')
check('outerRect 已随「工作区外框」一起退役（2026-10-17 用户拍板：一个画布 = 一个工作区）', typeof F.outerRect === 'undefined', String(typeof F.outerRect))
check('frameAt 命中卡片所在章', frameAt(dragBase.frames, p.a.x + 5, p.a.y + 5) === 'c1', String(frameAt(dragBase.frames, p.a.x + 5, p.a.y + 5)))
check('frameAt 空白处 → null', frameAt(dragBase.frames, 9000, 9000) === null, '')

console.log('\n=== 7. applyDragToChapters：拖拽期间连线跟手 ===')
check('未拖拽 → 原样返回同一引用（下游 useMemo 不白重算）', applyDragToChapters(baseCh, null, 0, 0) === baseCh, '')
const dragLive = applyDragToChapters(baseCh, 'a', 1000, 700)
check('被拖节点坐标被覆盖成实时值', dragLive[0].units[0].x === 1000 && dragLive[0].units[0].y === 700, JSON.stringify(dragLive[0].units[0]))
check('同章其余节点坐标不动', dragLive[0].units[1].x === baseCh[0].units[1].x, '')
check('纯函数：不修改入参', baseCh[0].units[0].x !== 1000, String(baseCh[0].units[0].x))
// 拖拽中卡片的连线端点取实时坐标（v1 的 bug 就是这里读了已提交坐标 → 只有卡片在动）
const liveEdge = edgePath(dragLive[0].units[0], dragLive[0].units[1])
check('连线端点取实时坐标（起点跟着卡片走）', liveEdge.startsWith(`M${1000 + NODE_W},`), liveEdge)

console.log('\n=== 8. pickActiveChapter / pickNextUnit（§19 / §20）===')
const prog = { a: { status: 'mastered' }, b: { status: 'learning' } }
check('记忆优先：记住的章仍在大纲里就用它', pickActiveChapter(ch2, prog, 'c3') === 'c3', String(pickActiveChapter(ch2, prog, 'c3')))
check('无记忆 / 记忆已失效 → 取有 learning 知识点的章', pickActiveChapter(ch2, prog, null) === 'c1' && pickActiveChapter(ch2, prog, 'gone') === 'c1', String(pickActiveChapter(ch2, prog, 'gone')))
const prog2 = { a: { status: 'mastered' } }
check('没有 learning → 取第一个还有未掌握的章', pickActiveChapter(ch2, prog2, null) === 'c1', String(pickActiveChapter(ch2, prog2, null)))
check('全部掌握 → 退回第一章（不留空当前章）', pickActiveChapter(ch2, { a: { status: 'mastered' }, b: { status: 'mastered' }, c: { status: 'mastered' }, d: { status: 'mastered' }, e: { status: 'mastered' }, f: { status: 'mastered' } }, null) === 'c1', '')
check('空大纲 → null', pickActiveChapter([], {}, null) === null, '')
check('继续学：接着上次那节课（上次的还没掌握）', pickNextUnit(ch2, { a: { status: 'mastered' }, c: { status: 'todo' } }, 'c1', 'c') === 'c', String(pickNextUnit(ch2, { a: { status: 'mastered' }, c: { status: 'todo' } }, 'c1', 'c')))
check('继续学：上次那节已掌握 → 当前章第一个未掌握', pickNextUnit(ch2, { a: { status: 'mastered' } }, 'c1', 'a') === 'b', String(pickNextUnit(ch2, { a: { status: 'mastered' } }, 'c1', 'a')))
check('继续学：当前章学完 → 退到全课第一个未掌握', pickNextUnit(ch2, { a: { status: 'mastered' }, b: { status: 'mastered' }, c: { status: 'mastered' }, d: { status: 'mastered' } }, 'c1', null) === 'e', String(pickNextUnit(ch2, { a: { status: 'mastered' }, b: { status: 'mastered' }, c: { status: 'mastered' }, d: { status: 'mastered' } }, 'c1', null)))
check('继续学：全学完 → null（浮动条显「全部学完」）', pickNextUnit(ch2, { a: { status: 'mastered' }, b: { status: 'mastered' }, c: { status: 'mastered' }, d: { status: 'mastered' }, e: { status: 'mastered' }, f: { status: 'mastered' } }, 'c1', null) === null, '')

console.log('\n=== 9. 工具 / 视线 ===')
check('snapValue 对齐到 20 网格', snapValue(31) === 40 && snapValue(29) === 20, `${snapValue(31)},${snapValue(29)}`)
check('clamp 边界', clamp(5, 0, 10) === 5 && clamp(-1, 0, 10) === 0 && clamp(99, 0, 10) === 10, '')
const sw = screenToWorld(200, 150, 50, 50, { x: 0, y: 0, k: 2 })
check('screenToWorld 反推世界坐标', sw.x === (200 - 50) / 2 && sw.y === (150 - 50) / 2, JSON.stringify(sw))
const fv = fitViewport({ x: 0, y: 0, w: 1000, h: 500 }, 1000, 700, 48)
check('fitViewport：等比缩放到装得下', Math.abs(fv.k - 0.904) < 1e-9, String(fv.k))
check('fitViewport：居中', Math.abs(fv.x - 48) < 1e-9 && Math.abs(fv.y - 124) < 1e-9, JSON.stringify(fv))
const fvTiny = fitViewport({ x: 0, y: 0, w: 10, h: 10 }, 1000, 700, 48)
check('fitViewport：小图不放大过 maxK', fvTiny.k === 1.1, String(fvTiny.k))

// ---------------------------------------------------------------- A2. constraintsParse
console.log('\n=== 10. constraintsParse：条目化往返 + 非条目行只读 ===')
const C = await loadPure('src/modules/ai-teaching/constraintsParse.ts', 'constraintsParse')
const { parseConstraintItems, serializeConstraintItems, applyConstraintEdits } = C
const DOC = '# 本知识点 · 要求\n\n这个知识点我只要够用在考试上。\n\n- 先给结论与适用条件\n- 代码示例一律 C++\n\n> 备注：不要软停用（D1）\n'
const items0 = parseConstraintItems(DOC)
check('parseConstraintItems：只取 `- ` 条目，按原文顺序', items0.length === 2 && items0[0].text === '先给结论与适用条件' && items0[1].text === '代码示例一律 C++', JSON.stringify(items0))
check('条目带原文行号（供就地编辑）', items0[0].line === 4 && items0[1].line === 5, JSON.stringify(items0.map((i) => i.line)))
const added = applyConstraintEdits(DOC, [{ op: 'add', text: '每节留一道自测题' }])
check('add：插在最后一条条目之后', parseConstraintItems(added).length === 3 && parseConstraintItems(added)[2].text === '每节留一道自测题', JSON.stringify(parseConstraintItems(added)))
check('add：非条目行逐字保留（标题 / 说明段 / 引用块）', added.includes('这个知识点我只要够用在考试上。') && added.includes('> 备注：不要软停用（D1）') && added.startsWith('# 本知识点 · 要求\n'), added)
const updated = applyConstraintEdits(DOC, [{ op: 'update', index: 1, text: '代码示例改 Python' }])
check('update：只替换那一条', parseConstraintItems(updated)[1].text === '代码示例改 Python' && parseConstraintItems(updated)[0].text === '先给结论与适用条件', JSON.stringify(parseConstraintItems(updated)))
check('update：说明段仍在原地', updated.indexOf('这个知识点我只要够用在考试上。') < updated.indexOf('代码示例改 Python'), '')
const removed = applyConstraintEdits(DOC, [{ op: 'remove', index: 0 }])
check('remove：删掉那一条、另一条不动', parseConstraintItems(removed).length === 1 && parseConstraintItems(removed)[0].text === '代码示例一律 C++', JSON.stringify(parseConstraintItems(removed)))
check('remove：文末换行与尾部引用块不受影响', removed.trimEnd().endsWith('> 备注：不要软停用（D1）'), JSON.stringify(removed.slice(-40)))
check('越界 index 不抛错、不改文本', applyConstraintEdits(DOC, [{ op: 'remove', index: 9 }]) === DOC, '')
check('空文本加一条 → 只有那一条', parseConstraintItems(applyConstraintEdits('', [{ op: 'add', text: 'x' }])).length === 1, '')
check('serializeConstraintItems：每行一条 `- `', serializeConstraintItems(['a', 'b']) === '- a\n- b\n', JSON.stringify(serializeConstraintItems(['a', 'b'])))
check('serializeConstraintItems：空输入 → 空串（不写空列表头）', serializeConstraintItems([]) === '' && serializeConstraintItems(['  ']) === '', '')
check('CRLF 输入不崩且往返稳定', applyConstraintEdits('# t\r\n\r\n- a\r\n- b\r\n', [{ op: 'add', text: 'c' }]).includes('- c'), '')

// ---------------------------------------------------------------- B. 接线静态断言
console.log('\n=== 11. 组件与接线 ===')
const canvasPath = 'src/modules/ai-teaching/flow/FlowCanvas.tsx'
check('FlowCanvas 组件存在', fs.existsSync(path.join(ROOT, canvasPath)), '')
const canvas = stripComments(read(canvasPath))
check('画布用 Pointer Events（HTML5 拖放会静默失败）', canvas.includes('onPointerDown') && canvas.includes("addEventListener('pointermove'"), '')
check('画布拖拽期间禁用文本选取', canvas.includes("classList.add('dragging')"), '')
check('画布 import 了 flowLayout', /from '\.\/flowLayout'/.test(read(canvasPath)), '')
check('折行列数由画布宽度反算', canvas.includes('colsForWidth(canvasSize.w)'), '')
check('布局走 layoutLanes（不再有 arrangePositions / 自由坐标）', canvas.includes('layoutLanes(') && !canvas.includes('arrangePositions'), '')
check('只展开当前章：折叠集合 = 除 activeChapterId 以外全部', /closedIds[\s\S]{0,300}?c\.id !== activeChapterId/.test(canvas), '')
check('点折叠条 = 展开并成为当前章（onFocusChapter）', canvas.includes('onFocusChapter') && canvas.includes('focusChapter'), '')
check('卡片独立图层按世界坐标渲染（不嵌在章框里 → 无双重偏移）', /liveChapters\.map\(\(shape\)/.test(canvas) && canvas.includes('transform: `translate(${u.x}px,${u.y}px)`'), '')
check('卡片两级信息（要求 / 素材 / 产物 + 课时 / 最近）', canvas.includes('data-cardmeta') && canvas.includes('data-cardmeta2') && canvas.includes('要求 {cnt?.req ?? 0}'), '')
check('卡片主行动按钮（开始学 / 继续学 / 复习）', canvas.includes('data-cardact') && /st === 'learning' \? '继续学'/.test(canvas), '')
check('状态浅底 + 状态色边（不再恒为白卡）', canvas.includes('color-mix(in srgb, ${color} 11%, var(--card-bg))') && canvas.includes('color-mix(in srgb, ${color} 34%, transparent)'), '')
check('章框头进度条', canvas.includes('data-chprog'), '')
check('章间主干渲染（spineEdges + spinePath）', canvas.includes('spineEdges(base.frames)') && canvas.includes('spinePath('), '')
check('已走过链段着色（mastered / learning → 实线 + accent）', /st === 'mastered' \|\| st === 'learning'/.test(canvas) && canvas.includes('kb-flow-arw-on'), '')
check('顶部四段分段条 + 大数字', canvas.includes('kb-flow-segbar') && canvas.includes('data-stats') && canvas.includes('data-legend'), '')
check('缩略图掌握度热力（透明度随 mastery）', canvas.includes('0.25 + mastery * 0.7'), '')
check('拖拽默认锁住 + 编辑布局态在组件 state（不落盘）', canvas.includes('const [editMode, setEditMode] = useState(false)') && /if \(!editMode\) \{ showLockBubble/.test(canvas), '')
check('锁定态点卡片给行内提示（不是「点了没反应」）', canvas.includes('data-lockbubble') && canvas.includes('进「编辑布局」再拖'), '')
check('插入位指示条（世界坐标元素 + pointer-events:none）', canvas.includes('data-dropbar') && canvas.includes('kb-flow-dropbar') && canvas.includes('dropBarRect('), '')
check('拖拽跟手：连线 / 缩略图读实时坐标', canvas.includes('applyDragToChapters(') && canvas.includes('liveChapters') && canvas.includes('posById[e.fromId]'), '')
check('落点判定用已提交几何（resolveDropIndex 拿到的是 base.chapters）', /resolveDropIndex\(\{[\s\S]{0,120}?chapters: base\.chapters/.test(canvas), '')
check('松手只改顺序：顺序未变不写盘', canvas.includes('if (!res || !res.changed) return'), '')
check('松手后的乐观顺序在 outline 换新后自动作废', /pending\.from === outline/.test(canvas) && canvas.includes('setPending(null)'), '')
check('手势补发 click 的 dragGuard 仍在（250ms）', /guardRef\.current = Date\.now\(\) \+ 250/.test(canvas) && canvas.includes('Date.now() < guardRef.current'), '')
check('选层不动视线的情形不挪画布（reveal 只在不可见时居中）', /const reveal[\s\S]{0,400}?if \(r\.x >= left && r\.y >= top && r\.x \+ r\.w <= right && r\.y \+ r\.h <= bottom\) return/.test(canvas), '')
check('数据刷新不重置视线（fit 只由 尺寸 / layoutKey 触发）', /useEffect\(\(\) => \{\s*if \(!canvasSize\.w \|\| !canvasSize\.h\) return\s*fitRef\.current\(\)\s*\}, \[canvasSize\.w, canvasSize\.h, layoutKey\]\)/.test(canvas), '')
check('Esc / 0 / ± 快捷键已补（v1 漏了）', canvas.includes("e.key === 'Escape'") && canvas.includes("e.key === '0'") && canvas.includes("e.key === '+'"), '')
check('位置持久化退役（无 localStorage 坐标、无「整理」按钮）', !canvas.includes('aiteach.flow.layout') && !canvas.includes('整理') && !canvas.includes('LayoutGrid'), '')
check('注记按 8px 内缩 / 10.5px 字号渲染（与 ZONE_FOOT 口径绑定）', /left-3 bottom-2 text-\[10\.5px\]/.test(canvas), '')
check('注记可被脚本定位（data-zonefoot）', canvas.includes('data-zonefoot'), '')
check('空章不渲染注记（占位框只有标题条，塞进去会压字）', /isActive && c\.units\.length > 0 && \(/.test(canvas), '')
check('画布不再画「全局 / 工作区」外框（data-outer / kb-flow-outer / outerRect 全退场）', !canvas.includes('data-outer') && !canvas.includes('kb-flow-outer') && !canvas.includes('outerRect'))
check('工作区层入口仍在画布顶栏（本工作区要求 → onOpenScopeDoc）', /onOpenScopeDoc\(\{ level: 'workspace' \}\)/.test(canvas) && canvas.includes('本工作区要求'))
check('选层口径 = selScope / onSelectScope', canvas.includes('selScope') && canvas.includes('onSelectScope'), '')
check('卡片点击 stopPropagation（不冒泡到章框覆盖选中）', /onClick=\{\(e\) => \{ e\.stopPropagation\(\); if \(Date\.now\(\) < guardRef\.current\) return; selectScope/.test(canvas), '')
check('章框头按钮 stopPropagation（复习课不误选章）', /e\.stopPropagation\(\); onOpenChapterReview/.test(canvas), '')

const course = stripComments(read('src/modules/ai-teaching/CourseMode.tsx'))
check('CourseMode 导入并渲染 FlowCanvas', course.includes("from './flow/FlowCanvas'") && course.includes('<FlowCanvas'), '')
check('CourseMode 接线 onMoveUnit → aiTeachCourseMoveUnit（返回 boolean 供乐观值回滚）', course.includes('aiTeachCourseMoveUnit(') && course.includes('return true'), '')
check('CourseMode 传 activeChapterId / onFocusChapter', course.includes('activeChapterId') && course.includes('onFocusChapter'), '')
check('「继续学」目标由 pickNextUnit 派生（接着上次那节课）', course.includes('pickNextUnit(') && course.includes('aiTeach.lastLesson.'), '')
check('CourseMode 不再自己实现收尾自测弹窗（弹窗收口到 index.tsx）', !course.includes('aiTeachCourseMakeUnitQuiz'), '')

const mod = stripComments(read('src/modules/ai-teaching/index.tsx'))
check('中栏 chip 保留「学习流」', mod.includes('学习流'), '')
check('右栏新增「层级」分区（railTab 三态）', /useState<'lanes' \| 'sources' \| 'scope'>/.test(mod) && mod.includes('<Layers size={11} />层级'), '')
check('右栏渲染 ScopeDetail', mod.includes('ScopeDetail') && mod.includes('<ScopeDetail'), '')
check('画布选层切换右栏到层级面（用户手动切走不抢回）', mod.includes('selectFlowScope') && /cur === 'scope' \? cur : 'scope'/.test(mod), '')
check('左栏知识点行可点（开课 + 画布选中 + 该章设为当前章）', mod.includes('focusFlowChapter(ch.chapterId)') && mod.includes('selectFlowScope({ level: \'unit\'') && mod.includes('void courseOpenUnit(u.unitId)'), '')
check('当前章记忆 key = aiTeach.flow.chapter.<wsId>', mod.includes('aiTeach.flow.chapter.'), '')
check('「编辑这一层」三层都真打开（章层明说本层不做）', mod.includes('aiTeachScopeEnsure(') && mod.includes('章层本层的要求不做'), '')
check('分层计数喂给画布（scopeCounts）', mod.includes('aiTeachScopeCounts(') && mod.includes('scopeCounts={scopeCounts}'), '')
check('收尾自测弹窗在 index.tsx 只挂一份', mod.includes('<UnitQuizModal') && mod.includes('setFinishQuiz'), '')

const scopeDetail = stripComments(read('src/modules/ai-teaching/ScopeDetail.tsx'))
check('ScopeDetail 三页签（推进 / 要求 / 素材）', scopeDetail.includes("'drive'") && scopeDetail.includes("'req'") && scopeDetail.includes("'src'"), '')
check('ScopeDetail 掌握度只读（不调 setUnitProgress 写 mastery）', scopeDetail.includes('掌握度 · 只读') && !/aiTeachCourseSetUnitProgress\([^)]*mastery/.test(scopeDetail), '')
check('ScopeDetail 删除知识点走行内确认（铁律 25，不是中央模态）', scopeDetail.includes('pendingDel') && !scopeDetail.includes('globalConfirm'), '')
check('ScopeDetail 要求用 constraintsParse 做行级编辑', scopeDetail.includes('parseConstraintItems(') && scopeDetail.includes('applyConstraintEdits(') && scopeDetail.includes('aiTeachScopeWriteText('), '')
check('ScopeDetail 素材分层（本层 + 继承工作区主库）', scopeDetail.includes('aiTeachSourcesReadScoped(') && scopeDetail.includes('继承 · 工作区主库'), '')
check('ScopeDetail 章层显示「本层未启用」而不是假按钮', scopeDetail.includes('本层未启用'), '')

const css = read('src/styles/index.css')
check('CSS 有拖拽跟手 / 落点 / 折叠条 / 插入位 / 锁提示样式',
  ['.kb-flow-node.kb-dragging', '.kb-flow-zone.kb-drop', '.kb-flow-zone.kb-closed', '.kb-flow-dropbar', '.kb-flow-lockhint', '.kb-flow-segbar'].every((c) => css.includes(c)), '')
check('动效走既有令牌（无 transition-all）', !/\.kb-flow[^}]*transition-all/.test(css), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
