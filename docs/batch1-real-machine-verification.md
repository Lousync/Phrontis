# 批 1 实机验收 · 交接文档

> **交接对象**：另一个 agent 工具。**你没有本会话的上下文，一切以本文件为准。**
> **任务**：在真机上验收「知识库非 md 文件的内容落点」批 1（代码已落，实机未验）。
> **仓库**：`E:\Projects\KnowledgeRecorder`，分支 `feature/v3.5.0`。
> **写于**：2026-10-12。

---

## 0. 三句话背景

1. **根因**：`E:\Projects\KnowledgeRecorder\src\modules\knowledge\components\PageEditor.tsx` 的内容分支里，
   `isArchiveFile` 排在了所有专门视图之前。而仓库内的非 md 文件**全部**是 `entryKind:'file'`
   （`electron/lib/kbStore/knowledgeIndex.ts` 注释：「非 md 一律收录」）⇒
   **PDF 阅读器、文本视图全都不可达**，一律落成一张元信息卡。
2. **改法**：把 `isArchiveFile` 降级为**兜底**（专门视图优先）；文本类改成**可编辑**；
   沉浸阅读路径里的同款遮蔽一并修；`rootId` 从 ref 提成 state（修并发装载竞态）。
3. **先读设计文档**：`E:\Projects\KnowledgeRecorder\docs\knowledge-content-routing-design.md`。
   本文件只讲「**怎么验**」，不复述机制。

**源码层门禁已经全绿**（下面 §6 可复跑）：tsc web/node 双 0；新契约 64/64；
`verify-note-surface` 196/196、`verify-note-topbar` 51/51、`verify-page-split` 40/40、
手册检索 76/76、更新说明契约 PASS。

⇒ **实机一旦失败，请先怀疑「探针/判断写错了」，再怀疑代码** —— 但**必须把原始证据贴回来**，
不要只报「失败」二字。这个项目有过「源码断言全绿、真机照样崩」的先例（页面分屏副栏塌成横条）。

### 验收进度（2026-10-12 起，随做随更）

| 项 | 状态 |
|---|---|
| **组 A2** 文本类可编辑 | ✅ **已实机确认** —— 开发负责人截图：一个 `.cpp` 打开即为可编辑 Monaco（行号 + C++ 高亮 + 正文），右上仍是悬浮胶囊。改前它只会是一张元信息卡 |
| 组 A1 PDF 阅读器 · A3 HTML 沙箱 · B3 图片/二进制落元信息卡 | ⏳ 探针自动断言（§4 的 §2/§3） |
| 组 C ⋮「文件」组四项 · 组 D html 源码 ⇄ 渲染 | ⏳ 探针**自动点**（§4 的 §3.5/§3.6） |
| 组 B1 `>10MB` 只读 · B2 `>50MB` 打不开 | ⏳ 需先 `seed-batch1-fixture.mjs --with-big` 造大文件（§3.2），再跑探针 |
| 手点两条：写通道往返 · 沉浸阅读 | ⏳ **必须手点**（§5，探针刻意不做） |

---

## 1. 先确认工作区状态

```powershell
cd E:\Projects\KnowledgeRecorder
& 'E:\git\Git\cmd\git.exe' status --short
```

**批 1 这条线（我改的，验收对象）**：

| 文件 | 改动 |
|---|---|
| `src\modules\knowledge\components\PageEditor.tsx` | 分支顺序 / rootId state / 文本自读 / `paneDoc` / ⋮ 文件组 / html 源码态 |
| `src\modules\knowledge\index.tsx` | 沉浸阅读同款分支 |
| `src\modules\knowledge\components\ArchiveTextView.tsx` | 改造为「超限只读」复用路径，加 `banner` |
| `src\modules\knowledge\components\FileMetaCard.tsx` | 抽出 `FileInfoRows`（与 ⋮ 弹层同源） |
| `src\lib\fileTypes.ts` | 补 16 个类型条目 + 兜底 `monacoLang` 改 `plaintext` |
| `.AGENT\scripts\knowledge-content-routing\` | **新增**：契约 + 探针 + fixture 播种 |
| `.AGENT\scripts\help-kb\verify-help-retrieval.mjs` | 新增 5 条用例 |
| `resources\help\工作台左栏与文件树模式.md`、`resources\help\笔记 · 写作模式与编辑器.md` | 手册同步 |
| `CHANGELOG.md`、`electron\lib\releaseNotes\data.ts` | v3.5.0 段 + 重跑生成器 |
| `docs\knowledge-content-routing-design.md` | **新增**设计文档 |

**不是我的、禁止提交或改动**（另一条并行线在做 AI 吉祥物）：

```
 M .AGENT/scripts/plugins/verify-mascot.mjs        M src/lib/settings.ts
 M electron/lib/pluginRegistry.ts                  M src/modules/settings/views/AiToolsView.tsx
 M src/components/shared/AiMascot/AiMascotAnchor.tsx
?? .AGENT/scripts/mascot-gen/    ?? resources/market-plugins/knowbase.mascot-desk-companions/
```

**提交口径**：本仓提交一律用**系统 git** `E:\git\Git\cmd\git.exe`
（Git Bash 自带那版有嵌套 ref bug，会把提交变成孤儿）。说「提交/推送」默认且**仅指本仓**。

---

## 2. 被验行为（4 组）

判定依据全部是**稳定的 DOM 事实**（锚点表见 §7），不依赖任何文案。

### 组 A：核心（批 1 的主目标）

| # | 文件 | 改前 | 改后**期望** | 判定依据 |
|---|---|---|---|---|
| A1 | 仓库里的 `.pdf` | **元信息卡**（阅读器分支被遮蔽） | 内嵌阅读器（与书架同一套：竖滚/单页/双页、翻页、缩放、目录） | `.kb-pdf-scope` 在场 |
| A2 | `.py` / `.txt` / `.csv` / `.json` / `.log` | 元信息卡 → 点「查看内容」→ **只读** | **直接进可编辑页签**（Monaco，能打字）**✅ 已实机确认** | `.monaco-editor` 在场 **且** 无 `[data-wb="archiveViewBanner"]` **且** 无 `[data-wb="noteTopBar"]` |
| A3 | 归档 `.html` | 沙箱渲染 | 沙箱渲染（默认不变） | `iframe[src^="kbview://"]` 在场 |

### 组 B：边界与降级（**需要 `--with-big` 造大文件**）

| # | 文件 | 期望 | 判定依据 |
|---|---|---|---|
| B1 | `大日志.log`（约 11 MB） | **只读**打开 + 提示条（`>10MB`，主进程 `editable:false`） | `.monaco-editor` 在场 **且** `[data-wb="archiveViewBanner"]` 在场 |
| B2 | `超大.bin`（52 MB） | 元信息卡（`>50MB`，`truncated:true`，不读内容） | `[data-wb="metaOpenInSystem"]` 在场 |
| B3 | `资料包.zip` / `示意图.png` | 元信息卡 | 同上 |
| B4 | `.md` 笔记（**对照组**） | 顶栏仍在，且 ⋮ 里**没有**「文件」组 | `[data-wb="noteTopBar"]` 在场 **且** 无 `[data-wb="peFileInfo"]` |

> B3 里的 `示意图.png` 是**预期行为**，不是 bug：图片渲染属**批 3**，本批故意不做。
> B4 是范围锁：本批明确「md 的 ⋮ 分段一行不改」。

### 组 C：`⋮` 的「文件」组（非 md 才有）

打开任一非 md 文件 → 右上悬浮胶囊 → `⋮` → 期望看到「文件」分组，含：
**文件信息** / **在系统中打开** / **在文件夹中显示** / **复制相对路径**（html 还多一条 **看源码**）。

- 改前：这一组几乎为空（仓库内 PDF/HTML/代码的 `⋮` 里只剩一条分隔线 —— 因为
  `关联`/`删除`/`文件格式` 都要 `!vaultMode`，而知识库内 `vaultMode` **恒 true**；`收藏` 排除归档条目）。
- 判定依据：`[data-wb="peFileInfo"]`、`peOpenInSystem`、`peRevealInFolder`、`peCopyRelPath`、
  `peHtmlSource`（html）在场；点「文件信息」→ `[data-wb="peFileInfoCard"]` 出现（含路径/尺寸/修改时间）。

### 组 D：html 源码 ⇄ 渲染

`归档页面.html` → `⋮` →「看源码」→ 期望进**可编辑 Monaco 源码**（`⋮` 里那条变成「看渲染」）；
再点「看渲染」→ 回到沙箱 iframe。换到另一个 html 页签时，源码态**不继承**（重置为渲染）。

---

## 3. 环境准备

### 3.1 起 dev

```powershell
cd E:\Projects\KnowledgeRecorder
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # ★ 必须删，否则 electron 起成 node
npm run dev                                                          # electron-vite dev，端口 7173
```

dev 起来后，主进程会在 **7465** 上开一个**开发调试桥**（仅 dev）。探针走它。

### 3.2 fixture（散落在仓库**正文区**的非 md 文件）

既有的 `tmp\vault-fixture` **不够用**：它的 PDF 全在 `.books\` 下，而 `.books` 是点前缀目录，
**知识库索引会跳过**（系统目录规则）。批 1 要验的正是「散落在仓库里的 PDF / 代码 / 文本」。

```powershell
# 若 tmp\vault-fixture 不存在，先生成它：
node .AGENT\scripts\workbench-shell\probes\seed-probe-vault.mjs --add-books --ud "knowbase (dev probe-app)"

# 播种批 1 的 fixture（落 tmp\vault-fixture\批1探针\；tmp/ 已被 .gitignore:45 忽略）
node .AGENT\scripts\knowledge-content-routing\seed-batch1-fixture.mjs
# 要验 >10MB / >50MB 两条降级路径时加 --with-big（会造约 62MB 的两个文件）
node .AGENT\scripts\knowledge-content-routing\seed-batch1-fixture.mjs --with-big
```

产出的文件：`脚本.py`、`说明.txt`、`数据.csv`、`配置.json`、`归档页面.html`、`示意图.png`、
`资料包.zip`、`论文.pdf`（从 `.books` 复制到正文区）、`大日志.log` / `超大.bin`（仅 `--with-big`）。

> ⚠️ **两个脚本我都没跑过**（见 §4 末「诚实交代」）。播种脚本只写 `tmp\vault-fixture\批1探针\`，
> 不碰任何真实仓库；但它若报错，请把报错原文贴回来。

然后**在 dev 窗口里把 `E:\Projects\KnowledgeRecorder\tmp\vault-fixture` 打开为当前仓库**
（或用你自己本来就有的仓库 —— 探针会**自动发现**仓库里现成的非 md 文件，见 §4）。

### 3.3 环境注意

- **单实例锁**：dev 的 userData 名 = `knowbase (dev KnowledgeRecorder)`。**别同时开两个 dev 窗口**，
  否则后起的会静默退出。隔离实例探针用 `run-probe-app.mjs`（cwd 换到 `tmp\probe-app`，userData 变
  `knowbase (dev probe-app)`）来绕开这件事 —— **不要 kill 用户的窗口去腾锁**。
- **隔离实例探针跑 `out\` 产物**，必须先 `npm run build`。本文件推荐的 dev-bridge 探针**不需要 build**。
- 端口：dev **7173**、dev bridge **7465**、隔离实例 CDP **9222**（可用 `KNOWBASE_PROBE_PORT` 覆盖）。

---

## 4. 验收方式 A：dev bridge 探针（推荐）

```powershell
# dev 已在跑的前提下，另开一个终端：
node E:\Projects\KnowledgeRecorder\.AGENT\scripts\knowledge-content-routing\probe-content-routing.mjs
```

它做什么：

1. `GET http://127.0.0.1:7465/health` 确认桥在；
2. 经 `window.api.getKnowledgePages(null)` 列出仓库内 `entryKind === 'file'` 的条目，按扩展名归类；
3. 逐类各挑一个（PDF / 文本类 / HTML / 图片 / 二进制），派发 `kb-open-note` 事件打开，
   读回**可见主栏内**的落点签名，与期望比对（**组 A + B3**）；
4. **§3.5 自动点开 `⋮`**，核对「文件」组四项在场、文本类不出现「看源码」，
   并点「文件信息」确认小卡出现（**组 C**）；
5. **§3.6 自动点「看源码 / 看渲染」**，核对 html 从沙箱 → 可编辑源码 → 回到沙箱（**组 D**）；
6. 打印需要**手点**的两条（写通道往返、沉浸阅读）。

它**只读**：不模拟键盘输入、不写盘、不改你的仓库文件。它会打开若干页签（停在最后一个），看完手动关掉即可。
（第 4/5 步用的是桥的 `ui.click` —— 真鼠标事件，不是合成 DOM 事件。）

### 探针失败时怎么区分「探针错」还是「代码错」

- 先看它打印的 `实际 <kind>`：
  - `unknown` → 很可能**探针的选择器没命中**（先按 §7 锚点表核对 DOM），不是代码错；
  - 落点与期望不符、且锚点命中 → **可能是真 bug**，请把 `§1 文件清单` + `§4 落点汇总` 原文贴回来；
- 若某类文件在你的仓库里不存在，探针会打 `[SKIP]` 而不是失败 —— 这是**设计如此**（别当成通过）。

### 诚实交代：这两个脚本我都没跑过

我（上一个 agent）所在的执行环境**禁子进程 pipe、禁写 `tmp/`、起不了 Electron**：

- `npm run dev` / `npm run build` 一律 `Error: spawn EPERM`（esbuild 的服务进程拉不起来）——
  这是**沙箱边界，不是代码缺陷**；
- 播种脚本写 `tmp\vault-fixture\批1探针` 时 `EPERM`。

所以：**`probe-content-routing.mjs` 与 `seed-batch1-fixture.mjs` 都只做过 `node --check` 语法自检**。
真机跑不通时，请把报错原文贴回来，不要替我"修好再说"——先贴证据。

---

## 5. 验收方式 B：手点清单（探针**刻意不做**的两条）

探针不做这两条是有理由的：都需要模拟键盘输入，**焦点一旦落错就会把垃圾打进真实文件**。

### 5.1 写通道往返（批 1 最有价值的一条）

1. 打开 `批1探针\脚本.py`（或任意 `.py` / `.txt`）；
2. 在末尾新起一行打 `# probe-write-test`；
3. 观察右上**悬浮胶囊的绿点**：应变橙（保存中）→ 约 1 秒后转回绿（`autoSaveDebounceMs` 防抖）；
4. 关掉该页签 → 从文件树重新打开 → **改动还在**；
5. **打开磁盘文件确认没有多出 frontmatter 头**：
   ```powershell
   Get-Content -LiteralPath 'E:\Projects\KnowledgeRecorder\tmp\vault-fixture\批1探针\脚本.py' -TotalCount 3
   ```
   期望：第 1 行仍是 `# 批 1 fixture：文本类应落「可编辑」`，
   **不应**出现 `---` / `id:` / `fileType:`（那说明保存串到了 md 的 frontmatter 分支）；
6. **还原**：删掉刚加的那行 → 等保存 → 再确认磁盘文件回到原样。

### 5.2 沉浸阅读（同款遮蔽的第二处）

1. 打开 `批1探针\说明.txt`；
2. 悬浮胶囊 `⋮` →「沉浸阅读」；
3. **期望**：显示只读正文（`ArchiveTextView`，头部写着「只读预览 · 批1探针/说明.txt」）；
4. **改前/错误表现**：屏幕上跳出一张「该文件不是 markdown 知识页，知识库中仅展示元信息」的卡。
   （`enterReading` 明确放行 md / txt / html，而沉浸分支原先对**所有** `entryKind:'file'` 一律元信息卡
   ⇒ 这条是**必现**的，不是偶发。）

---

## 6. 复跑门禁（源码层，命令照抄即可）

```powershell
cd E:\Projects\KnowledgeRecorder
node node_modules\typescript\bin\tsc --noEmit -p tsconfig.web.json
node node_modules\typescript\bin\tsc --noEmit -p tsconfig.node.json

node --experimental-strip-types .AGENT\scripts\knowledge-content-routing\verify-content-routing.mjs
node --experimental-strip-types .AGENT\scripts\notes-surface\verify-note-surface.mjs
node --experimental-strip-types .AGENT\scripts\note-topbar\verify-note-topbar.mjs
node --experimental-strip-types .AGENT\scripts\page-split\verify-page-split.mjs
node --experimental-strip-types .AGENT\scripts\help-kb\verify-help-retrieval.mjs
node --experimental-strip-types .AGENT\scripts\release-notes\verify-release-notes.mjs
```

基线（我跑出来的）：tsc 双 0；**64 / 196 / 51 / 40 / 76 全绿**；更新说明契约 PASS。
（`npx` 在本机沙箱不可用，故一律用 `node node_modules\typescript\bin\tsc` 的写法。）

---

## 7. DOM 锚点表（自己写探针时用）

| 锚点 | 含义 |
|---|---|
| `[data-pane="main"]` | 主栏容器（**用 `getClientRects().length > 0` 过滤出可见那个**，模块是保活的，隐藏模块的 DOM 还在） |
| `.kb-pdf-scope` | `PdfReaderView` 根（PDF 阅读器在场） |
| `iframe[src^="kbview://"]` | `WelcomeHtmlView` 沙箱（html 渲染态） |
| `.monaco-editor` | Monaco 在场 |
| `[data-wb="noteTopBar"]` / `noteTopTitle` | md 的顶栏（有它 = 走 md 路径） |
| `[data-wb="archiveViewBanner"]` | `ArchiveTextView` 的提示条（**只在超限只读时**给，是「只读 vs 可编辑」的判别锚点） |
| `[data-wb="metaOpenInSystem"]` / `metaRevealInFolder` | `FileMetaCard`（归档兜底）在场 |
| `[data-wb="peMore"]` | 非 md 的 `⋮` 按钮（探针靠它点开菜单；**批 2 搬到顶栏后锚点沿用**） |
| `[data-wb="peFileInfo"]` / `peOpenInSystem` / `peRevealInFolder` / `peCopyRelPath` / `peHtmlSource` | 非 md 的 `⋮`「文件」组各项 |
| `[data-wb="peFileInfoCard"]` | 「文件信息」小卡 |
| `[data-wb="floatBar"]` / `#editor-toolbar-slot` | 右上悬浮胶囊（非 md 的工具区，**批 2 会把它换成统一顶栏**） |
| `[data-wb-tree-path]` / `[data-wb-tree-dir]` | 左栏文件树节点（含 `relPath`；仅在左栏处于「文件树模式」时存在） |

dev bridge 用法（与探针同款）：

```
GET  http://127.0.0.1:7465/health | /state | /errors | /logs | /ui/tree
POST http://127.0.0.1:7465/action   body: {"name":"ui.eval","params":{"code":"..."}}
```

`ui.eval` 的返回值取 `resp.data.result.result`。渲染层里可以直呼 `window.api.*`（preload 桥）。

> 已知限制：Electron 的 `sendInputEvent` **不合成 `contextmenu`**，所以桥上的"右键"打不开右键菜单 ——
> 要验右键菜单得用真鼠标（或改走隔离实例 + CDP 的 `Input.dispatchMouseEvent`）。

---

## 8. 不要做的事

1. **不要提交**那条并行 mascot 线的任何文件（清单见 §1）。
2. **不要**用 `npm`/`npx` 之外的 git：提交一律 `E:\git\Git\cmd\git.exe`。
3. **不要扩大范围**。批 1 的范围锁（设计文档 §8）：图片渲染属**批 3**；非 md 的工具区统一属**批 2**；
   **主进程一行未动**；md 的 `⋮` 分段一行未改；编辑区既存待办（标注 callout / `==高亮==` /
   题目围栏渲染 / 禅模式等）不在本批。
4. **不要**为了让探针变绿去改断言或改代码 —— 先把证据贴回来。
5. 探针跑完**别留下打开的页签**（手动关掉），也别改 `tmp\vault-fixture` 之外的文件。

---

## 9. 已知的存量失败（**别追**，与批 1 无关）

`node --experimental-strip-types .AGENT\scripts\workbench-shell\verify-workbench-shell.mjs`
有 **5 条 FAIL**（另有 238 PASS）：

```
E6f 下段 = bg-primary 内容层 + 细边框；min-h-400 保底（宠物永不被挤）…
G4  副栏槽与副栏 DOM 标识（secondarySlotRef / wbSecActions / data-pb-split / splitPane）已清空
G9  「分屏」概念已从 App / 页签条 / 页面条 / 状态栏的源码与注释中清除
N8  右键菜单 portal 到 body（不走栏内定位 —— 变换容器会压窄菜单）
N13b VaultTree 的 hideSoft 默认 false（其余调用方行为不变），且主列表同样剔除命中项
```

判定为**存量**的依据：这 5 条指向的文件（`src\App.tsx`、`src\components\shared\VaultTree.tsx`、
`src\components\workbench\PageTabStrip.tsx`、`StatusBar`）批 1 **一个都没改**；且 `App.tsx` 里现在就有
**5 处「分屏」**，而 G9 断言的正是「『分屏』概念已清除」—— 页面级分屏是正式功能，所以它**必然**失败。
它们属页面级分屏合并与文件树重做留下的过期断言。

---

## 10. 回报格式

请按这个结构回：

```
## 环境
dev 是否起来 / 当前打开的仓库是哪个 / 是否用了 fixture（--with-big？）

## 组 A/B/C/D 结果
逐条：编号 · 文件 · 实际落点 · PASS/FAIL · 证据（DOM 片段或截图路径）

## 手点两条
5.1 写通道：改动是否留存 / 磁盘文件是否多出 frontmatter 头（贴前 3 行）
5.2 沉浸阅读：看到的是只读正文还是元信息卡（贴现象）

## 门禁复跑
tsc 两个 / 6 个契约的退出码与最后一行输出

## 失败项
原始证据优先（DOM 片段、控制台报错、文件前几行）；
并注明你判断是「探针/选择器问题」还是「代码问题」，以及依据
```

---

## 附：本批相关的三个文件

| 用途 | 路径 |
|---|---|
| 设计文档（机制、根因、范围锁） | `E:\Projects\KnowledgeRecorder\docs\knowledge-content-routing-design.md` |
| 源码层契约（64 项，含**按括号深度解析**的分支顺序断言） | `E:\Projects\KnowledgeRecorder\.AGENT\scripts\knowledge-content-routing\verify-content-routing.mjs` |
| 实机探针（dev bridge，只读） | `E:\Projects\KnowledgeRecorder\.AGENT\scripts\knowledge-content-routing\probe-content-routing.mjs` |
| fixture 播种 | `E:\Projects\KnowledgeRecorder\.AGENT\scripts\knowledge-content-routing\seed-batch1-fixture.mjs` |
