# 手机伴侣实时同步（长轮询）实现方案 · 同步协议 v1.7

> 状态：**方案已拍板（C 长轮询），本轮只写文档不落码**（2026-11-08）
> 背景：笔记 U 盘模式（v1.6，已落地 `07d54785`）实测两端同步触发时机太稀——手机只在「App 启动 / 自己写操作 / 手动同步」时对账，桌面端发生的一切手机都不知道。用户实测反馈：「桌面改了移动端文件，移动端不更新」（探查结论：桌面侧链路完好，手机在改动后从未再 pull，见本文 §1）。
> 协议真相源：手机仓 `docs/design.md` §2.1——**落地第一步先把 v1.7 节写进该文档**，再动两仓代码（仓规：改协议先改那边文档、再改实现、再跑契约）。
> 配套交接文档（给手机端会话）：`Phrontis-mobile/docs/handoff-realtime-sync-mobile.md`

---

## 0. 结论摘要

只做一件事：**给 pull 加 `wait` 参数，把它变成「挂起直到有变更或超时」的长轮询**；手机端配对 + 在线时维持一个挂起 pull 循环，桌面任何同步域一动，挂起的请求立即醒来返回，手机马上应用并继续挂下一发。

- 延迟 <1 秒（对比：A 方案轮询 15~30 秒）。
- **不新增端点**：还是 `POST /api/sync/pull`，只加请求字段 `wait` 与响应字段 `waitSupported`。
- 天然兼容：旧桌面不认识 `wait` → 立即返回且响应无 `waitSupported` → 手机探测到后**自动退回 30 秒定时轮询**（A 方案做兜底）。新旧两端任意组合可用。
- 电池友好：挂起的 fetch 不主动耗电，优于轮询。

不做：WebSocket / SSE（要新端点 + webview 长连管理，长轮询已到 <1s，不值）；桌面 → 手机的反向直连（手机没有服务端，协议模型不变）。

---

## 1. 实测证据（为什么桌面侧不用改检测逻辑）

2026-11-08 dev 环境实测（vault：`/home/lousync/测试仓库`）：

| 时刻 | 事件 | 证据 |
|---|---|---|
| 08:46:35 | 手机最后一次 pull | `phone-companion.json` 的 `notesStates.items['2a34…'].updatedAt` 停在此刻 |
| 08:46:49 | 桌面编辑器改 `你好.md` | 磁盘文件 frontmatter `updated` = `08:46:49.281Z`，与 mtime 一致——`writeWorkspaceFile` 写钩子正确 bump |
| 之后 | 手机再无 pull | 镜像一直停在 08:46:35 |

用设备令牌对 dev 服务发真实 pull，`changes.notes` 正确返回桌面改动 → **桌面「改动检测 → 下行变更集」完好，缺的只是手机端的拉取时机**。本方案只补「唤醒」这一环。

---

## 2. 协议增量（端点不变）

### 2.1 pull 请求

```jsonc
POST /api/sync/pull
{
  "since": { "ledger": 0, "schedule": 0, "notes": 1731045600000 },
  "wait": 25000          // v1.7 新增，可选：请求挂起上限（毫秒）。缺省/0 = 旧行为立即返回
}
```

### 2.2 pull 响应

```jsonc
{
  "ok": true,
  "changes": { "ledger": [...], "schedule": [...], "notes": [...] },
  "tombstones": [...],
  "cursor": { "ledger": ..., "schedule": ..., "notes": ... },
  "waitSupported": true   // v1.7 新增：本请求确实被挂起处理过（含「挂到超时才返回」）
}
```

### 2.3 语义（硬契约）

1. `wait > 0` 且服务端支持：请求挂起，直到 ① 任一同步域发生**变更信号**（§4）→ 立即以当前状态响应（changes 照常按 since 过滤，可能为空数组——信号是粗粒度的）；或 ② 挂满 `min(wait, 25000)` 毫秒无信号 → 返回空变更。两种情况都带 `waitSupported: true`。
2. `wait` 缺省 / 0 / 非法：立即返回（旧行为），**不带** `waitSupported` —— 手机据此探测「对端是旧桌面」。
3. 服务端实现上限 25 秒：客户端传再大也按 25000 封顶（避开一切中间层空闲超时）。
4. 同一设备并发的第二个 pull 到达：**顶掉**第一个挂起（旧挂起立即以 `waitSupported: true` + 当前状态返回）——手机引擎重试/重启时不会在服务端堆积挂起连接。
5. 挂起期间手机断开（连接关闭）：服务端清理挂起注册表，不留死等。
6. 变更信号是**通知不是数据**：醒来后照常走 since 过滤 + 各域扫描，返回什么由现有逻辑决定。信号粒度粗（任何域动一下都算）是有意的——简单、不漏；空返回的开销是一次普通 pull 往返。

### 2.4 兼容矩阵（两仓契约脚本都要锁）

| 组合 | 行为 |
|---|---|
| 新手机 + 新桌面 | 挂起循环，<1s 实时 |
| 新手机 + 旧桌面 | 首个 `wait` 请求立即返回且无 `waitSupported` → 手机退回 30s 定时轮询（对旧桌面行为与今天一致） |
| 旧手机 + 新桌面 | 手机不发 `wait` → 立即返回，完全同 v1.6 行为 |
| 任意一方离线 | 手机引擎退避重试（见 §6.3），不影响本地记录 |

---

## 3. 桌面侧实现（主仓）

### 3.1 `server.ts`

1. 挂起注册表：`const pendingPulls = new Map<deviceId, () => void>()`（resolver，调用即放行对应挂起请求）。
2. pull handler：`wait` 合法且 > 0 → 注册 resolver 后 `await Promise.race([waited(ms≤25000), signaled])`；被顶掉/唤醒/超时后从注册表摘除再响应。
3. 暴露唤醒入口：`createCompanionServer` 的返回值从裸 `Server` 换成 `{ server, pokeSync }`（或给 Server 挂属性——取侵入更小者）。`pokeSync()`：放行**全部**挂起（信号粗粒度，不做分域过滤）。
4. 响应统一带 `waitSupported: true`（仅当本请求走了挂起分支）。

### 3.2 `index.ts` 唤醒接线（信号源全清单）

| 信号源 | 接线点 |
|---|---|
| 手机 push 应用成功（ledger/schedule/notes upsert、墓碑） | `applyLedger` / `applySchedule` / `applyNote` / `applyDelete` 内 `r.applied` 后 `pokeSync()`——另一台挂起的设备要看到这笔变更 |
| **桌面自身改动**（编辑器 / AI 工具 / 用户改文件） | 监听 windowBus 既有广播：`broadcastDataChanged('accounting' | 'schedule' | 'knowledge')` → `pokeSync()`。接线点放在 index.ts（订阅 windowBus 事件），不散落到各 repo |
| pull 扫描发现桌面侧变更（`listNotesSinceUsb` 返回非空 / 记了墓碑） | 返回后 `pokeSync()`——其他设备也要看到 |
| 设备文件夹增删（树可见性变化）不需要唤醒 | 不接 |

### 3.3 不改的部分

- LWW / 墓碑 / notesState / 设备文件夹逻辑零改动（v1.6 全部复用）。
- `MAX_BODY_BYTES`、鉴权、限频不动。

### 3.4 UI（可选，低成本）

伴侣面板设备行加一个小标记：该设备当前有挂起 pull = 「实时」绿点；退回轮询 = 灰点。数据源：`companion:status` 增 `pendingPulls: string[]`（deviceId 列表）。不做也不影响功能。

---

## 4. 手机侧实现 → 见交接文档

挂起循环、`waitSupported` 探测与退回、前后台切换、写操作后的本地立即对账、退避重试——全部在手机仓，本文不展开：`Phrontis-mobile/docs/handoff-realtime-sync-mobile.md`。

---

## 5. 契约脚本（两仓都要过，仓规）

主仓 `.AGENT/scripts/phone-companion/verify-companion-protocol.mjs` 新增 §8（真 HTTP + 内存 deps，同现有做法）：

1. `wait=20000` + 无信号 → 挂起到超时，响应 `waitSupported: true` 且 changes 为空数组。
2. `wait=20000` + 300ms 后调用 `pokeSync()` → 请求在 <1s 内返回。
3. 不传 `wait` → 立即返回且**无** `waitSupported`（旧客户端兼容）。
4. 同设备第二个 pull 顶掉第一个（第一个提前返回，`waitSupported: true`）。
5. `wait` 超上限按 25000 封顶（传 999999，实测响应耗时 ≤ 26s——测试用 100ms 级小值覆盖逻辑，封顶断言走纯逻辑检查）。
6. 挂起中客户端断连 → 服务端注册表清理（下一个 pull 正常）。

手机仓 `scripts/verify-sync.mjs` 由手机侧补：`waitSupported` 探测、退回轮询状态机、挂起循环的 AbortController 重试语义。

---

## 6. 风险与边界

| 风险 | 处理 |
|---|---|
| 中间层（代理/NAT）掐空闲连接 | 服务端封顶 25s；手机侧 fetch 自带超时 + 断线退避重连 |
| webview 网络切换（Wi-Fi ↔ 蜂窝）挂死 fetch | 手机侧 AbortController + 重试退避（1s/2s/5s/…/30s 封顶） |
| 手机后台耗电 | 前后台感知：退后台暂停挂起循环（退回事件触发 + 手动），回前台立即恢复；交接文档给手机侧的硬要求 |
| 挂起连接堆积 | per-device 顶掉语义（§2.3-4）+ 断连清理（§2.3-5） |
| 桌面重启 | 手机挂起请求失败 → 退避重试，重连后自动恢复实时 |
| 信号风暴（批量导入时连续 poke） | poke 是幂等唤醒，挂起请求醒来后**重新走完整 pull**，天然合并；不需要防抖 |
| prompt/协议漂移 | 落地顺序硬性约定：design.md §2.1 v1.7 节 → 两仓实现 → 两仓契约（§5 清单） |

---

## 7. 分阶段

- **P0 协议与契约先行**：design.md §2.1 补 v1.7；主仓契约脚本 §8 用例先写（红）。
- **P1 桌面侧**：server.ts 挂起注册表 + pokeSync + index.ts 信号接线；契约转绿。
- **P2 手机侧**（按交接文档）：引擎挂起循环 + 探测退回 + 前后台；手机仓契约转绿。
- **P3 真机联调**：桌面改文件 → 手机 <1s 更新；手机改 → 桌面即时（既有 push 链路）；断网重连退避恢复；新旧 APK 混跑矩阵。

## 8. 一句话

**把「手机什么时候来问」换成「桌面一动手，挂着的问询立刻有答案」——协议只加两个可选字段，旧两端零破坏。**
