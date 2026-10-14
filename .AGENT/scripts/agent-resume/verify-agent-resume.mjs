#!/usr/bin/env node
/**
 * 中断续跑契约（A 方案，2026-10-14）。
 * 方案：docs/agent-interrupt-resume-plan.md §3.8。
 *
 * 三层断言：
 *   1) 纯函数离线断言（agentInterruptPure.ts）：卡片正文 / carry / 注入 / 摘要裁剪；
 *   2) 负向断言（这一层最值钱）：摘要里搜不到 carry 正文、没写现场时不能说「可点继续」、
 *      建议动作不与卡片尾句重复说「继续」；
 *   3) 源码级接线断言：纯函数写对了但没接上等于没做（claim 顺序、convo 末尾注入、
 *      会话列表出口裁剪、三处消息删改作废现场、按钮只挂在中断卡上）。
 *
 * 跑法：node .AGENT/scripts/agent-resume/verify-agent-resume.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildInterruptContent, buildResumeCarry, buildResumeInjection, toResumeInfo,
  INTERRUPT_CONTENT_CAP, CARRY_TOTAL_CAP, CARRY_ITEM_CAP, RESUMABLE_NOTE, RESUME_NOTICE,
} from '../../../electron/lib/agentInterruptPure.ts'
import {
  classifyFailure, rawFailure, suggestedActionText, INTERRUPT_CODE_TABLE,
} from '../../../electron/lib/llmFailurePure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}
const eq = (name, got, want) => check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)

// ============ 1. 中断卡正文 ============
console.log('\n[纯函数] 中断卡正文 buildInterruptContent')

const CHANGES = [
  { action: '编辑', target: '减肥记录/饮食计划.md', file: '减肥记录/饮食计划.md' },
  { action: '新建', target: '减肥记录/周复盘 10-14.md', file: '减肥记录/周复盘 10-14.md' },
  { action: '打卡', target: '运动' },
]
const failInput = {
  reason: '与模型服务的连接被中断',
  advice: suggestedActionText(classifyFailure(rawFailure({ layer: 'transport', raw: 'net::ERR_CONNECTION_RESET' }))),
  rounds: 12,
  toolCalls: 21,
  changes: CHANGES,
  diagnostics: '原因码：LLM_NET_RESET',
}
const failed = buildInterruptContent(failInput)

check('正文含白话原因（拍板点 1：不能只写「已中断」）', failed.includes('与模型服务的连接被中断'))
check('正文含轮数 / 工具数', failed.includes('已进行 12 轮推理 / 21 次工具调用'))
check('正文含改动清单（可读目标）', failed.includes('1. 编辑「减肥记录/饮食计划.md」') && failed.includes('3. 打卡「运动」'))
check('正文含可继续句', failed.includes(RESUMABLE_NOTE))
check('诊断块在正文里（复制正文即可带走证据）', failed.includes('```诊断') && failed.includes('原因码：LLM_NET_RESET'))
check('确定性：同输入两次逐字相同', failed === buildInterruptContent(failInput))

const humanLen = failed.split('```诊断')[0].length
check('白话段不超上限（诊断块不计入）', humanLen <= INTERRUPT_CONTENT_CAP + 40, `len=${humanLen}`)

const longChanges = Array.from({ length: 20 }, (_, i) => ({ action: '修改', target: `很长的目标名称/子目录/文件-${i}.md` }))
const longOut = buildInterruptContent({
  reason: 'x'.repeat(400), rounds: 99, toolCalls: 120, changes: longChanges,
  lastProcessText: 'y'.repeat(300), diagnostics: 'D',
})
check('超长正文被截断且不破诊断块', longOut.split('```诊断')[0].length <= INTERRUPT_CONTENT_CAP + 40 && longOut.includes('（正文过长，已截断）') && longOut.endsWith('```'))

const aborted = buildInterruptContent({ reason: '你点了「停止」，本次任务停在这里', rounds: 3, toolCalls: 4, changes: [] })
check('停止态与失败态可区分', aborted !== failed && aborted.includes('停止') && !aborted.includes('连接被中断'))
check('停止态默认也带可继续句（停止可续是拍板结论）', aborted.includes(RESUMABLE_NOTE))
check('原因缺失时诚实兜底（不编造）', buildInterruptContent({ reason: '', rounds: 0, toolCalls: 0 }).includes('未收到任何错误说明'))

// 负向：支线旁问 / 手册通道不写现场 → 正文不能说「可点继续」（指向不存在的按钮比不说更糟）
const noResume = buildInterruptContent({ reason: '与模型服务的连接被中断', rounds: 2, toolCalls: 1, canResume: false })
check('没写现场时不得提「继续」（负向）', !noResume.includes('继续'), noResume)

// ============ 2. carry ============
console.log('\n[纯函数] 续跑 carry buildResumeCarry')

const rows = [
  { tool: 'builtin.vault.read', args: '{"path":"a.md"}', result: JSON.stringify({ ok: true, data: { path: 'a.md', chars: 120 } }), ok: true },
  { tool: 'builtin.knowledge.search', args: '{"query":"减肥"}', result: JSON.stringify({ ok: false, error: '查询超时' }), ok: false },
  { tool: 'builtin.schedule.list', args: '', result: JSON.stringify({ ok: true, data: { items: [{ title: '跑步' }, { title: '游泳' }] } }), ok: true },
]
const carry = buildResumeCarry(rows)
const carryLines = carry.split('\n')

eq('逐条一行', carryLines.length, 3)
check('新→旧（最后执行的在最前）', carryLines[0].startsWith('builtin.schedule.list') && carryLines[2].startsWith('builtin.vault.read'))
check('形态是「工具(入参) → 结果摘要」', carryLines[2].includes('builtin.vault.read({"path":"a.md"}) → '))
check('失败调用也进 carry（标 [失败]）', carry.includes('[失败]'))
check('单条不超上限', carryLines.every(l => l.length <= CARRY_ITEM_CAP), `max=${Math.max(...carryLines.map(l => l.length))}`)
check('非 JSON 结果原样降级（不抛、不编）', buildResumeCarry([{ tool: 't', result: 'plain text result' }]).includes('plain text result'))
eq('空输入 = 空串', buildResumeCarry([]), '')
check('幂等（同输入两次相同）', buildResumeCarry(rows) === carry)

const many = Array.from({ length: 60 }, (_, i) => ({
  tool: `tool${i}`,
  args: '',
  result: JSON.stringify({ ok: true, data: 'v'.repeat(700) + i }),
  ok: true,
}))
const capped = buildResumeCarry(many)
const keptCount = capped.split('\n').length
check('总量不超上限', capped.length <= CARRY_TOTAL_CAP, `len=${capped.length}`)
check('超了丢最老的（最近的一定在）', capped.includes('tool59 →') && !capped.includes('tool30 →'), `kept=${keptCount}`)
check('截断后仍是一行一条（不产生半行）', capped.split('\n').every(l => l.includes(' → ')))

// ============ 3. 续跑注入 ============
console.log('\n[纯函数] 续跑注入 buildResumeInjection')

const facts = { reason: '模型输出到一半卡住了（已收到 8 段后 60 秒无新数据）', aborted: false, rounds: 12, toolCalls: 21, changes: CHANGES }
const injection = buildResumeInjection(facts, carry)

check('含 RESUME_NOTICE 标记', injection.includes(RESUME_NOTICE))
check('含 carry 原文', injection.includes(carryLines[0]))
check('含进度与改动清单', injection.includes('12 轮推理') && injection.includes('1. 编辑「减肥记录/饮食计划.md」'))
check('明说「已完成的不要重做」', injection.includes('不要重做'))
const emptyCarry = buildResumeInjection({ ...facts, rounds: 0, toolCalls: 0, changes: [] }, '')
check('首轮就死（carry 为空）仍是合法注入', emptyCarry.includes(RESUME_NOTICE) && emptyCarry.includes('已获得的信息：无'))
check('注入幂等', buildResumeInjection(facts, carry) === injection)

// ============ 4. 渲染层摘要（负向：绝不能带 carry） ============
console.log('\n[纯函数] 会话列表摘要 toResumeInfo')

const CARRY_BODY = 'SECRET-CARRY-BODY-工具结果原文'
const resumeRow = {
  at: '2026-10-14 10:00:00',
  message_id: 'msg-42',
  reason: '等待模型响应超时',
  aborted: false,
  tool_calls: 21,
  changes: CHANGES,
  carry: CARRY_BODY,
}
const info = toResumeInfo(resumeRow)

eq('messageId 搬运（按钮的锚点）', info.messageId, 'msg-42')
eq('toolCalls 搬运', info.toolCalls, 21)
eq('reason 搬运', info.reason, '等待模型响应超时')
check('changes 搬运（含 file）', info.changes.length === 3 && info.changes[0].file === '减肥记录/饮食计划.md')
check('负向：摘要里搜不到 carry 正文', !JSON.stringify(info).includes(CARRY_BODY))
check('负向：摘要里根本没有 carry 这个键', !('carry' in info))
eq('aborted 缺省不冒充 true', toResumeInfo({ ...resumeRow, aborted: false }).aborted, false)
eq('changes 非法时降级为空数组（不抛）', toResumeInfo({ ...resumeRow, changes: undefined }).changes.length, 0)

// ============ 5. 文案不重复 ============
console.log('\n[一致性] 建议动作 ↔ 卡片尾句')
const base = classifyFailure(rawFailure({ layer: 'transport', raw: '' }))
const dupAdvice = Object.keys(INTERRUPT_CODE_TABLE).filter((c) => {
  if (INTERRUPT_CODE_TABLE[c].action !== 'resume') return false
  return suggestedActionText({ ...base, code: c, ...INTERRUPT_CODE_TABLE[c] }).includes('继续')
})
eq('resume 类码不在建议动作里重复说「继续」', dupAdvice.length, 0)
const allResumable = Object.keys(INTERRUPT_CODE_TABLE).filter(c => INTERRUPT_CODE_TABLE[c].resumable !== true)
eq('每个归因码都可续（A 的按钮据此出）', allResumable.length, 0)

// ============ 6. 主进程接线 ============
console.log('\n[接线] electron/lib/agentService.ts')
const svc = read('electron/lib/agentService.ts')

check('agent:resume 通道存在且包在 withAbort 里', /ipcMain\.handle\('agent:resume'[\s\S]{0,300}withAbort\(/.test(svc))
check('续跑入口不追加用户消息（不调 appendAgentMessage(…, \'user\')）', (() => {
  const i = svc.indexOf('async function agentResume')
  const seg = svc.slice(i, i + 2000)
  return !seg.includes("'user'")
})())
check('claim 先清现场再跑（连点两次只消费一次）', (() => {
  const claim = svc.indexOf('updateSessionResume(sessionId, null)')
  const run = svc.indexOf('{ resumeInjection: injection }')
  return claim > -1 && run > -1 && claim < run
})())
check('注入作为 convo 末尾的合成 user 轮（前缀不变 → prompt cache 不受影响）', svc.includes("if (resumeInjection) convo.push({ role: 'user', content: resumeInjection })"))
check('守卫放行「末条是中断卡」（否则续跑永远进不去）', svc.includes("history[history.length - 1].role !== 'user' && !resumeInjection"))
check('runAgentLoop 接收 resumeInjection', svc.includes('resumeInjection?: string'))
check('每个失败 / 停止出口都带现场（含轮内、停止、工具批次、总结失败）', (svc.match(/interruptCtxOf\(/g) ?? []).length >= 5, `count=${(svc.match(/interruptCtxOf\(/g) ?? []).length}`)
check('会话列表出口裁剪（6k carry 不发渲染层）', svc.includes('listAgentSessions().map(sessionOut)') && svc.includes('delete out.resume'))
check('负向：不再把整行原样发给渲染层', !svc.includes('listAgentSessions().map(camelRow)'))
check('摘要经 toResumeInfo 产出', svc.includes('toResumeInfo(rs)'))
check('截断也留现场（可接着往下写）', svc.includes('if (ictx.writeResume !== false) persistResume('))
check('预算触顶也留现场（任务没做完，不是失败）', svc.includes('// 预算触顶 = 任务没做完（不是失败）'))
check('支线 / 手册通道不写现场（重问成本低）', svc.includes('writeResume: !isSideLane && !manual'))
check('停止态不贴诊断块（原因自明）', svc.includes("it.code === 'USER_ABORTED' ? {} : { diagnostics: buildDiagnostics(it, dt) }"))
check('现场落库失败不静默', svc.includes('续跑现场落库失败'))
check('中断卡正文由 buildInterruptContent 产出（不是手拼字符串）', svc.includes('buildInterruptContent({'))
check('carry 在每次工具执行后入账', svc.includes('carryRows.push(') && svc.includes('if (carryRows.length > 40) carryRows.shift()'))
check('入账的是实际回喂给模型的那份内容', svc.includes('result: toolContent.slice(0, 4000)'))

console.log('\n[接线] electron/lib/agentSessionRepo.ts')
const repo = read('electron/lib/agentSessionRepo.ts')
check('会话行新增 resume 字段（与 digest 同层）', /resume\?: SessionResume/.test(repo))
check('写回函数存在且不动 updated_at', repo.includes('export function updateSessionResume(') && /updateSessionResume[\s\S]{0,400}writeSessions\(sessions\)/.test(repo))
check('用户发新消息 = 现场作废', repo.includes("if (role === 'user') delete row.resume"))
check('appendAgentMessage 返回消息 id（按钮的锚点）', repo.includes("export function appendAgentMessage(sessionId: string, role: 'user' | 'assistant', content: string, trace?: unknown): string"))
check('编辑 / 删除 / 删其后 三处都作废现场', (repo.match(/invalidateResumeOnMutation\(sessionId\)/g) ?? []).length >= 3, `count=${(repo.match(/invalidateResumeOnMutation\(sessionId\)/g) ?? []).length}`)
check('作废失败不阻断消息操作', /function invalidateResumeOnMutation[\s\S]{0,400}catch/.test(repo))

// ============ 7. 渲染层接线 ============
console.log('\n[接线] 渲染层（preload / ipc / types / hook / MessageList / ChatBody）')
const pre = read('electron/preload/index.ts')
check('preload 暴露 agentResume', pre.includes("ipcRenderer.invoke('agent:resume', req)"))
const ipc = read('src/lib/ipc.ts')
check('渲染层 ipc 封装 agentResume', ipc.includes('export const agentResume = ('))
const types = read('src/types/index.ts')
check('镜像类型 ResumeInfo 存在', types.includes('export interface ResumeInfo {'))
check('会话信息带 resumeInfo', types.includes('resumeInfo?: ResumeInfo | null'))
check('桥接类型带 agentResume', /agentResume: \(req: \{ sessionId: string/.test(types))
check('负向：镜像里没有 carry（结构上就发不出去）', !/interface ResumeInfo \{[\s\S]{0,400}carry/.test(types))

const hook = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
check('控制器有 resume 动作并走 agentResume', hook.includes('const resume = useCallback(') && hook.includes('await agentResume(sid'))
check('resume 有「本会话在跑 / 并发上限」守卫', /const resume = useCallback[\s\S]{0,400}isSessionRunning\(sid\)[\s\S]{0,300}runningSessionCount\(\) >= MAX_PARALLEL/.test(hook))
check('resumeInfo 只认当前会话那一份', hook.includes('sessions.find(s => s.id === activeId)?.resumeInfo'))
check('后台结束也重拉会话列表（现场写在会话行上）', hook.includes('refreshSessionsRef.current?.()'))
check('失败提示指向「继续」入口（三入口都改了口径）', (hook.match(/可点「继续」接着做/g) ?? []).length >= 3)
check('用户停止的提示说「可继续」', hook.includes('已停止生成 · 可点「继续」接着做'))

const ml = read('src/components/shared/AssistantPanel/MessageList.tsx')
check('「继续」按钮存在', ml.includes('<Play size={9} />') && ml.includes('>继续</span>'))
check('按钮只挂在那条中断消息上（负向：不能出现在别的消息）', ml.includes('resumeInfo.messageId === m.id'))
check('按钮只在非运行态出现（运行中不给第二次）', /resumeInfo\.messageId === m\.id[\s\S]{0,60}|!pending && onResume/.test(ml) && ml.includes('!pending && onResume && resumeInfo'))
check('hover 有原因提示（不是裸按钮）', ml.includes('从断点继续（上次中断：'))

const body = read('src/components/shared/AssistantPanel/ChatBody.tsx')
check('宿主把现场与动作传给了消息流', body.includes('resumeInfo={resumeInfo}') && body.includes('onResume={() => { void resume() }}'))
check('宿主解构了 resume / resumeInfo', body.includes('regenerate, resume, resumeInfo, editSubmit'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
