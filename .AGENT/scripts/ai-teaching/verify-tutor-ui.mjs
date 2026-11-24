#!/usr/bin/env node
/**
 * Contract: AI teaching "tutor" (conversation) mode - container UI + composer card.
 *
 * Plan: docs/ai-teaching-tutor-mode-plan.md (section 1 / 2.2-2.7 / 7).
 * Prototype: tmp/ai-teach-tutor-mode/index.html.
 * Scope of this script: src/modules/ai-teaching/index.tsx only (U block).
 *   1. picker entry between workspace search and "new workspace"
 *   2. tutorActive view branch + enterWs / exitToPicker reset
 *   3. session rail (filter / grouping / create / rename / delete / folder rename side effect)
 *   4. five mode chips inside the composer tray (labels, default auto, reset after send)
 *      + material chip above the textarea
 *   5. auto routing (resolveTutorMode) and agentChat request fields
 *   6. solve action row only on the last assistant + no fake "add to wrongbook" button
 *   7. RightViewer persistScope + host viewer state reset on session switch
 *   8. course-only blocks hidden under tutor
 *   9. session folder drill-down: row folder button, list kept mounted, AiTeachFileTree branch
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
// 2026-11-24: the session folder path footer at the bottom of the left rail was removed.
// The rename side effect stays: after the first message the backend retitles the session and
// the folder must follow ({MM-DD title}). Locate it by source slice (nearest useEffect +
// its dependency array) so a bare mention or a call elsewhere cannot satisfy the contract.
const folderProbeAt = src.indexOf('aiTeachSessionFolder(activeId)')
const folderEffectStart = folderProbeAt >= 0 ? src.lastIndexOf('useEffect(() => {', folderProbeAt) : -1
const folderEffectEnd = folderProbeAt >= 0 ? src.indexOf('}, [tutorActive, activeId, activeTitle])', folderProbeAt) : -1
const folderEffectBlock = folderEffectStart >= 0 && folderEffectEnd > folderProbeAt
  ? src.slice(folderEffectStart, folderEffectEnd)
  : ''
check('session folder path no longer displayed in the rail',
  folderProbeAt > 0 && !/\{tutorFolder && \(/.test(code) && !/data-tip=\{tutorFolder\}/.test(code) &&
  !src.includes('不建课 · 每个对话一个文件夹'))
check('session folder rename still synced inside the effect',
  folderEffectBlock.length > 0 &&
  /await aiTeachRenameSessionFolder\(activeId, activeTitle\)/.test(folderEffectBlock))

// ---------------------------------------------------------------- 2b. session folder tree drill-down
console.log(`\n[2b] ${rel} - session folder tree drill-down`)
// Source slices, not bare grep: each contract is located relative to its own anchor.
const rowAt = src.indexOf('data-wb="aiTutorSessionRow"')
const filesBtnAt = rowAt >= 0 ? src.indexOf('data-wb="aiTutorSessionFiles"', rowAt) : -1
const deleteBtnAt = rowAt >= 0 ? src.indexOf('data-tip="删除对话"', rowAt) : -1
const filesBtn = filesBtnAt >= 0 ? src.slice(filesBtnAt, filesBtnAt + 700) : ''
check('folder button sits inside the session row, left of delete, and stops propagation',
  rowAt > 0 && filesBtnAt > rowAt && deleteBtnAt > filesBtnAt &&
  /onClick=\{e => \{ e\.stopPropagation\(\); void openTutorTree\(s\.id, s\.title\) \}\}/.test(filesBtn) &&
  /size=\{11\}/.test(filesBtn) && /p-0\.5/.test(filesBtn))

const openTreeAt = src.indexOf('const openTutorTree = useCallback')
const openTreeEndAt = openTreeAt >= 0 ? src.indexOf('}, [aiTeachRoot, openSession])', openTreeAt) : -1
const openTreeBlock = openTreeAt >= 0 && openTreeEndAt > openTreeAt ? src.slice(openTreeAt, openTreeEndAt) : ''
check('tree entry parses the session folder, derives the sub path, and only toasts when it is missing',
  openTreeBlock.length > 0 &&
  /await aiTeachSessionFolder\(sid\)/.test(openTreeBlock) &&
  /const prefix = `\$\{aiTeachRoot\}\/`/.test(openTreeBlock) &&
  /rel\.slice\(prefix\.length\)/.test(openTreeBlock) &&
  /if \(!rel\) \{ showToast\(\{ type: 'info', message: '这个对话还没有落盘文件夹：先发一条消息，再回来看文件' \}\); return \}/.test(openTreeBlock) &&
  /setTutorTreeSubRel\(sub\)[\s\S]{0,100}?setTutorTreeSid\(sid\)[\s\S]{0,160}?if \(activeIdRef\.current !== sid\) await openSession\(sid, title\)/.test(openTreeBlock))

const treeBranchAt = src.indexOf('{tutorTreeSid && tutorTreeSubRel !== null && (')
const treeCallAt = treeBranchAt >= 0 ? src.indexOf('subRel={tutorTreeSubRel}', treeBranchAt) : -1
const treeSlice = treeBranchAt >= 0 && treeCallAt > treeBranchAt ? src.slice(treeBranchAt, treeCallAt + 420) : ''
const backAt = treeSlice.indexOf('data-wb="aiTutorSessionTreeBack"')
const backBtnStart = backAt >= 0 ? treeSlice.lastIndexOf('<button', backAt) : -1
check('tree branch lazily mounts AiTeachFileTree at the session folder and a back button clears the same pair',
  treeSlice.length > 0 && treeCallAt > treeBranchAt &&
  treeSlice.includes('<AiTeachFileTree') &&
  /subRel=\{tutorTreeSubRel\}[\s\S]{0,420}?activeRel=\{tutorTreeActiveRel\}/.test(treeSlice) &&
  backAt > 0 &&
  /onClick=\{\(\) => \{ setTutorTreeSid\(null\); setTutorTreeSubRel\(null\) \}\}/.test(treeSlice.slice(backBtnStart, backAt + 120)))

const railMarkerAt = src.indexOf('data-wb="aiTutorSessionRail"')
const railOpenAt = railMarkerAt >= 0 ? src.lastIndexOf('<div', railMarkerAt) : -1
const railOpenTag = railOpenAt >= 0 ? src.slice(railOpenAt, railMarkerAt + 30) : ''
check('session list stays mounted via display toggle (scroll/search survive the round trip)',
  railOpenTag.length > 0 && /tutorTreeSid \? 'hidden' : 'kb-view-fade'/.test(railOpenTag) &&
  !/\{!tutorTreeSid && \(/.test(src))

check('tree state resets when leaving tutor mode and activeRel derives from the session folder prefix',
  /if \(!tutorActive\) \{ setTutorTreeSid\(null\); setTutorTreeSubRel\(null\); return \}/.test(src) &&
  /if \(tutorSessions\.some\(\(s\) => s\.id === tutorTreeSid\)\) return[\s\S]{0,90}?setTutorTreeSid\(null\); setTutorTreeSubRel\(null\)/.test(src) &&
  /const tutorTreeActiveRel = useMemo\(\(\) => \{[\s\S]{0,220}?const prefix = `\$\{aiTeachRoot\}\/\$\{tutorTreeSubRel\}\/`[\s\S]{0,140}?viewerActiveRel\.slice\(prefix\.length\)/.test(src))

// 树体高度契约（2026-11-24）：头部 34px 是 flex 兄弟，树体写 h-full 会叠出 34px 溢出、底部滚不到；
// 空态文案也必须换会话口径（默认那句是「产物根」引导，放在单个会话文件夹里答非所问）。
const treeBodyAt = src.indexOf('data-wb="aiTutorSessionTree"')
const treeBodyEndAt = treeBodyAt >= 0 ? src.indexOf('emptyHint="这个文件夹还是空的', treeBodyAt) : -1
check('tree body fills the remaining height (flex-1, not h-full) and gets a session-scoped empty hint',
  treeBodyAt > 0 && treeBodyEndAt > treeBodyAt &&
  /flex-1 min-h-0 overflow-hidden pb-1/.test(src.slice(treeBodyAt, treeBodyEndAt)) &&
  !/className="h-full min-h-0 pb-1"[\s\S]{0,160}?subRel=\{tutorTreeSubRel\}/.test(src))

// ---------------------------------------------------------------- 3. composer: mode chips + material chip
console.log(`\n[3] ${rel} - composer tray mode row and material chip`)
check('mode labels come from TUTOR_MODE_LABELS', (src.match(/TUTOR_MODE_LABELS/g) || []).length >= 2)
check('five modes in plan order', /\['auto', 'chat', 'read', 'solve', 'ask'\] as TutorUiMode\[\]/.test(src))
check('default mode is auto', /useState<TutorUiMode>\('auto'\)/.test(src))
check('chip exposes aria-pressed', /aria-pressed=\{tutorMode === m\}/.test(src))

// 2026-11-24: the five-mode row moved from above the textarea into the composer tray
// (`id="aiTeachComposerTray"`). Locate by source slices so a stray marker elsewhere
// cannot satisfy the contract.
const textareaAt = src.indexOf('ref={inputRef}')
const modeRowAt = src.indexOf('data-wb="aiTutorModeRow"')
const materialAt = src.indexOf('data-wb="aiTutorMaterialChip"')
const trayAt = src.indexOf('id="aiTeachComposerTray"')
// Tray body ends where the narrow effort bubble (rendered right after it) starts.
const trayEndAt = src.indexOf('data-wb="aiTeachEffortMenu"', trayAt)
const traySlice = trayAt >= 0 && trayEndAt > trayAt ? src.slice(trayAt, trayEndAt) : ''
const trayRowAt = trayAt >= 0 ? src.indexOf('kb-tray-row', trayAt) : -1
check('mode row sits inside the composer tray',
  traySlice.length > 0 && modeRowAt > trayAt && modeRowAt < trayEndAt && traySlice.includes('data-wb="aiTutorModeRow"'))
check('mode row shares the tray 34px row',
  trayRowAt > trayAt && trayRowAt < modeRowAt && /kb-tray-row[^\n]*h-\[34px\]/.test(src.slice(trayRowAt, trayRowAt + 220)))
check('mode row no longer sits above the textarea',
  textareaAt > 0 && materialAt > 0 && materialAt < textareaAt &&
  modeRowAt > textareaAt && !src.slice(materialAt, textareaAt).includes('data-wb="aiTutorModeRow"'))
check('mode resets to auto after send', /if \(tutorTurn\) setTutorMode\('auto'\)/.test(src))
check('reading context read via useSyncExternalStore',
  /useSyncExternalStore\(subscribeReadingContext, getReadingContext\)/.test(src))
check('material chip present (only rendered when a material is bound)',
  /\(readingCtx \|\| viewerActiveRel\) && tutorMaterialName && \([\s\S]{0,600}?data-wb="aiTutorMaterialChip"/.test(src))
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
// 2026-11-24: under tutorActive the empty title now reuses the quote layout instead of
// the bare status word "对话"; "章末复习" stays as the only status-name branch.
const titleAt = code.indexOf('text-balance text-[24px] font-semibold')
const titleEndAt = code.indexOf('{!tutorActive && !activeId && (', titleAt)
const titleBlock = titleAt >= 0 && titleEndAt > titleAt ? code.slice(titleAt, titleEndAt) : ''
// Scope the negative check to the empty-state block: `tutorActive ? '对话'` still exists
// legitimately in the panel header title, so a whole-file grep would be meaningless.
const emptyAt = code.indexOf('{emptyState && (')
const emptyBlock = emptyAt >= 0 && titleEndAt > emptyAt ? code.slice(emptyAt, titleEndAt) : ''
check('tutor empty title drops the standalone "对话" literal',
  titleBlock.length > 0 && emptyBlock.length > 0 &&
  !/['"]对话['"]/.test(titleBlock) && !/tutorActive \? '对话'/.test(emptyBlock))
check('tutor empty title shares the quote layout under tutorActive',
  /!tutorActive && courseReviewChapter \? '章末复习' : \(/.test(titleBlock) &&
  /emptyQuote\.text[\s\S]{0,200}?emptyQuote\.source/.test(titleBlock) &&
  titleBlock.indexOf('emptyQuote.text') > titleBlock.indexOf("'章末复习'"))
check('ask card kept (not guarded by tutorActive)', !/!tutorActive && askVisible/.test(src))
check('image attachment strip kept (not guarded by tutorActive)', !/!tutorActive && <ComposerImageStrip/.test(src))

console.log(`\nPASS -- ${pass}/${pass + fail} assertions passed`)
process.exit(fail > 0 ? 1 : 0)
