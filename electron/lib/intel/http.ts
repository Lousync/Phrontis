/**
 * 情报抓取公共 HTTP helper（docs/intel-module-plan.md §4.1）。
 * 用 Electron 的 net.fetch（Chromium 网络栈）：**吃系统代理 + Windows 证书库**——
 * Node 全局 fetch 两者都不认，用户开加速器（本地 TLS 拦截 / 系统代理）时外源会
 * 静默证书失败（2026-10-25 实测：GitHub 源恒空即此因）。先例：llmService / pluginRegistry。
 * 仅请求方案 §1 清单里的固定域名（无 SSRF 面）；单源失败由调用方兜住，绝不炸整轮。
 */
import { net } from 'electron'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_HTML_BYTES = 2 * 1024 * 1024

export const DEFAULT_TIMEOUT_MS = 12000
/** arXiv 响应慢（方案 §12 风险表） */
export const ARXIV_TIMEOUT_MS = 20000

async function request(url: string, timeoutMs: number, accept: string, retries: number): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await net.fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': accept,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: ctrl.signal,
        redirect: 'follow',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (err) {
      lastErr = err
      // 只重试网络/5xx 类抖动；4xx（限流 429、参数错）重试无意义
      const msg = String((err as Error)?.message ?? err)
      if (/HTTP 4\d\d/.test(msg)) break
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** GET JSON（超时 + 体积护栏；retries 默认 0） */
export async function fetchJson<T = unknown>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, headers?: Record<string, string>, retries = 0): Promise<T> {
  const res = await request(url, timeoutMs, 'application/json', retries)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_JSON_BYTES) throw new Error('响应过大')
  return JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(buf)) as T
}

/** GET 文本（HTML / Atom / RSS；超时 + 体积护栏；retries 默认 0） */
export async function fetchText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0): Promise<string> {
  const res = await request(url, timeoutMs, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', retries)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_HTML_BYTES) throw new Error('响应过大')
  return new TextDecoder('utf-8', { fatal: false }).decode(buf)
}

/** 文本转义反转（RSS / Atom 摘要里常见实体） */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x2F;|&#47;/g, '/')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n: string) => { try { return String.fromCodePoint(Number(n)) } catch { return '' } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => { try { return String.fromCodePoint(parseInt(n, 16)) } catch { return '' } })
}

/** 去标签 + 压空白（RSS description 摘要用） */
export function stripHtml(s: string): string {
  return decodeEntities(String(s ?? ''))
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
