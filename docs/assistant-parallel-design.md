# AI 助手多对话并行（N-3）实现方案

> 状态：已拍板并落码（2026-10-07）。台账：`docs/v3.4.0-feedback.md` `N-3`。原型：`tmp/aichat-parallel-proto/index.html`（开发负责人已体验确认）。
> 拍板口径（2026-10-07，按原型确认）：① 最小闭环 ② 切回恢复实时流 ③ 完成走列表角标、失败才 Toast ④ 并行上限 3 路 ⑤ 写冲突不拦截 ⑥ AI 教学模块不动。

## 一、核实结论（方案的事实基础）

「切走即停」**不是真的 abort**——主进程 `activeChats = Map<chatId, AbortController>`（`electron/lib/agentService.ts:277`）每个调用独立控制器，切换会话路径上没有任何 abort 调用（全仓仅停止按钮两处）。运行一直在跑、结果照常落库。观感问题出在渲染层按「单活动会话」建模：

| 缺陷 | 位置 |
|---|---|
| 流式草稿每宿主一份、不分会话 → 切走后别家会话的流串场渲染进当前视图 | `useAgentStream.ts`（单 draft 槽）+ `MessageList.tsx`（只看 pending+draft） |
| `pending` 是整个 hook 一份 → A 运行把 B 的输入锁死（「正在回复上一条消息」Toast） | `useAssistantChat.ts:302` |
| 会话列表无运行态数据，无从转圈/角标 | 会话列表两处：`ChatBody.tsx:335`（抽屉）、`AiChatSidebar.tsx:146`（整页左栏） |
| 停止按钮 abort 的是「本 hook 最后一次发送的 chatId」，跨宿主/跨会话语义错误 | `useAssistantChat.ts:428` |

## 二、方案总览

**真源上移主进程，渲染层共享一个 store。**

1. **运行态推送**：主进程在每次 agent 调用开始/结束时 `broadcast('assistant:runstate', { running: sessionId[], ended? })`（全窗口）。`ended` 附 `{ sessionId, chatId, ok, code?, error? }`。
2. **流式事件补 sessionId**：`agent:stream` / `agent:step` 载荷加 `sessionId`，渲染层按会话分桶——切回运行中的会话即恢复实时流（拍板②）。
3. **共享 store**（新 `src/lib/assistantRunStore.ts`）：每渲染进程单例——流式草稿按 sessionId 分桶、running/unread/failed 集合、IPC 只订阅一次（失败 Toast 天然每窗口一次，不因三宿主三实例重复）。三宿主（悬浮侧栏 / 右栏 AI 态 / aiChat 整页）读写同一份。
4. **会话级 pending**：`send/regenerate/editSubmit` 的占锁从全局布尔改为「目标会话是否在跑」；另加并行上限检查（拍板④，上限 3，含 AI 教学占用——都是同一 API key 的真实开销；AI 教学自身入口不动，拍板⑥）。
5. **停止按会话**：新增 `agent:abortSession(sessionId)`，abort 该会话全部在跑调用；停止按钮改走它。
6. **纯函数下沉**：draft 应用逻辑（`applyStreamEvent`/`completeTool` 等）从 `useAgentStream.ts` 抽到新 `src/lib/agentStreamCore.ts`，新旧两条订阅链共用；`useAgentStream(chatIdRef)` 签名与行为不变（AiLearn / AI 教学侧栏继续用，拍板⑥）。

## 三、逐文件改动

| 文件 | 改动 |
|---|---|
| `electron/main/windowBus.ts` | `BROADCAST_CHANNEL` 加 `assistantRunState: 'assistant:runstate'` |
| `electron/lib/agentService.ts` | `withAbort` 增 `sessionId` 形参：维护 chatId→sessionId 映射；开始/结束广播 runstate；`agent:step`/`agent:stream` 载荷补 `sessionId`；新增 `agent:abortSession` handler；各 `ipcMain.handle` 传 `req.sessionId` |
| `electron/preload/index.ts` | 暴露 `onAssistantRunState` / `agentAbortSession`；step/stream 监听载荷类型补 sessionId |
| `src/types/index.ts` | 桥面加 `agentAbortSession` / `onAssistantRunState`；新增 `AgentRunStateEvent`；step/stream 载荷类型补 sessionId |
| `src/lib/ipc.ts` | 对应包装函数 |
| `src/lib/agentStreamCore.ts`（新） | `StreamDraft`/`ProcessItem` 类型 + `createDraft`/`applyStreamEvent`/`completeTool` 纯函数（自 useAgentStream 迁入，逻辑零改动） |
| `src/lib/assistantRunStore.ts`（新） | 共享单例：buckets / runningIds / unreadIds / failedIds / viewedIds；60ms 节流 notify；单次 IPC 订阅；`ended` 分发（后台完成→unread 角标，失败→Toast+failed，ABORTED→静默）；`MAX_PARALLEL=3` |
| `src/components/shared/AssistantPanel/useAgentStream.ts` | 纯函数迁出后改为从 core 导入并 re-export 类型；对外签名/行为不变 |
| `useAssistantChat.ts` | 占锁改会话级 + 上限检查 + `store.begin/end` 生命周期 + `abort`→`agentAbortSession(activeId)` + `loadSession` 标记已读 + 暴露 `runStateOf(sid)` 供列表 + `pending/draft/liveSteps` 语义改为「当前激活会话的」 |
| `ChatBody.tsx` | 抽屉会话列表项加状态标记（转圈/蓝点/红!）；其余零改动（controller 形状不变） |
| `AiChatSidebar.tsx` | 同上（整页左栏列表项） |
| `src/styles/index.css` | 新增 `.kb-spin` 连续旋转令牌（transform-only + prefers-reduced-motion 降速） |
| `docs/ui-animation-plan.md` | 补 `.kb-spin` 令牌登记（铁律 13：先补基建再落码） |

## 四、行为明细

- **发送/重生成/编辑提交**：目标会话在跑 → Toast「本对话正在回复中」；全进程并行数 ≥3 → Toast「已有 3 个对话在运行」；否则 `store.begin(sid)`（乐观置 running + 建空桶）→ await → finally `store.end(sid)`。
- **结束分发（主进程 ended，store 单订阅处理）**：`ok` → 非查看中会话亮蓝点（unread）；`ok=false && code!=='ABORTED'` → 红色 failed 标记 + 失败 Toast（每窗口一次）；`ABORTED` → 静默。查看中 = 任一宿主 activeId 指向该会话（store.viewedIds）。
- **点进会话**（loadSession）：清该会话 unread/failed，登记 viewed；切走撤销 viewed。
- **后台完成时正在看它（跨宿主）**：hook 订阅 ended，若 `ended.sessionId === activeId` 则补一次 `refreshMessages`（该宿主不是发起方、没有 finally 兜底）。
- **列表标记优先级**：running（转圈）> failed（红!）> unread（蓝点）。
- **MessageList/composer**：`pending`/`draft`/`liveSteps` 由「hook 级」变「激活会话级」，下游组件形状不变。

## 五、边界与已知取舍

- **多窗口**：runstate 广播全窗口；流式增量仍只发发起窗口（既有设计，与同类产品一致）。窗口间 unread/failed 各自独立。
- **上限计数含 AI 教学**：cap 只在助手入口检查，但计数含教学会话的在跑数（同一 API key 的真实并发）；教学自身入口不检查（拍板⑥）。
- **写冲突**：不拦截，后写覆盖 + 审计可查（拍板⑤）；台账留档，真撞车再做互斥。
- **跨宿主 unread 一致性**：同窗口内一致（共享 store）；跨窗口独立（可接受）。
- **旧契约兼容**：`verify-aichat-f7-f8.mjs`（F-7/F-8）、`verify-manual-channel.mjs` 等断言的接线不改动；跑全量回归确认。

## 六、验证

1. 契约脚本 `.AGENT/scripts/ai-assistant/verify-assistant-parallel.mjs`：主进程推送/载荷/abortSession 静态断言 + store 单订阅与分桶 + hook 会话级占锁与上限 + 两处列表标记 + `.kb-spin` 令牌 + useAgentStream 兼容。
2. 既有契约回归：`verify-aichat-f7-f8.mjs`、`verify-manual-channel.mjs`、`verify-assistant-constraints.mjs`。
3. `npx tsc --noEmit -p tsconfig.node.json` / `-p tsconfig.web.json`。
4. 手动（需重启 dev，主进程无热重载）：双会话交替发送互不占锁；切走后台跑完亮蓝点；失败弹 Toast；第 4 路被拦；停止按钮停当前会话。
