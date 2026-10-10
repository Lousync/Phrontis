#!/usr/bin/env node
/**
 * 清点模块契约（对话驱动建课 Phase 1）。
 * 真实调用 `aiTeachingInventory.ts` 的纯函数 + 落盘（Node 原生 type-stripping 直接 import .ts）。
 * 跑法：node .AGENT/scripts/ai-teaching/verify-inventory.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  scanInventoryDir, buildInventoryMarkdown, inventoryFingerprint, writeInventoryIndex, todayLocal,
} from '../../../electron/lib/aiTeachingInventory.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MAT = join(ROOT, 'tmp', 'verify-inventory-mat')
const WS = join(ROOT, 'tmp', 'verify-inventory-ws')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

function buildFixtures() {
  rmSync(MAT, { recursive: true, force: true }); rmSync(WS, { recursive: true, force: true })
  mkdirSync(join(MAT, '内存管理'), { recursive: true })
  mkdirSync(join(MAT, '进程管理'), { recursive: true })
  writeFileSync(join(MAT, '内存管理', '虚拟存储器.md'), '# 虚拟存储器\n## 分页\n## 分段\n' + 'x'.repeat(100))
  writeFileSync(join(MAT, '内存管理', '连续分配.md'), '# 连续分配\n' + 'y'.repeat(50))
  writeFileSync(join(MAT, '进程管理', '进程与线程.md'), '# 进程与线程\n' + 'z'.repeat(30))
  writeFileSync(join(MAT, '进程管理', '课本.pdf'), '%PDF-1.4 fake bytes')
  mkdirSync(join(WS, 'SOURCES'), { recursive: true })
}

console.log('\n[清点] 已分类目录')
buildFixtures()
const scan = scanInventoryDir(MAT)
check('分类判定 = organized（子文件夹=章）', scan.classification === 'organized', scan.classification)
check('子文件夹数 = 2 且按名排序', scan.subdirs.length === 2 && scan.subdirs[0].name === '内存管理' && scan.subdirs[1].name === '进程管理', JSON.stringify(scan.subdirs.map(s => s.name)))
check('文本文件数 = 3（pdf 不计入正文件）', scan.totalFiles === 3, String(scan.totalFiles))
check('待转写清单含 pdf', scan.pendingTranscribe.length === 1 && scan.pendingTranscribe[0].ext === '.pdf')
check('抽取小标题', (scan.files.find(f => f.rel.includes('虚拟存储器'))?.headings || []).join('/') === '虚拟存储器/分页/分段')
check('子文件夹字符数 = 其内文件字符和', scan.subdirs.find(s => s.name === '内存管理').chars ===
  scan.files.filter(f => f.rel.startsWith('内存管理/')).reduce((n, f) => n + f.chars, 0))

console.log('\n[清点] 指纹 / markdown（纯函数）')
const fp1 = inventoryFingerprint(scan)
const md = buildInventoryMarkdown('操作系统资料', '考研/408 学习空间/操作系统', scan, fp1, '2026-10-11')
check('markdown 含指纹', md.includes(fp1))
check('markdown 含"待转写" pdf', md.includes('课本.pdf'))
check('markdown 声称已分类', md.includes('已分类'))
check('markdown 幂等（同输入同输出）', buildInventoryMarkdown('操作系统资料', '考研/408 学习空间/操作系统', scan, fp1, '2026-10-11') === md)
writeFileSync(join(MAT, '内存管理', '虚拟存储器.md'), '# 虚拟存储器\n## 分页\n改动后内容变长' + 'x'.repeat(200))
const scan2 = scanInventoryDir(MAT)
check('素材变动 → 指纹变化', inventoryFingerprint(scan2) !== fp1)

console.log('\n[清点] 落盘 SOURCES/{素材名}.index.md')
const w = writeInventoryIndex(WS, '操作系统资料', '考研/408 学习空间/操作系统', MAT, '2026-10-11')
check('写盘成功且 relPath 正确', w.ok && w.relPath === 'SOURCES/操作系统资料.index.md', JSON.stringify(w))
const idxAbs = join(WS, w.relPath || '')
check('索引文件确实存在', existsSync(idxAbs))
const idxText = existsSync(idxAbs) ? readFileSync(idxAbs, 'utf-8') : ''
check('索引内容含指纹与新统计', idxText.includes(w.fingerprint) && idxText.includes('待转写'))
check('missing 目录 → 报错不抛', (() => { const r = writeInventoryIndex(WS, 'x', 'nope', join(MAT, '不存在'), todayLocal()); return r.ok === false && !!r.error })())

console.log('\n[清点] 未分类目录')
rmSync(MAT, { recursive: true, force: true })
mkdirSync(MAT, { recursive: true })
writeFileSync(join(MAT, 'a.md'), '# a')
writeFileSync(join(MAT, 'b.md'), '# b')
check('平铺 → flat', scanInventoryDir(MAT).classification === 'flat')

rmSync(MAT, { recursive: true, force: true }); rmSync(WS, { recursive: true, force: true })
console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
