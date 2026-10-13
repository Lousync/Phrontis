#!/usr/bin/env node
/**
 * 契约验证：「可执行目录的完整性标签」—— 专验那类**错了也不报错、只让程序静默起不来**的机器状态。
 *
 * 为什么需要它（2026-10-13 真事）：
 * 为让受限（低完整性）会话能写仓库子目录，2026-10-12 22:46 对整棵树跑过
 * `icacls <主仓> /setintegritylevel (OI)(CI)L /T`（96,806 个文件，含 node_modules 与 packs）。
 * Windows 会把**镜像文件**的完整性级别带给新进程 ⇒ 从这两棵树启动的程序一律以低完整性运行：
 *   ① dev：node_modules\@esbuild\win32-x64\esbuild.exe 删不掉 %TEMP% 里由中等进程建的
 *      esbuild 临时文件 ⇒ `[vite:esbuild-transpile] remove …: Access is denied.` ⇒
 *      scripts/start-desktop.bat 窗口一闪而过（清 %TEMP% 残留无效：残留只是尸体）；
 *   ② 免安装：packs\<版本>\win-unpacked\Phrontis.exe 写不进 %APPDATA%\knowbase ⇒
 *      死在 Chromium 落盘之前（判据：userData 零写入 + crash-log.txt 无新增）。
 * 两者都不留任何安全日志（Defender 操作日志 / 通知库 / WER 全静默），
 * 极易被误判成「被 Windows 安全拦了」。本脚本就是那条「一眼看出是不是标签问题」的判据。
 * 机制、判据、修法与代价见 CLAUDE.local.md「沙箱环境手法」最后一条。
 *
 * 验什么：
 *   §1 放可执行文件的根目录本身（node_modules / packs / dist*）—— 目录带低标签即回归；
 *   §2 关键可执行文件（electron.exe / esbuild.exe / packs 里的 Phrontis.exe）；
 *   §3 抽样：这些目录里扫到的其它可执行文件（含 .dll / .node）。
 *
 * 注意两件事：
 *   - 只判「含可执行文件的目录」：`dist/`、`out/` 这类纯 JS 产物目录会被自动跳过
 *     （中等进程写低标签对象是允许的，标签只影响会被当作进程镜像启动的文件）。
 *   - 调 icacls 的输出走**临时文件重定向，不走管道**：受限（沙箱）会话里 Node 捕获子进程管道
 *     会被拒（`spawnSync icacls EPERM`），走文件才能在受限会话里也拿到真判据。
 *
 * 运行（项目根目录）：
 *   node .AGENT/scripts/acl-integrity-guard/verify-integrity-labels.mjs
 *   node .AGENT/scripts/acl-integrity-guard/verify-integrity-labels.mjs --root tmp/某目录   # 只查指定目录
 *
 * 退出码：0 = 已核对且正常；1 = 发现低标签（附修复命令）；2 = 有对象读不到、未核对（**不算通过**）。
 * 非 Windows 平台直接 0（本判据只对 Windows 有意义）。
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')

const DEFAULT_ROOTS = ['node_modules', 'packs', 'dist-electron']
const EXEC_EXTS = new Set(['.exe', '.com', '.scr', '.dll', '.node'])
const MAX_WALK_ENTRIES = 4000
const MAX_SAMPLE = 12

const failures = []
const warnings = []
const failedRoots = new Set()
let verified = 0
let unverified = 0

const ok = (m) => console.log(`[OK]   ${m}`)
const warn = (m) => { warnings.push(m); console.log(`[WARN] ${m}`) }
const fail = (m, root) => {
  failures.push(m)
  if (root) failedRoots.add(root)
  console.log(`[FAIL] ${m}`)
}

const WORK = mkdtempSync(join(tmpdir(), 'acl-integrity-guard-'))
const OUT_FILE = join(WORK, 'icacls.out')

function cleanup() {
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    /* 清不掉就算了，不掩盖退出码 */
  }
}

/**
 * 读一个对象（文件或目录）的强制性完整性标签。
 * 子进程 stdout/stderr 重定向到文件，避免受限会话里的管道 EPERM。
 */
function readLabel(target) {
  let fd
  try {
    fd = openSync(OUT_FILE, 'w')
    const res = spawnSync('icacls', [target], { stdio: ['ignore', fd, fd], windowsHide: true })
    if (res.error) return { kind: 'unknown', why: String(res.error.message || res.error).split(/\r?\n/)[0] }
  } catch (err) {
    return { kind: 'unknown', why: String(err.message || err).split(/\r?\n/)[0] }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
  let out
  try {
    out = readFileSync(OUT_FILE, 'utf8')
  } catch {
    return { kind: 'unknown', why: '读不到 icacls 的输出文件' }
  }
  if (!out.trim()) return { kind: 'unknown', why: 'icacls 没有输出' }
  if (/Low Mandatory|低强制|S-1-16-4096/i.test(out)) return { kind: 'low' }
  if (/Mandatory Label|强制标签/i.test(out)) return { kind: 'medium' }
  return { kind: 'medium' } // 没有标签 ACE = 默认中等
}

/** 有界宽度优先遍历：找可执行文件，顺带避开 junction/symlink 成环。 */
function collectExecutables(rootDir) {
  const found = []
  const queue = [rootDir]
  let head = 0
  let visited = 0
  while (head < queue.length && visited < MAX_WALK_ENTRIES) {
    const cur = queue[head++]
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (visited++ >= MAX_WALK_ENTRIES) break
      if (entry.isSymbolicLink()) continue
      const full = join(cur, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (EXEC_EXTS.has(extname(entry.name).toLowerCase())) found.push(full)
    }
  }
  return found
}

/** 出过事的几个位置：直接点名的关键文件，外加各版本产物的主程序。 */
function criticalFiles() {
  const list = [
    join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    join(ROOT, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
  ]
  for (const base of ['packs', 'dist-electron']) {
    const baseDir = join(ROOT, base)
    if (!existsSync(baseDir)) continue
    const direct = join(baseDir, 'win-unpacked', 'Phrontis.exe')
    if (existsSync(direct)) list.push(direct)
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const p = join(baseDir, entry.name, 'win-unpacked', 'Phrontis.exe')
      if (existsSync(p)) list.push(p)
    }
  }
  return list
}

// ---------------- 入口 ----------------
const argv = process.argv.slice(2)
const explicitRoots = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) explicitRoots.push(resolve(ROOT, argv[++i]))
}

if (process.platform !== 'win32') {
  ok('非 Windows 平台，本判据不适用')
  console.log('\nPASS')
  process.exit(0)
}

/** 判定一个对象的标签，并累计「已核对 / 未核对」。 */
function judge(target, root, kindLabel) {
  const label = readLabel(target)
  const shown = relative(ROOT, target) || target
  if (label.kind === 'low') {
    fail(`${kindLabel}带低信任标签：${shown}`, root)
    return
  }
  if (label.kind === 'unknown') {
    unverified++
    warn(`读不到${kindLabel}标签：${shown}（${label.why}）`)
    return
  }
  verified++
}

let roots
if (explicitRoots.length) {
  roots = explicitRoots.filter((p) => existsSync(p))
  if (!roots.length) fail('--root 给的路径都不存在')
} else {
  roots = DEFAULT_ROOTS.map((d) => join(ROOT, d))
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && /^dist/.test(entry.name)) roots.push(join(ROOT, entry.name))
  }
  roots = [...new Set(roots)].filter((p) => existsSync(p))
}

console.log(`[INFO] 仓库根：${ROOT}`)
console.log(`[INFO] 检查 ${roots.length} 个「放可执行文件」的根目录：${roots.map((p) => relative(ROOT, p) || p).join(' / ')}`)
console.log('')

const critical = criticalFiles()

for (const root of roots) {
  const relRoot = relative(ROOT, root) || root

  const probes = new Set()
  for (const c of critical) if (c === root || c.startsWith(root + sep)) probes.add(c)
  for (const f of collectExecutables(root)) {
    if (probes.size >= MAX_SAMPLE) break
    probes.add(f)
  }

  // 纯 JS 产物目录（dist/、out/）带低标签无害：只有「会被当作进程镜像启动的文件」才受标签影响，
  // 而中等进程写低标签对象本来就是允许的。没有可执行文件就不判目录标签，免得误报。
  if (probes.size === 0) {
    console.log(`[SKIP] ${relRoot}：没有可执行文件（纯 JS 产物，标签不影响程序启动）`)
    continue
  }

  const dirLabel = readLabel(root)
  if (dirLabel.kind === 'low') {
    fail(`目录带低信任标签：${relRoot} —— 从该目录启动的程序会以低信任身份运行`, root)
  } else if (dirLabel.kind === 'unknown') {
    unverified++
    warn(`读不到目录标签：${relRoot}（${dirLabel.why}）`)
  } else {
    verified++
    ok(`目录标签正常（中等）：${relRoot}`)
  }

  const before = failures.length
  const beforeVerified = verified
  let probeUnknown = 0
  for (const p of probes) {
    const beforeUnverified = unverified
    judge(p, root, '可执行文件')
    if (unverified > beforeUnverified) probeUnknown++
  }
  const checked = verified - beforeVerified
  if (failures.length === before && checked > 0) {
    ok(`${relRoot}：核对 ${checked} 个可执行文件，标签均正常${probeUnknown ? `（另有 ${probeUnknown} 个读不到）` : ''}`)
  }
}

cleanup()
console.log('')

if (failures.length) {
  console.log(`FAIL —— ${failures.length} 处异常。修复（需**管理员** PowerShell：relabel-up 要 SeRelabelPrivilege，`)
  console.log('普通或低完整性会话一律报 Access is denied）：')
  for (const root of failedRoots) {
    console.log(`  icacls '${root}' /setintegritylevel '(OI)(CI)M' /T /C /Q`)
  }
  console.log('回退：把上面的 M 换回 L 重跑。机制、判据与代价见 CLAUDE.local.md「沙箱环境手法」最后一条。')
  process.exit(1)
}

if (unverified > 0) {
  console.log(`UNVERIFIED —— 有 ${unverified} 个对象读不到标签，本次**不算通过**。`)
  console.log('请在普通（非沙箱/非受限）终端重跑本脚本，再据结果判断。')
  process.exit(2)
}

console.log(`PASS —— 可执行目录的完整性标签正常（核对 ${verified} 个对象，${roots.length} 个根目录，${warnings.length} 条提示）`)
process.exit(0)
