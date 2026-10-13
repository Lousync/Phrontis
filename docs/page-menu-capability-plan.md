# 页面 ⋮ 菜单能力补齐（实现方案）

> 来源：2026-10-13 开发者拍板「三条暂不能的先统统不做，现在就能做和接线就能加的**直接开始做**」。
> 上游盘点：两份只读对账（20 个菜单入口 × 61 条命令，逐条带 `文件:行`）；讨论原型 `tmp/page-menu-capability-proto/index.html`。
> 参考基准：Obsidian 的页签 `⋮` 菜单（开发者提供截图）。

## 一、范围（拍板结果）

| 组 | 条目 | 本次 |
|---|---|---|
| **接线（14）** | 重命名 · 将文件移动到… · 创建副本 · 删除（非 md）· 查找… · 替换… · 左右分屏 · 上下分屏 · 复制路径▸（相对/完整）· 使用默认应用打开（md）· 在系统资源管理器中显示（md）· 在文件列表中定位 · 导入文件… · 导入文件夹… | **做** |
| **新写（3）** | 在标签页中显示反向链接 · 导出为 PDF · 增加笔记属性 | **做** |
| **暂不能（3）** | 在新窗口中打开 · 打开版本历史 · 将该笔记合并到… | **不做**（本次明确排除，台账留档） |

## 二、落地前的两处新发现（只读盘点的补充）

1. **「导入文件…/导入文件夹…」的处理函数都在**：`src/modules/knowledge/index.tsx` 已有 `handleImportFolder`（`:542`，走 `showFolderDialog` + `importFolder`）与文件导入那一段（`:554`，走 `showImportOpenDialog`）。缺的只是**菜单项** ⇒ 纯接线，不是新能力。
2. **现有的「删除页面」在仓库模式下是假按钮**：`PageEditor.handleDelete`（`src/modules/knowledge/components/PageEditor.tsx:1108`）第一句就是 `if (vaultMode) { toast('仓库文件模式：删除请在编辑器模块操作'); return }`，而知识库模块**恒传** `vaultMode={true}`（`src/modules/knowledge/index.tsx:2530`）⇒ 今天点它只弹一句提示，不删任何东西。
   ⇒ 本次把「删除」统一接到模块层的 `handleTreeDelete`（系统回收站 + 危险确认 + 连带关页签），**md 与非 md 同一个落点**，顺带修掉这个假按钮。

## 三、改法

### 3.1 ⋮ 的分组对齐（md 与非 md 同一套）

> **批 1a 的实际做法（如实记）**：只做**追加** —— md 分支新增「编辑 / 文件 / 系统」三组；非 md 分支既有条目**一条都不动**，只把「复制相对路径」（一档）升级为「复制路径 ▸」（二级两档）。完整的「重排 + 叫法统一」（页面→视图、把非 md 那四项挪进系统组、以及「在系统中打开」与文件树的「使用默认应用打开」并成一句）留到批 1b 收尾：它纯属排列与文案，却要连带重写 205 / 54 / 58 项既有契约，收益与风险不成比例。**下面的表是目标态，不是 1a 的落地态。**

| 组 | md 页 | 非 md 页 |
|---|---|---|
| **视图** | 查看源码 / 看渲染 · 沉浸阅读 · 刷题模式（有题时） | 看源码 / 看渲染（html）· 看源码 / 看图片（svg）· 沉浸阅读（txt / html / 图片） |
| **布局** | 左右分屏 · 上下分屏 | 同左 |
| **文件** | 重命名 · 将文件移动到… · 创建副本 · 收藏页面 · 复制路径 ▸ · 在文件列表中显示 | 重命名 · 将文件移动到… · 创建副本 · 复制路径 ▸ · 在文件列表中显示 |
| **内容** | 添加关联 · 查找… · 替换… · 插入脚注 · 插入图片 · 文件格式 ▸ | 文件信息 · 查找… · 替换… |
| **查看** | — | 适应窗口 · 实际大小 · 向左旋转 · 向右旋转（图片） |
| **系统** | 在系统中打开 · 在文件夹中显示 | 在系统中打开 · 在文件夹中显示 |
| *危险项* | 删除（无组标题） | 删除（无组标题） |

- 现有 `data-wb` 锚**一个都不改名**（`peMdSource` / `peHtmlSource` / `peSvgSource` / `peFileInfo` / `peOpenInSystem` / `peRevealInFolder` / `peCopyRelPath` / `imgMenu*`），既有的探针与契约可继续用。
- 新项一律补 `data-wb`（`peRename` / `peMove` / `peDuplicate` / `peCopyPath` / `peLocate` / `peSplitRow` / `peSplitCol` / `peFind` / `peReplace` / `peDelete` / `peSystemOpen` / `peReveal`），否则又会回到「九项只有一个锚」。

### 3.2 写进菜单的键位提示走键帽

⋮ 里现在用裸 `text-[10px]` 文本显示键位（`Ctrl+Shift+R` 等）。本次统一改用 F-2 落地的 `.kb-kbd` 键帽，与命令面板同一套视觉。

### 3.3 需要模块层管道的能力（重命名 / 移动 / 副本 / 定位 / 删除 / 分屏）

这些动作会改 relPath 或动页签，**实现留在模块层**（`src/modules/knowledge/index.tsx` 已有 `handleTreeRename` / `handleTreeMove` / `handleTreeDelete` / `duplicateWorkspaceFile` / `setTreeRenaming` / `locatePageId`），`PageEditor` 只发请求：

| 新 prop（全部可选） | 模块层落点 |
|---|---|
| `onRenameRequest(relPath, newName)` | `handleTreeRename`（含分类通道、撤销栈、树与页签刷新） |
| `onMoveRequest(relPath, targetDir)` | `handleTreeMove` |
| `onDuplicateRequest(relPath)` | `duplicateWorkspaceFile` + `refreshTreeDir` |
| `onLocateRequest(relPath)` | `setLocatePageId`（展开并滚动到树中该行） |
| `onDeleteRequest(relPath)` | `handleTreeDelete({ relPath, type: 'file' })`（回收站 + 危险确认 + 关页签） |
| `onSplitRequest(orientation)` | `onSplitPage(pageId, orientation)`（页签右键同款） |

- **重命名的输入框放在 ⋮ 自己的弹层里**（照同文件已有的「文件信息」卡：`absolute right-2 top-full kb-pop`，Enter 提交 / Esc 取消），**不复用树内联改名** —— 树可能收起或侧栏关着，那时内联输入框根本不渲染（表象就是「点了没反应」）。
- **「将文件移动到…」同样挂这个弹层位**，内容复用现成的 `DirPicker`（它只负责内容与键盘，定位交给宿主）。
- 两个 `PageEditor` 实例（主栏 / 副栏）都要传这套 prop，否则副栏的 ⋮ 会缺项。

### 3.4 三处自足项（不需要管道）

| 条目 | 实现 |
|---|---|
| 使用默认应用打开 / 在系统资源管理器中显示（md） | 直接调本文件已有的 `handleArchiveOpenInSystem(reveal)`（它按 `page.path` 取路径，对 md 同样成立） |
| 复制路径 ▸ | 扩 `handleCopyRelPath` → `handleCopyPath(mode)`：`rel` 直接复制；`abs` 取当前仓库根拼前缀（与模块层 `copyPathText` 同一口径、同一个主进程剪贴板通道） |
| 查找… / 替换… | `noteRef.current?.getEditor()` 拿 Monaco → `getAction('actions.find')` / `getAction('editor.action.startFindReplaceAction')`。**即时渲染档（CM6）没有 Monaco** ⇒ 这两项只在源码档出现（`getMode() === 'source'`），与 `ed-find` 的现状口径一致 |

### 3.5 导入两项进文件树菜单

放在**目录 / 空白的右键菜单**（与「新建 / 粘贴」同组）——导入要指定落在哪个目录，语义上属"在这建东西"。不放进页面 ⋮（那儿没有"导入到哪"的答案）。

> **与原型的一处偏差**（如实记）：原型把这两条画在 ⋮ 的「文件」组里；落地改为放进文件树目录/空白菜单。理由同上，且 Obsidian 的导入也在文件列表侧。

### 3.6 新写的三项（各自独立小批）

| 项 | 做法 | 风险 |
|---|---|---|
| 在标签页中显示反向链接 | 阅读态正文末尾挂内联反链（数据源现成：右栏「关联网络」同一份查询）；给一个显示开关 | 长文末尾多一坨；与正文样式要区分 |
| 导出为 PDF | 主进程 `printToPDF`；**先定用哪个渲染面**（阅读态 / 沉浸态 / 隐藏窗口喂独立 HTML）与落盘口径 | 中文字体、分页断行、代码块与表格跨页、图片相对路径 |
| 增加笔记属性 | frontmatter 可视化编辑面板（照「文件信息」卡的弹层位） | 与源码档 / 编辑器缓冲区**双向同步**；`id` 必须锁死不可改 |

## 四、批次与验收

| 批 | 内容 | 状态 |
|---|---|---|
| **1a** | ⋮ 新增条目原语 + 五条自足项（md 的系统打开 / 文件夹显示、复制路径 ▸ 两档、md 的查找 / 替换）+ 键位提示走键帽 | **已落码**（2026-10-13，`docs/ui-updates.md` §51；md 分支新增「编辑 / 文件 / 系统」三组） |
| **1b** | 模块层管道六条（重命名 / 移动 / 副本 / 定位 / 删除 / 分屏）+ 树菜单导入两项 + 修掉「删除页面」假按钮 + 既有 8 处键帽统一 | **已落码**（2026-10-13，§52；新契约 `.AGENT/scripts/page-menu/verify-page-menu.mjs`） |
| **1c（收尾）** | 既有条目的叫法统一与重排（页面→视图、非 md 四项归位、「在系统中打开」与文件树的「使用默认应用打开」并成一句）+ 菜单项 ↔ 真源双向登记 | 待做（要连带改 3 份契约，单独一轮） |
| **2** | 在标签页中显示反向链接 | 待做 |
| **3** | 导出为 PDF（先出原型定渲染面） | 待做 |
| **4** | 增加笔记属性 | 待做 |
| **收尾** | 每批同步 `docs/ui-updates.md` 流水 + 真源 + 手册 | 随批进行 |

## 五、明确不做（本次排除，台账留档）

- **在新窗口中打开**：单实例锁 + 单窗 `windowBus`，要做等于新开窗口通道（退一步可只做只读阅读窗）。
- **打开版本历史**：只有会话内撤销栈（`src/lib/fileOpHistory.ts`），没有版本化存储 —— 属新子系统。
- **将该笔记合并到…**：仓库无合并语义（frontmatter / 附件 / 双链 / 标题冲突）。
