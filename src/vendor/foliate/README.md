# foliate-js（vendored）

渲染 EPUB / FB2 / CBZ 等电子书格式的阅读引擎。**本项目对其源码做了 8 处修改**（见下「KB PATCH」），
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

## KB PATCH（8 处，共 6 个文件）

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

### ⑥ `fixed-layout.js` — `#render` 空帧早退（B-17，2026-09-22）

**位置**：`#render()` 开头（约 `:106`）。

**动机**：`#showSpread()` 先把 `#left` / `#right` / `#center` **清成 null**，**之后**才
`await this.#createFrame(...)`。帧上的 `ResizeObserver` 回调 `() => this.#render()`（`:37`）
在这个 await 窗口里**照样会被投递** ⇒ 此刻 `const right = this.#center ?? this.#right` 的
两个来源**都是 null**，而 `right` 在函数体里**处处会用到**：

- `side !== 'left'` 时先撞 `target.width`（`target` 就是 `right`）；
- 两个分支最终都撞 `transform(right)`（解构 null ⇒ 读 `.element`）。

上游默认用例是「左 / 右 / 中三选一」，窗口期短、命中概率低；**宿主拍板
`rendition.spread = 'none'`**（每节都是 `{ center }`）⇒ `#center` 在窗口期**必为 null**
⇒ **每次翻页必踩一次**。页面观感正常（随后那次显式 `#render()` 把版式纠正回来），
属「控制台红字」级别 —— 但它会污染排查别的 ResizeObserver 问题时的证据（B-19 的放大源）。

```js
const left = this.#left ?? {}
const right = this.#center ?? this.#right
if (!right) return          // ← KB PATCH ⑥
```

★ **判据取「`right` 缺席」而不是「三槽全空」**：`#showSpread` 有**两个** await 窗口 ——
① 清空后第一个 `await`（三槽皆空）；② 双页路径里 `#left` 已挂上、`#right` 仍为 null 的那一段。
「三槽全空」罩不住 ②：那条路径上 `side === 'left'` 时前两处都不抛，最后由 `transform(right)`
抛。而 `!right` 把两个窗口一并罩住（②里半边帧也出不了正确的拼版 —— 宽度公式要把左右相加）。
**不会有合法路径被它挡掉**：`right` 缺席时下面那套坐标系本就无从计算（`left` 是 `{}`、
`right` 是 `null`，只会算出 `NaN` 或直接抛），早退只是把「抛异常」换成「什么都不做」；
补上 `#right` 后的显式 `#render()` 会渲最终态。上游若自己修掉，`git diff` 时按本行对照删。

### ⑦ `comic-book.js` — 页图补 MIME（B-18，2026-09-22）

**位置**：`load()` 里的 `URL.createObjectURL(await loadBlob(name))`（约 `:6`）。

**动机**：调用处**不传 `type`** ⇒ `loadBlob` 落进 `new BlobWriter(undefined)`（`view.js:33`）
⇒ 造出的 Blob `type = ''`。`<img src="blob:…">` 靠 **Blob 的 MIME** 选解码器，`type = ''`
时按「未知类型」**拒绝**，**不会**退化成按魔数嗅探 ⇒ 归档里的 `.svg` 页恒为**破图**
（`naturalWidth = 0`，且**无任何报错**）。PNG / JPEG / GIF / WebP 之所以「看起来没事」，
是它们恰好在浏览器硬编码的嗅探表里；SVG 不在 —— 这也是 `exts` 白名单**收了 `.svg` 却不生效**
的原因（白名单放它进归档，解码这一关又把它挡回来）。

```js
const MIME_BY_EXT = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.jxl': 'image/jxl', '.avif': 'image/avif',
}
const load = async name => {
    if (cache.has(name)) return cache.get(name)
    const src = URL.createObjectURL(await loadBlob(name, mimeOf(name)))
    // …
}
```

★ **这条不打开新攻击面**：`<img>` 里的 SVG 在**任何** MIME 下都**不执行脚本**（阶段 2b 的
恶意样书探针已实测：正确 MIME 下可解码、恶意标志位仍全 null）。CSP 的 `img-src` 只放行图片，
内容帧 sandbox 仍无 `allow-scripts`。

★ 只改了**页图**路径。`book.getCover` 同样是裸 `loadBlob`，但宿主没接（宿主用 ⑤ 暴露的
`getPageBlob`），不动它以免扩大改动面。

### ⑧ `paginator.js` — 拆卸时按留存引用撤销观察（B-21，2026-09-22）

**位置**：三处 —— `View` 的字段（约 `:204`）、`View.load()`（约 `:271`）、`View.destroy()` 与
`Paginator.destroy()`（约 `:418` / `:1175`）。

**现象**：打开任何 foliate 系书（epub / fb2 / fbz / cbz）再返回书架，控制台开始以 **166 条/秒**
恒速刷 `ResizeObserver loop completed with undelivered notifications`（实测单轮 357~615 条，
恰好等于该会话停留的秒数 × 166）。**不报错、不影响功能**，但把控制台彻底淹掉；离开那次开书之后
仍继续，直到那个内容文档被 GC —— 所以同一操作时有时无（GC 时机不定），很难当线索用。
按帧速率 166/s 反推，正好是 60fps 下**每帧一条**，即「每次 RO 交付周期都发现有无主通知」。

**根因**：`View` 观察的是**内容帧 `body`**（`this.#observer.observe(doc.body)`）。拆卸顺序上，
宿主先摘 DOM（`EpubReaderView` 的 `view.remove()`）再跑 effect cleanup，于是 `destroy()` 执行时
帧**已经脱离**：`#iframe.contentDocument` 变 `null` ⇒ `View.destroy()` 的门
`if (this.document) this.#observer.unobserve(this.document.body)` **恰好在这一刻失效** ⇒
观察者被永久留在那个**已脱离帧**的 body 上 ⇒ Chromium 每帧交付一次「目标不可渲染」的通知。

> 这条门是典型的**自我否定**：它唯一需要起作用的时刻（帧没了），正是它自己判据失效的时刻。
> 相邻两处是上游笔误：`Paginator.destroy()` 撤销的是 `this`（`Paginator` 实例）而不是它真正
> 观察的 `#container`；且 `this.#view.destroy()` 在 `#view` 为 null 时直接抛，会把后面的清理截断。
>
> 定位手法（一次性脚本，未进库）：在开书之前包一层 `ResizeObserver` + `HTMLIFrameElement.prototype
> .contentDocument` 的 getter，把 observe/unobserve/disconnect 的**调用栈**与「读 contentDocument
> 时帧还在不在」全录下来；再写一个**受控反证**：观察一个 iframe 的 body → 摘掉 iframe → 读数
> 166/s → `disconnect()` → 0/s。两者合起来把机制钉死。

```js
// View 字段：留一个实体引用
#body = null

// View.load()：观察前先留引用（撤销时不再依赖帧是否还在）
this.#body = doc.body
this.#observer.observe(this.#body)

// View.destroy()：按留存引用撤销，不再读 this.document
destroy() {
    if (this.#body) {
        this.#observer.unobserve(this.#body)
        this.#body = null
    }
}

// Paginator.destroy()：撤销真正被观察的 #container；#view 缺席时不要抛
destroy() {
    this.#observer.unobserve(this.#container)
    this.#view?.destroy()
    this.#view = null
}
```

★ **判据不要只看告警条数**：那是**现象**，且受 GC 时机影响（可能自然归零而看着像好了）。
真正的判据是**治本**的 —— 「一轮开书/关书之后，不存在**已不可渲染却仍被观察**的目标」。
回归位：`.AGENT/scripts/workbench-shell/probes/probe-ro-noise.mjs`（六种格式各开一次，
两条判据都断言 0，pdf / txt 顺带作为 B-19 的回归位）。修前该探针在 epub 上必然 ≥1 个残留目标；
修后实测告警 **527 → 0**，时间线里 `unobserve body` 出现在 `View.destroy`。
★ 上游若自行修掉此门（比如改成 `disconnect()`），`git diff` 时按本节对照删。

> ⚠ **判据不要只看告警条数**（2026-09-22 变异测试实测）：把构建产物改回上游那条门后，
> `probe-epub-reader` / `probe-fb2-reader` / `probe-cbz-reader` **都读到 0 条**，只有
> `probe-ro-noise.mjs` 读到 341 条 —— 条数受卸载时机 / GC 影响，**有 bug 时也能是 0**。
> 那三条探针里这一类只报数、不断言（源码注释写明会假通过）；本条的回归位**只在**
> `probe-ro-noise.mjs`，它判的是「**帧内的 window 已消失却仍被观察**」，与计数和 GC 都无关。

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
3. **重放上述 8 处 patch**（patch 代码块可直接对照）。
4. 跑契约：`verify-epub-formats.mjs` 的负向断言会检查 sandbox 与 `createURL` 是否仍符合预期。
5. 跑实机探针 `probe-epub-reader.mjs`（含恶意 EPUB 用例：打开后宿主 `window` 必须未被污染）。
6. 跑 `probe-ro-noise.mjs`（patch ⑧ 的回归位：拆卸后不得留下「已不可渲染却仍被观察」的目标；
   上游若把该门改回 `this.document`，这一步会当场变红）。
