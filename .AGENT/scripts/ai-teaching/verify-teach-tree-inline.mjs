/**
 * 契约：教学区文件树的新建 / 重命名 = 条目内联输入（2026-09-22 B-14）
 *
 * 锁三件事：
 *   ① **同一动作只有一种长相** —— 「新建文件 / 新建文件夹 / 重命名」在知识库与教学区必须走
 *      **同一套内联输入行**（VaultTree 的受控 `creating` / `renaming`）。
 *      教学区原持一套居中弹窗（`fixed inset-0 z-[90]`），同一动作两处两种长相、两套 Esc/失焦语义。
 *   ② **落点目录必须先展开** —— 内联行渲染在目录子级里，目标目录收着时输入框**根本不可见**，
 *      表象是「右键点了『新建文件』没反应」（知识库 B-13 踩过同一个坑）。这是本契约最容易被改回去的一行。
 *   ③ **共享树的内联机制是本契约的公共底座** —— 若有人删掉 VaultTree 的 InlineCreateRow/InlineRenameRow，
 *      两个消费方会**静默**退回「没有输入框」，所以这里对共享侧也做正向 + 行为断言。
 *
 * 为什么不用探针：本改动是三处源码之间的接线一致性（教学区 ↔ 共享树 ↔ 知识库），
 *   而运行时要复现「右键 → 内联框出现」得先造出 AI 教学产物根内容，成本高、且探针只能覆盖两个消费方中的一个。
 *   源码契约 CI 可跑、覆盖全部三处；DOM 侧的真机验证另见 `.AGENT/scripts/workbench-shell/probes/`。
 *
 * 跑法：node --experimental-strip-types .AGENT/scripts/ai-teaching/verify-teach-tree-inline.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => stripComments(readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n'))

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(detail ? `${label}\n      ${detail}` : label)
  return false
}

const TEACH = read('src/modules/ai-teaching/AiTeachFileTree.tsx')
const TREE = read('src/components/shared/VaultTree.tsx')
const KNOW = read('src/modules/knowledge/index.tsx')

/* ================= A. 教学区：居中弹窗整体退场 ================= */
console.log('\n=== A. 教学区不再持居中弹窗（B-14 的主诉） ===\n')

// 负向：逐条列出「弹窗时代」才有的标识，任一条复活 = 又出现了两套长相
const MODAL_MARKERS = [
  ['InputModal 类型', /\bInputModal\b/],
  ['nameModal 工厂', /\bnameModal\b/],
  ['modalValue 受控值', /\bmodalValue\b/],
  ['setModal 通道', /\bsetModal\b/],
  ['z-[90] 居中弹窗层', /z-\[90\]/],
  ['居中弹窗容器', /fixed inset-0 z-\[90\] flex items-center justify-center/],
]
const revived = MODAL_MARKERS.filter(([, re]) => re.test(TEACH)).map(([n]) => n)
ok(revived.length === 0,
  'A1 ★ 负向：教学区文件树内零弹窗残留（InputModal / nameModal / modalValue / setModal / z-[90]）',
  revived.length ? '复活：' + revived.join('、') : '')

// 负向：教学区树里不得自己渲染 input —— 输入框的唯一来源必须是共享树的内联行
ok(!/<input\b/.test(TEACH),
  'A2 ★ 负向：教学区树内零 `<input>`（新建/重命名的输入框只能来自共享树，自己写一个 = 又分叉）',
  '')
ok(!/autoFocus/.test(TEACH),
  'A3 负向：不再有 `autoFocus` 一次性输入（弹窗式手法的残留）', '')

/* ================= B. 教学区：6 个受控 props 接线齐全 ================= */
console.log('\n=== B. 教学区 → VaultTree 的内联接线 ===\n')

ok(/import type \{[^}]*\bCreateIntent\b[^}]*\bRenameIntent\b[^}]*\} from '\.\.\/\.\.\/components\/shared\/VaultTree'/.test(TEACH),
  'B1 从共享树引入 CreateIntent / RenameIntent 类型（意图类型的唯一来源）', '')
ok(/useState<CreateIntent \| null>\(null\)/.test(TEACH) && /useState<RenameIntent \| null>\(null\)/.test(TEACH),
  'B2 组件持有 `creating` / `renaming` 两个受控意图 state', '')

const PROPS = [
  ['creating={creating}', /creating=\{creating\}/],
  ['onCommitCreate', /onCommitCreate=\{/],
  ['onCancelCreate', /onCancelCreate=\{/],
  ['renaming={renaming}', /renaming=\{renaming\}/],
  ['onCommitRename', /onCommitRename=\{/],
  ['onCancelRename', /onCancelRename=\{/],
]
const missingProps = PROPS.filter(([, re]) => !re.test(TEACH)).map(([n]) => n)
ok(missingProps.length === 0,
  'B3 ★ 六个内联 props 全部接到 VaultTree（缺任一个 → 那一半动作静默失效）',
  missingProps.length ? '缺：' + missingProps.join('、') : '')

ok(/commitCreate\(dirRel, type as 'file' \| 'dir', rawName\)/.test(TEACH) && /commitRename\(relPath, rawName\)/.test(TEACH),
  'B4 提交回调确有实现（不是空壳接线）', '')
ok(/const commitCreate = async \(dirRel: string, type: 'file' \| 'dir', rawName: string\)/.test(TEACH) &&
   /const commitRename = async \(relPath: string, rawName: string\)/.test(TEACH),
  'B5 commitCreate / commitRename 签名与树回调对齐（dirRel + type / relPath）', '')
ok(/onCancelCreate=\{\(\) => setCreating\(null\)\}/.test(TEACH) && /onCancelRename=\{\(\) => setRenaming\(null\)\}/.test(TEACH),
  'B6 Esc / 失焦取消 = 只清意图、不写盘（与知识库同一收口）', '')

/* ================= C. 落点目录展开（「点了没反应」的防回归） ================= */
console.log('\n=== C. 落点目录必须先展开 ===\n')

// 精确语句而非「函数体里出现过 setExpanded」——宽松窗口会匹配到后续函数的 setExpanded（假通过）
ok(/const doCreate = \(dirRel: string, type: 'file' \| 'dir'\) => \{\s*\n\s*if \(dirRel\) setExpanded\(prev => \(prev\.has\(dirRel\) \? prev : new Set\(prev\)\.add\(dirRel\)\)\)\s*\n\s*setCreating\(\{ dirRel, type \}\)/.test(TEACH),
  'C1 ★ doCreate 先展开落点目录、再落创建意图（收着的目录里内联行不可见 = 「点了没反应」）', '')
ok(/const startRename = \(n: TreeNode\) => setRenaming\(\{ relPath: n\.relPath \}\)/.test(TEACH),
  'C2 重命名入口只落意图（条目本就可见才右键得到，无需展开）', '')
ok(/run: \(\) => startRename\(node\)/.test(TEACH),
  'C3 右键菜单「重命名」指向 startRename（不是残留的旧函数）', '')
ok(!/\bdoRename\b/.test(TEACH),
  'C4 负向：旧的一次性 doRename（弹窗提交版）已无残留', '')

/* ================= D. 空态让位（产物根为空时点「新建文件夹」） ================= */
console.log('\n=== D. 空态与内联行不互斥 ===\n')

ok(/\(dirCache\[''\] \?\? \[\]\)\.length === 0 && !creating \?/.test(TEACH),
  'D1 ★ 产物根为空但正在新建时，空态让位给树（否则输入框无处渲染）', '')
ok(/onClick=\{\(\) => doCreate\('', 'dir'\)\}/.test(TEACH),
  'D2 空态里的「＋ 新建文件夹」仍走同一入口', '')

/* ================= E. 共享底座：内联行本体必须还在且行为一致 ================= */
console.log('\n=== E. VaultTree 内联机制（本契约的公共底座） ===\n')

ok(/export interface CreateIntent \{[\s\S]{0,200}\}/.test(TREE) && /export interface RenameIntent \{[\s\S]{0,80}\}/.test(TREE),
  'E1 CreateIntent / RenameIntent 仍是导出类型', '')
ok(/creating\?: CreateIntent \| null/.test(TREE) && /renaming\?: RenameIntent \| null/.test(TREE),
  'E2 两个意图 props 受控（宿主持有状态、树不持态）', '')
ok(/<InlineCreateRow/.test(TREE) && /<InlineRenameRow/.test(TREE),
  'E3 ★ InlineCreateRow / InlineRenameRow 仍在（删掉 → 两个消费方静默失去输入框）', '')
// 行为锚点：Esc 取消 + 失焦取消（B-14 验收口径「与笔记区一致」就是这两条）
const escCount = (TREE.match(/if \(e\.key === 'Escape'\) cancel\(\)/g) ?? []).length
const blurCount = (TREE.match(/onBlur=\{\(\) => cancel\(\)\}/g) ?? []).length
ok(escCount >= 2 && blurCount >= 2,
  'E4 ★ 两个内联行都保持「Enter 提交 / Esc 取消 / 失焦取消」（B-14 验收口径的行为锚点）',
  `Esc=${escCount} 失焦=${blurCount}（各应 ≥2）`)
ok((TREE.match(/onKeyDown=\{\(e\) => \{[\s\S]{0,120}if \(e\.key === 'Enter'\) commit\(\)/g) ?? []).length >= 2,
  'E5 两个内联行都保持 Enter 提交', '')

/* ================= F. 两个消费方同源（一致性=本契约的立意） ================= */
console.log('\n=== F. 知识库与教学区消费同一套 props ===\n')

ok(/creating=\{treeCreating\}/.test(KNOW) && /renaming=\{treeRenaming\}/.test(KNOW),
  'F1 知识库仍传 creating / renaming（教学区不是在跟一个已废弃的接口对齐）', '')
ok(/onCommitCreate=\{handleTreeCommitCreate\}/.test(KNOW) && /onCommitRename=\{/.test(KNOW),
  'F2 知识库两个提交回调仍在', '')
ok(!/z-\[90\]/.test(KNOW),
  'F3 负向：知识库侧同样无居中弹窗（B-13 已删，别被"顺手加回"）', '')

/* ================= 结果 ================= */
if (fails.length === 0) {
  console.log(`\nPASS  ${pass} 项断言全绿`)
  process.exit(0)
} else {
  console.log(`\nFAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
