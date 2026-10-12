/**
 * 契约脚本：工作台分屏（模块级两栏）
 *
 * 覆盖的缺陷面：
 *   ① 保活回归 —— 模块容器换了父节点 / 可见性退回「等于 activeTab」= 模块内 useState 归零
 *      （静态锁：容器仍是单一 keyed 数组 + visible/active 分离 + 无老写法 display:t===activeTab）；
 *   ② 分屏钝解析回归 —— split 字段坏数据必须整体丢弃（不炸启动），合法数据要做组 id 归一 /
 *      g1 前置补齐 / tabs 只收字符串 / ratio 夹 0.2~0.8；
 *   ③ 接线断链 —— 右键拆分/合并/移到另一栏、跨栏拖入、自动合并、持久化读写、活动栏底色、
 *      工具宿主按栏归位：任一环漏接都会「按钮点了没反应」而无报错；
 *   ④ 整窗模块 × 分屏 —— layoutSplit 必须被 fullWindowTab 关掉（否则整窗模块里漏出分隔条/另一栏）。
 *
 * 用法：
 *   node --experimental-strip-types .AGENT/scripts/split/verify-split.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseWorkbenchLayout, DEFAULT_WORKBENCH_LAYOUT } from '../../../src/lib/workbenchLayout.ts'

// ★ 仓库根按脚本自身位置解析，不写死绝对路径（在 worktree 里跑校验的是那棵树）
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
const srcBar = stripComments(read('src/components/workbench/WorkbenchPageBar.tsx'))
const srcCss = stripComments(read('src/styles/index.css'))

/* ================= A. split 钝解析（直接 import 真实现） ================= */
console.log('\n=== A. workbenchLayout.split 钝解析 ===')
ok(DEFAULT_WORKBENCH_LAYOUT.split === null, 'A0 缺省 split = null（单栏）')
ok(parseWorkbenchLayout('').split === null, 'A1 空值 split = null')
ok(parseWorkbenchLayout('not-json{{').split === null, 'A2 坏 JSON split = null（不炸启动）')

const sp = parseWorkbenchLayout(JSON.stringify({ split: {
  orientation: 'column', ratio: 0.5, activeGroupId: 'g2',
  groups: [
    { id: 'g2', tabs: ['knowledge', 42, null], active: 'knowledge' },
    { id: 'g1', tabs: ['blog'], active: null },
  ],
} })).split
ok(!!sp && sp.orientation === 'column' && sp.ratio === 0.5 && sp.activeGroupId === 'g2', 'A3 合法 split 保留（方向/比例/活动组）', JSON.stringify(sp))
ok(!!sp && sp.groups.length === 2 && sp.groups[0].id === 'g1' && sp.groups[1].id === 'g2', 'A4 组按 g1→g2 归一排序', sp ? sp.groups.map((g) => g.id).join(',') : '')
ok(!!sp && sp.groups[1].tabs.length === 1 && sp.groups[1].tabs[0] === 'knowledge', 'A5 tabs 只收字符串（丢 42/null）', sp ? JSON.stringify(sp.groups[1].tabs) : '')

const r = parseWorkbenchLayout(JSON.stringify({ split: { orientation: 'row', ratio: 5, activeGroupId: 'g1', groups: [{ id: 'g1', tabs: [], active: null }] } })).split
ok(!!r && r.ratio === 0.8, 'A6 ratio 上夹 0.8', r ? String(r.ratio) : '')
const r2 = parseWorkbenchLayout(JSON.stringify({ split: { orientation: 'row', ratio: -3, activeGroupId: 'g1', groups: [{ id: 'g1', tabs: [], active: null }] } })).split
ok(!!r2 && r2.ratio === 0.2, 'A7 ratio 下夹 0.2', r2 ? String(r2.ratio) : '')

const bad = parseWorkbenchLayout(JSON.stringify({ split: { orientation: 'diagonal', ratio: 0.5, activeGroupId: 'g1', groups: [{ id: 'g1', tabs: ['blog'], active: null }] } })).split
ok(bad === null, 'A8 非法 orientation → split 整体丢弃')

const ng = parseWorkbenchLayout(JSON.stringify({ split: { orientation: 'row', ratio: 0.5, activeGroupId: 'g1', groups: [{ id: 'g2', tabs: ['blog'], active: 'blog' }] } })).split
ok(!!ng && ng.groups[0].id === 'g1' && ng.groups[0].tabs.length === 0 && ng.groups[1].id === 'g2', 'A9 缺 g1 → 补空 g1 于首位')

const dup = parseWorkbenchLayout(JSON.stringify({ split: { orientation: 'row', ratio: 0.5, activeGroupId: 'g1', groups: [{ id: 'g1', tabs: ['blog'], active: null }, { id: 'g1', tabs: ['knowledge'], active: null }, { id: 'g2', tabs: [], active: null }] } })).split
ok(!!dup && dup.groups.length === 2 && dup.groups.filter((g) => g.id === 'g1').length === 1, 'A10 组 id 去重 + 上限 2')

/* ================= B. App.tsx 组模型 / 保活结构 ================= */
console.log('\n=== B. App.tsx 组模型与保活结构 ===')
ok(/interface\s+WbGroup\s*\{/.test(srcApp), 'B1 WbGroup 组接口存在')
ok(/const\s+\[groups,\s*setGroups\]\s*=\s*useState<WbGroup\[\]>/.test(srcApp), 'B2 groups 状态（组模型地基）')
ok(/const\s+openTabs\s*=\s*useMemo\(/.test(srcApp), 'B3 openTabs 派生（并集，保住所有 includes 判断）')
ok(/const\s+activeTab:\s*TabName\s*\|\s*null\s*=/.test(srcApp) && /const\s+activeToolTab:\s*string\s*\|\s*null\s*=/.test(srcApp), 'B4 activeTab / activeToolTab 派生')
ok(/const\s+splitActive\s*=\s*groups\.length\s*>\s*1/.test(srcApp), 'B5 splitActive = 组数 > 1')
ok(/const\s+layoutSplit\s*=\s*splitActive\s*&&\s*!fullWindowTab/.test(srcApp), 'B6 layoutSplit = splitActive && !fullWindowTab（整窗模块暂隐分屏）')
ok(/const\s+paneStyleFor\s*=\s*useCallback\(\(gi:\s*number,\s*on:\s*boolean\)/.test(srcApp), 'B7 paneStyleFor(gi, on) 按栏排布')
ok(/function\s+renderMounted\(name:\s*TabName,\s*active:\s*boolean,\s*visible:\s*boolean\)/.test(srcApp), 'B8 renderMounted(active, visible) 焦点/可见分离')
ok(/renderMounted\(t,\s*t\s*===\s*activeTab,\s*visible\)/.test(srcApp), 'B9 调用点：active=t===activeTab，visible=gi!==-1')
ok(/rowModules\.map\(/.test(srcApp), 'B10 模块容器仍是 rowModules.map（单一 keyed 数组）')
ok(/data-group=\{visible\s*\?\s*groups\[gi\]\.id/.test(srcApp), 'B11 容器带 data-group 标记（契约 DOM 断言用）')
ok(/\{layoutSplit\s*&&\s*\(/.test(srcApp), 'B12 分隔条门 = layoutSplit')

/* 组操作 / 交互 */
ok(/const\s+splitTabToNewGroup\s*=\s*\(gid:\s*'g1'\s*\|\s*'g2'/.test(srcApp), 'B13 splitTabToNewGroup 拆分')
ok(/const\s+mergeGroupsToPrimary\s*=\s*useCallback\(/.test(srcApp), 'B14 mergeGroupsToPrimary 合并')
ok(/const\s+moveTabToGroup\s*=\s*\(tabId:\s*string,\s*targetGid/.test(srcApp), 'B15 moveTabToGroup 跨栏移动')
ok(/groups\.length\s*>\s*1\s*&&\s*\(groups\[0\]\.tabs\.length\s*===\s*0\s*\|\|\s*groups\[1\]\.tabs\.length\s*===\s*0\)/.test(srcApp), 'B16 自动合并：任一组清空即合并')
ok(/onDropExternal=\{\(dragId,\s*beforeId\)\s*=>\s*moveTabToGroup\(/.test(srcApp), 'B17 页面条 onDropExternal 接线到 moveTabToGroup')
ok(/const\s+renderPageBar\s*=\s*\(g:\s*WbGroup\)/.test(srcApp), 'B18 renderPageBar(g) 按组渲染页面条')
ok(/groups\.length\s*===\s*1\s*\?\s*renderPageBar\(groups\[0\]\)/.test(srcApp), 'B19 单栏走直接渲染（DOM 与改前一致）')
ok(/onContextMenu=\{\(e,\s*id\)\s*=>\s*openPageBarMenu\(/.test(srcApp), 'B20 页面条条目 onContextMenu 接线')
ok(/label:\s*'向右拆分'/.test(srcApp) && /label:\s*'向下拆分'/.test(srcApp), 'B21 右键菜单含向右/向下拆分')
ok(/label:\s*'移到另一栏'/.test(srcApp) && /label:\s*'合并回主栏'/.test(srcApp), 'B22 右键菜单含移到另一栏/合并回主栏')
ok(/paneActive=\{splitActive\s*&&\s*g\.id\s*===\s*activeGroupId\}/.test(srcApp), 'B23 页面条 paneActive = splitActive 且活动组（单栏不上底色，防回归）')
ok(/const\s+toolGroupIdx\s*=\s*\(\(\)\s*=>/.test(srcApp), 'B24 工具宿主按栏归位 toolGroupIdx')
ok(/!visibleToolTab\s*&&\s*groups\.every\(\(g\)\s*=>\s*g\.active\s*===\s*null\)/.test(srcApp), 'B25 空态 = 所有组均空且无工具')

/* 持久化 */
ok(/const\s+validTab\s*=\s*\(x:\s*string\)\s*=>/.test(srcApp), 'B26 validTab 恢复净化')
ok(/const\s+splitRestoredRef\s*=\s*useRef\(false\)/.test(srcApp), 'B27 splitRestoredRef 一次性恢复标记')
ok(/settingsReady/.test(srcApp) && /wbLayout\.split/.test(srcApp), 'B28 恢复/写回读 wbLayout.split + settingsReady 门')
ok(/update\('workbenchLayout',\s*JSON\.stringify\(\{\s*\.\.\.wbLayout,\s*split\s*\}\)\)/.test(srcApp), 'B29 持久化写回 wbLayout.split')

/* ================= C. WorkbenchPageBar.tsx 接线 ================= */
console.log('\n=== C. WorkbenchPageBar 接线 ===')
ok(/onDropExternal\?:\s*\(dragId:\s*string,\s*beforeId:\s*string\s*\|\s*null\)\s*=>\s*void/.test(srcBar), 'C1 onDropExternal prop')
ok(/paneActive\?:\s*boolean/.test(srcBar), 'C2 paneActive prop')
ok(/paneActive\s*\?\s*'\s*kb-pane-active'/.test(srcBar), 'C3 paneActive → kb-pane-active 类')
ok(/from\s*===\s*-1\)\s*\{\s*onDropExternal\?\.\(raw,\s*targetId\)/.test(srcBar), 'C4 组内落空 → 跨栏移动（targetId 前插入）')
ok(/const\s+handleRowDrop\s*=/.test(srcBar) && /onDropExternal\?\.\(raw,\s*null\)/.test(srcBar), 'C5 空白落点 → 追加到目标组尾部')

/* ================= D. index.css 高亮/分隔条 ================= */
console.log('\n=== D. index.css ===')
ok(/\.kb-pane-divider\s*\{/.test(srcCss), 'D1 .kb-pane-divider 分隔条样式')
ok(/\[data-wb="pagebar"\]\.kb-pane-active\s*\{/.test(srcCss), 'D2 活动栏底色高亮（抬特化压过 Tailwind 背景）')

/* ================= E. 反例（回归锁） ================= */
console.log('\n=== E. 反例断言 ===')
ok(!/display:\s*t\s*===\s*activeTab\s*\?\s*undefined\s*:\s*'none'/.test(srcApp), 'E1 不得退回「可见性=等于 activeTab」老写法（保活回归）')
ok(!/className="absolute inset-y-0 left-0 z-20 flex min-h-0 w-full flex-col"/.test(srcApp), 'E2 工具宿主不得退回绝对定位铺满（会盖另一栏）')
ok(!/activeTab\s*===\s*null\s*&&\s*!activeToolTab/.test(srcApp), 'E3 空态不得退回「只看 activeTab」')

/* ================= F. 知识库文件页签右键触发分屏 ================= */
console.log('\n=== F. 知识库页签右键触发分屏 ===')
const srcKb = stripComments(read('src/modules/knowledge/index.tsx'))
ok(/onSplitModule\?:\s*\(orientation:\s*'row'\s*\|\s*'column'\)\s*=>\s*void/.test(srcKb), 'F1 KnowledgeModule 暴露 onSplitModule prop')
ok(/向右拆分/.test(srcKb) && /向下拆分/.test(srcKb), 'F2 知识库页签右键菜单含向右/向下拆分')
ok(/onSplitModule=\{\(o\)\s*=>/.test(srcApp), 'F3 App 向 KnowledgeModule 传 onSplitModule（页签右键可触发分屏）')
ok(/const\s+splitDisabledFor\s*=\s*\(gid/.test(srcApp) && /disabled:\s*splitDisabledFor\(gid\)/.test(srcApp), 'F4 源栏仅剩一个标签时拆分项置灰（避免空合并「点了没反应」）')
ok(/splitDisabled=\{splitActive\s*\|\|/.test(srcApp), 'F5 App 向 KnowledgeModule 传 splitDisabled')
ok(/disabled=\{splitDisabled\}/.test(srcKb), 'F6 知识库拆分项受 splitDisabled 控制')

/* ================= 结果 ================= */
console.log(`\n==== 分屏契约：通过 ${pass}，失败 ${fails.length} ====`)
if (fails.length) {
  console.log('[FAIL] 失败项：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
console.log('[OK] 全部分屏契约通过')
