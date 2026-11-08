# AI 教学长资料读取与按章整理实现方案

> 状态：方案已拍板（§16 五项 2026-11-08 确认），待实现
> 范围：AI 教学（`source='aiTeaching'`）的素材转写、长资料自动检测、分页读取、按章笔记
> 关联文档：`docs/ai-teaching-simplify-plan.md`、`docs/ai-teaching-course-mode-plan.md`、`docs/ai-teaching-module-rework.md`

---

## 0. 结论摘要

只做三件事：

1. **AI 教学侧的素材统一先转 Markdown**：PDF / PPTX / Word 先提取成 md；扫描件单独标记，经用户确认后再视觉转写。AI 不直接读 PDF/Word 原件。
2. **长资料自动检测，自动切 1M 档**：按素材总页数 / 字符数自动判断；命中后提高单条结果上限、读取窗口、最近结果预算、轮数、写入次数与 token 预算。不做手动开关，界面只显示 badge。
3. **按章提取、按章读、一章一笔记**：以课程大纲的“章”为单位，先提取本章 md，再分页读，读完立刻写一个笔记；不合并成整本长文档。

不做：

- 不做专门的“教材整理”工作流 / 向导 / 新工具集；
- 不自动视觉转写扫描件（必须先确认）；
- 不把整本书塞进一次工具结果；
- 不改变 Vault 的“Markdown + JSON”真相源模型。

关键数字（1M profile）：单条工具结果 120k 字符、最近结果预算 40 万字符、`vault.read` 单次 100k 字符、历史上下文 200k token、最大 48 轮、token 预算 10M、单条消息写入上限 300。

---

## 1. 背景与目标

### 1.1 问题

用户用 1M 上下文模型做 AI 教学，希望 AI 能整理整本教材、按章产出笔记。当前链路的实际表现是：

- AI 只能读到文件开头。`vault.read` 文本默认 8000 字符、上限 50000；PDF/PPTX 默认 12000、上限 50000；没有 offset / 页码续读参数。
- 读到 3 万字符时反而只剩 4 千字符。`MAX_TOOL_RESULT_CHARS=24000` 会把整个结果替换成 4000 字符预览，并提示“降低 maxChars”。
- 多文件任务丢前面内容。`KEEP_RECENT_TOOL_RESULTS=3`，而并行批是 4；一次并行读 4 个文件，第 1 个在下一轮就被压缩。
- PDF 提取有 200 页硬上限，而且不告诉 AI。`extractPdfRange()` 单次最多 200 页，`extractSource()` 用它处理 `to=9999`，结果是一份不完整的提取稿。
- 一个素材只能记一个提取稿。`SourceEntry.extractRel` 是单值，按章提取时后一章覆盖前一章的指针，章节与提取稿错配。
- 扫描件没有结构化状态。文本层为空时只得到“（本页无可提取文本）”，AI 容易把空页当成已读。
- 发现类工具有静默封顶。`vault.list` 200 条、`vault.search` 50 命中 / 400 文件 / 1MB，`total` 是返回数而不是真实总数。

### 1.2 目标

- 一本 300～600 页的教材，AI 能在一次任务内完成：清点 → 按章提取 md → 分章阅读 → 一章一笔记 → 覆盖校验。
- AI 任何时候都知道自己读了多少、还剩多少；所有截断都可续读。
- 1M 模型自动获得更大的读取与任务预算；小上下文模型不被自动放大拖垮。
- 扫描件不被静默跳过；用户确认后才开始视觉转写。
- 笔记落点由用户指定，不默认写入课程目录或知识库。

### 1.3 非目标

- 不做教材整理专用工作流、专用 skill、专用工具族。
- 不新增 OCR 引擎；扫描件沿用现有视觉转写（12 页/批）。
- 不改 AI 教学以外的会话策略（通用 AI 对话只共享 `vault.read` / 结果治理能力）。
- 不做云端解析；全部本地完成。

---

## 2. 现状与缺口

### 2.1 已有链路

```
course.sources.register
  → course.sources.assign（章级 anchor）
  → course.sources.extract（PDF/PPTX/Word/code 区间 → md 提取稿）
  → vault.read（AI 读提取稿）
  → course.organize.archive / knowledge.create-page / vault.write（落笔记）
```

相关实现：

| 能力 | 位置 |
|---|---|
| 素材注册表 / 提取 / 索引 / 注入数据 | `/home/lousync/Projects/Phrontis/electron/lib/aiTeachingSourceRegistry.ts` |
| 旧素材函数 / 视觉转写 / LibreOffice 转换 | `/home/lousync/Projects/Phrontis/electron/lib/aiTeachingSources.ts` |
| PDF / PPTX 文本提取 | `/home/lousync/Projects/Phrontis/electron/lib/docsReader.ts` |
| 课程注入 / 素材提示 / 清点 | `/home/lousync/Projects/Phrontis/electron/lib/aiTeachingCourse.ts` |
| `course.sources.*` 工具 | `/home/lousync/Projects/Phrontis/electron/lib/builtinTools.ts` |
| Agent 循环 / 工具结果治理 | `/home/lousync/Projects/Phrontis/electron/lib/agentService.ts` |
| 循环预算默认值 | `/home/lousync/Projects/Phrontis/electron/lib/agentLoopPolicy.ts` |
| 设置项 | `/home/lousync/Projects/Phrontis/src/lib/settings.ts` |
| 共享素材类型 | `/home/lousync/Projects/Phrontis/src/lib/aiTeachingSourcesPure.ts` |

### 2.2 缺口清单

| # | 缺口 | 位置 | 影响 |
|---|---|---|---|
| G1 | 单条工具结果超 24k 整包换成 4k 预览 | `agentService.ts:136-158`、`:1660` | 3 万字文档反而只看到 4 千字；提示方向错误 |
| G2 | 读工具无 offset / 页码 | `builtinTools.ts:2079`、`:2108`、`:2130` | 只能读开头，无法续读 |
| G3 | PDF 单次最多 200 页且静默 | `docsReader.ts:22`、`:64`；`aiTeachingSourceRegistry.ts:725-755` | 600 页教材只提取前 200 页，AI 以为读完 |
| G4 | 一个素材只记一个 `extractRel` | `aiTeachingSourcesPure.ts:45`；`aiTeachingSourceRegistry.ts:748`、`:839` | 按章提取时章节与提取稿错配 |
| G5 | 最近结果只保留 3 条 | `agentService.ts:140`、`:204-216` | 并行读 4 个文件，第 1 个立即被压缩 |
| G6 | 发现类工具静默封顶 | `builtinTools.ts:209-212`、`:2055`、`:2163`、`:2186` | 大仓库搜不全、列不全，模型不知道 |
| G7 | 扫描件只写空占位 | `aiTeachingSourceRegistry.ts:735`、`:745` | AI 把空页当已读，开始编内容 |
| G8 | `vault.read` 10MB 预检挡在文档分派前 | `builtinTools.ts:2105` | PDF/PPTX >10MB 被拒，尽管 `docsReader` 允许 80MB |
| G9 | 搜索跳过 >1MB 文件 | `builtinTools.ts:210` | 中文教材约 1.8MB，搜索会静默跳过 |
| G10 | Word 依赖 LibreOffice，失败信息不结构化 | `aiTeachingSources.ts` 的 `convertToPdf` | 用户不知道是没装 soffice 还是转换失败 |

### 2.3 两个必须先修的“静默错误”

**（一）200 页不是整本**

`extractSource()` 调用 `extractPdfRange(docAbs, rg.from, rg.to)`；`extractPdfPages()` 内部：

```ts
const end = Math.min(to ?? total, total, start + MAX_PDF_PAGES - 1)
```

即使传 `to=9999`，也只返回前 200 页；`realTo` 写 200，提取稿命名为 `p1-200.md`，`extractRel` 指向它。没有 `hasMore`、没有总页数提示，AI 会认为整本已提取。

**（二）`extractRel` 是单值**

按章提取时：

```
第 1 章 → 教材-p1-40.md，src.extractRel = 教材-p1-40.md
第 2 章 → 教材-p41-80.md，src.extractRel = 教材-p41-80.md
```

`resolveSegmentSources()` 给每一章都返回 `src.extractRel`，于是第 1 章的提示指向第 2 章的提取稿。必须改成“区间 → 提取稿”的映射。

---

## 3. 设计决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | **Markdown first** | AI 教学侧只读 md 提取稿；PDF/PPTX/Word 先转写。原件只作为转写源。 |
| D2 | **只改 AI 教学链路** | 通用 AI 对话只共享 `vault.read` 分页与工具结果治理；不引入教材语义。 |
| D3 | **长资料自动检测** | 按素材页数/字符数自动切 profile；界面显示 badge，不弹窗。 |
| D4 | **一章一笔记** | 以课程大纲的章为单位；一章一个 md，不合并整本长文档。 |
| D5 | **落点由用户指定** | 任务开始用 `ask` 协议问一次；同一任务内沿用。不默认写课程目录或知识库。 |
| D6 | **扫描件先确认** | 文本层为空/部分为空时，只标记 `needs-vision` 并给出页数与批数；用户确认后才视觉转写。 |
| D7 | **不做专用工作流** | 不新增 `course.textbook.*` 工具、不做向导；复用 `course.sources.*`、课程大纲、`plan` 协议。 |
| D8 | **1M profile 有窗口护栏** | 自动放大以 `ctxWindow` 为天花板；`ctxWindow=0` 时退回 128k profile，不盲目按 1M 放大。 |

---

## 4. 数据模型

### 4.1 `SourceEntry` 扩展

共享类型在 `/home/lousync/Projects/Phrontis/src/lib/aiTeachingSourcesPure.ts`。

```ts
export type SourceTextLayer = 'text' | 'empty' | 'partial'

export interface SourceExtract {
  /** 提取稿仓库相对路径 */
  rel: string
  /** 对应原件区间；whole 表示整本 */
  anchor: SourceAnchor
  /** 实际提取页数（PDF/PPTX/Word） */
  pages?: number
  /** 提取稿字符数 */
  chars?: number
  /** 文本层状态 */
  textLayer: SourceTextLayer
  /** 文本层为空的页号（1-based） */
  emptyPages?: number[]
  createdAt: string
  /** 原件指纹；用于判断提取稿是否过期 */
  sourceMtimeMs?: number
  sourceSize?: number
}

export interface SourceEntry {
  id: string
  title: string
  type: SourceType
  rel?: string
  url?: string

  /** 兼容旧字段：最近一次提取稿。新代码优先读 extracts。 */
  extractRel?: string | null

  /** 新增：按区间记录的提取稿 */
  extracts?: SourceExtract[]

  /** 新增：原件总页数（能拿到时） */
  pages?: number
  /** 新增：原件/提取稿字符数 */
  chars?: number
  /** 新增：文本层状态（汇总） */
  textLayer?: SourceTextLayer

  anchor: SourceAnchor
  status: 'ready' | 'needs-extract' | 'needs-vision' | 'error'
  index?: SourceIndexEntry[]
  indexUpdatedAt?: string
  note?: string
  createdAt: string
}
```

### 4.2 区间键与匹配

在 `aiTeachingSourcesPure.ts` 增加纯函数：

```ts
export function anchorKey(a: SourceAnchor): string
// whole
// pages:12-41
// headings:第1章→第2章
// files:a.md,b.md（排序后）
// lines:100-250

export function pickExtract(
  source: Pick<SourceEntry, 'extractRel' | 'extracts'>,
  anchor: SourceAnchor,
): { extract: SourceExtract | null; match: 'exact' | 'fallback' | 'missing' }
```

规则：

1. `extracts` 中存在 `anchorKey` 完全一致 → `exact`。
2. 否则若有 `extractRel` → `fallback`（兼容旧数据）。
3. 否则 `missing`。

### 4.3 `status` 增加 `needs-vision`

- `needs-extract`：还没有提取稿（PDF/PPTX/Word）。
- `needs-vision`：有提取稿，但存在空文本页，需要视觉转写（部分或全部）。
- `ready`：提取稿完整，无空页。
- `error`：原件丢失/读取失败。

渲染层所有 `status` 枚举同步；旧数据只有 `ready` / `needs-extract` / `error`，不迁移也能用。

### 4.4 `sources.json` 兼容

- 不升 `v` 版本；新增字段全部可选。
- 读取时若没有 `extracts`，`pickExtract` 回退到 `extractRel`。
- 写入时保留旧字段 `extractRel`，并同步为 `extracts` 中最近的一条。
- 删除素材仍只删登记与分配，不删提取稿文件。

### 4.5 长资料状态

不持久化“长资料”布尔值，避免源文件变化后状态过期；由纯函数按需计算：

```ts
export interface LongMaterialState {
  active: boolean
  pages: number
  chars: number
  reason: string
  profile: 'normal' | 'long-128k' | 'long-1m'
}

export function detectLongMaterial(
  sources: SourceEntry[],
  ctxWindow: number,
): LongMaterialState
```

判定：

- `pages >= 100` 或 `chars >= 100_000` → `active=true`。
- 若 `ctxWindow >= 200_000` → `long-1m`；否则若 `ctxWindow >= 64_000` → `long-128k`；否则 `normal`。
- `ctxWindow=0`（未设置）→ `long-128k`，并在界面提示“未设置模型上下文窗口，按 128k 保守档运行”。
- 未提取的 PDF/PPTX 用文件大小做兜底：>3MB 视为候选，等提取后再精确计算。

---

## 5. 转写链路

### 5.1 类型分派

`extractSource(wsId, sourceId, anchor, opts?)` 按类型分派：

| 类型 | 处理 |
|---|---|
| `md` / `dir` / `url` | 不需要转写；直接返回原路径/目录 |
| `pdf` | 文本层提取；全空/部分空标记 `needs-vision` |
| `pptx` | 逐页文本提取；图片型内容可后续视觉转写 |
| `docx` | LibreOffice → PDF → 按 PDF 提取；失败返回结构化错误 |
| `code` | 按行号区间提取到 fenced code block |
| `image` | 不自动转写；标记 `needs-vision` |
| `other` | 明确拒绝并提示可转换方式 |

### 5.2 PDF 文本层

- 保留 `## pN` 页码标记；每页正文原样，不合并段落。
- 页文本为空时写 `（本页无可提取文本）`，同时记录 `emptyPages`。
- 提取完成后计算：
  - `chars = text.length`
  - `pages = total`
  - `emptyRatio = emptyPages.length / pages`
  - `textLayer = emptyRatio === 1 ? 'empty' : emptyRatio > 0 ? 'partial' : 'text'`
- 全空：**不写“ready”提取稿**；返回 `needsVision:true`、`pages`、`emptyPages`。
- 部分空：写提取稿，但 `status='needs-vision'`，返回 `emptyPages` 供后续只转写空页。

### 5.3 PDF 全本提取

`extractSource` 支持 `anchor.kind='whole'` 或 `opts.full=true`：

```
pageCount = pdf 总页数
for start = 1; start <= pageCount; start += 200:
  pages = extractPdfRange(abs, start, min(start+199, pageCount))
  append
```

- 不再把 200 页当成整本。
- 全本提取写一个 md（`教材名-p1-{pageCount}.md`），保留页码标记。
- 全本 md 可能 >2MB；`buildSourceIndex` 只读前 2MB 建索引，但正文仍可 `vault.read` 分页读取。若需要完整页索引，见 §5.7。
- 按章提取优先；全本提取只作为“目录未知/用户要求整本”的兜底。

### 5.4 PPTX

- 用 `extractPptxPages()` 逐页取文本。
- 每个 slide 写 `## pN`（沿用现有物理页序）。
- 页文本为空同样记录 `emptyPages`。
- 全本或区间提取与 PDF 共用同一套 `SourceExtract` 记录。

### 5.5 Word / DOCX

- 沿用 `convertToPdf(abs, getSetting('sofficePath'))`。
- 转换失败时返回结构化错误：
  - `needsSoffice: true`
  - `hint: '未配置 LibreOffice 路径，或 soffice 不可用'`
- 转换成功后按 PDF 处理；`pages` 为转换后 PDF 页数。
- 不在本期引入 docx 直读库；若后续要脱离 LibreOffice，再单独评估。

### 5.6 按章提取

`course.sources.extract` 的参数保持 `source` / `from` / `to`，语义：

- `from`/`to` 是**原件页码/行号**，闭区间。
- 每次提取写一个独立的 md：`{教材名}-p{from}-{to}.md`。
- 写入 `SourceEntry.extracts`：
  ```ts
  { rel, anchor: {kind:'pages',from,to}, pages, chars, textLayer, emptyPages, ... }
  ```
- 同一区间重复提取：覆盖同名文件与同 `anchorKey` 记录，避免出现多份重复提取稿。
- `extractRel` 同步为最近一次提取稿，兼容旧代码。

### 5.7 索引

`buildSourceIndex()` 当前只索引 md 标题、目录文件名、提取稿 `## pN`，上限 `MAX_INDEX=200`。

调整：

- `MAX_INDEX` 200 → 1000（按页索引时够 600 页教材）。
- 索引项仍只存 `{label, anchor, level?}`，不存正文。
- 对全本提取稿，优先索引页码标记；若超过 1000 页，只索引前 1000 页并标注截断。
- 对按章提取稿，索引该章内的 `## pN` 与 md 标题。

### 5.8 错误处理

所有提取失败都返回结构化字段，不只返回一个字符串：

```ts
interface ExtractResult {
  ok: boolean
  relPath?: string
  pages?: number
  chars?: number
  textLayer?: SourceTextLayer
  emptyPages?: number[]
  needsVision?: boolean
  estimatedVisionBatches?: number
  needsSoffice?: boolean
  error?: string
  hint?: string
  skipped?: boolean
}
```

AI 收到 `needsVision` 时不能假装已读；必须用 `ask` 协议让用户确认转写，或明确告知“扫描页尚未转写”。

---

## 6. 读取链路

### 6.1 `vault.read` 文本分页

参数新增：

```ts
offset?: number   // 字符偏移，默认 0
maxChars?: number // 本次返回上限
```

返回新增：

```ts
offset: number
nextOffset: number
hasMore: boolean
totalChars: number
```

行为：

- `content = text.slice(offset, offset + maxChars)`。
- `nextOffset = offset + content.length`。
- `hasMore = nextOffset < totalChars`。
- `offset` 超出末尾 → 空内容 + `hasMore:false`。
- 不改 `path` / `id` 二选一语义。
- 默认值与上限按 profile 取（见 §7）。

### 6.2 `vault.read` PDF / PPTX 页码

参数新增：

```ts
pages?: string // "12-41"，闭区间；支持单页 "12"
```

返回新增：

```ts
pageCount?: number
pagesRead?: number
nextPage?: number
textLayer?: SourceTextLayer
```

行为：

- 有 `pages`：`extractPdfRange()` / `extractPptxPages()` 只取该区间，返回 `nextPage`。
- 无 `pages`：保持旧行为（从开头按 `maxChars` 截断），但返回 `pageCount` 与 `textLayer`。
- 文本层为空：返回 `needsVision:true` + `emptyPages`，不要返回空正文让模型继续编。
- AI 教学侧优先读 md 提取稿；PDF 页码读取只作为兜底。

### 6.3 `vault.list` 分页

参数：

```ts
path?: string
offset?: number // 默认 0
limit?: number  // 默认 200，上限按 profile
```

返回：

```ts
path: string
total: number      // 目录真实条目数
offset: number
hasMore: boolean
entries: Array<{ name: string; type: 'dir' | 'file'; size?: number }>
```

实现：

- 先遍历全部 `names` 计数，再排序、切片；目录读取本身很便宜。
- 不能再把 `total` 写成 `entries.length`。

### 6.4 `vault.search` 分页

参数：

```ts
query: string
offset?: number // 命中偏移，默认 0
limit?: number  // 默认 20，上限按 profile
```

返回：

```ts
query: string
hits: Array<{ relPath: string; excerpt: string; size: number }>
scannedFiles: number
hasMore: boolean
scanTruncated: boolean // 是否撞到文件数/单文件大小预算
skippedLarge: number
```

实现：

- 为判断 `hasMore`，最多扫到 `offset + limit + 1` 个命中；不承诺真实总命中数。
- 文件遍历改为分片异步（每 50 个文件 `await new Promise(setImmediate)`），避免长任务卡主进程。
- 长资料 profile 提高文件数/单文件大小预算（见 §7），但不要盲目扫全库。
- 明确返回 `scanTruncated`，让模型知道“不是没命中，而是没扫完”。

### 6.5 `capToolResult` 结构化截断

替换现在“整包换 preview”的行为：

```ts
function capToolResult(raw: string, toolName: string, profile: CapProfile): string
```

优先级：

1. 工具自身先截断（`vault.read` 用 `maxChars` + `nextOffset`，避免进入通用截断）。
2. 超限时解析 JSON，递归保留结构：
   - 标量原样；
   - 长字符串截到 `maxStringChars`，追加 `_omittedChars`；
   - 大数组保留前 `maxItems` 项，追加 `_omittedItems`；
   - 保留 `path` / `id` / `title` / `totalChars` / `nextOffset` / `pageCount` 等关键字段；
   - 加 `_truncated:true`、`_originalChars`。
3. 解析失败才回退到 `preview`，并明确说明“非结构化结果”。

提示语按工具生成，不再统一写“降低 maxChars”：

- `vault.read`：`还有 N 字符未读，用 offset=${nextOffset} 继续`。
- `vault.read` PDF：`还有第 N 页起未读，用 pages="${nextPage}-${pageCount}" 继续`。
- `vault.list`：`目录还有 N 项，用 offset=${nextOffset} 继续`。
- `vault.search`：`还有更多命中，用 offset=${nextOffset} 继续`。

### 6.6 最近结果预算

替换固定 `KEEP_RECENT_TOOL_RESULTS=3`：

```ts
interface RecentWindowProfile {
  budgetChars: number   // 例如 120k / 400k
  maxItems: number      // 例如 6 / 12
  minItems: number      // 至少保留 2
  compressThreshold: number // 超过该字符数才压缩
}
```

选择算法：

- 从最新工具消息往前累加，直到 `budgetChars` 或 `maxItems` 用尽；至少保留 `minItems` 条。
- 更早的、且单条超过 `compressThreshold` 的结果才压缩。
- 压缩保留 `path` / `nextOffset` / `pageCount` / `anchor` 等续读坐标。
- 纯函数、幂等；profile 作为参数传入，不在函数里读全局设置，避免 prompt cache 被打散。

### 6.7 Prompt cache 约束

- `system + tools` 前缀保持逐字稳定；长资料 profile 在 run 开始时取一次，不在每轮重算。
- 最近结果预算只由 profile 与 convo 决定，不读取“当前 usage”，否则同一段历史在不同轮次会被压成不同文本。
- 已压缩结果用 `_compressed` 标记；再次压缩原样返回。

---

## 7. 长资料自动检测与预算

### 7.1 检测

在 AI 教学 run 开始时：

```ts
const wsId = getWorkspaceOfSession(sessionId)
const sources = getSources(wsId, getSetting).sources
const state = detectLongMaterial(sources, Number(getSetting('ctxWindow')) || 0)
```

补充运行时兜底：

- 若 `vault.read` 返回 `totalChars > 100_000` 或 `pageCount > 100`，本次 run 立即切长资料 profile。
- 若 `course.sources.extract` 返回 `pages > 100`，同样切换。

### 7.2 Profile 表

| 项 | normal | long-128k | long-1m |
|---|---:|---:|---:|
| 单条工具结果上限 | 48k 字符 | 64k | 120k |
| 预览上限 | 8k | 10k | 20k |
| 最近结果预算 | 120k 字符 | 200k | 400k |
| 最近结果条数 | 6 | 8 | 12 |
| 压缩阈值 | 4k | 4k | 10k |
| `vault.read` 文本默认 / 上限 | 16k / 60k | 32k / 80k | 40k / 100k |
| `vault.read` PDF 每批页数 | 20 | 30 | 30～60 |
| `vault.list` 上限 | 500 | 800 | 1000 |
| `vault.search` 命中上限 | 50 | 80 | 100 |
| `vault.search` 扫描文件 | 400 | 800 | 1200 |
| `vault.search` 单文件 | 1MB | 2MB | 2MB |
| 历史上下文 | 32k token | 64k | 200k |
| 最大推理轮数 | 16 | 32 | 48 |
| 单次 token 预算 | 500k | 3M | 10M |
| 单条消息写入上限 | 20 | 80 | 300 |
| 自动压缩触发线 | 80% | 85% | 90% |
| 并行批大小 | 4 | 4 | 6 |

说明：

- long-1m 的 300 写入上限需要把 `clampMaxSessionWrites` 上限从 99 抬到 300，设置项 `max` 同步。
- `agentContextBudgetTokens` 设置上限目前是 200000，long-1m 取 200k 正好；若后续要 300k 再抬设置上限。
- `agentRunTokenBudget` 设置上限目前是 10,000,000，long-1m 取 10M。
- `MAX_TOOL_RESULT_CHARS` 等常量改为 profile 参数，不再写死。

### 7.3 设置覆盖规则

- 长资料 profile 只在对应设置**仍是默认值**时覆盖；用户显式改过的值优先。
- 判断默认值用 `SETTINGS[key].default` 比较。
- 界面 badge 显示实际生效值（例如“48 轮 / 10M token”），避免用户以为设置没生效。
- 若用户显式把轮数调到 8，长资料任务只跑 8 轮，badge 标“受用户设置限制”。

### 7.4 `agentService` 接入点

- `runAgentLoop` 增加 `profile` 参数（或 `longMaterial` 标志）。
- `maxRounds` / `runTokenBudget` / `maxSessionWrites` / `budgetTokens` 从 profile 取。
- `capToolResult` / `compressStaleToolResults` 接收 profile。
- `PARALLEL_CHUNK` 从常量改为 profile 字段（normal 4，long-1m 6）。
- `FINAL_ROUND_NOTICE` / `FORCED_SUMMARY_NOTICE` 文案不变；预算更大后触发更晚。

### 7.5 UI badge

`AiTeachCourseState` 增加：

```ts
longMaterial?: {
  active: boolean
  pages: number
  chars: number
  profile: 'normal' | 'long-128k' | 'long-1m'
}
```

展示：

- 课程页顶部 / 课程助手顶部一个小 badge：`长资料 · 620 页`。
- hover / 点击展开：总页数、总字符、生效 profile、轮数/token 预算、模型窗口。
- 不弹窗、不阻断；用户点“停止”即可中断。

### 7.6 费用

- 1M profile 单次任务可能消耗数百万到千万 token；任务结束在用量面板显示本次 token/费用。
- 开始前不弹确认框（铁律 25），但 badge 里写明“长资料模式，费用可能较高”。
- 若用户设置 `agentRunTokenBudget` 低于 profile 值，按用户值执行，并在 badge 标注。

---

## 8. AI 教学注入与提示

### 8.1 素材提示

`renderSourcesHint()`（`aiTeachingSourceRegistry.ts:808`）调整：

- 每个 item 增加 `pages` / `chars` / `textLayer`。
- `extractPath` 改为 `pickExtract(source, item.anchor)` 的结果：
  - `exact`：显示“本章提取稿 …”；
  - `fallback`：显示“提取稿（非本章区间，请先提取本章）”；
  - `missing`：显示“未提取”。
- 段角色最多 4000 字符；超出时优先保留标题、anchor、extractPath，截断 note。
- 助手角色摘要增加总页数/字符数；不贴正文。

### 8.2 课程注入

`buildCourseInjection()`（`aiTeachingCourse.ts:1224`）在长资料时追加一段：

```
【长资料模式】本课程素材共 N 页 / M 字符。按章提取、按章阅读、一章一笔记；
每章读完立即落盘，再读下一章；扫描页必须先经用户确认后视觉转写；
笔记落点由用户指定，不要默认写入课程目录或知识库。
```

这是读取纪律，不是新工作流；具体步骤仍由现有大纲、`plan` 协议和用户指令决定。

### 8.3 落点询问

任务开始用现有 `ask` 协议问一次：

```json
{
  "question": "整理后的章节笔记放在哪里？",
  "options": ["课程工作区/教材", "知识库新页面", "仓库自定义目录"],
  "allowCustom": true
}
```

用户选择后：

| 落点 | 写入方式 |
|---|---|
| 课程工作区 | `course.organize.archive`，`target` 用用户指定目录 |
| 知识库 | `knowledge.create-page`（带 frontmatter/id） |
| 仓库自定义目录 | `vault.write` / `vault.edit` |
| 用户自定义 | 先确认路径在仓库内，再写 |

同一任务内沿用；不跨任务记忆，除非后续明确要做“记住上次落点”。

### 8.4 `plan` 协议

不需要新协议。每章开始/结束时更新现有 `plan` 块：

```
通读资料 → 第1章提取 → 第1章笔记 → 第2章提取 → …
```

用户能看到进度；上下文压缩后也能从 `plan` 和 `00-整理计划.md` 恢复。

---

## 9. 一章一笔记

### 9.1 单位

- 以课程大纲的“章”为单位；没有大纲时，先让用户确认章名/页码范围，不自行按文件切。
- 一章一个 md；不把多章合并成一篇长文档。
- 如果一章超过 100k 字符，仍写一个笔记，但读取分多次。

### 9.2 流程

1. 确定本章页码范围（大纲/用户/目录页）。
2. `course.sources.extract(source, from, to)` → 本章 md。
3. `vault.read(path, offset)` 循环读到 `hasMore:false`。
4. 写 `第N章 章名.md` 到用户指定落点。
5. 更新 `00-整理计划.md` 与 `plan`。
6. 下一章。

### 9.3 笔记内容

建议结构（不强制，由用户/课程要求决定）：

- 章节标题、来源、页码范围；
- 核心概念与定义；
- 公式/定理/推导要点；
- 例题与解法；
- 易错点/反例；
- 复习题（可选）；
- 引用标记（素材编号 + 页码）。

### 9.4 长笔记写入

- 先 `vault.write` 写标题与骨架。
- 再用 `vault.edit append=true` 分段落盘，避免单次输出上限截断。
- 每次 append 都带 `expectedMtimeMs`，防止覆盖用户手改。
- 写入次数计入 `agentMaxSessionWrites`；long-1m 300 次足够 30～50 章。

### 9.5 覆盖校验

任务收尾：

- 用课程大纲章列表 vs 已写笔记列表，列出缺章。
- 用每章 `pages` / `charCount` vs 已读范围，列出未读页。
- 列出 `needs-vision` 的空页/扫描页，明确“未覆盖原因”。
- 不把“未读”写成“已整理”。

---

## 10. 扫描件确认与视觉转写

### 10.1 检测

- 全空：`textLayer='empty'`，`needsVision=true`，`estimatedVisionBatches = ceil(pages/12)`。
- 部分空：`estimatedVisionBatches = ceil(emptyPages.length/12)`，只转空页。
- 部分空：`textLayer='partial'`，返回 `emptyPages`；只转写空页，不重复转写已有文本页。
- 检测阈值：`chars / pages < 10` 或空页比例 > 80% 视为扫描件；具体阈值可在实现时用真教材校准。

### 10.2 确认

- 不自动调用视觉模型。
- UI 在素材卡上显示“需视觉转写 N 页（约 M 批）”，提供“开始转写”按钮。
- AI 侧用 `ask` 协议询问：`是否转写这 N 页？`，选项“开始 / 先跳过 / 只转写空页”。
- 用户确认后才走现有 `aiTeachSrc:transcribe`。

### 10.3 批次

- 沿用 12 页/批；渲染层负责栅格化。
- 每批完成更新提取稿与 `SourceExtract.emptyPages`；全部完成后 `status='ready'`。
- 中断后重发同区间可续转；已有页跳过。

### 10.4 部分扫描

- 先提取文本页，得到 `emptyPages`。
- 只把 `emptyPages` 对应页交给视觉转写；文本页不重复付费。
- 转写结果追加到同一提取稿的“视觉转写”节，保留页码。

### 10.5 费用

- 视觉转写单独记 `llm.vision` 审计（现有逻辑）。
- 600 页 × 12 页/批 = 50 批；开始前显示页数/批数/模型，用户确认。
- 未配置视觉模型时，明确提示去设置，不静默失败。

---

## 11. UI 变更

### 11.1 素材卡

- 显示 `pages` / `chars` / `textLayer`。
- 状态：
  - `needs-extract`：`未提取`
  - `needs-vision`：`需转写 N 页`
  - `ready`：`已就绪`
  - `error`：`文件不可用`
- “提取”按钮沿用；新增“转写空页”入口（仅 `needs-vision`）。

### 11.2 长资料 badge

- 课程页/课程助手顶部显示 `长资料 · N 页`。
- 展开显示：总字符、生效 profile、轮数/token 预算、模型窗口。
- 不阻断操作；用户可停止。

### 11.3 转写确认

- 行内确认卡，不用中央模态（铁律 25）。
- 文案：`检测到 620 页扫描件，文本层为空。视觉转写约 52 批，是否开始？`
- 选项：`开始` / `只转写空页` / `稍后`。

### 11.4 落点

- 用 `ask` 卡片问一次；选项 + 自定义路径。
- 写入前把最终路径回显给用户。
- 不默认创建 `教材/` 或知识库页面。

---

## 12. 迁移与兼容

- `sources.json` 不升版本；新增字段可选。
- 旧 `extractRel` 保留，新代码优先 `extracts`，回退 `extractRel`。
- 旧 `status` 三值继续有效；新增 `needs-vision` 需要渲染层枚举同步。
- 旧 UI 的“提取”按钮仍调用 `extractSource`，行为兼容；新返回值多字段不影响旧调用。
- 已存在的单份提取稿不自动重建；用户/AI 下次提取时补 `extracts`。
- 不删除旧 `aiTeachingSources.ts` 的视觉转写/转换函数；只在新 registry 中复用。
- `.AGENT` 契约脚本与 `src/types/index.ts` 同步更新。

---

## 13. 验收与契约

### 13.1 纯函数契约

新增/更新脚本：

| 脚本 | 断言 |
|---|---|
| `.AGENT/scripts/ai-tools-audit/verify-tool-result-cap.mjs` | profile 化上限、结构化截断、`nextOffset`、最近结果预算、纯函数/幂等 |
| `.AGENT/scripts/ai-tools-audit/measure-tool-output.mjs` | normal / long-1m 的真实体积对比 |
| `.AGENT/scripts/ai-tools-audit/measure-tool-schema.mjs` | `vault.read` / `vault.list` / `vault.search` 新参数后 schema ≤800 字符 |
| `.AGENT/scripts/ai-teaching/verify-course-mode.mjs` | `extracts` / `pickExtract` / `extractSource` 新字段与导出 |
| `.AGENT/scripts/ai-teaching/verify-ai-teaching-tools.mjs` | `course.sources.extract` 新返回值、工具枚举 |
| `.AGENT/scripts/ai-teaching/verify-scope-injection.mjs` | 长资料提示注入、落点纪律 |
| 新增 `verify-long-material.mjs` | `detectLongMaterial`、`anchorKey`、`pickExtract`、分页边界 |

### 13.2 场景验收

1. **300 页文本 PDF，10 章**：全本/按章提取无 200 页截断；每章一个提取稿；10 个笔记；页码覆盖完整。
2. **600 页扫描 PDF**：返回 `needsVision`，不自动转写；确认后只转空页；未转写前 AI 明确说“未覆盖”。
3. **10 万字 Markdown**：`vault.read` 用 offset 分 3 次读完；不再出现 24k 后只剩 4k 预览。
4. **4 个文件并行读**：4 条结果都在最近窗口内；第 1 条不被立即压缩。
5. **1M 自动档**：检测到大教材，badge 显示 long-1m；轮数/token/写入按 profile 生效。
6. **128k / 未设置窗口**：按 long-128k；不出现上下文溢出；badge 提示保守档。
7. **落点由用户指定**：课程目录 / 知识库 / 自定义目录三种都能写；不默认创建目录。
8. **类型门禁**：`npx tsc --noEmit -p tsconfig.node.json`、`tsconfig.web.json` 均通过。

---

## 14. 分阶段实施

### P0：数据模型与纯函数

- `SourceExtract` / `SourceEntry.extracts` / `status='needs-vision'`。
- `anchorKey` / `pickExtract` / `detectLongMaterial`。
- 契约脚本先写用例。

### P1：转写链路

- `extractSource` 全本循环、按章记录、文本层检测。
- PDF/PPTX/DOCX 分派；结构化错误。
- `buildSourceIndex` 适配 `extracts` 与 1000 条索引。
- UI 素材卡状态。

### P2：读取与结果治理

- `vault.read` offset / pages。
- `vault.list` / `vault.search` 分页与 `hasMore`。
- `capToolResult` 结构化截断；最近结果预算。
- 10MB 预检 / 1MB 搜索跳过修复。

### P3：长资料 profile 与注入

- `agentService` 自动检测、profile 接入。
- `aiTeachingCourse` 长资料提示与 badge 数据。
- 设置上限调整（写入 300、轮数/ token 默认值）。
- `ctxWindow` 使用说明。

### P4：扫描件确认与落点

- `needs-vision` UI、确认卡、只转空页。
- `ask` 落点询问；三种写入路径。
- 视觉转写进度/费用展示。

### P5：验收

- 场景 1～8 全跑。
- 双 tsconfig、契约脚本、真实教材回归。
- 更新 `resources/help/` 相关手册（AI 教学素材、长资料、笔记落点）。
- 评估是否需要更新 `CHANGELOG.md` 与发布说明（按版本规则）。

---

## 15. 风险与边界

| 风险 | 处理 |
|---|---|
| 1M profile 费用高 | badge 显示预算；用户可调低 `agentRunTokenBudget`；任务结束显示用量 |
| 模型窗口未知 | `ctxWindow=0` 时退回 long-128k，不按 1M 放大 |
| 扫描件视觉转写慢/贵 | 先确认；只转空页；分批；显示批数与模型 |
| Word 依赖 LibreOffice | 结构化错误 + 设置指引；不静默失败 |
| 大 `sources.json` 索引膨胀 | 索引只存标题/anchor，不存正文；上限 1000；按章提取优先 |
| Prompt cache 被打散 | profile 在 run 开始取一次；压缩纯函数/幂等 |
| 笔记覆盖用户手改 | 写入带 `expectedMtimeMs`；冲突时报错让用户确认 |
| 落点越界 | 用户指定路径必须在仓库内；写入前回显路径 |
| 工具 schema 超限 | 新参数描述最短化；跑 `measure-tool-schema.mjs` |
| AI 把空页当已读 | `textLayer` / `emptyPages` / `needsVision` 显式返回；提示词禁止假装已读 |

---

## 16. 待确认（已全部拍板，2026-11-08）

1. **`ctxWindow` 是否固定设为 1000000？** ✅ 拍板：设置项默认值抬到 1000000；用户可在设置里改小，改小后自动按 128k 保守档。
2. **落点是否每次任务都问？** ✅ 拍板：每次任务用 `ask` 问一次，任务内沿用，不跨任务记忆（维持 §8.3 现方案）。
3. **扫描件确认粒度**：✅ 拍板：整本确认一次，确认后批内自动续转，中断可续（维持 §10.2 现方案）。
4. **笔记详细程度**：✅ 拍板：中等——每章 2~4k 字（核心概念 + 公式推导要点 + 例题解法 + 易错点）；30 章教材约 100~150 次 append，long-1m 写入上限 300 内从容。
5. **是否需要“长资料自动检测”开关**：✅ 拍板：纯自动，不加设置项开关；badge 显示生效档位与预算，点停止即可中断。

---

## 17. 文件改动清单

| 文件 | 改动 |
|---|---|
| `/home/lousync/Projects/Phrontis/src/lib/aiTeachingSourcesPure.ts` | `SourceExtract`、`SourceEntry.extracts/pages/chars/textLayer`、`status='needs-vision'`、`anchorKey`、`pickExtract`、`detectLongMaterial` |
| `/home/lousync/Projects/Phrontis/electron/lib/aiTeachingSourceRegistry.ts` | 全本/按章提取、`extracts` 写入、文本层检测、`buildSourceIndex`、`resolveSegmentSources`、`renderSourcesHint` |
| `/home/lousync/Projects/Phrontis/electron/lib/aiTeachingSources.ts` | 复用视觉转写/`convertToPdf`；结构化错误；只转空页 |
| `/home/lousync/Projects/Phrontis/electron/lib/docsReader.ts` | PDF 全本循环辅助、页数/文本层元数据；`MAX_PDF_PAGES` 语义澄清 |
| `/home/lousync/Projects/Phrontis/electron/lib/builtinTools.ts` | `vault.read` offset/pages、`vault.list`/`vault.search` 分页、10MB/1MB 修复、`course.sources.extract` 返回值 |
| `/home/lousync/Projects/Phrontis/electron/lib/agentService.ts` | profile 接入、结构化截断、最近结果预算、长资料检测 |
| `/home/lousync/Projects/Phrontis/electron/lib/agentLoopPolicy.ts` | profile 默认值、并行批大小、写入上限 clamp |
| `/home/lousync/Projects/Phrontis/electron/lib/aiTeachingCourse.ts` | 长资料提示、badge 数据、落点纪律 |
| `/home/lousync/Projects/Phrontis/src/lib/settings.ts` | `agentMaxSessionWrites` 上限 300；长资料相关默认值/说明 |
| `/home/lousync/Projects/Phrontis/src/types/index.ts` | `AiTeachCourseState.longMaterial`、`AiTeachSource` 新字段 |
| `/home/lousync/Projects/Phrontis/electron/preload/index.ts` / `src/lib/ipc.ts` | 新字段透传（如有 IPC payload 变化） |
| `/home/lousync/Projects/Phrontis/src/modules/ai-teaching/index.tsx` | 长资料 badge、素材状态、转写确认卡、落点 ask |
| `.AGENT/scripts/ai-tools-audit/*` | 结果上限/体积/schema 契约 |
| `.AGENT/scripts/ai-teaching/*` | 素材注册表/工具/注入契约 |
| `resources/help/*` | AI 教学素材、长资料、笔记落点说明 |

---

## 18. 一句话总结

**把“读不完”变成“可续读”，把“整本塞进去”变成“按章提取 + 一章一笔记”，把“手动调上限”变成“按素材大小和模型窗口自动切档”；扫描件只检测、不擅自转写，落点始终由用户指定。**
