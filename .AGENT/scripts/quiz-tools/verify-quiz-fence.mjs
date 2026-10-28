// 契约验证：builtin.quiz.gen-paper 落盘的练习页能否被真实 QuizParser 解析成题卡。
//
// 为什么需要它：gen-paper 生成的 .md 必须让 extractQuizzes 认出题目、
// 且题号必须重排为 1..N —— 否则答题回报 (pageId, quizNo) 会与页面题序错位，
// 错题回流就记到了错误的题上。这是整条「错题 → 组卷 → 重练 → 回流」闭环里
// 最容易静默出错的一环，所以用真实解析器而不是复制品来验。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/quiz-tools/verify-quiz-fence.mjs
// 期望：输出 PASS 且 exit=0

import { extractQuizzes, parseQuizFence, preprocessContent, duplicateQuizNos } from '../../../src/components/shared/QuizParser.ts'
import { ensureQuizDocFrontmatter, sameQuizDocBody } from '../../../electron/lib/quizDocPure.ts'

// 记录里的快照：no 是它在"原页面"的序号，组卷时必须重排
const snapshot = {
  no: 7,
  question: '关于二叉树的遍历，下列说法正确的是？',
  options: [
    { key: 'A', text: '前序遍历先访问根结点' },
    { key: 'B', text: '中序遍历先访问左子树' },
    { key: 'C', text: '后序遍历先访问右子树' },
    { key: 'D', text: '层序遍历使用栈实现' },
  ],
  answer: 'A',
  explanation: '前序遍历顺序为 根→左→右。',
}

// ↓↓↓ 与 electron/lib/builtinTools.ts 中 builtin.quiz.gen-paper 的落盘代码逐字一致 ↓↓↓
const picked = [snapshot]
const lines = []
lines.push('# 错题重练 · 2026-09-12')
lines.push('')
lines.push('> 由错题本自动组卷（全部学习空间），共 1 题，生成于 2026-09-12。')
lines.push('> 直接在本页作答：答错的题会自动回流到错题本，答对两次即视为已掌握。')
lines.push('')
picked.forEach((snap, i) => {
  lines.push('```quiz')
  lines.push(JSON.stringify({
    no: i + 1,
    points: '',
    question: snap.question,
    options: snap.options,
    answer: snap.answer,
    explanation: snap.explanation || '',
  }))
  lines.push('```')
  lines.push('')
})
const md = lines.join('\n')
// ↑↑↑ 改动上面这段时，务必同步 builtinTools.ts 的 gen-paper 实现 ↑↑↑

console.log('--- 生成的页面 markdown ---')
console.log(md)
console.log('--- QuizParser 解析结果 ---')
const items = extractQuizzes(md)
console.log('extracted =', items.length)

if (items.length !== 1) {
  console.error(`FAIL: 期望解析出 1 题，实得 ${items.length}`)
  process.exit(1)
}
const q = items[0]
const checks = [
  ['题号已重排为 1', q.no === 1],
  ['选项 4 个', q.options.length === 4],
  ['答案可取', q.answer === 'A'],
  ['题干含关键词', q.question.includes('二叉树')],
  ['解析可取', q.explanation.includes('根→左→右')],
]
let pass = true
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}`)
  if (!ok) pass = false
}
console.log(pass ? 'PASS: 围栏格式与 QuizParser 契约一致' : 'FAIL: 字段不符')

// ===== v3.1.1 条目13：字符串内未转义引号反向修复 + 合法 JSON 不被误改 =====
const { parseQuizFenceLoose, repairJsonQuotes } = await import('../../../src/components/shared/QuizParser.ts')

console.log('\n--- 条目13：解析层反向修复 ---')
// 翻车原文：题干字符串内含未转义英文双引号（实测形态，"底分" 把 JSON 截断）
const breakJson = '{"no":1,"points":"2","question":"鲁滨逊在木筏上说的\\"底分\\"是什么","options":[{"key":"A","text":"选项一"},{"key":"B","text":"选项二"}],"answer":"A","explanation":"解析"}'
  .replace(/\\"/g, '"')
const fixed = parseQuizFenceLoose(breakJson)
const fwDelimJson = '{"no":1,"points":"","question":"题干","options":[{"key":"A","text":"甲"},{"key":"B","text":"乙"}],"answer":"B","explanation":""}'.replace(/"/g, '“')
const repairChecks = [
  ['字符串内英文引号翻车原文 → 修复后解析出题', fixed !== null && fixed.question.includes('底分') && fixed.answer === 'A'],
  ['合法 JSON 原文不被误改', repairJsonQuotes('{"a":"x, y","b":"}"}') === '{"a":"x, y","b":"}"}'],
  ['正常收尾引号（后随 , } ] :）保持结构', repairJsonQuotes('{"a":"v","b":1}') === '{"a":"v","b":1}'],
  ['转义对 \" 原样保留不重复修复', repairJsonQuotes('{"a":"说\\"你好\\""}') === '{"a":"说\\"你好\\""}'],
  ['全角引号瑕疵旧路径不回归', (() => { const q = parseQuizFenceLoose(fwDelimJson); return q !== null && q.answer === 'B' })()],
  ['无效输入仍返回 null（不误报成题）', parseQuizFenceLoose('｛｝不是 JSON') === null],
]
for (const [name, ok] of repairChecks) {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}`)
  if (!ok) pass = false
}

// ===== v3.1.1 条目15：分值字段不渲染 =====
// 2026-09-13 开发负责人拍板：分值徽章整个移除（此前是「2分 分」归一化）。契约 = QuizCard 不再渲染 points；
// 解析层/类型仍容忍该字段（存量数据兼容），gen-paper 落盘 points:'' 不变（不可见）。
console.log('\n--- 条目15：分值徽章已移除 ---')
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const { dirname, join } = await import('node:path')
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..') // .AGENT/scripts/quiz-tools → 仓库根
const cardSrc = readFileSync(join(repoRoot, 'src', 'components', 'shared', 'QuizCard.tsx'), 'utf8')
const svcSrc = readFileSync(join(repoRoot, 'electron', 'lib', 'agentService.ts'), 'utf8')
const pointsChecks = [
  ['QuizCard 不再渲染分值徽章（points 不出现在 JSX）', !/quiz\.points/.test(cardSrc)],
  ['提示词示例已去掉 points 字段（agentService quizRuleHint）', !/"points":"2/.test(svcSrc.match(/【出题格式规则[\s\S]*?'/)?.[0] ?? '')],
]
for (const [name, ok] of pointsChecks) {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}`)
  if (!ok) pass = false
}
console.log(pass ? 'PASS: 条目15 归一化契约一致' : 'FAIL: 归一化不符')

// ===== 简答题：新协议 / 围栏提取 / 旧 <details> 兼容 =====
console.log('\n--- 简答题与旧格式兼容 ---')
const shortJson = JSON.stringify({
  type: 'short',
  no: 2,
  question: '简述接口的功能',
  referenceAnswer: '① 地址译码；② 数据缓冲（集合 {a,b}）',
  explanation: '补充说明',
})
const shortItem = parseQuizFence(shortJson)
const mixedMd = [
  '```quiz',
  JSON.stringify({ no: 1, question: '选择题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answer: 'A', explanation: '' }),
  '```',
  '',
  '```quiz',
  shortJson,
  '```',
].join('\n')
const mixed = extractQuizzes(mixedMd)
const detailsMd = [
  '<details>',
  '<summary>参考答案</summary>',
  '',
  '**解析**：先译码，再缓冲。',
  '</details>',
].join('\n')
const detailsOut = preprocessContent(detailsMd)
const codeFencedDetails = ['```md', '<details><summary>答案</summary>', 'x', '</details>', '```'].join('\n')
const codeFencedOut = preprocessContent(codeFencedDetails)
const legacyShort = ['### 第 1 题（10 分）', '题干', '', '```spoiler-answer', '**解析**：要点', '```'].join('\n')
const legacyShortOut = preprocessContent(legacyShort)
const dup = duplicateQuizNos([
  { type: 'short', no: 1 },
  { type: 'choice', no: 1 },
  { type: 'short', no: 2 },
])
const quizDoc = ensureQuizDocFrontmatter('练习·接口', mixedMd, 'id-fixed')
const plainDoc = ensureQuizDocFrontmatter('讲义', '# 普通讲义', 'id-x')
const shortChecks = [
  ['简答题解析出 type=short', shortItem?.type === 'short'],
  ['简答题 referenceAnswer 可取', shortItem?.referenceAnswer.includes('地址译码')],
  ['简答题 options 归一为空数组', Array.isArray(shortItem?.options) && shortItem.options.length === 0],
  ['混合卷提取 2 题', mixed.length === 2 && mixed[1].type === 'short'],
  ['参考答案里的 } 不截断', mixed[1]?.referenceAnswer.includes('{a,b}')],
  ['缺 referenceAnswer 的简答题拒绝', parseQuizFence(JSON.stringify({ type: 'short', no: 1, question: 'q' })) === null],
  ['未知 type 拒绝', parseQuizFence(JSON.stringify({ type: 'essay', no: 1, question: 'q' })) === null],
  ['<details> 转 spoiler-answer', detailsOut.includes('```spoiler-answer') && !detailsOut.includes('<details>')],
  ['代码围栏内的 <details> 不改', codeFencedOut === codeFencedDetails],
  ['408 简答块不误转选择题', legacyShortOut.includes('spoiler-answer') && !legacyShortOut.includes('```quiz')],
  ['重复题号可检出', dup.length === 1 && dup[0] === 1],
  ['题单落盘写 frontmatter id', /^---\nid: id-fixed\n/.test(quizDoc)],
  ['题单 frontmatter 幂等比较', sameQuizDocBody(quizDoc, mixedMd)],
  ['非 quiz 文档不注入 frontmatter', plainDoc === '# 普通讲义'],
]
for (const [name, ok] of shortChecks) {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}`)
  if (!ok) pass = false
}
console.log(pass ? 'PASS: 简答题与旧格式契约一致' : 'FAIL: 简答题契约不符')
process.exit(pass ? 0 : 1)
