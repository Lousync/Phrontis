/**
 * 契约验证：AI 教学「文档 / 画像」IPC 写通道（2026-11-22 AI 教学 UI 批次，C 线）。
 *
 * 锁的是三条写通道的**固定顺序**与**冲突口径**（铁律 4）：
 *   结课守卫 → detectConflict → 写盘 → statSync → broadcastTreeRefresh
 *   ① aiTeachWriteConstraints（CONSTRAINTS.md）
 *   ② aiTeachProfileWriteSession（会话 PROFILE.md）
 *   ③ aiTeachEnsureConstraints（懒建目录 + 空文件；幂等 + 创建前守卫）
 *
 * 断言方式：**源码结构断言**（真实实现 + 顺序位置），不碰用户 vault ——
 * 这些函数依赖 electron / fs / 当前仓库，无法在纯 node 里安全执行。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/ai-teaching/verify-doc-ipc.mjs [仓库路径]
 * 期望：全部 PASS 且 exit=0
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 截取 `startMarker` 到 `endMarker` 之间的源码（任一缺失 → 空串，后续断言自然 FAIL） */
function bodyOf(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  if (i < 0) return ''
  const j = src.indexOf(endMarker, i + startMarker.length)
  return j < 0 ? src.slice(i) : src.slice(i, j)
}

/** 断言 tokens 在 body 中按给定顺序出现（前后顺序即执行顺序） */
function orderCheck(body, tokens) {
  const idx = tokens.map((t) => body.indexOf(t))
  const bad = []
  for (let i = 0; i < idx.length; i++) {
    if (idx[i] < 0) bad.push(`缺少 ${tokens[i]}`)
    else if (i > 0 && idx[i] <= idx[i - 1]) bad.push(`${tokens[i]} 不在 ${tokens[i - 1]} 之后`)
  }
  return { pass: bad.length === 0, detail: bad.join('；') }
}

const WRITE_ORDER = ['assertCourseEditableBySession', 'detectConflict', 'writeFileSync', 'statSync', 'broadcastTreeRefresh']

const folders = read('electron/lib/aiTeachingFolders.ts')
const profile = read('electron/lib/aiTeachingProfile.ts')
const wm = read('electron/lib/workspaceManager.ts')
const preload = read('electron/preload/index.ts')
const ipc = read('src/lib/ipc.ts')
const types = read('src/types/index.ts')

// ---------------------------------------------------------------- 1. 三条写通道的顺序
console.log('\n=== 1. 写通道顺序：守卫 → 冲突 → 写盘 → stat → 刷新 ===')

const constraintsWrite = bodyOf(folders, 'export function writeConstraints(', '/** ensure 结果')
{
  const r = orderCheck(constraintsWrite, WRITE_ORDER)
  check('① writeConstraints：五步顺序固定', r.pass, r.detail)
  check('① 冲突时回磁盘内容（diskText）且不写盘先行返回',
    /chk\.conflict[\s\S]{0,220}diskText[\s\S]{0,120}return \{ ok: false[^}]*conflict: true/.test(constraintsWrite))
  check('① 未传基线时交给 detectConflict 放行（opts?.expectedMtimeMs）',
    /detectConflict\([^,]+,\s*opts\?\.expectedMtimeMs\)/.test(constraintsWrite))
  check('① 写盘后回 mtimeMs（下一次写的基线）', /mtimeMs = statSync\(abs\)\.mtimeMs/.test(constraintsWrite))
}

const profileWrite = bodyOf(profile, 'export function writeSessionProfile(', '/** 可选知识点画像')
{
  const r = orderCheck(profileWrite, WRITE_ORDER)
  check('② writeSessionProfile：五步顺序固定', r.pass, r.detail)
  check('② 冲突时回磁盘内容（diskText）且不写盘先行返回',
    /chk\.conflict[\s\S]{0,220}diskText[\s\S]{0,120}return \{ ok: false[^}]*conflict: true/.test(profileWrite))
  check('② 未传基线时交给 detectConflict 放行（opts?.expectedMtimeMs）',
    /detectConflict\([^,]+,\s*opts\?\.expectedMtimeMs\)/.test(profileWrite))
  check('② 写盘后回 mtimeMs（下一次写的基线）', /mtimeMs = statSync\(abs\)\.mtimeMs/.test(profileWrite))
}

const ensure = bodyOf(folders, 'export function ensureConstraints(', '// ===== 全局约束层')
{
  check('③ ensureConstraints：两次写盘前都有存在性判断（幂等只读返回）',
    (ensure.match(/if \(existsSync\(abs\)\) return \{ ok: true, relPath, created: false \}/g) || []).length === 2)
  const firstWrite = ensure.indexOf('writeFileSync')
  check('③ ensureConstraints：守卫在首次写盘之前',
    ensure.indexOf('assertCourseEditableBySession') > -1 && ensure.indexOf('assertCourseEditableBySession') < firstWrite)
  const r = orderCheck(ensure, ['writeFileSync', 'broadcastTreeRefresh'])
  check('③ ensureConstraints：建文件后才广播树刷新', r.pass, r.detail)
  check('③ ensureConstraints：created 区分「本次建」与「已存在」',
    ensure.includes('created: true') && ensure.includes('created: false'))
}

// ---------------------------------------------------------------- 2. expectedMtimeMs 不传 = 旧行为
console.log('\n=== 2. expectedMtimeMs 不传时行为完全不变 ===')
check('detectConflict：未传 / 非正数基线 → 恒放行（conflict:false）',
  /typeof expectedMtimeMs !== 'number' \|\| expectedMtimeMs <= 0\)\s*return \{ conflict: false \}/.test(wm))
check('两个写函数 opts 全程可选（opts?: { expectedMtimeMs?: number }）',
  (folders.match(/opts\?: \{ expectedMtimeMs\?: number \}/g) || []).length >= 1 &&
  (profile.match(/opts\?: \{ expectedMtimeMs\?: number \}/g) || []).length >= 1)
check('冲突分支只在 chk.conflict 为真时进入（老调用无基线 → 直写）',
  (folders.match(/if \(chk\.conflict\)/g) || []).length === 1 &&
  (profile.match(/if \(chk\.conflict\)/g) || []).length === 1)

// ---------------------------------------------------------------- 3. 读回 mtimeMs
console.log('\n=== 3. 读通道回 mtimeMs（下一次写的基线） ===')
const constraintsRead = bodyOf(folders, 'export function readConstraints(', '/**')
check('readConstraints：文件存在时 statSync 回 mtimeMs',
  /mtimeMs: statSync\(p\)\.mtimeMs/.test(constraintsRead))
const profileRead = bodyOf(profile, 'export function readSessionProfile(', '/**\n * 写会话画像')
check('readSessionProfile：文件存在时 statSync 回 mtimeMs',
  /mtimeMs: statSync\(p\)\.mtimeMs/.test(profileRead))

// ---------------------------------------------------------------- 4. IPC 三处接线
console.log('\n=== 4. main handler → preload → types → ipc.ts ===')
check('main：注册 aiTeach:ensureConstraints',
  folders.includes("ipcMain.handle('aiTeach:ensureConstraints'"))
check('main：aiTeach:writeConstraints 转发 opts',
  folders.includes("ipcMain.handle('aiTeach:writeConstraints', (_e, sessionId: string, text: string, opts?: { expectedMtimeMs?: number }) =>") &&
  folders.includes("writeConstraints(String(sessionId ?? ''), String(text ?? ''), getSetting, opts)"))
check('main：aiTeachProfile:writeSession 转发 opts',
  profile.includes("ipcMain.handle('aiTeachProfile:writeSession', (_e, sessionId: string, text: string, opts?: { expectedMtimeMs?: number }) =>") &&
  profile.includes("writeSessionProfile(String(sessionId ?? ''), String(text ?? ''), getSetting, opts)"))
check('preload：aiTeachEnsureConstraints 通道', preload.includes("ipcRenderer.invoke('aiTeach:ensureConstraints', id)"))
check('preload：writeConstraints 透传 opts',
  /aiTeachWriteConstraints: \(id: string, text: string, opts\?: \{ expectedMtimeMs\?: number \}\)[\s\S]{0,120}opts\)/.test(preload))
check('preload：profile writeSession 透传 opts',
  /aiTeachProfileWriteSession: \(id: string, text: string, opts\?: \{ expectedMtimeMs\?: number \}\)[\s\S]{0,120}opts\)/.test(preload))
check('ipc.ts：导出 aiTeachEnsureConstraints', ipc.includes('export const aiTeachEnsureConstraints = (id: string)'))
check('ipc.ts：writeConstraints 带 opts', /export const aiTeachWriteConstraints = \(id: string, text: string, opts\?: \{ expectedMtimeMs\?: number \}\)/.test(ipc))
check('ipc.ts：profile writeSession 带 opts', /export const aiTeachProfileWriteSession = \(id: string, text: string, opts\?: \{ expectedMtimeMs\?: number \}\)/.test(ipc))
check('ipc.ts：读结果类型含 mtimeMs',
  ipc.includes('export interface AiTeachConstraintsResult { ok: boolean; text?: string; relPath?: string | null; mtimeMs?: number; error?: string }'))
check('types：aiTeachReadConstraints 含 mtimeMs', /aiTeachReadConstraints: \(id: string\) => Promise<\{ ok: boolean; text\?: string; relPath\?: string \| null; mtimeMs\?: number; error\?: string \}>/.test(types))
check('types：aiTeachEnsureConstraints 出口存在', types.includes('aiTeachEnsureConstraints: (id: string) => Promise<{ ok: boolean; relPath?: string | null; created?: boolean; error?: string }>'))
check('types：aiTeachWriteConstraints 带 opts + conflict/diskText',
  /aiTeachWriteConstraints: \(id: string, text: string, opts\?: \{ expectedMtimeMs\?: number \}\) => Promise<\{[^}]*conflict\?: boolean; diskText\?: string/.test(types))
check('types：aiTeachProfileReadSession 含 mtimeMs',
  /aiTeachProfileReadSession: \(id: string\) => Promise<\{[^}]*mtimeMs\?: number/.test(types))
check('types：aiTeachProfileWriteSession 带 opts + conflict/diskText',
  /aiTeachProfileWriteSession: \(id: string, text: string, opts\?: \{ expectedMtimeMs\?: number \}\) => Promise<\{[^}]*conflict\?: boolean; diskText\?: string/.test(types))

// ---------------------------------------------------------------- 汇总
let pass = 0, fail = 0
for (const c of checks) {
  if (c.pass) { pass++; console.log(`  PASS  ${c.name}`) }
  else { fail++; console.log(`  FAIL  ${c.name}${c.detail ? '  -- ' + c.detail : ''}`) }
}
console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
