/**
 * 契约：左栏文件树的「新建」通道族（B-7 头部「＋」+ B-13 统一命名机制）
 *
 * 锁三件事：
 *   ① **创建通道唯一** —— 「新建分类目录」原来的居中浮层整条通道（`catDraft`）不得复活。
 *      它是 B-13 的成因：同一件事（新建分类目录）存在两条创建路径，改一处漏一处。
 *      判定用**全 src 剥注释后零命中**，不是只看 knowledge/index.tsx。
 *   ② **命名统一为树内联** —— 四种条目类型（file / dir / knowledge / category）都必须由
 *      VaultTree 的 InlineCreateRow 承接；category 是后并入的，最容易漏图标/占位符。
 *   ③ **落点唯一真相源** —— 头部「＋」与 Ctrl+N 共用 `treeLandDir()`；且「＋」的显隐口径
 *      与聚焦按钮一致（非知识库形态 / 选中空间 / 图谱态均不渲染）。
 *
 * 跑法：node --experimental-strip-types --no-warnings .AGENT/scripts/notes-merge/verify-tree-create-channels.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => stripComments(readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n'))

const SRC_TREE = read('src/components/shared/VaultTree.tsx')
const SRC_KNOW = read('src/modules/knowledge/index.tsx')
const SRC_BTN = read('src/components/shared/TreeNewButton.tsx')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(detail ? `${label}\n      ${detail}` : label)
  return false
}

console.log('=== A. 创建通道唯一（B-13：居中浮层不得复活） ===\n')

// A1 ★ 全 src 零命中 catDraft —— 这是本契约的主断言
const srcFiles = walkSourceFiles(join(repo, 'src'), { skip: (p) => p.includes('vendor') })
const catDraftHits = []
for (const f of srcFiles) {
  const body = stripComments(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
  if (/\bcatDraft\b/.test(body)) catDraftHits.push(f.slice(repo.length + 1))
}
ok(catDraftHits.length === 0,
  'A1 ★ 全 src 剥注释后无 `catDraft` 残留（居中浮层通道已整体删除，不得复活）',
  catDraftHits.length ? '命中：' + catDraftHits.join('、') : '')

ok(srcFiles.length > 100,
  'A1b 源码遍历有效（防 skip 写错导致"空集假通过"）',
  `实际扫到 ${srcFiles.length} 个文件`)

// A2 分类目录恒落根层：两个入口都必须给出 dirRel: ''
const catEntryHits = [...SRC_KNOW.matchAll(/setTreeCreating\(\{\s*dirRel:\s*'',\s*type:\s*'category'\s*\}\)/g)].length
ok(catEntryHits >= 2,
  'A2 ★ 两个入口（头部「＋」菜单 / 左栏右键菜单）都落 `setTreeCreating({ dirRel: \'\', type: \'category\' })`',
  `命中 ${catEntryHits} 处（应 ≥2：handleTreeNewPick + treeMenu 按钮）`)

// A3 提交侧不再自己收输入框
ok(!/setCatDraft/.test(SRC_KNOW),
  'A3 handleCommitCategory 不再调用 setCatDraft（收输入行交给树内联机制统一负责）', '')

// A4 category 分流必须先于 ensureVaultRoot：分类目录不走 vault 写通道，也不接受 dirRel
const iCatBranch = SRC_KNOW.indexOf("if (type === 'category') { await handleCommitCategory(name); return }")
const iEnsure = SRC_KNOW.indexOf('await ensureVaultRoot()', iCatBranch >= 0 ? iCatBranch : 0)
ok(iCatBranch >= 0 && iEnsure > iCatBranch,
  'A4 ★ category 分流在 ensureVaultRoot **之前**（免掉一次无用的根解析）', '')

console.log('\n=== B. 命名统一为树内联（四种类型齐备） ===\n')

ok(/export type CreateType = 'file' \| 'dir' \| 'knowledge' \| 'category'/.test(SRC_TREE),
  'B1 CreateType 四态齐备（category 已并入，不再另开类型）', '')
ok(/type === 'category'/.test(SRC_TREE) && /FolderTree/.test(SRC_TREE),
  'B2 InlineCreateRow 对 category 有专属图标（FolderTree，与「＋」菜单项/侧栏页签同源）', '')
ok(/type === 'category' \? '分类名称…'/.test(SRC_TREE),
  'B3 category 有专属占位符「分类名称…」（否则会退化成「名称…」，用户不知道在填什么）', '')
ok(/onCommitCreate\?: \(dirRel: string, type: CreateType, rawName: string\)/.test(SRC_TREE),
  'B4 onCommitCreate 签名用 CreateType（四处字面量并作一处，避免新增类型时漏改）', '')

console.log('\n=== C. 落点唯一真相源 + 「＋」显隐口径（B-7） ===\n')

const landUses = [...SRC_KNOW.matchAll(/treeLandDir\(\)/g)].length
ok(landUses >= 2,
  'C1 ★ `treeLandDir()` 是「＋」与 Ctrl+N 共用的唯一落点来源（≥2 处调用）',
  `实际 ${landUses} 处`)
ok(!/setTreeCreating\(\{\s*dirRel:\s*'',\s*type:\s*'knowledge'\s*\}\)/.test(SRC_KNOW),
  "C2 ★ 负向：Ctrl+N 不得退回硬编码 dirRel:''（那会让「选中目录」对该快捷键静默失效）", '')
ok(/const treeLandDir = useCallback\(\(\) => selectedDirRelRef\.current \?\? '', \[\]\)/.test(SRC_KNOW),
  'C3 treeLandDir 读 ref 且 deps 为空（恒等稳定，才能被模块级快捷键 effect 安全依赖）', '')

ok(/selectedPath\?: string \| null/.test(SRC_TREE) && /onSelectDir\?: \(dirRel: string\) => void/.test(SRC_TREE),
  'C4 VaultTree 的选中 props 均为 optional（编辑器侧文件树不传即零改动零回归）', '')
ok(/data-wb="treeDirSelected"/.test(SRC_TREE),
  'C5 选中目录有探针锚点（方案 A：左缘竖条）', '')
{
  // 取选中态那段 JSX 的局部切片再断言（全文件搜索会把别的行也算进来 = 假通过）
  const iSel = SRC_TREE.indexOf('selectedPath === relPath')
  const selBlock = iSel >= 0 ? SRC_TREE.slice(iSel, iSel + 400) : ''
  ok(/left-\[1px\]/.test(selBlock) && /bg-\[var\(--accent\)\]/.test(selBlock) && !/bg-\[var\(--bg-selected\)\]/.test(selBlock),
    'C6 选中态是左缘强调色竖条、**不铺** --bg-selected 底色（蓝底已被「正在看」占用，同底色两义会互相误读）',
    iSel < 0 ? '未找到 selectedPath === relPath' : '')
}

const iPlus = SRC_KNOW.indexOf('<TreeNewButton')
const plusLine = iPlus >= 0 ? SRC_KNOW.slice(Math.max(0, iPlus - 400), iPlus) : ''
ok(/sidebarVariant === 'knowledge' && !selectedSpaceId && !graphMode/.test(plusLine),
  'C7 ★ 「＋」与聚焦按钮同显隐口径（非知识库形态 / 选中空间 / 图谱态都不渲染）', '')
ok(/data-wb="treeNewBtn"/.test(SRC_BTN) && /data-wb=\{`treeNewItem-\$\{it\.key\}`\}/.test(SRC_BTN),
  'C8 「＋」按钮与菜单项有探针锚点（新增按钮会进头部动作槽，探针需可断言）', '')

// C9 落点目录收着时输入行不可见 —— 必须强制展开，否则表象是「点＋没反应」
ok(/setExpandedDirs\(\(prev\) => \(prev\.has\(dirRel\) \? prev : new Set\(prev\)\.add\(dirRel\)\)\)/.test(SRC_KNOW),
  'C9 ★ 进内联输入前强制展开落点目录（目录收着时输入行渲染在收起子树里 = 看起来没反应）', '')

console.log('\n' + '='.repeat(40))
if (fails.length === 0) {
  console.log(`PASS  ${pass} 项断言全绿`)
  process.exit(0)
} else {
  console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
