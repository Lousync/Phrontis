#!/usr/bin/env node
/**
 * 契约验证：AI 面共用文案（`src/lib/aiCopy.ts`）单一真源 + 四个宿主的接线。
 *
 * 锁什么：
 *  1. 常量本身保留关键语义（视觉模型名 / 不消耗 token / 降级规则 / 已完成轮次保留）；
 *  2. AI 教学、AI 助手、AI 学堂、助手面板、设置页都从 `aiCopy` 取文案，不再各写一份；
 *  3. 旧字面量不再出现在宿主源码里（漏改一处就会被这里拦住）；
 *  4. 对话模式左栏底部的「不建课 · 每个对话一个文件夹」已删除（无文件夹时整块不渲染）。
 *
 * 运行（仓库根目录）：node .AGENT/scripts/ai-teaching/verify-ai-copy.mjs [仓库路径]
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

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) pass += 1
  else fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  [${detail}]` : ''}`)
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/* ---------------------------------------------------------------- 1. 常量文件 */
const src = read('src/lib/aiCopy.ts')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-copy-'))
const tmpFile = path.join(tmpDir, 'aiCopy.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const copy = await import(pathToFileURL(tmpFile).href)

console.log('\n=== 1. aiCopy 常量 ===')
check('IMAGE_MODEL_TITLE', copy.IMAGE_MODEL_TITLE === '当前模型不支持图片输入', String(copy.IMAGE_MODEL_TITLE))
check('IMAGE_MODEL_HINT keeps model names', String(copy.IMAGE_MODEL_HINT).includes('vision / vl / 4o / glm-4v'))
check('IMAGE_MODEL_WARN = title + hint', String(copy.IMAGE_MODEL_WARN).includes(copy.IMAGE_MODEL_TITLE) && String(copy.IMAGE_MODEL_WARN).includes(copy.IMAGE_MODEL_HINT))
check('IMAGE_MODEL_SHORT', copy.IMAGE_MODEL_SHORT === '当前模型不支持图片')
check('PERCEPTION_DESC keeps no-token promise', String(copy.PERCEPTION_DESC).includes('不消耗对话 token'))
check('PERCEPTION_DESC keeps downgrade rule', String(copy.PERCEPTION_DESC).includes('未配置向量模型时自动降级'))
check('COMPRESSING_INLINE has no parenthetical', copy.COMPRESSING_INLINE === '正在压缩对话历史…', String(copy.COMPRESSING_INLINE))
check('COMPRESSING_TIP', copy.COMPRESSING_TIP === '正在压缩对话历史，请稍候')
check('COMPRESSING_TOAST', copy.COMPRESSING_TOAST === '正在压缩对话历史，请稍候再发送')
check('STOP_RUN_TIP keeps completed-rounds wording', copy.STOP_RUN_TIP === '停止生成（已完成的轮次保留）')

/* ---------------------------------------------------------------- 2. 宿主接线 */
const HOSTS = {
  chat: 'src/components/shared/AssistantPanel/ChatBody.tsx',
  panel: 'src/components/shared/AssistantPanel/index.tsx',
  hook: 'src/components/shared/AssistantPanel/useAssistantChat.ts',
  teach: 'src/modules/ai-teaching/index.tsx',
  assistant: 'src/modules/ai-assistant/index.tsx',
  learn: 'src/components/shared/AiLearn/index.tsx',
  settings: 'src/lib/settings.ts',
  tools: 'src/modules/settings/views/AiToolsView.tsx',
}
const code = Object.fromEntries(Object.entries(HOSTS).map(([k, rel]) => [k, read(rel)]))
const needImport = (key, names) => {
  const m = /import\s*\{([^}]*)\}\s*from\s*'[^']*aiCopy'/.exec(code[key])
  const got = m ? m[1] : ''
  const missing = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(got))
  check(`${key} imports from aiCopy`, !missing.length, missing.join(','))
  const used = names.filter((n) => new RegExp(`\\b${n}\\b`).test(code[key]))
  check(`${key} uses all imported constants`, used.length === names.length, names.filter((n) => !used.includes(n)).join(','))
}

console.log('\n=== 2. 四个宿主统一引用 ===')
needImport('chat', ['IMAGE_MODEL_TITLE', 'IMAGE_MODEL_HINT', 'IMAGE_MODEL_WARN', 'IMAGE_MODEL_SHORT', 'COMPRESSING_INLINE', 'STOP_RUN_TIP', 'PERCEPTION_DESC'])
needImport('panel', ['PERCEPTION_DESC'])
needImport('hook', ['COMPRESSING_TOAST'])
needImport('teach', ['IMAGE_MODEL_TITLE', 'IMAGE_MODEL_HINT', 'IMAGE_MODEL_SHORT', 'IMAGE_MODEL_WARN', 'COMPRESSING_INLINE', 'STOP_RUN_TIP'])
needImport('assistant', ['COMPRESSING_INLINE', 'COMPRESSING_TIP', 'STOP_RUN_TIP'])
needImport('learn', ['STOP_RUN_TIP'])
needImport('settings', ['PERCEPTION_DESC'])
needImport('tools', ['PERCEPTION_DESC'])

/* ---------------------------------------------------------------- 3. 旧字面量清零 */
console.log('\n=== 3. 旧字面量不再散落在宿主 ===')
const LEGACY = [
  ['正在压缩对话历史…（', 'inline parenthetical'],
  ['停止生成（已完成的轮次保留）', 'stop tip literal'],
  ['当前模型不支持图片输入。请在模型菜单', 'image bar literal'],
  ['不建课 · 每个对话一个文件夹', 'tutor footer fallback'],
]
for (const [needle, label] of LEGACY) {
  const hits = Object.entries(code).filter(([, s]) => s.includes(needle)).map(([k]) => k)
  check(`no legacy ${label}`, hits.length === 0, hits.join(','))
}

console.log('\n=== 4. 对话模式底部说明 ===')
check('footer block is conditional on tutorFolder', /\{tutorFolder && \(/.test(code.teach))
check('footer only renders the path', /data-tip=\{tutorFolder\}>/.test(code.teach))

/* ---------------------------------------------------------------- 5. 第二批字面量 */
console.log('\n=== 5. 第二批：叫法统一与单文件清理 ===')
const B2 = {
  chat: code.chat,
  entry: read('src/components/shared/AssistantPanel/AssistantEntry.tsx'),
  assistant: code.assistant,
  learn: code.learn,
  teach: code.teach,
  draft: read('src/modules/ai-teaching/right-viewer/AskDraftPane.tsx'),
  models: read('src/modules/settings/views/AiModelsTab.tsx'),
  quiz: read('src/components/shared/QuizReviewPane.tsx'),
  tree: read('src/modules/ai-teaching/AiTeachFileTree.tsx'),
}
const LEGACY2 = [
  ['仅本任务生效', 'assistant task wording'],
  ['只对本对话生效', 'assistant entry wording'],
  ['· 本轮显式生效', 'skill suffix'],
  ['点击条目跳转', 'assistant outline footer'],
  ['·发送时并入消息', 'context chip variant'],
  ['提问时按当前所在界面自动判断', 'context chip parenthetical'],
  ['这里是完整对话区', 'AI learn empty state'],
  ['只显示当前题单判错的题', 'quiz review explanation'],
]
for (const [needle, label] of LEGACY2) {
  const hits = Object.entries(B2).filter(([, s]) => s.includes(needle)).map(([k]) => k)
  check(`batch2 no legacy ${label}`, hits.length === 0, hits.join(','))
}
check('batch2 assistant uses 本会话 scope', B2.assistant.includes('仅本会话生效'))
check('batch2 assistant entry uses 本会话', B2.entry.includes('仅本会话'))
check('batch2 skill suffix is 本轮', /Skill：\{pickedSkill\.title\} · 本轮/.test(B2.teach) && /Skill：\{pickedSkill\.title\} · 本轮/.test(B2.chat))
check('batch2 ask draft keeps closing notice', B2.draft.includes('关掉不留记录'))
check('batch2 ask draft mentions save once', (B2.draft.match(/发出后才会保存/g) || []).length === 1)
check('batch2 opencode notes are a collapsed block', B2.models.includes('OpencodeEndpointNotes') && B2.models.includes('关于 opencode 地址'))
check('batch2 opencode HelpHint keeps only actionable half', B2.models.includes('按对话覆盖：填任何非空值即可。') && (B2.models.match(/实际发送的是当前对话的 ID。/g) || []).length === 1)
check('batch2 quiz review keeps key behavior', B2.quiz.includes('参考答案默认收起'))
check('batch2 file tree empty state is one line', B2.tree.includes('还没有产物 · 新建对话'))

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
console.log(`\nPASS -- ${pass}/${pass + fail} assertions passed`)
process.exit(fail > 0 ? 1 : 0)
