// 契约验证：看板磁贴栅格（2026-09-28，docs/dashboard-tile-grid-design.md）
//
// 切片真实实现 tileGrid.ts（零依赖纯函数）跑行为断言；其余用源码探针钉住
// 拖拽引擎的「不可能卡死」约束（window 级收尾 / 单一收尾口 / settling / 清扫）。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/dashboard/verify-dashboard-tile-grid.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../shared/strip-comments.mjs'

import {
  parseLayout, normalizeLayout, swapIds, insertId, withSize, clampWH,
  GRID_COLS, MIN_W, MAX_W, MIN_H, MAX_H,
} from '../../../src/modules/dashboard/tileGrid.ts'
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf-8')

const checks = []
function ok(name, pass, detail) { checks.push({ name, pass: !!pass, detail: detail ?? '' }) }
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, a === e ? '' : `实际 ${a} ≠ 期望 ${e}`)
}

/* ================= A. clampWH 边界 ================= */

eq('A1 低夹到 2×1', clampWH(1, 0), { w: 2, h: 1 })
eq('A2 高夹到 6×4', clampWH(9, 9), { w: 6, h: 4 })
eq('A3 NaN 回退最小档', clampWH(NaN, NaN), { w: 2, h: 1 })
eq('A4 小数四舍五入', clampWH(3.4, 2.6), { w: 3, h: 3 })
ok('A5 档位常量自洽', GRID_COLS === 6 && MIN_W === 2 && MAX_W === 6 && MIN_H === 1 && MAX_H === 4)

/* ================= B. parseLayout ================= */

eq('B1 坏 JSON → 空', parseLayout('{oops'), [])
eq('B2 非数组 → 空', parseLayout('"x"'), [])
eq('B3 正常解析 + 夹取', parseLayout('[{"id":"a","w":9,"h":0},{"id":"b"}]'), [
  { id: 'a', w: 6, h: 1 },
  { id: 'b', w: 2, h: 2 },
])
eq('B4 重复 id 去重（保留首个）', parseLayout('[{"id":"a","w":3,"h":1},{"id":"a","w":6,"h":4}]'), [{ id: 'a', w: 3, h: 1 }])
eq('B5 坏项丢弃', parseLayout('[null,1,{"w":2},{"id":"a","w":2,"h":2}]'), [{ id: 'a', w: 2, h: 2 }])

/* ================= C. normalizeLayout ================= */

const KNOWN = [
  { id: 'a', w: 2, h: 2 },
  { id: 'b', w: 2, h: 1 },
  { id: 'c', w: 6, h: 1 },
]
eq('C1 空布局 → 注册表序全量补齐', normalizeLayout([], KNOWN), KNOWN)
eq('C2 缺 b → 按来源序追加到尾部', normalizeLayout([{ id: 'c', w: 6, h: 1 }, { id: 'a', w: 2, h: 2 }], KNOWN), [
  { id: 'c', w: 6, h: 1 },
  { id: 'a', w: 2, h: 2 },
  { id: 'b', w: 2, h: 1 },
])
eq('C3 未知 id 丢弃；缺失的 b/c 按来源序补齐', normalizeLayout([{ id: 'zz', w: 2, h: 2 }, { id: 'a', w: 2, h: 2 }], KNOWN), [
  { id: 'a', w: 2, h: 2 },
  { id: 'b', w: 2, h: 1 },
  { id: 'c', w: 6, h: 1 },
])
ok('C4 幂等（同输入反复归一结果不变）',
  JSON.stringify(normalizeLayout(normalizeLayout([], KNOWN), KNOWN)) === JSON.stringify(normalizeLayout([], KNOWN)))

/* ================= D. swapIds / insertId / withSize ================= */

const L = [{ id: 'a', w: 2, h: 2 }, { id: 'b', w: 2, h: 1 }, { id: 'c', w: 2, h: 2 }]
eq('D1 对调', swapIds(L, 'a', 'c').map((t) => t.id), ['c', 'b', 'a'])
ok('D2 对调不改入参（纯函数）', JSON.stringify(L) === '[{"id":"a","w":2,"h":2},{"id":"b","w":2,"h":1},{"id":"c","w":2,"h":2}]')
eq('D3 对调含未知 id → 原样', swapIds(L, 'a', 'zz').map((t) => t.id), ['a', 'b', 'c'])
eq('D4 对调自身 → 原样', swapIds(L, 'a', 'a').map((t) => t.id), ['a', 'b', 'c'])
eq('D5 插前', insertId(L, 'c', 'a', false).map((t) => t.id), ['c', 'a', 'b'])
eq('D6 插后', insertId(L, 'c', 'a', true).map((t) => t.id), ['a', 'c', 'b'])
eq('D7 插入含未知目标 → 原样', insertId(L, 'c', 'zz', true).map((t) => t.id), ['a', 'b', 'c'])
eq('D8 改尺寸 + 夹取', withSize(L, 'b', 99, 0), [{ id: 'a', w: 2, h: 2 }, { id: 'b', w: 6, h: 1 }, { id: 'c', w: 2, h: 2 }])

/* ================= E. 拖拽引擎约束（源码探针，index.tsx） ================= */

{
  const index = stripComments(read('src/modules/dashboard/index.tsx'))
  const settings = stripComments(read('src/lib/settings.ts'))

  ok('E1 收尾事件全挂 window（up / pointercancel / blur —— 嵌入环境捕获会丢）',
    /addEventListener\('pointerup'/.test(index) && /addEventListener\('pointercancel'/.test(index) && /addEventListener\('blur'/.test(index))
  ok('E2 收尾只有一个口（finishRef）', /const finishRef = useRef\(onGlobalPointerFinish\)/.test(index))
  ok('E3 FLIP 落位期间禁止开新拖拽（settling）', /settling\.current = true/.test(index) && /settling\.current\) return/.test(index))
  ok('E4 拖拽起点前防御性清扫（sweepTileInline）', /sweepTileInline\(gridEl\)/.test(index) && /if \(!editing\) sweepTileInline\(gridRef\.current\)/.test(index))
  ok('E5 命中检测走布局快照（不用 elementFromPoint）', /snapshotTiles\(/.test(index) && !/elementFromPoint/.test(index))
  ok('E6 换位提交走 flushSync（DOM 先重排才量得到 FLIP 终态）', /flushSync\(\(\) => setLayout\(next\)\)/.test(index))
  ok('E7 让位预览只改 transform 不重排 DOM（dense 回填坑）', /from\.left - to\.left\}px, \$\{from\.top - to\.top\}px/.test(index))
  ok('E8 栅格：dense 流 + 固定行高 76px + 6 列', /gridAutoFlow: 'row dense'/.test(index) && /gridAutoRows: `\$\{ROW_H\}px`/.test(index) && /const ROW_H = 76/.test(index))
  ok('E9 拖拽元素无入场动画（fill 压 transform 教训）：wrapper 不挂 item-in 类', !/data-id=\{it\.id\}[^}]*kb-item-in/.test(index))
  ok('E10 拉角改尺寸吸附（2-6 × 1-4 走 withSize 落库）', /Math\.max\(2, Math\.min\(GRID_COLS,/.test(index) && /applyLayout\(withSize\(layoutRef\.current, rd\.id, rd\.w, rd\.h\)\)/.test(index))
  ok('E11 编辑态全卡遮罩（卡内交互停用防误触；iframe 同理；×/⌟ 在 z-20 更高层不受影响）', /\{editing && <div className="absolute inset-0 z-10" \/>\}/.test(index) && /data-no-drag[\s\S]{0,120}title=\{`隐藏/.test(index))
  ok('E12 显隐与布局分键存储（dashboardCards 语义不变 + 新增 dashboardTileLayout）',
    /dashboardTileLayout: \{ default: '\[\]'/.test(settings) && /update\('dashboardTileLayout', JSON\.stringify\(next\)\)/.test(index) && /update\('dashboardCards', JSON\.stringify\(ordered\)\)/.test(index))
  ok('E13 布局归一化保留存量未知 id（停用插件槽位不丢）', /for \(const p of parseLayout\(s\.dashboardTileLayout\)\)/.test(index))
  ok('E14 旧弹层已拔线（popOpen / SlidersHorizontal 不复存在）', !/popOpen/.test(index) && !/SlidersHorizontal/.test(index))
  // React #310 第四犯（2026-09-28 点击看板即崩）：早退 return 落在 useRef/useEffect 之前。
  // 源码序断言：早退标记必须晚于全部 hook 调用（module 级无 hook，lastIndexOf 即组件内最后一个）。
  {
    const earlyIdx = index.indexOf('正在载入看板') // 早退 return 的 JSX 文本（代码，不随剥注释消失）
    const lastHook = Math.max(
      index.lastIndexOf('useState('), index.lastIndexOf('useEffect('), index.lastIndexOf('useMemo('),
      index.lastIndexOf('useRef('), index.lastIndexOf('useCallback('), index.lastIndexOf('useContext('),
    )
    ok('E15 早退 return 在全部 hook 之后（React #310 四防）', earlyIdx > 0 && earlyIdx > lastHook)
  }
}

/* ================= 结果 ================= */

const fails = checks.filter((c) => !c.pass)
const pass = checks.length - fails.length
console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log(`   FAIL  ${f.name}${f.detail ? `\n         ${f.detail}` : ''}`)
}
console.log('========================================\n')
process.exit(fails.length === 0 ? 0 : 1)
