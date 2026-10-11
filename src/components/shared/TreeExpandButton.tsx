import type { MouseEvent } from 'react'

/**
 * 左栏文件树头部「展开/收起目录子树」按钮（工作台·文件树 与 知识库·文件树 共用）。
 *
 * 图标是单个 15px SVG（与其余头部按钮同尺寸，保证对齐），内含**两条 chevron 路径各自原地翻转
 * 180°**（.kb-chevron 过渡 rotate）——不是整体旋转（那对中心对称图形等于没动）：
 * 外张（上↑ 下↓）=可展开，内收（上↓ 下↑）=可收起。
 */
export function TreeExpandButton({ expanded, onClick, title, dataWb }: {
  expanded: boolean
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
  title: string
  dataWb?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      data-wb={dataWb}
      className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m7 9 5-5 5 5" className={`kb-chevron ${expanded ? 'rotate-180' : ''}`} style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />
        <path d="m7 15 5 5 5-5" className={`kb-chevron ${expanded ? 'rotate-180' : ''}`} style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />
      </svg>
    </button>
  )
}
