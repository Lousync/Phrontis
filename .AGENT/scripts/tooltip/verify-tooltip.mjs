#!/usr/bin/env node
/**
 * 契约验证：悬停提示（Tooltip，2026-11-13）
 *
 * 为什么需要它：这套东西的错误全是**静默**的 ——
 *   ① 定位写反 / 忘了翻面 → 气泡跑到屏幕外，界面上只是「没提示」，不报错；
 *   ② 气泡吃指针事件 → 鼠标一碰就闪、点不到底下的按钮；
 *   ③ 退回原生 title → 又变成 1s 延迟 + 键盘不可达，肉眼只觉得「有点钝」；
 *   ④ 主题令牌被写死成字面色 → 插件主题下看不清（kbd 那次的同类事故）。
 *
 * 覆盖：
 *   §1 定位纯函数用例表（placeTooltip / parseTipKeys / tipAttrs）
 *   §2 组件与样式契约（宿主、令牌、指针事件、reduced-motion）
 *   §3 迁移面负向锁（试点文件不许再有原生 title=）
 *
 * 跑法（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/tooltip/verify-tooltip.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  placeTooltip, parseTipKeys, tipAttrs,
  TIP_OPEN_DELAY, TIP_GAP, TIP_EDGE, TIP_MAX_KEYS,
} from '../../../src/lib/tooltip.ts'
import {
  sanitizeTipPattern, sanitizeTipPatternSize, tooltipDeclarations, TIP_PATTERN_MAX,
} from '../../../src/lib/tooltipPattern.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`) }
}

const rect = (left, top, width, height) => ({
  left, top, right: left + width, bottom: top + height, width, height,
})
const VP = { width: 1280, height: 800 }

/* ================= §1 定位纯函数 ================= */
console.log('\n§1 placeTooltip / parseTipKeys / tipAttrs（纯函数）')

check('开启动画延迟为 120ms（与 HelpHint 同口径）', TIP_OPEN_DELAY === 120, String(TIP_OPEN_DELAY))

{
  const r = placeTooltip(rect(600, 300, 40, 24), { width: 200, height: 30 }, VP)
  check('上方有空间 → 朝上', r.place === 'top', JSON.stringify(r))
  check('水平居中对齐锚点', Math.abs(r.left + 100 - 620) <= 1, JSON.stringify(r))
  check('垂直与锚点留 gap', r.top === 300 - TIP_GAP - 30, JSON.stringify(r))
  check('箭头指回锚点中心', Math.abs(r.left + r.arrowX - 620) <= 1, JSON.stringify(r))
}

{
  const r = placeTooltip(rect(600, 4, 40, 24), { width: 200, height: 30 }, VP)
  check('贴顶放不下 → 翻到下方', r.place === 'bottom' && r.top === 4 + 24 + TIP_GAP, JSON.stringify(r))
}

{
  // 锚点中心 50，气泡被夹到 left=8 后箭头仍要指回 50（42 在圆角内侧，未被夹）
  const r = placeTooltip(rect(40, 400, 20, 20), { width: 300, height: 30 }, VP)
  check('左侧越界 → 夹回视口（left = edge）', r.left === TIP_EDGE, JSON.stringify(r))
  check('夹回后箭头仍指锚点中心', Math.abs(r.left + r.arrowX - 50) <= 1, JSON.stringify(r))
  check('箭头不会贴到圆角外', r.arrowX >= 14 && r.arrowX <= 300 - 14, JSON.stringify(r))
}

{
  const r = placeTooltip(rect(1260, 400, 20, 20), { width: 300, height: 30 }, VP)
  check('右侧越界 → 夹回视口', r.left === VP.width - TIP_EDGE - 300, JSON.stringify(r))
}

{
  const r = placeTooltip(rect(600, 380, 40, 20), { width: 200, height: 500 }, VP)
  check('上下都放不下 → 垂直钳制在视口内', r.top >= TIP_EDGE && r.top + 500 <= VP.height - TIP_EDGE + 0.001, JSON.stringify(r))
}

{
  const r = placeTooltip(rect(600, 300, 40, 24), { width: 200, height: 30 }, VP, { force: 'bottom' })
  check('force=bottom 时忽略翻面', r.place === 'bottom', JSON.stringify(r))
}

check('parseTipKeys 去空白 / 去空项', JSON.stringify(parseTipKeys(' Ctrl , Shift ,, P ')) === JSON.stringify(['Ctrl', 'Shift', 'P']))
check('parseTipKeys 限量 4 枚', parseTipKeys('A,B,C,D,E,F').length === TIP_MAX_KEYS)
check('parseTipKeys 空值返回空数组', parseTipKeys(null).length === 0 && parseTipKeys('').length === 0)
check('tipAttrs：只有文案时不出 data-keys', !('data-keys' in tipAttrs('复制')))
check('tipAttrs：键位逗号拼接', tipAttrs('打开命令面板', ['Ctrl', 'Shift', 'P'])['data-keys'] === 'Ctrl,Shift,P')

/* ================= §1b 插件图案校验 ================= */
console.log('\n§1b 插件图案（tooltip.pattern，只允许渐变）')

check('接受 radial-gradient 点阵', sanitizeTipPattern('radial-gradient(circle, rgba(255,255,255,.12) 1px, transparent 1.4px)') !== null)
check('接受 repeating-linear-gradient 扫描线', sanitizeTipPattern('repeating-linear-gradient(0deg, rgba(255,255,255,.035) 0 1px, transparent 1px 3px)') !== null)
check('接受 none（主题可显式清空）', sanitizeTipPattern('none') === 'none')
check('拒绝 url()', sanitizeTipPattern('url(https://evil.test/a.png)') === null)
check('拒绝 image-set()', sanitizeTipPattern('image-set(url(a.png) 1x)') === null)
check('拒绝声明注入（分号）', sanitizeTipPattern('linear-gradient(#fff, #000); background: url(x)') === null)
check('拒绝规则逃逸（花括号）', sanitizeTipPattern('linear-gradient(#fff, #000) } html { --x: 1') === null)
check('拒绝非渐变值', sanitizeTipPattern('#ff0000') === null)
check('拒绝括号不配平', sanitizeTipPattern('linear-gradient(#fff, #000') === null)
check(`拒绝超长（>${TIP_PATTERN_MAX}）`, sanitizeTipPattern('radial-gradient(' + 'a,'.repeat(250) + 'red)') === null)
check('尺寸接受 auto', sanitizeTipPatternSize('auto') === 'auto')
check('尺寸接受 9px 9px', sanitizeTipPatternSize('9px 9px') === '9px 9px')
check('尺寸拒绝注入', sanitizeTipPatternSize('9px; background:red') === null)
check('尺寸拒绝 calc / expression', sanitizeTipPatternSize('expression(alert(1))') === null)

{
  const decls = tooltipDeclarations({
    pattern: 'radial-gradient(circle, rgba(255,255,255,.12) 1px, transparent 1.4px)',
    patternSize: '9px 9px',
  })
  check('tooltipDeclarations 产出两行变量', decls.length === 2, JSON.stringify(decls))
  check('变量名写成 --tip-pattern / --tip-pattern-size',
    /--tip-pattern:/.test(decls[0]) && /--tip-pattern-size:/.test(decls[1]), JSON.stringify(decls))
  check('非法图案不产出变量', tooltipDeclarations({ pattern: 'url(a.png)' }).length === 0)
  check('非对象 / 数组安全跳过', tooltipDeclarations(null).length === 0 && tooltipDeclarations([]).length === 0)
}

/* ================= §2 组件与样式契约 ================= */
console.log('\n§2 宿主组件 / 样式令牌')

const host = read('src/components/shared/TooltipHost.tsx')
const css = read('src/styles/index.css')
const app = read('src/App.tsx')
const helpHint = read('src/components/shared/HelpHint.tsx')

check('宿主用事件委托，不逐元素包组件', /pointerover/.test(host) && /closest<HTMLElement>\('\[data-tip\]'\)/.test(host))
check('宿主消费 TIP_OPEN_DELAY（不再散落魔法数 120）', /TIP_OPEN_DELAY/.test(host) && !/setTimeout\([^,]+,\s*120\)/.test(host))
check('宿主 role="tooltip"', /role="tooltip"/.test(host))
check('鼠标点击产生的焦点不弹气泡（:focus-visible 闸门）', /matches\(':focus-visible'\)/.test(host))
check('宿主给锚点挂 aria-describedby，收起时还原', /aria-describedby/.test(host) && /removeAttribute\('aria-describedby'\)/.test(host))
check('宿主挂载在 App 根（全仓共用一份实例）', /<TooltipHost \/>/.test(app) && /import \{ TooltipHost \}/.test(app))
check('气泡不吃指针事件', /\.kb-tip \{[^}]*pointer-events: none/.test(css))
check('气泡只动 transform / opacity（不碰 width/height 动画）',
  /@keyframes kb-tip-in-up \{[^}]*opacity:[^}]*transform:/.test(css))
check('位置写 left/top，transform 留给进场动画', /left: pos\?\.left/.test(host) && /top: pos\?\.top/.test(host))
check('量完宽高才进场（data-ready）', /data-ready=\{pos \? '1' : '0'\}/.test(host))

for (const token of ['--tip-bg', '--tip-fg', '--tip-border-color', '--tip-radius', '--tip-shadow', '--tip-arrow']) {
  check(`令牌 ${token} 在 :root 里有默认值`, new RegExp(`${token}:`).test(css))
}
check('令牌引用既有色板，不写死字面色（--tip-bg）', /--tip-bg:\s*var\(--bg-tertiary\)/.test(css))
check('reduced-motion 清单包含气泡进场', /\.kb-tip\[data-ready="1"\], \.kb-tip-anim/.test(css))
check('HelpHint 复用同一套皮肤（不再自己写 bg/边框/阴影）',
  /kb-tip-surface/.test(helpHint) && !/bg-\[var\(--bg-tertiary\)\]/.test(helpHint) && !/shadow-lg/.test(helpHint))
check('HelpHint 进场与全局 Tooltip 同一套', /kb-tip-anim/.test(helpHint))
check('气泡消费 --tip-pattern（主题图案生效点）',
  /--tip-pattern: none/.test(css) && /background-image: var\(--tip-pattern, none\)/.test(css))
check('气泡消费 --tip-pattern-size', /--tip-pattern-size: auto/.test(css) && /background-size: var\(--tip-pattern-size, auto\)/.test(css))
{
  const svc = read('src/lib/pluginService.ts')
  check('插件主题接线 tooltipDeclarations', /tooltipDeclarations\(rec\?\.tooltip\)/.test(svc))
  check('图案变量拼进主题规则', /tipVars\.join\('\\n'\)/.test(svc))
}

/* ================= §3 迁移面 ================= */
console.log('\n§3 试点迁移（负向：不许退回原生 title）')

const MIGRATED = [
  'src/components/workbench/WorkbenchEmptyState.tsx',
  'src/components/workbench/PageTabStrip.tsx',
  'src/components/shared/pdf/PdfReaderView.tsx',
  'src/components/shared/epub/EpubReaderView.tsx',
  'src/components/shared/txt/TxtReaderView.tsx',
  'src/components/shared/TreeNewButton.tsx',
  'src/components/shared/TreeExpandButton.tsx',
  'src/components/shared/ActivityBar.tsx',
  'src/components/shared/WorkbenchStatusBar.tsx',
  'src/components/shared/AssistantPanel/index.tsx',
  'src/components/shared/AssistantPanel/ChatBody.tsx',
  'src/components/shared/AssistantPanel/MessageList.tsx',
  'src/components/shared/AssistantPanel/AiChatSidebar.tsx',
  'src/components/shared/AssistantPanel/QuoteChips.tsx',
  'src/components/shared/AssistantPanel/ImageCard.tsx',
  'src/components/shared/AssistantPanel/SessionPinButton.tsx',
  'src/components/shared/AssistantPanel/SessionRunMark.tsx',
  'src/components/shared/AssistantPanel/AssistantEntry.tsx',
  'src/components/shared/AssistantPanel/ProcessSummary.tsx',
  'src/components/shared/AssistantPanel/ProcessRail.tsx',
]
for (const rel of MIGRATED) {
  const src = read(rel)
  check(`${rel} 已无原生 title=`, !/(?<![-\w])title=/.test(src))
  check(`${rel} 已接入 data-tip`, /data-tip/.test(src))
}

{
  let tips = 0
  for (const rel of [
    'src/modules/settings/views/AiModelsTab.tsx',
    'src/modules/settings/views/AiToolsView.tsx',
    'src/modules/settings/views/BlogView.tsx',
    'src/modules/settings/views/IntelView.tsx',
    'src/modules/settings/views/AboutView.tsx',
    'src/modules/settings/views/SecurityView.tsx',
    'src/modules/settings/views/AiModelPicker.tsx',
    'src/modules/settings/components/RowMenu.tsx',
    'src/modules/settings/components/SettingsSearchBox.tsx',
    'src/modules/settings/components/fields/NumberField.tsx',
  ]) tips += (read(rel).match(/data-tip=/g) || []).length
  check('设置区 DOM 提示已迁移（≥ 35 处）', tips >= 35, String(tips))
  check('设置区的组件标题 prop 未被误改', /title="应用主题"/.test(read('src/modules/settings/views/AppearanceView.tsx')))
}

{
  let tips = 0
  for (const rel of [
    'src/modules/knowledge/components/PageEditor.tsx',
    'src/modules/knowledge/components/ChapterPanel.tsx',
    'src/modules/knowledge/components/QuizCollection.tsx',
    'src/modules/knowledge/components/NoteTopBar.tsx',
    'src/modules/knowledge/components/graph/GraphView.tsx',
  ]) tips += (read(rel).match(/data-tip=/g) || []).length
  check('知识库编辑器 / 章节 / 错题本 / 图谱的 DOM 提示已迁移（≥ 40 处）', tips >= 40, String(tips))
}

{
  let tips = 0
  for (const rel of ['src/modules/desktop/index.tsx', 'src/modules/dashboard/index.tsx', 'src/modules/recycle/index.tsx']) {
    tips += (read(rel).match(/data-tip=/g) || []).length
  }
  check('桌面 / 看板 / 回收站的 DOM 提示已迁移（≥ 25 处）', tips >= 25, String(tips))
}

{
  let tips = 0
  for (const rel of [
    'src/modules/moments/index.tsx',
    'src/modules/blog/index.tsx',
    'src/modules/bookmarket/DownloadQueue.tsx',
    'src/modules/accounting/index.tsx',
    'src/modules/usage/index.tsx',
    'src/modules/toolbox/components/PasswordVault.tsx',
  ]) tips += (read(rel).match(/data-tip=/g) || []).length
  check('说说 / 博客 / 书市 / 记账 / 用量 / 工具箱的 DOM 提示已迁移（≥ 80 处）', tips >= 80, String(tips))
}

{
  const src = read('src/modules/knowledge/index.tsx')
  check('知识库左栏：重点按钮 / 截断标签已迁移', (src.match(/data-tip=/g) || []).length >= 10)
  check('知识库左栏：组件 props 的 title 保持不变（FileMetaCard / ConfirmDialog）',
    /<FileMetaCard title=/.test(src) && /title="未保存的更改"/.test(src))
}

{
  const src = read('src/components/workbench/WorkbenchEmptyState.tsx')
  check('工作台空态：键位不再拼进括号串', /data-keys=\{h\.keys\.join\(','\)\}/.test(src) && !/join\(' \+ '\)/.test(src))
}

{
  // title 以前兼任图标按钮的无障碍名，换掉后必须显式补 aria-label
  for (const rel of [
    'src/components/shared/pdf/PdfReaderView.tsx',
    'src/components/shared/epub/EpubReaderView.tsx',
  ]) {
    const src = read(rel)
    const tips = (src.match(/data-tip=/g) || []).length
    const labels = (src.match(/aria-label=/g) || []).length
    check(`${rel} 图标按钮补齐 aria-label`, tips > 0 && labels >= tips, `tips=${tips} labels=${labels}`)
  }
  const txt = read('src/components/shared/txt/TxtReaderView.tsx')
  const tips = (txt.match(/data-tip=/g) || []).length
  const labels = (txt.match(/aria-label=/g) || []).length
  // TXT 有一处是正文 <mark> 的批注提示，不是按钮，不需要 aria-label
  check('TXT 阅读器：按钮都补齐 aria-label（正文批注除外）', tips > 0 && labels >= tips - 1, `tips=${tips} labels=${labels}`)
}

/* ================= §4 全仓完成度 ================= */
console.log('\n§4 全仓迁移完成度（负向：DOM 元素不许再有 title=）')

{
  const DOM_TAGS = new Set([
    'button','span','div','td','th','a','code','kbd','img','li','label','p','input','select','option',
    'i','b','strong','em','small','canvas','figure','h1','h2','h3','h4','section','tr','pre','table',
    'textarea','ul','ol','header','footer','nav','article','aside','main','dl','dt','dd',
  ])
  const files = readdirSync(join(ROOT, 'src'), { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.tsx'))
  const leftovers = []
  let tips = 0
  for (const rel of files) {
    const src = readFileSync(join(ROOT, 'src', rel), 'utf8')
    tips += (src.match(/data-tip=/g) || []).length
    for (const m of src.matchAll(/(?<![-\w])title=/g)) {
      const before = src.slice(0, m.index)
      const tag = /<\s*([A-Za-z0-9_.]+)/.exec(before.slice(before.lastIndexOf('<')))
      if (tag && DOM_TAGS.has(tag[1])) {
        const line = before.split('\n').length
        leftovers.push(`${rel}:${line} <${tag[1]}>`)
      }
    }
  }
  check('全仓 DOM 元素已无原生 title=', leftovers.length === 0, leftovers.slice(0, 6).join(' · '))
  check('data-tip 覆盖 ≥ 800 处', tips >= 800, String(tips))
}

/* ================= 汇总 ================= */
console.log(`\n结果：PASS ${pass} · FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
