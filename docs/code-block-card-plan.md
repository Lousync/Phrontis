# AI 回复代码块卡片 · 实现方案

> **状态**：口径已定（2026-10-13 两轮拍板）→ **已落码**（2026-10-13，见 §2.6 收尾与 §7-3 的 A/B 结论）。
> **原型**：`tmp/ai-code-card-proto/index.html`（代码块单点对照，含形态 A/B）；**`tmp/ai-chat-experience-proto/index.html`（2026-10-13 新增：整条 AI 对话体验，含本卡片、生成态、操作条、准备态、会话列表、两个面对照）**。两个原型都在 `tmp/`（已 `.gitignore`），几何结论都在它们上面用无头 Edge 实测过。
> **契约脚本**：`.AGENT/scripts/code-block-card/verify-code-block-card.mjs`（待建）。
> **本文档只讲怎么改**；需求怎么来的、以及被否掉的备选，见文末 §8「被否掉的备选」与 §9「与其它文档的关系」。

---

## 1. 已定口径（开发负责人在原型上逐项点选确认）

| 项 | 定论 |
|---|---|
| 生效面 | AI 教学对话流 · AI 教学侧车 · 全局助手面板。**工件栏 md 页签不挂** |
| 对象 | **仅 `pre` 兜底分支的普通代码块**（= 用户想原样复制走的纯文本）。`quiz` / `mermaid` / `plugin` / `spoiler` / `anim` / `schedule-preview` 一律不碰 |
| 形态 | **B 悬浮胶囊**：不画头部分界条、不画头部底色，整块成一个平面；语言标签浮**左上**且常显；操作按钮成**右上悬浮胶囊**（自身底色 + 描边 + 投影） |
| 胶囊内容 | **纯图标**（对齐参考图），语义靠 `title` |
| 显隐 | **悬停才现**：默认 `opacity:0`，卡片 `:hover` / `:focus-within` 时显现。**自动换行开着时也不常显**（2026-10-13 第二轮回拍板：不做 `html.is-wrap` 常显档 —— 机制上也做不到「只让换行那一个按钮常显」，因为父级 `opacity:0` 时子元素不可能更可见，只能整枚胶囊常显，代价大于收益） |
| 自动换行 | **全局设置项、默认关**；入口就在卡片胶囊里 |
| 折叠 | 超 **20** 行折到前 **12** 行；折叠态**右侧截断、不给横滚**；展开后横滚 |
| 卡片内字号 | **不写死**，跟随 `--md-code-size`（`0.875em`）⇒ AI 教学正文 16px 里是 **14px**、全局面板正文 12px 里是 **10.5px**（与真实 `MarkdownPreview` 的 `pre/code` 一致） |
| 复制 | 复制**纯源码** —— 不带 ` ``` ` 围栏、不带高亮 DOM |
| 行号 | **本轮不做** |
| 流式面 | 只给语言标签 + 复制，**不给折叠、不给自动换行** |
| ★ 连带改动 | **全局助手面板去掉助手侧外层气泡**（`MessageList.tsx` 第 175 行的 `px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border`）—— 否则代码卡片自带 `bg-[var(--bg-primary)]` + 边框，在这一面变成「框中框」。AI 教学本来就是平铺无气泡（P3a 去气泡），本轮把两个面拉齐 |

### 1.1 为什么「仅 `pre` 兜底分支」这个边界是干净的

`MarkdownPreview.tsx` 的 `pre` 覆写（第 189–221 行）已经在按 lang 分派特殊围栏，命中即提前 return：

```
spoiler / anim          → 折叠块 / 沙箱动画
quiz / json             → 判题卡片（宽容修复失败 → 占位卡）
schedule-preview        → 迷你周表卡
mermaid                 → MermaidBlock
插件渲染器命中           → 沙箱内容帧
—— 以上全部不经过卡片 ——
return <pre>{children}</pre>   ← ★ 卡片只挂这一行
```

⇒ **「用户真想复制走的东西」在结构上就等于兜底分支**，不需要额外判断。另有两点由 ai-teaching 侧在进渲染前排掉：` ```profile|plan|ask|outline ` 协议块被 `src/modules/ai-teaching/index.tsx` 第 3330 行的正则整段剥除；行内 `code`（单反引号）走 `code` 覆写的 `!isBlock` 早退分支，也不进卡片。

---

## 2. 改动清单

### 2.1 `src/components/shared/MarkdownPreview.tsx`（唯一含逻辑的改动）

**新增两个可选 prop，默认值保持既有行为**（19 处消费者零变化）：

```ts
/** 'plain'（默认）= 现状；'card' = 出代码块卡片 */
codeBlockChrome?: 'plain' | 'card'
/** 流式档：卡片仍在，但不出折叠（正文每个 token 都在重排，折叠按钮会跳位） */
streaming?: boolean
```

三处改动：

1. **`components` memo 里新增 `pre` 的卡片分支**：`codeBlockChrome === 'card'` 且**未命中任何特殊围栏**时，
   `return <CodeBlockCard lang={fenceLang ?? ''} source={extractText(children)} streaming={streaming}>{children}</CodeBlockCard>`
2. **`code` 覆写在卡片档下只跳过最后那段** —— 即「块级代码包一层 `div.relative` + 语言标签」那个 `return`，改为裸 `<code>`（chrome 全交给卡片）。**它上面的分支一个都不能动**：
   - ⚠️ `spoiler` / `anim` 两个分支**必须保留** —— `pre` 覆写对这两个 lang 返回的是 `<>{children}</>`（**不包 `<pre>`**，第 192 行），真正的渲染体就在 `code` 里。若在卡片档把 `code` 无条件改成裸标签，内容包的 ` ```spoiler-answer ` 折叠块会**直接坏掉**（AI 教学的内容包在用这个围栏）。
   - `!isBlock`（行内 `code`）分支同样保留。
   不进卡片档时，`code` **逐字保持现状**。
3. **新增模块内私有组件 `CodeBlockCard`**：
   - `source = extractText(children)` —— 复用文件内现成纯函数（第 397 行），它能把 rehype-highlight 拆出的 `<span class="hljs-*">` 树还原成纯文本。**这就是「复制纯源码」的实现方式**，别再写一份。
   - 行数 = `source.replace(/\n$/, '').split('\n').length`；`> 20` 时加 `is-folded`，`more` 按钮文案 `展开全部（共 N 行）`。
   - 本地 state 只有 `expanded` 一个。
   - 自动换行**不是**本地 state（它是全局偏好、所有代码块必须同步切换）—— 走 **`useSettings()`**（`src/lib/SettingsContext.tsx`）：读 `s.codeBlockWordWrap`、用 `update('codeBlockWordWrap', next)` 切换。**不要用 `getSetting()`**：那是 `src/lib/ipc.ts` 第 18 行的**异步**函数，塞进组件只能绕 effect，且仓库里它的既有用途都是「一次性取一个值」（`skipDeleteConfirm_*` 那类），不是持续订阅。
   - 语言标签：`lang || 'txt'`（无语言围栏显示 `txt`，保证头部高度一致）。
   - 复制按钮：写入成功后就地变 ✓（1.2s 复位），**不弹 Toast** —— 聊天流里每次复制弹一个右下角提示比不反馈更烦。复制失败仍走 `showToast({ type: 'error' })`。

### 2.2 `src/styles/index.css`

**新增**一批 `.kb-code-card*` 规则与 `.kb-code-card__acts` 显隐规则；细滚动条直接复用既有口径（第 1536–1548 行 `.kb-thin-scroll` 的那套 4px / 静止透明）。

**卡片内字号一律不写死**：`pre` / `code` 只写 `font-size: inherit`，让 `.prose-content code { font-size: var(--md-code-size) }`（第 336 行）去决定 —— 这样 AI 教学 14px、全局面板 10.5px 自动成立，和真实渲染逐像素一致。（写死 12.5px 会让 AI 教学里的代码比真实小一号，原型第一版就是这个错。）

**折叠高度必须把形态 B 的胶囊带算进去**（原型实测修正，见 §3-3）。**落码只落形态 B**
（形态 A 只作为原型对照存在，生产 DOM 里没有 `html.form-pill` 这一档），所以
`--kb-card-head-extra` 固定 = 20px：

```css
.kb-code-card__body { --kb-card-head-extra: 20px; }   /* 36px 上内边距 − 16px --md-pre-pad */
.kb-code-card.is-folded .kb-code-card__body {
  max-height: calc(var(--kb-card-fold-lines, 12) * var(--kb-code-line-h) * 1em + var(--md-pre-pad) + var(--kb-card-head-extra));
  overflow: hidden;
}
```

> ★ 折叠**行数**（12）不在 CSS 里再写一遍：由 JS 常量 `FOLD_SHOWN_LINES` 通过内联
> `--kb-card-fold-lines` 喂进来，CSS 只消费（回落值 12 兜底）。常量与样式各写一份迟早漂移。
> 折叠**阈值**（20）只在 JS 里（`FOLD_OVER_LINES`）—— 它决定「要不要出折叠按钮」，
> 本来就是渲染逻辑，不是几何。

**卡片内行高必须显式给**（`--kb-code-line-h: 1.55`）：折叠高度要按「12 行」算，而
`line-height: normal` 是**字体相关**的、写不进 `calc()`。代价是卡片内行距被统一成 1.55，
跨三个面一致 —— 此前中栏继承 `normal`、全局面板继承 `leading-relaxed`(1.625)，
本来就各不相同。**不要**为了不改行距而把 `normal` 留在卡片里：那样折叠高度只能写死 px，
而写死 px 正是 §3-3 实测两头都错的那条路。

**严禁改动**这一条（19 处消费者的代码块样式全挂在它上面，且写作面即时渲染档共用）：

```css
:is(.prose-content, .kb-md-atom) pre { … }   /* 第 340–344 行，一个字都不动 */
```

CSS 需覆盖的状态：形态 B 的定位上下文与浮层、`:hover` / `:focus-within` 显现、纯图标隐藏 span、折叠态的 `max-height` 与 `overflow:hidden`、`prefers-reduced-motion` 兜底。

**去气泡那一层**（`MessageList.tsx` 第 175 行）要删的 5 个类：`bg-[var(--bg-secondary)]`、`border border-[var(--border-color)]`、`rounded-lg`、`px-3 py-2`、`mr-6`；连带把操作条的 `mr-6` 换成 AI 教学那套 `-ml-1.5`（否则操作条与正文左缘错开约 12px）。**必须保留**：`select-text`（`body` 全局 `user-select:none`，删了消息选不中）、外层 `group/msg`（操作条 `group-hover/msg` 的宿主）、`data-msg-id`（会话大纲定位的选择器）、`[&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:…` 那组宽内容安全网、`.kb-l1` / `.kb-l2` 容器查询标记。

### 2.3 `src/lib/settings.ts`

新增一个 entry（**沿用既有扁平 camelCase 命名**，仓库里是 `assistantThinking` / `aiShowThinking` / `ctxUsageDetail` / `ctxWindow` 这种，不用点号）：

```ts
codeBlockWordWrap: { default: false, type: 'toggle', label: '代码块长行自动换行', group: '对话输出', desc: 'AI 回复里的代码块长行自动换行（也可在代码块右上角胶囊里随时切换）', keywords: [...], section: 'aiTools', ui: false, scope: 'global', level: 'normal', affects: 'live' },
```

> ⚠️ **schema 以落码时的 `settings.ts` 为准，不是 `{ value, description }`。** 起草时（2026-10-13 早些时候）
> 这个文件还是旧 schema；同日的「AI 设置按域重排」那一轮已把它换成
> `default` + `type` + `label` + `group` + `desc` + `keywords` + `section` + `ui` + `scope` + `level` + `affects`
> （+ 可选的 `anchor` / `aiTab` / `min` / `max` / `unit`）。照旧 schema 写会直接**编译不过**
> （`SettingsValue<K>` 取的是 `default`）。落码时已按新 schema 落。

**不加 `ui: true`、不给 `anchor`、不进设置搜索** —— 入口就在卡片胶囊上，设置页再开一条会让两处状态入口不一致。若后续要进设置页，再补 anchor + `data-setting-anchor`。

### 2.4 各渲染面的接线（各一行，共 5 处）

> 下表的行号是起草时（2026-10-13）读到的位置，**`ai-teaching/index.tsx` 正在被另一个对话改动，落码前以实际为准**；其余文件均干净，行号可靠。

| 文件 | 位置 | 传什么 |
|---|---|---|
| `src/modules/ai-teaching/index.tsx` | 第 3329 行 `MarkdownPreview` | `codeBlockChrome="card"` |
| `src/modules/ai-teaching/SideLanePanel.tsx` | 第 306 行 | `codeBlockChrome="card"` |
| `src/components/shared/AssistantPanel/MessageList.tsx` | 第 176 行 | `codeBlockChrome="card"` **＋ 删掉第 175 行的助手气泡那 5 个类**（见 §2.2 末段） |
| `src/components/shared/AssistantPanel/StreamBubble.tsx` | 第 157 行 | `codeBlockChrome="card" streaming` |
| `src/modules/ai-teaching/ArtifactsPane.tsx` | 第 160 行 | **不传**（工件栏 md 页签按文档渲染） |

### 2.5 契约脚本（已建）

`.AGENT/scripts/code-block-card/verify-code-block-card.mjs` —— **66 条断言全绿**。断言表：

> 几何类条款在脚本里验的是「公式与结构」而非实测像素：精确性已在原型上用无头 Edge 量过
> （`tmp/ai-code-card-proto` / `tmp/ai-chat-experience-proto`），生产侧只要保证
> 「同一套公式 + 同一条优先级关系」就等价，而这两件事都是静态可验的。
> 脚本里刻意用「取单条规则正文」的方式解析 CSS（`ruleOf`），不用 `[\s\S]{0,N}?` 跨规则找 ——
> `.kb-code-card__body {` 之后紧跟着的就是 `.kb-code-card__body pre {`，跨规则找会假阳性（实测踩到）。

1. **折叠几何**：四种宽窄 × 换行组合下都是精确 12 行（`firstVisibleLines === 12`，溢出 ≤ 1px），**形态 A 与形态 B 都要跑**（B 少算 20px 就只露 11 行 —— 原型第二版实测到的真 bug，见 §3-3）；
2. **折叠态裁切**：`__body` 是 `overflow:hidden`，且 `max-height` 表达式里**不含滚动条 px 补偿**（`--kb-card-head-extra` 是形态补偿，不是滚动条补偿，两者别混）；
3. **滚动容器位置**：`overflow-x:auto` 在 `pre` 上、**不在** `__body` 上；
4. **悬浮胶囊不压代码**：`pill.bottom <= firstCodeLine.top`；
5. **悬停才现**：基态 `opacity:0`；`:focus-within` 可显现；`opacity:0` 的按钮**仍可 Tab 聚焦**（这条是键盘可达性的唯一保障）；**自动换行开着时仍是 `opacity:0`**；
6. **纯图标**：该模式下标签 `span` 的 computed `display === 'none'`；
7. **窄栏不撞**：侧车 320px 下胶囊与语言标签的间隙 > 0；
8. **语言标签**：在左上、常显；无 lang 围栏显示 `txt`；
9. **复制内容**：行数等于源码行数、**不含 ` ``` `**、首行未被截断；
10. **边界**：`codeBlockChrome` 默认档渲染出的 DOM **不出现** `.kb-code-card`（= 19 处消费者零变化）；
11. **生效面**：三个面都传了开关、`ArtifactsPane` 没传；
12. **卡片内字号跟随正文**：`getComputedStyle(pre).fontSize === 0.875 × 正文 fontSize`（AI 教学 14px / 全局面板 10.5px）；
13. **去气泡**：`MessageList` 渲染出的助手消息容器**不含** `bg-[var(--bg-secondary)]` / `border` / `rounded-lg` / `px-3 py-2` / `mr-6`，且仍含 `select-text` 与 `group/msg`。

### 2.6 收尾（按 `AGENTS.md` 工作流）

- **版本**：**留在 3.5.0，不抬号**。起草时写的是「抬到 3.6.0」，那是基于一个错判（以为 v3.5.0 已发版）。
  实际核对：`gh release list` 最新是 **v3.4.1（2026-10-07）**，git tag 里也**没有** `v3.5.0` ——
  也就是 `CHANGELOG.md` 的 v3.5.0 段（含 10-13 新增的「AI 设置按域重排」子段）是**未发版的当前线**。
  按 `AGENTS.md` 的「新功能抬到下一个 minor，修复进当前线」：当前线 = 3.5.0 ⇒ 本轮改动进 3.5.0 段。
  抬到 3.6.0 会凭空跳过一版、留一个永远发不出去的 3.5.0。
- **CHANGELOG.md** 在 v3.5.0 段内补子段 + 重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`（铁律 24，忘跑不报错但页面停上一版）。
- **AI 手册同步**（新功能 ⇒ 用户可见行为变化）：`resources/help/` 里讲 AI 教学对话的篇目需补「代码块悬停出操作、可一键复制、可切自动换行、超长会自动折叠」。具体篇目落码时点，验收跑 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs`。
- **类型门禁**：`npx tsc --noEmit -p tsconfig.node.json` 与 `-p tsconfig.web.json`（build 通过 ≠ 类型正确）。

---

## 3. 落码必须遵守的硬约束（每条都是原型阶段实测踩出来的）

1. **宿主必须 `min-width: 0`。** 卡片放进 flex / **grid** 容器时，容器项默认 `min-width:auto` = 内容最小宽度，超长行会把轨道撑开 —— 原型里第 1 节两栏被撑到 **743px**、整页横向溢出。
   ★ 且**把 overflow 放进卡片内部解决不了**（先试过，数字一点没变）：`overflow` 只影响 flex/grid 项自身的 `min-width:auto`，不改变块级内在尺寸的上溯。
   **当前三个生效面不受影响**（已核）：`MessageList.tsx` 的列表容器是 `… space-y-2` 的普通块（第 169 行），`ai-teaching` 同样是纵向块级；块级盒只铺满包含块、不反过来撑宽它。但消息流哪天改成 grid / flex-row 排布，这里就是第一个炸的地方。
2. **横向滚动容器放在 `pre` 上**，不要放在卡片 body 上。语义更直（滚动条落在代码块自身底边），且与 §3-1 的宿主约束配合更稳。
   ⚠️ 附带一条**优先级**注意：`MessageList.tsx` 第 175 行的助手气泡上挂着 `[&_pre]:overflow-x-auto [&_pre]:max-w-full` 这类 Tailwind 任意变体，落到 DOM 上就是 `.\[\&_pre\]\:overflow-x-auto pre`（特异性等同本方案的 `.kb-code-card__body pre`）。**本项目自定义 CSS 写在 `@layer` 之外（无层级），Tailwind 工具类在 `@layer utilities` 里，无层级胜出** ⇒ 我们的规则会生效。若哪天把卡片样式也塞进 `@layer`，这条就会反过来，届时气泡的 `overflow-x:auto` / `max-w-full` 会盖住卡片规则。
3. **折叠高度不许夹带固定 px 补偿 —— 但必须夹带形态补偿。** 两件事分清楚：
   - ❌「+12px 补滚动条位置」实测**两头都错**：没有水平滚动条时漏出第 13 行 12px；有滚动条（15px）时反而**盖住第 12 行**、只剩 11 行完整。滚动条宽度在两态之间是 0 / 15px，CSS 无从得知 ⇒ 折叠态直接 `overflow:hidden` 截断，展开后才横滚。
   - ✅ 形态 B 的胶囊带是靠 `pre` 的 `padding-top: 36px` 撑出来的，比 `--md-pre-pad`（16px）多 **20px**；折叠 `max-height` 若只写 `12 行 + --md-pre-pad`，第 12 行会被裁掉（2026-10-13 第二版原型用无头 Edge 实测：`clientHeight 264` vs 需要 `283.5`，实际只露 **11.03 行**）。所以高度写成 `12 行 + --md-pre-pad + --kb-card-head-extra`，由形态变量提供那 20px。
   - ⇒ 验收判据统一为「`__body.clientHeight === 12 × lineHeight + pre.paddingTop`」，形态 A/B 都跑这一条。
4. **隐藏态用 `opacity`，不用 `visibility` / `display`。** `opacity:0` 的元素**仍可 Tab 聚焦**，键盘用户 Tab 进来触发 `:focus-within` 即可显现；换成 `visibility:hidden` 会把按钮移出 Tab 序 ⇒ **键盘永远够不到复制**。同时隐藏态**保留占位**，悬停时语言标签不位移、头部不抖（与 `.kb-thin-scroll` 注释里「宽度保留，不因出现/消失引起内容回弹」同一条理由）。
5. **纯图标靠隐藏 `span` 实现**（与「图标 + 文字」共用同一套 DOM 与 `title`），不要写两套按钮。
6. **细滚动条走 `.kb-thin-scroll` 那套口径**（4px、静止全透明、宽度保留），已在 `index.css` 第 1536–1548 行。
7. **动效遵守铁律 13**：只动 `transform` / `opacity` / `grid-rows`。折叠切换**不做高度补间**（`max-height` 过渡不在允许清单里），改「类切换 + 整块透明度淡入」；全部带 `prefers-reduced-motion` 兜底。
8. **纯图标下 `title` 必须齐全** —— 「自动换行」那个折行箭头图标光看图认不出来，`title` 是它唯一的语义来源。
9. **`CodeBlockCard` 依赖 `useSettings()` ⇒ 必须在 `SettingsProvider` 内**（`SettingsContext.tsx` 第 47 行会 `throw`）。Provider 挂在 `src/main.tsx` 根部，三个生效面都在其内，没问题；但这条约束意味着**卡片档不能在没有 Provider 的环境里开**（探针里手搓 HTML、或将来别的独立渲染面）。
10. **接受首帧的一下翻转**：`s` 的初值是 `SETTINGS_DEFAULTS`，真实值要等 `getAllSettings()` resolve（即 `ready`）。所以「用户把自动换行设成开」时，代码块会先按「不换行」渲染、随后翻转成换行。**不 gate `ready`** —— 否则所有代码块都要等设置加载完才肯渲染，代价更大。另外 **不要**在 `update` 里补 `dataNotify`：那条通路是给 `theme` / `zoom` / `editorFont` 做跨窗口同步的（`SettingsContext.tsx` 第 34 行），折行只影响渲染层自己。
11. **卡片内字号不写死 px，跟随 `--md-code-size`（`0.875em`）。** 真实渲染里 `pre/code` 拿的就是这个值：AI 教学正文 16px ⇒ 代码 14px，全局面板正文 12px ⇒ 代码 10.5px。写死 12.5px 会让 AI 教学里的代码比真实小一号（原型第一版就是这个错，第二版已改）。同时 `--kb-code-line-h` 保持 `em`，折叠高度才会跟着字号缩放。
12. **去气泡时那 4 样一个都不能顺手删**：`select-text`（`body` 全局 `user-select:none`，删了整条消息选不中）、外层 `group/msg`（操作条 `group-hover/msg:opacity-100` 的宿主）、`data-msg-id`（`[data-assistant-variant="page"] [data-msg-id="…"]` 会话大纲定位）、`[&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:block [&_table]:overflow-x-auto` 这组宽内容安全网。删了都不会报错，只会静默坏掉。
13. **形态 B 的胶囊带是固定 px、卡片字号是 em** ⇒ 窄栏（全局面板 10.5px 代码）里 36px 的带子会显得偏厚。这是设计取舍不是 bug，但**验收时要专门看一眼全局面板里的卡片**（原型 `tmp/ai-chat-experience-proto` 的「面 = 全局助手面板」档就是给这个用的）。
14. **卡片内行高必须显式给**（`--kb-code-line-h: 1.55`）—— `normal` 进不了 `calc()`，而折叠高度必须能从行数算出来。副作用（卡片内行距统一）见 §2.2 末段。
15. **卡片样式必须留在 `:is(.prose-content, .kb-md-atom) pre` 之后**：两者特异性相同（1 类 + 1 元素），本项目自定义 CSS 又都在 `@layer` 之外 ⇒ 靠「后来者胜」。位置一挪到前面，卡片里的 `pre` 会再套一层边框 / 底色 / 圆角 / 投影（框中框）。契约脚本有一条断言锁这个前后关系。

---

## 4. ★ 冲突与落码时序（本方案最大的执行风险）

起草时（2026-10-13）`git status` 显示**另一个对话正在改**这四个文件：

```
 M src/components/shared/AssistantPanel/index.tsx
 M src/components/shared/AssistantPanel/useAssistantChat.ts
 M src/lib/settings.ts          ← 本方案 §2.3 要加一行
 M src/modules/ai-teaching/index.tsx   ← 本方案 §2.4 要加一行
```

**同日复查（第二轮拍板后）多出一个**：`M src/styles/index.css` ← 本方案 §2.2 要加一批规则。同一时段还看到 `M src/components/workbench/WorkbenchPageBar.tsx` / `M src/components/workbench/PageTabStrip.tsx` + 新增 `src/components/workbench/useStripScroll.tsx`，即**另一个对话正在做页面条溢出的 F-16**，与 `index.css` 的改动同源。⇒ 步 1 的两个目标文件里，`index.css` **已经不再干净**，必须等那一轮落库；`MarkdownPreview.tsx` 仍是干净的（最后改动 2026-10-12）。

**仍未在改动清单里（可随时动）**：`MessageList.tsx`、`StreamBubble.tsx`、`SideLanePanel.tsx`、`ArtifactsPane.tsx`。

而铁律 21 明确：**同一文件禁止并行编辑**，并行会静默互相覆盖、工具却回 "Successfully edited"。

⇒ **分三步落码**（注意 `settings.ts` 卡在第一步之前，不能往后放）：

| 步 | 内容 | 前置条件 |
|---|---|---|
| **0** | `settings.ts` 加那一行 entry | **等另一个对话把 `settings.ts` 落库**。只有一行新增，但它不落，第一步就过不了类型 —— 组件里读 `s.codeBlockWordWrap`，而 `s` 的类型是 `AppSettings = { [K in SettingsKey]: SettingsValue<K> }`（`settings.ts` 第 349–355 行），**key 不存在就是编译期报错**，不是运行时兜底 |
| **1** | `MarkdownPreview.tsx` + `index.css` + 新建契约脚本 | 步 0 完成，**且 `index.css` 那轮（F-16 页面条溢出）已落库**。做完不影响任何既有渲染（默认档零变化） |
| **2** | `MessageList.tsx`（含去气泡）/ `StreamBubble.tsx` / `SideLanePanel.tsx` 接线（三个文件都干净） + `ai-teaching/index.tsx` 接线 | 前两个文件随时可动；**`ai-teaching/index.tsx` 要等另一个对话落库** |

每一步动手前先重跑 `git status` 确认目标文件已干净；**改完 grep 复核关键标识**（铁律 21 的收尾要求）。

> 若另一个对话愿意顺手加 `settings.ts` 那一行（它就是一行，且与在改的内容无关区段），可以直接跳到步 1 —— 但那必须由**同一时刻只有一个写入方**来保证，不能两边同时改。

---

## 5. 验收口径

- 契约脚本全绿（§2.5 的 13 条）；
- `npx tsc --noEmit` 两个 project 零新增错误；
- 真机眼看四处：对话流里悬停出胶囊、Tab 能聚焦到隐藏按钮、折叠展开往返、**全局面板里卡片不再套在气泡里**；
- 回归确认：知识库阅读态、博客预览、帮助中心的代码块**外观与改动前逐像素一致**（这几处都不传 `codeBlockChrome`）；
- 对照原型：`tmp/ai-chat-experience-proto/index.html` 的 10 个场景断言全绿（`_static_check.py` 53 条 + `_probe.py` 382 条），可作为落码后的回归基线。

---

## 6. 明确不做（本轮）

- **行号** —— 与「自动换行」在纯 CSS 下互相破坏：折行后一个逻辑行占多个视觉行，而 CSS 生成的行号 gutter 仍按逻辑行数走，必然错位。要做就得把高亮结果按行拆成独立元素（跨行 span 在切分点两侧复制祖先链），属另一件工程。
- **`…` 溢出菜单** —— 胶囊里目前只有两项（自动换行、复制），不需要溢出。要加时基建现成：`src/lib/useAnchoredMenu.ts`（锚点翻折 + clamp + portal 到 body），F-2「菜单被边缘截断」就是靠它修的。
- **写作面同步** —— `src/components/shared/LiveMarkdownPane.tsx` 的 `CodeBlockWidget` 不动。本方案只在预览侧按开关生效，写作面维持现状（代价：写作面与 AI 回复的代码块外观分叉，但两者本来就是不同场景）。

---

## 7. 拍板结果（2026-10-13 第二轮，三处全部有答案）

1. **自动换行开着时胶囊要不要常显？** ⇒ **不常显**，仍只悬停显现。
   你选的是「最干净」那档：胶囊永远只在悬停时出现。代价是换行开着时用户看不出「为什么行被折了」—— 但换行是**用户自己在卡片胶囊里开的**，他知道入口在哪，所以这个代价可以接受。**方案里因此不写 `html.is-wrap .kb-code-card__acts { opacity:1 }`**（原先倾向要，已改）。
2. **折叠态长行：右侧截断还是强制换行？** ⇒ **右侧截断**（原型现行为）。
   高度精确到 12 行、不丢「前 12 行」的语义、也不跟全局换行偏好打架。折叠态**不给横向滚动条**，展开后才有横滚。
3. **全局助手面板的「框中框」** ⇒ **去掉外层气泡，与 AI 教学统一**（`MessageList.tsx` 第 175 行）。
   ★ 连带一个**只剩一处的子选择**（原型第 2 节可现场切换，右列那三个按钮）：
   - **改后 A · 仅助手侧平铺**（改动最小）：只删助手气泡。但用户气泡仍是全局面板那套（`bg-[var(--bg-selected)]` + 满宽 `ml-6`），于是变成「深蓝条 + 平铺正文」的混合体 —— 原型截图里能直接看出这个不协调。
   - **改后 B · 两面都对齐**（推荐）：用户气泡也换成 AI 教学那套（`bg-[var(--accent)]` + 右对齐 + `max-w-[86%]`），两个面完全一致。代价是动了用户气泡的样式（多删 4 个类、多 3 个类）。
   ⇒ **落码取 B（2026-10-13 落码时定）**：用户气泡换 `bg-[var(--accent)]` + 右对齐 + `rounded-xl rounded-br-sm` + `max-w-[86%]`，两个面完全一致。
   ★ 与原型的一处**有意差异**：字号**不**从 12px 抬到 AI 教学那档的 13px —— 全局面板整条排版尺度低一档（正文 12px / 消息间距 8px），单独把用户气泡抬成这一面最大的字反而更不协调。原型的 `mode-align` 用的是 `font-size:13px`，落码时按「只统一风格、不统一字号」处理。
   顺带：助手操作条的 `mr-6` 换成 AI 教学那套 `-ml-1.5`，消息下方的 `TraceBlock` 也去掉了 `mr-6`（否则去气泡后它与正文右缘错开 24px）。

---

## 8. 定稿前被否掉的备选（留档，避免重复调研）

| 备选 | 为什么没选 |
|---|---|
| 形态 A（30px 头部分界条 + 文字按钮） | 已实现并实测通过，作为对照保留在原型里；最终选了 B（更像参考图、且首行比 A 还高 10px） |
| 「+12px 补滚动条」的折叠高度 | 实测两头都错（见 §3-3） |
| 把 overflow 挪进卡片内部以阻止撑宽 | 实测无效（见 §3-1） |
| 智能折叠/行号 | 见 §6 |
| 自动换行开着时常显胶囊（`html.is-wrap … { opacity:1 }`） | 2026-10-13 第二轮拍板否掉：机制上只能整枚胶囊常显（父级 `opacity:0` 时子元素不可能更可见），换行又是用户自己开的，不值得为它牺牲「界面常净」 |
| 「接受框中框」（`MessageList` 气泡保留） | 2026-10-13 第二轮拍板否掉：AI 教学本来就是无气泡平铺，两面不一致比多改一层更贵 |
| 胶囊直接压在代码首行右侧（ChatGPT 那套） | 更紧凑，但会盖住首行行尾；选了「占同等高头部带、不画底色」 |

---

## 9. 与其它文档的关系

- 需求来源与逐轮对话中的取舍，见两个原型同目录的实测报告：`tmp/ai-code-card-proto/_report.json`、`_static_report.json`、`shot_measure.png`；`tmp/ai-chat-experience-proto/_report.json`、`_static_check.py`（53 条静态契约）、`_probe.py`（10 个场景 / 382 条浏览器断言）、`shots/*.png`。
- 本条是**新功能**，不进 `docs/v3.4.0-feedback.md`（那份只收正式版体验反馈 / 落差；同日在它那里登记的是页面条溢出的 `F-16`，与本方案无关）。
- 动效令牌与工具类遵循 `docs/ui-animation-plan.md`；冗余说明文字遵循 `docs/help-disclosure-pattern.md`；「去气泡」与 AI 教学的 P3a 口径一致（见 `docs/ai-teaching-module-rework.md`）。
- **同一轮讨论的另一半（生成态加载样式）见 `docs/ai-reply-loading-plan.md`** —— 那条动 `StreamBubble.tsx`，与本方案只在 `index.css` 上有交集，两份方案互不阻塞。
- **`tmp/ai-chat-experience-proto/index.html` 是「整条 AI 对话体验」的现状基线**：它把 AI 教学中栏（16px 正文 / 12px 消息间距 / 常显操作条 / 准备态 / 会话列表）与全局助手面板（12px 正文 / 8px 间距 / hover 操作条 / 抽屉）两套真实版式并排复刻，版式数值来自 2026-10-13 的源码盘点（`ai-teaching/index.tsx`、`AssistantPanel/{MessageList,StreamBubble}.tsx`、`index.css`）。**后续任何 AI 对话相关的改动，先在这个原型上改、再落码。**
