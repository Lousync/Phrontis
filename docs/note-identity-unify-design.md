# 身份统一与归档退役方案（v3.4.0 后续）

> 拍板依据（2026-09-20 开发负责人）：**① 无 id 文件在首次保存时自动补 id；② 归档不留**（界面上已无归档相关入口）。
> 对照模型：Obsidian —— 文件即笔记，标记是内容、过滤是视图，归档用目录表达。

## 0. 目标模型（三层）

| 层 | 内容 | 规则 |
|---|---|---|
| **文件层** | 仓库内每个文件 | 都是条目。`.md` 有 id 用 id、无 id 用 `auto:<relPath>` 兜底；非 md 直接收录（元信息卡）。`id` 继续在幕后承担附件路径 / 检索主键 / 改名不断链，**不删、不暴露** |
| **标记层** | frontmatter 字段（tags / starred / …） | 只是内容，不代表特权状态。**`status` 退役**：不再影响能否进库、不再参与过滤 |
| **视图层** | 列表 / 图谱 / 搜索 / 桌面统计 | 默认全显示；要「只看某类」由视图开关或 `.ignore`（排除清单）表达 |

**归档的替代**：想隐藏 = 写进 `.ignore`（已有能力）；想分层 = 挪进目录（目录即分类，已有能力）。不再有「归档清单 / status 双态」。

---

## 1. 阶段一 · 身份统一（无 id 也能进库 + 首次保存自动补 id）

### 行为变化
- 无 `frontmatter.id` 的 `.md` **不再被索引跳过**，以 `auto:<relPath>` 作为临时身份进库（可搜索、进图谱、可被 `[[引用]]`）。
- 该文件**首次被编辑保存**时，静默写入真 UUID（换成 `id: <uuid>`），身份从 `auto:` 升级为稳定 id —— 用户零操作。
- 「转为正式笔记」入口撤销（`draft:` 伪页签保留为「文件页」容器 id 形态，仅内部标识，不再表示"未转正"）。

### 改动点
| 文件 | 改动 |
|---|---|
| `electron/lib/kbStore/knowledgeIndex.ts:550-563` | 删除 `findCoveringDirEntry` 前提，任何无 id 的 md 一律 `auto:<rel>` + 补 title/fileType（现有 552-560 的特例**提升为通例**） |
| `electron/lib/kbStore/knowledgeIndex.ts:629-633` | 删掉「缺少 frontmatter.id 已跳过」分支（不再有跳过路径） |
| `electron/lib/kbStore/knowledgeIndex.ts:654` | `status` 计算退役（阶段二统一） |
| 保存写路径（**渲染层**，2026-09-20 落地时修正） | 新增「首次保存补 id」：`ensureFrontmatterId` 接在 PageEditor `doSave` 的 vault 分支、写盘之前；注入后**回写 `vaultPrefixRef`**。<br>⚠️ 为什么不在主进程收口：PageEditor 内存持有 frontmatter 前缀，主进程改写会让内存前缀缺 id → 下一次保存又写掉 → 身份来回丢。仅 `.md` 参与（非 md 是文件卡片，注入 frontmatter 会破坏内容）。共享纯函数在 `src/lib/frontmatter.ts`（零依赖、契约可 import）。 |
| `src/modules/knowledge/components/PageEditor.tsx:226-256, 972-978` | 撤掉「转为正式笔记」菜单项与 `handleConvertDraft`（能力由主进程自动接棒）；`draftRelPath` 装载逻辑保留（用于「文件页」编辑） |
| `.AGENT/scripts/notes-merge/verify-notes-inline-edit.mjs:117-129` | 断言改写：从「草稿直入编辑 + 转正入口」改为「文件页直入编辑 + 无转正入口（负向断言）」 |

### 验收
- 契约：新增断言「无 id 的 md 进索引且 id 前缀为 `auto:`」→ 用 seed fixture 断言真实索引产物；
- 契约：负向断言「PageEditor 源码不得再出现 转为正式笔记 / handleConvertDraft」；
- 探针：`probe-caret-sync.mjs` 走一遍 fixture（无 id 的 README.md）→ 编辑保存后**文件内出现 `id:`**，页签 id 由 `draft:` 迁移为真 id（不闪断）。

---

## 2. 阶段二 · `status` 退役

### 行为变化
- 删除知识页索引条目的 `status` 字段（**故意删字段而不是留恒 published**：让 tsc 把全部消费方报出来，逐个改为"不过滤" —— 与「清单漂移」防线同源）。
- 列表不再因 `status: draft` 隐藏；图谱节点不再虚化；正文 `[[引用]]` 不再虚化；桌面统计/语义检索不再排除。

### 改动点（tsc 会全部报出来，预计 10 处）
| 文件 | 改动 |
|---|---|
| `src/types/index.ts:453-454` | 删 `KnowledgePage.status`（含 `KnowledgePageIndexEntry` 同名位） |
| `electron/lib/kbStore/knowledgeVaultRepo.ts`、`graphIndex.ts`、`semanticIndex.ts`、`knowledgeSearch.ts`、`builtinTools.ts`、`pluginRegistry.ts` | 去掉 status 过滤/透传 |
| `src/modules/knowledge/index.tsx:1503-1537, 1610` | `draftWikiTitles` 全链路（data → MarkdownPreview prop）删除 |
| `src/components/shared/MarkdownPreview.tsx:56-57, 136, 282-290` | `draftWikiTitles` prop 删除 |
| `src/modules/knowledge/components/graph/*.tsx` | 虚化样式分支删除 |
| `src/modules/desktop/tiles.tsx:249, 548`、`useDesktopData.ts:205` | 统计/最近不再过滤 draft |
| 存量数据 | 一次性迁移：仓库内 `status: draft` 行**原地删除该行**（保留其余 frontmatter），写进 `.knowbot`?→ 走既有「刷新全量」路径静默完成；失败只记 warning，不阻断 |

### 验收
- `verify-workbench-shell` / `verify-perception` 全绿；
- 负向断言：源码不得再出现 `status === 'draft'` / `draftWikiTitles`；
- 探针：夹具仓库放一个 `status: draft` 页 → 列表可见、引用不虚化。

---

## 3. 阶段三 · 归档整条拔线

### 行为变化
- 删除「归档 / 取消归档」全部能力（右键菜单、IPC、清单、prune）。
- **非 md 文件改为直接收录**（不再需要「清单归档」才进库）：PDF / 图片 / html / 其他类型都以元信息卡出现在列表（此前只有归档过的才出现）。
- html 渲染口径变化：归档 html 走沙箱 iframe 的通道一并消失 → 除仓库根 `欢迎.html` 外，其余 html 一律元信息卡（**待确认项，见 §5**）。
- 编辑器模块：其文件树的「归档/草稿」右键与 `archivedPaths/draftRelPaths` 隐藏逻辑一并删除；模块本身去留见 §5。

### 改动点
| 文件 | 改动 |
|---|---|
| `electron/lib/kbStore/archivedFilesRepo.ts` | 整文件删除（含 manifest 读写、`findCoveringDirEntry`、`isArchivedByManifest`、`gcArchiveEntries`、`add/remove/renameArchiveEntry`） |
| `electron/lib/workspaceManager.ts:13, 593-…, 951-…` | 删归档 handler（`ws:setArchiveStatus` / `ws:setMdStatus` 归档分支）与所有 `*ArchiveEntry*` 调用；`ws:refreshVault` 的 prune 移除 |
| `electron/preload/index.ts:622` + `src/types/index.ts:1529-1531` | 删桥接与类型 |
| `electron/lib/fsWatcher.ts:6` | `gcArchiveEntries` 调用删除 |
| `electron/lib/kbVisualProtocol.ts:4, 103` | `isArchivedByManifest` 白名单③ 改为「仓库内任意 html」（保留 vault 内校验 / 2MB 上限 / CSP 锁死外联 / sandbox 无 same-origin）；三处白名单同步（见 `docs/knowledge-index-design.md`） |
| `electron/lib/kbStore/knowledgeVaultRepo.ts:58-62` | `isHtmlLike`（html 不走 frontmatter 注入 / 改名保护）复核：html 现在全量进库，需确认改名与 frontmatter 注入仍对其豁免 |
| `electron/lib/kbStore/knowledgeIndex.ts:8, 553, 565, 640` | 非 md **无条件收录**（不再查清单）；`coveredByDir` 概念删除 |
| `src/modules/editor/index.tsx:171-179, 692-733, 1058-1115, 1953-…` | 删 `archivedPaths` / `archivedDirPaths` / `draftRelPaths` / 「编辑即转草稿」/ 右键归档菜单 |
| `src/components/shared/VaultTree.tsx:40-43, 157-158, 222` | 删 `archivedPaths` / `draftRelPaths` props 与隐藏分支（草稿徽标已在 2026-09-19 退役） |
| `src/modules/knowledge/components/PageEditor.tsx` | `isArchiveFile` / `entryKind === 'file'` 语义改名（`archive` → `fileCard`），去掉「清单覆盖」推断 |
| `src/modules/knowledge/index.tsx` | 归档相关文案/分支清理（`isArchiveFile` 改名 `isFileCard`）|
| `.AGENT/scripts/editor/verify-fs-watcher.mjs:72-74, 121-228` | 归档 prune 断言删除（改为「刷新不再触碰归档清单」负向断言） |
| `.AGENT/scripts/demo-seed/seed-quiz.mjs:88` | `归档/` 目录 skip 规则删除 |
| 存量数据 | `.knowbase/` 下的归档清单文件**停止读取**；不主动删（留给用户手动清理），刷新一次索引即完成迁移 |

### 验收
- 全仓 `grep -r "归档\|archive" src electron` 仅剩数据目录兼容注释；
- 契约：`verify-workbench-shell` / `verify-fs-watcher`（改后）/ `verify-notes-inline-edit` 全绿；
- 探针：夹具仓库放一个 PDF + 一个 html → 列表出现两张元信息卡（无需任何归档动作）。

---

## 4. 明确不做
- ❌ 不删 `id`（附件路径 / 检索主键 / 改名锚都依赖它）；
- ❌ 不做「改名 → 全库改写 `[[旧标题]]`」（保留 id 换来的收益，不做 Obsidian 那条路径）；
- ❌ 不动 `.ignore` 排除清单与分类目录机制（它们就是我们的「视图层」）。

## 5. 已确认决策（2026-09-20 开发负责人拍板）
1. **非 md 全部收录**：不加扩展名白名单，仓库内非 md 文件一律以元信息卡进列表（PDF / 图片 / html / 其它）。
2. **仓库内 html 全部走沙箱渲染**：kbview 白名单③ 从「归档清单内的 html」改为「仓库内任意 `.html`」，保留既有安全边界（vault 内路径校验、2MB 上限、CSP 锁死外联、`sandbox="allow-scripts"` 无 same-origin）。
3. **编辑器模块物理删除**（它已合并进笔记区）；桌面模块本身后续会整体删除，本次只摘掉 `appModules` 里的 editor 条目（连带其磁贴），不为桌面做额外适配。

## 6. 分批与风险
- 三阶段各自独立可交付、可回滚；建议按 1 → 2 → 3 顺序（阶段一不改行为面，风险最低）。
- 每阶段结束跑：`tsc` + `verify-workbench-shell` + `verify-perception` + `verify-notes-inline-edit` + 相关探针，并单独 commit。
- 最大风险在阶段三的**非 md 直接收录**：列表可能瞬间变长（仓库里的杂项文件都进来）。缓解 = §5.1 的白名单（待定）。

---

## 7. 阶段四 · 编辑器模块物理删除（2026-09-20 追加）

### 为什么现在能删
- 能力已分流：正文编辑 → 笔记区 `PageEditor` + 共享 `MonacoPane`；文件树 → 共享 `VaultTree`；PDF 阅读 → 笔记区内嵌 `PdfReaderView`；页面条页签组 → `PageTabStrip`（App 托管）。
- **依赖面很窄**：全仓只有 `src/App.tsx` 一处 `from './modules/editor'`（模块入口），其余文件都在模块内部互相引用。

### 连带影响（必须先知道）
| 项 | 影响 | 处置 |
|---|---|---|
| **禅模式（Ctrl+K Z）** | `zenLevel` 是 **App 级**状态，除编辑器外 `AiTeachingModule` 也在用（`App.tsx:1112`）→ 删除编辑器模块**不会**丢掉全局禅模式；丢掉的是「编辑器内 Monaco 的禅参数接线」（淡化/打字机/大留白） | 保留 App 级禅模式；若以后想在笔记区编辑态复用，把 `MonacoPane` 的 zen 参数从 `PageEditor` 传即可（共享层已支持，零改动） |
| 编辑器「文件页签组」 | 页面条 owner='editor' 的分支、`openTabs` 里的 editor、`PAGE_OWNED` 成员 | 一并清除（`WorkbenchPageBar` / `PageTabStrip` / App 的 editor case） |
| 共享文件误伤 | `src/modules/editor/tabPolicy.ts` 等被笔记区引用的文件 | 删除前确认全部改用共享层 `src/lib/tabPolicy.ts`（落地检查清单：`App.tsx`、`knowledge/*`、`PageEditor.tsx`） |
| 契约与探针 | `.AGENT/scripts/editor/*`（verify-tab-preview、verify-fs-watcher、verify-zen? 等）全部针对编辑器模块 | 逐条判定：仍适用的改写为针对笔记区（如 fs-watcher），纯编辑器专属的随模块退役并删除脚本 |
| 桌面磁贴 | `appModules.ts:46` 的 editor 条目 | 摘掉该条目（tile 随之消失）；桌面模块整体删除留待后续专项 |

### 改动点
| 文件 | 改动 |
|---|---|
| `src/modules/editor/**` | 整目录删除（先 `os.rename` 移入 `E:\_备份_可删除\`，不硬删） |
| `src/App.tsx:50, 1099` | 删 import 与 `case 'editor'` |
| `src/lib/appModules.ts:44-46` | 删 editor 条目（含注释里的「退出活动栏」说明）与 `TabName` 成员？——**保留 TabName 成员会残留死枚举；删除它会让 App/页面条的 editor 分支一起报错**，正是我们要的（逐个清） |
| `src/types/index.ts` | `TabName` 去掉 `'editor'`（同上，让 tsc 暴露全部残留） |
| `.AGENT/scripts/**` | 编辑器专属契约脚本退役；跨模块脚本改指笔记区 |
| `docs/*` | 记录本次退役（`DESIGN-ARCHIVE.md` 索引） |

### 7.1 删除门禁（开工前必须逐条过，2026-09-20 盘点实测）

模块内其实只有 **5 个文件**：`index.tsx`(120KB，真正的实现) + `components/FileTree.tsx`(re-export shim) + `components/MonacoPane.tsx`(re-export shim) + `tabPolicy.ts`(re-export shim) + `types.ts`(4KB，部分类型已上移到 `src/lib/frontmatter.ts`)。

**⚠️ 全仓真依赖只有一条，且不在笔记区——删错就废掉 AI 教学：**

| # | 门禁项 | 现状（2026-09-20 实测） | 动作 |
|---|---|---|---|
| 1 | **跨模块真依赖清零** | `src/modules/ai-teaching/AiTeachFileTree.tsx:9` → `import { FileTree } from '../editor/components/FileTree'`（AI 教学的文件树走编辑器 shim） | 先改成直引共享层 `src/components/shared/VaultTree`，跑 AI 教学探针，再动删除 |
| 2 | 模块入口渲染 | `src/App.tsx:50` 是唯一 `from './modules/editor'` | 删 import + `case 'editor'` |
| 3 | 三个 shim 先摘 | `FileTree` / `MonacoPane` / `tabPolicy` 都是 re-export shim（真源已在共享层） | 先删 shim → 跑 `tsc`；还有报错说明有路径未改完（这正是 shim 的价值，别反过来先删本体） |
| 4 | **能力对照清单** | 120KB 的 `index.tsx` 内功能点未逐条核对 | 开工第一件事：把 index.tsx 的功能点列成表（文件树操作 / 多文档页签 / 预览分栏 / zen 参数 / 粘贴插图 / 快捷键…）→ 标注「已由笔记区或共享层覆盖 / 需移植 / 放弃」，**清单经确认后才删本体** |
| 5 | 契约与探针先改后删 | 6 个脚本读编辑器源码：`verify-perception.mjs:561`、`verify-fs-watcher.mjs:56`、`verify-paste-external.mjs:55`、`verify-tab-preview.mjs:34-35`、`verify-notes-inline-edit.mjs:40/74/96/104`、`verify-workbench-shell.mjs:111` | 逐条改指笔记区；纯编辑器专属（verify-tab-preview 的页签冻结基线）随模块退役并归档脚本 |
| 6 | 注释引用清理 | 7 处注释仍指 `editor/index.tsx`（TitleBar / VaultTree / PageEditor / workspaceManager / prepPolicy / profilePatch / frontmatter） | 顺手更新为笔记区或共享层的真实位置（避免下一个人按注释找错地方） |
| 7 | 删除方式 | — | `os.rename` 整目录移入 `E:\_备份_可删除\editor-module-<日期>\`（不硬删）；笔记区全链路探针复跑全绿后，再由你决定是否物理清除 |

**结论**：删除不是「一行 import 的事」，但也确实可控——先拆一条真依赖（AI 教学文件树）+ 过一遍能力对照清单，才是安全顺序。

### 7.2 验收
- `grep -rn "modules/editor" src` 零命中（含注释）；
- `tsc` 0 错（验证没有悬空引用）；
- 笔记区全链路探针复跑：`probe-pagebar` / `probe-caret-sync` / `probe-batch5-ai` 全绿；
- AI 教学回归：文件树由共享层直供后，`verify-perception` 与 AI 教学相关探针全绿；
- 契约：`verify-workbench-shell`（editor 相关断言改写）、`verify-notes-inline-edit` 全绿。


