#!/usr/bin/env node
/**
 * 契约验证：「附件入仓库」（3.9.2）。
 *
 * 为什么需要它：这条链路的失败全是静默的 ——
 * ① 分隔符归一化丢了 → Windows 建的库在 Linux 上全是破图，但没有任何报错（只是 404）；
 * ② 仓库优先改成旧目录优先 → 看起来能显示，实际用的是 userData 里的旧副本，换机照样丢；
 * ③ 迁移覆盖了仓库里更新的文件 → 数据被旧副本顶掉；
 * ④ 渲染层又拼回 `\\` → 只有 Windows 正常，Linux 上「用本地工具打开」静默失败。
 *
 * 所以这里验证的是**纯路径规则 + 真实文件行为 + 调用点形状**三件事。
 *
 * 运行（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/attachments/verify-attachment-store.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  normalizeRel,
  attachmentRel,
  resolveExistingPath,
  copyMissingFile,
  migrationRels,
} from '../../../electron/lib/kbStore/attachmentPath.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
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

/** 只剥注释、保留字符串字面量（同 workbench-shell 契约的状态机实现） */
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

function readRel(rel) {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/* ================= A. 归一化 ================= */
console.log('\n=== A. normalizeRel：反斜杠 / 盘符 / 越界 ===')
eq("a\\b\\c.jpg → a/b/c.jpg", normalizeRel('a\\b\\c.jpg'), 'a/b/c.jpg')
eq(".\\a\\b.png → a/b.png", normalizeRel('.\\a\\b.png'), 'a/b.png')
eq('a/./b/../c.png → a/c.png', normalizeRel('a/./b/../c.png'), 'a/c.png')
eq('../x.png 拒绝', normalizeRel('../x.png'), null)
eq('a/../../x 拒绝', normalizeRel('a/../../x'), null)
eq('C:\\x 拒绝', normalizeRel('C:\\x'), null)
eq('C:/x 拒绝', normalizeRel('C:/x'), null)
eq('/etc/passwd 拒绝', normalizeRel('/etc/passwd'), null)
eq('//server/share/x 拒绝', normalizeRel('//server/share/x'), null)
eq('空串拒绝', normalizeRel(''), null)
eq('空白拒绝', normalizeRel('   '), null)
eq('NUL 拒绝', normalizeRel('a\0b'), null)
eq('非字符串拒绝', normalizeRel(42), null)

/* ================= B. 拼接口径 ================= */
console.log('\n=== B. attachmentRel：永远 POSIX ===')
eq('带点扩展名', attachmentRel('moments_post', '_pending', 'abc', '.jpg'), 'moments_post/_pending/abc.jpg')
eq('不带点扩展名', attachmentRel('moments_post', '_pending', 'abc', 'png'), 'moments_post/_pending/abc.png')
eq('空扩展名', attachmentRel('misc', '_pending', 'abc', ''), 'misc/_pending/abc')
ok('任何输入都不出反斜杠', !attachmentRel('a', 'b', 'c', '.png').includes('\\'))

/* ================= C. 仓库优先 / 旧目录回退 ================= */
console.log('\n=== C. resolveExistingPath：仓库优先，旧目录兜底 ===')
const tmp = mkdtempSync(join(tmpdir(), 'kb-attachment-contract-'))
try {
  const vaultRoot = join(tmp, 'vault', '.attachments')
  const legacyRoot = join(tmp, 'userdata', 'attachments')
  mkdirSync(join(legacyRoot, 'moments_post', '_pending'), { recursive: true })
  writeFileSync(join(legacyRoot, 'moments_post', '_pending', 'a.jpg'), 'legacy-a')

  const hitLegacy = resolveExistingPath(vaultRoot, legacyRoot, 'moments_post\\_pending\\a.jpg')
  ok('反斜杠台账命中旧目录', !!hitLegacy, JSON.stringify(hitLegacy))
  eq('命中旧目录 inVault=false', hitLegacy?.inVault, false)
  eq('命中旧目录绝对路径', hitLegacy?.abs, join(legacyRoot, 'moments_post', '_pending', 'a.jpg'))
  eq('命中旧目录时 rel 已归一化', hitLegacy?.rel, 'moments_post/_pending/a.jpg')

  const copy1 = copyMissingFile(vaultRoot, legacyRoot, 'moments_post/_pending/a.jpg')
  eq('复制进仓库 copied=true', copy1?.copied, true)
  eq('复制内容一致', readFileSync(join(vaultRoot, 'moments_post', '_pending', 'a.jpg'), 'utf8'), 'legacy-a')

  const hitVault = resolveExistingPath(vaultRoot, legacyRoot, 'moments_post/_pending/a.jpg')
  eq('双命中时仓库优先', hitVault?.inVault, true)
  eq('双命中时路径在仓库', hitVault?.abs, join(vaultRoot, 'moments_post', '_pending', 'a.jpg'))

  const copy2 = copyMissingFile(vaultRoot, legacyRoot, 'moments_post/_pending/a.jpg')
  eq('第二次迁移 copied=false（幂等）', copy2?.copied, false)
  eq('第二次迁移不覆盖', readFileSync(join(vaultRoot, 'moments_post', '_pending', 'a.jpg'), 'utf8'), 'legacy-a')

  writeFileSync(join(vaultRoot, 'moments_post', '_pending', 'a.jpg'), 'vault-newer')
  const copy3 = copyMissingFile(vaultRoot, legacyRoot, 'moments_post/_pending/a.jpg')
  eq('仓库里更新过的文件不被旧副本覆盖', copy3?.copied, false)
  eq('覆盖保护后的内容', readFileSync(join(vaultRoot, 'moments_post', '_pending', 'a.jpg'), 'utf8'), 'vault-newer')

  eq('双缺失返回 null', resolveExistingPath(vaultRoot, legacyRoot, 'moments_post/_pending/none.jpg'), null)
  eq('无仓库时只看旧目录', resolveExistingPath(null, legacyRoot, 'moments_post/_pending/a.jpg')?.inVault, false)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

/* ================= D. 复制行为 ================= */
console.log('\n=== D. copyMissingFile：原子复制 / 头像前缀 / 越界 ===')
const tmp2 = mkdtempSync(join(tmpdir(), 'kb-attachment-contract-'))
try {
  const vaultRoot = join(tmp2, 'vault', '.attachments')
  const userData = join(tmp2, 'userdata')
  mkdirSync(join(userData, 'attachments', 'user_profile', 'default'), { recursive: true })
  writeFileSync(join(userData, 'attachments', 'user_profile', 'default', 'a.png'), 'avatar-bytes')

  const av = copyMissingFile(vaultRoot, userData, 'user_profile/default/a.png', 'attachments/user_profile/default/a.png')
  eq('头像旧前缀复制成功', av?.copied, true)
  eq('头像落到新口径路径', av?.abs, join(vaultRoot, 'user_profile', 'default', 'a.png'))
  eq('头像内容一致', readFileSync(join(vaultRoot, 'user_profile', 'default', 'a.png'), 'utf8'), 'avatar-bytes')

  eq('越界 rel 拒绝', copyMissingFile(vaultRoot, userData, '../escape.png'), null)
  eq('绝对 rel 拒绝', copyMissingFile(vaultRoot, userData, '/etc/passwd'), null)
  eq('源不存在返回 null', copyMissingFile(vaultRoot, userData, 'user_profile/default/none.png'), null)
  const leftTmp = readdirSync(join(vaultRoot, 'user_profile', 'default')).some(n => n.includes('.tmp-'))
  ok('没有留下 .tmp- 临时文件', !leftTmp)
} finally {
  rmSync(tmp2, { recursive: true, force: true })
}

/* ================= E. 迁移计划 ================= */
console.log('\n=== E. migrationRels：归一化 / 去重 / 回收区 ===')
const plan = migrationRels([
  { id: '1', file_path: 'moments_post\\_pending\\a.jpg', thumb_path: 'moments_post\\_pending\\thumbs\\a.jpg' },
  { id: '2', file_path: 'a/b.png', thumb_path: '', trashed: 1, trash_path: 'attachments_trash\\bin1\\a\\b.png' },
  { id: '3', file_path: '', thumb_path: '', trashed: 0, trash_path: 'attachments_trash/bin1/x.png' },
  { id: '1', file_path: 'moments_post/_pending/a.jpg' },
])
eq('计划条数', plan.length, 4)
eq('文件路径归一化', plan[0].rel, 'moments_post/_pending/a.jpg')
eq('缩略图归一化', plan[1].rel, 'moments_post/_pending/thumbs/a.jpg')
eq('回收区归一化', plan[3].rel, 'attachments_trash/bin1/a/b.png')
eq('回收区 kind', plan[3].kind, 'trash')
ok('未删除的行不迁移回收区', !plan.some(p => p.rel === 'attachments_trash/bin1/x.png'))
ok('重复路径去重', plan.filter(p => p.rel === 'moments_post/_pending/a.jpg').length === 1)

/* ================= F. 调用点形状 ================= */
console.log('\n=== F. 调用点形状（注释已剥离） ===')
const repo = stripComments(readRel('electron/database/repositories/attachmentRepo.ts'))
const user = stripComments(readRel('electron/database/repositories/userRepo.ts'))
const glob = stripComments(readRel('electron/lib/globalPaths.ts'))
const main = stripComments(readRel('electron/main/index.ts'))
const editor = stripComments(readRel('src/modules/knowledge/components/PageEditor.tsx'))

ok('attachmentRepo 不再使用全局 getAttachmentsDir', !repo.includes('getAttachmentsDir('))
ok('attachmentRepo 读路径走 ensureAttachmentInVault', /getAttachmentFilePath[\s\S]{0,600}?ensureAttachmentInVault\(/.test(repo))
ok('attachmentRepo 写路径走 attachmentRel', repo.includes('attachmentRel('))
ok('attachmentRepo 有迁移调用', repo.includes('ensureAttachmentStoreMigrated()'))
ok('userRepo 不再使用全局 getAttachmentsDir', !user.includes('getAttachmentsDir('))
ok('userRepo 头像走 resolveAvatarFile', user.includes('resolveAvatarFile('))
ok('globalPaths 只保留旧布局访问器', glob.includes('export function getLegacyAttachmentsDir') && !glob.includes('export function getAttachmentsDir'))
ok('app:getAttachmentsPath 返回仓库附件区', main.includes("ipcMain.handle('app:getAttachmentsPath', () => getVaultAttachmentsRoot() ?? '')"))
ok('PageEditor 不再拼反斜杠路径', !editor.includes('attachmentsPath}'))
ok('PageEditor 走 resolveAttachmentRel', editor.includes('resolveAttachmentRel('))

/* ================= 汇总 ================= */
console.log('')
if (fails.length === 0) {
  console.log(`PASS  ${pass}/${pass} 全部通过`)
  process.exit(0)
}
console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败`)
for (const f of fails) console.log('  - ' + f)
process.exit(1)
