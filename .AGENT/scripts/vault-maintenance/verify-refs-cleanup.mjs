#!/usr/bin/env node
/**
 * 契约：坏附件引用清理（`.AGENT/scripts/vault-maintenance/clean-broken-attachment-refs.mjs`）。
 *
 * 失败模式：误删合法附件引用（图片消失）、把同一行的文字一起删掉、把 CRLF 改成 LF、
 * 只删图不删空行导致版面多出空段、重复运行不幂等。
 *
 * 运行：node --experimental-strip-types --no-warnings .AGENT/scripts/vault-maintenance/verify-refs-cleanup.mjs
 */

import { cleanText, isLegal } from './clean-broken-attachment-refs.mjs'

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

console.log('\n=== A. 合法性判据 ===')
ok('UUID 引用合法', isLegal('11111111-1111-4111-8111-111111111111/'))
ok('UUID + thumb 合法', isLegal('11111111-1111-4111-8111-111111111111/?thumb=1'))
ok('vault/ 引用合法', isLegal('vault/11111111-1111-4111-8111-111111111111/a.png'))
ok('裸文件名非法', !isLegal('image.png'))
ok('image2.png 非法', !isLegal('image2.png'))

console.log('\n=== B. Markdown 图片清理 ===')
const r1 = cleanText('看图 ![x](attachment://image.png) 结束')
eq('删掉坏引用', r1.text, '看图  结束')
eq('计数', r1.removed, 1)
eq('合法 UUID 引用保留', cleanText('![a](attachment://11111111-1111-4111-8111-111111111111/)').text, '![a](attachment://11111111-1111-4111-8111-111111111111/)')
eq('vault 引用保留', cleanText('![a](attachment://vault/11111111-1111-4111-8111-111111111111/a.png)').text, '![a](attachment://vault/11111111-1111-4111-8111-111111111111/a.png)')

console.log('\n=== C. 整行删除与空行收敛 ===')
const r2 = cleanText('A\n\n![x](attachment://image.png)\n\nB\n')
eq('整行删除且不留双空行', r2.text, 'A\n\nB\n')
const r3 = cleanText('A\n![x](attachment://image.png)\nB')
eq('上下都有文字时只删图片行', r3.text, 'A\nB')

console.log('\n=== D. CRLF 保留 ===')
const r4 = cleanText('A\r\n![x](attachment://image.png)\r\nB')
eq('CRLF 不被改成 LF', r4.text, 'A\r\nB')

console.log('\n=== E. HTML img ===')
const r5 = cleanText('前<img src="attachment://figure.png" alt="x" />后')
eq('HTML 坏图删除', r5.text, '前后')
eq('HTML 合法图保留', cleanText('<img src="attachment://11111111-1111-4111-8111-111111111111/" />').text, '<img src="attachment://11111111-1111-4111-8111-111111111111/" />')

console.log('\n=== F. 幂等 ===')
const first = cleanText('A\n![x](attachment://image.png)\nB')
const second = cleanText(first.text)
eq('第二次 removed=0', second.removed, 0)
eq('第二次内容不变', second.text, first.text)

console.log('')
if (fails.length === 0) {
  console.log(`PASS  ${pass}/${pass} 全部通过`)
  process.exit(0)
}
console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败`)
for (const f of fails) console.log('  - ' + f)
process.exit(1)
