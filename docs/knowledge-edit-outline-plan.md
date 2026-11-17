# 笔记编辑态左栏大纲 · 实现方案

> 状态：已确认原型（`tmp/knowledge-outline-edit-proto/index.html`），本文件记录落码口径。
> 关联：`docs/knowledge-feed-topics-plan.md` §4.4（阅读态自动大纲的原方案）。

## 1. 背景

当前笔记左栏的自动大纲只在**阅读态**生效：

```ts
const outlineMode = !readingMode && !!activePageId && !homeActive && !activeTopicId
  && activeIsMd && activePreview && !manualFeed
```

`PageEditor` 上报 `activePreview=false`（进入编辑）后，左栏立刻退回三视图笔记列表。
编辑长文时想按标题定位，只能先切回阅读态，或者滚动找标题 —— 与写作时的实际需求相反。

## 2. 目标行为（已与用户确认）

1. Markdown 笔记**阅读态、编辑态都保持大纲**；只有点「返回列表」才回笔记列表。
2. 大纲**随正文修改实时刷新**（新增 / 删改标题），输入侧做约 150ms 防抖，避免大文档每个键全量解析。
3. 点大纲条目：编辑态定位到对应源码行并选中；阅读态平滑滚动（沿用现有 `outline:go-to-heading`）。
4. 「返回列表」保留在大纲顶部与工作台头部（与现状一致，不改）；换一篇笔记后自动恢复大纲。
5. 非 Markdown（PDF / 图片 / 代码 / 文本）编辑/阅读时左栏保持文件列表。
6. 标题为空时显示「大纲内容为空」空态（不回落文件列表）。

## 3. 改动清单

### 3.1 `src/modules/knowledge/index.tsx`

- `outlineMode` 去掉 `activePreview` 条件（`activeIsMd` + `!manualFeed` 仍保留）。
- 新增 `livePageId`：`handleLiveContent` 记录「这份正文属于哪一页」，切页后不拿上一篇的大纲冒充新页。
- 大纲正文改为「防抖后的快照」：
  - 阅读态 / 沉浸态直接跟随；
  - 编辑态 `setTimeout(150ms)` 后再 `parseHeadings`；
  - `activePageId` 变化立即清空快照，避免旧页标题残留。
- 装载占位：新页正文尚未上报时，`OutlinePanel` 显示「正在加载正文…」，不闪「大纲内容为空」。
- 两个 `OutlinePanel` 调用点（沉浸阅读 / 普通左栏）传 `pageId` 与 `loading`。

### 3.2 `src/components/shared/OutlinePanel.tsx`

- `navigateToHeading(line, id, pageId?)`：事件 detail 增加 `pageId`。
- `OutlinePanel` 新增可选 props：`pageId?: string`、`loading?: boolean`。
- `loading` 时渲染加载占位（搜索框保留，避免布局跳动）。

### 3.3 分屏定位（顺带修正）

同一窗口可能同时挂着主栏 + 副栏两个 `PageEditor` 实例，两者都在监听
`outline:go-to-heading`。此前点主栏大纲会**两栏一起跳**；编辑态大纲成为默认后暴露面更大。

- `PageEditor`：事件带 `pageId` 时，只处理 `pageId === 自己的 pageIdRef.current` 的请求。
- `blog/MarkdownEditor`：知识库事件带 `pageId`（目标页身份）时直接忽略，避免隐藏的博客编辑器跟着滚动。

### 3.4 文档 / 契约 / 手册

- `docs/knowledge-feed-topics-plan.md` §4.4、验收清单同步改为「阅读 / 编辑都自动大纲」。
- 新增契约 `.AGENT/scripts/knowledge-outline/verify-outline-edit.mjs`：
  - 大纲判定不再依赖 `activePreview`；
  - 防抖 150ms + 切页清空；
  - `pageId` 透传与三处消费者过滤；
  - 非 md / 空态 / 返回列表口径不漂移。
- 更新 `.AGENT/scripts/knowledge-topics/verify-topics.mjs` 的阅读态断言。
- 帮助手册：`resources/help/笔记 · 主题与总览.md`、`resources/help/模块一览.md`。
- `CHANGELOG.md` 新条目 + `package.json` 3.43.0（新功能抬 minor）+ 重跑
  `.AGENT/scripts/release-notes/build-release-notes.mjs`。

## 4. 取舍与风险

| 风险 | 处理 |
|---|---|
| 每个键都全量解析 Markdown，大文档卡顿 | 150ms 防抖；阅读态才实时直通 |
| 切页瞬间沿用上一篇标题 | `livePageId` 校验 + 切页清空 + 装载占位 |
| 分屏时两栏同时跳 | 事件带 `pageId`，消费者按页过滤 |
| `manualFeed` 覆盖失效 | 换页 / 打开页仍复位；文件列表点当前页也退出覆盖 |
| 非 md 误入大纲 | `activeIsMd` 判定不变 |
| 大纲搜索框因刷新失焦 | `OutlinePanel` 保持同一实例，只换 `headings` prop |

## 5. 验收

- `npx tsc --noEmit -p tsconfig.web.json` / `tsconfig.node.json`。
- `node .AGENT/scripts/knowledge-outline/verify-outline-edit.mjs`。
- `node --experimental-strip-types .AGENT/scripts/knowledge-topics/verify-topics.mjs`。
- `node .AGENT/scripts/workbench-shell/verify-workbench-shell.mjs`。
- `npm run build`。
- 真机：编辑长文增删标题看左栏跟随；点标题跳行；「返回列表」后可换笔记；PDF 保持列表；分屏只主栏跳。
