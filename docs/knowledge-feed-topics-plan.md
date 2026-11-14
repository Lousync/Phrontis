# 笔记区改造（笔记流 + 虚拟主题）实现方案

> 状态：**A 批已实施（v3.27.0，2026-11-14）；B 批已实施（v3.28.0，2026-11-14）**。
> 原型（本地，不入库）：`tmp/note-zone-proto/index.html`
> 拍板记录：2026-11-14 用户确认「主题 = 虚拟集合」等 8 条；本文所有「已拍板」以那轮为准。
>
> **实施结果与偏差**：
> - 两处收敛均按本方案落地：结构视图复用 `VaultTree`（无空间/笔记本模型）；主题详情是临时标签、总览是常驻固定标签。
> - 「返回列表」回到的是**进入大纲前的三视图**（最近 / 主题 / 结构），不是强制回「最近」。
> - 聚焦只属于「最近」视图（切走即清除），避免出现「看着已聚焦、列表没过滤」的假开关。
> - 数据层新增 `phrontis-core/src/kbStore/knowledgeTopicsRepo.ts`；纯函数在 `src/modules/knowledge/topicsPure.ts`。
> - 契约：`.AGENT/scripts/knowledge-topics/verify-topics.mjs`（静态 + 纯函数真值）、
>   `.AGENT/scripts/knowledge-topics/probe-feed.mjs`（真实 DOM，23 项）。


## 0. 已拍板（来自原型讨论）

| # | 结论 |
|---|---|
| 1 | 主题 = **虚拟集合**，不绑定目录 |
| 2 | 主题可以**跨空间 / 跨目录** |
| 3 | 一篇笔记可以属于**多个主题** |
| 4 | 「未归类」= **不属于任何主题**（目录不再算归类） |
| 5 | 拖到主题卡 = **加入主题**；移动文件只在「结构」视图 |
| 6 | 成员存 **pageId**（`topics.json`），不写 frontmatter；改名/移动不断链 |
| 7 | **不做首次迁移**：首次打开 0 个主题，全部笔记未归类 |
| 8 | 主题详情页要；成员按目录分组展示 |

配套（按推荐）：
- 创建入口三处：顶部 `＋` 菜单、主题视图「＋ 新建主题」、笔记右键「加入主题… / 新建主题并加入…」
- 删除主题只解散集合、笔记保留；删除确认走行内确认卡
- AI 只提案成员关系，不移动文件（B 批）

## 1. 范围与版本

- 当前版本 `3.26.0`；本轮是新功能 → **3.27.0**（minor）。
- **A 批（3.27.0）**：数据层 + 摘要 + IPC + 侧栏三视图 + 总览 + 固定总览标签 + 大纲 + 主题详情 + 未归类 + 契约 + 帮助手册。
- **B 批（3.28.0）**：AI 读写工具（`knowledge.topics` / `knowledge.topic.assign`）+ 确认方案 + AI 手册。
- 不在本轮：手机伴侣同步主题、旧 `NotebookList` / `ChapterPanel` 死代码清理（单开一批）、主题封面/图标、主题内嵌白板。

### 两处对原型的主动收敛（请确认）

1. **结构视图复用真实目录树**：原型里的「空间 → 笔记本」是演示数据；主程序现在的活入口只创建 `folder` 目录，`space` / `notebook` 是旧笔记树遗留且已无渲染入口。所以结构视图直接用 `VaultTree`（与当前文件树同一实现），**不引入新的空间/笔记本模型**；`＋` 菜单是「新建笔记 / 新建主题 / 新建目录」，不出现「新建空间」。
2. **主题详情是临时标签**：同时只开一个，不持久化、不参与分屏/固定（避免把 `topic:` 塞进现有 pageId 体系）；总览是常驻固定标签（恒第一位、不可关闭）。若你需要主题页像普通页签一样持久化，需要额外一轮 restore 逻辑。

## 2. 数据模型

### 2.1 `topics.json`

路径：`.knowbase/modules/knowledge/topics.json`（与 `categories.json` 同目录，唯一写方 = 新仓库文件）。

```json
{
  "version": 1,
  "topics": [
    {
      "id": "tp_9f2c…",
      "name": "面试高频",
      "desc": "操作系统 / 网络 / 数据库里反复被问到的点",
      "color": "teal",
      "members": [
        { "pageId": "a1b2…", "addedAt": "2026-11-14T09:00:00.000Z", "source": "manual" },
        { "pageId": "auto:计网/TCP.md", "path": "计网/TCP.md", "addedAt": "…", "source": "ai" }
      ],
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

- `color` 存**调色板键**（`blue | teal | gold | purple | red | sky`），渲染层映射成主题感知的 CSS 变量；不存 hex（亮/暗主题各自可读）。
- 成员对象而不是纯字符串：`addedAt` / `source` 给「最后整理」与审计用；读取时兼容 `string[]` 旧形状。
- 文件缺失 = 空列表；损坏时把原文件备份成 `topics.corrupt-<ts>.json` 再按空处理，避免下次写入直接吞掉。
- 上限：主题名 ≤ 80 字；描述 ≤ 300 字；单主题成员 ≤ 2000；同名主题禁止（trim 后精确比较）。

### 2.2 身份与失效（关键）

主题成员记 `pageId`：

- 稳定 id 页：改名、移动目录、AI 搬文件都不影响。
- `auto:<relPath>` 临时身份页：成员里同时写 `path`。读取时按 path 回查索引，命中就把成员**在内存里改写成真 id**；下一次写盘时落定。这样「先加主题、后首次保存」不会断链。
- 不存在的成员：读取时**惰性剔除**（只在内存），不做定时任务、不做删除级联写；下次写盘自然清掉。
- 非 md 归档文件允许加入主题（`entryKind:'file'`）；摘要为空，详情页显示文件类型角标。
- 不做「目录 → 主题」播种（拍板 7）。

### 2.3 摘要（喂左栏与总览）

现状：`vaultGetPages()` 不读正文，`KnowledgePage.contentMd` 为空；左栏每行要一行摘要。

方案：**在知识索引里算**，不新增 IPC。

- `phrontis-core/src/kbStore/knowledgeIndex.ts`
  - `KnowledgePageIndexEntry` 加 `excerpt: string`；
  - 建索引时（正文已读）`excerpt = mdToPlain(doc.body).slice(0, 120)`；
  - `KNOWLEDGE_INDEX_SCHEMA_VERSION` 7 → **8**（缓存失效一次）；
  - `vaultGetPages` / `entryToPage` 带出 `excerpt`。
- `src/types/index.ts`：`KnowledgePage.excerpt` 注释改为「列表摘要（前 120 字）/ 搜索命中摘录」。
- 非 md 文件 `excerpt=''`；搜索结果的命中摘录仍然覆盖列表摘要。

## 3. 主进程 / 数据层

> 注意：kbStore 实现层在**独立本地包** `/home/lousync/Projects/phrontis-core`（`package.json` 里 `file:../phrontis-core`）。本轮数据层改在 core 仓，IPC 改在主仓。

### 3.1 core 仓

新增 `phrontis-core/src/kbStore/knowledgeTopicsRepo.ts`：

- `vaultGetTopics(): VaultTopic[]`
  - 读 `topics.json`、归一化、按 2.2 修复 auto id、惰性剔除失效成员；
  - 返回带成员数组的完整主题（成员 ≤ 2000）。
- `vaultCreateTopic({ name, desc?, color? }): VaultTopic`
- `vaultUpdateTopic(id, patch: { name?, desc?, color? }): VaultTopic`
- `vaultDeleteTopic(id): void`
- `vaultPatchTopicMembers(id, { add?: string[], remove?: string[] }): VaultTopic`
  - 去重；`add` 时若 pageId 以 `auto:` 开头则写 `path`；一次写入 + 一次 `updatedAt`。
- 写入统一 `writeJsonOrThrow('modules/knowledge','topics.json', data)`（原子 tmp+rename）。
- 只写 `topics.json`，**绝不碰页面文件 / frontmatter**。
- 数据层不广播；广播由 IPC / AI 工具层负责（避免双广播）。

导出类型（core 与渲染层共享形状）：

```ts
export type TopicColor = 'blue'|'teal'|'gold'|'purple'|'red'|'sky'
export interface TopicMember { pageId: string; path?: string; addedAt: string; source: 'manual'|'ai' }
export interface VaultTopic {
  id: string; name: string; desc: string; color: TopicColor
  members: TopicMember[]; createdAt: string; updatedAt: string
}
```

### 3.2 主仓 IPC

`electron/database/repositories/knowledgeRepo.ts`：

- `VAULT_ALLOWED` 增加 5 个通道：
  - `knowledge:topics:list` → `vaultGetTopics()`
  - `knowledge:topics:create` → `vaultCreateTopic(data)`
  - `knowledge:topics:update` → `vaultUpdateTopic(id, patch)`
  - `knowledge:topics:delete` → `vaultDeleteTopic(id)`
  - `knowledge:topics:members` → `vaultPatchTopicMembers(id, {add,remove})`
- 每个写通道写完后 `broadcastDataChanged('knowledge')`（铁律 1）；读通道不广播。
- 错误原样抛给渲染层（同名主题 / 名称过长 / 越界 id 等），由界面的内联输入显示。

`electron/preload/index.ts` + `src/lib/ipc.ts` + `src/types/index.ts`：

```ts
getKnowledgeTopics(): Promise<KnowledgeTopic[]>
createKnowledgeTopic(d: CreateKnowledgeTopicDTO): Promise<KnowledgeTopic>
updateKnowledgeTopic(id, d: UpdateKnowledgeTopicDTO): Promise<KnowledgeTopic>
deleteKnowledgeTopic(id): Promise<void>
patchKnowledgeTopicMembers(id, p: { add?: string[]; remove?: string[] }): Promise<KnowledgeTopic>
```

渲染层无需 `notifyKnowledgeTreeChanged`（没有文件树变化）；`useDataChanged('knowledge')` 会收到主进程广播。

## 4. 渲染层

### 4.1 侧栏三视图

`src/modules/knowledge/index.tsx` 的 `sidebarInner` 改成：

```
[模块动作槽：＋ / 排序 / 展开收起 / 聚焦]   ← portal 到 modActionsEl（由工作台头部提供 house/lock，不重复造）
[搜索框]
[最近 | 主题 | 结构] 分段
[列表区：NoteFeed / TopicWall / VaultTree]
[图谱 / 错题本]
[仓库切换条]（工作台已有，模块内不重复）
```

- 视图状态：`feedView: 'recent'|'topics'|'tree'`，持久化到 `SETTINGS.knowledgeFeedView`（默认 `recent`）。
- 搜索：本地过滤 `allPages`（标题 / 摘要 / 标签 / 目录名）；全局搜索仍走 Ctrl+P 面板。
- 聚焦：按活动页的**顶层目录**（path 第一段）过滤；无活动页或根层页 → 禁用并 toast。
- 排序：`SETTINGS.knowledgeFeedSort`（`mtime` / `title`）；标题排序时扁平列表，不按日期分组。
- 密度：复用 `knowledgeSidebarItemSize`（s/m/l）+ `KNOWLEDGE_SIDEBAR_ITEM_VARS`；设置项文案改为「笔记侧栏条目大小（最近 / 主题 / 结构通用）」。
- 侧栏宽度：复用 `sidebarWidth_knowledgeCat`，默认 240 → **280**，min 180 → **220**，max 400 → **420**（已存值不动）。⚠️ `src/lib/settings.ts` 里这套键有**两处**定义（`SETTINGS` 条目 + 下方的 min/max 约束表），改一处必须同步另一处。
- 长列表：笔记行固定两行高度（约 48px），`NoteFeed` 行 `React.memo`；超过 150 行时给行加 `.kb-cv-sm`（铁律 11 的估值 60px 接近真实高度），短列表不加，避免滚动条乱跳。

组件拆分（新增）：

- `components/NoteFeed.tsx`：日期分组、行、悬停 `⋯`、拖拽源、右键菜单、聚焦 chip、空态。
- `components/TopicWall.tsx`：主题卡、拖拽加入、内联新建、未归类卡、搜索空态。
- `components/TopicDetail.tsx`：主题页（hero / 目录分组 / 移除成员 / 重命名 / 行内删除确认）。
- `components/NoteHome.tsx`：总览。
- `topicsPure.ts`：分组、未归类计算、排序、目录标签（零依赖纯函数，供契约脚本直接 import）。

`VaultTree` 原样复用于「结构」视图（含排序、展开/收起、目录聚焦、右键菜单、拖拽移动）。

### 4.2 总览与标签

- **总览是一个常驻标签**：恒第一位、不可关闭、不参与重排；`activePageId == null && activeTopicId == null` 时激活。
- `PageTabStrip` 小扩展（`src/components/workbench/PageTabStrip.tsx`）：
  - `StripItem` 加 `kind?: 'page'|'topic'|'home'`、`closable?: boolean`、`accent?: string`；
  - `home` 渲染房屋图标，`topic` 渲染 grid 图标（带主题色），`closable:false` 时不渲染关闭/固定按钮；
  - 重排时模块层强制 home 在第一（`ids` 过滤后 unshift）；主题标签固定在页签末尾、不参与拖拽。
- `onStripVisibleChange`：总览标签常驻 ⇒ 知识库页面条恒可见（此前无页面时整条隐藏）。
- 总览内容（`NoteHome`）：
  - 继续上次编辑：优先持久化的 `active` 页；为空则最近更新页。
  - 三个统计：本周新增（`createdAt` 近 7 天）/ 已归类（去重成员数）/ 未归类（总数 − 已归类）。
  - 最近修改 8 条、主题集合（成员数前 3）、标签云、未归类前 6 条。
  - 底部保留「回工作台」入口（现有 `onBackToWorkbench`），不要丢。

### 4.3 主题详情（临时标签）

状态：`openTopicId: string | null`（同时一个）+ `activeTopicId: string | null`。

- 点主题卡标题 → `openTopicId = id; activeTopicId = id; activePageId = null`；页签末尾出现主题标签。
- 点总览 / 页面页签 → `activeTopicId = null`，主题标签保留但非激活。
- 关闭主题标签 → 清 `openTopicId`；若正激活 → 回总览（或上一个页签）。
- **不持久化、不分屏、不固定**；重启后只恢复页面页签。
- 详情页：
  - hero：主题色、名称、描述、`N 篇 · 跨 M 个目录`、重命名 / 删除主题；
  - 成员按「顶层目录 / 子目录」分组（无目录 → 散页），行内 `×` 从主题移除（Toast + 撤销）；
  - 删除走行内确认卡；删除后关闭标签、回总览，笔记全部保留。
- 主题改名后同步更新页签标题；主题被删/失效时，激活中的标签自动关闭并提示。

### 4.4 大纲（阅读态自动切）

- `PageEditor` 新增可选回调 `onPreviewChange?: (preview: boolean) => void`（只在主栏实例传）；模块记 `activePreview`，切页复位。
- 侧栏模式：`outlineMode = activeIsMd && activePreview && !manualFeed`。
  - `manualFeed=true`：用户点了「返回列表」或三视图切换；切页复位。
  - 顶部 `大纲` 按钮 → `manualFeed=false`。
  - 非 md / 无页 → 自动回列表。
- 大纲内容复用 `components/shared/OutlinePanel.tsx`（embedded），标题来自现有 `outlineHeadings`；点标题滚动走现有 `outline:go-to-heading` 通道。
- 沉浸阅读（`readingMode`）沿用现有 `immersiveTabOverride === 'outline'` 分支，不新造第二套。

### 4.5 头部动作

`modActionsEl` 只放模块自己的按钮（工作台头部已有 house/lock）：

- `＋`：`TreeNewButton` 三项：新建笔记 / 新建主题 / 新建目录。
  - 新建笔记：落点 = 活动页所在目录 → 上次树选中目录 → 仓库根；创建后打开。
  - 新建主题：切到主题视图，内联命名（不落盘占位）。
  - 新建目录：切到结构视图，内联命名（现有树内联创建通道）。
- 排序：展开菜单最近修改 / 标题（当前项标「当前」）。
- 展开/收起：结构视图全部展开 / 收起；其它视图点击切到结构并展开。
- 聚焦：见 4.1。
- 大纲态：模块动作槽只留「返回列表」，其余隐藏。

### 4.6 拖拽语义

- 笔记行 / 主题成员行：`draggable`，mime `text/plain` = pageId。
- 拖到主题卡：`dropOnTopic` → `patchTopicMembers({add:[id]})`；卡片出现 `+ 加入` 提示；不移动文件。
- 拖到结构视图目录：现有 `handleTreeMove`（移动文件）；主题成员关系因 id 不变而保留。
- 拖到「未归类」卡：不做落点（避免误以为移出全部主题）。
- 乐观更新 + 失败回滚 + Toast；成功后主进程广播刷新。

### 4.7 右键菜单

笔记右键新增「加入主题…」：列出全部主题（已加入的带 ✓，点击切换成员），底部「新建主题并加入…」。

## 5. AI 工具（B 批）

> **已落码（v3.28.0）**：读 `builtin.knowledge.topics` / 写 `builtin.knowledge.topic.assign`；
> 名字 → 主题桥放在 core `vaultResolveOrCreateTopic(name)`（UI 与 AI 共用判重口径，铁律 18）；
> 写工具进 `STAGEABLE_WRITE_TOOLS`；契约 `.AGENT/scripts/knowledge-topics/verify-topic-ai-tools.mjs` 36 项。

### 5.1 读工具 `builtin.knowledge.topics`

- `readOnly: true`，`tier: 'ondemand'`，`module: 'knowledge'`。
- args：`{ topic?: string; pageId?: string; includeMembers?: boolean }`
- 返回：主题 id / 名称 / 成员数；`includeMembers` 时附成员 id + 标题（上限 100）；`pageId` 时返回该页所属主题。
- 不罗列返回字段（铁律 16），schema ≤ 800 字符。

### 5.2 写工具 `builtin.knowledge.topic.assign`

- `requires: 'write'`，`readOnly: false`，`tier: 'ondemand'`，`module: 'knowledge'`。
- args：`{ topicId?: string; name?: string; add?: string[]; remove?: string[] }`
  - 无 `topicId` 且有 `name`：查找，找不到则创建；
  - 只改成员，不移动文件、不改正文；
  - 幂等（重复 add/remove 不报错）。
- 返回 `{ ok, topicId, created, added, removed }`。
- 注册到 `electron/lib/aiAssistantStageable.ts` 的 `STAGEABLE_WRITE_TOOLS`（参数即完整意图、可重放）；确认模式走变更方案，不直接落盘。
- 写后 `broadcastDataChanged('knowledge')`。
- 不提供 AI 删除/重命名主题的工具（只允许人工）。

### 5.3 配套

- `builtin.tool.request` 的 description 增加这两个工具名。
- `.AGENT/scripts/ai-tools-audit/` 基线与 core/ondemand 计数更新。
- AI 手册《AI 权限与工具边界》补「主题只改成员、不移动文件」。

## 6. 文件清单

### core 仓（`/home/lousync/Projects/phrontis-core`）

| 文件 | 动作 |
|---|---|
| `src/kbStore/knowledgeTopicsRepo.ts` | 新增 |
| `src/kbStore/knowledgeIndex.ts` | `excerpt` + schemaVersion 8 |
| `src/kbStore/knowledgeVaultRepo.ts` | `entryToPage` 带出 excerpt |
| `src/index.ts` / `package.json` | 确认导出（`./*` 已覆盖，无需 barrel） |

### 主仓（`/home/lousync/Projects/Phrontis`）

| 文件 | 动作 |
|---|---|
| `electron/database/repositories/knowledgeRepo.ts` | 5 个通道 + 广播 |
| `electron/preload/index.ts` | 5 个 bridge |
| `src/lib/ipc.ts` | 5 个包装 |
| `src/types/index.ts` | `KnowledgeTopic` 等类型 + excerpt 注释 |
| `src/modules/knowledge/index.tsx` | 三视图 / 总览 / 主题标签 / 大纲 / 头部动作 / topics 数据 |
| `src/modules/knowledge/components/NoteFeed.tsx` | 新增 |
| `src/modules/knowledge/components/TopicWall.tsx` | 新增 |
| `src/modules/knowledge/components/TopicDetail.tsx` | 新增 |
| `src/modules/knowledge/components/NoteHome.tsx` | 新增 |
| `src/modules/knowledge/topicsPure.ts` | 新增（纯函数） |
| `src/components/workbench/PageTabStrip.tsx` | home/topic 标签扩展 |
| `src/modules/knowledge/components/PageEditor.tsx` | `onPreviewChange` |
| `src/lib/settings.ts` | view / sort / 宽度默认 / 条目大小文案 |
| `src/styles/index.css` | 主题调色板 token + 行/卡样式 |
| `electron/lib/builtinTools.ts` | B 批两个工具 + request 清单 |
| `electron/lib/aiAssistantStageable.ts` | B 批写工具登记 |

## 7. 契约与测试

新增 `.AGENT/scripts/knowledge-topics/verify-topics.mjs`（Node，直接 import core 源 + 静态断言）：

1. 目录 / 文件：`modules/knowledge/topics.json`、`writeJsonOrThrow`、唯一写方。
2. 纯函数：未归类计算、多主题、目录分组、排序、同名拒绝、成员去重、上限。
3. 身份：改名/移动后成员仍在；`auto:` → 真 id 的 path 修复；删除页惰性剔除。
4. 损坏文件：备份 + 空列表。
5. IPC：5 个通道注册、写后广播、读不广播。
6. 渲染契约：三视图切换、总览固定标签、主题卡拖拽语义、大纲自动切换、头部按钮顺序。
7. 反向断言：不得出现「拖到主题 = 移动文件」、不得写 frontmatter、不得有目录播种。

更新：

- `.AGENT/scripts/knowledge-index/verify-md-entry-fields.mjs`：schemaVersion 7 → 8，并断言 `excerpt` 字段来自 `mdToPlain`。
- `.AGENT/scripts/workbench-shell/verify-workbench-shell.mjs`：旧「文件 | 大纲」断言改为三视图 + 总览标签 + 大纲态。
- `.AGENT/scripts/ai-tools-audit/`：B 批工具计数 / schema 基线。
- `.AGENT/scripts/help-kb/verify-help-retrieval.mjs`：帮助检索全绿。

类型门禁：
- `npx tsc --noEmit -p tsconfig.node.json`
- `npx tsc --noEmit -p tsconfig.web.json`
- `npm run build`

## 8. 帮助手册

- 改写 `resources/help/工作台左栏与文件树模式.md`：笔记侧栏不再是「文件 | 大纲」，改为「最近 / 主题 / 结构」；文件树模式仍在工作台左栏；阅读态左栏自动大纲。
- 更新 `resources/help/模块一览.md` 的笔记条目。
- 新增 `resources/help/笔记 · 主题与总览.md`：虚拟主题、多主题、未归类、总览标签、拖拽语义。
- `resources/help/键盘快捷键.md` 若有「文件/大纲」表述一并改。
- 走 `.AGENT/help-rewrite/README.md` 流程 + 检索验收。

## 9. 风险与取舍

| 风险 | 处理 |
|---|---|
| PageTabStrip 改 home/topic 影响工作台页面条 | 只加可选字段，默认行为不变；契约 + 真机检查 |
| `preview` 默认 true ⇒ 打开笔记即大纲，用户可能找不到列表 | `manualFeed` 覆盖 + 「返回列表」按钮 + 三视图切换；切页复位 |
| 摘要进索引要 bump schema，首次重建一次 | 可接受；重建在启动时一次完成 |
| `auto:` 身份断链 | path 兜底 + 读取时内存修复 + 契约覆盖 |
| 主题文件损坏 | 备份 + 空列表；不静默覆盖 |
| AI 写工具误用 | 只改成员、不移动文件；确认模式暂存；不提供删除工具 |
| 主题页临时标签不符合部分人的预期 | 已写明取舍；要持久化需追加 restore |
| 结构视图与旧 `NotebookList` 并存 | 旧组件已无渲染入口，单开清理批 |

## 10. 分批与验收

### A 批（3.27.0）

1. core：topics repo + excerpt + schema bump。
2. 主仓：IPC / preload / types / ipc 包装。
3. 侧栏三视图（复用 VaultTree）+ 头部动作 + 搜索/聚焦/排序。
4. 总览 + 固定总览标签 + 主题卡 + 主题详情 + 未归类。
5. PageEditor `onPreviewChange` + 大纲自动切换。
6. 契约脚本 + 类型门禁 + 帮助手册。
7. CHANGELOG 3.27.0 → `build-release-notes.mjs`。

### B 批（3.28.0）

1. `knowledge.topics` / `knowledge.topic.assign`。
2. `STAGEABLE_WRITE_TOOLS` + `builtin.tool.request` 清单。
3. 确认方案 UI 文案（主题成员变更摘要）。
4. AI 手册 + 工具审计基线。

### 验收清单（A 批）

- [ ] 1000 页仓库：左栏首屏 < 100ms，滚动不掉帧；摘要不引发逐页读盘。
- [ ] 新建主题 → 内联命名 → 拖 3 篇（跨 2 个目录）→ 卡片显示「跨 2 个目录」。
- [ ] 同一篇加入两个主题；笔记页出现两个主题 chip。
- [ ] 重命名笔记 / 移动到别的目录：主题成员不变。
- [ ] 删除成员笔记：刷新后主题自动剔除，不报错。
- [ ] `auto:` 页加入主题 → 首次保存补 id → 成员仍在。
- [ ] 删除主题：行内确认 → 笔记全部保留。
- [ ] 总览标签常驻、不可关；关闭所有页面后自动回总览。
- [ ] 阅读态左栏自动大纲；点「返回列表」回笔记流；切到编辑回笔记流。
- [ ] 未归类数 = 总数 − 去重成员数；0 主题时全为未归类。
- [ ] 明/暗主题下 6 个主题色都可读。
- [ ] 类型门禁 + 契约 + build 全绿。

---

## 11. 左栏交互优化（v3.27.0 落码后的体验反馈，待拍板）

> 现状问题（2026-11-14 用户反馈）：① 搜索框只在「最近 / 主题」出现，切到「结构」直接消失；
> ② 头部部分按钮只在结构视图成立，在其它视图点会**先把画面切到结构**再执行，手感突兀；
> ③ 头部按钮集合随视图变形（主题视图里「聚焦」整个消失），头部宽度跟着跳；
> ④ 大纲态头部又换一套（只剩「返回列表」）。

原型已把三种做法做进 `tmp/note-zone-proto/index.html`，底部「方案对照」条实时切换：

| 维度 | 现状 | 方案 A（推荐） | 方案 B | 方案 C（未做进原型） |
|---|---|---|---|---|
| 头部动作 | ＋/排序/展开/聚焦 | 只留 ＋ 与 ⋯，其余进 ⋯ 按视图给 | 四钮固定位置，不适用置灰 | —— |
| 结构搜索 | 无（消失） | 查找并定位（平铺结果） | 过渡树（只能覆盖已展开目录） | 统一走全局搜索 Ctrl+P |
| 新建笔记 | 切到结构内联命名 | 列表顶部内联命名 | —— | —— |

**已确认的规则（若采纳 A）**

1. 头部只放对所有视图都成立的动作；只在某个视图成立的动作收进该视图的 ⋯。
2. 点任何按钮都不切视图；不适用的动作在菜单里不出现（B 方案下置灰 + 解释）。
3. 搜索框三视图常驻，语义 = 在当前视图里找东西：
   - 最近 / 主题：就地过滤；
   - 结构：查找并定位（不做树过滤——树是懒加载的，过滤只能覆盖已展开目录，会静默漏结果）。
4. ＋ 菜单只列当前视图能看到的对象：最近 → 新建笔记；主题 → 新建笔记 / 新建主题；结构 → 新建笔记 / 新建目录 / 新建空间。
5. 新建笔记在最近 / 主题里走列表顶部内联命名，回车创建并打开；不切视图。
6. 聚焦统一成「只看当前笔记所在目录 / 空间」筛选（三视图通用），原来的「目录聚焦（骨架化）」保留为设置项，不再占头部按钮位。
7. 大纲态头部保持 ＋ / ⋯ 不变，返回列表放进侧栏内容顶部。
8. 分段计数口径统一：结构栏不显示数字（另两栏是笔记数 / 主题数，与顶层目录数不是一回事）。

**已拍板并落码（2026-11-14，v3.27.0 同版补齐）**：不采用 A 的「⋯ 收纳」与 B 的「置灰」——
用户选择「只在结构成立的动作就只在结构出现」，其余按钮保持原位；搜索框三视图常驻（结构 = 查找并定位）；
新建笔记在列表视图走顶部内联命名。落码与契约见 `docs/ui-updates.md` 同日条目。

**落码影响面**

- `src/modules/knowledge/index.tsx`：头部动作槽、搜索行显隐与占位符、＋ 菜单、新建笔记流程、大纲态头部。
- `src/modules/knowledge/components/NoteFeed.tsx` / `TopicWall.tsx`：列表顶部内联命名行、主题排序。
- 结构查找定位复用现有 `handleLocateInTree`（`VaultTree` 不改）。
- 契约：新增「头部动作不随视图变形 / 结构视图有搜索 / 新建笔记不切视图」断言。
