# AI 会话随仓库走 · 实施方案

> 2026-10-13 拍板。缘起：用户发现「应用内 AI 对话跨仓库可看」，先确认现状是设计使然（R3 拍板 `agent/mcp(全局)`，且去库化前的全局 `knowledge.db` 就是这个口径），再决定**改为随仓库**，理由是它才对得上项目核心不变量「Vault = 唯一真相源，换电脑 = 拷走文件夹」——对话属于用户自己的学习内容，与笔记同级。
>
> 本文只写方案，未落码。落码前需用户确认（含文末开放问题）。

## 1. 目标与验收判据

| # | 判据 |
|---|---|
| 1 | 会话落在 `<仓库>/.knowbase/agent/`，与仓库同生共死 |
| 2 | 切到仓库 B：AI 左栏只出现 B 的会话；切回 A：A 的会话与消息完整 |
| 3 | 把仓库文件夹拷到新机器（或走「工具箱 → 导出」的整包）→ 会话跟着走 |
| 4 | 存量全局会话**不丢**，一次性归入升级后首次打开的仓库；原文件改名留存（不删） |
| 5 | 未打开仓库时：列表为空、不崩、不静默丢消息 |

## 2. 存储布局

```
<仓库>/.knowbase/
  agent/
    sessions.json               会话索引（原 userData/data/agent-sessions.json）
    messages/<sessionId>.jsonl  每会话一个文件（原 userData/data/agent-messages/<id>.jsonl）
```

选 `agent/` 这个上级目录名而非 `modules/agent/`：与 `.knowbase/` 下已有的平级模块目录（`blog/`、`toolbox/`、`translation/`、`cache/`、`supervise/`）同一惯例，且与 IPC 命名空间 `agent:` 对齐。

**不动**：

- `userData/data/ai-usage.json`（token / 费用记账）——留全局，理由：成本核算是**全应用**口径，且该文件注释已写下「与 AI 会话同层，换机不迁移」；改成随仓库会导致换仓库看不到自己的总花费。
- 会话文件改动台账 `sessionChanges`——它本来就是**内存**台账，主进程重启即清（`electron/lib/agentUsage.ts:171` 注释的 §3.8 口径），没有落盘，无需迁移。
- MCP 配置、插件安装状态、AI Key——R3 同样划为全局，本轮不碰。

## 3. 改哪些文件

### 主进程

**① `electron/lib/agentSessionRepo.ts`（主要改动）**

- 索引读写从 `globalReadJson/globalWriteJson(SESSIONS_FILE)` 换成 `readJson('agent', 'sessions.json', [])` / `writeJsonOrThrow('agent', 'sessions.json', rows)`（`electron/lib/kbStore/jsonStore.ts`，零依赖语义与原子写、损坏兜底都现成）。
- 新增 `vaultAgentDir(): string | null` = `getVaultKbRoot()` + `'agent'`，并 `mkdirSync(recursive)`。
- 所有把 `globalDataDir()` 传给 `agentMessageStore` 的调用点换成 `vaultAgentDir()`。`agentMessageStore` 头注释本就写着「baseDir 由调用方注入，纯逻辑模块（不 import electron）」，换根是它的既定用法。
  **落地更正（2026-10-13）**：该模块另有**一个常量**要改 —— `MESSAGES_DIR` 原为 `'agent-messages'`（全局时代的目录名），
  而本次认领把文件写进 `messages/`；两端不一致的后果是「认领成功但消息全看不见」（契约 `verify-agent-session-migrate.mjs`
  靠「用读端 API 读回来」这条断言当场判红）。已统一为 `'messages'`，两处常量注释互相指认。
- 无仓库时：读 → `[]`；写 → 抛错（沿用 `writeJsonOrThrow` 的语义：调用方会据此向用户汇报成功，静默 false 等于把写盘失败伪装成成功）。
- 例外：`ensureSessionSources()` 这类**读路径顺带回填**（`electron/lib/agentService.ts:1460`）必须用静默 `writeJson`，否则一个列表请求会因为一次回填写失败而整体报错。
- `ensureMigrated()`（v1 全量 json → v2 分文件）保留，baseDir 换根后对新目录依然成立。

**② `electron/lib/agentSessionMigrate.ts`（新增，零依赖纯模块）**

只依赖 `fs` / `path`，baseDir 全部由调用方注入，以便 `node` 直接冒烟（对标 `agentMessageStore` 与 `pluginHostGateway` 的写法）。

```ts
adoptLegacyGlobalAgentStore({ globalDir, vaultAgentDir }):
  { adopted: boolean; sessions: number; messages: number; error?: string }
```

顺序：`agent-sessions.json` + `agent-messages/*.jsonl` 拷进仓库 → 若存在 v1 的 `agent-messages.json` 一并拷入并交给既有的 `migrateLegacyMessages(vaultAgentDir)` → 全局侧原文件改名 `*.migrated.json`（对齐 `agent-messages.migrated.json` 的既有先例，**不删**）→ 返回计数。

幂等性天然成立：全局 `agent-sessions.json` 一旦改名，后续调用直接返回 `{adopted:false}`——**不会**给第二个仓库复制一份。

**③ 认领的挂载点（计划原写 `vaultContext.setCurrentVault()`，落地改为 `workspaceManager.runLayoutMigrations()`）**

计划原方案是挂进 `setCurrentVault()`（全应用「仓库成为当前仓库」的唯一收口，启动恢复 / `ws:openById` / 导入合并 / 退出仓库都经由它）。
**落地时改了**，两条理由：

1. **路径唯一真相源**：`vaultContext` 若自己去拼 `.knowbase/agent`，就把「会话目录叫什么」写成了第二份；
   而它不能 import `agentSessionRepo.vaultAgentDir()` —— 那会构成 `agentSessionRepo → vaultContext → agentSessionRepo` 循环。
2. `workspaceManager.runLayoutMigrations()` 已经是「进入仓库时的一次性工作」收口，且**恰好覆盖全部入口**：
   启动恢复（`:445`）、`adoptVaultDirectory()`（openDir / createVault / 导入合并，`:521`）、`ws:openById()`（切换，`:1130`）。
   认领器本身幂等 + 进程内只试一次，挂一处即三处生效。

失败只打日志，**不阻塞进入仓库**；无仓库时不置位（等真正进入仓库再认领）。
纯模块零相对 import 的约束依然成立：`agentSessionMigrate` 只用 `fs` / `path`，路径由调用方注入。

**④ `electron/lib/agentService.ts`**

无仓库守卫：`agent:newSession` 抛「需要先打开仓库」。渲染层那 4 处调用点（`src/components/shared/AssistantPanel/useAssistantChat.ts:348`/`:429`、`src/modules/ai-teaching/index.tsx:1150`/`:1191`）原本都是 `await agentNewSession(...).catch(() => null)`，抛错只会退化成静默 no-op —— 所以另加了一层渲染层包装（见 ⑦）把静默失败变成可见提示。

**⑤ 无需改动（已核查）**

`agentCompress.ts`、`assistantConstraints.ts`、`aiTeachingFolders.ts`、`aiTeachingSources.ts`、`aiTeachingWorkspaces.ts`、`aiTeachingCourse.ts` 一律只经 repo 层取会话，且对「会话不存在」已写好兜底（`aiTeachingFolders.ts:148` `if (!session) return { ok: false, error: '会话不存在' }`、`:501` `row?.parentSessionId`）。跨仓库的陈旧 sessionId 因此退化为一条明确报错，而不是崩溃。

### 渲染层

**⑥ 正确性上无需改代码。** 切换仓库走 `src/components/shared/VaultSwitcher.tsx:58-62` 的 `reloadInto()`（`location.reload()`，350ms 后整窗重载）与 `src/components/shared/VaultPicker.tsx:57-61` 的启动形态，因此 `App.tsx` 的「Tab 首挂后保活」不会造成读到上一个仓库的会话；首启形态是新挂载，天然干净。

**⑦ 润色（已确认做）**：`agentNewSession` 返回 `null` 时补一条 Toast「请先打开仓库」——现状是静默 no-op，只在「无仓库」这个被仓库选择页盖住的边缘态可见。

## 4. 存量会话归谁（迁移策略）

- **触发点**：升级后第一次「仓库成为当前仓库」（`runLayoutMigrations`，见 §3③）。
- **归属依据**：`settings.json` 记忆 `currentVaultId`，启动即恢复上次在用的仓库（`electron/lib/workspaceManager.ts:436`「恢复当前仓库上下文」）。所以存量会话落在「你上次在用的那个仓库」，这是能拿到的最可靠归属。
- **如实告知**：迁移后 Toast「已把 N 条历史会话归入仓库「X」」，并进更新说明。
  **落地更正**：不能当场广播 —— 切仓库的收尾是整窗 `location.reload()`（`src/components/shared/VaultSwitcher.tsx` 的 `reloadInto`，350ms 后重载），
  当场发出去的 Toast 会被这次重载抹掉。改为落成 userData 下的**待取文件**（`electron/lib/agentAdoptNotice.ts` +
  IPC `agent:takeAdoptNotice`），渲染层启动后取一次、**取走即删**，跨重载跨重启都不丢。
- **判不出来不猜**：不做「按内容猜归属」、不「给每个仓库复制一份」、不改写会话内容。原文件改名留存，想手动挪随时可以。
- **实测体量**（本机 dev 实例）：会话索引约 **60 KB**，消息 `agent-messages/` 24–42 个文件、**300 KB – 1 MB**。同步拷贝是毫秒级，无需异步化。

## 5. 取舍（逐条明说）

| 取舍 | 决定 | 理由 |
|---|---|---|
| 会话行要不要加 `rootId` 字段 | **不加** | 位置本身就是作用域。加冗余字段会漂移，且 `pdfReaderVaultRepo` 那类「rootId 与当前仓库不一致就拒绝」的校验在本场景是多余的（数据不可能出现在别的仓库目录里） |
| 用量统计 `ai-usage.json` | 留全局 | 见 §2 |
| 对话内容进仓库文件夹 | **接受** | 这正是本方案的目的。副作用必须知情：仓库若放在网盘同步目录，对话也会被同步；`.knowbase` 因此变大，整包备份也跟着变大 |
| 会话 jsonl 放 `.knowbase/agent/messages/` | 接受 | 一会话一文件、追加写 O(1)（v2 存储的设计初衷）。`.knowbase` 是点目录，知识库只扫 `.md`，不进索引 |
| 未打开仓库时不能新建会话 | 接受 | UI 被仓库选择页盖住，属边缘态 |
| 平台/`sandbox` 无影响 | — | 全部在主进程，渲染层只走既有 IPC |

## 6. 契约与验证

**新增 `.AGENT/scripts/agent-vault/verify-agent-vault-scope.mjs`（静态断言）**

- `agentSessionRepo.ts` 不再出现 `globalReadJson` / `globalWriteJson`；`globalDataDir()` 只允许出现一次（认领时的**源**目录），且绝不作为消息层的基目录传入；
- 索引读写经由 `readJson('agent'` / `writeJsonOrThrow('agent'`；
- 纯模块零相对 import（否则 node 加载 `.ts` 会 `ERR_MODULE_NOT_FOUND`，契约脚本就跑不起来）；
- 迁移器与读端的消息子目录名常量必须一致（`messages`）。

**新增 `.AGENT/scripts/agent-vault/verify-agent-session-migrate.mjs`（行为断言，临时目录跑纯模块）**

v2 迁移 / v1 迁移 / 幂等（第二次 `adopted:false`）/ 换仓库不复制第二份 / 原文件改名留存 / 索引损坏时抛错且原地不动 / 合并按 id 去重 / 损坏行抛错 / **用读端 API 把认领的消息读回来**。

> 最后一条是本次唯一抓出真 bug 的断言：只比对路径字符串抓不到「认领写 `messages/`、读端找 `agent-messages/`」这类跨模块不一致。
> 计划此处原写「单行损坏不弃整个会话」（那是**读**语义）；**认领**是搬家，跳过损坏行等于事后把源文件改名、那条消息永久消失，
> 因此认领对损坏一律**抛错**、原文件原样保留，可人工处置后再试。

**回归**：`npx tsc --noEmit -p tsconfig.node.json`、`-p tsconfig.web.json`、`npm run build`，以及既有的 AI 相关契约（`verify-ai-tab-anchors.mjs` 等）。

**真机验收（本 shell 做不到，必须你来）**：仓库 A 聊两句 → 切 B → 左栏为空 → 切回 A → 会话与消息完整；在 A 的 `.knowbase/agent/` 里能看到 `sessions.json` 与 `messages/*.jsonl`。

## 7. 文档同步（收尾必做）

1. `docs/rework-master-plan.md`——**修掉 §4 数据边界表的自相矛盾**：该表把「AI 会话历史」列在「跟账户走（仓库级）」列，而 §5 的 R3 行写的是 `agent/mcp(全局)`。本次按「随仓库」落地，需把 R3 行更新并注明 2026-10-13 的口径变更；§3 架构图数据层补一行 `.knowbase/agent/`。
2. `CHANGELOG.md` 加条目（**进 3.5.0 段**，见 §9）→ 重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`（铁律 24；忘跑 = 页面显示上一版且无报错）。
3. `resources/help/常见问题.md`「可以建多个仓库吗？怎么切换？」一节补一句：AI 对话随仓库走（该节现在只说「仓库之间彼此独立」）；`resources/help/AI 助手 · 吉祥物.md` 视情况补「历史会话存在哪」。改完跑 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs`。
4. `docs/ui-updates.md` 补 UI 变更流水（含此前 AI 设置改造那一轮的欠账）。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 存量会话归错仓库（升级后先打开的不是常用仓库） | 启动恢复 `currentVaultId` 使默认路径就是上次在用的仓库；Toast 明示归属；原文件留存可人工再迁 |
| 迁移拖慢「进入仓库」 | 实测 60 KB + ≤1 MB，同步拷贝毫秒级；纯模块失败不影响进入 |
| 迁移代码与 `jsonStore` 形成循环 import | 纯模块只依赖 `fs`/`path`，路径由调用方注入（§3③） |
| 网盘同步目录下 jsonl 频繁追加产生同步冲突文件 | 这是选择「随仓库」的固有代价，写入策略维持「单行 append + 索引原子写」不变；文档注明 |
| 读路径因回填写失败而整体报错 | 回填用静默 `writeJson`，只有「用户会被告知成功」的写才用 `writeJsonOrThrow`（§3①） |

## 9. 决策记录（2026-10-13 已定，落码依据）

| 问题 | 决定 | 说明 |
|---|---|---|
| 版本口径 | **并入 3.5.0 段** | 当前线未发版，与既有 AI 改造同批出；`CHANGELOG.md` 不新开段 |
| 用量统计 `ai-usage.json` | **留全局** | 口径见 §2：成本核算是全应用口径，换仓库仍应看到总花费 |
| 无仓库时的 Toast 润色 ⑦ | **做** | 只改 2 个渲染层调用点，避免留「点了没反应」的排查成本 |

三条原为开放问题，均已由用户确认；本方案自此无待定项，可直接落码。
