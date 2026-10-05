/**
 * 契约验证：AI 助手「手册通道」N-1（docs/v3.4.0-feedback.md `N-1`）。
 *
 * A. 纯函数真实执行 —— strip-types import `electron/lib/manualChannelPure.ts`（零依赖），
 *    验 `hasOperationIntent` 的超集原则（操作词 → agent；纯用法问句 → 不命中）与常量。
 * B. 接线静态断言 —— 分类/分叉/升格/UI 徽标的四层接线，漏一处都是静默失效（点了没反应/不生效）。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-assistant/verify-manual-channel.mjs [仓库路径]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------- A. 纯函数
const PURE_REL = 'electron/lib/manualChannelPure.ts'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-verify-'))
const tmpFile = path.join(tmpDir, 'manualChannelPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(read(PURE_REL), { mode: 'strip' }))
const P = await import(pathToFileURL(tmpFile).href)

console.log('\n=== 1. hasOperationIntent：操作意图 → agent（超集原则）===')
for (const t of ['帮我建一篇笔记', '创建一条待办', '删掉那篇日记', '把今天的日记补上', '导出一下数据', '整理成一篇周报']) {
  check(`操作意图命中：${t}`, P.hasOperationIntent(t) === true, String(P.hasOperationIntent(t)))
}
console.log('\n=== 2. hasOperationIntent：纯用法问句不命中（→ 交 LLM 分类）===')
for (const t of ['知识库为什么看不到我的文件？', '怎么备份数据？', '快捷键有哪些？', 'AI 权限在哪设置？', '']) {
  check(`用法问句不命中：${t || '(空)'}`, P.hasOperationIntent(t) === false, String(P.hasOperationIntent(t)))
}

console.log('\n=== 3. 常量与提示词 ===')
check('MANUAL_CHANNEL_TOOL = builtin.help.search', P.MANUAL_CHANNEL_TOOL === 'builtin.help.search', P.MANUAL_CHANNEL_TOOL)
check('MANUAL_MAX_ROUNDS ≤ 3', P.MANUAL_MAX_ROUNDS <= 3, String(P.MANUAL_MAX_ROUNDS))
check('MANUAL_MAX_RESULT_CHARS = 6000', P.MANUAL_MAX_RESULT_CHARS === 6000, String(P.MANUAL_MAX_RESULT_CHARS))
check('FEW_SHOT 判例三类齐（manual/agent/tech）', ['manual', 'agent', 'tech'].every((k) => P.FEW_SHOT.some(([, a]) => a === k)), '')
check('手册提示词要求先检索 help.search', P.buildManualSystemPrompt().includes('builtin.help.search'), '')
check('手册提示词声明不执行操作', /不执行任何操作|不要调用写类工具/.test(P.buildManualSystemPrompt()), '')

// ---------------------------------------------------------------- B. 接线静态断言
console.log('\n=== 4. 主进程：分类 + 分叉 + 升格 ===')
const repo = stripComments(read('electron/lib/agentSessionRepo.ts'))
const svc = stripComments(read('electron/lib/agentService.ts'))
const tools = stripComments(read('electron/lib/builtinTools.ts'))
const bus = stripComments(read('electron/main/windowBus.ts'))
const chan = stripComments(read('electron/lib/manualChannel.ts'))
// N-1 三分类：tech（第三方软件 / 编程 / 通用技术问答）不再被误判成 manual
check('分类器提示词含第三类 tech + 第三方', chan.includes('tech') && chan.includes('第三方'), '')
check('分类解析认 tech 输出', chan.includes("return 'tech'"), '')
check('agentService 把 tech 归入通用助手（非 manual）', /intent === 'manual' \? 'manual' : 'agent'/.test(svc), '')
check('会话行加 mode 字段', /mode\?:\s*AgentSessionMode/.test(repo) || /mode\?:\s*'manual'\s*\|\s*'agent'/.test(repo), '')
check('导出 setSessionMode', repo.includes('export function setSessionMode'), '')
check('agentService 引用手册通道常量', svc.includes('MANUAL_CHANNEL_TOOL') && svc.includes('MANUAL_MAX_ROUNDS'), '')
check('buildToolsPayload 支持白名单参数', /buildToolsPayload\(sessionId,\s*manual\s*\?/.test(svc), '')
check('手册通道 system 走 buildManualSystemPrompt', svc.includes('buildManualSystemPrompt()'), '')
check('手册通道 effort 强制 off', /effort:\s*manual\s*\?\s*'off'/.test(svc), '')
check('首条消息分类调用 classifyManualIntent', svc.includes('classifyManualIntent('), '')
check('操作意图升格 setSessionMode(sessionId, \'agent\')', /setSessionMode\(sessionId,\s*'agent'\)/.test(svc), '')
check('升格广播 assistant notice', svc.includes('BROADCAST_CHANNEL.assistantNotice'), '')
check('help.search 结果附带 catalog', tools.includes('helpCatalog') && tools.includes('catalog: helpCatalog()'), '')

console.log('\n=== 5. 广播 / IPC 三层（onAssistantNotice）===')
check('windowBus 新增 assistantNotice 通道', bus.includes("assistantNotice: 'assistant:notice'"), '')
const preload = stripComments(read('electron/preload/index.ts'))
const types = stripComments(read('src/types/index.ts'))
const ipc = stripComments(read('src/lib/ipc.ts'))
for (const [name, src] of [['preload', preload], ['types', types], ['ipc', ipc]]) {
  check(`onAssistantNotice 存在于 ${name}`, src.includes('onAssistantNotice'), '')
}
check('AgentSessionInfo 加 mode 字段', /mode\?:\s*'manual'\s*\|\s*'agent'/.test(types), '')

console.log('\n=== 6. 渲染层：Toast + 会话徽标 ===')
const uc = stripComments(read('src/components/shared/AssistantPanel/useAssistantChat.ts'))
const side = stripComments(read('src/components/shared/AssistantPanel/AiChatSidebar.tsx'))
check('useAssistantChat 订阅 onAssistantNotice', uc.includes('onAssistantNotice('), '')
check('useAssistantChat 订阅回调里 showToast', /onAssistantNotice\([\s\S]{0,200}showToast/.test(uc), '')
check('会话列表按 mode 显示「使用帮助」徽标', side.includes("sess.mode === 'manual'") && side.includes('使用帮助'), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
