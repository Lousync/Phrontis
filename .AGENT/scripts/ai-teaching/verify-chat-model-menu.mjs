#!/usr/bin/env node
/**
 * Contract check: assistant chat model menu pure layer
 * (`src/components/shared/AssistantPanel/chatModelMenuPure.ts`) plus the
 * wiring that ChatBody.tsx must keep.
 *
 * Locks:
 *   - group order curated / recent / all, and cross-group dedupe by entry id;
 *   - recent specs: unresolvable dropped, capped at 4;
 *   - empty catalog -> empty section list; empty curated -> no curated group;
 *   - rows carry free flag and only explicit yes/no capability chips (max 2);
 *   - filterChatModels: case-insensitive, modelId substring, blank query copy;
 *   - shouldShowSearch: 7/8/9 boundary;
 *   - modelLabelOf: empty -> default, entry -> name, legacy spec -> colon suffix;
 *   - ChatBody.tsx uses the catalog hook, writes entry ids, pushes recents,
 *     and does not import ModelMenu nor call alert()/confirm().
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-chat-model-menu.mjs [repo-path]
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

const REL = 'src/components/shared/AssistantPanel/chatModelMenuPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-model-menu-'))
const tmpFile = path.join(tmpDir, 'chatModelMenuPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const {
  buildChatModelSections, filterChatModels, shouldShowSearch, modelLabelOf, MAX_RECENT_ROWS,
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

const c1 = mk('m_c1', 'Fast Flash', { curated: true, capabilities: { vision: 'yes', tools: 'no', json: 'auto' } })
const c2 = mk('m_c2', 'Vision Pick', { curated: true })
const r1 = mk('m_r1', 'Recent Only')
const legacy = mk('m_legacy', 'Legacy Named', { providerId: 'p0', modelId: 'legacy-1' })
const plain = ['m_a1', 'm_a2', 'm_a3', 'm_a4', 'm_a5', 'm_a6'].map((id) => mk(id, `Plain ${id.slice(-2)}`))
const ALL = [c1, c2, r1, legacy, ...plain]

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
const sectionIds = (sections) => sections.map((s) => s.id).join('|')
const rowIds = (sections, id) => (sections.find((s) => s.id === id)?.rows ?? []).map((r) => r.entry.id).join('|')

// ---------------------------------------------------------------- 1. grouping
console.log('\n=== 1. buildChatModelSections: group order, content, dedupe ===')
const base = buildChatModelSections({
  entries: ALL,
  curated: [c1, c2],
  recentSpecs: ['m_r1', 'p0:legacy-1', 'm_ghost', 'p1:nope', 'm_c1'],
  resolve,
})
check('three groups in fixed order', sectionIds(base) === 'curated|recent|all', sectionIds(base))
check('titles are well formed (non-empty, distinct)',
  base.length === 3 && base.every((s) => typeof s.title === 'string' && s.title.length > 0)
  && new Set(base.map((s) => s.title)).size === 3, '')
check('curated group keeps curated order', rowIds(base, 'curated') === 'm_c1|m_c2', rowIds(base, 'curated'))
check('curated entries are deduped out of recent', rowIds(base, 'recent') === 'm_r1|m_legacy', rowIds(base, 'recent'))
check('unresolvable recent specs are dropped', !rowIds(base, 'recent').includes('m_ghost'), rowIds(base, 'recent'))
check('curated and recent entries are deduped out of all',
  rowIds(base, 'all') === plain.map((e) => e.id).join('|'), rowIds(base, 'all'))
check('every entry appears at most once across groups', (() => {
  const flat = base.flatMap((s) => s.rows.map((r) => r.entry.id))
  return new Set(flat).size === flat.length
})(), '')
check('all groups together cover every catalog entry', (() => {
  const flat = base.flatMap((s) => s.rows.map((r) => r.entry.id))
  return flat.length === ALL.length && ALL.every((e) => flat.includes(e.id))
})(), String(base.flatMap((s) => s.rows).length))

// ---------------------------------------------------------------- 2. recent cap
console.log('\n=== 2. buildChatModelSections: recent cap and empty cases ===')
const manyRecents = buildChatModelSections({
  entries: ALL,
  curated: [],
  recentSpecs: ['m_a1', 'm_a2', 'm_a3', 'm_a4', 'm_a5', 'm_a6'],
  resolve,
})
check('recent is capped at MAX_RECENT_ROWS', MAX_RECENT_ROWS === 4, String(MAX_RECENT_ROWS))
check('recent keeps at most 4 rows', (manyRecents.find((s) => s.id === 'recent')?.rows.length ?? 0) === 4,
  String(manyRecents.find((s) => s.id === 'recent')?.rows.length ?? 0))
check('dropped recent rows fall through to all',
  (manyRecents.find((s) => s.id === 'all')?.rows.length ?? 0) === ALL.length - 4,
  String(manyRecents.find((s) => s.id === 'all')?.rows.length ?? 0))
check('duplicate curated ids collapse to one row',
  (buildChatModelSections({ entries: ALL, curated: [c1, c1], recentSpecs: [], resolve })
    .find((s) => s.id === 'curated')?.rows.length ?? 0) === 1, '')
check('empty catalog -> empty section list',
  buildChatModelSections({ entries: [], curated: [], recentSpecs: ['m_x', 'p1:y'], resolve: () => null }).length === 0, '')
check('empty curated -> no curated group, all still populated', (() => {
  const s = buildChatModelSections({ entries: ALL, curated: [], recentSpecs: [], resolve })
  return !s.some((x) => x.id === 'curated') && rowIds(s, 'all') === ALL.map((e) => e.id).join('|')
})(), '')
check('unresolvable-only recents -> no recent group', (() => {
  const s = buildChatModelSections({ entries: ALL, curated: [], recentSpecs: ['m_ghost', 'p1:nope'], resolve })
  return !s.some((x) => x.id === 'recent')
})(), '')

// ---------------------------------------------------------------- 3. row payload
console.log('\n=== 3. row payload: free flag and explicit capability chips ===')
const rich = buildChatModelSections({
  entries: [mk('m_rich', 'Rich', { free: true, capabilities: { vision: 'yes', tools: 'no', json: 'auto', imageGeneration: 'yes' } })],
  curated: [],
  recentSpecs: [],
  resolve: () => null,
})
const richRow = rich[0]?.rows[0]
check('free flag is carried to the row', richRow?.free === true, '')
check('auto capabilities do not produce chips', (richRow?.chips ?? []).length === 2, String((richRow?.chips ?? []).length))
check('chips are capped at 2 and keep capability order',
  (richRow?.chips ?? []).length === 2 && richRow.chips[0] !== richRow.chips[1], (richRow?.chips ?? []).join(','))
const bareRow = buildChatModelSections({ entries: [mk('m_bare', 'Bare')], curated: [], recentSpecs: [], resolve: () => null })[0].rows[0]
check('no explicit capability -> no chips, free false', bareRow.chips.length === 0 && bareRow.free === false, '')

// ---------------------------------------------------------------- 4. filterChatModels
console.log('\n=== 4. filterChatModels ===')
const byName = mk('m_flash', 'DeepSeek Flash', { modelId: 'deepseek-v4.1-flash' })
const byId = mk('m_plain', 'Plain Model', { modelId: 'GLM-5.2', providerId: 'opencode' })
const pool = [byName, byId]
check('case-insensitive name match', filterChatModels(pool, 'deepseek FLASH').length === 1
  && filterChatModels(pool, 'deepseek FLASH')[0].id === byName.id, '')
check('modelId substring match', filterChatModels(pool, 'v4.1').length === 1
  && filterChatModels(pool, 'v4.1')[0].id === byName.id, '')
check('modelId match is case-insensitive', filterChatModels(pool, 'glm-5').length === 1
  && filterChatModels(pool, 'glm-5')[0].id === byId.id, '')
check('no match -> empty array', filterChatModels(pool, 'nothing-here').length === 0, '')
check('blank query returns a copy, not the same array', (() => {
  const a = filterChatModels(pool, '')
  const b = filterChatModels(pool, '   ')
  return a.length === 2 && b.length === 2 && a !== pool && b !== pool
})(), '')

// ---------------------------------------------------------------- 5. shouldShowSearch
console.log('\n=== 5. shouldShowSearch boundary ===')
check('7 rows -> hidden', shouldShowSearch(7) === false, '')
check('8 rows -> hidden', shouldShowSearch(8) === false, '')
check('9 rows -> shown', shouldShowSearch(9) === true, '')
check('non-numeric / negative -> hidden', shouldShowSearch(Number.NaN) === false && shouldShowSearch(-1) === false, '')

// ---------------------------------------------------------------- 6. modelLabelOf
console.log('\n=== 6. modelLabelOf fallbacks ===')
check('empty value falls back to the default label', modelLabelOf('', ALL) === '默认模型' && modelLabelOf('   ', ALL) === '默认模型', '')
check('entry id resolves to the entry name', modelLabelOf('m_c1', ALL) === 'Fast Flash', modelLabelOf('m_c1', ALL))
check('legacy spec with a live entry resolves to the entry name',
  modelLabelOf('p0:legacy-1', ALL) === 'Legacy Named', modelLabelOf('p0:legacy-1', ALL))
check('legacy spec without a matching entry falls back to the colon suffix',
  modelLabelOf('p9:ghost-model', ALL) === 'ghost-model', modelLabelOf('p9:ghost-model', ALL))
check('unknown entry id is shown as-is (no silent truncation)',
  modelLabelOf('m_ghost', ALL) === 'm_ghost', modelLabelOf('m_ghost', ALL))
check('plain string is shown as-is', modelLabelOf('gpt-4', ALL) === 'gpt-4', modelLabelOf('gpt-4', ALL))

// ---------------------------------------------------------------- 7. static wiring
console.log('\n=== 7. ChatBody.tsx wiring ===')
const chatBody = fs.readFileSync(path.join(ROOT, 'src/components/shared/AssistantPanel/ChatBody.tsx'), 'utf8')
check('ChatBody uses the shared catalog hook', /\buseModelCatalog\b/.test(chatBody), '')
check('ChatBody builds sections from the pure layer', /buildChatModelSections\s*\(/.test(chatBody), '')
check('ChatBody pushes recents on pick', /pushRecentSpec\s*\(/.test(chatBody), '')
check('ChatBody writes the picked value through setModelId', /setModelId\s*\(/.test(chatBody), '')
check('ChatBody renders the management row only through the optional prop',
  /onManageModels\?\.?/.test(chatBody), '')
check('ChatBody has no alert() call', !/\balert\s*\(/.test(chatBody), '')
check('ChatBody has no confirm() call', !/\bconfirm\s*\(/.test(chatBody), '')
check('ChatBody does not import ModelMenu', !/from\s+['"][^'"]*\bModelMenu\b['"]/.test(chatBody), '')

// ---------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup is best-effort */ }
process.exit(failed.length === 0 ? 0 : 1)
