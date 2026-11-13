/**
 * 契约验证：AI 教学「选择工作区」页改版（3.26，方案 E 主从预览）。
 *
 * 锁四件事：
 *  1. 纯函数 courseProgressSummary 的口径（与 unitLearned 一致、无大纲不产生 NaN）；
 *  2. 主进程 listWorkspaces 带回 recentSessions（内存复用，不新增读盘）；
 *  3. 渲染层接线：等高主从布局、细滚动条 / 隐藏滚动条、打开文件夹通道；
 *  4. 旧中央模态已移除、删除走行内确认（不再 showGlobalConfirm）。
 *
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-picker.mjs
 * 输出纯 ASCII（禁 emoji）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-picker-'))
function load(rel) {
  const src = read(rel)
  let out = stripTypeScriptTypes(src, { mode: 'strip' })
  out = out.replace(/from '\.\/([^']+)'/g, "from './$1.mjs'")
  const file = path.join(tmp, `${path.basename(rel, '.ts')}.mjs`)
  fs.writeFileSync(file, out)
  return import(pathToFileURL(file).href)
}

const pure = await load('src/lib/aiTeachingProgressPure.ts')
const summary = pure.courseProgressSummary

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\n=== A. courseProgressSummary ===')
const outline = { chapters: [{ units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] }] }
check('0 学完 → 0/3', eq(summary(outline, {}, {}), { learned: 0, total: 3, pct: 0 }), JSON.stringify(summary(outline, {}, {})))
const p2 = { u1: { finished: true }, u2: { finished: true } }
check('2 学完 → 67%', eq(summary(outline, p2, {}), { learned: 2, total: 3, pct: 67 }), JSON.stringify(summary(outline, p2, {})))
const p3open = { u1: { finished: true }, u2: { finished: true }, u3: { finished: true } }
const lessonsOpen = { s1: { status: 'open', unitIds: ['u3'] } }
check('段未收尾 → 不算学完', eq(summary(outline, p3open, lessonsOpen), { learned: 2, total: 3, pct: 67 }), JSON.stringify(summary(outline, p3open, lessonsOpen)))
const lessonsEnded = { s1: { status: 'ended', unitIds: ['u3'] } }
check('段已收尾 → 3/3', eq(summary(outline, p3open, lessonsEnded), { learned: 3, total: 3, pct: 100 }), JSON.stringify(summary(outline, p3open, lessonsEnded)))
check('大纲为 null → 0/0/0', eq(summary(null, {}, {}), { learned: 0, total: 0, pct: 0 }), JSON.stringify(summary(null, {}, {})))
check('空章 → 0/0/0', eq(summary({ chapters: [] }, {}, {}), { learned: 0, total: 0, pct: 0 }), JSON.stringify(summary({ chapters: [] }, {}, {})))

console.log('\n=== B. 主进程 recentSessions ===')
const wsSrc = read('electron/lib/aiTeachingWorkspaces.ts')
check('WorkspaceInfo 带 recentSessions 字段', /recentSessions:\s*WorkspaceRecentSession\[\]/.test(wsSrc))
check('listWorkspaces 取前 2 条', /slice\(0,\s*2\)/.test(wsSrc) && /recentSessions,/.test(wsSrc))
check('复用内存 sessions（不新增读盘）', !/readFileSync\([^)]*sessions/.test(wsSrc))

console.log('\n=== C. 类型同步 ===')
const typesSrc = read('src/types/index.ts')
check('AiTeachRecentSession 存在', /interface AiTeachRecentSession\b/.test(typesSrc))
check('AiTeachWorkspaceInfo 带 recentSessions', /interface AiTeachWorkspaceInfo\b[\s\S]{0,400}recentSessions: AiTeachRecentSession\[\]/.test(typesSrc))

console.log('\n=== D. 渲染层接线 ===')
const viewSrc = read('src/modules/ai-teaching/index.tsx')
check('使用 courseProgressSummary', /courseProgressSummary\(/.test(viewSrc))
check('列表细滚动条 .kb-thin-scroll', /kb-thin-scroll/.test(viewSrc))
check('预览隐藏滚动条 .kb-hide-scrollbar', /kb-hide-scrollbar/.test(viewSrc))
check('主从两列 260/300px', /grid-cols-\[260px_minmax\(0,1fr\)\]/.test(viewSrc) && /xl:grid-cols-\[300px_minmax\(0,1fr\)\]/.test(viewSrc))
check('左列 absolute 等高', /absolute inset-0 flex flex-col/.test(viewSrc))
check('分栏高度上限 480', /max-h-\[480px\]/.test(viewSrc))
check('打开文件夹走 workspaceOpenInSystem', /workspaceOpenInSystem\(rootId/.test(viewSrc))
check('最近对话时间格式函数', /function wsRecentTime\(/.test(viewSrc))
check('单击选中 / 双击进入', /onClick=\{\(\) => setSelWsId\(w\.id\)\}/.test(viewSrc) && /onDoubleClick=\{\(\) => enterWs\(w\.id\)\}/.test(viewSrc))

console.log('\n=== E. 去中央模态 + 行内删除 ===')
check('不再有 wsModal 状态', !/wsModal/.test(viewSrc))
check('不再有 submitWsModal', !/submitWsModal/.test(viewSrc))
check('不再有 removeWs', !/\bremoveWs\b/.test(viewSrc))
const delBody = (() => {
  const i = viewSrc.indexOf('const confirmDeleteWs')
  if (i < 0) return ''
  const j = viewSrc.indexOf('}, [', i)
  return viewSrc.slice(i, j < 0 ? i + 1200 : j)
})()
check('confirmDeleteWs 存在', delBody.length > 0)
check('行内删除不走 showGlobalConfirm', delBody.length > 0 && !/showGlobalConfirm/.test(delBody))
check('行内删除调用 aiTeachDeleteWorkspace', /aiTeachDeleteWorkspace\(/.test(delBody))

console.log('\n=== F. 样式基建 ===')
const cssSrc = read('src/styles/index.css')
check('.kb-hide-scrollbar 已定义', /\.kb-hide-scrollbar\s*\{/.test(cssSrc))
check('.kb-thin-scroll 仍是 4px', /\.kb-thin-scroll::-webkit-scrollbar\s*\{\s*width:\s*4px/.test(cssSrc))

let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  -> ${c.detail}` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
if (failed) {
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('RESULT: PASS')
