/**
 * 知识库写工具「目标目录」解析契约（v3.15.2）。
 *
 * 锁定这次修复的三类失败模式：
 *  · 空目录 / 普通磁盘目录不在分类索引里 → 旧实现报「未找到分类」；
 *  · 学习空间根被 `categoryType !== 'space'` 写死拒绝；
 *  · 同名分类静默取第一个 → 页面落到错误空间。
 * 另外锁暂存前置：解析必须在 handler 暂存前发生（失败当场回给模型），
 * 以及应用期优先使用暂存解析结果、目录被删则明确失败。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-knowledge-target.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeDirRel, resolveKnowledgeTargetPure } from '../../../electron/lib/knowledgeTargetPure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}
function expectThrow(fn, label, contains = '') {
  try {
    fn()
    return ok(false, label, '未抛错')
  } catch (err) {
    const msg = String(err?.message ?? err)
    return ok(!contains || msg.includes(contains), label, msg)
  }
}

const cats = [
  { id: 'space', name: '感悟与心得', parentId: null, categoryType: 'space', path: '感悟与心得' },
  { id: 'folder', name: '高数', parentId: null, categoryType: 'folder', path: '学习空间/高数' },
  { id: 'dup-top', name: '同名', parentId: null, categoryType: 'folder', path: '同名' },
  { id: 'dup-nested', name: '同名', parentId: 'x', categoryType: 'folder', path: '空间/同名' },
  { id: 'notebook', name: '专有', parentId: 'x', categoryType: 'notebook', path: '学习空间/专有' },
]
const dirs = new Set(['空目录', '学习空间/高数', '空间/同名', '学习空间/专有', '同名'])
const exists = (rel) => dirs.has(rel)
const resolve = (args) => resolveKnowledgeTargetPure(args, cats, exists)

console.log('=== A. categoryName：分类 / 空间根 / 空目录 ===')
{
  ok(resolve({ categoryName: '感悟与心得' }).categoryId === 'space', 'A1 学习空间根可作为建页目标')
  ok(resolve({ categoryName: '高数' }).categoryId === 'folder', 'A2 普通分类名精确命中')
  const empty = resolve({ categoryName: '空目录' })
  ok(empty.categoryId === null && empty.dirRel === '空目录', 'A3 空目录（不在分类索引）走磁盘兜底')
  const top = resolve({ categoryName: '同名' })
  ok(top.categoryId === 'dup-top', 'A4 同名歧义优先唯一顶层节点')
  ok(resolve({ categoryName: '专有' }).categoryId === 'notebook', 'A5 notebook 可作为目标')
  expectThrow(() => resolve({ categoryName: '不存在' }), 'A6 分类名与磁盘目录都不存在 → 明确报错', '未找到分类')
}

console.log('\n=== B. categoryPath：路径优先 ===')
{
  ok(resolve({ categoryPath: '学习空间/高数' }).categoryId === 'folder', 'B1 路径命中分类 → categoryId')
  const empty = resolve({ categoryPath: '空目录' })
  ok(empty.categoryId === null && empty.dirRel === '空目录', 'B2 路径命中空目录 → dirRel')
  expectThrow(() => resolve({ categoryPath: '不存在/目录' }), 'B3 路径不存在 → 明确报错', '目录不存在')
  expectThrow(() => resolve({ categoryPath: '../etc' }), 'B4 路径穿越被拒', '目录路径非法')
  expectThrow(() => resolve({ categoryPath: '/etc' }), 'B5 绝对路径被拒', '目录路径非法')
  expectThrow(() => resolve({ categoryPath: 'C:/x' }), 'B6 盘符路径被拒', '目录路径非法')
  expectThrow(() => resolve({ categoryPath: '.knowbase' }), 'B7 隐藏目录被拒', '目录路径非法')
}

console.log('\n=== C. 应用期：暂存结果优先并重新校验 ===')
{
  ok(resolve({ categoryId: 'space' }).categoryId === 'space', 'C1 已解析 categoryId 直接使用')
  ok(resolve({ dirRel: '空目录' }).dirRel === '空目录', 'C2 已解析 dirRel 直接使用')
  expectThrow(() => resolve({ categoryId: 'gone' }), 'C3 分类已被删 → 明确报错', '目标分类已不存在')
  expectThrow(() => resolve({ dirRel: '已删除' }), 'C4 目录已被删 → 明确报错', '目标目录已不存在')
  expectThrow(() => resolve({ dirRel: '../x' }), 'C5 暂存目录非法 → 明确报错', '目标目录非法')
}

console.log('\n=== D. 未指定目标 = 未分类收件箱 ===')
{
  const t = resolve({})
  ok(t.categoryId === null && t.dirRel === null && t.display === '未分类', 'D1 省略 categoryName/categoryPath → 收件箱')
}

console.log('\n=== E. normalizeDirRel ===')
{
  ok(normalizeDirRel('学习空间\\高数\\') === '学习空间/高数', 'E1 反斜杠与尾斜杠归一')
  ok(normalizeDirRel('  感悟与心得  ') === '感悟与心得', 'E2 首尾空白归一')
  ok(normalizeDirRel('') === null, 'E3 空串拒绝')
  ok(normalizeDirRel('a//b') === null, 'E4 空段拒绝')
  ok(normalizeDirRel('a/./b') === null, 'E5 点段拒绝')
}

console.log('\n=== F. 源码接线 ===')
{
  const bt = read('electron/lib/builtinTools.ts')
  const repo = read('electron/lib/kbStore/knowledgeVaultRepo.ts')
  const stageable = read('electron/lib/aiAssistantStageable.ts')
  ok(/resolveKnowledgeTargetPure/.test(bt) && /vaultDirExists/.test(bt), 'F1 builtinTools 走纯解析器 + 磁盘存在检查')
  ok(!/categoryType !== 'space'/.test(bt), 'F2 不再写死拒绝学习空间根')
  const createBlock = bt.slice(bt.indexOf("name: 'builtin.knowledge.create-page'"), bt.indexOf("name: 'builtin.blog.create-entry'"))
  ok(/stageToolOp\(ctx/.test(createBlock) && /resolveKnowledgeTarget\(args\)/.test(createBlock),
    'F3 create-page 在暂存前解析目标')
  const paperBlock = bt.slice(bt.indexOf("name: 'builtin.quiz.gen-paper'"), bt.indexOf("// ===== 书市工具"))
  ok(/stageToolOp\(ctx/.test(paperBlock) && /resolveKnowledgeTarget\(args\)/.test(paperBlock),
    'F4 gen-paper 在暂存前解析目标')
  ok(/HANDLER_STAGED_DATA_TOOLS/.test(stageable) && /builtin\.knowledge\.create-page/.test(stageable),
    'F5 建页 / 组卷登记为 handler 自暂存')
  ok(/export function vaultDirExists/.test(repo) && /dirRel\?: string \| null/.test(repo),
    'F6 vault 层支持 dirRel 与目录存在检查')
}

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
