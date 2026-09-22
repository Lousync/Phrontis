import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import { bookMarketCoverGet } from '../../lib/ipc'
import type { BookKind } from '../../types'

/**
 * 封面分发（书架升级全格式阅读器一期，方案 §S4；B 段扩 epub；S4 段加书市封面）：
 * 书市封面（有 coverRef）→ 真图；否则 pdf → PdfCover（懒渲染 + 封面缓存）、
 * txt / epub → 纯色书卡——色相由 relPath 字符和 % 8 取色板，书卡内排书名 + 右上角格式角标；
 * 不引入新依赖、不读文件内容。props 与 PdfCover 对齐（非 pdf 分支忽略 mtime/cacheHit/onReady）。
 *
 * ★★ 铁律 20：`PdfCover` **只能动态 import**。它静态拖着 pdfjs-dist，而本组件被
 * `modules/bookshelf/index.tsx` 静态引用、又被 `App.tsx` 静态引用 —— 一旦这里写静态 import，
 * pdfjs 就整块进首屏静态闭包（实测入口 chunk 内含 pdfjs-*.js 的 modulepreload，1.15 MB；
 * `manualChunks` 只切了文件、切不断静态引用边）。契约脚本 verify-epub-formats.mjs 有负向断言锁。
 * 同理 `bookMarketCoverGet` 走的是 ipc.ts（纯 invoke 封装，无新依赖），不构成静态闭包增量。
 */
const PdfCover = lazy(() => import('./PdfCover').then((m) => ({ default: m.PdfCover })))

/** 纯色书卡色板：8 组柔和底色（浅色底 + 深字，随主题变量无冲突——用固定低饱和色） */
const CARD_PALETTE = [
  { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#dcfce7', fg: '#166534' },
  { bg: '#fef3c7', fg: '#92400e' },
  { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#ede9fe', fg: '#5b21b6' },
  { bg: '#ccfbf1', fg: '#115e59' },
  { bg: '#ffe4e6', fg: '#9f1239' },
  { bg: '#e0e7ff', fg: '#3730a3' },
]

function cardPaletteOf(relPath: string): { bg: string; fg: string } {
  let sum = 0
  for (let i = 0; i < relPath.length; i++) sum += relPath.charCodeAt(i)
  return CARD_PALETTE[sum % CARD_PALETTE.length]
}

/** 纯色书卡（非 pdf 共用：txt / epub / fb2 / fbz …；角标显示格式名）——不含 pdfjs，可安全同步渲染 */
function PlainBookCard({ relPath, name, label }: { relPath: string; name: string; label: string }) {
  const { bg, fg } = cardPaletteOf(relPath)
  return (
    <div
      className="flex aspect-[3/4] w-full select-none flex-col justify-between overflow-hidden rounded-[6px] p-2.5"
      style={{ background: bg, color: fg }}
    >
      {/* 竖排书脊线 + 顶部装饰，制造「书」的意象（纯 CSS，无图片） */}
      <div className="flex items-start justify-between">
        <span className="text-[9px] tracking-[0.2em] opacity-70">{label}</span>
        <span className="h-6 w-0.5 rounded-full opacity-40" style={{ background: fg }} />
      </div>
      <div className="line-clamp-4 break-all text-center text-[12px] font-medium leading-snug" style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {name}
      </div>
    </div>
  )
}

/**
 * 书市封面内存缓存：`<rootId>|<coverRel>` → Promise<dataUrl|null>。
 *
 * ★ 缓存的是 **Promise**（不是结果）有两个好处：① 同一本书在「续读条 + 网格」各渲染一次时
 *   只发一次 IPC（网格本就有双份渲染，实测每本书两次）；② 失败结果也一起缓存下来，
 *   不会因为某本书封面缺失而在每次重渲染/滚动往返时反复打 IPC（封面是增益，拿不到就回落）。
 * ★ 键带 rootId：coverRel 是**仓库内**相对路径，换仓库后同名引用会串（虽然一次只开一个仓库，
 *   但切仓库那一刻旧值还在缓存里）。封面文件名是内容 hash ⇒ 同键必然同图，没有失效问题。
 */
const marketCoverCache = new Map<string, Promise<string | null>>()

function loadMarketCover(rootId: string, coverRef: string): Promise<string | null> {
  const key = `${rootId}|${coverRef}`
  const hit = marketCoverCache.get(key)
  if (hit) return hit
  const p = bookMarketCoverGet(rootId, coverRef)
    .then((r) => (r.ok && r.dataUrl ? r.dataUrl : null))
    .catch(() => null)
  marketCoverCache.set(key, p)
  return p
}

/** 书市封面（`.books/.covers/<hash>.jpg`，经只读通道 `bookMarket:coverGet` 取字节）。
 *  取不到 / 通道报错 → 原样渲染 `fallback`（纯色书卡或 PdfCover），绝不整卡空白。 */
function MarketCover({ rootId, coverRef, fallback }: { rootId: string; coverRef: string; fallback: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void loadMarketCover(rootId, coverRef).then((u) => { if (alive && u) setUrl(u) })
    return () => { alive = false }
  }, [rootId, coverRef])
  if (!url) return <>{fallback}</>
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      className="aspect-[3/4] w-full rounded-[6px] object-cover select-none"
    />
  )
}

export function BookCover({ kind, rootId, relPath, name, coverRef, mtime, cacheHit, onReady }: {
  kind: BookKind
  rootId: string
  relPath: string
  /** 展示名（书卡内排字用）——上游拼好的 `BookListItem.displayName`，这里不再推导 */
  name: string
  /** 书市封面相对引用（`BookListItem.coverRef`；空串 = 这本书没有书市封面，走原有分支） */
  coverRef?: string
  mtime: number
  cacheHit: boolean
  onReady?: (dataUrl: string) => void
}) {
  const plain = <PlainBookCard relPath={relPath} name={name} label={kind.toUpperCase()} />
  // 原有分支一字未改：pdf 走懒渲染 + 封面缓存，其余走纯色书卡
  // （非 pdf：txt / epub / fb2 / fbz，以及将来任何新格式 —— 角标由 kind 派生，无需改这里）
  const body: ReactNode = kind === 'pdf'
    // 懒加载期间用同尺寸纯色卡占位（避免网格跳动；PdfCover 就绪后原地替换）
    ? <Suspense fallback={<PlainBookCard relPath={relPath} name={name} label="PDF" />}>
        <PdfCover rootId={rootId} relPath={relPath} name={name} mtime={mtime} cacheHit={cacheHit} onReady={onReady} />
      </Suspense>
    : plain
  // 书市封面优先（S4 拍板 ①）。注意这条路 **不碰 pdfjs**：`coverRef` 有值时上面那个
  // Suspense/PdfCover 元素不会被渲染（React 不渲染就不触发 lazy import），
  // 所以「pdf + 有书市封面」不会白拖 1.15 MB 的 pdfjs。
  if (!coverRef) return body
  return <MarketCover rootId={rootId} coverRef={coverRef} fallback={body} />
}
