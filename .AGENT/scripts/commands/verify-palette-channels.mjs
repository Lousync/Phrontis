#!/usr/bin/env node
/**
 * 契约：命令面板的「派发端 ↔ 监听端」通道对账（v3.5.0 L2）。
 *
 * 为什么需要它：真源契约 §2 只保证「palette:true 的命令在 App 绑定表里有一条动作」（双射），
 * 而**那条动作指向的通道有没有监听端**它管不着。本仓真踩过这个坑 —— 派发端还在、监听端已被
 * 顺手删掉（见 docs/ui-updates.md §45.3），表象是「面板里点了没反应」：零报错、零日志，
 * tsc 也拦不住字符串字面量通道（'kb-editor-new-page' 这类两边各写一遍、谁也不引用谁）。
 *
 * 锁三层：
 *   ① 每条通道都有监听端，且用反例证明匹配器不是空转；
 *   ② PDF 适应窗口（pdf-zoom-fit）这条通道的**运行期口径**：只让「当前可见」的阅读器响应
 *      （offsetParent 判定），并与键盘 Ctrl+0 共用同一个 resetFit —— 少了可见判定，
 *      隐藏 Tab 里那个阅读器会被顺手写一条 zoom 进度（resetFit 末尾的 scheduleProgress 会落盘）；
 *   ③ 通道名单不许缩水：新增模块通道时必须同步本文件的 EXPECTED_CHANNELS。
 *
 * ★ 2026-10-13 扩（K-1 / K-2）：可见性这条判据原先只长在命令面板那一半 —— 阅读器自己的键盘
 *   handler（K-1）与 App 侧全局缩放的让位判定（K-2）都没跟上「阅读器多了一个挂载点（笔记编辑器
 *   里的 PDF 附件）」这件事实。§3 现在把三处（面板通道 / 键盘 handler / 全局缩放让位）连同
 *   「探针标记两侧对账」一起锁住，每条都配反例。
 *
 * 跑法（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/commands/verify-palette-channels.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { commandById } from '../../../src/lib/commandRegistry.ts'
import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => stripComments(readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n'))

let failures = 0
const ok = (label, detail) => console.log(`  [OK]   ${label}${detail ? ' —— ' + detail : ''}`)
const bad = (label, detail) => { failures++; console.error(`  [FAIL] ${label}${detail ? ' —— ' + detail : ''}`) }
const check = (label, cond, detail) => (cond ? ok(label, detail) : bad(label, detail))

// ---------------------------------------------------------------- §1 派发端枚举

console.log('\n§1 派发端：App 绑定表里派发出去的跨模块事件')

const APP = read('src/App.tsx')
const segFrom = APP.indexOf('const buildPaletteBindings')
const segTo = APP.indexOf('const buildCommandItems')
const seg = segFrom >= 0 && segTo > segFrom ? APP.slice(segFrom, segTo) : ''

// 事件常量 → 字面值（pdfEvents.ts 是唯一真源；面板侧用了常量名，这里把它解析回字面值）
const EVENTS_SRC = read('src/components/shared/pdf/pdfEvents.ts')
const constToLiteral = new Map([...EVENTS_SRC.matchAll(/export const ([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))

// `new CustomEvent('literal')` 与 `new CustomEvent(KB_CONST)` 两种写法都要认
const dispatched = []
const unresolved = []
for (const m of seg.matchAll(/new CustomEvent\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))/g)) {
  const literal = m[1]
  const ident = m[2]
  if (literal) { dispatched.push({ name: literal, idents: [] }); continue }
  const value = constToLiteral.get(ident)
  if (value) dispatched.push({ name: value, idents: [ident] })
  else unresolved.push(ident)
}
const names = dispatched.map((d) => d.name).sort()
/**
 * ★ 必须把真源自己排除掉：`commandRegistry.ts` 的 `sources` 里**原样引用**监听端那行代码
 *   当锚（`'…PdfReaderView.tsx:1239 @ window.addEventListener(KB_PDF_ZOOM_FIT, onZoomFit)'`），
 *   不排除的话「锚里抄的代码」会被当成监听端 —— 监听端真被删掉时本契约照样绿。
 *   本契约第一版就撞上了：pdf 那条同时命中了 PdfReaderView.tsx 与 commandRegistry.ts。
 */
const srcFiles = walkSourceFiles(resolve(ROOT, 'src'), { skip: (p) => p.includes('commandRegistry.ts') })
const listenersOf = (d) => {
  const pats = [`'${d.name}'`, ...d.idents]
  const hits = []
  for (const f of srcFiles) {
    const body = stripComments(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
    if (pats.some((p) => new RegExp('addEventListener\\(\\s*' + p.replace(/[$]/g, '\\$&')).test(body))) {
      hits.push(f.slice(ROOT.length + 1).replace(/\\/g, '/'))
    }
  }
  return hits
}
check('监听端只算真代码（真源里被引用作锚的代码串不算）',
  !listenersOf({ name: 'kb-pdf-zoom-fit', idents: ['KB_PDF_ZOOM_FIT'] }).some((p) => p.includes('commandRegistry')),
  '真源被排除了')

check(`绑定表切得出来且读到 ≥6 条通道`, seg.length > 0 && dispatched.length >= 6,
  `实际 ${dispatched.length} 条：${names.join(', ')}`)
check('通道名全部解析成功（常量名写错会让下面整段断言空转）', unresolved.length === 0,
  `未解析：${unresolved.join(', ') || '无'}`)

// ★ 名单式断言（不是"至少几条"）：新增/删除通道必须来这里改一行，避免悄悄多出一条没人管的派发
const EXPECTED_CHANNELS = [
  'blog-new-entry',
  'kb-close-active-tab',
  'kb-editor-new-page',
  'kb-pdf-zoom-fit',
  'kb-toggle-immersive',
  'schedule-new-task',
]
check('通道名单与期望集一致（新增通道要同步本文件）', names.join('|') === EXPECTED_CHANNELS.join('|'),
  `实际 ${names.join(' ')}`)

// ---------------------------------------------------------------- §2 监听端存在

console.log('\n§2 监听端：每条派发出去的通道都有人接')

for (const d of dispatched) {
  const hits = listenersOf(d)
  check(`${d.name} 有监听端`, hits.length >= 1, hits.length ? hits.join('、') : '零命中 —— 派发端还在、监听端没了')
}
// 反例（负向验证）：随机不存在的名字必须零命中，否则说明匹配器恒真、上面全是假通过
const fake = listenersOf({ name: 'kb-no-such-channel-xyz', idents: [] })
check('反例：不存在的通道名匹配不到监听端（证明匹配器不空转）', fake.length === 0, fake.join('、'))

// ---------------------------------------------------------------- §3 pdf-zoom-fit 运行期口径

console.log('\n§3 pdf-zoom-fit：可见性兜底 + 与 Ctrl+0 共用同一个动作')

const PDF_VIEW = read('src/components/shared/pdf/PdfReaderView.tsx')
const regIdx = PDF_VIEW.indexOf('window.addEventListener(KB_PDF_ZOOM_FIT')
// 处理器写在注册语句**之前**，所以切片要往回带一段（注释已被 stripComments 剥掉，不会假通过）
const effect = regIdx >= 0 ? PDF_VIEW.slice(Math.max(0, regIdx - 500), regIdx + 120) : ''
check('阅读器里注册了 KB_PDF_ZOOM_FIT 监听', regIdx >= 0,
  regIdx >= 0 ? `PdfReaderView.tsx:${PDF_VIEW.slice(0, regIdx).split('\n').length}` : '')
check('监听端调的是既有 resetFit（不另写一份缩放逻辑）', /resetFit\(\)/.test(effect))
check('★ 监听端先判可见性：不可见（所在 Tab 被 display:none 收起）直接 return',
  /offsetParent === null/.test(effect) && effect.indexOf('offsetParent === null') < effect.indexOf('resetFit()'),
  '缺这条 = 隐藏 Tab 里的阅读器也会被写一条 zoom 进度')

const keyIdx = PDF_VIEW.indexOf("e.key === '0' && (e.ctrlKey || e.metaKey)")
const keyBranch = keyIdx >= 0 ? PDF_VIEW.slice(keyIdx, keyIdx + 160) : ''
check("键盘 Ctrl+0 分支仍调 resetFit（两条路径同一个动作源）",
  keyIdx >= 0 && /resetFit\(\)/.test(keyBranch), keyBranch.trim().slice(0, 90))

// ★ K-1（2026-10-13）：键盘 handler 原先**没有**可见性守卫 —— 被收起那个实例照样响应 window keydown。
const keyHandlerOf = (src) => {
  const i = src.indexOf('const onKey = (e: KeyboardEvent) => {')
  const j = i >= 0 ? src.indexOf("window.addEventListener('keydown', onKey)", i) : -1
  return i >= 0 && j > i ? src.slice(i, j) : ''
}
const keyGuardOK = (src) => {
  const body = keyHandlerOf(src)
  return /offsetParent === null/.test(body) && body.indexOf('offsetParent === null') < body.indexOf('stepPage(1)')
}
check('键盘 handler 切得出来（切错会让下面两条空转）', keyHandlerOf(PDF_VIEW).length > 200,
  `${keyHandlerOf(PDF_VIEW).length} 字符`)
check('★ 键盘分支也先判可见性（K-1：被收起的实例一律不动键盘）', keyGuardOK(PDF_VIEW),
  '守卫必须在第一个动作 stepPage 之前')
check('反例（K-1 的旧形态）：把守卫删掉后同一条匹配器必须不认',
  !keyGuardOK(PDF_VIEW.replace('if (!root || root.offsetParent === null) return', '')),
  '删掉后仍判为「有守卫」= 匹配器空转')

// ★ K-2（2026-10-13）：全局缩放的让位判定原先只认「书架 Tab + 在读」，漏了笔记侧那个挂载点。
const zoomHeadOf = (src) => {
  const i = src.indexOf('NumpadAdd')
  return i >= 0 ? src.slice(Math.max(0, i - 900), i) : ''
}
const yieldOK = (src) => {
  const head = zoomHeadOf(src)
  return /hasVisiblePdfReader\(\)/.test(head) && /activeTab === 'bookshelf'/.test(head)
    && /e\.key === '='/.test(head) && /e\.key === '-'/.test(head)
}
check('全局缩放的 keydown 处理器切得出来（切错会让下面两条空转）', zoomHeadOf(APP).length > 200,
  '锚点：App.tsx 里的 NumpadAdd')
check('★ 让位判定认第二个挂载点（K-2：笔记侧 PDF 附件也让位）', yieldOK(APP),
  '缺这条 = 笔记里 Ctrl+= 界面缩放与附件缩放同时生效')
check('反例（K-2 的旧形态）：去掉可见性探针后同一条匹配器必须不认',
  !yieldOK(APP.replace(' || hasVisiblePdfReader()', '')),
  '去掉后仍判为「已放宽」= 匹配器空转')

// 探针两侧对账：标记写在阅读器根 div 上、选择器写在 pdfEvents —— 只改一侧 ⇒ 探针恒 false（零报错）
const attrMatch = EVENTS_SRC.match(/querySelectorAll[^(]*\(\s*'\[([a-z0-9-]+)\]'/)
const probeAttr = attrMatch ? attrMatch[1] : ''
const rootRefIdx = PDF_VIEW.indexOf('ref={rootRef}')
const rootTag = rootRefIdx >= 0
  ? PDF_VIEW.slice(PDF_VIEW.lastIndexOf('<div', rootRefIdx), PDF_VIEW.indexOf('>', rootRefIdx) + 1)
  : ''
const probeIdx = EVENTS_SRC.indexOf('function hasVisiblePdfReader')
const probe = probeIdx >= 0 ? EVENTS_SRC.slice(probeIdx, probeIdx + 400) : ''
check('可见性探针存在于 pdfEvents（App 与阅读器共用同一条判据）', probe.length > 0)
check('探针找的属性名解析成功（解析不到会让下面两条空转）', !!probeAttr, probeAttr || '未解析到')
check(`阅读器根节点带着探针要找的属性（${probeAttr || '?'}）`,
  !!rootTag && rootTag.includes(probeAttr), rootTag.slice(0, 110))
check('反例：同一条匹配器对改名后的属性不认（证明上一条不是恒真）',
  !!probeAttr && !!rootTag && !rootTag.includes(probeAttr + '-renamed'), `${probeAttr}-renamed 不该命中`)
check('探针按 offsetParent 判可见，且不是恒真桩',
  /offsetParent !== null/.test(probe) && probe.indexOf('offsetParent !== null') < probe.indexOf('return true'),
  '判据必须先于 return true')

const bindIdx = seg.indexOf("'pdf-zoom-fit'")
const binding = bindIdx >= 0 ? seg.slice(bindIdx, bindIdx + 240) : ''
check('App 绑定表用常量派发（不是手抄字符串 —— 手抄的改名后不报错）',
  /new CustomEvent\(KB_PDF_ZOOM_FIT\)/.test(binding), binding.trim().split('\n')[0] ?? '')

const def = commandById('pdf-zoom-fit')
check('真源里 pdf-zoom-fit 的锚包含运行期承接点（面板路径不会只指向键盘那条）',
  !!def && def.sources.some((s) => s.includes('KB_PDF_ZOOM_FIT')),
  (def?.sources ?? []).join(' | '))

// ---------------------------------------------------------------- 收尾

console.log('')
if (failures === 0) {
  console.log(`PASS  面板通道：${dispatched.length} 条派发 / 全部有监听端 / pdf-zoom-fit 与全局缩放让位口径完整（含 K-1 K-2）`)
  process.exit(0)
}
console.error(`FAIL  ${failures} 项未通过`)
process.exit(1)
