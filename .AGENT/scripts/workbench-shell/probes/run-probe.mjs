/**
 * 探针宿主：spawn electron（build 产物）→ 前台跑探针脚本 → 透传退出码并收尾。
 * 用法：node tmp/run-probe.mjs <探针路径> [electron 参数...]
 * 三条件（windows-sandbox-ops §9.5）：脱沙箱外跑、剥 ELECTRON_RUN_AS_NODE、node 常驻父进程。
 * 数据隔离：不设 KNOWBASE_SHARED_DATA → app 走 dev 隔离分支（main/index.ts L86），
 * userData = %APPDATA%/knowbase (dev KnowledgeRecorder)，与正式数据完全隔离。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const probePath = resolve(process.argv[2] ?? 'tmp/probe-shell-b3.mjs')
if (!existsSync(probePath)) {
  console.error('探针不存在:', probePath)
  process.exit(2)
}

const NODE_EXE = process.execPath
const ELECTRON_EXE = resolve('node_modules/electron/dist/electron.exe')
if (!existsSync(ELECTRON_EXE)) {
  console.error('electron.exe 不存在:', ELECTRON_EXE)
  process.exit(2)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // 否则 electron 退化成裸 Node（ipcMain undefined）
// 不设 KNOWBASE_SHARED_DATA → 走 main/index.ts L86 dev 隔离分支，userData 与正式数据隔离

// CDP 端口可覆盖：9222 会被本机常驻的 WorkBuddy（自身也开 devtools 端口）占住，
// 那时 electron 报「bind() ... 只允许使用一次」→ 探针等不到 page target 直接失败。
// 探针侧读同一个环境变量（KNOWBASE_PROBE_PORT），两处必须一致。
const PROBE_PORT = process.env.KNOWBASE_PROBE_PORT ?? '9222'

// 沙箱硬约束（electron-inapp-ui-probe §一）：不传 --no-sandbox → GPU 进程连环 exit_code=1，
// 最终 FATAL:GPU process isn't usable → 渲染进程被 kill。这两个参数在所有环境都无害，固定带上。
const extraArgs = process.argv.slice(3)
const electronProc = spawn(ELECTRON_EXE, ['.', `--remote-debugging-port=${PROBE_PORT}`, '--no-sandbox', '--disable-gpu', ...extraArgs], {
  cwd: process.cwd(),
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
})
console.log(`[宿主] electron pid=${electronProc.pid} port=${PROBE_PORT}`)

const probeProc = spawn(NODE_EXE, [probePath], { cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'] })
probeProc.on('exit', (code) => {
  // Windows 上 kill() 不保证整树退出，taskkill /T 兜底
  try { spawn('taskkill', ['/F', '/T', '/PID', String(electronProc.pid)], { stdio: 'ignore' }) } catch { /* 尽力收尾 */ }
  console.log(`[宿主] 探针退出码=${code}，electron 已收尾`)
  process.exit(code ?? 0)
})
// 保活：父进程必须常驻，否则 stdio 管道断裂 electron 静默死
setInterval(() => {}, 1 << 30)
