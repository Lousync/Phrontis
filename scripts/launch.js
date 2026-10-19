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
 *
 * ---- Linux 平台化（2026-10-19，三条都是实测结论）----
 *   · **可执行文件名**不再写死 `electron.exe`：那是 Windows 专属名，Linux / macOS 下叫
 *     `electron`。原先 `npm start` 在非 Windows 上必然是 ENOENT。改由 scripts/electron-bin.js
 *     按平台解析（权威来源是 electron 包的 path.txt）。
 *   · **沙箱**：Ubuntu 23.10+ 用 AppArmor 关掉了非特权 user namespace，而 node_modules 里的
 *     chrome-sandbox 既非 root 所有也无 setuid 位 → Chromium 发现「SUID 助手存在但没配好」
 *     直接 FATAL 退出（退出码 133 + core dump）。故 Linux 下按需注入 --no-sandbox：
 *     dev 走 electron-vite 的 NO_SANDBOX=1，start 走命令行参数。判据与恢复修法见 electron-bin.js。
 *     ⚠️ 反过来，**不能**靠 app.commandLine.appendSwitch('no-sandbox') 兜底 —— 实测无效
 *     （sandbox 在 JS 主脚本执行前就已定下来）。臭氧平台同理，见下条。
 *   · **显示后端**：显式钉 ELECTRON_OZONE_PLATFORM_HINT=x11。原生 Wayland 下窗口定位
 *     （setBounds 驱动的贴顶停靠 / 边缘拖拽恢复）与全局热键都不可用，本项目只支持 X11/XWayland。
 *     ★ 本开关**只能**走 env 变量或命令行开关：`app.commandLine.appendSwitch('ozone-platform', …)`
 *       实测对该开关无效（臭氧平台在主脚本执行前就已选定）。另注意 HINT=auto 在 Wayland 会话下
 *       会**主动选中 Wayland**，所以这里必须是硬值 x11 而不是 auto。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { electronBinary, needsNoSandbox, warnNoSandbox } = require('./electron-bin')

const root = path.join(__dirname, '..')
const mode = process.argv[2] || 'start'
const passthrough = process.argv.slice(3)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// —— 平台守卫：一次算好，两个分支共用 ——
const noSandbox = needsNoSandbox(root)
if (noSandbox) warnNoSandbox(root)
if (process.platform === 'linux' && !env.ELECTRON_OZONE_PLATFORM_HINT) {
  env.ELECTRON_OZONE_PLATFORM_HINT = 'x11'
}

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
  // electron-vite 读到 NO_SANDBOX=1 会给 Electron 追加 --no-sandbox
  // （实现见 node_modules/electron-vite/dist/chunks/lib-*.js：`if (process.env.NO_SANDBOX === '1') args.push('--no-sandbox')`）
  if (noSandbox) env.NO_SANDBOX = '1'
  spawnElectronVite(['dev', ...passthrough]).on('close', code => process.exit(code || 0))
} else {
  const electron = electronBinary(root)
  const mainScript = path.join(root, 'out/main/index.js')
  if (!fs.existsSync(electron)) {
    console.error('启动失败: 找不到 Electron 可执行文件 ' + electron + ' —— 先跑 npm install')
    process.exit(1)
  }
  if (!fs.existsSync(mainScript)) {
    console.error('启动失败: 找不到主进程产物 ' + mainScript + ' —— 先跑 npm run build')
    process.exit(1)
  }
  const args = [mainScript, ...(noSandbox ? ['--no-sandbox'] : []), ...passthrough]
  const child = spawn(electron, args, { env, cwd: root, stdio: 'inherit' })
  child.on('error', err => { console.error('启动失败:', err.message); process.exit(1) })
  child.on('close', code => process.exit(code || 0))
}
