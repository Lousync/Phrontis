import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { ModalShell } from '../../components/shared/ModalShell'

/**
 * 书市四个弹层（凭据 / 新增编辑源 / 重名 / 删源）共用的壳。
 *
 * 只做两件事：套 `ModalShell`（遮罩淡入 + 面板缩放进出场 + 退场延迟卸载，见
 * docs/ui-animation-plan.md B 类）+ 三段式骨架（头 / 体 / 脚）。**不复用 ModalShell 的
 * 默认遮罩类之外的任何样式** —— 面板尺寸与配色每个弹层一致，所以收在这里一处。
 *
 * ★ 调用方**不要**再写 `if (!open) return null`：那会把退场动画一起吞掉（ModalShell 的约定）。
 *   内容随 `open` 变化时要自己记住「最后一项」再画（见各弹层里的 ref 手法）。
 */
export function Sheet({ open, title, onClose, children, footer }: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      panelClassName="w-[min(560px,92vw)] max-h-[86vh] overflow-y-auto rounded-[14px] border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-[0_8px_28px_rgba(0,0,0,0.28)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-[18px] py-[15px]">
        <h3 className="m-0 text-[14px] font-medium text-[var(--text-primary)]">{title}</h3>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="ml-auto grid h-6 w-6 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
      <div className="px-[18px] py-[18px]">{children}</div>
      {footer && (
        <div className="flex justify-end gap-2 border-t border-[var(--border-color)] px-[18px] py-[14px]">{footer}</div>
      )}
    </ModalShell>
  )
}

/** 弹层内的三档按钮（原型 `.btn` / `.btn.ghost` / `.btn.danger`） */
export const SHEET_BTN = 'inline-flex h-7 items-center gap-1.5 rounded-[7px] bg-[var(--accent)] px-3 text-[12px] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:border disabled:border-[var(--border-color)] disabled:bg-transparent disabled:text-[var(--text-disabled)]'
export const SHEET_BTN_GHOST = 'inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
export const SHEET_BTN_DANGER = 'inline-flex h-7 items-center gap-1.5 rounded-[7px] bg-[var(--danger)] px-3 text-[12px] text-white transition-opacity hover:opacity-90'

/** 弹层内的信息条（原型 `.infobar`） */
export const SHEET_INFO = 'mb-4 block rounded-[8px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[11.5px] leading-[1.7] text-[var(--text-muted)]'
/** 弹层内的输入框（原型 `.inp`） */
export const SHEET_INP = 'h-8 w-full select-text rounded-[7px] border border-[var(--border-color)] bg-[var(--input-bg)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'
/** 弹层内的字段块（原型 `.fld`） */
export const SHEET_FLD = 'mb-3.5'
export const SHEET_LABEL = 'mb-1.5 block text-[12px] text-[var(--text-secondary)]'
export const SHEET_TIP = 'mt-1.5 text-[11px] leading-[1.6] text-[var(--text-muted)]'
