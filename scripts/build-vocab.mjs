#!/usr/bin/env node
/**
 * 构建 qwerty-learner 静态产物 → resources/vocab（v3.17.0）
 *
 * 为什么不在仓库里提交上游源码/产物：qwerty-learner 自带 380 个词库 JSON，仓库体积
 * 百 MB 级；这里按需浅克隆 + 构建，产物 gitignore，打包时由 extraResources 收进安装包。
 *
 * 用法：
 *   npm run build:vocab
 *   VOCAB_UPSTREAM_DIR=/path/to/qwerty-learner npm run build:vocab   # 复用本地检出
 */
import { existsSync, mkdirSync, rmSync, cpSync, statSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = process.env.VOCAB_UPSTREAM_DIR
  ? resolve(process.env.VOCAB_UPSTREAM_DIR)
  : join(ROOT, 'vendor', 'qwerty-learner')
const OUT = join(ROOT, 'resources', 'vocab')
const PATCH = join(ROOT, 'scripts', 'vocab', 'patch-upstream.mjs')

function run(cmd, args, cwd) {
  console.log(`\n[RUN] ${cmd} ${args.join(' ')}  (${cwd})`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`[FAIL] 命令失败：${cmd} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}

function dirSizeMb(dir) {
  let total = 0
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const f = join(p, name)
      const st = statSync(f)
      if (st.isDirectory()) walk(f)
      else total += st.size
    }
  }
  walk(dir)
  return (total / 1024 / 1024).toFixed(1)
}

// 1. 取上游（浅克隆；已存在则对齐 origin/master）
if (!existsSync(join(UPSTREAM, 'package.json'))) {
  mkdirSync(dirname(UPSTREAM), { recursive: true })
  run('git', ['clone', '--depth', '1', 'https://github.com/RealKai42/qwerty-learner.git', UPSTREAM], ROOT)
} else {
  run('git', ['fetch', '--depth', '1', 'origin', 'master'], UPSTREAM)
  run('git', ['reset', '--hard', 'FETCH_HEAD'], UPSTREAM)
}

// 2. 打补丁（失败即中止，绝不静默产出带上报的包）
run(process.execPath, [PATCH, UPSTREAM], ROOT)

// 3. 安装依赖 + 构建
// 上游有 yarn.lock，但 npm install 也能解析 package.json；优先用 npm，避免要求全局 yarn。
run('npm', ['install', '--no-audit', '--no-fund'], UPSTREAM)
run('npm', ['run', 'build'], UPSTREAM)

// 4. 复制 build → resources/vocab
const buildDir = join(UPSTREAM, 'build')
if (!existsSync(join(buildDir, 'index.html'))) {
  console.error('[FAIL] 构建产物缺少 build/index.html')
  process.exit(1)
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
cpSync(buildDir, OUT, { recursive: true })

console.log(`\n[DONE] resources/vocab 已生成（${dirSizeMb(OUT)} MB）`)
console.log('      开发模式可直接 npm run dev；打包时由 extraResources 收进安装包。')
