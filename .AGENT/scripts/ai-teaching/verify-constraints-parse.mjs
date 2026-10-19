#!/usr/bin/env node
/**
 * 契约验证：AI教学「要求」文档条目化纯函数（`src/modules/ai-teaching/constraintsParse.ts`）
 * 方案：`E:\Projects\KnowledgeRecorder\.AGENT\.claude\plans\ai-teaching-flow-v2-impl.md` §五 verify-constraints-parse
 *
 * ★ 本脚本**只读不改**该模块（模块由渲染层那条线维护，这里只当契约方）。
 * 断言口径（全部跑真实实现，strip 类型后直接 import）：
 *   · 条目化往返（parse ⇄ serialize）；
 *   · **非条目行逐字保留**（负向：加一条 / 删一条后，标题与说明段落一字不差）；
 *   · 越界 index 不抛错、不改文本；
 *   · CRLF 输入不崩（归一为 LF，条目仍可解析）；
 *   · 空文本 / 无条目文档 / 无尾换行 三类边界。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-constraints-parse.mjs [仓库路径]
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

const REL = 'src/modules/ai-teaching/constraintsParse.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'constraints-parse-'))
const tmpFile = path.join(tmpDir, 'constraintsParse.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const { parseConstraintItems, serializeConstraintItems, applyConstraintEdits } = await import(pathToFileURL(tmpFile).href)

/** 非条目行（标题 / 说明段 / 空行）逐字对比用：把条目行整行剔掉再比 */
const ITEM_RE = /^(\s*)-\s+(.*\S)\s*$/
const nonItemLines = (text) => String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => !ITEM_RE.test(l)).join('\n')

const DOC = [
  '# 工作区要求（本工作区所有会话每轮自动遵循）',
  '',
  '在这里写本课程/主题的共同要求，例如：',
  '- 讲解尽量控制在 10 分钟能读完',
  '- 代码示例统一用 TypeScript',
  '',
  '优先级：用户当下消息 > 本会话要求 > 工作区要求 > 全局要求。',
  '',
].join('\n')

console.log('\n=== 1. parseConstraintItems：条目化 + 行号 ===')
const items = parseConstraintItems(DOC)
check('抽出 2 条条目', items.length === 2, JSON.stringify(items))
check('条目文本去 `- ` 与首尾空白', items[0]?.text === '讲解尽量控制在 10 分钟能读完' && items[1]?.text === '代码示例统一用 TypeScript', JSON.stringify(items))
check('line 是原文 0 基行号', items[0]?.line === 3 && items[1]?.line === 4, JSON.stringify(items.map((x) => x.line)))
check('标题 / 说明段 / 空行不进条目', !items.some((x) => x.text.includes('工作区要求（') || x.text.includes('优先级：')), '')
check('空文本 → 空数组', parseConstraintItems('').length === 0, '')
check('无条目文档 → 空数组', parseConstraintItems('# 只有标题\n\n一句说明\n').length === 0, '')
check('裸 `-` / `- ` 不算条目（负向）', parseConstraintItems('- \n-  \n- x').length === 1, JSON.stringify(parseConstraintItems('- \n-  \n- x')))
check('CRLF 输入行号正确、不崩', (() => { const r = parseConstraintItems(DOC.replace(/\n/g, '\r\n')); return r.length === 2 && r[0].line === 3 })(), '')

console.log('\n=== 2. serializeConstraintItems：序列化与往返 ===')
check('序列化为 `- ` 逐行 + 尾换行', serializeConstraintItems(['甲', '乙']) === '- 甲\n- 乙\n', JSON.stringify(serializeConstraintItems(['甲', '乙'])))
check('空数组 → 空串', serializeConstraintItems([]) === '', JSON.stringify(serializeConstraintItems([])))
check('条目内空白折叠', serializeConstraintItems(['  甲   乙  ']) === '- 甲 乙\n', JSON.stringify(serializeConstraintItems(['  甲   乙  '])))
const round = parseConstraintItems(serializeConstraintItems(['甲 一', '乙 二', '丙 三']))
check('serialize → parse 往返等值', round.length === 3 && round.map((x) => x.text).join('|') === '甲 一|乙 二|丙 三', JSON.stringify(round))

console.log('\n=== 3. applyConstraintEdits：加一条（非条目行逐字保留，负向）===')
const added = applyConstraintEdits(DOC, [{ op: 'add', text: '每节课结尾附 3 道自测题' }])
check('加条目后条目数 3', parseConstraintItems(added).length === 3, String(parseConstraintItems(added).length))
check('新条目内容正确', parseConstraintItems(added)[2]?.text === '每节课结尾附 3 道自测题', JSON.stringify(parseConstraintItems(added)[2]))
check('★ 非条目行逐字保留（标题/说明段/优先级段一字不差）', nonItemLines(added) === nonItemLines(DOC), JSON.stringify(nonItemLines(added)))
check('标题行原样在（含全角括号）', added.includes('# 工作区要求（本工作区所有会话每轮自动遵循）'), '')
check('优先级段原样在', added.includes('优先级：用户当下消息 > 本会话要求 > 工作区要求 > 全局要求。'), '')
check('只多了一行（行数 +1）', added.split('\n').length === DOC.split('\n').length + 1, `${added.split('\n').length} vs ${DOC.split('\n').length}`)
check('空文本加条目 → 只有该条目', applyConstraintEdits('', [{ op: 'add', text: '甲' }]) === '- 甲\n', JSON.stringify(applyConstraintEdits('', [{ op: 'add', text: '甲' }])))
check('空白条目被忽略（无副作用）', applyConstraintEdits(DOC, [{ op: 'add', text: '   ' }]) === DOC, '')

console.log('\n=== 4. applyConstraintEdits：删一条 / 改一条（非条目行逐字保留，负向）===')
const removed = applyConstraintEdits(DOC, [{ op: 'remove', index: 0 }])
check('删除后仅剩 1 条且是第二条', parseConstraintItems(removed).length === 1 && parseConstraintItems(removed)[0].text === '代码示例统一用 TypeScript', JSON.stringify(parseConstraintItems(removed)))
check('★ 删条目后非条目行逐字保留', nonItemLines(removed) === nonItemLines(DOC), '')
check('删条目后行数 -1', removed.split('\n').length === DOC.split('\n').length - 1, String(removed.split('\n').length))
const updated = applyConstraintEdits(DOC, [{ op: 'update', index: 1, text: '代码示例统一用 TypeScript 5' }])
check('修改后第二条文本已换、第一条不动', parseConstraintItems(updated).map((x) => x.text).join('|') === '讲解尽量控制在 10 分钟能读完|代码示例统一用 TypeScript 5', JSON.stringify(parseConstraintItems(updated)))
check('★ 改条目后非条目行逐字保留', nonItemLines(updated) === nonItemLines(DOC), '')
const indented = applyConstraintEdits('说明\n  - 缩进条目\n', [{ op: 'update', index: 0, text: '换过' }])
// 模块既有语义（`ITEM_RE.exec(...)[1].replace(/\s+$/, '')`）：update 会把缩进条目**归一为顶格**。
// 这条与主进程 `aiTeachingScope.countConstraintItems`（只数顶格 `- ` 行）是同一口径 —— 编辑器写过的条目恒顶格；
// 仅当用户手写缩进且从不经界面 update 时，parse 认它而计数不认它（已在交付说明里记为已知边界）。
check('update 时缩进条目归一为顶格（与主进程计数口径一致）', indented === '说明\n- 换过\n', JSON.stringify(indented))
const twoEdits = applyConstraintEdits(DOC, [{ op: 'remove', index: 0 }, { op: 'add', text: '追加的一条' }])
check('多条编辑逐步应用（下标按上一步结果）', parseConstraintItems(twoEdits).map((x) => x.text).join('|') === '代码示例统一用 TypeScript|追加的一条', JSON.stringify(parseConstraintItems(twoEdits)))

console.log('\n=== 5. 越界 / 非法编辑：不抛错、不改文本 ===')
let threw = false
let outOfRange = ''
try { outOfRange = applyConstraintEdits(DOC, [{ op: 'remove', index: 99 }]) } catch { threw = true }
check('越界 remove 不抛错', !threw, '')
check('越界 remove 文本不变（负向）', outOfRange === DOC, JSON.stringify(outOfRange.slice(0, 60)))
let threw2 = false
let neg = ''
try { neg = applyConstraintEdits(DOC, [{ op: 'update', index: -1, text: 'x' }]) } catch { threw2 = true }
check('负数 index 不抛错也不改文本', !threw2 && neg === DOC, '')
check('空编辑数组 → 原样返回', applyConstraintEdits(DOC, []) === DOC, '')
check('越界 index 在空文档上也不抛错', applyConstraintEdits('', [{ op: 'remove', index: 0 }]) === '', '')

console.log('\n=== 6. CRLF / 尾换行 边界 ===')
const crlf = DOC.replace(/\n/g, '\r\n')
const crlfAdded = applyConstraintEdits(crlf, [{ op: 'add', text: 'CRLF 里加一条' }])
check('CRLF 输入不崩且条目可解析', parseConstraintItems(crlfAdded).length === 3, String(parseConstraintItems(crlfAdded).length))
check('CRLF 输出已归一（无 \\r 残留）', !crlfAdded.includes('\r'), '')
check('CRLF 下非条目行逐字保留（按归一后比）', nonItemLines(crlfAdded) === nonItemLines(DOC), '')
const noTrailing = DOC.replace(/\n$/, '')
check('无尾换行：编辑后仍无尾换行（不凭空补 \\n）', !applyConstraintEdits(noTrailing, [{ op: 'update', index: 0, text: '甲' }]).endsWith('\n'), '')
check('有尾换行：编辑后仍有尾换行', applyConstraintEdits(DOC, [{ op: 'update', index: 0, text: '甲' }]).endsWith('\n'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
