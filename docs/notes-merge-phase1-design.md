# 笔记模块合并 Phase 1 技术方案：知识库就地编辑 + 宿主收敛

> 背景：知识库/编辑区是同一份 vault 数据的两套前端壳（目录树 ×2、Monaco 宿主 ×2、页签策略 ×2、跨模块通道 ×5、成对白名单 ×2）。
> 总方向（开发负责人已拍板）：分阶段合并为单一「笔记」模块——旧体验（去库化前的一体化知识库）+ 新不变量。
> **Phase 1 范围**：知识库页签内阅读/编辑就地切换（消灭「想改一笔必须跳编辑区」）+ Monaco 宿主与页签策略开始收敛。
> **Phase 1 不做**：合并导航树（含草稿底部独立分组）、合并模块、退役编辑区、`kb-open-in-editor` 消费方改道——全部留给 Phase 2。

## 0. 已核实的代码事实（写码前不要再凭记忆想象）

| 事实 | 位置 |
|---|---|
| vault 正文唯一写 IPC：`workspaceWriteFile(rootId, relPath, content, expectedMtimeMs?)`，包装层自动广播 `kb:file-saved` | `src/lib/ipc.ts:310-314` |
| 编辑区保存范式：`joinFrontmatter(...)` + `doc.mtimeMs` 作基线；外部删除（missing）不带基线；冲突态 `conflictState` + 「覆盖磁盘」forceMtimeMs | `src/modules/editor/index.tsx:672-711, 781` |
| 外部变更监听：`onWsExternalChange`（mtime 变化 >2ms 即置冲突态） | `editor/index.tsx:546-551, 582-584` |
| 知识库 PageEditor **脏状态机/自动保存防抖/Ctrl+S/保存指示/相似笔记/keep-alive 重读全部已存在**，只是被 vaultMode 闸住 | `PageEditor.tsx:226-252, 326-336, 338+` |
| vaultMode 闸：`doSave` 直接 return（:228）、注解保存 return（:244）、Monaco `readOnly`（:774）、代码/PDF 附件只读（:891） | `PageEditor.tsx` |
| 旧写路径 `updateKnowledgePage`（id 基、pre-R6 语义）——**就地保存绝不复活它** | `PageEditor.tsx:232` |
| 页签纯函数已齐：`previewReplacement` / `pickTabsToEvict` / `nextTabInCycle` / `landingAfterClose` | `src/modules/editor/tabPolicy.ts` |
| 知识库手写另一套页签逻辑 | `src/modules/knowledge/index.tsx:125-147` |
| `kb-open-in-editor` 是**全局文件打开总线**（快速切换器/AI 引用/书架/博客/桌面磁贴/aiTeaching 十余处），Phase 1 保留不动 | `App.tsx:287,537` 等十余处 |
| 回读通道：编辑区保存后 `kb-editor-doc-changed`（`editor/index.tsx:1388`）；知识库 keep-alive 重读 `kb-reload-detail`（`PageEditor.tsx:208-217`，本地有脏编辑则不打断） | 两处 |

## 1. 改动清单

### 1.1 PageEditor 解锁就地编辑（核心）

**进入/退出编辑态**（新增 session 内双态，阅读态为默认）：
- 阅读态 = 现状 `MarkdownPreview`（kbview iframe / PDF 附件展示不变）。
- 编辑态触发：工具条「✎ 编辑」按钮 / 双击正文 / `Ctrl+E`。退出 = 「✓ 完成并保存」（flush 后回阅读态）。
- 切换时资源释放：阅读态 iframe（`WelcomeHtmlView`）在进入编辑态时卸载，编辑态 Monaco 在退出阅读时卸载——不保活双份。

**保存语义（对齐 Obsidian，2026-09-19 查证官方文档与社区资料后修订）**：
- Obsidian **没有「保存」概念**：编辑停顿 ~2s 即防抖写盘（事件驱动 trailing debounce，非定时轮询），`Ctrl+S` 立即写盘，切页/关闭/退出前自动 flush 待写内容。用户心智里只有「这行字已经在盘上了吗」的短暂蓝点，没有「文档脏了要记得存」。
- 本方案采纳同款语义：自动保存防抖（沿用 PageEditor 现有 `autoSaveDebounceMs`）**直接写盘**（走下方 vault 写路径）；`Ctrl+S` 立即 flush；切换页签/退出编辑态前 flush。
- 「脏」降级为**待写盘短暂指示**（防抖窗口内），不再是需要用户管理的持久状态——原型页签上的脏点只在这 2 秒窗口出现。
- 冲突语义不变（mtime 基线），分两种情况：本地**有待写修改** + 外部变更 → 冲突 UI（复用编辑区 `conflictState` 同款）；本地**干净** + 外部变更 → 静默重读（PageEditor 既有 `kb-reload-detail` keep-alive 重读逻辑已具备，本地有脏编辑时不打断的守卫在 :213）。

**保存路径重写**（替换 `doSave` 的 vaultMode 早退）：
1. page id → relPath：复用知识库读源的 id↔path 映射（`knowledgeIndex` 扫描结果经 knowledgeRepo 读出；实现时先核实现有读 IPC 已带 path 的最小入口，**不新写主进程函数**）。
2. 组包：`joinFrontmatter({ frontmatterPrefix, content })`，frontmatter 处理照抄编辑区（保留 id/标题等原前缀）。
3. 落盘：`workspaceWriteFile(rootId, relPath, content, baseline)`，baseline = 页面装载时记录的 `mtimeMs`（`workspaceReadFile` 返回值里取，与 `editor/index.tsx:483` 同源）。
4. 冲突：复用编辑区同款语义——写失败/外部变更（`onWsExternalChange`）→ 提示 + 「覆盖磁盘」（以磁盘最新 mtime 强制写），不静默覆盖。
5. 保存成功后的联动全部走既有广播，**不加新通道**：`kb:file-saved`（ipc 包装自动发）→ 编辑区外部监听自动同步；`kb-reload-detail` → 相似笔记/图谱回读照旧。
6. `updateKnowledgeLinks`（双链入图）：保存后以新正文重新解析提交（沿用现有调用，但核实它在 vault 模式下主进程侧是否已随文件变更重建图谱索引，避免重复入图）。
7. 注解（annotation）：核实其 vault 存放位置后决定随正文一起写或保持独立防抖保存；若现走 `updateKnowledgePage` 旧路径，同样切 vault 写路径。

**旧路径清除**：`doSave` 里 `updateKnowledgePage` 的正文保存分支删除（负向断言进契约）；该函数其他字段用途（如知识库元数据）不受影响。

### 1.2 Monaco 宿主收敛（P1a 抽共享，P1b 换宿主）

- **P1a（必做）**：PageEditor 与 MonacoPane 的 Monaco 装配（主题、选项、markdown language 配置）抽到 `src/components/shared/` 或 `src/lib/` 单份；wikilink 补全注册抽成可复用扩展函数。
- **P1b（做）**：PageEditor 的编辑态换用 `MonacoPane` 作为子宿主。收益：B4 内联建议（ghost text/点火守卫/状态栏微标）、感知相关能力自动随宿主带入知识库，不再维护第二份 Monaco 宿主。PageEditor 现有自装 wikilink 补全迁移为 MonacoPane 的扩展注册。
- 页签徽标：页签上显示 读/写 态 + 脏点（照原型）；写态=该页正在编辑、脏=有未写盘修改。

### 1.3 页签策略统一

- `knowledge/index.tsx:125-147` 手写的 preview/pinned/dirty 逻辑改为消费 `tabPolicy.ts` 纯函数。
- dirty 语义适配：对齐 Obsidian —— 自动保存防抖**直接写盘**，页签「脏」= 防抖窗口内的待写盘短暂态；Ctrl+S 立即写盘；切换页签/退出编辑态前 flush（详见 1.1 保存语义）。

### 1.4 通道与入口处置

- `kb-open-in-editor`：**保留**（全局总线，十几处消费方）。变化仅在知识库内部默认行为：知识库内点笔记 = 就地阅读/编辑，不再默认跳编辑区。
- PageEditor 的「在编辑器模块中打开」按钮：保留、降级为次入口（大文件/双栏对照场景仍有用）。
- `PAGE_OWNED` / `SPLIT_ELIGIBLE`：Phase 1 不动（分屏已下线，白名单残留 Phase 2 清）。

## 2. 明确不做（Phase 2 备忘）

- 合并导航树为一棵（正式笔记 + 底部「草稿」独立分组——**开发负责人已拍板**：无 frontmatter id 的 md/.txt 收进草稿组，点击直接进编辑态；附件/目录照 Obsidian 惯例全量可见）。
- 合并两模块、退役编辑区模块、`kb-open-in-editor` 消费方改道到新模块。
- 清理 `PAGE_OWNED` / `SPLIT_ELIGIBLE` 成对白名单残留。
- Live Preview 编辑模式（Monaco 混合渲染，先议再做）；「新页签默认视图」设置项；点击空 wikilink 建笔记。
- **并排查看移交 3.5.0 分屏重做**：分屏单位从「两个模块」改为「同一笔记的编辑+阅读双视图」（Obsidian Ctrl+点击范式），输入文档 `docs/workbench-split-scope-design.md` 待补记。

## 3. Obsidian 对照与取舍（2026-09-19 查证 help.obsidian.md 官方文档与社区资料）

Obsidian 是这个领域的标杆，且架构前提与我们相同（本地 vault = 纯 md 文件 + 附件、Electron、无数据库）。逐项对照：

| 设计点 | Obsidian 的做法 | 本方案取舍 |
|---|---|---|
| 模块划分 | **没有独立的知识库/编辑器模块**——单一工作区：左栏文件树（全 vault，含附件）+ 中间页签化编辑器，图谱/反链是面板不是模块 | 终态一致（Phase 2 目标）；Phase 1 先在知识库内达成同等体验 |
| 视图切换 | 阅读视图 ⇄ 编辑视图，`Ctrl+E` / 右上角书本⇄铅笔图标切换；**默认新页签=编辑视图**（可设置） | `Ctrl+E`、右上角切换按钮照抄；默认视图先取阅读态（我们编辑态=源码模式，不如 Live Preview 可读），Phase 2 补「新页签默认视图」设置 |
| 编辑模式 | 编辑视图内分 **Live Preview（默认）与源码模式**；Live Preview 行内渲染、光标进入才显语法——「多数情况消除切换阅读视图的必要」 | **Phase 1 不做 Live Preview**（Monaco 上做混合渲染成本高）；双态方案先落地，Live Preview 列为 Phase 2+ 可选项 |
| 并排查看 | `Ctrl+点击` 视图切换器 = 同一笔记同时开编辑+阅读两个视图 | 与 3.5.0 分屏重做天然契合：分屏单位从「模块」细化为「同一笔记的双视图」，记入 Phase 2 备忘 |
| 保存 | **无保存概念**：编辑停顿 ~2s 防抖写盘，Ctrl+S 立即，切页/关闭前 flush；社区插件证明 2s trailing 是写盘频率的验证平衡点 | **采纳**（详见 1.1 保存语义修订——原「写盘才算干净」方案废弃） |
| 页签 | 文件树点击默认替换当前页签（可选新页签）；无 VS Code 式预览页签 | 保留我们已有的 tabPolicy 预览/固定双态（v3.2.0 条目 18），比 Obsidian 的模型更接近 VS Code，不倒退 |
| 文件树 | 显示**全 vault**（含附件、目录、一切文件），无「草稿不可见」概念 | Phase 2 合树时采纳：正式笔记 + 底部「草稿」独立分组（开发负责人已拍板），附件目录照常显示 |
| 双链 | `[[文件名]]` 即身份（无 frontmatter id），点击未解析链接=建新笔记 | 不改我们的 id 体系（改名/重排安全依赖它）；「点击空链接建笔记」列为 Phase 2 增强项 |

**采纳清单**：Ctrl+E 切换、右上角视图切换按钮、防抖直写盘保存语义、切换/退出前 flush、并排查看（移交 3.5.0 分屏重做）、全量文件树（Phase 2）。
**不采纳**：Live Preview（成本，Phase 2+ 再议）、文件名即身份（与 id 体系冲突）、默认新页签=编辑态（源码模式可读性不足）。

## 4. 验证

- 契约：新增 `verify-notes-inline-edit.mjs`（import 真实实现）——① 保存路径断言：PageEditor 正文保存只允许 `workspaceWriteFile` 路径、`updateKnowledgePage` 不出现在正文/注解保存调用点（负向）；② tabPolicy 消费断言；③ joinFrontmatter/baseline 参数形态与编辑区一致。
- 探针：`run-probe.mjs --no-sandbox --disable-gpu`，场景 = 阅读态 → 进编辑 → 改字（走 `window.__kb_monaco` applyEdits）→ Ctrl+S 写盘 → 回阅读态 → 切走再切回（保活重读不丢）→ 外部改文件触发冲突提示。
- 常规：`tsc --noEmit` 双端 0 错；`electron-vite build` 大写盘符 cwd、EXIT=0；改 `electron/` 后重启 dev 验证。

## 5. 风险与顺序

1. **mtime baseline**：照抄编辑区（读盘返回值记录、missing 不带基线、覆盖磁盘用磁盘最新 mtime），不要自造第二套冲突语义。
2. **id→relPath 解析**是唯一可能需要主进程配合的点：优先复用现有读源（探查确认 knowledgeIndex 扫描结果已含 path），确实没有再补只读 IPC。
3. **写盘频率是新的第一风险**（Obsidian 同款痛点）：防抖写盘每次落盘都会广播 `kb:file-saved` → 编辑区回读 + 可能触发知识库索引/图谱刷新。确认主进程侧扫描是增量/去抖的；若实测有风暴，在主进程对同文件连续写做合并（Obsidian 社区为此专门做过 autosave-control 插件，2s trailing 是社区验证过的平衡点）。
4. **保活**：无跨父节点搬迁（PageEditor 本就在 knowledge 模块内部），React #310/重挂风险低；但 Monaco 换宿主（P1b）后要跑保活探针确认切换不重挂。
5. 实施顺序：1.1 写路径 → 1.2 P1a 装配收敛 → 1.3 页签 → 1.2 P1b 换宿主 → 契约+探针 → tsc/build。每步独立可验证。
