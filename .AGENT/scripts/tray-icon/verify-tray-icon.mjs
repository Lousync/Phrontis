/**
 * 契约脚本：托盘/任务栏图标装载（台账 F-3，2026-09-26）
 *
 * 缺陷面：① electron-builder files 配置只打包 out 目录 —— build/icon.png 不进 asar，
 * 安装版旧三个候选路径全部不存在 → 恒走兜底（紫方块）；② 无重试 —— 开机自启/杀软的瞬时
 * 读盘竞态没有兜底（「有时正常有时不正常」的候选解释）；③ 旧兜底是无意义紫色方块。
 *
 * 锁定：isPackaged 分叉候选 + extraResources 带出 icon.png + 有限重试 + 内嵌真图标兜底
 * （48px，从 build/icon.ico 抽帧）+ 托盘/任务栏同一事实源。
 *
 * 用法：node --experimental-strip-types .AGENT/scripts/tray-icon/verify-tray-icon.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('\n=== A. appIcon.ts 装载助手 ===')
const srcIcon = read('electron/lib/appIcon.ts')
ok(/export const ICON_FALLBACK_DATA_URL/.test(srcIcon) && /export function loadAppIconSync/.test(srcIcon)
  && /export async function loadAppIconWithRetry/.test(srcIcon),
  'A1 三个导出在位（兜底常量 / 单轮装载 / 有限重试装载）')
ok(/app\.isPackaged\s*\?\s*\[join\(resPath, 'icon\.png'\)/.test(srcIcon),
  'A2 候选按 isPackaged 分叉（打包首候选 = resourcesPath/icon.png，配合 extraResources）')
ok(/existsSync\(p\)/.test(srcIcon) && /!img\.isEmpty\(\)/.test(srcIcon),
  'A3 双重校验：存在性 + 非空图（createFromPath 对损坏文件返回空图而非抛错）')
ok(/for \(let i = 2; i <= attempts; i\+\+\)/.test(srcIcon) && /setTimeout\(r, delayMs\)/.test(srcIcon),
  'A4 有限重试在场（防启动期瞬时读盘竞态，全部失败也不抛错）')

console.log('\n=== B. 内嵌兜底是真应用图标 ===')
const m = srcIcon.match(/ICON_FALLBACK_DATA_URL =\s*\n([\s\S]*?)\n\nexport interface/)
ok(!!m, 'B1 兜底常量块存在')
if (m) {
  const b64 = m[1].match(/'([A-Za-z0-9+/=]+)'/g).map(s => s.slice(1, -1)).join('')
  ok(b64.length >= 3000, 'B2 兜底图标非玩具占位（base64 ≥3000 字符；旧紫方块仅 ~380）', `实际 ${b64.length}`)
  const buf = Buffer.from(b64, 'base64')
  ok(buf.length > 1000 && buf.readUInt32BE(0) === 0x89504e47, 'B3 解码后是合法 PNG（签名 89504E47）')
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
    ok(w === 48 && h === 48, 'B4 兜底图标 48×48（build/icon.ico 第三帧）', `${w}×${h}`)
  }
}

console.log('\n=== C. 主进程接线 ===')
const srcMain = read('electron/main/index.ts')
ok(/loadAppIconWithRetry\(4, 400/.test(srcMain) && /new Tray\(image\)/.test(srcMain),
  'C1 createTray 走 loadAppIconWithRetry（重试参数 4×400ms）')
ok(!/builtin placeholder/.test(srcMain) && !/iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf/.test(srcMain),
  'C2 负向：旧「内置 16px 彩色占位」与紫方块 base64 已清除')
ok(/icon: loadAppIconSync\(\)\.img/.test(srcMain),
  'C3 任务栏窗口图标走同一事实源（台账附注：修 F-3 两处同批，否则托盘好了任务栏还是白的）')
const pkg = JSON.parse(read('package.json'))
const iconRes = (pkg.build?.extraResources ?? []).some(r => r.from === 'build/icon.png' && r.to === 'icon.png')
ok(iconRes, 'C4 package.json extraResources 把 build/icon.png 带出到资源根（打包态候选 ① 成立的前提）')
ok(JSON.stringify(pkg.build?.files ?? []) === '["out/**/*"]',
  'C5 佐证：files 仍只打包 out/**（build/ 不进 asar —— 本条是根因链的一环，若将来改 files 需重审候选顺序）')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`❌ ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
