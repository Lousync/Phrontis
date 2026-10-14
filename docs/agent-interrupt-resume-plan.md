# AI 助手「工作中断」治理方案（A 断点续跑 + B 流式重试）

> 2026-10-14 拟。**状态：决策已拍板，未落码。**
> 上游依据：本仓会话中的探查结论 + `%APPDATA%\knowbase\data\plugin-audit.json` 实测（2026-09-09 ~ 10-14，819 次 LLM 调用 / 1093 次工具调用）。
> 范围：**只做 A、B 两包**。C（超时自适应）/ D（run 内上下文预算）/ F（停止语义之外的杂项）/ G / H 见 §8「本轮不做」，不扩范围。

## 0.0 已拍板（2026-10-14，用户确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 中断卡正文怎么来 | **本地拼接**（纯函数，不调 LLM）；★ 并明确要求：**出错原因要拼进这条回答里给用户看**（见 §3.1 `friendlyReason`） |
| 2 | 续跑指令是否落可见用户气泡 | **不落**（尾部一次性合成 user 消息，不渲染） |
| 3 | resume 有效期 | **下一条用户消息即失效** |
| 4 | 用户按「停止」是否可续 | **可续**（Toast 为「已停止」而非「调用失败」） |
| 5 | B 的落地粒度 | **先阶段 1**（零输出重放，零渲染协议改动），交付后按审计 `attempt` 分布决定是否上阶段 2 |
| 6 | 中断记录是否进模型历史 | **进**（它就是一条 ≤600 字符的正常 assistant 轮） |

---

## 0. 问题复述与实测依据（结论摘要）

**一句话根因**：不是上下文被撑爆，而是「长任务 = 几十次上游请求」把单次网络/超时的偶发失败放大成必然，而**失败那一刻本轮攒下的工作既不落库也不重试**。

| 实测事实 | 数值 | 来源 |
|---|---|---|
| LLM 调用失败率 | 41 / 819 = **5.0%** | `plugin-audit.json` `llm.invoke` |
| 以失败收尾的任务 | 25 / 122 个含工具任务 = **20.5%** | 按 90s 间隔切分 run |
| 落在失败任务里的工具调用 | 215 / 1093 = **19.7%（结果全丢）** | 同上 |
| 单任务 prompt 重发量（10-14 样本） | 35 轮 / 62 次工具 / **102 万 token** | 逐轮 `promptTokens` 求和 |
| 上下文窗口爆掉 | **0 条** context-length 报错 | 全量审计 |
| 顶到 `agentMaxRounds` | **0 个**任务（用户已设 64） | 同上 |
| 自动压缩生效 | **0 / 35** 会话有 `digest`（预算 10 万 × 触发线 60% 从没到过） | `agent-sessions.json` |
| 同名同参重复调用 | 160 / 1093 = **14.6%** | 同上 |

10-14 那次会话的逐轮曲线（首字节超时与连接重置交替）：

```
 1   prompt 11549  cached 11392   33667ms  OK
 5   prompt 45604  cached 34432   10701ms  OK
 6   -             -              60004ms  FAIL 流式响应超时（60 秒无数据）
 7   prompt 32817  cached  4608    9176ms  OK    ← 现场清零，从头重来
15   -             -               4376ms  FAIL net::ERR_CONNECTION_RESET
21   -             -              18009ms  FAIL net::ERR_HTTP2_PROTOCOL_ERROR
23   prompt  4484  cached  4096    3100ms  OK    ← 几乎完全从零
35   -             -              60015ms  FAIL 流式响应超时（60 秒无数据）
```

**四条失效链路（代码实锤）**：

1. 任何一轮 `!r.ok` → 直接退出循环、无重试 —— `electron/lib/agentService.ts:1062`；流式路径明确不做故障转移 —— `electron/lib/llmService.ts:1199-1201`。
2. 失败时本轮工作不落库 —— `appendAgentMessage` 只在成功分支（`agentService.ts:1070`、`:1275`）；历史装配只取 `user|assistant`（`agentService.ts:640`），工具结果本来就只活在本次 run 的内存 `convo` 里。
3. 界面把过程整张卡删掉 —— `src/lib/assistantRunStore.ts:80` `buckets.delete(ended.sessionId)`；用户只看到一个错误 Toast（`src/components/shared/AssistantPanel/useAssistantChat.ts:473`）。
4. 用户按「停止」被记成失败 —— 中断在轮内发生时不带 `ABORTED` 码（`llmService.ts:1269-1279` 只回 `{ok:false,error}`），审计里 12 条 `The operation was aborted` 即此。

---

## 1. 目标与非目标

**A（断点续跑）目标**
- 中断（失败 / 用户停止）时：**本轮已完成的步骤、已写改动、已获得的工具结果**都留下来，并且用户看得见。
- 提供一个「继续」入口：带着已获得的信息接着做，**不重跑那些已经做过的查询**。
- 中断记录可在**重启后**仍然可续（它是落盘数据，不是内存态）。

**A 非目标**：不做多分支续跑（只保留「最近一次中断」）；不把工具结果原样全量塞回上下文（有预算，见 §3.5）；不改工具层语义。

**B（流式重试）目标**
- 供应商级抖动（首字节超时 / 空闲超时 / 连接重置 / HTTP2 协议错 / 5xx / 429）时，**本轮原地重放**，而不是让整个任务死掉。
- 重试对用户**可见**（不再是一次 60 秒的静默假死）。
- 重放不得让「用户停止」也进入重试（这是硬约束，先修 abort 语义，见 §4.2）。

**B 非目标**：不改单次超时常数（那是 C）；不改上下文预算口径（那是 D）；不做跨轮断点（那是 A）。

---

## 2. 不变量与既有约定（必须遵守）

| 约定 | 本方案如何遵守 |
|---|---|
| 铁律 17：结果侧「拿得少 / 丢得早」，压缩必须纯函数且幂等 | 续跑 carry 的构造与裁剪放 `*Pure.ts`，纯函数、上限固定、幂等（重复构造同输入同输出） |
| 铁律 1：主进程写盘后要有刷新通道 | 复用 agent 既有通道：`broadcastRunState`（`agentService.ts:1379`）+ 渲染层结果后 `refreshMessages` |
| 铁律 25：常规确认行内化、禁止弹窗 | 「继续」是中断卡上的行内动作，**不是弹窗** |
| 铁律 12：说明文字按 `docs/help-disclosure-pattern.md` 收，不新增醒目横幅 | 中断卡的说明走既有 `TraceBlock` 折叠区 + 一行状态句 |
| 铁律 13：所有进出都要有动效 | 中断卡入场用 `.kb-item-in`，按钮反馈用 `.kb-micro-pop`（缺则先补基建再落码） |
| 契约脚本文化：改大了必须配独立验证脚本 | `*Pure.ts` + 两个 `.mjs` 契约（见 §3.8 / §4.8） |
| UI 改动先出单文件 HTML 原型 | A 涉及界面 → **原型先行**（§3.6 末），原型进 `tmp/`，不进 git |

---

## 3. A 方案：断点续跑

### 3.1 数据结构（三处新增，全部向后兼容）

**(1) 新增纯函数模块** `electron/lib/agentInterruptPure.ts`（零依赖，供 `.mjs` 契约 import；写法对标 `electron/lib/llmProtocolPure.ts:1-12`、`electron/lib/agentLoopPolicy.ts`）：

```ts
export interface InterruptChange { action: string; target: string; file?: string }
export interface InterruptFacts {
  reason: string            // 已本地化的原因串（如「流式响应超时（60 秒无数据）」）
  aborted: boolean          // 用户停止 = true
  rounds: number            // 本次 run 消耗的推理轮数
  toolCalls: number         // 本次 run 的工具调用次数
  changes: InterruptChange[]
  lastProcessText?: string  // 最后一次带工具轮次的旁白（≤300 字符，来自 trace）
}
/** 中断卡的正文（人读 + 进历史）——上限 600 字符，确定性、无 LLM */
export function buildInterruptContent(f: InterruptFacts): string
/** ★ 拍板点 1：原始错误串 → 用户看得懂的一句话（下表）；未命中则原样返回 */
export function friendlyReason(raw: string, aborted: boolean): string
/** 续跑 carry：把本轮工具结果压成「已获得的信息」——单条 ≤800 字符、总量 ≤6000 字符、新→旧 */
export function buildResumeCarry(rows: { tool: string; args: string; result: string }[]): string
/** 续跑注入文本（一次性、不落库）：RESUME_NOTICE + carry */
export function buildResumeInjection(f: InterruptFacts, carry: string): string
/** 会话列表/结果里只暴露摘要，**绝不带 carry 正文** */
export function toResumeInfo(r: SessionResume): ResumeInfo   // { at, reason, messageId, toolCalls, changes, aborted }
export const RESUME_NOTICE: string
export const INTERRUPT_CONTENT_CAP = 600
export const CARRY_TOTAL_CAP = 6000
export const CARRY_ITEM_CAP = 800
```

**`friendlyReason` 映射表**（原始串来自本机审计的真实样本，未命中的一律原样透出，不吞错）：

| 原始错误串 | 给用户看的话 |
|---|---|
| `流式响应超时（60 秒无数据）` | 等待模型响应超时（60 秒内一点数据都没回来）｜已收到 N 段后卡住时改说「模型输出到一半卡住了」（判据见 §3.1b A） |
| `net::ERR_CONNECTION_RESET` | 网络连接被中断 |
| `net::ERR_HTTP2_PROTOCOL_ERROR` | 与模型服务的连接出错（HTTP/2 协议错误） |
| `net::ERR_NAME_NOT_RESOLVED` | 域名解析失败（检查网络或代理） |
| `The operation was aborted…` + `signal.aborted` | 你点了「停止」，本次任务停在这里 |
| `免费模型限频中…` / `HTTP 429` | 模型服务限频，稍后或换模型重试 |
| `上游模型暂时不可用（5xx）` | 模型服务暂时不可用 |
| `鉴权失败（401/403）…` | API Key 无效或已过期 |
| 其它 | 原样（截断 120 字符） |

**中断卡正文模板**（`buildInterruptContent` 产出，直接当回答正文展示给用户；长度实测这类文本 <300 字符）：

```
本次任务被中断：等待模型响应超时（60 秒内一点数据都没回来）。
（原始错误：流式响应超时（60 秒无数据））

已进行 12 轮推理 / 21 次工具调用。已经完成的改动（3 处）：
1. 编辑「减肥记录/饮食计划.md」
2. 新建「减肥记录/周复盘 10-14.md」
3. 打卡「运动」

已获得的信息已保留，可从中断处继续，未完成的查询不必重跑。
```

**(2) 会话行新增字段**（`electron/lib/agentSessionRepo.ts`，跟 `digest` 同一层，`:87-117` 之后）：

```ts
export interface SessionResume {
  /** 中断时刻（本地时间串，同 nowLocal 口径） */
  at: string
  /** 中断记录对应的那条 assistant 消息 id —— 「继续」动作挂在它上面 */
  message_id: string
  /** 原因串（直接展示） */
  reason: string
  aborted: boolean
  tool_calls: number
  changes: InterruptChange[]
  /** 机器可读的现场（本次已获得的工具结果摘要），**只在续跑时注入** */
  carry: string
}
// AgentSessionRow 加： resume?: SessionResume
// 新增写回函数（照 updateSessionDigest 的写法，agentSessionRepo.ts:390-397）：
export function updateSessionResume(id: string, resume: SessionResume | null): void
```

> **为什么放会话行、不放消息行**：① 语义上「一个会话只有一个可续的中断点（最近一次）」，天然幂等；② 放消息行的话 `agent:messages` 会把 6k 字符的 carry 全量发给渲染层（`camelRow` 是 spread 全字段，`agentService.ts:1422-1434`），放会话行同样有这个风险 —— 所以**两处 IPC 出口都要裁剪**：`agent:sessions` 只发 `toResumeInfo()`（不带 carry），`agent:messages` 不动（消息行不含 carry）。

**(3) 中断记录本身 = 一条普通 assistant 消息**（`electron/lib/agentMessageStore.ts:23-30` 的 role 只有 `user|assistant`，**不新增 role**）：
- `content` = `buildInterruptContent(...)`
- `trace_json` = 本次 run 的 `AgentTraceStep[]`（**含失败那一步**）
- 渲染侧零改动即可显示：两个宿主都已把 `traceJson` 映射成 `trace`（`useAssistantChat.ts:152`、`src/modules/ai-teaching/index.tsx:929`），`MessageList` 对任何带 trace 的消息渲染 `TraceBlock`（`MessageList.tsx:242`）。

## 3.1b 原因归因：中断卡到底能说到多具体（★ 2026-10-14 用户追问后补）

**结论：今天只能「原样转述」，给不到「归类 + 判据」；要说到具体，必须在失败那一刻补采集，而不是在拼接时想词。**

> ★ 2026-10-14 追问后，本节已升级为独立子系统方案 → **`docs/agent-error-attribution-plan.md`**（采集层 `RawFailure` / 归一 `classifyFailure` / 呈现三层；22 个原因码；四家适配器逐行落点；mock provider 13 类故障矩阵；G1–G12 缺口清单）。本节的表是该方案的精简版，**码表与判据以那份文档为唯一真源**。

> **原则：拼接质量 ≤ 采集质量。** 中断卡的正文是**事后**从已捕获的数据拼出来的 —— 失败路径没记下来的东西，写文案时无中生有不了。所以本节一半是「分类表」，一半是「**采集清单**」。

### A. 采集清单（失败那一刻已经在手、但现在没往上传的东西）

| 现场量 | 今天在哪 | 现在传上来了吗 | 用途 |
|---|---|---|---|
| 结构化原因码 | 只有自由文本 `error`（`llmService.ts:1085-1089` 的 `code` 只覆盖 3 个配置类错误） | ✗ | 区分「首字节超时 / 空闲卡死 / 401 / 429 / 400 上下文超长」 |
| 已收到多少数据段 | `createStreamAbort` 的 `sa.chunk()` 被调用次数（`llmService.ts:455`） | ✗ | **零段 = 首字节阶段就断**；非零段 = 收了一半被掐 |
| 已产出多少字符 | `adapter.chatStream` 内的 `content.length` | ✗ | 判断是「一句没说」还是「说了一半」 |
| 跑到第几轮 / 已用 token | `runAgentLoop` 的循环下标与 `runTokens` | 只在 trace 里 | 正文里的「已进行 N 轮」，也用于判断是不是预算耗尽 |
| 已重试几次（B 上线后） | 尚无 | ✗ | 「已重试 2 次仍未成功」——决定建议动作 |
| 最后成功的工具 / 最后失败的一步 | trace 已有（`AgentTraceStep{kind:'tool',ok}`） | ✓ | 已在卡片显示 |
| 上游 HTTP 状态码 | 被 `friendlyHttpError` 拼进中文串（`llmService.ts:339-349`），detail 截断 120 字符 | 半 | 分类要码，不要从中文里正则挖 |

### B. 原因码表（建议枚举 → 卡片上写什么 → 建议动作）

| 原因码 | 今天能判定吗 | 补齐后 | 卡片正文（白话） | 建议动作 |
|---|---|---|---|---|
| `LLM_STREAM_FIRST_BYTE_TIMEOUT` | ✗（与下一行同一个串） | 靠「收到 0 段」 | 等待模型响应超时（60 秒内一点数据都没回来） | 重试；反复出现就换模型/查网络 |
| `LLM_STREAM_IDLE_TIMEOUT` | ✗ | 靠「收到 N 段」 | 模型输出到一半卡住了（已收到 N 段后 60 秒无数据） | 可继续（已产出的部分作废） |
| `LLM_PROVIDER_NET` | 半（英文串透出） | ✓ | 与模型服务的网络连接中断 | 可继续 / 重试 |
| `LLM_HTTP_4xx/5xx`（带码） | 半（中文串里有码） | ✓ | 模型服务返回 <码>：<上游原话> | 按码给（401 查 Key / 429 等或换模型 / 5xx 稍后） |
| `LLM_CONTEXT_OVERFLOW` | ✗（今天是 `HTTP 400: ...maximum context length...`，靠字符串猜） | ✓ | 这轮上下文超出模型窗口（已用 N token） | 压缩/新开会话；工具层收窄查询 |
| `LLM_AUTH` | 半 | ✓ | API Key 无效或已过期 | 去设置里检查账号 |
| `AGENT_ROUND_CAP` / `AGENT_TOKEN_BUDGET` | 只能从 `hitCap` 间接看 | ✓ | 达到本次任务上限（N 轮 / N token），已就地总结 | 抬预算或拆任务 |
| `AGENT_SUMMARY_FAILED` | ✗（今天是 `MAX_ITERATIONS` 的合并文案） | ✓ | 预算已耗尽，且收场总结也没跑成 | 可继续 |
| `USER_ABORTED` | ✗（今天报成「调用失败」，见 §4.2） | ✓ | 你点了「停止」 | 可继续 |
| `EXCEPTION`（异常逃逸） | ✗✗ **完全静默**（见下 C-1） | ✓ | 内部异常：<错误类名>（已留完整日志） | 报 bug 时附日志 |
| 上游 200 + SSE 内 error 帧 / 干净 EOF | ✗✗ **静默当成功**（见下 C-3） | ✓ | 回答被上游中途截断（未收到结束帧） | 重新生成 |

### C. 三条结构性缺口（补齐前，「具体原因」在部分场景**原理上给不出**）

1. **异常逃逸 = 完全静默（P0，A 的必备项）**：`agentService.ts:1372-1388` 的 `withAbort` **只有 try/finally，没有 catch**；渲染层 `useAssistantChat.ts:456-480` 的 `send` 同样只有 try/finally；渲染层**没有**全局 `unhandledrejection`（只有 dev 桥的收集器 `src/devbridge/collector.ts:158` 有）。三者叠加 ⇒ 主进程里任何未被 `runAgentLoop` 收住的异常（如工具执行器抛错、写盘抛错）会：**卡片消失、零 Toast、零记录**。这是「工作中断且什么提示都没有」的最坏形态，也是用户这次抱怨的一部分。→ 落点：`withAbort` 补 `catch` 返回 `{ok:false, code:'EXCEPTION', error}`；`send`/`regenerate`/`editSubmit` 补 `catch`；未捕获异常也走 §3.2 的中断记录。
2. **归因错位：`CONNECT_TIMEOUT_MS` 是死常数**（`llmService.ts:114` 声明后全文件无引用）⇒ 连接/DNS 阶段挂住时没有独立判据，一律表现成「60 秒无数据」被报成**响应超时**。→ 短期不必新增超时（那是 C）：用「收到 0 段」把首字节超时与空闲超时**分开说清楚**，并在文案里**不声称**是连接问题；长期把它接上或删掉，别留着当装饰。
3. **静默 EOF = 当成功**：流被服务端干净关闭（EOF 且无 `[DONE]` 帧）时 `readFrames` 正常结束 → 返回 `{ok:true, content:半截}` → 渲染层当正常回答（`docs/pending-fixes.md` B-29 §4 已记这条，与本节同源）。→ 落点：`stopReason` 透传（B-29 本体的 G 项），或至少「未见 `[DONE]` 即标记异常收尾」。

### D. 不可归因时怎么写（诚实口径，禁止编造）

拿不到判据时正文只写**观测到的事实 + 已做的努力**，不给因果猜测：
> 本次任务被中断：与模型服务的连接中断，未收到任何错误说明（已重试 2 次）。
> 原始错误：（空）

**禁止**：把「60 秒无数据」写成「网络不通」、把 5xx 写成「你的网络有问题」、把未知异常写成「服务繁忙」—— 归错因会让用户去修一个不存在的问题。

### 3.2 生命周期状态机

```
                        ┌──────────── 续跑成功 → 清空 resume
                        │
[run 开始] ──► 成功 ──► 不写 resume                       （保持现状）
                │
                └─► 失败/停止 ──► 写 1 条中断 assistant 消息
                                  写 session.resume（含 carry）
                                        │
   ┌────────────────────────────────────┼────────────────────────────────────┐
   │                                    │                                    │
[点「继续」] claim：先 resume=null，再跑 resume 轮      [用户发新消息]        [消息被编辑/删除]
   │                                    │  → resume=null（现场作废）          → resume=null
   └─► 成功 → 不再写（resume 已是 null）  └─► 失败 → 重新写一份 resume
```

**写 resume 的三个触发点**（都在 `runAgentLoop` 内，统一收口）：轮内 `!r.ok`（`agentService.ts:1062`）、轮数/token 预算耗尽后**强制总结轮也失败**（`:1251-1278`）、以及用户中断（`:1009`/`:1219` 的 `signal.aborted` 分支，以及 §4.2 修好后的 `code==='ABORTED'` 返回）。

**清 resume 的四处**：① 续跑 claim；② `appendAgentMessage(sessionId,'user',…)`（`agentSessionRepo.ts:413`）；③ 消息编辑/删除/删其后（照 `invalidateDigestOnMutation` 的写法，`agentSessionRepo.ts:461-476`，新增 `invalidateResumeOnMutation`）；④ 会话删除（行没了，天然清）。

**落库失败怎么办**：写 resume 是**尽力而为**——`try/catch` 包住，失败只 `console.error`，绝不因为「记录中断」失败而改变本次调用的返回结果（对齐 `appendAudit` 的「审计失败不阻断业务」哲学）。

### 3.3 落点清单（改哪些文件）

| 文件 | 改动 |
|---|---|
| `electron/lib/agentInterruptPure.ts` | **新增**：§3.1 的全部纯函数与常数 |
| `electron/lib/agentSessionRepo.ts` | 新增 `SessionResume` 类型 + `AgentSessionRow.resume?` + `updateSessionResume()`；`invalidateResumeOnMutation` 接到 `updateMessageContent` / `deleteMessage` / `deleteMessagesAfterId`；`appendAgentMessage` 里 user 角色时清 resume |
| `electron/lib/llmService.ts` | A-0 配套（§3.1b 采集清单）：① 失败分支的 `code` 从 3 个配置码（`PROVIDER_NOT_FOUND \| PROVIDER_DISABLED \| NO_DEFAULT_MODEL`，`:1085-1089`）扩成原因码枚举；② 流式失败时把「**已收到数据段数**」「**已产出字符数**」带出（`sa.chunk()` 调用次数与 `content.length` 都在手，`:455`）—— 这是区分「首字节超时 / 空闲卡死」的唯一判据 |
| `electron/lib/agentService.ts` | ① `runAgentLoop` 失败/停止三分支收口到 `persistInterrupt(...)`；② 失败时**也返回 `changes`**（现在只在成功分支返回，`lastChanges` 面板拿不到已写改动）；③ 新入口 `agentResume(req, signal)`（≈ `runAgentLoop` + `resumeInjection`，**不追加用户消息**）；④ `ipcMain.handle('agent:resume', …)` 挂 `withAbort`（照 `:1390-1397`）；⑤ `agent:sessions` 出口（`:1465`）对会话行做 `toResumeInfo()` 裁剪 —— `agent:messages`（`:1478`）取的是消息行、**不含 resume，无需改**；⑥ **`withAbort`（`:1372-1388`）补 `catch`**：异常逃逸也要返回 `{ok:false, code:'EXCEPTION'}` 并落中断记录（§3.1b C-1，今天这条是**完全静默**的） |
| `electron/preload/index.ts` | 新增 `agentResume`（照 `:281` `agentChat` 的形状） |
| `src/types/index.ts` | `AgentSessionInfo.resumeInfo?`；`AgentChatResult.interrupted?: { resumable: boolean; reason: string; aborted: boolean }`；`ResumeInfo` 类型 |
| `src/lib/ipc.ts` | `agentResume(sessionId, chatId)` 封装 |
| `src/components/shared/AssistantPanel/useAssistantChat.ts` | 新增 `resume` 动作（复用 `beginRun/endRun` 与运行中守卫）；失败分支 toast 由「AI 调用失败」改为「已中断 · 可继续」（成功续跑则静默）；**三个入口（`send` / `regenerate` / `editSubmit`）补 `catch`** —— IPC 拒绝（`withAbort` 抛错）今天是无声的（§3.1b C-1） |
| `src/components/shared/AssistantPanel/MessageList.tsx` | 末条 assistant 消息的动作行加「继续」（位置同「重新生成」，`:225-231`），**仅当该消息 id === resumeInfo.messageId 且有 resume** |
| `src/lib/assistantRunStore.ts` | 中断时不再静默：`failed` 角标语义细化为「可继续」；后台会话仍进未读/失败集合（`:81-88`） |
| `.AGENT/scripts/agent-resume/verify-agent-resume.mjs` | **新增契约**（§3.8） |

### 3.4 续跑请求的装配（关键取舍）

`agentResume` 不新建用户消息：中断前那条**用户消息仍在历史末尾**（它在 run 开始时就落库了，`agentService.ts:602`），所以 `runAgentLoop` 的守卫 `history[last].role === 'user'`（`:697`）天然通过。续跑只需在两处改动：

1. **尾部追加一条一次性的合成 user 消息**（不落库、不渲染）：
   ```
   { role: 'user', content: buildResumeInjection(facts, carry) }
   ```
   放在 `convo` 末尾（**不进 `requestInjection` 槽**）—— 理由：续跑指令必须是「最近一条指令」才有牵引力；而 `requestInjection` 是注入首条 user 消息的（`agentCompressCore.ts:152-162`），语义是「本轮素材」，混进「继续」会让历史读起来错乱。
2. **工具结果 carry 只此一次**：续跑成功后 `resume` 已清空，carry 不会污染后续任何一轮。

> **prompt cache 影响**：注入发生在消息尾部，**前缀（system + tools）逐字不变**，缓存前缀不受影响；carry 本身只付一次。

### 3.5 carry 的构造（拿得少、丢得早）

来源 = 失败那一刻 `convo` 里的 `role:'tool'` 消息（`agentService.ts:1150-1154` 压进去的），与 `compressStaleToolResults`（`:167-179`）同源但**更狠**：

| 层级 | 规则 |
|---|---|
| 逐条 | 复用 `compressOneToolResult` 的缩水思路（标量保留、长文本/大数组降级），再截到 `CARRY_ITEM_CAP=800` 字符 |
| 总量 | `CARRY_TOTAL_CAP=6000` 字符（≈2.3k token），**新→旧**取，超了直接丢最老的 |
| 形态 | `工具名(关键参数) → 结果摘要`，一行一条，便于模型复述「已经查过什么」 |
| 幂等 | 同输入恒同输出（纯函数），重复构造不漂移 |

**不做**：不调 LLM 生成 carry（理由见 §7 决策 1）；不把 `MAX_TOOL_RESULT_CHARS=24000` 的原始结果搬回来（那是 §8 D 要治的病）。

### 3.6 UI 变化（原型先行）

- **中断卡**：就是那条 assistant 消息 + 既有 `TraceBlock`。正文 = `buildInterruptContent` 的产出（**首行是用户看得懂的原因**，第二行灰字给原始错误串便于诊断，其后进度 + 改动清单）；新增一行状态句（灰字）：`已中断 · 12 轮 / 21 次工具调用 · 3 处改动`。**不给横幅、不给图标轰炸**（铁律 12）。
- **动作行**加「继续」（`MessageList.tsx:225-231` 同位，`RefreshCw` 换成 `Play`/`ArrowRight`），仅该消息可续时出现（`resumeInfo.messageId === m.id`）；点击后该消息的「继续」转为运行中（复用 `pending` 态）。
- **Toast**：失败 → 「已中断：{原因} · 可点「继续」接着做」；用户停止 → 「已停止 · 可继续」。
- **「本次改动」面板**：失败也 `setLastChanges(r.changes)`，让已写文件可见可点。
- **会话列表**：`failed` 角标（`SessionRunMark.tsx`）在可续时用「可继续」语义（文案/tooltip 区分「已失败」与「已中断可续」）。

> **原型要求**：单文件、浏览器直接打开、可真实交互，覆盖四种态 —— ① 可继续的中断卡；② 点击继续后的运行态；③ 续跑成功（新回复落在中断卡之后）；④ 续跑又失败（重新生成中断卡）。放 `tmp/agent-interrupt-proto/index.html`，**不进 git**。
>
> **原型已产出（2026-10-14）**：`E:\Projects\KnowledgeRecorder\tmp\agent-interrupt-proto\index.html`（另有 `selfcheck.mjs`，用仓内 `linkedom` 真跑一遍行内脚本，**42/42 PASS**：四种态 + 停止态 + 「对照改造前」+ 两个开关 + 主题；不含视觉/动效断言，那部分要人眼看）。
>
> **★ 遗留交互点已定（2026-10-14 落码时）**：「继续」**不进**「常显 / 跟随悬停」那组讨论 —— 它和「重新生成 / 删除 / 复制」放**同一行动作行**，因此自动继承该行既有的显隐规则（`opacity-0` → `group-hover/msg:opacity-100`）。理由：同一行里的按钮显隐方式不一致，比两者都不完美更糟；且这一行是「这条消息能做什么」的唯一去处。

### 3.7 边界与陷阱（逐条给判据）

| 边界 | 处置 |
|---|---|
| 支线旁问（`lane==='side'`） | 落中断消息（诚实反馈），**不写 carry**（不给「继续」）—— 支线职责是答一点，重问成本低（`agentService.ts:59-77` 的纪律） |
| 手册通道（`manual===true`） | 同上不写 carry（≤3 轮，重问便宜） |
| 日程助手 / AI 教学 | 都走 `runAgentLoop` → 自动获得能力；两个宿主的消息渲染复用 `MessageList`，**继续按钮自动出现**；需真机确认日程助手宿主确实用 `MessageList`（若不用，P0 只承诺助手 + AI 教学） |
| 后台完成的会话 | 沿用 `assistantRunStore` 的未读/失败分发（`:81-88`），**按会话粒度**；切回会话后中断卡与「继续」都在 |
| 连点两次「继续」 | 复用既有的「一个会话同时只有一个循环」去重（`runningSessionIds` / `activeChatSessions`，`agentService.ts:285-297`）+ claim 时先清 resume；第二次点击按钮已不存在（`pending` 态） |
| 续跑时又中断 | 重新写一份 resume（覆盖旧的），中断卡追加一条新的 —— 历史如实记录「两次中断」 |
| 用户改主意（发了新消息） | `appendAgentMessage(user)` 清 resume → 「继续」消失，中断卡**保留为历史**（不删） |
| 编辑/删除中断卡或其后的消息 | `invalidateResumeOnMutation` 清 resume（与 digest 失效同构） |
| 无仓库 / 切仓库 | resume 存在**仓库内** `.knowbase/agent/sessions.json`，天然按仓库隔离；切走再切回，「继续」仍在 |
| 会话压缩（digest）与 resume 并存 | 两者独立字段，互不改写；压缩只动 digest 检查点 |
| 中断卡的正文进历史 | 上限 600 字符（`INTERRUPT_CONTENT_CAP`），且它是一条正常 assistant 轮次，参与 `assembleAgentHistory` 的条数/token 裁剪（`:635-653`） |

### 3.8 契约与验证（A）

**契约脚本** `.AGENT/scripts/agent-resume/verify-agent-resume.mjs`（跑法 `node .AGENT/scripts/agent-resume/verify-agent-resume.mjs`，末行 PASS 且 exit=0；写法对标 `.AGENT/scripts/llm-adapters/verify-llm-protocol.mjs`，直接 `import` `agentInterruptPure.ts`）：

纯函数断言（离线）
1. `buildInterruptContent` 确定性 + 长度 ≤600；含原因、轮数、工具数、改动清单；用户停止与失败两种文案可区分。
1b. **`friendlyReason`**：§3.1 映射表逐条断言（用 §4.3 的实测原始串当 fixture）；未命中串**原样透出**（负向：不能被吞成空或「未知错误」）；`aborted=true` 时恒为「你点了停止」语义。
1d. **原因归因（§3.1b）**：① 有 `code` 时优先用 `code`，无 `code` 才回退字符串匹配（负向：`code='LLM_STREAM_FIRST_BYTE_TIMEOUT'` 时不得因原始串相同而输出「空闲卡死」）；② 零数据段与非零数据段产出**不同文案**；③ 不可归因时输出「未收到任何错误说明」而**不猜因果**（负向断言：文案里不得出现「网络不通」「服务繁忙」这类猜测词）。
1c. 中断正文里**必须出现** friendly 原因（负向：正文只写「已中断」不带原因 = 不合格 —— 这是拍板点 1 的明确要求）。
2. `buildResumeCarry`：新→旧排序；单条 ≤800；总量 ≤6000；超出丢最旧的；**幂等**（同输入两次调用字符串相等）。
3. `buildResumeInjection` 含 `RESUME_NOTICE` 与 carry；carry 为空时仍是合法注入（首轮就死的情况）。
4. `toResumeInfo` 的输出**不含** `carry` 字段（负向断言：`JSON.stringify(info).includes(carry)` 必须为 false）。

接线断言（源码文本级，防「纯函数写对了但没接上」）
5. `agentService.ts` 三个失败/停止分支都调用了 `persistInterrupt`。
5b. **异常不再静默**（§3.1b C-1）：`withAbort` 内有 `catch` 且产出 `code:'EXCEPTION'`；`useAssistantChat.ts` 的 `send` / `regenerate` / `editSubmit` 三处都有 `catch`（源码文本级断言 —— 这条最容易在重构里被悄悄删掉）。
5c. **采集是真的接了**：`llmService.ts` 的失败分支确实把「已收到数据段数 / 已产出字符数」放进返回值（不是只在纯函数里定义）。
6. `runAgentLoop` 失败分支返回结果里含 `changes`。
7. `agentSessionRepo.appendAgentMessage` 在 `role==='user'` 时清 resume。
8. `agentSessionRepo` 的 `updateMessageContent` / `deleteMessage` / `deleteMessagesAfterId` 都接了 `invalidateResumeOnMutation`。
9. `ipcMain.handle('agent:resume'` 存在且包在 `withAbort` 里；`preload/index.ts` 有对应导出。
10. `agentService.ts` 的 `agent:sessions` 出口对 resume 做了 `toResumeInfo()` 裁剪（**防止 6k carry 全量发给渲染层**）；且 `toResumeInfo` 的输出不含 `carry`（见第 4 条负向断言）。
11. `MessageList.tsx` 的「继续」按钮带 `resumeInfo.messageId === m.id` 门（负向：不能出现在别的消息上）。

端到端（§9 的人工配方 + 可选探针）
12. 用 mock SSE provider 造一次「跑到第 3 轮就断」→ 断言：会话 jsonl 里出现中断消息（含 trace）、`sessions.json` 有 resume、`agent:resume` 后**不再重复调用前 3 轮的工具**（比对 `plugin-audit.json` 的 `tool.invoke` 计数）。

---

### 3.9 落码记录（2026-10-14，批次 2 已落）

**实际落点**（与 §3.3 的差异逐条列出；本节是"当时打算怎么做 → 实际怎么做"的对账）：

| 文件 | 实际改动 |
|---|---|
| `electron/lib/agentInterruptPure.ts`（新增，**零 import**） | `buildInterruptContent` / `buildResumeCarry` / `buildResumeInjection` / `toResumeInfo` + 三个上限常数 + `RESUMABLE_NOTE` / `RESUME_NOTICE` / `SessionResume` / `ResumeInfo` |
| `electron/lib/agentSessionRepo.ts` | `SessionResume` 类型导入 + `AgentSessionRow.resume?` + `updateSessionResume()` + `invalidateResumeOnMutation()`（接编辑/删除/删其后三处）+ `appendAgentMessage` **返回消息 id** 且 `role==='user'` 时清现场 |
| `electron/lib/agentService.ts` | 中断出口 `interruptResult` 增第 6 参 `InterruptContext`（改动清单/轮数/工具数/carry/writeResume）→ 正文改由 `buildInterruptContent` 产出 + 写 `persistResume`；`interruptCtxOf()` 挂在 4 个失败/停止出口；工具执行后 `carryRows.push`；截断与预算触顶两条 `ok=true` 路径也写现场；新增 `agentResume()` + `agent:resume` handler；`sessionOut()` 裁剪会话列表出口；`runAgentLoop` 增 `resumeInjection` 入参并放行「末条是中断卡」 |
| `electron/preload/index.ts` / `src/lib/ipc.ts` / `src/types/index.ts` | `agentResume` 三处接线 + `ResumeInfo` 镜像 + `AgentSessionInfo.resumeInfo` |
| `src/components/shared/AssistantPanel/useAssistantChat.ts` | `resume()` 动作（守卫同 send）+ `resumeInfo`（只认当前会话）+ 后台结束补拉会话列表 + 三入口失败提示指向「继续」 |
| `src/components/shared/AssistantPanel/MessageList.tsx` / `ChatBody.tsx` | 动作行「继续」按钮（门 = `resumeInfo.messageId === m.id`，`Play` 图标）+ 宿主透传 |
| `src/lib/assistantRunStore.ts` / `SessionRunMark.tsx` | 口径从「失败」改成「中断」（Toast 与角标 title）：这不是失败，会话里有原因卡 |
| `.AGENT/scripts/agent-resume/verify-agent-resume.mjs`（新增） | 81 条断言（纯函数 + 负向 + 源码接线） |

**与原方案的四处偏离（以此为准）**：

1. **卡片正文的组装方式**：§3.1 原写 `buildInterruptContent(InterruptFacts)` 自己调 `friendlyReason`。实际改成**接收已算好的字符串**
   （`reason` / `advice` / `diagnostics`）—— 因为零 import 是硬要求，而文案真源必须唯一。契约用「resume 类码的建议动作
   不许出现『继续』」这条负向断言把「两处都说一遍」挡住。
2. **写现场的触发点从 3 处变成 5 处**：多出「预算触顶但总结成功」与「输出被截断」。这两种都是"没做完"，且码表里
   `resumable` 本就是 true；不给它们「继续」等于让用户重来一遍。
3. **UI 少了一行状态句**：§3.6 原想再加一行灰字 `已中断 · 12 轮 / 21 次工具调用 · 3 处改动` —— 实际这些信息已在正文里
   （`buildInterruptContent` 的进度段 + 改动清单），按铁律 12「文案只收不删」不再重复一行。
4. **`AgentChatResult` 不加 `interrupted` 字段**：`interruption` 已经是同一份信息，两个载体 = 新的漂移源。

**没做的**：§3.8 第 12 条端到端（mock SSE provider 造「第 3 轮就断」+ 比对 `tool.invoke` 计数不重复）要真机 dev + devbridge，
随归因方案 §7.2 的 13 类故障矩阵一起跑；`tmp/agent-interrupt-proto/` 是原型，不进 git。

**★ 宿主覆盖范围（与 §3.7 的原判断不同，以实测为准）**：「继续」按钮长在共用组件 `MessageList` 的动作行上，因此

| 宿主 | 渲染路径 | 本批是否有「继续」 |
|---|---|---|
| 悬浮侧栏（Ctrl+J） | `AssistantPanel` → `ChatBody` → `MessageList` | ✅ |
| 工作台右栏 AI 态 / aiChat 整页 | `ChatBody` → `MessageList` | ✅ |
| 日程助手 | `ScheduleAssistantPanel` → `ChatBody` → `MessageList` | ✅ |
| AiLearn（学堂窄版） | 直接用 `MessageList` 但未传 resume props | ❌（不传即可，零改动） |
| **AI 教学（`src/modules/ai-teaching/index.tsx`）** | **自有会话渲染（不经过 `MessageList`）**，自有 `agentChat` 调用 | ❌ **缺口** |

§3.7 原写「AI 教学复用 MessageList，继续按钮自动出现」—— 实测**不成立**：AI 教学是独立渲染 + 独立发送链路
（该文件 4400+ 行）。补它要另接 `agentResume` + 自己的运行态，且这个文件当时正被另一路改动占用 ⇒
**本批不碰它**，留作后续（用户可见影响：AI 教学里中断后要「继续」得回到通用助手会话，或等下一批补上）。

---

## 4. B 方案：流式重试与故障转移

### 4.1 落点

改动集中在 `electron/lib/llmService.ts` 的 `invokeLlmStreamInternal`（`:1218-1280`），新增纯函数模块 `electron/lib/llmRetryPure.ts`（零依赖，供契约 import）：

```ts
export type LlmFailureKind = 'aborted' | 'retryable' | 'fatal'
/** 失败分类：必须是纯函数，输入 = 错误串 + 是否超时 + 外部 signal 是否已 abort */
export function classifyLlmFailure(input: { error: string; timedOut: boolean; externalAborted: boolean }): LlmFailureKind
/** 退避表：attempt 为已失败的次数（1 起） */
export function retryDelayMs(attempt: number): number       // 1 → 1500, 2 → 4000, 其后不重试
export function shouldRetry(input: {
  attempt: number; maxAttempts: number; kind: LlmFailureKind
  producedOutput: boolean; roundElapsedMs: number; roundBudgetMs: number
}): boolean
export const MAX_ATTEMPTS = 3            // 1 次原 + 2 次重试
export const ROUND_WALL_CLOCK_MS = 150_000
export const STAGE2_PARTIAL_MAX = 200    // 阶段 2：已产出少于 200 字符才允许作废重放
```

### 4.2 B-0 前置（**必须先做，否则重试会把「用户停止」也重试**）

现状：外部 abort 与流超时都表现为 `catch (err)`，只区分了超时（`:512`/`:657`/`:863`/`:987`「流式响应超时」），外部 abort 原样抛出 → `llmService.ts:1278` 返回 `{ok:false, error:'The operation was aborted'}`，**没有 code**。

修法（三件事，都在 B 里一并做）：
1. `createStreamAbort` 暴露 `externalAborted()`（`ctrl.abort` 的来源可判，`:134-162`）。
2. `invokeLlmStreamInternal` 的错误出口统一成 `{ ok:false, code: InterruptCode, error, interruption, detail }`（**码表唯一真源已升级为归因子系统**，见 `docs/agent-error-attribution-plan.md` §2）；`req.signal?.aborted === true` 一律 `USER_ABORTED`。
3. `agentService` 的轮内失败分支（`:1062`）把 `code` 透传，渲染层按 `code === 'USER_ABORTED'` 走「已停止」而不是「调用失败」（`useAssistantChat.ts` 的三个入口分支就活了）。

> 这条顺带修掉实测审计里的 12 条误报（用户按停止 → 报「AI 调用失败」），也是 A 里「停止也可续」的前提。

### 4.3 失败分类表（用实测错误串当 fixture）

| 实测错误串（来自本机审计） | 分类 | 说明 |
|---|---|---|
| `流式响应超时（60 秒无数据）` | retryable | 首字节/空闲超时；上游未产出或少产出 |
| `net::ERR_CONNECTION_RESET` | retryable | 连接被重置（实测 3 次） |
| `net::ERR_HTTP2_PROTOCOL_ERROR` | retryable | 网关 HTTP/2 抖动（实测 1 次） |
| `net::ERR_NAME_NOT_RESOLVED` | retryable（限 1 次） | DNS 瞬时失败；别把退避预算烧在 DNS 上 |
| `The operation was aborted` + `signal.aborted` | **aborted** | 用户停止 —— **绝不重试**，立即返回 `ABORTED` |
| `The operation was aborted due to timeout`（5010ms） | 不适用 | 这是**手册通道分类器**自己的 5 秒超时（`electron/lib/manualChannel.ts:17,51`），与流式重试无关（但会混进审计，分析时需剔除） |
| `HTTP 429` / `免费模型限频中…` | retryable（长退避） | 也可直接 failover |
| `上游模型暂时不可用（5xx）` | retryable | failover 往往更划算 |
| `鉴权失败（401/403）…` | **fatal** | 换供应商也没用 |
| `接口路径不存在（404）…` | **fatal** | 配置错 |

> 现有 `isProviderLevelError`（`:1144-1147`）的正则**漏了** `net::ERR_NAME_NOT_RESOLVED` / `ERR_HTTP2_PROTOCOL_ERROR` / 以及中文的「流式响应超时」串 —— 分类函数必须覆盖这三类，否则新旧两条路径行为不一致。

### 4.4 阶段 1（建议先落）：零输出轮重放

**门槛**：`producedOutput === false`（本轮**一个** text / reasoning / tool_call delta 都没推给渲染层）+ `kind === 'retryable'` + 未超 `MAX_ATTEMPTS` + 轮内墙钟未超 `ROUND_WALL_CLOCK_MS`。

**为什么这个门槛是安全的**：本轮没有任何内容被推给渲染层，也没有 `assistantMessage` 被写进 `convo`（`agentService.ts:1079` 只在成功后 push），所以重放**不存在内容拼接/重复**问题，**零渲染协议改动**。它正好覆盖实测里最主要的两类：60004ms/60015ms 首字节超时（必然零输出）、连接重置/HTTP2 错误（多为首字节阶段）。

**覆盖不到的**：中途卡住的空闲超时（实测 98845ms 那次 = 已产出后卡死）→ 阶段 2。

**failover**：第 3 次尝试若仍未成功且 `!req.providerId && !req.modelId`（未钉死模型），按 `llmInvoke` 的既有规则（`:1199-1208`）换一个可用供应商试一次。整轮作废重放，所以**不会**出现该注释里担心的「中途切换造成内容拼接错乱」。

**每次重试的请求体逐字相同**（同一份 `messages/tools` 复用），`x-opencode-session` 会话头也复用 → prompt cache 前缀照常命中（实测 cachedTokens 常在 30-42k，这条不能丢）。

### 4.5 阶段 2（可选，覆盖「中途卡死」）：`round-reset` 事件

新增流事件（两处类型必须同步：`electron/lib/agentService.ts:211-215` 与 `src/types/index.ts:1188-1192`）：

```ts
| { kind: 'round-reset' }
```

- 主进程：决定作废重放前（`producedOutput === true` 但已产出 < `STAGE2_PARTIAL_MAX` 字符）先 `emitStream?.({ kind: 'round-reset' })`，再重放本轮。
- 渲染层 `src/lib/agentStreamCore.ts:34-57`：`round-start` 时记 `d.roundMark = d.items.length`；收到 `round-reset` 时 `items.length = roundMark`、`text = ''`、`thinking = ''`、`round` 不变。
- `src/lib/assistantRunStore.ts` 与 `useAgentStream.ts` 共用同一份 `applyStreamEvent`，改一处即两宿主一致。
- 副产物：过程时间线里那半截内容被清掉，符合「本轮作废」语义；**不动已落库的历史**（本轮还没落库）。

**风险**：已产出的部分 token 是付费的（上限 200 字符，浪费可控）；若上游是「稳定地产 100 字符后卡死」，阶段 2 会反复重试 —— 由 `MAX_ATTEMPTS` + 墙钟上限兜住。

### 4.6 观测（不静默）

1. 审计：每次尝试都落一行 `llm.invoke`（保持现状），**detail 加 `attempt` 字段**，并新增 `llm.retry` 一行 `{ from, to, attempt, error }` —— 便于日后用同一套探查脚本统计「重试救回了多少轮」。
2. 用户可见：新增流事件 `{ kind: 'retry'; attempt: number; reason: string }` → `StreamBubble` 灰字「连接中断，正在重试（1/2）…」。这条**不放进阶段 1 的硬门槛**（可以先后端重试、再补可见性），但应尽快补 —— 否则用户只看到「变慢了」。
3. trace：重试成功的那一轮，`AgentTraceStep.tokens` 等字段按最终成功那次记（现状），可在 `summary` 里附「重试 1 次」（可选）。

### 4.7 风险清单（B）

| 风险 | 判据/兜底 |
|---|---|
| 上游**系统性**首字节超时（大 prompt 被网关排队 >60s） | 重试会白等：审计若显示 `attempt` 恒等于 `MAX_ATTEMPTS` 且全部 `STREAM_TIMEOUT`，说明该做 **C（超时自适应）**，不是继续加重试 |
| 重试把「用户停止」也重放 | §4.2 前置 + 契约断言（`externalAborted → 'aborted'`，`shouldRetry` 返回 false） |
| 轮耗时被拉长（3 次 × 60s） | `ROUND_WALL_CLOCK_MS=150s` + `MAX_ATTEMPTS=3`；超限即按原逻辑失败（并落 §3 的中断记录，用户可续） |
| 429 长退避与用户体感冲突 | 429 走 failover 优先；无备用供应商则退避 1 次后失败（可续） |
| 重放打散 prompt cache | 请求体与会话头逐字复用，零改动（契约里加断言：重放必须复用同一 `sessionId`） |

### 4.8 契约与验证（B）

**契约脚本** `.AGENT/scripts/llm-adapters/verify-llm-retry.mjs`（离线，`import` `llmRetryPure.ts`）：

1. 分类表逐条断言：上面 §4.3 的 **8 条实测错误串原样**喂进去，期望分类一致（含 401/404 → fatal）。
2. `externalAborted: true` + 任意错误串 → `'aborted'`（**负向优先级最高**：即使同时 `timedOut` 也必须是 aborted，不能重试）。
3. `retryDelayMs`：1→1500、2→4000、3→0（不再重试）；`shouldRetry` 在 `attempt >= MAX_ATTEMPTS` / `producedOutput` / 墙钟超限时为 false。
4. `llmService.ts` / `agentService.ts` / `src/types/index.ts` 接线断言：`invokeLlmStreamInternal` 内的重试只包住 `adapter.chatStream`（不能包住已经 emit 过 delta 的路径）；`code:'ABORTED'` 在 abort 时被设置。
5. 阶段 2 若落：`round-reset` 在两处类型定义里都存在；`agentStreamCore.applyStreamEvent` 处理它时清空 `text/thinking` 并回退 `items`。

**端到端（可选探针）** `.AGENT/scripts/agent-resume/mock-sse-provider.mjs`：本机 127.0.0.1 的伪 OpenAI 流式端点，可编排「第 N 次请求先卡 61 秒再成功 / 直接重置连接」，配合 devbridge（`KNOWBASE_DEV_BRIDGE=1`，端口 7465；`POST /action {name:'ui.eval'}` 触发 `window` 侧 IPC + `GET /ui/screenshot`）跑真机链路。这条同时服务 A 的第 12 条断言。

---

## 5. 两包共同影响面

| 项 | 处置 |
|---|---|
| 类型门禁 | 每轮改完必跑 `npx tsc --noEmit -p tsconfig.node.json` 与 `-p tsconfig.web.json`（build 通过 ≠ 类型正确） |
| 版本号 | A 是**新功能**（用户可见新入口）→ 抬到下个 minor（3.5.0 → **3.6.0**）；B 是修复，随 A 一起进 3.6.0 即可（不给新功能发 3.5.z） |
| CHANGELOG / 应用内更新说明 | 改 `CHANGELOG.md` 段名后**必须重跑** `.AGENT/scripts/release-notes/build-release-notes.mjs`（否则页面显示上一版且无报错，铁律 24） |
| AI 手册 | 涉及用户可见行为变化（中断后能继续 / 停止不再报失败）→ 收尾提醒核查 `resources/help/常见问题.md`（建议新增一问「AI 回答到一半被中断了怎么办」）与 `resources/help/AI 权限与工具边界.md`（工具调用失败的说明口径），跑 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs` 验收 |
| 与 B-29 的关系 | B-29（`docs/pending-fixes.md:1640`，输出被 `max_tokens` 截断且无提示）**已并入归因方案的 P0**：`finish_reason` / `stop_reason` / `done_reason` 就在本方案要改的同四个循环里（`docs/agent-error-attribution-plan.md` §1.2 G5、§8），顺带收口；新码 `LLM_OUTPUT_TRUNCATED` → 卡片提示「达单次输出上限」+ 可续写 |
| 落码批次与并行冲突 | 三份方案合并为三批（归因 P0+B-0 → A 续跑 → B 重试），**文件占用与冲突纪律见** `docs/agent-error-attribution-plan.md` §11（当前另一路会话正在改代码，本批只记文档） |
| 新增设置项 | **本方案不新增**（避免再出现 `ui:false` 的隐形配置，B-29 的教训）。超时是否可配留到 C 轮 |

---

## 6. 分期建议

| 期 | 内容 | 可独立验收 |
|---|---|---|
| P0-1 | **B-0（abort 语义）+ 阶段 1 重试** | 能：停停止不再报失败；首字节超时能自愈 |
| P0-2 | **A 主进程**（纯函数 + 落库 + `agent:resume` + 契约） | 能：中断后消息在、`resume` 在、`agent:resume` 能续（先用 devbridge 触发） |
| P0-3 | **A 界面**（原型 → 继续按钮 / toast / 改动面板 / 角标） | 能：肉眼走完四种态 |
| P1 | B 阶段 2（`round-reset`）+ 重试可见 + 审计 `attempt` | 能：中途卡死也能自愈，且用户看得见 |
| P2（另议） | C / D / H（§8） | —— |

---

## 7. 决策点（已拍板 —— 结论见 §0.0，此处保留原始推荐与备选，便于日后回溯）

1. **中断卡的正文怎么来** → 推荐：**本地拼**（纯函数、零延迟、零额外 LLM 调用、不会二次失败）。备选：让模型总结一次（多一次可能失败的上游调用，且失败时没有兜底）。
2. **续跑指令是否落一条可见的用户气泡** → 推荐：**不落**（尾部一次性合成 user 消息，不渲染）。备选：落一条「继续」用户消息（历史更好读，但污染对话列表、且会占用下一轮的「最近一条」语义）。
3. **resume 的有效期** → 推荐：**下一条用户消息即失效**（现场新鲜、防止把陈旧上下文重新注入）。备选：保留到成功或手动清除（用户隔天回来还能续，但可能带着过期现场）。
4. **用户按「停止」是否也可续** → 推荐：**可续**（停止多半是嫌慢/想改方向，能接着做才不浪费已跑的 20 次工具）。备选：停止只落记录、不给续。
5. **B 的落地粒度** → 推荐：**先阶段 1（零输出重放，零协议改动）**，交付后看审计里 `attempt` 分布再决定是否上阶段 2。备选：直接上阶段 2（中途卡死也能救，但要动渲染协议、有重复内容风险）。
6. **中断记录是否进模型历史** → 推荐：**进**（它就是一条 600 字符内的正常 assistant 轮，模型下一轮能看到「上次断在哪」，这对用户手打「继续」而不点按钮的场景也有价值）。

---

## 8. 本轮明确不做（已识别，另案）

| 代号 | 内容 | 为什么本轮不做 |
|---|---|---|
| C | 首字节/空闲超时自适应（现固定 60s，`llmService.ts:127-128`，且不可配） | 用户本轮只选了 A/B；且 C 的效果要在 B 上线后用审计数据判断（见 §4.7） |
| D | run 内上下文预算（现只在发送前预估一次，`:961-979`；run 内增长无约束；口径含 system+tools ⇒ 实际从不触发） | 涉及「压缩必须幂等」的既有硬约束，且会改动已被用户调到 10 万的三个预算语义，风险面独立 |
| F | 空回复（模型返回空 content 且无工具调用 → 落一条空消息，`agentService.ts:1069` 无空判） | 一行能改，可挂到 P1；本质是「诚实反馈」小项 |
| G | `finish_reason` / `stop_reason` 透传（即 B-29 本体） | **已改判**：并入 `docs/agent-error-attribution-plan.md` 的 **P0**（拍板 2026-10-14，见该文档 §0.0 决策 4 / §1.2 G5） |
| H | 同 run 同名同参只读工具结果复用（实测可省 14.6% 调用） | 用户本轮未选；有缓存失效与写工具禁忌，需单独设计 |

---

## 9. 验收清单

**A（人工）**
1. 造一次中断（断网 / 用 mock provider / 把 `agentMaxRounds` 临时调到 2）：中断卡出现、含 trace 与「本次改动」、Toast 说「可继续」而不是「调用失败」。
2. 点「继续」：跑完任务；**用审计比对** —— 续跑轮里没有重复出现中断前已经做过的 `tool.invoke`（同名同参）。
3. 发一条新消息：中断卡还在，「继续」消失。
4. 重启应用后再点「继续」：仍可用（落盘态）。
5. 用户按「停止」：Toast 是「已停止」（**不是**「AI 调用失败」），且可续。

**A（脚本）**：§3.8 的 12 条全绿；`npx tsc --noEmit -p tsconfig.node.json` 与 `-p tsconfig.web.json` 零新增错。

**B（人工）**
6. 用 mock provider 让第 1 次请求卡 61 秒再成功：整轮**不中断**，最终回答正常；过程区出现「正在重试」提示。
7. 用 mock provider 让第 1、2 次都失败、第 3 次成功：仍完成（`MAX_ATTEMPTS` 边界）。
8. 全部失败：走 A 的中断卡（可续）。
9. 按「停止」：**不重试**，立刻停（这是 §4.2 的硬验收）。
10. 观察 `plugin-audit.json`：重试留痕（`attempt` / `llm.retry`），且同一轮的 `promptTokens` 在多次尝试间**完全一致**（证明请求体未被改动、cache 前缀未打散）。

**共同**：`CHANGELOG.md` → 重跑 `build-release-notes.mjs`；`resources/help/` 相关篇目核查；契约脚本全部跑一遍。
