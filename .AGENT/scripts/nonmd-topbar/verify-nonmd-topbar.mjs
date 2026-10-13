/**
 * 契约脚本：非 Markdown 文件的统一顶栏（批 2）
 * 设计：`docs/nonmd-topbar-design.md` · 原型：`tmp/nonmd-topbar-proto/index.html`（945 行，可交互）
 *
 * 覆盖的缺陷面（每条都是「不报错但坏掉」的类型）：
 *   ① **两套按钮并存** —— 顶栏放开了门槛、胶囊却没退役 ⇒ 右上角同时挂两套（本批的核心风险）；
 *   ② **假按钮** —— 非 md 给了「阅读切换 / ✨续写 / 文件格式」：前者没有预览态、中者没有 ghost text、
 *      后者 `onFileTypeChange` 只改内存不落盘而扩展名来自文件名 ⇒ 三个都是点了没反应或重启即失效；
 *   ③ **绿点撒谎** —— 保存点对没有保存动作的类型恒亮「已保存」（批 1 之后判断依据过期，见设计 §三·①）；
 *   ④ **PDF 沉浸漏顶栏** —— `immersive` 是阅读器**内部** state，它藏自己的栏而顶栏在外面 ⇒
 *      正文进沉浸、顶栏还挂着；且换页不复位 ⇒ 换到别的文件顶栏永远不显示；
 *   ⑤ **PDF 两条栏各说一遍书名** —— 「合并公共部分」没做全 ⇒ 书名上下各一次，白占一行阅读高度；
 *   ⑥ **批 1 锚点漂移 / 旧契约被悄悄打红** —— ⋮ 里那五项搬位置时被改名或漏搬，而 workbench-shell /
 *      note-topbar / page-split / 批 1 探针里锁着旧结构（正向断言 → 必须同批转负向）。
 *
 * 用法（与其它契约脚本同款）：
 *   node .AGENT/scripts/nonmd-topbar/verify-nonmd-topbar.mjs
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

const TOP = code('src/modules/knowledge/components/NoteTopBar.tsx')
const PAGE = code('src/modules/knowledge/components/PageEditor.tsx')
const PDF = code('src/components/shared/pdf/PdfReaderView.tsx')
const APP = code('src/App.tsx')
const MODULE = code('src/modules/knowledge/index.tsx')
const CSS = code('src/styles/index.css')
const SHELL_VERIFY = read('.AGENT/scripts/workbench-shell/verify-workbench-shell.mjs')
const TOP_VERIFY = read('.AGENT/scripts/note-topbar/verify-note-topbar.mjs')
const SPLIT_VERIFY = read('.AGENT/scripts/page-split/verify-page-split.mjs')
const B1_PROBE = read('.AGENT/scripts/knowledge-content-routing/probe-content-routing.mjs')

// ===================== A 组：顶栏组件新增的四个纯展示 prop =====================

console.log('\n=== A. NoteTopBar 新增 prop（纯展示，不引入新真源）===')
ok(/showSaveDot\?: boolean/.test(TOP) && /showSaveDot = true/.test(TOP), 'A1 showSaveDot prop + 默认 true')
ok(/subtitle\?: string/.test(TOP) && /data-wb="noteTopSubtitle"/.test(TOP), 'A2 subtitle prop + 锚点 noteTopSubtitle')
ok(/showViewToggle\?: boolean/.test(TOP) && /showViewToggle = true/.test(TOP), 'A3 showViewToggle prop + 默认 true')
ok(/showMore\?: boolean/.test(TOP) && /showMore = true/.test(TOP), 'A4 showMore prop + 默认 true')
ok(/\{showSaveDot && \([\s\S]{0,120}?data-wb="noteSaveDot"/.test(TOP),
  'A5 保存点是**条件渲染**（不是渲染成禁用态 / 半透明态）')
ok(/\{showViewToggle && \([\s\S]{0,120}?data-wb="noteTopViewToggle"/.test(TOP), 'A6 阅读切换钮条件渲染')
ok(/\{showMore && \([\s\S]{0,200}?data-wb="noteTopMore"/.test(TOP), 'A7 ⋮ 条件渲染（false 时整个不出现）')
ok(/\{subtitle && \(/.test(TOP), 'A8 subtitle 为空时不占位（非 PDF 不留空格子）')
ok(!/useState/.test(TOP),
  'A9 负向：顶栏组件仍**零 state**（fileType / saving / preview / AI 四态的真源在 PageEditor，历史栈在模块层）')
ok(!/readFileSync|ipc|window\.api/.test(TOP), 'A10 负向：顶栏不自己取数据（纯展示 + 槽）')

// ===================== B 组：PageEditor 门槛与非 md 菜单 =====================

console.log('\n=== B. PageEditor 门槛与非 md 菜单 ===')
ok(/\{!isMindMapFile && !pdfImmersive && \(/.test(PAGE),
  'B1 顶栏门槛 = 非导图 + 非 PDF 沉浸（导图自带工具条；沉浸由阅读器上报）')
ok(!/\{isMdNote && \(\s*<NoteTopBar/.test(PAGE), 'B2 负向：旧的「仅 md 挂顶栏」门槛已删除')
ok(/const moreMenuItemCount = isMdNote/.test(PAGE) && /showMore=\{moreMenuItemCount > 0\}/.test(PAGE),
  'B3 ⋮ 空则隐藏的判据接了真值（moreMenuItemCount > 0）—— 现状恒真，是**潜伏守卫**，见设计 §三·②')
ok(/showSaveDot=\{!!paneDoc && textFile\?\.reason !== 'oversize-edit'\}/.test(PAGE),
  'B4 保存点判据 = paneDoc 非空**且**非 oversize-edit 只读文本（★ paneDoc 非空 ≠ 可编辑：>10MB 的文本类也会让 paneDoc 非空，而它的渲染分支被 ArchiveTextView 只读接走）')
ok(/showViewToggle=\{isMdNote\}/.test(PAGE), 'B5 阅读切换只给 md（非 md 无预览态）')
ok(/showInline=\{isMdNote && !preview && writingMode === 'source'\}/.test(PAGE),
  'B6 ✨续写只给 md 的源码档（非 md 没有 ghost text）')
ok(/subtitle=\{[\s\S]{0,320}isPdfFile && pdfPages > 0 \? `\$\{pdfPages\} 页`[\s\S]{0,24}: undefined/.test(PAGE),
  'B7 PDF 页数上移顶栏中段（批 3：同一处先给图片像素尺寸，PDF 页数退成第二档）')
ok(/moreMenu=\{isMdNote \? \(/.test(PAGE), 'B8 ⋮ 菜单按 isMdNote 分流（★ 2026-10-13 起 md 那一支**已有增补**：「查看源码 / 看渲染」，见 notes-surface 契约 C8e~C8m；本断言只锁分流本身）')
for (const a of ['peHtmlSource', 'peFileInfo', 'peOpenInSystem', 'peRevealInFolder', 'peCopyRelPath']) {
  ok(PAGE.includes(`data-wb="${a}"`), `B9 批 1 锚点原样搬进顶栏：${a}`)
}
ok(!/data-wb="peMore"/.test(PAGE) && !/data-wb="peMore"/.test(TOP),
  'B10 负向：胶囊那颗 ⋮ 的锚点 peMore 已删（顶栏的 ⋮ 用 noteTopMore）')
ok(/\(fileType === 'txt' \|\| fileType === 'html' \|\| isImagePage\) && onRequestReading/.test(PAGE),
  'B11 非 md 的「沉浸阅读」门槛对齐模块层 enterReading（knowledge/index.tsx：md / txt / html + 批 3 放行的图片）')
ok((PAGE.match(/文件格式/g) || []).length === 1,
  'B12 负向：非 md 的 ⋮ 不给「文件格式」（全仓只剩 md 菜单那一处 —— 只改内存不落盘 ⇒ 假按钮）',
  String((PAGE.match(/文件格式/g) || []).length))
ok(PAGE.includes('data-wb="peFileInfoCard"') && /<FileInfoRows/.test(PAGE),
  'B13 「文件信息」小卡随 ⋮ 一起搬进顶栏（仍用 FileInfoRows 同源渲染）')
ok(/\{showFileInfo && \([\s\S]{0,200}?kb-pop/.test(PAGE),
  'B14 小卡走 kb-pop 动效工具类（铁律 13：弹层进出必须带动效）')
ok(/if \(pdfImmersiveRef\.current\) return/.test(PAGE) && /pdfImmersiveRef/.test(PAGE),
  'B15 ★ Esc 在 PDF 沉浸态让给「退出沉浸」（阅读器的 Esc 分支不 stopPropagation，而这段是「关页签」' +
  ' ⇒ 不加守卫就是「按一次 Esc 先退出沉浸、再把笔记关掉」。以前写不出这道守卫，因为 immersive 是阅读器内部 state）')
ok(/useEffect\(\(\) => \{ pdfImmersiveRef\.current = pdfImmersive \}, \[pdfImmersive\]\)/.test(PAGE),
  'B16 沉浸态 ref 镜像已同步（keydown effect 依赖保持 [doSave, onBack]，不因沉浸切换重挂监听）')

// ===================== C 组：悬浮胶囊退役（负向，剥注释后）=====================

console.log('\n=== C. 悬浮胶囊退役（负向）===')
ok(!/floatBar|kb-float-hide|editor-toolbar-slot|createPortal/.test(PAGE),
  'C1 PageEditor 侧零残留（含 createPortal —— 顶栏改为行内渲染）')
ok(!/floatBar|mainPane|editor-toolbar-slot|wbContentActions/.test(APP),
  'C2 App 侧零残留（含 v3.4.0「页面条置顶」遗留的死代码 wbContentActionsEl）')
ok(!/data-wb='floatBar'|kb-float-hide|not\(:has\(button\)\)/.test(CSS), 'C3 index.css 侧零残留')
ok(!/isActive/.test(PAGE),
  'C4 随胶囊变死的 isActive prop 已删（它唯一的用途是给那颗 portal 做门槛）')
ok(!/isActive=\{/.test(MODULE),
  'C5 模块层不再向任何组件传 isActive（主栏与副栏两处都删）—— 保留 isActive 自身做别的事，故只锁传参形态')

// ===================== D 组：PdfReaderView「合并公共部分」=====================

console.log('\n=== D. PDF 合并公共部分 ===')
ok(/chrome\?: 'full' \| 'reader-only'/.test(PDF) && /chrome = 'full'/.test(PDF),
  'D1 chrome prop + 默认 full（书架阅读态一行不动）')
ok(/\{chrome === 'full' && \(/.test(PDF), 'D2 文件名 / 页数段是条件渲染')
ok(/chrome === 'full' && \([\s\S]{0,300}?\{name\}[\s\S]{0,200}?numPages\} 页/.test(PDF),
  'D3 被条件包住的正是「文件名 + N 页」（阅读器那条只留阅读控件）')
ok(/chrome="reader-only"/.test(PAGE), 'D4 知识库内传 reader-only')
ok(!/chrome="reader-only"/.test(MODULE), 'D5 负向：书架那条路不传（保持默认 full）')
ok(/onDocInfoRef/.test(PDF) && /onImmersiveChangeRef/.test(PDF),
  'D6 两个上报回调经 ref 转发（不污染 viewer 创建 effect 的依赖 —— 否则每次 handler 换身份就重建 viewer）')
{
  const stateAt = PDF.indexOf('const [immersive, setImmersive]')
  const effAt = PDF.indexOf('onImmersiveChangeRef.current?.(immersive)')
  ok(stateAt > -1 && effAt > stateAt,
    'D7 ★ 沉浸上报 effect 在 immersive 声明**之后**（依赖数组在 render 期求值，放前面撞 TDZ）',
    `state@${stateAt} effect@${effAt}`)
}
ok(/onDocInfoRef\.current\?\.\(\{ pages: pdf\.numPages \}\)/.test(PDF), 'D8 页数上报挂在文档装载处')
ok(/onDocInfo=\{\(i\) => setPdfPages\(i\.pages\)\}/.test(PAGE) && /onImmersiveChange=\{setPdfImmersive\}/.test(PAGE),
  'D9 PageEditor 接住两个上报')
ok(/setPdfPages\(0\); setPdfImmersive\(false\)/.test(PAGE) && /\}, \[pageId\]\)/.test(PAGE),
  'D10 换页复位（阅读器按 page.path 重挂、内部 state 归零，外层不复位 ⇒ 换到别的文件顶栏永远不显示）')
ok(/setHtmlSource\(false\); setSvgSource\(false\); setPdfPages\(0\); setPdfImmersive\(false\)/.test(PAGE),
  'D11 复位仍挂在**原有的**那个换页 effect 上（批 3 又兼了 svg 源码态，没有新造第二个 effect）')

// ===================== E 组：既有契约已同批同步（否则新代码把旧契约悄悄打红）=====================

console.log('\n=== E. 既有契约已同步 ===')
ok(/F8 内容级操作浮层已退役/.test(SHELL_VERIFY) && !/F8 内容级操作浮层在 App/.test(SHELL_VERIFY),
  'E1 workbench-shell F8 由正向转负向（原来正向断言胶囊存在，不改必红）')
ok(/F8b 悬浮栏样式基建已退役/.test(SHELL_VERIFY), 'E2 workbench-shell F8b 由正向转负向')
ok(/B9 负向：PageEditor 不再 portal/.test(TOP_VERIFY), 'E3 note-topbar B9 转负向')
ok(/B9b 负向：悬浮胶囊的类名与槽 id/.test(TOP_VERIFY), 'E4 note-topbar B9b 负向断言在位')
ok(/noteTopSubtitle/.test(TOP_VERIFY), 'E5 note-topbar B1 锚点表已含 noteTopSubtitle')
ok(/F1 主栏单例工具栏槽与悬浮胶囊已退役/.test(SPLIT_VERIFY) && !/F1 副栏 PageEditor 必须 isActive/.test(SPLIT_VERIFY),
  'E6 page-split F1 已改写（原锁「副栏必须 isActive={false}」，该 prop 已删）')
ok(/noteTopViewToggle/.test(B1_PROBE) && !/topbar \? 'md-editor'/.test(B1_PROBE),
  'E7 批 1 探针改用「阅读切换钮」区分 md（批 2 后非 md 也有顶栏，「有顶栏 = md」已失效）')
ok(!/\[data-wb="peMore"\]/.test(B1_PROBE), 'E8 批 1 探针的点击目标已换成 noteTopMore')

// ===================== 结果 =====================

console.log('')
if (fails.length === 0) {
  console.log(`PASS  ${pass} 项断言全绿`)
  process.exit(0)
}
console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
for (const f of fails) console.log('  [FAIL] ' + f)
process.exit(1)
