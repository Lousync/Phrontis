// 契约脚本：三层权限矩阵（P0-B / v3.31.0）
// 覆盖：全局 off/read/write × 工作区 allow/deny/null × 终端模块闸门 + 工具可见性语义。
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { loadTsModule, ok, report } from '../shared/ts-module.mjs'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const { mod: P, dir } = await loadTsModule(join(ROOT, 'electron/lib/aiPermissionPure.ts'))

const T = (fileWrite, shellExec) => ({ fileWrite, shellExec })
const run = (globalFilePerm, globalExec, trust, extra = {}) =>
  P.evaluatePermission({ globalFilePerm, globalExec, trust, ...extra })

// ── ① 文件读写 ─────────────────────────────────────────────────────────────────
const cases = [
  // global, trust.fileWrite, expectRead, expectWrite
  ['off', 'allow', false, false],
  ['off', null, false, false],
  ['read', 'allow', true, true],
  ['read', 'deny', true, false],
  ['read', null, true, false],
  ['write', 'allow', true, true],
  ['write', 'deny', true, false],
  ['write', null, true, true],
]
for (const [g, t, er, ew] of cases) {
  const s = run(g, false, T(t, null))
  ok(`文件 ${g} × ${t} → read=${er} write=${ew}`, s.fileRead === er && s.fileWrite === ew, JSON.stringify(s))
}

// ── ② 终端 ─────────────────────────────────────────────────────────────────────
const execCases = [
  [false, 'allow', true],
  [false, 'deny', false],
  [false, null, false],
  [true, 'allow', true],
  [true, 'deny', false],
  [true, null, true],
]
for (const [g, t, expect] of execCases) {
  const s = run('read', g, T(null, t))
  ok(`终端 aiExec=${g} × ${t} → exec=${expect}`, s.exec === expect, JSON.stringify(s))
}
ok('终端模块 off 硬否决（即使 trust allow）', run('read', true, T(null, 'allow'), { terminalModuleOff: true }).exec === false)

// ── ③ 工具可见性（关键取舍）─────────────────────────────────────────────────────
ok('trust=null 时写工具仍进模型视野', run('read', false, T(null, null)).writeToolsVisible === true)
ok('trust=deny 时写工具不可见', run('read', false, T('deny', null)).writeToolsVisible === false)
ok('全局 off 时写工具不可见', run('off', false, T('allow', 'allow')).writeToolsVisible === false)
ok('trust=null + aiExec=false → 终端工具不可见', run('read', false, T(null, null)).execToolsVisible === false)
ok('trust=allow → 终端工具可见', run('read', false, T(null, 'allow')).execToolsVisible === true)
ok('terminal 模块 off → 终端工具不可见', run('read', true, T(null, 'allow'), { terminalModuleOff: true }).execToolsVisible === false)

// ── ④ 一次性询问判定 ───────────────────────────────────────────────────────────
ok('两层都未表态 → 需要一次性卡', run('read', false, T(null, null)).needsTrustPrompt === true)
ok('写已授权、命令未表态 → 仍需要卡', run('read', false, T('allow', null)).needsTrustPrompt === true)
ok('两层都明确允许 → 不再询问', run('read', false, T('allow', 'allow')).needsTrustPrompt === false)
ok('两层都明确拒绝 → 不再询问', run('read', false, T('deny', 'deny')).needsTrustPrompt === false)
ok('全局 write + aiExec 开 → 默认已授权，不弹卡', run('write', true, T(null, null)).needsTrustPrompt === false)
ok('全局 write + aiExec 关 → 只为命令弹卡', run('write', false, T(null, null)).pendingFileTrust === false && run('write', false, T(null, null)).pendingExecTrust === true)
ok('只读标记', run('read', false, T('deny', 'deny')).readOnlyMarked === true)
ok('未表态不标只读', run('read', false, T(null, null)).readOnlyMarked === false)

// ── ⑤ 归一化 ───────────────────────────────────────────────────────────────────
ok('trustAll 同时授予两项', P.trustAll().fileWrite === 'allow' && P.trustAll().shellExec === 'allow')
ok('trustReadOnly 同时拒绝两项', P.trustReadOnly().fileWrite === 'deny' && P.trustReadOnly().shellExec === 'deny')
ok('非法 trust 值归一为 null', P.normalizeTrustLevel('yes') === null && P.normalizeTrustLevel(undefined) === null)
ok('损坏的 trust 对象归一为默认', JSON.stringify(P.normalizeWorkspaceTrust({ fileWrite: 'x' })) === JSON.stringify(P.DEFAULT_WORKSPACE_TRUST))

rmSync(dir, { recursive: true, force: true })
report('verify-ai-permission')
