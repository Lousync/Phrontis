#!/usr/bin/env node
/**
 * Contract check: current reading context (AI teaching tutor mode, R slice).
 *
 * Plan: docs/ai-teaching-tutor-mode-plan.md 2.4 / 6 (frozen shape + truncation),
 *       section 4 split R (store + PDF/EPUB publishers only).
 *
 * Assertions:
 *   A. Real implementation of src/lib/readingContext.ts (strip types, then import):
 *      clamp boundary (short / 3000 / 3001 / empty / custom max), store publish/get,
 *      shallow-compare dedupe, null clear, idempotent unsubscribe, multi-subscriber.
 *      Plus clearReadingContextOf scope guard (only clears its own relPath).
 *   B. Static wiring:
 *      PdfReaderView publishes page + label, uses a request sequence guard and clears
 *      on unmount/file switch; EpubReaderView publishes section text + label and clears
 *      the same way. Both call clampReadingText.
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-reading-context.mjs [repoPath]
 * Output is pure ASCII (no emoji, AGENTS.md); exit 0 only when everything passes.
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

const REL = 'src/lib/readingContext.ts'
const PDF_REL = 'src/components/shared/pdf/PdfReaderView.tsx'
const EPUB_REL = 'src/components/shared/epub/EpubReaderView.tsx'

/* ---------------------------------------------------------------- A. store / clamp */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-context-verify-'))
const tmpFile = path.join(tmpDir, 'readingContext.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(read(REL), { mode: 'strip' }))
const {
  READING_CONTEXT_LIMIT,
  clampReadingText,
  isReadingTextTruncated,
  publishReadingContext,
  getReadingContext,
  subscribeReadingContext,
  clearReadingContextOf,
} = await import(pathToFileURL(tmpFile).href)

const NOTE_3000 = '\n\n\uFF08\u53EA\u8BFB\u4E86\u524D 3000 \u5B57\uFF09'
const note = (max) => `\n\n\uFF08\u53EA\u8BFB\u4E86\u524D ${max} \u5B57\uFF09`

console.log('\n=== 1. readingContext.ts has no React / DOM dependency ===')
const relSrc = read(REL)
check('no react import', !/from\s+['"]react['"]/.test(relSrc))
check('no direct window/document reference', !/\bwindow\.|\bdocument\./.test(relSrc))
check('limit exported as 3000', READING_CONTEXT_LIMIT === 3000, String(READING_CONTEXT_LIMIT))

console.log('\n=== 2. clampReadingText: pure, boundary-exact ===')
check('empty string stays empty', clampReadingText('') === '')
check('non-string input -> empty', clampReadingText(undefined) === '' && clampReadingText(null) === '')
check('short text unchanged', clampReadingText('hello') === 'hello')
const exactly = 'a'.repeat(3000)
check('3000 chars unchanged', clampReadingText(exactly) === exactly)
check('3000 chars not truncated', isReadingTextTruncated(exactly) === false)
const over = 'b'.repeat(3001)
const clamped = clampReadingText(over)
check('3001 chars -> first 3000 + note', clamped === 'b'.repeat(3000) + NOTE_3000)
check('3001 chars -> isTruncated true', isReadingTextTruncated(clamped) === true)
check('note carries actual max (3000)', clamped.includes('3000'))
const custom = clampReadingText('c'.repeat(11), 10)
check('custom max -> note carries that max', custom === 'c'.repeat(10) + note(10))
check('custom max -> isTruncated with same max', isReadingTextTruncated(custom, 10) === true)
check('isTruncated with wrong max -> false', isReadingTextTruncated(custom, 3000) === false)
check('clamp is idempotent (already clamped stays same)', clampReadingText(clamped) === clamped)
check('pure (source text not mutated)', over.length === 3001 && over === 'b'.repeat(3001))

console.log('\n=== 3. store: publish / get / shallow dedupe ===')
check('initial state is null', getReadingContext() === null)
const page1 = { relPath: 'books/a.pdf', kind: 'pdf', page: 1, label: '\u7B2C 1 \u9875', text: 'alpha' }
publishReadingContext(page1)
const got1 = getReadingContext()
check('publish -> get returns content', !!got1 && got1.relPath === 'books/a.pdf' && got1.page === 1 && got1.text === 'alpha')
check('snapshot identity is stable between reads', getReadingContext() === got1)
check('publish copies (caller mutation cannot leak)', (() => {
  page1.text = 'mutated'
  return getReadingContext().text === 'alpha'
})())
let notifications = 0
const offA = subscribeReadingContext(() => { notifications += 1 })
publishReadingContext({ relPath: 'books/a.pdf', kind: 'pdf', page: 1, label: '\u7B2C 1 \u9875', text: 'alpha' })
check('same content -> no notification', notifications === 0)
publishReadingContext({ relPath: 'books/a.pdf', kind: 'pdf', page: 2, label: '\u7B2C 2 \u9875', text: 'alpha' })
check('different page -> one notification', notifications === 1, String(notifications))
publishReadingContext({ relPath: 'books/a.pdf', kind: 'pdf', page: 2, label: '\u7B2C 2 \u9875', text: 'beta' })
check('different text -> one notification', notifications === 2, String(notifications))
publishReadingContext({ relPath: 'books/a.pdf', kind: 'pdf', page: 2, label: '\u7B2C 2 \u9875', text: 'beta' })
check('repeat still deduped', notifications === 2, String(notifications))

console.log('\n=== 4. store: null clear / unsubscribe / multi-subscriber ===')
let other = 0
const offB = subscribeReadingContext(() => { other += 1 })
publishReadingContext(null)
check('null clears state', getReadingContext() === null)
check('clear notifies every subscriber', notifications === 3 && other === 1, `${notifications}/${other}`)
publishReadingContext(null)
check('clearing twice is a no-op', notifications === 3 && other === 1, `${notifications}/${other}`)
offA()
offA()
publishReadingContext({ relPath: 'x.md', kind: 'md', text: 'body' })
check('unsubscribed listener gets nothing', notifications === 3, String(notifications))
check('remaining listener still notified', other === 2, String(other))
offB()

console.log('\n=== 5. store: clearReadingContextOf only clears its own ===')
publishReadingContext({ relPath: 'books/a.pdf', kind: 'pdf', page: 5, text: 'keep me' })
clearReadingContextOf('books/b.epub')
check('other relPath does not clear', getReadingContext()?.relPath === 'books/a.pdf')
clearReadingContextOf('books/a.pdf')
check('own relPath clears', getReadingContext() === null)
publishReadingContext(null)
check('clearing empty store is safe', getReadingContext() === null)

console.log('\n=== 6. PDF publisher wiring ===')
const pdfSrc = read(PDF_REL)
check('imports store api', /from\s+'\.\.\/\.\.\/\.\.\/lib\/readingContext'/.test(pdfSrc))
check('imports clampReadingText', /\bclampReadingText\b/.test(pdfSrc))
check('reads current page textContent', /getTextContent\(\)/.test(pdfSrc))
check('publishes kind pdf', /kind:\s*'pdf'/.test(pdfSrc))
check('publishes 1-based page number', /page,\s*label:\s*`\u7B2C \$\{page\} \u9875`/.test(pdfSrc))
check('uses request sequence guard', /readingSeqRef/.test(pdfSrc) && /seq !== readingSeqRef\.current/.test(pdfSrc))
check('clamps before publish', /clampReadingText\(pdfPageText\(tc\.items\),\s*READING_CONTEXT_LIMIT\)/.test(pdfSrc))
check('empty text clears instead of faking', /if\s*\(!text\.trim\(\)\)[\s\S]{0,120}clearReadingContextOf\(relPath\)/.test(pdfSrc))
check('unmount / switch clears own context', /useEffect\(\(\) => \(\) => \{ clearReadingContextOf\(relPath\) \}, \[relPath\]\)/.test(pdfSrc))
check('invalidates in-flight request on cleanup', /readingSeqRef\.current \+= 1/.test(pdfSrc))

console.log('\n=== 7. EPUB publisher wiring ===')
const epubSrc = read(EPUB_REL)
check('imports store api', /from\s+'\.\.\/\.\.\/\.\.\/lib\/readingContext'/.test(epubSrc))
check('imports clampReadingText', /\bclampReadingText\b/.test(epubSrc))
check('reads rendered section via renderer.getContents', /renderer\?\.getContents\?\.\(\)/.test(epubSrc))
check('publishes kind epub', /kind:\s*'epub'/.test(epubSrc))
check('publishes section label', /\.\.\.\(label \? \{ label \} : \{\}\)/.test(epubSrc))
check('schedules from relocate', /scheduleReadingContext\(cur, label\)/.test(epubSrc))
check('uses request sequence guard', /readingSeqRef/.test(epubSrc) && /seq !== readingSeqRef\.current/.test(epubSrc))
check('chapter-level dedupe key', /readingKeyRef/.test(epubSrc))
check('clamps before publish', /clampReadingText\(raw,\s*READING_CONTEXT_LIMIT\)/.test(epubSrc))
check('empty text clears instead of faking', /if\s*\(!text\.trim\(\)\)[\s\S]{0,120}clearReadingContextOf\(relPath\)/.test(epubSrc))
check('unmount / switch clears own context', /useEffect\(\(\) => \(\) => \{ clearReadingContextOf\(relPath\) \}, \[relPath\]\)/.test(epubSrc))
check('fixed-layout (image) book skips publishing', /if \(isFixedLayoutBook\) return/.test(epubSrc))

/* ---------------------------------------------------------------- report */
let failed = 0
for (const c of checks) {
  if (!c.pass) failed += 1
  const line = `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`
  console.log(ascii(line))
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
if (failed > 0) {
  console.log(`FAIL: ${failed} check(s) did not pass`)
  process.exit(1)
}
console.log(`\nPASS -- ${checks.length - failed}/${checks.length} assertions passed`)
