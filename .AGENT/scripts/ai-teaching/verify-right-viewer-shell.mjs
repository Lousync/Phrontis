#!/usr/bin/env node
/**
 * Contract check: AI teaching right viewer shell
 * (`src/modules/ai-teaching/right-viewer/{rightViewerPure.ts, viewerResize.ts, RightViewer.tsx}`).
 *
 * Plan: docs/ai-teaching-right-viewer-plan.md sections 3.2 / 3.3 / 5.1 / 9
 *       kernel decisions doc (2026-11-19) C5 / C6 / C7 / D5
 *
 * Locks:
 *   - pure: rail tab migration (lanes -> ask, progress/sources -> web, garbage -> web);
 *   - pure: width clamp (dead values -> 480, viewportless upper bound, innerWidth - 300);
 *   - pure: web native view must be hidden when closed or when another tab is active;
 *   - pure: tab labels + tab key guard, cross-checked against the frozen pane contracts;
 *   - static: four panes wired, webPaneHideAll called, tablist a11y, .kb-view-in keep-alive,
 *             no alert()/confirm(), width + tab persistence keys present;
 *   - static: resize gesture keeps the four-way teardown (capture, dead zone, cancel,
 *             lostpointercapture) and never leaves select-none on body.
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
const resizeSrc = read(`${DIR}/viewerResize.ts`)
const pureSrc = read(`${DIR}/rightViewerPure.ts`)
const contractsSrc = read(`${DIR}/paneContracts.ts`)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'right-viewer-shell-'))
const loadStripped = async (src, name) => {
  const file = path.join(tmpDir, `${name}.mjs`)
  fs.writeFileSync(file, stripTypeScriptTypes(src, { mode: 'strip' }))
  return import(pathToFileURL(file).href)
}

const pure = await loadStripped(pureSrc, 'rightViewerPure')
const contracts = await loadStripped(contractsSrc, 'paneContracts')

const {
  migrateRailTab, clampViewerWidth, initialViewerWidth, viewerWidthStyle,
  shouldHideWebViewer, tabLabel, isViewerTabKey,
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

// ---------------------------------------------------------------- 3. shouldHideWebViewer
console.log('\n=== 3. shouldHideWebViewer: native view visibility ===')
check('closed -> hide', shouldHideWebViewer(false, 'web') === true, '')
check('open on web -> show', shouldHideWebViewer(true, 'web') === false, '')
check('open on notes -> hide', shouldHideWebViewer(true, 'notes') === true, '')
check('closed on ask -> hide', shouldHideWebViewer(false, 'ask') === true, '')

// ---------------------------------------------------------------- 4. labels / guard
console.log('\n=== 4. tabLabel / isViewerTabKey parity with the frozen contracts ===')
check('labels follow VIEWER_TABS order (web / notes / books / ask)',
  `${tabLabel('web')}|${tabLabel('notes')}|${tabLabel('books')}|${tabLabel('ask')}` === contracts.VIEWER_TABS.map((t) => t.label).join('|'),
  'label mismatch')
check('pure guard accepts exactly the four viewer tabs',
  ['web', 'notes', 'books', 'ask'].every((k) => isViewerTabKey(k)),
  '')
check('pure guard rejects legacy / garbage keys',
  !isViewerTabKey('progress') && !isViewerTabKey('lanes') && !isViewerTabKey(null) && !isViewerTabKey(''),
  '')
check('guard agrees with paneContracts.isViewerTabKey on every probe',
  ['web', 'notes', 'books', 'ask', 'progress', 'lanes', 'sources', '', null, undefined, 0, {}]
    .every((v) => isViewerTabKey(v) === contracts.isViewerTabKey(v)),
  '')
check('migration output is always a viewer tab key',
  ['lanes', 'ask', 'progress', 'sources', 'web', 'notes', 'books', 'nope', null, undefined]
    .every((v) => isViewerTabKey(migrateRailTab(v))),
  '')

// ---------------------------------------------------------------- 5. static: shell
console.log('\n=== 5. static: RightViewer.tsx wiring ===')
check('shell imports the frozen tab list from paneContracts', /import[\s\S]{0,300}VIEWER_TABS[\s\S]{0,200}from '\.\/paneContracts'/.test(shellSrc), '')
check('all four pane slots are wired', ['web', 'notes', 'books', 'ask']
  .every((k) => shellSrc.includes(`<PaneSlot tab="${k}"`)), '')
check('panes are lazy loaded', (shellSrc.match(/lazyPane\(\(\) => import\('\.\/\w+'\)/g) || []).length === 4,
  String((shellSrc.match(/lazyPane/g) || []).length))
check('webPaneHideAll is imported and called', shellSrc.includes('webPaneHideAll')
  && shellSrc.includes('void webPaneHideAll()'), '')
check('tablist a11y: role=tablist / role=tab / aria-selected',
  shellSrc.includes('role="tablist"') && shellSrc.includes('role="tab"') && shellSrc.includes('aria-selected={active}'), '')
check('tab panels carry role=tabpanel + aria-controls link',
  shellSrc.includes('role="tabpanel"') && shellSrc.includes('aria-controls={`rv-panel-${key}`}'), '')
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

// ---------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup is best-effort */ }
process.exit(failed.length === 0 ? 0 : 1)
