# 看板栅格化 · 磁贴布局引擎移植（实现文档）

> 2026-09-28 拍板。原型 `proto/dashboard-grid-tiles.html`（v7，已过 15 项 headless 探针断言）。
> 交互资产来源：已退役的桌面磁贴模块（`src/modules/desktop/`，文件仍在、仅从模块清单退役），
> 其 `layout.ts` 纯函数与编辑态手感当年已拍板；拖拽硬约束见技能 `css-grid-drag-reorder`。

## 1. 目标形态

看板从「3 列 auto-row 卡片」改为 **6 列 × 固定行高（76px）磁贴栅格**（`grid-auto-flow: row dense`），
每张卡有格子比例（w×h）。默认非编辑态与现状观感连续；编辑态提供：

| 交互 | 规格 |
|---|---|
| 进入/退出 | 顶栏「✏️ 编辑 ↔ ✓ 完成」toggle；旧「编辑卡片」弹层整个删除 |
| 拖拽换位 | 网格内对调语义（swapTiles）；手感 = 抬起 scale(1.05)+大投影 → 其它卡实时让位（transform 预览）→ 松手 FLIP 落位 |
| 拉角改尺寸 | 卡右下 ⌟ 手柄，拖到哪格吸哪格；宽 2-6 列 × 高 1-4 行（行跨度不做自由值） |
| × 隐藏 | 隐藏 = **彻底退出布局**（不渲染不占格），控件进底部托盘 |
| 控件托盘 | 编辑态网格下方横向列表，每项带真实比例缩略预览；**点一下** = 按原布局槽位加回；**拖进网格** = 插入语义（指针在目标中线左/右决定插前/插后，落点卡高亮框） |
| 卡片背景 | 四档选择器收进编辑态顶栏（原弹层顶部那段原样搬家） |

**不进栅格**：hero 问候区、主卡「今天该做的」（保持栅格外全宽常驻，不参与勾选）。

## 2. 数据与设置

| 键 | 语义 | 变化 |
|---|---|---|
| `dashboardCards`（既有） | 显示哪些卡（id 数组） | **语义不变**；插件控件 id 已并入（今日基建） |
| `dashboardTileLayout`（新增，json） | `[{id, w, h}]` 布局序 + 尺寸 | settings.ts 注册（group 看板） |

**归一化规则**（`tileGrid.ts` 纯函数，契约脚本直接装载）：
- 读入时：未知 id 丢弃；注册表/插件清单里有而布局缺的 id **按注册表序追加**（带默认比例）；w/h 夹取 2-6 × 1-4。
- 写出时机：换位提交 / 改尺寸提交 / 加回（插入语义挪位）。
- 坏 JSON / 空 → 回退「注册表序 + 默认比例」。
- 卸载/停用插件的 id：渲染侧按清单过滤即可（layout 与 cards 里的残留无害，插件回来还在原槽位）。

## 3. 比例表（默认值真源 = CARD_REGISTRY 条目加 `w`/`h`）

| 卡 | 默认 | 说明 |
|---|---|---|
| todos 今天该做的 | **2×3**（2026-09-28 二轮拍板：窄高单栏，不做宽横幅） | **常驻磁贴**：强制在场、无 ×、可拖/可改尺寸；数据 = 日程的今日待办 + 逾期未完成（快照上限 3+4 条），不进 dashboardCards 勾选清单 |
| habit 今日打卡 | 2×2 | 正文卡内滚动沿用 |
| usage 今日使用 | 2×1 | 大数字卡 |
| notes 最近编辑 | 2×2 | |
| book 在读的书 | 2×2 | |
| heatmap 使用热力图 | 2×2 | 尺寸与老 3 列卡几乎一致；**格子封顶 16px 居中**（`max-width: weeks*17px`），用户拉大卡出留白不裁切 |
| 插件控件 | manifest 声明 | `contributes.dashboardWidgets[]` 从 `span(1-3)` 升级为 **`w`(2-6) × `h`(1-4)**，缺省 2×2 —— 上午基建未提交未使用，直接改 |

## 4. 落码结构与文件清单

| 文件 | 改动 |
|---|---|
| `src/modules/dashboard/tileGrid.ts`（新） | 纯函数：`parseLayout` / `normalizeLayout` / `clampWH` / `swapIds` / `insertId`。零依赖供契约脚本 import（同 heatmapModel 先例） |
| `src/modules/dashboard/cards.tsx` | CardDef 加 `w`/`h` 默认；CARD_REGISTRY 六条补比例；`Card` 改为吃 style span（列+行）；CardBody 各卡适配固定高度（max-h 内滚动沿用） |
| `src/modules/dashboard/Heatmap.tsx` | 两层网格包 `mx-auto` + `maxWidth: weeks*17`，格子封顶居中 |
| `src/modules/dashboard/index.tsx` | 重写卡片区：栅格渲染 + 编辑态（toggle/背景档位入顶栏/删弹层）+ 托盘 + 拖拽状态机（见 §5）；紧凑档仅压 padding，行高不动 |
| `src/lib/settings.ts` | 注册 `dashboardTileLayout` |
| `electron/lib/pluginRegistry.ts` | dashboardWidgets 校验 span→w/h；`plugin:listDashboardWidgets` 返回 w/h |
| `src/types/index.ts` + preload + ipc | `PluginDashboardWidget.span` → `w`/`h` |
| `docs/plugin-api-v2-reference.md` | §5.2.1 字段表同步 |
| 契约 | `verify-dashboard.mjs`（栅格断言重算）、`verify-dashboard-widgets.mjs`（w/h 断言）、新增 `verify-dashboard-tile-grid.mjs`（tileGrid 纯函数 + 拖拽关键约束的源码断言） |

## 5. 拖拽引擎移植要点（React 化）

原型是原生 JS，落码按桌面磁贴同款模式 React 化（`desktop/index.tsx` 先例）：

1. **状态机 + refs**：`tileDrag` / `trayDrag` 状态放 ref（拖动全程零 setState）；move/up/pointercancel/**blur** 监听挂 window（一个 useEffect 挂一次），收尾只有 `finishDrag()` 一个口。
2. **提交才重排**：拖动中只写 transform（让位预览同原型）；松手 `flushSync(() => setLayout(newLayout))` 后量终态做 FLIP——React 用 key 稳定复用节点，flushSync 后 DOM 已重排。
3. **settling 标记**：FLIP 220ms 内禁止开新拖拽（快照会量到半路位置）。
4. **渲染前清扫**：`sweepInline()` 清全部内联 transform/transition/is-dragging（防残态叠加）。
5. **拖拽元素零入场动画**：`animation-fill-mode: both` 会永久压住内联 transform（v5 教训）；`.tile` 不挂 item-in，入场动效只给栅格容器。
6. **iframe 卡编辑态**：编辑态给插件卡 body 盖 `pointer-events:none` 遮罩（iframe 会吞 pointerdown，拖拽起不来）；非编辑态照常交互。
7. **命中检测**：抬起瞬间量布局快照（相对栅格原点、排除自身），全程按快照判命中——z-index 抬起后 `elementFromPoint` 恒命中自己，不可用。
8. 动效红线：只动 transform/opacity；跟手阶段 `transition:none` 首帧内联；`prefers-reduced-motion` 兜底。

## 6. 已定不做

- 行跨度自由值 / 磁贴 1 列宽卡（可读性差，最小 2 列）
- 多套布局预设（磁贴有、看板不需要）
- 非编辑态任何拖拽/尺寸操作
- 幽灵占位（隐藏卡留空位）——已否决，隐藏即退出布局
