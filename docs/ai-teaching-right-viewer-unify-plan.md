# AI 教学右侧栏统一方案（工件栏并入查看器）

- 日期：2026-11-23
- 状态：**已实现（2026-11-23）**；验收记录见 `docs/ui-updates.md` 同日条目
- 取代：`docs/ai-teaching-artifacts-pane-design.md` 中「工件栏是独立分栏」的布局前提
- 目标版本：3.58.0（新功能；版本号在确认实现后再抬）

## 1. 背景

AI 教学区右侧目前有两套并存的栏：

| | 右侧查看器 | 工件栏 |
|---|---|---|
| 入口 | 顶栏 `PanelRightOpen` / `Ctrl+Alt+B` | 点左栏文件 / 素材；AI 生成产物自动开 |
| 实现 | `src/modules/ai-teaching/right-viewer/RightViewer.tsx` | `src/modules/ai-teaching/ArtifactsPane.tsx` |
| 布局 | overlay 盖在右缘，中栏 `padding-right` 让位 | `ResizablePanel` 挤压中栏（默认 420，280–780） |
| 页签 | 网页 / 笔记 / 电子书 / 旁问 | md / 沙箱 HTML / 思维导图 / 图片 / PPT |
| 记忆 | 宽度 360–960 + 页签跨重启恢复 | 宽度 420 + 页签按会话恢复 |
| 额外 | — | `⤢` 全屏、底部「本次改动」、PPT「讲解此页」 |

两者还会互斥：打开查看器会自动收起工件栏（并弹 Toast）。

用户口径：**右侧只留一个查看器**，点文件统一在查看器新建页签；工件栏整体退役。

## 2. 已拍板口径

1. **工件栏整体退役**：文件、素材、AI 生成的示意图 / 导图 / 图片 / 讲义 / PPT 全部进查看器页签。
2. **只加一种新页签「文件」**：图片 / 导图 / PPT / 本地 HTML 共用这一种页签，内部按扩展名分派；不为它们各造一种页签类型。
3. **Markdown 预览优先**：点开 md 默认渲染预览，可一键切编辑；预览态要保留题单作答能力。
4. **AI 产物自动打开查看器**：生成开始时自动展开查看器并开「生成中」占位页签，完成后原地替换。
5. **查看器加全屏放大 `⤢`**：占满 AI 教学模块区域，`Esc` / 再点退出。
6. **记忆全走查看器口径**：宽度 360–960 跨重启记忆；文件页签与 AI 产物页签都跨重启恢复。
7. **「本次改动」清单直接去掉**：不再单独列，靠聊天记录回看。
8. **PPT「讲解此页」保留**：留在课件文件页签里。

## 3. 目标形态

```
┌ AI 教学模块 ─────────────────────────────────────────────┐
│ 左课程树 │ 中栏对话（padding-right 让位） │ 右侧查看器（overlay）│
│          │                              │ 页签：网页/笔记/电子书/旁问/文件 │
└──────────────────────────────────────────────────────────┘
```

- 右侧只有一个栏：查看器；中栏用 `padding-right` 让位（沿用现实现）。
- 全屏态：查看器 `left: 0; width: 100%` 覆盖整个模块区域（含左栏），`Esc` 退出。
- 删除：工件栏面板、贴边展开按钮、`⤢`（旧工件栏那枚）、宽度 420 记忆、`artOpen` 互斥逻辑、底部「本次改动」。

## 4. 页签数据模型

### 4.1 新增 `file` 页签（`src/modules/ai-teaching/right-viewer/viewerTabs.ts`）

```ts
export type ViewerPaneType = 'web' | 'notes' | 'books' | 'ask' | 'file'

/** 文件页签内部按扩展名 / 内容识别的种类（不是页签类型） */
export type FileKind = 'html' | 'image' | 'mindmap' | 'pptx'

export interface FileViewerTab extends ViewerTabBase {
  type: 'file'
  /** 仓库相对路径；生成中占位为空串 */
  relPath: string
  fileKind: FileKind
  /** AI 生成中占位：禁关，完成后原地替换 */
  generating?: boolean
  /** visual.html 的 slug / image 的 slug（空串回落 'image'） */
  slug?: string
  /** pptx 当前页（持久化；1 页 = 0） */
  page?: number
  /** 外部改动重读令牌（运行时，不持久化） */
  rev?: number
}
```

- `ViewerStateV2` **不升版本**：仍是 `v: 2`，`tabs` 联合新增 `file` 分支；旧存档解析不受影响。
- 生成中占位**不持久化**（与旁问草稿同一口径，`serializeViewerState` 过滤）。
- 页签 `id`：常规 `t_<uuid>`；生成中 `gen:<slug>`（与现有约定一致，完成后换成正式 tab id 或原地保留）。

### 4.2 文件分派规则（唯一入口）

`RightViewer` 暴露 `openFile(relPath, meta)`，所有入口都走它：

| 扩展名 / 内容 | 落到哪 | 说明 |
|---|---|---|
| `.md` / `.markdown` | **笔记页签**（已有） | `previewDefault: true`；可切编辑；题单可作答 |
| `.txt` | **笔记页签** | 只读预览不适用，直接编辑（plaintext） |
| `.json` | 读内容判断 | `kind:"mindmap"` → 文件页签（导图）；否则笔记页签 |
| `.html` / `.htm` | **文件页签**（html） | 复用 `ArtHtmlView`，`kbview://` 沙箱 |
| 图片（png/jpg/webp/gif/svg…） | **文件页签**（image） | 复用 `ImmersiveImageView` |
| `.pptx` | **文件页签**（pptx） | 逐页文本 + 上一页/下一页 + 讲解此页 |
| `.pdf` / `.epub` / `.fb2` | **电子书页签**（已有） | 统一到查看器，不再甩给系统程序 |
| 其它（zip/docx…） | 维持现状 | 外部程序打开 |

> 关键取舍：md 不新造「文件」页签，继续用现有「笔记」页签。它本来就是一个文件 = 一个页签，并且已经带有完整的 1s 防抖 + `expectedUpdatedAt` 冲突检测；再写一套只读/编辑管线必然漂移。

### 4.3 去重与路径键

- 笔记 / 文件 / 电子书页签统一用平台化 `pathKey` 去重（Linux 大小写敏感）。
- 同一路径再次打开 = 聚焦已有页签并 bump 重读，不新开。
- `parseViewerState` 恢复时同样按路径去重。

## 5. 新组件 `FilePane.tsx`

路径：`src/modules/ai-teaching/right-viewer/FilePane.tsx`

职责：只做「一个文件页签」的渲染与文件级动作，不持有壳状态。

```
props（在 paneContracts.ts 追加，全部可选，遵守“只追加不改已有字段”）
  initialRelPath, fileKind, generating?, slug?, rev?, page?
  onTitleChange?, onPageChange?, onOpenInEditor?, onOpenFileRef?
  onTalkPage?({ name, page, n, text })
```

- **html**：`<ArtHtmlView relPath reloadSeq={rev} fit />`（保留缩放 / 适配行为）。
- **mindmap**：`<MindMapView relPath reloadSeq={rev} showExport showSource onRef={onOpenFileRef} />`；节点 ref 点击 → 壳再开一个文件页签（左聊右看，不跳模块）。
- **image**：`<ImmersiveImageView relPath name sizeBytes reloadSeq={rev} />`。
- **pptx**：挂载 / `rev` 变化时 `docsPptxPages(rel)` 取页；页码 `page` 回写壳；「讲解此页」→ `onTalkPage`，由宿主发送到对话。
- **generating**：骨架 + 对应文案（示意图 / 思维导图 / 图片生成中），禁关。
- **动作行**（32px）：文件名、重读、复制路径；html 额外「在编辑器中打开」。
- **外部变更**：自己订阅 `onWsExternalChange` / `kb:file-saved`，命中本文件就 bump 本地重读序号（pptx 重新取页）；不依赖宿主。
- **异常态**：文件被删 / 读取失败 → 行内错误卡 + 关闭页签，不弹全局错误。

## 6. 壳层改动（`RightViewer.tsx` / `ViewerChrome.tsx` / `paneContracts.ts`）

1. **懒加载 FilePane**：`const FilePane = lazyPane(() => import('./FilePane'), 'FilePane')`，补 `paneFor` 的 `file` 分支。
2. **请求协议扩展**（现有 `request` 一次性通道）：
   ```ts
   {
     tab: ViewerPaneType
     seq: number
     // 已有：url / relPath / name / ask
     fileKind?: FileKind
     previewDefault?: boolean
     mode?: 'open' | 'begin' | 'commit' | 'drop'
     slug?: string
     page?: number
   }
   ```
   - `open`：普通打开（去重 / 聚焦）。
   - `begin`：AI 生成占位（按 `slug` 合并，不重复开；自动打开查看器）。
   - `commit`：占位原地转正式（按 `slug` 匹配；已存在同 relPath 页签则就地刷新）。
   - `drop`：生成失败 / 停止，清掉对应 `slug`（或全部）生成中占位。
3. **`+` 菜单**：不新增「文件」项（没有通用文件选择器；文件统一从左栏 / 素材 / 产物进入）。`VIEWER_TABS` 与 `TYPE_ICONS` 补 `file`（按 `fileKind` 显示 html / 图片 / 导图 / PPT 图标）。
4. **全屏 `⤢`**：
   - `ViewerChrome` 在关闭按钮左侧加 `Maximize2 / Minimize2`，`aria-expanded` + `data-tip`。
   - 壳内 `expanded` state；根节点 `left: 0; width: 100%; z-40`，拖动条禁用；`Esc` 退出；关面板时自动复位。
   - 全屏时向宿主上报宽度 0（中栏不需要让位），退出后恢复原宽度。
5. **宽度 / 记忆**：沿用 `useViewerWidth`（360–960，跨重启）；工件栏的 `aiTeachArtWidth` 不再读写。
6. **保活配额**：新增 `VIEWER_FILE_LIVE_CAP = 3`（html / 导图 / 图片重，超窗按 LRU 卸载，切回重建）；pptx 与其它共用窗口。
7. **`rightViewerPure.ts`**：`TAB_LABELS` / `isViewerTabKey` 补 `file`（契约脚本交叉断言两份取值一致）。

## 7. 宿主改动（`index.tsx`）

### 7.1 打开入口统一

新增 `openViewerFile(rel, opts)`：

- 读一次文件内容（仅 `.json` / 需要识别 mindmap 时）；
- 按 §4.2 分派为 `requestViewer({ tab: 'notes' | 'file' | 'books', ... })`；
- 替代现有 `openArtFile`，并统一以下调用点：
  - `AiTeachFileTree` 的 `onOpenMd / onOpenHtml / onOpenImage`
  - `CourseSources` 的 `onOpenFile`
  - 对话里的「整理成文档」「在工件栏打开」等入口
  - 导图节点 ref（`onOpenFileRef`）
- `requestViewer` 保持「打开请求即展开查看器」的行为。

### 7.2 AI 产物

- `visual.html` / `mindmap` / `image` 的 `agent:step` 事件：
  - `begin` → 文件页签占位（`generating` + `slug`），并自动展开查看器；
  - `commit` → 占位原地转正式；已存在同路径页签则原地刷新；
  - 失败 / 停止 → `drop`。
- 会话守卫保持不变：只处理当前会话的事件。
- 不再有「切会话清空工件页签 / 按会话恢复」：查看器页签全局持久化（用户已定）。

### 7.3 删除

- `ArtifactsPane` 渲染（含 `ResizablePanel` 工件分栏、`⤢` 全宽态、贴边展开按钮）。
- `artTabs / artActive / artOpen / artZoom / artPaneW / htmlSeq / artEdgeBtnRef / applyArtOpen / openArtTab / closeArtTab / reloadArtTab / openArtFile / syncSessionFiles 的工件分支 / talkArtPage / setArtPptxPage / artOpenInEditor / artOpenRef / changeOpensInArtifactPane`。
- `lastChanges` 状态与「本次改动」UI。
- `writeNav` 里的 `arts / artActiveRel / docRel / readerRel / readerPage` 写入（旧存档字段读取忽略即可）。
- 打开查看器时「先收起工件栏」的互斥逻辑与 Toast。

## 8. Markdown 预览优先 + 题单

### 8.1 预览默认

- `NotesViewerTab` 追加 `previewDefault?: boolean`；`makeNotesTab` 接受该参数；由 `openFile`（文件树 / 素材 / 文档产物）传 `true`。
- `NotesPane` 追加 `initialPreview?: boolean`，初始 `preview` 取它；新建空笔记仍从编辑开始。
- 预览 ↔ 编辑沿用现有的 `Eye / Pencil` 切换，不新造控件。

### 8.2 题单作答

- 把 `ArtifactsPane` 的题单接线搬进 `NotesPane` 预览分支：
  - `useQuizRecordStore({ pageId: relPath, relPath, pageTitle })`
  - `extractQuizzes(doc.content)` 有题时才渲染 `QuizSheetBar`
  - `QuizRecordContext.Provider` 包住 `MarkdownPreview`
- 只对 `fileKind === 'note'` 且 `.md` 生效；画像 / 要求不挂题单。

## 9. 删除 / 保留清单

| 对象 | 处理 |
|---|---|
| `src/modules/ai-teaching/ArtifactsPane.tsx` | 删除 |
| `src/modules/ai-teaching/artifacts.ts`（`ArtTab`） | 删除 |
| `src/modules/ai-teaching/ArtHtmlView.tsx` | **保留**，FilePane 复用 |
| `MindMapView` / `ImmersiveImageView` | **保留**，FilePane 复用 |
| `docs/ai-teaching-artifacts-pane-design.md` | 标注“布局前提已被本方案取代” |
| `aiTeach.artOpen` / `aiTeachArtWidth` / `aiTeach.nav.*.arts` | 停止读写；旧键静默忽略 |
| 「本次改动」底部清单 | 删除 |
| PPT「讲解此页」 | 保留到 FilePane |
| 查看器 `⤢` | 新增 |

## 10. 迁移与兼容

- 查看器持久化仍是 `v: 2`；旧存档（无 `file`）照常解析。
- 旧工件栏宽度 / 开合状态不再生效；首次打开查看器使用查看器自己的记忆宽度（默认 480）。
- 旧会话 `aiTeach.nav.{sid}.arts` 不再恢复（页签改为全局记忆）；不影响消息、课程进度、画像 / 要求。
- 已打开的文件页签在重启后重新按路径读盘；不持久化正文，避免存档膨胀与陈旧内容。
- 文件被删：文件页签显示错误态，可关闭；不阻塞其它页签。

## 11. 契约与验收

### 11.1 脚本更新

| 脚本 | 改动 |
|---|---|
| `.AGENT/scripts/ai-teaching/verify-right-viewer-tabs.mjs` | 新增 `file` 页签：make / find / 去重 / serialize / parse / live window / generating 不持久化 |
| `.AGENT/scripts/ai-teaching/verify-right-viewer-shell.mjs` | FilePane 懒加载、`file` 分支、全屏按钮与 `Esc`、无 ArtifactsPane、`tabLabel` 两份一致 |
| `.AGENT/scripts/ai-teaching/verify-artifact-tabs.mjs` | 改为验证「AI 产物 → 查看器 file 页签」的 begin / commit / drop 接线 |
| `.AGENT/scripts/ai-teaching/verify-ai-teaching-tools.mjs` | 工件栏断言改指 FilePane（图片 / 导图渲染） |
| `.AGENT/scripts/ai-teaching/verify-mindmap.mjs` | `ArtifactsPane` 目标改 `FilePane` |
| `.AGENT/scripts/ai-teaching/verify-teach-toolbar-ui.mjs` | 第 260 行读 `ArtifactsPane` 的段落改指 FilePane |
| `.AGENT/scripts/ai-teaching/verify-all-p0.mjs` | 清单维持 39 份，只改各脚本内部断言 |
| `.AGENT/scripts/ai-teaching/verify-viewer-tabs.mjs` | 补 file 与 notes 的跨类型去重断言 |

### 11.2 验收清单

- [ ] 左栏点 md / txt / json / html / 图片 / pptx / pdf：都在右侧查看器开页签，右侧不再出现第二个栏。
- [ ] 同一文件点两次：聚焦同一个页签，不重复开。
- [ ] md 打开是预览；切编辑可改；1s 防抖保存与冲突提示正常；预览里题单可作答。
- [ ] html / 导图 / 图片 / pptx 正常渲染；外部改动后原地刷新；删除后显示错误态。
- [ ] AI 生成示意图 / 导图 / 图片：查看器自动打开并出现「生成中」；完成后原地替换；失败自动清掉占位。
- [ ] PPT「讲解此页」仍能把当前页发给对话。
- [ ] `⤢` 全屏覆盖模块区域，`Esc` 退出；退出后宽度回到原值。
- [ ] 关闭应用重开：文件 / 产物页签与查看器宽度恢复。
- [ ] 工件栏相关入口 / 状态 / 存储键全部不再出现；`aiTeach.artOpen` 不再影响布局。
- [ ] `tsc` 双配置 0 错；`npm run build` 通过；`verify-all-p0` 全绿。

## 12. 风险与取舍

1. **md 用笔记页签而非文件页签**：减少一套编辑 / 保存管线，但「文件」页签的语义只覆盖非文本文件。已与用户口径对齐（问题只问图片 / 导图 / PPT / HTML）。
2. **页签全局持久化**：切会话不再清空产物页签，会话之间会互相看到对方产物；这是用户选择的“全走查看器口径”。路径都在仓库内，不存在权限问题。
3. **生成中页签不持久化**：重启时生成中的占位会消失，可能留下一个已生成但没打开的产物；产物仍可从左栏打开。
4. **保活配额**：同时打开很多重文件时旧页签会被卸载，切回重建（与网页 / 电子书现有行为一致）。
5. **全屏与网页原生视图**：`WebContentsView` 仍在 DOM 之上，全屏只改 DOM 几何；WebPane 的 ResizeObserver 会同步 bounds，需要实机验证一次。
6. **PDF 改走电子书页签**：与「点击文件统一进查看器」一致，但会改变原来“用系统程序打开”的习惯；如需保留外部打开，可在右键菜单保留「在系统中打开」。

## 12.5 冻结接口（子代理按此实现，禁止各自发挥）

> 多线并行时，**接口先冻结**；任何需要改签名的情况先回到主代理确认，不要自行改契约。

### A. `viewerTabs.ts`

```ts
export type ViewerPaneType = 'web' | 'notes' | 'books' | 'ask' | 'file'
export type FilePaneKind = 'html' | 'image' | 'mindmap' | 'pptx'

export interface FileViewerTab extends ViewerTabBase {
  type: 'file'
  relPath: string          // 生成中为空串
  fileKind: FilePaneKind
  generating?: boolean     // 生成中占位：禁关、不持久化
  slug?: string
  page?: number            // pptx 当前页（0 基）
  rev?: number             // 运行时重读令牌，不持久化
}

export interface NotesViewerTab extends ViewerTabBase {
  // ...既有字段
  previewDefault?: boolean // 文件树 / 素材点开：默认预览
}

export const VIEWER_FILE_LIVE_CAP = 3

export function makeFileTab(
  id: string,
  opts: { relPath?: string; fileKind: FilePaneKind; title?: string; generating?: boolean; slug?: string; page?: number },
  now?: number,
): FileViewerTab

export function isFilePaneKind(v: unknown): v is FilePaneKind
export function findFileTab(tabs: readonly ViewerTab[], relPath: unknown, opts?: { caseInsensitive?: boolean }): FileViewerTab | null
/** 跨类型去重：md 笔记页签与文件页签都可能占用同一路径，打开前先查这一条 */
export function findAnyPathTab(tabs: readonly ViewerTab[], relPath: unknown, opts?: { caseInsensitive?: boolean }): NotesViewerTab | FileViewerTab | null
```

- `serializeViewerState`：过滤 `type === 'file' && generating`；其余 file 只存 `relPath / fileKind / page`。
- `parseViewerState`：接受 `file`，`fileKind` 非法或 `relPath` 为空则丢弃；按路径去重。
- `selectLiveIds`：`file` 用 `VIEWER_FILE_LIVE_CAP`。
- `tabTitleOf`：file → `stemOf(relPath) || '文件'`；生成中保留标题。

### B. `paneContracts.ts`

```ts
export type { FilePaneKind } from './viewerTabs'

export const VIEWER_TABS = [
  { key: 'web', label: '网页' },
  { key: 'notes', label: '笔记' },
  { key: 'books', label: '书架' },
  { key: 'file', label: '文件' },
  { key: 'ask', label: '旁问' },
]

/** 宿主 → 壳的一次性请求（扩展现有 request） */
export interface ViewerOpenRequest {
  tab: ViewerPaneType
  seq: number
  mode?: 'open' | 'begin' | 'commit' | 'drop'
  url?: string
  relPath?: string
  name?: string
  ask?: unknown
  fileKind?: FilePaneKind
  previewDefault?: boolean
  slug?: string
  page?: number
}

export interface FilePaneProps extends ViewerPaneContext {
  request?: PaneOpenRequest | null
  initialRelPath: string
  fileKind: FilePaneKind
  generating?: boolean
  slug?: string
  rev?: number
  page?: number
  displayName?: string
  onTitleChange?: (title: string) => void
  onPageChange?: (page: number) => void
  onOpenInEditor?: (relPath: string) => void
  onOpenFileRef?: (relPath: string) => void
  onTalkPage?: (page: { name: string; page: number; n: number; text: string }) => void
}
```

`PaneOpenRequest` 保持原样（只加可选 `page?: number` 也可以，但 FilePane 主要用 `rev` 重读）。

### C. `RightViewer.tsx` 内部方法（不导出）

```ts
openFile(relPath: string, meta: {
  fileKind?: FilePaneKind
  title?: string
  previewDefault?: boolean
  page?: number
}): string   // 返回 tabId；同路径已开则聚焦

beginArtifact(input: { fileKind: FilePaneKind; slug?: string; name?: string; title?: string; page?: number }): void
commitArtifact(input: { fileKind: FilePaneKind; slug?: string; relPath: string; name?: string; title?: string; page?: number }): void
dropArtifact(slug?: string): void
```

`RightViewer` 新 props：

```ts
request?: ViewerOpenRequest | null
onTalkPage?: (page: { name: string; page: number; n: number; text: string }) => void
```

`rev` / `page` 的 patch 走现有 `patchTab`。

### D. `FilePane.tsx`

- `generating` 为真时只渲染骨架 + 文案，不读盘。
- `html / image / mindmap` 用 `rev` 作为重读令牌；`pptx` 在 `rev` 变化时重新 `docsPptxPages`。
- 自己订阅 `onWsExternalChange` 与 `kb:file-saved`，命中 `initialRelPath` 时本地 bump 重读序号；pptx 重新取页。
- 页码变化回调 `onPageChange`，由壳写回 `page`。
- 「讲解此页」只传 `{ name, page, n, text }`，发送逻辑留在宿主。

### E. 并行边界

- 同一文件同一时间只允许一个子代理改（铁律 21）。
- 子代理不改 `package.json` / `CHANGELOG.md` / release notes；版本与提交由主代理统一做。
- 子代理不跑 `git commit`、不跑 `git push`。

## 13. 实施顺序

1. 纯函数层：`viewerTabs.ts` / `rightViewerPure.ts` / `paneContracts.ts` + 契约脚本（先锁边界）。
2. `FilePane.tsx`（四种内容 + 生成中 + 外部变更 + PPT 讲解）。
3. 壳：懒加载、请求协议、页签图标 / 标题、全屏、保活配额、持久化。
4. `NotesPane`：预览默认 + 题单接线。
5. 宿主 `index.tsx`：统一入口、AI 产物 begin / commit / drop、删除工件栏整套。
6. 契约脚本与文档、CHANGELOG / 版本 / 更新说明。

## 14. 文档与版本

- `docs/ui-updates.md` 记录本次 UI 变更。
- `docs/ai-teaching-artifacts-pane-design.md` 顶部标注取代关系。
- `resources/help/` 需同步（用户可见行为变化）：
  - `模块一览.md`（工件栏 → 查看器）
  - `思维导图.md`（“右栏工件栏” → 查看器页签）
  - `AI 教学素材与代码.md`（点文件在查看器打开）
  - `AI 生图.md`（生成中占位在查看器；切会话不再自动恢复上次那张）
- 版本：新功能 → `3.58.0`；改 `CHANGELOG.md` → 重跑 `build-release-notes.mjs` → `npm run pack`。
