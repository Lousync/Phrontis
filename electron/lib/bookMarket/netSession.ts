import { net, session, type ClientRequest, type IncomingMessage, type Session } from 'electron'

/**
 * 书市网络基建（方案 §三 / 拍板 ②）—— 专用 partition session + 代理 + `net.request` 原语。
 *
 * ★★ 这个文件存在的唯一理由：`net.fetch` 无法指定 per-request 代理（`electron.d.ts`），
 *    代理只能作用于 session；而把代理设在 **defaultSession** 上会连带改道 LLM 对话、
 *    模型探测、自动更新、网页剪藏 —— 用户配代理的动机通常只是「书源要能连」。
 *    故书市自建一个**非持久 partition**，只影响书市。**永远不要碰 defaultSession 的代理。**
 *
 * ★ 由 S0 探针实测锁定的两条（`probe-s0-session.cjs`，结论写在方案 §三）：
 *   ① **走代理的请求必须用 `net.request({session})`，不得用 `net.fetch`** ——
 *      net.fetch 的 `session` 参数对**代理**无效，它读的是 defaultSession 的代理。
 *      （实测：死代理设在 defaultSession 上时，带 `{session: 书市分区}` 的 fetch 照样
 *        `ERR_PROXY_CONNECTION_FAILED`，而同一时刻该分区自己是直连。）
 *   ② 附带好处：`net.request` 的响应 `IncomingMessage` **本身就是 Readable**
 *      ⇒ 不需要 `updateService` 里的 `Readable.fromWeb`（S3 的下载器直接吃它）。
 *
 * ★ 超时一律用 `request.abort()` + 定时器，不用 `AbortSignal.timeout` ——
 *   `ClientRequest.abort()` 是 net 模块自己的中止路径，探针验过；`AbortSignal` 在
 *   `net.request` 上的支持面比 fetch 窄。
 */

/** 非持久分区（无 `persist:` 前缀 ⇒ 内存态、不落盘、退出即清） */
export const BOOK_MARKET_PARTITION = 'bookmarket'

/** 可识别 UA（方案 §三「礼貌抓取」）：别用浏览器的，免得被当成爬虫伪装 */
export const BOOK_MARKET_UA = 'Knowbase-BookMarket/3.4 (+https://local.phrontis)'

/** 代理绕行：本机地址不走代理（自建书源多半就在局域网里） */
export const BOOK_MARKET_PROXY_BYPASS = '<local>'

/** 元数据类请求的超时（下载另有一套：S3 按空闲字节判，不共用这个） */
export const BOOK_REQUEST_TIMEOUT_MS = 20_000

let cached: Session | null = null

/** 书市分区 session。惰性创建（非持久，重复调用返回同一实例 —— S0 探针验过）。 */
export function getBookMarketSession(): Session {
  if (!cached) cached = session.fromPartition(BOOK_MARKET_PARTITION)
  return cached
}

/**
 * 应用代理设置。`proxyRules` 为空 ⇒ 显式**直连**（不是「不改动」——
 * 用户清空代理框时必须真的回到直连，否则旧代理会一直生效）。
 *
 * ★ 代理规则格式即 Chromium 的 `--proxy-server` 语法（`http://127.0.0.1:7890`、
 *   `socks5://…` 等）；**不做自动配置、不做按站点绕行**（§八 明确不做）。
 */
export async function applyBookMarketProxy(proxyRules: string): Promise<{ ok: boolean; error?: string }> {
  const rules = String(proxyRules ?? '').trim()
  try {
    await getBookMarketSession().setProxy(
      rules
        ? { proxyRules: rules, proxyBypassRules: BOOK_MARKET_PROXY_BYPASS }
        : { mode: 'direct' },
    )
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * 启动时把已存设置灌进 session。
 * `getSettingValue` 由 `main/index.ts` 注入（与 llmService / updateService 同套路，避免循环依赖）。
 */
export async function initBookMarketProxy(getSettingValue: (key: string) => unknown): Promise<void> {
  const v = getSettingValue('bookMarketProxy')
  await applyBookMarketProxy(typeof v === 'string' ? v : '')
}

export interface BookRequestOptions {
  method?: string
  headers?: Record<string, string>
  /** 覆盖超时（流式下载路径不共用它 —— S3 的下载器按空闲字节判卡死） */
  timeoutMs?: number
}

/**
 * **所有书市请求的唯一入口**：走书市分区的 `net.request`。
 *
 * 返回**未消费的** `ClientRequest`（调用方自己挂 `response` / `error` / `abort`）——
 * 文本路径（`bookRequestText`）与流式路径（S3 的下载器）共用它，免得两处各写一套
 * 代理/UA/超时逻辑（那正是「换个请求忘了带 session ⇒ 静默走了 defaultSession 代理」的温床）。
 */
export function openBookRequest(url: string, opts: BookRequestOptions = {}): ClientRequest {
  const headers: Record<string, string> = {
    'User-Agent': BOOK_MARKET_UA,
    Accept: '*/*',
    ...(opts.headers ?? {}),
  }
  return net.request({
    method: opts.method ?? 'GET',
    url,
    session: getBookMarketSession(),
    redirect: 'follow',
    headers,
  })
}

export interface BookResponse {
  status: number
  /** net 的头值可能是数组（同名头多次出现）——取值一律走 `headerOf` */
  headers: Record<string, string | string[]>
  body: string
  /** 发起时的地址（`net.request` 的 `redirect: 'follow'` 不透出最终 URL） */
  url: string
}

export class BookRequestError extends Error {
  constructor(
    message: string,
    /** `timeout` 与 `network` 分开：三态文案与重试策略要看它 */
    readonly kind: 'timeout' | 'network',
  ) {
    super(message)
    this.name = 'BookRequestError'
  }
}

/** 单值取头（net 的 headers 值可能是 string[]） */
function headerOf(headers: Record<string, string | string[]>, name: string): string {
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue
    return Array.isArray(v) ? (v[0] ?? '') : String(v ?? '')
  }
  return ''
}

/** 响应体上限：feed 是元数据，正常几十 KB。这个上限防的是「源其实返回了一个大文件把内存吃爆」 */
export const MAX_FEED_BYTES = 4 * 1024 * 1024

/**
 * 取文本响应（OPDS feed / JSON 接口）。
 *
 * ★ 错误信息**只拼 hostname + 状态码** —— 绝不把 URL 全量或请求头（里面可能有
 *   `Authorization`）带进 Error。凭据不进日志/错误信息是硬规则。
 */
export function bookRequestText(url: string, opts: BookRequestOptions = {}): Promise<BookResponse> {
  const timeoutMs = opts.timeoutMs ?? BOOK_REQUEST_TIMEOUT_MS
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return Promise.reject(new BookRequestError('检索地址无法解析', 'network'))
  }
  return new Promise<BookResponse>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }
    let req: ClientRequest
    try {
      req = openBookRequest(url, opts)
    } catch {
      done(() => reject(new BookRequestError(`${host} 请求无法发起`, 'network')))
      return
    }
    timer = setTimeout(() => {
      done(() => {
        try { req.abort() } catch { /* 已经结束了 */ }
        reject(new BookRequestError(`${host} 请求超时`, 'timeout'))
      })
    }, timeoutMs)
    timer.unref?.()

    req.on('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_FEED_BYTES) {
          done(() => {
            try { req.abort() } catch { /* 已结束 */ }
            reject(new BookRequestError(`${host} 响应体过大（超过 ${Math.floor(MAX_FEED_BYTES / 1024 / 1024)}MB）`, 'network'))
          })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        done(() =>
          resolve({
            status,
            headers: (res.headers ?? {}) as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString('utf-8'),
            url,
          }),
        )
      })
      res.on('error', () => done(() => reject(new BookRequestError(`${host} 响应读取中断`, 'network'))))
    })
    req.on('error', (e: Error) => {
      // Electron 的错误串里可能带 URL；只取「有没有超时」这个语义，原文不外抛
      const msg = String(e?.message ?? '')
      const kind: 'timeout' | 'network' = /timed? ?out|ETIMEDOUT/i.test(msg) ? 'timeout' : 'network'
      done(() => reject(new BookRequestError(`${host} ${kind === 'timeout' ? '请求超时' : '连接失败'}`, kind)))
    })
    req.end()
  })
}

/** 取响应头里的 content-type（去参数、小写） */
export function responseContentType(res: BookResponse): string {
  return headerOf(res.headers, 'content-type').split(';')[0].trim().toLowerCase()
}

/** 取 content-length（认不出返回 null） */
export function responseContentLength(res: BookResponse): number | null {
  const raw = headerOf(res.headers, 'content-length')
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}
