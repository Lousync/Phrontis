#!/usr/bin/env node
/**
 * 契约验证：AI 教学「上下文编译器」纯函数（`electron/lib/contextCompilerPure.ts`）
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/Phrontis-AI教学-技术方案-2026-11-19.md` §2.7 / §9
 *      `/home/lousync/Projects/DesginProcess/Phrontis/方案与调研/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` A4 / §5.2 / §5.5
 *
 * 锁什么：CONSTRAINTS.md 节语义（hard / soft、散条目归 hard、三种条目写法、HTML 注释）、
 *         三层去重取最细、条数 / 字符截断、块顺序与空块跳过、预算丢弃顺序与 truncated 名单。
 *
 * 运行（仓库根目录）：node .AGENT/scripts/ai-teaching/verify-context-compiler.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
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
const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const REL = 'electron/lib/contextCompilerPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-compiler-'))
const tmpFile = path.join(tmpDir, 'contextCompilerPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const {
  parseConstraintSections,
  compileScopeLayers,
  compileContextBlocks,
  CONTEXT_SCOPE_MAX_ITEMS,
  CONTEXT_SCOPE_MAX_CHARS,
  CONTEXT_BLOCKS_BUDGET,
} = await import(pathToFileURL(tmpFile).href)

console.log('\n=== 1. parseConstraintSections：节语义 ===')
const DOC = [
  '# 本段要求',
  '',
  '## 必须',
  '- 只用中文回答',
  '* 每个公式给出适用条件',
  '1. 先结论再推导',
  '',
  '## 禁止',
  '- 不要直接给答案',
  '',
  '## 输出格式',
  '- 列表优先',
  '',
  '## 范围',
  '- 只考第 3 章',
  '',
  '## 偏好',
  '- 多举生活化例子',
  '',
].join('\n')
const parsed = parseConstraintSections(DOC)
check('硬节条目数 = 6（必须 3 + 禁止 1 + 输出格式 1 + 范围 1）', parsed.hard.length === 6, JSON.stringify(parsed.hard))
check('软节条目数 = 1（偏好）', parsed.soft.length === 1 && parsed.soft[0] === '多举生活化例子', JSON.stringify(parsed.soft))
check('`- ` / `* ` / `1. ` 三种写法都认', parsed.hard.includes('只用中文回答') && parsed.hard.includes('每个公式给出适用条件') && parsed.hard.includes('先结论再推导'), JSON.stringify(parsed.hard))
check('标题行不进条目', !parsed.hard.some((x) => x.includes('必须') || x.includes('禁止')), '')

const stray = parseConstraintSections('随手记一句\n- 散条目一\n\n## 备注\n- 备注里的条目\n')
check('★ 不在节内的散条目归 hard（保守）', stray.hard.includes('散条目一'), JSON.stringify(stray))
check('未知标题下的条目也归 hard', stray.hard.includes('备注里的条目'), JSON.stringify(stray))
check('非条目行忽略', !stray.hard.some((x) => x.includes('随手记一句')), JSON.stringify(stray))

const commented = parseConstraintSections('## 必须\n<!-- 这是说明\n- 被注释掉的条目\n-->\n- 真条目\n')
check('HTML 注释（含多行）被忽略', !commented.hard.some((x) => x.includes('被注释掉')) && commented.hard.includes('真条目'), JSON.stringify(commented))
check('空文本 → 两个空数组', (() => { const r = parseConstraintSections(''); return r.hard.length === 0 && r.soft.length === 0 })(), '')

console.log('\n=== 2. compileScopeLayers：三层去重取最细 ===')
const scope = compileScopeLayers({
  global: '## 必须\n- 只用中文\n- 逐步推导\n## 偏好\n- 多举例',
  course: '## 禁止\n- 跳过推导',
  lesson: '## 必须\n- 只用中文。',
})
check('同句跨层只保留一条', scope.hard.filter((x) => x.includes('只用中文')).length === 1, JSON.stringify(scope.hard))
check('去重文本取最细一层（lesson 的全角句号版本）', scope.hard[0] === '只用中文。', JSON.stringify(scope.hard))
check('顺序按 global → course → lesson 首次出现', eqJson(scope.hard, ['只用中文。', '逐步推导', '跳过推导']), JSON.stringify(scope.hard))
check('软偏好也合并', eqJson(scope.soft, ['多举例']), JSON.stringify(scope.soft))
check('layers 归属计数（global 1 hard + 1 soft / course 1 / lesson 1）', eqJson(scope.layers, [
  { layer: 'global', hard: 1, soft: 1 },
  { layer: 'course', hard: 1, soft: 0 },
  { layer: 'lesson', hard: 1, soft: 0 },
]), JSON.stringify(scope.layers))
check('未截断时 truncated=false', scope.truncated === false, '')

const spacing = compileScopeLayers({
  global: '## 必须\n- 只用 中文，',
  lesson: '## 必须\n- 只用中文',
})
check('忽略空白与全/半角尾标点差异（负向：不会重复）', spacing.hard.length === 1, JSON.stringify(spacing.hard))

console.log('\n=== 3. compileScopeLayers：截断 ===')
const thirteen = compileScopeLayers({
  global: `## 必须\n${Array.from({ length: 13 }, (_, i) => `- 条目${i + 1}`).join('\n')}`,
})
check('超条数按 maxItems=12 截断', thirteen.hard.length === 12 && thirteen.truncated === true, `${thirteen.hard.length}`)
check('截断保留前 12 条、丢弃第 13 条', !thirteen.hard.includes('条目13'), JSON.stringify(thirteen.hard.slice(-2)))

const longItems = `## 必须\n${Array.from({ length: 5 }, (_, i) => `- ${'a'.repeat(10)}${i}`).join('\n')}`
const charCut = compileScopeLayers({ global: longItems }, { maxChars: 25 })
check('超字符按 maxChars 截断（只算 hard）', charCut.hard.length === 2 && charCut.truncated === true, JSON.stringify(charCut.hard))
check('chars ≤ maxChars', charCut.chars <= 25, `${charCut.chars}`)
check('chars 与 hard 拼接长度同口径', charCut.chars === charCut.hard.join('\n').length, `${charCut.chars}`)

const customItems = compileScopeLayers({ global: longItems }, { maxItems: 1 })
check('maxItems 可覆盖（传 1 只留 1 条）', customItems.hard.length === 1 && customItems.truncated === true, JSON.stringify(customItems.hard))
check('默认常量 = 12 条 / 1200 字符', CONTEXT_SCOPE_MAX_ITEMS === 12 && CONTEXT_SCOPE_MAX_CHARS === 1200, `${CONTEXT_SCOPE_MAX_ITEMS}/${CONTEXT_SCOPE_MAX_CHARS}`)
check('全空输入 → 空 hard / soft，不截断', (() => { const r = compileScopeLayers({}); return r.hard.length === 0 && r.soft.length === 0 && r.truncated === false && r.chars === 0 })(), '')

console.log('\n=== 4. compileContextBlocks：顺序 / 空块 / 预算 ===')
const LAYER_ORDER = compileContextBlocks({
  profile: '学过 C 语言',
  scope,
  brief: '本段讲银行家算法',
  materials: '1. 教材 3.2 节',
  ledger: '已讲到第 2 步',
})
check('块顺序恒为 画像 → 要求 → 本段简报 → 素材清单 → 台账', eqJson(LAYER_ORDER.blocks.map((b) => b.name), ['画像', '要求', '本段简报', '素材清单', '台账']), JSON.stringify(LAYER_ORDER.blocks.map((b) => b.name)))
check('要求块含 hard 与 soft 两组', LAYER_ORDER.blocks.find((b) => b.name === '要求')?.text.includes('必须遵守：') && LAYER_ORDER.blocks.find((b) => b.name === '要求')?.text.includes('偏好：'), '')
check('chars = 各块字符数之和', LAYER_ORDER.blocks.reduce((n, b) => n + b.text.length, 0) === LAYER_ORDER.chars, `${LAYER_ORDER.chars}`)
check('未超预算时 truncated 为空', LAYER_ORDER.truncated.length === 0, JSON.stringify(LAYER_ORDER.truncated))

const sparse = compileContextBlocks({ profile: '  ', scope: compileScopeLayers({}), brief: '', materials: '素材', ledger: undefined })
check('空块跳过（只剩素材清单）', eqJson(sparse.blocks.map((b) => b.name), ['素材清单']), JSON.stringify(sparse.blocks))
check('全空 → 零块', compileContextBlocks({}).blocks.length === 0, '')

const budgeted = compileContextBlocks({
  profile: '画像文本',
  brief: '简报文本',
  materials: '素材文本',
  ledger: '台账文本',
  budgetChars: 8,
})
check('预算超限从最后一块开始丢（台账先丢）', eqJson(budgeted.truncated, ['台账', '素材清单']), JSON.stringify(budgeted.truncated))
check('丢到预算内后剩余块顺序不变', eqJson(budgeted.blocks.map((b) => b.name), ['画像', '本段简报']), JSON.stringify(budgeted.blocks))
check('丢弃后 chars ≤ 预算', budgeted.chars <= 8, `${budgeted.chars}`)
check('预算 = 默认 8000', CONTEXT_BLOCKS_BUDGET === 8000, String(CONTEXT_BLOCKS_BUDGET))
const tinyBudget = compileContextBlocks({ profile: '画像文本', budgetChars: 0 })
check('预算为 0 时全部丢弃、名单完整（边界）', tinyBudget.blocks.length === 0 && eqJson(tinyBudget.truncated, ['画像']) && tinyBudget.chars === 0, JSON.stringify(tinyBudget))

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
