// 契约脚本：AI 运行 journal 与「撤销本次运行」（P1-1）
// 覆盖：撤销顺序、冲突跳过口径（运行后又被改过不覆盖）、删除快照缺失、保留期上限、工具与 UI 接线。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: M } = await loadTsModule(join(ROOT, 'electron/lib/runJournalPure.ts'))

const probe = (files = {}, dirs = []) => ({
  exists: (rel) => Object.prototype.hasOwnProperty.call(files, rel) || dirs.includes(rel),
  hash: (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null),
})

// ── ① 撤销顺序 ────────────────────────────────────────────────────────────────
{
  const ops = [
    { seq: 1, kind: 'write', relPath: 'a.md' },
    { seq: 2, kind: 'edit', relPath: 'b.md' },
    { seq: 3, kind: 'trash', relPath: 'c.md' },
  ]
  const order = M.undoOrder(ops)
  ok('撤销逆序执行', order.map((o) => o.seq).join(',') === '3,2,1', order.map((o) => o.seq).join(','))
}
{
  const ops = [
    { seq: 1, kind: 'write', relPath: 'a.md', undone: true },
    { seq: 2, kind: 'edit', relPath: 'b.md' },
  ]
  ok('已撤销的项不重放', M.undoOrder(ops).map((o) => o.seq).join(',') === '2')
}

// ── ② 冲突判定：运行后又被改过 → 跳过 ─────────────────────────────────────────
{
  const op = { kind: 'write', relPath: 'a.md', prev: 'old', nextHash: 'h-new' }
  ok('覆写：内容未变可撤销', M.undoBlockReason(op, probe({ 'a.md': 'h-new' })) === null)
  ok('覆写：内容变了跳过（不覆盖用户修改）', /修改/.test(M.undoBlockReason(op, probe({ 'a.md': 'h-user' })) ?? ''))
  ok('覆写：文件已被删 → 跳过（不擅自复活）', /删除/.test(M.undoBlockReason(op, probe({})) ?? ''))
}
{
  const op = { kind: 'write', relPath: 'new.md', prev: null, nextHash: 'h-new' }
  ok('新建：内容未变可撤销', M.undoBlockReason(op, probe({ 'new.md': 'h-new' })) === null)
  ok('新建：内容变了跳过', /修改/.test(M.undoBlockReason(op, probe({ 'new.md': 'h-user' })) ?? ''))
  ok('新建：文件已不在原位置跳过', /不在/.test(M.undoBlockReason(op, probe({})) ?? ''))
}
{
  const op = { kind: 'edit', relPath: 'a.md', prev: 'old', nextHash: 'h-new' }
  ok('编辑：内容未变可撤销', M.undoBlockReason(op, probe({ 'a.md': 'h-new' })) === null)
}
{
  const op = { kind: 'rename', relPath: 'a.md', to: 'b.md' }
  ok('移动：目标仍在、原位空 → 可撤销', M.undoBlockReason(op, probe({ 'b.md': 'h' })) === null)
  ok('移动：目标已不在 → 跳过', /不在/.test(M.undoBlockReason(op, probe({ 'a.md': 'h' })) ?? ''))
  ok('移动：原位已有同名 → 跳过', /同名/.test(M.undoBlockReason(op, probe({ 'a.md': 'h', 'b.md': 'h' })) ?? ''))
}
{
  const op = { kind: 'move-batch', moves: [{ from: 'a', to: 'x' }, { from: 'b', to: 'y' }] }
  ok('批量移动：全部到位 → 可撤销', M.undoBlockReason(op, probe({ x: 'h', y: 'h' })) === null)
  ok('批量移动：任一未到位整批跳过', /不在/.test(M.undoBlockReason(op, probe({ x: 'h' })) ?? ''))
  ok('批量移动：原位被占整批跳过', /同名/.test(M.undoBlockReason(op, probe({ a: 'h', x: 'h', y: 'h' })) ?? ''))
}
{
  ok('删除：有快照且原位空 → 可恢复', M.undoBlockReason({ kind: 'trash', relPath: 'a.md', snapshot: '0001-a.md' }, probe({})) === null)
  ok('删除：无快照（如目录删除）→ 跳过', /快照/.test(M.undoBlockReason({ kind: 'trash', relPath: 'a.md' }, probe({})) ?? ''))
  ok('删除：原位已有同名 → 不覆盖', /同名/.test(M.undoBlockReason({ kind: 'trash', relPath: 'a.md', snapshot: 's' }, probe({ 'a.md': 'h' })) ?? ''))
}

// ── ③ 保留期 ──────────────────────────────────────────────────────────────────
{
  const now = Date.parse('2026-11-16T00:00:00.000Z')
  const mk = (runId, daysAgo, bytes = 100) => ({ runId, finishedAt: new Date(now - daysAgo * 86400000).toISOString(), bytes })
  const newestHuge = M.expiredRunIds([mk('newest', 0, 999999999)], { keepRuns: 1, keepDays: 1, maxBytes: 1 }, now)
  ok('最新一次永远保留（即使超容量）', newestHuge.length === 0, JSON.stringify(newestHuge))

  const overCount = M.expiredRunIds([mk('a', 0), mk('b', 1), mk('c', 2), mk('d', 3)], { keepRuns: 2, keepDays: 30, maxBytes: 1e9 }, now)
  ok('超过保留次数从最旧清理', overCount.sort().join(',') === 'c,d', overCount.join(','))

  const overAge = M.expiredRunIds([mk('a', 0), mk('b', 10), mk('c', 20)], { keepRuns: 10, keepDays: 7, maxBytes: 1e9 }, now)
  ok('超过保留天数清理', overAge.sort().join(',') === 'b,c', overAge.join(','))

  const overSize = M.expiredRunIds([mk('a', 0, 60), mk('b', 1, 60), mk('c', 2, 60)], { keepRuns: 10, keepDays: 30, maxBytes: 100 }, now)
  ok('总量超上限从最旧清理', overSize.sort().join(',') === 'b,c', overSize.join(','))
}

// ── ④ 快照命名 ────────────────────────────────────────────────────────────────
{
  ok('快照名补零且只取基名', M.snapshotFileName(3, '目录/子目录/a.md') === '0003-a.md', M.snapshotFileName(3, '目录/子目录/a.md'))
  ok('快照名不带目录分隔符的其他形态', !M.snapshotFileName(1, 'a\\b.md').includes('\\'), M.snapshotFileName(1, 'a\\b.md'))
}
{
  ok('可记账类型白名单', M.isJournalableKind('write') && M.isJournalableKind('trash') && !M.isJournalableKind('mkdir') && !M.isJournalableKind('tool'))
}

// ── ⑤ 接线（源码断言）─────────────────────────────────────────────────────────
const commit = readFileSync(join(ROOT, 'electron/lib/aiAssistantCommit.ts'), 'utf8')
ok('提交岔口：propose 分支先返回（不进 journal）', commit.indexOf('if (isPropose(ctx))') >= 0 && commit.indexOf('beginRunOp(ctx.runId') > commit.indexOf('if (isPropose(ctx))'))
ok('提交岔口：直接执行落盘前 begin、成功后 commit、失败 abort', /beginRunOp\(ctx\.runId/.test(commit) && /commitRunOp\(pending\)/.test(commit) && /abortRunOp\(pending\)/.test(commit))
ok('提交岔口：journal 失败不影响真实写盘', /commitRunOp\(pending\) \} catch/.test(commit))

const svc = readFileSync(join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
ok('Agent 循环每次运行分配 runId', /const runId = randomUUID\(\)/.test(svc) && /runAgentLoopInner\(/.test(svc))
ok('两次工具执行都注入 runId', (svc.match(/runId: opts\?\.runId/g) ?? []).length === 2)
ok('运行结束挂 journal 摘要', /summary = finishRun\(runId\)/.test(svc) && /journal: summary/.test(svc))
ok('IPC 撤销通道已注册', /ipcMain\.handle\('aiJournal:undo'/.test(svc))

const builtin = readFileSync(join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')
ok('六类文件写操作统一经 commitOrStage', (builtin.match(/return commitOrStage\(ctx/g) ?? []).length >= 6)

const preload = readFileSync(join(ROOT, 'electron/preload/index.ts'), 'utf8')
const ipc = readFileSync(join(ROOT, 'src/lib/ipc.ts'), 'utf8')
const types = readFileSync(join(ROOT, 'src/types/index.ts'), 'utf8')
ok('preload 暴露 aiJournalUndo', /aiJournalUndo:/.test(preload) && /aiJournal:undo/.test(preload))
ok('渲染层 IPC 封装 aiJournalUndo', /export const aiJournalUndo/.test(ipc))
ok('共享类型含 journal / 撤销回执', /journal\?: RunJournalSummary/.test(types) && /interface AgentRunUndoResult/.test(types))

const hook = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/useAssistantChat.ts'), 'utf8')
ok('控制器暴露 lastRun / undoRun', /lastRun: RunJournalSummary \| null/.test(hook) && /undoRun: \(\) => Promise<void>/.test(hook))
ok('失败/中止也保留可撤销入口', /if \(r\.journal\) setLastRun\(r\.journal\)/.test(hook))

const body = readFileSync(join(ROOT, 'src/components/shared/AssistantPanel/ChatBody.tsx'), 'utf8')
ok('改动卡带「撤销本次运行」', /撤销本次运行/.test(body) && /void undoRun\(\)/.test(body))

const settings = readFileSync(join(ROOT, 'src/lib/settings.ts'), 'utf8')
ok('保留上限三项设置已登记', /agentRunUndoKeepRuns/.test(settings) && /agentRunUndoKeepDays/.test(settings) && /agentRunUndoMaxMb/.test(settings))

const journal = readFileSync(join(ROOT, 'electron/lib/runJournal.ts'), 'utf8')
ok('删除先快照到 .knowbase/agent/undo/<runId>/', /join\(kb, 'agent', 'undo'\)/.test(journal) && /writeFileSync\(snapAbs, buf\)/.test(journal))
ok('journal 落盘到 .knowbase/agent/journal/<runId>.json', /join\(kb, 'agent', 'journal'\)/.test(journal) && /JSON\.stringify\(journal/.test(journal))
ok('撤销前校验仓库 rootId', /journal\.rootId !== cur\.rootId/.test(journal))
ok('目录改名撤销走分类通道', /vaultRenameCategory\(cat\.id, basename\(rel\)\)/.test(journal))

report('运行 journal / 撤销本次运行（P1-1）')
