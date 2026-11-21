#!/usr/bin/env node
/**
 * 契约验证：AI 教学重构 · 模型目录纯函数（P0）
 *   · electron/lib/modelCatalogPure.ts
 *   · electron/lib/modelCapabilityTable.ts
 *
 * 断言口径（跑真实实现：stripTypeScriptTypes 后动态 import，不改被验文件）：
 *   1. normalizeCatalog 容错（null / 混垃圾 / 重复 id / 缺字段 / 排序）；
 *   2. resolveModelEntry 五级顺序 + 已删 id 继续往下找；
 *   3. lookupCapability 四段链（显式 > 表 > 名称正则 > auto）；
 *   4. isLegacySpec / parseLegacySpec 正反例；
 *   5. findReferences 四处引用 + 去重 + 旧 spec 映射；
 *   6. pickSlotCandidates 软过滤（blocked 给中文原因）；
 *   7. entryLabel / dedupeBySpec；
 *   8. 内置能力表（版本 / 条数 / 命中 / 负向不误判）。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-model-catalog.mjs [仓库路径]
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'))

/** strip 类型后落到临时 .mjs，再动态 import（类型 import 会被整行抹掉，无需移动依赖） */
async function loadPure(rel, outName) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const file = path.join(tmpDir, outName)
  fs.writeFileSync(file, stripTypeScriptTypes(src, { mode: 'strip' }))
  return import(pathToFileURL(file).href)
}

const catalogMod = await loadPure('electron/lib/modelCatalogPure.ts', 'modelCatalogPure.mjs')
const tableMod = await loadPure('electron/lib/modelCapabilityTable.ts', 'modelCapabilityTable.mjs')

const {
  normalizeCatalog,
  resolveModelEntry,
  lookupCapability: capabilityOf,
  isLegacySpec,
  parseLegacySpec,
  findReferences,
  pickSlotCandidates,
  entryLabel,
  dedupeBySpec,
  REASONING_NAME_RE,
} = catalogMod
const {
  CAPABILITY_TABLE_VERSION,
  CAPABILITY_PATTERNS,
  lookupCapability: tableLookup,
  lookupAll,
} = tableMod

const ISO = '2026-01-01T00:00:00.000Z'
const entry = (over = {}) => ({
  id: 'm_a',
  name: 'A',
  providerId: 'p',
  modelId: 'model-a',
  reasoning: { supported: false, default: 'off' },
  capabilities: {},
  curated: false,
  source: 'auto',
  createdAt: ISO,
  updatedAt: ISO,
  ...over,
})

/* ============================ 1. normalizeCatalog ============================ */
console.log('\n=== 1. normalizeCatalog: tolerant normalization ===')

check('normalizeCatalog(null) -> [] without throwing', Array.isArray(normalizeCatalog(null)) && normalizeCatalog(null).length === 0, '')
check('normalizeCatalog(non-array) -> []', normalizeCatalog('x').length === 0 && normalizeCatalog({ a: 1 }).length === 0 && normalizeCatalog(42).length === 0, '')

const mixed = normalizeCatalog([
  null,
  42,
  'oops',
  [],
  {},
  { providerId: 'p', modelId: '' },
  { providerId: '', modelId: 'x' },
  { id: 'm_ok', name: 'OK', providerId: 'p', modelId: 'gpt-4o' },
])
check('mixed garbage array keeps only valid entries', mixed.length === 1 && mixed[0].id === 'm_ok', JSON.stringify(mixed.map((e) => e.id)))

const dupIds = normalizeCatalog([
  { id: 'm_1', providerId: 'p', modelId: 'a', name: 'first' },
  { id: 'm_1', providerId: 'p', modelId: 'b', name: 'second' },
  { id: 'm_1', providerId: 'p', modelId: 'c', name: 'third' },
])
check(
  'duplicate id keeps first, later get -dup suffix, no data loss',
  dupIds.length === 3 &&
    dupIds[0].id === 'm_1' && dupIds[0].name === 'first' &&
    dupIds[1].id === 'm_1-dup' && dupIds[1].name === 'second' &&
    dupIds[2].id === 'm_1-dup2' && dupIds[2].name === 'third',
  JSON.stringify(dupIds.map((e) => [e.id, e.name]))
)

const dflt = normalizeCatalog([{ providerId: 'p', modelId: 'm' }])[0]
check('missing id generates m_ prefixed id', !!dflt && dflt.id.startsWith('m_'), dflt && dflt.id)
check('missing reasoning defaults to supported:false/off', JSON.stringify(dflt.reasoning) === '{"supported":false,"default":"off"}', JSON.stringify(dflt.reasoning))
check('missing capabilities stays empty (no hardcoded yes/no)', Object.keys(dflt.capabilities).length === 0, JSON.stringify(dflt.capabilities))

const capsRaw = normalizeCatalog([
  { id: 'm_c', providerId: 'p', modelId: 'm', capabilities: { vision: 'yes', tools: 'maybe', json: 'auto' } },
])[0]
check(
  'capabilities keeps only explicit yes/no (drops invalid and auto)',
  capsRaw.capabilities.vision === 'yes' && capsRaw.capabilities.tools === undefined && capsRaw.capabilities.json === undefined,
  JSON.stringify(capsRaw.capabilities)
)

const sorted = normalizeCatalog([
  { id: 'm_s2', providerId: 'p', modelId: 's2', sortOrder: 2, createdAt: '2026-01-01' },
  { id: 'm_s1', providerId: 'p', modelId: 's1', sortOrder: 1, createdAt: '2026-02-01' },
  { id: 'm_s3', providerId: 'p', modelId: 's3', createdAt: '2026-01-15' },
  { id: 'm_s4', providerId: 'p', modelId: 's4', createdAt: '2026-01-10' },
])
check('sorts by sortOrder then createdAt (missing sortOrder last)', sorted.map((e) => e.id).join(',') === 'm_s1,m_s2,m_s4,m_s3', sorted.map((e) => e.id).join(','))

/* ============================ 2. resolveModelEntry ============================ */
console.log('\n=== 2. resolveModelEntry: five-level order ===')

const CAT = [
  entry({ id: 'm_conv', name: 'conversation' }),
  entry({ id: 'm_ws', name: 'workspace' }),
  entry({ id: 'm_glob', name: 'global' }),
  entry({ id: 'm_wscur1', name: 'workspace curated 1' }),
  entry({ id: 'm_globcur', name: 'global curated', curated: true }),
]

const resolvedId = (input) => {
  const hit = resolveModelEntry(input)
  return hit ? hit.id : null
}

check(
  'conversation override beats workspace and global',
  resolvedId({ catalog: CAT, conversationEntryId: 'm_conv', workspaceEntryId: 'm_ws', globalDefaultId: 'm_glob' }) === 'm_conv',
  String(resolvedId({ catalog: CAT, conversationEntryId: 'm_conv', workspaceEntryId: 'm_ws', globalDefaultId: 'm_glob' }))
)
check(
  'workspace default beats global default',
  resolvedId({ catalog: CAT, workspaceEntryId: 'm_ws', globalDefaultId: 'm_glob' }) === 'm_ws',
  String(resolvedId({ catalog: CAT, workspaceEntryId: 'm_ws', globalDefaultId: 'm_glob' }))
)
check(
  'global default used when conversation/workspace empty',
  resolvedId({ catalog: CAT, globalDefaultId: 'm_glob' }) === 'm_glob',
  String(resolvedId({ catalog: CAT, globalDefaultId: 'm_glob' }))
)
check(
  'workspace curated first when no defaults',
  resolvedId({ catalog: CAT, workspaceCuratedIds: ['m_wscur1', 'm_globcur'] }) === 'm_wscur1',
  String(resolvedId({ catalog: CAT, workspaceCuratedIds: ['m_wscur1', 'm_globcur'] }))
)
check(
  'global curated first as fallback',
  resolvedId({ catalog: CAT }) === 'm_globcur',
  String(resolvedId({ catalog: CAT }))
)
check(
  'deleted conversation id is skipped, falls through to workspace',
  resolvedId({ catalog: CAT, conversationEntryId: 'm_gone', workspaceEntryId: 'm_ws' }) === 'm_ws',
  String(resolvedId({ catalog: CAT, conversationEntryId: 'm_gone', workspaceEntryId: 'm_ws' }))
)
check(
  'all referenced ids deleted and no curated -> null',
  resolveModelEntry({ catalog: CAT.filter((e) => !e.curated), globalDefaultId: 'm_gone' }) === null,
  ''
)
check('empty catalog -> null without throwing', resolveModelEntry({ catalog: [] }) === null, '')

/* ============================ 3. lookupCapability ============================ */
console.log('\n=== 3. lookupCapability: explicit > table > name hint > auto ===')

const yesEntry = entry({ modelId: 'acme-1', capabilities: { vision: 'yes' } })
const noEntry = entry({ modelId: 'gpt-4o', capabilities: { vision: 'no' } })
check(
  'explicit yes overrides table no',
  (() => { const r = capabilityOf(yesEntry, 'vision', () => 'no'); return r.state === 'yes' && r.resolved === true })(),
  JSON.stringify(capabilityOf(yesEntry, 'vision', () => 'no'))
)
check(
  'explicit no overrides table yes',
  (() => { const r = capabilityOf(noEntry, 'vision', () => 'yes'); return r.state === 'no' && r.resolved === true })(),
  JSON.stringify(capabilityOf(noEntry, 'vision', () => 'yes'))
)
check(
  'table hit marks resolved',
  (() => { const r = capabilityOf(entry({ modelId: 'acme-1' }), 'tools', () => 'no'); return r.state === 'no' && r.resolved === true })(),
  JSON.stringify(capabilityOf(entry({ modelId: 'acme-1' }), 'tools', () => 'no'))
)
check(
  'table returning auto is treated as no basis',
  (() => { const r = capabilityOf(entry({ modelId: 'acme-1' }), 'tools', () => 'auto'); return r.state === 'auto' && r.resolved === false })(),
  JSON.stringify(capabilityOf(entry({ modelId: 'acme-1' }), 'tools', () => 'auto'))
)
check(
  'name regex fallback when no table (qwen vl)',
  (() => { const r = capabilityOf(entry({ modelId: 'qwen2.5-vl-7b-instruct' }), 'vision'); return r.state === 'yes' && r.resolved === true })(),
  JSON.stringify(capabilityOf(entry({ modelId: 'qwen2.5-vl-7b-instruct' }), 'vision'))
)
check(
  'unknown model -> auto + unresolved',
  (() => { const r = capabilityOf(entry({ modelId: 'acme-unknown-9' }), 'tools'); return r.state === 'auto' && r.resolved === false })(),
  JSON.stringify(capabilityOf(entry({ modelId: 'acme-unknown-9' }), 'tools'))
)
check(
  'explicit auto does not short-circuit, table still consulted',
  (() => { const r = capabilityOf(entry({ modelId: 'acme-1', capabilities: { vision: 'auto' } }), 'vision', () => 'yes'); return r.state === 'yes' && r.resolved === true })(),
  ''
)
check(
  'unknown capability key -> auto + unresolved, no throw',
  (() => { const r = capabilityOf(entry(), 'notAKey'); return r.state === 'auto' && r.resolved === false })(),
  ''
)

// ---- 思考（reasoning）三态链：显式 -> 表 -> 名称正则 -> 未定（2026-11-21）----
const reasoningTable = (id, key) => (key === 'reasoning' ? tableLookup(id, key) : null)
check(
  'reasoning: explicit yes overrides table no',
  (() => { const r = capabilityOf(entry({ modelId: 'acme-x', capabilities: { reasoning: 'yes' } }), 'reasoning', () => 'no'); return r.state === 'yes' && r.resolved === true })(),
  JSON.stringify(capabilityOf(entry({ modelId: 'acme-x', capabilities: { reasoning: 'yes' } }), 'reasoning', () => 'no'))
)
check(
  'reasoning: explicit no overrides table yes',
  (() => { const r = capabilityOf(entry({ modelId: 'deepseek-v4.1-flash', capabilities: { reasoning: 'no' } }), 'reasoning', reasoningTable); return r.state === 'no' && r.resolved === true })(),
  JSON.stringify(capabilityOf(entry({ modelId: 'deepseek-v4.1-flash', capabilities: { reasoning: 'no' } }), 'reasoning', reasoningTable))
)
check(
  'reasoning: explicit auto + table hit (deepseek-v4.1-flash)',
  (() => { const r = capabilityOf(entry({ modelId: 'deepseek-v4.1-flash', capabilities: { reasoning: 'auto' } }), 'reasoning', reasoningTable); return r.state === 'yes' && r.resolved === true })(),
  JSON.stringify(capabilityOf(entry({ modelId: 'deepseek-v4.1-flash' }), 'reasoning', reasoningTable))
)
check(
  'reasoning: table hit for gemini-3 / gpt-5 / kimi-k2-thinking / o4-mini',
  ['gemini-3-pro', 'gpt-5.6-luna', 'kimi-k2-thinking', 'openai/o4-mini'].every((id) => tableLookup(id, 'reasoning') === 'yes'),
  ['gemini-3-pro', 'gpt-5.6-luna', 'kimi-k2-thinking', 'openai/o4-mini'].map((id) => `${id}=${tableLookup(id, 'reasoning')}`).join(',')
)
check(
  'reasoning: name regex fallback when table misses (qwen3 / deepthink)',
  (() => {
    const a = capabilityOf(entry({ modelId: 'qwen3-235b-a22b' }), 'reasoning')
    const b = capabilityOf(entry({ modelId: 'acme-deepthink-1' }), 'reasoning')
    return a.state === 'yes' && a.resolved === true && b.state === 'yes' && b.resolved === true
  })(),
  JSON.stringify([capabilityOf(entry({ modelId: 'qwen3-235b-a22b' }), 'reasoning'), capabilityOf(entry({ modelId: 'acme-deepthink-1' }), 'reasoning')])
)
check(
  'reasoning: undetermined model stays auto + unresolved (not selectable)',
  (() => { const r = capabilityOf(entry({ modelId: 'glm-5.3' }), 'reasoning', reasoningTable); return r.state === 'auto' && r.resolved === false })(),
  JSON.stringify(capabilityOf(entry({ modelId: 'glm-5.3' }), 'reasoning', reasoningTable))
)
check(
  'reasoning name hint mirrors llmProtocolPure.REASONING_MODEL_RE (no drift)',
  (() => {
    const proto = fs.readFileSync(path.join(ROOT, 'electron/lib/llmProtocolPure.ts'), 'utf8')
    const hit = /export const REASONING_MODEL_RE =\s*\/(.+?)\/i/.exec(proto)
    return !!hit && hit[1] === REASONING_NAME_RE.source
  })(),
  ''
)

/* ============================ 4. legacy spec ============================ */
console.log('\n=== 4. isLegacySpec / parseLegacySpec ===')

check(
  'isLegacySpec true for p:m / a:b:c / padded spec',
  isLegacySpec('p:m') && isLegacySpec('a:b:c') && isLegacySpec('  openrouter:anthropic/claude  '),
  ''
)
check(
  'isLegacySpec false for m_abc / empty / non-string / no colon',
  !isLegacySpec('m_abc') && !isLegacySpec('') && !isLegacySpec(null) && !isLegacySpec(42) && !isLegacySpec('gpt-4o'),
  ''
)
const abc = parseLegacySpec('a:b:c')
check(
  'parseLegacySpec splits at first colon',
  !!abc && abc.providerId === 'a' && abc.modelId === 'b:c',
  JSON.stringify(abc)
)
const padded = parseLegacySpec(' p : m ')
check(
  'parseLegacySpec trims both segments',
  !!padded && padded.providerId === 'p' && padded.modelId === 'm',
  JSON.stringify(padded)
)
check(
  'parseLegacySpec null for m_abc / p: / :m / empty',
  ['m_abc', 'p:', ':m', '', null].every((v) => parseLegacySpec(v) === null),
  ''
)

/* ============================ 5. findReferences ============================ */
console.log('\n=== 5. findReferences: slots + workspace + global ===')

const refCat = [
  entry({ id: 'm_a' }),
  entry({ id: 'm_b' }),
  entry({ id: 'm_c' }),
  entry({ id: 'm_d' }),
  entry({ id: 'm_gpt4o', providerId: 'openai', modelId: 'gpt-4o' }),
]
const refs = findReferences({
  catalog: refCat,
  slots: { assistantModelId: 'm_a', aiTranslateModelId: 'openai:gpt-4o' },
  workspaceEntry: { ws_1: { modelEntryId: 'm_b', curatedEntryIds: ['m_c', 'm_c'] } },
  defaultEntryId: 'm_d',
})
const wheres = refs.map((r) => r.where)
check(
  'finds references in slot / workspace default / workspace curated / global default',
  ['slot:assistantModelId', 'workspace:ws_1:default', 'workspace:ws_1:curated', 'global:default'].every((w) => wheres.includes(w)),
  JSON.stringify(wheres)
)
check(
  'dedupes same entryId + where (duplicated curated id appears once)',
  refs.filter((r) => r.where === 'workspace:ws_1:curated').length === 1,
  JSON.stringify(refs.filter((r) => r.where === 'workspace:ws_1:curated'))
)
check(
  'legacy providerId:modelId slot maps back to entry id',
  refs.some((r) => r.entryId === 'm_gpt4o' && r.where === 'slot:aiTranslateModelId'),
  JSON.stringify(refs)
)
check(
  'dangling id is not reported',
  !refs.some((r) => r.entryId === 'm_gone'),
  JSON.stringify(refs)
)
const refsMulti = findReferences({
  catalog: refCat,
  slots: { assistantModelId: 'm_a' },
  workspaceEntry: { ws_2: { modelEntryId: 'm_a' } },
  defaultEntryId: 'm_a',
})
check(
  'same entry referenced in three places -> three rows',
  refsMulti.filter((r) => r.entryId === 'm_a').length === 3,
  JSON.stringify(refsMulti)
)

/* ============================ 6. pickSlotCandidates ============================ */
console.log('\n=== 6. pickSlotCandidates: soft filter by capability ===')

const slotCat = [
  entry({ id: 'm_v_no', modelId: 'acme-v1', capabilities: { vision: 'no' } }),
  entry({ id: 'm_v_yes', modelId: 'acme-v2', capabilities: { vision: 'yes' } }),
  entry({ id: 'm_v_auto', modelId: 'acme-unknown-v3' }),
  entry({ id: 'm_img_no', modelId: 'acme-img', capabilities: { imageGeneration: 'no' } }),
  entry({ id: 'm_edit_no', modelId: 'acme-edit', capabilities: { imageEdit: 'no' } }),
]
const vis = pickSlotCandidates(slotCat, 'aiTeachVisionModel')
check(
  'vision slot blocks known-unsupported entries',
  vis.blocked.length === 1 && vis.blocked[0].entry.id === 'm_v_no',
  JSON.stringify(vis.blocked.map((b) => b.entry.id))
)
check(
  'blocked reason is Chinese and mentions vision',
  /[\u4e00-\u9fa5]/.test(vis.blocked[0].reason) && vis.blocked[0].reason.includes('\u89c6\u89c9'),
  'reason is not a Chinese vision message'
)
check(
  'auto/undetected entry stays usable',
  vis.usable.some((e) => e.id === 'm_v_auto') && vis.usable.some((e) => e.id === 'm_v_yes'),
  JSON.stringify(vis.usable.map((e) => e.id))
)
const img = pickSlotCandidates(slotCat, 'aiImageModel')
check(
  'image slot filters by imageGeneration',
  img.blocked.length === 1 && img.blocked[0].entry.id === 'm_img_no',
  JSON.stringify(img.blocked.map((b) => b.entry.id))
)
const edit = pickSlotCandidates(slotCat, 'aiImageEditModel')
check(
  'image edit slot filters by imageEdit',
  edit.blocked.length === 1 && edit.blocked[0].entry.id === 'm_edit_no',
  JSON.stringify(edit.blocked.map((b) => b.entry.id))
)
const chat = pickSlotCandidates(slotCat, 'defaultChatModel')
check(
  'non-capability slot does not filter (tools not involved)',
  chat.blocked.length === 0 && chat.usable.length === slotCat.length,
  JSON.stringify([chat.usable.length, chat.blocked.length])
)
const tableBlocked = pickSlotCandidates([entry({ id: 'm_t', modelId: 'acme-x' })], 'aiTeachVisionModel', () => 'no')
check(
  'table callback can also block a slot candidate',
  tableBlocked.blocked.length === 1 && tableBlocked.usable.length === 0,
  JSON.stringify([tableBlocked.usable.length, tableBlocked.blocked.length])
)

/* ============================ 7. entryLabel / dedupeBySpec ============================ */
console.log('\n=== 7. entryLabel / dedupeBySpec ===')

check('entryLabel prefers name', entryLabel(entry({ name: 'Fast DeepSeek' })) === 'Fast DeepSeek', entryLabel(entry({ name: 'Fast DeepSeek' })))
check(
  'entryLabel falls back to provider / model',
  entryLabel(entry({ name: '', providerId: 'openai', modelId: 'gpt-4o' })) === 'openai / gpt-4o',
  entryLabel(entry({ name: '', providerId: 'openai', modelId: 'gpt-4o' }))
)
check(
  'entryLabel falls back to modelId when provider empty',
  entryLabel(entry({ name: '', providerId: '', modelId: 'gpt-4o' })) === 'gpt-4o',
  entryLabel(entry({ name: '', providerId: '', modelId: 'gpt-4o' }))
)

const dupCat = [
  entry({ id: 'm_plain', providerId: 'p', modelId: 'same', curated: false, updatedAt: '2026-05-01' }),
  entry({ id: 'm_cur', providerId: 'p', modelId: 'same', curated: true, updatedAt: '2026-01-01' }),
  entry({ id: 'm_old', providerId: 'q', modelId: 'same', curated: false, updatedAt: '2026-01-01' }),
  entry({ id: 'm_new', providerId: 'q', modelId: 'same', curated: false, updatedAt: '2026-06-01' }),
]
const kept = dedupeBySpec(dupCat)
check(
  'dedupeBySpec keeps curated entry',
  kept.some((e) => e.id === 'm_cur') && !kept.some((e) => e.id === 'm_plain'),
  JSON.stringify(kept.map((e) => e.id))
)
check(
  'dedupeBySpec keeps latest updatedAt when both not curated',
  kept.some((e) => e.id === 'm_new') && !kept.some((e) => e.id === 'm_old'),
  JSON.stringify(kept.map((e) => e.id))
)
check(
  'dedupeBySpec does not mutate input and returns 2 entries',
  kept.length === 2 && dupCat.length === 4,
  JSON.stringify([kept.length, dupCat.length])
)

/* ============================ 8. capability table ============================ */
console.log('\n=== 8. capability table ===')

check(
  'CAPABILITY_TABLE_VERSION is a non-empty string',
  typeof CAPABILITY_TABLE_VERSION === 'string' && CAPABILITY_TABLE_VERSION.length > 0,
  ''
)
check(
  'table registers 12 to 24 patterns',
  CAPABILITY_PATTERNS.length >= 12 && CAPABILITY_PATTERNS.length <= 24,
  String(CAPABILITY_PATTERNS.length)
)
check('table vision hit: gpt-4o with provider prefix', tableLookup('openai/gpt-4o-mini', 'vision') === 'yes', String(tableLookup('openai/gpt-4o-mini', 'vision')))
check('table tools hit: gpt-4o', tableLookup('openai/gpt-4o-mini', 'tools') === 'yes', String(tableLookup('openai/gpt-4o-mini', 'tools')))
check(
  'table vision hit: Qwen2.5-VL (case and separators)',
  tableLookup('Qwen/Qwen2.5-VL-7B-Instruct', 'vision') === 'yes',
  String(tableLookup('Qwen/Qwen2.5-VL-7B-Instruct', 'vision'))
)
const reasonedPattern = CAPABILITY_PATTERNS.find((p) => p.pattern.includes('reasoner'))
check(
  'tools:no entry exists and documents its source',
  tableLookup('deepseek-reasoner', 'tools') === 'no' && !!reasonedPattern && !!reasonedPattern.note && reasonedPattern.note.includes('function calling'),
  String(tableLookup('deepseek-reasoner', 'tools'))
)
check(
  'gemini-embedding is not misclassified as vision (negative)',
  tableLookup('models/gemini-embedding-001', 'vision') === null,
  String(tableLookup('models/gemini-embedding-001', 'vision'))
)
check(
  'gpt-4o-tts/transcribe variants are not misclassified (negative)',
  tableLookup('gpt-4o-mini-tts', 'tools') === null && tableLookup('gpt-4o-transcribe', 'vision') === null,
  String(tableLookup('gpt-4o-mini-tts', 'tools'))
)
check(
  'unknown model returns null for fallback layers',
  tableLookup('acme-unknown-9', 'vision') === null && tableLookup('acme-unknown-9', 'tools') === null,
  ''
)
check(
  'lookupAll merges vision and tools',
  (() => { const all = lookupAll('gpt-4o'); return all.vision === 'yes' && all.tools === 'yes' })(),
  JSON.stringify(lookupAll('gpt-4o'))
)
check('lookupAll on empty model -> {}', Object.keys(lookupAll('')).length === 0, '')

// ---- 思考族登记（2026-11-21）：每个家族必须写明 note 来源 ----
check(
  'reasoning table: DeepSeek V3.2 / V4 registered',
  tableLookup('deepseek-v4.1-flash', 'reasoning') === 'yes' && tableLookup('deepseek-v3.2-exp', 'reasoning') === 'yes',
  String(tableLookup('deepseek-v4.1-flash', 'reasoning'))
)
check(
  'reasoning table: gemini-3 / gpt-5 / kimi-k2-thinking registered',
  tableLookup('gemini-3-pro', 'reasoning') === 'yes'
    && tableLookup('gpt-5.6-luna', 'reasoning') === 'yes'
    && tableLookup('kimi-k2-thinking', 'reasoning') === 'yes',
  ''
)
check(
  'reasoning table: o3 / o4-mini registered (with provider prefix and separators)',
  tableLookup('o3', 'reasoning') === 'yes'
    && tableLookup('openai/o3-mini', 'reasoning') === 'yes'
    && tableLookup('o4-mini', 'reasoning') === 'yes',
  String(tableLookup('openai/o3-mini', 'reasoning'))
)
check(
  'deepseek-r1 keeps tools:no and is explicitly reasoning:yes',
  (() => { const all = lookupAll('deepseek-reasoner'); return all.tools === 'no' && all.reasoning === 'yes' })(),
  JSON.stringify(lookupAll('deepseek-reasoner'))
)
check(
  'o1 negative tools entry stays before o3/o4 positives (no reasoning leak)',
  (() => { const all = lookupAll('o1-mini'); return all.tools === 'no' && all.reasoning === undefined })(),
  JSON.stringify(lookupAll('o1-mini'))
)
check(
  'reasoning table: uncertain models stay null (glm-5.3)',
  tableLookup('glm-5.3', 'reasoning') === null,
  String(tableLookup('glm-5.3', 'reasoning'))
)
check(
  'every reasoning pattern carries a note',
  CAPABILITY_PATTERNS.filter((p) => p.caps && p.caps.reasoning).every((p) => typeof p.note === 'string' && p.note.length > 0),
  ''
)

// ---------------------------------------------------------------- report
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* temp cleanup failure does not affect the verdict */
}
process.exit(failed.length === 0 ? 0 : 1)
