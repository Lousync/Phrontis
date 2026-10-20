# 桌面集成 · 决策与交接（2026-10-20）

> **用途**：上下文压缩 / 换会话后先看这一份。机制与验收细节见
> `docs/desktop-integration-plan.md`；对外接口契约见独立仓库
> `phrontis-desktop-integration/docs/interface.md`。

## 1. 本轮拍板（用户口径，按原话记录）

| # | 事项 | 用户决定 | 状态 |
|---|---|---|---|
| 1 | 番茄钟控制 `PomodoroControl` | **暂不做** —— 性价比不高、优先级低 | 不做 |
| 2 | `OpenApp(relPath)` | **暂不做** —— 只想要顶栏联动，外部搜索/按路径打开不需要 | 不做 |
| 3 | 任务栏模式（top-dock / desktop-widget） | **直接删除干净**，只保留自由漂浮；顶栏联动是唯一方向 | **已完成**（§3.1） |
| 4 | 设置搜索 `aiTools.llmUsage` 无落点 | **顺手修** | **已完成**（`c21f5a5e`） |
| 5 | 坏产物 `packs/3.9.2-4` | **删除**；只删这一个，别删错 | **已完成**（`3.9.2-5` 保留） |
| 6 | 面板待办口径 | **保持 A**：今天到期 + 非计划类逾期；不含待安排 / 已完成 | **已完成** |
| 7 | 托盘 | 图标保留（运行指示）；菜单只留「显示主窗口 / 退出」 | **已完成** |
| 8 | 面板交互 | 勾选/打卡**不关闭面板** + 勾选动效 | **已落码，待重登验证** |
| 9 | 发布 / 更新手册 / 版本号 | **当前不是优先项**，暂缓 | 搁置 |

### 关于第 2 项的澄清（用户问过）

`OpenApp(relPath)` **不是应用内搜索**（应用内搜索已经正常）。它指的是：
让**外部消费者**（GNOME 顶栏面板里的 Search 结果、`phrontis-cli`、未来的通知/提醒）
点名打开某个仓库文档。与「GNOME 活动搜索 / 系统搜索」也不是一回事（那是更大的独立项）。
既然只要顶栏联动，这项暂不做。

## 2. 当前状态

- 主仓分支 `feature/v3.9.2-linux`，工作区干净；本轮提交见 `git log -3`
  （`c21f5a5e` 锚点 + 交接单，以及「删除任务栏模式」的收尾提交）。
- 集成仓 `phrontis-desktop-integration`，最新 `dc5ecee`（扩展 A+B、原生快捷键、面板交互）。
- 已验证：`GetToday` / `ToggleDayPanel` 经 D-Bus 可用；扩展 `ACTIVE`；`[Tray] Tray created`；
  `[vault-registry] 清理同 id 重复行：2 → 1`；小窗脱离 / 吸附（dev bridge 实测：开窗落右下角
  `1596,536`、吸附后重开位置保持、无 (0,0) 残留）。
- **未验证**：扩展的「面板不关闭 + 动效」是 ESM 模块，`disable/enable` 不重载代码，
  必须**注销重登**后才生效。

## 3. 待做清单

### 3.1 删除任务栏模式 —— 已完成（2026-10-20）

只保留 **floating（自由漂浮）**。已删除：

- 主进程 `electron/main/dayPanelWindow.ts`：`PanelMode` / `MODES` / `setPanelMode` / `getPanelMode` /
  `onPanelModeChanged`、top-dock 的收缩/展开与高度动画、desktop-widget 的穿透与固定尺寸、
  拖拽贴顶吸附、`Control+Alt+Up/Down`、`daypanel:mode-set|get`、`daypanel:topdock-*`、
  `daypanel:widget-interactive`、`daypanel:get-state`
- `electron/preload/index.ts` / `src/types/index.ts`：对应 API 与 state 字段；
  `onDayPanelStateChanged` 载荷收成 `{ detached }`
- `src/daypanel/DayPanel.tsx`：`panelMode / collapsed / widgetInteractive` props、触碰条、
  桌面小组件视图、hover 激活逻辑
- `src/daypanel/DayPanelWindowApp.tsx`：不再订阅形态（固定漂浮）
- 保留：脱离 / 吸附回右栏（`dayPanelPopout` / `dayPanelDockBack`）、内容高度自适应、位置落盘

契约同步：
- `verify-workbench-shell` 258 项全绿
- `verify-habit-link-removal`：打卡刷新通道断言改挂 `HabitWidget`；打卡写入断言改指
  `electron/lib/habitActions.ts`（IPC 与 D-Bus 共用的唯一实现）
- `verify-linux-port`：托盘宿主断言接受「1.2s × 3 重试」写法；`extraResources` 期望值 5 → 6
  （新增 `scripts/desktop-bridge`）

> 仍需真机验证：脱离 → 小窗可拖动/可关闭 → 吸附回右栏。

### 3.2 修设置搜索落点 —— 已完成（`c21f5a5e`）

- `src/modules/settings/views/AiUsageTab.tsx` 的「打开用量看板」按钮已加
  `data-setting-anchor="aiTools.llmUsage"`
- `verify-ai-tab-anchors`：96 PASS / 0 FAIL

### 3.3 删除坏产物 —— 已完成

- 删除前用 `verifyPackedAsar` 确认 `packs/3.9.2-4` 失败（坏包），已删除
- `packs/3.9.2-5`（验证通过的好包）保留

### 3.4 重登验收（只有用户能做）

- 注销 → 重新登录
- 验证：面板勾选/打卡后**不关闭**；图标放大回弹；顶栏读数即时变化；
  `Ctrl+Alt+S` 开关日程小窗；快速设置磁贴正常

## 4. 常用命令

```bash
# 主仓契约
node --experimental-strip-types --no-warnings .AGENT/scripts/desktop-integration/verify-desktop-bridge.mjs
node --experimental-strip-types --no-warnings .AGENT/scripts/vault-identity/verify-vault-identity.mjs
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json

# 扩展（改完必须重登）
cd /home/lousync/Projects/phrontis-desktop-integration
./gnome-extension/install.sh

# 日程小窗 / D-Bus 手测
gdbus call --session --dest io.github.lousync.Phrontis.Dev \
  --object-path /io/github/lousync/Phrontis \
  --method io.github.lousync.Phrontis.Core1.ToggleDayPanel

# dev bridge
curl -s http://127.0.0.1:7465/state
```
