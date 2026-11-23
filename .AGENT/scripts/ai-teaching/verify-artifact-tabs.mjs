/**
 * 契约：右侧查看器页签条的溢出可达性（原工件栏 F-3 契约，2026-11-23 迁到 ViewerChrome）。
 *
 * 失败模式（原样保留）：页签条自己 `overflow-x-auto` + 隐藏滚动条，但没有滚轮接管 / 渐隐 /
 * 激活归位，鼠标用户够不到被裁掉的页签；更糟的是固定动作（`+` / `⤢` / `×`）和页签在同一个
 * 滚动容器里，页签一多按钮跟着滚出视野（功能入口直接消失）。
 *
 * 现在页签条在 `right-viewer/ViewerChrome.tsx`：溢出判定用 `stripOverflow`（纯函数，见
 * verify-right-viewer-tabs.mjs），溢出时右缘 `mask-image` 渐隐；固定动作在滚动容器**之外**。
 * 工件栏（ArtifactsPane）退役后本脚本不再读它，只锁查看器这一份实现。
 *
 * 跑法：node .AGENT/scripts/ai-teaching/verify-artifact-tabs.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments, walkSourceFiles } from '../shared/strip-comments.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const read = (p) => stripComments(readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n'))

const chrome = read('src/modules/ai-teaching/right-viewer/ViewerChrome.tsx')
const shell = read('src/modules/ai-teaching/right-viewer/RightViewer.tsx')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  → ' + detail : ''))
  return false
}

console.log('=== A. 复用页签条溢出基建（stripOverflow + 实测宽度） ===')
ok(/import \{[\s\S]{0,300}?stripOverflow,[\s\S]{0,300}?\} from '\.\/viewerTabs'/.test(chrome)
  && /stripOverflow\(widths, el\.clientWidth, 1\)\.overflowing/.test(chrome),
  'A1 overflow 判定走 viewerTabs 的 stripOverflow（不手写阈值）')
ok(/const measure = \(\) => \{[\s\S]{0,300}?setOverflowing/.test(chrome)
  && /new ResizeObserver\(measure\)/.test(chrome) && /ro\.observe\(el\)/.test(chrome),
  'A2 按实测宽度采样（ResizeObserver 跟面板拖宽）')
ok(/style=\{overflowing \? \{[\s\S]{0,240}?maskImage: 'linear-gradient\(to right/.test(chrome),
  'A3 溢出时右缘 mask-image 渐隐（不明显裁掉页签名）')
ok(/overflow-x-auto/.test(chrome) && /\[scrollbar-width:none\]/.test(chrome) && /\[&::-webkit-scrollbar\]:hidden/.test(chrome),
  'A4 滚动容器：overflow-x-auto + 隐藏滚动条（靠渐隐 / 下拉替代提示）')
ok(/if \(e\.key === 'ArrowRight'\)/.test(chrome) && /e\.key === 'ArrowLeft'/.test(chrome)
  && /e\.key === 'Home'/.test(chrome) && /e\.key === 'End'/.test(chrome),
  'A5 键盘 ←/→/Home/End 在页签间移动（含循环）')
ok(/tabRefs\.current\[activeId\]\?\.scrollIntoView\(\{ inline: 'nearest'/.test(chrome),
  'A6 激活页签自动滚进视野（8+ 页签仍能找回）')
ok(/const listButton = \(/.test(chrome) && /narrow \|\| overflowing \? '' : 'hidden'/.test(chrome),
  'A7 「全部页签」入口在窄头部或溢出时可见（不靠隐藏滚动条猜）')

console.log('\n=== B. 固定动作与可滚内容分离 ===')
ok(!/flex-1 min-w-\[8px\]/.test(chrome), 'B1 旧的 flex-1 占位不再出现（它会把固定动作推进滚动区）')
{
  // 渲染顺序：滚动容器（role="tablist"）→ 全部页签 → + → ⤢ → ×
  const iStrip = chrome.indexOf('role="tablist"')
  const iList = chrome.indexOf('{!narrow && listButton}')
  const iPlus = chrome.indexOf('{plusButton}')
  const iExpand = chrome.indexOf('{expandButton}')
  const iClose = chrome.indexOf('{closePanelButton}')
  ok(iStrip > 0 && iList > iStrip && iPlus > iList && iExpand > iPlus && iClose > iExpand,
    'B2 滚动容器 → 全部页签 → + → ⤢ → × 的结构顺序（后四者不参与横向滚动）',
    `strip@${iStrip} / list@${iList} / plus@${iPlus} / expand@${iExpand} / close@${iClose}`)
}
{
  // 滚动容器的子元素只能是页签本身（固定动作若挂在里面就会跟着滚走）
  const iStrip = chrome.indexOf('role="tablist"')
  const iList = chrome.indexOf('{!narrow && listButton}')
  const block = iStrip >= 0 && iList > iStrip ? chrome.slice(iStrip, iList) : ''
  ok(block.length > 100 && block.includes('tabs.map((t) => renderTab(t))')
    && !block.includes('iconBtnCls') && !block.includes('plusButton'),
    'B3 滚动容器内部只挂页签（没有 + / ⤢ / × 混进去）')
}
ok(/const iconBtnCls = 'flex h-6 w-6 shrink-0/.test(chrome)
  && /const plusButton = \(/.test(chrome) && /const expandButton = \(/.test(chrome)
  && /const closePanelButton = \(/.test(chrome),
  'B4 三枚固定动作各自是头部常量（与页签条生命周期解耦）')
ok(/const listButton = \(/.test(chrome)
  && /aria-label=\{`切换页签：\$\{tabTitleOf\(activeTab\)\}`\}/.test(chrome),
  'B5 窄头部把当前页签名本身做成下拉入口（固定动作仍在条外）')

console.log('\n=== C. 溢出兜底：全部页签下拉（列出全部，不只被裁掉的） ===')
ok(/const \[menu, setMenu\] = useState<MenuKind>\('none'\)/.test(chrome) && /openMenu\('tablist'\)/.test(chrome),
  'C1 头部菜单状态机（tablist 与新建菜单互斥）')
ok(/aria-haspopup="dialog"[\s\S]{0,300}?aria-expanded=\{menu === 'tablist'\}/.test(chrome),
  'C2 「全部页签」按钮 aria-haspopup + aria-expanded 接线')
ok(/tabs\.map\(\(t\) => renderTab\(t, true\)\)/.test(chrome), 'C3 下拉列出全部页签')
ok(/onClick=\{\(\) => \{ setMenu\('none'\); onSelect\(tab\.id\) \}\}/.test(chrome)
  && /onCloseTab\(tab\.id\)/.test(chrome),
  'C4 点条目 = 激活该页签并收起菜单（行内 ✕ 仍可关）')
ok(/aria-selected=\{active\}/.test(chrome) && /max-h-\[330px\] overflow-y-auto/.test(chrome),
  'C5 列表带选中态 + 高度上限（长列表自己滚）')

console.log('\n=== D. 工件栏已退役：查看器是唯一页签条 ===')
ok(!shell.includes('ArtifactsPane') && !shell.includes('artTabs'), 'D1 RightViewer 不再挂工件栏')
ok(!chrome.includes('ArtTab') && !chrome.includes('ArtifactsPane'), 'D2 ViewerChrome 不引用工件栏类型')
ok(!existsSync(join(repo, 'src/modules/ai-teaching/ArtifactsPane.tsx'))
  && !existsSync(join(repo, 'src/modules/ai-teaching/artifacts.ts')),
  'D3 工件栏两个文件已删除（不存在第二份页签条实现）')
ok((chrome.match(/overflow-x-auto/g) || []).length === 1,
  'D4 模块内只有一处裸横向滚动容器（其余横向条不得回潮）',
  `实际 ${(chrome.match(/overflow-x-auto/g) || []).length}`)

console.log('\n=== E. 固定动作自身可辨识（窄头部 / 图标态仍有 aria-label） ===')
ok(/aria-label="新建页签"/.test(chrome) && /aria-label="全部页签"/.test(chrome)
  && /aria-label="关闭面板"/.test(chrome)
  && /aria-label=\{expanded \? '退出全屏' : '全屏'\}/.test(chrome),
  'E1 + / ⌄ / ⤢ / × 四枚固定动作都有 aria-label（图标没有可见文字）')
ok(/data-viewer-menu-trigger="1"/.test(chrome) && /onMenuOpenChange\(menu !== 'none'\)/.test(chrome),
  'E2 弹层开合上报壳（网页原生视图据此让位）')

console.log('\n=== F. 同类哨兵：隐藏滚动条的条目条必须接溢出基建 ===')
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

console.log('\n=== G. 核心不变量：固定动作不随内容滚走 ===')
ok(/className="flex min-w-0 flex-1 items-center gap-px overflow-x-auto/.test(chrome),
  'G1 滚动容器只吃剩余宽度（min-w-0 flex-1），固定动作宽度不被挤掉')
ok(/\{!narrow && listButton\}[\s\S]{0,200}?\{plusButton\}[\s\S]{0,200}?\{expandButton\}[\s\S]{0,200}?\{closePanelButton\}/.test(chrome),
  'G2 四枚固定动作连排在滚动容器之后（页签再多也固定在右端）')

console.log('\n========================================')
if (fails.length === 0) {
  console.log(`[OK] 全部通过：${pass} 项断言 PASS`)
} else {
  console.log(`[FAIL] ${fails.length} 项 FAIL（另有 ${pass} 项 PASS）`)
  for (const f of fails) console.log('   · ' + f)
  process.exit(1)
}
