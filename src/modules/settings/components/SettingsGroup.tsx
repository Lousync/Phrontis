import { ChevronRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { HelpHint } from '../../../components/shared/HelpHint'
import { usePresence } from '../../../lib/usePresence'
import { claimPendingAnchor, subscribePendingAnchor } from '../sections'

/**
 * 设置页的折叠分组（2026-10-14，docs/ai-settings-v2-plan.md §2）。
 *
 * 与 `SectionHead` 的分工（不是替代它的通用件，而是「一行一物」改造的落点）：
 *   · `SectionHead` = **常显小节的标题**（标题 + 悬停展开的说明），给不折叠的区块用；
 *   · `SettingsGroup` = **可折叠分组**，标题行上是「标题 + ⓘ + 摘要 + 右侧动作」，
 *     收起时也要能读出「里面有什么」（摘要），且带**多锚点自动展开**。
 *   （既有的 `CollapseList` 只有 title/count，没有摘要与右侧动作，本轮它唯一的调用方
 *     迁移到本组件后已删除 —— 别再从历史提交里把它捞回来。）
 *
 * 两个关键设计：
 *   1. **`anchorIds` 是数组**。搜索跳转的锚点可能落在组内**不同**子块上（模型页场景表里
 *      有 视觉转写 / 文生图 / 改图重绘 三个锚点），只认单个 id 的组件在折叠后会表现为
 *      「滚到一个收起的分组、什么都看不见」。声明齐全 + 跳转自动展开 = 约束 1。
 *   2. **标题行不是一个包住全部的大按钮**。右侧动作与 ⓘ 都是按钮，套进外层按钮会形成
 *      嵌套 `<button>`（浏览器会拆开 DOM，表象是「⋯ 和开关各自变成一个带框的小方块」）。
 *      所以按钮只包「chevron + 标题 + 计数」，「ⓘ / 摘要 / 右侧动作」是它的兄弟节点。
 */
interface Props {
  title: ReactNode
  /** 收起时也能看出里面有什么的一句话摘要（放在标题右侧，可截断） */
  summary?: ReactNode
  /** 说明走 ⓘ 悬停。有真信息量才给 —— 复述标签的句子直接删，不要为了「有个 ⓘ」留半句话 */
  hint?: ReactNode
  /** 本组内容涉及的全部设置锚点 id；搜索跳到组内任一锚点时自动展开（含更深的折叠子块） */
  anchorIds?: string[]
  /** 条数，显示在标题右侧 */
  count?: number
  defaultOpen?: boolean
  /** 标题样式：默认小节标题（12px 大写）；大标题场景传 h2 样式 */
  titleClassName?: string
  /** 标题行右侧的常驻控件（刷新 / 新增等） */
  headerRight?: ReactNode
  className?: string
  children: ReactNode
}

export function SettingsGroup({
  title, summary, hint, anchorIds, count, defaultOpen = false,
  titleClassName, headerRight, className, children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen)
  // 收起时延迟卸载内层子树（保持「收起不挂载」的懒语义，只把卸载推迟一个动画时长）。
  // 外层 grid 容器必须常驻：随内容一起挂载会让展开变成「已展开状态下新建元素」，动画没有起始态。
  // 见 docs/ui-animation-plan.md C 类。
  const { mounted } = usePresence(open, 220)

  // 锚点集合用字符串做依赖：数组每次渲染都是新引用，直接当 dep 会让订阅反复重挂
  const anchorKey = anchorIds?.join('|') ?? ''

  useEffect(() => {
    if (!anchorKey) return
    const ids = anchorKey.split('|')
    // 挂载时先认领一次（覆盖「切换大项后重挂载」），再订阅后续跳转（覆盖停留本页时的二次跳转）
    if (claimPendingAnchor(ids)) setOpen(true)
    return subscribePendingAnchor(id => { if (id && ids.includes(id)) setOpen(true) })
  }, [anchorKey])

  return (
    <div className={className}>
      {/* 标题行是**带框的一行实体**（原型 .group-row 口径）：收起的分组也读得出"这里能点"，
          纯文字标题会被当成小标题、没人去点。摘要右对齐，与标题分居两端。 */}
      <div className="kb-hoveronly-host group flex items-center gap-2 mb-3 px-2.5 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="flex items-center gap-1.5 min-w-0 text-left"
        >
          {/* Tailwind v4 的 rotate-90 写的是 rotate 属性，transition-transform 收不到它 →
              统一用 .kb-chevron（同时过渡 transform 与 rotate） */}
          <ChevronRight size={12} className={`kb-chevron shrink-0 text-[var(--text-muted)] ${open ? 'rotate-90' : ''}`} />
          <h3 className={`truncate ${titleClassName ?? 'text-[13px] text-[var(--text-primary)]'}`}>
            {title}
          </h3>
          {typeof count === 'number' && (
            <span className="shrink-0 text-[10px] text-[var(--text-disabled)]">({count})</span>
          )}
        </button>
        {hint ? <HelpHint text={hint} /> : null}
        {(summary || headerRight) ? (
          <span className="ml-auto min-w-0 flex items-center gap-2 justify-end">
            {summary ? <span className="truncate text-[11.5px] text-[var(--text-muted)]">{summary}</span> : null}
            {headerRight ? <span className="shrink-0 flex items-center gap-1">{headerRight}</span> : null}
          </span>
        ) : null}
      </div>
      <div className={`kb-collapse ${open ? 'open' : ''}`}>
        {open || mounted ? <div>{children}</div> : null}
      </div>
    </div>
  )
}
