#!/usr/bin/env node
/**
 * AI 助手会话「钉住 / ★ 收藏」契约：全链路接线断言。
 * 范围 = 只通用助手（整页左栏 AiChatSidebar + 悬浮/右栏抽屉 ChatBody）；
 * 日程助手（surface='schedule'）不适用（「一天一会话」）。
 * 跑法：node .AGENT/scripts/assistant-aichat/verify-session-pin.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

console.log('\n[数据层] agentSessionRepo.ts')
const repo = read('electron/lib/agentSessionRepo.ts')
check('AgentSessionRow 增 pinned_at 字段', repo.includes('pinned_at?: string'))
check('setSessionPinned 业务函数', repo.includes('export function setSessionPinned(id: string, pinned: boolean): boolean'))
check('钉住写 nowLocal / 取消 delete', repo.includes('row.pinned_at = nowLocal()') && repo.includes('delete row.pinned_at'))

console.log('\n[IPC] agentService.ts')
const svc = read('electron/lib/agentService.ts')
check('引入 setSessionPinned', svc.includes('setSessionPinned'))
check('camelRow 映射 pinnedAt', svc.includes('pinnedAt: typeof row.pinned_at'))
check('handler agent:setSessionPinned', svc.includes("ipcMain.handle('agent:setSessionPinned'"))

console.log('\n[接线] preload / types / ipc')
check('preload 通道 agentSetSessionPinned', read('electron/preload/index.ts').includes('agentSetSessionPinned:'))
const types = read('src/types/index.ts')
check('AgentSessionInfo 增 pinnedAt', types.includes('pinnedAt?: string | null'))
check('ElectronAPI 增 agentSetSessionPinned', types.includes('agentSetSessionPinned: (id: string, pinned: boolean) => Promise<boolean>'))
check('ipc.ts 封装 agentSetSessionPinned', read('src/lib/ipc.ts').includes('export const agentSetSessionPinned'))

console.log('\n[控制器] useAssistantChat.ts')
const hook = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
check('引入 agentSetSessionPinned', hook.includes('agentSetSessionPinned'))
check('togglePin 回调（乐观更新 + 落盘）', hook.includes('const togglePin = useCallback') && hook.includes('agentSetSessionPinned(id, next)'))
check('togglePin 进控制器接口与返回', hook.includes('togglePin: (id: string) => Promise<void>') && hook.includes('\n    togglePin,'))

console.log('\n[整页左栏] AiChatSidebar.tsx')
const side = read('src/components/shared/AssistantPanel/AiChatSidebar.tsx')
check('收藏分区（★ 收藏 标题）', side.includes('收藏') && side.includes('全部会话'))
check('行内 ★ = chat.togglePin', side.includes('chat.togglePin(sess.id)'))
check('右键菜单项 pin', side.includes('data-ai-menu-item="pin"') && side.includes('钉住到收藏'))
check('菜单委托处理 pin', side.includes("t.dataset.aiMenuItem === 'pin'"))

console.log('\n[抽屉] ChatBody.tsx')
const body = read('src/components/shared/AssistantPanel/ChatBody.tsx')
check('gate 到通用助手（!scheduleMode）', body.includes('const pinEnabled = !scheduleMode'))
check('抽屉行内 ★ = togglePin', body.includes('togglePin(sess.id)'))
check('抽屉收藏分区', body.includes('收藏') && body.includes('全部会话'))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
