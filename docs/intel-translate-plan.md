# 情报卡片英文自动翻译（intel translate）实现方案

> **交接文档**：三个关键决策已于 2026-10-25 与用户确认，本文档是唯一实现依据，不再重开范围讨论。
>
> - 实现落 **`feature/v3.13.0`** 工作树（`E:\Projects\KnowledgeRecorder-intel`），排在报纸化 v2（`docs/intel-module-plan.md`）之后、同版本发布。
> - 关联：模块总方案 `docs/intel-module-plan.md`；本文件只管翻译这一条线。
> - 一句话目标：**英文卡片读得懂、刷新和列表永远不等翻译、同一文本终身只译一次。**

## 0. 已拍板决策（确认过，实现时不再询问）

| # | 决策 |
|---|---|
| TD1 | **引擎 = 用户已配置的 LLM**，走 `invokeLlmInternal`（`electron/lib/llmService.ts:1924`），不引入免费翻译接口（Google 非官方端点依赖加速器、随时失效——GitHub 源的代理坑刚验证过）。免费引擎降级留待以后。 |
| TD2 | **范围 = 卡片级**：只译 feed 卡片上展示的文本——标题 + summary（`FeedCard`，`src/modules/intel/index.tsx:340-343`）。**文章页/正文一律不译**（用户明确：进浏览器用浏览器翻译）。 |
| TD3 | **呈现 = 双语同屏**：原文在上、简体中文灰字副行在下（标题译副行 + 摘要译副行），不提供"只显中文"切换。 |
| TD4 | **缓存复用 `translationRepo`**（`.knowbase/modules/translation/cache.json`）：新 `mode: 'plain'`，key = `plain:<sha1(text)>` 内容寻址——同文本跨条目、跨刷新、跨会话零 token 复用。不新建 intel 专属缓存文件。 |
| TD5 | **触发 = 预热 + 可见即译**：刷新完成后 idle 预热 top-24 英文条目的标题（一批）；卡片滚入视口时译该卡（标题 + summary）。全文预热不做。 |
| TD6 | **设置只加两项**：`intel.translateOn`（总开关）、`intel.translateBudget`（会话条数上限）。**不加模型选择项**——模型解析复用 B4 内联建议的「默认链命中思考型 → 降级到同供应商第一个非思考模型」判据（`resolveInlineSuggestFallback`，`llmService.ts:1342`；翻译与"续写一句"同一痛点：不需要思考链）。 |

## 1. 总原则：不卡的三条硬约束

1. **翻译永远不在关键路径上**——刷新不等它、列表首屏不等它、点开文章不等它。译文是"后到的一行灰字"。
2. **高度预留**：翻译副行渲染前就占住一行高度（「译…」占位），到位后内容淡入（`.kb-view-in`）；标题译行 `line-clamp-2`，绝大多数一行落定，卡片高度基本不跳。
3. **静默降级**：失败不弹窗、不 toast 刷屏；LLM 未配置 / 预算耗尽 → 渲染层本会话熔断（不再发请求），仅在首次触发时 toast 一次并带设置指引。

## 2. 数据与缓存

**不改 `intel.json` 的存储形态**。`IntelItem` 增加两个**运行时合并字段**（类型加在 `src/types/index.ts`，注释注明不落盘）：

```ts
export interface IntelItem {
  // …现有字段不变…
  /** 运行时合并自翻译缓存（translationRepo，mode 'plain'），不落 intel.json */
  titleZh?: string
  summaryZh?: string
}
```

- 读取侧合并：`intelStore` 的 `readIntel()`（返回 `{ items, meta }` 处）对每条 item 查 `getTranslationCache('plain:' + sha1(title))` / `('plain:' + sha1(summary))`，命中则挂 `titleZh` / `summaryZh`。整表一次性读入内存后 map，不做逐条 IO。
- 写入侧：每批翻译完成 → `upsertTranslationCache(key, 'plain', 原文, 译文, model)` → `windowBus.broadcastDataChanged('intel')`；连续多批时 400ms 合并广播一次（防止列表反复 refetch 抖动）。
- **不做 GC**：内容寻址缓存不随条目清理，与划词缓存同策略（一条 ≈ 300–800B，三千条 < 2.5MB，体量可控）。

## 3. 翻译管线（新文件 `electron/lib/intel/translate.ts`）

纯函数与 LLM 调用都在这里；编排（读 items、合并缓存）在 `intelStore`，保持数据所有权不动。

### 3.1 英文检测

```ts
export function isEnglishText(s: string): boolean {
  const t = s.trim()
  if (t.length < 2) return false
  const cjk = (t.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length
  const latin = (t.match(/[A-Za-z]/g) ?? []).length
  return latin >= 6 && cjk / Math.max(cjk + latin, 1) < 0.25
}
```

中文源（qbitai / weekly / 六个新闻源 / 中文自定义 RSS）自动跳过，零 token。

### 3.2 批量 prompt（标题与摘要分开走）

- `TITLE_SYSTEM`：输入 JSON 字符串数组（英文科技/新闻标题），输出**等长**简体中文翻译数组。规则：产品名/公司名/人名/型号/库名保留英文原文（GitHub、GPT-5、LangChain…）；数字与单位不变；简洁新闻标题体；不输出数组以外的任何内容。
- `SUMMARY_SYSTEM`：同理，摘要体——一段连贯中文，信息量 ≤ 原文，不添油加醋，专有名词规则同上。
- user 内容就是 `JSON.stringify(texts)`。
- 调用参数：`effort: 'off'`、`sessionId: 'intel-translate'`（固定用途名，口径照 `translateService.ts:98`）、`maxTokens` 显式传（内部调用方专用通道）：标题批 `40 × n + 120`，摘要批 `3200`。`accounting` 走默认 `'auto'`（记入 ai-usage.json，用量面板可见）。
- 批大小：**标题批 ≤ 20 条 / 摘要批 ≤ 4 条**；单并发（模块内 promise 链排队）。

### 3.3 解析与失败

- 去 code fence → `JSON.parse` → 校验 `Array.isArray && length === n`；不齐 = 整批失败。
- 失败处理：同批重试一次（user 追加「仅输出 JSON 数组，不要任何其他文字」）；再失败 → 本批文本记入会话内 `failedKeys`（`Map<key, fails>`），`fails ≥ 2` 的 key 本会话不再自动重试。**失败不写缓存**。
- 命中缓存的文本直接跳过，不发 LLM。

### 3.4 预算

- 会话内计数器（主进程模块级，随 app 生命周期）：每成功译 1 个 text 计 1。
- `intel.translateBudget`（默认 300）：耗尽 → 所有入口返回 `{ disabled: true, reason: 'budget' }`，渲染层熔断。

## 4. 触发链路

### 4.1 预热（刷新完成后）

`intelStore.intelRefresh()` 成功收尾后 fire-and-forget：按 score 取 top-24 英文条目的**标题**（一批）→ 翻译 → upsert → 广播。`intel.translateOn` 为 false 或预算耗尽则跳过。效果：刷新完回到列表，首屏译题基本已就位。

### 4.2 可见即译（渲染层驱动）

- 列表容器上 `IntersectionObserver`（`rootMargin: '200px'`，`threshold: 0`）：进入视口且无 `titleZh` 的卡片 → 收集 id，600ms 防抖合并去重 → `window.api.intelTranslate(ids)`。
- IPC `intel:translate(ids)` **await 全流程**（去缓存 → 检测 → 批量 LLM → upsert → 广播），返回统计：

```ts
export interface IntelTranslateResult {
  translated: number   // 本次新译
  cachedHit: number    // 缓存复用
  skippedChinese: number
  failed: number
  disabled?: true      // translateOn 关 / 无默认模型 / 预算耗尽
  reason?: 'off' | 'noModel' | 'budget'
}
```

- 渲染层收到响应：清除对应卡片的「译…」占位；`disabled` 则本会话熔断（不再观察请求），首次 toast 一次（「卡片翻译已停用：<原因>」+ detail 指到 设置 › 模块 › 情报）。
- 中文条目在主进程侧判跳（渲染层不判断），会话内 `skippedIds` 记忆，重复滚入不重复请求。

## 5. 渲染层（`src/modules/intel/index.tsx`）

`FeedCard` 双语结构（挂在现有 340-343 行处）：

```tsx
<div className="mb-1 text-[13.5px] font-semibold leading-[1.45] …">{item.title}</div>
{item.titleZh && <div className="kb-view-in mb-1 line-clamp-2 text-[12px] leading-[1.55] text-[var(--text-muted)]">{item.titleZh}</div>}
{item.summary && <div className="line-clamp-2 text-[12px] leading-[1.55] text-[var(--text-secondary)]">{item.summary}</div>}
{item.summaryZh && <div className="kb-view-in line-clamp-2 text-[12px] leading-[1.55] text-[var(--text-muted)]">{item.summaryZh}</div>}
```

- 占位：`pendingIds.has(item.id) && !item.titleZh` 时，标题下渲染一行 `text-[var(--text-muted)] opacity-60` 的「译…」（占住高度，到位后整行被 `titleZh` 替换并 `.kb-view-in` 淡入）。
- 观察标记：卡片根节点加 `data-intel-id={item.id}`，有 `titleZh` 的卡加 `data-zh="1"`，observer 只盯没有的。
- 头条视图 hero 直接读合并后的 `titleZh`，无需单独逻辑。
- `intel.translateOn` 为 false：不挂 observer、不渲染占位（纯原文，零开销）。

## 6. 接线清单（文件级）

| 文件 | 改动 |
|---|---|
| `electron/lib/intel/translate.ts` | **新建**：`isEnglishText` / `translateTextsBatch`（标题批、摘要批）/ 会话队列与预算 / `failedKeys` / `skippedIds` |
| `electron/lib/intel/intelStore.ts` | `readIntel` 合并 `titleZh`/`summaryZh`；新增 `intelTranslateItems(ids)` 编排；refresh 收尾接预热 |
| `electron/database/repositories/translationRepo.ts` | **零改动**（复用 `getTranslationCache` / `upsertTranslationCache`，mode `'plain'`） |
| `electron/database/repositories/intelRepo.ts` | 注册 `intel:translate` |
| `electron/preload/index.ts` | `intelTranslate: (ids: string[]) => ipcRenderer.invoke('intel:translate', ids)` |
| `src/lib/ipc.ts` | `intelTranslate` 封装 |
| `src/types/index.ts` | `IntelItem.titleZh?/summaryZh?` + `IntelTranslateResult` + api 声明 |
| `src/lib/settings.ts` | `intel.translateOn`（toggle，默认 true）、`intel.translateBudget`（number，默认 300，min 50 max 2000 step 50，unit 条） |
| `src/modules/intel/index.tsx` | `FeedCard` 双语副行 + 占位 + `IntersectionObserver` + 熔断态 |

设置两项进现有「设置 › 模块 › 情报」分区（`SETTINGS` ui: true + anchor，自动渲染）。

## 7. 失败矩阵

| 场景 | 行为 |
|---|---|
| LLM 未配置 / 供应商禁用 | `disabled: 'noModel'` → toast 一次 + 会话熔断，卡片保持纯原文 |
| 网络失败 / 上游报错 | 批失败 → 会话内 `failedKeys` 退避；占位行消失回纯原文，无提示 |
| JSON 解析失败 | 重试一次 → 仍失败按上条处理 |
| 预算耗尽 | `disabled: 'budget'` → 会话熔断；已译内容不受影响 |
| 中文条目 | 静默跳过（`skippedChinese` 计数） |
| 原文变更（同 id 新摘要） | 内容寻址天然失效 → 新 key 重译，旧缓存自然孤儿化 |

## 8. 验收清单

- [ ] tsc 双门禁（`tsconfig.node.json` / `tsconfig.web.json`）通过。
- [ ] 契约脚本：`isEnglishText` 用例表（纯英文 / 中英混合 / 纯中文 / 短串）+ 解析函数幂等（合法数组、带 fence、长度不齐、非 JSON）——放 `.AGENT/scripts/intel-translate/verify-translate-pure.mjs`，import 纯函数直接断言。
- [ ] 关掉加速器 + 开着加速器各刷一轮：英文卡译题 3s 内陆续淡入，中文卡零请求（主进程日志核对）。
- [ ] 同一批卡片二次进入视口：`cachedHit` 全命中，无新 LLM 调用。
- [ ] `intel.translateOn` 关闭：无占位、无请求；预热跳过。
- [ ] `intel.translateBudget` 调到 50 后狂滚列表：到量熔断，toast 一次。
- [ ] 收尾提醒同步 `resources/help/` 情报篇（翻译开关与预算的说明）。

## 9. 明确不做（用户已拍板或本期排除）

- **文章页 / 正文翻译**——用户明确用浏览器翻译兜底，不做应用内双语正文。
- 免费 MT 引擎降级通道（Google/DeepL）——留待以后，本期单引擎。
- 翻译模型选择设置项——跟随默认链 + 思考型自动降级（TD6）。
- 悬停即译、按需手动「译」按钮——自动覆盖了就不需要。
