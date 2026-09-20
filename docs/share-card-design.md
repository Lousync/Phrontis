# 打卡图（分享卡片）实现方案

> 状态：**待拍板**（需求已确认 2026-09-20；本文含逐文件施工细则，可交给独立会话实施）
> 原型：`outputs/checkin-card-prototype.html`（三主视觉已定稿）
> 一句话：打卡模块手动生成卡片 → 画布出图 → **复制到剪贴板**（去微信 `Ctrl+V`）或另存 PNG。不做微信 SDK（平台不支持桌面应用）。

## 0. 需求确认（2026-09-20 四问四答）

1. **三种主视觉都保留**，且**可现场切换**（卡片旁「换一种风格」按钮），用户选过的风格记住。
2. **只做手动入口**：日程 · 打卡视图里一个「打卡图」按钮，不自动弹。
3. **出口两个**：复制图片（剪贴板）+ 另存为 PNG。
4. **大数字指标先不定**：接入时按真实数据再定（本文给出候选与数据源）。

术语澄清：用户说的「剪切」= 把卡片图片放进剪贴板。桌面端真正意义的「剪切」会把源文件标记待删，而卡片是生成物、没有源文件，所以该按钮语义就是**复制图片**。

---

## 1. 现状地图（关键：大部分基建已存在，别重造）

| 能力 | 位置 | 现状 |
|---|---|---|
| **剪贴板写图片** | `electron/main/index.ts:790` `clipboard:copyImage`（收 `{path?, dataUrl?}` → `nativeImage` → `clipboard.writeImage`） | ✅ **已存在**，卡片复制直接复用 |
| 复制辅助（含 data: 分支） | `src/lib/ipc.ts:358` `copyImageUrlToClipboard(url)` / `:9` `copyImage` | ✅ 一行调用即可 |
| **二维码生成** | `src/lib/ipc.ts:273` `lanShareQr(text)` → `electron/lib/lanShare/qr.ts:8` `QRCode.toDataURL(text,{errorCorrectionLevel:'M'})` | ✅ **已存在**，`qrcode` 已是生产依赖，无需新增依赖 |
| 打卡数据 | `electron/database/repositories/checkinRepo.ts:72` `habit:getAll` → `{ habits, records:[{id,habitId,date,source}] }` | ✅ 渲染层经 `src/lib/ipc.ts:372 habitGetAll` 可取 |
| 统计纯函数范式 | `electron/lib/kbStore/habitStats.ts`（零依赖 + UTC 天序号 `dayNo`，契约脚本 strip-types 直跑） | ✅ **照它的范式写新模块** |
| 专注时长数据 | `electron/lib/kbStore/pomoVaultRepo.ts:9` `PomoSessionRow{minutes,date}` @ `.knowbase/modules/pomodoro/sessions.json` | ⚠️ 只有 `createPomodoroSession`（写）暴露，**渲染层读不到** → 需补读通道 |
| 「连续天数」（现有口径） | `electron/database/repositories/userRepo.ts:214-230` `user:getStats.consecutiveDays` = 博客 md ∪ 日程 todo | ⚠️ **不是打卡口径**，卡片要用需决策（见 §2.4） |
| 另存对话框范式 | `electron/lib/pdfService.ts:63` `dialog.showSaveDialog` + `writeFileSync` | ✅ 有范式可抄（但属 PDF 专用通道 → 新开通用的） |
| 卡片视觉定稿 | `outputs/checkin-card-prototype.html` | 三风格：纸山 / 书页 / 热力；明暗两态；二维码已接真实地址 |

**结论：新增代码集中在「一个纯函数统计模块 + 两个 IPC + 一个卡片组件（canvas 单源绘制）」**，其余全是复用。

---

## 2. 数据层设计

### 2.1 新增零依赖纯函数模块

`electron/lib/kbStore/shareCardStats.ts`（**零 import**，与 `habitStats.ts` 同范式，契约脚本直接装载）：

```ts
/** 'YYYY-MM-DD' → UTC 天序号（照抄 habitStats.dayNo 的口径，避免两处算法打架） */
export function dayNo(s: string): number

/** 连续打卡天数：任一天有任意习惯打卡即算「打卡日」。
 *  今天尚未打卡不算断（宽限一天，避免早上打开卡片显示 0）；
 *  从今天（或昨天）向前逐日扫，遇到第一个空日即停。 */
export function checkinStreak(records: Array<{ date: string }>, today: string): number

/** 本周 7 格（**周一为起点**）：返回 { done, cells: [7]boolean }，cells[0] = 周一 */
export function weekCells(records: Array<{ date: string }>, today: string): { done: number; cells: boolean[] }

/** 某日专注总分钟数（PomoSessionRow.minutes 求和；非该日 / 缺字段一律跳过，不抛错） */
export function focusMinutesOn(sessions: Array<{ minutes: number; date: string }>, date: string): number

/** 热力分档（0..3）：窗口内逐日统计打卡数 → 分档阈值 [0,1,2,3+] 映射 level 0..3，
 *  返回 length = weeks*7 的一维数组（列优先：第 i 周 7 天连续排列），供 canvas 直接画 */
export function heatLevels(records: Array<{ date: string }>, today: string, weeks: number): number[]

/** 聚合出卡片所需的全部数字（纯函数，便于契约断言整体口径） */
export function buildCardData(input: {
  records: Array<{ date: string }>
  sessions: Array<{ minutes: number; date: string }>
  today: string
  heatWeeks?: number   // 默认 13
}): ShareCardData
```

`ShareCardData` 形状（渲染层与主进程共用，落 `src/types/index.ts`）：

```ts
interface ShareCardData {
  date: string            // 'YYYY-MM-DD'（本地时区）
  focusMinutesToday: number
  streakDays: number
  week: { done: number; total: number; cells: boolean[] }
  heat: { weeks: number; rate: number; levels: number[] }
  siteUrl: string         // 官网地址（主进程单一来源）
  qrDataUrl: string       // 官网二维码 PNG dataURL
}
```

### 2.2 官网地址单一来源（防 list-drift）

`electron/lib/productInfo.ts`（**新建，就是常量文件**）：

```ts
/** 产品官网（GitHub Pages）。**全应用唯一出现处** —— 打卡图二维码、关于页、更新说明
 *  一律从这里取，不要在别处再写字面量。 */
export const PRODUCT_SITE = 'https://lousync.github.io/Phrontis/'
```

- 主进程生成二维码：`QRCode.toDataURL(PRODUCT_SITE, { width: 512, margin: 1, errorCorrectionLevel: 'M' })`
- 渲染层**不写这个 URL**，只消费 IPC 回传的 `siteUrl` / `qrDataUrl`
- 契约脚本做负向断言：`lousync.github.io` 只允许出现在 `productInfo.ts`

### 2.3 新增两个 IPC

`electron/database/repositories/shareCardRepo.ts`（新建，转发层）：

| channel | 入参 | 返回 | 说明 |
|---|---|---|---|
| `shareCard:get` | 无 | `ShareCardData` | 一次取全：打卡记录（`vaultRecordsAll`）+ 番茄钟场次（`pomoSessionsAll`）+ 二维码 dataURL + siteUrl。**聚合是为了「二维码与网址同源」**——两者都在主进程产出 |
| `shareCard:savePng` | `(pngBytes: Uint8Array, suggestedName: string)` | `{ ok, path?, error? }` | `dialog.showSaveDialog`（默认目录 = 图片目录，默认名 `Phrontis打卡-yyyyMMdd.png`）→ `writeFileSync` → `shell.showItemInFolder`；用户取消返回 `{ok:false, canceled:true}` |

三处同步（改一处必改三处的铁律）：
- `electron/preload/index.ts`：`shareCardGet` / `shareCardSavePng`
- `src/types/index.ts`：WindowApi 声明 + `ShareCardData` 类型
- `src/lib/ipc.ts`：两行薄封装

### 2.4 指标口径（用户说"接入时再定"，这里给候选与数据源）

| 候选指标 | 数据源 | 备注 |
|---|---|---|
| **今日专注 分钟** | `sessions.json` 的 `minutes` 按日求和 | 数据最准、语义最实（默认建议） |
| **连续打卡 天** | habit records 的**日期并集**连续天数 | 打卡语义最正；**不是** `user:getStats.consecutiveDays`（那个口径是博客∪日程） |
| 本周 n/7 | habit records 本周去重天数 | 周一起始 |
| 附加热力 | 近 13 周每日打卡数分档 | 同时供 `heat` 风格主视觉 |

备选（若用户更想要"学习感"）：今日笔记字数（`knowledgeIndex`）、今日复习卡片数（`quizRepo` 统计）、连续学习天数（`user:getStats.consecutiveDays`）。**实现时按用户最终选择接三处纯函数即可，卡片布局不变**。

---

## 3. 渲染层设计（canvas 单源，杜绝"预览好看、导出跑版"）

### 3.1 为什么用 canvas 当唯一真相源

若预览走 DOM/CSS、导出走另存位图，必然出现两套实现漂移（字体、间距、渐变都可能不一致）。改为：**卡片只被绘制一次——画在 `<canvas>` 上，预览就是这张 canvas 的等比缩放显示**（1080×1920 画布，CSS 宽 540 显示）。导出/复制直接 `canvas.toDataURL()`，**所见即所得，无第二份实现**。

### 3.2 新文件与职责

```
src/components/share-card/
  ShareCardCanvas.tsx     ← 持有 <canvas>，调 renderShareCard 绘制；暴露 canvasRef
  renderShareCard.ts      ← **纯绘制函数**（不碰 DOM 全局，可在离屏 canvas 跑）
  shareCardStyles.ts      ← 三风格的视觉参数（颜色/几何/文案模板）
  ShareCardDialog.tsx     ← 模块内浮层：预览 + 三个动作按钮
  useShareCardData.ts     ← 取数（shareCard:get）+ 订阅数据变化刷新
src/modules/schedule/components/CheckinCardEntry.tsx  ← 打卡视图工具栏入口按钮
```

### 3.3 绘制函数签名

```ts
export type ShareCardStyle = 'peak' | 'page' | 'heat'
export interface RenderOpts { scale?: number }   // 默认 1 → 1080×1920

/** 纯绘制：不读 document / window / 环境；所有输入来自参数。
 *  seed 由 data.date 派生 → 同一天同一风格出图**完全一致**（可复现）。 */
export function renderShareCard(
  ctx: CanvasRenderingContext2D,
  data: ShareCardData,
  style: ShareCardStyle,
  opts?: RenderOpts,
): void
```

绘制要点（每一条都对应一个真实坑）：
1. **第一笔必须是 `fillRect` 底色**（纸白 `#fdfbf7` 或深色底）。透明 PNG 粘到微信可能显示黑底。
2. **字体**：`ctx.font` 用系统字体族（`"Segoe UI", sans-serif` / `Georgia, "Times New Roman", "SimSun", serif`），**不要依赖 web font**；若将来引入自定义字体，必须先 `await document.fonts.ready` 再绘制（canvas 不会等字体加载）。
3. 三风格几何全部程序化：纸山（四层山形由 `date` 做 seed 生成贝塞尔折线）、书页（大字格言 + 超大日期水印）、热力（13×7 马赛克，色阶取 `heat.levels`）。
4. 文本自适应：只在固定位置绘制，**不做自动折行**（格言按行硬编码在 `shareCardStyles.ts`，每行长度受控）——避免 canvas 断行算法与原型不一致。
5. 元素顺序：底 → 主视觉 → 信息面板 → 二维码（`ctx.drawImage(img)`，img 由 `qrDataUrl` 载入，需 `await img.decode()`）。

### 3.4 交互与落点

- **入口**：日程模块 · 打卡视图工具栏加一个图标按钮（`lucide` 里 `Share2` 或 `ImageDown`），`data-wb="checkinCardBtn"`（探针用）。
- **浮层**：模块内 overlay（走 `docs/ui-animation-plan.md` 的 `.kb-overlay`），内容 = 卡片预览 + 底部动作条：
  - `换一种风格`（轮换 peak → page → heat，立即重绘，风格存设置键）
  - `复制图片`（主按钮）
  - `另存为 PNG`
- **设置键**：`shareCardStyle`（默认 `'peak'`），钝解析：非法值回落默认（照 `workbenchLayout` 的钝规则哲学）。加进 `src/lib/settings.ts` 的 SETTINGS 定义。
- **动作实现**：
  - 复制：`const url = canvas.toDataURL('image/png')` → `copyImageUrlToClipboard(url)`（**复用现成 IPC**）→ toast「已复制，去微信 Ctrl+V」
  - 另存：`canvas.toBlob` → `arrayBuffer()` → `shareCardSavePng(bytes, name)` → 成功后 toast 提示路径
- **不做**：不自动弹卡片；不写入 vault（卡片是临时产物，按需另存）。

---

## 4. 契约与探针

### 4.1 新契约脚本 `.AGENT/scripts/share-card/verify-share-card.mjs`

> 范式照抄 `.AGENT/scripts/pdf-reader/verify-pdf-reader.mjs`：`check(name, ok, extra)` 累积 `pass`，strip-types 直接 import 真实 `.ts`。

| # | 断言组 | 用例 |
|---|---|---|
| ① | `checkinStreak` | 今天有打卡 → 含今天；**今天没打卡但昨天有 → 仍算连续**（宽限规则）；中间断一天 → 只算到断点前；空记录 → 0；跨月/跨年连续；重复同一天记录只算一次 |
| ② | `weekCells` | 周一起始对齐（周日当天：cells[6]=true）；本周完全无记录 → done=0、cells 全 false；跨周记录不串格 |
| ③ | `focusMinutesOn` | 多场次求和；非目标日期不计；`minutes` 缺失/负数容错跳过 |
| ④ | `heatLevels` | 长度 = weeks×7；分档边界（0/1/2/3 次 → level 0/1/2/3）；空窗口全 0 |
| ⑤ | `buildCardData` | 聚合口径一致性：`week.done` = `week.cells` 中 true 的数量；`heat.rate` = 非零格 ÷ 总格（四舍五入） |
| ⑥ | 负向：URL 单一来源 | 全仓剥注释扫描，`lousync.github.io` 只允许出现在 `electron/lib/productInfo.ts` |
| ⑦ | 负向：绘制函数不依赖 DOM | `renderShareCard.ts` 剥注释后不含 `document.` / `window.` / `getComputedStyle`（保证可在离屏 canvas 与测试环境跑） |
| ⑧ | 风格枚举与钝解析 | `ShareCardStyle` 三值；设置解析：`'bogus'`/`null`/`123` → 回落 `'peak'` |
| ⑨ | IPC 三处同步 | `shareCard:get` / `shareCard:savePng` 字符串在 preload 与 repos 一致；types/ipc.ts 均有声明 |

### 4.2 探针 `.AGENT/scripts/schedule-reminder/probes/probe-share-card.mjs`

> 运行：`node .AGENT/scripts/workbench-shell/probes/run-probe.mjs <该文件> --no-sandbox --disable-gpu`（复用现成宿主；探针文件放哪个目录按实现时就近原则，运行方式不变）

断言链：
1. 打开日程 → 打卡视图 → 点「打卡图」按钮 → overlay 出现，canvas 存在且 `width=1080 && height=1920`
2. canvas 非空：抽样若干像素点，断言不是全同色（能证明真画出内容而非空白画布）
3. 点「换一种风格」→ 重新抽样像素哈希，断言与切换前**不同**
4. 点「复制图片」→ 主进程侧 `clipboard.readImage()` 非空，且 `getSize()` = 1080×1920
5. 关闭 overlay → canvas 从 DOM 移除；重开 → 风格仍是刚才选的那种（设置持久化生效）

---

## 5. 命令与门禁（每步提交前跑）

```bash
# 类型检查（必须 --noEmit）
node_modules/.bin/tsc --noEmit -p tsconfig.web.json
node_modules/.bin/tsc --noEmit -p tsconfig.node.json

# 构建（cwd 必须大写盘符 E:\...）
npx electron-vite build

# 契约
node --experimental-strip-types --no-warnings .AGENT/scripts/share-card/verify-share-card.mjs

# 探针
node .AGENT/scripts/workbench-shell/probes/run-probe.mjs .AGENT/scripts/schedule-reminder/probes/probe-share-card.mjs --no-sandbox --disable-gpu
```

**已踩过的坑**：`bash` 里 `ls/grep/head` 可能 command not found → 用 Grep/Glob 工具或 `node -e`；build 前备份 `out/` 可能被 EPERM 拒 → 清空 `out/renderer/assets` 再 build；同一文件禁止并行 Edit；写盘后复核 `git log -1`；`git add` 只显式加点名路径。

---

## 6. 验收清单

- [ ] 打卡视图有「打卡图」入口，点开出现卡片预览，不自动弹、不打扰
- [ ] 三种风格都能切，切完卡片立即变化，且**重开浮层记住上次选的风格**
- [ ] 点「复制图片」→ 微信窗口 `Ctrl+V` 能直接粘出图片消息（这是本功能的最终判据）
- [ ] 点「另存为 PNG」→ 落盘 1080×1920，且资源管理器自动定位到该文件；取消对话框不报错
- [ ] 导出图与预览**逐像素一致**（同一张 canvas，不允许出现第二套绘制实现）
- [ ] 卡片底色不透明（不被微信渲染成黑底）
- [ ] 卡片二维码扫出来是官网 `https://lousync.github.io/Phrontis/`
- [ ] 无数据场景不崩：没有打卡记录 / 没有番茄钟场次 → 显示 0 与空热力，不出现 `NaN`
- [ ] 契约脚本 + 探针全 PASS；两个 tsc project 全绿
- [ ] 文案与动效守则：`docs/help-disclosure-pattern.md`、`docs/ui-animation-plan.md`

## 7. 本期不做

微信开放平台 SDK（**桌面平台不提供**，非技术难度问题）· 自动发送到微信（模拟按键，脆弱且属外挂性质）· `weixin://` 唤起（不能预置内容）· 局域网扫码取图（`lanShare` 复用是独立增强项）· 朋友圈专用竖版/方版 · 卡面 DIY（自定义背景图）

## 8. 后续增强（口子留对即可）

- **局域网扫码取图**：复用 `electron/lib/lanShare`，临时二维码指向 `http://<lan-ip>:<port>/card/xxx.png`；**注意与卡片内嵌的官网码语义分开**（卡片内是长期官网地址，分享面板里才是临时局域网地址，混用会让扫码结果不可预期）
- **移动端**：若将来有 Android/iOS 端，才走微信开放平台移动应用 SDK（企业主体 + 300 元认证 + 审核 + 签名校验）；且 SDK 图片分享有压缩与结构限制，业界普遍实为「存相册 → 唤起微信」两步
- **周/月报变体**：同一 canvas 绘制函数加 `variant` 参数即可复用
