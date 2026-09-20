import { PdfCover } from './PdfCover'
import type { BookKind } from '../../types'

/**
 * 封面分发（书架升级全格式阅读器一期，方案 §S4）：
 * pdf → 现有 PdfCover（懒渲染 + 封面缓存）；txt → 纯色书卡——
 * 色相由 relPath 字符和 % 8 取色板，书卡内排书名；不引入新依赖、不读文件内容。
 * props 与 PdfCover 对齐（txt 分支忽略 mtime/cacheHit/onReady）。
 */

/** 纯色书卡色板：8 组柔和底色（浅色底 + 深字，随主题变量无冲突——用固定低饱和色） */
const TXT_PALETTE = [
  { bg: '#dbeafe', fg: '#1e40af' },
  { bg: '#dcfce7', fg: '#166534' },
  { bg: '#fef3c7', fg: '#92400e' },
  { bg: '#fce7f3', fg: '#9d174d' },
  { bg: '#ede9fe', fg: '#5b21b6' },
  { bg: '#ccfbf1', fg: '#115e59' },
  { bg: '#ffe4e6', fg: '#9f1239' },
  { bg: '#e0e7ff', fg: '#3730a3' },
]

function txtPaletteOf(relPath: string): { bg: string; fg: string } {
  let sum = 0
  for (let i = 0; i < relPath.length; i++) sum += relPath.charCodeAt(i)
  return TXT_PALETTE[sum % TXT_PALETTE.length]
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
    return <PdfCover rootId={rootId} relPath={relPath} name={name} mtime={mtime} cacheHit={cacheHit} onReady={onReady} />
  }
  const { bg, fg } = txtPaletteOf(relPath)
  return (
    <div
      className="flex aspect-[3/4] w-full select-none flex-col justify-between overflow-hidden rounded-[6px] p-2.5"
      style={{ background: bg, color: fg }}
    >
      {/* 竖排书脊线 + 顶部装饰，制造「书」的意象（纯 CSS，无图片） */}
      <div className="flex items-start justify-between">
        <span className="text-[9px] tracking-[0.2em] opacity-70">TXT</span>
        <span className="h-6 w-0.5 rounded-full opacity-40" style={{ background: fg }} />
      </div>
      <div className="line-clamp-4 break-all text-center text-[12px] font-medium leading-snug" style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {name}
      </div>
    </div>
  )
}
