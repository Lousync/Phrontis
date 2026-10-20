# 桌面集成 · 决策与交接（2026-10-20）

> **用途**：上下文压缩 / 换会话后先看这一份。机制与验收细节见
> `docs/desktop-integration-plan.md`；对外接口契约见独立仓库
> `phrontis-desktop-integration/docs/interface.md`。

## 1. 本轮拍板（用户口径，按原话记录）

| # | 事项 | 用户决定 | 状态 |
|---|---|---|---|
| 1 | 番茄钟控制 `PomodoroControl` | **暂不做** —— 性价比不高、优先级低 | 不做 |
| 2 | `OpenApp(relPath)` | **暂不做** —— 只想要顶栏联动，外部搜索/按路径打开不需要 | 不做 |
| 3 | 任务栏模式（top-dock / desktop-widget） | **直接删除干净**，只保留自由漂浮；顶栏联动是唯一方向 | **待做**（清单见 §3.1） |
| 4 | 设置搜索 `aiTools.llmUsage` 无落点 | **顺手修** | **待做**（§3.2） |
| 5 | 坏产物 `packs/3.9.2-4` | **删除**；只删这一个，别删错 | **待做**（§3.3） |
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

- 主仓分支 `feature/v3.9.2-linux`，最新 `8d27f15e`（含 D-Bus Core1、托盘、原生快捷键、
  登记表去重、A 口径）。工作区干净。
- 集成仓 `phrontis-desktop-integration`，最新 `dc5ecee`（扩展 A+B、原生快捷键、面板交互）。
- 已验证：`GetToday` / `ToggleDayPanel` 经 D-Bus 可用；扩展 `ACTIVE`；`[Tray] Tray created`；
  `[vault-registry] 清理同 id 重复行：2 → 1`。
- **未验证**：扩展的「面板不关闭 + 动效」是 ESM 模块，`disable/enable` 不重载代码，
  必须**注销重登**后才生效。

## 3. 待做清单

### 3.1 删除任务栏模式（用户拍板）

目标：只保留 **floating（自由漂浮）**；删除 top-dock（顶部停靠）与 desktop-widget（桌面小组件）
的全部代码与入口。保留「脱离 / 吸附回右栏」的小窗基本能力。

改动面（按文件）：

- `electron/main/dayPanelWindow.ts`
  - `PanelMode` / `MODES` / `mode` / `explicitMode` 收成单一 floating（可直接删类型）
  - 删 `getPanelMode` / `setPanelMode` / `onPanelModeChanged` / `dayPanelModeChanged` 广播
  - 删 `computeTargetPos` 的 top-dock / desktop-widget 分支；`applyMode` 的分支
  - 删 top-dock 展开/收缩动画、`EXPAND_MS`、`collapsed`、触碰条、`dayPanelTopdock*`
  - 删 desktop-widget 的 `widgetInteractive`、穿透切换、固定尺寸逻辑
  - 删 `onPopoutMoved` 里的「贴顶自动停靠」判定（`DOCK_JUDGE_MS` / `POPOUT_GRACE_MS` 视引用清理）
  - 键盘：删 `Control+Alt+Up` / `Control+Alt+Down`（保留 `Control+Alt+S`）
  - IPC：删 `daypanel:mode-set`、`daypanel:mode-get`、`daypanel:topdock-*`、`daypanel:widget-interactive`
- `electron/preload/index.ts`
  - 删 `dayPanelSetMode` / `dayPanelTopdockExpand` / `dayPanelTopdockCollapseIntent` /
    `dayPanelTopdockCancelCollapse` / `dayPanelWidgetInteractive`
  - `dayPanelGetState` / `onDayPanelStateChanged` 的返回结构收成 `{ detached }`
- `src/types/index.ts`
  - 同步删上述 API 与 `mode/collapsed/widgetInteractive` 字段
- `src/daypanel/DayPanel.tsx`、`src/daypanel/DayPanelWindowApp.tsx`
  - 删 `panelMode` / `collapsed` / `widgetInteractive` props 与 top-dock / widget 分支、
    按钮（「划过激活 / 可操作」等）与相关事件
- 契约 / 文档
  - `grep -rn "top-dock\|desktop-widget\|widgetInteractive\|dayPanelSetMode" src electron .AGENT`
    清零（历史文档里的说明除外）
  - 跑相关契约 + 双份 `tsc`
  - `docs/desktop-integration-plan.md` / `docs/linux-port-plan.md` 补一条变更记录

> 风险：`dayPanelWindow.ts` 里模式逻辑与尺寸/显示耦合，删完必须真机验证
> 「脱离 → 小窗可拖动/可关闭 → 吸附回右栏」仍正常。

### 3.2 修设置搜索落点（一行）

- `src/modules/settings/views/AiUsageTab.tsx` 的「打开用量看板」按钮加
  `data-setting-anchor="aiTools.llmUsage"`
- 验收：`node .AGENT/scripts/settings/verify-ai-tab-anchors.mjs`（应全绿；这是存量 1 FAIL）

### 3.3 删除坏产物

- 只删 `packs/3.9.2-4`（该次 `app.asar` 文件表错位，装上会退化成 Electron 默认页）
- 删除前用 `scripts/pack.mjs` 的 `verifyPackedAsar` 确认它失败（坏包）再删
- **不要动** `packs/3.9.2-5`（已验证的好包）与其它历史目录

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
