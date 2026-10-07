/**
 * 四象限共享配置（TodoItem / TodoEditModal / QuadrantChart / schedule index 共用）
 *
 * 解决三处各写一份 QUADRANT_LABELS / QUADRANT_COLORS 导致的口径漂移：
 * 标签、颜色、紧迫度档位、图标方案、排序方案全部收敛到这里。
 *
 * 数据层不动：quadrant 存储值恒为 0/1/2/3（与后端一致），排序与图标只影响渲染。
 */

/** 四象限图标方案（设置项 scheduleQuadrantIcon） */
export type QuadrantIcon = 'bars' | 'flame' | 'step' | 'grid'

/** 四象限排序方案（设置项 scheduleQuadrantOrder） */
export type QuadrantOrder = 'ladder' | 'legacy'

export interface QuadrantMeta {
  /** 存储值，勿改（后端/历史数据均按此值） */
  value: number
  label: string
  /** 紧迫度档位 1-4，越大越紧迫 */
  level: number
  /** 着色（文字 / 图标 currentColor 由父级 text 色决定，此处给 tooltip 与直接着色用） */
  color: string
}

/** 按存储值序（0/1/2/3）的定义表 */
export const QUADRANTS: QuadrantMeta[] = [
  { value: 0, label: '紧急重要', level: 4, color: 'var(--danger)' },
  { value: 1, label: '重要不紧急', level: 2, color: 'var(--accent)' },
  { value: 2, label: '紧急不重要', level: 3, color: 'var(--warning)' },
  { value: 3, label: '不紧急不重要', level: 1, color: 'var(--text-muted)' },
]

/** 文字着色 class（沿用既有视觉：0 红 / 1 蓝 / 2 黄 / 3 灰） */
export const QUADRANT_TEXT_CLASS: Record<number, string> = {
  0: 'text-[var(--danger)]',
  1: 'text-[var(--accent)]',
  2: 'text-[var(--warning)]',
  3: 'text-[var(--text-muted)]',
}

export function quadrantMeta(value: number): QuadrantMeta {
  return QUADRANTS.find(q => q.value === value) ?? QUADRANTS[0]
}


/**
 * 展示顺序。
 * - ladder（默认）：紧迫度**从左到右递增** —— 不紧急不重要 → 重要不紧急 → 紧急不重要 → 紧急重要，
 *   视觉上是一条朝右上走的阶梯。
 * - legacy：原顺序（紧急重要 · 重要不紧急 · 紧急不重要 · 不紧急不重要），档位 4·2·3·1 不单调。
 */
export function orderedQuadrants(order: QuadrantOrder): QuadrantMeta[] {
  if (order === 'legacy') return QUADRANTS.slice()
  return QUADRANTS.slice().sort((a, b) => a.level - b.level)
}


/** 低透明度：未点亮的格/柱/火（用 currentColor + opacity，自动适配明暗主题） */
const DIM = 0.18

/**
 * 象限图标：把「紧迫度档位」画出来。
 * 四种方案都遵循同一语言 —— 点亮的柱/火/格越多、圆点越高，越紧迫。
 * 颜色取父级 currentColor（配合象限文字色 class），未点亮部分用同色低透明度。
 */
export function QuadrantIconGlyph({ icon, meta, size = 19, className }: {
  icon: QuadrantIcon
  meta: QuadrantMeta
  /** 图标宽度（px），高度按 20:16 比例 */
  size?: number
  className?: string
}) {
  const w = size
  const h = Math.round(size * 0.8)
  const common = { width: w, height: h, viewBox: '0 0 20 16', className, style: { flex: '0 0 auto' } as const }

  if (icon === 'bars') {
    // 信号格：4 根递增柱，亮起的根数 = 档位
    const heights = [5, 8, 11.5, 15]
    return (
      <svg {...common}>
        {heights.map((bh, i) => (
          <rect key={i} x={i * 5.2} y={16 - bh} width={3.6} height={bh} rx={1.1}
            fill="currentColor" opacity={i < meta.level ? 1 : DIM} />
        ))}
      </svg>
    )
  }

  if (icon === 'flame') {
    // 火焰：1~3 团，第四档整排加亮放大
    const count = meta.level >= 3 ? 3 : meta.level
    const scale = meta.level === 4 ? 0.98 : 0.86
    const d = 'M5.5 0C5.5 3 2 4.2 2 8.2 2 11.2 3.9 13 5.5 13 7.1 13 9 11.2 9 8.2 9 5.4 6.6 4.6 5.5 0Z'
    return (
      <svg {...common}>
        {[0, 1, 2].map(i => {
          const lit = i < count
          const sc = lit ? scale : 0.6
          return (
            <g key={i} transform={`translate(${i * 6.3}, ${lit ? 1 : 4}) scale(${sc})`}>
              <path d={d} fill="currentColor" opacity={lit ? 1 : DIM} />
            </g>
          )
        })}
      </svg>
    )
  }

  if (icon === 'step') {
    // 上升阶梯：4 级台阶 + 圆点标出所在档位（从左到右逐级升高）
    const d = 'M1 14 H5.75 V10.4 H10.5 V6.8 H15.25 V3.2 H19.5'
    return (
      <svg {...common}>
        <path d={d} fill="none" stroke="currentColor" strokeWidth={1.6}
          strokeLinejoin="round" strokeLinecap="round" opacity={0.45} />
        {[0, 1, 2, 3].map(i => (
          <circle key={i}
            cx={1 + i * 4.75 + 2.4}
            cy={14 - i * 3.6 - 1.8}
            r={i === meta.level - 1 ? 2.4 : 1.5}
            fill="currentColor"
            opacity={i === meta.level - 1 ? 1 : DIM} />
        ))}
      </svg>
    )
  }

  // grid：迷你象限 —— 右=紧急、上=重要，点亮所在格
  const pos: Record<number, { x: number; y: number }> = {
    0: { x: 10.6, y: 0.6 }, // 紧急重要 → 右上
    1: { x: 0.6, y: 0.6 },  // 重要不紧急 → 左上
    2: { x: 10.6, y: 8.6 }, // 紧急不重要 → 右下
    3: { x: 0.6, y: 8.6 },  // 不紧急不重要 → 左下
  }
  return (
    <svg {...common}>
      {[0, 1, 2, 3].map(v => (
        <rect key={v} x={pos[v].x} y={pos[v].y} width={8.8} height={6.8} rx={1.8}
          fill="currentColor" opacity={v === meta.value ? 1 : DIM} />
      ))}
    </svg>
  )
}
