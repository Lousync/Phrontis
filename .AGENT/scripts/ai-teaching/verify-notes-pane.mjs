#!/usr/bin/env node
/**
 * Contract: AI teaching right-viewer Notes pane (D1 editable notes).
 *
 * Plan: /home/lousync/Projects/Phrontis/docs/ai-teaching-right-viewer-plan.md section 6.2
 *       + kernel doc D1 (markdown editable in the viewer) / D6 (one notes folder per session,
 *         path follows F11 flattening into `产物/`).
 *
 * Covers two layers:
 *   1. pure functions in src/modules/ai-teaching/right-viewer/notesPanePure.ts
 *      (type-stripped and imported for real);
 *   2. static source contracts in NotesPane.tsx (mtime baseline / lazy editor /
 *      dirty reporting / no alert or confirm).
 *
 * Run: node .AGENT/scripts/ai-teaching/verify-notes-pane.mjs
 * Output is pure ASCII. Last line: `PASS -- N/N assertions passed` (exit 1 on failure).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const PURE_REL = 'src/modules/ai-teaching/right-viewer/notesPanePure.ts'
const PANE_REL = 'src/modules/ai-teaching/right-viewer/NotesPane.tsx'

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const ascii = (s) => String(s === undefined ? '' : s).replace(/[^\x20-\x7e]/g, '?')

/* ---------------------------------------------------------------- load pure layer */
const pureSrc = fs.readFileSync(path.join(ROOT, PURE_REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-pane-'))
const tmpFile = path.join(tmpDir, 'notesPanePure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const mod = await import(pathToFileURL(tmpFile).href)
const {
  noteNameOf,
  isNoteFile,
  pickNoteFiles,
  uniqueNotePath,
  relativeTime,
  saveStateLabel,
  mergeSaveResult,
} = mod

/* ---------------------------------------------------------------- 1. isNoteFile */
console.log('\n=== 1. isNoteFile: md / txt only (case-insensitive) ===')
check('accepts a.md', isNoteFile('AI教学/会话/笔记.md') === true)
check('accepts b.MD (uppercase extension)', isNoteFile('AI教学/b.MD') === true)
check('accepts c.txt', isNoteFile('AI教学/c.txt') === true)
check('NEGATIVE: rejects d.pdf', isNoteFile('AI教学/d.pdf') === false)
check('NEGATIVE: rejects extensionless name', isNoteFile('AI教学/README') === false)
check('NEGATIVE: rejects backup suffix md.bak', isNoteFile('AI教学/e.md.bak') === false)

/* ---------------------------------------------------------------- 2. noteNameOf */
console.log('\n=== 2. noteNameOf: dir + extension stripped ===')
check('strips directory and extension', noteNameOf('AI教学/产物/笔记.md') === '笔记')
check('keeps extensionless stem', noteNameOf('AI教学/readme') === 'readme')
check('does not eat dotfiles', noteNameOf('AI教学/.keep') === '.keep')

/* ---------------------------------------------------------------- 3. pickNoteFiles */
console.log('\n=== 3. pickNoteFiles: mtime desc, limit, no input mutation ===')
const raw = [
  { relPath: 'a/old.md', mtimeMs: 100 },
  { relPath: 'a/new.md', mtimeMs: 900 },
  { relPath: 'a/mid.txt', mtimeMs: 500 },
  { relPath: 'a/pic.png', mtimeMs: 9999 },
]
const rawSnapshot = JSON.stringify(raw)
const sorted = pickNoteFiles(raw)
check(
  'sorts by mtime desc and drops non-notes',
  sorted.map((f) => f.relPath).join(',') === 'a/new.md,a/mid.txt,a/old.md',
)
check('applies limit', pickNoteFiles(raw, 2).length === 2 && pickNoteFiles(raw, 2)[0].relPath === 'a/new.md')
check('does not mutate input array order', JSON.stringify(raw) === rawSnapshot)
check('default limit is 12', pickNoteFiles(Array.from({ length: 20 }, (_, i) => ({ relPath: `n${i}.md`, mtimeMs: i }))).length === 12)

/* ---------------------------------------------------------------- 4. uniqueNotePath */
console.log('\n=== 4. uniqueNotePath ===')
const base = 'AI教学/会话/产物/笔记.md'
check('no conflict -> base path', uniqueNotePath([], base) === base)
check('occupied -> -2', uniqueNotePath([base], base) === 'AI教学/会话/产物/笔记-2.md')
check('skips occupied -2 -> -3', uniqueNotePath([base, 'AI教学/会话/产物/笔记-2.md'], base) === 'AI教学/会话/产物/笔记-3.md')
check(
  'case-insensitive collision on Windows',
  uniqueNotePath(['AI教学/会话/产物/笔记.MD'], base) === 'AI教学/会话/产物/笔记-2.md',
)

/* ---------------------------------------------------------------- 5. relativeTime */
console.log('\n=== 5. relativeTime ===')
const now = new Date(2026, 10, 19, 10, 0, 0).getTime() // local 2026-11-19 10:00
const MIN = 60_000
const HOUR = 3_600_000
check('under a minute -> just now', relativeTime(now, now - 30_000) === '刚刚')
check('12 minutes -> 12 min ago', relativeTime(now, now - 12 * MIN) === '12 分钟前')
check('3 hours -> 3 hours ago', relativeTime(now, now - 3 * HOUR) === '3 小时前')
check('calendar yesterday -> yesterday', relativeTime(now, now - 25 * HOUR) === '昨天')
check('older -> MM-DD', relativeTime(now, now - 3 * 24 * HOUR) === '11-16')
const lateNight = new Date(2026, 10, 19, 0, 30, 0).getTime()
check(
  'cross-day but under an hour stays minutes',
  relativeTime(lateNight, lateNight - 31 * MIN) === '31 分钟前',
)
check('invalid mtime -> dash', relativeTime(now, 0) === '\u2014')

/* ---------------------------------------------------------------- 6. saveStateLabel */
console.log('\n=== 6. saveStateLabel: five states ===')
check('dirty -> unsaved label', saveStateLabel('dirty') === '未保存')
check('saving -> saving label', saveStateLabel('saving').includes('保存中'))
check('saved with clock', saveStateLabel('saved', '09:12') === '已保存 · 09:12')
check('conflict -> conflict label', saveStateLabel('conflict') === '冲突')
check('clean without clock -> saved label', saveStateLabel('clean') === '已保存')

/* ---------------------------------------------------------------- 7. mergeSaveResult */
console.log('\n=== 7. mergeSaveResult ===')
const conflict = mergeSaveResult({ mtimeMs: 111 }, { ok: false, conflict: true })
check('conflict keeps state + baseline', conflict.state === 'conflict' && conflict.mtimeMs === 111)
const saved = mergeSaveResult({ mtimeMs: 111 }, { ok: true, mtimeMs: 222 })
check('success backfills new mtime', saved.state === 'saved' && saved.mtimeMs === 222)
const savedNoMtime = mergeSaveResult({ mtimeMs: 111 }, { ok: true })
check('success without mtime keeps baseline', savedNoMtime.state === 'saved' && savedNoMtime.mtimeMs === 111)
const failed = mergeSaveResult({ mtimeMs: 111 }, { ok: false })
check('plain failure -> error', failed.state === 'error' && failed.mtimeMs === 111)

/* ---------------------------------------------------------------- 8. NotesPane source contracts */
console.log('\n=== 8. NotesPane.tsx static contracts ===')
const pane = stripComments(fs.readFileSync(path.join(ROOT, PANE_REL), 'utf8').replace(/\r\n/g, '\n'))
check('writes with a 4th mtime baseline (expectedMtimeMs)', /workspaceWriteFile\([\s\S]{0,160}?expectedMtimeMs\)/.test(pane))
check('conflict path re-reads disk and refreshes baseline', /merged\.state === 'conflict'/.test(pane) && /const disk = await workspaceReadFile/.test(pane))
check('editor is lazy-loaded', /lazy\(\s*\(\)\s*=>/.test(pane) && /<Suspense/.test(pane))
check('reports dirty state upward', /onDirtyChange/.test(pane) && /dirtyCbRef\.current\?\.\(dirty\)/.test(pane))
check('no alert() in pane', !/\balert\s*\(/.test(pane))
check('no confirm() in pane', !/\bconfirm\s*\(/.test(pane))
check('rescans on knowledge data change', /useDataChanged\('knowledge'/.test(pane))
check('writing mode comes from the editorWritingMode setting', /getSetting\('editorWritingMode'\)/.test(pane))
check('session folder resolved via aiTeachSessionFolder', /aiTeachSessionFolder\(/.test(pane))
check('new note name derived through uniqueNotePath', /uniqueNotePath\(/.test(pane) && /产物/.test(pane))
check('list capped by NOTE_LIMIT = 12', /const NOTE_LIMIT = 12/.test(pane) && /pickNoteFiles\(/.test(pane))
check('save debounce is 1000ms', /const SAVE_DEBOUNCE_MS = 1000/.test(pane))
check('request opens paths outside the list', /request\?\.relPath/.test(pane) && /isNoteFile\(rel\)/.test(pane))
check('unmount flushes pending write', /return \(\) => \{[\s\S]{0,200}?void saveNow\(\)/.test(pane))

/* ---------------------------------------------------------------- report */
let pass = 0
const fails = []
for (const c of checks) {
  if (c.pass) pass++
  else fails.push(c.name + (c.detail ? ' -> ' + ascii(c.detail) : ''))
}
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${ascii(c.name)}`)
console.log('')
if (fails.length === 0) {
  console.log(`PASS -- ${pass}/${checks.length} assertions passed`)
} else {
  for (const f of fails) console.log('[FAIL] ' + f)
  console.log(`FAIL -- ${pass}/${checks.length} assertions passed`)
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* temp cleanup is best-effort */
}
process.exit(fails.length === 0 ? 0 : 1)
