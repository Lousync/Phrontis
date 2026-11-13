# 番茄钟升级实现方案（主题必填 · 结束后自动记录 · 评分 · 统计）

> 状态：2026-11-13 方案定稿，开始落码。
> 入口沿用现状：右栏工具箱「番茄钟」→ 中间内容区全屏面板；运行态由状态栏 / 右栏小控件回看。
> 可交互原型：`tmp/pomodoro-upgrade-proto/index.html`（仅本地，不入 git）。

## 1. 需求口径

1. **开始专注前必须填写主题**（≤30 字），用于统计「注意力花在哪里」。
2. 专注**自然完成**或**提前结束**都自动记一场；不足 1 分钟不记。
3. 每场结束后可打 **1–5 星**，可选最多 3 个状态标签；可跳过，之后在统计里补评。
4. 面板内提供统计：今日 / 本周 / 本月；时长、场次、完成率、平均分、趋势、主题分布、最近记录。
5. 旧记录（只有 `{ id, minutes, date, created_at }`）继续计入时长与场次，但不冒充有主题的数据。

## 2. 数据模型

落盘位置不变：`.knowbase/modules/pomodoro/sessions.json`。

```ts
interface PomoSessionRow {
  id: string
  minutes: number              // 实际分钟（保留，兼容看板热力图 / AI 工具 / 周月总结）
  date: string                 // 结束日 YYYY-MM-DD（本地）
  created_at?: string
  topic?: string               // 新字段；旧记录缺省
  planned_minutes?: number     // 计划专注分钟
  actual_seconds?: number      // 实际专注秒数（暂停不计）
  completed?: boolean          // true=自然完成；false=提前结束；旧记录缺省按 true
  started_at?: string
  ended_at?: string
  rating?: number | null       // 1–5；null=未评
  tags?: string[]              // 最多 3 个
  updated_at?: string          // 评分更新时间
}
```

兼容策略：

- `minutes` 永远是实际分钟，所有旧消费方（dashboard / builtin tool / periodStats）不改也能用。
- 旧行缺 `topic` / `completed` / `rating`：读取时归一化为「无主题 / 自然完成 / 未评分」，**不批量改写旧文件**。
- 统计里旧记录计入总时长与场次；主题分布只统计有主题的记录，并显示「另有 N 场旧记录无主题」。
- 新记录 `date` 按 `ended_at` 的本地日期落，避免跨零点记到前一天。

## 3. IPC 与数据变更

| 通道 | 入参 | 返回 |
|---|---|---|
| `pomodoro:createSession` | `PomodoroSessionInput`（兼容旧的 number 分钟） | `PomodoroSession \| null` |
| `pomodoro:updateSession` | `{ id, rating?, tags? }` | `PomodoroSession \| null` |
| `pomodoro:listSessions` | 无 | `PomodoroSession[]` |

- 主进程写盘后 `broadcastDataChanged('pomodoro')`（铁律 1）。
- `DataChangeScope` 增加 `'pomodoro'`；看板、分享卡、统计面板、右栏控件订阅后即时刷新。
- `pomodoro:createSession` 保留 number 入参兜底，避免旧调用 / 插件路径静默失效。

## 4. 状态机

`usePomodoroState` 保持现有字段（`visible / expanded / presetIdx / phase / seconds / running / done`），新增：

- `topic` / `lastTopic` / `recentTopics`
- `startedAt`（首次开始时间，重置时清空）
- `pendingSession`（已落盘、待评分的场次）
- `finishing`（落盘中的短态，防重复提交）

派生 `mode`：

`idle | running | paused | rating | breakReady | breakRunning | breakDone`

关键行为：

- `startTimer(topicOverride?)`：工作阶段必须拿到非空主题，否则返回 `false`（UI 提示并聚焦输入框）；暂停后继续不重置。
- 自然归零：置 `done`，effect 落库一次；成功后进入 `rating`。
- `finishWork(false)`：提前结束；实际秒数 <60 直接回准备态并提示「不足 1 分钟，未记录」。
- `saveRating` / `skipRating`：评分写入后进入 `breakReady`；跳过评分也进入休息。
- `resetTimer`：明确「放弃本场」，不落库（只用于准备态 / 重置按钮，不在运行态提供）。
- `startNextRound`：休息结束后沿用当前主题直接开下一轮。
- 面板折叠 / 切换标签页只收起界面，计时继续；运行态由状态栏和右栏控件兜底。

## 5. UI

### 5.1 番茄钟面板（`PomodoroPanel`）

- 头部：返回、标题、当前状态副标题、`计时 / 统计` 切换。
- 准备：主题输入（必填、字数、最近主题 chips）、圆环、预设、开始、今日摘要。
- 运行：状态胶囊、主题、圆环、暂停/继续、结束（行内二次确认）。
- 评分：场次信息、5 星、状态标签（最多 3）、保存 / 跳过。
- 休息：建议休息、圆环、开始休息 / 跳过 / 下一轮。
- 统计：区间切换、洞察条、4 个指标、趋势（本周堆叠柱 / 本月热力 / 今日 24 小时）、专注质量、主题分布（前 5）、最近记录（行内补评分）。

动效只使用既有工具类：`.kb-view-in` / `.kb-view-fade` / `.kb-item-in` / `.kb-chevron`，不新增过渡。

### 5.2 右栏小控件（`PomoWidget`）

- 准备态增加一行主题输入（预填上次主题），开始前必须非空。
- 运行态显示主题；主按钮暂停/继续，次按钮「结束」（两次点击确认，结束后进入待评分）。
- 待评分态主按钮「去评分」展开面板；休息态主按钮开始/跳过/下一轮。

### 5.3 状态栏（`WorkbenchStatusBar`）

- 由「visible 就显示」改为「有活动场次才显示」：运行/暂停、待评分、休息。
- 待评分显示「待评分」，点击展开面板。

## 6. 受影响文件

**主进程 / 核心**

- `phrontis-core/src/kbStore/pomoVaultRepo.ts`：扩展行结构、创建、评分更新、兼容 number。
- `electron/database/repositories/summaryRepo.ts`：三个 IPC + 广播。
- `electron/lib/builtinTools.ts`：`builtin.pomodoro.summary` 结果补主题 / 评分摘要（schema 不膨胀）。
- `electron/database/repositories/dashboardRepo.ts`：无需改口径（`minutes` 不变）；补订阅侧即可。

**渲染层**

- `src/types/index.ts`：`PomodoroSession` / 入参 / ElectronAPI 方法。
- `electron/preload/index.ts`：桥接三个方法。
- `src/lib/ipc.ts`：三个封装 + 类型。
- `src/lib/dataChanged.ts`：`'pomodoro'` scope。
- `src/modules/toolbox/hooks/usePomodoroState.ts`：状态机。
- `src/modules/toolbox/hooks/PomodoroContext.tsx`：被动占位值同步新字段。
- `src/modules/toolbox/pomodoroStats.ts`（新）：纯统计函数 + 主题色。
- `src/modules/toolbox/components/PomodoroPanel.tsx`：面板重写。
- `src/components/workbench/widgets/PomoWidget.tsx`：控件改造。
- `src/components/shared/WorkbenchStatusBar.tsx`：状态条件与文案。
- `src/modules/dashboard/index.tsx`、`src/components/share-card/useShareCardData.ts`：订阅 `pomodoro`。
- `src/App.tsx`、`src/modules/toolbox/index.tsx`：激活事件不再强制重置预设（去掉 `preset: 0`）。
- `resources/help/番茄钟.md`：用户可见行为说明同步更新。

## 7. 验证

1. `npx tsc --noEmit -p tsconfig.web.json`
2. `npx tsc --noEmit -p tsconfig.node.json`
3. `node --experimental-strip-types --no-warnings .AGENT/scripts/pomodoro/verify-pomodoro-stats.mts`
4. 手工 / CDP 路径：空主题不能开始 → 开始 → 暂停继续 → 提前结束 → 评分 → 休息 → 统计补评分；旧数据兼容；主题超过 5 个只显示前 5；右栏控件与状态栏同步。
5. `npm run build` 通过。
