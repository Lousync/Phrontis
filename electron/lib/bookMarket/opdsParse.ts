/**
 * 书市 · OPDS / JSON 解析（方案 §三 解析条、拍板 ①）。
 *
 * **零依赖纯函数文件** —— 不 import electron / fs / 任何相对模块。
 * 契约脚本 `.AGENT/scripts/book-market/verify-opds-parse.mjs` 用
 * `node --experimental-strip-types` 直接 import 本文件跑用例（fixture 是**真抓的 feed**）。
 * ★ 一旦这里出现运行时 import（哪怕自家零依赖模块），脚本会 Cannot find module ——
 *   要带 `.ts` 扩展名才解析得到。所以「可读性判定」不在本文件：那要 `bookExtOf()`，
 *   本文件改为**注入** `extOf` / `extFromMime` 两个回调（见 `toBookMarketItems`）。
 *
 * 只覆盖本场景真实出现的构造（拍板 ①）：元素与属性、实体引用、CDATA、自闭合标签、
 * `dc:` / `atom:` 这类前缀按**字面标签名**处理。**不追求通用 XML 规范实现** ——
 * 遇到不认识的构造宁可丢弃该条目，也不抛错（与 jsonStore 的「损坏不阻断」口径一致）。
 *
 * ★★ 两条由**真实 feed 实测**逼出来的硬约束（改之前先看 fixture）：
 *   ① **属性顺序不敏感** —— Gutenberg 的 `<link>` 是 `type,rel,title,length,href`，
 *      Standard Ebooks 是 `href,length,rel,title,type`。任何「按属性位置切」的写法都会在
 *      另一家静默错（不抛错、只是永远取不到值）。
 *   ② **两级结构** —— Gutenberg 的检索 feed 里 8 条 entry 全是 `rel="subsection"` 指针
 *      （还有 2 条是 Authors / Subjects **导航**条目），真正的 acquisition 链接在下一层
 *      `/ebooks/<id>.opds`。本文件负责把「这一条是书还是指针」判出来（`subFeedUrl`），
 *      展开一层由 `sourceClient` 做（并发池在那边）。
 */

// ===== XML 极简解析 =====

export interface XmlNode {
  /** 字面标签名（`dc:creator` 原样保留，前缀不做命名空间解析） */
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** 本节点的**直接**文本（不含后代；CDATA 已并入） */
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** 实体引用解码：具名五个 + `&#nn;` + `&#xnn;`；认不出的原样保留（不抛错） */
export function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = ENTITIES[body]
    return named === undefined ? whole : named
  })
}

/** 已闭合的标签 → 不再期待闭合（HTML 式空元素也一并容错） */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'source'])

/**
 * 去掉文本里残留的标记。**实测必需**：Standard Ebooks 的 `<content type="html">`
 * 里是**转义过的 HTML**（`&lt;p&gt;&lt;i&gt;…`）—— 经 `decodeEntities` 之后就是带标签的文本，
 * 直接当简介显示会在书卡上露出 `<p><i>` 与 `&quot;`。
 * ★ 只给「HTML 型 content」这条兜底路径用；`<summary>` 与 `<content type="xhtml">`
 *   （Gutenberg 的真元素）本身已经是纯文本，过一道也无害。
 */
export function stripMarkup(s: string): string {
  return s
    // 标签换**空格**而不是空串：`<p>a</p><p>b</p>` 换空串会粘成 `ab`
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    // 收拾标签留下的悬空空格：`<i>Holmes</i>, published` 会变成 `Holmes , published`
    .replace(/\s+([,.;:!?)\]}»”’])/g, '$1')
    .trim()
}

/**
 * 解析成节点树。**认不出就返回 null，绝不抛错。**
 * 容错点：注释 / `<?xml?>` / `<!DOCTYPE>` 一律跳过；未闭合的标签在 EOF 处容错收尾。
 */
export function parseXml(src: string): XmlNode | null {
  if (typeof src !== 'string' || !src) return null
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0
  const n = src.length
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      stack[stack.length - 1].text += decodeEntities(src.slice(i))
      break
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      // ★ CDATA 里是**原文**，不解实体（这正是 CDATA 的意义）
      stack[stack.length - 1].text += src.slice(lt + 9, end < 0 ? n : end)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt)
      i = end < 0 ? n : end + 1
      continue
    }
    const gt = src.indexOf('>', lt)
    if (gt < 0) {
      // 末尾残缺的半个标签：当文本丢掉（不抛错）
      break
    }
    const raw = src.slice(lt + 1, gt)
    i = gt + 1
    if (raw[0] === '/') {
      const name = raw.slice(1).trim().toLowerCase()
      // 闭合到最近的同名节点；找不到就忽略（不抛错）
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].tag.toLowerCase() === name) {
          stack.length = d
          break
        }
      }
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const nameEnd = body.search(/[\s/]/)
    const tag = (nameEnd < 0 ? body : body.slice(0, nameEnd)).trim()
    if (!tag) continue
    const node: XmlNode = {
      tag,
      attrs: parseAttrs(nameEnd < 0 ? '' : body.slice(nameEnd)),
      children: [],
      text: '',
    }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing && !VOID_TAGS.has(tag.toLowerCase())) stack.push(node)
  }
  return root
}

/** 属性解析：单双引号、无引号值都收；**顺序无关**（这是实测逼出来的硬约束） */
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const name = m[1]
    if (!name || name === '/') continue
    const value = m[2] ?? m[3] ?? m[4] ?? ''
    // 同名属性只留第一个（后面的是畸形数据）
    if (!(name in out)) out[name] = decodeEntities(value)
  }
  return out
}

/** 属性取值：**不区分大小写**（XML 本区分大小写，这里刻意放宽 —— 源五花八门） */
export function attrOf(node: XmlNode | null | undefined, name: string): string {
  if (!node) return ''
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.toLowerCase() === want) return v
  }
  return ''
}

/** 节点的**全部**文本（自身 + 后代），空白折叠后去首尾 */
export function nodeText(node: XmlNode | null | undefined): string {
  if (!node) return ''
  let acc = node.text
  for (const c of node.children) acc += ` ${nodeText(c)}`
  return acc.replace(/\s+/g, ' ').trim()
}

/** 按字面标签名（不区分大小写）找**直接**子节点，可给多级路径 `feed/entry` */
export function findChild(node: XmlNode | null | undefined, path: string): XmlNode | null {
  let cur: XmlNode | null = node ?? null
  for (const seg of path.split('/')) {
    if (!cur) return null
    const want = seg.toLowerCase()
    cur = cur.children.find((c) => c.tag.toLowerCase() === want) ?? null
  }
  return cur
}

/** 按标签名找**所有后代**（深度优先，含自身） */
export function findAll(node: XmlNode | null | undefined, tag: string): XmlNode[] {
  const want = tag.toLowerCase()
  const out: XmlNode[] = []
  const walk = (cur: XmlNode): void => {
    for (const c of cur.children) {
      if (c.tag.toLowerCase() === want) out.push(c)
      walk(c)
    }
  }
  if (node) walk(node)
  return out
}

// ===== OPDS / Atom =====

/** 只收 `http` / `https`（挡 `data:` 内联图与各种本地 scheme —— Gutenberg 部分封面就是 base64 内联） */
export function isHttpUrl(v: unknown): boolean {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return false
  try {
    const p = new URL(s)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

/** 相对 href → 绝对 URL（相对 feed 自身地址解析）。认不出返回 ''（不抛错） */
export function resolveUrl(href: unknown, baseUrl: string): string {
  const h = typeof href === 'string' ? href.trim() : ''
  if (!h) return ''
  try {
    const abs = new URL(h, isHttpUrl(baseUrl) ? baseUrl : undefined)
    return abs.href
  } catch {
    return ''
  }
}

/**
 * OPDS 的 acquisition 关系判定。
 * ★ 收 `…/acquisition` 与 `…/acquisition/open-access`（实测：**Standard Ebooks 全用后者**）；
 *   排除 `/buy` `/borrow` `/subscribe` `/sample` —— §八 明确不做受控借阅与商业平台，
 *   把它们当可下载会给用户一个点了没反应的下载键。
 */
export function isAcquisitionRel(rel: string): boolean {
  const r = String(rel ?? '').trim().toLowerCase()
  if (r === 'http://opds-spec.org/acquisition' || r === 'https://opds-spec.org/acquisition') return true
  const m = /^https?:\/\/opds-spec\.org\/acquisition\/([a-z-]+)$/.exec(r)
  if (!m) return false
  return m[1] === 'open-access'
}

/** 一个 `<link>` 的归一形状 */
export interface FeedLink {
  rel: string
  href: string
  type: string
  title: string
  /** `length` 属性（字节）；认不出为 null */
  length: number | null
}

const NON_SUB_FEED_RELS = new Set(['self', 'start', 'search', 'alternate', 'related', 'next', 'prev', 'first', 'last', 'up'])

export interface FeedEntry {
  id: string
  title: string
  author: string
  summary: string
  /** 封面绝对 URL；认不出 / 是 `data:` 内联图 → '' */
  coverUrl: string
  /** 全部 `<link>`（href 已解析成绝对） */
  links: FeedLink[]
  /** 本 entry 的 acquisition 候选（顺序 = 源给的顺序） */
  acquisitions: FeedLink[]
  /** 本条若是指向「书的下一层 feed」则给出绝对 URL，否则 ''（两级展开用） */
  subFeedUrl: string
}

/**
 * 一条 entry 的作者：**三路兜底**（实测两家都不给 `dc:creator`）——
 * `dc:creator` → `author/name` → 子 `<content type="text">`（Gutenberg 把作者塞这儿）。
 */
function entryAuthor(entry: XmlNode): string {
  const dc = findAll(entry, 'dc:creator')[0]
  const dcText = nodeText(dc)
  if (dcText) return dcText
  const name = nodeText(findChild(findChild(entry, 'author'), 'name'))
  if (name) return name
  // Gutenberg：<content type="text">Arthur Thomas Malkin</content>
  for (const c of findAll(entry, 'content')) {
    if (attrOf(c, 'type').toLowerCase() === 'text') {
      const t = nodeText(c)
      if (t) return t
    }
  }
  return ''
}

/**
 * 一条 entry 的简介：`<summary>` 优先，其次 HTML 型 `<content>`。
 * ★ 后一条必须过 `stripMarkup`：SE 的 `type="html"` content 是**转义 HTML**，
 *   `nodeText` 出来的就是带 `<p><i>` 的原文（实测，见 `stripMarkup` 头注）。
 */
function entrySummary(entry: XmlNode): string {
  const sum = nodeText(findChild(entry, 'summary'))
  if (sum) return sum
  for (const c of findAll(entry, 'content')) {
    const t = attrOf(c, 'type').toLowerCase()
    if (t === 'html' || t === 'xhtml') {
      const text = stripMarkup(nodeText(c))
      if (text) return text
    }
  }
  return ''
}

function toFeedLink(node: XmlNode, baseUrl: string): FeedLink {
  const len = Number(attrOf(node, 'length'))
  return {
    rel: attrOf(node, 'rel'),
    href: resolveUrl(attrOf(node, 'href'), baseUrl),
    type: attrOf(node, 'type'),
    title: attrOf(node, 'title'),
    length: Number.isFinite(len) && len > 0 ? Math.floor(len) : null,
  }
}

/** 封面：优先 `rel` 含 `image/thumbnail`，其次含 `image`；非 http(s) 一律丢 */
function entryCover(entry: XmlNode, links: FeedLink[]): string {
  const pick = (pred: (l: FeedLink) => boolean): string =>
    links.find((l) => pred(l) && isHttpUrl(l.href))?.href ?? ''
  return (
    pick((l) => l.rel.includes('opds-spec.org/image/thumbnail')) ||
    pick((l) => l.rel.includes('opds-spec.org/image')) ||
    pick((l) => l.rel.includes('image') && !!l.type && l.type.startsWith('image/'))
  )
}

export interface ParsedFeed {
  entries: FeedEntry[]
  /** `opensearch:totalResults`；认不出为 null（它的值是**总数**不是本页条数） */
  totalResults: number | null
  /** `rel="next"` 的绝对 URL；没有则 ''（拍板 ⑧ 的「加载更多」用它） */
  nextPageUrl: string
  /** 本 feed 的 self 地址（解析相对 href 的基准） */
  feedUrl: string
}

/**
 * 解析一份 Atom / OPDS feed。**认不出就返回 null，绝不抛错。**
 * `feedUrl` = 取这份 feed 时用的地址（相对 href 的解析基准）。
 */
export function parseAtomFeed(xml: string, feedUrl: string): ParsedFeed | null {
  const root = parseXml(xml)
  if (!root) return null
  const feed = findChild(root, 'feed') ?? findAll(root, 'feed')[0] ?? null
  if (!feed) return null
  const base = feedUrl
  const entries: FeedEntry[] = []
  // 只认 feed 的**直接**子 entry（别用 findAll —— 嵌套 feed / `<content>` 里再出现 entry 会串）
  for (const e of feed.children.filter((c) => c.tag.toLowerCase() === 'entry')) {
    const links = findAll(e, 'link').map((l) => toFeedLink(l, base))
    const acquisitions = links.filter((l) => isAcquisitionRel(l.rel) && isHttpUrl(l.href))
    // 子 feed 指针：type 含 opds-catalog 且 rel 不是 self/start/search/alternate/related 之流
    const sub = links.find(
      (l) =>
        isHttpUrl(l.href) &&
        l.type.toLowerCase().includes('opds-catalog') &&
        !NON_SUB_FEED_RELS.has(l.rel.trim().toLowerCase()),
    )
    entries.push({
      id: nodeText(findChild(e, 'id')),
      title: nodeText(findChild(e, 'title')),
      author: entryAuthor(e),
      summary: entrySummary(e),
      coverUrl: entryCover(e, links),
      links,
      acquisitions,
      subFeedUrl: acquisitions.length === 0 && sub ? sub.href : '',
    })
  }
  // ★ 没这个标签时必须是 null，不能落成 0（0 与「源没说」在「加载更多」的剩余条数上含义不同）
  const totalText = nodeText(findChild(feed, 'opensearch:totalResults'))
  const total = totalText === '' ? NaN : Number(totalText)
  // feed 级的分页链接只看**直接**子节点 —— 用 findAll 会把 entry 内部的 next 也捞进来
  const next = feed.children
    .filter((c) => c.tag.toLowerCase() === 'link')
    .map((l) => toFeedLink(l, base))
    .find((l) => l.rel.trim().toLowerCase() === 'next')
  return {
    entries,
    totalResults: Number.isFinite(total) && total >= 0 ? Math.floor(total) : null,
    nextPageUrl: next && isHttpUrl(next.href) ? next.href : '',
    feedUrl: base,
  }
}

/**
 * 从子 feed 里挑出「这本书」的 acquisition：
 * 取**第一条带 acquisition 的 entry**。
 * ★ 为什么不是 `entries[0]`：Gutenberg 的检索 feed 里混着 Authors / Subjects 这类**导航**
 *   条目，展开后拿到的是一个「作者列表 feed」，其 entry 全无 acquisition —— 用 [0] 会
 *   把第一个作者名当成书名。按「第一个带 acquisition 的 entry」取，导航条目自然被丢掉。
 */
export function pickAcquisitionFromChildFeed(xml: string, childFeedUrl: string): FeedEntry | null {
  const feed = parseAtomFeed(xml, childFeedUrl)
  if (!feed) return null
  return feed.entries.find((e) => e.acquisitions.length > 0) ?? null
}

// ===== 声明式取值路径（JSON 映射；拍板 ⑤ 的 `responseType: 'json'` 走这条） =====

interface PathSeg {
  key: string
  /** `[*]` = 展开数组全部元素 */
  star: boolean
  /** `[n]` = 定下标；-1 = 无下标 */
  index: number
}

/**
 * 路径语言：`a.b[*].c`（数组展开）/ `a.b[0].c`（定下标）。
 * **不含表达式、不含函数调用**（方案 §三 边界：映射只是取值）。
 * 首段也可以是 `[*]`（作用于根数组）。
 */
export function parseJsonPath(path: string): PathSeg[] | null {
  const p = String(path ?? '').trim()
  if (!p) return null
  const segs: PathSeg[] = []
  for (const rawSeg of p.split('.')) {
    if (!rawSeg) return null
    const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(rawSeg)
    if (!m) return null
    const key = m[1]
    const brackets = m[2]
    if (!brackets) {
      if (!key) return null
      segs.push({ key, star: false, index: -1 })
      continue
    }
    // 一个段最多带一个下标（`books[*]` / `files[0]`）；多个下标（`a[0][1]`）不支持
    const inner = /^\[([^\]]*)\]$/.exec(brackets)
    if (!inner) return null
    const body = inner[1].trim()
    if (body === '*') segs.push({ key, star: true, index: -1 })
    else if (/^\d+$/.test(body)) segs.push({ key, star: false, index: Number(body) })
    else return null
  }
  return segs
}

/** 按路径取值，返回**全部命中值**（`[*]` 会命中多个；认不出返回空数组，不抛错） */
export function readJsonPath(doc: unknown, path: string): unknown[] {
  const segs = parseJsonPath(path)
  if (!segs) return []
  let cur: unknown[] = [doc]
  for (const seg of segs) {
    const next: unknown[] = []
    for (const v of cur) {
      let holder: unknown[]
      if (seg.key === '') {
        holder = [v] // 首段形如 `[*]`：直接作用于当前值
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        const child = (v as Record<string, unknown>)[seg.key]
        if (child === undefined || child === null) continue
        holder = [child]
      } else {
        continue
      }
      for (const h of holder) {
        if (seg.star) {
          if (Array.isArray(h)) next.push(...h)
          else if (h && typeof h === 'object') next.push(...Object.values(h as Record<string, unknown>))
        } else if (seg.index >= 0) {
          if (Array.isArray(h) && seg.index < h.length) next.push(h[seg.index])
        } else {
          next.push(h)
        }
      }
    }
    cur = next
  }
  return cur.filter((v) => v !== undefined && v !== null)
}

/** 取第一个命中值并转成字符串（数字 / 布尔也收；对象数组一律丢） */
function firstStr(doc: unknown, path: string): string {
  for (const v of readJsonPath(doc, path)) {
    if (typeof v === 'string') {
      const s = v.trim()
      if (s) return s
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      return String(v)
    }
  }
  return ''
}

// ===== 统一条目模型（可读性由注入的回调判，见文件头注） =====

/** 一个候选下载源（OPDS 的每条 acquisition / JSON 的单条合成） */
export interface ItemCandidate {
  url: string
  /** 源给的格式：OPDS = link 的 `type`（MIME）；JSON = mapping 的 `format` 字段值 */
  format: string
  sizeBytes: number | null
}

/** 归一后的条目（**未判可读性**，可读性在 `toBookMarketItems` 里由回调判） */
export interface RawItem {
  title: string
  author: string
  summary: string
  coverUrl: string
  candidates: ItemCandidate[]
}

/** 与 `src/types/index.ts` 的 `BookMarketItem` 同形（那边是渲染层镜像声明） */
export interface BookMarketItemShape {
  sourceId: string
  sourceName: string
  title: string
  author: string
  summary: string
  coverUrl: string
  downloadUrl: string
  ext: string
  sizeBytes: number | null
  readable: boolean
}

export interface ItemBuildDeps {
  sourceId: string
  sourceName: string
  /** 路径 / 带点裸扩展名 → 扩展名；未收录返回 null（真实调用方传 `bookExtOf`） */
  extOf: (s: string) => string | null
  /** MIME → 扩展名；未收录返回 null（真实调用方传 `bookExtFromMime`） */
  extFromMime: (mime: string) => string | null
}

/** 候选的扩展名：**源给的格式字段 → MIME → URL**（顺序不可换，理由见 `bookExtFromMime` 头注） */
function candidateExt(c: ItemCandidate, deps: ItemBuildDeps): string {
  const byFormat = deps.extOf(c.format.startsWith('.') ? c.format : `.${c.format}`)
  if (byFormat) return byFormat
  const byMime = deps.extFromMime(c.format)
  if (byMime) return byMime
  return deps.extOf(c.url) ?? ''
}

/**
 * 归一后的条目 → **统一条目模型**（`BookMarketItem`）。
 *
 * 下载链接选择：**取第一条可读的候选**（源给的顺序即它的偏好序）；
 * 一条可读的都没有但有候选 ⇒ 取第一条并置 `readable:false`（书卡据此标「暂不支持」+ 禁用下载）；
 * 连候选都没有（纯导航 entry）⇒ `downloadUrl:''` / `readable:false`。
 *
 * 体积取**被选中那条候选**的（不是第一条的 —— 选错了会让体积闸拿错数字）。
 */
export function toBookMarketItems(raws: RawItem[], deps: ItemBuildDeps): BookMarketItemShape[] {
  const out: BookMarketItemShape[] = []
  for (const raw of raws) {
    if (!raw.title) continue // 没有书名的条目没有意义（同 schema 的 coerceBookMetaEntry 口径）
    const scored = raw.candidates.map((c) => ({ c, ext: candidateExt(c, deps) }))
    const chosen = scored.find((s) => s.ext) ?? scored[0] ?? null
    const ext = chosen?.ext ?? ''
    out.push({
      sourceId: deps.sourceId,
      sourceName: deps.sourceName,
      title: raw.title,
      author: raw.author,
      summary: raw.summary,
      coverUrl: isHttpUrl(raw.coverUrl) ? raw.coverUrl : '',
      downloadUrl: chosen?.c.url ?? '',
      ext,
      sizeBytes: chosen?.c.sizeBytes ?? null,
      readable: !!ext && !!chosen?.c.url,
    })
  }
  return out
}

/** OPDS entry → `RawItem`（acquisition 全部进候选，选哪条交给 `toBookMarketItems`） */
export function feedEntryToRawItem(entry: FeedEntry): RawItem {
  return {
    title: entry.title,
    author: entry.author,
    summary: entry.summary,
    coverUrl: entry.coverUrl,
    candidates: entry.acquisitions.map((l) => ({ url: l.href, format: l.type, sizeBytes: l.length })),
  }
}

/** JSON 文档 + 映射 → `RawItem`[]（`list` 路径定条目数组，其余字段逐条取值） */
export function jsonToRawItems(
  doc: unknown,
  mapping: { list: string; title: string; author?: string; cover?: string; summary?: string; download: string; format?: string },
  baseUrl: string,
): RawItem[] {
  const rows = readJsonPath(doc, mapping.list)
  const out: RawItem[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const title = firstStr(row, mapping.title)
    if (!title) continue
    const abs = (v: string): string => (isHttpUrl(v) ? v : resolveUrl(v, baseUrl))
    out.push({
      title,
      author: mapping.author ? firstStr(row, mapping.author) : '',
      summary: mapping.summary ? firstStr(row, mapping.summary) : '',
      coverUrl: mapping.cover ? abs(firstStr(row, mapping.cover)) : '',
      candidates: [
        {
          url: abs(firstStr(row, mapping.download)),
          format: mapping.format ? firstStr(row, mapping.format) : '',
          // 映射语言里没有体积字段（拍板 ⑤ 的键集不含 size）⇒ 未知，留给 S3 的 Content-Length 判
          sizeBytes: null,
        },
      ],
    })
  }
  return out
}
