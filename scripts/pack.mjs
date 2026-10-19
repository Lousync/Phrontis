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
import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 纯函数：给定「已存在判定器」，算出本次可用的产物目录（相对仓库根的 POSIX 路径）。
 * @param {string} version 版本号（如 '3.4.1'）
 * @param {(relPath: string) => boolean} exists 相对仓库根是否存在
 */
export function nextPackDirName(version, exists) {
  const v = String(version ?? '').trim() || '0.0.0'
  const base = `packs/${v}`
  if (!exists(base)) return base
  for (let i = 1; i < 1000; i++) {
    const cand = `packs/${v}-${i}`
    if (!exists(cand)) return cand
  }
  throw new Error('打包目录后缀超过上限（1000）——请清理 packs/ 后重试')
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
}

if (isDirectRun()) main()
