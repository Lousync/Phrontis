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
import { stripComments } from '../shared/strip-comments.mjs'

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
  lastTeachPatchOf,
  foldTeachFences,
  ledgerToPatch,
  renderSegmentLedger,
  renderSegmentProgressLine,
  renderSegmentLedgerRequestBlock,
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

console.log('\n=== 6. lastTeachPatchOf：只取最后一条 assistant 围栏 ===')
const MSGS = [
  { role: 'user', content: '老师继续' },
  { role: 'assistant', content: '第一轮\n```teach\n{"unitId":"u1","step":1,"label":"定义"}\n```' },
  { role: 'assistant', content: '中间一条没有围栏的回答' },
  { role: 'assistant', content: '第三轮\n```teach\n{"unitId":"u2","step":2,"label":"第二步"}\n```' },
  { role: 'user', content: '```teach\n{"unitId":"u9","step":9}\n```' },
]
const lastPatch = lastTeachPatchOf(MSGS)
check('★ 取最后一条围栏（不是第一条）', lastPatch?.unitId === 'u2' && lastPatch?.step === 2, JSON.stringify(lastPatch))
check('后续无围栏回答不影响取最后一条有效围栏', lastPatch?.label === '第二步', '')
check('user 消息里的围栏不计入（负向）', lastPatch?.unitId !== 'u9', JSON.stringify(lastPatch))
check('全部没有围栏返回 null（负向）', lastTeachPatchOf([{ role: 'assistant', content: '只有正文' }]) === null, '')
check('空消息列表返回 null（负向）', lastTeachPatchOf([]) === null, '')

console.log('\n=== 7. renderSegmentLedger：注入块 / 优先级 / 上限 ===')
const UNITS = [
  { id: 'u1', name: '资源分配图' },
  { id: 'u2', name: '安全序列' },
  { id: 'u3', name: '银行家算法' },
]
const seg = renderSegmentLedger({
  patch: { unitId: 'u3', step: 2, label: '安全性检查', newTerms: ['安全状态', '安全状态', '死锁'], next: '讲不安全状态反例' },
  units: UNITS,
  focusId: 'u2',
})
check('无围栏 → 空串（调用方保持原注入逐字不变）', renderSegmentLedger({ patch: null, units: UNITS, focusId: 'u1' }).text === '', '')
check('已讲到 = 知识点名 · 第 N 步 · 台阶', seg.text.includes('已讲到：银行家算法 · 第 2 步 · 安全性检查'), JSON.stringify(seg.text))
check('已覆盖 = 当前知识点之前的部分', seg.text.includes('已覆盖：资源分配图、安全序列'), JSON.stringify(seg.text))
check('最后一个知识点时不再输出未覆盖行（负向）', !seg.text.includes('未覆盖：'), JSON.stringify(seg.text))
check('下一步 + 最近术语（同轮去重）', seg.text.includes('下一步：讲不安全状态反例') && seg.text.includes('最近术语：安全状态、死锁'), JSON.stringify(seg.text))
check('★ 台账与当前聚焦冲突 → conflict=true 且块内点明以台账为准', seg.conflict === true && seg.text.includes('以台账为准'), JSON.stringify(seg))
check('不冲突时 conflict=false（负向）', renderSegmentLedger({ patch: { unitId: 'u1', step: 1 }, units: UNITS, focusId: 'u1' }).conflict === false, '')
const mid = renderSegmentLedger({ patch: { unitId: 'u2', step: 1 }, units: UNITS, focusId: 'u2' })
check('未覆盖 = 当前知识点之后的部分', mid.text.includes('未覆盖：银行家算法'), JSON.stringify(mid.text))
check('台账块抬头稳定', seg.text.startsWith(TEACH_LEDGER_HEADER), JSON.stringify(seg.text))
const huge = renderSegmentLedger({
  patch: { unitId: 'u2', step: 1, label: 'x'.repeat(900), newTerms: ['y'.repeat(500)] },
  units: UNITS,
  focusId: 'u2',
})
check('★ 注入块 ≤ 800 字符且带截断标记', huge.text.length <= 800 && huge.text.endsWith(TEACH_LEDGER_TRUNCATED_MARK), String(huge.text.length))

console.log('\n=== 7b. 分层：进度句进 system（与台账无关）/ 台账进请求级 ===')
const PLAIN_LINE = '本段进度：当前聚焦第 2/3 个知识点（安全序列）。已讲到哪、还有哪些没讲，结合本段对话自行判断。'
const progressLine = renderSegmentProgressLine({ activeIdx: 2, total: 3, activeName: '安全序列' })
check('★ 无围栏时原「本段进度」句逐字保留', progressLine === PLAIN_LINE, JSON.stringify(progressLine))
check('★ 进度句不含台账 / 台账抬头（system 前缀逐字稳定）',
  !progressLine.includes(TEACH_LEDGER_HEADER) && !progressLine.includes('台账'), JSON.stringify(progressLine))
check('无聚焦知识点时不带括号（负向）',
  renderSegmentProgressLine({ activeIdx: 0, total: 3 }) === '本段进度：当前聚焦第 0/3 个知识点。已讲到哪、还有哪些没讲，结合本段对话自行判断。', '')
const reqSeg = renderSegmentLedgerRequestBlock({
  patch: { unitId: 'u2', step: 1, label: '安全序列判定' },
  units: UNITS,
  focusId: 'u2',
  activeIdx: 2,
  total: 3,
  activeName: '安全序列',
})
check('请求级块 = 降级句 + 台账块（以台账为准）',
  reqSeg.startsWith('本段进度：界面当前聚焦第 2/3 个知识点（安全序列）。实际讲到哪以下方【本段台账】为准，冲突时以台账为准。\n' + TEACH_LEDGER_HEADER),
  JSON.stringify(reqSeg))
check('无围栏 → 请求级块空串（调用方不加任何注入）',
  renderSegmentLedgerRequestBlock({ patch: null, units: UNITS, focusId: 'u2', activeIdx: 2, total: 3 }) === '', '')

console.log('\n=== 7c. foldTeachFences：全量合并 / 单调前沿 / 坏围栏 ===')
const ORDER = ['u1', 'u2', 'u3']
const FOLD_MSGS = [
  { role: 'user', content: '开始', created_at: '2026-11-22T10:00:00.000Z' },
  { role: 'assistant', content: '第一轮\n```teach\n{"unitId":"u1","step":1,"label":"定义","newTerms":["资源分配图"]}\n```', created_at: '2026-11-22T10:01:00.000Z' },
  { role: 'assistant', content: '第二轮\n```teach\n{"unitId":"u2","step":1,"label":"安全序列","newTerms":["安全序列"]}\n```', created_at: '2026-11-22T10:02:00.000Z' },
  { role: 'assistant', content: '坏围栏\n```teach\n{"unitId": }\n```', created_at: '2026-11-22T10:03:00.000Z' },
  { role: 'assistant', content: '第三轮\n```teach\n{"unitId":"u3","step":2,"label":"银行家算法","newTerms":["死锁"],"next":"讲反例"}\n```', created_at: '2026-11-22T10:04:00.000Z' },
]
const folded = foldTeachFences(FOLD_MSGS, { unitOrder: ORDER })
check('★ 全量合并取到最新知识点与台阶', folded?.current?.unitId === 'u3' && folded?.current?.step === 2, JSON.stringify(folded?.current))
check('★ terms 全量累加并去重（按首次定义顺序）',
  eqJson(folded?.terms.map((t) => t.term), ['资源分配图', '安全序列', '死锁']), JSON.stringify(folded?.terms))
check('terms 保留各条消息的 createdAt（不是最后一条时间）',
  folded?.terms[0]?.definedAt === '2026-11-22T10:01:00.000Z' && folded?.terms[2]?.definedAt === '2026-11-22T10:04:00.000Z', JSON.stringify(folded?.terms))
check('next 取最新一条', folded?.next === '讲反例', String(folded?.next))

// 后一条围栏写回旧 unitId：全量合并后已覆盖不减少（旧实现只看最后一条 → 归零）
const REGRESS_MSGS = [
  ...FOLD_MSGS,
  { role: 'assistant', content: '写回旧点\n```teach\n{"unitId":"u1","step":2,"label":"回看定义","newTerms":["资源分配图"]}\n```', created_at: '2026-11-22T10:05:00.000Z' },
]
const regressedFold = foldTeachFences(REGRESS_MSGS, { unitOrder: ORDER })
const regressedBlock = renderSegmentLedgerRequestBlock({
  patch: ledgerToPatch(regressedFold),
  units: UNITS,
  focusId: 'u3',
  activeIdx: 3,
  total: 3,
  activeName: '银行家算法',
})
const oldLast = lastTeachPatchOf(REGRESS_MSGS)
const oldBlock = renderSegmentLedger({ patch: oldLast, units: UNITS, focusId: 'u3' }).text
check('★ unitId 回退不生效：合并后仍停在前沿知识点', regressedFold?.current?.unitId === 'u3' && regressedFold?.current?.step === 2, JSON.stringify(regressedFold?.current))
check('★ 后一条围栏 unitId 回退时「已覆盖」不减少',
  regressedBlock.includes('已覆盖：资源分配图、安全序列') && regressedBlock.includes('已讲到：银行家算法'),
  JSON.stringify(regressedBlock))
check('（对照）旧「只读最后一条」口径下已覆盖确实消失了', !oldBlock.includes('已覆盖：') && oldLast?.unitId === 'u1', JSON.stringify(oldBlock))
check('回退围栏里的 newTerms 仍然去重累加（不重复记同一术语）',
  regressedFold?.terms.filter((t) => t.term === '资源分配图').length === 1, JSON.stringify(regressedFold?.terms))

// step 只增不减（同一知识点内）
const stepBack = foldTeachFences([
  { role: 'assistant', content: '```teach\n{"unitId":"u2","step":3,"label":"第三步"}\n```', created_at: '2026-11-22T11:00:00.000Z' },
  { role: 'assistant', content: '```teach\n{"unitId":"u2","step":1,"label":"旧第一步"}\n```', created_at: '2026-11-22T11:01:00.000Z' },
], { unitOrder: ORDER })
check('★ 同一知识点内 step 不倒退（旧消息跳过）', stepBack?.current?.step === 3 && stepBack?.current?.label === '第三步', JSON.stringify(stepBack?.current))

// 换知识点前进：step 从 1 重计（不带上一个知识点的步数）
const switchFwd = foldTeachFences([
  { role: 'assistant', content: '```teach\n{"unitId":"u1","step":3,"label":"第三步"}\n```', created_at: '2026-11-22T12:00:00.000Z' },
  { role: 'assistant', content: '```teach\n{"unitId":"u2","step":1,"label":"新知识点第一步"}\n```', created_at: '2026-11-22T12:01:00.000Z' },
], { unitOrder: ORDER })
check('★ 换知识点（前进）时 step 从 1 重计', switchFwd?.current?.unitId === 'u2' && switchFwd?.current?.step === 1, JSON.stringify(switchFwd?.current))

// 乱序 / 坏围栏：非 assistant、数组围栏、坏 JSON、无围栏全部跳过
const skipFold = foldTeachFences([
  { role: 'user', content: '```teach\n{"unitId":"u9","step":9,"newTerms":["用户写的"]}\n```', created_at: '2026-11-22T13:00:00.000Z' },
  { role: 'assistant', content: '```teach\n[{"unitId":"u9"}]\n```', created_at: '2026-11-22T13:01:00.000Z' },
  { role: 'assistant', content: '```teach\n{"unitId": }\n```', created_at: '2026-11-22T13:02:00.000Z' },
  { role: 'assistant', content: '只有正文，没有围栏', created_at: '2026-11-22T13:03:00.000Z' },
], { unitOrder: ORDER })
check('乱序 / 坏围栏 / 用户消息围栏全部跳过（返回 null）', skipFold === null, JSON.stringify(skipFold))
check('没有任何围栏 → null（调用方保持原注入）', foldTeachFences([{ role: 'assistant', content: '正文' }], { unitOrder: ORDER }) === null, '')
check('空消息列表 → null（负向）', foldTeachFences([], { unitOrder: ORDER }) === null, '')
// 无 unitOrder 时退回旧口径：step 全局只增（已有用例覆盖），此处只锁「不抛错」
check('无 unitOrder 也能合并（退回旧口径不抛错）',
  foldTeachFences([{ role: 'assistant', content: '```teach\n{"unitId":"u2","step":2}\n```' }])?.current?.step === 2, '')

console.log('\n=== 8. 接线：提示词 / 段会话注入 / 渲染层剥离 ===')
const agentSrc = stripComments(fs.readFileSync(path.join(ROOT, 'electron/lib/agentService.ts'), 'utf8'))
const courseSrc = stripComments(fs.readFileSync(path.join(ROOT, 'electron/lib/aiTeachingCourse.ts'), 'utf8'))
const panelSrc = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/index.tsx'), 'utf8')
check('系统提示含 ```teach 台账协议', agentSrc.includes('【段内台账协议（AI教学）】') && agentSrc.includes('```teach'))
check('协议字段与解析口径一致（unitId / step / label / newTerms / next）',
  ['"unitId"', '"step"', '"label"', '"newTerms"', '"next"'].every((k) => agentSrc.includes(k)), '')
check('协议要求：每条都输出、step 只增、newTerms 只放本轮新术语',
  agentSrc.includes('每条回答都输出、最多一个') && agentSrc.includes('只增不减') && agentSrc.includes('newTerms 只放本轮**新引入**的术语'), '')
check('★ 只对段会话注入（课程助手 / 复习课 / 零散会话不注入）',
  /const sessionLessonBrief = source === 'aiTeaching' && !isSideLane[\s\S]{0,120}getSessionLessonBrief\(sessionId\)/.test(agentSrc)
  && /const teachLedgerRuleHint = sessionLessonBrief && !sessionLessonBrief\.ended/.test(agentSrc), '')
check('已收尾段不注入台账协议（负向）', /sessionLessonBrief && !sessionLessonBrief\.ended/.test(agentSrc), '')
check('teachLedgerRuleHint 拼进 systemFull', /\+ teachLedgerRuleHint \+ wrapupRuleHint \+ visualHint/.test(agentSrc), '')
check('台账协议计入 protocols 分区（与其它协议同区）', /outlineRuleHint \+ endcourseRuleHint \+ teachLedgerRuleHint \+ wrapupRuleHint \+ teachStyleHint/.test(agentSrc), '')
check('★ 段会话全量合并本会话所有围栏（foldTeachFences + 全量消息 + unitOrder）',
  /const ledger = foldTeachFences\(getAgentMessagesAll\(sessionId\), \{ unitOrder: ids \}\)/.test(courseSrc), '')
check('★ 不用只给最早 500 条的 getAgentMessages（长段会漏最近围栏，负向）',
  !/foldTeachFences\(getAgentMessages\(sessionId\)/.test(courseSrc), '')
check('★ 合并结果经 ledgerToPatch 作为 renderSegmentLedgerRequestBlock 的输入',
  courseSrc.includes('patch: ledgerToPatch(ledger)') && courseSrc.includes('renderSegmentLedgerRequestBlock({') && courseSrc.includes('focusId: active?.id'), '')
check('★ system 层进度句只走纯函数且参数不含台账',
  /lines\.push\(renderSegmentProgressLine\(\{ activeIdx, total: ids\.length, activeName: active\?\.name \}\)\)/.test(courseSrc), '')
check('★ 台账经 requestOut 出参交给请求级层（不 push 进 system 行）',
  courseSrc.includes('requestOut.block = requestBlock') && !courseSrc.includes('lines.push(ledgerBlock)') && !courseSrc.includes('lines.push(requestBlock)'), '')
check('★ 不再只读最后一条围栏（负向）', !courseSrc.includes('lastTeachPatchOf('), '')
check('已收尾段不注入台账块（负向）', /if \(curLesson\.status !== 'ended'\) \{[\s\S]{0,120}foldTeachFences/.test(courseSrc), '')
check('渲染层剥离 teach 围栏（不进正文）', /\(profile\|plan\|ask\|outline\|endcourse\|teach\|wrapup\)/.test(panelSrc), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

for (const dir of [ledgerTmp, typesTmp]) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
}
process.exit(failed.length === 0 ? 0 : 1)
