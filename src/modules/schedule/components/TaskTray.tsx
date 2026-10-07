import { useState, type ReactNode } from 'react'
import type { ScheduleTodo } from '../../../types'
import { Zap, Info, Trash2 } from 'lucide-react'
import {
  quadrantMeta, QUADRANT_TEXT_CLASS, QuadrantIconGlyph,
  type QuadrantIcon,
} from '../../../lib/scheduleQuadrant'
import { dragGuard, emitScheduleDragStart } from '../timetable'

/**
 * 日程表视图的「待安排」栏（侧栏）。
 *
 * 这里只放**没有排期时段**的未完成任务 —— 三类任务（计划 / 当日 / 截止）都可能出现，
 * 拖进右侧网格即完成排期；网格里拖回来则清空排期、回到这里。
 *
 * 拖拽用 pointer events：按下后位移超过阈值才真正「起拖」，
 * 事件交给 TimetableView 接管（它掌握网格几何，负责落点判定与提交）；
 * 本栏只负责把任务快照广播出去。落点区域用 `data-tray-drop` 标出来供对方识别。
 *
 * 卡片悬停时右上角出现删除钮（2026-09-13 补）：删除入口原先只存在于日视图列表，
 * 周视图里建错/过期的任务删不掉，必须切到日视图找到那一天。删除钮按下时
 * **必须 stopPropagation**——否则会同时触发卡片的起拖（pointer 手势）与打开编辑弹窗。
 */
interface Props {
  todos: ScheduleTodo[]
  iconSize: 'sm' | 'md' | 'lg'
  quadrantIcon: QuadrantIcon
  quadrantText: 'show' | 'hide'
  onOpen: (todo: ScheduleTodo) => void
  /** 删除任务（上层落盘）。本组件先播 180ms 退场动效再回调，避免卡片瞬间消失看不到动画 */
  onDelete?: (todo: ScheduleTodo) => void
  /** 空态文案（周任务清单与待安排栏文案不同） */
  emptyHint?: ReactNode
}

const TYPE_LABEL: Record<string, string> = { plan: '计划', daily: '当日', deadline: '截止' }

/** 与 `.kb-item-out` 的过渡时长一致（styles/index.css） */
const EXIT_MS = 180

const SZ = {
  sm: { title: 'text-[11.5px]', meta: 'text-[10px]', icon: 12, pad: 'px-2 py-1.5', gap: 'mb-1' },
  md: { title: 'text-[12.5px]', meta: 'text-[10.5px]', icon: 14, pad: 'px-2.5 py-2', gap: 'mb-1.5' },
  lg: { title: 'text-[13.5px]', meta: 'text-[11px]', icon: 16, pad: 'px-3 py-2.5', gap: 'mb-2' },
}

export function TaskTray({ todos, iconSize, quadrantIcon, quadrantText, onOpen, onDelete, emptyHint }: Props) {
  const s = SZ[iconSize]
  /** 正在退场的卡片 id（播完动画才真正落盘删除） */
  const [deletingId, setDeletingId] = useState<string | null>(null)

  /** 点删除：先标记退场 → 动画结束再落盘。中途不落盘，卡片才不会在动画播完前被数据刷新移除 */
  function handleDelete(todo: ScheduleTodo, e: React.MouseEvent) {
    e.stopPropagation()
    if (!onDelete || deletingId) return
    setDeletingId(todo.id)
    window.setTimeout(() => {
      setDeletingId(null)
      onDelete(todo)
    }, EXIT_MS)
  }

  /** 按下后位移超过阈值才算起拖（否则是一次点击 → 打开编辑） */
  function handleCardPointerDown(todo: ScheduleTodo, e: React.PointerEvent) {
    if (e.button !== 0) return
    if (todo.status === 'done') return
    const sx = e.clientX
    const sy = e.clientY
    let started = false

    const onMove = (ev: PointerEvent) => {
      if (started) return
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
      started = true
      cleanup()
      emitScheduleDragStart({
        todo: {
          id: todo.id, title: todo.title, date: todo.date, taskType: todo.taskType,
          tagId: todo.tagId, quadrant: todo.quadrant,
          scheduledStart: todo.scheduledStart, scheduledEnd: todo.scheduledEnd,
        },
        from: 'tray',
        // 待安排任务还没有时长，先按 1 小时落位，落点后可再拉伸
        duration: 60,
        grabOffset: 30,
      })
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
  }

  if (todos.length === 0) {
    return (
      <div data-tray-drop className="flex h-full flex-col">
        <div className="flex-1 flex items-center justify-center px-4">
          <p className="text-[11.5px] text-[var(--text-disabled)] text-center leading-relaxed">
            {emptyHint ?? <>全部任务都已排期<br />把网格里的卡片拖回来可取消排期</>}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div data-tray-drop className="group flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {todos.map(todo => {
          const done = todo.status === 'done'
          const tag = todo.tag ?? null
          const q = quadrantMeta(todo.quadrant)
          const colorCls = QUADRANT_TEXT_CLASS[todo.quadrant] ?? 'text-[var(--text-muted)]'
          return (
            <div
              key={todo.id}
              onPointerDown={e => handleCardPointerDown(todo, e)}
              onClick={() => {
                // 刚拖完的那一下会补发 click，忽略掉，避免顺手弹出编辑窗
                if (Date.now() - dragGuard.lastEnd < 250) return
                onOpen(todo)
              }}
              className={`kb-item-in group relative flex items-center gap-2 ${s.pad} ${s.gap} bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-md ${done ? 'opacity-60' : 'cursor-grab active:cursor-grabbing hover:border-[var(--accent)]'} ${deletingId === todo.id ? 'kb-item-out' : ''} transition-colors`}
              title={done ? '已完成（周任务清单含已完成）' : '拖到右侧日程表即可排期'}
            >
              {/* 标签色条 */}
              <span className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-md" style={{ background: tag?.color ?? 'var(--border-color)' }} />
              <div className="flex-1 min-w-0 pl-1">
                <div className="flex items-center gap-1.5">
                  {todo.taskType === 'daily' ? (
                    /* 零碎任务专属标注：⚡ + warning 色（当天创建当天完成） */
                    <span className="inline-flex items-center gap-0.5 shrink-0 text-[var(--warning)] font-medium" title="零碎任务 · 当天创建当天完成">
                      <Zap size={Math.max(11, s.icon - 2)} />
                      <span className={s.meta}>零碎</span>
                    </span>
                  ) : (
                    <>
                      <span className={`inline-flex items-center shrink-0 ${colorCls}`} title={`${q.label}（紧迫度 ${q.level}/4）`}>
                        <QuadrantIconGlyph icon={quadrantIcon} meta={q} size={Math.max(11, s.icon - 1)} />
                        {quadrantText === 'show' && <span className={s.meta}>{q.label}</span>}
                      </span>
                      <span className={`${s.meta} text-[var(--text-muted)] shrink-0`}>{TYPE_LABEL[todo.taskType] ?? todo.taskType}</span>
                    </>
                  )}
                  {tag && <span className={`${s.meta} text-[var(--text-muted)] truncate`}>{tag.name}</span>}
                </div>
                <p className={`${s.title} font-medium ${done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'} mt-0.5 leading-snug truncate`}>{todo.title}</p>
              </div>
              {/* 删除：始终占位（仅切 opacity），悬停才显现 —— 恒定占位可避免 hover 时标题宽度跳动。
                  按下时 stopPropagation：否则会同时触发卡片的起拖手势 */}
              {onDelete && (
                <button
                  onClick={e => handleDelete(todo, e)}
                  onPointerDown={e => e.stopPropagation()}
                  title="删除"
                  className="shrink-0 p-1 rounded text-[var(--text-muted)] hover:text-[var(--danger)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-colors"
                >
                  <Trash2 size={Math.max(12, s.icon - 2)} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {/* 帮助文案渐进披露（方案三+）：默认仅 ⓘ 图标，悬停托盘交叉淡入完整提示 */}
      <div className="shrink-0 relative h-7 border-t border-[var(--border-color)]">
        <span className="absolute inset-0 flex items-center justify-center text-[var(--text-disabled)] transition-opacity duration-300 group-hover:opacity-0">
          <Info size={13} />
        </span>
        <span className="absolute inset-0 flex items-center justify-center px-3 text-[10.5px] text-[var(--text-disabled)] whitespace-nowrap overflow-hidden text-ellipsis opacity-0 translate-y-[3px] transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
          拖到右侧日程表即可排期；网格里的卡片拖回这里可取消排期
        </span>
      </div>
    </div>
  )
}
