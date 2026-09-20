# UI 全局动效规划（2026-09-11）

> 目标：所有「页面变化点」都有平滑动画。本文档是落码前的定稿依据，按「基础设施 → 共享组件 → 模块清单」三阶段实施。
> 原则：**只动 transform / opacity / grid-rows**；拖拽跟手过程不加动画；全部动画带 `prefers-reduced-motion` 兜底。
> **可交互原型**：`docs/prototypes/ui-animation-prototype.html`（六类动画全部可点，含倍速 / reduced-motion 对照 / 明暗切换 / 类名标注开关）

---

## 一、现状统计结论

### 已有成体系的动画（保留、作为范式复用）
| 范式 | 位置 | 说明 |
|---|---|---|
| 删除吞噬 DeleteWipe | index.css `kb-deleting` 系列 | 列表删除，全模块共用，保留不动 |
| 任务完成反馈三档 | index.css `kb-task-*` 系列 | schedule TodoItem |
| 面板宽度过渡 | shared/ResizablePanel.tsx:179 | `width 200ms ease-out`，拖拽时自动禁用 |
| AI 学堂滑入/扩张 | AssistantPanel | `cubic-bezier(.22,.68,.32,1)` 280-420ms |
| 视图交叉淡化 | schedule `useViewTransition` | 唯一做了视图切换过渡的模块 |
| 相册展开/新帖入列 | moments `grid-rows 300ms` + `animate-album-unfold` | 展开收起与列表进场的现成范式 |
| 禅模式过渡 | `.zen-transition` / `.zen-paper-bg` | 300ms |

### 完全无动画的重灾区（补齐优先级从高到低）
1. **顶层视图硬切**：Tab 切换（App.tsx display:none 保活）、settings 左导航、blog 三视图、moments 时间线/相册、toolbox 画廊↔工具、help/devtools 目录、knowledge 文件/大纲 tab。
2. **所有弹层硬切**：ConfirmDialog、GlobalConfirm、CommandPalette、全部自定义 Modal（TodoEditModal、ImportModal、moments 三弹窗、plugins 确认框、关联选择器…）、右键菜单、下拉菜单、Toast 进出与堆叠。
3. **树/分组展开收起**：NotebookList、FileTree、ChapterPanel、AiModelsTab 分组、help 目录、CollapseList。
4. **列表增删**：Tab 增删/拖拽排序、TaskTray、blog 条目、moments 帖子、recycle 行删除、会话列表删除。
5. **状态跳变**：主题切换全局颜色跳变、收藏星标、日历月切换、PDF 翻页、保存圆点、划词浮钮。
6. **全屏模式进入/退出**：沉浸阅读、图谱全幅、QuizMode、QuizCollection、PDF 沉浸模式。

---

## 二、统一动画规范（设计令牌）

全部落在 `src/styles/index.css`，命名前缀 `kb-`，与现有令牌同处。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--ease-kb` | `cubic-bezier(0.22, 0.68, 0.32, 1)` | 标准缓动（快出缓停无回弹，沿用既有定稿） |
| `--ease-kb-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 反馈类微回弹（沿用 kb-task-pop） |
| `--dur-micro` | 140ms | hover、状态色变、菜单项 |
| `--dur-std` | 220ms | 树展开、列表进出、抽屉 |
| `--dur-large` | 300ms | 视图切换、Modal、全屏模式 |
| `--dur-view` | 260ms | Tab / 大区切换（fade + translateY） |

### 新增工具类（一阶段基建，约 10 个）
| 类 | 内容 | 使用场景 |
|---|---|---|
| `.kb-view-in` | `opacity 0→1 + translateY(8px)→0`，`--dur-view` | 所有顶层视图/Tab 切换进场 |
| `.kb-pop` | `opacity + scale(0.96→1) + translateY(6px→0)`，240ms | 菜单、下拉、popover 进场 |
| `.kb-overlay` | 遮罩 `opacity 0→1` 200ms | 所有 Modal 遮罩 |
| `.kb-modal-in` | 面板 `scale(0.97→1) + translateY(10px→0)`，280ms | Modal 主体进场 |
| `.kb-collapse` | `grid-template-rows 0fr↔1fr` 240ms + 子元素 `overflow:hidden` | 树节点/分组/折叠面板展开收起 |
| `.kb-chevron` | `transform rotate` 200ms | 所有展开箭头 |
| `.kb-item-in` | `opacity + translateY(4px)` 200ms，`--ease-kb` | 列表项进场（新增行） |
| `.kb-item-out` | `opacity→0 + scale(0.98) + 高度塌缩`，180ms | 列表项退场（普通删除，区别于吞噬特效） |
| `.kb-micro-pop` | `scale 1→0.85→1` 180ms spring | 星标、勾选、开关点击反馈 |
| `.kb-dock-hint` | `opacity 0→1 + translateX(12px→0)` 170ms | 可拖动浮窗拖近停靠区时的落位预览块（G 类） |
| `.kb-theme-vt` | `::view-transition-old/new(root)` 交叉淡化 220ms | 主题切换（View Transition），降级走容器级过渡 |

> 所有类统一包一段 `@media (prefers-reduced-motion: reduce)` 关闭。

---

## 三、分类动画指派（按变化类型，非逐点罗列）

### A. 顶层视图切换 → `.kb-view-in`
| 交互点 | 位置 | 方案 |
|---|---|---|
| Tab 切换（保活 display:none） | App.tsx:710 | 显示瞬间对内容容器挂 `.kb-view-in`（key 用 activeTab 重放动画，无需卸载组件） |
| settings 左导航大项切换 | settings/index.tsx | 内容区 `.kb-view-in`，方向感可选：向下进入 |
| blog 三视图 / moments 视图 / toolbox 画廊↔工具 / help / devtools / plugins tab | 各 index.tsx | 同上，统一 `.kb-view-in` |
| knowledge 文件/大纲 tab | knowledge/index.tsx:1350 | 同上 |
| 知识库沉浸阅读、图谱全幅、QuizMode、QuizCollection、PDF 沉浸进出 | 各处 | 全屏覆盖层统一 `.kb-overlay` + 内容 `.kb-modal-in`（300ms），退出 180ms |
| 引导步骤（已有 180ms） | Onboarding.tsx | 迁到统一令牌 |

### B. 弹层（Modal/菜单/popover）→ `.kb-overlay` + `.kb-pop` / `.kb-modal-in`
| 交互点 | 方案 |
|---|---|
| ConfirmDialog（全应用共用）| **改组件一处全局受益**：遮罩 `.kb-overlay` + 面板 `.kb-modal-in`，退场 160ms 反向 |
| GlobalConfirm、CommandPalette | 同上 |
| 右键菜单（NotebookList 三类、ChapterPanel、editor tabCtx/ctxMenu、知识库页面菜单）| `.kb-pop` 160ms，transform-origin 对准锚点 |
| 下拉（TitleBar 更新面板、ActivityBar 设置/主题子菜单、语言菜单、更多菜单、sizeMenu、createMenu、「+」新建）| `.kb-pop` 160ms |
| 各模块自定义 Modal（TodoEditModal、ImportModal、moments 三弹窗、BlogTemplateModal、TagManageModal、plugins 确认框、关联/wiki 选择器）| 统一遮罩+面板组合；优先抽一个共享 `<KbModal>` 壳，一次收敛 |
| 划词浮钮、AI 悬浮按钮 | `.kb-pop` 180ms spring |
| Toast | 进：顶部滑入 240ms；出：淡出+上移 180ms；堆叠位移用 transform 过渡 |

### C. 展开/收起 → `.kb-collapse` + `.kb-chevron`
覆盖：NotebookList 树节点、收藏分组、FileTree 目录与「软件文件」节、ChapterPanel 两组列表、AiModelsTab 分组、CollapseList、help 目录、大纲/搜索侧栏（editor PdfReaderView sideTab）、已完成面板、密码本分组、标签结果展开。方案：`grid-rows 0fr→1fr` 240ms（moments 已验证此模式），chevron 旋转 200ms。子树首帧加 `.kb-item-in` 弱化层级感。

### D. 列表增删/排序
| 场景 | 方案 |
|---|---|
| 新增行（TaskTray、blog、moments 帖子、Tab 新建、会话新建）| `.kb-item-in` 200ms |
| 普通删除/还原（recycle、会话删除、moments）| `.kb-item-out` 180ms 后卸载（组件内 setState 延迟卸载即可，不引 FLIP 库） |
| 破坏性删除 | 保留 DeleteWipe 吞噬特效，不重复叠加 |
| Tab/树拖拽排序 | 落位仍瞬跳（FLIP 成本高，列入后续可选）；拖起 opacity 加 120ms 过渡即可 |

### E. 状态反馈 → `.kb-micro-pop` / 150ms 色变
收藏星标（knowledge/blog）、保存圆点颜色、勾选框、plugins 开关（已有）、PdfViewer 适宽选中、TrafficLight 已达标项不动。日历月切换：网格 `.kb-view-in` 弱化版（仅 opacity 180ms）。PDF 翻页：canvas 容器 opacity 120ms 快闪淡入，不拖慢连续翻页。

### F. 主题切换 → View Transition（**不用 wildcard 全局过渡**）
实测（见 §五）：`html.theme-transitioning * { transition: color/background }` 在 4290 节点下会让主线程卡住 133ms 单帧——**该方案作废**。
改为 `document.startViewTransition`（Electron 33 = Chromium 130，原生支持）：快照交叉淡化 220ms，逐节点 recalc 成本为零，帧分布与「瞬时切换」完全一致。
降级路径（不支持时）：只对少数大面积容器（根容器 / 侧栏 / 内容壳）加 200ms 背景过渡，绝不使用 `*` 通配。

### G. 拖拽辅助投影 → `.kb-dock-hint`（2026-09-14 新增）
可拖动浮窗（AI 教学「支线旁问」）在拖近停靠区时，于落点位置浮现一个预览块，提示「松手会停在这里」。
只做 `opacity + translateX(12px→0)`，方向与停靠侧一致（从停靠侧滑入）。
调用方须给元素 `pointer-events-none`——提示压在舞台右缘，不能吃掉正在进行的拖拽手势。
与「跟手无动画」的边界见 §五-6：跟手的是窗口本体（无动画），提示是状态翻转（有动画）。

### H. 保活浮层显隐 → `.kb-view-toggle`（2026-09-20 新增）
适用场景：**元素常驻不卸载**的浮层视图（错题本视图等「页签 ↔ 视图」反复切换、内部有大量
筛选/编辑态不能丢的界面）。这类切换不能用 `.kb-view-fade` 等挂载动画——元素不 remount，
动画没有重播时机；也不能用条件渲染——卸载即丢状态（与 §C 折叠容器的「外层常驻」同理）。
用法：外层 wrapper 挂 `kb-view-toggle absolute inset-0` + `aria-hidden={!open}`，
状态由 `aria-hidden` 属性承载（true = 淡出 + `visibility:hidden` + 不可点）。
实现只动 `opacity` / `visibility`（visibility 离散属性随 duration 延迟翻转 = 淡出完成后
才真正不可聚焦），令牌 `--dur-std` / `--ease-kb`，带 `prefers-reduced-motion` 兜底。
首个使用方：知识库错题本视图（notes-merge，保活哲学与 App Tab 宿主同源）。

---

## 五、性能评估（实测数据）

测量环境：真实 Chromium（agent-browser 无头，软件合成），原型 295 节点，脚本 `tmp/anim-perf.js`。
数值是**同一环境下的 A/B 对比**，不是绝对值；重点是「动画开关」造成的差异。

### 1. 合成器动画（transform / opacity）——增量成本约等于 0
| 场景 | 帧数 | avg | p95 | max | >20ms 帧 |
|---|---|---|---|---|---|
| 视图切换（带动画）| 138 | 6.07ms | 6.2ms | 6.5ms | 0 |
| 视图切换（动画压到 1ms）| 136 | 6.07ms | 6.2ms | 6.3ms | 0 |

两者曲线完全重合 → `.kb-view-in` / `.kb-pop` / `.kb-modal-in` / `.kb-item-in` / `.kb-micro-pop` 这类纯 transform+opacity 动画**基本不产生额外开销**（走合成器线程，不触发布局与绘制）。

### 2. 高度动画（grid-template-rows）——数千行也只有零点几毫秒
每帧一次 toggle + 强制布局的耗时：

| 子树行数 | 20 | 500 | 2000 | 6000 |
|---|---|---|---|---|
| 每次布局 ms | 0.012 | 0.021 | 0.054 | 0.15 |

线性增长且极低：6000 行也只有 0.15ms/帧，占 16.7ms 预算的 1%。
注意：该项为离屏容器测量（Chrome 会跳过绘制），只代表 **layout 成本**；可见子树还要叠加 paint，但即使 ×10 仍在预算内。真正的风险点是**同时展开多个数千行子树**，控制方式见表末。

### 3. Toast 风暴（24 个连续创建）——单帧抖动一帧
avg 6.3ms / p95 6.2ms / **max 42.5ms** / 超 20ms 帧 = 1，无超 50ms 帧。
即连续创建几十个带阴影的浮层会掉一帧，属可接受范围（真实场景几乎不会 24 个并发）。

### 4. 主题切换——唯一的重灾区
| 方案 | 帧数 | avg | p95 | max | 结论 |
|---|---|---|---|---|---|
| 瞬时切换（基线）| 67 | 6.16ms | 6.3ms | 12.1ms | 基准 |
| **wildcard `*` 过渡** | **2** | 75.9ms | **133.6ms** | 133.6ms | ⛔ 主线程冻结 ~134ms |
| **View Transition** | 43 | 6.21ms | 6.2ms | 12.1ms | ✅ 与基线一致，且免费获得交叉淡化 |

wildcard 方案在 420ms 采样窗口内只渲染出 2 帧 = 界面明显冻结。真实应用节点数是这里的好几倍（Monaco + 列表），只会更糟。**结论：F 类改用 View Transition。**

### 5. 未实测但必须规避的三类风险
| 风险 | 原因 | 处理 |
|---|---|---|
| **带 backdrop-filter 的遮罩淡入**（moments 五处弹窗 + 灯箱 + TitleBar + PDF 悬浮条）| 遮罩 opacity 动画期间，模糊背景每帧重新采样，背后是图片墙时成本极高 | 遮罩动画只作用于**纯色层**；blur 放在独立、不参与动画的兄弟层，或动画结束后再挂 blur |
| **重内容面板做 transform 动画**（Monaco / PDF canvas / 插件 iframe）| 会把整个子树提升为合成层并重新栅格化，显存占用大；iframe 在 transform 中易闪烁 | 重面板只做 opacity 淡入，**不加 translateY**；外壳动、内容不动 |
| **列表项逐个进出场** | 每项一个合成层，一次进 50 项 = 50 层显存峰值 | stagger 最多前 8 项（delay ≤ 8×30ms），其余同时进场；**禁止给列表项常驻 will-change** |

### 6. 落码时的硬约束
1. 只动 `transform` / `opacity`（`.kb-collapse` 的 grid-rows 是唯一例外，已验证成本可接受）；
2. 不给列表项、卡片、弹层加常驻 `will-change`（confetti.ts 那次性使用是正确姿势）；
3. 主题切换禁用通配选择器过渡，统一 View Transition + 容器级降级；
4. 遮罩层与 backdrop-filter 层解耦；
5. 所有新增动画仍需在 `prefers-reduced-motion: reduce` 下退化为瞬时；
6. **拖拽跟手过程一律无动画**（元素本体不许有 transition；位置由 pointer 位移直写内联样式）。
   唯一允许的例外是「拖拽的辅助投影」——如浮窗拖近停靠区的落位提示（`.kb-dock-hint`，G 类），
   它不跟手、只是状态翻转提示，故可以有进场动画。

---

## 六、实施进度

### 已完成（阶段①②③全部）

**基建**
- `src/styles/index.css`：令牌（`--ease-kb` / `--ease-kb-spring` / `--dur-micro|std|large|view`）+ 工具类
  `.kb-view-in`、`.kb-view-fade`、`.kb-overlay(-out)`、`.kb-modal-in/-out`、`.kb-pop`、`.kb-toast-in/-out`、
  `.kb-collapse`、`.kb-chevron`、`.kb-item-in`、`.kb-item-out`、`.kb-micro-pop`、`::view-transition(root)` + 统一 reduced-motion 兜底。
  折叠容器用 `visibility`（延迟 `--dur-std` 切换）避免收起后的按钮/输入行仍可 Tab 聚焦。
- `src/lib/usePresence.ts`：退场存在性 hook（定时器兜底，不依赖 transitionend）+ `prefersReducedMotion()`
- `src/components/shared/Collapsible.tsx`：函数子节点的折叠容器（两个方向都有动画，且保持收起不挂载子树的懒语义）
- `src/components/shared/ModalShell.tsx`：**新增弹层规范壳**（遮罩淡入淡出 + 面板缩放进出场 + 延迟卸载，
  且带 `animateOverlay` 开关给 backdrop-blur 遮罩用）。当前未接线（30+ 既有弹层走「遮罩挂类」批量通路），
  作为后续新增弹层的首选封装保留。

**共享组件（B 类，一处改全局受益）**
- ConfirmDialog、GlobalConfirm：遮罩淡入淡出 + 面板缩放进出场（带完整退场）
- Toast：右侧滑入 / 收起反向滑出（退场用 ref 幂等，避开 StrictMode 双调用陷阱）
- CommandPalette：遮罩 + 面板进出场（动作立即执行、视觉继续播退场）
- `lib/settings.ts` 的 `applyThemeClass`：改走 View Transition（F 类），首次应用不加过渡

**B 类弹层 / 菜单（批量机制 + 全部接线）**
- 三条「首子元素继承」规则 —— `.kb-overlay > :first-child` / `.kb-overlay-out > :first-child`（面板进/退场）、
  `.kb-pop-layer > :first-child`（菜单/下拉缩放入场）。调用方**只在遮罩上挂一个类**，面板自动跟着动。
- 有 `open` 语义（走 `usePresence`，**完整进出场**）：ConfirmDialog、GlobalConfirm、TodoEditModal、
  TagManageModal、CategoryMovePicker、QuadrantChart、BlogTemplateModal。
- 条件挂载型（只挂 `kb-overlay`，**入场**）：RecycleBinPanel、ImportModal、AiToolsView、AiModelsTab、
  PasswordSection、DataClearSection、VaultArchiveSection、PasswordVault×2、BookmarkModals×2、
  HabitEditorModal、plugins×2、WebSourceDialog、AiTeachFileTree、editor×3、PageEditor×2。
- 菜单 / 下拉（`kb-pop-layer`）：editor 的 createMenu/ctxMenu/tabCtx、NotebookList、ChapterPanel、
  QuickSearch、AiTeachFileTree。
- **backdrop-blur 遮罩另走一路**（按 §五 约束不做遮罩淡入，只动面板）：moments 的编辑器 / 详情 / 相册×2 /
  灯箱（`kb-modal-in` 挂面板本身或 `kb-modal-out` 成对）、BlogTemplateModal（面板进出场）。
- 划词浮钮 TranslateCard：卡片本就靠内联 `opacity` + `transition` 显隐（挂 `.kb-pop` 会被 `both` 填充
  长期压制内联 `opacity:0` 导致关不掉）→ 改走同一套 transition，补 `scale-95` + `origin-top-left`。

**A 类顶层视图切换**
- App.tsx：Tab 切换淡入（`kb-view-fade`，纯透明不做位移，避免把 Monaco/PDF/iframe 提升合成层）+ AI 浮钮入场
- settings 大项、blog 三视图、toolbox 三态、help 文档（此前已完成）
- moments 时间线 / 相册 / 相册详情：`key={viewMode:selectedAlbumId}` + `kb-view-in`
- plugins 已安装 / 市场 tab：`key={tab}` + `kb-view-in`
- devtools 工具切换：`key={activeId}` + `kb-view-in`
- 知识库：沉浸阅读进场 + 主布局回退进场（`kb-view-fade`，含 iframe 故只透明）；
  「大纲」面板进入 `kb-view-in`；`GraphView`、`QuizCollection`、`QuizMode` 全屏层 `kb-view-fade`
- editor：预览分栏 `kb-view-fade`；大纲浮层 `kb-pop`
- 日历切月：网格 `key={year-month}` + `kb-view-fade`（仅 opacity，避免位移干扰日期定位）
- PdfReaderView：侧栏显隐 `kb-view-fade`，大纲 / 搜索两个 tab 各自 `kb-view-in`

**C 类展开 / 收起（`.kb-collapse` + `.kb-chevron`）**
- 复用 `Collapsible`（外层常驻、只懒挂载子树）：ChapterPanel 章节列表、NotebookList 收藏分组、
  QuickSearch 标签结果、日程「已完成」面板、AiModelsTab 服务商表单展开
- chevron 单图标 + `.kb-chevron`（顺带修掉 Tailwind v4 `rotate` 收不到 `transition-transform` 的老问题）：
  ChapterPanel 章节/页面、PasswordVault 分组、日程已完成、NotebookList 收藏、QuickSearch 标签

**D 类列表增删（进场）**
- `.kb-item-in`：recycle 行、TaskTray 任务卡、blog EntryCard、AI 侧栏会话列表、editor「未保存」标记

**E 类状态反馈**
- `.kb-micro-pop` + `key` 重挂载重播：收藏星标（blog EntryCard / blog 详情 / 知识库 ChapterPanel /
  知识库 PageEditor / QuizCard / QuizMode / QuizCollection / PasswordVault×2）
- blog 星标 hover 的 `transition-transform` → `transition-[transform,scale]`（Tailwind v4 的 `scale` 是独立属性）

### 明确未做 / 延后（含理由，不是遗漏）
| 项 | 原因 |
|---|---|
| 条件挂载型弹层补「退场」 | 需先把 `{state && ...}` 改造成 `open` 语义，属结构性改动，留待按需做 |
| Tab 增删 / 拖拽排序 | Tab 可拖拽且靠内联 transform 跟手；排序落位仍瞬跳（FLIP 成本高，§四 D 表已列为可选） |
| 密码本分组的展开动画 | 分组内容由分页切片（`take = isCollapsed ? 0 : ...`）驱动，收起时条目不在了，`grid-rows` 无可过渡对象 → 需重做分页口径 |
| editor PDF 翻页淡入 | 页面画布是同一 `<canvas>` 原地重绘，要触发动画必须按页重挂载 → 会打断渲染并闪白，得不偿失 |
| 知识库「文件」tab 回切 | 文件树刻意常驻（保留展开态），不能重挂载 → 回切方向无动画（保留态优先） |
| 插件市场列表逐项进场 | 列表可能很长，§五 明确「一次进 50 项 = 50 个合成层」风险 → 只保留容器级 `kb-view-in` |
| moments 相册照片墙逐项进场 | 同上（图墙可达数十张） |

### 落码踩到并修掉的问题
1. **折叠容器展开方向不播动画**：`Collapsible` / `CollapseList` 原先 `if (!mounted) return null` /
   `{mounted && ...}` —— 外层 grid 容器随 `mounted`（effect 里才置真）一起挂载，展开时元素是**以「已展开」
   状态新建**的，`grid-template-rows` 没有起始态可过渡。改为**外层容器常驻、只懒挂载内层子树**，
   子内容用 `open || mounted` 求值（保证与 `open` 类同一次提交，否则 `1fr` 无内容可撑、过渡退化成跳变）。
2. **`.kb-item-in` 的填充模式必须是 `backwards` 而非 `both`**：`both` 会在动画结束后**长期保留**
   `transform` / `opacity` 声明，而 CSS 动画优先级高于内联样式 → 会压掉拖拽时写的
   `style.transform` / `style.opacity`（FileTree / NotebookList 行拖拽就靠内联 opacity 做反馈）。
3. **JSX 注释位置**：`{/* */}` 只能作为 JSX 子节点，写进 `( ... )` 表达式或属性列表会直接语法报错 →
   这类位置改用 JS 块注释 `/* */`（本轮在 moments 弹窗与 TranslateCard 各踩一次，已修正并全仓扫描）。
4. 批量脚本注入缩进写歪（CategoryMovePicker / QuadrantChart），已手工对齐。

### 验收记录
- `tsc --noEmit -p tsconfig.web.json`：25 个既有债务错误、本轮触碰文件**零新增**
  （blog/index.tsx:396 zoom 类型、plugins/index.tsx 的 toast `"success"` 均为既有债务）
- `tsc --noEmit -p tsconfig.node.json`：2 个既有错误（updateService / ipcSafe），零新增
- `electron-vite build`（main + preload + renderer 三端）：exit 0，警告均为既有（dynamic import 分块、pdfjs eval）
- 产物校验：`out/renderer/assets/index-*.css` 含全部 17 项新增动效类 / 令牌
- Hook 顺序人工核查：批量注入 `usePresence` 的文件均为「所有 Hook → `usePresence` → 早期 return」，return 之后无 Hook
- 全仓扫描：无「括号表达式内 JSX 注释」类语法错误
- 运行态验证：**仍未启动 dev 实例做实机交互**（按既有约定，整套重构收尾时统一 smoke）



---

## 四、实施三阶段

| 阶段 | 内容 | 收益面 |
|---|---|---|
| ① 基建 | index.css 增加令牌 + 10 个工具类 + reduced-motion 统一段 | 纯增量，零风险 |
| ② 共享组件接入 | ConfirmDialog、GlobalConfirm、Toast、CommandPalette、（可选）抽 KbModal 壳；ResizablePanel/AssistantPanel 不动 | 全应用弹层一次到位 |
| ③ 模块接入 | 按「重灾区」顺序：Tab 切换 → settings/blog/moments/toolbox/help 视图 → 树展开 → 列表增删 → 主题切换 → 各模块散点 Modal | 逐模块验收 |

### 验收标准
- 任意界面操作不再出现无过渡的元素生灭（拖拽跟手除外）；
- 全部动画只使用 transform/opacity/grid-rows，无 width/height/left/top 动画（ResizablePanel 既有 width 除外）；
- `prefers-reduced-motion: reduce` 下全部退化为瞬时切换；
- 动画后 `tsc --noEmit` 两个 tsconfig 通过 + smoke。

### 注意事项
- Tab 保活机制下切 Tab 只重放进场动画（display:none→block 重新触发 keyframes 即可），**不得卸载组件**；
- React.memo 组件新增动画类不影响 props 稳定性，但 key 重放方案注意不要破坏既有记忆化；
- Tailwind v4 下 transitionend 属性名陷阱：凡需 JS 兜底的（Modal 退场卸载）沿用 AssistantPanel 的定时器兜底模式，不依赖 transitionend；
- 不引入 framer-motion：现有 CSS 范式已够用，新增依赖与打包体积（铁律 12）不划算。
