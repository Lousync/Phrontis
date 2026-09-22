import { Suspense, lazy } from 'react'
import type { BookKind } from '../../types'

/**
 * 封面分发（书架升级全格式阅读器一期，方案 §S4；B 段扩 epub）：
 * pdf → PdfCover（懒渲染 + 封面缓存）；txt / epub → 纯色书卡——
 * 色相由 relPath 字符和 % 8 取色板，书卡内排书名 + 右上角格式角标；不引入新依赖、不读文件内容。
 * props 与 PdfCover 对齐（非 pdf 分支忽略 mtime/cacheHit/onReady）。
 *
 * ★★ 铁律 20：`PdfCover` **只能动态 import**。它静态拖着 pdfjs-dist，而本组件被
 * `modules/bookshelf/index.tsx` 静态引用、又被 `App.tsx` 静态引用 —— 一旦这里写静态 import，
 * pdfjs 就整块进首屏静态闭包（实测入口 chunk 内含 pdfjs-*.js 的 modulepreload，1.15 MB；
 * `manualChunks` 只切了文件、切不断静态引用边）。契约脚本 verify-epub-formats.mjs 有负向断言锁。
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

export function BookCover({ kind, rootId, relPath, name, mtime, cacheHit, onReady }: {
  kind: BookKind
  rootId: string
  relPath: string
  /** 去扩展名的展示名（书卡内排字用） */
  name: string
  mtime: number
  cacheHit: boolean
  onReady?: (dataUrl: string) => void
}) {
  if (kind === 'pdf') {
    return (
      // 懒加载期间用同尺寸纯色卡占位（避免网格跳动；PdfCover 就绪后原地替换）
      <Suspense fallback={<PlainBookCard relPath={relPath} name={name} label="PDF" />}>
        <PdfCover rootId={rootId} relPath={relPath} name={name} mtime={mtime} cacheHit={cacheHit} onReady={onReady} />
      </Suspense>
    )
  }
  // 非 pdf（txt / epub / fb2 / fbz，以及将来任何新格式）：纯色书卡 + 格式角标（角标由 kind 派生，无需改这里）
  return <PlainBookCard relPath={relPath} name={name} label={kind.toUpperCase()} />
}
