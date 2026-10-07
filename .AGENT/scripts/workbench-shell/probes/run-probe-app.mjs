/**
 * 探针宿主（**隔离实例**版）—— 与同目录 `run-probe.mjs` 同款，但 electron 的 cwd 指向隔离 app 目录，
 * 从而绕开「用户自己开着 dev 窗口 ⇒ 单实例锁被占 ⇒ 探针实例静默退出」。
 *
 * ## 为什么需要它
 * dev 的 userData 按 `basename(app.getAppPath())` 命名（`main/index.ts` L94）。cwd = 仓库根时是
 * `knowbase (dev KnowledgeRecorder)` —— **与用户自己开着的 dev 窗口同一个** ⇒ 抢不到单实例锁 →
 * `app.exit(0)` 静默退出，探针只报「CDP page target 未出现」，看不出原因
 * （见记忆 `dev-instance-holds-probe-lock`）。**不要 kill 用户的窗口来腾锁。**
 *
 * 把 cwd 换成一个**真实目录**（本脚本自动建 `tmp/probe-app`，其 `out` / `node_modules` / `build`
 * 三个子项是指向仓库的 junction）⇒ `getAppPath()` 就是那个目录名 ⇒ userData = `knowbase (dev probe-app)`，
 * 与用户实例互不打扰。
 *   ★ 注意「junction 绕不开」那条说的是**把仓库根 junction 到别处**——那时 getAppPath() 会解析回真实
 *     路径，devDir 不变。本脚本 junction 的是**子目录**，appPath 是真实目录，故有效。
 *
 * ## 用法
 *   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs <探针路径>
 * 前置（缺一即假红）：
 *   1) `npm run build` —— 探针跑的是 `out/` 构建产物（junction 到仓库 out/）；改了 electron/ 或渲染层都要重跑。
 *   2) seed 用**同一个 userData 名**：`node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --add-books --ud "knowbase (dev probe-app)"`
 *      （探针的 fixture 在 `tmp/vault-fixture`，两份 seed 共用同一 fixture 目录）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'

const probePath = resolve(process.argv[2] ?? '')
if (!probePath || !existsSync(probePath)) {
  console.error('探针不存在:', probePath)
  process.exit(2)
}

const ELECTRON_EXE = resolve('node_modules/electron/dist/electron.exe')
if (!existsSync(ELECTRON_EXE)) {
  console.error('electron.exe 不存在:', ELECTRON_EXE)
  process.exit(2)
}

// ===== 自备隔离 app 目录（幂等）：真实目录 + 三个 junction 子项 + 一份 package.json =====
const APP_DIR = resolve('tmp', 'probe-app')
mkdirSync(APP_DIR, { recursive: true })
for (const sub of ['out', 'node_modules', 'build']) {
  const link = join(APP_DIR, sub)
  if (!existsSync(link)) {
    try {
      symlinkSync(resolve(sub), link, 'junction')
      console.log(`[宿主] junction: ${sub} → ${resolve(sub)}`)
    } catch (e) {
      console.error(`建 junction 失败（${sub}）：`, e.message)
      process.exit(2)
    }
  }
}
// package.json 决定 `main` 指向 out/main/index.js；每次从仓库根刷新，避免版本号飘
try { copyFileSync(resolve('package.json'), join(APP_DIR, 'package.json')) } catch (e) {
  console.error('复制 package.json 失败：', e.message)
  process.exit(2)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // 否则 electron 退化成裸 Node（ipcMain undefined）
const PROBE_PORT = process.env.KNOWBASE_PROBE_PORT ?? '9333'

// 沙箱硬约束：--no-sandbox 必带（否则 GPU 进程连环崩、渲染进程被 kill）
const electronProc = spawn(ELECTRON_EXE, ['.', `--remote-debugging-port=${PROBE_PORT}`, '--no-sandbox', '--disable-gpu'], {
  cwd: APP_DIR,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
})
console.log(`[宿主] electron pid=${electronProc.pid} port=${PROBE_PORT} appDir=${APP_DIR}`)

// 探针的 cwd 保持在仓库根（它按 process.cwd()/tmp/vault-fixture 找 fixture）
const probeProc = spawn(process.execPath, [probePath], {
  cwd: process.cwd(),
  env: { ...env, KNOWBASE_PROBE_PORT: PROBE_PORT },
  stdio: ['ignore', 'inherit', 'inherit'],
})
probeProc.on('exit', (code) => {
  // Windows 上 kill() 不保证整树退出，taskkill /T 兜底
  try { spawn('taskkill', ['/F', '/T', '/PID', String(electronProc.pid)], { stdio: 'ignore' }) } catch { /* 尽力收尾 */ }
  console.log(`[宿主] 探针退出码=${code}，electron 已收尾`)
  process.exit(code ?? 0)
})
// 保活：父进程必须常驻，否则 stdio 管道断裂 electron 静默死
setInterval(() => {}, 1 << 30)
