/**
 * 契约验证：博文编辑器必须走共享 MonacoPane（弃用受控 value），防「中文输入光标跳文末 / 乱字」回归。
 * 背景（缺陷链与修法）见 .AGENT/scripts/workbench-shell/probes/probe-caret-sync.mjs 头注。
 * 运行（项目根目录）：node .AGENT/scripts/blog-tools/verify-blog-editor-caret.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const REL = 'src/modules/blog/components/MarkdownEditor.tsx'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })

check('博文编辑器 import 共享 MonacoPane', /components\/shared\/MonacoPane/.test(src))
check('不再直接 import @monaco-editor/react', !src.includes("from '@monaco-editor/react'"))
check('不再使用受控 value（<Editor value={…}）', !/<Editor[\s\S]{0,200}?\bvalue=\{/.test(src))
check('不再手写 handleEditorMount 粘贴/拖拽监听', !src.includes('handleEditorMount'))
check('图片粘贴/拖拽改走 onPasteImage/onDropImage', src.includes('onPasteImage') && src.includes('onDropImage'))

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)
process.exit(failed.length === 0 ? 0 : 1)
