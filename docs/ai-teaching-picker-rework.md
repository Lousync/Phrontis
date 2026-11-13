# AI 教学 · 工作区选择页改版（方案 E · 主从预览）

> 状态：**已实施**（3.26.0，2026-11-13；契约脚本 `.AGENT/scripts/ai-teaching/verify-picker.mjs` 28/28 通过）
> 原型（只做讨论用，不进版本库）：`tmp/ai-teaching-picker-proto/index.html`
> 目标版本：**3.26.0**（一次 UI 改版，按 minor 抬）

## 1. 目标与范围

**做**

- 选择页从「等大卡片两列平铺」改为「左侧课程清单 + 右侧预览」的主从布局
- 整页铺满窗口，不出现窗口级滚动条；列表与预览各自内部滚动
- 左右两块严格等高；列表多时只有列表滚动
- 新建 / 改名 / 删除全部行内化（去中央模态）
- 预览显示：统计、课程进度、最近对话、目录路径，底部固定操作条

**不做**

- 不改工作区内部（对话 / 课程进度 / 右栏）的任何界面
- 不做手动排序、不做虚拟列表
- 最近对话只做只读预览，**不直接跳到某条会话**（避免与「进入工作区自动开段」冲突，后续再议）
- 不改删除语义：只解除归属，文件夹与对话保留

## 2. 交互规格

### 2.1 页面骨架

```
模块根（现有 h-full flex flex-col min-h-0）
└─ 选择页 flex-1 min-h-0 flex flex-col overflow-hidden
   └─ 内容列 mx-auto w-full max-w-[1040px] flex-1 min-h-0 flex flex-col px-6 pt-7 pb-4
      ├─ 页头（shrink-0）：eyebrow / 标题 + 计数 / 说明 / 继续上次 / 搜索 + 新建
      ├─ 分栏（mt-4 flex-1 min-h-0 max-h-[480px] grid gap-3
      │        grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)]）
      │  ├─ 左：relative 单元格 → 面板 absolute inset-0（flex 列，overflow-hidden）
      │  │     ├─ 列表 flex-1 min-h-0 overflow-y-auto kb-thin-scroll
      │  │     └─ 底栏 shrink-0：新建按钮 / 行内新建表单
      │  └─ 右：预览 flex 列（relative，overflow-hidden）
      │        ├─ 内容 flex-1 min-h-0 overflow-y-auto kb-hide-scrollbar
      │        ├─ 操作条 shrink-0 border-t
      │        └─ 删除确认 absolute inset-0 z-10（kb-view-fade）
      └─ 页尾（shrink-0 mt-3）：学习者画像 / 全局要求 + 目录规则 details
```

- 等高原理：左列外层 `relative`、列表面板 `absolute inset-0`；行高由右侧预览决定，左侧永远填满同一高度
- 页面本身 `overflow-hidden`，所以窗口不出现整页滚动条；只有列表 / 预览内部滚
- 分栏高度 `flex-1` 自适应但有 `max-h-[480px]`：预览内容不多时不会把面板拉满，避免中间空一大截；
  窗口内容高度过矮（< 860）时退化为整页滚动，避免面板被压到不可用
- 预览内容区**不画滚动条**（`kb-hide-scrollbar`），实际溢出时仍可滚轮滚动；操作条永远在面板底部，不会被内容顶走
- 列表滚动条复用现有 `.kb-thin-scroll`（4px、悬停才显形）

### 2.2 左侧列表

- 每行：文件夹图标 + 名称 + 「N 对话 · M 产物」 + 右侧最近活跃
- 行是 `<button role="option" aria-selected>`；单击 = 选中（预览跟随），双击 = 进入
- 选中态：`bg-[var(--accent)]/12` + 左缘 2px 强调条
- 「上次工作区」不额外加标签（右侧预览有标识），避免列表噪音
- 列表底：`＋ 新建工作区` 固定在面板底部（不随列表滚动）
- 行数多时内部滚动；不启用 `content-visibility`（工作区量级通常 < 50）

### 2.3 右侧预览

自上而下：

1. 文件夹图标 + 课程名（改名时变输入框）+ 目录路径 + 「打开」图标按钮 + 「上次活跃」小标签
2. 统计三块：对话 / 产物 / 最近活跃
3. 课程进度：细进度条 + 百分比；无大纲时显示「还没有课程大纲」；加载中显示静态占位条
4. 最近对话：最多 2 条，只读（消息图标 + 标题 + 相对时间）
5. 操作条（固定底部）：进入工作区（主）/ 改名 / 画像 / 要求 / 删除（右）

- 不再显示「本课程目标」长文（已确认），也不再单列「工作区目录」块（路径与打开按钮上移到标题下）
- 内容区与操作条之间用 1px 分隔线

### 2.4 新建 / 改名 / 删除（全部行内）

| 操作 | 入口 | 形态 | 键位 |
|---|---|---|---|
| 新建 | 页头按钮 / 列表底按钮 | 列表底部展开输入行 + [创建并进入] [取消]；重复名 / 空名在表单内显示错误 | Enter 提交 / Esc 取消 |
| 改名 | 预览操作条 | 预览标题变输入框 + [保存] [取消]；错误就地显示 | Enter 保存 / Esc 取消 |
| 删除 | 预览操作条 | 预览面板整体覆盖确认层（「只解除归属，文件夹与对话保留」）+ [取消] [删除] | Esc 取消，默认焦点在取消 |

- 删除成功后：刷新列表 → 选中相邻项（优先同位置，否则上一条）→ Toast；删空则进入空态
- 所有错误走行内文案（表单下 / 标题下），不再只靠 Toast
- 移除 `wsModal` 状态、`submitWsModal`、`removeWs`（删除逻辑并入行内确认处理器）；`showGlobalConfirm` 在本模块其它三处继续使用，不动

### 2.5 搜索 / 排序 / 选中

- 搜索匹配 **名称 + 目录路径**（不再匹配目标；目标字段已从本页移除）
- 排序：`lastWorkspaceId` 置顶 → 其余按 `lastActive` 倒序（空值排最后）→ 名称兜底
- 选中规则：
  - 进入页面时选中 `lastWorkspaceId`，否则第一条
  - 过滤 / 删除后若选中项不在结果里，自动选中第一条可见项
  - 无结果时列表显示「没有匹配…」+ 清空按钮，预览显示「没有选中的工作区」
- 搜索框：`Esc` 清空（清空后再按一次离开输入框）、`Enter` 进入选中项
  - 未做全局 `/` 聚焦：AI 教学输入区的 `/` 是斜杠指令入口，全局抢键会与 `/mindmap`、`/生图` 冲突

### 2.6 空态与窄窗

- 一个工作区都没有：列表区提示「还没有工作区」，预览区给「新建工作区」主按钮
- 窄窗：左列宽度 `< 1280` 时 260px、`≥ 1280` 时 300px；预览自适应，内容自行滚动
- 极矮窗口：两块面板随 flex 收缩；预览内容可滚但无条，操作条始终可见

### 2.7 键盘与焦点

- 列表 `role=listbox` + `tabIndex=0`；`↑ / ↓` 移动选中（焦点跟随行），`Enter` 进入
- 新建 / 改名输入框打开即聚焦；`Esc` 逐层取消（先关删除确认 / 改名，再清搜索）
- 图标按钮补 `aria-label`；悬停提示用 **`data-tip`**（3.25 起的统一气泡），不再写原生 `title`
  - 本次重写到的按钮（打开 / 删除 / 新建等）顺手完成 `title` → `data-tip` 迁移；纯文字按钮不需要

## 3. 数据与 IPC

### 3.1 最近对话（零额外读盘）

`listWorkspaces()` 已经在主进程里 `listAgentSessions()` 一次、并按工作区过滤出 `own`。直接复用：

```ts
// electron/lib/aiTeachingWorkspaces.ts
export interface WorkspaceRecentSession { id: string; title: string; updatedAt: string }
export interface WorkspaceInfo extends AiWorkspace {
  // …现有字段
  recentSessions: WorkspaceRecentSession[]
}
```

```ts
const recentSessions = [...own]
  .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  .slice(0, 2)
  .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updated_at }))
```

- 不新增 IPC 通道、不新增磁盘读：`sessions` 本来就在内存里
- 渲染层时间格式：新增 `wsRecentTime(iso)`（今天 HH:MM / 昨天 HH:MM / M 月 D 日），与现有 `wsAgo` 并列

### 3.2 课程进度（选中时懒加载 + 缓存）

- 复用现有 `aiTeachCourseGetState(wsId)`（`aiTeachCourse:getState`），一次只取选中的一门
- 新增零依赖纯函数：

```ts
// src/lib/aiTeachingProgressPure.ts
export interface ProgressOutlineLike { chapters: { units: { id: string }[] }[] }
export function courseProgressSummary(
  outline: ProgressOutlineLike | null | undefined,
  progress: Record<string, ProgressUnitLike> | null | undefined,
  lessons: Record<string, ProgressLessonLike> | null | undefined,
): { learned: number; total: number; pct: number }
```

口径直接复用 `unitLearned()`：所在段未收尾的知识点不算学完；`total === 0` 时 pct 为 0。

> 注意：`getCourseState()` 内部会先跑 `ensureCourseLayout()`（幂等迁移，与「进入工作区」完全同一条路径）。
> 预览只是把它提前到选中时执行；若后续不接受「仅浏览也触发迁移」，再单开只读 `course:getBrief` 通道（本版不做）。

- 渲染层缓存：`useRef<Map<wsId, { learned; total; pct } | 'none'>>` + `useRef<Set<wsId>>` 防重复请求；
  读取时命中缓存直接渲染，未命中发一次请求后写缓存并触发重渲染
- 失效：`exitToPicker()` 与 `refreshWorkspaces()` 清空缓存（从工作区返回时进度可能已变）
- 竞态：按 wsId 入缓存，即使快速连点也不会把进度写到别的课程上
- 预览缓存只为展示；真正进入仍走 `enterWs()` 的原有取数，不改其行为

### 3.3 打开文件夹

- 标题下的「打开」按钮：`workspaceGetCurrent()` 拿 `rootId` → `workspaceOpenInSystem(rootId, w.folderRel)`
- 复用现有通道与约定（渲染层不接触绝对路径）
- 失败 Toast；`rootId` 缺失时提示「尚未打开仓库」

## 4. 文件改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `electron/lib/aiTeachingWorkspaces.ts` | `WorkspaceRecentSession` + `WorkspaceInfo.recentSessions`；`listWorkspaces` 里按 `updated_at` 取前 2 条 |
| 2 | `src/types/index.ts` | `AiTeachRecentSession`；`AiTeachWorkspaceInfo` 增 `recentSessions` |
| 3 | `src/lib/aiTeachingProgressPure.ts` | 新增 `courseProgressSummary`（零依赖、结构类型） |
| 4 | `src/modules/ai-teaching/index.tsx` | **主改**：picker 分支整段替换（约 3490–3618 行）；状态 / 处理器 / 键盘 / 行内表单；移除 `wsModal`、`submitWsModal`、`removeWs`，并同步摘掉全局 Esc 栈里的 `wsModal` 分支（约 1621 行）与依赖项；新增 `workspaceOpenInSystem` 导入 |
| 5 | `src/styles/index.css` | 新增 `.kb-hide-scrollbar`（隐藏条但可滚，4 行；列表复用既有 `.kb-thin-scroll`） |
| 6 | `.AGENT/scripts/ai-teaching/verify-picker.mjs` | 新增契约脚本（见 §6） |
| 7 | `resources/help/AI 教学 · 课程模式.md` | 「选择工作区」段改写（见 §8） |
| 8 | `package.json` / `CHANGELOG.md` | 3.26.0 + 更新说明段落 |

**不改**：`electron/preload/index.ts`（同一通道，返回体多字段无需改桥）、`electron/lib/aiTeachingCourse*.ts`、工作区内部组件。

## 5. 动效（全部复用既有令牌，见 `docs/ui-animation-plan.md`）

| 场景 | 类 | 说明 |
|---|---|---|
| 进入选择页 | `.kb-view-in` | 页面根节点，现有 Tab 保活会重放 |
| 切换选中的课程 | `.kb-view-in` + `key={sel.id}` | 只淡入 + 8px 上移，不卸载预览骨架 |
| 新建表单展开 | `.kb-item-in` | 表单替换底部按钮时进场 |
| 新建成功的行 | `.kb-item-in` | 只给刚创建的那一行（`newWsId` 标记） |
| 删除确认层 | `.kb-view-fade` | 只透明度过场，覆盖在预览面板内 |
| Toast | 现有 `.kb-toast-in/out` | 成功 / 失败反馈 |

- 不加新的 keyframes；全部带 `prefers-reduced-motion` 兜底（令牌已内置）
- 不用 `transition-all`；悬停色变沿用 `transition-colors`

## 6. 类型与契约脚本

- 类型门禁：
  - `npx tsc --noEmit -p tsconfig.node.json`
  - `npx tsc --noEmit -p tsconfig.web.json`
- 新脚本 `.AGENT/scripts/ai-teaching/verify-picker.mjs`（纯 ASCII 输出）：
  1. **纯函数**：用 `stripTypeScriptTypes` 载入 `aiTeachingProgressPure.ts`
     - 3 个知识点 0 学完 → `{learned:0,total:3,pct:0}`
     - 2 学完 → `pct=67`
     - 某知识点所在段仍 open → 不算学完
     - `outline=null` → `{0,0,0}`
  2. **静态接线**：
     - `aiTeachingWorkspaces.ts` 含 `recentSessions` 且 `slice(0, 2)`
     - `types/index.ts` 的 `AiTeachWorkspaceInfo` 含 `recentSessions`
     - `index.tsx` 含 `courseProgressSummary`、`kb-thin-scroll`、`kb-hide-scrollbar`、
       `grid-cols-[260px_minmax(0,1fr)]`、`workspaceOpenInSystem`
     - `index.tsx` 不再含 `wsModal` / `setWsModal` / `submitWsModal`
     - 删除不再调用 `showGlobalConfirm`（该行内流程里）
     - `styles/index.css` 含 `.kb-hide-scrollbar`
  3. 退出码非 0 即失败；输出用 `PASS` / `FAIL`

## 7. 验收清单（实机）

- [ ] 1512×982 / 1280×800：整页无窗口滚动条，两块面板上下沿严格对齐
- [ ] 12+ 工作区：只有左列表滚动；滚动条 4px、仅悬停显形
- [ ] 预览内容区无滚动条；操作条始终贴在面板底部
- [ ] 单击只选中、双击 / 按钮 / Enter 才进入；进入后「返回选择页」选中态保留
- [ ] 搜索名称与目录路径；无结果空态；选中项自动回落到第一条
- [ ] 新建：页头与列表底两个入口都能打开；重名/空名行内报错；创建后直接进入
- [ ] 改名：预览标题行内编辑；Enter 保存、Esc 取消；文件夹同步改名
- [ ] 删除：预览内确认层；只解除归属；删完选中相邻项；删空进入空态
- [ ] 进度：选中首次加载、二次选中不重复请求；从工作区返回后刷新
- [ ] 最近对话显示 2 条、时间格式正确；无对话时给占位文案
- [ ] 「打开」能在系统文件管理器中打开工作区文件夹
- [ ] `↑/↓/Enter`、`/`、`Esc` 键位可用；图标按钮有 `aria-label` + `data-tip`
- [ ] 深色 / 浅色 / 昼夜夜晚三种主题下对比度正常；reduced-motion 下无位移

## 8. 帮助手册与发版

- 改 `resources/help/AI 教学 · 课程模式.md` 的「选择工作区」一节：
  左列选课、右侧预览、双击进入、行内新建/改名/删除、进度与最近对话的来源、列表滚动
- 跑 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs` 验收检索
- 发版：`package.json` → `3.26.0`；`CHANGELOG.md` 段名 `## v3.26.0（日期）`；
  重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`；`npm run pack` 落 `packs/3.26.0[-N]`；push 等明确指令

## 9. 取舍与风险

- **预览偏空**：目标 / 目录 / 上次标签去掉后，预览内容比面板矮，操作条固定在底、中间会留白；
  面板已用 `max-h-[480px]` 收紧。若实机仍显空，可补一节「章节概览」（`getState` 已带 outline，无需新通道），本条暂列 v3.26 之后的跟进项
- **高度链**：模块根已是 `h-full flex flex-col min-h-0`，选择页 `flex-1 min-h-0` 即可；若 Tab 宿主加了 padding
  导致仍出现整页滚动，优先检查这一层，不要在页面里写死高度
- **绝对定位左列**：行高由预览决定；预览内容（含最近对话）必须保持有界，否则会把分栏顶高——最近对话固定 2 条
- **懒加载进度**：每次选中最多一次 `course:getState`；若某仓库课程状态文件很大，首次选中会有轻微延迟，用占位条遮挡
- **隐藏滚动条**：预览超出时无可见提示；靠「操作条固定 + 内容区截断」判断是否还有内容。若后续反馈难发现，再加悬停渐隐
- **最近对话只读**：如后续要直接跳会话，需要在 `enterWs` 增加「指定 session」分支并复用 `openSegmentBySid`，单独立项

## 10. 实施顺序

1. IPC 字段 + 类型 + 纯函数（可独立跑契约脚本）
2. 页面骨架与等高布局（先静态数据，确认无整页滚动）
3. 列表 / 预览渲染 + 选中联动 + 搜索排序
4. 行内新建 / 改名 / 删除 + 错误文案
5. 进度懒加载与缓存 + 最近对话 + 打开文件夹
6. 键盘、动效、`data-tip`、契约脚本、tsc、实机验收

## 11. 实施记录（3.26.0）

- 按 §10 顺序全部落码；`tsc --noEmit` 两个 project 均通过，`npm run build` 通过，`verify-picker.mjs` 28/28。
- **计划外但必要的两处**：
  - 工作区内部顶栏 chip 的「新建工作区」原来是打开 `wsModal`，改成「回选择页 + 展开列表底输入」；
  - `src/styles/index.css` 的 `.kb-fit-aiws` 容器规则随卡片一起删除（编号 ④ 留空注释，不重排）。
- **与计划的偏差**：全局 `/` 聚焦搜索未实现（理由见 §2.5）；搜索框改为 `Esc` 清空 / `Enter` 进入选中项。
- **实机验收（§7）尚未执行**：当前开发机为 Linux 无显示环境，跑不了 Electron 真机检查；等高、无窗口滚动条、滚动条显隐需在 Windows 上过一遍。
