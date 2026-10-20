# Phrontis · Linux 平台化 —— 更新计划

> **用途**：Linux 平台化这条线（自 `3.9.2` 起）的**唯一计划文档** —— 交付范围、已拍板决策、阶段进度，以及「Linux 桌面融入」的候选方向都记在这里。
> 历史反馈条目仍走 `docs/v3.9.0-feedback.md`（`F-n` / `N-n`）；本文件只记**计划**，不重复条目细节。
>
> **开发线**：worktree `/home/lousync/Projects/Phrontis-linux`，分支 `feature/v3.9.2-linux`（基点 `main` @ `d819e2a6`）。
> **目标**：交付能对外发布的 Linux 安装包（`deb`），只保 **X11 / XWayland**。
> **建档**：2026-10-19。

---

## 0. 已拍板（不要再问）

| # | 决策 |
|---|---|
| 1 | 交付范围 = 阶段 0 + 1 + 2；阶段 3（`readme` / `AGENTS.md` / `resources/help/*` 文案口径改写）本次不做，收尾提醒 |
| 2 | 显示后端只保 X11 / XWayland，不做原生 Wayland 支持（仅保留告警） |
| 3 | 关窗语义：探测不到托盘宿主就**真退出**（不隐藏） |
| 4 | 打包格式 **deb** |
| 5 | 可执行名 / 桌面条目名 = **phrontis** |
| 6 | Linux 用**独立 tag**（`v<ver>-linux`），Windows 仍走原通道；**Linux 版关掉应用内自动更新** |
| 7 | 版本号 **3.9.2**（避开在途的 `origin/v3.9.1` 线）；CHANGELOG 写明「Linux 自 3.9.2 起」 |
| 8 | 3.5.0 ~ 3.9.0 历史 tag **不补** |
| 9 | 双平台 tag 必须指向**同一个 commit**；平台差异不靠分支承载 |
| 10 | 跨平台密文解不开时**要加显式 UI 提示**（不是只写文档） |
| 11 | worktree 桌面启动器纳入本次范围（Linux 生成 `.desktop`） |
| 12 | 提交一律用系统 git；脚本输出一律不用 emoji |

---

## 1. 阶段与进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 启动器 / 沙箱 / 显示后端 / 字体 / worktree 启动器 | **已完成**（提交 `1a1ad3cf`） |
| 顺带 | 台账 `F-7` / `F-8` / `F-9` | **已完成**（提交 `5ead0cec`） |
| 顺带 | AI 工具面平台中性（审计 + 1 处文案 + 契约 G 节） | **已完成**（提交 `e8739bfc`） |
| 阶段 1 | 托盘宿主探测 + 关窗语义 · `globalShortcut` 失败告警 · `safeStorage` 平台断言 · 跨平台密文显式提示 · inotify 上限与回收站自检 | **已完成**（提交 `deb5c080`；契约 §H 110/110 + 7 条变异测试） |
| 阶段 2 | 打包与发布：`build.linux` · `pack.mjs` · `publish-release.py` · Linux 关更新 · 渲染层隐藏更新入口 · CHANGELOG + 重跑更新说明 · 真机 deb 验收 | **已完成**（提交见下；产物 `packs/3.9.2/Phrontis-3.9.2-amd64.deb` + `latest-linux.yml`；待你 `sudo apt install` 真机安装验收） |
| 阶段 2 追加 | **附件入仓库**（说说图 / 头像 / 博客图 / 编辑器插图 → `<vault>/.attachments/`，旧 `userData/attachments` 只读兼容 + 自动复制迁移 + 路径归一化）· **仓库身份统一**（rootId 写入 `meta.json`，阅读进度 / 摘录 / 导出映射 / 封面跨系统合并）· **坏图片引用清理** | **已完成**（契约 `verify-attachment-store` 55/55 + `verify-vault-identity` 39/39 + 9 条变异测试 + Electron 集成探针 14/14；方案 `docs/attachments-in-vault-plan.md` / `docs/vault-identity.md`） |
| 桌面集成 · 阶段 1 | **核心通路**：D-Bus `Core1`（GetToday / ToggleTodo / CheckIn / OpenApp / Search / GetCapabilities + Changed）· 托盘「今日」区 · `phrontis-cli` · deb 注入（D-Bus 激活 / 卸载清理） | **已完成**（契约 54 项 + 2 条变异测试；方案 `docs/desktop-integration-plan.md`；真机 dev + 打包产物双验证） |
| 桌面集成 · 阶段 2 | **GNOME 扩展 v1**（独立仓库 `phrontis-desktop-integration/gnome-extension`）：A 顶栏「图标 + 今日 N 项 · 打卡 M/K」+ 弹出面板（勾待办 / 打卡 / 打开应用）· B 快速设置磁贴 | **已落码，待实机重登录验收**（headless GNOME 50.1 验证 `enable()` 与面板/磁贴构造；修复 `addExternalIndicator` 移除后的挂载点） |
| 阶段 3 | 文档口径（`readme` / `AGENTS.md` / `resources/help/*`） | **不做**（收尾提醒） |

---

## 2. ★ Linux 桌面融入 backlog（2026-10-19 登记）

> **开发负责人 2026-10-19 口径（原话大意）**：「我的 Linux 桌面也在被我定制中，我希望以后这个软件能够很好地融入我的桌面 —— 把这个点记进更新计划。」
>
> ⇒ 这不是某一版的补丁，而是一条**长期方向**：随桌面环境（GNOME + 个人定制）演进，让 Phrontis 成为「系统的一部分」，而不是自带一个小世界。
>
> **记录纪律**：本节只登记**方向与候选**，不排期、不动码；等拍板进某一版，再各自展开成需求条目（台账 `N-n` + 方案文档）。

### 判断标准（先立，避免变成愿望清单）

「像个本地应用」= ① **它是系统的一部分**（主题 / 快捷键 / 通知 / 文件关联都跟系统走）；② **它有 Linux 的礼貌**（数据放对地方、出错能查、命令能敲）。

### 发布前必测（不是新功能，是可用性底线）

- **中文输入法**（fcitx5 / ibus）。全仓**零处理**（搜 `fcitx` / `ibus` / `GTK_IM_MODULE` / `XMODIFIERS` 无命中）。从桌面图标启动的程序常拿不到输入法环境 ⇒ **编辑器里打不出中文**。对中文笔记应用是底线问题，发布前必须真机实测；大概率靠打包补环境变量 + 文档解决，不用改代码。

### 第一档：不做就一眼「外来户」

1. **深浅色跟随系统** + **强调色跟随系统**。现状：主题只能手动选（`src/lib/settings.ts` 无「跟随系统」项，`applyThemeClass` 只在用户切换时调用）。
2. **任务栏 / 概览图标对得上号**。现状：自绘窗口未声明窗口类名 ⇒ 可能出现默认图标或同一应用重复条目。
3. **通知的「身份」正确**。现状：`electron/lib/scheduleReminder.ts` 发通知但未声明桌面身份 ⇒ 装包后可能显示通用名 / 无图标 / 点通知唤不出窗口。
4. **文件关联 + 命令行入口**。现状：完全没有 —— 无 `MimeType`、无 `setAsDefaultProtocolClient`、启动不看参数。目标：文件管理器「用 Phrontis 打开」、终端 `phrontis <file>`。

### 第二档：做了才叫「融入系统」

5. **开机自启**（XDG autostart）。现状：完全没有（只有注释里提过）。
6. **网络跟随系统**：系统代理 + 系统证书信任（企业 / 自签场景）。现状：只有「书市」有代理设置，且 `bookMarketProxy` 的 desc 原话写明「只影响书市，不影响 AI 对话与更新」。
7. **从文件管理器拖文件进来**（外部 `text/uri-list` 拖入知识库 / 编辑器）。
8. **键盘习惯对齐**：`Ctrl+Q` 退出、`Ctrl+,` 设置、`F11` 全屏等。
9. **日志能拿到**。现状：从桌面图标启动时终端无输出；应写日志到系统约定位置。
10. **数据目录符合 XDG 习惯**：配置 / 缓存 / 日志分开；dev 目录名 `knowbase (dev)` 带空格与括号，Linux 上是经典坑。

### 第三档：锦上添花 / 长期

11. **系统搜索里能搜到笔记**（GNOME 活动搜索）。需常驻后台服务 + D-Bus，工作量最大、最出彩。
12. **软件中心可见介绍**（AppStream metainfo，GNOME Software / KDE Discover）。
13. **系统菜单显示中文名**（`.desktop` 的 `Name[zh_CN]`）。
14. **免安装 / Flatpak 版**（跨发行版分发）。

### 带着走的原则

上一批候选里有一半（文件关联、命令行、开机自启、系统代理）**是跨平台价值**，不是「Linux 专属」⇒ 做法应是「同一功能，Linux 多一条注册实现」，符合已拍板口径 #9（平台差异不靠分支承载），顺手把 Windows 侧补齐。

---

## 3. 有意设计（不要再建议改）

- **窗口控件的位置与长相**：自绘三色按钮（`src/components/shared/TitleBar.tsx`），**由开发负责人钉死**，不跟随系统 `button-layout`、不做「跟随系统 / 左 / 右」选项。
  **2026-10-19 明确**：这是有意设计，已从「融入桌面」建议清单里划出 —— 后续不要再提议改它。

---

## 4. 开放待拍板

- **桌面融入的版本安排**：建议 3.9.2 只放「发布前必测 + 第一档里最省的几条」，其余开 **3.10.0**（新功能按仓库口径抬 minor）。
- 第 11 条（系统搜索）是否认真做（工作量最大）。
- **顺手发现（与本线无关，待拍板归属）**：契约 `.AGENT/scripts/settings/verify-ai-tab-anchors.mjs` 常红 1 项 ——
  入口项 `aiTools.llmUsage`（`src/modules/settings/sections.tsx:129`，AI 工具的「用量」页签）在视图里**没有落点锚点**，
  即设置搜索能搜到、点进去没地方跳。已实测 HEAD（`2605501a`）即为此状态 ⇒ **非本批引入**。修法 = 在
  `src/modules/settings/views/AiUsageTab.tsx` 的 token 用量卡上补一个 `data-setting-anchor="aiTools.llmUsage"`（一行）。
  未改（避免与阶段 1 混在一批）。

### 已拍板（2026-10-19，只留结论与依据）

| 事项 | 结论 | 依据 / 落点 |
|---|---|---|
| 台账 `F-10`（未钉 locale 的 `localeCompare`） | **只改 AI 面**：`aiAssistantScopeSuggestPure` / `aiTools` 改码点序；人类列表保留 `'zh-Hans'` 钉死档 | 判据「给 AI 看的排序必须确定，给人看的可以自然」。已落码（提交 `deb5c080`）；契约 §H9 真跑 `LC_ALL=C / zh_CN.UTF-8 / en_US.UTF-8` 比行序 |
| 三个本地提交（`1a1ad3cf` / `5ead0cec` / `e8739bfc`）+ 后续提交 | **推送** `feature/v3.9.2-linux` | 远端此前没有该分支，先落袋；双平台 tag 仍等发版再打 |
| `.desktop` 落 `~/.local/share/applications` 而非 `~/Desktop` | **保留** | `~/Desktop` 上的 .desktop 需 `gio set … metadata::trusted true` 才能双击，否则弹「不受信任的启动器」 |
| `AGENTS.md` 的 worktree 启动器规则（现仅覆盖 Windows `.bat`） | **本次不改** | 属阶段 3 文档口径；Linux 走 `.desktop`，规则改动面比代码大 |
| `desktopName` / `syncDesktopName` 是否本次加（清单外 2 行） | **加**（2026-10-19 确认） | 不加则 GNOME 无法把窗口关联到 `phrontis.desktop`（任务栏/概览图标对不上），且每次打包一条 warning；属 N-1 第一档，顺手收 |
| deb 的 `author.email` / `maintainer` 取值 | **`Lousync <19292274929@163.com>`**（2026-10-19 确认） | 与 git 提交身份一致，仓库提交里已是同一邮箱 ⇒ 无新增暴露 |

### 已核实、勿再按旧前提推理（2026-10-19）

- **`trash` 包在 Linux 不依赖 `gio` / `trash-cli`**：`trash@10.1.1` 的 `node_modules/trash/lib/linux.js`
  **自己实现 XDG Trash**（`xdg-trashdir` + `move-file` + `@stroncium/procfs`），只有 Windows 分支用
  `chunked-exec` 调 powershell。阶段 1 原写的「外部命令缺失要降级提示」**没有可探测对象** ⇒
  自检改为 **XDG Trash 目录可写性**（`$XDG_DATA_HOME/Trash` 或 `~/.local/share/Trash`）。

### 阶段 2 落地时核实的新事实（2026-10-19，都已进契约/闸门）

- **`node_modules` 是符号链接时，electron-builder 会静默漏掉一大批依赖**（worktree 省盘做法的直接后果）。
  实测对照（同一份代码、同一个版本号）：symlink → `cannot find path for dependency` 100+ 条、asar 里只有
  **51** 个顶层包；真目录（或 `cp -al` 硬链接目录）→ 0 条、**2853** 个顶层包。
  表象是最难查的那种：**包能打出来、体积也正常，装上一启动就崩**（`Cannot find module 'safer-buffer'`，
  iconv-lite 的传递依赖）。⇒ `scripts/pack.mjs` 加闸门 `nodeModulesIsSymlink`（默认中止，逃生门
  `KNOWBASE_ALLOW_SYMLINK_NODE_MODULES=1`）。**本 worktree 的 `node_modules` 已换成一个真目录**
  （`cp -al` 硬链接自主仓，不额外占盘）—— 想换回符号链接请自行 `rm -rf node_modules && ln -s …`，
  换回后 `npm run pack` 会被闸门拦下（这是有意的）。
- **deb 需要 `homepage` 或 github `repository`**：两者都没有时 electron-builder 抛
  `Please specify project homepage`。而**只有 `homepage` 仍然不够** —— 更新元数据
  （`latest.yml` / `latest-linux.yml`）是在 `getPublishConfigsForUpdateInfo` 里按 **github repository**
  推断生成的，没有它两个平台都拿不到元数据（这正是 `publish-release.py` 门 1 要的三件套）。
  本次加了 `homepage` + `repository`（纯元数据，不动任何构建行为）。
- **`linux.desktop.Exec` 被 electron-builder 明确禁止**（`Please specify executable name as
  linux.executableName instead of linux.desktop.Exec`）⇒ 想把 **XWayland 钉进桌面条目**只能用
  `linux.executableArgs: ["--ozone-platform=x11"]`（生成的 `Exec=/opt/Phrontis/phrontis --ozone-platform=x11 %U`）。
  ⚠️ 覆盖面只有「菜单 / 桌面图标」这条路径；从终端敲 `phrontis` 的，要自行补参数（已写进 CHANGELOG）。
- **Ubuntu 24+ 的沙箱两条防线本机都成立**：`apparmor_status --enabled` 退出 0，且随包 profile 的
  `apparmor_parser --skip-kernel-load --debug` 干跑**通过**（abi/4.0 被接受）⇒ 装完 profile 生效；
  postinst 仍保留「profile 没装成 + 内核限制 userns → `chrome-sandbox` 回退 4755」的兜底。
- **deb 的默认 Depends 与已核对的结论一致**（`libgtk-3-0` / `libatspi2.0-0` 在 24.04+ 由 `*t64` 提供旧名，
  `libxss1` 在 resolute 仓库存在）⇒ 未改 `depends`。

### 发版操作（Linux 侧，本机执行）

```bash
npm run pack                                  # 产物落 packs/<版本>/（当前 3.9.2）
sudo apt install ./packs/3.9.2/Phrontis-3.9.2-amd64.deb   # 真机安装验收（装完会在 /usr/bin 建 phrontis 软链）
python3 scripts/publish-release.py --version 3.9.2 --platform linux   # 需要先装 gh 并 gh auth login
```

- tag = **`v3.9.2-linux`**（决策 #6）；Windows 侧在同**一个 commit** 上打 `v3.9.2`。
  发布脚本会把新 tag **钉在本地 HEAD**（= 打包用的那个 commit，`gh release create --target`），
  并在上传前校验另一平台的同名 tag 是否指向同一 commit（不一致直接中止）—— 避免「同版本号、内容不同」。
- 发布脚本的 Linux 门：deb `control` 版本 ↔ `latest-linux.yml` 版本 ↔ 你传的 `--version` 三者一致，
  sha512/size 与本地 deb 实测一致（另核对 `dpkg-deb -f` 的 `Version`，防「抬了版本号没重打包」）。
- 验收建议（未做，需你执行）：装完直接启动一次，确认托盘图标、`Ctrl+Alt+P`、关闭窗口语义；
  再验一次「中文输入法」（`docs/linux-port-plan.md` §2「发布前必测」那条，全仓零处理）。

---

## 5. 变更记录

| 日期 | 事项 |
|---|---|
| 2026-10-19 | 建档。登记「Linux 桌面融入」方向与三档候选；划出「窗口控件位置与长相 = 有意设计，不再建议」。 |
| 2026-10-19 | **阶段 1 完成**（提交 `deb5c080`）。五项：① 新增 `electron/lib/linuxDesktop.ts`（D-Bus 名探测状态栏宿主 + XDG Trash 可写性自检）并把关窗语义改为「Linux 且确有托盘才隐藏，否则真退出」；② `globalShortcut` 三处注册改看**返回值**并汇总提示；③ `safeStorage` 密文头改**按平台**断言（Linux = v11，探针按平台给期望头）+ 启动打印后端名；④ 解密改**三态**并透出 `passwordUndecryptable` / `keyUnreadable`，密码本与 AI 模型页给行内标记 + 可关闭提示条（`secretBox` 与 `passwordRepo` 两份拷贝同步改、互相标注），新增密文平台 IPC 与主进程告警通道；⑤ inotify 配额预检 + ENOSPC 归因 + 回收站自检。台账 `F-10` 按「只改 AI 面」一并收口。 |
| 2026-10-19 | 同轮两条**事实更正 / 新事实**：① `trash@10.1.1` 在 Linux 自实现 XDG Trash、**不依赖 gio/trash-cli** ⇒ 回收站自检改判「XDG Trash 目录可写性」（原前提不成立，已与开发负责人确认）；② `~/Desktop` 上的 .desktop 需 `metadata::trusted` 才能双击 ⇒ 维持落 `~/.local/share/applications`。另：契约 `verify-linux-port.mjs` 增 §H 56 条（110/110）并做 **7 条变异测试**，其中「inotify 预检位置」一条第一版是**假断言**（`indexOf` 命中了函数定义），已改为只在 `syncVaultWatcher` 内部找调用；`verify-perception.mjs` 的 `J12b` 随 `bind()` 包装改钉点。真机 dev 启动实测：密文自检不再报假故障（后端 `gnome_libsecret`）、托盘创建成功、快捷键注册成功、无回收站/inotify 告警。**告警链路另做了端到端验证**：以 `XDG_DATA_HOME=/` 启动（回收站目录必然不可写）→ 主进程自检失败并登记告警 → 渲染层启动后取到并在界面上弹出了 Toast（用 devbridge `ui.eval` 读到 DOM 文案「回收站不可用：删除的文件可能无法移入回收站」），即 队列/广播 → IPC → React effect → Toast 全链路通。**顺手发现**（非本批引入）：`verify-ai-tab-anchors.mjs` 常红一项 `aiTools.llmUsage` 无落点锚点，已记入 §4 待拍板。 |
| 2026-10-19 | **阶段 2 完成**：`package.json` 加顶层 `author`（deb 必需）/ 平台中性 `description` / `homepage` + `repository`（否则 deb 缺 Homepage 报错，且**两个平台都拿不到**更新元数据）/ `desktopName` + `syncDesktopName` / `build.linux`（deb x64 · icon · category · synopsis · maintainer · `executableName: phrontis` · `artifactName` · `executableArgs: --ozone-platform=x11`）+ `build.deb.afterInstall`；新增 `build/linux-after-install.sh`（**整份替换**默认模板：AppArmor profile 干跑通过才装，装不成且内核限制 userns 时把 `chrome-sandbox` 回退 4755；只用 `executable` / `sanitizedProductName` 两个宏）；`scripts/pack.mjs` 按平台选目标 + 拒绝交叉打包 + **拒绝 symlink 的 node_modules**；`scripts/publish-release.py` 加 `--platform`（Linux → tag `v<ver>-linux`，门 1 校验 deb + `latest-linux.yml`，另核对包内 `control` 版本；缺 `gh` 给安装指引而不是抛栈）；`electron/lib/updateService.ts` 在 Linux 下 check / download / install **硬拒且不发任何请求**，顺手修「`downloads + 反斜杠` 在 POSIX 上恒判路径不受信任」的现成 bug；`api.platform` 透出 + 新增 `src/lib/platform.ts` 作唯一判据，标题栏与设置页在 Linux 隐藏更新入口、改为「打开发布页」；`CHANGELOG.md` 抬 3.9.2 并**重跑** `.AGENT/scripts/release-notes/build-release-notes.mjs`。契约：`verify-linux-port.mjs` §I（145/145）、`verify-pack-dir.mjs` 23/23（含真跑 symlink 闸门），**9 条变异测试**全被抓住（其中一条第一版是假断言：`nodeModulesIsSymlink(repoRoot)` 被函数定义命中，已改成钉调用点形状）。 |
| 2026-10-19 | 阶段 2 **真机打包 + 产物验收**：`npm run pack` 产出 `packs/3.9.2/Phrontis-3.9.2-amd64.deb`（156 MB）+ `latest-linux.yml`。deb 内核对无误：`control`（Maintainer / Homepage / Description / Depends）· `/usr/share/applications/phrontis.desktop`（`Exec=/opt/Phrontis/phrontis --ozone-platform=x11 %U`、`Icon=phrontis`、`StartupWMClass=phrontis`、`Categories=Office;TextEditor;`）· 随包 AppArmor profile（干跑 exit 0）· `app-update.yml`。**打包产物真机启动实测通过**（隔离 userData + `--no-sandbox`）：`[Boot] Phrontis main ready - net-v2 - 3.9.2`、密文后端 `gnome_libsecret`、`[Tray] Tray created`，无 `Cannot find module`、无 FATAL。`publish-release.py --platform linux` 三道门全过（`control` 版本 3.9.2 · sha512/size 一致），到上传步骤因本机**未装 gh** 而按设计给出安装指引（未真正发布）。 |
| 2026-10-19 | **附件入仓库完成**（3.9.2 追加项）。根因：附件本体写在全局 `userData/attachments`、台账里 168/176 条是 Windows 反斜杠 ⇒ 换系统打开同一仓库时说说图 / 头像 / 博客图 / 编辑器插图全变破图，且「拷走文件夹」备份不完整。改动：① 新增 `electron/lib/kbStore/attachmentPath.ts`（零 Electron 依赖：归一化 / POSIX 拼接 / 候选解析 / 原子复制 / 迁移计划）；② 新增 `electron/lib/attachmentStore.ts`（仓库优先、旧目录只读回退、首次读取复制进仓库、每仓库每会话一次迁移、头像旧前缀兼容）；③ `attachmentRepo` 读写/回收/清理全部改基座（回收区 → `<vault>/.knowbase/attachments_trash/`，保留相对路径避免缩略图同名覆盖）；④ `userRepo` 头像四处改仓库；⑤ `PageEditor` 去掉 `${attachmentsPath}\\` 的 Windows 专有拼接，新增 `attachment:resolveRel`；⑥ `globalPaths.getAttachmentsDir` → `getLegacyAttachmentsDir`（只读兜底）。契约 `.AGENT/scripts/attachments/verify-attachment-store.mjs` 55/55 + 4 条变异测试（去归一化 / 旧目录优先 / 去掉存在即跳过 / 扩展名不补点）全被抓住；Electron 集成探针 14/14（含回收区恢复、仓库已有文件不被覆盖、旧文件保留）。迁移口径：**复制不删**，旧版 Windows 仍可用；两端升级后再手动清旧目录。 |
| 2026-10-19 | **仓库身份统一 + 坏引用清理完成**（3.9.2 追加项，`docs/vault-identity.md`）。身份：`.knowbase/meta.json` 增 `id` 作为唯一真相源；`resolveVaultId` 在启动恢复与打开/导入两处解析（缺失时第一个设备写入，另一设备采纳），`setCurrentVault` 按 id + 路径去重，`upsertVault` 按路径只留一行；`migrateVaultIdentity` 把 `pdfReader` / `readerState` / `excerpts` / `excerptExports` / 封面索引里其它 UUID 前缀的键迁到当前 id —— 进度取 `updatedAt` 新、摘录按条合并、导出映射取 `exportedAt` 新、封面 `sha1(bookKey)` 文件同步改名。用真实 `pdfReader.json` + 封面副本验收：6 个进度键 + 11 个封面键迁移，0 缺失，另一系统再打开采纳同一 id。契约 `verify-vault-identity` 39/39 + 5 条变异测试（不删旧键 / 冲突总用旧值 / 摘录整本覆盖 / 封面不改文件 / 最近列表不按路径去重）。坏引用：新增 `.AGENT/scripts/vault-maintenance/clean-broken-attachment-refs.mjs`（默认 dry-run，`--apply --backup` 写盘），已清理当前仓库 12 个文件 / 31 处 `attachment://image.png` 类无效引用，备份在 `/tmp/opencode/broken-refs-backup-20261019-205942`；契约 `verify-refs-cleanup` 16/16 + 4 条变异测试。 |
| 2026-10-20 | **桌面集成 · 阶段 1 核心通路完成**（C 档 + 对外接口地基，形态见 `phrontis-desktop-integration`）。新增 `electron/lib/desktopBridge/`（`dayService` 读快照 / `dbusService` Core1 / `trayMenu` 今日区 / `index` 挂载）与 `src/lib/daySnapshotPure.ts`（纯映射，契约可直接跑）；`dbus-next` 仅 Linux 懒加载。写入口收敛：`todoActions.toggleTodoDone`（补插件完成事件）、`habitActions.setHabitChecked/toggleHabitChecked`（含远程监督推送），IPC 与 D-Bus 共用；`windowBus` 加 `subscribeDataChanged`，主进程写盘也会发 `Changed` / 刷新托盘。托盘右键新增「今日 N/M 项 · 打卡 X/Y」+ 前 5 条待办/习惯 + 番茄状态。CLI `phrontis-cli`（Electron node 模式 + `busctl --json`，零新依赖），deb 注入 `.service`（按宏重写 Exec）+ `DBusActivatable` + `afterRemove`（`upgrade` 不删）。**刻意不做**：`PomodoroControl`（需渲染层下行通道）、`OpenApp(relPath)`、GNOME 扩展 A+B。验收：契约 `.AGENT/scripts/desktop-integration/verify-desktop-bridge.mjs` 52/52 + 2 条变异测试；`tsc` 双配置干净；真机 dev 实例 `gdbus` GetToday 返回真实仓库数据、`phrontis-cli today` 正常、关闭后总线名释放。 |
| 2026-10-20 | **桌面集成打包验收 + 新增 asar 自洽闸门**：第一次打包（`packs/3.9.2-4`）时 dev 进程仍在写 `out/`，`app.asar` 文件表与数据区错位（`package.json` 偏移指向 `index.html` 字节）—— deb 能装、启动却退化成 Electron 默认页（打印 Usage），**全程无报错**。停掉所有 dev 实例重打（`packs/3.9.2-5`）后校验通过；`scripts/pack.mjs` 增加 `verifyPackedAsar`（构建后校验 `package.json` 可解析 + `main` 真在包内，失败 `exit 4`）。产物验收：`[desktop] D-Bus 服务已就绪: io.github.lousync.Phrontis`（正式名，非 `.Dev`）· `gdbus GetCapabilities` 正常 · 包内 CLI（node 模式）`capabilities`/`today` 与壳脚本正常 · `DBusActivatable=true` · postinst 安装 `.service`/`phrontis-cli` · asar 内 31 个 `dbus-next` 文件。**`3.9.2-4` 是坏产物，勿发布**（`publish-release.py` 默认取最大后缀 = `-5`）。 |
| 2026-10-20 | **桌面集成 · 阶段 2（GNOME 扩展 v1）落码**（独立仓库 `phrontis-desktop-integration/gnome-extension`）：A 顶栏入口（图标 + `今日 N 项 · 打卡 M/K`）+ 弹出面板（勾待办 / 打卡 / 打开应用）、B 快速设置磁贴（同源读数，点击唤起）。数据全走 D-Bus `Core1`，不碰 vault。实现要点：读 `GetToday` 用 `NO_AUTO_START`（登录时不拉起应用），写动作与 `OpenApp` 允许激活；订阅 `Changed` + `NameOwnerChanged` 刷新；应用未运行时显示 `Phrontis` 并可一键启动。**GNOME 50 适配**：`addExternalIndicator` 已移除 → 磁贴挂 `statusArea.quickSettings.menu`；headless 实测先报 `addItem is not a function`，修复后 `enable()` 与面板/磁贴构造通过。**Wayland 不能热加载新扩展**：已装入 `~/.local/share/gnome-shell/extensions/phrontis@lousync.github.io` 并写入 `enabled-extensions`，待重新登录看实际效果。 |
| 2026-10-20 | **桌面集成补强：原生快捷键 + 登记表去重**。① `Ctrl+Alt+S` 在 Wayland 下不生效的根因：Electron 的全局键走 XWayland 的 `XGrabKey`，只在 X11 窗口有焦点时收得到；`globalShortcut.isRegistered` 返回 true 也会失效（XTEST 实测无反应）。改为 **GNOME 扩展用 `Main.wm.addKeybinding` 注册原生快捷键**（自带 GSettings schema，Wayland 有效），新增 D-Bus `ToggleDayPanel` + 能力 `dayPanel`；托盘菜单加「日程小窗」作不依赖快捷键的兜底；dev bridge `/state` 暴露三个键的真实注册结果。② 修 `vaults.json` 同 id 重复行：`upsertVault` 原来只按 path 去重，仓库被复制到新路径后旧行残留（切换器里同一仓库出现两次 + React duplicate key 警告），改为同 id 或同 path 都归并 + 启动自愈（实测 2 → 1，警告消失）。契约：`verify-desktop-bridge` 54/54、`verify-vault-identity` 44/44（+5 条登记表用例）、tsc 双配置干净。 |
| 2026-10-20 | **托盘菜单按用户要求收口**：移除「任务栏模式」（自由漂浮/顶部停靠/桌面小组件，功能未完成）与「日程小窗」，只留「显示主窗口 / 退出 Phrontis」。托盘图标保留（用于显示应用仍在运行）；今日面板唯一入口 = GNOME 扩展顶栏 + `Ctrl+Alt+S`。契约同步改为负向断言（托盘不得再出现任务栏模式 / 今日区）。 |
