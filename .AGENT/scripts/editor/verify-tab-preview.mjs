/**
 * 契约验证：v3.2.0 条目 18 —— 编辑器文件标签的 VS Code 式双态（预览标签 + 固定标签）。
 *
 * 为什么需要它：本项把「标签存亡的判据」从**是否脏**换成了**是否预览态**，
 * 这是一条**状态机**，而状态机最容易出的三类错都不会报错、只会静默跑偏：
 *
 *   ① **回收候选集选错** —— 软上限回收若把「当前激活 / 预览 / 脏」也算进候选，
 *      表现是「打字打到一半，某个未保存标签自己没了」。静态文本断言看不出这种错。
 *   ② **转移规则漏一条** —— 例如「在预览标签里编辑要自动转固定」漏掉，
 *      表现是「输入到一半被新打开的第二个文件顶替，写的东西没了」；
 *      再如「保存不改变预览态」写反，就退回成本次报障的原症状（一保存标签就变样）。
 *   ③ **接线漏一处** —— 重命名 / 移动 / 撤销三个 relPath 迁移点若不搬 previewRel 与 LRU 记账，
 *      表现是「重命名后标签从斜体变正体、回收顺序也乱」，编译期完全无感。
 *
 * 做法（**优先直接 import 真实实现**）：核心判定抽在 `src/modules/editor/tabPolicy.ts`，
 *   本脚本用 `--experimental-strip-types` 直接 import 它并**真跑用例**——
 *   照抄一份算法到脚本里会正好掩盖「候选集自己选错了」这类缺陷（见 `.AGENT` 内既有教训）。
 *   剩下的接线与 UI 部分（React 组件内、无法脱离 electron 跑）用剥注释后的源码断言补。
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/editor/verify-tab-preview.mjs
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

// 真实纯函数（无 React / 无 electron 依赖，可直接引）
import {
  TAB_SOFT_CAP, previewReplacement, pickTabsToEvict, nextTabInCycle, landingAfterClose,
} from '../../../src/modules/editor/tabPolicy.ts'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const EDITOR = path.join(ROOT, 'src/modules/editor/index.tsx')
const TYPES = path.join(ROOT, 'src/modules/editor/types.ts')
const POLICY = path.join(ROOT, 'src/modules/editor/tabPolicy.ts')

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail })
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, a === e ? '' : `实际 ${a} ≠ 期望 ${e}`)
}

const editorCode = fs.existsSync(EDITOR) ? stripComments(fs.readFileSync(EDITOR, 'utf8')) : ''
const typesCode = fs.existsSync(TYPES) ? stripComments(fs.readFileSync(TYPES, 'utf8')) : ''
const policyCode = fs.existsSync(POLICY) ? stripComments(fs.readFileSync(POLICY, 'utf8')) : ''

check('三个目标文件都可读（守卫脚本没跑错目录）',
  editorCode.length > 1000 && typesCode.length > 100 && policyCode.length > 100,
  `index.tsx ${editorCode.length} / types.ts ${typesCode.length} / tabPolicy.ts ${policyCode.length} 字符`)

/** 从 startRe 命中处截到其后第一个 endRe（用于「某个函数体内**没有** X」这类断言） */
function sliceBetween(code, startRe, endRe) {
  const i = code.search(startRe)
  if (i < 0) return ''
  const tail = code.slice(i)
  const j = tail.search(endRe)
  return j < 0 ? tail : tail.slice(0, j)
}

/* ==================================================================
   一、真实执行：转移规则 1 的判定 —— 旧预览「转固定」还是「移除」
   ================================================================== */

eq('规则1：无旧预览 → none（什么都不用做）', previewReplacement(null, 'b.md', []), 'none')
eq('规则1：旧预览就是新文件 → none（只激活）', previewReplacement('a.md', 'a.md', []), 'none')
eq('规则1：旧预览干净 → drop（从 openFiles 移除）', previewReplacement('a.md', 'b.md', []), 'drop')
eq('规则1：旧预览脏 → keep（自动转固定，绝不丢内容）', previewReplacement('a.md', 'b.md', ['a.md']), 'keep')
eq('规则1：旧预览脏、新文件也在脏集合里 → 仍按旧预览判定', previewReplacement('a.md', 'b.md', ['a.md', 'b.md']), 'keep')

/* ==================================================================
   二、真实执行：软上限回收的候选集（三条保护 + LRU 最旧优先）
   ================================================================== */

eq('上限常量 = 20（DP 拍板值）', TAB_SOFT_CAP, 20)

const mk = (n, prefix = 'f') => Array.from({ length: n }, (_, i) => `${prefix}${i}.md`)

eq('未超上限 → 不回收', pickTabsToEvict({ rels: mk(20), previewRel: null, activeRel: 'f0.md', dirtyRels: [], lru: mk(20) }), [])
eq('恰好等于上限 → 不回收', pickTabsToEvict({ rels: mk(20), previewRel: null, activeRel: null, dirtyRels: [], lru: [] }).length, 0)

const over = mk(21)
const evicted = pickTabsToEvict({ rels: over, previewRel: null, activeRel: 'f20.md', dirtyRels: [], lru: over })
eq('超一个 → 只回收 1 个', evicted.length, 1)
eq('回收的是 LRU 最旧的那个', evicted, ['f0.md'])

// 预览标签不参与计数：20 固定 + 1 预览 = 合法
eq('预览标签不计数（20 固定 + 1 预览 → 不回收）',
  pickTabsToEvict({ rels: [...mk(20), 'preview.md'], previewRel: 'preview.md', activeRel: 'f0.md', dirtyRels: [], lru: [...mk(20), 'preview.md'] }),
  [])

// 保护集三档。注意用例里的「超限个数」= fixed 数 − cap（5 个固定、cap=2 → 要回收 3 个）
const rels5 = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']
eq('【保护】当前激活永不回收（即便它最旧）',
  pickTabsToEvict({ rels: rels5, previewRel: null, activeRel: 'a.md', dirtyRels: [], lru: rels5, cap: 2 }),
  ['b.md', 'c.md', 'd.md'])
eq('【保护】脏标签永不回收（即便它最旧）',
  pickTabsToEvict({ rels: rels5, previewRel: null, activeRel: 'e.md', dirtyRels: ['a.md'], lru: rels5, cap: 2 }),
  ['b.md', 'c.md', 'd.md'])
eq('【保护】预览标签不计入 fixed、也永不被回收',
  pickTabsToEvict({ rels: rels5, previewRel: 'a.md', activeRel: 'e.md', dirtyRels: [], lru: rels5, cap: 3 }),
  ['b.md'])
eq('候选不足时宁可少回收，也不动保护集',
  pickTabsToEvict({ rels: ['a.md', 'b.md', 'c.md'], previewRel: 'c.md', activeRel: 'a.md', dirtyRels: ['b.md'], lru: ['a.md', 'b.md', 'c.md'], cap: 1 }),
  [])
eq('未记账（不在 lru 里）视为最旧、优先回收',
  pickTabsToEvict({ rels: rels5, previewRel: null, activeRel: 'e.md', dirtyRels: [], lru: ['b.md', 'c.md', 'd.md'], cap: 3 }),
  ['a.md', 'b.md'])

/* ==================================================================
   三、真实执行：关闭落点 与 Ctrl+Tab 循环
   ================================================================== */

const tabs = ['a.md', 'b.md', 'c.md']
eq('关闭落点：中间标签 → 右邻居', landingAfterClose(tabs, 'b.md'), 'c.md')
eq('关闭落点：最后一个 → 左邻居', landingAfterClose(tabs, 'c.md'), 'b.md')
eq('关闭落点：第一个 → 右邻居', landingAfterClose(tabs, 'a.md'), 'b.md')
eq('关闭落点：只剩一个 → null（回编辑器空态）', landingAfterClose(['a.md'], 'a.md'), null)
eq('关闭落点：不在列表里 → null', landingAfterClose(tabs, 'zz.md'), null)
eq('关闭落点：不返回被关掉的标签', landingAfterClose(tabs, 'b.md') === 'b.md', false)

eq('循环：正向到末尾回绕', nextTabInCycle(tabs, 'c.md', false), 'a.md')
eq('循环：反向到开头回绕', nextTabInCycle(tabs, 'a.md', true), 'c.md')
eq('循环：正向正常前进', nextTabInCycle(tabs, 'a.md', false), 'b.md')
eq('循环：反向正常后退', nextTabInCycle(tabs, 'b.md', true), 'a.md')
eq('循环：无激活 → 正向取首个', nextTabInCycle(tabs, null, false), 'a.md')
eq('循环：无激活 → 反向取末个', nextTabInCycle(tabs, null, true), 'c.md')
eq('循环：激活不在列表 → 有兜底', nextTabInCycle(tabs, 'zz.md', false), 'a.md')
eq('循环：不足 2 个 → null（调用方放过这次按键）', nextTabInCycle(['a.md'], 'a.md', false), null)
eq('循环：空列表 → null', nextTabInCycle([], null, false), null)

/* ==================================================================
   四、静态：接线（判定必须真的被 index.tsx 用上，不许各写一份）
   ================================================================== */

check('index.tsx 从 ./tabPolicy 引入全部判定（唯一真相源）',
  /from '\.\/tabPolicy'/.test(editorCode)
  && ['TAB_SOFT_CAP', 'previewReplacement', 'pickTabsToEvict', 'nextTabInCycle', 'landingAfterClose']
    .every((s) => new RegExp(`import\\s*\\{[^}]*\\b${s}\\b`, 's').test(editorCode) || new RegExp(`\\b${s}\\b`).test(editorCode)))
check('index.tsx 不再自带一份 TAB_SOFT_CAP 字面量（避免两处飘）',
  !/const TAB_SOFT_CAP\b/.test(editorCode))
check('openFile 的预览顶替用 previewReplacement 判定',
  /previewReplacement\(/.test(sliceBetween(editorCode, /const openFile = useCallback/, /\n  \}, \[/)))
check('capTabs 用 pickTabsToEvict 挑候选',
  /pickTabsToEvict\(/.test(sliceBetween(editorCode, /const capTabs = useCallback/, /\n  \}, \[/)))
check('closeTab 落点用 landingAfterClose',
  /landingAfterClose\(/.test(sliceBetween(editorCode, /const closeTab = useCallback/, /\n  \}, \[/)))
check('Ctrl+Tab 用 nextTabInCycle',
  /nextTabInCycle\(/.test(editorCode))
check('Ctrl+W 关闭当前标签（未保存 → 复用 closeTarget 确认）',
  /e\.key === 'w'/.test(editorCode) && /requestCloseTab\(activePathRef\.current\)/.test(editorCode))

/* ==================================================================
   五、静态：六条转移规则逐条钉住
   ================================================================== */

check('规则1：旧预览顶替是**原子**的（同一个 setOpenFiles 里 delete 旧 + 加新的）',
  /verdict === 'drop' && prevPreview\) delete next\[prevPreview\]/.test(editorCode))
check('规则1：顶替不弹任何确认框（静默，对标 VS Code）',
  !/ConfirmDialog/.test(sliceBetween(editorCode, /const openFile = useCallback/, /\n  \}, \[/)))
check('规则2：预览标签里编辑 → 立即自动转固定',
  /previewRelRef\.current === relPath/.test(sliceBetween(editorCode, /const handleChange = useCallback/, /\n  \}, \[\]\)/))
  && /setPreviewRel\(null\)/.test(sliceBetween(editorCode, /const handleChange = useCallback/, /\n  \}, \[\]\)/)))
check('规则3：双击标签 → 固定',
  /onDoubleClick=\{\(\) => pinTab\(rel\)\}/.test(editorCode))
check('规则3：右键菜单有「固定标签」（单向，不做 Unpin）',
  /固定标签（保持常驻）/.test(editorCode) && !/取消固定/.test(editorCode) && !/PinOff/.test(editorCode))
check('规则4：保存**不改变预览态**（saveDoc 体内不碰 previewRel / 不回收标签）',
  (() => {
    const body = sliceBetween(editorCode, /const saveDoc = useCallback/, /\n  \}, \[\]\)/)
    return body.length > 500 && !/setPreviewRel|previewRelRef|forgetTabRel|capTabs|pruneCleanNonActive/.test(body)
  })())
check('规则4：保存后不再有任何「回收标签」的调用',
  !/pruneCleanNonActive/.test(editorCode))
check('规则5：关闭标签清预览态 + LRU 记账（forgetTabRel 单一实现）',
  /forgetTabRel\(relPath\)/.test(sliceBetween(editorCode, /const closeTab = useCallback/, /\n  \}, \[/))
  && /const forgetTabRel = useCallback/.test(editorCode)
  && /previewRelRef\.current === rel/.test(sliceBetween(editorCode, /const forgetTabRel = useCallback/, /\n  \}, \[\]\)/)))
check('规则6：原先「activePath 一变就回收干净文档」的 effect 已删除',
  !/useEffect\(\(\) => \{\s*pruneCleanNonActive\(activePath\)/.test(editorCode)
  && !/切走即回收/.test(editorCode))

/* ==================================================================
   六、静态：文件被外部删除 = 标签保留 + 删除线 + 保存即重建
   ================================================================== */

check('types.ts：EditorDoc 增加 missing 标记', /missing\?: boolean/.test(typesCode))
check('外部删除 → 打 missing 标记（不再弹三选）',
  /missing: true/.test(editorCode)
  && !/setConflictState\(\(cur\) => \(cur \? cur : \{ relPath, missing: true \}\)\)/.test(editorCode))
check('保存冲突三选状态不再承载 missing',
  /const \[conflictState, setConflictState\] = useState<\{ relPath: string; diskMtimeMs\?: number \}/.test(editorCode)
  && !/conflictState\.missing/.test(editorCode))
check('保存即重建：missing 文档不带 mtime 基线（非正数基线在主进程侧直接放行）',
  /wasMissing \? undefined : doc\.mtimeMs/.test(editorCode))
check('保存即重建：显式 0 = 「明确不带基线」的递归重写',
  /saveDoc\(relPath, 0\)/.test(editorCode))
check('保存成功清掉删除线', /missing: false/.test(editorCode))
check('重建后有明确反馈（toast）', /文件已在磁盘上重新创建/.test(editorCode))
check('磁盘内容被外部修改、而缓冲区干净 → 静默重读（不打扰）',
  /const reloadCleanDocFromDisk = useCallback/.test(editorCode)
  && (editorCode.match(/reloadCleanDocFromDisk\(/g) || []).length >= 2)

/* ==================================================================
   七、静态：标签栏交互与视觉（斜体=预览、删除线=已被删除）
   ================================================================== */

check('标签栏 = openFiles 全部（不再按「脏」过滤）',
  /const openList = Object\.keys\(openFiles\)/.test(editorCode)
  && !/const openList = Object\.keys\(openFiles\)\.filter/.test(editorCode))
check('视觉：预览态斜体（不加图标 / 色块 / 角标）',
  /isPreview \? 'italic' : ''/.test(editorCode))
check('视觉：已删除文件用删除线表达',
  /isMissing \? 'line-through' : ''/.test(editorCode))
check('视觉：固定态沿用原样式（未被改配色）',
  /border-transparent text-\[var\(--text-secondary\)\] hover:bg-\[var\(--bg-hover\)\]/.test(editorCode))
check('中键点击标签关闭（VS Code 习惯）',
  /onAuxClick=\{[^}]*e\.button === 1/.test(editorCode)
  && /onMouseDown=\{[^}]*e\.button === 1[^}]*e\.preventDefault\(\)/.test(editorCode))
check('激活标签自动滚进可视区',
  /scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/.test(editorCode)
  && /data-tab-rel=/.test(editorCode)
  && /ref=\{tabBarRef\}/.test(editorCode))
check('右键菜单补齐：关闭其他 / 关闭已保存 / 关闭全部',
  ['关闭其他', '关闭已保存', '关闭全部'].every((t) => editorCode.includes(t))
  && ['closeTabsExcept', 'closeSavedTabs', 'closeAllTabs'].every((f) => new RegExp(`const ${f} = useCallback`).test(editorCode)))
check('批量关闭不丢内容：脏标签一律保留（有明确口径注释）',
  /只关「干净」标签，脏标签一律保留/.test(fs.readFileSync(EDITOR, 'utf8'))
  && /未保存的标签未关闭（避免丢失修改）/.test(editorCode)
  && /个未保存的标签已保留/.test(editorCode))

/* ==================================================================
   八、静态：relPath 迁移与仓库切换（记账必须跟着搬 / 跟着清）
   ================================================================== */

check('四个 relPath 迁移点都搬运了标签记账（重命名 / 移动 / 知识库移动 / 撤销）',
  (editorCode.match(/remapTabRel\(/g) || []).length >= 4)
check('删除文件走 closeTab（复用落点与记账清理）',
  /closeTab\(node\.relPath\)/.test(sliceBetween(editorCode, /const doTrash = useCallback/, /\n  \}, \[/)))
check('切换 / 关闭仓库时清空预览态与 LRU 记账',
  /previewRelRef\.current = null/.test(sliceBetween(editorCode, /const enterWorkspace = useCallback/, /\n  \}, \[/))
  && /tabLruRef\.current = \[\]/.test(sliceBetween(editorCode, /const enterWorkspace = useCallback/, /\n  \}, \[/)))

/* ==================================================================
   九、负向：旧策略的痕迹必须清零
   ================================================================== */

const FORBIDDEN_OLD = [
  ['旧策略注释「切走即回收」', /切走即回收/],
  ['只有未保存才驻留的过滤', /isDirtyDoc\(openFiles\[rel\]\)/],
  ['pruneCleanNonActive（整段）', /pruneCleanNonActive/],
  ['旧落点「取最右标签」', /keys\[keys\.length - 1\]/],
  ['批量关闭的二次确认框（本项不做）', /closeBulkTarget|批量关闭确认/],
]
for (const [name, re] of FORBIDDEN_OLD) {
  check(`旧策略清零：${name}`, !re.test(editorCode))
}

/* ------------------------------------------------------------------ 汇总 */
const failed = checks.filter((c) => !c.pass)
console.log('\n=== verify-tab-preview ===')
console.log(`真实执行: tabPolicy.ts（previewReplacement / pickTabsToEvict / nextTabInCycle / landingAfterClose）`)
console.log(`静态断言: src/modules/editor/index.tsx + types.ts（剥注释）`)
console.log(`断言: ${checks.length - failed.length} PASS / ${failed.length} FAIL（共 ${checks.length}）\n`)
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  → ' + c.detail : ''}`)
}
if (failed.length) {
  console.log(`\nFAILED: ${failed.map((c) => c.name).join(' | ')}`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
