/**
 * 统一 AI 助手（v3.11.0）契约。
 *
 * 这次改动的失败模式几乎都不报错：
 *  · 旧 aiAssistant 会话迁移后把空 scope 当整仓 → 静默扩权；
 *  · confirm 模式仍有写工具直接落盘 → 用户没确认的改动进了仓库；
 *  · 非统一会话被 scopeAll 语义误伤 → AI 教学 / 日程突然读不到文件；
 *  · 右侧栏和工作区各自维护会话 → 同一句话两边看不到。
 *
 * 所以本脚本锁三件事：迁移纯函数、确认模式工具白名单、三宿主共享控制器接线。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-unified-assistant.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeSessionFields } from '../../../electron/lib/agentSessionNormalizePure.ts'
import {
  HANDLER_STAGED_TOOLS, STAGEABLE_WRITE_TOOLS, isConfirmModeHiddenTool, isHandlerStagedTool, isStageableWriteTool,
} from '../../../electron/lib/aiAssistantStageable.ts'
import { selectOps, actionForOp } from '../../../electron/lib/aiAssistantPlanPure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')
let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. 会话迁移纯函数 ===')
{
  const legacy = { source: 'aiAssistant', scope: ['A'] }
  ok(normalizeSessionFields(legacy) === true, 'A1 旧 aiAssistant 需要迁移')
  ok(legacy.source === 'assistant', 'A2 旧 aiAssistant 来源归一为 assistant')
  ok(legacy.scopeAll === false && legacy.writeMode === 'confirm', 'A3 旧 aiAssistant 保留严格 scope + 确认模式')
  ok(Array.isArray(legacy.scope) && legacy.scope[0] === 'A', 'A4 旧路径作用域不丢')

  const legacyEmpty = { source: 'aiAssistant', scope: [] }
  normalizeSessionFields(legacyEmpty)
  ok(legacyEmpty.scopeAll === false, 'A5 旧 aiAssistant 空 scope 仍是严格模式（不能扩成整仓）')

  const normal = { source: 'assistant' }
  normalizeSessionFields(normal)
  ok(normal.scopeAll === true && normal.writeMode === 'direct', 'A6 旧通用助手默认整仓 + 直接执行')
  ok(Array.isArray(normal.scope) === false, 'A7 整仓不强行写 scope 字段（读取侧按空处理）')

  const narrowed = { source: 'assistant', scope: ['A/B'] }
  normalizeSessionFields(narrowed)
  ok(narrowed.scopeAll === false && narrowed.writeMode === 'confirm', 'A8 有路径无 scopeAll 的旧数据按缩窄 + 确认')

  const teaching = { source: 'aiTeaching', scope: ['A'] }
  ok(normalizeSessionFields(teaching) === false && teaching.source === 'aiTeaching' && teaching.scopeAll === undefined,
    'A9 AI 教学 / 日程不被统一迁移误伤')

  const once = { source: 'aiAssistant', scope: ['A'] }
  normalizeSessionFields(once)
  const snapshot = JSON.stringify(once)
  ok(normalizeSessionFields(once) === false && JSON.stringify(once) === snapshot, 'A10 迁移幂等')
}

console.log('\n=== B. 确认模式工具白名单 ===')
ok(HANDLER_STAGED_TOOLS.has('builtin.vault.write') && isHandlerStagedTool('builtin.vault.edit'), 'B1 vault 四工具由 handler 自暂存')
ok(STAGEABLE_WRITE_TOOLS.has('builtin.knowledge.create-page') && isStageableWriteTool('builtin.knowledge.create-page'),
  'B2 知识库建页可暂存')
ok(isStageableWriteTool('builtin.quiz.tag') && isStageableWriteTool('builtin.accounting.import-json'),
  'B3 错题本 / 记账写工具可暂存')
ok(!isStageableWriteTool('builtin.terminal.exec'), 'B4 终端不可预览')
ok(isConfirmModeHiddenTool('builtin.terminal.exec', 'write'), 'B5 确认模式隐藏终端')
ok(isConfirmModeHiddenTool('builtin.schedule.create-todo', 'write'), 'B6 确认模式隐藏日程写入')
ok(!isConfirmModeHiddenTool('builtin.knowledge.create-page', 'write'), 'B7 可暂存工具不被确认模式隐藏')

console.log('\n=== C. 变更方案支持工具 op ===')
{
  const tool = { id: 't1', kind: 'tool', tool: 'builtin.knowledge.create-page', status: 'pending', args: { title: 'x' } }
  ok(actionForOp(tool, 'apply') === null && actionForOp(tool, 'rollback') === null, 'C1 tool op 不产生文件动作')
  ok(selectOps([tool], ['t1'], 'apply').length === 1, 'C2 tool op 可被采纳')
  const applied = { ...tool, status: 'applied' }
  ok(selectOps([applied], [], 'rollback').length === 1, 'C3 已应用 tool op 进入回滚候选（由 fs 层跳过并计数）')
}

console.log('\n=== D. 主进程接线 ===')
{
  const repo = read('electron/lib/agentSessionRepo.ts')
  const svc = read('electron/lib/agentService.ts')
  const tools = read('electron/lib/aiTools.ts')
  const builtin = read('electron/lib/builtinTools.ts')
  const plan = read('electron/lib/aiAssistantPlan.ts')
  ok(/normalizeSessionFields/.test(repo), 'D1 会话读路径调用统一迁移')
  ok(/scopeAll:\s*!legacyAiAssistant/.test(repo) && /writeMode:\s*legacyAiAssistant\s*\?\s*'confirm'\s*:\s*'direct'/.test(repo),
    'D2 新会话默认整仓 + 直接执行（兼容入口才 confirm）')
  ok(/updateAgentSessionPreferences/.test(repo) && /writeMode/.test(repo) && /modelId/.test(repo) && /effort/.test(repo),
    'D3 会话级写入方式 / 模型 / 思考强度落库函数')
  ok(/scopeAll/.test(svc) && /writeMode/.test(svc) && /aiPropose/.test(svc), 'D4 AgentRunner 读取 scopeAll + writeMode')
  ok(/scheduleReadOnly:\s*unifiedAssistant/.test(svc) && /confirmMode:\s*aiPropose/.test(svc),
    'D5 工具面按确认模式 / 日程只读过滤')
  ok(/isWithinVaultScope\(String\(r\.path\), aiScope\)/.test(svc), 'D6 缩窄作用域过滤越界附件')
  ok(/perceptionOn[\s\S]{0,120}unifiedAssistant\s*&&\s*!scopeAll/.test(svc), 'D7 缩窄作用域关闭感知检索')
  ok(/stagedResult/.test(svc), 'D8 暂存结果不进「本次改动」清单')
  ok(/stageOp\(ctx\.sessionId/.test(tools) && /isStageableWriteTool/.test(tools) && /tempId/.test(tools),
    'D9 通用暂存层：白名单 + 临时 id')
  ok(/await import\('\.\/aiTools'\)/.test(plan) && /op\.kind === 'tool'/.test(plan) && /skipped/.test(plan),
    'D10 工具 op 应用 + 不可回滚计数')
  ok(/ctx\?\.unifiedAssistant\s*&&\s*t\.module === 'schedule'/.test(builtin),
    'D11 tool.request 拒绝统一助手内的日程写工具')
  ok(/ctx\?\.propose\s*&&\s*isConfirmModeHiddenTool/.test(builtin),
    'D12 tool.request 拒绝确认模式下不可预览的写工具')
}

console.log('\n=== E. 作用域严格语义 ===')
{
  const scope = read('electron/lib/aiAssistantScope.ts')
  ok(/ctx\?\.scopeAll === true\) return undefined/.test(scope), 'E1 整仓 = 不限制')
  ok(/ctx\?\.scopeAll === false\) return scope/.test(scope), 'E2 缩窄 = 严格返回数组（含空数组）')
  ok(/scope\.length === 0\) return \(\) => false/.test(scope), 'E3 空数组读谓词全部拒绝（不再沿用「空=全库」）')
  ok(/scope\.length === 0\) return false/.test(scope), 'E4 空数组写全部拒绝')
  ok(/hasScope && isWithinVaultScope/.test(scope), 'E5 空作用域清单不列出全库页面')
}

console.log('\n=== F. IPC 三处同步 ===')
{
  const preload = read('electron/preload/index.ts')
  const types = read('src/types/index.ts')
  const ipc = read('src/lib/ipc.ts')
  for (const ch of ['agentSetSessionPrefs', 'agentSetSessionScope']) {
    ok(preload.includes(ch), `F preload 暴露 ${ch}`)
    ok(types.includes(ch), `F types 声明 ${ch}`)
    ok(ipc.includes(ch), `F ipc 封装 ${ch}`)
  }
  ok(/scopeAll\?:\s*boolean/.test(types) && /writeMode\?:\s*'direct'\s*\|\s*'confirm'/.test(types),
    'F AgentSessionInfo 带 scopeAll / writeMode')
}

console.log('\n=== G. 三宿主共享控制器 ===')
{
  const hook = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
  const chat = read('src/components/shared/AssistantPanel/ChatBody.tsx')
  const workspace = read('src/modules/ai-assistant/useAiAssistant.ts')
  const mod = read('src/modules/ai-assistant/index.tsx')
  ok(/unified = options\.unified !== false && !sessionSource/.test(hook), 'G1 统一控制器（日程助手自动关闭）')
  ok(/scopeAll/.test(hook) && /setScopeAll/.test(hook) && /setWriteMode/.test(hook), 'G2 控制器暴露作用域 / 写入方式')
  ok(/agentSetSessionScope/.test(hook) && /agentSetSessionPrefs/.test(hook), 'G3 控制器落库会话级设置')
  ok(/aiAssistantPlanGet/.test(hook) && /aiAssistantPlanApply/.test(hook) && /aiAssistantPlanReject/.test(hook),
    'G4 控制器收口变更方案')
  ok(/sanitize|unifiedContextOf/.test(hook) && /scopeAll/.test(hook) && /writeMode/.test(hook), 'G5 每轮请求携带作用域 / 写入方式')
  ok(/ScopePane/.test(chat) && /ReviewPane/.test(chat) && /writeMode/.test(chat), 'G6 右侧栏接入文件树 / 写入方式 / 预览')
  const review = read('src/modules/ai-assistant/ReviewPane.tsx')
  ok(/compact\?: boolean/.test(review) && /renderSideBySide:\s*!compact/.test(review),
    'G6b 窄宿主用单栏 diff（避免固定 236px 清单把 diff 挤成黑条）')
  ok(/compact=\{variant !== 'page'\}/.test(chat), 'G6c 右侧栏 / 悬浮侧栏传 compact')
  ok(/compact=\{reviewWidth < 720\}/.test(mod) && /maxWidth: '100%'/.test(mod),
    'G6d 工作区预览按面板宽度切 compact，并限制不溢出')
  ok(/useAssistantChat/.test(workspace) && /unified:\s*true/.test(workspace), 'G7 工作区改走统一控制器')
  ok(/scopeAll/.test(mod) && /scopeCollapsed/.test(mod), 'G8 工作区作用域卡支持整仓与折叠')
  ok(/AgentSessionInfo/.test(hook) && /source \?\? 'assistant'/.test(hook), 'G9 会话列表合并旧 assistant 来源')
}

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
