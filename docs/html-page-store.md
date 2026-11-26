# 仓库内 HTML 页面数据（page store）

> 2026-11-26 拍板：仓库里的 `.html` 页面可以读写 `.knowbase/pagesdata/` 下的 JSON，
> 数据文件由**页面自己声明**，软件侧不硬编码任何路径。

## 为什么需要它

知识库里的 html 走 `kbview://` 沙箱渲染（`electron/lib/kbVisualProtocol.ts`）：

- iframe 是 `sandbox="allow-scripts"`（**没有** `allow-same-origin`）→ 不透明源，`localStorage` / `IndexedDB` 直接抛错；
- 响应头 `connect-src 'none'` → `fetch` / `XHR` 全断。

所以页面脚本既存不了状态，也读不了同目录的 json。想让「HTML 看板记进度」真正成立，
就必须由宿主代转、由主进程落盘 —— 这就是 page store。

## 页面怎么写（三步）

```html
<head>
  <!-- ① 声明数据文件：相对仓库根，只允许 .knowbase/pagesdata/*.json -->
  <meta name="kb-store" content=".knowbase/pagesdata/28考研看板.json">
</head>
<body>
<script>
  // ② 在浏览器里打开时没有这个对象 —— 按约定提示「在软件内打开」
  if (!window.KbStore) {
    document.body.innerHTML = '<p>请在 Phrontis 内打开本页（双击本文件即可）</p>'
  } else {
    init()
  }

  async function init() {
    const { exists, data } = await KbStore.read()   // 不存在时 exists=false，data=null
    const state = data || { columns: [] }
    render(state)

    // ③ 改一下就存：1s 防抖，自动串行，不会写乱序
    KbStore.save(state)
  }
</script>
</body>
```

### API

| 调用 | 说明 |
|---|---|
| `KbStore.rel` | 声明的数据文件相对路径（`.knowbase/pagesdata/…json`） |
| `await KbStore.read()` | → `{ exists, data, rev }`；文件不存在不算错误 |
| `KbStore.save(data)` | 1s 防抖自动保存（**日常用它**）；改动越密集越只写一次 |
| `await KbStore.write(data)` | 立即写，返回 `{ ok, rev, conflict, error }` |
| `KbStore.flush()` | 立刻把还在防抖窗口里的改动写出去（关页面前用） |
| `KbStore.onStatus(cb)` | `'dirty' \| 'saving' \| 'saved' \| 'conflict' \| 'error'` |
| `KbStore.onChange(cb)` | `(data, rev)` —— AI 或另一个页面改了同一份数据 |

`rev` 是文件内容的 sha1：读到的 `rev` 会随下一次写自动带上（乐观锁），
**不需要页面自己管**。只有「别处改过、你的 rev 过期」时才会拿到 `conflict`。

### 冲突时怎么办

`conflict` 意味着磁盘上的内容已经不是你读到的样子（AI 刚写过 / 另一个页面写了）。
推荐做法：提示一条「数据已被别处更新」，让用户点一下重新载入 —— 不要自动覆盖。

## 数据文件

| 项 | 规则 |
|---|---|
| 位置 | `.knowbase/pagesdata/**`（**唯一**开写的目录） |
| 扩展名 | `.json` |
| 层级 | 最多 3 层子目录 |
| 单文件 | ≤ 1MB，内容必须是 JSON 对象或数组 |
| 写盘 | `phrontis-core` 的 `writeJsonOrThrow`（临时文件 + rename 原子写） |
| 刷新 | 写盘后广播 `dataChanged('pagesdata')`，打开着同一份数据的页面自动重读 |

多个页面可以声明**同一个**数据文件（看板页 + 周报页共用一份进度），它们会互相同步；
也可以各写各的。

## 安全边界

- 页面只能碰 `.knowbase/pagesdata/`：密码本、日程、错题本等核心模块数据一律不在白名单内
  （`electron/lib/pageStorePath.ts` 硬校验，`..` / 绝对路径 / `%2e` 编码一律拒绝）。
- 渲染侧仍是 `sandbox="allow-scripts"`，`allow-same-origin` **永不添加** ——
  页面拿不到宿主 `window.api`，只能经 postMessage 走这一条通道。
- 写盘后宿主会弹一次「页面已连接数据文件」（每对【页面, 数据文件】每会话一次），
  让用户知道这个页面开始落盘了。
- 入口在**应用内**：同一个 html 用系统浏览器打开时没有 `KbStore`，按约定提示「在软件内打开」。

## AI 侧

三个按需工具（`module: 'pagedata'`，权限页有「页面数据」一行，默认**只读**）：

| 工具 | 作用 |
|---|---|
| `builtin.pagedata.list` | 列出 `.knowbase/pagesdata` 下的数据文件 |
| `builtin.pagedata.read` | 读一份数据（返回 `rev`） |
| `builtin.pagedata.write` | 覆盖写入（带 `rev` 才防覆盖；需在设置里把「页面数据」调成读写） |

典型用法：「数学线代第三章过完了，2.5 小时」→ AI 读 → 改对应卡片与时长 → 写回 →
打开着的看板立刻反映。**不带 `rev` 的写入是强制覆盖**，所以 AI 应先读后写。

## 验证

```bash
node --experimental-strip-types --no-warnings .AGENT/scripts/page-store/verify-page-store.mjs
```

覆盖：路径白名单（含 `..` / 编码穿越 / 大小写扩展名）、内容校验与 1MB 上限、
乐观锁语义、三条白名单分支的注入、两个宿主的 sandbox 属性、
以及**在假 window 里真跑一遍客户端脚本**（宿主晚挂重发 / 防抖合并 / 冲突状态 / 外部变更去重）。

示例页面：`docs/examples/pagesdata-kanban.html`（复制进仓库根目录即可用）。
