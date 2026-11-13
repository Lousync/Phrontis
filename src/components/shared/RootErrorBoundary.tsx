import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { err: Error | null; info: string }

/**
 * 应用根错误边界（UI 优化 §15 加固）：
 * 任一模块渲染/生命周期崩溃时不再整树卸载（透明窗口会直接「消失」），
 * 而是落一层不透明恢复界面：保留错误摘要 + 一键重载渲染层（location.reload，
 * 主进程与仓库数据不受影响——保活架构下重载后回到上次状态）。
 */
export class RootErrorBoundary extends Component<Props, State> {
  state: State = { err: null, info: '' }

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err }
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? '' })
    console.error('[RootErrorBoundary] 捕获渲染层崩溃:', err, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.err) {
      return (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-3 bg-[var(--bg-primary)] text-[var(--text-primary)]">
          <div className="text-[15px] font-medium">界面渲染出错了</div>
          <div className="max-w-[560px] truncate px-6 text-[12px] text-[var(--text-secondary)]" data-tip={String(this.state.err?.stack ?? this.state.err)} aria-label={String(this.state.err?.stack ?? this.state.err)}>
            {String(this.state.err?.message ?? this.state.err)}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => this.setState({ err: null, info: '' })}
              className="rounded-md border border-[var(--border-color)] px-3 py-1.5 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
            >尝试恢复</button>
            <button
              onClick={() => { window.location.reload() }}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] text-white hover:opacity-90 transition-opacity"
            >重载界面</button>
          </div>
          <div className="text-[11px] text-[var(--text-muted)]">仓库数据不受影响 · 重载后回到上次状态</div>
        </div>
      )
    }
    return this.props.children
  }
}
