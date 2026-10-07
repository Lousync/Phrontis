/**
 * 桌面一键启动器
 * - 首次运行：自动安装依赖
 * - 直接以开发模式启动：node scripts/launch.js dev（实时编译最新代码，免安装、免手动打包）
 * 用法：node scripts/start-desktop.js
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/electron.exe')

function needInstall() {
  return !fs.existsSync(ELECTRON)
}

function run(cmd, args, label) {
  console.log(`\n[启动器] ${label} ...`)
  const child = spawn(cmd, args, { cwd: ROOT, shell: false, stdio: 'inherit' })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${label} 失败 (exit ${code})`))
    })
  })
}

/**
 * 调用 npm 的方式（2026-09-21）：**不能**写 `npm.cmd`。
 * Node ≥18.20.2（含本机 v24）对 `spawn('*.cmd', { shell: false })` 直接抛 EINVAL
 * —— CVE-2024-27980 的缓解措施，实测 `spawn('npm.cmd', …)` 抛的就是 EINVAL；
 * 而改走 shell: true 又要求 node 所在目录在 PATH 上，Explorer 双击时这个前提
 * 不成立（同 scripts/launch.js 顶部注释第 2 条）。
 * 出路与 launch.js 一致：`npm-cli.js` 是纯 JS 入口、就在 node 安装目录下，
 * 用 process.execPath（= 正在跑本脚本的 node，必然存在）直接 exec，
 * 不依赖 PATH、不依赖 .cmd、不依赖 shell。npx 式兜底只留给非标准安装。
 */
function npmInstall() {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(cli)) return run(process.execPath, [cli, 'install'], '安装依赖')
  return process.platform === 'win32'
    ? run('cmd.exe', ['/c', 'npm', 'install'], '安装依赖')
    : run('npm', ['install'], '安装依赖')
}

;(async () => {
  try {
    if (needInstall()) {
      console.log('[启动器] 首次运行，正在安装依赖，请稍候...')
      await npmInstall()
    }
    console.log('[启动器] 正在以开发模式启动 Knowbase ...')
    await run(process.execPath, [path.join(ROOT, 'scripts/launch.js'), 'dev'], '启动应用')
    console.log('[启动器] 应用已退出')
  } catch (err) {
    console.error('\n[启动器] ' + err.message)
    console.error('[启动器] 如反复失败，请打开项目目录手动执行：npm install && npm run build')
    process.exit(1)
  }
})()
