/**
 * 契约验证：打包产物目录命名 + 目标平台解析（规范见仓库根 AGENTS.md「工作流」）。
 * 直接 import `scripts/pack.mjs` 的纯函数，真实执行（不复刻逻辑）。
 * 运行（项目根目录）：node .AGENT/scripts/pack/verify-pack-dir.mjs
 *
 * 2026-10-19（Linux 平台化阶段 2）新增 §2：目标平台解析。
 * 原先 `scripts/pack.mjs` 硬编码 `--win` —— 在 Linux 上跑 `npm run pack` 会去要 Windows 产物，
 * 而 electronDist 与 node-pty 的二进制都绑宿主平台 ⇒ 产物装上也起不来，且**不报错**。
 * 这一节把「按平台选目标 + 拒绝交叉打包」钉死。
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const { nextPackDirName, resolveTargetFlag, isCrossPack, nodeModulesIsSymlink } = await import(pathToFileURL(path.join(ROOT, 'scripts/pack.mjs')).href)

const checks = []
const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
const makeExists = (set) => (rel) => set.has(rel)

check('无冲突 → packs/<版本>', nextPackDirName('3.4.1', makeExists(new Set())) === 'packs/3.4.1', nextPackDirName('3.4.1', makeExists(new Set())))
check('基目录已存在 → 追加 -1', nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1']))) === 'packs/3.4.1-1', '')
check('基与 -1 都在 → -2', nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1', 'packs/3.4.1-1']))) === 'packs/3.4.1-2', '')
check('-1 空洞也跳过：基 + -1 + -2 在 → -3', nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1', 'packs/3.4.1-1', 'packs/3.4.1-2']))) === 'packs/3.4.1-3', '')
check('中间删过也不回填：基 + -1 + -2 + -5 在 → -6（2026-10-20 实测事故）',
  nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1', 'packs/3.4.1-1', 'packs/3.4.1-2', 'packs/3.4.1-5']))) === 'packs/3.4.1-6', '')
check('只有 -2（-1 空洞）→ -3，而不是回填 -1',
  nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1', 'packs/3.4.1-2']))) === 'packs/3.4.1-3', '')
check('只存在历史 -5（无基）→ 仍用基', nextPackDirName('3.4.1', makeExists(new Set(['packs/3.4.1-5']))) === 'packs/3.4.1', '')
check('别的版本不影响', nextPackDirName('3.4.2', makeExists(new Set(['packs/3.4.1', 'packs/3.4.1-1']))) === 'packs/3.4.2', '')
check('空版本兜底 0.0.0', nextPackDirName('', makeExists(new Set())) === 'packs/0.0.0', '')

// ---- §2 目标平台解析 ----
const win = resolveTargetFlag('win32', [])
check('win32 宿主默认 → --win', win.flag === '--win' && win.explicit === false, JSON.stringify(win))
const lin = resolveTargetFlag('linux', [])
check('linux 宿主默认 → --linux', lin.flag === '--linux' && lin.explicit === false, JSON.stringify(lin))
check('显式 --linux 覆盖（linux 宿主）', resolveTargetFlag('linux', ['--linux']).flag === '--linux', '')
check('显式 --win 覆盖（win32 宿主）', resolveTargetFlag('win32', ['--win', '--dir-only']).flag === '--win', '')
check('未知平台不猜目标（直接抛错，不静默产坏包）', (() => {
  try { resolveTargetFlag('darwin', []); return false } catch { return true }
})())
check('同时指定 --win 与 --linux 直接抛错', (() => {
  try { resolveTargetFlag('linux', ['--win', '--linux']); return false } catch { return true }
})())
check('交叉打包判定：linux 宿主 + --win 为交叉', isCrossPack('linux', '--win') === true)
check('交叉打包判定：同平台不算交叉', isCrossPack('linux', '--linux') === false && isCrossPack('win32', '--win') === false)

// ---- §3 node_modules 符号链接闸门（真跑：造一个 symlink 目录试） ----
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-pack-check-'))
const asLink = path.join(scratch, 'link')
const asReal = path.join(scratch, 'real')
fs.mkdirSync(asLink)
fs.mkdirSync(asReal)
fs.symlinkSync(asReal, path.join(asLink, 'node_modules'), 'dir')
fs.mkdirSync(path.join(asReal, 'node_modules'))
check('symlink 的 node_modules 能被识别（这是会让产物静默缺依赖的情形）',
  nodeModulesIsSymlink(asLink) === true, asLink)
check('真目录的 node_modules 不算 symlink（正常打包不过闸）',
  nodeModulesIsSymlink(asReal) === false, asReal)
check('没有 node_modules 时不当成 symlink（让 builder 自己报依赖没装）',
  nodeModulesIsSymlink(scratch) === false, scratch)
fs.rmSync(scratch, { recursive: true, force: true })

// ---- §4 静态：入口确实用了这两个闸门，且不再硬编码 --win ----
import { readFileSync } from 'node:fs'
const srcPack = readFileSync(path.join(ROOT, 'scripts/pack.mjs'), 'utf8')
check('入口调用 resolveTargetFlag', /const \{ flag, explicit \} = resolveTargetFlag\(process\.platform, argv\)/.test(srcPack))
check('入口调用 nodeModulesIsSymlink 闸门', /if \(nodeModulesIsSymlink\(repoRoot\)/.test(srcPack))
check('负向：不再出现裸 electron-builder --win 硬编码', !/electron-builder --win/.test(srcPack))
check('交叉打包有逃生门（KNOWBASE_ALLOW_CROSS_PACK）', /KNOWBASE_ALLOW_CROSS_PACK/.test(srcPack))
check('符号链接闸门有逃生门（KNOWBASE_ALLOW_SYMLINK_NODE_MODULES）', /KNOWBASE_ALLOW_SYMLINK_NODE_MODULES/.test(srcPack))

// ---- §5 本机自用安装（2026-10-20） ----
check('打包成功后调用本地安装钩子', /installLocalIfConfigured\(outRel\)/.test(srcPack))
check('钩子由 gitignored 的 scripts/local-install.json 开关', /local-install\.json/.test(srcPack))
const srcInstall = readFileSync(path.join(ROOT, 'scripts', 'install-local.mjs'), 'utf8')
check('本地安装复用 app.asar 闸门（坏包不覆盖现有安装）', /verifyPackedAsar/.test(srcInstall))
check('本地安装带 --no-sandbox（免 root 的明确取舍）', /--no-sandbox/.test(srcInstall))
check('本地安装写用户级 D-Bus 激活文件', /io\.github\.lousync\.Phrontis\.service/.test(srcInstall))
check('本地安装是原子替换（staging rename）', /renameSync\(staging, target\)/.test(srcInstall))
check('本地安装目标配置不进版本控制', /scripts\/local-install\.json/.test(readFileSync(path.join(ROOT, '.gitignore'), 'utf8')))

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  ${c.pass ? '[OK]' : '[FAIL]'} ${c.name}${c.detail && !c.pass ? '  -> ' + c.detail : ''}`)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 断言通过`)
process.exit(failed.length === 0 ? 0 : 1)
