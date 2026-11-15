// 契约脚本：目录操作与批量移动（P0-A / v3.31.0）
// 覆盖：目录改名/移动/删除的准入与保护、批量移动的目录支持、自嵌套/成环拒绝。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: M, dir } = await loadTsModule(join(ROOT, 'electron/lib/vaultMovePure.ts'))

// fs 事实桩：文件 / 目录集合
const probe = (files = [], dirs = []) => ({
  isFile: (r) => files.includes(r),
  isDir: (r) => dirs.includes(r),
  exists: (r) => files.includes(r) || dirs.includes(r),
})

const anyType = { allowDirs: true, allowSource: () => true, allowTarget: () => true }

// ── ① 目录移动（allowDirs）─────────────────────────────────────────────────────
{
  const r = M.preflightMoves([{ from: '旧目录', to: '新目录' }], probe([], ['旧目录', '旧目录/a.md', '旧目录/b.md']), anyType)
  ok('目录改名允许', r.ok && r.moves[0].to === '新目录', JSON.stringify(r))
}
{
  const r = M.preflightMoves([{ from: '旧目录', to: '归档' }], probe([], ['旧目录', '归档']), anyType)
  ok('目录移入已存在目录保留名字', r.ok && r.moves[0].to === '归档/旧目录', JSON.stringify(r))
}
{
  const r = M.preflightMoves([{ from: 'a', to: 'a/b' }], probe([], ['a']), anyType)
  ok('目录搬进自身子树拒绝', !r.ok && /子目录/.test(r.conflicts[0].reason), JSON.stringify(r))
}
{
  const r = M.preflightMoves([{ from: 'a', to: 'b' }], probe([], ['a', 'b']), { ...anyType, resolveDirTargets: false })
  ok('目标目录已存在（明确按新路径解析时）拒绝', !r.ok && /已存在/.test(r.conflicts[0].reason), JSON.stringify(r))
}
{
  // 缺省（旧语义）仍拒绝目录
  const r = M.preflightMoves([{ from: 'dir', to: 'dir2' }], probe([], ['dir']), { resolveDirTargets: false })
  ok('未开 allowDirs 时目录仍拒绝（旧语义保留）', !r.ok, JSON.stringify(r))
}
{
  const r = M.preflightMoves(
    [{ from: '甲', to: '丙' }, { from: '乙', to: '甲/乙' }],
    probe([], ['甲', '乙']),
    anyType,
  )
  ok('目标落在另一条移动的源子树内 → 整批拒绝（成环）', !r.ok && /成环|子树/.test(r.conflicts[0].reason), JSON.stringify(r))
}
{
  const r = M.preflightMoves(
    [{ from: '父/子', to: 'x' }, { from: '父', to: 'y' }],
    probe([], ['父', '父/子']),
    anyType,
  )
  ok('祖孙重叠移动整批拒绝（父搬走后子路径失效）', !r.ok && /祖孙/.test(r.conflicts[0].reason), JSON.stringify(r))
}
{
  const r = M.preflightMoves([{ from: 'AI教学/课', to: 'x' }], probe([], ['AI教学', 'AI教学/课']), anyType)
  ok('受保护根（AI 教学）拒绝', !r.ok && /受保护/.test(r.conflicts[0].reason), JSON.stringify(r))
}
{
  const r = M.preflightMoves([{ from: 'a.md', to: 'b.md' }], probe(['a.md', 'b.md']), anyType)
  ok('文件目标已存在不覆盖', !r.ok && /已存在/.test(r.conflicts[0].reason))
}
{
  const r = M.preflightMoves([{ from: 'a.ts', to: 'b.ts' }], probe(['a.ts']), { allowSource: () => true, allowTarget: () => true })
  ok('非 md/txt 文件在自定义策略下可移动', r.ok && r.moves[0].to === 'b.ts')
}

// ── ② 工具接线（源码断言）──────────────────────────────────────────────────────
const bt = readFileSync(join(ROOT, 'electron/lib/builtinTools.ts'), 'utf8')
ok('vault.rename 支持目录（statKind 判定 + evaluateAiDir）', /const oldKind = statKind\(oldAbs\)/.test(bt) && /assertAiDirWritable\(root, rel\)/.test(bt))
ok('目录纯改名走分类通道（保住 space/notebook）', /vaultRenameCategory\(cat\.id/.test(bt) && /findCategoryByPath/.test(bt))
ok('vault.trash 目录需 recursive:true', /删除目录必须显式传 recursive:true/.test(bt))
ok('vault.trash 保护仓库根 / SOURCES / AI 教学根', /不能删除仓库根目录/.test(bt) && /SOURCES\/ 是只读素材目录/.test(bt) && /AI 教学目录受保护/.test(bt))
ok('vault.trash 目录在确认模式标不可回滚', /不可自动回滚/.test(bt) && /stageToolOp\(ctx/.test(bt))
ok('vault.mkdir 存在则报错（不自动加后缀）', /路径已存在/.test(bt))
ok('vault.move 放开目录与策略判定', /allowDirs: true/.test(bt) && /allowSource: \(rel, kind\)/.test(bt))
ok('目录操作登记整棵自写（markSelfWriteTree）', readFileSync(join(ROOT, 'electron/lib/workspaceManager.ts'), 'utf8').includes('markSelfWriteTree'))
ok('欢迎页保护：可原地写、禁改名/移动/删除', /欢迎页只能原地编辑，不能改名或移动/.test(bt) && /欢迎页只能原地编辑，不能删除/.test(bt))

rmSync(dir, { recursive: true, force: true })
report('verify-vault-dir-tools')
