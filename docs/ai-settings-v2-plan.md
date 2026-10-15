# AI 区设置改造 v2 实现方案（分子分级 + 文案收口 + 连通性入口）

> 2026-10-14 定。原型已体验确认：`E:\Projects\KnowledgeRecorder\tmp\ai-settings-v2-proto\index.html`（**已定稿，不再改**，只作落码参照）。
> 盘盘数据源：`E:\Projects\KnowledgeRecorder\tmp\ai-copy-audit\report.md`（177 条 / 4997 字逐条表）。
> 本文只讲「改哪些文件、什么做法、哪些取舍」；机制解释一律指向既有文档。

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 目标 | 让「设置 → AI」六个页签读起来是一张**清单**而不是一篇**散文**（用户原话：改造后还是太乱、臃肿） |
| 范围 | 六个页签全部（模型 / 权限 / 工具 / 对话 / 用量 / 教学） |
| 三条手法 | ① 一行一物（列表层只留 状态 + 名称 + 摘要）② 点开才说（表单/账号/清单/协议降级为折叠）③ 解释走 ⓘ 悬停 |
| 新增能力 | 连通性测试入口提到可见层（端点行 / 账号行 / 模型清单各一处），**灰闪电图标按钮 + 悬停才显** |
| 不动的 | 主进程与数据层、IPC 契约、6 页签划分、`AiTab` 联合、`SETTINGS` 的 key/label/keywords、搜索打分、快捷键 |
| 顺带定调 | **CC Switch 线进入观察期**（用户判断：这轮改完软件基本不依赖它了，可能下个 minor 整体清理）—— 本轮**不删代码**，只保证「入口收敛到一处、退役时一处可摘」，全量盘点见 §9 |
| 版本 | `3.6.0` → `3.7.0`（用户可见行为变更 = 抬 minor） |
| 工作量 | 4 刀；第 2 刀最大（`AiModelsTab.tsx` 1238 行基本重写渲染层，数据层逻辑原样搬） |

## 1. 三条硬约束（每刀都受它约束，先立规矩）

1. **可搜索的锚点不因折叠离开 DOM。** 折叠分组必须声明它内部有哪些 anchor，跳转时自动展开。
   现状缺口：`src\modules\settings\components\CollapseList.tsx:10,33-36` 只认**单个** `anchorId`；
   而模型页场景表的 `aiTeach.visionModel` / `aiTools.imageModel` / `aiTools.imageEditModel` 是**组内**三个不同锚点，
   折叠后跳转会「滚到一个收起的分组、什么都看不见」。→ 扩成 `anchorIds: string[]`。
2. **常显白名单只有三类**：空态引导 · 不可逆警告 · 故障诊断。其余一律 HelpHint（hover）或折叠。
   这条直接对应「臃肿」的主因（严格常显 42 条 / 878 字，其中约 52% 是直接写在 JSX 里的说明段）。
3. **动效只用既有令牌**：折叠走 `.kb-collapse`（`src\styles\index.css:766-781`），
   悬停动作新增 `.kb-hoveronly` —— 按铁律 13「缺工具类先补基建」，先改 `index.css` 与
   `docs\ui-animation-plan.md`，再落码。

## 2. 新增基建（第 1 刀；3 件，后面每刀都复用）

| 文件 | 是什么 | 为什么必须新抽 |
|---|---|---|
| `src\components\shared\HelpHint.tsx`（新） | ⓘ 悬停披露：`form='hover'` 行级浮层 / `'swap'` 窄条换字（形态 A）/ `'know'` 已知晓记忆（形态 C）。props：`text / form / icon / align / width` | `docs\help-disclosure-pattern.md` §5 最后一条「抽通用 `HelpHint` 组件」**本就是待办项**，这轮兑现；现在 6 个视图各写各的 |
| `src\modules\settings\components\SettingsGroup.tsx`（新） | 折叠分组外壳：标题行（chevron + 标题 + ⓘ + 摘要 + 右侧动作）+ `.kb-collapse` 内层 + **`anchorIds` 订阅自动展开** + 键盘可达 | `CollapseList` 只有 title/count，没有「摘要 + 右侧动作 + 多锚点」；直接改它会牵动快捷键页等既有调用方 |
| `src\styles\index.css` + `docs\ui-animation-plan.md` | 新增 `.kb-hoveronly`：`opacity:0` 占位（**不用 `max-width:0`/`display:none`，否则悬停时后续元素位移、整行跳版**），宿主 `:hover` / `:focus-within` 时 `opacity:1` | 铁律 13：不许临时用 `transition-all` 凑；且要一份写在文档里的规格供后人复用 |
| `src\components\shared\AnchoredLayer.tsx`（新，**原方案漏了这件**） | 锚点浮层：菜单 / 下拉 / 提示统一走 `createPortal` + `position: fixed`，用锚点 rect 落位、实测宽高纠偏、越界翻面并**夹回视口**；内部滚动不算「页面滚了」；「点外面关闭」把锚点自身算作内部 | 折叠容器的内层 `overflow: hidden`（高度动画要裁切开合）会把**就地 absolute** 的菜单/下拉裁成半个 —— 这一页的账号菜单、场景模型下拉、ⓘ 提示三者都在折叠组里。原方案只在 HelpHint 一条里提了 portal，落地时发现是三处共性问题，故抽成通用件 |

`.kb-hoveronly` 规格（与原型的 `.hoveronly` 一致）：过渡仅 `opacity`、`var(--dur-micro) var(--ease-kb)`、
`prefers-reduced-motion` 走既有全局兜底；**宿主必须可聚焦**，否则键盘用户永远看不到这些按钮；
宿主只许贴住**那一行**（选择器是后代匹配，挂在大容器上会「划过容器就整片亮起」）。

## 3. 四刀分期

### 第 1 刀 · 基建 + 契约（不改任何界面）
- 新增上表三件。
- ✅ 已落地（2026-10-14）：`HelpHint.tsx`（D 形态行级 ⓘ 浮层，portal + fixed 定位，`aria-describedby` + `role="tooltip"`；**只实现 D 形态**，A/C 形态没有调用方就不写）、
  `SettingsGroup.tsx`（`anchorIds: string[]` 多锚点自动展开）、`index.css` 的 `.kb-hoveronly` 段（L 段，`docs\ui-animation-plan.md` 同步）。
- **与原文的偏离（1 处，已确认无害）**：`CollapseList.tsx` **未改** —— 它全仓只有 `AiToolsView.tsx:504` 一个调用方，
  而该调用方在第 3 刀就要换成 `SettingsGroup`；现在两处都改等于同一件事做两遍。多锚点缺口真正出在
  模型页场景表（新代码），`SettingsGroup` 的 `anchorIds` 就是那个修法。第 3 刀迁移完后若 `CollapseList` 无调用方就删掉。
- 顺带：`sections.tsx` 新增 `claimPendingAnchor(ids: string[])`（多锚点认领；逐个 `consumePendingAnchor` 只能命中被调用的那一个，且未命中时不能清）。
- 验收：两套 `tsc` 过 + 既有契约全绿（`verify-ai-tab-anchors` 97 PASS、`verify-llm-accounts` / `verify-ai-perms` / `verify-llm-protocol` / `verify-model-names` / `verify-shortcuts-table` / `verify-mascot` / `verify-ccswitch-import` 全 PASS）+ 六个页签**视觉零变化**（此刀不接入）。
- ⚠ **留给第 3 刀的契约地雷**：`verify-ai-tab-anchors.mjs` §8③ 断言「`SectionHead` 至少被 5 个 AI 视图使用」。
  六个视图里若有 2 个以上改用 `SettingsGroup` + `HelpHint`（不再出现 `SectionHead` 字样），这条会 FAIL ——
  这正是它该改的信号：断言应从「某个具体组件名出现次数」改成「披露组件（`SectionHead` ∪ `SettingsGroup` ∪ `HelpHint`）覆盖了每个 AI 视图」。

### 第 2 刀 · 模型页（改动最大）
文件：`src\modules\settings\views\AiModelsTab.tsx`（1160 行）

| 区块 | 做法 | 取舍 |
|---|---|---|
| 供应商列表 | 每行 = chevron + 状态点 + 名称 + 类型徽章 + 「N 账号 · M 模型」+ 右侧 `⚡ ⋯ 开关`；行整体可点开 | 摘要行取代原来卡上的 baseUrl 行 + Key 状态行 + 延迟行；地址移入展开区（带复制） |
| 展开区 | **连体卡**（行 `rounded-b-none`、表单 `rounded-t-none` + `border-t-0`），内容 = API 密钥 / `自定义设置`(折叠：地址·协议·请求头) / 账号 / 模型目录(折叠：清单·逐模型协议) + 底部右对齐 `取消 保存` | 展开即编辑（DSH 同款），不再有「只读态 → 编辑态」两级；`ProviderForm` 从「独立触发表单」改为展开区内嵌 |
| 预设 | 8 磁贴 → 右侧 `＋ 添加供应商` → 行内选择器（8 预设 + 底部一行「从 CC Switch 导入」）→ 选中后就地展开 `PresetAddForm` | 预设磁贴的副标题（73 字）随之下线；`PresetAddForm` 的「预设替你填了什么」维持明写（那是防呆，不进折叠）。**空态那半句「也可装 CC Switch 后导入」（`AiModelsTab.tsx:225-226`）删掉** —— 导入入口就在下拉里，空态不必重逢；且它是退休线上的文案，留着下版还得改两处 |
| 账号行 | 恢复被 v2 原型弄丢的账号级 `⋯`（更换 Key / 重命名 / 停用 / 删除）+ 新增 `⚡ 测试这个账号` | 切账号仍是左侧圆点（只改 `activeAccountId`，铁律见 `verify-llm-accounts.mjs` §2） |
| 模型清单 | 每项右侧悬停出 `⚡`，结果**行内**显示 `✓ 可用（412ms）` / `✗ <error>` | 不走 Toast：连测两个模型时 Toast 会互相顶掉 |
| 场景分配 | 折叠为一行（摘要「已指定 N / 7」），组内 7 行 = 标签 + ⓘ + 选择器 + 悬停 `测试这个模型` | `anchorIds` 必须含 `aiTeach.visionModel`、`aiTools.imageModel`、`aiTools.imageEditModel`（约束 1） |
| ~~高级~~ | **2026-10-15 整组删除**：组内唯一一项 `llmMaxTokens` 已移除（空组不留壳） | 该上限不再由用户设置 —— 普通对话不下发 `max_tokens` / `max_output_tokens`，Ollama 传 `-1`，Anthropic 因协议必填兜底 4096。口径与理由见 `docs/pending-fixes.md` B-29「最终口径」 |
| `ModelFamilyPanel` | 降级为展开区内的折叠子块 | 能力全留，只是不再常显 |

| `⚡` 规格（用户已拍板）：lucide `Zap`，14px，`text-[var(--text-muted)]`，hover → `text-[var(--text-primary)]` + `bg-[var(--bg-hover)]`，
与现有图标按钮同规格（`p-1 rounded-md transition-colors`）；外裹 `.kb-hoveronly`；`title` + `aria-label` 必填。
**不用 emoji 字形**（原型里那个 ⚡ 只是为了先看位置）。

- ✅ **已落地（2026-10-14）**：`AiModelsTab.tsx` 1238 → 1146 行；渲染层重写，数据层（IPC 调用与入参）逐字保留。
  真机点验脚本 `tmp\probe-ai-models-v2.mjs`（CDP，43 断言全绿，截图落 `tmp\probe-ai-shots\`），关键几条：
  行的 ⚡/⋯ 未悬停时 `opacity=0` 且占位；点行即展开编辑区（名称/API 密钥/自定义设置/账号/模型目录/取消/保存全在）；
  **账号 ⋯ 菜单与场景模型下拉都真挂在 `document.body` 上且完全落在视口内**；
  **搜「图片视觉转写模型」→ 折叠组自动展开 + 锚点高亮**（约束 1 的正向验收）；保存后该行 ⚡ 带 `is-peek` 常显 3 秒、
  编辑区收起；「高级」已移到页尾。
- **能力保留的三处"原文没写但必须有"**：① 编辑区补了**名称**字段（原型把改名入口整个丢了，展开即编辑之后
  ⋯ 菜单里的「编辑端点」被删，改名就无处可去）；② 自定义设置里保留了**测试地址**（改造前 `ProviderForm` 的
  「测试连通」测的是未落盘的草稿地址，删了就真少一个能力）；③ 保留 `embeddingModel`（语义检索模型）与
  模型清单的**手动添加**（原型只在 ⋯ 里留了一句，这里是 ⋯ + 清单里的虚线按钮两条路）。
- **与原型的一处刻意不同**：行内 ⋯ 菜单不再就地 absolute，改走 `AnchoredLayer`（原型是绝对定位——原型页面里
  卡片没有 `overflow: hidden`，真机上折叠容器有，照抄必被裁）。
- **顺带修掉的既有隐患**：`AiModelPicker` 的下拉原先也是就地 absolute，本轮一并走 `AnchoredLayer`，
  否则折叠后的场景表里下拉会被裁掉大半。

### 第 3 刀 · 其余 5 页签 + 一条漏掉的常显通道
| 文件 | 做法 |
|---|---|
| `src\modules\settings\views\AiToolsView.tsx`（1012 行） | 工具页：内置工具 / MCP / Skill / 最近调用 / 高级 → 五个 `SettingsGroup`（行上带计数摘要）。对话页：回复方式 / AI 助手 / 编辑器续写 / Agent 循环 → 四组；组内控件行 = 标签 + ⓘ + 右侧控件，删掉控件下常显的 11px 说明（chat 4 段 ≈ 332 字） |
| `src\modules\settings\views\AiPermissionsTab.tsx`（179 行） | 9 行模块 desc / writeDesc（154 字）→ 模块名旁 ⓘ；`直接生效` 黄条**保持常显**（白名单②）；终端执行 hint 维持 hover |
| `src\modules\settings\views\AiToolsAdvanced.tsx`（110 行） | 「1 ~ 200」「默认值 300，范围 0 ~ 5000」→ ⓘ；三个锚点（`aiTools.sofficePath` / `crawlPages` / `crawlDelay`）随「高级」分组进 `anchorIds` |
| `src\modules\settings\views\AiUsageTab.tsx`（115 行） | 月度上限括号说明（22 字）→ 标签旁 ⓘ（标签只留「月度调用上限」） |
| `src\modules\settings\views\AiTeachingView.tsx`（85 行） | 两段常显说明（70 字）→ ⓘ；**顺手修缺陷**：源码注释声称「这里只留一句指路」而 `{/* … */}` 从不渲染（`AiTeachingView.tsx:80-82`），补一行「视觉转写模型在『模型』页的场景分配表」 |
| `src\modules\settings\components\SettingListPanel.tsx`（258 行） | `description`（第 221-223 行）从**常显**改为 `HelpHint`（盘点里点名的第二条常显通道，`AI_VIEWS` 里唯一漏网的） |

- ✅ **已落码（2026-10-14）**，但**尚未真机点验**（探针目前只覆盖模型页，见 §10 待办）：
  · 新增共用件 `src\modules\settings\components\RowMenu.tsx`（`RowMenuButton` + `MenuItem` + `MenuSep`）：
    行级 ⋯ 菜单统一「挂 body + 自持开合 + 点任一项自动收起」，`AiModelsTab` 的两处菜单也收敛到它；
  · **对话页**：四个 `SettingsGroup`（回复方式 / AI 助手 / 编辑器续写 / Agent 循环），行 = 标签 + ⓘ + 控件，
    整页 11px 常显说明全部进 ⓘ。`anchorIds` 逐组列全（AI 助手那组列了 6 个）；
  · **工具页**：五个 `SettingsGroup`（MCP / Skill / 内置工具 / 最近调用 / 高级），行上带计数摘要；
    MCP 与 Skill 的行内按钮收进 ⋯；内置工具改用 `SettingListPanel` 的 popover 形态（其面板已改走 `AnchoredLayer`，
    否则折叠组里会被裁）；安装三个入口上移到分组标题行；
  · **权限页**：9 行收进一张卡，每行 = 模块名 + ⓘ + 三态控件；读写档说明与只读说明**合并进同一个 ⓘ**
    （原先是"选了读写才把那行字换掉"，等于另一半永远看不到）；
  · **用量页**：月度上限的括号说明进 ⓘ；**教学页**：两行一张卡 + ⓘ，并**补上那句从未渲染的指路**；
  · `SettingListPanel.description` 从常显段落改为标题行 ⓘ（盘点里点名的第二条常显通道）；
  · **删掉 `CollapseList.tsx`**：迁移后它没有调用方了（它唯一的调用方是工具页的「最近调用」）。
- ⚠ **本轮动了两条既有断言**（都是"判据该跟着改"而不是"为了让脚本变绿"）：
  ① §5 的 `AgentLoopPanel` → `AgentLoopGroup`（组件改名，断言意图不变）；
  ② §8② 从「`SectionHead` 出现 ≥5 次」改成「每个视图至少用一个披露件（`SectionHead` / `SettingsGroup` / `HelpHint`）」——
     工具页与对话页现在整页由后两者组成，按旧判据会假 FAIL，且会诱导把 `SectionHead` 塞回去。

### 第 4 刀 · 收尾
- 契约：`.AGENT\scripts\settings\verify-ai-tab-anchors.mjs` §8 加两条闸（见 §4）。
- 新增 `.AGENT\scripts\settings\verify-ai-views-disclosure.mjs`（见 §4）。
- `docs\ui-updates.md` 记流水；`docs\help-disclosure-pattern.md` §5 把「AI 全部页签」那行补记 v2 与 `HelpHint` 抽件。
- `CHANGELOG.md` 写 3.7.0 段 → 重跑 `.AGENT\scripts\release-notes\build-release-notes.mjs`（铁律 24，忘了页面会停上一版且无报错）。
- **AI 手册同步**（AGENTS.md 要求）：`resources\help\AI 权限与工具边界.md` 第 18 行那段「模型页有什么」需要重写（供应商改行式、预设收进按钮、场景表默认折叠、新增三处测试入口）；
  另外 3 篇提到场景表的路径（`AI 教学素材与代码.md:36`、`AI 生图.md:67`、`快速上手.md:64,80`）
  路径不变（仍是「模型 → 哪个场景用哪个模型」），**无需改**，但验收时要跑一遍 `.AGENT\scripts\help-kb\verify-help-retrieval.mjs` 确认召回没塌。

## 4. 契约与文档同步

| 脚本 | 加什么 | 为什么现在测不出来 |
|---|---|---|
| `.AGENT\scripts\settings\verify-ai-tab-anchors.mjs` §8 | ① 常显白名单：除空态/警告/诊断外，视图里不得出现常显说明段（负向）；② 已删文案名单追加本轮新增项 | 现有 §8① 只认「`</h2>` 紧跟 `<p>`」这一种形态 —— chat/teach 那些 `<p>` 挂在 `<div>` 里，正好漏过去 |
| 同上，新 §10 | 每个折叠分组声明的 `anchorIds` 必须覆盖其内所有 `data-setting-anchor` | §3 是**扫源码文本**，锚点因折叠离开 DOM 它看不出来（这是真缺口） |
| `.AGENT\scripts\settings\verify-ai-views-disclosure.mjs`（新） | ① 三处 `⚡` 存在且都挂 `.kb-hoveronly`；② `Zap` 图标（不许 emoji）；③ 折叠组内层用 `.kb-collapse`；④ 常显白名单外说明段为 0 | — |
| 既有 `verify-llm-accounts.mjs` / `verify-llm-protocol.mjs` / `verify-ai-perms.mjs` / `verify-llm-attribution.mjs` | **不改，必须仍全绿** | 本轮零数据层改动，它们跑的是纯模块 |

## 5. 验证方式

1. 类型门禁：`npx tsc --noEmit -p tsconfig.node.json` 与 `npx tsc --noEmit -p tsconfig.web.json`（build 通过 ≠ 类型正确）。
2. 契约：上面 4 个既有脚本 + 2 个改/新增脚本，期望全 PASS。
3. 真机点验清单（`npm run dev`，dev 主进程无热重载 —— 只改 `src/` 则 HMR 够用）：
   - [ ] 六个页签首屏都能在**一屏内**看全分节，不出现「要滚才看到第二段」
   - [ ] 搜索框搜「图片视觉转写模型」→ 自动展开场景分配组 → 高亮到那一行（约束 1 的正向验收）
   - [ ] 搜「LibreOffice 路径」「单次抓取页数上限」两个落点都能滚到并高亮（原第三个落点
     「单次 maxTokens 上限」已随设置项在 2026-10-15 删除）
   - [ ] 供应商行 hover：⚡ / ⋯ / 开关都在，且**鼠标划过时行内元素不位移**
   - [ ] `Tab` 键走到供应商行：⚡ / ⋯ 同样浮出（`focus-within` 兜底）
   - [ ] 端点行 ⚡ → Toast 带延迟；账号行 ⚡ → Toast + 状态文字变「刚刚」；模型清单 ⚡ → 行内 ✓/✗
   - [ ] 去掉一个账号的 Key 后该端点 ⚡ 测试失败 → 行内/Toast 报错可读
   - [ ] 权限页某模块设「读写」→ 黄条出现（常显白名单②没被误收）
   - [ ] 断网/填错 Key：三处 ⚡ 都给出可读错误而不是静默
   - [ ] 亮色/暗色 + 至少一套第三方主题下，`.kb-hoveronly` 与 ⓘ 浮层可读

## 6. 明确不做（防范围蔓延）

- 不动 6 页签划分、`AiTab` 联合、`SETTINGS` 的 key/label/keywords/level（契约 §1/§9 锁着的）。
- 不动主进程 `llmService` / 账号迁移 / `llmAccountPure.ts`。
- 不动搜索打分（`sections.tsx` 的 `searchSettings`）。
- **不删 CC Switch 任何代码**（用户已定调：下个 minor 可能整体清理，本轮只做零耦合，见 §9）。它现在的导入弹窗是中央模态（按铁律 25 属「不该弹」的正例），**本轮不回改** —— 一条随时要退役的线，不值得先修一遍。
- 不动快捷键页（它是 `CollapseList` 的既有调用方，第 1 刀只允许「加参数、不改行为」）。

## 7. 风险与退路

| 风险 | 判据 | 退路 |
|---|---|---|
| 折叠把锚点带离 DOM，搜索跳转落空 | 点验清单第 2/3 条 | 该组改为不折叠（或内层常驻 DOM）——按分组粒度回退 |
| 悬停按钮不可发现 | 见 §8 已定 1 | 退到 C 形态（状态位常显「未测试」小字） |
| 行内展开区高度动画在长内容上卡顿 | DevTools Performance | 展开区不用动画直接出现（铁律 13 允许的例外情形需登记） |
| 同文件并行改坏（铁律 21） | grep 复核关键标识 | 同文件串行；每刀结束 `git diff --stat` 核对 |
| 手册与实现不同步（AI 照旧文档说错话且无报错） | `verify-help-retrieval.mjs` | 第 4 刀必做 |

## 8. 未定点 → 已定（2026-10-14，用户回复「都用你的建议」）

| # | 事项 | 定论 |
|---|---|---|
| 1 | 悬停测试按钮的**可发现性** | **B**：保存成功后该行动作常显 3 秒再回悬停。零常驻成本，且正好命中「刚配完、还不知道往哪悬停」那一刻。实现 = 保存成功给该行挂临时 `kb-hoveronly--peek` 类，3s 后摘除（`prefers-reduced-motion` 下只切类、不做过渡） |
| 2 | 供应商行右侧 `⚡ ⋯ 开关` 三件是否偏挤 | **保留开关**。启停要一眼可见，收进 ⋯ 会让「端点已停用」变成翻菜单才知道 |
| 3 | 场景分配表放哪个页签 | **留「模型」页折叠**。搬它要改契约 §6 与 4 篇手册路径，收益不抵风险 |
| 4 | 「＋ 添加供应商」形态 | **行内选择器**。不遮当前列表，与 DSH 同款 |
| 5 | 折叠组内层挂载策略 | **懒挂 + 跳转自动展开**（沿 `usePresence` 既有语义）。代价：跳转需播一次展开动画 |
| 6 | CC Switch 导入是否顺手行内化 | **不改**，且升级为整条线观察期 —— 见 §9 |
| 7 | 方案落码后是否归档 DesignProcess | 落码后按 `docs\DESIGN-ARCHIVE.md` 的规矩归档 |

## 9. CC Switch 线：观察期（2026-10-14 用户定调）

> 用户原话：「这样改之后，我们的软件可能都不太依赖 CC Switch 的配置了，我觉得 CC Switch 这条线都可以观望一下，可能下个版本就将这块代码给清理掉了。」

**本轮不删任何东西，只做两件事**：① 把入口收敛成一处（模型页只留「＋ 添加供应商」选择器里那一行，空态重复的半句删掉，顶部不再有第二个显眼的 CC Switch 按钮）；② 把退役盘点记在下面，下个 minor 决定摘除时照着清单走，不用重新考古。

### 退役盘点（2026-10-14 grep 全量实数）

| 层 | 位置 | 摘除动作 |
|---|---|---|
| 主进程 | `electron\lib\ccSwitchImport.ts`（147 行，整文件） | 删文件 |
| 主进程 | `electron\lib\ccSwitchPure.ts`（24 行） | 删文件；`ccSwitchProviderType` 被契约脚本直接 import（见下） |
| 主进程 | `electron\lib\llmService.ts:5,1592,1606-1610` | 删 import、`bindCcSwitchSaver(...)` 调用、两个 `ipcMain.handle('llm:ccswitch:*')`。**⚠ `saveProviderDraft` 是「IPC 保存」与「导入」共用的 —— 只删绑定点，别删函数**（它是 1523 行的那个） |
| 主进程 | `electron\types\sql-js.d.ts`（7 行） | 删（它只为读外部 SQLite 而存在） |
| 依赖 | `package.json:52` `sql.js` | 删依赖；AGENTS.md:28「真实调用只剩 ccSwitchImport」这句随之改写 |
| 桥 | `electron\preload\index.ts:433-434` | 删两个方法 |
| 桥 | `src\lib\ipc.ts:753-754` | 删两个封装 |
| 类型 | `src\types\index.ts:1139,2667-2668` | 删 `CcSwitchItem` / `CcSwitchScanResult` / `CcSwitchImportResult` 与 api 声明 |
| 界面 | `src\modules\settings\views\AiModelsTab.tsx:158-160`（入口按钮）、`1126-1232`（`CcSwitchImportModal`） | 删；选择器里那一行同时摘掉 |
| 文案 | `src\modules\settings\views\AiModelsTab.tsx:225-226`（空态） | **本轮已删**，届时零改动 |
| 文案 | `src\components\shared\AssistantPanel\ChatBody.tsx:860` | 改成「在 设置 → AI 里配置供应商」 |
| 文案 | `src\components\shared\Onboarding.tsx:118` | 去掉「支持 CC Switch 一键导入」 |
| 文案 | `electron\lib\kbStore\welcomeDoc.ts:749` | 去掉「装过 CC Switch 可一键导入」 |
| 测试 | `.AGENT\scripts\ai-teaching\verify-ccswitch-import.mjs`、`scripts\e2e-mcp-verify.cjs:370`（19b 段） | 删脚本 / 删用例 |
| 外部文档 | `readme.md:36`、`website\docs.html:273,284`、`CHANGELOG.md` 相关历史段 | readme / website 改写；**CHANGELOG 与 `electron\lib\releaseNotes\data.ts` 是历史记录，一字不动** |

### 摘除判定（满足其一即可排期）

1. 用户体感上确认「CC Switch 这条我不用了」（当前无埋点，不必等数据）。
2. 3.7.0 落地后一个版本周期内没有任何与 CC Switch 相关的反馈 / 求助。
3. 因别的理由要动 `sql.js` —— 那时这条线是唯一阻碍，顺手一起摘。

### 摘除时必须补的验收

- `sql.js` 出 `package.json` ⇒ 重跑 `npm install` + `npx tsc --noEmit -p tsconfig.node.json`（`sql-js.d.ts` 删了之后若有别处引用会立刻报错，这正是我们要的信号）。
- AGENTS.md:28「存储」一格的措辞要改（它是全仓唯一还提 sql.js 残留的地方）。
- `docs\ui-updates.md` 记一条；`resources\help\` 里若提到导入要跟着改，然后跑 `.AGENT\scripts\help-kb\verify-help-retrieval.mjs`。
- 删 `verify-ccswitch-import.mjs` 前先确认没有**别的**脚本 import 了 `ccSwitchPure.ts`（它被 `llmProtocolPure` / `skillPackPure` 的头注当先例引用，但那是注释、不影响）。

## 10. 收尾状态与遗留（2026-10-14 结项）

**四刀全部落地，五条结束判据全部有证据。**

| 判据 | 证据 |
|---|---|
| 两套 `tsc` 全过 | `tsconfig.web.json` / `tsconfig.node.json` 均 exit 0 |
| 既有契约仍全绿 | `verify-llm-accounts` · `verify-llm-protocol` 110 · `verify-ai-perms` · `verify-model-names` · `verify-image-tool` · `verify-ccswitch-import` 8 · `verify-shortcuts-table` 58 · `verify-mascot` 49 |
| 新增/加强的契约 PASS | `verify-ai-tab-anchors` **97 PASS**（§8② 判据已改）· 新增 `verify-ai-views-disclosure` **30 PASS** |
| 真机点验逐条过 | `tmp\probe-ai-models-v2.mjs` **43/43** + `tmp\probe-ai-tabs-v2.mjs` **38/38**，截图 18 张落 `tmp\probe-ai-shots\` |
| docs / help / CHANGELOG 同步 | `docs\ui-updates.md` 记流水 · `resources\help\AI 权限与工具边界.md` 重写且 `verify-help-retrieval` **142/142**（顺手把它 4009 → 达标，正文超长告警消除）· `CHANGELOG.md` 3.7.0 段 + `package.json` 3.7.0 + `build-release-notes.mjs` 已跑（`verify-release-notes` PASS） |

**两条遗留（都不是缺陷，是需要人来定的）**：
1. **连通性测试的"真调"没点**：三处 ⚡ 的存在、悬停包裹、行内结果渲染都验了，但**没有真的点下去** ——
   那会用你自己的 Key 发一次真实请求（花额度）。要确认端到端效果，请在真机上点一下；
   若要我代跑，说一声即可（会消耗一点额度）。
2. **只验了一套主题**：探针跑在你当前的主题（`plugin-knowbase-themes-collection-9`）下。
   `.kb-hoveronly` 与 ⓘ 浮层用的是 `var(--text-muted)` / `var(--bg-tertiary)` 这类既有令牌，
   换主题理论上无风险，但没实测。**亮色主题建议顺手看一眼**。

**未做（本轮明确不做）**：`docs\ai-settings-v2-plan.md` 与原型归档进 DesignProcess（跨仓操作，
按 `CLAUDE.local.md` 只在点名时做）；提交（未收到指令）。

**本轮踩到、值得记住的三条**：
- `data-setting-anchor` 必须**字面量**写在视图里（契约扫源码文本，走 props 传值两边都认不出来）；
- ⓘ 文案里**不许出现 §9 的口语别名**，**连注释里都不行**（负向断言扫全文，本轮就是注释里抄了一遍而写红）；
- 契约脚本里**不要用固定字符窗口**截取 JSX 段落内容（会溢出到下一个元素，制造大量假阳性）——
  要取到最近的 `</p>` 为止。

