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
> ★ **B-1…B-24 已全部占用**（12/13/14 是本线那三条，15…19 是并入的阅读器那批，20 = data-changed 监听告警，21 = foliate 残余 RO 刷屏，22 = EPUB 书签在重排后重复/删不掉，23 = 导出摘录撞上陈旧索引 ENOENT，24 = pdfjs `PDFViewer` 留观察者）—— 新条目请**从 B-25 起**，别再顺手写一个已占的号。
> **本文自 2026-09-22 合并（v3.4.0 ← feature/ui-rework）起即唯一清单**：1…11 = UI 那批（已修，标 `[x]`）· 12/13/14 = 感知模式开关 / 树内联命名 / 教学区树内联输入 · 15…19 = 阅读器那批 · 20/21 = 两条诊断噪音。
> **阅读器那批的现状（2026-09-22 更新）**：B-15 / B-16 / B-17 / B-18 / B-19 **已落码标 `[x]` 且实机验证完毕**
> （B-17 另做了「stash 掉 patch ⑥」的前后对照；B-19 的 Δ=0 对 pdf/txt 成立，foliate 残余 ⇒ 见 **B-21**）；
> B-16 的「worker 化」方向经实测**无收益**、已由用户拍板换成读取链路优化 + 体积分档确认框（见该条修复记录）。
> **收尾轮（2026-09-22 晚）**：**B-20 / B-21 已修并标 `[x]`**（B-20 = preload 单点扇出 + 新契约脚本；
> B-21 = vendor patch ⑧ + 新探针 `probe-ro-noise.mjs`，含变异测试）；
> **B-22 保持开放**是用户 2026-09-22 的显式取舍（「书签只做快速跳转」），**不是漏项**；
> **B-23 / B-24 / B-25 / B-26 均已修并标 `[x]`（2026-09-23）** —— B-24 = pdfjs `PDFViewer` 留观察者
> （采用 A′ 宿主侧捕获式；收尾时另修掉一处 `detachViewerDocument` 的「顺序」缺陷 —— `setDocument(null)`
> 会抛、把 `disconnect` 整段跳过；详见该条目结案块，是「契约绿 ≠ 运行期验过」的又一实例）。
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

## [x] B-15 导出「读书笔记」页名不带扩展名：同名书（a.epub / a.fb2）会撞进同一篇页（2026-09-22，P3）

### ★ 修复记录（2026-09-22，选 **A**；契约 `verify-reader-formats.mjs` + `verify-excerpt-export.mjs` + 探针第 8 步）

| # | 改动 | 落点 | 治的是 |
|---|---|---|---|
| 1 | 页名改用**身份名** `bookIdentityName`（保留扩展名的 basename） | `electron/lib/kbStore/excerptExportVaultRepo.ts` | 页名与映射键 `{rootId}/{relPath}` 口径对齐（映射键本来就区分格式，只有页名丢了信息） |
| 2 | 新增 `bookIdentityName`，与 `bookDisplayName` 明确分工 | `electron/lib/kbStore/bookFormats.ts` | **页名是身份、书名给人读** —— md 内的 H1 仍用展示名（`bookName: bookDisplayName(relPath)`），来源行已带 relPath，两者不重叠 |

**★ 对本文原「根因」段的更正（重要）**：原文写「已存在时走的是覆盖重写路径 ⇒ 第二本书**静默改写**第一篇页」，
**这句是错的**。查 `knowledgeVaultRepo.ts` 的 `vaultCreatePage` → `uniquePageName`（`:247-252`）：

```ts
let name = `${stem}.md`
let n = 1
while (existsSync(join(root, dirRel, name))) { name = `${stem}(${n}).md`; n++ }
```

**重名只会加 `(1)` 后缀，绝不覆盖** —— 原文那句「实测过 `(1)` 后缀」和「已存在时覆盖」自相矛盾，
写的时候把两条互斥的推断并列了。所以 B-15 的真实后果是**「两篇页无法按书名区分」**（观感与可检索性），
**不是数据丢失** —— 严重性比原登记低一档。修法（A/B/C）的取舍不受此更正影响，仍按 A 落地。

**验证**：`probe-excerpt-export.mjs` 新增第 8 步 —— 用 `探针样书.epub` 再导一次，断言
`读书笔记 · 探针样书.epub.md` 与 `读书笔记 · 探针样书.txt.md` **两篇都在**、无 `(N)` 后缀重复、
TXT 那篇逐字节未变、EPUB 那篇含自己的摘录文本。契约侧加了两条**立论**断言（同名三格式的
展示名相同、身份名互不相同）与一条负向（页名不得再用 `bookDisplayName`）。

**现象**：同一本书的不同格式（或任意两个**去掉扩展名后同名**的书）都导出为笔记时，第二本会**顶掉**第一本的笔记页内容 —— 第一本的摘录静默消失。做阶段 2a 的 fb2 探针时撞见：`探针样书.epub` 与 `探针样书.fb2` 都导出成同一篇 `读书笔记 · 探针样书.md`。

**定位**：`electron/lib/kbStore/excerptExportVaultRepo.ts:76`

```ts
const page = vaultCreatePage({ title: `读书笔记 · ${bookDisplayName(relPath)}`, contentMd: md })
```

`bookDisplayName`（`electron/lib/kbStore/bookFormats.ts:90`）就是**去掉扩展名**，于是页名里丢掉了唯一定位信息。反之映射键（`excerptExports.json`）用的是 `{rootId}/{relPath}`，**是**区分格式的 —— 两套口径不一致，问题只在页名上。

**根因**：页名 = 展示名，不是身份。`vaultCreatePage` 遇到重名会加 `(1)` 后缀（实测过：`读书笔记 · 探针样书(1).md`），但那只在「文件确实不存在」时发生；已存在时走的是覆盖重写路径，于是**第二本书静默改写第一篇页**（`count`/`pageId` 都回写成第二本的）。

> ⚠️ **本段后半句已证伪**（2026-09-22）：`uniquePageName` 只会加 `(1)` 后缀、**不会覆盖**。
> 真实后果是「两篇页无法按书名区分」，**无数据丢失** —— 详见上方「★ 修复记录」里的更正段。

**修复方向**（择一，需拍板）：
- **A**：页名带格式后缀（`读书笔记 · 探针样书.fb2`），与映射键口径对齐；缺点：页名出现扩展名，观感略生硬。
- **B**：页名不变，但导出前先查映射表里是否已有**别的书**占用了该页名，撞了就加区分后缀（`.fb2` / `(2)`）。逻辑更绕、但普通情况页名干净。
- **C**：接受现状，仅在「同一仓库里去掉扩展名后同名的书」这一条件下触发，属边缘场景 —— 但**是静默数据覆盖**，不建议只记录。

**验证**：造 `a.epub` 与 `a.fb2` 各含 1 条摘录 → 依次导出 → 两篇页都在、内容互不覆盖；再各导一次确认幂等（同一本书仍只一篇页、id 不变）。探针可挂在 `probe-excerpt-export.mjs` 后面加一步。

**★ 第三个撞车者（2026-09-22 补，来自阶段 2b）**：cbz 接入后 `.cbz` 同样进 `BOOK_EXTS`，`探针样书.cbz` 的展示名也是 `探针样书` ⇒ 撞车面从「两种格式」扩到**三种**（epub / fb2 / fbz / cbz 任意两个同名即撞）。**这不改变修法**（A/B/C 三选一的取舍与格式无关），只是把触发概率抬高了一档 —— 探针 fixture 恰好四本同前缀，`--add-books` 造的样书**天然命中**。

---

## [x] B-16 cbz（画集）的两个体积/卡顿隐患：128MB 上限偏紧 + zip 在主线程同步解包（2026-09-22，P3）

**现象**（尚未收到用户报告，是阶段 2b 落码时从源码推出的**预判**）：打开一本大画集（几十上百 MB、几百页）时，应用会**卡住一段时间**再显示第一页；超过 `MAX_BOOK_BYTES` 则直接**打不开**（报体积超限）。
**读数修正（2026-09-22 实测）**：「纯白等」不准确 —— `loading` 期间**已有** `Loader2` 转圈（`data-wb-state="loading"`）；缺的是**阶段/进度文字**（读了多少字节、在解包还是在等首帧），用户无法区分「在加载」和「卡死了」。

**定位**（2026-09-22 复核，原写错了）：
- 体积闸门**在渲染层**：`src/components/shared/epub/EpubReaderView.tsx:50` 的 `MAX_BOOK_BYTES = 128 * 1024 * 1024`（`readWholeBook` 里比 `first.size`）。~~原先记的「`electron/lib/workspaceManager.ts` 的 `MAX_BOOK_BYTES`」不存在~~ —— 主进程 `readWorkspaceRange` **没有任何体积闸门**，只有扩展名白名单（`RANGE_EXT_WHITELIST`）。
- 主线程解包：`src/vendor/foliate/view.js:26` 的 `configure({ useWebWorkers: false })` —— **上游默认就是 false**，我们只是没改。于是 `zip.js` 的 `BlobReader`/`ZipReader` **全部在主线程**跑。

**根因**：文字类书（epub/fb2）体积在几 MB 量级，主线程解包无感；**画集是图片归档，体积高一个数量级**，于是同一份配置从「无感」变成「可感知卡顿」。这两条都是**量变引起质变**，不是配置写错了。

**影响面与定性**：
- 128MB 上限：画集越界是「**打不开**」（正确性阻断），但上限本身是**有意设的**（防解压炸弹/误选大文件），不是 bug ⇒ 要动得先想清楚放开的代价。
- 主线程解包：是「**打开时卡住**」（体验问题，不是正确性问题）。
- ★ 本批的缩略图队列**没有加剧**这条：它是「按需 + 每页让出主线程」的设计（`docs`/方案 §四），真正的成本只在**首次解包**那一下。

**修复方向**（都留待评估，本轮不做）：
1. 主线程解包 → 试 `configure({ useWebWorkers: true })`（上游支持，但要验：worker 里 blob/URL 的生命周期、打包后 worker 文件能否被 electron-vite 正确产出 —— **分包与 CSP 都要看**）。收益是最大的，风险也最集中。
2. 体积上限 → 按**扩展名分档**（画集给更大额度）或改成「超限时弹确认框、用户点继续才加载」。别直接一刀抬到无限。
3. 兜底体验（无论 1/2 做不做都值得）：解包期间给个**可见的加载态**（现在打开大书是纯白等），避免「看起来死了」。

**★ 实测分解（2026-09-22，本机；工具 = `tmp/make-big-cbz.mjs` + `tmp/probe-cbz-perf.mjs`，两份都**不进 git**）**

fixture 刻意造在 128MB 闸门**之下**（96.2MB / 126 页噪声页 —— 噪声不可压缩，zip STORED 后 ≈ 页字节总和）：先量清「现行策略允许的最坏情况」，超限区现在根本打不开、无从测量。

| 量 | 数值 |
|---|---|
| 点卡 → `data-wb-state=ready`：小书（258KB / 60 页） | ~550ms ← **固定开销基准**（zip 解析 + foliate 初启 + 首页解码） |
| 同上：96MB 大书 | **1.6–2.0s** |
| 读取链路 `readWholeBook`（96MB，页面侧独立复算） | **~1.5s**（≈62MB/s） |
| ├ IPC 传输（`ws:readRange`；**与分块大小无关**，8/16/32/64MB 拉完总时长都在 550–650ms） | ~600ms ＝ **160MB/s 天花板** |
| ├ base64 解码（`atob` + 逐字节循环；本版 Chromium **无** `Uint8Array.fromBase64`） | ~660ms |
| └ O(n²) 重分配拼接 | ~110ms |
| 磁盘地板（`readFileSync` 96MB，页缓存命中） | **34ms**（2.8GB/s） |

**由实测得出的四条结论**（都不是推断）：
1. **卡顿的主体是读取链路，不是 zip 解包** ⇒ 原「修复方向 1（worker 化）」**经测无收益**：读路径全在渲染主线程，而 Web Worker **拿不到** `contextBridge`（`window.api`），搬不动；zip 索引解析本身只占固定开销里极小一块。
2. **160MB/s 是 `ipcRenderer.invoke` 的 V8 结构化克隆天花板** —— 临时加的一条「字节直传」通道实测同为 ~160MB/s（首块 8MB：字节 49ms / base64 39ms），换通道只省得掉解码那一段。
3. **渲染侧即可省 ~0.77s**（1.5s → ~0.73s）：字节通道（免解码）+ 预分配一块就地写入（免 O(n²) 拼接）。零 CSP / 安全面改动。
4. **内存面**：读链路同时存在三份 96MB（u8 / 合并副本 / ArrayBuffer），`new File()` 再复制第四份 ⇒ 峰值 ≈ **4× 文件体积**（500MB 的书 ≈ 2GB）。这是「上限不能无限抬」的硬理由。

**验证**：①用 `tmp/probe-cbz-perf.mjs` 复算读取链路（改前 ~1.5s / 改后 ~0.73s）；②加载期有阶段+进度文字；
③ 超限那一档有明确提示而不是静默失败。**★ 别用 long task 当判据**：本机 `PerformanceObserver('longtask')` 在 renderer 里
一条都收不到（即便同时有 1.5s 的读链路）—— 判据用**墙钟 + 页面侧微基准**。

### ★ 修复记录（2026-09-22 落码；用户当日拍板两条方向）

原「修复方向 1（worker 化）」**按实测撤掉**（结论 1：读路径搬不进 worker），替换为**读取链路优化**；
体积上限从「一刀切打不开」改为**三档 + 超限确认框**（用户原话：「大的先问一句」）。

| # | 改动 | 落点 |
|---|---|---|
| 1 | 三档判定 + 全部用户可见文案，**零依赖纯函数**（照 `releaseNotes/judge.ts` 先例，契约脚本可直接 import） | `electron/lib/kbStore/bookSizeGate.ts`（新） |
| 2 | 主进程抽出 `readRangeBuffer()` 为**唯一 core**（白名单 / 偏移 / 越界只此一份）；base64 出口 `readWorkspaceRange` 与新增 `readWorkspaceRangeBytes`（回 `Uint8Array` 零拷贝视图）都转发它；新增 IPC `ws:readRangeBytes` | `electron/lib/workspaceManager.ts` |
| 3 | `api.workspaceReadRangeBytes` + 渲染侧类型镜子 | `electron/preload/index.ts` / `src/types/index.ts` / `src/lib/ipc.ts` |
| 4 | `readWholeBook` 重写：字节通道 + **预分配一块就地写入**（`new Uint8Array(total)` + `.set()`）；装载流程加体积闸门 + 确认框 + 取消态；加载覆盖层加阶段/进度文字；删 `b64ToU8` | `src/components/shared/epub/EpubReaderView.tsx` |
| 5 | 确认框加探针锚点（`data-wb=globalConfirm*`，纯测试面，无行为变化） | `src/components/shared/GlobalConfirm.tsx` |

**分档口径**（`BOOK_SILENT_MAX = 128MB` / `BOOK_HARD_MAX = 384MB`，端点含上）：

| 档 | 判据 | 行为 |
|---|---|---|
| 静默 | ≤ 128MB | 照旧直接开 |
| 确认 | 128MB < size ≤ 384MB | `showGlobalConfirm` 写明**体积 / 预计耗时 / 预计内存**，点「仍要打开」才继续 |
| 拒绝 | > 384MB | 不读、直接 error 态，文案给体积 + 上限 + 建议 |

取消的落点是 **error 态 + 「仍要打开」**（不是踢回书架）：可逆、不产生意外跳转，再点一次 = 复跑装载
（`reloadKey` 递增，`bigOkKeyRef` 记住「已确认过」避免追问第二遍）。

**★ 实测前后（同机同 fixture，96.2MB / 126 页噪声页 cbz）**：

| 量 | 改前 | 改后 |
|---|---|---|
| 点卡 → `ready`（小书 258KB 基准） | ~550ms | 457ms |
| 点卡 → `ready`（96MB） | 1.6–2.0s | **805ms** |
| **体积增量（大书 − 小书）** | ~1.4s | **348ms** |
| 整本读回（探针页内复算，8MB 块 / 含逐字节 FNV） | ~1.5s | 690ms |
| 内存峰值 | ≈ **4×** 体积 | ≈ **2×**（u8 + `new File()`） |

`READ_EST_MBPS = 120` / `PEAK_MEM_RATIO = 2` 就是照这张表定的（宁可比预告快，不比预告慢）；改这两个常数
必须同步重跑 `probe-cbz-bigbook.mjs`。2026-09-22 复核：131MB 的书文案报「约 2 秒 / 262 MB」，实测 1.09s 开完 —— 符合预留冗余的口径。

**★ 期间探针抓到的一个真缺陷（顺手修掉）**：装载 effect 第一步是 `const host = hostRef.current; if (!host) return`，
而宿主 div 原先只在**非 error 分支**渲染 ⇒ 「取消」后点「仍要打开」时宿主不在 DOM，effect 直接 return，
`reloadKey` 递增了却什么都没发生（表象 =「按钮点了没反应」）。修法：宿主**常驻 DOM**（error 态改成覆盖宿主而非替换它）。
这条断言现在锁在 `probe-cbz-bigbook.mjs` 里（改前红、改后绿）。

**验证（2026-09-22）**：
- 新增 `.AGENT/scripts/workbench-shell/probes/make-big-cbz.mjs`（大书生成器，**确定性**：定种 PRNG + 固定 zip 时间戳 ⇒ 产物 sha256 逐轮相同；原 `tmp/` 的两份一次性侦察脚本已删）+
  `seed-probe-vault.mjs --add-big-books`（96MB / 130MB 两本，默认不落，约 226MB 磁盘）。
- 新增探针 `probe-cbz-bigbook.mjs`：整本走新通道分块读回做 **FNV-1a 逐字节等值**（小书 + 96MB × 8MB/1MB 两种块大小）、
  阶段/进度文字采样（`正在读取 N%` → `正在解包排版…`，百分比非递减）、130MB 确认框文案含真实体积、
  取消 → error → 「仍要打开」→ ready 且不再问第二遍、耗时表 + 体积增量 < 1000ms 兜底。**全绿**。
- `verify-reader-formats.mjs` 新增 §⑭（分档三档含端点 / 文案同口径 / 阈值只有一份 / 读取链路源码镜像 /
  两通道共用 core / IPC 三处同步），**全绿**；既有 5 个阅读器契约与 `probe-cbz-reader` / `probe-epub-reader` /
  `probe-fb2-reader` / `probe-reading-panel` **不回归**。
- **★ 别用 long task 当判据**（同上，实测取证）。

---

## [x] B-17 `fixed-layout.js` 的 `#render` 有 ResizeObserver 竞态：每次翻页控制台一条未捕获 TypeError（2026-09-22，P3）

### ★ 修复记录（2026-09-22，落码为 **patch ⑥**；契约 `verify-epub-formats.mjs` §⑪ 三条全绿）

| # | 改动 | 落点 | 治的是 |
|---|---|---|---|
| 1 | `#render()` 在算出 `right` 之后加早退 `if (!right) return` | `src/vendor/foliate/fixed-layout.js` `#render`（patch ⑥） | 根因本身 —— await 窗口内无帧可渲时不再进坐标系 |

**为什么判据是「`right` 缺席」**：第一版写的是「三槽全空早退」，落码后复核发现它**罩不全** ——
`#showSpread` 有**两个** await 窗口：① 清空后第一个 `await`（三槽皆空，被它罩住）；
② 双页路径里 `#left` 已挂上、`#right` 仍为 null 的那一段（`#center` 也是 null ⇒
`right` 为 null）。窗口 ② 里 `side === 'left'` 时 `target.width` 与 `blankWidth` 都不抛，
最后由 `transform(right)` 解构 null 抛 —— 「三槽全空」判据放它过去。改成 `!right` 后两个窗口一并罩住
（`right` 缺席时 `left` 若是 `{}`，下面只会算出 `NaN`；半边帧也出不了把左右相加的拼版宽度）。
契约据此加了一条**覆盖性顺序断言**：`transform(right)` 必须排在守卫之后（就是窗口 ② 那条）。

**顺带撤掉了探针里的定点过滤（这才是这条修的真验证）**：`probe-cbz-reader.mjs` 以前把
`Cannot read properties of null (reading 'width')` 当**已知噪声定点滤掉**（当年确实修不了）。
patch ⑥ 落码后改成**硬断言零条** —— 留着过滤等于把这条修的验证也一起滤掉了。
这是「不报错」类修复的通病：没有断言，后人删掉守卫不会有任何反馈。同时 §9 那段
`[噪声提示] 接下来的 TypeError 不是断言失败` 的终稿说明也已删（现象不存在了）。

**登记面同步**（这是上文说「有仪式成本」的那部分，一次做完）：
- `src/vendor/foliate/README.md`：补丁表 **5 处 → 7 处**（新增 ⑥⑦）、升级流程「重放上述 7 处 patch」、
  两处计数行；⑥ 条目含「为何这条守卫安全」与「上游若修掉照此删」。
- 契约新增 §⑪：早退在位 · ★ **位置断言**（在 `const right = …` **之后**、`const target = …` **之前** ——
  早了是引用未声明变量，晚了就先在 `target.width` 上抛）· ★ **覆盖性断言**（`transform(right)`
  也排在守卫之后 = 窗口 ②）· 前提断言（`#observer` 回调仍直连 `#render`，即窗口期的触发路径）·
  负向「未顺手把 `allow-scripts` 加回来」· README 计数＝7 与升级流程同步。

✅ **实机验证（2026-09-22 完成）**：`probe-cbz-reader.mjs` 那条硬断言（连翻多页 + 进出多轮，全程零
`Cannot read properties of null (reading 'width')`）**全绿**；同一次会话里渲染层错误列表为空（`[[]]`）。

★ **另做了一次前后对照（`git stash` 掉本 patch → 重建 → 跑同样的序列），结论要按这个说**：

| 序列（同序同实例） | 无守卫（pre-⑥） | 有守卫（post-⑥） |
|---|---|---|
| cbz 连开 3 轮 | 0 / 0 / 0 | 0 / 0 / 0 |
| epub 2 轮 | 355 / 532 | 333 / 508 |
| 再 1 轮 cbz | **622** | 8 |

- **观感无差别**：两版在「打开 cbz 后的稳定帧」上截图**逐像素几乎相同**（都正常落位，紫色页 + 进度 14%）。
  即本 patch 的**已验证收益是「异常消失」，不是「版式被修好」** —— 那个抛异常的窗口期过后版式本来就会被
  下一次显式 `#render()` 纠正（原条目里写的「页面观感正常」是准确的，别被「修了个竞态」误读成「修好了版面」）。
- **前文那个 RO 环告警（`loop`）计数与本 patch 无关**：epub 路径 patch ⑥ 碰不到（另一套引擎），
  两版都在同一量级（355/532 vs 333/508）；cbz 路径在**同一个 post-⑥ 构建**上跨会话从 288/303/298 跳到 0/0/0
  ⇒ 该计数是**状态依赖**的，不构成对本 patch 的判据；而两版里最大的一次读数（622）出在**被 stash 掉的**那一版。
  残余刷屏已另立 **B-21**。

**现象**：打开任何 cbz（固定版式书），**每翻一页**控制台就出现一条未捕获异常：

```
Uncaught TypeError: Cannot read properties of null (reading 'width')
  at fixed-layout-*.js:417
```

**页面观感正常**（版式被后续那次显式 `#render()` 纠正回来了），所以这是「控制台红字」级别的问题 —— 但**每次翻页一条**，排查别的问题时会被它干扰（探针已把它显式指名滤掉）。

**定位**：`src/vendor/foliate/fixed-layout.js` 的 `#render()`（打包后 `fixed-layout-*.js:417`）

**根因**（上游 latent bug，被我们的配置放大）：
- `#showSpread({ center })` 先把 `#left` / `#right` **置 null**，再 `await #createFrame(center)`；
- 这个 await 窗口内若有 ResizeObserver 回调触发 `#render()`，它读的是 `const right = this.#center ?? this.#right`（`#center` 此刻也还没赋上）⇒ **null.width** ⇒ 抛。
- 上游默认用例里每节是「左 / 右 / 中」三选一，窗口期短、命中概率低；我们拍板 `rendition.spread = 'none'` ⇒ **每节都是 `{center}`** ⇒ `#center` 在窗口期必为 null ⇒ **每次翻页必踩**。

**修复方向（本批没做，理由见下）**：
- 上游一行即可修：`#render` 开头加 `if (!right) return`（或在 `#showSpread` 里先赋 `#center` 再 await）。
- ★ **阶段 2b 明确不加第 6 处 vendor patch**（该批把 patch ⑤ 限定在 `comic-book.js`，见 `.claude/plans/b-stage2b-cbz.md` §C/§九）。要修就得**另开一次 patch 批次**：`src/vendor/foliate/README.md` 的补丁表 + 「5 处 / 6 文件」计数 + 契约脚本的负向断言都要同步改，属**有仪式成本**的动作，不适合顺手塞进 2b。
- 若将来升级 foliate 版本，先看上游有没有自己修掉。

**验证**：连续翻 20 页 → 控制台**零** `Cannot read properties of null` 异常；版式与现在一致（帧数、fit-page/fit-width 几何不变）；`probe-cbz-reader.mjs` 全绿（该探针的噪声过滤可一并撤掉）。

---

## [x] B-18 cbz 里的 `.svg` 页显示为破图（`loadBlob` 不传 MIME）（2026-09-22，P3）

### ★ 修复记录（2026-09-22，落码为 **patch ⑦**；契约 `verify-epub-formats.mjs` §⑪ 全绿）

**选 A**（按后缀推 MIME）—— C「接受」在上一轮是暂缓，本轮按同一批 patch 摊薄仪式成本后一并做掉。

| # | 改动 | 落点 | 治的是 |
|---|---|---|---|
| 1 | 页图 `loadBlob` 传 MIME 第二实参（新增 `MIME_BY_EXT` 表 + `mimeOf(name)`） | `src/vendor/foliate/comic-book.js` `load()`（patch ⑦） | 根因 —— Blob `type` 由 `''` 变成正确 MIME，Chromium 才选得出解码器 |

**三条断言缺一不可**（少任一条都回到破图，且都是**静默**的）：
1. 调用处确实传了第二实参（不传 ⇒ `BlobWriter(undefined)` ⇒ `type=''`）；
2. `mimeOf` 取后缀**大小写不敏感** —— 与 patch ⑤-b 配对：⑤-b 放 `.JPG`/`.PNG` 进白名单，
   这里若大小写敏感，那一类页就是「进得来、显示不出」（比彻底不收更糟，因为不报错）；
3. **MIME 表 ⊇ `exts` 白名单全量**（契约里是**交叉校验**：从源码解析两组集合比对）。
   漏一项 = 那一类页静默破图，而白名单偏偏让它照进归档 —— `.svg` 原来就是唯一那个漏项。
   ★ 这条交叉校验是防「以后给 `exts` 加格式、忘了给 MIME 表加」的唯一防线，别删。

**探针侧的升级（B-18 的真验证）**：恶意样书的第 2 页**就是** `page_2.svg`（800×1120），
所以 `probe-cbz-reader.mjs` 原本那条「已知产品缺口：本帧 `img.naturalWidth` 实测 0」的 note，
现在换成**硬断言 800×1120**。原来只能做「同一份载荷在正确 MIME 下可解码却不执行」的**间接**对照
（因为当场解不出来），现在正面判据和数据都在同一个 `<img>` 上 ——
且「标志位全 null」那条安全断言**同时**锁住了「补 MIME 不打开新攻击面」：加了 MIME 之后
`<img>` 里的 SVG 依然不执行脚本（与 MIME 无关，`img` 通道本就不跑脚本）。

★ 只改了**页图**路径。`book.getCover` 同样是裸 `loadBlob`，但宿主没接（宿主用 ⑤ 暴露的
`getPageBlob`），不动它以免扩大改动面 —— 这条取舍已写进 vendor README 的 ⑦ 条目。

✅ **实机验证（2026-09-22 完成）**：`probe-cbz-reader.mjs` 里原来那条「已知产品缺口」note 已换成硬断言，
实机报 `{"scripts":0,"onerrorAttr":0,"imgNw":800,"imgNh":1120,"imgSrc":"blob:","sandbox":"allow-same-origin"}`
—— 该 SVG 页**确实解码了**，且四个安全标志位仍全 null（补 MIME 没打开新攻击面）。**全绿**。
（未做「stash 掉 patch ⑦ 再测」的反向对照：判据是同一个 `<img>` 上的 `naturalWidth`，正向值已足够定案。）

**现象**：cbz 归档里若某一页是 `.svg`，那一页打开是**破图**（`<img>` 加载失败、`naturalWidth = 0`），其余 PNG/JPEG 页正常。属**静默降级**，没有任何报错。

**定位**：`src/vendor/foliate/comic-book.js:8`（`URL.createObjectURL(await loadBlob(name))`）→ `loadBlob` 的定义在 `view.js` 的 `makeZipLoader`（`loadBlob = load((entry, type) => entry.getData(new BlobWriter(type)))`）。调用处**没传 `type`** ⇒ `new BlobWriter(undefined)` ⇒ 造出的 Blob `type = ''`。

**根因**：`<img>` 的 `src` 指向 `blob:` 时，Chromium **靠 Blob 的 MIME 决定解码器**；`type = ''` 时按「未知类型」处理并**拒绝**，不会退化成按魔数嗅探。
- PNG / JPEG / GIF / WebP 之所以"看起来没事"：它们走的是**图片嗅探**路径（且这几类本来就在浏览器硬编码的嗅探表里）。
- SVG **必须**有 `image/svg+xml` 才解码 —— 实测同一份字节：`type:''` → **error**；`type:'image/svg+xml'` → **ok:800x1120**。
- ★ 这也是 `comic-book.js:19` 的 `exts` 白名单**收了 `.svg` 却不生效**的原因（白名单让它进了归档，解码这一关又把它挡回来）。

**与安全的关系（重要，别误读）**：这条**不是**安全缺口，反而是安全结论的**旁证** —— `<img>` 里的 SVG 在**任何** MIME 下都**不执行脚本**（阶段 2b 的恶意样书探针已实测：正确 MIME 下可解码、标志位仍全 null）。所以修它**不会**打开任何新的攻击面（`img-src` 只放行图片，内容帧 sandbox 仍无 `allow-scripts`）。

**修复方向**（择一）：
- **A 按后缀推 MIME 传给 `loadBlob`**（`comic-book.js` 里已有扩展名 → 类型的映射可复用），一行左右；**但属 vendor 改动**（2b 已定「只动两处」，这条要另开 patch 批次，同 B-17 的仪式成本）。
- **B 把 `.svg` 从白名单剔除** —— 改了反而**降低**能力（能显示的页面变少），不推荐。
- **C 接受** —— 实机画集极少用 SVG 当页，影响面接近零。**本轮的选择**。

**验证**（若选 A）：恶意样书 / 探针样书里放一页 `.svg` → 该页正常显示（`naturalWidth > 0`），且探针的安全负向断言**仍全绿**（标志位 null、sandbox 不含 `allow-scripts`、`script-src` 无 `'unsafe-inline'`）。

---

## [x] B-19 退出书籍回书架后，终端刷 ~266 条 `ResizeObserver loop completed with undelivered notifications`（2026-09-22，P2）

### ★ 修复记录（2026-09-22，落码 + 契约 `verify-devbridge-logging.mjs` 28 项全绿）

按上文「修复方向」逐条落地，**四条一起做**才闭环（只做一条都会被另外一条抵消）：

| # | 改动 | 落点 | 治的是 |
|---|---|---|---|
| 1 | `measure()` **同值短路 + 未布局(0×0)早退** | `src/components/shared/pdf/PdfReaderView.tsx` | 治本 A/B —— 断掉「测量 → setState → 缩放变 → 尺寸变 → 滚动条进出 → 再测量」的反馈环；0×0 早退顺带干掉保活 `display:none` 期间 `Math.max(120,…)` 造出的**假 120** |
| 2 | 渲染层日志**按「来源+消息体」窗口去重限流**（1s 一次，压掉的条数回显 `[+N 条同类已折叠]`） | `electron/main/index.ts` `console-message` | 治标 C —— 终端不再被同一条刷屏；**不整条静音**，别的模块真出问题照样看得见 |
| 3 | `recordLog` **折叠紧邻同消息**（同 scope/level/message 累加 `count` + 刷新 `lastTs`，不新占条目） | `electron/devbridge/capture.ts` | 配套建议 —— 500 条日志环不再被单体刷屏挤爆（**这正是上次吃掉同段其它证据的原因**）；`aggregateErrors` 同步认 `count`/`lastTs`，聚合数不缩水 |
| 4 | `did-fail-load` **判主帧**（子帧 `ERR_ABORTED` 是有意取消） | `electron/main/index.ts` | 同族噪音 —— 进出书籍各一条的假窗口级故障 |

- ★ **`scrollbar-gutter: stable` 早已在位**（`pdfViewerTheme.css:51`），故治本 A 只剩 measure 那一半。
- ★ **有意不做**：把沙箱拦截消息（`Blocked script execution in 'blob:…'`）从日志环里滤掉 —— 它是**防线生效的常态输出**、每次开书仅 1~2 条，不构成刷屏；为它加一条消息名过滤，反而会在真出 CSP 问题时把信号一起吞掉。
- ✅ **实机 Δ=0 已确认（2026-09-22）**：手法 = 装着 devbridge 的 dev 实例 + fixture 仓库，先 `ro-attrib.mjs install`
  再按标题指书做「开书 → 返回书架」，取 `/errors` 聚合的 Δ。**本条要治的两条路径都 Δ=0**：

  | 书 | 引擎 | 主文档 RO 回调 | 日志环 RO Δ |
  |---|---|---|---|
  | `.books/探针样书.txt` | txt | 0 | **Δ=0** |
  | `.books/Reader Sample (light).pdf` | pdf | 3（pdfjs×2 + `PdfReaderView`×1） | **Δ=0** |

- ⏳ **但仍有一处残余，且不在本条范围内**：foliate 系（epub/cbz）每轮**仍刷 168~622 条**，已另立 **B-21**
  （并订正了下面「已排除」第 1 条的错判 —— 那台观察者其实**在**主文档里）。

**现象**：在 dev 实例里从某本书退出回书架后，跑 `npm run dev` 的那个终端**整屏刷**同样的行（用户截图 ≈ 200+ 行）：

```
[Renderer] ResizeObserver loop completed with undelivered notifications. (http://127.0.0.1:7173/:0)
```

**界面观感正常**（无白屏、无卡死、书卡与进度都对），所以这也是「终端刷红字」级别的问题 —— 但**一次刷两三百行**足以淹没真报错，且背后是真实的布局抖动。

**量化证据**（devbridge `GET http://127.0.0.1:7465/errors` 的聚合项，2026-09-22 实测）：

| 计数 | 作用域 | 区间 | 跨度 |
|---|---|---|---|
| 266 | `renderer` | 06:37:58.564 → 06:38:00.010 | **1.45 s** |
| 234 | `main`（转发副本） | 06:37:58.569 → 06:38:00.004 | 1.44 s |

→ **不是持续刷屏，是退出瞬间的阵发**：≈183 条/秒 ≈ 每帧 2~3 条，持续 1.45 s 后**收敛归零**（此后反复读取该聚合，count 不再增长）。这个「每帧多条、约 1.5 s 内衰减」的形态，正是**尺寸依赖型布局在收敛**的签名（滚动条出现/消失一类），不是死循环。

**为什么会被终端刷屏（放大器，不是根因）**：`electron/main/index.ts:316-320` 把渲染层 `console-message` 中 `level >= 2` 的**无条件** `console.error('[Renderer]', …)` 转发到 stdout；而 Chromium 把 ResizeObserver 环告警当作**错误事件**投递 ⇒ 一条浏览器内部告警变成了 N 行终端输出。

**已排除的两件事**（都有证据，避免下次重走）：
1. ~~**不是书籍内容帧（foliate）里的 observer**：foliate 的观察者全在内容帧内，故可排除。~~
   ★ **这条判错了（2026-09-22 订正，留档防再走）**：前一句的 sourceId 论证只能证明「告警**投递**在主文档」，
   推不出「foliate 的观察者不在主文档」。实机包一层 RO 构造器后看得清清楚楚 —— foliate 系每轮造出的观察者
   栈是 `at new RO… <- at <instance_members_initializer> (out/renderer/…)`，也就是
   **`#observer = new ResizeObserver(…)` 这种类字段**（`paginator.js` / `fixed-layout.js` / `view.js` 都是这个写法），
   `foliate-view` 宿主元素**就在主文档**里（内容帧才是它内部的 iframe）。⇒ 这条**不能排除**，反而正是残余刷屏的嫌疑人。
2. **不是 B-17**：B-17 是「翻页 → 一条未捕获 TypeError」（`fixed-layout.js` 的 `#render` 竞态），形态与计数模式都不同，属另一处 RO 家族问题。
   （B-17 修掉后残余刷屏仍在 ⇒ 这条排除**成立**，见 B-21 的前后对照。）

**未复现说明（重要）**：装了构造期归因探针后，跑「打开→返回书架」共 **5 轮 epub + 1 轮 PDF**，主文档 RO 回调 **0**、`/errors` Δ告警 **0** ⇒ **简单进出不足以复现**，需要「当时的那个触发条件」。故本条**尚未锁定到唯一 observer**，下面给主推根因与归因手法。

**★ 观测环境（2026-09-22 追加，重要）**：本条的观测与探针全部跑在**当时 7173 上的 dev 实例**，而该实例实际服务的是 `E:/Projects/KnowledgeRecorder-ui-rework` 检出 —— 判定手法：往两个检出各放一个同名标记文件，再问 dev server 要它（返回 `export const TREE = "UIREWORK"`）。两条结论：

- 归因所依据的代码在**两树一致**（`ui-rework` 的 `PdfReaderView.tsx:147 / :262-264 / :267` 与主仓同款），故下面的根因分析对两树通用；但**修的时候改主仓**（阅读器 B 段及后续收尾都只提在主仓）。
- 这暴露了「dev 实例跑在非预期检出」的老毛病（与 2026-09-22 上午「桌面启动无 EPUB」同源）。**排查 UI 问题前先确认实例服务的是哪个检出**，否则会出现「改了没反应 / HMR 不生效」的假象 —— 判定脚本 `tmp/tree-probe.mjs` 可复用。

**主推根因（代码锚定）**：`PdfReaderView` 的「测量回灌」构成滚动条抖动的反馈环 ——
- `src/components/shared/pdf/PdfReaderView.tsx:258-272`：`new ResizeObserver(measure)`，而 `measure()` **每次回调都 `setAvailW/setAvailH`**（无同值短路）；
- `availW/availH` 又喂给 `:550`（依赖数组含 `availW, availH` 的 `applyAutoScale`）、`:749-752`（宽度是否瓶颈）、`:817`（双页降级）⇒ **缩放/模式会随测量值变化**；
- 缩放一变，内容尺寸变 ⇒ `:1326` 的滚动容器（`absolute inset-0 overflow-auto`）**滚动条出现或消失** ⇒ `clientWidth` 跳 ~15px ⇒ 触发下一次回调 ⇒ 环。

**次要候选（保活模块，`display:none` 也仍挂着）**：`src/modules/desktop/index.tsx:220`（`:224` 注释已记「切走时容器宽度 0、RO 不触发」—— 说明该风险团队有感知）· `src/components/workbench/AiUsagePanel.tsx:122` · `src/modules/knowledge/components/graph/GraphCanvas.tsx:529` · `src/modules/ai-teaching/index.tsx:1942` · `ArtHtmlView.tsx:51` · `useFloatingWindow.ts:174`；另有 `pdfjs-dist` 官方 viewer 内部 RO 与 Monaco `automaticLayout`（都不可 grep）。

**★ 复现与归因手法（留档，否则下次要重做）**：
1. **判定靠差量，不靠肉眼看终端**：读 devbridge `/errors` 聚合项的 `count` + `lastTs`，动作前后各读一次取差（探针 `tmp/ro-probe.mjs` 的 `scan`/`cycle` 动作即此法）。
2. **归因靠「构造期包一层」**：在渲染层包 `ResizeObserver` 构造器，记录 `new Error().stack` + 每次回调的 target 尺寸与时间戳，再按创建点聚合。
   ⚠️ **只能抓到安装之后创建的实例** ⇒ 顺序必须是「先装探针 → 再进书 → 再退出」；探针已收编进库：`.AGENT/scripts/devbridge/ro-attrib.mjs`（原 `tmp/ro-probe.mjs`）。
3. 复现时把「进书前 / 退出时是否伴随窗口变化（改尺寸、最大化）、右栏 Tab 切换、左栏折叠」一并记录 —— 本轮就是缺这个上下文才没能复现。

**修复方向**：
- **治本 A（推荐，一行级）**：`measure()` 里加**同值短路** —— `const w = Math.max(120, el.clientWidth), h = Math.max(120, el.clientHeight); if (w === availWRef.current && h === availHRef.current) return`，断掉「回调 → setState → 布局再变」的环；配套给滚动容器加 `scrollbar-gutter: stable`，让滚动条出现/消失不再改变 `clientWidth`。
- **治本 B**：保活（`display:none`）期间在回调里跳过 0 尺寸，别用 `Math.max(120, …)` 兜底成假值（120 会与真实尺寸来回跳）。
- **治标 C（可与 A 并行）**：`electron/main/index.ts:316-320` 的转发加**按消息去重限流**（例如同一条消息每秒最多一次），避免真错误被淹没；**不要整条静音** —— 这类告警在别的模块里可能真是缺陷信号。

**验证**：复现该路径时 `/errors` 里 ResizeObserver 项 **Δ = 0**；终端最多一行提示；阅读器缩放/双页降级/进度还原行为不变（`probe-pdf-reader` 类探针全绿）；窗口从大到小拖动时页面不再抖动。

**同族噪音与一个副作用（2026-09-22 追加，建议一并处置）**

同一段会话里还出现过另两类消息（`GET /errors` 全量清单共 7 条，按 `count/firstTs` 分三类）：

| 类别 | 计数 | 时间戳 | 判明 |
|---|---|---|---|
| `[Window] did-fail-load: {errorCode:-3, validatedURL:'blob:http://127.0.0.1:7173/<uuid>'}` | 3 | 06:41:29 / 06:41:59 / 06:45:01 | **良性**：书籍内容帧的导航被**主动中止**（ERR_ABORTED），发生在「帧还没加载完就被拆掉/换掉」的时序 —— 每次进入+退出书籍各一次（时间戳与探针那几轮打开/退出完全对齐） |
| `[Renderer] Blocked script execution in 'blob:…' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.` | 2 | 06:43:16 / 06:45:11 | **期望行为，不是缺陷**：正是铁律 10 的第二道防线（内容帧 sandbox 不含 `allow-scripts`）在拦书页内脚本；样例里那几本「恶意样书」就是为此造的，`verify-epub-formats.mjs` 有负向断言锁着 |

处置建议：

- **`did-fail-load` 加主帧判据**：该事件对**子帧**也会触发，而我们的 handler（`electron/main/index.ts:309-311`）不看 `isMainFrame` 就按窗口级错误报 —— 子帧的 `ERR_ABORTED` 属正常取消，应过滤（`if (!isMainFrame) return`，或对 `-3` 静默）。
- **沙箱拦截消息不进日志环**：它是「防线生效」的常态输出，dev 下每次打开带脚本的书都会来一条；建议不进 `logRing`（或降为 info），否则会被误认为错误。
- ★ **真正的副作用（本条的存在意义）**：devbridge 的日志环容量只有 **500 条**（`electron/devbridge/capture.ts:39` `logRing = new Ring<LogItem>(500)`），而本次 RO 刷屏单体就产生 **266 条**（renderer）+ **234 条**（main 转发副本）⇒ **把环形缓冲挤爆，把之前/同时段的其他报错挤了出去**。
  - 这解释了排查中观察到的「计数从 266 衰减到 260」：不是错误消失，是旧条目被挤出环（**我以为的"收敛"在计数上混合了挤出效应**，真实收敛判据应以 `lastTs` 停住为准）。
  - 后果：**这次刷屏已经破坏了 06:37:58 之前的证据**，所以不能断言「那次只有 RO 一条」—— 排查者若据此下结论会错。
  - 配套建议：修掉 A（同值短路）后刷屏自然消失；另可给 `logRing` 扩容或在入环前**按消息去重计数**（同消息只占 1 条 + count），别让噪声吃掉诊断面。

---

## [x] B-20 渲染层每次会话都刷一条 `MaxListenersExceededWarning: 11 kb:data-changed listeners added`（2026-09-22，P3；**2026-09-22 已修**：方向 A 单点扇出 + 一次性软上限提示）

**修复（2026-09-22）**：`electron/preload/index.ts` 里 `onDataChanged` 改成**单点扇出** —— 只挂
**一个** `ipcRenderer.on('kb:data-changed')`，订阅者进 `Set<cb>`，返回的退订函数从 Set 里摘。
第一次订阅时才接线（`dataChangedWired` 守卫）。遍历用副本，避免某订阅者在回调里退订时后面的漏掉这一拍；
单个回调抛错被吞掉，不牵连同拍其他订阅者。

另外补了**一次性软上限提示**（`DATA_CHANGED_SUB_SOFT_MAX = 50`，稳态十几个）：越线只 `console.warn` 一次，
文案直接指向 `src/lib/dataChanged.ts`。这样两条语义重新分开 —— **同屏订阅者多（正常）不再刷屏，
而「订了不复位」的真泄漏仍有且只有一条信号**。这正是本条的存在意义（原「方向 A」漏掉的一半）。

**验证**：新增契约 `.AGENT/scripts/shared/verify-data-changed.mjs`（**16/16 PASS**）——
静态 ①~⑧ 锁「preload 里 `ipcRenderer.on('kb:data-changed')` 只出现一次」等形状，
行为 ⑨~⑯ 用桩 `ipcRenderer` 跑**真实切片代码**：12 个订阅者 ⇒ `listenerCount === 1`；
广播每人恰好一次；退订一个不影响其余；某个订阅者抛错不阻塞同拍；>50 才提示且只提示一次；20 个订阅者零提示。
另：`tsc -p tsconfig.node.json` / `tsconfig.web.json` 均 0 错，`npm run build` 通过。


**现象**：dev 下（探针跑也行）终端出现：

```
[Renderer] MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 kb:data-changed listeners added. Use emitter.setMaxListeners() to increase limit
```

**本轮偶遇**：跑 `probe-excerpt-export.mjs` 时，点开 TXT 阅读器后出现（换页/开关阅读器都会加订阅者）。

**定位**：`electron/preload/index.ts:563`（`onDataChanged`）+ `src/lib/dataChanged.ts:23`（`useDataChanged`）

**根因（已验证，**不是**泄漏）**：`onDataChanged` 每次调用都 `ipcRenderer.on('kb:data-changed', handler)`，
并返回配对的 `removeListener`；`useDataChanged` 的 effect 也在 cleanup 里 `offPush?.()`。
所以**订阅者数 = 同时挂载的 `useDataChanged` 组件数**，而全仓有 **38 个调用点**
（工作台左右栏 / 各 widget / 阅读器 / 书架 / 知识库面板…），同屏十几个是**正常稳态** ——
Electron 沙箱里 `ipcRenderer` 的默认上限是 10，越过就报。

**但仍值得修**，因为它把两种情形混成同一条消息：**①同屏订阅者多（正常）** 与
**②某个组件忘记 cleanup（真泄漏）**。噪声长期在场后，真泄漏来的时候没人认得出 ——
这正是铁律 1 那条 `useDataChanged` 接线（接错/漏接的表现是「AI 说改好了、界面没反应」）最需要的诊断面。

**修复方向**（择一）：
- **A preload 单点扇出**（推荐）：`onDataChanged` 只注册**一个** `ipcRenderer.on`，内部维护
  `Set<cb>`，返回的函数从 Set 里摘；订阅者再多也只有一个 ipc 监听者。副产品是广播只解一次 payload。
- **B 显式抬上限**：`ipcRenderer.setMaxListeners(50)` 并注明「预期同屏 N 个订阅者」——一行，
  但把「真泄漏」这条路彻底堵死（不推荐单独用）。
- **C 接受**：它是 warning 不是 error，不影响功能。**当前状态**。

**验证**（若选 A）：打开阅读器 + 工作台全开 → 零 `MaxListenersExceededWarning`；
`useDataChanged` 的 38 个调用点行为不变（派发一次、所有匹配 scope 的回调各触发一次）；
契约侧建议加一条「preload 里 `ipcRenderer.on('kb:data-changed')` 只出现一次」。

---

## [x] B-21 foliate 系（epub / cbz）进出书籍仍刷主文档 `ResizeObserver loop` 告警（B-19 的残余）（2026-09-22，P3；**2026-09-22 当日闭环**：根因 = `View.destroy()` 的自我否定之门 → vendor patch ⑧）

**现象**：把任意 **epub / fb2 / fbz / cbz**（即走 foliate 的书）开一次再返回书架，日志环与终端仍收
`ResizeObserver loop completed with undelivered notifications.`（`http://127.0.0.1:7173/:0` = **主文档**）。
B-19 修好的是 pdf/txt 那条路径（那两条已 **Δ=0**），本条是**修完才露出来的残余**。

**量化（2026-09-22 实测，同一实例、同一次会话、按标题精确指书）**：

| 书 | 引擎 | 主文档 RO 回调 | 页内 loop 告警 | `/errors` Δ |
|---|---|---|---|---|
| `.books/探针样书.txt` | txt | 0 | 0 | **Δ=0** |
| `.books/Reader Sample (light).pdf` | pdf | 3（pdfjs×2 + `PdfReaderView`×1） | 0 | **Δ=0** |
| `.books/探针样书.epub` | foliate | 3 | **168 / 333 / 355 / 508 / 532** | Δ=3~5 |
| `.books/探针样书.cbz` | foliate | 1 | **0 ~ 622（见下「双稳」）** | Δ=0~6 |

★ **读数要看两列**：页内计数是几百，而**日志环 Δ 只有几条** —— 那是 B-19 落的两条机制
（`recordLog` 折叠紧邻同消息 + `console-message` 窗口限流）在压。**观感层面已经被压住了**（终端不再刷屏），
但底噪没消：每轮仍有 1~6 条真进环，而且环是被折叠后的 count 占着。

★ **cbz 的计数是双稳的（重要，别拿单次读数下结论）**：同一个 post-⑥ 构建上，一次会话读到
288 / 303 / 298，另一次会话（新实例、同样序列）读到 0 / 0 / 0，再一轮 8 / 622。
⇒ 该计数由**状态**（开书时的面板宽度 / resize 时序 / 存的 zoom 与 locator）主导，不是代码路径的性质。

**归因**：告警的**投递**在主文档，而 foliate 的观察者**也在主文档** —— 给 `ResizeObserver` 构造器包一层后，
每次回调都能拿到创建点栈：`at new RO… <- at <instance_members_initializer> (out/renderer/…)`，
即 `#observer = new ResizeObserver(…)` 这类**类字段**初始化（`view.js` / `paginator.js` / `fixed-layout.js` 都是这个写法）。
宿主元素 `foliate-view` 在主文档里，内容帧才是它内部的 iframe。
（B-19 的「已排除」第 1 条与此冲突 —— 已在原处**订正并留档**，防止后人照它继续排除。）

**与 B-17 无关（已做前后对照）**：把 patch ⑥ `git stash` 掉重建，epub 路径（patch ⑥ 碰不到的引擎）
两版同量级（无守卫 355/532 vs 有守卫 333/508），cbz 路径最大的一次读数（622）出在**被 stash 掉的**那一版。
⇒ 本条**不是** patch ⑥ 引入的，B-17 修掉后它照样在。

**为什么仍值得修**：① 每条 loop 告警 = 那一帧里真的发生了布局抖动，几百条/轮说明 foliate 的
relayout 与容器尺寸在互相追（真机翻页/改窗口大小是否掉帧值得实测）；② 与 B-20 同款理由 ——
噪声长期在场，**真布局抖动来的时候没人分得出**。

**修复方向（先做实验，别直接改 vendor）**：
- **A 宿主侧先定位触发条件（下一步该做的）**：foliate 的 RO 观察的是**阅读区容器**，而右栏
  `ReadingSidePanel` 开合 / 左栏折叠 / 进入阅读器时的布局动画都会改阅读区宽度 ⇒ 每次都进 foliate 的 relayout。
  实验：同一台机器上跑「不动任何面板开书 → 退出」vs「开书往返期间切右栏 Tab / 折叠左栏」，比 Δ。
  若「不动面板」能压到 0，根因在**宿主**，修的地方就不是 vendor（比如别在书开着时做宽度动画，或把面板开合
  改成只动 transform）。
  ★ **这条已被实验否掉（留档防重走）**：「不动任何面板」照样满速刷（**357 条/轮**）⇒ 与面板开合/宽度动画无关。
- **B vendor：给 foliate 的 `#observer` 回调加同尺寸短路** —— 与 B-19 治本 A 同款手法（`measure()` 同值短路），
  落点 `view.js` / `paginator.js` / `fixed-layout.js`。属第 8 处起的 patch，**仪式成本同 B-17**
  （README 补丁表 + 计数 + 契约负向断言 + 升级流程全要同步）。
  ★ **也不是这条**：回调短路治的是「抖动」，而实测是**观察者被永久留在已摘掉的帧上**（每帧一条，速率恒 166/s）。
- **C 接受**：观感无异常、计数已被 B-19 的折叠/限流压住。

---

### ★★ B-21 结案（2026-09-22）：根因 = `View.destroy()` 撞上「帧先被摘」的时序，门自己失效

**为什么刷得那么稳（166 条/秒）**：不是抖动，是**每次 RO 交付周期都发现有无主通知**。
60fps ⇒ 每帧一条 ⇒ 视觉上「稳定 166/s」，与实测逐字吻合。原来那句「cbz 读数双稳」也由此解释：
**更早那本 epub 留下的泄漏在继续刷**，cbz 只是接在后面的观测者（新实例/清空状态时读 0 = 那次没赶上趟）。

**机制（微验证钉死）**：观察一个 **iframe 的 body** → 把这个 iframe **摘掉** → 该观察者从此每帧报一条
（实测 166/s）；`disconnect()` 立刻归零。反之，**主文档**里被观察的普通 div 摘掉后 **0 条/秒**。
⇒ 告警的必要条件是「目标的**帧**没了」，不是「目标不可见」。

**根因**：`paginator.js` 的 `View` 观察内容帧的 `body`，而撤销写在
`destroy() { if (this.document) this.#observer.unobserve(this.document.body) }` —— `this.document`
就是 `#iframe.contentDocument`。宿主的拆卸顺序（`EpubReaderView`：`view.close()` → `view.remove()`）
**先摘 DOM，effect cleanup 才跑**，于是帧已经脱离、`contentDocument` 变 `null`，
**唯一需要它起作用的时刻正是它判据失效的时刻** ⇒ 观察者被永久留在已脱离帧上。
相邻两处上游笔误：`Paginator.destroy()` 撤销的是 `this`（实例）而不是它真正观察的 `#container`；
`this.#view.destroy()` 在 `#view` 为 null 时直接抛，会截断后面的清理。

**定位手法（全部一次性脚本，未进库；可复用的是手法本身）**：
1. 开书前包一层 `ResizeObserver` + `HTMLIFrameElement.prototype.contentDocument` 的 getter，
   录 observe/unobserve/disconnect 的**调用栈**与「读 contentDocument 时帧还在不在」；
2. 用上一步的痕迹证明 `View.destroy()` **确实跑了**，而它读 `contentDocument` 得到 `null`；
3. 受控反证（微验证）：iframe body 被观察 → 摘帧 → 166/s → `disconnect()` → 0/s。

**修复（vendor patch ⑧，`src/vendor/foliate/paginator.js` 三处）**：
`View` 加 `#body` 字段留**实体引用**（`load()` 里 `this.#body = doc.body` 后再 observe），
`destroy()` 改成按留存引用无条件 `unobserve`；`Paginator.destroy()` 改撤 `#container` 并把
`#view?.destroy()` 写成可选调用。README 补丁表已补 ⑧ 并同步「8 处 / 重放 8 处 / 升级流程第 6 步跑新探针」。

**验证**：
- 修前 epub 单轮 **527 条** → 修后 **0 条**；时间线里出现 `unobserve body … at View.destroy`（修前从来没有）。
- 新增探针 `.AGENT/scripts/workbench-shell/probes/probe-ro-noise.mjs`（六种格式各开一次再返回）**19/19 PASS**：
  逐本断言 ①开书期间告警 0、②返回后告警 0、③**「帧已摘掉却仍被观察」的目标 0**（治本判据）+ ④六种格式都真进到 ready
  （专挡「没打开所以没告警」这类假通过）。
- **变异测试**：把构建产物里的 `View.destroy()` 改回上游那条门 → 探针当场变红 ⇒ 确实能抓这条回归，不是空跑。
  首轮（旧判据）epub 返回后 **347** 条、fb2 183 / fbz 191 / cbz 188；改用最终判据后重跑：
  逐本 **96 / 352 / 361 / 347** 条，且**残留帧观察逐本累加 1 → 2 → 3**（每开一本留一个，与实际机制一致）。
- ★ **告警条数不能当判据**（这次变异测试顺带证伪的）：同一份变异构建上，`probe-cbz-reader` /
  `probe-fb2-reader` / `probe-epub-reader` 读到的 RO 告警都是 **0 条**，而 `probe-ro-noise.mjs` 读 **341 条**
  —— 条数受卸载时机 / GC 影响，**有 bug 时也能读 0**。所以那三条探针里这一类只**报数、不断言**
  （源码注释写明会假通过），本条的回归位**只在** `probe-ro-noise.mjs`；本探针读数稳定是因为包装层的
  `live` 表对被观察节点是强引用（RO 规范本身也强引用观察目标）。
- 判据口径留档：检测写成 `el.ownerDocument !== document && !el.ownerDocument.defaultView`
  （泄漏的 body 自述 `isConnected === true`、`frameElement` 取不到 —— 只有 `defaultView` 为 null 是准的）。
- 契约位：`.AGENT/scripts/pdf-reader/verify-epub-formats.mjs` 第 **⑫** 组锁 patch ⑧（含
  **负向**「上游那条 `if (this.document) this.#observer.unobserve` 必须不在」）＋ README 计数＝8 / 升级流程 / 探针登记。

**复现与判据（留档）**：`node .AGENT/scripts/devbridge/ro-attrib.mjs install` → 按 relPath **精确指书**
（书架主网格卡片的 `title` 就是 relPath；侧栏书名是按阅读状态算出来的，第二轮起指错）→ 开书 + 返回 → 读 Δ。
⚠️ `install` 只能抓**安装之后**创建的实例，顺序必须是「先装 → 再进书 → 再退书」；日志环会折叠紧邻重复，
**读 `count` 不读行数**。

**验证**：同一序列下 `/errors` 里 ResizeObserver 项的 Δ 从 3~6 降到 **0**（页内计数同步降到个位数）；
阅读器翻页 / 进度还原 / 版式几何不变；`probe-cbz-reader.mjs` 与 `probe-epub-reader.mjs` 全绿。

## B-22 EPUB 书签在重新分页后（改字号 / 拉窗口）会重复，且旧那条从 UI 删不掉（2026-09-22，P3）

**现象**：epub/fb2/fbz 里加了书签 → 改字号或改窗口宽度（重新分页）→ 回到「同一处」再点工具栏书签按钮，
**加出第二条**而不是移除；且旧的那条**删不掉**（右栏书签行只能跳、没有删除入口；跳过去之后当前 CFI
仍与存储值不等 ⇒ 再点还是加）。

**定位**：`src/components/shared/epub/EpubReaderView.tsx` 的 `toggleBookmark`（判定 = `bkmRef.current.find(b => b.cfi === cfi)`，**全等**）；
右栏行渲染在 `src/components/workbench/ReadingSidePanel.tsx` 的 `markItems`（只有 `go`，无删除）。

**根因**：书签的定位键是 foliate 在 relocate 时给的 **range CFI**（= 当前屏可见文本范围）。**重新分页会改变同一屏的 CFI**
（起点字符与范围终点都随分页走），全等判定因此失配。「删不掉」是**第二个独立缺口**：只有阅读器工具栏能删，
且只在当前 CFI 恰好等于存储值时可删 —— 与漂移叠加后就成了孤儿条目。

**修复方向**（二选一或都做）：
1. 判「同一处」改成**起点归一化**比对（`父路径 + 第一个子路径`，即把 `epubcfi(/6/2!/4/2/4,/1:0,/1:24)` 截到 `epubcfi(/6/2!/4/2/4,/1:0)`）。
   ★ **不能只截到第一个逗号**：`epubcfi(/6/6!/4,/2[c3],/12/1:55)` 的公共父是章节容器，截到那里等于「整章都算同一处」。
2. 右栏书签行加**删除入口**（hover 出 ✕，走 `readerStatePatch({ bookmarks })`）—— 这条与 CFI 漂移无关，
   一次就把「删不掉」独立修掉（pdf 书签在 PDF 阅读器内有自己的删除，不受此影响）。

**验证**：改字号 → 同页再点书签按钮，盘上条数**不变**（而非 +1）；右栏能删任意一条；
`probe-epub-reader.mjs` 第 8.5 步仍绿，并补一条「改字号后同页再点不新增」。

**为什么现在不修**：本次（2026-09-22）拍板 **书签只做快速跳转**；实测「加 → 翻走 → 点右栏跳回」落回处
CFI 与存储值**逐字相同**（探针 note 有记录）⇒ **不换字号 / 不拉窗口时不会发生**。先落可用版本，
不为它临时发明一套 CFI 归一化口径。

---

## [x] B-23 「导出为笔记」撞上陈旧知识索引时直接 ENOENT，导出整个被打断（2026-09-22，P3；发现于 B-16 验证期）

**现象**：书里点右栏「导出为笔记」没反应，主进程日志一条
`Error occurred in handler for 'excerpt:exportNote': ENOENT: no such file or directory, open '…\.knowbase\_inbox\读书笔记 · 探针样书.fb2.md'`。
触发不需要任何非常规操作：**只要 `excerptExports.json` 里记着的页面文件已被「应用外」删掉**（同步工具挪走 / 手动清目录 / 另一个实例删 / 探针绕过应用直接删盘），
而应用还没重扫过知识库 —— 之后这本书**永远导不出来**，且页面上的提示只有一句泛泛的失败。

**定位**：`electron/lib/kbStore/knowledgeVaultRepo.ts` 的 `vaultExportExcerptsNote`（按 id 查索引 → `readFileSync` 那一段）。

**根因**：知识索引是**记忆化**的（`getKnowledgeIndex()` + 磁盘缓存 `cache/knowledge-index.json`），
而它**不校验条目所指文件是否还在盘上**（「幽灵页」的由来，`seed-probe-vault.mjs` 里有同一坑的说明）。
于是导出链路：索引说「有这篇页」→ 拼出 abs → `readFileSync` 抛 ENOENT → 异常穿出 handler。
关键点是**调用方本来就有自愈分支**（页面不存在时重建 + 回写新 id），但它的触发条件是「函数返回 `null`」——
异常绕过了这个契约，「文件没了」这种最该自愈的情形反而走了最硬的一条路。

**修复**：命中索引后加一道 `if (!existsSync(abs)) { invalidateKnowledgeIndex(); return null }`。
★ 顺序不能反：**先失效索引再返回 null** —— 否则下次读到的还是同一条幽灵条目（自愈会变成每轮都靠异常兜）。

**验证**：
- `probe-fb2-reader.mjs` 上这条是**改前红 4 条 / 改后连着两轮全绿**（自愈幂等：第二次导出不再重建新页）。
- 契约 `verify-excerpt-export.mjs` §④ 加两条负向断言锁住（`existsSync` 守卫存在 + 守卫内**先** `invalidateKnowledgeIndex()` 再 `return null`）。

**★ 顺带收掉的测试卫生问题（与产品无关，但会伪装成这条的回归）**：`probe-excerpt-export.mjs` **启动时绕过应用直接删盘**上的读书笔记页
（为了「重复跑不漂移」），而索引是记忆化的 ⇒ 它自己就会把上一轮留下的页算成幽灵页，`点导出 → 知识库页数 +1` 拿到假读数
（2026-09-22 实测：夹在别的探针后面跑 `before=13 after=11`；紧接 `seed-probe-vault.mjs` 跑则全绿）。
修法：删盘之后**用一次净零的星标往返**（`toggleKnowledgeStar` 两次，内部自带 `invalidateKnowledgeIndex()`）逼索引重建，
不新造测试专用 IPC、也不动产品代码。现在连跑两轮、且不预先 seed 也全绿。

---

## [x] B-24 pdfjs 的 `PDFViewer` 每开一次 PDF 留一个观察者（无告警，但会拴住整棵 viewer 图）（2026-09-22，P3；排查 B-21 时顺带测出；**2026-09-23 已修**：A′ 宿主侧捕获式，代码本体见 `a7d2fd9`，收尾含一处「顺序」返修）

**现象（无感）**：不用 RO 探针看不出来 —— 反复「开 PDF → 返回书架」不会产生任何告警，
只是**每开一次**会多留一个仍被观察的 `.kb-pdf-scroll` 节点（B-21 结案时探针的「良性残留」那一列恒为 1）。

**定位**：`node_modules/pdfjs-dist/web/pdf_viewer.js:6003`（`#resizeObserver = new ResizeObserver(...)`）
与 `:6021`（构造器里 `observe(this.container)`）；宿主侧
`src/components/shared/pdf/PdfReaderView.tsx:507`（`new kit.PDFViewer({...})`）+
`src/components/shared/pdf/pdfViewerKit.ts:43`（`detachViewerDocument`）。

**根因**：pdfjs 3.11 的 `PDFViewer` **没有 `destroy()`**（`grep` 全文件只有 `cleanup()` 与页级
`firstView?.destroy()`），构造器里那次 `observe(container)` **没有任何解除路径**；而 `PDFViewer`
是 React 每次挂载重建的 ⇒ 观察者被留在「卸载后已脱离文档」的容器上。
`detachViewerDocument` 的注释（「官方 viewer 没有 destroy()，`setDocument(null)` 就是卸载」）是对的，
但 `setDocument(null)` 不碰那个 RO。

**为什么不是 B-21 同类（判据别混）**：目标在**主文档**，Chromium 对「主文档里被观察的脱离节点」
**不报 loop 告警**（微验证实测 0 条/秒；只有帧被摘掉才 166/s）。所以它既不刷屏也不进日志环，
**不要**把它算进 B-21 的判据 —— 那会逼着后人去调阈值。

**为什么仍值得记**：`ResizeObserver` 的活动观察会**拴住目标**，目标又被 `PDFViewer` 引用 ⇒
每开一次 PDF 就留一整套（viewer + 容器子树）在内存里，长会话反复开 PDF 会持续涨。
量级不大（单本 PDF 一轮一份），但它是**单向累积**、无自愈。

**修复方向（择一，都要验「连开 20 次 → 良性残留恒为 0 / 内存不涨」）**：
- **A vendor patch（与 foliate 同款仪式）**：给 pdfjs 的 `PDFViewer` 补一个 `destroy()`（`#resizeObserver.disconnect()`
  + 既有 `cleanup()` 之类），在 `detachViewerDocument` 里改调它。代价：多一个 vendor 补丁表 + 升级重放。
- **B 宿主侧绕过**：不复用 React 的容器节点 —— 造一个**常驻**的容器元素（挂进一个不卸载的宿主、或应用级单例），
  每次挂载复用它 ⇒ 被观察的目标永不脱离。代价：容器尺寸/定位得自己维护，且观察者会越积越多（只是不再拴住死节点）。
  ⚠ **这条修不到根上，还会把判据弄绿**（2026-09-22 补注）：RO → 它绑定的回调 → `PDFViewer` 这条引用链
  不因「目标是否脱离」而改变（保活只认「有没有活动观察」），所以换容器**不回收任何 viewer 图**；
  它唯一的效果是让探针那列**读 0** ⇒ 变成「判据绿了、问题还在」的假通过。要复用容器请连带说明为什么还要它。
- **A′ 宿主侧捕获式（2026-09-22 补记；不需要新依赖，代价最小）★ 本条采用、已落码（见下「结案」）**：pdfjs 那份 `pdf_viewer.js` 是
  **普通 npm 依赖**（`pdfjs-dist@^3.11.174`，无 alias、无 patch 工具），所以「A」其实还隐含一个
  载具问题（要引入 `patch-package` + `postinstall`，或把 232KB 的 CJS 文件连同相对 import 一起 vendor）。
  A′ 绕开载具：那个 RO 全文件只出现三处（`:6003` 字段初始化、`:6021` 构造器 observe、`:7374` 回调），
  即**只可能建在构造期**。于是可以在 `pdfViewerKit` 里把 `globalThis.ResizeObserver` 在
  **`new PDFViewer(...)` 这一句的同步窗口内**换成捕获版，收下这次构造新建的实例，宿主侧在
  `detachViewerDocument` 里对它们 `disconnect()`。要留的注释：为什么必须「只在这一句包」、
  以及 pdfjs 升级后若把 RO 建到构造期之外，捕获会漏（判据靠探针，见下行）。
- **C 接受**：当前状态。若哪天要查内存增长，**从这条查起**。

**判据（留档）**：跑 `.AGENT/scripts/workbench-shell/probes/probe-ro-noise.mjs`，
看「良性残留」那一列 —— 现在恒为 1（首次开 PDF 之后），修好后应为 0。
★ **只有 A 能让这一列真正归零**（B 是把它涂绿），所以「连开 20 次 → 恒 0」这条验证必须连同
「`PDFViewer` 实例可回收」一起看，别只读探针的列。

### ★★ B-24 结案（2026-09-23）：A′ 已落码；收尾时抓到并修掉一处「顺序」缺陷（契约绿 ≠ 运行期验过）

**落码（A′；代码本体提交 `a7d2fd9`）**：三处源码 + 一处契约。
- `src/components/shared/pdf/pdfViewerKit.ts`：`withRoCapture(fn)`（只在 `new PDFViewer(...)` 的**同步窗口**内把
  `globalThis.ResizeObserver` 换成继承式捕获版，try/finally 还原，返回 `{ result, observers }`）；
  `detachViewerDocument(viewer, observers?)` 第二参逐个 `disconnect()`。
- `src/components/shared/pdf/PdfReaderView.tsx`：构造处用捕获版 + `viewerRoRef` 承接 + 两个 detach 点（早退 / 卸载）都传下去。
- 契约分组 ⑮（`.AGENT/scripts/pdf-reader/verify-reader-formats.mjs`，19 条含负向）。

**⚠ 收尾抓到的高价值缺陷**：`a7d2fd9` 当时**运行期无效** —— `detachViewerDocument` 把 `setDocument(null)` 写在
`disconnect` **之前**，而 pdfjs 3.11 的 `setDocument(null)` **会同步抛**（实测 `Cannot read properties of null
(reading 'destroy')`）。一次抛就把 `disconnect` 整段跳过，外层 `try/catch` 又把异常吞掉 ⇒ **每次开 PDF 仍照漏一个**、
且完全静默（这正是本条「无感」的又一次复现）。
- 更糟：**契约当时把这个错的顺序锁成了断言**（旧「负向②」要求 `setDocument` 在前）⇒「契约全绿」恰恰掩盖了运行期一直漏。
  这是本条目判据**必须跑运行期探针、不能只看源码级契约**的直接理由（同 B-21 的教训）。
- **修正**：`detachViewerDocument` 改成**先断观察者、再 `setDocument(null)`**，两者各自独立 `try/catch`
  （视图清理失败不得连累观察者断开）；契约负向②改成锁「观察者在前」，并新增「`setDocument(null)` 单独 try/catch」一条。

**运行期主判据**（`probe-ro-noise.mjs` 新增切片「连开 20 次 PDF」；治本，**不看 GC / 内存读数**）：
包装器按**实例**记「我观察过哪些元素」（`owners` 是 `Set<RO>` 而非「一个元素一条」：`observe` 里加 `this`，
`disconnect`/`unobserve` 里 `__drop(this)`，owners 空了才删 `live` 条目）。据此断言：
1. 每次开完 → 返回书架，`constructed === disconnected`（实测每轮 **2/2**：宿主 `measure` RO 一个 + pdfjs viewer RO 一个，返回后都断）；
2. `benignDetached()`（**主文档**里脱离文档却仍被观察的目标）**恒为 0**；`live` 恒 0；
3. 每次确实进到 `ready`（挡「没打开所以残留 0」的假通过）。
★ 判据只问「**那个观察还在不在**」—— 与判据 A 同风格：不看告警条数、不看 GC 时机。

**变异测试（必做；数字留档）**：把 `detachViewerDocument` 的观察者断开整段停掉（`if (false && observers)`）后重跑：
- `constructed/disconnected` 变成 **2/1**（每轮恰好漏 1）；
- 良性残留**单调累积** `2,3,4,…,21`（每次 +1）；
- 两条新断言**当场变红**。还原后即回到 `2/2`、恒 0。

**回归（2026-09-23）**：`npm run build` → 7 条相关探针（ro-noise / pdf-excerpt / excerpt-export / reading-panel / epub / fb2 / cbz）全绿；
全量契约 **41/41**；`tsc` 双端 0 错。

**探针自身的坑（省后人重走，本次都踩到）**：
- 包装器的 `disconnect()` **必须按实例清 `live`**，否则修复生效后 `benignDetached()` 仍报 1 ⇒ 判据**假红**（计划 §3.2 已预警）。
- 连开**同一本书**时，单次「返回书架」可能不生效（下一轮仍停在阅读器）⇒ 点不到卡片、表象是**隔次 `no-card`**。
  要重试「返回书架」直到书架卡片**真的出现**。判「在不在书架」只能用 `main button[title]` 里含 **`.books/` 前缀**的
  —— 阅读器自身也有一堆 `button[title]`（目录 / 缩略图 / 书签…），拿它当标志会误判。

**★ 一条通用建议（写给后续）**：RO / 监听器这一族已出现 **5 次**（B-17 / B-19 / B-20 / B-21 / B-24）。
共性 = **三方引擎的卸载契约不可信、宿主侧必须补偿**（引擎说「我 destroy 了」不等于真把观察/监听撤干净 —— pdfjs 连 `destroy()` 都没有）。
`withRoCapture` 是「**引擎卸载守卫**」这个工具的第一块。后续再遇同类（foliate / 别的三方组件），优先复用
「**宿主侧捕获 + 卸载时按实例断开**」这个形状，并在**探针里补一条「连开 N 次残留恒 0」**，而不是只补源码级契约 ——
本条的教训就是：**源码级契约会把错的顺序也锁绿，只有运行期才知道它到底有没有生效。**

---

## [x] B-25 边缘翻页的**提示层**只有右侧会亮，鼠标进左侧热区什么都不出现（2026-09-22，P2；用户实机反馈；**2026-09-23 已修**：判据换成引擎的 `atStart`/`atEnd`，固定版式走 section 序号兜底）

**现象**：epub/fb2/fbz/cbz 阅读时把鼠标移到**左侧**边缘 —— 光标确实变成手型（热区在）、点一下也确实翻上一页，
但那条提示动画（默认形态 B = 渐变 + 圆形箭头 +「上一页」）**始终不出现**；同样操作在**右侧**一切正常。

**定位**：
- 提示层点亮：`src/components/shared/epub/EpubReaderView.tsx:325` `paintEdgeHint`（`:330` 的 `canTurn` 门），
  由 `:702` `onMouseMove` 在 `:712` 调用。
- 提示层 DOM：同文件 `:1145`（`data-wb="edgeHintL"`）/ `:1150`（`data-wb="edgeHintR"`），左右各一个 div（类 `l` / `r`）。
- 样式：`src/styles/index.css:1422-1458`（`.kb-edge-hint` 基类 + `.l`/`.r` + A–D 四档；只有 `.on` 才 `opacity: 1`）。

**已排除（2026-09-22 逐处核对，四处全对称）**：① 两个 ref（`:280`/`:281`）与两处 JSX 结构逐字对称；
② CSS 的定位、渐变方向、chip 位移左右成对（`:1426-1441`）；③ 热区几何 `hostArea()`/`edgeZone()`
（`:644`/`:653`）左右同式，`want`（`:707`）与诊断钩子的 `branch`（`:675`）本来就是同一个表达式；
④ `probe-epub-reader.mjs` 第①步在 `host.left + 12` 悬停**读到了帧内手型类 `kb-et-l`**（`:302`）
⇒ 那个几何下事件到得了帧、且判成 L。

**⇒ 整条链上唯一非对称的东西是 `canTurn`**（`:330`）：
```ts
const canTurn = k === 'l' ? pctRef.current > 0 : pctRef.current < 100
```
它拿**四舍五入后的全书百分比**（`:725` `Math.round(d.fraction * 100)`）当「还有没有上一屏 / 下一屏」的判据：

- **书开头**：`Math.round` 让整本书的前 0.5% 都算 `pct === 0` —— 大书开头好几屏**翻得动却不提示**（左侧）；
  书末 0.5% 同理（右侧，同一个 bug，用户没提）。
- **`fraction` 取不到时**（`:725` 的 `Number.isFinite` 兜底写死 `0`）`pct` **恒为 0**
  ⇒ 这本书**左侧永远不提示**（右侧恒亮，因为 `0 < 100`）—— 与用户描述的形状逐字一致。
  固定版式（cbz / fb2 fixed-layout）到底给不给 `fraction` **尚未实测**，这是第一个要量的点。

**待测的分叉（先量后改）**：开阅读器后置 `window.__kbEdgeDiag = true`（排障钩子 `:659`，生产零开销），
鼠标移到左边缘，读宿主 `<html data-kb-edge>` 末条 + `[data-wb="edgeHintL"]` 的 `classList` 与 `opacity`：

| 读数 | 结论 | 改哪儿 |
|---|---|---|
| 没有新条目 | 事件没到帧（几何 / 命中 / 被别的东西盖住） | 比 `frameRect()`（`:636`）与 `hostArea()`（`:644`） |
| `branch:'L'` 但 `.on` 没挂上 | **`canTurn` 门**（本条目主嫌） | 换判据（见下） |
| `branch:'-'` 或 `'R'` | 几何算错 | `hostArea()` / `edgeZone()` |
| `.on` 挂上了但 `opacity: 0` | 样式 / 堆叠 / 被裁切 | CSS 或父容器 |

**修复方向（判据本身要换）**：「还有没有上一屏」不能拿**取整的百分比**当代理。可选口径（待用户拍板）：
① 用**未取整**的 `fraction` 加 eps；② 固定版式走 `d.section.current > 0` / `< total - 1`（`:730` 本来就在读 `d.section`）；
③ 在 relocate 时算一次「已到首屏 / 末屏」的两个布尔存 ref，mousemove 里只读布尔，不在高频路径上做判断。

**判据（回归位）**：这一层现在**零覆盖** —— `probe-epub-reader.mjs` 只断言帧内手型类（`:302`）与点击真的翻页（`:318`），
**从不读宿主侧 overlay 的 `.on`**。要补：① 悬停左边缘 → `[data-wb="edgeHintL"]` 带 `on` 且 opacity 趋 1；
② 同一次悬停右侧 → 只右边亮；③ 负向：移到正中 → 两边都不亮；④ ★ **在首屏与末屏各测一次** —— 当前判据正是错在这里。

**为什么现在不修**：修法要选口径（①/②/③ 影响面不同），且第一步是**实测分叉**，方案见
`.claude/plans/b25-edge-hint-left.md`（本机 `.claude/` 不进版本控制）。

### ★★ B-25 结案（2026-09-23）：根因 = `canTurn` 拿**取整后的百分比**冒充「有没有上一屏」

**第一步的实测分叉（按计划要求先量后改，结论与原推测**部分不符、必须记下来**）**：

- 原推测「`fraction` 取不到 ⇒ `pct` 恒 0 ⇒ **左侧永远不亮**」在四种夹具（epub / fb2 / fbz / cbz）上
  **未复现**：只要 `pct > 0`，左提示就亮；cbz 的 `fraction` 确实恒为 0（`fixed-layout.js:265`
  `#reportLocation` 写死），但应用侧的 `pct` 走的是 `progress.getProgress`，实测 **1%/2%/3%** 正常推进。
- 我反复观察到的「左侧不亮」是**探针伪影**：宿主盒两端各约 23px 的**事件投递死带**（帧收不到 mousemove，
  `probe-epub-reader.mjs:244/248` 早有记录）。它是**左右对称**的 —— 所以**解释不了**用户说的「右侧一切正常」，
  拿它当根因会修错地方。★ 后世沿用判据：**悬停坐标必须与 `frameBox()` 求交**，只按宿主盒取点会
  「通过得莫名其妙」（`leftX = max(h.left+45, b.left+20)`；cbz 是 fit-page，帧 379..891 / 宿主 307..963）。
- **真正可复现、且与用户描述形状一致的缺陷是「说谎式提示」**：书首 `atStart === true`（没有上一页）
  时左提示**照样亮**（实测 `on:true`）—— 违背代码自己的意图（原文注释：「首/末页不提示…避免
  『提示能点、点了没反应』」）。取整是元凶：`Math.round(fraction*100)` 让全书前 0.5% 都算 `pct === 0`…

**修复**：口径取 ②+③ —— **主判据用引擎原生的 `atStart`/`atEnd`**（`paginator.js:1102` 的 getter，
`#adjacentIndex(-1) == null && page <= 1`，是权威判据），**固定版式用 section 序号兜底**
（`foliate-fxl` **没有**实现这两个 getter，必须兜）。落点 `EpubReaderView.tsx`：

- `paintEdgeHint` 改为读 `viewRef.current?.renderer` 的 `atStart`/`atEnd`——
  `typeof r.atStart === 'boolean'` **这一关本身就是「要不要走兜底」的开关**；
- 兜底值 `fxlEdgeRef` 在 `onRelocate` 里**无条件**算（`cur <= 0` / `cur >= total-1`，与页码标签同源）。
  ★ **不许为了省这一步去先判「是不是固定版式」**：`verify-epub-formats.mjs` ④ 有负向断言
  `!/\.isFixedLayout\b/` —— 判据必须单点走 `isFixedLayoutBook = bookKind === 'cbz'`（工具栏要在
  `open()` 之前就渲染对）。本轮先写成 `if (viewRef.current?.isFixedLayout)` 守卫，**当轮就被这条契约逮住**
  （契约拦得对：`view.isFixedLayout` 由 `rendition.layout` 推导，`pre-paginated` 的 fbz 走 fxl 渲染器
  却过不了 `bookKind` 那道闸）；改无条件赋值后契约回绿。
- ★ 重排书**不得**拿 `fxlEdgeRef` 当判据 —— section 在一章之内不变，会把「章内第二页」误判成书首。

**判据（回归位）**：`probe-epub-reader.mjs` 新增 **§10**（10 条断言，2026-09-23）——书首 `on:false` →
翻页 `on:true` → 书末右缘 `on:false` → 回退 `on:true`；再开 cbz 验兜底分支（`FOLIATE-FXL` 且
`atStart == null`）第 1 页不亮 / 第 2 页亮。**变异测试**：把 `canTurn` 还原成 pct 版 → 2 条断言转红
（书首 + cbz 第 1 页，均为 `on:true` 的说谎式提示），证明断言有咬合力。

**验证矩阵**：`tsc`(web/node) ✓ · `npm run build` ✓ · `verify-epub-formats.mjs` ✓ ·
`probe-epub-reader.mjs`（含 §10）✓ · 同类探针 cbz / fb2 / excerpt-export / reading-panel / cbz-bigbook ✓。

**顺带测出的既有失败（与本条无关，未修、只登记）**：全量契约扫描 35/41，5 个红——
`verify-fs-watcher` / `verify-paste-external`（harness 自身 `ReferenceError: editorIdx is not defined`）、
`verify-resizable-panel`（`onHandleClickRef is not defined`）、`verify-input-bubble`（17 条）、
`verify-slash-commands`。**归因依据**：这 5 个脚本读的源文件（`ai-teaching/*`、`AssistantPanel/*`、
`chatCommands.ts`、`fsWatcher.ts`、`ResizablePanel.tsx` …）**本次工作树一处未改**，不读 `epub/*`。

---

## [x] B-26 阅读器勾画后点「问 AI」弹出的是**悬浮 AI 侧栏**，不是工作台右栏的原生 AI 助手（2026-09-22，P2；用户实机反馈；**2026-09-23 已修**：右栏 AI 态登记为划词宿主 · 路线 1）

**现象**：在阅读器（epub / txt）里勾画 / 划选后点浮条的「问 AI」，从屏幕右侧滑出**悬浮 AI 侧栏**（浮层，盖在阅读区上），
而用户期望的是**工作台右栏那个原生 AI 助手**（即 Ctrl+J 唤出的同一处）。

**定位**：浮条派发 `ai-assistant:selection-action`（epub：`src/components/shared/epub/EpubReaderView.tsx:1047`；
txt：`src/components/shared/txt/TxtReaderView.tsx:668`）→
`src/components/shared/AssistantPanel/index.tsx:274` 收 → `:244` `askSelection`：
先问 `getSelectionAskHost()`（`:248` → `src/lib/assistantContext.ts:48`），**取不到**就
`setSelQuotes(...)` + `openPanel()`（`:261`）= **悬浮侧栏**。
而 `registerSelectionAskHost` 目前**只有 AI 教学注册**（`src/modules/ai-teaching/index.tsx:708`，
且它的 `accept()` 要求「本模块激活 + 已有当前对话」）⇒ 在阅读器里必然走回退分支。

**根因（是缺口不是回归）**：划词问答只有两个出口 ——「AI 教学就地接管」与「全局悬浮侧栏」，
**工作台右栏 AI Tab 从来没被登记成候选宿主**。而它是这三处里最贴「边读边问」的那个：右栏 AI 态本来就是
`ChatBody docked` + `useAssistantChat`（`WorkbenchRightPanel.tsx:128`），与悬浮侧栏**共用同一个会话真源**
（在主进程），只是另一张皮 —— 所以「另开一个对话」这个担心不成立，问题纯粹是**落点选错**。

**修复方向**（推荐 1；2/3 备选，待用户拍板 —— 见 `.claude/plans/b26-reader-ask-ai-routing.md` §三）：
1. **在工作台右栏登记一个 `SelectionAskHost`**：`WorkbenchRightPanel` 在 `reading !== null`（有书在读）时注册，
   `accept: () => 右栏 AI Tab 可用`（未被 `panelTabsHidden` 藏掉），
   `ask: (text) => 展开右栏 + patch({ rightTab: 'ai' }) + 把选段交给右栏对话的输入区`。
   **零新机制**（复用既有注册表 + 既有 `rightTab` 持久化 + `aiChat.setInput`/`inputRef`），
   且 `accept()` false 时**回退分支原样保留**。
2. 把「引用胶囊」下沉进 `ChatBody`（现在只在 `AssistantPanel/index.tsx:368` 的 JSX 里，右栏 docked 版没有）
   ⇒ 三处宿主一致地「以引用形式带上选段」。★ 代价：`verify-perception.mjs` 的 H3b / J18c2 是**按该 JSX 所在文件**
   断言的，要同步改 —— 属「先说清再动」的一档。
3. 最小改动：只切 Tab + 聚焦输入框，选段**直接填进输入框**（不自动发送）。不动 `ChatBody`、不动契约，
   但与悬浮侧栏的「引用胶囊」体验不一致。

★ 无论走哪条，**`accept()` 为 false 时必须能落回悬浮侧栏**（右栏 AI Tab 被 ⋯ 藏掉 / 无书在读 / 右栏不渲染的场景）。
★ 另有一处**已存在**的第三种行为要一并想清楚：PDF 的 `TextSelectionBar.tsx:22` 把「问 AI」做成了
**跳 AI 教学模块**，与 epub/txt 走事件桥是两条路 —— 三处口径是否统一，本轮不擅自改。

**判据（回归位）**：`probe-b8-ai-shortcuts.mjs` 的 P6 已覆盖「工作台 Ctrl+J → 右栏 AI」，但它不碰划词。要补
（放 `probe-epub-reader.mjs` 或新小探针）：阅读器里划选 → 点浮条「问 AI」→ ① 悬浮侧栏锚点
`#assistant-panel-root`（`AssistantPanel/index.tsx:441`）**不得出现**；② 右栏切到 `[data-wb-rp-tab="ai"]` 且可见；
③ 选段确实进了右栏对话的输入/引用区；④ 负向：右栏 AI Tab 被藏掉时仍回退到悬浮侧栏（**不许静默无反应**）。

**为什么现在不修**：三条路线体验差别明显（多一个决策点），且路线 2 会牵动既有契约，方案见
`.claude/plans/b26-reader-ask-ai-routing.md`。

### ★★ B-26 结案（2026-09-23）：路线 1 —— 右栏 AI 态登记为划词宿主，选段填进输入框

**用户拍板（2026-09-22 会话）**：路线 **1**（右栏登记宿主，不把引用胶囊下沉进 `ChatBody` —— 那是路线 2，
单独一项做）；`aiChatOpen`（右栏对话被 ⤢ 扩成中间标签，右栏原位变 token 面板）时**放手回退悬浮侧栏**
（「点击必须始终有反应」优先于「一律进右栏」）。

**落码要点（三处，按改动顺序）**：

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/lib/assistantContext.ts` | **注册表由单槽改为栈**（栈顶接管；注销弹出自己、露出下一个）—— 见下「为什么必须栈化」 |
| 2 | `src/App.tsx` | 注册宿主（`rightAskRef` + deps 为空的注册 effect）；`pendingRightAsk` state 转交选段；抽出 `rightReading` 单一口径供「阅读 Tab」与「划词路由」共用 |
| 3 | `src/components/workbench/WorkbenchRightPanel.tsx` | 消费 `pendingAsk`（挂载后 `setInput` + 聚焦）；**自身不再注册** |

**★ 为什么宿主注册在 App 而不是右栏组件里（本轮最大的一处修正）**：右栏**折叠时 `WorkbenchRightPanel`
整体卸载** —— `ResizablePanel` 只渲染 `visible` 的子节点（`{visible && children}`），而 `rightCollapsed`
默认就是 `true`。第一版把注册写在组件里，探针当场照出「右栏折叠 ⇒ 宿主不在栈里 ⇒ 照旧弹悬浮侧栏」，
**即默认状态下这条修复完全无效**。故宿主上移到常驻的 App，选段经 state 投递给挂载后的右栏消费
（与既有 `pendingAsk`（PDF→AI 教学）同一手法，不新造机制）。
> 顺带记一笔既有事实（**不在本条范围**）：右栏组件里「实例常驻、输入草稿不丢」的注释与
> `{visible && children}` 的实际行为不符 —— 折叠/整窗都会卸载，草稿随之丢失。本轮不改渲染语义，
> 只把注释里的判断按实际写清。

**★ 为什么必须把注册表栈化**：单槽版（`askHost = h`，注销时 `askHost === h ? null : 略`）在
「常驻宿主被临时宿主顶掉」时会**永久失联** —— 阅读器开着（App 宿主常驻）时去 AI 教学划词一次，
教学宿主入栈；离开教学时它把槽置 null，而 App 宿主**不会自己回到槽里** ⇒ 此后在阅读器里划词
一律回退悬浮侧栏。表象是「时灵时不灵、且与操作顺序有关」。栈化后这对组合**顺序无关**：
教学激活即接管（§三 5「教学的地盘不被抢」由**栈顶优先**保证，教学侧 `accept` 未改动），离开即还给右栏。

**回退矩阵（`accept()` 四条，全在 App；false ⇒ 原样回退悬浮侧栏，不许静默无反应）**：

| 场景 | 判据 | 实测 |
|---|---|---|
| 无书在读 / 书已关 | `!!rightReading` | 未覆盖（构造上：划词只可能发生在阅读器可见时） |
| 右栏 AI Tab 被 ⋯ 菜单藏掉 | `!panelTabsHidden.includes('ai')` | ★ 探针负向断言实测**回退到悬浮侧栏** |
| 对话已扩成 aiChat 中间标签 | `activeTab !== 'aiChat'` | 未覆盖（同上，不可达） |
| 整窗模块（左右栏退场） | `!fullWindowTab` | 未覆盖（同上，不可达） |
| 右栏折叠 | **不挡**（`ask()` 顺手 `rightCollapsed: false` 拉开） | ★ 探针实测：折叠 → 点「问 AI」→ 宽度 6px → 299px |

**判据（回归位）**：新探针 `.AGENT/scripts/workbench-shell/probes/probe-b26-ask-ai-routing.mjs`，12 条断言 ——
夹具自证起始态（右栏折回折叠 + AI Tab 可见，★ 两者都是**持久化设置**，前一版探针跑挂后把它们留成
脏状态，导致下一轮「所有断言都在另一个前提下跑」，已加收敛步骤 + 收尾复位）→ 划选 → 点浮条「问 AI」→
① `#assistant-panel-root` **不得出现**；② 右栏 `[data-wb-rp-tab="ai"]` 激活且宽度 > 60（从折叠被拉开）；
③ 选段进了 docked 输入框（不自动发送）；④ 主进程会话集合逐字不变（「没另开对话」）；
⑤ 负向：藏掉 AI Tab 后再点 ⇒ 悬浮侧栏**出现**；⑥ 勾回后再点 ⇒ 又落回右栏（回退是双向的）。

**变异测试（当场变红）**：把 App 宿主的 `accept()` 恒置 `false`（= 修复前行为）→ **6 条转红**
（① 悬浮侧栏出现 / ② Tab 未激活 + 宽度 −1（组件未挂载）/ ③ 输入框空 / ⑤⑥ 两条级联），
而**回退类断言保持绿**（本该如此：全都回退 = 回退语义没坏）。还原后 12 条全绿。

**★ 全量契约扫出的连带一处（已修 · 属「期望过期」不是回归）**：`verify-epub-formats` ⑩(6) 是**文本
形状锁**（`/reading=\{[^}]*kind !== 'cbz'/`），锁的是「调用点内联」这一形态。`rightReading` 抽出来
（第 2 处改动，为了让「阅读 Tab」与「划词路由」共用同一份「有书在读」口径）后它当场转红 —— 但
cbz 排除的**执行语义原样保留**（派生值对 cbz 仍为 `null`），且该断言读的是 `App.tsx` 文本、
不含任何运行时行为，故判为期望过期。已改为**两处同锁**：派生处有 cbz 守卫 **且** 调用点确实
`reading={rightReading}`；并做变异验证 —— ①去掉 cbz 守卫 ②调用点改回内联，**两种变异都转红**。

**验证矩阵**：`tsc`(web/node) ✓ · `npm run build` ✓ · 新探针 12/12 ✓ · 变异测试 6 红 ✓ ·
全量契约 **36/41**（5 条既有红：`verify-input-bubble` / `verify-slash-commands` / `verify-fs-watcher` /
`verify-paste-external` / `verify-resizable-panel` —— 已逐个确认**都不读本轮改过的四个文件**，属主干既有红）·
`probe-ro-noise.mjs` ✓（探针里反复折叠/展开右栏会打出几条主文档 `ResizeObserver loop` 告警 ——
属 B-21 已定性为**良性、只报数**的那一类（主文档、非 foliate 帧）；对照：不做折叠舞蹈的
`probe-epub-reader.mjs` 同样运行 0 条，故为探针自身的布局抖动）。

**明确不做（不擅自扩大范围）**：① 引用胶囊下沉进 `ChatBody`（路线 2，会牵动 `verify-perception`
的 H3b / J18c2）；② 统一 PDF `TextSelectionBar` 那条「跳 AI 教学」的第三口径；
③ 右栏组件的挂载语义（折叠即卸载）—— 只改注释口径，不改渲染。

**已知简化**：选段是**追加**到输入框（已有草稿接在后面，不覆盖），没有悬浮侧栏的「N 条对话引用」
胶囊与 5 条上限 —— 那是路线 2 的事。`ExcerptCaptureBar` 的「问 AI」tooltip 仍写着「收进侧栏引用
胶囊」，在阅读器场景下已不准确，属文案口径统一，未在本轮改。

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
