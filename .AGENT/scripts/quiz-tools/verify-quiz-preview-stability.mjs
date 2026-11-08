// 契约验证：B-50 题单展开/收起参考答案时页面乱跳 —— 渲染稳定性的语义钉住。
//
// 背景（docs/pending-fixes.md B-50）：toggleReveal / 500ms 草稿防抖会走 store.saveDraft →
// rebuild()。rebuild 无条件换新 summary 对象 + PageEditor 整页 useQuizSummary 订阅 +
// MarkdownPreview 收到内联回调 ⇒ memo 失效 → 正文子树整棵重挂 → 滚动跳动 / 焦点丢失。
//
// 本脚本两层钉住（DOM 身份与滚动的运行期断言在 probe-quiz-preview-stability.mjs）：
//   1) 纯函数：summary 统计口径 + 结构共享判定（store.rebuild 的行为真源）
//   2) 静态断言：切断「页面级重渲染 → 子树重挂」链条的四处关键代码形状（防回归）
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/quiz-tools/verify-quiz-preview-stability.mjs
// 期望：输出 PASS 且 exit=0

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeQuizSummary, quizSummaryEqual } from '../../../src/components/shared/quizSummaryPure.ts'

const proj = join(dirname(fileURLToPath(import.meta.url)), '../../..')

let pass = true
const check = (name, ok) => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}`)
  if (!ok) pass = false
}

console.log('--- summary 统计口径（computeQuizSummary） ---')
check('空记录 → 0/0/0', JSON.stringify(computeQuizSummary([])) === '{"answered":0,"wrong":0,"drafts":0}')
check('lastResult 有值计已答（对错都算）',
  computeQuizSummary([{ lastResult: 1, draft: null }, { lastResult: 0, draft: null }]).answered === 2)
check('lastResult=0 计错题',
  computeQuizSummary([{ lastResult: 0, draft: null }]).wrong === 1)
check('未判题且有草稿文本计草稿',
  computeQuizSummary([{ lastResult: null, draft: { text: '答' } }]).drafts === 1)
check('未判题但草稿只有 revealed 不计草稿（text 口径）',
  computeQuizSummary([{ lastResult: null, draft: { text: '', revealed: true } }]).drafts === 0)
check('选择题 picked 不计草稿（同原实现：只看 text）',
  computeQuizSummary([{ lastResult: null, draft: { text: '', picked: 'B' } }]).drafts === 0)
check('判过题的草稿文本不再计草稿',
  computeQuizSummary([{ lastResult: 1, draft: { text: '答' } }]).drafts === 0)

console.log('\n--- 结构共享判定（quizSummaryEqual） ---')
const a = { answered: 2, wrong: 1, drafts: 3 }
check('同数字不同对象 → 相等（rebuild 应复用旧对象）', quizSummaryEqual(a, { answered: 2, wrong: 1, drafts: 3 }))
check('revealed 翻转场景：数字不变 → 相等', quizSummaryEqual(a, computeQuizSummary([
  { lastResult: 1, draft: null },
  { lastResult: 0, draft: { text: '答' } },
  { lastResult: null, draft: { text: '草' } },
  { lastResult: null, draft: { text: '草' } },
  { lastResult: null, draft: { text: '草' } },
])))
check('answered 变 → 不相等', !quizSummaryEqual(a, { ...a, answered: 3 }))
check('wrong 变 → 不相等', !quizSummaryEqual(a, { ...a, wrong: 0 }))
check('drafts 变 → 不相等', !quizSummaryEqual(a, { ...a, drafts: 0 }))

console.log('\n--- 静态断言：页面级重渲染切断 ---')
const readSrc = (rel) => readFileSync(join(proj, rel), 'utf8')
const pageEditor = readSrc('src/modules/knowledge/components/PageEditor.tsx')
const store = readSrc('src/components/shared/QuizRecordStore.tsx')
const shortCard = readSrc('src/components/shared/ShortAnswerCard.tsx')

check('PageEditor 不再页面级订阅 summary（B-50 修复 1）',
  !pageEditor.includes('const quizSummary = useQuizSummary'))
check('错题数订阅收进 WrongRedoMenuItem 小组件',
  /function WrongRedoMenuItem\(/.test(pageEditor) && /useQuizSummary\(store\)/.test(pageEditor))
check('resolveInternalLink 已 useCallback',
  pageEditor.includes('const resolveInternalLink = useCallback('))
check('MarkdownPreview 的 onWikiLink 不再是内联箭头（memo 生效的前提）',
  /onWikiLink=\{handleWikiLink\}/.test(pageEditor) && !/onWikiLink=\{\w+ =>/.test(pageEditor))
check('MarkdownPreview 的 onLinkClick 不再是内联箭头',
  /onLinkClick=\{handlePreviewLinkClick\}/.test(pageEditor) && !/onLinkClick=\{\w+ =>/.test(pageEditor))
check('store.rebuild 结构共享：数字不变复用旧 summary 对象',
  store.includes('quizSummaryEqual(summary, this.summarySnapshot)') &&
  !store.includes('this.summarySnapshot = { answered'))
check('ShortAnswerCard revealed 同步初始化（重挂场景不闪「先收起一帧」）',
  shortCard.includes('useState(() => (redo ? false : !!record?.draft?.revealed))'))

// React #310 防回归（2026-11-07 实测）：PageEditor 在 `if (!page) return` 早退之后不得再调任何
// hooks —— 首帧走早退、加载完成那一帧 hooks 数变多，直接崩掉页面渲染。
{
  const early = pageEditor.indexOf('if (!page) return (')
  check('PageEditor 早退分支存在', early > -1)
  const hooksAfter = (pageEditor.slice(early).match(
    /\buse(?:Callback|Memo|State|Effect|Ref|SyncExternalStore|QuizSummary|QuizRecordStore|Settings|DataChanged)\(/g,
  ) ?? []).length
  check('PageEditor 早退分支之后没有任何 hooks 调用', early > -1 && hooksAfter === 0, `after=${hooksAfter}`)
}

console.log(`\n${pass ? 'PASS' : 'FAIL'}: quiz preview stability contract`)
process.exit(pass ? 0 : 1)
