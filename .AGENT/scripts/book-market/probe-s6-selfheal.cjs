/**
 * 书市 S6 元数据自愈探针 —— 在真实 electron 主进程里驱动**真实的 fsWatcher 与 workspaceManager**。
 *
 * 为什么必须有它：`verify-book-market-selfheal.mjs` 只验静态接线（import / 调用点 / 常量），
 * 验不了「事件真的抵达 flush 并真的回收了孤儿」—— 那要靠真 `fs.watch` + 真节流 + 真 prune。
 * S6 是**纯主进程**功能（零 UI、零 IPC），故主进程探针即可完整覆盖，不需要 CDP / 渲染层。
 *
 * 跑法（两步；Electron 33 = Node 20，不能 strip-types，所以先把真实实现打包）：
 *   node_modules/.bin/esbuild tmp/s6-probe-entry.ts --bundle --platform=node \
 *     --format=cjs --external:electron --outfile=tmp/s6-selfheal.cjs
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe .AGENT/scripts/book-market/probe-s6-selfheal.cjs --no-sandbox --disable-gpu
 *
 * ★ 声明：**不碰用户的开发数据目录**。启动即把 userData 改到系统临时目录，仓库用临时目录里的
 *   假 vault；只写 `%TEMP%` 下一个一次性目录，绝不写 `%APPDATA%/knowbase (dev)`。临时目录不删（便于复核）。
 *
 * 三条断言（对应方案 `.claude/plans/s6-metadata-selfheal.md` §五）：
 *   ① 实时扫描：运行期从磁盘删一本书 → fsWatcher flush 节流触发 → meta 条目被回收
 *   ② 节流负向：刚 prune 过再放一个孤儿，1s 内**不该**被回收（证明 30s 节流真的在拦）
 *   ③ 打开即扫：adoptImportedVault（仓库打开）→ 孤儿同步被回收 + 孤儿/无引用封面一并删
 *
 * 产物：stdout 一份 JSON + tmp/book-market-s6-selfheal.json（留档）
 */
const { app } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const BASE = mkdtempSync(join(tmpdir(), 'kb-probe-s6-'))
const USER_DATA = join(BASE, 'userData')
const VAULT = join(BASE, 'vault')
// ★ 必须在 app ready 之前改：晚了 settings.json 已按真实 userData 算好路径（会写进开发数据目录）
app.setPath('userData', USER_DATA)

const KB = join(VAULT, '.knowbase')
const BOOKS = join(VAULT, '.books')
const ROOT_ID = 'probe-vault'

const results = []
let pass = true
function check(name, ok, extra = '') {
  if (!ok) pass = false
  results.push({ name, ok: !!ok, extra: String(extra) })
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  mkdirSync(join(KB, 'modules'), { recursive: true })
  writeFileSync(join(KB, 'meta.json'), JSON.stringify({ schemaVersion: 1, name: 'probe' }), 'utf-8')
  mkdirSync(BOOKS, { recursive: true })

  const repo = require(join(process.cwd(), 'tmp', 's6-selfheal.cjs'))
  repo.setCurrentVault({ rootId: ROOT_ID, name: 'probe-vault', rootPath: VAULT })
  const META = repo.bookMetaFileAbsPath()
  const COVERS = repo.ensureBookCoversDir()
  const metaKeys = () => Object.keys(repo.bookMetaReadAll().books)

  const out = {
    when: new Date().toISOString(),
    electron: process.versions.electron,
    base: BASE,
    vault: VAULT,
    metaFile: META,
    coversDir: COVERS,
    checks: results,
  }

  /* ================= ① 实时扫描：运行期删书 → fsWatcher 节流触发 ================= */
  console.log('--- ① 实时扫描（fsWatcher flush 节流触发）---')
  writeFileSync(join(BOOKS, 'runtime.epub'), Buffer.from('FAKE-EPUB-RUNTIME'))
  const up1 = repo.bookMetaUpsert('.books/runtime.epub', { size: 18 }, '运行期书')
  check('种子：runtime.epub 落盘 + meta 已写',
    existsSync(join(BOOKS, 'runtime.epub')) && up1.ok && metaKeys().includes('.books/runtime.epub'),
    up1.error || '')
  // 起监听：此刻 lastPruneAt 仍为 0（此前无任何 .books/ 事件，探针进程内是全新的）
  repo.syncVaultWatcher()
  // 从磁盘删书（模拟用户在文件管理器里删）→ 事件抵达 flush → 节流放行 → prune
  unlinkSync(join(BOOKS, 'runtime.epub'))
  await sleep(1500) // 300ms 防抖 + flush + prune 的余量
  check('★ 运行期删书 → meta 条目被实时回收',
    !metaKeys().includes('.books/runtime.epub'), metaKeys().join(',') || '(空)')
  check('meta 文件仍是合法 JSON', (() => {
    try { JSON.parse(readFileSync(META, 'utf-8')); return true } catch { return false }
  })())

  /* ================= ② 节流负向：刚 prune 过，1s 内新孤儿不该被回收 ================= */
  console.log('--- ② 节流负向（30s 窗口内不得回收）---')
  writeFileSync(join(COVERS, 'ghost.jpg'), 'FAKE-JPG-GHOST')
  const up2 = repo.bookMetaUpsert('.books/ghost.epub', { coverRel: '.books/.covers/ghost.jpg' }, '幽灵书')
  check('种子：孤儿 ghost.epub 条目已写（磁盘无此书）',
    up2.ok && metaKeys().includes('.books/ghost.epub'), up2.error || '')
  await sleep(1200) // 写 meta 触发 .books/ 事件 → flush → 但节流应拦下
  check('★ 节流生效：1s 内孤儿未被回收（否则 30s 节流没拦住）',
    metaKeys().includes('.books/ghost.epub'), metaKeys().join(',') || '(空)')
  check('节流生效：孤儿封面也还在', existsSync(join(COVERS, 'ghost.jpg')))

  /* ================= ③ 打开即扫：adoptImportedVault 同步回收 ================= */
  console.log('--- ③ 打开即扫（workspaceManager 仓库打开）---')
  const before = metaKeys().length
  const adopted = repo.adoptImportedVault(VAULT, 'probe-vault')
  check('adoptImportedVault 成功返回 rootId', !!adopted?.rootId, JSON.stringify(adopted))
  check('★ 仓库打开即扫：孤儿条目同步被回收',
    !metaKeys().includes('.books/ghost.epub'), metaKeys().join(',') || '(空)')
  check('回收顺手删掉孤儿封面', !existsSync(join(COVERS, 'ghost.jpg')))
  check('只回收孤儿、未误伤（恰少 1 条）', before - metaKeys().length === 1,
    `before=${before} after=${metaKeys().length}`)

  /* ================= ④ 幂等：再打开一次不再变化 ================= */
  console.log('--- ④ 幂等 ---')
  const snapshot = JSON.stringify(repo.bookMetaReadAll())
  repo.adoptImportedVault(VAULT, 'probe-vault')
  check('幂等：再次打开 meta 不再变化', JSON.stringify(repo.bookMetaReadAll()) === snapshot)

  /* ================= 收尾 ================= */
  out.checks = results
  out.summary = { total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length }
  out.overall = pass ? 'PASS（S6 元数据自愈行为全部成立）' : '需人工判读 —— 见 checks'
  console.log('\n========================================')
  console.log(pass ? `✅ S6 元数据自愈行为全部通过：${out.summary.pass}/${out.summary.total}` : `❌ ${out.summary.fail} 项 FAIL（另有 ${out.summary.pass} 项 PASS）`)
  console.log(`临时目录（留档，可人工复核）：${BASE}`)
  console.log(JSON.stringify(out, null, 2))
  try {
    const { writeFileSync: w } = require('node:fs')
    w(join(process.cwd(), 'tmp', 'book-market-s6-selfheal.json'), JSON.stringify(out, null, 2))
  } catch { /* 落盘不影响 stdout */ }
  app.exit(pass ? 0 : 1)
})
