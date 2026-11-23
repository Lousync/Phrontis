#!/usr/bin/env node
/**
 * 契约验证：AI 教学「题单质量门」**接线层**（`electron/lib/quizGatePure.ts` + 主进程写盘点）
 *
 * 纯函数四项能力本身由 `verify-quiz-quality.mjs` 锁；本脚本锁两件事：
 *   A. 接线层三档行为（strict / warn / off）、保护规则、幂等、warnings 结构；
 *   B. 真正落盘点 `electron/lib/aiTeachingCourse.ts` 的 `archiveOrganizedPage` 确实在
 *      **写盘前**调用了质量门，且设置键 / 重试上限 / 作答记录保护都没漏。
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §9
 *      `/home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md` E4
 *
 * 运行（仓库根）：node .AGENT/scripts/ai-teaching/verify-quiz-quality-wiring.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import { makeStager } from './strip-load.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const stager = makeStager(ROOT)
const gate = await stager.load('electron/lib/quizGatePure.ts')
const docMod = await stager.load('electron/lib/quizDocPure.ts')
const {
  applyQuizQualityGate,
  extractQuizFences,
  normalizeQuizQualityMode,
  QUIZ_GATE_MAX_REWRITE,
} = gate
const { hasQuizFence, QUIZ_FENCE_RE } = docMod

/* ---------------------------------------------------------------- 夹具 */

/** 长度都一致的选项文本：4 / 4 / 4 / 4，避免误触长度暗示（阈值 0.75~1.35） */
const evenTexts = (no) => [`正确${no}x`, `干扰${no}a`, `干扰${no}b`, `干扰${no}c`]

const choice = (no, answer, texts = evenTexts(no), extra = {}) =>
  JSON.stringify({
    no,
    question: `第 ${no} 题题干`,
    options: ['A', 'B', 'C', 'D'].map((key, i) => ({ key, text: texts[i] })),
    answer,
    explanation: `第 ${no} 题解析`,
    ...extra,
  })

const short = (no) =>
  JSON.stringify({ type: 'short', no, question: `第 ${no} 题简答`, referenceAnswer: '要点式答案', explanation: '说明' })

const FENCE = (json) => '```quiz\n' + json + '\n```'
const INTRO = '# 随堂测验\n\n覆盖第 1 章，共 N 题。\n\n'
const doc = (jsons) => INTRO + jsons.map(FENCE).join('\n\n') + '\n'
const bodies = (content) => extractQuizFences(content).map((f) => f.question)
const answers = (content) => bodies(content).map((q) => q && q.answer)

/* ---------------------------------------------------------------- 1. 档位归一 */

console.log('\n=== 1. normalizeQuizQualityMode：缺省 strict ===')
check("undefined → strict", normalizeQuizQualityMode(undefined) === 'strict', '')
check("'warn' → warn", normalizeQuizQualityMode('warn') === 'warn', '')
check("'off' → off", normalizeQuizQualityMode('off') === 'off', '')
check("'STRICT' / 乱值 → strict（大小写不宽容，与 settings 值域一致）", normalizeQuizQualityMode('STRICT') === 'strict', '')
check('重试上限 = 1（只退回一次）', QUIZ_GATE_MAX_REWRITE === 1, String(QUIZ_GATE_MAX_REWRITE))

/* ---------------------------------------------------------------- 2. off / 非题单直通 */

console.log('\n=== 2. off 档与旧路径逐字一致 ===')
const allA = [choice(1, 'A'), choice(2, 'A'), choice(3, 'A'), choice(4, 'A')]
const allADoc = doc(allA)
const offResult = applyQuizQualityGate({ content: allADoc, mode: 'off' })
check('off：正文逐字不变', offResult.content === allADoc, '')
check('off：changed=false / warnings 空 / 不要求重写', offResult.changed === false && offResult.warnings.length === 0 && offResult.needsRewrite === false, JSON.stringify(offResult.warnings))
check('off：ok=true 且不解析围栏（summary 全空）', offResult.ok === true && offResult.summary.fences === 0 && offResult.summary.total === 0, JSON.stringify(offResult.summary))
const brokenDoc = doc(['{no:1, 坏 JSON'])
const offBroken = applyQuizQualityGate({ content: brokenDoc, mode: 'off' })
check('off：坏 JSON 也不拦（旧路径行为）', offBroken.ok === true && offBroken.content === brokenDoc, JSON.stringify(offBroken.errors))
const lecture = '# 讲义\n\n没有 quiz 围栏。\n'
const noFence = applyQuizQualityGate({ content: lecture, mode: 'strict' })
check('无题单围栏：strict 也不碰（讲义不受影响）', noFence.ok === true && noFence.content === lecture && noFence.warnings.length === 0 && noFence.changed === false, '')

/* ---------------------------------------------------------------- 2b. 围栏口径一致 */

console.log('\n=== 2b. hasQuizFence 与 extractQuizFences 口径一致 ===')
const missingNewline = '```quiz\n' + choice(1, 'A') + '```'
check('★ 闭合前缺换行的围栏也能被 extractQuizFences 拆出', hasQuizFence(missingNewline) === true && extractQuizFences(missingNewline).length === 1, JSON.stringify(extractQuizFences(missingNewline).map((f) => f.question?.no)))
check('★ 同一份正文走 strict 质量门能逐题校验（不再静默放行）', (() => {
  const r = applyQuizQualityGate({ content: missingNewline, mode: 'strict', allowRetry: true })
  return r.summary.fences === 1 && r.summary.total === 1
})(), JSON.stringify(applyQuizQualityGate({ content: missingNewline, mode: 'strict', allowRetry: true }).summary))
const unclosed = '```quiz\n' + choice(1, 'A') + '\n没有结尾围栏'
check('有开头无闭合：extract 为空但 hasQuizFence 为 true', hasQuizFence(unclosed) === true && extractQuizFences(unclosed).length === 0, '')
const unclosedStrict = applyQuizQualityGate({ content: unclosed, mode: 'strict', allowRetry: true })
check('★ 未闭合围栏在 strict 下是结构错误（不静默放行）', unclosedStrict.ok === false && /未闭合/.test(unclosedStrict.retryPrompt), String(unclosedStrict.retryPrompt))
const unclosedWarn = applyQuizQualityGate({ content: unclosed, mode: 'warn' })
check('未闭合围栏在 warn 下只告警', unclosedWarn.ok === true && unclosedWarn.warnings.some((w) => w.code === 'structure' && /未闭合/.test(w.message)), JSON.stringify(unclosedWarn.warnings))
check('统一正则导出且两处共用（quizDocPure → quizGatePure）', QUIZ_FENCE_RE instanceof RegExp && /from '\.\/quizDocPure'/.test(read('electron/lib/quizGatePure.ts')) && read('electron/lib/quizDocPure.ts').includes('export const QUIZ_FENCE_RE'), '')

/* ---------------------------------------------------------------- 3. warn：只检测 */

console.log('\n=== 3. warn 档：只检测、不拦、不改写 ===')
const warnUnbalanced = applyQuizQualityGate({ content: allADoc, mode: 'warn' })
check('warn：答案全 A 不拦（ok=true）', warnUnbalanced.ok === true, '')
check('warn：正文逐字不变（不重排）', warnUnbalanced.content === allADoc && warnUnbalanced.changed === false, '')
check('warn：报「答案位置不均衡」', warnUnbalanced.warnings.some((w) => w.code === 'unbalanced'), JSON.stringify(warnUnbalanced.warnings))
check('warn：summary 报出「若均衡会动几题」', warnUnbalanced.summary.rebalanced > 0, JSON.stringify(warnUnbalanced.summary))

const dupKeyDoc = doc([
  JSON.stringify({ no: 1, question: '题干', options: [{ key: 'A', text: '甲' }, { key: 'A', text: '乙' }], answer: 'A', explanation: '解析' }),
])
const warnStruct = applyQuizQualityGate({ content: dupKeyDoc, mode: 'warn' })
check('warn：结构错误只进 warnings，不拦不写回', warnStruct.ok === true && warnStruct.content === dupKeyDoc && warnStruct.errors.length > 0, JSON.stringify(warnStruct.errors))
check('warn：warnings 含 structure 条目', warnStruct.warnings.some((w) => w.code === 'structure' && /key/.test(w.message)), JSON.stringify(warnStruct.warnings))

const refDoc = doc([
  JSON.stringify({ no: 1, question: '下列 A 项 中正确的是', options: [{ key: 'A', text: '甲甲' }, { key: 'B', text: '乙乙' }, { key: 'C', text: '丙丙' }, { key: 'D', text: '丁丁' }], answer: 'A', explanation: '因为 A 项 成立' }),
])
const warnRef = applyQuizQualityGate({ content: refDoc, mode: 'warn' })
check('warn：字母指代进 warnings（带题号）', warnRef.warnings.some((w) => w.code === 'letter-ref' && eqJson(w.nos, [1])), JSON.stringify(warnRef.warnings))

const longDoc = doc([
  JSON.stringify({ no: 1, question: '题干', options: [{ key: 'A', text: '这是一个非常非常长的正确选项文本用来制造长度暗示' }, { key: 'B', text: '短甲甲' }, { key: 'C', text: '短乙乙' }, { key: 'D', text: '短丙丙' }], answer: 'A', explanation: '解析' }),
])
const warnLong = applyQuizQualityGate({ content: longDoc, mode: 'warn' })
check('warn：长度暗示进 warnings（code/nos/message 三段齐全）', warnLong.warnings.some((w) => w.code === 'length-bias' && eqJson(w.nos, [1]) && w.message.includes('第 1 题')), JSON.stringify(warnLong.warnings))

/* ---------------------------------------------------------------- 4. strict：结构硬校验 */

console.log('\n=== 4. strict 档：结构不过 → 不写盘 + 重写提示 ===')
const strictStruct = applyQuizQualityGate({ content: dupKeyDoc, mode: 'strict', allowRetry: true })
check('第一次：ok=false 且要求重写', strictStruct.ok === false && strictStruct.needsRewrite === true, JSON.stringify(strictStruct))
check('第一次：正文原样返回（绝不落坏题）', strictStruct.content === dupKeyDoc && strictStruct.changed === false, '')
check('第一次：提示可被模型理解（结构规则 + 整卷重提）', /结构硬校验未通过/.test(strictStruct.retryPrompt) && /整卷重新提交/.test(strictStruct.retryPrompt) && /quiz/.test(strictStruct.retryPrompt), strictStruct.retryPrompt)
const strictStructFinal = applyQuizQualityGate({ content: dupKeyDoc, mode: 'strict', allowRetry: false })
check('第二次：仍不写盘（结构硬校验不放行）', strictStructFinal.ok === false && strictStructFinal.content === dupKeyDoc, JSON.stringify(strictStructFinal))
check('第二次：提示说明「已退回改写一次」', /已退回改写一次/.test(strictStructFinal.retryPrompt), strictStructFinal.retryPrompt)
check('第二次：needsRewrite=false（不再无限要重写）', strictStructFinal.needsRewrite === false, String(strictStructFinal.needsRewrite))

const badJson = applyQuizQualityGate({ content: brokenDoc, mode: 'strict', allowRetry: true })
check('坏 JSON 围栏：strict 拦下并说明解析失败', badJson.ok === false && /JSON 解析失败/.test(badJson.retryPrompt), badJson.retryPrompt)
const seqDoc = doc([choice(2, 'A'), choice(1, 'B')])
const badSeq = applyQuizQualityGate({ content: seqDoc, mode: 'strict', allowRetry: true })
check('题号不是 1..N：strict 拦下', badSeq.ok === false && /题号/.test(badSeq.retryPrompt), badSeq.retryPrompt)

/* ---------------------------------------------------------------- 5. strict：均衡 */

console.log('\n=== 5. strict 档：答案均衡（改写 + 语义不变 + 幂等） ===')
const strictBalanced = applyQuizQualityGate({ content: allADoc, mode: 'strict', allowRetry: true })
check('合法题单：放行（ok=true）', strictBalanced.ok === true, JSON.stringify(strictBalanced))
check('发生了均衡（changed=true）', strictBalanced.changed === true && strictBalanced.summary.rebalanced > 0, JSON.stringify(strictBalanced.summary))
const ans = answers(strictBalanced.content)
const counts = ans.reduce((acc, k) => ({ ...acc, [k]: (acc[k] || 0) + 1 }), {})
check('答案分布不再全 A', !eqJson(counts, { A: 4 }), JSON.stringify(counts))
check('槽位 key 顺序仍是 A/B/C/D（只换文本）', bodies(strictBalanced.content).every((q) => q.options.map((o) => o.key).join('') === 'ABCD'), '')
check('正确项文本仍与 answer 对应（语义未坏）', bodies(strictBalanced.content).every((q) => q.options.find((o) => o.key === q.answer)?.text.startsWith('正确')), JSON.stringify(bodies(strictBalanced.content).map((q) => q.options.find((o) => o.key === q.answer)?.text)))
check('★ 幂等：连过两遍第二遍 changed=false', (() => { const second = applyQuizQualityGate({ content: strictBalanced.content, mode: 'strict', allowRetry: true }); return second.ok && second.changed === false && second.content === strictBalanced.content })(), '')
const mixedIdem = (() => {
  const seed = doc([choice(1, 'A'), short(2), choice(3, 'A')])
  const first = applyQuizQualityGate({ content: seed, mode: 'strict', allowRetry: true })
  const second = applyQuizQualityGate({ content: first.content, mode: 'strict', allowRetry: true })
  return first.ok && second.ok && second.changed === false && second.content === first.content
})()
check('★ 幂等：混合卷（简答 + 字母指代 + 选择题）第二遍也不动', mixedIdem, '')
check('围栏外正文逐字保留（标题 / 说明没被重写）', strictBalanced.content.startsWith(INTRO), JSON.stringify(strictBalanced.content.slice(0, INTRO.length)))
check('围栏数量不变', extractQuizFences(strictBalanced.content).length === 4, String(extractQuizFences(strictBalanced.content).length))
const mixedFences = '# 讲义\n\n```teach\n{"step":1}\n```\n\n' + doc(allA).slice(INTRO.length)
const mixedFencesOut = applyQuizQualityGate({ content: mixedFences, mode: 'strict', allowRetry: true })
check('不碰其它围栏（```teach 原样保留）', mixedFencesOut.ok && mixedFencesOut.content.includes('```teach\n{"step":1}\n```'), '')
check('warning 提供 letter-ref 之外的「已放行」信息不误报', strictBalanced.warnings.every((w) => w.code !== 'structure'), JSON.stringify(strictBalanced.warnings))

console.log('\n=== 6. strict：简答题 / 字母指代 / 已作答 三条例外 ===')
const mixedDoc = doc([choice(1, 'A'), short(2), choice(3, 'A')])
const mixedOut = applyQuizQualityGate({ content: mixedDoc, mode: 'strict', allowRetry: true })
const mixedQs = bodies(mixedOut.content)
check('简答题原样保留（题干 / 参考答案不变）', eqJson(mixedQs[1], JSON.parse(short(2))), JSON.stringify(mixedQs[1]))
check('简答题不打断选择题均衡（第 3 题被换过）', mixedOut.ok === true && mixedOut.summary.short === 1 && mixedOut.summary.choice === 2, JSON.stringify(mixedOut.summary))

const refStrict = applyQuizQualityGate({ content: refDoc, mode: 'strict', allowRetry: true })
check('字母指代题跳过重排（answer 仍是 A）', answers(refStrict.content)[0] === 'A', JSON.stringify(answers(refStrict.content)))
check('字母指代题仍进 warnings（code=letter-ref）', refStrict.warnings.some((w) => w.code === 'letter-ref' && eqJson(w.nos, [1])), JSON.stringify(refStrict.warnings))

const recentDoc = doc([choice(1, 'A'), choice(2, 'A'), choice(3, 'A'), choice(4, 'A')])
const recentOut = applyQuizQualityGate({ content: recentDoc, mode: 'strict', allowRetry: true, recentKeys: { '1': 'A' } })
check('recentKeys 命中的题不重排（第 1 题仍是 A）', answers(recentOut.content)[0] === 'A', JSON.stringify(answers(recentOut.content)))
check('未被命中的题照常均衡（有别的题被换过）', recentOut.summary.rebalanced > 0, JSON.stringify(recentOut.summary))

/* ---------------------------------------------------------------- 7. strict：长度暗示 */

console.log('\n=== 7. strict 档：长度暗示退回改写一次 ===')
const longOnce = applyQuizQualityGate({ content: longDoc, mode: 'strict', allowRetry: true })
check('第一次命中：不写盘（ok=false / needsRewrite=true）', longOnce.ok === false && longOnce.needsRewrite === true && longOnce.content === longDoc, JSON.stringify(longOnce))
check('提示点名题号与原因', /第 1 题/.test(longOnce.retryPrompt) && /偏长/.test(longOnce.retryPrompt), longOnce.retryPrompt)
const longTwice = applyQuizQualityGate({ content: longDoc, mode: 'strict', allowRetry: false })
check('第二次仍命中：放行写盘（ok=true）', longTwice.ok === true, JSON.stringify(longTwice))
check('第二次：留轻提示（code=rewrite-exhausted）', longTwice.warnings.some((w) => w.code === 'rewrite-exhausted' && eqJson(w.nos, [1])), JSON.stringify(longTwice.warnings))

/* ---------------------------------------------------------------- 8. warnings 结构 */

console.log('\n=== 8. warnings 结构稳定 ===')
const allWarn = [...warnUnbalanced.warnings, ...warnRef.warnings, ...warnLong.warnings, ...longTwice.warnings]
check('每条 warning 都有 code / message', allWarn.length > 0 && allWarn.every((w) => typeof w.code === 'string' && typeof w.message === 'string' && w.message.length > 0), JSON.stringify(allWarn))
check('code 只在约定值域内', allWarn.every((w) => ['structure', 'letter-ref', 'length-bias', 'unbalanced', 'rewrite-exhausted'].includes(w.code)), JSON.stringify(Array.from(new Set(allWarn.map((w) => w.code)))))
check('nos 出现时恒为数字数组', allWarn.every((w) => w.nos === undefined || (Array.isArray(w.nos) && w.nos.every((n) => typeof n === 'number'))), '')

/* ---------------------------------------------------------------- 9. 主进程接线（静态） */

console.log('\n=== 9. 落盘点接线：aiTeachingCourse.archiveOrganizedPage ===')
const course = read('electron/lib/aiTeachingCourse.ts')
const tools = read('electron/lib/builtinTools.ts')
const settings = read('src/lib/settings.ts')
const idx = read('src/modules/ai-teaching/index.tsx')

check('import 质量门（apply / normalize / 上限）', /from '\.\/quizGatePure'/.test(course) && /applyQuizQualityGate/.test(course) && /normalizeQuizQualityMode/.test(course) && /QUIZ_GATE_MAX_REWRITE/.test(course), '')

const start = course.indexOf('export function archiveOrganizedPage')
const end = course.indexOf('// ===== IPC 注册 =====', start)
const fn = start >= 0 && end > start ? course.slice(start, end) : ''
const helperStart = course.indexOf('/* ===== 题单质量门')
const gateBlock = helperStart >= 0 && end > helperStart ? course.slice(helperStart, end) : ''
check('找到 archiveOrganizedPage 函数体', fn.length > 0, `start=${start}`)
check('读取设置键 aiTeachQuizQuality（默认值在 settings 里）', fn.includes("getSetting('aiTeachQuizQuality')"), '')
const gateAt = fn.indexOf('applyQuizQualityGate(')
const writeAt = fn.indexOf('writeFileSync(')
check('质量门在 writeFileSync 之前（主进程写盘前拦截）', gateAt > 0 && writeAt > gateAt, `gateAt=${gateAt} writeAt=${writeAt}`)
check('off 档不进质量门（quizContent 保持原文）', /let quizContent = text/.test(fn) && /if \(mode !== 'off'\)/.test(fn), '')
check('结构 / 长度不合格 → 直接 return、不走到写盘', /if \(!gate\.ok\)[\s\S]{0,240}return \{ ok: false/.test(fn), '')
check('重试次数带上限（used < QUIZ_GATE_MAX_REWRITE）', /allowRetry: used < QUIZ_GATE_MAX_REWRITE/.test(fn), '')
check('作答记录保护走 records.json（readQuizRecords + page_id / page_title）', gateBlock.includes('readQuizRecords()') && gateBlock.includes('row.page_id') && gateBlock.includes('row.page_title'), '')
check('recentKeys 传进质量门', /recentKeys: quizAnsweredKeys\(/.test(fn), '')
check('成功分支把 warnings 带回给模型', /warnings: quizWarnings/.test(fn), '')
check('重试计数有 TTL（防陈旧计数误放行）', gateBlock.includes('QUIZ_GATE_ATTEMPT_TTL_MS') && gateBlock.includes('now - hit.at > QUIZ_GATE_ATTEMPT_TTL_MS'), '')
check('旧卷不批量重排（质量门不扫盘：无 readdirSync / 只作用于传入正文）', !gateBlock.includes('readdirSync') && !gateBlock.includes('readdir('), '')
check('只对题单生效（非 quiz 文档不进质量门）', /if \(isQuiz\) \{[\s\S]{0,200}normalizeQuizQualityMode/.test(fn), '')
check('工具层原样透传结果（不吞 warnings）', /const r = archiveOrganizedPage\(sid, str\(args\.title\), str\(args\.content\), str\(args\.target\), getSettingReader\(\)\)/.test(tools), '')
check('设置项存在且默认 strict、ui:false（getSetting 仍可读）', /aiTeachQuizQuality: \{ default: 'strict'[^\n]*ui: false/.test(settings), '')
check('质量门不在渲染层（渲染层只展示，拦截无效）', !idx.includes('applyQuizQualityGate') && !idx.includes('aiTeachQuizQuality'), '')

console.log('\n=== 10. 其余写入口也过门（复习讲义 / vault.write） ===')
check('导出统一写盘门 gateQuizContentForWrite', /export function gateQuizContentForWrite\(/.test(course), '')
const writeGateStart = course.indexOf('export function gateQuizContentForWrite')
const writeGateEnd = course.indexOf('/** 整理页归档', writeGateStart)
const helperFn = writeGateStart >= 0 && writeGateEnd > writeGateStart ? course.slice(writeGateStart, writeGateEnd) : ''
check('off 档逐字直通（gate 对原文一个字符都不改，连 CRLF 都不动）',
  /if \(mode === 'off'\) return \{ ok: true, content: rawText \}/.test(helperFn), '')
check('无 quiz 围栏的正文不过门（普通复习讲义 / 笔记不受影响，原样返回）',
  /if \(!hasQuizFence\(rawText\)\) return \{ ok: true, content: rawText \}/.test(helperFn), '')
const reviewStart = course.indexOf('export function writeChapterReviewDoc')
const reviewEnd = course.indexOf('/** 取本段同章上一段的交接内容', reviewStart)
const reviewFn = reviewStart >= 0 && reviewEnd > reviewStart ? course.slice(reviewStart, reviewEnd) : ''
check('★ writeChapterReviewDoc 写盘前调用质量门',
  /writeChapterReviewDoc[\s\S]{0,1600}gateQuizContentForWrite\([\s\S]{0,900}writeFileSync\(/.test(course), '')
check('复习讲义不合格 → return 错误、不写盘', /if \(!gated\.ok\) return \{ ok: false, error: gated\.error/.test(reviewFn), '')
check('★ vault.write 在 aiTeaching + 含 quiz 围栏时调用同一道门',
  /ctx\?\.source === 'aiTeaching' && rel\.toLowerCase\(\)\.endsWith\('\.md'\) && hasQuizFence\(content\)/.test(tools)
  && /gateQuizContentForWrite\(String\(ctx\.sessionId \?\? ''\)/.test(tools), '')
check('vault.write 门不合格时抛错（不是拒绝保存，是把重写提示给模型）', /if \(!gated\.ok\) throw new Error\(gated\.error\)/.test(tools), '')
check('两处入口复用同一个 gate 实现（不各写一套）',
  (tools.match(/applyQuizQualityGate\(/g) ?? []).length === 0 && (course.match(/export function gateQuizContentForWrite\(/g) ?? []).length === 1, '')

/* ---------------------------------------------------------------- 11. 所有 .md 写入口共同过门 */

console.log('\n=== 11. 所有 .md 写入口共同过门（write / write-batch / edit） ===')

/** 截取某个 tool 的 handler 片段（到下一个 registerTool 为止） */
const toolBody = (name) => {
  const s = tools.indexOf(`name: '${name}'`)
  if (s < 0) return ''
  const nxt = tools.indexOf('\n  registerTool({', s)
  return tools.slice(s, nxt > s ? nxt : tools.length)
}

const writeBody = toolBody('builtin.vault.write')
const batchBody = toolBody('builtin.vault.write-batch')
const editBody = toolBody('builtin.vault.edit')
check('找到三个写入口的 handler', writeBody.length > 0 && batchBody.length > 0 && editBody.length > 0,
  `write=${writeBody.length} batch=${batchBody.length} edit=${editBody.length}`)

for (const [label, body] of [['vault.write', writeBody], ['vault.write-batch', batchBody], ['vault.edit', editBody]]) {
  check(`★ ${label}：aiTeaching + .md + hasQuizFence 都调用同一道门`,
    /ctx\?\.source === 'aiTeaching' && rel\.toLowerCase\(\)\.endsWith\('\.md'\) && hasQuizFence\(/.test(body)
    && body.includes('gateQuizContentForWrite(String(ctx.sessionId ?? \'\')'), '')
}

// write-batch：位置与整批中止
const batchGateAt = batchBody.indexOf('gateQuizContentForWrite(')
const batchPushAt = batchBody.indexOf('writes.push(')
const batchEnsureIdAt = batchBody.indexOf('ensureKnowledgeDocFrontmatter(')
const batchCommitAt = batchBody.indexOf('commitOrStage(')
check('★ write-batch：门在 ensureId 之后（校验的是补好 frontmatter 的正文）',
  batchEnsureIdAt >= 0 && batchGateAt > batchEnsureIdAt, `ensureIdAt=${batchEnsureIdAt} gateAt=${batchGateAt}`)
check('★ write-batch：门在 writes.push 之前（任一条不合格不会先入队）',
  batchGateAt > 0 && batchPushAt > batchGateAt, `gateAt=${batchGateAt} pushAt=${batchPushAt}`)
check('★ write-batch：失败信息带「第 N 条：」前缀',
  /if \(!gated\.ok\) throw new Error\(`第 \$\{i \+ 1\} 条：\$\{gated\.error\}`\)/.test(batchBody), '')
check('★ write-batch：该 throw 在 commitOrStage 之前（整批中止，不落盘也不进暂存）',
  batchCommitAt > 0 && batchGateAt < batchCommitAt
  && batchBody.slice(0, batchCommitAt).includes('第 ${i + 1} 条：${gated.error}'), `gateAt=${batchGateAt} commitAt=${batchCommitAt}`)

// vault.edit：全文过门 + 位置
const editGateAt = editBody.indexOf('gateQuizContentForWrite(')
const editNextAt = editBody.lastIndexOf('next = text.slice(')
const editAppendAt = editBody.indexOf("next = text.replace(/\\s*$/, '')")
const editCommitAt = editBody.indexOf('commitOrStage(')
check('★ vault.edit：门在 next 算好之后（替换分支与追加分支都覆盖）',
  editNextAt >= 0 && editAppendAt >= 0 && editGateAt > editNextAt && editGateAt > editAppendAt,
  `appendAt=${editAppendAt} sliceAt=${editNextAt} gateAt=${editGateAt}`)
check('★ vault.edit：门在 commitOrStage 之前（不合格不落盘）',
  editGateAt > 0 && editCommitAt > editGateAt, `gateAt=${editGateAt} commitAt=${editCommitAt}`)
check('vault.edit：门看的是 next 全文而不是 newText 片段',
  /hasQuizFence\(next\)/.test(editBody) && /gateQuizContentForWrite\(String\(ctx\.sessionId \?\? ''\)[^\n]*next,/.test(editBody), '')
check('vault.edit：门不合格抛错（把重写提示给模型）', /if \(!gated\.ok\) throw new Error\(gated\.error\)/.test(editBody), '')

// off 档逐字直通（含 CRLF）
const crlfDoc = doc([choice(1, 'A'), choice(2, 'B')]).replace(/\n/g, '\r\n')
const crlfOff = applyQuizQualityGate({ content: crlfDoc, mode: 'off' })
check('★ off 档不归一化：CRLF 正文逐字返回（长度 / 字符完全一致）',
  crlfOff.ok === true && crlfOff.content === crlfDoc && crlfOff.content.length === crlfDoc.length
  && crlfOff.changed === false && crlfOff.summary.fences === 0, `len=${crlfOff.content.length}/${crlfDoc.length}`)
check('gateQuizContentForWrite 的 off 分支同样返回 rawText（三个入口共用，无需各自归一化）',
  /if \(mode === 'off'\) return \{ ok: true, content: rawText \}/.test(helperFn), '')

/** 执行级说明：三个 handler 依赖 Electron ipcMain / 当前 vault / 权限上下文，脚本内无法低成本拉起，
 *  故批量写「strict 坏题单 → 抛错且目标文件未创建」用上面的位置断言（throw 先于 commitOrStage 与 writes.push）
 *  + 纯函数严格档用例共同覆盖；真正的落盘路径由 verify-all-p0 的端到端脚本负责。 */

/* ---------------------------------------------------------------- 12. 其余吃任意 Markdown 的写入口 */

console.log('\n=== 12. knowledge.create-page / artifact.edit 过门 + gen-paper 豁免 ===')

const sources = read('electron/lib/aiTeachingSources.ts')

// 12a. builtin.knowledge.create-page：整篇 Markdown 进暂存 → vaultCreatePage 落盘
const createBody = toolBody('builtin.knowledge.create-page')
check('找到 knowledge.create-page handler', createBody.length > 0, `len=${createBody.length}`)
const cpLetAt = createBody.indexOf('let contentMd = str(args.contentMd)')
const cpGateAt = createBody.indexOf('gateQuizContentForWrite(')
const cpStageAt = createBody.indexOf('stageToolOp(')
check('★ create-page：只在 aiTeaching + 含 quiz 围栏时过门（普通知识库备注不动）',
  /ctx\?\.source === 'aiTeaching' && hasQuizFence\(contentMd\)/.test(createBody), '')
check('★ create-page：门在 stageToolOp 之前（预览 / 确认的就是校正后正文，失败也不等应用才炸）',
  cpLetAt >= 0 && cpGateAt > cpLetAt && cpStageAt > cpGateAt, `letAt=${cpLetAt} gateAt=${cpGateAt} stageAt=${cpStageAt}`)
check('★ create-page：校正后的正文写回暂存参数（预览与落盘同一份，不留「预览原样、落盘校正」旁路）',
  /withResolvedTarget\(\{ \.\.\.args, contentMd \}, target\)/.test(createBody)
  && /let contentMd = str\(args\.contentMd\)/.test(createBody)
  && /args: stagedArgs/.test(createBody), '')
check('create-page：落盘用的也是同一个 contentMd 变量（没有回退去读 args.contentMd）',
  /vaultCreatePage\(\{ title, contentMd,/.test(createBody) && !/vaultCreatePage\(\{ title, contentMd: str\(args\.contentMd\)/.test(createBody), '')
check('create-page：不合格抛错（把重写提示当错误回给模型，与 vault.write 同口径）',
  /if \(!gated\.ok\) throw new Error\(gated\.error\)/.test(createBody), '')

// 12b. aiTeach.artifact.edit（editArtifactText）：局部替换 / 追加后整篇过门
check('artifact.edit 所在的 aiTeachingSources 已 import 同一道门 + 围栏判定（不各写一套）',
  /gateQuizContentForWrite/.test(sources) && /from '\.\/quizDocPure'/.test(sources), '')
const eaStart = sources.indexOf('export function editArtifactText')
const eaEnd = sources.indexOf('/** 解析条目路径', eaStart)
const eaFn = eaStart >= 0 && eaEnd > eaStart ? sources.slice(eaStart, eaEnd) : ''
check('找到 editArtifactText 函数体', eaFn.length > 0, `start=${eaStart}`)
const eaNextAt = eaFn.indexOf('let next = applied.next')
const eaGateAt = eaFn.indexOf('gateQuizContentForWrite(')
const eaWriteAt = eaFn.indexOf('writeFileSync(abs, next')
check('★ artifact.edit：门在全文 next 算好之后（替换分支与追加分支都已应用）',
  eaNextAt >= 0 && eaGateAt > eaNextAt, `nextAt=${eaNextAt} gateAt=${eaGateAt}`)
check('★ artifact.edit：门在 writeFileSync 之前（不合格就不落盘）',
  eaGateAt > 0 && eaWriteAt > eaGateAt, `gateAt=${eaGateAt} writeAt=${eaWriteAt}`)
check("★ artifact.edit：条件正好是 ext === 'md' && hasQuizFence(next)（html / json 产物不受影响）",
  /if \(ext === 'md' && hasQuizFence\(next\)\) \{/.test(eaFn), '')
check('★ artifact.edit：门看的是 next 全文而不是 edits 片段，且复用本函数的 getSetting',
  /gateQuizContentForWrite\(sessionId, basename\(n\.rel\)\.replace\(\/\\\.md\$\/i, ''\), next, getSetting\)/.test(eaFn), '')
check('★ artifact.edit：失败返回 { ok:false, error }，不 throw',
  /if \(!gated\.ok\) return \{ ok: false, error: gated\.error \}/.test(eaFn) && !/throw new Error\(gated\.error\)/.test(eaFn), '')
check('★ artifact.edit：放行后把校正正文写回 next（落盘用的是过门结果）',
  /next = gated\.content/.test(eaFn), '')

// 12c. builtin.quiz.gen-paper：**有意豁免**（机械拼装，坏快照不该炸整卷）
const genBody = toolBody('builtin.quiz.gen-paper')
check('★ gen-paper：豁免注释存在（锁住「这是有意的，不是漏了」）',
  /题单质量门\*\*有意豁免\*\*/.test(genBody) && /快照/.test(genBody), '')
check('gen-paper：确实没有调用质量门（豁免已落实，不是注释与代码不一致）',
  genBody.length > 0 && !genBody.includes('gateQuizContentForWrite('), '')

// 12d. 清单式断言：所有「模型写 .md 正文」的入口都在这里
const mdWriteEntries = [
  ['vault.write', writeBody],
  ['vault.write-batch', batchBody],
  ['vault.edit', editBody],
  ['knowledge.create-page', createBody],
  ['artifact.edit', eaFn],
]
const missingMdEntries = mdWriteEntries.filter(([, body]) => !body.includes('gateQuizContentForWrite(')).map(([label]) => label)
check('★ 所有 .md 写入口清单齐全（write / write-batch / edit / create-page / artifact.edit）',
  missingMdEntries.length === 0, `缺：${missingMdEntries.join(', ') || '无'}`)

/** 执行级说明：`editArtifactText` 虽不依赖 ipcMain，但它所在的 `aiTeachingSources.ts` 静态 import
 *  electron / phrontis-core / src/*（素材库整条业务链），本脚本的 strip 装载器只 stage 相对 TS import、
 *  不解析裸包，故无法在纯 node 里低成本拉起 —— 「坏题单 .md 产物 → ok:false 且文件未被修改」这一条
 *  由上面的位置断言（门在 writeFileSync 之前 + 失败走 return）+ verify-quiz-quality.mjs 的 strict 用例
 *  共同覆盖；端到端落盘路径由 verify-all-p0 的端到端脚本负责。 */

/* ---------------------------------------------------------------- 报告 */

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

stager.cleanup()
process.exit(failed.length === 0 ? 0 : 1)
