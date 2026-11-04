/**
 * 契约验证：题单「提取答案」纯函数 + `QuizSheetBar` 接线。
 *
 * 锁口径：
 *  1. 题号升序；未作答也列出；
 *  2. 选择题只写 picked；简答题保留多行原文；
 *  3. 不导出正确答案 / 解析 / 参考答案 / 自评 / 错题次数 / 题干；
 *  4. 头部带判分指令与题单标题；无标题回退「当前题单」；
 *  5. QuizSheetBar 有「提取答案」按钮、无作答禁用、复制走 copyText + Toast。
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/quiz-tools/verify-answer-export.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAnswerExport } from '../../../src/components/shared/quizAnswerExportPure.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

const q = (no, type, extra = {}) => ({
  type,
  no,
  points: '',
  question: `Q${no} 题干`,
  options: [],
  answer: 'ZZZ_CORRECT',
  referenceAnswer: 'ZZZ_REFERENCE',
  explanation: 'ZZZ_EXPLANATION',
  ...extra,
})
const rec = (quizNo, picked, text, extra = {}) => ({
  quizNo,
  draft: { picked, text, revealed: false, assessedText: 'ZZZ_ASSESSED', updatedAt: '2026-11-03 10:00:00' },
  lastResult: 0,
  ...extra,
})

console.log('=== 1. 基本格式 / 排序 / 多行简答 ===')
const quizzes = [q(3, 'short'), q(1, 'choice'), q(4, 'short'), q(2, 'choice')]
const records = [
  rec(1, 'B', ''),
  rec(2, null, ''),
  rec(3, null, '进程是资源分配单位，线程是调度单位……\n① 进程有独立地址空间\n② 线程共享地址空间'),
  rec(4, null, '   \n\t'),
]
const r = buildAnswerExport({ title: '第二章 进程管理 · 自测', quizzes, records })
console.log(r.text)
check('有作答题数 = 2', r.answered === 2, JSON.stringify(r))
check('选择 / 简答计数', r.choiceAnswered === 1 && r.shortAnswered === 1, JSON.stringify(r))
check('总题数 = 4', r.total === 4, String(r.total))
check('首行是题单标题', r.text.startsWith('【题单作答】《第二章 进程管理 · 自测》'), r.text.split('\n')[0])
check('第二行是判分指令', r.text.split('\n')[1].includes('请对照本题单判分'), r.text.split('\n')[1])
check('题号升序 1..4', /^1\. \[选择\] B$/m.test(r.text) && /^4\. \[简答\] 未作答$/m.test(r.text), '')
check('选择题只写 key', r.text.includes('1. [选择] B') && !r.text.includes('1. [选择] ZZ'), '')
check('未作答也列出', r.text.includes('2. [选择] 未作答') && r.text.includes('4. [简答] 未作答'), '')
check('简答题保留多行原文', r.text.includes('3. [简答]\n进程是资源分配单位，线程是调度单位……\n① 进程有独立地址空间\n② 线程共享地址空间'), '')
check('不导出正确答案', !r.text.includes('ZZZ_CORRECT'), '')
check('不导出解析', !r.text.includes('ZZZ_EXPLANATION'), '')
check('不导出参考答案', !r.text.includes('ZZZ_REFERENCE'), '')
check('不导出自评', !r.text.includes('ZZZ_ASSESSED') && !r.text.includes('自评'), '')
check('不导出题干', !r.text.includes('Q1 题干'), '')
check('不导出错题次数 / lastResult', !r.text.includes('lastResult'), '')

console.log('\n=== 2. 全未作答 / 标题回退 / 多选 key ===')
const allEmpty = buildAnswerExport({ quizzes: [q(1, 'choice'), q(2, 'short')], records: [] })
check('全未作答 answered=0', allEmpty.answered === 0, JSON.stringify(allEmpty))
check('无标题回退当前题单', allEmpty.text.startsWith('【题单作答】《当前题单》'), allEmpty.text.split('\n')[0])
check('全未作答逐题列出', allEmpty.text.includes('1. [选择] 未作答') && allEmpty.text.includes('2. [简答] 未作答'), '')
const multi = buildAnswerExport({ title: 'T', quizzes: [q(1, 'choice')], records: [rec(1, 'ABD', '')] })
check('多选 key 原样保留', multi.text.includes('1. [选择] ABD'), multi.text)
const legacy = buildAnswerExport({ title: 'T', quizzes: [q(1, 'choice')], records: [{ quizNo: 1, draft: null, lastResult: 1 }] })
check('只有 lastResult、无 draft → 未作答（旧记录不冒充作答）', legacy.answered === 0 && legacy.text.includes('未作答'), legacy.text)

console.log('\n=== 3. QuizSheetBar 接线 ===')
const bar = fs.readFileSync(path.join(ROOT, 'src/components/shared/QuizSheetBar.tsx'), 'utf8')
check('按钮图标 ClipboardCopy', bar.includes('ClipboardCopy'))
check('调用纯函数 buildAnswerExport', bar.includes('buildAnswerExport({ title: store.pageTitle, quizzes, records })'))
check('点击时取最新记录', bar.includes('store.getRecords()'))
check('走主进程 copyText', bar.includes('await copyText(latest.text)'))
check('成功 / 失败 Toast', bar.includes('复制失败') && bar.includes('粘贴给 AI 即可判题'))
check('无作答禁用', bar.includes('disabled={answerExport.answered === 0}'))
check('按钮文案「提取答案」', bar.includes('提取答案'))
check('按钮在「错题重做」左边', bar.indexOf('提取答案') < bar.indexOf('错题重做'), '')

/* 宿主接线（2026-11-04 用户反馈：AI 教学区的分页/页签查看模式也要能提取答案）：
   工件栏 md 页签解析题单并渲染同一条 QuizSheetBar；没有题单内重做视图，故不传 onReview。 */
const artPane = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/ArtifactsPane.tsx'), 'utf8')
check('工件栏 md 页签解析 quizzes', artPane.includes('extractQuizzes(tab.content'), '')
check('工件栏渲染 QuizSheetBar', artPane.includes('<QuizSheetBar quizzes={quizzes} store={quizStore} />'), '')
check('工件栏不传 onReview（无题单内重做视图，不能留死按钮）', !/<QuizSheetBar[^>]*onReview=/.test(artPane), '')

const help = fs.readFileSync(path.join(ROOT, 'resources/help/AI 教学 · 课程模式.md'), 'utf8')
check('帮助文档提到「提取答案」', help.includes('提取答案'), '')

const fails = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ` —— ${c.detail}`}`)
console.log(fails.length ? `\n${fails.length} FAIL` : `\nALL PASS (${checks.length}/${checks.length})`)
process.exit(fails.length ? 1 : 0)
