#!/usr/bin/env node
/**
 * 契约验证：仓库身份统一（3.9.2）。
 *
 * 失败模式全是静默的：
 * ① 只写了 meta.id 但没迁移旧键 → 阅读进度看起来「消失」，实际还在旧前缀下；
 * ② 迁移时用新值覆盖旧值 → 另一台机器记的进度被旧副本顶掉；
 * ③ 摘录按整本覆盖而不是按摘录 id 合并 → 一边的批注消失；
 * ④ 封面只改索引不改文件名（sha1 键派生）→ 书架封面全部空白。
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/vault-identity/verify-vault-identity.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import {
  migrateStoreKeys,
  migrateCoverIndex,
  migrateVaultIdentity,
  resolveVaultId,
} from '../../../electron/lib/kbStore/vaultIdentity.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CUR = '11111111-1111-4111-8111-111111111111'
const OLD = '22222222-2222-4222-8222-222222222222'

let pass = 0
const fails = []
function ok(label, cond, detail) {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}
function eq(label, actual, expected) {
  return ok(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function stripComments(src) {
  let out = ''
  let st = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (st === 'code') {
      if (c === '/' && n === '/') { st = 'line'; i++; out += '  '; continue }
      if (c === '/' && n === '*') { st = 'block'; i++; out += '  '; continue }
      if (c === "'") st = 'sq'; else if (c === '"') st = 'dq'; else if (c === '`') st = 'tpl'
      out += c; continue
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c } else out += ' '; continue }
    if (st === 'block') { if (c === '*' && n === '/') { st = 'code'; i++; out += '  ' } else out += c === '\n' ? '\n' : ' '; continue }
    if (st === 'sq' || st === 'dq' || st === 'tpl') {
      if (c === '\\') { out += c + (n ?? ''); i++; continue }
      if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) st = 'code'
      out += c; continue
    }
  }
  return out
}

/* ================= A. pdf / reader：键迁移 + 冲突取新 ================= */
console.log('\n=== A. migrateStoreKeys：迁移与冲突 ===')
const pdf = {
  version: 1,
  books: {
    [`${OLD}/a.pdf`]: { updatedAt: '2026-10-01T00:00:00.000Z', lastPage: 10 },
    [`${OLD}/b.pdf`]: { updatedAt: '2026-10-04T00:00:00.000Z', lastPage: 2 },
    [`${CUR}/b.pdf`]: { updatedAt: '2026-10-03T00:00:00.000Z', lastPage: 9 },
    [`${OLD}/d.pdf`]: { updatedAt: '2026-10-01T00:00:00.000Z', lastPage: 5 },
    [`${CUR}/d.pdf`]: { updatedAt: '2026-10-09T00:00:00.000Z', lastPage: 6 },
    [`${CUR}/c.pdf`]: { updatedAt: '2026-10-01T00:00:00.000Z', lastPage: 1 },
    'not-a-uuid/d.pdf': { updatedAt: '2026-10-01T00:00:00.000Z', lastPage: 1 },
  },
}
const r1 = migrateStoreKeys(pdf, CUR, 'pdf')
eq('迁移条数', r1.changed, 3)
eq('旧键已删除', (r1.store.books)[`${OLD}/a.pdf`], undefined)
eq('搬过来的值', (r1.store.books)[`${CUR}/a.pdf`]?.lastPage, 10)
eq('旧值更新时覆盖', (r1.store.books)[`${CUR}/b.pdf`]?.lastPage, 2)
eq('当前值更新时保留', (r1.store.books)[`${CUR}/d.pdf`]?.lastPage, 6)
eq('当前键不动', (r1.store.books)[`${CUR}/c.pdf`]?.lastPage, 1)
ok('非 UUID 前缀不动', !!(r1.store.books)['not-a-uuid/d.pdf'])
const r2 = migrateStoreKeys(r1.store, CUR, 'pdf')
eq('幂等：第二次 changed=0', r2.changed, 0)

const reader = { version: 1, books: { [`${OLD}/x.txt`]: { updatedAt: '2026-10-01T00:00:00.000Z', pct: 0.4 } } }
const rr = migrateStoreKeys(reader, CUR, 'reader')
eq('reader 键迁移', (rr.store.books)[`${CUR}/x.txt`]?.pct, 0.4)

/* ================= B. 摘录：按摘录 id 合并 ================= */
console.log('\n=== B. 摘录合并（不整本覆盖） ===')
const excerpts = {
  version: 1,
  books: {
    [`${OLD}/book.epub`]: {
      e1: { id: 'e1', text: 'old', updatedAt: '2026-10-01T00:00:00.000Z' },
      e2: { id: 'e2', text: 'only-old', updatedAt: '2026-10-01T00:00:00.000Z' },
    },
    [`${CUR}/book.epub`]: {
      e1: { id: 'e1', text: 'new', updatedAt: '2026-10-05T00:00:00.000Z' },
      e3: { id: 'e3', text: 'only-cur', updatedAt: '2026-10-01T00:00:00.000Z' },
    },
  },
}
const re = migrateStoreKeys(excerpts, CUR, 'excerpt')
const merged = (re.store.books)[`${CUR}/book.epub`]
eq('同 id 取新', merged.e1.text, 'new')
ok('旧侧独有摘录保留', merged.e2?.text === 'only-old')
ok('新侧独有摘录保留', merged.e3?.text === 'only-cur')
eq('旧书键删除', (re.store.books)[`${OLD}/book.epub`], undefined)

/* ================= C. 导出映射：exportedAt 取新 ================= */
console.log('\n=== C. 导出映射冲突 ===')
const exportsStore = {
  version: 1,
  books: {
    [`${OLD}/b.pdf`]: { pageId: 'old-page', exportedAt: '2026-10-01T00:00:00.000Z' },
    [`${CUR}/b.pdf`]: { pageId: 'new-page', exportedAt: '2026-10-05T00:00:00.000Z' },
  },
}
const rx = migrateStoreKeys(exportsStore, CUR, 'export')
eq('导出映射取新', (rx.store.books)[`${CUR}/b.pdf`]?.pageId, 'new-page')

/* ================= D. 封面索引：键 + 文件名一起迁 ================= */
console.log('\n=== D. 封面索引与文件改名 ===')
const oldFile = `${createHash('sha1').update(`${OLD}/a.pdf`).digest('hex')}.png`
const newFile = `${createHash('sha1').update(`${CUR}/a.pdf`).digest('hex')}.png`
const cover = migrateCoverIndex({
  [`${OLD}/a.pdf`]: { mtimeMs: 100, file: oldFile },
  [`${CUR}/c.pdf`]: { mtimeMs: 200, file: 'c.png' },
}, CUR)
eq('封面键迁移', !!cover.index[`${CUR}/a.pdf`], true)
eq('封面文件名重算', cover.index[`${CUR}/a.pdf`]?.file, newFile)
eq('改名对', cover.renames[0]?.from, oldFile)
eq('改名目标', cover.renames[0]?.to, newFile)
ok('当前键保留', cover.index[`${CUR}/c.pdf`]?.file === 'c.png')
const cover2 = migrateCoverIndex(cover.index, CUR)
eq('封面幂等', cover2.changed, 0)

/* ================= E. resolveVaultId：meta 优先 / 回填 ================= */
console.log('\n=== E. 仓库身份解析 ===')
const tmp = mkdtempSync(join(tmpdir(), 'kb-vault-identity-'))
try {
  const metaDir = join(tmp, '.knowbase')
  mkdirSync(metaDir, { recursive: true })
  const metaPath = join(metaDir, 'meta.json')

  writeFileSync(metaPath, JSON.stringify({ schemaVersion: 1, id: OLD, name: 'n', createdAt: 'x' }))
  eq('meta.id 优先（另一系统采纳）', resolveVaultId(tmp, CUR), OLD)

  writeFileSync(metaPath, JSON.stringify({ schemaVersion: 1, name: 'n', createdAt: 'x' }))
  eq('meta 无 id → 写本地 id', resolveVaultId(tmp, CUR), CUR)
  const filled = JSON.parse(readFileSync(metaPath, 'utf8'))
  eq('回填 id', filled.id, CUR)
  eq('保留 name', filled.name, 'n')
  eq('保留 createdAt', filled.createdAt, 'x')

  writeFileSync(metaPath, JSON.stringify({ id: 'not-a-uuid' }))
  eq('非法 id → 覆盖为本地 id', resolveVaultId(tmp, CUR), CUR)

  const noMeta = join(tmp, 'fresh')
  mkdirSync(noMeta, { recursive: true })
  eq('无 meta 不凭空建文件', resolveVaultId(noMeta, CUR), CUR)
  eq('无 meta 不建 .knowbase', existsSync(join(noMeta, '.knowbase')), false)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

/* ================= F. migrateVaultIdentity：真实文件 ================= */
console.log('\n=== F. migrateVaultIdentity：落盘 + 封面文件 ===')
const fx = mkdtempSync(join(tmpdir(), 'kb-vault-identity-fs-'))
try {
  const modDir = join(fx, '.knowbase', 'modules')
  const coverDir = join(fx, '.knowbase', 'cache', 'covers')
  mkdirSync(modDir, { recursive: true })
  mkdirSync(coverDir, { recursive: true })
  writeFileSync(join(modDir, 'pdfReader.json'), JSON.stringify({ version: 1, books: { [`${OLD}/a.pdf`]: { updatedAt: '2026-10-01T00:00:00.000Z', lastPage: 7 } } }))
  writeFileSync(join(coverDir, 'index.json'), JSON.stringify({ [`${OLD}/a.pdf`]: { mtimeMs: 1, file: oldFile } }))
  writeFileSync(join(coverDir, oldFile), 'png')

  const out = migrateVaultIdentity(fx, CUR)
  eq('迁移键数', out.keys, 1)
  eq('迁移封面数', out.covers, 1)
  const saved = JSON.parse(readFileSync(join(modDir, 'pdfReader.json'), 'utf8'))
  eq('落盘后键已换', !!saved.books[`${CUR}/a.pdf`], true)
  ok('封面文件已改名', existsSync(join(coverDir, newFile)) && !existsSync(join(coverDir, oldFile)))
  const idx = JSON.parse(readFileSync(join(coverDir, 'index.json'), 'utf8'))
  eq('封面索引已换', idx[`${CUR}/a.pdf`]?.file, newFile)

  const again = migrateVaultIdentity(fx, CUR)
  eq('整体幂等：键 0', again.keys, 0)
  eq('整体幂等：封面 0', again.covers, 0)
} finally {
  rmSync(fx, { recursive: true, force: true })
}

/* ================= G. 调用点形状 ================= */
console.log('\n=== G. 调用点形状（注释已剥离） ===')
const ws = stripComments(readFileSync(join(ROOT, 'electron/lib/workspaceManager.ts'), 'utf8'))
const vc = stripComments(readFileSync(join(ROOT, 'electron/lib/kbStore/vaultContext.ts'), 'utf8'))
ok('adopt 入口解析仓库身份', ws.includes('resolveVaultId('))
ok('打开/恢复都跑身份迁移', (ws.match(/migrateVaultIdentity\(/g) || []).length >= 2, String((ws.match(/migrateVaultIdentity\(/g) || []).length))
ok('ensureKbRoot 写入 id', vc.includes('id: vaultId'))
ok('最近列表按路径去重', vc.includes('x.path !== v.rootPath'))

/* ================= 汇总 ================= */
console.log('')
if (fails.length === 0) {
  console.log(`PASS  ${pass}/${pass} 全部通过`)
  process.exit(0)
}
console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败`)
for (const f of fails) console.log('  - ' + f)
process.exit(1)
