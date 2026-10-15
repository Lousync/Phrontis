#!/usr/bin/env node
/**
 * 打包输出规范（2026-10-08 用户拍板，规范正文见仓库根 AGENTS.md「工作流」）：
 *   - 产物目录统一落仓库根 `packs/`；
 *   - 目录名 = 当前 package.json 版本号（如 `packs/3.4.1`）；
 *   - 若该目录已存在（版本号没抬就重复打包），追加 `-1` / `-2` … 直到不冲突（如 `packs/3.4.1-1`）。
 *
 * 用法（经 npm scripts 调用，node_modules/.bin 已在 PATH 上）：
 *   npm run pack       → electron-vite build && electron-builder（输出到 packs/<name>）
 *   npm run pack:dir   → 同上，但只出解包目录（--dir，不打安装包）
 */
import { existsSync, realpathSync, readFileSync } from 'node:fs'
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
  const dirOnly = process.argv.includes('--dir-only')
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const version = String(pkg.version ?? '').trim()
  const exists = (rel) => existsSync(join(repoRoot, rel))
  const outRel = nextPackDirName(version, exists)
  console.log(`[pack] 版本 ${version} -> 产物目录 ${outRel}`)
  run('electron-vite build')
  run(`electron-builder --win --publish=never${dirOnly ? ' --dir' : ''} --config.directories.output=${outRel}`)
}

if (isDirectRun()) main()
