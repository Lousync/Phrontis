# 页面级分屏 · 未完成与交接记录

> 记录时间：2026-10-12。基线：主 worktree `E:\Projects\KnowledgeRecorder`，分支 **`feature/v3.5.0`**，
> 合并提交 `0a66f32`（已推送 `origin/feature/v3.5.0`）。

## 一、已完成并入主线（背景）

- **左栏文件树/条目/右键菜单重做（Obsidian 风）**：`fb9981b`（含 `FileContextMenu` / `FileExtBadge` /
  `TreeExpandButton` / `sidebarHeaderIcon` / `treeSort` / `treeExpand` / `fileName` / `fileDuplicate`、
  `ws:copy` IPC 等）。
- **页面级分屏（只搬「页面标签」，模块整体不分栏）**：`57f4798`（数据模型+副栏骨架）→ `44ebd52`（跨栏拖/切页/自动合并）
  → `91114e5`（副栏接真实 `PageEditor`）→ `1319a46`（持久化+契约脚本）。设计见
  `.claude/plans/split-screen-page-level.md`，原型 `tmp/page-split-proto/index.html`。
- **期间一度做错的模块级分屏已回退**：`0b028e6`（dev3 历史里仍留有 `ec0553d..009913a` 那 10 个被 revert 的提交，属噪音）。

## 二、未完成（按优先级）

### 1. 【必做】AI 手册同步（用户可见功能未落文档）
分屏与「左栏文件树/右键菜单重做」都是用户可见功能，`resources/help/*.md` 是 AI 回答「软件怎么用」的唯一语料，
不同步 = AI 照旧文档说错话且无报错。本次涉及时曾明确「先不急着写」。
- 可能受影响：`resources/help/工作台左栏与文件树模式.md`（页面条/拆分/文件树）、
  `resources/help/模块一览.md`、`resources/help/快速上手.md`；若分屏涉及编辑器，另看 `笔记 · 写作模式与编辑器.md`。
- 流程：`.AGENT/help-rewrite/README.md`；验收检索：`.AGENT/scripts/help-kb/verify-help-retrieval.mjs`。

### 2. 【实机验收】运行时未验证
合并只做了编译/契约级校验（`tsc` web+node、`electron-vite build`、契约脚本），**没跑运行时**。
建议 `npm run dev`（端口 7173）重点过：
- 分屏：页面标签右键「向右/向下拆分」→ 副栏渲染真实页面；跨栏拖页面；副栏切页；拖空自动合并；重启恢复。
- 与同期合并的「笔记顶栏 NoteTopBar」是否互不干扰（两者都改了 `modules/knowledge/index.tsx` 与 `PageEditor` 一带）。

### 3. 【取舍待定】分屏的已知简化
- 副栏**没有页面级工具栏**（格式切换/预览/保存等）——副栏 `PageEditor` 传 `isActive=false`（该 prop 只控制右上悬浮工具栏 portal，避免两实例抢主栏单例槽 `#editor-toolbar-slot`）。若要副栏也有工具栏，需给副栏一套独立槽位。
- 两栏各持一套 Monaco，重页面内存翻倍。

### 4. 【可选清理】
- 本地分支 `feature/dev3` 仍在（`1319a46`，已并入 v3.5.0）：`git branch -d feature/dev3`。
- dev3 worktree 已删除（`E:\Projects\KnowledgeRecorder-dev3` 不存在）。

## 三、关键文件（页面级分屏）
- `src/App.tsx`（`pageSplit` 状态/渲染/持久化、`mainPageBar`、副栏两槽、`.kb-pane-divider`）
- `src/components/workbench/PageTabStrip.tsx`（`onExternalDrop` 跨栏）
- `src/modules/knowledge/index.tsx`（主/副栏页签条、拆分菜单、副栏 `PageEditor` portal）
- `src/lib/workbenchLayout.ts`（`PageSplitLayout` + 钝解析）
- `src/styles/index.css`（`.kb-pane-divider`）
- 契约脚本：`.AGENT/scripts/page-split/verify-page-split.mjs`（40 项）

## 四、验证命令
```bash
npx tsc --noEmit -p tsconfig.web.json
npx tsc --noEmit -p tsconfig.node.json
node --experimental-strip-types .AGENT/scripts/page-split/verify-page-split.mjs
node --experimental-strip-types .AGENT/scripts/note-topbar/verify-note-topbar.mjs
npm run build
```
