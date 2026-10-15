/**
 * 契约验证：打包产物目录命名（规范见仓库根 AGENTS.md「工作流」）。
 * 直接 import `scripts/pack.mjs` 的纯函数 `nextPackDirName`，真实执行（不复刻逻辑）。
 * 运行（项目根目录）：node .AGENT/scripts/pack/verify-pack-dir.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const { nextPackDirName } = await import(pathToFileURL(path.join(ROOT, 'scripts/pack.mjs')).href)

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const makeExists = (set) => (rel) => set.has(rel)

check('无冲突 → packs/<版本>', nextPackDirName('3.4.1', makeExists(new Set())) === 'packs/3.4.1', nextPackDirName('3.4.1', makeExists(new Set())))
check('基目录已存在 → 追加 -1', nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1']))) === 'packs/3.4.1-1', '')
check('基与 -1 都在 → -2', nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1', 'packs/3.4.1-1']))) === 'packs/3.4.1-2', '')
check('-1 空洞也跳过：基 + -1 + -2 在 → -3', nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1', 'packs/3.4.1-1', 'packs/3.4.1-2']))) === 'packs/3.4.1-3', '')
check('只存在历史 -5（无基）→ 仍用基', nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1-5']))) === 'packs/3.4.1', '')
check('别的版本不影响', nextPackDirName('3.4.2', makeExists(new Set(['packs/3.4.1', 'packs/3.4.1-1']))) === 'packs/3.4.2', '')
check('空版本兜底 0.0.0', nextPackDirName('', makeExists(new Set())) === 'packs/0.0.0', '')

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)
process.exit(failed.length === 0 ? 0 : 1)
