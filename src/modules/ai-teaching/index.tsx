import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, X, Loader2, Bot, FileText, Plus, Trash2, BookOpen, Compass, CalendarClock, PenLine, ChevronLeft, ChevronRight, ChevronDown, PanelRightClose, PanelRightOpen, ArrowLeft, ArrowUp, ArrowDown, ArrowRight, Folder, Search, User, Eye, FileOutput, Copy, RotateCcw, ScrollText, Image as ImageIcon, Quote, Info, Paperclip, ClipboardList, GitBranch, RefreshCw, Check, MessagesSquare, Star, Repeat, Layers } from 'lucide-react'
import {
  agentSessions, agentMessages, agentDeleteSession,
  agentChat, agentAbort, onAgentStep, llmGetUsage, getSettingRaw, setSettingRaw, agentSetSessionInstructions, llmListProviders, llmReasoningCapable, llmVisionModels, aiToolsListSkills, agentListSideLanes,
  workspaceGetCurrent, workspaceReadFile, docsPptxPages, workspaceRefreshVault,
  agentRenameSession, aiTeachSessionFolder, aiTeachRenameSessionFolder, aiTeachDeleteSessionFolder, aiTeachReadConstraints, aiTeachWriteConstraints, aiTeachGlobalEnsureConstraints, aiTeachWorkspaceEnsureConstraints, aiTeachOrganizeDoc, onAiTeachNotice, onAiTeachTreeRefresh, onWsFsChanged,
  aiTeachListWorkspaces, aiTeachCreateWorkspace, aiTeachRenameWorkspace, aiTeachDeleteWorkspace, aiTeachUnassignSession, aiTeachSetLastWorkspace,
  aiTeachCourseGetState, aiTeachCourseGetSources, aiTeachCourseWriteOutlineDraft, onAiTeachCourseRefresh,
  aiTeachCourseOpenSegment, aiTeachCourseSetActiveUnit, aiTeachCourseEndSegment, aiTeachCourseFinalizeSegment,
  aiTeachCourseReadPrevHandoff,
  aiTeachCourseOpenAssistant, aiTeachCourseOpenChapterReview,
  aiTeachFavList, aiTeachFavAdd, aiTeachFavRemove,
  aiTeachProfileEnsureGlobal, aiTeachProfileEnsureSession, aiTeachProfileEnsureWorkspace,
  aiTeachProfileWriteSession, aiTeachProfileApplyPatch, getSetting,
} from '../../lib/ipc'
import { AiTeachFileTree } from './AiTeachFileTree'
import { CourseRail } from './CourseRail'
import { Preflight } from './Preflight'
import { CourseProgress } from './CourseProgress'
import { CourseSources } from './CourseSources'
import { RequirementsDrawer, type ReqLayer } from './RequirementsDrawer'
import { buildCourseRail, activeChapterId as pickRailChapter, type RailChapterInput } from './courseRail'
import { latestEndedSegmentOfUnit, lessonUnitIds, openSegmentOfUnit, reviewState, unitLearned } from '../../lib/aiTeachingProgressPure'
import { parseProfileFence, profileThrottleAllows, profileThrottleNote, layerAllows, userRoundCount, PROFILE_THROTTLE_ROUNDS, type ProfileLayer, type ProfileSuggestion, type ProfileThrottleState } from './profilePatchParse'
import { ArtifactsPane } from './ArtifactsPane'
import { SideLaneCenter } from './SideLaneCenter'
import { SideLanePanel } from './SideLanePanel'
import type { ArtTab } from './artifacts'
import { ResizablePanel } from '../../components/shared/ResizablePanel'
import { Collapsible } from '../../components/shared/Collapsible'
import { looseJsonParse } from '../../components/shared/QuizParser'
import { showToast } from '../../lib/toast'
import { handleChatCommand } from '../../lib/chatCommands'
import { SlashCommandMenu, buildSlashItems, filterSlashItems, type SlashMenuItem } from '../../components/shared/SlashCommandMenu'
import { ImageCard, imageGroupsOf } from '../../components/shared/AssistantPanel/ImageCard'
import { looksLikeMindMap } from '../../lib/mindmap'
import { isRenderableImagePath } from '../../lib/imageFormats'
import { toolActionLabel } from '../../lib/toolLabels'

/** AI 教学面的斜杠指令（/mindmap、/生图）已收口到 src/lib/chatCommands.ts 的
 *  PASSTHROUGH_COMMANDS 单一真源 —— 弹层候选与「放行给模型」判定读同一张表，
 *  本模块不再另写一份（v3.6.0，docs/ai-image-gen-plan.md §5.1）。 */
import { showGlobalConfirm } from '../../lib/globalConfirm'
import { registerSelectionAskHost } from '../../lib/assistantContext'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'
import { StreamBubble } from '../../components/shared/AssistantPanel/StreamBubble'
import { ProcessSummary, type TraceRowView } from '../../components/shared/AssistantPanel/ProcessSummary'
import { useAgentStream } from '../../components/shared/AssistantPanel/useAgentStream'
import { useInputShell } from '../../components/shared/AssistantPanel/inputShells'
import { UsageRing, fmtTok } from '../../components/shared/UsageRing'
import { AiMascotAnchor } from '../../components/shared/AiMascot/AiMascotAnchor'

/**
 * v3.1.2 条目11：支线旁问。锚点回答 → 支线映射**由会话库派生**（见下方 anchorLanes）——
 * `agent:listSideLanes` 带回的每条支线都带 `branchFromMessageId`，据此在回答下方显示
 * 「支线追问 · 已开」（点击进右栏支线中心重开）；不再落 localStorage（修掉清缓存/换机即失联）。
 */
import type { AgentSessionInfo, AgentSideLaneInfo, AgentStoredMessage, AgentTraceStep, AgentChange, AgentChatResult, AiTeachInjectionStats, LlmUsageInfo, LlmProviderInfo, LlmVisionModelInfo, AiTeachWorkspaceInfo, AiTeachSourcesPayload, AiTeachSegmentSource, AiTeachSource, AiTeachCourseChapter, AiTeachFavorite, SkillInfo, AiTeachProfileEntry, AiTeachProfileOp, AiTeachCourseState } from '../../types'

/**
 * 「AI教学」模块（原 id immersive / 沉浸式 Agent；总纲 docs/ai-teaching-module-rework.md，
 * 历史设计 docs/agent-immersive-mode-design.md M0 骨架）
 * 独立全屏 Tab（五区布局），与轻问答共用 AgentRunner 会话库与 agent:step 推送。
 * 已实现：会话列表/新建任务（场景模板）/发送/回复渲染/实时步骤/轨迹折叠/改动清单可跳编辑器；
 * P1 会话⇄文件夹绑定：新建对话即建 `{MM-DD} 标题` 文件夹（.session.json 锚点）、重命名同步改夹、
 * 删除会话按 aiTeachDeleteSessionFolder（ask/keep/delete）处理文件夹（进系统回收站）。
 * P2 约束文件化：会话要求唯一真相源 = 会话文件夹 CONSTRAINTS.md（弹层读写文件，主进程每轮重读注入）。
 * P3 中栏改版：AI 回答去气泡平铺 + 逐条操作条（整理成文档/复制/轨迹）；右缘快速定位条（标题锚点）；
 * 输入区流式停止键 + 本对话模型/思考强度合一菜单（仅本对话生效）；顶栏收敛（时间线/文档视图/文档地图退役）。
 * P4 左栏 VS Code 化（§3.7/3.9）：多分区侧栏（资源管理器=产物根文件树全套操作 / 会话），
 * 折叠贴靠+状态记忆，左右侧栏整体收放记忆；md 点击 → 中栏文档阅读视图（方案 B：工具行+宽幅渲染+h2/h3 大纲+滚动记忆）。
 * 　（v3.8.0 布局改造：原左栏第三分区「任务规划」已删除，左栏恒为 会话 / 资源管理器 两段）
 * P5 工作区两层（§3.2-6）：记住上次工作区直接进（3-38），顶栏工作区 chip 回「工作区选择页」（卡片统计/搜索/新建/改名/删除=仅解归属）；
 * 一个工作区=一门课程含多对话，元数据入仓库 .knowbase/modules/aiTeaching/workspaces.json；
 * 顶栏页签=本工作区对话（会话列表区退役）、工作区 chip 返回选择页；左栏树挂工作区文件夹层；
 * 新对话自动归属当前工作区，产物落 `AI教学/{工作区}/{MM-DD 标题}/`（存量扁平文件夹不迁移，锚点扫描双深度兼容）。
 * P7 题目视图（§3.2-7/3-9）**已于 v3.8.0 删除**（用户 2026-10-16 拍板：做题直接让 AI 生成一篇「题目文档」，
 * 不必在模块里单开一栏）：出题改为 **AI 调 course.organize.archive 把整卷写成一篇 .md「题目文档」**（每题一个 ```quiz 围栏），
 * 在文档阅读视图 / 知识库里作答（MarkdownPreview 渲染题卡，判分 / 解析 / 错题回流与知识库同一条链路）；
 * 「出题规则」仍照旧注入（围栏格式不变），但不再有聚合清单、整卷答题与交卷报告。
 * P6 素材库（v3.1.1 上移工作区层）：右栏「素材库」= **工作区主库** `SOURCES/SOURCE.md`（跨对话共用，未建对话也可登记）
 * + 本对话历史登记（存量，合并视图重编号 1..N，标「对话」角标，一键「上收」并入主库）；「＋素材」表单登记
 * （类型/存放/页码·行号区间仅 pdf·pptx·docx·code 拆起止，3-28 程序解析写入；区间类型清单收敛为 RANGE_TYPES 常量，v3.2.0 条目 ⑯）、pdf/pptx/docx 一键区间提取为同级可编辑提取稿（3-20/3-26；docx 经 soffice 转 PDF，v3.1.2 条目5），
 * SOURCE.md 与提取稿经 AgentRunner 素材目录注入供 AI 编号引用（3-29，每轮重读）——新对话因此能看到工作区已有素材。
  * 3-21 视觉转写（手动档）：pdf/pptx/docx 条目「转写」按钮→主进程转 PDF（pptx/docx 经 soffice）→渲染层 pdf.js 区间栅格化→视觉模型逐页转写→并入提取稿。
 * P8 用户画像（§3.14）：全局（仓库内 {aiTeachRoot}/PROFILE.md）+ 工作区 + 会话 PROFILE.md 三层每轮注入；
 * 更新走 Plan B——AI 输出 ```profile 建议块 → 输入框上方建议卡片，接受才写文件（3-33）；
 * v3.2.0 第 20 项起：围栏内容是**相对本主题画像的变化条目**（`[{field,op,text}]`），卡片升级为
 * 可勾选 / 可编辑的 diff 列表 —— 本主题层可整段替换字段，工作区 / 全局只允许追加（只接受 add）；
 * 忽略后有节流窗口（8 轮 / 30 分钟取先到），窗口内只留安静入口，不再每轮弹；
 * 「🩺 诊断问答」模板（3-34）答完生成初稿；入口=选择页「全局画像」chip + 顶栏「画像」chip（3-35）。
 */

/** P5：工作区卡片「最近活跃」相对时间（updated_at 'YYYY-MM-DD HH:MM:SS' 本地串） */
function wsAgo(iso: string | null): string {
  if (!iso) return '无'
  const t = new Date(iso.replace(' ', 'T')).getTime()
  if (Number.isNaN(t)) return '无'
  const d = Date.now() - t
  if (d < 86400000) return '今天'
  if (d < 172800000) return '昨天'
  return iso.slice(5, 10)
}

/** P4 §3.9-1：侧栏分区头（VS Code 式贴靠——收起只剩头，展开体占剩余高度） */
function SectionHead({ open, title, onToggle, right }: { open: boolean; title: string; onToggle: () => void; right?: React.ReactNode }) {
  return (
    <div
      onClick={onToggle}
      className={`flex items-center gap-1 px-2 py-1.5 shrink-0 select-none cursor-pointer border-t border-[var(--border-color)] text-[11px] font-semibold tracking-wide text-[var(--text-muted)] hover:bg-[var(--bg-hover)] first:border-t-0 ${open ? 'bg-[var(--bg-secondary)]' : ''}`}
    >
      {/* UI 优化条目3：单一 chevron + rotate 过渡（展开=向下 90°，收起=向右），替代瞬时双图标切换 */}
      <ChevronRight size={11} className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
      <span className="truncate">{title}</span>
      {right && <span className="ml-auto flex items-center gap-0.5" onClick={e => e.stopPropagation()}>{right}</span>}
    </div>
  )
}

/** P3b：思考强度档位（与主进程 LlmInvokeRequest.effort 同口径） */
type Effort = 'off' | 'low' | 'medium' | 'high'
const EFFORT_LABEL: Record<Effort, string> = { off: '关闭', low: '低', medium: '中', high: '高' }

/** P3a（3-13）：回答锚点标题——取首行 markdown 标题（主进程已注入标题规则）；无标题退首行截断，再退「回答N」 */
function msgAnchorTitle(content: string, n: number): string {
  const lines = String(content ?? '').split('\n')
  for (const l of lines) {
    const m = /^\s{0,3}#{1,6}\s+(.+)/.exec(l)
    const t = m?.[1]?.replace(/[*`>]/g, '').trim()
    if (t) return t.slice(0, 40)
  }
  const first = (lines.find(l => l.trim().length > 0) ?? '').trim()
  return first ? first.slice(0, 28) : `回答 ${n + 1}`
}

/** L4 引用网络：从 AI 回答里抽出 `跳转：<知识点名>` 行（正文剔除，另渲染成跳转 chip） */
function splitJumps(content: string): { body: string; jumps: string[] } {
  const jumps: string[] = []
  const body = String(content ?? '').split('\n').filter((line) => {
    const m = /^\s*(?:跳转|跳转链接|回顾链接|回顾)[：:]\s*(.+?)\s*$/.exec(line)
    if (m) { jumps.push(m[1].replace(/[《》"']/g, '').trim()); return false }
    return true
  }).join('\n')
  return { body, jumps }
}

/** 名称归一（去书名号/引号/标点/空白，大小写不敏感）：让跳转 chip 容忍 AI 输出的写法差异（F3） */
function normName(s: string): string {
  return String(s ?? '').replace(/[《》「」『』""''\s·・,，.。:：;；!！?？、\-—_]/g, '').toLowerCase()
}

/** trace → 完成态过程摘要的行视图（思考行只在有 thinkingMs 时出现） */
function traceRows(steps?: AgentTraceStep[]): TraceRowView[] {
  return (steps ?? []).flatMap((st, j): TraceRowView[] => {
    if (st.kind === 'tool') {
      return [{
        key: `${j}-${st.name ?? 'tool'}`,
        kind: 'tool' as const,
        label: toolActionLabel(st.name),
        ok: st.ok !== false,
        durationMs: st.durationMs,
      }]
    }
    if (!st.thinkingMs || st.thinkingMs <= 0) return []
    return [{
      key: `${j}-llm`,
      kind: 'think' as const,
      label: '思考',
      ok: st.ok !== false,
      durationMs: st.thinkingMs,
    }]
  })
}

/**
 * 流式期间剥掉尾部**未闭合**的 ``` 围栏（quiz/plan/ask/profile 等协议块），
 * 防止半截 JSON 在正文里闪现；围栏闭合后自然恢复显示。
 * 规则：最后一个 ``` 之后若再无 ```，则截断到它之前（正规 Markdown 中围栏总是成对）。
 */
function stripOpenFence(text: string): string {
  const open = text.lastIndexOf('```')
  if (open === -1) return text
  return text.slice(open + 3).includes('```') ? text : text.slice(0, open)
}

interface UiMsg {
  id?: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  trace?: AgentTraceStep[]
}

/** UI 优化条目4：时间显示统一正则版（参照 AssistantPanel）——SQLite 'YYYY-MM-DD HH:MM:SS'(localtime) 直取数字、
 * 带时区 ISO 先转本地分量；解析失败返回 ''（时间段整体不渲染），杜绝 `new Date()` 构造 Invalid Date 上屏 */
function fmtTime(raw?: string | null): string {
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && /Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const t = new Date(raw).getTime()
    if (Number.isNaN(t)) return ''
    const d = new Date(t)
    const p = (n: number) => String(n).padStart(2, '0')
    raw = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(raw)
  if (!m) return ''
  const now = new Date()
  const sameDay = Number(m[1]) === now.getFullYear() && Number(m[2]) === now.getMonth() + 1 && Number(m[3]) === now.getDate()
  return sameDay ? `${m[4]}:${m[5]}` : `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}
/** 中英混排估算口径（仅用于注入构成摘要的字符→token 折算展示，非计费依据） */
const CHARS_PER_TOKEN = 2.6

/** UI 优化条目6B：中栏导航状态按会话持久化（`aiTeach.nav.{sessionId}`）。
 *  保活架构下切 Tab 不卸载组件，但模块实例重建会整树重置——
 *  以 localStorage 兜底，回到该会话即恢复到离开时的视图（文档阅读 > 逐页阅读 > 对话）。 */
type AiTeachNav = {
  docRel?: string | null; readerRel?: string | null; readerPage?: number
  /**
   * v3.1.2 条目7（会话准备态）：创建对话 → 首条消息之间的中间态快照。
   * - `started` 缺省/false = 仍停准备态；true = 已开讲（此后不再进准备态）
   * - `draft` 首条消息（用户编辑后的值；缺省回落场景 startPrompt）
   * - `srcOpen`/`reqOpen` 素材条 / 会话要求条折叠态（切回时还原到切走瞬间）
   * 素材与约束内容不入快照——真相源是 SOURCE.md / CONSTRAINTS.md，实时读才不会丢外部变更。
   */
  prep?: { started?: boolean; draft?: string; srcOpen?: boolean; reqOpen?: boolean }
  /**
   * v3.2.0 第 20 项（画像更新建议节流）：用户忽略 / 应用一次后记账，
   * 窗口内（8 轮或 30 分钟，取先到）不再自动弹卡片 —— 忽略的留一个安静入口，已写入的不留。
   */
  profile?: ProfileThrottleState
}
/** 画像建议卡片的一行 = 一条变化条目 + 勾选态；`text` 可被用户就地改写（改过即以用户版本为准） */
type ProfRow = AiTeachProfileEntry & { checked: boolean }

function readNav(sid: string): AiTeachNav {
  try { return JSON.parse(String(localStorage.getItem(`aiTeach.nav.${sid}`) || '{}')) as AiTeachNav } catch { return {} }
}
function writeNav(sid: string, patch: AiTeachNav): void {
  try { localStorage.setItem(`aiTeach.nav.${sid}`, JSON.stringify({ ...readNav(sid), ...patch })) } catch { /* 隐私模式忽略 */ }
}
function clearNav(sid: string): void {
  try { localStorage.removeItem(`aiTeach.nav.${sid}`) } catch { /* ignore */ }
}

/** UI 优化条目12/13：```ask 围栏解析——对象 = 单题选择卡；数组 = 整卷模式（§13.1 诊断问答） */
type AskSingle = { kind: 'single'; id: string; question: string; options: string[]; allowCustom: boolean }
type AskExam = { kind: 'exam'; id: string; questions: Array<{ question: string; options: string[] }> }
type AskBlock = AskSingle | AskExam
function parseAskBlock(raw: string, id: string): AskBlock | null {
  // 条目13：宽容解析（全角瑕疵 + 字符串内未转义引号反向修复）——翻车主形态「题干内 "底分"」在修复层兜住
  const p: unknown = looseJsonParse(raw)
  if (p === null) return null
  try {
    const normOpts = (o: unknown): string[] =>
      Array.isArray(o) ? o.map(x => String(x)).filter(s => s.trim()).slice(0, 6) : []
    if (Array.isArray(p)) {
      const qs = (p as Array<Record<string, unknown>>)
        .map(q => ({ question: String(q?.question ?? '').slice(0, 120), options: normOpts(q?.options) }))
        .filter(q => q.question && q.options.length >= 2)
      return qs.length > 0 ? { kind: 'exam', id, questions: qs.slice(0, 8) } : null
    }
    if (p && typeof p === 'object' && String((p as Record<string, unknown>).question ?? '') && Array.isArray((p as Record<string, unknown>).options) && ((p as Record<string, unknown>).options as unknown[]).length >= 2) {
      const o = p as Record<string, unknown>
      return { kind: 'single', id, question: String(o.question), options: normOpts(o.options), allowCustom: o.allowCustom !== false }
    }
    return null
  } catch { return null }
}

export interface PendingAsk {
  question: string
  source?: { type: string; relPath: string; page: number; excerpt: string }
}

export function AiTeachingModule({ isActive, zenLevel = 0, onZenLevelChange, pendingAsk = null, onConsumePendingAsk }: { isActive?: boolean; zenLevel?: number; onZenLevelChange?: (n: number) => void; pendingAsk?: PendingAsk | null; onConsumePendingAsk?: () => void }) {
  // 输入卡外壳（v3.4.0 反馈轮：与 AI 助手共用 inputShells，设置 → 外观统一切换）
  const shell = useInputShell()
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeTitle, setActiveTitle] = useState('')
  const [messages, setMessages] = useState<UiMsg[]>([])
  const [input, setInput] = useState('')
  /**
   * input 的实时镜像（v3.1.2 性能修复）。根因：`doSend` 若直接闭包 `input`，则**每次击键**它都换新引用
   * → `retryQuiz`（deps=[doSend]）跟着换 → 每条 AI 消息的 `MarkdownPreview`（`React.memo`）**浅比较失败
   * → 整段 Markdown 全量重解析**（实测长回答 17.8ms/条：katex 16.4 + highlight 7.5；10 条会话 ≈55ms/击键、
   * 20 条 ≈110ms）。改读 ref 后 `doSend` 与输入解耦 → `retryQuiz` 稳定 → memo 恢复生效。
   * 安全性：`doSend()` 只从**用户事件**（Enter / 发送按钮）调用，必然晚于上一次 render+effect，
   * 故 ref 一定是最新值；无「setInput(x) 后同步 doSend()」的踩空路径（三处调用要么传显式文本、要么现读）。
   */
  const inputValueRef = useRef('')
  useEffect(() => { inputValueRef.current = input }, [input])
  // v3.1.1 条目10：/ 弹层（指令 + 已装 Skill）、Skill 显式调用 chip、压缩进行时占位
  const [slashSkills, setSlashSkills] = useState<SkillInfo[]>([])
  const [slashActive, setSlashActive] = useState(0)
  const [pickedSkill, setPickedSkill] = useState<SkillInfo | null>(null)
  const [compressing, setCompressing] = useState(false)
  /** 划词引用片段列表（「问 AI」收进输入区上方引用胶囊，不自动发送；随消息一起发出后一次性消费） */
  const [quotes, setQuotes] = useState<string[]>([])
  const [quotesOpen, setQuotesOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [liveSteps, setLiveSteps] = useState<AgentTraceStep[]>([])
  const [lastChanges, setLastChanges] = useState<AgentChange[] | null>(null)
  // P3b（§3.8 第五轮 R12/R14）：本对话模型/思考强度覆盖（内存级，仅本对话生效）+ 整理成文档状态
  const convoLlm = useRef<Map<string, { modelId?: string; effort?: Effort }>>(new Map())
  const [convoModel, setConvoModel] = useState('')
  const [convoEffort, setConvoEffort] = useState<Effort>('off')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  /**
   * 视觉转写模型（素材转写用，与回答模型分开）：'' = 自动按模型名识别；格式 providerId:model。
   *
   * 单一真源是**设置键 aiTeachVisionModel**（2026-10-13 决策 D）。此前它只存在 localStorage 的
   * `aiTeach.visionModel`，是个隐藏设置 —— 设置页搜不到、也不随设置迁移（换电脑就丢）。
   * 现在设置入口在「设置 → AI → 教学」，这里与它是同一个键（老 localStorage 值按决策 E 退役）。
   */
  const [visionModel, setVisionModel] = useState('')
  const [visionList, setVisionList] = useState<LlmVisionModelInfo[]>([])
  const [showAllVision, setShowAllVision] = useState(false)
  const pickVision = (val: string): void => {
    setVisionModel(val)
    void setSettingRaw('aiTeachVisionModel', val)
  }
  // 读设置键（与「设置 → AI → 教学」同一真源）
  useEffect(() => {
    void getSettingRaw('aiTeachVisionModel').then(v => setVisionModel(String(v ?? ''))).catch(() => null)
  }, [])
  const [providerList, setProviderList] = useState<LlmProviderInfo[]>([])
  const [modelCapable, setModelCapable] = useState(false)
  const [organized, setOrganized] = useState<Record<string, string>>({})
  // P4（§3.7/3.9）：左栏 VS Code 多分区（折叠贴靠+状态记忆）+ 侧栏整体收放 + 中栏文档阅读视图（方案 B）
  const [collapsedSec, setCollapsedSec] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('aiTeach.sections.collapsed') || '{}') } catch { return {} } })
  const toggleSec = useCallback((k: string) => setCollapsedSec(prev => {
    const n = { ...prev, [k]: !prev[k] }
    localStorage.setItem('aiTeach.sections.collapsed', JSON.stringify(n))
    return n
  }), [])
  const [leftOpen, setLeftOpen] = useState(() => localStorage.getItem('aiTeach.leftOpen') !== '0')
  /** 资源管理器刷新（v3.2.0 条目④） */
  const [treeRefreshSeq, setTreeRefreshSeq] = useState(0)
  const [treeRefreshing, setTreeRefreshing] = useState(false)
  /** 左栏「会话」三层树：章的展开态（本地记忆，与分区折叠分开存） */
  const [collapsedChap, setCollapsedChap] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('aiTeach.rail.chapCollapsed') || '{}') } catch { return {} } })
  const toggleChap = useCallback((id: string) => setCollapsedChap(prev => {
    const n = { ...prev, [id]: !prev[id] }
    localStorage.setItem('aiTeach.rail.chapCollapsed', JSON.stringify(n))
    return n
  }), [])
  /** 左栏「零散对话」组展开态（3.14 已删除该组；保留 state 避免旧 localStorage 读取报错） */
  const [rightOpen, setRightOpen] = useState(() => localStorage.getItem('aiTeach.rightOpen') !== '0')
  /** 右栏可见态（v3.8.0 §二改：右栏 = 素材 / 支线 两分区；工件已是中栏右侧独立分栏）。
   *  rightOpen=用户意图态（持久），srcVisible=渲染态；openRail() 两态同步置 true */
  const [srcVisible, setSrcVisible] = useState(() => localStorage.getItem('aiTeach.rightOpen') !== '0')
  const toggleSide = (side: 'left' | 'right') => {
    if (side === 'left') { const v = !leftOpen; setLeftOpen(v); localStorage.setItem('aiTeach.leftOpen', v ? '1' : '0') }
    else { const v = !rightOpen; setRightOpen(v); localStorage.setItem('aiTeach.rightOpen', v ? '1' : '0'); setSrcVisible(v) }
  }
  /** 展开右栏（保持上次分区，只把面板拉出来——顶栏 chip / 贴边条专用） */
  const openRail = () => { setRightOpen(true); localStorage.setItem('aiTeach.rightOpen', '1'); setSrcVisible(true) }
  // Ctrl+B 切左侧栏 / Ctrl+Alt+B 切右侧栏（2026-09-08 用户反馈补齐，对齐 VS Code 侧栏习惯）。
  // 模块级快捷键：仅本模块激活时生效；焦点在输入控件内不拦截；deps 随开合状态刷新闭包
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.key.toLowerCase() !== 'b') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      if (e.altKey) { if (!srcVisible) openRail(); else toggleSide('right') } // 自动收起态下快捷键=展开（意图态已 true，翻转逻辑不适用）
      else toggleSide('left')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, leftOpen, rightOpen, srcVisible])
  const [aiTeachRoot, setAiTeachRoot] = useState('AI教学')
  // ---------- 工件栏（docs/ai-teaching-artifacts-pane-design.md §1.2/§2）----------
  // 对话固定左主区永不替换；md 阅读 / pptx 逐页 / visual.html 示意图全部收进右侧页签。
  // 页签列表=会话内存态（切会话清空）；栏宽持久化；开合无手动开关——有页签即出现、关完即消失
  //（2026-09-09 用户拍板：不设主动展开把手，避免与素材库右缘拉出条打架）；HTML 正文永不进对话流（工件卡唯一形态）。
  const [artTabs, setArtTabs] = useState<ArtTab[]>([])
  const [artActive, setArtActive] = useState<string | null>(null)
  /** v3.8.0 §二改：工件 = **中栏右侧的独立分栏**（与对话并排同屏）—— 面板实际宽度（ResizablePanel 上报），
   *  供工件内部按宽自适应（原先是右栏单面板的宽度上报） */
  const [artPaneW, setArtPaneW] = useState(0)
  /** v3.8.0：工件分栏开关（用户意图态，持久）。列可见 = `artTabs` 非空 && `artOpen` ——
   *  拖到最窄（ResizablePanel snap-close）或点顶栏「工件」chip 即隐藏分栏，页签不丢（再点即回） */
  const [artOpen, setArtOpen] = useState(() => localStorage.getItem('aiTeach.artOpen') !== '0')
  const applyArtOpen = useCallback((v: boolean) => {
    setArtOpen(v)
    try { localStorage.setItem('aiTeach.artOpen', v ? '1' : '0') } catch { /* ignore */ }
  }, [])
  /** html 页签 ⟳ 刷新计数（key 版本，ArtHtmlView 重读磁盘） */
  const [htmlSeq, setHtmlSeq] = useState<Record<string, number>>({})
  /** ⤢ 原位放大：工件栏占满内容区（absolute 盖过对话/左右栏，组件不卸载 → 对话滚动与 iframe 全存活），⤡/Esc 退出 */
  const [artZoom, setArtZoom] = useState(false)
  useEffect(() => { if (artTabs.length === 0) setArtZoom(false) }, [artTabs.length])
  const artTabsRef = useRef<ArtTab[]>([])
  useEffect(() => { artTabsRef.current = artTabs }, [artTabs])
  /** 开/复用页签（同 id 原地合并更新）并激活 */
  const openArtTab = useCallback((tab: ArtTab) => {
    setArtTabs(prev => {
      const i = prev.findIndex(t => t.id === tab.id)
      if (i < 0) return [...prev, tab]
      const n = [...prev]
      n[i] = { ...n[i], ...tab }
      return n
    })
    setArtActive(tab.id)
    // v3.8.0：打开工件即展开工件分栏（不依赖 artExpanded 的 0→1 边沿）
    applyArtOpen(true)
  }, [applyArtOpen])
  const closeArtTab = useCallback((id: string) => {
    const prev = artTabsRef.current
    const i = prev.findIndex(t => t.id === id)
    if (i < 0 || prev[i].generating) return
    const next = prev[i + 1] ?? prev[i - 1] ?? null
    setArtTabs(prev.filter(t => t.id !== id))
    setArtActive(cur => (cur === id ? next?.id ?? null : cur))
  }, [])
  /** 统一打开入口：pptx→逐页页签；html→沙箱预览页签；其余按 md 阅读页签 */
  const openArtFile = useCallback(async (rel: string, opts?: { name?: string; title?: string; lines?: number; cur?: number }) => {
    if (/\.pptx$/i.test(rel)) {
      const pr = await docsPptxPages(rel).catch(() => null)
      if (pr?.ok && pr.pages?.length) {
        openArtTab({ id: rel, kind: 'pptx', rel, name: opts?.name ?? rel.split('/').pop() ?? rel, pages: pr.pages, cur: Math.min(Math.max(0, opts?.cur ?? 0), pr.pages.length - 1) })
      } else {
        showToast({ type: 'error', message: (pr as { error?: string } | null)?.error || '读取失败（暂仅支持 .pptx）' })
      }
      return
    }
    if (/\.html?$/i.test(rel)) {
      openArtTab({ id: rel, kind: 'html', rel, name: opts?.title || opts?.name || rel.split('/').pop() || rel, title: opts?.title, lines: opts?.lines })
      return
    }
    // 生图产物（v3.6.0 阶段二）：png/jpg… → 图片页签（批 3 查看器）。
    // ★ 必须排在下面那条"读文本 → md 页签"的兜底**之前**：图片按文本读只会得到一段乱码，
    //   而且不报错 —— 表象是「点开产物页签里是一堆黑菱形」
    if (isRenderableImagePath(rel)) {
      openArtTab({ id: rel, kind: 'image', rel, name: opts?.name ?? opts?.title ?? rel.split('/').pop() ?? rel, title: opts?.title })
      return
    }
    const cur = await workspaceGetCurrent().catch(() => null)
    const rootId = (cur as { rootId?: string } | null)?.rootId
    if (!rootId) { showToast({ type: 'error', message: '尚未打开仓库' }); return }
    const r = await workspaceReadFile(rootId, rel).catch(() => null)
    if (!r || typeof r.content !== 'string') { showToast({ type: 'error', message: '读取文档失败' }); return }
    // 思维导图 JSON：按内容识别（kind:"mindmap"）→ 导图页签；其余按 md 阅读页签
    if (looksLikeMindMap(r.content)) {
      openArtTab({ id: rel, kind: 'mindmap', rel, name: opts?.title || opts?.name || rel.split('/').pop() || rel, title: opts?.title })
      return
    }
    openArtTab({ id: rel, kind: 'md', rel, name: opts?.name ?? rel.split('/').pop() ?? rel, content: r.content })
  }, [openArtTab])
  const reloadArtTab = useCallback((tab: ArtTab) => {
    if (tab.kind === 'html') { setHtmlSeq(prev => ({ ...prev, [tab.rel]: (prev[tab.rel] ?? 0) + 1 })); return }
    void openArtFile(tab.rel, { name: tab.name, title: tab.title })
  }, [openArtFile])
  useEffect(() => { void getSettingRaw('aiTeachRootDir').then(v => { const s = String(v ?? '').trim(); if (s) setAiTeachRoot(s) }).catch(() => {}) }, [])
  // / 弹层 Skill 组候选（v3.1.1 条目10）：模块挂载时拉一次（安装/停用在设置页，低频变化）
  useEffect(() => { aiToolsListSkills().then(r => setSlashSkills(r.skills)).catch(() => setSlashSkills([])) }, [])

  // ---------- P5 工作区两层（§3.2-6；3-6/3-8 按建议：元数据入仓库 .knowbase、跟随当前激活仓库） ----------
  const [wsList, setWsList] = useState<AiTeachWorkspaceInfo[]>([])
  const [wsSessionMap, setWsSessionMap] = useState<Record<string, string>>({})
  const [lastWsId, setLastWsId] = useState<string | null>(null)
  const [activeWs, setActiveWs] = useState<string | null>(null) // null = 工作区选择页（3-38：默认记住上次直接进，仅首次/无记忆时可见）
  const activeWsRef = useRef<string | null>(null)
  useEffect(() => { activeWsRef.current = activeWs }, [activeWs])
  const wsMapRef = useRef<Record<string, string>>({})
  useEffect(() => { wsMapRef.current = wsSessionMap }, [wsSessionMap])
  const [wsSearch, setWsSearch] = useState('')
  const [wsSwitcherOpen, setWsSwitcherOpen] = useState(false)
  const [wsModal, setWsModal] = useState<{ mode: 'create' | 'rename'; id?: string; value: string } | null>(null)
  const refreshWorkspaces = useCallback(async () => {
    const r = await aiTeachListWorkspaces().catch(() => null)
    if (!r) return
    setWsList(r.workspaces); setWsSessionMap(r.sessionWs); setLastWsId(r.lastWorkspaceId)
  }, [])
  useEffect(() => { void refreshWorkspaces() }, [refreshWorkspaces])
  // ---------- 课程（3.14：课程 = 工作区；章 → 知识点；段）----------
  const [courseState, setCourseState] = useState<AiTeachCourseState | null>(null)
  const courseStateRef = useRef<AiTeachCourseState | null>(null)
  useEffect(() => { courseStateRef.current = courseState }, [courseState])
  /** 课程助手会话 id（整门课唯一；打开课程助手时指向它） */
  const [assistantSid, setAssistantSid] = useState<string | null>(null)
  /** 当前段会话 id（null = 不在段里） */
  const [activeSegmentSid, setActiveSegmentSid] = useState<string | null>(null)
  /** 当前段内聚焦知识点 */
  const [activeUnitId, setActiveUnitId] = useState<string | null>(null)
  /** 当前段状态：ended → 只读 */
  const [segmentStatus, setSegmentStatus] = useState<'open' | 'ended'>('open')
  /** 当前打开的章末复习课所属章 id（null = 不在复习课） */
  const [courseReviewChapter, setCourseReviewChapter] = useState<string | null>(null)
  /** 开段预检：{ 章 id, 被点的知识点, 上一段交接 } */
  const [preflight, setPreflight] = useState<{ chapterId: string; unitId: string; prevHandoff: string } | null>(null)
  const [preflightBusy, setPreflightBusy] = useState(false)
  /** 右栏素材按需加载（getSources 不随 courseState 每轮拉） */
  const [sourcePayload, setSourcePayload] = useState<AiTeachSourcesPayload | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [railSearch, setRailSearch] = useState('')
  /** 当前章（左栏展开 / 右栏素材归属） */
  const [activeChapterState, setActiveChapterState] = useState<string | null>(null)
  /** 要求抽屉 */
  const [reqOpen, setReqOpen] = useState(false)
  const [reqLayer, setReqLayer] = useState<ReqLayer>('workspace')
  /** 上段交接内容（界面条） */
  const [prevHandoff, setPrevHandoff] = useState('')
  const [handoffOpen, setHandoffOpen] = useState(true)
  const courseEnabled = !!activeWs && activeWs !== '__none__'
  const courseReadonly = !!activeSegmentSid && activeId === activeSegmentSid && segmentStatus === 'ended'
  const courseUnits = useMemo(() => (courseState?.outline?.chapters ?? []).flatMap(c => c.units), [courseState])
  /** L4 引用网络：知识点名（归一化） → 最近已收尾段 / 旧总结篇（跳转 chip 点击打开） */
  const courseJumpByName = useMemo(() => {
    const m = new Map<string, { sid?: string; rel?: string }>()
    for (const c of courseState?.outline?.chapters ?? []) for (const u of c.units) {
      const hit = latestEndedSegmentOfUnit(courseState?.lessons, u.id)
      const rel = courseState?.progress[u.id]?.summaryRel
      if (hit?.sessionId) m.set(normName(u.name), { sid: hit.sessionId })
      else if (rel) m.set(normName(u.name), { rel })
    }
    return m
  }, [courseState])
  const reloadCourse = useCallback(async () => {
    const ws = activeWsRef.current
    if (!ws || ws === '__none__') { setCourseState(null); return }
    const s = await aiTeachCourseGetState(ws).catch(() => null)
    courseStateRef.current = s ?? null
    setCourseState(s ?? null)
  }, [])
  const reloadSources = useCallback(async () => {
    const ws = activeWsRef.current
    if (!ws || ws === '__none__') { setSourcePayload(null); return }
    setSourceLoading(true)
    const s = await aiTeachCourseGetState(ws).catch(() => null)
    if (s) { courseStateRef.current = s; setCourseState(s) }
    const r = await aiTeachCourseGetSources(ws).catch(() => null)
    setSourcePayload(r ?? null)
    setSourceLoading(false)
  }, [])
  useEffect(() => {
    if (activeWs && activeWs !== '__none__') return
    setActiveSegmentSid(null); setActiveUnitId(null); setSegmentStatus('open'); setCourseReviewChapter(null)
    setAssistantSid(null); setPreflight(null); setSourcePayload(null); setRailSearch('')
    setActiveChapterState(null)
    courseStateRef.current = null
    setCourseState(null)
  }, [activeWs])
  useEffect(() => {
    const off = onAiTeachCourseRefresh((p) => { if (p.wsId === activeWsRef.current) { void reloadCourse(); if (sourcePayload) void reloadSources() } })
    return off
  }, [reloadCourse, reloadSources, sourcePayload])
  // 上段交接：当前会话 = 段时读取，展示为可折叠交接条
  useEffect(() => {
    const sid = activeId
    const lesson = sid ? courseState?.lessons[sid] : null
    if (!lesson || !sid) { setPrevHandoff(''); return }
    let alive = true
    aiTeachCourseReadPrevHandoff(sid)
      .then((r) => { if (alive) { setPrevHandoff(r?.ok ? (r.text ?? '') : ''); setHandoffOpen(true) } })
      .catch(() => { if (alive) setPrevHandoff('') })
    return () => { alive = false }
  }, [activeId, courseState?.lessons])
  const wsActive = activeWs && activeWs !== '__none__' ? wsList.find(w => w.id === activeWs) ?? null : null
  const wsTreeSeg = (() => {
    if (!wsActive) return ''
    const p = `${aiTeachRoot}/`
    return wsActive.folderRel.startsWith(p) ? wsActive.folderRel.slice(p.length) : wsActive.folderRel
  })()
  const treeBase = wsTreeSeg ? `${aiTeachRoot}/${wsTreeSeg}` : aiTeachRoot
  /**
   * 性能（v3.1.2）：左栏文件树 / 工件栏的打开回调**提到 useCallback**——它们原来是调用点的内联箭头，
   * 每次渲染都是新引用，会让下面两个子组件的 `React.memo` 恒失效（输入框击键时整棵树/工件栏白重渲染）。
   * 依赖仅为 `treeBase`（字符串，按值稳定）与 `openArtFile`（useCallback）。
   */
  const treeOpenArt = useCallback((rel: string) => { void openArtFile(`${treeBase}/${rel}`) }, [openArtFile, treeBase])
  const treeOpenExternal = useCallback((rel: string) => {
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: `${treeBase}/${rel}`, from: 'aiTeaching' } }))
  }, [treeBase])
  const artOpenInEditor = useCallback((rel: string) => {
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: rel, from: 'aiTeaching' } }))
  }, [])
  /** 导图节点 ref 点击 → 在工件栏开该笔记页签（左聊右看，不跳模块） */
  const artOpenRef = useCallback((rel: string) => { void openArtFile(rel) }, [openArtFile])
  const wsSessions = useMemo(
    () => sessions.filter(s => (wsSessionMap[s.id] ?? '__none__') === (activeWs ?? '__none__')),
    [sessions, wsSessionMap, activeWs],
  )
  /**
   * v3.1.2 条目11 P4：**已升格支线**（lane==='main' 且带 parentSessionId）跟随父行缩进。
   * 支线本身不分配工作区，故从**全量** sessions 里按父行归属；父行不在当前工作区视图时不出现（旧行为）。
   */
  /** 左栏课程树数据（章 → 知识点 → 复习状态；不再有会话行） */
  const railChapters: RailChapterInput[] = useMemo(() => (courseState?.outline?.chapters ?? []).map((c) => {
    const ids = c.units.map((u) => u.id)
    const review = reviewState(c.id, ids, courseState?.progress ?? {}, courseState?.lessons ?? {}, courseState?.reviews ?? {})
    const activeIds = activeSegmentSid && courseState?.lessons[activeSegmentSid]?.status === 'open' ? lessonUnitIds(courseState?.lessons[activeSegmentSid]) : []
    return {
      id: c.id,
      name: c.name,
      review,
      units: c.units.map((u) => ({
        id: u.id,
        name: u.name,
        learned: unitLearned(u.id, courseState?.progress, courseState?.lessons),
        active: activeUnitId === u.id && !!activeSegmentSid && activeIds.includes(u.id),
        inSegment: activeIds.includes(u.id),
      })),
    }
  }), [courseState, activeSegmentSid, activeUnitId])
  const railVisible = useMemo(() => buildCourseRail(railChapters, railSearch), [railChapters, railSearch])
  const railActiveChapter = useMemo(() => pickRailChapter(railChapters, activeChapterState), [railChapters, activeChapterState])
  const activeSegment = activeSegmentSid ? courseState?.lessons[activeSegmentSid] ?? null : null
  const preflightChapter = preflight ? courseState?.outline?.chapters.find((c) => c.id === preflight.chapterId) ?? null : null
  const preflightUnits = useMemo(() => (preflightChapter?.units ?? []).map((u) => ({
    id: u.id, name: u.name, learned: unitLearned(u.id, courseState?.progress, courseState?.lessons),
  })), [preflightChapter, courseState])
  const preflightAssignments = preflight ? sourcePayload?.assignments[preflight.chapterId] ?? [] : []
  const preflightSources = sourcePayload?.sources ?? []
  // ---- Token 消耗统计（月度走 llm:getUsage）----
  const [usage, setUsage] = useState<LlmUsageInfo | null>(null)
  const [defaultModel, setDefaultModel] = useState('')
  const [tokenOpen, setTokenOpen] = useState(false)
  // UI 优化条目9③：输入区用量指示档位（off/compact/detailed）+ 上下文窗口（圆环分母，0=退化纯数字）
  const [usageDetail, setUsageDetail] = useState<'off' | 'compact' | 'detailed'>('compact')
  const [ctxWindow, setCtxWindow] = useState(0)
  // UI 优化条目9②：本轮 system 注入分段（按会话存，主进程随结果回传；用于构成摘要）
  const [injectionMap, setInjectionMap] = useState<Record<string, AiTeachInjectionStats>>({})
  const readUsageSettings = useCallback(() => {
    void getSettingRaw('ctxUsageDetail').then(v => { const s = String(v ?? 'compact'); setUsageDetail(s === 'off' || s === 'detailed' ? s : 'compact') }).catch(() => null)
    void getSettingRaw('ctxWindow').then(v => setCtxWindow(Math.max(0, Math.floor(Number(v) || 0)))).catch(() => null)
  }, [])
  useEffect(() => { readUsageSettings() }, [readUsageSettings])
  useEffect(() => { if (isActive) readUsageSettings() }, [isActive, readUsageSettings])
  useEffect(() => {
    void llmGetUsage().then(setUsage).catch(() => null)
    void getSettingRaw('defaultChatModel').then(v => setDefaultModel(String(v ?? ''))).catch(() => {})
  }, [])
  // P1：主进程侧不可静默的提示（根目录改名迁移失败/目标占用等）
  useEffect(() => onAiTeachNotice((msg) => { if (msg) showToast({ type: 'warning', message: msg }) }), [])
  // 会话级全局要求（P2 §2.3：唯一真相源=会话文件夹 CONSTRAINTS.md；DB 字段仅旧会话读兼容）
  const [activeInstr, setActiveInstr] = useState('')
  const [instrRel, setInstrRel] = useState('')
  const [instrOpen, setInstrOpen] = useState(false)
  const [instrDraft, setInstrDraft] = useState('')
  const [instrDismiss, setInstrDismiss] = useState(false)
  // 3.14 右栏：进度 / 素材 / 支线；默认进度
  const [railTab, setRailTab] = useState<'progress' | 'sources' | 'lanes'>(() => {
    const v = localStorage.getItem('aiTeach.railTab')
    return v === 'sources' ? 'sources' : v === 'lanes' ? 'lanes' : 'progress'
  })
  // 记住上次分区选择（默认进度）
  useEffect(() => { try { localStorage.setItem('aiTeach.railTab', railTab) } catch { /* ignore */ } }, [railTab])
  useEffect(() => {
    if (!railActiveChapter) return
    setCollapsedChap(prev => {
      let changed = false
      const n = { ...prev }
      for (const c of railChapters) {
        if (n[c.id] === undefined) { n[c.id] = c.id !== railActiveChapter; changed = true }
      }
      if (n[railActiveChapter] !== false) { n[railActiveChapter] = false; changed = true }
      if (!changed) return prev
      try { localStorage.setItem('aiTeach.rail.chapCollapsed', JSON.stringify(n)) } catch { /* ignore */ }
      return n
    })
  }, [railActiveChapter, railChapters])
  /** 当前会话的支线清单（含派生字段）：右栏中心 / 计数 / 锚点 chip 映射共用。数据源=会话库（不再靠 localStorage） */
  const [laneInfos, setLaneInfos] = useState<AgentSideLaneInfo[]>([])
  /** 右栏「浮出」的支线（3.14 保留；简单浮层，不做拖拽） */
  const [floatLane, setFloatLane] = useState<{ laneId: string; anchorMessageId: string; title: string } | null>(null)
  /** 打开右栏支线中心的请求（锚点 chip 触发；中心按 requestSeq 重新响应） */
  const [centerReq, setCenterReq] = useState<{ kind: 'open'; laneId: string } | { kind: 'create'; anchorMessageId: string } | null>(null)
  const [centerSeq, setCenterSeq] = useState(0)
  const refreshLanes = useCallback(async () => {
    const sid = activeIdRef.current
    if (!sid) { setLaneInfos([]); return }
    const rows = await agentListSideLanes(sid).catch(() => [] as AgentSideLaneInfo[])
    setLaneInfos(rows.filter(r => r.lane !== 'main')) // 已升格的从左栏看，右栏移除
  }, [])
  /** 锚点回答 → 支线映射：由会话库派生（branchFromMessageId），回答下方 chip 据此显示「已开 / 就这点追问」 */
  const anchorLanes = useMemo(() => {
    const m: Record<string, { laneId: string; laneTitle: string }> = {}
    for (const l of laneInfos) if (l.branchFromMessageId) m[l.branchFromMessageId] = { laneId: l.id, laneTitle: l.title }
    return m
  }, [laneInfos])
  /** 打开右栏支线中心（锚点 chip 用）：确保右栏可见并切到「支线」分区 */
  const openCenter = useCallback((req: { kind: 'open'; laneId: string } | { kind: 'create'; anchorMessageId: string }) => {
    openRail()               // 先展开右栏…
    setRailTab('lanes')      // …再切到支线分区（批量更新，以最后一次为准）
    setCenterReq(req); setCenterSeq(s => s + 1)
  }, [openRail])
  // PPT 逐页阅读已并入工件栏 pptx 页签（工件栏方案 §1.4，原 reader 中栏互斥态退役）
  // UI 优化条目6B：中栏导航状态（视图 / 工件栏激活页签）随变化落到本会话持久化键
  useEffect(() => {
    if (!activeId) return
    const t = artTabs.find(x => x.id === artActive)
    writeNav(activeId, {
      // docRel = 「可原地重开的阅读类页签」：md / html / image
      docRel: t && !t.generating && (t.kind === 'md' || t.kind === 'html' || t.kind === 'image') ? t.rel : null,
      readerRel: t && !t.generating && t.kind === 'pptx' ? t.rel : null,
      readerPage: t && t.kind === 'pptx' ? t.cur ?? 0 : 0,
    })
  }, [activeId, artTabs, artActive])
  const [activeIdRef, chatIdRef] = [useRef<string | null>(null), useRef('')]
  /** 当前 messages 归属的会话 id（refreshMessages 里更新）——把「随会话」的 UI（```ask 提问卡等）
   *  严格绑到 activeId：切会话是「先换 activeId、再异步拉 messages」，空窗里旧会话的卡片会串到新会话。 */
  const messagesSidRef = useRef<string | null>(null)
  // v3.2.0 条目6：原先这里还有个 `bottomRef` 死锚点（定义了、也渲染了，全仓无人读取）——
  // 它就是「滚底实现丢了」的物证。本条改用直接赋值 `scrollTop = scrollHeight`（同 MessageList 范式、
  // 与 rules 1/2 的写法一致），不再需要锚点元素，故连同其渲染点一并移除。

  /** 输入区（划词「问 AI」就地追问时聚焦用） */
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** 引用片段的 ref 镜像——sendText 是 useCallback，读 ref 避免闭包捕获旧值 */
  const quotesRef = useRef<string[]>([])
  // P3a 快速定位条：消息滚动容器 + 当前锚点高亮
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 对话流滚动记忆（**按会话 id**，2026-10-10 重做）：跳文档阅读视图 / 切视图（上课 ⇄ 课程助手）
   *  都会换 activeId 或卸载容器；旧的单一 ref 在每次切会话时被归零 → 切回上课就跑到顶部。
   *  改为 Map<sid, scrollTop>：每个会话各自记忆，回切恢复原位置（对齐 docScrollPos 模式）。 */
  const convScroll = useRef<Map<string, number>>(new Map())
  /**
   * 贴底跟随（v3.2.0 条目 6）：距底 < 48px 视为「贴底」，只有贴底时内容增长才跟随滚到底。
   * 初始 true：新会话从底部开始。范式对齐 `src/components/shared/AssistantPanel/MessageList.tsx`。
   */
  const stickRef = useRef(true)
  /** 不贴底时显示「回到底部」浮标 */
  const [jumpBottom, setJumpBottom] = useState(false)
  const [activeAnchor, setActiveAnchor] = useState(0)
  const liveRef = useRef(liveSteps)
  /**
   * 贴底 + 滚到底（instant）——**条目 6 的「强制滚底」只有这一份实现**：
   * 规则 1（发送，无条件）与规则 3（浮标点击）都走它；规则 2（内容增长）走下面那个只贴底才生效的 effect。
   * instant 而非 smooth：流式下 effect 每 ~60ms 触发一次，smooth 动画会与下一次调用互相打断，表现为滚动抽搐
   * （同 `src/components/shared/AssistantPanel/MessageList.tsx` 已记录的坑）。
   * 末尾补一帧 rAF：发送路径调用时乐观消息可能尚未提交 DOM，同步读到的 scrollHeight 会少最后一条的高度。
   */
  const jumpToBottom = useCallback(() => {
    stickRef.current = true
    setJumpBottom(false)
    const c = scrollRef.current
    if (c) { c.scrollTop = c.scrollHeight; if (activeIdRef.current) convScroll.current.set(activeIdRef.current, c.scrollHeight) }
    requestAnimationFrame(() => { const c2 = scrollRef.current; if (c2) { c2.scrollTop = c2.scrollHeight; if (activeIdRef.current) convScroll.current.set(activeIdRef.current, c2.scrollHeight) } })
  }, [])

  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  useEffect(() => { liveRef.current = liveSteps }, [liveSteps])

  // 划词「问 AI」就地接管：提问落进本模块「当前对话」往后答，而不是弹出侧边栏另开一个对话。
  // 无当前对话时不接管（accept=false）→ 回退侧边栏行为，用户始终有路可走。
  useEffect(() => {
    if (!isActive) return
    return registerSelectionAskHost({
      accept: () => !!activeIdRef.current,
      ask: (text) => {
        // 引用形式（不自动发送）：收进输入区上方引用胶囊，多条可累积，随用户消息一起发出
        setQuotes(prev => {
          const next = prev.includes(text) ? prev : [...prev, text].slice(-5)
          quotesRef.current = next
          return next
        })
        setQuotesOpen(true)
        setTimeout(() => inputRef.current?.focus(), 60)
      },
    })
  }, [isActive])

  // ---- 禅模式（本模块只**消费**档位，不再持有入口）----
  // 入口统一在命令面板「布局：禅模式」（App 层 zenLevel 单一真相源，全模块可用），本模块只读档位用于
  // 收起自身顶栏/侧栏。Esc 的「先关本模块浮层，再退禅」统一放在 askVisible/srcForm 等浮层 state 声明之后
  // （见 §P8 画像小节），这里只保留 zenActive（若在此处引用后文声明的 srcForm/askVisible 会触发 TDZ 报错
  // → 整模块崩溃）。
  const zenActive = zenLevel >= 1 && !!onZenLevelChange

  // P2（§2.3/2-6）：会话约束读取——文件唯一真相源；无文件夹的旧会话读兼容回退 DB 字段一次
  const loadConstraints = useCallback(async (sid: string, dbFallback: string): Promise<void> => {
    const r = await aiTeachReadConstraints(sid).catch(() => null)
    const text = r && r.ok ? (r.relPath ? (r.text ?? '').trim() : dbFallback) : dbFallback
    if (activeIdRef.current === sid) { setActiveInstr(text); setInstrRel(r?.relPath ?? '') }
  }, [])

  const refreshSessions = useCallback(async () => {
    // 只保留 AI 教学来源的会话：助手侧栏 / AI 学堂 / 日程助手都有自己的列表（同表存储，按 source 分流）。
    // ★ 2026-10-13（F-8）：原来是排除法（`!== 'assistant'`）—— `schedule` 行也满足它，
    //   于是日程助手的会话会在「无工作区」桶里混进教学左栏。改成白名单，与 useAssistantChat 同一口径。
    // v3.1.2 条目11：未升格的支线（lane='side'）不进主列表——它们只活在浮层/宽轨里；
    // 升格后 lane='main'，随主线行缩进显示（见 promoted / railTree，2026-10-16 起按课程三层树归位）。
    const list = (await agentSessions().catch(() => []))
      .filter(s => s.source === 'aiTeaching' && !(s.parentSessionId && s.lane === 'side'))
    setSessions(list)
    // 3.14：左栏不再自动打开任意会话（旧零散会话不可达）；只同步当前会话标题，切段/助手/复习由显式动作驱动
    const cur = activeIdRef.current ? list.find(s => s.id === activeIdRef.current) : undefined
    if (cur) setActiveTitle(cur.title)
    else if (!activeWsRef.current) {
      setActiveId(null)
      setActiveInstr(''); setInstrRel('')
    }
  }, [loadConstraints])

  /** 右栏支线中心「引用到主线」：把支线末条 AI 回答作为引用胶囊放进主线输入框（不自动发送） */
  const quoteFromLane = useCallback((text: string) => {
    const t = text.trim()
    if (!t) { showToast({ type: 'warning', message: '这条支线还没有可引用的回答' }); return }
    setQuotes(prev => { const next = prev.includes(t) ? prev : [...prev, t].slice(-5); quotesRef.current = next; return next })
    setQuotesOpen(true)
    setTimeout(() => inputRef.current?.focus(), 60)
    showToast({ type: 'info', message: '已引用到主线输入框（未发送，可继续编辑）' })
  }, [])

  /** 右栏支线中心「浮出」：在模块内开一个浮层（同一支线） */
  const floatFromCenter = useCallback((laneId: string) => {
    const info = laneInfos.find((l) => l.id === laneId)
    if (!info) { showToast({ type: 'warning', message: '支线信息还没加载完' }); return }
    setFloatLane({ laneId, anchorMessageId: info.branchFromMessageId ?? '', title: info.title })
  }, [laneInfos])

  /** v3.2.0 第 19 项：返回消息条数——`openSession` 用它校正「准备态」判据（快照说未开讲、但会话已有消息）。 */
  const refreshMessages = useCallback(async (sid: string): Promise<number> => {
    const rows = await agentMessages(sid).catch(() => [] as AgentStoredMessage[])
    messagesSidRef.current = sid
    setMessages(rows.map(m => ({
      id: m.id, role: m.role, content: m.content, createdAt: m.createdAt,
      trace: m.traceJson ? (() => { try { return JSON.parse(m.traceJson) as AgentTraceStep[] } catch { return undefined } })() : undefined,
    })))
    return rows.length
  }, [])

  // 打开 AI教学 Tab 时同步会话
  useEffect(() => { void refreshSessions() }, [refreshSessions, isActive])
  // 支线清单随当前会话 / 激活态刷新（右栏中心 / 锚点 chip / 计数）
  useEffect(() => { void refreshLanes() }, [activeId, refreshLanes, isActive])
  // P1 重命名会话（双击列表行）：agentRenameSession + 文件夹同步改名
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  // 流式过程（思考链 / 工具时间线 / 正文增量）：与侧栏共用同一 hook（docs/ai-streaming-design.md §5.3.5）。
  // liveSteps 仍由下方 onAgentStep 订阅维护（本模块还要做工件栏占位页签联动，不合并）。
  const { draft: streamDraft, begin: beginStream, end: endStream } = useAgentStream(chatIdRef)

  // 实时步骤（agent:step，按 chatId 过滤）。工件栏方案 §3.4 生成时序：
  // ① visual.html 带 args 的「生成中」事件 → 工件栏同步开占位页签（禁止关闭，即时反馈）；
  // ② 带 artifact 的成功事件 → 占位原地换正式页签 + toast（对话流工件卡随消息落库自动出现）。
  useEffect(() => {
    return onAgentStep(({ chatId, step }) => {
      if (chatId !== chatIdRef.current) return
      setLiveSteps(prev => [...prev.slice(-29), step])
      const isProduct = step.name === 'visual.html' || step.name === 'mindmap' || step.name === 'image'
      if (isProduct && step.args && !step.artifact) {
        const slug = String(step.args.slug ?? '')
        if (step.name === 'image') {
          // 生图（v3.6.0 阶段二）：slug 是**可选**参数（方案 §12 D3），占位键回落 'image' ——
          // 必须与下面完成事件用**同一条**回落规则，否则空 slug 时占位页签永远匹配不上，
          // 屏幕上就留一个卡死的「生成中…」（禁关页签）
          const key = slug || 'image'
          setArtTabs(prev => [...prev.filter(t => !(t.generating && t.slug === key)),
            { id: `gen:${key}`, kind: 'image', rel: '', name: '生成中…', generating: true, slug: key, title: String(step.args?.prompt ?? '').slice(0, 80) || '生成的图片' }])
          setArtActive(`gen:${key}`)
        } else {
          const isMind = step.name === 'mindmap'
          const title = String(step.args.title ?? '') || (isMind ? '思维导图' : '示意图')
          setArtTabs(prev => [...prev.filter(t => !(t.generating && t.slug === slug)),
            { id: `gen:${slug || title}`, kind: isMind ? 'mindmap' : 'html', rel: '', name: '生成中…', generating: true, slug, title }])
          setArtActive(`gen:${slug || title}`)
        }
      }
      if (step.artifact && step.ok) {
        const a = step.artifact
        if (!a.rel) return
        // 生图产物（v3.6.0 阶段二，方案 §6.2）：占位原地转正式页签，键与上面同一条回落规则。
        // 页签名取文件名（页签条只有 170px，prompt 会被截成一串省略号），prompt 留作 title 悬浮提示。
        if (a.kind === 'image') {
          const key = a.slug || 'image'
          setArtTabs(prev => {
            const rest = prev.filter(t => !(t.generating && t.slug === key))
            return rest.some(t => t.id === a.rel) ? rest
              : [...rest, { id: a.rel, kind: 'image', rel: a.rel, name: a.rel.split('/').pop() || '图片', title: a.title, w: a.w, h: a.h, bytes: a.bytes }]
          })
          setArtActive(cur => cur === `gen:${key}` ? a.rel : cur)
          showToast({ type: 'info', message: `✓ 图片已生成：${a.rel.split('/').pop()}（会话 outputs/ 目录）` })
          return
        }
        const kind = a.kind ?? 'html'
        setArtTabs(prev => {
          const rest = prev.filter(t => !(t.generating && a.slug && t.slug === a.slug))
          return rest.some(t => t.id === a.rel) ? rest : [...rest, { id: a.rel, kind, rel: a.rel, name: a.title || a.rel.split('/').pop() || a.rel, title: a.title, lines: a.lines }]
        })
        setArtActive(cur => cur === `gen:${a.slug}` ? a.rel : cur)
        showToast({ type: 'info', message: kind === 'mindmap'
          ? `✓ 思维导图已生成：${a.rel.split('/').pop()}（${a.nodes ?? 0} 节点）`
          : `✓ 示意图已生成：${a.rel.split('/').pop()}（${a.lines} 行）` })
      }
      // 工具失败：清掉「生成中」占位页签（禁关页签不能因失败卡死）；停止生成同理（setPending(false) 处兜底）
      if (isProduct && !step.ok && !step.artifact) {
        setArtTabs(prev => prev.filter(t => !t.generating))
        setArtActive(cur => cur?.startsWith('gen:') ? null : cur)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换会话（段 / 复习 / 助手 / 旧会话）
  const openSession = useCallback(async (sid: string, title: string) => {
    setActiveId(sid); setActiveTitle(title); setLastChanges(null); setLiveSteps([])
    quotesRef.current = []; setQuotes([]); setQuotesOpen(false) // 引用片段属于发起时那个对话，切会话即失效
    setArtTabs([]); setArtActive(null) // 工件栏页签=会话内存态：切会话清空（阅读位置记忆保留在页签组件内）
    setPreflight(null)
    const row = sessions.find(s => s.id === sid)
    setInstrDismiss(false)
    void loadConstraints(sid, row?.instructions ?? '')
    await refreshMessages(sid)
    const nav = readNav(sid)
    // UI 优化条目6B：恢复该会话「上次离开时的工件」（页签在则栏在——内容驱动，无手动开合）
    if (nav.docRel) void openArtFile(nav.docRel)
    else if (nav.readerRel && /\.pptx$/i.test(nav.readerRel)) void openArtFile(nav.readerRel, { cur: nav.readerPage ?? 0 })
  }, [refreshMessages, sessions, loadConstraints, openArtFile])

  const sendText = useCallback(async (raw: string, cid: string, withQuote = false, skillName?: string): Promise<AgentChatResult | null> => {
    setPending(true); setLiveSteps([]); beginStream()
    const sid = activeIdRef.current
    if (!sid) { setPending(false); return null }
    // 划词引用片段：仅「输入框发送」路径消费（withQuote），避免逐页讲解/模板等命令误带上无关引用。
    // 会话引用形式：引用以可见的 markdown 引用块并入消息正文（对话回看时来源可查），
    // 不再走不可见的 selectionContext 注入；单条截断 600 字防刷屏
    const qs = withQuote ? [...quotesRef.current] : []
    if (qs.length > 0) { quotesRef.current = []; setQuotes([]); setQuotesOpen(false) }
    const text = qs.length > 0
      ? qs.map((q, i) => `> 【引用 ${i + 1}】${q.replace(/\s+/g, ' ').trim().slice(0, 600)}${q.replace(/\s+/g, ' ').trim().length > 600 ? '…' : ''}`).join('\n') + `\n\n${raw}`
      : raw
    setMessages(prev => [...prev, { role: 'user', content: text, createdAt: new Date().toISOString() }]) // 条目4：乐观时间存 ISO（原纯时刻串必 Invalid Date）
    // v3.2.0 条目6 规则1：**发送 = 无条件滚到底**（与规则3「上滚不打断」刻意不对称，对标 ChatGPT：
    // 刚发出消息本就该看到它，哪怕之前正在上方阅读）。共用 jumpToBottom 一份实现，见其定义处注释。
    jumpToBottom()
    const ov = convoLlm.current.get(sid)
    const r = await agentChat(sid, text, undefined, cid, 'aiTeaching', ov?.modelId, ov?.effort, skillName)
    // 自动压缩告知（会话压缩 §6.1）：主进程发送前折叠旧轮为纪要，用户应知道上下文变了
    if (r?.ok && r.compressed) showToast({ type: 'info', message: `上下文已自动压缩 ${r.compressed.covered} 条历史 → 纪要（/compress 可手动触发）` })
    // V-2：失败提示下沉到 sendText——模板开场/ask 发送/PPT 逐页讲解等 5 处 void sendText 路径统一覆盖（原先只有 doSend 有 toast）
    if (r && !r.ok && r.code !== 'ABORTED') showToast({ type: 'error', message: `AI 调用失败：${r.error ?? ''}` })
    // 条目9②：本轮 system 注入分段按会话留存（hover 构成摘要）；条目9③：月度用量随每轮刷新
    if (r?.injection) setInjectionMap(prev => ({ ...prev, [sid]: r.injection as AiTeachInjectionStats }))
    void llmGetUsage().then(setUsage).catch(() => null)
    setLastChanges(r?.changes && r.changes.length ? r.changes : null)
    await refreshMessages(sid)
    // 复习课：若 AI 刚用 course.review.write 生成 / 更新了讲义，自动刷新课程态并打开工件
    const reviewCid = Object.entries(courseStateRef.current?.reviews ?? {}).find(([, rv]) => rv.sessionId === sid)?.[0] ?? null
    if (reviewCid) {
      const before = courseStateRef.current?.reviews[reviewCid]?.rel ?? null
      await reloadCourse()
      const after = courseStateRef.current?.reviews[reviewCid]?.rel ?? null
      if (after && after !== before) void openArtFile(after)
    }
    endStream()
    setPending(false)
    setArtTabs(prev => prev.some(t => t.generating) ? prev.filter(t => !t.generating) : prev) // 中止/失败收尾：禁关占位不留场
    setArtActive(cur => cur?.startsWith('gen:') ? null : cur)
    return r
  }, [refreshMessages, beginStream, endStream, jumpToBottom, reloadCourse, openArtFile])

  const doSend = useCallback(async (override?: string) => {
    const text = (override ?? inputValueRef.current).trim()
    if (!text || pending || compressing) return
    // 斜杠指令（/compress 等）：命中即拦截执行，不进对话（无会话时也拦截并提示）
    if (text.startsWith('/')) {
      const sid0 = activeIdRef.current
      const ov0 = sid0 ? convoLlm.current.get(sid0) : undefined
      if (await handleChatCommand(text, {
        sessionId: sid0 ?? '',
        surface: 'aiTeaching',
        modelId: ov0?.modelId,
        effort: ov0?.effort,
        onProgress: p => setCompressing(p.active),
      })) {
        setInput('')
        return
      }
    }
    setInput('')
    // Skill chip 一次性消费：随本条消息显式注入，发出即清（v3.1.1 条目10）
    const sk = pickedSkill
    setPickedSkill(null)
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    await sendText(text, cid, true, sk?.registryName) // 失败 toast 已下沉 sendText（V-2），此处不再重复提示
  }, [pending, compressing, sendText, pickedSkill])

  // ---- / 弹层派生态（v3.1.1 条目10）：输入为「/ + 无空格词」时弹，带空格/换行即视为正文 ----
  const slashQuery = input.startsWith('/') && !/[\s\n]/.test(input.slice(1)) && input.length > 1 ? input.slice(1) : (input === '/' ? '' : null)
  const slashItems = useMemo(
    () => filterSlashItems(buildSlashItems(slashSkills, [], 'aiTeaching'), slashQuery ?? ''),
    [slashSkills, slashQuery],
  )
  const slashOpen = slashQuery !== null
  /** 弹层选中：指令 → 补全到输入框（回车执行走既有拦截链）；Skill → 挂 chip、清输入继续写正文 */
  const pickSlash = (it: SlashMenuItem) => {
    if (it.kind === 'command') {
      setInput('/' + it.name + ' ')
      setSlashActive(0)
      inputRef.current?.focus()
      return
    }
    const sk = slashSkills.find(s => s.registryName === it.name)
    if (sk) { setPickedSkill(sk); setInput(''); setSlashActive(0) }
  }
  /** 弹层键控：局部拦截并 stopPropagation，不进本模块全局 Esc 浮层链（TDZ 敏感区零改动） */
  const onSlashKeys = (e: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean }; preventDefault: () => void; stopPropagation: () => void; defaultPrevented: boolean }) => {
    if (!slashOpen || slashItems.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSlashActive(i => (i + 1) % slashItems.length); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSlashActive(i => (i - 1 + slashItems.length) % slashItems.length); return }
    if (e.key === 'Tab') { e.preventDefault(); pickSlash(slashItems[slashActive]); return }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); pickSlash(slashItems[slashActive]); return }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setInput(''); setSlashActive(0) }
  }

  /** v3.6.0 生图卡：把「改图 / 重试」的文本填回输入框（入口是对话，卡上没有插入按钮 —— 决策 D3）。
   *  只填不发 —— 用户还要补一句"改成什么样"再回车（与 pickSlash 的指令补全同一手法） */
  const prefillImagePrompt = useCallback((text: string) => {
    setInput(text)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  /** 条目13：quiz 解析失败占位卡的「让 AI 重出新题」——填入重试 prompt 直接发送（V-2 失败 toast 下沉同理路径） */
  const retryQuiz = useCallback(() => {
    void doSend('上一条回答里的 ```quiz 题目 JSON 解析失败（可能存在未转义英文双引号），请把那道题重新输出一遍：围栏语言 quiz，字符串内部需要引用时用中文引号『』或“”，确保 JSON 可解析。')
  }, [doSend])

  // ---------- v3.4.0 PDF 划词入口（pdf-reader 方案 §6）：pendingAsk 直接进当前对话 ----------
  useEffect(() => {
    if (!pendingAsk?.question) return
    const q = pendingAsk.question
    onConsumePendingAsk?.()
    if (!activeIdRef.current) { showToast({ type: 'warning', message: '当前没有打开的对话：先进入一段 / 课程助手，再发起划词提问' }); return }
    void sendText(q, crypto.randomUUID())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk])

  // ---------- P5：工作区进出与管理 ----------
  const enterWs = useCallback((id: string) => {
    setActiveWs(id); activeWsRef.current = id
    setWsSearch('')
    if (id !== '__none__') void aiTeachSetLastWorkspace(id)
    setActiveSegmentSid(null); setActiveUnitId(null); setSegmentStatus('open'); setCourseReviewChapter(null)
    setPreflight(null); setSourcePayload(null); setAssistantSid(null)
    void (async () => {
      const s = id === '__none__' ? null : await aiTeachCourseGetState(id).catch(() => null)
      courseStateRef.current = s
      setCourseState(s ?? null)
      setAssistantSid(s?.assistantSessionId ?? null)
      const first = s?.outline?.chapters.find((c) => c.units.some((u) => !unitLearned(u.id, s.progress, s.lessons))) ?? s?.outline?.chapters[0]
      setActiveChapterState(first?.id ?? null)
      const open = s ? Object.entries(s.lessons).find(([, l]) => l.status === 'open') : null
      if (open) {
        const l = open[1]
        const ids = lessonUnitIds(l)
        const title = sessions.find((x) => x.id === open[0])?.title ?? `段${l.order}`
        setActiveSegmentSid(open[0]); setActiveUnitId(l.activeUnitId ?? ids[0] ?? null); setSegmentStatus('open')
        const ch = s?.outline?.chapters.find((c) => c.units.some((u) => ids.includes(u.id)))
        if (ch) setActiveChapterState(ch.id)
        void openSession(open[0], title).then(() => {
          setActiveSegmentSid(open[0])
          setActiveUnitId(l.activeUnitId ?? ids[0] ?? null)
          setSegmentStatus('open')
          setCourseReviewChapter(null)
        })
      } else if (s?.assistantSessionId) {
        void openSession(s.assistantSessionId, '课程助手')
      } else {
        activeIdRef.current = null
        setActiveId(null); setActiveTitle(''); setMessages([]); setLastChanges(null); setLiveSteps([]); setArtTabs([]); setArtActive(null)
        setActiveInstr(''); setInstrRel('')
      }
      void refreshSessions()
    })()
  }, [sessions, openSession, refreshSessions])
  // 3-38（已拍板）：记住上次工作区，进模块直接回到上次的对话；换区走顶栏工作区 chip 回选择页。
  // 只在选择页态（用户未手动退出过：boot 尝试仅一次）且记忆有效时自动进入；首次使用停留在选择页。
  const wsBootRef = useRef(false)
  useEffect(() => {
    if (wsBootRef.current || wsList.length === 0) return
    wsBootRef.current = true
    if (activeWs === null && lastWsId && wsList.some(w => w.id === lastWsId)) enterWs(lastWsId)
  }, [wsList, lastWsId, activeWs, enterWs])
  const exitToPicker = useCallback(() => {
    setActiveWs(null); activeWsRef.current = null
    void refreshWorkspaces()
  }, [refreshWorkspaces])
  const submitWsModal = useCallback(async () => {
    if (!wsModal) return
    const name = wsModal.value.trim()
    if (!name) { setWsModal(null); return }
    if (wsModal.mode === 'create') {
      const r = await aiTeachCreateWorkspace(name)
      setWsModal(null)
      if (!r.ok || !r.workspace) { showToast({ type: 'error', message: r.error ?? '创建工作区失败' }); return }
      showToast({ type: 'info', message: `已创建工作区「${r.workspace.name}」` })
      await refreshWorkspaces()
      enterWs(r.workspace.id)
    } else {
      const r = await aiTeachRenameWorkspace(wsModal.id ?? '', name)
      if (!r.ok) showToast({ type: 'error', message: r.error ?? '工作区改名失败' })
      else showToast({ type: 'info', message: '工作区已改名（产物文件夹同步）' })
      await refreshWorkspaces()
      setWsModal(null)
    }
  }, [wsModal, refreshWorkspaces, enterWs])
  const removeWs = useCallback(async (w: AiTeachWorkspaceInfo) => {
    const okGo = await showGlobalConfirm({
      title: `删除工作区「${w.name}」`,
      message: '只删除工作区本身（归属元数据）：「AI教学」下的文件夹与其中对话都保留在原处（3-39：不迁移、也不再显示在界面中），产物文件不删。',
      confirmLabel: '删除工作区', variant: 'danger',
    })
    if (!okGo) return
    const r = await aiTeachDeleteWorkspace(w.id)
    if (!r.ok) { showToast({ type: 'error', message: r.error ?? '删除失败' }); return }
    if (activeWs === w.id) { setActiveWs(null); activeWsRef.current = null }
    await refreshWorkspaces()
  }, [activeWs, refreshWorkspaces])
  const wsFiltered = useMemo(() => {
    const q = wsSearch.trim().toLowerCase()
    return q ? wsList.filter(w => w.name.toLowerCase().includes(q)) : wsList
  }, [wsList, wsSearch])

  /** 打开已存在的段（不新建） */
  const openSegmentBySid = useCallback(async (sid: string) => {
    const cs = courseStateRef.current
    const l = cs?.lessons[sid]
    if (!l) return
    const ids = lessonUnitIds(l)
    const ch = cs?.outline?.chapters.find((c) => c.units.some((u) => ids.includes(u.id)))
    setActiveSegmentSid(sid)
    setActiveUnitId(l.activeUnitId ?? ids[0] ?? null)
    setSegmentStatus(l.status)
    setCourseReviewChapter(null)
    setPreflight(null)
    if (ch) setActiveChapterState(ch.id)
    await openSession(sid, sessions.find((s) => s.id === sid)?.title ?? `第${l.order}段`)
    setActiveSegmentSid(sid)
    setActiveUnitId(l.activeUnitId ?? ids[0] ?? null)
    setSegmentStatus(l.status)
    setCourseReviewChapter(null)
  }, [openSession, sessions])

  /** 点知识点：本段内 → 聚焦；已学 → 回看最近段；未学 → 开段预检 */
  const courseOpenUnit = useCallback(async (chapterId: string, unitId: string) => {
    const cs = courseStateRef.current
    if (!cs?.outline) return
    const open = openSegmentOfUnit(cs.lessons, unitId)
    if (open) {
      if (open.sessionId !== activeSegmentSid) await openSegmentBySid(open.sessionId)
      const r = await aiTeachCourseSetActiveUnit(open.sessionId, unitId).catch(() => null)
      if (r?.ok) {
        setActiveUnitId(unitId)
        const st = courseStateRef.current
        if (st?.lessons[open.sessionId]) st.lessons[open.sessionId].activeUnitId = unitId
      }
      return
    }
    if (unitLearned(unitId, cs.progress, cs.lessons)) {
      const last = latestEndedSegmentOfUnit(cs.lessons, unitId)
      if (last) { await openSegmentBySid(last.sessionId); setActiveUnitId(unitId); return }
      const rel = cs.progress[unitId]?.summaryRel
      if (rel) { void openArtFile(rel); return }
      showToast({ type: 'info', message: '这个知识点标为已学，但没有可回看的段' })
      return
    }
    const ch = cs.outline.chapters.find((c) => c.id === chapterId) ?? cs.outline.chapters.find((c) => c.units.some((u) => u.id === unitId))
    if (!ch) return
    const openInChapter = Object.entries(cs.lessons).find(([, l]) => l.status === 'open' && lessonUnitIds(l).some((id) => ch.units.some((u) => u.id === id)))
    if (openInChapter) {
      showToast({ type: 'warning', message: '本章还有一段没收尾，先收尾再开新段' })
      await openSegmentBySid(openInChapter[0])
      return
    }
    setActiveChapterState(ch.id)
    if (!sourcePayload) void reloadSources()
    // 上一段交接：同章最后一个已收尾段的 交接.md
    let prev = ''
    const ended = Object.entries(cs.lessons)
      .filter(([, l]) => l.status === 'ended' && lessonUnitIds(l).some((id) => ch.units.some((u) => u.id === id)))
      .sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0))
    const rel = ended.length ? ended[ended.length - 1][1].handoffRel : null
    if (rel) {
      const cur = await workspaceGetCurrent().catch(() => null)
      const rootId = (cur as { rootId?: string } | null)?.rootId
      if (rootId) {
        const f = await workspaceReadFile(rootId, rel).catch(() => null)
        if (f && typeof f.content === 'string') prev = f.content.slice(0, 4000)
      }
    }
    setPreflight({ chapterId: ch.id, unitId, prevHandoff: prev })
  }, [activeSegmentSid, openArtFile, openSegmentBySid, reloadSources, sourcePayload])

  /** 预检确认：开段 */
  const startSegment = useCallback(async (unitIds: string[], sources: AiTeachSegmentSource[]) => {
    const ws = activeWsRef.current
    if (!ws || ws === '__none__') return
    setPreflightBusy(true)
    const r = await aiTeachCourseOpenSegment(ws, unitIds, sources).catch(() => null)
    setPreflightBusy(false)
    if (!r?.ok || !r.sessionId) { showToast({ type: 'warning', message: r?.error ?? '开段失败' }); return }
    setPreflight(null)
    setActiveSegmentSid(r.sessionId)
    setActiveUnitId(unitIds[0] ?? null)
    setSegmentStatus('open')
    setCourseReviewChapter(null)
    await reloadCourse()
    await openSession(r.sessionId, `第${r.order ?? 1}段`)
    // openSession 读的是 courseStateRef；刚开段时极少数时序下 ref 仍是旧值，这里再钉一次
    setActiveSegmentSid(r.sessionId)
    setActiveUnitId(unitIds[0] ?? null)
    setSegmentStatus('open')
    setCourseReviewChapter(null)
    void refreshSessions()
  }, [openSession, reloadCourse, refreshSessions])

  /** 打开课程助手（整门课唯一会话；无大纲也可用） */
  const courseOpenAssistant = useCallback(async () => {
    const ws = activeWsRef.current
    if (!ws || ws === '__none__') return
    const r = await aiTeachCourseOpenAssistant(ws).catch(() => null)
    if (!r?.ok || !r.sessionId) { showToast({ type: 'warning', message: r?.error ?? '打开课程助手失败' }); return }
    setAssistantSid(r.sessionId)
    setActiveSegmentSid(null); setActiveUnitId(null); setCourseReviewChapter(null); setPreflight(null)
    await openSession(r.sessionId, '课程助手')
    void refreshSessions()
  }, [openSession, refreshSessions])

  /** 打开章末复习（学完才解锁；有历史讲义则始终可看） */
  const courseOpenChapterReview = useCallback(async (chapterId: string) => {
    const ws = activeWsRef.current
    const cs = courseStateRef.current
    if (!ws || ws === '__none__' || !cs?.outline) return
    const ch = cs.outline.chapters.find((c) => c.id === chapterId)
    if (!ch) return
    const st = reviewState(chapterId, ch.units.map((u) => u.id), cs.progress, cs.lessons, cs.reviews)
    if (st.state === 'locked') { showToast({ type: 'warning', message: `本章还有 ${st.remaining} 个知识点没学完，学完自动解锁` }); return }
    const r = await aiTeachCourseOpenChapterReview(ws, chapterId).catch(() => null)
    if (!r?.ok || !r.sessionId) { showToast({ type: 'warning', message: r?.error ?? '打开复习课失败' }); return }
    setActiveSegmentSid(null); setActiveUnitId(null); setSegmentStatus('open')
    setCourseReviewChapter(chapterId); setPreflight(null); setActiveChapterState(chapterId)
    await openSession(r.sessionId, `复习课·${ch.name}`)
    setCourseReviewChapter(chapterId)
    setActiveSegmentSid(null); setActiveUnitId(null)
    await reloadCourse()
    void refreshSessions()
  }, [openSession, reloadCourse, refreshSessions])

  /** 收尾当前段：冻结 + 置学完 + 异步生成交接 */
  const courseEndSegment = useCallback(async () => {
    const sid = activeIdRef.current
    if (!sid) return
    const r = await aiTeachCourseEndSegment(sid).catch(() => null)
    if (!r?.ok) { showToast({ type: 'error', message: r?.error ?? '收尾失败' }); return }
    setSegmentStatus('ended')
    showToast({ type: 'info', message: '本段已收尾 · 正在生成交接…' })
    await reloadCourse()
    const f = await aiTeachCourseFinalizeSegment(sid).catch(() => null)
    if (f?.skipped) showToast({ type: 'info', message: '本段没有内容，未生成交接' })
    else if (f?.ok) { showToast({ type: 'success', message: '交接已生成（交接.md）' }); await reloadCourse() }
    else showToast({ type: 'warning', message: `交接生成失败：${f?.error ?? ''}（可手动补写）` })
  }, [reloadCourse])

  /** 复习课：让 AI 生成 / 更新讲义 */
  const courseWriteReview = useCallback(() => {
    if (!courseReviewChapter) return
    void doSend('请把本次复习整理成《复习讲义》，调用 course.review.write 写入本章目录；写好后告诉我落盘路径。')
  }, [courseReviewChapter, doSend])

  /** 跳转 chip：知识点名 → 最近已收尾段 / 旧总结篇 */
  const courseJump = useCallback((name: string) => {
    const hit = courseJumpByName.get(normName(name))
    if (!hit) { showToast({ type: 'info', message: `没有找到「${name}」对应的段或总结` }); return }
    if (hit.sid) { void openSegmentBySid(hit.sid); return }
    if (hit.rel) void openArtFile(hit.rel)
  }, [courseJumpByName, openArtFile, openSegmentBySid])

  const courseReviewChapterName = useMemo(() => courseState?.outline?.chapters.find(c => c.id === courseReviewChapter)?.name ?? '', [courseState, courseReviewChapter])
  const activeChapterObj = useMemo(() => courseState?.outline?.chapters.find((c) => c.id === railActiveChapter) ?? null, [courseState, railActiveChapter])
  const activeSegmentUnitNames = useMemo(() => {
    const ids = activeSegment ? lessonUnitIds(activeSegment) : []
    return ids.map((id) => courseUnits.find((u) => u.id === id)?.name ?? id)
  }, [activeSegment, courseUnits])

  const openRequirements = useCallback((layer: ReqLayer) => {
    setReqLayer(layer)
    setReqOpen(true)
  }, [])

  // ---------- 左栏「收藏」（v3.6.0：钉住活文档随手翻；favorites.json 按工作区） ----------
  const [favorites, setFavorites] = useState<AiTeachFavorite[]>([])
  const [favOpen, setFavOpen] = useState(false)
  const favoritesRef = useRef<AiTeachFavorite[]>([])
  favoritesRef.current = favorites
  const reloadFavorites = useCallback(async () => {
    const ws = activeWsRef.current
    if (!ws || ws === '__none__') { setFavorites([]); return }
    setFavorites(await aiTeachFavList(ws).catch(() => [] as AiTeachFavorite[]))
  }, [])
  useEffect(() => { void reloadFavorites() }, [activeWs, reloadFavorites])
  /** 钉 / 取消钉（rel = 仓库相对路径）；稳定回调，供 memo 子组件（AiTeachFileTree） */
  const togglePin = useCallback(async (rel: string, name: string) => {
    const ws = activeWsRef.current
    if (!ws || ws === '__none__' || !rel) return
    const pinned = favoritesRef.current.some((f) => f.rel === rel)
    const next = pinned
      ? await aiTeachFavRemove(ws, rel).catch(() => favoritesRef.current)
      : await aiTeachFavAdd(ws, rel, name).catch(() => favoritesRef.current)
    setFavorites(next)
    showToast({ type: 'info', message: pinned ? '已取消收藏' : `已钉到收藏：${(name || rel).replace(/\.md$/i, '')}` })
  }, [])
  const isPinned = useCallback((rel: string) => favoritesRef.current.some((f) => f.rel === rel), [])

  /** CONSTRAINTS / 打开中的工件回读（3.14 不再回读 SOURCE.md；素材由 right rail 按需拉） */
  const instrStateRef = useRef({ open: false, draft: '' })
  useEffect(() => { instrStateRef.current = { open: instrOpen, draft: instrDraft } }, [instrOpen, instrDraft])
  const syncSessionFiles = useCallback((opts: { constraints?: boolean; doc?: string | null }) => {
    const sid = activeIdRef.current
    if (opts.constraints && sid) {
      void aiTeachReadConstraints(sid).then(r => {
        if (!r?.ok || !r.relPath || activeIdRef.current !== sid) return
        const text = (r.text ?? '').trim()
        setActiveInstr(text)
        setInstrRel(r.relPath)
        const st = instrStateRef.current
        if (!(st.open && st.draft.trim() !== text)) setInstrDraft(text)
      }).catch(() => null)
    }
    // 打开中的工件页签回读磁盘（编辑器保存/程序重写后即时反映）
    const rel = opts.doc ?? null
    const openTabs = artTabsRef.current.filter(t => !t.generating && t.rel && t.kind !== 'image' && (rel ? t.rel === rel : t.kind === 'md'))
    for (const t of openTabs) {
      void workspaceGetCurrent().then(cur => {
        const rootId = (cur as { rootId?: string } | null)?.rootId
        return rootId ? workspaceReadFile(rootId, t.rel) : null
      }).then(r => {
        if (!r || typeof r.content !== 'string') return
        if (t.kind === 'md') setArtTabs(prev => prev.map(x => x.id === t.id && x.content !== r.content ? { ...x, content: r.content } : x))
        else if (t.kind === 'html') setHtmlSeq(prev => ({ ...prev, [t.rel]: (prev[t.rel] ?? 0) + 1 }))
      }).catch(() => null)
    }
  }, [])
  useEffect(() => {
    const onSaved = (e: Event) => {
      const rel = String((e as CustomEvent).detail?.relPath ?? '')
      const base = rel.split(/[\\/]/).pop() ?? ''
      const artHit = !!rel && artTabsRef.current.some(t => !t.generating && t.rel === rel)
      if (base !== 'CONSTRAINTS.md' && !artHit) return
      syncSessionFiles({ constraints: base === 'CONSTRAINTS.md', doc: artHit ? rel : null })
    }
    const onTree = () => { syncSessionFiles({ constraints: true }); void reloadCourse() }
    const onFocus = () => syncSessionFiles({ constraints: true })
    window.addEventListener('kb:file-saved', onSaved)
    window.addEventListener('focus', onFocus)
    const off = onAiTeachTreeRefresh(onTree)
    const offFs = onWsFsChanged(({ watcherError }) => {
      if (watcherError) return
      onTree()
      setTreeRefreshSeq(n => n + 1)
    })
    return () => { window.removeEventListener('kb:file-saved', onSaved); window.removeEventListener('focus', onFocus); off(); offFs() }
  }, [syncSessionFiles, reloadCourse])
  // 切回本模块 Tab：回读一次（保活组件不卸载，isActive 是唯一「重新可见」信号）
  useEffect(() => { if (isActive) syncSessionFiles({ constraints: true }) }, [isActive, syncSessionFiles])

  // ---------- P8 用户画像（§3.14；三层 = 三份仓库内 PROFILE.md，编辑一律跳编辑区——第三轮「C 移入仓库」拍板） ----------
  /** 12/13：最新一个未答 ```ask 块（只挂最新一条 assistant 回答里的；其后出现用户消息即视为已答）
   *  （声明于 Esc 效应之前：Esc「先关浮层」链引用 askVisible，置后声明会 TDZ） */
  const askPending = useMemo<AskBlock | null>(() => {
    // 切会话空窗（activeId 已换、messages 还没拉到）：当前 messages 不属于 activeId 时不认卡片，
    // 否则「上课 ⇄ 课程助手」互切时会把上一个会话的提问卡串到另一个页面。
    if (messagesSidRef.current !== activeId) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user') return null
      const mt = /```ask[^\n]*\n([\s\S]*?)```/.exec(m.content)
      return mt ? parseAskBlock(mt[1], m.id ?? `idx${i}`) : null
    }
    return null
  }, [messages, activeId])
  const [askDismissed, setAskDismissed] = useState<string | null>(null)
  const [askPicks, setAskPicks] = useState<Record<number, string>>({})
  // 提问卡 v2（WorkBuddy 式）：整卷 ‹k/n› 翻页 + 每题「其他补充」自定义回答
  const [askPage, setAskPage] = useState(0)
  /** 每题一条补充草稿 / 一个编辑态：翻页不串题（B-44 根因 5），翻回来还能继续编辑 */
  const [askCustomDrafts, setAskCustomDrafts] = useState<Record<number, string>>({})
  const [askCustomOpen, setAskCustomOpen] = useState<Record<number, boolean>>({})
  /** 本题答案是否来自「其他补充」：与选项文本恰好相等时也仍按补充行呈现（B-44 根因 1） */
  const [askCustomPicks, setAskCustomPicks] = useState<Record<number, boolean>>({})
  const askVisible = !!askPending && askDismissed !== askPending.id
  /** 条目9：提问卡收起二态（不丢 askPending 与点选状态；换 ask 重置） */
  const [askCollapsed, setAskCollapsed] = useState(false)
  useEffect(() => { setAskPicks({}); setAskPage(0); setAskCustomDrafts({}); setAskCustomOpen({}); setAskCustomPicks({}); setAskCollapsed(false) }, [askPending?.id]) // 换 ask 重置整卷点选/翻页/补充/收起

  /**
   * v3.2.0 第 20 项：画像建议的三块状态。
   * - `profRows`：条目形态下 AI 所给条目的**可勾选 / 可编辑副本**（AI 原文不直接落盘）。
   *   重建只由「建议本身或会话变化」触发 —— **刻意不再挂 `[messages]` 无条件复位**，
   *   否则「忽略后 8 轮内不再提示」的节流窗口会被下一条消息冲掉（旧实现就是这个毛病）。
   * - `profLayer`：写入层级（本主题可整段替换字段；工作区 / 全局只追加）。
   * - `profExpanded`：节流窗口内「安静入口」被手动展开。
   * - `profTick`：忽略 / 写入后记一次账，用于让节流判定重算（localStorage 不是响应式数据源）。
   */
  const [profRows, setProfRows] = useState<ProfRow[]>([])
  const [profLayer, setProfLayer] = useState<ProfileLayer>('session')
  const [profExpanded, setProfExpanded] = useState(false)
  const [profTick, setProfTick] = useState(0)
  /** 旧形态（整篇全文）建议的「预览」= 就地受控展开 / 收起 —— v3.2.0 条目7 同款口径，保留给回落路径 */
  const [profPreviewOpen, setProfPreviewOpen] = useState(false)
  // Esc 统一入口（R26 真机验证补口）：本模块浮层优先逐个关闭（素材表单 → 工作区弹层 → 会话要求 →
  // 用量明细 → 新建菜单 → 模型菜单），都关完才退禅。原实现挂在 zenActive 分支里 → 非禅模式下浮层按 Esc 无反应。
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (askVisible && askPending) {
        // 条目9：Esc 两段式——先收起（轻操作，可随时展开），已收起再按 = 忽略（退回自由输入）
        if (!askCollapsed) { setAskCollapsed(true); return }
        setAskDismissed(askPending.id)
        return
      }
      if (reqOpen) { setReqOpen(false); return }
      if (preflight) { setPreflight(null); return }
      if (wsModal) { setWsModal(null); return }
      if (instrOpen) { setInstrOpen(false); return }
      if (tokenOpen) { setTokenOpen(false); return }
      if (modelMenuOpen) { setModelMenuOpen(false); return }
      if (!zenActive) return
      e.preventDefault()
      onZenLevelChange?.(0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive, zenActive, onZenLevelChange, askVisible, askPending, askCollapsed, reqOpen, preflight, wsModal, instrOpen, tokenOpen, modelMenuOpen])
  /**
   * 最新一条 assistant 回答里的 ```profile 围栏 = 画像更新建议（接受才写文件）。
   * v3.2.0 第 20 项起：围栏正文先过 `parseProfileFence` —— 解得出 JSON 条目数组就是新形态，
   * 解不出则回落「整篇全文」（历史消息仍是旧形态，回落只允许写本主题层）。
   */
  const profileFence = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      const mt = /```profile[^\n]*\n([\s\S]*?)```/.exec(m.content)
      return mt ? { raw: mt[1].trim() } : null
    }
    return null
  }, [messages])
  const profileSuggestion = useMemo<ProfileSuggestion | null>(
    () => (profileFence ? parseProfileFence(profileFence.raw) : null),
    [profileFence],
  )
  /** 对话驱动建课：最新一条 assistant 回答里的 ```outline 围栏 = 课程大纲草稿（用户满意才正式落盘）。
      带出所属消息下标 idx —— 草稿卡要**内联在产生它的那条回复里**（2026-10-14 拍板，见 docs/ai-outline-inline-plan.md），
      旧轮次的围栏照旧只剥不渲染（正文剥离正则在渲染处）。 */
  const outlineFence = useMemo<{ raw: string; idx: number } | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      const mt = /```outline[^\n]*\n([\s\S]*?)```/.exec(m.content)
      return mt ? { raw: mt[1].trim(), idx: i } : null
    }
    return null
  }, [messages])
  type OutlineDraftUi = { title?: string; goal?: string; chapters?: { name?: string; units?: { name?: string; goal?: string; source?: string }[] }[] }
  const outlineDraft = useMemo<OutlineDraftUi | null>(() => {
    if (!outlineFence) return null
    try {
      const o = JSON.parse(outlineFence.raw) as OutlineDraftUi
      return o && Array.isArray(o.chapters) ? o : null
    } catch { return null }
  }, [outlineFence])
  /** 落盘态：记住**哪一份草稿**已落盘 + 落盘路径（草稿内容一变就退回未落盘）。内存态 —— 切会话即清。 */
  const [outlineDone, setOutlineDone] = useState<{ fence: string; rel: string } | null>(null)
  useEffect(() => { setOutlineDone(null) }, [activeId])
  const outlineCommitted = !!outlineDone && !!outlineFence && outlineDone.fence === outlineFence.raw
  const commitOutlineDraft = useCallback(async () => {
    const ws = activeWs && activeWs !== '__none__' ? activeWs : ''
    if (!ws || !outlineDraft || !outlineFence) { showToast({ type: 'warning', message: '缺少工作区或大纲草稿' }); return }
    const r = await aiTeachCourseWriteOutlineDraft(ws, outlineDraft).catch(() => null)
    if (r?.ok) { showToast({ type: 'info', message: '已生成课程大纲' }); setOutlineDone({ fence: outlineFence.raw, rel: r.relPath ?? '' }) }
    else showToast({ type: 'error', message: `生成失败${r?.error ? `：${r.error}` : ''}` })
  }, [activeWs, outlineDraft, outlineFence])
  /** 打开已落盘的 课程.md：与本模块画像 / CONSTRAINTS 同范式（ensure 产物 → 跳编辑区打开，带「← 返回 AI教学」） */
  const openCourseOutline = useCallback(() => {
    const rel = outlineDone?.rel
    if (!rel) { showToast({ type: 'warning', message: '课程大纲尚未落盘' }); return }
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: rel, from: 'aiTeaching' } }))
  }, [outlineDone])
  /** 建议一变（或换会话）就重建勾选副本：默认全勾，层级回本主题，安静入口收起 */
  useEffect(() => {
    setProfRows(profileSuggestion?.mode === 'entries' ? profileSuggestion.entries.map((e) => ({ ...e, checked: true })) : [])
    setProfLayer('session')
    setProfExpanded(false)
    setProfPreviewOpen(false)
  }, [profileSuggestion, activeId])
  /** 节流判定：忽略 / 写入后 8 轮或 30 分钟内不再自动弹（取先到）。轮数 = user 消息条数 */
  const profRound = useMemo(() => userRoundCount(messages), [messages])
  const profThrottle = useMemo(() => {
    void profTick // localStorage 不是响应式数据源：忽略 / 写入后靠 profTick 触发重算
    const state = activeId ? readNav(activeId).profile : undefined
    const now = Date.now()
    return { state, active: !profileThrottleAllows(state, profRound, now), note: profileThrottleNote(state, profRound, now) }
  }, [activeId, profRound, profTick])
  /** 有待确认的建议（已写入过的不再算待确认） */
  const profPending = !!profileSuggestion && profileSuggestion.mode !== 'invalid' && profThrottle.state?.mutedBy !== 'applied'
  /** 窗口已过或用户手动展开 → 展开卡片 */
  const profShow = profPending && (!profThrottle.active || profExpanded)
  /** 窗口内的安静入口（拍板：不打断心流但不错过） */
  const profQuiet = profPending && profThrottle.active && !profExpanded
  /** 卡片可选层级：工作区层在无工作区时不可用 */
  const profLayers = useMemo(() => ([
    { id: 'session' as ProfileLayer, label: '本主题', enabled: !!activeId, title: '写入当前会话 PROFILE.md —— 最细颗粒，可整段替换字段' },
    { id: 'workspace' as ProfileLayer, label: '工作区', enabled: !!wsActive, title: wsActive ? `写入工作区「${wsActive.name}」画像 —— 只做追加，不改写已有内容` : '会话未归属工作区，无工作区画像层' },
    { id: 'global' as ProfileLayer, label: '全局', enabled: true, title: '写入仓库内全局画像（跨工作区 / 跨仓库共享）—— 只做追加，不改写已有内容' },
  ]), [activeId, wsActive])
  /** 当前勾选且在当前层级可用的条目数 */
  const profUsableCount = profRows.filter((r) => r.checked && layerAllows(profLayer, r.op)).length
  /** 画像编辑 = 确保对应层文档存在（缺则落骨架）后直接跳编辑区打开；编辑器顶栏「← 返回 AI教学」回跳（条目6 已实现） */
  const openProfile = useCallback(async (layer: 'global' | 'workspace' | 'session', wsId?: string | null) => {
    if (layer === 'session' && !activeId) { showToast({ type: 'warning', message: '本主题画像随对话存放：先选择或新建一个对话' }); return }
    if (layer === 'workspace' && !wsId && !(activeWs && activeWs !== '__none__')) { showToast({ type: 'warning', message: '先进入一个工作区' }); return }
    const wid = wsId ?? activeWs
    const r = layer === 'global' ? await aiTeachProfileEnsureGlobal().catch(() => null)
      : layer === 'workspace' ? await aiTeachProfileEnsureWorkspace(wid!).catch(() => null)
      : await aiTeachProfileEnsureSession(activeId!).catch(() => null)
    if (!r?.ok || !r.relPath) { showToast({ type: 'error', message: `画像打开失败${r?.error ? `：${r.error}` : ''}` }); return }
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: r.relPath, from: 'aiTeaching' } }))
    showToast({ type: 'info', message: `画像文档已在知识库打开（${r.created ? '已按骨架创建' : '已有文件'}）· 页面条左侧可「← 返回 AI教学」` })
  }, [activeId, activeWs])
  /** 全局要求编辑 = ensure 产物根 CONSTRAINTS.md（缺则落骨架）→ 跳编辑区打开；与全局画像同款交互（global-constraints 方案） */
  const openGlobalConstraints = useCallback(async () => {
    const r = await aiTeachGlobalEnsureConstraints().catch(() => null)
    if (!r?.ok || !r.relPath) { showToast({ type: 'error', message: `全局要求打开失败${r?.error ? `：${r.error}` : ''}` }); return }
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: r.relPath, from: 'aiTeaching' } }))
    showToast({ type: 'info', message: `全局要求已在编辑区打开（${r.created ? '已按骨架创建' : '已有文件'}）· 保存后所有会话下一轮生效` })
  }, [])
  /** v3.1.2 条目6：工作区要求编辑 = ensure {工作区}/CONSTRAINTS.md（缺则落骨架）→ 跳编辑区打开；与全局要求同款交互 */
  const openWorkspaceConstraints = useCallback(async (wsId?: string | null) => {
    const wid = wsId ?? activeWs
    if (!wid || wid === '__none__') { showToast({ type: 'warning', message: '会话未归属工作区，无工作区要求层' }); return }
    const r = await aiTeachWorkspaceEnsureConstraints(wid).catch(() => null)
    if (!r?.ok || !r.relPath) { showToast({ type: 'error', message: `工作区要求打开失败${r?.error ? `：${r.error}` : ''}` }); return }
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: r.relPath, from: 'aiTeaching' } }))
    showToast({ type: 'info', message: `工作区要求已在编辑区打开（${r.created ? '已按骨架创建' : '已有文件'}）· 保存后本工作区会话下一轮生效` })
  }, [activeWs])
  /** 关闭建议 → 记账节流窗口：`ignored` 窗口内留安静入口，`applied` 已写入则不再留 */
  const muteProfileSuggestion = useCallback((by: 'ignored' | 'applied') => {
    if (!activeId) return
    writeNav(activeId, { ...readNav(activeId), profile: { mutedRound: profRound, mutedTs: Date.now(), mutedBy: by } })
    setProfTick((v) => v + 1)
    setProfExpanded(false)
  }, [activeId, profRound])
  /** 应用当前勾选的条目到 `profLayer`（合并语义：add 追加 / update 替换 / remove 删行） */
  const applyProfileSuggestion = useCallback(async () => {
    const sug = profileSuggestion
    if (!sug || !activeId) return

    // 旧形态（整篇全文）：只写本主题层 —— 上层绝不允许被整篇覆盖
    if (sug.mode === 'fulltext') {
      const r = await aiTeachProfileWriteSession(activeId, sug.text).catch(() => null)
      if (r?.ok) {
        muteProfileSuggestion('applied')
        showToast({ type: 'info', message: '已写入本主题画像（AI 给的是整篇全文，按旧格式处理）· 下轮生效' })
      } else showToast({ type: 'error', message: '画像写入失败' })
      return
    }

    const usable = profRows.filter((r) => r.checked && layerAllows(profLayer, r.op))
    if (usable.length === 0) { showToast({ type: 'warning', message: '没有可写入的条目（当前层级下这些条目都不可用）' }); return }

    // 删除类条目二次确认（设置项 `skipProfileDeleteConfirm` 可关；默认要确认）
    const removes = usable.filter((r) => r.op === 'remove')
    if (removes.length > 0) {
      const skip = await getSetting('skipProfileDeleteConfirm').catch(() => false)
      if (skip !== true) {
        const yes = await showGlobalConfirm({
          title: '确认删除画像内容',
          message: `将删除 ${removes.length} 条画像内容：${removes.map((r) => `${r.field}·${r.text}`).join('；')}。删除后可到画像文档手动加回。`,
          confirmLabel: '删除',
          variant: 'danger',
        })
        if (!yes) return
      }
    }

    const id = profLayer === 'global' ? null : profLayer === 'workspace' ? (activeWs && activeWs !== '__none__' ? activeWs : null) : activeId
    if (profLayer !== 'global' && !id) { showToast({ type: 'warning', message: '当前层级不可用' }); return }
    const entries: AiTeachProfileEntry[] = usable.map((r) => (r.from ? { field: r.field, op: r.op, text: r.text, from: r.from } : { field: r.field, op: r.op, text: r.text }))
    const r = await aiTeachProfileApplyPatch(profLayer, id, entries).catch(() => null)
    if (!r?.ok) { showToast({ type: 'error', message: `画像写入失败${r?.error ? `：${r.error}` : ''}` }); return }
    muteProfileSuggestion('applied')
    const label = profLayers.find((l) => l.id === profLayer)?.label ?? ''
    const applied = r.applied ?? []
    const skipped = r.skipped ?? []
    showToast({ type: 'info', message: `已写入${label}画像 ${applied.length} 条${skipped.length > 0 ? ` · ${skipped.length} 条跳过` : ''}` })
    if (skipped.length > 0) showToast({ type: 'warning', message: skipped.map((s) => `${s.field}：${s.reason}`).join('；') })
  }, [profileSuggestion, activeId, profRows, profLayer, activeWs, profLayers, muteProfileSuggestion])

  // ---------- UI 优化条目12/13：提问模式（ask 协议） ----------
  // （条目11「任务规划」面板已随 v3.8.0 布局改造删除：左栏不再承载 plan 步骤列表与跳步遥控，
  //    plan 协议本身与会话数据未动 —— AI 仍在对话里按 ```plan 围栏汇报进度）

  /** 12/13 回答动作：点选项 / 提交整卷 = 作为用户消息发出（ask 随新用户消息自动判已答） */
  const sendAskAnswer = useCallback((text: string) => {
    if (pending) return
    if (!activeIdRef.current) { showToast({ type: 'warning', message: '先选择或新建一个对话' }); return }
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    setAskDismissed(null)
    void sendText(text, cid)
  }, [pending, sendText])
  const submitAskExam = useCallback((override?: { page: number; value: string }) => {
    if (!askPending || askPending.kind !== 'exam' || pending) return
    // ↑ 前输入框里还没按 Enter 的文字：由调用方作为 override 传入，避免 setState 异步导致漏答
    const picks = override ? { ...askPicks, [override.page]: override.value } : askPicks
    const lines = askPending.questions.map((q, i) => `${i + 1}. ${q.question} → ${picks[i] ?? '（未答）'}`)
    sendAskAnswer(`【整卷回答】\n${lines.join('\n')}`)
  }, [askPending, askPicks, pending, sendAskAnswer])

  /** P2（2-6）：保存会话要求 = 写会话文件夹 CONSTRAINTS.md（懒建兜底）；清掉旧 DB 字段残留防双真相源 */
  const saveInstr = async (): Promise<void> => {
    const sid = activeIdRef.current
    if (!sid) return
    const text = instrDraft.trim().slice(0, 2000)
    const r = await aiTeachWriteConstraints(sid, text).catch(() => null)
    if (r && r.ok) {
      const hadDb = !!sessions.find(s => s.id === sid)?.instructions
      if (hadDb) void agentSetSessionInstructions(sid, '').catch(() => null)
      setActiveInstr(text); setInstrRel(r.relPath ?? ''); setInstrDismiss(false); setInstrOpen(false)
      showToast({ type: 'info', message: text ? '已保存到 CONSTRAINTS.md（编辑器里可直接改，AI 每轮发送时重读）' : '已清除本会话约束' })
    } else {
      showToast({ type: 'error', message: `约束保存失败${r?.error ? `：${r.error}` : ''}` })
    }
  }

  // ---- PPT 逐页阅读（已并入工件栏 pptx 页签；条目5.1 「原件」按钮 → openArtFile 分派）----
  const setArtPptxPage = useCallback((id: string, delta: number) => {
    setArtTabs(prev => prev.map(t => {
      if (t.id !== id || !t.pages?.length) return t
      const next = Math.min(Math.max((t.cur ?? 0) + delta, 0), t.pages.length - 1)
      return next === t.cur ? t : { ...t, cur: next }
    }))
  }, [])

  /** 让 AI 讲解当前页（对话常驻左主区：页签保留，仅切回对话视图并发送） */
  const talkArtPage = useCallback((tab: ArtTab) => {
    if (pending || !tab.pages?.length) return
    const page = tab.pages[Math.min(tab.cur ?? 0, tab.pages.length - 1)]
    if (!page) return
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    const text = `我在逐页阅读 PPT《${tab.name}》第 ${(tab.cur ?? 0) + 1} 页（原文编号 ${page.n}）。请基于这一页讲清楚要点，讲完停一下等我的问题：\n\n${page.text.slice(0, 2200)}`
    void sendText(text, cid)
  }, [pending, sendText])

  /** 提交重命名：DB 标题 + 会话文件夹同步（无文件夹的旧会话不主动建，2-5 懒创建时自然用新名） */
  const commitRename = useCallback(async (sid: string) => {
    const t = renameDraft.trim().slice(0, 40)
    setRenamingId(null)
    const row = sessions.find(s => s.id === sid)
    if (!t || !row || t === row.title) return
    setSessions(prev => prev.map(s => (s.id === sid ? { ...s, title: t } : s)))
    if (activeIdRef.current === sid) setActiveTitle(t)
    await agentRenameSession(sid, t).catch(() => null)
    void aiTeachRenameSessionFolder(sid, t).then(r => {
      if (r && !r.ok && r.error) showToast({ type: 'error', message: `会话文件夹改名失败：${r.error}` })
    })
  }, [renameDraft, sessions])

  /** 删除会话（P1，2-4）：对话记录必删；产物文件夹按 aiTeachDeleteSessionFolder 设置处理。A2：ask 弹窗三键，「取消」中止整个删除 */
  const delSession = useCallback(async (e: React.MouseEvent, sid: string, title?: string) => {
    e.stopPropagation()
    // v3.1.2 条目11 P4：删除主线会级联删除其下支线——先查个数，明确告知（不静默连带删）。
    // 主进程 agent:deleteSession 负责真正级联（连同各自 .jsonl 消息文件）。
    const lanes = await agentListSideLanes(sid).catch(() => [] as AgentSessionInfo[])
    const laneNote = lanes.length > 0 ? `该对话下还有 ${lanes.length} 条支线旁问，将一并删除。` : ''
    const mode = String((await getSettingRaw('aiTeachDeleteSessionFolder').catch(() => null)) ?? 'ask')
    let rmFolder = false
    let laneNoteShown = false
    if (mode !== 'keep') {
      const f = await aiTeachSessionFolder(sid).catch(() => null)
      if (f?.ok && f.relPath) {
        if (mode === 'delete') rmFolder = true
        else {
          const r = await showGlobalConfirm({
            title: '删除会话',
            message: `${laneNote ? laneNote + '\n\n' : ''}对话记录「${title ?? ''}」将被删除。该会话在仓库中的产物文件夹「${f.relPath}」如何处理？\n\n· 删除文件夹 —— 对话记录与文件夹一并移入系统回收站\n· 仅保留文件夹 —— 只删对话记录，文件夹留在仓库\n· 取消 —— 什么都不删`,
            confirmLabel: '删除文件夹',
            extraLabel: '仅保留文件夹',
            cancelLabel: '取消',
            variant: 'danger',
          })
          if (r === false) return // A2：Esc/背景/「取消」= 真正中止删除（原行为会无条件删掉会话）
          rmFolder = r === true
          laneNoteShown = true
        }
      }
    }
    // 有支线但上面没机会提示（无文件夹 / 文件夹模式=直接删）→ 单独确认一次
    if (laneNote && !laneNoteShown) {
      const r = await showGlobalConfirm({
        title: '删除会话',
        message: `${laneNote}\n\n对话记录「${title ?? ''}」将被删除。`,
        confirmLabel: '删除',
        cancelLabel: '取消',
        variant: 'danger',
      })
      if (r === false) return
    }
    await agentDeleteSession(sid).catch(() => null)
    void aiTeachUnassignSession(sid).catch(() => null) // A4：同步清理 workspaces.json.sessionWs 残留
    clearNav(sid) // 条目6B：会话级导航持久化键随会话回收（否则 localStorage 只增不减）
    if (rmFolder) void aiTeachDeleteSessionFolder(sid).then(r => {
      if (r && !r.ok && r.error) showToast({ type: 'error', message: `会话文件夹删除失败：${r.error}` })
    })
    if (activeIdRef.current === sid) { setActiveId(null); setMessages([]); activeIdRef.current = null }
    void refreshSessions()
  }, [refreshSessions])

  const lastStep = liveSteps[liveSteps.length - 1]
  /** 生图「生成中」态（v3.6.0）：最后一条 image 步骤是**调用前的占位事件**（durationMs=0、无 artifact）
   *  才算"还在画"；一旦出现完成事件（带 artifact，或失败），占位卡就该收起来 ——
   *  成品/失败由上面的消息区（落库 trace）渲染，两处不会同时出现。 */
  const liveImagePending = (() => {
    for (let i = liveSteps.length - 1; i >= 0; i--) {
      const s = liveSteps[i]
      if (s.name !== 'image') continue
      if (s.artifact || s.durationMs > 0) return null
      return {
        prompt: typeof s.args?.prompt === 'string' ? s.args.prompt : '',
        aspect: typeof s.args?.aspect === 'string' ? s.args.aspect : '',
        ref: typeof s.args?.ref === 'string' ? s.args.ref : '',
      }
    }
    return null
  })()
  // ---------- 行容器观测（v3.8.0 §二：工件并入右栏单面板，行宽供「全宽阅读」与工件内部自适应） ----------
  const rowRef = useRef<HTMLDivElement>(null)
  const [rowW, setRowW] = useState(0)
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setRowW(el.clientWidth))
    ro.observe(el)
    setRowW(el.clientWidth)
    return () => ro.disconnect()
  }, [activeWs])
  /** 工件分栏是否有页签（内容驱动：一个工件都没有时不占地方） */
  const artExpanded = artTabs.length > 0
  // v3.8.0：首个工件页签出现时自动展开工件分栏（用户不必再点一次顶栏 chip）
  useEffect(() => {
    if (!artExpanded) return
    applyArtOpen(true)
  }, [artExpanded, applyArtOpen])
  // P3a（§3.8-1）：快速定位条锚点——每条 AI 回答取首行标题（标题规则由主进程注入，3-13）
  const anchors = useMemo(
    () => messages.flatMap((m, idx) => (m.role === 'assistant' ? [{ idx, title: msgAnchorTitle(m.content, idx) }] : [])),
    [messages])
  const jumpToAnchor = useCallback((idx: number) => {
    scrollRef.current?.querySelector(`[data-msg-idx="${idx}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])
  const onConvScroll = useCallback(() => {
    const c = scrollRef.current
    if (!c) return
    // Tab 保活隐藏期间（display:none）滚动容器读回 0——别把位置记忆冲掉，否则回切恢复不到
    if (!isActive) return
    if (activeIdRef.current) convScroll.current.set(activeIdRef.current, c.scrollTop)
    // 贴底判定（条目 6）：**纯几何**，不需要「程序化滚动」标记 —— 程序滚到底后几何上本就是贴底，
    // 所以不会把「自己滚的自己」误判成用户上滚；48px 容差同时吸收了流式增量带来的高度滞后。
    const near = c.scrollHeight - c.scrollTop - c.clientHeight < 48
    stickRef.current = near
    setJumpBottom(!near)
    if (anchors.length === 0) return
    const top = c.getBoundingClientRect().top
    let cur = 0
    anchors.forEach((a, i) => {
      const el = c.querySelector(`[data-msg-idx="${a.idx}"]`)
      if (el && el.getBoundingClientRect().top - top <= 90) cur = i
    })
    setActiveAnchor(cur)
  }, [anchors, isActive])

  /**
   * 内容变化 → **仅贴底时**滚到底（规则 2）。
   * **必须 instant，不能用 smooth**：流式下本 effect 每 60ms 触发一次，smooth 动画会与下一次
   * 调用互相打断，表现为滚动抽搐（同 MessageList.tsx 已记录的坑）。
   */
  const draftSig = streamDraft ? `${streamDraft.text.length}|${streamDraft.items.length}|${streamDraft.rev}` : ''
  useEffect(() => {
    const c = scrollRef.current
    if (!c || !stickRef.current) return
    c.scrollTop = c.scrollHeight
    if (activeIdRef.current) convScroll.current.set(activeIdRef.current, c.scrollHeight)
  }, [messages, pending, draftSig])

  // 切会话 / 切视图 / Tab 保活回切：恢复**该会话**记住的位置（没记过 = 从顶部）。
  // 开段预检会卸载对话容器、display:none 会重置滚动位置，故 preflight / isActive 都要进依赖。
  useEffect(() => {
    if (preflight) return
    setActiveAnchor(0)
    const saved = activeId ? convScroll.current.get(activeId) : undefined
    const t = saved ?? 0
    requestAnimationFrame(() => {
      const c = scrollRef.current
      if (!c) return
      c.scrollTop = t
      const near = c.scrollHeight - c.scrollTop - c.clientHeight < 48
      stickRef.current = near
      setJumpBottom(!near)
    })
  }, [preflight, activeId, isActive])

  // P3b：切会话时同步模型/思考强度控件到该会话的覆盖值（未覆盖=跟随全局默认）
  useEffect(() => {
    const ov = activeId ? convoLlm.current.get(activeId) : undefined
    setConvoModel(ov?.modelId ?? '')
    setConvoEffort(ov?.effort ?? 'off')
  }, [activeId])
  const effModel = convoModel || defaultModel
  const effModelBare = effModel.includes(':') ? effModel.slice(effModel.indexOf(':') + 1) : effModel
  useEffect(() => {
    if (!effModelBare) { setModelCapable(false); return }
    void llmReasoningCapable(effModelBare).then(setModelCapable).catch(() => setModelCapable(false))
  }, [effModelBare])
  useEffect(() => {
    // 换到不支持的模型 → 强度自动回「关闭」（整区禁用同屏已呈现）
    if (!modelCapable && convoEffort !== 'off') {
      setConvoEffort('off')
      const sid = activeIdRef.current
      const cur = sid ? convoLlm.current.get(sid) : undefined
      if (cur && sid) convoLlm.current.set(sid, { ...cur, effort: 'off' })
    }
  }, [modelCapable, convoEffort])
  const pickModel = (val: string): void => {
    const sid = activeIdRef.current
    if (!sid) { showToast({ type: 'warning', message: '请先新建对话，再选择本对话模型' }); return }
    convoLlm.current.set(sid, { ...(convoLlm.current.get(sid) ?? {}), modelId: val })
    setConvoModel(val)
  }
  const pickEffort = (e: Effort): void => {
    const sid = activeIdRef.current
    if (!sid) { showToast({ type: 'warning', message: '请先新建对话，再设置思考强度' }); return }
    convoLlm.current.set(sid, { ...(convoLlm.current.get(sid) ?? {}), effort: e })
    setConvoEffort(e)
  }
  const openModelMenu = (): void => {
    if (!modelMenuOpen) {
      void llmListProviders().then(res => setProviderList(res.providers ?? [])).catch(() => null)
      void llmVisionModels().then(r => setVisionList(r.models ?? [])).catch(() => null)
    }
    setModelMenuOpen(v => !v)
  }

  /** P3b「整理成文档」（§3.8-2）：本条回答落盘会话文件夹（懒建夹 2-5 + 幂等跳转 3-14 默认直出） */
  const organizeDocFor = async (content: string, idx: number, mid: string | undefined): Promise<void> => {
    const sid = activeIdRef.current
    if (!sid) return
    const key = mid ?? `idx${idx}`
    const existing = organized[key]
    if (existing) { void openArtFile(existing); return } // 工件栏入口②：已生成 → 页签阅读
    const title = msgAnchorTitle(content, idx)
    const r = await aiTeachOrganizeDoc(sid, title, content).catch(() => null)
    if (r?.ok && r.relPath) {
      setOrganized(prev => ({ ...prev, [key]: r.relPath as string }))
      showToast({ type: 'info', message: `已生成文档：${r.relPath.split('/').pop()}（左栏/编辑器可见可改）` })
    } else {
      showToast({ type: 'error', message: `整理失败${r?.error ? `：${r.error}` : ''}` })
    }
  }
  const tokenStats = useMemo(() => {
    const all: AgentTraceStep[] = [...messages.flatMap(m => m.trace ?? []), ...liveSteps]
    let llmTokens = 0, llmRounds = 0, toolCalls = 0, durationMs = 0
    let promptTokens = 0, completionTokens = 0, hasSplit = false
    for (const s of all) {
      durationMs += s.durationMs || 0
      if (s.kind === 'llm') {
        llmRounds++; llmTokens += s.tokens ?? 0
        if (typeof s.promptTokens === 'number' || typeof s.completionTokens === 'number') hasSplit = true
        promptTokens += s.promptTokens ?? 0
        completionTokens += s.completionTokens ?? 0
      } else toolCalls++
    }
    return { llmTokens, llmRounds, toolCalls, durationMs, promptTokens, completionTokens, hasSplit }
  }, [messages, liveSteps])
  const monthTokens = usage?.monthTokens ?? 0
  const budget = usage?.budget ?? 0
  /** UI 优化条目9②：上下文占用 = 最近一次 LLM 调用的 promptTokens（本轮真实喂进模型的输入，
   *  含 system 注入与工具定义；比累计 tokens 更贴近「还能装多少」的语义） */
  const ctxUsed = useMemo(() => {
    const all = [...messages.flatMap(m => m.trace ?? []), ...liveSteps]
    for (let i = all.length - 1; i >= 0; i--) {
      const s = all[i]
      if (s.kind === 'llm' && typeof s.promptTokens === 'number' && s.promptTokens > 0) return s.promptTokens
    }
    return 0
  }, [messages, liveSteps])
  const injection = activeId ? injectionMap[activeId] ?? null : null
  const ctxPct = ctxWindow > 0 ? ctxUsed / ctxWindow : null
  /** 注入构成摘要（字符→token 估算口径 ≈2.6 字/token，仅展示用） */
  const injParts = useMemo(() => {
    if (!injection) return []
    const t = (n: number) => Math.round(n / CHARS_PER_TOKEN)
    return [
      { k: '基础人设', v: t(injection.systemChars) },
      { k: '会话约束', v: t(injection.constraintChars) },
      { k: '三层画像', v: t(injection.profileChars) },
      { k: '素材目录', v: t(injection.sourcesChars) },
      { k: '教学规则', v: t(injection.ruleChars) },
    ].filter(p => p.v > 0)
  }, [injection])
  const injSystemEst = injParts.reduce((a, p) => a + p.v, 0)

  /** 右栏三个页签：进度 / 素材 / 支线（3.14 删除「层级」） */
  const railTabCls = (tab: 'progress' | 'sources' | 'lanes') => `flex-1 inline-flex items-center justify-center gap-1 px-1.5 py-1 rounded-md text-[11.5px] transition-colors ${railTab === tab ? 'bg-[var(--bg-primary)] text-[var(--accent)] font-medium shadow-sm' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`

  const composerFooter = (
                <div className="flex items-center gap-2 mt-0.5">
                  {/* 条目7：AI 生成内容合规提示——常驻左端空白处（原 flex-1 空占位），弱化小字不新增行高；
                      静态渲染与流式/停止两种右端状态正交，布局零跳动（AGENTS.md#12 帮助披露：禁醒目标签轰炸） */}
                  <span className="flex-1 min-w-0 truncate text-[10.5px] text-[var(--text-disabled)] select-none" title="AI 生成内容可能存在错误，请自行核实">AI 生成内容，请注意甄别</span>
                  {/* 模型 + 思考强度合一菜单（P3b R12/R14）：仅本对话生效 */}
                  <div className="relative">
                    <button onClick={openModelMenu}
                      className="flex items-center gap-1 h-7 px-2 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                      title="本对话模型与思考强度（仅本对话生效，默认跟随 设置→AI 默认模型）">
                      <Bot size={11} />
                      <span className="max-w-[140px] truncate">{effModelBare || '默认'}</span>
                      {convoEffort !== 'off' && <span className="text-[var(--accent)]">· 🧠{EFFORT_LABEL[convoEffort]}</span>}
                      <ChevronRight size={10} className="-rotate-90 shrink-0" />
                    </button>
                    {modelMenuOpen && (
                      <div className="absolute bottom-full right-0 mb-1.5 w-[280px] z-30 rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl overflow-hidden select-none">
                        <div className="px-3 py-1.5 text-[10.5px] text-[var(--text-muted)] bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">回答模型 · 仅本对话生效</div>
                        <div className="max-h-[300px] overflow-y-auto py-1">
                          {providerList.filter(p => p.enabled && p.models.length > 0).flatMap(p =>
                            p.models.map(mm => {
                              const val = `${p.id}:${mm}`
                              const sel = effModel === val
                              return (
                                <button key={val} onClick={() => pickModel(val)}
                                  className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-[11.5px] hover:bg-[var(--bg-hover)] transition-colors ${sel ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                                  <span className="text-[9.5px] text-[var(--text-muted)] shrink-0">{p.name}</span>
                                  <span className="truncate flex-1">{mm}</span>
                                  {sel && <span className="shrink-0">✓</span>}
                                </button>
                              )
                            }))}
                          {providerList.filter(p => p.enabled && p.models.length > 0).length === 0 && (
                            <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">尚无启用的供应商（设置 → AI 模型中添加）</div>
                          )}
                        </div>
                        <div className="px-3 py-1.5 text-[10.5px] text-[var(--text-muted)] bg-[var(--bg-secondary)] border-t border-b border-[var(--border-color)]">视觉转写模型（素材转写用 · 全局）</div>
                        <div className="max-h-[180px] overflow-y-auto py-1">
                          <button onClick={() => pickVision('')}
                            className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-[11.5px] hover:bg-[var(--bg-hover)] transition-colors ${!visionModel ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                            <span className="truncate flex-1">自动识别（按模型名：qwen-vl / glm-4v / gpt-4o…）</span>
                            {!visionModel && <span className="shrink-0">✓</span>}
                          </button>
                          {(() => {
                            // 只列视觉特征模型（vision/vl/4o/glm-4v/gemini/kimi-vision…）；正则漏判时「显示全部」兜底
                            const list = showAllVision
                              ? providerList.filter(p => p.enabled && p.type === 'openai-compatible' && p.models.length > 0).flatMap(p => p.models.map(mm => ({ spec: `${p.id}:${mm}`, providerName: p.name, model: mm })))
                              : visionList
                            return (
                              <>
                                {list.map(v => {
                                  const sel = visionModel === v.spec
                                  return (
                                    <button key={v.spec} onClick={() => pickVision(v.spec)}
                                      className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-[11.5px] hover:bg-[var(--bg-hover)] transition-colors ${sel ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                                      <span className="text-[9.5px] text-[var(--text-muted)] shrink-0">{v.providerName}</span>
                                      <span className="truncate flex-1">{v.model}</span>
                                      {sel && <span className="shrink-0">✓</span>}
                                    </button>
                                  )
                                })}
                                {list.length === 0 && (
                                  <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">没有识别到视觉模型（模型名需含 vision/vl/4o/glm-4v 等特征）。</div>
                                )}
                                {providerList.some(p => p.enabled && p.type === 'openai-compatible' && p.models.length > 0) && (
                                  <button onClick={() => setShowAllVision(v => !v)}
                                    className="w-full px-3 py-1 text-left text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                                    {showAllVision ? '▲ 收起，只看视觉模型' : '▼ 显示全部模型（若你确认某模型支持图片但未被识别）'}
                                  </button>
                                )}
                              </>
                            )
                          })()}
                        </div>
                        <div className="px-3 py-1.5 text-[10px] text-[var(--text-muted)] border-t border-[var(--border-color)] bg-[var(--bg-secondary)] space-y-0.5">
                          <div>本月用量 · 回答：{(usage?.monthTokens ?? 0).toLocaleString()} tokens{(usage?.monthPromptTokens != null || usage?.monthCompletionTokens != null) ? `（↑ ${(usage?.monthPromptTokens ?? 0).toLocaleString()} / ↓ ${(usage?.monthCompletionTokens ?? 0).toLocaleString()}）` : ''}</div>
                          <div>本月用量 · 视觉转写：{(usage?.visionMonthTokens ?? 0).toLocaleString()} tokens / {(usage?.visionPages ?? 0)} 页</div>
                        </div>
                        <div className="px-3 pt-1.5 flex items-center justify-between border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
                          <span className="text-[10.5px] text-[var(--text-muted)]">思考强度</span>
                          {!modelCapable && <span className="text-[10px] text-[var(--text-muted)]">当前模型不支持</span>}
                        </div>
                        <div className={`flex gap-1 px-3 py-2 bg-[var(--bg-secondary)] ${modelCapable ? '' : 'opacity-40 pointer-events-none'}`}>
                          {(['off', 'low', 'medium', 'high'] as const).map(e => (
                            <button key={e} onClick={() => pickEffort(e)}
                              className={`flex-1 px-1 py-0.5 rounded-md text-[11px] transition-colors ${convoEffort === e ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>
                              {EFFORT_LABEL[e]}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* UI 优化条目9②③：用量指示（圆环/数字降级）——hover 看上下文构成摘要，点击上翻详情面板；
                      档位由 设置→AI教学 `ctxUsageDetail`（off/compact/detailed），窗口大小 `ctxWindow`（F-12 提为通用键） */}
                  {usageDetail !== 'off' && (
                    <div className="relative group">
                      <button onClick={() => setTokenOpen(v => !v)}
                        className={`flex items-center gap-1 h-7 px-2 rounded-md transition-colors ${tokenOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
                        title={ctxWindow > 0 ? `上下文占用 ${fmtTok(ctxUsed)} / ${fmtTok(ctxWindow)} · 点击查看明细（窗口大小在 设置→AI教学 配置）` : '本会话累计 LLM tokens · 点击查看明细（设置模型上下文窗口后圆环按占用比例着色）'}>
                        <UsageRing pct={ctxWindow > 0 ? ctxPct : null} used={ctxUsed || tokenStats.llmTokens} />
                        {usageDetail === 'detailed' && (
                          <span className="tabular-nums whitespace-nowrap text-[10.5px]">
                            {ctxWindow > 0 ? `${fmtTok(ctxUsed)}/${fmtTok(ctxWindow)}` : `会话 ≈${fmtTok(tokenStats.llmTokens)}`}
                          </span>
                        )}
                      </button>
                      {!tokenOpen && (
                        <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 hidden group-hover:block w-[248px] z-30 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl px-2.5 py-2 text-[10.5px] leading-relaxed">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[var(--text-muted)] shrink-0">上下文已用</span>
                            <span className="tabular-nums text-[var(--text-primary)] truncate">
                              {ctxWindow > 0 ? `${fmtTok(ctxUsed)} / ${fmtTok(ctxWindow)} · 剩 ${fmtTok(Math.max(0, ctxWindow - ctxUsed))}` : `${fmtTok(ctxUsed)}（未设窗口）`}
                            </span>
                          </div>
                          {injParts.length > 0 ? (
                            <div className="mt-1 border-t border-[var(--border-color)] pt-1">
                              <div className="text-[var(--text-muted)]">本轮 system 注入构成（≈2.6 字/token 估算）</div>
                              {injParts.map(p => (
                                <div key={p.k} className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">{p.k}</span><span className="tabular-nums">{fmtTok(p.v)}</span></div>
                              ))}
                              <div className="flex items-center justify-between"><span className="text-[var(--text-secondary)]">对话历史与工具</span><span className="tabular-nums">{fmtTok(Math.max(0, ctxWindow - ctxUsed - injSystemEst))}</span></div>
                            </div>
                          ) : (
                            <div className="mt-1 text-[var(--text-muted)]">本轮尚无注入采样（发一条消息后可见构成）</div>
                          )}
                        </div>
                      )}
                      {tokenOpen && (
                        <div className="absolute bottom-full right-0 mb-1.5 w-[300px] z-30 rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl overflow-hidden select-text">
                          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
                            <span className="text-[11.5px] font-medium text-[var(--text-primary)]">用量明细</span>
                            <button onClick={() => setTokenOpen(false)} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><X size={12} /></button>
                          </div>
                          <div className="p-3 space-y-2.5 text-[11.5px] max-h-[60vh] overflow-y-auto">
                            <div className="flex items-center justify-between">
                              <span className="text-[var(--text-muted)]">模型</span>
                              <span className="text-[var(--text-primary)] truncate max-w-[190px]" title={effModel}>{effModelBare || defaultModel || '（默认配置）'}</span>
                            </div>
                            <div className="border-b border-[var(--border-color)] pb-2">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[var(--text-muted)]">上下文占用</span>
                                <span className="tabular-nums font-medium text-[var(--text-primary)]">{ctxWindow > 0 ? `${fmtTok(ctxUsed)} / ${fmtTok(ctxWindow)}` : `${fmtTok(ctxUsed)}（未设窗口）`}</span>
                              </div>
                              {ctxWindow > 0 && (
                                <div className="h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                                  <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.min(100, (ctxPct ?? 0) * 100)}%`, background: (ctxPct ?? 0) > 0.85 ? 'var(--danger)' : (ctxPct ?? 0) >= 0.7 ? 'var(--warning)' : 'var(--accent)' }} />
                                </div>
                              )}
                              <div className="mt-1 text-[10.5px] text-[var(--text-muted)] leading-relaxed">
                                口径 = 最近一次调用的输入 tokens（含 system 注入与工具定义）。{ctxWindow <= 0 && '在 设置 → AI教学 填模型上下文窗口后可见比例。'}
                              </div>
                              {injParts.length > 0 && (
                                <div className="mt-1.5 space-y-0.5">
                                  {injParts.map(p => (
                                    <div key={p.k} className="flex items-center justify-between text-[10.5px]"><span className="text-[var(--text-muted)]">{p.k}</span><span className="tabular-nums text-[var(--text-secondary)]">≈{fmtTok(p.v)}</span></div>
                                  ))}
                                  <div className="flex items-center justify-between text-[10.5px]"><span className="text-[var(--text-muted)]">对话历史与工具</span><span className="tabular-nums text-[var(--text-secondary)]">≈{fmtTok(Math.max(0, ctxWindow - injSystemEst))}</span></div>
                                </div>
                              )}
                            </div>
                            <div>
                              <div className="flex items-center justify-between">
                                <span className="text-[var(--text-muted)]">本会话 LLM tokens（累计）</span>
                                <span className="tabular-nums font-medium text-[var(--text-primary)]">{fmtTok(tokenStats.llmTokens)}{tokenStats.llmTokens >= 1000 ? `（${Math.round(tokenStats.llmTokens)}）` : ''}</span>
                              </div>
                              {tokenStats.hasSplit && (
                                <div className="mt-0.5 flex items-center justify-end gap-3 text-[10.5px] tabular-nums text-[var(--text-muted)]">
                                  <span>↑ {fmtTok(tokenStats.promptTokens)} 输入</span>
                                  <span>↓ {fmtTok(tokenStats.completionTokens)} 输出</span>
                                </div>
                              )}
                            </div>
                            <div className="grid grid-cols-3 gap-1.5 text-center">
                              {[['模型轮次', String(tokenStats.llmRounds)], ['工具调用', String(tokenStats.toolCalls)], ['耗时', `${Math.round(tokenStats.durationMs / 1000)}s`]].map(([k, v]) => (
                                <div key={k} className="rounded-lg bg-[var(--bg-secondary)] py-1.5">
                                  <div className="text-[10.5px] text-[var(--text-muted)]">{k}</div>
                                  <div className="tabular-nums text-[12px] font-medium">{v}</div>
                                </div>
                              ))}
                            </div>
                            <div className="border-t border-[var(--border-color)] pt-2">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[var(--text-muted)]">本月 LLM tokens</span>
                                <span className="tabular-nums">{fmtTok(monthTokens)}{budget > 0 && <span className="text-[var(--text-muted)]"> / {fmtTok(budget)}</span>}</span>
                              </div>
                              {(usage?.monthPromptTokens != null || usage?.monthCompletionTokens != null) && (
                                <div className="mb-1 flex items-center justify-end gap-3 text-[10.5px] tabular-nums text-[var(--text-muted)]">
                                  <span>↑ {fmtTok(usage?.monthPromptTokens ?? 0)} 输入</span>
                                  <span>↓ {fmtTok(usage?.monthCompletionTokens ?? 0)} 输出</span>
                                </div>
                              )}
                              {budget > 0 ? (
                                <div className="h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, (monthTokens / budget) * 100)}%`, background: monthTokens / budget > 0.85 ? '#a32d2d' : '#185fa5' }} />
                                </div>
                              ) : (
                                <div className="text-[10.5px] text-[var(--text-muted)]">未设月度预算（设置 → AI 可配置上限）</div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {/* P3b（R12）：流式输出中发送键 → 停止键（深色底白方块），点击中断、保留已落库内容 */}
                  {pending ? (
                    <button onClick={() => { void agentAbort(chatIdRef.current) }}
                      className="w-8 h-8 rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] flex items-center justify-center hover:opacity-80 transition-opacity"
                      title="停止生成（已完成的轮次保留）">
                      <span className="w-2.5 h-2.5 rounded-[2px] bg-current" />
                    </button>
                  ) : (
                    <button onClick={() => { void doSend() }} disabled={!input.trim()} title="发送"
                      className="w-8 h-8 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-all">
                      <ArrowUp size={15} />
                    </button>
                  )}
                </div>
  )

  return (
    <div className="kb-theme-surface h-full flex flex-col min-h-0 relative">
      {/* v3.8.0 §二：顶栏瘦身 —— 去掉会话页签与课程分段器（会话导航归左栏列表、课程切换归中栏视图切换器）；
          工作区 chip 改为面包屑「AI教学 / 工作区 / 会话名」，右侧仅留工具组 */}
      {activeWs ? (
      <>
      <div className="flex items-center gap-1 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 shrink-0 select-none">
        <button onClick={exitToPicker} title="返回工作区选择页"
          className="shrink-0 flex items-center gap-1 max-w-[260px] px-1.5 py-0.5 rounded-md text-[11.5px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          <Folder size={12} className="shrink-0 text-[var(--accent)]" />
          <span className="shrink-0 opacity-60">AI教学</span>
          <span className="shrink-0 opacity-30">/</span>
          <span className="truncate">{wsActive?.name ?? '工作区'}</span>
        </button>
        {activeId && (
          <>
            <span className="shrink-0 opacity-30">/</span>
            <span className="min-w-0 max-w-[220px] truncate text-[11.5px] text-[var(--text-secondary)]">{activeTitle || '未命名对话'}</span>
          </>
        )}
        <div className="flex-1 min-w-0" />
        <div className="shrink-0 flex items-center gap-0.5">

          {/* 顶栏工具组：**只图标不带文字**（窄栏不挤，含义靠 title 气泡；状态用右上角小圆点 / 数字）
              非当前会话不需要的入口不渲染；工件分栏 chip 只有存在工件页签时才出现 */}
          <button
            onClick={() => { if (activeId) void openProfile('session'); else showToast({ type: 'warning', message: '本主题画像随对话存放：先选择或新建一个对话' }) }}
            title="本主题画像（当前对话的 PROFILE.md · 对话内唯一编辑入口）。全局画像在「工作区选择页 → 学习者画像」卡片，工作区画像在各工作区卡片 hover「画像」；AI 每轮自动注入，冲突时以更细颗粒层为准"
            className="relative p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
            <User size={14} />
            {profPending && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--accent)]" title="AI 有画像更新建议待确认" />}
          </button>
          {/* 工件分栏开关（v3.8.0：工件 = 中栏右侧的独立分栏，与对话并排同屏）——
              有工件页签时才出现；点＝收/放分栏（页签不丢，收起后再点即回），页签数与状态进 title */}
          {artExpanded && (
            <button onClick={() => applyArtOpen(!artOpen)}
              title={artOpen ? `收起工件分栏（含 ${artTabs.length} 个页签，页签保留，再点即回）` : `展开工件分栏，与对话并排同屏（${artTabs.length} 个页签）`}
              className={`p-1 rounded-md transition-colors ${artOpen ? 'text-[var(--accent)] hover:bg-[var(--bg-hover)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
              <FileText size={14} />
            </button>
          )}
          {/* 右栏展开入口：右栏不可见时顶栏显示，点击展开（v3.8.0 §二改：右栏只剩 素材 / 支线，保持上次分区） */}
          {!srcVisible && (
            <button onClick={openRail} title="展开右栏（进度 / 素材 / 支线）"
              className="relative p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
              <PanelRightOpen size={14} />
              {!!courseState?.sourceCounts.total && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />}
            </button>
          )}
          {/* 会话要求（UI 优化条目8.1 方案 A：中型编辑弹层，规格对齐画像弹层；Ctrl+Enter 保存；阅读视图次级入口）。
              约束随会话存放（CONSTRAINTS.md 在会话夹内）——工作区没有任何会话时整个入口不渲染
              （2026-09-08 用户拍板：删除全部会话后也不出现，不只首次进入） */}
          {wsSessions.length > 0 && (
          <div className="relative shrink-0">
            <button
              onClick={() => { setInstrDraft(activeInstr); setInstrOpen(v => !v); if (activeId) void aiTeachReadConstraints(activeId).then(r => { const t = r?.ok && r.relPath ? (r.text ?? '').trim() : ''; setActiveInstr(t); setInstrDraft(t); if (r?.relPath) setInstrRel(r.relPath) }).catch(() => null) }}
              className={`relative p-1 rounded-md transition-colors ${activeInstr ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'} ${instrOpen ? 'bg-[var(--bg-hover)]' : ''}`}
              title="会话约束：写入本会话文件夹的 CONSTRAINTS.md，AI 每轮发送时重读（编辑器里可直接改）">
              <PenLine size={14} />
              {activeInstr && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />}
            </button>
          </div>
          )}
          {instrOpen && wsSessions.length > 0 && (
            <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30" onClick={() => setInstrOpen(false)}>
              <div className="w-[560px] max-w-[94vw] max-h-[86vh] flex flex-col rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl" onClick={e => e.stopPropagation()}>
                <div className="shrink-0 px-4 pt-3.5 pb-2">
                  <div className="flex items-center gap-2">
                    <PenLine size={14} className="text-[var(--accent)] shrink-0" />
                    <span className="text-[13px] font-medium text-[var(--text-primary)]">本会话约束</span>
                    <span className="text-[10.5px] text-[var(--text-muted)]">CONSTRAINTS.md · 唯一真相源，AI 每轮重读</span>
                    <button onClick={() => setInstrOpen(false)} className="ml-auto p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><X size={12} /></button>
                  </div>
                  <details className="mt-1.5 text-[11px] text-[var(--text-secondary)]">
                    <summary className="cursor-pointer select-none text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">怎么写？（模板与示例）</summary>
                    <div className="mt-1 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] px-3 py-2 leading-relaxed text-[var(--text-muted)]">
                      自由 Markdown，无固定字段。示例：<br />
                      · 只用中文回答，先给结论再展开<br />
                      · 这个对话只聊 Linux 内核，跑题请拉回<br />
                       · 每次回答结尾附一个表情<br />
                       （留空并保存 = 清除约束；此文件可在左栏资源管理器或编辑器直接改）<br />
                       <span className="text-[var(--text-muted)]">层级从细到粗：<b>本会话要求</b>（此文件，只作用于本对话）＞ <b>工作区要求</b>（本工作区所有会话，入口见下方）＞ <b>全局要求</b>（AI教学选择页，跨工作区所有会话）。写在哪一层，作用范围就到哪一层。</span>
                    </div>
                  </details>
                  {/* v3.1.2 条目6：本工作区要求入口（三层约束中间档）——仅当会话归属工作区时出现 */}
                  {activeWs && activeWs !== '__none__' && (
                    <button onClick={() => { setInstrOpen(false); void openWorkspaceConstraints() }} title={`编辑本工作区要求（${wsActive?.name ?? '工作区'}/CONSTRAINTS.md）——本工作区所有会话共同遵循，优先级低于本会话要求、高于全局要求`}
                      className="mt-1.5 flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline transition-colors">
                      🏷️ 本工作区要求（{wsActive?.name ?? '工作区'}）→
                    </button>
                  )}
                </div>
                <textarea
                  value={instrDraft}
                  spellCheck={false}
                  onChange={e => setInstrDraft(e.target.value)}
                  maxLength={2000}
                  placeholder={'把长期要求写在这里，例如：\n· 只用中文回答\n· 这个对话只聊 Linux 内核\n· 每次先给结论再展开\n（留空保存 = 清除）'}
                  className="flex-1 min-h-[320px] mx-4 px-3 py-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] text-[12.5px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-[var(--font-mono,var(--font-family))] resize-none"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveInstr() } }}
                />
                <div className="shrink-0 flex items-center gap-2 px-4 py-3">
                  {instrRel && (
                    <button onClick={() => { setInstrOpen(false); void openArtFile(instrRel) }} title="在工件栏阅读视图中打开本文件"
                      className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors truncate max-w-[220px]" >📖 在阅读视图中打开 →</button>
                  )}
                  {instrRel && <span className="truncate text-[10px] text-[var(--text-muted)] flex-1 min-w-0" title={instrRel}>{instrRel}</span>}
                  {!instrRel && <span className="flex-1" />}
                  {activeInstr && (
                    <button onClick={() => { setInstrDraft(''); void saveInstr() }}
                      className="text-[11.5px] px-2.5 py-1 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-red-400 hover:border-red-400/50 transition-colors">清除</button>
                  )}
                  <button onClick={() => { void saveInstr() }}
                    className="rounded-md bg-[var(--accent)] px-3.5 py-1.5 text-[12.5px] text-white hover:opacity-90 transition-opacity">保存（Ctrl+Enter）</button>
                </div>
              </div>
            </div>
          )}

          {/* UI 优化条目9①：顶栏用量 chip 退役——用量指示迁入输入区（与模型·思考同簇，见下方输入栏）；
              顶栏就此收敛为 工作区 chip + 页签 + 画像 + 会话要求 */}

          {/* P3b（§3.8-2/连锁）：顶栏「文档地图」退役——产物导航由逐条「整理成文档」+ P4 左栏资源管理器承接；
              顶栏恒为：会话要求 + Token 仪表 +（P5 工作区 chip）。
              原「禅模式」按钮已迁出：入口统一到命令面板「布局：禅模式」（全模块可用），本模块只消费档位 */}
        </div>
      </div>

      <div ref={rowRef} className="relative flex flex-1 min-h-0">
        {/* 左栏（P4 §3.7 + UI 优化条目2/3）：ResizablePanel 可调宽持久化 + 折叠贴边条（悬停高亮，点/拖展开）；
            分区体 grid-rows 动画常挂载（滚动/展开状态自然保留），折叠态 visibility 兜底 */}
        <ResizablePanel side="left" storageKey="aiTeach.leftWidth" defaultWidth={248} minWidth={200} maxWidth={400}
          visible={leftOpen} onSnapClose={() => toggleSide('left')} onSnapOpen={() => toggleSide('left')}
          collapsedWidth={14}>
          {/* v3.8.0 §二：工作区 switcher（顶部常驻）——选择页本身不变，这里只是快捷切换 */}
          {activeWs && (
            <div className="relative shrink-0 border-b border-[var(--border-color)]">
              <button onClick={() => setWsSwitcherOpen(v => !v)} title="切换工作区"
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[var(--bg-hover)] transition-colors">
                <Folder size={12} className="shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[var(--text-primary)]">{wsActive?.name ?? '工作区'}</span>
                <ChevronDown size={11} className={`shrink-0 text-[var(--text-muted)] kb-chevron ${wsSwitcherOpen ? 'rotate-180' : ''}`} />
              </button>
              {wsSwitcherOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setWsSwitcherOpen(false)} />
                  <div className="kb-pop absolute left-1 right-1 top-full mt-0.5 z-40 max-h-[60vh] overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl">
                    {wsList.filter(w => w.id !== '__none__').map(w => (
                      <button key={w.id} onClick={() => { setWsSwitcherOpen(false); if (w.id !== activeWs) enterWs(w.id) }}
                        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-[12px] transition-colors ${w.id === activeWs ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>
                        <Folder size={11} className="shrink-0 text-[var(--text-muted)]" />
                        <span className="min-w-0 flex-1 truncate">{w.name}</span>
                        {w.id === lastWsId && w.id !== activeWs && <span className="shrink-0 text-[9.5px] text-[var(--text-muted)]">上次</span>}
                      </button>
                    ))}
                    <div className="border-t border-[var(--border-color)]" />
                    <button onClick={() => { setWsSwitcherOpen(false); setWsModal({ mode: 'create', value: '' }) }}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] transition-colors">
                      <Plus size={11} /> 新建工作区
                    </button>
                    <button onClick={() => { setWsSwitcherOpen(false); exitToPicker() }}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
                      <ChevronLeft size={11} /> 工作区选择页
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {/* 收藏（顶部细行，v3.6.0）：钉住的活文档随手翻；0 条隐藏、默认收起、非并列分区 */}
          {favorites.length > 0 && (
            <div className="shrink-0 border-b border-[var(--border-color)]">
              <button onClick={() => setFavOpen((o) => !o)} title="钉住的文档，随手翻"
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[var(--bg-hover)] transition-colors">
                <Star size={12} className="shrink-0 text-[var(--warning)]" />
                <span className="text-[11.5px] font-semibold text-[var(--text-secondary)]">收藏</span>
                <span className="shrink-0 px-1.5 rounded-full bg-[var(--bg-hover)] text-[9.5px] text-[var(--text-muted)]">{favorites.length}</span>
                <span className="flex-1" />
                <ChevronDown size={11} className={`shrink-0 text-[var(--text-muted)] kb-chevron ${favOpen ? 'rotate-180' : ''}`} />
              </button>
              {favOpen && (
                <div className="px-1.5 pb-1.5 flex flex-col gap-0.5">
                  {favorites.map((f) => (
                    <div key={f.rel} className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-[var(--bg-hover)]">
                      <FileText size={11} className="shrink-0 text-[var(--text-muted)]" />
                      <button onClick={() => { void openArtFile(f.rel, { name: f.name }) }} title={f.rel}
                        className="min-w-0 flex-1 truncate text-left text-[12px] text-[var(--text-primary)]">{f.name.replace(/\.md$/i, '')}</button>
                      <button onClick={() => { void togglePin(f.rel, f.name) }} title="取消钉选"
                        className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"><X size={11} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* v3.1.2（开发负责人 2026-09-14）：会话列表区回归，与资源管理器「分区并列共存」——
              形态 A：会话（上，限高可折叠）+ 资源管理器（中，撑满剩余）。
              折叠任一分区，其余分区自动获得空间（原会话列表区曾因「页签即会话切换器」退役，本次恢复）。 */}
          {/* 左栏两分区 = 一个四轨 grid（会话头 / 会话体 / 资源管理器头 / 资源管理器体）。
              贴底原理见 .kb-rail-secs：资源管理器收起时第 4 轨归 0，剩余高度全给第 2 轨（auto）
              ⇒ 会话体撑满，把「资源管理器」条目压到侧栏底（对标 VS Code）。
              ★ 本容器不能 overflow-hidden —— 会话头的「新建对话」是绝对定位浮层，会被裁掉。 */}
          <div className={`kb-rail-secs ${!collapsedSec.sessions && collapsedSec.explorer ? 'kb-stick' : ''} ${!collapsedSec.explorer ? 'kb-open-explorer' : ''}`}>
          <SectionHead open={!collapsedSec.sessions} title="课程" onToggle={() => toggleSec('sessions')} />
          {/* 课程树（第 2 轨：展开且资源管理器收起时撑满，资源管理器展开时回到内容高 ≤38vh） */}
          <div className={`kb-collapse min-h-0 ${collapsedSec.sessions ? '' : 'open'}`}>
            <div className={`min-h-0 transition-opacity duration-150 ${collapsedSec.sessions ? 'opacity-0' : 'opacity-100'}`}>
              <div className={`h-full ${collapsedSec.explorer ? 'max-h-[38vh]' : ''}`}>
                <CourseRail
                  chapters={railVisible}
                  activeChapterId={railActiveChapter}
                  collapsed={collapsedChap}
                  onToggleChapter={toggleChap}
                  onActivateChapter={setActiveChapterState}
                  onUnit={(chapterId, unitId) => void courseOpenUnit(chapterId, unitId)}
                  onReview={(chapterId) => void courseOpenChapterReview(chapterId)}
                  assistantActive={!!assistantSid && activeId === assistantSid}
                  onAssistant={() => void courseOpenAssistant()}
                  search={railSearch}
                  onSearch={setRailSearch}
                  hasOutline={!!courseState?.outline?.chapters.length}
                />
              </div>
            </div>
          </div>
          <SectionHead open={!collapsedSec.explorer} title="资源管理器" onToggle={() => toggleSec('explorer')}
            right={(
              /* v3.2.0 条目 ④：与编辑器侧同语义的手动刷新（口径 b 全量：树重扫 + 知识索引/图谱失效
                 + 归档清单 prune）。右栏的 SOURCE.md / 约束 / 打开中的工件由 syncSessionFiles 一并回读 */
              <button
                onClick={() => {
                  if (treeRefreshing) return
                  setTreeRefreshing(true)
                  setTreeRefreshSeq(n => n + 1)
                  syncSessionFiles({ constraints: true })
                  void workspaceRefreshVault()
                    .then(r => { if (r.error) showToast({ type: 'error', message: r.error }) })
                    .catch(() => {})
                    .finally(() => setTreeRefreshing(false))
                }}
                disabled={treeRefreshing}
                title="刷新资源管理器"
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
              >
                <RefreshCw size={12} className={treeRefreshing ? 'animate-spin' : undefined} />
              </button>
            )} />
          {/* 资源管理器体 = 第 4 轨（0fr↔1fr，全模块唯一参与高度动画的轨道）。收起时轨道高 0 ⇒
              条目被顶到底；这里不再自带 grid-template-rows —— 高度由外层 .kb-rail-secs 给出，
              过渡也只留外层一处（原先这里过渡 flex-grow，属布局属性，越出铁律 13 允许集）。 */}
          <div className={`overflow-hidden min-h-0 transition-opacity duration-150 ${collapsedSec.explorer ? 'invisible opacity-0' : 'opacity-100'}`}>
            <div className="h-full min-h-0 pb-1">
              <AiTeachFileTree
                subRel={wsTreeSeg}
                refreshSeq={treeRefreshSeq}
                activeRel={(() => { const r = artTabs.find(t => t.id === artActive && !t.generating)?.rel ?? null; return r && r.startsWith(`${treeBase}/`) ? r.slice(treeBase.length + 1) : null })()}
                onOpenMd={treeOpenArt}
                onOpenHtml={treeOpenArt}
                onOpenImage={treeOpenArt}
                onOpenExternal={treeOpenExternal}
                isPinned={isPinned}
                onTogglePin={togglePin}
              />
              </div>
            </div>
          </div>
        </ResizablePanel>

        {/* 中栏（工件栏方案 §1.2 定稿）：对话主区固定、永不替换；原 docView/reader 分支整体迁入右缘工件栏页签 */}
        <section className="flex-1 flex flex-col min-w-0 min-h-0 relative">
          {preflight && preflightChapter ? (
            <Preflight
              key={`${preflight.chapterId}:${preflight.unitId}`}
              chapter={preflightChapter}
              units={preflightUnits}
              assignments={preflightAssignments}
              sources={preflightSources}
              initialUnitId={preflight.unitId}
              prevHandoff={preflight.prevHandoff}
              busy={preflightBusy}
              onCancel={() => setPreflight(null)}
              onConfirm={(unitIds, sources) => void startSegment(unitIds, sources)}
            />
          ) : (
            <>
              {/* 段 / 复习顶部上下文条 */}
              {activeSegment && activeId === activeSegmentSid && (
                <div className="shrink-0 flex items-center gap-2 px-4 pt-2 pb-1.5 border-b border-[var(--border-color)] select-none">
                  <span className="shrink-0 text-[11px] font-medium text-[var(--text-primary)]">{activeChapterObj?.name ?? '本段'}</span>
                  <span className="shrink-0 text-[10px] text-[var(--text-muted)]">第{activeSegment.order}段</span>
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-muted)]" title={activeSegmentUnitNames.join('、')}>{activeSegmentUnitNames.join('、')}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{activeSegmentUnitNames.length} 个知识点</span>
                  <div className="shrink-0 flex items-center gap-1">
                    {segmentStatus === 'open' && (
                      <button onClick={() => void courseEndSegment()} disabled={pending}
                        className="rounded-md border border-[var(--border-color)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40">收尾本段</button>
                    )}
                    <button onClick={() => openRequirements('segment')} title="本段要求（CONSTRAINTS.md）"
                      className="rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">要求</button>
                    <button onClick={() => { setRailTab('progress'); openRail() }} title="打开右栏进度"
                      className="rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">进度</button>
                  </div>
                </div>
              )}
              {courseReviewChapter && activeId && courseState?.reviews[courseReviewChapter]?.sessionId === activeId && (
                <div className="shrink-0 flex items-center gap-2 px-4 pt-2 pb-1.5 border-b border-[var(--border-color)] select-none">
                  <span className="shrink-0 text-[11px] font-medium text-[var(--text-primary)]">章末复习 · {courseReviewChapterName}</span>
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-muted)]">本章学完已解锁；复习不引入新知识点</span>
                  <div className="shrink-0 flex items-center gap-1">
                    {courseState?.reviews[courseReviewChapter]?.rel ? (
                      <button onClick={() => { const rel = courseState?.reviews[courseReviewChapter]?.rel; if (rel) void openArtFile(rel) }}
                        className="rounded-md border border-[var(--border-color)] px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">查看讲义</button>
                    ) : (
                      <button onClick={courseWriteReview} disabled={pending}
                        className="rounded-md bg-[var(--accent)] px-2 py-0.5 text-[10.5px] text-white disabled:opacity-40">生成复习讲义</button>
                    )}
                    <button onClick={() => openRequirements('workspace')} title="本课程要求（CONSTRAINTS.md）"
                      className="rounded-md px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">要求</button>
                  </div>
                </div>
              )}
              {activeInstr && !instrDismiss && (
                <div className="shrink-0 flex items-center gap-2 mx-4 mt-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)]">
                  <PenLine size={11} className="shrink-0 text-[var(--accent)]" />
                  <span className="flex-1 min-w-0 truncate" title={activeInstr}><b className="font-medium text-[var(--text-primary)]">本会话要求：</b>{activeInstr}</span>
                  <button onClick={() => { setInstrOpen(true); setInstrDraft(activeInstr) }} className="shrink-0 text-[var(--accent)] hover:underline">编辑</button>
                  <button onClick={() => setInstrDismiss(true)} title="隐藏（不删除）" className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={11} /></button>
                </div>
              )}
              <div className="relative flex-1 min-h-0">
              {/* v3.1.2 补强：支线旁问浮层已提到**行容器末尾**（见 rowRef 那一段）——
                  原先挂在这里只能在中栏里浮，现在要能跨左栏/中栏/工件栏自由拖动。 */}
              {/* 底部留白 48px = 「回到底部」浮标占位（bottom-3 12px + 按钮 36px）——浮标是 absolute 不占流，
                  若不留白就会盖住滚到下方时的最后一行文字。留白常驻（不随浮标显隐变化）→ 不产生二次回流。 */}
              <div ref={scrollRef} onScroll={onConvScroll} className="absolute inset-0 overflow-y-auto pl-4 pr-8 pt-3 pb-12 space-y-3 min-h-0">
                {messages.length === 0 && !pending && (
                  <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
                    <div className="text-[15px] font-medium text-[var(--text-primary)]">
                      {courseReviewChapter ? '章末复习' : activeSegment ? '本段开始' : activeId ? (assistantSid && activeId === assistantSid ? (courseState?.outline ? '课程助手' : '和课程助手建课') : '开始对话') : '从左侧开始'}
                    </div>
                    <div className="max-w-[420px] text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                      {courseReviewChapter
                        ? '本章知识点都学完了。把复习讨论整理成《复习讲义》，或按你的要求逐块回顾。'
                        : activeSegment
                          ? '本段只围绕左侧列出的知识点推进。讲完可点「收尾本段」，系统会生成交接给同章下一段。'
                          : assistantSid && activeId === assistantSid
                            ? '把资料和目标交给课程助手：它负责登记素材、给出章→知识点大纲、按章分配素材；开讲由你点知识点开段。'
                            : '从左侧点一个知识点开段，或点「课程助手」建课 / 改大纲。'}
                    </div>
                    {!activeId && (
                      <button onClick={() => void courseOpenAssistant()} className="mt-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11.5px] text-white hover:opacity-90">打开课程助手</button>
                    )}
                  </div>
                )}
                {messages.map((m, idx) => (
                  <div key={m.id ?? idx} data-msg-idx={idx} className={m.role === 'user' ? 'group relative flex justify-end' : 'min-w-0'}>
                    {m.role === 'user' ? (
                      /* 用户消息保留右侧气泡（§3.8-3：仅 AI 回复去气泡）；v3.1.1 条目6：
                         select-text = 全局 body user-select:none（防误选 UI）下对气泡的局部白名单恢复，
                         悬停时气泡左侧空白区浮出「复制」chip（绝对定位不挤布局，复制原始 m.content） */
                      <>
                        <div className="max-w-[86%] min-w-0 select-text bg-[var(--accent)] text-white rounded-xl rounded-br-sm px-3.5 py-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{m.content}</div>
                        <button onClick={() => { void navigator.clipboard.writeText(m.content).then(() => showToast({ type: 'info', message: '已复制本条消息' })).catch(() => null) }}
                          title="复制本条消息"
                          className="absolute right-full top-1/2 -translate-y-1/2 mr-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-md whitespace-nowrap text-[11.5px] text-[var(--text-muted)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-opacity">
                          <Copy size={11} />复制
                        </button>
                      </>
                    ) : (
                      /* P3a 去气泡：助手回复平铺 markdown 原生排版；P3b 轻量操作条（§3.8-3：整理成文档/复制/轨迹折叠） */
                      <div className="min-w-0">
                        {/* 过程收起来（默认收起）：思考时长 + 工具清单折成一行，点开是事件流 */}
                        <ProcessSummary rows={traceRows(m.trace)} />
                        {/* P8：```profile 建议块不直显；条目11/12：```plan / ```ask 协议块同样收敛（plan→侧栏、ask→提问卡） */}
                        <MarkdownPreview
                          content={splitJumps(m.content).body.replace(/```(profile|plan|ask|outline)[^\n]*\n[\s\S]*?```/g, '')}
                          onQuizRetry={retryQuiz}
                          codeBlockChrome="card"
                        />
                        {/* L4 引用网络：跳转 chip（AI 输出 `跳转：<知识点名>` → 打开最近段） */}
                        {splitJumps(m.content).jumps.map((name, k) => {
                          const hit = courseJumpByName.get(normName(name))
                          return (
                            <button key={k} disabled={!hit}
                              title={hit ? `打开「${name}」的最近段` : '该知识点还没有可回看的段（先收尾）'}
                              onClick={() => { if (hit) courseJump(name) }}
                              className="mr-1.5 mt-1.5 inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[11.5px] text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-50 transition-colors">
                              <ArrowRight size={11} />回顾：{name}
                            </button>
                          )
                        })}
                        {/* 工件栏方案 §2：visual.html 工件卡（对话流唯一形态，HTML 正文永不进流）——数据源=trace 里的 artifact step。
                            ★ 仍**排除 image**（v3.6.0 阶段二复核过）：图的"卡"就是图本身，下面 `ImageCard` 直接把它画出来了，
                              再叠一个「在工件栏打开 →」按钮是同一件事说两遍；产物页签由生成时的事件流自动开（转正/关闭都归工件栏管） */}
                        {(m.trace ?? []).some(s => s.artifact && s.artifact.kind !== 'image') && (
                          <div className="mt-1.5 space-y-1">
                            {(m.trace ?? []).filter(s => s.artifact && s.artifact.kind !== 'image').map((s, k) => {
                              const a = s.artifact as NonNullable<typeof s.artifact>
                              const isMind = a.kind === 'mindmap'
                              return (
                                <button key={k} onClick={() => { void openArtFile(a.rel, { title: a.title, lines: a.lines }) }} title={a.rel}
                                  className="w-full max-w-[440px] flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]/50 transition-colors text-left">
                                  {isMind ? <GitBranch size={13} className="shrink-0 text-[var(--accent)]" /> : <ImageIcon size={13} className="shrink-0 text-[var(--accent)]" />}
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[12px] text-[var(--text-primary)]">{a.title || a.rel.split('/').pop()}</span>
                                    <span className="block truncate text-[10px] text-[var(--text-muted)]">{isMind ? `思维导图 · ${a.nodes ?? 0} 节点` : `${a.rel} · ${a.lines} 行 · 单文件自包含`}</span>
                                  </span>
                                  <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">在工件栏打开 →</span>
                                </button>
                              )
                            })}
                          </div>
                        )}
                        {/* 生图卡（v3.6.0）：/生图 在 AI 教学面同样可用（阶段一产物落仓库 .attachments/），
                            卡面与助手面共用同一个组件 —— 两处各画一份迟早会长歪。
                            工件栏页签/文件树接线属阶段二（方案 §6），此处只渲染对话流里的卡。 */}
                        {imageGroupsOf(m.trace).map((group, gi) => (
                          <div key={`img-${gi}`} className="mt-1.5">
                            <ImageCard artifact={group[group.length - 1]} versions={group}
                              onPrefill={prefillImagePrompt}
                              onStop={() => { void agentAbort(chatIdRef.current) }} />
                          </div>
                        ))}
                        {(m.trace ?? []).filter(s => s.name === 'image' && s.ok === false).map((s, si) => (
                          <div key={`imgerr-${si}`} className="mt-1.5">
                            <ImageCard error={String(s.summary ?? '生图失败')}
                              errorPrompt={typeof s.args?.prompt === 'string' ? s.args.prompt : ''}
                              onPrefill={prefillImagePrompt} />
                          </div>
                        ))}
                        {/* 对话驱动建课：```outline 草稿卡 —— 内联在**产生它的这条回复**里，跟着对话滚动；
                            居中并与输入区那条带子左右对齐（同 `max-w-[820px] mx-auto px-3`）。
                            满意才「正式生成」落 课程.md；落盘后转「已落盘 · 课程.md + 打开课程」。
                            2026-10-14 拍板：从输入区带子挪进对话流、删「继续修改」、章节列表不再内部滚动。 */}
                        {outlineFence?.idx === idx && outlineDraft && (
                          <div className="mt-2 w-full max-w-[820px] mx-auto px-3">
                            <div className="kb-pop rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/8 px-3 py-2">
                              <div className="flex items-center gap-2">
                                <BookOpen size={12} className="shrink-0 text-[var(--accent)]" />
                                <span className="text-[12.5px] font-medium text-[var(--text-primary)]">课程大纲草稿</span>
                                <span className={`text-[10.5px] ${outlineCommitted ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
                                  {outlineCommitted ? '已落盘 · 课程.md' : '对话内 · 未落盘'}
                                </span>
                              </div>
                              <div className="mt-1.5 text-[12px] text-[var(--text-secondary)]">{outlineDraft.title || '课程大纲'}{outlineDraft.goal ? ` · ${outlineDraft.goal}` : ''}</div>
                              <div className="mt-1.5 flex flex-col gap-1">
                                {(outlineDraft.chapters || []).map((c, i) => (
                                  <div key={i} className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5">
                                    <div className="text-[12px] font-medium text-[var(--text-primary)]">
                                      第{i + 1}章 {c.name || '（未命名）'}
                                      {(!c.units || !c.units.length) && <span className="ml-1.5 text-[10.5px] font-normal text-[var(--text-muted)]">🔒 未展开（学完上一章再展开）</span>}
                                    </div>
                                    {(c.units || []).map((u, k) => (
                                      <div key={k} className="mt-0.5 pl-3 text-[11.5px] text-[var(--text-secondary)]">· {u.name}</div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                              <div className="mt-2 flex justify-end gap-2">
                                {outlineCommitted ? (
                                  <button type="button" onClick={openCourseOutline} title={`在编辑区打开 ${outlineDone?.rel || '课程.md'}`}
                                    className="px-3 py-1 rounded-md border border-[var(--accent)]/50 text-[var(--accent)] text-[11.5px] hover:bg-[var(--accent)]/10 transition-colors">打开课程</button>
                                ) : (
                                  <button type="button" onClick={() => void commitOutlineDraft()}
                                    className="px-3 py-1 rounded-md bg-[var(--accent)] text-white text-[11.5px] hover:bg-[var(--accent-hover)] transition-colors">正式生成</button>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {/* UI 优化条目4：操作条升格为轻 chip 条（11.5px+图标，对齐顶栏 chip 规范）；时间戳坏数据不渲染 */}
                        <div className="text-[11.5px] mt-1.5 flex items-center gap-1.5 -ml-1.5">
                          {/* v3.1.2 条目11：支线旁问入口（与整理成文档/复制/轨迹同簇）。
                              已开过支线的回答 → 按钮变「支线追问 · 已开」并高亮，点击在**右栏支线中心**重开原支线；
                              未开过 → 「就这点追问」在右栏中心新建一条（打开即输入，创建即已读）。
                              数据源=会话库派生（anchorLanes），不再依赖 localStorage。 */}
                          {(() => {
                            const al = m.id ? anchorLanes[m.id] : undefined
                            return (
                              <button onClick={() => openCenter(al ? { kind: 'open', laneId: al.laneId } : { kind: 'create', anchorMessageId: m.id ?? '' })}
                                title={al ? '这条回答已开过支线，点击在右栏重新打开' : '就这条回答的某一点开独立深挖线，不打断主线节奏'}
                                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors ${al ? 'text-[var(--accent)] hover:bg-[var(--bg-hover)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
                                <GitBranch size={12} />{al ? '支线追问 · 已开' : '就这点追问'}
                              </button>
                            )
                          })()}
                          <button onClick={() => { void organizeDocFor(m.content, idx, m.id) }}
                            className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors ${organized[m.id ?? `idx${idx}`] ? 'text-[var(--accent)] ring-1 ring-inset ring-[var(--accent)]/40' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
                            <FileOutput size={12} />{organized[m.id ?? `idx${idx}`] ? '✓ 已生成文档 →' : '整理成文档'}
                          </button>
                          {organized[m.id ?? `idx${idx}`] && (() => {
                            const rel = organized[m.id ?? `idx${idx}`]!
                            const on = isPinned(rel)
                            return (
                              <button onClick={() => { void togglePin(rel, rel.split('/').pop() || rel) }}
                                title={on ? '取消收藏' : '钉到收藏（左栏顶部随手翻）'}
                                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors ${on ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
                                <Star size={12} fill={on ? 'currentColor' : 'none'} />
                              </button>
                            )
                          })()}
                          <button onClick={() => { void navigator.clipboard.writeText(m.content).then(() => showToast({ type: 'info', message: '已复制本条回答' })).catch(() => null) }}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                            <Copy size={12} />复制
                          </button>
                          {fmtTime(m.createdAt) && <span className="text-[11px] text-[var(--text-muted)] tabular-nums ml-0.5">{fmtTime(m.createdAt)}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* V-2 附属增强：会话只有一条无回复的用户消息（模板开场发送失败等）时提供重发出口。
                    实现取简单方案——重发该消息文本，不关心模板来源；历史保留失败那条，用户可看出重发过 */}
                {!pending && messages.length === 1 && messages[0].role === 'user' && (
                  <div className="flex justify-center py-1">
                    <button
                      onClick={() => { void sendText(messages[0].content, crypto.randomUUID()) }}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      <RotateCcw size={11} className="text-[var(--warning)]" />
                      未收到 AI 回复？点击重发这条消息
                    </button>
                  </div>
                )}

                {pending && (streamDraft ? (
                  /* 流式过程（生成态）：状态行 + 下滑条 + 思考行 + 正文增量。
                     外壳与已完成消息同款 `min-w-0` 平铺 —— 不再套 max-w-[92%]：
                     正文落定后是满宽，窄一点会在最后一帧跳一下。 */
                  <div className="min-w-0">
                    <StreamBubble draft={streamDraft} textTransform={stripOpenFence} />
                  </div>
                ) : (
                  /* 兜底（无流式草稿）：换成**同一套状态行**，否则过程中会闪一下旧样式。
                     旧版这版的转圈与描边盒子一并去掉（R1/R3）——停止入口在输入区。 */
                  <div className="kb-gen-row">
                    <span className="kb-stage">
                      <span className="stage-label">
                        {!lastStep ? '正在等待模型响应…'
                          : lastStep.kind === 'tool'
                            ? (lastStep.ok
                              ? `正在${toolActionLabel(lastStep.name)}…`
                              : `执行 ${toolActionLabel(lastStep.name)} 失败，正在调整…`)
                            : '正在思考…'}
                      </span>
                      <span className="kb-sweep" />
                    </span>
                  </div>
                ))}

                {/* 生图（生成态 · v3.6.0）：占位框单独一档（它是"图位"，不是过程文本的一部分）。
                    与助手面同源（agent:step 的 image 跑动事件带 prompt/aspect）；停止钮在图上常显（C3）。 */}
                {pending && liveImagePending && (
                  <div className="mt-1">
                    <ImageCard pending={liveImagePending} onStop={() => { void agentAbort(chatIdRef.current) }} />
                  </div>
                )}
                </div>
                {/* 右缘快速定位条（§3.8-1，3-13）：每条回答一个刻度，hover 预览标题，点击滚动定位。
                    2026-09-08 用户拍板：锚点紧凑聚拢（顶部起 + 固定间距），不再 evenly 拉满整条高度 */}
                {anchors.length > 1 && (
                  <div className="absolute right-1 top-2 w-3 flex flex-col items-center justify-start gap-1.5 z-10">
                    {anchors.map((a, i) => (
                      <button key={a.idx} onClick={() => jumpToAnchor(a.idx)}
                        title={a.title}
                        className={`group relative w-1.5 rounded-full transition-all ${i === activeAnchor ? 'h-3 bg-[var(--accent)]' : 'h-1.5 bg-[var(--border-color)] hover:bg-[var(--text-muted)]'}`}>
                        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 hidden group-hover:block whitespace-nowrap max-w-[260px] truncate px-1.5 py-0.5 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[10px] text-[var(--text-primary)] shadow z-20">{a.title}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/* v3.2.0 条目6 规则3：不贴底时的「回到底部」浮标——圆 · 纯白底（暗色主题随 --bg-primary）·
                    无边框 · 柔和阴影 · 细线 ↓。进场走 .kb-pop（已被统一 reduced-motion 兜底覆盖）；
                    退场不排队动画：滚底后立刻消失才不挡视线。底部 48px 留白见 scrollRef 上的注释。 */}
                {jumpBottom && (
                  <button type="button" onClick={jumpToBottom} title="回到底部" aria-label="回到底部"
                    className="kb-pop absolute right-3 bottom-3 z-20 w-9 h-9 rounded-full flex items-center justify-center bg-[var(--bg-primary)] text-[var(--text-secondary)] shadow-lg hover:text-[var(--text-primary)] transition-colors">
                    <ArrowDown size={16} strokeWidth={1.75} />
                  </button>
                )}
              </div>

              {/* v3.2.0 第 20 项 · 安静入口：节流窗口内不再自动弹卡片，只留一行可点开的提示
                  （拍板口径：不打断心流但不错过 —— 点一下即展开完整卡片） */}
              {profQuiet && (
                <div className="shrink-0 w-full max-w-[820px] mx-auto px-3 pb-1 pt-1.5">
                  <button type="button" onClick={() => setProfExpanded(true)}
                    title={profThrottle.note || `本会话再过 ${PROFILE_THROTTLE_ROUNDS} 轮后恢复提示`}
                    className="kb-pop flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] transition-colors">
                    <User size={11} className="shrink-0" />
                    <span>{profileSuggestion?.mode === 'entries' ? `${profileSuggestion.entries.length} 条画像更新待确认` : '1 条画像更新待确认'}</span>
                  </button>
                </div>
              )}
              {/* P8（3-33 Plan B）+ v3.2.0 第 20 项：AI 画像更新建议 —— 逐条勾选 / 行内可改 / 选写入层。
                  容器与输入框同为 `max-w-[820px] mx-auto px-3`（原是 `mx-2`，右边界对不齐）→ 左边界逐像素对齐。 */}
              {profShow && profileSuggestion && (
                <div className="shrink-0 w-full max-w-[820px] mx-auto px-3 pb-1.5 pt-1.5">
                  <div className="kb-pop rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/8 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <User size={12} className="shrink-0 text-[var(--accent)]" />
                      <span className="text-[12px] text-[var(--text-primary)]">
                        AI 提议更新学习者画像 · {profileSuggestion.mode === 'entries' ? `${profRows.length} 处变化` : '整篇全文（旧格式）'}
                      </span>
                      {profileSuggestion.mode === 'entries' ? (
                        <>
                          <span className="ml-auto shrink-0 text-[10.5px] text-[var(--text-muted)]">写入到</span>
                          {profLayers.filter((l) => l.enabled).map((l) => (
                            <button key={l.id} type="button" onClick={() => setProfLayer(l.id)} title={l.title}
                              className={`shrink-0 px-1.5 py-0.5 rounded-md border text-[11px] transition-colors ${profLayer === l.id ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>{l.label}</button>
                          ))}
                        </>
                      ) : (
                        <span className="ml-auto shrink-0 text-[10.5px] text-[var(--text-muted)]">写入到 本主题</span>
                      )}
                    </div>
                    {profileSuggestion.mode === 'entries' ? (
                      <>
                        {/* 上层只做追加 —— 非 add 条目在此层级置灰，并就地说明原因（铁律 12：说明只收不删） */}
                        {profLayer !== 'session' && (
                          <div className="mt-1 text-[10.5px] text-[var(--text-muted)]">上层画像只做追加 —— 「修改 / 删除」类条目在此层级不可用（确要改上层，走顶栏「画像」跳编辑区直接改）。</div>
                        )}
                        <div className="mt-1.5 space-y-1">
                          {profRows.map((r, i) => {
                            const usable = layerAllows(profLayer, r.op)
                            return (
                              <div key={`${r.field}-${r.op}-${i}`} className="flex items-start gap-2">
                                <button type="button" disabled={!usable}
                                  onClick={() => setProfRows((rows) => rows.map((x, j) => (j === i ? { ...x, checked: !x.checked } : x)))}
                                  title={usable ? '勾选后写入' : '上层画像只做追加，不改写已有内容'}
                                  className={`shrink-0 mt-[2px] w-3.5 h-3.5 rounded-[3px] border flex items-center justify-center transition-colors ${usable ? (r.checked ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-[var(--border-color)] hover:border-[var(--accent)]') : 'border-[var(--border-color)] opacity-40 cursor-not-allowed'}`}>
                                  {r.checked && usable && <Check size={10} strokeWidth={3} />}
                                </button>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="shrink-0 px-1 rounded text-[10.5px] text-[var(--text-secondary)] bg-[var(--bg-hover)]">{r.field}</span>
                                    <span className={`shrink-0 px-1 rounded text-[10.5px] ${r.op === 'add' ? 'text-[var(--success)]' : r.op === 'update' ? 'text-[var(--warning)]' : 'text-[var(--danger)]'}`}>{r.op === 'add' ? '新增' : r.op === 'update' ? '修改' : '删除'}</span>
                                    {/* 行内可改：改过即以用户版本为准（AI 原文不直接落盘） */}
                                    <input value={r.text} disabled={!usable}
                                      onChange={(e) => setProfRows((rows) => rows.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                                      className="min-w-0 flex-1 bg-transparent outline-none text-[11.5px] text-[var(--text-primary)] border-b border-transparent focus:border-[var(--accent)] disabled:opacity-50" />
                                  </div>
                                  {r.op === 'update' && r.from && (
                                    <div className="mt-0.5 text-[10.5px] text-[var(--text-muted)] line-through">原：{r.from}</div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="mt-1.5 text-[10.5px] text-[var(--text-muted)]">AI 给的是「整篇全文」形态的建议（旧格式）—— 只能写入本主题层，上层不允许被整篇覆盖。</div>
                        <div className="mt-1.5">
                          {/* 条目7 根因2：由 scrollIntoView 改为就地展开；「建议内容全文」这行文案收进 title（铁律 12：只收不删） */}
                          <button type="button" onClick={() => setProfPreviewOpen(v => !v)} aria-expanded={profPreviewOpen}
                            title={profPreviewOpen ? '收起（建议内容全文）' : '预览（建议内容全文）'}
                            className="shrink-0 px-1.5 py-0.5 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">{profPreviewOpen ? '收起' : '预览'}</button>
                        </div>
                        {/* 折叠走既有 .kb-collapse（经 Collapsible 封装）——铁律 13 的面板开合令牌，不另造过渡。
                            外层 grid 容器常驻，故收起态零高度；子树在收起动画播完后才卸载（懒语义同文件树）。 */}
                        <Collapsible open={profPreviewOpen} className="mt-1.5">
                          {() => (
                            <div className="max-h-40 overflow-y-auto">
                              <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-secondary)] font-[var(--font-mono,var(--font-family))]">{profileSuggestion.text}</pre>
                            </div>
                          )}
                        </Collapsible>
                      </>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[10.5px] text-[var(--text-muted)]">
                        {profileSuggestion.mode === 'entries' ? (profUsableCount > 0 ? `已选 ${profUsableCount} 条` : '未选任何条目') : '写入后下轮生效'}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <button type="button" onClick={() => muteProfileSuggestion('ignored')}
                          title={`忽略本条建议：本会话再过 ${PROFILE_THROTTLE_ROUNDS} 轮、或 30 分钟后才恢复提示（窗口内可点输入区上方那行小字重新打开）`}
                          className="shrink-0 px-1.5 py-0.5 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] transition-colors">忽略</button>
                        <button type="button" onClick={() => { void applyProfileSuggestion() }}
                          disabled={profileSuggestion.mode === 'entries' && profUsableCount === 0}
                          className="shrink-0 px-2 py-0.5 rounded-md bg-[var(--accent)] text-white text-[11px] hover:opacity-90 disabled:opacity-40 transition-opacity">
                          {`写入${profLayers.find((l) => l.id === profLayer)?.label ?? ''}`}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <div className="shrink-0 w-full max-w-[820px] mx-auto px-3 pb-2.5 pt-2">
                {/* v3.1.2 条目7：会话准备态 —— 未开讲时输入区位置显示准备面板（素材 / 会话要求 / 首条消息）
                    与正常输入框同一块区域互斥切换；点「开始对话」才发首条消息。 */}
                {askVisible && askPending ? (
                <>
                {/* UI 优化条目12/13：未答 ```ask 块 → 输入区变形为提问卡（单题选择卡 / 整卷模式）；
                    「自由输入」随时切回打字（ask 标记忽略，输入框恢复） */}
                {(() => {
                  /* 提问卡 v2（WorkBuddy 式版式）：题干头行 + ‹k/n› 翻页 + ✕；序号横条选项（整卷点选/单题点选即发）；
                     「✎ 其他补充…」= 自定义回答输入；右下圆形 ↑ 发送（整卷=全部选完统一发送，单题=发送补充内容）。
                     定位边界：ask 只用于「下一步工作」类流程澄清 + 会话级画像诊断（§13.3）——全局/工作区画像仅在编辑区编辑 */
                  const exam = askPending.kind === 'exam'
                  const n = exam ? askPending.questions.length : 1
                  const page = Math.min(askPage, n - 1)
                  const curQ = exam ? askPending.questions[page].question : askPending.question
                  const curOpts = exam ? askPending.questions[page].options : askPending.options
                  const pickedCur = exam ? askPicks[page] : undefined
                  const pickedCount = exam ? Object.keys(askPicks).length : 0
                  /** 本题当前答的是「其他补充」：用独立标记，避免自定义文本恰好等于某选项时丢失补充行 */
                  const hasCustomAnswer = exam && pickedCur !== undefined && askCustomPicks[page] === true
                  const customDraft = askCustomDrafts[page] ?? ''
                  const customOpen = askCustomOpen[page] === true
                  /** 当前输入等于一道还没记录的答案 —— ↑ 要把它算进可提交数（B-44 根因 4） */
                  const draftFillsAnswer = exam && customOpen && !!customDraft.trim() && askPicks[page] === undefined
                  const submitCount = pickedCount + (draftFillsAnswer ? 1 : 0)
                  /** 别的题还开着补充编辑且草稿未确认：避免整卷 ↑ 跨页静默丢掉那段字（B-44 根因 4 的跨页版） */
                  const otherDraftPending = exam && Object.entries(askCustomOpen).some(([k, open]) => {
                    const p = Number(k)
                    if (!open || p === page) return false
                    const d = (askCustomDrafts[p] ?? '').trim()
                    return !!d && askPicks[p] !== d
                  })
                  const canSubmitExam = !exam || (submitCount >= n && !otherDraftPending)
                  const openCustom = () => {
                    setAskCustomOpen(p => ({ ...p, [page]: true }))
                    // 已记录的自定义答案回填；否则保留本题草稿（翻页回来可继续）
                    setAskCustomDrafts(p => ({ ...p, [page]: hasCustomAnswer ? (pickedCur ?? '') : (p[page] ?? '') }))
                  }
                  const cancelCustom = () => {
                    setAskCustomOpen(p => ({ ...p, [page]: false }))
                    setAskCustomDrafts(p => {
                      const next = { ...p }
                      if (hasCustomAnswer) next[page] = pickedCur ?? ''
                      else delete next[page]
                      return next
                    })
                  }
                  const submitCustom = () => {
                    if (pending) return
                    const v = customDraft.trim()
                    if (!v) return
                    if (!exam) {
                      setAskCustomDrafts(p => { const next = { ...p }; delete next[page]; return next })
                      setAskCustomOpen(p => ({ ...p, [page]: false }))
                      sendAskAnswer(v)
                      return
                    }
                    const prev = askPicks[page]
                    setAskPicks(p => ({ ...p, [page]: v }))
                    setAskCustomPicks(p => ({ ...p, [page]: true }))
                    setAskCustomDrafts(p => { const next = { ...p }; delete next[page]; return next })
                    setAskCustomOpen(p => ({ ...p, [page]: false }))
                    // 覆盖旧答案（选项或旧补充）给一次轻反馈；首次补充由 .kb-item-in 行出现即可
                    if (prev !== undefined && prev !== v) {
                      showToast({ type: 'info', message: n > 1 ? `第 ${page + 1} 题的回答已更新` : '回答已更新' })
                    }
                  }
                  return (
                    <div className="w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg px-3.5 pt-3 pb-2.5">
                      {/* 头行（条目9 双态把手）：展开 = 题干 + ‹k/n› + 收起钮 + ✕；收起 = 细 chip（点击展开，✕ 仍可直接忽略） */}
                      {askCollapsed ? (
                        <div className="flex items-center gap-2 cursor-pointer select-none" onClick={() => setAskCollapsed(false)} title="展开提问卡（Esc 再按 = 忽略）">
                          <ChevronDown size={13} className="shrink-0 text-[var(--text-muted)]" />
                          <span className="flex-1 min-w-0 truncate text-[12.5px] text-[var(--text-secondary)]">待回答：{curQ}</span>
                          {exam && <span className="shrink-0 text-[10.5px] text-[var(--text-muted)] tabular-nums">已答 {pickedCount}/{n}</span>}
                          <button onClick={e => { e.stopPropagation(); setAskDismissed(askPending.id) }} title="关闭提问卡，自由打字回答"
                            className="p-0.5 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shrink-0"><X size={13} /></button>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0 text-[13px] leading-relaxed text-[var(--text-primary)]">{curQ}</div>
                          {n > 1 && (
                            <div className="flex items-center gap-0.5 shrink-0 text-[var(--text-muted)]">
                              <button onClick={() => setAskPage(p => Math.max(0, p - 1))} disabled={page === 0}
                                className="p-0.5 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30 transition-colors"><ChevronLeft size={13} /></button>
                              <span className="text-[11px] tabular-nums px-0.5">{page + 1} / {n}</span>
                              <button onClick={() => setAskPage(p => Math.min(n - 1, p + 1))} disabled={page === n - 1}
                                className="p-0.5 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30 transition-colors"><ChevronRight size={13} /></button>
                            </div>
                          )}
                          <button onClick={() => setAskCollapsed(true)} title="收起提问卡（Esc 亦可），点选状态保留"
                            className="p-0.5 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shrink-0"><ChevronDown size={13} /></button>
                          <button onClick={() => setAskDismissed(askPending.id)} title="关闭提问卡，自由打字回答"
                            className="p-0.5 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors shrink-0"><X size={13} /></button>
                        </div>
                      )}
                      {/* 选项 + 底部：收起动效走 .kb-collapse（grid-rows 折叠壳，条目9）；选项区 40vh 兜底内滚，整卷多题不再无限撑高 */}
                      <Collapsible open={!askCollapsed}>
                      {() => (<>
                      <div className="pt-2 max-h-[40vh] overflow-y-auto space-y-0.5">
                        {curOpts.map((o, oi) => {
                          // 补充答案有独立标记：它占了本题的「唯一高亮」，选项行不再高亮（B-44）
                          const picked = exam ? pickedCur === o && askCustomPicks[page] !== true : false
                          return (
                            <button key={o} disabled={pending}
                              onClick={() => {
                                if (!exam) { sendAskAnswer(o); return }
                                const prev = askPicks[page]
                                setAskPicks(p => ({ ...p, [page]: o }))
                                setAskCustomPicks(p => { const next = { ...p }; delete next[page]; return next })
                                // 选项是明确选择：收起补充编辑器（草稿保留，可再点「继续编辑补充」）
                                setAskCustomOpen(p => ({ ...p, [page]: false }))
                                // 选项覆盖掉一条补充答案时给轻反馈（补充行会消失）；首次点选 / 选项互切靠高亮移动即可
                                if (prev !== undefined && prev !== o && askCustomPicks[page] === true) {
                                  showToast({ type: 'info', message: n > 1 ? `第 ${page + 1} 题的回答已更新` : '回答已更新' })
                                }
                              }}
                              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left text-[12.5px] transition-colors disabled:opacity-40 ${
                                picked ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'border-transparent hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'}`}>
                              <span className={`w-5 h-5 rounded-full border flex items-center justify-center text-[10px] shrink-0 ${picked ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}>{oi + 1}</span>
                              <span className="flex-1 min-w-0">{o}</span>
                              {picked && <ArrowRight size={13} className="text-[var(--accent)] shrink-0" />}
                            </button>
                          )
                        })}
                        {/* 其他补充：自定义回答（整卷 = 当前题答案；单题 = Enter/↑ 直接发出） */}
                        {hasCustomAnswer && (
                          <div key={`custom-${page}-${pickedCur}`} data-wb="aiTeachAskCustomAnswer"
                            className="kb-item-in w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-[var(--accent)] bg-[var(--accent)]/10 text-left text-[12.5px] text-[var(--text-primary)]">
                            <span className="w-5 h-5 rounded-full border border-[var(--accent)] bg-[var(--accent)] text-white flex items-center justify-center shrink-0"><PenLine size={11} /></span>
                            <span className="flex-1 min-w-0 break-words">{pickedCur}</span>
                            {customOpen ? (
                              <span className="shrink-0 text-[10px] text-[var(--accent)]">编辑中</span>
                            ) : (
                              <button onClick={openCustom} disabled={pending} title="修改这条补充回答"
                                className="shrink-0 px-1.5 py-0.5 rounded text-[10.5px] text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40 transition-colors">编辑</button>
                            )}
                            <ArrowRight size={13} className="text-[var(--accent)] shrink-0" />
                          </div>
                        )}
                        {customOpen && (
                          <div className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--accent)] bg-[var(--bg-primary)]">
                            <PenLine size={12} className="text-[var(--accent)] shrink-0" />
                            <input autoFocus value={customDraft} disabled={pending}
                              onChange={e => setAskCustomDrafts(p => ({ ...p, [page]: e.target.value }))}
                              onKeyDown={e => {
                                if (e.key === 'Escape') {
                                  // 中文输入法正在组合时，Esc 交给 IME 取消候选词；不让它顺手收起提问卡
                                  if (e.nativeEvent.isComposing) { e.stopPropagation(); return }
                                  e.preventDefault(); e.stopPropagation(); cancelCustom(); return
                                }
                                if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submitCustom() }
                              }}
                              placeholder="补充你的回答…（Enter 确认）"
                              data-wb="aiTeachAskCustomInput"
                              className="flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none disabled:opacity-50" />
                            <button onClick={cancelCustom} disabled={pending} title="取消补充（保留原答案）"
                              className="shrink-0 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40">取消</button>
                            <span className="text-[10px] text-[var(--text-muted)] shrink-0">Enter 确认</span>
                          </div>
                        )}
                        {!customOpen && !hasCustomAnswer && (
                          <button onClick={openCustom} disabled={pending} data-wb="aiTeachAskCustomOpen"
                            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[12.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
                            <PenLine size={13} className="shrink-0" /> {customDraft.trim() ? '继续编辑补充…' : '其他补充…'}
                          </button>
                        )}
                      </div>
                      {/* 底部：进度 + 圆形 ↑ 发送 */}
                      <div className="mt-1.5 flex items-center">
                        {exam && (
                          <span className="text-[10.5px] text-[var(--text-muted)] mr-auto tabular-nums">
                            已答 {pickedCount}/{n}
                            {canSubmitExam
                              ? (draftFillsAnswer ? ' · 含当前补充，可提交' : ' · 可提交')
                              : otherDraftPending ? ' · 有未确认补充' : ' · ‹›翻页作答'}
                          </span>
                        )}
                        <button
                          onClick={() => {
                            if (!exam) { submitCustom(); return }
                            // 整卷 ↑ 先把当前输入记到本题，再统一发送（B-44 根因 4）
                            const draft = customOpen ? customDraft.trim() : ''
                            if (draft) {
                              setAskPicks(p => ({ ...p, [page]: draft }))
                              setAskCustomPicks(p => ({ ...p, [page]: true }))
                              setAskCustomDrafts(p => { const next = { ...p }; delete next[page]; return next })
                              setAskCustomOpen(p => ({ ...p, [page]: false }))
                              submitAskExam({ page, value: draft })
                              return
                            }
                            submitAskExam()
                          }}
                          disabled={pending || (exam ? !canSubmitExam : !(customOpen && customDraft.trim()))}
                          title={exam
                            ? (otherDraftPending ? '还有未确认的补充：翻回该题按 Enter 或取消' : `统一发送全部回答（${submitCount}/${n}）`)
                            : '发送补充回答'}
                          className="ml-auto w-8 h-8 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-all">
                          <ArrowUp size={15} />
                        </button>
                      </div>
                      </>)}
                      </Collapsible>
                    </div>
                  )
                })()}
                {composerFooter}
                </>
                ) : (
                  <div className={`relative px-3 pt-2.5 pb-2 ${shell.wrap}`}>
                    <AiMascotAnchor />
                    {quotes.length > 0 && (
                      <div className="mb-1.5">
                        {/* 引用胶囊（会话引用形式）：不展示全文只报条数，点开管理；× 一键全清 */}
                        <div className="flex items-center gap-1.5">
                          <button type="button" onClick={() => setQuotesOpen(o => !o)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                            title="点击查看/管理引用片段">
                            <Quote size={10} className="text-[var(--accent)]" />
                            <span>{quotes.length} 条对话引用</span>
                          </button>
                          <button type="button" onClick={() => { quotesRef.current = []; setQuotes([]); setQuotesOpen(false) }} title="移除全部引用"
                            className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                            <X size={11} />
                          </button>
                        </div>
                        {quotesOpen && (
                          <div className="mt-1 space-y-1">
                            {quotes.map((q, i) => (
                              <div key={`${i}-${q.slice(0, 16)}`} className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                                <Quote size={11} className="mt-[3px] shrink-0 text-[var(--accent)]" />
                                <span className="flex-1 min-w-0 text-[11px] leading-[1.5] text-[var(--text-secondary)] line-clamp-3">【引用 {i + 1}】{q}</span>
                                <button type="button" onClick={() => setQuotes(prev => { const next = prev.filter((_, j) => j !== i); quotesRef.current = next; return next })} title="移除此引用"
                                  className="shrink-0 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                                  <X size={11} />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {compressing && (
                      <div className="mb-1.5 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] kb-pop">
                        <Loader2 size={12} className="animate-spin shrink-0 text-[var(--accent)]" />
                        正在压缩对话历史…（可能数十秒，期间暂不能发送）
                      </div>
                    )}
                    {pickedSkill && (
                      <div className="mb-1.5">
                        <span className="inline-flex items-center gap-1 max-w-full px-2 py-0.5 rounded-md bg-[var(--bg-selected)] border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)]">
                          <Sparkles size={10} className="shrink-0 text-[var(--accent)]" />
                          <span className="truncate">Skill：{pickedSkill.title} · 本轮显式生效</span>
                          <button type="button" onClick={() => setPickedSkill(null)} title="移除该 Skill"
                            className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"><X size={10} /></button>
                        </span>
                      </div>
                    )}
                    {activeSegment && activeId === activeSegmentSid && prevHandoff && (
                      <div className="mb-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden kb-view-in">
                        <button type="button" onClick={() => setHandoffOpen(v => !v)}
                          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
                          <ChevronDown size={12} className={`transition-transform ${handoffOpen ? '' : '-rotate-90'}`} />
                          上一段交接（同章）
                        </button>
                        {handoffOpen && (
                          <div className="px-2.5 pb-2 text-[11.5px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap max-h-[160px] overflow-y-auto">{prevHandoff.replace(/^#[^\n]*\n?/, '')}</div>
                        )}
                      </div>
                    )}
                    {activeSegment && activeId === activeSegmentSid && (
                      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 kb-view-in">
                        {lessonUnitIds(activeSegment).map((uid) => {
                          const name = courseUnits.find((u) => u.id === uid)?.name ?? uid
                          const on = activeUnitId === uid
                          return (
                            <button key={uid} type="button" disabled={segmentStatus === 'ended'}
                              onClick={() => {
                                if (!activeSegmentSid) return
                                void aiTeachCourseSetActiveUnit(activeSegmentSid, uid).then((r) => { if (r?.ok) setActiveUnitId(uid) })
                              }}
                              title={on ? '当前聚焦' : '切换本段聚焦知识点'}
                              className={`px-2.5 py-1 rounded-full border text-[11px] transition-colors ${on ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent)]/50 hover:text-[var(--accent)]'} disabled:opacity-50`}>
                              {name}
                            </button>
                          )
                        })}
                        {segmentStatus === 'ended' && <span className="text-[11px] text-[var(--text-muted)]">本段已收尾（只读）</span>}
                      </div>
                    )}
                    <div className="relative">
                      {slashOpen && (
                        <SlashCommandMenu items={slashItems} activeIndex={slashActive} onHover={setSlashActive} onPick={pickSlash} />
                      )}
                      <textarea ref={inputRef} spellCheck={false} value={input} onChange={e => { setInput(e.target.value); setSlashActive(0) }}
                        onKeyDown={e => { onSlashKeys(e); if (!e.defaultPrevented && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend() } }}
                        disabled={courseReadonly}
                        rows={2} placeholder={courseReadonly ? '本段已收尾（只读）· 要补充请开新段' : quotes.length > 0 ? '针对引用内容提问…（Enter 发送）' : '粘贴资料或输入指令…（Enter 发送，/ 唤起指令）'}
                        className="w-full appearance-none px-0.5 py-1 text-[13px] resize-none outline-none bg-transparent! border-0! rounded-none! disabled:opacity-60" />
                    </div>
                    {composerFooter}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        {/* v3.8.0：工件**独立分栏** —— 中栏右侧、与对话并排同屏（VS Code 分屏编辑器的形态）。
            ResizablePanel(side=right)：手柄在左缘、左拖变宽；拖过 minWidth/2 = snap-close（artOpen=false，页签不丢）；
            收起后留 12px 贴边条，点/左拖即回。宽度持久化在 aiTeach.artWidth。 */}
        <ResizablePanel side="right" storageKey="aiTeach.artWidth" defaultWidth={420} minWidth={280} maxWidth={780}
          visible={artExpanded && artOpen && !artZoom}
          onSnapClose={() => applyArtOpen(false)}
          onSnapOpen={artExpanded && !artZoom ? () => applyArtOpen(true) : undefined}
          collapsedWidth={12}
          onWidthChange={setArtPaneW}>
          <ArtifactsPane
            tabs={artTabs}
            activeId={artActive}
            widthPx={artPaneW > 0 ? artPaneW : 420}
            htmlSeq={htmlSeq}
            expanded={false}
            onToggleExpanded={setArtZoom}
            onActivate={setArtActive}
            onClose={closeArtTab}
            onReload={reloadArtTab}
            onPptxPage={setArtPptxPage}
            onTalkPage={talkArtPage}
            pending={pending}
            onEdit={artOpenInEditor}
            onOpenRef={artOpenRef}
          />
        </ResizablePanel>

        {/* ⤢ 全宽阅读：拿满整行（absolute inset-0 z-40；组件不卸载 → 对话滚动与 iframe 全存活）。
            此态下工件分栏不重复挂载 ArtifactsPane（避免两份实例各跑计时器；iframe 是 kbview:// 独立文档）。 */}
        {artExpanded && artZoom && (
          <div className="absolute inset-0 z-40 min-h-0">
            <ArtifactsPane
              tabs={artTabs}
              activeId={artActive}
              widthPx={rowW}
              htmlSeq={htmlSeq}
              expanded={artZoom}
              onToggleExpanded={setArtZoom}
              onActivate={setArtActive}
              onClose={closeArtTab}
              onReload={reloadArtTab}
              onPptxPage={setArtPptxPage}
              onTalkPage={talkArtPage}
              pending={pending}
              onEdit={artOpenInEditor}
              onOpenRef={artOpenRef}
            />
          </div>
        )}

        {/* 右栏（v3.8.0 §二改）：只剩 素材 / 支线 两个分区（工件已迁到中栏右侧独立分栏）。
            展开入口在顶栏工具组与文件名 chip；收起后留 12px 贴边条（onSnapOpen），点/右拖即展开 */}
        {/* 默认宽 2026-10-17 由 340 收到 300（用户反馈「启动后右栏偏宽」，学习流画布被压到只能排 1–2 列）；
            下限仍 260：再窄「层级」面里的要求条目输入框与路径行就会挤成竖排（.kb-fit 只保标题行） */}
        <ResizablePanel side="right" storageKey="aiTeach.rightWidth" defaultWidth={300} minWidth={260} maxWidth={720}
          visible={srcVisible} onSnapClose={() => toggleSide('right')} onSnapOpen={() => toggleSide('right')} collapsedWidth={12}>
          <div className="h-full min-h-0 flex flex-col">
            <div className="shrink-0 flex items-center gap-1 border-b border-[var(--border-color)] px-1.5 py-1 bg-[var(--bg-secondary)]">
              <button onClick={() => setRailTab('progress')} title="课程进度：章 / 段 / 复习" className={railTabCls('progress')}>
                <Layers size={11} />进度
              </button>
              <button onClick={() => setRailTab('sources')} title="素材：本段 / 本章 / 未分配" className={railTabCls('sources')}>
                <Paperclip size={11} />素材{courseState?.sourceCounts.total ? `（${courseState.sourceCounts.total}）` : ''}
              </button>
              <button onClick={() => setRailTab('lanes')} title="支线追问" className={railTabCls('lanes')}>
                <GitBranch size={11} />支线{laneInfos.length > 0 ? ` ${laneInfos.length}` : ''}
              </button>
            </div>
            <div className="flex-1 min-h-0 relative">
              <div className={`absolute inset-0 overflow-y-auto ${railTab === 'progress' ? '' : 'hidden'}`}>
                <CourseProgress
                  outline={courseState?.outline ?? null}
                  progress={courseState?.progress ?? {}}
                  lessons={courseState?.lessons ?? {}}
                  reviews={courseState?.reviews ?? {}}
                  activeSegmentSid={activeSegmentSid}
                  onOpenSegment={(sid) => void openSegmentBySid(sid)}
                  onOpenReview={(chapterId) => void courseOpenChapterReview(chapterId)}
                />
              </div>
              <div className={`absolute inset-0 overflow-y-auto ${railTab === 'sources' ? '' : 'hidden'}`}>
                {courseState?.outline && activeWs && activeWs !== '__none__' ? (
                  <CourseSources
                    wsId={activeWs}
                    outline={courseState.outline}
                    activeChapterId={railActiveChapter}
                    activeSegment={activeSegment}
                    onOpenFile={(rel) => void openArtFile(rel)}
                    onReloadCourse={() => void reloadCourse()}
                  />
                ) : (
                  <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">先让课程助手建课，再登记 / 分配素材。</div>
                )}
              </div>
              <div className={`absolute inset-0 ${railTab === 'lanes' ? '' : 'hidden'}`}>
                <SideLaneCenter
                  parentSessionId={activeId ?? ''}
                  parentTitle={activeTitle}
                  request={centerReq}
                  requestSeq={centerSeq}
                  onQuote={quoteFromLane}
                  onFloat={floatFromCenter}
                  onChanged={() => void refreshLanes()}
                />
              </div>
            </div>
            {lastChanges && lastChanges.length > 0 && (
              <div className="shrink-0 border-t border-[var(--border-color)] max-h-[132px] overflow-y-auto">
                <div className="px-2 py-1 text-[10px] text-[var(--text-muted)] select-none">本次改动（{lastChanges.length}）</div>
                <ul className="pb-1">
                  {lastChanges.map((c, i) => (
                    <li key={i}>
                      {c.file ? (
                        <button onClick={() => (c.tool === 'visual.html' || c.tool === 'image' ? void openArtFile(String(c.file), { title: c.target }) : window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: c.file, from: 'aiTeaching' } })))}
                          title={c.tool === 'visual.html' ? '在工件栏打开渲染预览' : c.tool === 'image' ? '在工件栏查看图片' : '在编辑器中打开'}
                          className="w-full flex items-center gap-1 px-2 py-0.5 text-left text-[10.5px] hover:bg-[var(--bg-hover)] transition-colors">
                          <FileText size={9} className="shrink-0 text-[var(--accent)]" />
                          <span className="shrink-0 text-[var(--accent)]">{c.action}</span>
                          <span className="truncate text-[var(--text-primary)]">{c.target}</span>
                        </button>
                      ) : (
                        <div className="flex items-center gap-1 px-2 py-0.5 text-[10.5px]">
                          <FileText size={9} className="shrink-0 text-[var(--text-muted)]" />
                          <span className="shrink-0 text-[var(--accent)]">{c.action}</span>
                          <span className="truncate text-[var(--text-secondary)]">{c.target}</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="shrink-0 flex items-center justify-between px-2 py-1 border-t border-[var(--border-color)]">
              <button onClick={() => { if (activeId) { void refreshMessages(activeId); showToast({ type: 'info', message: '已刷新消息' }) } }}
                className="px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors text-left">
                刷新当前会话
              </button>
              <button onClick={() => toggleSide('right')} title="折叠右栏"
                className="p-1 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                <PanelRightClose size={12} />
              </button>
            </div>
          </div>
        </ResizablePanel>
      </div>
      </>
      ) : (
      /* P5：工作区选择页（进入模块首屏；3-7 未拍板 → 按验收条款每次先见选择页 + 「继续上次工作区」快捷入口） */
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 py-12">
          <div className="flex items-center gap-2 text-[var(--text-muted)]">
            <Sparkles size={16} className="text-[var(--accent)]" />
            <span className="text-[12px] tracking-wide">AI教学</span>
          </div>
          <h1 className="mt-3 text-[22px] font-semibold text-[var(--text-primary)]">选择工作区</h1>
          {lastWsId && wsList.find(w => w.id === lastWsId) && (
            <button onClick={() => enterWs(lastWsId)}
              className="mt-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[12.5px] text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors">
              <ArrowLeft size={12} className="rotate-180" /> 继续上次工作区「{wsList.find(w => w.id === lastWsId)?.name}」
            </button>
          )}
          <div className="mt-6 flex items-center gap-2">
            <div className="flex-1 relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input value={wsSearch} onChange={e => setWsSearch(e.target.value)} placeholder="搜索工作区…"
                className="w-full pl-8 pr-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </div>
            <button onClick={() => setWsModal({ mode: 'create', value: '' })}
              className="flex shrink-0 items-center gap-1 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12.5px] hover:opacity-90 transition-opacity"><Plus size={12} /><span className="kb-l1">新建工作区</span></button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {wsFiltered.map(w => (
              <div key={w.id} onClick={() => enterWs(w.id)}
                className="group relative rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 cursor-pointer hover:border-[var(--accent)]/50 transition-colors"
                title={w.folderRel}>
                <div className="flex items-center gap-2 min-w-0">
                  <Folder size={14} className="shrink-0 text-[var(--accent)]" />
                  <span className="text-[14px] font-medium text-[var(--text-primary)] truncate">{w.name}</span>
                  {w.id === lastWsId && <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)]">上次</span>}
                </div>
                <div className="mt-2 text-[11.5px] text-[var(--text-muted)]">{w.sessionCount} 个对话 · {w.docCount} 个产物 · 最近活跃 {wsAgo(w.lastActive)}</div>
                {/* 卡片 hover 操作行：4 个「图标+文字」按钮挤在卡片宽（grid 两列 → 卡片约 200–500px）里。
                    文字按容器宽度退化（styles/index.css 的 .kb-fit 段）：卡片 <200px 时隐文字只留图标，
                    避免「改名/画像/要求/删除」被压成竖排。 */}
                <div className="kb-fit kb-fit-aiws mt-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                  <button onClick={() => setWsModal({ mode: 'rename', id: w.id, value: w.name })}
                    className="flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><PenLine size={11} /><span className="kb-l1">改名</span></button>
                  {/* UI 优化条目8.2.2：工作区画像第三层入口（卡片 hover 行） */}
                  <button onClick={() => { void openProfile('workspace', w.id) }} title={`工作区画像 · ${aiTeachRoot}/${w.folderRel.startsWith(`${aiTeachRoot}/`) ? w.folderRel.slice(aiTeachRoot.length + 1) : w.folderRel}/PROFILE.md（本课程目标/进度，覆盖全局画像）`}
                    className="flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><User size={11} /><span className="kb-l1">画像</span></button>
                  {/* v3.1.2 条目6：工作区要求入口（卡片 hover 行，与画像并列）——本工作区所有会话共同遵循的 CONSTRAINTS.md */}
                  <button onClick={() => { void openWorkspaceConstraints(w.id) }} title={`工作区要求 · ${w.folderRel}/CONSTRAINTS.md（本工作区所有会话共同遵循，优先级：本会话要求 > 工作区要求 > 全局要求）`}
                    className="flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><ScrollText size={11} /><span className="kb-l1">要求</span></button>
                  <button onClick={() => void removeWs(w)}
                    className="flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:text-red-400 transition-colors"><Trash2 size={11} /><span className="kb-l1">删除</span></button>
                </div>
              </div>
            ))}
            <button onClick={() => setWsModal({ mode: 'create', value: '' })}
              className="rounded-xl border border-dashed border-[var(--border-color)] p-4 text-left cursor-pointer hover:border-[var(--accent)]/60 transition-colors">
              <div className="flex items-center gap-2 text-[var(--text-muted)]"><Plus size={14} /><span className="text-[14px] font-medium">新建工作区</span></div>
              <div className="mt-2 text-[11.5px] text-[var(--text-muted)]">如「数学冲刺」「英语精读」，一个课程/主题一个</div>
            </button>
            {wsFiltered.length === 0 && wsSearch.trim() && (
              <div className="col-span-2 py-6 text-center text-[12px] text-[var(--text-muted)]">没有匹配「{wsSearch.trim()}」的工作区</div>
            )}
          </div>
          {/* UI 优化条目8.2.1 → 10.x 帮助披露改造：说明文字默认收起，悬停卡片平滑展开（同 TaskTray 交换条模式）；ⓘ 提示悬停有说明 */}
          <div className="group mt-4 flex items-start gap-3 rounded-xl border border-[var(--accent)]/35 bg-[var(--accent)]/6 px-4 py-3.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/15 text-[var(--accent)]">
              <User size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
                学习者画像 · 三层
                <Info size={12} className="shrink-0 text-[var(--text-disabled)]" />
              </div>
              <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 group-hover:grid-rows-[1fr]">
                <div className="overflow-hidden">
                  <div className="mt-1 text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                    <b className="text-[var(--text-secondary)]">全局</b>（跨仓库，你是谁/会什么/偏好） · <b className="text-[var(--text-secondary)]">工作区</b>（本课程目标与进度） · <b className="text-[var(--text-secondary)]">本主题</b>（当前水平）——AI 每轮自动注入，冲突时以更细颗粒层为准。
                  </div>
                </div>
              </div>
            </div>
            <button onClick={() => { void openProfile('global') }} title={`全局学习者画像 · 编辑区打开 ${aiTeachRoot}/PROFILE.md（跨工作区共享）`}
              className="shrink-0 self-center flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--accent)]/45 text-[12px] text-[var(--accent)] hover:bg-[var(--accent)]/12 transition-colors">
              全局画像
            </button>
          </div>
          {/* 全局要求（global-constraints 方案）：跨会话共同遵守的约束，与画像全局层同级同交互；说明文字同款悬停展开 */}
          <div className="group mt-3 flex items-start gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-3.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--bg-hover)] text-[var(--text-secondary)]">
              <ScrollText size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
                全局要求 · 所有会话每轮遵循
                <Info size={12} className="shrink-0 text-[var(--text-disabled)]" />
              </div>
              <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 group-hover:grid-rows-[1fr]">
                <div className="overflow-hidden">
                  <div className="mt-1 text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                    写在 <code className="rounded bg-[var(--bg-hover)] px-1">{aiTeachRoot}/CONSTRAINTS.md</code> 的个人通用要求（语言/结构/风格），跨工作区共享；冲突时优先级：用户当下消息 &gt; 会话要求 &gt; 工作区要求 &gt; 全局要求。
                  </div>
                </div>
              </div>
            </div>
            <button onClick={() => { void openGlobalConstraints() }} title={`编辑全局要求 · 确保并打开 ${aiTeachRoot}/CONSTRAINTS.md（首次点击按骨架创建）`}
              className="shrink-0 self-center flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--border-color)] text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
              编辑全局要求
            </button>
          </div>
          <div className="mt-8 text-[11px] text-[var(--text-muted)] leading-relaxed">
            对话产物目录：<code className="px-1 rounded bg-[var(--bg-hover)]">{treeBase}/{'{MM-DD 会话标题}'}/</code>；「课程助手」固定为 <code className="px-1 rounded bg-[var(--bg-hover)]">{treeBase}/{'{工作区}/课程助手/output'}/</code>。删除工作区只解除归属，文件夹与对话保留。
          </div>
        </div>
        {wsModal && (
          <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30" onClick={() => setWsModal(null)}>
            <div className="w-80 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 shadow-xl" onClick={e => e.stopPropagation()}>
              <div className="mb-2 text-[13px] font-medium text-[var(--text-primary)]">{wsModal.mode === 'create' ? '新建工作区' : '工作区改名'}</div>
              <input autoFocus value={wsModal.value} maxLength={40} onChange={e => setWsModal({ ...wsModal, value: e.target.value })}
                placeholder="课程或主题名，如：数学冲刺"
                className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                onKeyDown={e => { if (e.key === 'Enter') void submitWsModal(); if (e.key === 'Escape') setWsModal(null) }} />
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={() => setWsModal(null)} className="rounded-md px-3 py-1 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
                <button onClick={() => void submitWsModal()} className="rounded-md bg-[var(--accent)] px-3 py-1 text-[12.5px] text-white hover:opacity-90">{wsModal.mode === 'create' ? '创建并进入' : '改名'}</button>
              </div>
            </div>
          </div>
        )}
        {/* UI 优化条目5.2（A1）：素材表单与画像弹层已上提至根层（文件尾）——原误挂在 picker 分支，工作区视图永远渲染不到 */}
      </div>
      )}
      {/* UI 优化条目8.1/8.2.2 + 条目5.2（A1）：素材表单与画像弹层上提根层（两视图通用）；画像升三层 */}
      {floatLane && activeId && (
        <div className="fixed right-6 bottom-6 z-50 w-[420px] max-w-[92vw] h-[560px] max-h-[80vh] rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-2xl overflow-hidden kb-pop">
          <SideLanePanel
            parentSessionId={activeId}
            parentTitle={activeTitle}
            anchorMessageId={floatLane.anchorMessageId}
            openLaneId={floatLane.laneId}
            hideTurns
            onClose={() => setFloatLane(null)}
            onDock={() => setFloatLane(null)}
            onQuote={quoteFromLane}
          />
        </div>
      )}
      {reqOpen && activeWs && activeWs !== '__none__' && (
        <RequirementsDrawer
          wsId={activeWs}
          wsName={wsActive?.name ?? '课程'}
          unitId={activeUnitId}
          segmentSessionId={activeSegmentSid}
          layer={reqLayer}
          onLayer={setReqLayer}
          onClose={() => setReqOpen(false)}
        />
      )}
    </div>
  )
}
