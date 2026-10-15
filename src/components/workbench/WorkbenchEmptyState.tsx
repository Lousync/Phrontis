import type { ReactNode } from 'react'
import { AppWindow } from 'lucide-react'

/**
 * 工作台「全关空态」的引导面（v3.5.0，2026-10-13）。
 *
 * 来历：空态原本只留一枚 `AppWindow` 图标（2026-09-19 反馈「不要文字说明，页面简画」）。
 * 本次加的不是说明文字，而是**三条可执行的动作入口** —— 挑的三条有同一条判据：
 * **界面上看不见、只能靠快捷键记忆的能力**。
 *   · 命令面板 Ctrl+Shift+P —— 唯一的全局兜底入口
 *   · 快速打开文件 Ctrl+O   —— 顶栏搜索框删除后，按文件名找仓库 md 只剩这个键
 *   · AI 助手 Ctrl+J        —— 右下 AI 浮钮 2026-09-16 已移除、右栏默认折叠
 *                              （workbenchLayout 的 rightCollapsed: true）
 *                              ⇒ 冷启动时 AI 对话入口在界面上**零可见**
 * 反例（刻意不放）：打开笔记 / AI教学 / 日程 —— 活动栏、左栏书签、右栏磁贴区
 * 已有三处可见入口，放进空态只是重复噪音。
 *
 * 契约（改动前先读）：
 *   ① 本组件是**纯展示**：三条文案 / 键位 / 动作一律由 App 注入（同 CommandPalette 收
 *      `items` 的范式）。动作真源是 App.tsx 的 `openCommandPalette` / `openQuickOpen` /
 *      `toggleWorkbenchAi` —— 它们同时被全局快捷键监听与 Ctrl+J 路由调用。
 *      **不许在这里内联动作实现**，否则快捷键与提示会各自演化（契约脚本
 *      `.AGENT/scripts/workbench-shell/verify-empty-state-hints.mjs` 有断言锁）。
 *   ② 外层是 `absolute inset-y-0` 铺满主栏：绝对定位不参与 flex 流，加三行**不会**
 *      挤动左右两栏几何（与 2026-09-19 那条注释同口径）。
 *   ③ 矮中心区（小窗 / 分屏）兜底 = 提示块 `min-h-0 + max-h-full + overflow-hidden`：三条永远都在，
 *      不够高时裁掉底部，而不是「矮的时候少显示一条」（少显示哪条都说不通）。
 *      ★ `min-h-0` 不可省：column flex 项的 `min-height` 默认 `auto`（= 内容高）⇒ 不加就根本
 *      收缩不了，整块溢出后会被外层 `overflow-hidden` 从**上下两端**一起裁，连图标都被切。
 *   ④ 入场动效走既有令牌 `.kb-item-in` + 逐条 `animationDelay`，**不新增任何 CSS**
 *      （该类的 `prefers-reduced-motion` 兜底已在 styles/index.css 的统一清单里）。
 */

export interface WorkbenchHint {
  id: string
  label: string
  /** 快捷键键帽，逐枚渲染（如 ['Ctrl','Shift','P']） */
  keys: string[]
  icon: ReactNode
  run: () => void
}

interface Props {
  hints: WorkbenchHint[]
}

export function WorkbenchEmptyState({ hints }: Props) {
  return (
    <div
      data-wb="empty"
      className="absolute inset-y-0 left-0 z-20 flex w-full flex-col items-center justify-center gap-[22px] overflow-hidden pb-16"
    >
      <AppWindow size={44} strokeWidth={1.2} className="shrink-0 text-[var(--text-disabled)]" />
      <div
        role="group"
        aria-label="常用指令"
        data-wb="emptyHints"
        /* min-h-0 是兜底能生效的前提：column flex 项的 min-height 默认是 auto（= 内容高），
           不加就**根本收缩不了**，矮窗下整块溢出、被外层 overflow-hidden 从上下两端一起裁，
           连图标都会被切。加上它 + 图标 shrink-0，才是「图标恒在、只裁提示底部」。
           （与仓库里 `flex min-h-0 flex-1 flex-col` 的既有写法同一条理由。） */
        className="flex min-h-0 max-h-full w-[300px] max-w-[80%] flex-col gap-1 overflow-hidden"
      >
        {hints.map((h, i) => (
          <button
            key={h.id}
            data-wb-hint={h.id}
            onClick={h.run}
            title={`${h.label}（${h.keys.join(' + ')}）`}
            style={{ animationDelay: `${i * 70}ms` }}
            className="kb-item-in flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent)]/10"
          >
            <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-[var(--accent)]/12 text-[var(--accent)]">
              {h.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{h.label}</span>
            <span className="flex shrink-0 gap-0.5">
              {h.keys.map((k) => (
                <kbd
                  key={k}
                  className="kb-kbd rounded px-1 py-[3px] text-[10px] leading-none"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
