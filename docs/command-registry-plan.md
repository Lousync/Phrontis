# 指令表真源化（L1）+ 命令面板增强（L2）技术方案

> 状态：**进行中**（2026-10-13）。**P0 + P1 已落地**（拍板 **B1**：真源覆盖全部有键位的命令，设置页 42 → 61 行 / 11 组），流水见 `docs/ui-updates.md` §45。**P2（手册表格生成）与 P3（命令面板增强）未做。**
> 前置：设置 → 快捷键「指令表」的逐行对账已完成并落库（提交 `4c58ea5`，流水 `docs/ui-updates.md` §44）。
> 对账原型与 58 条命令底账：`E:\Projects\KnowledgeRecorder\tmp\command-registry-proto\index.html`（本地工作区，不进 git）。
> **A1 / C1** 采纳为默认（面板门控隐藏 / 手册只生成表格区），P2/P3 开工前如无异议即按此执行。

## 1. 要解决什么

现在「同一批键位」在**四个地方各写一遍**，四份已经开始互相漂移：

| # | 位置 | 现状 | 谁在用 |
|---|---|---|---|
| 1 | `src\modules\settings\views\ShortcutsView.tsx:47-121` | 手写 42 行 · 9 组 · 组锚 `shortcuts.*` | 设置 → 快捷键页 |
| 2 | `src\modules\settings\sections.tsx:139-158` | 手写 9 条（id / group / desc / keywords） | 设置搜索索引 |
| 3 | `resources\help\键盘快捷键.md` | 手写 11 张表 · 102 行 | AI 的 `builtin.help.search`（`electron\lib\helpService.ts:40` 读盘） |
| 4 | `src\App.tsx:393-440` | `buildEmptyHints()` 三条带键位 + `buildCommandItems()` 16 条（11 模块打开 + 5 界面设置）**全都不带键位** | 空态提示 / 命令面板 |

漂移的实证（本次对账查出、已修的那一批就是它）：`Ctrl+Shift+S` 是死键却长期挂在表里；`Ctrl+Shift+F` 代码里存在而表里整条缺失；密码本 `Ctrl+Alt+P` 声称「可在设置改键」但该设置项不存在。

**目标**：键位与命令信息有**唯一真源**；上表四处（含「约 18 行存量缺口」与手册）由它派生或与它对齐；并把「撞车」变成机器可查的规则（本次 `Ctrl+O` 撞车是人工发现、改键收场的）。

**非目标**：不改任何键位行为（除已拍板的 `Ctrl+Alt+O`）；不做「密码本真正可改键」；不重构 `CommandPalette` 的视觉与动效令牌。

## 2. 真源设计

### 2.1 文件与命名

新增 **`src\lib\commandRegistry.ts`**（零依赖：不 import React / DOM / electron / 其他业务模块，只允许 `import type`）。

命名取舍：`src\lib\shortcuts.ts` **已存在**，是运行期按键闸门纯函数（`isEditingInput` / `allowsWorkbenchShortcut`），不是清单 —— 真源另起名字，别混。`commands.ts` 会与已有的 `src\lib\chatCommands.ts`（聊天斜杠命令）在语义上撞车，故取 `commandRegistry.ts`。

放置理由（与铁律 24 的 `electron\lib\releaseNotes\judge.ts` 同一手法）：**零依赖 + 可被 Node 脚本直接 import**。本仓 42 个契约脚本已用 `node --experimental-strip-types` 直接 import `.ts`（见 `.AGENT\scripts\release-notes\verify-release-notes.mjs:17,28-32`），所以生成器与契约不需要 esbuild、不需要打包（本机沙箱下 esbuild 拉子进程会 `EPERM`，绕开它是有实际收益的）。本机 Node v24.16.0。

★ 硬约束：真源只能写**可擦除语法**（不能有 `enum` / `namespace` / 构造函数参数属性 / 装饰器），否则 strip-types 直接抛错。

### 2.2 数据形状

```ts
export interface CommandGroup { id: string; label: string; anchor: string }   // anchor = 'shortcuts.global'
export interface CommandDef {
  id: string              // 稳定 id：绑定表、契约、面板 recents 都用它
  label: string           // 命令面板里的短名（沿用现文案）
  desc: string            // 指令表里的说明列（沿用现文案）
  keys: string[][]        // 逐枚键帽；多组 = 同效（即现有 Row 的 alts）
  group: string           // → CommandGroup.id
  scope: CommandScope     // 生效范围：global | note | pdf | image | blog | schedule | system
  palette: boolean        // 是否作为可执行命令出现在命令面板
  sources: string[]       // 代码锚，如 'src/App.tsx:304'；只存在于手册的写 'doc'
  note?: string           // 已知取舍（原样保留 §44 头注里的那几条判据）
}
export const COMMAND_GROUPS: CommandGroup[]
export const COMMANDS: CommandDef[]
```

四条设计取舍：

1. **`label` 与 `desc` 两个文本字段都留** —— 面板要短名（「AI 助手」），指令表要带范围的说明（「AI 助手开关（工作台右栏；整窗模块下为悬浮助手）」）。迁移时两列都按现状原文抄，**零文案回归**，不趁机重写。
2. **`scope` 是撞车规则的输入**（不是装饰）：同 scope 内同键 = 冲突（契约 FAIL）；跨 scope 同键 = 合法但必须显式登记（这正是 PDF 缩放 vs 界面缩放的关系，见 §2.3）。
3. **图标不进真源** —— JSX 不可序列化。真源只存 `id`，渲染层留一张 `id → lucide 组件` 的小映射表（空态三条现在是内联 JSX，改查表）。
4. **`run` 不进真源** —— 动作要 React 状态。真源只说「有这么条命令、可面板执行」，App 侧留一张 `id → run` 绑定表，契约做**双射检查**（有声明必有绑定、有绑定必有声明）。这条是防漂移的核心。

### 2.3 已被代码解决的先例（真源要把它表达出来）

`src\App.tsx:1296-1301` 里有一段**行内作用域仲裁**：

> 作用域仲裁（2026-09-20 反馈「界面缩放和页面缩放冲突」）：正在书架里读 PDF 时，这组快捷键归阅读器页面缩放（PdfReaderView 自行处理），全局界面缩放让位

判据是 `bookshelfReading && activeTab === 'bookshelf' && (key === '=' | '+' | '-' | '_')` → `return`。

也就是说「`Ctrl+=` 在 PDF 里归 PDF、在别处归界面」这条知识，今天**只活在一段 if 里**，而指令表把两者当成两条独立行。真源化后它应当表达为：`pdf-zoom-in` 的 `scope='pdf'`，`zoom-in` 的 `scope='global'`，两 scope 关系在契约里锁死（跨 scope 同键必须两边都登记 scope 且存在仲裁判据）。**这也把本次 `Ctrl+O` 那类撞车从「人工发现」变成「机器可查」。**

## 3. 消费方改造

### 3.1 设置页 `ShortcutsView.tsx`

`Row` / `Group` 组件保留（渲染与锚点语义不变），数据来源换成遍历 `COMMAND_GROUPS` + `COMMANDS`。渲染必须与现状**逐字等价**（含 `data-setting-anchor`、键帽 chip 的 class 与 `min-w-[20px]`），否则设置搜索的定位与滚动会回归 —— 契约 §3 用真组件 SSR 比对。

### 3.2 搜索索引 `sections.tsx:139-158`

9 条 `shortcuts.*` 的 `id` / `group` 由真源生成（组数、组名、顺序三者对齐）；`desc` / `keywords` **保持手写**（检索排序的第一杠杆，见 §44 记的「keywords 也会抢别人的分」那件事，自动生成会打坏排序调优）。契约断言：真源组集合 ↔ `sections.tsx` 的 `shortcuts.*` 集合 = 双射。

### 3.3 AI 手册 `resources\help\键盘快捷键.md`

**只在表上做生成，不做全量生成。** 用标记包裹：

```md
## 知识库

<!-- GEN:keytable group=kbTabs -->
| 快捷键 | 功能 |
|--------|------|
| `Ctrl` `N` | 新建知识页（文件树内联命名，落点跟随选中目录） |
<!-- /GEN -->
```

- 生成器：`.AGENT\scripts\commands\build-shortcuts-doc.mjs`（写盘）/ `--check`（生成到内存比对，不一致非零退出并提示重跑）—— 与铁律 24 的「生成 + 比对」同款。
- **为什么不全量生成**：该篇的 frontmatter `keywords` 与各节散文（「历史是全局单条、最多 50 条」这类）是给人看、且调过检索排序的；全量生成会把它们冲掉。表是数据、散文是文案，只生成数据。
- 标记契约：真源每个组 id 在篇中**恰好出现一次** `GEN:keytable`（漏组 / 孤儿标记都 FAIL）。
- 篇中现存的组名（「笔记顶栏（页面历史）」「日程与打卡小窗」）与设置页组名不同：**节标题与散文留手写**，表由 `group=<id>` 决定，因此不需要强行统一命名。

### 3.4 命令面板与空态提示 `App.tsx`

- `buildEmptyHints()` 的三条改为「按 id 查真源取 label/keys + 查本地图标表」，文案与键位不再各写一份。
- `buildCommandItems()` 里与真源重合的部分改为真源派生；**插件命令**（运行时数据，`pluginCommands`）与**模块打开项**继续走它自己的通道（真源不管插件）。
- 面板行获得**键帽显示**（真源带来的直接好处：以前面板根本不知道键位）。

## 4. L2：面板增强

`src\components\shared\CommandPalette.tsx` 现状（已核）：

| 现状 | 位置 | 问题 |
|---|---|---|
| `label/hint/group` 子串 `includes` 过滤，无评分无排序 | `:47-55` | 输「gzk」找不到「工作台」；结果顺序 = 声明顺序 |
| 无最近使用 | — | 高频命令每次都要重敲 |
| `items` 无键位字段 | `PaletteItem:12-18` | 面板不知道快捷键（真源落地后即可填） |
| 无上下文门控 | `buildCommandItems()` | 在设置页里仍然列出「打开 设置」；PDF 命令在笔记里也列出 |

改动：

1. **模糊匹配提为纯函数** `src\lib\fuzzy.ts`（`subsequence` + `score`，从原型搬）。放 lib 是为了**能被契约直接单测**（Node strip-types 直接 import），不必起浏览器。
2. **最近使用**：`localStorage`（键 `kb.palette.recents`，只存 id 数组，上限 8）。理由：纯渲染层状态、不需要跨进程，不值得进 `SETTINGS`（那是配置真源）。面板顶部出「最近使用」组。
3. **上下文门控**：App 计算一个 `PaletteContext`（`activeTab` / `inWorkbench` / `zenLevel` / `openTabs` / 编辑档位 / 阅读器类型），与真源的 `palette: true` 条目一起过门控。门控条件**建议写成声明式字段**（如 `requires?: { tabs?: string[]; workbench?: boolean; reading?: 'pdf' | 'image' }`）而不是函数：可序列化、可在契约里用上下文矩阵穷举、不会藏闭包状态。
4. 保持既有动效令牌（`kb-overlay` / `kb-modal-in` / `kb-item-in`）不动。

## 5. 契约计划

新增 `.AGENT\scripts\commands\verify-commands-registry.mjs`：

| 组 | 断言 |
|---|---|
| §1 结构 | id 唯一 · `group` 都指向存在的组 · `keys` 非空且键帽 token 在白名单（`Ctrl`/`Shift`/`Alt`/`Esc`/`F2`/`←`/`空格` 等，防 `Ctr` 这类错字）· `sources` 非空 |
| §2 双射 | 真源 `palette: true` 的 id ↔ `App.tsx` 绑定表双向完备（漏绑定 / 幽灵绑定都 FAIL） |
| §3 渲染等价 | 真组件 SSR：行数 == 真源条数 · 每组锚点齐全 · 键帽 chip 数与分隔符正确（沿用 `tmp\shortcuts-view\render-check.mjs` 的 esbuild+SSR 手法，搬进契约） |
| §4 手册同步 | 跑生成器比对 `键盘快捷键.md`（不一致 FAIL 并提示重跑）；标记双射 |
| §5 搜索索引 | 真源组 ↔ `sections.tsx` 的 `shortcuts.*` 双射 |
| §6 撞车 | 同 scope 同键 = FAIL；跨 scope 同键 = 必须两边都声明 scope，且**全局侧存在让位判据**（当前即 `App.tsx:1301`）—— 把 §2.3 的仲裁锁住，防它被删掉 |
| §7 手册内容 | 「写作面 / 图片查看器 / PDF 缩放」等组的键位与代码锚一致 |

存量 `.AGENT\scripts\settings\verify-shortcuts-table.mjs`（54 项）：**不删**。§44 那 8 组「内容判据」（死键复查、`Ctrl+O` 不再被博客占用、密码本不实承诺等）继续由它守；结构类断言（行数 / 组数）移交给新契约，避免两处各说一遍。其中两条是**翻转标记**，L1 落地时必须翻转而不是删：

- `H8`（`:215`）全局仍缺 `Ctrl+Shift+J` / `Ctrl+Alt+B` / `Ctrl+Z` —— 补齐后翻转为「必须存在」
- `H9`（`:217`）写作面 8 键、图片查看器 4 键未进设置页 —— 同上

## 6. 落地顺序（每步独立可验，未过不进下一步）

| 步 | 内容 | 验 | 状态 |
|---|---|---|---|
| P0 | 加 `commandRegistry.ts`（内容搬原型底账，逐条复核 `sources`）+ 契约 §1/§6 | tsc 双端 · 新契约绿 | **已完成**：11 组 / **61 条**（B1 比原型 58 条多出博客 `Ctrl+Alt+O` 等）· 63 个代码锚全部可解析 |
| P1a | **方案外新增的一步**：旧契约（`verify-shortcuts-table.mjs`、`verify-perception.mjs`）原本**文本解析** `ShortcutsView.tsx`，设置页改数据驱动后必然误报 ⇒ 改指真源 | 两个契约全绿 | **已完成**：54 → 58 项（A9/A10 新增、H8/H9 翻转 + H9c）· perception J12 三项改指真源后 235/235 |
| P1b | 设置页改读真源 + `sections.tsx` 组同步（9 → 11 条）+ 渲染等价契约 | 契约 §5 · 渲染 43/43 · 真机目测 | **已完成**：42 → 61 行 / 11 组 |
| P2 | 手册表格改生成区 + 生成器 + 契约 §4/§7 | 生成器 `--check` 绿 · 检索契约全绿（keywords 未动，排序不应变化） | **已完成**：10 处标记 / 61 行恰好各一次 · 手册补「PDF 阅读器」「密码本」两节 · 检索 109/109、结构警告 16 条不变 |
| P3 | L2：`fuzzy.ts` + 面板接真源（键帽 / recents / 门控）+ 契约 §2 双射 | `fuzzy` 单测 · 真机面板双向实测 · 动效令牌未新增 | 未做 |

> §3「渲染等价」已在 P1b 落地（`verify-commands-render.mjs`）：期望值**由真源投影得到**，所以它同时管住「组件把真源渲染错」与「真源改了渲染没跟上」两头。
> §2「`id → run` 双射」仍是 P3 的活 —— 绑定表本身是 App 侧产物（要 React 状态），P0/P1 阶段还没有它，先写就是一条对着不存在的表做断言的假断言。

版本：L1+L2 属**新功能**，按口径抬 `3.5.0`（当前 `package.json` 已是 3.5.0，本批并入该线，不单独抬）。

## 7. 需拍板（三条）

**A. 面板怎么处理「只在某处才有意义」的命令**（§4.3）
- **A1（推荐）** 列出全部 + 声明式门控，不满足时**隐藏**。理由：Obsidian 的做法；隐藏不干扰；「找不到某命令」由 L1 的指令表兜底（它成为完整参考）。
- A2 不满足时**置灰 +「当前不可用」**：可发现性更好，代价是列表变长、噪声多。
- A3 只列全局可用命令（约 20 条）：最简单，但面板价值锐减。

**B. 真源覆盖范围**
- **B1（推荐）** 覆盖**全部有键位的命令**（原型底账 58 条）。设置页 42 行 → 约 58 行 / 11 组，副标题「所有可用的键盘快捷键一览」才名副其实；这些键位手册里本来就有，属对账缺口而非新增声明；H8/H9 得以翻转。
- B2 只覆盖现在表里那 42 行：改动最小，但「所有可用的」继续不实，H8/H9 只能继续挂着当缺口标记。

**C. 手册生成粒度**
- **C1（推荐）** 只生成表格区（§3.3），散文与 keywords 手写。
- C2 全量生成该篇：源单一度最高，但会冲掉调优过的检索 keywords（§44 记过 keywords 抢分的实例），检索排序有回归风险。

## 8. 风险与退路

| 风险 | 退路 |
|---|---|
| 设置页数据驱动后渲染与现状不等价 → 设置搜索定位回归 | 契约 §3 逐项比对；P1 单独成步，可单独回退 |
| 真源用了不可擦除语法 → 契约脚本直接 import 失败 | §2.1 硬约束 + tsc 双端门禁 |
| 手册生成器在沙箱里跑不动 | 生成器是纯 Node 文件读写，不拉子进程、不依赖 esbuild |
| 一个 58 条的真源要逐条复核 `sources` | 原型底账已核过一轮（含 `src` 锚与 `drift` 标记），P0 以「锚仍指向预期代码」为验收，不重做考古 |
| 跨 scope 同键的仲裁判据被后人删掉 | 契约 §6 锁（当前锚 `App.tsx:1301`） |

## 9. 明确不做

- 不把插件命令收进真源（运行时数据，`src\lib\pluginCommandBus.ts` 通道不变）。
- 不做「密码本真正可改键」（新功能，另开）。
- 不统一设置页键帽（`<span>`）与空态键帽（`<kbd>`）的 DOM —— 本次只搬数据来源，样式统一属独立小改。
- 不改 `Ctrl+Alt+O` 之外的任何键位；不改「工作台」按钮的 no-op 语义。
