import type { IntelItem, IntelKind, IntelSection, IntelSourceKey } from '../types'

/**
 * 情报模块纯函数（v3.12.0，docs/intel-module-plan.md §4.2）。
 *
 * 主进程（清洗/打分管线）、渲染层（feed 过滤/源徽标）、契约脚本（verify-intel-pipeline）
 * 三方共用 —— 语义移植自 OpenCollector pipeline/cleaner.py。**零依赖**（sha256 内联实现，
 * Node/浏览器/裸 node 脚本都能跑；主进程渲染层都不需要各自再引 hash 库）。
 *
 * 本文件保持零 value import（只 import type），契约脚本 strip-types 直跑不炸。
 */

// ===== 源元数据（渲染层侧栏徽标也用它，别在组件里抄第二份）=====

export interface IntelSourceMeta {
  label: string
  kind: IntelKind
  /** 版面（v2）：侧栏分组 + 头条视图分区 + 打分分化都用它 */
  section: IntelSection
  /** 源权重（打分 30 分段内的归一分母 = 权重最大值） */
  weight: number
  /** 侧栏 / 徽标色（对齐原型 feed-module-proto 的 --src-*） */
  fg: string
}

export const SOURCE_META: Record<IntelSourceKey, IntelSourceMeta> = {
  github:         { label: 'GitHub',      kind: 'repo',   section: 'tech',     weight: 26, fg: '#8b949e' },
  hn:             { label: 'Hacker News', kind: 'news',   section: 'tech',     weight: 24, fg: '#ff6600' },
  arxiv:          { label: 'arXiv',       kind: 'paper',  section: 'tech',     weight: 26, fg: '#e04040' },
  openalex:       { label: 'OpenAlex',    kind: 'paper',  section: 'tech',     weight: 24, fg: '#4ec9b0' },
  weekly:         { label: '阮一峰周刊',  kind: 'weekly', section: 'tech',     weight: 28, fg: '#a371f7' },
  hf:             { label: 'HF Papers',   kind: 'paper',  section: 'tech',     weight: 27, fg: '#c98a00' },
  labs:           { label: 'AI 官方博客', kind: 'blog',   section: 'tech',     weight: 27, fg: '#6f9dff' },
  qbitai:         { label: '量子位',      kind: 'news',   section: 'tech',     weight: 20, fg: '#d4549a' },
  cnblogs:        { label: '博客园',      kind: 'blog',   section: 'tech',     weight: 21, fg: '#2e8b57' },
  csdn:           { label: 'CSDN',        kind: 'blog',   section: 'tech',     weight: 20, fg: '#c92027' },
  chinanews:       { label: '中新网·滚动', kind: 'news',  section: 'domestic', weight: 22, fg: '#2f7fbf' },
  chinanews_world: { label: '中新网·国际', kind: 'news',  section: 'world',    weight: 22, fg: '#3a8fd0' },
  wallstcn:        { label: '华尔街见闻',  kind: 'news',  section: 'finance',  weight: 24, fg: '#b08d2f' },
}

export const INTEL_SOURCE_KEYS = Object.keys(SOURCE_META) as IntelSourceKey[]

/** 版面展示顺序与名称（v2 侧栏分组 / 头条视图 / AI 注入共用，别在组件里抄第二份） */
export const SECTIONS: readonly IntelSection[] = ['tech', 'domestic', 'world', 'finance']
export const SECTION_META: Record<IntelSection, { label: string }> = {
  tech: { label: '科技' },
  domestic: { label: '时政 · 国内' },
  world: { label: '国际' },
  finance: { label: '财经' },
}

/** source 键 → 版面（内置源查表；自定义源/未知键兜 tech —— 自定义条目落库时自带 section，不走这里） */
export function sectionOf(source: string): IntelSection {
  return SOURCE_META[source as IntelSourceKey]?.section ?? 'tech'
}

/** source 键 → 源权重（内置源查表；自定义源固定 18，低于全部内置源） */
export function sourceWeightOf(source: string): number {
  return SOURCE_META[source as IntelSourceKey]?.weight ?? 18
}

/** 论文类来源（AI「只看论文」筛选与 feed pill 同口径） */
export const PAPER_SRCS: readonly IntelSourceKey[] = ['arxiv', 'openalex', 'hf']
/** 中文来源（AI「只看中文」筛选；v2.1 起含 3 个新闻源——人民网/新浪 feed 已冻结，见方案 §1 勿再调研清单） */
export const CN_SRCS: readonly IntelSourceKey[] = ['weekly', 'qbitai', 'cnblogs', 'csdn', 'chinanews', 'chinanews_world', 'wallstcn']

// ===== URL 归一化 + hash（去重键）=====

/** 去重时剥掉的追踪参数（前缀匹配 utm_*；其余整名匹配） */
const TRACK_PARAM_PREFIXES = ['utm_', 'utm-']
const TRACK_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid',
  'spm', 'scm', 'share_token', 'shareToken', 'ref', 'ref_src', 'ref_url', 'referrer',
  'et_rid', 'sr_share', 'cmpid', 'affiliate', 'from', 'nsukey', 'tdsourcetag',
])

/** 追踪参数清洗后的 URL：scheme/host 小写、去 www.、去默认端口、去尾斜杠（保留 query 非追踪部分与 hash） */
export function normalizeIntelUrl(raw: string): string {
  let u: URL
  try { u = new URL(String(raw ?? '').trim()) } catch { return String(raw ?? '').trim() }
  u.protocol = u.protocol.toLowerCase()
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = ''
  const keep: Array<[string, string]> = []
  for (const [k, v] of u.searchParams.entries()) {
    const lk = k.toLowerCase()
    if (TRACK_PARAM_PREFIXES.some((p) => lk.startsWith(p)) || TRACK_PARAMS.has(lk)) continue
    keep.push([k, v])
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const qs = keep.length ? '?' + keep.map(([k, v]) => `${k}=${v}`).join('&') : ''
  const path = u.pathname.replace(/\/+$/, '') || '/'
  return `${u.protocol}//${u.host}${path}${qs}`
}

// —— 内联 sha256（FIPS 180-4；输入走 UTF-8）——
const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLen = bytes.length * 8
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, bitLen >>> 0, false)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  let out = ''
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0')
  return out
}

/** 去重键：归一化 URL 的 sha256 前 40 位 */
export function intelHash(url: string): string {
  return sha256Hex(normalizeIntelUrl(url)).slice(0, 40)
}

/** 条目稳定 id = hash 前 12 位 */
export function intelIdOf(url: string): string {
  return intelHash(url).slice(0, 12)
}

/** 文本内容 hash（翻译缓存键用）：与 intelHash 同实现，但不做 URL 归一化 */
export function intelTextHash(text: string): string {
  return sha256Hex(String(text ?? '')).slice(0, 40)
}

// ===== 卡片英文自动翻译（docs/intel-translate-plan.md §3）=====

/** 英文判定：拉丁字母 ≥6 且 CJK 占比 <25% —— 中文源（qbitai / 新闻源）自动跳过，零 token */
export function isEnglishText(s: string): boolean {
  const t = String(s ?? '').trim()
  if (t.length < 2) return false
  const cjk = (t.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length
  const latin = (t.match(/[A-Za-z]/g) ?? []).length
  return latin >= 6 && cjk / Math.max(cjk + latin, 1) < 0.25
}

/** 批量翻译响应解析：剥 code fence、截首个 [ 到末个 ]；等长字符串数组才算过，否则 null（整批失败） */
export function parseTranslateArray(raw: string, expectCount: number): string[] | null {
  let s = String(raw ?? '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const lo = s.indexOf('[')
  const hi = s.lastIndexOf(']')
  if (lo < 0 || hi <= lo) return null
  try {
    const arr: unknown = JSON.parse(s.slice(lo, hi + 1))
    if (!Array.isArray(arr) || arr.length !== expectCount || !arr.every((x) => typeof x === 'string')) return null
    return (arr as string[]).map((x) => x.trim())
  } catch {
    return null
  }
}

// ===== 营销水文过滤（设置 intel.filter 可关）=====

const SPAM_RE = [
  /限时[优惠特惠]/, /扫码[关注登录]/, /扫一扫/, /关注公众号/, /加(?:我)?微信/, /微信号[:：\s]/,
  /副业/, /月入[过破上万\d]/, /躺赚/, /睡后收入/, /免费领取/, /0元(?:领|学|购)/, /零基础(?:月|躺)/,
  /点击链接领取/, /优惠券/, /独家中奖/, /内部渠道(?:名额|优惠)/, /涨粉(?:秘籍|攻略)/, /带货/,
  /割韭菜/, /白嫖(?:党|攻略)/, /速来(?:报名|抢)/, /最后[几3\d]天/, /错过再等一年/,
] as const

/** 营销水文判定：标题 / 摘要命中任一强营销特征词即拦（宁缺毋滥；正则刻意保守防误伤技术文） */
export function intelSpam(title: string, summary: string): boolean {
  const s = `${title}\n${summary}`
  return SPAM_RE.some((re) => re.test(s))
}

// ===== 质量分（0~100，保留 1 位小数）=====

/** 热度对数缩放的分母锚（各 kind 一个量级锚点：repo star 万级 / news 赞千级 / paper 引用百级） */
const HEAT_CAP: Record<IntelKind, number> = { repo: 5000, news: 500, paper: 150, weekly: 1, blog: 1 }

const SIGNAL_WORDS = [
  '开源', '模型', '论文', '算法', '框架', '数据库', '编译器', '性能', '架构', '推理', '训练',
  'rag', 'llm', 'agent', 'transformer', 'embedding', 'benchmark', 'local-first', '本地优先',
  'api', 'sdk', 'cli', 'kernel', 'protocol', '部署', '微调', '量化', '上下文', '检索',
] as const

/** 质量分：源权重(≤30) + 热度 log 缩放(≤35) + 技术信号词(≤15) + 摘要完整度(≤10) + 新鲜度(≤10)。
 *  v2 D14：非科技版面不套技术信号词表（时政/财经/国际无 star/点赞，热度项天然 0；靠源权重+新鲜度+完整度区分）。 */
export function intelScore(item: Pick<IntelItem, 'source' | 'kind' | 'title' | 'summary' | 'stars' | 'publishedAt' | 'fetchedAt'> & { section?: IntelSection }): number {
  const section = item.section ?? sectionOf(item.source)
  let s = sourceWeightOf(item.source) / 28 * 30
  const heat = Math.max(0, Number(item.stars) || 0)
  if (heat > 0) s += Math.min(1, Math.log1p(heat) / Math.log1p(HEAT_CAP[item.kind] || 1)) * 35
  const text = `${item.title}\n${item.summary}`.toLowerCase()
  if (section === 'tech') {
    const hits = SIGNAL_WORDS.filter((w) => text.includes(w)).length
    if (hits > 0) s += Math.min(15, hits * 4)
  }
  const len = (item.summary ?? '').trim().length
  s += len >= 200 ? 10 : len >= 120 ? 8 : len >= 60 ? 6 : len >= 20 ? 4 : len > 0 ? 2 : 0
  const t = Date.parse(item.publishedAt || item.fetchedAt || '')
  if (Number.isFinite(t)) {
    const h = (Date.now() - t) / 3600000
    s += h <= 6 ? 10 : h <= 24 ? 9 : h <= 72 ? 8 : h <= 168 ? 6 : h <= 336 ? 4 : 2
  }
  return Math.round(Math.min(100, s) * 10) / 10
}

// ===== 过滤（feed 与 AI 工具共用一套）=====

export interface IntelFilter {
  /** 源 key（单源；v2 起可为 custom:<id>） */
  source?: string
  /** 版面（v2：侧栏组头筛选与 AI query 的 section 参数） */
  section?: IntelSection
  /** 类型：具体 kind，或 'paper'（= PAPER_SRCS）/ 'chinese'（= CN_SRCS）组合筛选 */
  kind?: IntelKind | 'paper' | 'chinese' | ''
  /** 关键词：标题 + 摘要包含（不分大小写） */
  kw?: string
  /** id 集合（命中其一即保留） */
  ids?: string[]
}

export function filterIntelItems(items: IntelItem[], f: IntelFilter): IntelItem[] {
  const idSet = f.ids && f.ids.length ? new Set(f.ids) : null
  const kw = (f.kw ?? '').trim().toLowerCase()
  const kind = f.kind ?? ''
  return items.filter((it) => {
    if (f.source && it.source !== f.source) return false
    if (f.section && (it.section ?? sectionOf(it.source)) !== f.section) return false
    if (kind === 'paper') { if (!(PAPER_SRCS as readonly string[]).includes(it.source)) return false }
    else if (kind === 'chinese') { if (!(CN_SRCS as readonly string[]).includes(it.source)) return false }
    else if (kind && it.kind !== kind) return false
    if (idSet && !idSet.has(it.id)) return false
    if (kw && !`${it.title}\n${it.summary}`.toLowerCase().includes(kw)) return false
    return true
  })
}

// ===== 池运算（merge / prune / 截断）—— 纯函数三方共用，主进程 intelStore 只做落盘 =====

/** 池排序口径：score 降序，同分按发布时间新者在前 */
export function sortIntelItems(items: IntelItem[]): IntelItem[] {
  return items.slice().sort((a, b) => b.score - a.score || (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0))
}

/**
 * 合并一轮原始条目进池：按 hash 去重；已存在条目**只更新热度类字段**
 * （stars / publishedAt，score 随之重算），fav / favAt / 摘要等用户可见内容原样保留。
 * 返回新池（score 降序）与新增条数。
 */
export function mergeIntelPool(pool: IntelItem[], raw: IntelItem[]): { pool: IntelItem[]; added: number } {
  // v2 迁移：老池条目没有 section（v1 全是科技源）——合并时按源补齐，磁盘随下一轮刷新自然收敛
  const byHash = new Map(pool.map((it) => [it.hash, it.section ? it : { ...it, section: sectionOf(it.source) }]))
  let added = 0
  for (const item of raw) {
    if (!item.hash || !item.id) continue
    const prev = byHash.get(item.hash)
    if (prev) {
      const next: IntelItem = {
        ...prev,
        stars: item.stars ?? prev.stars,
        publishedAt: item.publishedAt || prev.publishedAt,
      }
      next.score = intelScore(next)
      byHash.set(item.hash, next)
    } else {
      byHash.set(item.hash, item.section ? item : { ...item, section: sectionOf(item.source) })
      added++
    }
  }
  return { pool: sortIntelItems([...byHash.values()]), added }
}

/** 按 fetchedAt 清理过期条目（fav 豁免）——「永不被 prune 清除」由这条豁免保证 */
export function pruneIntelPool(pool: IntelItem[], keepDays: number, now = Date.now()): IntelItem[] {
  const cutoff = now - Math.max(1, keepDays) * 86400000
  return pool.filter((it) => it.fav || !(it.fetchedAt && Date.parse(it.fetchedAt) < cutoff))
}

/** 体量截断：fav 恒保留，其余按 score 取前 max 条 */
export function capIntelPool(pool: IntelItem[], max = 2000): IntelItem[] {
  if (pool.length <= max) return pool
  const favs = pool.filter((it) => it.fav)
  const rest = pool.filter((it) => !it.fav).sort((a, b) => b.score - a.score).slice(0, Math.max(0, max - favs.length))
  return [...favs, ...rest]
}
