# 自定义斜杠指令与提示型 Hooks 实现方案

> **状态**：已落码（2026-11-16，v3.39.0）
> **目标版本**：`v3.39.0`（新功能）
> **关联**：`docs/agent-harness-alignment-plan.md` §9 P2；`AGENTS.md` 铁律 1 / 2 / 25；原型 `tmp/assistant-commands-hooks-proto/index.html`
> **范围**：仓库级自定义 `/` 指令 + 提示型 hooks。不含子代理、shell hooks、符号索引。

---

## 1. 需求（已与用户确认）

### 1.1 自定义 `/` 指令

- 存放：仓库根 `.assistant/commands/<命令名>.md`，一文件一命令，随仓库走。
- 文件名即命令名；支持中文，最长 24 字符，不允许空白 / `/` `\` / 路径穿越 / 前导点。
- 文件格式：
  - 可选 frontmatter `description:`（弹层说明，≤200 字）；
  - 正文 = 提示词（≤20,000 字）；
  - `$ARGUMENTS` 占位符替换为命令后的文字；正文没有占位符时，非空参数追加到末尾。
- 入口（AI 助手面板头部「助手定制」菜单）：
  - 新建自定义指令（行内表单，输入名字 → 生成骨架并打开）；
  - 编辑现有指令（列出现有命令，点哪个打开哪个）；
  - 钩子 · 提示型（ensure `hooks.json` 并打开）。
- `/` 弹层：自定义命令独立分组「自定义指令」，带「自定义」标记；命中后作为一条普通用户消息发出（`ctx.onSend`），不本地执行。
- 生效面：仅统一助手（`surface === 'assistant'`）；AI 教学 / 日程 / 情报不读。

### 1.2 提示型 Hooks

- 存放：仓库根 `.assistant/hooks.json`（预填骨架，手改 JSON）。
- 不执行任何命令、不改文件；只把 `prompt` 注入模型上下文。
- 事件：
  - `run-start`：每次运行开始时注入到 system（同一轮运行内稳定，不破坏 prompt cache）；
  - `after-tool`：匹配的工具成功执行后，在下一轮 LLM 调用前注入一条**不落库**的合成 user 消息。
- 字段：`{ event, prompt, enabled?, tools? }`；`tools` 仅 `after-tool` 使用，支持精确名与尾部 `*` 通配（如 `builtin.vault.*`）。
- 上限：最多 20 条钩子；单条 prompt ≤500 字；注入总量 ≤3000 字；同一条钩子每次运行最多触发一次；每轮最多注入 3 条 after-tool 钩子。
- 开关：设置 → AI → Agent 循环 →「启用提示型钩子」（`agentPromptHooks`，默认开）。
- 生效面：仅统一助手；只读规划 / 先预览 / 直接执行都可注入，但钩子本身不产生写操作。
- 坏 JSON / 非法事件 / 空 prompt：跳过该条，不打断对话；只写主进程日志。

---

## 2. 数据与解析

### 2.1 指令文件

```md
---
description: 按本周笔记生成一份周报
---
请根据本周新增 / 修改的笔记生成周报。
先列提纲，再展开；重点写「本周推进」与「下周计划」。
用户补充要求：$ARGUMENTS
```

- 文件名 `周报.md` → 命令 `/周报`。
- 无 frontmatter 也合法，description 回落为「自定义指令」。
- 正文为空 / 只有空白 → 不进入弹层，调用时报「指令内容为空」。

### 2.2 hooks.json

```json
{
  "_说明": "提示型钩子：只注入 prompt，不执行命令。event: run-start | after-tool。",
  "hooks": [
    { "event": "run-start", "enabled": false, "prompt": "开始前先看任务清单。" },
    {
      "event": "after-tool",
      "enabled": false,
      "tools": ["builtin.vault.write", "builtin.vault.edit"],
      "prompt": "刚改过文件：涉及代码或配置时提醒用户跑一次校验。"
    }
  ]
}
```

- 骨架里的示例默认 `enabled: false`：创建文件不改变现有行为。
- 顶层支持 `{ "hooks": [...] }` 或直接数组（宽容解析，方便手写）。
- 未知字段忽略，便于以后扩展。

---

## 3. 模块与文件改动

### 3.1 新增（主进程，纯逻辑 + IO 分离）

| 文件 | 职责 |
|---|---|
| `electron/lib/assistantCommandsPure.ts` | 命令名校验、frontmatter 解析、`$ARGUMENTS` 替换、骨架生成、列表排序。零依赖，契约直接 import。 |
| `electron/lib/assistantCommands.ts` | 读写 `<vault>/.assistant/commands/`、ensure 骨架、列目录；register IPC。 |
| `electron/lib/assistantHooksPure.ts` | hooks JSON 宽容解析、事件 / 工具匹配、上限裁剪、注入文案拼装。零依赖。 |
| `electron/lib/assistantHooks.ts` | 读 `<vault>/.assistant/hooks.json`、ensure 骨架、register IPC。 |

### 3.2 新增（IPC / 类型）

- `electron/preload/index.ts`、`src/lib/ipc.ts`、`src/types/index.ts`：
  - `assistantCommandsList()` → `{ ok, commands: Array<{ name, description }> }`
  - `assistantCommandsRead(name)` → `{ ok, name?, description?, prompt?, error? }`
  - `assistantCommandsCreate(name)` → `{ ok, relPath?, created?, error? }`
  - `assistantHooksEnsure()` → `{ ok, relPath?, created?, error? }`
- `electron/main/index.ts`：注册新的 handler 组。

### 3.3 改动（主进程）

- `electron/lib/agentService.ts`
  - 读一次 hooks（每次运行开始，`unifiedAssistant && !manual && setting !== false`）。
  - `run-start` 注入：拼到 `systemFull` 末尾附近，标题「【项目钩子 · 运行开始】」。
  - `after-tool`：记录本圆成功执行的工具名；每轮工具批次结束后，匹配未触发钩子 → `convo.push({ role:'user', content:'【项目钩子 · 工具之后】…' })`；不落库、不进 trace、不写会话文件。
  - 预算触顶 / 中断结束的轮不注入（没有下一轮 LLM）。
- `src/lib/settings.ts`：新增 `agentPromptHooks`（toggle，默认 `true`，Agent 循环分组，可搜索）。

### 3.4 改动（渲染层）

- `src/lib/chatCommands.ts`
  - `handleChatCommand` 在未知指令前先 `assistantCommandsRead(name)`；命中则 `ctx.onSend(prompt)`。
  - 未知指令提示里附带当前自定义命令名（读 `assistantCommandsList`）。
  - 只对 `surface === 'assistant'` 查自定义命令。
- `src/components/shared/SlashCommandMenu.tsx`
  - `SlashMenuItem.kind` 增加 `'custom'`；`buildSlashItems` 增加自定义命令参数并归到独立分组「自定义指令」。
- `src/components/shared/AssistantPanel/useAssistantChat.ts`
  - 新增 `slashCommands` 状态；面板可见时与 Skills 一起加载；监听 `assistant-commands-changed` 事件刷新。
  - 控制器暴露 `slashCommands`。
- `src/components/shared/AssistantPanel/ChatBody.tsx`
  - 把 `slashCommands` 传给 `buildSlashItems`（仅 `surface === 'assistant'`）。
  - `pickSlash` 把 `'custom'` 与 `'command'` 同样补全到输入框。
- `src/components/shared/AssistantPanel/AssistantEntry.tsx`
  - 菜单新增「新建自定义指令」「编辑自定义指令 ▸」「钩子 · 提示型」。
  - 新建 = 行内表单（名字输入 + 创建并打开），成功后派发 `assistant-commands-changed` 并打开文件。
  - 「编辑自定义指令」→ 同一弹层内切换成命令列表（有描述），点击打开；没有命令时显示空态。
  - 钩子 = `assistantHooksEnsure()` 后 `kb-open-note` 打开 `hooks.json`。

### 3.5 文档

- `resources/help/AI助手.md`：新增「自定义指令与提示型钩子」小节（存放位置、参数、事件、上限、仅统一助手生效）。
- `resources/help/AI 权限与工具边界.md`：补一句「提示型钩子不执行命令」。
- `docs/agent-harness-alignment-plan.md` §9：P2 该项标记落码指针。
- `CHANGELOG.md` + 应用内更新说明 + `AGENTS.md` 当前工作段。

---

## 4. 关键取舍

1. **不新增管理面板**：命令是普通 md，走知识库 / 编辑器；弹层只负责新建与跳转。
2. **「自定义指令文件夹」改为「编辑自定义指令 ▸」子菜单**：知识库的 `kb-open-note` 只能打开文件，不能打开目录；列出现有命令更符合「点哪个跳哪个」的既有交互。若确实要开系统文件夹，另走 `ws:openInSystem`（不作为默认）。
3. **命令是提示词，不是可执行脚本**：不引入 shell，不新增工具权限。
4. **hooks 只注入文本**：不做工具拦截 / 权限修改 / 文件写入；避免出现「配置文件能绕过权限」的通道。
5. **after-tool 不进历史**：注入的 user 消息只在本次运行的 `convo` 里，不写会话文件；刷新后看不到，也不影响后续轮。
6. **每轮运行只读一次 hooks**：同一运行内 system 前缀逐字稳定，prompt cache 不受影响。

---

## 5. 契约

新增 `.AGENT/scripts/ai-harness/verify-assistant-customization.mjs`：

- 命令名：中文 / 字母 / 数字 / `_-` 合法；空白、斜杠、`..`、前导点、超长拒绝。
- frontmatter：有 / 无 description；坏 frontmatter 不崩；正文为空 → 不进列表。
- `$ARGUMENTS`：替换全部出现；无占位符且参数非空 → 追加；参数为空 → 不追加空行。
- hooks：合法 / 坏 JSON / 直接数组 / 未知 event / enabled=false / 空 prompt / 超上限裁剪。
- 工具匹配：精确名、`builtin.vault.*`、不匹配。
- 注入接线：`run-start` → system；`after-tool` → 合成 user 消息；不落库；预算触顶不注入。
- 仅统一助手：AI 教学 / 日程 / 情报路径不读命令和 hooks。
- 设置开关：`agentPromptHooks` 默认开、关掉不读。
- 弹层：自定义分组、`kind='custom'`、`pickSlash` 补全、入口菜单三项齐备。
- IPC / preload / types / main 注册全链路存在。

另跑既有 `verify-assistant-constraints.mjs`、`verify-plan-mode.mjs`、`verify-long-task.mjs`、`verify-repo-rules.mjs` 防回归。

---

## 6. 手工验收

1. 新建 `/周报`，用编辑器写正文与 `$ARGUMENTS`；输入 `/周报 这周重点写读书` 发送 → 模型收到替换后的提示词。
2. 新建命令时名字含空格 / 斜杠 / `..` → 表单拒绝并给出原因。
3. 在 AI 教学面输入 `/周报` → 不出现、不生效。
4. `hooks.json` 写一条 `run-start` → 新运行生效；改成坏 JSON → 对话不受影响。
5. `after-tool` 匹配 `builtin.vault.write` → 写文件后下一轮模型能看到提醒；刷新会话后历史里没有这条钩子消息。
6. 关掉「启用提示型钩子」→ 钩子不再注入，自定义命令仍可用。

---

## 7. 已确认（2026-11-16）

- 「自定义指令文件夹」= 切到知识库并在左栏文件树定位、展开 `.assistant/commands`（用户确认；不打开右侧编辑区）。
- `hooks.json` 手改 JSON（不做表单 UI）——用户确认。

---

## 8. 落码结果（2026-11-16）

| 落点 | 最终实现 |
|---|---|
| 命令解析 | `electron/lib/assistantCommandsPure.ts`：命令名 Unicode 校验（含 Windows 保留名）、frontmatter 只取 description、`$ARGUMENTS` 全量替换 / 无占位符追加、20k 正文上限 |
| 命令 IO | `electron/lib/assistantCommands.ts`：列目录 / 读单条（参数在主进程替换）/ 新建（已存在不覆盖）/ ensure 目录；大小写不敏感回退 |
| Hooks 解析 | `electron/lib/assistantHooksPure.ts`：数组或 `{hooks:[]}` 宽容解析、事件 / 工具通配、20 条 / 500 字 / 3000 字 / 10 工具上限 |
| Hooks IO | `electron/lib/assistantHooks.ts`：读 `.assistant/hooks.json`（坏 JSON 降级）、ensure 骨架（示例默认关） |
| 注入 | `agentService`：运行开始读一次；run-start 进 system；after-tool 每轮工具批次后注入一条**不落库**的合成 user 消息；预算触顶轮不注入；同一钩子每次运行只触发一次 |
| IPC | 5 个通道（list / read / create / ensureDir / hooks ensure），preload / ipc / types 全链路 |
| 弹层 | `SlashCommandMenu` 新增 `kind='custom'` 与「自定义指令」分组；仅统一助手传入 |
| 入口 | `AssistantEntry` 新增新建指令（行内表单）、自定义指令文件夹（文件树定位展开）、钩子（ensure 后打开） |
| 文件树定位 | 新增 `kb-reveal-tree` 事件 → App 投递 `pendingRevealRel` → 知识库预加载祖先目录并 `handleLocateInTree(rel, { expandSelf:true })` |
| 设置 | `agentPromptHooks` 默认开；关掉只影响 hooks，不影响自定义指令 |
| 契约 | `.AGENT/scripts/ai-harness/verify-assistant-customization.mjs`（87 项断言） |

**与原型差异**：原型里的「自定义指令文件夹」按用户确认改为**文件树定位并展开**（不打开右侧编辑区）；hooks 维持手改 JSON，不做表单 UI。
