#!/usr/bin/env node
/**
 * Contract: AI teaching composer model pill (collapse -> icon, hover/linger expand).
 *
 * Plan: docs/ui-animation-plan.md section 2 (`.kb-collapse-x`) + section 3 C.
 * Reference implementation: DeepTutor `use-linger-expand` / `ToolbarLabel` /
 * `ModelSelector` (see tmp/deeptutor-src ... ModelSelector.tsx).
 *
 * Locks:
 *   1. src/lib/useLingerExpand.ts exports expanded / linger / triggerProps, the
 *      1200ms default, hover / focus / open / lingering state machine, timer cleanup.
 *   2. the composer model button uses `.kb-collapse-x` + `open`, keeps the full
 *      model name + effort in data-tip / aria-label, exposes aria-expanded.
 *   3. click path expands first, then opens the menu on the next frame (rAF) so
 *      useAnchoredMenu measures the expanded geometry; selection and every menu
 *      close call linger().
 *   4. no `transition-all` anywhere in the touched source; no hand-rolled width
 *      animation and no second reduced-motion branch (the token owns it).
 *   5. no hardcoded model names (label derives from effModelBare / EFFORT_LABEL).
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-model-pill.mjs [repo-path]
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

let pass = 0
const fails = []
const check = (name, cond, detail = '') => {
  if (cond) pass++
  else fails.push(name + (detail ? '  -- ' + detail : ''))
}

/** Strip comments but stay aware of string literals (so `//` inside URLs is kept). */
function stripComments(src) {
  let out = ''
  let state = 'code' // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i++; continue }
      if (c === '/' && n === '*') { state = 'block'; i++; continue }
      if (c === "'") { state = 'sq'; out += c; continue }
      if (c === '"') { state = 'dq'; out += c; continue }
      if (c === '`') { state = 'tpl'; out += c; continue }
      out += c
      continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } continue }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i++ } continue }
    if (c === '\\') { out += c + (n ?? ''); i++; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'
      out += c
      continue
    }
    out += c
  }
  return out
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const TEACH_REL = 'src/modules/ai-teaching/index.tsx'
const HOOK_REL = 'src/lib/useLingerExpand.ts'
const DOC_REL = 'docs/ui-animation-plan.md'
const CSS_REL = 'src/styles/index.css'

const teachRaw = read(TEACH_REL)
const teach = stripComments(teachRaw)
const hookRaw = read(HOOK_REL)
const hook = stripComments(hookRaw)
const doc = read(DOC_REL)

const count = (s, sub) => s.split(sub).length - 1

// ------------------------------------------------------------------ 1. hook API
console.log('\n=== 1. useLingerExpand: API and state machine ===')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pill-'))
const tmpFile = path.join(tmpDir, 'useLingerExpand.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(hookRaw, { mode: 'strip' }))
// The hook only imports `react`; link node_modules so the temp copy resolves it
// exactly like the real module would (no copies of the implementation).
try {
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmpDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
} catch { /* a pre-existing link is fine */ }
const mod = await import(pathToFileURL(tmpFile).href)

check('hook exports useLingerExpand()', typeof mod.useLingerExpand === 'function')
check('hook exports isLingerExpanded()', typeof mod.isLingerExpanded === 'function')
check('LINGER_EXPAND_MS = 1200', mod.LINGER_EXPAND_MS === 1200, String(mod.LINGER_EXPAND_MS))
check('default linger window is the exported constant',
  /lingerMs\s*=\s*LINGER_EXPAND_MS/.test(hook), '')

const state = (over) => mod.isLingerExpanded({ open: false, hovered: false, keyboardFocused: false, lingering: false, ...over })
check('base state (no reason) collapses', state({}) === false)
check('hover expands', state({ hovered: true }) === true)
check('keyboard focus expands', state({ keyboardFocused: true }) === true)
check('open menu expands', state({ open: true }) === true)
check('lingering window keeps it expanded', state({ lingering: true }) === true)
check('all reasons off collapses again', state({ hovered: false, keyboardFocused: false, open: false, lingering: false }) === false)

const ret = hook.slice(hook.indexOf('return {'), hook.indexOf('triggerProps: {'))
check('returns expanded', /expanded:\s*isLingerExpanded\(/.test(hook), '')
check('returns linger', /^\s*linger,$/m.test(ret), '')
check('returns triggerProps spread with hover handlers',
  /triggerProps:\s*\{/.test(hook) && /onMouseEnter,/.test(hook) && /onMouseLeave,/.test(hook), '')
check('focus only counts when :focus-visible', /matches\(':focus-visible'\)/.test(hook), '')
check('blur clears focus and lingers', /onBlur:[\s\S]{0,120}?linger\(\)/.test(hook), '')
check('hover clears the linger timer (no stale collapse)', /onMouseEnter[\s\S]{0,200}?clearTimer\(\)/.test(hook), '')
check('timer is cleared on unmount', /useEffect\(\(\)\s*=>\s*clearTimer/.test(hook), '')
check('linger restarts (does not stack) the timer', /const linger = useCallback\([\s\S]{0,160}?clearTimer\(\)[\s\S]{0,160}?setTimeout/.test(hook), '')
check('hook has no framer-motion / animation dependency', !/framer-motion|motion\./.test(hook), '')

// smoke render: the hook must actually produce the documented shape (SSR is
// enough - no effects/timers needed for the initial state).
const React = await import('react')
const { renderToString } = await import('react-dom/server')
let captured = null
const Probe = () => { captured = mod.useLingerExpand(false); return React.createElement('i', null, String(captured.expanded)) }
const html = renderToString(React.createElement(Probe))
check('hook renders collapsed by default', html.includes('false') && captured.expanded === false, html)
check('hook returns a callable linger()', typeof captured.linger === 'function')
check('triggerProps exposes hover + focus handlers',
  ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur'].every((k) => typeof captured.triggerProps[k] === 'function'),
  Object.keys(captured.triggerProps).join(','))
let capturedOpen = null
const ProbeOpen = () => { capturedOpen = mod.useLingerExpand(true); return React.createElement('i') }
renderToString(React.createElement(ProbeOpen))
check('open menu forces the expanded state', capturedOpen.expanded === true)

// ------------------------------------------------------------------ 2. button
console.log('\n=== 2. composer model button: collapse-x + a11y ===')
check('imports the hook', /import \{ useLingerExpand \} from '\.\.\/\.\.\/lib\/useLingerExpand'/.test(teach), '')
check('wires the hook to the menu open state', /useLingerExpand\(modelMenu\.open\)/.test(teach), '')

const btnStart = teach.indexOf('<button ref={modelMenuTriggerRef}')
const btnEnd = teach.indexOf('{modelMenu.open && modelMenu.pos && (', btnStart)
const btn = btnStart >= 0 && btnEnd > btnStart ? teach.slice(btnStart, btnEnd) : ''
check('button block found', btn.length > 0, btnStart >= 0 ? 'end marker missing' : 'start marker missing')
if (btn) {
  check('label wrapper uses .kb-collapse-x', /kb-collapse-x/.test(btn), '')
  check('.kb-collapse-x gets the open class from expanded', /kb-collapse-x\$\{modelPill\.expanded \? ' open' : ''\}/.test(btn), '')
  check('button exposes aria-expanded', /aria-expanded=\{modelMenu\.open\}/.test(btn), '')
  check('collapsed state keeps the full label in aria-label', /aria-label=\{modelPillTip\}/.test(btn), '')
  check('collapsed state keeps the full label in data-tip', /data-tip=\{modelPillTip\}/.test(btn), '')
  check('hover / focus / open handlers spread from the hook', /\{\.\.\.modelPill\.triggerProps\}/.test(btn), '')
  check('effort chip lives inside the collapsible label', /EFFORT_LABEL\[convoEffort\]/.test(btn), '')
  check('model name falls back to the default label, not a hardcoded name',
    /effModelBare \|\| '\u9ed8\u8ba4'/.test(btn), '')
  check('chevron uses the shared .kb-chevron token', /kb-chevron/.test(btn), '')
  check('click goes through onModelPillClick', /onClick=\{onModelPillClick\}/.test(btn), '')
  check('no inline width style on the collapsible label', !/style=\{\{[^}]*width/.test(btn), '')
  check('no hand-rolled width transition in the button', !/transition-\[[^\]]*width/.test(btn), '')
  check('no second reduced-motion branch in the button', !/matchMedia|prefers-reduced-motion/.test(btn), '')
}

check('pill tip includes model name + effort, derived not hardcoded',
  /const modelPillLabel = `\$\{effModelBare \|\| '\u9ed8\u8ba4'\}/.test(teach)
  && /convoEffort !== 'off'[\s\S]{0,80}?EFFORT_LABEL\[convoEffort\]/.test(teach), '')
check('pill tip is built from modelPillLabel', /const modelPillTip = `[^`]*\$\{modelPillLabel\}/.test(teach), '')

// ------------------------------------------------------------------ 3. linger wiring
console.log('\n=== 3. click path, selection and menu close all linger ===')
const clickStart = teach.indexOf('const onModelPillClick')
const clickBlock = clickStart >= 0 ? teach.slice(clickStart, clickStart + 900) : ''
check('click handler found', clickBlock.length > 0)
if (clickBlock) {
  check('click handler lingers (keeps the label readable)', /modelPill\.linger\(\)/.test(clickBlock), '')
  check('click handler opens the menu on the next frame (rAF)', /requestAnimationFrame\(/.test(clickBlock), '')
  check('rAF re-measures via openModelMenu(triggerRef)', /requestAnimationFrame\([\s\S]{0,220}?openModelMenu\(el\)/.test(clickBlock), '')
  check('click handler closes an already-open menu', /if \(modelMenu\.open\)[\s\S]{0,120}?modelMenu\.close\(\)/.test(clickBlock), '')
  check('double clicks are guarded', /modelPillOpening/.test(clickBlock), '')
}

const itemStart = teach.indexOf('menuModelEntries.map((e) =>')
const itemBlock = itemStart >= 0 ? teach.slice(itemStart, itemStart + 700) : ''
check('menu item: pickModel then close then linger',
  /pickModel\(e\.id\); modelMenu\.close\(\); modelPill\.linger\(\)/.test(itemBlock), '')

check('menu close edge (outside click / Esc) also lingers',
  /modelPillWasOpen\.current && !modelMenu\.open\) modelPill\.linger\(\)/.test(teach), '')
check('anchor still comes from useAnchoredMenu with the 248px menu width',
  /useAnchoredMenu\(modelMenuTriggerRef, modelMenuRef, 248\)/.test(teach), '')
check('trigger ref is bound to the button (rAF reads it)',
  /<button ref=\{modelMenuTriggerRef\}/.test(teach), '')

// ------------------------------------------------------------------ 4. animation hygiene
console.log('\n=== 4. animation tokens and no transition-all ===')
check('AI teaching pane has no transition-all (comments stripped)', count(teach, 'transition-all') === 0,
  'occurrences: ' + count(teach, 'transition-all'))
check('hook has no transition-all', count(hook, 'transition-all') === 0, '')
check('docs token table documents .kb-collapse-x', /\| `\.kb-collapse-x` \|/.test(doc), '')
check('docs describe the 0fr<->1fr behaviour', /0fr.{0,4}1fr/.test(doc), '')

const cssExists = fs.existsSync(path.join(ROOT, CSS_REL))
let cssHasToken = false
if (cssExists) {
  const css = read(CSS_REL)
  cssHasToken = css.includes('.kb-collapse-x')
  if (cssHasToken) {
    // The CSS is owned by another change; if it landed, it must be the agreed token.
    check('index.css .kb-collapse-x uses grid-template-columns 0fr',
      /\.kb-collapse-x \{[^}]*grid-template-columns:\s*0fr/.test(css), '')
    check('index.css .kb-collapse-x.open switches to 1fr',
      /\.kb-collapse-x\.open \{[^}]*grid-template-columns:\s*1fr/.test(css), '')
    check('index.css .kb-collapse-x uses --dur-std',
      /\.kb-collapse-x \{[^}]*var\(--dur-std/.test(css), '')
    check('index.css .kb-collapse-x child is clipped / non-wrapping',
      /\.kb-collapse-x > \* \{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/.test(css), '')
  }
}
console.log('  [INFO] index.css .kb-collapse-x ' + (cssHasToken ? 'present (token verified)' : 'not added yet (owned by the CSS batch)'))

// ------------------------------------------------------------------ 5. no hardcoded models
console.log('\n=== 5. no hardcoded model names / no dead paths ===')
const NAME_HITS = teachRaw.match(/DeepSeek|Claude|GPT-[0-9]|GLM-[0-9]|gemini/gi) ?? []
check('AI teaching pane mentions no concrete model name', NAME_HITS.length === 0, NAME_HITS.join(','))
check('old plain-text trigger onClick is gone', !/onClick=\{\(e\) => openModelMenu\(e\.currentTarget\)\}/.test(teach), '')

// ------------------------------------------------------------------ report
console.log('')
for (const f of fails) console.log('  [FAIL] ' + f)
console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} -- ${pass}/${pass + fails.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
process.exit(fails.length === 0 ? 0 : 1)
