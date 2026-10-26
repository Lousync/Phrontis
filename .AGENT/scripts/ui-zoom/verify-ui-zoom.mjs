/**
 * 契约脚本：界面缩放必须「整体等比」（v3.13.2，2026-10-26）
 *
 * 为什么需要它：
 *   2026-10 反馈「最大化后控件和字太小、画面很空」。根因是缩放实现只写了根字号
 *   （`documentElement.style.fontSize = zoom × 16px`），只能影响 rem；而全仓字号有
 *   2700+ 处 `text-[Npx]` 绝对像素，**一个都不会变大**。用户把设置从 100% 调到 120%
 *   看到的是留白变大、字没变，于是觉得「调了也没用」。
 *   结论：界面缩放必须走 Chromium 页面缩放（`webContents.setZoomFactor`），它连绝对 px、
 *   iframe 内容、画布一起等比放大；同时必须**删掉**渲染层那些「字号 × zoom」的补偿，
 *   否则两层缩放叠在一起（字号被放两次）。
 *
 * 这个脚本锁四件事：
 *   A 设置真源：默认 130%、范围 85–200、上限约束 2.0
 *   B 渲染层零残留：不许再出现根字号缩放，也不许再有 `字号 × zoom` 的补偿
 *   C 主进程唯一口径：三个窗口都在 dom-ready 后应用；设置变更即时生效；DIP/CSS 换算点按 zoom 折算
 *   D 迁移：老配置 120% → 130% 只做一次，且首屏提示存在
 *
 * 用法：node .AGENT/scripts/ui-zoom/verify-ui-zoom.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')
const code = (p) => stripComments(read(p))

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  return false
}

// ---------------------------------------------------------------- A 设置真源
const settingsSrc = code('src/lib/settings.ts')
const zoomLine = (settingsSrc.match(/^\s*zoom:\s*\{[^\n]*$/m) || [''])[0]
ok(/default:\s*1\.0\b/.test(zoomLine), 'A1 zoom 默认值应为 1.0（窗口态）', zoomLine.slice(0, 120))
ok(/min:\s*85\b/.test(zoomLine) && /max:\s*200\b/.test(zoomLine), 'A2 zoom 范围应为 85–200', zoomLine.slice(0, 120))
const zoomMaxLine = (settingsSrc.match(/^\s*zoomMax:\s*\{[^\n]*$/m) || [''])[0]
ok(/default:\s*2(\.0)?\b/.test(zoomMaxLine), 'A3 zoomMax 默认值应为 2.0', zoomMaxLine.slice(0, 120))
ok(/uiZoomMigrated:/.test(settingsSrc), 'A4 迁移标记 uiZoomMigrated 必须登记在 SETTINGS（否则 settings:set 白名单拦住写入）')
ok(/uiZoomNotice:/.test(settingsSrc), 'A5 迁移提示 uiZoomNotice 必须登记在 SETTINGS')
ok(/uiZoomMaximizedBoost:\s*\{[^\n]*default:\s*true/.test(settingsSrc), 'A5b 最大化自动放大开关 uiZoomMaximizedBoost 必须默认开启')
ok(/uiZoomMaximizedBoost:\s*\{[^\n]*ui:\s*true/.test(settingsSrc), 'A5c 最大化自动放大开关必须进设置页（ui:true）')
const generalSrc = code('src/modules/settings/views/GeneralView.tsx')
ok(
  /min=\{SETTINGS\.zoom\.min\}/.test(generalSrc) && /max=\{SETTINGS\.zoom\.max\}/.test(generalSrc) && /defaultValue=\{Math\.round\(SETTINGS\.zoom\.default \* 100\)\}/.test(generalSrc),
  'A6 设置页缩放范围/默认档必须读 SETTINGS（此前手写 max=150，抬到 200 后会被输入框挡回去）',
)

// ---------------------------------------------------------------- B 渲染层零残留
// B1 全仓 src 不许再改根字号做缩放（注释先剥掉 —— 说明文字里还写着旧实现）
const rootFontHits = []
for (const f of walkSourceFiles(`${ROOT}/src`)) {
  const text = stripComments(readFileSync(f, 'utf8'))
  text.split('\n').forEach((line, i) => {
    if (/documentElement\.style\.fontSize\s*=/.test(line)) {
      rootFontHits.push(`${f.replace(ROOT + '/', '')}:${i + 1}`)
    }
  })
}
ok(rootFontHits.length === 0, 'B1 渲染层不得再用根字号实现界面缩放', rootFontHits.join(', '))

// B2 字号补偿必须彻底删除（页面缩放已经放大过一次，再乘 zoom 就是两层）
const compensated = [
  ['src/modules/knowledge/components/PageEditor.tsx', /fontSize:\s*Math\.round\(s\.editorFontSize\s*\*\s*zoom\)/],
  ['src/modules/knowledge/components/PageEditor.tsx', /fontSize=\{Math\.round\(s\.editorFontSize\s*\*\s*zoom\)\}/],
  ['src/modules/knowledge/index.tsx', /Math\.round\(15\s*\*\s*zoom\)/],
  ['src/modules/blog/components/MarkdownEditor.tsx', /Math\.round\(s\.editorFontSize\s*\*\s*zoom\)/],
]
for (const [file, re] of compensated) {
  ok(!re.test(code(file)), `B2 ${file} 不得保留「字号 × zoom」补偿`, re.toString())
}

// B3 两个模块的 zoom 入参必须下线（留着必然被下一个人误用）
for (const file of ['src/modules/knowledge/index.tsx', 'src/modules/blog/index.tsx']) {
  ok(!/\bzoom\?: number/.test(code(file)), `B3 ${file} 不应再声明 zoom prop`)
}
ok(!/zoom=\{s\.zoom\}/.test(code('src/App.tsx')), 'B3 src/App.tsx 不应再把 zoom 传给模块')
ok(!/layoutKey=\{zoom\}/.test(code('src/modules/blog/components/MarkdownEditor.tsx')), 'B3 博文编辑器不应再用 zoom 当 layoutKey')

// B4 小窗渲染层不再自己算缩放
ok(!/\bzoom\b/.test(code('src/daypanel/DayPanelWindowApp.tsx')), 'B4 日程小窗渲染层不应再自行应用缩放')

// ---------------------------------------------------------------- C 主进程唯一口径
ok(existsSync(`${ROOT}/electron/main/uiZoom.ts`), 'C1 缺少 electron/main/uiZoom.ts 统一入口')
const uiZoom = code('electron/main/uiZoom.ts')
ok(/setZoomFactor\(/.test(uiZoom), 'C2 uiZoom.ts 必须调用 setZoomFactor')
ok(/UI_ZOOM_MIN\s*=\s*0\.85/.test(uiZoom) && /UI_ZOOM_MAX\s*=\s*2(\.0)?/.test(uiZoom), 'C3 主进程 clamp 与设置范围必须一致（0.85–2.0）')
ok(/MAXIMIZED_ZOOM_BOOST\s*=\s*1\.3/.test(uiZoom), 'C3b 最大化放大倍数必须是 1.3')
const boostNum = Number((uiZoom.match(/MAXIMIZED_ZOOM_BOOST\s*=\s*([\d.]+)/) || [])[1])
const baseNum = Number((settingsSrc.match(/^\s*zoom:\s*\{[^\n]*?default:\s*([\d.]+)/m) || [])[1])
ok(
  Math.round(baseNum * boostNum * 100) === 130,
  'C3d 校准：窗口态默认 100% × 最大化 1.3 必须等于 130%（用户实测两态都舒服的点）',
  `base=${baseNum} boost=${boostNum}`,
)

ok(/export function getEffectiveUiZoom/.test(uiZoom), 'C3c 必须提供有效缩放 getEffectiveUiZoom（基础档 × 最大化倍数）')
ok(/minSizeBases/.test(uiZoom) && /setMinimumSize\(\s*Math\.min\(Math\.round\(baseSize\.width \* f\)/.test(uiZoom), 'C4 最小窗口尺寸必须按缩放折算（DIP = 设计 CSS px × zoom）并夹到工作区')

const main = code('electron/main/index.ts')
ok(/from '\.\/uiZoom'/.test(main), 'C5 主进程未接入 uiZoom')
ok(/registerUiMinSize\(mainWindow, 900, 600\)/.test(main), 'C6 主窗必须登记设计最小尺寸 900×600')
ok(/on\('dom-ready', \(\) => applyUiZoomTo\(mainWindow\)\)/.test(main), 'C7 主窗必须在 dom-ready 后应用缩放（加载前设值会被导航覆盖）')
ok(/if \(key === 'zoom'\) setUiZoom\(value\)/.test(main), 'C8 settings:set 收到 zoom 必须立刻应用（不能等 500ms 落盘）')
ok(/setUiZoom\(settingsCache\['zoom'\]\)/.test(main), 'C9 启动时必须按已存设置应用一次')
ok(/setUiZoomBoostResolver\(\(win\) =>/.test(main), 'C9b 主进程必须注册「最大化是否放大」的判定')
ok(/if \(key === 'uiZoomMaximizedBoost'\) applyUiZoomToAll\(\)/.test(main), 'C9c 开关变更必须立刻重算所有窗口')
ok(/const scheduleZoomSync = \(\): void =>/.test(main), 'C9d 必须有几何落定后重算缩放的 scheduleZoomSync')
ok(/on\('resize', \(\) => \{ scheduleMaxSync\(\); scheduleZoomSync\(\) \}\)/.test(main), 'C9d2 resize 必须触发缩放重算（最大化 / 还原的几何变化靠它落定）')
ok(/on\('move', \(\) => \{ scheduleMaxSync\(\); scheduleZoomSync\(\) \}\)/.test(main), 'C9d3 move 必须触发缩放重算（跨屏 / 贴边）')
const sendMaxBlock = (main.match(/const sendMaxState = \([\s\S]*?\n  \}\n/) || [''])[0]
ok(!/applyUiZoomTo/.test(sendMaxBlock), 'C9d4 sendMaxState 不得直接应用缩放（乐观调用时 isMaximized/bounds 还是旧值，实测会把缩放留在反方向）')
ok(/scheduleMaxSync\(nextMax\)[\s\S]{0,200}scheduleZoomSync\(\)/.test(main), 'C9d5 window:maximize 切换后必须安排一次缩放重算')
ok(/isWinMaximized\(win\) \|\| coversWorkArea\(win\)/.test(main), 'C9d6 最大化判定必须含几何兜底（X11 实测存在铺满工作区但 isMaximized()=false 的窗口）')
ok(/on\('enter-full-screen',[\s\S]{0,200}scheduleZoomSync\(\)/.test(main), 'C9e 进入全屏必须重算有效缩放')
ok(/on\('leave-full-screen',[\s\S]{0,200}scheduleZoomSync\(\)/.test(main), 'C9f 退出全屏必须重算有效缩放')
ok(/const zoom = getEffectiveUiZoom\(win\)/.test(main), 'C10a 主窗的 CSS↔DIP 换算必须用有效缩放（含最大化倍数）')
ok(/const delta = Math\.round\(\(req - lastDrawerWidth\) \* zoom\)/.test(main), 'C10 侧栏撑宽必须把 CSS px 折算成 DIP')
ok(/Math\.round\(lastDrawerWidth \* zoom\)/.test(main), 'C11 侧栏收回同样要折算')
ok(/const minW = Math\.round\(MINW \* zoom\)/.test(main), 'C12 边缘拖拽最小宽度必须折算')

const day = code('electron/main/dayPanelWindow.ts')
ok(/from '\.\/uiZoom'/.test(day) && /applyUiZoomTo\(zoomWin\)/.test(day), 'C13 日程小窗必须在 dom-ready 后应用缩放')
ok(/Math\.round\(scrollW \* zoom\)/.test(day) && /Math\.round\(scrollH \* zoom\)/.test(day), 'C14 小窗内容尺寸（CSS px）必须折算成 DIP')

const fill = code('electron/main/passwordFiller.ts')
ok(/from '\.\/uiZoom'/.test(fill) && /applyUiZoomTo\(win\)/.test(fill), 'C15 密码悬浮窗必须跟随界面缩放')
ok(/Math\.round\(FILL_W \* zoom\)/.test(fill) && /Math\.round\(FILL_H \* zoom\)/.test(fill), 'C16 密码悬浮窗尺寸必须按缩放放大（否则内部布局被压扁）')

// ---------------------------------------------------------------- D 一次性迁移
ok(/Number\(settingsCache\['zoom'\]\) === 1\.2/.test(main), 'D1 迁移判据必须是「老配置恰好 120%」')
ok(/settingsCache\['uiZoomMigrated'\] = true/.test(main), 'D2 迁移必须打标记（用户以后手动改回 120% 不应再被抬走）')
ok(/settingsCache\['uiZoomNotice'\] = '1\.0'/.test(main), 'D3 迁移必须写首屏提示')
const app = code('src/App.tsx')
ok(/s\.uiZoomNotice/.test(app) && /update\('uiZoomNotice', ''\)/.test(app), 'D4 首屏必须消费并清空迁移提示（只弹一次）')

// ---------------------------------------------------------------- 汇总
if (fails.length === 0) {
  console.log(`PASS ui-zoom contract: ${pass} assertions`)
  process.exit(0)
}
console.log(`FAIL ui-zoom contract: ${fails.length} failed / ${pass} passed`)
for (const f of fails) console.log('  - ' + f)
process.exit(1)
