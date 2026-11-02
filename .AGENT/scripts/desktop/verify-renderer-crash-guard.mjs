/**
 * 契约：渲染进程崩溃兜底（v3.16.1 F-1）。
 *
 * 失败模式：透明无边框窗口在渲染进程 OOM 后没有内容可画，主进程却还活着；
 * 用户从托盘 / 任务栏唤起时，`show()` 把同一个死窗口重新显示出来 —— 只剩透明圆角框，
 * 看起来像「应用卡死」。此前 `render-process-gone` 只写日志，没有任何恢复动作。
 *
 * 本脚本锁：首次崩溃自动 reload、连续崩溃弹原生选择、唤起前检查崩溃态、二实例入口同源。
 *
 * 跑法：node .AGENT/scripts/desktop/verify-renderer-crash-guard.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const main = stripComments(readFileSync(join(repo, 'electron/main/index.ts'), 'utf8').replace(/\r\n/g, '\n'))

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. 崩溃恢复函数 ===')
ok(/function recoverCrashedRenderer\(win: BrowserWindow, trigger: 'crash' \| 'show'\)/.test(main),
  'A1 存在统一恢复入口 recoverCrashedRenderer')
ok(/const RENDERER_CRASH_WINDOW_MS = 60_000/.test(main), 'A2 连续崩溃判定窗口 = 60 秒')
ok(/if \(trigger === 'crash' && !repeated\)[\s\S]{0,260}?win\.webContents\.reload\(\)/.test(main),
  'A3 首次崩溃自动 reload 一次')
ok(/type: 'error'[\s\S]{0,260}?buttons: \['重启界面', '退出应用'\]/.test(main),
  'A4 连续崩溃弹原生对话框，提供重启 / 退出')
ok(/response === 1[\s\S]{0,120}?app\.quit\(\)/.test(main), 'A5 「退出应用」真正退出')
ok(/lastRendererCrashAt = 0[\s\S]{0,80}?win\.webContents\.reload\(\)/.test(main),
  'A6 用户选择重启后清零计数并 reload（避免下一次正常崩溃被误判为连续）')

console.log('\n=== B. 唤起入口先检查崩溃态 ===')
ok(/if \(mainWindow\.webContents\.isCrashed\(\)\)[\s\S]{0,120}?recoverCrashedRenderer\(mainWindow, 'show'\)/.test(main),
  'B1 showMainWindow 不再把死窗口直接 show() 出来')
ok(/if \(!win\.isVisible\(\)\) win\.show\(\)/.test(main), 'B2 恢复对话框前先让窗口可见')
ok(/app\.on\('second-instance', \(\) => \{[\s\S]{0,120}?showMainWindow\(\)/.test(main),
  'B3 第二实例 / 任务栏唤起走同一入口')

console.log('\n=== C. 崩溃事件接线 ===')
ok(/webContents\.on\('render-process-gone'[\s\S]{0,1200}?recoverCrashedRenderer\(win, 'crash'\)/.test(main),
  'C1 render-process-gone 触发恢复（中间可插入内存取证，不阻断恢复）')
ok(/if \(details\.reason === 'clean-exit'\) return/.test(main), 'C2 clean-exit 不触发恢复')
ok(/__kbLogRendererGone\?\.\(details\)/.test(main), 'C3 原有崩溃日志留痕保留')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
