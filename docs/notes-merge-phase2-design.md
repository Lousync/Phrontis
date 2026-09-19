# 笔记模块合并 Phase 2 技术方案：文件树为主（B 方案），知识库 + 编辑区合一

> 前置：Phase 1 已落地（就地编辑 + 共享 MonacoPane/frontmatter/tabPolicy，HEAD=c5ed7c2）。
> 开发负责人已看原型拍板 **B 方案（Obsidian 式文件树）**：目录即真相，笔记本/分类降级为属性筛选器。
> 原型：`.workbuddy/prototypes/notes-merge-phase2.html`（树对比 + 草稿直入编辑 + 附件走阅读器 + 编辑区退役示意）。

## 0. 目标形态

- 工作台标签条：**笔记 / 日程 / 书架 / 博客 / 错题本**，编辑区退役（入口移除，能力并入「笔记」）。
- 「笔记」模块左栏 = **vault 文件树**（目录/文件与磁盘一一对应，含无 id 草稿与附件，弱标识区分）；顶部一条**笔记本/分类筛选器**（结构从树的骨架降级为属性过滤）。
- 中栏 = 页签栈（Phase 1 已有：读/写就地切换、页签固定、草稿点击直接进编辑态）。
- 不变量全部保留：Monaco 唯一写入方（共享宿主）、写路径唯一（`workspaceWriteFile` + mtime 基线）、保活两约束（单一父节点 + 顺序恒定）。

## 1. 已核实的事实（写码前必读）

| 事实 | 位置 |
|---|---|
| editor 的 FileTree 342 行、目录懒加载缓存 DirCache | `src/modules/editor/components/FileTree.tsx` + `editor/types.ts` |
| 知识库左栏三件套 NotebookList(1166)/CategoryTree(194)/ChapterPanel(606) 为逻辑结构骨架 | `src/modules/knowledge/components/` |
| 页签判定已共享（previewReplacement/landingAfterClose） | `src/lib/tabPolicy.ts` |
| MonacoPane 共享宿主（PaneDoc/modelPath） | `src/components/shared/MonacoPane.tsx` |
| `kb-open-in-editor` 消费方十余处（快速切换器/AI 引用/书架/博客/桌面磁贴/aiTeaching/knowledge PDF 路由） | `grep kb-open-in-editor src/` |
| `PAGE_OWNED=['editor','knowledge']`、`SPLIT_ELIGIBLE`（分屏已死，纯残留） | `WorkbenchPageBar.tsx:24` / `appModules.ts` |
| 草稿口径：无 frontmatter id = 知识库不显示；编辑器保存知识页可「转草稿」（status: draft） | `editor/index.tsx:686-693` |
| PdfReaderView 在编辑器模块内（知识库 PDF「在阅读器打开」跳过去） | `PageEditor.tsx:149-153` |

## 2. 批次划分（每批独立可验收）

### 批次 1 · 地基：文件树进知识库左栏（不动编辑区）

1. FileTree 上移共享 `src/components/shared/VaultTree.tsx`（editor 处留 re-export shim，契约路径随迁）。
2. knowledge 左栏改造：NotebookList/CategoryTree/ChapterPanel 三件套 → **筛选器条 + VaultTree**。筛选器 = 顶部下拉（全部 / 按笔记本 / 按分类），过滤树高亮或裁剪（首版：过滤=列表态降级为纯文件树全显 + 高亮匹配项；后续再增强）。
3. 结构维护重做（文件树语境）：树右键 = 新建文件/目录（FileTree 已有 CreateIntent 通道）+「归类到笔记本/分类」（复用 CategoryMovePicker，写 frontmatter/结构 JSON）；现有 SpacePanel/ChapterPanel 收进右键或工具条，不再占左栏骨架。
4. 草稿标识：无 frontmatter id 的文件正常显示 + 弱标识（虚点/斜体）；点击 = 打开页签进编辑态；右键「转为正式笔记」= 补 frontmatter id（核实主进程现有通道，缺则补一个纯写 id 的小 IPC）。
5. 验收：契约扩展 + probe-pagebar 适配（左栏结构变了，选择器要核）+ tsc/build。

### 批次 2 · 编辑区退役：打开通道改道

1. App.tsx：`pendingOpenRel` 的目标从 editor 改为 knowledge（事件名 `kb-open-in-editor` 先不改名——十余处消费方零改动，只换 App 侧路由；后续统一改名一次提交）。editor 页签从 `mountedTabs` 退役（**顺序恒定**：从数组尾部摘除，绝不动 knowledge 的挂载位）。
2. 知识库页签栈吸收 editor 残余能力：最近打开（页签 LRU 已有）、外部变更监听（onWsExternalChange 接进 PageEditor 冲突检测——Phase 1 已具备，核对接线）。
3. PdfReaderView 去向：编辑器模块退役后 Reader 宿主随 PageEditor 内嵌（PDF 页签内嵌阅读器）或独立隐藏模块——实现时核实体量再定（倾向内嵌）。
4. `PAGE_OWNED` → `['knowledge']`；`SPLIT_ELIGIBLE` 删除；`WORKBENCH_TABBAR_EXCLUDED` 不含 knowledge（维持现状）。
5. 验收：全量探针 + 契约；手动核十余处消费方打开路径。

### 批次 3 · 收尾与更名

1. 模块更名「笔记」（显示名/图标条文案），模块 id 内部是否改 `knowledge` → `notes` **暂缓**（改 id 牵动保活/探针/契约面太大，收益低——单独立项评估）。
2. `kb-open-in-editor` → `kb-open-note` 一次性改名（全消费方 + 探针 + 契约）。
3. editor 模块目录清理：吸收完毕后删除（MonacoPane/FileTree/类型已上移；剩余归档到 git 历史）。

## 3. 明确不做

- 实时 Live Preview（Phase 2+ 可选项，另行评估）。
- 多窗口 / 三区外壳（已否决项）。
- 模块 id 改名（批次 3 评估，默认不动）。

## 4. 风险与顺序

1. **保活是第一红线**：knowledge 的挂载位绝不能动；editor 摘除只从尾部删。每批跑 probe-pagebar（18 项）+ probe-batch5-ai（58 项）回归。
2. **结构维护语义**：笔记本/分类数据目前写在 `.knowbase` 结构 JSON（目录树非文件属性），B 方案筛选器读它即可，不需要迁移到 frontmatter——「归类」操作照旧写结构 JSON，只是展示从树骨架变成过滤属性。
3. **草稿转正式**：补 id = 写 frontmatter（readVaultRefText 已有守卫读盘，写走 workspaceWriteFile 拼 id 行）；需与「保存转草稿」（status: draft）语义区分——id 是身份、status 是发布态，互不相干。
4. 每批完成即提交推送（代理 502 用长重试手法），DP 记录照旧。
