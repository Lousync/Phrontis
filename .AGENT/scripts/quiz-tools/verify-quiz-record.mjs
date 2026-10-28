// 契约验证：答题痕迹纯函数（草稿合并 / auto 转正迁移 / 错题口径）。
//
// 这些函数被 quizRepo 与渲染层 store 共用；迁移合并错一处会静默丢记录/丢标签关联，
// 所以用真实函数直接跑，不复制实现。
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/quiz-tools/verify-quiz-record.mjs
// 期望：输出 PASS 且 exit=0

import {
  applyDraftPatch,
  draftIsEmpty,
  mergeRowsOnPageIdMigration,
  parseDraftJson,
  serializeDraft,
  wrongNosOf,
  QUIZ_DRAFT_TEXT_MAX,
} from '../../../electron/lib/quizRecordPure.ts'

let pass = true
const check = (name, ok) => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}`)
  if (!ok) pass = false
}

console.log('--- 草稿合并 ---')
const first = applyDraftPatch(null, { text: '第一次', revealed: true }, '2026-10-28 10:00:00')
check('首次 patch 生成草稿', first.text === '第一次' && first.revealed === true)
const second = applyDraftPatch(first, { text: '第二次' }, '2026-10-28 10:01:00')
check('未提供的字段保留', second.revealed === true && second.text === '第二次')
check('updatedAt 跟随本次 patch', second.updatedAt === '2026-10-28 10:01:00')
const picked = applyDraftPatch(second, { picked: 'B' }, '2026-10-28 10:02:00')
check('picked 合并', picked.picked === 'B' && picked.text === '第二次')
const cleared = applyDraftPatch(picked, { picked: null, assessedText: '第二次' }, '2026-10-28 10:03:00')
check('picked 可清空', cleared.picked === null)
check('assessedText 写入', cleared.assessedText === '第二次')
const long = applyDraftPatch(null, { text: 'x'.repeat(QUIZ_DRAFT_TEXT_MAX + 20) }, 'now')
check('草稿文本截断到上限', long.text.length === QUIZ_DRAFT_TEXT_MAX)
check('序列化后可回读', parseDraftJson(serializeDraft(cleared))?.assessedText === '第二次')
check('坏 JSON 返回 null', parseDraftJson('{oops') === null)
check('空草稿判定', draftIsEmpty(applyDraftPatch(null, { picked: null, text: '' }, 'now')))

console.log('\n--- auto 转正迁移 ---')
const base = {
  id: 'old-1',
  page_id: 'auto:练习.md',
  quiz_no: 1,
  page_title: '练习',
  is_favorite: 0,
  wrong_count: 2,
  correct_count: 1,
  last_result: 0,
  streak_correct: 0,
  note: '',
  snapshot_json: JSON.stringify({ no: 1, question: '旧题' }),
  source_space: '408',
  source_notebook: '数据结构',
  created_at: '2026-10-01 10:00:00',
  updated_at: '2026-10-02 10:00:00',
  draft_json: serializeDraft(applyDraftPatch(null, { text: '旧草稿' }, '2026-10-02 10:00:00')),
}
const noConflict = mergeRowsOnPageIdMigration([base], 'auto:练习.md', 'uuid-page')
check('无冲突：记录改到新 pageId', noConflict.moved === 1 && noConflict.rows[0].page_id === 'uuid-page')
check('无冲突：record id 保留', noConflict.rows[0].id === 'old-1')
check('无冲突：idMap 指向自身', noConflict.idMap['old-1'] === 'old-1')

const target = {
  ...base,
  id: 'new-1',
  page_id: 'uuid-page',
  wrong_count: 1,
  correct_count: 2,
  last_result: 1,
  streak_correct: 2,
  updated_at: '2026-10-03 10:00:00',
  draft_json: serializeDraft(applyDraftPatch(null, { text: '新草稿' }, '2026-10-03 10:00:00')),
}
const conflict = mergeRowsOnPageIdMigration([base, target], 'auto:练习.md', 'uuid-page')
check('有冲突：合并为一行', conflict.merged === 1 && conflict.rows.length === 1)
check('有冲突：计数相加', conflict.rows[0].wrong_count === 3 && conflict.rows[0].correct_count === 3)
check('有冲突：streak 取较大值', conflict.rows[0].streak_correct === 2)
check('有冲突：last_result 取较新', conflict.rows[0].last_result === 1)
check('有冲突：草稿取较新', parseDraftJson(conflict.rows[0].draft_json)?.text === '新草稿')
check('有冲突：idMap 指向保留行', conflict.idMap['old-1'] === 'new-1')
check('有冲突：保留新 record id', conflict.rows[0].id === 'new-1')
check('有冲突：收藏取 OR', (() => {
  const a = { ...base, is_favorite: 1 }
  const b = { ...target, is_favorite: 0 }
  return mergeRowsOnPageIdMigration([a, b], 'auto:练习.md', 'uuid-page').rows[0].is_favorite === 1
})())

console.log('\n--- 错题重做口径 ---')
const wrongNos = wrongNosOf([
  { quizNo: 1, lastResult: 0 },
  { quizNo: 2, lastResult: 1 },
  { quizNo: 3, lastResult: null },
  { quizNo: 4, lastResult: 0 },
])
check('只取 lastResult === 0', wrongNos.length === 2 && wrongNos.includes(1) && wrongNos.includes(4))

console.log(pass ? '\nPASS: 答题痕迹纯函数契约一致' : '\nFAIL: 答题痕迹契约不符')
process.exit(pass ? 0 : 1)
