import { bookExtFromMime, bookExtOf } from '../kbStore/bookFormats'
import { credentialSatisfies, resolveSearchUrl, type BookSource, type BookSourceCredential } from '../kbStore/bookMarketSchema'
import { bookSourceCredentialFor, bookSourceGet, bookSourceList } from '../kbStore/bookSourceVaultRepo'
import { bookRequestText, BookRequestError } from './netSession'
import {
  feedEntryToRawItem, jsonToRawItems, parseAtomFeed, pickAcquisitionFromChildFeed, toBookMarketItems,
  type BookMarketItemShape, type FeedEntry, type RawItem,
} from './opdsParse'

/**
 * 书市 · 按源检索（方案 §三 / 拍板 ②⑥⑦）。
 *
 * 职责：源描述 → 请求 → 解析 → **统一条目模型**。这一步之后渲染层拿到的就只是
 * `BookMarketItem[]`，不认识 OPDS、JSON、两级结构这些概念。
 *
 * ★★ 三条不许破的线：
 *   ① **凭据只进 `Authorization` 头** —— 不进 URL、不进日志、不进错误文案。
 *      这里的错误文案一律只拼 `hostname`（`BookRequestError` 已经这么做了）；
 *      本文件自己也**绝不做 `console.log(req)`** 这类事。
 *   ② **部分源失败不整页报错**（拍板 ⑦）：单源失败进 `failed[]`，其余源照常返回。
 *      单条**子 feed**（两级展开）失败更轻：只丢那一条，连 `failed` 都不进。
 *   ③ **可读性判定用 `bookExtOf` / `bookExtFromMime`**（格式唯一真相源在 bookFormats.ts），
 *      别在本文件写任何格式字面量 —— 加格式要改的是那张表，不是这里。
 *
 * ★ 并发**全局上限 2**（`MAX_CONCURRENCY`）：两级展开的子请求与各源请求**共用同一个池**
 *   （拍板 ⑦ 明确「并发上限按全局 2 算，不按源各 2」）。
 *
 * ★ **展开只有一层，而且是结构性的**（§八「不做整站镜像 / 批量抓取」）：`entriesToRawItems`
 *   只对「本条没 acquisition 但有 `subFeedUrl`」的 entry 取**一次**子 feed，子 feed 里拿到的
 *   entry 直接产出条目、**不再往下走**。所以这里没有 depth 参数（也别加一个改了不生效的常数）。
 */

/** 全局并发上限（拍板 ⑦）。含两级展开的子请求 —— 它们与本池共用额度。 */
export const MAX_CONCURRENCY = 2

/** 单条子 feed 的超时（比主 feed 短：它是「展开一层」，慢的直接放弃比拖着用户等强） */
export const CHILD_FEED_TIMEOUT_MS = 15_000

/** 单源单页条目上限（防护：源返回超长 feed 时别把渲染层淹掉） */
export const MAX_ITEMS_PER_SOURCE = 60

/**
 * 传输类失败的重试次数（方案 §三：「源请求必须有超时 + 重试」）。
 * ★ 实测依据：Gutenberg 本机不稳 —— HTTP2 stream 中断、45s 空回，**都是重试一次就过**。
 * ★ **凭据类失败不重试**（`need-credential`）：401 重试一万次还是 401，只会让用户多等
 *   （同 拍板 ⑬ 对下载队列的口径）。4xx 同理 —— 那是「你问错了」，不是「网络抖了」。
 */
export const SOURCE_RETRY_TIMES = 1

/** 重试前的等待。取值小：用户在看搜索结果，重试是「顺手再试一次」不是退避策略 */
export const RETRY_DELAY_MS = 300

/** 三态连通性（拍板：凭据缺失必须是「需要凭据」而不是「连接失败」） */
export type SourceConnectivity = 'ok' | 'need-credential' | 'fail'

/** `failed[]` 里的原因文案（渲染层直接显示，故是给人看的中文） */
export const REASON_NEED_CREDENTIAL = '需要凭据'
export const REASON_NOT_CONFIGURED = '未配置检索地址'
export const REASON_CONNECT_FAILED = '连接失败'
export const REASON_TIMEOUT = '连接超时'
export const REASON_BAD_RESPONSE = '响应无法解析'

export interface SourceSearchFailure {
  sourceId: string
  name: string
  reason: string
}

export interface BookMarketSearchResultDto {
  items: BookMarketItemShape[]
  failed: SourceSearchFailure[]
}

// ===== 并发池（**全局**一个：所有源与所有子请求共用 2 个额度） =====

/**
 * 极简并发闸：把任务排队，最多 `limit` 个同时在跑。
 * 不用 `Promise.all` 分批 —— 那会「一批等最慢的」，两级展开时长尾会明显拖慢。
 */
function createPool(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  const next = (): void => {
    if (active >= limit) return
    const run = queue.shift()
    if (!run) return
    active++
    run()
  }
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        // ★ `Promise.resolve().then(task)` 而不是直接 `task()`：后者若**同步抛**
        //   （非 async 任务），`active` 永不回落 ⇒ 池子卡死、后续请求全排队。
        Promise.resolve()
          .then(task)
          .then(
            (v) => { active--; next(); resolve(v) },
            (e) => { active--; next(); reject(e) },
          )
      })
      next()
    })
  }
}

// ===== 凭据注入 =====

/**
 * 构造 `Authorization` 头。**这是凭据唯一被读到的地方，也是唯一被用掉的地方。**
 * 返回 null = 没有凭据（调用方据此判「需要凭据」）。
 *
 * ★ 用 `Buffer.from(...).toString('base64')` 而不是 `btoa` —— 后者在 Node 里对非 ASCII
 *   会抛 `InvalidCharacterError`（用户名带中文/重音字符时）。这是实测踩过的坑。
 * ★ **导出**是给 S3 的下载器用的（它也要按源注入凭据）：凭据拼装必须只有一份实现 ——
 *   在 downloader 里再写一遍 base64 就是把「凭据不进日志/不进 URL」这条线的守卫复制成两份。
 */
export function authHeaderFor(cred: BookSourceCredential | null): string | null {
  if (!cred) return null
  if (cred.type === 'basic') {
    if (!cred.username || !cred.password) return null
    return `Basic ${Buffer.from(`${cred.username}:${cred.password}`, 'utf-8').toString('base64')}`
  }
  return cred.token ? `Bearer ${cred.token}` : null
}

/**
 * 判定一个源此时的连通性**前置条件**（不发请求那部分，故可以单独被 S4 的书源列表调用）。
 * 顺序即优先级：**先看凭据够不够，再看地址配没配** —— 缺凭据时不该发一个必然 401 的请求出去。
 */
export function preflightConnectivity(source: BookSource, cred: BookSourceCredential | null): SourceConnectivity {
  if (source.auth && !credentialSatisfies(source.auth.type, cred)) return 'need-credential'
  if (!resolveSearchUrl(source, { query: 'x' })) return 'fail'
  return 'ok'
}

// ===== 单源检索 =====

interface FetchOutcome {
  /** 解析出的条目（未判可读性） */
  raw: RawItem[]
  /** 三态判定结果 */
  state: SourceConnectivity
  reason?: string
}

/** 401/403 是「需要凭据」，其余非 2xx 是「连接失败」（拍板 ⑦ 的三态口径） */
function classifyStatus(status: number): SourceConnectivity {
  if (status === 401 || status === 403) return 'need-credential'
  return 'fail'
}

type FeedFailure = {
  ok: false
  state: SourceConnectivity
  reason: string
  /** **与三态正交**：值得再试一次吗。见 `fetchFeedRetry` */
  retryable: boolean
}

async function fetchFeed(url: string, headers: Record<string, string>, timeoutMs?: number): Promise<{ ok: true; body: string } | FeedFailure> {
  try {
    const res = await bookRequestText(url, { headers, timeoutMs })
    if (res.status < 200 || res.status >= 300) {
      const state = classifyStatus(res.status)
      return {
        ok: false,
        state,
        reason: state === 'need-credential' ? REASON_NEED_CREDENTIAL : `HTTP ${res.status}`,
        // 5xx 是「对面挂了」（值得重试）；4xx 是「你问错了」（重试一万次还是一样）
        retryable: res.status >= 500,
      }
    }
    return { ok: true, body: res.body }
  } catch (e) {
    const err = e as BookRequestError
    const timedOut = err?.kind === 'timeout'
    // 超时 / 连接中断都值得重试（实测 Gutenberg 的 HTTP2 中断与 45s 空回都是重试即过）
    return { ok: false, state: 'fail', reason: timedOut ? REASON_TIMEOUT : REASON_CONNECT_FAILED, retryable: true }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * `fetchFeed` + 失败重试（方案 §三「源请求必须有超时 + 重试」）。
 * ★ 只重试 `retryable` 的：超时 / 连接中断 / 5xx。
 *   **401/403 与 4xx 一律不重试** —— 401 重试一万次还是 401，只会让用户多等
 *   （同 拍板 ⑬ 对下载队列的口径：「凭据类失败不空转重试」）。
 */
async function fetchFeedRetry(url: string, headers: Record<string, string>, timeoutMs?: number) {
  let last = await fetchFeed(url, headers, timeoutMs)
  for (let i = 0; !last.ok && last.retryable && i < SOURCE_RETRY_TIMES; i++) {
    await sleep(RETRY_DELAY_MS)
    last = await fetchFeed(url, headers, timeoutMs)
  }
  return last
}

/** 把 OPDS feed 的 entry 变成 `RawItem`，**必要时并发展开一层**（拍板 ⑥） */
async function entriesToRawItems(
  entries: FeedEntry[],
  feedUrl: string,
  headers: Record<string, string>,
  run: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<RawItem[]> {
  const direct: RawItem[] = []
  const pending: FeedEntry[] = []
  for (const e of entries) {
    if (e.acquisitions.length > 0) direct.push(feedEntryToRawItem(e))
    else if (e.subFeedUrl) pending.push(e)
  }
  if (pending.length === 0) return direct

  // ★ 并发展开（同一全局池）。单条失败 ⇒ 丢这一条，**不进 failed**（那是整源失败的口径）
  const expanded = await Promise.all(
    pending.map((e) =>
      run(async () => {
        const child = await fetchFeedRetry(e.subFeedUrl, headers, CHILD_FEED_TIMEOUT_MS)
        if (!child.ok) return null
        const picked = pickAcquisitionFromChildFeed(child.body, e.subFeedUrl)
        return picked ? feedEntryToRawItem(picked) : null
      }).catch(() => null),
    ),
  )
  for (const item of expanded) if (item) direct.push(item)
  return direct
}

/** 单源检索：返回未判可读性的 `RawItem[]` + 三态 */
async function searchOneSource(
  source: BookSource,
  cred: BookSourceCredential | null,
  query: string,
  page: number,
  run: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<FetchOutcome> {
  if (source.auth && !credentialSatisfies(source.auth.type, cred)) {
    return { raw: [], state: 'need-credential', reason: REASON_NEED_CREDENTIAL }
  }
  const url = resolveSearchUrl(source, { query, page })
  if (!url) return { raw: [], state: 'fail', reason: REASON_NOT_CONFIGURED }

  // ★ 凭据只在这里落成请求头，且这个对象只传给发起请求的那一层
  const headers: Record<string, string> = { Accept: 'application/atom+xml, application/json;q=0.9, */*;q=0.5' }
  const auth = authHeaderFor(cred)
  if (auth) headers.Authorization = auth

  const res = await fetchFeedRetry(url, headers)
  if (!res.ok) return { raw: [], state: res.state, reason: res.reason }

  // 解析器**只**由源声明的 responseType 选（拍板 ⑤：它唯一职责就是这个）。
  // ★ 刻意**不按响应内容猜**（「以 `<` 开头就当 Atom」）：没有任何实测依据支持这种兜底，
  //   而它会把「源返回了一个 HTML 错误页」也引到 Atom 分支，掩盖真正的配置错误。
  try {
    if (source.responseType === 'atom') {
      const feed = parseAtomFeed(res.body, url)
      if (!feed) return { raw: [], state: 'fail', reason: REASON_BAD_RESPONSE }
      const raw = await entriesToRawItems(feed.entries, url, headers, run)
      return { raw: raw.slice(0, MAX_ITEMS_PER_SOURCE), state: 'ok' }
    }
    if (!source.mapping) return { raw: [], state: 'fail', reason: REASON_NOT_CONFIGURED }
    const doc: unknown = JSON.parse(res.body)
    const raw = jsonToRawItems(doc, source.mapping, source.url)
    return { raw: raw.slice(0, MAX_ITEMS_PER_SOURCE), state: 'ok' }
  } catch {
    return { raw: [], state: 'fail', reason: REASON_BAD_RESPONSE }
  }
}

// ===== 聚合检索（对外唯一入口） =====

export interface SearchOptions {
  /** 只查这些源；缺省 = 当前仓库里所有**启用**的源 */
  sourceIds?: string[]
  page?: number
}

/**
 * 聚合检索：所有启用源并发跑（全局 ≤2），**部分源失败只进 `failed[]`**（拍板 ⑦）。
 * 副产物是每个源的连通性（S4 的书源列表三态用它，无需再发一轮请求）。
 */
export async function searchBookSources(
  rootId: string,
  query: string,
  opts: SearchOptions = {},
): Promise<BookMarketSearchResultDto & { connectivity: Record<string, SourceConnectivity> }> {
  const wanted = opts.sourceIds && opts.sourceIds.length > 0 ? new Set(opts.sourceIds) : null
  const sources = bookSourceList(rootId).filter((s) => s.enabled && (!wanted || wanted.has(s.id)))
  const page = Number.isFinite(opts.page) && (opts.page as number) > 0 ? Math.floor(opts.page as number) : 1

  const run = createPool(MAX_CONCURRENCY)
  const results = await Promise.all(
    sources.map((s) =>
      run(async () => {
        // 凭据在主进程侧读取，**只用于构造请求头**；出这个函数的只有条目与三态
        const cred = s.auth ? bookSourceCredentialFor(rootId, s.auth.ref) : null
        const outcome = await searchOneSource(s, cred, query, page, run)
        return { source: s, outcome }
      }).catch(() => ({
        source: s,
        outcome: { raw: [], state: 'fail' as SourceConnectivity, reason: REASON_CONNECT_FAILED },
      })),
    ),
  )

  const items: BookMarketItemShape[] = []
  const failed: SourceSearchFailure[] = []
  const connectivity: Record<string, SourceConnectivity> = {}
  for (const { source, outcome } of results) {
    connectivity[source.id] = outcome.state
    if (outcome.state !== 'ok') {
      failed.push({ sourceId: source.id, name: source.name, reason: outcome.reason ?? REASON_CONNECT_FAILED })
      continue
    }
    // 可读性判定在这里（格式唯一真相源在 bookFormats.ts —— 本文件不写格式字面量）
    items.push(...toBookMarketItems(outcome.raw, {
      sourceId: source.id,
      sourceName: source.name,
      extOf: bookExtOf,
      extFromMime: bookExtFromMime,
    }))
  }
  return { items, failed, connectivity }
}

/**
 * 单源连通性探测（S4 书源列表的「三态」显示用）。
 * ★ 它**发一次真实请求**（用当前检索词或一个探测词）—— 只做前置判断会把
 *   「地址配了但服务器挂了」误报成已连通。故这里必须真打一次。
 */
export async function probeSourceConnectivity(rootId: string, sourceId: string, query = 'test'): Promise<SourceConnectivity> {
  const source = bookSourceGet(rootId, sourceId)
  if (!source) return 'fail'
  const cred = source.auth ? bookSourceCredentialFor(rootId, source.auth.ref) : null
  const pre = preflightConnectivity(source, cred)
  if (pre !== 'ok') return pre
  const run = createPool(MAX_CONCURRENCY)
  const outcome = await searchOneSource(source, cred, query, 1, run)
  return outcome.state
}
