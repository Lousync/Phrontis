#!/usr/bin/env node
/**
 * 契约验证：AI教学「旁问作用域」纯函数（`electron/lib/sideLanePure.ts`）
 * 方案：`/home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/Phrontis-AI教学-技术方案-2026-11-19.md` §2.11 / §4.5 / §6.4 / §9
 *       + 内核文档 C8 / C9 / C10 / C11。
 *
 * 断言口径（全部跑真实实现，strip 类型后直接 import）：
 *   · `normalizeSideScope` 三合法值 + 非法输入默认 anchor（负向）；
 *   · 两档 discipline 的关键约束词（不锁全文）；
 *   · 整段转录：单条截断 / 总量上限 / omitted / 正序 / 空数组；
 *   · `estimatePromptChars` 单调不减且 conversation 含转录；
 *   · 不修改入参。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-side-scope.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const ascii = (s) => String(s === undefined ? '' : s).replace(/[^\x20-\x7e]/g, '?')
const clone = (v) => structuredClone(v)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const REL = 'electron/lib/sideLanePure.ts'
const TYPES_REL = 'electron/lib/aiTeachingTypesPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const typesSrc = fs.readFileSync(path.join(ROOT, TYPES_REL), 'utf8')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-scope-'))
fs.writeFileSync(
  path.join(tmpDir, 'aiTeachingTypesPure.mjs'),
  stripTypeScriptTypes(typesSrc, { mode: 'strip' })
)
const stripped = stripTypeScriptTypes(src, { mode: 'strip' }).replace(
  /(from\s+['"])\.\/aiTeachingTypesPure(['"])/g,
  '$1./aiTeachingTypesPure.mjs$2'
)
const tmpFile = path.join(tmpDir, 'sideLanePure.mjs')
fs.writeFileSync(tmpFile, stripped)
const {
  normalizeSideScope,
  sideLaneModePrompt,
  buildConversationTranscript,
  estimatePromptChars,
} = await import(pathToFileURL(tmpFile).href)

/* ---------------------------------------------------------------- 1. 归一 */
console.log('\n=== 1. normalizeSideScope ===')
check('keeps conversation', normalizeSideScope('conversation') === 'conversation')
check('keeps anchor', normalizeSideScope('anchor') === 'anchor')
check('keeps selection', normalizeSideScope('selection') === 'selection')
check('NEGATIVE: undefined -> anchor (legacy default)', normalizeSideScope(undefined) === 'anchor')
check('NEGATIVE: null -> anchor', normalizeSideScope(null) === 'anchor')
check('NEGATIVE: empty string -> anchor', normalizeSideScope('') === 'anchor')
check('NEGATIVE: wrong case -> anchor', normalizeSideScope('Conversation') === 'anchor')
check('NEGATIVE: number -> anchor', normalizeSideScope(42) === 'anchor')
check('NEGATIVE: object -> anchor', normalizeSideScope({ scope: 'anchor' }) === 'anchor')

/* ---------------------------------------------------------------- 2. 提示 */
console.log('\n=== 2. sideLaneModePrompt ===')
const conversation = sideLaneModePrompt('conversation')
const anchor = sideLaneModePrompt('anchor')
const selection = sideLaneModePrompt('selection')

check('conversation header says whole conversation', conversation.header === '已读整段对话')
check('conversation discipline re-reads main transcript', conversation.discipline.includes('重新读取主对话'))
check('conversation discipline mentions this/just-now pointing to main chat', conversation.discipline.includes('「这个」') && conversation.discipline.includes('主对话'))
check('conversation discipline forbids write-back', conversation.discipline.includes('不写回'))
check('conversation discipline forbids quiz generation', conversation.discipline.includes('不出题'))
check('conversation discipline skips global memory', conversation.discipline.includes('不读全局记忆'))
check('conversation discipline forbids file writes', conversation.discipline.includes('不改任何文件'))

check('anchor header is a caller-filled N template', anchor.header.includes('锚定') && anchor.header.includes('N'))
check('anchor discipline limits to three sentences', anchor.discipline.includes('三句'))
check('anchor discipline stays on the anchored point', anchor.discipline.includes('被追问的那一点') && anchor.discipline.includes('不重讲主线'))
check('anchor discipline forbids write-back', anchor.discipline.includes('不写回'))
check('anchor discipline forbids quiz generation', anchor.discipline.includes('不出题'))
check('anchor discipline forbids file writes', anchor.discipline.includes('不改任何文件'))

check('selection header names selected text', selection.header.includes('选中'))
check('selection discipline scopes to selected text', selection.discipline.includes('选中的这段文字') && selection.discipline.includes('不扩展话题'))
check('selection discipline forbids write-back and quiz', selection.discipline.includes('不写回') && selection.discipline.includes('不出题'))
check('unknown scope prompt falls back to anchor', same(sideLaneModePrompt('bogus'), anchor))

/* ---------------------------------------------------------------- 3. 转录 */
console.log('\n=== 3. buildConversationTranscript ===')
const empty = buildConversationTranscript([])
check('empty messages -> empty text and zero omitted', empty.text === '' && empty.omitted === 0)

const long = 'x'.repeat(7000)
const truncated = buildConversationTranscript([{ role: 'user', content: long }])
check('single long message is truncated to maxPerMsg (6000)', truncated.text.length === '学习者：'.length + 6000)
check('single message truncation keeps the tail', truncated.text.endsWith('x'.repeat(100)) && truncated.omitted === 0)

const custom = buildConversationTranscript([{ role: 'user', content: 'abcdefghijklmnop' }], { maxPerMsg: 10 })
check('custom maxPerMsg is honoured', custom.text.endsWith('ghijklmnop') && custom.text.length === '学习者：'.length + 10)

const ordered = buildConversationTranscript([
  { role: 'user', content: 'AAA' },
  { role: 'assistant', content: 'BBB' },
])
check('output is chronological with learner/mentor labels', ordered.text === '学习者：AAA\n\n导师：BBB')

const many = Array.from({ length: 10 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `${i}:` + 'x'.repeat(4996),
}))
const manySnap = clone(many)
const capped = buildConversationTranscript(many, { maxTotal: 12000, maxPerMsg: 6000 })
check('total cap stops accumulation and reports omitted', capped.omitted > 0 && capped.omitted === 7)
check('total cap keeps the newest messages', capped.text.includes('9:') && capped.text.includes('8:'))
check('omitted prefix line is present', capped.text.startsWith('（更早的 messages 已省略）'))
check('earliest messages are excluded', !capped.text.includes('0:') && !capped.text.includes('1:'))
check('buildConversationTranscript does not mutate input', same(many, manySnap))

const partial = buildConversationTranscript(
  Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `${i}:`.padEnd(100, 'y') })),
  { maxTotal: 250, maxPerMsg: 1000 }
)
check('partially included oldest kept message is not counted as omitted', partial.omitted === 2 && partial.text.includes('（更早的 messages 已省略）'))

/* ---------------------------------------------------------------- 4. 估算 */
console.log('\n=== 4. estimatePromptChars ===')
const conversationBase = conversation.discipline.length
const anchorBase = anchor.discipline.length
check('conversation includes transcript length', estimatePromptChars('conversation', { text: 'x'.repeat(100) }) === conversationBase + 100)
check('anchor ignores transcript length', estimatePromptChars('anchor', { text: 'x'.repeat(9999) }) === anchorBase)
check('selection ignores transcript length', estimatePromptChars('selection', { text: 'x'.repeat(9999) }) === selection.discipline.length)

const sizes = [0, 100, 5000].map((n) => estimatePromptChars('conversation', { text: 'x'.repeat(n) }))
check(
  'estimate grows monotonically with transcript',
  sizes[0] <= sizes[1] && sizes[1] <= sizes[2] && sizes[2] > sizes[0]
)
check(
  'conversation estimate exceeds anchor for same transcript',
  estimatePromptChars('conversation', { text: 'x'.repeat(100) }) > estimatePromptChars('anchor', { text: 'x'.repeat(100) })
)
check('unknown scope estimate falls back to anchor', estimatePromptChars('bogus', { text: 'xxxx' }) === anchorBase)

/* ---------------------------------------------------------------- 报告 */
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${!c.pass && c.detail ? '  -> ' + ascii(c.detail) : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} - ${checks.length - failed.length}/${checks.length} assertions passed`)

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* temp dir cleanup is best-effort */
}
process.exit(failed.length === 0 ? 0 : 1)
