/**
 * 契约脚本：文件树右键菜单（对齐 Obsidian + 宽度自适应 + 目录搜索弹层）
 * 设计：`docs/file-menu-rework-design.md` · 原型：`tmp/file-menu-proto/index.html`（568 行，可交互）
 *
 * 覆盖的缺陷面（每条都是「不报错但坏掉」的类型）：
 *   ① **宽度地板回来** —— 面板是 shrink-to-fit，再长出 `min-w` 就是那条约 85px 的右侧死区；
 *   ② **二级面板开错边** —— 同一颗组件既服务左栏文件树（往右开没事）也服务贴窗口右缘的菜单
 *      ⇒ 写死一边必然有一处出屏（编辑器右键菜单已为同类问题修过一次，见 notes-surface C13）；
 *   ③ **目录搜索弹层把文件移进自己** —— 不排除「源目录自身及其子孙」会成环；不排除「当前所在目录」
 *      则是「移了等于没移」，用户点完看不出任何变化；
 *   ④ **「新建 / 粘贴」又爬回文件条目** —— 本批的拍板就是把它只留给文件夹与空白处；
 *   ⑤ **剪贴板口径回退** —— 批 1 定的是「渲染层不直连 navigator.clipboard，走主进程 copyText」，
 *      这次反正要改「复制路径」那行，改回去就是口径漂移；
 *   ⑥ **范围外溢** —— AI 教学文件树与总览零散文件**本轮不动**，被顺手改了就是超范围。
 *
 * 用法：
 *   node .AGENT/scripts/file-menu/verify-file-menu.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
/** 负向断言必须走剥注释版，否则**说明文字会被当成真实代码**（见 shared/strip-comments.mjs 头注） */
const code = (p) => stripComments(read(p))

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  return false
}

const MENU = code('src/components/shared/FileContextMenu.tsx')
const PICKER = code('src/components/shared/DirPicker.tsx')
const KNOW = code('src/modules/knowledge/index.tsx')
const WTREE = code('src/components/workbench/WorkbenchFileTree.tsx')
const TEACH = code('src/modules/ai-teaching/AiTeachFileTree.tsx')
const LEFT = code('src/components/workbench/WorkbenchLeftPanel.tsx')
const CSS = code('src/styles/index.css')
const SHELL_VERIFY = read('.AGENT/scripts/workbench-shell/verify-workbench-shell.mjs')
const PASTE_VERIFY = read('.AGENT/scripts/editor/verify-paste-external.mjs')
const TEACH_VERIFY = read('.AGENT/scripts/ai-teaching/verify-teach-tree-inline.mjs')

// ===================== A 组：面板宽度与二级面板选边 =====================

console.log('\n=== A. FileContextMenu：宽度自适应 + 二级选边 ===')
ok(!/min-w-\[216px\]/.test(MENU) && !/min-w-\[216px\]/.test(CSS),
  'A1 负向：`min-w-[216px]` 硬地板已删（它就是那条约 85px 右侧死区的成因）')
ok(/max-w-\[300px\]/.test(MENU), 'A2 上限保留（超长标签仍走 truncate，不撑破屏幕）')
ok(/const SUB_W = 240/.test(MENU) && /setSide\(/.test(MENU),
  'A3 二级面板按可用空间选边（SUB_W 预估宽 + setSide）')
ok(/window\.innerWidth - \(left \+ r\.width\) < SUB_W/.test(MENU),
  'A4 判据 = 面板右缘到视口右缘的剩余空间（不是面板自身的宽度）')
ok(/side === 'left'\s*\?\s*\{ right: 'calc\(100% \+ 4px\)'/.test(MENU) && /data-sub-side=\{side\}/.test(MENU),
  'A5 往左开走 right、往右开走 left，并留 data-sub-side 供探针断言')
ok(/const over = r\.bottom - \(window\.innerHeight - 8\)/.test(MENU) && /setSubShift\(over\)/.test(MENU),
  'A6 二级面板贴底时上移（编辑器右键菜单已为同类问题修过一次，不重犯）')

console.log('\n=== B. 两个新字段与两种展开时机 ===')
ok(/submenu\?: Array<\{ label: string; onSelect: \(\) => void \}>/.test(MENU), 'B1 FileMenuItem 有 submenu 字段')
ok(/popover\?: ReactNode/.test(MENU), 'B2 FileMenuItem 有 popover 字段（任意二级内容）')
ok(/onMouseEnter=\{\(\) => \{ if \(it\.submenu && !it\.disabled\) setOpenKey\(it\.key\) \}\}/.test(MENU),
  'B3 submenu **悬停即开**（照 Obsidian「复制路径 ▸」）')
ok(/if \(it\.submenu \|\| it\.popover\) \{ setOpenKey\(\(k\) => \(k === it\.key \? null : it\.key\)\); return \}/.test(MENU),
  'B4 popover **点击才开**（里面有输入框，悬停开会没法用）；且不会顺手关掉整个菜单')
ok(/fixed inset-0 z-\[70\] kb-pop-layer/.test(MENU) && /document\.body,/.test(MENU),
  'B5 仍是 portal 到 body 的 fixed 层（左栏变换容器会改写 fixed 包含块 —— 历史坑）')
ok(/if \(e\.key === 'Escape'\) onClose\(\)/.test(MENU), 'B6 Esc 仍能关整个菜单')
ok(!/\sw-\[\d+px\]/.test(MENU),
  'B7 负向：面板没有写死宽度（shrink-to-fit 的前提 —— 补一个固定 w 等于把地板换个写法加回来）',
  '注意判据要 `\\sw-`：`max-w-[300px]` 里也含 `w-[300px]` 子串，不加前导空格会假失败')

// ===================== C 组：目录搜索弹层 =====================

console.log('\n=== C. DirPicker（「将文件移动到…」的落点选择）===')
ok(/loadTreeSubtree\(rid, ''\)/.test(PICKER),
  'C1 数据源 = loadTreeSubtree（已带 2000 目录上限与 truncated 标记，不另造递归）')
ok(/rootId \|\| \(await workspaceGetCurrent\(\)\.then\(\(c\) => c\?\.rootId\)/.test(PICKER),
  'C2 rootId 可省 —— 宿主只有异步 ensureVaultRoot 时自己解析（否则得为了一个 prop 造同步真源）')
ok(/if \(rel === sameDir\) continue/.test(PICKER),
  'C3 ★ 排除「源文件当前所在目录」（移过去是空操作，用户点完看不出变化）')
ok(/if \(selfIsDir && \(rel === sourceRel \|\| rel\.startsWith\(sourceRel \+ '\/'\)\)\) continue/.test(PICKER),
  'C4 ★ 源是目录时排除自身及其全部子孙（否则会移进自己 / 成环）')
ok(/e\.key === 'ArrowDown'/.test(PICKER) && /e\.key === 'ArrowUp'/.test(PICKER) && /e\.key === 'Enter'/.test(PICKER) && /e\.key === 'Escape'/.test(PICKER),
  'C5 键盘四件齐（↑↓ 选择 / Enter 确认 / Esc 取消）')
ok(/正在读取目录…/.test(PICKER), 'C6 加载态（不是空白面板）')
ok(/没有匹配的目录/.test(PICKER) && /仓库里没有可作为目标的目录/.test(PICKER),
  'C7 两种空态分开报：筛不到 vs 仓库里根本没有可选目录')
ok(/目录过多，已截断到 2000 个/.test(PICKER), 'C8 truncated 时明确告知（不静默少列）')
ok(/data-wb="dirPicker"/.test(PICKER), 'C9 稳定锚点 dirPicker（探针用）')
ok(/out\.sort\(\(a, b\) => \(a\.rel < b\.rel/.test(PICKER),
  'C10 字典序排序即层级序（\'/\' 码位小于字母 ⇒ 父目录恒在子目录之前）')

// ===================== D 组：知识库文件树（宿主一）=====================

console.log('\n=== D. 知识库文件树：文件条目只放「对这个文件做什么」===')
{
  // 文件分支必须**提前 return**，否则会掉进目录/空白处那段（新建 + 粘贴）。
  // ★ 锚点只能用**代码**：KNOW 是剥注释版，拿注释当锚点会 indexOf = -1（第一版就踩了这个）。
  const fileAt = KNOW.indexOf("if (self && self.type === 'file') {")
  const dirAt = KNOW.indexOf("key: 'newFile'", fileAt)
  ok(fileAt > -1 && dirAt > fileAt, 'D1 文件分支存在且排在目录/空白处分支之前', `file@${fileAt} dir@${dirAt}`)
  const fileBranch = fileAt > -1 && dirAt > fileAt ? KNOW.slice(fileAt, dirAt) : ''
  for (const k of ['open', 'dup', 'moveTo', 'copyPath', 'openSys', 'reveal', 'rename', 'delete']) {
    ok(fileBranch.includes(`key: '${k}'`), `D2 文件条目含 ${k}`)
  }
  ok(!/key: 'newFile'|key: 'newDir'|key: 'newCat'|key: 'paste'/.test(fileBranch),
    'D3 ★ 负向：文件条目里**没有**「新建 / 粘贴」（只留给文件夹与空白处 —— 本批拍板）')
  ok(/key: 'moveTo'[\s\S]{0,200}?<DirPicker/.test(fileBranch), 'D4 「将文件移动到…」挂的是目录搜索弹层')
  ok(/key: 'copyPath'[\s\S]{0,160}?submenu: \[[\s\S]{0,220}?copyPathText\(self\.relPath, 'rel'\)[\s\S]{0,140}?copyPathText\(self\.relPath, 'abs'\)/.test(fileBranch),
    'D5 「复制路径 ▸」二级两档：仓库相对路径 / 完整路径')
  ok(/handleTreeMove\(self\.relPath, dst\)/.test(fileBranch),
    'D6 落盘复用既有 handleTreeMove（→ workspaceRename），不新写通道')
}
{
  // 目录 / 空白处分支保持原样：从它那条 newFile 起截一段
  const dirAt = KNOW.indexOf("key: 'newFile'")
  const dirBranch = dirAt > -1 ? KNOW.slice(dirAt, dirAt + 2600) : ''
  for (const k of ['newFile', 'newDir', 'newCat', 'paste', 'expandDir', 'collapseDir', 'rename', 'delete']) {
    ok(dirBranch.includes(`key: '${k}'`), `D7 目录 / 空白处条目仍含 ${k}`)
  }
}
ok(/const copyPathText = useCallback\(async \(rel: string, mode: 'abs' \| 'rel'\)/.test(KNOW)
  && /await copyPathText\(rel, mode\)/.test(KNOW),
  'D8 复制路径抽成 copyPathText，handleCopyPath 委托它（一个落点，两处消费）')
ok(/const ok = await copyText\(text\)/.test(KNOW) && !/navigator\.clipboard\.writeText\(text\)/.test(KNOW),
  'D9 ★ 走主进程剪贴板通道 copyText（批 1 口径：渲染层不直连 navigator.clipboard）')
ok(/const openTreeInSystem = useCallback\(async \(rel: string, reveal: boolean\)/.test(KNOW)
  && /workspaceOpenInSystem\(root, rel, reveal\)/.test(KNOW),
  'D10 「使用默认应用打开 / 在系统资源管理器中显示」复用主进程 workspaceOpenInSystem（reveal 分流）')

// ===================== E 组：工作台文件树（宿主二）=====================

console.log('\n=== E. 工作台文件树 ===')
{
  const fileAt = WTREE.indexOf("if (node.type === 'file') {")
  const dirAt = WTREE.indexOf("key: 'newFile'", fileAt)
  ok(fileAt > -1 && dirAt > fileAt, 'E1 文件分支存在且排在目录分支之前', `file@${fileAt} dir@${dirAt}`)
  const fileBranch = fileAt > -1 && dirAt > fileAt ? WTREE.slice(fileAt, dirAt) : ''
  for (const k of ['dup', 'moveTo', 'copyPath', 'openSys', 'reveal', 'rename', 'delete']) {
    ok(fileBranch.includes(`key: '${k}'`), `E2 文件条目含 ${k}`)
  }
  ok(!/key: 'newFile'|key: 'newDir'|key: 'newKn'|key: 'paste'/.test(fileBranch),
    'E3 ★ 负向：文件条目里没有「新建 / 粘贴」')
  ok(/key: 'moveTo'[\s\S]{0,200}?<DirPicker/.test(fileBranch) && /doMove\(node\.relPath, dst\)/.test(fileBranch),
    'E4 「将文件移动到…」复用既有 doMove（→ workspaceRename + 撤销栈登记）')
  ok(/copyTreePath\(node\.relPath, 'rel'\)/.test(fileBranch) && /copyTreePath\(node\.relPath, 'abs'\)/.test(fileBranch),
    'E5 「复制路径 ▸」二级两档')
  const dirBranch = dirAt > -1 ? WTREE.slice(dirAt, dirAt + 1800) : ''
  for (const k of ['newFile', 'newDir', 'newKn', 'paste', 'expandDir', 'collapseDir', 'rename', 'delete']) {
    ok(dirBranch.includes(`key: '${k}'`), `E6 目录条目仍含 ${k}`)
  }
}
ok(!/navigator\.clipboard/.test(WTREE),
  'E7 ★ 负向：本文件已无 navigator.clipboard（原来「复制路径」那处是直连的，本批统一到 copyText）')
ok(/const ok = await copyText\(text\)/.test(WTREE) && /workspaceOpenInSystem\(root, rel, reveal\)/.test(WTREE),
  'E8 copyTreePath 走 copyText、openTreeInSystem 走 workspaceOpenInSystem')

// ===================== F 组：范围锁（本轮不动的两个宿主）=====================

console.log('\n=== F. 范围锁：AI 教学文件树 / 总览零散文件 本轮不动 ===')
ok(!/key: 'moveTo'/.test(TEACH) && !/DirPicker/.test(TEACH),
  'F1 负向：AI 教学文件树没被加进「将文件移动到…」（用户本轮只选了知识库 + 工作台）')
ok(!/key: 'moveTo'/.test(LEFT) && !/DirPicker/.test(LEFT),
  'F2 负向：总览零散文件没被加进「将文件移动到…」（它只列仓库根层，移走会让文件从列表消失）')
ok(/key: 'newFile'/.test(TEACH) && /key: 'copy'/.test(TEACH),
  'F3 AI 教学文件树保留自己的条目（打开阅读 / 复制到剪贴板 / 钉到收藏 等）—— 未被压平')

// ===================== G 组：既有契约已同批同步 =====================

console.log('\n=== G. 既有契约已同步（陈旧断言会掩盖真回归）===')
// ★ 三条都**只做正向断言**：契约脚本自己的说明文字里就写着旧写法（「原来锁 navigator.clipboard…」），
// 对它做负向断言必然假失败 —— 这正是 shared/strip-comments.mjs 头注警告的那类坑，
// 而契约脚本的注释是**不该**被剥的（它是给人读的），所以只能不写负向。
ok(/复制路径（二级：相对 \/ 完整，走主进程剪贴板）/.test(SHELL_VERIFY)
  && /将文件移动到…（目录搜索弹层）/.test(SHELL_VERIFY)
  && /系统打开 \/ 资源管理器定位/.test(SHELL_VERIFY),
  'G1 workbench-shell N4 已改写并扩到十项（原「复制路径」行锁渲染层直连剪贴板，改后必红）')
// G2/G3 的判据里 `\\\(` 是**故意的**：被检查的契约文件里写的是**正则字面量**
// （`/onSelect: \(\) => …/`），所以磁盘上的字节就是「反斜杠 + 左括号」。这里要匹配那个字节序列。
ok(/requestPasteFromMenu\\\(dirRel\\\)/.test(PASTE_VERIFY),
  'G2 paste-external 的粘贴断言已校正为「数据驱动」口径（原锁 `>粘贴</button>`，HEAD 上就是红的）')
ok(/onSelect: \\\(\\\) => startRename\\\(node\\\)/.test(TEACH_VERIFY),
  'G3 teach-tree C3 已校正为共享菜单 API（原锁 `run:` —— 那是旧 API 的字段名，HEAD 上就是红的）')

// ===================== 结果 =====================

console.log('')
if (fails.length === 0) {
  console.log(`PASS  ${pass} 项断言全绿`)
  process.exit(0)
}
console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
for (const f of fails) console.log('  [FAIL] ' + f)
process.exit(1)
