# 桌面集成实施计划（阶段 1 · 核心通路）

> 状态：**阶段 1 第一批已落码**（2026-10-20）。
> 形态拍板见 `phrontis-desktop-integration/docs/decisions.md`（A+B+C，D/E 不做）；对外契约见该仓库 `docs/interface.md`。
> 本文只记「应用侧怎么实现、改了哪些文件、哪些刻意没做」。

## 1. 三层架构

```
应用内核（本仓库）                     消费者（独立仓库 / 用户自管）
─────────────────────────────         ─────────────────────────────
Core1 D-Bus 接口 + 托盘               GNOME 扩展（A 顶栏 + B 磁贴）
   ↑                                  phrontis-cli（脚本 / rofi / Waybar）
   └── 只读快照 + 轻动作               日历 / 其他桌面（未来）
```

两条硬边界：

1. **写正文不在接口里** —— 接口只有看待办 / 勾待办 / 打卡 / 打开 / 搜索。
2. **消费者不碰 vault 文件** —— 全部经 D-Bus；应用侧写盘仍走 repo 层。

## 2. 本批交付（核心通路）

| 能力 | 落点 |
|---|---|
| 今日快照（待办 + 打卡 + 番茄只读） | `src/lib/daySnapshotPure.ts`（纯函数）+ `electron/lib/desktopBridge/dayService.ts`（读 repo） |
| D-Bus 服务 | `electron/lib/desktopBridge/dbusService.ts` |
| 托盘（**仅应用级动作**：显示 / 退出） | `electron/main/index.ts` |
| 数据变更 → `Changed` 信号 / 托盘刷新 | `electron/main/windowBus.ts` 的 `subscribeDataChanged` |
| 写入口统一 | `electron/lib/todoActions.ts`、`electron/lib/habitActions.ts`（IPC 与 D-Bus 共用） |
| CLI | `scripts/desktop-bridge/phrontis.cjs` + `scripts/desktop-bridge/phrontis-cli`（dev：`scripts/phrontis-cli.sh`） |
| deb 注入 | `build/linux-after-install.sh`（.service + CLI）、`build/linux-after-remove.sh`、`package.json` 的 `extraResources` / `DBusActivatable` |
| 契约 | `.AGENT/scripts/desktop-integration/verify-desktop-bridge.mjs` |

## 3. 接口（实际签名）

总线名：正式 `io.github.lousync.Phrontis`；dev `io.github.lousync.Phrontis.Dev`（可用 `PHRONTIS_BUS_NAME` 覆盖）。
对象路径 `/io/github/lousync/Phrontis`，接口 `io.github.lousync.Phrontis.Core1`。

| 方法 | 签名 | 说明 |
|---|---|---|
| `GetToday` | `() -> (sa(ssbsi)a(ssbii)(iii))` | `(date, todos[(id,text,done,due,quadrant)], habits[(id,name,doneToday,streak,target)], pomo(state,left,total))` |
| `ToggleTodo` | `(s id) -> (b)` | 翻转完成态；完成时补发插件事件 |
| `CheckIn` | `(s habitId, b value) -> (b)` | **幂等**：已是目标状态也返回 true；含远程监督推送 |
| `OpenApp` | `(s target) -> (b)` | `''` / `today` / `pomodoro`；`relPath` 暂不支持（明确返回 false） |
| `Search` | `(s q, i limit) -> (as)` | 返回仓库相对路径，最多 50 |
| `ToggleDayPanel` | `() -> (b)` | 显示 / 隐藏日程小窗（GNOME 扩展的原生快捷键入口；XWayland 全局键不可靠） |
| `GetCapabilities` | `() -> (as)` | `today/todo/checkin/search/open/dayPanel` |
| 信号 `Changed` | `(s scope)` | `today` / `vault`；写后由主进程广播 |

**名称必须用 DO_NOT_QUEUE**：dev 与正式版同名配置会抢总线名，排队会让调用方一直挂着。

## 4. 数据口径

- 待办（**A 口径**，2026-10-20 用户拍板）= **今天到期 + 逾期未完成**；
  **不含**「待安排」计划类、已完成、子任务。实现：`isAgendaTodo`（`src/lib/daySnapshotPure.ts`）
  过滤 `vaultTodosForDate` + `vaultOverdueTodos`，再按 id 去重。
- 排序 = 未完成在前 → `sort_order` → `created_at` → id（与 UI 稳定序一致）。
- 打卡 = 未归档习惯全部；`doneToday` 按当天记录去重；`streak` 复用 `checkinCurrentStreak`（按习惯过滤后）。
- 番茄 = 主进程已有的渲染层快照镜像；`totalSeconds` 由 `left / (1 - progress)` 反推，`progress` 为 0/1 时给 0。
  **阶段 2 让渲染层直接上报精确值**，届时改 `pomoFromSource` 的优先级即可。

## 5. 打包

- `.desktop` 加 `DBusActivatable=true`；`.service` 的 `Exec` 在 afterInstall 里按宏重写成 `/opt/<product>/<executable>`。
- `/usr/bin/phrontis` **仍是 GUI 链接**（默认模板不动）；CLI 装到 `/usr/bin/phrontis-cli`。
  刻意不占用 `phrontis` 这个名字：升级时若把既有 GUI 链接换成 CLI，属于静默破坏。
- `afterRemove` 只在 `remove/purge` 时清理；`upgrade` 直接退出（dpkg 顺序：旧 postrm upgrade → 配置新版）。

## 6. 验收

1. `node --experimental-strip-types --no-warnings .AGENT/scripts/desktop-integration/verify-desktop-bridge.mjs`
2. `npm run dev` 后：
   ```bash
   gdbus call --session --dest io.github.lousync.Phrontis.Dev \
     --object-path /io/github/lousync/Phrontis \
     --method io.github.lousync.Phrontis.Core1.GetToday
   ./scripts/phrontis-cli.sh today
   ```
3. 托盘右键：应出现「今日 N/M 项 · 打卡 X/Y」+ 前 5 条待办/习惯。
4. 打包后 `dpkg -i`：`/usr/bin/phrontis-cli today`、`gdbus` 调用同上（不带 `.Dev`）。
5. `npm run pack` 自带 `app.asar` 自洽校验（dev 进程还在写 `out/` 会产出静默坏包，详见 `scripts/pack.mjs` 的 `verifyPackedAsar`）。

## 7. 刻意没做（下一批）

- `PomodoroControl`：权威状态机在渲染层，需要主进程 → 渲染层的命令通道（先做通道，再开方法）。
- `OpenApp(relPath)`：需要渲染层「按路径开页签」通道。
- GNOME 扩展（A+B）：等接口跑通再动，避免边做边改契约。
- 图标 / 深色跟随：属「桌面融入」backlog，与本接口无关。
