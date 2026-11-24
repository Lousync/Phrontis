#!/usr/bin/env node
/**
 * Contract test: AI teaching workspace (course) model binding pure functions
 *   src/modules/ai-teaching/workspaceModelPure.ts
 *
 * Plan: /home/lousync/Projects/DesginProcess/Phrontis/已实现设计文档/Phrontis-AI教学-技术方案-2026-11-19.md 2.9 / 4.3
 *       /home/lousync/Projects/DesginProcess/Phrontis/方案与调研/Phrontis-AI教学-内核重构与模型目录-2026-11-19.md 15.1
 *
 * Reads the real implementation (strip types, dynamic import), never modifies it.
 * Assertions:
 *   1. resolve order: conversation > workspace > global > workspace curated > global curated > none
 *   2. dangling binding id: skipped, staleBinding true, falls through, hint present
 *   3. pickerEntriesForWorkspace grouping / ordering
 *   4. toggleWorkspaceCurated add / remove / idempotent / input untouched
 *   5. normalizeWorkspaceBinding tolerance
 *   6. bindingPatch only changed fields, cleared -> null
 *   7. slotFallbackWarning missing-entry / incompatible / unrestricted slots ignored
 *   8. cross-file: SLOT_CAPABILITY in src/lib/modelCatalog.ts equals local copy
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-workspace-model.mjs [repoPath]
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

const REL = 'src/modules/ai-teaching/workspaceModelPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-model-'))
const tmpFile = path.join(tmpDir, 'workspaceModelPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const mod = await import(pathToFileURL(tmpFile).href)
const {
  resolveWorkspaceModel,
  pickerEntriesForWorkspace,
  toggleWorkspaceCurated,
  normalizeWorkspaceBinding,
  bindingPatch,
  slotFallbackWarning,
} = mod

/** Minimal but type-complete entry (runtime only needs id / name / capabilities / curated). */
const mk = (id, extra = {}) => ({
  id,
  name: extra.name ?? id,
  providerId: extra.providerId ?? 'prov',
  modelId: extra.modelId ?? id,
  reasoning: { supported: false, default: 'off' },
  capabilities: extra.capabilities ?? {},
  curated: extra.curated === true,
  source: 'user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})
const ids = (list) => (Array.isArray(list) ? list.map((x) => (x && typeof x === 'object' ? x.id : x)) : [])
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ---------------------------------------------------------------- 1. order */
console.log('\n=== 1. resolveWorkspaceModel: six-level order ===')

const E = {
  conv: mk('m_conv'),
  ws: mk('m_ws'),
  glob: mk('m_glob'),
  wsc1: mk('m_wsc1', { curated: true }),
  wsc2: mk('m_wsc2', { curated: true }),
  gc: mk('m_gc', { curated: true }),
  plain: mk('m_plain'),
}
const ALL = [E.conv, E.ws, E.glob, E.wsc1, E.wsc2, E.gc, E.plain]
const BOUND = { modelEntryId: 'm_ws', curatedEntryIds: ['m_wsc1'] }

const rConv = resolveWorkspaceModel({
  entries: ALL,
  binding: BOUND,
  globalDefaultId: 'm_glob',
  conversationOverrideId: 'm_conv',
})
check('conversation override wins', rConv.entry?.id === 'm_conv', JSON.stringify(rConv.entry?.id))
check('conversation override flagged viaConversation', rConv.viaConversation === true, String(rConv.viaConversation))

const rWs = resolveWorkspaceModel({ entries: ALL, binding: BOUND, globalDefaultId: 'm_glob' })
check('workspace default beats global default', rWs.entry?.id === 'm_ws' && rWs.source === 'workspace', `${rWs.entry?.id}/${rWs.source}`)

const rGlobal = resolveWorkspaceModel({ entries: ALL, binding: {}, globalDefaultId: 'm_glob' })
check('global default when workspace has none', rGlobal.entry?.id === 'm_glob' && rGlobal.source === 'global', `${rGlobal.entry?.id}/${rGlobal.source}`)

const rWsCurated = resolveWorkspaceModel({
  entries: ALL,
  binding: { curatedEntryIds: ['m_wsc2', 'm_wsc1'] },
})
check('workspace curated first (binding order)', rWsCurated.entry?.id === 'm_wsc2' && rWsCurated.source === 'curated', `${rWsCurated.entry?.id}/${rWsCurated.source}`)

const rGlobalCurated = resolveWorkspaceModel({
  entries: [E.plain, E.gc, mk('m_gc2', { curated: true })],
  binding: {},
})
check('global curated first (catalog order)', rGlobalCurated.entry?.id === 'm_gc' && rGlobalCurated.source === 'curated', `${rGlobalCurated.entry?.id}/${rGlobalCurated.source}`)

const rNone = resolveWorkspaceModel({ entries: [], binding: {} })
check('nothing available -> source none', rNone.source === 'none' && rNone.entry === undefined, `${rNone.source}/${String(rNone.entry)}`)
check('nothing available -> not stale, no hint', rNone.staleBinding === false && rNone.hint === undefined, `${rNone.staleBinding}/${String(rNone.hint)}`)

/* ---------------------------------------------------------------- 2. stale */
console.log('\n=== 2. dangling binding ids ===')

const rStaleDefault = resolveWorkspaceModel({
  entries: [E.glob, E.gc],
  binding: { modelEntryId: 'm_deleted' },
  globalDefaultId: 'm_glob',
})
check('deleted workspace default is skipped', rStaleDefault.entry?.id === 'm_glob', String(rStaleDefault.entry?.id))
check('deleted workspace default -> staleBinding true', rStaleDefault.staleBinding === true, String(rStaleDefault.staleBinding))
check('deleted workspace default -> hint present', typeof rStaleDefault.hint === 'string' && rStaleDefault.hint.length > 0, String(rStaleDefault.hint))
check('deleted workspace default falls back to global source', rStaleDefault.source === 'global', rStaleDefault.source)

const rStaleCurated = resolveWorkspaceModel({
  entries: [E.wsc1],
  binding: { curatedEntryIds: ['m_gone', 'm_wsc1'] },
})
check('deleted curated id skipped, next one used', rStaleCurated.entry?.id === 'm_wsc1' && rStaleCurated.staleBinding === true, `${rStaleCurated.entry?.id}/${rStaleCurated.staleBinding}`)

const rAllStale = resolveWorkspaceModel({ entries: [], binding: { modelEntryId: 'm_gone', curatedEntryIds: ['m_gone2'] } })
check('all stale and nothing else -> none + stale + hint', rAllStale.source === 'none' && rAllStale.staleBinding === true && !!rAllStale.hint, `${rAllStale.source}/${rAllStale.staleBinding}`)

const rConvStale = resolveWorkspaceModel({
  entries: [E.conv, E.glob],
  binding: { modelEntryId: 'm_gone' },
  globalDefaultId: 'm_glob',
  conversationOverrideId: 'm_conv',
})
check('stale binding still warns when conversation override wins', rConvStale.entry?.id === 'm_conv' && rConvStale.staleBinding === true && !!rConvStale.hint, `${rConvStale.entry?.id}/${rConvStale.staleBinding}`)

const rHealthy = resolveWorkspaceModel({ entries: [E.ws, E.wsc1], binding: BOUND, globalDefaultId: 'm_glob' })
check('healthy binding -> not stale, no hint', rHealthy.staleBinding === false && rHealthy.hint === undefined, `${rHealthy.staleBinding}/${String(rHealthy.hint)}`)
check('no binding at all -> not stale', resolveWorkspaceModel({ entries: ALL }).staleBinding === false, '')

/* ---------------------------------------------------------------- 3. picker */
console.log('\n=== 3. pickerEntriesForWorkspace ===')

const PICK = [
  mk('m_a', { name: 'Zeta', curated: true }),
  mk('m_b', { name: 'alpha', curated: false }),
  mk('m_c', { name: 'Alpha', curated: true }),
  mk('m_d', { name: 'Beta', curated: true }),
]
const picked = pickerEntriesForWorkspace({
  entries: PICK,
  binding: { curatedEntryIds: ['m_d', 'm_a', 'm_gone', 'm_d'] },
})
check('workspace keeps binding order and dedupes', sameJson(ids(picked.workspace), ['m_d', 'm_a']), JSON.stringify(ids(picked.workspace)))
check('global excludes workspace ids and non-curated', sameJson(ids(picked.global), ['m_c']), JSON.stringify(ids(picked.global)))
check('all sorted curated first then name', sameJson(ids(picked.all), ['m_c', 'm_d', 'm_a', 'm_b']), JSON.stringify(ids(picked.all)))
check('all contains every entry once', picked.all.length === PICK.length, String(picked.all.length))
const pickedEmpty = pickerEntriesForWorkspace({ entries: PICK, binding: { curatedEntryIds: ['m_gone'] } })
check('dangling curated ids yield empty workspace', pickedEmpty.workspace.length === 0, JSON.stringify(ids(pickedEmpty.workspace)))
check('no binding -> all curated entries are global', sameJson(ids(pickedEmpty.global), ['m_c', 'm_d', 'm_a']), JSON.stringify(ids(pickedEmpty.global)))

/* ---------------------------------------------------------------- 4. toggle */
console.log('\n=== 4. toggleWorkspaceCurated ===')

const toggleBase = Object.freeze({ modelEntryId: 'm_ws', curatedEntryIds: Object.freeze(['m_a']) })
const added = toggleWorkspaceCurated(toggleBase, 'm_b')
check('add appends to the end', sameJson(added.curatedEntryIds, ['m_a', 'm_b']), JSON.stringify(added.curatedEntryIds))
check('add keeps other fields', added.modelEntryId === 'm_ws', String(added.modelEntryId))
const removedAgain = toggleWorkspaceCurated(added, 'm_a')
check('remove drops the id, order kept', sameJson(removedAgain.curatedEntryIds, ['m_b']), JSON.stringify(removedAgain.curatedEntryIds))
const twice = toggleWorkspaceCurated(toggleWorkspaceCurated(toggleBase, 'm_b'), 'm_b')
check('double toggle returns to original state', sameJson(twice, toggleBase), JSON.stringify(twice))
check('input object not mutated', sameJson(toggleBase, { modelEntryId: 'm_ws', curatedEntryIds: ['m_a'] }), JSON.stringify(toggleBase))
const fromEmpty = toggleWorkspaceCurated({}, 'm_x')
check('empty binding + add -> only curatedEntryIds', sameJson(fromEmpty, { curatedEntryIds: ['m_x'] }), JSON.stringify(fromEmpty))
check('blank entry id is a no-op', sameJson(toggleWorkspaceCurated({ modelEntryId: 'm_ws' }, '  '), { modelEntryId: 'm_ws' }), '')

/* ---------------------------------------------------------------- 5. normalize */
console.log('\n=== 5. normalizeWorkspaceBinding ===')

for (const raw of [null, undefined, 42, 'm_gone', [], true]) {
  const out = normalizeWorkspaceBinding(raw)
  check(`non-object input -> empty object (${String(raw)})`, typeof out === 'object' && out !== null && Object.keys(out).length === 0, JSON.stringify(out))
}
const normRaw = { modelEntryId: 42, curatedEntryIds: ['m_a', 'm_a', 3, null, ' m_b ', ''] }
const normOut = normalizeWorkspaceBinding(normRaw)
check('drops non-string modelEntryId', !('modelEntryId' in normOut), JSON.stringify(normOut))
check('dedupes and trims curated ids, drops junk', sameJson(normOut.curatedEntryIds, ['m_a', 'm_b']), JSON.stringify(normOut.curatedEntryIds))
check('normalize does not mutate input', sameJson(normRaw.curatedEntryIds, ['m_a', 'm_a', 3, null, ' m_b ', '']), '')
check('trims a valid modelEntryId', normalizeWorkspaceBinding({ modelEntryId: '  m_a  ' }).modelEntryId === 'm_a', '')
check('explicit empty curated array is preserved', sameJson(normalizeWorkspaceBinding({ curatedEntryIds: [] }), { curatedEntryIds: [] }), '')
check('already normal binding is idempotent', sameJson(normalizeWorkspaceBinding(normalizeWorkspaceBinding({ curatedEntryIds: ['m_b', 'm_a'], modelEntryId: 'm_c' })), { modelEntryId: 'm_c', curatedEntryIds: ['m_b', 'm_a'] }), '')

/* ---------------------------------------------------------------- 6. patch */
console.log('\n=== 6. bindingPatch ===')

check('unchanged binding -> empty patch', Object.keys(bindingPatch({ modelEntryId: 'm_a', curatedEntryIds: ['m_b'] }, { modelEntryId: 'm_a', curatedEntryIds: ['m_b'] })).length === 0, '')
check('presets from empty -> both fields', sameJson(bindingPatch({ modelEntryId: 'm_a', curatedEntryIds: ['m_b'] }, {}), { modelEntryId: 'm_a', curatedEntryIds: ['m_b'] }), '')
const patchCurated = bindingPatch({ modelEntryId: 'm_a', curatedEntryIds: ['m_c'] }, { modelEntryId: 'm_a', curatedEntryIds: ['m_b'] })
check('only changed field appears', !('modelEntryId' in patchCurated) && sameJson(patchCurated.curatedEntryIds, ['m_c']), JSON.stringify(patchCurated))
const patchClearDefault = bindingPatch({}, { modelEntryId: 'm_a' })
check('cleared default -> null', patchClearDefault.modelEntryId === null && !('curatedEntryIds' in patchClearDefault), JSON.stringify(patchClearDefault))
const patchClearCurated = bindingPatch({ curatedEntryIds: [] }, { curatedEntryIds: ['m_a'] })
check('cleared curated (empty array) -> null', patchClearCurated.curatedEntryIds === null, JSON.stringify(patchClearCurated))
const patchDropCurated = bindingPatch({}, { curatedEntryIds: ['m_a'] })
check('dropped curated key -> null', patchDropCurated.curatedEntryIds === null, JSON.stringify(patchDropCurated))
const patchReorder = bindingPatch({ curatedEntryIds: ['m_b', 'm_a'] }, { curatedEntryIds: ['m_a', 'm_b'] })
check('reorder counts as a change', sameJson(patchReorder.curatedEntryIds, ['m_b', 'm_a']), JSON.stringify(patchReorder))
check('empty vs absent treated as equal', Object.keys(bindingPatch({}, { curatedEntryIds: [] })).length === 0, '')

/* ---------------------------------------------------------------- 7. slots */
console.log('\n=== 7. slotFallbackWarning ===')

const SLOT_ENTRIES = [
  mk('m_vision_blocked', { capabilities: { vision: 'no' } }),
  mk('m_auto_img', { capabilities: {} }),
  mk('m_ok_img', { capabilities: { imageGeneration: 'yes' } }),
  mk('m_ok_edit', { capabilities: { imageEdit: 'yes' } }),
  mk('m_conv_only', { capabilities: { tools: 'yes' } }),
  mk('m_legacy', { providerId: 'prov', modelId: 'legacy-model', capabilities: { imageGeneration: 'yes' } }),
]

const warnMissing = slotFallbackWarning({ entries: SLOT_ENTRIES, slots: { aiTeachVisionModel: 'm_gone' } })
check('unknown slot value -> missing-entry', warnMissing.length === 1 && warnMissing[0].reason === 'missing-entry' && warnMissing[0].slot === 'aiTeachVisionModel' && warnMissing[0].spec === 'm_gone', JSON.stringify(warnMissing))

const warnVisionNo = slotFallbackWarning({ entries: SLOT_ENTRIES, slots: { aiTeachVisionModel: 'm_vision_blocked' } })
check('explicit capability no -> incompatible', warnVisionNo.length === 1 && warnVisionNo[0].reason === 'incompatible', JSON.stringify(warnVisionNo))

const warnAutoImg = slotFallbackWarning({ entries: SLOT_ENTRIES, slots: { aiImageModel: 'm_auto_img' } })
check('auto image generation -> incompatible', warnAutoImg.length === 1 && warnAutoImg[0].reason === 'incompatible', JSON.stringify(warnAutoImg))

const warnVisionAuto = slotFallbackWarning({ entries: SLOT_ENTRIES, slots: { aiTeachVisionModel: 'm_conv_only' } })
check('auto vision is allowed (no warning)', warnVisionAuto.length === 0, JSON.stringify(warnVisionAuto))

const warnOkImg = slotFallbackWarning({ entries: SLOT_ENTRIES, slots: { aiImageModel: 'm_ok_img', aiImageEditModel: 'm_ok_edit' } })
check('explicit yes -> no warning', warnOkImg.length === 0, JSON.stringify(warnOkImg))

const warnLegacy = slotFallbackWarning({ entries: SLOT_ENTRIES, slots: { aiImageModel: 'prov:legacy-model' } })
check('legacy providerId:modelId resolves against catalog', warnLegacy.length === 0, JSON.stringify(warnLegacy))

const warnCodeSlot = slotFallbackWarning({ entries: SLOT_ENTRIES, slots: { defaultChatModel: 'm_gone', agentCompressModelId: 'nope:nope' } })
check('unrestricted code slots are ignored', warnCodeSlot.length === 0, JSON.stringify(warnCodeSlot))

const warnEmpty = slotFallbackWarning({ entries: SLOT_ENTRIES, slots: { aiTeachVisionModel: '   ' } })
check('blank slot value is ignored', warnEmpty.length === 0, JSON.stringify(warnEmpty))

const warnOrder = slotFallbackWarning({
  entries: SLOT_ENTRIES,
  slots: { aiImageEditModel: 'm_gone_edit', aiTeachVisionModel: 'm_gone_vision' },
})
check('warnings follow fixed slot order', sameJson(warnOrder.map((w) => w.slot), ['aiTeachVisionModel', 'aiImageEditModel']), JSON.stringify(warnOrder.map((w) => w.slot)))
check('empty slots -> no warnings', slotFallbackWarning({ entries: SLOT_ENTRIES, slots: {} }).length === 0, '')

/* ------------------------------------------------- 8. cross-file consistency */
console.log('\n=== 8. SLOT_CAPABILITY parity with src/lib/modelCatalog.ts ===')

function readSlotCapability(text) {
  const at = text.indexOf('const SLOT_CAPABILITY')
  if (at < 0) return null
  const open = text.indexOf('{', at)
  const close = text.indexOf('}', open)
  if (open < 0 || close < 0) return null
  const body = text.slice(open + 1, close)
  const map = {}
  const re = /([A-Za-z_$][\w$]*)\s*:\s*'([^']+)'/g
  let m
  while ((m = re.exec(body))) map[m[1]] = m[2]
  return map
}
const localMap = readSlotCapability(src)
const rendererMap = readSlotCapability(fs.readFileSync(path.join(ROOT, 'src/lib/modelCatalog.ts'), 'utf8'))
const sortPairs = (map) => Object.keys(map || {}).sort().map((k) => `${k}=${map[k]}`)

check('local SLOT_CAPABILITY parsed (3 slots)', !!localMap && Object.keys(localMap).length === 3, JSON.stringify(localMap))
check('renderer SLOT_CAPABILITY parsed (3 slots)', !!rendererMap && Object.keys(rendererMap).length === 3, JSON.stringify(rendererMap))
check('same slot keys as src/lib/modelCatalog.ts', sameJson(Object.keys(localMap || {}).sort(), Object.keys(rendererMap || {}).sort()), `${sortPairs(localMap)} vs ${sortPairs(rendererMap)}`)
check('same slot -> capability pairs as src/lib/modelCatalog.ts', sameJson(sortPairs(localMap), sortPairs(rendererMap)), `${sortPairs(localMap)} vs ${sortPairs(rendererMap)}`)

/* ---------------------------------------------------------------- report */
const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup failure does not affect result */ }
process.exit(failed.length === 0 ? 0 : 1)
