import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { AiTeachCourseState } from '../../types'
import { aiTeachCourseMoveUnit } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { FLOW_ST_LABEL } from './flow/flowStatus'
import { FlowCanvas } from './flow/FlowCanvas'
import { pickNextUnit, type FlowScope } from './flow/flowLayout'

/**
 * AI教学·课程模式前端（docs/ai-teaching-course-mode-plan.md）。
 *
 * 定位（2026-10-16 改版 + 2026-10-17 学习流 v2）：**课程模式 = 工作区主界面**。开启后：
 *   · 左栏「会话」区 + 知识点清单（index.tsx 渲染）；
 *   · 中栏在「对话」与「学习流」之间切换（中栏 chip，index.tsx 渲染）；
 *   · 本组件只负责**中栏内容**：无大纲 → 引导回对话；有大纲 → 学习流画布（`FlowCanvas`）。
 * 数据全部走 IPC（主进程 aiTeachingCourse.ts）；本组件不直接碰盘。
 *
 * 本组件只持有**一条**渲染层记忆（方案 §四-9：localStorage，不进 `progress.json`）：
 *   · `aiTeach.lastLesson.<wsId>` —— 上次停留的知识点（§20「继续学」接着它）。
 * 「当前章」（`aiTeach.flow.chapter.<wsId>`）由 index.tsx 持有 —— 因为左栏知识点行点击
 * 也要把那一章设为当前章，跟画布必须是**同一份**记忆；两处各存一份必然不同步。
 */

export const COURSE_ST_LABEL = FLOW_ST_LABEL

interface ScopeCount { req: number; src: number }

interface Props {
  wsId: string
  wsName: string
  state: AiTeachCourseState
  onStartUnit: (unitId: string) => void
  onFinishUnit: (unitId: string, score?: { correct: number; total: number }) => void
  onReopenUnit: (unitId: string) => void
  /** 章末复习课：点进和课程助手讨论本章复习 */
  onOpenChapterReview: (chapterId: string) => void
  /** 收尾自测（出题 → 作答 → 生成总结篇）：弹窗由 index.tsx 持有，两个入口共用 */
  onFinishQuiz: (unitId: string) => void
  onReload: () => void
  /** 对话驱动建课：跳回对话（跟教学助手说目标/改大纲） */
  onGoChat?: () => void
  /** 当前选中的作用域层（画布与右栏「层级」页签共用同一份） */
  selScope: FlowScope
  /** 选中作用域层变化（画布 → 上层；右栏「层级」面据此显示该层的要求 / 素材） */
  onSelectScope: (scope: FlowScope) => void
  /** 「编辑这一层」——打开该层的要求文档 */
  onOpenScopeDoc?: (scope: FlowScope) => void
  /** 每知识点的分层计数（要求 / 素材），卡片两级信息用 */
  scopeCounts?: Record<string, ScopeCount>
  /** 当前章（index.tsx 持有记忆，§19）；只展开它，其余折叠成条 */
  activeChapterId: string
  /** 点折叠条 = 展开并成为当前章（§19） */
  onFocusChapter: (chapterId: string) => void
}

const LAST_KEY = (ws: string) => `aiTeach.lastLesson.${ws}`

function readStr(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeStr(key: string, v: string): void {
  try { localStorage.setItem(key, v) } catch { /* 配额 / 隐私模式失败不影响主流程 */ }
}
/** 上次停留的知识点（存 JSON：`{ unitId, at }`，读坏了就当没记忆） */
function readLastUnit(ws: string): string | null {
  const raw = readStr(LAST_KEY(ws))
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as { unitId?: unknown }
    return typeof o?.unitId === 'string' && o.unitId ? o.unitId : null
  } catch { return null }
}

export function CourseHome({
  wsId, state, onStartUnit, onFinishQuiz, onOpenChapterReview, onGoChat,
  selScope, onSelectScope, onOpenScopeDoc, scopeCounts, activeChapterId, onFocusChapter,
}: Props) {
  /** 上次停留的知识点（§20） */
  const [lastUnit, setLastUnit] = useState<string | null>(() => readLastUnit(wsId))

  // 切工作区：记忆跟着换（state 初始化只在首挂跑一次）
  useEffect(() => { setLastUnit(readLastUnit(wsId)) }, [wsId])

  const chapters = state.outline?.chapters ?? []
  const nextUnitId = useMemo(
    () => pickNextUnit(chapters, state.progress, activeChapterId || null, lastUnit),
    [chapters, state.progress, activeChapterId, lastUnit],
  )

  /** 开课 / 继续学：顺手记住「上次停在这一节」，底部「继续学」下次就接着它 */
  const startUnit = useCallback((unitId: string) => {
    setLastUnit(unitId)
    writeStr(LAST_KEY(wsId), JSON.stringify({ unitId, at: Date.now() }))
    onStartUnit(unitId)
  }, [wsId, onStartUnit])

  // 画布拖拽落点：跨章/同章搬移知识点（保留 id 与进度；主进程写盘后广播刷新）
  // 返回 boolean 供画布决定「乐观顺序」要不要撤（写盘失败就回到真相，别让界面骗人）
  const moveUnit = useCallback(async (unitId: string, targetChapterId: string, beforeUnitId: string | null) => {
    const r = await aiTeachCourseMoveUnit(wsId, unitId, targetChapterId, beforeUnitId).catch(() => null)
    if (!r?.ok) {
      showToast({ type: 'warning', message: `移动知识点失败（${r?.error ?? '未知错误'}）` })
      return false
    }
    return true
  }, [wsId])

  if (!state.outline) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center px-6">
        <div className="w-full max-w-[460px] text-center">
          <div className="mx-auto w-[46px] h-[46px] rounded-xl bg-[var(--accent)]/12 text-[var(--accent)] flex items-center justify-center"><Sparkles size={22} /></div>
          <h2 className="mt-4 text-[17px] font-semibold text-[var(--text-primary)]">还没有课程大纲</h2>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">回到对话，跟<b>教学助手</b>说你的学习目标和素材——它会先清点素材、给你一份大纲草稿，你确认满意后再正式生成。</p>
          {onGoChat && (
            <button onClick={onGoChat}
              className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--accent)] text-white text-[12px] hover:opacity-90 kb-press"><Sparkles size={13} />去和教学助手聊聊</button>
          )}
          <div className="mt-3 text-[11px] text-[var(--text-muted)]">也可以直接手动编辑 <code className="font-mono text-[var(--accent)]">课程.md</code></div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <FlowCanvas
        outline={state.outline}
        progress={state.progress}
        lessons={state.lessons}
        reviews={state.reviews}
        scopeCounts={scopeCounts}
        selScope={selScope}
        onSelectScope={onSelectScope}
        onOpenScopeDoc={onOpenScopeDoc}
        onStartUnit={startUnit}
        onOpenChapterReview={onOpenChapterReview}
        onFinishQuiz={onFinishQuiz}
        onMoveUnit={moveUnit}
        layoutKey={wsId}
        activeChapterId={activeChapterId}
        onFocusChapter={onFocusChapter}
        nextUnitId={nextUnitId}
      />
    </div>
  )
}
