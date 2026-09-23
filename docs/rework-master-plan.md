# 重构总方案：Obsidian 内核 + VS Code 外壳（Master Plan）

> 状态：**总体方案定稿**（2026-09-02）。
> 本文档是重构的唯一入口：拍板记录、总体架构、数据边界、统一路线图、子文档索引都在这里。
> **具体功能的设计与实现文档单独成文**，由 §7 索引引用；子文档与本文冲突时，以本文的拍板记录为准。

---

## 1. 目标一句话

把 Knowbase 从「固定 Tab 的 sql.js 桌面应用」重构为：**数据层对齐 Obsidian（Vault 文件即数据 + 双链 + 图谱），外壳对齐 VS Code（Workbench 布局 + 命令面板 + 编辑器组）**，保留现有模块生态与安全底线。

## 2. 拍板记录（2026-09-02，全部已确认）

| # | 决策 | 结论 | 细化文档 |
|---|------|------|---------|
| D1 | 整体方向 | Obsidian 内核 + VS Code 外壳，混合演进，保留模块生态 | 本文 |
| D2 | 仓库模型 | **单仓库**：首次使用选定目录建仓库，之后默认进入；**一个仓库 = 一个账户**，切账户 = 换目录 | §7-2 |
| D3 | 插件路线 | **尽可能开放**：放开 JS 执行，但插件关进沙箱运行时，能力经 Gateway 授权；市场由作者个人开发+审核（受信供应链） | §7-3 |
| D4 | UI 骨架 | **Workbench 化**：活动栏 + 侧栏视图 + 编辑器组 + 底部面板 + 状态栏 | §7-1 |
| D5 | 图谱技术 | **引入 d3-force**（~30KB 纯计算，破「不引包」惯例）；渲染 Canvas 2D 起步 | §7-4 |
| D6 | 图谱归属 | 图谱入口放在**现有知识库模块**（知识库模块重设计中，具体形式后定）；**标签默认入图**、支持开关 | §7-4 |
| D7 | 读写分工 | **知识库模块 = 阅读器 + 结构化视图**（沉浸阅读/刷题/反链/标签）；**编辑器模块 = 唯一写入方**（Monaco + Ctrl+S）；**Vault = 唯一真相源**；无 frontmatter id 的文件 = 普通草稿，知识库列表不显示 | §7-1 / §7-2 |
| D8 | 文档结构 | 总体文档（本文）+ 功能子文档引用制 | 本文 |
| D9 | R6 范围（2026-09-07 拍板） | **彻底 JSON 化**：小模块（日程/说说/习惯/体重/密码本/quiz）也迁 `.knowbase/`，推翻 R3 期「小模块留 sqlite」拍板；sql.js 完整移除 | 本文 §5 R6 |

## 3. 总体架构：三层

```
┌─ 外壳层（VS Code）───────────────────────────────────────┐
│ 活动栏 · 侧栏视图(模块入口) · 编辑器组(唯一写入区)           │
│ 底部面板(全局搜索/日志) · 状态栏(仓库上下文) · 命令面板/快速切换 │
├─ 索引层（交汇点）────────────────────────────────────────┤
│ metadataCache：knowledgeIndex(页面元数据)                  │
│              + GraphIndex(双链/反链/标签，graph.json)       │
│              + 全文搜索索引            .knowbase/cache/     │
├─ 数据层（Obsidian）──────────────────────────────────────┤
│ Vault = 唯一真相源：<仓库>/…/*.md（frontmatter）            │
│         + .knowbase/modules/*.json（结构化模块）            │
│         + .knowbase/config.json（仓库级设置）               │
│ 附件 _attachments/ · 密码 secretStore(DPAPI)               │
└──────────────────────────────────────────────────────────┘
```

**不变量（重构全程成立）**：
1. 渲染层永不接触绝对路径，IPC 只收 `{rootId, relPath}`
2. **内容写入**唯一入口 = 编辑器模块（原子写 + mtime 冲突检测，见 `docs/conflict-resolution-design.md`）；知识库模块自 2026-09-07 起开放**结构维护写**（建删目录/空间/笔记本、导入、重命名、排序——全部 vault 原生文件语义，D7 演进见 §5 R6 注）
3. 索引一律「写时失效、用时懒重建」，失效钩子挂在 `ws:writeFile/createFile/rename/trash` 四通道
4. 密码本/AI Key 走 DPAPI，渲染层永不可见

## 4. 数据边界：账户级 vs 设备级（D2 细化）

| 跟账户走（仓库级，`.knowbase/`） | 跟设备走（`userData/`） |
|---|---|
| 全部模块数据（博客/日程/知识库索引/说说/打卡/书签/体重/quiz/wordbook…） | 主题、字体、缩放、窗口布局 |
| user_profile（账户身份） | **最近仓库列表**（切账户入口） |
| AI 会话历史、插件安装状态与配置 | 锁屏密码 |
| 仓库级设置 config.json（图谱参数等） | 全局设置 settings.json |
| GraphIndex / knowledgeIndex 缓存 | DPAPI 加密密钥（机器绑定） |

**已知约束**：DPAPI 跟机器不跟仓库——仓库目录拷到新机器后密码本/AI Key 需重新加密，迁移流程要预留「重新加密」步骤（开放问题 O3）。

## 5. 统一路线图（去库化 P0-P5 与外壳线合并）

依赖原则：**数据层地基先行，外壳紧随，删库永远最后**；P2-P4（模块迁移）与外壳改造动不同文件，可穿插并行。

| 阶段 | 内容 | 来源 | 状态 |
|---|---|---|---|
| **R0 数据地基** | knowledgeIndex ✅ → 双读源开关 `storage.knowledge` → knowledgeRepo vault 读路径 → 迁移器产品化 | 原 P0 | ✅ 收官（2026-09-02） |
| **R1 Workbench 化** | App.tsx 骨架：活动栏/侧栏视图/编辑器组/状态栏 → 命令面板 + 快速切换器 | 外壳线 | ✅ W1-W3（骨架/命令面板/分屏 v1） |
| **R2 编辑器与链接** | 双链跳转/反链面板（GraphIndex）→ 全局搜索（底部面板）→ Breadcrumbs → Editor Groups 分屏 | 外壳线+原阶段3/5 | ✅ 反链/搜索/分屏 + 编辑器 [[ 补全、大纲、wiki 常驻高亮（Breadcrumbs 挂账） |
| **R3 数据层推广** | 博客(.md) → 说说/日程/打卡/书签 → 密码本(加密) → quiz/wordbook(仓库级)+agent/mcp(全局) | 原 P1-P4 | ✅ 博客/书签/wordbook + 目录重构 + 插件 vault 适配（小模块留 sqlite 为拍板决定） |
| **R4 图谱** | G0-G4（GraphIndex→物理动画→交互→过滤→增删动画），入口在知识库模块 | 原 阶段6 | ✅ G0-G3 + A8 收尾（含设置持久化），G4 其余挂账 |
| **R5 分栏预览**（原 Live Preview，**2026-09-03 用户拍板改方案**） | ~~CodeMirror 6 所见即所得~~ → **编辑区分栏：左 Monaco 编辑 / 右 MarkdownPreview 实时渲染**（复用现有 react-markdown 基建，不引入 CM6） | 原 阶段4 | ✅ 落地（预览开关 + 双链跳转 + localStorage 记忆） |
| **R6 去库收尾**（2026-09-07 拍板 D9：彻底 JSON 化） | R6-a 小模块逐个迁 `.knowbase/` JSON（schedule→moments→habit→weight→password(DPAPI)→quiz，每模块：vaultRepo+渲染层双读+迁移器+回收站/导出适配）→ R6-b 双读源开关 `storageKnowledge` 下线（固定 vault）→ R6-c 移除 sql.js（connection/migrations/repositories DB 分支清理）→ R6-d 备份适配（纯 `.knowbase` 打包）→ R6-e 全量回归+打包验证 | 原 P5 + D9 | 🔜 计划定稿待开工 |
| **R7 插件开放** | 沙箱运行时 + capability 网关 + 签名（修订 plugin-api v2） | D3 | ✅ V3-1 契约定稿 / V3-2a 网关骨架 / V3-2b code 放行 / V3-2c UI+Worker 宿主 / V3-2d 自动挂载 / V3-3 code-hello 试点 / V3-4 签名链路（2026-09-03 收官） |
| **PDF 阅读器 P1**（[plugin-pdf-reader-design](./plugin-pdf-reader-design.md) v1 冻结项全落地，2026-09-03） | 二进制范围读取 ws:readRange → 编辑器 .pdf 文档类型路由（PdfReaderView 懒加载 range transport）→ 大纲/文本层/Ctrl+F 搜索/沉浸 → 知识库附件路由（含无扩展名 PDF 头探测） | 原 阶段4 子项 | ✅ 594d426 → c0ab7f9 → f86e136 → 77c540c（v2 注解/引用/进度 + P2 外壳插件化待做） |

关键排序理由：R0 之前不动知识库读路径；R1 是后续一切外壳功能的容器（命令面板/分屏/底部面板都长在 Workbench 上）；R6 必须等所有模块读完仓库（今日已验证：当前 0 个模块能读仓库文件，此时删库必丢数据）。

## 6. 既有文档的承接

| 文档 | 处置 |
|---|---|
| `docs/plugin-api-v2-design.md` / `reference.md` | **待修订**：红线从「不执行代码」改为「执行代码但关沙箱」，PluginHostGateway 从「唯一通道」变为「沙箱内唯一出口」（见 §7-3） |
| `docs/conflict-resolution-design.md` | 沿用，编辑器唯一写入方的冲突兜底 |
| `.AGENT/docs/去库化迁移方案.md` | 并入本文路线图 R0/R3/R6 |
| `docs/graph-view-design.md` | 沿用，D5/D6 已回写 |

## 7. 子文档索引

| # | 文档 | 内容 |
|---|---|---|
| 1 | [rework-workbench-design.md](./rework-workbench-design.md) | Workbench 化布局：五区规格、模块→侧栏视图映射、App.tsx 改造面、分期 |
| 2 | [rework-vault-account-model.md](./rework-vault-account-model.md) | 单仓库 + 仓库即账户：首次引导、账户切换、数据边界落地 |
| 3 | [rework-plugin-openness.md](./rework-plugin-openness.md) | 插件开放与沙箱：信任模型、红线修订、运行时选型、签名 |
| 4 | [graph-view-design.md](./graph-view-design.md) | 关系图谱：Obsidian 逆向、GraphIndex、d3-force 选型、动画规格 G0-G4 |
| 5 | [rework-toolbox-as-plugins.md](./rework-toolbox-as-plugins.md) | 工具箱插件化评估：逐工具能力映射、四个新 Gateway 命名空间、试点顺序 |
| 6 | [plugin-pdf-reader-design.md](./plugin-pdf-reader-design.md) | PDF 阅读器插件：vscode-pdf 架构借鉴、pdf.js 锁 v3 约束、二进制范围通道、文档类型注册表 |
| 7 | [plugin-external-integration.md](./plugin-external-integration.md) | 外部软件联动：Anki/滴答清单/Habitica/Readwise API 调研、OAuth Connector 框架缺口、待选目标（**长期不做**，2026-09-23 定；材料在 DP `Phrontis/搁置功能与想法/外部软件联动/`） |
| 8 | [agent-file-tools-design.md](./agent-file-tools-design.md) | AI 文件操控工具：Vault 内 list/read/write/edit 工具族、vaultFile 权限域、写入双通道不变量 |
| 9 | [knowledge-query-design.md](./knowledge-query-design.md) | 库查询（Dataview 式）：QDL JSON 查询描述、knowledgeIndex 之上的查询引擎、saved-queries 落 `.knowbase/modules/knowledge/`（**已搁置**，2026-09-23 原型体验后判「暂不需要」；材料在 DP `Phrontis/搁置功能与想法/库查询/`） |
| 10 | [plugin-web-clipper-design.md](./plugin-web-clipper-design.md) | 浏览器剪藏：厚桌面端 clipperServer（127.0.0.1 + token，defuddle 转 md）+ 薄扩展，落 `_inbox/clipper`（判为内置能力，同 lanShare 理由） |
| 11 | ~~zen-mode-design.md~~ | 禅模式 **已实现**（R25，2026-09-06：Z1/Z2 进出+Esc 退，真机验收通过）；设计文档未落盘，如需归档可从实现反写 |

> 9-11 均为 2026-09-02 讨论会话产出的方案文档。10、11 已落码（剪藏内置能力 / 禅模式 R25）；9 已于 2026-09-23 搁置（原型体验后判「暂不需要」，材料见 DP `Phrontis/搁置功能与想法/`）。

## 8. 风险清单

1. **App.tsx 骨架改造**是最大单点：47 迁移/232 IPC 的模块保活架构要迁到 Workbench 容器，需逐模块迁移灰度
2. **知识库模块重设计**与图谱/读写分工会话并行，图谱入口形式待其定稿（已对齐 GraphIndex 复用）
3. **双读源灰度期**双份读路径并存，回归面大——每批迁移都要保留 sqlite 回退开关
4. d3-force 引包后打包体积 +30KB，electron-builder 产物体积可忽略
5. 仓库=账户后，多账户场景的锁屏/密码本语义要重新过一遍（O2）

## 9. 开放问题

- **O1** 命令面板的能力清单与插件命令注册（等 R7 设计）
- **O2** 账户切换时锁屏密码、番茄钟常驻等「进行中状态」的处理
- **O3** 跨机迁移时 DPAPI 加密数据的重新加密流程
- **O4** 知识库模块重设计定稿后，图谱入口与阅读器视图的最终挂载形式
