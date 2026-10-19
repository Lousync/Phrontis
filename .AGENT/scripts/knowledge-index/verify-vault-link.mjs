// 契约：仓库内相对链接解析（2026-10-19）
//
// 背景：知识页里点 `[README](../README.md)` 这类相对链接没反应，控制台报
//   `[Security] Blocked opening path outside data dir: ../README.md`
// 根因：PageEditor 的 onLinkClick 只按**标题**猜目标，猜不中就交给 window.api.openExternal；
//   主进程按自己的 cwd 解析相对路径，判为 userData 之外并拒绝。
// 修法：相对链接先按当前页目录归一成仓库相对路径，按 path 命中；都找不到就明确提示，
//   **绝不**再把相对路径交给系统打开（相对路径只在仓库语境里才有意义）。
//
// 覆盖：
//   ① resolveVaultRel 纯函数用例：相对 / 上跳 / 编码 / 反斜杠 / 锚点 / 越界
//   ② 源码接线：PageEditor 确实用这个函数；兜底分支不得再调 openExternal
//
// 运行（项目根目录）：
//   node --experimental-strip-types --no-warnings .AGENT/scripts/knowledge-index/verify-vault-link.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.cwd()
let pass = true
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' fail '} ${name}${extra ? `  [${extra}]` : ''}`)
  if (!ok) pass = false
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// ===== ① 纯函数用例 =====
console.log('\n--- ① resolveVaultRel：相对链接归一 ---')
const { resolveVaultRel } = await import('../../../src/lib/vaultLink.ts')

const CASES = [
  // [当前页, 链接, 期望]
  ['notes/a.md', '../README.md', 'README.md'],
  ['notes/a.md', 'b.md', 'notes/b.md'],
  ['notes/a.md', './sub/b.md', 'notes/sub/b.md'],
  ['a.md', 'b.md', 'b.md'],
  ['notes/a.md', '../other/c.md', 'other/c.md'],
  ['notes/a.md', 'sub/../../z.md', 'z.md'],            // 合法落回根下
  ['notes/a.md', '../README.md#sec', 'README.md'],     // 锚点不参与路径
  ['notes/a.md', 'x%20y.md', 'notes/x y.md'],          // URL 编码
  ['notes\\a.md', '..\\README.md', 'README.md'],       // Windows 分隔符
  // —— 以下一律 null ——
  ['a.md', '../x.md', null],                           // 越出仓库根（不夹回根）
  ['notes/a.md', '../../z.md', null],
  ['notes/a.md', '/etc/passwd', null],                 // 绝对路径
  ['notes/a.md', 'C:\\Windows\\x.md', null],           // 盘符
  ['notes/a.md', 'https://example.com', null],         // 协议
  ['notes/a.md', 'mailto:a@b.c', null],
  ['notes/a.md', '#anchor', null],                     // 纯锚点
  ['notes/a.md', '   ', null],
]
for (const [cur, href, want] of CASES) {
  const got = resolveVaultRel(cur, href)
  check(`${cur} + ${href}`, got === want, `${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`)
}

// ===== ② 源码接线 =====
console.log('\n--- ② PageEditor 接线 ---')
const pe = stripComments(read('src/modules/knowledge/components/PageEditor.tsx'))
check('PageEditor 引入 resolveVaultRel', /import\s*\{\s*resolveVaultRel\s*\}\s*from\s*'\.\.\/\.\.\/\.\.\/lib\/vaultLink'/.test(pe))
check('★ 按 path 精确命中（相对链接的第一优先）', /p\.path[^\n]*===\s*rel/.test(pe))
check('★ 兜底走 showToast（不再静默）', /找不到这个链接指向的页面/.test(pe))
// 负向：兜底里不得再出现「匹配不到 → openExternal(href)」的老写法
check('★ 负向：不再有 `else { openExternal(href) }` 的兜底',
  !/else\s*\{\s*openExternal\(href\)\s*\}/.test(pe))

console.log(pass ? '\nPASS —— 全部通过' : '\nFAIL —— 有用例未通过')
process.exit(pass ? 0 : 1)
