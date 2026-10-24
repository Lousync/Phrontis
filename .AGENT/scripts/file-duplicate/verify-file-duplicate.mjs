/**
 * B-34 契约：创建副本必须重写 frontmatter id（同 id 双文件 = 索引「后者跳过」的祸根）。
 *
 * 纯函数用例：`rewriteFrontmatterId`（src/lib/fileDuplicate.ts）——
 * 换行保持、跨行 id 不动、无 frontmatter / 无 id 返回 null。
 * 接线断言：duplicateWorkspaceFile 在 ws:copy 成功后必须对 .md 副本做 id 重写；
 * 非 .md / 复制失败不得触发重写。
 *
 * 用法：node .AGENT/scripts/file-duplicate/verify-file-duplicate.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`  [OK]   ${label}`); return }
  fails.push(label + (detail ? ` -> ${detail}` : ''))
  console.log(`  [FAIL] ${label}${detail ? '  —— ' + detail : ''}`)
}

// TS 源文件直接 import 会因类型标注炸掉 —— 只截取 rewriteFrontmatterId 函数体、剥类型标注后
// 落临时 .mjs 再 import（与其他纯函数契约同手法）
const srcPath = resolve(ROOT, 'src/lib/fileDuplicate.ts')
const src = readFileSync(srcPath, 'utf8')
const fnStart = src.indexOf('export function rewriteFrontmatterId')
const tail = fnStart >= 0 ? src.slice(fnStart) : ''
const fnEndMatch = /\r?\n\}\s*$/.exec(tail) // CRLF 容忍：Write 落盘可能是 \r\n
if (fnStart < 0 || !fnEndMatch) { console.error('  [FAIL] 源文件里找不到 rewriteFrontmatterId'); process.exit(1) }
const fnBody = tail.slice(0, fnEndMatch.index) + '\n}\n'
const fnSrc = fnBody.replace('(text: string, newId: string): string | null', '(text, newId)')
const tmpPath = resolve(ROOT, 'tmp/.verify-file-duplicate.mjs')
const { writeFileSync } = await import('node:fs')
writeFileSync(tmpPath, fnSrc, 'utf8')
const { rewriteFrontmatterId } = await import(pathToFileURL(tmpPath).href)

console.log('\n§1 rewriteFrontmatterId 纯函数')
{
  const r = rewriteFrontmatterId('---\nid: probe-note-surface\ntitle: 写作面探针\ntags: [探针]\n---\n\n# 正文\n', 'uuid-2')
  ok(r !== null && r.includes('id: uuid-2'), '单行 id 被替换', r?.slice(0, 60))
  ok(r !== null && r.includes('title: 写作面探针') && r.includes('tags: [探针]'), '其余 frontmatter 原样保留')
  ok(r !== null && r.endsWith('\n\n# 正文\n'), '正文原样保留')
  ok(r !== null && !r.includes('probe-note-surface'), '旧 id 不残留')
}
{
  const crlf = '---\r\nid: a\r\ntitle: t\r\n---\r\n\r\nbody\r\n'
  const r = rewriteFrontmatterId(crlf, 'b')
  ok(r !== null && r.includes('\r\n') && !r.includes('\r\n'.replace('\r\n', '\n')) === false && r.includes('id: b'), 'CRLF 文件换行风格保持', JSON.stringify(r?.slice(0, 30)))
}
ok(rewriteFrontmatterId('# 无 frontmatter\n正文', 'x') === null, '无 frontmatter → null')
ok(rewriteFrontmatterId('---\ntitle: 没有 id\n---\n正文', 'x') === null, '有 frontmatter 无 id → null（auto 兜底页不重写）')
ok(rewriteFrontmatterId('---\nid: >-\n  跨行\n---\n正文', 'x') === null, '跨行 id（块标量）→ null')
{
  const r = rewriteFrontmatterId('---\nid:   spaced-id\ntitle: t\n---\n', 'n')
  ok(r !== null && r.includes('id: n') && !r.includes('spaced-id'), '带空格的 id 行也能对齐替换')
}

console.log('\n§2 接线：duplicateWorkspaceFile 的 id 重写触发条件')
ok(/workspaceCopyFile\(rootId, relPath, dstRel\)\.then\(async \(r\)/.test(src), '复制成功后进入重写分支')
ok(/\.md\$\/i\.test\(r\.relPath\)/.test(src), '只对 .md 副本重写')
ok(/rewriteFrontmatterId\(read\.content, crypto\.randomUUID\(\)\)/.test(src), '新 id = crypto.randomUUID()')
ok(/catch \{ \/\* id 重写失败不阻塞副本创建/.test(src), '重写失败不阻塞副本创建（退回旧行为）')

import { unlinkSync } from 'node:fs'
try { unlinkSync(tmpPath) } catch { /* 尽力清理 */ }

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} ${pass} 项通过${fails.length ? `，${fails.length} 项未过` : ''}`)
for (const f of fails) console.log('  · ' + f)
process.exit(fails.length ? 1 : 0)
