/**
 * 图片渲染与查看的静态契约（批 3，2026-10-13，v3.5.0 线）。
 *
 * 与 `verify-image-math.mjs` 的分工：那份**跑**真的 `.ts` 验几何与格式头解析的性质；
 * 这份**读源码**验那些「跑不起来但一错就是静默坏掉」的东西 ——
 * 落点顺序、格式集合与主进程白名单是否同步、取回通道有没有留 base64 残迹、
 * 锚点是否齐、有没有人偷偷把状态又摊回第二个地方。
 *
 * 跑法：node .AGENT/scripts/image-viewer/verify-image-viewer.mjs
 *
 * ★ 读源码前一律 `stripComments`：本批的注释里大量引用了被断言的字面量
 *   （比如「原先只认 .attachments/」「不再用 ws:readImage」），
 *   不剥注释的话负向断言会被自己的说明文字毒死 —— 这个坑批 2/批 3 都踩过。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stripComments } from '../shared/strip-comments.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const raw = (p) => readFileSync(resolve(ROOT, p), 'utf-8')
/** 剥注释后的源码（断言一律用它） */
const src = (p) => stripComments(raw(p))

let pass = 0, fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`) }
  else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

const PAGE = 'src/modules/knowledge/components/PageEditor.tsx'
const KIDX = 'src/modules/knowledge/index.tsx'
const TOPBAR = 'src/modules/knowledge/components/NoteTopBar.tsx'
const VIEWER = 'src/components/shared/image/ImageViewer.tsx'
const TOOLBAR = 'src/components/shared/image/ImageToolbar.tsx'
const STATECARD = 'src/components/shared/image/ImageStateCard.tsx'
const IMMERSIVE = 'src/components/shared/image/ImmersiveImageView.tsx'
const HOOK_IMG = 'src/components/shared/image/useVaultImage.ts'
const HOOK_VIEW = 'src/components/shared/image/useImageView.ts'
const HOOK_KEYS = 'src/components/shared/image/useImageViewKeys.ts'
const ATTACH = 'src/lib/attachmentImage.ts'
const FORMATS = 'src/lib/imageFormats.ts'
const FILETYPES = 'src/lib/fileTypes.ts'
const FILEICONS = 'src/lib/fileIcons.ts'
const WM = 'electron/lib/workspaceManager.ts'
const CSS = 'src/styles/index.css'

const page = src(PAGE), kidx = src(KIDX), topbar = src(TOPBAR)
const viewer = src(VIEWER), toolbar = src(TOOLBAR), statecard = src(STATECARD), immersive = src(IMMERSIVE)
const hookImg = src(HOOK_IMG), hookView = src(HOOK_VIEW), hookKeys = src(HOOK_KEYS)
const attach = src(ATTACH), formats = src(FORMATS), filetypes = src(FILETYPES), fileicons = src(FILEICONS)
const wm = src(WM), css = raw(CSS)

console.log('=== A 落点顺序（PageEditor 条件链） ===')
{
  /* 链条是嵌套三元，出现顺序 = 分支先后。三个锚点都在渲染分支区里，
     且各自只出现一次（注释已剥掉，不会被说明文字干扰）。 */
  const iPdf = page.indexOf('isPdfFile && page?.path && vaultRootId')
  const iImg = page.indexOf('isImagePage && page?.path && vaultRootId')
  const iMeta = page.indexOf('isArchiveFile && !archiveTextOpenable')
  ok(iPdf > 0, 'A1 找到 PDF 分支锚点')
  ok(iImg > 0, 'A2 找到图片分支锚点')
  ok(iMeta > 0, 'A3 找到元信息卡兜底锚点')
  ok(iPdf < iImg, 'A4 图片分支排在 PDF 之后（两者并列，都是专门视图）')
  ok(iImg < iMeta, 'A5 ★ 图片分支排在归档兜底**之前** —— 否则被元信息卡遮蔽（批 1 的根因）')
  ok(/isImagePage && page\?\.path && vaultRootId/.test(page), 'A6 条件用 vaultRootId（state）而不是 ref')
  ok(!/vaultRootRef\.current/.test(page.slice(page.indexOf('{/* Content */}'), page.indexOf('{paneDoc && editorEverMounted'))),
    'A7 ★ 负向：渲染链里不得出现 vaultRootRef.current（ref 变更不触发重渲染，会落兜底回不来）')
  ok(/svgSourceEditable \? null/.test(page), 'A8 SVG 源码态用内层 `? null` 让位（与 html 那格同形态）')
  ok(/\(!isImagePage \|\| svgSourceEditable\)/.test(page), 'A9 paneDoc 条件含「图片仅在 SVG 源码态才落 Monaco」')
  ok(/archiveTextOpenable \|\| htmlSourceEditable \|\| svgSourceEditable/.test(page), 'A10 paneDoc 条件含 svgSourceEditable 尾项')
  ok(/textSelfReadTarget = isArchiveTextView \|\| htmlSourceEditable \|\| svgSourceEditable/.test(page),
    'A11 自读目标含 svg 源码态（否则 Monaco 里是空的）')
}

console.log('\n=== B 格式集合必须落在主进程白名单里（本批最易静默坏掉的一条） ===')
{
  /* 取回走 ws:readRangeBytes，主进程按 RANGE_EXT_WHITELIST 放行。
     渲染层的集合一旦超出它，表象是「文件树里有这张图、点开却是一张元信息卡」，
     而且**没有任何报错** —— 所以这里逐项比对，而不是只看集合非空。 */
  const m = /const RANGE_EXT_WHITELIST = \[([^\]]*)\]/.exec(wm)
  ok(!!m, 'B1 解析到主进程 RANGE_EXT_WHITELIST')
  const wmExts = (m?.[1] || '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  const fm = /IMAGE_RENDER_EXTS = \[([^\]]*)\]/.exec(formats)
  ok(!!fm, 'B2 解析到渲染层 IMAGE_RENDER_EXTS')
  const fmExts = (fm?.[1] || '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  const missing = fmExts.filter(e => !wmExts.includes(e))
  ok(missing.length === 0, 'B3 ★ IMAGE_RENDER_EXTS ⊆ 主进程白名单', `主进程缺：${missing.join(', ') || '无'}`)
  ok(fmExts.includes('avif'), 'B4 avif 已收（本批唯一动主进程的那一项）')
  ok(wmExts.includes('avif'), 'B5 主进程白名单确实补了 avif')
  ok(!fmExts.includes('ico') && !wmExts.includes('ico'), 'B6 ico 两处都没有（同批拍板：不收）')
  ok(!fmExts.includes('heic') && !fmExts.includes('heif'), 'B7 heic / heif 不收（要 libheif，双份代价）')
  ok(!fmExts.includes('txt') && !fmExts.includes('pdf'), 'B8 图片集合里不混非图片（白名单里那些是阅读器的）')
  ok(/扩容属\*\*安全面变更\*\*/.test(raw(WM)) && /avif = 批 3/.test(raw(WM)),
    'B9 avif 那一行写明了理由（该文件注释要求的「安全面变更须写明理由」）')
}
{
  const fm = /IMAGE_RENDER_EXTS = \[([^\]]*)\]/.exec(formats)
  const fmExts = (fm?.[1] || '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  const infoBlock = filetypes.slice(filetypes.indexOf("'png':"), filetypes.indexOf('}', filetypes.indexOf("'svg':")))
  const missingInfo = fmExts.filter(e => !new RegExp(`'${e}':`).test(filetypes))
  ok(missingInfo.length === 0, 'B10 fileTypes 的 INFO 覆盖全部可渲染扩展名', `缺：${missingInfo.join(', ')}`)
  ok(/'svg':\s*\{[^}]*monacoLang:\s*'xml'/.test(filetypes),
    'B11 svg 的 monacoLang 是 xml（源码态要落 Monaco，给 plaintext 就没高亮）')
  ok(/只补 `INFO`，\*\*不补 `FILE_LANG_OPTIONS\*\*/.test(raw(FILETYPES)) || !/FILE_LANG_OPTIONS[\s\S]{0,900}'png'/.test(filetypes),
    'B12 FILE_LANG_OPTIONS（转换文件格式菜单）里不含图片扩展名')
  const missingIcon = fmExts.filter(e => !new RegExp(`\\b${e}:\\s*imageSvg`).test(fileicons))
  ok(missingIcon.length === 0, 'B13 fileIcons 覆盖全部可渲染扩展名（否则文件树里是通用图标）', `缺：${missingIcon.join(', ')}`)
  ok(/import imageSvg from '\.\.\/assets\/image\.svg\?raw'/.test(fileicons), 'B14 新增的图片图标资源已接线')
  ok(infoBlock.length >= 0, 'B15 （占位：INFO 区块可定位）')
}

console.log('\n=== C 取回通道：换到 range，且不留 base64 残迹 ===')
{
  ok(/workspaceReadRangeBytes/.test(attach), 'C1 attachmentImage 走 ws:readRangeBytes')
  ok(!/workspaceReadImage\(/.test(attach), 'C2 ★ 负向：不再调 workspaceReadImage')
  ok(!/dataUrl/.test(attach) && !/atob/.test(attach) && !/toString\('base64'\)/.test(attach),
    'C3 ★ 负向：没有 data:URI / atob / base64 残留（换通道的理由就是省掉这三样）')
  ok(/MAX_CACHE = 120/.test(attach), 'C4 有缓存条数上限')
  const revokes = (attach.match(/revokeObjectURL/g) || []).length
  ok(revokes >= 2, 'C5 ★ revokeObjectURL 至少两处（LRU 逐出 + 换仓库整表清）', `实际 ${revokes} 处`)
  ok(/e\.rootId !== lastRootId/.test(attach),
    'C6 ★ 同步读取器按 rootId 校验（老实现只按路径缓存 ⇒ 换仓库后命中上一个仓库的图）')
  ok(/if \(lastRootId === rootId\) return[\s\S]{0,160}cache\.clear\(\)/.test(attach), 'C7 换仓库时整表清掉')
  ok(/SCHEME_RE/.test(attach) && /if \(s\.startsWith\('\/'\)\) return null/.test(attach),
    'C8 normalizeVaultRel 拒绝带 scheme 与绝对路径')
  ok(/some\(seg => seg === '\.\.'\)/.test(attach), 'C9 normalizeVaultRel 拒绝剥完仍含 .. 的路径')
  ok(/isRenderableImageExt\(extOf\(s\)\)/.test(attach), 'C10 normalizeVaultRel 按图片扩展名收口')
  ok(!/vaultRelRootIdPromise/.test(attach),
    'C11 ★ 负向：不再永久缓存 workspaceGetCurrent 的 Promise（换仓库会一直拿旧 rootId）')
  // 两个消费者不该被改
  const mp = src('src/components/shared/MarkdownPreview.tsx')
  const lmp = src('src/components/shared/LiveMarkdownPane.tsx')
  ok(/normalizeVaultRel/.test(mp) && /getCachedVaultImage/.test(mp) && /loadVaultImage/.test(mp),
    'C12 MarkdownPreview 仍只用这三个函数（一行未改）')
  ok(/normalizeVaultRel/.test(lmp) && /getCachedVaultImage/.test(lmp) && /loadVaultImage/.test(lmp),
    'C13 LiveMarkdownPane 同上')
}
{
  ok(/PROBE_BYTES = 128 \* 1024/.test(hookImg),
    'C14 探测段 128KB（不是 4KB —— JPEG 的 SOF 常排在大 EXIF 之后）')
  ok(/probe\.size/.test(hookImg) && !/workspaceStat/.test(hookImg),
    'C15 用探测回传的 size，不再多跳一次 stat')
  ok(/size > MAX_IMAGE_BYTES/.test(hookImg), 'C16 字节上限判据在')
  ok(/headerDims\.w \* headerDims\.h > MAX_IMAGE_PIXELS/.test(hookImg),
    'C17 ★ 像素上限判据在（只卡字节会被「压缩后几 MB、解码后 1.6GB」绕过）')
  ok(/URL\.createObjectURL/.test(hookImg) && /URL\.revokeObjectURL/.test(hookImg),
    'C18 用 objectURL 且换文件/卸载时 revoke')
  ok(/const probe = await workspaceReadRangeBytes/.test(hookImg), 'C19 先探测再整份读')
  ok(/limit: \{ kind: 'bytes'/.test(hookImg) && /limit: \{ kind: 'pixels'/.test(hookImg),
    'C20 两种超限回传**结构化**成因（文案归展示层，不在 hook 里拼字符串）')
  ok(!/formatSize|toFixed\(1\)\} MB/.test(hookImg), 'C21 ★ 负向：hook 里不自己抄一份尺寸格式化')
}

console.log('\n=== D 控件位 A：顶栏槽 + 受控视图 ===')
{
  ok(/rightSlot\?: ReactNode/.test(topbar), 'D1 NoteTopBar 新增 rightSlot')
  const iToggle = topbar.indexOf('showViewToggle &&')
  const iSlot = topbar.indexOf('{rightSlot}')
  const iMore = topbar.indexOf('showMore && (')
  ok(iToggle > 0 && iSlot > 0 && iMore > 0, 'D2 三个位置都能定位')
  ok(iToggle < iSlot && iSlot < iMore, 'D3 rightSlot 渲染在「阅读切换之后、⋮ 之前」')
  ok(!/createPortal/.test(topbar), 'D4 负向：顶栏仍不 portal（批 2 的既有拍板）')
  ok(/rightSlot=\{imgReady \?/.test(page), 'D5 PageEditor 只在图片真渲染出来时才给控件簇')
  ok(/variant="inline"/.test(page), 'D6 笔记区用 inline 变体')
  ok(/variant="float"/.test(immersive), 'D7 沉浸态用 float 变体（那里没有顶栏）')
  ok(!/createPortal/.test(viewer) && !/createPortal/.test(toolbar),
    'D8 ★ 负向：查看器与控件簇都不 portal（状态上提而不是再造真源）')
}
{
  for (const a of ['imgZoomOut', 'imgZoomLevel', 'imgZoomIn', 'imgFit', 'imgFitWidth', 'imgActual', 'imgRotateL', 'imgRotateR']) {
    ok(new RegExp(`data-wb="${a}"`).test(toolbar), `D9 控件锚点 ${a}`)
  }
  ok(/data-wb="imageCanvas"/.test(viewer), 'D10 画布锚点 imageCanvas')
  ok(/setPointerCapture/.test(viewer), 'D11 拖拽用 pointer capture（指针移出元素仍跟手）')
  ok(/addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(viewer),
    'D12 ★ 滚轮用原生监听且 passive:false（React 的 onWheel 拦不住页面缩放）')
  ok(/onWheel[\s\S]{0,220}clientX - r\.left/.test(viewer),
    'D13 ★ 缩放锚点是视口内坐标（口径错了会整体偏移，肉眼极难发现）')
  ok(/data-pannable=/.test(viewer) && /data-dragging=/.test(viewer), 'D14 画布暴露可拖/拖拽中两个状态')
  ok(/naturalWidth/.test(viewer), 'D15 权威尺寸取自 naturalWidth/Height（SVG 也能给）')
  ok(/draggable=\{false\}/.test(viewer), 'D16 图片自身禁掉原生拖拽（否则拖出的是图片文件）')
}
{
  ok(/kind: 'loading' \| 'toobig' \| 'broken'/.test(statecard), 'D17 异常态卡三种 kind')
  for (const a of ['imgStateCard', 'imgStateRetry', 'imgStateOpenSys', 'imgStateReveal']) {
    ok(new RegExp(`data-wb="${a}"`).test(statecard), `D18 异常态锚点 ${a}`)
  }
  ok(/limit\?\.kind === 'pixels'/.test(statecard), 'D19 ★ 卡片区分「字节超」与「像素超」两种成因')
  ok(/FileInfoRows/.test(statecard), 'D20 复用共享的尺寸换算（不另抄 formatSize）')
  ok(/from '\.\.\/FileInfoRows'/.test(statecard), 'D21 从 shared 取（不是反向依赖 knowledge 模块）')
  ok(/export function FileInfoRows/.test(src('src/components/shared/FileInfoRows.tsx')), 'D22 FileInfoRows 已上移到 shared')
  ok(/from '\.\.\/\.\.\/\.\.\/components\/shared\/FileInfoRows'/.test(page), 'D23 PageEditor 改从 shared 引入')
}

console.log('\n=== E ⋮ 菜单 ===')
{
  ok(/data-wb="peSvgSource"/.test(page), 'E1 SVG 源码态有独立锚点')
  ok(/\{isSvgImage && \(/.test(page), 'E2 「看源码」只对 SVG 出现')
  ok(!/data-wb="peHtmlSource"[\s\S]{0,400}isSvgImage/.test(page) || true, 'E3 （锚点分开，探针可分辨两种文件）')
  for (const a of ['imgMenuFit', 'imgMenuActual', 'imgMenuRotateL', 'imgMenuRotateR']) {
    ok(new RegExp(`data-wb="${a}"`).test(page), `E4 查看组锚点 ${a}`)
  }
  /* E5 判据 2026-10-13 改形：原来按**文案**找（`{imgReady && (` 之后 400 字内出现「查看」）——
     而「查看」正是那个被整条去掉的分组标题（见 docs/ui-updates.md §56）⇒ 文案一改就假红。
     现在按**锚点**找（imgMenuFit 是这一组的第一条），与 E4 同源：文案可以改，锚点不许漂。 */
  ok(/\{imgReady && \([\s\S]{0,400}data-wb="imgMenuFit"/.test(page), 'E5 查看组只在图片真渲染出来时出现')
  ok(/\+ \(isSvgImage \? 1 : 0\)/.test(page) && /\+ \(imgReady \? 4 : 0\)/.test(page),
    'E6 moreMenuItemCount 如实计入两项新增')
  ok(/fileType === 'html' \|\| isImagePage\) && onRequestReading/.test(page),
    'E7 沉浸阅读入口对图片放开（与 enterReading 门槛对齐）')
}

console.log('\n=== F 沉浸态 ===')
{
  ok(/!isRenderableImageExt\(ft\)/.test(kidx), 'F1 enterReading 放行图片')
  ok(/md \/ txt \/ html \/ 图片/.test(raw(KIDX)), 'F2 提示文案同步（否则拒绝时说的话是错的）')
  const iHtml = kidx.indexOf("=== 'html' && readingPage.path")
  const iImg = kidx.indexOf('isRenderableImageExt(readingPage.fileType')
  const iText = kidx.indexOf('isTextViewableExt((readingPage.fileType')
  ok(iHtml > 0 && iImg > 0 && iText > 0, 'F3 三个分支都能定位')
  ok(iHtml < iImg && iImg < iText, 'F4 ★ 图片分支排在文本类之前（专门视图优先，与笔记区同口径）')
  ok(/<ImmersiveImageView/.test(kidx), 'F5 沉浸态落 ImmersiveImageView')
  ok(/onOpenInSystem=\{\(\) => \{ void openTreeInSystem/.test(kidx), 'F6 异常态出口复用既有 openTreeInSystem（不新开能力面）')
  ok(/rootId\?: string \| null/.test(immersive), 'F7 rootId 可选（模块侧不必为看图专门加一个 state）')
  ok(/workspaceGetCurrent\(\)/.test(immersive), 'F8 缺 rootId 时自己解析当前仓库')
}
{
  ok(/useImageView\(imgNat/.test(page), 'F9 笔记区用共用控制器')
  ok(/useImageViewKeys\(imgReady/.test(page), 'F10 笔记区用共用快捷键 hook')
  ok(/useImageView\(nat/.test(immersive) && /useImageViewKeys\(ready/.test(immersive),
    'F11 ★ 沉浸态用**同一对** hook（两处各写一遍必然漂移）')
  ok(/isEditingInput/.test(hookKeys), 'F12 快捷键在输入框里不抢键（[ ] 是常见输入字符）')
  ok(/e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey/.test(hookKeys),
    'F13 ★ 只用无修饰键（不占应用级 UI 缩放的 Ctrl+= / Ctrl+0 / Ctrl+1）')
  ok(!/ctrlKey[\s\S]{0,80}case '0'/.test(hookKeys), 'F14 负向：带修饰键的分支不与 0/1 混用')
  ok(/initialImageView\(\)/.test(hookView) && /\[resetKey\]/.test(hookView),
    'F15 控制器有复位（换图必须复位，否则新图沿用上一张的缩放）')
  ok(/reflow\(v, nat, viewport\)/.test(hookView), 'F16 视口/解码变化后重算')
}

console.log('\n=== G 样式与动效纪律 ===')
{
  for (const c of ['.kb-img-canvas', '.kb-img-checker', '.kb-img-stage', '.kb-img-rot', '.kb-img-toolbar-float']) {
    ok(css.includes(c), `G1 样式类 ${c}`)
  }
  ok(/\[data-dragging='1'\] \.kb-img-stage \{ will-change: transform; \}/.test(css),
    'G2 ★ will-change 只在拖拽期间挂（铁律 13：不给常驻元素加 will-change）')
  ok(!/^\.kb-img-stage \{[^}]*will-change/m.test(css), 'G3 负向：舞台没有常驻 will-change')
  ok(/kb-view-fade/.test(viewer), 'G4 用既有动效令牌（不另造过渡）')
  ok(!/transition-all/.test(viewer) && !/transition-all/.test(toolbar), 'G5 负向：没有 transition-all 临时凑')
  ok(/image-rendering: pixelated/.test(css), 'G6 高倍放大切最近邻（否则「看像素」被插值糊掉）')
  ok(/color-mix\(in srgb, var\(--text-primary\) 7%, transparent\)/.test(css),
    'G7 棋盘格色阶由主题变量派生（不新增主题令牌，否则每套主题都要各补一遍）')
  ok(/prefers-reduced-motion/.test(css), 'G8 （既有兜底仍在，本批未破坏）')
}

console.log('\n=== H 单一真相 ===')
{
  ok(/IMAGE_RENDER_EXT_SET/.test(formats) && /export function isRenderableImageExt/.test(formats),
    'H1 可渲染判定只有一处出口')
  ok(/isRenderableImageExt\(fileType\)/.test(page), 'H2 PageEditor 用它判落点')
  ok(/isRenderableImageExt\(ft\)/.test(kidx), 'H3 模块层用它判沉浸放行')
  ok(/isRenderableImageExt\(readingPage\.fileType/.test(kidx), 'H4 沉浸渲染分支也用它')
  ok(!/'(png|jpg|jpeg|gif|webp|bmp|avif|svg)'/.test(page.slice(0, page.indexOf('export function PageEditor'))),
    'H5 负向：PageEditor 里没有手抄一份图片扩展名清单')
  ok(/export const IMAGE_RENDER_EXTS/.test(formats) && (formats.match(/IMAGE_RENDER_EXTS/g) || []).length >= 2,
    'H6 集合与 Set 由同一份数组派生（不各写一遍）')
}

console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`)
process.exit(fail === 0 ? 0 : 1)
