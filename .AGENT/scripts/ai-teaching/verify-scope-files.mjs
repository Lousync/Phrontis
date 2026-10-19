#!/usr/bin/env node
/**
 * 契约验证：AI教学 · 分层要求与分层素材的**文件层**（真实临时目录往返）
 * 方案：`E:\Projects\KnowledgeRecorder\.AGENT\.claude\plans\ai-teaching-flow-v2-impl.md` §三-2/§三-3、§五
 *
 * 为什么能跑真函数：`aiTeachingScope.ts` / `aiTeachingSources.ts` / `aiTeachingFolders.ts` 依赖
 * `electron` 与 `getCurrentVault()`（评审口径见 verify-sources-workspace.mjs 头注：整链抽不干净）。
 * 本脚本的做法是**把三个模块的 import 行机械改写**成 `const { … } = __mod('<spec>')`，
 * 只桩掉仓库上下文 / 广播 / 大纲（`stubs.mjs`），三个模块本体与 `parseSourceMd` / `rewriteEntries` /
 * `unitConstraintsRel` / 骨架全部**跑真实实现**，仓库根指向 `os.tmpdir()` 下的真临时目录。
 *
 * 覆盖（全部为断言，负向标注在名字里）：
 *   1. 章层 `{ ok:false, error:'章层本层未启用' }`；未知层级同拒
 *   2. counts 缺文件时全 0 且**不创建任何文件**（负向）
 *   3. 知识点级 CONSTRAINTS 骨架（无列表项）→ 写入 → 读回往返（CRLF 归一 / 相对路径格式）
 *   4. 写盘后复用**既有**两条广播、无新通道（铁律 1）
 *   5. `addSource` 缺省 target 仍写工作区主库（负向：不落知识点夹）；显式 unit target / addScopedSource 分层
 *   6. `readScopedSources` 分组正确（组内重编号、互不串层）
 *   7. counts 覆盖大纲全部知识点 + `{ req, src }` 实数
 *   8. IPC 六通道接线 + 注册可达性（静态）
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-scope-files.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const ROOT_DIR = 'AI教学'
const WS_FOLDER = `${ROOT_DIR}/工作区A`
const SCOPE_REL = 'electron/lib/aiTeachingScope.ts'
const SOURCES_REL = 'electron/lib/aiTeachingSources.ts'
const FOLDERS_REL = 'electron/lib/aiTeachingFolders.ts'

// 常量从真源取（不在脚本里手抄 `CONSTRAINTS.md`，避免两处漂移）
const foldersSrc = read(FOLDERS_REL)
const constraintsFile = /export const CONSTRAINTS_FILE = '([^']+)'/.exec(foldersSrc)?.[1] ?? 'CONSTRAINTS.md'

// ---------------------------------------------------------------- 桩模块 + 模块改写
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-files-'))
const vaultPath = path.join(tmpDir, 'vault')
fs.mkdirSync(vaultPath, { recursive: true })

const stubsSrc = `
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

/** 脚本驱动的仓库上下文（真临时目录）+ 广播记录 */
export const state = {
  rootPath: '',
  vaultOpen: true,
  broadcasts: [],
  outline: null,
  unitFolders: {},
}

const real = {}
export function __register(spec, ns) { real[spec] = ns }

const overrides = {
  electron: { ipcMain: { handle: () => {} }, BrowserWindow: {}, dialog: {} },
  './kbStore/vaultContext': { getCurrentVault: () => (state.vaultOpen ? { rootPath: state.rootPath, rootId: 'vault-1' } : null) },
  '../main/windowBus': {
    broadcast: (channel, payload) => { state.broadcasts.push({ channel, payload }) },
    BROADCAST_CHANNEL: {
      aiTeachTreeRefresh: 'aiTeach:tree-refresh',
      aiTeachCourseRefresh: 'aiTeach:course-refresh',
      aiTeachNotice: 'aiTeach:notice',
    },
  },
  './aiTeachingFolders': { CONSTRAINTS_FILE: '${constraintsFile}' },
  './aiTeachingWorkspaces': {
    workspaceFolderRel: (wsId) => (String(wsId == null ? '' : wsId).trim() === 'ws1' ? '${WS_FOLDER}' : null),
    getWorkspaceOfSession: () => 'ws1',
    listWorkspaces: () => ({ workspaces: [], sessionWs: {}, unassignedCount: 0, lastWorkspaceId: 'ws1' }),
  },
  './aiTeachingCourse': {
    unitFolderRel: (_wsId, unitId) => state.unitFolders[String(unitId)] || null,
    getSessionUnitFolderRel: () => null,
    readCourseOutline: () => state.outline,
  },
  './workspaceManager': {
    uniqueFileName: (_dir, name) => name,
    uniqueVersionedName: (_dir, name) => name,
    renameWorkspacePath: () => {},
    trashWorkspacePath: async () => {},
  },
  './agentSessionRepo': { getAgentSession: () => null, createAgentSession: () => ({ id: 's1' }), getAgentMessages: () => [] },
  '../../src/lib/aiTextExts': { AI_TEXT_CODE_EXTS: ['ts', 'js', 'tsx', 'py', 'c'] },
  '../../src/lib/mindmap': { parseMindmap: () => null, countNodes: () => 0 },
}

/** spec -> 命名空间；未覆盖者给「延迟转发」，以便循环 import 的另一半在调用时才取真身 */
export function __mod(spec) {
  if (spec === 'fs' || spec === 'node:fs') return nodeFs
  if (spec === 'path' || spec === 'node:path') return nodePath
  const ov = overrides[spec] || {}
  return new Proxy(ov, {
    get(t, name) {
      if (typeof name !== 'string') return undefined
      if (Object.prototype.hasOwnProperty.call(t, name)) return t[name]
      return (...args) => {
        const ns = real[spec]
        const fn = ns ? ns[name] : undefined
        if (typeof fn !== 'function') return undefined
        return fn(...args)
      }
    },
  })
}
`
fs.writeFileSync(path.join(tmpDir, 'stubs.mjs'), stubsSrc)

/** 把某 .ts 的 import 行改写成 `const { … } = __mod('<spec>')`（真模块本体保留） */
function rewriteModule(rel, outName) {
  const js = stripTypeScriptTypes(read(rel), { mode: 'strip' })
  const lines = js.split('\n')
  const out = []
  const leftovers = []
  for (const line of lines) {
    const m = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)'\s*;?\s*$/.exec(line)
    if (m) {
      const names = m[1].split(',').map((s) => s.trim())
        .filter((s) => s && !/^type\s/.test(s))
        .join(', ')
      out.push(names ? `const { ${names} } = __mod('${m[2]}')` : `__mod('${m[2]}')`)
      continue
    }
    if (/^import\s/.test(line)) leftovers.push(line)
    out.push(line)
  }
  fs.writeFileSync(path.join(tmpDir, outName), `${out.join('\n')}\nimport { __mod } from './stubs.mjs'\n`)
  return leftovers
}

const leftovers = [
  ...rewriteModule(FOLDERS_REL, 'aiTeachingFolders.mjs'),
  ...rewriteModule(SOURCES_REL, 'aiTeachingSources.mjs'),
  ...rewriteModule(SCOPE_REL, 'aiTeachingScope.mjs'),
]
check('三个模块的 import 全部可机械改写（无多行 import 残留）', leftovers.length === 0, leftovers.join(' | '))

const stubs = await import(pathToFileURL(path.join(tmpDir, 'stubs.mjs')).href)
stubs.state.rootPath = vaultPath
stubs.state.unitFolders = { u1: `${WS_FOLDER}/1·知识点A`, u2: `${WS_FOLDER}/1·知识点B` }
stubs.state.outline = {
  title: '测试课程', goal: '', anchor: '',
  chapters: [{ id: 'c1', name: '一、章一', units: [
    { id: 'u1', name: '知识点A', goal: '', source: '' },
    { id: 'u2', name: '知识点B', goal: '', source: '' },
  ] }],
}

const foldersMod = await import(pathToFileURL(path.join(tmpDir, 'aiTeachingFolders.mjs')).href)
const sourcesMod = await import(pathToFileURL(path.join(tmpDir, 'aiTeachingSources.mjs')).href)
const scopeMod = await import(pathToFileURL(path.join(tmpDir, 'aiTeachingScope.mjs')).href)
stubs.__register('./aiTeachingFolders', foldersMod)
stubs.__register('./aiTeachingSources', sourcesMod)
stubs.__register('./aiTeachingScope', scopeMod)

const { readScopeText, writeScopeText, ensureScopeText, scopeCounts, normalizeSourceTarget, countConstraintItems, UNIT_CONSTRAINTS_SKELETON } = scopeMod
const { addSource, addScopedSource, readScopedSources } = sourcesMod

const getSetting = (key) => (key === 'aiTeachRootDir' ? ROOT_DIR : undefined)
const abs = (rel) => path.join(vaultPath, rel)
const listEntries = (dir) => {
  const out = []
  const walk = (d, base) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isDirectory()) { out.push(`${rel}/`); walk(path.join(d, e.name), rel) } else out.push(rel)
    }
  }
  walk(dir, '')
  return out.sort()
}

const UNIT_A = { wsId: 'ws1', level: 'unit', unitId: 'u1' }
const UNIT_B = { wsId: 'ws1', level: 'unit', unitId: 'u2' }
const WS_A = { wsId: 'ws1', level: 'workspace' }
const GLOBAL = { wsId: '', level: 'global' }
const UNITS_REL = `${WS_FOLDER}/1·知识点A`
const UNIT_CONSTRAINTS_REL = `${UNITS_REL}/${constraintsFile}`
const UNIT_SOURCE_REL = `${WS_FOLDER}/SOURCES/1·知识点A/SOURCE.md`
const WS_SOURCE_REL = `${WS_FOLDER}/SOURCES/SOURCE.md`

console.log('\n=== 1. 章层本层未启用 / 未知层级 ===')
const chRead = readScopeText({ wsId: 'ws1', level: 'chapter', unitId: 'u1' }, getSetting)
const chWrite = writeScopeText({ wsId: 'ws1', level: 'chapter' }, 'x', getSetting)
const chEnsure = ensureScopeText({ wsId: 'ws1', level: 'chapter' }, getSetting)
check('章层 read → 本层未启用', chRead.ok === false && chRead.error === '章层本层未启用', JSON.stringify(chRead))
check('章层 write → 本层未启用', chWrite.ok === false && chWrite.error === '章层本层未启用', JSON.stringify(chWrite))
check('章层 ensure → 本层未启用', chEnsure.ok === false && chEnsure.error === '章层本层未启用', JSON.stringify(chEnsure))
check('章层被拒不落盘（负向：仓库里没有多出文件）', listEntries(vaultPath).length === 0, listEntries(vaultPath).join(','))
const bogus = readScopeText({ wsId: 'ws1', level: 'nope' }, getSetting)
check('未知层级被拒（不静默落到工作区层）', bogus.ok === false && String(bogus.error).startsWith('未知层级'), JSON.stringify(bogus))

console.log('\n=== 2. counts：缺文件全 0 且不创建任何文件（负向）===')
const before = listEntries(vaultPath)
const c0 = scopeCounts('ws1', getSetting)
check('counts 覆盖大纲全部知识点（u1/u2）', c0.ok && Object.keys(c0.units).sort().join(',') === 'u1,u2', JSON.stringify(c0))
check('缺文件时全 0', c0.units.u1.req === 0 && c0.units.u1.src === 0 && c0.units.u2.req === 0 && c0.units.u2.src === 0, JSON.stringify(c0.units))
check('counts 调用后文件树未变（只读，负向）', listEntries(vaultPath).join(',') === before.join(','), listEntries(vaultPath).join(','))
check('无仓库时 counts 报错不炸', (() => { stubs.state.vaultOpen = false; const r = scopeCounts('ws1', getSetting); stubs.state.vaultOpen = true; return r.ok === false && r.units && Object.keys(r.units).length === 0 })(), '')

console.log('\n=== 3. 知识点级 CONSTRAINTS：骨架 → 写入 → 读回往返 ===')
const ensured = ensureScopeText(UNIT_A, getSetting)
check('ensure 返回知识点层相对路径', ensured.ok && ensured.relPath === UNIT_CONSTRAINTS_REL, JSON.stringify(ensured))
check('ensure 落盘（真实临时目录里文件存在）', fs.existsSync(abs(UNIT_CONSTRAINTS_REL)), UNIT_CONSTRAINTS_REL)
const skeleton = ensured.text ?? ''
check('骨架首行 = `# 知识点 · 要求`', skeleton.startsWith('# 知识点 · 要求'), JSON.stringify(skeleton.slice(0, 20)))
check('骨架含一句说明（分层语义）', skeleton.includes('只对本知识点下的课时生效'), '')
check('骨架**不**含列表项（条目由用户加，负向）', !/^-\s/m.test(skeleton), JSON.stringify(skeleton))
check('骨架 = 模块常量（唯一真源）', skeleton === UNIT_CONSTRAINTS_SKELETON, '')
const ensured2 = ensureScopeText(UNIT_A, getSetting)
check('二次 ensure 幂等（created=false，内容不变）', ensured2.ok && ensured2.created === false && ensured2.text === skeleton, JSON.stringify({ created: ensured2.created }))

const body = '- 先给一句话结论\n- 每节结尾留 3 道自测题\n'
const wrote = writeScopeText(UNIT_A, '- 先给一句话结论\r\n- 每节结尾留 3 道自测题\r\n', getSetting)
check('write 归一 CRLF 并回传正文', wrote.ok && wrote.text === body && wrote.relPath === UNIT_CONSTRAINTS_REL, JSON.stringify(wrote))
check('写盘内容与回传一致', fs.readFileSync(abs(UNIT_CONSTRAINTS_REL), 'utf8') === body, JSON.stringify(fs.readFileSync(abs(UNIT_CONSTRAINTS_REL), 'utf8')))
const readBack = readScopeText(UNIT_A, getSetting)
check('读回往返一致', readBack.ok && readBack.text === body, JSON.stringify(readBack))
check('相对路径格式：正斜杠、无盘符、非绝对（铁律 3）', !/^[A-Za-z]:/.test(wrote.relPath) && !wrote.relPath.startsWith('/') && !wrote.relPath.includes('\\') && wrote.relPath.startsWith(`${ROOT_DIR}/`), wrote.relPath)
const missing = readScopeText(UNIT_B, getSetting)
check('未落文件的知识点：读回 text 空串且路径已解析', missing.ok && missing.text === '' && missing.relPath === `${WS_FOLDER}/1·知识点B/${constraintsFile}`, JSON.stringify(missing))
check('读操作不建文件（负向）', !fs.existsSync(abs(missing.relPath)), missing.relPath)

console.log('\n=== 4. 写盘后复用既有广播（无新通道，铁律 1）===')
stubs.state.broadcasts.length = 0
writeScopeText(UNIT_A, body, getSetting)
const chans = stubs.state.broadcasts.map((b) => b.channel)
check('写知识点层 → tree-refresh + course-refresh 各一次', chans.includes('aiTeach:tree-refresh') && chans.includes('aiTeach:course-refresh'), chans.join(','))
check('tree-refresh 带本层目录', stubs.state.broadcasts.some((b) => b.channel === 'aiTeach:tree-refresh' && b.payload && b.payload.dirRel === UNITS_REL), JSON.stringify(stubs.state.broadcasts))
check('course-refresh 带 wsId', stubs.state.broadcasts.some((b) => b.channel === 'aiTeach:course-refresh' && b.payload && b.payload.wsId === 'ws1'), JSON.stringify(stubs.state.broadcasts))
check('未引入新广播通道（负向）', !chans.some((c) => c.includes('scope')), chans.join(','))
stubs.state.broadcasts.length = 0
writeScopeText(GLOBAL, '# 全局要求\n\n- 甲\n', getSetting)
const gChans = stubs.state.broadcasts.map((b) => b.channel)
check('写全局层也发 tree-refresh', gChans.includes('aiTeach:tree-refresh'), gChans.join(','))
check('全局层无具体工作区 → 不发 course-refresh（负向）', !gChans.includes('aiTeach:course-refresh'), gChans.join(','))

console.log('\n=== 5. 工作区层 / 全局层：复用既有 ensure 与骨架 ===')
const wsEnsured = ensureScopeText(WS_A, getSetting)
check('工作区层 ensure → {工作区}/CONSTRAINTS.md', wsEnsured.ok && wsEnsured.relPath === `${WS_FOLDER}/${constraintsFile}` && wsEnsured.created === true, JSON.stringify(wsEnsured))
check('工作区骨架用既有文案（工作区要求）', String(wsEnsured.text).includes('# 工作区要求'), JSON.stringify(String(wsEnsured.text).slice(0, 24)))
const glEnsured = ensureScopeText(GLOBAL, getSetting)
check('全局层 ensure → {产物根}/CONSTRAINTS.md', glEnsured.ok && glEnsured.relPath === `${ROOT_DIR}/${constraintsFile}`, JSON.stringify(glEnsured))
check('全局骨架用既有文案（全局要求）', String(glEnsured.text).includes('# 全局要求'), JSON.stringify(String(glEnsured.text).slice(0, 24)))
check('全局层读回复用既有读点', readScopeText(GLOBAL, getSetting).ok && String(readScopeText(GLOBAL, getSetting).text).includes('# 全局要求'), '')
const wsText = '- 讲解控制在 10 分钟能读完\n'
check('工作区层读写往返', (() => { const w = writeScopeText(WS_A, wsText, getSetting); const r = readScopeText(WS_A, getSetting); return w.ok && r.ok && r.text === wsText })(), '')

console.log('\n=== 6. addSource：缺省 target 仍写工作区主库（旧行为不破，负向）===')
check('normalizeSourceTarget() 缺省 = workspace', normalizeSourceTarget().level === 'workspace' && normalizeSourceTarget().unitId === null, JSON.stringify(normalizeSourceTarget()))
check('normalizeSourceTarget(undefined/null) = workspace', normalizeSourceTarget(undefined).level === 'workspace' && normalizeSourceTarget(null).level === 'workspace', '')
check('level=unit 但缺 unitId → 降级 workspace（负向：不落知识点夹）', normalizeSourceTarget({ level: 'unit', wsId: 'ws1' }).level === 'workspace', JSON.stringify(normalizeSourceTarget({ level: 'unit', wsId: 'ws1' })))
check('level=unit + unitId → unit', normalizeSourceTarget({ level: 'unit', wsId: 'ws1', unitId: 'u1' }).level === 'unit', '')
const r1 = addSource('sid-1', { name: '教材甲', type: 'url', path: 'https://example.com/a', storage: '仅引用' }, getSetting)
check('缺省 target：登记成功', r1.ok, JSON.stringify(r1.error))
check('缺省 target：落工作区主库 SOURCE.md', fs.existsSync(abs(WS_SOURCE_REL)) && fs.readFileSync(abs(WS_SOURCE_REL), 'utf8').includes('教材甲'), WS_SOURCE_REL)
check('缺省 target：**不**落知识点夹（负向）', !fs.existsSync(abs(UNIT_SOURCE_REL)), UNIT_SOURCE_REL)
check('缺省 target：relPath 指工作区主库', r1.relPath === WS_SOURCE_REL, String(r1.relPath))
check('缺省 target：模板署名仍是「工作区级·跨对话共用」（负向：不写成 SOURCES）', (() => {
  const t = fs.readFileSync(abs(WS_SOURCE_REL), 'utf8')
  return t.includes('归属: （工作区级·跨对话共用）') && !t.includes('归属: SOURCES')
})(), '')

console.log('\n=== 7. 显式 unit target / addScopedSource：分层落点 ===')
const r2 = addSource('', { name: '讲义乙', type: 'url', path: 'https://example.com/b', storage: '仅引用' }, getSetting, { level: 'unit', wsId: 'ws1', unitId: 'u1' })
check('显式 unit target：落知识点级 SOURCE.md', r2.ok && fs.existsSync(abs(UNIT_SOURCE_REL)), JSON.stringify(r2.error))
check('显式 unit target：relPath 指知识点夹', r2.relPath === UNIT_SOURCE_REL, String(r2.relPath))
check('显式 unit target：条目带 unit 作用域', Array.isArray(r2.entries) && r2.entries.every((e) => e.scope === 'unit'), JSON.stringify((r2.entries ?? []).map((e) => e.scope)))
const r3 = addScopedSource('ws1', 'u2', { name: '讲义丙', type: 'url', path: 'https://example.com/c', storage: '仅引用' }, getSetting)
check('addScopedSource(wsId,u2) 落 u2 知识点夹', r3.ok && fs.existsSync(abs(`${WS_FOLDER}/SOURCES/1·知识点B/SOURCE.md`)), JSON.stringify(r3.error))
const r4 = addScopedSource('ws1', null, { name: '教材丁', type: 'url', path: 'https://example.com/d', storage: '仅引用' }, getSetting)
check('addScopedSource(wsId,null) 落工作区主库（unitId 空 = 工作区层）', r4.ok && r4.relPath === WS_SOURCE_REL, String(r4.relPath))
const r5 = addScopedSource('ws1', 'u9', { name: '坏 id', type: 'url', path: 'https://example.com/e', storage: '仅引用' }, getSetting)
check('未知工作区被拒（不静默落别处，负向）', addScopedSource('ws-unknown', null, { name: 'x', type: 'url', path: 'https://example.com/f', storage: '仅引用' }, getSetting).ok === false, '')
check('脏 unitId 被拒（不落兜底路径，负向）', r5.ok === false, JSON.stringify(r5))
check('脏 unitId 未落盘到 1·知识点 兜底夹', !fs.existsSync(abs(`${WS_FOLDER}/SOURCES/1·知识点/SOURCE.md`)), '')

console.log('\n=== 8. readScopedSources：按层分组 ===')
const sc = readScopedSources('ws1', 'u1', getSetting)
check('分层读成功', sc.ok, JSON.stringify(sc.error))
check('工作区组 = 2 条（教材甲 + 教材丁）', sc.workspace.length === 2, JSON.stringify(sc.workspace.map((e) => e.name)))
check('知识点组 = 1 条（讲义乙）', sc.unit.length === 1 && sc.unit[0].name === '讲义乙', JSON.stringify(sc.unit.map((e) => e.name)))
check('两组互不串层（负向）', sc.workspace.every((e) => e.name !== '讲义乙') && sc.unit.every((e) => e.name !== '教材甲'), '')
check('组内编号各从 1 起', sc.workspace.map((e) => e.no).join(',') === '1,2' && sc.unit.map((e) => e.no).join(',') === '1', JSON.stringify({ w: sc.workspace.map((e) => e.no), u: sc.unit.map((e) => e.no) }))
check('条目带 scope / dirRel / origNo', sc.unit[0].scope === 'unit' && sc.unit[0].dirRel === `${WS_FOLDER}/SOURCES/1·知识点A` && sc.workspace[0].scope === 'workspace', JSON.stringify(sc.unit[0]))
check('返回两层文件相对路径（无绝对路径）', sc.workspaceRel === WS_SOURCE_REL && sc.unitRel === UNIT_SOURCE_REL && !String(sc.unitRel).includes('\\'), JSON.stringify({ w: sc.workspaceRel, u: sc.unitRel }))
const scNoUnit = readScopedSources('ws1', null, getSetting)
check('unitId 缺省 → 只读工作区组，unit 空数组 + unitRel null', scNoUnit.ok && scNoUnit.unit.length === 0 && scNoUnit.unitRel === null && scNoUnit.workspace.length === 2, JSON.stringify(scNoUnit.unitRel))
check('已登记的知识点组可读（u2 一条）', (() => { const r = readScopedSources('ws1', 'u2', getSetting); return r.ok && r.unit.length === 1 })(), '')
check('无仓库时报错不炸', (() => { stubs.state.vaultOpen = false; const r = readScopedSources('ws1', 'u1', getSetting); stubs.state.vaultOpen = true; return r.ok === false && r.unit.length === 0 && r.workspace.length === 0 })(), '')

console.log('\n=== 9. counts：实数 + 覆盖全部知识点 ===')
writeScopeText(UNIT_A, '- 甲\n- 乙\n', getSetting)
const before2 = listEntries(vaultPath)
const c1 = scopeCounts('ws1', getSetting)
check('u1 → { req:2, src:1 }', c1.ok && c1.units.u1.req === 2 && c1.units.u1.src === 1, JSON.stringify(c1.units.u1))
check('u2 → { req:0, src:1 }（缺失层填 0，覆盖全部知识点）', c1.units.u2.req === 0 && c1.units.u2.src === 1, JSON.stringify(c1.units.u2))
check('counts 再次调用仍不改文件树（负向）', listEntries(vaultPath).join(',') === before2.join(','), '')
// 口径必须与渲染层 `src/modules/ai-teaching/constraintsParse.ts` 的 ITEM_RE 一致：
// 缩进条目**算**条目（渲染层编辑时会归一成顶格），空条目 / 标题 / 说明段不算。
check('条目计数口径 = `- ` 行（允许缩进；空条目与标题不算）', countConstraintItems('- a\n  - 缩进也算\n- \n# 标题\n- b') === 3, String(countConstraintItems('- a\n  - 缩进也算\n- \n# 标题\n- b')))
check('骨架不计条目（新层 counts 为 0）', countConstraintItems(UNIT_CONSTRAINTS_SKELETON) === 0, String(countConstraintItems(UNIT_CONSTRAINTS_SKELETON)))

// ---------------------------------------------------------------- 静态接线
console.log('\n=== 10. IPC 六通道 + 注册可达性（剥注释后静态断言）===')
const scopeSrc = stripComments(read(SCOPE_REL))
const sourcesSrc = stripComments(read(SOURCES_REL))
const mainIndex = stripComments(read('electron/main/index.ts'))
const windowBus = stripComments(read('electron/main/windowBus.ts'))
const preload = stripComments(read('electron/preload/index.ts'))
const types = stripComments(read('src/types/index.ts'))
const ipc = stripComments(read('src/lib/ipc.ts'))
for (const c of ['aiTeachScope:read', 'aiTeachScope:writeText', 'aiTeachScope:ensure', 'aiTeachScope:counts']) {
  check(`主进程注册 ${c}`, scopeSrc.includes(`'${c}'`), '')
}
check('handler 计数 = 4（aiTeachScope:*）', (scopeSrc.match(/ipcMain\.handle\('aiTeachScope:/g) ?? []).length === 4, String((scopeSrc.match(/ipcMain\.handle\('aiTeachScope:/g) ?? []).length))
for (const c of ['aiTeachSources:readScoped', 'aiTeachSource:addScoped']) {
  check(`主进程注册 ${c}`, sourcesSrc.includes(`'${c}'`), '')
}
check('scope 注册器被素材注册器调用（可达）', sourcesSrc.includes('registerAiTeachingScopeHandlers(getSetting)'), '')
check('素材注册器被 main/index.ts 调用（可达）', /registerAiTeachingSourceHandlers\(/.test(mainIndex), '')
check('folders 导出 CONSTRAINTS_FILE（唯一文件名真源）', /export const CONSTRAINTS_FILE = 'CONSTRAINTS\.md'/.test(foldersSrc), '')
check('folders 导出 unitConstraintsRel（层 → 路径解析器）', /export function unitConstraintsRel\(/.test(foldersSrc) && foldersSrc.includes('`${dir}/${CONSTRAINTS_FILE}`'), '')
// 环与 TDZ：folders 是唯一有 `let lessonFolderResolver` 顶层状态的模块，course 顶层会调它的 setter。
// 故 folders 必须保持「无环」（不得反向 import course/sources/scope）；scope↔sources 这个环是刻意的
// （scope 复用 sources 的 SOURCE.md 解析，sources 复用 scope 的 target 归一 + 注册器），两侧都只有
// 函数声明、无顶层副作用，环内调用都发生在运行期。
check('folders 不反向 import course/sources/scope（无环，保 TDZ 安全）', !/from '\.\/aiTeaching(Course|Sources|Scope)'/.test(stripComments(foldersSrc)), '')
check('scope↔sources 互引用为刻意环（两侧均无顶层副作用）',
  stripComments(read(SCOPE_REL)).includes("from './aiTeachingSources'") && sourcesSrc.includes("from './aiTeachingScope'"), '')
check('旧三参调用点仍在（旧契约不破）', sourcesSrc.includes("=> addSource(String(sessionId ?? ''), input, getSetting))"), '')
check('addSource 第四参 target 为可选', /export function addSource\(sessionId: string, input: AddSourceInput, getSetting: \(key: string\) => unknown, target\?: AiTeachSourceTarget\)/.test(sourcesSrc), '')
const busChannels = [...windowBus.matchAll(/'(aiTeach:[a-z-]+)'/g)].map((m) => m[1]).sort().join(',')
check('windowBus 未新增广播通道（铁律 1 负向：仍是既有 4 条 aiTeach 通道）',
  busChannels === 'aiTeach:course-refresh,aiTeach:notice,aiTeach:tree-refresh,aiTeach:web-crawl-progress', busChannels)
const apiMethods = ['aiTeachScopeRead', 'aiTeachScopeWriteText', 'aiTeachScopeEnsure', 'aiTeachScopeCounts', 'aiTeachSourcesReadScoped', 'aiTeachSourceAddScoped']
for (const m of apiMethods) {
  const okPreload = preload.includes(m)
  const okTypes = types.includes(m)
  const okIpc = ipc.includes(m)
  check(`IPC 三层一致：${m}`, okPreload && okTypes && okIpc, `preload=${okPreload} types=${okTypes} ipc=${okIpc}`)
}
check('types 导出 AiTeachScopeLevel/Ref/TextResult/ScopedSourcesResult/ScopeCount', ['AiTeachScopeLevel', 'AiTeachScopeRef', 'AiTeachScopeTextResult', 'AiTeachScopedSourcesResult', 'AiTeachScopeCount'].every((n) => types.includes(`export type ${n}`) || types.includes(`export interface ${n}`)), '')
check('preload 通道名逐个对应（无拼写漂移）', preload.includes("ipcRenderer.invoke('aiTeachScope:counts', wsId)") && preload.includes("ipcRenderer.invoke('aiTeachSources:readScoped', wsId, unitId ?? null)") && preload.includes("ipcRenderer.invoke('aiTeachSource:addScoped', wsId, unitId ?? null, input)"), '')

// ---------------------------------------------------------------- 报告
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(failed.length === 0 ? 0 : 1)
