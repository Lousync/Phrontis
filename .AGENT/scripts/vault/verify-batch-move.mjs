/**
 * 契约：AI 批量移动原语（v3.16.1 方案 A）。
 *
 * 失败模式全是静默的：
 *  · 预检只报第一条冲突 → 模型改一条又撞下一条，来回烧回合；
 *  · 目标是已存在目录却没解析成「目录/原文件名」→ 移动到目录本身；
 *  · 大小写-only 重命名在 Windows 上时好时坏；
 *  · 暂存后磁盘变了，应用时不再校验 → 覆盖已有文件；
 *  · 单条失败后其余照搬 → 半批文件散落在新位置；
 *  · 工具没登记进 HANDLER_STAGED_TOOLS → 确认模式下它直接消失。
 *
 * 本脚本跑真实纯逻辑（preflight / reverse / summarize / actionForOp），再静态锁接线。
 *
 * 跑法：node --experimental-strip-types --no-warnings .AGENT/scripts/vault/verify-batch-move.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'
import {
  preflightMoves, normalizeVaultRel, reverseMoves, summarizeMoves, formatMoveConflicts,
  MAX_BATCH_MOVES, MAX_BATCH_MOVE_ITEMS_PER_MESSAGE,
} from '../../../electron/lib/vaultMovePure.ts'
import { actionForOp, selectOps } from '../../../electron/lib/aiAssistantPlanPure.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => stripComments(readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n'))

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

const probe = (files = [], dirs = []) => ({
  isFile: (r) => files.includes(r),
  isDir: (r) => dirs.includes(r),
  exists: (r) => files.includes(r) || dirs.includes(r),
})
const mv = (from, to) => ({ from, to })
const files = ['a.md', 'b.md', 'c.txt', 'd.md', 'x/a.md', 'y/a.md', 'AI教学/session/n.md']
const dirs = ['ch2', 'ch3', 'folder.md.bak']
const P = probe(files, dirs)

console.log('=== A. 路径归一 ===')
ok(normalizeVaultRel(' a\\\\b.md ') === 'a/b.md', 'A1 去空白 + 反斜杠归一')
ok(normalizeVaultRel('./a//b.md') === 'a/b.md', 'A2 去掉 `.` 与空段')
ok(normalizeVaultRel('../a.md') === null, 'A3 拒绝 `..` 越界')
ok(normalizeVaultRel('/abs/a.md') === null && normalizeVaultRel('C:/a.md') === null, 'A4 拒绝绝对路径 / 盘符')
ok(normalizeVaultRel('.knowbase/a.md') === null, 'A5 拒绝隐藏首段（.knowbase / .attachments）')
ok(normalizeVaultRel('') === null, 'A6 拒绝空路径')

console.log('\n=== B. 预检：合法批次 ===')
{
  const r = preflightMoves([mv('a.md', 'ch2'), mv('b.md', 'ch2/b-new.md'), mv('c.txt', 'ch3/c.txt')], P)
  ok(r.ok, 'B1 三条合法移动通过')
  ok(r.ok && r.moves[0].to === 'ch2/a.md', 'B2 目标是已存在目录 → 解析为 目录/原文件名', r.ok ? r.moves[0].to : r.conflicts[0]?.reason)
  ok(r.ok && r.moves[1].to === 'ch2/b-new.md', 'B3 目标是新文件路径 → 按新文件名')
  ok(r.ok && r.moves.length === 3, 'B4 一次工具调用 = 一整批（不是拆成三条）')
}

console.log('\n=== C. 预检：整批拒绝且返回全部冲突 ===')
ok(!preflightMoves([], P).ok, 'C1 空数组拒绝')
ok(!preflightMoves(Array.from({ length: MAX_BATCH_MOVES + 1 }, (_, i) => mv(`a${i}.md`, `ch2/a${i}.md`)), P).ok,
  `C2 超过 ${MAX_BATCH_MOVES} 条拒绝`)
{
  const r = preflightMoves([mv('a.md', 'ch2'), mv('a.md', 'ch3')], P)
  ok(!r.ok && r.conflicts.some((c) => c.reason.includes('from 重复')), 'C3 from 重复拒绝')
}
{
  const r = preflightMoves([mv('x/a.md', 'ch2'), mv('y/a.md', 'ch2')], P)
  ok(!r.ok && r.conflicts.some((c) => c.reason.includes('目标路径重复')), 'C4 解析后目标重复拒绝（x/a 与 y/a 都去 ch2）')
}
{
  const r = preflightMoves([mv('missing.md', 'ch2')], P)
  ok(!r.ok && r.conflicts[0].reason.includes('源不存在'), 'C5 源不存在拒绝')
}
{
  const r = preflightMoves([mv('folder.md', 'ch2')], P)
  ok(!r.ok && r.conflicts[0].reason.includes('不是文件'), 'C6 源是目录拒绝（isFile=false）')
}
{
  const r = preflightMoves([mv('a.pdf', 'ch2')], probe(['a.pdf'], dirs))
  ok(!r.ok && r.conflicts[0].reason.includes('.md'), 'C7 非 .md/.txt 拒绝')
}
{
  const r = preflightMoves([mv('a.md', 'b.md')], P)
  ok(!r.ok && r.conflicts[0].reason.includes('目标已存在'), 'C8 目标已存在拒绝（v1 不覆盖）')
}
{
  const r = preflightMoves([mv('a.md', 'A.md')], P)
  ok(!r.ok && r.conflicts[0].reason.includes('大小写'), 'C9 大小写-only 重命名拒绝')
}
{
  const r = preflightMoves([mv('a.md', 'AI教学/x.md')], P)
  ok(!r.ok && r.conflicts[0].reason.includes('受保护目录'), 'C10 AI 教学目录拒绝')
}
{
  const r = preflightMoves([mv('missing.md', 'ch2'), mv('a.pdf', 'ch2')], probe(['a.pdf'], dirs))
  ok(!r.ok && r.conflicts.length === 2, 'C11 失败时返回全部冲突（不是只报第一条）', `实得 ${r.conflicts.length}`)
}
{
  const r = preflightMoves([mv('a.md', 'ch2')], P, { resolveDirTargets: false })
  ok(!r.ok, 'C12 应用期 resolveDirTargets=false：`to` 必须已是最终文件路径（防止暂存后目录同名把文件搬进目录）')
}
{
  const msg = formatMoveConflicts([
    { index: 1, from: 'a.md', to: '', reason: 'from 缺失' },
    { index: 2, from: 'b.md', to: 'c.md', reason: '目标已存在' },
  ])
  ok(msg.includes('第 1 条') && msg.includes('第 2 条'), 'C13 错误文案按条编号，模型可逐条修正')
}

console.log('\n=== D. 回滚方向 / 摘要 ===')
{
  const moves = [mv('a.md', 'ch2/a.md'), mv('b.md', 'ch2/b.md')]
  const rev = reverseMoves(moves)
  ok(rev.length === 2 && rev[0].from === 'ch2/b.md' && rev[0].to === 'b.md', 'D1 逆序 + 反向')
  const summary = summarizeMoves(moves)
  ok(summary.includes('2 个文件') && summary.includes('ch2'), 'D2 摘要含数量与主要目标目录', summary)
  ok(MAX_BATCH_MOVE_ITEMS_PER_MESSAGE === 300, 'D3 单条消息累计上限 = 300')
}

console.log('\n=== E. ChangePlan 正反向 ===')
{
  const op = { id: 'm1', kind: 'move-batch', relPath: '', moves: [mv('a.md', 'ch2/a.md'), mv('b.md', 'ch2/b.md')], status: 'pending' }
  const ap = actionForOp(op, 'apply')
  ok(ap?.action === 'move-batch' && ap.moves?.[0]?.from === 'a.md' && ap.moves?.[1]?.to === 'ch2/b.md', 'E1 apply 保持原顺序')
  const rb = actionForOp(op, 'rollback')
  ok(rb?.action === 'move-batch' && rb.moves?.[0]?.from === 'ch2/b.md' && rb.moves?.[1]?.to === 'a.md', 'E2 rollback 逆序反向')
  ok(selectOps([op], ['m1'], 'apply').length === 1, 'E3 selectOps 把 move-batch 当普通 pending op')
}

console.log('\n=== F. 工具 / 暂存 / 方案卡接线 ===')
const bt = read('electron/lib/builtinTools.ts')
const stage = read('electron/lib/aiAssistantStageable.ts')
const svc = read('electron/lib/agentService.ts')
const plan = read('electron/lib/aiAssistantPlan.ts')
const review = read('src/modules/ai-assistant/ReviewPane.tsx')
const types = read('src/types/index.ts')
const planPure = read('electron/lib/aiAssistantPlanPure.ts')

ok(/name: 'builtin\.vault\.move'/.test(bt), 'F1 注册 builtin.vault.move')
ok(/name: 'builtin\.vault\.move'[\s\S]{0,1200}?tier: 'ondemand'/.test(bt), 'F2 tier=ondemand（默认折叠）')
ok(/name: 'builtin\.vault\.move'[\s\S]{0,1200}?requires: 'write'/.test(bt), 'F3 requires=write')
ok(/commitOrStage\(ctx, \(\) => \(\{ kind: 'move-batch'/.test(bt), 'F4 通过 commitOrStage 暂存为一条 op')
ok(/vault\.move \/ vault\.trash/.test(bt), 'F5 builtin.tool.request 清单包含 vault.move')
ok(/'builtin\.vault\.move'/.test(stage) && /HANDLER_STAGED_TOOLS/.test(stage),
  'F6 登记进 HANDLER_STAGED_TOOLS（否则确认模式直接看不到它）')
ok(/MAX_BATCH_MOVE_ITEMS_PER_MESSAGE/.test(svc) && /batchMoveItems/.test(svc),
  'F7 agentService 记账单条消息累计条目（300 硬上限）')
ok(/applyMoveBatch\(root, rootId, moves\)/.test(bt), 'F8 直接执行走 applyMoveBatch')
ok(/for \(const back of \[\.\.\.done\]\.reverse\(\)\)/.test(plan),
  'F9 单条失败逆序回滚已移动条目')
ok(/resolveDirTargets: false/.test(plan), 'F10 应用前再预检且不把 to 当目录二次解析')
ok(/action\?\.action === 'move-batch'[\s\S]{0,160}?rels\.push\(m\.from, m\.to\)/.test(plan),
  'F11 applyPlan 刷新所有 from/to 父目录')
ok(/op\.status = 'failed'/.test(plan) && /errors\.push/.test(plan),
  'F12 rollbackTask 单 op 失败不中断整任务（标 failed + 收错误）')
ok(/'move-batch'/.test(planPure) && /moves\?: MovePair\[\]/.test(planPure), 'F13 PlanOp 类型扩展')
ok(/kind: 'move-batch'|'move-batch'/.test(types), 'F14 渲染层 AiPlanOpKind 镜像')
ok(/'move-batch'/.test(review) && /MoveBatchView/.test(review), 'F15 ReviewPane 有 move-batch 视图分支')
ok(/op\.kind === 'move-batch'\) return op\.summary/.test(review), 'F16 方案卡标签用 summary，不拼 100 条路径')
ok(!/return op\.kind === 'write' \|\| op\.kind === 'edit' \|\| op\.kind === 'trash' \|\| op\.kind === 'move-batch'/.test(review),
  'F17 move-batch 不参与文本 diff')

/** 单工具 inputSchema 真实发包字符数（同 measure-tool-schema 口径） */
function schemaCharsOf(src, name) {
  const at = src.indexOf(`name: '${name}'`)
  if (at < 0) return -1
  const sAt = src.indexOf('inputSchema:', at)
  const start = src.indexOf('{', sAt)
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        return src.slice(start, i + 1).split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trim()).join('').length
      }
    }
  }
  return -1
}
{
  const chars = schemaCharsOf(bt, 'builtin.vault.move')
  ok(chars > 0 && chars <= 800, 'F18 单工具 schema ≤ 800 字符', `实得 ${chars}`)
}

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
