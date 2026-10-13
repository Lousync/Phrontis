#!/usr/bin/env node
/**
 * 契约：页面 ⋮ 菜单「能力补齐」批 1b —— 模块层管道六条 + 文件树导入两项（2026-10-13）。
 *
 * 为什么需要它：这一批把 ⋮ 从「只管本页内容」扩到「也能做文件级动作」，而**实现全在模块层**
 * （改名 / 移动会改仓库相对路径 ⇒ 必须连带刷树、刷 allPages、改页签；删要走回收站 + 连带关页签）。
 * 于是这里有三个容易静默退化的点，各配断言与反例：
 *   ① 「接了才算」：六个动作都靠可选 prop 门控，**模块层漏传 = 菜单里那一项直接消失**
 *      （不报错、不告警），所以既锁 PageEditor 侧的门控，也锁模块层两个调用点都传了；
 *   ② 「假按钮」：`handleDelete` 第一句就是 `if (vaultMode)` 弹提示返回，而知识库模块**恒传**
 *      `vaultMode={true}` ⇒ 这条菜单项在仓库模式下**只弹提示、什么都不删**。本批换成先走
 *      `onDeleteRequest`（模块层 handleTreeDelete：回收站 + 危险确认 + 关页签），并锁住优先级；
 *   ③ 「复用而不是新造」：改名 / 移动 / 副本 / 导入全部复用既有实现（handleTreeRename /
 *      handleTreeMove / duplicateWorkspaceFile / handleDialogImport / handleImportFolder），
 *      不许另写一份盘操作。
 *
 * 跑法（项目根目录）：
 *   node --experimental-strip-types --no-warnings .AGENT/scripts/page-menu/verify-page-menu.mjs
 * 期望：末尾 PASS 且 exit=0
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

let failures = 0
const ok = (label, detail) => console.log(`  [OK]   ${label}${detail ? ' —— ' + detail : ''}`)
const bad = (label, detail) => { failures++; console.error(`  [FAIL] ${label}${detail ? ' —— ' + detail : ''}`) }
const check = (label, cond, detail) => (cond ? ok(label, detail) : bad(label, detail))

const PAGE = read('src/modules/knowledge/components/PageEditor.tsx')
const MOD = read('src/modules/knowledge/index.tsx')

/** 锚点写法两态：直接写 `data-wb="X"`，或走条目原语 `anchor="X"`（渲染到 DOM 仍是 data-wb）。 */
const hasAnchor = (src, a) => src.includes(`data-wb="${a}"`) || src.includes(`anchor="${a}"`)

// ---------------------------------------------------------------- §1 六个可选 prop 的接线

console.log('\n§1 模块层管道：六个动作都从 PageEditor 发请求、由模块层落盘')

for (const [prop, sig] of [
  ['onRenameRequest', '(relPath: string, newName: string) => void'],
  ['onMoveRequest', '(relPath: string, targetDirRel: string) => void'],
  ['onDuplicateRequest', '(relPath: string) => void'],
  ['onLocateRequest', '(relPath: string) => void'],
  ['onDeleteRequest', '(relPath: string) => void'],
  ['onSplitRequest', "(orientation: 'row' | 'column') => void"],
]) {
  check(`Props 里声明了 ${prop}`, PAGE.includes(`${prop}?: ${sig}`), prop)
}
// 模块层两个调用点（主栏 / 副栏）都要传：漏传 = 那个栏位的 ⋮ 少几项，且没有任何报错
for (const prop of ['onRenameRequest=', 'onMoveRequest=', 'onDuplicateRequest=', 'onLocateRequest=', 'onDeleteRequest=']) {
  const n = MOD.split(prop).length - 1
  check(`模块层两个 PageEditor 调用点都传了 ${prop.slice(0, -1)}`, n === 2, `实际 ${n} 处`)
}
check('只有主栏传分屏（副栏再拆一次没有语义，刻意不给）',
  (MOD.split('onSplitRequest=').length - 1) === 1 && /唯独\*\*不给分屏\*\*/.test(MOD))

// 复用而不是新造盘操作
for (const [fn, why] of [
  ['handleTreeRename(rel, name)', '重命名复用文件树那条（含分类通道 + 撤销栈 + 刷树/刷页签）'],
  ['handleTreeMove(rel, dst)', '移动复用文件树那条'],
  ['handleDeleteByRel', '删除复用 handleTreeDelete（回收站 + 危险确认 + 连带关页签）'],
  ['handleDuplicateByRel', '创建副本复用 duplicateWorkspaceFile'],
  ['handleLocateInTree', '定位走宿主 expandedDirs + 行锚点滚动'],
]) {
  check(`模块层：${why}`, MOD.includes(fn), fn)
}

// ---------------------------------------------------------------- §2 「删除」假按钮的修复

console.log('\n§2 删除：从「仓库模式下只弹提示的假按钮」换成真删除')

check('⋮ 两项删除都接 requestDelete（md 与非 md 同一个落点）',
  (PAGE.split('requestDelete()').length - 1) >= 2)
{
  const i = PAGE.indexOf('const requestDelete = () => {')
  const body = i >= 0 ? PAGE.slice(i, i + 320) : ''
  check('requestDelete 先走 onDeleteRequest（模块层真删除），没接才回落 handleDelete',
    /onDeleteRequest && rel/.test(body) && body.indexOf('onDeleteRequest') < body.indexOf('handleDelete'),
    '优先级反了就等于假按钮还在')
  check('反例（旧形态）：`if (vaultMode)` 那条提示仍在 handleDelete 里（说明回落路径没被删掉）',
    /if \(vaultMode\) \{\s*showToast\(\{ type: 'warning', message: '仓库文件模式：删除请在编辑器模块操作/.test(read('src/modules/knowledge/components/PageEditor.tsx')))
}
check('模块层删除落点复用 handleTreeDelete 且不需要完整 TreeNode（只读 relPath / type）',
  /handleTreeDelete\(\{ relPath: rel, type: 'file' \} as TreeNode\)/.test(MOD))
check('非 md 的 ⋮ 有「删除文件」（此前非 md 根本没有删除入口）', PAGE.includes('label="删除文件"'))
check('md 的 ⋮ 仍是「删除页面」（既有文案不改，免得牵动手册与探针）', PAGE.includes('label="删除页面"'))

// ---------------------------------------------------------------- §3 重命名：输入框跟着 ⋮ 走

console.log('\n§3 重命名：弹层输入（不复用树内联改名）')

check('有重命名弹层与输入框锚点', hasAnchor(PAGE, 'peRenameCard') && hasAnchor(PAGE, 'peRenameInput'))
check('Enter 提交 / Esc 取消', /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); submitRename\(\) \}/.test(PAGE)
  && /else if \(e\.key === 'Escape'\)/.test(PAGE))
check('打开前先关掉另两个弹层（三者共用 ⋮ 下方那个槽位）',
  /setShowFileInfo\(false\); setShowMove\(false\); setShowRename\(true\)/.test(PAGE))
check('外点 / Esc 关闭并认自己的锚点（捕获阶段，不依赖冒泡顺序）',
  /peRenameCard[\s\S]{0,400}addEventListener\('mousedown'/.test(PAGE) && /addEventListener\('keydown'/.test(PAGE))
check('换页复位弹层（不同文件之间不继承）', /\}, \[pageId\]\)/.test(PAGE))
check('★ 输入框种子是当前文件名（含扩展名），不是标题', /setRenameDraft\(pageRel\(\)\.split\('\/'\)\.pop\(\) \?\? ''\)/.test(PAGE))

// ---------------------------------------------------------------- §4 将文件移动到…

console.log('\n§4 将文件移动到…：复用共享 DirPicker')

check('移动弹层用共享 DirPicker（不另写目录选择）',
  /<DirPicker[\s\S]{0,220}sourceRel=\{page\.path\}/.test(PAGE))
check('选中后把目标目录交回模块层（组件自己不动盘）', /onPick=\{\(dst\) => requestMove\(dst\)\}/.test(PAGE))
check('rootId 传本组件手里的仓库 id（拿不到时由 DirPicker 自己兜底）', /rootId=\{vaultRootId \?\? undefined\}/.test(PAGE))

// ---------------------------------------------------------------- §5 在文件列表中显示

console.log('\n§5 在文件列表中显示当前文件')

check('切到文件视图（左栏还停在大纲页时否则什么也看不到）', /setSidebarTab\('files'\)/.test(MOD))
check('展开全部祖先目录', /const dirs = \[''\]/.test(MOD) && /setExpandedDirs\(prev => new Set\(\[\.\.\.prev, \.\.\.dirs\]\)\)/.test(MOD))
check('按行锚点滚进视野（树组件本身不改）',
  /querySelector<HTMLElement>\(`\[data-wb-tree-path="\$\{CSS\.escape\(rel\)\}"\]`\)/.test(MOD)
  && /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/.test(MOD))
check('★ 两帧后再滚（目录展开是异步的，当帧行还没渲染）',
  /requestAnimationFrame\(\(\) => requestAnimationFrame\(/.test(MOD))
check('找不到给提示，不静默（可能被 .ignore 收起）', /没找到这一条（可能被 \.ignore 规则收起）/.test(MOD))

// ---------------------------------------------------------------- §6 分屏

console.log('\n§6 分屏：与页签右键同一个动作源')

check('布局组抽成 MoreSplitGroup（md / 非 md 共用一段，不两处各写一份）',
  /function MoreSplitGroup\(/.test(PAGE) && (PAGE.split('<MoreSplitGroup').length - 1) === 2)
check('两个锚点都在（peSplitRow / peSplitCol）', hasAnchor(PAGE, 'peSplitRow') && hasAnchor(PAGE, 'peSplitCol'))
check('disabled 与页签右键同源（splitDisabled 由模块层传）', /disabled=\{disabled\}/.test(PAGE) && /splitDisabled=\{splitDisabled\}/.test(MOD))
check('模块层调的是既有 onSplitPage（不新写分屏逻辑）', /onSplitPage\(activePageId, o\)/.test(MOD))

// ---------------------------------------------------------------- §7 导入两项进文件树

console.log('\n§7 导入文件… / 导入文件夹… 进文件树（能力早就在，只差菜单项）')

check('目录 / 空白组新增两条', /key: 'importFiles', label: '导入文件…'/.test(MOD) && /key: 'importFolder', label: '导入文件夹…'/.test(MOD))
check('复用既有处理函数（不新写导入通道）',
  /onSelect: \(\) => void handleDialogImport\(\)/.test(MOD) && /onSelect: \(\) => void handleImportFolder\(\)/.test(MOD))
check('负向：这两条**不再只**躺在那两套没有任何渲染入口的旧菜单里',
  (MOD.split("label: '导入文件夹…'").length - 1) === 1, '旧组件里的那份仍在（死代码），但可达的那份只有一处')

// ---------------------------------------------------------------- §8 门控与反例

console.log('\n§8 门控：没接就不出现（不做点了没反应的假按钮）')

for (const [gate, what] of [
  ['{onRenameRequest &&', '重命名'],
  ['{onDuplicateRequest &&', '创建副本'],
  ['{onMoveRequest &&', '将文件移动到…'],
  ['{onLocateRequest &&', '在文件列表中显示'],
  ['{onSplitRequest &&', '分屏组'],
  ['{onDeleteRequest &&', '非 md 的删除文件'],
]) {
  const n = PAGE.split(gate).length - 1
  check(`门控在位：${what}`, n >= 1, `${n} 处`)
}
check('反例：契约里那个「锚点两态」匹配器对不存在的锚点必须不认（防空转）',
  !hasAnchor(PAGE, 'peNoSuchAnchorXYZ'))
check('反例：不存在的处理函数名匹配不到（证明 §1 的匹配器不是恒真）', !MOD.includes('handleNoSuchThingByRel'))

console.log('')
if (failures === 0) {
  console.log('PASS  页面 ⋮ 批 1b：六个动作接到位 / 删除不再是假按钮 / 导入进可达菜单 / 门控与反例齐全')
  process.exit(0)
}
console.error(`FAIL  ${failures} 项未通过`)
process.exit(1)
