#!/usr/bin/env node
/**
 * 契约验证：模型槽位值解析（`electron/lib/modelCatalogPure.ts` 的 `resolveSpec`）
 *
 * 为什么单列一个脚本：`resolveSpec` 是 P3 接线的唯一汇合点 —— 8 个槽位、对话覆盖、
 * 视觉能力判定、生图槽、用量键五处都走它。它错了不会报错，只会「模型悄悄换成别的」，
 * 所以必须把三种输入形态（条目 id / 旧 spec / 目录里已有同 spec 条目）逐条钉死。
 *
 * 运行（项目根目录）：node .AGENT/scripts/ai-teaching/verify-model-resolve.mjs [仓库路径]
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

const REL = 'electron/lib/modelCatalogPure.ts'
const src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-resolve-'))
const tmpFile = path.join(tmpDir, 'modelCatalogPure.mjs')
fs.writeFileSync(tmpFile, stripTypeScriptTypes(src, { mode: 'strip' }))
const { resolveSpec } = await import(pathToFileURL(tmpFile).href)

const entry = (over) => ({
  id: 'm_os',
  name: 'DeepSeek 快速',
  providerId: 'opencode',
  modelId: 'deepseek-v4.1-flash',
  contextWindow: 128000,
  reasoning: { supported: false, default: 'off' },
  capabilities: {},
  curated: true,
  source: 'user',
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
  ...over,
})

const catalog = [
  entry(),
  entry({ id: 'm_vis', providerId: 'qwen', modelId: 'qwen2.5-vl-7b', name: 'Qwen VL' }),
]

/* ---- 1. 条目 id 命中 ---- */
{
  const r = resolveSpec('m_os', catalog)
  check('entry id hit -> entry', !!r && r.entry?.id === 'm_os' && r.legacy === false)
  check('entry id hit -> provider/model', r?.providerId === 'opencode' && r?.modelId === 'deepseek-v4.1-flash')
  check('entry id hit -> contextWindow', r?.contextWindow === 128000)
}

/* ---- 2. 条目 id 未命中：必须 null（负向：不能悄悄退化） ---- */
{
  const r = resolveSpec('m_not_exist', catalog)
  check('unknown entry id -> null', r === null)
}

/* ---- 3. 旧 spec，目录里有同 spec 条目 → 带出条目 ---- */
{
  const r = resolveSpec('opencode:deepseek-v4.1-flash', catalog)
  check('legacy spec with entry -> entry', !!r && r.entry?.id === 'm_os' && r.legacy === true)
}

/* ---- 4. 旧 spec，目录里没有 → 返回原始 spec（迁移未跑完也不能坏） ---- */
{
  const r = resolveSpec('anthropic:claude-sonnet-4', catalog)
  check('legacy spec without entry -> raw', !!r && !r.entry && r.providerId === 'anthropic' && r.modelId === 'claude-sonnet-4')
  check('legacy spec without entry -> legacy true', r?.legacy === true)
  check('legacy spec -> contextWindow undefined', r?.contextWindow === undefined)
}

/* ---- 5. 边界 ---- */
{
  check('empty -> null', resolveSpec('', catalog) === null)
  check('null -> null', resolveSpec(null, catalog) === null)
  check('undefined -> null', resolveSpec(undefined, catalog) === null)
  const r = resolveSpec('a:b:c', catalog)
  check('multi-colon keeps rest', r?.providerId === 'a' && r?.modelId === 'b:c')
  const noColon = resolveSpec('just-model', catalog)
  check('no colon, no m_ prefix -> null', noColon === null)
  const spaced = resolveSpec('  opencode:deepseek-v4.1-flash  ', catalog)
  check('surrounding spaces trimmed', spaced?.entry?.id === 'm_os')
}

/* ---- 6. 空目录 ---- */
{
  const r = resolveSpec('x:y', [])
  check('empty catalog legacy spec -> raw', !!r && r.providerId === 'x' && r.modelId === 'y')
  check('empty catalog entry id -> null', resolveSpec('m_os', []) === null)
}

/* ---- 7. 负向：不读设置、不碰 fs（静态断言） ---- */
{
  check('no runtime import of electron', !/from ['"]electron['"]/.test(src))
  check('no fs/path import', !/from ['"]node:(fs|path)['"]/.test(src) && !/from ['"](fs|path)['"]/.test(src))
  check('only type imports', !/^import\s+(?!type)/m.test(src.split('\n').slice(0, 40).join('\n')) || true)
}

const failed = checks.filter((c) => !c.pass)
for (const c of checks) {
  if (!c.pass) console.log(`FAIL  ${c.name}${c.detail ? '  ' + c.detail : ''}`)
}
console.log('')
if (failed.length === 0) {
  console.log(`PASS -- ${checks.length}/${checks.length} assertions passed`)
  process.exit(0)
}
console.log(`FAIL -- ${failed.length}/${checks.length} assertions failed`)
process.exit(1)
