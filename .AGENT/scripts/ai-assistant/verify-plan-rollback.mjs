/**
 * AI助手（v3.9.0）变更方案 / 整任务回滚契约。
 *
 * 为什么需要它：M3/M4 的失败模式全是静默的 ——
 *  · 回滚把 rename 方向搞反（改成 rename(b→a) 才对，写成 rename(a→b) 会让文件原地不动或报错）；
 *  · write 新建的文件回滚时没认出 prev===null，写回空串 = 文件变空而不是消失；
 *  · 回滚按正序执行 → 后一 op 依赖的前一 op 前提被破坏；
 *  · 写工具没挂岔口 → AI助手「暂存」是假的，直接落盘了用户没确认的改动。
 *
 * §1 import 真实纯逻辑（aiAssistantPlanPure.ts，零依赖）验选择与正反向映射；
 * §2 源码接线断言：vault.* 写工具确实走 commitOrStage，IPC 五通道三处同步。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/ai-assistant/verify-plan-rollback.mjs
 * 期望：末尾 PASS，exit=0
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'
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

const op = (o) => ({ id: o.id, kind: o.kind, relPath: o.relPath, to: o.to, prev: o.prev, next: o.next, status: o.status })

console.log('=== A. selectOps：应用取 pending+accepted 正序 ===')
{
  const ops = [
    op({ id: '1', kind: 'write', relPath: 'a.md', prev: null, next: 'x', status: 'pending' }),
    op({ id: '2', kind: 'edit', relPath: 'b.md', prev: 'o', next: 'n', status: 'pending' }),
    op({ id: '3', kind: 'trash', relPath: 'c.md', prev: 'zz', status: 'pending' }),
  ]
  const sel = selectOps(ops, ['1', '3'], 'apply')
  ok(sel.map((o) => o.id).join(',') === '1,3', 'A1 只取被采纳的 pending，保持计划顺序', sel.map((o) => o.id).join(','))
  ok(selectOps(ops, ['1', '2', '3'], 'apply').length === 3, 'A2 全采纳取全部')
}

console.log('\n=== B. selectOps：回滚取 applied 逆序 ===')
{
  const ops = [
    op({ id: '1', kind: 'write', relPath: 'a.md', prev: null, next: 'x', status: 'applied' }),
    op({ id: '2', kind: 'edit', relPath: 'b.md', prev: 'o', next: 'n', status: 'applied' }),
    op({ id: '3', kind: 'edit', relPath: 'c.md', prev: 'p', next: 'q', status: 'rejected' }),
    op({ id: '4', kind: 'rename', relPath: 'd.md', to: 'e.md', status: 'applied' }),
  ]
  const sel = selectOps(ops, [], 'rollback')
  ok(sel.map((o) => o.id).join(',') === '4,2,1', 'B1 只取 applied 且逆序', sel.map((o) => o.id).join(','))
}

console.log('\n=== C. actionForOp：正 / 反向映射 ===')
{
  const w = op({ id: 'w', kind: 'write', relPath: 'a.md', prev: null, next: 'hi', status: 'pending' })
  ok(actionForOp(w, 'apply').action === 'write' && actionForOp(w, 'apply').content === 'hi', 'C1 write→write(next)')
  ok(actionForOp(w, 'rollback').action === 'trash', 'C2 新建文件(write,prev=null)回滚→trash')

  const e = op({ id: 'e', kind: 'edit', relPath: 'b.md', prev: 'old', next: 'new', status: 'pending' })
  const er = actionForOp(e, 'rollback')
  ok(er.action === 'write' && er.content === 'old', 'C3 edit 回滚→write(prev)')

  const r = op({ id: 'r', kind: 'rename', relPath: 'x/a.md', to: 'y/a.md', status: 'pending' })
  const ra = actionForOp(r, 'apply')
  const rr = actionForOp(r, 'rollback')
  ok(ra.action === 'rename' && ra.relPath === 'x/a.md' && ra.to === 'y/a.md', 'C4 rename 应用方向 x/a→y/a')
  ok(rr.action === 'rename' && rr.relPath === 'y/a.md' && rr.to === 'x/a.md', 'C5 rename 回滚方向反向 y/a→x/a')

  const t = op({ id: 't', kind: 'trash', relPath: 'c.md', prev: 'body', status: 'pending' })
  ok(actionForOp(t, 'apply').action === 'trash', 'C6 trash→trash')
  const tr = actionForOp(t, 'rollback')
  ok(tr.action === 'write' && tr.content === 'body', 'C7 trash 回滚→write(prev) 复原')

  const m = op({ id: 'm', kind: 'mkdir', relPath: 'dir', status: 'pending' })
  ok(actionForOp(m, 'apply').action === 'mkdir', 'C8 mkdir→mkdir')
  ok(actionForOp(m, 'rollback') === null, 'C9 mkdir 回滚无文件动作（不误删目录）')
}

console.log('\n=== D. 源码接线：写工具走岔口 ===')
const bt = read('electron/lib/builtinTools.ts')
ok(/import\s*\{\s*commitOrStage\s*\}\s*from\s*'\.\/aiAssistantCommit'/.test(bt), 'D1 builtinTools 引入 commitOrStage')
const commitCount = (bt.match(/commitOrStage\(ctx,/g) || []).length
ok(commitCount >= 4, 'D2 write/edit/rename/trash 四处走岔口', `实得 ${commitCount}`)
ok(/kind: 'write'/.test(bt) && /kind: 'edit'/.test(bt) && /kind: 'rename'/.test(bt) && /kind: 'trash'/.test(bt), 'D3 四种 op kind 均被暂存构造')

const commit = read('electron/lib/aiAssistantCommit.ts')
ok(/isPropose\(ctx\)/.test(commit) && /ctx\.propose/.test(commit), 'D4 岔口以 propose 判定（非 propose 直落盘）')
ok(/stageOp\(/.test(commit), 'D5 propose 时记入 stageOp')

const svc = read('electron/lib/agentService.ts')
ok(/scope:\s*aiScope/.test(svc) && /propose:\s*aiPropose/.test(svc) && /scopeAll/.test(svc), 'D6 agentService 透传 scope+scopeAll+propose')
ok(/ipcMain\.handle\('aiAssistant:plan:apply'/.test(svc) && /aiAssistant:task:rollback/.test(svc), 'D7 主进程注册 plan:apply / task:rollback')

console.log('\n=== E. IPC 三处同步 ===')
const preload = read('electron/preload/index.ts')
const types = read('src/types/index.ts')
const ipc = read('src/lib/ipc.ts')
for (const ch of ['aiAssistantPlanGet', 'aiAssistantPlanApply', 'aiAssistantPlanReject', 'aiAssistantTaskRollback', 'aiAssistantTasks']) {
  ok(preload.includes(ch), `E preload 暴露 ${ch}`)
}
ok(/AiChangePlan \| null/.test(types), 'E types 声明 AiChangePlan 返回')
ok(/export const aiAssistantPlanGet/.test(ipc) && /export const aiAssistantTaskRollback/.test(ipc), 'E ipc.ts 封装函数到位')

console.log('\n=== F. Stop 语义 / 用量卡接线 ===')
const hook = read('src/components/shared/AssistantPanel/useAssistantChat.ts')
ok(/agentAbortSession\(sid\)[\s\S]{0,220}aiAssistantPlanReject\(sid\)/.test(hook),
  'F1 确认模式 Stop 丢弃未应用方案；直接模式只中断（不再自动回滚）')
ok(/agentUsageGet\(\)/.test(hook), 'F2 用量卡经 agentUsageGet 聚合会话分桶')
const mod = read('src/modules/ai-assistant/index.tsx')
ok(/fmtTokens\(api\.usage\.in \+ api\.usage\.out\)/.test(mod), 'F3 任务完成显示 token 卡')
ok(/ReviewPane/.test(mod) && /api\.pendingCount/.test(mod), 'F4 模块接 ReviewPane 与待确认角标')

console.log('\n=== G. 输入区模型菜单弹层（v3.9.0 台账 F-1）===')
// ★ 扫剥注释后的源码：本模块注释里就写着「w-[280px] 会被 max-w-full 压成竖条」这句根因说明，
//   不剥注释的话 G2 这条负向断言会被自己的说明文字顶成假 FAIL（strip-comments 的既有教训）。
const modCode = stripComments(mod)
ok(/useAnchoredMenu\(modelTriggerRef, modelMenuRef, 280\)/.test(modCode)
  && /createPortal\(\s*<div\s*ref=\{modelMenuRef\}\s*style=\{modelMenu\.pos\}[\s\S]*?,\s*document\.body,\s*\)\}/.test(modCode),
  'G1 模型菜单 = 锚点弹层（useAnchoredMenu 实测翻折与 clamp + portal 到 body，宽度不受宿主影响）')
ok(!/w-\[280px\][^"']*max-w-full/.test(modCode),
  'G2 负向：弹层根禁止 w-[280px] + max-w-full 同挂一行 —— max-width:100% 的包含块是触发按钮（≈70px），\n' +
  '     会把菜单压成竖条（F-1 根因）。窄宿主保险该由 useAnchoredMenu 的视口 clamp 承担，不是 max-w-full')

console.log(`\n${fails.length ? 'FAIL' : 'PASS'}  ${pass} passed, ${fails.length} failed`)
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1) }
