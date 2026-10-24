# v3.12.0 情报模块（intel）实现方案

> **交接文档**：需求与原型均已确认，本文档是唯一实现依据，不再重开范围讨论。
>
> **⚠ v2 修订（2026-10-25，扩源报纸化）已并入各节**：新增决策 D11–D14；源扩到 14 内置 + 自定义 RSS；`IntelItem` 加 `section` 字段（**若 M1 已开工，先补这个小 diff 再继续**）；侧栏版面分组 + 头条视图；设置增 6 源开关与自定义源编辑器。改动点全部标注「v2」字样，改前重读 §0/§1/§3。
> - 分支：`feature/v3.12.0`（基于 main @ a97181d，工作树干净；`stash@{0}` 是用户在 v3.9.1 上的日程 WIP，**勿动**）
> - 交互基准原型：`E:\Projects\KnowledgeRecorder\tmp\prototypes\feed-module-proto.html`（本地静态服务 `http://127.0.0.1:8391/feed-module-proto.html`；tmp/ 不进 git，实现前别删）
> - 参考项目：`E:\Projects\KnowledgeRecorder\tmp\OpenCollector`（MIT，仅借鉴管线思路，不引依赖）
> - 关联方案：卡片英文自动翻译（双语副行 + 翻译缓存复用）见 `docs/intel-translate-plan.md`（2026-10-25 定稿，并入 3.13.0）

## 0. 已拍板决策（全部确认过，实现时不再询问）

| # | 决策 |
|---|---|
| D1 | 定位：工作台内模块「情报」——抓取 / 筛查 / 推荐 + 收藏与网页跳转 + **应用内阅读**（Defuddle 提取可行，「组装不是发明」）；v2 起升级为「**线上报纸**」：时政 / 国内 / 国际 / 财经 + 科技全版面 |
| D2 | **14 个内置数据源**（8 科技 + 6 新闻，见 §1；6 个新闻源 2026-10-25 在用户真机实测可达）＋**用户自定义 RSS** |
| D3 | 模块占一个工作台页签；点开一篇文章**新开一个文章页签**（Edge Fluent Tab，可关） |
| D4 | 收藏 ♥ + 存为笔记；存笔记必须走 clipper 草稿通道（编辑器是唯一正文写入方，AGENTS 铁律 2） |
| D5 | AI：**独立条件 Tab「📡 情报助手」**，`AgentSessionSource = 'intel'` 物理隔离会话，照抄日程助手模板（`agentService.ts` source==='schedule' 全套接线） |
| D6 | 情报助手**只读情报池**（窄工具白名单 + 每轮池快照注入）；「结合我的笔记推荐」留 3.12.x |
| D7 | AI 写动作（set-recommendations / set-filter）**直接落盘**，不走 AiChangePlan 暂存（可一键清空的 UI 态，可逆） |
| D8 | 通用助手（三宿主）拿**只读** `builtin.intel.query`——照 `scheduleReadOnly` 先例（`electron/lib/agentService.ts:514`），写工具滤出模型视野 |
| D9 | 设置进**现有设置模块**（`src/lib/settings.ts` SETTINGS + 设置页「模块 › 情报」分区），模块内不放设置页 |
| D10 | 首期不做：用户画像、每日简报（顶栏按钮 disabled 占位，title 注明 3.12.x） |
| D11 | **（v2 修订 2026-10-25）扩源报纸化**：新增版面维度 `section`（tech / domestic / world / finance），**必须在 M1 类型冻结时一并落**，晚加是伤筋动骨的迁移 |
| D12 | **（v2）自定义 RSS 源**：配置随仓库走（`.knowbase/modules/intel/sources.json`），设置 › 情报里增删改；参与 fetchAll，源权重固定 18，版面由用户选 |
| D13 | **（v2）呈现**：左栏侧栏按版面分组（科技 / 时政·国内 / 国际 / 财经）；feed 顶部增「头条 / 时间流」视图切换，默认时间流（会话内记忆，不持久化） |
| D14 | **（v2）打分按版面分化**：非科技版面**不套技术信号词表**（时政/财经/国际无 star/点赞，热度天然为 0），新闻源权重 20–24 |

## 1. 数据源清单（v2：14 内置 + 自定义）

**科技版面（8，原清单）：**

| key | 名称 | 取数方式 | kind | 源权重 |
|---|---|---|---|---|
| `github` | GitHub 新晋高星 | Search API `q=created:>{7天前}+stars:>20&sort=stars&order=desc&per_page={limit}`，`Accept: application/vnd.github+json`，匿名（限流 10 req/min，每轮只发 1 请求） | repo | 26 |
| `hn` | Hacker News | Algolia `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage={limit}` | news | 24 |
| `arxiv` | arXiv 论文 | `http://export.arxiv.org/api/query?search_query=cat:cs.*&sortBy=submittedDate&sortBy=desc&max_results={limit}`（Atom，轻量解析；超时放宽 20s） | paper | 26 |
| `openalex` | OpenAlex 论文 | `https://api.openalex.org/works?filter=from_publication_date:{7天前}&sort=cited_by_count:desc&per-page={limit}&mailto=phrontis@local` | paper | 24 |
| `weekly` | 阮一峰周刊 | GitHub contents API `repos/ruanyf/weekly/contents/docs` 取最新一期目录，条目 = 期内文章链接 | weekly | 28 |
| `hf` | HF Daily Papers | `{hfBase}/api/daily_papers?limit={limit}`，默认 `https://huggingface.co`，基址可配镜像（设置 `intel.hfBase`） | paper | 27 |
| `labs` | AI 官方博客 | DeepMind `https://deepmind.google/blog/rss.xml` + OpenAI `https://openai.com/news/rss.xml`（标准 RSS）+ Anthropic `https://www.anthropic.com/news` 页面解析（脆弱，单站失败不影响另两站）；title 加 `DeepMind:` / `OpenAI:` / `Anthropic:` 前缀区分 | blog | 27 |
| `qbitai` | 量子位 | `https://www.qbitai.com/feed`（WordPress RSS，偶发 502，重试 1 次） | news | 20 |

**新闻版面（v2 新增 6，2026-10-25 用户真机实测 200）：**

| key | 名称 | 版面 | 取数方式 | kind | 源权重 |
|---|---|---|---|---|---|
| `people_politics` | 人民网·时政 | domestic | `http://www.people.com.cn/rss/politics.xml`（标准 RSS，实测 382KB 全文） | news | 24 |
| `people_world` | 人民网·国际 | world | `http://www.people.com.cn/rss/world.xml` | news | 24 |
| `sina_china` | 新浪·国内焦点 | domestic | `https://rss.sina.com.cn/news/china/focus15.xml` | news | 20 |
| `sina_world` | 新浪·国际焦点 | world | `https://rss.sina.com.cn/news/world/focus15.xml` | news | 20 |
| `chinanews` | 中新网·滚动 | domestic | `https://www.chinanews.com/rss/scroll-news.xml` | news | 22 |
| `wallstcn` | 华尔街见闻·快讯 | finance | `https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit={limit}`（JSON，`data.items[]`，content 为 HTML 需转 markdown/去标签；子频道 a-stock 等后续可扩） | news | 24 |

**自定义 RSS（v2 新增）**：用户在 设置 › 情报 添加任意 RSS/Atom 地址（命名 + 归入四版面之一），存 `.knowbase/modules/intel/sources.json` 随仓库走；抓取走与内置 RSS 源同一 `fetchRss()` 通道，`source` 键 = `custom:<id>`，源权重固定 18。

已验证不可用、勿再调研：linux.do（login_required）、V2EX hot.json（2025 起反爬）、Reddit（OAuth）、Papers with Code（2025 停服）、**新华网 RSS（404）、界面 yaowen.xml（404）、联合早报 RSS（返回 HTML，已死）、36氪 /feed（返回 HTML，已死）、gov.cn/rss/zhengce.xml（404）、澎湃首页侧栏 API（通但全是推广位内容，质量不合格）**。

## 2. 架构总览

```
渲染层                                    IPC（invoke）                主进程
─────────────────────────────            ─────────────                ─────────────────────────────
src/modules/intel/                        intel:getItems   ──────▶     electron/lib/intel/
  index.tsx        情报主页（feed）        intel:refresh               ├─ sources/ 14 个源适配器（每源一文件）+ rss.ts 公共 RSS/Atom 解析
  IntelSidebar.tsx 模块侧栏（portal）      intel:toggleFav             ├─ pipeline.ts 清洗/打分（调 intelPure）
  IntelArticleView.tsx 文章页             intel:getArticle             ├─ intelStore.ts 读写/合并/清理（真相源）
  IntelAssistantPanel.tsx 右栏 AI         intel:setAiRec               ├─ fetchAll.ts 一轮抓取编排
                                          intel:clearAiRec             └─ scheduler.ts 定时器（pushService 同型）
WorkbenchPageBar 文章页签 intel-a:<id>                                  │
WorkbenchRightPanel 📡 条件 Tab                                        ▼ 写盘后 windowBus.broadcastDataChanged('intel')
App.tsx 页签宿主渲染分支                                    .knowbase/modules/intel/{items,meta}.json
                                                          .knowbase/modules/intel/articles/<id>.json
AI 面
  agentService.ts source==='intel'：白名单工具 + 人设(system) + 池快照(首条 user 层)
  builtinTools.ts  builtin.intel.{query,set-recommendations,set-filter}
```

分层原则（对应 AGENTS 铁律）：
- 主进程写盘后必须 `windowBus.broadcastDataChanged('intel')`；
- AI 工具与 IPC handler 共用 `intelStore` 导出的业务函数，不给 `.knowbase` 开写白名单；
- 渲染层不接触绝对路径，IPC 只传 id / 参数。

## 3. 数据形状（先冻结，多线开工的前提）

### 3.1 跨线类型（加进 `E:\Projects\KnowledgeRecorder\src\types\index.ts`）

```ts
export type IntelSourceKey = 'github' | 'hn' | 'arxiv' | 'openalex' | 'weekly' | 'hf' | 'labs' | 'qbitai'
  | 'people_politics' | 'people_world' | 'sina_china' | 'sina_world' | 'chinanews' | 'wallstcn'
export type IntelKind = 'repo' | 'news' | 'paper' | 'weekly' | 'blog'
/** 版面（v2）：报纸的分类维度；条目 section = 来源源固定 section（自定义源 = 用户所选） */
export type IntelSection = 'tech' | 'domestic' | 'world' | 'finance'

export interface IntelItem {
  id: string          // 稳定条目 id = hash 前 12 位
  hash: string        // URL 归一化后 sha256 前 40（去重键）
  source: IntelSourceKey | `custom:${string}`
  section: IntelSection
  kind: IntelKind
  title: string
  url: string         // 原文链接（「打开原文」用）
  author: string
  summary: string
  tags: string[]
  score: number       // 0~100 质量分（§5.2）
  stars?: number      // repo 类热度
  publishedAt: string // ISO；缺失 ''
  fetchedAt: string   // ISO 本轮抓取时间
  fav: boolean        // 用户收藏（永不被 prune/merge 清除）
  favAt?: string
  extra?: Record<string, unknown>  // forks / paperId / points 等源特有字段
}

export interface IntelAiRec {
  ids: string[]       // 推荐条目 id 集（有序，按推荐优先级）
  query: string       // 用户当时的问句（左栏入口副标题 + feed 顶部 pill 显示）
  note?: string       // AI 一句话说明
  updatedAt: string
}

export interface IntelMeta {
  aiRec: IntelAiRec | null
  lastFetchAt: string
  lastFetchStats?: { ok: IntelSourceKey[]; failed: IntelSourceKey[]; added: number }
}

/** 用户自定义 RSS 源（v2，随仓库走） */
export interface IntelCustomSource {
  id: string          // `custom:` 前缀的 source 键体（如 'c7f2a1'）
  name: string        // 用户命名（侧栏显示）
  url: string         // RSS/Atom 地址
  section: IntelSection
  enabled: boolean
}
```

### 3.2 落盘文件（jsonStore：`MOD = 'modules/intel'`，写用 `writeJsonOrThrow`）

| 文件 | 内容 | 说明 |
|---|---|---|
| `.knowbase/modules/intel/items.json` | `IntelItem[]` | 全量池，按 score 降序 |
| `.knowbase/modules/intel/meta.json` | `IntelMeta` | AI 推荐 + 抓取统计 |
| `.knowbase/modules/intel/sources.json` | `IntelCustomSource[]` | **（v2）用户自定义 RSS 源**，随仓库走 |
| `.knowbase/modules/intel/articles/<itemId>.json` | `{ url, title, md, fetchedAt }` | 正文缓存，**惰性写**（首次打开文章才提取），随 prune 清理 |

体量控制：每轮每源 ≤ `intel.limit`（默认 20）条；merge 时全池按 `intel.keep` 天（默认 14）prune（fav 条目豁免），prune 后再按 score 截断上限 2000 条。

### 3.3 `DataChangeScope`（`E:\Projects\KnowledgeRecorder\src\lib\dataChanged.ts:14`）

联合类型加 `'intel'`。所有 intel 数据写入（refresh / fav / aiRec / article 缓存不广播）后主进程广播；渲染层 feed 页、侧栏、文章页挂 `useDataChanged('intel', reload)`。

## 4. 主进程 `E:\Projects\KnowledgeRecorder\electron\lib\intel\`

### 4.1 `sources/`（8 文件，每源一个适配器）

统一形态：

```ts
export async function fetchGithub(limit: number): Promise<IntelItem[]> // 其余同理
```

- 公共 helper `fetchJson / fetchText`（放 `electron/lib/intel/http.ts`）：Node fetch + 浏览器 UA + `AbortController` 超时（默认 12s，arXiv 20s）+ 失败重试 1 次（qbitai）——照 `electron/lib/webSearch.ts` 既有写法。
- **`rss.ts`（v2 新增公共层）**：轻量 RSS/Atom 解析（正则抽 `<item>/<entry>` 的 title/link/description/pubDate，不引 XML 依赖，与 arXiv Atom 解析同思路）；供 6 个新闻源 + 自定义源共用。人民网/新浪/中新网为标准 RSS 直解；华尔街见闻走 `fetchJson`（content 字段为 HTML → 去标签保文）；自定义源按响应类型自动判 RSS/Atom。
- **单源失败返回 `[]`，绝不炸整轮**；`fetchAll` 用 `Promise.allSettled` 汇总，失败源进 `lastFetchStats.failed`。
- 适配器只做「拉数 + 映射成 IntelItem 雏形」（score/fav 等由管线补）。
- **fetchAll 编排（v2）**：14 内置源（各受 `intel.source.<key>` 开关控制）+ `sources.json` 里 enabled 的自定义源一并 `allSettled`；自定义源条目带 `source: 'custom:<id>'` 与用户所选 section。

### 4.2 `pipeline.ts`（清洗与打分，逻辑放纯函数）

打分与清洗**不写在这里**——纯函数放 `E:\Projects\KnowledgeRecorder\src\lib\intelPure.ts`（主进程 / 渲染层 / 契约脚本三方共用，先例：`scheduleRecurringPure`）。`pipeline.ts` 只是组装：拉原始条 → `intelSpam` 过滤 → `intelScore` 打分 → hash/去重。

`intelPure.ts` 内容（语义移植自 OpenCollector `pipeline/cleaner.py`，中文注释）：

- `normalizeIntelUrl(url)`：去追踪参数（utm_* / fbclid / gclid / spm / ref…）、host 小写、去 `www.`、去尾斜杠；
- `intelHash(url)`：归一化后 sha256 前 40；
- `intelSpam(title, summary)`：营销水文正则（限时优惠 / 扫码关注 / 加微信 / 副业月入…，可被设置 `intel.filter` 关闭）；
- `intelScore(item)`：源权重(30) + 热度 log 缩放(35) + 技术信号词(15) + 摘要完整度(10) + 新鲜度(10)，上限 100 保留 1 位小数；权重表 = §1 各源权重；**v2 按版面分化：`section !== 'tech'` 时跳过技术信号词表**（时政/财经/国际无 star/点赞，热度项天然为 0，官方快讯类靠源权重+新鲜度+完整度区分）；
- `SOURCE_META: Record<IntelSourceKey, { label, kind, section, weight, fg }>`：源名 / 类型 / **版面** / 权重 / 侧栏徽标色（渲染层也用它渲染，别在组件里抄第二份）；自定义源不进此表，渲染侧查 `sources.json`（label/section 同结构兜底，weight 18）；
- `filterIntelItems(items, { source?, kind?, kw?, ids? })`：feed 与 AI 工具共用一套过滤。

### 4.3 `intelStore.ts`（唯一真相源）

导出业务函数（IPC handler 与 AI 工具共用）：

- `intelItemsAll(): IntelItem[]`
- `intelMergeItems(raw: IntelItem[]): { added: number }` —— 按 hash 去重合并；已存在条目**只更新热度类字段**（stars/score/publishedAt），`fav`/`favAt` 原样保留；写 items.json；
- `intelPrune(keepDays: number)` —— 按 fetchedAt 清理，fav 豁免；同时清 articles/ 下失联缓存；
- `intelToggleFav(id): IntelItem | null`
- `intelSetAiRec(rec: IntelAiRec)` / `intelClearAiRec()`
- `intelRefresh(): Promise<IntelMeta>` —— fetchAll → merge → prune → 更新 meta → **`windowBus.broadcastDataChanged('intel')`** → 返回统计；
- `intelGetArticle(item: IntelItem): Promise<{ md } | { error }>` —— 有缓存直接回；无则 `extractArticle(url)`（复用 `electron/lib/clipperServer/extract.ts`，Defuddle → stripDangerous → markdown）后写缓存。**收藏/推荐等状态写不走这里**，正文只读缓存。
- **（v2）自定义源 CRUD**：`intelListCustomSources() / intelAddCustomSource({name,url,section}) / intelRemoveCustomSource(id) / intelToggleCustomSource(id)` —— 读写 sources.json（name/url 去重校验，上限 20 个）；增删后 `broadcastDataChanged('intel')`（侧栏即时刷新）。

无仓库（`getVaultKbRoot()` 为 null）时所有写函数返回空/ false 并让调用方 Toast「请先打开仓库」。

### 4.4 `scheduler.ts`（定时抓取）

照 `electron/lib/pushService.ts` 的 `startSuperviseScheduler / stopSuperviseScheduler` 同型：

- `startIntelScheduler()` / `stopIntelScheduler()`，内部 `setInterval(tick, 5min)`：到点检查设置 `intel.interval`（'off' 不跑）、无仓库跳过、距 `lastFetchAt` 不足间隔跳过；
- 挂载点：`E:\Projects\KnowledgeRecorder\electron\main\index.ts`（`registerScheduleHandlers()` 约 :1099 附近调 `registerIntelHandlers()`；`startSuperviseScheduler()` 约 :1251 附近调 `startIntelScheduler()`；will-quit 约 :1359 处 stop）。

## 5. IPC 层

`E:\Projects\KnowledgeRecorder\electron\database\repositories\intelRepo.ts`，`registerIntelHandlers()`（channel 命名照 `schedule:getAllTodos` 风格）：

```
intel:getItems      → intelItemsAll()
intel:refresh       → intelRefresh()
intel:toggleFav     → intelToggleFav(id)
intel:getArticle    → intelGetArticle(id)（读条目 + 提取）
intel:setAiRec      → intelSetAiRec(rec)
intel:clearAiRec    → intelClearAiRec()
intel:listCustomSources  → intelListCustomSources()
intel:addCustomSource    → intelAddCustomSource({ name, url, section })
intel:removeCustomSource → intelRemoveCustomSource(id)
intel:toggleCustomSource → intelToggleCustomSource(id)
```

preload（`E:\Projects\KnowledgeRecorder\electron\preload\index.ts`）暴露通道，`E:\Projects\KnowledgeRecorder\src\lib\ipc.ts` 加 typed 包装 `intelGetItems / intelRefresh / intelToggleFav / intelGetArticle / intelSetAiRec / intelClearAiRec`。

## 6. 渲染层 `E:\Projects\KnowledgeRecorder\src\modules\intel\`

### 6.1 模块与页签注册

| 文件 | 改动 |
|---|---|
| `src/types/index.ts` | `TabName` 联合加 `'intel'`（`appModules.ts` 的 `_AllTabNamesCovered` 会强制对齐） |
| `src/lib/appModules.ts` | `APP_MODULES` 加 `{ id: 'intel', label: '情报', bar: false, tile: true, palette: true }`（入口形态照记账：不进活动栏，走书签 + 磁贴 + 命令面板） |
| `src/lib/workbenchLayout.ts` | `RailModule`(:193) 加 `'intel'`；`BOOKMARK_COLORS`(:231) 加情报（fg `#1a9e9e`，bg 照现有各色的柔和底格式配同色系）；`WORKBENCH_BOOKMARKS`(:211) 加「情报」书签；`RAIL_FOLLOW_MAP`(:254) 加 `intel: 'intel'`；`RIGHT_PANEL_TAB_IDS_ALL`(:85) 加 `'intel'`（📡 条件 Tab，不进基础三元组 `WORKBENCH_PANEL_TAB_IDS`） |
| `src/App.tsx` | 渲染分支：`activeTab === 'intel'` → `IntelModule`（**模块根节点 `h-full`，禁 `flex-1`**，铁律 11）；磁贴 / 命令面板入口随 APP_MODULES 自动生效 |

### 6.2 文章页签（动态 id，先例：工具页签 / 错题本 quiz）

- 页签 id：`intel-a:<itemId>`；辅助 `isIntelArticleTab(id)` / `intelArticleIdOf(id)`；
- `WorkbenchPageBar.tsx`：`tabLabel`(:55) 加分支返回条目标题（截 12 字符）；icon 用 lucide `Radar`（14px，随 TAB_ICONS 表）；
- `App.tsx`：tabs 数组 push/pop 正常走；activeTab 为文章页签时渲染 `IntelArticleView itemId=...`；**重启恢复时条目已被 prune** → 渲染「该条情报已过期」空态卡（按钮：回情报页 + 关闭本页签），不要静默空白；
- 打开逻辑：feed 卡片点击 → 若页签已开则激活，否则新开（去重）。

### 6.3 组件

**`index.tsx`（情报主页）**——对照原型 feed 页：
- topbar：统计 chip（共 N 条 · 收藏 M）｜上次更新时间（相对时间）｜「简报」按钮 disabled + title「每日简报将在 3.13.0 提供」｜「刷新」（转圈中禁用，结束 Toast「新增 X 条 · Y 源失败」）｜⚙（`tab:open` 跳设置 intel 分区）｜◐ 主题｜🤖（展开右栏并落 📡 Tab）；
- **视图切换（v2）**：feed-head 右侧「头条 / 时间流」两态切换（默认时间流，会话内记忆）。**头条视图 = 报纸头版**：按版面分区展示，每区取该版面质量分 top 3（区首条大卡带摘要，其余紧凑行；区头 = 版面名 + 「共 N 条」）；时间流 = 现有单列列表；
- 筛选 pill 行：全部 / 收藏 / ✨ AI 推荐（有推荐才显示）/ 各版面 / 各源；AI 关键词或 kind 筛选生效时追加不可关闭 pill「来自询问：「query」」；
- 列表：`filterIntelItems` 过滤；列表项挂 `.kb-cv`（content-visibility，估值按行高选 120px 档）；增删动效用 `.kb-item-in / .kb-item-out`，禁另造过渡（铁律 13）；
- 空态 / 加载态 / 单源全失败提示行。

**`IntelSidebar.tsx`（模块侧栏）**——portal 挂进 WorkbenchLeftPanel 模块态 slot（App 收集 slot DOM 传模块，照 `ScheduleSidebar` 同型）：
- **版面分组（v2）**：按 section 分四组「科技 / 时政·国内 / 国际 / 财经」，组头显示版面名 + 组内条数（点击 = feed 筛选该版面；**组头右侧 chevron 可折叠/展开源列表**，`.kb-chevron` 令牌，折叠态会话内记忆）；组下列各自源项（`SOURCE_META` 渲染名 + 徽标色 + 计数，点击 = 筛选该源），自定义源挂进其所属版面组（名取 `name`，附 📰 标记）；默认全展开；
- 「我的」分组：`✨ AI 推荐`（`meta.aiRec` 存在且 ids>0 才渲染；副标题 query；hover ✕ = `intelClearAiRec`）＋ `♥ 收藏夹`；
- 计数随 `useDataChanged('intel')` 刷新。

**`IntelArticleView.tsx`（文章页）**——对照原型 art 页：
- 头部：源徽标（SOURCE_META 色）+ 标题 + `♥ 收藏`（即时乐观更新 + Toast）+ `💾 存为笔记` + `↗ 打开原文`（`window.api` 的 shell.openExternal 通道，沿用既有外链打开方式）；
- 正文：`intelGetArticle` 拉取 → `MarkdownPreview`（760px 阅读列，远程图白名单沿用组件内置）；加载中骨架；失败模板（原因 + 重试 + 打开原文兜底）——原型有 8 种源特有头部模板，v1 简化为统一头部 + 正文，不逐源做花头；
- **存为笔记**：`extractArticle` 的 md → clipper 草稿通道（`.knowbase/_draft/clipper/`）→ 打开编辑器页签（照 clipperServer 既有流程；**不自建写正文路径**，铁律 2）→ Toast「已存为笔记草稿」。

**`IntelAssistantPanel.tsx`（右栏 AI）**——见 §7。

### 6.4 交互与文案纪律

- 一切反馈走 `showToast`（`src/lib/toast.ts`），禁 alert/confirm（铁律 25：常规操作行内化）；
- 设置锚点：`data-setting-anchor` 挂在设置页 intel 分区，模块顶栏 ⚙ 直达。

## 7. AI 接线（本模块的重头，全部有先例可抄）

### 7.1 会话来源与右栏条件 Tab

| 文件 | 改动 |
|---|---|
| `src/types/index.ts:1363` | `AgentSessionSource` 加 `'intel'` |
| `src/components/workbench/WorkbenchRightPanel.tsx` | 加 `intelActive?: boolean` prop（App → WorkbenchShell 传递链照 `scheduleActive`）；📡 Tab 按钮（lucide `Radar` 14px，28px 按钮、active 态 `bg-[var(--accent)]/10`，`data-wb-rp-tab="intel"`，title「情报助手（情报模块激活时出现）」；不进 ⋯ 菜单）；`effectiveTab === 'intel'` 分支渲染 `IntelAssistantPanel` |
| `src/modules/intel/IntelAssistantPanel.tsx` | `useAssistantChat({ active, sessionSource: 'intel', unified: false })` + `ChatBody` docked 窄版；顶部快捷 chips（✨ 推荐 / 🔍 找资料 / 📑 只看论文 / 🇨🇳 只看中文 → setInput + send）——对照原型 |

会话策略：普通会话列表（**不**用日程的一天一会话 `autoResumeToday`）；`unified: false`（无文件作用域 / 无写入模式 UI——情报助手不碰仓库文件）。

### 7.2 `electron/lib/agentService.ts`（4 处 source 分支，与 schedule 同接线点）

- :702 会话创建：source 三元链补 `'intel'`；
- :954 工具面：`source === 'intel' ? INTEL_TOOL_NAMES : ...`；
- :1171 人设：`source === 'intel' ? INTEL_PERSONA : ''` + `buildIntelInjection()`；
- :1982 摘要来源归一补 `'intel'`。

**`INTEL_TOOL_NAMES` 白名单**（铁律 16：窄工具面 = 少误触少 token）：

```ts
const INTEL_TOOL_NAMES = [
  'builtin.intel.query',
  'builtin.intel.set-recommendations',
  'builtin.intel.set-filter',
  'builtin.time.now',
]
```

**`INTEL_PERSONA`**（进 system，逐字稳定命中 prompt cache；语义要点，成文时照 SCHEDULE_PERSONA 的条目化风格写）：
1. 你是 Phrontis 的「情报助手」，只管情报池的查询 / 筛选 / 推荐，不处理日程、知识库、记账等其它事务；池覆盖**科技 / 时政国内 / 国际 / 财经四个版面**；
2. 只使用情报相关工具；【情报数据】快照给出当前日期与池子概况（按版面统计），以它为准，不凭印象编条目；
3. 「推荐」：先 `intel.query` 取候选，挑 3~8 条，把 id 传给 `intel.set-recommendations`（query 填用户原话），再用正文简述推荐理由；
4. 「找 X」：`intel.query` 带 q 检索，命中多条先 set-recommendations 收进结果集再汇报；池内没有就说没有，**不要编造**；
5. 「只看论文 / 只看中文 / 只看某源」：`intel.set-filter`（kind: 'paper'；中文源 = weekly/qbitai；kw 支持关键词）；
6. 回答简洁、简体中文；提条目时给「源 · 标题 · 一句话价值」，不贴长 URL。

**`buildIntelInjection()`**（每轮现算 → 首条 user 消息层，防打散 prompt cache；总量截断）：

```
【情报数据（本轮快照）】
现在：YYYY-MM-DD 周X HH:mm（时区）
池：共 N 条（科技 xx · 时政国内 xx · 国际 xx · 财经 xx；收藏 M）
按质量分前 30：
— [github|26.5] owner/repo — 摘要前 60 字（id:xxxx）
— …
当前 AI 推荐：k 条（来自「query」，updatedAt …）
```

### 7.3 通用助手只读边界

`agentService.ts` `buildToolsPayload` 的 modeOpts（:514 scheduleReadOnly 同款）加 `intelReadOnly`：`source !== 'intel'` 的会话里 `t.module === 'intel' && t.requires === 'write'` → return false（写工具滤出视野）；:1186 附近的 hint 同步加一句「情报池对通用助手只读，筛选与推荐请用户打开情报模块的📡情报助手」。

### 7.4 `electron/lib/builtinTools.ts` 三个新工具

全部 `tier: 'ondemand'`、`source: 'builtin'`、schema **≤800 字符**、description **不罗列返回字段**（铁律 16）：

```ts
// 读（通用助手 + 情报助手都可见）
registerTool({
  name: 'builtin.intel.query', title: '查询情报池',
  description: '按关键词/源/类型检索已抓取的情报条目',
  inputSchema: { type:'object', properties:{
    q:{type:'string',description:'关键词，标题+摘要匹配'},
    source:{type:'string',description:'源 key：github/hn/arxiv/openalex/weekly/hf/labs/qbitai/people_politics/people_world/sina_china/sina_world/chinanews/wallstcn'},
    section:{type:'string',description:'版面：tech/domestic/world/finance'},
    kind:{type:'string',description:'repo/news/paper/weekly/blog'},
    limit:{type:'number',description:'上限，默认 20'} } },
  readOnly: true, module: 'intel',
}, args => filterIntelItems(intelItemsAll(), {...}).slice(0, limit).map(精简投影 {id,title,source,score,publishedAt,summary截120,url}))

// 写（module:'intel' + requires:'write' → 仅情报助手可见；直接落盘，D7）
registerTool({ name:'builtin.intel.set-recommendations', title:'刷新 AI 推荐',
  description:'把筛选出的条目 id 设为左栏「AI 推荐」结果集（覆盖式刷新）',
  inputSchema:{ type:'object', properties:{ ids:{type:'array',items:{type:'string'}}, query:{type:'string',description:'用户原话'}, note:{type:'string'} }, required:['ids','query'] },
  requires:'write', module:'intel' }, args => intelSetAiRec(...))

registerTool({ name:'builtin.intel.set-filter', title:'设置情报筛选',
  description:'设置情报页的筛选态（类型/中文/关键词）',
  inputSchema:{ type:'object', properties:{ kind:{type:'string',description:"'paper'|'chinese'|''"}, kw:{type:'string'} } },
  requires:'write', module:'intel' }, args => 写入 meta 并 broadcast)
```

接线纪律（铁律 18）：`builtin.tool.request` 的 description 工具清单同步补 3 行；`aiModulePermissions` 默认 JSON（`src/lib/settings.ts`）加 `"intel":"read"`（通用助手默认只读，与 D8 一致）。

## 8. 设置（进现有设置模块）

`E:\Projects\KnowledgeRecorder\src\lib\settings.ts` `SETTINGS` 新增（每条 = key + 默认值 + label/desc/keywords/anchor，全部 `section: 'modules'`、`scope: 'global'`、进设置搜索的加 `ui: true + anchor`）：

| key | 默认 | 类型 | 说明 |
|---|---|---|---|
| `intel.interval` | `'3h'` | select（off/1h/3h/1d） | 自动抓取间隔 |
| `intel.source.github` … `.qbitai`（8 条） | `true` | toggle | 各源开关（科技版面） |
| `intel.source.people_politics` / `.people_world` / `.sina_china` / `.sina_world` / `.chinanews` / `.wallstcn`（6 条，v2） | `true` | toggle | 新闻版面各源开关；**自定义源开关不进 SETTINGS**（随 sources.json 存仓库） |
| `intel.limit` | `20` | number | 每源每轮上限 |
| `intel.filter` | `true` | toggle | 营销水文过滤 |
| `intel.keep` | `14` | number | 条目保留天数 |
| `intel.hfBase` | `'https://huggingface.co'` | text | HF API 基址（镜像可配） |

新视图 `E:\Projects\KnowledgeRecorder\src\modules\settings\views\IntelView.tsx`：h2「情报」+ 一句描述 + 分组行（SettingToggle / SettingSelect / SettingNumber，`data-setting-anchor` 挂锚点；照 `ScheduleView.tsx` 同型），注册进设置页「模块」分区导航。抓取器与 scheduler 一律 `getSetting()` 取值，**不硬编码**。
**v2 增**：分区底部「自定义 RSS 源」列表编辑器（name + url + 版面下拉 + 启用开关 + 删除，行内增删不用弹窗；上限 20 个，超限禁用添加按钮 + 说明）——走 §4.3 的自定义源 IPC，不写 SETTINGS。

## 9. 网络与安全

- 全源 https + 浏览器 UA；超时 / 重试见 §4.1；单源失败静默降级（统计上报）；
- 正文渲染链 `extractArticle → stripDangerous → markdown → MarkdownPreview`：无脚本执行面（MarkdownPreview 不跑 js，远程图走白名单）；**不要**为正文引入 iframe 渲染；
- 「打开原文」一律外链默认浏览器（shell.openExternal 既有通道），不在应用内 iframe 打开任意网页；
- 抓取不携带任何用户数据；无 telemetry。

## 10. 里程碑（每步完成即自验，勿跳步串写）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 数据层** | `src/types` 类型（**含 v2 的 `IntelSection` / `section` 字段 / `IntelCustomSource`，类型冻结一次到位**）+ `src/lib/intelPure.ts` + `electron/lib/intel/`（http/rss/sources×14/pipeline/intelStore/fetchAll 含自定义源） | `npx tsc --noEmit -p tsconfig.node.json` 过；临时脚本直跑 14 源 fetchAll 真网通（失败源列明）；纯函数契约脚本通过 |
| **M2 IPC + 骨架** | intelRepo handlers（含 4 个自定义源 channel）+ preload + ipc.ts + Tab/模块注册 + feed 页（**含头条/时间流切换**）+ 版面分组侧栏 + 刷新链路 | dev 起得来；刷新后 Toast 统计、列表出现、broadcast → useDataChanged 生效（开两窗改收藏另一窗跟着变）；头条视图分区正确；设置里增删自定义源 → 下轮刷新出现其条目 |
| **M3 文章链路** | 文章页签 + intelGetArticle 缓存 + 收藏 + 存为笔记 | 点卡片开页签、去重激活、关闭；正文渲染 + 失败兜底；存为笔记出草稿并可编辑 |
| **M4 AI 全链** | source='intel' 四处接线 + 白名单 + persona + 注入 + 3 工具 + intelReadOnly + 📡 Tab + 左栏 AI 推荐入口 | 问「推荐」→ set-recommendations → 左栏入口出现 → 点开是推荐集 → 再问刷新 → ✕ 清空；通用助手里问情报只见 query 不见写工具 |
| **M5 设置 + 定时 + 收尾** | SETTINGS + IntelView + scheduler + 动效令牌复查 | 设置改动即时生效；间隔到点自动抓；§11 收尾清单全绿 |

## 11. 收尾清单（AGENTS 硬规则，缺一不发版）

1. 类型门禁双跑：`npx tsc --noEmit -p tsconfig.node.json` 与 `npx tsc --noEmit -p tsconfig.web.json`（build 过 ≠ 类型对）；
2. 契约脚本（放 `E:\Projects\KnowledgeRecorder\.AGENT\scripts\intel\`，输出禁 emoji）：
   - `verify-intel-pipeline.mjs`：score/dedup/spam/merge/prune 断言（fav 豁免、URL 归一化、prune 不清 fav、articles 缓存随清）；
   - `verify-intel-tools.mjs`：3 工具 schema ≤800 字符、tier/module/requires 断言、`INTEL_TOOL_NAMES` 与注册名一致、通用助手视野不含 intel 写工具（`buildToolsPayload` 纯逻辑）；
3. `CHANGELOG.md` 加 3.12.0 段 → **重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`**（忘跑 = 应用内更新说明停上一版且无报错）；
4. 发版链：抬 `package.json` 3.12.0 → 改 CHANGELOG 段名 → rebuild release notes → `npm run pack` → `python scripts/publish-release.py --version 3.12.0`；
5. **AI 手册同步**（`resources/help/` 是 `builtin.help.search` 唯一语料）：新增《情报.md》；改《模块一览.md》《AI 权限与工具边界.md》《AI助手.md》；写作规范见 `.AGENT/help-rewrite/README.md`，检索验收跑 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs`；
6. 提交一律用系统 git（`/e/git/Git/cmd/git`），禁 Git Bash 自带 git。

## 12. 风险与降级（已预判，实现时按此处理）

| 风险 | 处置 |
|---|---|
| **（v2）新闻源 RSS 结构各异 / 站方改版** | 6 源全走 `fetchRss` 公共层 + 每源独立 try/catch；单源失败降级不炸整轮；自定义源同理 |
| **（v2）时政类内容合规** | 只做官方/主流媒体 RSS 的原文跳转与摘要（来源注明），不做正文改写与评论生成；提取失败一律引导「打开原文」 |
| **（v2）自定义源质量参差** | 权重固定 18 低于内置源；上限 20 个；营销过滤（intelSpam）对自定义源同样生效 |
| GitHub 匿名限流（10 req/min） | 每轮仅 1 请求；429 → 本轮该源记失败，下轮再试；不重试轰炸 |
| Anthropic 无 RSS，页面解析脆弱 | labs 源内部三站独立 try/catch，单站失败不影响；解析选择器变更只需改一个函数 |
| HF 大陆直连不稳 | `intel.hfBase` 镜像设置（hf-mirror.com 等），文档写进《情报.md》 |
| arXiv 响应慢 | 超时 20s；失败降级为空 |
| 正文提取失败（paywall / SPA） | 失败模板 + 「打开原文」兜底，不算错误 |
| items.json 膨胀 | §3.2 上限（keepDays + 2000 条截断）；articles 惰性缓存 |
| dev 主进程无热重载 | 改 `electron/` 后必须重启 `npm run dev`（铁律 8） |
