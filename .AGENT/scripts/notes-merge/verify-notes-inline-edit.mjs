/**
 * 契约：笔记合并 Phase 1 —— 知识库就地编辑（docs/notes-merge-phase1-design.md §1.1/§4）
 *
 * 锁三件事：
 *   ① frontmatter 拆装共享层（src/lib/frontmatter.ts）roundtrip 无损，editor/types.ts 只是 re-export；
 *   ② PageEditor 的 vault 保存分支只允许 workspaceWriteFile 写路径（joinFrontmatter + mtime 基线），
 *      严禁复活 pre-R6 的 updateKnowledgePage / updateKnowledgeLinks（后者在 vault 模式被
 *      DB-only 白名单拒绝，knowledgeRepo.ts:201）；
 *   ③ 就地编辑解锁：Monaco 不再 readOnly={vaultMode}，Ctrl+E / Ctrl+/ 均可切换。
 *
 * 跑法：node --experimental-strip-types .AGENT/scripts/notes-merge/verify-notes-inline-edit.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { splitFrontmatter, joinFrontmatter } from '../../../src/lib/frontmatter.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n')

let pass = 0
let fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  PASS ' + name) } else { fail++; console.log('  FAIL ' + name) } }

// ---- ① frontmatter 共享层 ----
console.log('[1] frontmatter 共享层')
{
  const raw = '---\nid: kb-abc\ntitle: 存储层改造\nstatus: draft\n---\n\n# 正文标题\n\n内容 [[双链]]。'
  const fm = splitFrontmatter(raw)
  ok(fm !== null, 'splitFrontmatter 识别 --- 包裹前缀')
  ok(fm && fm.prefix === '---\nid: kb-abc\ntitle: 存储层改造\nstatus: draft\n---\n', '前缀原样保留（含换行形态）')
  ok(fm && fm.body.startsWith('\n# 正文标题'), '正文从闭合行后开始')
  ok(fm && joinFrontmatter({ frontmatterPrefix: fm.prefix, content: fm.body }) === raw, 'prefix+body roundtrip 无损')
  const crlf = '---\r\nid: kb-abc\r\n---\r\n\r\n正文'
  const fm2 = splitFrontmatter(crlf)
  ok(fm2 && fm2.prefix === '---\r\nid: kb-abc\r\n---\r\n' && fm2.body === '\r\n正文', 'CRLF 前缀同样原样保留')
  ok(splitFrontmatter('无 frontmatter 的纯文本') === null, '无 frontmatter → null')
  ok(joinFrontmatter({ content: '正文' }) === '正文', '无前缀 join = 原样')
  const types = read('src/modules/editor/types.ts')
  ok(/export \{ splitFrontmatter, joinFrontmatter \}/.test(types) && !/export function splitFrontmatter/.test(types), 'editor/types.ts 为 re-export，不再持有实现')
}

// ---- ② vault 保存分支只走 workspaceWriteFile ----
console.log('[2] vault 保存分支写路径')
{
  const pe = read('src/modules/knowledge/components/PageEditor.tsx')
  const m = pe.match(/if \(vaultModeRef\.current\) \{[\s\S]*?\n    \}\n/) // doSave 的 vault 分支（到分支收口）
  ok(m !== null, '定位到 doSave 的 vault 分支')
  const branch = m ? m[0] : ''
  ok(branch.includes('workspaceWriteFile'), 'vault 分支走 workspaceWriteFile（与编辑器同一条写路径）')
  ok(branch.includes('joinFrontmatter'), 'frontmatter 前缀拼回')
  ok(branch.includes('vaultMtimeRef'), 'mtime 冲突基线（装载时记录）')
  ok(!branch.includes('updateKnowledgePage'), '负向：vault 分支不得调用 updateKnowledgePage（pre-R6 写路径）')
  ok(!branch.includes('updateKnowledgeLinks'), '负向：vault 分支不得调用 updateKnowledgeLinks（DB-only 白名单拒绝）')
  ok(branch.includes('res?.conflict'), '外部修改冲突分支存在（不静默覆盖）')
}

// ---- ③ 就地编辑解锁 ----
console.log('[3] 就地编辑解锁')
{
  const pe = read('src/modules/knowledge/components/PageEditor.tsx')
  ok(!pe.includes('readOnly: vaultMode'), '负向：Monaco 不得再 readOnly={vaultMode}')
  ok(pe.includes('readOnly: false'), 'Monaco 就地可编辑')
  ok(/e\.key === '\/'\) \|\| \(e\.ctrlKey && \(e\.key === 'e' \|\| e\.key === 'E'\)\)/.test(pe), 'Ctrl+E 与 Ctrl+/ 均为阅读/编辑切换')
  ok(!/if \(vaultModeRef\.current\) return\s+\/\/ 仓库文件模式：固定阅读视图/.test(pe), '负向：Ctrl+/ 不再被 vaultMode 拦截')
  ok(pe.includes('loadVaultBaseline'), '装载时缓存 frontmatter 前缀 + mtime 基线')
}

// ---- ④ P1b：共享 MonacoPane 宿主 ----
console.log('[4] 共享 MonacoPane 宿主（P1b）')
{
  const shared = read('src/components/shared/MonacoPane.tsx')
  const shim = read('src/modules/editor/components/MonacoPane.tsx')
  const pe = read('src/modules/knowledge/components/PageEditor.tsx')
  ok(shared.includes("'../../lib/monaco-setup'") && shared.includes('installInlineCompletion'), '共享层持有 B4 provider 装配（内联建议随宿主带入知识库）')
  ok(shared.includes('addInlineSuggestBusyListener') && shared.includes('inlineBusyListeners = new Set'), 'busy/暂停监听为多宿主注册表（keep-alive 双宿主共存不互相覆盖）')
  ok(shared.includes('modelPath') && shared.includes('relPathByModel'), 'modelPath 命名空间 + relPath 记账（跨模块不共享 Monaco model，内联建议仍拿真实路径）')
  ok(/export \{ MonacoPane/.test(shim) && !/interface Props/.test(shim), 'editor 旧路径为 re-export shim，不再持有实现')
  ok(pe.includes("from '../../../components/shared/MonacoPane'"), 'PageEditor 消费共享宿主')
  ok(pe.includes('kb://knowledge/'), '知识库文档走命名空间 modelPath')
  ok(pe.includes('onDropImage={handleImageToMarkdown}') && pe.includes('onPasteImage={handleImageToMarkdown}'), '粘贴与拖图拦截接入共享宿主')
  ok(shared.includes('focus(): void') && shared.includes('getEditor():'), '句柄含 focus/getEditor（脚注/插图/大纲沿用）')
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
