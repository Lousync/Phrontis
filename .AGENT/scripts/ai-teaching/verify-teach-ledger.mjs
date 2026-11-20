#!/usr/bin/env node
/**
 * 契约验证：AI 教学「段内进度台账」纯函数（`electron/lib/teachLedgerPure.ts`）
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.8 / §9
 *      `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` E2
 *
 * 锁什么：teach 围栏解析容错（单引号 / 尾逗号 / 注释 / 全角引号 / 坏 JSON）、
 *         strip 不碰其它围栏、merge 幂等与 step 单调、terms 大小写去重、
 *         注入格式与超长截断、`### 标题` 兜底。
 *
 * 运行（仓库根目录）：node .AGENT/scripts/ai-teaching/verify-teach-ledger.mjs [仓库路径]
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

async function loadStripped(relPath, tmpName) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-teach-pure-'))
  const tmpFile = path.join(tmpDir, tmpName)
  fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
  const mod = await import(pathToFileURL(tmpFile).href)
  return { mod, tmpDir }
}

const { mod: ledger, tmpDir: ledgerTmp } = await loadStripped('electron/lib/teachLedgerPure.ts', 'teachLedgerPure.mjs')
const { mod: types, tmpDir: typesTmp } = await loadStripped('electron/lib/aiTeachingTypesPure.ts', 'aiTeachingTypesPure.mjs')
const {
  parseTeachFence,
  stripTeachFence,
  mergeLedger,
  renderLedgerForPrompt,
  ledgerFromHeadings,
  TEACH_LEDGER_PROMPT_MAX_CHARS,
  TEACH_LEDGER_HEADER,
  TEACH_LEDGER_TRUNCATED_MARK,
} = ledger
const { TEACH_LEDGER_MAX_CHARS } = types

const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\n=== 1. parseTeachFence：正常 / 容错 / 坏 JSON ===')
const NORMAL = '讲解正文。\n\n```teach\n{"unitId":"u3","step":2,"label":"银行家算法安全性检查","newTerms":["资源分配图","安全序列"],"next":"讲不安全状态的反例"}\n```\n'
const normalPatch = parseTeachFence(NORMAL)
check('正常围栏解析出全部字段', !!normalPatch && normalPatch.unitId === 'u3' && normalPatch.step === 2 && normalPatch.label === '银行家算法安全性检查', JSON.stringify(normalPatch))
check('newTerms 数组保留顺序', eqJson(normalPatch?.newTerms, ['资源分配图', '安全序列']), JSON.stringify(normalPatch?.newTerms))
check('next 解析', normalPatch?.next === '讲不安全状态的反例', JSON.stringify(normalPatch?.next))

const singleQuoted = parseTeachFence("```teach\n{'unitId': 'u3', 'step': 2, 'label': '银行家算法'}\n```")
check('单引号 + 单引号键可解析', !!singleQuoted && singleQuoted.unitId === 'u3' && singleQuoted.label === '银行家算法', JSON.stringify(singleQuoted))

const bareKeys = parseTeachFence('```teach\n{unitId: "u4", step: 3, label: "试算"}\n```')
check('裸键（未加引号）可解析', !!bareKeys && bareKeys.unitId === 'u4' && bareKeys.step === 3, JSON.stringify(bareKeys))

const trailing = parseTeachFence('```teach\n{"unitId":"u3", // 行内注释\n"step":4,}\n```')
check('尾逗号 + 行内注释可解析', !!trailing && trailing.step === 4, JSON.stringify(trailing))

const fullwidth = parseTeachFence('```teach\n{『unitId』: 『u5』, 『step』: 5, 『label』: 『死锁预防』}\n```')
check('全角引号（『』）结构位置可解析', !!fullwidth && fullwidth.unitId === 'u5' && fullwidth.label === '死锁预防', JSON.stringify(fullwidth))

const prose = parseTeachFence('下面是台账：\n```teach\n说明 {"unitId":"u6","step":1} 结束\n```\n以上。')
check('JSON 前后多余文字可解析', !!prose && prose.unitId === 'u6' && prose.step === 1, JSON.stringify(prose))

check('坏 JSON 返回 null 不抛错', parseTeachFence('```teach\n{"unitId": }\n```') === null, '')
check('无 teach 围栏返回 null', parseTeachFence('只有 markdown 正文') === null, '')
check('围栏内是数组返回 null（负向）', parseTeachFence('```teach\n[{"unitId":"u3"}]\n```') === null, '')
check('空对象 / 无已知字段返回 null（负向）', parseTeachFence('```teach\n{"foo":1}\n```') === null, '')

console.log('\n=== 2. stripTeachFence：只删 teach 围栏 ===')
const MIXED = '## 讲解\n\n正文一段。\n\n```teach\n{"step":2}\n```\n\n```quiz\n{"no":1,"question":"q"}\n```\n\n```plan\n{"ops":[]}\n```\n'
const stripped = stripTeachFence(MIXED)
check('teach 围栏被移除', !stripped.includes('```teach'), JSON.stringify(stripped))
check('quiz / plan 围栏原样保留', stripped.includes('```quiz') && stripped.includes('```plan'), '')
check('正文段落保留', stripped.includes('## 讲解') && stripped.includes('正文一段。'), '')
check('多余空行已收敛（无连续 3 换行）', !stripped.includes('\n\n\n'), JSON.stringify(stripped))

console.log('\n=== 3. mergeLedger：累加 / 幂等 / 单调 / 去重 ===')
const NOW1 = '2026-11-19T10:00:00.000Z'
const PATCH = { unitId: 'u3', step: 2, label: '银行家算法安全性检查', newTerms: ['资源分配图', '安全序列'], next: '讲不安全状态的反例' }
const first = mergeLedger(null, PATCH, NOW1)
check('null + 有效 patch → 完整 ledger', first.current?.unitId === 'u3' && first.current?.step === 2 && first.terms.length === 2 && first.next === '讲不安全状态的反例', JSON.stringify(first))
check('terms 记录首次 definedAt', first.terms.every((t) => t.definedAt === NOW1), '')

const twice = mergeLedger(first, PATCH, NOW1)
check('★ 同一 patch 连续两次合并结果相同（幂等）', eqJson(twice, first), JSON.stringify(twice))

const caseFirst = mergeLedger(first, { newTerms: ['Resource Graph', 'resource graph', '资源分配图'] }, NOW1)
check('terms 大小写不敏感去重', caseFirst.terms.length === 3, JSON.stringify(caseFirst.terms.map((t) => t.term)))
check('去重保留首次 definedAt / 首次写法', caseFirst.terms.find((t) => t.term.toLowerCase() === 'resource graph')?.definedAt === NOW1 && caseFirst.terms.filter((t) => t.term.toLowerCase() === 'resource graph').length === 1, JSON.stringify(caseFirst.terms))

const stale = mergeLedger(first, { unitId: 'u1', step: 1, label: '旧台阶' }, '2026-11-19T11:00:00.000Z')
check('★ step 只增不减（旧 step patch 整段 current 不动）', stale.current?.step === 2 && stale.current?.unitId === 'u3' && stale.current?.label === '银行家算法安全性检查', JSON.stringify(stale.current))
check('旧 patch 不刷新 updatedAt', stale.updatedAt === first.updatedAt, stale.updatedAt)

const higher = mergeLedger(first, { unitId: 'u3', step: 3, label: '安全检查例题' }, '2026-11-19T12:00:00.000Z')
check('step 前进并更新 label', higher.current?.step === 3 && higher.current?.label === '安全检查例题', JSON.stringify(higher.current))
check('step 前进刷新 updatedAt', higher.updatedAt === '2026-11-19T12:00:00.000Z', higher.updatedAt)

check('空 patch 原样返回 prev（引用相同）', mergeLedger(first, {}, NOW1) === first, '')
check('空 patch + null prev → 空 ledger（不是 null）', (() => { const e = mergeLedger(null, {}, NOW1); return !!e && Array.isArray(e.terms) && e.terms.length === 0 })(), '')
check('newTerms 空数组不改 terms', mergeLedger(first, { newTerms: [] }, NOW1) === first, '')
check('换 unit 未给 label 时清空旧 label（负向）', (() => { const r = mergeLedger(first, { unitId: 'u4', step: 3 }, NOW1); return r.current?.unitId === 'u4' && r.current?.label === '' })(), JSON.stringify(mergeLedger(first, { unitId: 'u4', step: 3 }, NOW1).current))

console.log('\n=== 4. renderLedgerForPrompt：格式 / 空 / 截断 ===')
const rendered = renderLedgerForPrompt(first)
const expected = [
  TEACH_LEDGER_HEADER,
  '已讲到：unit u3 · 第 2 步 · 银行家算法安全性检查',
  '已定义：资源分配图、安全序列',
  '下一步：讲不安全状态的反例',
].join('\n')
check('注入格式与方案一致', rendered === expected, JSON.stringify(rendered))
check('空 ledger 渲染空串（null）', renderLedgerForPrompt(null) === '', '')
check('空 ledger 渲染空串（无内容的 ledger）', renderLedgerForPrompt({ terms: [], updatedAt: NOW1 }) === '', '')
check('常量 800 与 aiTeachingTypesPure.TEACH_LEDGER_MAX_CHARS 同值', TEACH_LEDGER_PROMPT_MAX_CHARS === TEACH_LEDGER_MAX_CHARS, `${TEACH_LEDGER_PROMPT_MAX_CHARS} vs ${TEACH_LEDGER_MAX_CHARS}`)
const cut = renderLedgerForPrompt(first, 60)
check('超长按行截断并以标记结尾', cut.endsWith(TEACH_LEDGER_TRUNCATED_MARK) && cut.length <= 60, JSON.stringify(cut))
check('截断后仍保留抬头', cut.startsWith(TEACH_LEDGER_HEADER), JSON.stringify(cut))
const defaultCut = renderLedgerForPrompt({ current: { unitId: 'u9', step: 9, label: 'x'.repeat(1000) }, terms: [], updatedAt: NOW1 })
check('默认上限下长度 ≤ 800 且带标记', defaultCut.length <= 800 && defaultCut.endsWith(TEACH_LEDGER_TRUNCATED_MARK), String(defaultCut.length))

console.log('\n=== 5. ledgerFromHeadings：漏写围栏兜底 ===')
const headingPatch = ledgerFromHeadings('## 章节\n\n### 第一步 定义\n内容\n### 银行家算法安全性检查\n内容')
check('取最后一个 `### 标题` 作为 label', headingPatch?.label === '银行家算法安全性检查', JSON.stringify(headingPatch))
check('传入 unitId 时一并带上', ledgerFromHeadings('### 甲', 'u3')?.unitId === 'u3', JSON.stringify(ledgerFromHeadings('### 甲', 'u3')))
check('没有 `### 标题` 返回 null（负向）', ledgerFromHeadings('## 只有二级标题\n正文') === null, '')
check('`####` 不进兜底（负向）', ledgerFromHeadings('#### 四级标题') === null, '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

for (const dir of [ledgerTmp, typesTmp]) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
}
process.exit(failed.length === 0 ? 0 : 1)
