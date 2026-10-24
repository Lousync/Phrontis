# 情报推荐系统方案（3.13.0 简报+埋点 / 3.14.0 画像+重排）

> **交接文档**：方向性决策已全部确认，本文是两个版本切片的实现依据。
>
> **⏸ 状态（2026-10-25）：暂缓**——推荐系统整体挂起，当前优先做 3.12.0 的「线上报纸」扩源（见 `docs/intel-module-plan.md` 修订 v2：14 内置源 + 自定义 RSS + 版面分组/头条视图）。本文保留待复用；其中「每日简报」升格预期从 3.12.x 变为 3.13.0（决策记录见文档 §0 与对话）。
>
> - **前置依赖**：v3.12.0 情报模块先落地（方案见 `E:\Projects\KnowledgeRecorder\docs\intel-module-plan.md`，另一实现线进行中）。本文所有「基建」指该方案建立的 `intelStore` / `intelPure.ts` / scheduler / 设置分区 / 文章页签 / AI 接线，**不重复其机制说明**。
> - 参考实现：`E:\Projects\KnowledgeRecorder\tmp\OpenCollector\backend\recommend\engine.py`（双通道打分语义来源，移植时保留其词边界与水平适配设计）。

## 0. 已拍板决策

| # | 决策 |
|---|---|
| D1 | 冷启动：**知识库引导 + 显式配置**——扫近 90 天笔记出 top 20 候选兴趣词，**用户勾选确认后**才建档（不静默建档）；身份/水平下拉补充 |
| D2 | 打分：**标签双通道纯函数起步**（精准匹配 + 邻接表延展）；向量作**可选增强**（设置开关，未配向量模型则置灰） |
| D3 | 版本：**3.13.0 = 每日简报 + 信号埋点**（只收集不消费）；**3.14.0 = 画像 + 信息流重排 + 反馈闭环**（守「新功能不发补丁号」规则） |
| D4 | 简报触发：**每日首次启动时生成**（启动序列 idle 后，不抢启动）+ 顶栏手动「立即生成」；不搞定点闹钟 |
| D5 | 简报选材：自上一份简报以来的新增条目（首份取近 24h），质量分 top 10，**每源至多 3 条** |
| D6 | 简报生成：LLM **一次调用**输出 ≤600 字 markdown；模型走场景路由固定用途名；未配模型/失败 → **模板降级**（功能完整不报错） |
| D7 | 埋点：`signals.json` 滚动 90 天 / 上限 5000 条截头；事件即写；停留时长在文章页签失活时结算；设置一行披露 + `intel.signals` 总开关 |
| D8 | 重排只在 feed「全部」视图生效；**探索配额**：前 30% 位次保留纯质量分序（防过滤气泡） |
| D9 | 个性化默认开；首启出披露卡（「已基于知识库完成引导」+「知道了」记忆，照 `docs/help-disclosure-pattern.md` 强引导模式） |
| D10 | 负反馈：行内「不感兴趣」（隐藏+降权）与「减少此类」（tagWeights 负更新）；设置「我的兴趣画像」卡可查/单删/清空/暂停 |
| D11 | LLM 不进每轮排序（token 成本不可控），只进简报与解释层 |

---

## 1. 3.13.0：每日简报 + 信号埋点

### 1.1 类型增量（`src/types/index.ts`）

```ts
export interface IntelDigest {
  date: string          // YYYY-MM-DD（主键，一天一份）
  itemIds: string[]     // 入选条目（点击跳文章页签用）
  md: string            // LLM 生成或模板降级的 markdown
  generatedAt: string
  model?: string        // 生成模型；模板降级为 ''
  degraded?: boolean    // true = 模板降级产物
}

export type IntelSignalEvent =
  | 'click' | 'dwell' | 'fav' | 'note' | 'openOrigin'
  | 'dislike' | 'filter' | 'airecClick' | 'digestClick'

export interface IntelSignal {
  t: string             // ISO
  e: IntelSignalEvent
  id?: string           // 条目 id（dwell/filter 无条目时省略）
  source?: IntelSourceKey
  kind?: IntelKind
  tags?: string[]       // 条目 tags 快照（学习时条目可能已 prune）
  dwellMs?: number      // 仅 dwell
  meta?: Record<string, unknown>  // filter 的 kind/kw 等
}
```

### 1.2 简报生成链（新文件 `electron/lib/intel/digest.ts`）

- `ensureTodayDigest()`：主进程启动序列挂一次（`main/index.ts` 启动完成后 `setTimeout` 8s，避开启动高峰）；当日 `digests/<date>.json` 已存在 → no-op。
- **选材**（纯函数 `pickDigestItems(items, lastDate)` 进 `intelPure.ts`，可测）：`lastDate` = digests 目录最大日期；候选 = `fetchedAt > lastDate 00:00` 的条目（无历史取近 24h）→ 质量分降序 → **每源 ≤3** → 取 top 10。
- **生成**：`llmService` 固定用途名 `'intelDigest'`（场景路由 = 设置「AI 工具 → 模型 → 哪个场景用哪个模型」，未配置跟对话默认，参照 `translate` / `vision` 先例）；prompt 输入 = 10 条精简投影（标题/源/摘要截 100 字/分数），输出约束 ≤600 字：一句导语 + 按主题分组（每组 2-3 条一句话点评）+ 结尾「今天值得多看一眼的是 X」。超时 30s。
- **降级**：未配模型 / 调用失败 / 超时 → `buildTemplateDigest()`：按源分组的纯列表（同样进 `md`，`degraded: true`）。**降级路径是简报先发的底气：零 AI 配置也完整可用。**
- 落盘 + `windowBus.broadcastDataChanged('intel')`；`intelPrune` 顺带清理 >30 天的简报。

### 1.3 IPC 与呈现

- `electron/database/repositories/intelRepo.ts` 增：`intel:getDigest(date)` / `intel:listDigests` / `intel:regenerateDigest`（手动重新生成，覆盖当日）。
- 呈现：feed 顶栏「简报」按钮（v1 的 disabled 占位）转正 → **简报子视图**（intel 模块内切换列表区，不开新页签类型）：当日简报大页 + 近 30 天历史列表；页内条目点击直开文章页签（复用 `intel-a:<id>`）；「存为笔记」复用草稿通道。

### 1.4 埋点

| 事件 | 触发点 | 携带 |
|---|---|---|
| `click` | feed 卡片点击开文章页签时 | id/source/kind/tags |
| `dwell` | 文章页签**失活**时结算（activeTab 切走 + 页签关闭两个边界，Tab 保活正好可测） | id/source/kind/tags/dwellMs |
| `fav` | 收藏成功 | id/source/kind/tags |
| `note` | 存为笔记成功（最强正信号） | 同上 |
| `openOrigin` | 打开原文 | 同上 |
| `dislike` | 3.14 的按钮，事件先记 | 同上 |
| `filter` | 应用 kind/kw 筛选时（一次性，不随渲染重复） | meta: {kind?, kw?} |
| `airecClick` / `digestClick` | 从 AI 推荐集 / 简报页点开条目 | id/... |

- 写入：`intelSignalsAppend(evts)`（intelStore 内，append 后**不广播**——不触发界面刷新）；`signals.json` 读取时滚动 90 天 + 截头 5000 条。
- 设置：`intel.signals`（toggle，默认 true）+ 一行披露「为个性化推荐收集本地行为信号（不出本机）」。
- **本版只收集不消费**：意义在 3.14 发布时用户已攒数周数据，行为学习无冷启动空窗。

### 1.5 验收（3.13.0）

- 断网 / 未配模型启动 → 模板简报照发，`degraded` 标记正确；
- 同日重复启动不重复生成；手动「重新生成」覆盖；
- dwell 两个结算边界（切走 / 关页签）都记且不重复；
- 契约脚本 `verify-intel-digest.mjs`：选材纯函数断言（每源 ≤3、top 10、增量窗口、首份 24h）。

---

## 2. 3.14.0：画像 + 重排 + 反馈闭环

### 2.1 画像（`.knowbase/modules/intel/profile.json`）

```ts
export interface IntelProfile {
  techStack: string[]   // 技术栈标签（小写）
  interests: string[]   // 兴趣标签
  identity: 'student' | 'engineer' | 'researcher' | 'freelancer'
  skillLevel: 'beginner' | 'intermediate' | 'advanced'
  tagWeights: Record<string, number>   // 行为学习权重（正负皆有）
  sources: Record<IntelSourceKey, number>
  bootstrappedAt?: string   // 知识库引导完成时间
  updatedAt: string
}
```

**引导流程**：设置「情报 › 个性化」开启 `intel.personalize` → `intelSuggestInterests()`（主进程：knowledgeIndex 近 90 天 pages → frontmatter tags 频次 + 标题分词「bigram + 停用词表，不引分词依赖」→ top 20 候选）→ **勾选确认卡** → 落 `profile.json`；提供「重新从知识库引导」。身份/水平两个下拉。主进程内部读知识索引，与 v3.12.0 的 D6（情报助手 AI 会话只读情报池）**无关**——那条管的是 AI 工具面，不是管线。

### 2.2 双通道打分（`src/lib/intelPure.ts` 增 `scorePersonalized(item, profile)`）

语义移植 engine.py，返回 `{ match, growth, total, reasons[] }`：

- **通道一·精准**：techStack 命中 ×30（带 `_tag_hit` 词边界移植——`go` 不误命中 `golang`）+ interests 命中 ×20 + 语言命中 ×10，cap 100；`tagWeights` 命中加成 `1 + w×0.1`；
- **水平适配**：beginner 遇进阶信号词（内核/编译器/…）×0.6 且 reason「内容偏进阶，可先收藏」；advanced 遇入门词 ×0.5；
- **通道二·延展**：DOMAIN_ADJACENCY 邻接表（python→llm/rust…，内容照 engine.py 本地化可扩）+ 身份阶段表（student→竞赛/毕设/论文…）每命中 ×35，cap 100；
- **融合**：`match×0.55 + growth×0.25 + quality×0.20`，权重**固定不进设置**；
- `reasons` 中文短句直接供 UI（「匹配你的技能栈：rag / vector」「延展方向：分布式」）。

### 2.3 信息流重排

- 仅「全部」视图：`scorePersonalized` 全池打分 → total 降序；**探索配额**：结果前 `ceil(n×0.3)` 个槽位插入纯质量分序条目（与已排条目去重合并）；
- 卡片分数区显示 total；reasons 挂 hover 展开行（照信息卡 hover 展开模式）；
- `intel.personalize` 关 / profile 空 → 行为与现状完全一致。

### 2.4 行为学习（`learnFromSignals(signals, profile)` 纯函数）

- 事件权重：`note=5, fav=3, dwell>30s=2, airecClick/digestClick=1.5, click=1, filter=0.5, dislike=-4`；
- 更新：`tagWeights[tag] = min(old×decay + w, 30)`（dislike 负向对称）；**周级衰减 ×0.95**（每轮 refresh 后跑一次）；sources 同法；
- 触发重算：refresh 完成后 + 打开画像卡片时。

### 2.5 负反馈

- 卡片 ⋯ 菜单：「不感兴趣」→ 条目 `hidden: true`（merge/prune 都不清）+ dislike 事件；「减少此类」→ 命中 tags 即时负更新并重排。

### 2.6 画像卡片（设置 › 情报 › 个性化）

标签云（字号 ∝ 权重，点击删除）+ 身份/水平 + 「重新从知识库引导」+「清空画像」+「暂停个性化」（= `intel.personalize` toggle）；全操作即时落盘 + Toast，无中央弹窗。

### 2.7 向量增强（`intel.semantic`，可选）

- 前置：语义索引可用（`semanticStatus()`，未配 embeddingModel → 开关置灰 + 原因提示，对齐既有降级设计）；
- 开启后每轮 refresh 末尾：质量分 **top 50** 条目摘要 → 批量 embedding（复用 `semanticIndex` 的 embeddingModel 通道）→ 存 `.knowbase/modules/intel/embeddings/<hash>.json`（含维度；模型变更作废重算，参照 `isModelMismatch` 先例）；
- 通道二分 = `max(邻接表分, 与 KB top-K chunks 的 cosine 相似度 ×100)`；KB 侧向量用现成语义索引（用户开过感知/建过索引才有——依赖关系写进设置说明与《情报.md》）；
- 成本封顶：每轮 50 条 × 1 次调用。

### 2.8 AI 联动

`INTEL_PERSONA` v2 + `buildIntelInjection` 增画像段（tagWeights 前 10 + 今日重排亮点 3 条），用户可问「为什么给我推这个」。人设仍逐字稳定（画像段进首条 user 层快照，不进 system）。

### 2.9 验收（3.14.0）

- 引导：无笔记仓库出空态卡不报错；勾选确认才建档；
- 打分：`verify-intel-recommend.mjs` 断言词边界 / 水平适配 / 融合 / 探索配额 / 学习公式幂等（同信号重放结果一致）；
- 反馈：「不感兴趣」条目消失且刷新后仍隐藏；「减少此类」立即重排；
- 向量：未配模型置灰说明；配了则通道二取 max；模型切换后旧向量作废重算。

---

## 3. 设置 keys 汇总（`src/lib/settings.ts` 增量）

| 版本 | key | 默认 | 说明 |
|---|---|---|---|
| 3.13.0 | `intel.digest` | `true` | 每日简报开关（关闭则不自动生成，按钮仍可手动） |
| 3.13.0 | `intel.signals` | `true` | 行为信号收集（含披露文案） |
| 3.14.0 | `intel.personalize` | `true` | 个性化重排总开关（= 暂停个性化） |
| 3.14.0 | `intel.semantic` | `false` | 向量增强（未配向量模型置灰） |

全部 `section: 'modules'`、进设置搜索（`ui: true` + anchor）。

## 4. 里程碑

**3.13.0**：M1 埋点（事件表 + dwell 双边界）→ M2 简报生成链（选材纯函数 / LLM / 模板降级）→ M3 简报视图 + 设置 + 收尾。
**3.14.0**：M1 画像引导（suggest 纯函数 + 勾选卡）→ M2 打分 + 重排 + 理由卡 → M3 行为学习 + 反馈 + 画像卡片 → M4 向量增强 + AI 注入 → 收尾。

## 5. 收尾清单（每版同 AGENTS 硬规则）

1. tsc 双门禁（node + web）；
2. 契约脚本（`.AGENT/scripts/intel/`）：`verify-intel-digest.mjs`（3.13）、`verify-intel-recommend.mjs`（3.14），输出禁 emoji；
3. `CHANGELOG.md` 段 + **重跑 `build-release-notes.mjs`**；
4. help 手册：《情报.md》扩节（简报 / 个性化 / 画像 / 数据均在本地），涉及 AI 工具面的改动同步《AI 权限与工具边界.md》；跑 `verify-help-retrieval.mjs`；
5. 发版链：抬版本 → CHANGELOG → rebuild notes → `npm run pack` → `publish-release.py`。

## 6. 风险与处置

| 风险 | 处置 |
|---|---|
| 简报 LLM 成本 / 失败 | 1 次/天封顶；模板降级兜底 |
| 中文标题分词质量 | bigram + 停用词表够用，不引分词依赖；引导本就有勾选确认兜底 |
| signals.json 膨胀 | 90 天滚动 + 5000 条截头 |
| 向量模型切换 / 维度变更 | 存维度、mismatch 作废重算（`isModelMismatch` 先例） |
| 过滤气泡 | 探索配额 30% + 延展通道 + 暂停开关三重保险 |
| 埋点隐私顾虑 | 纯本地 + 总开关 + 设置披露一行 |
