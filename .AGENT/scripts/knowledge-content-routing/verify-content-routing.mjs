/**
 * 契约脚本：知识库非 md 文件的内容落点（批 1）+ 文本类可编辑
 * 拍板记录：2026-10-12（原型 `tmp/nonmd-content-routing-proto/index.html`，路由真值表 24 项）
 *
 * 覆盖的缺陷面（每条都是「不报错但坏掉」的类型）：
 *   ① **专门视图被归档兜底遮蔽** —— `isArchiveFile` 一旦排到 `isPdfFile` 前面，
 *      仓库内 PDF 就永远看不到书架那套阅读器（而仓库内非 md 全是 entryKind:'file'，
 *      所以这不是边缘情况，是**全部**）。这个坑已经踩过两次：导图那次补了、PDF 这次没补。
 *      ⇒ 本脚本**按括号深度解析出真实的 JSX 条件链**，断言分支顺序，而不是 indexOf 比大小
 *      （2026-10-12 页面分屏的教训：40 条源码正则断言全绿，真机照样崩，因为证不了结构）。
 *   ② **rootId 用 ref 当渲染条件** —— ref 变更不触发重渲染 ⇒ 与页面数据的并发装载形成竞态，
 *      落到 legacy 降级分支后**再也回不来**。负向锁死「渲染链里不得出现 vaultRootRef.current」。
 *   ③ **自读四条纪律写飞** —— 超限灌 content（10MB 进 state）/ 对非 md 切 frontmatter /
 *      不同步 savedContentRef（导致刚读到的内容被当成用户改动回写一次）/ 没强制编辑态。
 *   ④ **编辑入口溢出能力面** —— `ws:writeFile` 主进程无扩展名白名单，
 *      所以「能编辑哪些文件」只由渲染层的 `isTextViewableExt` 一处决定，必须锁住。
 *   ⑤ **文本类没有真实语言映射** —— 未登记的扩展名会拿到兜底 `monacoLang`，
 *      而兜底曾是 'markdown' ⇒ `.csv` / `.log` 按 Markdown 高亮。逐个扩展名扫一遍。
 *   ⑥ **沉浸阅读的同款遮蔽** —— `enterReading` 放行 txt，而沉浸分支对所有 entryKind:'file'
 *      一律元信息卡 ⇒ 打开仓库里的 .txt 进沉浸阅读会跳出一张「不是 markdown 知识页」的卡。
 *
 * 用法（与其它契约脚本一致，需 --experimental-strip-types 以直接 import .ts）：
 *   node --experimental-strip-types .AGENT/scripts/knowledge-content-routing/verify-content-routing.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'
import { getFileTypeInfo, FILE_LANG_OPTIONS } from '../../../src/lib/fileTypes.ts'
import { TEXT_VIEWABLE_EXTS } from '../../../src/lib/aiTextExts.ts'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0
const fails = []
function ok(cond, label, detail = '') {
  if (cond) { pass++; return true }
  fails.push(label + (detail ? '  -> ' + detail : ''))
  return false
}

const SRC_PAGE = stripComments(read('src/modules/knowledge/components/PageEditor.tsx'))
const SRC_MODULE = stripComments(read('src/modules/knowledge/index.tsx'))
const SRC_CARD = stripComments(read('src/modules/knowledge/components/FileMetaCard.tsx'))
const SRC_ARCHIVE_VIEW = stripComments(read('src/modules/knowledge/components/ArchiveTextView.tsx'))
// 批 2（2026-10-12）：⋮ 按钮搬进了顶栏组件，锚点也随之落在那里
const SRC_TOPBAR = stripComments(read('src/modules/knowledge/components/NoteTopBar.tsx'))
/** 批 3：FileInfoRows 上移到 shared（图片异常态卡也要用，shared 反向依赖 module 是层次倒挂） */
const SRC_INFO = stripComments(read('src/components/shared/FileInfoRows.tsx'))

// ===================== A 组：分支顺序（结构断言，按括号深度解析）=====================

/**
 * 从 `anchor` 处的 `{` 起，用括号深度扫描出**整个 JSX 表达式块**并返回其原文。
 * 为什么不能用 indexOf 比大小：源码里 `isArchiveFile` / `isPdfFile` 各出现在十几处，
 * 只有「同一个条件链内部的先后」才是有意义的顺序，比全文下标会把注释、别的分支、
 * 甚至 ⋮ 菜单里的条件算进来 —— 那正是上一轮「全绿却真机崩」的成因。
 *
 * 字符串字面量整段跳过（模板串里的 `${}` 本身是配对的，跳过不影响配平）。
 */
function jsxBlock(src, anchor) {
  const at = src.indexOf(anchor)
  if (at < 0) return null
  let i = at
  let depth = 0
  let started = false
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      i++
      continue
    }
    if (c === '{') { depth++; started = true; i++; continue }
    if (c === '}') {
      depth--
      i++
      if (started && depth === 0) return src.slice(at, i)
      continue
    }
    i++
  }
  return null
}

const CONTENT_ANCHOR = '{isMindMapFile && page?.path ? ('
const chain = jsxBlock(SRC_PAGE, CONTENT_ANCHOR)
ok(!!chain, 'A1 能定位并解析出内容区的 JSX 条件链（括号配平到深度 0）',
  chain ? `长度 ${chain.length}` : '未找到锚点或括号不配平')

if (chain) {
  /** 分支头（按**期望的**先后列出）：标签 → 该分支的条件片段 */
  const HEADS = [
    ['导图（MindMapView）', 'isMindMapFile && page?.path ?'],
    ['html 合流（WelcomeHtmlView）', '(isWelcomeHtml || isArchiveHtml) && page?.path ?'],
    ['XMind 提示卡', 'isXmindFile ?'],
    ['PDF 阅读器（PdfReaderView）', 'isPdfFile && page?.path && vaultRootId ?'],
    // 批 3（2026-10-13）：图片查看器与 PDF 并列，同属「专门视图」
    ['图片查看器（ImageViewer）', 'isImagePage && page?.path && vaultRootId ?'],
    ['文本类超限只读（ArchiveTextView）', "archiveTextOpenable && page?.path && textFile?.reason === 'oversize-edit' ?"],
    ['归档兜底（FileMetaCard）', 'isArchiveFile && !archiveTextOpenable ?'],
    ['legacy PDF（不在仓库内）', 'isPdfFile ?'],
    ['md/txt 阅读态', 'preview ?'],
  ]
  const positions = []
  for (const [label, frag] of HEADS) {
    const idx = chain.indexOf(frag)
    ok(idx >= 0, `A2 条件链含分支：${label}`, frag)
    positions.push([label, idx])
  }
  const present = positions.filter(([, i]) => i >= 0)
  let ordered = true
  let broke = ''
  for (let k = 1; k < present.length; k++) {
    if (present[k][1] < present[k - 1][1]) {
      ordered = false
      broke = `${present[k - 1][0]} 排在 ${present[k][0]} 之前`
      break
    }
  }
  ok(ordered, 'A3 ★ 分支顺序正确：专门视图一律排在归档兜底之前（防第三次被遮蔽）', broke)
  ok(present.length === HEADS.length, 'A4 九个分支头全部在场（没有分支被悄悄删掉）',
    `在场 ${present.length}/${HEADS.length}`)

  // 归档兜底必须晚于 PDF —— 这就是本轮修的那个 bug，单独立一条，失败信息最直白
  const pdfIdx = chain.indexOf('isPdfFile && page?.path && vaultRootId ?')
  const archIdx = chain.indexOf('isArchiveFile && !archiveTextOpenable ?')
  ok(pdfIdx >= 0 && archIdx >= 0 && pdfIdx < archIdx,
    'A5 ★ PDF 阅读器分支早于归档兜底（仓库内 PDF 全是 entryKind:file，反了就等于永远看不到阅读器）',
    `pdf@${pdfIdx} archive@${archIdx}`)

  // 批 3（2026-10-13）：图片同一个坑 —— 仓库内图片也全是 entryKind:file
  const imgIdx = chain.indexOf('isImagePage && page?.path && vaultRootId ?')
  ok(imgIdx >= 0 && archIdx >= 0 && imgIdx < archIdx,
    'A5b ★ 图片分支早于归档兜底（同一个根因：仓库内图片全是 entryKind:file，反了就是一张元信息卡）',
    `img@${imgIdx} archive@${archIdx}`)
  ok(chain.includes('svgSourceEditable ? null'),
    'A5c SVG 源码态用内层 `? null` 让位给 paneDoc（与 html 那格同形态，不新增「互斥」语义）')

  // 文本类可编辑落点不得被归档兜底吃掉
  ok(chain.includes('!archiveTextOpenable'),
    'A6 归档兜底带 `!archiveTextOpenable` 闸（否则文本类会同时渲染元信息卡与编辑器）')

  ok(!chain.includes('vaultRootRef.current'),
    'A7 ★ 负向：渲染链里不得出现 `vaultRootRef.current`（ref 变更不触发重渲染 ⇒ 竞态后落到 legacy 分支回不来）')
  ok(chain.includes('rootId={vaultRootId}'),
    'A8 PDF 阅读器取 rootId 走 state（`vaultRootId`），不是 ref')
  ok(!chain.includes('isArchiveTextView && archiveShowContent'),
    'A9 负向：旧的「元信息卡 → 查看内容」两跳态已移除（该状态与分支都不该残留）')
}

// ===================== B 组：文本类自读的四条纪律 =====================

const readEffectAnchor = 'if (!textSelfReadTarget || !page?.path) { setTextFile(null); return }'
const readEffectAt = SRC_PAGE.indexOf(readEffectAnchor)
ok(readEffectAt >= 0, 'B1 自读 effect 在场（归档条目索引正文恒空，必须按需自读）')
const readEffect = readEffectAt >= 0 ? SRC_PAGE.slice(readEffectAt, readEffectAt + 2200) : ''

ok(readEffect.includes('r.truncated') && readEffect.includes("reason: 'oversize-open'"),
  'B2 >50MB（truncated）⇒ 退回元信息卡，不尝试按文本打开')
ok(readEffect.includes('r.binary') && readEffect.includes("reason: 'binary'"),
  'B3 二进制（detectBinary / %PDF- 头）⇒ 退回元信息卡')
ok(readEffect.includes('r.editable === false') && readEffect.includes("reason: 'oversize-edit'"),
  'B4 >10MB（editable:false）⇒ 走超限只读，而不是给一个存不进去的编辑框')
ok(!/reason: 'oversize-edit'[\s\S]{0,200}setContent\(/.test(readEffect),
  'B5 ★ 纪律①：超限分支**不得**把正文灌进 content state（10MB 进 React state 会让脏态比较与派生计算白跑）')
ok(!readEffect.includes('splitFrontmatter'),
  'B6 ★ 纪律②：自读**不得**调 splitFrontmatter（一个以 --- 开头的 .py 会被切掉开头）')
ok(readEffect.includes("vaultPrefixRef.current = ''"),
  'B7 ★ 纪律②：非 md 的 frontmatter 前缀恒为空串')
ok(/savedContentRef\.current = body/.test(readEffect),
  'B8 ★ 纪律③：同步 savedContentRef（否则灌进 content 的一瞬会被自动保存当成用户改动回写一次）')
ok(/vaultMtimeRef\.current = [\s\S]{0,80}mtimeMs/.test(readEffect),
  'B9 记录磁盘 mtime 作为保存冲突基线')
ok(readEffect.includes('setPreview(false)'),
  'B10 ★ 纪律④：归档文本类强制编辑态（loadPage 的 setPreview 规则会给 .txt 阅读态，那是给 txt 知识页定的）')
ok(/adoptVaultRoot\(root\)/.test(readEffect),
  'B11 自读顺手补齐 rootId（两条并发装载链任一先到都不影响落点）')

// ===================== C 组：编辑入口的能力面 =====================

ok(/const isArchiveTextView = isArchiveFile && !isArchiveHtml && isTextViewableExt\(fileType\)/.test(SRC_PAGE),
  'C1 ★ 编辑入口锁在 TEXT_VIEWABLE_EXT_SET 之内（主进程 ws:writeFile 无扩展名白名单，能力面只由这一行决定）')
ok(/archiveTextOpenable = isArchiveTextView && textFile !== null[\s\S]{0,120}reason !== 'binary'[\s\S]{0,80}reason !== 'oversize-open'/.test(SRC_PAGE),
  'C2 archiveTextOpenable 的判定式：必须同时排除二进制与超大打开')
ok(/modelPath: isArchiveFile \? `kb:\/\/archive-edit\/\$\{page\.path\}` : `kb:\/\/knowledge\/\$\{page\.path\}`/.test(SRC_PAGE),
  'C3 归档文本类用独立 Monaco model 命名空间（与知识页正文隔离，防 onChange / 外部监听打架）')
ok(/const paneDoc = vaultMode && page\?\.path && !isPdfFile[\s\S]{0,300}\(!isWelcomeHtml \|\| htmlSourceEditable\)[\s\S]{0,300}\(!isArchiveFile \|\| archiveTextOpenable \|\| htmlSourceEditable \|\| svgSourceEditable\)/.test(SRC_PAGE),
  'C4 paneDoc 对归档文本类 / html 源码态 / svg 源码态放行，其余归档条目仍然排除')
ok(/&& \(!isImagePage \|\| svgSourceEditable\)/.test(SRC_PAGE),
  'C4b ★ 图片只在「SVG 且切到源码态」时才落 Monaco（渲染态图片没有可编辑正文）')
ok(/if \(\/\\\.md\$\/i\.test\(rel\)\)/.test(SRC_PAGE),
  'C5 负向锁：保存路径的 frontmatter 注入仍只对 .md 生效（非 md 写裸正文）')

// ===================== D 组：⋮ 的「文件」组与文件信息 =====================

/**
 * 锚点写法两态（2026-10-13 页面菜单能力补齐）：⋮ 的条目原语 `MoreItem` / `MoreSub` 把锚点收成
 * `anchor` 属性（渲染到 DOM 仍是 `data-wb="…"` ⇒ 运行时选择器与两份探针一字不改，
 * 变的是源码文本形状）。两种写法都算「锚点在」，删掉则两者皆无 ⇒ 断言不空转。
 */
const pageHasAnchor = (a) => SRC_PAGE.includes(`data-wb="${a}"`) || SRC_PAGE.includes(`anchor="${a}"`)
for (const [anchor, label] of [
  ['peFileInfo', '文件信息'],
  ['peOpenInSystem', '在系统中打开'],
  ['peRevealInFolder', '在文件夹中显示'],
  // 2026-10-13：这一项由「复制相对路径」（一档）升级为「复制路径 ▸」（相对 / 完整 两档）——
  // 与文件树右键同能力。锚点名保留，标签改了；运行时的 peCopyRelPath 选择器仍然有效。
  ['peCopyRelPath', '复制路径 ▸'],
]) {
  ok(pageHasAnchor(anchor), `D1 ⋮ 有「${label}」项（锚点 ${anchor}）`)
}

// ---- D5：2026-10-13「页面菜单能力补齐」批 1a —— md 分支的路径 / 系统 / 编辑入口 ----
// 背景：md 页的 ⋮ 此前**一个文件级入口都没有**（只有收藏 / 关联 / 沉浸 / 刷题 / 源码档 / 脚注 / 图片 / 格式），
// 而它的非 md 兄弟与文件树右键都有 → 同一件事两个入口两种能力。这一批把 md 补齐到同一水平。
for (const [anchor, label] of [
  ['peCopyPath', '复制路径 ▸'],
  ['peSystemOpen', '在系统中打开'],
  ['peReveal', '在文件夹中显示'],
  ['peFind', '查找…'],
  ['peReplace', '替换…'],
]) {
  ok(pageHasAnchor(anchor), `D5 md 分支有「${label}」（锚点 ${anchor}）`)
}
ok(/const canFindReplace = !preview && writingMode === 'source'/.test(SRC_PAGE) && /\{canFindReplace && \(/.test(SRC_PAGE),
  'D5b ★ 查找 / 替换只在「源码档 + 编辑态」出现（阅读态下写作面是 display:none 保活、即时渲染档没有 Monaco ⇒ 给了就是假按钮）')
ok(/handleCopyPath\('rel'\)/.test(SRC_PAGE) && /handleCopyPath\('abs'\)/.test(SRC_PAGE) && /copyPathText/.test(SRC_PAGE) === false,
  'D5c 复制路径两档都在（相对直接复制 / 完整拼仓库根），且不再沿用模块层那个只服务树的名字')
ok(/const ok = await copyText\(text\)/.test(SRC_PAGE) && !/navigator\.clipboard\.writeText/.test(SRC_PAGE),
  'D5d 负向：路径复制走主进程 copyText，渲染层不直连 navigator.clipboard')
ok(/<MoreSub anchor="peCopyRelPath"/.test(SRC_PAGE),
  'D5e 非 md 的「复制路径」也升级成二级两档（此前只有「相对」一档）')
{
  // 反例（负向验证）：D5 的匹配器对**不存在的锚点**必须不认，否则上面五条是空转
  const fake = 'peNoSuchAnchorXYZ'
  ok(!pageHasAnchor(fake), 'D5f 反例：不存在的锚点匹配不到（证明 pageHasAnchor 不空转）')
}
ok(SRC_PAGE.includes('data-wb="peFileInfoCard"') && SRC_PAGE.includes('<FileInfoRows'),
  'D2 「文件信息」小卡用 FileInfoRows 渲染（与元信息卡同源）')
ok(SRC_TOPBAR.includes('data-wb="noteTopMore"') && !SRC_PAGE.includes('data-wb="peMore"'),
  'D2b 非 md 的 ⋮ 用顶栏的稳定锚点 noteTopMore（批 2：按钮搬进 NoteTopBar，胶囊那颗 peMore 随胶囊退役；探针已同步）')
ok(SRC_INFO.includes('export function FileInfoRows') && SRC_CARD.includes("from '../../../components/shared/FileInfoRows'") && /<FileInfoRows /.test(SRC_CARD),
  'D3 FileInfoRows 住在 shared 且 FileMetaCard 用它（批 3 上移：图片异常态卡也要用，shared 反向依赖 module 是层次倒挂）')
{
  // D4（批 2 改写）：原来断言 `!isMdNote && (…peFileInfo`，现在「文件」组是 ⋮ 菜单的 **else 分支**。
  // 用下标比较而不是长距离正则 —— md 菜单有 80+ 行，任何窗口值都是拍脑袋。
  // 批 3：窗口从 1200 抬到 2000 —— else 分支里多了 SVG 的「看源码」一项（7 行），
  // 它排在「文件信息」之前。窗口值只用来确认「在同一分支内」，不是精确布局断言。
  const m = SRC_PAGE.indexOf('moreMenu={isMdNote ? (')
  const elseAt = m > -1 ? SRC_PAGE.indexOf(') : (', m) : -1
  const infoAt = elseAt > -1 ? SRC_PAGE.indexOf('peFileInfo', elseAt) : -1
  ok(m > -1 && elseAt > -1 && infoAt > -1 && infoAt - elseAt < 2000,
    'D4 「文件」组只在非 md 出现（批 2：它是 ⋮ 菜单的 else 分支；md 菜单一字不改，拍板 E1 的范围锁）',
    `moreMenu@${m} else@${elseAt} peFileInfo@${infoAt}`)
}
ok(/const \{ copyText \} = await import\('\.\.\/\.\.\/\.\.\/lib\/ipc'\)/.test(SRC_PAGE),
  'D5 复制相对路径走主进程剪贴板通道（渲染层不直连 navigator.clipboard）')

// ===================== E 组：超限只读复用 + html 源码态 =====================

ok(SRC_ARCHIVE_VIEW.includes('banner') && SRC_ARCHIVE_VIEW.includes('data-wb="archiveViewBanner"'),
  'E1 ArchiveTextView 支持 banner（超限原因提示条）')
ok(SRC_ARCHIVE_VIEW.includes('editable: false'),
  'E2 ArchiveTextView 仍是只读（editable:false）—— 它是「超限只读」落点，不是第二个编辑器')
ok(/backLabel = '返回'/.test(SRC_ARCHIVE_VIEW),
  'E3 返回按钮可定制 / 可省略（作为页面直接落点时无上游可回）')

/* html 源码态（拍板：默认仍沙箱渲染，只加出口） */
ok(/const htmlSourceEditable = \(isWelcomeHtml \|\| isArchiveHtml\) && htmlSource && !!page\?\.path/.test(SRC_PAGE),
  'E4 html 源码态同时覆盖欢迎页与归档 html')
ok(/const \[htmlSource, setHtmlSource\] = useState\(false\)/.test(SRC_PAGE),
  'E5 ★ html 默认仍是沙箱渲染（htmlSource 初值 false —— 默认行为不变，只加出口）')
ok(/useEffect\(\(\) => \{\s*setHtmlSource\(false\); setSvgSource\(false\); setPdfPages\(0\); setPdfImmersive\(false\)/.test(SRC_PAGE),
  'E6 换页重置 html 源码态（批 2 起同一个 effect 兼复位 PDF 上报的页数 / 沉浸态；批 3 又兼了 svg 源码态）')
ok(/htmlSource \? null : <WelcomeHtmlView path=\{page\.path\} \/>/.test(SRC_PAGE),
  'E7 渲染分支：htmlSource 为真时让位给下方 paneDoc 块（源码 Monaco），否则沙箱 iframe')
ok(SRC_PAGE.includes('data-wb="peHtmlSource"'),
  'E8 ⋮ 里有「看源码 / 看渲染」切换项（锚点 peHtmlSource）')
ok(/const textSelfReadTarget = isArchiveTextView \|\| htmlSourceEditable/.test(SRC_PAGE),
  'E9 自读目标 = 归档文本类 ∪ html 源码态（两者索引正文都为空）')

// ===================== F 组：沉浸阅读的同款遮蔽 =====================

const immAt = SRC_MODULE.indexOf("(readingPage.entryKind ?? 'doc') === 'file'")
ok(immAt >= 0, 'F1 沉浸阅读的归档分支在场')
const immBlock = immAt >= 0 ? SRC_MODULE.slice(immAt, immAt + 1400) : ''
ok(immBlock.includes('isTextViewableExt'),
  'F2 ★ 沉浸分支按文本类判定（enterReading 放行 txt，原先一律元信息卡 ⇒ 必现一张「不是 markdown 知识页」的卡）')
ok(immBlock.indexOf('<ArchiveTextView') >= 0 && immBlock.indexOf('<ArchiveTextView') < immBlock.indexOf('<FileMetaCard'),
  'F3 ★ 沉浸分支里文本视图排在元信息卡之前（同款遮蔽不得在第二处复发）')
ok(immBlock.includes('WelcomeHtmlView'),
  'F4 沉浸分支的 html 沙箱渲染保留')

// ===================== G 组：fileTypes 的语言映射（表驱动）=====================

ok(getFileTypeInfo('csv').monacoLang === 'plaintext', 'G1 csv → plaintext', getFileTypeInfo('csv').monacoLang)
ok(getFileTypeInfo('log').monacoLang === 'plaintext', 'G2 log → plaintext', getFileTypeInfo('log').monacoLang)
ok(getFileTypeInfo('toml').monacoLang === 'ini', 'G3 toml → ini', getFileTypeInfo('toml').monacoLang)
ok(getFileTypeInfo('cs').monacoLang === 'csharp', 'G4 cs → csharp', getFileTypeInfo('cs').monacoLang)
ok(getFileTypeInfo('kt').monacoLang === 'kotlin', 'G5 kt → kotlin', getFileTypeInfo('kt').monacoLang)
ok(getFileTypeInfo('ps1').monacoLang === 'powershell', 'G6 ps1 → powershell', getFileTypeInfo('ps1').monacoLang)
ok(getFileTypeInfo('swift').monacoLang === 'swift', 'G7 swift → swift', getFileTypeInfo('swift').monacoLang)
ok(getFileTypeInfo('zzz-unknown').monacoLang === 'plaintext',
  'G8 ★ 未知扩展名的兜底是 plaintext，不再是 markdown（按 Markdown 高亮未知类型是纯粹的误导）')

{
  /* 逐个扫：凡是「可编辑文本类」的扩展名，都必须有**真实**语言映射（md 系除外，它们本来就该是 markdown） */
  const MD_LIKE = new Set(['md', 'markdown', ''])
  const bad = TEXT_VIEWABLE_EXTS.filter(e => !MD_LIKE.has(e) && getFileTypeInfo(e).monacoLang === 'markdown')
  ok(bad.length === 0, `G9 ★ 全部 ${TEXT_VIEWABLE_EXTS.length} 个可编辑文本类扩展名都有真实语言映射（无 markdown 兜底）`,
    bad.length ? '仍走 markdown 兜底：' + bad.join(', ') : '')
  /* badge 判不出「有没有条目」——兜底 badge 就是 `ext.toUpperCase()`，与真实条目同形。
     改判 **label**：兜底 label 恒等于扩展名本身（小写），真实条目一律是中文或专有写法。
     （`.markdown` 的 badge 刻意复用 `MD`，与 `.md` 同款，所以不能拿 badge 当判据。） */
  const noEntry = TEXT_VIEWABLE_EXTS.filter(e => e && getFileTypeInfo(e).label === e)
  ok(noEntry.length === 0, 'G10 ★ 每个可编辑文本类都有真实类型条目（label 不等于扩展名，树里不再显示成通用文件）',
    noEntry.length ? '仍是兜底条目：' + noEntry.join(', ') : '')
}

{
  /* 文件格式菜单（转换文件类型）不该出现数据 / 日志类 —— 把 .md 改成 .csv 是没有语义的 */
  const opts = FILE_LANG_OPTIONS.map(o => o.ext)
  const leaked = ['csv', 'tsv', 'log', 'toml', 'ini', 'cfg', 'conf'].filter(e => opts.includes(e))
  ok(leaked.length === 0, 'G11 ★ FILE_LANG_OPTIONS（文件格式菜单）不含数据 / 日志类',
    leaked.length ? leaked.join(', ') : '')
}

// ===================== 结果 =====================

if (fails.length === 0) {
  console.log(`PASS  ${pass} 项断言全绿`)
  process.exit(0)
} else {
  console.log(`FAIL  ${pass} 通过 / ${fails.length} 失败\n`)
  for (const f of fails) console.log('  [FAIL] ' + f)
  process.exit(1)
}
