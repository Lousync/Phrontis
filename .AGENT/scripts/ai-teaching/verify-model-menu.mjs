#!/usr/bin/env node
/**
 * Contract check: model menu pure layer
 * (`src/components/shared/modelMenuPure.ts`).
 *
 * Plan: /home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md section 6.1
 *       /home/lousync/桌面/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md section 15.3
 *
 * The script runs the real implementation (types stripped) and locks:
 *   - the four group order (workspace default / workspace curated / global curated / recent);
 *   - cross-group dedupe: one entry appears only in the earliest group;
 *   - workspace default equal to global default -> no duplicated group;
 *   - unresolvable recent specs are dropped;
 *   - empty input -> no sections; empty curated -> no global curated group;
 *   - filterMenuEntries: case-insensitive, modelId substring, empty query copy;
 *   - nextIndex: wrap-around navigation and total<=0 boundary;
 *   - menuLabel: name -> modelId -> entry id fallback chain.
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-model-menu.mjs [repo-path]
 * Output is pure ASCII (AGENTS.md); exit 0 only when every assertion passes.
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

const REL = 'src/components/shared/modelMenuPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-menu-'))
const tmpFile = path.join(tmpDir, 'modelMenuPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const {
  buildMenuSections, filterMenuEntries, nextIndex, menuLabel,
} = await import(pathToFileURL(tmpFile).href)

// ---------------------------------------------------------------- fixtures
const mk = (id, name, extra = {}) => ({
  id,
  name,
  providerId: 'p1',
  modelId: `model-${id}`,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  reasoning: { supported: false, default: 'off' },
  capabilities: {},
  curated: false,
  free: false,
  source: 'user',
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  ...extra,
})

const e1 = mk('m_ws_default', 'Course Default', { modelId: 'model-a' })
const e2 = mk('m_ws_curated', 'Course Pick', { modelId: 'model-b' })
const e3 = mk('m_shared', 'Shared Pick', { modelId: 'model-c', curated: true })
const e4 = mk('m_global_only', 'Global Pick', { modelId: 'model-d', curated: true })
const e5 = mk('m_recent_only', 'Recent Pick', { modelId: 'model-e' })
const ALL = [e1, e2, e3, e4, e5]

/** Same resolution rules as `resolveCatalogEntry` in src/lib/modelCatalog.ts. */
const resolverFor = (entries) => (spec) => {
  const s = String(spec ?? '').trim()
  if (!s) return null
  const hit = entries.find((e) => e.id === s)
  if (hit) return { entry: hit }
  if (s.startsWith('m_')) return null
  const i = s.indexOf(':')
  if (i <= 0 || i === s.length - 1) return null
  const same = entries.find((e) => e.providerId === s.slice(0, i) && e.modelId === s.slice(i + 1))
  return same ? { entry: same } : null
}
const resolve = resolverFor(ALL)

const ids = (sections) => sections.map((s) => s.id).join('|')
const itemIds = (sections, id) => (sections.find((s) => s.id === id)?.items ?? []).map((e) => e.id).join('|')

// ---------------------------------------------------------------- 1. grouping
console.log('\n=== 1. buildMenuSections: group order and content ===')
const base = buildMenuSections({
  entries: ALL,
  curated: [e3, e4],
  workspaceDefaultId: e1.id,
  globalDefaultId: e4.id,
  workspaceCuratedIds: [e2.id, e3.id],
  recentSpecs: [e5.id, e2.id, e1.id],
  resolve,
})
check('four groups in fixed order', ids(base) === 'workspaceDefault|workspaceCurated|curated|recent', ids(base))
check('group titles are the agreed labels',
  base.map((s) => s.title).join('|') === '本课程默认|本课程精选|全局精选|最近使用',
  base.map((s) => s.title).join('|'))
check('workspace default group holds exactly the bound entry', itemIds(base, 'workspaceDefault') === e1.id, itemIds(base, 'workspaceDefault'))
check('workspace curated keeps given order', itemIds(base, 'workspaceCurated') === `${e2.id}|${e3.id}`, itemIds(base, 'workspaceCurated'))
check('entry in workspace curated is deduped out of global curated', itemIds(base, 'curated') === e4.id, itemIds(base, 'curated'))
check('recent drops entries already shown earlier',
  itemIds(base, 'recent') === e5.id,
  itemIds(base, 'recent'))
check('every entry appears at most once across groups', (() => {
  const flat = base.flatMap((s) => s.items.map((e) => e.id))
  return new Set(flat).size === flat.length
})(), '')

// ---------------------------------------------------------------- 2. dedupe / default
console.log('\n=== 2. buildMenuSections: default dedupe and tolerance ===')
const sameDefault = buildMenuSections({
  entries: ALL,
  curated: [e1, e4],
  workspaceDefaultId: e1.id,
  globalDefaultId: e1.id,
  workspaceCuratedIds: [],
  recentSpecs: [],
  resolve,
})
check('same workspace/global default -> no workspace default group',
  !sameDefault.some((s) => s.id === 'workspaceDefault'),
  ids(sameDefault))
check('same default entry still shows once in global curated',
  itemIds(sameDefault, 'curated') === `${e1.id}|${e4.id}`,
  itemIds(sameDefault, 'curated'))

const noGlobalDefault = buildMenuSections({
  entries: ALL,
  curated: [],
  workspaceDefaultId: e1.id,
  workspaceCuratedIds: [],
  recentSpecs: [],
  resolve,
})
check('without global default the binding still shows (no silent drop)',
  itemIds(noGlobalDefault, 'workspaceDefault') === e1.id,
  ids(noGlobalDefault))

const legacyDefault = buildMenuSections({
  entries: ALL,
  curated: [],
  workspaceDefaultId: 'p1:model-a',
  workspaceCuratedIds: [],
  recentSpecs: [],
  resolve,
})
check('legacy providerId:modelId binding resolves to the entry',
  itemIds(legacyDefault, 'workspaceDefault') === e1.id,
  ids(legacyDefault))

// ---------------------------------------------------------------- 3. filter / empties
console.log('\n=== 3. buildMenuSections: unresolvable specs and empty groups ===')
const badRecent = buildMenuSections({
  entries: ALL,
  curated: [],
  workspaceCuratedIds: [],
  recentSpecs: ['m_does_not_exist', 'p1:unknown-model', 'p1:model-e'],
  resolve,
})
check('unresolvable recent specs are filtered out',
  ids(badRecent) === 'recent' && itemIds(badRecent, 'recent') === e5.id,
  ids(badRecent) + ' / ' + (badRecent[0]?.items.map((e) => e.id).join('|') ?? ''))
check('all-unresolvable recent specs -> empty section list',
  buildMenuSections({ entries: ALL, curated: [], workspaceCuratedIds: [], recentSpecs: ['m_nope', 'x:y'], resolve }).length === 0, '')

check('empty input -> empty array', buildMenuSections({
  entries: [], curated: [], recentSpecs: [], resolve: () => null,
}).length === 0, '')

check('empty curated -> no global curated group', !buildMenuSections({
  entries: ALL, curated: [], workspaceCuratedIds: [], recentSpecs: [], resolve,
}).some((s) => s.id === 'curated'), '')

check('missing workspaceCuratedIds -> no workspace curated group', (() => {
  const s = buildMenuSections({ entries: ALL, curated: [e4], recentSpecs: [], resolve })
  return ids(s) === 'curated'
})(), '')

check('unknown workspace curated ids are dropped, group disappears when all unknown', (() => {
  const s = buildMenuSections({
    entries: ALL, curated: [], workspaceCuratedIds: ['m_ghost'], recentSpecs: [], resolve,
  })
  return s.length === 0
})(), '')

// ---------------------------------------------------------------- 4. filterMenuEntries
console.log('\n=== 4. filterMenuEntries ===')
const byName = mk('m_flash', 'DeepSeek Flash', { modelId: 'deepseek-v4.1-flash' })
const byId = mk('m_plain', 'Plain Model', { modelId: 'GLM-5.2', providerId: 'opencode' })
const pool = [byName, byId]
check('case-insensitive name match', filterMenuEntries(pool, 'deepseek FLASH').length === 1
  && filterMenuEntries(pool, 'deepseek FLASH')[0].id === byName.id, '')
check('modelId substring match', filterMenuEntries(pool, 'v4.1').length === 1
  && filterMenuEntries(pool, 'v4.1')[0].id === byName.id, '')
check('modelId match is case-insensitive', filterMenuEntries(pool, 'glm-5').length === 1
  && filterMenuEntries(pool, 'glm-5')[0].id === byId.id, '')
check('provider name is searchable too', filterMenuEntries(pool, 'opencode').length === 1
  && filterMenuEntries(pool, 'opencode')[0].id === byId.id, '')
check('no match -> empty array', filterMenuEntries(pool, 'nothing-here').length === 0, '')
check('empty query returns every entry', filterMenuEntries(pool, '').length === 2, '')
check('empty / blank query returns a copy, not the same array', (() => {
  const a = filterMenuEntries(pool, '')
  const b = filterMenuEntries(pool, '   ')
  return a.length === 2 && b.length === 2 && a !== pool && b !== pool
})(), '')

// ---------------------------------------------------------------- 5. nextIndex
console.log('\n=== 5. nextIndex ===')
check('moves forward', nextIndex(1, 1, 3) === 2, String(nextIndex(1, 1, 3)))
check('wraps forward past the end', nextIndex(2, 1, 3) === 0, String(nextIndex(2, 1, 3)))
check('wraps backward before the start', nextIndex(0, -1, 3) === 2, String(nextIndex(0, -1, 3)))
check('total = 0 -> 0', nextIndex(0, 1, 0) === 0 && nextIndex(5, -1, 0) === 0, '')
check('negative total -> 0', nextIndex(3, 1, -4) === 0, '')
check('out-of-range current is normalized', nextIndex(5, 0, 3) === 2 && nextIndex(-1, 0, 3) === 2,
  `${nextIndex(5, 0, 3)} / ${nextIndex(-1, 0, 3)}`)
check('single item list stays at 0', nextIndex(0, 3, 1) === 0, '')

// ---------------------------------------------------------------- 6. menuLabel
console.log('\n=== 6. menuLabel ===')
check('name wins over modelId',
  menuLabel(mk('m_1', 'Fast DeepSeek', { modelId: 'deepseek-v4' })) === 'Fast DeepSeek', '')
check('empty name falls back to modelId',
  menuLabel(mk('m_2', '   ', { modelId: 'deepseek-v4' })) === 'deepseek-v4', '')
check('name and modelId both empty -> entry id',
  menuLabel(mk('m_3', '', { modelId: '' })) === 'm_3', menuLabel(mk('m_3', '', { modelId: '' })))
check('fallback label appends provider name (only when name is missing)',
  menuLabel(mk('m_4', '', { modelId: 'glm-5.2' }), 'OpenCode') === 'glm-5.2 · OpenCode', '')
check('named entry keeps label short (provider is small text in the row)',
  menuLabel(mk('m_5', 'Fast', { modelId: 'glm-5.2' }), 'OpenCode') === 'Fast', '')

// ---------------------------------------------------------------- 7. AI teaching composer menu
// 2026-11-20 重做：AI 教学的模型菜单只消费设置里配置的条目（shared ModelMenu 不动）。
console.log('\n=== 7. AI teaching composer menu consumes entries only ===')
const teach = fs.readFileSync(path.join(ROOT, 'src/modules/ai-teaching/index.tsx'), 'utf8')
check('AI teaching menu consumes modelCatalog.entries', /modelCatalog\.entries/.test(teach), '')
check('AI teaching menu no longer renders the providerList inventory', !/\bproviderList\b/.test(teach), '')
check('AI teaching menu no longer calls provider / vision inventory IPC',
  !/llmListProviders\s*\(/.test(teach) && !/llmVisionModels\s*\(/.test(teach), '')

// ---------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup is best-effort */ }
process.exit(failed.length === 0 ? 0 : 1)
