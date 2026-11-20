#!/usr/bin/env node
/**
 * Contract check: settings > AI > model entries pure layer (P3.2)
 *   src/modules/settings/views/modelCatalogUiPure.ts
 *
 * Assertions (real implementation, stripped + imported, source untouched):
 *   1. filterEntries: case-insensitive, empty query returns all in original order,
 *      name and modelId both match, returns a copy (negative);
 *   2. groupForPicker: curated group first, single "all" group when nothing is curated,
 *      no duplicated group when everything is curated;
 *   3. validateSaveInput: empty provider / empty model / negative window / over-long name;
 *   4. refsText: slot:<key> becomes readable Chinese, global / workspace forms, dedupe;
 *   5. sortEntries: curated first, sortOrder ordering, stable for equal keys;
 *   6. applyEntryPick: entry mode -> id, spec mode -> providerId:modelId;
 *   7. drift guard: slot labels here must equal SLOT_LABEL in src/lib/modelCatalog.ts.
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-model-catalog-ui.mjs [repo path]
 * Output is ASCII only (non-ASCII is escaped in failure details). Exit 0 = all pass.
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
/** Print inline (reads as a sectioned report) while still counting for the exit code */
const check = (name, pass, detail = '') => {
  checks.push({ name, pass })
  if (!pass) console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`)
  else console.log(`  [OK] ${name}`)
}

/** Keep stdout ASCII even when a failing detail embeds Chinese labels */
const ascii = (v) => JSON.stringify(v).replace(/[^\x20-\x7e]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))

const REL = 'src/modules/settings/views/modelCatalogUiPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-ui-'))
const tmpFile = path.join(tmpDir, 'modelCatalogUiPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const {
  filterEntries,
  groupForPicker,
  validateSaveInput,
  refsText,
  sortEntries,
  applyEntryPick,
  MODEL_NAME_MAX,
} = await import(pathToFileURL(tmpFile).href)

const entry = (over = {}) => ({
  id: `m_${over.id ?? 'x'}`,
  name: 'N',
  providerId: 'p1',
  modelId: 'mid',
  reasoning: { supported: false, default: 'off' },
  capabilities: {},
  curated: false,
  source: 'user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const E1 = entry({ id: 'a', name: 'GPT 4o', modelId: 'gpt-4o', curated: true })
const E2 = entry({ id: 'b', name: 'Claude Sonnet', modelId: 'claude-3-5-sonnet' })
const E3 = entry({ id: 'c', name: 'DeepSeek Chat', modelId: 'deepseek-chat' })
const ALL = [E1, E2, E3]

/* ---------------------------------------------------------------- 1. filter */
console.log('\n=== 1. filterEntries ===')
const hitName = filterEntries(ALL, 'gpt')
check('case-insensitive name match', hitName.length === 1 && hitName[0].id === E1.id, ascii(hitName.map((e) => e.id)))
const hitModel = filterEntries(ALL, 'CLAUDE')
check('case-insensitive modelId match (upper query)', hitModel.length === 1 && hitModel[0].id === E2.id, ascii(hitModel.map((e) => e.id)))
const hitSub = filterEntries(ALL, '4O')
check('partial modelId match, mixed case', hitSub.length === 1 && hitSub[0].id === E1.id, ascii(hitSub.map((e) => e.id)))
const all = filterEntries(ALL, '')
check('empty query returns every entry', all.length === ALL.length, String(all.length))
check('empty query keeps input order', all.map((e) => e.id).join('|') === ALL.map((e) => e.id).join('|'), ascii(all.map((e) => e.id)))
check('whitespace-only query equals empty query', filterEntries(ALL, '   ').length === ALL.length, '')
check('empty query returns a copy, not the same array (negative)', filterEntries(ALL, '') !== ALL, '')
const miss = filterEntries(ALL, 'zzz-no-such')
check('non-matching query returns []', miss.length === 0, String(miss.length))

/* ---------------------------------------------------------------- 2. groups */
console.log('\n=== 2. groupForPicker ===')
const g1 = groupForPicker(ALL)
check('curated group comes first', g1[0]?.title === '精选', ascii(g1.map((g) => g.title)))
check('curated group holds only curated entries', g1[0]?.items.length === 1 && g1[0].items[0].id === E1.id, ascii(g1[0]?.items.map((e) => e.id)))
check('second group holds all entries', g1.length === 2 && g1[1].items.length === ALL.length, String(g1.length) + '/' + String(g1[1]?.items.length))
const gNone = groupForPicker([E2, E3])
check('no curated -> exactly one group', gNone.length === 1, String(gNone.length))
check('no curated -> group holds all entries', gNone[0].items.length === 2, String(gNone[0].items.length))
const gAllCurated = groupForPicker([entry({ id: 'r1', curated: true }), entry({ id: 'r2', curated: true })])
check('everything curated -> no duplicated second group', gAllCurated.length === 1, String(gAllCurated.length))

/* ---------------------------------------------------------------- 3. validate */
console.log('\n=== 3. validateSaveInput ===')
check('empty providerId is rejected', validateSaveInput({ providerId: '', modelId: 'm' }) === '请选择供应商', ascii(validateSaveInput({ providerId: '', modelId: 'm' })))
check('empty modelId is rejected', validateSaveInput({ providerId: 'p', modelId: '  ' }) === '请选择模型', ascii(validateSaveInput({ providerId: 'p', modelId: '  ' })))
check('negative contextWindow is rejected', !!validateSaveInput({ providerId: 'p', modelId: 'm', contextWindow: -1 }), ascii(validateSaveInput({ providerId: 'p', modelId: 'm', contextWindow: -1 })))
check('zero contextWindow is rejected', !!validateSaveInput({ providerId: 'p', modelId: 'm', contextWindow: 0 }), ascii(validateSaveInput({ providerId: 'p', modelId: 'm', contextWindow: 0 })))
check('NaN contextWindow is rejected', !!validateSaveInput({ providerId: 'p', modelId: 'm', contextWindow: Number.NaN }), '')
check('over-long name is rejected', !!validateSaveInput({ name: 'x'.repeat(MODEL_NAME_MAX + 1), providerId: 'p', modelId: 'm' }), '')
check('name at the limit is accepted', validateSaveInput({ name: 'x'.repeat(MODEL_NAME_MAX), providerId: 'p', modelId: 'm' }) === null, ascii(validateSaveInput({ name: 'x'.repeat(MODEL_NAME_MAX), providerId: 'p', modelId: 'm' })))
check('valid input returns null', validateSaveInput({ name: 'ok', providerId: 'p', modelId: 'm', contextWindow: 128000 }) === null, '')

/* ---------------------------------------------------------------- 4. refsText */
console.log('\n=== 4. refsText ===')
const slotText = refsText([{ entryId: 'm_a', where: 'slot:assistantModelId' }])
check('slot:<key> becomes a readable Chinese location', slotText.length === 1 && /场景/.test(slotText[0]) && /AI 助手/.test(slotText[0]), ascii(slotText))
check('raw where string does not leak into the slot label', !slotText[0].includes('slot:'), ascii(slotText))
check('global default is readable', refsText([{ entryId: 'm_a', where: 'global:default' }])[0] === '全局默认模型', ascii(refsText([{ entryId: 'm_a', where: 'global:default' }])))
const wsText = refsText([
  { entryId: 'm_a', where: 'workspace:ws-1:default' },
  { entryId: 'm_a', where: 'workspace:ws-1:curated' },
])
check('workspace default / curated are both readable', wsText.length === 2 && /ws-1/.test(wsText[0]) && /默认/.test(wsText[0]) && /精选/.test(wsText[1]), ascii(wsText))
check('duplicate where is de-duplicated', refsText([
  { entryId: 'm_a', where: 'global:default' },
  { entryId: 'm_a', where: 'global:default' },
]).length === 1, '')
check('unknown where does not throw and keeps the raw hint', (() => {
  const t = refsText([{ entryId: 'm_a', where: 'mystery:place' }])
  return t.length === 1 && t[0].includes('mystery:place')
})(), '')

/* ---------------------------------------------------------------- 5. sort */
console.log('\n=== 5. sortEntries ===')
const sortIn = [
  entry({ id: 's1', name: 'B model', modelId: 'm1', curated: false }),
  entry({ id: 's2', name: 'A model', modelId: 'm2', curated: true }),
  entry({ id: 's3', name: 'C model', modelId: 'm3', curated: false }),
]
const sorted = sortEntries(sortIn)
check('curated entry floats to the top', sorted[0].id === 's2', ascii(sorted.map((e) => e.id)))
check('sortEntries does not mutate the input array', sortIn[0].id === 's1' && sortIn.length === 3, ascii(sortIn.map((e) => e.id)))
const stableIn = [
  entry({ id: 't1', name: 'same', modelId: 'm-a', curated: true, sortOrder: 2 }),
  entry({ id: 't2', name: 'same', modelId: 'm-b', curated: true, sortOrder: 2 }),
  entry({ id: 't3', name: 'same', modelId: 'm-c', curated: true, sortOrder: 2 }),
]
check('equal sort keys keep input order (stable)', sortEntries(stableIn).map((e) => e.id).join('|') === 't1|t2|t3', ascii(sortEntries(stableIn).map((e) => e.id)))
const orderIn = [
  entry({ id: 'o1', name: 'Z', sortOrder: 5 }),
  entry({ id: 'o2', name: 'A', sortOrder: 1 }),
  entry({ id: 'o3', name: 'M' }),
]
const orderOut = sortEntries(orderIn).map((e) => e.id).join('|')
check('sortOrder wins over name, missing sortOrder goes last', orderOut === 'o2|o1|o3', orderOut)

/* ---------------------------------------------------------------- 6. applyEntryPick */
console.log('\n=== 6. applyEntryPick ===')
check('entry mode returns the entry id', applyEntryPick('entry', E1) === E1.id, ascii(applyEntryPick('entry', E1)))
check('spec mode returns providerId:modelId', applyEntryPick('spec', E1) === 'p1:gpt-4o', ascii(applyEntryPick('spec', E1)))

/* ---------------------------------------------------------------- 7. label drift */
console.log('\n=== 7. slot label drift guard ===')
const catalogSrc = fs.readFileSync(path.join(ROOT, 'src/lib/modelCatalog.ts'), 'utf8')
const labelBlock = /export const SLOT_LABEL[^{]*\{([\s\S]*?)\n\}/.exec(catalogSrc)?.[1] ?? ''
const labelOf = (key) => new RegExp(`${key}:\\s*'([^']+)'`).exec(labelBlock)?.[1] ?? ''
const slots = [
  'defaultChatModel', 'assistantModelId', 'aiAssistantInlineSuggestModelId',
  'aiTranslateModelId', 'agentCompressModelId', 'aiTeachVisionModel',
  'aiImageModel', 'aiImageEditModel',
]
check('SLOT_LABEL block was found in modelCatalog.ts', labelBlock.length > 0, String(labelBlock.length))
const drift = slots.filter((k) => {
  const expected = labelOf(k)
  const got = refsText([{ entryId: 'm_a', where: `slot:${k}` }])[0] ?? ''
  return !expected || got !== `场景「${expected}」`
})
check('all 8 slot labels match modelCatalog.SLOT_LABEL', drift.length === 0, ascii(drift))

/* ---------------------------------------------------------------- report */
const failed = checks.filter((c) => !c.pass)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup is best-effort */ }
process.exit(failed.length === 0 ? 0 : 1)
