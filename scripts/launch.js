/**
 * 启动器 —— 剥离 ELECTRON_RUN_AS_NODE 环境变量后启动 Electron
 * 用法：node scripts/launch.js dev   → electron-vite dev
 *       node scripts/launch.js start → 运行已构建的 out/main/index.js
 *       node scripts/launch.js dev --rendererOnly
 *         （只跑渲染层 dev server；注意它**仍会尝试启动 Electron**，
 *           若 out/main/index.js 不存在会报 “No electron app entry file found”）
 *
 * 为什么优先直接 exec 本地 CLI，而不是 npx（2026-09-15）：
 *   1. npx 是 .cmd。Node ≥18.20.2（含本机 v24）对 `spawn('*.cmd', { shell: false })`
 *      会直接抛 EINVAL（CVE-2024-27980 的缓解措施），旧写法在此静默失败。
 *   2. 即使改走 `cmd /c npx`，也要求 node 所在目录在 PATH 里。桌面快捷方式、
 *      Explorer 启动、IDE 集成终端里这个前提经常不成立 —— 表象就是「双击没反应」。
 *   3. node_modules/electron-vite/bin/electron-vite.js 是纯 JS 入口，
 *      用 process.execPath（= 正在跑本脚本的那个 node，必然存在）直接 exec 即可：
 *      不依赖 PATH、不依赖 .cmd、不依赖 shell。npx 只保留为本地 CLI 缺失时的兜底。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const mode = process.argv[2] || 'start'
const passthrough = process.argv.slice(3)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const localCli = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

function spawnElectronVite(args) {
  if (fs.existsSync(localCli)) {
    return spawn(process.execPath, [localCli, ...args], {
      env, cwd: root, stdio: 'inherit'
    })
  }
  // 兜底：本地 CLI 不存在（依赖没装全）时退回 npx。
  // Windows 下必须经 cmd.exe —— npx 是 .cmd，shell:false 直呼会 EINVAL。
  return process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'npx', 'electron-vite', ...args], {
        env, cwd: root, stdio: 'inherit', shell: false
      })
    : spawn('npx', ['electron-vite', ...args], {
        env, cwd: root, stdio: 'inherit', shell: false
      })
}

if (mode === 'dev') {
  // AI 测试桥:dev 默认开启(显式设 KNOWBASE_DEV_BRIDGE=0 可关闭)。
  // 生产构建不经过本分支,因此无论环境变量如何都不会打包该能力。
  if (env.KNOWBASE_DEV_BRIDGE === undefined) env.KNOWBASE_DEV_BRIDGE = '1'
  spawnElectronVite(['dev', ...passthrough]).on('close', code => process.exit(code || 0))
} else {
  const electron = path.join(root, 'node_modules/electron/dist/electron.exe')
  const mainScript = path.join(root, 'out/main/index.js')
  const child = spawn(electron, [mainScript], { env, cwd: root, stdio: 'inherit' })
  child.on('error', err => { console.error('启动失败:', err.message); process.exit(1) })
  child.on('close', code => process.exit(code || 0))
}
