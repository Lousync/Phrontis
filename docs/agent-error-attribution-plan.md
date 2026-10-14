# AI 助手中断「错误归因」方案

> 2026-10-14 拟。**状态：决策已拍板（见 §0.0），未落码 —— 本批只记文档，改代码要等并行会话让出文件（见 §11）。**
> 定位：把 `docs/agent-interrupt-resume-plan.md` §3.1b 的那张表，升级成一个**跨层子系统** —— 让中断卡上写的「原因」**细致、准确、可行动、且说不清时敢说说不清**。
> 前置依赖：A（断点续跑）与 B（流式重试）的方案已拍板（A/B 方案 §0.0）。本方案的产出物是 A 的中断卡正文来源，也是 B 重试判据的唯一真源。

## 0.0 已拍板（2026-10-14，用户确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 原因码粒度 | **接受细粒度**（校正后共 **25 个码**，含本轮新增的 `LLM_CONNECT_TIMEOUT`；原稿误记为 22） |
| 2 | 「复制诊断信息」放哪期 | **提到 P0**（诊断块与采集同批落地，否则采到的证据用户拿不出去） |
| 3 | G7（`CONNECT_TIMEOUT_MS` 死常数） | **现在就接上**（不等 C 轮）—— 连接阶段独立判据，新增 `LLM_CONNECT_TIMEOUT` 码；接法见 §4.1 |
| 4 | B-29（输出截断无提示） | **并入本批 P0** 一起收口（`finish_reason` / `stop_reason` / `done_reason` 就在同四个循环里，见 G5） |
| 5 | 落码时机 | **先只记文档、不动代码**：另一个会话正在改代码（见 §11 文件占用与冲突纪律） |


---

## 0. 什么叫「细致 + 准确」（判据，先定标准再设计）

| 判据 | 含义 | 反例（今天的行为） |
|---|---|---|
| **可判据** | 每个原因码都由**可观测的事实**推出（HTTP 状态、上游错误体、传输层错误名、收到数据段数、计时），不靠推断 | 连接慢被说成「响应超时」 |
| **细致** | 能分开「长得像但修法不同」的原因 | 首字节超时 / 输出半途卡死共用一句话；限频 / 欠费共用 429 |
| **可行动** | 每个码带**建议动作**（继续 / 重试 / 换模型 / 查 Key / 压缩上下文 / 报 bug） | 「AI 调用失败」→ 用户不知道该干嘛 |
| **不猜** | 证据不足时写观测事实 + 已做的努力，**不给因果** | 把 5xx 写成「你的网络有问题」 |
| **跨协议一致** | 四家适配器（OpenAI 兼容 / Anthropic / Ollama / Responses）同类故障落到**同一个码** | 三家各有各的中文串 |

---

## 1. 现状矩阵与已核实缺口

### 1.1 四家适配器的失败点行为（全部实读源码）

| 失败点 | OpenAI 兼容（412-530） | Anthropic（751-869） | Ollama（580-680） | Responses（887-993） |
|---|---|---|---|---|
| 非 200（流式） | ✅ `friendlyHttpError(status, body)` 带上游原话（detail 截 **120** 字符）`440-442` | ✅ 带 `json.error.message`（截 200）`802-804` | ❌ **只抛 `HTTP ${status}`，错误体整个丢掉** `604` | ✅ `friendlyHttpError(status, body)`（detail 截 120）`916-918` |
| 流内 error 帧 | ❌ **完全不看 `json.error`** —— 循环只读 `content/reasoning_content/tool_calls/usage`（`454-494`） | ❌ **不认 `type:'error'`** —— 只认 5 种 type（`message_start/intermediate…`，`817-848`），Anthropic 的 `overloaded_error` 就此消失 | ❌ 只认 `message.content/thinking/tool_calls/prompt_eval_count/done`（`617-642`） | ✅ **已经处理** `response.failed \| error` → 抛 `976-977`（可当样板） |
| 正常结束判据 | `data === '[DONE]'` → break（`458`），**不记录「见过 [DONE]」** | `type === 'message_stop'` → break（`846`） | `json.done` → break（`642`） | `response.completed \| incomplete` → break（`972-974`），但 **`incomplete` 当正常完成** |
| 输出被截断（`finish_reason`/`stop_reason`） | ❌ 没人读 | ❌ 没人读（`message_delta.stop_reason` 就在帧里，`844-845` 只取 usage） | ❌（`done_reason`） | 半（`incomplete` 有信号但被当成功） |
| 超时 | 首字节/空闲**共用** `流式响应超时（60 秒无数据）`（`512`） | 同（`863`） | 同（`657`） | 同（`987`） |
| 连接阶段 | ❌ 无独立判据：`CONNECT_TIMEOUT_MS = 30_000`（`114`）**声明后全文件没人用 = 死常数** | 同 | 同 | 同 |

### 1.2 缺口清单（G1–G12，逐条带落点）

| # | 缺口 | 后果（用户看到的） | 落点 |
|---|---|---|---|
| G1 | OpenAI 兼容 SSE 内 `json.error` 不认 | 上游报错 → **当正常回答，内容半截** | `llmService.ts:454-494` |
| G2 | Anthropic `type:'error'`（含 `overloaded_error` 529）不认 | 同上；且这是 Anthropic 最常见的失败之一 | `llmService.ts:816-848` |
| G3 | Ollama 非 200 丢错误体 | 只看到 `HTTP 404`，**不知道是模型没拉** | `llmService.ts:604` |
| G4 | `[DONE]` / `message_stop` / `done` 是否出现过没记录 | 干净 EOF 与正常结束**同形**（B-29 §4 已记） | 四处循环 |
| G5 | `finish_reason` / `stop_reason` / `done_reason` 不读 | 输出被 `max_tokens` 截断 **无提示**（B-29 本体） | 四处循环 |
| G6 | 首字节超时 / 空闲超时同一文案 | 「分不开」——修法完全不同（继续 vs 重试） | `llmService.ts:127-128` + 四处 throw |
| G7 | `CONNECT_TIMEOUT_MS` 死常数 | 连接/DNS 慢 → 被归因成「响应超时」（**归因错位**） | `llmService.ts:114` |
| G8 | 异常逃逸完全静默 | 卡片消失、零 Toast、零记录 | `agentService.ts:1372-1388`（`withAbort` 无 catch）+ `useAssistantChat.ts:456-480`（`send` 无 catch）+ 渲染层无全局 `unhandledrejection`（只有 `src/devbridge/collector.ts:158`） |
| G9 | 供应商级错误正则漏三类 | `net::ERR_NAME_NOT_RESOLVED` / `ERR_HTTP2_PROTOCOL_ERROR` / 中文超时串**不触发 failover** | `llmService.ts:1144-1147` |
| G10 | 审计只存 error 文本 | 无法按原因统计、无法度量「归因准不准」 | `llmService.ts:1162-1188` |
| G11 | `LlmInvokeResponse.code` 只覆盖 3 个配置码 | 运行期失败**没有码**，UI 只能显示字符串 | `llmService.ts:1072-1089` |
| G12 | 渲染层只把 `r.error` 当文案 | 分类进不了 UI 语义（无法按码给按钮/建议） | `useAssistantChat.ts:470-474` |

---

## 2. 设计总览：三层

```
① 采集 RawFailure        ② 归一 Interruption              ③ 呈现
（每个 catch 点就地构造）   （纯函数，唯一真源）              （卡片/文案/按钮/审计）
─────────────────────    ──────────────────────────    ──────────────────────
http 状态 + 上游错误体      classifyLlmFailure(raw)       friendlyReason(it)
传输层错误名               → code（枚举）                 suggestedAction(it)
收到数据段数 / 已产出字符    → evidence（证据强度）          中断卡三行 + 诊断块
轮次 / token / 重试次数     → resumable / retryable        审计 code + 分布统计
```

**唯一真源原则**：`code` 只在一处产生（②），A 的卡片文案、B 的重试判定、审计统计、会话角标**全部读同一个 `code`**。今天「文案各写各的」正是归因漂移的根源。

### 2.1 数据形状（新增 `electron/lib/llmFailurePure.ts`，零依赖，供 `.mjs` 契约 import）

```ts
/** ① 采集：失败那一刻的事实（全部来自可观测量，不含推断） */
export interface RawFailure {
  /** 哪个环节出错 */
  layer: 'transport' | 'http' | 'stream-frame' | 'stream-eof' | 'agent-loop' | 'tool' | 'renderer-ipc'
  /** 传输层原始错误名（如 net::ERR_CONNECTION_RESET）或抛出的 Error.message */
  raw: string
  httpStatus?: number
  /** 上游错误体里的机器可读码（OpenAI error.code/type、Anthropic error.type、Ollama error 文本归一） */
  upstreamCode?: string
  /** 上游错误体原话（截 300，给「复制诊断信息」用） */
  upstreamMessage?: string
  /** 是否外部 signal 已 abort（用户点停止） */
  externalAborted: boolean
  /** 超时：'connect'（响应头都没回来）| 'first-byte' | 'idle'（靠下面两位判定，不靠文案） */
  timedOut?: 'connect' | 'first-byte' | 'idle'
  /** ★ 关键判据：收到过几个数据段（sa.chunk() 调用次数，llmService.ts:455 等四处） */
  receivedChunks: number
  /** ★ 已产出多少字符（content.length / text.length） */
  partialChars: number
  /** 是否见过正常结束帧（[DONE] / message_stop / done / response.completed） */
  sawTerminator: boolean
  /** 循环侧补充 */
  round?: number
  runTokens?: number
  attempts?: number
  providerId?: string
  model?: string
  elapsedMs: number
}

/** ② 归一：原因码 + 证据强度 + 建议动作（唯一真源） */
export type InterruptCode =
  // 用户/策略
  | 'USER_ABORTED' | 'AGENT_ROUND_CAP' | 'AGENT_TOKEN_BUDGET' | 'AGENT_SUMMARY_FAILED' | 'AGENT_WRITE_CAP'
  // 鉴权与额度
  | 'LLM_AUTH' | 'LLM_QUOTA_EXHAUSTED' | 'LLM_RATE_LIMIT' | 'LLM_MODEL_NOT_FOUND' | 'LLM_PROTOCOL_MISMATCH'
  // 请求本身
  | 'LLM_CONTEXT_OVERFLOW' | 'LLM_BAD_REQUEST' | 'LLM_OUTPUT_TRUNCATED'
  // 上游可用性
  | 'LLM_UPSTREAM_5XX' | 'LLM_OVERLOADED' | 'LLM_PROVIDER_ERROR_FRAME'
  // 传输
  | 'LLM_CONNECT_FAILED' | 'LLM_CONNECT_TIMEOUT' | 'LLM_NET_RESET' | 'LLM_DNS_FAILED' | 'LLM_FIRST_BYTE_TIMEOUT' | 'LLM_IDLE_TIMEOUT'
  | 'LLM_STREAM_TRUNCATED' | 'LLM_UNKNOWN'
  // 程序自身
  | 'INTERNAL_EXCEPTION'

/** 证据强度：决定「能不能写因果」——这是「不猜」的机械保障 */
export type Evidence = 'provider-body' | 'http-status' | 'transport-error' | 'timing' | 'inferred'

export interface Interruption {
  code: InterruptCode
  evidence: Evidence
  /** 可续跑？ */
  resumable: boolean
  /** 可重试？（B 的重试表直接读这里，不再各写一套正则） */
  retryable: boolean
  /** 建议动作（UI 据此出按钮/文案） */
  action: 'resume' | 'retry' | 'switch-model' | 'check-key' | 'top-up' | 'wait' | 'shrink-context' | 'new-session' | 'report-bug' | 'none'
  /** 归一码的判据来源，给「复制诊断信息」用 */
  matched: string
}

/** ② 唯一入口：纯函数、无 electron 依赖、可离线断言 */
export function classifyFailure(raw: RawFailure): Interruption
/** ③ 白话（证据不足时回落到观测式陈述，禁止因果猜测） */
export function friendlyReason(it: Interruption, raw: RawFailure): string
export function suggestedActionText(it: Interruption): string
```

### 2.2 归一优先级（判据顺序 = 防误归因的核心）

**从上往下第一条命中即为结果**；顺序本身就是正确性（例：用户停止即使同时超时也必须判 `USER_ABORTED`）：

| 序 | 判据（全部可观测） | 码 | evidence |
|---|---|---|---|
| 1 | `externalAborted === true` | `USER_ABORTED` | transport-error |
| 2 | 循环侧：轮数用尽 / token 预算触顶（含总结轮失败） | `AGENT_ROUND_CAP` / `AGENT_TOKEN_BUDGET` / `AGENT_SUMMARY_FAILED` | inferred（循环侧事实） |
| 3 | `layer === 'renderer-ipc' \|\| raw 含 'TypeError' 等且非网络串` | `INTERNAL_EXCEPTION` | transport-error |
| 4 | `httpStatus === 401 \| 403` 或 `upstreamCode ∈ {invalid_api_key, authentication_error}` | `LLM_AUTH` | http-status |
| 5 | `httpStatus === 402` 或 `upstreamCode ∈ {insufficient_quota, billing_hard_limit_reached}` | `LLM_QUOTA_EXHAUSTED` | http-status |
| 6 | `upstreamCode ∈ {context_length_exceeded}` 或 `upstreamMessage` 命中「maximum context length / too many tokens / prompt is too long」 | `LLM_CONTEXT_OVERFLOW` | provider-body |
| 7 | `httpStatus === 404` + 模型名 | `LLM_MODEL_NOT_FOUND`；协议族不符（如 `/messages` 打到 chat 端点）→ `LLM_PROTOCOL_MISMATCH` | http-status |
| 8 | `httpStatus === 429` / `upstreamCode ∈ {rate_limit_exceeded}` | `LLM_RATE_LIMIT` | http-status |
| 9 | `upstreamCode ∈ {overloaded_error}` 或 529 | `LLM_OVERLOADED` | provider-body |
| 10 | `httpStatus >= 500` | `LLM_UPSTREAM_5XX` | http-status |
| 11 | 流内 error 帧（G1/G2 补上后）且无 http 状态 | `LLM_PROVIDER_ERROR_FRAME` | provider-body |
| 12 | `raw` 命中 DNS 族（`ERR_NAME_NOT_RESOLVED` / `ENOTFOUND` / `EAI_AGAIN`） | `LLM_DNS_FAILED` | transport-error |
| 13 | `raw` 命中连接族（`ERR_CONNECTION_RESET` / `ERR_HTTP2_PROTOCOL_ERROR` / `ECONNRESET` / `socket hang up`） | `LLM_NET_RESET` | transport-error |
| 14 | `raw` 命中连接建立失败（`ERR_CONNECTION_REFUSED` / `ERR_CONNECTION_CLOSED` / `ECONNREFUSED`，且 `receivedChunks === 0`） | `LLM_CONNECT_FAILED` | transport-error |
| 14 | `timedOut === 'connect'`（判据：**响应头都没回来**，见 §4.1） | `LLM_CONNECT_TIMEOUT` | timing |
| 15 | `timedOut === 'first-byte'`（判据：`receivedChunks === 0` 但响应头已到） | `LLM_FIRST_BYTE_TIMEOUT` | timing |
| 16 | `timedOut === 'idle'`（`receivedChunks > 0`） | `LLM_IDLE_TIMEOUT` | timing |
| 17 | `sawTerminator === false` && `partialChars > 0` | `LLM_STREAM_TRUNCATED` | transport-error |
| 18 | **以上全不命中** | `LLM_UNKNOWN`（写「未收到任何错误说明」） | inferred |

**硬约束**：
- 第 1 条永不重试、永不算失败（B 的 `shouldRetry` 直接复用）；
- 第 15/16 条**只允许用「收到几段数据」判定**，不许出现「网络不通」这类因果词（`evidence === 'timing'` ⇒ 文案模板禁用因果词，契约里锁）；
- 第 18 条禁止猜测（`evidence === 'inferred'` ⇒ 只准写观测 + 已重试次数 + 建议动作）。

### 2.3 码表（含三列联动：可续 / 可重试 / 建议动作）

| 码 | 可续 | 可重试 | 建议动作 | 卡片白话（首行） |
|---|---|---|---|---|
| `USER_ABORTED` | ✅ | ✗ | resume | 你点了「停止」，本次任务停在这里 |
| `AGENT_ROUND_CAP` | ✅ | ✗ | resume | 达到本次任务轮数上限（N 轮），已就地总结 |
| `AGENT_TOKEN_BUDGET` | ✅ | ✗ | resume | 达到本次任务 token 上限（N），已就地总结 |
| `AGENT_SUMMARY_FAILED` | ✅ | ✗ | resume | 预算已耗尽，收场总结也没跑成 |
| `LLM_AUTH` | ✅ | ✗ | check-key | API Key 无效或已过期 |
| `LLM_QUOTA_EXHAUSTED` | ✅ | ✗ | top-up | 账号额度已用尽 |
| `LLM_RATE_LIMIT` | ✅ | ✅（长退避/换端点） | wait | 模型服务限频，稍后或换模型 |
| `LLM_CONTEXT_OVERFLOW` | ✅ | ✗ | shrink-context | 这轮上下文超出模型窗口（已用 N token） |
| `LLM_MODEL_NOT_FOUND` | ✅ | ✗ | switch-model | 模型不存在（检查模型列表） |
| `LLM_PROTOCOL_MISMATCH` | ✅ | ✗ | switch-model | 端点协议族不符（该模型不走这条 API） |
| `LLM_UPSTREAM_5XX` | ✅ | ✅ | retry | 模型服务返回 <码>，暂时不可用 |
| `LLM_OVERLOADED` | ✅ | ✅ | retry | 模型服务过载（<上游原话>） |
| `LLM_PROVIDER_ERROR_FRAME` | ✅ | ✅ | retry | 上游在流中报错：<原话> |
| `LLM_CONNECT_FAILED` | ✅ | ✅ | retry | 连不上模型服务（未建立连接） |
| `LLM_CONNECT_TIMEOUT` | ✅ | ✅ | retry | 连接模型服务超时（30 秒内没建立连接/没拿到响应头） |
| `LLM_NET_RESET` | ✅ | ✅ | retry | 与模型服务的连接被中断 |
| `LLM_DNS_FAILED` | ✅ | ✅（限 1 次） | retry | 域名解析失败（检查网络或代理） |
| `LLM_FIRST_BYTE_TIMEOUT` | ✅ | ✅ | retry | 等待模型响应超时（60 秒内一点数据都没回来） |
| `LLM_IDLE_TIMEOUT` | ✅ | ✅（阶段 2） | resume | 模型输出到一半卡住了（已收到 N 段后 60 秒无新数据） |
| `LLM_STREAM_TRUNCATED` | ✅ | ✅ | retry | 回答被上游中途截断（没收到结束帧） |
| `LLM_OUTPUT_TRUNCATED` | ✅ | ✗ | resume（续写） | 达到单次输出上限，回答被截断 |
| `INTERNAL_EXCEPTION` | ✅ | ✗ | report-bug | 内部异常：<错误类名>（已留完整日志） |
| `LLM_UNKNOWN` | ✅ | ✅（1 次） | retry（反复出现再考虑报 bug） | 本次任务被中断，**未收到任何错误说明** |
| `LLM_BAD_REQUEST` | ✅ | ✗ | switch-model | 上游拒绝了这次请求（参数或模型能力不符） |
| `AGENT_WRITE_CAP` | ✅ | ✗ | none | 已达本次会话写入上限，新的写入被拦下 |

> ★ 最后两行是 2026-10-14 落码时补的：`§2.1` 的枚举里有、本表原稿漏列（契约脚本按 25 个码全覆盖比对，漏一个就红）。
> ★ `LLM_UNKNOWN` 首行原文是「与模型服务的连接中断，未收到任何错误说明」—— 落码时按 §2.2 第 18 条
> 「禁止猜测、只写观测事实」改成「本次任务被中断，未收到任何错误说明」（`evidence=inferred` 不许写因果）。

> **`可续` 全为 ✅ 是刻意的**：只要有现场（trace + carry），任何中断都能「继续」。这与 A 的 `resumable` 语义一致 —— 例外只有「会话已删 / 无仓库」这类外部条件。

---

## 3. 逐适配器落点（把四家原生形状归一到同一套码）

| 适配器 | 要补什么 | 行号落点 |
|---|---|---|
| **OpenAI 兼容** | ① 循环里加 `if (json.error) throw mkFailure({layer:'stream-frame', upstreamCode: json.error.code ?? json.error.type, upstreamMessage: json.error.message, httpStatus: undefined})`；② 记 `sawTerminator`（`[DONE]` 置位）与 `receivedChunks`；③ 读 `choices[0].finish_reason === 'length'` → `LLM_OUTPUT_TRUNCATED`；④ 非 200 时把 `status` 与**未截断的上游原话（300）**一起带上（现在只有拼好的中文串） | `454-494`（循环）、`458`（[DONE]）、`440-442`（非 200）、`462-493`（帧字段） |
| **Anthropic** | ① 认 `type === 'error'`（`error.type` → 归一码：`overloaded_error`→`LLM_OVERLOADED`、`invalid_request_error`→`LLM_BAD_REQUEST`、`authentication_error`→`LLM_AUTH`、`rate_limit_error`→`LLM_RATE_LIMIT`）；② 记 `message_stop` 是否出现；③ 读 `message_delta.stop_reason === 'max_tokens'` → `LLM_OUTPUT_TRUNCATED` | `816-848`（type 分支）、`846`（message_stop）、`844-845`（message_delta） |
| **Ollama** | ① 非 200 时**读并保留错误体**（`json.error`，如 `model "x" not found`）→ `LLM_MODEL_NOT_FOUND`；② 记 `json.done` 是否出现；③ 读 `done_reason` | `604`（非 200）、`642`（done）、`617-642`（循环） |
| **Responses** | ① **保持**它已有的 `response.failed \| error` 处理（当样板，`976-977`）；② `response.incomplete` 不能再当正常完成（`972-974`）→ `LLM_OUTPUT_TRUNCATED` 或 `LLM_PROVIDER_ERROR_FRAME`（读 `incomplete_details.reason`） | `972-977` |

**跨协议归一映射（上游原生 → 本方案码）**：

| 上游原生 | 归一码 |
|---|---|
| OpenAI `error.code = 'context_length_exceeded'` | `LLM_CONTEXT_OVERFLOW` |
| OpenAI `error.type = 'insufficient_quota'` / HTTP 402 | `LLM_QUOTA_EXHAUSTED` |
| OpenAI `error.type = 'invalid_request_error'` + 模型名 | `LLM_MODEL_NOT_FOUND` |
| Anthropic `error.type = 'overloaded_error'`（529） | `LLM_OVERLOADED` |
| Anthropic `error.type = 'rate_limit_error'` | `LLM_RATE_LIMIT` |
| Anthropic `error.type = 'authentication_error'` | `LLM_AUTH` |
| Ollama `error: 'model "x" not found'` | `LLM_MODEL_NOT_FOUND` |
| Responses `response.incomplete` + `incomplete_details.reason = 'max_output_tokens'` | `LLM_OUTPUT_TRUNCATED` |
| 任一家的干净 EOF（无结束帧） | `LLM_STREAM_TRUNCATED` |

> 各家原生形状用**真机各留一份样本**进契约 fixture（今天先用 mock 编排 + 本机审计里的真实串；协议公开形状按官方文档写，遇到不一致以真机样本为准）。

---

## 4. 跨层落点

| 层 | 改什么 | 落点 |
|---|---|---|
| `llmService.ts` | ① 新增 `llmFailurePure.ts` 的采集/归一调用；② `LlmInvokeResponse` 失败分支：`code` 扩成 `InterruptCode`，并带 `detail: { httpStatus?, upstreamCode?, upstreamMessage?, receivedChunks, partialChars, sawTerminator, elapsedMs }`；③ `createStreamAbort` 暴露 `timedOutKind(): 'first-byte' \| 'idle' \| null`（首次 chunk 前超时 = first-byte）；④ `isProviderLevelError` 改为 `classifyFailure(raw).retryable`（一并修 G9：漏掉的 DNS/HTTP2/中文超时串）；⑤ 四处 `流式响应超时` 抛错改为带 `timedOutKind` 的结构化失败；⑥ 审计 `llm.invoke` 加 `code`；新增 `llm.retry`（attempt, code） | `1072-1089`、`114-162`、`454-494`、`604`、`816-848`、`972-977`、`1144-1147`、`1162-1188` |
| `agentService.ts` | ① `runAgentLoop` 三个中断出口构造 `RawFailure`（含 round/runTokens/attempts）→ `persistInterrupt`；② `withAbort` 补 `catch` → `INTERNAL_EXCEPTION`（G8）；③ 结果里回传 `interruption`；④ 渲染层出口带 `code`（已有 `AgentChatResult.code`，`254-271`） | `1062`、`1251-1278`、`1009`/`1219`、`1352-1388` |
| 会话/存储 | `SessionResume` 增加 `code` 与 `detail`（截断后的诊断块，≤800 字符）；`InterruptFacts` 读它 | `agentSessionRepo.ts`（A 方案 §3.1） |
| 渲染层 | ① 按 `code`/`action` 出按钮与文案（不再只显示字符串）；② `send/regenerate/editSubmit` 补 `catch`（G8/G12）；③ 中断卡加「复制诊断信息」 | `useAssistantChat.ts:470-474`、`MessageList.tsx` |
| 审计/观测 | 按 `code` 落审计；发布后用同一套 Python 探查脚本统计分布（`tmp/agent-interrupt-probe/*.py`） | `plugin-audit.json` |

---

### 4.1 连接超时怎么接（G7，本轮 P0 —— 已拍板）

`CONNECT_TIMEOUT_MS = 30_000`（`llmService.ts:114`）今天**声明后无人使用**。接上它时必须与流式超时**语义分明**，否则三种超时又会糊成一团：

| 阶段 | 从哪到哪 | 定时器 | 超时判据（可观测） | 码 |
|---|---|---|---|---|
| **连接** | `net.fetch(...)` 调用 → **Promise resolve（响应头到达）** | `CONNECT_TIMEOUT_MS`（30s，**用起来**） | fetch 未 resolve 即超时 | `LLM_CONNECT_TIMEOUT`；若直接抛 `ERR_CONNECTION_REFUSED` / `ERR_CONNECTION_CLOSED` → `LLM_CONNECT_FAILED` |
| **首字节** | 响应头到达 → **第一个数据帧** | `STREAM_FIRST_BYTE_MS`（60s） | 60s 内 0 帧 | `LLM_FIRST_BYTE_TIMEOUT` |
| **空闲** | 帧 → 帧 | `STREAM_IDLE_MS`（60s，每帧重置） | 60s 无帧 | `LLM_IDLE_TIMEOUT`（阶段 2 才可重试，见 B 方案 §4.5） |

**实现要点**（收口在 `createStreamAbort`，`llmService.ts:134-162`）：
1. 保留现有 `streamAbort`；**另起一个「连接期」定时器**，在 `net.fetch(...)` settle 后立刻清掉，**再** arm 首字节定时器 —— 今天是 fetch 之前就 arm 首字节（四处 `arm(STREAM_FIRST_BYTE_MS)`），所以两者混在一起。
2. `timedOutKind(): 'connect' | 'first-byte' | 'idle' | null`；超时归属由「fetch 是否已 resolve」决定，**不靠耗时猜测**。
3. `externalAborted`（用户停止）优先于任何超时（B-0）。
4. **不会误报**的情形：某些代理/网关先回 200 再长时间不出数据 → 响应头已到 ⇒ 仍归 `LLM_FIRST_BYTE_TIMEOUT`。这正是要的分辨率。
5. **不新增用户设置项**（B-29 的教训：隐形配置等于没有）；先固定 30s / 60s，靠审计观测，要放开留到 C 轮与「超时自适应」一起做。

## 5. 与 A / B / B-29 的接口（一张码表驱动三件事）

| 消费方 | 读什么 | 效果 |
|---|---|---|
| **A 中断卡** | `friendlyReason` + `suggestedActionText` + `resumable` | 卡片写清原因；`resumable` 决定「继续」按钮出不出 |
| **B 重试** | `retryable`（**唯一真源**，删掉 `isProviderLevelError` 那套正则） | 阶段 1 只对「零输出 + retryable」重放；顺带修 G9 |
| **B-29（截断）** | `LLM_OUTPUT_TRUNCATED` | `finish_reason/stop_reason/done_reason` 一读，B-29 的「断了且无提示」当场解决（G5） |
| **会话角标** | `resumable` | 「可继续 / 失败」两态（A 方案 §3.6） |
| **开发者** | 「复制诊断信息」块 | 报 bug 时一键带上 code + http + 上游原话 + 段数 + 轮次 + 模型（**不含任何正文与 Key**） |

---

## 6. 观测与验收指标（「准不准」要能量出来）

1. **未知率**：`LLM_UNKNOWN` 占全部中断的比例 —— 目标 < 15%（今天无法度量；发布后按审计统计）。超过就说明还有没认的形状 → 补映射表，别改文案。
2. **按码分布**：一张表看清主要中断是不是我们以为的那些（今天只知道 5% 失败率）。
3. **归因一致性**：同一 `code` 的卡片首行必须逐字相同（契约断言）。
4. **不猜率**：`evidence === 'timing' \| 'inferred'` 的文案里**零因果词**（契约负向断言）。

---

## 7. 验证

### 7.1 契约 `verify-llm-attribution.mjs`（离线、纯函数）

- **真实串 fixture**（本机审计原文）：`流式响应超时（60 秒无数据）`、`net::ERR_CONNECTION_RESET`、`net::ERR_HTTP2_PROTOCOL_ERROR`、`net::ERR_NAME_NOT_RESOLVED`、`The operation was aborted`（+ `externalAborted`）、`HTTP 429: …`、`免费模型限频中…`、`上游模型暂时不可用（503）…`、`鉴权失败（401）…`、`HTTP 404: 接口路径不存在…`、`HTTP 400: maximum context length is 32768 tokens`。
- 断言：① 每条 → 期望码与 `evidence`；② `externalAborted` 优先级最高（与超时同时命中仍判 `USER_ABORTED` 且 `retryable === false`）；③ `receivedChunks` 0/N → `LLM_FIRST_BYTE_TIMEOUT` / `LLM_IDLE_TIMEOUT`（同一原始串必须给出不同码）；④ 无判据 → `LLM_UNKNOWN` 且文案里**不含因果词**（负向词表：网络不通 / 服务繁忙 / 你的网络 / 服务器崩了）；⑤ 码表三列（`resumable`/`retryable`/`action`）与 §2.3 表逐行一致。
- **接线断言**（源码文本级）：四处 `[DONE]/message_stop/done` 循环都记了 `sawTerminator`；四家都读了 `finish_reason/stop_reason/done_reason`；`llmService` 的审计带了 `code`；`agentService.withAbort` 有 `catch`；渲染层三入口有 `catch`。

### 7.2 mock provider 故障矩阵（端到端，「准确」的机器判据）

`.AGENT/scripts/agent-attribution/mock-llm-provider.mjs`：本机 HTTP 服务，按 URL/计数编排下列故障；探针用 devbridge（`KNOWBASE_DEV_BRIDGE=1` / `ui.eval`）真机触发，断言**卡片上写的码 = 编排的故障**：

| # | 编排 | 期望码 |
|---|---|---|
| 1 | 首字节前挂住 61s | `LLM_FIRST_BYTE_TIMEOUT` |
| 2 | 发 3 帧后挂住 61s | `LLM_IDLE_TIMEOUT` |
| 3 | 首字节前 RST | `LLM_NET_RESET` |
| 4 | 200 后直接断（无 `[DONE]`） | `LLM_STREAM_TRUNCATED` |
| 5 | SSE 内 `{"error":{"code":"context_length_exceeded"}}` | `LLM_CONTEXT_OVERFLOW` |
| 6 | Anthropic 形状 `{"type":"error","error":{"type":"overloaded_error"}}` | `LLM_OVERLOADED` |
| 7 | HTTP 429 + `rate_limit_exceeded` | `LLM_RATE_LIMIT` |
| 8 | HTTP 402 + `insufficient_quota` | `LLM_QUOTA_EXHAUSTED` |
| 9 | HTTP 401 | `LLM_AUTH` |
| 10 | HTTP 404 + 模型名 | `LLM_MODEL_NOT_FOUND` |
| 11 | HTTP 503 | `LLM_UPSTREAM_5XX` |
| 12 | `finish_reason: 'length'` | `LLM_OUTPUT_TRUNCATED` |
| 13 | 200 + SSE 内乱码/HTTP2 协议错 | `LLM_PROVIDER_ERROR_FRAME` 或 `LLM_UNKNOWN`（择一，契约锁定） |

### 7.3 人工验收

中断卡首行能让人**不看原始串就知道该干什么**；「复制诊断信息」粘进 issue 后，开发者不需要再问用户要日志。

---

## 8. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| **P0 先说清（不改行为）** | 采集（`receivedChunks`/`partialChars`/`sawTerminator`/status/上游原话）+ `llmFailurePure.ts` + 四处 adapter 的 error 帧与结束帧 + `code` 透传 + `friendlyReason` + 中断卡接上 + `withAbort` catch（G8，A-0）+ **连接超时接上（G7，§4.1）** + **B-29 截断收口（G5）** + **「复制诊断信息」诊断块（拍板 2）** | 契约 7.1 全绿；卡片对 14 类故障都能说出码；异常不再静默；连接超时不再被误报成响应超时；输出被截断有提示且可续写；诊断块可一键复制 |
| **P1 联动** | B 的重试判定改用 `retryable`（修 G9）；建议动作出按钮；会话角标按 `resumable` | mock 矩阵 14/14；点「停止」不再重试也不再报失败 |
| **P2 能量化 + 收尾** | 审计落 `code` + 分布统计 + 未知率看板；按码反推缺失的上游形状，补映射表 | 未知率 < 15% 可测 |

---

## 9. 风险与取舍

| 风险 | 处置 |
|---|---|
| **过度归因**（把不确定说成确定） | 由 `evidence` 强度**机械限制**文案模板；`timing`/`inferred` 禁用因果词（契约负向断言） |
| 上游改词 / 换网关 | 只认**码 + status**为主、文本特征为辅；未知一律落 `LLM_UNKNOWN` 并保留原话（不静默、不硬猜） |
| 码表膨胀（**25 个码**） | 呈现层只暴露**首行 + 建议动作**，码本身进诊断块；码表进纯函数文件，改动只在一处 |
| 跨协议漂移（四家各写一套） | 归一码是唯一真源；四家只负责「原生 → RawFailure」的翻译，契约按协议各锁一份 fixture |
| 与 prompt cache 冲突 | 采集与归零改动**不影响请求体**（唯一的请求体变化是将来为截断续写加参数时，需单独评估） |
| 诊断块泄漏隐私 | 诊断块只含码/状态/上游原话/段数/轮次/模型名，**不含正文、不含 Key**（契约负向断言：不得出现 `apiKey`/`Authorization`/正文片段） |

---

## 10. 明确不做

- 不引入第三方错误码库；不新增用户可见设置项（昨天 B-29 的教训：隐形配置等于没有）。
- 不做「自动归因修复」（比如自动换模型/自动压缩并重试）—— 归因先做准，自动动作另案（会改变用户意图）。
- 不改四家的请求体与协议（除将来截断续写需要的新参数，单列）。

---

## 11. 协作与开工前置（★ 2026-10-14 现状：另一路会话正在改代码）

**本批只产出文档，不动任何代码。** 开工前必须先确认下列文件在另一路会话里已交付或已明确不碰 —— 铁律 21：**同一文件禁止并行 Edit**（并行会静默互相覆盖，而工具仍回 `Successfully edited`）。

### 11.1 本方案要动的文件 = 冲突面（★ 附 2026-10-14 实测占用）

> 实测命令：`E:\git\Git\cmd\git.exe status --porcelain`（系统 git）。下表「当前占用」= 该文件在工作区已有未提交改动（= 另一路会话正在改）。

| 文件 | 冲突风险 | 本方案要动的部分 | 当前占用（2026-10-14 实测） |
|---|---|---|---|
| `electron/lib/llmService.ts` | **高**（另一路若在改模型/网关/流式，必然撞车） | 四适配器 error 帧 / 结束帧 / `stopReason`、`createStreamAbort`、`classifyFailure` 调用、审计 | **干净** |
| `src/types/index.ts` | **高**（AGENTS.md：跨线共享汇点，多线并行前先冻结接口） | `RawFailure` / `Interruption` / `InterruptCode` / `AgentSessionInfo.resumeInfo` | **干净** |
| `electron/lib/agentService.ts` | 中 | 中断出口收口、`withAbort` catch、`agent:resume` | **干净** |
| `electron/lib/agentSessionRepo.ts`、`agentMessageStore.ts` | 中 | `SessionResume` 字段与失效规则 | **干净** |
| `src/components/shared/AssistantPanel/useAssistantChat.ts` | 中 | 三个入口 `catch`、resume 动作、toast 文案 | **干净** |
| `src/components/shared/AssistantPanel/MessageList.tsx` | **高** | 「继续」按钮、诊断块按钮 | ⚠️ **已被占用** |
| `src/components/shared/AssistantPanel/StreamBubble.tsx` | 中 | 重试可见（B 阶段 1b） | ⚠️ **已被占用** |
| `src/styles/index.css` | 低（本批不新增动效） | —— | ⚠️ **已被占用** |
| `src/lib/settings.ts` | 低（本批不动设置项） | —— | ⚠️ **已被占用**（本批不碰即可） |

另：另一路当前可见的产物是「代码块卡片」线 —— `src/components/shared/AssistantPanel/ToolSummary.tsx`（新增未跟踪）、`src/components/shared/MarkdownPreview.tsx`、`docs/code-block-card-plan.md`、`.AGENT/scripts/code-block-card/`。**它正在改的 `MessageList.tsx` 恰好是本方案批次 2 要加「继续」按钮的地方。**

### 11.2 降冲突面的三条变通（不改方案语义）

1. **诊断块先做成中断正文的一部分**（正文末尾一个 ` ```诊断 ` 围栏）：现有「复制」按钮复制的是 `m.content` 全文 ⇒ **用户今天就能导出诊断信息，零 `MessageList.tsx` 改动**；等该文件空闲再加独立的「复制诊断信息」按钮（纯增强）。
2. **批次 1 完全不碰被占用的四个文件**：只改 `llmService.ts` / `agentService.ts` / `agentSessionRepo.ts` / `useAssistantChat.ts` / `src/types/index.ts` —— 实测这些今天都干净。中断卡与调用轨迹靠**现有渲染路径**（`traceJson` → `TraceBlock`）自动出现，不需要新组件。
3. **批次 2（「继续」按钮）必须动 `MessageList.tsx`** ⇒ 排在对方交付之后；在那之前，续跑能力可用 `agent:resume` IPC + devbridge 验证（端到端可测，只是界面入口晚一步）。

### 11.3 开工前置检查（逐条打勾才动手）

1. 另一路会话确认**已交付**，或明确声明不碰 `llmService.ts` 与 `src/types/index.ts`；
2. 用系统 git 看这两个文件是否干净（`/e/git/Git/cmd/git status`）；有未提交改动 → 先问清归属，别覆盖别人的活；
3. **接口先冻结一次**：`RawFailure` / `Interruption` / `InterruptCode` 三个类型一次性落 `src/types/index.ts`，之后各方只读不改；
4. 落码顺序：纯函数文件 → `llmService.ts` → `agentService.ts` → 渲染层（前一步的类型是后一步的输入）；**单文件串行、不同文件才可并行**。

### 11.4 合并后的落码批次（与 A/B 方案对齐，避免同一段代码改三遍）

归因 P0 与 A/B 方案的 B-0、A-0 落在**同一段代码**上（都在 `llmService.ts` / `withAbort` / 渲染层错误分支），因此三份方案合并成三批：

| 批次 | 内容 | 来源 |
|---|---|---|
| **批次 1** | 归因采集与码表 + B-0（abort 语义）+ 连接超时（G7）+ 结束帧与截断（G5 = B-29）+ 诊断块 + `withAbort`/渲染层 `catch`（G8） | 本文档 §8 P0 ＋ A/B 方案 §4.2、§3.1b A-0 |
| **批次 2** | A 断点续跑（`SessionResume`、`agent:resume`、「继续」按钮、角标）—— 中断卡的**正文**已随批次 1 落地，本批只补「续跑载体 + 入口」 | A/B 方案 §3 |
| **批次 3** | B 阶段 1 重试（读 `retryable`）＋ 建议动作按钮 ＋ 重试可见 | A/B 方案 §4.4、§4.6 |

> ★ **2026-10-14 落码时的边界确认（批次 1 已落）**：中断卡的**正文**（`friendlyReason` + 建议动作 + ` ```诊断 ` 块）
> 必须与采集同批落地 —— 否则采到的证据用户拿不出去（拍板 2），「异常不再静默」也无处体现。
> 因此实际切片是：**批次 1 = 归因 P0 全量**（含「中断 assistant 消息落库」这一条正文载体），
> 批次 2 只剩「续跑载体 `SessionResume` + `agent:resume` + 「继续」按钮 + 角标」。
> 配套口径：批次 1 的建议动作文案写成「可回复「继续」让我接着往下做」（此时还没有按钮，
> 卡片不许指向不存在的入口）；批次 2 加按钮时改回按钮口径（`suggestedActionText`）。
> 另：`USER_ABORTED` 取代了旧的字面量 `'ABORTED'`（`agentService` / `assistantRunStore` / `aiActivity` /
> `useAssistantChat` 共 6 处已统一），否则「一个现象两个码」就是我们正要消灭的归因漂移。
>
> ★ **2026-10-14 批次 2 已落（断点续跑，同一 v3.5.1）**：
> 1. **新增零依赖纯函数模块** `electron/lib/agentInterruptPure.ts`：卡片正文 `buildInterruptContent`、
>    续跑 carry `buildResumeCarry`、注入 `buildResumeInjection`、出口摘要 `toResumeInfo`。
>    它**不 import 任何东西**（原因文案仍由 `llmFailurePure.friendlyReason` 算好传进来）—— 零 import 是硬要求：
>    `.mjs` 契约要用裸 node 直接 import 它，一旦有 import 就得写 `.ts` 后缀而 tsconfig 不接受。
> 2. **现场写在会话行**（`AgentSessionRow.resume`，与 `digest` 同层）：`updateSessionResume` 写回；
>    `appendAgentMessage(role==='user')` 与三处消息删改（`updateMessageContent` / `deleteMessage` / `deleteMessagesAfter`）
>    各自作废现场；`agent:sessions` 出口按 `toResumeInfo()` 裁剪（**6k 字符的 carry 绝不发渲染层**）。
> 3. **入口**：`agent:resume`（同样挂 `withAbort`）→ preload → `src/lib/ipc.ts` → `useAssistantChat.resume`
>    → `MessageList` 动作行的「继续」（门 = `resumeInfo.messageId === m.id`，与「重新生成」同排同显隐规则）。
> 4. **写现场的触发点比原方案多两处**（原方案只列了轮内失败 / 总结失败 / 用户停止）：**预算触顶的总结成功**与
>    **输出被截断**也写 —— 这两种恰恰是最该「继续」的场景（任务没做完、回答没写完），且码表里它们的
>    `resumable` 本来就是 true。
> 5. **两处口径调整（与原文档不同，以此为准）**：① `suggestedActionText('resume')` 改为**空串** ——
>    续跑指引由卡片尾句 `RESUMABLE_NOTE` 说一次，否则同一张卡说两遍「继续」；② `AgentChatResult`
>    **不新增** `interrupted` 字段 —— 批次 1 的 `interruption`（`code` / `resumable` / `action`）是同一份信息，
>    再立一个载体就是新的漂移源。
> 6. **契约** `.AGENT/scripts/agent-resume/verify-agent-resume.mjs`（81 条，含「摘要里搜不到 carry 正文」
>    「没写现场时不得提『继续』」两条负向断言）；端到端 mock 矩阵（§7.2）仍待真机跑。
