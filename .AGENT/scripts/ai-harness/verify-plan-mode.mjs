// 契约脚本：只读规划模式 + 通用任务清单（P1-4）
// 覆盖：清单归一、writeMode=plan 的工具面/硬拦截、会话偏好、UI 三档与清单渲染接线。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: M } = await loadTsModule(join(ROOT, 'electron/lib/agentTodoPure.ts'))

// ── ① 清单归一 ────────────────────────────────────────────────────────────────
{
  const r = M.normalizeAgentTodos([
    { text: '调查现状', status: 'done' },
    { text: '  改 A 文件  ' },
    { text: '运行验证', status: 'doing' },
  ])
  ok('合法清单归一', r.ok && r.items.length === 3 && r.items[1].text === '改 A 文件' && r.items[1].status === 'todo')
  ok('状态别名 done/completed', M.normalizeAgentTodos([{ text: 'x', status: 'completed' }]).items[0].status === 'done')
  ok('状态别名 current → doing', M.normalizeAgentTodos([{ text: 'x', status: 'current' }]).items[0].status === 'doing')
}
{
  const r = M.normalizeAgentTodos([
    { text: 'a', status: 'doing' }, { text: 'b', status: 'doing' }, { text: 'c', status: 'doing' },
  ])
  ok('最多一个 doing（其余降为 todo）', r.ok && r.items.filter(i => i.status === 'doing').length === 1 && r.items[1].status === 'todo')
}
{
  ok('空数组 = 清空清单（合法）', M.normalizeAgentTodos([]).ok && M.normalizeAgentTodos([]).items.length === 0)
  ok('非数组拒绝', !M.normalizeAgentTodos('a').ok)
  ok('超过 20 项拒绝', !M.normalizeAgentTodos(Array.from({ length: 21 }, (_, i) => ({ text: `t${i}` }))).ok)
  ok('空文本项丢弃', M.normalizeAgentTodos([{ text: '   ' }, { text: 'ok' }]).items.length === 1)
  ok('单项 200 字截断', M.normalizeAgentTodos([{ text: 'x'.repeat(300) }]).items[0].text.length === 200)
  ok('缺 text 视为空项丢弃', M.normalizeAgentTodos([{ status: 'todo' }]).items.length === 0)
}
{
  const steps = [
    { kind: 'tool', todo: [{ text: 'a', status: 'todo' }] },
    { kind: 'llm' },
    { kind: 'tool', todo: [{ text: 'b', status: 'done' }] },
    { kind: 'tool' },
  ]
  ok('取最后一条清单快照', M.latestTodoOfSteps(steps)[0].text === 'b')
  ok('无清单返回 null', M.latestTodoOfSteps([{ kind: 'llm' }]) === null && M.latestTodoOfSteps([]) === null)
}

// ── ② 主进程：写模式与工具面 ──────────────────────────────────────────────────
const svc = readFileSync(join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
ok('writeMode 接受 plan', /writeMode: 'direct' \| 'confirm' \| 'plan'/.test(svc) && /ctxData\.writeMode === 'plan'/.test(svc))
ok('planMode 由 writeMode=plan 派生', /const planMode = unifiedAssistant && writeMode === 'plan'/.test(svc))
ok('工具面按 planMode 隐藏 requires=write', /modeOpts\?\.planMode && t\.requires === 'write'/.test(svc))
ok('plan 模式自动放行任务清单工具', /if \(modeOpts\?\.planMode\) extraTools\.add\('builtin\.plan\.todo'\)/.test(svc))
ok('规划模式 system 提示存在', /只读规划模式.*写工具、终端命令、模块写入全部不在工具面/.test(svc))
ok('任务清单快照随 trace 落库', /realName === 'builtin\.plan\.todo'/.test(svc) && /toolStep\.todo = items/.test(svc))

const tools = readFileSync(join(ROOT, 'electron/lib/aiTools.ts'), 'utf8')
ok('invoke 层兜住 plan 写调用', /ctx\?\.writeMode === 'plan' && tool\.requires === 'write'/.test(tools))
ok('ToolInvokeCtx.writeMode 含 plan', /writeMode\?: 'direct' \| 'confirm' \| 'plan'/.test(tools))

const bt = readFileSync(join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')
ok('plan 模式不能申请写工具', /ctx\?\.writeMode === 'plan' && t\.requires === 'write'/.test(bt))
ok('builtin.plan.todo 已注册（ondemand / requires read）', /name: 'builtin\.plan\.todo'/.test(bt) && /tier: 'ondemand'/.test(bt) && /requires: 'read'/.test(bt))

const repo = readFileSync(join(ROOT, 'electron/lib/agentSessionRepo.ts'), 'utf8')
ok('会话行 writeMode 类型与校验含 plan', /SessionWriteMode = 'direct' \| 'confirm' \| 'plan'/.test(repo) && /patch\.writeMode === 'plan'/.test(repo))
const norm = readFileSync(join(ROOT, 'electron/lib/agentSessionNormalizePure.ts'), 'utf8')
ok('存量迁移类型含 plan', /NormalizableWriteMode = 'direct' \| 'confirm' \| 'plan'/.test(norm))

// ── ③ 渲染层：三档与清单 ──────────────────────────────────────────────────────
const chat = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/useAssistantChat.ts'), 'utf8')
ok('控制器 writeMode 三档', /writeMode: 'direct' \| 'confirm' \| 'plan'/.test(chat) && /setWriteMode: \(mode: 'direct' \| 'confirm' \| 'plan'\)/.test(chat))
ok('会话加载识别 plan', /row\?\.writeMode === 'plan' \? 'plan'/.test(chat))
ok('缩窄作用域时只从 direct 自动切先预览', /wasAll && writeMode === 'direct'/.test(chat))

const body = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/ChatBody.tsx'), 'utf8')
ok('写入方式菜单含只读规划', /只读规划/.test(body) && /setWriteMode\('plan'\)/.test(body))

const msg = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/MessageList.tsx'), 'utf8')
const card = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/PlanTodoCard.tsx'), 'utf8')
ok('消息流渲染任务清单（完成态 + 生成态）', /PlanTodoCard items=\{latestTodoOf\(m\.trace\)\}/.test(msg) && /pending && <PlanTodoCard items=\{liveTodo\}/.test(msg))
ok('清单卡有 done/total 与三态图标', /done\}\/\{items\.length/.test(card) && /CheckCircle2/.test(card) && /CircleDot/.test(card))

const types = readFileSync(join(ROOT, 'src/types/index.ts'), 'utf8')
ok('共享类型含 AgentTodoItem + trace.todo', /interface AgentTodoItem/.test(types) && /todo\?: AgentTodoItem\[\]/.test(types))
const preload = readFileSync(join(ROOT, 'electron/preload/index.ts'), 'utf8')
const ipc = readFileSync(join(ROOT, 'src/lib/ipc.ts'), 'utf8')
ok('preload/IPC 的会话偏好接受 plan', /'direct' \| 'confirm' \| 'plan'/.test(preload) && /'direct' \| 'confirm' \| 'plan'/.test(ipc))

report('只读规划模式 + 通用任务清单（P1-4）')
