# 图片渲染与查看（设计文档 · 批 3）

> 状态：**已落码**（2026-10-13，v3.5.0 线）。真机验收清单见 `docs/batch3-real-machine-verification.md`。
> 原型：`tmp/image-viewer-proto/index.html`（3 视图 × 3 控件位 × 2 主题，`#mode=…&chrome=…` 可寻址）。
> 原型冒烟：`tmp/image-viewer-proto/_smoke.mjs`（结构 63/63）· `_math.mjs`（几何 36/36）。
> 契约：`.AGENT/scripts/image-viewer/verify-image-viewer.mjs`（124）· `verify-image-math.mjs`（75）。
> 上游口径：批 1 `docs/knowledge-content-routing-design.md` §8「图片渲染属批 3」· 批 2 `docs/nonmd-topbar-design.md` §四。

## 0. 落码结果（2026-10-13）

方案一字未改地落下来了，另有三处**方案里没写、落码时发现必须做**的：

1. **`FileInfoRows` 上移到 `src/components/shared/FileInfoRows.tsx`**。
   图片异常态卡要用它，而它原先住在 `src/modules/knowledge/components/FileMetaCard.tsx` ——
   shared 反向依赖 module 是层次倒挂。`formatSize` 一并搬走（它原本只服务那一行）。
2. **`MarkdownPreview` 的 `VaultRelImg` 补了「破图」分支**。
   原先加载中与失败**都**落「图片加载中…」⇒ 打错一个路径就是一个永远转不完的加载态。
   本批把仓库内任意图片路径都放开了，打错字的概率随之上升，这个坑必须一起填。
   ★ 与 `LiveMarkdownPane` 的 `ImageWidget` 对齐 —— 那边早就有 `kb-live-img-broken` 分支，
   属于两个消费者之间的行为漂移。
3. **图片控制器与快捷键抽成两个共用 hook**（`useImageView` / `useImageViewKeys`）。
   方案里写的是「状态上提到 PageEditor」，但图片有**两个宿主**（笔记区 / 沉浸阅读），
   两处各摊一份 state + 五个回调必然会漂移（改键位时漏一处，表象是「沉浸态按 0 没反应」）。
   落成 hook 后 `PageEditor` 只多 6 行接线。

另外**方案 §11 的开放项已拍板**：`avif` 收、`ico` 不收 —— `RANGE_EXT_WHITELIST` 加了 `avif` 一行，
理由写在该数组上方的注释块里（那一行明确要求「安全面变更须写明理由」）。
这是本批**唯一**一处主进程改动。

## 1. 一句话方案

在 `PageEditor` 的内容分支里补一格**图片视图**（排在 `isArchiveFile` 兜底之前），
取回走**既有的** `ws:readRangeBytes` 通道，缩放/旋转控件落在**顶栏右侧新增的一个槽**里，
并把 md 内联图片的取回从「附件区 data:URI」换成同一条通道 —— **主进程一行不改**。

## 2. 先更正一条我自己写错的前提

批 1 的设计文档 §11 留了一句：

> **批 3**：图片渲染（需要放开 `ws:readImage` 的附件区白名单，属安全口径变更，待拍板）。

**这个前提是错的。** 主进程早就有一条现成通道能读图片字节：

| | 通道 | 路径校验 | 扩展名白名单 |
|---|---|---|---|
| 老（附件专用） | `ws:readImage`（`electron/lib/workspaceManager.ts:803`） | `requireInside` | **附件区**（`.attachments/` / `.knowbase/_attachments/`） |
| 现成（阅读器共用） | `ws:readRange` / `ws:readRangeBytes`（同文件 `:870` / `:881`） | `requireInside` | **扩展名**（`:235`，**已含 png/jpg/jpeg/webp/gif/bmp/svg**） |

`RANGE_EXT_WHITELIST` 里的图片那七种是当初给 PDF 封面与漫画 cbz 加进去的，
PDF 阅读器 / TXT 阅读器 / foliate 系阅读器全在用。所以对**标准位图格式**：

- `ws:readImage` 一个字不用改，也**不扩它的白名单**；
- 不需要新开通道，不需要动 `pathGuard`；
- 「安全面变更」这件事本批**不存在**。

⚠️ **一处需要更正得更细的地方**：原型阶段我说过「avif / ico 顺手就能收」。**不准确** ——
`avif` 与 `ico` **不在** `RANGE_EXT_WHITELIST` 里，收它们要动主进程那一行，
而该行上方写着「扩容属**安全面变更**（提交信息须写明理由）」。
故本批的默认范围是**现有白名单与图片的交集**：`png / jpg / jpeg / webp / gif / bmp / svg`。
avif / ico 单列进 §11 开放项，等你一句话。

## 3. 拍板表

| # | 项 | 拍板 | 记录 |
|---|---|---|---|
| D1 | 格式范围 | `png / jpg / jpeg / webp / gif / bmp / svg`（不收 HEIC） | HEIC 要 `heic-to`（libheif WASM ~1MB）解码 + 白名单扩容，双份代价 |
| D2 | 能力面 | **标准套件**：适应窗口 / 缩放 / 1:1 / 适应宽度 / 拖拽平移 / 双击切换 / 左右旋转 / 透明棋盘格 | — |
| D3 | SVG | **默认当图片渲染**，⋮ 给「看源码」切文本编辑（照 html 那套） | — |
| D4 | 沉浸阅读 | **放行图片** | 要改 `enterReading` 的类型门槛 |
| D5 | md 内联 | **一并放开**（`![](图片/x.png)` 不再破图） | 渲染层换通道，主进程零改动 |
| D6 | 文件树缩略图 | **不做** | 「从文件树能打开、在笔记区看」 |
| D7 | 控件位 | **A 顶栏内联** | 图片时顶栏右侧本就只剩 ⋮，零新增行高；与批 2「统一顶栏」一脉相承 |
| D8 | 适应窗口放大 | **不放大，停在 100%** | VS Code / Obsidian 口径 |
| D9 | 底色 | **按格式自动**（png/gif/webp/svg 等可能含 alpha 的铺棋盘格；jpg/bmp 纯色） | — |
| D10 | ⋮ 菜单 | **放「查看」组**（适应窗口 / 实际大小 / 向左旋转 / 向右旋转） | 与批 2「⋮ 是非 md 全部动作的落点」一致 |

## 4. 新的分支顺序（唯一真相）

在批 1 定的七格链条里插一格，**位置与 PDF 并列**（两者都是「专门视图」）：

```
1  isMindMapFile && path                          → MindMapView
2  (isWelcomeHtml || isArchiveHtml) && path       → WelcomeHtmlView（htmlSource 为真时返回 null）
3  isXmindFile                                    → XMind 提示卡
4  isPdfFile && path && vaultRootId               → PdfReaderView
5  isImageFile && path && vaultRootId             → ImageViewer    ★ 本批新增
     └ svgSource 为真时返回 null（把这一格让给 paneDoc 的 Monaco）
6  archiveTextOpenable && reason==='oversize-edit' → ArchiveTextView（只读）
7  isArchiveFile && !archiveTextOpenable          → FileMetaCard（兜底）
8  isPdfFile                                      → legacy「旧版附件不在仓库内」
9  preview ? MarkdownPreview : paneDoc            → md / txt 知识页原有路径
```

**为什么是「返回 null」而不是把条件写成 `!svgSource`**：链条是嵌套三元，第 2 格
（html 源码态）就是这么做的 —— 条件不含 `!htmlSource`，靠内层返回 `null` 让位给
**兄弟块** `{paneDoc && editorEverMounted && …}`（`:1542`）。照抄这个形态，
契约 **A3/A5** 解析条件链先后时不必新增一条「互斥」语义。

### 4.1 SVG 源码态要接进文本落点

`svg` **不进** `TEXT_VIEWABLE_EXT_SET`。理由：那个集合是「文本类文件的落点候选」，
往里加 svg 会让**每次打开 SVG** 都触发一次自读 + `setPreview(false)`（白读一遍 XML），
只为了一个默认关闭的源码态。改为与 html 平行的一个开关：

```ts
const svgSourceEditable = isSvgImage && svgSource && !!page?.path
const textSelfReadTarget = isArchiveTextView || htmlSourceEditable || svgSourceEditable
const paneDoc = vaultMode && page?.path && !isPdfFile
  && (!isImageFile || svgSourceEditable)                 // ★ 新增
  && (!isWelcomeHtml || htmlSourceEditable)
  && (!isArchiveFile || archiveTextOpenable || htmlSourceEditable || svgSourceEditable)  // ★ 加尾项
```

`svgSource` 是一个与 `htmlSource` 平行的新 state，同样在 `pageId` 变化的 effect 里复位
（`:97` 那个 effect）。

## 5. 取回链路（本批的技术核心）

### 5.1 一次探测 + 一次读段，尺寸与上限都在探测里拿到

照 `PdfReaderView.tsx:630` 的既有惯例（先 `workspaceReadRange(root, rel, 0, 4096)` 探一下）：

```
① probe = readRangeBytes(root, rel, 0, 128*1024)
     ├ 返回 { bytes, size, truncated }  → size 就是真实文件大小，**不用再 stat**
     ├ size > MAX_IMAGE_BYTES(32MB)  → 落「过大」卡，**零浪费**（没读整份）
     └ dimsFromHeader(bytes)          → 像素尺寸（拿不到就跳过像素守卫，见 5.3）
② 若像素 > MAX_IMAGE_PIXELS(1e8)     → 落「过大」卡，**不解码**（防解码爆内存）
③ full = readRangeBytes(root, rel, 0, size)
④ new Blob([full.bytes], { type: imageMime(ext) }) → URL.createObjectURL
⑤ <img> onLoad → naturalWidth/naturalHeight 是**权威尺寸**（SVG 也能给），
   用它刷新顶栏副标题与适应比例
```

- 为什么探测用 128KB 而不是 4096：JPEG 的 SOF 段可能排在一个很大的 APP1（EXIF）之后，
  4KB 常常读不到。128KB 一次读的代价可忽略，且仍远小于整份。
- 为什么**不用** `ws:readImage` 的 data:URI：base64 多 33% 体积 + 一次 `atob` 全量解码。
  20MB 的图白白多 7MB 字符串，而 `Blob` 让 Chromium 在解码后自行回收。
- **为什么不用 `ws:stat`**：`readRangeBuffer` 已经把 `size` 回传了（`:314`），
  再 `stat` 一次是多余的一跳。

### 5.2 上限口径（两个，缺一不可）

| 常量 | 值 | 挡什么 |
|---|---|---|
| `MAX_IMAGE_BYTES` | 32 MB | 读字节与 IPC 的内存 |
| `MAX_IMAGE_PIXELS` | 1e8（1 亿像素） | **解码**后的内存 |

像素这一条不是摆设：一张 20000×20000 的 PNG 压缩后可能只有几 MB，
解码成 RGBA 是 **1.6 GB**。只卡字节数会被它绕过。

放在 `src/lib/imageFormats.ts` 里导出，**不走 `SETTINGS`** —— 与主进程
`MAX_EDIT_SIZE` / `MAX_OPEN_SIZE`（`workspaceManager.ts:31-32`）同一口径：
这是技术守卫，不是用户偏好（`AGENTS.md`「设置项的唯一真源」针对的是用户可调项）。

### 5.3 拿不到像素尺寸时的降级

`dimsFromHeader` 只认 PNG / JPEG / GIF / BMP / WebP 五种容器头，SVG 走属性解析。
**解析不出来就不拦**（不报错、不落卡），只靠 32MB 那条兜底 ——
宁可放一张大图进去让 Chromium 自己降采样，也不要因为解析器认不出一个冷门变体
就把用户能看的图判成不能看。

## 6. 受控组件切分（为什么不 portal）

批 2 已经拍过板：顶栏**行内渲染、不 portal**，理由是「真源在 `PageEditor`，
走 portal 等于再造一个真源」（`PageEditor.tsx:1180-1183`）。
而 D7 选的 A 方案要求控件**物理上长在顶栏里**，顶栏又在图片视图**上方** ——
组件没法往祖先的槽里塞东西，除非 portal。

所以状态**上提到 `PageEditor`**，两个组件都是**受控的纯视图**：

```
src/lib/imageView.ts                      纯几何：effNat / fitScale / clampPan / zoomAbout
                                          （原型里那四个函数原文搬过来，_math.mjs 的性质照旧成立）
src/lib/imageFormats.ts                   纯格式：可渲染集合 / mime / 是否可能含 alpha / 两个上限 / dimsFromHeader
src/components/shared/image/useVaultImage.ts   取回管线（probe → cap → read → blob → decode）
                                         返回 { status, url, natW, natH }；换文件/卸载时 revoke
src/components/shared/image/ImageViewer.tsx    画布：渲染 + 指针/滚轮/双击；**受控**（scale/rot/tx/ty 由外部传）
src/components/shared/image/ImageToolbar.tsx   控件簇；variant: 'inline'（顶栏槽）| 'float'（沉浸态）
```

`PageEditor` 侧新增的状态很少（6 个字段 + 4 个动作），真源仍在本组件 —— 与顶栏其余部分同款。

**沉浸态为什么用 `variant='float'`**：沉浸阅读按定义**没有顶栏**（批 2 的 `pdfImmersive` 就是把它藏掉），
所以那里没有槽可放。这是 A 方案的一个必然例外，不是口径分裂 —— 与 PDF 沉浸态
「藏掉顶栏、阅读器自己的栏留下」是同一个处理。

### 6.1 `NoteTopBar` 新增一个槽

```ts
/** 右簇中、`⋮` 之前的内联槽（批 3：图片的缩放/旋转控件）。
 *  与已退役的 `#editor-toolbar-slot`（悬浮胶囊的 portal 槽）无关 —— 那个是 portal，
 *  这个是行内 JSX，真源仍在调用方。 */
rightSlot?: ReactNode
```

渲染位置：`{showViewToggle && …}` 之后、`{showMore && …}` 之前（「控件在前、溢出在后」的常规次序）。
图片态下 `showViewToggle` / `showInline` / `showSaveDot` 三者全为假 ⇒ 右侧本来就只有 ⋮，
加了这个槽是**零新增行高**（D7 的全部理由）。

## 7. md 内联：换通道，不是加通道

`src/lib/attachmentImage.ts` 是 `ws:readImage` 在全仓的**唯一调用方**，
而它只有两个消费者：`MarkdownPreview` 的 `VaultRelImg`（`:357`）与
`LiveMarkdownPane` 的 `ImageWidget`（`:112`）。**两个消费者一行都不用改** ——
它们只调 `normalizeVaultRel` / `loadVaultImage` / `getCachedVaultImage`。

改三处：

| 处 | 现在 | 改成 |
|---|---|---|
| `normalizeVaultRel` | 只认 `.attachments/` / `.knowbase/_attachments/` / `_attachments/` 三个前缀，其余返回 null | 认**仓库内任意相对路径**；仍然拒绝：绝对路径、UNC、盘符、带 scheme 的 URL、剥掉 `./` `../` 后仍含 `..` 段的 |
| 取回通道 | `ws:readImage`（附件白名单） | `ws:readRangeBytes`（扩展名白名单，任意仓库内路径） |
| 缓存 | `Map<string, string>`（data:URI，无上限、永不释放） | 有上限的 LRU（120 条）+ 逐出时 `revokeObjectURL` |

**顺带修一个潜伏 bug**：缓存键现在是 `rel`，不带 `rootId` ——
换仓库后同一个 `rel`（比如 `图片/照片.png`）会命中**上一个仓库的图**。
改成 `rootId + '\0' + rel`。

**`ws:readImage` 本批不动**（留着但变成无调用方）。删它要动主进程四处
（handler / preload / `types/index.ts` / `ipc.ts`），本批的价值不在那儿；
建议单独一次清理提交，且那时才好判断有没有别的用途。这条进 §10「明确不做」。

## 8. 格式与图标补条目

`src/lib/fileTypes.ts` 现在**一个图片条目都没有** ⇒ 图片走兜底
（`monacoLang: 'plaintext'`、灰色 badge、`label` 等于大写扩展名）。
`src/lib/fileIcons.ts` 也没有图片图标 ⇒ 文件树里**每张图都显示通用文件图标**，
而这正是用户看到的第一眼。

补：

- `fileTypes.ts` 的 `INFO` 加 `png / jpg / jpeg / gif / webp / bmp / svg`
  （`monacoLang` 对图片无意义，给 `plaintext`；svg 给 `xml`，源码态要用）
- `src/assets/image.svg`（新，vscode-icons 风格）+ `fileIcons.ts` 的 `FILE_ICONS` 加映射

`FILE_LANG_OPTIONS`（「转换文件格式」菜单）**不加** —— 把 `.md` 改成 `.png` 是没有语义的
（与批 1 补 `csv`/`log` 时的同一条取舍）。

## 9. 快捷键

图片态下新增**无修饰键**四个：`0` 适应窗口 / `1` 实际大小 / `[` 向左旋转 / `]` 向右旋转；
`Ctrl+滚轮` 缩放（以光标为锚点）。

**刻意不占用 `Ctrl+=` / `Ctrl+-` / `Ctrl+0` / `Ctrl+1`** —— 那是应用级 UI 缩放的地盘，
抢过来代价远大于收益。落码前先 grep 一遍既有的全局快捷键表确认无冲突。

## 10. 明确不做（范围锁）

- **HEIC / HEIF**：要 `heic-to` 懒加载块 + 白名单扩容，双份代价（D1）。
- **avif / ico**：要动 `RANGE_EXT_WHITELIST` 那一行，属安全面变更 → §11 开放项。
- **文件树缩略图**（D6）。
- **图片编辑**（裁剪 / 标注 / 旋转后落盘）：本批只看，不改图。旋转是**视图态**，不写盘。
- **多图幻灯片 / 相邻图片翻页**。
- **md 图片的 `![[wiki 嵌入]]` 语法**：`normalizeVaultRel` 只管 `![](路径)` 那条。
- **`ws:readImage` 的删除**（§7 末）。
- **`⋮` 菜单改成描述符数组**（`:1170` 的 `moreMenuItemCount` 是手算式，有 drift 风险）：
  本批只按新增项**如实扩展**那个算式，重构留到专门一次。
- 编辑区既存待办（标注 callout / `==高亮==` / 题目围栏 / 禅模式等）不在本批。

## 11. 开放项（已拍板 2026-10-13）

**avif 收、ico 不收。**

- `avif` 已收：`electron/lib/workspaceManager.ts:235` 的 `RANGE_EXT_WHITELIST` 加了一行。
  该行上方明确写着「扩容属**安全面变更**（提交信息须写明理由）」，理由已写在注释块里，
  并进了提交信息。风险面与既有图片格式完全一致：只读、pathGuard 内、无写通道、
  渲染侧另受 32MB 与 1 亿像素两道守卫。
- `ico` 不收：仓库里罕见，不值得再动一次安全面。
- `heic` / `heif` 不收（同批）：要 `heic-to`（libheif WASM ≈1MB）解码 + 同样要扩白名单 —— 双份代价。

## 12. 门禁

| 门禁 | 预期 |
|---|---|
| `tsc --noEmit -p tsconfig.web.json` / `tsconfig.node.json` | 0 / 0 |
| `.AGENT/scripts/image-viewer/verify-image-viewer.mjs`（新） | 静态契约：分支顺序 / 上限常量 / 控件锚点 / ⋮ 组 / `rightSlot` / 格式集合 ⊆ 主进程白名单 / md 换通道 / `enterReading` 放行 / 无 `data:`+base64 残留 / LRU 有 revoke |
| `.AGENT/scripts/image-viewer/verify-image-math.mjs`（新） | **import 真的 `.ts`**（`node --experimental-strip-types`）跑 `src/lib/imageView.ts` + `src/lib/imageFormats.ts`：把原型 `_math.mjs` 那 36 条性质搬过来 + `dimsFromHeader` 五种容器头各造一段最小字节 |
| `.AGENT/scripts/image-viewer/probe-image-viewer.mjs`（新） | 实机探针（devbridge）：真机点开 PNG / SVG / 超限 / 损坏四种，读 `noteTopSubtitle` 与 `data-wb` 锚点；供另一个 agent 工具跑 |
| `verify-content-routing.mjs` | 同步 **A3/A5**（条件链多了一格，且 `paneDoc` 条件多两个尾项） |
| `verify-nonmd-topbar.mjs` | 同步 `moreMenuItemCount` 口径（图片多一个「查看」组） |
| `verify-note-topbar.mjs` | 同步新增的 `rightSlot` |
| `verify-note-surface.mjs` / `verify-page-split.mjs` | 应零影响（`paneDoc` 对**渲染态图片**恒 null，保活链不动） |
| `verify-workbench-shell.mjs` | 5 条既有 FAIL 与本批无关，不得变多 |
| `verify-help-retrieval.mjs` | 改完 `resources/help/` 后跑 |
| `verify-release-notes.mjs` | 改完 `CHANGELOG.md` + 重跑 `build-release-notes.mjs` 后跑 |

## 13. 收尾必做

- **CHANGELOG.md** 加一条（v3.5.0 段）→ 重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`
  （否则应用内更新说明停上一版且无报错，铁律 24）。
- **AI 手册同步**（`AGENTS.md`「工作流」最后一条）：本批用户可见行为变化明确，涉及
  `resources/help/笔记 · 写作模式与编辑器.md`（非 md 落点多了图片一档）、
  `resources/help/工作台左栏与文件树模式.md`（从文件树打开图片）、
  `resources/help/常见问题.md`（「为什么我的图在笔记里不显示」这类问答）、
  `resources/help/模块一览.md`（能力面）。
  重编流程见 `.AGENT/help-rewrite/README.md`，验收跑 `verify-help-retrieval.mjs`。
- **真机验收清单**写进 `docs/batch3-real-machine-verification.md`。

## 14. 关键文件

**新增**
- `src/lib/imageView.ts` · `src/lib/imageFormats.ts`
- `src/components/shared/image/{ImageViewer.tsx,ImageToolbar.tsx,useVaultImage.ts}`
- `src/assets/image.svg`
- `.AGENT/scripts/image-viewer/{verify-image-viewer.mjs,verify-image-math.mjs,probe-image-viewer.mjs}`

**修改**
- `src/modules/knowledge/components/PageEditor.tsx`（分支一格 / `svgSource` / `paneDoc` 两尾项 / `rightSlot` / ⋮ 查看组 / 快捷键 / 副标题）
- `src/modules/knowledge/components/NoteTopBar.tsx`（`rightSlot`）
- `src/modules/knowledge/index.tsx`（`enterReading` 放行 + 沉浸态图片分支）
- `src/lib/attachmentImage.ts`（换通道 / 放宽 `normalizeVaultRel` / LRU + revoke / 键加 rootId）
- `src/lib/fileTypes.ts` · `src/lib/fileIcons.ts`
- `CHANGELOG.md` · `electron/lib/releaseNotes/data.ts`（生成）
- `resources/help/*.md`（§13）
