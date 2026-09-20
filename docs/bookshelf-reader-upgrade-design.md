# 书架升级全格式阅读器 + 右栏阅读侧栏 · 实现方案（施工版）

> 状态：**一期已实施**（2026-09-20 落地：S1-S8 全部完成；契约 verify-reader-formats 全绿 + 探针 probe-reading-panel 13 项全过）。
> 来源：Weave EPUB Reader 借鉴调研 + 交互原型 `outputs/weave-reader-prototype.html`
> 实施者须知：本文所有「现状」都经过代码核对（附行号）。**开工前请先复核这些行号**（主仓随时有其它会话在写）。
> 实施差异记录：① decodeText 落零依赖 `src/lib/textDecode.ts`（组件文件带 React 依赖，契约脚本 strip-types 直 import 会炸）；② `BookKind` 在 `src/types/index.ts` 本地定义（tsconfig.web 只含 src/**，不能复导出主进程文件），与 bookFormats 的一致性由契约断言；③ PDF 事件常量抽零依赖 `src/components/shared/pdf/pdfEvents.ts`（防常量消费方把 pdfjs 拖进主包）；④ `ws:readRange` 白名单补 `txt`（workspaceManager RANGE_EXT_WHITELIST，否则 TxtReader 读不了书）。

## 0. 拍板结论（需求侧，不再讨论）

1. 右栏 Tab 头（🧩 小工具 / 🤖 AI）新增第三个条件图标「📖 阅读」；有书在读时出现，点击切到阅读侧栏。
2. 书架模块升级改造成阅读器（**不新建独立标签**）；书架标签被删除 → 右栏入口自动消失。
3. 侧栏内容 = 摘录面板（一期用书签 + 空态占位，为二期摘录预留）；左栏目录/缩略图/书签**不动**。
4. 分两期：一期 = 书架识别扩展（+`.txt`）+ TXT 阅读 + 右栏入口与侧栏；二期 = foliate-js 六格式。

---

## 1. 现状地图（施工依据，含锚点）

| 对象 | 位置 | 关键事实 |
|---|---|---|
| 书架自动库扫描 | `electron/lib/kbStore/knowledgeIndex.ts:204` `scanVaultPdfs()` | 扫 `<vault>/.books`，`L217` 硬编码 `endsWith('.pdf')`；目录不存在自动 mkdir；返回 `{relPath,size,mtimeMs}[]`（relPath 已 posix 化） |
| 书架清单 IPC | `electron/database/repositories/pdfReaderRepo.ts:38` `pdfReader:listBooks` | `L42 scanVaultPdfs()` + `L43 pdfReaderListProgress(cur.rootId)` join → 返回 `{ok, books}` |
| 进度仓库 | `electron/lib/kbStore/pdfReaderVaultRepo.ts` | `.knowbase/modules/pdfReader.json` **唯一写方**；键 `{rootId}/{relPath}`；`pdfReaderPatchBook(rootId, relPath, patch, expectedUpdatedAt)` |
| 纯校验层 | `electron/lib/kbStore/pdfReaderSchema.ts` | 零依赖，契约脚本 `--experimental-strip-types` 直接 import（新 schema 照抄这个范式） |
| preload 桥 | `electron/preload/index.ts:613-618` | `pdfReaderListBooks/Get/Patch/CoverList/CoverGet/CoverSave` |
| 渲染封装 | `src/lib/ipc.ts:292-299` | 一行一函数的薄封装 |
| 类型 | `src/types/index.ts:1196` `PdfBookListItem`（relPath/name/size/mtime/lastPage/totalPages/hasProgress/updatedAt）；`1521-1526` WindowApi 声明 | IPC 改动必须三处同步：preload / types / ipc.ts |
| 书架模块 | `src/modules/bookshelf/index.tsx` | `reading` 非空 → 模块内渲染 `PdfReaderView`（L95-117）；封面网格 + 续读条（L153-200）；`openBook` L90 去掉 `.pdf` 后缀 |
| 阅读态上收 | `src/App.tsx:579-582` `bookshelfReading` / `railReaderDoc` | `L1060-1070` 传进 `BookshelfModule`；`L1146-1156` 左栏三件套 portal |
| 右栏 | `src/components/workbench/WorkbenchRightPanel.tsx` | Tab 头 L247-275；`effectiveTab` L109；props 见 L63-84 |
| 右栏布局状态 | `src/lib/workbenchLayout.ts` | `rightTab: 'widgets'\|'ai'`（L25）、`WORKBENCH_PANEL_TAB_IDS`（L59）、钝解析 L89 |
| 关标签 | `src/App.tsx:792` `closeTab(tab)` | 通用关闭路径（✕ / 中键 / 全关），落点由 `landingAfterClose` 决定 |
| 契约脚本 | `.AGENT/scripts/pdf-reader/verify-pdf-reader.mjs`（范式样板）、`.AGENT/scripts/workbench-shell/verify-workbench-shell.mjs` | 用 `check(name, ok, extra)` 累积 `pass`；零依赖 .ts 直接 import；负向断言用 `shared/strip-comments.mjs` |
| 探针 | `.AGENT/scripts/workbench-shell/probes/run-probe.mjs` | 用法 `node <该文件> <探针.mjs> --no-sandbox --disable-gpu`；CDP 9222；已有 `probe-right-panel-inspect.mjs` 可抄 |

数据流（一期完成后）：

```
.books/*.pdf|*.txt
   └─ scanVaultBooks()（knowledgeIndex）
        └─ pdfReader:listBooks（pdfReaderRepo）── join ──┬─ pdfReader.json（pdf 进度/书签）
                                                          └─ readerState.json（txt 进度，新）
                                                               ↓ ipc.ts / types
                                                    BookshelfModule（书架 ⇄ 阅读器）
                                                               ↓ bookshelfReading(kind)
                                              App ──→ WorkbenchRightPanel(reading) ──→ ReadingSidePanel
```

---

## 2. 施工步骤（每步可独立提交、可独立验证）

> 提交信息用中文短句、不写人名。**同一文件禁止并行 Edit**，逐条串行发出。

### S1 格式常量唯一真相源（新建，无行为变化）

**新建** `electron/lib/kbStore/bookFormats.ts`（**零 import**，契约脚本要 strip-types 直跑）：

```ts
/** 书架支持的书籍扩展名（唯一真相源）。一期 = pdf + txt；二期追加
 *  '.epub' | '.mobi' | '.azw3' | '.fb2' | '.fbz' | '.cbz'（同时补 bookKindOf 分支）。 */
export const BOOK_EXTS = ['.pdf', '.txt'] as const

export type BookExt = (typeof BOOK_EXTS)[number]
export type BookKind = 'pdf' | 'txt'

/** 扩展名 → 阅读引擎种类；未收录返回 null（调用方跳过，不抛错） */
export function bookKindOf(relPath: string): BookKind | null {
  const p = String(relPath ?? '').toLowerCase()
  for (const ext of BOOK_EXTS) {
    if (!p.endsWith(ext)) continue
    return ext === '.pdf' ? 'pdf' : 'txt'
  }
  return null
}

/** 展示名：去掉书籍扩展名（无匹配扩展名时原样返回） */
export function bookDisplayName(relPath: string): string {
  const base = String(relPath ?? '').split('/').pop() ?? ''
  return bookKindOf(base) ? base.replace(/\.[^.]+$/, '') : base
}
```

**判据**：`node --experimental-strip-types -e "import('file:///E:/Projects/KnowledgeRecorder/electron/lib/kbStore/bookFormats.ts').then(m=>console.log(m.bookKindOf('a/b/C.TXT')))"` 输出 `txt`。

### S2 readerState 仓库（TXT 进度，四层照抄 pdfReader 范式）

1. **新建** `electron/lib/kbStore/readerStateSchema.ts`（零依赖）：
   ```ts
   export interface VaultReaderState { kind: BookKind; pct: number; updatedAt: string }
   export function readerKey(rootId: string, relPath: string): string   // 同 pdfBookKey 口径：posix 化 / 拒空 / 拒绝对路径
   export function readerKeyRel(key: string): string
   export function sanitizeReaderPatch(patch: unknown): { pct?: number } | null
   // pct 白名单：整数 0..100（1.5 / -1 / 101 / '50' 一律 null；空 patch null）
   export function coerceReaderState(raw: unknown, now: string): VaultReaderState  // kind 非法回落 'txt'，pct 夹取
   ```
2. **新建** `electron/lib/kbStore/readerStateVaultRepo.ts`：store 文件 `.knowbase/modules/readerState.json`，结构 `{ version: 1, books: Record<key, VaultReaderState> }`；导出 `readerStateGetBook(rootId, relPath)` / `readerStateListProgress(rootId)`（前缀过滤，语义同 `pdfReaderListProgress`）/ `readerStatePatchBook(rootId, relPath, patch, expectedUpdatedAt?)`（`expectedUpdatedAt` 冲突检测 + `writeJsonOrThrow`，失败必须抛错不伪装成功）。
3. **新建** `electron/database/repositories/readerStateRepo.ts`：注册 `readerState:get` / `readerState:patch` 两个 handler（转发 + 成功后 `broadcastDataChanged('readerState')`）。
4. **接线（六处）**：
   - `electron/main/index.ts`：`registerReaderStateHandlers()`（紧跟 `registerPdfReaderHandlers`）
   - `electron/preload/index.ts`：`readerStateGet` / `readerStatePatch` 两个 invoke 桥
   - `src/types/index.ts`：WindowApi 加两方法声明 + 类型 `ReaderBookState`
   - `src/lib/ipc.ts`：两行薄封装
   - `src/lib/dataChanged.ts`：`DataChangeScope` 联合类型加 `'readerState'`（主进程 `broadcastDataChanged` 入参类型同源，契约脚本双侧断言）
   - `src/types/index.ts` 顺带导出 `BookKind`（从 bookFormats 复导出，渲染层不要另写字面量）

### S3 扫描扩展 + 清单 join

1. `electron/lib/kbStore/knowledgeIndex.ts`：`scanVaultPdfs()` → **改名 `scanVaultBooks()`**，返回项补 `kind: BookKind`；过滤改为 `if (bookKindOf(abs) === null) continue`（删掉 `L217` 的 `.pdf` 字面量）。relPath/mtime/自动 mkdir 语义全部保留。
2. `electron/database/repositories/pdfReaderRepo.ts`：改 import（`scanVaultPdfs` → `scanVaultBooks`）；`listBooks` handler 按 kind 分流 join：`pdf` → `pdfReaderListProgress(rootId)`（不变）；`txt` → `readerStateListProgress(rootId)` 映射为 `{ kind:'txt', lastPage:0, totalPages:0, pct, hasProgress: pct>0, updatedAt }`。
3. `src/types/index.ts`：`PdfBookListItem` → **改名 `BookListItem`**，加 `kind: BookKind` 与 `pct?: number`（txt 用）；其余类型不动。改完整仓 `grep -rn "PdfBookListItem"` 把引用点全部更名（预期 3-5 处）。

**判据**：往 `.books/` 丢一个 `.txt`，书架出现卡片（此时点开仍是 PDF 视图——S5 才接阅读器，属预期）。

### S4 书架列表 UI 适配 kind

`src/modules/bookshelf/index.tsx`：

- 续读条（L158-175）：`kind === 'txt'` 时右侧改显示 `pct%`（`Play` 图标 + 文案），`title` 由「第 N 页」改「已读 pct%」；pdf 分支保持原样。
- 封面网格角标（L192-194）：`kind === 'pdf' && b.hasProgress` 才显示 `P{n}`。
- 书名去后缀（L91 / L169 / L196）：`b.name.replace(/\.pdf$/i,'')` → `bookDisplayName(b.relPath)`。
- **封面分发**：新建 `src/modules/bookshelf/BookCover.tsx`——`kind==='pdf'` 渲染现有 `PdfCover`；`kind==='txt'` 渲染纯色书卡（色相由 `relPath` 字符和 % 8 取色板，书卡内排书名），不引入新依赖、不读文件内容。
- 空态文案（L125）：「…自动收拢 .books 目录里的 PDF」→「…自动收拢 .books 目录里的书」。

### S5 TXT 阅读器 + 模块分发

1. **新建** `src/components/shared/txt/TxtReaderView.tsx`，props 与 `PdfReaderView` 对齐：
   ```ts
   interface Props { rootId: string; relPath: string; name: string; backLabel?: string; onBack?: () => void }
   ```
   - **读取**：循环 `workspaceReadRange(rootId, relPath, offset, 128*1024)` 累积到 `MAX_TXT_BYTES = 20 * 1024 * 1024`；超限只读前 20MB + 顶部一条提示（不弹窗）。
   - **解码**：`export function decodeText(u8: Uint8Array): string` —— ① BOM：`EF BB BF` → utf-8 去 BOM，`FF FE` / `FE FF` → utf-16le/be；② 否则 `new TextDecoder('utf-8', { fatal: true })` try；③ 抛错 → `new TextDecoder('gb18030')` 兜底。**单独导出供契约脚本跑用例**。
   - **分段**：`text.split(/\r?\n/)` → 连续空行折叠为段落边界 → 每段 `<p data-p={i}>`；单段超 4000 字内部再切。
   - **虚拟化**：段落数 > 300 时才在段落项加 `content-visibility:auto` + `contain-intrinsic-size: 96px`；≤300 段**不加**（铁律 11：估值会把滚动高度抬成数倍、滚动条乱跳）。
   - **排版**：max-width 700px / 字号 19px / 行高 2.05 / 衬线字体 / 两端对齐；根节点 `h-full`（**不能写 `flex-1`**）；滚动容器在组件内部（`overflow-y-auto`），与 pdf 阅读器同构。
   - **进度**：滚动 → 节流 200ms 算 `pct = round(scrollTop/(scrollHeight-clientHeight)*100)`；防抖 400ms 落盘 `readerStatePatch(rootId, relPath, { pct }, expectedUpdatedAtRef.current)`（返回 `state.updatedAt` 存回 ref）；恢复时按 `pct/100` 反算 scrollTop。
   - **广播**：`window.dispatchEvent(new CustomEvent('kb-reader-state-changed', { detail: { relPath, kind:'txt', pct } }))`（节流 200ms）。
   - **工具栏**：与 `PdfReaderView` 同款容器（最左「← 返回书架」+ 书名 + 右侧 `pct%`）；一期不做目录/缩略图。根节点加 `data-wb="txtReader"`（探针用）。
   - **Hook 纪律**：所有 hook 声明在**任何早退 return 之前**（React #310 已三犯：早退分支后写 hook 必炸、tsc 全绿只有运行时炸）。
2. `src/modules/bookshelf/index.tsx`：阅读分支按 `reading.kind` 分发——
   ```tsx
   {reading.kind === 'txt'
     ? <TxtReaderView rootId={rootId} relPath={reading.relPath} name={reading.name} backLabel="返回书架" onBack={() => onCloseBook?.()} />
     : <PdfReaderView rootId={rootId} relPath={reading.relPath} name={reading.name} backLabel="返回书架" onBack={() => onCloseBook?.()} />}
   ```
   `TxtReaderView` 同样 `lazy(() => import(...))` 拆 chunk（对齐 `PdfReaderView` 现有做法）。

### S6 右栏「阅读」Tab + 阅读侧栏

1. `src/lib/workbenchLayout.ts`：
   - `rightTab: 'widgets' | 'ai' | 'reading'`；钝解析 L89 接受 `'reading'`，坏值仍回落 `'widgets'`。
   - 新增 `export const RIGHT_PANEL_TAB_IDS_ALL = ['widgets', 'ai', 'reading'] as const`；**`WORKBENCH_PANEL_TAB_IDS` 保持 `['widgets','ai']` 不动**并补注释：「reading 是条件性入口 Tab，不进 ⋯ 选显菜单、不持久化显隐——存在性由阅读态决定；两集合刻意不同，勿合并」（防 list-drift）。
2. `src/components/workbench/WorkbenchRightPanel.tsx`：
   - props 增 `reading?: { relPath: string; name: string; kind: BookKind } | null`。
   - `effectiveTab`（L109）改为：
     ```ts
     const readingOn = !!reading
     const effectiveTab = rightTab === 'reading'
       ? (readingOn ? 'reading' : visiblePanelTabs[0])
       : (visiblePanelTabs.includes(rightTab) ? rightTab : visiblePanelTabs[0])
     ```
     （**不改持久化值**：关书再开书回到用户上次选的 widgets/ai）
   - Tab 头：`visiblePanelTabs.map` 之后条件渲染第三个按钮，`data-wb="rpTab"` + `data-wb-rp-tab="reading"` + `data-wb-rp-active`（与另两个同款 class 语言）；图标 lucide `BookOpen` size 14；`title="阅读"`；点击 `patch({ rightTab: 'reading', rightCollapsed: false })`（**同时展开右栏**——入口语义是「看阅读侧栏」，点了必须看得见）。
   - 内容分支：`effectiveTab === 'reading' ? <ReadingSidePanel reading={reading!} onLocatePdfPage={...} /> : （原 widgets / AI 分支）`。
3. **新建** `src/components/workbench/ReadingSidePanel.tsx`（根节点 `data-wb="readingPanel"`）：
   - 头部：书名 + kind 角标（`PDF`/`TXT`）+ 进度（初值拉一次 `pdfReaderGet` / `readerStateGet`，之后订阅 `kb-reader-state-changed` 与 `KB_PDF_PAGE_CHANGED`）。
   - 段「书签」（仅 pdf，`useDataChanged('pdfReader')` 刷新）：条目 = `第 N 页` + 备注，点击 → `onLocatePdfPage(page)`。
   - 段「摘录」：一期空态文案「划选正文即可创建摘录 · 即将支持」（按 `docs/help-disclosure-pattern.md` 口径：只收不删、不醒目标签）。
   - 时间线 Tab 一期不做（书签量少无意义），二期摘录批次一起上。
4. `src/App.tsx` 接线：
   - `bookshelfReading` 类型扩为 `{ relPath: string; name: string; kind: BookKind }`；`railReaderDoc` 派生处补 `kind`。
   - `BookshelfModule` 的 `onOpenBook` 签名带 `kind`（S4 改模块内部 `openBook`）。
   - `closeTab`（L792）**函数开头**加唯一清空点：
     ```ts
     if (tab === 'bookshelf') setBookshelfReading(null)
     ```
     （这是「标签删 → 入口消失」的唯一事实源；不要在右栏里再推断一次。）
   - 传参：
     ```tsx
     reading={openTabs.includes('bookshelf') && bookshelfReading ? bookshelfReading : null}
     onLocatePdfPage={(page) => {
       if (activeTab !== 'bookshelf') handleTabChange('bookshelf')
       requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(KB_PDF_GOTO_PAGE, {
         detail: { relPath: bookshelfReading!.relPath, page },
       })))
     }}
     ```
     （**不看 `activeTab`**：阅读器在后台标签也允许侧栏可见，VS Code 大纲面板同语义；但「定位原文」必须先切回书架标签，否则事件无人接收。）

### S7 契约脚本

**新建** `.AGENT/scripts/pdf-reader/verify-reader-formats.mjs`（抄 `verify-pdf-reader.mjs` 的 `check` 脚手架）：

| # | 断言组 | 用例（import 真实实现，非复制品） |
|---|---|---|
| ① | `bookFormats` 纯函数 | `bookKindOf('a/B.TXT')==='txt'` · `bookKindOf('a.pdf.txt')==='txt'` · `bookKindOf('a.md')===null` · `bookKindOf('')===null` · `bookDisplayName('x/呐喊.txt')==='呐喊'` · 遍历 `BOOK_EXTS` 每项都能被识别（常量↔函数一致性） |
| ② | `readerStateSchema` | `readerKey` 归一 / 拒空 / 拒绝对路径 · `sanitizeReaderPatch({pct:50})` 收 · `{pct:1.5}` `{pct:101}` `{pct:-1}` `{pct:'50'}` `{}` 非对象 全拒 · `coerceReaderState` 坏 kind 回落、pct 夹取 |
| ③ | 负向：单写方 | 剥注释后全仓扫描，`readerState.json` 只允许出现在 `electron/lib/kbStore/readerStateVaultRepo.ts` |
| ④ | 负向：扫描唯一真相源 | `knowledgeIndex.ts` 剥注释后**不得**再出现 `.pdf` 字面量（过滤一律走 `bookKindOf`） |
| ⑤ | IPC 三处同步 | `readerState:get` / `readerState:patch` 两 channel 字符串在 preload 与 repos 一致；`types/index.ts` 与 `src/lib/ipc.ts` 均有对应声明 |
| ⑥ | DataChangeScope 双侧 | 渲染层 union 与主进程 `broadcastDataChanged('readerState')` 双侧都含 `'readerState'` |
| ⑦ | Tab 集合纪律 | `WORKBENCH_PANEL_TAB_IDS` 仍 2 项且不含 `reading`；`RIGHT_PANEL_TAB_IDS_ALL` 含 `reading`；`parseWorkbenchLayout` 接受 `'reading'`、`'bogus'` 回落 `'widgets'` |
| ⑧ | 关标签清阅读态 | 剥注释后在 `src/App.tsx` 的 `closeTab` 函数体内断言存在 `setBookshelfReading(null)` |
| ⑨ | 兜底 | `decodeText` 用例表：UTF-8 无 BOM / UTF-8 带 BOM / GB18030 样本各一篇（样本用 `Buffer.from(hex,'hex')` 内联，别放外部文件） |
| ⑩ | TabName 冻结 | 仍 16 项（防顺手新增 TabName） |

**`verify-workbench-shell.mjs` 增项**（既有 check 序列尾部追加）：

- `WorkbenchRightPanel.tsx` 中 reading 按钮渲染条件包含 reading 真值判断（剥注释 + 正则）；
- `data-wb-rp-tab="reading"` 标记存在；
- `rightTab === 'reading'` 的回落表达式存在（锁「关书回落」语义不被删）。

### S8 探针（真实应用内端到端）

**新建** `.AGENT/scripts/workbench-shell/probes/probe-reading-panel.mjs`（抄 `probe-right-panel-inspect.mjs` 的 CDP 骨架）。

前置：扩展 `seed-probe-vault.mjs` 支持 `--add-books`——在探针 vault 的 `.books/` 落一本 `探针样书.txt`（几十段中文、含空行分段）。

断言链（任一失败即 `process.exit(1)`）：

1. 打开书架标签 → 卡片出现，且 `[data-wb="readingPanel"]` 不存在
2. 点第一本书 → `[data-wb="txtReader"]` 存在 → **右栏出现** `[data-wb-rp-tab="reading"]`
3. 点该图标 → `[data-wb="readingPanel"]` 可见，右栏宽度 > 0（`rightCollapsed` 已被强制展开）
4. 关掉书架标签（页面条 ✕）→ `[data-wb-rp-tab="reading"]` **从 DOM 消失**，且 `[data-wb-rp-active="1"]` 指向 widgets 或 ai（回落生效）
5. 真实滚动驱动 TXT 到 50% → 主进程侧读 `.knowbase/modules/readerState.json`，断言该书的 `pct` 落在 45~55

运行（**必须带两个 flag**，否则沙箱里 GPU 崩、渲染进程被 kill）：

```
node .AGENT/scripts/workbench-shell/probes/run-probe.mjs \
  .AGENT/scripts/workbench-shell/probes/probe-reading-panel.mjs --no-sandbox --disable-gpu
```

---

## 3. 命令与门禁（每步提交前跑）

```bash
# 类型检查（必须 --noEmit）
node_modules/.bin/tsc --noEmit -p tsconfig.web.json
node_modules/.bin/tsc --noEmit -p tsconfig.node.json

# 构建（cwd 必须大写盘符 E:\...，小写盘符必现 ?raw 解析失败）
npx electron-vite build

# 契约
node --experimental-strip-types --no-warnings .AGENT/scripts/pdf-reader/verify-pdf-reader.mjs
node --experimental-strip-types --no-warnings .AGENT/scripts/pdf-reader/verify-reader-formats.mjs
node --experimental-strip-types --no-warnings .AGENT/scripts/workbench-shell/verify-workbench-shell.mjs

# 探针（build 产物必须最新才有意义）
node .AGENT/scripts/workbench-shell/probes/run-probe.mjs .AGENT/scripts/workbench-shell/probes/probe-reading-panel.mjs --no-sandbox --disable-gpu
```

**沙箱坑清单（踩过的，别再踩）**：`bash` 里 `ls/head/grep` 可能 command not found → 用 Grep/Glob 工具或 `node -e`；`electron-vite build` 前想备份 `out/` 可能被 EPERM 整体拒绝 → 退路是清空 `out/renderer/assets` 再 build；`git commit` 后分支可能被回滚 → 用系统 git 2.37、写盘后复核 `git log -1`；`git add` 只显式加点名路径（主仓有并行会话）；**禁止 `git stash`**。

---

## 4. 验收清单（对着勾）

- [ ] `.books/` 同时放 .pdf 与 .txt，书架都收；卡片角标 / 续读信息按 kind 正确
- [ ] TXT 打开：UTF-8（带/不带 BOM）与 GB18030 样本都不乱码
- [ ] TXT 读到 50% 后关标签再开：回到 50% 位置（进度落 `.knowbase/modules/readerState.json`）
- [ ] PDF 原有能力零回归：进度、书签、目录/缩略图、封面缓存、页码角标
- [ ] 右栏：无书在读时**没有**第三个图标；有书在读时出现；点它右栏自动展开并显示侧栏
- [ ] 关闭书架标签 → 图标消失、右栏回落 widgets/ai（不残留空侧栏）
- [ ] 摘录面板「定位原文」（pdf 书签）能把阅读器切回书架标签并跳到该页
- [ ] 全部契约脚本 + 探针 PASS，两个 tsc project 全绿
- [ ] 文案口径：无冗余说明文字、无醒目标签（`docs/help-disclosure-pattern.md`）
- [ ] 动效走既有工具类（`docs/ui-animation-plan.md`），无 `transition-all` 临时凑

## 5. 本期明确不做（防范围膨胀）

EPUB/MOBI/AZW3/FB2/FBZ/CBZ 渲染 · 划选摘录与双向溯源 · 扫描件探测与页级降级 · OCR · TXT 目录/章节切分 · 生词本 · AI 讲解入口（归二期/独立批次）。
左栏三件套（目录/缩略图/书签）位置与形态**不动**。

## 6. 二期预留接口（现在就把口子留对）

- `BOOK_EXTS` 追加六类 + `bookKindOf` 补分支 + 新增 `bookEngineOf(ext): 'pdf'|'txt'|'foliate'`（一期不导出亦可；二期加不许改一期签名）
- `BookKind` 联合类型扩为 `'pdf'|'txt'|'epub'|'mobi'|'azw3'|'fb2'|'fbz'|'cbz'`（`coerceReaderState` 的 kind 回落逻辑改成「不在合法集才回落」）
- `VaultReaderState` 二期加 `locator?: string`（pdf 页码 / txt pct / foliate CFI 三类统一承载），pdf 状态做一次性迁移
- `ReadingSidePanel` 的摘录段留空态占位，二期直喂真数据（组件签名不变）
- 扫描件探测纯函数（输入每页字数数组 → `'full'|'partial'|'no'`）二期新增，落 `readerStateSchema.ts` 同层
