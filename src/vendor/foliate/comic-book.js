export const makeComicBook = async ({ entries, loadBlob, getSize, getComment }, file) => {
    const cache = new Map()
    const urls = new Map()
    // ── KB PATCH（第 7 处，见 src/vendor/foliate/README.md）：B-18 页图补 MIME ──
    //   上游 `loadBlob(name)` 不传 type ⇒ `new BlobWriter(undefined)` ⇒ Blob 的 `type = ''`。
    //   `<img src="blob:…">` 靠 **Blob 的 MIME** 选解码器，`type=''` 时按未知类型**拒绝**，
    //   退化不成魔数嗅探 ⇒ 归档里的 `.svg` 页恒为破图（`naturalWidth = 0`，**且无任何报错**）。
    //   PNG / JPEG / GIF / WebP 之所以「看起来没事」，是它们恰好在浏览器硬编码的嗅探表里；
    //   SVG 不在。★ 这**不是**安全放宽 —— `<img>` 里的 SVG 在任何 MIME 下都不执行脚本
    //   （阶段 2b 恶意样书探针实测：正确 MIME 下可解码、恶意标志位仍全 null）。
    const MIME_BY_EXT = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
        '.svg': 'image/svg+xml', '.jxl': 'image/jxl', '.avif': 'image/avif',
    }
    const mimeOf = name => {
        const dot = name.lastIndexOf('.')
        return dot > -1 ? (MIME_BY_EXT[name.slice(dot).toLowerCase()] ?? '') : ''
    }
    const load = async name => {
        if (cache.has(name)) return cache.get(name)
        const src = URL.createObjectURL(await loadBlob(name, mimeOf(name)))
        const page = URL.createObjectURL(
            new Blob([`<body style="margin: 0"><img src="${src}">`], { type: 'text/html' }))
        urls.set(name, [src, page])
        cache.set(name, page)
        return page
    }
    const unload = name => {
        urls.get(name)?.forEach?.(url => URL.revokeObjectURL(url))
        urls.delete(name)
        cache.delete(name)
    }

    const exts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.jxl', '.avif']
    // ── KB PATCH（第 5 处，见 src/vendor/foliate/README.md）：页序与扩展名判定 ──
    //   ① 上游是裸 `.sort()`（字典序）⇒ `page_10` 排在 `page_2` **之前**。补零命名的 zip
    //      看不出差别，非补零的会静默错页。改自然序比较器；**钉死 'en' 是刻意的** ——
    //      传 undefined 会随运行环境 locale 变，页序就不可复现（探针断言会飘）。
    //   ② 上游 `endsWith` 大小写敏感 ⇒ `.JPG`/`.PNG` 整包被丢，表象是
    //      `No supported image files in archive`（实机 zip 里大写扩展名很常见）。
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
    const files = entries
        .map(entry => entry.filename)
        .filter(name => {
            const lower = name.toLowerCase()
            return exts.some(ext => lower.endsWith(ext))
        })
        .sort((a, b) => collator.compare(a, b))
    if (!files.length) throw new Error('No supported image files in archive')

    const book = {}
    try {
        const jsonComment = JSON.parse(await getComment() || '')
        const info = jsonComment['ComicBookInfo/1.0']
        if (info) {
            const year = info.publicationYear
            const month = info.publicationMonth
            const mm = month && month >= 1 && month <= 12 ? String(month).padStart(2, '0') : null
            book.metadata = {
                title: info.title || file.name,
                publisher: info.publisher,
                language: info.language || info.lang,
                author: info.credits ? info.credits.map(c => `${c.person} (${c.role})`).join(', ') : '',
                published: year && month ? `${year}-${mm}` : undefined,
            }
        } else {
            book.metadata = { title: file.name }
        }
    } catch {
        book.metadata = { title: file.name }
    }
    book.getCover = () => loadBlob(files[0])
    // ── KB PATCH（同上）：暴露页图原始字节 ──
    //    上游只给了 `getCover()`（第 1 页）与 `section.load()`（包好 <img> 的**文档** URL），
    //    宿主拿不到页图本身 ⇒ 做左栏缩略图网格就得在宿主里再解一遍 zip（重复实现 + 双份内存）。
    //    未命中条目返回 null（上游 loader 的既有语义），调用方须自行兜底。
    book.getPageBlob = name => loadBlob(name)
    book.sections = files.map(name => ({
        id: name,
        load: () => load(name),
        unload: () => unload(name),
        size: getSize(name),
    }))
    book.toc = files.map(name => ({ label: name, href: name }))
    book.rendition = { layout: 'pre-paginated' }
    book.resolveHref = href => ({ index: book.sections.findIndex(s => s.id === href) })
    book.splitTOCHref = href => [href, null]
    book.getTOCFragment = doc => doc.documentElement
    book.destroy = () => {
        for (const arr of urls.values())
            for (const url of arr) URL.revokeObjectURL(url)
    }
    return book
}
