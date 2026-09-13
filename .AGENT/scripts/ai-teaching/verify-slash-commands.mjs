#!/usr/bin/env node
/**
 * v3.1.1 条目10 契约脚本：/ 弹层 + Skill 显式调用 + /compress 进行时反馈
 * 防回归点：四层 skillName 链路、Esc 局部拦截不进全局链、chip 一次性消费、重入门卫。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failed = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed++
}

const t = read('src/lib/chatCommands.ts')
const svc = read('electron/lib/agentService.ts')
const pre = read('electron/preload/index.ts')
const ipc = read('src/lib/ipc.ts')
const types = read('src/types/index.ts')
const menu = read('src/components/shared/SlashCommandMenu.tsx')
const teach = read('src/modules/ai-teaching/index.tsx')
const panel = read('src/components/shared/AssistantPanel/index.tsx')

console.log('[chatCommands 单一真源]')
check('CHAT_COMMANDS 表存在（弹层指令组数据源）', t.includes('export const CHAT_COMMANDS: ChatCommand[]'))
check('ctx.onProgress 执行态回调已声明', t.includes('onProgress?: (p: { active: boolean }) => void'))
check('run 前 onProgress({active:true})', t.includes('ctx.onProgress?.({ active: true })'))
check('finally 中 onProgress({active:false})（失败也收占位）', /finally\s*{[\s\S]*?ctx\.onProgress\?\.\(\{ active: false \}\)[\s\S]*?}/.test(t))
check('running 重入门卫（执行期间再发指令拒绝）', t.includes('if (running) {') && t.includes('running = true'))
check('ChatCommand.run 签名未被破坏（未来命令零成本接入）', t.includes('run: (ctx: ChatCommandCtx) => Promise<string | null>'))

console.log('\n[skillName 四层穿透]')
check('AgentChatRequest 含 skillName（main 层入参）', svc.includes('skillName?: string'))
check('agentChat → runAgentLoop 透传 skillName', svc.includes('skillName: req.skillName'))
check('runAgentLoop llmOpts 含 skillName', /llmOpts\?: \{[^}]*skillName\?: string/.test(svc))
check('preload agentChat 类型含 skillName', pre.includes("skillName?: string }) => ipcRenderer.invoke('agent:chat'"))
check('ElectronAPI.agentChat 类型含 skillName', types.includes("effort?: 'off' | 'low' | 'medium' | 'high'; skillName?: string }) => Promise<AgentChatResult>"))
check('渲染层 ipc agentChat 追加 skillName 参数', ipc.includes('effort?: \'off\' | \'low\' | \'medium\' | \'high\', skillName?: string'))

console.log('\n[agentService 显式注入]')
check('findSkillPrompt 导入自 skillService', svc.includes("import { findSkillPrompt } from './skillService'"))
check('explicitSkillHint 组装并拼入 systemFull', svc.includes('explicitSkillHint') && svc.includes('+ skillHint + explicitSkillHint +'))
check('注入文案标注「用户显式指定」优先级', svc.includes('用户显式指定 Skill') && svc.includes('优先遵循执行'))
check('Skill 不存在/停用时有降级文案', svc.includes('不存在或已停用'))
check('超长 Skill 提示词截断 6000', svc.includes('explicitSkill.prompt.length > 6000'))

console.log('\n[SlashCommandMenu 组件]')
check('buildSlashItems：指令在前、过滤 disabled Skill', menu.includes('kind: \'command\'') && menu.includes('.filter((s) => !s.disabled)'))
check('filterSlashItems 匹配 title 与全文 search（展示截断不影响检索）', menu.includes('it.title.toLowerCase().includes(q)') && menu.includes('it.search.toLowerCase().includes(q)'))
check('空态文案「没有匹配的指令或 Skill」', menu.includes('没有匹配的指令或 Skill'))
check('组件无业务状态（纯展示 + hover + pick）', !menu.includes('useState(') && !menu.includes('createAgentSession'))

console.log('\n[AI教学面接线]')
check('slashQuery 派生：/ 开头且无空白才弹', /slashQuery = input\.startsWith\('\/'\) && !\/\[\\s\\n\]\//.test(teach))
check('Esc 局部拦截 stopPropagation（不进全局 Esc 链）', /onSlashKeys[\s\S]*?e\.key === 'Escape'[\s\S]*?e\.stopPropagation\(\)/.test(teach))
check('Enter 在弹层打开时优先选中、不直发（defaultPrevented 判断）', teach.includes('if (!e.defaultPrevented && e.key === \'Enter\''))
check('Skill chip 一次性消费：doSend 内发出即清', /const sk = pickedSkill[\s\S]*?setPickedSkill\(null\)[\s\S]*?sendText\(text, cid, true, sk\?\.registryName\)/.test(teach))
check('sendText 增 skillName 透传 agentChat', teach.includes("await agentChat(sid, text, undefined, cid, 'aiTeaching', ov?.modelId, ov?.effort, skillName)"))
check('doSend 守卫 compressing（压缩中禁止发送）', teach.includes('if (!text || pending || compressing) return'))
check('handleChatCommand 接线 onProgress → setCompressing', teach.includes('onProgress: p => setCompressing(p.active)'))
check('挂载时拉取 Skill 列表（aiToolsListSkills）', teach.includes('aiToolsListSkills().then(r => setSlashSkills(r.skills))'))
check('compressing 占位条渲染', teach.includes('正在压缩对话历史'))
check('pickedSkill chip 可移除（X 按钮）', /pickedSkill && \([\s\S]*?setPickedSkill\(null\)[\s\S]*?<X/.test(teach))

console.log('\n[AssistantPanel 接线（assistant + aiLearn 两 surface 共用）]')
check('slashQuery 派生：/ 开头且无空白才弹', /slashQuery = input\.startsWith\('\/'\) && !\/\[\\s\\n\]\//.test(panel))
check('Esc 局部拦截 stopPropagation', /onSlashKeys[\s\S]*?e\.key === 'Escape'[\s\S]*?e\.stopPropagation\(\)/.test(panel))
check('Skill chip 一次性消费：send 内发出即清', /const sk = pickedSkill[\s\S]*?setPickedSkill\(null\)[\s\S]*?agentChat\(sid, text, ctx \?\? undefined, cid, undefined, undefined, undefined, sk\?\.registryName\)/.test(panel))
check('handleChatCommand 接线 onProgress → setCompressing', panel.includes('onProgress: p => setCompressing(p.active)'))
check('发送键禁用条件含 compressing', panel.includes('disabled={pending || compressing || !input.trim()}'))
check('send 依赖数组补 pickedSkill', panel.includes('full, learn.last, pickedSkill])'))
check('面板打开时刷新 Skill 列表', panel.includes('aiToolsListSkills().then(r => setSlashSkills(r.skills))'))
check('compressing 占位条渲染', panel.includes('正在压缩对话历史'))

console.log('\n[红线]')
check('ai-teaching 全局 Esc 浮层链未改动（TDZ 敏感区）', teach.includes("if (askVisible && askPending) { setAskDismissed(askPending.id); return }") || teach.includes('askCollapsed'))
check('未知指令 Toast 教育兜底保留', t.includes('未知指令'))

console.log(failed === 0 ? '\n全部断言通过 ✅' : `\n${failed} 条断言失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
