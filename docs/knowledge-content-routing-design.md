# 知识库非 md 文件的内容落点（设计文档）

> 状态：**已落码**（批 1，2026-10-12，v3.5.0 线）。
> 原型：`tmp/nonmd-content-routing-proto/index.html`（路由真值表 24 项，`_route-check.mjs`）。
> 契约：`.AGENT/scripts/knowledge-content-routing/verify-content-routing.mjs`（64 项）。
> 需求口径（开发负责人 2026-10-12）：「把书架那套 PDF 阅读搬到笔记区来」+「所有文本类的文件都可以在笔记区编辑查看」。

## 1. 一句话根因

`PageEditor.tsx` 的内容分支里，**`isArchiveFile` 排在了所有专门视图之前**，而仓库内的非 md 文件
**全部**是 `entryKind:'file'`（`knowledgeIndex.ts` 注释：「非 md 一律收录」）——
于是 PDF 阅读器、文本视图、将来的图片视图**全都不可达**，一律落成一张元信息卡。

这不是边缘情况，是「非 md 的每一种」都中招。

### 1.1 同一个坑已经踩过两次

导图那次留下了记录（`PageEditor.tsx` 导图分支上方注释）：

> 必须排在 `isArchiveFile` 之前——`.json` 归档条目默认落元信息卡，**会遮蔽**导图分支

导图那次把分支挪到了最前，**PDF 这次没挪**。批 1 的修法不是「再挪一个」，
而是**把 `isArchiveFile` 降级为兜底**，从结构上消除「下一个专门视图又被遮蔽」的可能。

## 2. 新的分支顺序（唯一真相）

```
1  isMindMapFile && path                       → MindMapView（按内容识别 kind:"mindmap"）
2  (isWelcomeHtml || isArchiveHtml) && path    → WelcomeHtmlView（沙箱 iframe）
     └ htmlSource 为真时让位给第 5 步（可编辑源码）
3  isXmindFile                                 → XMind 提示卡（外部应用打开）
4  isPdfFile && path && vaultRootId            → PdfReaderView（与书架同一个共享组件）
5  文本落点（paneDoc）                          → 可编辑 MonacoPane
     · 归档文本类（TEXT_VIEWABLE_EXT_SET 之内）
     · html 的源码态
6  isArchiveFile && !archiveTextOpenable       → FileMetaCard（**兜底**）
     · 二进制（detectBinary / %PDF- 头）
     · > 50 MB（不读内容）
     · 未识别类型
7  isPdfFile                                   → legacy「旧版附件不在仓库内」
8  preview ? MarkdownPreview : paneDoc         → md / txt 知识页原有路径（一行未改）
```

顺序由契约 **A3/A5** 锁住，且是**按括号深度解析出真实条件链**再比对先后，
不是对全文做 `indexOf` 比大小 —— 后者会把注释、别的分支、⋮ 菜单里的同名条件一起算进来。

## 3. 数据层一行未动（复用既有能力）

批 1 的全部改动都在渲染层。主进程早就把这套边界做完了：

| 能力 | 位置 |
|---|---|
| 二进制探测（NUL + `%PDF-` 头），二进制不返回内容 | `workspaceManager.ts:199-212` |
| `>10MB` 拒绝编辑（`editable:false`）/ `>50MB` 拒绝打开（`truncated:true`） | 同上 `:31-32`、`:204-221` |
| 保存冲突基线 `mtimeMs` | `ReadFileResult.mtimeMs`（`:193`） |
| 写文本无扩展名白名单 + `expectedMtimeMs` 冲突检测 | `ws:writeFile`（`:892-910`） |
| 非 md 写盘不注入 frontmatter | `PageEditor.tsx` 的 `/\.md$/i` 守卫 |

## 4. 自读的四条纪律（都在 `verify-content-routing.mjs` 的 B 组锁住）

归档条目的索引正文**恒为空**（主进程对 `entryKind:'file'` 不读内容：「二进制可能很大」），
所以文本落点必须**按需自读**。四条纪律都是「不报错但坏掉」的类型：

1. **超限不灌 `content`** —— `>10MB` 交给 `ArchiveTextView` 自读，不把 10MB 字符串塞进
   `PageEditor` 的 state：那会让自动保存的脏态比较与一批派生计算（题号 / 双链）白跑一遍。
   （原型阶段这里真写错过：`>10MB` 落进了可编辑态，给出一个存不进去的编辑框。）
2. **绝不 `splitFrontmatter`** —— 非 md 没有 frontmatter 语义，而一个以 `---` 开头的 `.py`
   会被切掉开头。
3. **同步 `savedContentRef`** —— 否则灌进 `content` 的那一刻，自动保存的 effect
   （`content !== savedContentRef.current`）会把刚读到的内容当成用户改动回写一次。
4. **强制编辑态** —— `loadPage` 的 `setPreview` 规则会给 `.txt` 阅读态，那是给 **txt 知识页**
   定的；归档 `.txt` 按拍板要「直接编辑」。

## 5. `rootId` 从 ref 提成 state（同一处的第二个坑）

`vaultRootRef` 是 `useRef`，**改它不触发重渲染**。而 rootId 与页面数据是 `loadPage` 里
两条并发 IPC 链（`workspaceGetCurrent` vs `getKnowledgePageById`），谁先落地不确定：
页面数据先到就渲染一次，那时 rootId 还是 null ⇒ 仓库内 PDF 落到
「旧版附件不在仓库内，请使用本地工具打开」的降级分支，之后 rootId 填上也**再没有一次重渲染**
把它救回来。

修法：新增 `vaultRootId` state 供渲染条件使用，`vaultRootRef` 保留给 `doSave` /
`handleArchiveOpenInSystem` 的**同步**读取；两者一律经 `adoptVaultRoot` 同步写入。
契约 **A7** 是负向锁：渲染链里不得再出现 `vaultRootRef.current`。

## 6. 能力面（`ws:writeFile` 没有扩展名白名单）

主进程的 `ws:writeFile` 只要求 `pathGuard.requireInside`（路径在仓库内）+ `expectedMtimeMs`，
**不看扩展名**。所以「知识库能编辑哪些文件」这件事**只由渲染层一处决定**：

```ts
const isArchiveTextView = isArchiveFile && !isArchiveHtml && isTextViewableExt(fileType)
```

`TEXT_VIEWABLE_EXT_SET`（`src/lib/aiTextExts.ts`）= 代码类 28 种 + 配置/数据类 + 纯文本。
契约 **C1** 锁住这一行 —— 改它就是改能力面，不是改样式。

## 7. 顺带修的三处

| 处 | 问题 | 修法 |
|---|---|---|
| 沉浸阅读（`knowledge/index.tsx`） | `enterReading` 放行 txt，而沉浸分支对**所有** `entryKind:'file'` 一律元信息卡 ⇒ 打开仓库里的 `.txt` 进沉浸阅读**必现**一张「该文件不是 markdown 知识页」的卡 | 文本类走 `ArchiveTextView`，顺序在 `FileMetaCard` 之前（契约 F2/F3） |
| `fileTypes.ts` | `csv / log / toml / ini / cfg / conf / cs / kt / swift / ps1 / vue / scss / text` 等**没有条目** ⇒ 兜底 `monacoLang:'markdown'`，`.csv` 按 Markdown 高亮 | 补齐条目；兜底改成 `plaintext`；契约 G9 逐个扩展名扫一遍 |
| `⋮` 菜单 | 非 md 的 ⋮ 里几乎为空（关联/删除要 `!vaultMode`，而 `vaultMode` 恒 true；收藏排除归档条目；文件格式同样要 `!vaultMode`）⇒ 仓库内 PDF/HTML/代码的 ⋮ 只剩一条分隔线 | 新增「文件」组：看源码（html）/ 文件信息 / 在系统中打开 / 在文件夹中显示 / 复制相对路径 |

## 8. 明确不做（范围锁）

- **图片渲染**（批 3）：本批图片仍落文件信息卡。
- **工具栏统一**（批 2）：本批非 md 仍在悬浮胶囊上，只是 ⋮ 被填上了。
- **主进程改动**：一行未动。
- **md 的 ⋮ 分段**：一行未改（「文件」组带 `!isMdNote` 闸，契约 D4）。
- 编辑区既存待办（标注 callout / `==高亮==` / 题目围栏渲染 / 禅模式等）不在本批。

## 9. 验收

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit`（web / node） | 0 错 |
| 新契约 `verify-content-routing.mjs` | **64 PASS / 0 FAIL** |
| `verify-note-surface.mjs` | 196 PASS / 0 FAIL（未被破坏） |
| `verify-note-topbar.mjs` | 51 PASS / 0 FAIL |
| `verify-page-split.mjs` | 40 PASS / 0 FAIL |
| `verify-help-retrieval.mjs` | 76/76（新增 5 条用例全第 1 名命中） |
| 实机探针 | **待跑**（本机沙箱起不了 Electron；`PageEditor` 的落点必须在真机上看一眼） |

### 9.1 已知的存量契约失败（与本批无关）

`verify-workbench-shell.mjs` 有 5 条 FAIL，指向的文件（`src/App.tsx`、`src/components/shared/VaultTree.tsx`、
`src/components/workbench/PageTabStrip.tsx`、`StatusBar`）本批**一个都没改**；其中 G9 断言的是
「『分屏』概念已从 App 等处的源码与注释中清除」，而 `App.tsx` 现在就有 5 处「分屏」
（页面级分屏是正式功能）⇒ 必然失败。属页面级分屏合并与文件树重做留下的过期断言。

## 10. 关键文件

- `src/modules/knowledge/components/PageEditor.tsx`（分支顺序 / rootId / 自读 / ⋮ 文件组 / html 源码态）
- `src/modules/knowledge/index.tsx`（沉浸阅读同款分支）
- `src/modules/knowledge/components/ArchiveTextView.tsx`（改造为「超限只读」复用路径，加 `banner`）
- `src/modules/knowledge/components/FileMetaCard.tsx`（抽出 `FileInfoRows`，与 ⋮ 弹层同源）
- `src/lib/fileTypes.ts`（补类型 + 兜底改 `plaintext`）
- `.AGENT/scripts/knowledge-content-routing/verify-content-routing.mjs`

## 11. 后续批次

- **批 2**：非 md 的工具栏从悬浮胶囊改成统一顶栏（原型 `tmp/nonmd-topbar-proto/index.html` 已定稿）。
  批 1 填进胶囊 ⋮ 的「文件」组届时**原样搬进**顶栏 ⋮，`data-wb` 锚点保持不变。
- **批 3**：图片渲染（需要放开 `ws:readImage` 的附件区白名单，属安全口径变更，待拍板）。
