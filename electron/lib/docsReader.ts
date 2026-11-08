/**
 * 文档文本提取服务（界面阅读 + builtin.vault.read 文档分派共用；docs/agent-file-tools-design.md §13）
 * - .pdf → pdfjs-dist legacy（Node 主进程 + workerSrc 本机 worker，2026-09-03 实测可行）
 * - .pptx → 复用 zip.ts 解压 + 手读 ppt/slides/slide*.xml 的 <a:t>（零新依赖）
 * - 仅纯文本提取（供 LLM 通读），不做渲染/OCR；扫描件（图片型 PDF）提取为空属预期
 */

import { readFileSync, statSync } from 'fs'
import { extname } from 'path'
import { unzipBuffer } from './zip'
import { mapSymbolPua } from './puaMap'

export interface DocTextOutput {
  kind: 'pdf' | 'pptx'
  /** 纯文本（各页间 \n 分隔；pptx 每页以空行分隔） */
  text: string
  pages: number
  totalChars: number
}

export const MAX_DOC_SIZE = 80 * 1024 * 1024 // pptx/pdf 上限 80MB（vault.read 文档分派也按此预检，§2.2 G8）
const MAX_PDF_PAGES = 200

// ===== pdfjs（Node 主进程）=====

interface PdfPageLike {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>
}
interface PdfDocLike {
  numPages: number
  getPage: (n: number) => Promise<PdfPageLike>
  destroy?: () => Promise<void>
}

let pdfjsPromise: Promise<{
  GlobalWorkerOptions: { workerSrc: string }
  getDocument: (p: { data: Uint8Array }) => { promise: Promise<PdfDocLike> }
}> | null = null

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfjs = require('pdfjs-dist/legacy/build/pdf.js') as {
        GlobalWorkerOptions: { workerSrc: string }
        getDocument: (p: { data: Uint8Array }) => { promise: Promise<PdfDocLike> }
      }
      try {
        // Node 无 DOM Worker → 指向本机 worker 文件（v3.11 isNodeJS 分支支持，2026-09-03 实测可行）
        pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js')
      } catch { /* workerSrc 设不上时 pdfjs 会走 fake worker 失败路径，由调用方兜错 */ }
      return pdfjs
    })()
  }
  return pdfjsPromise
}

async function extractPdfPages(absPath: string, from = 1, to?: number): Promise<{ pageTexts: string[]; total: number }> {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(readFileSync(absPath))
  const doc = await pdfjs.getDocument({ data }).promise
  const total = doc.numPages
  const start = Math.max(1, from)
  const end = Math.min(to ?? total, total, start + MAX_PDF_PAGES - 1) // 单次提取仍受页数上限保护
  const chunks: string[] = []
  for (let i = start; i <= end; i++) {
    try {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      chunks.push(tc.items.map(it => String(it?.str ?? '')).filter(Boolean).join(' '))
    } catch {
      chunks.push('') // 单页失败不中断（扫描页/异常页跳过）
    }
  }
  try { await doc.destroy?.() } catch { /* ignore */ }
  return { pageTexts: chunks, total }
}

/** P6 素材库：按 1-based 页码区间提取 PDF 文本（两端含）；返回逐页文本与文档总页数 */
export async function extractPdfRange(absPath: string, from: number, to: number): Promise<{ pages: { n: number; text: string }[]; total: number }> {
  const r = await extractPdfPages(absPath, from, to)
  const start = Math.max(1, from)
  return { pages: r.pageTexts.map((text, i) => ({ n: start + i, text })), total: r.total }
}

/**
 * 全本提取：循环切 200 页一块直到最后一页（长资料方案 §5.3）。
 * MAX_PDF_PAGES 只约束**单次**调用；整本不再被静默截断在前 200 页。
 * 每块重新打开文档（200 页一块重新 parse 的开销可接受，600 页 ≈ 3 次）。
 */
export async function extractPdfWhole(absPath: string): Promise<{ pages: { n: number; text: string }[]; total: number }> {
  const first = await extractPdfRange(absPath, 1, Number.MAX_SAFE_INTEGER)
  const pages = [...first.pages]
  const total = first.total
  for (let start = MAX_PDF_PAGES + 1; start <= total; start += MAX_PDF_PAGES) {
    const r = await extractPdfRange(absPath, start, Math.min(start + MAX_PDF_PAGES - 1, total))
    pages.push(...r.pages)
  }
  return { pages, total }
}

/** 按页码区间的分块提取（长资料方案 §5.6）：章区间可超 200 页，自动循环补齐，不把单次上限当区间末尾。 */
export async function extractPdfRangeChunked(absPath: string, from: number, to: number): Promise<{ pages: { n: number; text: string }[]; total: number }> {
  const start = Math.max(1, Math.floor(from))
  const probe = await extractPdfRange(absPath, start, start) // 顺便拿总页数
  const total = probe.total
  const end = Math.min(Math.floor(to), total)
  const pages = [...probe.pages]
  for (let s = start + 1; s <= end; s += MAX_PDF_PAGES) {
    const r = await extractPdfRange(absPath, s, Math.min(s + MAX_PDF_PAGES - 1, end))
    pages.push(...r.pages)
  }
  return { pages, total }
}

// ===== pptx（zip + XML）=====

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
}

function slideNumOf(name: string): number {
  const m = name.match(/slide(\d+)\.xml/i)
  return m ? parseInt(m[1], 10) : 0
}

function extractPptxRaw(absPath: string): { n: number; text: string }[] {
  const map = unzipBuffer(readFileSync(absPath))
  const slideNames = [...map.keys()]
    .filter(k => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
    .sort((a, b) => slideNumOf(a) - slideNumOf(b))
  return slideNames.map(name => {
    const xml = map.get(name)!.toString('utf-8')
    const parts: string[] = []
    // (?=\s|>) 词边界：原 <a:t[^>]*> 会误配 <a:tbl>（表格），把整段表格 XML 当文本吞进正文（slide5/9 实证泄漏）
    for (const m of xml.matchAll(/<a:t(?=[ >])[^>]*>([\s\S]*?)<\/a:t>/g)) parts.push(mapSymbolPua(decodeXml(m[1])))
    return { n: slideNumOf(name), text: parts.join(' ') }
  })
}

function extractPptx(absPath: string): { text: string; pages: number } {
  const pages = extractPptxRaw(absPath)
  return { text: pages.map(p => p.text).join('\n'), pages: pages.length }
}

/** 按页返回 PPT 文本（界面逐页阅读用；页号取文件内 slideN 编号） */
export function extractPptxPages(absPath: string): { n: number; text: string }[] {
  return extractPptxRaw(absPath)
}

// ===== 入口 =====

/** 按扩展名提取文档文本；不支持的类型明确拒绝（.md/.txt 走 vault.read） */
export async function extractDocText(absPath: string): Promise<DocTextOutput> {
  const st = statSync(absPath)
  if (!st.isFile()) throw new Error('不是文件')
  if (st.size > MAX_DOC_SIZE) throw new Error(`文件过大（${st.size} 字节 > 80MB）`)
  const ext = extname(absPath).slice(1).toLowerCase()
  if (ext === 'pdf') {
    const r = await extractPdfPages(absPath)
    return { kind: 'pdf', text: r.pageTexts.join('\n'), pages: r.total, totalChars: r.pageTexts.join('\n').length }
  }
  if (ext === 'pptx') {
    const r = extractPptx(absPath)
    return { kind: 'pptx', text: r.text, pages: r.pages, totalChars: r.text.length }
  }
  throw new Error('仅支持 .pdf / .pptx 文本提取（.md/.txt 请用 vault.read；Word/扫描件暂不支持）')
}
