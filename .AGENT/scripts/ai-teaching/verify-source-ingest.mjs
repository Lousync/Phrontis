#!/usr/bin/env node
/**
 * Contract check: AI-teaching material ingest pure functions
 *   implementation: electron/lib/sourceIngestPure.ts
 *   plan: /home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md  sections 2.2 / 2.3 / 4.1 / 9
 *
 * Policy notes encoded here (read before changing the implementation):
 *   - nextIngestStatus REJECTS illegal transitions by returning `prev` unchanged
 *     (never throws). `ready -> parsing` is illegal on purpose: a parsed source must
 *     be queued explicitly before it is re-parsed. `partial` is sticky: `done` keeps
 *     `partial` so pending OCR pages are not forgotten.
 *   - cacheKeyFor / engineSignature throw on empty segments; every other helper is
 *     total (bad input -> usable value, never throw).
 *   - sliceContent only interprets `page` anchors; chapter/heading/char/sheet anchors
 *     must be resolved upstream into an offset. `nextOffset` is always relative to
 *     the slice origin and equals `offset + returned length`.
 *
 * Run from repo root: node .AGENT/scripts/ai-teaching/verify-source-ingest.mjs [repoPath]
 * Output is pure ASCII. All checks must PASS and exit code must be 0.
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

const REL = 'electron/lib/sourceIngestPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ingest-'))
const tmpFile = path.join(tmpDir, 'sourceIngestPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const mod = await import(pathToFileURL(tmpFile).href)
const {
  cacheKeyFor,
  cacheRootFor,
  nextIngestStatus,
  classifyTextLayer,
  splitPageMarkers,
  sliceContent,
  normalizeStructure,
  engineSignature,
  DEFAULT_SLICE_MAX_CHARS,
  MAX_SLICE_MAX_CHARS,
} = mod

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const throws = (fn) => {
  try { fn(); return false } catch { return true }
}

console.log('\n=== 0. module surface (contract exported, zero runtime import) ===')
const API = [
  'cacheKeyFor', 'cacheRootFor', 'nextIngestStatus', 'classifyTextLayer',
  'splitPageMarkers', 'sliceContent', 'normalizeStructure', 'engineSignature',
]
check('all 8 API functions exported', API.every((k) => typeof mod[k] === 'function'), API.filter((k) => typeof mod[k] !== 'function').join(','))
check('no runtime import left in source (only `import type`)', !/^import\s+(?!type\b)/m.test(src), '')
check('no require() in source', !/\brequire\s*\(/.test(src), '')
check('no node builtin / electron import', !/from\s+'node:/.test(src) && !/from\s+'electron'/.test(src), '')

console.log('\n=== 1. cacheKeyFor: <contentHash>/<engineSig>, no traversal ===')
const key1 = cacheKeyFor('abc123', 'v1')
check('plain input -> hash/sig', key1 === 'abc123/v1', key1)
check('exactly one separator', key1.split('/').length === 2, key1)
const TRAVERSALS = ['../../etc/passwd', 'a/b', 'C:\\x', '..', '/', '\\\\server\\share', 'x/../../y', 'a:b']
let traversalOk = true
let traversalBad = ''
for (const bad of TRAVERSALS) {
  const out = cacheKeyFor(bad, 'e@1')
  const segs = out.split('/')
  const ok = segs.length === 2
    && segs.every((s) => s.length > 0)
    && !out.includes('..')
    && !out.includes('\\')
    && !out.includes(':')
    && !segs.some((s) => s === '.' || s === '..')
    && !out.startsWith('/')
  if (!ok) { traversalOk = false; traversalBad = `${bad} -> ${out}` }
}
check('traversal / separator inputs never escape', traversalOk, traversalBad)
check('a/b and a:b do not collide (escape, not replace)', cacheKeyFor('a/b', 'v') !== cacheKeyFor('a:b', 'v'), '')
check('backslash / slash inputs stay inside one segment each', (() => {
  const a = cacheKeyFor('C:\\x', 'v').split('/')
  const b = cacheKeyFor('C:/x', 'v').split('/')
  return a.length === 2 && b.length === 2 && !a[0].includes('\\') && !b[0].includes('\\') && !a[0].includes(':') && !b[0].includes(':')
})(), '')
check('a/b differs from ab (no silent merge)', cacheKeyFor('a/b', 'v') !== cacheKeyFor('ab', 'v'), '')
check('deterministic / idempotent', cacheKeyFor('h', 's') === cacheKeyFor('h', 's'), '')
check('empty contentHash throws', throws(() => cacheKeyFor('', 'v')), '')
check('blank engineSig throws', throws(() => cacheKeyFor('h', '   ')), '')
check('undefined coerced and rejected', throws(() => cacheKeyFor(undefined, undefined)), '')
check('Windows reserved name is prefixed', cacheKeyFor('CON', 'v').startsWith('_CON/'), cacheKeyFor('CON', 'v'))
const UNI = 'caf\u00e9'
check('unicode letters survive in key segment', cacheKeyFor(UNI, 'v') === UNI + '/v', '')
check('segment length capped', cacheKeyFor('x'.repeat(500), 'v').split('/')[0].length <= 160, '')

console.log('\n=== 2. cacheRootFor: setting wins, else <course>/.cache ===')
check('null configured -> course/.cache (forward slashes)', cacheRootFor(null, 'C:\\vault\\AI') === 'C:/vault/AI/.cache', cacheRootFor(null, 'C:\\vault\\AI'))
check('undefined configured -> course/.cache', cacheRootFor(undefined, '/vault/AI') === '/vault/AI/.cache', cacheRootFor(undefined, '/vault/AI'))
check('blank configured -> course/.cache', cacheRootFor('   ', '/vault/AI') === '/vault/AI/.cache', '')
check('configured wins after trim + slash normalization', cacheRootFor('  D:\\pc\\ ', '/vault/AI') === 'D:/pc', cacheRootFor('  D:\\pc\\ ', '/vault/AI'))
check('configured trailing slash removed', cacheRootFor('/tmp/cache/', '/vault') === '/tmp/cache', cacheRootFor('/tmp/cache/', '/vault'))
check('course trailing slash does not double', cacheRootFor('', 'C:\\vault\\') === 'C:/vault/.cache', cacheRootFor('', 'C:\\vault\\'))
check('root configured kept as root', cacheRootFor('/', '/vault') === '/', cacheRootFor('/', '/vault'))
check('both blank throws', throws(() => cacheRootFor('', '')), '')
check('course drive root no double slash', !cacheRootFor('', 'C:\\').includes('//'), cacheRootFor('', 'C:\\'))

console.log('\n=== 3. nextIngestStatus: legal path + reject (return prev) ===')
check('indexed + queue -> queued', nextIngestStatus('indexed', 'queue') === 'queued', '')
check('queued + start -> parsing', nextIngestStatus('queued', 'start') === 'parsing', '')
check('parsing + chunk -> parsing', nextIngestStatus('parsing', 'chunk') === 'parsing', '')
check('parsing + done -> ready', nextIngestStatus('parsing', 'done') === 'ready', '')
check('NEG: ready + start stays ready (illegal)', nextIngestStatus('ready', 'start') === 'ready', nextIngestStatus('ready', 'start'))
check('NEG: ready + chunk stays ready', nextIngestStatus('ready', 'chunk') === 'ready', '')
check('NEG: parsing + queue stays parsing', nextIngestStatus('parsing', 'queue') === 'parsing', '')
check('NEG: indexed + done stays indexed', nextIngestStatus('indexed', 'done') === 'indexed', '')
check('NEG: indexed + ocr stays indexed', nextIngestStatus('indexed', 'ocr') === 'indexed', '')
check('parsing + ocr -> partial', nextIngestStatus('parsing', 'ocr') === 'partial', '')
check('partial + done keeps partial (sticky)', nextIngestStatus('partial', 'done') === 'partial', '')
check('partial + start -> parsing (reset path)', nextIngestStatus('partial', 'start') === 'parsing', '')
check('parsing + done after reset -> ready', nextIngestStatus(nextIngestStatus('partial', 'start'), 'done') === 'ready', '')
check('parsing + fail -> failed', nextIngestStatus('parsing', 'fail') === 'failed', '')
check('failed + start -> parsing (retry)', nextIngestStatus('failed', 'start') === 'parsing', '')
check('ready + stale -> stale', nextIngestStatus('ready', 'stale') === 'stale', '')
check('stale + start -> parsing', nextIngestStatus('stale', 'start') === 'parsing', '')
check('NEG: stale + done stays stale', nextIngestStatus('stale', 'done') === 'stale', '')
check('index resets anything (ready -> indexed)', nextIngestStatus('ready', 'index') === 'indexed', '')
check('unknown event returns prev', nextIngestStatus('ready', 'bogus') === 'ready', '')
check('unknown prev normalized to indexed', nextIngestStatus('weird', 'queue') === 'queued', nextIngestStatus('weird', 'queue'))
const walk = ['indexed', 'queue', 'start', 'chunk', 'chunk', 'done'].reduce((s, e) => nextIngestStatus(s, e), 'indexed')
check('full happy path ends ready', walk === 'ready', walk)

console.log('\n=== 4. classifyTextLayer: text / partial / empty ===')
check('no empty page -> text', classifyTextLayer({ pages: 10, emptyPages: [], chars: 1000 }) === 'text', '')
check('one empty page -> partial', classifyTextLayer({ pages: 10, emptyPages: [3], chars: 900 }) === 'partial', '')
check('all pages empty -> empty', classifyTextLayer({ pages: 2, emptyPages: [1, 2], chars: 10 }) === 'empty', '')
check('duplicate empty page counted once', classifyTextLayer({ pages: 5, emptyPages: [1, 1, 1], chars: 10 }) === 'partial', '')
check('zero chars -> empty even with pages', classifyTextLayer({ pages: 3, emptyPages: [], chars: 0 }) === 'empty', '')
check('negative chars -> empty', classifyTextLayer({ pages: 3, emptyPages: [], chars: -5 }) === 'empty', '')
check('NaN chars -> empty', classifyTextLayer({ pages: 3, emptyPages: [], chars: Number.NaN }) === 'empty', '')
check('pages 0 with chars -> text', classifyTextLayer({ pages: 0, emptyPages: [], chars: 100 }) === 'text', '')
check('pages 0 with 0 chars -> empty', classifyTextLayer({ pages: 0, emptyPages: [], chars: 0 }) === 'empty', '')
check('out-of-range empty page ignored', classifyTextLayer({ pages: 3, emptyPages: [99], chars: 10 }) === 'text', '')
check('input array not mutated', (() => { const a = [3, 1, 1]; classifyTextLayer({ pages: 5, emptyPages: a, chars: 10 }); return eq(a, [3, 1, 1]) })(), '')

console.log('\n=== 5. splitPageMarkers: CRLF / duplicate / missing tail ===')
const PAGE_DOC = '<!-- page 1 -->\nALPHA\n<!-- page 2 -->\nBETA\n<!-- page 3 -->\nGAMMA\n'
const markers = splitPageMarkers(PAGE_DOC)
check('3 markers found', markers.length === 3, JSON.stringify(markers))
check('page numbers in document order', eq(markers.map((m) => m.n), [1, 2, 3]), JSON.stringify(markers.map((m) => m.n)))
check('page 1 slice excludes marker text', PAGE_DOC.slice(markers[0].startChar, markers[0].endChar).trim() === 'ALPHA', '')
check('page 3 slice runs to end of content', PAGE_DOC.slice(markers[2].startChar, markers[2].endChar).trim() === 'GAMMA', '')
check('ranges are ordered and non-overlapping', markers[0].endChar <= markers[1].startChar && markers[1].endChar <= markers[2].startChar, '')
check('no marker leaked into any slice', !markers.some((m) => PAGE_DOC.slice(m.startChar, m.endChar).includes('<!--')), '')
const crlf = PAGE_DOC.replace(/\n/g, '\r\n')
const crlfMarkers = splitPageMarkers(crlf)
check('CRLF: same marker count and numbers', crlfMarkers.length === 3 && eq(crlfMarkers.map((m) => m.n), [1, 2, 3]), '')
check('CRLF: slices still extract body', crlf.slice(crlfMarkers[1].startChar, crlfMarkers[1].endChar).trim() === 'BETA', '')
check('no markers -> empty array', eq(splitPageMarkers('plain text'), []), '')
check('missing end marker -> last range to EOF', (() => { const c = 'x<!-- page 1 -->\nTAIL'; const r = splitPageMarkers(c); return r.length === 1 && r[0].endChar === c.length })(), '')
check('marker with empty body -> zero-length range', (() => { const c = 'abc<!-- page 1 -->'; const r = splitPageMarkers(c); return r.length === 1 && r[0].startChar === r[0].endChar })(), '')
const dupDoc = '<!-- page 1 -->\nA\n<!-- page 1 -->\nB\n<!-- page 2 -->\nC\n'
const dupMarkers = splitPageMarkers(dupDoc)
check('duplicate page number -> single region', dupMarkers.length === 2 && eq(dupMarkers.map((m) => m.n), [1, 2]), JSON.stringify(dupMarkers))
check('duplicate region keeps both bodies (no text loss)', (() => { const s = dupDoc.slice(dupMarkers[0].startChar, dupMarkers[0].endChar); return s.includes('A') && s.includes('B') })(), '')
check('page 0 ignored', eq(splitPageMarkers('<!-- page 0 -->x<!-- page 2 -->y').map((m) => m.n), [2]), '')
check('uppercase PAGE accepted', eq(splitPageMarkers('<!-- PAGE 5 -->z').map((m) => m.n), [5]), '')
check('non-string input -> empty array, no throw', eq(splitPageMarkers(null), []), '')

console.log('\n=== 6. sliceContent: offset / maxChars / hasMore / page anchor ===')
const LONG = 'x'.repeat(50_000)
check('default maxChars constant = 12000', DEFAULT_SLICE_MAX_CHARS === 12_000, String(DEFAULT_SLICE_MAX_CHARS))
const d0 = sliceContent(LONG, {})
check('default slice length 12000', d0.content.length === 12_000, String(d0.content.length))
check('hasMore true on first page', d0.hasMore === true, '')
check('nextOffset = 12000', d0.nextOffset === 12_000, String(d0.nextOffset))
check('totalChars = whole document', d0.totalChars === 50_000, String(d0.totalChars))
const r1 = sliceContent(LONG, { offset: 0, maxChars: 1000 })
const r2 = sliceContent(LONG, { offset: r1.nextOffset, maxChars: 1000 })
check('sequential reads concatenate', r1.content + r2.content === LONG.slice(0, 2000), '')
check('offset past end -> empty, no throw', (() => { const r = sliceContent(LONG, { offset: 999_999 }); return r.content === '' && r.hasMore === false && r.totalChars === 50_000 })(), '')
check('offset past end -> nextOffset clamped to end', sliceContent(LONG, { offset: 999_999 }).nextOffset === 50_000, '')
check('negative offset treated as 0', (() => { const r = sliceContent(LONG, { offset: -5 }); return r.content.length === 12_000 && r.nextOffset === 12_000 })(), '')
check('maxChars 0 -> default', sliceContent(LONG, { maxChars: 0 }).content.length === 12_000, '')
check('maxChars NaN -> default', sliceContent(LONG, { maxChars: Number.NaN }).content.length === 12_000, '')
check('maxChars huge -> clamped to MAX_SLICE_MAX_CHARS', MAX_SLICE_MAX_CHARS === 400_000 && sliceContent(LONG, { maxChars: 9_999_999 }).content.length === 50_000, '')
check('exact tail read -> hasMore false', (() => { const r = sliceContent(LONG, { offset: 49_990, maxChars: 100 }); return r.content.length === 10 && r.hasMore === false && r.nextOffset === 50_000 })(), '')
const p22 = sliceContent(PAGE_DOC, { anchor: { kind: 'page', from: 2, to: 2 } })
check('page anchor 2..2 -> only page 2 body', p22.content.trim() === 'BETA', JSON.stringify(p22.content))
check('page anchor totalChars stays whole document', p22.totalChars === PAGE_DOC.length, String(p22.totalChars))
check('page anchor single page -> hasMore false', p22.hasMore === false, '')
const p23 = sliceContent(PAGE_DOC, { anchor: { kind: 'page', from: 2, to: 3 } })
check('page anchor 2..3 -> both bodies kept', p23.content.includes('BETA') && p23.content.includes('GAMMA'), JSON.stringify(p23.content))
check('page anchor 2..3 keeps only interior separator (boundaries cut)', !p23.content.includes('<!-- page 2 -->') && !p23.content.trim().startsWith('<!--') && p23.content.includes('<!-- page 3 -->'), JSON.stringify(p23.content))
const p2open = sliceContent(PAGE_DOC, { anchor: { kind: 'page', from: 2, to: 99 } })
check('page anchor to=99 -> reads to end of document', p2open.content.trim().endsWith('GAMMA') && p2open.hasMore === false, JSON.stringify(p2open.content))
const pMissing = sliceContent(PAGE_DOC, { anchor: { kind: 'page', from: 9 } })
check('missing page -> falls back to whole document', pMissing.content === PAGE_DOC, JSON.stringify(pMissing.content.slice(0, 20)))
const pFromOnly = sliceContent(PAGE_DOC, { anchor: { kind: 'page', to: 2 } })
check('page anchor to-only resolves that page', pFromOnly.content.trim() === 'BETA', JSON.stringify(pFromOnly.content))
const pCut = sliceContent(PAGE_DOC, { anchor: { kind: 'page', from: 2, to: 2 }, maxChars: 4 })
check('page anchor honours maxChars', pCut.content.length === 4 && pCut.hasMore === true && pCut.nextOffset === 4, JSON.stringify(pCut))
const pRest = sliceContent(PAGE_DOC, { anchor: { kind: 'page', from: 2, to: 2 }, offset: pCut.nextOffset })
check('page anchor pagination rejoins the region', pCut.content + pRest.content === PAGE_DOC.slice(markers[1].startChar, markers[1].endChar), '')
check('page anchor offset past region -> empty, hasMore false', (() => { const r = sliceContent(PAGE_DOC, { anchor: { kind: 'page', from: 2 }, offset: 99_999 }); return r.content === '' && r.hasMore === false })(), '')
check('non-page anchor behaves as whole document', sliceContent(LONG, { anchor: { kind: 'chapter', label: 'c1' } }).content === LONG.slice(0, 12_000), '')
check('char anchor is not interpreted here (whole document)', sliceContent(LONG, { anchor: { kind: 'char', from: 100 } }).content === LONG.slice(0, 12_000), '')
check('empty content -> stable zeros', (() => { const r = sliceContent('', {}); return r.content === '' && r.nextOffset === 0 && r.hasMore === false && r.totalChars === 0 })(), '')

console.log('\n=== 7. normalizeStructure: tolerant, renumber, recompute ranges ===')
check('null -> empty structure', eq(normalizeStructure(null), { v: 1, pages: [], assets: [] }), '')
check('plain object -> empty structure', eq(normalizeStructure({}), { v: 1, pages: [], assets: [] }), '')
check('v forced to 1', normalizeStructure({ v: 7 }).v === 1, '')
check('pages not an array -> empty', eq(normalizeStructure({ pages: 'nope' }).pages, []), '')
check('null / number / array pages dropped', normalizeStructure({ pages: [null, 42, [], { blocks: 'x' }] }).pages.length === 1, JSON.stringify(normalizeStructure({ pages: [null, 42, [], { blocks: 'x' }] }).pages))
const ns = normalizeStructure({
  pages: [
    {
      n: 5,
      startChar: 100,
      endChar: 200,
      blocks: [
        { t: 'h', text: 'Title' },
        { t: 'heading', text: 'drop-me' },
        { t: 'P', text: 3 },
        { t: 'img', assetId: ' a1 ' },
        null,
        'x',
        { t: 'p', text: null, page: '2' },
      ],
    },
  ],
})
check('bad blocks dropped, good blocks kept', ns.pages[0].blocks.length === 4, JSON.stringify(ns.pages[0].blocks))
check('block type lowercased', ns.pages[0].blocks.some((b) => b.t === 'p'), '')
check('numeric block text stringified', ns.pages[0].blocks.some((b) => b.text === '3'), '')
check('block page coerced from string', ns.pages[0].blocks.some((b) => b.page === 2), '')
check('assetId trimmed', ns.pages[0].blocks.some((b) => b.assetId === 'a1'), '')
check('page n renumbered from 1', ns.pages[0].n === 1, String(ns.pages[0].n))
const renum = normalizeStructure({ pages: [{ n: 5 }, { n: 9 }, { n: 1 }] })
check('all page numbers renumbered 1..N', eq(renum.pages.map((p) => p.n), [1, 2, 3]), JSON.stringify(renum.pages.map((p) => p.n)))
const ranges = normalizeStructure({ pages: [{ startChar: 100, endChar: 200 }, { startChar: 10, endChar: 20 }, { startChar: 200, endChar: 200 }] })
check('overlapping range recomputed to zero length', ranges.pages[1].startChar === 200 && ranges.pages[1].endChar === 200, JSON.stringify(ranges.pages[1]))
check('ranges stay monotonic', ranges.pages.every((p, i) => i === 0 || p.startChar >= ranges.pages[i - 1].endChar), JSON.stringify(ranges.pages))
const badRange = normalizeStructure({ pages: [{ startChar: -5, endChar: 10 }, { startChar: 20, endChar: 10 }] })
check('negative / inverted ranges clamped, no throw', badRange.pages[0].startChar === 0 && badRange.pages[0].endChar === 0 && badRange.pages[1].startChar === 0, JSON.stringify(badRange.pages))
const assets = normalizeStructure({ assets: [{ id: 'a', path: 'assets\\x.png' }, { id: 'a', path: 'dup.png' }, { id: '', path: 'p.png' }, { id: 'b' }, null] })
check('asset id dedupe keeps first', assets.assets.length === 1, JSON.stringify(assets.assets))
check('asset path normalized to forward slashes', assets.assets[0].path === 'assets/x.png', assets.assets[0].path)
check('deep junk does not throw', (() => { const r = normalizeStructure({ pages: [[], {}, { blocks: [{ t: 'p' }] }] }); return r.pages.length === 2 })(), '')

console.log('\n=== 8. engineSignature: stable, order independent ===')
const sigA = engineSignature({ id: 'pdf', version: '1.2', params: { dpi: 150, ocr: true } })
const sigB = engineSignature({ id: 'pdf', version: '1.2', params: { ocr: true, dpi: 150 } })
check('param insertion order does not matter', sigA === sigB, `${sigA} vs ${sigB}`)
check('format is id@version|k=v&k=v sorted', sigA === 'pdf@1.2|dpi=150&ocr=true', sigA)
check('no params -> bare id@version', engineSignature({ id: 'pdf', version: '1' }) === 'pdf@1', engineSignature({ id: 'pdf', version: '1' }))
check('empty params object -> bare id@version', engineSignature({ id: 'pdf', version: '1', params: {} }) === 'pdf@1', '')
check('idempotent', engineSignature({ id: 'a', version: '2', params: { x: 'y' } }) === engineSignature({ id: 'a', version: '2', params: { x: 'y' } }), '')
check('value with separators is escaped (no ambiguity)', (() => {
  const squashed = engineSignature({ id: 'e', version: '1', params: { a: '1&b=2' } })
  const split = engineSignature({ id: 'e', version: '1', params: { a: '1', b: '2' } })
  return squashed !== split && squashed.includes('%26') && squashed.includes('%3D')
})(), '')
check('NaN param skipped', engineSignature({ id: 'e', version: '1', params: { x: Number.NaN } }) === 'e@1', '')
check('non-primitive param skipped', engineSignature({ id: 'e', version: '1', params: { x: {} } }) === 'e@1', '')
check('boolean / number coerced stably', engineSignature({ id: 'e', version: '1', params: { n: 0, b: false } }) === 'e@1|b=false&n=0', engineSignature({ id: 'e', version: '1', params: { n: 0, b: false } }))
check('blank id throws', throws(() => engineSignature({ id: ' ', version: '1' })), '')
check('blank version throws', throws(() => engineSignature({ id: 'e', version: '' })), '')
const crossCheck = cacheKeyFor('deadbeef', engineSignature({ id: 'pdf', version: '1.2', params: { ocr: true } }))
check('engineSignature feeds cacheKeyFor without separators', crossCheck.split('/').length === 2 && !crossCheck.includes('..'), crossCheck)

// ---------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} - ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup failure does not change the verdict */ }
process.exit(failed.length === 0 ? 0 : 1)
