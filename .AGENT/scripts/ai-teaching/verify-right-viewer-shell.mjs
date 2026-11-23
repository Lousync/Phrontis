#!/usr/bin/env node
/**
 * Contract check: AI teaching right viewer shell
 * (`src/modules/ai-teaching/right-viewer/{rightViewerPure.ts, viewerResize.ts, viewerTabs.ts,
 *   RightViewer.tsx, ViewerChrome.tsx}`).
 *
 * Plan: docs/ai-teaching-right-viewer-plan.md sections 3.2 / 3.3 / 5.1 / 9
 *       kernel decisions doc (2026-11-19) C5 / C6 / C7 / D5
 *
 * Locks:
 *   - pure: rail tab migration (lanes -> ask, progress/sources -> web, garbage -> web);
 *   - pure: width clamp (dead values -> 480, viewportless upper bound, innerWidth - 300);
 *   - pure: reserve-aware upper bound (`middle-left + 420`, tight floor 300 at narrow windows,
 *           legacy `innerWidth - 300` / 360 floor when no reserve is given);
 *   - pure: web native view must be hidden when closed or when another tab is active;
 *   - pure: tab labels + tab key guard, cross-checked against the frozen pane contracts;
 *   - static: pane kinds come from paneContracts and the tab strip is rendered by ViewerChrome,
 *             one PaneSlot per instance id, tablist a11y on both sides of the id scheme,
 *             webPaneHideAll called, .kb-view-in keep-alive,
 *             no alert()/confirm(), width + tab persistence keys present;
 *   - static: resize gesture keeps the four-way teardown (capture, dead zone, cancel,
 *             lostpointercapture) and never leaves select-none on body.
 *
 * 2026-11-22 随动态多页签改造更新：页签条搬进 ViewerChrome.tsx（壳不再持有四固定页签），
 * 槽位改为按实例 id 渲染 —— 本节断言跟着新落点走。
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-right-viewer-shell.mjs [repo-path]
 * Output is pure ASCII (AGENTS.md); exit 0 only when every assertion passes.
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

const DIR = 'src/modules/ai-teaching/right-viewer'
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const shellSrc = read(`${DIR}/RightViewer.tsx`)
const chromeSrc = read(`${DIR}/ViewerChrome.tsx`)
const resizeSrc = read(`${DIR}/viewerResize.ts`)
const pureSrc = read(`${DIR}/rightViewerPure.ts`)
const contractsSrc = read(`${DIR}/paneContracts.ts`)
const tabsSrc = read(`${DIR}/viewerTabs.ts`)
const indexSrc = read('src/modules/ai-teaching/index.tsx')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'right-viewer-shell-'))
const loadStripped = async (src, name) => {
  const file = path.join(tmpDir, `${name}.mjs`)
  fs.writeFileSync(file, stripTypeScriptTypes(src, { mode: 'strip' }))
  return import(pathToFileURL(file).href)
}

const pure = await loadStripped(pureSrc, 'rightViewerPure')
const contracts = await loadStripped(contractsSrc, 'paneContracts')
const tabsModel = await loadStripped(tabsSrc, 'viewerTabs')

const {
  migrateRailTab, clampViewerWidth, initialViewerWidth, viewerWidthStyle,
  shouldHideWebViewer, tabLabel, isViewerTabKey,
  upperWidth, viewerReserveWidth,
  VIEWER_MIN_MIDDLE_WIDTH, VIEWER_TIGHT_MIN_WIDTH, VIEWER_MIDDLE_LEFT_FALLBACK,
} = pure

// ---------------------------------------------------------------- 1. migrateRailTab
console.log('\n=== 1. migrateRailTab: legacy right rail -> viewer tab ===')
check('lanes (side lane) migrates to ask', migrateRailTab('lanes') === 'ask', String(migrateRailTab('lanes')))
check('ask stays ask', migrateRailTab('ask') === 'ask', String(migrateRailTab('ask')))
check('progress falls back to web (not a viewer tab any more)',
  migrateRailTab('progress') === 'web', String(migrateRailTab('progress')))
check('sources falls back to web',
  migrateRailTab('sources') === 'web', String(migrateRailTab('sources')))
check('missing legacy value -> web (null and undefined and empty)',
  migrateRailTab(null) === 'web' && migrateRailTab(undefined) === 'web' && migrateRailTab('') === 'web',
  `${migrateRailTab(null)} / ${migrateRailTab(undefined)} / ${migrateRailTab('')}`)
check('web / notes / books are preserved',
  migrateRailTab('web') === 'web' && migrateRailTab('notes') === 'notes' && migrateRailTab('books') === 'books',
  `${migrateRailTab('web')} / ${migrateRailTab('notes')} / ${migrateRailTab('books')}`)
check('file is NOT migrated from the old rail (the old rail had no file tab)',
  migrateRailTab('file') === 'web', String(migrateRailTab('file')))

// ---------------------------------------------------------------- 2. clampViewerWidth
console.log('\n=== 2. clampViewerWidth: bounds and viewport guard ===')
check('too narrow 200 -> 360', clampViewerWidth(200, 1600) === 360, String(clampViewerWidth(200, 1600)))
check('too wide 1200 -> 960', clampViewerWidth(1200, 1600) === 960, String(clampViewerWidth(1200, 1600)))
check('innerWidth 1000 caps at 700', clampViewerWidth(800, 1000) === 700, String(clampViewerWidth(800, 1000)))
check('NaN -> 480', clampViewerWidth(Number.NaN, 1600) === 480, String(clampViewerWidth(Number.NaN, 1600)))
check('0 / negative -> 480', clampViewerWidth(0, 1600) === 480 && clampViewerWidth(-40, 1600) === 480,
  `${clampViewerWidth(0, 1600)} / ${clampViewerWidth(-40, 1600)}`)
check('tiny window never returns below the 360 floor (no negative width)',
  clampViewerWidth(480, 400) === 360, String(clampViewerWidth(480, 400)))
check('persisted value path equals the clamp path',
  initialViewerWidth('700', 1600) === 480 && initialViewerWidth(700, 1600) === 700,
  `${initialViewerWidth('700', 1600)} / ${initialViewerWidth(700, 1600)}`)
check('viewerWidthStyle collapses to 0 when closed',
  viewerWidthStyle(false, 480).width === '0px' && viewerWidthStyle(true, 480).width === '480px',
  `${viewerWidthStyle(false, 480).width} / ${viewerWidthStyle(true, 480).width}`)

// ---------------------------------------------------------------- 2b. middle-readable reserve
console.log('\n=== 2b. reserve-aware clamp: middle pane keeps a readable width ===')
// 2026-11-23 缺陷：上限只按 innerWidth-300 算，900px 窗下查看器仍要 360 → 中栏只剩 ≈227px
// （正文一行 4 个字、输入区工具条竖排）。reserve = 中栏左缘 + 420，窗口过窄时降到 300 一线。
check('reserve helper = middle-left + 420 (fallback 63+248)',
  viewerReserveWidth(311) === 311 + VIEWER_MIN_MIDDLE_WIDTH
  && viewerReserveWidth(null) === VIEWER_MIDDLE_LEFT_FALLBACK + VIEWER_MIN_MIDDLE_WIDTH
  && viewerReserveWidth(Number.NaN) === VIEWER_MIDDLE_LEFT_FALLBACK + VIEWER_MIN_MIDDLE_WIDTH,
  `${viewerReserveWidth(311)} / ${viewerReserveWidth(null)}`)
check('900 window + left open (reserve 311+420): upper is the 300 tight floor, not 360',
  upperWidth(900, 311 + 420) === VIEWER_TIGHT_MIN_WIDTH,
  String(upperWidth(900, 311 + 420)))
check('900 window + left open: 480 clamps to 300 (not 360)',
  clampViewerWidth(480, 900, 311 + 420) === 300, String(clampViewerWidth(480, 900, 311 + 420)))
check('900 window + left collapsed (reserve 67+420): upper ~= 413',
  upperWidth(900, 67 + 420) === 413 && clampViewerWidth(480, 900, 67 + 420) === 413,
  `${upperWidth(900, 67 + 420)} / ${clampViewerWidth(480, 900, 67 + 420)}`)
check('1280 window + left open: default 480 is left untouched',
  upperWidth(1280, 311 + 420) === 549 && clampViewerWidth(480, 1280, 311 + 420) === 480,
  `${upperWidth(1280, 311 + 420)} / ${clampViewerWidth(480, 1280, 311 + 420)}`)
check('1024 window + left open: upper 293 -> 300 tight floor',
  clampViewerWidth(480, 1024, 311 + 420) === 300, String(clampViewerWidth(480, 1024, 311 + 420)))
check('no reserve keeps the legacy innerWidth-300 rule (360 floor)',
  upperWidth(1600) === 960 && upperWidth(1000) === 700 && upperWidth(400) === 360
  && clampViewerWidth(800, 1000) === 700 && clampViewerWidth(480, 400) === 360,
  `${upperWidth(1600)} / ${upperWidth(1000)} / ${upperWidth(400)}`)
check('drag lower bound follows upper when the window is too narrow (never min > max)',
  clampViewerWidth(100, 900, 311 + 420) === 300
  && clampViewerWidth(100, 700, 311 + 420) === 300
  && clampViewerWidth(100, 1400, 311 + 420) === 360,
  `${clampViewerWidth(100, 900, 311 + 420)} / ${clampViewerWidth(100, 700, 311 + 420)} / ${clampViewerWidth(100, 1400, 311 + 420)}`)
check('tight floor never drops below 300 (no zero / negative width)',
  clampViewerWidth(480, 400, 311 + 420) === 300 && clampViewerWidth(480, 0, 311 + 420) === 480,
  String(clampViewerWidth(480, 400, 311 + 420)))

// ---------------------------------------------------------------- 3. shouldHideWebViewer
console.log('\n=== 3. shouldHideWebViewer: native view visibility ===')
check('closed -> hide', shouldHideWebViewer(false, 'web') === true, '')
check('open on web -> show', shouldHideWebViewer(true, 'web') === false, '')
check('open on notes -> hide', shouldHideWebViewer(true, 'notes') === true, '')
check('closed on ask -> hide', shouldHideWebViewer(false, 'ask') === true, '')

// ---------------------------------------------------------------- 4. labels / guard
console.log('\n=== 4. tabLabel / isViewerTabKey parity with the frozen contracts ===')
check('labels follow VIEWER_TABS order (web / notes / books / file / ask)',
  `${tabLabel('web')}|${tabLabel('notes')}|${tabLabel('books')}|${tabLabel('file')}|${tabLabel('ask')}` === contracts.VIEWER_TABS.map((t) => t.label).join('|'),
  'label mismatch')
check('pure guard accepts exactly the five viewer tabs',
  ['web', 'notes', 'books', 'ask', 'file'].every((k) => isViewerTabKey(k)),
  '')
check('pure guard rejects legacy / garbage keys',
  !isViewerTabKey('progress') && !isViewerTabKey('lanes') && !isViewerTabKey(null) && !isViewerTabKey(''),
  '')
check('guard agrees with paneContracts.isViewerTabKey on every probe',
  ['web', 'notes', 'books', 'ask', 'file', 'progress', 'lanes', 'sources', '', null, undefined, 0, {}]
    .every((v) => isViewerTabKey(v) === contracts.isViewerTabKey(v)),
  '')
check('migration output is always a viewer tab key',
  ['lanes', 'ask', 'progress', 'sources', 'web', 'notes', 'books', 'file', 'nope', null, undefined]
    .every((v) => isViewerTabKey(migrateRailTab(v))),
  '')
// VIEWER_TABS 是冻结契约里唯一的 kind 清单（页签条由实例数组驱动，不再遍历它渲染）
check('frozen VIEWER_TABS contains file between books and ask, with the shared label',
  contracts.VIEWER_TABS.length === 5
  && contracts.VIEWER_TABS.map((t) => t.key).join('|') === 'web|notes|books|file|ask'
  && contracts.VIEWER_TABS.find((t) => t.key === 'file')?.label === '文件',
  contracts.VIEWER_TABS.map((t) => t.key).join('|'))
// `file` 没有通用文件选择器，统一从左栏 / 素材 / 产物进入 —— `+` 菜单刻意不提供空文件页签
check('new-tab menu covers every openable kind and deliberately omits file',
  tabsModel.VIEWER_NEW_TAB_ORDER.every((o) => contracts.VIEWER_TABS.some((t) => t.key === o.type))
  && contracts.VIEWER_TABS.filter((t) => t.key !== 'file')
    .every((t) => tabsModel.VIEWER_NEW_TAB_ORDER.some((o) => o.type === t.key))
  && tabsModel.VIEWER_NEW_TAB_ORDER.every((o) => contracts.isViewerTabKey(o.type))
  && !tabsModel.VIEWER_NEW_TAB_ORDER.some((o) => o.type === 'file'),
  tabsModel.VIEWER_NEW_TAB_ORDER.map((o) => o.type).join('|'))

// ---------------------------------------------------------------- 4b. frozen file contracts
console.log('\n=== 4b. frozen file tab contracts ===')
check('viewerTabs exposes the file kind + factory + lookups + live cap',
  /export type FilePaneKind = 'html' \| 'image' \| 'mindmap' \| 'pptx'/.test(tabsSrc)
  && tabsSrc.includes('export function makeFileTab(')
  && tabsSrc.includes('export function isFilePaneKind(')
  && tabsSrc.includes('export function findFileTab(')
  && tabsSrc.includes('export function findAnyPathTab(')
  && tabsSrc.includes('export const VIEWER_FILE_LIVE_CAP = 3'), '')
check('paneContracts freezes ViewerOpenRequest with the begin/commit/drop protocol',
  /export interface ViewerOpenRequest \{/.test(contractsSrc)
  && /mode\?: 'open' \| 'begin' \| 'commit' \| 'drop'/.test(contractsSrc)
  && /fileKind\?: FilePaneKind/.test(contractsSrc)
  && /previewDefault\?: boolean/.test(contractsSrc)
  && /slug\?: string/.test(contractsSrc)
  && /page\?: number/.test(contractsSrc), '')
check('paneContracts freezes FilePaneProps (no existing field retyped)',
  /export interface FilePaneProps extends ViewerPaneContext \{/.test(contractsSrc)
  && /initialRelPath: string/.test(contractsSrc)
  && /onPageChange\?: \(page: number\) => void/.test(contractsSrc)
  && /onTalkPage\?: \(page: \{ name: string; page: number; n: number; text: string \}\) => void/.test(contractsSrc), '')
check('notes tabs can request preview-on-open but new notes stay in edit mode',
  tabsSrc.includes('previewDefault?: boolean') && tabsSrc.includes('previewDefault: true'), '')

// ---------------------------------------------------------------- 5. static: shell
console.log('\n=== 5. static: RightViewer.tsx + ViewerChrome.tsx wiring ===')
// 壳只管模型与槽位：kind 类型从 paneContracts 取，页签条整套渲染搬进 ViewerChrome
check('shell takes pane kinds from paneContracts, ViewerChrome renders the strip',
  /import \{[\s\S]{0,240}type ViewerPaneType[\s\S]{0,80}from '\.\/paneContracts'/.test(shellSrc)
  && shellSrc.includes('isViewerTabKey')
  && /import type \{ ViewerPaneType \} from '\.\/paneContracts'/.test(chromeSrc)
  && chromeSrc.includes('role="tablist"')
  && !shellSrc.includes('VIEWER_TABS') && !chromeSrc.includes('VIEWER_TABS'),
  'fixed tab list still referenced')
check('one PaneSlot per tab instance, all five kinds dispatched',
  (shellSrc.match(/<PaneSlot key=\{tab\.id\} tabId=\{tab\.id\} active=\{active\}>/g) || []).length === 5
  && ['web', 'notes', 'books', 'file', 'ask'].every((k) =>
    shellSrc.includes(`tab.type === '${k}'`) || (k === 'ask' && shellSrc.includes('<AskPane'))),
  String((shellSrc.match(/<PaneSlot key=\{tab\.id\}/g) || []).length))
check('panes are lazy loaded', (shellSrc.match(/lazyPane\(\(\) => import\('\.\/\w+'\)/g) || []).length === 5,
  String((shellSrc.match(/lazyPane/g) || []).length))
check('panes are mounted from the live-window ids (LRU), not from a fixed kind list',
  /tabs\.filter\(\(t\) => liveIds\.includes\(t\.id\)\)\.map\(paneFor\)/.test(shellSrc),
  '')
check('webPaneHideAll is imported and called', shellSrc.includes('webPaneHideAll')
  && shellSrc.includes('void webPaneHideAll()'), '')
check('tablist a11y: role=tablist / role=tab / aria-selected (ViewerChrome)',
  chromeSrc.includes('role="tablist"') && chromeSrc.includes('role="tab"')
  && chromeSrc.includes('aria-selected={active}')
  && chromeSrc.includes('id={`rv-tab-${tab.id}`}')
  && chromeSrc.includes('aria-controls={`rv-panel-${tab.id}`}'), '')
check('tab panels carry role=tabpanel + aria-labelledby on the same instance id',
  shellSrc.includes('role="tabpanel"')
  && shellSrc.includes('id={`rv-panel-${tabId}`}')
  && shellSrc.includes('aria-labelledby={`rv-tab-${tabId}`}')
  && shellSrc.includes('aria-hidden={!active}'), '')
check('tab switch animation uses the shared .kb-view-in token', shellSrc.includes('kb-view-in'), '')
check('keep-alive: inactive panes stay mounted via display:none',
  shellSrc.includes("display: active ? 'flex' : 'none'"), '')
check('closed panel is inert (no focus into the 0-width strip)', shellSrc.includes('inert={!open}'), '')
check('overlay shell has no backdrop / mask layer',
  !/backdrop|fixed inset-0/.test(shellSrc), '')
check('single-layer shadow only, dropped when closed',
  shellSrc.includes('shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.35)]') && shellSrc.includes('shadow-none'), '')
check('no alert() / confirm() in the shell',
  !/\balert\s*\(/.test(shellSrc) && !/\bconfirm\s*\(/.test(shellSrc), '')
check('open/close transition uses the animation tokens, none while dragging',
  shellSrc.includes('var(--dur-std) var(--ease-kb)') && /dragging \|\| reducedMotion/.test(shellSrc), '')
check('reduced motion is honoured (pane animation + panel transition)',
  shellSrc.includes('motion-reduce:animate-none') && shellSrc.includes('prefers-reduced-motion'), '')

// ---------------------------------------------------------------- 6. static: persistence
console.log('\n=== 6. static: persistence keys ===')
check('width setting key is aiTeachRightViewerWidth', resizeSrc.includes("'aiTeachRightViewerWidth'"), '')
check('width is read through getSettingRaw', resizeSrc.includes('getSettingRaw(VIEWER_WIDTH_SETTING_KEY)'), '')
check('width is written through setSettingRaw', resizeSrc.includes('setSettingRaw(VIEWER_WIDTH_SETTING_KEY'), '')
check('width write is debounced', /PERSIST_DEBOUNCE_MS\s*=\s*300/.test(resizeSrc), '')
check('double click / reset restores the default width', shellSrc.includes('onDoubleClick={reset}'), '')
check('tab keys live in paneContracts: aiTeach.rightTab / aiTeach.railTab',
  contractsSrc.includes("'aiTeach.rightTab'") && contractsSrc.includes("'aiTeach.railTab'"), '')
check('shell reads the new tab key first, legacy rail tab second',
  shellSrc.includes('readLs(VIEWER_LS_KEYS.tab)') && shellSrc.includes('readLs(VIEWER_LS_KEYS.legacyRailTab)'), '')
check('legacy key is migrated but not deleted',
  !/removeItem\(\s*VIEWER_LS_KEYS\.legacyRailTab/.test(shellSrc), '')

// ---------------------------------------------------------------- 7. static: resize gesture
console.log('\n=== 7. static: viewerResize.ts drag session ===')
check('pointer capture is taken on pointerdown', resizeSrc.includes('setPointerCapture(e.pointerId)'), '')
check('4px dead zone before the drag really starts',
  /DRAG_DEAD_ZONE_PX\s*=\s*4/.test(resizeSrc) && resizeSrc.includes('DRAG_DEAD_ZONE_PX'), '')
check('body gets select-none while dragging',
  resizeSrc.includes("BODY_SELECT_CLASS = 'select-none'") && resizeSrc.includes('classList.add(BODY_SELECT_CLASS)'), '')
check('four-way teardown: pointerup / pointercancel / lostpointercapture / unmount',
  resizeSrc.includes("addEventListener('pointerup'")
  && resizeSrc.includes("addEventListener('pointercancel'")
  && resizeSrc.includes("addEventListener('lostpointercapture'")
  && /classList\.remove\(BODY_SELECT_CLASS\)/.test(resizeSrc), '')
check('body pollution is cleared on unmount', /return \(\) => \{[\s\S]*clearBody\(\)[\s\S]*\}/.test(resizeSrc), '')
check('window resize re-clamps the width', /addEventListener\('resize'/.test(resizeSrc), '')
check('hook returns the frozen API surface', ['width', 'setWidth', 'dragging', 'beginDrag', 'reset']
  .every((k) => new RegExp(`\\b${k}\\b`).test(resizeSrc)), '')

// ---------------------------------------------------------------- 8. static: reserve wiring
console.log('\n=== 8. static: middle-pane reserve wiring (index.tsx -> shell -> hook) ===')
check('clamp rule lives in exactly one place (pure layer, imported by the hook)',
  pureSrc.includes('export function clampViewerWidth') && !resizeSrc.includes('function clampWidth')
  && resizeSrc.includes('clampViewerWidth'), 'duplicate clamp or missing import')
check('index.tsx measures the middle section left edge',
  indexSrc.includes('ref={attachMiddleSection}')
  && indexSrc.includes('getBoundingClientRect()') && indexSrc.includes('rect.left'),
  'middle section ref / measurement missing')
check('index.tsx observes the middle section with a ResizeObserver',
  indexSrc.includes('new ResizeObserver') && indexSrc.includes('attachMiddleSection')
  && indexSrc.includes('middleSectionRef'), 'ResizeObserver wiring missing')
check('index.tsx computes the reserve via the pure helper',
  indexSrc.includes('viewerReserveWidth(') && indexSrc.includes('reserve={viewerReserve}'),
  'reserve not computed / not passed')
check('left rail reports width changes so the reserve is re-measured',
  /onWidthChange=\{syncViewerReserve\}/.test(indexSrc), 'left panel onWidthChange missing')
check('shell forwards reserve into useViewerWidth',
  shellSrc.includes('reserve?: number') && shellSrc.includes('useViewerWidth({ open, reserve })'),
  'reserve not forwarded')
check('hook re-clamps when reserve changes',
  /\[opts\.reserve, applyWidth, schedulePersist\]/.test(resizeSrc), 'reserve change effect missing')

// ---------------------------------------------------------------- 9. static: file pane + artifacts + fullscreen
console.log('\n=== 9. static: file pane wiring / artifact protocol / fullscreen ===')
// 2026-11-23 第三批（查看器壳层）：工件栏并入查看器 → 多一种 `file` 页签 + `⤢` 全屏。
check('FilePane is lazy loaded through the same normaliser',
  /const FilePane = lazyPane\(\(\) => import\('\.\/FilePane'\), 'FilePane'\)/.test(shellSrc), '')
check('file tabs keep their own PaneSlot branch with the frozen FilePaneProps',
  shellSrc.includes("if (tab.type === 'file')")
  && shellSrc.includes('<FilePane')
  && shellSrc.includes('initialRelPath={tab.relPath}')
  && shellSrc.includes('fileKind={tab.fileKind}')
  && shellSrc.includes('rev={tab.rev ?? 0}')
  && shellSrc.includes('page={tab.page}')
  && shellSrc.includes('onPageChange={cached(')
  && shellSrc.includes('onOpenFileRef={cached(')
  && shellSrc.includes('onTalkPage={cached('), 'file pane props missing')
check('notes tabs get previewDefault so file-tree opens land in preview',
  shellSrc.includes('initialPreview={tab.previewDefault}'), '')
check('a file request with an empty relPath never creates an empty file tab',
  /if \(type === 'file'\) \{\s*\/\/[^\n]*\n\s*if \(!rel\) return/.test(shellSrc), 'relPath guard missing')
// 统一入口：所有文件打开都走同一个 openFile（跨 notes / file 去重），宿主不再各写一套
check('every file entry funnels through one openFile() with cross-type dedupe',
  shellSrc.includes('const openFile = useCallback(')
  && shellSrc.includes('findAnyPathTab(tabsRef.current, rel)')
  && shellSrc.includes('openFile(rel)')
  && shellSrc.includes('makeFileTab(newTabId()'), 'unified openFile missing')
check('request protocol branches on mode begin / commit / drop',
  /const mode = request\.mode \?\? 'open'/.test(shellSrc)
  && shellSrc.includes("mode === 'drop'") && shellSrc.includes("mode === 'begin'")
  && shellSrc.includes("mode === 'commit'")
  && shellSrc.includes('dropArtifact(request.slug)')
  && shellSrc.includes('beginArtifact({') && shellSrc.includes('commitArtifact({'), '')
check('begin merges by slug and keeps one generating placeholder per artifact',
  /`gen:\$\{slug \|\| fileKind\}`/.test(shellSrc)
  && /generating: true/.test(shellSrc)
  && /findGenerating\(slug\)/.test(shellSrc), 'begin protocol missing')
check('commit reuses an existing formal tab instead of opening a duplicate',
  /const formal = findFileTab\(tabsRef\.current, rel\)/.test(shellSrc)
  && /formal\.id !== ph\.id/.test(shellSrc)
  && /closeTabById\(tabsRef\.current, activeIdRef\.current, ph\.id\)/.test(shellSrc), '')
check('commit converts the placeholder in place (drops generating / slug, bumps rev)',
  shellSrc.includes('type: \'file\',') && shellSrc.includes('generating !== true')
  && /relPath: rel,\s*\n\s*fileKind,\s*\n\s*rev: \(t\.rev \?\? 0\) \+ 1/.test(shellSrc), '')
check('drop removes generating placeholders without the close animation',
  /dropArtifact = useCallback/.test(shellSrc)
  && /t\.type !== 'file' \|\| t\.generating !== true/.test(shellSrc)
  && /apply\(next, nextActive\)/.test(shellSrc)
  && !/dropArtifact[\s\S]{0,600}closeTab\(/.test(shellSrc), '')
// 全屏：按钮在关闭面板左侧，状态归壳，宽度 / 焦点 / Esc 三条边界
check('viewer chrome has the fullscreen toggle left of the close button',
  chromeSrc.includes('Maximize2') && chromeSrc.includes('Minimize2')
  && chromeSrc.includes('aria-pressed={expanded}')
  && chromeSrc.includes("data-tip={expanded ? '退出全屏（Esc）' : '全屏'}")
  && chromeSrc.includes('ref={expandButtonRef}')
  && chromeSrc.indexOf('{expandButton}') < chromeSrc.indexOf('{closePanelButton}'), '')
check('shell owns the expanded state and reports width 0 while fullscreen',
  /const \[expanded, setExpanded\] = useState\(false\)/.test(shellSrc)
  && /onWidthChangeRef\.current\?\.\(open && !expanded \? width : 0\)/.test(shellSrc), '')
check('fullscreen covers the module area (left 0 / width 100%) above the panel layer',
  /\{ left: 0, right: 0, width: '100%', minWidth: '0px' \}/.test(shellSrc)
  && shellSrc.includes("full ? 'z-40' : 'z-30'"), '')
check('fullscreen drops the drag handle (nothing to resize while covered)',
  /\{!full && \(/.test(shellSrc) && /role="separator"/.test(shellSrc)
  && /onDoubleClick=\{reset\}/.test(shellSrc), '')
check('Esc exits fullscreen only while expanded; closing the panel resets it',
  /if \(!full\) return[\s\S]{0,320}addEventListener\('keydown'/.test(shellSrc)
  && shellSrc.includes("e.key !== 'Escape'") && shellSrc.includes('e.stopPropagation()')
  && shellSrc.includes('if (!open && expanded) setExpanded(false)'), '')
check('leaving fullscreen returns focus to the toggle button',
  /expandBtnRef\.current\?\.focus\(\{ preventScroll: true \}\)/.test(shellSrc), '')
check('TYPE_ICONS keeps the Record complete and the strip icon follows fileKind',
  /const TYPE_ICONS: Record<ViewerPaneType, typeof Globe> = \{[\s\S]{0,220}file: FileText/.test(chromeSrc)
  && chromeSrc.includes("tab.fileKind === 'html' ? FileCode2")
  && chromeSrc.includes("tab.fileKind === 'mindmap' ? Network")
  && chromeSrc.includes(': Presentation'), '')
check('the retired artifacts pane is not referenced by the shell',
  !shellSrc.includes('ArtifactsPane') && !chromeSrc.includes('ArtifactsPane'), '')

// ---------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup is best-effort */ }
process.exit(failed.length === 0 ? 0 : 1)
