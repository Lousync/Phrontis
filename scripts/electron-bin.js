/**
 * Electron 可执行文件定位 + Linux 沙箱可用性判定。
 * 被 scripts/launch.js（dev / start）与 scripts/start-desktop.js 共用。
 *
 * 为什么需要它（2026-10-19 Linux 平台化）：仓库原先在两处硬编码
 * `node_modules/electron/dist/electron.exe` —— 那是 **Windows 专属文件名**，
 * Linux / macOS 下叫 `electron`，于是 `npm start` 在非 Windows 上必然
 * `spawn … electron.exe ENOENT`。
 *
 * 权威来源是 electron 包安装时按当前平台写好的 `node_modules/electron/path.txt`；
 * 按平台拼名只作为 path.txt 缺失时的兜底。
 */
const fs = require('fs')
const path = require('path')

/** electron 包的 dist 目录 */
function electronDistDir(root) {
  return path.join(root, 'node_modules', 'electron', 'dist')
}

/** Electron 可执行文件绝对路径（不保证文件存在） */
function electronBinary(root) {
  const dist = electronDistDir(root)
  try {
    const name = fs.readFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
    // macOS 下 path.txt 是 'Electron.app/Contents/MacOS/Electron'（含子路径），join 能正确处理
    if (name) {
      const p = path.join(dist, name)
      if (fs.existsSync(p)) return p
    }
  } catch { /* path.txt 缺失：落到按平台拼名 */ }
  const fallback =
    process.platform === 'win32' ? 'electron.exe'
    : process.platform === 'darwin' ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
    : 'electron'
  return path.join(dist, fallback)
}

/**
 * Linux 上 Chrome 沙箱当前是否可用。
 *
 * 背景（2026-10-19 本机实测，Ubuntu 26.04 / Electron 33.2.0 / GNOME）：
 *   · node_modules 里的 chrome-sandbox 既不是 root 所有、也没有 setuid 位；
 *   · Ubuntu 23.10+ 用 AppArmor 关掉了非特权 user namespace，Chromium 的 namespace
 *     沙箱因此不可用 —— 实测 `--disable-setuid-sandbox` 报 `No usable sandbox!`，
 *     也就是说「只关 SUID 助手、保留 namespace 沙箱」这条退路在本发行版上是死的；
 *   · 而 Chromium 一旦发现 SUID 助手**存在却没配好**，会直接 FATAL 退出而不是退回其它沙箱：
 *       FATAL:setuid_sandbox_host.cc(163) The SUID sandbox helper binary was found, but is
 *       not configured correctly. Rather than run without sandboxing I'm aborting now.
 *     （退出码 133 + core dump；表象是「窗口一闪都没闪，进程就没了」）
 *
 * 所以判据就是「chrome-sandbox 是否 root 所有 + 有 setuid 位」：不满足就必须显式 --no-sandbox。
 *
 * 注意：装成 deb 之后不受此影响 —— electron-builder 的 postinst 会按发行版情况装 AppArmor
 * profile（或按需 chmod 4755），从应用菜单启动的正式版走的是那条路，不是本函数。
 */
function linuxSandboxUsable(root) {
  try {
    const st = fs.statSync(path.join(electronDistDir(root), 'chrome-sandbox'))
    return st.uid === 0 && (st.mode & 0o4000) !== 0
  } catch {
    return false
  }
}

/** 本次启动是否需要显式关沙箱。KNOWBASE_NO_SANDBOX=0/1 可强制覆盖（排障用）。 */
function needsNoSandbox(root) {
  const forced = process.env.KNOWBASE_NO_SANDBOX
  if (forced === '1') return true
  if (forced === '0') return false
  if (process.platform !== 'linux') return false
  return !linuxSandboxUsable(root)
}

/** 关沙箱时打一次醒目提示 —— 这是安全性降级，必须让开发者看见，并给出恢复沙箱的修法 */
function warnNoSandbox(root) {
  const box = path.join(electronDistDir(root), 'chrome-sandbox')
  console.warn('[sandbox] 已对 Electron 关闭沙箱。原因：Linux 下 chrome-sandbox 未 root+setuid，')
  console.warn('[sandbox] 且本发行版（Ubuntu 23.10+ / AppArmor）禁用了非特权 user namespace。')
  console.warn('[sandbox] 想恢复沙箱，二选一：')
  console.warn('[sandbox]   1) sudo chown root:root ' + box)
  console.warn('[sandbox]      sudo chmod 4755 ' + box)
  console.warn('[sandbox]   2) 装成 deb（postinst 会带 AppArmor profile）后从应用菜单启动')
  console.warn('[sandbox] 想强制保持沙箱：KNOWBASE_NO_SANDBOX=0')
}

module.exports = { electronDistDir, electronBinary, linuxSandboxUsable, needsNoSandbox, warnNoSandbox }
