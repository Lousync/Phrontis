/**
 * 桌面一键启动器
 * - 首次运行：自动安装依赖
 * - 直接以开发模式启动：node scripts/launch.js dev（实时编译最新代码，免安装、免手动打包）
 * - 全程输出同时落 logs/launch-last.log（2026-10-12）：dev 启动失败时窗口可能一闪就没了，
 *   这份日志保证错误还在磁盘上，直接发它就是完整现场。
 * - dev 进程树的 TEMP/TMP 收到 tmp/dev-temp（2026-10-13，见 DEV_TMP 注释）。
 * - 启动前自检 node_modules 的「低信任标签」（2026-10-13，见 integrityPreflight 注释）：
 *   标签一旦被降级，dev 的 electron 写不进 userData，表象只有窗口一闪而过。
 * 用法：node scripts/start-desktop.js
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { electronBinary } = require('./electron-bin')

const ROOT = path.join(__dirname, '..')
// Electron 可执行名按平台解析。原先写死 `electron.exe`（Windows 专属名），
// Linux / macOS 下 `needInstall()` 会恒为真 → 每次启动都白跑一遍 npm install。
// 平台守卫与沙箱判定理由见 scripts/electron-bin.js。
const ELECTRON = electronBinary(ROOT)
const LOG_DIR = path.join(ROOT, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'launch-last.log')

/**
 * dev 进程树的临时目录（2026-10-13）。
 *
 * esbuild 的 JS 侧与它的 Go 服务之间有一半协议走**文件**：每条请求写一个
 * `%TEMP%\esbuild-<32字节随机>` 负载（vite 的 SSR bundle 输入有 4 MB 上下），
 * 服务读完自己 `os.Remove`。共用 Temp 根上这一步会间歇性被拒 ——
 *   ERROR [vite:esbuild-transpile] remove C:\...\Temp\esbuild-<hash>: Access is denied
 *   ✗ Build failed in ~7s
 * 于是 dev 起不来、窗口一闪就没。把 TEMP/TMP 收进仓库 tmp/（已 gitignore）后
 * 实测同样负载 0 残留（见 tmp/dev-temp/），系统 Temp 根则每跑必留 1 个。
 * 只影响 dev 启动；打包后的应用仍用系统 Temp。
 *
 * Linux 平台化（2026-10-19）：同一套 esbuild 文件协议在 POSIX 上走的是 TMPDIR，
 * 故启动子进程时 TEMP / TMP / TMPDIR 三个都指向本目录（各平台只会读自己那条）。
 */
const DEV_TMP = path.join(ROOT, 'tmp', 'dev-temp')
const INTEGRITY_GUARD = path.join(ROOT, '.AGENT', 'scripts', 'acl-integrity-guard', 'verify-integrity-labels.mjs')

let log = null

function needInstall() {
  return !fs.existsSync(ELECTRON)
}

function openLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const stream = fs.createWriteStream(LOG_FILE, { flags: 'w' })
    stream.write(`[启动器] ${new Date().toISOString()}  node=${process.execPath}  cwd=${ROOT}\n`)
    return stream
  } catch (err) {
    console.error('[启动器] 日志文件打不开（不影响启动，只是没有日志）：' + err.message)
    return null
  }
}

function tail(file, lines) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return ''
  }
}

/**
 * 子进程输出同时进控制台与日志。
 * stdio 必须是 pipe（不能是 inherit）——inherit 只接控制台，日志就拿不到错误原文。
 */
function run(cmd, args, label, extraEnv) {
  console.log(`\n[启动器] ${label} ...`)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env
    })
    child.stdout.on('data', buf => { process.stdout.write(buf); if (log) log.write(buf) })
    child.stderr.on('data', buf => { process.stderr.write(buf); if (log) log.write(buf) })
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

/**
 * 启动前置自检：node_modules 里可执行文件的「低信任标签」（2026-10-13 真事）。
 *
 * 为让受限会话能写仓库子目录，整棵树被 `icacls /setintegritylevel (OI)(CI)L /T` 打过低标签；
 * Windows 会把镜像文件的完整性级别带给新进程 ⇒ 从 node_modules 启动的 electron / esbuild
 * 一律以低信任身份运行：electron 写不进 %APPDATA%\knowbase (dev)，esbuild 也删不掉自己的
 * 临时负载。表象只有「窗口一闪而过 + Access is denied」，而 Defender / 通知库 / WER 全静默，
 * 极易被误判成「被 Windows 安全拦了」。这里只读判定，不自动修（改标签要管理员权限）。
 *
 * 退出码：0 = 正常，继续启动；1 = 确认带低标签（dev 必然失败）⇒ 停下，让上方的修复命令可见；
 * 2 = 读不到结果（受限会话/权限）⇒ 不拦，失败原因照旧看 logs/launch-last.log。
 * stdio 用 inherit：受限会话里 Node 捕获子进程管道会被拒（EPERM），inherit 不受影响。
 */
function integrityPreflight() {
  if (!fs.existsSync(INTEGRITY_GUARD)) return 0
  console.log('[启动器] 自检可执行目录的完整性标签（node_modules）...')
  let res
  try {
    res = spawnSync(process.execPath, [INTEGRITY_GUARD, '--root', 'node_modules'], { cwd: ROOT, stdio: 'inherit' })
  } catch {
    return 2
  }
  return res.status === null ? 2 : res.status
}

;(async () => {
  log = openLog()
  let code = 0
  try {
    const integrity = integrityPreflight()
    // 同步落盘：这一行是「为什么起不来」的关键判据，不能停在写流缓冲区里
    try { fs.appendFileSync(LOG_FILE, `[启动器] 完整性标签自检 exit=${integrity}\n`) } catch { /* 日志写不了不影响启动 */ }
    if (integrity === 1) {
      throw new Error('node_modules 里的可执行文件带着低信任标签 —— dev 必然起不来（修复命令见上方）')
    }
    if (integrity === 2) {
      console.warn('[启动器] 完整性标签自检没拿到结果（受限会话/权限），继续启动；失败原因以日志为准。')
    }
    if (needInstall()) {
      console.log('[启动器] 首次运行，正在安装依赖，请稍候...')
      await npmInstall()
    }
    fs.mkdirSync(DEV_TMP, { recursive: true })
    console.log(`[启动器] 正在以开发模式启动 Knowbase ...（dev 临时目录：${DEV_TMP}）`)
    // Windows 认 TEMP/TMP，POSIX 认 TMPDIR —— 三处都设，各平台只取自己那条
    await run(process.execPath, [path.join(ROOT, 'scripts/launch.js'), 'dev'], '启动应用', {
      TEMP: DEV_TMP,
      TMP: DEV_TMP,
      TMPDIR: DEV_TMP
    })
    console.log('[启动器] 应用已退出')
  } catch (err) {
    code = 1
    console.error('\n[启动器] ' + err.message)
    console.error('[启动器] 完整日志：' + LOG_FILE)
    const t = tail(LOG_FILE, 40)
    if (t) console.error('[启动器] 日志末尾 40 行：\n' + t)
    if (/esbuild/i.test(t) && /Access is denied/i.test(t)) {
      console.error('[启动器] 提示：esbuild 的临时文件删不掉（安全软件占用 %TEMP% 时的典型症状）。')
      console.error('[启动器] 本启动器已把 dev 的 TEMP 收到 ' + DEV_TMP + '；')
      console.error('[启动器] 若仍失败：清空该目录后重试，或把仓库目录加入杀软白名单。')
    }
    console.error('[启动器] 如反复失败，请打开项目目录手动执行：npm install && npm run build')
  }
  if (log) log.end()
  // 用 exitCode 而非 process.exit()：让日志流写完再自然退出
  process.exitCode = code
})()
