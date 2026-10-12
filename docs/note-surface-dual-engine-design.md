# 双写作面：源码档 / 即时渲染档（设计文档）

> 状态：**已落码**（2026-10-09，v3.5.0 线）。方案与实现同批，验证见 §7。
> 需求口径（开发负责人 2026-10-09）：「让现在的输入手感保留，同时用户也能进行选择」+「切档后光标在上一次结尾处」+「编辑区右键要有同款唤出菜单」+「我直接体验最后的结果即可」（不要中间档、不要原型）。

## 1. 定位与不变量

笔记正文有两个**对等**的写作面，用户自己选：

| 档位 | 引擎 | 语义 |
|---|---|---|
| **源码**（默认） | Monaco（既有实现） | Markdown 原文 + 标记淡化。**行为一行未改** |
| **即时渲染** | CodeMirror 6 | 非光标块按排版渲染；**光标所在块回源码** |

不变量照旧：`.md` + frontmatter 是唯一真相源；正文唯一写方是编辑器；渲染层只传 `{rootId, relPath}`。引擎只吐 `onChange`，**保存 / 冲突检测 / 广播刷新链路完全复用**。

三条自我约束（防「为了统一抽象而削弱现状」）：
1. 源码档代码路径保持原样，只把**纯逻辑**（候选规则 / 附件取回 / 动作表）抽出去共用；
2. 不为「平滑过渡」做中间档、不做跨档状态搬运（撤销栈跨引擎不可合并，只记光标位置）；
3. 同一 `relPath` 同一时刻**只挂一个引擎**（双写会互相覆盖保存）。

## 2. 架构

```
PageEditor（知识库就地编辑）
  └─ NoteSurface（宿主：按设置二选一 + 右键菜单 + 光标记账）
       ├─ MonacoPane        （源码档；同时是博客编辑器 / 归档文本 / 导图的宿主，未受影响）
       └─ LiveMarkdownPane  （即时渲染档；lazy 加载，CM6 不进首屏静态闭包）
```

| 文件 | 职责 |
|---|---|
| `src/lib/noteEngine.ts` | 写作面契约 `NoteEngineHandle` + 切档光标记忆（按「文件 × 档位」） |
| `src/lib/noteActions.ts` | **动作表**：菜单树 + 动作实现（零 DOM 依赖，可被契约脚本直接跑） |
| `src/components/shared/NoteSurface.tsx` | 宿主：档位二选一、契约转发、右键菜单、光标恢复 |
| `src/components/shared/NoteContextMenu.tsx` | 右键菜单渲染（两档共用同一棵树） |
| `src/components/shared/LiveMarkdownPane.tsx` | CM6 即时渲染档 |
| `src/lib/wikiLinkSuggest.ts` | `[[` 候选规则（缓存/匹配/排序/截断）——两档共用一处真相 |
| `src/lib/attachmentImage.ts` | 仓库相对附件取回（阅读态与编辑器内联图片共用一份缓存与归一化） |

设置项：`editorWritingMode`（`source` / `live`，设备级，默认 `source` —— 默认不改现有手感），入口 `设置 → 编辑器 → 写作模式`。**非 Markdown 文档一律回落源码档**（即时渲染只对 Markdown 有意义）。

## 3. 即时渲染档实现要点

- **文档模型始终是 Markdown 原文**（真相源不变）；渲染靠 CM6 装饰：
  - 行级样式：标题（含 setext）、引用条、代码块底色、列表符号（`•` / 序号）；
  - 行内：加粗 / 斜体 / 删除线 / 行内代码 / 链接（逐个给**子节点之间的空隙**上类 —— `**x**` 的语法树里只有两个 `EmphasisMark`，文字不是节点）；
  - 块级 widget：图片（内联，走附件白名单）、行内与块级公式（KaTeX）、GFM 表格（渲染表 + **单元格就地编辑**）、任务复选框（可点，点一下改源文本）、分隔线；
  - 行内 widget：脚注 `词^[注释]`（虚线下划线 + 上标「注」+ 点击气泡，与阅读态同一批工具类）。
- **光标所在块回源码**：`hitsActiveLine`（行级）+ `containsCursor`（块级）两重判定；被替换/隐藏的区间一律跳过。**表格是唯一例外**：它永远渲染成表，靠单元格编辑回写源文本（见 §3.2）。
- **一期显式不渲染**：mermaid、`quiz` / `ask` / `profile` 等项目自定义围栏、HTML 块（保持源码文本，避免在编辑器里再跑一条重渲染管线）。
- **正则类装饰的扫描范围外扩 `SCAN_PAD = 400`**：公式与脚注靠正则扫（lezer 的 markdown 语法里没有它们）。块级公式跨行，视口顶切在 `$$` 中间时只扫可见区间就只剩一个 `$$` ⇒ 不命中 ⇒ 半截公式留在源码态。外扩后不再被切一半（整块在视口外仍不渲染，那是正确的）。
- **输入法**：组合输入期间不落外部文本，组合结束后按**最小 diff** 对齐（与源码档同一条纪律，Monaco 侧为「中文停顿后光标跳文末」踩过）。

### 3.1 两条 CM6 硬约束（都是实测踩出来的）

1. **跨行替换装饰不能由 ViewPlugin 提供** —— `Decorations that replace line breaks may not be specified via plugins`。表格与块级公式属于这一类，故整套装饰改由 **StateField** 提供，可见区间由一个小 ViewPlugin 作为 effect 投递进来。
2. **不能在 update 过程中 dispatch** —— `Calls to EditorView.update are not allowed while an update is in progress`（CM6 判为 plugin crashed，整帧装饰失效）。视口投递推到下一帧。

（两条都是「不报错但写作面整个崩掉、被 RootErrorBoundary 接走 → 中栏空白」的类型，故探针必须真跑。）

### 3.2 表格就地编辑（2026-10-11 第三轮，对齐 Obsidian）

**问题**：此前表格与其它块同语义（光标进入 → 整块回源码），于是「插入 → 表格」把人丢进 `| 列 1 | 列 2 |` 的管道符里；Obsidian 是**直接在渲染后的表格里打字**。

**机制（三条都是 CM6 的既定行为，不是绕路）**：

1. **单元格是编辑宿主**：CM6 给 widget 根节点设 `contentEditable=false`，单元格显式 `contentEditable=true` ⇒ 单元格成为 editing host，编辑被浏览器限制在这一格内（退格不会并格、Enter 不会裂表）。
2. **CM6 不接管格内事件**：widget 的 `ignoreEvent()` 默认 `true` ⇒ 事件不进 CM6 的处理器；`DOMObserver.readMutation` 对 widget tile **直接 `return null`** ⇒ 格内 DOM 改动不会被当成文档改动（我们自己在 `input` / `compositionend` 上回写源）。
3. **回写后同步 widget 实例的 `src`**：写源之后把 `widget.src` 更新成新文本，重建装饰时 `eq` 判等 ⇒ CM6 **保留这块 DOM** ⇒ 格内光标与输入法候选不会因为每次按键重建 DOM 而丢。这是「contenteditable 做在 widget 里」最容易翻车的一处。

**落点映射**：单元格的源区间**每次从文档现算**（`view.posAtDOM(wrap)` = widget 区间起点 → 语法树往上找 `Table` 节点 → 按未转义 `|` 切行），不缓存偏移 —— 表格上方增删内容、表格自己增减行都不会让映射失效。回写只替换该格**正文区间**（`| ` 这类排版空格原地保留），换行压成空格、`|` 转义成 `\|`（GFM 表格按行解析，格内不能有裸换行/管道符）。

**交互**：`Tab` / `Shift+Tab` 换格（末格 → 追加一行）· `Enter` 下一行同列（末行 → 追加一行）· `Esc` 退出格 · 格内 `Ctrl+Z` 交给 CM6 撤销（原生 contenteditable 撤销改的是 DOM，会与源脱钩）· 拦掉原生富文本命令 `Ctrl+B/I/U`（它们会改 DOM 而源不动）。**对齐方式**（`| :--- |`）与分隔行不渲染，要改切源码档。

**插入落点**：`ins-table` 不再选中源码里的首格（选中会落在被替换的 widget 区间里），改为经**可选契约** `focusBlockCell(at)` 把焦点交给首格（源码档不实现 ⇒ 仍是插完选中首格）。

## 4. 编辑器右键菜单（两档同款）

菜单树与动作实现在 `src/lib/noteActions.ts`，**一份定义两档共用**（源码档接管 Monaco 自带菜单；即时渲染档接管 CM6 的 `contextmenu`）。

| 菜单项 | 落法 |
|---|---|
| 新增链接 / 新增外部链接 | 插 `[[` 并唤起候选（两档各自的建议通道）/ `[文字](https://)` |
| 文本格式 | 加粗 / 斜体 / 删除线 / 行内代码 / 高亮 |
| 段落设置 | 正文 / 标题 1–6 / 引用 / 无序 / 有序 / 任务列表（**幂等**：重复点不叠加，会剥掉既有前缀） |
| 插入 | 脚注 / 表格 / 标注 / 分隔线 / 代码块 / 数学块 / 题目围栏 |
| 剪贴板 | 剪切 / 复制 / 粘贴 / 以纯文本形式粘贴 / 全选（走主进程 `clipboard:*` 通道，渲染层不直连 `navigator.clipboard`） |

- **不做「新建数据库」**：本项目没有 Obsidian Bases 的对标物；自有围栏是「题目围栏」，占了这一位。
- **块级插入的落点规则**（`insertBlock`）：有选区→替换；空行且上一行也空→就地插；空行但上一行有内容→保留空行另起一行；非空行→**空一行再插**。最后一条是必须的：`---` 紧跟段落会被 Markdown 解析成**标题下划线**（setext），补空行才是分隔线。
- 编辑器内快捷键与菜单**同一段实现**：`Ctrl+B` / `Ctrl+I` / `Ctrl+K` / `Ctrl+Alt+1·2·3·0`（两档一致，不走全局键）。
- **菜单不被屏幕边缘截断**（2026-10-11 修）：① 主菜单的出屏回夹改用 `offsetWidth/offsetHeight` 量尺寸 —— `.kb-pop` 进场 keyframes 从 `scale(0.94)` 起，`getBoundingClientRect()` 在布局期量到的是**缩小 6%** 的尺寸，按它回夹仍会溢出（~500px 的菜单能溢出 ~30px）；② 子菜单此前完全没有出屏处理（在窗口右缘右键 → 往右展开的「插入 / 文本格式 / 段落设置」整块在窗口外），现在**右边放不下就翻到左侧、下边放不下就上移**，并在极矮窗口下内部滚动。共享 hook `src/lib/useContextMenuPosition.ts`（文件树 / 书签 / 章节等 8 处菜单）同因同修。
- **子菜单父项「点击只开不关」**：悬停已经把它打开了，再做成 toggle 就会出现「鼠标还在这一行、点一下反而收起来」的自相矛盾。

## 5. 切档与光标

- 两档各记一份「字符偏移」（`rememberCursor` / `recallCursor`），切档时由目标引擎在**首挂时**落到该位置（`initialCursorOffset`），不做宿主侧延时补位（那条路有「引擎还没挂好」的竞态）。
- **撤销栈跨档不保留**（两个引擎的 undo 历史无法合并）——这是双引擎方案的固有权衡，已在设置项说明里写明。

## 6. 批次与边界

| 批次 | 内容 | 状态 |
|---|---|---|
| P0 | 设置项 + 契约 + 宿主 + 单写者闸门 + 光标记账 + 右键菜单（两档） | ✅ |
| P1 | CM6 渲染 / 回源码 / 列表与配对 / 快捷键 / 图片 / 公式 / 表格 | ✅ |
| P1.5 | **排版与阅读态逐项一致**（2026-10-11）：共享令牌 `--md-*` + 共用原子作用域 `.kb-md-atom`，代码块卡片化 + highlight.js，基准字号改跟随正文字号 | ✅ |
| P1.6 | **表格渲染态就地编辑 + 脚注渲染 + 菜单出屏回夹**（2026-10-11 第三轮） | ✅ |
| P2 | `[[` 候选共用数据层 + 两档补全；脚注 / 插图 / 大纲跳转走契约 | ✅ |
| P3 | **AI 续写（ghost text）在即时渲染档**：暂未提供（该档不渲染 ✨ 钮，避免点了没反应） | ⏳ 待做 |
| P4 | 禅模式 / 打字机 / 折叠等细节对齐 | ⏳ 待做 |

**明确不做**：中间档「淡化+」· 跨档撤销搬运 · 同屏双引擎 · **表格全量 grid 编辑器**（只做「点格打字 + Tab/Enter 换格 + 末行加行」；列宽拖拽 / 行列增删菜单不做）· mermaid 渲染 · 块引用 `^id` · 拖拽块排序 · 「新建数据库」。

## 6.1 排版对齐（2026-10-11 追加）

**起因**：即时渲染档与预览看起来"不太一样"。实测（`compare-live-vs-preview.mjs`）发现两侧是两套独立样式表，差异 14 项，最大一条是**基准字号 13px vs 16px**（差 23%）。

**治理结构（防再次漂移）**：

1. **共享排版令牌**：`src/styles/index.css` 新增 `:root { --md-* }`（h1–h6 字号字重、行高、行内代码、代码卡、表格、引用条）。`.prose-content` 与 `.kb-live-*` **都只引用令牌**，不许各写数值（契约 C11h 负向锁住）。
2. **共用原子作用域 `.kb-md-atom`**：表格 / 代码块 / 图片 widget 产出**与预览同构的 DOM** 并挂这个类，CSS 写成 `:is(.prose-content, .kb-md-atom) …` —— 一致性由构造保证，不靠两处对数值。
3. **基准字号 = 根字号**：CM6 主题写 `1rem`（`App.tsx` 把缩放写成 `html{font-size: zoom×16px}`），与预览同基准；「编辑器字号」设置**从此只管源码档**。
4. **代码块卡片化**：`CodeBlockWidget` 用 highlight.js（`lib/common`，与预览同一个库、同一套 `.hljs-*` 配色，且该 chunk 与预览共用、不重复打包）产出 `<pre><code class="hljs language-js">` + 语言标签；光标进入整块回源码（与表格同一套语义）。

**有意保留的差异**（写进探针 EXEMPT，防被误当 bug 回改）：任务复选框可点性（编辑态可点 / 阅读态不可点）· 预览顶部多一行页面标题 · 文档总高度（编辑器必须显示空行）· 列表缩进的 ±2px 容差（两侧量法不同）。

**2026-10-11 第二轮（列表与图片收口，已完成）**：

- **有序列表重编号**：源里写 `1. 1. 1.` 时编辑器也显示 1/2/3（此前只有阅读态重编号）；层级走**整棵语法树的祖先链**（`listDepth`），不受「可见区间切片」影响；并按层换 `a.` / `i.`（对应阅读态的 `lower-alpha` / `lower-roman`）。
- **列表缩进对齐**：编辑器给列表首行设 `padding-left = 16 + 24 + 20×层`，并**隐藏源里的前导空格**（否则「源缩进 + padding」叠加）；光标所在行不设 —— 该行按「回源码」规则显示，保留真实缩进才好编辑。实测两侧相对段落的缩进**完全相等**（顶层 24px / 嵌套 44px）。
- **行高对齐**：列表行与引用行改为 1.5（阅读态这两类是继承来的 1.5，段落才是 1.75）。
- **图片断言**：对比 fixture 加了一张 data:URI 图片，两侧的 `border-radius / max-width / margin` 与「真的加载出来（naturalWidth > 0）」都进断言。
- **`Ctrl F` 查找**：接 `@codemirror/search`（依赖早已在 `package.json`，此前未接线）——`search({ top: true })` + `searchKeymap` + `highlightSelectionMatches()`，面板样式换成应用 token，与源码档 Monaco 的 find widget 对齐。★ 踩坑：CM6 的查找输入框**没有 `type` 属性**（只设 `name`），选择器写 `input[type=text]` 会一条都不命中（主题与探针断言都栽过一次）。
- **探针自身两处修正**（都是假红，值得记）：① CM6 只装饰视口内的块 → 单张快照覆盖不全，改为**顶 / 底 / 公式三张快照取并集**；② 编辑器侧的 computed 值是**设备像素对齐后的 used 值**（本机 DPR 1.5 → 1px 读成 0.667px、3px 读成 2.667px）→ 数值比对加 **0.5px 容差**（真差异都 ≥1px，容差不掩盖问题）。

**下一轮待办（2026-10-11 记录，未做）**：

**下一轮待办（2026-10-11 记录，未做）**：

- 列表「松散项」（项内多行）的续行缩进：目前只给首行上 padding，续行仍是基准缩进（fixture 未覆盖）。
- **插入项里还剩两处「插完看不到预期效果」**（本轮盘点，未做）：① **标注** `> [!note]` 在阅读态与写作面都只按普通引用显示（没有 callout 卡片，两处都要新写渲染，属新功能）；② **题目围栏**在写作面显示为 `lang=quiz` 的代码卡片，而阅读态是可作答的 QuizCard（一期显式不渲染自定义围栏）。其余插入项（表格 / 脚注 / 代码块 / 数学块 / 分隔线）本轮已对齐。
- 高亮 `==文字==` 同样两侧都无专用样式（remark 不解析，需要自定义插件）。

**2026-10-11 第三轮（表格就地编辑 / 脚注 / 菜单回夹，已完成）**：

- **表格**：从「光标进入整块回源码」改成**永远是渲染表 + 单元格就地编辑**（详见 §3.2）；`ins-table` 插完焦点直接进首格。
- **脚注**：即时渲染档补上 `词^[注释]`（虚线下划线 + 上标「注」+ 点击气泡），外观**复用预览那份 Tailwind 工具类**（同一批 class 字符串 ⇒ 同一批数值，契约 C12l/C12m 互锁两边字符串必须逐字相同）；气泡在编辑器里用 `fixed` + 视口回夹（预览那份 `absolute` 会被 `.cm-scroller` 的 overflow 裁掉）。
- **菜单出屏回夹**：主菜单改用 `offsetWidth/offsetHeight` 量尺寸、子菜单加「右侧放不下翻左侧 / 下边放不下上移」，共享 hook 同修。
- **探针自身三处修正**（都是假红，值得记）：① 顶栏改版后 `button[title^="切换到预览"]` 不再存在 → 阅读态快照整片 `null`，65 项全红却看不出原因 ⇒ 改用 `data-wb="noteTopViewToggle"` + 新增的 `data-view` 状态锚点；② 脚注/块级公式都在文档中段，顶/底两张快照都照不到 ⇒ 各加一次「滚到它」的快照，并把断言改成**多张快照取并集**；③ 子菜单展开跟随**悬停**，而物理鼠标停在哪儿不确定（菜单正好弹在指针下时浏览器补发 mouseover 会抢走 `openSub`）⇒ 探针开菜单前先 `parkPointer()`，并用**真鼠标**走「移到插入 → 移到表格 → 点击」。

## 7. 验证

| 门禁 | 结果（2026-10-11 第三轮后复跑） |
|---|---|
| `tsc --noEmit`（node / web） | 0 错 |
| `electron-vite build` | 通过（CM6 独立 chunk `LiveMarkdownPane-*.js`，lazy；highlight.js 与预览共用同一 chunk，无重复打包） |
| 契约 `.AGENT/scripts/notes-surface/verify-note-surface.mjs` | **196 PASS / 0 FAIL**（含用假引擎跑真动作的表驱动断言 + C11「排版单一真相」/ C12「表格就地编辑 + 脚注」/ C13「菜单不被边缘截断」三组源码层负向断言） |
| 探针 `.AGENT/scripts/notes-surface/probe-note-surface.mjs`（隔离实例 + CDP 真 DOM） | **45 PASS / 0 FAIL**（源码档在场 → 两档右键菜单 → **切档不关笔记、当场换成即时渲染档** → CM6 渲染各类块且标记被隐藏 → 代码块卡片 + 语法高亮 → 光标块回源码（含代码块来回） → **Ctrl+F 查找面板开/焦点/关** → 菜单动作真落进文档并渲染 → **表格：真点格 → 打字写回源 → Tab 换格 / Esc 退出 / 格内 Ctrl+Z → 插入表格后焦点进首格** → 切回源码档不残留 → console 零 error） |
| 排版一致性探针 `.AGENT/scripts/notes-surface/compare-live-vs-preview.mjs`（隔离实例 + computedStyle 逐项比对） | **72 PASS / 0 FAIL**（54 项排版数值两侧相等（数值容差 0.5px = 设备像素对齐，含脚注 4 项）+ 脚注渲染数 + 代码卡/高亮/语言标签 + 视口内块级公式必须渲染 + 脚注在视口内必须渲染 + 列表标记与重编号 + 相对缩进 + 图片加载 + console 零 error；有意差异列在 EXEMPT 只打印不判失败） |
| 手册检索 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs` | **54/54 用例通过**（新增《笔记 · 写作模式与编辑器》8 条用例全第 1 名命中） |

探针跑法（隔离 userData，不动开发机数据）：

```bash
node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"
node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs .AGENT/scripts/notes-surface/probe-note-surface.mjs
node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs .AGENT/scripts/notes-surface/compare-live-vs-preview.mjs
```

> 两个探针都必须**先 build**（跑的是 `out/` 产物）；`compare-live-vs-preview.mjs` 会把截图与 computedStyle JSON 落到 `tmp/probe-shots/`，改样式后可重跑复核。

调试钩子：`window.__kbLive`（CM6 `EditorView` 实例，与 `__kbTerm` / `__kb_inline_trigger` 同范式）——探针靠它读「菜单动作到底改没改到文档」。

## 8. 已知影响面

- **`PageEditor` 不再直接渲染引擎**：既有契约脚本里「PageEditor 消费共享宿主」那条仍成立（它仍从 `MonacoPane` 取 `cancelInlineSuggestInFlight`），另有 `.AGENT/scripts/notes-surface/` 新脚本守住新结构。
- **博客编辑器 / 归档文本 / 导图视图不受影响**（仍直接用 `MonacoPane`，写作模式设置只作用于知识库笔记正文）。
- **「编辑器字号」语义收窄**（2026-10-11）：该项从此只作用于**源码档**（Monaco）；即时渲染档跟随界面正文字号（与阅读态一致）。设置说明、`EditorView` 提示与 AI 手册已同步。
- **阅读态预览也有改动**：补齐 h4–h6 样式、任务列表去掉「• ☐」双标记、代码块相关规则改为 `:is(.prose-content, .kb-md-atom)` 双作用域（`.prose-content` 有 19 处消费者，改动均为**加法**：既有取值不变，仅新增选择器与 h4–h6）。
- **契约新增一条可选面**（2026-10-11 第三轮）：`NoteEngineHandle.focusBlockCell?(pos)` —— 只有即时渲染档实现（源码档的表格就是文本，插完选中首格即可）。假引擎 harness 已补该方法的计数，契约 A3c 锁住「插表格后必须调它」。
- **`NoteTopBar` 新增 `data-view` 状态锚点**：阅读/编辑切换钮上标 `preview` / `edit`。此前探针按 `title` 文案找按钮，顶栏改版把「切换到预览」改成「切换到阅读视图」后，`compare-live-vs-preview.mjs` 静默读不到阅读态 → 65 项全红。**按状态锚点找控件，不按文案找**。
- **菜单定位的尺寸口径**：`NoteContextMenu` 与共享 hook `useContextMenuPosition` 一律用 `offsetWidth/offsetHeight` 量（`getBoundingClientRect()` 会被进场 `scale` 缩小，见 §4）；改这两处时别退回 rect。
- **AI 手册已同步**：新增《笔记 · 写作模式与编辑器》（含字号口径、表格就地编辑一节与不支持项）。
