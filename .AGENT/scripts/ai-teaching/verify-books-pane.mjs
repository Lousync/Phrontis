#!/usr/bin/env node
/**
 * 契约验证：AI 教学右侧查看器「书架页签」（`src/modules/ai-teaching/right-viewer/`）
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/ai-teaching-right-viewer-plan.md` §6.3
 *       + 内核文档 D2（全格式）/ D3（不设固定工具条）/ D5（切页签只隐藏不卸载）
 *         / D7（复用阅读能力、状态按 rootId+relPath 共享）/ D8（入口决定右侧或全屏）
 *
 * 断言面：
 *   1. 纯函数层 `booksPanePure.ts`（strip 类型后直接 import 真实实现）：
 *      引擎推导 / 进度换算 / 进度文案 / 过滤 / 排序 / 列数 / 格式徽标；
 *   2. 静态：三款阅读器在 `BooksPane.tsx` 里一律 `lazy(` 装载（铁律 20）、
 *      走 `useDataChanged` 重读清单、PDF 用 `chrome="reader-only"`、
 *      契约 props 来自 `./paneContracts`、源码无 `alert(` / `confirm(`。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-books-pane.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
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
const near = (a, b) => Math.abs(a - b) < 1e-9

const PURE_REL = 'src/modules/ai-teaching/right-viewer/booksPanePure.ts'
const PANE_REL = 'src/modules/ai-teaching/right-viewer/BooksPane.tsx'

/* ------------------------------------------------ 1. 纯函数（真实实现） */
const pureSrc = fs.readFileSync(path.join(ROOT, PURE_REL), 'utf8')

// 纯函数层必须零运行时依赖（只允许 `import type`）——否则 strip 后 import 会失败
check('booksPanePure has no runtime imports', !/^\s*import\s+(?!type\b)/m.test(pureSrc))

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-pane-'))
const tmpFile = path.join(tmpDir, 'booksPanePure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const {
  engineOfPath,
  progressOf,
  progressLabel,
  filterBooks,
  sortBooks,
  columnsForWidth,
  formatBadge,
} = await import(pathToFileURL(tmpFile).href)

/* engineOfPath: 6 cases */
check('engineOfPath: nested pdf path -> pdf', engineOfPath('docs/books/guide.pdf') === 'pdf')
check('engineOfPath: uppercase .PDF -> pdf', engineOfPath('BOOK.PDF') === 'pdf')
check('engineOfPath: .epub -> epub', engineOfPath('a/b.epub') === 'epub')
check('engineOfPath: .fb2 -> fb2', engineOfPath('story.fb2') === 'fb2')
check('engineOfPath: .fbz -> fbz and .cbz -> cbz', engineOfPath('s.fbz') === 'fbz' && engineOfPath('c.CBZ') === 'cbz')
check('engineOfPath: .TXT -> txt', engineOfPath('notes/readme.TXT') === 'txt')
check('engineOfPath: unknown extension -> null', engineOfPath('report.docx') === null)
check('engineOfPath: no extension -> null', engineOfPath('README') === null)

/* progressOf: 4 cases (+ clamp edges) */
check('progressOf: pages -> ratio', near(progressOf({ lastPage: 42, totalPages: 380 }), 42 / 380))
check('progressOf: pct -> ratio', near(progressOf({ pct: 12 }), 0.12))
check('progressOf: missing fields -> 0', progressOf({}) === 0 && progressOf({ lastPage: 3, totalPages: 0 }) === 0)
check('progressOf: over range clamps to 1', progressOf({ lastPage: 500, totalPages: 100 }) === 1)
check('progressOf: negative pct clamps to 0', progressOf({ pct: -20 }) === 0)
check('progressOf: non-finite pct -> 0', progressOf({ pct: Number.NaN }) === 0)

/* progressLabel: 3 cases (+ empties) */
check('progressLabel: pages -> "42 / 380"', progressLabel({ lastPage: 42, totalPages: 380 }) === '42 / 380')
check('progressLabel: pct -> "12%"', progressLabel({ pct: 12 }) === '12%')
check('progressLabel: missing -> empty string', progressLabel({}) === '' && progressLabel({ pct: 0 }) === '')
check('progressLabel: page clamped into 1..total', progressLabel({ lastPage: 999, totalPages: 100 }) === '100 / 100')

/* filterBooks */
const shelf = [
  { displayName: 'Deep Work', relPath: 'a.pdf' },
  { displayName: '读者', relPath: 'b.epub' },
  { displayName: 'deep learning', relPath: 'c.txt' },
]
const shelfSnap = JSON.parse(JSON.stringify(shelf))
check('filterBooks: case-insensitive match', same(filterBooks(shelf, 'DEEP').map((b) => b.relPath), ['a.pdf', 'c.txt']))
check('filterBooks: empty query keeps order', same(filterBooks(shelf, '   '), shelf))
check('filterBooks: empty query returns same array', filterBooks(shelf, '') === shelf)
check('filterBooks: no match -> empty list', filterBooks(shelf, 'zzz').length === 0)
check('filterBooks: does not mutate input', same(shelf, shelfSnap))

/* sortBooks */
const rows = [
  { id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'new', updatedAt: '2026-11-19T10:00:00.000Z' },
  { id: 'none' },
  { id: 'bad', updatedAt: 'not-a-date' },
  { id: 'mid', updatedAt: '2026-06-01T00:00:00.000Z' },
]
const rowsSnap = JSON.parse(JSON.stringify(rows))
check('sortBooks: newest first', same(sortBooks(rows).map((b) => b.id), ['new', 'mid', 'old', 'none', 'bad']))
check('sortBooks: missing updatedAt goes last', sortBooks(rows).slice(-1)[0].id === 'bad')
check('sortBooks: does not mutate input', same(rows, rowsSnap))
const ties = [
  { id: 'first', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'second', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'third', updatedAt: '2026-01-01T00:00:00.000Z' },
]
check('sortBooks: stable for equal timestamps', same(sortBooks(ties).map((b) => b.id), ['first', 'second', 'third']))

/* columnsForWidth */
check('columnsForWidth: 419 -> 1', columnsForWidth(419) === 1)
check('columnsForWidth: 420 -> 2', columnsForWidth(420) === 2)
check('columnsForWidth: 360 (min panel) -> 1', columnsForWidth(360) === 1)
check('columnsForWidth: 960 (max panel) -> 2', columnsForWidth(960) === 2)

/* formatBadge */
check('formatBadge: pdf -> PDF', formatBadge('pdf') === 'PDF')
check('formatBadge: cbz -> CBZ', formatBadge('cbz') === 'CBZ')
check('formatBadge: null -> empty', formatBadge(null) === '')

/* ------------------------------------------------ 2. 静态契约（BooksPane.tsx） */
const pane = fs.readFileSync(path.join(ROOT, PANE_REL), 'utf8')

check('BooksPane: PdfReaderView is lazy()', /const\s+PdfReaderView\s*=\s*lazy\(/.test(pane))
check('BooksPane: TxtReaderView is lazy()', /const\s+TxtReaderView\s*=\s*lazy\(/.test(pane))
check('BooksPane: EpubReaderView is lazy()', /const\s+EpubReaderView\s*=\s*lazy\(/.test(pane))
check('BooksPane: PdfReaderView has no static import', !/import\s+[^'"]*PdfReaderView/.test(pane))
check('BooksPane: wires useDataChanged', /useDataChanged\(/.test(pane))
check('BooksPane: watches pdfReader scope', /useDataChanged\('pdfReader'/.test(pane))
check('BooksPane: watches readerState scope', /useDataChanged\('readerState'/.test(pane))
check('BooksPane: watches knowledge scope', /useDataChanged\('knowledge'/.test(pane))
check('BooksPane: PDF reader uses chrome="reader-only"', /chrome="reader-only"/.test(pane))
check('BooksPane: props come from ./paneContracts', /import type \{[^}]*BooksPaneProps[^}]*\} from '\.\/paneContracts'/.test(pane))
check('BooksPane: dispatches by bookEngineOf', /bookEngineOf\(/.test(pane))
check('BooksPane: no alert()', !/\balert\(/.test(pane))
check('BooksPane: no confirm()', !/\bconfirm\(/.test(pane))
check('BooksPane: no fixed reader toolbar wrapper (D3)', !/rfloat|reader-toolbar/.test(pane))
check('BooksPane: long list uses .kb-cv classes on items', /kb-cv-sm|kb-cv\b/.test(pane))

/* ---------------------------------------------------------------- 报告 */
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${!c.pass && c.detail ? '  -> ' + ascii(c.detail) : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* temp dir cleanup is best-effort */
}
process.exit(failed.length === 0 ? 0 : 1)
