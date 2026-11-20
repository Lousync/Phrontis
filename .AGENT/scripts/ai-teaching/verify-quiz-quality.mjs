#!/usr/bin/env node
/**
 * 契约验证：AI 教学「题单质量门」纯函数（`electron/lib/quizQualityPure.ts`）
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §9
 *      `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` E4
 *
 * 锁什么：结构硬校验正反例、字母指代检测、答案均衡（分布 / 无 3 连 / 幂等 / 跳过规则）、
 *         长度偏置三种 reason。
 *
 * 运行（仓库根目录）：node .AGENT/scripts/ai-teaching/verify-quiz-quality.mjs [仓库路径]
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

const REL = 'electron/lib/quizQualityPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-quality-'))
const tmpFile = path.join(tmpDir, 'quizQualityPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const { validateQuizDoc, detectOptionLetterRefs, rebalanceAnswers, detectLengthBias } = await import(pathToFileURL(tmpFile).href)

/* ---------------------------------------------------------------- 夹具 */
const choice = (no, answer, texts = ['甲', '乙', '丙', '丁'], extra = {}) => ({
  no,
  question: `第 ${no} 题题干`,
  options: ['A', 'B', 'C', 'D'].slice(0, texts.length).map((key, i) => ({ key, text: texts[i] })),
  answer,
  explanation: `第 ${no} 题解析`,
  ...extra,
})
const short = (no, referenceAnswer = '要点式答案') => ({ no, type: 'short', question: `第 ${no} 题简答`, referenceAnswer, explanation: '略' })

console.log('\n=== 1. validateQuizDoc：正例 ===')
const good = [choice(1, 'A'), choice(2, 'C'), short(3)]
const goodResult = validateQuizDoc(good)
check('合法混合卷 ok=true 且无错误', goodResult.ok === true && goodResult.errors.length === 0, JSON.stringify(goodResult))
check('合法四选一卷 ok=true', validateQuizDoc([choice(1, 'B'), choice(2, 'D')]).ok === true, '')
check('合法简答卷 ok=true', validateQuizDoc([short(1), short(2)]).ok === true, '')

console.log('\n=== 2. validateQuizDoc：反例 ===')
const seq = validateQuizDoc([choice(2, 'A'), choice(1, 'B')])
check('题号不是 1..N 连续 → 报错', seq.ok === false && seq.errors.some((e) => e.includes('题号')), JSON.stringify(seq.errors))
const fewOpts = validateQuizDoc([{ ...choice(1, 'A'), options: [{ key: 'A', text: '甲' }] }])
check('选项少于 2 个 → 报错', fewOpts.ok === false && fewOpts.errors.some((e) => e.includes('至少需要 2 个选项')), JSON.stringify(fewOpts.errors))
const dupKey = validateQuizDoc([{ ...choice(1, 'A'), options: [{ key: 'A', text: '甲' }, { key: 'A', text: '乙' }] }])
check('选项 key 重复 → 报错', dupKey.ok === false && dupKey.errors.some((e) => e.includes('key')), JSON.stringify(dupKey.errors))
const badAnswer = validateQuizDoc([choice(1, 'E')])
check('answer 不在选项 key 中 → 报错', badAnswer.ok === false && badAnswer.errors.some((e) => e.includes('answer')), JSON.stringify(badAnswer.errors))
const noExpl = validateQuizDoc([{ ...choice(1, 'A'), explanation: '  ' }])
check('选择题解析为空 → 报错', noExpl.ok === false && noExpl.errors.some((e) => e.includes('解析')), JSON.stringify(noExpl.errors))
const noRef = validateQuizDoc([short(1, '')])
check('简答题参考答案为空 → 报错', noRef.ok === false && noRef.errors.some((e) => e.includes('参考答案')), JSON.stringify(noRef.errors))
const dupText = validateQuizDoc([choice(1, 'A', ['同文', '同文', '丙', '丁'])])
check('选项文本重复 → 报错', dupText.ok === false && dupText.errors.some((e) => e.includes('文本重复')), JSON.stringify(dupText.errors))
check('空题集 → 不通过（负向）', validateQuizDoc([]).ok === false, JSON.stringify(validateQuizDoc([])))

console.log('\n=== 3. detectOptionLetterRefs ===')
check('「A 项」→ true', detectOptionLetterRefs('上述 A 项 的说法正确') === true, '')
check('「选 B」→ true', detectOptionLetterRefs('应选 B 而不是其他') === true, '')
check('「选项 C」→ true', detectOptionLetterRefs('选项 C 描述的是死锁') === true, '')
check('「A. 」行首指代 → true', detectOptionLetterRefs('A. 先来先服务') === true, '')
check('「（D）」→ true', detectOptionLetterRefs('答案应为（D）') === true, '')
check('普通中文解读 → false', detectOptionLetterRefs('安全序列是指系统按此顺序分配资源不会死锁') === false, '')
check('英文缩写 / 猜想名 → false', detectOptionLetterRefs('ABC 猜想与 TypeScript 无关') === false, '')
check('空串 → false', detectOptionLetterRefs('') === false, '')

console.log('\n=== 4. rebalanceAnswers：分布 / 无 3 连 / 幂等 ===')
const allA = Array.from({ length: 8 }, (_, i) => choice(i + 1, 'A', [`正确${i + 1}`, `干扰${i + 1}a`, `干扰${i + 1}b`, `干扰${i + 1}c`]))
const balanced = rebalanceAnswers(allA)
const dist = { A: 0, B: 0, C: 0, D: 0 }
for (const q of balanced) dist[q.answer] += 1
check('4 选 1 时答案分布约 1/4（8 题各 2）', dist.A === 2 && dist.B === 2 && dist.C === 2 && dist.D === 2, JSON.stringify(dist))
let maxRun = 0
let run = 0
let last = ''
for (const q of balanced) {
  if (q.answer === last) run += 1
  else {
    last = q.answer
    run = 1
  }
  if (run > maxRun) maxRun = run
}
check('不出现连续 3 题同答案', maxRun < 3, `maxRun=${maxRun}`)
check('正确项文本仍与 answer 对应（语义未坏）', balanced.every((q, i) => q.options.find((o) => o.key === q.answer)?.text === `正确${i + 1}`), JSON.stringify(balanced.map((q) => q.answer)))
const balancedAgain = rebalanceAnswers(balanced)
check('★ 均衡幂等（跑两次结果完全相同）', eqJson(balancedAgain, balanced), '')
const allAKeys = allA.map((q) => q.options.map((o) => o.key).join(''))
const balancedKeys = balanced.map((q) => q.options.map((o) => o.key).join(''))
check('槽位 key 顺序不变（A/B/C/D 不错位）', eqJson(allAKeys, balancedKeys), JSON.stringify(balancedKeys))

console.log('\n=== 5. rebalanceAnswers：跳过规则 ===')
const refQ = { ...choice(1, 'A'), question: '下列 A 项 中正确的是', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }, { key: 'C', text: '丙' }, { key: 'D', text: '丁' }] }
const refOut = rebalanceAnswers([refQ])[0]
check('题干含字母指代 → 答案 / 选项顺序都不动', refOut.answer === 'A' && eqJson(refOut.options, refQ.options), JSON.stringify(refOut))
const explQ = { ...choice(1, 'B'), explanation: '因为选项 D 与题干矛盾' }
const explOut = rebalanceAnswers([explQ])[0]
check('解析含字母指代 → 不动', explOut.answer === 'B' && eqJson(explOut.options, explQ.options), JSON.stringify(explOut))
const protectedQ = choice(1, 'C', ['正确', '干扰一', '干扰二', '干扰三'])
const protectedOut = rebalanceAnswers([protectedQ], { recentKeys: { '1': 'C' } })[0]
check('recentKeys 已记录答案 → 不动', protectedOut.answer === 'C' && eqJson(protectedOut.options, protectedQ.options), JSON.stringify(protectedOut))
const shortOut = rebalanceAnswers([short(1)])[0]
check('简答题不参与均衡', eqJson(shortOut, short(1)), JSON.stringify(shortOut))

console.log('\n=== 6. detectLengthBias：三种 reason ===')
const longQ = choice(1, 'A', ['这是一个非常非常长的正确选项文本用来制造长度暗示', '短甲', '短乙', '短丙'])
const longFlags = detectLengthBias([longQ]).flagged
check('正确项明显偏长 → correct-long', longFlags.some((f) => f.no === 1 && f.reason === 'correct-long'), JSON.stringify(longFlags))
const shortQ = choice(1, 'A', ['短', '这是一个长度正常的干扰选项', '这是另一个长度正常的干扰项', '再一个长度正常的干扰项'])
const shortFlags = detectLengthBias([shortQ]).flagged
check('正确项明显偏短 → correct-short', shortFlags.some((f) => f.no === 1 && f.reason === 'correct-short'), JSON.stringify(shortFlags))
const spreadQ = choice(1, 'A', ['正常长度的正确项', '正常长度的干扰一', '正常长度的干扰二', '这个干扰项被写得特别特别特别特别特别长'])
const spreadFlags = detectLengthBias([spreadQ]).flagged
check('全卷最长 / 最短 > 2.2 → 唯一最长项标 spread', spreadFlags.some((f) => f.no === 1 && f.reason === 'spread'), JSON.stringify(spreadFlags))
const evenQ = choice(1, 'A', ['长度甲甲甲', '长度乙乙乙', '长度丙丙丙', '长度丁丁丁'])
const evenFlags = detectLengthBias([evenQ, short(2)]).flagged
check('长度均衡且简答不参与 → 无标记（负向）', evenFlags.length === 0, JSON.stringify(evenFlags))
const tieQ = choice(1, 'A', ['很长很长的甲', '很长很长的乙', '短', '短'])
const tieFlags = detectLengthBias([tieQ]).flagged
check('最长项不唯一 → 不标 spread（负向）', !tieFlags.some((f) => f.reason === 'spread'), JSON.stringify(tieFlags))

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
