#!/usr/bin/env node
/**
 * CCswitch 导入契约：供应商类型判定（纯函数）。
 * 回归：claude 条目必须判为 anthropic（不再按 URL 误判成 openai-compatible → 404）。
 * 跑法：node .AGENT/scripts/ai-teaching/verify-ccswitch-import.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ccSwitchProviderType, inferTypeFromUrl } from '../../../electron/lib/ccSwitchPure.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const imp = readFileSync(join(ROOT, 'electron/lib/ccSwitchImport.ts'), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`) }
}

console.log('\n[类型判定] ccSwitchProviderType')
check('claude → anthropic（哪怕 URL 不含 anthropic，如 opencode/zen/go）', ccSwitchProviderType('claude', 'https://opencode.ai/zen/go') === 'anthropic')
check('claude-desktop → anthropic', ccSwitchProviderType('claude-desktop', 'https://any.example.com') === 'anthropic')
check('codex + /go/v1 → openai-compatible', ccSwitchProviderType('codex', 'https://opencode.ai/zen/go/v1') === 'openai-compatible')
check('codex + deepseek → openai-compatible', ccSwitchProviderType('codex', 'https://api.deepseek.com') === 'openai-compatible')
check('codex + localhost → ollama（保留原兜底）', ccSwitchProviderType('codex', 'http://localhost:8080') === 'ollama')
check('未知类型 + URL 含 anthropic → anthropic', ccSwitchProviderType('other', 'https://api.deepseek.com/anthropic') === 'anthropic')

console.log('\n[接线] ccSwitchImport.ts')
check('导入 ccSwitchProviderType', imp.includes("from './ccSwitchPure'"))
check('按 app_type 判定（不再用旧 inferType）', imp.includes('ccSwitchProviderType(appType, baseUrl)') && !imp.includes('function inferType('))

console.log(`\n断言: ${pass} PASS, ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
