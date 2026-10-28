#!/usr/bin/env node
/**
 * 打包输出规范（2026-10-08 用户拍板，规范正文见仓库根 AGENTS.md「工作流」）：
 *   - 产物目录统一落仓库根 `packs/`；
 *   - 目录名 = 当前 package.json 版本号（如 `packs/3.4.1`）；
 *   - 若该目录已存在（版本号没抬就重复打包），追加 `-1` / `-2` … 直到不冲突（如 `packs/3.4.1-1`）。
 *
 * 用法（经 npm scripts 调用，node_modules/.bin 已在 PATH 上）：
 *   npm run pack                 → electron-vite build && electron-builder（按当前平台选目标）
 *   npm run pack -- --linux      → 显式指定目标（Linux：deb）
 *   npm run pack -- --win        → 显式指定目标（Windows：nsis）
 *   npm run pack:dir             → 同上，但只出解包目录（--dir，不打安装包）
 *
 * ---- 平台化（2026-10-19 · v3.9.2）----
 * 原先这里硬编码 `--win`：在 Linux 上跑 `npm run pack` 会去要 Windows 产物，而 electron-builder 的
 * `electronDist`（`node_modules/electron/dist`）与 `@lydell/node-pty` 的预编译二进制**都绑宿主平台**，
 * 于是产物是个「看着像安装包、装上也起不来」的东西 —— 静默错，最难查。
 * 现在目标按 `process.platform` 选（win32 → --win，linux → --linux），可用 `--win` / `--linux` 显式覆盖。
 *
 * ★ 交叉打包仍然**不支持**（已拍板：Linux 包必须 Linux 打、Windows 包必须 Windows 打）：
 *   显式指定的目标与宿主平台不一致时直接中止，而不是产出一个坏包。
 *   确有需要（例如只想看 electron-builder 的配置解析）可置 `KNOWBASE_ALLOW_CROSS_PACK=1` 放行。
 */
import { existsSync, lstatSync, realpathSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const requireFromHere = createRequire(import.meta.url)

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 纯函数：给定「已存在判定器」，算出本次可用的产物目录（相对仓库根的 POSIX 路径）。
 *
 * 2026-10-20 修：原先取「第一个空位」，删掉中间某份产物（如坏包 `-4`）后会被**重新占用**，
 * 于是 `packs/<v>-5` 反而比新产物旧 —— 发布脚本「取后缀最大者」会误发旧包。
 * 现在恒取 `max(已存在后缀) + 1`，后缀单调递增、永不回填。
 * @param {string} version 版本号（如 '3.4.1'）
 * @param {(relPath: string) => boolean} exists 相对仓库根是否存在
 */
export function nextPackDirName(version, exists) {
  const v = String(version ?? '').trim() || '0.0.0'
  const base = `packs/${v}`
  if (!exists(base)) return base
  let max = 0
  for (let i = 1; i < 1000; i++) {
    if (exists(`${base}-${i}`)) max = i
  }
  if (max >= 999) throw new Error('打包目录后缀超过上限（999）——请清理 packs/ 后重试')
  return `${base}-${max + 1}`
}

/** 平台 → electron-builder 目标开关（唯一真相源；契约脚本直接 import 本函数真跑） */
const PLATFORM_FLAG = { win32: '--win', linux: '--linux' }

/**
 * 纯函数：解析本次要打的平台目标。
 * @param {string} platform process.platform
 * @param {readonly string[]} argv 命令行参数（只看 `--win` / `--linux`）
 * @returns {{ flag: string, explicit: boolean }}
 * @throws 宿主平台没有登记目标、或显式指定了多个互相矛盾的目标
 */
export function resolveTargetFlag(platform, argv) {
  const explicitFlags = argv.filter((a) => a === '--win' || a === '--linux')
  if (explicitFlags.length > 1) {
    throw new Error(`不能同时指定 ${explicitFlags.join(' 与 ')} —— 一次只打一个平台`)
  }
  if (explicitFlags.length === 1) return { flag: explicitFlags[0], explicit: true }
  const flag = PLATFORM_FLAG[platform]
  if (!flag) {
    throw new Error(`当前平台 ${platform} 没有登记打包目标（只支持 win32 / linux）—— 请显式传 --win 或 --linux`)
  }
  return { flag, explicit: false }
}

/** 显式目标与宿主平台不一致 = 交叉打包（产物必然不可用，见文件头） */
export function isCrossPack(platform, flag) {
  return PLATFORM_FLAG[platform] !== flag
}

/**
 * 纯函数：`node_modules` 是否为**符号链接**（worktree 常见做法：指向主仓的安装）。
 *
 * 为什么要挡它（2026-10-19 实测）：electron-builder 的依赖收集器靠 `npm list` 驱动，
 * node_modules 是 symlink 时 npm 会把大量传递依赖判成 `extraneous`，收集器随即报一百多条
 * `cannot find path for dependency` 并把它们**跳过** —— 包照样打得出来、体积也像模像样，
 * 但 app.asar 里只有直接依赖（实测 51 个顶层包 / 缺 safer-buffer 等），装上启动即崩：
 * `Cannot find module 'safer-buffer'`。典型的「静默产出坏产物」，所以默认直接中止。
 *
 * 对照实测（同一份代码、同一个版本号）：symlink → 100+ 条 PKG_NOT_FOUND、asar 51 个顶层包；
 * 真目录（或硬链接目录）→ 0 条、asar 2853 个顶层包、装上去能启动。
 */
export function nodeModulesIsSymlink(repoRoot) {
  try {
    return lstatSync(join(repoRoot, 'node_modules')).isSymbolicLink()
  } catch {
    return false // 不存在（依赖没装）→ 交给 electron-builder 自己报错，别在这里抢话
  }
}

function isDirectRun() {
  try {
    return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

function run(command) {
  const r = spawnSync(command, { cwd: repoRoot, stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function main() {
  const argv = process.argv.slice(2)
  const dirOnly = argv.includes('--dir-only')
  const { flag, explicit } = resolveTargetFlag(process.platform, argv)
  if (isCrossPack(process.platform, flag) && process.env.KNOWBASE_ALLOW_CROSS_PACK !== '1') {
    console.error(
      `[pack] 中止：宿主平台 ${process.platform} 上不能打 ${flag} 包（交叉打包不受支持）。\n` +
      '      原因：build.electronDist 与 @lydell/node-pty 的预编译二进制都绑宿主平台，产物装上也起不来。\n' +
      '      Windows 包请在 Windows 上打，Linux 包请在 Linux 上打；确需放行请置 KNOWBASE_ALLOW_CROSS_PACK=1。',
    )
    process.exit(2)
  }
  if (nodeModulesIsSymlink(repoRoot) && process.env.KNOWBASE_ALLOW_SYMLINK_NODE_MODULES !== '1') {
    console.error(
      '[pack] 中止：node_modules 是指向别处的符号链接，打出来的包会**静默缺依赖**。\n' +
      '      原因：electron-builder 的依赖收集器靠 npm list 驱动，symlink 会让大量传递依赖被判成\n' +
      '      extraneous 而收集不到 —— 包能打出来，但 app.asar 只有直接依赖，装上启动即崩\n' +
      '      （实测表象：Cannot find module \'safer-buffer\'）。\n' +
      '      解法：① 在本目录用真目录安装依赖（npm ci）；② 或到有真 node_modules 的仓库目录里打包；\n' +
      '      ③ 只是想看配置解析确需放行，置 KNOWBASE_ALLOW_SYMLINK_NODE_MODULES=1。',
    )
    process.exit(3)
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const version = String(pkg.version ?? '').trim()
  const exists = (rel) => existsSync(join(repoRoot, rel))
  const outRel = nextPackDirName(version, exists)
  console.log(`[pack] 版本 ${version} -> 产物目录 ${outRel}（目标 ${flag}${explicit ? '，显式指定' : '，按宿主平台'}）`)
  run('electron-vite build')
  run(`electron-builder ${flag} --publish=never${dirOnly ? ' --dir' : ''} --config.directories.output=${outRel}`)

  const asarPath = ['linux-unpacked', 'win-unpacked']
    .map(d => join(repoRoot, outRel, d, 'resources', 'app.asar'))
    .find(existsSync)
  if (!asarPath) {
    console.error(`[pack] 中止：产物里没有 app.asar（${outRel}）`)
    process.exit(4)
  }
  verifyPackedAsar(asarPath)
  installLocalIfConfigured(outRel)
}

/**
 * 本机自用安装（2026-10-20）：`scripts/local-install.json` 存在时（gitignored），
 * 打包成功后自动把产物同步到配置的目录，保证「每次更新后安装版跟着更新」。
 * 配置不存在 = 不启用（其他机器 / CI 不受影响）。
 */
function installLocalIfConfigured(outRel) {
  const cfgPath = join(repoRoot, 'scripts', 'local-install.json')
  if (!existsSync(cfgPath)) return
  let cfg
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch (e) {
    console.warn('[pack] scripts/local-install.json 无法解析，跳过本地安装：' + (e?.message || e))
    return
  }
  const target = typeof cfg?.target === 'string' ? cfg.target.trim() : ''
  if (!target) return
  const icon = typeof cfg?.icon === 'string' ? cfg.icon.trim() : ''
  console.log(`[pack] 本地安装已配置 → ${target}${icon ? `（图标覆盖：${icon}）` : ''}`)
  const args = [
    join(repoRoot, 'scripts', 'install-local.mjs'),
    '--from', outRel,
    '--target', target,
  ]
  if (icon) args.push('--icon', icon)
  const r = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' })
  if (r.status !== 0) {
    console.warn('[pack] 本地安装更新失败（安装包本身已生成，可稍后手动重跑 scripts/install-local.mjs）')
  }
}

/**
 * 外部依赖自检：`out/main` 里所有 bare require 都必须能在 `app.asar` 的 node_modules 里找到。
 *
 * 为什么需要（2026-10-28 依赖分层）：渲染层依赖（react / monaco / mermaid …）已移入
 * devDependencies —— 它们由 Vite 打进 `out/renderer`，不进 asar。只有主进程 `require()`
 * 的包必须留在 dependencies。一旦误把主进程用到的包移走，electron-builder **不会报错**，
 * 只是把它漏出 asar → 装机启动即 `Cannot find module`。
 *
 * 判据：用 Node 的 `require.resolve` 解析每个说明符（自动走 package.json exports，
 * 子路径别名也能命中），再把解析结果换算成 asar 内相对路径，必须存在。
 * `canvas` 永不触发的可选分支（linkedom 的 Node 原生路径），允许缺席。
 *
 * @param {string} asarPath app.asar 绝对路径
 * @param {string} outMainDir 主进程产物目录（out/main）
 */
export function verifyAsarExternalDeps(asarPath, outMainDir) {
  const asar = requireFromHere('@electron/asar')
  const entries = new Set(asar.listPackage(asarPath).map((p) => p.replace(/\\/g, '/')))
  const resolveFromRepo = createRequire(join(repoRoot, 'package.json'))
  const ALLOW_MISSING = new Set(['canvas'])
  const BUILTINS = new Set([
    'fs', 'path', 'os', 'url', 'stream', 'crypto', 'http', 'https', 'zlib', 'child_process',
    'util', 'events', 'net', 'tls', 'dns', 'vm', 'module', 'assert', 'buffer', 'process',
    'readline', 'tty', 'worker_threads', 'perf_hooks', 'string_decoder', 'querystring',
    'constants', 'timers', 'async_hooks', 'punycode', 'repl', 'cluster', 'dgram', 'sys',
    'wasi', 'inspector', 'diagnostics_channel', 'trace_events',
  ])
  const RE = [
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\.resolve\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ]
  const specifiers = new Set()
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (p.endsWith('.js')) {
        const text = readFileSync(p, 'utf8')
        for (const re of RE) for (const m of text.matchAll(re)) specifiers.add(m[1])
      }
    }
  }
  walk(outMainDir)

  const missing = []
  for (const spec of specifiers) {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec === 'electron') continue
    const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (BUILTINS.has(pkgName) || ALLOW_MISSING.has(pkgName)) continue
    // 用 Node 的 require 解析真实落盘文件（会自动走 package.json exports，子路径别名也能命中）
    let resolved
    try {
      resolved = resolveFromRepo.resolve(spec)
    } catch {
      missing.push(`${spec}（无法解析）`)
      continue
    }
    const rel = relative(repoRoot, resolved).replace(/\\/g, '/')
    if (!entries.has('/' + rel)) {
      missing.push(`${spec} → /${rel}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `app.asar 缺主进程运行时依赖：\n  - ${missing.join('\n  - ')}\n` +
      '  这些包被 out/main require，但不在 dependencies 里（大概率被误移到 devDependencies）。',
    )
  }
  console.log(`[pack] asar 外部依赖自检通过：${specifiers.size} 个 bare require 全部命中`)
}

/**
 * 构建后校验 app.asar 的「文件表 ↔ 数据区」是否自洽。
 *
 * 为什么需要（2026-10-20 实测）：`npm run dev` 还在跑时执行 `npm run pack`，
 * electron-vite 的 dev 进程会在 build 清理 out/ 之后继续写文件 → electron-builder
 * 先按 A 时刻的文件表算偏移、再按 B 时刻的内容拷数据 ⇒ 包能打出来、deb 也能装，
 * 但 `app.asar` 里的 package.json 指向了 index.html 的字节，启动退化成 Electron 默认页
 * （打印 Usage），**全程没有任何报错**。这条断言把「静默坏包」变成响亮的失败。
 *
 * @param {string} asarPath 绝对路径
 */
export function verifyPackedAsar(asarPath) {
  try {
    const asar = requireFromHere('@electron/asar')
    const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
    const entries = new Set(asar.listPackage(asarPath).map((p) => p.replace(/\\/g, '/')))
    const main = String(pkg.main || '').replace(/^\.\//, '')
    if (!main) throw new Error('package.json 缺 main')
    if (!entries.has('/' + main)) throw new Error(`入口不在包内：/${main}`)
    console.log(`[pack] app.asar 校验通过（${entries.size} 项，入口 /${main}）`)
  } catch (e) {
    console.error(
      '[pack] 中止：app.asar 校验失败 —— ' + (e?.message || e) + '\n' +
      '      典型原因：打包时有 dev 进程（electron-vite dev）在写 out/，文件表与数据区错位。\n' +
      '      修法：停掉所有 dev 实例后重打；本产物不可发布（装上会退化成 Electron 默认页）。',
    )
    process.exit(4)
  }
  try {
    verifyAsarExternalDeps(asarPath, join(repoRoot, 'out', 'main'))
  } catch (e) {
    console.error('[pack] 中止：' + (e?.message || e))
    process.exit(4)
  }
}

if (isDirectRun()) main()
