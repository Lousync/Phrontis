# 批 3 真机验收清单（图片渲染与查看）

> 状态：**待跑**（2026-10-13，v3.5.0 线）。
> 方案：`docs/image-viewer-design.md` · 原型：`tmp/image-viewer-proto/index.html`
> 契约：`.AGENT/scripts/image-viewer/verify-image-viewer.mjs`（124）· `verify-image-math.mjs`（75）
> 实机探针：`.AGENT/scripts/image-viewer/probe-image-viewer.mjs`

## 0. 为什么必须真机跑一遍

本批的两个契约都只能证「**源码接线**是对的」：

- `verify-image-viewer.mjs` 读源码断言（分支顺序 / 锚点 / 上限常量 / 格式集合 ⊆ 主进程白名单）；
- `verify-image-math.mjs` 把 `src/lib/imageView.ts` 与 `imageFormats.ts` 的真函数 import 进来跑性质。

它们证不了的三件事，恰好是本批的全部价值：

1. **落点** —— 图片此前一律落元信息卡（批 1 的根因），是否真的进了查看器；
2. **三条非正常态** —— 过大（**像素**那条）/ 解码失败 / 加载中，是否真的各落各的卡；
3. **手感** —— 缩放锚点、拖拽夹取、旋转后的适应比例。这三样错了**不报错**，只是「用起来不对劲」。

★ 第 3 类是本批最需要人眼的部分。`Ctrl+滚轮` 的锚点口径若写错，偏移量是**恒定**的
（`(k-1)·视口/2`），现象是「缩放本身正常、只是目标每滚一下就跑掉」—— 原型阶段就是靠
`_math.mjs` 的性质断言才发现的，肉眼极难定位。**务必挑一个明显的特征点对准了再滚**
（fixture 里的 `照片.png` 有 100px 网格，交叉点最好认）。

## 1. 前置

```powershell
# 1) 播种 fixture（造 5 张图 + 1 篇引用笔记；全部落在 tmp/vault-fixture/，不碰真实仓库）
node .AGENT/scripts/image-viewer/seed-batch3-fixture.mjs

# 2) 起 dev（启动前删掉 ELECTRON_RUN_AS_NODE）
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dev

# 3) 另开一个终端跑探针
node .AGENT/scripts/image-viewer/probe-image-viewer.mjs
```

fixture 清单（`tmp/vault-fixture/批3图片/`）：

| 文件 | 形态 | 期望落点 |
|---|---|---|
| `照片.png` | 800×600 RGB + 100px 网格 | 查看器，顶栏中段「800 × 600」 |
| `透明图.png` | 600×400 RGBA（右下全透明 / 左侧半透明） | 查看器 + **棋盘格底** |
| `超像素.png` | IHDR 声称 20000×20000，实际几百字节 | 「过大」卡，成因是**像素**那条 |
| `损坏.png` | 头可读 800×600、IDAT 非法 | 「解码失败」卡 + 「重新读取」 |
| `示意.svg` | 640×360 矢量 | 查看器，`⋮` 里有「看源码」 |
| `批3引用/图片引用.md` | 三张引用：正常 / 路径不存在 / 非图片扩展名 | 阅读态 1 张 blob 图 + 2 个破图占位 |

## 2. 探针自动覆盖的（`probe-image-viewer.mjs`）

| 段 | 验什么 |
|---|---|
| §2 | 正常 PNG → `imageCanvas`；`src` 是 `blob:`（**不是** `data:base64`）；解码出真实宽高；顶栏控件簇是 `inline` 变体；中段「宽 × 高」；**无保存点**；PNG 铺棋盘格 |
| §3 | 透明 PNG 带棋盘格；**JPEG 不铺**（纯色底）—— 两侧对照 |
| §4 | 超像素 → `toobig`，卡上写明是**像素**超限并报出 20000×20000；无控件簇（没有可缩放的东西就不给按钮） |
| §5 | 损坏 → `broken` + 「重新读取」；点重试后仍是 broken（文件确实坏着） |
| §6 | `⋮` 的「查看」组四项；点「实际大小」→ 读数 100%；点「向右旋转」→ `rotate(90deg)`；快捷键 `1` / `0` |
| §7 | SVG 默认渲染 → 「看源码」进 Monaco（XML 高亮）→ 「看图片」回查看器 |
| §8 | 沉浸态：**顶栏消失** + 控件退成 `float` 变体；`Esc` 退出后顶栏回来 |
| §9 | md 内联：非附件区引用显示为 blob 图；打错的路径显示 `mdImgBroken` 占位；**没有**停在「图片加载中」 |

## 3. 必须手点的（探针刻意不做）

探针不做手势合成 —— 失败时你分不清是功能坏了还是探针没模拟对。

### 3.1 缩放锚点（本批最关键的一条）

1. 打开 `照片.png`；
2. 把光标停在**某个网格交叉点**上（记住那个位置）；
3. `Ctrl` + 滚轮放大几档；
4. **判据**：那个交叉点必须**始终待在光标下面**。若它随缩放往某个方向漂，就是锚点口径错了
   （见 §0 的说明）。再缩小几档复核一次。
5. 在**沉浸态**里重做一遍（浮条控件与顶栏控件是同一份逻辑，应当表现一致）。

### 3.2 拖拽夹取

1. 放大到图明显超出视口 → 往右下拖到尽头；
   **判据**：图不会消失，停在「边缘 + 48px」处；
2. 缩回小于视口 → 图自动回到正中；
   **判据**：此时光标不该是抓手（`clampPan` 会把平移按回 0，拖了等于没拖），
   即 `.kb-img-canvas[data-pannable='0']`。

### 3.3 旋转与适应比例

1. `]` 转 90°；
   **判据**：**适应比例要跟着换**（800×600 横图转成 600×800 竖图后，适应比例变小、图不溢出视口）；
2. 转 270° 回到 0°；
3. 自由缩放到某个比例后再旋转；
   **判据**：比例保持不变（旋转只改角度、不夺用户的手动缩放），但平移归零（否则图会飞出视口）。

### 3.4 双击与适应窗口不放大

1. 双击 → 100%；再双击 → 适应窗口（来回切）；
2. 打开 `小图.png`（若 fixture 里没有，随便找一张小于视口的图）；
   **判据**：适应窗口后**不被放大**（拍板 D8：停在 100%，居中一小块）。想大看用放大钮或双击。

### 3.5 窗口尺寸变化

1. 处于「适应窗口」时拖窗口边缘；
   **判据**：比例跟着变（读数变化）；
2. 手动缩放过（读数不再是适应值）后再拖窗口；
   **判据**：比例**不变**（`fit` 已置 null ⇒ 不再被拉回），只做平移夹取。

### 3.6 写通道不受影响（回归）

1. 打开一个仓库里的 `.py` / `.txt`，改一个字 → 顶栏绿点转橙再转绿 → 关掉再开，改动还在；
2. 打开 `示意.svg` → `⋮` →「看源码」→ 改一个字 → 保存 → 切回「看图片」；
   **判据**：改动能存进 SVG 文件（`ws:writeFile` 无扩展名白名单），且**不注入 frontmatter**；
3. 打开一个 `.md`，确认 `![](图片/照片.png)` 能显示，且**改这个 md 不会影响图片文件**。

### 3.7 边界

- **沉浸态与 PDF 不打架**：先打开一个 PDF 进沉浸、`Esc` 退出；再打开图片进沉浸、`Esc` 退出。
  两轮都不该出现「退出沉浸的同时把页签关掉」（批 2 修过的 Esc 冲突）。
- **分屏**：把图片拖到副栏 → 两栏各挂各的顶栏与控件簇，互不抢槽（缩放互不影响）。
- **文件树图标**：图片条目现在应有**图片图标**（此前一律通用文件图标）。
- **换仓库**：切到另一个仓库再打开同名的 `图片/照片.png`；
  **判据**：显示的是**新仓库**那张（老实现缓存键只有路径，会命中上一个仓库的图 —— 本批顺手修了）。

## 4. 已知的存量红（与本批无关，**不要**当成本批回归）

判定方式：这些断言读的文件**不在 `git status` 的改动清单里** ⇒ 内容与 HEAD 逐字节相同
⇒ 结果与干净 HEAD 一致。逐个核过，不是推断。

| 契约 | 存量失败 | 目标文件（本批未动） |
|---|---|---|
| `workbench-shell` | 4 项：E6f / G4 / G9 / N13b | `App.tsx` · `RightPanel` · `PageTabStrip` · `StatusBar` · `VaultTree.tsx` |
| `book-market-tools` | 2 项：内置写工具清单未覆盖 `mindmap / inventory / course.*` | AI 教学工具清单 |
| `md-entry-fields` | 1 项：`schemaVersion` 未抬到 6 | 知识库索引 schema |
| `tray-icon` | 1 项：B1 兜底常量块 | 托盘图标常量 |
| `sticky-bottom` | 抛错：找不到 `[activeId]` 的 effect | `src/modules/ai-teaching/index.tsx` |
| `habit-link-removal` | 1 项：Habit 的 `link` 字段残留 | 习惯模块 |
| `outline-dest-page` | 1 项 | PDF 大纲 |
| `terminal` | 2 项 | 终端模块 |
| `conversational-flow` | 1 项 | AI 教学会话流 |
| `paste-external` | 1 项：J1 符号链接源被拒 | 环境无法创建 junction，用例未执行 |

**本批期间修掉的三条陈旧断言**（都是「断言了重构后已不存在的写法」，留着会掩盖真回归）：

| 契约 | 原先锁什么 | 实际是什么 |
|---|---|---|
| `workbench-shell` N8 | 菜单的层类名出现在 `WorkbenchFileTree.tsx` 里 | 文件树已改用共享组件 `FileContextMenu.tsx`（一颗组件服务 6 个调用点），层类名正确地住在那里。拆成两条：共享组件里有 portal + 文件树确实用它 |
| `ai-assistant/perception` J17d | `const inlineOn = …` 这个**局部常量** | 批 2 把 ✨ 搬进 `NoteTopBar` 后它是**下传的 prop**（`inlineOn={…}`）—— 判据「取自设置真值」没变 |
| `content-routing` C4/D3/D4/E6 | paneDoc 的两项条件 / `FileMetaCard` 导出 `FileInfoRows` / ⋮ else 分支窗口 1200 / 复位 effect 的旧写法 | 批 3 加了 svg 源码态与图片一项；`FileInfoRows` 上移到 `src/components/shared/`（解 shared→module 层次倒挂） |

## 5. 沙箱内跑不了、需要放宽权限的契约

这 7 个要往 `tmp/` 或自身目录写临时文件，`workspace-write` 沙箱会拒（EPERM）。
放宽后**全部 exit=0**，不是断言失败：

`ai-tools-audit/verify-prompt-cache` · `shared/verify-data-changed` · `ai-teaching/verify-inventory` ·
`ai-teaching/verify-profile-banner` · `ai-tools-audit/verify-tool-result-cap` ·
`blog-summary/verify-summary-files` · `shared/verify-resizable-panel`
