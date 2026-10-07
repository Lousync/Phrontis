#!/usr/bin/env node
/**
 * 桌面磁贴「拖拽换位 + 让位 + 落位」契约（2026-09-15 反馈第 ② 条）—— 静态断言 + 切片真跑。
 *
 * 为什么必须真跑：这一项的高危回归全是**静默失败**，光读代码看不出来 ——
 *   · 让位位移累加：每次 move 都基于「已被平移过的 rect」算偏移 → 越拖越飘
 *   · 命中判定把**拖动块自己**判成目标 → pointerup 时 swapTiles(id, id) 原样返回 = 白拖
 *   · 落位 FLIP 起点算错（拿 originRect 而不是「松手时的视觉位置」）→ 松手先瞬移回原位再滑
 *   · 落位 FLIP 少一步强制回流 → 松手瞬间硬跳
 * 所以这里把组件里那几段**真实实现**切出来，配极简 DOM 替身在沙箱里跑真实路径
 * （做法与 .AGENT/scripts/ai-tools-audit/verify-tool-result-cap.mjs 一致）。
 *
 * ⚠️ 负向断言必须先剥注释：修复代码旁的说明注释**本身就在引用**旧写法
 * （如「不能用 elementFromPoint」），不剥注释会假失败。
 *
 * 用法：node .AGENT/scripts/desktop/verify-drag-reorder.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SRC = path.join(ROOT, 'src/modules/desktop/index.tsx')
const LAYOUT_SRC = path.join(ROOT, 'src/modules/desktop/layout.ts')
const CSS_SRC = path.join(ROOT, 'src/styles/index.css')
const raw = fs.readFileSync(SRC, 'utf8')
const css = fs.readFileSync(CSS_SRC, 'utf8')

/** 剥注释（状态机版，感知字符串/模板串字面量；不感知正则字面量，本文件够用） */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && c2 === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += c; i++
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c; i++
  }
  return out
}
const code = stripComments(raw)
const cssCode = stripComments(css)

/* ==================== 一、静态断言 ==================== */
const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const seg = (from, to) => {
  const a = code.indexOf(from)
  if (a < 0) return null
  const b = code.indexOf(to, a)
  return code.slice(a, b < 0 ? code.length : b)
}
const moveBody = seg('const onTilePointerMove', 'const onTilePointerUp')
const upBody = seg('const onTilePointerUp', 'const onSizePointerDown')
const newBtn = seg('const onNewPage', 'const [editing, setEditing]')

check('能切出 onTilePointerMove / onTilePointerUp / onNewPage', !!moveBody && !!upBody && !!newBtn)
check('命中判定不再用 elementFromPoint（拖动块抬了 z-index，只会命中它自己）',
  !/elementFromPoint/.test(code))
check('不再有 is-over 类与 overId state（让位取代了「给目标描一圈」）',
  !/\bis-over\b/.test(code) && !/setOverId/.test(code))

const dragCss = /\.is-dragging\s*\{[^}]*\}/.exec(cssCode)?.[0] ?? ''
check('CSS：[.is-dragging] 用「抬层级 + 大投影 + 实线描边」表达拿起，不靠降透明度',
  /z-index:\s*30/.test(dragCss) && /box-shadow/.test(dragCss) && !/opacity/.test(dragCss),
  dragCss.slice(0, 120))
check('CSS：is-over 规则已移除', !/\.is-over\b/.test(cssCode))

check('move：抬起时先取 originRect 再取命中快照，且快照在写 transform 之前（否则矩形已被位移污染）',
  (moveBody || '').indexOf('d.originRect = d.el.getBoundingClientRect()') >= 0 &&
  (moveBody || '').indexOf('captureHitSnapshot(') > (moveBody || '').indexOf('d.originRect =') &&
  (moveBody || '').indexOf('captureHitSnapshot(') < (moveBody || '').indexOf('d.el.style.transform ='))
check('move：抬起当帧就关掉过渡（.is-dragging 的 transition 要等 React 渲染才生效，来不及）',
  /d\.el\.style\.transition = 'none'/.test(moveBody || ''))
check('move：命中走 hitTest（快照）+ previewShift（让位），不再每帧 setState',
  /hitTest\(e\.clientX, e\.clientY\)/.test(moveBody || '') &&
  /previewShift\(hit\?\.el \?\? null, d\.originRect\)/.test(moveBody || ''))
check('move：记下当前位移 tx/ty（落位 FLIP 的起点要用它）',
  /d\.tx = dx/.test(moveBody || '') && /d\.ty = dy/.test(moveBody || ''))

check('previewShift：测量前先把 transition 置 none（有过渡时 rect 读到的还是过渡起点）',
  /target\.style\.transition = 'none'[\s\S]{0,120}getBoundingClientRect\(\)/.test(code))
check('previewShift：切目标时先还原上一个（否则旧目标永远停在错位）',
  /if \(prev\) \{ prev\.style\.transition = shiftEase\(170\); prev\.style\.transform = '' \}/.test(code))

check('up：用 flushSync 落数据（下面量的必须是重排后的终态位置）',
  /flushSync\(\(\) => \{ patchPreset/.test(upBody || ''))
check('up：换位仍走 swapTiles（数据模型没变）', /swapTiles\(p\.tiles, d\.id, target\)/.test(upBody || ''))
check('up：FLIP 起点含当前位移（只拿 originRect 会让磁贴先瞬移回原位再滑）',
  /origin\.left \+ d\.tx - after\.left/.test(upBody || '') && /origin\.top \+ d\.ty - after\.top/.test(upBody || ''))
check('up：落位 FLIP = 强制回流 + 收尾 transform',
  /void el\.offsetHeight/.test(upBody || '') && /translate\(0px, 0px\) scale\(1\)/.test(upBody || ''))
check('up：只有真拖过才动数据（单击不触发换位）',
  /if \(!d\.moved\) \{ el\.style\.transform = ''; return \}/.test(upBody || ''))
check('up：换过位时让位目标**瞬时**还原（它的新格位已在视觉位上，带过渡反而错位滑回）',
  /preview\.style\.transition = swapped \? 'none' : shiftEase\(170\)/.test(upBody || ''))

check('新建按钮改为走编辑器（复用 kb-open-note + kb-editor-new-page）',
  !!newBtn && /kb-open-note/.test(newBtn) && /kb-editor-new-page/.test(newBtn))
check('新建按钮：切换 Tab 与触发命名行之间留了挂载余量（180ms，与知识库 Ctrl+N 同值）',
  /setTimeout\(\(\) => window\.dispatchEvent\(new CustomEvent\('kb-editor-new-page'\)\), 180\)/.test(newBtn || ''))
check("新建按钮的 onClick 已从 onOpenModule('knowledge') 换成 onNewPage",
  /<button className="desk-newbtn" onClick=\{onNewPage\}/.test(code) &&
  !/onClick=\{\(\) => onOpenModule\('knowledge'\)\}/.test(code))

/* ==================== 二、切片真跑 ==================== */
const sliceFrom = raw.indexOf('  /** 抬起倍数')
const sliceTo = raw.indexOf('  const onSizePointerDown')
if (sliceFrom < 0 || sliceTo < 0) throw new Error('切片定位失败：LIFT_SCALE / onSizePointerDown 没找到')
const slice = raw.slice(sliceFrom, sliceTo)

/** 极简 DOM 替身：只实现这套逻辑用到的部分。
 *  两处刻意保真：(1) style.transform 赋值在「有过渡」时 applied 不变
 *  —— 这正是真机「设完 transform 立刻量 rect 拿到过渡起点」的成因；
 *  (2) patchPreset 触发一次简化版 dense 布局重排 —— 真机的换位是 React 重排 DOM 后位置真的变了。 */
const STUB = `
const COLS = 6, CELL = 100, GAP = 10, PITCH = CELL + GAP
function __trans(t) {
  if (!t) return { x: 0, y: 0 }
  const m = /translate\\((-?[0-9.]+)px,\\s*(-?[0-9.]+)px\\)/.exec(String(t))
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 }
}
class FakeEl {
  constructor(id, spanW, spanH) {
    this.dataset = { deskId: id }
    this.spanW = spanW
    this.spanH = spanH
    this.base = { left: 0, top: 0, w: spanW * PITCH - GAP, h: spanH * PITCH - GAP }
    this.applied = { x: 0, y: 0 }
    this.offsetHeight = 1
    this.log = []
    this.__classes = new Set()
    this.__transition = ''
    this.__transform = ''
    const self = this
    this.classList = {
      add: (c) => { self.__classes.add(c) },
      remove: (c) => { self.__classes.delete(c) },
      contains: (c) => self.__classes.has(c),
    }
    /** pointerdown 里用 closest 排除尺寸手柄 / 删除钮：夹具里没有这两样，恒 null */
    this.closest = () => null
    this.style = {}
    Object.defineProperty(this.style, 'transition', {
      get: () => self.__transition,
      set: (v) => { self.__transition = v },
    })
    Object.defineProperty(this.style, 'transform', {
      get: () => self.__transform,
      set: (v) => {
        self.__transform = v
        self.log.push(v)
        if (self.__transition === 'none') self.applied = __trans(v)
      },
    })
  }
  getBoundingClientRect() {
    return {
      left: this.base.left + this.applied.x,
      top: this.base.top + this.applied.y,
      width: this.base.w, height: this.base.h,
      right: this.base.left + this.applied.x + this.base.w,
      bottom: this.base.top + this.applied.y + this.base.h,
    }
  }
}
const __grid = {
  base: { left: 0, top: 0 },
  children: [],
  getBoundingClientRect() { return { left: this.base.left, top: this.base.top } },
}
/** grid-auto-flow: row dense 的简化版：按 DOM 顺序逐块找**行优先**的第一个空位 */
function __layout() {
  const occ = []
  for (const el of __grid.children) {
    let spot = null
    for (let r = 0; !spot && r < 50; r++) {
      for (let c = 0; c + el.spanW <= COLS; c++) {
        let free = true
        for (let dr = 0; dr < el.spanH && free; dr++) {
          for (let dc = 0; dc < el.spanW && free; dc++) {
            if (occ.some((o) => o[0] === c + dc && o[1] === r + dr)) free = false
          }
        }
        if (free) { spot = { c: c, r: r }; break }
      }
    }
    if (!spot) spot = { c: 0, r: 0 }
    for (let dr = 0; dr < el.spanH; dr++) {
      for (let dc = 0; dc < el.spanW; dc++) occ.push([spot.c + dc, spot.r + dr])
    }
    el.base.left = spot.c * PITCH
    el.base.top = spot.r * PITCH
  }
}
function __build() {
  __grid.children = [new FakeEl('A', 2, 2), new FakeEl('B', 2, 2), new FakeEl('C', 2, 2), new FakeEl('D', 2, 1), new FakeEl('E', 2, 1)]
  gridRef.current = __grid
  __layout()
  return __grid.children
}
let reduceMotion = false
let editing = true
const gridRef = { current: null }
const hitSnapRef = { current: [] }
const previewElRef = { current: null }
const overIdRef = { current: null }
const dragRef = { current: null }
const __calls = { dragging: [], swap: [], patch: [] }
const setDraggingId = (v) => { __calls.dragging.push(v) }
const flushSync = (fn) => { fn() }
/** 记录调用参数的探针，内部仍走 layout.ts 的真实 swapTiles（下面 __realSwapTiles） */
function swapTiles(tiles, a, b) {
  __calls.swap.push([a, b])
  return __realSwapTiles(tiles, a, b)
}
const patchPreset = (fn) => {
  __calls.patch.push(fn)
  const next = fn({ id: 'p', tiles: __grid.children.map((c) => ({ id: c.dataset.deskId })) })
  const byId = new Map(__grid.children.map((c) => [c.dataset.deskId, c]))
  __grid.children = next.tiles.map((t) => byId.get(t.id)).filter(Boolean)
  __layout()
}
const window = { matchMedia: () => ({ matches: reduceMotion }), setTimeout: () => 0 }
function __setReduceMotion(v) { reduceMotion = v }
function __setEditing(v) { editing = v }
`
// 换位的 swapTiles 用 layout.ts 里的**真实实现**（切出来，不复刻）
const layoutRaw = fs.readFileSync(LAYOUT_SRC, 'utf8')
const swFrom = layoutRaw.indexOf('/** 交换两块磁贴的位置')
const swTo = layoutRaw.indexOf('/** 按档轮转尺寸')
if (swFrom < 0 || swTo < 0) throw new Error('layout.ts 里定位 swapTiles 失败')
// 改名成 __realSwapTiles：把 swapTiles 这个名字留给 STUB 里的记录探针，
// 探针内部转调真实实现 —— 断言的是参数，跑的是真代码。
const swapSlice = layoutRaw.slice(swFrom, swTo).replace('function swapTiles(', 'function __realSwapTiles(')

const EXPORTS = `export { LIFT_SCALE, shiftEase, captureHitSnapshot, hitTest, previewShift,
  onTilePointerDown, onTilePointerMove, onTilePointerUp, swapTiles,
  gridRef, hitSnapRef, previewElRef, overIdRef, dragRef, __grid, __build, __calls,
  __trans, __setReduceMotion, __setEditing, FakeEl }`

const js = stripTypeScriptTypes(`${swapSlice}\n${STUB}\n${slice}\n${EXPORTS}`, { mode: 'strip', sourceMap: false })
const mod = await import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`)
const { gridRef, hitSnapRef, previewElRef, overIdRef, dragRef, __grid, __build, __calls } = mod

const near = (a, b) => Math.abs(a - b) < 0.001

// ---- 夹具自检 ----
{
  const el = new mod.FakeEl('T', 2, 2)
  el.style.transition = 'transform 170ms ease'
  el.style.transform = 'translate(30px, 40px)'
  const trapped = el.getBoundingClientRect()
  el.style.transition = 'none'
  el.style.transform = ''
  const freed = el.getBoundingClientRect()
  check('[夹具自检] 有过渡时 rect 读到的是过渡起点（替身能复现真机陷阱）',
    near(trapped.left, 0) && near(trapped.top, 0), `trapped=(${trapped.left},${trapped.top})`)
  check('[夹具自检] 过渡关掉后 rect 立刻反映新值', near(freed.left, 0) && near(freed.top, 0))
  check('[夹具自检] 换位用的 swapTiles 是 layout.ts 真实实现（切出来的，不是复刻）',
    mod.swapTiles([{ id: 'a' }, { id: 'b' }], 'a', 'b').map((t) => t.id).join() === 'b,a')
}

// ---- captureHitSnapshot / hitTest ----
{
  const els = __build()
  const byId = (id) => els.find((e) => e.dataset.deskId === id)
  check('[夹具] dense 布局把 A/B/C 排在首行、D/E 在第二行',
    byId('A').base.left === 0 && byId('B').base.left === 220 && byId('C').base.left === 440 &&
    byId('D').base.top === 220 && byId('D').base.left === 0 && byId('E').base.left === 220,
    JSON.stringify(els.map((e) => [e.dataset.deskId, e.base.left, e.base.top])))

  mod.captureHitSnapshot(__grid, 'A')
  check('快照跳过被拖动的那块本身',
    hitSnapRef.current.length === 4 && !hitSnapRef.current.some((s) => s.id === 'A'))
  const hitB = mod.hitTest(325, 105)
  check('hitTest 命中指针下的那块', hitB?.id === 'B', `got=${hitB?.id}`)
  check('hitTest 在拖动块自己的原位不命中任何块（不会 swapTiles(A,A) 白拖）',
    mod.hitTest(55, 55) === null)
  check('hitTest 命中块的边角区（不是只有中心才算）', mod.hitTest(445, 5)?.id === 'C')
  check('hitTest 在栅格外的空白处返回 null', mod.hitTest(-50, -50) === null)
}

// ---- previewShift：让位位移、幂等、不累加 ----
{
  const els = __build()
  const byId = (id) => els.find((e) => e.dataset.deskId === id)
  const A = byId('A'), B = byId('B'), C = byId('C')
  const origin = A.getBoundingClientRect()

  mod.previewShift(B, origin)
  check('让位：目标被平移到「被拖块腾出的格子」',
    near(mod.__trans(B.style.transform).x, origin.left - B.base.left) && B.style.transform === 'translate(-220px, 0px)',
    B.style.transform)
  check('让位：previewElRef 记下当前目标', previewElRef.current === B)

  const t1 = B.style.transform
  mod.previewShift(B, origin)
  check('让位幂等：同一目标再调一次不重写', B.style.transform === t1)

  mod.previewShift(C, origin)
  check('让位切目标：旧目标被还原（不留错位）', B.style.transform === '')
  check('让位切目标：新目标按**基座**算偏移（不是叠在旧偏移上）',
    B.style.transform === '' && C.style.transform === 'translate(-440px, 0px)', C.style.transform)

  mod.previewShift(B, origin)
  check('让位回切：位移仍以基座为准（连续切换不漂）',
    B.style.transform === 'translate(-220px, 0px)', B.style.transform)

  mod.previewShift(null, origin)
  check('让位清空：目标被还原、ref 置空', B.style.transform === '' && previewElRef.current === null)
}

// ---- onTilePointerMove / onTilePointerUp：跑真实事件路径 ----
{
  const els = __build()
  const A = els.find((e) => e.dataset.deskId === 'A')
  const B = els.find((e) => e.dataset.deskId === 'B')
  __calls.dragging.length = 0; __calls.swap.length = 0; __calls.patch.length = 0

  mod.onTilePointerDown({ currentTarget: A, target: A, clientX: 40, clientY: 26, pointerId: 1 }, { id: 'A', w: 2, h: 2 })
  check('pointerdown 登记了拖动块', dragRef.current?.id === 'A')

  mod.onTilePointerMove({ clientX: 46, clientY: 26 })   // 6px，刚过 5px 阈值
  check('抬起：记下拖动块原矩形（未位移）',
    near(dragRef.current.originRect.left, 0) && near(dragRef.current.originRect.top, 0))
  check('抬起：开了抬起态', __calls.dragging.includes('A'))
  check('抬起：当帧就把过渡关掉', A.style.transition === 'none')

  mod.onTilePointerMove({ clientX: 300, clientY: 110 })  // 拖到 B 的中心
  check('拖动中：命中目标写进 overIdRef', overIdRef.current === 'B', `got=${overIdRef.current}`)
  check('拖动中：B 被让位到 A 的格位', B.style.transform === 'translate(-220px, 0px)', B.style.transform)
  check('拖动中：A 跟手位移（含抬起缩放）',
    A.style.transform === 'translate(260px, 84px) scale(1.06)', A.style.transform)

  const aLogBefore = A.log.length
  mod.onTilePointerUp()
  check('松手：走 swapTiles(拖动块, 目标)', JSON.stringify(__calls.swap[0]) === '["A","B"]',
    JSON.stringify(__calls.swap))
  check('松手：通过 patchPreset 落库（settings 是唯一真相源）', __calls.patch.length === 1)
  check('松手：摘掉抬起态类', !A.__classes.has('is-dragging'))
  check('松手：让位目标瞬时还原（不带过渡 —— 它的新格位就是视觉位置）',
    B.style.transform === '' && B.style.transition === 'none')
  check('松手：清空拖动/命中引用（下次拖动不继承）',
    dragRef.current === null && previewElRef.current === null && overIdRef.current === null)

  const aLog = A.log.slice(aLogBefore)
  check('松手：FLIP 起点 = 松手时的视觉位置（originRect + 当前位移 - 新格位）',
    aLog[0] === '' && aLog[1] === 'translate(40px, 84px) scale(1.06)', JSON.stringify(aLog))
  check('松手：FLIP 收尾 = 归零 transform（位移真的归位）',
    aLog[2] === 'translate(0px, 0px) scale(1)', JSON.stringify(aLog))
  check('松手：FLIP 起点处渲染出来仍是松手位置（视觉不回跳）',
    near(A.getBoundingClientRect().left, 260) && near(A.getBoundingClientRect().top, 84),
    `rect=(${A.getBoundingClientRect().left},${A.getBoundingClientRect().top})`)
  check('松手：换位后 A 的格位确实变了（dense 重排真的发生）', near(A.base.left, 220), String(A.base.left))

  const nextPreset = __calls.patch[0]({ tiles: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] })
  check('落库更新器把 A 与 B 换位',
    JSON.stringify(nextPreset.tiles.map((t) => t.id)) === '["B","A","C"]',
    JSON.stringify(nextPreset.tiles.map((t) => t.id)))
}

// ---- 松手落点不在任何块上 → 不换位，只弹回 ----
{
  const els = __build()
  const A = els.find((e) => e.dataset.deskId === 'A')
  __calls.swap.length = 0; __calls.patch.length = 0
  mod.onTilePointerDown({ currentTarget: A, target: A, clientX: 40, clientY: 26, pointerId: 2 }, { id: 'A', w: 2, h: 2 })
  mod.onTilePointerMove({ clientX: 46, clientY: 26 })
  mod.onTilePointerMove({ clientX: -400, clientY: -400 })   // 拖到栅格外
  check('拖到栅格外：命中目标为 null，也不产生让位位移',
    overIdRef.current === null && previewElRef.current === null)
  const before = A.log.length
  mod.onTilePointerUp()
  check('拖到栅格外松手：不换位（不落库）', __calls.swap.length === 0 && __calls.patch.length === 0)
  check('拖到栅格外松手：从落点弹回原位（FLIP 起点 = 当前位移）',
    A.log[before] === '' && A.log[before + 1] === 'translate(-440px, -426px) scale(1.06)',
    JSON.stringify(A.log.slice(before)))
}

// ---- 减少动态效果：时长归零，位移仍然发生 ----
{
  mod.__setReduceMotion(true)
  check('prefers-reduced-motion：让位过渡置 none', mod.shiftEase(170) === 'none')
  mod.__setReduceMotion(false)
  check('常规：让位过渡 170ms',
    mod.shiftEase(170) === 'transform 170ms cubic-bezier(.2, .9, .3, 1)', mod.shiftEase(170))
  check('常规：落位过渡 200ms',
    mod.shiftEase(200) === 'transform 200ms cubic-bezier(.2, .9, .3, 1)', mod.shiftEase(200))
}

/* ==================== 输出 ==================== */
const pass = checks.filter((c) => c.pass).length
const failed = checks.length - pass
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `   ← ${c.detail}`}`)
console.log(`\n断言: ${pass} PASS, ${failed} FAIL`)
process.exitCode = failed === 0 ? 0 : 1
