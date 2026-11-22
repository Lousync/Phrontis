# 设置 → AI → 模型：按原型重做（实现方案）

> 原型：`/home/lousync/桌面/Phrontis-设置模型页-原型-2026-11-20.html`（用户已确认）
> 范围：**只重排版与样式**。模型条目的增删改 / 精选 / 能力三态 / 上下文窗口 / 测试连接 /
> 供应商账号与 Key / 场景分配 8 槽的行为与 IPC 调用一律不动。
> 日期：2026-11-20

---

## 1. 现状取证

### 1.1 页面骨架

| 位置 | 现状 | 与原型的关系 |
|---|---|---|
| `src/modules/settings/index.tsx` | 两栏：左导航 `w-48` 常驻；右栏顶部 `px-6 pt-4 pb-2` 放 `SettingsSearchBox`，内容区 `py-6` + `max-w-2xl px-6` | 原型 320 宽时隐藏左导航（`.stage[data-vp="320"] .snav { display:none }`），右栏 padding 收到 12px。仓库窗口 `minWidth: 900`，窄宽只在 devtools 模拟下出现 |
| `src/modules/settings/views/AiToolsView.tsx:148-186` | 页签行是普通 `<button>` 数组，无 `role="tablist"` / `role="tab"` / `aria-selected`；`px-3 py-2 text-[13px] border-b-2 -mb-px`；复位按钮 `ml-auto mb-1` | 原型要求 `role="tablist"` + `role="tab"` + `aria-selected`，高度 34px、hover 有底色、图标激活变强调色 |
| `src/modules/settings/components/SettingsSearchBox.tsx` | 用「背景层 div 画框 + 透明 input 叠在上面」的等价写法（不是 `.kb-field`）；下拉只有「热门设置」标题、无结果计数；清除按钮 `p-1`（约 21px） | 原型：`.kb-field` + `.kb-field-control` 单道框、清除按钮 22px、下拉有头（热门 / 搜索结果 + 共 N 项）与尾（↑↓ 选择 / ↵ 跳转 / Esc 关闭） |

### 1.2 模型条目（`ModelCatalogSection.tsx`，约 760 行）

- 根 `max-w-2xl`；`SectionHead` 标题「模型条目」+ 三个按钮（统一为条目 id / 从现有配置导入 / 添加条目）
  —— `SectionHead` 的标题行不换行，320 宽会被三个按钮顶出横向溢出。
- 本地搜索（第 239-248 行）：外层 `div` 自己画 `border + bg-[var(--input-bg)]`，内部 `<input>` 只加了
  `outline-none`。全局 `input` 自带 `1px` 边框 ⇒ **当前就存在「框中框」**（`docs/input-field-pattern.md` §6 反例）。
- 条目容器：`rounded-lg border bg-[var(--bg-secondary)]`，行间 `border-t`。
- 条目行三层信息被压成两行且都在一条 flex 里：单选圈（`w-3 h-3`）、名称（下划线式输入，聚焦才出线）、
  ★、精选开关（带文字标签）、删除；第二行 `pl-[20px]` 内同时塞「供应商 · modelId（`truncate`）+ 5 个能力 chip +
  上下文（原生 token 的 `number` 输入，82px）+ 测试按钮 + 结果文本（`truncate max-w-[42%]`）」。
  ⇒ 窄宽时 modelId 被省略号截断、测试结果被当成一行正文、上下文口径是「token」而原型是「千 token + K」。
- 测试：`out` 只有 `{ ok, text }`，行内显示一行彩色文字；没有「结果胶囊 + 展开详情」。
- 删除：直接调用 `llmCatalogRemove`；被引用时返回 `refs`，再渲染「改派到另一个条目」行内卡。

### 1.3 供应商（`AiModelsTab.tsx:302-430`）

- 行头：`px-3.5 py-2.5` + chevron + 6px 圆点（仅启用色/禁用灰）+ 名称 + 类型徽标 + 摘要（`truncate`）+
  ⚡（`.kb-hoveronly`）+ ⋯ 菜单 + 开关（md）。
- 正文列宽被 `max-w-md`（448px）夹住，原型是内容列全宽（672px）。
- 展开区（编辑器）里所有输入框走 `inputCls`（`border-[var(--border-color)]`）。

### 1.4 场景分配（`AiModelsTab.tsx:268-283` / `SceneTable`）

- `SettingsGroup`（组头：chevron + 标题 + 摘要 + ⓘ）+ 卡片内 8 行「标签 116px + `AiModelPicker` + 未纳入条目
  徽标 + 测试结果 + 测试按钮」。
- 同样被 `max-w-md` 夹窄；`AiModelPicker` 触发器边框取 `--border-color`。

### 1.5 现状里必须保持的东西

1. `data-setting-anchor`：`aiTools.scenes` / `aiTeach.visionModel` / `aiTools.imageModel` /
   `aiTools.imageEditModel` 必须仍然以**字面量**出现（`verify-ai-tab-anchors.mjs` 按文本扫描）。
2. `SETTINGS` 的 `ui: true` + `anchor` + `aiTab` 三元组不动；`sections.tsx` 的 `ENTRY_ITEMS` 不动（`aiTools.models` 仍由
   `AiToolsView` 包一层渲染）。
3. 所有 IPC：`llmCatalogSave / SetDefault / Test / Remove / AdoptRefs / Migrate / ListProviders`、`setSettingRaw`、
   `llmListProviders / llmTestModel / llmVisionModels / llmSaveProvider / ...` 一个不删、参数不改。
4. 校验口径 `validateSaveInput`、引用文案 `refsText`、排序 `sortEntries`、过滤 `filterEntries`。
5. 披露契约：`AiModelsTab.tsx` 里常显 `<p>` 只能命中
   `.AGENT/scripts/settings/verify-ai-views-disclosure.mjs` 的白名单（本页只保留「该端点没有可用账号」与
   「尚未配置供应商」两条）。**不新增常显段落**；新增说明一律走 `HelpHint` 悬停。
6. `.kb-hoveronly` 的悬停显形与 `is-peek` 口径（同一脚本 §3 断言）。

---

## 2. 目标（逐块对应原型）

| 原型块 | 落地口径 |
|---|---|
| **全局搜索** | `SettingsSearchBox` 改 B 形态：外壳 `.kb-field`（36px / 8px 圆角 / 10px 内边距）+ 搜索图标 + `.kb-field-control` + 22px 清除钮（`aria-label` / `data-tip`）；焦点只在外壳。下拉加头（热门设置 / 搜索结果 + 共 N 项）与尾（↑↓ / ↵ / Esc，保留 Tab 补全提示）。`Esc` 有文字即清空，空文字关下拉，再按失焦 |
| **页签行** | `role="tablist"` + `role="tab"` + `aria-selected`；34px 高、icon + 文字、激活项强调色下划线 + icon 强调色、hover 淡底、`-mb-px` 压线；复位按钮 26px |
| **模型条目头** | 本地 `<h2>模型条目</h2>` + 计数徽标（`entries.length`）+ 三个按钮（`flex-wrap`，320 不溢出）+ 常显一句 hint（原型 `sechint`，与「标题后紧贴说明」的契约不冲突——该契约只扫 AI 五视图） |
| **本地搜索** | `.kb-field` + `.kb-field-control` + 22px 清除钮；右侧「N 条 / N / M 条」计数（`aria-live="polite"`）+ 帮助入口（复用 `HelpHint`，替代原型的 `?` 气泡：浮层必须走 portal，避免窄宽被裁） |
| **条目行三层** | ① 单选圈 + 名称（默认无框、hover 淡底、聚焦才出强调色框与 2px 光环）+ ★ + 精选开关 + 删除；② `供应商 · modelId`（**`overflow-wrap: anywhere` 换行，不省略号**）；③ 5 个能力 chip + 弹性留白 + 上下文（`.kb-field kb-field-sm`，千 token + `K` 后缀）+ 测试按钮 + 结果胶囊 |
| **测试状态胶囊** | 测试完成才有胶囊：成功 `812ms`（绿点）/ 失败 `失败`（红点）+ chevron；点开详情：成功「连接正常 · 延迟 · 模型 · 测试不写回条目 · 重测」，失败「测试失败 · 原始错误 · 重试 / 复制错误」。进行中显示禁用的 `测试中` 胶囊（转圈）。折叠用 `.kb-collapse`；胶囊按钮 `aria-expanded` |
| **供应商行** | 行头改为：chevron + 状态点（可用绿 / 有端点无可用账号黄 / 停用灰，带 3px 弱光环）+ 名称 + 类型徽标 + 摘要（`flex-1`，窄宽换行而不是顶出）+ ⚡（悬停显形）+ ⋯ + 开关。删除 / 改默认 / 刷新模型仍走 ⋯ 菜单（行为不变）。正文列改为内容列全宽 |
| **场景分配** | 保留 `SettingsGroup`（组头 = 原型 `.group-head`）；场景卡片全宽，行 = 标签 132px + 选择器（flex-1）+ 未纳入条目徽标 + 测试；说明仍走 ⓘ（不新增常显段落） |
| **320px** | 所有行 `flex-wrap` + `min-w-0`；长 model id 换行；控件宽度上限 ≤ 容器；面板内不出现横向滚动条。设置左导航在 `<480px` 隐藏（原型同款），右栏 padding 收到 16px |

---

## 3. 文件级改动清单

### 3.1 `src/styles/index.css`（令牌 + 少量工具类）

- `:root` 新增 `--field-border: color-mix(in srgb, var(--border-color) 78%, var(--text-primary) 22%)`
  （深色下 ≈ `#5a5a5a`，比 `#3c3c3c` 的框线可见但不抢眼）。
- `html.theme-light` 新增 `--field-border: var(--border-color)`。
- `html.theme-daycycle` 新增 `--field-border: color-mix(in srgb, var(--border-color) 55%, var(--text-muted) 45%)`
  （昼夜主题的 `--border-color` 带 alpha，直接混 `--text-primary` 会过淡）。
- 新增 `.kb-field.kb-field-strong { border-color: var(--field-border); }` —— 放在 `.kb-field` 与
  `.kb-field:focus-within` **之间**，保证聚焦时仍由 `:focus-within` 的强调色覆盖（同权重靠源序）。
- 新增 `.kb-field-sm`（28px 高 / 8px 内边距 / 4px 间距 / 7px 圆角；内部控件 11.5px、右对齐、等宽数字）。
- 新增 `.kb-field-input { border-color: var(--field-border); }`（A 形态单控件用；`input:focus` 的
  元素+伪类权重更高，聚焦仍变强调色）。
- **只在本次改到的控件上挂 `.kb-field-strong` / `.kb-field-input`**。全局 `.kb-field` / `input` 的边框不改：
  深色下「输入框框线不可见」是全仓现状，全局替换会把所有页面的观感一起改掉且回归面巨大 —— **全局铺开需另行确认**。
- 不新增任何过渡：沿用 `.kb-field` 已有的 `border-color / box-shadow` 过渡与动效令牌。

### 3.2 `src/modules/settings/components/SettingsSearchBox.tsx`

- 外壳改 `.kb-field kb-field-strong`（36px / 圆角 8 / `px-2.5` / `gap-[7px]`），内部 `<input>` 加
  `.kb-field-control`（去掉原来的背景层 div 与 `border-transparent` 内联）。
- 幽灵补全文本改为覆盖在 input 容器内（`absolute inset-0` + 同样的 13px/行高），仍 `aria-hidden`。
- 清除按钮：22×22、`rounded-[5px]`、`data-tip="清除"` + `aria-label="清除搜索"`、`onMouseDown` 阻止失焦。
- 下拉：加头（`热门设置` / `搜索结果` + `共 N 项`）与尾（`↑↓ 选择` / `↵ 跳转` / `Tab 补全`（有补全时）/ `Esc 关闭`）；
  面板沿用现有 `border + bg-secondary + shadow-lg`（不进折叠容器，无需 `AnchoredLayer`）。
- `Esc`：有查询 → 清空；无查询且下拉开 → 关；否则失焦。

### 3.3 `src/modules/settings/index.tsx`

- 左导航：`w-48 shrink-0 ... flex flex-col` → 追加 `max-[479px]:hidden`。
- 搜索区 padding：`px-6 pt-4 pb-2` → `px-4 min-[480px]:px-6 pt-4 pb-2`。
- 内容区：`py-6` + `max-w-2xl px-6` → `py-6` + `max-w-2xl px-4 min-[480px]:px-6`，外层 `min-w-0`。

### 3.4 `src/modules/settings/views/AiToolsView.tsx`

- 页签容器加 `role="tablist" aria-label="AI 设置页签"`；每个按钮加 `type="button" role="tab" aria-selected={tab === id}`；
  样式改 `h-[34px] px-2.5 gap-1.5 text-[13px]`，激活 `border-[var(--accent)] text-[var(--text-primary)]` 且 icon
  `text-[var(--accent)]`，非激活 hover 底色 `bg-[var(--bg-hover)]/60`。
- 复位按钮：`h-[26px] px-2.5 rounded-[7px] text-[11.5px]`，两态色沿用（确认态红）。

### 3.5 `src/modules/settings/views/ModelCatalogSection.tsx`（主改）

- 头部：弃用 `SectionHead`（它不支持标题行换行），改本地 `sechead`（`h2` + 计数 + 按钮组 `flex-wrap`）；
  三按钮改为原型尺寸（`h-7` / `px-2` / `text-[11.5px]`，主按钮 `bg-[var(--accent)] text-white`）。
- 本地搜索：`.kb-field` + `.kb-field-control` + 条件清除钮 + 计数 + `HelpHint`（能力三态 / 上下文千 token / 星标 / 精选口径）。
- 条目卡片：外层 `rounded-[10px] border bg-secondary overflow-hidden`；行 `flex items-start gap-[9px] px-3 py-[11px]`。
- 条目行拆三层（见 §2）。名称输入：`border-transparent bg-transparent hover:bg-hover focus:bg-input
  focus:border-accent focus:shadow-[0_0_0_2px_color-mix(...14%)]`，`h-[26px] rounded-md`；能力 chip / 上下文 /
  测试胶囊按原型尺寸（20px / 28px / 22px）。
- 上下文：`value = contextWindowToK(entry.contextWindow)`，后缀 `K`，`title = contextWindowTitle(...)`；
  `blur` / `Enter` 提交，解析走 `parseContextWindowK`（空 = 清空为 `null`；非法 → Toast + 还原）；
  `save({ contextWindow })` 语义不变。
- 测试：`out` 扩为 `{ ok, latencyMs?, error?, at }`；`runTest` 仍只调 `llmCatalogTest(entry.id)` 并把结果留在行内
  （**不写回条目**）；胶囊开合 `detailOpen`；失败详情「重试 / 复制错误」（`copyText`），成功详情「重测」。
- 删除：沿用既有「直接删 → 被引用才拦截 → 行内改派」流程（不改语义），只把卡片样式对齐原型 `.del-confirm`。
- 空态：虚线卡 + 图标圆 + 标题（含搜索词）+ 副标题 + 「清空搜索」按钮。

### 3.6 `src/modules/settings/views/modelCatalogUiPure.ts`

新增（全部纯函数，零运行时依赖）并补契约：

- `contextWindowToK(tokens?)` / `contextWindowTitle(tokens?)`
- `parseContextWindowK(raw)` → `{ ok: true, tokens: number | null } | { ok: false, reason }`
- `nextCapabilityState(cur)`（auto → yes → no → auto）
- `testPillLabel(outcome)` / `testTimeText(at, now)`
- `entriesCountText(shown, total, query)`

### 3.7 `src/modules/settings/views/AiModelsTab.tsx`

- 供应商正文列去掉 `max-w-md`（全宽）；`SectionHead` 标题行保持（`hint` 悬停）。
- `ProviderRow` 行头按 §2 重排：状态点三态（绿/黄/灰 + 光环）、类型徽标、摘要 `flex-1 basis-[120px] truncate`、
  ⚡/⋯/开关顺序与行为不变；容器加 `kb-hoveronly-host`（已有）与 `flex-wrap`。
- `p.usable` 警告文案与位置不动（白名单）。
- `inputCls` 追加 `.kb-field-input`（本页 A 形态输入统一用 `--field-border`）。
- 场景区：`SettingsGroup` 去掉 `max-w-md`；`SceneTable` 改全宽卡片（`rounded-[10px]` / `px-3` / 行 `py-1.5`）；
  `SceneRow` 标签 `w-[132px]`，选择器 `min-w-0 flex-1`。
- 不新增常显 `<p>`；已有段落逐字保留。

### 3.8 `src/modules/settings/views/AiModelPicker.tsx`

- 触发器是 A 形态单控件（`docs/input-field-pattern.md` §7 已登记），边框改挂 `.kb-field-input`
  （只影响本页场景表；全仓只有 `AiModelsTab` 使用它）。

### 3.9 契约脚本

- `.AGENT/scripts/ai-teaching/verify-model-catalog-ui.mjs`：import 新纯函数，新增 §8（千 token 往返、非法输入、
  能力循环、胶囊文案与时间、计数文案）。
- 新增 `.AGENT/scripts/settings/verify-model-page-rework.mjs`：锁本轮结构口径 ——
  `--field-border` 在 `:root` / 浅色 / 昼夜三处都有；`.kb-field-strong` 定义在 `.kb-field:focus-within` 之前；
  三处搜索/窗口控件用 `.kb-field` + `.kb-field-control`（无框中框：内部控件不带 `border-[` 类）；
  页签 `role="tab"` + `aria-selected`；改到的四个视图里没有 `transition-all`；`data-setting-anchor` 四个字面量仍在。

---

## 4. 取舍（沿用原型默认，记下「为什么」）

1. **能力标签 5 个常显、点一下循环**：沿用现有三态与保存语义；`auto` 虚线、`yes` 实线绿、`no` 删除线。
   不改成下拉 —— 行已经很密，下拉会多一层且看不到当前状态。
2. **上下文窗口按千 token 显示 + `K` 后缀**：只改**展示口径**，落盘仍是 token 整数
   （`contextWindow = K × 1000`），并保留小数 K（如 `100.5`）以免回写时篡改原值。
3. **测试结果放行尾胶囊、点开展详情**：结果本来就不写回条目（B11），因此它只在本会话内存在；
   胶囊让「失败」在行上可见而不占一行正文，详情承载原始错误与重试。
4. **名称默认无框、聚焦出框**：条目名称是「内容」不是「表单字段」，常驻框会让每行都长出四个边框；
   聚焦/悬停才提示它可编辑。
5. **默认条目保留单选圈、不加胶囊**：原型同样用 radio 表达；加「默认」胶囊会与「精选 / 免费」徽标抢注意力。
6. **删除仍走「先删、被引用才拦截」**：原型是「点删除 → 展开确认卡」，但仓库现有语义是直接删、被引用时返回
   `refs` 再改派。改流程等于改行为与 IPC 时序，超出「只重排版」的范围 —— 保留现有流程，只对齐卡片样式。
7. **供应商行保留 ⋯ 菜单**：原型行头没有 ⋯，但「获取模型 / 手动添加 / 设为默认端点 / 删除端点」只在这里，
   砍掉等于删功能。⋯ 常显、⚡ 悬停显形（其他动作收进菜单）与披露契约一致。
8. **场景说明继续走 ⓘ**：原型在卡片下方有一句常显说明；本页的披露契约不允许新增常显段落，且这句是
   「留空如何跟随」的机制说明 —— 放在 ⓘ 里一字不删。
9. **窄宽隐藏左导航**：原型 320 舞台就是这么做的。桌面窗口最小 900px，实际不会触发；只为满足
   「320 下不横向溢出」的验收口径。
10. **全局铺开 `--field-border` 需另行确认**：本次只给模型页的输入控件挂类，避免把其它页面的边框观感
    一起改掉（深色下很多输入框现在其实也「看不见框」）。

---

## 5. 风险与验证

| 风险 | 处理 / 判据 |
|---|---|
| 设置搜索失效（anchor 被包进条件渲染 / 表达式） | 四个 `data-setting-anchor` 保持**字面量**且始终渲染；`node .AGENT/scripts/settings/verify-ai-tab-anchors.mjs` |
| 深链 / 自动展开（场景组、生图两槽） | `SettingsGroup.anchorIds` 原样保留；`verify-ai-tab-anchors.mjs` §6/§6.1 |
| 常显文案长回来 | 不新增 `<p className="...text-[1x]">`；`verify-ai-views-disclosure.mjs` 全绿 |
| 输入框「框中框」 | 三处组合控件全部 `.kb-field` + `.kb-field-control`；新增脚本负向断言内部控件无 `border-[` |
| 深色框线不可见 | `--field-border` 独立令牌 + `.kb-field-strong` / `.kb-field-input`；浅色与昼夜各一支；用户肉眼复核 |
| 320 横向溢出 | 全部行 `flex-wrap` + `min-w-0`；model id 换行；控件固定宽 ≤ 78/86px；设置左导航窄宽隐藏；用户肉眼复核 |
| **`.kb-field` 外壳漏写 `flex`** | `.kb-field` 只画边框/背景、**不写 display**（调用方负责 flex，与 `docs/input-field-pattern.md` §3.1 的例子一致）。漏了 `flex items-center` ⇒ 容器变 block，内部 input 的 `flex-1` 变死属性、后缀 `K` 掉到框外（2026-11-20 真机截图复现）。已由 `verify-model-page-rework.mjs` 对 `src/modules/settings/**/*.tsx` 做静态断言，每条 `className` 里独立的 `kb-field` token 必须同时含 `flex` 与 `items-center` |
| 键盘操作 | `role="tab"` / `role="switch"` / `role="radio"` + `aria-checked` / `aria-selected`；胶囊 `aria-expanded`；图标按钮 `aria-label` + `data-tip`；`Esc` 清空、`Enter` 提交后失焦 |
| 动效 | 只用 `.kb-pop` / `.kb-item-in` / `.kb-collapse` / `.kb-chevron` / `.kb-view-fade`；禁 `transition-all`；只动 transform / opacity / grid-rows |
| 数据语义 | 所有 IPC 参数与调用点不动；`contextWindow` 落盘仍是 token；测试仍不写回 |
| 类型门禁 | `npx tsc --noEmit -p tsconfig.web.json` / `-p tsconfig.node.json` |
| 纯逻辑回归 | `.AGENT/scripts/ai-teaching/verify-model-catalog-ui.mjs`（新增用例） |

**需要用户肉眼确认**：① 深色主题下三处输入框（全局搜索 / 本地搜索 / 上下文）框线是否「可见但弱」；
② 320px（devtools 模拟）下模型条目、供应商行、场景行是否横向溢出；③ 深色下测试失败胶囊与红框详情卡；
④ 名称输入聚焦态与 `K` 后缀在 900 / 1200 两种宽度下的观感。
