/**
 * 书市 S1 磁盘契约探针 —— 在真实 electron 主进程里跑**真实的 repo 实现**，只认磁盘字节。
 *
 * 为什么必须有它：`verify-book-sources.mjs` 只能验零依赖纯函数 + 静态不变量（repo 层 import
 * electron，Node 的 strip-types 起不来）。而 S1 最要紧的那条负向保证 —— **凭据只进密文文件、
 * 书源描述里一个字节都不留** —— 唯有看落盘字节才算数（schema 层验过不代表落盘对）。
 *
 * 跑法（两步；Electron 33 = Node 20，不能 strip-types，所以先把真实实现打包）：
 *   node_modules/.bin/esbuild tmp/s1-probe-entry.ts --bundle --platform=node \
 *     --format=cjs --external:electron --outfile=tmp/s1-repo.cjs
 *   unset ELECTRON_RUN_AS_NODE
 *   ./node_modules/electron/dist/electron.exe .AGENT/scripts/book-market/probe-s1-disk.cjs --no-sandbox --disable-gpu
 *
 * ★ 声明：**不碰用户的开发数据目录**。启动即把 userData 改到系统临时目录，仓库用临时目录里的
 *   假 vault；只写 `%TEMP%` 下一个一次性目录，绝不写 `%APPDATA%/knowbase (dev)`。
 *   临时目录**不删**（便于人工复核），路径打在输出里。
 *
 * 产物：stdout 一份 JSON + tmp/book-market-s1-disk.json（留档）
 */
const { app } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, dirname } = require('node:path')

const BASE = mkdtempSync(join(tmpdir(), 'kb-probe-s1-'))
const USER_DATA = join(BASE, 'userData')
const VAULT = join(BASE, 'vault')
// ★ 必须在 app ready 之前改：晚了 settings.json 已经按真实 userData 算好路径（会写进开发数据目录）
app.setPath('userData', USER_DATA)

const KB = join(VAULT, '.knowbase')
const F_SOURCES = join(KB, 'modules', 'bookSources.json')
const F_SECRET = join(KB, 'secret', 'bookSources.json')
const F_META = join(VAULT, '.books', '.meta.json')
const LEAK = { USER: 'LEAK_USER_9f3a', PASS: 'LEAK_PASS_9f3a', TOKEN: 'LEAK_TOKEN_9f3a' }

const results = []
let pass = true
function check(name, ok, extra = '') {
  if (!ok) pass = false
  results.push({ name, ok: !!ok, extra: String(extra) })
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
}

/** 读文件原始字节（不做任何解码归一），用于「一个字节都不许留」类断言 */
function rawBytes(p) {
  return existsSync(p) ? readFileSync(p, 'utf-8') : null
}

function backupFiles() {
  const dir = dirname(F_SOURCES)
  if (!existsSync(dir)) return []
  return require('node:fs').readdirSync(dir).filter((n) => n.includes('.corrupt-'))
}

app.whenReady().then(() => {
  mkdirSync(KB, { recursive: true })
  writeFileSync(join(KB, 'meta.json'), JSON.stringify({ schemaVersion: 1, name: 'probe' }), 'utf-8')

  const repo = require(join(process.cwd(), 'tmp', 's1-repo.cjs'))
  const { setCurrentVault, getCurrentVault } = repo
  const ROOT = 'probe-vault'
  setCurrentVault({ rootId: ROOT, name: 'probe-vault', rootPath: VAULT })

  const out = { when: new Date().toISOString(), electron: process.versions.electron, base: BASE, vault: VAULT, checks: results }

  console.log('--- ⓪ 预置源种入（拍板 ⑥⑦；★ 必须在建任何自建源**之前**读，否则量不出「首次」）---')
  const seeded = repo.bookSourceList(ROOT)
  check('首次读清单即种入两个预置源', seeded.length === 2 && seeded.every((s) => s.builtin), seeded.map((s) => s.id).join(','))
  check('预置源带检索模板（不是只种了 id）', seeded.every((s) => s.searchUrl.includes('{query}')))
  check('种入即落盘（不是只在内存里）', existsSync(F_SOURCES) && JSON.parse(rawBytes(F_SOURCES)).sources.length === 2)
  check('再读不重复种入（幂等）', repo.bookSourceList(ROOT).length === 2)
  check('内置源不可删（拍板 ⑥：可停用不可删）', repo.bookSourceRemove(ROOT, 'builtin-gutenberg').ok === false)
  check('内置源可停用',
    repo.bookSourceSetEnabled(ROOT, 'builtin-gutenberg', false).ok === true
    && repo.bookSourceList(ROOT).find((s) => s.id === 'builtin-gutenberg').enabled === false)
  check('★ 停用状态不会被下次读盘种回启用（种入只补**缺的 id**，不碰已存在的）',
    repo.bookSourceList(ROOT).find((s) => s.id === 'builtin-gutenberg').enabled === false)
  // 改名 + 复启用：改名后 id 仍在 ⇒ 不该被重种一份「同名新源」（重复种入的典型表象）
  repo.bookSourceUpsert(ROOT, { name: '古腾堡（我改的名）', enabled: true }, 'builtin-gutenberg')
  check('★ 改名后的内置源不被重种一份（清单仍 2 条）', repo.bookSourceList(ROOT).length === 2,
    repo.bookSourceList(ROOT).map((s) => s.name).join(','))

  console.log('--- ① 书源读写往返 ---')
  const created = repo.bookSourceUpsert(ROOT, { name: '公版书库', kind: 'opds', url: 'https://example.org/opds' })
  check('新建书源成功', created.ok && !!created.source?.id, created.error || '')
  const sid = created.source?.id
  check('落盘文件已生成', existsSync(F_SOURCES))
  check('新读回 3 条（2 预置 + 1 自建）', repo.bookSourceList(ROOT).length === 3)
  const renamed = repo.bookSourceUpsert(ROOT, { name: '公版书库（改）' }, sid)
  check('更新只覆盖给到的字段', renamed.ok && renamed.source.name === '公版书库（改）' && renamed.source.url === 'https://example.org/opds')
  check('停用生效', repo.bookSourceSetEnabled(ROOT, sid, false).ok
    && repo.bookSourceList(ROOT).find((s) => s.id === sid).enabled === false)
  check('非法 URL 明确报错（不是静默丢弃）', repo.bookSourceUpsert(ROOT, { url: 'ftp://x/y' }, sid).ok === false)
  check('空 patch 不报错（no-op）', repo.bookSourceUpsert(ROOT, {}, sid).ok === true)

  console.log('--- ② 凭据只进密文：书源描述一个字节都不许留 ---')
  const saved = repo.bookSourceSaveCredential(ROOT, sid, { type: 'basic', username: LEAK.USER, password: LEAK.PASS })
  check('存凭据成功', saved.ok, saved.error || '')
  const srcBytes = rawBytes(F_SOURCES) || ''
  check('bookSources.json 字节里无凭据明文', !srcBytes.includes(LEAK.USER) && !srcBytes.includes(LEAK.PASS))
  check('bookSources.json 里连字段名都没有', !/"(username|password|token)"\s*:/.test(srcBytes))
  const srcJson = JSON.parse(srcBytes)
  const stored = srcJson.sources.find((s) => s.id === sid)
  check('源上只留 auth 引用（type + ref=源 id）', stored?.auth?.type === 'basic' && stored?.auth?.ref === sid)
  const secretBytes = rawBytes(F_SECRET)
  check('密文文件已生成', !!secretBytes)
  check('密文是密文（enc1: 前缀 + 不含明文）', !!secretBytes && secretBytes.startsWith('enc1:') && !secretBytes.includes(LEAK.PASS))
  check('解密往返（hasCredential = true）', repo.bookSourceHasCredential(ROOT, sid) === true)
  check('主进程取得到凭据本体（S2 注入用）', repo.bookSourceCredentialFor(ROOT, sid)?.password === LEAK.PASS)

  console.log('--- ③ 出 IPC 的描述不含凭据本体 ---')
  const infos = repo.bookSourceInfos(ROOT)
  // ★ 按 id 找，别用 [0] —— 预置源排在前面，[0] 是内置源
  const info = infos.find((i) => i.id === sid)
  check('info 报 hasCredential=true', info?.hasCredential === true)
  check('info 报 authType', info?.authType === 'basic')
  check('info 里有预置源且它们免认证（hasCredential=false）',
    infos.filter((i) => i.builtin).length === 2 && infos.filter((i) => i.builtin).every((i) => i.hasCredential === false))
  check('info 序列化后无凭据明文', !JSON.stringify(infos).includes('LEAK_'))
  check('info 不含 auth.ref 之外的东西（无凭据字段）', !/"(password|token|username)"/.test(JSON.stringify(infos)))

  console.log('--- ④ 内置源不可删 / 删源清凭据 ---')
  const seed = JSON.parse(srcBytes)
  seed.sources.push({ id: 'builtin-1', name: '内置源', kind: 'opds', url: 'https://gutenberg.org/opds', auth: null, enabled: true, builtin: true, mapping: null, createdAt: new Date().toISOString() })
  writeFileSync(F_SOURCES, JSON.stringify(seed, null, 2), 'utf-8')
  check('内置源拒绝删除', repo.bookSourceRemove(ROOT, 'builtin-1').ok === false)
  check('删普通源成功', repo.bookSourceRemove(ROOT, sid).ok === true)
  check('删源后清单里没有它（预置源与那条假内置源仍在）',
    (() => { const l = repo.bookSourceList(ROOT); return !l.some((s) => s.id === sid) && l.filter((s) => s.builtin).length === 3 })(),
    repo.bookSourceList(ROOT).map((s) => s.id).join(','))
  check('删源顺手清掉密文条目', rawBytes(F_SECRET) !== null && !repo.bookSourceHasCredential(ROOT, sid))

  console.log('--- ⑤ 脏数据回落（书市不该被坏文件弄打不开） ---')
  const before = backupFiles().length
  writeFileSync(F_SOURCES, '{ 这不是 JSON', 'utf-8')
  const afterGarbage = repo.bookSourceList(ROOT)
  // ★ 期望在 2026-09-22 变过：坏文件下**自建源会丢**，但预置源照旧种回来（拍板 ⑥「删了下次还会回来」）。
  //   别把「只剩预置源」当回归 —— 这才是「书市不被坏文件弄打不开」的落地形态。
  check('坏文件 → 不抛错，退回「只剩预置源」', Array.isArray(afterGarbage) && afterGarbage.length === 2 && afterGarbage.every((s) => s.builtin),
    afterGarbage.map((s) => s.id).join(','))
  check('坏文件已备份为 .corrupt-<ts>', backupFiles().length === before + 1)
  check('坏 store 形状（sources 非数组）→ 同样只剩预置源', (() => {
    writeFileSync(F_SOURCES, JSON.stringify({ version: 1, sources: 'oops' }), 'utf-8')
    const l = repo.bookSourceList(ROOT)
    return l.length === 2 && l.every((s) => s.builtin)
  })())

  console.log('--- ⑥ 元数据落盘 / 自愈回收 ---')
  check('越权 relPath 拒绝', repo.bookMetaUpsert('/abs.epub', {}, '书名').ok === false)
  check('缺书名拒绝', repo.bookMetaUpsert('books/a.epub', {}).ok === false)
  const coverDir = repo.ensureBookCoversDir()
  check('封面目录可建', !!coverDir && existsSync(coverDir))
  writeFileSync(join(coverDir, 'beef01.jpg'), 'FAKE-JPEG')
  const up = repo.bookMetaUpsert('books/鲁迅 - 呐喊.epub', { author: '鲁迅', size: 1234, coverRel: '.books/.covers/beef01.jpg' }, '呐喊')
  check('元数据写入成功', up.ok && up.entry.author === '鲁迅' && up.entry.size === 1234, up.error || '')
  check('meta 文件已生成且含书名', (rawBytes(F_META) || '').includes('呐喊'))
  check('回读一致（键 = relPath）', repo.bookMetaGet('books/鲁迅 - 呐喊.epub')?.title === '呐喊')
  check('越权封面引用被清空', repo.bookMetaUpsert('books/b.epub', { coverRel: '../../x.jpg' }, 'B').entry.coverRel === '')
  check('越权封面删除被拒', repo.bookCoverDelete('../../x.jpg') === false)

  // 自愈式回收：磁盘上根本没有这本书（scanVaultBooks 扫不到）→ 条目应被回收、封面一并删掉
  const pruned = repo.bookMetaPruneOrphans()
  check('孤儿条目被回收', pruned.ok && Object.keys(pruned.removed).length === 2, JSON.stringify(Object.keys(pruned.removed)))
  check('回收后 meta 里不留该书', Object.keys(repo.bookMetaReadAll().books).length === 0)
  check('回收顺手删掉孤儿封面', !existsSync(join(coverDir, 'beef01.jpg')))
  check('回收幂等（再跑一次不报错）', repo.bookMetaPruneOrphans().removed && Object.keys(repo.bookMetaPruneOrphans().removed).length === 0)

  console.log('--- ⑦ 跨仓库守卫 ---')
  check('rootId 不匹配一律拒绝', repo.bookSourceUpsert('other-vault', { name: 'x', url: 'https://a.org' }).ok === false)
  check('无当前仓库时不写盘', (() => { setCurrentVault(null); const r = repo.bookSourceUpsert(ROOT, { name: 'x', url: 'https://a.org' }); setCurrentVault({ rootId: ROOT, name: 'probe-vault', rootPath: VAULT }); return r.ok === false })())

  out.checks = results
  out.summary = { total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length }
  out.overall = pass ? 'PASS（S1 磁盘契约全部成立）' : '需人工判读 —— 见 checks'
  console.log('\n========================================')
  console.log(pass ? `✅ S1 磁盘契约全部通过：${out.summary.pass}/${out.summary.total}` : `❌ ${out.summary.fail} 项 FAIL（另有 ${out.summary.pass} 项 PASS）`)
  console.log(`临时目录（留档，可人工复核）：${BASE}`)
  console.log(JSON.stringify(out, null, 2))
  try {
    const dest = join(process.cwd(), 'tmp', 'book-market-s1-disk.json')
    const { writeFileSync: w } = require('node:fs')
    w(dest, JSON.stringify(out, null, 2))
  } catch { /* 落盘不影响 stdout */ }
  app.exit(pass ? 0 : 1)
})
