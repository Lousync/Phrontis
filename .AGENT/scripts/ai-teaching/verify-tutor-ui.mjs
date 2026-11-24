#!/usr/bin/env node
/**
 * Contract: AI teaching "tutor" (conversation) mode - container UI + composer card.
 *
 * Plan: docs/ai-teaching-tutor-mode-plan.md (section 1 / 2.2-2.7 / 7).
 * Prototype: tmp/ai-teach-tutor-mode/index.html.
 * Scope of this script: src/modules/ai-teaching/index.tsx only (U block).
 *   1. picker entry between workspace search and "new workspace"
 *   2. tutorActive view branch + enterWs / exitToPicker reset
 *   3. session rail (filter / grouping / create / rename / delete / folder path)
 *   4. five mode chips (labels, default auto, reset after send) + material chip
 *   5. auto routing (resolveTutorMode) and agentChat request fields
 *   6. solve action row only on the last assistant + no fake "add to wrongbook" button
 *   7. RightViewer persistScope + host viewer state reset on session switch
 *   8. course-only blocks hidden under tutor
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-tutor-ui.mjs
 * Output is pure ASCII (no emoji).
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`)
  }
}

const rel = 'src/modules/ai-teaching/index.tsx'
const src = read(rel)
const code = stripComments(src)
console.log(`\n[1] ${rel} - view switch and picker entry`)

// ---------------------------------------------------------------- 1. view switch / entry
const entryAt = src.indexOf('data-wb="aiTeachTutorEntry"')
const searchAt = src.indexOf('placeholder="搜索工作区')
const newWsAt = src.indexOf('<Plus size={12} /><span className="kb-l1">新建工作区</span>')
check('picker has tutor entry marker', entryAt > 0)
check('entry sits after workspace search', searchAt > 0 && entryAt > searchAt)
check('entry sits before "new workspace" button', newWsAt > 0 && entryAt < newWsAt)
check('entry tooltip = not building a course', src.includes('data-tip="不建课，直接拿资料问"'))
check('entry uses MessagesSquare icon',
  /data-wb="aiTeachTutorEntry"[\s\S]{0,300}?<MessagesSquare size=\{12\}/.test(src))
check('entry calls enterTutor', /onClick=\{\(\) => void enterTutor\(\)\}[\s\S]{0,200}?data-wb="aiTeachTutorEntry"/.test(src))

check('tutorActive state declared', /const \[tutorActive, setTutorActive\] = useState\(false\)/.test(src))
check('top-level render branches on activeWs || tutorActive', /\{\(activeWs \|\| tutorActive\) \? \(/.test(src))
check('enterWs resets tutor mode',
  /const enterWs = useCallback\(\(id: string\) => \{[\s\S]{0,320}?setTutorActive\(false\)/.test(src))
check('exitToPicker resets tutor mode',
  /const exitToPicker = useCallback\(\(\) => \{[\s\S]{0,400}?setTutorActive\(false\)/.test(src))
check('enterTutor clears course state',
  /const enterTutor = useCallback\([\s\S]{0,900}?setActiveSegmentSid\(null\)[\s\S]{0,400}?setPreflight\(null\)/.test(src))

// ---------------------------------------------------------------- 2. session rail
console.log(`\n[2] ${rel} - session rail`)
check('tutor sessions filtered by aiTeachMode === tutor', /sessions\.filter\(s => s\.aiTeachMode === 'tutor'\)/.test(src))
check('grouping uses today / yesterday / earlier',
  /'今天'[\s\S]{0,120}'昨天'[\s\S]{0,120}'更早'/.test(src))
check('group helper splits by calendar day', /function tutorDayGroup\(/.test(src))
check('rail markup present', src.includes('data-wb="aiTutorSessionRail"'))
check('rail has its own search box', src.includes('data-wb="aiTutorSearch"') && /placeholder="搜索对话"/.test(src))
check('new session calls aiTeachTutorCreate', /aiTeachTutorCreate\(\)/.test(src))
check('new session refreshes list then opens it',
  /aiTeachTutorCreate\(\)[\s\S]{0,500}?refreshSessions\(\)[\s\S]{0,200}?openSession\(r\.sessionId, '新对话'\)/.test(src))
check('rename calls agentRenameSession', /agentRenameSession\(sid, t\)/.test(src))
check('rename syncs session folder', /aiTeachRenameSessionFolder\(sid, t\)/.test(src))
check('dblclick enters inline rename', /onDoubleClick=\{\(\) => \{ setTutorRenamingId\(s\.id\)/.test(src))
check('Enter commits / Escape cancels rename',
  /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); void commitTutorRename\(s\.id\) \}/.test(src) &&
  /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); setTutorRenamingId\(null\) \}/.test(src))
check('delete reuses delSession (folder ask/keep/delete preserved)', /delSession\(e, s\.id, s\.title\)/.test(src))
check('empty state offers new session', /还没有对话[\s\S]{0,260}?新建对话/.test(src))
check('session folder path displayed (only when folder exists)', /aiTeachSessionFolder\(activeId\)/.test(src) && /\{tutorFolder && \(/.test(src) && /data-tip=\{tutorFolder\}/.test(src) && !src.includes('不建课 · 每个对话一个文件夹'))

// ---------------------------------------------------------------- 3. composer: mode chips + material chip
console.log(`\n[3] ${rel} - composer mode row and material chip`)
check('mode labels come from TUTOR_MODE_LABELS', (src.match(/TUTOR_MODE_LABELS/g) || []).length >= 2)
check('five modes in plan order', /\['auto', 'chat', 'read', 'solve', 'ask'\] as TutorUiMode\[\]/.test(src))
check('default mode is auto', /useState<TutorUiMode>\('auto'\)/.test(src))
check('chip exposes aria-pressed', /aria-pressed=\{tutorMode === m\}/.test(src))
check('mode row sits above the textarea',
  src.indexOf('data-wb="aiTutorModeRow"') < src.indexOf('ref={inputRef}'))
check('mode resets to auto after send', /if \(tutorTurn\) setTutorMode\('auto'\)/.test(src))
check('reading context read via useSyncExternalStore',
  /useSyncExternalStore\(subscribeReadingContext, getReadingContext\)/.test(src))
check('material chip present', src.includes('data-wb="aiTutorMaterialChip"'))
check('material chip focuses right rail', /data-wb="aiTutorMaterialChip"[\s\S]{0,700}?onClick=\{openRail\}/.test(src))
check('material chip x clears reading context', /onClick=\{\(\) => publishReadingContext\(null\)\}/.test(src))
check('empty state suggestions exist', src.includes('data-wb="aiTutorSuggestions"'))
check('suggestions never auto-send', /tutorSuggest\(c\.act\)/.test(src) && !/tutorSuggest[\s\S]{0,200}?doSend/.test(src))

// ---------------------------------------------------------------- 4. auto routing + request fields
console.log(`\n[4] ${rel} - auto routing and agentChat request`)
check('resolveTutorMode imported', /import \{ TUTOR_MODE_LABELS, resolveTutorMode, type TutorUiMode \}/.test(src))
check('doSend resolves auto before sending',
  /const teachMode: TutorTurnMode \| undefined = tutorTurn[\s\S]{0,500}?tutorMode === 'auto'[\s\S]{0,400}?resolveTutorMode\(\{/.test(src))
check('sendText falls back to resolveTutorMode for indirect sends',
  /const teachMode: TutorTurnMode \| undefined = tutorTurn[\s\S]{0,500}?\(mode \?\? resolveTutorMode\(\{/.test(src))
check('sendText accepts an optional turn mode', /images: ComposerImage\[\] = \[\], mode\?: TutorTurnMode\)/.test(src))
const chatCallAt = src.indexOf('agentChat(sid, text')
const chatCall = chatCallAt >= 0 ? src.slice(chatCallAt, chatCallAt + 900) : ''
check('agentChat call site exists', chatCallAt > 0)
check('agentChat call site passes teachMode + reading', /teachMode, reading\)/.test(chatCall))
check('auto is never forwarded as a teachMode literal', !/agentChat\([^)]*['"]auto['"]/.test(src))
check('non-tutor path sends undefined tutor fields',
  /tutorTurn\s*\?\s*\(mode \?\? resolveTutorMode/.test(src) && /: undefined/.test(src))

// ---------------------------------------------------------------- 5. message badge + solve actions
console.log(`\n[5] ${rel} - message badge and solve action row`)
check('stored teachMode mapped into UI messages', /\.\.\.\(m\.teachMode \? \{ teachMode: m\.teachMode \} : \{\}\)/.test(src))
check('assistant badge uses TUTOR_MODE_LABELS', /TUTOR_MODE_LABELS\[m\.teachMode\]/.test(src))
check('solve row targets the last assistant message',
  /messages\[lastAssistantIdx\]\?\.teachMode === 'solve'/.test(src))
check('solve row index is last-assistant based', /const tutorSolveRowIdx = tutorActive && !pending && lastAssistantIdx >= 0/.test(src))
check('solve row renders only on that index', /\{idx === tutorSolveRowIdx && \(/.test(src))
check('variant action sends solve mode',
  src.includes("void doSend('再来两道同类型变式题，题号从 1 开始，用 ```quiz 围栏。', 'solve')"))
check('add-to-sheet appends to session outputs', /\/产物\/题单\.md/.test(src))
check('add-to-sheet uses quiz fences', /function extractQuizFences\(/.test(src) && /addSolveToSheet\(m\.content\)/.test(src))
check('no fake "add to wrongbook" action rendered', !code.includes('加入错题'))

// ---------------------------------------------------------------- 6. viewer scope + session switch
console.log(`\n[6] ${rel} - right viewer scope`)
check('RightViewer receives persistScope',
  /persistScope=\{tutorActive \? `tutor:\$\{activeId \|\| 'empty'\}` : undefined\}/.test(src))
check('session switch clears host viewer state under tutor',
  /if \(tutorActiveRef\.current\) setViewerActiveRel\(null\)/.test(src))

// ---------------------------------------------------------------- 7. course-only blocks hidden
console.log(`\n[7] ${rel} - course-only blocks hidden under tutor`)
check('course rail replaced by tutor rail', /tutorActive \? \([\s\S]{0,1200}?data-wb="aiTutorSessionRail"/.test(src))
check('docPills hidden', /\{!tutorActive && \([\s\S]{0,80}?\{docPills\}/.test(src))
check('preflight hidden', /\{!tutorActive && preflight && preflightChapter \?/.test(src))
check('chapter review banner hidden', /\{!tutorActive && courseReviewChapter && activeId/.test(src))
check('course jump chips hidden', /\{!tutorActive && parsedMsg\(m\)\.jumps\.map/.test(src))
check('outline fence card hidden', /\{!tutorActive && outlineFence\?\.idx === idx/.test(src))
check('endcourse fence card hidden', /\{!tutorActive && endCourseFence\?\.idx === idx/.test(src))
check('wrapup fence card hidden', /\{!tutorActive && wrapupFence\?\.idx === idx/.test(src))
check('segment handoff block hidden', /\{!tutorActive && activeSegment && activeId === activeSegmentSid && prevHandoff/.test(src))
check('segment-ended row hidden', /\{!tutorActive && activeSegment && activeId === activeSegmentSid && segmentStatus === 'ended'/.test(src))
check('course-ended card hidden', /\{courseEnded && activeWs && activeWs !== '__none__' && !tutorActive/.test(src))
check('empty-state "open course assistant" hidden', /\{!tutorActive && !activeId && \(/.test(src))
check('hero chips hidden', /const heroMode = emptyState && !!activeSegment && !tutorActive/.test(src))
check('tutor empty title is the conversation title', /\{tutorActive \? '对话' : courseReviewChapter \? '章末复习'/.test(src))
check('ask card kept (not guarded by tutorActive)', !/!tutorActive && askVisible/.test(src))
check('image attachment strip kept (not guarded by tutorActive)', !/!tutorActive && <ComposerImageStrip/.test(src))

console.log(`\nPASS -- ${pass}/${pass + fail} assertions passed`)
process.exit(fail > 0 ? 1 : 0)
