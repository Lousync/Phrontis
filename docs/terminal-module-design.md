# 终端模块实现方案（内置 PowerShell / nvim + AI 执行命令）

> **状态**：已拍板，落码中（2026-10-04）。
> 需求来源：对话拍板 —— ① 软件内使用 neovim；② 给 AI shell 执行能力。
> 交互原型：`tmp/terminal-proto/index.html`（v2，已确认；落码后按 `DESIGN-ARCHIVE.md` 规则归档）。
> 关联规范：`docs/ui-interaction-patterns.md`（铁律 25）、`docs/ui-animation-plan.md`。

## 1. 拍板记录

| # | 决策 | 内容 |
|---|---|---|
| 1 | 真终端 | node-pty（`@lydell/node-pty` 预编译）+ xterm.js；pty 在主进程，渲染层零进程能力（不变量 3 不破） |
| 2 | AI 用法 | 一次性 exec 工具（提交命令 → 拿输出），**不**附身交互会话 |
| 3 | AI 权限 | 设置开关 `terminal.aiExec`（**默认关**，关 = 工具不进模型视野）+ 每条命令确认；确认走**行内卡**（终端模块「AI 执行记录」签页），高危命令才弹严重警告窗（铁律 25 允许的唯一弹窗形态） |
| 4 | 形态 | 工作台内 Tab（左栏书签入口，与笔记/日程同类），多会话 = 模块内会话条 |
| 5 | 默认 cwd | 当前仓库根（`getCurrentVault()?.rootPath`），无仓库回落用户主目录 |
| 6 | 多平台 | Windows（pwsh 7 → PowerShell 5.1 → cmd）/ macOS（$SHELL → zsh）/ Linux（$SHELL → bash），nvim 走 PATH |
| 7 | 「本会话内相同命令不再询问」 | 讨论项**未拍板**，MVP 不实现 |
| 8 | **输入行为（2026-10-04 二次反馈拍板）** | Windows PowerShell 5.1 卸载 PSReadLine，行编辑退回控制台**原生 cooked 模式**（敲什么显什么）——PSReadLine 2.0 在 ConPTY 上的 CJK 重画 bug 是输入区垃圾字符的机制源，用户明确不要那套；pwsh 7 保留完整 PSReadLine 体验。探针 `.AGENT/scripts/terminal/probe-pty-echo.mjs` 佐证 |
| 9 | **界面降噪（2026-10-05 反馈拍板）** | ① 侧栏底栏信息改 **swap-bar**（help-disclosure-pattern A：默认只显 ⓘ，悬停淡入 shell·cwd 一行），「nvim 等 TUI」常驻提示**删除**（教学内容保留在 `resources/help/终端.md`）；② 工具栏「新建会话」删除（与会话条「＋」、左栏「新建会话」重复）；③ 会话条「会话随 Tab 保活」文案收进悬停 ⓘ（只收不删）；④ **shell 版本按系统实测**：`resolveShell` 只给占位短名（PowerShell / pwsh / basename），`displayShellLabel` 异步探测真实版本（pwsh `--version` / 5.1 问 `$PSVersionTable` / posix `--version` 首行，按 file 缓存 + in-flight 去重），只用于工具栏 shell 牌与侧栏悬停行，会话签页保持短名；探测失败回落占位名，不编造版本 |

## 2. 架构

```
渲染层 src/modules/terminal/          主进程
┌─────────────────────────┐   IPC    ┌──────────────────────────────┐
│ xterm.js 实例（每会话）   │ ◀──────▶ │ terminalService（electron/lib）│
│ 会话条 / AI 执行记录      │  term:*  │  · pty 会话表（真源）+ 回放缓冲  │
│ 行内确认卡 / 高危弹窗     │          │  · shell 解析（三平台）         │
└─────────────────────────┘          │  · AI exec 门控 + spawn 执行    │
        preload 只透传                └──────────────────────────────┘
```

- **会话真源在主进程**：渲染层 Tab 关闭重开、切换保活，会话不丢；attach 时回放 backlog（字符串环形缓冲，上限 200k 字符）。应用退出 = 全部回收（约定行为，无持久化）。
- 会话数上限 4，超出拒绝并 Toast（与原型一致）。
- 写路径 `term:write` 用 `ipcRenderer.send`（高频、免回执）；数据下行 `term:data` 用 preload 单点扇出（照 `dataChangedSubs` 模式，L19-33 先例）。

## 3. IPC 设计

| 通道 | 方向 | 形态 | 载荷 |
|---|---|---|---|
| `term:create` | R→M | invoke | `{cols,rows,shellPref?}` → `{id,shell,cwd,pid,backlog}` |
| `term:attach` | R→M | invoke | `{id}` → `{backlog}` （重挂回放） |
| `term:write` | R→M | **send** | `(id, data)` |
| `term:resize` | R→M | send | `(id, cols, rows)` |
| `term:kill` | R→M | invoke | `(id)` |
| `term:list` | R→M | invoke | → `{sessions:[{id,shell,cwd,exited}]}` |
| `term:defaultShell` | R→M | invoke | → `{shell,label}`（工具栏/侧栏显示；label 含实测版本，主进程异步探测缓存） |
| `term:data` | M→R | broadcast | `{id,data}` |
| `term:exit` | M→R | broadcast | `{id,exitCode}` |
| `term:aiRecord` | M→R | broadcast | `{record}`（按 reqId 整条替换；**status='pending' 即待确认请求**，不设独立 aiRequest 通道 —— 落码时合并，少一条协议） |
| `term:aiRecords` | R→M | invoke | → `{records}`（模块挂载拉取，近 50 条） |

handler 注册：新增 `electron/database/repositories/terminalRepo.ts`（`registerTerminalHandlers({ getSetting })`），在 `electron/main/index.ts` 启动序列挂载。广播一律走 `electron/main/windowBus.ts` 的 `broadcast()`，通道名加进 `BROADCAST_CHANNEL`。

## 4. 文件改动清单

**新增**
- `electron/lib/terminalService.ts` —— pty 会话表 / shell 解析 / AI exec 门控与执行（纯主进程，不含 ipcMain）
- `electron/database/repositories/terminalRepo.ts` —— IPC 注册层
- `src/modules/terminal/index.tsx` —— 模块壳（工具栏 + 会话条 + 视口，根节点 `h-full`，铁律 11）
- `src/modules/terminal/TerminalPane.tsx` —— 单会话 xterm 宿主（FitAddon + ResizeObserver + 隐藏重挂 refit）
- `src/modules/terminal/AiRecordList.tsx` —— AI 执行记录签页（行内确认卡 + 高危 ConfirmDialog）
- `.AGENT/scripts/terminal/verify-terminal.mjs` —— 契约验证
- `resources/help/终端.md` —— AI 手册新篇（收尾阶段）

**修改**
- `src/types/index.ts` —— `TabName` 加 `'terminal'`；`ElectronAPI` 加 term 桥类型
- `src/lib/appModules.ts` —— `APP_MODULES` 加 `{ id:'terminal', label:'终端', bar:false, tile:true, palette:true }`
- `src/lib/workbenchLayout.ts` —— `RailModule` 联合 + `WORKBENCH_BOOKMARKS` 加终端书签 + `BOOKMARK_COLORS` 配色
- `src/App.tsx` —— 模块挂载 switch 加 `case 'terminal'`（**动态加载**：devtools 同款状态 + `import()` 惰性模式，xterm ≈ 415KB 不进首屏静态闭包）
- `src/components/workbench/WorkbenchLeftPanel.tsx` —— `BOOKMARK_ICONS` 的 `Record<RailModule,…>` 补 terminal 图标项（SquareTerminal）
- `src/lib/ipc.ts` —— term 具名包装函数
- `src/lib/settings.ts` —— 三条设置（见 §6）
- `electron/preload/index.ts` —— term 桥（send/handle + 单点扇出订阅）
- `electron/main/index.ts` —— 挂 `registerTerminalHandlers`
- `electron/main/windowBus.ts` —— `BROADCAST_CHANNEL` 加 term 通道
- `electron/lib/builtinTools.ts` —— 注册 `builtin.terminal.exec`；`builtin.tool.request` 的 description 清单补条目
- `electron/lib/agentService.ts` —— `buildToolsPayload` 加一行：`terminal.aiExec` 关时过滤 module==='terminal'
- `electron.vite.config.ts` —— manualChunks 加 xterm 桶
- `package.json` —— 依赖 + `asarUnpack`

**落码校准**（与上文如有出入以此为准）：xterm 实装为 `@xterm/xterm` 6.0 + `@xterm/addon-fit` 0.11；AI 确认合并为单通道 `term:ai-record`（见 §3）；左栏书签图标在 `WorkbenchLeftPanel.BOOKMARK_ICONS` 补项；终端模块走 App 动态加载，已复核首屏静态闭包不变（index.html 只引 index/react-vendor/vite-helpers/katex/highlight）。

## 5. shell 解析（`terminalService.resolveShell`）

| 平台 | 优先级 | 参数 |
|---|---|---|
| win32 | `terminal.shell` 设置（auto/pwsh/powershell/cmd）→ auto: `where pwsh` 探测 + 标准安装目录 → `powershell.exe` 兜底（系统必有） | pwsh：`[]`；**5.1：`-NoExit -Command "Remove-Module PSReadLine"`（拍板 ⑧，原生 cooked 输入）** |
| darwin | 设置 → `$SHELL` → `/bin/zsh` | `['-l']` |
| linux | 设置 → `$SHELL` → `/bin/bash` | `['-l']` |

AI exec 用同一解析结果但**非交互**：pwsh `-NoProfile -NonInteractive -Command <cmd>`；posix `-c <cmd>`（无 TTY，输出干净，属预期）。

## 6. AI 工具与设置

**`builtin.terminal.exec`**（照 `AgentTool` 接口）：`module:'terminal'`、`requires:'write'`、`tier:'ondemand'`、`readOnly:false`；schema 仅 `command`（必填）+ `timeoutMs`（默认 30000，上限 300000），≤800 字符、不罗列返回字段（铁律 16）。

**门控链**（四道，逐条兜底）：
1. `agentService.buildToolsPayload`：`terminal.aiExec` 关 → `module==='terminal'` 整体不进视野；
2. `checkModulePermission`：`aiModulePermissions.terminal` 走通用模块权限；
3. 支线会话 `requires==='write'` 硬拦截（既有行为）；
4. invoke 时 handler 再查一次设置 + 每条命令广播 `term:aiRequest` 等待行内确认，**确认超时 90s 视为拒绝**（返回 `{ok:false}` 告知 AI「用户未确认」，AI 可继续）。

**高危判定**（启发式正则，命中 → 渲染层弹严重警告窗代替行内卡）：删除类（`rd/rmdir/del/erase/Remove-Item/rm/mv→覆盖`）、磁盘/系统（`format/mkfs/dd/diskpart/shutdown/Stop-Process/taskkill/reg delete`）、git 破坏类（`push --force/reset --hard/clean -f`）。清单是 heuristic 不是沙箱，文档与手册里明说。

**输出处理**：stdout+stderr 合并；win32 下 UTF-8 解码含 U+FFFD 时用 iconv-lite 回落 GBK；自截 8000 字符（框架 24k 上限前自守，铁律 17「拿得少」）；AI 记录留存近 50 条（输出截 2000 字符供 UI 回看）。

**设置三项**（`src/lib/settings.ts`）：
- `terminal.shell`：select（auto/pwsh/powershell/cmd/zsh/bash），默认 auto，group 终端；
- `terminal.fontSize`：number 12–18 默认 13，`ui:true` + anchor（进设置搜索）；
- `terminal.aiExec`：toggle 默认 false，group AI，desc 写明「关闭时执行类工具完全不进入 AI 视野」。

## 7. 打包与构建

- 依赖：`@lydell/node-pty`（platform 子包 optionalDependencies，已验证 `@lydell/node-pty-win32-x64` 落地，plain Node 冒烟通过）+ `@xterm/xterm` + `@xterm/addon-fit`。
- **N-API 构建**：conpty.node 为 ABI 无关预编译，`npmRebuild:false` 维持不变；electron-builder `asarUnpack: ["**/node_modules/@lydell/node-pty*/**"]`（主包 + 平台子包都要解出 asar）。
- `electron.vite.config.ts` main 段 `externalizeDepsPlugin` 默认外置 node-pty（原生模块不进 bundle，正确）；renderer manualChunks 加 `@xterm` → `'xterm'` 桶（不加兜底，铁律 20）。
- xterm CSS（`@xterm/xterm/css/xterm.css`）在模块内 import。

## 8. 验收（契约脚本 `.AGENT/scripts/terminal/verify-terminal.mjs`）

静态断言：TabName / APP_MODULES / workbenchLayout 书签 / App.tsx case / preload 桥三层同名 / ElectronAPI 类型 / builtinTools 注册（tier、requires、module）/ `builtin.tool.request` 清单 / settings 三项（aiExec 默认 false）/ agentService 过滤行 / package.json asarUnpack。
动态断言：plain Node 下真跑 pty 冒烟（spawn cmd echo 标记串）。
**UI 探针（devbridge 实机截图）**：`.AGENT/scripts/terminal/probe-terminal-ui*.mjs` 四发 —— ① 全流程截图（开 Tab / ASCII / 中文 / dir）；② 断点分流（真实按键 vs 直写 pty 对照）；③ textarea 事件监听；④ backlog 原始流取证。运行方式见各文件头注（`KNOWBASE_DEV_BRIDGE=1 npm run build` 后经 `run-probe.mjs` 起 electron）。**dev 首跑人工项**：Electron 33 下 pty 可用、nvim 全屏 TUI、中文输入、主题联动、Tab 保活重挂回放、AI 行内确认全链路。

## 9. 风险与已知限制

| 风险 | 处置 |
|---|---|
| **★ 根因复盘 1（2026-10-04 实测定性）**：首版漏引 `@xterm/xterm/css/xterm.css` —— 无样式表的 xterm 把字符测量元素（`xterm-char-measure-element`，本应 `left:-9999em` 藏屏外）按文档流画出来 = boot 屏 `>>>>` 乱码行；光标/行布局/反色全坏。**一行 import 修复**，devbridge UI 探针截图前后对照实证 | 已修；教训：xterm 集成的第一件事是引样式表，`verify-terminal.mjs` 已加静态断言拦截 |
| **★ 根因复盘 2（2026-10-05 实测定性）**：TerminalPane v2 重写时**丢失 `term.onData → ipc.termWrite` 接线** —— xterm 收键、处理、但无人转发 pty = 终端完全无法输入。CDP 真实键盘注入 + `__kbTerm`/`__kbTermDbg` 诊断钩子实锤，修复后探针键入 `dir` 真实执行并渲染目录列表 | 已修；`verify-terminal.mjs` 已加接线断言；诊断钩子常驻（`window.__kbTerm` / `__kbTermDbg`） |
| **★ 主题对比度（2026-10-05 反馈）**：前景色曾直取 `--text-primary`，自定义主题未定义该变量时落到浅色兜底 = 浅底浅字 | 已修：按背景亮度（hexLuminance>0.4）自动选深/浅字色；主题切换监听改为 html 的 **class**（本应用主题机制是 `html.theme-<id>`，此前误监听 data-theme） |
| pty 80×24 起进程后 resize 触发 ConPTY 全屏重印（xtermjs#2798/#2459） | 已修：boot pane 先量真实尺寸 → `termCreate({cols,rows})` 实尺寸起进程；等值 resize 靠首测基线免发，后续 resize 走 120ms 去抖 |
| xterm 不知对端是 ConPTY → BufferLine 工厂不对（VS Code 在 Windows 必设 `windowsPty`） | 已修：`term:defaultShell` 回报 `windowsBuildNumber`，模块等它就位再挂 pane，构造时传 `windowsPty:{backend:'conpty',buildNumber}` |
| PowerShell 5.1 自带 PSReadLine 2.0 的 CJK 宽字符 bug（PSReadLine#779） | 已拍板（⑧）：5.1 卸载 PSReadLine 走原生 cooked 输入；pwsh 7 保留完整体验，探测补标准安装目录 |
| Tab `display:none` 时 xterm 尺寸为 0 | active prop 变化 + ResizeObserver 触发 `fit()` + `term.refresh()` |
| backlog 环形缓冲切在多字节字符中间 | 重放偶发首字符乱码，可接受；后续换 StringDecoder 分块解码 |
| 高危正则可被复合命令绕过 | 定位是「提醒」不是「沙箱」；真正的边界是用户确认这一步 + 仓库根 cwd 限制 |
| attach 快照与 live 数据的乱序/丢失窗口 | 订阅先行 + 快照回放期间 live 数据排队，回放后按序 flush |
| AI exec 无 TTY 丢颜色 | 预期行为，手册注明 |
| 每窗口都收 `term:data` 广播 | 单实例单主窗，量级可忽略；多窗优化留待需要 |
| **探针卫生（2026-10-05 教训）**：run-probe 的 electron 秒退（单实例锁被残留实例占用）时，探针会连到**僵尸旧实例**的 devbridge —— 连续多轮「修复无效」的假象即由此来（测的是几十分钟前的旧构建） | 每轮探针前先 `taskkill //F //IM electron.exe //T` 并用 `/health` 的 uptimeMs 确认是新实例 |

## 10. 手册同步（收尾必做）

`resources/help/` 新增 **终端.md**（怎么开、会话条、nvim、平台 shell 规则、AI 执行记录与确认）；**AI 权限与工具边界.md** 增补 `builtin.terminal.exec` 门控链。验收跑 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs`。
