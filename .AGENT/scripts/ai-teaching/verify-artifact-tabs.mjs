/**
 * 契约：AI 教学工件栏页签条的溢出可达性（v3.16.1 F-3）。
 *
 * 失败模式：页签条自己 `overflow-x-auto` + 隐藏滚动条，但没有滚轮横滚 / 渐隐 / 激活归位，
 * 鼠标用户够不到被裁掉的页签；更糟的是 ⤢ 全屏按钮和页签在同一个滚动容器里，页签一多
 * 按钮跟着滚出视野（功能入口直接消失）。
 *
 * 修法：复用页面条的 `useStripScroll` + `StripEdges`，并把固定动作移出滚动容器。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-artifact-tabs.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => stripComments(readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n'))

const pane = read('src/modules/ai-teaching/ArtifactsPane.tsx')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. 复用页面条溢出基建 ===')
ok(/import \{ useStripScroll, StripEdges \} from '\.\.\/\.\.\/components\/workbench\/useStripScroll'/.test(pane),
  'A1 import useStripScroll / StripEdges')
ok(/const strip = useStripScroll\(`\$\{activeId \?\? ''\}\|\$\{tabs\.length\}`\)/.test(pane),
  'A2 revealKey = 激活页签 + 页签数（切换 / 新增都会归位）')
ok(/ref=\{setStripNode\}/.test(pane) && /strip\.setNode\(node\)/.test(pane),
  'A3 滚动容器挂 setStripNode（同时喂给 useStripScroll 与溢出计数）')
ok(/<StripEdges edges=\{strip\.edges\} \/>/.test(pane), 'A4 渲染左右渐隐')
ok(/kb-edge-strip/.test(pane), 'A5 滚动容器走 .kb-edge-strip（隐藏滚动条，渐隐替代提示）')
ok(/data-wb-active=\{t\.id === activeId \? '1' : '0'\}/.test(pane),
  'A6 每个页签带 data-wb-active（useStripScroll 的激活选择器契约）')

console.log('\n=== B. 固定动作与可滚内容分离 ===')
ok(!/flex-1 min-w-\[8px\]/.test(pane), 'B1 旧的 flex-1 占位已删除（它会把 ⤢ 推进滚动区）')
{
  // 结构顺序：滚动容器 → StripEdges → 全部页签按钮 → ⤢；后两者都在滚动容器外
  const iEdges = pane.indexOf('<StripEdges edges={strip.edges} />')
  const iAllTabs = pane.indexOf('ref={allTabsBtnRef}')
  const iExpand = pane.indexOf('{tab && !tab.generating && tab.rel && (')
  ok(iEdges > 0 && iAllTabs > iEdges && iExpand > iAllTabs,
    'B2 ⤢ / 全部页签按钮都位于滚动容器与 StripEdges 之后（结构上不参与横向滚动）')
}
ok(/className="shrink-0 flex items-center gap-0\.5 px-2 pt-1\.5 pb-0 select-none"/.test(pane),
  'B3 页签行外层只负责左右布局，不再自己 overflow-x-auto')
ok(!/overflow-x-auto[^"]*\[scrollbar-width:none\]/.test(pane),
  'B4 负向：不再使用「隐藏滚动条且无提示」的裸滚动容器')

console.log('\n=== C. 行为口径（纯函数契约由 verify-strip-overflow 覆盖）===')
ok(/items-center gap-0\.5 overflow-x-auto/.test(pane), 'C1 滚动容器保留 flex 单行不换行')
ok(/const tabMaxWidth = widthPx < 300 \? 96 : widthPx < 420 \? 132 : 170/.test(pane)
  && /style=\{\{ maxWidth: tabMaxWidth \}\}/.test(pane),
  'C2 页签宽度按分栏宽度自适应（窄分栏 96 / 132，正常 170）')

console.log('\n=== D. 全部页签下拉（P1） ===')
ok(/useAnchoredMenu\(allTabsBtnRef, allTabsMenuRef, 248\)/.test(pane),
  'D1 「全部页签」按钮锚定弹出（useAnchoredMenu，视口钳位 / 外部点击关闭）')
ok(/全部页签 · \{tabs\.length\}/.test(pane) && /\{tabs\.map\(t => \(/.test(pane),
  'D2 下拉列出全部页签（不是只列被裁掉的）')
ok(/onClick=\{\(\) => \{ onActivate\(t\.id\); allTabsMenu\.close\(\) \}\}/.test(pane),
  'D3 点条目 = 激活该页签并收起菜单')
ok(/<Check size=\{10\} className="shrink-0 text-\[var\(--accent\)\]" \/>/.test(pane),
  'D4 当前激活页签在列表里有对勾')
ok(/const \[hiddenTabs, setHiddenTabs\] = useState\(0\)/.test(pane)
  && /r\.left < cr\.left - 1 \|\| r\.right > cr\.right \+ 1/.test(pane),
  'D5 溢出计数按真实矩形测量「完全滚出可视区」的页签数')
ok(/\{hiddenTabs > 0 && \([\s\S]{0,200}?>\+\{hiddenTabs\}<\/span>/.test(pane),
  'D6 有溢出时按钮上直接显示未显示数量（不只靠 tooltip）')
ok(/hiddenTabs > 0 \? `，\$\{hiddenTabs\} 个未显示` : ''/.test(pane),
  'D7 tooltip 带「共 N 个 / M 个未显示」的完整口径')

console.log('\n=== E. 页签右键菜单（P1） ===')
ok(/onContextMenu=\{e => \{ e\.preventDefault\(\); e\.stopPropagation\(\); setTabMenu\(/.test(pane),
  'E1 页签右键打开菜单并阻止冒泡')
ok(/<FileContextMenu x=\{tabMenu\.x\} y=\{tabMenu\.y\} items=\{tabMenuItems\}/.test(pane),
  'E2 复用共享 FileContextMenu（视口钳位 / Esc / 外部点击）')
for (const [label, re] of [
  ['关闭', /key: 'close', label: '关闭'/],
  ['关闭其他', /key: 'others', label: others\.length \? `关闭其他（\$\{others\.length\}）`/],
  ['关闭右侧', /key: 'right', label: right\.length \? `关闭右侧（\$\{right\.length\}）`/],
  ['全部关闭', /key: 'all', label: all\.length \? `全部关闭（\$\{all\.length\}）`/],
]) ok(re.test(pane), `E3 菜单项：${label}`)
ok(/const canClose = \(t: ArtTab\) => !t\.generating/.test(pane),
  'E4 生成中的页签不参与批量关闭（与单页签 ✕ 禁关同一口径）')
{
  // 批量关闭会在同一 tick 连续调 closeArtTab；只靠 effect 回填 artTabsRef 时后一次读到旧数组，
  // setState 互相覆盖 → 表象「全部关闭只关掉一个」。
  const teachIndex = read('src/modules/ai-teaching/index.tsx')
  ok(/artTabsRef\.current = nextTabs[\s\S]{0,80}?setArtTabs\(nextTabs\)/.test(teachIndex),
    'E5 closeArtTab 同步回填 artTabsRef（批量关闭不会互相覆盖）')
}

console.log('\n=== F. 同类哨兵：隐藏滚动条的条目条必须接 useStripScroll ===')
{
  // `.kb-edge-strip` 把滚动条藏掉是为了不占盒高；代价是「看不出能滚」。
  // 任何新条目条使用它，就必须同时给滚轮接管 + 渐隐 + 激活归位，否则又回到 F-3 的老路。
  const offenders = []
  for (const file of walkSourceFiles(join(repo, 'src'), { exts: ['.tsx'] })) {
    if (file.endsWith('useStripScroll.tsx')) continue // 基建自己
    const src = stripComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    if (!src.includes('kb-edge-strip')) continue
    const wired = /useStripScroll\(/.test(src) && /ref=\{[^}]*set(?:Strip)?Node[^}]*\}/.test(src) && /<StripEdges/.test(src)
    if (!wired) offenders.push(file.slice(repo.length + 1))
  }
  ok(offenders.length === 0,
    'F1 所有 `.kb-edge-strip` 条目条都接了 useStripScroll（setNode + StripEdges）',
    offenders.join('、'))
}

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
