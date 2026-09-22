import { BOOKS_DIR, safeBookFileName } from '../../../electron/lib/kbStore/bookMarketSchema'
import type { BookMarketItem, BookSourceConnectivity, BookSourceInfo } from '../../types'

/**
 * 书市模块内的小工具（纯函数，无 React）。
 *
 * ★ 为什么单独一个文件：条目身份 / 体积格式化 / 三态文案在「发现页 · 详情抽屉 · 下载面板」
 *   三处都要用 —— 抄三份就是 drift 家族（同一件事三种写法，改一处忘两处）。
 */

/**
 * 条目身份键：**源 + 下载地址**。
 * 同一本书在 Gutenberg 与 Standard Ebooks 是两个条目、同一本书的 epub 与 txt 也是两个条目，
 * 所以书名不能当键；下载地址才是唯一定位（主进程侧下载器也以 url 为准）。
 */
export function itemKey(it: BookMarketItem): string {
  return `${it.sourceId}|${it.downloadUrl}`
}

/**
 * 这本书若下载会落到的仓库内相对路径（`.books/作者 - 书名.ext`）。
 * ★ 用的是**下载器同一个命名函数** `safeBookFileName`（schema 的纯函数叶子），不另写一份规则：
 *   两份命名规则哪怕只差一个空格，表象就是「明明下好了，卡片还是显示未上架」。
 *   详情页的「保存为」与「已上架」判定都读它。
 */
export function bookRelPathFor(it: BookMarketItem): string {
  return `${BOOKS_DIR}/${safeBookFileName(it.author, it.title, it.ext)}`
}

/** 体积文案（`null` / 0 = 源没给 ⇒ 显示「未知体积」而不是「0 B」） */
export function fmtBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** 扩展名角标文案（'' → 认不出格式，用「?」占位而不是空白芯片） */
export function extLabel(ext: string): string {
  return ext ? ext.replace(/^\./, '').toUpperCase() : '?'
}

/** 连通性三态 → 圆点色 + 文案（书源行右侧那两列） */
export const CONN_META: Record<BookSourceConnectivity | 'off' | 'unknown', { dot: string; label: string }> = {
  ok: { dot: 'var(--success)', label: '已连通' },
  'need-credential': { dot: 'var(--warning)', label: '需要凭据' },
  fail: { dot: 'var(--danger)', label: '连接失败' },
  off: { dot: 'var(--text-disabled)', label: '已停用' },
  unknown: { dot: 'var(--text-disabled)', label: '未测试' },
}

export function connOf(s: BookSourceInfo, conn: Record<string, BookSourceConnectivity>): BookSourceConnectivity | 'off' | 'unknown' {
  if (!s.enabled) return 'off'
  return conn[s.id] ?? 'unknown'
}

/** 源名兜底：删源后旧检索结果里的 `sourceName` 仍在（条目自带），这里只兜「为空的极端情况」 */
export function sourceLabel(it: BookMarketItem): string {
  return it.sourceName || it.sourceId || '未知来源'
}

/** 首启提示条的 localStorage 记忆键（help-disclosure C 形态；try/catch 兜隐私模式） */
export const HINT_KEY = 'kb.bookMarket.hintDismissed'

export function readHintDismissed(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return false
  }
}

export function writeHintDismissed(): void {
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch {
    /* 隐私模式下写不了，下次再显示一遍即可，不影响功能 */
  }
}
