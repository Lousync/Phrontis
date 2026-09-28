# 桌宠（右栏快捷控件）实现报告

> 状态：**已实施 + 已验收（2026-09-28）**；**第二轮布局改版 + 切换宠物已落码**；**第三轮右栏高度分配（不挤占宠物 + 最大化吸收余量）已落码（2026-09-28）**。
> 契约 211 项全绿、tsc 双门禁 0 错、运行期探针 18/18。
> 原型：`outputs/desktop-pet-prototype.html`（v11，数值与状态机以此为准）；布局改版原型 `outputs/desktop-pet-layout-prototype.html`。
> 分工口径：本文档只写「改什么、在哪、取舍」；像素/立绘手法与调试坑见 `2026-09-28` 工作日志。
> 第二轮方案另存 `.claude/plans/pet-layout-toolbar.md`。

## 〇、落地过程中发现并修掉的三个坑（后手必读）

1. **rAF 循环在空态提前退出 → 立绘永远不画**（探针实锤，非契约可断）：渲染循环 effect 依赖 `[]`，
   而首次渲染 `snap` 为 null → 组件走空态、canvas 尚未挂载 → effect 里 `if (!cv) return` 退出且
   **永不再跑**；等 `pet:get` 回来挂上 canvas 时循环已放弃。修法：effect 依赖 `[ready]`（`ready = snap !== null`）。
   探针判据 = canvas 非透明像素数 > 500（截图看气泡在飘、底下却是空的，即此症）。
2. **立绘「假透明」**：ImageGen 产出的 PNG 是 **1024² 无 alpha（colorType 2）**，背景是烤进像素的
   白/浅灰棋盘格；深色面板上就是一块亮方块。且奶白毛同样是「浅+中性」，**不能全图抠色**（会在胸口/爪上打洞）。
   处理手法：副本里把浅中性像素压平纯白 → 从四角 BFS 只吃与外圈连通的那片 → alpha 搬回原图（RGB 不动），
   再 NEAREST ÷4 降采样到 256²（14.5 MB → 1.6 MB）。契约 P12 锁「colorType=6」防拷回未处理版。
3. **Tailwind 类名不存在**：初稿用了 `text-main`/`text-hint`/`bg-accent`/`border-line`/`after:border-5`
   —— 项目没有 @theme 自定义色，这些一律是 no-op（喂食按钮 `bg-accent` = 透明、气泡尾巴缺失）。
   已全部对齐 `var(--text-primary)`/`var(--text-muted)`/`var(--bg-tertiary)`/`var(--accent)` 体系（照 NavWidget/PomoWidget 口径）。

## 一、已拍板结论（原型迭代收敛）

1. **形态**：右栏快捷控件新条目（与番茄钟/网址导航同级），无独立窗口。
2. **品种**：内置小狗 / 小猫两个（史莱姆已否决）；**无蛋**——出生即幼年。
3. **成长**：两阶段 幼年 →（成长值 120）成年；成年切换更成熟立绘 + 跳跃动画。
4. **姿态集**（幼年 / 成年各一套，共 10 张/品种……实为每品种 10 张）：基础坐姿、饥饿讨食、无聊趴下（兼睡觉）、被抚摸、埋头吃饭。
5. **养成机制**：喂食免费（饱食 ≥92 拒绝）、摸头加心情、**时间衰减**（几天不管会蔫但饿不死）、**轻联动**（使用数据 → 活跃度 → 心情衰减变慢 + 成长加速，喂食仍免费）。
6. **插件品种**：品种可由插件经 `contributes.pets` 注册扩充——**二期实施**，一期只做内置品种 + 预留声明结构。

## 二、架构总览

```
渲染层                              主进程
PetWidget.tsx (canvas 状态机)  ←→  petRepo.ts (IPC 注册)
  │  pet:get / feed / pet            │
  │  useDataChanged('pet')           ↓
  └─ assets/pets/*.png          petVaultRepo.ts (pet.json 读写 + 衰减/活跃度结算)
workbenchLayout.ts ('pet' 挂载)        ↓
WorkbenchRightPanel.tsx (META+分支)  .knowbase/modules/pet/pet.json  ← Vault 唯一真相源
```

- **主进程为状态真相源**：衰减/活跃度/成长结算全部在 `petVaultRepo` 内完成（`pet:get` 时按真实流逝时间结算并写回），渲染层只做表现与动画（对齐「Vault = 唯一真相源」不变量）。
- **渲染层不接触绝对路径**：立绘走 Vite 静态 import（`src/assets/pets/`），数据走 IPC。

## 三、文件清单

### 新增

| 文件 | 职责 |
|---|---|
| `electron/lib/kbStore/petVaultRepo.ts` | pet.json 读写（`MOD = 'modules/pet'`）+ 衰减结算 + 活跃度聚合 + 成长结算；导出 `vaultPetGet / vaultPetFeed / vaultPetPetTouch / vaultPetRename / vaultPetReset` |
| `electron/database/repositories/petRepo.ts` | `registerPetHandlers()`：`pet:get / pet:feed / pet:petTouch / pet:rename / pet:reset`，写操作后 `broadcastDataChanged('pet')` |
| `src/components/workbench/widgets/PetWidget.tsx` | 桌宠控件：canvas 状态机渲染（移植原型 v11 逻辑）+ 喂食/摸头/改名按钮 + 状态条 |
| `src/assets/pets/` 下 10 张 PNG | 立绘：`{dog,cat}-{baby,adult}-{base,hungry,lie,pet,eat}.png`（从 `tmp/pet-sprites/` 拷贝重命名） |
| `.AGENT/scripts/workbench-shell/verify-workbench-shell.mjs`（P1–P12 段） | 契约：挂载三处接线 + IPC 五通道三层 + 广播 scope + 数值常量 + 立绘 20 张且带 alpha |
| `.AGENT/scripts/workbench-shell/probes/probe-pet-widget.mjs` | 运行期探针（隔离实例）：切换条点桌宠 → canvas 出像素 → IPC 往返 → 喂食饱食上升 → pet.json 落盘 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/lib/workbenchLayout.ts:39,51` | `WORKBENCH_WIDGET_IDS` 与 `RIGHT_PANEL_WIDGET_IDS` 追加 `'pet'` |
| `src/components/workbench/WorkbenchRightPanel.tsx:102-108,393-397` | `WIDGET_META` 加 `pet: { Icon: Cat, label: '桌宠' }`（lucide `Cat`）；渲染分支加 `{effectiveWidget === 'pet' && <PetWidget />}` |
| `src/lib/dataChanged.ts:14` | `DataChangeScope` 加 `'pet'` |
| `electron/preload/index.ts`（bookmark 区块 ：476 附近） | `petGet/petFeed/petPetTouch/petRename/petReset` 五个 invoke |
| `src/lib/ipc.ts`（:431 附近） | 对应五个薄封装 |
| `src/types/index.ts`（:316 DTO 区 + :1851 api 声明区） | `PetState` 类型 + `window.api` 五个方法声明 |
| `electron/main/index.ts:912 附近` | `registerPetHandlers()` 注册 + import |
| `.AGENT/scripts/workbench-shell/verify-workbench-shell.mjs:311` | E5 断言 `['pomo']` 已落后于现状 `['pomo','nav']`，本次一并改为 `['pomo','nav','pet']` |

## 四、数据结构

### pet.json（`.knowbase/modules/pet/pet.json`）

```jsonc
{
  "version": 1,
  "name": "小狗",          // 用户可改名，≤8 字
  "species": "dog",        // 'dog' | 'cat'
  "stage": 0,              // 0=幼年 1=成年
  "exp": 0,                // 成长值；幼年需 120 升级
  "hunger": 80,            // 0-100，约 36h 耗尽
  "mood": 80,              // 0-100，下限 5
  "ts": 1759041600000      // 上次结算时间戳（衰减基准）
}
```

- 读：`readJson('modules/pet', 'pet.json', DEFAULTS)`；写：`writeJsonOrThrow`（喂食/摸头等用户操作必须落盘成功）。
- **旧原型 localStorage 存档不做迁移**（原型数据为演示产物）。

### 活跃度（实时计算，不落盘）

```
activity = min(1, min(1, 今日使用分钟/240)×0.5 + min(1, 打卡连续/7)×0.25
             + min(1, 今日笔记数/5)×0.15 + min(1, 今日AI互动/10)×0.10)
心情衰减速率 ×(1 − 0.6×activity)；成长获取 ×(1 + 0.5×activity)
```

数据源（全部现成，零新写采集）：
- 使用分钟：`appUsageStore.getUsageTodayMinutes()`（appUsageStore.ts:146）
- 打卡连续：`checkinCurrentStreak(vaultRecordsAll(), today)`（habitStats.ts:210）
- 今日笔记：`getKnowledgeIndex().pages` 按 `updatedAt.startsWith(today)` 计数（对齐 dashboardRepo.ts:159 口径）
- AI 互动：`getAiUsageData().days[today]?.calls ?? 0`（agentUsage.ts:118）

## 五、数值与状态机（自原型 v11 移植）

- 衰减：每小时 `hunger −2.8`；`mood −(1.5 + (hunger<20 ? 1.8 : 0)) × (1 − 0.6×activity)`，下限 5。
- 喂食：饱食 ≥92 → 拒绝（摇头）；否则 饱食 +30、心情 +10、成长 `+round(10×(1+0.5×act))`。
- 摸头：心情 +8、成长 `+round(2×(1+0.5×act))`、爱心粒子。
- 升级：`exp ≥ 120 && stage===0` → stage=1 + 跳跃动画 + 气泡「我长大啦！」。
- **姿态优先级**：被抚/害羞 > 睡觉(夜间 23–7) > 瞬时动画(吃/升级/拒绝) > 按钮强制(调试用，正式版删除) > 饥饿(饱食<25) > 无聊(心情<30) > 常规坐姿。
- 动画：待机呼吸浮动、吃饭咀嚼弹动、爱心/碎屑粒子——全部 transform/opacity，带 `prefers-reduced-motion` 兜底（铁律 13）。

## 六、取舍与不做

- **衰减结算在主进程**（打开控件/操作时按 `ts` 结算），渲染层 1s tick 仅驱动表现，不写盘。
- **成年姿态图已齐**（图生图 8 张），随一期一起进 `src/assets/pets/`。
- **不做**：多窗口悬浮桌宠（已否决决策不碰）、宠物死亡、养成任务系统（重联动已否）。
- **二期**：`contributes.pets` 插件品种（品种包 = manifest + 立绘目录，id 强制 `<pluginId>:<petId>`，宿主渲染，与 dashboardWidgets 同口径）、宠物上看板磁贴。
- **AI 手册**：新功能用户可见，收尾时按规范提醒同步 `resources/help`（涉及模块：右栏工作台）。

## 七、门禁与验收（2026-09-28 实测结果）

1. `npx tsc --noEmit -p tsconfig.node.json` / `-p tsconfig.web.json` —— **双 0 错**。
2. 契约 `node .AGENT/scripts/workbench-shell/verify-workbench-shell.mjs` —— **211 项全绿**（含 P1–P12）。
3. 运行期探针（隔离实例，跑 `out/` 产物）：
   ```
   npm run build
   node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"
   node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs .AGENT/scripts/workbench-shell/probes/probe-pet-widget.mjs
   ```
   —— **10/10 PASS**：图标出现 → canvas 出立绘像素 → pet:get/reset 往返 → 喂食饱食+心情+成长上升 → pet.json 落盘且与 IPC 回传一致；截图 `tmp/probe-pet-widget.png`。
4. 修改涉及渲染层 + 主进程（新增 repo/handler）→ **主进程需重启 dev**（用户实例验收时）。
5. **尚未机器验证**（需真机长时观察，探针覆盖不到）：跨天/重启后的衰减与等级保留；夜间 23–7 自动入睡；摸头爱心粒子；改名持久化（IPC 通道已在，但 UI 改名路径未进探针）。
6. **`pet:reset` 入口**：第二轮已补上（⋯ 菜单 →「重新养一只」），见 §八。

## 八、第二轮：布局改版 + 切换宠物（2026-09-28）

**需求**：控件内容整体贴底；顶部腾出的空位放互动按钮 + ⋯ 菜单入口；菜单可切换宠物（狗⇄猫）。

**布局**（`PetWidget.tsx`）：三段 —— 顶部工具条（✋ 摸摸头 / 🍎 喂食 / ⋯）→ 中部留白（气泡浮出）→ 底部组贴底（立绘 → 名字+阶段+成长 → 三条状态条）。
- 根节点 `flex h-full w-full flex-col`；中部 `flex-1` 吃掉剩余高度把底部组压下；**右栏槽位须给 `h-full`**（`WorkbenchRightPanel` 里 pet 走 `h-full w-full` 分支），否则根节点 `h-full` 无高度可依、贴底失效。
- 气泡锚定立绘容器顶边（`bottom-full mb-1`），落在中部留白里、不压立绘（探针 P-P16 锁 ±10px）。
- 菜单走 `useAnchoredMenu` + portal（对齐右栏既有 ⋯ 菜单手法）。

**切换宠物 = 换皮肤不丢进度**（用户拍板）：新增 `pet:switchSpecies` 通道，只改 `species` 与显示名，`stage/exp/hunger/mood` 一位不动。契约 P14 用**负向断言**锁住「函数体不出现 `defaults()`/`exp=`/`hunger=`/`stage=`/`mood=`」。

**名字跟着宠物走**（用户拍板）：数据加 `names: { dog, cat }` 表，每品种各记一个名字；`name` = `names[species]`（冗余存一份便于渲染层直读）。旧档（只有单个 `name`）在 `readRaw` 里一次性迁移：归到当前品种，另一品种给默认名。「重新养一只」只重置当前品种的名字与数值，另一只不动。

**新增/改动文件**：`petVaultRepo.ts`（`names` + `vaultPetSwitchSpecies`）、`petRepo.ts`（`pet:switchSpecies`）、`preload` / `ipc.ts` / `types`（三层接线）、`PetWidget.tsx`（重排 + 菜单）、`WorkbenchRightPanel.tsx`（pet 槽位 `h-full`）；契约 P13–P19、探针 P-P4b/P-P4c/P-P11…P-P16。

**待补**：AI 手册（`resources/help`，右栏工作台篇章需补「切换宠物 / 重新养一只」）。

## 九、第三轮：高度分配（不挤占宠物 + 最大化吸收余量，2026-09-28）

**两个方向的问题（都实测过）**：
1. 桌宠控件撑满右栏下段（`flex-1`），而立绘固定 192、内容贴底 → 富余高度全变成上方一整块留白。
   本机默认窗口舞台 794px 时留白 448px（56%），窗口拉高到 1064px 时留白 718px（68%）——最大化后尤其难看。
2. 反方向：矮窗口下「最近编辑」按内容固定高（6 行 ≈ 200px），宠物只能捡剩下的 → 被挤到 248px、
   **三条状态条被裁出滚动条**（截图实锤）。

**用户口径**：**任何情况下都不许挤占宠物**（宠物不是让位方）；最大化多出来的高度才让中段「最近编辑」吸收。

**做法**：`WorkbenchRightPanel` 新增 `absorbSurplus`（App 按 `winMax` 下发，策略留在 App，面板不耦合窗口状态；E6g）：
- **下段保底 `min-h-[400px]`** —— 矮窗口下宠物仍有完整高度，不再被「最近编辑」挤（本轮核心修复）。
- `absorbSurplus=false`（未最大化）→ 下段 `flex-1` 吃满；最近编辑 `shrink max-h-[212px] min-h-[36px]`（空间不够就收缩，列表内滚），条目 6 条。
- `absorbSurplus=true`（最大化）→ 下段 `grow-[99] basis-0 max-h-[480px]`（**增长优先级高、先吃饱再封顶**），最近编辑 `grow basis-0 min-h-[64px]` + 列表 `min-h-0 flex-1` + 条目 6→20。
  「grow 优先级」是这套的关键：等下段撞到 `max-h` 被冻结后，余量才重分配给最近编辑；若两者等权（都 `flex-1`），短窗下宠物会被挤掉一半（实测 384→249px，已修）。

**实测**（探针 `tmp/probe-pet-size.mjs`，真最大化 + 视口模拟；截图 `tmp/pet-size-unmax.png` 已确认状态条完整）：

| 视口 | 宠物控件 | 宠物留白 | 最近编辑 |
|---|---|---|---|
| 820（未最大化） | 345 | 0 | 103（6 条，列表内滚） |
| 912（真最大化） | 425 | 79（19%） | 129（15 条） |
| 1230（最大化） | **425** | **79（19%）** | 447（15 条） |
| 1500（最大化） | **425** | 79 | 717 |
| 1600（最大化） | **425** | 79 | 817 |

→ 未最大化：宠物从 248（被裁）抬到 **345 且状态条完整**，「最近编辑」让位到 103（列表内滚）——这是「不挤占宠物」的必然代价。
最大化：宠物恒定封顶 425px（不再随窗口变高），余量全给「最近编辑」。

**契约**：E1c（最近编辑默认可收缩 + absorbSurplus 转增长项）、E1e（条目 6→20 + 列表常驻 `flex-1`）、E6f（下段 `min-h-400` 保底 + absorbSurplus 封顶 max-h-480）、E6g（App 下发 `absorbSurplus={winMax}`）；E6c（右栏不依赖 `maximized`）借改名继续成立。

**顺带修**：`ResizablePanel` / `QuizDataPanel` 的 `transition` 简写与 `transitionDelay` 长写混用（React 重渲染告警，简写会重置长写）——延迟并入简写，关闭右栏时不再报错。

**取舍**：极高显示器上「最近编辑」会被拉得很高（余量全给它），条目上限 20 缓解；若嫌过高，可给最近编辑也加 `max-h`（余量转去面板底部留白）。
