import { BookOpen } from 'lucide-react'

/**
 * 书架模块（v3.4.0 批次3 占位页，方案 §3.3 拍板④ / §5 新增清单）。
 *
 * v3.4.0 的书架 = **PDF 书架**（封面网格 + 续读，第二批立项「PDF 阅读体验整包」的主战场）。
 * 本批次只落左栏书签 → 中间标签页的入口闭环与侧栏壳（左栏模块态显示空态书架侧栏），
 * 封面网格/阅读器/PdfViewer 接线等由 PDF 整包批次实现。
 */
export function BookshelfModule({ isActive = true }: { isActive?: boolean }) {
  void isActive
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--bg-primary)] text-[var(--text-muted)]">
      <BookOpen size={40} strokeWidth={1.5} />
      <div className="text-[13.5px]">书架</div>
      <div className="max-w-[280px] text-center text-[11.5px] leading-relaxed">
        PDF 书架（封面网格 · 续读）将在「PDF 阅读体验整包」批次上线
      </div>
    </div>
  )
}
