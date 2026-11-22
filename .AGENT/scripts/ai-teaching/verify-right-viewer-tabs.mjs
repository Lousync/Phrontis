#!/usr/bin/env node
/**
 * 契约验证：AI 教学「右侧活动栏 · 动态多页签」
 *
 * 方案：`tmp/ai-teach-right-viewer/PLAN.md`（动态实例页签 / 保活窗口 / 持久化 v2 / 旁问草稿）
 * 并行批次约束：`tmp/ui-batch/CONTRACT.md`（B 线只动 `right-viewer/**`）
 *
 * 两类断言：
 *   A. 纯函数真实实现执行 —— strip 类型后 import `viewerTabs.ts`（零运行时依赖），
 *      验证创建 / 去重 / 关闭邻位 / 保活采样 / 溢出采样 / 序列化 / 宽容解析 / 旧键迁移 / 不可变。
 *   B. 渲染层接线静态断言 —— 防「加了页签却没接持久化 / 没做去重 / 草稿落了库」这类
 *      静默失配（编译不报错，只有用户能发现）。
 *
 * 运行（仓库根）：node .AGENT/scripts/ai-teaching/verify-right-viewer-tabs.mjs [repo-path]
 * 输出纯 ASCII（AGENTS.md 禁 emoji）；期望全部 PASS 且 exit=0。
 *
 * 命名说明：本脚本原名 `verify-viewer-tabs.mjs`，但该文件名已被
 * `electron/lib/viewerTabsPure.ts` 的契约占用（且挂在 verify-all-p0 里），
 * 故本批次改用 `verify-right-viewer-tabs.mjs` 以免覆盖别人的契约。
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
const ascii = (s) => String(s === undefined ? '' : s).replace(/[^\x20-\x7e]/g, '?')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const clone = (v) => structuredClone(v)

const DIR = 'src/modules/ai-teaching/right-viewer'
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/* ---------------------------------------------------------------- A. 纯函数 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'right-viewer-tabs-'))
const tmpFile = path.join(tmpDir, 'viewerTabs.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(read(`${DIR}/viewerTabs.ts`), { mode: 'strip' }))
const T = await import(pathToFileURL(tmpFile).href)

const {
  makeWebTab, makeNotesTab, makeBooksTab, makeAskTab, noteTabTitle, draftTitle,
  firstQuestionTitle, tabTitleOf, inferNotesFileKind, pathKey, baseName, stemOf, clipTitle,
  tabById, findNotesTab, findBooksTabByBook, findAskTabByLane, findDraftTab, findWebTab,
  firstTabOfType, isDraftAskTab, appendTab, updateTab, activateTab, closeTabById,
  selectLiveIds, stripOverflow, serializeViewerState, parseViewerState,
  migrateLegacyViewerState, parseLegacyWebTabs, VIEWER_LIVE_WINDOW, VIEWER_WEB_LIVE_CAP,
} = T

const draftOf = (over = {}) => ({
  parentSessionId: 's1',
  parentTitle: '第 3 讲',
  anchorMessageId: '',
  sideScope: 'conversation',
  anchorOrdinal: null,
  excerpt: '',
  ...over,
})

/* ---------------------------------------------------------------- 1. 创建 */
console.log('\n=== 1. factories: defaults and titles ===')
const web = makeWebTab('t1', { url: 'https://a.example/x' }, 1)
check('web tab keeps url and falls back to a non-empty title',
  web.type === 'web' && web.url === 'https://a.example/x' && web.title === '新网页', JSON.stringify(web))
check('web tab keeps an explicit title',
  makeWebTab('t1', { url: 'https://a/', title: '维基百科' }).title === '维基百科')

const note = makeNotesTab('t2', { relPath: 'AI教学/x/产物/笔记.md' }, 2)
check('notes tab derives the title from the file name', note.title === '笔记', note.title)
check('notes tab defaults to fileKind note with no owner',
  note.fileKind === 'note' && note.ownerSessionId === null)
check('profile tab title is a human word', noteTabTitle('AI教学/x/PROFILE.md', 'profile') === '画像')
check('constraints tab title is a human word', noteTabTitle('AI教学/x/CONSTRAINTS.md', 'constraints') === '要求')
check('empty relPath still has a title', noteTabTitle('', 'note') === '笔记')

const shelf = makeBooksTab('t3')
check('books tab starts on the shelf', shelf.relPath === null && shelf.title === '书架', shelf.title)
const reader = makeBooksTab('t4', { relPath: 'books/deep.pdf', name: 'Deep Work' }, 4)
check('books tab with a book takes the name as title', reader.title === 'Deep Work' && reader.relPath === 'books/deep.pdf')

const laneTab = makeAskTab('t5', { laneId: 'lane-1', parentSessionId: 's1', title: '闭区间' })
check('ask tab with laneId is persisted-looking (draft null)',
  laneTab.laneId === 'lane-1' && laneTab.draft === null && laneTab.title === '闭区间')
const draftTab = makeAskTab('t6', { draft: draftOf({ sideScope: 'anchor', anchorMessageId: 'm2', anchorOrdinal: 2 }) })
check('ask draft title says which answer it anchors to', draftTab.title === '新旁问 · 第 2 条', draftTab.title)
check('ask draft inherits parent meta from the draft',
  draftTab.parentSessionId === 's1' && draftTab.parentTitle === '第 3 讲')
check('conversation draft title', draftTitle(draftOf()) === '新旁问 · 整段')
check('anchor draft without an ordinal does not invent one', draftTitle(draftOf({ sideScope: 'anchor' })) === '新旁问 · 锚定')
check('selection draft title', draftTitle(draftOf({ sideScope: 'selection' })) === '新旁问 · 选区')
check('draft is only for laneId-less ask tabs', isDraftAskTab(draftTab) === true && isDraftAskTab(laneTab) === false)

check('first question becomes the lane title (clipped to 16)',
  firstQuestionTitle('### 为什么上界要用闭区间？如果 hi 取 n 会怎样？') === '为什么上界要用闭区间？如果 hi', firstQuestionTitle('## hi'))
check('empty first question falls back to a plain title', firstQuestionTitle('   ') === '旁问')

/* ---------------------------------------------------------------- 2. 小工具 */
console.log('\n=== 2. path helpers ===')
check('pathKey normalises slashes and case', pathKey('AI教学\\X\\A.MD') === 'ai教学/x/a.md', pathKey('AI教学\\X\\A.MD'))
check('baseName keeps the extension', baseName('a/b/c.md') === 'c.md')
check('stemOf drops the extension but keeps dotfiles', stemOf('a/b.md') === 'b' && stemOf('a/.keep') === '.keep')
check('clipTitle collapses whitespace and truncates',
  clipTitle('  a   b\tc  ', 3) === 'a b', clipTitle('  a   b\tc  ', 3))
check('inferNotesFileKind recognises the two session docs',
  inferNotesFileKind('x/PROFILE.md') === 'profile'
  && inferNotesFileKind('x\\constraints.MD') === 'constraints'
  && inferNotesFileKind('x/笔记.md') === 'note')

/* ---------------------------------------------------------------- 3. 去重 */
console.log('\n=== 3. dedupe lookups ===')
const pool = [web, note, makeBooksTab('t7', { relPath: 'books/a.epub' }), laneTab, draftTab]
const wholeDraftTab = makeAskTab('t9', { draft: draftOf() })
check('same note file hits regardless of slash style / case',
  findNotesTab(pool, 'AI教学/X/产物/笔记.MD')?.id === 't2')
check('missing note returns null', findNotesTab(pool, 'nope.md') === null)
check('same book hits by relPath', findBooksTabByBook(pool, 'books/A.EPUB')?.id === 't7')
check('shelf tab is not a book hit', findBooksTabByBook(pool, '') === null)
check('lane tab found by laneId', findAskTabByLane(pool, 'lane-1')?.id === 't5')
check('draft is never found by laneId', findAskTabByLane(pool, '') === null)
check('conversation draft dedupes to the single whole-conversation draft',
  findDraftTab([wholeDraftTab], draftOf())?.id === 't9' && findDraftTab(pool, draftOf()) === null)
check('anchor draft dedupes by anchor message',
  findDraftTab([draftTab], draftOf({ sideScope: 'anchor', anchorMessageId: 'm2' }))?.id === 't6'
  && findDraftTab([draftTab], draftOf({ sideScope: 'anchor', anchorMessageId: 'm9' })) === null)
check('a different anchor message opens a new draft (user may compare phrasings)',
  findDraftTab([draftTab], draftOf({ sideScope: 'anchor', anchorMessageId: 'm3' })) === null)
check('only one web tab is kept: findWebTab picks the first',
  findWebTab(pool)?.id === 't1' && findWebTab([note]) === null)
check('firstTabOfType ignores other kinds', firstTabOfType(pool, 'books')?.id === 't7')
check('tabById returns null for empty ids', tabById(pool, null) === null && tabById(pool, 't7')?.id === 't7')

/* ---------------------------------------------------------------- 4. 变更 / 关闭 */
console.log('\n=== 4. append / activate / close (neighbour rule) ===')
const base = [makeWebTab('a', {}, 1), makeNotesTab('b', { relPath: 'b.md' }, 2), makeBooksTab('c', {}, 3)]
const baseSnap = clone(base)
const appended = appendTab(base, makeAskTab('d', { draft: draftOf() }, 4))
check('appendTab activates the new tab', appended.activeId === 'd' && appended.tabs.length === 4)
check('appendTab does not mutate the input array', same(base, baseSnap))

const activated = activateTab(base, 'b', 999)
check('activateTab touches lastActiveAt and keeps the title', activated.tabs[1].lastActiveAt === 999
  && activated.activeId === 'b')
check('activateTab on a missing id keeps the array', activateTab(base, 'zz', 5).tabs === base)
check('activateTab does not mutate the input', same(base, baseSnap))

const closedMid = closeTabById(base, 'b', 'b')
check('closing the active middle tab activates the right neighbour',
  closedMid.activeId === 'c' && closedMid.tabs.length === 2, closedMid.activeId)
const closedTail = closeTabById(base, 'c', 'c')
check('closing the active tail activates the left neighbour', closedTail.activeId === 'b', closedTail.activeId)
const closedOther = closeTabById(base, 'a', 'c')
check('closing a background tab keeps the active one', closedOther.activeId === 'a' && closedOther.tabs.length === 2)
const closedLast = closeTabById([makeWebTab('only', {})], 'only', 'only')
check('closing the last tab lands on the empty state', closedLast.activeId === null && closedLast.tabs.length === 0)
check('closing an unknown id is a no-op', closeTabById(base, 'a', 'zz').tabs.length === 3)
check('closeTabById does not mutate the input', same(base, baseSnap))

const patched = updateTab(base, 'b', { title: '改过的标题' })
check('updateTab patches a field', patched[1].title === '改过的标题')
check('updateTab cannot change type or id', (() => {
  const r = updateTab(base, 'b', { type: 'web', id: 'hijack' })
  return r[1].type === 'notes' && r[1].id === 'b'
})())
check('updateTab on a missing id returns the same array', updateTab(base, 'zz', { title: 'x' }) === base)

/* ---------------------------------------------------------------- 5. 保活窗口 */
console.log('\n=== 5. selectLiveIds: window, LRU, protection ===')
const many = Array.from({ length: 10 }, (_, i) => makeNotesTab(`n${i}`, { relPath: `n${i}.md` }, i))
const live = selectLiveIds({ tabs: many, activeId: 'n9', dirtyIds: ['n0'], runningIds: [] })
check('live window defaults to 6 panes', live.length === VIEWER_LIVE_WINDOW && VIEWER_LIVE_WINDOW === 6, String(live.length))
check('active tab is always live', live.includes('n9'))
check('dirty note is protected even when it is the oldest', live.includes('n0'))
check('the rest is filled by most-recently-active', live.includes('n8') && live.includes('n7'), live.join(','))
check('cold tabs beyond the window are not live', !live.includes('n1') && !live.includes('n2'))

const twoWeb = [makeWebTab('w1', {}), makeWebTab('w2', {}), makeWebTab('w3', {})]
const webLive = selectLiveIds({ tabs: twoWeb, activeId: 'w3', dirtyIds: [], runningIds: [] })
check('web live views are capped independently',
  webLive.filter((id) => id.startsWith('w')).length === VIEWER_WEB_LIVE_CAP, webLive.join(','))

const askTabs = [
  makeAskTab('a1', { laneId: 'l1', parentSessionId: 's1' }, 1),
  makeAskTab('a2', { laneId: 'l2', parentSessionId: 's1' }, 2),
]
const askLive = selectLiveIds({ tabs: askTabs, activeId: 'a1', dirtyIds: [], runningIds: ['a2'] })
check('running side lanes are never evicted', askLive.includes('a2') && askLive.includes('a1'))

const manySnap = clone(many)
selectLiveIds({ tabs: many, activeId: 'n9', dirtyIds: [], runningIds: [] })
check('selectLiveIds does not mutate the tabs or their order', same(many, manySnap))

/* ---------------------------------------------------------------- 6. 溢出 */
console.log('\n=== 6. stripOverflow: measured widths, not count ===')
check('fits exactly', stripOverflow([100, 100], 201).overflowing === false)
check('overflows by more than 1px', stripOverflow([100, 100], 150).overflowing === true)
check('sub-pixel overflow is tolerated', stripOverflow([100], 99.5).overflowing === false)
check('visible count stops before the first non-fitting tab',
  stripOverflow([100, 100, 100], 260).visible === 2, String(stripOverflow([100, 100, 100], 260).visible))
check('unknown width (0) still fits', stripOverflow([0, 0], 10).overflowing === false)
check('unmeasured container never reports overflow', stripOverflow([100], 0).overflowing === false)
check('four long titles overflow even though the count is small',
  stripOverflow([156, 156, 156, 156], 400).overflowing === true)

/* ---------------------------------------------------------------- 7. 持久化 */
console.log('\n=== 7. serialize / parse ===')
const stateTabs = [
  makeWebTab('w', { url: 'https://a/', title: 'A' }, 1),
  makeNotesTab('n', { relPath: 'x/画像/PROFILE.md', fileKind: 'profile', ownerSessionId: 's1' }, 2),
  makeBooksTab('b', { relPath: 'books/a.pdf', name: 'A' }, 3),
  makeAskTab('a', { laneId: 'lane-1', parentSessionId: 's1', parentTitle: '第 3 讲' }, 4),
  draftTab,
]
const ser = serializeViewerState(stateTabs, 'a')
check('serialize drops draft ask tabs', ser.tabs.length === 4 && !ser.tabs.some((t) => t.type === 'ask' && !t.laneId))
check('serialize version is 2', ser.v === 2)
check('serialize writes no lastActiveAt', ser.tabs.every((t) => t.lastActiveAt === 0))
check('serialize keeps fileKind + ownerSessionId',
  ser.tabs[1].fileKind === 'profile' && ser.tabs[1].ownerSessionId === 's1')
check('serialize keeps the lane parent so a restored tab opens the right conversation',
  ser.tabs[3].parentSessionId === 's1' && ser.tabs[3].parentTitle === '第 3 讲')
const serDraftActive = serializeViewerState(stateTabs, draftTab.id)
check('activeId pointing at a dropped draft falls back to the first kept tab',
  serDraftActive.activeId === 'w', String(serDraftActive.activeId))
check('all-draft session serializes to an empty list with null active',
  serializeViewerState([draftTab], draftTab.id).tabs.length === 0
  && serializeViewerState([draftTab], draftTab.id).activeId === null)

const roundTrip = parseViewerState(JSON.parse(JSON.stringify(ser)))
check('serialize -> parse round-trips', !!roundTrip && roundTrip.tabs.length === 4
  && roundTrip.activeId === 'a', JSON.stringify(roundTrip && roundTrip.tabs.length))
check('round-trip keeps the profile kind', roundTrip.tabs[1].fileKind === 'profile')

check('bad JSON -> null', parseViewerState(null) === null && parseViewerState('nope') === null)
check('wrong version -> null', parseViewerState({ v: 1, tabs: [] }) === null)
const tolerant = parseViewerState({
  v: 2,
  activeId: 'missing',
  tabs: [
    null, 42, 'x',
    { id: 'k1', type: 'unknown' },
    { id: 'k2', type: 'web', url: 'file:///etc/passwd' },
    { id: 'k3', type: 'web', url: 'https://ok.example/' },
    { id: 'k3', type: 'web', url: 'https://dup.example/' },
    { id: 'k4', type: 'notes', relPath: 'a.md' },
    { id: 'k5', type: 'notes', relPath: 'A.md' },
    { id: 'k6', type: 'ask' },
    { id: 'k7', type: 'books', relPath: 'b.pdf' },
    { id: 'k8', type: 'books', relPath: 'B.PDF' },
  ],
})
check('parser drops junk without throwing', tolerant.tabs.length === 3, String(tolerant.tabs.length))
check('NEGATIVE: parser drops non-http(s) web tabs by id',
  !tolerant.tabs.some((t) => t.id === 'k2') && tolerant.tabs.some((t) => t.id === 'k3'))
check('parser drops duplicate ids', tolerant.tabs.filter((t) => t.id === 'k3').length === 1)
check('parser dedupes the same note file (case-insensitive)', tolerant.tabs.filter((t) => t.type === 'notes').length === 1)
check('parser dedupes the same book', tolerant.tabs.filter((t) => t.type === 'books').length === 1)
check('parser drops ask tabs without a laneId (no fake drafts from storage)',
  !tolerant.tabs.some((t) => t.type === 'ask'))
check('parser falls back to the first tab when activeId is gone',
  tolerant.activeId === 'k3', String(tolerant.activeId))
const emptyParsed = parseViewerState({ v: 2, tabs: [], activeId: 'x' })
check('empty tab list parses to null active (zero-tab state is legitimate)',
  emptyParsed.tabs.length === 0 && emptyParsed.activeId === null)

/* ---------------------------------------------------------------- 8. 迁移 */
console.log('\n=== 8. legacy migration ===')
const migWeb = migrateLegacyViewerState({ rightTab: 'web', legacyWebTabs: [{ id: 'w2', url: 'https://b/', title: 'B' }, { id: 'w3', url: 'https://c/' }], newId: (i) => `m${i}` })
check('legacy web tab keeps the first url and title',
  migWeb.tabs.length === 1 && migWeb.tabs[0].url === 'https://b/' && migWeb.tabs[0].title === 'B', JSON.stringify(migWeb.tabs[0]))
check('legacy web migration activates the restored tab', migWeb.activeId === 'm0')
const migNotes = migrateLegacyViewerState({ rightTab: 'notes', newId: (i) => `m${i}` })
check('legacy single tab becomes one instance of that kind',
  migNotes.tabs.length === 1 && migNotes.tabs[0].type === 'notes')
const migBooks = migrateLegacyViewerState({ rightTab: 'books', newId: (i) => `m${i}` })
check('legacy books tab starts on the shelf', migBooks.tabs[0].type === 'books' && migBooks.tabs[0].relPath === null)
const migLanes = migrateLegacyViewerState({ railTab: 'lanes', newId: (i) => `m${i}` })
check('legacy rail "lanes" migrates to an ask draft tab', migLanes.tabs[0].type === 'ask' && migLanes.tabs[0].laneId === null)
const migDefault = migrateLegacyViewerState({ newId: (i) => `m${i}` })
check('no legacy keys at all -> one empty web tab',
  migDefault.tabs.length === 1 && migDefault.tabs[0].type === 'web' && migDefault.tabs[0].url === '')
check('legacy web tabs parser ignores non-http entries',
  parseLegacyWebTabs([{ url: 'file:///x' }, { url: 'https://ok/' }, null]).length === 1)
check('migration output is a valid v2 state', migDefault.v === 2 && migDefault.activeId === 'm0')

/* ---------------------------------------------------------------- B. 静态接线 */
console.log('\n=== 9. shell wiring (static) ===')
const shell = read(`${DIR}/RightViewer.tsx`)
const chrome = read(`${DIR}/ViewerChrome.tsx`)
const notesPane = read(`${DIR}/NotesPane.tsx`)
const askPane = read(`${DIR}/AskPane.tsx`)
const draftPane = read(`${DIR}/AskDraftPane.tsx`)
const historyMenu = read(`${DIR}/AskHistoryMenu.tsx`)
const contractsSrc = read(`${DIR}/paneContracts.ts`)

check('shell owns the dynamic tab array (no four fixed keys)',
  /useState<ViewerTab\[\]>/.test(shell) && !/VIEWER_TABS\.map/.test(shell))
check('persistence key is aiTeach.rightTabs.v2', contractsSrc.includes("'aiTeach.rightTabs.v2'"))
check('shell writes only the v2 key', /localStorage\.setItem\(\s*VIEWER_LS_KEYS\.tabsV2/.test(shell)
  && !/localStorage\.setItem\(\s*VIEWER_LS_KEYS\.tab\b/.test(shell))
check('legacy keys are read but never removed',
  shell.includes('VIEWER_LS_KEYS.tab') && shell.includes('VIEWER_LS_KEYS.legacyRailTab')
  && !/removeItem\(/.test(shell))
check('serialize filters drafts before writing', /serializeViewerState\(tabs, activeId\)/.test(shell))
check('note tabs dedupe by file', /findNotesTab\(/.test(shell))
check('book tabs dedupe by book', /findBooksTabByBook\(/.test(shell))
check('ask tabs dedupe by lane', /findAskTabByLane\(/.test(shell))
check('draft tabs dedupe by scope/anchor', /findDraftTab\(/.test(shell))
check('only one web tab is opened at a time', /findWebTab\(/.test(shell))
check('keep-alive window is applied', /selectLiveIds\(/.test(shell))
check('dirty notes are passed to the keep-alive protection', /dirtyIds/.test(shell))
check('running side lanes are treated as protected', /isSessionRunning\(/.test(shell))
check('close awaits the pane flush before removing the tab',
  /const flush = flushRef\.current\.get\(id\)/.test(shell) && /await flush\(\)/.test(shell))
check('blocked flush keeps the tab and explains why',
  /这份文件还有未处理的改动/.test(shell))
check('tab removal animates with the shared .kb-item-out token', /kb-item-out/.test(shell) || /closingIds/.test(shell))
check('web native view is hidden for menus, restored via a sync token',
  /webPaneHideAll/.test(shell) && /webSyncToken/.test(shell))
check('pane slots stay mounted via display:none', /display: active \? 'flex' : 'none'/.test(shell))
check('no alert() / confirm() in the shell', !/\balert\s*\(/.test(shell) && !/\bconfirm\s*\(/.test(shell))
check('shell keeps an empty state card for zero tabs', /ViewerEmptyCard/.test(shell))

console.log('\n=== 10. chrome wiring (static) ===')
check('chrome has a single-row strip with role=tablist', /role="tablist"/.test(chrome) && /aria-label="右侧页签"/.test(chrome))
check('chrome has the narrow (<400) header', /NARROW_WIDTH = 400/.test(chrome))
check('overflow is measured, not counted', /stripOverflow\(/.test(chrome) && /ResizeObserver/.test(chrome))
check('overflow button lists all tabs in a vertical tablist',
  /aria-orientation="vertical"/.test(chrome))
check('close button of a tab is hover/active only', /group-hover:opacity-100/.test(chrome))
check('panel close button is separate from tab close',
  /aria-label="关闭面板"/.test(chrome) && /关闭 \$\{title\}/.test(chrome))
check('plus menu lists the four kinds', /VIEWER_NEW_TAB_ORDER\.map/.test(chrome))
check('menus use the shared .kb-pop token', /kb-pop/.test(chrome))
check('ask history is a sub-step of the plus menu (not a second popover)',
  /AskHistoryMenu/.test(chrome) && /onBack=/.test(chrome))

console.log('\n=== 11. ask draft lifecycle (static) ===')
check('history loads the cross-conversation list', historyMenu.includes('agentListAllSideLanes'))
check('history shows title / source conversation / time',
  /parentTitle/.test(historyMenu) && /lastAssistantAt/.test(historyMenu) && /fmtTime/.test(historyMenu))
check('history offers "ask the whole conversation" as a draft entry', /问整段对话/.test(historyMenu))
check('draft pane creates the lane only when sending', /agentCreateSideLane\(/.test(draftPane))
check('draft lane is created with the first question as title', /firstQuestionTitle\(text\)/.test(draftPane))
check('draft does not create a lane on mount', (() => {
  const callSites = draftPane.split('await agentCreateSideLane(').length - 1
  const sendIdx = draftPane.indexOf('const send = useCallback')
  const createIdx = draftPane.indexOf('await agentCreateSideLane(')
  return callSites === 1 && sendIdx >= 0 && createIdx > sendIdx
})())
check('draft registers the run bucket before handing over to the detail pane', /beginRun\(laneId\)/.test(draftPane))
check('draft reports laneId back so the shell can persist it', /onLaneReady\(laneId, laneTitle\)/.test(draftPane))
check('draft explains that closing loses nothing', /发出第一个问题后才会保存到旁问历史/.test(draftPane))
check('ask pane is a two-state switch (lane detail vs draft)',
  /if \(laneId\)/.test(askPane) && /AskDraftPane/.test(askPane))
check('ask pane reuses the existing SideLanePanel', askPane.includes("from '../SideLanePanel'"))
check('ask pane never promotes a lane (read-only boundary)', !/agentPromoteSideLane/.test(askPane))

console.log('\n=== 12. session file tabs (static) ===')
check('notes pane writes notes with the mtime baseline',
  /workspaceWriteFile\([\s\S]{0,160}?expectedMtimeMs\)/.test(notesPane))
check('profile tab writes through the dedicated guarded channel',
  /aiTeachProfileWriteSession\(owner, body, opts\)/.test(notesPane))
check('constraints tab writes through the dedicated guarded channel',
  /aiTeachWriteConstraints\(owner, body, opts\)/.test(notesPane))
check('session docs never fall back to a bare workspaceWriteFile', (() => {
  const idx = notesPane.indexOf('if (cur.fileKind ===')
  const tail = notesPane.slice(idx)
  return tail.indexOf('workspaceWriteFile') >= 0
    && tail.indexOf('workspaceWriteFile') < tail.indexOf('aiTeachProfileWriteSession')
})())
check('conflict keeps the local buffer and refreshes the baseline',
  /merged\.state === 'conflict'/.test(notesPane) && /const disk = await workspaceReadFile/.test(notesPane))
check('conflict offers keep-mine / reload inline (no modal)', /保留我的版本/.test(notesPane) && /重新载入/.test(notesPane)
  && !/kb-overlay/.test(notesPane))
check('flush reports whether the tab may close', /return clean && !conflictRef\.current/.test(notesPane))
check('dirty state is reported upward', /onDirtyChange/.test(notesPane) && /dirtyCbRef\.current\?\.\(dirty\)/.test(notesPane))
check('save debounce is still 1000ms', /const SAVE_DEBOUNCE_MS = 1000/.test(notesPane))
check('file switcher hands selection to the shell (one tab per file)',
  /onRequestOpenNote\(f\.relPath\)/.test(notesPane))
check('new note is created by the shell helper',
  /createSessionNote\(/.test(notesPane) && fs.existsSync(path.join(ROOT, DIR, 'noteFileOps.ts')))
check('a note tab reports its real relPath after opening', /relCbRef\.current\?\.\(target\)/.test(notesPane))
check('editor is still lazy-loaded', /lazy\(\s*\(\)\s*=>/.test(notesPane) && /<Suspense/.test(notesPane))
check('no alert() / confirm() in the notes pane', !/\balert\s*\(/.test(notesPane) && !/\bconfirm\s*\(/.test(notesPane))

/* ---------------------------------------------------------------- 报告 */
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${!c.pass && c.detail ? '  -> ' + ascii(c.detail) : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} - ${checks.length - failed.length}/${checks.length} assertions passed`)

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* temp dir cleanup is best-effort */
}
process.exit(failed.length === 0 ? 0 : 1)
