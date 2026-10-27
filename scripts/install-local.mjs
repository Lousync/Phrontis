#!/usr/bin/env node
/**
 * 本地安装 / 更新（Linux，免 root）：把 `packs/<ver>[-N]/linux-unpacked` 同步到
 * `~/apps/Phrontis`（默认），并刷新用户级启动器 / D-Bus 服务 / CLI。
 *
 * 为什么不用 deb：
 *   deb 固定装到 `/opt/Phrontis`，还要 sudo + AppArmor / chrome-sandbox 处理；
 *   本机只想「放在自己指定的目录、随每次打包自动更新」，所以走**解包目录 + 用户级集成**。
 *   代价：必须带 `--no-sandbox`（chrome-sandbox 不是 root:4755），启动器 / D-Bus / CLI
 *   三处都已写死该参数；这是本机单用户安装的明确取舍。
 *
 * 自动更新：
 *   `scripts/local-install.json`（gitignored）存在时，`npm run pack` 成功后会自动调用本脚本
 *   （见 scripts/pack.mjs 的 installLocalIfConfigured）。
 *
 * 用法：
 *   node scripts/install-local.mjs                        # 取最新 pack，装到 ~/apps/Phrontis
 *   node scripts/install-local.mjs --from packs/3.9.2-6
 *   node scripts/install-local.mjs --target /home/you/apps/Phrontis
 *   node scripts/install-local.mjs --icon /path/to/system-icon.png
 *
 * --icon 只覆盖本机安装目录与桌面图标，不改 build/icon.png，也不会进入安装包；
 * 适合用户自己替换了系统图标、但软件本身仍应使用官方图标的场景。
 *
 * 目录替换是「staging → 原子 rename」，不会在运行中被逐文件覆盖。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, chmodSync, copyFileSync, statSync, cpSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const requireFromHere = createRequire(import.meta.url)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { from: '', target: '', icon: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') out.from = String(argv[++i] ?? '')
    else if (a === '--target') out.target = String(argv[++i] ?? '')
    else if (a === '--icon') out.icon = String(argv[++i] ?? '')
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/install-local.mjs [--from packs/<ver>[-N]] [--target <dir>] [--icon <png>]')
      process.exit(0)
    }
  }
  return out
}

/** 取最新 pack（按 app.asar 的 mtime；比后缀更可靠，能兼容中间产物被删过） */
function latestPackDir() {
  const packs = join(repoRoot, 'packs')
  if (!existsSync(packs)) return ''
  const rows = readdirSync(packs)
    .map((name) => {
      const unpacked = join(packs, name, 'linux-unpacked')
      const asar = join(unpacked, 'resources', 'app.asar')
      return { unpacked, asar, mtime: existsSync(asar) ? statSync(asar).mtimeMs : 0 }
    })
    .filter((r) => r.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime)
  return rows[0]?.unpacked ?? ''
}

function resolveSource(from) {
  if (!from) {
    const latest = latestPackDir()
    if (!latest) throw new Error('packs/ 下没有可用的 linux-unpacked，请先 npm run pack')
    return latest
  }
  const abs = isAbsolute(from) ? from : resolve(repoRoot, from)
  if (existsSync(join(abs, 'linux-unpacked'))) return join(abs, 'linux-unpacked')
  return abs
}

function readVersion(asarPath) {
  try {
    const asar = requireFromHere('@electron/asar')
    const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
    return String(pkg.version ?? 'unknown')
  } catch {
    return 'unknown'
  }
}

function quote(p) {
  return `"${p.replace(/"/g, '\\"')}"`
}

/** 目标目录规范化：支持 `~/...`，其余按当前工作目录解析 */
function resolveTarget(raw) {
  let p = String(raw || '').trim()
  if (!p) return join(homedir(), 'apps', 'Phrontis')
  if (p === '~') p = homedir()
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
  return resolve(p)
}

function writeFileIfChanged(file, content, mode) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, { encoding: 'utf8', mode: mode ?? 0o644 })
  if (mode) chmodSync(file, mode)
}

function runQuiet(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const src = resolveSource(args.from)
  const asarPath = join(src, 'resources', 'app.asar')
  const binPath = join(src, 'phrontis')
  if (!existsSync(binPath)) throw new Error(`产物不可用：找不到 ${binPath}`)
  if (!existsSync(asarPath)) throw new Error(`产物不可用：找不到 ${asarPath}`)

  // 与 pack.mjs 同一把闸门：坏 asar 绝不覆盖现有安装
  const { verifyPackedAsar } = await import(pathToFileURL(join(repoRoot, 'scripts', 'pack.mjs')).href)
  verifyPackedAsar(asarPath)

  const version = readVersion(asarPath)
  const target = resolveTarget(args.target || join(homedir(), 'apps', 'Phrontis'))
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })

  // 护栏：不许装到 /、home 根、或路径过浅处（防参数写错把家目录整个换掉）
  if (target === sep || target === homedir() || target.split(sep).filter(Boolean).length < 3) {
    throw new Error(`拒绝安装到过浅的路径：${target}`)
  }

  const staging = `${target}.new`
  const old = `${target}.old`
  console.log(`[install] Phrontis ${version}  ${src}  ->  ${target}`)
  rmSync(staging, { recursive: true, force: true })
  cpSync(src, staging, { recursive: true, dereference: false })
  rmSync(old, { recursive: true, force: true })
  if (existsSync(target)) renameSync(target, old)
  renameSync(staging, target)
  rmSync(old, { recursive: true, force: true })
  console.log('[OK] 应用目录已更新（原子替换）')

  // ---- 用户级集成：桌面入口 / D-Bus 激活 / CLI / 终端命令 ----
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const appDir = join(dataHome, 'applications')
  const dbusDir = join(dataHome, 'dbus-1', 'services')
  const iconDir = join(dataHome, 'icons', 'hicolor', '512x512', 'apps')
  const binDir = join(homedir(), '.local', 'bin')

  // 本机系统图标覆盖：只影响这台机器的安装目录与桌面图标，
  // 不写回 build/icon.png，也不会进入安装包（软件本身仍用官方图标）。
  // 优先级：--icon 参数 > gitignored 的 scripts/local-install.json > 安装包图标。
  let configuredIcon = ''
  try {
    const cfg = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'local-install.json'), 'utf8'))
    if (typeof cfg?.icon === 'string') configuredIcon = cfg.icon.trim()
  } catch { /* 没配置就回退安装包图标 */ }
  const requestedIcon = (args.icon.trim() || configuredIcon)
  const overrideIcon = requestedIcon ? resolve(requestedIcon) : ''
  if (overrideIcon && !existsSync(overrideIcon)) console.warn(`[install] 自定义图标不存在，回退安装包图标：${overrideIcon}`)
  if (overrideIcon && existsSync(overrideIcon)) {
    copyFileSync(overrideIcon, join(target, 'resources', 'icon.png'))
    console.log(`[install] 使用本机图标覆盖：${overrideIcon}`)
  }
  const iconSrc = overrideIcon && existsSync(overrideIcon) ? overrideIcon : join(target, 'resources', 'icon.png')
  if (existsSync(iconSrc)) {
    mkdirSync(iconDir, { recursive: true })
    copyFileSync(iconSrc, join(iconDir, 'phrontis.png'))
  }

  // 桌面文件名必须是 phrontis.desktop（package.json 的 desktopName / 窗口关联靠它）；
  // 这个文件名不是 reverse-DNS，带 `DBusActivatable=true` 会被 desktop-file-validate 判错，
  // 且 D-Bus 激活由下面单独的 user service 文件承担 —— 所以这里不写该键。
  const desktop = [
    '[Desktop Entry]',
    'Name=Phrontis',
    `Exec=${quote(join(target, 'phrontis'))} --no-sandbox --ozone-platform=x11 %U`,
    `TryExec=${join(target, 'phrontis')}`,
    'Terminal=false',
    'Type=Application',
    'Icon=phrontis',
    // 必须与窗口实际 WM_CLASS 的 res_class 完全一致。package.json 的 name 是 knowbase，
    // 不能为改这个去 app.setName('Phrontis')：Electron 在 Linux 上把 safeStorage 的
    // 钥匙串条目也存在 app.name 名下，改名会让存量 API Key / 密码本全部解不开。
    // 匹配成功后桌面显示的是 Name=Phrontis / Icon=phrontis（用户看到的部分）。
    'StartupWMClass=knowbase',
    'Comment=Phrontis — 本地优先的学习生活操作系统（知识库 / 日程 / 打卡 / AI 教学，数据 100% 本地）',
    'Categories=Office;TextEditor;',
    '',
  ].join('\n')
  writeFileIfChanged(join(appDir, 'phrontis.desktop'), desktop)

  const service = [
    '[D-BUS Service]',
    'Name=io.github.lousync.Phrontis',
    `Exec=${quote(join(target, 'phrontis'))} --no-sandbox --ozone-platform=x11`,
    '',
  ].join('\n')
  writeFileIfChanged(join(dbusDir, 'io.github.lousync.Phrontis.service'), service)

  // CLI：复用应用自带 Electron 的 node 模式（脚本支持 PHRONTIS_HOME / PHRONTIS_CLI 覆盖）
  const cliCjs = join(target, 'resources', 'desktop-bridge', 'phrontis.cjs')
  const cliSh = join(target, 'resources', 'desktop-bridge', 'phrontis-cli')
  if (existsSync(cliCjs) && existsSync(cliSh)) {
    const cliWrapper = [
      '#!/bin/sh',
      `export PHRONTIS_HOME=${quote(target)}`,
      `export PHRONTIS_CLI=${quote(cliCjs)}`,
      `exec ${quote(cliSh)} "$@"`,
      '',
    ].join('\n')
    writeFileIfChanged(join(binDir, 'phrontis-cli'), cliWrapper, 0o755)
  }

  const guiWrapper = [
    '#!/bin/sh',
    `exec ${quote(join(target, 'phrontis'))} --no-sandbox --ozone-platform=x11 "$@"`,
    '',
  ].join('\n')
  writeFileIfChanged(join(binDir, 'phrontis'), guiWrapper, 0o755)

  runQuiet('update-desktop-database', [appDir])
  runQuiet('gtk-update-icon-cache', ['-f', '-t', join(dataHome, 'icons', 'hicolor')])

  console.log(`[OK] 启动器：${join(appDir, 'phrontis.desktop')}`)
  console.log(`[OK] D-Bus 激活：${join(dbusDir, 'io.github.lousync.Phrontis.service')}`)
  console.log(`[OK] 命令：${join(binDir, 'phrontis')} / ${join(binDir, 'phrontis-cli')}`)
  console.log('[OK] 完成。下次 npm run pack 成功后会再次自动同步到这里。')
}

try {
  await main()
} catch (e) {
  console.error('[FAIL] ' + (e?.message || e))
  process.exit(1)
}
