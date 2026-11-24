#!/usr/bin/env node
/**
 * Contract test: AI teaching preflight "course model" line pure functions
 *   src/modules/ai-teaching/preflightModelPure.ts
 *
 * Plan: /home/lousync/Projects/DesginProcess/Phrontis/方案与调研/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md B2 / B3
 *
 * Reads the real implementation (strip types, dynamic import), never modifies it.
 * Assertions:
 *   1. modelLineView source labels: workspace / global / curated / none
 *   2. modelLineView stale binding warning text + warn flag
 *   3. modelLineView conversation override suppresses the source label
 *   4. pickerSections dedupe priority (ws > global > all), empty groups, order
 *   5. rowsForQuery case-insensitive matching, id fallback, dedupe
 *   6. cross-file: source enum of resolveWorkspaceModel == SOURCE_LABEL / WARN_TEXT keys
 *   7. static: Preflight.tsx wiring (AnchoredLayer / llmCatalogSetWorkspace / optional props)
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-preflight-model.mjs [repoPath]
 * Output is pure ASCII (AGENTS.md). Expect all PASS and exit=0.
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
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ids = (list) => (Array.isArray(list) ? list.map((x) => x.id) : [])
/** Console may be GBK (AGENTS.md): never emit non-ASCII, even on failure details. */
const ascii = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '?')

/* ------------------------------------------------------------ load module */
const PURE_REL = 'src/modules/ai-teaching/preflightModelPure.ts'
const pureSrc = fs.readFileSync(path.join(ROOT, PURE_REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-model-'))
const tmpFile = path.join(tmpDir, 'preflightModelPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const mod = await import(pathToFileURL(tmpFile).href)
const { modelLineView, pickerSections, rowsForQuery } = mod

/* ------------------------------------------------- 1. source labels */
console.log('\n=== 1. modelLineView: source labels ===')

const withEntry = (source, name = 'GPT-5') => ({ entry: { name }, source, staleBinding: false })
const plain = (source) => modelLineView({ resolved: withEntry(source), conversationOverridden: false })

const vWs = plain('workspace')
check('workspace -> label from entry.name', vWs.label === 'GPT-5', vWs.label)
check('workspace -> sourceLabel course default', vWs.sourceLabel === '本课程默认', vWs.sourceLabel)
const vGlobal = plain('global')
check('global -> sourceLabel global default', vGlobal.sourceLabel === '全局默认', vGlobal.sourceLabel)
const vCurated = plain('curated')
check('curated -> sourceLabel curated', vCurated.sourceLabel === '精选', vCurated.sourceLabel)
const vNone = modelLineView({ resolved: { source: 'none', staleBinding: false }, conversationOverridden: false })
check('none -> label unconfigured', vNone.label === '未配置', vNone.label)
check('none -> empty sourceLabel', vNone.sourceLabel === '', vNone.sourceLabel)
check('healthy binding -> no warning text', vWs.warn === false && vWs.warnText === '', `${vWs.warn}/${vWs.warnText}`)

const vTrim = modelLineView({ resolved: { entry: { name: '   ' }, source: 'workspace', staleBinding: false }, conversationOverridden: false })
check('blank entry name -> unconfigured label', vTrim.label === '未配置', vTrim.label)

/* ------------------------------------------------- 2. stale binding */
console.log('\n=== 2. modelLineView: stale binding warning ===')

const staleGlobal = modelLineView({ resolved: { entry: { name: 'Global' }, source: 'global', staleBinding: true }, conversationOverridden: false })
check('stale + global -> warn true', staleGlobal.warn === true, String(staleGlobal.warn))
check('stale + global -> global fallback sentence', staleGlobal.warnText === '原绑定已失效，暂用全局默认', staleGlobal.warnText)
const staleCurated = modelLineView({ resolved: { entry: { name: 'C' }, source: 'curated', staleBinding: true }, conversationOverridden: false })
check('stale + curated -> curated fallback sentence', staleCurated.warnText === '原绑定已失效，暂用精选模型', staleCurated.warnText)
const staleNone = modelLineView({ resolved: { source: 'none', staleBinding: true }, conversationOverridden: false })
check('stale + none -> asks user to pick again', staleNone.warn === true && staleNone.warnText.includes('重新选择'), staleNone.warnText)

/* ------------------------------------------------- 3. conversation override */
console.log('\n=== 3. modelLineView: conversation override ===')

const conv = modelLineView({
  resolved: { entry: { name: 'Convo' }, source: 'workspace', staleBinding: false },
  conversationOverridden: true,
})
check('override suppresses source label', conv.sourceLabel === '', conv.sourceLabel)
check('override keeps the effective model name', conv.label === 'Convo', conv.label)

/* ------------------------------------------------- 4. pickerSections */
console.log('\n=== 4. pickerSections ===')

const ws = [{ id: 'm_ws1', name: 'W1' }, { id: 'm_shared', name: 'S' }]
const global = [{ id: 'm_g1', name: 'G1' }, { id: 'm_shared', name: 'S' }]
const all = [{ id: 'm_ws1', name: 'W1' }, { id: 'm_shared', name: 'S' }, { id: 'm_g1', name: 'G1' }, { id: 'm_x', name: 'X' }]
const secs = pickerSections({ workspace: ws, global, all, query: '' })
check('section order ws > global > all', sameJson(secs.map((s) => s.id), ['ws', 'global', 'all']), JSON.stringify(secs.map((s) => s.id)))
check('workspace keeps its own items only', sameJson(ids(secs[0].items), ['m_ws1', 'm_shared']), JSON.stringify(ids(secs[0].items)))
check('global drops ids already in workspace', sameJson(ids(secs[1].items), ['m_g1']), JSON.stringify(ids(secs[1].items)))
check('all drops ids already listed above', sameJson(ids(secs[2].items), ['m_x']), JSON.stringify(ids(secs[2].items)))
check('section titles are the three expected ones', sameJson(secs.map((s) => s.title), ['本课程精选', '全局精选', '全部模型']), JSON.stringify(secs.map((s) => s.title)))

const emptyWs = pickerSections({ workspace: [], global: [{ id: 'm_g1', name: 'G1' }], all: [{ id: 'm_g1', name: 'G1' }], query: '' })
check('empty workspace section is omitted', sameJson(emptyWs.map((s) => s.id), ['global']), JSON.stringify(emptyWs.map((s) => s.id)))
check('empty sections are all omitted', sameJson(pickerSections({ workspace: [], global: [], all: [], query: '' }), []), '')
const filtered = pickerSections({ workspace: ws, global, all, query: 'w1' })
check('query filters every section case-insensitively', sameJson(filtered.map((s) => [s.id, ids(s.items)]), [['ws', ['m_ws1']]]), JSON.stringify(filtered.map((s) => [s.id, ids(s.items)])))
check('query with no match yields no sections', pickerSections({ workspace: ws, global, all, query: 'zzz' }).length === 0, '')

/* ------------------------------------------------- 5. rowsForQuery */
console.log('\n=== 5. rowsForQuery ===')

const rows = [{ id: 'm_a', name: 'Alpha' }, { id: 'm_b', name: 'beta' }, { id: 'm_ModelX' }]
check('case-insensitive name match', sameJson(ids(rowsForQuery(rows, 'ALPHA')), ['m_a']), JSON.stringify(ids(rowsForQuery(rows, 'ALPHA'))))
check('case-insensitive id match when name missing', sameJson(ids(rowsForQuery(rows, 'modelx')), ['m_ModelX']), JSON.stringify(ids(rowsForQuery(rows, 'modelx'))))
check('blank query returns every row once', sameJson(ids(rowsForQuery(rows, '  ')), ['m_a', 'm_b', 'm_ModelX']), JSON.stringify(ids(rowsForQuery(rows, '  '))))
check('query trims and matches id substring', sameJson(ids(rowsForQuery(rows, ' m_b ')), ['m_b']), JSON.stringify(ids(rowsForQuery(rows, ' m_b '))))
const dupRows = [{ id: 'm_a', name: 'Alpha' }, { id: 'm_a', name: 'Alpha again' }, { id: '  ', name: 'junk' }]
check('duplicate / blank ids are dropped', sameJson(ids(rowsForQuery(dupRows, '')), ['m_a']), JSON.stringify(ids(rowsForQuery(dupRows, ''))))

/* ------------------------------------------------- 6. cross-file source enum */
console.log('\n=== 6. cross-file: resolveWorkspaceModel source enum ===')

const workspaceSrc = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/workspaceModelPure.ts'), 'utf8')
const enumMatch = workspaceSrc.match(/source:\s*((?:'[a-z]+'\s*\|\s*)*'[a-z]+')/)
const enumList = enumMatch ? (enumMatch[1].match(/'([a-z]+)'/g) || []).map((s) => s.replace(/'/g, '')) : []

function objectKeys(text, decl) {
  const at = text.indexOf(decl)
  if (at < 0) return []
  const open = text.indexOf('{', at)
  const close = text.indexOf('}', open)
  if (open < 0 || close < 0) return []
  const body = text.slice(open + 1, close)
  return [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1])
}
const sourceLabelKeys = objectKeys(pureSrc, 'const SOURCE_LABEL')
const warnTextKeys = objectKeys(pureSrc, 'const WARN_TEXT')

check('resolveWorkspaceModel source enum parsed (4 values)', enumList.length === 4, JSON.stringify(enumList))
check('enum equals SOURCE_LABEL keys', sameJson([...enumList].sort(), [...sourceLabelKeys].sort()), `${JSON.stringify(enumList)} vs ${JSON.stringify(sourceLabelKeys)}`)
check('enum equals WARN_TEXT keys', sameJson([...enumList].sort(), [...warnTextKeys].sort()), `${JSON.stringify(enumList)} vs ${JSON.stringify(warnTextKeys)}`)

/* ------------------------------------------------- 7. static wiring */
console.log('\n=== 7. static: Preflight.tsx wiring ===')

const preflightSrc = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/Preflight.tsx'), 'utf8')
check('imports AnchoredLayer', preflightSrc.includes('AnchoredLayer'))
check('imports llmCatalogSetWorkspace', preflightSrc.includes('llmCatalogSetWorkspace'))
check('imports resolveWorkspaceModel / bindingPatch', preflightSrc.includes('resolveWorkspaceModel') && preflightSrc.includes('bindingPatch'))
check('new props are optional', preflightSrc.includes('workspaceId?: string') && preflightSrc.includes('conversationModelId?: string'))
check('layer aligned to end', preflightSrc.includes('align="end"'))
check('layer width 280 and max height 320', preflightSrc.includes('w-[280px]') && preflightSrc.includes('max-h-[320px]'))
check('no alert() / confirm()', !/\balert\s*\(/.test(preflightSrc) && !/\bconfirm\s*\(/.test(preflightSrc))
check('row is gated on workspaceId', preflightSrc.includes('{workspaceId && <PreflightModelRow'))

/* ------------------------------------------------------------ report */
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${ascii(c.name)}${c.detail && !c.pass ? '  -> ' + ascii(c.detail) : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup failure does not affect result */ }
process.exit(failed.length === 0 ? 0 : 1)
