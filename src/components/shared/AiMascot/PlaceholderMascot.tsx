import { memo } from 'react'
import type { AiActivity } from '../../../lib/aiActivity'

/**
 * 内置占位吉祥物（.claude/plans/ai-composer-mascot.md §4.4）。
 *
 * 自绘像素小生物（不涉任何第三方形象），用于把「扩展点 → 活动状态 → 挂载 → 设置开关」
 * 这条管线先跑通；插件贡献的角色（`contributes.mascot`）随后由 `MascotPlayer` 播放。
 * 尺寸 52×36 逻辑格 × 2px = 104×72，脚踩在输入卡上沿（由 `AiMascotAnchor` 定位）。
 */

function face(activity: AiActivity): { body: string; ink: string; mood: 'idle' | 'happy' | 'bad' | 'sleep' | 'think' } {
  switch (activity) {
    case 'error': return { body: '#d9534f', ink: '#2b2a26', mood: 'bad' }
    case 'attention': return { body: '#e0a94a', ink: '#2b2a26', mood: 'happy' }
    case 'sweeping': return { body: '#d97757', ink: '#2b2a26', mood: 'sleep' }
    case 'thinking':
    case 'working': return { body: '#d97757', ink: '#2b2a26', mood: 'think' }
    case 'notification': return { body: '#d97757', ink: '#2b2a26', mood: 'think' }
    default: return { body: '#d97757', ink: '#2b2a26', mood: 'idle' }
  }
}

export const PlaceholderMascot = memo(function PlaceholderMascot({ activity }: { activity: AiActivity }) {
  const active = activity !== 'idle'
  const { body, ink, mood } = face(activity)
  const eyes = (() => {
    switch (mood) {
      case 'happy': // ^ ^
        return <path d="M22 23l1.5-1.5L25 23 M27 23l1.5-1.5L30 23" stroke={ink} strokeWidth="1" fill="none" />
      case 'bad': // x x
        return <path d="M22.5 21.5l2 2 M24.5 21.5l-2 2 M27.5 21.5l2 2 M29.5 21.5l-2 2" stroke={ink} strokeWidth="1" fill="none" />
      case 'sleep': // — —
        return <path d="M22.5 22.5h2 M27.5 22.5h2" stroke={ink} strokeWidth="1" fill="none" />
      default:
        return <><rect x="23" y="21" width="1.5" height="2.5" fill={ink} /><rect x="28" y="21" width="1.5" height="2.5" fill={ink} /></>
    }
  })()
  return (
    <div className={`kb-mascot ${active ? 'kb-mascot-active' : ''}`}>
      <svg viewBox="0 0 52 36" width={104} height={72} shapeRendering="crispEdges" aria-hidden>
        {/* 壳 */}
        <rect x="21" y="18" width="10" height="9" rx="1" fill={body} />
        {/* 侧钳 */}
        <rect x="17.5" y="20" width="3.5" height="3.5" fill={body} />
        <rect x="31" y="20" width="3.5" height="3.5" fill={body} />
        {/* 腿（踩在底行） */}
        <rect x="22" y="27" width="2" height="5" fill={body} />
        <rect x="26" y="27" width="2" height="5" fill={body} />
        <rect x="30" y="27" width="2" height="5" fill={body} />
        {eyes}
        {/* 思考泡 */}
        {mood === 'think' && (
          <>
            <circle cx="34" cy="15" r="1.4" fill="var(--text-muted)" />
            <circle cx="36.5" cy="11.5" r="2" fill="var(--text-muted)" />
          </>
        )}
        {/* 完成 / 出错的小记号 */}
        {activity === 'attention' && <path d="M34 8l1 2 2 .5-1.5 1.4.4 2-1.9-1-1.9 1 .4-2L31.5 10.5 33.5 10z" fill="#e0a94a" />}
        {activity === 'error' && <text x="35" y="10" fontSize="7" fontWeight="700" fill="#d9534f">!</text>}
      </svg>
    </div>
  )
})
