# Phrontis

本地优先的 Windows 桌面「学习生活操作系统」——知识库 / 日程 / 打卡 / AI 教学集于一身，数据 100% 本地：正文是 Markdown，结构化数据是 JSON，**无数据库、无云**。npm 包名仍是 `knowbase`，软件名 Phrontis。

体感对标 VS Code：即时反馈（<100ms）· 不卡主线程 · 操作可逆 · 减少认知负荷。

> **本文件是工程规则的唯一维护处**，各工具入口文件（`CLAUDE.md`、`.cursor/rules`）都指向这里，改规则改这一份。
> **写作口径：本文件只放「规则 + 指针」。** 机制解释、操作手法、单模块实现细节一律进 skill 或 `docs/` —— 本文件每轮都注入，写在这里等于每轮付一遍钱。

## 三条核心不变量

这三条决定数据写在哪、由谁写。

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
| 存储 | **纯 JSON 文件** + Markdown。`sql.js` 已随 R6 去库化退役，真实调用只剩 `electron/lib/ccSwitchImport.ts` |
| 其他 | d3-force（图谱）· pdfjs-dist（PDF）· katex / highlight.js |

> 旧文档里的「`saveToDisk()`」「`blog_` / `schedule_` 表前缀」「四模块架构」「Knowbase Programmer Edition」「better-sqlite3 / Milkdown」一律是 v3.0.0 之前的过期描述。

## 架构地图

```
electron/
  main/index.ts        窗口管理（frameless + 自绘标题栏 + 单实例）
  preload/             IPC 桥接（contextBridge）
  database/repositories/   IPC handler 注册层（21 文件 / 29 个 registerXxxHandlers），
                       一律转发给 lib/kbStore/ —— 目录名里的 database 是历史遗留
  lib/kbStore/         Vault JSON 实现层 = 真相源（*VaultRepo.ts / jsonStore / mdStore /
                       knowledgeIndex / graphIndex / ignoreFile / welcomeDoc）
  lib/                 其余主进程业务：agentService·aiTools·builtinTools·llmService·
                       mcpManager·pluginRegistry·pluginHostGateway·pluginSigning·
                       workspaceManager·pathGuard·helpService·updateService·lanShare
  devbridge/           开发期调试桥（KNOWBASE_DEV_BRIDGE=1 → 端口 7465）
src/
  App.tsx              Tab 宿主：**Tab 首挂后 display:none 保活，切换不卸载**
  modules/             功能模块 —— **清单唯一真相源是 `src/lib/appModules.ts`，别在此处手抄**
  components/shared/   TitleBar·StatusBar·TabBar·Toast·Collapsible …
  lib/                 ipc.ts（IPC 封装）· settings.ts（SETTINGS 定义）· usePresence ·
                       fileOpHistory·toast·deleteFx …
  types/index.ts       **跨线共享汇点：多线并行开工前先冻结接口**
```

数据与设置目录：`%APPDATA%/knowbase/`（dev 环境为 `knowbase (dev)`）——存 recentVaults / currentVaultId / 全局设置。

---

## 铁律

> 判据型问题（布局 / 滚动 / 配色 / 沙箱报错 / git ref）先读对应 skill：`web-layout-scroll-verify`、`windows-sandbox-ops` 等，此处不重复机制。

### 数据与 IPC
1. 主进程写盘后**必须** `windowBus.broadcastDataChanged(scope)` —— 唯一的界面刷新通道。`data:notify` 语义不同（排除发送方），别混用。写文件走 `jsonStore.writeJsonOrThrow`。
2. **AI 工具读写模块数据：走 repo 抽出的 export 业务函数，不要给 `.knowbase` 开写白名单**（`isAiWritableFile` 对点目录恒 false）。主进程 AI 工具拿不到 `ipcRenderer`，故 IPC handler 只是转发层，两边共用同一实现。
3. AI 写工具 `requires: 'write'` 会被权限系统**预过滤出模型视野**——那不是报错，是设计。排查顺序：settings.json 权限 → plugin-audit.json → 磁盘。
4. 自动保存三件事：内容与 id 原子绑定 · 防抖窗口清空必须置 null · update 带 `expectedUpdatedAt` 做冲突检测（参考 `PasswordVault.tsx`）。
5. 撤销栈 `fileOpHistory.ts` 两个编辑区共用；`renameWorkspacePath` 有 `existsSync(to)` 保护。
6. `.ignore` 过滤只插在 `scanMarkdownFiles` 一处，全链路即生效（不要让每处查询各自过滤）。
7. `TodoItem` 播完动画才回调（520 / 920ms），父组件用乐观更新接管。

### 渲染层
8. **dev 主进程没有热重载** —— 改了 `electron/` 必须重启 dev。
9. `-webkit-user-drag: none` 会被继承，拖拽源要挂 `.kb-draggable`；日程类拖拽用 **pointer events**（HTML5 拖放会静默失败）；pointer 手势结束会补发 click，需要 `dragGuard` 250ms 窗口兜底 + 手柄上 `stopPropagation`。
10. `kbview://` 是独立 scheme + iframe sandbox，**绝不 srcdoc / blob**；白名单三处必须同步。欢迎页只渲染仓库根 `欢迎.html`（合成 id `kb-welcome-doc`；收藏 / 改名 / 排序一律拒绝）。
    **唯一例外：电子书内容帧**（epub 等）—— 引擎分页必须读 `iframe.contentDocument`（跨源恒 `null` → 分页全废），故内容帧只能同源 = `blob:`。★ 配套两条硬约束：**sandbox 永不含 `allow-scripts`**、**`script-src` 永不含 `'unsafe-inline'`** —— 上游引擎**不做内容净化**（内联 `<script>` / `onerror` 属性原样存活），这两条是仅有的防线，契约有负向断言锁。机制与升级手法见 `src/vendor/foliate/README.md`。**取内容帧只能走 CDP**（帧在 closed shadow root 内，`window.frames` / `querySelector` 都数不到它）—— 手法见 `probes/probe-epub-reader.mjs` 头注。
11. 长列表用 `content-visibility`（`.kb-cv` / `.kb-cv-sm`，**加在「列表项」上**，估值 120px / 60px 一项）——只有几十行的短列表**不要**加（估值会抬虚滚动高度、滚动条乱跳）；`React.memo` 要 props 引用稳定；effect 依赖数组注意 TDZ（把数组整体后移）。
    **模块根节点必须 `h-full`，不能写 `flex-1`** —— 槽位容器是块级 div，`flex-1` 在里面是死属性，表象是「界面能显示，但滚轮没反应」。机制与判据见 skill `web-layout-scroll-verify`。
12. 冗余说明文字一律按 `docs/help-disclosure-pattern.md` 处理：bar 类用 swap-bar、信息卡用 hover 展开卡、强引导首启可见 +「知道了」记忆。**文案只收不删，禁醒目标签。**
13. **所有操作都必须带动效** —— 面板开合 / 列表增删 / 弹层进出 / 按钮与开关反馈 / 视图与 Tab 切换 / 状态变更提示，一律走 `docs/ui-animation-plan.md` 已定的令牌与工具类（`.kb-view-in` / `.kb-overlay` / `.kb-pop` / `.kb-collapse` / `.kb-chevron` / `.kb-item-in(-out)` / `.kb-micro-pop` / `.kb-toast-in(-out)`），**不要另造过渡、不要用 `transition-all` 临时凑**；缺对应工具类时**先补基建（`src/styles/index.css` + 更新该文档）再落码**。硬约束：① 只动 `transform` / `opacity` / `grid-rows`（后者仅 `.kb-collapse`，已验证），拖拽跟手不加动画，全部带 `prefers-reduced-motion` 兜底；② 主题切换禁用通配 `*` 过渡，走 View Transition + 容器级降级；③ Tailwind v4 的 `rotate-*` / `translate-*` 收不到 `transition-transform`，一律用 `.kb-chevron`；④ 弹层走「首子元素继承」规则，调用方只挂一个类；⑤ 折叠容器外层 grid 常驻 DOM、只懒挂内层子树，用「延迟卸载 + open 类切换」而非条件渲染。
14. 日程列清单有三处手工重复（`TodoColumn` / `TODO_COLUMNS` / `switch(col)`）：**加列漏 case = patch 静默丢弃、IPC 照样成功**，表象是「按钮点了没反应」。加列必须补跑 `.AGENT/scripts/schedule-reminder/verify-snooze-persist.mjs` 的 `COLUMN_CASES`。
15. 错题本 `source_space` 推导（`quizRepo.vaultResolveSource`）：上溯**必须走到 space 才 break**，notebook 只赋值不 break。演示数据工具 `.AGENT/scripts/demo-seed/`。

### AI 工具
16. **工具 schema 就是每轮成本**（`.AGENT/scripts/ai-tools-audit/`）：core 14 个常驻 ≈7.7k tok/轮，ondemand 17 个默认折叠。新增默认 `tier: 'ondemand'`，单工具 schema **≤800 字符**，**严禁在 description 里罗列返回字段**。
17. 结果侧只做两件事：**拿得少**（默认值 / 上限）、**丢得早**（`MAX_TOOL_RESULT_CHARS=24000` 摘要替代 + `KEEP_RECENT_TOOL_RESULTS=3`）。压缩必须是纯函数且幂等，否则打散 prompt cache。
18. 新模块接入 AI 工具的接线清单：`DataChangeScope` 加该模块 scope + 对应面板挂 `useDataChanged`（否则表象是「AI 说改好了、界面没反应」）；提供 `*ResolveOrCreate(name)` 命名桥；查询工具**不得**有建标签这类副作用；新写工具同步补 `builtin.tool.request` 的 description 清单。
19. 出题 → 答题闭环：组卷落成知识库 `.md`，页内每题一个 ` ```quiz ` 围栏；答错自动回流错题本，**题号必须重排 1..N**（`snapshot.no` 是原页序号，沿用会把错题记到别的题上）。契约 `.AGENT/scripts/quiz-tools/verify-quiz-fence.mjs`。

### 安全与构建
20. Vite 分包：`manualChunks` **禁止兜底 `return 'vendor'`**；只切大依赖（monaco / pdfjs / heic-to 的宿主组件 lazy），业务模块静态 import；改完必须重算首屏静态闭包。
21. **同一文件禁止并行 Edit** —— 并行会静默互相覆盖，而工具仍回 "Successfully edited"。同文件串行、不同文件才可并行；改完 grep 复核关键标识。
22. **`electron/database/` 不是死代码**：目录名未改，现在是 IPC handler 注册层（29 个 `registerXxxHandlers()`，转发给 `lib/kbStore`），**别删**。`grep sql.js` 只会命中注释。
23. 沙箱构建两类故障（EPERM 报错退出 / 永不返回）与退路 → skill `windows-sandbox-ops` §6、§7。
24. **`CHANGELOG.md` 是「应用内更新说明」的唯一源** —— 改完必须重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs` 生成 `electron/lib/releaseNotes/data.ts`（忘跑 = 页面显示上一版内容，无任何报错；契约脚本 §4 会拦）。触发规则（仅 major.minor 变化时自动打开 / 首装不弹 / **页面成功展示后**才推进基线）的纯函数在 `electron/lib/releaseNotes/judge.ts`（零依赖独立文件，专为让脚本 import）——**改规则必须同步补 `.AGENT/scripts/release-notes/verify-release-notes.mjs` 的用例表**，别把规则写回 `index.ts`。

---

## 开发流程

**做新功能或界面改造走这三步，每步产出未经用户确认不进下一步。**（纯 bug 修复、单点小改可直接动手，但第 3 条同样适用。）

1. **提炼需求 → 反问确认**：把口语描述整理成条目化需求清单（要解决什么 / 涉及哪些模块 / 已定什么 / 未定什么），回给用户问「是否符合你的预期」。
2. **出 HTML 原型 → 体验讨论**：UI 改动先产出**单文件、浏览器直接打开、可真实交互**的 HTML 原型（放本地工作区，不进 git），让用户点一遍再讨论。优先拿原型对话，而不是散文或静态截图。
3. **有疑问当场问 → 确认后出技术方案 → 编码**：任何歧义 / 多个可选实现 / 影响面不确定，立即询问，不替用户决定、不自行扩大范围。确认后**先写实现方案**（改哪些文件、什么路径、哪些取舍）再动手；方案阶段发现新问题，回到「询问」。

## 工作流

```bash
npm run dev      # electron-vite dev（端口 7173）；启动前删掉 ELECTRON_RUN_AS_NODE
npm run build    # electron-vite build —— 不做类型检查
npm run pack     # build + electron-builder 打包
```

- **类型门禁**（build 通过 ≠ 类型正确，必须单独跑）：`npx tsc --noEmit -p tsconfig.node.json` 与 `npx tsc --noEmit -p tsconfig.web.json`。
- **提交必须用系统 git**（Git Bash 自带的版本会删嵌套分支 ref → 提交变孤儿）。路径与理由见 skill `windows-sandbox-ops` §1。
- **改动越大越要配独立的契约验证脚本** —— 只跑 tsc 不够。

## 提示与设置

- 所有用户反馈走右下角 Toast：`showToast({ type, message, detail? })`（`src/lib/toast.ts`）。**禁止** `alert()` / `confirm()`。
- **设置项的唯一真源是 `src/lib/settings.ts` 的 `SETTINGS`** —— 一个 entry = key + 默认值 + 描述，类型由 `SettingsValue<K>` 推导，前后端共用。不要在组件里硬编码配置常数（超时时长、回收站保留天数等一律走 `getSetting()`），也不要在多处重复定义同一份选项列表。
- 新增 setting 两步：`SETTINGS` 加一行 → 组件里 `getSetting('key')`。要进设置搜索需 `ui: true` + anchor + `data-setting-anchor`。

## 文档指针

| 要了解什么 | 去哪 |
|---|---|
| 重构总纲（R0–R7、决策 D1–D9） | `docs/rework-master-plan.md` |
| AI 教学模块 | `docs/ai-teaching-module-rework.md` |
| UI 变更流水 | `docs/ui-updates.md` |
| 动效方案与落地进度 | `docs/ui-animation-plan.md` |
| 帮助披露规范 | `docs/help-disclosure-pattern.md` |
| 更新说明机制（触发规则 / 数据三层） | `docs/release-notes-design.md` |
| 未决问题收集 | `docs/verification-issues-*.md`；待修 bug 清单 `docs/pending-fixes.md` |
| 设计文档 / 原型去哪了 | `docs/DESIGN-ARCHIVE.md` —— 已落码或已搁置的方案与原型统一归档在独立库 **DesignProcess** |

**已评估暂缓、勿重复调研**：语音输入 ASR（`docs/voice-input-design.md` 已论证到落码级）。

## CodeGraph

仓库根存在 `.codegraph/` 时优先用它：MCP `codegraph_explore` / `codegraph_node`，或 shell `codegraph explore|node`。没有就跳过。
