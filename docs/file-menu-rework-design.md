# 文件树右键菜单重做（设计）

> 状态：**已落码**（2026-10-12）。契约：`.AGENT/scripts/file-menu/verify-file-menu.mjs`（74 项）
> 原型：`E:\Projects\KnowledgeRecorder\tmp\file-menu-proto\index.html`（568 行，可交互；配套 `_smoke.mjs` 20 项冒烟断言全绿）
> 上游：批 1（非 Markdown 落点）/ 批 2（非 Markdown 统一顶栏）—— 那两批解决「打开什么」，本批解决「右键能做什么」。
> 触发：用户给的两张图 —— 图一我们现状（右侧空白偏多、且混了两类动作），图二 Obsidian 的文件菜单。

## 一、问题

### 1.1 面板宽度：恒定约 85px 的右侧死区

`E:\Projects\KnowledgeRecorder\src\components\shared\FileContextMenu.tsx:63` 的面板是 **shrink-to-fit**，
但被 `min-w-[216px]` 钉死了下限。而各宿主最长的一条（「新建分类目录」，6 个 CJK 字 @ 12.5px）只需要约 **130px**
⇒ 每条右侧恒定留 **约 85px 点不到的空白**。这就是图一那截「长出来的空白」。

★ 这颗面板有 **6 个调用点**（见 §三）：**4 个文件条目菜单 + 2 个排序菜单**（排序菜单借它的长相）。
改一处、六处一起变 —— 这既是收益（一次修好）也是风险（排序菜单也会变窄，要一起看）。

### 1.2 文件条目的菜单混了两类动作

Obsidian 把「在这建东西」只给**文件夹与空白处**；我们把它也塞进了**文件条目**的菜单。
图一那颗 10 项里 5 项是「建 / 粘贴」（新建文件 / 新建目录 / 新建分类目录 / 粘贴），
只有 5 项是「对这个文件做什么」（打开 / 重命名 / 创建副本 / 删除）。

### 1.3 与 Obsidian 比，缺的能力分三类

| Obsidian 项 | 我们的状态 | 依据 |
|---|---|---|
| 在新标签页中打开 | **已有** | = 现在的「打开」（`handleTreeOpenFile`） |
| 在新标签组中打开 | **换入口** | 页面级分屏已有，入口在页签右键（`onSplitPage`） |
| 创建副本 | **已有** | `duplicateWorkspaceFile` |
| **将文件移动到…** | **需新做 UI** | 落盘通道现成：`handleTreeMove` → `workspaceRename`；目录数据源现成：`loadTreeSubtree` |
| 复制路径 ▸（相对 / 完整） | **半有** | 知识库已有 `handleCopyPath(type,id,'abs'\|'rel')`；各宿主菜单里只有一档 |
| 使用默认应用打开 | **已有能力、不在菜单里** | `workspaceOpenInSystem(rootId, rel, false)`（批 2 刚做进非 md 顶栏） |
| 在系统资源管理器中显示 | **已有能力、不在菜单里** | 同上，`reveal: true` |
| 重命名 / 删除 | **已有** | — |
| 在新窗口中打开 | **本轮不做** | Electron 单实例锁，要新开窗口通道 |
| 收藏 | **本轮不做** | 非 md 主进程拒绝写 frontmatter（会毁文件） |
| 将该笔记合并到… | **本轮不做** | 仓库里没有笔记合并 |
| 打开版本历史 | **本轮不做** | 仓库里没有版本历史，等于新子系统 |

## 二、拍板（用户已确认）

| 项 | 选择 |
|---|---|
| 面板宽度 | **内容自适应** —— 去掉 `min-w` 地板，面板贴内容 |
| 「将文件移动到…」形态 | **搜索弹层** —— 带输入框的扁平目录列表，输入筛选、Enter 确认 |
| 文件条目菜单里的「新建 / 粘贴」 | **拿掉**，只留给文件夹条目与空白处 |
| 四项新能力 | **只做「将文件移动到…」**；新窗口 / 收藏 / 合并笔记 / 版本历史 不做 |

## 三、现状盘点：6 个调用点

| # | 位置 | 用途 | 文件条目的菜单内容 |
|---|---|---|---|
| 1 | `src\components\workbench\WorkbenchLeftPanel.tsx:338` | 排序菜单（借壳） | — （`TREE_SORT_OPTIONS`） |
| 2 | `src\modules\knowledge\index.tsx:2175` | 排序菜单（借壳） | — （同上） |
| 3 | `src\components\workbench\WorkbenchFileTree.tsx:320-348` | **工作台文件树** | 重命名 / 创建副本 / 复制路径 / 删除 |
| 4 | `src\modules\knowledge\index.tsx:2270-2302` | **知识库文件树** | 新建×3 / 粘贴 / 打开 / 重命名 / 创建副本 / 删除 |
| 5 | `src\modules\ai-teaching\AiTeachFileTree.tsx:184-216` | **AI 教学文件树** | 打开阅读 / 打开渲染预览 / 重命名 / 复制（到剪贴板）/ 创建副本 / 复制路径 / 钉到收藏 / 删除 |
| 6 | `src\components\workbench\WorkbenchLeftPanel.tsx:577-602` | **总览·零散文件** | 打开 / 创建副本 / 复制路径 / 重命名 / 删除 |

三个宿主都已有移动落盘通道：`WorkbenchFileTree.doMove`（`:234`）、`knowledge.handleTreeMove`（`:980`）、
`AiTeachFileTree` 的 `onMove` 内联实现（`:232-237`）。**零散文件**那处没有（它只列仓库根层，见 §六）。

## 四、落码

### 4.1 组件级：`src\components\shared\FileContextMenu.tsx`

1. **宽度**：删掉 `min-w-[216px]`，保留 `max-w-[300px]`。`absolute` + 无 `width` 本身就是 shrink-to-fit，
   去掉地板即贴内容。排序菜单（只有 3-4 项）会明显变窄 —— 这是预期效果，不是回归。
2. **二级面板自动选边**：新增按可用空间选边的逻辑（面板右缘到视口右缘不足子面板预估宽时，子面板改往左开）。
   ★ 为什么必须做：同一颗组件既服务**左栏文件树**（往右开没问题），也服务**知识页顶栏的 ⋮**（贴窗口右缘，
   那里已有的「文件格式 ▸」是**写死往左**的）。加二级菜单就会撞上这个分叉。
   做法：面板算一个 `data-side="left|right"`，子面板 CSS 按属性选 `left: calc(100% + 4px)` 或 `right: calc(100% + 4px)`。
3. **`FileMenuItem` 加 `submenu?: { label: string; onSelect: () => void }[]`** —— 现在没有二级能力，
   知识页 ⋮ 的「文件格式 ▸」是手写的。加了之后「复制路径 ▸」才能复用同一套选边逻辑。
4. **`FileMenuItem` 加 `picker?: 'dir'`** —— 声明这一项点开后挂「目录搜索弹层」而不是子菜单。

### 4.2 新增共享件：`src\components\shared\DirPicker.tsx`

| 项 | 内容 |
|---|---|
| 数据源 | `loadTreeSubtree(rootId, '', 2000)`（`src\lib\treeExpand.ts:20`，已带 2000 目录上限与 `truncated` 标记） |
| 形态 | 输入框（实时筛选，纯前端过滤已取回的扁平列表）+ 缩进显示层级的目录行 + 脚注「Enter 移到高亮项 · Esc 取消」 |
| 排除项 | 源文件当前所在目录、源文件自身（若是目录则排除自身及其子孙） |
| 空态 | 「没有匹配的目录」；加载中给骨架；`truncated` 为真时脚注加一句「目录过多已截断」 |
| 键盘 | `Enter` 选第一项 · `↑↓` 移动高亮 · `Esc` 关闭 |
| 动效 | 面板挂 `kb-pop`（铁律 13：弹层进出必须带动效） |

### 4.3 各宿主的条目表

**统一原则**：文件条目只放「对这个文件做什么」；「新建 / 粘贴」只留文件夹与空白处。

| 宿主 | 文件条目改成 | 目录条目 |
|---|---|---|
| 知识库文件树 | 打开 / **将文件移动到…** / **复制路径 ▸** / **使用默认应用打开** / **在系统资源管理器中显示** / 创建副本 / 重命名 / 删除 | **不动**（新建×3 + 粘贴 + 展开 / 收起 + 重命名 + 删除） |
| 工作台文件树 | **将文件移动到…** / **复制路径 ▸** / **使用默认应用打开** / **在系统资源管理器中显示** / 创建副本 / 重命名 / 删除 | **不动** |
| AI 教学文件树 | 打开阅读 / 打开渲染预览 / **将文件移动到…** / **复制路径 ▸** / **使用默认应用打开** / **在系统资源管理器中显示** / 钉到收藏 / 创建副本 / 复制（到剪贴板）/ 重命名 / 删除 | **不动** |
| 总览·零散文件 | **将文件移动到…** / **复制路径 ▸** / **使用默认应用打开** / **在系统资源管理器中显示** / 创建副本 / 重命名 / 删除 | 不适用（该列表只有文件） |

★ **AI 教学那套「复制（到剪贴板）+ 到目标目录右键粘贴」保留不动** —— 它是「复制一份」语义
（`doDuplicate`），与「移动到…」不是同一件事，两者并存不冲突。

### 4.4 顺手修：复制路径改走主进程剪贴板

四处现在都是 `navigator.clipboard.writeText(relPath)`，而批 1 定的口径是
「渲染层不直连 `navigator.clipboard`，走 `copyText`」（见 `PageEditor.tsx:266-268` 的注释）。
这次反正要改这行（变成二级菜单），一并统一到 `copyText`。

## 五、契约同步（不改必红）

| 契约 | 为什么必须改 |
|---|---|
| `E:\Projects\KnowledgeRecorder\.AGENT\scripts\workbench-shell\verify-workbench-shell.mjs:704` | `N4 操作接线：复制路径` **正向断言** `navigator.clipboard.writeText(node.relPath)`。改成二级菜单 + `copyText` 后必然失配 ⇒ 同批改写，并顺带把 N4 从八项扩到十项（补「将文件移动到…」与「系统打开 / 资源管理器定位」两条新入口） |
| **新增** `.AGENT\scripts\file-menu\verify-file-menu.mjs` | 本批正向契约：宽度无地板 · 选边逻辑 · `submenu` / `popover` 两个新字段与两种展开时机 · `DirPicker` 的排除与空态 · 两个宿主的条目表（文件条目无「新建 / 粘贴」）· 范围锁 |

### 5.1 顺手校正的三条**陈旧断言**（不是行为回归）

用 `git show HEAD:<file>` 逐条对过：这三条在**改动之前就是红的** —— 它们锁着已经不存在的写法，
留着会掩盖真回归，且都在本批的改动面里，故一并校正：

| 契约 | 原来锁什么 | 实际是什么 |
|---|---|---|
| `.AGENT\scripts\editor\verify-paste-external.mjs` 「右键菜单含粘贴入口」 | `>粘贴</button>` + `setTreeMenu(null); requestPasteFromMenu(dirRel)` | 菜单项早就是**数据**（由共享 `FileContextMenu` 渲染），这两个字面量在 HEAD 上就不存在 |
| `.AGENT\scripts\ai-teaching\verify-teach-tree-inline.mjs` C3 | `run: () => startRename(node)` | 共享菜单 API 是 `onSelect:`，`run:` 是**旧 API** 的字段名 |
| `.AGENT\scripts\workbench-shell\verify-workbench-shell.mjs` N8 | FileContextMenu 的层类名 `fixed inset-0 z-[70] kb-pop-layer` 出现在 `WorkbenchFileTree.tsx` 里 | 那个类名在 `FileContextMenu.tsx` 里 —— 断言找错了文件（批 2 时它就在那 5 条既有 FAIL 里） |

## 六、范围锁

**改造铺到哪两个宿主（用户已确认）**：**知识库文件树** + **工作台文件树**。

★ 但组件级的两处改动（去宽度地板 + 二级面板选边）**自动作用于全部 6 个调用点** ——
也就是两个排序菜单、AI 教学文件树、总览零散文件的菜单**也会跟着变窄**。它们的**条目不动**，只是宽度贴内容。

**不做**：

- 在新窗口中打开 / 收藏 / 将该笔记合并到… / 打开版本历史（四项已拍板排除）
- **在新标签组中打开**：能力在（`onSplitPage`），但只有知识库宿主有；其余三个宿主没有页面级分屏通道。
  本轮不加，避免做出「同一个菜单项在四个宿主里三个是灰的」。
- **AI 教学文件树 / 总览零散文件的条目表**：维持现状。前者有自己的「打开阅读 / 打开渲染预览 / 钉到收藏 /
  复制到剪贴板」，本轮不压平；后者只列仓库**根层**文件，加「移动到…」会让文件移进子目录后从列表消失
  （语义上说得通，但容易被读成「文件不见了」）。契约 F 组锁住这两处不被顺手改。
- **目录条目的「将文件夹移动到…」**：`handleTreeMove` 支持目录（分类目录除外），但用户这轮说的是
  「文件条目」。目录目前仍靠拖拽移动。
- 导图 / 图片渲染（批 3 的事）

## 七、门禁（2026-10-12 实测）

| 门禁 | 结果 |
|---|---|
| `tsc -p tsconfig.web.json` / `tsconfig.node.json` | **0 / 0** |
| 本批契约 `verify-file-menu.mjs` | **74 / 74 PASS** |
| `verify-workbench-shell.mjs` | **N4 由红转绿**（并扩到十项）；余 5 条 FAIL（E6f / G4 / G9 / N8 / N13b）是**既有**的 |
| `verify-paste-external.mjs` | **60 PASS / 1 FAIL** —— 余下那条 `J1 符号链接源被拒` 报「环境无法创建 junction，用例未执行」，是**沙箱环境限制**，非代码问题 |
| `verify-teach-tree-inline.mjs` | **23 / 23 PASS**（C3 校正后由红转绿） |
| `verify-tree-create-channels.mjs` | **18 / 18 PASS** |
| `verify-notes-inline-edit.mjs` | **67 / 0 PASS** |
| 批 2 `verify-nonmd-topbar.mjs` | **54 / 54 PASS** |
| 批 1 `verify-content-routing.mjs` | **65 / 65 PASS** |
| `verify-note-topbar.mjs` | **58 / 58 PASS** |
| `verify-note-surface.mjs` | **196 / 196 PASS** |
| `verify-page-split.mjs` | **41 / 41 PASS** |
| help 检索 `verify-help-retrieval.mjs` | **88 / 88 PASS**（+6 条本批问句） |
| 更新说明 `verify-release-notes.mjs` | **PASS**（46 版本 / 574 条目） |

原型自测：`node tmp/file-menu-proto/_smoke.mjs` → **20 / 20 PASS**（DOM 桩上真跑 + 逐条走新增路径）。
