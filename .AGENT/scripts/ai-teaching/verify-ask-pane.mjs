#!/usr/bin/env node
/**
 * Contract check: AI teaching right viewer -> "ask" pane (side-lane upgrade).
 *
 * Plan: docs/ai-teaching-right-viewer-plan.md §6.4
 * Kernel doc: C8 (merge into one ask surface, two scopes), C10 (read-only boundary),
 *             C11 (legacy lanes are anchor lanes, no invented ordinal).
 *
 * Two kinds of assertions:
 *   A. Real implementation of src/modules/ai-teaching/right-viewer/askPanePure.ts
 *      (strip types, then import) -- badges / subtitle / filter / sort / request / quote gate.
 *   B. Static wiring assertions -- the three-way split of the dynamic tab model:
 *      chrome (AskHistoryMenu) owns the list, AskDraftPane creates the lane on the first
 *      question (whole conversation = empty anchor), AskPane is detail-only via SideLanePanel.
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-ask-pane.mjs [repoPath]
 * Output is pure ASCII (no emoji, AGENTS.md); exit 0 only when everything passes.
 *
 * 2026-11-22 随动态多页签改造更新：列表移进壳的 `+ -> 旁问` 浮层，lanes 由首问才落库，
 * 本脚本的接线断言按新分工重写（纯函数层断言不变）。
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const ascii = (s) => String(s === undefined ? '' : s).replace(/[^\x20-\x7e]/g, '?')

const PURE_REL = 'src/modules/ai-teaching/right-viewer/askPanePure.ts'
const PANE_REL = 'src/modules/ai-teaching/right-viewer/AskPane.tsx'
const DRAFT_REL = 'src/modules/ai-teaching/right-viewer/AskDraftPane.tsx'
const HISTORY_REL = 'src/modules/ai-teaching/right-viewer/AskHistoryMenu.tsx'
const CHROME_REL = 'src/modules/ai-teaching/right-viewer/ViewerChrome.tsx'
const SHELL_REL = 'src/modules/ai-teaching/right-viewer/RightViewer.tsx'
const PANEL_REL = 'src/modules/ai-teaching/SideLanePanel.tsx'

/* ---------------------------------------------------------------- A. pure layer */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-pane-verify-'))
const tmpFile = path.join(tmpDir, 'askPanePure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(read(PURE_REL), { mode: 'strip' }))
const {
  laneBadge, laneSubtitle, filterLanes, sortLanes, scopeFromRequest, canQuoteFromLane,
} = await import(pathToFileURL(tmpFile).href)

console.log('\n=== 1. laneBadge: scope badge (C8 / C11) ===')
check('conversation -> whole conversation badge', laneBadge({ sideScope: 'conversation' }).label === '\u6574\u6bb5')
check('conversation tone', laneBadge({ sideScope: 'conversation' }).tone === 'conversation')
check('anchor + ordinal 3 -> third', laneBadge({ sideScope: 'anchor', anchorOrdinal: 3 }).label === '\u7b2c 3 \u6761')
check('anchor + ordinal tone', laneBadge({ sideScope: 'anchor', anchorOrdinal: 3 }).tone === 'anchor')
check('anchor without ordinal -> plain anchor (no invented number)', laneBadge({ sideScope: 'anchor' }).label === '\u951a\u5b9a')
check('legacy lane (no sideScope) -> plain anchor', laneBadge({}).label === '\u951a\u5b9a')
check('selection -> selection', laneBadge({ sideScope: 'selection' }).label === '\u9009\u533a' && laneBadge({ sideScope: 'selection' }).tone === 'selection')

console.log('\n=== 2. laneSubtitle: detail header source line ===')
check('conversation -> whole conversation read', laneSubtitle({ sideScope: 'conversation' }) === '\u5df2\u8bfb\u6574\u6bb5\u5bf9\u8bdd')
check('anchor ordinal 2 -> second answer', laneSubtitle({ sideScope: 'anchor', anchorOrdinal: 2 }).includes('\u7b2c 2 \u6761'))
check('anchor without ordinal -> no NaN / no fake index', (() => {
  const s = laneSubtitle({ sideScope: 'anchor' })
  return !/NaN|undefined|\u7b2c \d/.test(s) && s.includes('\u951a\u5b9a')
})())
check('legacy row (no sideScope, no ordinal) -> anchor, no fake index', !/\u7b2c \d/.test(laneSubtitle({})))
check('selection subtitle', laneSubtitle({ sideScope: 'selection' }).includes('\u9009\u533a'))
check('unknown future scope falls back to excerpt line', laneSubtitle({ sideScope: 'thread', excerpt: 'a  b\nc' }).includes('a b c'))

console.log('\n=== 3. filterLanes: search title / excerpt / anchorTitle ===')
const pool = [
  { id: 'a', title: 'Alpha', excerpt: 'first', anchorTitle: 'Intro' },
  { id: 'b', title: 'beta', excerpt: 'Second Point', anchorTitle: 'Middle' },
  { id: 'c', title: 'Gamma', excerpt: 'third', anchorTitle: 'Outro' },
]
check('empty query keeps order (no mutation)', (() => {
  const copy = pool.slice()
  const out = filterLanes(pool, '   ')
  return out.length === 3 && out.map((x) => x.id).join('') === 'abc' && pool.map((x) => x.id).join('') === copy.map((x) => x.id).join('')
})())
check('case-insensitive title match', filterLanes(pool, 'ALPHA').length === 1 && filterLanes(pool, 'ALPHA')[0].id === 'a')
check('matches excerpt', filterLanes(pool, 'second point').length === 1 && filterLanes(pool, 'second point')[0].id === 'b')
check('matches anchorTitle', filterLanes(pool, 'outro').length === 1 && filterLanes(pool, 'outro')[0].id === 'c')
check('no match -> empty array', filterLanes(pool, 'zzz').length === 0)

console.log('\n=== 4. sortLanes: unread first, newest answer first, stable, missing last ===')
const sorted = sortLanes([
  { id: 'old', lastAssistantAt: '2026-11-01 10:00:00' },
  { id: 'new', lastAssistantAt: '2026-11-19 10:00:00' },
  { id: 'none' },
  { id: 'old2', lastAssistantAt: '2026-11-01 10:00:00' },
])
check('newest assistant answer first', sorted[0].id === 'new')
check('missing timestamp goes last', sorted[sorted.length - 1].id === 'none')
check('equal timestamps keep input order (stable)', (() => {
  const ids = sorted.map((x) => x.id).filter((id) => id.startsWith('old'))
  return ids.join(',') === 'old,old2'
})())
check('unread lane wins over newer-but-read lane', (() => {
  const out = sortLanes([
    { id: 'read', lastAssistantAt: '2026-11-19 10:00:00' },
    { id: 'unread', lastAssistantAt: '2026-11-01 10:00:00', unread: true },
  ])
  return out[0].id === 'unread'
})())
check('falls back to updated_at when no assistant answer', (() => {
  const out = sortLanes([
    { id: 'a', updated_at: '2026-11-02 10:00:00' },
    { id: 'b', updated_at: '2026-11-18 10:00:00' },
  ])
  return out[0].id === 'b'
})())
check('does not mutate input order', (() => {
  const input = [{ id: 'x' }, { id: 'y', lastAssistantAt: '2026-11-19 10:00:00' }]
  sortLanes(input)
  return input[0].id === 'x'
})())

console.log('\n=== 5. scopeFromRequest: loose parse of shell request ===')
check('null / undefined -> null', scopeFromRequest(null) === null && scopeFromRequest(undefined) === null)
check('bare string -> kind', (() => {
  const r = scopeFromRequest(' Open ')
  return !!r && r.kind === 'open'
})())
check('object -> kind only', (() => {
  const r = scopeFromRequest({ kind: 'create', laneId: 'L1' })
  return !!r && r.kind === 'create' && Object.keys(r).length === 1
})())
check('object without kind -> null', scopeFromRequest({ laneId: 'L1' }) === null)
check('number / boolean -> null', scopeFromRequest(3) === null && scopeFromRequest(true) === null)

console.log('\n=== 6. canQuoteFromLane: no quoting a half-written answer ===')
check('run -> false', canQuoteFromLane({ laneStatus: 'run' }) === false)
check('done -> true', canQuoteFromLane({ laneStatus: 'done' }) === true)
check('cut -> true', canQuoteFromLane({ laneStatus: 'cut' }) === true)
check('missing status (legacy) -> true', canQuoteFromLane({}) === true)

/* ---------------------------------------------------------------- B. static wiring */
console.log('\n=== 7. ask tab wiring: chrome list / draft pane / detail pane ===')
const pane = read(PANE_REL)
const draft = read(DRAFT_REL)
const history = read(HISTORY_REL)
const chrome = read(CHROME_REL)
const shell = read(SHELL_REL)
const panel = read(PANEL_REL)
check('draft pane creates the lane on the first question (whole conversation = empty anchor)',
  /agentCreateSideLane\(/.test(draft)
  && /draft\.anchorMessageId \|\| null/.test(draft)
  && /draft\.sideScope/.test(draft)
  && /firstQuestionTitle\(/.test(draft)
  && /onLaneReady\(laneId, laneTitle\)/.test(draft)
  && /anchorMessageId: ''/.test(shell) && /sideScope: 'conversation'/.test(shell),
  'lane creation not where it is expected')
check('never calls agentChat from the tab chrome', !/\bagentChat\s*\(/.test(pane) && !/\bagentChat\s*\(/.test(chrome))
check('no alert() outside the inline cards', !/\balert\s*\(/.test(pane))
check('no confirm() outside the inline cards', !/\bconfirm\s*\(/.test(pane))
check('no promote-to-session entry (C10 read-only)', !/agentPromoteSideLane/.test(pane))
// 引用门禁：运行时态纯函数仍锁「run 中不可引用」；接线侧的下放到每条回答（非空正文才出现按钮）
check('quote gate is per-message in SideLanePanel (non-empty content only)',
  pane.includes('quotePerMessage') && pane.includes('onQuote={onQuote}')
  && panel.includes("quotePerMessage && onQuote && m.content.trim() !== ''"),
  'quote gate moved')
// 列表 / 详情分工：列表在壳的 `+ -> 旁问` 浮层，pane 只按 laneId / draft 二选一
check('history list lives in ViewerChrome/AskHistoryMenu, pane is detail-or-draft only',
  !/agentListSideLanes\(/.test(pane)
  && chrome.includes('<AskHistoryMenu')
  && history.includes('agentListAllSideLanes(')
  && history.includes('onOpenLane(lane)')
  && history.includes('onNewWhole')
  && /if \(laneId\)/.test(pane) && /if \(draft\)/.test(pane),
  'list still in the pane')
check('empty repo/session inline card', pane.includes('\u5148\u8fdb\u5165\u4e00\u4e2a AI \u6559\u5b66\u5bf9\u8bdd'))
// 动效：只用既有令牌，禁 transition-all（铁律 13）
const MOTION_TOKENS = new Set([
  'kb-view-in', 'kb-view-fade', 'kb-overlay', 'kb-pop', 'kb-collapse', 'kb-chevron',
  'kb-item-in', 'kb-item-out', 'kb-micro-pop', 'kb-toast-in', 'kb-toast-out',
])
const MOTIONISH = /kb-(?:view|overlay|pop|collapse|chevron|item|micro|toast|slide|fade|zoom|bounce)[a-z-]*/g
const askFiles = { AskPane: pane, AskDraftPane: draft, AskHistoryMenu: history, ViewerChrome: chrome }
const strayTokens = Object.entries(askFiles).flatMap(([name, src]) =>
  (src.match(MOTIONISH) || []).filter((t) => !MOTION_TOKENS.has(t)).map((t) => name + ':' + t))
check('uses existing motion tokens only, and no transition-all',
  strayTokens.length === 0
  && Object.values(askFiles).every((src) => !/transition-all/.test(src))
  && pane.includes('kb-view-fade') && history.includes('kb-pop') && chrome.includes('kb-view-in'),
  strayTokens.join(','))

console.log('\n=== 8. SideLanePanel.tsx additive prop ===')
check('quotePerMessage is optional', /quotePerMessage\?:\s*boolean/.test(panel))
check('quotePerMessage defaults to false', /quotePerMessage\s*=\s*false/.test(panel))
check('per-message quote button calls onQuote only', /quotePerMessage && onQuote && [\s\S]{0,600}?onClick=\{\(\) => onQuote\(m\.content\)\}/.test(panel))
check('bottom single quote hidden when quotePerMessage', /onQuote && !quotePerMessage && \(/.test(panel))
check('bottom float action kept', panel.includes('\u6d6e\u51fa\u7a97\u53e3'))

/* ---------------------------------------------------------------- report */
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${!c.pass && c.detail ? '  -> ' + ascii(c.detail) : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* temp dir cleanup is best-effort */
}
process.exit(failed.length === 0 ? 0 : 1)
