# AI 教学 · 右侧查看器改版 实现方案

> 2026-11-19 · 输入原型 `/home/lousync/桌面/Phrontis-右侧查看器-原型-2026-11-19.html`
>
> **一句话**：把 AI 教学现有右栏（进度 / 素材 / 支线）换成单一面板 —— **网页 / 笔记 / 书架 / 旁问**；面板是右侧 overlay（默认 480，可拖 360–960，状态持久化）。网页走主进程 `WebContentsView`，其余三个复用现有件，**不重建**阅读器 / 支线 / 笔记引擎。

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 替换 | `src/modules/ai-teaching/index.tsx` 的**右栏**（`ResizablePanel` + 进度/素材/支线，行 3807–3898） |
| 保留 | 中栏右侧的**工件分栏** `ArtifactsPane`（产物查看）；查看器打开时自动收起它（D3） |
| 新增 | `right-viewer/` 一套壳 + 四个 pane；主进程 `electron/lib/webPaneView.ts`（`WebContentsView`） |
| 复用 | 旁问 = `SideLaneCenter/SideLanePanel`；书架 = `pdfReaderListBooks` + 三个阅读器；笔记 = `NoteSurface` + `MarkdownPreview` + `workspaceReadFile/WriteFile`；拖拽 = `ResizablePanel` |
| 必带修复 | 现有宽度持久化是**空操作**：`aiTeach.*Width` 不在 `SETTINGS`，`settings:set` 静默返回 false（见 §1.6） |
| 待拍板 | D1 笔记是否可写 · D2 进度/素材去向 · D3 与工件栏同开 · D4 书架是否接受真实阅读器形态 |

---

## 1. 现状取证（代码事实）

### 1.1 四栏与右栏

`src/modules/ai-teaching/index.tsx`：

- 左栏 `ResizablePanel`（2850–2988）、中栏对话（2991–3751）、**工件栏** `ArtifactsPane`（3756–3778，原位放大副本 3782–3801）、**右栏**（3807–3898）。
- 右栏三按钮「进度 / 素材 / 支线」切 `railTab`，三个面板常驻 DOM 用 `hidden` 切显隐（3822 / 3834 / 3849）。
- 状态：`rightOpen`（意图，433）+ `srcVisible`（渲染，436）双态；`railTab` 持久化在 `aiTeach.railTab`（811–816）；快捷键 `Ctrl+Alt+B`（445–458）。
- 右栏底部还有「本次改动」列表（3861–3886），点击按 `changeOpensInArtifactPane` 决定进工件栏或编辑器。

### 1.2 工件栏（产物）

- 模型：`src/modules/ai-teaching/artifacts.ts:5-30` —— `kind: 'md'|'html'|'pptx'|'mindmap'|'image'`，**没有 web**。
- 开/关：`openArtFile`（511–543）、`openArtTab`（484–495）、`closeArtTab`（496–508）；宽度 `aiTeach.artWidth` 默认 420 / 280–780（3756–3760）。
- 内容驱动：`artExpanded = artTabs.length > 0`，首个页签出现自动展开（2250–2255）。
- md 页签是 `MarkdownPreview` **只读**；「编辑」= `kb-open-note` 跳到知识库（ArtifactsPane 280–285 → index.tsx 721–723 → App.tsx 909–925）。
- 会话级页签恢复：`localStorage['aiTeach.nav.' + sid]`（862–870 写、1136–1143 重放）。

### 1.3 支线旁问（现成）

- `SideLaneCenter.tsx`：`agentListSideLanes` 列支线，过滤 `lane==='main'`，带未读点、状态徽标、搜索；打开即 `agentMarkSideLaneRead`；详情复用 `SideLanePanel`。
- `SideLanePanel.tsx`：打开即固化快照（零 LLM），轮数 1/3/5，发送走 `agentChat`；底部「引用到主线」把**最后一条 assistant** 交给 `onQuote`（368–377）。
- 主线的「引用」是**胶囊队列**而不是裸文本：`quotes` / `quotesOpen`（368–369）、`quoteFromLane` 去重后塞 `[...prev, t].slice(-5)`（972–979）、发送时拼成 `> 【引用 i】…`（1186–1202）；**不自动发送**。
- 服务端 `agent:createSideLane` 的 `anchorMessageId` 允许为空：`anchor = anchorMessageId ? getMessageById(...) : null`（`electron/lib/agentService.ts:2640-2645`）⇒「问整段对话」的整段支线**不必新增 IPC**。

### 1.4 笔记

- 模块内**没有可编辑正文**（工件 md 只读），可复用编辑器有 `MonacoPane`（重，必须 lazy）、`LiveMarkdownPane`（CodeMirror，lazy）、`NoteSurface`（两者二选一 + 光标记忆）、`MarkdownPreview`（只读）。
- 文件 IPC：`workspaceReadFile`（含 `mtimeMs`）/ `workspaceWriteFile(..., expectedMtimeMs)`；冲突口径 `detectConflict`（2ms 容差，`electron/lib/workspaceManager.ts:354-366`）。
- **与 AGENTS 铁律 2「编辑器 = 唯一正文写入方」冲突** → 见 D1。

### 1.5 书架与阅读器

- 清单：`pdfReaderListBooks()` + `pdfReaderCoverList()`（`src/modules/bookshelf/index.tsx:67-102`）；进度：PDF 落 `.knowbase/modules/pdfReader.json`（`lastPage/totalPages/…`），其余落 `readerState.json`；阅读器自己写回，书架 `useDataChanged` 刷新。
- 阅读器 props：`PdfReaderView{rootId,relPath,name,backLabel,onBack,chrome:'full'|'reader-only'}`、`EpubReaderView`/`TxtReaderView` 同名少 `chrome`；**必须 lazy**（契约 `.AGENT/scripts/pdf-reader/verify-epub-formats.mjs` 负向断言）。
- 阅读器工具栏自带缩放 / 大纲 / 书签 / 护眼，容器窄时按 `.kb-fit-pdfread` 容器查询自动收起。

### 1.6 网页能力与宽度持久化（两个坑）

- **全仓没有 `WebContentsView` / `BrowserView` 先例**；`<webview>` 在 `electron/main/index.ts:1742-1746` 全局 `preventDefault`；CSP `frame-src` 不含 `https:`（`index.html:16`）⇒ 只能新写主进程 `WebContentsView`。
- `setWindowOpenHandler` 已把 http(s) 转系统浏览器（481–489）；`openExternal` 通道在（1414–1430）。
- 宽度键 `aiTeach.leftWidth/artWidth/rightWidth` **不在 `SETTINGS`**；`settings:set` 对未知键直接 `return false`（1018–1021）⇒ 现在拖完宽度其实没落盘。新面板要「记住宽度」必须先补键（§5.3）。

---

## 2. 目标 / 非目标

**目标**

1. 右侧只有一个查看器：四页签固定，顺序与图标照原型；无「进度」「素材」。
2. overlay：默认 480，拖 360–960，跟手无过渡，松手保留；关掉即消失、中栏铺满；单层淡阴影、无遮罩。
3. 切页签 150–200ms 淡入 + 轻微上移，容器高度不变。
4. 打开时恢复上次页签；宽度 / 开合 / 页签三项都持久化。
5. 网页：真实网页（`WebContentsView`），地址栏 / 前进后退 / 刷新 / 系统浏览器 / 登录态保留；最多 3 个内层页签。
6. 笔记 / 书架 / 旁问：复用现有数据与组件，不复制业务逻辑。

**非目标**

- 不做通用浏览器（不做书签、扩展、下载管理、多窗口）；
- 不把「进度」「素材」塞进查看器；
- 不重写阅读器引擎，不实现原型里的假分页双栏（见 D4）；
- 不新增 AI 工具，不动出题 / 讲义格式。

---

## 3. 交互定稿（对齐原型）

### 3.1 容器

- 位置：`position:absolute; top:0; right:0; bottom:0`，挂在 `rowRef` 行容器内（与 `ResizablePanel` 同级），z-index 高于中栏与工件栏。
- 背景 `--bg-primary` / 边框 `--border-color` / 单层阴影；**无 backdrop、无遮罩**。
- 中栏让位：`<section>` 加 `padding-right: var(--viewer-w)`，与面板宽度同一条 200ms 曲线；拖拽时两侧都 `transition:none`。
- 关闭：宽度收敛到 0 + 阴影消失；内容由 `overflow:hidden` 裁掉；不保留 12px 贴边条（开合统一走顶栏按钮）。

### 3.2 页签条

- 4 个 tab（网页 / 笔记 / 书架 / 旁问，各带内联图标）+ 右侧关闭 ×；不做 hover 下拉、不做右键菜单。
- 切换：目标 pane `absolute inset:0`，`display:none → flex` + 180ms `opacity/translateY(6px)`；容器高度由父级固定，**不跳动**。
- App 动效令牌：复用 `kb-view-in` 同源曲线（`--dur-std / --ease-kb`），不另造 transition。

### 3.3 宽度

- 默认 480；范围 360–960；`window.innerWidth` 不足时上限收到 `innerWidth - 300`（与原型一致，避免中栏不可读）。
- 拖左缘：`pointerdown + setPointerCapture`，4px dead-zone，实时改 `--viewer-w`；松手写盘；双击手柄回 480。
- 不接 `onSnapClose`（不折叠成贴边条）；关面板只走关闭按钮 / 快捷键。

### 3.4 键盘

- `Ctrl+Alt+B`：开 / 关查看器（沿用现有右栏快捷键；焦点在输入框内不拦截）。
- `Esc`：焦点在查看器内且没有浮层时关闭查看器。
- 网页内层页签 `Ctrl+T`（新建）/`Ctrl+W`（关闭）只在该页签聚焦时生效——**需主进程 `before-input-event` 转发**（可选，P2）。

### 3.5 状态文案

- 所有提示走 `showToast`；禁止 `alert/confirm`；空态 / 失败态用行内卡片（无中央模态）。

---

## 4. 文件改动清单

### 4.1 新增

| 文件 | 作用 |
|---|---|
| `src/modules/ai-teaching/right-viewer/RightViewer.tsx` | 壳：页签、开合、宽度、持久化、空态 |
| `src/modules/ai-teaching/right-viewer/WebPane.tsx` | 地址栏 / 内层页签 / 加载态 / 失败态占位（真实像素由主进程视图覆盖） |
| `src/modules/ai-teaching/right-viewer/NotesPane.tsx` | 文件列表 + 编辑器 / 预览 + 保存状态 |
| `src/modules/ai-teaching/right-viewer/BooksPane.tsx` | 书架列表 + 阅读器宿主 + 返回书架 |
| `src/modules/ai-teaching/right-viewer/AskPane.tsx` | 包 `SideLaneCenter`，补「问整段对话」与 scope 徽标 |
| `src/modules/ai-teaching/right-viewer/paneBounds.ts` | 把占位 div 的 CSS rect 换算成窗口 DIP（乘 UI zoom） |
| `electron/lib/webPaneView.ts` | `WebContentsView` 单例管理：create/show/hide/setBounds/close + 安全钩子 |
| `electron/database/repositories/webPaneRepo.ts` | `webPane:*` IPC 注册（沿用 33 个 `registerXxxHandlers()` 惯例） |
| `.AGENT/scripts/ai-teaching/verify-right-viewer.mjs` | 新契约（§10） |
| `docs/ai-teaching-right-viewer-plan.md` | 本文 |

### 4.2 修改

| 文件 | 改动 |
|---|---|
| `src/modules/ai-teaching/index.tsx` | 删右栏 3807–3898；挂 `RightViewer`；顶栏「展开右栏」改为查看器开关；`railTab` 退役；支线锚点 → 打开查看器「旁问」；快捷键 |
| `src/components/shared/ResizablePanel.tsx` | 新增 `overlay` 模式（absolute + `onWidthChange`）；其余拖拽契约不动 |
| `src/lib/settings.ts` | 新增 `aiTeach.rightViewerWidth`，并补回 `aiTeach.leftWidth/artWidth/rightWidth`（§5.3） |
| `src/modules/ai-teaching/SideLaneCenter.tsx` | scope 徽标（整段 / 第 N 条回答）、「问整段对话」入口、列表时间 / 未读 |
| `src/modules/ai-teaching/SideLanePanel.tsx` | 支持空锚点（整段）；「引用到主线」下放到**每条 AI 回答**；详情头显示来源 + 摘要 |
| `electron/lib/sideLaneMeta.ts`（或在 `agentService`） | 派生 `anchorOrdinal`（第 N 条回答），避免渲染层扫消息 |
| `src/lib/ipc.ts` / `electron/preload/index.ts` / `src/types/index.ts` | `webPane:*` 封装与类型 |
| `electron/main/index.ts` | register webPane handlers；窗口关闭时 dispose；`app:openExternal` 复用 |
| `src/styles/index.css` | 仅补容器查询（360–430px 的笔记列表 / 阅读器字号），其余用 Tailwind 令牌 |

---

## 5. 状态与持久化

### 5.1 键

| 键 | 值 | 说明 |
|---|---|---|
| `aiTeach.rightOpen` | `'1' / '0'` | 沿用现有键（开合意图） |
| `aiTeach.rightTab`（新） | `web / notes / books / ask` | 上次页签；默认 `web` |
| `aiTeach.rightViewerWidth`（新） | number | 走 `SETTINGS`（见 5.3），默认 480 |
| `aiTeach.webTabs`（新，内存优先） | `[{url}]` | 内层网页页签，最多 3；可只存 URL |

**迁移**：首次升级时若存在 `aiTeach.railTab === 'lanes'` → `rightTab='ask'`；否则 `web`。`aiTeach.railTab` 停止写入，保留一个版本后清理。

### 5.2 页面内状态

- 网页：每个内层页签一个主进程 view id（`w1..w3`）+ URL / title / canGoBack / canGoForward / loading（事件回传）。
- 笔记：当前文件、mtime、脏标记、保存定时器（组件内）。
- 书架：`shelf | reader`、当前书 relPath；阅读位置由阅读器 JSON 负责。
- 旁问：列表 / 详情（`SideLaneCenter` 内已有），整段 or 锚定。

### 5.3 宽度持久化修复（必做）

`SETTINGS` 增 4 个 `type:'number'`、`scope:'global'`、`ui:false` 的键（`src/lib/settings.ts`）：

```ts
aiTeachLeftWidth / aiTeachArtWidth / aiTeachRightWidth / aiTeachRightViewerWidth
```

键名沿用现有 `storageKey`（`aiTeach.leftWidth` 等）需要确认 `SETTINGS` 允许点号 key；若不允许，则统一改为下划线并做一次读迁移。**验收脚本必须断言「写入后再读回得到同一值」**——现在的静默丢弃就是没这条断言。

---

## 6. 四个页签

### 6.1 网页（新能力，风险最高）

**结构**：查看器内是「浏览器 chrome（渲染层）+ 一块透明占位 + 主进程原生视图」。

**主进程** `electron/lib/webPaneView.ts`：

```ts
interface WebPane { view: WebContentsView; win: BrowserWindow; visible: boolean }
const panes = new Map<string, WebPane>()   // 最多 3 个，按需创建

create(id, url):
  new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    partition: 'persist:aiTeachWeb',      // 登录态 / cookie 跨重启保留
    webSecurity: true, spellcheck: false
  }})
  win.contentView.addChildView(view)
  view.setVisible(false)
```

- **安全四件套**（缺一不可）：
  1. `setWindowOpenHandler` → 一律 `deny`；http(s) 转 `shell.openExternal`；
  2. `will-navigate` / `will-redirect` → 只放行 `http:`/`https:`，`file:`/`javascript:`/`data:`/自定义 scheme 一律 `preventDefault`；
  3. `session.setPermissionRequestHandler` + `setPermissionCheckHandler` → 全拒（摄像头 / 定位 / 通知 / 剪贴板读取）；
  4. `will-download` → `preventDefault()` + Toast「原型/本期不下载」。
- **不挂 preload**；页面拿不到任何 `window.api`。宿主 CSP / sandbox 与它无关，边界全靠以上四处。
- **bounds**：渲染层把 `#webSlot` 的 `getBoundingClientRect()`（CSS px）发给主进程；主进程 × `getEffectiveUiZoom(win)`（`electron/main/uiZoom.ts:60`）后 `setBounds`，并夹在窗口内容区内。缩放 / 分栏拖动 / 窗口 resize 都要重发（rAF 合并）。
- **可见性**必须由宿主逐项上报，因为**原生视图永远盖在 DOM 上**：面板关闭 / 切到其它页签 / 工件原位放大 / 窗口最小化 / 打开会盖住面板的浮层 → 一律 `hide`；重新进入 `show`。可复用 `pdfEvents.ts` 的 `hasVisiblePdfReader`（`offsetParent === null`）可见性口径。
- **导航**：`webContents.navigationHistory.canGoBack()/goBack()`（Electron 33 已支持）；事件 `did-navigate`、`did-navigate-in-page`、`did-start-loading`、`did-stop-loading`、`did-fail-load` 回传渲染层。
- **加载失败**：渲染层在占位区显示「无法加载 / 不联网」卡片，同时 `hide` 原生视图（避免白屏盖住占位）。
- **内层页签**：每个页签一个 view（按需创建、关闭即 `destroy`）；共用 `persist:aiTeachWeb` 分区（登录态跨页签、跨重启保留）。选 3 个 view 是因为主进程导航历史无法按「标签」拆分；内存代价可接受（最多 3 个页面）。
- **zoom**：页面自身缩放保持 100%，不跟随界面缩放；只做 bounds 换算。

**渲染层** `WebPane.tsx`：地址栏、← → ⟳、系统浏览器、内层页签条（最多 3、可关）、加载进度、失败卡片、右侧账号 chip（静态「已登录」装饰；真实登录态由站点自己显示）。

### 6.2 笔记

- **文件列表**：当前会话文件夹（`{MM-DD 标题}/`）与 `产物/` 下的 `*.md` / `*.txt`，用 `workspaceListDir` + `workspaceStat` 取 mtime，按最近修改排序，最多 5 条；切会话重扫。
- **编辑**：`NoteSurface`（lazy，按用户 `editorWritingMode` 选 Monaco / CodeMirror）+ `MarkdownPreview` 预览；原型里的 textarea 只是轻量示意，产品沿用单写者引擎。
- **保存**：输入 → `未保存`；1s 防抖 → `workspaceWriteFile(rootId, rel, text, mtimeMs)`；成功 → `已保存 · HH:MM` 并回填 mtime；`conflict` → Toast + 重读（`PageEditor` 同款处理，1037–1065）。
- 切文件 / 切页签 / 关闭面板前 flush 一次。
- **取舍**：见 D1（铁律 2）。

### 6.3 书架

- 列表：`pdfReaderListBooks()` + `pdfReaderCoverList()`；封面复用 `BookCover`（`PdfCover` 必须 lazy），4 本起，按 `updatedAt` 倒序；进度条 = `lastPage/totalPages` 或非 PDF 的 `pct`。
- 打开：按 `bookEngineOf(relPath)` 挂 `PdfReaderView` / `EpubReaderView` / `TxtReaderView`（全部 `lazy + Suspense`）；PDF 用 `chrome="reader-only"`，返回按钮复用阅读器自带 `onBack/backLabel`（若该阅读器没有返回钮，查看器的书架条补一个）。
- 进度：阅读器自己写 JSON；书架 `useDataChanged('pdfReader'|'readerState'|'knowledge')` 重读；返回书架即看到新进度。
- **与原型差异**：原型是手写假文本双栏 + 自造 A-/A+/纸张主题；产品用真实阅读器（滚动/分页由引擎决定，工具栏是阅读器自己的）。见 D4。

### 6.4 旁问

- 列表：`agentListSideLanes`；徽标 `整段` / `第 N 条回答`（`anchorOrdinal` 由 `sideLaneMeta` 派生）；时间 + 未读点；顶部「＋ 问整段对话」。
- **问整段对话**：`agentCreateSideLane({ parentSessionId })` **不传 anchor**（服务端已支持），创建后打开详情；面板头显示「已读整段对话」。
- 详情：复用 `SideLanePanel`（`hideTurns`、`onBack`、`onQuote`）；头一行来源（整段 / 锚定），第二行两行截断摘要（`AgentSideLaneInfo.excerpt`）。
- **引用到主线**：从「底部一个」改为**每条 AI 回答一个**（`SideLanePanel` 消息渲染处），点击仍走 `onQuote` → 主线引用胶囊队列，**不自动发送**（现成逻辑 972–979）。
- 只读边界：该面不挂「写文件 / 出题 / 改大纲」类按钮；现状 `SideLanePanel` 只有引用/浮出，审一遍即可。

---

## 7. 与现有四区布局的整合

### 7.1 右栏退役

- 删除 3807–3898 的右栏块；顶栏「展开右栏（进度 / 素材 / 支线）」按钮改为查看器开关；`Ctrl+Alt+B` 沿用。
- 支线锚点 chip 的「已开 / 就这点追问」仍走 `centerReq`，落到查看器 `ask` 页签（先切页签再发请求）。
- 底部「本次改动」列表：随右栏一起移走，落到工件栏底部（`ArtifactsPane` footer）或左栏资源管理器顶部的一条细栏——**D2 一并拍**。

### 7.2 进度 / 素材（D2）

| 原位置 | 建议去处 | 理由 |
|---|---|---|
| 右栏「进度」（`CourseProgress`） | 顶栏「本段 3/8」chip → 锚定浮层 | 组件现成；浮层不占列；不违反「禁中央模态」 |
| 右栏「素材」（`CourseSources`） | 左栏资源管理器表头加「文件 / 素材」分段 | 不新增左栏轨道（现 4 轨），改动最小；素材本来就是文件 |

### 7.3 工件栏同开（D3）

- 查看器打开时若工件栏已展开：自动 `applyArtOpen(false)`（只收不关，页签保留），并 Toast 一次「工件栏已收起，查看器占用右侧」。
- 理由：1440 下左 248 + 工件 420 + 查看器 480 = 1148，中栏只剩 292，不可读；查看器本身就是「查资料」的主入口。
- 关查看器不自动重开工件栏（避免「关一个开一个」的抖动），顶栏 chip 一键恢复。

---

## 8. 安全与边界（网页）

- 不新增 `<webview>`，不改 `index.html` 的 CSP `frame-src`。
- `WebContentsView` 权限四件套见 6.1；`sandbox/contextIsolation/nodeIntegration` 与主窗同规。
- 外部协议：`mailto:` / `tel:` 等一律 `deny`（或转系统，需单列白名单）。
- 登录态：`persist:aiTeachWeb` 持久分区；**不清 cookie**（面板关闭只 `hide`，不 `destroy` 活动页签；真正关闭页签才 destroy）。
- 原生视图与 DOM 的层级是硬约束：任何盖在页面区域上的自绘浮层（地址建议、下拉）都要么限制在 chrome 区，要么临时 `hide` 视图。
- UI 缩放：`setBounds` 必须乘 `getEffectiveUiZoom`；否则 125%/150% 下偏移。

---

## 9. 动效 / 空态 / 可访问性

- 页签切换 180ms（`--dur-std` + `--ease-kb`）；面板开合 200ms（宽度 + 阴影）；拖拽 `transition:none`；全部尊重 `prefers-reduced-motion`。
- 空态：网页无页签 / 笔记无文件 / 书架无书 / 旁问无支线，各一张行内说明卡 + 一个主操作。
- 失败态：网页 `did-fail-load`、笔记冲突、阅读器装载失败，都用行内卡片 + Toast，不弹模态。
- 焦点：面板打开时焦点进页签条；关闭后焦点回触发按钮；`aria-selected` / `role=tab` / `role=tabpanel` 补齐。

---

## 10. 契约脚本与验收

### 10.1 新增 `.AGENT/scripts/ai-teaching/verify-right-viewer.mjs`

断言面（静态 + 纯函数）：

1. 查看器只有 4 个 tab，源码无 `进度`/`素材` 作为 tab 文案；
2. `SETTINGS` 含 `aiTeach*Width` 且 `settings:set` 可写回（读回同值）；
3. `webPane` 注册了 `setPermissionRequestHandler`/`setWindowOpenHandler`/`will-navigate`/`will-download` 四道；
4. `setBounds` 链路调用 `getEffectiveUiZoom`；
5. 切页签 / 关面板 / 工件放大都调用 `hide`；
6. 笔记写入带 `expectedMtimeMs`；
7. 旁问「引用」不触发 `agentChat` / 不自动发送；
8. 阅读器仍然 `lazy`（与 `verify-epub-formats.mjs` 的口径一致）。

### 10.2 复跑

```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
node .AGENT/scripts/shared/verify-resizable-panel.mjs
node .AGENT/scripts/ai-teaching/verify-side-lane-center.mjs
node .AGENT/scripts/ai-teaching/verify-artifact-tabs.mjs
node .AGENT/scripts/pdf-reader/verify-epub-formats.mjs
node .AGENT/scripts/help-kb/verify-help-retrieval.mjs   # 文档同步后
```

### 10.3 手工清单（对齐原型 8 条）

1. 拖 360 / 960 夹紧，松手保持，刷新后仍保持；
2. 四页签切换无跳动、有 180ms 动效；
3. 网页：地址栏回车 → 后退 → 前进 → 错误页；关面板后重开回到网页；
4. 笔记：输入「未保存」→ 1s「已保存 · 时间」；冲突时 Toast + 重载；
5. 书架：翻 3 页、目录跳页、返回书架进度变化；
6. 旁问：引用后主线出现引用胶囊，消息未发送；
7. 关面板再开回到上次页签；
8. 控制台无报错；Network 无本机以外的非预期请求（真实网页除外，桌面端另测）。

---

## 11. 发版与文档

- 版本：**v3.45.0**（新功能，抬 minor）。
- `CHANGELOG.md` 新段 → 跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`（否则应用内更新说明停上一版且无报错）→ `npm run pack` → 发布脚本；`git push` 等用户明确指令。
- help 同步：`resources/help/AI 教学 · 课程模式.md`、`resources/help/AI 教学素材与代码.md`（右栏/素材描述）+ 跑检索验收。
- 落码后本文移入 DP `Phrontis/已实现设计文档/` 并在 `docs/DESIGN-ARCHIVE.md` 登记。

---

## 12. 已拍板（2026-11-19 追记）

> 本节原为「不拍板不动手」的表；四项已在决策文档里连同 D 组一起定案，这里只留**落地口径**，避免两份文档互相打架。
>
> 注意：本节编号是本方案自己的 D1–D4，**不要**与决策文档的 D1–D8（笔记形态 / 格式 / 布局 / 外部文件…）混读。

| # | 问题 | 定案 | 落地口径 |
|---|---|---|---|
| **D1** | 笔记页签是否允许直接改正文？ | **可写**（决策文档 D1 已定：Markdown 编辑器，打开的文件也可编辑） | 会话笔记与右侧打开的 md / txt 共用同一个编辑器（`NoteSurface`），默认编辑态，1s 防抖自动保存 + `expectedMtimeMs` 冲突检测；AGENTS 铁律 2 的措辞按「查看器只做会话内速记」理解，正式正文仍以编辑器为准，「在编辑器中打开」入口保留 |
| **D2** | 进度 / 素材 / 本次改动 去哪？ | **按本节选项 A**（用户 2026-11-19 确认） | 进度 → 顶栏「本段 3/8」chip 点开浮层（复用 `CourseProgress`）；素材 → 左栏资源管理器表头「文件 / 素材」分段（复用 `CourseSources`）；本次改动 → 工件栏底部一条细栏。查看器里**不出现**这三块 |
| **D3** | 查看器与工件栏同开 | **A：查看器打开时自动收起工件栏** | 只收不关（页签保留）+ 一次 Toast；关查看器不自动重开 |
| **D4** | 书架形态 | **A：直接用真实阅读器** | 三款阅读器 `lazy` 挂载、`chrome="reader-only"`；不设自定义固定工具条（决策 D3）；窄栏适配只加容器类，不改阅读器源码 |

**仓库外文件**（决策 D4）：本批**只支持仓库内文件**（用户 2026-11-19 确认）。渲染层永不接触绝对路径；等 P1 素材链路把 `{课程}/.cache/external/<hash>/` 落地后，再统一接入「小文件复制 / 大文件只读 token」两条通道，避免两套缓存实现。

---

## 13. 实施顺序（建议）

1. **P0 壳 + 持久化**：`RightViewer` 四页签 + overlay + 宽度键修复 + 迁移；其余三页先占位。
2. **P1 旁问 + 书架**：复用件接入（风险低、用户价值高），同时把右栏进度/素材按 D2 迁走。
3. **P2 笔记**：按 D1 定案接 `NoteSurface` + autosave + 冲突处理。
4. **P3 网页**：主进程 `WebContentsView` + 安全四件套 + bounds/隐藏 + 3 内层页签；最后接地址栏/历史。
5. **收尾**：动效/空态/a11y、契约脚本、help 文档、发版。

---

## 14. 落地进度（2026-11-19 第一批）

> 本批一次性把 §13 的 1–4 全部落码（六条并行线），门禁全绿；P5 收尾（help / 发版）未做。

### 已完成

| 层 | 文件 | 说明 |
|---|---|---|
| 主进程 | `electron/lib/webPaneView.ts` | `WebContentsView` 管理：最多 3 个、`persist:webtabs`、安全四件套、`getEffectiveUiZoom` 换算 bounds、导航事件回传 |
| 主进程 | `electron/database/repositories/webPaneRepo.ts` | `webPane:*` 12 个 handler（窗口取自 `event.sender`） |
| 主进程 | `electron/lib/agentService.ts` · `agentSessionRepo.ts` | `sideScope`（conversation / anchor / selection）+ `anchorOrdinal` 派生；**整段旁问每轮现算**（C9，24k / 单条 6k），不再落快照 |
| 壳 | `right-viewer/RightViewer.tsx` · `viewerResize.ts` · `rightViewerPure.ts` | 四页签 + overlay + 8px 手柄（4px dead-zone / 双击回 480）+ `aiTeachRightViewerWidth` 持久化 + 旧 `railTab` 迁移 + `onWidthChange` 上报 |
| 页签 | `WebPane.tsx` · `webPanePure.ts` | 地址栏 / 前进后退 / 刷新 / 3 内层页签 / 加载与失败态；bounds 走 rAF 合并；失败必 hide 原生视图 |
| 页签 | `NotesPane.tsx` · `notesPanePure.ts` | 会话夹 + `产物/` 的 md/txt 列表、`NoteSurface` 编辑（默认编辑态）、1s 防抖 + `expectedMtimeMs`、冲突不覆盖本地输入 |
| 页签 | `BooksPane.tsx` · `booksPanePure.ts` | 书架清单 + 三款阅读器 lazy 复用（PDF `chrome="reader-only"`）、进度按 `(rootId, relPath)` 共享、不设自绘工具栏 |
| 页签 | `AskPane.tsx` · `askPanePure.ts` | 列表按 scope 分组徽标（整段 / 第 N 条）、「问整段对话」= 空锚点、详情复用 `SideLanePanel`、每条回答可引用 |
| 接线 | `src/modules/ai-teaching/index.tsx` | 删右栏；挂 `RightViewer`；中栏 `padding-right` 让位；查看器打开自动收工件栏（D3）；顶栏入口改查看器；`Ctrl+Alt+B` 沿用 |
| 接线 | `ArtifactsPane.tsx` | 底部「本次改动」细栏（D2） |
| 接线 | 左栏资源管理器 | 表头「文件 / 素材」分段，素材 = 原 `CourseSources`（D2） |
| 接线 | 中栏段头「进度」 | 改为 `AnchoredLayer` 浮层里的 `CourseProgress`（D2） |
| 接线 | `src/App.tsx` | `kb-open-book` 事件：右侧书架「全屏阅读」回书架模块（D8） |
| 设置 | `src/lib/settings.ts` | 新增 `aiTeachLeftWidth` / `aiTeachArtWidth` / `aiTeachRightViewerWidth`（修复「拖完宽度不落盘」） |
| 契约 | `.AGENT/scripts/ai-teaching/verify-{right-viewer-shell,web-pane-security,web-pane-renderer,notes-pane,books-pane,ask-pane}.mjs` | 6 个脚本、293 条断言，全 PASS；已并入 `verify-all-p0.mjs`（19/19） |

### 已拍板但本批未做（下一批）

1. **仓库外文件**（D4）：等 P1 的 `{课程}/.cache/external/<hash>/` 落地后统一接，现在一律 Toast「下一批支持」。
2. **C9 附带项**：旁问上下文目前只读主线最近对话，**没有**注入「当前段简报」。
3. **网页 `Ctrl+T` / `Ctrl+W`**（§3.4 可选 P2）：未做 `before-input-event` 转发。
4. ~~**统一助手 / 预检的工作区默认模型**（P3 遗留四条）~~ —— **2026-11-19 第二批已完成**：
   `ChatBody` 模型浮层改条目分组（保思考模式开关）、`Preflight` 加「本课程模型」一行 + 锚定浮层、
   请求链路解析顺序改为「本对话 → 本课程 → 全局」（`agentService`，仅 AI 教学面）、
   设置页「统一为条目 id」显式迁移（行内确认卡 + 逐槽位失败点名）。
   同时修掉 `defaultModelEntryId` 无人读取、`resolveNonThinkingFallback` 切分条目 id、
   上下文窗口无法清空、能力三态无编辑入口四处静默缺陷。
5. **`SideLaneCenter.tsx` 已成为死代码**：旁问页签自建列表，只复用 `SideLanePanel`；留一版观察，下一批删除并把契约脚本迁到 `AskPane` 行为断言（已迁一条）。
6. **help 手册**：`resources/help/AI 教学 · 课程模式.md`、`AI 教学素材与代码.md`、`AI助手.md`、`常见问题.md` 需要补「四页签 / 网页登录态 / 笔记可编辑 / 旁问两作用域」。
7. **版本 / CHANGELOG / release-notes**：未抬版本、未写段、未跑 `build-release-notes.mjs`。

### 已知遗留（非本批引入）

- `.AGENT/scripts/shared/verify-resizable-panel.mjs` 有 11 条 FAIL（工件栏分隔条 / 素材库拉出条指针化断言），**HEAD 上就已经不成立**，与本次改动无关。
