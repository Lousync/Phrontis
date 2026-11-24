#!/usr/bin/env node
/**
 * Contract check: AI teaching right viewer web pane (native WebContentsView).
 *
 * Plan: /home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/ai-teaching-right-viewer-plan.md sections 6.1 / 8
 *       /home/lousync/Projects/DesginProcess/Phrontis/方案与调研/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md C1 / C3 / C4
 *
 * Static source assertions only: no `electron` import, no app boot. This module is the
 * security boundary of the whole feature, so the checks lock the four guard hooks and the
 * sandbox profile in place. The browser-level behavior (bounds math, navigation events) is
 * asserted where it can be read from source; runtime behavior is covered by the manual list.
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-web-pane-security.mjs [repo-path]
 * Output is pure ASCII (AGENTS.md); exit 0 only when every assertion passes.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

const VIEW_REL = 'electron/lib/webPaneView.ts'
const REPO_REL = 'electron/database/repositories/webPaneRepo.ts'

const readOrEmpty = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return ''
  }
}

const view = readOrEmpty(VIEW_REL)
const repo = readOrEmpty(REPO_REL)
const both = `${view}\n${repo}`

/** Slice from `export function <name>` to the next top-level `export ` declaration. */
const fnBody = (src, name) => {
  const start = src.indexOf(`export function ${name}`)
  if (start < 0) return ''
  const rest = src.slice(start)
  const next = rest.indexOf('\nexport ', 1)
  return next < 0 ? rest : rest.slice(0, next)
}

/** Count matches of a literal (non-regex) string. */
const countOf = (haystack, needle) => haystack.split(needle).length - 1

console.log('\n=== 0. files exist ===')
check(`${VIEW_REL} exists and is non-trivial`, view.length > 2000, `${view.length} chars`)
check(`${REPO_REL} exists and is non-trivial`, repo.length > 1000, `${repo.length} chars`)

console.log('\n=== 1. sandbox profile (C3 / plan 8) ===')
check('webPreferences sets sandbox: true', /sandbox\s*:\s*true/.test(view), '')
check('webPreferences sets contextIsolation: true', /contextIsolation\s*:\s*true/.test(view), '')
check('webPreferences sets nodeIntegration: false', /nodeIntegration\s*:\s*false/.test(view), '')
check('webPreferences sets webSecurity: true', /webSecurity\s*:\s*true/.test(view), '')
check('spellcheck disabled', /spellcheck\s*:\s*false/.test(view), '')
check('no nodeIntegration: true anywhere', !/nodeIntegration\s*:\s*true/.test(both), '')
check('no preload field wired into the pane webPreferences', !/\bpreload\s*:/.test(both), '')
check('persistent partition constant is persist:webtabs',
  /'persist:webtabs'/.test(view), '')
check('view actually uses the partition constant',
  /partition\s*:\s*WEB_PANE_PARTITION/.test(view), '')

console.log('\n=== 2. guard 1: window.open ===')
check('setWindowOpenHandler installed', /setWindowOpenHandler\s*\(/.test(view), '')
check('window open always denied', /action\s*:\s*'deny'/.test(view), '')
check('http(s) targets forwarded to shell.openExternal',
  /shell\.openExternal\s*\(/.test(view) && /isHttpUrl\s*\(/.test(view), '')

console.log('\n=== 3. guard 2: in-page navigation ===')
check('will-navigate hook installed', /\.on\(\s*'will-navigate'/.test(view), '')
check('will-redirect hook installed', /\.on\(\s*'will-redirect'/.test(view), '')
const navGuards = view.slice(view.indexOf("'will-navigate'"), view.indexOf("'will-attach-webview'"))
check('navigation guards call preventDefault when the URL is not http(s)',
  countOf(navGuards, 'event.preventDefault()') >= 2, String(countOf(navGuards, 'event.preventDefault()')))
check('protocol gate rejects non-http(s) schemes',
  /protocol\s*===\s*'http:'/.test(view) && /protocol\s*===\s*'https:'/.test(view), '')
check('scheme completion still re-validates the final URL',
  /toHttpUrl/.test(view) && /hasScheme/.test(view), '')

console.log('\n=== 4. guard 3: permissions ===')
check('setPermissionRequestHandler installed', /setPermissionRequestHandler\s*\(/.test(view), '')
check('permission requests are denied via callback(false)',
  /setPermissionRequestHandler\([^)]*\)\s*=>\s*callback\(false\)/.test(view.replace(/\s+/g, ' '))
  || /callback\(false\)/.test(view), '')
check('setPermissionCheckHandler installed', /setPermissionCheckHandler\s*\(/.test(view), '')
check('permission checks always false', /setPermissionCheckHandler\(\(\)\s*=>\s*false\)/.test(view), '')
check('session hardening runs once (module-level flag)',
  /sessionHardened/.test(view) && /if\s*\(sessionHardened\)\s*return/.test(view), '')

console.log('\n=== 5. guard 4: downloads ===')
check('will-download hook installed on the webtabs session',
  /\.on\(\s*'will-download'/.test(view) && /WEB_PANE_PARTITION/.test(view), '')
check('downloads are prevented', (() => {
  const i = view.indexOf("'will-download'")
  if (i < 0) return false
  return /event\.preventDefault\(\)/.test(view.slice(i, i + 400))
})(), '')
check('blocked download surfaces through webPane:changed state',
  /'webPane:changed'/.test(view) && /下载已阻止/.test(view), '')

console.log('\n=== 6. bounds and zoom ===')
const boundsBody = fnBody(view, 'setWebPaneBounds')
check('setWebPaneBounds exists', boundsBody.length > 200, `${boundsBody.length} chars`)
check('setWebPaneBounds reads getEffectiveUiZoom', /getEffectiveUiZoom\s*\(/.test(boundsBody), '')
check('CSS px are multiplied by the zoom factor',
  /Math\.round\([\s\S]{0,60}\*\s*zoom\s*\)/.test(boundsBody), '')
check('bounds are clamped to the window content area',
  /getContentBounds\s*\(/.test(boundsBody), '')
check('non-positive size hides instead of setting bad bounds',
  /width\s*<=\s*0\s*\|\|\s*height\s*<=\s*0/.test(boundsBody) && /setVisible\(false\)/.test(boundsBody), '')
check('setBounds does not auto-show the view', !/setVisible\(true\)/.test(boundsBody), '')

console.log('\n=== 7. lifecycle: cap, hide, dispose ===')
check('pane cap is 3', /WEB_PANE_MAX\s*=\s*3/.test(view), '')
check('cap violation returns the agreed message',
  /最多 \$\{WEB_PANE_MAX\} 个网页页签/.test(view), '')
check('panes stored in a Map with view + visibility',
  /new Map<string,\s*PaneRecord>/.test(view), '')
check('child view attached to window contentView',
  /contentView\.addChildView\s*\(/.test(view), '')
check('new view starts hidden', /addChildView[\s\S]{0,200}setVisible\(false\)/.test(view), '')
check('hideAllWebPanes exported and iterates every pane', (() => {
  const b = fnBody(view, 'hideAllWebPanes')
  return b.length > 80 && /setVisible\(false\)/.test(b)
})(), '')
check('closeWebPane is idempotent when the pane is gone',
  /const pane = panes\.get\(key\)\s*\n\s*if \(!pane\) return \{ ok: true \}/.test(view), '')
check('closeWebPane removes the child view and closes webContents',
  /removeChildView\s*\(/.test(view) && /webContents\.close\s*\(/.test(view), '')
check('disposeAllWebPanes exported', /export function disposeAllWebPanes/.test(view), '')
check('clearWebPaneData clears storage and cache',
  /clearStorageData\s*\(/.test(view) && /clearCache\s*\(/.test(view), '')

console.log('\n=== 8. navigation history (Electron 33) ===')
check('uses navigationHistory for back/forward',
  /navigationHistory\.canGoBack/.test(view) && /navigationHistory\.canGoForward/.test(view), '')
check('no deprecated webContents.canGoBack call',
  !/webContents\.canGoBack\s*\(/.test(view), '')
check('all webContents work is guarded by isDestroyed',
  /isDestroyed\s*\(\)/.test(view) && countOf(view, 'isDestroyed()') >= 6, String(countOf(view, 'isDestroyed()')))

console.log('\n=== 9. state channel ===')
for (const evt of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'did-fail-load', 'page-title-updated']) {
  check(`state broadcast on ${evt}`, view.includes(`'${evt}'`), '')
}
check('state payload shape matches { id, state }',
  /send\(CHANGED_CHANNEL,\s*\{ id, state:/.test(view), '')
check('broadcast skips destroyed windows',
  /win\.isDestroyed\(\)/.test(view) && /webContents\.isDestroyed\(\)/.test(view), '')

console.log('\n=== 10. IPC channels (12) ===')
const CHANNELS = [
  'webPane:create', 'webPane:setUrl', 'webPane:setBounds', 'webPane:setVisible',
  'webPane:hideAll', 'webPane:back', 'webPane:forward', 'webPane:reload',
  'webPane:close', 'webPane:state', 'webPane:clearData', 'webPane:disposeAll',
]
const missing = CHANNELS.filter((c) => !both.includes(`'${c}'`))
check('all 12 channels are registered', missing.length === 0, missing.join(', '))
check('every channel uses ipcMain.handle',
  countOf(repo, 'ipcMain.handle(') >= CHANNELS.length, String(countOf(repo, 'ipcMain.handle(')))
check('registerWebPaneHandlers is exported',
  /export function registerWebPaneHandlers\s*\(\s*\)\s*:\s*void/.test(repo), '')
check('registration is idempotent', /if \(registered\) return/.test(repo), '')
check('owner window resolved from the IPC sender',
  /BrowserWindow\.fromWebContents\(event\.sender\)/.test(repo), '')
check('missing window returns { ok:false } instead of throwing',
  /return fail\('主窗口不可用'\)/.test(repo), '')
check('disposeAll channel delegates to disposeAllWebPanes',
  /disposeAllWebPanes\(\)/.test(repo), '')

// ---------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)
process.exit(failed.length === 0 ? 0 : 1)
