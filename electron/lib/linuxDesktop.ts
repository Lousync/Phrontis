import { execFile } from 'child_process'
import { accessSync, constants } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'

/**
 * Linux 桌面环境探测（v3.9.2 平台化 · 阶段 1）。
 *
 * 本文件只做**探测与告警**，不改任何既有平台行为；两条探测各自的判据都是实测结论：
 *
 * ① **状态栏宿主（StatusNotifierHost）** —— 决定托盘图标能不能真的显示出来。
 *    ★ 必须走 D-Bus 名探测，**不能**按 GNOME 扩展名判定：
 *      2026-10-19 本机实测宿主**存在**（托盘能显示），但提供它的是系统级预装扩展
 *      `ubuntu-appindicators@ubuntu.com` —— 它**不在** `org.gnome.shell enabled-extensions`
 *      列表里，按扩展名查会得到假阴性（把好机器判成没托盘）。
 *    探测手法：`gdbus call` 问会话总线 `org.kde.StatusNotifierWatcher` 有没有 owner（2s 超时）。
 *    失败（gdbus 不存在 / 总线不在 / 超时）一律按**没有宿主**处理 —— 这一侧的误判代价小：
 *    只表现为「不隐藏窗口」（仍是可用状态），反之误判成「有宿主」会让窗口藏起来后找不回来。
 *
 * ② **XDG 回收站可写性** —— 删除走 `trash` 包，它在 Linux 下**自己实现 XDG Trash**
 *    （`node_modules/trash/lib/linux.js`：xdg-trashdir + move-file + @stroncium/procfs），
 *    **不调用 gio / trash-cli**（只有 Windows 分支用 chunked-exec 调 powershell）。
 *    所以没有「外部命令缺失」可探测，真正会失败的是**回收站目录不可写**（只读 home、
 *    权限被改坏的 ~/.local/share）。本函数按 trash 包同一套规则解析目录并检查可写性。
 *    ⚠️ 覆盖面：只查 **home 设备**的回收站（`$XDG_DATA_HOME/Trash` 或 `~/.local/share/Trash`）。
 *    仓库放在外部挂载点时，trash 包按设备号改走 `<挂载点>/.Trash-<uid>`，本自检不覆盖那种情形
 *    （那种情形下失败会在删除时如实抛错，用户能看到「删除失败」）。
 */

/** 状态栏宿主的 D-Bus 名（KDE 定的规范名，GNOME 的 AppIndicator 扩展同样实现它） */
const STATUS_NOTIFIER_WATCHER = 'org.kde.StatusNotifierWatcher'

/** 探测超时：正常几十毫秒就返回；2s 是给「总线卡住」留的天花板，不能拖住启动 */
const PROBE_TIMEOUT_MS = 2000

let cachedHost: boolean | null = null

/** 已探测到的宿主结论（null = 尚未探测）；关窗语义是同步判据，只能读这个缓存 */
export function statusNotifierHostCached(): boolean | null {
  return cachedHost
}

/** 排障开关：`KNOWBASE_FORCE_TRAY=1` 强制按「有宿主」处理（探测本身出问题时的逃生门） */
function forceTrayRequested(): boolean {
  return process.env.KNOWBASE_FORCE_TRAY === '1'
}

/**
 * 探测状态栏宿主是否存在（结果缓存，重复调用不再起进程）。
 * 非 Linux 平台直接返回 false —— 调用方必须自行按平台分叉，别拿它当「通用托盘可用性」用。
 */
export async function detectStatusNotifierHost(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (cachedHost !== null) return cachedHost
  if (process.platform !== 'linux') {
    cachedHost = false
    return false
  }
  if (forceTrayRequested()) {
    cachedHost = true
    return true
  }
  cachedHost = await queryStatusNotifierHost(timeoutMs)
  return cachedHost
}

/** `gdbus call … NameHasOwner org.kde.StatusNotifierWatcher` → stdout 里带 true 即视为有宿主 */
function queryStatusNotifierHost(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'gdbus',
      [
        'call', '--session',
        '--dest', 'org.freedesktop.DBus',
        '--object-path', '/org/freedesktop/DBus',
        '--method', 'org.freedesktop.DBus.NameHasOwner',
        STATUS_NOTIFIER_WATCHER,
      ],
      { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
      (err, stdout) => {
        if (err) {
          // ENOENT（没装 gdbus）/ 无会话总线 / 超时，都按「没有宿主」处理，理由见文件头 ①
          console.warn('[Linux] 状态栏宿主探测失败，按「无宿主」处理：', (err as Error).message)
          resolve(false)
          return
        }
        resolve(/true/i.test(String(stdout)))
      },
    )
  })
}

export interface TrashCheck {
  ok: boolean
  /** 被检查的回收站目录（可能是尚未创建的路径） */
  dir: string
  /** 不可用时的原因（给告警明细用，人话） */
  reason?: string
}

/** 解析 home 设备的 XDG 回收站目录（与 trash 包的 xdg-trashdir 同规则；只取 home 设备那一份） */
export function xdgTrashDir(): string {
  const dataHome = process.env.XDG_DATA_HOME
  // XDG 规范：XDG_DATA_HOME 必须是绝对路径，否则视为未设置（相对路径会让回收站落在 CWD 下）
  const base = dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), '.local', 'share')
  return join(base, 'Trash')
}

/**
 * 回收站可用性自检：向上找到**最近的已存在祖先**检查可写性。
 * 不做 mkdir —— 自检不该有副作用（真正创建目录是 trash 包删除时的动作）。
 */
export function checkXdgTrash(): TrashCheck {
  const dir = xdgTrashDir()
  let probe = dir
  // 逐级上溯到已存在的祖先（正常情况下 ~/.local/share 一定存在）
  for (;;) {
    try {
      accessSync(probe, constants.W_OK)
      return { ok: true, dir }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        return { ok: false, dir, reason: `${probe} 不可写（${code || (e as Error).message}）` }
      }
    }
    const parent = join(probe, '..')
    if (parent === probe) return { ok: false, dir, reason: `无法解析可写的上级目录（自 ${dir} 上溯到根仍不可写）` }
    probe = parent
  }
}
