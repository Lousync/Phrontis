#!/usr/bin/env node
/**
 * 契约验证：AI 教学「段会话错题回流」纯函数（`electron/lib/segmentWrongFeedbackPure.ts`）
 * 与主进程接线（`aiTeachingCourse.buildCourseInjection` / `agentService.requestInjection`）。
 *
 * 锁什么：
 *  1. 归属判定按**真实键**：题单页面路径落在本段产物夹前缀下（同段 / 嵌套 / 跨段 / 前缀边界 / 无路径）；
 *  2. 只认 `lastResult === 0`（最近一次答错），null / 1 一律不算；
 *  3. 最近 N 条 + 时间倒序（`updated_at`）；
 *  4. 题干 ≤40 字、标签 / 答案截断，正确优先于解析首句；
 *  5. 整块 ≤600 字，超了从最旧的丢；
 *  6. 无错题 → 空串（零注入，system 与请求级逐字不变）；
 *  7. 只进请求级（负向断言：systemFull 拼接里不出现错题标题）；
 *  8. 已收尾段不注入（块在 `curLesson.status !== 'ended'` 守卫内）。
 *
 * 运行（仓库根目录）：node .AGENT/scripts/ai-teaching/verify-segment-wrong-feedback.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const charLen = (s) => Array.from(String(s ?? '')).length

async function loadStripped(relPath, tmpName) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-teach-wrong-'))
  const tmpFile = path.join(tmpDir, tmpName)
  fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
  const mod = await import(pathToFileURL(tmpFile).href)
  return { mod, tmpDir }
}

const { mod: pure } = await loadStripped('electron/lib/segmentWrongFeedbackPure.ts', 'segmentWrongFeedbackPure.mjs')
const {
  SEGMENT_WRONG_HEADER,
  SEGMENT_WRONG_MAX_ITEMS,
  SEGMENT_WRONG_MAX_CHARS,
  pageBelongsToSegment,
  filterSegmentQuizPages,
  collectSegmentWrongItems,
  renderSegmentWrongRequestBlock,
  normalizeRelPath,
} = pure

const courseSrc = stripComments(fs.readFileSync(path.join(ROOT, 'electron/lib/aiTeachingCourse.ts'), 'utf8').replace(/\r\n/g, '\n'))
const agentSrc = stripComments(fs.readFileSync(path.join(ROOT, 'electron/lib/agentService.ts'), 'utf8').replace(/\r\n/g, '\n'))

const OWNER = 'AI教学/算法/第1章 图论/段1'
const PAGE_A = { pageId: 'id-a', relPath: `${OWNER}/测验·最短路径.md`, title: '测验·最短路径' }
const PAGE_B = { pageId: 'id-b', relPath: `${OWNER}/子目录/测验·图遍历.md`, title: '测验·图遍历' }
const PAGE_OTHER_SEG = { pageId: 'id-x', relPath: 'AI教学/算法/第1章 图论/段2/测验·最短路径.md', title: '测验·最短路径' }
const PAGE_SEG10 = { pageId: 'id-z', relPath: 'AI教学/算法/第1章 图论/段10/测验·最短路径.md', title: '测验·最短路径' }
const PAGE_NO_REL = { pageId: 'id-norel', title: '测验·无路径' }

const snap = (no, question, answer = '', explanation = '', extra = {}) => JSON.stringify({
  no,
  type: 'choice',
  question,
  options: [
    { key: 'A', text: '阿尔法选项文本' },
    { key: 'B', text: '贝塔选项文本' },
    { key: 'C', text: '伽马选项文本' },
  ],
  answer,
  explanation,
  ...extra,
})
const rec = (pageId, quizNo, lastResult, updatedAt, snapshotJson = '', pageTitle = '') => ({
  pageId, quizNo, lastResult, updatedAt, snapshotJson, pageTitle,
})

console.log('\n=== 1. 归属判定：本段产物夹路径前缀（真实键） ===')
check('★ 同段文件算本段', pageBelongsToSegment(PAGE_A.relPath, OWNER) === true, PAGE_A.relPath)
check('★ 本段下的嵌套产物夹也算', pageBelongsToSegment(PAGE_B.relPath, OWNER) === true, PAGE_B.relPath)
check('★ 兄弟段（同名题单）不算', pageBelongsToSegment(`${PAGE_OTHER_SEG.relPath}`, OWNER) === false, PAGE_OTHER_SEG.relPath)
check('★ 前缀边界：段1 不吃段10', pageBelongsToSegment(PAGE_SEG10.relPath, OWNER) === false, PAGE_SEG10.relPath)
check('★ 父目录文件不算（必须落在夹内）', pageBelongsToSegment('AI教学/算法/第1章 图论/段1.md', OWNER) === false, '')
check('反斜杠路径归一后仍能判定', pageBelongsToSegment(OWNER.replace(/\//g, '\\') + '\\测验·最短路径.md', OWNER) === true, '')
check('无 owner / 无路径一律不算', pageBelongsToSegment(PAGE_A.relPath, '') === false && pageBelongsToSegment('', OWNER) === false, '')
check('normalizeRelPath 去首尾斜杠 + 反斜杠转正', normalizeRelPath('/a\\b/') === 'a/b', normalizeRelPath('/a\\b/'))

const allPages = [PAGE_A, PAGE_B, PAGE_OTHER_SEG, PAGE_SEG10, PAGE_NO_REL]
const filtered = filterSegmentQuizPages(allPages, OWNER)
check('★ 过滤只保留本段两条（跨段 / 段10 / 无路径全丢）', filtered.length === 2 && filtered.map((p) => p.pageId).join(',') === 'id-a,id-b', filtered.map((p) => p.pageId).join(','))
check('空页表 / 非法输入不崩', filterSegmentQuizPages(null, OWNER).length === 0 && filterSegmentQuizPages([{}], OWNER).length === 0, '')

console.log('\n=== 2. 只认 lastResult === 0，且只算本段 ===')
const mixed = [
  rec('id-a', 1, 0, '2026-11-22 10:00:00', snap(1, '同段错题一', 'B')),
  rec('id-a', 2, 1, '2026-11-22 10:05:00', snap(2, '同段已答对', 'A')),
  rec('id-a', 3, null, '2026-11-22 10:06:00', snap(3, '从未作答', 'A')),
  rec('id-x', 1, 0, '2026-11-22 10:07:00', snap(1, '跨段错题', 'A')),
  rec('id-z', 1, 0, '2026-11-22 10:08:00', snap(1, '段10 错题', 'A')),
  rec('id-b', 1, 0, '2026-11-22 10:09:00', snap(1, '同段错题二', 'C', '', { type: 'short', options: [], answer: '', referenceAnswer: '先做拓扑排序。再做松弛。' })),
  rec('unknown', 1, 0, '2026-11-22 10:10:00', snap(1, '题单不在本段', 'A')),
]
const items = collectSegmentWrongItems({ ownerRel: OWNER, pages: allPages, records: mixed })
check('★ 只留 2 条（null / 答对 / 跨段 / 段10 / 不在页表 全部排除）', items.length === 2, items.map((i) => `${i.pageId}#${i.quizNo}`).join(','))
check('★ 时间倒序：10:09 先于 10:00', items[0]?.pageId === 'id-b' && items[1]?.pageId === 'id-a', items.map((i) => i.updatedAt).join(','))
check('跨段错题不进摘要', !renderSegmentWrongRequestBlock({ ownerRel: OWNER, pages: allPages, records: mixed }).includes('跨段错题'), '')

console.log('\n=== 3. 最近 N 条 + 时间倒序 ===')
const many = []
for (let n = 1; n <= 7; n++) {
  many.push(rec('id-a', n, 0, `2026-11-22 1${n}:00:00`, snap(n, `第${n}题的题干`)))
}
const recent = collectSegmentWrongItems({ ownerRel: OWNER, pages: allPages, records: many })
check(`★ 默认最多 ${SEGMENT_WRONG_MAX_ITEMS} 条`, recent.length === SEGMENT_WRONG_MAX_ITEMS, String(recent.length))
check('★ 取最新 5 条：题号 7,6,5,4,3', recent.map((i) => i.quizNo).join(',') === '7,6,5,4,3', recent.map((i) => i.quizNo).join(','))
const recentBlock = renderSegmentWrongRequestBlock({ ownerRel: OWNER, pages: allPages, records: many })
check('最新一条在块里、最旧两条不在', recentBlock.includes('第7题') && !recentBlock.includes('第1题') && !recentBlock.includes('第2题'), '')
check('maxItems 可显式调小', collectSegmentWrongItems({ ownerRel: OWNER, pages: allPages, records: many, maxItems: 2 }).length === 2, '')
check('maxItems 0 / 负数 → 空', collectSegmentWrongItems({ ownerRel: OWNER, pages: allPages, records: many, maxItems: 0 }).length === 0, '')

console.log('\n=== 4. 字段口径：标签 / 题干截断 / 正确答案或解析首句 ===')
const longQ = '这是一道非常长的题干'.repeat(12)
const fieldCases = [
  rec('id-a', 11, 0, '2026-11-22 12:00:00', snap(11, longQ, 'B'), '测验·最短路径'),
  rec('id-a', 12, 0, '2026-11-22 11:00:00', snap(12, '没有答案但有解析', '', '第一句结论。第二句不该出现。')),
  rec('id-a', 13, 0, '2026-11-22 10:00:00', snap(13, '简答题', '', '参考要点。补充说明。', { type: 'short', options: [], answer: '', referenceAnswer: '参考答案首句。后面的不要。' })),
]
const fieldItems = collectSegmentWrongItems({ ownerRel: OWNER, pages: allPages, records: fieldCases })
check('题干截断 ≤ 40 字（含省略号）', charLen(fieldItems[0].question) <= 40 && fieldItems[0].question.endsWith('…'), `${charLen(fieldItems[0].question)} / ${fieldItems[0].question}`)
check('题单标签去掉「测验·」前缀', fieldItems[0].label === '最短路径', fieldItems[0].label)
check('选择题给正确答案 + 选项文本', fieldItems[0].answer === '正确答案：B. 贝塔选项文本', fieldItems[0].answer)
check('无答案时退回解析首句（只取第一句）', fieldItems[1].answer === '解析：第一句结论', fieldItems[1].answer)
check('简答题给参考答案（首句）', fieldItems[2].answer === '参考答案：参考答案首句', fieldItems[2].answer)
check('无快照题干 → 占位而不是崩', collectSegmentWrongItems({
  ownerRel: OWNER, pages: allPages, records: [rec('id-a', 1, 0, '2026-11-22 10:00:00', 'not-json')],
})[0].question === '（题干未留存）', '')

// 2026-11-23：ASCII `.` 不能无脑当句末 —— 小数 / 缩写 / URL 会被切坏
const dotCases = [
  ['1.5', '1.5'],
  ['0.75 米', '0.75 米'],
  ['Dr. Smith', 'Dr. Smith'],
  ['https://a.b/c', 'https://a.b/c'],
]
const dotAnswers = dotCases.map(([text], i) => collectSegmentWrongItems({
  ownerRel: OWNER,
  pages: allPages,
  records: [rec('id-a', 30 + i, 0, `2026-11-22 09:0${i}:00`, snap(30 + i, '题', '', '', { type: 'short', options: [], answer: '', referenceAnswer: text }))],
})[0]?.answer)
check('★ 小数点不被当句末（1.5 / 0.75 米）', dotAnswers[0] === '参考答案：1.5' && dotAnswers[1] === '参考答案：0.75 米', JSON.stringify(dotAnswers.slice(0, 2)))
check('★ 英文缩写不被当句末（Dr. Smith）', dotAnswers[2] === '参考答案：Dr. Smith', JSON.stringify(dotAnswers[2]))
check('★ URL 不被当句末（https://a.b/c）', dotAnswers[3] === '参考答案：https://a.b/c', JSON.stringify(dotAnswers[3]))
check('真正的句末仍然断开（。 / 英文句号+空格）', (() => {
  const a = collectSegmentWrongItems({ ownerRel: OWNER, pages: allPages, records: [rec('id-a', 40, 0, '2026-11-22 08:00:00', snap(40, '题', '', '', { type: 'short', options: [], answer: '', referenceAnswer: '第一句。第二句' }))] })[0].answer
  const b = collectSegmentWrongItems({ ownerRel: OWNER, pages: allPages, records: [rec('id-a', 41, 0, '2026-11-22 08:01:00', snap(41, '题', '', 'First sentence. Second sentence.'))] })[0].answer
  return a === '参考答案：第一句' && b === '解析：First sentence'
})(), '')

// 2026-11-23：快照 answer 不在选项 key 里 → 不写「正确答案：Z」，退回解析
const badKeyItems = collectSegmentWrongItems({
  ownerRel: OWNER,
  pages: allPages,
  records: [rec('id-a', 20, 0, '2026-11-22 09:30:00', snap(20, '答案 key 写错', 'Z', '真实解析句。第二句。'))],
})
check('★ answer 不在选项 key 里 → 退回解析首句（不写「正确答案：Z」）',
  badKeyItems[0].answer === '解析：真实解析句' && !badKeyItems[0].answer.includes('Z'), badKeyItems[0].answer)
const badKeyWithRef = collectSegmentWrongItems({
  ownerRel: OWNER,
  pages: allPages,
  records: [rec('id-a', 21, 0, '2026-11-22 09:31:00', snap(21, '答案 key 写错但有参考答案', 'Z', '', { referenceAnswer: '参考要点。补充。' }))],
})
check('answer 不在 key 但另有参考答案 → 用参考答案', badKeyWithRef[0].answer === '参考答案：参考要点', badKeyWithRef[0].answer)

// 2026-11-23：旧 record quizNo 缺省（0）不显示「第0题」
const noNoBlock = renderSegmentWrongRequestBlock({
  ownerRel: OWNER, pages: allPages, records: [rec('id-a', 0, 0, '2026-11-22 07:00:00', snap(1, '没有题号的旧记录', 'A'))],
})
check('★ quizNo 缺省时不显示「第0题」', !noNoBlock.includes('第0题') && /^- 最短路径：没有题号的旧记录 → /m.test(noNoBlock), JSON.stringify(noNoBlock))

const rendered = renderSegmentWrongRequestBlock({ ownerRel: OWNER, pages: allPages, records: fieldCases })
check('渲染形状：`- 标签 · 第N题：题干 → 答案`', /^- 最短路径 · 第11题：.+ → 正确答案：B\. /m.test(rendered), rendered.split('\n')[1] ?? '')
check('标题逐字等于约定文案', rendered.startsWith(SEGMENT_WRONG_HEADER + '\n'), SEGMENT_WRONG_HEADER)

console.log('\n=== 5. 字数上限：超了从最旧的丢 ===')
const longItems = []
for (let n = 1; n <= 5; n++) {
  longItems.push(rec('id-a', n, 0, `2026-11-22 1${n}:00:00`, snap(n, `${'很长的题干内容'.repeat(10)}${n}`, 'A')))
}
const defaultBlock = renderSegmentWrongRequestBlock({ ownerRel: OWNER, pages: allPages, records: longItems })
check(`★ 默认整块 ≤ ${SEGMENT_WRONG_MAX_CHARS} 字`, charLen(defaultBlock) <= SEGMENT_WRONG_MAX_CHARS, String(charLen(defaultBlock)))
const tightBlock = renderSegmentWrongRequestBlock({ ownerRel: OWNER, pages: allPages, records: longItems, maxChars: 180 })
check('★ 收紧上限后整块 ≤ 180 字', charLen(tightBlock) <= 180, String(charLen(tightBlock)))
check('★ 从最旧丢：保留最新题，最旧题消失', tightBlock.includes('第5题') && !tightBlock.includes('第1题'), tightBlock.split('\n').map((l) => l.slice(0, 12)).join(' | '))
check('截断后仍是「标题 + 条目」结构（不截在标题中间）', tightBlock.startsWith(SEGMENT_WRONG_HEADER), '')
check('上限小于标题长度时退化为「只留标题」且不超限', (() => {
  const tiny = renderSegmentWrongRequestBlock({ ownerRel: OWNER, pages: allPages, records: longItems, maxChars: 5 })
  return tiny.startsWith(SEGMENT_WRONG_HEADER) && charLen(tiny) <= charLen(SEGMENT_WRONG_HEADER) + 1
})(), '')

console.log('\n=== 6. 无错题 → 零注入（空串） ===')
check('无记录 → 空串', renderSegmentWrongRequestBlock({ ownerRel: OWNER, pages: allPages, records: [] }) === '', '')
check('全答对／从未作答 → 空串', renderSegmentWrongRequestBlock({
  ownerRel: OWNER, pages: allPages, records: [rec('id-a', 1, 1, '2026-11-22 10:00:00', snap(1, '答对')), rec('id-a', 2, null, '2026-11-22 10:01:00', snap(2, '没做'))],
}) === '', '')
check('题单都不在本段 → 空串', renderSegmentWrongRequestBlock({
  ownerRel: OWNER, pages: allPages, records: [rec('id-x', 1, 0, '2026-11-22 10:00:00', snap(1, '跨段'))],
}) === '', '')
check('参数缺省不崩', renderSegmentWrongRequestBlock() === '' && renderSegmentWrongRequestBlock({}) === '', '')

console.log('\n=== 7. 主进程接线：归属用写盘同一 owner，只认 quiz 围栏 ===')
check('★ 段产物夹解析走 resolveWriteOwnerRel（与 archiveOrganizedPage 同一口径）', /resolveWriteOwnerRel\(sessionId, getSetting\)/.test(courseSrc), '')
check('夹还没建时回退 lessonFolderRel', /resolveWriteOwnerRel\(sessionId, getSetting\) \?\? lessonFolderRel\(sessionId, getSetting\)/.test(courseSrc), '')
check('★ 页面身份：frontmatter id，缺省 auto:<仓库相对路径>', /readFrontmatterId\(text\) \|\| `auto:\$\{rel\}`/.test(courseSrc), '')
check('★ 题目身份：只认含 ```quiz 围栏的 .md（不按标题匹配）', /if \(!hasQuizFence\(text\)\) continue/.test(courseSrc) && !/测验\[·-\]/.test(courseSrc), '')
check('扫描有文件数 / 深度上限（不无界遍历）', /SEGMENT_QUIZ_SCAN_MAX_FILES = 80/.test(courseSrc) && /SEGMENT_QUIZ_SCAN_MAX_DEPTH = 3/.test(courseSrc), '')
check('记录先按本段 pageId 收窄再交给纯函数', /const pageIds = new Set\(quiz\.pages\.map\(\(p\) => p\.pageId\)\)/.test(courseSrc) && /filter\(\(r\) => pageIds\.has\(String\(r\.page_id\)\)\)/.test(courseSrc), '')
check('纯函数出参挂到 requestOut.wrongBlock', /if \(wrongBlock && requestOut\) requestOut\.wrongBlock = wrongBlock/.test(courseSrc), '')

console.log('\n=== 8. 只进请求级（错题标题绝不进 systemFull） ===')
check('★ 错题块不 push 进 system 行（负向）', !courseSrc.includes('lines.push(wrongBlock)') && !courseSrc.includes('SEGMENT_WRONG_HEADER'), '')
check('★ buildCourseInjection 出参声明含 wrongBlock', /requestOut\?: \{ block: string; wrongBlock\?: string \}/.test(courseSrc), '')
check('★ 出参每轮先清空两个块（旧块不残留）', /requestOut\.block = ''\n\s*requestOut\.wrongBlock = ''/.test(courseSrc), '')
check('★ agentService 把台账 + 错题拼进 requestInjection 层', /\[courseRequestOut\.block, courseRequestOut\.wrongBlock\]\.filter\(Boolean\)\.join\('\\n\\n'\)/.test(agentSrc), '')
const requestInjectionLine = (agentSrc.match(/const requestInjection = \[[^\]]*\]/) || [''])[0]
check('requestInjection 数组含 courseRequestHint', requestInjectionLine.includes('courseRequestHint'), requestInjectionLine.slice(0, 140))
const systemFullBlock = (agentSrc.match(/const systemFull = manual[\s\S]*?\n\n/) || [''])[0]
check('★ systemFull 拼接不含错题标题 / wrongBlock（负向，防打散 prompt cache 前缀）',
  systemFullBlock !== '' && !systemFullBlock.includes(SEGMENT_WRONG_HEADER) && !systemFullBlock.includes('wrongBlock') && !systemFullBlock.includes('错题'),
  systemFullBlock.slice(-120))

console.log('\n=== 9. 已收尾段不注入 ===')
const gate = /if \(curLesson\.status !== 'ended' && !isCourseEnded\(wsId\)\) \{([\s\S]*?)\n  const handoff = readPrevHandoff/.exec(courseSrc)
check('★ 台账与错题块同在 open 段 + 课程未结课守卫内（ended / 已结课零注入）',
  !!gate && gate[1].includes('requestOut.block = requestBlock') && gate[1].includes('renderSegmentWrongRequestBlock'),
  gate ? '' : 'guard not found')
check('★ 已结课课程不再注入（!isCourseEnded(wsId)）', /curLesson\.status !== 'ended' && !isCourseEnded\(wsId\)/.test(courseSrc), '')
check('ended 分支确实存在（守卫不是空壳）', /if \(curLesson\.status === 'ended'\) \{/.test(courseSrc), '')

console.log('\n========================================')
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  if (!c.pass) console.log(`[FAIL] ${c.name}  ${c.detail}`)
}
if (failed.length === 0) {
  console.log(`PASS -- ${checks.length}/${checks.length} assertions passed`)
  process.exit(0)
}
console.log(`FAIL -- ${checks.length - failed.length}/${checks.length} assertions passed`)
process.exit(1)
