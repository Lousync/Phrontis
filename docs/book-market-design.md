# 书市（书源检索与下载）实现方案

> **状态**：**S1–S5 已落地**（S6 元数据自愈待做）· 2026-09-21 立项 / 2026-09-22 两批拍板收口 / 2026-09-23 S5 收尾
> **落地记录**：S1 磁盘与仓库 / S2 检索 / S3 下载器 / S4 模块 UI + 书架书名收口 —— 见 `docs/ui-updates.md` §22；**S5 AI 起草书源**（§四 的两个工具 + 草案预填表单）—— 见同文件 §23。三个新脚本：契约 `verify-book-market-tools.mjs`、实机探针 `probe-s5-tools.mjs`。
> **前置依赖**：本功能的**实现**排在阅读器二期（epub 六格式，foliate）之后 —— 书市搜到的书绝大多数是 epub，格式引擎不到位则市场体验残缺。
> **可交互原型**：`tmp/book-market-proto/book-market-prototype.html`（单文件、浅暗双主题）；**唯一探针** `tmp/book-market-proto/_probe.mjs`（CDP 驱动无头 Edge，**70 项交互断言全绿**、控制台零报错，另出 scene0..scene8 截图）
>
> **⚠️ 锚点时效**：本文写于 2026-09-21。其中 §2.2 / §5 的**行号与部分事实已过期**（模块项数、handler 数量、`scanMarkdownFiles` 已改名、`bookDisplayName` 调用点、`BookListItem` 字段等）。**施工以 `.claude/plans/book-market-implementation.md`（2026-09-22 按当前代码逐条复核）为准。**
> **需求与拍板来源**：本文件第一节即拍板记录；后续新增需求在 §4 单列。

---

## 一、范围与已定口径

### 1.1 要解决的问题

应用内完成「发现书 → 拿到书 → 上架 → 读」的闭环，不离开软件；让内置阅读器有内容来源。

### 1.2 拍板结果（2026-09-21）

| # | 项 | 拍板 |
|---|---|---|
| 1 | 书源协议 | **OPDS + 声明式自定义源描述**（只做字段映射，不执行脚本、不抓 HTML） |
| 2 | 源边界 | **不预置 / 不推荐 / 不分发任何侵权书源**；内置只有公版与公共目录 |
| 3 | 格式先后 | epub 阅读先落地，书市排其后 |
| 4 | 落点形态 | **纯内置模块**，不做插件 |
| 5 | 市场层级 | **左栏独立整窗模块**，书架不动（工作台内标签保持原样，靠「上架后跳转」衔接） |
| 6 | 元数据 | `<vault>/.books/.meta.json` 集中一份 |
| 7 | 代理 | 用户自填的可选 HTTP 代理，**不做自动配置与按站点绕行** |

### 1.3 为什么原路走不通（三条硬卡点，已实证）

最初设想「把书市做成一个插件」，实测**做不了**：

1. **插件拿不到网** —— 能力白名单 `electron/lib/pluginRegistry.ts:84` 只有 theme/clipboard/data/knowledge/navigation/files/vault:read\|write，**无 network**；宿主方法表 `electron/lib/pluginHostGateway.ts:1345-1720` 全无 HTTP 出口；`index.html:6` 的 CSP 为 `default-src 'self'`，iframe 内亦发不出外部请求。
2. **无书籍入库入口** —— 书籍本体落 `<vault>/.books/`，清单靠 `scanVaultBooks()` 扫盘**不落盘**；全仓无「下载落盘到 vault」的 IPC。
3. **设置里无代理项** —— 网络全走主进程 `net.fetch`，设置只有 `updateMirror` 这类镜像前缀。

→ 结论：书市是**宿主级功能**，必须新增主进程网络与落盘能力。§5 给出模块挂载的真实改动面。

---

## 二、现状核对（开工前的证据链）

### 2.1 可直接复用的既有资产（不要重写）

| 能力 | 现成实现 | 位置 |
|---|---|---|
| vault 模块 JSON 读写 | `readJson` / `writeJson` / `writeJsonOrThrow`（原子写 tmp+rename，损坏自动备份 `.corrupt-<ts>`） | `electron/lib/kbStore/jsonStore.ts:17,24,42,67` |
| 凭据加密 | `encryptSecret` / `decryptSecret`（safeStorage，`enc1:` 前缀） | `electron/lib/secretBox.ts:1,25-36,51-63` |
| vault 内加密 JSON 范式 | `readSecret` / `writeSecret` → `.knowbase/secret/passwords.json` | `electron/lib/kbStore/secretStore.ts:14-48`、`secretVaultRepo.ts:27-28` |
| 流式下载 + 断点续传 + 进度节流 | `net.fetch` + `Readable.fromWeb` + `createWriteStream` + `Range` | `electron/lib/updateService.ts:178,194,207,177,186-189,139-140,216` |
| 下载进度推送渲染层（事件式，非轮询） | `downloadZipStreaming` → `webContents.send` | `electron/lib/pluginRegistry.ts:555-598,815-818` |
| 「AI 产出 → 渲染层解析 → 用户确认 → 才落库」范式 | \`\`\`profile 围栏 + 建议卡 + 确认 | 见 §4.4 |
| 备份自动覆盖新模块 | `walkFiles(root)` 整仓递归打包 | `electron/lib/kbStore/vaultBackupRepo.ts:25-57` ✅ 新模块零登记 |

### 2.2 三处必须处理的缺口

| 缺口 | 事实 | 影响 |
|---|---|---|
| **无 XML 解析能力** | `package.json` 中无 `fast-xml-parser` / `xml2js` / `sax` / `htmlparser2` 等任何 XML 依赖；OPDS feed 是 Atom XML | 已拍板**手写极简解析器**（§3.4、§7 ①） |
| **代理无法 per-request** | `net.fetch(input, init)` 的 `init` 只多 `bypassCustomProtocolHandlers`（`node_modules/electron/electron.d.ts:9285`）；代理只能 `session.setProxy`（`:11924`，配置 `proxyRules`/`proxyBypassRules` `:10593-10597`） | §3.3 定方案 |
| **书架书名是文件名** | 显示名 = `bookDisplayName(relPath)`（`electron/lib/kbStore/bookFormats.ts:28-31`），且**被 5 处直接调用**：`src/modules/bookshelf/index.tsx:94,173,176,198,209`（均在用 `b.relPath`，`b.name` 实际未被消费） | §3.6 单点收口，否则 list-drift |

---

## 三、架构

### 3.1 分层与新增文件

沿用项目既有分层（渲染层不接触绝对路径，IPC 只传 `{rootId, relPath}`）：

```
electron/lib/kbStore/
  bookSourceVaultRepo.ts      【新】书源列表落盘（.knowbase/modules/bookSources.json）
  vaultBookMetaRepo.ts        【新】.books/.meta.json 读写（书名/作者/封面/来源/下载时间）
electron/lib/bookMarket/
  opdsParse.ts                【新】Atom/OPDS 与声明式 JSON 源 → 统一条目模型
  sourceClient.ts             【新】按源描述发起检索（注入凭据、限并发、UA）
  downloader.ts               【新】流式下载到 .books/ + 进度广播（形态照抄 updateService）
  netSession.ts               【新】书市专用 partition session 与代理设置（见 §3.3）
electron/database/repositories/
  bookMarketRepo.ts           【新】IPC handler 注册层（registerBookMarketHandlers）
src/modules/bookmarket/       【新】模块 UI（发现 / 书源 双视图、详情抽屉、下载队列、凭据弹层）
src/lib/ipc.ts                【改】新增封装
src/lib/dataChanged.ts        【改】DataChangeScope 增项
src/lib/appModules.ts         【改】注册模块（§5）
src/types/index.ts            【改】冻结共享类型（开工前先冻结）
```

### 3.2 数据落盘

**① 书源列表** `.knowbase/modules/bookSources.json`（**已拍板：per-vault**）

```jsonc
{
  "version": 1,
  "sources": [
    {
      "id": "s_xxx", "name": "我的 Calibre-Web",
      "kind": "opds",                          // 'opds' | 'custom'
      "url": "http://192.168.1.20:8083/opds",
      "auth": { "type": "basic", "ref": "s_xxx" },   // ★ 只存引用，不存凭据
      "enabled": true,
      "builtin": false,
      "mapping": { /* kind='custom' 时的声明式字段映射 */ },
      "createdAt": 1758432000000
    }
  ]
}
```

- 版本与兜底：**模块 JSON 无 schemaVersion 全局惯例**（只有 `.knowbase/config.json` 的 `schemaVersion:1`）。参照 `readerStateVaultRepo.ts:23` / `pdfReaderVaultRepo.ts:29` 用 `version:1`，读路径由 `coerceBookSources()` 兜底（同 `readerStateSchema.ts:132` 的口径），**存量/脏数据一律回落不报错**。
- 无需登记任何模块清单：备份/导入走 `walkFiles` 整仓递归，新文件自动进包。

**② 凭据** `.knowbase/secret/bookSources.json`

复用 `secretStore` 与 `secretBox`，**不新造加密路径**。密钥 = 源 id。

> **取舍（须写进用户文档）**：`secretBox` 基于 Electron `safeStorage` → Windows 下由 DPAPI 绑定**当前机器账户**。因此 **vault 拷到别的电脑后，书源凭据解不开，需重新输入**。密码本（`.knowbase/secret/passwords.json`）已接受同一取舍，此处保持一致，不另起一套。

**③ 书籍与元数据**

- 书籍本体 → `<vault>/.books/<可选子目录>/`。`scanVaultFiles` 是**递归**的（`electron/lib/kbStore/knowledgeIndex.ts:184` 自调用），故子目录可用，**且入库无需新 IPC**。
- 元数据 → `<vault>/.books/.meta.json`：`{ [relPath]: { title, author, cover?, sourceId, sourceName, downloadedAt, size } }`。
- 下载完成后必须 `broadcastDataChanged(...)` —— 否则表象是「下完了书架里没有」。

### 3.3 网络与代理（已验，方案据此定型）

**事实**：`net.fetch` 无法指定 per-request 代理（`electron.d.ts:9285`）。代理只能作用于 session。

**方案（已拍板）：书市用独立 partition session，不碰 defaultSession。**

```ts
// electron/lib/bookMarket/netSession.ts（示意）
const sess = session.fromPartition('bookmarket')   // 非持久，内存态，不落盘
sess.setProxy({ proxyRules: proxy || '', proxyBypassRules: '<local>' })
// 后续请求走 net.request({ session: sess }) 而非 net.fetch
```

**为什么不用全局 `session.defaultSession.setProxy`**：那会**连带改道 LLM 对话、模型探测、自动更新、网页剪藏**等所有请求。用户配代理的动机通常只是「书源要能连」，把 LLM 请求一起送进代理会产生极难排查的故障（供应商直连正常、走代理超时）。代理只影响书市，认知负担最小。

**代价与前置验证**：改用 `net.request({session})` 比 `net.fetch` 啰嗦（要自己收 `response` 流）。**开工第一步必须先跑一个约 20 行的探针确证**：① 非持久 partition 上 `setProxy` 生效；② `net.request` 能带出可读流并支持 `Range` 头。若不成立，退回全局代理（并把它显式标注为「影响全部网络请求」）。

### 3.4 源描述与解析

**OPDS**：标准协议，`kind='opds'` 只需 URL。检索命中 `/search`、`/opds/v1.2` 这类端点。

**自定义源**：声明式字段映射，**只取值不执行**：

```jsonc
{
  "kind": "custom",
  "searchUrl": "{base}/search?q={query}&page={page}",   // 变量：{base} {query} {page} {isbn}
  "responseType": "json",                                // 'json' | 'atom'
  "mapping": {
    "items": "data.books[*]",
    "title": "title", "author": "author.name", "cover": "cover_url",
    "summary": "summary", "fileUrl": "files[0].url", "format": "files[0].format"
  }
}
```

**解析实现（已拍板：手写极简解析器）**

放 `electron/lib/bookMarket/opdsParse.ts`，约 150 行，**只覆盖本场景真实出现的构造**：元素与属性、实体引用（`&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&#nn;`）、CDATA、自闭合标签、`dc:` / `atom:` 这类前缀按**字面标签名**处理。**不追求通用 XML 规范实现**——遇到不认识的构造宁可丢弃该条目，也不抛错（与 `jsonStore` 的「损坏不阻断」口径一致）。契约脚本用固定 fixture 覆盖上述五类构造（§9 第 2 条）。

**边界（写进代码注释与 UI 提示，不只是文档）**：

- 映射语言是**取值路径**，不含表达式、不含函数调用、**不执行任何脚本**；
- **不做 HTML 抓取**（原型里该选项已置灰）—— 抓 HTML 等于为任意站点写适配器，性质与边界都不对；
- 凭据只从 `secretStore` 取，**不写进源描述、不进日志、不进错误信息**；
- URL 白名单只放 `http` / `https`（挡掉 `file:` / `kbview:` 等本地 scheme）；私网地址**允许**（自建库就是局域网场景）；
- **礼貌抓取**：检索并发上限 2、请求间隔、可识别 User-Agent。这也是**不做「整站镜像 / 批量抓取」**的理由。

### 3.5 下载器

形态**照抄 `updateService.ts`**，不另造：`net.fetch`（→ 代理落地后改 `net.request`）+ `Readable.fromWeb` + `createWriteStream` + `Range` 断点续传 + 进度节流（约 300ms 一次）+ 99% 锁在收尾阶段 + `webContents.send` 推给渲染层（事件式，非轮询）。

落盘后：写 `.meta.json` → `broadcastDataChanged` → 书卡转「已上架」。

### 3.6 书架书名收口（list-drift 防线）

现在的显示名由 `bookDisplayName(relPath)` 产生，**5 处调用点各自算**（`src/modules/bookshelf/index.tsx:94,173,176,198,209`）。

**修法：上游解析、下游只收。** 在 DTO 层（`electron/database/repositories/pdfReaderRepo.ts:31-44` 的 `BookListItem`）就拼好最终显示字段（`displayName` / `author` / `coverRef`），渲染层一律只读 DTO 字段，**禁止在任何渲染点写 `meta?.title || bookDisplayName(...)` 这种兜底**。

---

## 四、新增需求：AI 辅助配置书源

> 2026-09-21 追加。目标是「开放一个工具，让 AI 帮用户配置/添加书源」。
>
> **★ 已落地（S5，2026-09-23）**：本章的两个工具与「草案 → 预填表单」那一跳已实施，与本文的两处**有意差异**记在这里：
> ① `booksource.draft` 的字段映射参数是 **`mappingJson: string`**（JSON 文本）而非内联对象 —— 内联对象让 `inputSchema` 冲到 1185 字符，破 AGENTS.md#16 的 800 红线；
> ② 本仓**没有「read + ondemand」先例**，故 `booksource.list` 单独放着没人提及就永远进不了模型视野 —— 已让 `draft` 的 description 点名它，并由契约脚本双向锁住。
> 落地细节与验收见 `docs/ui-updates.md` §23；实机验收 = `.AGENT/scripts/book-market/probe-s5-tools.mjs`（49 项全绿）。

### 4.1 这个需求真正的价值在哪

用户口述地址（「我的 Calibre 在 192.168.1.20:8083」）只是其一；**真正的痛点是自定义源的字段映射** —— 让普通用户看一段 JSON 响应手写 `data.books[*].files[0].url` 是不现实的，而 AI 读一段响应样例就能生成映射。这是本需求的主战场。

### 4.2 工具清单（两个，均 `tier: 'ondemand'`）

| 工具 | requires | 作用 | 备注 |
|---|---|---|---|
| `booksource.list` | `read` | 列出已配置书源（名称/类型/URL/是否需要凭据/凭据是否已存/启用态） | **绝不返回凭据内容** |
| `booksource.draft` | `write` | 提交一份书源配置草案，交给用户确认 | schema 须守 800 字符红线 |

接线（铁律 16 / 18 逐条对齐）：

- `registerTool` 签名与字段见 `electron/lib/aiTools.ts:95` / `:27-49`；`tier` 缺省是 `core`，**必须显式写 `ondemand`**（折叠判定 `electron/lib/agentService.ts:401`）；当前 31 个（core 14 / ondemand 17），本方案 +2 → **33**。
- 返回值统一走 `{ok:true,data}` / `{ok:false,code,message}` 包装（`aiTools.ts:82-89,299-316`），不要自造形状。
- `booksource.draft` 标 `requires:'write'` 会被权限系统**预过滤出模型视野**（`agentService.ts:392` 支线硬拦截、`:418` 写集合、`aiTools.ts:183-193` 校验）——**这是想要的默认**：用户主动到设置里开权限，AI 才能碰书源配置。
- 写工具名要**同步补进** `builtin.tool.request` 的 description 清单（`electron/lib/builtinTools.ts:973`，现有 19 个）。
- 落库**必须走 repo 抽出的 export 业务函数**，AI 工具与 IPC handler 共用同一实现（铁律 2：不要给 `.knowbase` 开写白名单）。
- schema 自检跑 `.AGENT/scripts/ai-tools-audit/measure-tool-schema.mjs`（红线 `SCHEMA_CHAR_LIMIT=800`，见 `:92`；量的是 `inputSchema` 去换行/缩进/注释后的发包字符）。

### 4.3 安全三条（本需求的关键约束）

1. **AI 永远不接触凭据。** `booksource.draft` 的入参 schema **不含** username / password / token 字段；凭据只能由用户在界面手输，且直接进 `secretStore`。`booksource.list` 只回「凭据是否已存」这个布尔。
2. **AI 不直接落库。** 无论走下面哪条路，配置的最后一跳必须由用户点击完成。
3. **AI 不指定盗版源。** 工具的 description 与返回文案都不得暗示任何具体站点；用户口述的地址照录，AI 不主动推荐「去哪找书」。

### 4.4 落地路径（已拍板：路 A · 预填表单）

**路 A（选定）· 预填表单**

`booksource.draft` → 主进程发事件 → 书市模块打开「新增书源」表单并**预填**（名称 / 地址 / 认证方式 / 字段映射）→ 用户检查、手输凭据、点「添加」→ 走普通 IPC 落库。

- 优点：零自动写入、零新持久化概念、用户全程可见；**凭据天然由用户手输**（AI 无从接触）；工程最轻。
- 缺点：需要唤醒书市模块（未打开时先切入）。
- 附注：可复用**已有的围栏确认范式**做呈现侧（AI 回复里给一张「已生成源配置」卡片，点卡片跳到表单）。

**路 B（未采用，留档备查）· 草案 + 确认条**

`booksource.draft` → 把草案写进主进程内存暂存区 → 广播新 scope → 书市顶部弹确认条 → 用户点「添加」落库。优点是一次给出完整配置、确认成本仅一次点击；缺点是新增「草案暂存」概念与一个 scope，且草案不落盘（重启即失效）。**若日后嫌预填表单多一步点击，可改走此路，安全口径不变。**

**选 A 的理由**：既然凭据无论如何都要用户手输，用户本来就得打开那个表单 —— 在表单里一并确认更自然、更少概念，且不必为「AI 能改配置」单独论证安全。

### 4.5 可借鉴的既有范式

「AI 产出 → 渲染层解析 → 用户确认 → 才落库」在项目里**已有成熟实例**（AI 教学画像更新，走 \`\`\`profile 围栏而非工具返回）：

协议注入 `electron/lib/agentService.ts:675` → 抓最新 assistant 围栏 `src/modules/ai-teaching/index.tsx:1640` → `parseProfileFence`（`profilePatchParse.ts:96`）→ 建议卡 `index.tsx:2981-3065` → 确认 `applyProfileSuggestion :1714` → IPC `aiTeachProfileApplyPatch`（`src/lib/ipc.ts:600` → `preload:323` → `aiTeachingProfile.ts:328` → `applyProfilePatch:285`）。

**注意**：全仓**没有任何**「AI 工具返回草案、确认后落库」的既有实现 —— 路 A/B 都是新形态，别照抄错对象。

---

## 五、模块挂载与契约影响（本章是改动的真实重量）

「左栏独立整窗模块」听着轻，实际是**牵动最多的一处**。

| 要改的地方 | 位置 | 说明 |
|---|---|---|
| 模块清单（唯一真相源） | `src/lib/appModules.ts:23-34,43-64` | 加条目 `{ id:'bookMarket', label:'书市', bar:true, startable:true, tile:true, palette:true }`；`:71-74` 有编译期兜底 |
| 整窗独占清单 | `src/lib/workbenchLayout.ts:134` `WORKBENCH_TABBAR_EXCLUDED` | 加入 `bookMarket`，否则它会被当成工作台内标签 |
| 渲染入口 | `src/App.tsx:1118-1149 renderModuleContent` | 加 `case 'bookMarket'`；保活走同一套 `renderMounted:1151-1163` |
| 左侧图标条 | `src/components/shared/ActivityBar.tsx:31-36 RAIL_BUTTONS` | 当前**仅 4 项**（aiTeaching/recycle/plugins/moments）→ 加书市共 **5 项**（已拍板，见 §7 ⑤） |
| 手绘图标 | `src/components/shared/ModuleIcons.tsx:199-207,209-223,225-237` | `StyleAware` 机制：新增需同时给「手绘」与「风格包」两条路，照 `PluginIcon` 的写法 |
| 图标 id | `src/lib/sidebarIcons.tsx:18-20 IconModuleId`（现 13 值） | 需扩一个值 + 风格包映射（`:29-36`） |
| 页面条图标 | `src/components/shared/WorkbenchPageBar.tsx:20-38 TAB_ICONS` | 补 key（兜底 `:41` 存在，不加也不崩，但会不一致） |

**会因此失败的契约（必须同步改，否则门禁红）**

`APP_MODULES` 的项数被**手抄进了 3 个脚本**，其中一条**现在就是错的**：

| 脚本:行 | 断言 | 现状 |
|---|---|---|
| `.AGENT/scripts/startup-tab/verify-startup-tab.mjs:69` | 恰 **16** 项 | ⚠️ **当前已红** —— 实测 `APP_MODULES`（`src/lib/appModules.ts:43-64`）只有 **15** 项（knowledge/blog/schedule/moments/aiTeaching/toolbox/plugins/recycle/help/bookshelf/aiChat/graph/releaseNotes/settings/devtools）。该数字是 v3.4.0 期按当时口径写的，editor 模块退役后没跟着改 |
| `.AGENT/scripts/pdf-reader/verify-pdf-reader.mjs:105` | 仍为 **15** 项（注释「编辑器退役后冻结，**新增即 FAIL**」） | 现在绿；加书市后会红 |
| `.AGENT/scripts/pdf-reader/verify-reader-formats.mjs:170` | 同上 | 现在绿；加书市后会红 |

→ 这是典型的同一常量多处分抄（list-drift 家族）。**加模块之前先把这个数字收敛**（要么只在一处断言项数，要么改成从 `APP_MODULES` 派生后断言集合关系，而非断言长度），否则往后每加一个模块都要同时改三个脚本、且必然漏一个。

其余需一并更新的：

- `verify-startup-tab.mjs:222-225`（磁贴序快照）、`:236-241`（命令面板快照）需重算。
- `.AGENT/scripts/workbench-shell/verify-workbench-shell.mjs:59,61` 断言书签**恰 5 项**；`:116,138` 断言 `RAIL_BUTTONS` **恰 4 项**（若书市进这一排则一并改）。

> 提醒：`B-10` 那条备忘里「`TAB_ICONS` 有而 `ModuleIcons` 缺手绘稿」的 6 个模块**正好含 `bookshelf`** —— 做书市图标时顺手可见，但**不要**顺手统一整表（B-9 已拍板本轮只统一「插件」一个概念）。

### 5.1 设置项

代理**不进设置页**，放书市模块内「书源 → 网络」段（原型已如此）。理由：代理只作用于书市 session（§3.3），放进全局设置页会让人以为它影响全部网络请求。

> 参考：设置表结构 `src/lib/settings.ts:127-272`（字符串项照 `updateMirror:261`），分区映射 `src/modules/settings/sections.tsx:64-74`，网络类现落在 `AboutView.tsx:92-105`（section `about`）；设置**无版本迁移机制**，缺省由读侧兜底（`src/lib/ipc.ts:15-17`）。若最终退回全局代理方案，则须改放设置页。

---

## 六、分批实施

| 批次 | 内容 | 出口判据 |
|---|---|---|
| **S0 前置探针** | `net.request({session:partition})` + `setProxy` + `Range` 三件事的可行性验证（§3.3） | 探针脚本跑通并留档；若不成立则按 §7 末注退回全局代理 |
| **S1 数据层** | 冻结 `src/types/index.ts` 共享类型；`bookSourceVaultRepo` + `vaultBookMetaRepo` + `coerceBookSources`；凭据走 `secretStore`；新增 `DataChangeScope` 项 | 契约脚本（读写往返、脏数据回落、凭据不落源描述）全绿 |
| **S2 网络层** | `netSession` + `opdsParse` + `sourceClient`（凭据注入、并发 ≤2、UA、三态连通性：已连通 / **需要凭据** / 连接失败） | 用 Gutenberg 与一个本地 mock 源各跑通一次检索 |
| **S3 下载与上架** | `downloader`（断点续传 + 进度广播）→ 写 `.books/` → 写 `.meta.json` → 广播刷新 → 书架可见 | 端到端：搜到 → 下载 → 书架显示 `meta` 书名作者 |
| **S4 模块 UI** | `src/modules/bookmarket/`（发现 / 书源双视图、详情抽屉、下载队列、凭据弹层、搜索条吸顶）；书架书名收口（§3.6） | 实机探针（见 §9） |
| **S5 AI 工具** | `booksource.list` / `booksource.draft` + 选定的落地路（§4.4）+ 权限与 `tool.request` 清单接线 | schema ≤800；权限预过滤生效；草案→确认→落库闭环 |

---

## 七、拍板结果（两批 · 14 项）

> ①–⑤ = 架构与范围层（2026-09-21）；⑥–⑭ = 数据与行为细节层（2026-09-22），逐项已在原型与探针中落地。

| # | 问题 | 拍板 |
|---|---|---|
| ① | OPDS 的 Atom 解析 | **手写极简解析器** —— 约 150 行，覆盖 tag / 属性实体 / CDATA / 自闭合 / `dc:` 前缀，配单测；零新增依赖，走主进程不进渲染包 |
| ② | 代理作用域 | **独立 partition session，只影响书市** —— 不动 `defaultSession`，LLM / 更新 / 剪藏不受影响；代价是改用 `net.request({session})` 自己收响应流 |
| ③ | AI 辅助配源落地路（§4.4） | **路 A · 预填表单** —— AI 生成配置 → 打开「新增书源」表单预填 → 用户检查、手输凭据、点添加。零自动写入，凭据天然由用户手输 |
| ④ | 书源列表归属 | **per-vault** —— `.knowbase/modules/bookSources.json`，与「vault = 唯一真相源」一致，源随仓库走、随备份带走 |
| ⑤ | 书市是否进左侧图标条 | **进** —— 由「左栏独立整窗模块」（§1.2 第 5 条）直接推出，与工具箱 / 插件平级；需同步 `src/components/shared/ActivityBar.tsx:31-36` 的 `RAIL_BUTTONS`（现 4 项 → 5 项）及其契约断言（§5） |

| ⑥ | 预置源清单 | **只 Gutenberg + Standard Ebooks** 两个可下载源（另保留 Open Library 作「仅书目元数据」的公共目录源）；预置源**可停用、不可删除** —— 它们随版本分发，删了下次更新还会回来。Internet Archive 移除（受控借阅，§8 明确不做） |
| ⑦ | 部分源失败 | **只出灰条**，不整页报错、不静默吞掉：结果照常展示，顶部压一条「N 个源未返回结果（需要凭据 / 连接失败）」+ 重试 / 去书源。并发上限按**全局 2** 算，不按源各 2 |
| ⑧ | 检索翻页 | **首屏取一页 + 显式「加载更多」**（按钮带剩余条数），不做无限滚动。页大小 = 源一次响应返回的条数（OPDS feed 通常 20–50 条） |
| ⑨ | 认证类型 | **只做 Basic + Bearer**；Digest、表单登录、自定义请求头一律不做 |
| ⑩ | 落盘命名与重名 | 文件名 **「作者 - 书名.扩展名」**（路径非法字符替换为下划线）；同 relPath 已存在时**弹确认**：覆盖 / 另存副本（加 ` (2)`），不静默覆盖、也不静默改名 |
| ⑪ | 封面存储 | 封面图落 **`.books/.covers/<hash>.jpg`**，`.meta.json` 里只存**相对引用**（渲染层不接触绝对路径） |
| ⑫ | 删书联动 | 书架删除一本书时，**文件 + meta 条目 + 封面一并删除**，**不进应用暂存区** |
| ⑬ | 下载列表 | **Steam 式列表**：并发**恒为 1**（一次只跑一个，其余排队）；逐项**暂停 / 继续 / 取消 / 重试**；头部汇总 + 全部暂停·开始 + 清除已完成；失败自动重试 1 次（凭据类失败不空转重试，直接给「重试」按钮） |
| ⑭ | 发现页快捷词 | **舍弃** —— 不摆预设检索词行。理由：首屏本就有书卡填充、快捷词只是空态拐杖；且公版源中文藏书有限，中文预设词多半给不出结果（预期管理改由 0 结果空态文案承担）。日后若要加发现入口，走 **OPDS 导航 feed（分类浏览）**而非预设词 |

> 唯一可能回摆的是 ②：S0 前置探针若证伪「非持久 partition + `setProxy` + `net.request({stream})`」，则退回全局 `defaultSession.setProxy`，并按 §5.1 末句把代理框移进设置页。

---

## 八、明确不做

- 预置、适配或推荐任何侵权书源；源描述的分发 / 分享渠道（不做「源市场」）
- 源描述执行脚本、HTML 抓取、整站镜像 / 批量抓取
- 代理的自动配置、按站点绕行
- 受控借阅类源（Open Library / Internet Archive 的**借阅**）—— 需账号、有到期与加密，不在应用内处理（仅可接其书目元数据）
- 商业平台（微信读书 / 京东读书 / 豆瓣阅读 / OverDrive）—— 无开放 OPDS，逆向私有 API + DRM 不做
- 内置阅读器的格式扩项（归阅读器二期 foliate）
- 阅读进度 / 摘录的跨设备同步
- 发现页的预设检索词行（快捷词）—— 首屏已有书卡填充，发现入口日后走 OPDS 导航 feed，而不是手写一批推荐词

---

## 九、验证清单

**契约脚本**（新增，放 `.AGENT/scripts/book-market/`）

1. `verify-book-sources.mjs` —— 源列表读写往返、脏数据回落不报错、`version:1` 兼容、**凭据字段绝不出现于源描述**（负向断言）。
2. `verify-opds-parse.mjs` —— 用固定 fixture（含 CDATA / 实体 / 自闭合 / `dc:` 命名空间）断言解析结果；对自定义源的字段映射做正例与**缺字段负例**。
3. `verify-book-market-scope.mjs` —— `DataChangeScope` 双侧登记（类型 + 消费），下载完成后书架能刷新的正向断言。
4. `verify-book-market-tools.mjs` —— 两个 AI 工具的 schema 红线（借用 `measure-tool-schema.mjs` 口径）、`tool.request` 清单已同步、**入参 schema 不含任何凭据字段**（负向）。
5. 回归：`verify-startup-tab.mjs` / `verify-workbench-shell.mjs` 的快照与计数断言同步更新。

**实机探针**（`.AGENT/scripts/book-market/probe-*.mjs`，可复用书市原型的 CDP 手法）

6. 模块挂载：`[data-wb="bookMarket"]` 存在、图标条高亮、切走再切回状态保持。
7. 检索 → 详情 → 下载 → 上架 → 书架出现该书且显示 `meta` 书名作者（端到端）。
8. 三态连通性：公版源「已连通」/ 无凭据的自建源「**需要凭据**」/ 填凭据后「已连通」。
9. AI 工具链路：权限关闭时工具不在视野 → 开启后草案能产出 → 确认后落库 → 书市列表刷新。

**手工确认（自动化不可替代）**

10. 代理：配一个不可用代理 → 书市报错而 **LLM 对话不受影响**（验证 §3.3 的隔离）。
11. 换机取舍：把 vault 拷到另一台机器 → 书源凭据需重输、源列表本身完好。

---

## 十、附：原型与本文的对应关系

原型 `tmp/book-market-proto/book-market-prototype.html` 已实现并在探针中逐项断言的界面部分：发现页（搜索框为主体、搜索条吸顶）、详情抽屉、下载队列与「去书架」、书源管理（启用开关 / 三态连通性 / 预置标记）、凭据弹层（含 DPAPI 说明）、自定义源字段映射表单（HTML 抓取置灰）、代理输入、EPUB 依赖提示条、浅暗双主题。**S4 可直接以此为验收基线**；未覆盖的是网络与落盘的真实链路（S1–S3）。

原型已去掉「快捷词」预设检索词行（拍板 ⑭）；配套唯一探针 `_probe.mjs` 共 **70 项断言**，覆盖上表全部界面部分（含分页、部分源灰条、下载列表的暂停/继续/取消、重复下载确认、预置源不可删）。
