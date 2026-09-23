import { useRef } from 'react'
import type { BookDownloadRequest, BookMarketItem, BookSourceInfo } from '../../types'
import { SHEET_BTN, SHEET_BTN_DANGER, SHEET_BTN_GHOST, SHEET_INFO, Sheet } from './SheetShell'

/**
 * 两个「问一句再动手」的弹层：
 * ① `DuplicateSheet` —— 落盘重名二选一（原型 `renderDupeSheet`）。
 * ② `DeleteSourceSheet` —— 删源自确认（原型 `renderDelSheet`）。
 *
 * ★ 重名这一层是**主进程主动要求**的：`bookMarketDownload` 不带 `conflict` 时遇到同名文件
 *   会返回 `{ ok:false, conflict:true, relPath, fileName }`，界面拿这份回执再问用户，
 *   然后把同一个 payload **带上 conflict 重调一次**。所以这里只做「记住 payload + 转发选择」，
 *   不自己判重、不自己拼路径（那两件事在 downloader 里，唯一真相源）。
 * ★ 两个弹层都记住了「最后一项」：退场动画期间 props 已变 null，面板还要画完（ModalShell 约定）。
 */

/** `.books/作者 - 书名.epub` → `.books/作者 - 书名 (2).epub`（与下载器 copyNameFor 同构，仅供预览文案） */
function copyPreviewOf(relPath: string): string {
  const at = relPath.lastIndexOf('.')
  const ext = at > relPath.lastIndexOf('/') ? relPath.slice(at) : ''
  const stem = ext ? relPath.slice(0, at) : relPath
  return `${stem} (2)${ext}`
}

export interface DuplicatePending {
  /** 原条目（「另存副本 / 覆盖」要重发的是它，不是从当前结果里回捞 —— 重发时换过一页也照样能下） */
  item: BookMarketItem
  payload: BookDownloadRequest
  relPath: string
  fileName: string
  title: string
  ext: string
}

export function DuplicateSheet({ pending, onClose, onGo }: {
  pending: DuplicatePending | null
  onClose: () => void
  /** 'overwrite' 覆盖 / 'copy' 另存副本 —— 直接就是 IPC 的 conflict 入参 */
  onGo: (how: 'overwrite' | 'copy') => void
}) {
  const last = useRef<DuplicatePending | null>(null)
  if (pending) last.current = pending
  const shown = pending ?? last.current

  return (
    <Sheet
      open={!!pending}
      title="此书已存在"
      onClose={onClose}
      footer={<>
        <button type="button" className={SHEET_BTN_GHOST} onClick={onClose}>取消</button>
        <button type="button" className={SHEET_BTN_GHOST} onClick={() => onGo('copy')}>另存副本</button>
        <button type="button" className={SHEET_BTN} onClick={() => onGo('overwrite')}>覆盖</button>
      </>}
    >
      {shown && (
        <>
          <div className={SHEET_INFO}>
            书架上已有《{shown.title}》（{shown.ext.replace('.', '').toUpperCase()}），
            对应文件 <code className="rounded bg-[var(--bg-secondary)] px-1 py-[1px] font-mono text-[11px]">.{shown.relPath}</code>。
          </div>
          <div className="text-[12px] leading-[1.9] text-[var(--text-secondary)]">
            <b className="font-medium">覆盖</b> —— 用新下载的文件替换已有文件，文件名不变。
            <br />
            <b className="font-medium">另存副本</b> —— 保留原文件，新的存为
            <code className="ml-1 rounded bg-[var(--bg-tertiary)] px-1 py-[1px] font-mono text-[11px] text-[var(--text-muted)]">.{copyPreviewOf(shown.relPath)}</code>。
          </div>
          <div className="mt-3 text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
            两个文件都进不了应用暂存区：覆盖是就地替换，副本是新增一个文件。阅读进度按文件名绑定，所以覆盖后进度仍在原书卡上。
          </div>
        </>
      )}
    </Sheet>
  )
}

export function DeleteSourceSheet({ source, onClose, onConfirm }: {
  source: BookSourceInfo | null
  onClose: () => void
  onConfirm: (s: BookSourceInfo) => void
}) {
  const last = useRef<BookSourceInfo | null>(null)
  if (source) last.current = source
  const shown = source ?? last.current

  return (
    <Sheet
      open={!!source}
      title="删除书源"
      onClose={onClose}
      footer={<>
        <button type="button" className={SHEET_BTN_GHOST} onClick={onClose}>取消</button>
        <button type="button" className={SHEET_BTN_DANGER} onClick={() => shown && onConfirm(shown)}>删除</button>
      </>}
    >
      {shown && (
        <>
          <div className={SHEET_INFO}>
            将删除 <b className="font-medium text-[var(--text-secondary)]">{shown.name}</b>
            （<code className="rounded bg-[var(--bg-secondary)] px-1 py-[1px] font-mono text-[11px]">{shown.url}</code>）
            及其已保存的凭据。删掉之后要重新添加；如果你只是暂时不想用它，
            <b className="font-medium text-[var(--text-secondary)]">停用</b>更合适。
          </div>
          <div className="text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
            已下载的书不受影响 —— 它们已经是仓库里的普通文件，与书源再无关系（连来源标记都只留在元数据里）。
          </div>
        </>
      )}
    </Sheet>
  )
}
