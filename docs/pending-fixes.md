# 待修问题归集（滚动累积）

> 用途：开发负责人叙述的 bug 先在此逐条登记（现象 + 定位 + 根因 + 修复方向），攒齐后统一开修。
> 修完把对应条目标 `[x]` 并注明修复提交；确认闭环的条目可整段删除。
> 条目编号 `B-n` 全局递增，不复用。

---

## B-1 右栏下段「⋯ 显示的小控件」菜单弹出位置错位（2026-09-21，P2）

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

## B-2 笔记左栏文件树右键菜单没有「删除」（2026-09-21，P1）

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

## B-3 元信息卡「在编辑器中打开」点击无反应（2026-09-21，P1）

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

## B-4 左栏「大纲」按钮恒不可用（根因：md 知识页 fileType 为空串，连带 3 处按钮静默失效）（2026-09-21，P1）

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

## B-5 「AI 续写建议」感觉不可用（三重死锁：自动暂停 / 总闸不回血 / 全程无反馈）（2026-09-21，P1）

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

## B-6 【需求】AI 建议按钮的状态用颜色 + 闪烁区分（四态配色）（2026-09-21 细化，P2）

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

## B-7 【需求】笔记区左栏头部那排按钮加一个「+」（新建页面 / 目录）（2026-09-21，P2，待拍板）

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

## B-8 AI 教学区按 Ctrl+J 会唤出「AI 助手」（规格违背；且只禁一半）（2026-09-21，P1）

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

## B-9 【需求】全局统一「插件」图标：拼图（Puzzle）→ 箱子（左栏那个）（2026-09-21，P2）

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

## B-11 PDF 阅读器「边缘被勾画的痕迹」（疑为滚动容器的聚焦虚框）（2026-09-21，P2）

**现象**：PDF 阅读器里（截图用的是探针样书 *Phrontis Reader Sample*，12 页）选中/点击后，页面**左边缘外侧**出现一条**竖直虚线**贯穿整页；用户疑问：「怎么边缘还是有被勾画的痕迹，不是已经改成了现有的一些工具了吗」。

**先回答那个疑问**：**是，已经换成官方 pdf.js viewer 了**（2026-09-21 迁移，覆盖层就是 `components/shared/pdf/pdfViewerTheme.css`）。而这条虚线**大概率不是自研时代的残留** —— 它作用在**我们自己那层滚动容器**上，换不换 viewer 都会在（见下）。

**主推定位（A）：滚动容器的聚焦虚框（focus ring）**
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

**修复方向**：
- **A 主修**：给滚动宿主做焦点样式收口 —— 用 `:focus { outline: none }` **或更稳妥的 `:focus-visible` 保留键盘焦点可见性**（别一律 `outline-none` 把键盘用户的焦点提示也删了，那是可达性回退）。建议在 `index.css` 里给"滚动宿主"统一一条（如 `.kb-scroll-host:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px }`），而不是在 PDF 里就地写一次性样式（铁律 13 的口径）。
- **B 复核后决定**：若确认是 hit-pad 溢出，则两条路 —— ① 选区绘制改用 `::selection` 之外的方式（自绘 overlay）；② 或接受（毕竟 pad 是为了消灭更严重的误选，取舍要权衡）。改前先实测，别凭注释断言。
- ★ **全局排查（顺带价值）**：这是"**点击滚动区空白处就冒虚框**"的通用问题，不只 PDF —— `grep -rn "overflow-y-auto\|overflow-auto" src` 找出所有滚动宿主，逐个确认。用户在其它模块（笔记区、侧栏列表、设置页）大概率也会碰到。

**验证**：① 在 PDF 里不选任何文字、只点空白 → 左缘虚线**不再出现**；② 键盘 Tab 进入该区域时仍**有可见焦点提示**（确认没有把可达性一起删掉）；③ 拖选文字的蓝色块边缘与文字的关系符合预期；④ 其它滚动宿主抽查一遍。

**待确认（本轮只记录，未实机复现）**：我判定为"虚线"是依据截图；若实机看到的是**实线**，则改从官方 focus-ring 变量那条线排查（`pdf_viewer.css:1537/1656` 的 `--focus-ring-outline`）。

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
