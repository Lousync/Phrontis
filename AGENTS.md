# Phrontis

本地优先的 Windows 桌面「学习生活操作系统」——知识库 / 日程 / 打卡 / AI 教学集于一身，数据 100% 本地：正文是 Markdown，结构化数据是 JSON，**无数据库、无云**。npm 包名仍是 `knowbase`，**软件名 Phrontis**（原 Knowbase Programmer Edition）。

体感对标 VS Code：即时反馈（<100ms）· 不卡主线程 · 操作可逆 · 减少认知负荷。

> **本文件是本项目工程规则的唯一维护处。** 各 AI 工具的入口文件（`CLAUDE.md`、`.cursor/rules` 等）都指向这里；改规则请改这一份，不要在工具文件里各写一遍。

## 三条核心不变量

改动前先想清楚这三条，它们决定了数据该写在哪、由谁写。

1. **Vault = 唯一真相源。** 仓库 = 一个含 `.knowbase/` 的文件夹。正文是 `.md`（带 frontmatter），结构化数据是 `.knowbase/modules/*.json`。换电脑 = 拷走文件夹。
2. **编辑器 = 唯一正文写入方。** 知识库是阅读器 + 结构维护（建删目录 / 空间 / 笔记本、导入、重命名、排序、拖拽），**侧栏没有写正文的能力**。无 frontmatter id 的 md = 草稿，知识库不显示。
3. **渲染层不接触绝对路径。** IPC 只传 `{ rootId, relPath }`，主进程侧由 `workspaceManager` + `pathGuard` 解析落盘。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面 | Electron 33 —— **`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`**，preload 只用 contextBridge / ipcRenderer / webUtils |
| 渲染 | React 19 + TypeScript 5.7 + Tailwind v4 |
| 构建 | electron-vite（dev 端口 **7173**）+ electron-builder |
| 编辑器 | Monaco 0.56 |
| 存储 | **纯 JSON 文件** + Markdown。`sql.js` 已随 R6 去库化整体退役，**真实调用只剩 `electron/lib/ccSwitchImport.ts`**（解析 CC Switch 的 SQLite 配置，一次性用途） |
| 其他 | d3-force（图谱）· pdfjs-dist（PDF）· katex / highlight.js |

> 遇到旧文档里的「`saveToDisk()` 持久化」「`blog_` / `schedule_` 等表名前缀」「四模块架构」「better-sqlite3 / Milkdown 选型」，一律视为 v3.0.0 之前的过期描述。

## 架构地图

```
electron/
  main/index.ts        窗口管理（frameless + 自绘标题栏 + 单实例）
  preload/             IPC 桥接（contextBridge）
  database/repositories/   ⚠️ 名字有误导：这里早已没有数据库。
                       R6 去库化后它**没改名**，现在是 IPC handler 注册层
                       （21 个文件、main 注册 29 个 handler，形如 registerXxxHandlers()）
                       内部一律转发给 lib/kbStore/。**不是死代码，别删。**
  lib/kbStore/         Vault JSON 实现层 = 真相源（*VaultRepo.ts / jsonStore / mdStore /
                       knowledgeIndex / graphIndex / ignoreFile / welcomeDoc）
  lib/                 其余主进程业务：agentService·aiTools·builtinTools·llmService·
                       mcpManager·pluginRegistry·pluginHostGateway·pluginSigning·
                       workspaceManager·pathGuard·helpService·updateService·lanShare
  devbridge/           开发期调试桥（KNOWBASE_DEV_BRIDGE=1 → 端口 7465）
src/
  App.tsx              Tab 宿主：**Tab 首挂后 display:none 保活，切换不卸载**
  modules/             ai-teaching·blog·devtools·editor·help·knowledge·moments·
                       plugins·recycle·schedule·settings·toolbox·user（+ shared）
  components/shared/   TitleBar·StatusBar·TabBar·Toast·Collapsible …
  lib/                 ipc.ts（IPC 封装）· settings.ts（SETTINGS 定义）· usePresence ·
                       fileOpHistory·toast·deleteFx …
  types/index.ts       **跨线共享汇点：多线并行开工前先冻结接口**
```

数据与设置目录：`%APPDATA%/knowbase/`（dev 环境为 `knowbase (dev)`）——存 recentVaults / currentVaultId / 全局设置。

---

## 铁律

### 数据与 IPC
1. 主进程写盘后**必须** `windowBus.broadcastDataChanged(scope)` —— 唯一的界面刷新通道。`data:notify` 语义不同（会排除发送方），别混用。写文件走 `jsonStore.writeJsonOrThrow`。
2. **AI 工具读写模块数据：走 repo 抽出的 export 业务函数，不要给 `.knowbase` 开写白名单。** `isAiWritableFile` 对点目录恒返回 false，那是「AI 只能写仓库里的 .md / .txt」这条不变量。主进程中的 AI 工具拿不到 `ipcRenderer`，所以 IPC handler 退化为转发层，两边共用同一实现。
3. AI 写工具 `requires: 'write'` 会被权限系统**预过滤出模型视野**——那不是报错，是设计。排查顺序：settings.json 权限 → plugin-audit.json → 磁盘。
4. 自动保存三件事：内容与 id 原子绑定 · 防抖窗口清空必须置 null · update 带 `expectedUpdatedAt` 做冲突检测（参考 `PasswordVault.tsx`）。
5. 撤销栈 `fileOpHistory.ts` 两个编辑区共用；`renameWorkspacePath` 有 `existsSync(to)` 保护。
6. `.ignore` 过滤只插在 `scanMarkdownFiles` 一处，全链路即生效（不要让每处查询各自过滤）。
7. `TodoItem` 播完动画才回调（520 / 920ms），父组件用乐观更新接管。

### 渲染层
8. **dev 主进程没有热重载** —— 改了 `electron/` 必须重启 dev。
9. `-webkit-user-drag: none` 会被继承，拖拽源要挂 `.kb-draggable`；日程类拖拽用 **pointer events**（HTML5 拖放会静默失败）；pointer 手势结束会补发 click，需要 `dragGuard` 250ms 窗口兜底 + 手柄上 `stopPropagation`。
10. `kbview://` 是独立 scheme + iframe sandbox，**绝不 srcdoc / blob**；白名单三处必须同步。欢迎页只渲染仓库根 `欢迎.html`（无 frontmatter，合成 id `kb-welcome-doc`；收藏 / 改名 / 排序一律拒绝）。
11. 长列表用 `content-visibility`（`.kb-cv` / `.kb-cv-sm`，**加在「列表项」上**，估值 120px / 60px 一项）——只有几十行的短列表**不要**加，估值会把滚动高度抬到实际的数倍、滚动条乱跳；`React.memo` 要求 props 引用稳定；effect 依赖数组注意 TDZ（把数组整体后移）。
    **模块根节点必须 `h-full`，不能写 `flex-1`** —— 槽位容器（`App.tsx` 的 `renderMounted`）是**块级** div（只有 `flex-1 min-h-0`、没有 `flex` / `flex-col`），`flex-1` 在里面完全不生效 → 根节点高度随内容增长、永不溢出 → 内层 `overflow-y-auto` 拿不到可滚高度 → **表现是「界面能显示，但滚轮没反应」**，且 `html/body/#root` 是 `overflow:hidden`，溢出部分直接被裁掉、连页面级滚动都没有。`help` / `user` / `ai-teaching` / `blog` 四个模块的根节点都是 `h-full`，照抄。
12. 冗余说明文字一律按 `docs/help-disclosure-pattern.md` 处理：bar 类用 swap-bar、信息卡用 hover 展开卡、强引导首启可见 +「知道了」记忆。**文案只收不删，禁醒目标签。**
13. **所有操作都必须带动效** —— 面板开合、列表增删、弹层进出、按钮与开关反馈、视图 / Tab 切换、状态变更提示，一律走 `docs/ui-animation-plan.md` 已定的令牌与工具类（`.kb-view-in` / `.kb-overlay` / `.kb-pop` / `.kb-collapse` / `.kb-chevron` / `.kb-item-in(-out)` / `.kb-micro-pop` / `.kb-toast-in(-out)` 等），**不要另造过渡、不要用 `transition-all` 临时凑**；若某类交互还没有对应工具类，**先补基建（改 `src/styles/index.css` + 更新该文档）再落码**，不要就地写一次性动画。硬约束：① 性能只动 `transform` / `opacity` / `grid-rows`（后者是 `.kb-collapse` 的唯一例外，已验证成本可接受），拖拽**跟手过程不加动画**，全部动画带 `prefers-reduced-motion` 兜底；② 主题切换**禁用通配 `*` 过渡**，走 View Transition + 容器级降级；③ Tailwind v4 的 `rotate-*` / `translate-*` 是独立属性，收不到 `transition-transform`，一律用 `.kb-chevron`；④ 弹层动效走 `.kb-overlay > :first-child` 等「首子元素继承」规则，调用方只挂一个类；⑤ 折叠容器**外层 grid 必须常驻 DOM、只懒挂内层子树**，且用「延迟卸载 + open 类切换」而非条件渲染。
14. 日程列清单有三处手工重复（`TodoColumn` / `TODO_COLUMNS` / `switch(col)`）：**加列漏 case = patch 静默丢弃、IPC 照样成功**，表象是「按钮点了没反应」。加列必须补跑 `.AGENT/scripts/schedule-reminder/verify-snooze-persist.mjs` 的 `COLUMN_CASES`。
15. 错题本 `source_space` 推导（`quizRepo.vaultResolveSource`）：上溯**必须走到 space 才 break**，notebook 只赋值不 break；写该字段的迁移 / 播种数据按此口径。演示数据工具 `.AGENT/scripts/demo-seed/`（先 `--backup`；重跑 `--write` 前用 `backup/quiz/records.json` 复位）。

### AI 工具
16. **工具 schema 就是每轮成本**（度量脚本 `.AGENT/scripts/ai-tools-audit/`）：core 14 个全量常驻 ≈7.7k tok/轮，ondemand 17 个默认折叠。新增默认 `tier: 'ondemand'`，单工具 schema **≤800 字符**（脚本末尾有红线自检，量的是 `inputSchema` 去换行/缩进/注释后的发包字符数），**严禁在 description 里罗列返回字段**。
17. 结果侧只做两件事：**拿得少**（给默认值 / 上限）、**丢得早**（`MAX_TOOL_RESULT_CHARS=24000` 摘要替代 + `KEEP_RECENT_TOOL_RESULTS=3`）。压缩必须是纯函数且幂等，否则打散 prompt cache。
18. 新模块接入 AI 工具的接线清单：`DataChangeScope` 加该模块 scope + 对应面板挂 `useDataChanged`（否则表象是「AI 说改好了、界面没反应，得关掉重开」）；提供 `*ResolveOrCreate(name)` 命名桥；查询工具**不得**有建标签这类副作用；新写工具要同步补 `builtin.tool.request` 的 description 清单。
19. 出题 → 答题闭环：组卷落成知识库 `.md`，页内每题一个 ```` ```quiz ```` 围栏；答错自动回流错题本，**题号必须重排 1..N**（记录里的 `snapshot.no` 是原页序号，直接沿用会把错题记到别的题上）。契约验证脚本 `.AGENT/scripts/quiz-tools/verify-quiz-fence.mjs`。

### 安全与构建
20. Vite 分包：`manualChunks` **禁止兜底 `return 'vendor'`**；只切大依赖（monaco / pdfjs / heic-to 的宿主组件 lazy），业务模块静态 import；改完必须重算首屏静态闭包。
21. **同一文件禁止并行 Edit** —— 并行会静默互相覆盖，而工具仍回 "Successfully edited"。同文件串行、不同文件才可并行；改完 grep 复核关键标识。
22. **`electron/database/` 不是死代码**：R6 去库化后目录名未改，它现在是 IPC handler 注册层（29 个 `registerXxxHandlers()`，转发给 `lib/kbStore`），**别删**。`grep sql.js` 只会命中注释里的说明文字。
23. **沙箱构建**：build 前 `mv out out_prev_xxx` 可能被整体拒绝（EPERM）；退路是删空 `out/renderer/assets` 再 build。
24. **`CHANGELOG.md` 是「应用内更新说明」的唯一源** —— 改完必须重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs` 生成 `electron/lib/releaseNotes/data.ts`（忘跑 = 页面显示上一版内容，无任何报错；契约脚本 §4 会拦住）。触发规则（只在 major.minor 变化时自动打开 / 首装不弹 / **页面成功展示后**才推进基线）的纯函数在 `electron/lib/releaseNotes/judge.ts` —— 它是零依赖独立文件就是为了让脚本能 import，**改规则必须同步补 `.AGENT/scripts/release-notes/verify-release-notes.mjs` 的用例表**，别把规则写回 `index.ts`。

---

## 开发流程

**做新功能或界面改造，按顺序走这三步。每一步的产出没经用户确认，不要进入下一步。**
（适用于新功能与界面改造；纯 bug 修复、单点小改可直接动手，但第 3 条同样适用。）

### 1. 提炼需求 → 反问确认

把用户的口语描述**整理成条目化的需求清单**：要解决什么问题、涉及哪些模块、已经明确了什么、还有哪些没定。然后**把这份清单回给用户，问一句「这是否符合你的预期」**。

不要拿着模糊需求直接开工——歧义会在编码阶段放大成返工。

### 2. 出 HTML 原型 → 体验讨论

UI 相关的改动，先产出一份**单文件、浏览器直接打开、可真实交互**的 HTML 原型，让用户点一遍再讨论。原型放本地工作区（不进 git），方向定稿后按 `docs/DESIGN-ARCHIVE.md` 归档。

优先拿原型对话，而不是散文描述或静态截图——用户要能「上手摸」。

### 3. 有疑问当场问 → 确认后出技术方案 → 编码

- **任何歧义、多个可选实现、影响面不确定的地方，立即询问**，不要替用户做决定；也不要为了显得周全而自行扩大需求范围。
- 用户确认无误后，**先写实现方案**（改哪些文件、走什么路径、有哪些取舍），再动手编码。方案阶段发现新问题，回到「询问」这一步。

## 工作流

```bash
npm run dev      # electron-vite dev（端口 7173）；启动前删掉 ELECTRON_RUN_AS_NODE 环境变量
npm run build    # electron-vite build —— 注意：它不做类型检查
npm run pack     # build + electron-builder 打包
```

- **类型门禁**（build 通过 ≠ 类型正确，必须单独跑）：
  `npx tsc --noEmit -p tsconfig.node.json` 与 `npx tsc --noEmit -p tsconfig.web.json`
- **提交用系统 git 2.37**。Git Bash 自带的 2.55 在更新嵌套分支 ref 时会删掉 `refs/heads/<a>/` 整个父目录，导致提交变孤儿、分支「凭空消失」。
- **改动越大越要配独立的契约验证脚本** —— 只跑 tsc 不够。

## 提示与设置

- 所有用户反馈走右下角 Toast：`showToast({ type: 'error' | 'warning' | 'info', message, detail? })`（`src/lib/toast.ts`）。**禁止** `alert()` / `confirm()`。
- **设置项的唯一真源是 `src/lib/settings.ts` 的 `SETTINGS` 对象** —— 一个 entry = key + 默认值 + 描述，类型由 `SettingsValue<K>` 自动推导，前后端共用。不要在组件里硬编码配置常数（`setTimeout(..., 2000)` 的 2000、回收站保留天数等都要走 `getSetting()`），也不要在多个文件重复定义同一份选项列表。
- 新增 setting 两步：`SETTINGS` 加一行 → 组件里 `getSetting('key')`。设置项要进搜索需 `ui: true` + anchor + `data-setting-anchor`。

## 文档指针

| 要了解什么 | 去哪 |
|---|---|
| 重构总纲（R0–R7 全过程、决策编号 D1–D9） | `docs/rework-master-plan.md` |
| AI 教学模块 | `docs/ai-teaching-module-rework.md` |
| UI 变更流水 | `docs/ui-updates.md` |
| 动效方案与落地进度 | `docs/ui-animation-plan.md` |
| 帮助披露规范 | `docs/help-disclosure-pattern.md` |
| 更新说明（发版告知机制 / 触发规则 / 数据三层） | `docs/release-notes-design.md` |
| 未决问题收集 | `docs/verification-issues-*.md` |
| 设计文档 / 原型去哪了 | `docs/DESIGN-ARCHIVE.md` —— 已落码或已搁置的设计方案、原型、视觉稿，统一归档在独立的设计过程留存库 **DesignProcess** |
| 语音输入 ASR | **已评估暂缓，长期不做**（`docs/voice-input-design.md` 已论证到落码级）。勿重复调研 |

## CodeGraph

仓库根存在 `.codegraph/` 时，**先查 CodeGraph 再 grep / find**：

- MCP 工具：`codegraph_explore`（一次调用给出相关符号的逐字源码 + 调用路径）· `codegraph_node`（单符号源码 + callers，或整文件带行号）
- Shell（始终可用）：`codegraph explore "<符号名或问题>"` · `codegraph node <符号或文件>`

没有 `.codegraph/` 就跳过——是否索引由用户决定。
