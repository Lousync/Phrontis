# 待修问题归集（滚动累积）

> 用途：开发负责人叙述的 bug 先在此逐条登记（现象 + 定位 + 根因 + 修复方向），攒齐后统一开修。
> 修完把对应条目标 `[x]` 并注明修复提交；确认闭环的条目可整段删除。
> 条目编号 `B-n` 全局递增，不复用。
>
> **★ 编号沿革（2026-09-22，合并前收口）**：本清单最初由两条并行线**各自创建**（本线 `5ccc3bb` 与主仓 `feature/v3.4.0` 的 `b9873dc`；分叉点 `388657b` 上该文件尚不存在），于是 B-12 起两条线撞号。
> 定案口径：**提交信息里引用过的号不动** —— 本线的 B-12/13/14 有 3 条提交标题（`f52c83f` / `b368566` / `1879584`）与 28 处代码注释引用（含探针文件名 `probe-b14-teach-inline.mjs`），故**保持原号**；主仓线把它那五条顺延了一段（主仓提交 `88039b3`）：
>
> | 主仓旧号 → 新号 | 内容 |
> |---|---|
> | B-12 → **B-15** | 导出「读书笔记」页名不带扩展名（同名书撞同一篇页） |
> | B-13 → **B-16** | cbz（画集）体积 / 卡顿两隐患 |
> | B-14 → **B-17** | `fixed-layout.js` 的 `#render` RO 竞态 |
> | B-15 → **B-18** | cbz 里的 `.svg` 页破图 |
> | B-16 → **B-19** | 退出书籍刷 ~266 条 RO 告警 |
>
> ★ **本线占用 B-1…B-14（本条为最后一条），B-15…B-19 属主仓线** —— 本线登记新条目请**从 B-20 起**，别再顺手写 B-15。
> 合并（v3.4.0 ← ui-rework）后本文即统一清单：1…11 = 本线那批（已修）· 12/13/14 = 感知模式开关 / 树内联命名 / 教学区树内联输入 · 15…19 = 阅读器那批。
> 教训：**并行分支登记新条目前先取另一条线的最大号**（当时主仓已到 B-16，本线从 B-12 续 ⇒ 撞号）。

---

## [x] B-1 右栏下段「⋯ 显示的小控件」菜单弹出位置错位（2026-09-21，P2）

**已修（2026-09-21，ui-rework 分支，未提交）**：按修复方向 3 抽出 `src/lib/useAnchoredMenu.ts`（`place()` 实测 `offsetHeight` → 放不下才翻转到 `r.top - h - GAP`，`left/top` 双向 clamp；open 期间 `scroll` 捕获 + `resize` 重算，`pointerdown` 外部 / Esc 关闭）。`WorkbenchRightPanel.tsx` 两处 ⋯ 菜单（`ws` / `pt`）删掉各自的 state + `toggleXxxMenu`，统一改用该 hook。`data-wb="wsMore" / widgetMenu / panelTabMenu` 锚点未动。

**现象**：工作台右侧边栏 → 下段「控件切换条」右上角的 ⋯ 点开后，弹出的「显示的小控件」菜单**不在触发按钮附近**，而是浮到侧栏中部（覆盖在「最近编辑」列表区域上），看着像从整张卡片上方凭空冒出来，与锚点按钮的视觉关联完全断开。

**定位**：`src/components/workbench/WorkbenchRightPanel.tsx:185-191`（`toggleWsMenu`）

```ts
const r = wsMoreRef.current?.getBoundingClientRect()
if (r) setWsMenuPos({
  left: Math.max(8, Math.min(r.right - 210, window.innerWidth - 218)),
  top: Math.max(8, r.top - 248),          // ← 写死「向上弹」
})
```

**根因**：定位公式把菜单方向**硬编码为向上弹**，`248` 是菜单高度的估值常量。触发按钮位于侧栏**下段控件条**（偏下），再往上方偏移 248px 就直接顶到侧栏中部，脱离锚点并压住相邻卡片内容。

同文件的面板 Tab 菜单（`togglePtMenu`，`:225-231`）用的却是 `top: r.bottom + 6`（向下贴按钮）——两处同款交互、两种方向策略，不一致正是本 bug 的成因。

**同处附带隐患**（一并修）：
- 无「视口空间不足则翻转方向」判定，方向纯写死；
- 菜单尺寸用常量 248 代替实测高度，条目增减后偏移量即失真；
- 位置只在打开瞬间算一次，之后侧栏滚动 / 窗口 resize 菜单不跟随（菜单已 portal 到 `document.body` 且 `position: fixed`）。

**修复方向**：
1. 统一为「优先向下 `r.bottom + 6`，下方空间不足以容纳实测高度时翻转为 `r.top - h - 6`」，`h` 取 `menuRef.getBoundingClientRect().height`（首帧测量后回填，或按条目数估算 + 测量校正）；
2. `left` / `top` 一律 clamp 到视口内；
3. 建议抽成 `useAnchoredMenu(triggerRef, menuRef)` 小 hook，把两处 ⋯ 菜单（`ws` / `pt`）收敛到同一实现，避免第三次复制粘贴；
4. 若要顺带处理滚动跟随，可在 open 期间监听 `scroll`（捕获阶段）+ `resize` 重算位置。

**验证**：右栏下段 ⋯ 点开 → 菜单应紧贴按钮下方展开且完整可见；把侧栏拉窄 / 窗口缩到很矮时，菜单应自动改为向上弹且不越出视口。

---

## [x] B-2 笔记左栏文件树右键菜单没有「删除」（2026-09-21，P1）

**已修（2026-09-21，ui-rework 分支，未提交）**：按拍板「同批补重命名、本轮不做 Delete 键绑定」。
- 删除按节点性质分流：**分类目录**（`categories.json` 里有登记）→ `confirmVaultCategoryDelete` + `deleteKnowledgeCategory`；**普通目录 / 任意条目** → `showGlobalConfirm` + `workspaceTrash`（不动 `categories.json`）。
- 连带三件全做：`closeTabsUnder(relPath)` 关掉该路径及其子树的已开页签（草稿 id 走 `draft:` 前缀剥壳）、`refreshTreeDir(parentDirOf(...))`、`deleteWithAnimation` 红色吞噬（★ 刷新与 `setDirCache` 放在 `await` **之后**，与 NotebookList 的节奏一致，否则行在 'done' 淡出前就被移除）。
- ★ 撤销栈未动：`ws:trash` 走系统回收站、程序内无 restore 通道，按原注释口径**不纳入** `fileOpHistory`。
- 重命名：VaultTree 新增 `renaming` / `onCommitRename` / `onCancelRename` 三个可选 prop + 文件末尾 `InlineRenameRow`（Enter 提交 / Esc 与 blur 取消；只选中主名不含扩展名）。提交侧走 `workspaceRename` → `recordFileOp({kind:'move'})` → 派发 `kb-file-moved` → 刷新父目录与 allPages。
- VaultTree 新增 `deletingMap` 可选 prop（对齐 NotebookList 的 `Map<key,'animating'|'done'>` 形态，键取 `relPath`）+ `<DeleteWipe />`。
- 菜单定位顺带修正：原来写死 `Math.min(treeMenu.y, window.innerHeight - 160)` 的估值，改用共享的 `useContextMenuPosition`（有 `ref` + `style`）。

**现象**：知识库左栏「文件」树里右键任意条目（目录 / md / 其他文件），弹出菜单只有「新建文件 / 新建目录 / 新建分类目录」三项 + 「打开」（仅文件可见）——**没有任何针对被点中条目本身的操作**：既没有删除，也没有重命名。

**定位**：
- 菜单渲染：`src/modules/knowledge/index.tsx:1814-1838`（portal 到 body 的 `treeMenu`）
- 触发：`:1784` 的 VaultTree `onContextMenu(e, node)`；菜单 state 在 `:99`（携带 `node: TreeNode`）

**根因**：菜单的动作集整体是「在此处新建」语境 —— 三项都由 `dirRel` 派生（目录节点取自身、文件节点取父目录，`:1823`）去做创建，只有「打开」是文件专属。**没有一项消费 `treeMenu.node` 自身**。而 `TreeNode` 已带 `relPath` + `type`，做删除所需信息完全具备 —— 属遗漏，非能力缺失。

旁证（能力其实齐备，只是没接到这棵树上）：
- 分类树 `components/CategoryTree.tsx:120` 自带删除按钮；
- Delete 键在 `:1316-1340` 是 context-aware，但针对的是「活动页 / 选中章节 / 选中笔记本」，**不是文件树里右键的那个节点**。

**修复方向与关键取舍**：
1. 删除通道二选一，按节点性质分流：
   - **目录**（= 分类目录）→ `deleteKnowledgeCategory(id)`（`src/lib/ipc.ts:93`，会同步 `categories.json` 登记）
   - **任意条目**（含非 md 文件、普通目录）→ `workspaceTrash(rootId, relPath)`（`ipc.ts:323`，直接移入系统回收站，**不动 categories.json**）
   - ★ 目录若走 `workspaceTrash`，`categories.json` 会残留指向不存在目录的脏条目 → 建议目录一律走 `deleteKnowledgeCategory`。
2. 连带动作必须同批做，否则删了界面不认：
   - 关闭/失效已打开的对应页签 —— 走 `kb-fs-op-changed` 的 `removed` 通道（`src/lib/fileOpHistory.ts:21-32` 已定义该字段）；
   - 刷新当前目录：`refreshTreeDir(parentDirOf(relPath))`；
   - 删除确认弹层照 `confirmVaultCategoryDelete`（`:390-400`，目录文案已定：「将一并移入系统回收站」）；
   - **动画**：必须走 `deleteWithAnimation`（`:366-387` 红色吞噬），项目铁律 13「所有操作都必须带动效」，别裸删。
3. ★ **撤销语义（别顺手改错）**：`fileOpHistory.ts:5` 明确「删除（ws:trash）**不纳入**撤销栈——走系统回收站，程序内无 restore 通道」。所以加删除时**不要**塞进撤销栈，否则得同时补 restore 通道（那是另一个量级的改动）。
4. 顺带缺口：**重命名也没有入口**（拖拽移动有、重命名无），建议同批补。
5. 可选但属扩大改动：给文件树条目绑 Delete 键 —— 需要树的选中态，而 VaultTree 目前只有 `activePath`、无 selected 概念，建议单独拍板。

**验证**：右键目录 → 删除项出现 → 确认后目录连子文件进系统回收站、`categories.json` 无残留、已开页签自动关闭、有删除动画；右键 md / 非 md 文件 → 删除后树刷新、页签关闭。

---

## [x] B-3 元信息卡「在编辑器中打开」点击无反应（2026-09-21，P1）

**已修（2026-09-21，ui-rework 分支，未提交）**：按拍板「A+B 完整」。
- **A 只读内容视图**：新增 `src/lib/aiTextExts.ts` 的 `TEXT_VIEWABLE_EXTS` / `isTextViewableExt`（★从 `AI_TEXT_CODE_EXTS` **派生**再加展示专有的配置 / 纯文本类，不另抄第三份清单——本仓已因清单各持一份吃过多次 drift）；新增 `src/modules/knowledge/components/ArchiveTextView.tsx`，按 `path` 自读（`workspaceGetCurrent` + `workspaceReadFile`）→ 只读 `MonacoPane`（`editable:false`，独立 `modelPath` 命名空间 `kb://archive-view/…`），头部常驻「返回」出口（加载 / 失败态也留）。
- **B 系统打开**：新增主进程 `ws:openInSystem`（`workspaceManager.ts`，`requireInside(rootId, relPath)` → `shell.openPath` / `shell.showItemInFolder`）+ preload + `src/lib/ipc.ts` 的 `workspaceOpenInSystem(rootId, relPath, reveal?)` + `types/index.ts` 声明。★ **没有复用 `app:openExternal`** —— 它只放行 `userData` 目录内的路径，仓库文件会被安全拦截挡掉。
- `FileMetaCard.tsx` 重写：按钮从「在编辑器打开」（自环空承诺）改为「查看内容」（仅文本类，`data-wb="metaViewContent"`）/「在系统中打开」（`metaOpenInSystem`）/「在文件夹中显示」（`metaRevealInFolder`）；过时注释与「内容请到编辑器查看」文案一并更正。
- `PageEditor.tsx` 归档分支改三分支：html → `WelcomeHtmlView`；文本类且已展开 → `ArchiveTextView`；否则 → `FileMetaCard`。换页重置展开态（`useEffect(..., [pageId])`）。

**现象**：非 md 归档文件（例：`.session.json`）在知识库中渲染成元信息卡，卡上「在编辑器打开」按钮**点击后没有任何可见反馈**（不跳转、不报错、卡片不变）。

**定位（完整链路）**：
- 按钮与派发：`src/modules/knowledge/components/FileMetaCard.tsx:30-36`（派发 `kb-open-note`）
- 转发：`src/App.tsx:555-565`（无条件转成 `kb-open-note-rel`）
- 接收：`src/modules/knowledge/index.tsx:817-825` → `openByRelPath`（`:803-810`）→ `handleOpenPage`（`:600-653`）

**根因 = 自环**：`openByRelPath` 第一步是 `allPages.find(p => p.path === relPath)` —— 归档非 md 文件**确实在 allPages 里**（主进程 `electron/lib/kbStore/knowledgeIndex.ts:582` 为它们建 `entryKind:'file'` 条目，`getKnowledgePages()` 会返回，`refreshAllPages` 装进 allPages）。于是命中 page 分支 → `handleOpenPage(同一条目 id)` → `:622-625` 发现该 id 已在 `openPageIds` 中 → 仅 `setActivePageId(同一个 id)` → **零可见变化**。

而这个按钮出现的前提就是「当前活动页 = 该归档条目」（`PageEditor.tsx:174` 的 `isArchiveFile` 分支 + `:986-992` 渲染 FileMetaCard）→ 点按钮时**必然**自环，不是偶发。

**第二层锁死**：`PageEditor.tsx:178` 的 `paneDoc` 条件显式排除 `!isArchiveFile` → 归档文件**永远进不了 MonacoPane**，即便绕过自环也**没有内容视图可落**。

**定性**：编辑区模块（`src/modules/editor`）在 Phase 2 批次 2/3 退役后，非 md 文件的内容查看通道随之消失。「在编辑器中打开」已是一个**没有承接方的空承诺**——连文案里的「编辑器」这个模块都不存在了。

**修复方向（三选一，待拍板）**：
- **A 补内容视图**：归档**文本类**扩展名在知识库内就地查看 —— 放开 `paneDoc` 对 `entryKind==='file'` 中文本类的排除，以只读 MonacoPane 呈现；按钮文案改「查看内容」。
- **B 改语义**：按钮改为「在系统中打开」/「在文件夹中显示」（`openExternal` / shell `showItemInFolder`）——对二进制、未知类型更实用。
- **C 最省**：非可查看类型直接隐藏按钮（不给空承诺），同时清掉卡内说明文案的「编辑器」字样。
- 倾向 A（覆盖文本类）+ B（兜底其余）；无论选哪个，至少要消除「点了没反应」。
- 顺带：`FileMetaCard.tsx:10` 注释「kb-open-note 闭环已有」已过时，需同步更正；说明文案（`:82`「内容请到编辑器查看」）同理。

**验证**：对 `.json` / 代码类归档文件点按钮 → 有明确可见结果（内容视图 / 系统打开 / 按钮不存在三选一，不得为无反应）；确认 md 归档路径不受影响。

---

## [x] B-4 左栏「大纲」按钮恒不可用（根因：md 知识页 fileType 为空串，连带 3 处按钮静默失效）（2026-09-21，P1）

**已修（2026-09-21，ui-rework 分支，未提交）**：按修复方向 1+2+4 单点收口，未在渲染层加任何 `|| ''` 兜底。
- **单一解析点**：把 id / title / fileType 三条缺省补全从 `knowledgeIndex.ts` 内联块抽出为**零依赖纯函数** `electron/lib/kbStore/mdEntryFields.ts` 的 `normalizeMdEntryFields(fm, rel)`，索引的 `.md` 分支**无条件**调用 —— `fileType` 不再只写在「无 frontmatter id」的 auto 分支里（这正是 B-4 根因）。
- 抽成独立文件的理由与 `releaseNotes/judge.ts` 同：契约脚本要能直接 `import`（`knowledgeIndex.ts` 走 extensionless 相对导入且间接引 `electron`，node 裸跑 import 不进来）。
- **写入侧**：`vaultCreatePage` 的 `fm` 补上 `fileType: data.fileType || 'md'` —— 原先那个 `fileType?` 参数是陷阱参数（传了却被静默丢弃），而更新路径 `vaultUpdatePage` 本来就写，导致「建页时缺、首次保存后才有」的窗口。
- **缓存杠杆**：`schemaVersion` 5 → 6 并提取为 `KNOWLEDGE_INDEX_SCHEMA_VERSION` 常量（接口声明 / 两处返回值 / 缓存校验点四处同源）。不 bump 则老仓库冷启动仍读 v5 磁盘缓存，装了修复表象照旧。
- **契约脚本**：`.AGENT/scripts/knowledge-index/verify-md-entry-fields.mjs`（29 项）—— 纯函数用例（含 B-4 主场景「有 id 无 fileType」与显式值不被覆盖的负向）+ 索引侧「不再直写 `frontmatter.fileType` / `.id`」的负向源码断言 + `vaultCreatePage` 写入断言 + schemaVersion 同源断言。
- 连带修好的其他 3 个表象（同一根因）：左栏非 md 自动回落文件树的 effect、「沉浸阅读 Ctrl+Shift+R」、AI 内联续写按钮 —— 均无需改码。

**现象**：知识库左栏「文件 | 大纲」切换行里，「大纲」呈灰色禁用态（`opacity-40`），点击无任何反应；**与当前页面有没有标题无关**（不管页面里有多少个标题都一样），hover 提示是「大纲（仅 md 页面可用）」。

**根因链（四层，已逐层实证）**：

1. **写入侧丢字段** — `electron/lib/kbStore/knowledgeVaultRepo.ts:263`：`vaultCreatePage` 构造 frontmatter 时**没有写 `fileType`**：
   ```ts
   const fm = { id, title: data.title || stem, tags: data.tags ?? [], starred: false, status: 'published', created: now, updated: now }
   ```
   而函数签名（`:255`）明明**接收**了 `fileType?: string` 参数 —— **传进来却被静默丢弃**。
   ★ 实证：演示仓库的页 frontmatter（`.AGENT/scripts/demo-seed/backup/md/408 学习空间/操作系统/进程管理/死锁.md:1-10`）只有 `id / title / category / tags / starred / sortOrder / created / updated`，**没有 fileType**。

2. **索引侧只在一半分支补** — `electron/lib/kbStore/knowledgeIndex.ts:650` 是 `fileType: asString(doc.frontmatter.fileType)`，而 `asString(undefined)` 返回 `''`（`:99-101`）。补 `fileType = 'md'` 的那行（`:560`）**只写在「无 frontmatter id」的 auto 兜底分支里**。
   → 反直觉结果：**应用内正式新建 / 导入的页（有 id）没有 fileType，反而从外部丢进来的无名 md 才有。**

3. **映射侧不兜底** — `knowledgeVaultRepo.ts:103` 的 `entryToPage` 原样透传 `fileType: entry.fileType`（无兜底）；而**同一函数的兜底分支** `:268` 却写死 `fileType: 'md'` —— 同一未知量两条路径给两个值，正是项目硬规则明令禁止的「多处各自兜底」。

4. **渲染侧严格判定被误伤** — `openPageInfos[pageId].fileType === ''` →
   - `src/modules/knowledge/index.tsx:1744` `activeIsMd = ... === 'md'` → **false** → 大纲按钮 `disabled`（**用户所报表象**）
   - `:1411` 同款门控的「非 md 自动回落文件树」effect（所以即便手动置为 outline 也会被立刻打回）
   - `PageEditor.tsx:904` AI 内联续写按钮 `fileType === 'md'` → **不渲染**
   - `PageEditor.tsx:956` 「沉浸阅读（Ctrl+Shift+R）」`fileType === 'md' || 'txt'` → **不渲染**
   - 反证：`PageEditor.tsx:301/303` 却**显式兜了空串**（`ft === ''`）→ 说明空串是**已知现象**，只是兜得零散不全。

**为什么界面看着一切正常**：`PageEditor.tsx:166` 的 `isCodeFile = fileType !== '' && …` 把空串归入"非代码"→ 落到 markdown 预览/编辑 → 正文渲染无恙。**只有严格 `=== 'md'` 的分支在静默失效**，所以这是"看起来没坏、功能悄悄少了几处"的类型。

**修复方向（优先单点收口，不要到处加兜底）**：
1. **首选：索引侧一处补全** —— 把 `knowledgeIndex.ts:560` 的 `doc.frontmatter.fileType = 'md'` 从 auto 分支里**提出来**，让 `:550-563` 的 `.md` 分支对所有 md 无条件补（frontmatter 已显式给则尊重原值）。上游一处解析、下游只收，连带修好全部 4 个表象，且不新增兜底点。
2. **顺带修 `vaultCreatePage`**：`:263` 的 `fm` 要么真正写入 `fileType`，要么把那个从没用上的 `fileType?` 参数删掉 —— 现在它是个**陷阱参数**（调用方传了以为生效）。
3. ⛔ **不要**在渲染层给每个 `=== 'md'` 各加一个 `|| ''` 兜底 —— 会把同一未知量散成 N 处（list-drift 教训）。
4. 注意缓存：fileType 由 frontmatter 读取产出，改映射逻辑后需 `invalidateKnowledgeIndex()` 让索引重建，否则旧缓存里仍是空串；必要时确认 `knowledgeIndex.ts:686` 的 `schemaVersion: 5` 是否要 bump。

**验证**：打开任一**正式 md 知识页** → 左栏「大纲」变可点、点后列出标题；更多菜单出现「沉浸阅读」；md 页工具条出现 AI 续写按钮。契约建议：给索引加断言「有 id 的 md 条目 `fileType === 'md'`」，防回归。

---

## [x] B-5 「AI 续写建议」感觉不可用（三重死锁：自动暂停 / 总闸不回血 / 全程无反馈）（2026-09-21，P1）

**已修（2026-09-21，ui-rework 分支，未提交）**：拍板结果 = **✨ 单击语义保持不变（总开关）**（2026-09-20 定，不回退）+ 阈值**放宽到 5**。故本轮做 A / D + C 的一部分，**不做** B（按钮语义）。
- **方案 A（核心，自愈）**：`MonacoPane.tsx` 新增具名 `resetInlineAutoPause()`（重置 streak / 暂停 / 待结算记账 + 广播「已不在暂停」，内部走纯函数 `reviveByManual()`）；Alt+A 手动入口改为调它（原先内联 `{...INITIAL_AUTO_STATE}` + 手写广播）。新增**总闸 / 自动开关 false→true 边沿 effect** 调它 —— 这条边上原先什么都不做，正是「点两次 ✨ 之后自动建议依然是停的」。★ 两个刻意的取舍：① 重置**不能**放进 `setInlineAutoMode`（那是渲染期调用的，会同步触发宿主 setState → 跨组件渲染期更新告警）；② `prevRef` 初值给 `false`，**首次挂载也重置**（总闸可能在设置页被打开过，且「打开一篇文档」本就该算新的写作时段）。
- **方案 D（暂停可发现）**：`PageEditor` 的 `onInlineSuggestPaused` 从裸 `setInlinePaused` 换成 `handleInlinePaused` —— 进入暂停时给一次 Toast（带「按 Alt+A 可随时要一条」），用 `inlinePauseNotifiedRef` 保证每轮暂停只提示一次（唤醒后复位）。
- **C 的一部分**：总闸关闭时按 Alt+A 原先被 `fireInlineTrigger` 的 `inlineOnRef` 闸门**静默吞掉**（按了键零反馈，是「不知为何」的另一半来源）→ 现在按 `triggerInlineSuggest()` 的返回值判定，确因关闭才给提示。视觉开关反馈（开/关只差一档灰度）由 **B-6** 承接，避免同一处代码改两遍。
- **阈值**：`AUTO_PAUSE_STREAK` 3 → 5（`src/lib/inlineSuggestTrigger.ts`）。
- **契约**：`verify-perception.mjs` 从 J16 起新增 17 项断言（单一重置入口 / 两条边沿 / 三条**负向**：重置不得进 `setInlineAutoMode`、不得在渲染期调、不得直连裸 `setInlinePaused` / 暂停提示记账位 / Alt+A 提示 / 探针轮数派生）。原 J15i、J15l 的「3 次」硬编码用例改为按阈值派生，J15u 改为断言具名重置。
- **顺带修**：该脚本的 `ROOT` 原写死 `E:/Projects/KnowledgeRecorder` → 在 worktree 里跑会**静默校验主仓**（脚本全绿而实际改的是另一棵树）。改为 `resolve(import.meta.dirname, '..','..','..')`，与多数脚本口径一致。
- **探针**：`probe-batch5-ai.mjs` 的 G11 轮数改为从源码读 `AUTO_PAUSE_STREAK` 派生（写死 5 轮会随阈值调整假失败）；新增 G11c（暂停 Toast，用 MutationObserver 采集 —— Toast 会自行退场，事后查 DOM 必假 FAIL）与 G6c（总闸关闭时 Alt+A 给出提示）。

**现象**：写作时 AI 建议突然不再出现；点工具栏的 ✨ 按钮「好像不能用，不知为何」——点了之后界面上看不出任何变化，也不产生建议。

**这不是坏了，是三件事叠成的死锁**（每步都有代码实证）：

1. **自动通道会静默暂停** — `src/lib/inlineSuggestTrigger.ts:18` `AUTO_PAUSE_STREAK = 3`：连续 **3 次**「发了建议但用户没按 Tab 采纳」→ `paused = true`（`:80-84`）。之后自动通道在 `MonacoPane.tsx:445` `if (!canAutoRequest(...)) return` 直接返回，**不再发任何请求**。
2. **暂停的唯一提示是 1.5px 灰点** — `PageEditor.tsx:925` `{inlinePaused && inlineOn && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--text-disabled)]" />}`。胶囊静息态还会 `opacity: .62 + scale(.97)`（`index.css:1346-1349`）→ 基本看不见。
3. **点 ✨ 的语义与用户预期相反** — `PageEditor.tsx:910-918` 的 onClick 只做一件事：**切总开关**。
   - 开着点 → `cancelInlineSuggestInFlight()` + `hideInlineSuggest()` + `update('aiAssistantInlineSuggest', false)` → **把功能关掉**（用户以为在"要一条建议"，实际是把 AI 建议关了）；
   - 关着点 → `update(..., true)`。
   - ⛔ **它从不调用 `triggerInlineSuggest()`** —— 而"要一条 / 唤醒暂停"恰恰只有那个入口会做（`MonacoPane.tsx:425-430`：`settleAutoOutcome()` + `inlineAutoState = {...INITIAL_AUTO_STATE}` + 通知 listeners）。
4. ★★ **关掉再打开也不会自愈** — `MonacoPane.tsx:748` 是**模块级变量**：
   ```ts
   let inlineAutoState: AutoState = { ...INITIAL_AUTO_STATE }
   ```
   总闸（`inlineOnRef`）与暂停态（`inlineAutoState`）是两套东西；总闸 false→true 的路径上**没有任何地方重置 paused**（`:230-235` 只同步 `inlineOnRef` 与 auto mode）。→ 用户点两次 ✨ 之后，自动建议**依然是停的**。
5. **唯一出路是 Alt+A，且它会被静默吞掉** — `PageEditor.tsx:353-360` 注册了 Alt+A → `triggerInlineSuggest()`。但 `fireInlineTrigger` 第一道闸是 `if (!inlineOnRef.current) return false`（`MonacoPane.tsx:411`）→ **若总闸此刻是关的（第 3 步刚被点关），Alt+A 静默返回、无任何提示**。而"Alt+A 能唤醒"只写在按钮 hover 的 title 里，用户根本不知道有"暂停"这回事。

**用户实际经历的路径**：写三段没采纳 → 自动静默暂停（看不见）→ 觉得没建议了 → 点 ✨（以为要一条）→ **实际把 AI 建议关了** → 再点 ✨ → 打开了但自动仍是停的 → 结论「不能用，不知为何」。

**修复方向**（建议全做，成本都不高）：
- **A 最小修（必做）**：总闸 false→true 的边沿重置暂停态 —— 在 `MonacoPane` 里监听 `inlineSuggestEnabled` 变 true 时 `inlineAutoState = {...INITIAL_AUTO_STATE}` 并 `inlinePausedListeners.forEach(fn => fn(false))`。（`setInlineAutoMode` 处同理处理 auto 开关的 false→true。）
- **B 按钮语义**：让单击 ✨ **至少等于"要一条"**（调 `paneRef.current?.triggerInlineSuggest()`，它自带唤醒+重置冷却）；"关闭整个功能"挪进「更多」菜单或长按/右键。★ 但按钮现有语义是 2026-09-20 拍板定的（原注释：「原『触发一次』定位不明、开了关不掉」）→ **改前需拍板**，别擅自回退。
- **C 任何点击必须有可见反馈**：现在点 ✨ 后界面零变化（开关两态的视觉差别只有 `--text-secondary` vs `--text-disabled`，几乎看不出）。这条与 B-6 互为解法。
- **D 暂停要可发现**：首次进入暂停时给一次提示（toast / 状态栏「自动建议已暂停 · Alt+A 唤醒」），别让它静默发生；`AUTO_PAUSE_STREAK = 3` 也偏激进，可考虑放宽。

**验证**：连续 3 次不看建议 → 出现可见的暂停提示；点 ✨ → 有明确可见的状态变化且能重新拿到建议；把总闸关掉再打开 → **自动建议恢复**（当前不会）；总闸关闭时按 Alt+A → 有提示而不是静默无效。

---

## [x] B-6 【需求】AI 建议按钮的状态用颜色 + 闪烁区分（四态配色）（2026-09-21 细化，P2）

**已修（2026-09-21，ui-rework 分支，未提交）**：拍板结果 = **「关」用 `--danger` 降一级表达**（同色 + `opacity-70`，hover 回满）+ **关态叠斜杠**（色盲兜底）。
- 四态落地在 `PageEditor.tsx` 的 `inlineStateClass` 单点表达式（不在 JSX 里散写三元）：生成中 `--success`（沿用 `animate-pulse`）/ 关 `--danger opacity-70` / 暂停 `--warning` / 开 `--success`。**短路顺序刻意保持**：`inlineBusy` 恒在最前、`inlinePaused` 插在「开」之前。
- 生成中角标 `data-wb="inlineBusy"` 由 `--warning` 改 `--success`（配色与按钮一致）。
- 关态斜杠：`data-wb="inlineOffSlash"`，`bg-current` + 静态 `rotate(-45deg)`（不用 Tailwind `rotate-*` —— 铁律 13 那条约束针对「要动画的旋转」，此处无过渡）。
- 暂停角标 `data-wb="inlinePaused"` **刻意保持中立灰**：按钮本身已变黄表达暂停，角标再黄就糊成一团；灰点是黄图标旁清晰可辨的独立标记。保留它同时满足探针 G11/G11b 锚点。
- 按钮加 `hover:bg-[var(--bg-hover)]`（原来靠 `hover:text-*`，现在四种态各有专属色，文字 hover 会与状态色打架）。
- **契约**：`verify-perception.mjs` 新增 J17 共 9 项（短路顺序按 index 断言 / 三色令牌齐备 / `opacity-70` 降级 / 斜杠 / 只有生成中挂 `animate-pulse` / 三个探针锚点未破 / `data-wb-inline-off` 语义不变）。
- **探针**：`probe-batch5-ai.mjs` 新增 G3e（关态有斜杠）、G3f（关态不透明度 < 1 = 降级红）、G3g（开态斜杠消失、不透明度回满）、G3h（开/关两态计算色确实不同 —— 不锁具体色值，避免换主题即假失败）。
- ✅ **口径已定（2026-09-22 用户回复：「就按照原文实现，四个状态四种颜色状态表示」）** —— 原先那处「选项预览把『开』画成灰白 vs 原文『开 = 绿色常亮』」的差异，**以原文为准**：开 = 绿色常亮。这与当前实现（`inlineStateClass` 末行 `--success`）一致，**无需改码**；上一条「待你确认」的记录由本条取代。

**用户口径（2026-09-21 细化版，取代上一版「开=绿闪 / 关=黄静」）**：状态分四态，各给一个信号 ——

| 状态 | 用户要求 | 对应代码变量（`PageEditor.tsx:905` / `:924`） |
|---|---|---|
| **开** | **绿色**（常亮） | `inlineOn && !inlineBusy && !inlinePaused` |
| **关** | **红色**（常亮） | `!inlineOn` |
| **生成中** | **绿色闪烁** | `inlineBusy` |
| **暂停** | **黄色** | `inlinePaused && inlineOn` |

**背景**：原诉求是"收起态下看不出开关状态"——因为现状「开 / 关」只差一档灰度（`--text-secondary` vs `--text-disabled`），其余两态是 `--warning` + pulse（生成中）与角上 1.5px 灰点（暂停）。四态各占一色后，"收起只剩图标"时状态依然可读。

**现状**（`PageEditor.tsx:909-926`）：
```tsx
className={`relative p-1.5 rounded transition-colors ${inlineBusy ? 'text-[var(--warning)]' : inlineOn ? 'text-[var(--text-secondary)]' : 'text-[var(--text-disabled)]'}`}
<Sparkles size={15} className={inlineBusy ? 'animate-pulse' : ''} />
{inlinePaused && inlineOn && <span data-wb="inlinePaused" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--text-disabled)]" />}
```
★ 改造时保持既有的**短路顺序**：`inlineBusy` 判定必须在最前（生成中优先级最高），`inlinePaused` 插在 `inlineOn` 之后。`data-wb` 锚点（`inlineSuggestBtn` / `inlineBusy` / `inlinePaused` / `data-wb-inline-off`）是探针 G 系依赖的，**不能改**（`:902` 注释已声明）。

**主题变量已具备**（`styles/index.css:26-34` dark / `:78-85` light）：`--success` / `--warning` / `--danger` 三色齐备。
- light（`index.css:68-85`）：`--success #107c10`（标准绿）｜`--warning #8a6d15`（**暗土黄**）｜`--danger #d01020`
- dark（`index.css:14-34`）：`--success #4ec9b0`（★ **偏青绿/薄荷，不是正绿**）｜`--warning #c5a332`（亮黄）｜`--danger #e81123`
→ 两个主题的观感会有差：light 下"黄"偏暗、dark 下"绿"偏青。四态配色建议**实机双主题各看一遍**再定稿。

**动画成本：这一版更省，是好事** ——「生成中 = 绿色闪烁」**只需把现有颜色从 `--warning` 改成 `--success`，动画沿用 `animate-pulse`**（`:924` 现在挂的就是它）→ **不新增动画类、免补基建、也无"常驻闪烁噪音"问题**（相比上一版"开=绿闪"要新造常驻脉冲类，这版只让"生成中"闪，而它本来就是短暂态）。✅

**两条实施提示（需知道，非反对）**：

1. ★ **「关 = 红」会借用到 `--danger` 的语义**：项目里红色专指**危险 / 删除** —— `.desk-del:hover`、`kb-delete-fade` / `kb-wipe-*` 删除动画、危险确认按钮（`variant: 'danger'`）、多处 `hover:text-[var(--danger)]`。把"AI 建议已关闭"标红，等于让一个**正常可关的状态**穿上"危险动作"的色。你的直觉（红绿 = 电源指示灯的普适开关语汇）是成立的、也确实最醒脑，只是要知道这层借用。若想两全，可让"关"用**红但降一级表达**（如只描边/降不透明度，而非满色），与"删除红"拉开一点体感。
2. ★★ **红绿是色盲最难区分的一对**（红绿色弱约占男性 8%），而这两个颜色这里恰好承担最关键的"开 / 关"，且图标**形状完全相同**（同一个 `Sparkles`）→ 色弱用户会完全看不出区别。建议颜色之外再加**一点形状/符号差异**（例如关闭态给图标加一条斜杠、或降为空心/描边版）。成本极低，收益是这四态对所有人都可读。
   （同胶囊内另有一处同色不同义可接受：保存点 `:881` 的「绿常亮 = 已保存」与本按钮「绿常亮 = 开着」——同为"正常态"，不会误导。）

**收起态上下文**：工具栏是 `[data-wb='floatBar']` 悬浮胶囊（`index.css:1334-1356`），静息态会 `display:none` 掉所有标了 `.kb-float-hide` 的次级钮；✨ 按钮**没标该类**，所以收起态它照样可见 —— 这正是状态要靠颜色表达的原因。

**验证**：四态逐一实机核对 —— 开=绿、关=红、生成中=绿且脉冲、暂停=黄；切 light / dark 两主题各看一遍（尤其 light 下 `--warning` 的暗土黄 #8a6d15 是否够醒目）；跑探针 G 系确认 `inlineSuggestBtn` / `inlineBusy` / `inlinePaused` / `data-wb-inline-off` 四个锚点语义未变。

---

## [x] B-7 【需求】笔记区左栏头部那排按钮加一个「+」（新建页面 / 目录）（2026-09-21，P2）

**已修（2026-09-21，ui-rework 分支，未提交）**：拍板四答 = 菜单三项（知识页/目录/分类目录）· **引入「选中目录」** · 点＋弹小菜单 · 显隐与聚焦按钮一致。原型 `E:/tmp/b7-tree-new-prototype.html`（不进 git），方案 `.claude/plans/B-7-tree-new-button.md`。
- **新增「选中目录」概念**（`knowledge/index.tsx:106`）：`selectedDirRel` + 镜像 ref（快捷键 effect 内读，避免监听器随每次点目录重建——同 `activePageIdRef` 的理由）。语义**一次点击即更新**：点目录行 = 该目录（**展开/收起照旧不变**）、点文件行 = 其父目录；进空间 / 图谱态清空。
- **落点唯一真相源** `treeLandDir()`（`:906`，读 ref 所以 deps 为空、恒等稳定）：头部「＋」与 **Ctrl+N 共用**。连带修正：Ctrl+N 原为**恒落仓库根**，现跟随选中目录。
- **VaultTree 两个新 props 全 optional**（`selectedPath` / `onSelectDir`）→ 编辑器侧的文件树不传即行为完全不变，零回归。顺带把三处重复的 `split('/').slice(0,-1).join('/')` 收成 `parentDirOf()`。
- **选中态视觉 = 方案 A**（原型 A/B 两案对比后拍板）：左缘 2px `--accent` 竖条、**不铺底色** —— 文件的「正在看」已占用蓝底，同底色会让人以为目录被打开了。锚点 `data-wb="treeDirSelected"`。
- **新组件** `src/components/shared/TreeNewButton.tsx`：按钮 + 弹出菜单（`kb-pop`，portal 到 body——模块槽是窄包含块，就地 absolute 会被压成竖条，同 `treeMenu` 的理由）。菜单项 props 化（`TreeNewMenuItem`），shared/ 里不含 knowledge 词汇。按钮 `data-wb="treeNewBtn"`、菜单项 `data-wb="treeNewItem-{key}"`。
- **两项保护**：① 落点目录若收着，先**强制展开**再进内联输入 —— 否则输入框渲染在收起子树里，表象是「点＋没反应」；②「新建分类目录」恒落仓库根（既有设计：分类 = 顶层容器，`parentId:null`），选中子目录时菜单项右侧加 **「根层」小字**而非置灰（置灰会先被当成 bug）。
- **不抽公共菜单**：左栏右键菜单项集不同（含打开/重命名/删除），强行合并要引入 `showSelfActions` 之类开关，比两份 6 行 onClick 更贵。**分叉风险已消除** —— 真正的真相源是 `handleTreeCommitCreate` / `handleCommitCategory`，不是菜单项列表。
- **复用而非新写**：三项分别接 `setTreeCreating({type:'knowledge'|'dir'})` 与 `setCatDraft`，未新增任何创建逻辑。
- **门禁**：`tsc --noEmit` node + web 双门禁 EXIT 0；`npm run build` EXIT 0。

---

**用户口径（原文）**：在笔记区的这一排按钮中添加一个「+」按钮，用于新建页面和目录。
（截图指的就是左栏模块态头部那一排：**🏠 返回 ｜ 🔒 锁定 ｜ [模块动作槽]**，笔记态时最右是「聚焦」按钮。）

**宿主结构（现状）** — `src/components/workbench/WorkbenchLeftPanel.tsx:267-282`：
```tsx
<div data-wb="mod" data-wb-mod={railModule ?? railTool} className="flex h-8 shrink-0 items-center justify-center gap-1 px-1.5">
  <button onClick={onBack}>🏠</button>
  <button onClick={onToggleLock}>🔒 / LockOpen</button>
  <div ref={modActionsRef} className="flex items-center gap-1" />   {/* ← 模块动作槽 */}
</div>
```
★★ **`justify-center` 是刻意的**：2026-09-19 二次反馈明确要求「不要贴右，所有按钮居中放一起」（见 `:279-280` 注释）。新增按钮必须**同组居中**，不能另起靠右。

**推荐的挂载方式**：**由 knowledge 模块 portal 进 `modActionsEl`**，与现有的聚焦按钮完全同款 —— 范例在 `src/modules/knowledge/index.tsx:1727-1735`（`FolderFocusButton` 的 portal）。理由：
- 新建的全部状态与逻辑本来就在 knowledge 组件内（见下），portal 不产生反向依赖；
- `WorkbenchLeftPanel` 保持「纯受控展示」口径（`:27` 注释），不被塞进业务逻辑；
- 自动与三钮同组居中，满足上面那条反馈。

**已有可复用能力（新建逻辑齐备，不必新写）** — 全在 `src/modules/knowledge/index.tsx`：
| 能力 | 位置 | 说明 |
|---|---|---|
| `handleTreeCommitCreate(dirRel, type)` | `:859` | 支持三种 intent：`'file'`（空 md）/ `'dir'` / **`'knowledge'`（写 frontmatter id 的正式知识页，建完自动打开，见 `:867-877`）** |
| `setTreeCreating({ dirRel, type })` | `:99` 附近 | 触发树内联输入 |
| `handleCommitCategory(name)` + `setCatDraft` | `:844` | 新建**分类目录**（顶层 mkdir + `categories.json` 登记） |
| VaultTree 内联输入 UI | `:1786-1788`（`creating` / `onCommitCreate` / `onCancelCreate`） | 已存在，可直接复用 |

**★ 四个必须先拍板的歧义（不替用户决定）**：

1. **「+」里放哪几项？** 用户原话「新建页面和目录」→ 至少 2 项。现有候选共 4 个：新建页面 / 新建文件 / 新建目录 / 新建分类目录（后两者在左栏右键菜单里已有）。
2. **"新建页面"指哪一个？** 现有代码里这是**两个不同 intent**，不能混：
   - `'file'` = 写一个空 `.md`（左栏右键菜单的「新建文件」用的就是它）
   - `'knowledge'` = 写**带 frontmatter id 的正式知识页**（建完自动打开）
   → 需要定"页面"是哪一种（或两种都给）。
3. ★★ **新建到哪里？** 右键菜单里 `dirRel` 由**被点中的节点**派生（目录取自身 / 文件取父目录，`:1823`）；而头部「+」**没有"当前节点"这个概念**。候选：
   - a) 当前**活动页**所在目录（无活动页 → 仓库根）—— 零新增状态，最省；
   - b) 固定落在**仓库根**；
   - c) 给 VaultTree 引入「选中目录」概念 —— 但 VaultTree 现在**只有 `activePath`、没有 selected**（B-2 的重命名/删除也需要它）→ 属扩大改动。
   这条直接决定交互，**建议先定它**。
4. **交互形态**：点「+」弹小菜单 → 选类型 → 再进内联输入；还是点「+」直接就进内联输入（复用 `treeCreating`）？

**连带与注意事项**：
- 与 **B-2**（右键菜单缺删除）同属「条目维护」动作族，**建议一起设计**：头部「+」管新建、右键菜单补齐 删除 / 重命名。可以分批评，但形状最好一次定，免得两处二次返工。
- **显隐口径**：现有聚焦按钮的 portal 条件是 `sidebarVariant === 'knowledge' && !selectedSpaceId && !graphMode`（`:1728`）。「+」是否同样排除图谱态 / 空间态，需一并定。
- **探针影响已核**：`probe-batch5-ai.mjs:292` 的 C1「头部三钮合组居中」测的是**总览态**的 🔖/🔍/🌳（`:276-291`），与模块态这排无关；`probe-mod-header.mjs` 的断言是模块容器/标题行残留，也没有按钮计数。→ 新增按钮不会打破既有断言。但落地后仍要跑 `verify-workbench-shell.mjs`（139 项）+ 这两个探针，并复看有无「零残留 / 计数」式断言会被打破（★ v3.4.0 契约 G 段负向断言锁死新实现的教训）。
- 新按钮建议加 `data-wb` 锚点（如 `data-wb="treeNewBtn"`），便于探针断言。

**验证**：点「+」→ 出现菜单/内联输入 → 提交后左栏树刷新、新建项位置符合拍板口径（按 intent 决定是否自动打开）；图谱态/空间态下的显隐符合拍板结果；既有探针与 139 项契约全绿。

---

## [x] B-8 AI 教学区按 Ctrl+J 会唤出「AI 助手」（规格违背；且只禁一半）（2026-09-21，P1）

**已修（2026-09-22，ui-rework 分支，未提交）**：拍板 = **只禁 aiTeaching**（其他整窗模块里问 AI 是合理用法，不禁）+ 教学区按 Ctrl+J **完全无反应**（不改成「聚焦教学区自己的输入框」）。
- **具名清单唯一真相源**：`workbenchLayout.ts` 新增 `AI_ASSISTANT_SHORTCUT_DISABLED: readonly TabName[] = ['aiTeaching']`（该文件保持零 value import，契约脚本 strip-types 直跑不炸）。
- **App 侧**：`activeTab` 派生 `aiShortcutDisabled`，与 `suspendShortcut` **并列**传给悬浮面板。★ **取舍：没有按条目原文的「最小改法」并进 `suspendShortcut`** —— 那个 prop 的语义是「宿主接管了 Ctrl+J」，而**工作台内它恒为 true**；把 Ctrl+Shift+J 一并挂上去会连带**废掉工作台里现有的 Ctrl+Shift+J「全屏学堂」**，超出本条目范围，故新增独立 prop、旧语义保持不动。
- **面板侧**（`AssistantPanel/index.tsx`）：新 prop `aiShortcutDisabled`；**Ctrl+J 与 Ctrl+Shift+J 两条分支一起闸**（后者原先**不检查任何闸门** —— 这正是「只禁一半」的成因）；禁用时**不** `preventDefault`（按拍板口径「完全无反应」，别把按键吞掉影响别处）；**Esc 分支刻意不动**（面板若已开着，仍须能退出）。
- ★ **补一条（2026-09-22 第二轮拍板）：进 AI 教学区时自动收起浮层** —— 只禁快捷键**不够**。复核时发现另一条残留路径：浮层是 `fixed z-40` 且**渲染后不随切 Tab 自动收**，所以「工作台按 Ctrl+Shift+J 唤起 → 收起 → 点进 AI 教学区」这条路上浮层仍开在那里，与教学区自带对话区并排 = 同屏两块对话，**换个入口又回来了**。落地：`AssistantPanel` 加 `useEffect(() => { if (aiShortcutDisabled) closeAll() }, [aiShortcutDisabled, closeAll])`。**幂等**（本就关着时 `closeAll()` 是空操作）、**不做边沿限制**（启动即停教学区的场景同样该收）。Esc 分支仍不动。
- **顺带清死监听**：`ai-assistant:toggle` 全仓 grep 只剩监听 + 注释、**零派发方**（右下浮钮 2026-09-16 已删）→ 删掉监听 useEffect，同步更正三处过时注释（App / AssistantPanel 两处）。
- **契约**：`verify-perception.mjs` 新增 **J19 共 12 项（J19a–J19l）** —— 清单真值 import 断言（恰 `aiTeaching` 一项）/ 具名导出 / App 由清单派生闸门（非写死）+ 透传 / **两条分支按区间切片**断言（防「只闸一条」复发）/ 禁用时不 preventDefault / 两条**负向**字面量（App 闸门行与面板组件内零 `aiTeaching`）/ 全 src 零 `ai-assistant:toggle`（附「扫到 >100 文件」防空集假通过）/ **J19l = 自动收起 effect**。
- **门禁**：`tsc --noEmit` node + web 双 EXIT 0；`npm run build` EXIT 0；`verify-perception.mjs` **235 项全绿**（223 → 235）；`verify-workbench-shell.mjs` 139 项全绿。
- ✅ **真机已验证（2026-09-22，build 产物 + CDP）**：新增探针 `.AGENT/scripts/workbench-shell/probes/probe-b8-ai-shortcuts.mjs`，**15/15 全绿** —— 设置页 Ctrl+J 唤出浮层 / Ctrl+Shift+J 进全屏学堂（**禁用范围没扩散**）→ **点进 AI 教学区浮层自动收起**（拍板③直接证据）→ 区内 Ctrl+J、Ctrl+Shift+J **零响应且 `hits=0`**（用 MutationObserver 计次，排除「闪一下又收」的假 PASS）→ 工作台 Ctrl+J 仍唤出右栏 AI 侧栏、再按收起（开/关两态都测）→ 回设置页两条快捷键仍可用（幂等：禁用跟着模块走，不是一次性关闭）→ console 零 error。
- 探针顺手修一处**假 PASS 隐患**：`run-probe.mjs` 的 CDP 端口原**写死 9222**，而本机常驻的 WorkBuddy 自己就占着 9222 → electron 报 `bind() ... 只允许使用一次`、探针等不到 page target 直接失败（**不是被验证的代码有问题**）。改为 `KNOWBASE_PROBE_PORT` 可覆盖（宿主与探针读同一变量），默认值不变、不影响既有探针。


**用户口径（原文）**：在 AI 教学区居然可以 Ctrl+J 唤出 AI 助手，**其实这是不允许的**。

**现象**：在 AI 教学（整窗模块）里按 Ctrl+J，右侧滑出一个悬浮「AI 助手」面板 —— 与 AI 教学自带的对话区并排叠着，**同一屏出现两块 AI 对话**。

**机制（三条链路串起来，全部有据）**：
1. `src/App.tsx:1073` `fullWindowTab = activeTab !== null && WORKBENCH_TABBAR_EXCLUDED.includes(activeTab)`
2. `aiTeaching` **就在这个清单里** —— `src/lib/workbenchLayout.ts:134`：
   ```ts
   export const WORKBENCH_TABBAR_EXCLUDED = ['aiTeaching','devtools','moments','toolbox','plugins','recycle','settings']
   ```
3. 于是：
   - `App.tsx:1099` Ctrl+J 路由遇整窗模块 **直接 return**（不管）；
   - `App.tsx:1443` `suspendShortcut={!fullWindowTab}` → 整窗模块时为 **false**；
   - `AssistantPanel/index.tsx:160`「`if (suspendShortcut) return`」不生效 → **它自己 openPanel()** → 唤出悬浮助手。

**定性**：不是逻辑写错，是**规则漏了一条语义**。现行设计是「工作台内 Ctrl+J → 右栏 AI 侧栏；整窗模块 → 悬浮 AI 助手」，本身自洽；漏的是「**AI 教学区自己就是 AI 对话区**」——在那里再唤起一个 AI 助手，等于同屏两块对话，语义重复、还容易问错对象。

**★ 连带缺口（只禁 Ctrl+J 等于只禁一半）**：
`AssistantPanel/index.tsx:154` 的 **Ctrl+Shift+J**（全屏学堂 / 侧栏↔全屏切换）分支 **不检查 `suspendShortcut`** —— 那个检查只写在 `:160` 的 Ctrl+J 分支里。→ 在 AI 教学区按 Ctrl+Shift+J **仍会唤起/全屏悬浮助手**。要禁就得连它一起。

**修复方向**：
- **最小改法**：`App.tsx:1443` 的 `suspendShortcut={!fullWindowTab}` 扩成「整窗模块 **或** AI 教学区」；并把 `AssistantPanel` 的 **Ctrl+Shift+J 分支也纳入 suspend 判定**（否则半禁，见上）。
- ★ **别在 App 里写死 `'aiTeaching'` 字面量** —— 扩成 `workbenchLayout.ts` 的具名清单（例如 `AI_ASSISTANT_SHORTCUT_DISABLED: readonly TabName[] = ['aiTeaching']`）作为唯一真相源，App 与 AssistantPanel 都读它，并补契约断言。这正是 list-drift 的防线（同一份清单被抄成多份 → 改动只落到几处）。
- **待拍板**：其他整窗模块（recycle / toolbox / plugins / settings / moments / devtools）是否一并禁用？常识上「在设置、回收站里问 AI」是合理的，**AI 教学区是唯一自带对话的模块** → 建议只禁 aiTeaching，但要你确认。
- 参考：如果将来想让 AI 教学区按 Ctrl+J 有反馈，也可以改成「聚焦 AI 教学自己的输入框」；但按你的口径（"不允许"），保持**完全无反应**最省。

**顺带发现（低优先级，可同批清）**：`ai-assistant:toggle` 事件**已无派发方** —— 右下浮钮在 2026-09-16 删除（`App.tsx:1427-1428` 注释留有说明），`AssistantPanel/index.tsx:180-185` 的监听因此成了**死监听**（与之前清掉的 `kb-editor-doc-changed` 同类遗留）。

**验证**：AI 教学区按 Ctrl+J / **Ctrl+Shift+J** → 均无反应；切回工作台按 Ctrl+J → 正常唤出右栏 AI 侧栏；其他整窗模块的行为符合拍板结果。

---

## [x] B-9 【需求】全局统一「插件」图标：拼图（Puzzle）→ 箱子（左栏那个）（2026-09-21，P2）

**已修（2026-09-22，ui-rework 分支，未提交）**：按 09-21 已定拍板执行 —— 只统一「插件」概念（15 处），`TAB_ICONS` 整表不动，**web-clipper 那处保留 Puzzle**。
- **基建（B-9 实施要点 2）**：`ModuleIcons.tsx` 的 `IconProps` 补可选 `strokeWidth`，`Svg` 用 `strokeWidth ?? 1.6` → 插件市场空态那个 40px 大图标仍是 **1.2**（大尺寸下 1.6 偏粗）。`StyleAware` 把线宽**只透传给手绘包**：classic140 包自带 1.5、插件 SVG 包是第三方 `<svg>` 原样注入 —— 「各显其形」是本图标系统的既有设计，不为统一线宽去改它们（注释里已写明）。
- **15 处全部改走 `<PluginIcon …/>`**（StyleAware）：页面条 plugins 页签 / 插件市场空态 40px + 左栏标题 / 插件工具页头 / 知识库插件视图入口 + 全屏覆盖层头 / PluginSlotEntry 两处 / 博客「来自插件的模板」/ 新手引导三处 / PluginIconImg 兜底 / 设置→外观「来自插件的主题」；`pluginService.ts:144` 的 helpDocs 默认 icon 名 `'Puzzle'` → `'Package'`（消费方是 lucide 名字解析）。
- ★ **全仓没有一处直写 lucide 名绕过 StyleAware** —— 这是 B-9 实施要点 1 的防线（直写当下看着一样，切图标风格时这些地方不跟随而左栏跟随 → 下一轮不一致）。
- **连带放宽两处类型注记**（不做则 `tsc` 必红）：`Onboarding.tsx` 的 `SCENE_META` / `ACTIVITY_MODS` 原写 `icon: typeof PenLine`（lucide 组件类型，装不下普通函数组件的 `PluginIcon`）→ 抽 `type ModuleIconComp = React.ComponentType<{ size?: number; className?: string }>`，同一文件三处 icon 位置共用。
- **契约**：新增 `.AGENT/scripts/plugin-icons/verify-plugin-icons.mjs` **20 项** —— ① 全 src 剥注释后 `Puzzle` **只允许**白名单 web-clipper 一个文件（附「扫到 >100 文件」防假通过）+ **反向断言**白名单那处仍在（防「顺手统一」改错）；② 9 个文件 15 处按 JSX 具体属性逐点接线；③ **负向**：这些文件不得直写 `<Package …>`；④ IconProps/Svg 线宽通道三条（含负向不得写死 1.6）；⑤ `pluginService` 默认名 `Package` 且不得回 `Puzzle`。
- **顺带修正**：`verify-workbench-shell.mjs` 的 `ROOT` 原**写死主仓绝对路径** → 在 worktree 里跑会**静默校验另一棵树**（脚本全绿而实际改的是这里，最难查的一类假 PASS）→ 改为按脚本自身位置解析（同 B-5 对 `verify-perception.mjs` 的处理）。修后重跑 **139 项全绿**（校验的是本树）。
- **门禁**：`tsc --noEmit` node + web 双 EXIT 0；`npm run build` EXIT 0；契约 235 + 139 + 20 + 18（tree-create-channels）+ 29（md-entry-fields）**全绿**。
- ✅ **真机已验证（2026-09-22，build 产物 + CDP）**：新增探针 `.AGENT/scripts/workbench-shell/probes/probe-b9-plugin-icons.mjs`，**11/11 全绿** —— 通过**设置页 UI 真点**切包（不是直接写设置）：手绘包下活动栏「插件市场」`stroke-width=1.6`、classic140 下换成 lucide Package `=1.5`（每次 outerHTML 都不同 = 确实在跟随）；插件市场页左栏「插件」标题（12px）同样跟随；★★ **详情空态 40px 大图标在手绘包下 = 1.2**（B-9 新增的 `strokeWidth` 通道真生效）、classic140 下 = 1.5（各显其形，没把线宽硬塞给别的包）。
- ★ **负向检查（本次改动的可反查签名）**：裸 lucide 的**默认 `strokeWidth = 2`** —— 探针在各观测点断言**无一处 `stroke-width="2"`**，即「改漏了直接裸写 lucide」这条漏法能被自动抓到，不用靠肉眼看。收尾把 `sidebarIconStyle` 复原成探针进场时的值（本机 dev = classic140）。
- ⚠️ **覆盖口径（诚实声明）**：探针覆盖运行时**可达**的 4 个站点；其余站点（页面条 plugins 页签 / 工具箱注册表 / 知识库插件视图两处 / 博客模板弹窗 / PluginSlotEntry 两处 / 新手引导三处 / PluginIconImg）由契约脚本逐点核对 JSX 覆盖。**插件 SVG 包分支**（第三方 `<svg>` 原样注入）本机**无插件贡献 `sidebarIcons`**（查 dev userData 的 5 个已装插件均无），无法真机验证 —— 该分支只由源码断言覆盖。
- 备注：`plugins/index.tsx` 的 lucide `Package` 是**改动前就存在的未使用 import**（非本次引入），未动。


**用户口径**：插件市场空态那个大图标先改掉（"改成像 tab 图标一样，不要这个拼图图标"）；追问后明确 —— **全局凡是这样（代表"插件"）的拼图图标都统一改掉**。

**★ 先说一个必须先澄清的歧义**：项目里**两套图标系统并存**，而"tab 图标"现在**恰恰就是拼图** ——

| 位置 | 图标系统 | 现在是什么 |
|---|---|---|
| **左栏模块图标**（图标条 / 书签） | `components/shared/ModuleIcons.tsx` 手绘 + 风格包（`lib/sidebarIcons.tsx`） | **箱子** ✓ —— `ModuleIcons.tsx:154` 注释：「插件：包裹箱（**2026-09-17 由「拼图块」改为「立体箱」**）」，几何与 lucide `Package` 同构 |
| **页面条 tab 图标** | `components/workbench/WorkbenchPageBar.tsx` 的 `TAB_ICONS`（lucide 硬编码） | **拼图** ❌ —— `:28` `plugins: <Puzzle size={14} />` |

→ 所以你说的"和 tab 图标一样"应理解为**和左栏那个箱子一样**（你明确说了"不要拼图"）。**左栏早在 09-17 就改成箱子了，页面条和其余 14 处没跟上** —— 这就是全局不一致的根因。

### 全局清单（共 16 处，已按语义分档）

**✅ 应改 —— 代表「插件」这个概念（11 处）**

| # | 位置 | 用途 |
|---|---|---|
| 1 | `WorkbenchPageBar.tsx:28` | 页面条 plugins **tab 图标**（与左栏不齐的那处） |
| 2 | `plugins/index.tsx:576` | 插件市场**空态大图标**（本次起因，`size={40}`） |
| 3 | `plugins/index.tsx:865` | 插件市场左栏标题「插件」 |
| 4 | `toolRegistry.tsx:146` | 插件工具页头部（右侧带「插件」尾注） |
| 5 | `knowledge/index.tsx:1876` | 知识库左栏「插件视图入口」按钮 |
| 6 | `knowledge/index.tsx:2030` | 插件视图全屏覆盖层头部 |
| 7 | `PluginSlotEntry.tsx:62` | 同 5（共享组件版，供其他模块用） |
| 8 | `PluginSlotEntry.tsx:72` | 同 6 |
| 9 | `BlogTemplateModal.tsx:92` | 博客模板里**来自插件的模板**标记 |
| 10 | `Onboarding.tsx:21` | 新手引导模块卡片「插件」 |
| 11 | `Onboarding.tsx:37` | 同上（分模块图标映射 `plugins.icon`） |
| 12 | `Onboarding.tsx:195` | 新手引导 InfoRow「插件 · 官方市场」 |

**⚠️ 建议改，但语义要分清（3 处）**

| # | 位置 | 语义 | 说明 |
|---|---|---|---|
| 13 | `PluginIconImg.tsx:17` | **单个插件**自身图标的兜底（插件没给 icon 图 / 加载失败） | 与"插件概念"图标不同层，但视觉语汇统一后会一致；改与不改都成立，倾向改 |
| 14 | `AppearanceView.tsx:70` | 设置→外观 里**来自插件的主题**项 | 同 #9 的"来自插件"语义，倾向改 |
| 15 | `pluginService.ts:144` | 插件贡献的 helpDocs 缺 icon 时的**默认名字符串** `'Puzzle'` | 消费方是 lucide **名字解析**（`modules/help/index.tsx:28-31` `LucideIcons[name]`）→ 改成 `'Package'` 即可生效；纯兜底，风险低 |

**❌ 不要改（1 处，最容易误伤）**

| # | 位置 | 原因 |
|---|---|---|
| 16 | `toolbox/components/web-clipper/index.tsx:159` | 这里是**「安装浏览器扩展」**的图标 —— Chrome 扩展用拼图是那个场景的**正确语汇**（Chrome 应用商店即拼图），和"插件市场"没关系。改了就错。 |

### ★ 两个实施要点（照做才算"统一"，否则会二次分叉）

1. **复用 `PluginIcon` 组件，不要抄 lucide 名**。`components/shared/ModuleIcons.tsx:236` 导出的 `PluginIcon` 是 **StyleAware** 的（跟随「设置 → 外观 → 侧边栏图标风格」：手绘包 = 手绘箱子 / classic140 = lucide `Package` / 插件图标包 = 插件提供的 svg）。
   ```tsx
   import { PluginIcon } from '.../ModuleIcons'
   <PluginIcon size={40} className="text-[var(--text-disabled)]" />
   ```
   若各处直接写 `<Package size={40} />`，用户切成"手绘"风格后这些地方就**不跟随**了 —— 而左栏会跟随 → 又是新一轮不一致。**这正是 list-drift 的典型形态：同一个图标被抄成多份。**
2. **`IconProps` 目前只有 `size` / `className`，没有 `strokeWidth`**（`ModuleIcons.tsx:10-13`，`Svg` 内固定 `strokeWidth={1.6}`）。而空态大图标原本是 `strokeWidth={1.2}` —— **大尺寸下 1.6 会偏粗**。→ 实施时要么给 `IconProps`/`Svg` 扩一个可选 `strokeWidth`（各包一致生效），要么给空态专门做一个细线变体。别忽略，40px 与 14px 的线宽体感差很大。

### 拍板结果（2026-09-21）

- **本轮范围 = 只统一「插件」这一个概念**（上表 ✅12 + ⚠️3 处，各写各的合适写法），**`TAB_ICONS` 整表不动**。
  - 理由（当时给的取舍）：整表换成 `ModuleIcons` 会改变整条页面条的观感、影响面远超本次诉求；两套图标系统并存是既有架构现状，要动应当单独评估。
- **整表统一另立条目** → 见 **B-10**（低优先级、本轮不做，仅留档）。
- ⚠️ 执行注意：改完记得**清理各文件的 `Puzzle` import**（`plugins/index.tsx` 有两处，都改掉后才能删 import），否则 lint 会报未使用变量。
- ⚠️ 执行注意：#15（`pluginService.ts:144` 的默认 icon 名）与 #16（web-clipper）分处不同层 —— 前者是字符串默认值（改 `'Package'`），后者**必须保留 Puzzle**。复核时别把 web-clipper 一起"顺手统一"了。

**验证**：切「侧边栏图标风格」三档（手绘 / 经典细线 / 插件包）各看一遍，上述位置应**全部跟随变化**且无残留拼图；空态大图标线宽观感正常；`grep -rn "Puzzle size=" src` 只剩 web-clipper 那一处（浏览器扩展，预期保留）。

---

## B-10 【留档·本轮不做】页面条与左栏两套图标系统是否统一（2026-09-21 立项，P3）

> 由 B-9 的拍板派生：B-9 只统一「插件」这一个概念，**整表统一不在本轮范围**，此处仅留档，避免以后重新调研。

**事实（两套系统并存）**：

| | 页面条 | 左栏模块图标 |
|---|---|---|
| 实现 | `components/workbench/WorkbenchPageBar.tsx` 的 `TAB_ICONS`（`:20-38`） | `components/shared/ModuleIcons.tsx` 手绘方案 + `lib/sidebarIcons.tsx` 风格包 |
| 形态 | **lucide 硬编码**，`size={14}` | **StyleAware**：手绘（默认）/ classic140（lucide 细线）/ 插件贡献的图标包 |
| 是否跟随「设置→外观→侧边栏图标风格」 | ❌ 不跟随 | ✅ 跟随 |
| 模块数 | **17 个 key** + `FALLBACK_ICON` | `IconModuleId` **13 个** |

**不一致的后果**：同一个模块在两处形状/线宽不同、且"改了一处另一处不跟着变"—— B-9 的插件图标就是这么漏掉 15 处的（左栏 09-17 改了箱子，页面条直到 09-21 才发现还是拼图）。

**★ 整表统一的关键成本（先量化再决定）**：
- `TAB_ICONS` 有而 `ModuleIcons` 没有对应手绘图标的模块共 **6 个**：`releaseNotes` / `bookshelf` / `aiChat` / `graph` / `devtools` / `quiz`
  → 整表统一 = **要先给这 6 个补手绘图标**（否则它们只能落 `FALLBACK_ICON`），不是一次改 import 就能完事。
- 反向差集 2 个：`user` / `export`（`ModuleIcons` 有、`TAB_ICONS` 无）—— 属正常，它们是活动栏/其他位置用的。

**候选方向**（待将来评估，别在本轮动）：
- **a) 页面条改用 `ModuleIcons`**：观感与风格设置完全统一；代价 = 补 6 个手绘图标 + 页面条整体视觉变化（小尺寸 14px 下，手绘 1.6 线宽 vs lucide 细线的观感差异需要实机比对）。
- **b) 页面条保持 lucide**：理由是 14px 小尺寸下细线更清晰；只把"概念性图标"逐个与左栏对齐（B-9 就是这条路的实例）—— 但缺一份防漂移的机制。
- **c) 建映射表作唯一真相源**：无论选 a 还是 b，都值得有一处"模块 → 图标"的单一来源（`appModules.ts` 已是模块清单真源，图标却各组件自持 —— 见 `appModules.ts:19` 注释：*「图标仍然各组件自持：ActivityBar 的 BAR_ICONS、tiles.tsx 的 desc/icon、设置页的图标表」*）→ **三处以上各自维护图标，正是 list-drift 的温床**，本条目的长期价值可能就在这里。

---

## [x] B-11 PDF 阅读器「边缘被勾画的痕迹」（2026-09-21 立项，P2；**2026-09-22 定案并修复**：根因 = 我们的选区配色压掉了上游的 br 守卫 → 见下面 ★★ 一节）

**现象**：PDF 阅读器里（截图用的是探针样书 *Phrontis Reader Sample*，12 页）选中/点击后，页面**左边缘外侧**出现一条**竖直虚线**贯穿整页；用户疑问：「怎么边缘还是有被勾画的痕迹，不是已经改成了现有的一些工具了吗」。

**先回答那个疑问**：**是，已经换成官方 pdf.js viewer 了**（2026-09-21 迁移，覆盖层就是 `components/shared/pdf/pdfViewerTheme.css`）。而这条虚线**大概率不是自研时代的残留** —— 它作用在**我们自己那层滚动容器**上，换不换 viewer 都会在（见下）。

### ★★ 2026-09-22 定案（根因已量化 + 已修；下面那节「现象未复现」是被本轮复现推翻的）

**结论：那条竖条 = 文本层里「每行末尾那个 `<br>`」的选区高亮 —— 而它之所以会被涂色，是因为我们的选区配色规则（特异度更高）压掉了上游为同一个 Chrome bug 写的守卫。**

机理：pdf.js 的文本层里 **span 是绝对定位、`<br>` 是普通流**，于是所有 br 全堆在文本层左缘、从层顶往下依次叠；多行划选时 Chromium 给这些 0 宽的换行盒逐个画高亮，叠出来就是那条竖条。

实测（探针 `-left-column` / `-dragrects` / `-whopaints` / `-cssom` / `-fixclean`，图与逐像素扫描在 `tmp/probe-shots/`）：

| 量 | 值 |
|---|---|
| 位置 | 物理 x=497..502 → **CSS x=331.3..334.7**（页面左缘 331），y 从页面顶 106 往下 **77px** |
| 尺寸 / 颜色 | **4 × 81 CSS px**；`#C4D5E2`（浅带）+ `#90B4D6`（深带 = 相邻两块叠出来的，所以看着像「虚线」） |
| 颜色反算 | `rgba(0,120,255,.35)` 叠在 `F7F7F3` 上、再过护眼滤镜 `sepia(.32)`：理论 (191,212,227) / 叠两层 (142,181,219)；实测 (196,213,226) / (144,180,214) |

**三段证据（都不是推理）**：
1. **品红鉴别**：把 `br::selection` 改成品红 → 竖条那 702 个像素**变品红**（`#CC2DBF`），正文蓝条纹丝不动 ⇒ 上色用的就是 **br 自己的 `::selection`**。
2. **删规则**：经 CSSOM 删掉 `pdfViewerTheme.css` 那条 `.kb-pdf-scope .pdfViewer .textLayer ::selection{rgba(0,120,255,.35)}` → br 落回上游的 `background: transparent`（实算 `rgba(0,0,0,0)`）→ **竖条 0 像素**。
3. **先挂后划**：把候选修法**先挂好、再重新划选** → 竖条 0 像素、正文蓝条完好、撤掉后截图与基线**逐字节相同**。
   （教训：对已经存在的选区改样式会被 Chromium 的高亮缓存吃掉 —— 本轮第一次注入「无效」就是这个坑，必须全新划选才算数。）

**为什么上游的守卫救不了我们**：上游 `pdf_viewer.css` 本就有 `.textLayer br::selection { background: transparent }`（注释直接带 mozilla/pdf.js#13840），但它是特异度 **(0,1,1)**，而我们 ④ 那条是 **(0,3,0)** ⇒ **我们的规则赢**。本文件头注「每条覆盖都靠更高特异度」的副作用，就是它。

**已修（2026-09-22）**：`pdfViewerTheme.css` ④ 之后加 **④b**，把上游那条守卫按更高特异度（(0,3,1)）捡回来，并在注释里写明「不能删」及牌理。
- 备选 `br{user-select:none}` 也验证能消掉竖条，但会让复制出的文本**丢换行** → 弃。
- 影响面：全仓只有 `PdfReaderView` 真的渲染 `.textLayer`（工具箱 / ai-teaching 只是用 pdfjs 抽文本）⇒ 范围就这一处。
- 与「定位 B（`--kb-hit-pad` 让色块溢出）」的关系：B 猜的机理（色块溢出文字）**不成立**；但 hit-pad 有份 —— 它把 br 叠栈行距从 20.7 压到 15.1，所以这列读起来是连续短划而非稀疏几笔。
- ⚠ 同一个 bug 在**主仓 `feature/v3.4.0` 的 `pdfViewerTheme.css:61` 也存在**（同一份规则）—— 两条线合并/移植时这条 ④b 必须一起带过去，否则用户会在主线版本上再看到一次。

**验收（2026-09-22 已过）**：`npm run build` 通过；探针 `probe-b11-fixclean.mjs` 同带同判据复验 —— **竖条带 702 → 0 蓝像素**、正文带 43411 → 43518（蓝选区正常），且 `br` 的 `::selection` 实算由 `rgba(0,120,255,.35)` 变 `rgba(0,0,0,0)`（这正是 ④b 生效的判据）。证据图：修后 `tmp/probe-shots/b11fix2-F{0,1,2}.png`（三次全 0）、修前 `b11p6-P0.png`（702，带 `#C4D5E2`/`#90B4D6` 两色）。
- 踩坑记录：用户自己的实例在跑时占着单实例锁，探针 spawn 的实例会**静默退出**（`main/index.ts:189` 是 `app.exit(0)`）——见下节环境坑第 ③ 条；也曾试图用 junction 换 app 目录名 + 一次性隔离档案绕开，**无效**（Node/Electron 会把 junction 解析成真实路径，`getAppPath()` 仍指回原目录）。

---

### ★ 2026-09-22 取证结果（**已被上面的 ★★ 定案取代**；下面「主推定位 A」的推理已被推翻，保留仅供对照）

**结论：主推定位 A（滚动容器聚焦虚框）被三个独立实验证伪，且现象本身没能复现 —— 计划中的「A 主修」若落码就是一次无效改动（no-op），所以不要按下面的「修复方向 A」动手。**

1. **证伪 A（探针 `.AGENT/scripts/workbench-shell/probes/probe-b11-scroll-focus.mjs`）** —— 在一个注入的最小可滚 div（`overflow-y:auto`，与 `.kb-pdf-scroll` 同一种东西）上做三次独立实验，全部否定「点击/键盘滚动会给滚动宿主焦点」：
   - 真鼠标点击 → 焦点留在 **BODY**（不给滚动容器）；
   - 点击后按 PageDown → 容器**确实滚了**（`scrolled=210`）但焦点**仍是 BODY**（键盘滚动也不聚焦）；
   - 按 Tab → 根本不把可滚 div 当停留点（被跳过，落到应用里的一个 BUTTON 上，那个按钮是真 `:focus-visible`、`outline: auto 0.667px` —— 即**焦点环机制本身是好的，只是不落在滚动宿主上**）。
   - 顺带定案立项时那个「待确认」：**本仓不存在「点滚动宿主 → 冒虚线」这条路径**，所以不必再问用户「虚线还是实线」。
2. **现象未复现（探针 `.AGENT/scripts/workbench-shell/probes/probe-b11-pdf-edge.mjs`）** —— 打开同一本样书（*Phrontis Reader Sample*）、**同一页（Page 9 / 12）**、同一状态（蓝选区 + 摘录工具条），做真实拖选，然后逐元素读 `.kb-pdf-scope` 全树的 `outline / border-left / box-shadow`，并对页面左缘做 3x 放大截图：
   - **没有任何虚线**（全树零 dashed outline/border）；
   - `.page` = `outline: none` / `border: none` / `box-shadow: rgba(0,0,0,0.18) 0px 2px 8px`（正常投影，不是勾画）；
   - 3x 放大的左缘 = 干净的实线页边。
3. **因此这条既不是 A、也不是某条我们自己的样式**（上游 `pdf_viewer.css` 全文亦无 dashed，见「已排除」）→ 剩下的可能都是**需要看到用户那张截图才能收敛的**：可能是沉浸模式下的某条分隔线 / 另一个模块的面板缘 / 窗口缘，或某个只在特定交互（例如拖动分隔条、悬停手柄）下才出现的元素。
4. **要用户提供（三问，任一即可定性）**：① 那条线在**哪个"边"**（窗口缘 / 面板缘 / 页面缘）；② **虚线还是实线**；③ 是否**只在拖选之后**出现、当时是否在**沉浸模式**。
5. **定位 B（`--kb-hit-pad` 让选区色块溢出）本轮未复核** —— 没有独立判据：上面那张截图里蓝块边缘未见异常外溢，但**没做量化**（没量色块高度 vs 文字行盒）。若用户截图指向"色块边缘比文字宽一圈"，再回头按 B 复核。
6. 跑这两个探针的环境坑（已解决，供复用）：① 端口用 `KNOWBASE_PROBE_PORT`（本机 9222 被 WorkBuddy 占住）；② `pdf-edge` 要先把 dev 设置的 `currentVaultId` 临时指向放着样书的仓库（`.books` 是**每仓库**的，dev 仓库里没有 PDF），跑完已复原；③ **同 worktree 的 dev 实例不能同时在跑** —— dev userData 按检出目录名隔离（`%APPDATA%/knowbase (dev <目录名>)`），单实例锁就在里面；用户自己开了该 worktree 的实例时，探针 spawn 的 electron 抢不到锁会**静默退出**，表象是 `CDP page target 未出现`。判据：`Get-CimInstance Win32_Process -Filter "name='electron.exe'"` 看 `CommandLine` —— 探针起的带 `--remote-debugging-port`，用户自己起的不带。

---

**主推定位（A）：滚动容器的聚焦虚框（focus ring）** ← 已被上面第 1 条证伪，以下为立项时的推理原文
- `PdfReaderView.tsx:1261` 的 `<div ref={containerRef} … className="kb-pdf-scroll absolute inset-0 overflow-auto">` —— 这是官方 viewer 要求的那个**可滚动 container**。
- Chromium 让**可滚动容器参与键盘滚动**（因此它可获得焦点）；而 PDF 页面（canvas + textLayer）里**没有任何可聚焦元素**，所以点击页面/拖选后焦点就落到这个滚动 div 上 → 浏览器给它画默认 focus ring。
- Chromium 在 Windows 上对 `outline: auto` 用的是**平台原生风格（虚线）**，于是表现为"页面左缘外侧一条竖虚线"（其余三边在视口外/被裁，看起来就只剩这一条）。
- 判据：这条线**与选区无关**（不选任何文字、只点击空白也会出现），且**换页/滚动后仍在**。

**待复核定位（B）：`--kb-hit-pad` 可能让选区色块溢出文字**
- `pdfViewerTheme.css:71-74` 给文本层每个 `span/br` 加了 `padding: var(--kb-hit-pad) 0` + 等量负 `margin-top`（为消灭"拖选到两行之间突然选中下面十几行"）。
- 该处注释断言"**选区高亮按文本行盒绘制、不含 padding，视觉零变化**" —— 这个前提**需要用实测复核**：若 Chromium 的 `::selection` 实际按 **border-box（含 padding）** 绘制，蓝色块就会上下各溢出一个 pad，表现正是"色块边缘比文字宽一圈、像被勾了框"。
- 判据：看蓝色块**上下边缘是否明显高出文字**（若只是常规行盒高度，则与普通网页选中无异，B 不成立）。

**已排除（免得白排查）**：
- **不是**上游 viewer 的页面边框：上游是 `--page-border: 9px solid transparent`（`node_modules/pdfjs-dist/web/pdf_viewer.css:1822` / `:1877`）—— **solid 不是 dashed**，且我们已 `border: 0` 覆盖（`pdfViewerTheme.css:26-31`，特异性也够）。
- **上游 CSS 全文无 `dashed`**（grep 无命中）→ 虚线不可能来自官方样式。
- **不是**选区/摘录配色问题：选区 `::selection` = 蓝 35%（`pdfViewerTheme.css:61-63`）、摘录 `.kb-excerpt-hl` = 黄 32%（`:83-88`）—— 截图里的蓝块 = 选区、黄块（含被摘的 "do"）= 摘录叠加，两者都**符合设计**。

**修复方向（★ 2026-09-22 晚：已按 ★★ 定案的 ④b 落地；下面 A / B 两条保留作历史，**A 已确认无关、不要动**）**：
- **A 主修（不要动）**：给滚动宿主做焦点样式收口 —— 用 `:focus { outline: none }` **或更稳妥的 `:focus-visible` 保留键盘焦点可见性**（别一律 `outline-none` 把键盘用户的焦点提示也删了，那是可达性回退）。建议在 `index.css` 里给"滚动宿主"统一一条（如 `.kb-scroll-host:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px }`），而不是在 PDF 里就地写一次性样式（铁律 13 的口径）。
- **B 复核后决定**：若确认是 hit-pad 溢出，则两条路 —— ① 选区绘制改用 `::selection` 之外的方式（自绘 overlay）；② 或接受（毕竟 pad 是为了消灭更严重的误选，取舍要权衡）。改前先实测，别凭注释断言。
- ★ **全局排查（顺带价值）**：这是"**点击滚动区空白处就冒虚框**"的通用问题，不只 PDF —— `grep -rn "overflow-y-auto\|overflow-auto" src` 找出所有滚动宿主，逐个确认。用户在其它模块（笔记区、侧栏列表、设置页）大概率也会碰到。

**验证**（★ 需重写：先拿到用户截图定性，再定验证口径 —— 现状见上「取证结果」第 3/4 条）：
~~① 在 PDF 里不选任何文字、只点空白 → 左缘虚线**不再出现**~~（前提已证伪：点空白不会给滚动宿主焦点，这条判据测不出东西）；② 键盘 Tab 进入该区域时仍**有可见焦点提示**（这条仍然有效且已实测：`:focus-visible` + `outline: auto` 正常，别顺手 `outline-none` 把它删了）；③ 拖选文字的蓝色块边缘与文字的关系（= 定位 B，未量化）；④ 其它滚动宿主抽查一遍。

**待确认（2026-09-22 更新）**：立项时判定的「虚线」只是依据用户截图；**本轮既证伪了它的主推成因、也没能复现它**。下一步不是继续猜，而是**拿用户那张截图（或一句精确描述：哪个边 / 虚线还是实线 / 是否拖选后）**再定位。

---

## [x] B-12 【需求】AI 助手侧边栏的「感知模式」开关从顶层移到输入框上方（2026-09-21，P2）

**二次拍板（2026-09-22）**：输入卡内顶部观感不对（与输入正文脱节），改落**输入卡底部工具行行首**（📎 / 模型 / 消耗那排，Radar 图标与行内按钮同款 12px 规格）。实现：ChatBody 新开 `inputBarLeft` 行首插槽（工具行 `relative flex` 首位渲染，page 态宿主不传即不出现，口径仍=只动侧边栏）；JSX 仍留在 index.tsx（H3b/H4a 按文件断言不变）；弱提示限宽 150px 截断防挤压发送钮。契约 J18b/c 已同步改写。门禁：`verify-perception.mjs` 221 项全绿；`tsc --noEmit` web EXIT 0。

**三次拍板（2026-09-22，同日）**：工作台右栏 / page 态的感知开关**同位跟进**——ChatBody 的 `PerceptionToggle` 从轻头部移除，落非侧栏形态的工具行行首（在 `inputBarLeft` 之后，侧栏形态不重复渲染）；头部下方通栏弱提示条改为工具行内限宽 150px 行内提示（顺带消除 sidebar 下 index.tsx + ChatBody 双份提示的既有隐患）；page 态 2026-09-18「不放开关」口径作废（当时因头部不渲染无处安放，现开关跟工具行走）。PerceptionToggle 规格对齐行内按钮（px-1.5 py-1 + 12px 图标）。契约 H3a/H4a 按文件断言不受影响，未改。门禁：`verify-perception.mjs` 221 项全绿；`tsc --noEmit` web EXIT 0。

**四次拍板（2026-09-22，原型定稿方案 A）**：弱提示从工具行小字**升格为输入卡顶部暖色提示条**——琥珀底（主题 token `--warning`/`--warning-bg`，明暗各一份，未写死色值）+ 警告三角图标 + 文案改「语义索引未配置，感知模式当前按关键词匹配」+ **「去配置」直达**（`settings:open` → aiTools/models，嵌入模型就在该页配置）。侧栏走 inputTop 插槽（提示条+引用胶囊），docked/page 态在 ChatBody 输入卡内同款渲染（`goSettings`）。仍只描述状态：不阻断发送、无「知道了」记忆（H5 不变）。契约 J18 重写为 a/a2/b/c/c2 五条（开关独占工具行 / 提示条独立含去配置 / inputTop 组合提示条与胶囊）。门禁：`verify-perception.mjs` **223 项全绿**；`tsc --noEmit` web EXIT 0。原型存档：`.workbuddy/prototypes/perception-hint-prototype.html`（A/B/C 三案，选 A）。

**已修（2026-09-21，ui-rework 分支，未提交）**：拍板三答 = **a) 输入卡内顶部** · **只搬侧边栏** · **弱提示跟着走**。
- 开关与弱提示合成一个 `perceptionRow`（`AssistantPanel/index.tsx:324-350`），由 `inputTop = <>{perceptionRow}{quoteRow}</>` 组合 —— 复用 `ChatBody` **既有** `inputTop` 插槽（渲染在输入卡内、上下文徽章之上），**零改 ChatBody**。
- 头部删掉开关与那条通栏弱提示（`:447-452` 原位置），头部回归纯导航（会话列表 / 全屏 / 收起）。弱提示从「整条横带」改成**紧贴开关的一行小字**（卡内空间窄，通栏会顶掉对话区高度）。
- ★ **关键取舍：JSX 刻意留在 `index.tsx` 内、只挪渲染位置** —— 契约 H3b / H4a 是**按文件**断言的（`data-wb="perceptionToggle"` 与 `语义索引未配置` 各须在本文件出现），搬进 ChatBody 即破契约。只挪位置 ⇒ 两条断言原样成立。
- **右栏 AI 态不动**（`ChatBody.tsx:271`）：按拍板只搬侧边栏；page 态仍不放开关（守 `ChatBody:257-259` 那条 2026-09-18 拍板）。
- **契约补齐**：`verify-perception.mjs` 新增 **J18 共 6 项** —— a) 开关与弱提示同处 `perceptionRow`（锁「提示跟着开关走」不得分家）；b) `inputTop` 组合它（= 位于输入卡内）；c) 经插槽 prop 传入未另开通道；d/e) **负向**：侧边栏头部**区间切片**内不得再出现开关 / 弱提示；f) `aria-pressed` 仍在（探针与无障碍判态依赖）。
  - ⚠️ 首版 J18d 写错方向：头部 JSX 在文件里位于 `perceptionRow` **之后**（const 先于 `return`），单纯比索引大小会**假失败**。已改成「取头部区间切片再断言其中不含该串」，并加 `length > 100` 防空切片造成的**假通过**。
- **门禁**：`tsc --noEmit` web EXIT 0；`npm run build` EXIT 0；`verify-perception.mjs` **221 项全绿**；`verify-workbench-shell.mjs` 139 项全绿。

---

**用户口径（原文）**：AI 助手侧边栏顶层的感知模式开关将其移动一个位置，移动到输入框上。

**现状（有两条并行的放置口径，别弄混）**：

| 渲染点 | 位置 | 何时渲染 | 代码 |
|---|---|---|---|
| **悬浮侧边栏** | 头部（Menu 会话列表 · 「AI 助手」标题 · **感知开关** · ⤢ 全屏 · ✕ 收起） | 恒（sidebar 态头部在本组件） | `AssistantPanel/index.tsx:424-434` ← **用户要搬的就是这处** |
| **右栏 AI 态 / page 态** | 轻头部（Menu · 标题 · **感知开关** · ⤢） | `variant !== 'sidebar'` **且** `showDrawer \|\| (isNarrow && onExpand)` | `ChatBody.tsx:271`（组件定义在 `:691`）；`ChatBody.tsx:257-259` 注释记着 2026-09-18 拍板「**感知开关不放这里**」——指的是 **page 态**（`showDrawer=false` 且不窄 → 整块头部不渲染） |

**现成通道**：`ChatBody` 已有 `inputTop` 插槽（`ChatBody.tsx:408`，渲染在输入卡**内部**、上下文徽章之上），宿主的划词引用胶囊就走它（`index.tsx:324-351`）。若开关 JSX **留在 `index.tsx` 内、只改渲染位置**（塞进 `inputTop`），则 `verify-perception.mjs` 的 **H3b**（断言 `data-wb="perceptionToggle"` 出现在 SRC_SIDEBAR）与 **H4a**（`语义索引未配置` 在两文件各一份）**全部不受影响** —— 这两条是**按文件**断言的，不是按位置。

**连带**：弱提示条「语义索引未配置，当前按关键词匹配」被复制了两份（`index.tsx:447-452` 注释明说「sidebar 态的头部在本组件，故这里也渲染一份」+ `ChatBody.tsx:283-288`）。开关一旦下移，这条 hint 若留在头部就会与开关分家（提示的是那个开关的状态，却离它一屏远）。

**三个必须先拍板的歧义**：
1. **精确落点**：a) 输入**卡内**顶部（复用现成 `inputTop`，**零改 ChatBody**，与划词引用胶囊同区）；还是 b) 输入卡**上方**独立一行（更贴字面，但要么改 `inputTop` 的渲染位置——会连带改掉引用胶囊的观感，要么给 ChatBody 新增一个插槽）。
2. **右栏 AI 态要不要一起搬**？用户只说了侧边栏。搬法 A = 只搬侧边栏（口径最窄、零连带）；搬法 B = 侧边栏 + 右栏统一搬到输入框上方，page 态仍不放（跨三处形态一致，但改动面大、且与 `ChatBody:257-259` 那条拍板注释要对齐）。
3. **弱提示条跟不跟着走**？跟着走 = 提示紧贴其描述的状态（推荐）；留头部 = 视作全局状态提示。

**验证**：侧边栏头部**不再**有感知开关；输入框上方出现且可切；切换后 `aria-pressed` / 颜色随动；`verify-perception.mjs`（215 项）与相关探针全绿（H3a/H3b/H4a 是按文件断言，只要 JSX 不换文件就不会破）。

---

## [x] B-13 【需求】笔记区新建条目时用居中窗口命名，要改成 VS Code 式的树内联输入（2026-09-21，P2）

**已修（2026-09-21，ui-rework 分支，未提交）**：拍板三答 = **就是分类目录** · **恒在根层末尾** · **旧通道删掉**。
- `CreateIntent.type` 加第四态 `'category'`，并抽出 `export type CreateType`（四处字面量并作一处，新增类型时不再漏改）。
- `InlineCreateRow` 补 category 的图标（`FolderTree`，与「＋」菜单项、侧栏「分类」页签同源）与占位符「分类名称…」。
- `handleTreeCommitCreate` 内**先于** `ensureVaultRoot` 分流 → `handleCommitCategory(name)`（分类不走 vault 写通道、也不接受 `dirRel`，提前分流免掉一次无用的根解析）。
- **`catDraft` 整条通道删除**：state、居中浮层 JSX（380px / `pt-[26vh]`）、三处引用全部清掉；`handleCommitCategory` 不再自己收输入框（首行 `setCatDraft(null)` 已删）——收输入行由树内联机制统一负责。
- 两个入口（头部「＋」菜单 / 左栏右键菜单）统一改为 `setTreeCreating({ dirRel: '', type: 'category' })`，**落点恒为仓库根层**（与分类目录的语义一致，且 B-7 已在「＋」菜单项标了「根层」提示）。
- **新契约** `.AGENT/scripts/notes-merge/verify-tree-create-channels.mjs` **18 项**（同时覆盖 B-7 与 B-13）：A) 全 src 剥注释后 `catDraft` **零命中**（主断言，附「扫到 >100 文件」防空集假通过）+ 两入口落点 + 分流顺序；B) 四态齐备 + category 图标/占位符；C) `treeLandDir()` ≥2 处调用 + **负向**禁止 Ctrl+N 退回硬编码 `dirRel: ''` + 选中态是竖条且**不铺**底色 + 「＋」与聚焦按钮同显隐口径 + 落点目录强制展开。
  - 写契约时踩到两个坑并已修：① 单引号字符串里嵌 `dirRel: ''` 直接语法错误；② C6 首版用 `[\s\S]{0,80}` 窗口太窄（`selectedPath === relPath` 到 `left-[1px]` 实距约 165 字符）→ 改成取局部切片断言，顺带把「不铺底色」写成正反两面。
- **门禁**：`tsc --noEmit` node + web 双 EXIT 0；`verify-perception.mjs` 221 项、`verify-workbench-shell.mjs` 139 项、新契约 18 项**全绿**。

---

**用户口径（原文）**：笔记区，创建新的条目的时候，命名时是在一个位于窗口中间的小窗口创建的，我很不喜欢这个设计，我希望在创建条目的时候是跟 vscode 那样一样。

**★ 全模块排查结果：笔记区里「居中窗口命名」只有一处** —— 也就是用户看到的那处：

| 创建入口 | 命名方式 | 代码 |
|---|---|---|
| **新建分类目录** | ❌ **居中浮层**（`fixed inset-0 ... pt-[26vh]`，380px 宽） | `index.tsx:1932-1950`（state `catDraft` 在 `:116`） |
| 新建知识页 | ✅ 树内联（VS Code 式） | `VaultTree` `InlineCreateRow`（`type:'knowledge'`） |
| 新建目录 | ✅ 树内联 | 同上（`type:'dir'`） |
| 新建空文件 | ✅ 树内联 | 同上（`type:'file'`） |
| 学习空间 / 笔记本 | ✅ 行内输入（本就如此） | `NotebookList.tsx:760-783` |

→ **反直觉的点**：用户说"创建新的**条目**"，但唯一不合口径的是**分类目录**（一项 category，不是文件条目）。其余三处**已经是** VS Code 式。（也正因如此，若不先排查就会改错地方。）

**根因**：`catDraft` 是 Phase 2 批次 3 收尾时单独加的通道（`index.tsx:857-870`），当时**没有**并进 批次 2 的 `treeCreating` 内联机制。B-7 又把「新建分类目录」放进头部「＋」菜单，于是这处旧通道被多引了一次 —— **两条创建路径并存本身就是分叉源**。

**修复方向**：把「新建分类目录」并进 `treeCreating` 内联机制，**删掉 `catDraft` 整条通道**。
- `CreateIntent.type` 加第四态 `'category'`；`InlineCreateRow` 补它的图标（`FolderTree`，与「＋」菜单项、侧栏「分类」页签一致）与占位符「分类名称…」、默认名空。
- `handleTreeCommitCreate` 内**先于** `ensureVaultRoot` 分流：`if (type === 'category') { await handleCommitCategory(name); return }` —— `handleCommitCategory` 不接受 `dirRel`（分类恒在仓库根层），提前分流可免掉一次无用的 ensureVaultRoot。
- 删 `catDraft` state、居中浮层 JSX、三处 `setCatDraft` 引用（`:860` 提交内 / `:924` ＋菜单 / `:1973` 左栏右键菜单改 `setTreeCreating`）。
- **已核：无契约/探针锚定 `catDraft`**（`grep .AGENT/scripts/` 零命中）→ 删除不会破任何断言。

**待确认**：
1. **分类目录恒落仓库根层**（既有设计：`parentId: null` + 顶层 mkdir）—— 内联输入行就该出现在**根层列表末尾**。若用户在子目录里点「＋ → 新建分类目录」，输入框会出现在根部（离选中处有距离）。要么接受（诚实反映约束，且 B-7 已在菜单项标了「根层」），要么放开"只能根层"的限制（改 `categories.json` 的 `parentId` 语义 + `resolveCategoryIdByPath` 推导 → **扩大改动**）。
2. 居中浮层**删掉**还是保留为备用入口？（倾向删——两条路径并存就是分叉源。）
3. **同类但不同模块**：AI 教学区文件树仍是居中 `nameModal`（`AiTeachFileTree.tsx:117-138`，新建文件 / 新建文件夹 / 重命名 三处）。要不要一并改？（用户只点名了笔记区。）

**验证**：笔记区从「＋」或左栏右键点「新建分类目录」→ 输入行出现在**树内**（不再是居中窗口）→ 提交后分类目录出现在根层、`categories.json` 有登记、页面拖进去即归类；居中浮层不再存在；Esc / 失焦取消行为与其它内联创建一致。

---

## [x] B-14 【需求】AI 教学区文件树仍是居中窗口命名，未与笔记区统一（2026-09-21 立项，P3；2026-09-22 落码）

**来由**：B-13 排查时顺带发现的**同类问题**，属**另一个模块**。B-13 立项时已就此问过用户，用户当时的选择是「确认指的就是笔记区分类目录」——即**本轮不包含教学区**，故单独登记，不丢。

**现象**：AI 教学区文件树的新建 / 重命名走居中命名弹窗（`nameModal`），与笔记区改造后的 VS Code 式树内联不一致。

**★ 先查清的结果：立项时写的两条路（迁树 / 照抄）都是错的。** 立项假定「两边不是同一棵树，不能复用 `CreateIntent` / `InlineCreateRow`」——实测不成立：
- `AiTeachFileTree.tsx:9` **早就** `import { VaultTree } from '../../components/shared/VaultTree'`，`:211` 直接渲染它。教学区只有**状态层与操作层**是自己的（数据源确实独立：树根 = 产物根 / 当前工作区段，调 `ws:*` 时拼 `base` 前缀），树本体从来就是共享的那一棵。
- 内联创建的整套机制（`CreateIntent` `VaultTree.tsx:27` / `renaming` `:51` / `InlineCreateRow` `:369` / `InlineRenameRow` `:425`）**本来就在共享 `VaultTree.tsx` 里** —— B-13 是加在共享组件上，不是加在笔记区上。
→ 既不用迁树、也不用照抄：**教学区把 6 个受控 props 接上即可**。改动面 = 1 个文件 + 删掉本地弹窗。

**落码（2026-09-22）**：`src/modules/ai-teaching/AiTeachFileTree.tsx`
- 删 `InputModal` 接口 / `nameModal` 工厂 / `modalValue` / 那段 `fixed inset-0 z-[90]` 居中弹窗 JSX；改持 `creating: CreateIntent | null` + `renaming: RenameIntent | null`。
- `doCreate(dirRel, type)` 拆两半：入口只落意图，**并先展开落点目录**（内联行渲染在目录子级里，目录收着 = 输入框不可见 = 表象「点了没反应」；知识库 B-13 踩过同一个坑）；写盘挪进 `commitCreate`。`doRename` 同理拆 `startRename` / `commitRename`。
- 空态让位：仅当 `(dirCache[''] ?? []).length === 0 && !creating` 才显示「还没有内容」引导 —— 否则产物根为空时点「＋ 新建文件夹」，树被空态替换、输入框无处渲染。
- 保留原有反馈：空名仍 toast「名称不能为空」（知识库那边是静默 return，此处不吃掉既有提示）；重命名空名/同名静默 return（原本如此）。

**验证**：
- 源码契约 `.AGENT/scripts/ai-teaching/verify-teach-tree-inline.mjs` —— **23 项全绿**。锁三件事：① 教学区零弹窗残留（6 个负向标记：`InputModal`/`nameModal`/`modalValue`/`setModal`/`z-[90]`/自渲染 `<input>` —— 这 6 条在 HEAD 旧版上**逐条命中、改动后归零**，证明断言有牙不是空过）；② 6 个 props 接线齐全，且「落点先展开」用精确语句断言（宽松窗口会匹配到后续函数的 `setExpanded` → 假通过）；③ 共享底座不退化（两个内联行仍在，且 Enter 提交 / `Escape` 取消 / `onBlur` 取消各 ≥2 处）。
- 真机探针 `.AGENT/scripts/workbench-shell/probes/probe-b14-teach-inline.mjs` —— **15/15 PASS**（真右键菜单 + 真键盘 Esc，**全程只 Esc、不按 Enter = 零写盘**）：输入框在树内、祖先链零 `fixed`、不居中（旧实现的运行期签名 = 输入框必有 `fixed inset-0` 祖先）；内联行签名 = 默认名「新目录」+ placeholder「名称…」（旧弹窗是空值 +「名称（含扩展名）」，DOM 上可区分）；自动聚焦；按目标目录缩进 30px（= 其子级）；**重命名时该条目行被内联行替换、预填原名、主名选中扩展名保留**；Esc 后条目数与名字均未变；全程负向观察器零「fixed inset-0 居中弹窗」。截图 `tmp/probe-shots/b14-q2-inline-create.png`（新建行落在 `09-13 跟我学（教学）` 子级）/ `b14-q9-inline-rename.png`（`SOURCE.md` → 内联行，`SOURCE` 选中）。
- 门禁：`npx tsc --noEmit -p tsconfig.web.json` EXIT 0；`npm run build` 通过。
- **探针首跑踩到的两个前提**（非产品问题，已写进探针注释便于复用）：教学区树的根 = **当前工作区段**（`subRel = wsTreeSeg`），不是 `AI教学` 产物根本身 → 条目天然少（本机该层只有 2 个目录）；该层全是目录，要验证重命名必须先展开一层才有文件行。

---

## 登记格式（后续条目照此写）

```
## B-n <一句话现象>（YYYY-MM-DD，P0/P1/P2/P3）

**现象**：用户视角看到什么、怎么触发。
**定位**：文件:行（尽力给出）。
**根因**：为什么错。
**修复方向**：怎么改、要注意什么。
**验证**：修完怎么确认。
```
