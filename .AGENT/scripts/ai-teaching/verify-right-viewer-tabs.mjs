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
 *      `pathKey` 的大小写口径按平台（Linux 敏感 / Windows 不敏感）；契约显式传
 *      `{ caseInsensitive: true|false }` 两种模式都断言，另有一条钉住缺省值随平台。
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
  makeWebTab, makeNotesTab, makeBooksTab, makeAskTab, makeFileTab,
  noteTabTitle, draftTitle, firstQuestionTitle, tabTitleOf,
  inferNotesFileKind, isFilePaneKind, pathKey, baseName, stemOf, clipTitle,
  tabById, findNotesTab, findFileTab, findAnyPathTab,
  findBooksTabByBook, findAskTabByLane, findDraftTab, findWebTab,
  firstTabOfType, isDraftAskTab, appendTab, updateTab, activateTab, closeTabById,
  selectLiveIds, stripOverflow, serializeViewerState, parseViewerState,
  migrateLegacyViewerState, parseLegacyWebTabs,
  sanitizeViewerScope, scopedViewerTabsKey, scopedViewerWidthKey,
  VIEWER_SCOPED_TABS_PREFIX, VIEWER_SCOPED_WIDTH_PREFIX,
  VIEWER_LIVE_WINDOW, VIEWER_WEB_LIVE_CAP, VIEWER_FILE_LIVE_CAP,
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

/* ---------------------------------------------------------------- 1b. 文件页签工厂 */
console.log('\n=== 1b. file tab factory ===')
const fileHtml = makeFileTab('f1', { relPath: 'AI教学/x/演示\\示意图.html', fileKind: 'html', page: 0 }, 11)
check('file tab derives the title from the file name',
  fileHtml.type === 'file' && fileHtml.title === '示意图', fileHtml.title)
check('file tab normalises slashes and keeps page 0 (0 is a real page)',
  fileHtml.relPath === 'AI教学/x/演示/示意图.html' && fileHtml.page === 0,
  `${fileHtml.relPath} / ${fileHtml.page}`)
const genFile = makeFileTab('f2', { fileKind: 'image', generating: true, slug: 'img-1' }, 12)
check('generating file tab without a path falls back to a plain title',
  genFile.relPath === '' && genFile.generating === true && genFile.title === '文件' && genFile.slug === 'img-1',
  JSON.stringify(genFile))
check('runtime-only fields are omitted when not passed',
  !('rev' in fileHtml) && !('slug' in fileHtml) && !('generating' in fileHtml), JSON.stringify(fileHtml))
check('file pane kind guard accepts exactly html / image / mindmap / pptx',
  ['html', 'image', 'mindmap', 'pptx'].every((k) => isFilePaneKind(k))
  && !isFilePaneKind('note') && !isFilePaneKind('') && !isFilePaneKind(null))
check('tabTitleOf uses the stem and keeps an explicit generating title',
  tabTitleOf(makeFileTab('f3', { relPath: 'a/b/导图.json', fileKind: 'mindmap' })) === '导图'
  && tabTitleOf({ ...genFile, title: '正在生成示意图' }) === '正在生成示意图')

/* ---------------------------------------------------------------- 2. 小工具 */
console.log('\n=== 2. path helpers ===')
check('pathKey (case-insensitive) normalises slashes and case',
  pathKey('AI教学\\X\\A.MD', { caseInsensitive: true }) === 'ai教学/x/a.md',
  pathKey('AI教学\\X\\A.MD', { caseInsensitive: true }))
check('pathKey case-insensitive mode folds A/B.MD == a\\b.md == a/b.md/',
  pathKey('A/B.MD', { caseInsensitive: true }) === pathKey('a\\b.md', { caseInsensitive: true })
  && pathKey('a\\b.md', { caseInsensitive: true }) === pathKey('a/b.md/', { caseInsensitive: true }))
check('pathKey case-insensitive mode strips leading/trailing slashes',
  pathKey('/a/b.md/', { caseInsensitive: true }) === 'a/b.md')
check('pathKey case-sensitive mode keeps A/B.md apart from a/b.md',
  pathKey('A/B.md', { caseInsensitive: false }) !== pathKey('a/b.md', { caseInsensitive: false }))
check('pathKey case-sensitive mode still folds slashes and trailing slashes',
  pathKey('a\\b.md', { caseInsensitive: false }) === pathKey('a/b.md/', { caseInsensitive: false })
  && pathKey('a/b.md/', { caseInsensitive: false }) === 'a/b.md',
  pathKey('a/b.md/', { caseInsensitive: false }))
check('pathKey case-sensitive mode keeps a real case difference in the directory',
  pathKey('Notes/A.md', { caseInsensitive: false }) !== pathKey('notes/a.md', { caseInsensitive: false }))
// 缺省口径随平台：Linux 大小写敏感（两个真实文件），Windows / macOS 不敏感（同一个文件）。
// 本断言直接钉住缺省行为，防止有人把 pathKey 改回「无条件小写」。
const hostIsLinux = process.platform === 'linux'
check(`pathKey default follows the host platform (${process.platform}: ${hostIsLinux ? 'case-sensitive' : 'case-insensitive'})`,
  hostIsLinux
    ? pathKey('A.md') !== pathKey('a.md')
    : pathKey('A.md') === pathKey('a.md'),
  JSON.stringify([pathKey('A.md'), pathKey('a.md')]))
check('pathKey default never depends on separator style or trailing slashes',
  pathKey('a\\b.md') === pathKey('a/b.md/'))
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
check('same note file hits regardless of slash style / case (case-insensitive lookup)',
  findNotesTab(pool, 'AI教学/X/产物/笔记.MD', { caseInsensitive: true })?.id === 't2')
check('NEGATIVE: case-sensitive findNotesTab does not hit a differently-cased path',
  findNotesTab(pool, 'ai教学/x/产物/笔记.MD', { caseInsensitive: false }) === null)
check('case-sensitive findNotesTab still hits the same path with other slashes',
  findNotesTab(pool, 'AI教学\\x\\产物\\笔记.md', { caseInsensitive: false })?.id === 't2')
check('missing note returns null', findNotesTab(pool, 'nope.md') === null)
check('same book hits by relPath (case-insensitive lookup)',
  findBooksTabByBook(pool, 'books/A.EPUB', { caseInsensitive: true })?.id === 't7')
check('NEGATIVE: case-sensitive findBooksTabByBook requires an exact-case relPath',
  findBooksTabByBook(pool, 'books/A.EPUB', { caseInsensitive: false }) === null
  && findBooksTabByBook(pool, 'books/a.epub', { caseInsensitive: false })?.id === 't7')
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

/* ---------------------------------------------------------------- 3b. 文件去重 / 跨类型去重 */
console.log('\n=== 3b. file dedupe + cross-type path dedupe ===')
const filePool = [
  note,
  makeFileTab('f10', { relPath: 'AI教学/x/产物/示意图.html', fileKind: 'html' }),
  makeFileTab('f11', { relPath: 'AI教学/x/产物/图片.PNG', fileKind: 'image' }),
]
check('same file tab hits regardless of slash style / case (case-insensitive lookup)',
  findFileTab(filePool, 'AI教学\\X\\产物\\示意图.HTML', { caseInsensitive: true })?.id === 'f10')
check('NEGATIVE: case-sensitive findFileTab does not hit a differently-cased path',
  findFileTab(filePool, 'ai教学/x/产物/示意图.html', { caseInsensitive: false }) === null)
check('findFileTab never returns a notes tab that shares the path',
  findFileTab([note], 'AI教学/x/产物/笔记.md') === null)
check('missing file returns null', findFileTab(filePool, 'nope.html') === null)
check('findAnyPathTab hits the notes tab for an md path',
  findAnyPathTab(filePool, 'AI教学/x/产物/笔记.md')?.type === 'notes')
check('findAnyPathTab hits the file tab for a non-md path (slash / case tolerant)',
  findAnyPathTab(filePool, 'AI教学\\x\\产物\\图片.png', { caseInsensitive: true })?.id === 'f11')
check('findAnyPathTab sees a cross-type clash even when both kinds claim the path',
  (() => {
    const clashNote = makeNotesTab('cn', { relPath: 'x/a.md' })
    const clashFile = makeFileTab('cf', { relPath: 'x/a.md', fileKind: 'html' })
    return findAnyPathTab([clashNote, clashFile], 'x/a.md')?.id === 'cn'
      && findAnyPathTab([clashFile, clashNote], 'x/a.md')?.id === 'cf'
  })())
check('NEGATIVE: findAnyPathTab ignores books / web / unknown paths',
  findAnyPathTab([makeBooksTab('b1', { relPath: 'x/a.pdf' })], 'x/a.pdf') === null
  && findAnyPathTab(filePool, 'nope.html') === null)

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

/* ---------------------------------------------------------------- 5b. 文件保活配额 */
console.log('\n=== 5b. file live cap ===')
const fileTabs = Array.from({ length: 5 }, (_, i) =>
  makeFileTab(`lf${i}`, { relPath: `f${i}.html`, fileKind: 'html' }, i))
const fileLive = selectLiveIds({ tabs: fileTabs, activeId: 'lf4', dirtyIds: [], runningIds: [] })
check('file panes are capped at VIEWER_FILE_LIVE_CAP (3)',
  VIEWER_FILE_LIVE_CAP === 3 && fileLive.length === 3, `${VIEWER_FILE_LIVE_CAP} / ${fileLive.length}`)
check('the active file tab always stays live', fileLive.includes('lf4'))
check('file cap keeps the most recently active instead of the oldest',
  fileLive.includes('lf3') && !fileLive.includes('lf0'), fileLive.join(','))

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
}, { caseInsensitive: true })
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

// Linux 口径：`Notes/A.md` 与 `notes/a.md` 是两个真实文件，恢复时两个页签都必须留下
const twoCaseNotes = {
  v: 2,
  activeId: 'cs2',
  tabs: [
    { id: 'cs1', type: 'notes', relPath: 'Notes/A.md' },
    { id: 'cs2', type: 'notes', relPath: 'notes/a.md' },
  ],
}
const sensitiveParsed = parseViewerState(twoCaseNotes, { caseInsensitive: false })
check('case-sensitive parse keeps two note tabs that differ only in case',
  sensitiveParsed.tabs.length === 2, String(sensitiveParsed.tabs.length))
check('case-sensitive parse keeps the second tab active',
  sensitiveParsed.activeId === 'cs2', String(sensitiveParsed.activeId))
check('case-sensitive parse keeps both relPaths untouched',
  sensitiveParsed.tabs.map((t) => t.relPath).join('|') === 'Notes/A.md|notes/a.md',
  sensitiveParsed.tabs.map((t) => t.relPath).join('|'))
const insensitiveParsed = parseViewerState(twoCaseNotes, { caseInsensitive: true })
check('case-insensitive parse still dedupes the same note file',
  insensitiveParsed.tabs.length === 1 && insensitiveParsed.activeId === 'cs1',
  `${insensitiveParsed.tabs.length} / ${insensitiveParsed.activeId}`)

/* ---------------------------------------------------------------- 7b. 文件页签持久化 */
console.log('\n=== 7b. file persistence ===')
const fileState = [
  makeNotesTab('pn', { relPath: 'x/预览.md', previewDefault: true }, 1),
  makeFileTab('ph', { relPath: 'x/示意图.html', fileKind: 'html', slug: 'v1' }, 2),
  makeFileTab('pp', { relPath: 'x/课件.pptx', fileKind: 'pptx', page: 3 }, 3),
  makeFileTab('pg', { fileKind: 'image', generating: true, slug: 'img-9' }, 4),
]
const fileSer = serializeViewerState(fileState, 'pg')
check('serialize drops the generating file placeholder',
  fileSer.tabs.length === 3 && !fileSer.tabs.some((t) => t.id === 'pg'),
  JSON.stringify(fileSer.tabs.map((t) => t.id)))
check('activeId pointing at a generating placeholder falls back to the first kept tab',
  fileSer.activeId === 'pn', String(fileSer.activeId))
check('serialize keeps only relPath / fileKind / page for file tabs',
  (() => {
    const tab = fileSer.tabs.find((t) => t.id === 'ph')
    return !!tab && tab.type === 'file'
      && tab.relPath === 'x/示意图.html' && tab.fileKind === 'html'
      && !('slug' in tab) && !('rev' in tab) && !('page' in tab) && !('generating' in tab)
  })())
check('serialize persists the pptx page', fileSer.tabs.find((t) => t.id === 'pp')?.page === 3)
check('serialize persists previewDefault only when it is true',
  fileSer.tabs.find((t) => t.id === 'pn')?.previewDefault === true
  && !('previewDefault' in serializeViewerState([makeNotesTab('p0', { relPath: 'x/a.md' })], 'p0').tabs[0]))

const fileParsed = parseViewerState({
  v: 2,
  activeId: 'pf1',
  tabs: [
    { id: 'pf1', type: 'file', relPath: 'x/示意图.html', fileKind: 'html', page: 0 },
    { id: 'pf2', type: 'file', relPath: 'x/示意图.html', fileKind: 'image' },
    { id: 'pf3', type: 'file', relPath: '', fileKind: 'image' },
    { id: 'pf4', type: 'file', relPath: 'x/bad.html', fileKind: 'note' },
    { id: 'pf5', type: 'file', relPath: 'x/导图.json', fileKind: 'mindmap' },
  ],
}, { caseInsensitive: false })
check('parse accepts file tabs and drops empty relPath / invalid fileKind',
  fileParsed.tabs.length === 2 && !fileParsed.tabs.some((t) => t.id === 'pf3' || t.id === 'pf4'),
  fileParsed.tabs.map((t) => t.id).join(','))
check('parse dedupes file tabs by path',
  fileParsed.tabs.filter((t) => t.relPath === 'x/示意图.html').length === 1)
check('parse keeps page 0 and the file kind',
  fileParsed.tabs[0].id === 'pf1' && fileParsed.tabs[0].page === 0 && fileParsed.tabs[0].fileKind === 'html')
const fileRound = parseViewerState(JSON.parse(JSON.stringify(fileSer)))
check('file state round-trips through serialize -> parse',
  fileRound.tabs.length === 3 && fileRound.activeId === 'pn' && fileRound.v === 2,
  JSON.stringify([fileRound.tabs.length, fileRound.activeId]))
check('round-trip keeps previewDefault / pptx page',
  fileRound.tabs.find((t) => t.id === 'pn')?.previewDefault === true
  && fileRound.tabs.find((t) => t.id === 'pp')?.page === 3)

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
check('draft explains that closing loses nothing', /还没有提问[\s\S]{0,200}发出后才会保存，关掉不留记录/.test(draftPane))
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

console.log('\n=== 13. closing tab revival (static) ===')
/**
 * 缺陷背景：关页签有 190ms 视觉留拍，这期间页签仍在 `tabs` 里、仍能被 findXxxTab 命中，
 * 但 `liveIds` 已把它过滤掉。若此时「激活」它（点页签 / openNote / openWeb / 外部请求），
 * 结果是内容区空白且到点被定时器删掉 —— 用户看到「点了没反应 + 页签闪一下消失」。
 * 修法是**复活**而不是复用：撤定时器 + 从 closingIds 摘出，再激活。
 */
const sliceBetween = (src, startMark, endMark) => {
  const i = src.indexOf(startMark)
  if (i < 0) return ''
  const j = src.indexOf(endMark, i + startMark.length)
  return j < 0 ? src.slice(i) : src.slice(i, j)
}

const reviveBody = sliceBetween(shell, 'const reviveClosing = useCallback(', 'const selectTab = useCallback(')
const selectBody = sliceBetween(shell, 'const selectTab = useCallback(', '/** 请某个页签「再打开一次」')
const closeBody = sliceBetween(shell, 'const closeTab = useCallback(', "/* ------------------------------------------------------------ 外部请求 */")
const bookBody = sliceBetween(shell, 'const openBook = useCallback(', '/** 打开 / 聚焦已落库的旁问')

check('shell defines reviveClosing as a stable useCallback', reviveBody.length > 0)
check('reviveClosing cancels the pending removal timer',
  /clearTimeout\(t\)/.test(reviveBody) && /closeTimersRef\.current\.delete\(id\)/.test(reviveBody))
check('reviveClosing drops the id from closingIds via a filter',
  /setClosingIds\(\(prev\) => \(prev\.includes\(id\) \? prev\.filter\(\(x\) => x !== id\) : prev\)\)/.test(reviveBody))
check('reviveClosing tests the timer id against undefined (0 is a valid timer id)',
  /const t = closeTimersRef\.current\.get\(id\)/.test(reviveBody)
  && /if \(t !== undefined\)/.test(reviveBody)
  && !/if \(t\)\s*\{/.test(reviveBody))
check('selectTab revives the tab before activating it',
  selectBody.indexOf('reviveClosing(id)') >= 0
  && selectBody.indexOf('reviveClosing(id)') < selectBody.indexOf('activateTab(')
  && selectBody.indexOf('reviveClosing(id)') < selectBody.indexOf('apply('))
check('NEGATIVE: closeTab never goes through selectTab (would revive the tab it is closing)',
  closeBody.length > 0 && !/selectTab\(/.test(closeBody) && !/reviveClosing\(/.test(closeBody))
check('closeTab keeps the post-flush existence guard and the 190ms leave-one-frame animation',
  /if \(!tabById\(tabsRef\.current, id\)\) return/.test(closeBody) && /}, 190\)/.test(closeBody))
check('every existing-tab activation path outside selectTab revives first',
  // openBook 复用「当前书架页签」是唯一不经 selectTab 的现有页签激活路径
  bookBody.length > 0 && /reviveClosing\(shelfTab\.id\)/.test(bookBody)
  && bookBody.indexOf('reviveClosing(shelfTab.id)') < bookBody.indexOf('apply(next, shelfTab.id)'))
check('liveIds still excludes closing tabs (revival is the only way back in)',
  /closingIds\.length \? ids\.filter\(\(id\) => !closingIds\.includes\(id\)\) : ids/.test(shell))

/* ---------------------------------------------------------------- 14. 作用域持久化 */
console.log('\n=== 14. scoped persistence (persistScope) ===')

// A. 纯函数：清洗与键名（真实执行 viewerTabs.ts）
check('scope sanitize keeps letters / digits / dash / underscore / colon',
  sanitizeViewerScope('tutor:ses-01_x') === 'tutor:ses-01_x',
  sanitizeViewerScope('tutor:ses-01_x'))
check('scope sanitize replaces illegal chars with _',
  sanitizeViewerScope('tutor:ses 01/x?') === 'tutor:ses_01_x_',
  sanitizeViewerScope('tutor:ses 01/x?'))
check('scope sanitize trims surrounding whitespace',
  sanitizeViewerScope('  tutor:1  ') === 'tutor:1', sanitizeViewerScope('  tutor:1  '))
check('empty / undefined scope means "course session"',
  sanitizeViewerScope('') === '' && sanitizeViewerScope(undefined) === ''
  && sanitizeViewerScope('   ') === '')
check('scope sanitize is idempotent',
  sanitizeViewerScope(sanitizeViewerScope('a b/c')) === sanitizeViewerScope('a b/c'))
check('scoped tabs key carries the sanitized scope',
  scopedViewerTabsKey('tutor:ses 01') === `${VIEWER_SCOPED_TABS_PREFIX}tutor:ses_01`,
  String(scopedViewerTabsKey('tutor:ses 01')))
check('scoped width key carries the sanitized scope',
  scopedViewerWidthKey('tutor:ses 01') === `${VIEWER_SCOPED_WIDTH_PREFIX}tutor:ses_01`,
  String(scopedViewerWidthKey('tutor:ses 01')))
check('no scope -> null (caller falls back to the legacy keys)',
  scopedViewerTabsKey('') === null && scopedViewerTabsKey(undefined) === null
  && scopedViewerWidthKey('') === null && scopedViewerWidthKey(undefined) === null)
check('NEGATIVE: scoped keys never collide with the course keys',
  scopedViewerTabsKey('x') !== 'aiTeach.rightTabs.v2'
  && !scopedViewerTabsKey('x').startsWith('aiTeach.')
  && scopedViewerWidthKey('x') !== 'aiTeachRightViewerWidth')
check('two scopes never share a key',
  scopedViewerTabsKey('tutor:a') !== scopedViewerTabsKey('tutor:b')
  && scopedViewerWidthKey('tutor:a') !== scopedViewerWidthKey('tutor:b'))

// B. 渲染层静态接线：可选 prop / 按作用域读写 / 切换时重载 / 旧键保留
const viewerTabsSrc = read(`${DIR}/viewerTabs.ts`)
check('shell accepts an optional persistScope prop',
  /persistScope\?: string/.test(shell))
check('shell sanitizes the scope before touching storage',
  /sanitizeViewerScope\(persistScope\)/.test(shell))
check('viewerTabs owns the sanitizer and both scoped key builders',
  /export function sanitizeViewerScope/.test(viewerTabsSrc)
  && /export function scopedViewerTabsKey/.test(viewerTabsSrc)
  && /export function scopedViewerWidthKey/.test(viewerTabsSrc))
check('shell reads the scoped tabs key before the legacy key',
  shell.includes('scopedViewerTabsKey(scope)')
  && shell.indexOf('scopedViewerTabsKey(scope)') < shell.indexOf('VIEWER_LS_KEYS.tabsV2'))
check('a scoped session starts empty instead of inheriting course tabs',
  /return parseViewerState\(readJson\(readLs\(scopedKey\)\)\) \?\? \{ v: 2, tabs: \[\], activeId: null \}/.test(shell))
check('scope switch reloads tabs for the new scope',
  /if \(tabsScopeRef\.current === persistScopeKey\) return/.test(shell)
  && shell.includes('loadBootState(sessionIdRef.current, persistScopeKey)'))

const scopeEffect = sliceBetween(
  shell,
  '/* ------------------------------------------------------------ 作用域切换 */',
  '/* ------------------------------------------------------------ 持久化 */',
)
check('scope switch drops per-tab transient state (closing timers / dirty / callbacks)',
  scopeEffect.length > 0
  && /closeTimersRef\.current\.forEach/.test(scopeEffect)
  && /setClosingIds\(\[\]\)/.test(scopeEffect)
  && /setDirtyIds\(\[\]\)/.test(scopeEffect)
  && /flushRef\.current\.clear\(\)/.test(scopeEffect)
  && /cbCacheRef\.current\.clear\(\)/.test(scopeEffect))
check('scope switch writes the outgoing scope before replacing the tab list',
  scopeEffect.indexOf('persistTabsState(tabsScopeRef.current') >= 0
  && scopeEffect.indexOf('persistTabsState(tabsScopeRef.current') < scopeEffect.indexOf('apply(boot.tabs'))
check('scope switch reloads the scoped width (or restores the course baseline)',
  /readScopedWidth\(nextWidthKey\)/.test(scopeEffect)
  && /setWidth\(stored\)/.test(scopeEffect)
  && /setWidth\(courseWidthRef\.current\)/.test(scopeEffect))
check('scoped width is read and written under its own key',
  /function readScopedWidth/.test(shell) && /function writeScopedWidth/.test(shell)
  && /scopedViewerWidthKey\(/.test(shell))
check('width writes are gated per scope (no cross-scope clobbering)',
  /lastScopedWidthRef/.test(shell) && /prev\.scope !== persistScopeKey/.test(shell))
check('legacy tabs key is still written for course sessions (backward compatible)',
  /window\.localStorage\.setItem\(VIEWER_LS_KEYS\.tabsV2/.test(shell))
check('legacy migration still runs only in the course branch',
  /migrateLegacyViewerState\(\{/.test(shell)
  && shell.indexOf('if (scopedKey)') < shell.indexOf('migrateLegacyViewerState({'))
check('scoped code never removes the legacy keys',
  !/removeItem\(/.test(shell))

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
