import { edgeResizeStart, edgeResizeEnd } from '../../lib/ipc'

/**
 * UI 优化条目1.7：最大化态的窗口边缘拖拽热区（Edge/Chrome 式「拖边即恢复 + 贴随鼠标」）。
 * 仅在 winMax 时由 App 挂载——无埋窗口最大化后 OS 接管、原生 resize 热区不响应，
 * 这里以固定定位的透明条覆盖四边/四角，mousedown 交主进程 `window:edgeResizeStart` 接管
 * （unmaximize + 对边固定 + 光标跟随 setBounds），window mouseup 统一收尾。
 * z-[80] 压过标题栏（z-[75]）：上缘热区不被顶栏 drag-region 吞掉；`no-drag` 防止热区自身被当拖拽区。
 *
 * ★ mouseup 必须在 mousedown 内动态注册、自移除（2026-10-25 Linux 实锤）：
 *   edgeResizeStart 成功后主进程会 sendMaxState(false) → winMax=false → **本组件即刻卸载**，
 *   useEffect 里的 mouseup 监听随清理被移除 → 用户松手事件丢失 → 主进程跟随循环永不停
 *   （窗口贴着鼠标跑，后续 maximize 与循环互写 = 恶性闪烁）。挂在 window 上的闭包监听
 *   不随组件卸载移除，mouseup 时自摘。
 */
const HANDLES: Array<{ id: string; cursor: string; style: React.CSSProperties }> = [
  { id: 'top', cursor: 'ns-resize', style: { top: 0, left: 8, right: 8, height: 6 } },
  { id: 'bottom', cursor: 'ns-resize', style: { bottom: 0, left: 8, right: 8, height: 6 } },
  { id: 'left', cursor: 'ew-resize', style: { left: 0, top: 8, bottom: 8, width: 6 } },
  { id: 'right', cursor: 'ew-resize', style: { right: 0, top: 8, bottom: 8, width: 6 } },
  { id: 'top-left', cursor: 'nwse-resize', style: { left: 0, top: 0, width: 12, height: 12 } },
  { id: 'top-right', cursor: 'nesw-resize', style: { right: 0, top: 0, width: 12, height: 12 } },
  { id: 'bottom-left', cursor: 'nesw-resize', style: { left: 0, bottom: 0, width: 12, height: 12 } },
  { id: 'bottom-right', cursor: 'nwse-resize', style: { right: 0, bottom: 0, width: 12, height: 12 } },
]

export function WindowResizeHandles() {
  return (
    <>
      {HANDLES.map(h => (
        <div
          key={h.id}
          className="no-drag"
          onMouseDown={(e) => {
            e.preventDefault()
            void edgeResizeStart(h.id).catch(() => {})
            const up = () => {
              window.removeEventListener('mouseup', up)
              void edgeResizeEnd().catch(() => {})
            }
            window.addEventListener('mouseup', up)
          }}
          style={{ position: 'fixed', zIndex: 80, cursor: h.cursor, ...h.style }}
        />
      ))}
    </>
  )
}
