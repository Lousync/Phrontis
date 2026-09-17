import { useState } from 'react'
import type * as pdfjsLib from 'pdfjs-dist'

/**
 * PDF 大纲（书签树）共享件（v3.4.0 批次 6 自 PdfReaderView 拆出，方案 §8）：
 * 阅读器内嵌大纲侧栏已删除，三件套（目录/缩略图/书签）只在左栏 bookshelf 模块态渲染一份。
 */

export interface OutlineNode {
  title: string
  dest?: unknown
  items: OutlineNode[]
}

/** outline dest → 页码（v3 dest 结构：数组首元素是 {num,gen} ref；字符串需 getDestination 解析） */
export async function destToPageNum(pdf: pdfjsLib.PDFDocumentProxy, dest: unknown): Promise<number> {
  try {
    let d = dest
    if (typeof d === 'string') d = await pdf.getDestination(d)
    if (Array.isArray(d) && d[0] && typeof d[0] === 'object' && typeof (d[0] as { num?: unknown }).num === 'number') {
      return (d[0] as { num: number }).num
    }
  } catch { /* 解析失败回第 1 页 */ }
  return 1
}

/** pdf.getOutline() → 本地树结构（空/失败返回 []） */
export async function loadOutline(pdf: pdfjsLib.PDFDocumentProxy): Promise<OutlineNode[]> {
  try {
    const raw = await pdf.getOutline()
    if (!raw || !raw.length) return []
    const walk = (list: typeof raw): OutlineNode[] => list.map((it) => ({
      title: it.title ?? '',
      dest: it.dest,
      items: it.items?.length ? walk(it.items) : [],
    }))
    return walk(raw)
  } catch {
    return []
  }
}

interface TreeProps {
  nodes: OutlineNode[]
  onJump: (n: OutlineNode) => void
  depth: number
}

export function OutlineTree({ nodes, onJump, depth }: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  return (
    <div className={depth > 0 ? 'ml-3 border-l border-[var(--border-color)]' : ''}>
      {nodes.map((n, i) => {
        const key = `${depth}-${i}-${n.title}`
        const isCollapsed = collapsed.has(key)
        const hasKids = n.items.length > 0
        return (
          <div key={key}>
            <div className="group flex items-center gap-0.5 pr-1 hover:bg-[var(--bg-hover)]">
              {hasKids ? (
                <button onClick={() => setCollapsed((s) => { const n2 = new Set(s); if (n2.has(key)) n2.delete(key); else n2.add(key); return n2 })}
                  className="w-4 shrink-0 pl-0.5 text-center text-[10px] text-[var(--text-tertiary)]">{isCollapsed ? '▸' : '▾'}</button>
              ) : <span className="w-4 shrink-0" />}
              <button onClick={() => onJump(n)}
                className="min-w-0 flex-1 truncate py-0.5 pr-2 text-left text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                style={{ paddingLeft: depth > 0 ? 0 : 2 }}
                title={n.title}>
                {n.title}
              </button>
            </div>
            {hasKids && !isCollapsed && <OutlineTree nodes={n.items} onJump={onJump} depth={depth + 1} />}
          </div>
        )
      })}
    </div>
  )
}
