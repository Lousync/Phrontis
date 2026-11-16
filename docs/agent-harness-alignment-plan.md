# AI 助手 Harness 对齐实现方案

> **状态**：P0-A/B/C/D 已落码（2026-11-15，v3.31.0）；P1 第 1 项「AI 操作 journal + 撤销本次运行」（v3.32.0）、第 2 项「终端只读通道 `terminal.inspect`」（v3.33.0）、第 3 项「终端 `exec` 增强」（v3.34.0）、第 4 项「只读规划模式 + 通用任务清单」已落码（v3.35.0），其余待排期。
> **目标版本**：`v3.31.0`（P0，新功能）；P1 逐项随 `v3.32.0` / `v3.33.0` / `v3.34.0` / `v3.35.0`（均为新功能）。
> **范围**：P0 四批 —— A 文件策略与通用文件原语 / B 工作区信任 / C 索引与默认忽略 / D MCP、Skill 与工具发现；P1 只给提纲。
> **关联**：`AGENTS.md` 铁律 1 / 2 / 16 / 17 / 18 / 25；`docs/ui-animation-plan.md`；`docs/pending-fixes.md`。

---

## 0. 总览

| 批次 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| P0-A | 文件策略、通用文件原语、目录操作、编码保真 | 大 | 无 |
| P0-B | 工作区信任与一次性开启 | 中 | A（策略接口） |
| P0-C | 默认忽略与索引策略 | 小 | 无（可与 A 并行） |
| P0-D | MCP / Skill 安全语义 + 工具发现 | 小 | 无 |

四批可以按 A → B → C → D 落，也可以 A/B 与 C/D 两两并行。P1 从「AI 操作 journal + 撤销本次运行」开始。

---

## 1. 目标与非目标

### 1.1 目标

把 AI 助手从「笔记助手 + 一组模块工具」升级为**通用的 agent harness**：编码、资料整理、批量处理、脚本运行都只是它的使用场景，底座是同一套文件、命令、检索、权限、可逆性原语。

判断标准不是「能不能写代码」，而是这四件事是否成立：

1. 模型能把仓库当文件系统用（读、写、目录、查找、检索），而不是只能碰 `.md/.txt`；
2. 模型的动作有明确的能力边界（全局 → 工作区 → 仓库策略三层）；
3. 模型改了什么、能不能撤销，用户看得见、退得回；
4. 扩展（MCP / Skill）不会绕开权限、不会把每轮上下文撑爆。

### 1.2 已拍板的前提

- **仓库（vault）= 唯一工作区**，不新增「代码工作区」类型；`{rootId, relPath}` 语义保持不变。
- 策略**按工作区**存，默认保守。
- 权限**一次性开启**：首次使用弹一张行内卡，同时授予「写文件 + 执行命令」，之后不再问。
- 默认可写范围 = **所有文本文件**（`TEXT_VIEWABLE_EXTS`），配置类（json / yml / toml / ini 等）也在内；二进制、密钥、点目录、`.knowbase` 内部仍拒绝。

### 1.3 非目标

- 不新增「代码工作区 / 多根工作区」模型。
- 不做沙箱、LSP、符号索引、子代理、原生 Git 工具（P2 再议）。
- 不改变插件侧 `kb.vault.*` 的权限语义（插件与 AI 用各自的策略函数，避免顺手放大插件权限）。
- 不把 AI 教学的四层 `CONSTRAINTS.md` 机制并进统一助手。

---

## 2. 权限与策略模型

### 2.1 三层，各管一件事

| 层 | 存储 | 职责 | 随仓库走 |
|---|---|---|---|
| 全局默认 | `%APPDATA%/knowbase` 的 settings | `aiVaultFilePerm`：`off` / `read` / `write`；`terminal.aiExec`：`false` / `true` | 否 |
| 工作区信任 | `%APPDATA%/knowbase/data/workspace-trust.json`（dev 为 `knowbase (dev)`），按 `rootId` | `fileWrite` / `shellExec`：`allow` / `deny` / `null` | 否（换机重问） |
| 仓库策略 | `<vault>/.knowbase/config.json#aiPolicy` | 可写类型预设、大小上限、额外拒绝规则 | 是（跟仓库走） |

**生效 = 全局不否决 × 工作区允许 × 仓库策略允许。**

### 2.2 生效矩阵

| 全局 `aiVaultFilePerm` | 工作区 `fileWrite` | 仓库策略 | 结果 |
|---|---|---|---|
| `off` | 任意 | 任意 | 文件工具不出现（硬否决） |
| `read` | `allow` | 允许该扩展名 | 读 + 写 |
| `read` | `deny` | 任意 | 只读，不再询问 |
| `read` | `null` | 任意 | 只读；首次写触发一次性卡 |
| `write` | `null` / `allow` | 允许该扩展名 | 读 + 写，不询问 |
| `write` | `deny` | 任意 | 只读（工作区显式拒绝优先） |
| 任意 | 任意 | 扩展名不在策略内 | 只读（策略只能收窄） |

终端同理：

| 全局 `terminal.aiExec` | 工作区 `shellExec` | 结果 |
|---|---|---|
| `false` | `allow` | 工具可用，每条命令仍逐条确认 |
| `false` | `deny` / `null` | 工具不出现；首次使用触发一次性卡 |
| `true` | `null` / `allow` | 工具可用，每条命令仍逐条确认 |
| `true` | `deny` | 工具不出现 |

`terminal` 模块权限为 `off` 时仍是硬否决，优先于以上所有层。

### 2.3 一次性信任卡

不弹中央模态（铁律 25）。在 AI 助手面板顶部放一张行内卡，所有统一助手宿主（工作台书签 / 右侧栏 / AI 对话页）共用：

> **允许 AI 在此工作区写文件并执行命令？**
> 写文件受本仓库策略限制；命令每条仍需你确认。此授权只对本工作区、本机生效。
> `[一次性开启]` `[保持只读]` `调整可写类型 ▾`

- 「一次性开启」→ `fileWrite=allow`、`shellExec=allow`，写盘后不再询问；
- 「保持只读」→ `fileWrite=deny`、`shellExec=deny`，不再询问，面板上留「只读」小标记，点一下可改；
- 设置 → AI → 权限页增加「当前工作区」一行，可就地切换 / 撤销，不必重开仓库；
- **未决定（`null`）时不预过滤写工具**：模型仍能看到、能调用，`invoke` 返回明确的「此工作区尚未授权，请用户在顶部一次性开启」错误，让模型能引导用户；`deny` / 全局 `off` 才从模型视野移除。
- AI 教学面（`source === 'aiTeaching'`）暂不接这张卡，保持既有行为；后续单独评估。

### 2.4 写入模式默认值

P0 起，**新建会话默认 `confirm`（先预览）**；存量会话保留已存偏好。理由：可写面从 `.md/.txt` 扩到全部文本文件后，`direct` 默认的风险与收益不成比例。用户仍可一键切「直接执行」。

---

## 3. 文件策略

### 3.1 默认值（`all-text`）

- **可读**：`TEXT_VIEWABLE_EXTS` 全部（md / markdown / txt / text / 28 种代码 / json / yml / yaml / toml / ini / cfg / conf / csv / tsv / log）+ `.pdf` / `.pptx` 文本提取 + `.knowbase/modules/*.json` 只读。
- **可写**：同「可读」的文本集合（不含 pdf / pptx / modules json）。
- **始终拒绝**：
  - 任意路径段以 `.` 开头（`.knowbase` / `.git` / `.env` / `.attachments`）；
  - `.knowbase` 内部（唯一例外：`_inbox` 见 §3.3）；
  - 点目录默认全拒；仓库策略可加 `allowDotDirs` 白名单（如 `.github` / `.vscode` / `.devcontainer`），但 `.git` / `.ssh` / `.aws` / `.knowbase` 永远拒绝；
  - 符号链接；
  - 内容含 NUL 或二进制探测失败；
  - 密钥类文件名：`*.pem` / `*.key` / `*.p12` / `*.pfx` / `id_rsa*` / `id_ed25519*` / `credentials*`；
  - 超过大小上限（读 10MB，写 2MB；pdf / pptx 沿用 80MB）。
- **默认忽略目录**（只影响遍历/检索，不阻止显式路径操作）：`node_modules` / `bower_components` / `dist` / `build` / `out` / `target` / `coverage` / `.venv` / `venv` / `__pycache__` / `.next` / `.nuxt` / `.svelte-kit` / `.turbo` / `.cache` / `vendor`。
- 预设：`all-text`（默认）/ `notes`（md + txt）/ `notes+code`（md + txt + 28 种代码）/ `custom`。
- 仓库策略只能收窄：`aiPolicy.writeExts` 是交集，不是并集。
- 锁文件（`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`）默认仍可写，但工具描述提示「不要手改」；后续可加策略项。

### 3.2 编码与保真

新增纯函数模块统一处理，AI 写路径全部经过它：

- **读取**：严格 UTF-8 校验；带 BOM 的 UTF-8 / UTF-16LE / UTF-16BE 正常解码；非 UTF-8 且无 BOM（典型 GBK）→ 报错并提示用 `encoding` 参数显式指定，**不猜**。
- **写入**：
  - 沿用原文件的 encoding / BOM；
  - 沿用原文件的 EOL（CRLF / LF）；`.bat` / `.cmd` 强制 CRLF；新文件用 LF（`.bat` / `.cmd` 除外）；
  - 保留原文件 mode（POSIX `chmod`；Windows no-op）；
  - 非 UTF-8 文件：未显式给 `encoding` 时拒绝写入，避免读成乱码再写回。
- 原子写仍走「临时文件 + rename」；rename 后恢复 mode。

### 3.3 未分类收件箱例外

`.knowbase/_inbox` 是知识页收件箱（`knowledgeIndex` 显式放行）。当前 AI 能搜到未分类页、却读不到（点目录规则），而 `knowledge.create-page` 省略目标时又默认写进这里——**AI 自己建的页自己读不回来**。

P0-A 结尾修掉：只对 `.knowbase/_inbox` 这一个子树放行 `.md` 读写与移动；不放开 `.knowbase` 其它任何路径。系统提示补一句「未分类页在 `.knowbase/_inbox`」。

---

## 4. P0-A：文件策略与通用文件原语

### 4.1 新增模块

| 文件 | 职责 |
|---|---|
| `electron/lib/aiFilePolicyPure.ts` | 类型、默认值、预设合并、`evaluateRead` / `evaluateWrite`、拒绝原因；零依赖，契约脚本直接 import |
| `electron/lib/aiFilePolicy.ts` | 读写 `.knowbase/config.json#aiPolicy`；按仓库缓存 + 失效；把仓库策略与全局默认合成有效策略 |
| `electron/lib/textFileCodecPure.ts` | BOM / EOL / 编码探测与转换；严格 UTF-8 校验；纯函数 |
| `electron/lib/vaultFindPure.ts` | glob 匹配（`**` / `*` / `?`）、深度限制、与忽略规则组合 |

跨仓改动：`phrontis-core/src/kbStore/repoConfig.ts` 增加 `aiPolicy` 段（沿用现有白名单合并 + 原子写）；`phrontis-core` 与主仓一起提交，契约脚本放在主仓。

### 4.2 工具变更

| 工具 | 层级 | 变更 |
|---|---|---|
| `builtin.vault.read` | core | 增加 `startLine` / `endLine` / `numberLines`；非 UTF-8 明确报错；保留 `offset` / `pages` 续读 |
| `builtin.vault.write` | ondemand | 走策略 + codec；增加 `encoding?`；`expectedMtimeMs` 仍为冲突基线 |
| `builtin.vault.edit` | ondemand | 走策略 + codec；非 UTF-8 未指定 `encoding` 时拒写 |
| `builtin.vault.list` | core | 配置类文件可见；增加 `includeIgnored?` |
| `builtin.vault.find` | core（新增） | `path?` + `pattern?` + `depth?` + `limit?` + `includeIgnored?`；返回扁平 `{relPath,type,size?}` |
| `builtin.vault.search` | core | 增加 `regex?` / `glob?` / `contextLines?` / `caseSensitive?`；返回行号、列号、上下文 |
| `builtin.vault.mkdir` | ondemand（新增） | 建目录；已存在则报错（不自动加 `(1)`） |
| `builtin.vault.rename` | ondemand | 源可为目录；目标为已存在目录 = 移入 |
| `builtin.vault.move` | ondemand | 批量移动接受目录；补自嵌套 / 祖孙重叠 / 成环冲突规则 |
| `builtin.vault.trash` | ondemand | 目录需显式 `recursive:true`；返回删除清单；拒绝仓库根 / AI 教学根 / `SOURCES` |
| `builtin.vault.write-batch` | ondemand（P1） | 多文件原子写 + 逆序回滚 |

`vault.rename` / `vault.move` / `vault.trash` 的源 / 目标文件判定也一并改用 `evaluateWrite`，不再写死 `.md/.txt`——否则「能写代码但不能改名代码文件」会成为一个奇怪的能力缺口。

新增 schema 预算：`find` 约 300 字符、`mkdir` 约 120 字符；`search` 增加约 200 字符。P0-D 的 `tool.request` 瘦身会抵消这部分增量（见 §7）。

### 4.3 目录操作规则

- **改名**：源可以是目录。目录在 `categories.json` 有登记时走 `vaultRenameCategory(id, newName)`（保住 space / notebook 类型与排序）；否则走 `renameWorkspacePath`。
- **移动**：目标已存在目录 = 移入；`to` 落在 `from` 子树内 → 拒绝；space 类型目录禁止移动（与界面同口径）；移动后索引重建会按「父级 + 名字」认领原分类节点。
- **删除**：必须 `recursive:true`；返回 `{ files, pages, sample }`；删除前拒绝仓库根、AI 教学根、`SOURCES` 子树、任一点目录段；确认模式下标记为不可回滚。
- **批量移动目录**：整批预检，任一冲突整批拒绝；规则 = 目标已存在 / 自嵌套 / 多条 from 互为祖孙 / A→B 与 B→A 成环 / 受保护根。
- **自写标记**：`markSelfWrite` 目前只登记精确路径；目录操作要改为前缀匹配（或对子树逐个登记），否则已打开的子文件会被 watcher 当成外部改动。
- **未分类收件箱**：见 §3.3。

### 4.4 共用守卫

所有写工具统一经过：

1. `normalizeVaultRel`（任一 `..` / 绝对路径 / 点目录段拒绝）；
2. `aiFilePolicy.evaluateWrite`；
3. `assertCanWrite`（统一助手 scope）；
4. AI 教学边界（仅 `source === 'aiTeaching'`）；
5. 特殊文件保护：`欢迎.html` 可原地写但禁止移动/删除；`课程.md` / `交接.md` / `CONSTRAINTS.md` / `.session.json` 继续走各自专用入口。

### 4.5 暂存与回滚

| 操作 | 暂存方式 | 回滚 |
|---|---|---|
| 写 / 改 | `{kind:'write' 或 'edit', prev, next}` | 写回 `prev` |
| 目录 / 文件改名、移动 | `{kind:'rename'}` | 反向 rename |
| 批量移动 | `{kind:'move-batch'}` | 逆序反向 |
| 建目录 | `{kind:'mkdir'}` | 不回滚（保留空目录） |
| 删除文件 | `{kind:'trash', prev}` | 写回内容 |
| 删除目录 | `{kind:'tool'}` 重放 | 跳过并如实告知「不可自动回滚」 |

### 4.6 契约脚本

| 脚本 | 覆盖 |
|---|---|
| `.AGENT/scripts/ai-harness/verify-ai-file-policy.mjs` | 预设合并、允许 / 拒绝矩阵、密钥 / 点目录 / 大小 / 扩展名 |
| `.AGENT/scripts/ai-harness/verify-text-codec.mjs` | BOM、CRLF/LF、UTF-16、非 UTF-8 拒写、mode 保持 |
| `.AGENT/scripts/ai-harness/verify-vault-find.mjs` | glob 边界、深度、ignore、`includeIgnored` |
| `.AGENT/scripts/ai-harness/verify-vault-dir-tools.mjs` | 目录改名 / 移动 / 删除、自嵌套、祖孙重叠、成环、整批拒绝 |
| `.AGENT/scripts/ai-harness/verify-vault-search.mjs` | regex / glob / 行号 / 上下文 / 截断标记 |

---

## 5. P0-B：工作区信任

### 5.1 新增模块与存储

| 文件 | 职责 |
|---|---|
| `electron/lib/aiPermissionPure.ts` | 三层权限矩阵（纯函数，契约脚本直接 import） |
| `electron/lib/workspaceTrust.ts` | 读写 `workspace-trust.json`、按 `rootId` 取/授权/撤销 |

`workspace-trust.json`（`globalReadJson` / `globalWriteJson`，与 `recentVaults` 同目录）：

```json
{
  "version": 1,
  "vaults": {
    "<rootId>": {
      "fileWrite": "allow",
      "shellExec": "allow",
      "updatedAt": "2026-11-15T12:00:00.000Z"
    }
  }
}
```

- 按 `rootId`（不是路径），仓库移动/改名不丢信任；
- 不在 `.knowbase` 里，拷走仓库不会带走信任；
- 同一台机器复制仓库（同 rootId）会继承信任——可接受，后续若要更严可加 rootPath 哈希。

### 5.2 IPC

| 通道 | 入参 | 返回 |
|---|---|---|
| `aiTrust:get` | — | `{ rootId, fileWrite, shellExec }` |
| `aiTrust:set` | `{ fileWrite?, shellExec? }` | 更新后的状态 |
| `aiTrust:revoke` | — | 清空当前仓库记录（回到未授权） |
| `aiPolicy:get` | — | 有效策略 + 仓库覆盖 |
| `aiPolicy:set` | `{ preset?, writeExts?, maxWriteBytes? }` | 更新后的策略 |

同步改 `electron/preload/index.ts`、`src/lib/ipc.ts`、`src/types/index.ts`。

### 5.3 UI

- 新增 `src/components/shared/AssistantPanel/TrustGateCard.tsx`，挂在 `ChatBody` 顶部；只在统一助手面出现，`fileWrite` / `shellExec` 任一未授权时显示；
- 设置 → AI → 权限：新增「当前工作区」一张卡（读写 / 终端两行 + 策略预设 + 撤销）；
- 所有状态变化走既有 toast，不弹中央模态。

### 5.4 迁移

- 存量 `aiVaultFilePerm=write` → 视为「默认可写」，不弹卡；
- `read` → 首次写触发卡片；
- `terminal.aiExec=true` → 视为默认允许（仍逐条确认）；`false` → 首次用终端触发卡片；
- 没有 `aiPolicy` 的仓库 → 用 `all-text` 默认；
- 新会话 `writeMode=confirm`；存量会话保留。

### 5.5 契约

`.AGENT/scripts/ai-harness/verify-ai-permission.mjs`：全局 × 工作区 × 策略全矩阵，外加「off 硬否决」「deny 优先」「策略收窄」。

---

## 6. P0-C：索引与默认忽略

- `phrontis-core/src/kbStore/ignoreFile.ts`：导出 `DEFAULT_IGNORE_RULES`；`getVaultIgnore()` 先用默认规则建 `Ignore` 实例，再叠加用户 `.ignore`（`!node_modules` 可恢复可见）；默认规则不进 `ruleLines` 对账，避免误报。
- 消费方同步改判据：`ign === null` 不再表示「没有用户规则」，要改用 `ruleLines.length > 0`（`knowledgeIndex` 的 warnings / audit 分支）。
- `knowledgeIndex.scanVaultFiles`：目录命中默认规则整棵剪枝；**点文件跳过**（点目录逻辑保持不变，`.knowbase/_inbox` 仍显式放行）。
- `fsWatcher.IGNORED_SEGMENTS` 与 `builtinTools.SEARCH_IGNORE_DIRS` 改为引用同一份默认集合，删掉三份手写清单。
- `vault.find` / `vault.search` 默认跳过忽略项；`vault.list` 显式给路径时照常展示；两者都支持 `includeIgnored`。
- `.ignore` 的否定规则可覆盖默认值；索引 warnings 继续只报用户规则。

契约：`.AGENT/scripts/ai-harness/verify-vault-ignore.mjs`（默认集合、否定覆盖、点文件、`_inbox` 例外、includeIgnored）。

---

## 7. P0-D：MCP、Skill 与工具发现

- `mcpManager.ts`：
  - 注册时 `tier:'ondemand'`；
  - 每个 server 增加 `readOnly` 声明（默认 `false`），映射到 `requires: 'read' | 'write'`；
  - MCP 工具按 `mcp.` 前缀纳入通用暂存层（确认模式下作为 `kind:'tool'` 方案项重放）；采纳后在方案卡上标「外部工具，不可自动回滚」。
- `skillService.ts`：`tier:'ondemand'`。
- 新增 `builtin.tool.list`（core，约 200 字符）：按 `query` / `domain` 列出**当前权限允许的按需工具**（已装载的也列出，附 `loaded` 标记）；含 `requires` / `module` / `source`。列表本身不依赖 agentService 的会话状态，避免循环 import。
- 改 `builtin.tool.request`：删除硬编码工具清单，改为「先调 `builtin.tool.list` 查名字」；保留一两句常见示例。
- 效果：core schema 净减少；MCP 装得再多也不会每轮常驻；MCP 写操作重新回到确认模式与月度写入上限之内。

契约：`.AGENT/scripts/ai-harness/verify-ai-tool-discovery.mjs`（tier / requires / 权限过滤 / 申请链路）+ 重跑 `.AGENT/scripts/ai-tools-audit/measure-tool-schema.mjs`。

---

## 8. P1 提纲（P0 落地后立即开始）

| 顺序 | 内容 | 关键点 |
|---|---|---|
| 1 ✅ | AI 操作 journal + 撤销本次运行 | 每次运行记 write / edit / rename / move / trash；删除先快照到 `.knowbase/agent/undo/<runId>/`；面板加「撤销本次运行」；容量与保留期上限。落码见 §15 |
| 2 ✅ | 终端只读通道 `terminal.inspect` | 白名单命令（git status/diff/log/show、ls、cat、head/tail、wc、rg、find、file、which）；`spawn` 直呼 argv、不走 shell；规划模式可用。落码见 §16 |
| 3 ✅ | 终端 `exec` 增强 | `tailLines` / `filter` / 输出续读；后台任务 + 事后读取。落码见 §17 |
| 4 ✅ | 只读规划模式 + 通用 todo | `writeMode` 增加 `plan`；todo 工具落到对话框清单。落码见 §18 |
| 5 | 长任务档 | `long/deep` 循环档（60 轮 / 150 写 / 64k 历史）；触顶后支持「继续」 |
| 6 | 规则文件 | 自动注入仓库根 `AGENTS.md` / `CLAUDE.md`（+ 目录级），带长度上限、可关 |
| 7 | `vault.write-batch` | 多文件原子写 + 逆序回滚，暂存为一条 op |

---

## 9. P2 提纲

- 子代理 / 任务委派；
- hooks、自定义斜杠命令、`ask_user` 结构化提问；
- 符号索引、LSP 诊断、原生 Git 工具；
- 沙箱（Windows 先做命令白名单 + 路径约束）；
- 多模态输入（截图 / 设计稿）。

---

## 10. 兼容与迁移

- **插件不受影响**：`isAiReadableFile` / `isAiWritableFile` 保持现有语义供插件与旧工具使用；AI 侧改用 `evaluateRead/Write`。两套策略分开，避免顺手放大插件权限。
- **索引行为变化**：点文件不再进知识索引；默认忽略目录不再进索引。已有仓库重开即重建，不丢数据；用户仍可通过 `!规则` 恢复。
- **设置迁移**：`aiVaultFilePerm` / `terminal.aiExec` 语义改为「默认值 + 硬否决」，见 §2.2；存量值按 §5.4 映射。
- **新会话默认先预览**：存量会话不变。
- **AI 教学**：不接信任卡；`SOURCES` / 生成文件边界保持现状。

---

## 11. 验收与发版

- 每个批次跑对应契约脚本 + `npx tsc --noEmit -p tsconfig.node.json` / `-p tsconfig.web.json`；
- 重跑 `.AGENT/scripts/ai-tools-audit/measure-tool-schema.mjs`，确认 core schema 没有反弹；
- 同步 `resources/help/AI 权限与工具边界.md`、`resources/help/笔记 · 写作模式与编辑器.md`（目录、批量、写入范围有用户可见变化）；
- `package.json` 抬到 `3.31.0`；`CHANGELOG.md` 写段名；重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`；
- `npm run pack` 产物落 `packs/3.31.0`。

---

## 12. 风险与取舍

| 风险 | 处理 |
|---|---|
| 可写面扩大 → 误改风险上升 | 三层权限 + 新会话默认先预览 + 密钥/点目录硬拒 + P1 journal |
| 正则检索回溯爆炸 | 限制 pattern 长度（≤200）、单文件大小、结果上限；必要时优先调用可用 `rg`，否则 JS 扫描 |
| 编码探测误判 | 只对 BOM / 严格 UTF-8 自动处理；其余要求显式 `encoding`，检测不了就拒写 |
| 默认忽略误伤（用户真有个 `build` 目录） | `.ignore` 否定规则可恢复；`vault.list` 显式路径不受默认忽略影响 |
| 信任随仓库复制（同机同 rootId） | 记录 `rootId`，后续可加 rootPath 哈希；跨机不随仓库走 |
| 方案 JSON 存全文膨胀 | P0 先沿用；P1 `write-batch` 时评估改存 patch |
| 目录删除不可回滚 | 确认模式标不可逆；P1 journal 先覆盖文件级 |

---

## 13. 待确认（已按默认落码）

1. 新会话默认 `confirm`（先预览）是否接受？如果希望默认直接执行，把 §2.4 改成 `direct` 即可。
2. `欢迎.html` 允许 AI 原地写、禁止移动/删除 —— 是否需要更严（完全只读）？
3. 锁文件（`package-lock.json` 等）默认允许写，还是加入默认拒绝（需要时再放开）？

> 落码口径：三条均按「建议默认」执行 —— 新会话 `confirm`；`欢迎.html` 可原地写、不改名不删除（沿用既有保护，未加额外限制）；锁文件默认可写，工具描述提示不要手改。

---

## 14. 落码结果（2026-11-15）

| 批次 | 状态 | 主要落点 |
|---|---|---|
| P0-A | 已落码 | `electron/lib/aiFilePolicyPure.ts` / `aiFilePolicy.ts` / `textFileCodecPure.ts` / `vaultFindPure.ts`；`builtinTools` 的 read/list/search/write/edit/rename/move/trash + 新增 find / mkdir；`workspaceManager.writeWorkspaceFile` 加编码 / 换行 / mode；`phrontis-core/repoConfig` 加 `aiPolicy` |
| P0-B | 已落码 | `electron/lib/aiPermissionPure.ts` / `workspaceTrust.ts`；`aiTools` 新增 `aiTrust:*` / `aiPolicy:*` / `aiPermission:get`；`TrustGateCard.tsx` + 设置页「当前工作区」；新会话默认 `confirm` |
| P0-C | 已落码 | `phrontis-core/kbStore/ignoreDefaults.ts`（新）+ `ignoreFile` 默认层 + 索引跳过点文件；`fsWatcher` / `builtinTools` 共用同一清单 |
| P0-D | 已落码 | MCP `tier:'ondemand'` + `readOnly`→`requires`；Skill ondemand；`builtin.tool.list`；`tool.request` 清单退役；MCP 写工具进确认暂存 |

**实测（`measure-tool-schema.mjs`）**：builtin 74 个（core 18 / ondemand 56）；core schema 3544 → 4847 字符（+1303，约 +390 tok/轮），来自新增 find（430）/ tool.list（246）与 read/search 的行区间、正则参数；`tool.request` 的长清单删除后其描述缩短约 300 字符。净增约 190 tok/轮 —— 与 §7「净减少」的预估不符，如实记录；若后续要压回去，首选把 `vault.find` 降为 ondemand。

**契约**（`.AGENT/scripts/ai-harness/`）：`verify-ai-file-policy`、`verify-text-codec`、`verify-vault-find`、`verify-vault-search`、`verify-vault-dir-tools`、`verify-ai-permission`、`verify-vault-ignore`、`verify-ai-tool-discovery`；另更新 `verify-ai-read-exts.mjs` 与 `verify-batch-move.mjs` 以匹配新口径。

---

## 15. P1-1 落码结果（2026-11-16，v3.32.0）

| 落点 | 内容 |
|---|---|
| `electron/lib/runJournalPure.ts`（新） | 纯逻辑：撤销顺序（逆序 + 跳过已撤销）、冲突判定（运行后文件被改过 → 跳过，不覆盖用户修改）、保留期选择（最新一次永远保留） |
| `electron/lib/runJournal.ts`（新） | 运行内 journal（内存）→ 运行结束落 `<vault>/.knowbase/agent/journal/<runId>.json`；删除前原始字节快照落 `.knowbase/agent/undo/<runId>/`；`undoRun` 逆序还原并校验仓库 `rootId` |
| `electron/lib/aiAssistantCommit.ts` | 直接执行路径统一在此记账：落盘前 `beginRunOp`（trash 先快照）、成功后 `commitRunOp`（写后读盘算内容指纹）、失败 `abortRunOp`；先预览仍走 ChangePlan，不重复记 |
| `electron/lib/agentService.ts` | 每次运行分配 `runId`，两处工具执行注入 ctx；结束把 journal 摘要挂到 `AgentChatResult.journal`（失败/中止也保留，便于撤销半途改动）；新增 IPC `aiJournal:undo` |
| 渲染层 | `useAssistantChat` 暴露 `lastRun` / `undoRun`（切会话即收起）；`ChatBody` 的「本次改动」卡新增「撤销本次运行」；模块数据写入不在文件撤销范围内时如实提示 |
| 保留上限 | `agentRunUndoKeepRuns` / `agentRunUndoKeepDays` / `agentRunUndoMaxMb`（`ui:false`，默认 20 次 / 7 天 / 50 MB） |

**口径**：
- 只覆盖统一助手「直接执行」模式的 `vault.write/edit/rename/move/trash`（含目录改名，撤销走分类通道）；`mkdir` 不记、目录删除无快照（沿用 §12「先覆盖文件级」）。
- 运行后文件又被改过 → 跳过并如实告知（用户拍板），绝不覆盖后续手动修改。
- 撤销成功才写 `undoneAt`；有跳过/失败时保留记录，已还原的项不重放，可处理后重试。

**契约**：`.AGENT/scripts/ai-harness/verify-run-journal.mjs`（44 项断言：撤销顺序、冲突矩阵、保留期、快照命名、工具/UI/IPC 接线）。

---

## 16. P1-2 落码结果（2026-11-16，v3.33.0）

| 落点 | 内容 |
|---|---|
| `electron/lib/terminalInspectPure.ts`（新） | 纯校验：命令白名单、参数上限、路径归一（禁绝对路径 / `..`）、git 只读子命令与危险参数黑名单、rg / find / tail 危险参数黑名单、超时与输出上限 |
| `electron/lib/terminalInspect.ts`（新） | 主进程实现：`ls/cat/head/tail/wc/find/file/which/pwd` 用 Node 原生实现（跨平台，不依赖 Unix 命令）；`git` / `rg` 直呼 argv spawn，**永不走 shell**；所有文件路径再过 `assertCanRead` + `evaluateAiFile` |
| `builtinTools.builtin.terminal.inspect`（新） | `readOnly: true` / `requires: 'read'` / `module: 'terminal'` / `vaultFile: 'read'` / `tier: 'ondemand'`；入参 `program + args[] + timeoutMs`，无需逐条确认 |
| `agentService` | 终端写闸（`terminal.aiExec` + 工作区 shellExec 信任）改为只拦 `requires === 'write'`；只读通道据此在「规划 / 先预览」类只读任务里仍可见 |
| 安全细节 | git：`--no-pager`、`core.pager=cat`、`core.fsmonitor=false`、`--no-textconv`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`；拒绝 `--output / --no-index / --ext-diff / --textconv`。rg：只允许只读 flag，拒绝 `--pre / -z / --hidden / -u / --no-ignore / -g / -t / --follow`，并固定追加 `TEXT_VIEWABLE_EXTS` 的 `-g` 白名单、清空 `RIPGREP_CONFIG_PATH`。find：拒绝 `-exec / -delete / -fprint / -fls` 等写文件/执行程序的动作。 |
| 作用域 | `scopeAll=false` 时只允许原生文件命令；`git` / `rg` 这类整仓命令直接拒绝，避免绕过作用域 |

**取舍**：`ls/cat/head/tail/wc/find/file/which` 在 Windows 没有对应可执行文件（`find` 还是另一个程序），故用 Node 原生实现而不是 spawn；「不走 shell」的硬约束对所有路径成立。

**契约**：`.AGENT/scripts/ai-harness/verify-terminal-inspect.mjs`（61 项断言：白名单、路径、git/rg/find/tail 参数、超时/截断、接线）。

---

## 17. P1-3 落码结果（2026-11-16，v3.34.0）

| 落点 | 内容 |
|---|---|
| `electron/lib/terminalOutputPure.ts`（新） | 纯逻辑：`shapeAiOutput`（关键词 AND 过滤 → 末尾 N 行）、`sliceAiOutput`（offset / 8000 字符 / nextOffset / hasMore）、tail / filter 上限 |
| `electron/lib/terminalService.ts` | `aiExec` 增加 `tailLines / filter / background`；输出按 `outputId` 保留最近 40 条 / 4M 字符；`aiReadOutput` 分页续读、查看状态、`kill` 终止；`killAllAiJobs` 应用退出清理 |
| `builtinTools` | `builtin.terminal.exec` 暴露三个新参数；新增 `builtin.terminal.output`（requires read，可 kill，ondemand） |
| `electron/main/index.ts` | `before-quit` 调 `killAllAiJobs`，防止后台命令活过主进程 |
| 结果字段 | 前台/后台都返回 `outputId / totalChars / hasMore / nextOffset / status`；后台额外 `background:true`，`status=running` 时读到当前累计输出 |

**口径**：
- `filter` 是**关键词**过滤（空格分隔 = AND、不区分大小写），不是正则 —— 避免输出驱动的正则回溯爆炸；要做正则检索用 `vault.search`。
- 整形顺序固定：先过滤、再取末尾 N 行、最后按 8000 字符切片；`offset` 是整形后视图内的字符偏移。
- 后台任务默认 10 分钟、最多 30 分钟；前台默认 30 秒、最多 5 分钟。后台输出同样受 400k 原始上限保险丝保护。
- 输出句柄不是审计日志：只保留最近 40 条 / 4M 字符，超出即不可续读（如实报错）。

**契约**：`.AGENT/scripts/ai-harness/verify-terminal-exec.mjs`（30 项断言：整形、过滤、续读边界、接线）。

---

## 18. P1-4 落码结果（2026-11-16，v3.35.0）

| 落点 | 内容 |
|---|---|
| `writeMode` | 会话写入策略扩为 `direct / confirm / plan`；会话行、规范化迁移、preload / IPC / 渲染层类型全链路同步 |
| 工具面 | `buildToolsPayload` 新增 `planMode`：所有 `requires=write` 工具（含 MCP / 模块写）一律不进视野；`builtin.plan.todo` 在规划模式自动放行（on-demand 不额外申请一轮） |
| 硬拦截 | `aiTools.invokeTool` 对 `writeMode=plan + requires=write` 直接拒绝（模型幻觉调用也执行不了）；`builtin.tool.request` 在规划模式不允许申请写工具 |
| 提示词 | 规划模式注入专用纪律：先调查、输出可执行计划、用任务清单展示步骤、不得声称已修改；确认后再切直接执行 / 先预览 |
| `builtin.plan.todo`（新，ondemand） | 模型提交**完整最新清单**（最多 20 项 / 200 字 / 最多一个 doing）；`AgentTraceStep.todo` 随消息 trace 落库 |
| 渲染层 | 输入区运行方式菜单三档；`PlanTodoCard` 在生成态（liveSteps）与完成态（消息 trace）都渲染清单，取最后一条快照 |
| 行为 | 从整仓缩窄作用域只在「直接执行」时自动切先预览，规划模式不受影响 |

**取舍**：清单工具保持 `ondemand`（不占每轮 core schema），规划模式通过 `extraTools` 自动放行；其它模式要模型主动申请。清单只影响界面，不写文件/模块数据；`readOnly:false` 让它串行执行，避免并发更新快照。

**契约**：`.AGENT/scripts/ai-harness/verify-plan-mode.mjs`（32 项断言：清单归一、工具面/硬拦截、会话偏好、UI 接线）。
