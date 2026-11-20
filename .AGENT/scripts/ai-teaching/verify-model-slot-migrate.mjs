#!/usr/bin/env node
/**
 * Contract check: settings > AI > model entries > "unify to entry id" (P3)
 *   src/modules/settings/views/modelCatalogUiPure.ts  (planSlotRewrite / rewriteSummary)
 *   src/modules/settings/views/ModelCatalogSection.tsx (wiring + no native dialogs)
 *
 * Assertions (real implementation, stripped + imported, source untouched):
 *   1. mixed scan: one legacy spec rewritten, one entry id kept, one empty, one unmatched;
 *   2. m_ id that no entry owns -> no-entry, never silently replaced;
 *   3. keys outside the allowed whitelist never appear (neither plan nor skipped);
 *   4. spec matching is case sensitive, no normalization of PID:MID;
 *   5. rewriteSummary: 0 / 1 / n;
 *   6. static wiring: setSettingRaw(, llmCatalogMigrate(, the button label, planSlotRewrite(
 *      are present and no alert( / confirm( / window.confirm( call is used.
 *
 * Run (repo root): node .AGENT/scripts/ai-teaching/verify-model-slot-migrate.mjs [repo path]
 * Output is ASCII only. Exit 0 = all pass, 1 = at least one failure.
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

const PURE_REL = 'src/modules/settings/views/modelCatalogUiPure.ts'
const SECTION_REL = 'src/modules/settings/views/ModelCatalogSection.tsx'
const pureSrc = fs.readFileSync(path.join(ROOT, PURE_REL), 'utf8')
const sectionSrc = fs.readFileSync(path.join(ROOT, SECTION_REL), 'utf8')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-slot-migrate-'))
const tmpFile = path.join(tmpDir, 'modelCatalogUiPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(pureSrc, { mode: 'strip' }))
const { planSlotRewrite, rewriteSummary, MODEL_SLOT_KEYS } = await import(pathToFileURL(tmpFile).href)

/** Slot label fixture (mirrors SLOT_LABEL; the label drift itself is guarded elsewhere) */
const LABELS = {
  defaultChatModel: 'chat default',
  assistantModelId: 'assistant',
  aiAssistantInlineSuggestModelId: 'inline',
  aiTranslateModelId: 'translate',
  agentCompressModelId: 'compress',
  aiTeachVisionModel: 'vision',
  aiImageModel: 'image gen',
  aiImageEditModel: 'image edit',
}

const entry = (over = {}) => ({ id: 'm_a', name: 'A', providerId: 'p1', modelId: 'mid', ...over })
const E_A = entry({ id: 'm_a', name: 'Entry A', providerId: 'p1', modelId: 'gpt-4o' })
const E_B = entry({ id: 'm_b', name: 'Entry B', providerId: 'p2', modelId: 'claude' })
const ENTRIES = [E_A, E_B]
const ALL = Object.keys(LABELS)

const scan = (slots, extra = {}) => planSlotRewrite({
  slots,
  entries: extra.entries ?? ENTRIES,
  slotLabels: LABELS,
  allowed: extra.allowed ?? ALL,
})

/* ------------------------------------------------------- 1. mixed scenario */
console.log('\n=== 1. planSlotRewrite: mixed scenario ===')
const mixed = scan({
  defaultChatModel: 'p1:gpt-4o',     // legacy spec -> rewrite
  assistantModelId: 'm_a',           // already an entry id
  aiTranslateModelId: '',            // empty
  agentCompressModelId: 'p9:ghost',  // legacy spec with no entry
})
check('exactly one slot is planned for rewrite', mixed.plan.length === 1, ascii(mixed.plan.map((p) => p.slot)))
check('planned slot is the legacy spec slot', mixed.plan[0]?.slot === 'defaultChatModel', ascii(mixed.plan[0]?.slot))
check('plan.to is exactly the same-spec entry', mixed.plan[0]?.to === 'm_a', ascii(mixed.plan[0]?.to))
check('plan.from keeps the raw legacy spec', mixed.plan[0]?.from === 'p1:gpt-4o', ascii(mixed.plan[0]?.from))
check('plan.entryName is the entry display name', mixed.plan[0]?.entryName === 'Entry A', ascii(mixed.plan[0]?.entryName))
check('plan.slotLabel comes from slotLabels', mixed.plan[0]?.slotLabel === 'chat default', ascii(mixed.plan[0]?.slotLabel))

const skipOf = (r, slot) => r.skipped.find((s) => s.slot === slot)
check('entry id is reported as already-entry', skipOf(mixed, 'assistantModelId')?.reason === 'already-entry', ascii(skipOf(mixed, 'assistantModelId')))
check('already-entry keeps its value in from', skipOf(mixed, 'assistantModelId')?.from === 'm_a', ascii(skipOf(mixed, 'assistantModelId')))
check('empty value is reported as empty', skipOf(mixed, 'aiTranslateModelId')?.reason === 'empty', ascii(skipOf(mixed, 'aiTranslateModelId')))
check('unmatched legacy spec is reported as no-entry', skipOf(mixed, 'agentCompressModelId')?.reason === 'no-entry', ascii(skipOf(mixed, 'agentCompressModelId')))
check('unmatched legacy spec keeps its raw from', skipOf(mixed, 'agentCompressModelId')?.from === 'p9:ghost', ascii(skipOf(mixed, 'agentCompressModelId')))
check('unmatched legacy spec never enters the plan', mixed.plan.every((p) => p.slot !== 'agentCompressModelId'), ascii(mixed.plan.map((p) => p.slot)))
check('slots that were not provided count as empty', skipOf(mixed, 'aiImageModel')?.reason === 'empty', ascii(skipOf(mixed, 'aiImageModel')))

/* ------------------------------------------------------- 2. unknown m_ id */
console.log('\n=== 2. m_ id without a matching entry ===')
const ghost = scan({ defaultChatModel: 'm_ghost' })
check('unknown m_ id -> no-entry', skipOf(ghost, 'defaultChatModel')?.reason === 'no-entry', ascii(skipOf(ghost, 'defaultChatModel')))
check('unknown m_ id is not rewritten to some other entry', ghost.plan.length === 0, ascii(ghost.plan))
const ghost2 = scan({ assistantModelId: 'm_ghost', entries: ENTRIES })
check('unknown m_ id is not swapped for the first catalog entry (negative)', ghost2.plan.every((p) => p.to !== 'm_a'), ascii(ghost2.plan))

/* ------------------------------------------------------- 3. whitelist */
console.log('\n=== 3. allowed whitelist ===')
const narrow = scan(
  { defaultChatModel: 'p1:gpt-4o', outsider: 'p1:gpt-4o', aiTranslateModelId: 'm_a' },
  { allowed: ['defaultChatModel'] },
)
check('key outside allowed is not planned', narrow.plan.length === 1 && narrow.plan[0].slot === 'defaultChatModel', ascii(narrow.plan.map((p) => p.slot)))
check('key outside allowed does not pollute skipped', narrow.skipped.every((s) => s.slot !== 'outsider'), ascii(narrow.skipped.map((s) => s.slot)))
check('only allowed keys are reported at all', narrow.skipped.length === 0, ascii(narrow.skipped.map((s) => s.slot)))

/* ------------------------------------------------------- 4. case sensitivity */
console.log('\n=== 4. case-sensitive spec matching ===')
const upperPid = scan({ defaultChatModel: 'P1:gpt-4o' })
check('upper-case providerId does not match', upperPid.plan.length === 0, ascii(upperPid.plan))
check('upper-case providerId lands in no-entry', skipOf(upperPid, 'defaultChatModel')?.reason === 'no-entry', ascii(skipOf(upperPid, 'defaultChatModel')))
const upperMid = scan({ defaultChatModel: 'p1:GPT-4O' })
check('upper-case modelId does not match', upperMid.plan.length === 0, ascii(upperMid.plan))
const upperWhole = scan({ defaultChatModel: 'P1:GPT-4O' })
check('fully upper-cased spec does not match', upperWhole.plan.length === 0 && skipOf(upperWhole, 'defaultChatModel')?.reason === 'no-entry', ascii(skipOf(upperWhole, 'defaultChatModel')))
const malformed = scan({ defaultChatModel: 'p1:', aiTranslateModelId: ':mid' })
check('spec with an empty side is no-entry', malformed.plan.length === 0, ascii(malformed.plan))

/* ------------------------------------------------------- 5. summary text */
console.log('\n=== 5. rewriteSummary ===')
check('zero plan says nothing to rewrite', rewriteSummary([]) === '没有需要改写的槽位', ascii(rewriteSummary([])))
check('single item summary', rewriteSummary([{ slot: 'a', slotLabel: 'A', from: 'p:1', to: 'm_a', entryName: 'A' }]) === '改写 1 个槽位', ascii(rewriteSummary([{ slot: 'a', slotLabel: 'A', from: 'p:1', to: 'm_a', entryName: 'A' }])))
const three = [1, 2, 3].map((i) => ({ slot: 's' + i, slotLabel: 'S' + i, from: 'p:' + i, to: 'm_' + i, entryName: 'E' + i }))
check('multi item summary carries the count', rewriteSummary(three) === '改写 3 个槽位', ascii(rewriteSummary(three)))
check('summary follows the real plan length', rewriteSummary(mixed.plan) === '改写 1 个槽位', ascii(rewriteSummary(mixed.plan)))

/* ------------------------------------------------------- 6. slot key list */
console.log('\n=== 6. MODEL_SLOT_KEYS ===')
check('slot list has the 8 scene slots', Array.isArray(MODEL_SLOT_KEYS) && MODEL_SLOT_KEYS.length === 8, ascii(MODEL_SLOT_KEYS))
check('slot list has no duplicates', new Set(MODEL_SLOT_KEYS).size === MODEL_SLOT_KEYS.length, ascii(MODEL_SLOT_KEYS))
check('slot list covers every label fixture key', ALL.every((k) => MODEL_SLOT_KEYS.includes(k)), ascii(ALL.filter((k) => !MODEL_SLOT_KEYS.includes(k))))

/* ------------------------------------------------------- 7. static wiring */
console.log('\n=== 7. static wiring in ModelCatalogSection.tsx ===')
check('section writes settings through setSettingRaw(', sectionSrc.includes('setSettingRaw('), '')
check('section calls the idempotent legacy import llmCatalogMigrate(', sectionSrc.includes('llmCatalogMigrate('), '')
check('section exposes the entry point label', sectionSrc.includes('统一为条目 id'), '')
check('section builds the plan with planSlotRewrite(', sectionSrc.includes('planSlotRewrite('), '')
check('section renders the confirm button through rewriteSummary(', sectionSrc.includes('rewriteSummary('), '')
check('no alert( call in the section', !/\balert\s*\(/.test(sectionSrc), '')
check('no confirm( call in the section', !/(^|[^.\w])confirm\s*\(/.test(sectionSrc), '')
check('no window.confirm call in the section', !/\bwindow\s*\.\s*confirm\s*\(/.test(sectionSrc), '')
check('no alert( call in the pure module', !/\balert\s*\(/.test(pureSrc), '')

/* ------------------------------------------------------- report */
const failed = checks.filter((c) => !c.pass)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} assertions passed`)

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* temp cleanup is best-effort */ }
process.exit(failed.length === 0 ? 0 : 1)
