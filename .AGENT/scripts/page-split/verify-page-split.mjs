/**
 * 契约脚本：页面级分屏（只搬「页面标签」，模块不分栏）
 *
 * 覆盖的缺陷面：
 *   ① pageSplit 钝解析回归 —— 坏数据整体落 null（单栏，不炸启动）；方向非法丢弃、ratio 夹 0.2~0.8、
 *      空/非字符串 id 过滤；合法数据往返。
 *   ② 接线断链 —— 拆分/合并/移动/移除页面、跨栏拖入、副栏页签条/内容 portal、分隔条、
 *      持久化读写：任一环漏接会「按钮点了没反应」而无报错。
 *   ③ 保活与槽冲突 —— 主栏模块容器结构不动；副栏 PageEditor 必须 isActive=false，
 *      否则两实例抢主栏单例槽 #editor-toolbar-slot。
 *   ④ 范围锁 —— 分屏模型只装「页面」，模块标签不得进（模块整体不分栏）。
 *
 * 用法：
 *   node --experimental-strip-types .AGENT/scripts/page-split/verify-page-split.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseWorkbenchLayout, DEFAULT_WORKBENCH_LAYOUT } from '../../../src/lib/workbenchLayout.ts'

// ★ 仓库根按脚本自身位置解析（在 worktree 里跑校验的是那棵树）
const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  return false
}

/** 只剥注释、保留字符串字面量（与 verify-workbench-shell 同一份状态机实现） */
function stripComments(src) {
  let out = ''
  let st = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (st === 'code') {
      if (c === '/' && n === '/') { st = 'line'; i++; out += '  '; continue }
      if (c === '/' && n === '*') { st = 'block'; i++; out += '  '; continue }
      if (c === "'") st = 'sq'; else if (c === '"') st = 'dq'; else if (c === '`') st = 'tpl'
      out += c; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c } else out += ' '; continue }
    if (st === 'block') { if (c === '*' && n === '/') { st = 'code'; i++; out += '  ' } else out += c === '\n' ? '\n' : ' '; continue }
    if (st === 'sq' || st === 'dq' || st === 'tpl') {
      if (c === '\\') { out += c + (n ?? ''); i++; continue }
      if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) st = 'code'
      out += c; continue
    }
  }
  return out
}

const srcApp = stripComments(read('src/App.tsx'))
const srcKb = stripComments(read('src/modules/knowledge/index.tsx'))
const srcStrip = stripComments(read('src/components/workbench/PageTabStrip.tsx'))
const srcWbl = stripComments(read('src/lib/workbenchLayout.ts'))
const srcCss = stripComments(read('src/styles/index.css'))

/* ================= A. pageSplit 钝解析（直接 import 真实现） ================= */
console.log('\n=== A. workbenchLayout.pageSplit 钝解析 ===')
ok(DEFAULT_WORKBENCH_LAYOUT.pageSplit === null, 'A0 缺省 pageSplit = null（单栏）')
ok(parseWorkbenchLayout('').pageSplit === null, 'A1 空值 pageSplit = null')
ok(parseWorkbenchLayout('not-json{{').pageSplit === null, 'A2 坏 JSON pageSplit = null（不炸启动）')

const ps = parseWorkbenchLayout(JSON.stringify({ pageSplit: {
  orientation: 'column', ratio: 0.5, secondaryPageIds: ['p1', 42, '', 'p2'], secondaryActiveId: 'p2',
} })).pageSplit
ok(!!ps && ps.orientation === 'column' && ps.ratio === 0.5 && ps.secondaryActiveId === 'p2', 'A3 合法 pageSplit 保留', JSON.stringify(ps))
ok(!!ps && ps.secondaryPageIds.length === 2 && ps.secondaryPageIds[0] === 'p1' && ps.secondaryPageIds[1] === 'p2', 'A4 secondaryPageIds 只收非空字符串', ps ? JSON.stringify(ps.secondaryPageIds) : '')

const psR = parseWorkbenchLayout(JSON.stringify({ pageSplit: { orientation: 'row', ratio: 9, secondaryPageIds: ['x'], secondaryActiveId: null } })).pageSplit
ok(!!psR && psR.ratio === 0.8, 'A5 ratio 夹到 0.8', psR ? String(psR.ratio) : '')
const psR2 = parseWorkbenchLayout(JSON.stringify({ pageSplit: { orientation: 'row', ratio: -2, secondaryPageIds: ['x'], secondaryActiveId: null } })).pageSplit
ok(!!psR2 && psR2.ratio === 0.2, 'A6 ratio 夹到 0.2', psR2 ? String(psR2.ratio) : '')

const psBadOri = parseWorkbenchLayout(JSON.stringify({ pageSplit: { orientation: 'diagonal', ratio: 0.5, secondaryPageIds: ['x'], secondaryActiveId: null } })).pageSplit
ok(psBadOri === null, 'A7 非法 orientation → pageSplit 丢弃（落单栏）')
const psEmpty = parseWorkbenchLayout(JSON.stringify({ pageSplit: { orientation: 'row', ratio: 0.5, secondaryPageIds: [], secondaryActiveId: null } })).pageSplit
ok(psEmpty === null, 'A8 空 secondaryPageIds → 单栏（无意义分屏丢弃）')
const psNoActive = parseWorkbenchLayout(JSON.stringify({ pageSplit: { orientation: 'row', ratio: 0.5, secondaryPageIds: ['x'] } })).pageSplit
ok(!!psNoActive && psNoActive.secondaryActiveId === null, 'A9 缺 secondaryActiveId → null')

/* ================= B. App 状态 / 渲染接线 ================= */
console.log('\n=== B. App 状态与渲染 ===')
ok(/const\s+\[pageSplit,\s*setPageSplit\]\s*=\s*useState</.test(srcApp), 'B1 pageSplit 状态')
ok(/const\s+splitPageToPane\s*=\s*useCallback\(/.test(srcApp), 'B2 splitPageToPane 拆分')
ok(/const\s+mergePagePanes\s*=\s*useCallback\(/.test(srcApp), 'B3 mergePagePanes 合并')
ok(/const\s+movePageToPane\s*=\s*useCallback\(/.test(srcApp), 'B4 movePageToPane 移动')
ok(/const\s+removePageFromPane\s*=\s*useCallback\(/.test(srcApp), 'B5 removePageFromPane 移除 + 空自动合并')
ok(/const\s+mainPageBar\s*=\s*\(/.test(srcApp), 'B6 mainPageBar 抽出（单栏/两栏共用）')
ok(/!fullWindowTab\s*&&\s*!pageBarHidden\s*&&\s*\(pageSplitActive\s*\?/.test(srcApp), 'B7 页面条分屏分支按 pageSplitActive')
ok(/data-pb-slot="secondary"/.test(srcApp), 'B8 副栏页签段槽 data-pb-slot="secondary"')
ok(/ref=\{wbSecondaryContentRef\}/.test(srcApp), 'B9 副栏内容槽 ref')
ok(/wbSecondaryPageRef/.test(srcApp) && /wbSecondaryContentRef/.test(srcApp), 'B10 副栏两槽 ref 定义')
ok(/kb-pane-divider/.test(srcApp) && /startPageSplitDrag/.test(srcApp), 'B11 分隔条 + 拖拽调比例')
ok(/rowModules\.map\(/.test(srcApp), 'B12 主栏模块容器仍是 rowModules.map（保活不动）')
ok(/onMovePageToPane=\{movePageToPane\}/.test(srcApp), 'B13 App 向 KnowledgeModule 传 onMovePageToPane')

/* 持久化 */
ok(/const\s+pageSplitRestoredRef\s*=\s*useRef\(false\)/.test(srcApp), 'B14 pageSplitRestoredRef 一次性恢复标记')
ok(/wbLayout\.pageSplit/.test(srcApp), 'B15 恢复/写回读 wbLayout.pageSplit')
ok(/update\('workbenchLayout',\s*JSON\.stringify\(\{\s*\.\.\.wbLayout,\s*pageSplit: next\s*\}\)\)/.test(srcApp), 'B16 持久化写回 wbLayout.pageSplit')

/* ================= C. workbenchLayout 类型 ================= */
console.log('\n=== C. workbenchLayout 类型 ===')
ok(/export\s+interface\s+PageSplitLayout/.test(srcWbl), 'C1 PageSplitLayout 接口')
ok(/pageSplit:\s*PageSplitLayout\s*\|\s*null/.test(srcWbl), 'C2 WorkbenchLayout.pageSplit 字段')

/* ================= D. KnowledgeModule 接线 ================= */
console.log('\n=== D. KnowledgeModule 接线 ===')
ok(/secondaryPageIds\?:\s*string\[\]/.test(srcKb), 'D1 secondaryPageIds prop')
ok(/openPageIds\.filter\(\(pid\)\s*=>\s*!secondaryPageIds\.includes\(pid\)\)/.test(srcKb), 'D2 主栏页签条排除副栏页面')
ok(/onSplitPage\?:\s*\(pageId:\s*string,\s*orientation:\s*'row'\s*\|\s*'column'\)\s*=>\s*void/.test(srcKb), 'D3 onSplitPage prop')
ok(/向右拆分/.test(srcKb) && /向下拆分/.test(srcKb), 'D4 页面页签右键菜单含向右/向下拆分')
ok(/secondaryBarEl\s*&&\s*secItems\.length\s*>\s*0\)\s*\?\s*createPortal\(/.test(srcKb), 'D5 副栏页签条 portal 进副栏段槽')
ok(/onExternalDrop=\{\(id\)\s*=>\s*onMovePageToPane\?\.\(id\)\}/.test(srcKb), 'D6 副栏页签条接受跨栏拖入')
ok(/onExternalDrop=\{\(id\)\s*=>\s*onRemoveSecondary\?\.\(id\)\}/.test(srcKb), 'D7 主栏页签条接受副栏页面拖回')

/* ================= E. PageTabStrip 跨栏能力 ================= */
console.log('\n=== E. PageTabStrip 跨栏 ===')
ok(/onExternalDrop\?:\s*\(dragId:\s*string\)\s*=>\s*void/.test(srcStrip), 'E1 onExternalDrop prop')
ok(/const\s+canDrag\s*=\s*!!onReorder\s*\|\|\s*!!onExternalDrop/.test(srcStrip), 'E2 canDrag = onReorder || onExternalDrop')
ok(/if\s*\(srcIdx\s*===\s*-1\)\s*\{\s*onExternalDrop\?\.\(srcId\)/.test(srcStrip), 'E3 跨栏落点分流')

/* ================= F. 保活 / 槽冲突（反例锁） ================= */
console.log('\n=== F. 保活与槽冲突 ===')
ok(/secondaryContentEl\s*&&\s*secondaryPageIds\.length\s*>\s*0\s*&&\s*secondaryActiveId\s*&&\s*createPortal\([\s\S]{0,1600}?isActive=\{false\}/.test(srcKb), 'F1 副栏 PageEditor 必须 isActive={false}（否则抢主栏单例工具栏槽）')
ok(!/className="flex min-h-0 flex-1">\s*<div className="relative flex min-h-0 min-w-0 flex-1 flex-col"/.test(srcApp), 'F2 主栏内容行不得退回未挂 ref 的旧结构')

/* ================= 结果 ================= */
console.log(`\n==== 页面级分屏契约：通过 ${pass}，失败 ${fails.length} ====`)
if (fails.length) {
  console.log('[FAIL] 失败项：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
console.log('[OK] 全部页面级分屏契约通过')
