# foliate-js（vendored）

渲染 EPUB / FB2 / CBZ 等电子书格式的阅读引擎。**本项目对其源码做了 5 处修改**（见下「KB PATCH」），
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

## KB PATCH（5 处，共 6 个文件）

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

### ④ `fb2.js` — 书内样式表改内联（阶段 2a，2026-09-22）

**位置**：模块级 `fb2CSS`（约 `:173`）+ `template()`（约 `:230`）。

**动机**：上游把 FB2 的内建样式表做成 `blob:` URL，再用 `<link href="blob:…">` 注入每节文档；
宿主 `style-src` 是 `'self' 'unsafe-inline' data:`（**无 `blob:`**）⇒ FB2 排版会**静默失效**
（不报错，只是样式表被 CSP 拦下）。

**改法**：与 ① 同思路 —— 把 CSS 文本直接内联进 `<style>`，`style-src` 因此**无需**放宽：

```js
const fb2CSS = `…上游原 CSS 文本…`

const template = html => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
    <head><style>${fb2CSS}</style></head>
    <body>${html}</body>
</html>`
```

FB2 的节文档本身仍是 `blob:`（与 EPUB 内容文档同理，`paginator` 要读 `contentDocument`），
这条 patch 只动**子资源**。图片走 `data:`（上游 `getImageSrc` 本就用 `data:`）。

### ⑤ `comic-book.js` — 页序自然序 / 扩展名大小写 / 暴露页图字节

**位置**：`entries.map(...).filter(...).sort()` 一处；`book.getCover` 之后一处。

**动机**（三件事，都是 cbz 实机必踩）：

1. **页序**：上游是裸 `.sort()`（字典序）⇒ `page_10` 排在 `page_2` **之前**。补零命名的 zip
   看不出差别，非补零的**静默错页**（页序错 = 内容错，且无任何报错）。
2. **扩展名判定**：上游 `name.endsWith(ext)` 大小写敏感 ⇒ `.JPG`/`.PNG` 整包被过滤掉，
   表象是 `No supported image files in archive`；实机 zip 里大写扩展名很常见。
3. **页图字节**：上游只给了 `getCover()`（第 1 页）与 `section.load()`（包好 `<img>` 的
   **文档** URL）。宿主做左栏缩略图网格需要页图本身，不暴露就得在宿主里再解一遍 zip
   （重复实现 + 双份内存）。

```js
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const files = entries
    .map(entry => entry.filename)
    .filter(name => {
        const lower = name.toLowerCase()
        return exts.some(ext => lower.endsWith(ext))
    })
    .sort((a, b) => collator.compare(a, b))
// …
book.getPageBlob = name => loadBlob(name)
```

★ **钉死 `'en'` 是刻意的**：`Intl.Collator(undefined, …)` 会随运行环境 locale 变，页序将不可复现
（探针断言会飘）。`getPageBlob` 未命中条目返回 `null`（上游 loader 的既有语义），调用方须兜底。

★ **这条 patch 不减少 CSP 例外，与 ① 相反**：cbz 的页图**只能**走 `blob:`（`comic-book.js` 给每页图
各造一个 blob URL，再套进一层 blob 文档），故 `index.html` 的 `img-src` 放开了 `blob:`。
页图动辄数 MB，不适用 ① 那条「子资源改走 `data:`」的口径。风险面仅限「多一类图片来源」——
`img` 通道不能执行脚本，SVG-as-`<img>` 亦然，且内容帧 sandbox 仍无 `allow-scripts`。

---

## 安全模型（改动这些文件前必读）

1. **上游不做内容净化**。`epub.js:856` 留有作者自己的 TODO：
   `// TODO: replace inline scripts? probably not worth the trouble`
   —— 实测书里的内联 `<script>` 与 `<img onerror>` **都原样存活在 DOM 里**。
2. **实际拦截靠我们自己的两层 + 上游的一层加载策略**：
   - sandbox 不含 `allow-scripts`（见 patch ③）
   - 应用 CSP 的 `script-src 'self'`，**不含 `'unsafe-inline'`**（`blob:` 文档继承父文档 CSP）
   - 上游 `epub.js:794`：`MIME.JS` 命中且 `allowScript=false`（默认值，本应用未改）→
     `loadItem` 直接返回 `null`，**脚本子资源根本不进加载流程**。实测 `<script src="evil.js">`
     标签仍在 DOM，但属性被 `replaceString` 写成字符串 `"null"`（更不可能加载）；
     内联 `<script>` 则原样留存、由上面两层拦下。探针 `probe-epub-reader.mjs` 的第 9 步
     对三种载荷逐一验「在 DOM 里 + 一句未执行」。
3. ⛔ **`script-src` 永不加 `'unsafe-inline'`** —— 那是唯一挡着恶意 EPUB 的东西之一，
   加了等于全盘失守。契约脚本有负向断言锁这一条。
4. ⛔ **sandbox 永不加回 `allow-scripts`**。契约脚本有负向断言锁这一条。

---

## 升级流程

1. 从**上游 git 仓库**取目标 commit（不要再走 npm）。
2. 与本目录逐文件 diff，确认上游变更。
3. **重放上述 5 处 patch**（patch 代码块可直接对照）。
4. 跑契约：`verify-epub-formats.mjs` 的负向断言会检查 sandbox 与 `createURL` 是否仍符合预期。
5. 跑实机探针 `probe-epub-reader.mjs`（含恶意 EPUB 用例：打开后宿主 `window` 必须未被污染）。
