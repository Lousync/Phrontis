#!/usr/bin/env node
/**
 * P0 总闸：把 AI 教学重构 P0 阶段的全部契约脚本跑一遍。
 *
 * 方案：`/home/lousync/桌面/Phrontis-AI教学-技术方案-2026-11-19.md` §9 / §10
 *
 * 用法（仓库根）：node .AGENT/scripts/ai-teaching/verify-all-p0.mjs [仓库路径]
 * 输出纯 ASCII（AGENTS.md：脚本禁用 emoji）；任一脚本失败即 exit 1。
 *
 * 说明：只跑「本批新增」的脚本，不去跑存量脚本 —— 存量脚本有自己的验收节奏，
 * 混在一起会让一次 P0 收尾变成全量回归，失败时定位成本过高。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const SCRIPTS = [
  'verify-source-ingest.mjs',
  'verify-artifact-naming.mjs',
  'verify-outline-v2.mjs',
  'verify-model-catalog.mjs',
  'verify-model-resolve.mjs',
  'verify-model-menu.mjs',
  'verify-workspace-model.mjs',
  'verify-model-catalog-ui.mjs',
  'verify-right-viewer-shell.mjs',
  'verify-web-pane-security.mjs',
  'verify-web-pane-renderer.mjs',
  'verify-notes-pane.mjs',
  'verify-books-pane.mjs',
  'verify-ask-pane.mjs',
  'verify-chat-model-menu.mjs',
  'verify-preflight-model.mjs',
  'verify-model-slot-migrate.mjs',
  'verify-teach-ledger.mjs',
  'verify-quiz-quality.mjs',
  'verify-context-compiler.mjs',
  'verify-viewer-tabs.mjs',
  'verify-side-scope.mjs',
]

const dir = path.join(ROOT, '.AGENT/scripts/ai-teaching')
const results = []

for (const name of SCRIPTS) {
  const abs = path.join(dir, name)
  if (!fs.existsSync(abs)) {
    results.push({ name, code: -1, note: 'MISSING' })
    console.log(`[SKIP] ${name}  (file not found)`)
    continue
  }
  const r = spawnSync(process.execPath, [abs, ROOT], { encoding: 'utf8' })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  // 每个脚本收尾都会打一行 `PASS -- N/M assertions passed`；抓住它做汇总，便于一眼看断言总数
  const summary = out.split('\n').reverse().find((l) => /^PASS\b/.test(l)) || ''
  const counts = /(\d+)\/(\d+)/.exec(summary)
  const note = counts ? `${counts[1]}/${counts[2]} assertions` : 'no summary line'
  results.push({ name, code: r.status ?? 1, note, pass: Number(counts?.[1] || 0), total: Number(counts?.[2] || 0) })
  console.log(`[${r.status === 0 ? 'OK' : 'FAIL'}] ${name}  ${note}`)
  if (r.status !== 0) {
    // 失败时把该脚本输出完整打出来，省一次重跑
    console.log('----- output -----')
    console.log(out.trim())
    console.log('------------------')
  }
}

const failed = results.filter((r) => r.code !== 0)
console.log('')
console.log(`SUMMARY: ${results.length - failed.length}/${results.length} scripts passed`)
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
console.log('PASS')
