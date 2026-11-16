// 契约脚本：批量写入 vault.write-batch（P1-7）
// 覆盖：PlanOp 正/反向文件动作、运行 journal 撤销判定、原子写回滚、工具接线、预览面板。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: P } = await loadTsModule(join(ROOT, 'electron/lib/aiAssistantPlanPure.ts'))
const { mod: J } = await loadTsModule(join(ROOT, 'electron/lib/runJournalPure.ts'))
const { mod: S } = await loadTsModule(join(ROOT, 'electron/lib/aiAssistantStageable.ts'))

const op = {
  id: 'op1',
  kind: 'write-batch',
  relPath: 'a.md',
  status: 'pending',
  writes: [
    { relPath: 'a.md', prev: 'old A', next: 'new A', codec: { eol: '\n' } },
    { relPath: 'b.md', prev: null, next: 'new B', codec: { eol: '\r\n' } },
    { relPath: 'c.md', prev: 'old C', next: 'new C' },
  ],
}

// ── ① 方案动作（应用 / 回滚） ────────────────────────────────────────────────
{
  const apply = P.actionForOp(op, 'apply')
  ok('应用 = 正向写 next', apply.action === 'write-batch' && apply.writes.length === 3)
  ok('应用条目 content=next / inverse=prev', apply.writes[0].content === 'new A' && apply.writes[0].inverse === 'old A')
  ok('新建文件 inverse=null（回滚要移除）', apply.writes[1].inverse === null)
  ok('应用保留原顺序', apply.writes.map((w) => w.relPath).join(',') === 'a.md,b.md,c.md')
  ok('应用保留各文件编码元信息', apply.writes[0].codec?.eol === '\n' && apply.writes[1].codec?.eol === '\r\n')

  const back = P.actionForOp(op, 'rollback')
  ok('回滚 = 逆序', back.writes.map((w) => w.relPath).join(',') === 'c.md,b.md,a.md')
  ok('回滚 content=prev', back.writes[0].content === 'old C' && back.writes[2].content === 'old A')
  ok('回滚新建文件 content=null / inverse=next', back.writes[1].content === null && back.writes[1].inverse === 'new B')
  ok('回滚新文件在中间位置', back.writes[1].relPath === 'b.md')
}

// ── ② 运行 journal：撤销判定 ──────────────────────────────────────────────────
{
  const jop = {
    seq: 1,
    kind: 'write-batch',
    relPath: 'a.md',
    writes: [
      { relPath: 'a.md', prev: 'old A', nextHash: 'h1' },
      { relPath: 'b.md', prev: null, nextHash: 'h2' },
    ],
  }
  const good = { exists: () => true, hash: (rel) => (rel === 'a.md' ? 'h1' : 'h2') }
  ok('全部未改过 → 可撤销', J.undoBlockReason(jop, good) === null)
  const changed = { exists: () => true, hash: (rel) => (rel === 'a.md' ? 'h1' : 'CHANGED') }
  const blocker = J.undoBlockReason(jop, changed)
  ok('任一文件被改 → 整批跳过并指出路径', typeof blocker === 'string' && blocker.includes('b.md') && blocker.includes('运行后文件已被修改'))
  const missing = { exists: (rel) => rel !== 'a.md', hash: () => 'h1' }
  ok('文件被删 → 整批跳过', /a\.md/.test(J.undoBlockReason(jop, missing)) && /文件已被删除/.test(J.undoBlockReason(jop, missing)))
  const noHash = { exists: () => true, hash: () => 'x' }
  ok('缺指纹 → 跳过', /缺少运行后的内容指纹/.test(J.undoBlockReason({ ...jop, writes: [{ relPath: 'a.md', prev: 'old' }] }, noHash)))
  ok('空清单 → 跳过', J.undoBlockReason({ ...jop, writes: [] }, good) === '记录缺少文件清单')
  ok('write-batch 可记账', J.isJournalableKind('write-batch'))
  ok('面板标签正确', J.journalOpLabel(jop) === '批量写入 2 个文件')
  ok('撤销顺序仍是逆序', J.undoOrder([jop, { seq: 2, kind: 'write', relPath: 'x.md' }])[0].seq === 2)
}

// ── ③ 原子写与回滚（源码契约） ────────────────────────────────────────────────
const plan = readFileSync(join(ROOT, 'electron/lib/aiAssistantPlan.ts'), 'utf8')
ok('导出 applyWriteBatch', /export async function applyWriteBatch\(/.test(plan))
ok('顺序写入 + 失败逆序回滚', /for \(const back of \[\.\.\.done\]\.reverse\(\)\)/.test(plan))
ok('回滚用 inverse 内容', /writeWorkspaceFile\(backAbs, back\.inverse/.test(plan))
ok('回滚新建文件走回收站', /if \(existsSync\(backAbs\)\) await trashWorkspacePath\(rootId, back\.relPath\)/.test(plan))
ok('回滚不干净时如实报告', /个回滚失败：/.test(plan) && /整批未应用/.test(plan))
ok('runAction 支持 write-batch', /case 'write-batch':\s*\n\s*await applyWriteBatch/.test(plan))
ok('applyPlan 刷新批量写入的所有路径', /action\?\.action === 'write-batch'[\s\S]{0,120}rels\.push\(w\.relPath\)/.test(plan))
ok('rollbackTask 刷新批量写入的所有路径', /回滚失败可能留下部分移动[\s\S]{0,200}write-batch/.test(plan))

// ── ④ 工具：校验 / 暂存 / 预览 ────────────────────────────────────────────────
const bt = readFileSync(join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')
ok('工具已注册（ondemand / write / vaultFile）', /name: 'builtin\.vault\.write-batch'/.test(bt) && /vaultFile: 'write'/.test(bt))
ok('单批上限 20', /maxItems: 20/.test(bt) && /一次最多批量写入 20 个文件/.test(bt))
ok('拒绝重复路径', /重复路径：\$\{rel\}/.test(bt))
ok('逐条走策略 / 大小 / 冲突校验', /assertCanWrite\(rel, ctx\)/.test(bt) && /assertAiWritable\(root, abs, item\?\.expectedMtimeMs/.test(bt))
ok('逐条解码编码元信息', /const dec = decodeTextFile\(existingBuf, \{ encoding: explicit \}\)/.test(bt))
ok('NUL 内容拒写', /内容含 NUL 字符，拒绝写入/.test(bt))
ok('暂存为一条 write-batch op', /kind: 'write-batch'/.test(bt) && /writes, summary/.test(bt))
ok('直接执行走 applyWriteBatch', /applyWriteBatch\(root, rootId, writes\.map/.test(bt))
ok('失败也刷新界面（回滚后的实际状态）', /refreshWritten\(\) \/\/ 中途失败已逆序回滚/.test(bt))

ok('确认模式白名单已登记', S.isStageableWriteTool('builtin.vault.write-batch') === true)
ok('确认模式不会隐藏该工具', S.isConfirmModeHiddenTool('builtin.vault.write-batch', 'write') === false)

const svc = readFileSync(join(ROOT, 'electron/lib/agentService.ts'), 'utf8')
ok('本次改动标签', /'builtin\.vault\.write-batch': '批量写入文件'/.test(svc))
ok('本次改动逐文件展开', /realName === 'builtin\.vault\.write-batch' && Array\.isArray\(data\.files\)/.test(svc))

const labels = readFileSync(join(ROOT, 'src/lib/toolLabels.ts'), 'utf8')
ok('工具动作标签', /'builtin\.vault\.write-batch': '批量写入'/.test(labels))

const types = readFileSync(join(ROOT, 'src/types/index.ts'), 'utf8')
ok('渲染层 op 类型含 write-batch', /'move-batch' \| 'write-batch'/.test(types) && /writes\?: Array<\{ relPath: string; prev: string \| null; next: string \}>/.test(types))

const review = readFileSync(join(ROOT, 'src/modules/ai-assistant/ReviewPane.tsx'), 'utf8')
ok('预览面板有批量写入视图', /function WriteBatchView/.test(review) && /selected\.kind === 'write-batch'/.test(review))
ok('文件切换条 + 单文件 diff', /writes\.map\(\(w, i\)/.test(review) && /original=\{cur\.prev \?\? ''\}/.test(review))
ok('面板标签', /批量写入 \$\{op\.writes\?\.length \?\? 0\} 个文件/.test(review))

const journal = readFileSync(join(ROOT, 'electron/lib/runJournal.ts'), 'utf8')
ok('journal 记录批量写入条目', /writes: input\.kind === 'write-batch'/.test(journal))
ok('落盘后逐文件记指纹', /for \(const w of op\.writes \?\? \[\]\)/.test(journal))
ok('撤销逆序还原每个文件', /for \(const w of \[\.\.\.\(op\.writes \?\? \[\]\)\]\.reverse\(\)\)/.test(journal))

report('批量写入 vault.write-batch（P1-7）')
