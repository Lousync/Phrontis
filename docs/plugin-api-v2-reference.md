# Knowbase 插件 API v2 参考手册

> 配套文档：[插件 API v2 设计文档](./plugin-api-v2-design.md)
> 本手册面向插件作者，列出协议、方法签名、清单字段与可运行骨架。

---

## 1. 三分钟上手

### 1.1 目录结构

```
my-plugin/
  plugin.json        # 清单（必需）
  index.html         # 入口（type: ui 时必需）
  settings.html      # 可选：插件设置页
  icon.svg           # 可选：插件图标
```

### 1.2 最小清单

```jsonc
{
  "id": "com.example.my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "type": "ui",
  "entry": "index.html",
  "apiVersion": 2,
  "capabilities": ["store"],
  "contributes": {
    "store": { "quotaMb": 50 }
  }
}
```

### 1.3 最小入口页

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>我的插件</title></head>
<body>
  <div id="app">加载中…</div>
  <script type="module">
    import { kb } from './kb-api.mjs'   // 或 npm i knowbase-plugin-api

    const notes = await kb.store.get('notes', [])
    notes.push({ at: Date.now(), text: '第一条' })
    await kb.store.set('notes', notes)
    document.getElementById('app').textContent = `已保存 ${notes.length} 条`
  </script>
</body>
</html>
```

打包成 zip（`plugin.json` 在根或单层顶层目录内）→ 插件页「从文件安装」。

---

## 2. 传输协议

插件页运行在 `sandbox` iframe 内，无法访问 Electron IPC，全部通信经 `postMessage`。

### 2.1 报文

```ts
// 插件 → 宿主（请求）
{ channel: 'kb-plugin', v: 2, id: string, token: string, method: string, params?: unknown }

// 宿主 → 插件（响应，id 与请求一致）
{ channel: 'kb-plugin', v: 2, id: string, ok: true,  result: unknown }
{ channel: 'kb-plugin', v: 2, id: string, ok: false, error: { code: string, message: string } }

// 宿主 → 插件（初始化）
{ channel: 'kb-plugin', v: 2, type: 'init',
  payload: { token, hostVersion, capabilities, themeVars, vault: { rootId, name } } }

// 宿主 → 插件（事件）
{ channel: 'kb-plugin', v: 2, type: 'event', event: string, payload: unknown }
```

`token` 由宿主在 `init` 里下发，后续每个请求必须携带；iframe 重建即失效。

### 2.2 手写实现（不使用 SDK 时）

```js
let token = ''
const pending = new Map()
let seq = 0

window.addEventListener('message', (e) => {
  const d = e.data
  if (!d || d.channel !== 'kb-plugin') return
  if (d.type === 'init') { token = d.payload.token; return }
  if (d.type === 'event') { emit(d.event, d.payload); return }
  const p = pending.get(d.id)
  if (!p) return
  pending.delete(d.id)
  d.ok ? p.resolve(d.result) : p.reject(Object.assign(new Error(d.error.message), { code: d.error.code }))
})

function call(method, params) {
  const id = String(++seq)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout: ' + method)) }, 10000)
    parent.postMessage({ channel: 'kb-plugin', v: 2, id, token, method, params }, '*')
  })
}
```

**强烈建议直接用 SDK**——上面的代码没处理重连、事件多路分发与错误类型映射。

### 2.3 v1 兼容

`v: 1` 或省略 `v` 字段：沿用旧语义（`{ channel, action, payload }`，回包用同名 `action`，无 id 配对）。宿主保留 v1 分支一个版本周期，下一个大版本移除。新插件一律用 v2。

---

## 3. 方法签名

约定：
- `RelPath` = 相对**当前仓库根**的路径，如 `'pages/note.md'`；禁止 `..`、盘符、UNC、绝对路径
- `Json` = 可 JSON 序列化的任意值
- 所有方法返回 `Promise`，失败抛出带 `code` 的 `Error`

### 3.1 `kb.store.*` — 插件私有存储

落盘：`<vault>/.knowbase/plugins/<pluginId>/`。**零授权**，且无法访问其他插件或宿主数据。

| 方法 | 签名 | 说明 |
|---|---|---|
| `store.get` | `(key: string, fallback?: Json) => Promise<Json>` | 读 JSON；不存在或损坏返回 fallback |
| `store.set` | `(key: string, value: Json) => Promise<{ ok: true }>` | 原子写（tmp + rename） |
| `store.delete` | `(key: string) => Promise<{ ok: true }>` | 不存在视为成功 |
| `store.list` | `(prefix?: string) => Promise<{ name: string; size: number; mtime: number }[]>` | 列 `data/` 下文件 |
| `store.doc.read` | `(path: string) => Promise<{ frontmatter: Record<string, unknown>; body: string }>` | Markdown + frontmatter |
| `store.doc.write` | `(path: string, doc: { frontmatter?: object; body: string }) => Promise<{ ok: true }>` | 序列化后原子写 |
| `store.doc.list` | `(prefix?: string) => Promise<{ name: string; size: number }[]>` | 列 `docs/` |
| `store.doc.delete` | `(path: string) => Promise<{ ok: true }>` | — |
| `store.cache.*` | 同 `get/set/delete` | 落 `cache/`，宿主「清理插件缓存」时整体删除 |
| `store.usage` | `() => Promise<{ bytes: number; quotaMb: number; files: number }>` | 供设置页展示 |

限额：单文件 ≤ 10 MB；插件总额默认 200 MB（`contributes.store.quotaMb` 可调）。

```js
await kb.store.set('books/2026', [{ id: 1, name: '高数' }])
const books = await kb.store.get('books/2026', [])
await kb.store.doc.write('notes/分析.md', {
  frontmatter: { tags: ['复盘'], updated: '2026-09-02' },
  body: '# 本周错题分析\n\n…'
})
```

### 3.2 `kb.vault.*` — 仓库文件系统

能力：`vault:read`（读/列/监听）、`vault:write`（写/建/改删）。

| 方法 | 签名 | 能力 |
|---|---|---|
| `vault.getInfo` | `() => Promise<{ rootId: string; name: string }>` | `vault:read` |
| `vault.list` | `(relPath?: string) => Promise<Entry[]>` | `vault:read` |
| `vault.read` | `(relPath: string) => Promise<{ content: string; binary: boolean; size: number; editable: boolean }>` | `vault:read` |
| `vault.write` | `(relPath: string, content: string) => Promise<{ ok: true }>` | `vault:write` |
| `vault.create` | `(relPath: string) => Promise<{ ok: true }>` | `vault:write` |
| `vault.mkdir` | `(relPath: string) => Promise<{ ok: true }>` | `vault:write` |
| `vault.rename` | `(oldRel: string, newRel: string) => Promise<{ ok: true }>` | `vault:write` |
| `vault.trash` | `(relPath: string) => Promise<{ ok: true }>` | `vault:write`（走系统回收站，不真删） |
| `vault.stat` | `(relPath: string) => Promise<{ size: number; mtime: number; isDir: boolean }>` | `vault:read` |
| `vault.watch` | `(patterns: string[]) => Promise<{ ok: true }>` | `vault:read` |

```ts
interface Entry { name: string; type: 'file' | 'dir'; size: number; mtime: number }
```

行为细节（与内置编辑器完全一致）：

- `list` 跳过符号链接与隐藏目录（`.git` / `node_modules` / `.obsidian` 等），文件夹优先 + 中文友好排序
- `read` 对 > 50 MB 文件返回空内容 + `truncated: true`；二进制（前 512 字节 NUL > 5%）返回 `binary: true` 且不带内容；> 10 MB 标 `editable: false`
- `write` 为原子写（临时文件 + rename）
- `trash` 走系统回收站，**不可绕过**
- 路径逐段 lstat，任一段是符号链接即拒绝（`EPATH`）

若清单声明 `vaultScope: ["pages/"]`，则 `write/create/mkdir/rename/trash` 的目标必须落在该前缀内，否则 `EPATH`；读取不受限。

### 3.3 `kb.metadata.*` — 仓库索引

依赖宿主的 `metadataCache`（路线图阶段 2）。未就绪时返回 `ENOTFOUND`。

| 方法 | 签名 |
|---|---|
| `metadata.get` | `(relPath: string) => Promise<{ frontmatter: object; tags: string[]; links: string[] }>` |
| `metadata.search` | `(q: string, opts?: { limit?: number; folder?: string }) => Promise<{ path: string; score: number }[]>` |
| `metadata.query` | `(filter: { tag?: string; folder?: string; frontmatter?: Record<string, unknown> }) => Promise<string[]>` |
| `metadata.backlinks` | `(relPath: string) => Promise<{ from: string; context: string }[]>` |

### 3.4 `kb.ui.*` — 界面扩展

| 方法 | 签名 | 能力 |
|---|---|---|
| `ui.toast` | `(message: string, type?: 'info' \| 'success' \| 'warning' \| 'error') => Promise<void>` | — |
| `ui.notify` | `(title: string, body?: string) => Promise<void>` | `ui.notify` |
| `ui.theme.get` | `() => Promise<Record<string, string>>` | `ui.theme` |
| `ui.theme.apply` | `(vars: Record<string, string>) => Promise<{ ok: true }>` | `ui.theme` |
| `ui.statusBar.create` | `(item: { id; text; align?: 'left' \| 'right'; title?: string; command?: string }) => Promise<Handle>` | `ui.statusBar` |
| `ui.statusBar.update` | `(id: string, patch: { text?: string; title?: string }) => Promise<void>` | `ui.statusBar` |
| `ui.statusBar.dispose` | `(id: string) => Promise<void>` | `ui.statusBar` |
| `ui.modal.open` | `(opts: { title: string; entry: string; width?: number; height?: number }) => Promise<Handle>` | — |
| `ui.panel.open` | `(opts: { slot: string; entry: string; title: string }) => Promise<Handle>` | `ui.panel` |
| `ui.settings.register` | `(opts: { entry: string; title?: string }) => Promise<Handle>` | `ui.settings` |
| `ui.menu.register` | `(opts: { when: string; items: MenuItem[] }) => Promise<Handle>` | `ui.menu` |
| `ui.clipboard.write` | `(text: string) => Promise<void>` | `ui.clipboard` |

`Handle` = `{ dispose(): Promise<void> }`。插件卸载时宿主自动 dispose 全部句柄。

`when` 表达式（白名单求值，不执行代码）：

```
fileType == 'md'          resourceType == 'file' | 'dir'
resourcePath =~ /pages\//
activeModule == 'knowledge'
```

### 3.5 `kb.commands.*`

| 方法 | 签名 | 能力 |
|---|---|---|
| `commands.register` | `(cmd: { id; title; keybinding?: string; run: () => void }) => Promise<Handle>` | `commands` |
| `commands.execute` | `(id: string) => Promise<unknown>` | `commands` |
| `commands.list` | `() => Promise<{ id; title; keybinding?: string }[]>` | `commands` |

- `id` 在插件内唯一，宿主内部改写为 `<pluginId>.<id>`
- 注册命令自动进入 `Ctrl+Shift+P` 命令面板
- 快捷键冲突：内置命令优先，后注册者返回 `ECONFLICT`
- `execute` 只能调用白名单宿主命令：`app.openSettings` / `app.switchModule` / `knowledge.openPage` / `editor.openFile`

### 3.6 `kb.events.*`

```ts
const off = kb.events.on('vault:modify', (payload) => { /* … */ })
off()   // 或 await off()
```

| 事件 | 载荷 | 能力 |
|---|---|---|
| `vault:create` | `{ path: string }` | `vault:read` |
| `vault:modify` | `{ path: string }` | `vault:read` |
| `vault:delete` | `{ path: string }` | `vault:read` |
| `vault:rename` | `{ path: string; oldPath: string }` | `vault:read` |
| `workspace:activeFileChange` | `{ path: string } \| null` | — |
| `workspace:vaultChange` | `{ rootId: string; name: string }` | — |
| `theme:change` | `{ theme: string; vars: Record<string, string> }` | — |
| `plugin:unload` | `{}` | — |
| `host:dataChanged` | `{ scope: string }` | `host:read` |

`vault:*` 事件需要先 `kb.vault.watch(patterns)` 订阅路径模式（glob，如 `['**/*.md']`）。

### 3.7 `kb.ai.*`

| 方法 | 签名 | 能力 |
|---|---|---|
| `ai.complete` | `(req: { prompt: string; maxTokens?: number; model?: string }) => Promise<{ text: string; model: string }>` | `ai` |
| `ai.listTools` | `() => Promise<{ name; title; description; source }[]>` | — |
| `ai.invokeTool` | `(name: string, args?: object) => Promise<unknown>` | `ai:invoke` |
| `ai.renderSkill` | `(req: { id: string; vars?: Record<string, string> }) => Promise<string>` | — |

`complete` 与 `invokeTool` 计入宿主的 `aiToolMonthlyLimit`，超限抛 `ELIMIT`。

**不支持**：插件注册可执行工具（`registerTool(fn)`）。要供能给 AI，请改用清单的 `contributes.skills`（声明式提示词）或 `contributes.tools`（宿主枚举动作）。

### 3.8 `kb.host.*` — 宿主业务数据

能力命名 `host:<module>:<read|write>`，模块取值：`knowledge` / `schedule` / `blog` / `habits` / `bookmarks` / `moments`。

| 方法 | 签名 |
|---|---|
| `host.knowledge.search` | `(q: string) => Promise<{ id; title; snippet }[]>` |
| `host.knowledge.read` | `(id: string) => Promise<{ id; title; content }>` |
| `host.knowledge.createPage` | `(data: { title; content; categoryId?: string }) => Promise<{ id: string }>` |
| `host.knowledge.appendPage` | `(id: string, md: string) => Promise<{ ok: true }>` |
| `host.schedule.listTodos` | `(date: string) => Promise<Todo[]>` |
| `host.schedule.createTodo` | `(data: object) => Promise<{ id: string }>` |
| `host.blog.createEntry` | `(data: { content: string; date?: string }) => Promise<{ id: string }>` |
| `host.habits.list` / `host.habits.check` | `(date?: string)` / `(habitId: string, date: string)` |
| `host.bookmarks.search` | `(q: string) => Promise<Bookmark[]>` |

这组方法复用内置 AI 工具的 handler（`builtinTools.ts`），语义与 `builtin.*` 工具一致。

---

## 4. 生命周期

入口页在收到 `init` 后，若页面导出了生命周期钩子，宿主会通过 `eval` 之外的方式调用——**实际机制**：宿主在 `init` 后 postMessage `{ type: 'lifecycle', phase: 'load' | 'unload' }`，插件自行处理。

```html
<script type="module">
  import { kb, onLifecycle } from './kb-api.mjs'

  let timer = null

  onLifecycle('load', async (ctx) => {
    // ctx: { pluginId, capabilities, vault: { rootId, name } }
    await kb.vault.watch(['**/*.md'])
    timer = setInterval(refreshBadge, 60_000)
    await refreshBadge()
  })

  onLifecycle('unload', () => {
    clearInterval(timer)
  })
</script>
```

触发时机：插件启用 / 禁用、**切换仓库**（先 unload 再 load）、应用退出前。
宿主在 unload 后统一回收事件订阅、statusBar/modal/panel 句柄。

---

## 5. 清单字段全表

### 5.1 顶层字段

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | ✔ | `^[a-z0-9][a-z0-9._-]*$`，也是安装目录名 |
| `name` | string | ✔ | ≤ 50 字符 |
| `version` | string | ✔ | `x.y.z` |
| `type` | `'declarative' \| 'ui'` | ✔ | `code` 被拒收 |
| `entry` | string | ui 必需 | 包内 HTML 文件名，如 `index.html` |
| `apiVersion` | `1 \| 2` | ✖ | 缺省 1；2 = token 会话 + 新命名空间 |
| `capabilities` | string[] | ui 必需 | 见 §5.3 |
| `vaultScope` | string[] | ✖ | 声明后写操作被限制在这些前缀内 |
| `icon` | string | ✖ | 包内图片（svg/png/jpg/webp/gif） |
| `category` | string | ✖ | ≤ 20 字符 |
| `riskLevel` | `'S' \| 'A' \| 'B' \| 'C'` | ✖ | 自报值；宿主取 `max(自报, 强算)` |
| `engineVersion` | string | ✖ | `">=x.y.z"`，不满足则拒绝安装 |
| `activation` | string[] | ✖ | `startup` / `onCommand:<id>` / `onVaultOpen` |
| `author` / `description` | string | ✖ | ≤ 50 / ≤ 300 |
| `contributes` | object | ✔ | 见 §5.2 |

### 5.2 `contributes` 全表

| 键 | 类型要求 | 风险等级贡献 |
|---|---|---|
| `theme` | 主题数组（CSS 变量） | 内容级 S |
| `blogTemplates` | 模板数组 | 内容级 S |
| `helpDocs` | 文档数组 | 内容级 S |
| `pomodoroPresets` | 预设数组 | 内容级 S |
| `skills` | 1-20 条，每条含 `id/title/prompt`，可选 `variables`/`tools` | 内容级 S |
| `sidebarIcons` | 图标包数组（内联 SVG） | 内容级 S |
| `deleteFx` | 删除动画皮肤（SVG + 颜色 + 时长） | 内容级 S |
| `habitPresets` | 预设数组 | 数据级 A |
| `bookmarkPresets` | 预设数组 | 数据级 A |
| `automationRule` | 规则对象 | 数据级 A |
| `knowledgePages` | `{ space, notebooks[] }` 或 `{ notebook, chapters[] }` | 数据级 A |
| `tools` | 1-10 条，每条含 `id/name` | UI 专属 |
| `views` | 1-10 条，每条含 `slot/title`，可选 `mode` | UI 专属 |
| **`dashboardWidgets`** | 1-10 条，每条含 `wid/title`，可选 `w`(2-6)/`h`(1-4) 格子比例 | **新增 · UI 专属** |
| `tables` | 1-20 张表定义 | UI 专属 · **C 级 · 已 deprecated** |
| **`store`** | `{ quotaMb?: number; collections?: string[] }` | **新增 · B 级** |
| **`commands`** | 1-50 条 `{ id, title, keybinding? }` | **新增 · B 级** |
| **`menus`** | 1-20 条 `{ when, items[] }` | **新增 · B 级** |
| **`statusBar`** | 1-5 条 `{ id, align?, title? }` | **新增 · B 级** |
| **`settings`** | `{ entry, title? }` | **新增 · B 级** |

未列出的键一律拒绝安装（宿主白名单强校验）。

### 5.2.1 `contributes.dashboardWidgets` — 看板控件（2026-09-28）

UI 插件可把自己的界面作为卡片挂到「看板」模块的卫星卡片区。声明后**默认不显示**——用户在看板「编辑卡片 → 插件控件」里勾选；插件卸载/停用后卡片自动消失（设置里的勾选残留无害，渲染侧过滤）。

```json
{
  "type": "ui",
  "entry": "index.html",
  "contributes": {
    "dashboardWidgets": [
      { "wid": "word-count", "title": "今日字数", "w": 2, "h": 2 },
      { "wid": "review-board", "title": "复习看板", "w": 4, "h": 2 }
    ]
  }
}
```

- **`wid`**：插件内唯一，`^[a-z0-9][a-z0-9-]{0,39}$`；全局控件 id = **`<pluginId>:<wid>`**（宿主拼，与面板编辑器同口径）。
- **`title`**：卡片标题，≤20 字符。
- **`w` / `h`**：看板磁贴栅格的格子比例，宽 2-6 列 × 高 1-4 行（缺省 2×2）。用户可在看板编辑态拉角改尺寸（存宿主布局设置，不改清单）。
- **运行形态**：沙箱 iframe（与 `views` 同一套 `PluginFrame` 数据桥/主题变量），内嵌标准磁贴卡位；看板编辑态宿主会盖透明遮罩停用 iframe 指针（拖拽需要），非编辑态正常交互。
- **校验**：仅 `type: ui` 且带 `entry` 的插件可声明；1-10 条；`wid` 不得重复。

### 5.3 `capabilities` 取值

| capability | 开放的方法 | 等级 | 默认授予 |
|---|---|---|---|
| `ui.theme`（旧 `theme`） | `ui.theme.*` | B | ✔ |
| `ui.clipboard`（旧 `clipboard`） | `ui.clipboard.*` | B | ✔ |
| `store` | `kb.store.*` | B | ✔ |
| `commands` | `kb.commands.*` | B | ✔ |
| `ui.statusBar` / `ui.notify` / `ui.menu` / `ui.panel` / `ui.settings` | 对应方法 | B | ✔ |
| `data`（旧） | `pluginData.*` + `kb.store.*` | C | ✔（存量）/ 新装需勾选 |
| `knowledge`（旧） | `host:knowledge:read` + `host.review` | C | ✖ |
| `navigation`（旧） | `ui.navigation` | C | ✖ |
| `vault:read` | `kb.vault` 读/列/监听、`kb.metadata.*` | C | ✖ |
| `vault:write` | `kb.vault` 写/建/改删 | C | ✖ |
| `host:<module>:read` | 对应 `kb.host.*` 只读方法 | C | ✖ |
| `host:<module>:write` | 对应 `kb.host.*` 写方法 | C | ✖ |
| `ai` | `kb.ai.complete` | C | ✖ |
| `ai:invoke` | `kb.ai.invokeTool` | C | ✖ |

---

## 6. 错误码

| code | 场景 | 建议处理 |
|---|---|---|
| `EBRIDGE` | token 失效/伪造 | 重新等待 `init`，不要重试当前请求 |
| `ECAPABILITY` | 能力未声明或未授权 | 提示用户到插件页勾选能力 |
| `EPARAM` | 参数类型/必填不符 | 修正调用 |
| `EPATH` | 路径越界或非法 | 检查是否传了绝对路径/`..` |
| `ENOTFOUND` | 目标不存在 | — |
| `ECONFLICT` | 目标已存在 / 快捷键冲突 / 命令 id 重复 | — |
| `ELIMIT` | 月度调用上限 / 存储配额 | 提示到设置页调整 |
| `EDISABLED` | 插件被禁用或命名空间停用 | — |
| `EHOST` | 无当前仓库 / 宿主服务未就绪 | 提示用户先打开仓库 |
| `EINTERNAL` | 宿主内部错误 | 重试一次，仍失败则上报 |

```js
try { await kb.vault.write('a.md', 'x') }
catch (e) {
  if (e.code === 'ECAPABILITY') showGrantHint()
  else if (e.code === 'EHOST') show('请先打开一个仓库')
}
```

---

## 7. 示例

### 7.1 统计型（Store + 状态栏）

统计仓库内 Markdown 数量，显示在状态栏，点击打开面板。

`plugin.json`

```jsonc
{
  "id": "com.example.md-counter",
  "name": "Markdown 计数器",
  "version": "1.0.0",
  "type": "ui",
  "entry": "index.html",
  "apiVersion": 2,
  "capabilities": ["store", "vault:read", "ui.statusBar"],
  "contributes": {
    "store": { "quotaMb": 10 },
    "statusBar": [{ "id": "count", "align": "right", "title": "Markdown 文件数" }]
  }
}
```

`index.html`

```html
<script type="module">
  import { kb, onLifecycle } from './kb-api.mjs'

  onLifecycle('load', async () => {
    const update = async () => {
      const files = await kb.vault.list('')
      let n = 0
      for (const e of files) if (e.type === 'dir') {
        const sub = await kb.vault.list(e.name)
        n += sub.filter(x => x.name.endsWith('.md')).length
      }
      await kb.store.set('stats', { count: n, at: Date.now() })
      await kb.ui.statusBar.update('count', { text: `${n} 篇` })
    }
    await update()
    kb.events.on('vault:create', update)
    kb.events.on('vault:delete', update)
  })
</script>
```

### 7.2 内容型（Vault 读写 + 菜单）

在右键菜单给 `.md` 文件加「插入模板」动作。

```jsonc
{
  "capabilities": ["vault:read", "vault:write", "ui.menu"],
  "vaultScope": ["pages/"],
  "contributes": {
    "commands": [{ "id": "insertTemplate", "title": "插入复盘模板" }],
    "menus": [{ "when": "fileType == 'md'", "items": [{ "command": "insertTemplate" }] }]
  }
}
```

```js
kb.commands.register({
  id: 'insertTemplate',
  run: async (ctx) => {
    const file = await kb.vault.read(ctx.resourcePath)
    const tpl = '\n\n---\n\n## 复盘\n\n- 做得好：\n- 待改进：\n'
    await kb.vault.write(ctx.resourcePath, file.content + tpl)
    kb.ui.toast('已插入复盘模板', 'success')
  }
})
```

### 7.3 学习工具型（Store 替代 tables）

错题本从 `contributes.tables` 迁移到 `store` 的写法对照。

```jsonc
// 旧
"contributes": {
  "tables": [{ "name": "records", "columns": [
    { "name": "id", "type": "TEXT", "notNull": true },
    { "name": "page_id", "type": "TEXT", "notNull": true },
    { "name": "quiz_no", "type": "INTEGER" }
  ]}]
}

// 新
"contributes": {
  "store": { "quotaMb": 200, "collections": ["records", "books"] }
}
```

```js
// 旧：结构化 SQL
await call('data.query', { table: 'records', where: [{ field: 'wrong_count', op: '>', value: 0 }] })

// 新：KV + 内存过滤
const records = await kb.store.get('records', [])
const wrong = records.filter(r => r.wrongCount > 0)
```

迁移路径：`scripts/migrate-plugin-tables.mjs` 读 `plugin_<id>_<table>` → 写 `.knowbase/plugins/<id>/data/<table>.json`，带行数校验与回滚。

---

## 8. 调试

| 场景 | 做法 |
|---|---|
| 看插件日志 | 插件页右键 → 检查（DEV 模式）；`console.error` 会转发到主窗口控制台与 `userData/plugin-debug.log` |
| 看协议报文 | `userData/plugin-debug.log` 记录 `plugin://` 请求；桥报文在 DEV 模式下同文件输出 |
| 热重载 | `kbcli dev --vault <path>`：符号链接插件目录 + 文件变更后自动 reload iframe |
| 校验清单 | `kbcli validate`（与安装器同一套规则，离线运行） |
| 常见坑 | ① 忘记 `apiVersion: 2` → 走 v1 通道，新命名空间返回 `ECAPABILITY`；② `token` 写死 → iframe 重建后全部 `EBRIDGE`；③ 传绝对路径给 `vault.*` → `EPATH` |

---

## 9. 迁移检查表（v1 → v2）

- [ ] 清单加 `"apiVersion": 2`
- [ ] 旧 capability 名改新名（`theme` → `ui.theme`、`clipboard` → `ui.clipboard`），旧名仍可用但建议改
- [ ] 用 `contributes.tables` 的插件：改 `store`，跑迁移脚本，回归后删除 `tables` 声明
- [ ] 手写 postMessage 的插件：换 SDK，处理 `id` 配对与超时
- [ ] 需要文件访问的插件：加 `vault:read` / `vault:write`，并在插件页引导用户勾选能力
- [ ] 有定时器/订阅的插件：实现 `onLifecycle('unload')` 清理
