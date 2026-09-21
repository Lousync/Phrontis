# foliate-js（vendored）

渲染 EPUB / FB2 / CBZ 等电子书格式的阅读引擎。**本项目对其源码做了 3 处修改**（见下「KB PATCH」），
升级时必须重放这些改动。

## 来源与版本

| 项 | 值 |
|---|---|
| 上游 | https://github.com/johnfactotum/foliate-js |
| 授权 | MIT（见同目录 `LICENSE`） |
| 取用方式 | npm 包 `foliate-js@1.0.1`（发布于 2025-04-21） |
| 取用时间 | 2026-09-21 |

> ★ **为何不从 npm 直接依赖**：npm 上的 `foliate-js` **不是作者本人发布的** —— 该版本 maintainer 为
> `shmandadi <saiprakash.mandadi@skillsoft.com>`，只发过这一个版本、2025-04 后无更新，
> 且占用的正是官方包名。官方 README 明确建议以 **git submodule** 方式引入，并声明 API 尚未稳定。
> 我们既需要可信来源、又必须能打补丁（见下），故采取 vendoring。

**已收录的文件**：`view.js` / `epub.js` / `epubcfi.js` / `paginator.js` / `overlayer.js` /
`progress.js` / `text-walker.js` / `search.js` / `tts.js` / `mobi.js` / `fb2.js` /
`comic-book.js` / `fixed-layout.js` / `vendor/{zip,fflate}.js`。

**未收录**：`reader.js` 与 `ui/`（上游自带的整套阅读器 UI 外壳，我们用不到）、
`dict.js` / `opds.js` / `uri-template.js` / `quote-image.js`（词典 / OPDS / 引用图，与阅读无关）。

**外部依赖**：`fixed-layout.js:1` 静态 `import 'construct-style-sheets-polyfill'`
→ 已加入 `package.json` 的 `dependencies`（MIT，calebdwilliams/construct-style-sheets）。
注：Chromium 早已原生支持 constructable stylesheets，该 polyfill 实际不会生效，
但上游是**静态 import**，文件缺了会直接报错，故必须保留。

---

## KB PATCH（3 处，共 4 个文件）

### ① `epub.js` — 子资源改走 `data:` URL

**位置**：`createURL()`；辅助函数 `kbToDataURL()` 定义在 `class Loader` 之前（约 `:708`）。

**动机**：上游把**所有**资源（内容文档、CSS、图片、字体）都做成 `blob:` URL，逼得宿主必须
在 CSP 里为 `img-src` / `style-src` / `font-src` 三处都放开 `blob:`。改为「只有内容文档走
`blob:`」后，子资源走 `data:` —— 而 `img-src` / `font-src` 的现有 CSP **本就允许 `data:`**。

★ **内容文档必须保留 `blob:`**：`paginator.js` 通篇依赖 `iframe.contentDocument`
（`:241` getter、`:278` render 早退、`:286/:305/:336` 分页与排版测量、`:355` expand、
`:337` 图片尺寸、`:411` destroy）。跨源 iframe 的 `contentDocument` 恒为 `null` →
**分页机制整个失效**。同源即 `blob:`，别无选择。

```js
const kbIsDocument = /x?html/i.test(newType || '')
const url = kbIsDocument
    ? URL.createObjectURL(new Blob([newData], { type: newType }))
    : await kbToDataURL(newData, newType)
```

### ② `epub.js` — `revokeObjectURL` 加守卫

**位置**：`unref()`（约 `:777`）与 `destroy()`（约 `:925`）。

`data:` URL 不能也不需要 `revoke`，加 `startsWith('blob:')` 判断。

### ③ `paginator.js:235` + `fixed-layout.js:86` — sandbox 去掉 `allow-scripts`

上游：

```js
// `allow-scripts` is needed for events because of WebKit bug
// https://bugs.webkit.org/show_bug.cgi?id=218086
iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
```

改为 `'allow-same-origin'`。

**理由**：那条 `allow-scripts` 是为绕 **WebKit** bug 218086 —— **本应用跑 Chromium，无该 bug**。
实测去掉后渲染 / 分页 / 进度**全部照常**，而书页内脚本被浏览器层彻底禁止执行：

> `Blocked script execution in 'blob:…' because the document's frame is sandboxed
> and the 'allow-scripts' permission is not set.`

`allow-same-origin` **必须保留**（分页要读 `contentDocument`）。此处是**独立于 CSP 的第二道防线**。

---

## 安全模型（改动这些文件前必读）

1. **上游不做内容净化**。`epub.js:856` 留有作者自己的 TODO：
   `// TODO: replace inline scripts? probably not worth the trouble`
   —— 实测书里的内联 `<script>` 与 `<img onerror>` **都原样存活在 DOM 里**。
2. **实际拦截靠我们自己的两层**：
   - sandbox 不含 `allow-scripts`（见 patch ③）
   - 应用 CSP 的 `script-src 'self'`，**不含 `'unsafe-inline'`**（`blob:` 文档继承父文档 CSP）
3. ⛔ **`script-src` 永不加 `'unsafe-inline'`** —— 那是唯一挡着恶意 EPUB 的东西之一，
   加了等于全盘失守。契约脚本有负向断言锁这一条。
4. ⛔ **sandbox 永不加回 `allow-scripts`**。契约脚本有负向断言锁这一条。

---

## 升级流程

1. 从**上游 git 仓库**取目标 commit（不要再走 npm）。
2. 与本目录逐文件 diff，确认上游变更。
3. **重放上述 3 处 patch**（patch 代码块可直接对照）。
4. 跑契约：`verify-epub-formats.mjs` 的负向断言会检查 sandbox 与 `createURL` 是否仍符合预期。
5. 跑实机探针 `probe-epub-reader.mjs`（含恶意 EPUB 用例：打开后宿主 `window` 必须未被污染）。
