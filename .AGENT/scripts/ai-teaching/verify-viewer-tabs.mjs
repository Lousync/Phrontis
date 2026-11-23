#!/usr/bin/env node
/**
 * 契约验证：AI教学「右侧查看器页签状态」纯函数（`electron/lib/viewerTabsPure.ts`）
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §2.10 / §6.2 / §9
 *       + 内核文档 C4 / C6 / C7 / D5。
 *
 * 断言口径（全部跑真实实现，strip 类型后直接 import）：
 *   · 归一容错：坏 tab 丢弃、activeIndex 钳位、width 钳位；
 *   · ★ 负向：web 页签只认 http/https（file: / javascript: / data: 一律丢）；
 *   · 同身份复用（web url / rootId+relPath / externalToken）；
 *   · 关闭页签的邻位激活与空会话 -1；
 *   · bounds 换算（zoom 0.8 / 1.25 / 0）；
 *   · pruneSessions / activateDormant 幂等；
 *   · ★ 所有函数不修改入参（深比较）。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-viewer-tabs.mjs [仓库路径]
 * 输出纯 ASCII（禁 emoji，AGENTS.md）；期望全部 PASS 且 exit=0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const ascii = (s) => String(s === undefined ? '' : s).replace(/[^\x20-\x7e]/g, '?')
const clone = (v) => structuredClone(v)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const REL = 'electron/lib/viewerTabsPure.ts'
const TYPES_REL = 'electron/lib/aiTeachingTypesPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const typesSrc = fs.readFileSync(path.join(ROOT, TYPES_REL), 'utf8')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-tabs-'))
fs.writeFileSync(
  path.join(tmpDir, 'aiTeachingTypesPure.mjs'),
  stripTypeScriptTypes(typesSrc, { mode: 'strip' })
)
const stripped = stripTypeScriptTypes(src, { mode: 'strip' }).replace(
  /(from\s+['"])\.\/aiTeachingTypesPure(['"])/g,
  '$1./aiTeachingTypesPure.mjs$2'
)
const tmpFile = path.join(tmpDir, 'viewerTabsPure.mjs')
fs.writeFileSync(tmpFile, stripped)
const {
  normalizeViewerState,
  tabIdentity,
  openTab,
  closeTab,
  setActive,
  setWidth,
  isExternalTab,
  boundsToDevice,
  pruneSessions,
  activateDormant,
} = await import(pathToFileURL(tmpFile).href)

/* ---------------------------------------------------------------- fixtures */
const web = (url, extra = {}) => ({ kind: 'web', url, ...extra })
const pdf = (relPath, extra = {}) => ({ kind: 'pdf', rootId: 'r1', relPath, name: 'x.pdf', ...extra })
const stateOf = (tabs, activeIndex = 0, width) => {
  const session = { tabs, activeIndex }
  if (width !== undefined) session.width = width
  return { v: 1, sessions: { s1: session } }
}
const tabsOf = (state, id = 's1') => state.sessions[id].tabs
const sessionOf = (state, id = 's1') => state.sessions[id]

/* ---------------------------------------------------------------- 1. 归一 */
console.log('\n=== 1. normalizeViewerState: tolerant normalization ===')
const validRaw = {
  v: 1,
  sessions: {
    s1: {
      tabs: [
        web('https://example.com/a', { title: 'Example' }),
        { kind: 'note', relPath: 'notes/a.md' },
        pdf('books/a.pdf'),
        { kind: 'sidechat', sessionId: 'side-1' },
      ],
      activeIndex: 2,
      width: 500,
    },
  },
}
const nValid = normalizeViewerState(validRaw)
check('keeps valid web/note/pdf/sidechat tabs', tabsOf(nValid).length === 4)
check('keeps session activeIndex and width', sessionOf(nValid).activeIndex === 2 && sessionOf(nValid).width === 500)
check('output version is 1', nValid.v === 1)

const blocked = normalizeViewerState({
  v: 1,
  sessions: {
    s1: {
      tabs: [
        web('file:///etc/passwd'),
        web('javascript:alert(1)'),
        web('data:text/html,<b>x</b>'),
      ],
      activeIndex: 0,
    },
  },
})
check('NEGATIVE: drops file:// web tab', tabsOf(blocked).length === 0)
check('NEGATIVE: drops javascript: web tab', !JSON.stringify(blocked).includes('javascript'))
check('NEGATIVE: drops data: web tab', !JSON.stringify(blocked).includes('data:text'))
const onlyHttp = normalizeViewerState({
  v: 1,
  sessions: { s1: { tabs: [web('file:///a'), web('https://ok.example/x')], activeIndex: 9 } },
})
check('keeps only http(s) web tab after filtering', tabsOf(onlyHttp).length === 1 && tabsOf(onlyHttp)[0].url === 'https://ok.example/x')

let threw = false
let nBad
try {
  nBad = normalizeViewerState({
    v: 1,
    sessions: {
      s1: {
        tabs: [
          null,
          42,
          'nope',
          { kind: 'unknown' },
          { kind: 'pdf' },
          { kind: 'pdf', rootId: 'r1' },
          { kind: 'book', rootId: 'r1', relPath: 'x.epub' },
          { kind: 'sidechat' },
        ],
        activeIndex: 'x',
      },
    },
  })
} catch {
  threw = true
}
check('drops bad tabs without throwing', !threw && tabsOf(nBad).length === 0)
check('empty session clamps activeIndex to -1', sessionOf(nBad).activeIndex === -1)

const hi = normalizeViewerState({
  v: 1,
  sessions: { s1: { tabs: [web('https://a/'), web('https://b/')], activeIndex: 99 } },
})
check('clamps activeIndex high to len-1', sessionOf(hi).activeIndex === 1)
const lo = normalizeViewerState({
  v: 1,
  sessions: { s1: { tabs: [web('https://a/'), web('https://b/')], activeIndex: -7 } },
})
check('clamps activeIndex low to 0', sessionOf(lo).activeIndex === 0)

const badRoot = normalizeViewerState({ sessions: 'nope' })
check('non-object sessions -> empty state', badRoot.v === 1 && Object.keys(badRoot.sessions).length === 0)
const wLow = normalizeViewerState({ v: 1, sessions: { s1: { tabs: [], activeIndex: -1, width: 100 } } })
const wHigh = normalizeViewerState({ v: 1, sessions: { s1: { tabs: [], activeIndex: -1, width: 5000 } } })
const wZero = normalizeViewerState({ v: 1, sessions: { s1: { tabs: [], activeIndex: -1, width: 0 } } })
check('normalizes width into panel bounds', sessionOf(wLow).width === 360 && sessionOf(wHigh).width === 960)
check('width 0 is treated as unset', sessionOf(wZero).width === undefined)

/* ---------------------------------------------------------------- 2. 身份 */
console.log('\n=== 2. tabIdentity / isExternalTab ===')
check('web identity is web:<url>', tabIdentity(web('https://a.example/x')) === 'web:https://a.example/x')
check('file identity is kind:rootId:relPath:token', tabIdentity(pdf('a/b.pdf')) === 'pdf:r1:a/b.pdf:')
check('file identity keeps external token', tabIdentity(pdf('a.pdf', { externalToken: 'tok_1' })) === 'pdf:r1:a.pdf:tok_1')
check(
  'different external tokens are different identities',
  tabIdentity(pdf('a.pdf', { externalToken: 'tok_1' })) !== tabIdentity(pdf('a.pdf', { externalToken: 'tok_2' }))
)
check('sidechat identity is sidechat:<sessionId>', tabIdentity({ kind: 'sidechat', sessionId: 'sx' }) === 'sidechat:sx')
check('isExternalTab true only with token', isExternalTab(pdf('a.pdf', { externalToken: 'tok_1' })) === true)
check('isExternalTab false for repo file', isExternalTab(pdf('a.pdf')) === false)
check('isExternalTab false for web tab', isExternalTab(web('https://a/')) === false)

/* ---------------------------------------------------------------- 3. openTab */
console.log('\n=== 3. openTab: reuse vs append (immutability) ===')
const baseWeb = stateOf([web('https://a.example/')])
const baseWebSnap = clone(baseWeb)
const reuse = openTab(baseWeb, 's1', web('https://a.example/'))
check('reuses tab with same url', reuse.reused === true && reuse.index === 0 && tabsOf(reuse.state).length === 1)
check('openTab does not mutate input', same(baseWeb, baseWebSnap))
const appended = openTab(baseWeb, 's1', web('https://b.example/'))
check(
  'appends different url and activates it',
  appended.reused === false && appended.index === 1 && tabsOf(appended.state).length === 2 && sessionOf(appended.state).activeIndex === 1
)
const baseFile = stateOf([pdf('a.pdf')])
const fileReuse = openTab(baseFile, 's1', pdf('a.pdf'))
check('reuses file tab by rootId+relPath', fileReuse.reused === true && fileReuse.index === 0)
const tokenNew = openTab(baseFile, 's1', pdf('a.pdf', { externalToken: 'tok_1' }))
check('external token makes a distinct tab', tokenNew.reused === false && tokenNew.index === 1 && tabsOf(tokenNew.state).length === 2)
const created = openTab({ v: 1, sessions: {} }, 's9', web('https://new.example/'))
check('creates missing session on open', created.index === 0 && tabsOf(created.state, 's9').length === 1)

/* ---------------------------------------------------------------- 4. closeTab */
console.log('\n=== 4. closeTab: neighbour activation ===')
const three = stateOf([web('https://a/'), web('https://b/'), web('https://c/')], 0)
const threeSnap = clone(three)
const closedMid = closeTab(three, 's1', 1)
check(
  'closing middle activates right neighbour',
  closedMid.activeIndex === 1 && tabsOf(closedMid.state).length === 2 && tabsOf(closedMid.state)[1].url === 'https://c/'
)
check('closeTab does not mutate input', same(three, threeSnap))
const closedOnly = closeTab(stateOf([web('https://a/')]), 's1', 0)
check('closing last remaining tab -> activeIndex -1', closedOnly.activeIndex === -1 && tabsOf(closedOnly.state).length === 0)
const closedTail = closeTab(stateOf([web('https://a/'), web('https://b/')], 0), 's1', 1)
check('closing tail activates left neighbour', closedTail.activeIndex === 0 && tabsOf(closedTail.state).length === 1)
const badClose = closeTab(three, 's1', 99)
check('out-of-range close keeps state', badClose.activeIndex === 0 && tabsOf(badClose.state).length === 3)

/* ---------------------------------------------------------------- 5. setActive / setWidth */
console.log('\n=== 5. setActive / setWidth ===')
const activeBase = stateOf([web('https://a/'), web('https://b/'), web('https://c/')], 0)
const activeSnap = clone(activeBase)
check('setActive clamps high', sessionOf(setActive(activeBase, 's1', 99)).activeIndex === 2)
check('setActive clamps negative', sessionOf(setActive(activeBase, 's1', -3)).activeIndex === 0)
check('setActive does not mutate input', same(activeBase, activeSnap))
const widthBase = stateOf([web('https://a/')], 0, 480)
const widthSnap = clone(widthBase)
check('setWidth clamps low to 360', sessionOf(setWidth(widthBase, 's1', 100)).width === 360)
check('setWidth clamps high to 960', sessionOf(setWidth(widthBase, 's1', 5000)).width === 960)
check('setWidth <= 0 clears width', sessionOf(setWidth(widthBase, 's1', 0)).width === undefined)
check('setWidth does not mutate input', same(widthBase, widthSnap))

/* ---------------------------------------------------------------- 6. bounds */
console.log('\n=== 6. boundsToDevice ===')
const rect = { x: 10, y: 20, width: 100, height: 50 }
check('zoom 0.8 scales and rounds', same(boundsToDevice(rect, 0.8), { x: 8, y: 16, width: 80, height: 40 }))
check('zoom 1.25 rounds half up', same(boundsToDevice(rect, 1.25), { x: 13, y: 25, width: 125, height: 63 }))
check('zoom 0 falls back to 1', same(boundsToDevice(rect, 0), rect))
check('width/height have a floor of 1', same(boundsToDevice({ x: 0, y: 0, width: 0.2, height: 0.4 }, 1), { x: 0, y: 0, width: 1, height: 1 }))

/* ---------------------------------------------------------------- 7. prune / dormant */
console.log('\n=== 7. pruneSessions / activateDormant ===')
const liveState = {
  v: 1,
  sessions: {
    s1: { tabs: [web('https://a/')], activeIndex: 0 },
    s2: { tabs: [web('https://b/')], activeIndex: 0 },
    s3: { tabs: [web('https://c/')], activeIndex: 0 },
  },
}
const liveSnap = clone(liveState)
const pruned = pruneSessions(liveState, ['s1', 's3'])
check('pruneSessions keeps alive sessions only', !!pruned.sessions.s1 && !!pruned.sessions.s3 && !pruned.sessions.s2)
check('pruneSessions keeps tab arrays', tabsOf(pruned, 's1').length === 1)
check('pruneSessions does not mutate input', same(liveState, liveSnap))

const dormantState = stateOf([web('https://a/', { dormant: true })])
const dormantSnap = clone(dormantState)
const woken = activateDormant(dormantState, 's1', 0)
check('activateDormant clears dormant flag', tabsOf(woken)[0].dormant === false)
check('activateDormant does not mutate input', same(dormantState, dormantSnap))
const wokenAgain = activateDormant(woken, 's1', 0)
check('activateDormant is idempotent', same(woken, wokenAgain))

/* ---------------------------------------------------------------- 8. right-viewer file tab */
console.log('\n=== 8. right-viewer file tab: cross-type path dedupe ===')
const RV_DIR = 'src/modules/ai-teaching/right-viewer'
const rvTabsSrc = fs.readFileSync(path.join(ROOT, RV_DIR, 'viewerTabs.ts'), 'utf8')
const rvTmpFile = path.join(tmpDir, 'rightViewerTabs.mjs')
fs.writeFileSync(rvTmpFile, stripTypeScriptTypes(rvTabsSrc, { mode: 'strip' }))
const RV = await import(pathToFileURL(rvTmpFile).href)

const rvNote = RV.makeNotesTab('rv-n', { relPath: 'AI教学/x/笔记.md', previewDefault: true })
const rvHtml = RV.makeFileTab('rv-f', { relPath: 'AI教学/x/示意图.html', fileKind: 'html' })
const rvPptx = RV.makeFileTab('rv-p', { relPath: 'AI教学/x/课件.pptx', fileKind: 'pptx', page: 2 })
const rvPool = [rvNote, rvHtml, rvPptx]

check('file tab title comes from the file stem', RV.tabTitleOf(rvHtml) === '示意图')
check('file kind guard accepts the four file kinds',
  ['html', 'image', 'mindmap', 'pptx'].every((k) => RV.isFilePaneKind(k))
  && !RV.isFilePaneKind('notes'))
check('findFileTab dedupes the same non-md path (slash / case tolerant)',
  RV.findFileTab(rvPool, 'AI教学\\x\\示意图.html', { caseInsensitive: true })?.id === 'rv-f')
check('findAnyPathTab dedupes across notes and file kinds',
  RV.findAnyPathTab(rvPool, 'AI教学/x/笔记.md')?.id === 'rv-n'
  && RV.findAnyPathTab(rvPool, 'AI教学/x/示意图.html')?.id === 'rv-f')
check('NEGATIVE: findAnyPathTab does not fold different paths together',
  RV.findAnyPathTab(rvPool, 'AI教学/x/别的.md') === null)
check('generating file placeholder is not persisted but regular ones are',
  (() => {
    const gen = RV.makeFileTab('rv-g', { fileKind: 'image', generating: true, slug: 'img' })
    const state = RV.serializeViewerState([...rvPool, gen], 'rv-g')
    return state.tabs.length === 3
      && !state.tabs.some((t) => t.id === 'rv-g')
      && state.activeId === 'rv-n'
  })())
check('file tab page survives a serialize -> parse round trip',
  (() => {
    const state = RV.serializeViewerState([rvPptx], 'rv-p')
    const back = RV.parseViewerState(JSON.parse(JSON.stringify(state)))
    return back.tabs.length === 1 && back.tabs[0].page === 2
  })())
check('parse drops file tabs with an invalid kind or an empty relPath',
  (() => {
    const back = RV.parseViewerState({
      v: 2,
      tabs: [
        { id: 'g1', type: 'file', relPath: '', fileKind: 'image' },
        { id: 'g2', type: 'file', relPath: 'a.html', fileKind: 'pdf' },
      ],
      activeId: 'g1',
    })
    return back.tabs.length === 0 && back.activeId === null
  })())

/* ---------------------------------------------------------------- 报告 */
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${!c.pass && c.detail ? '  -> ' + ascii(c.detail) : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} - ${checks.length - failed.length}/${checks.length} assertions passed`)

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* temp dir cleanup is best-effort */
}
process.exit(failed.length === 0 ? 0 : 1)
