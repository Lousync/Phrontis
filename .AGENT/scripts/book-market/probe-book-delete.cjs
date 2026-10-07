/**
 * 删书链路运行期探针 —— 在真实 electron 主进程里跑**真实实现**（`lib/bookDelete.deleteBookEverywhere`），
 * 只认磁盘字节。判据形态见记忆 `probe-form-main-vs-cdp`：纯主进程功能不上 CDP。
 *
 * ## 为什么必须有它
 * `verify-book-delete.mjs` 只能验**静态接线**（七个 step 在场、顺序对、广播齐）。但「七步真的把五处 JSON
 * 里的键清干净了吗」「书文件真的进了回收站吗」「导出的『读书笔记』页面真的留着吗」—— 这三条只有真跑才算数。
 * 尤其第三条：**清多了**（顺手把笔记页也删了）在静态断言下完全看不出来，而那是用户数据的永久损失。
 *
 * ## 判定面
 *   ① 五处 store 删前都**确实有**该书的键（前置断言 —— 没 seed 上就等于什么都没验）
 *   ② 删后五处键全无 + `.books/` 里书文件没了 + `.books/.covers` 封面文件没了 + pdfReader 缓存 png 没了
 *   ③ ★ **导出出的「读书笔记」页仍在磁盘上**（只断了映射）
 *   ④ 幂等/健壮：书文件已被外部删掉时再调一次 → 不抛异常，其余五处仍清干净（如实记一条 errors）
 *
 * ## 跑法（两步；Electron 33 = Node 20，不能 strip-types，所以先把真实实现打包）
 *   node_modules/.bin/esbuild tmp/book-delete-probe-entry.ts --bundle --platform=node \
 *     --format=cjs --external:electron --external:trash --outfile=tmp/book-delete-repo.cjs
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe .AGENT/scripts/book-market/probe-book-delete.cjs --no-sandbox --disable-gpu
 * ★ `--external:trash` 不能省：trash 是 ESM 且用 `import.meta.url` 定位自身，
 *   被 esbuild 打进 CJS 后 `import.meta.url` 变 undefined → 运行期报 "Invalid URL"（不是删书逻辑的问题）。
 * ★ 打包入口 `tmp/book-delete-probe-entry.ts` 在 tmp/（**不进版本控制**）—— 丢了按它 export 的面重建。
 *
 * ## 声明
 * ★ **不碰用户的开发数据目录**：userData 在 app ready **之前**改到系统临时目录，仓库用临时目录里的假 vault。
 *   临时目录**不删**（便于人工复核），路径打在输出里。
 * ★ **仓库必须先按真实形态登记**（`data/vaults.json` + `settings.json` → `registerWorkspaceHandlers()`）：
 *   「移入回收站」这步走 workspaceManager 的路径守卫，未登记的 rootId 一律「未授权的工作区」。
 *   漏了这步不是产品 bug，是探针夹具不完整 —— 别把这条失败当成链路坏了。
 *
 * 产物：stdout 逐条断言 + tmp/book-market-delete-probe.json（留档）
 */
const { app } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const BASE = mkdtempSync(join(tmpdir(), 'kb-probe-del-'))
const USER_DATA = join(BASE, 'userData')
const VAULT = join(BASE, 'vault')
// ★ 必须在 app ready 之前改：晚了 settings.json 已按真实 userData 算好路径（会写进开发数据目录）
app.setPath('userData', USER_DATA)

const ROOT = 'probe-vault'
const BOOKS = join(VAULT, '.books')
const KB = join(VAULT, '.knowbase')
const REL = '.books/probe-book.pdf'
const BOOK_ABS = join(VAULT, REL)
const BOOK_COVER_REL = '.books/.covers/probecover.jpg'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const results = []
let pass = true
function check(name, ok, extra = '') {
  if (!ok) pass = false
  results.push({ name, ok: !!ok, extra: String(extra) })
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
}

app.whenReady().then(async () => {
  mkdirSync(join(KB, 'modules'), { recursive: true })
  writeFileSync(join(KB, 'meta.json'), JSON.stringify({ schemaVersion: 1, name: 'probe' }), 'utf-8')
  mkdirSync(BOOKS, { recursive: true })
  // 书文件（内容无关，占位即可；但必须真存在，回收站那步会 existsSync 检查）
  writeFileSync(BOOK_ABS, Buffer.alloc(2048, 0x25), 'binary')

  // ★ 仓库登记：真实启动时由 workspaceManager.loadVaults() 从这两份全局文件恢复 roots。
  //   少了这步，「移入回收站」那步的路径守卫（requireRoot）会报「未授权的工作区」——
  //   探针要验的是删书链路，不是路径守卫，所以必须把仓库按真实形态登记上。
  const now = new Date().toISOString()
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'data', 'vaults.json'),
    JSON.stringify([{ id: ROOT, name: 'probe-vault', path: VAULT, created_at: now, updated_at: now }]), 'utf-8')
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ currentVaultId: ROOT }), 'utf-8')

  const repo = require(join(process.cwd(), 'tmp', 'book-delete-repo.cjs'))
  repo.registerWorkspaceHandlers()          // → loadVaults()：登记 roots + 设当前仓库
  repo.setCurrentVault({ rootId: ROOT, name: 'probe-vault', rootPath: VAULT })  // 兜底：登记失败也不静默
  if (!existsSync(BOOK_ABS)) throw new Error('seed 前置：书文件不在，后面全是空验')

  console.log(`\n临时仓库：${VAULT}\n`)

  // ===== seed =====
  console.log('--- seed（五处 store 各写入该书一条记录）---')
  const coverAbs = repo.bookCoverAbsPath(BOOK_COVER_REL)
  repo.ensureBookCoversDir()
  writeFileSync(coverAbs, Buffer.alloc(64, 0x11), 'binary')
  const mUpsert = repo.bookMetaUpsert(REL, { coverRel: BOOK_COVER_REL }, '探针样书')
  const rPatch = repo.readerStatePatchBook(ROOT, REL, { pct: 42 })
  const pPatch = repo.pdfReaderPatchBook(ROOT, REL, {
    lastPage: 7, totalPages: 100, bookmarks: [{ page: 3, note: '', at: new Date().toISOString() }],
  })
  const mtimeMs = statSync(BOOK_ABS).mtimeMs
  const cSave = repo.pdfReaderCoverSave(ROOT, REL, PNG, mtimeMs)
  const eCreate = repo.excerptCreate(ROOT, REL, { kind: 'pdf', page: 3, text: '探针摘录' })
  const eExport = repo.excerptExportToNote(ROOT, REL)

  // ① 前置：seed 全成功（没 seed 上 = 后面的「删干净了」是空验）
  check('seed：meta 写入', mUpsert.ok === true, mUpsert.error ?? '')
  check('seed：readerState 写入（pct）', rPatch.ok === true, rPatch.error ?? '')
  check('seed：pdfReader 写入（进度 + 书签）', pPatch.ok === true, pPatch.error ?? '')
  check('seed：pdfReader 封面缓存写入', cSave.ok === true, cSave.error ?? '')
  check('seed：摘录写入', eCreate.ok === true, eCreate.error ?? '')
  check('seed：导出为「读书笔记」页（映射 + 页面）', eExport.ok === true, eExport.error ?? '')
  const notePageAbs = eExport.pagePath ? join(VAULT, eExport.pagePath) : ''
  check('seed：笔记页文件真在磁盘上', !!notePageAbs && existsSync(notePageAbs), eExport.pagePath ?? '无 pagePath')
  check('seed：pdfReader 缓存 png 真在磁盘上', !!repo.pdfReaderCoverGet(ROOT, REL))

  // ===== 删除 =====
  console.log('\n--- 删除（deleteBookEverywhere）---')
  const r = await repo.deleteBookEverywhere(ROOT, REL)
  check('返回值 ok=true（无部分失败）', r.ok === true, JSON.stringify(r.errors))

  console.log('\n--- ① 书文件：进系统回收站（`.books/` 里不再有）---')
  check('★ 书文件已从 `.books/` 消失', !existsSync(BOOK_ABS))

  console.log('\n--- ② 五处 JSON / 缓存键全清 ---')
  check('meta：该书键已无', repo.bookMetaGet(REL) === null)
  check('★ `.books/.covers` 封面文件已删', !existsSync(coverAbs))
  check('readerState：该书键已无', repo.readerStateGetBook(ROOT, REL) === null)
  check('pdfReader：该书键已无（进度 + 书签一起走）', repo.pdfReaderGetBook(ROOT, REL) === null)
  check('★ pdfReader 封面缓存 png 已删', repo.pdfReaderCoverGet(ROOT, REL) === null)
  check('摘录：该书键已无', repo.excerptList(ROOT, REL).length === 0)
  check('导出映射：该书键已无', repo.getExportEntry(ROOT, REL) === null)

  console.log('\n--- ③ ★ 负向：导出出的「读书笔记」页面必须保留 ---')
  check('★ 笔记页文件仍在磁盘上（书没了，笔记该留着）', !!notePageAbs && existsSync(notePageAbs), eExport.pagePath ?? '')
  check('★ 笔记页内容未被清空', !!notePageAbs && existsSync(notePageAbs) && readFileSync(notePageAbs, 'utf8').length > 0)

  console.log('\n--- ④ 幂等/健壮：书文件已被外部删掉时再调一次 ---')
  // 还原一处 store 键，验证「书文件不在」不会阻断其余清理
  repo.readerStatePatchBook(ROOT, REL, { pct: 5 })
  const r2 = await repo.deleteBookEverywhere(ROOT, REL)
  check('第二次调用不抛异常（返回结构完整）', typeof r2 === 'object' && Array.isArray(r2.errors))
  check('第二次：如实记一条「移入回收站」失败（文件已不在）',
    r2.errors.some((e) => e.startsWith('移入回收站：')), JSON.stringify(r2.errors))
  check('★ 第二次：其余五处仍被清干净（书文件不在不阻断清理）', repo.readerStateGetBook(ROOT, REL) === null)
  check('★ 第二次：笔记页依然保留', !!notePageAbs && existsSync(notePageAbs))

  // ===== 结果 =====
  const out = { base: BASE, vault: VAULT, results }
  writeFileSync(join(process.cwd(), 'tmp', 'book-market-delete-probe.json'), JSON.stringify(out, null, 2), 'utf-8')
  console.log('\n========================================')
  console.log(pass ? `✅ 删书链路运行期探针全部通过（${results.length} 条）` : '❌ 有断言失败 —— 见上面的 fail 行')
  console.log(`临时目录（未删，便于复核）：${BASE}`)
  console.log(`留档：tmp/book-market-delete-probe.json`)
  app.exit(pass ? 0 : 1)
}).catch((e) => {
  console.error('探针自身异常：', e)
  app.exit(2)
})
