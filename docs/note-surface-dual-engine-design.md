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
  - 块级 widget：图片（内联，走附件白名单）、行内与块级公式（KaTeX）、GFM 表格（只读渲染）、任务复选框（可点，点一下改源文本）、分隔线。
- **光标所在块回源码**：`hitsActiveLine`（行级）+ `containsCursor`（块级）两重判定；被替换/隐藏的区间一律跳过。
- **一期显式不渲染**：mermaid、`quiz` / `ask` / `profile` 等项目自定义围栏、HTML 块、脚注气泡（保持源码文本，避免在编辑器里再跑一条重渲染管线）。
- **输入法**：组合输入期间不落外部文本，组合结束后按**最小 diff** 对齐（与源码档同一条纪律，Monaco 侧为「中文停顿后光标跳文末」踩过）。

### 3.1 两条 CM6 硬约束（都是实测踩出来的）

1. **跨行替换装饰不能由 ViewPlugin 提供** —— `Decorations that replace line breaks may not be specified via plugins`。表格与块级公式属于这一类，故整套装饰改由 **StateField** 提供，可见区间由一个小 ViewPlugin 作为 effect 投递进来。
2. **不能在 update 过程中 dispatch** —— `Calls to EditorView.update are not allowed while an update is in progress`（CM6 判为 plugin crashed，整帧装饰失效）。视口投递推到下一帧。

（两条都是「不报错但写作面整个崩掉、被 RootErrorBoundary 接走 → 中栏空白」的类型，故探针必须真跑。）

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

## 5. 切档与光标

- 两档各记一份「字符偏移」（`rememberCursor` / `recallCursor`），切档时由目标引擎在**首挂时**落到该位置（`initialCursorOffset`），不做宿主侧延时补位（那条路有「引擎还没挂好」的竞态）。
- **撤销栈跨档不保留**（两个引擎的 undo 历史无法合并）——这是双引擎方案的固有权衡，已在设置项说明里写明。

## 6. 批次与边界

| 批次 | 内容 | 状态 |
|---|---|---|
| P0 | 设置项 + 契约 + 宿主 + 单写者闸门 + 光标记账 + 右键菜单（两档） | ✅ |
| P1 | CM6 渲染 / 回源码 / 列表与配对 / 快捷键 / 图片 / 公式 / 表格只读 | ✅ |
| P2 | `[[` 候选共用数据层 + 两档补全；脚注 / 插图 / 大纲跳转走契约 | ✅ |
| P3 | **AI 续写（ghost text）在即时渲染档**：暂未提供（该档不渲染 ✨ 钮，避免点了没反应） | ⏳ 待做 |
| P4 | 禅模式 / 打字机 / 折叠等细节对齐 | ⏳ 待做 |

**明确不做**：中间档「淡化+」· 跨档撤销搬运 · 同屏双引擎 · 表格内 grid 编辑 · mermaid 渲染 · 块引用 `^id` · 拖拽块排序 · 「新建数据库」。

## 7. 验证

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit`（node / web） | 0 错 |
| `electron-vite build` | 通过（CM6 独立 chunk `LiveMarkdownPane-*.js`，lazy） |
| 契约 `.AGENT/scripts/notes-surface/verify-note-surface.mjs` | **146 PASS / 0 FAIL**（含用假引擎跑真动作的表驱动断言：包裹 / 幂等段落 / 块级落点 / 脚注三态 / 菜单树完整性 / 单写者与惰性的负向断言） |
| 探针 `.AGENT/scripts/notes-surface/probe-note-surface.mjs`（隔离实例 + CDP 真 DOM） | **26 PASS / 0 FAIL**（源码档在场 → 两档右键菜单 → 切档后 CM6 渲染各类块且标记被隐藏 → 光标块回源码 → 菜单动作真落进文档并渲染 → 切回源码档不残留 → console 零 error） |

探针跑法（隔离 userData，不动开发机数据）：

```bash
node .AGENT/scripts/workbench-shell/probes/seed-probe-vault.mjs --ud "knowbase (dev probe-app)"
node .AGENT/scripts/workbench-shell/probes/run-probe-app.mjs .AGENT/scripts/notes-surface/probe-note-surface.mjs
```

调试钩子：`window.__kbLive`（CM6 `EditorView` 实例，与 `__kbTerm` / `__kb_inline_trigger` 同范式）——探针靠它读「菜单动作到底改没改到文档」。

## 8. 已知影响面

- **`PageEditor` 不再直接渲染引擎**：既有契约脚本里「PageEditor 消费共享宿主」那条仍成立（它仍从 `MonacoPane` 取 `cancelInlineSuggestInFlight`），另有 `.AGENT/scripts/notes-surface/` 新脚本守住新结构。
- **博客编辑器 / 归档文本 / 导图视图不受影响**（仍直接用 `MonacoPane`，写作模式设置只作用于知识库笔记正文）。
- **AI 手册需同步**：`resources/help/` 是 AI 回答「软件怎么用」的唯一语料，写作模式与右键菜单属用户可见新功能（见 DP `v3.5.0.md` 的「AI 使用手册同步」条目）。
