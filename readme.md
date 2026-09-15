# Phrontis

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![License](https://img.shields.io/badge/license-GPL--3.0-green)
![Release](https://img.shields.io/github/v/release/Lousync/Phrontis?include_prereleases)

**本地优先的 Windows 学习生活操作系统** —— 知识库 · 日程 · 打卡 · AI 教学，集于一身，数据 100% 本地。

> 所有数据保存在你自己的电脑上——无需注册、没有云端、不联网也能用。
> 仓库只是一个文件夹：正文是 Markdown，结构化数据是 JSON，换电脑 = 拷走文件夹。

## ✨ 核心亮点

- **本地优先，数据主权**：无数据库依赖，Markdown + JSON 纯文件存储，任何编辑器都能打开，网盘同步友好
- **AI 教学工作台**：三栏教学 / 学习空间、PDF / PPT / 图片视觉转写、自动出题、用户画像
- **知识库**：四级结构 + `[[双链]]` + 力导向知识图谱 + PDF / 代码 / XMind 附件注解层
- **学习生活闭环**：日程四象限、周视图拖拽排期、习惯打卡、番茄钟、博客周 / 月总结
- **AI 助手**：本地优先模型网关（OpenAI 兼容 / Ollama / Anthropic），自然语言驱动本地工具，全程审计、按模块权限分级
- **安全的插件生态**：官方市场 + S / A / B 三级审核 + Worker 沙箱 + ed25519 签名验签

## 📦 功能模块

| 模块 | 说明 |
|------|------|
| ✏️ 编辑器 | **唯一正文写入方**：Monaco 内核 + 文件树（vscode-icons），分栏实时预览、**禅模式**（`Ctrl+K Z`）、**文件操作撤销栈**（`Ctrl+Z` / `Ctrl+Shift+Z` 覆盖移动 / 重命名 / 新建）；打开 `.pdf` 走内置阅读器（文本层 / 大纲 / 搜索 / 沉浸） |
| 📝 博客 | 每日一篇，Markdown 写作，标签分类，日历筛选，全文搜索；**周/月总结面板**自动汇总区间数据，**自定义模板**一键套用 |
| 📅 日程 | 日历视图，待办列表，四象限优先级，子任务，截止时间线，周期任务；**日程表周视图**——拖拽排期 / 边缘拉伸调时长 / 未完成自动延后；**今日工作台小窗**（日程 / 打卡 / 番茄 / 导航四 Tab），贴边吸附 / 磁吸回位 / 拖离自由摆放，逾期置顶 + 一句话快速添加，与主窗口实时双向同步 |
| 📚 知识库 | 空间 / 笔记本 / 章节 / 页面四级结构，`[[双链]]` + **关联网络**（反链上下文、手动关联、相关性推荐），**知识图谱**（d3-force 力导向，支持进入目录只看该目录），PDF / 代码 / XMind 附件与注解层，**沉浸阅读模式**；支持仓库根 `.ignore` 规则文件（gitignore 语法）——私人目录/草稿在知识库、搜索、图谱、AI 检索中整体隐藏，编辑器不受影响 |
| 💬 说说 | 轻量动态 + 相册管理，支持时间线可见性切换 |
| 🎓 AI 教学 | 三栏教学 / 学习工作台：会话 ⇄ 文件夹绑定、素材库、**视觉转写**（PDF / PPT / 图片转文字，图片理解模型槽位）、自动出题、用户画像、Token 消耗可视化；AI 生成的 HTML 产物经 `kbview://` 沙箱渲染 |
| 🤖 AI 助手 | 全局侧栏（`Ctrl+J` / 右下角悬浮按钮），**本地优先**的模型网关（OpenAI 兼容 / Ollama / Anthropic，支持 CC Switch 一键导入、自定义请求头），自然语言驱动本地工具（≤8 轮推理、全程审计、按模块权限分级），**上下文感知**——阅读知识库页面时"边看边问"；MCP 外部服务器、Skill 提示词包 |
| 🧩 插件 | 官方市场一键安装，S/A/B 三级安全审核 + **code 插件沙箱运行时**（能力网关逐项授权、ed25519 签名验签）；**主题包**（GitHub Dark/Light、护眼米白、赛博朋克、手绘线条、水墨·夜）、番茄钟进阶预设、错题本（插件版）、Markdown 使用指南、Teach 教学助手、强密码生成器 |
| 🧰 工具箱 | 9 个内嵌实用工具（见下表），含**数据导出**——按模块勾选导出备份包（ZIP），拖入窗口即可完整还原 |
| 🗑️ 回收站 | 软删除，可恢复，保留天数可调，支持导出为 Markdown |
| ⚙️ 设置 | 深色/浅色主题、字体、缩放、编辑器行为、打卡提醒、博客模板、AI 与插件权限等（支持关键词搜索直达具体设置项） |

### 🧰 工具箱

| 工具 | 功能 |
|------|------|
| 密码本 | 加密存储（系统级密钥保护），收藏 / 分组管理，快速搜索，一键复制，内置强密码生成器，全局快速填充悬浮窗（`Ctrl+Alt+P`） |
| 网址导航 | 分类管理学习资料网址，JSON 备份 / Netscape HTML 导入浏览器收藏夹 |
| 数据导出 | 按模块勾选导出备份包（ZIP），拖入窗口即可完整还原 |
| 设备传输 | 局域网二维码互传（`http://ip:端口/?token`），扫码即双向收发 |
| 网页剪藏 | 桌面端剪藏服务 + 浏览器扩展（MV3），一键把网页正文转 Markdown 存进仓库草稿区 |
| 番茄钟 | 三档预设专注循环，状态栏常驻，专注时长计入周月总结 |
| 习惯打卡 | 每天 / 每周指定 / 每周 N 次三种规则，补卡、连击里程碑与统计 |
| 远程监督 | 打卡实时推送到微信 / 钉钉 / 企微（Webhook），每日汇总与免打扰 |
| PDF 工具箱 | 多文件合并、页面整理（缩略图 / 旋转 / 重排 / 仅导出勾选页）、文本提取 |

## 🚀 其他特性

- **Vault 文件化**：仓库 = 账户（启动选择页 + 标题栏切换器），内容为 `.md` 文件、结构化数据为 `.knowbase/` 内 JSON，换电脑 = 拷走仓库文件夹
- **新手引导**：首次启动分步向导，快速上手（设置中可随时重看）
- **AI 对话与工具调用**：`Ctrl+J` 随时唤起，支持停止生成 / 重新生成 / 编辑重发 / 会话留存；工具执行与手动操作同一套审计链路；AI 可直接读写 Vault 文件（`vault.*` 工具族）
- **检查更新**：标题栏出现 ⬇ 徽章即代表有新版本，点击直下、完成后一键安装；下载支持可配置镜像加速（ghproxy 协议，失效可随时替换）
- **帮助中心**：内置中文文档；侧栏「反馈问题」一键跳转 GitHub Issues
- **快捷键**：`Ctrl+N` 当前模块新建 · `Ctrl+J` AI 助手 · `Ctrl+B` 侧栏 · `Ctrl+Shift+P` 命令面板 · `Ctrl+O` 快速打开文件 · `Ctrl+Shift+R` 沉浸阅读 · `Ctrl+K Z` 禅模式 · `Ctrl+Z` / `Ctrl+Shift+Z` 文件操作撤销 / 重做 · `Ctrl+Alt+S` 日程与打卡小窗 · `Ctrl+Alt+P` 密码填充 · `Ctrl+滚轮` 缩放界面

## 🛠 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Electron 33 | 无边框窗口 + 自定义标题栏，渲染进程沙箱化 |
| 前端框架 | React 19 + TypeScript | 函数组件 + Hooks，严格模式 |
| 构建工具 | electron-vite | 主进程 / preload / 渲染进程统一构建 |
| UI 样式 | TailwindCSS 4 | 原子化 CSS，深色/浅色双主题（CSS 变量） |
| 数据存储 | 本地 JSON + Markdown（仓库 Vault） | 无数据库依赖；内容页为 `.md` 文件，结构化数据为 `.knowbase/` 内 JSON，原子写盘 |
| 编辑器 | Monaco Editor | VS Code 同款内核，主题由 CSS 变量动态合成 |
| 知识图谱 | d3-force | 力导向布局（纯计算），Canvas 2D 渲染 |
| PDF | pdf.js + pdf-lib | 内置阅读器渲染 / 工具箱合并·整理·文本提取 |
| Markdown | react-markdown + rehype-highlight | 默认不渲染原始 HTML，安全无 XSS |
| 图标 | lucide-react | 轻量 SVG 图标 |
| 打包 | electron-builder | NSIS 安装包（x64） |

## 🔒 安全设计

- 数据 100% 本地存储（Markdown + JSON 纯文件，无数据库），密码本列使用系统级加密（Electron safeStorage；AES-256-GCM 密文，密钥由 Windows DPAPI 保护）
- 渲染进程沙箱 + contextIsolation，IPC 最小暴露面，路径类操作防穿越（Zip Slip 防护）
- 复制的密码 30 秒后自动清空剪贴板（仅当内容未被覆盖时）
- 整仓备份 = 仓库 `.knowbase/` 目录整包 ZIP，恢复前预检
- **AI 安全**：API Key 系统级加密存储（渲染层永不可见）；AI 工具调用全程审计、逐轮 Token 用量可视化；按模块权限分级（禁止/只读/读写），未授权工具对 AI 完全不可见；MCP 外部命令双重确认
- **插件安全**：S/A/B 三级强算分级（主进程防骗标）；内容包导入单事务执行、失败自动回滚；本地已修改页面默认跳过保护，冲突面板可勾选按页覆盖
- **插件沙箱**：`code` 插件运行在 Worker 沙箱，能力经 PluginHostGateway 单点裁决、逐项授权，未授权调用 deny + 审计；支持 ed25519 签名验签
- **子服务收敛**：网页剪藏 clipperServer 仅绑 `127.0.0.1` + Origin 白名单 + Bearer token；AI 生成的 HTML 产物经 `kbview://` 自定义协议沙箱渲染，响应头 `default-src 'none'`

## 📥 下载安装

前往 [Releases](https://github.com/Lousync/Phrontis/releases) 下载最新 NSIS 安装包（x64），双击安装即用。

## 💾 数据目录

应用采用「仓库 = 磁盘文件夹」模型（对标 Obsidian Vault），数据分两层：

| 数据 | 路径 |
|------|------|
| 知识页 / 博客 | 仓库根内 `.md` 文件（frontmatter 承载元数据） |
| 结构化数据 | 仓库根 `.knowbase/modules/*.json`（书签/日程/打卡/错题本等） |
| 索引与缓存 | 仓库根 `.knowbase/cache/` |
| 仓库内附件 | 仓库根 `.attachments/` |
| 设置 | `%APPDATA%/knowbase/settings.json` |
| 全局域数据 | `%APPDATA%/knowbase/data/*.json`（AI 会话 / MCP / 插件数据等） |
| 历史附件目录 | `%APPDATA%/knowbase/attachments/`（旧版遗留，只读兼容） |

> 仓库可放在任意磁盘目录（含网盘同步目录），换电脑 = 拷走仓库文件夹。

## ⚙️ 部署

### 环境要求

| 依赖 | 最低版本 |
|------|---------|
| Windows | 10 / 11 (64 位) |
| Node.js | 18+（推荐 20 LTS） |
| npm | 9+ |

### 开发环境

```bash
git clone https://github.com/Lousync/Phrontis.git
cd Phrontis
npm install
npm run dev       # 启动开发模式（热更新）
```

> 开发模式使用独立的 `%APPDATA%/knowbase (dev)` 数据目录，与正式版完全隔离。

### 生产打包

```bash
npm run pack
```

打包产物在 `dist-electron/` 目录。

## ⚠️ 环境检查

1. **`ELECTRON_RUN_AS_NODE`** — 系统环境变量中若存在需删除，否则 Electron 以纯 Node 模式运行
2. **数据备份** — 定期使用「设置 → 数据与仓库」的整仓备份，或直接拷贝仓库文件夹

## 🤝 参与贡献

有更好的想法或发现 Bug，欢迎 [提 Issue](https://github.com/Lousync/Phrontis/issues) 或 PR；也可在应用内 **帮助 → 反馈问题** 直达。

## 📄 许可证

[GPL-3.0](./LICENSE)

## 致谢

- 文件类型图标来自 [vscode-icons](https://github.com/vscode-icons/vscode-icons) (CC BY 4.0)
