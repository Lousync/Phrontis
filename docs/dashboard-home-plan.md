# 看板首页（今日纸）实现方案

> 状态：**已实施（2026-11-14，v3.29.0）**
> 原型：`tmp/home-view-proto/index.html#e`（方案 E · 今日纸）
> 契约：`.AGENT/scripts/dashboard/verify-dashboard.mjs`（84 项）

## 1. 目标（已达成）

把「看板」从**工作台里的一个书签页**提升为**应用首屏与顶层视图**，并重做为「今天这一页」：

1. 看板 = 顶层；工作台 / AI 教学 = 它的两个平级容器。
2. 首屏 = 一句话结论 + 左月历 / 右今天时间线 + 打卡 + 近一年热力图，右列是两个模块窗口。
3. 回看板**没有任何「返回」按钮** —— 只走图标条最上面那枚「看板」。

### 不做

- 手机端适配（独立仓库）。
- 看板内拖拽 / 编辑布局（磁贴编辑态整体退役，见 §6）。
- 翻月（v1 只显示当月）。

## 2. 结构变动（已落码）

### 2.1 图标条 = 顶层导航

```
看板 | 工作台 | AI 教学
──────────────────────
回收站 插件 动态 书市 用量
```

- 三枚**固定**：不参与 `railOrder` 拖拽、不进 `railHidden` 右键显隐。
- 高亮：`activeTab === 'dashboard'` → 看板；`activeTab` 为空或非整窗模块 → 工作台；`activeTab === 'aiTeaching'` → AI 教学。
- 落点：`src/components/shared/ActivityBar.tsx`（新增固定顶组 + `onBoard`）、`src/lib/appModules.ts`（`RAIL_MODULE_IDS` 去掉 `aiTeaching`，新增 `RAIL_PINNED_IDS`）、`src/lib/settings.ts`（`railOrder` 默认值同步）。

### 2.2 看板不再挂在工作台里

- `WORKBENCH_BOOKMARKS` 删除 `dashboard`；`RailModule` / `BOOKMARK_COLORS` / `BOOKMARK_ICONS` 同步删除。
- `src/App.tsx`：`case 'dashboard'` 去掉 `onBack`，改传 `openTabs / lastTab / onOpenTab / onOpenWorkbench`。
- 工作台空态没有「回看板」按钮（本来就没有，保持）。

### 2.3 启动落看板

启动时仍恢复 `lastOpenTabs`（工作台窗口要列它们），但不再把 `lastActiveTab` 当可见标签 —— 统一 `setActiveTab('dashboard')`。

## 3. 数据层（已落码）

`src/types/index.ts` + `electron/database/repositories/dashboardRepo.ts` 两侧同步：

```ts
calendar: { month: string; days: Record<string, { total: number; done: number }> }
course: null | {
  wsId: string; wsName: string
  chapterTitle: string; unitTitle: string; unitGoal: string
  pct: number                     // 已收尾知识点 / 总数
  chapterIndex: number; chapterCount: number
}
todos: { today: Array<{ id; title; time; done }>; doneToday; totalToday }  // 含已完成
```

- **calendar**：`vaultMonthTodos(YYYY-MM)` 后按 `date.slice(0,7)` 过滤，只留计数。
- **course**：`listWorkspaces(getSetting).lastWorkspaceId` → `getCourseState()` → 大纲里第一个未收尾知识点；全收尾则停在最后一个。`registerDashboardHandlers` 因此改为注入 `getSettingValue`。
- **usage**：`DASHBOARD_LIMITS.heatmapDays` 183 → **364**。
- 跨天逾期不再进首页（`vaultOverdueTodos` 从聚合里移除）—— 时间线是「今天」，逾期去日程看。

## 4. 渲染层（已落码）

| 文件 | 说明 |
|---|---|
| `src/modules/dashboard/index.tsx` | 容器：快照 / 每分钟「现在」/ 称呼行内编辑 / 版式骨架 |
| `src/modules/dashboard/summary.ts` | 纯函数：结论句、时间线排序与「现在」插入点、月历 42 格、热力图区间、日期文案 |
| `src/modules/dashboard/MonthCalendar.tsx` | 月历：今天填色、有安排打点、点日期进日程 |
| `src/modules/dashboard/DayTimeline.tsx` | 时间线：按时排、逾期红、完成划线、插「现在」 |
| `src/modules/dashboard/UsageHeatmap.tsx` | 52 周热力图：月份刻度、格子随宽度、右对齐裁最早周 |
| `src/modules/dashboard/ModuleWindow.tsx` | AI 教学窗口 / 工作台窗口 / 在读 |
| `src/modules/dashboard/heatmapModel.ts` | 保留（纯计算层，契约直跑） |

版面细节（都按原型 e 定稿）：

- 内容最大宽 1800（≥2000 视口 2000，字号整体放大一档）。
- 纸内左月历 200–300，右侧「今天」；时间线行宽上限 760（容器 ≥950 时 820、≥1080 时 900）。
- 打卡：容器 <620 在时间轴下方一行，≥620 转成右列 176（≥1080 时 210）。
- 热力图：`minmax(7px, 1fr)`，内层最小宽 `weeks*7 + gap`，右对齐 + `overflow-hidden`。
- 刻度：只在月份变化列落标签；首列不完整月跳过；最后一个月右对齐（只剩 1 列也不被裁）。
- 矮窗（视口 <940）收一档：热力图 150、标题 26、行距压缩。

## 5. 交互

| 操作 | 结果 |
|---|---|
| 图标条「看板」 | `activeTab='dashboard'`，左右栏与页面条退场 |
| 「工作台」/「打开工作台」 | 落上次工作台标签（仍在 openTabs 时），否则空态 |
| 工作台窗口某一行 | 直接激活该模块标签 |
| 点月历任意日期 / 时间线任意行 / 「打开日程 →」 | 进日程模块 |
| 打卡胶囊 | 写 `habit:toggleCheck` + 广播 `habit`（勾上时炸彩纸） |
| AI 教学窗口「继续这一段」 | 进 AI 教学模块 |

## 6. 三个取舍（已按最保守选项落地）

1. **磁贴看板整体退役**：`cards.tsx` / `tileGrid.ts` / 旧 `Heatmap.tsx` 删除；`dashboardCards` / `dashboardBg` / `dashboardTileLayout` 三个设置键**保留但不再读取**（回滚旧版时数据还在）。
2. **插件看板控件**：看板不再渲染 `PluginFrame`；插件的声明面（manifest / 注册表 / `pluginListDashboardWidgets`）原样保留，只是没有消费方，未来可以放进工作台窗口。
3. **月历 v1 只显示当月**：没有翻月箭头；翻月需要「按月取数」的新 IPC，留到 P1。

## 7. 契约与验收

- `npx tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json`
- `.AGENT/scripts/dashboard/verify-dashboard.mjs`（重写，84 项）：
  - 热力图分档 / 区间 52 列 / 跨年同月份号不合并；
  - 结论句三种文案；时间线排序、逾期、「现在」插入点；
  - 月历 42 格、周一起排、闰年；
  - 快照字段与主进程聚合（calendar / course / 364 天 / 逐块 try）；
  - 结构接线（三枚固定 / 启动落看板 / 书签撤出 / 无 onBack）；
  - 版面与动效（760 上限、容器查询、既有动效令牌）。
- `.AGENT/scripts/workbench-shell/verify-workbench-shell.mjs`：书签 10 项、图标条 5 项 + 顶部三枚。
- `.AGENT/scripts/startup-tab/verify-startup-tab.mjs`：图标条成员快照同步。
- 真机：1280×820 / 963、1440×900、1920×1080、2560×1440 无滚动；1000×700（<1080 右列落下方）页面滚动、主列 520 保底。

## 8. 收尾待办

- **AI 手册必须同步**：`resources/help/*.md` 里讲「看板 / 图标条 / 启动落点 / 怎么回看板 / 磁贴编辑」的段落已过时，按 `.AGENT/help-rewrite/README.md` 重编，并跑 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs`。
- P1 可选：翻月、热力图 hover 明细已在（保留 tooltip）、在读书继续阅读、空态文案。
