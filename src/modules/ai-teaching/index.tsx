import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, X, Loader2, Bot, FileText, Wrench, Plus, Trash2, BookOpen, Compass, CalendarClock, PenLine, Presentation, ChevronLeft, ChevronRight, ChevronDown, Feather, PanelLeftClose, PanelRightClose, PanelRightOpen, ArrowLeft, ArrowUp, ArrowDown, ArrowRight, Folder, Search, User, Eye, FileOutput, Copy, RotateCcw, ScrollText, Image as ImageIcon, Quote, Info, Paperclip, ClipboardList, GitBranch, RefreshCw } from 'lucide-react'
import {
  agentSessions, agentNewSession, agentMessages, agentDeleteSession,
  agentChat, agentStartScene, agentAbort, onAgentStep, llmGetUsage, getSettingRaw, agentSetSessionInstructions, llmListProviders, llmReasoningCapable, llmVisionModels, aiToolsListSkills, agentPromoteSideLane, agentListSideLanes,
  workspaceGetCurrent, workspaceReadFile, docsPptxPages, workspaceListDir, workspaceRefreshVault,
  agentRenameSession, aiTeachEnsureSessionFolder, aiTeachSessionFolder, aiTeachRenameSessionFolder, aiTeachDeleteSessionFolder, aiTeachReadConstraints, aiTeachWriteConstraints, aiTeachGlobalEnsureConstraints, aiTeachWorkspaceEnsureConstraints, aiTeachOrganizeDoc, onAiTeachNotice, onAiTeachTreeRefresh, onWsFsChanged,
  aiTeachListWorkspaces, aiTeachCreateWorkspace, aiTeachRenameWorkspace, aiTeachDeleteWorkspace, aiTeachAssignSession, aiTeachUnassignSession, aiTeachSetLastWorkspace,
  aiTeachSrcRead, aiTeachSrcAdd, aiTeachSrcRemove, aiTeachSrcExtract, aiTeachSrcPick, aiTeachSrcPickDir, aiTeachSrcVisionCheck,
  aiTeachSrcPdfBytes, aiTeachSrcTranscribe, aiTeachSrcPromote,
  aiTeachProfileEnsureGlobal, aiTeachProfileEnsureSession, aiTeachProfileEnsureWorkspace,
  aiTeachProfileWriteGlobal, aiTeachProfileWriteSession, aiTeachProfileWriteWorkspace,
} from '../../lib/ipc'
import { AiTeachFileTree } from './AiTeachFileTree'
import { ArtifactsPane } from './ArtifactsPane'
import type { ArtTab } from './artifacts'
import { ResizablePanel } from '../../components/shared/ResizablePanel'
import { Collapsible } from '../../components/shared/Collapsible'
import { QuizMode } from '../../components/shared/QuizMode'
import { extractQuizzes, looseJsonParse } from '../../components/shared/QuizParser'
import { showToast } from '../../lib/toast'
import { handleChatCommand } from '../../lib/chatCommands'
import { SlashCommandMenu, buildSlashItems, filterSlashItems, type SlashMenuItem } from '../../components/shared/SlashCommandMenu'
import { showGlobalConfirm } from '../../lib/globalConfirm'
import { registerSelectionAskHost } from '../../lib/assistantContext'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'
import { StreamBubble } from '../../components/shared/AssistantPanel/StreamBubble'
import { useAgentStream } from '../../components/shared/AssistantPanel/useAgentStream'
import { WebSourceDialog } from './components/WebSourceDialog'
import { SideLanePanel } from './SideLanePanel'
import { useFloatingWindow } from './useFloatingWindow'

/**
 * 锚点回答 → 支线映射（localStorage）：被追问的那条回答下方据此出现「支线追问 · 已开」，
 * 重启后依然能重新打开原支线。
 *
 * v3.1.2 条目11（2026-09-14 改）：登记时机由「用户手动带回主线时」改为**开窗即自动登记**
 * ——关掉浮窗不再失联：那条被追问的回答自己就是入口，不必再往主线里塞一条"带回消息"。
 */
const ANCHOR_LANES_KEY = 'aiTeach.anchorLanes'
import type { AgentSessionInfo, AgentStoredMessage, AgentTraceStep, AgentChange, AgentChatResult, AiTeachInjectionStats, LlmUsageInfo, LlmProviderInfo, LlmVisionModelInfo, AiTeachWorkspaceInfo, AiTeachSourceEntry, SkillInfo } from '../../types'

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
 * P4 左栏 VS Code 化（§3.7/3.9）：多分区侧栏（资源管理器=产物根文件树全套操作 / 会话 / 任务规划），
 * 折叠贴靠+状态记忆，左右侧栏整体收放记忆；md 点击 → 中栏文档阅读视图（方案 B：工具行+宽幅渲染+h2/h3 大纲+滚动记忆）。
 * P5 工作区两层（§3.2-6）：记住上次工作区直接进（3-38），顶栏工作区 chip 回「工作区选择页」（卡片统计/搜索/新建/改名/删除=仅解归属）；
 * 一个工作区=一门课程含多对话，元数据入仓库 .knowbase/modules/aiTeaching/workspaces.json；
 * 顶栏页签=本工作区对话（会话列表区退役）、工作区 chip 返回选择页；左栏树挂工作区文件夹层；
 * 新对话自动归属当前工作区，产物落 `AI教学/{工作区}/{MM-DD 标题}/`（存量扁平文件夹不迁移，锚点扫描双深度兼容）。
 * P7 题目视图（§3.2-7/3-9）：中栏「对话 ⇄ 题目」切换器；AI 按 quiz 围栏协议出题（注入格式规则），
 * 题目自动收录进题目视图，答题复用知识库 QuizMode（判分/解析/错题），交卷后成绩报告落会话文件夹 `测验·*.md`，
 * 逐题记录经 quizRecord:report（aiTeach: 命名空间）入知识库错题体系（3-10）。
 * P6 素材库（v3.1.1 上移工作区层）：右栏「素材库」= **工作区主库** `SOURCES/SOURCE.md`（跨对话共用，未建对话也可登记）
 * + 本对话历史登记（存量，合并视图重编号 1..N，标「对话」角标，一键「上收」并入主库）；「＋素材」表单登记
 * （类型/存放/页码区间仅 pdf·pptx·docx 拆起止，3-28 程序解析写入）、pdf/pptx/docx 一键区间提取为同级可编辑提取稿（3-20/3-26；docx 经 soffice 转 PDF，v3.1.2 条目5），
 * SOURCE.md 与提取稿经 AgentRunner 素材目录注入供 AI 编号引用（3-29，每轮重读）——新对话因此能看到工作区已有素材。
  * 3-21 视觉转写（手动档）：pdf/pptx/docx 条目「转写」按钮→主进程转 PDF（pptx/docx 经 soffice）→渲染层 pdf.js 区间栅格化→视觉模型逐页转写→并入提取稿。
 * P8 用户画像（§3.14）：全局画像（userData/AI教学/PROFILE.md）+ 会话 PROFILE.md 两层每轮注入；
 * 更新走 Plan B——AI 输出 ```profile 建议块 → 输入框上方建议卡片「接受（本主题/全局）/忽略」，接受才写文件（3-33）；
 * 「🩺 诊断问答」模板（3-34）答完生成初稿；入口=选择页「全局画像」chip + 顶栏「画像」chip（3-35）。
 */

/** 素材类型自动识别（与主进程 addSource 检测同口径）：路径/URL → 类型，无法识别 → other。
 *  表单实时预览用；落盘类型以主进程 addSource 的检测结果为准 */
function inferSrcType(path: string): string {
  const p = path.trim()
  if (/^https?:\/\//i.test(p)) return 'url'
  const m = /\.([A-Za-z0-9]+)\s*$/.exec(p)
  const ext = m ? m[1].toLowerCase() : ''
  if (ext === 'pdf') return 'pdf'
  if (ext === 'pptx' || ext === 'ppt') return 'pptx'
  if (ext === 'docx' || ext === 'doc') return 'docx'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image'
  if (['md', 'markdown', 'txt'].includes(ext)) return 'md'
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'c', 'h', 'cpp', 'hpp', 'cc', 'java', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sh', 'bat', 'ps1', 'lua', 'sql', 'vue', 'scss', 'css', 'html', 'xml', 'json', 'yml', 'yaml', 'toml', 'ini'].includes(ext)) return 'code'
  return 'other'
}

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

interface Template {
  id: string
  label: string
  icon: React.ReactNode
  desc: string
  goal: string
  steps: string[]
  /**
   * 场景流程规则：新建会话时播种进会话文件夹 CONSTRAINTS.md（会话约束唯一真相源）。
   * 不再作为开场白伪装成用户消息发送——主进程每轮重读该文件注入，用户可在编辑器直接改。
   */
  rule: string
  /**
   * v3.1.2 条目7：开场模板——新建对话后预填进「准备态」首条消息框（用户可编辑后再发送）。
   * 不再自动空发首轮（原 startScene 虚拟首轮已从 newTask 摘除）。
   */
  startPrompt: string
}

const TEMPLATES: Template[] = [
  {
    id: 'teach', label: '跟我学（教学）', icon: <BookOpen size={13} />,
    desc: '喂资料，学到大纲确认与测验',
    goal: '把我提供的资料教到我会：先出大纲待我确认，再分步精讲，最后出题检验。',
    steps: ['通读资料', '学习大纲', '分章精讲', '随堂测验', '沉淀复习笔记'],
    rule: '## 场景流程（跟我学）\n用户会提供学习资料（网址/文件/仓库笔记均可）。按此流程执行：\n① 通读资料后产出学习大纲，等用户确认后再开讲（未确认不要直接讲）；\n② 确认后分步精讲，每步讲完停一下让用户提问；\n③ 最后出题检验并讲解。\n全程用简体中文。',
    startPrompt: '我要学：〈主题，如 数列极限的定义与证明〉\n资料：〈网址 / 文件路径 / 素材编号，留空则由你从已登记素材里选〉\n其他要求：〈可选，如 多举例子 / 跳过基础推导〉',
  },
  {
    id: 'research', label: '深度研读（织网）', icon: <Compass size={13} />,
    desc: '把相关笔记读透并整理成专题页',
    goal: '把一个主题在仓库里的所有相关内容研读一遍，讲给我听，并产出一张带双链的专题页草稿待确认写入。',
    steps: ['定位相关笔记', '批量通读', '综合讲解', '专题页草稿', '确认写入'],
    rule: '## 场景流程（深度研读）\n用户会给出研究主题关键词。按此流程执行：\n① 用 vault.search 找出仓库内相关笔记并通读；\n② 向用户综合讲解；\n③ 产出一张「主题专题」.md 草稿（含指向来源页的 [[双链]]），等用户确认后再写入。',
    startPrompt: '研究主题：〈关键词，如 傅里叶变换的物理意义〉\n范围：〈可指定素材编号如 #1#3，留空则用全部已登记素材〉',
  },
  {
    id: 'review', label: '周复盘', icon: <CalendarClock size={13} />,
    desc: '读日程/日记/打卡生成周报',
    goal: '总结我指定的一段时间：成就、回落与下周建议，产出周报草稿。',
    steps: ['读取模块数据', '生成周报草稿', '确认写入'],
    rule: '## 场景流程（周复盘）\n读取用户的日程待办、日记、习惯打卡与番茄钟统计，生成一份复盘报告草稿（成就/回落/下周建议），等用户确认后再写入周总结。',
    startPrompt: '复盘时间段：〈本周 / 上周 / MM-DD ~ MM-DD〉\n关注重点：〈可选，如 学习时长 / 打卡连续性〉',
  },
  {
    id: 'profile-diagnose', label: '画像诊断', icon: <User size={13} />,
    desc: '答几道题生成初始学习者画像',
    goal: '通过诊断问答了解我的身份/基础/薄弱点/目标/偏好，产出学习者画像初稿待确认。',
    steps: ['AI 出 3~5 道诊断题', '我作答', 'AI 产出画像初稿', '确认写入 PROFILE.md'],
    // 注：ask/profile 围栏的具体协议由主进程每轮注入（askRuleHint / profileHint），此处只写流程，不重复协议细节
    rule: '## 场景流程（画像诊断）\n用 ask 整卷模式做入学诊断：先输出整卷问卷（3~5 题，覆盖身份/学科背景、当前水平、薄弱点、学习目标、偏好；每题选项 ≤20 字）。用户整卷作答后，据答案产出**本主题**学习者画像初稿（含当前水平/薄弱点/学习进度/学习目标/偏好），以 profile 围栏输出，等用户确认后再写入会话文件夹 PROFILE.md——确认前不要写文件。诊断只针对本主题层，全局与工作区画像不需要生成。',
    startPrompt: '开始入学诊断：我想先把本主题的学习者画像建起来。\n说明：〈可选，补充你的背景或特别想被了解的点〉',
  },
]

/** 内置工具 → 中文简称（缺省回退短名）。2026-09-09 P1/P2 退役项已删：habits.list / docs.read-text / bookmarks.search / knowledge.read / knowledge.append-page */
const TOOL_CN: Record<string, string> = {
  'builtin.vault.list': '列目录', 'builtin.vault.read': '读仓库文件', 'builtin.vault.search': '搜笔记内容',
  'builtin.vault.write': '写笔记文件', 'builtin.vault.edit': '修改/追加笔记', 'builtin.vault.rename': '重命名',
  'builtin.vault.trash': '移回收站', 'builtin.vault.resolve-ref': '校验引用',
  'builtin.knowledge.search': '搜知识库', 'builtin.knowledge.create-page': '建知识页',
  'builtin.blog.create-entry': '写日记', 'builtin.schedule.create-todo': '建待办',
  'builtin.schedule.update-todo': '改待办', 'builtin.schedule.delete-todo': '删待办',
  'builtin.checkin.check-habit': '打卡', 'builtin.habits.stats': '习惯查询统计',
  'builtin.pomodoro.summary': '专注统计', 'builtin.schedule.list-todos': '查待办',
  'builtin.web.search': '联网搜索', 'builtin.web.read': '读网页',
}
function toolName(name?: string): string {
  const s = String(name ?? '')
  return TOOL_CN[s] ?? (s.startsWith('builtin.') ? s.slice(8) : s || '工具')
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
function fmtTok(n: number): string { return n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n) }

/** UI 优化条目9②：上下文占用环形指示（纯 SVG，无新依赖）。pct=null → 退化为紧凑数字 chip（优雅降级）。
 *  分档口径与月度预算一致：<70% 常态（accent）、70~85% 警示（warning）、>85% 红（danger）。 */
function UsageRing({ pct, used }: { pct: number | null; used: number }) {
  if (pct == null) return <span className="tabular-nums text-[11px] text-[var(--text-secondary)]">≈ {fmtTok(used)}</span>
  const R = 8
  const C = 2 * Math.PI * R
  const clamped = Math.max(0, Math.min(1, pct))
  const color = pct > 0.85 ? 'var(--danger)' : pct >= 0.7 ? 'var(--warning)' : 'var(--accent)'
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx="11" cy="11" r={R} fill="none" stroke="var(--border-color)" strokeWidth="2.5" />
      <circle cx="11" cy="11" r={R} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${(clamped * C).toFixed(1)} ${C.toFixed(1)}`} className="transition-[stroke-dasharray] duration-300" />
      <text x="11" y="11" transform="rotate(90 11 11)" textAnchor="middle" dominantBaseline="central"
        fontSize="6.5" fill={color} className="tabular-nums">{Math.round(clamped * 100)}</text>
    </svg>
  )
}

/** 中英混排估算口径（仅用于注入构成摘要的字符→token 折算展示，非计费依据） */
const CHARS_PER_TOKEN = 2.6

/** UI 优化条目6B：中栏导航状态按会话持久化（`aiTeach.nav.{sessionId}`）。
 *  保活架构下切 Tab 不卸载组件，但模块在主栏/副栏之间换位（分屏互切）或实例重建会整树重置——
 *  以 localStorage 兜底，回到该会话即恢复到离开时的视图（文档阅读 > 逐页阅读 > 题目 > 对话）。 */
type AiTeachNav = {
  midView?: 'chat' | 'quiz'; docRel?: string | null; readerRel?: string | null; readerPage?: number
  /**
   * v3.1.2 条目7（会话准备态）：创建对话 → 首条消息之间的中间态快照。
   * - `started` 缺省/false = 仍停准备态；true = 已开讲（此后不再进准备态）
   * - `draft` 首条消息（用户编辑后的值；缺省回落场景 startPrompt）
   * - `srcOpen`/`reqOpen` 素材条 / 会话要求条折叠态（切回时还原到切走瞬间）
   * 素材与约束内容不入快照——真相源是 SOURCE.md / CONSTRAINTS.md，实时读才不会丢外部变更。
   */
  prep?: { started?: boolean; draft?: string; srcOpen?: boolean; reqOpen?: boolean }
}
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

/** 素材类型分组（右栏改造方案 B，docs/ai-teaching-sources-panel-rework.md）：五类 + 其他兜底；色点对齐定稿原型 */
const SRC_GROUPS: Array<{ key: string; label: string; color: string }> = [
  { key: 'pdf', label: 'PDF 文件', color: '#d04242' },
  { key: 'pptx', label: 'PPT 课件', color: '#e8842a' },
  { key: 'docx', label: 'Word 文档', color: '#2b579a' },
  { key: 'url', label: '网页', color: '#2e9e5b' },
  { key: 'code', label: '代码', color: '#4f6bed' },
  { key: 'dir', label: '目录', color: '#8b949e' },
  { key: 'other', label: '其他', color: '#a3aab8' },
]
/** type → 组键（image/md/other/未识别全进 other，不丢条目） */
const srcGroupKey = (t: string): string => (['pdf', 'pptx', 'docx', 'url', 'code', 'dir'].includes(t) ? t : 'other')
/** 折叠缓动：快出缓停无回弹（方案 §3 定稿曲线） */
const SRC_EASE = 'ease-[cubic-bezier(0.22,0.68,0.32,1)]'

export function AiTeachingModule({ isActive, zenLevel = 0, onZenLevelChange }: { isActive?: boolean; zenLevel?: number; onZenLevelChange?: (n: number) => void }) {
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeTitle, setActiveTitle] = useState('')
  const [template, setTemplate] = useState<Template>(TEMPLATES[0])
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
  /** 视觉转写模型（素材转写用，全局级与回答模型分开）：'' = 自动按模型名识别；格式 providerId:model */
  const [visionModel, setVisionModel] = useState(() => localStorage.getItem('aiTeach.visionModel') ?? '')
  const [visionList, setVisionList] = useState<LlmVisionModelInfo[]>([])
  const [showAllVision, setShowAllVision] = useState(false)
  const pickVision = (val: string): void => {
    setVisionModel(val)
    try { if (val) localStorage.setItem('aiTeach.visionModel', val); else localStorage.removeItem('aiTeach.visionModel') } catch { /* 隐私模式忽略 */ }
  }
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
  const [rightOpen, setRightOpen] = useState(() => localStorage.getItem('aiTeach.rightOpen') !== '0')
  /** 素材库实际可见态（双右栏联动 §1.3）：rightOpen=用户意图态（持久），srcVisible=渲染态——
   *  工件栏展开时自动收起但不改意图；用户手动展开（贴边条/顶栏 chip）两栏允许同屏 */
  const [srcVisible, setSrcVisible] = useState(() => localStorage.getItem('aiTeach.rightOpen') !== '0')
  const toggleSide = (side: 'left' | 'right') => {
    if (side === 'left') { const v = !leftOpen; setLeftOpen(v); localStorage.setItem('aiTeach.leftOpen', v ? '1' : '0') }
    else { const v = !rightOpen; setRightOpen(v); localStorage.setItem('aiTeach.rightOpen', v ? '1' : '0'); setSrcVisible(v) }
  }
  /** 打开素材库（顶栏 chip / 贴边条专用——自动收起态下 rightOpen 意图已是 true，翻转逻辑不适用） */
  const openSources = () => { setRightOpen(true); localStorage.setItem('aiTeach.rightOpen', '1'); setSrcVisible(true) }
  // Ctrl+B 切左侧栏 / Ctrl+Alt+B 切右侧栏（2026-09-08 用户反馈补齐，对齐 VS Code 侧栏习惯）。
  // 模块级快捷键：仅本模块激活时生效；焦点在输入控件内不拦截；deps 随开合状态刷新闭包
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.key.toLowerCase() !== 'b') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      if (e.altKey) { if (!srcVisible) openSources(); else toggleSide('right') } // 自动收起态下快捷键=展开（意图态已 true，翻转逻辑不适用）
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
  const [artPct, setArtPctRaw] = useState(() => {
    const n = Number(localStorage.getItem('aiTeach.artWidth'))
    return Number.isFinite(n) && n >= 24 && n <= 60 ? n : 46
  })
  /**
   * 分栏拖拽期遮罩（v3.2.0 条目 ⑤「第二层保险」）。
   * `setPointerCapture` 是正解，但工件栏正文是 `.html` 时会挂一个 `kbview://` 独立文档的 iframe
   * ——capture 跨文档边界是否稳不由我们决定，而**遮罩是物理上不让指针进入 iframe**，不依赖任何语义。
   * 两者并用：capture 保证收尾可达，遮罩保证指针全程留在父文档内（顺带全窗口光标统一为 col-resize）。
   * ⚠️ 只能由拖拽收尾摘除（`onUp` / `lostpointercapture`），绝不能另挂一个只认 up 的监听——
   * 那正是「状态卡死只能重启」的老路。
   */
  const [artDragMask, setArtDragMask] = useState(false)
  /** html 页签 ⟳ 刷新计数（key 版本，ArtHtmlView 重读磁盘） */
  const [htmlSeq, setHtmlSeq] = useState<Record<string, number>>({})
  /** ⤢ 原位放大：工件栏占满内容区（absolute 盖过对话/左右栏，组件不卸载 → 对话滚动与 iframe 全存活），⤡/Esc 退出 */
  const [artZoom, setArtZoom] = useState(false)
  useEffect(() => { if (artTabs.length === 0) setArtZoom(false) }, [artTabs.length])
  const artTabsRef = useRef<ArtTab[]>([])
  useEffect(() => { artTabsRef.current = artTabs }, [artTabs])
  const setArtPct = useCallback((v: number) => {
    setArtPctRaw(v)
    try { localStorage.setItem('aiTeach.artWidth', String(Math.round(v))) } catch { /* 隐私模式忽略 */ }
  }, [])
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
  }, [])
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
    const cur = await workspaceGetCurrent().catch(() => null)
    const rootId = (cur as { rootId?: string } | null)?.rootId
    if (!rootId) { showToast({ type: 'error', message: '尚未打开仓库' }); return }
    const r = await workspaceReadFile(rootId, rel).catch(() => null)
    if (!r || typeof r.content !== 'string') { showToast({ type: 'error', message: '读取文档失败' }); return }
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
  const [wsModal, setWsModal] = useState<{ mode: 'create' | 'rename'; id?: string; value: string } | null>(null)
  const refreshWorkspaces = useCallback(async () => {
    const r = await aiTeachListWorkspaces().catch(() => null)
    if (!r) return
    setWsList(r.workspaces); setWsSessionMap(r.sessionWs); setLastWsId(r.lastWorkspaceId)
  }, [])
  useEffect(() => { void refreshWorkspaces() }, [refreshWorkspaces])
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
    window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: `${treeBase}/${rel}`, from: 'aiTeaching' } }))
  }, [treeBase])
  const artOpenInEditor = useCallback((rel: string) => {
    window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: rel, from: 'aiTeaching' } }))
  }, [])
  const wsSessions = useMemo(
    () => sessions.filter(s => (wsSessionMap[s.id] ?? '__none__') === (activeWs ?? '__none__')),
    [sessions, wsSessionMap, activeWs],
  )
  /**
   * v3.1.2 条目11 P4：左栏会话列表 = 主线行 + 其下缩进的「已升格支线」。
   * 支线本身不分配工作区，靠 parentSessionId 归属到父行下（父行在当前工作区视图时才带出）。
   */
  const wsSessionTree = useMemo(() => {
    const inView = new Set(wsSessions.map(s => s.id))
    const childrenOf = new Map<string, AgentSessionInfo[]>()
    for (const s of sessions) {
      if (!s.parentSessionId || s.lane !== 'main' || !inView.has(s.parentSessionId)) continue
      const arr = childrenOf.get(s.parentSessionId) ?? []
      arr.push(s); childrenOf.set(s.parentSessionId, arr)
    }
    const out: Array<{ s: AgentSessionInfo; child: boolean }> = []
    for (const s of wsSessions) {
      if (s.parentSessionId && s.lane === 'main') continue // 已升格支线由父行带出，不单独成行
      out.push({ s, child: false })
      for (const c of childrenOf.get(s.id) ?? []) out.push({ s: c, child: true })
    }
    return out
  }, [wsSessions, sessions])
  // ---------- P7 题目视图（§3.2-7/3-9 中栏顶部切换器；答题复用知识库 QuizMode，3-10 记录持久化） ----------
  const [midView, setMidView] = useState<'chat' | 'quiz'>('chat')
  // ---------- v3.1.2 条目7：会话准备态（新建对话 → 首条消息之间的中间态） ----------
  // prepStarted=false 时输入区显示准备面板（素材 / 会话要求 / 首条消息），零 LLM 调用；
  // 点「开始对话」才置 true 并走既有 doSend，此后与旧会话行为完全一致。
  const [prepStarted, setPrepStarted] = useState(true)
  const [prepSrcOpen, setPrepSrcOpen] = useState(false)
  const [prepReqOpen, setPrepReqOpen] = useState(false)
  // 场景模板与首条消息草稿（准备态专用；草稿同步落 nav.prep.draft 以支持切走切回还原）
  const [prepTemplate, setPrepTemplate] = useState<Template | null>(null)
  const prepDraftTimer = useRef<number | null>(null)
  /** nav 是 localStorage（非 React state）——准备态开讲/新建后需要一次重渲染让页签「准备中」标记即时更新 */
  const [prepNavSeq, setPrepNavSeq] = useState(0)
  const [quizOpen, setQuizOpen] = useState(false)
  const [lastQuizReport, setLastQuizReport] = useState<{ rel: string; score: string } | null>(null)
  const quizItems = useMemo(
    () => messages.filter(m => m.role === 'assistant').flatMap(m => extractQuizzes(m.content)),
    [messages],
  )
  const [showNewMenu, setShowNewMenu] = useState(false)
  /** 左栏「会话」区的 ＋ 自带菜单（锚点必须在自己身上，不能复用顶栏那个 setShowNewMenu） */
  const [leftNewMenu, setLeftNewMenu] = useState(false)
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
    void getSettingRaw('aiTeachUsageDetail').then(v => { const s = String(v ?? 'compact'); setUsageDetail(s === 'off' || s === 'detailed' ? s : 'compact') }).catch(() => null)
    void getSettingRaw('aiTeachCtxWindow').then(v => setCtxWindow(Math.max(0, Math.floor(Number(v) || 0)))).catch(() => null)
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
  // v3.1.2 条目11：支线旁问面板（浮层 / 右栏宽轨）。null=关闭。
  // parentSessionId 在打开瞬间锁定——面板开着时切主线会话不会把支线挪到别的会话下。
  const [sideLane, setSideLane] = useState<{ parentSessionId: string; anchorMessageId: string; parentTitle: string; openLaneId?: string } | null>(null)
  const [sideLaneWide, setSideLaneWide] = useState(false)
  /** 锚点回答 → 支线映射：被追问的回答消息 id → 支线（回答下方按钮据此重开） */
  const [anchorLanes, setAnchorLanes] = useState<Record<string, { laneId: string; laneTitle: string }>>(() => {
    try { return JSON.parse(localStorage.getItem(ANCHOR_LANES_KEY) || '{}') as Record<string, { laneId: string; laneTitle: string }> } catch { return {} }
  })
  // PPT 逐页阅读已并入工件栏 pptx 页签（工件栏方案 §1.4，原 reader 中栏互斥态退役）
  // UI 优化条目6B：中栏导航状态（对话/题目 · 工件栏激活页签）随变化落到本会话持久化键
  useEffect(() => {
    if (!activeId) return
    const t = artTabs.find(x => x.id === artActive)
    writeNav(activeId, {
      midView,
      docRel: t && !t.generating && (t.kind === 'md' || t.kind === 'html') ? t.rel : null,
      readerRel: t && !t.generating && t.kind === 'pptx' ? t.rel : null,
      readerPage: t && t.kind === 'pptx' ? t.cur ?? 0 : 0,
    })
  }, [activeId, midView, artTabs, artActive])
  const [activeIdRef, chatIdRef] = [useRef<string | null>(null), useRef('')]
  // v3.2.0 条目6：原先这里还有个 `bottomRef` 死锚点（定义了、也渲染了，全仓无人读取）——
  // 它就是「滚底实现丢了」的物证。本条改用直接赋值 `scrollTop = scrollHeight`（同 MessageList 范式、
  // 与 rules 1/2 的写法一致），不再需要锚点元素，故连同其渲染点一并移除。

  /** 输入区（划词「问 AI」就地追问时聚焦用） */
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** 引用片段的 ref 镜像——sendText 是 useCallback，读 ref 避免闭包捕获旧值 */
  const quotesRef = useRef<string[]>([])
  // P3a 快速定位条：消息滚动容器 + 当前锚点高亮
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 对话流滚动记忆（2026-09-08）：跳文档阅读视图会卸载对话容器（scrollTop 丢失）——
   *  onConvScroll 持续记录，返回对话时恢复（对齐 docScrollPos 的文档滚动记忆模式） */
  const convScrollTop = useRef(0)
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
    if (c) c.scrollTop = c.scrollHeight
    requestAnimationFrame(() => { const c2 = scrollRef.current; if (c2) c2.scrollTop = c2.scrollHeight })
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

  // ---- 禅模式（唯一作用域 = 本模块）----
  // Esc 的「先关本模块浮层，再退禅」统一放在 askVisible/srcForm 等浮层 state 声明之后（见 §P8 画像小节），
  // 这里只保留 zenActive（若在此处引用后文声明的 srcForm/askVisible 会触发 TDZ 报错 → 整模块崩溃）。
  const zenActive = zenLevel >= 1 && !!onZenLevelChange

  // 离开本模块 Tab 自动退出禅（保活架构组件不卸载，必须监听 isActive）
  useEffect(() => {
    if (!isActive && zenLevel > 0) onZenLevelChange?.(0)
  }, [isActive, zenLevel, onZenLevelChange])

  // P2（§2.3/2-6）：会话约束读取——文件唯一真相源；无文件夹的旧会话读兼容回退 DB 字段一次
  const loadConstraints = useCallback(async (sid: string, dbFallback: string): Promise<void> => {
    const r = await aiTeachReadConstraints(sid).catch(() => null)
    const text = r && r.ok ? (r.relPath ? (r.text ?? '').trim() : dbFallback) : dbFallback
    if (activeIdRef.current === sid) { setActiveInstr(text); setInstrRel(r?.relPath ?? '') }
  }, [])

  const refreshSessions = useCallback(async () => {
    // 只保留 AI 教学来源的会话：助手侧栏 / AI 学堂的会话有自己的列表（同表存储，按 source 分流）。
    // v3.1.2 条目11：未升格的支线（lane='side'）不进主列表——它们只活在浮层/宽轨里；
    // 升格后 lane='main'，随主线行缩进显示（见 wsSessionTree）。
    const list = (await agentSessions().catch(() => []))
      .filter(s => s.source !== 'assistant' && !(s.parentSessionId && s.lane === 'side'))
    setSessions(list)
    // P5：选择页状态（activeWs=null）不自动开会话；进工作区后只在本工作区会话里选
    const cur = activeIdRef.current ? list.find(s => s.id === activeIdRef.current) : undefined
    const pool = activeWsRef.current
      ? list.filter(s => (wsMapRef.current[s.id] ?? '__none__') === activeWsRef.current)
      : []
    const first = activeWsRef.current ? (cur ?? pool[0]) : undefined
    if (first) {
      setActiveId(first.id)
      setActiveTitle(first.title)
      setInstrDismiss(false)
      void loadConstraints(first.id, first.instructions ?? '')
    } else if (!activeWsRef.current) {
      setActiveId(null)
      setActiveInstr(''); setInstrRel('')
    }
  }, [loadConstraints])

  /** v3.1.2 条目11 P4：升格支线为正式会话（单向不可逆）——刷新会话表后随主线行缩进显示 */
  const promoteLane = useCallback(async (laneId: string) => {
    const ok = await agentPromoteSideLane(laneId).catch(() => false)
    if (!ok) { showToast({ type: 'error', message: '升格失败' }); return }
    await refreshSessions()
    showToast({ type: 'info', message: '已升格为正式会话（见左栏主线会话下方）' })
  }, [refreshSessions])

  const refreshMessages = useCallback(async (sid: string) => {
    const rows = await agentMessages(sid).catch(() => [] as AgentStoredMessage[])
    setMessages(rows.map(m => ({
      id: m.id, role: m.role, content: m.content, createdAt: m.createdAt,
      trace: m.traceJson ? (() => { try { return JSON.parse(m.traceJson) as AgentTraceStep[] } catch { return undefined } })() : undefined,
    })))
  }, [])

  /**
   * v3.1.2 条目11：支线**首条消息发出时**自动登记锚点回执。
   *
   * 被追问的那条回答就是这条支线的入口——登记后按钮变「支线追问 · 已开」，点击即可重开；
   * 关窗 / 切形态都不再失联（原「带回主线」的人工通道已于 2026-09-14 移除，支线不再往主线塞消息）。
   * 登记时点选在**首条消息**而非开窗瞬间：一句没发的空支线不该在主线留下「已开」入口
   * （空支线由面板卸载时回收，两面互为补集，不存在「有内容却无入口」的空档）。
   */
  /** 当前打开支线的会话 id（首条消息后才有值）——供切换浮层/宽轨形态时承接，避免重挂时重建会话丢内容 */
  const activeLaneIdRef = useRef('')
  const noteLaneReady = useCallback((anchorMessageId: string, laneId: string, laneTitle: string) => {
    activeLaneIdRef.current = laneId
    if (!anchorMessageId) return
    setAnchorLanes(prev => {
      const next = { ...prev, [anchorMessageId]: { laneId, laneTitle } }
      try { localStorage.setItem(ANCHOR_LANES_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  /**
   * 切换支线形态（浮层 ⇄ 右栏宽轨）——两者是**不同挂载点**，重挂时若不带 `openLaneId` 会重新建会话
   * （旧支线连同已追问内容变孤儿）。已发过消息的支线带上 `activeLaneIdRef` 作 `openLaneId`
   * → 新形态**载入同一条**（不丢内容）；未发送的支线不带（新形态重建无损失，旧空支线由面板卸载回收）。
   */
  const toggleSideLaneWide = useCallback((wide: boolean) => {
    setSideLaneWide(wide)
    const lid = activeLaneIdRef.current
    if (lid) setSideLane(prev => (prev && !prev.openLaneId ? { ...prev, openLaneId: lid } : prev))
  }, [])
  // 换锚点 / 关面板时清掉上一次的承接 id，避免切形态承载到错误的支线
  useEffect(() => {
    activeLaneIdRef.current = sideLane?.openLaneId ?? ''
  }, [sideLane?.anchorMessageId, sideLane?.openLaneId])

  // 打开 AI教学 Tab 时同步会话
  useEffect(() => { void refreshSessions() }, [refreshSessions, isActive])
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
      if (step.name === 'visual.html' && step.args && !step.artifact) {
        const slug = String(step.args.slug ?? '')
        const title = String(step.args.title ?? '') || '示意图'
        setArtTabs(prev => [...prev.filter(t => !(t.generating && t.slug === slug)),
          { id: `gen:${slug || title}`, kind: 'html' as const, rel: '', name: '生成中…', generating: true, slug, title }])
        setArtActive(`gen:${slug || title}`)
      }
      if (step.artifact && step.ok) {
        const a = step.artifact
        if (!a.rel) return
        setArtTabs(prev => {
          const rest = prev.filter(t => !(t.generating && a.slug && t.slug === a.slug))
          return rest.some(t => t.id === a.rel) ? rest : [...rest, { id: a.rel, kind: 'html' as const, rel: a.rel, name: a.title || a.rel.split('/').pop() || a.rel, title: a.title, lines: a.lines }]
        })
        setArtActive(cur => cur === `gen:${a.slug}` ? a.rel : cur)
        showToast({ type: 'info', message: `✓ 示意图已生成：${a.rel.split('/').pop()}（${a.lines} 行）` })
      }
      // 工具失败：清掉「生成中」占位页签（禁关页签不能因失败卡死）；停止生成同理（setPending(false) 处兜底）
      if (step.name === 'visual.html' && !step.ok && !step.artifact) {
        setArtTabs(prev => prev.filter(t => !t.generating))
        setArtActive(cur => cur?.startsWith('gen:') ? null : cur)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换会话
  const openSession = useCallback(async (sid: string, title: string) => {
    setLeftNewMenu(false) // 从左栏点会话即视为收起新建菜单
    setSideLane(null) // v3.1.2 条目11：切会话即收起支线面板（支线挂在原主线会话下）
    setActiveId(sid); setActiveTitle(title); setLastChanges(null); setLiveSteps([])
    quotesRef.current = []; setQuotes([]); setQuotesOpen(false) // 引用片段属于发起时那个对话，切会话即失效
    setArtTabs([]); setArtActive(null) // 工件栏页签=会话内存态：切会话清空（§2，阅读位置记忆保留在页签组件内）
    setMidView('chat'); setQuizOpen(false); setLastQuizReport(null) // P7 复位
    const row = sessions.find(s => s.id === sid)
    setInstrDismiss(false)
    void loadConstraints(sid, row?.instructions ?? '')
    await refreshMessages(sid)
    const nav = readNav(sid)
    // v3.1.2 条目7：准备态还原——未开讲的会话回到「切走瞬间」的准备态（草稿/折叠态入 nav，素材与约束实时读）
    const prep = nav.prep
    if (prep && prep.started === false) {
      setPrepStarted(false)
      setPrepSrcOpen(!!prep.srcOpen); setPrepReqOpen(!!prep.reqOpen)
      setInput(prep.draft ?? '')
      setPrepTemplate(TEMPLATES.find(t => t.label === title) ?? null)
      return
    }
    setPrepStarted(true); setPrepTemplate(null)
    // UI 优化条目6B：恢复该会话「上次离开时的工件」（页签在则栏在——内容驱动，无手动开合）
    if (nav.docRel) void openArtFile(nav.docRel)
    else if (nav.readerRel && /\.pptx$/i.test(nav.readerRel)) void openArtFile(nav.readerRel, { cur: nav.readerPage ?? 0 })
    if (nav.midView === 'quiz') setMidView('quiz')
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
    endStream()
    setPending(false)
    setArtTabs(prev => prev.some(t => t.generating) ? prev.filter(t => !t.generating) : prev) // 中止/失败收尾：禁关占位不留场
    setArtActive(cur => cur?.startsWith('gen:') ? null : cur)
    return r
  }, [refreshMessages, beginStream, endStream, jumpToBottom])

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
    () => filterSlashItems(buildSlashItems(slashSkills), slashQuery ?? ''),
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

  /** 条目13：quiz 解析失败占位卡的「让 AI 重出新题」——填入重试 prompt 直接发送（V-2 失败 toast 下沉同理路径） */
  const retryQuiz = useCallback(() => {
    void doSend('上一条回答里的 ```quiz 题目 JSON 解析失败（可能存在未转义英文双引号），请把那道题重新输出一遍：围栏语言 quiz，字符串内部需要引用时用中文引号『』或“”，确保 JSON 可解析。')
  }, [doSend])

  // 场景启动：不落任何用户消息，用虚拟首轮触发（主进程 allowEmptyHistory）
  // ——聊天区第一条即 AI 回复，不再出现程序伪造的开场白气泡
  const startScene = useCallback(async (sid: string) => {
    setPending(true); setLiveSteps([])
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    const ov = convoLlm.current.get(sid)
    const r = await agentStartScene(sid, cid, 'aiTeaching', ov?.modelId)
    if (r && !r.ok && r.code !== 'ABORTED') showToast({ type: 'error', message: `AI 调用失败：${r.error ?? ''}` })
    if (r?.injection) setInjectionMap(prev => ({ ...prev, [sid]: r.injection as AiTeachInjectionStats }))
    void llmGetUsage().then(setUsage).catch(() => null)
    setLastChanges(r?.changes && r.changes.length ? r.changes : null)
    await refreshMessages(sid)
    setPending(false)
    setArtTabs(prev => prev.some(t => t.generating) ? prev.filter(t => !t.generating) : prev)
    setArtActive(cur => cur?.startsWith('gen:') ? null : cur)
  }, [refreshMessages])

  // 新建任务（模板）：播种场景规则到 CONSTRAINTS.md，再进「准备态」由用户备好首条消息后手动开讲
  // （v3.1.2 条目7：原先此处 void startScene(row.id) 自动空发首轮——已摘除，改为零 LLM 调用）
  const newTask = useCallback(async (tpl: Template) => {
    const row = await agentNewSession(`${tpl.label}`, 'aiTeaching').catch(() => null)
    if (!row) return
    // P5：先归属当前工作区（元数据真相源），再建夹——ensure 在主进程读归属决定两层路径
    if (activeWs && activeWs !== '__none__') await aiTeachAssignSession(row.id, activeWs).catch(() => null)
    // P1（2-2）：新建对话确认即建会话文件夹（懒建语义下空会话也不删）
    const folder = await aiTeachEnsureSessionFolder(row.id).catch(() => null)
    if (folder && !folder.ok && folder.error) showToast({ type: 'error', message: `会话文件夹创建失败：${folder.error}` })
    // 场景流程播种进 CONSTRAINTS.md（会话约束唯一真相源，用户可编辑；主进程每轮重读注入）
    const cur = await aiTeachReadConstraints(row.id).catch(() => null)
    const base = (cur?.text ?? '').trim()
    if (!base.includes(tpl.rule)) {
      await aiTeachWriteConstraints(row.id, [base, tpl.rule].filter(Boolean).join('\n\n')).catch(() => null)
    }
    // v3.1.2 条目7：进准备态——快照落 nav（started=false + 场景模板预填），切走切回可还原
    writeNav(row.id, { prep: { started: false, draft: tpl.startPrompt, srcOpen: false, reqOpen: false } })
    setPrepNavSeq(n => n + 1)
    setPrepTemplate(tpl)
    // v3.1.2（开发负责人 2026-09-14）：新建对话后默认收起左右两侧栏——让用户先专注在「备好再开讲」，
    // 需要时用顶栏把手 / 拖拽展开（不覆盖用户的持久化意图，仅本次新建动作后收起）
    setLeftOpen(false); localStorage.setItem('aiTeach.leftOpen', '0')
    setRightOpen(false); localStorage.setItem('aiTeach.rightOpen', '0'); setSrcVisible(false)
    setPrepStarted(false); setPrepSrcOpen(false); setPrepReqOpen(false)
    void loadConstraints(row.id, '')
    void refreshWorkspaces()
    setTemplate(tpl)
    setActiveId(row.id); setActiveTitle(row.title)
    activeIdRef.current = row.id
    setInput(tpl.startPrompt)
    setMessages([]); setLastChanges(null); setShowNewMenu(false); setLeftNewMenu(false); setActiveInstr(''); setInstrRel(''); setInstrDismiss(false); setArtTabs([]); setArtActive(null)
    setMidView('chat'); setQuizOpen(false); setLastQuizReport(null) // P7 复位
    void refreshSessions()
  }, [refreshSessions, loadConstraints, activeWs, refreshWorkspaces])

  // ---------- v3.1.2 条目7：会话准备态交互 ----------
  /** 准备态草稿变更 → 同步 state + 防抖落 nav.prep.draft（切走切回还原的关键） */
  const onPrepDraftChange = useCallback((text: string) => {
    setInput(text)
    const sid = activeIdRef.current
    if (!sid) return
    if (prepDraftTimer.current) window.clearTimeout(prepDraftTimer.current)
    prepDraftTimer.current = window.setTimeout(() => {
      const prev = readNav(sid).prep ?? {}
      writeNav(sid, { prep: { ...prev, started: false, draft: text } })
    }, 300)
  }, [])
  /** 准备态折叠条开合 → 同步 state + nav（切回时还原到切走瞬间） */
  const onPrepFold = useCallback((which: 'src' | 'req') => {
    const sid = activeIdRef.current
    const nextSrc = which === 'src' ? !prepSrcOpen : prepSrcOpen
    const nextReq = which === 'req' ? !prepReqOpen : prepReqOpen
    setPrepSrcOpen(nextSrc); setPrepReqOpen(nextReq)
    if (sid) {
      const prev = readNav(sid).prep ?? {}
      writeNav(sid, { prep: { ...prev, started: false, srcOpen: nextSrc, reqOpen: nextReq } })
    }
  }, [prepSrcOpen, prepReqOpen])
  /** 「开始对话」：退出准备态 → 发首条消息（走既有 doSend，首轮即带素材目录 + 会话要求 + 用户消息） */
  const startPreparedChat = useCallback(() => {
    const sid = activeIdRef.current
    if (!sid) return
    const text = input.trim()
    if (!text || pending || compressing) return
    const prev = readNav(sid).prep ?? {}
    writeNav(sid, { prep: { ...prev, started: true } }) // 开讲标记：此后切回不再进准备态
    setPrepNavSeq(n => n + 1)
    setPrepStarted(true); setPrepTemplate(null)
    void doSend(text)
  }, [input, pending, compressing, doSend])

  // ---------- P5：工作区进出与管理 ----------
  const enterWs = useCallback((id: string) => {
    setActiveWs(id); activeWsRef.current = id
    setWsSearch('')
    if (id !== '__none__') void aiTeachSetLastWorkspace(id)
    const own = sessions
      .filter(s => (wsSessionMap[s.id] ?? '__none__') === id)
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))) // 真机验证补口：旧数据/未映射行 updatedAt 可能缺失，排序不得抛
    if (own.length) {
      void openSession(own[0].id, own[0].title)
    } else {
      activeIdRef.current = null
      setActiveId(null); setActiveTitle(''); setMessages([]); setLastChanges(null); setLiveSteps([]); setArtTabs([]); setArtActive(null)
      setActiveInstr(''); setInstrRel('')
      setMidView('chat'); setQuizOpen(false); setLastQuizReport(null)
    }
    void refreshSessions()
  }, [sessions, wsSessionMap, openSession, refreshSessions])
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

  /** P7：快捷发问（空题目视图引导；与输入框同链路，自动带 aiTeaching 规则） */
  const sendQuick = useCallback((text: string) => {
    if (pending) return
    if (!activeIdRef.current) { showToast({ type: 'warning', message: '先在「对话」里发一条消息或新建任务' }); return }
    setMidView('chat')
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    void sendText(text, cid)
  }, [pending, sendText])

  /** P7（测验结果联动产物）：整卷答完 → 报告 md 落会话文件夹 `测验·随堂测验 MM-DD HH:mm.md` */
  const handleQuizFinish = useCallback(async (s: { total: number; correctCount: number; records: Array<{ no: number; correct: boolean; picked: string }> }) => {
    const sid = activeIdRef.current
    if (!sid) return
    const now = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const stamp = `${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`
    const byNo = new Map(quizItems.map(q => [q.no, q]))
    const pct = s.total ? Math.round((s.correctCount / s.total) * 100) : 0
    const lines: string[] = [
      '### 随堂测验报告',
      '',
      `> 会话「${activeTitle || '未命名'}」 · 得分 **${s.correctCount} / ${s.total}**（${pct}%） · ${stamp}`,
      '',
      '| 题号 | 我的答案 | 结果 |',
      '|---|---|---|',
      ...s.records.map(r => `| ${r.no} | ${r.picked} | ${r.correct ? '✓' : '✗'} |`),
    ]
    const wrong = s.records.filter(r => !r.correct)
    if (wrong.length) {
      lines.push('', '## 错题解析', '')
      for (const r of wrong) {
        const item = byNo.get(r.no)
        if (!item) continue
        lines.push(`**第 ${item.no} 题** ${(item.question || '').replace(/\s*\n+\s*/g, ' ').slice(0, 200)}`, '', `我选了 ${r.picked}，正确答案 **${item.answer}**。`, '', item.explanation || '（本题无解析）', '')
      }
    } else {
      lines.push('', '全部答正确，保持状态 💪')
    }
    lines.push('', '_报告由 AI教学题目视图在答题完成后自动生成；题干与解析以对话原文为准。_')
    const r = await aiTeachOrganizeDoc(sid, `随堂测验 ${stamp}`, lines.join('\n'), '测验').catch(() => null)
    if (r && r.ok && r.relPath) {
      setLastQuizReport({ rel: r.relPath, score: `${s.correctCount}/${s.total}` })
      showToast({ type: 'info', message: `测验成绩 ${s.correctCount}/${s.total} · 报告已存 ${r.relPath.split('/').pop()}` })
      void refreshWorkspaces()
    } else {
      showToast({ type: 'error', message: `测验报告落盘失败${r?.error ? `：${r.error}` : ''}` })
    }
  }, [quizItems, activeTitle, refreshWorkspaces])

  // ---------- P6 素材库（§3.13 结构 v3：SOURCE.md 登记 + 区间提取稿） ----------
  const [srcEntries, setSrcEntries] = useState<AiTeachSourceEntry[]>([])
  const [srcFileRel, setSrcFileRel] = useState<string | null>(null)
  const [srcForm, setSrcForm] = useState<null | { name: string; type: string; path: string; storage: '已入库' | '仅引用'; rangeFrom: string; rangeTo: string; note: string }>(null)
  const [srcBusy, setSrcBusy] = useState<number | null>(null)
  const [visionBusy, setVisionBusy] = useState<null | { no: number; label: string; done?: number; total?: number }>(null)
  /** 网页素材「展开网页」对话框（web-crawl P3）：{no,name,path} 非空即开 */
  const [webDlg, setWebDlg] = useState<null | { no: number; name: string; path: string }>(null)
  // ===== 右栏素材库改造（docs/ai-teaching-sources-panel-rework.md）=====
  // 过滤 chips / 分组折叠 / 紧凑收起 = 纯视图态，localStorage 持久；不触碰 SOURCE.md 与 AI 注入口径
  const [srcFilter, setSrcFilterRaw] = useState<string>(() => { try { return localStorage.getItem('aiTeach.srcFilter') || 'all' } catch { return 'all' } })
  const [srcCompact, setSrcCompactRaw] = useState<boolean>(() => { try { return localStorage.getItem('aiTeach.srcCompact') === '1' } catch { return false } })
  const [groupClosed, setGroupClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('aiTeach.srcGroupClosed') ?? '[]') as string[]) } catch { return new Set<string>() } })
  const setSrcFilter = (k: string) => { setSrcFilterRaw(k); try { localStorage.setItem('aiTeach.srcFilter', k) } catch { /* 隐私模式忽略 */ } }
  const setSrcCompact = (v: boolean) => { setSrcCompactRaw(v); try { localStorage.setItem('aiTeach.srcCompact', v ? '1' : '0') } catch { /* 隐私模式忽略 */ } }
  const toggleSrcGroup = (k: string) => setGroupClosed(prev => {
    const n = new Set(prev)
    if (n.has(k)) n.delete(k); else n.add(k)
    try { localStorage.setItem('aiTeach.srcGroupClosed', JSON.stringify([...n])) } catch { /* 隐私模式忽略 */ }
    return n
  })
  /** 素材卡片（两行 DOM 不变；第二行包 grid-rows 折叠壳：紧凑收起=0fr+opacity，只动 grid-rows/padding，方案 2.2/落地4） */
  const renderSrcCard = (e: AiTeachSourceEntry) => {
    const extMatch = /^✓\s*→\s*(.+)$/.exec(e.extracted)
    // v3.1.1 两层合并：提取稿/原件相对「条目所属层」的素材夹（工作区主库 vs 对话私有存量），
    // 逐条目携带（e.dirRel），不能再用主库 srcFileRel 统一推导 —— 会话存量会被拼到错误目录
    const dirRel = e.dirRel || (srcFileRel ? srcFileRel.slice(0, srcFileRel.lastIndexOf('/')) : '')
    const extractable = (e.type === 'pdf' || e.type === 'pptx' || e.type === 'docx' || e.type === 'code') && !extMatch && e.range && e.range !== '-' // 条目10：code 按行号区间提取；v3.1.2 条目5：docx 先经 soffice 转 PDF 再提取
    const inRepo = e.path.startsWith('./') || (srcFileRel && !/^[a-zA-Z]:|^https?:|^\//.test(e.path))
    return (
      <div key={e.no} className={`rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 kb-group-anim transition-[padding] duration-[320ms] ${SRC_EASE} ${srcCompact ? 'py-[3px]' : 'py-1.5'}`}>
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-[10px] font-medium text-[var(--text-muted)]">#{e.no}</span>
          <span className="flex-1 min-w-0 truncate text-[11.5px] text-[var(--text-primary)]" title={e.note || e.name}>{e.name}</span>
          {e.scope === 'session' && (
            <span className="shrink-0 px-1 rounded text-[9.5px] text-[var(--warning)] border border-[var(--warning)]/40" title="对话私有补充（历史登记）：可经右上「上收」并入工作区主库，跨对话共用">对话</span>
          )}
          <span className="shrink-0 px-1 rounded text-[9.5px] uppercase text-[var(--text-muted)] border border-[var(--border-color)]">{e.type}</span>
        </div>
        <div className={`grid kb-group-anim transition-[grid-template-rows,opacity] duration-[320ms] ${SRC_EASE} ${srcCompact ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}>
          <div className="min-h-0 overflow-hidden">
            <div className="pt-1 flex items-center gap-2 text-[10.5px] text-[var(--text-muted)]">
              {e.range && e.range !== '-' && <span title={e.type === 'code' ? '行号区间' : '页码区间'}>{e.type === 'code' ? 'L' : 'p'}{e.range}</span>}
              <span title={e.path}>{e.storage === '已入库' ? '已入库' : (e.path.startsWith('http') ? '链接' : '引用')}</span>
              <div className="ml-auto flex items-center gap-1.5">
                {e.type === 'url' && /^https?:\/\//i.test(e.path) && (
                  <button onClick={() => setWebDlg({ no: e.no, name: e.name, path: e.path })}
                    title={extMatch ? '补抓/重抓：已存在章节自动跳过，只补失败与新增页' : '展开网页：探测目录/单文章，勾选章节批量抓取为提取稿（零 token 纯程序流水线）'}
                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">{extMatch ? '补抓' : '展开网页'}</button>
                )}
                {extMatch && dirRel && (
                  <button onClick={() => { void openArtFile(`${dirRel}/${extMatch[1].trim()}`) }} title="阅读提取稿（可编辑）"
                    className="text-[var(--accent)] hover:opacity-80 transition-opacity">提取稿 ✓</button>
                )}
                {extractable && (
                  <button onClick={() => { void doExtract(e.no) }} disabled={srcBusy === e.no}
                    className="flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 transition-colors">
                    {srcBusy === e.no ? <Loader2 size={9} className="animate-spin" /> : <BookOpen size={9} />}{srcBusy === e.no ? '提取中…' : '提取'}
                  </button>
                )}
                {(e.type === 'pdf' || e.type === 'pptx' || e.type === 'docx') && e.path && e.path !== '-' && (
                  /* 3-21 手动档→分批流水线：区间页栅格化→视觉模型转写（公式/图形/扫描件），
                     >12 页自动分批+断点续转（提取稿已有页跳过），结果非破坏并入提取稿；
                     pptx（2026-09-09 B 方案）由主进程 soffice 转 PDF 后同链路栅格化 */
                  <button onClick={() => { void doTranscribe(e.no) }} disabled={!!visionBusy}
                    title={visionBusy?.no === e.no ? visionBusy.label : (e.type === 'pptx' || e.type === 'docx')
                      ? `视觉转写：${e.type === 'docx' ? 'Word 文档' : 'pptx'} 先经本机 LibreOffice 转 PDF 再逐页转写（需已安装 LibreOffice；装在自定义目录时可在「设置 → AI 工具 → 模型 → LibreOffice 路径」手动指定，无需重启）；文本提取多数情况下已够用`
                      : '视觉转写：把登记区间的页面交给视觉模型转写（>12 页自动分批、断点续转），并入提取稿后可编辑。点击可中途停止'}
                    className="flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 transition-colors">
                    {visionBusy?.no === e.no ? <Loader2 size={9} className="animate-spin" /> : <Eye size={9} />}
                    {visionBusy?.no === e.no ? '转写中…' : '转写'}
                  </button>
                )}
                {(e.type === 'pdf' || e.type === 'pptx' || e.type === 'docx') && e.path && e.path !== '-' && (
                  /* 同一原件再加区间（2026-09-08 用户需求）：一个 PDF 多章 = 多条目共享同一份
                     已入库原件（不再重复拷贝），各条目独立转写/提取/编号引用 */
                  <button onClick={() => setSrcForm({ name: e.name, type: e.type, path: e.path, storage: '仅引用', rangeFrom: '', rangeTo: '', note: '' })}
                    title="同一文件换个页码区间再登记一条（如另一章）——不重复拷贝原件"
                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">再加区间</button>
                )}
                {inRepo && e.path.startsWith('./') && dirRel && e.type === 'pptx' && (
                  <button onClick={() => { void openArtFile(`${dirRel}/${e.path.slice(2)}`, { name: e.name }) }} title="逐页阅读原件"
                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">原件</button>
                )}
                <button onClick={() => { void doRemoveSrc(e.no, e.name) }} title="移除登记（不删文件）"
                  className="text-[var(--text-muted)] hover:text-red-400 transition-colors"><X size={10} /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }
  const [srcAnom, setSrcAnom] = useState<{ unnamed: number; dupNo: number; noPath?: number } | null>(null)
  /** v3.1.1：对话级补充文件路径（非空 = 该对话还有存量「对话私有补充」条目，显示上收入口） */
  /**
   * v3.2.0 条目 ④：左栏「资源管理器」树的重扫计数（原始类型 prop → memo 化的 AiTeachFileTree）。
   * 两个来源共用它：外部文件系统变更广播、左栏头部的手动刷新按钮。
   */
  const [treeRefreshSeq, setTreeRefreshSeq] = useState(0)
  /** 左栏手动刷新进行中（转圈 + 防连点；子组件重扫与其并行，不复位展开态） */
  const [treeRefreshing, setTreeRefreshing] = useState(false)
  const [srcSessionRel, setSrcSessionRel] = useState<string | null>(null)
  /**
   * v3.1.1：素材库 = **工作区主库 + 本对话存量**合并；sid 为空也照常读（工作区库脱离对话常驻，
   * 无对话也能浏览/登记/移除——解开「导素材要先建对话」的冷启动死结）。
   */
  const refreshSources = useCallback(async (sid: string | null) => {
    const r = await aiTeachSrcRead(sid ?? '').catch(() => null)
    if (r?.ok) {
      setSrcEntries(r.entries ?? []); setSrcFileRel(r.relPath ?? null); setSrcAnom(r.anomalies ?? null)
      setSrcSessionRel(r.sessionRel ?? null)
    }
    else { setSrcEntries([]); setSrcFileRel(null); setSrcAnom(null); setSrcSessionRel(null) }
  }, [])
  useEffect(() => { void refreshSources(activeId) }, [activeId, refreshSources])
  /** UI 优化条目5.3（真机 B1/B6 同根因）：SOURCE.md / CONSTRAINTS.md 变更后右栏与弹层即时回读。
   *  四路触发：①应用内保存（`ipc.workspaceWriteFile` 落盘后广播 `kb:file-saved`）；②程序写入
   *  （主进程 `aiTeach:tree-refresh`：表单登记/提取/移除/AI 直接写文件）；③本 Tab 重新激活；
   *  ④窗口聚焦（应用外编辑器改文件——项目无 fs 监听，聚焦回读是最省成本的兜底策略）。
   *  约束侧只在「文件确实存在」时更新展示值，旧无文件夹会话不回退覆盖；弹层打开且草稿未落盘时不覆盖草稿。 */
  const instrStateRef = useRef({ open: false, draft: '' })
  useEffect(() => { instrStateRef.current = { open: instrOpen, draft: instrDraft } }, [instrOpen, instrDraft])
  const syncSessionFiles = useCallback((opts: { sources: boolean; constraints: boolean; doc?: string | null }) => {
    const sid = activeIdRef.current
    // v3.1.1：素材库常驻工作区层 —— 无对话也要回读（sid=null 时读的是工作区主库）；约束文件仍属对话私有，无对话跳过
    if (opts.sources) void refreshSources(sid)
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
    // 条目6B 配套 + 工件栏 §2：打开中的页签回读磁盘（编辑器保存/程序重写后即时反映，滚动位置按文件记忆恢复）
    const rel = opts.doc ?? null
    const openTabs = artTabsRef.current.filter(t => !t.generating && t.rel && (rel ? t.rel === rel : t.kind === 'md'))
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
  }, [refreshSources])
  useEffect(() => {
    const onSaved = (e: Event) => {
      const rel = String((e as CustomEvent).detail?.relPath ?? '')
      const base = rel.split(/[\\/]/).pop() ?? ''
      const artHit = !!rel && artTabsRef.current.some(t => !t.generating && t.rel === rel)
      if (base !== 'SOURCE.md' && base !== 'CONSTRAINTS.md' && !artHit) return
      syncSessionFiles({ sources: base === 'SOURCE.md', constraints: base === 'CONSTRAINTS.md', doc: artHit ? rel : null })
    }
    const onTree = () => syncSessionFiles({ sources: true, constraints: true })
    const onFocus = () => syncSessionFiles({ sources: true, constraints: true })
    window.addEventListener('kb:file-saved', onSaved)
    window.addEventListener('focus', onFocus)
    const off = onAiTeachTreeRefresh(onTree)
    // v3.2.0 条目 ④：仓库目录被外部改动（资源管理器 / 外部编辑器 / git）→ 右栏回读 + 左栏树重扫。
    // watcher 降级告知由编辑器侧统一 toast（同一条广播会送达所有窗口），这里不重复提示。
    const offFs = onWsFsChanged(({ watcherError }) => {
      if (watcherError) return
      onTree()
      setTreeRefreshSeq(n => n + 1)
    })
    return () => { window.removeEventListener('kb:file-saved', onSaved); window.removeEventListener('focus', onFocus); off(); offFs() }
  }, [syncSessionFiles])
  // 切回本模块 Tab：回读一次（保活组件不卸载，isActive 是唯一「重新可见」信号）
  useEffect(() => { if (isActive) syncSessionFiles({ sources: true, constraints: true }) }, [isActive, syncSessionFiles])
  const openSrcFile = (rel: string) => window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: rel, from: 'aiTeaching' } }))
  const submitSrcForm = async () => {
    if (!srcForm) return
    const name = srcForm.name.trim()
    if (!name) { showToast({ type: 'warning', message: '素材名称必填' }); return }
    // 「再加区间」条目自动派生名：区间有效且名称未手动区分（不含 ·p 标记）时补「·p{起}-{终}」——
    // 同一原件多条目在素材库/AI 注入中可辨识
    const rf = srcForm.rangeFrom.trim()
    const rt = srcForm.rangeTo.trim()
    const finalName = rf && !/·p\d+/.test(name) ? `${name}·p${rf}${rt && rt !== rf ? `-${rt}` : ''}` : name
    // v3.1.1：登记一律落工作区主库（activeId 只用于定位工作区层，无对话也能登记）
    const r = await aiTeachSrcAdd(activeId ?? '', {
      name: finalName, path: srcForm.path.trim(), storage: srcForm.storage,
      rangeFrom: srcForm.rangeFrom.trim() || undefined, rangeTo: srcForm.rangeTo.trim() || undefined, note: srcForm.note.trim(),
    }).catch((e: Error) => ({ ok: false as const, error: e.message }))
    const rr = r as { ok: boolean; error?: string; corrected?: { from: string; to: string } }
    if (r.ok) {
      await refreshSources(activeId); setSrcForm(null)
      // 类型自动纠错提示：登记类型与文件扩展名不符时主进程已按扩展名纠正（否则提取/阅读器会用错解析器）
      showToast(rr.corrected
        ? { type: 'info', message: `✓ 已写入 SOURCE.md（类型已按文件扩展名从 ${rr.corrected.from} 纠正为 ${rr.corrected.to}）` }
        : { type: 'info', message: '✓ 已写入 SOURCE.md' })
    }
    else showToast({ type: 'error', message: `登记失败：${rr.error ?? '未知错误'}` })
  }
  const pickSrcFile = async () => {
    const r = await aiTeachSrcPick().catch(() => null)
    if (r?.ok && r.path) setSrcForm(f => (f ? { ...f, path: r.path as string, storage: '已入库' } : f))
  }
  // 登记仓库目录为素材：仅引用（不拷贝），主进程按目录自动检测类型 dir，注入时展开文件清单
  const pickSrcDir = async () => {
    const r = await aiTeachSrcPickDir().catch(() => null)
    if (!r) return
    if (r.ok && r.path) setSrcForm(f => (f ? { ...f, path: r.path as string, type: 'dir', storage: '仅引用' } : f))
    else if (!r.ok) showToast({ type: 'error', message: r.error ?? '选择目录失败' })
  }
  const doExtract = async (no: number) => {
    setSrcBusy(no)
    const r = await aiTeachSrcExtract(activeId ?? '', no).catch((e: Error) => ({ ok: false as const, error: e.message }))
    setSrcBusy(null)
    if (r.ok && r.relPath) { await refreshSources(activeId); showToast({ type: 'info', message: `提取完成：${r.relPath.split('/').pop()}` }); openSrcFile(r.relPath) }
    else showToast({ type: 'error', message: `提取失败：${(r as { error?: string }).error ?? '未知错误'}` })
  }
  /** 3-21 视觉转写（2026-09-08 升级为分批流水线）：区间 ≤12 页即时转；>12 页按 12 页/批
   *  逐批「栅格化→视觉模型转写→并入提取稿」，进度可停（已完成批保留），断点续转靠主进程
   *  跳过提取稿中已有页（重发同区间零重复消耗）。 */
  const transcribeStopRef = useRef(false)
  const doTranscribe = async (no: number) => {
    if (visionBusy) return
    const e = srcEntries.find(x => x.no === no)
    if (!e) return
    const rm = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(e.range.trim())
    if (e.range.trim() === '-' || !rm) { showToast({ type: 'warning', message: '先登记页码区间（编辑 SOURCE.md 或重新登记），再视觉转写' }); return }
    const from0 = Math.max(1, parseInt(rm[1], 10))
    const to0 = rm[2] ? parseInt(rm[2], 10) : from0
    const total = Math.max(1, to0 - from0 + 1)
    if (total > 12) {
      const batches = Math.ceil(total / 12)
      const yes = await showGlobalConfirm({
        title: '分批视觉转写',
        message: `区间 p${from0}-${to0} 共 ${total} 页，将按 12 页/批分 ${batches} 批逐批转写（每批一次视觉模型调用）。可随时停止，已完成批保留、重发自动续转。开始？`,
        confirmLabel: `开始转写 ${total} 页`,
      })
      if (!yes) return
    }
    // 视觉模型预检：栅格化之前确认可用（否则白跑一堆页面位图才失败），错误含配置指引
    setVisionBusy({ no, label: '检查视觉模型…' })
    const vc = await aiTeachSrcVisionCheck().catch(() => null)
    if (!vc?.ok) { setVisionBusy(null); showToast({ type: 'error', message: vc?.error ?? '视觉模型预检失败' }); return }
    setVisionBusy({ no, label: `读取原件…（视觉模型：${vc.model}）` })
    transcribeStopRef.current = false
    try {
      const b = await aiTeachSrcPdfBytes(activeId ?? '', no)
      if (!b?.ok || !b.base64) { showToast({ type: 'error', message: `视觉转写失败：${b?.error ?? '原件不可读'}` }); return }
      const pdfjs = await import('pdfjs-dist')
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.js?url')).default
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      const bytes = Uint8Array.from(atob(b.base64), c => c.charCodeAt(0))
      const doc = await pdfjs.getDocument({ data: bytes }).promise
      const from = from0
      const to = Math.min(doc.numPages, Math.max(from0, to0))
      let doneTotal = 0
      let skippedTotal = 0
      const failedPages: number[] = []
      let lastRel: string | undefined
      let lastModel = ''
      let failMsg = ''
      let bi = 0
      const totalBatches = Math.ceil((to - from + 1) / 12)
      for (let f = from; f <= to; f += 12) {
        bi++
        if (transcribeStopRef.current) { showToast({ type: 'info', message: `视觉转写已停止：已完成 ${doneTotal} 页（重发同区间将自动续转）` }); break }
        const t = Math.min(to, f + 11)
        const pages: { n: number; dataUrl: string }[] = []
        for (let n = f; n <= t; n++) {
          if (transcribeStopRef.current) break
          setVisionBusy({ no, label: `第 ${bi}/${totalBatches} 批 · 栅格化 p${n}/${t}`, done: doneTotal, total: to - from + 1 })
          const page = await doc.getPage(n)
          const vp = page.getViewport({ scale: 2 })
          const cvs = document.createElement('canvas')
          cvs.width = Math.floor(vp.width); cvs.height = Math.floor(vp.height)
          const ctx = cvs.getContext('2d')
          if (!ctx) { page.cleanup(); continue }
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cvs.width, cvs.height)
          await page.render({ canvasContext: ctx, viewport: vp }).promise
          pages.push({ n, dataUrl: cvs.toDataURL('image/jpeg', 0.82) })
          page.cleanup()
        }
        if (pages.length === 0) continue
        setVisionBusy({ no, label: `第 ${bi}/${totalBatches} 批 · 视觉模型转写 ${pages.length} 页…（已转 ${doneTotal} 页）`, done: doneTotal, total: to - from + 1 })
        const r = await aiTeachSrcTranscribe(activeId ?? '', no, pages, visionModel || undefined).catch((err: Error) => ({ ok: false as const, error: err.message }))
        if (!r?.ok) { failMsg = `视觉转写失败：${(r as { error?: string }).error ?? ''}（已完成 ${doneTotal} 页保留，可重发续转）`; break }
        lastRel = r.relPath ?? lastRel
        lastModel = r.model ?? lastModel
        const d = r.done?.length ?? 0
        doneTotal += d
        skippedTotal += r.skipped?.length ?? 0
        if (r.failed?.length) failedPages.push(...r.failed)
        await refreshSources(activeId)
      }
      void doc.destroy()
      if (failMsg) { showToast({ type: 'error', message: failMsg }); return }
      if (transcribeStopRef.current) { showToast({ type: 'info', message: `视觉转写已停止：已完成 ${doneTotal} 页（重发同区间将自动续转）` }); return }
      if (doneTotal > 0 || skippedTotal > 0) {
        await refreshSources(activeId)
        if (lastRel) void openArtFile(lastRel)
        const fail = failedPages.length ? ` · ${failedPages.length} 页失败（重发同区间自动重试失败页）` : ''
        showToast({ type: 'info', message: `👁 视觉转写完成（${lastModel || '视觉模型'}）：转写 ${doneTotal} 页 · 跳过已转 ${skippedTotal} 页${fail}` })
      }
    } catch (err) {
      showToast({ type: 'error', message: `视觉转写失败：${(err as Error).message}` })
    } finally {
      setVisionBusy(null)
      transcribeStopRef.current = false
    }
  }
  const doRemoveSrc = async (no: number, nm: string) => {
    const yes = await showGlobalConfirm({ title: '移除素材登记', message: `从 SOURCE.md 删除条目 #${no}「${nm}」？素材原件与提取稿文件不会被删除。`, confirmLabel: '移除', variant: 'danger' })
    if (!yes) return
    const r = await aiTeachSrcRemove(activeId ?? '', no).catch((e: Error) => ({ ok: false as const, error: e.message }))
    if (r?.ok) { await refreshSources(activeId); showToast({ type: 'info', message: '已移除登记' }) }
    else showToast({ type: 'error', message: `移除失败：${(r as { error?: string })?.error ?? ''}` })
  }
  /** v3.1.1 上收：对话私有存量（含已入库原件与提取稿）并入工作区主库，之后所有对话共用。
   *  部分失败时主库已迁入的条目保留、失败项留在对话级可重试（promoteSessionSources 原子语义）。 */
  const doPromoteSources = async () => {
    if (!activeId) return
    const n = srcEntries.filter(e => e.scope === 'session').length
    const yes = await showGlobalConfirm({
      title: '上收素材到工作区主库',
      message: `把本对话登记的 ${n} 条素材并入工作区主库？原件与提取稿一并复制过去，此后所有对话都能直接引用，本对话不再单独保留登记。`,
      confirmLabel: '上收',
    })
    if (!yes) return
    const r = await aiTeachSrcPromote(activeId).catch((e: Error) => ({ ok: false as const, error: e.message }))
    if (r?.ok) {
      await refreshSources(activeId)
      showToast({ type: 'info', message: (r as { promoted?: number }).promoted ? `已上收 ${(r as { promoted?: number }).promoted} 条到工作区主库` : '对话级没有需要上收的登记' })
    }
    else showToast({ type: 'error', message: `上收失败：${(r as { error?: string })?.error ?? ''}` })
  }

  // ---------- P8 用户画像（§3.14；三层 = 三份仓库内 PROFILE.md，编辑一律跳编辑区——第三轮「C 移入仓库」拍板） ----------
  /** 12/13：最新一个未答 ```ask 块（只挂最新一条 assistant 回答里的；其后出现用户消息即视为已答）
   *  （声明于 Esc 效应之前：Esc「先关浮层」链引用 askVisible，置后声明会 TDZ） */
  const askPending = useMemo<AskBlock | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user') return null
      const mt = /```ask[^\n]*\n([\s\S]*?)```/.exec(m.content)
      return mt ? parseAskBlock(mt[1], m.id ?? `idx${i}`) : null
    }
    return null
  }, [messages])
  const [askDismissed, setAskDismissed] = useState<string | null>(null)
  const [askPicks, setAskPicks] = useState<Record<number, string>>({})
  // 提问卡 v2（WorkBuddy 式）：整卷 ‹k/n› 翻页 + 每题「其他补充」自定义回答
  const [askPage, setAskPage] = useState(0)
  const [askCustomOpen, setAskCustomOpen] = useState(false)
  const [askCustom, setAskCustom] = useState('')
  const askVisible = !!askPending && askDismissed !== askPending.id
  /** 条目9：提问卡收起二态（不丢 askPending 与点选状态；换 ask 重置） */
  const [askCollapsed, setAskCollapsed] = useState(false)
  useEffect(() => { setAskPicks({}); setAskPage(0); setAskCustomOpen(false); setAskCustom(''); setAskCollapsed(false) }, [askPending?.id]) // 换 ask 重置整卷点选/翻页/补充/收起

  const [profDismissed, setProfDismissed] = useState(false)
  useEffect(() => { setProfDismissed(false) }, [messages])
  /**
   * v3.2.0 条目7：画像建议「预览」= **就地受控展开/收起**。
   * 原实现是对 `[data-profile-suggestion]`（那是个默认收起的 `<details>`，且横幅本身在消息滚动容器
   * **之外**、是输入区上方的页脚带、任何时刻完整可见）调 `scrollIntoView` —— 对「最近可滚动祖先为零」
   * 的元素，浏览器什么也不做，于是用户视角就是「点了没反应」（onClick 其实触发了）。
   * 受控 state 还让按钮文案（预览 ↔ 收起）与展开态天然一致，并消掉那处全文档 querySelector 脆弱点。
   */
  const [profPreviewOpen, setProfPreviewOpen] = useState(false)
  useEffect(() => { setProfPreviewOpen(false) }, [messages])
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
      if (srcForm) { setSrcForm(null); return }
      if (wsModal) { setWsModal(null); return }
      if (instrOpen) { setInstrOpen(false); return }
      if (tokenOpen) { setTokenOpen(false); return }
      if (showNewMenu) { setShowNewMenu(false); return }
      if (leftNewMenu) { setLeftNewMenu(false); return }
      if (modelMenuOpen) { setModelMenuOpen(false); return }
      // v3.1.2 条目11：支线旁问面板（浮层/宽轨）——模态类浮层都关掉后再轮到这里
      if (sideLane) { setSideLane(null); return }
      if (!zenActive) return
      e.preventDefault()
      onZenLevelChange?.(0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive, zenActive, onZenLevelChange, askVisible, askPending, askCollapsed, srcForm, wsModal, instrOpen, tokenOpen, showNewMenu, leftNewMenu, modelMenuOpen, sideLane])
  /** 最新一条 assistant 回答里的 ```profile 围栏 = 画像更新建议（接受才写文件） */
  const profileSuggestion = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      const mt = /```profile[^\n]*\n([\s\S]*?)```/.exec(m.content)
      return mt ? { text: mt[1].trim() } : null
    }
    return null
  }, [messages])
  /** 画像编辑 = 确保对应层文档存在（缺则落骨架）后直接跳编辑区打开；编辑器顶栏「← 返回 AI教学」回跳（条目6 已实现） */
  const openProfile = useCallback(async (layer: 'global' | 'workspace' | 'session', wsId?: string | null) => {
    if (layer === 'session' && !activeId) { showToast({ type: 'warning', message: '本主题画像随对话存放：先选择或新建一个对话' }); return }
    if (layer === 'workspace' && !wsId && !(activeWs && activeWs !== '__none__')) { showToast({ type: 'warning', message: '先进入一个工作区' }); return }
    const wid = wsId ?? activeWs
    const r = layer === 'global' ? await aiTeachProfileEnsureGlobal().catch(() => null)
      : layer === 'workspace' ? await aiTeachProfileEnsureWorkspace(wid!).catch(() => null)
      : await aiTeachProfileEnsureSession(activeId!).catch(() => null)
    if (!r?.ok || !r.relPath) { showToast({ type: 'error', message: `画像打开失败${r?.error ? `：${r.error}` : ''}` }); return }
    window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: r.relPath, from: 'aiTeaching' } }))
    showToast({ type: 'info', message: `画像文档已在编辑区打开（${r.created ? '已按骨架创建' : '已有文件'}）· 编辑器顶栏可「← 返回 AI教学」` })
  }, [activeId, activeWs])
  /** 全局要求编辑 = ensure 产物根 CONSTRAINTS.md（缺则落骨架）→ 跳编辑区打开；与全局画像同款交互（global-constraints 方案） */
  const openGlobalConstraints = useCallback(async () => {
    const r = await aiTeachGlobalEnsureConstraints().catch(() => null)
    if (!r?.ok || !r.relPath) { showToast({ type: 'error', message: `全局要求打开失败${r?.error ? `：${r.error}` : ''}` }); return }
    window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: r.relPath, from: 'aiTeaching' } }))
    showToast({ type: 'info', message: `全局要求已在编辑区打开（${r.created ? '已按骨架创建' : '已有文件'}）· 保存后所有会话下一轮生效` })
  }, [])
  /** v3.1.2 条目6：工作区要求编辑 = ensure {工作区}/CONSTRAINTS.md（缺则落骨架）→ 跳编辑区打开；与全局要求同款交互 */
  const openWorkspaceConstraints = useCallback(async (wsId?: string | null) => {
    const wid = wsId ?? activeWs
    if (!wid || wid === '__none__') { showToast({ type: 'warning', message: '会话未归属工作区，无工作区要求层' }); return }
    const r = await aiTeachWorkspaceEnsureConstraints(wid).catch(() => null)
    if (!r?.ok || !r.relPath) { showToast({ type: 'error', message: `工作区要求打开失败${r?.error ? `：${r.error}` : ''}` }); return }
    window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: r.relPath, from: 'aiTeaching' } }))
    showToast({ type: 'info', message: `工作区要求已在编辑区打开（${r.created ? '已按骨架创建' : '已有文件'}）· 保存后本工作区会话下一轮生效` })
  }, [activeWs])
  const acceptProfileSuggestion = useCallback(async (target: 'global' | 'workspace' | 'session') => {
    if (!profileSuggestion) return
    if (target === 'session' && !activeId) return
    if (target === 'workspace' && !(activeWs && activeWs !== '__none__')) return
    const r = target === 'global'
      ? await aiTeachProfileWriteGlobal(profileSuggestion.text).catch(() => null)
      : target === 'workspace'
        ? await aiTeachProfileWriteWorkspace(activeWs!, profileSuggestion.text).catch(() => null)
        : await aiTeachProfileWriteSession(activeId!, profileSuggestion.text).catch(() => null)
    if (r?.ok) { setProfDismissed(true); showToast({ type: 'info', message: `已写入${target === 'global' ? '全局' : target === 'workspace' ? '工作区' : '本主题'}画像 · 下轮生效` }) }
    else showToast({ type: 'error', message: '画像写入失败' })
  }, [profileSuggestion, activeId, activeWs])

  // ---------- UI 优化条目11/12/13：任务规划激活（plan 协议）+ 提问模式（ask 协议） ----------
  /** 11A：最新一份 ```plan 围栏（AI 阶段推进时输出；随消息历史自动恢复，无需单独落库） */
  const planState = useMemo<Array<{ step: string; status: 'done' | 'current' | 'todo' }> | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      const mt = /```plan[^\n]*\n([\s\S]*?)```/.exec(m.content)
      if (!mt) continue
      try {
        const arr: unknown = JSON.parse(mt[1].trim())
        if (!Array.isArray(arr)) continue
        const steps = (arr as Array<Record<string, unknown>>)
          .map(x => ({ step: String(x?.step ?? '').slice(0, 24), status: x?.status === 'done' ? 'done' as const : x?.status === 'current' ? 'current' as const : 'todo' as const }))
          .filter(x => x.step)
        if (steps.length > 0) return steps
      } catch { /* 半截/坏块忽略，回落模板播种 */ }
    }
    return null
  }, [messages])
  /** 11B：数据佐证徽标——产物文档数（会话文件夹内 md 文件，排除登记表/约束文件） */
  const [prodCount, setProdCount] = useState(0)
  useEffect(() => {
    let alive = true
    setProdCount(0)
    if (!activeId) return
    void (async () => {
      const f = await aiTeachSessionFolder(activeId).catch(() => null)
      if (!f?.ok || !f.relPath || !alive) return
      const cur = await workspaceGetCurrent().catch(() => null)
      const rootId = (cur as { rootId?: string } | null)?.rootId
      if (!rootId || !alive) return
      const list = await workspaceListDir(rootId, f.relPath).catch(() => null)
      if (!alive) return
      const n = Array.isArray(list)
        ? (list as Array<{ name?: string; type?: string }>).filter(e => e?.type === 'file' && /\.md$/i.test(String(e.name)) && !/^(SOURCE|CONSTRAINTS)\.md$/i.test(String(e.name))).length
        : 0
      setProdCount(n)
    })()
    return () => { alive = false }
  }, [activeId, messages.length, srcEntries.length])
  /** 11B：步骤 → 数据徽标（关键词口径；计数为 0 不显示） */
  const planBadge = useCallback((step: string): string | null => {
    if (/测验|练习|出题/.test(step)) return quizItems.length > 0 ? `${quizItems.length} 题` : null
    if (/资料|素材|讲义/.test(step)) return srcEntries.length > 0 ? `${srcEntries.length} 条素材` : null
    if (/笔记|草稿|报告|专题|写入|文档|总结|讲解/.test(step)) return prodCount > 0 ? `${prodCount} 份产物` : null
    return null
  }, [quizItems.length, srcEntries.length, prodCount])
  /** 11A 交互：点击任意步骤 → 自动发跳步指令；当前步 hover「让 AI 讲解此步」同链路 */
  const jumpPlanStep = useCallback((idx: number, step: string, status: 'done' | 'current' | 'todo') => {
    if (pending) return
    if (!activeIdRef.current) { showToast({ type: 'warning', message: '先选择或新建一个对话' }); return }
    setMidView('chat')
    const cmd = status === 'current' ? `请讲解任务规划当前步骤「${step}」` : `请${status === 'done' ? '继续' : '推进到'}任务规划的第 ${idx + 1} 步「${step}」`
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    void sendText(cmd, cid)
  }, [pending, sendText])

  /** 12/13 回答动作：点选项 / 提交整卷 = 作为用户消息发出（ask 随新用户消息自动判已答） */
  const sendAskAnswer = useCallback((text: string) => {
    if (pending) return
    if (!activeIdRef.current) { showToast({ type: 'warning', message: '先选择或新建一个对话' }); return }
    const cid = crypto.randomUUID()
    chatIdRef.current = cid
    setAskDismissed(null)
    void sendText(text, cid)
  }, [pending, sendText])
  const submitAskExam = useCallback(() => {
    if (!askPending || askPending.kind !== 'exam' || pending) return
    const lines = askPending.questions.map((q, i) => `${i + 1}. ${q.question} → ${askPicks[i] ?? '（未答）'}`)
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
    setMidView('chat')
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

  // 占位事件（args 无 artifact）不计入工具次数（它只是「开始生成」信号，正式 tool step 另有一条）
  const toolCount = liveSteps.filter(s => s.kind === 'tool' && !(s.name === 'visual.html' && s.args && !s.artifact)).length
  const lastStep = liveSteps[liveSteps.length - 1]
  // ---------- 工件栏布局（§1.2/§1.3）：分隔条拖拽 + 双右栏联动 ----------
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
  /** 双窗口判定：工件栏有页签即在（内容驱动，无折叠态；空栏不挤占素材库） */
  const artExpanded = artTabs.length > 0
  // 支线旁问浮窗力学（v3.1.2 补强，2026-09-14 开发负责人拍板）：可拖动 + 八向缩放 + 拖近右缘自动停靠。
  // 舞台 = 三栏工作区行（rowRef，已是 position:relative）→ 拖拽范围 = 顶栏以下整个模块工作区；
  // 位置尺寸全局记忆（不随工作区/会话变）；双击顶栏复位。宽轨态交给 ResizablePanel，本 hook 只管浮层态。
  const floatWin = useFloatingWindow({
    storageKey: 'aiTeach.sideLaneWin',
    stageRef: rowRef,
    enabled: !!sideLane && !sideLaneWide,
    defaultW: 380, defaultH: 560, minW: 300, minH: 260,
    onDock: () => setSideLaneWide(true),
  })
  /** 窄窗兜底（§1.3）：<1100px 工件栏降宽至 40% */
  const artPctEff = rowW > 0 && rowW < 1100 ? Math.min(artPct, 40) : artPct
  // 工件栏展开 → 素材库自动收起（一次折叠动画，不改意图态）；工件栏关闭 → 不自动弹出素材库（2026-09-09 用户拍板），
  // 需要时经顶栏「素材库」chip / 右缘拉出条 / Ctrl+Alt+B 手动展开
  useEffect(() => {
    if (artExpanded) setSrcVisible(false)
  }, [artExpanded])
  // 工件栏分隔条拖拽：dead-zone 防误触（2026-09-09 修）
  // 老逻辑 mousedown 立刻改 cursor + 监听 mousemove，鼠标移动 1px 就 setArtPct；
  // 触摸板"轻敲"瞬间 / 用户没意识到按下时手稍微抖一下，都会被解释成"拖拽"，看起来像"鼠标掠过手柄就自动被点击"。
  // 改为 mousedown 后先 armed=false 待命，只有 mousemove 横向位移 ≥4px 才算真拖——cursor 才变 col-resize、setArtPct 才被调用。
  //
  // 2026-09-15 补 `setPointerCapture`（v3.2.0 条目 ⑤ 同源漏点，本处是最后一个）：分隔条只有 5px 宽，
  // **往右拖第一下指针就离开它、落进工件栏**；而工件栏正文是 `.html` 时走 `ArtHtmlView` →
  // `kbview://` iframe（独立文档、无 allow-same-origin）→ 父文档收不到 `mousemove`、更收不到 `mouseup`
  // → 手柄当场跟丢、`body.cursor` 永久卡在 `col-resize`（只能重启）。capture 后事件即使落在 iframe
  // 之上也仍派发给本元素（并继续冒泡到 window），这才是「往右拖」的正解。
  // ⚠️ 判据：右侧开 `.md` 页签时走 `MarkdownPreview`、渲染在**父文档 DOM** 里，所以从来不犯病——
  // 这也是「HTML 必犯病、md 完全正常」的原因，改动时必须保住这一半（`.md` 的对照组不许被弄坏）。
  const dividerEndRef = useRef<(() => void) | null>(null)
  const onDividerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const row = rowRef.current
    if (!row) return
    const rect = row.getBoundingClientRect()
    const startX = e.clientX
    let armed = false
    // capture 只为「送达保证」：指针进入工件 iframe 后事件不再断流（不支持时退回 window 监听）
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 退回 window 监听 */ }
    const onMove = (ev: PointerEvent): void => {
      if (!armed) {
        if (Math.abs(ev.clientX - startX) < 4) return
        armed = true
        setArtDragMask(true)
        document.body.style.cursor = 'col-resize'
      }
      setArtPct(Math.min(60, Math.max(24, (rect.right - ev.clientX) / rect.width * 100)))
    }
    const onUp = (): void => {
      dividerEndRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setArtDragMask(false)
      document.body.style.cursor = ''
    }
    dividerEndRef.current = onUp
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [setArtPct])
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
    convScrollTop.current = c.scrollTop
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
  const draftSig = streamDraft ? `${streamDraft.text.length}|${streamDraft.items.length}|${streamDraft.thinking?.length ?? 0}` : ''
  useEffect(() => {
    const c = scrollRef.current
    if (!c || !stickRef.current) return
    c.scrollTop = c.scrollHeight
  }, [messages, pending, draftSig])

  useEffect(() => {
    setActiveAnchor(0)
    // 条目 6 顺带①：切会话**必须真的归零**。旧代码只做 `if (t > 0)` 恢复、从不置 0，
    // 于是新会话沿用了上一个会话遗留的位置（与「从顶部看新会话」的注释不符）。
    convScrollTop.current = 0
    // 同时解除贴底：否则随后 messages 载入会被规则 2 一把拉到最底，与「新会话从顶部开始」矛盾。
    stickRef.current = false
    setJumpBottom(false)
  }, [activeId])
  // 题目视图会卸载对话容器（scrollTop 丢失）；Tab 保活切换会让 display:none 重置滚动位置。
  // 两处都要恢复 → 条目 6 顺带②：isActive 也必须进依赖（原来只监听 midView / activeId）。
  // 归零情形同样走这一条（t = 0 时无条件应用，旧代码的 `if (t > 0)` 正是顺带① 的成因）。
  useEffect(() => {
    if (midView !== 'chat') return
    const t = convScrollTop.current
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = t })
  }, [midView, activeId, isActive])

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

  /** P7：中栏顶部「对话 ⇄ 题目」分段切换器（3-9 按 §六 L399 形态） */
  const chipCls = (on: boolean) => `px-2 py-1 rounded-md text-[11.5px] transition-colors ${on ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`
  const midChips = (
    <div className="shrink-0 flex items-center gap-1 px-3 pt-2 select-none">
      <button onClick={() => setMidView('chat')} className={chipCls(midView === 'chat')}>💬 对话</button>
      <button onClick={() => setMidView('quiz')} className={chipCls(midView === 'quiz')}>📝 题目{quizItems.length > 0 ? `（${quizItems.length}）` : ''}</button>
      {lastQuizReport && (
        <button onClick={() => { void openArtFile(lastQuizReport.rel) }} title="工件栏阅读最近一次测验报告"
          className="ml-auto text-[10.5px] px-1.5 py-0.5 rounded-md text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors truncate max-w-[220px]">
          🧾 最近测验 {lastQuizReport.score} · 报告 →
        </button>
      )}
    </div>
  )

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
                      档位由 设置→AI教学 `aiTeachUsageDetail`（off/compact/detailed），窗口大小 `aiTeachCtxWindow` */}
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
                                <div className="text-[10.5px] text-[var(--text-muted)]">未设月度预算（设置 → AI 工具 可配置上限）</div>
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
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-primary)]">
      {/* P5（§3.2-6/页签即会话切换器）：顶栏 = 工作区 chip（返回选择页）+ 对话页签 + 新建任务 + 工具组 */}
      {activeWs ? (
      <>
      <div className="flex items-center gap-1 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 shrink-0 select-none">
        <button onClick={exitToPicker} title="返回工作区选择页"
          className="shrink-0 flex items-center gap-1 max-w-[150px] px-1.5 py-0.5 rounded-md text-[11.5px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          <Folder size={12} className="shrink-0 text-[var(--accent)]" />
          <span className="truncate">{wsActive?.name ?? '工作区'}</span>
          <ChevronDown size={11} className="shrink-0 opacity-60" />
        </button>
        {/* 新建任务入口：紧贴工作区 chip（2026-09-08 用户验收：加对话按钮应挂在工作区旁）。
            必须在 overflow-x-auto 滚动容器之外——容器会裁剪 absolute 下拉菜单
            （2026-09-08 用户验收实锤：菜单在容器内时被裁剪为不可见，表现为「新建对话点不到」） */}
        <div className="relative shrink-0">
          <button onClick={() => setShowNewMenu(v => !v)} title="新建任务"
            className="flex items-center px-1 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><Plus size={13} /></button>
          {/* z-40：须高于左栏 ResizablePanel 拖拽手柄（w-0.5 z-30，内贴在左栏右缘＝中栏左缘）。
              旧的 z-30 与手柄同级 → 菜单左缘骑在手柄上、分界线压在菜单之上（2026-09-09 用户报障） */}
          {showNewMenu && (
            <div className="absolute left-0 top-full mt-1 w-56 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl z-40 overflow-hidden">
              {TEMPLATES.map(t => (
                <button key={t.id} onClick={() => void newTask(t)}
                  className="w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors">
                  <span className="mt-0.5 text-[var(--accent)]">{t.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-[12px] text-[var(--text-primary)]">{t.label}</span>
                    <span className="block text-[10.5px] text-[var(--text-muted)]">{t.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto">
          {wsSessions.map(s => (
            <div key={s.id} onClick={() => { void openSession(s.id, s.title) }}
              title={s.id === activeId ? `当前对话：${activeTitle}` : s.title}
              className={`group shrink-0 flex items-center gap-1 px-2 h-[22px] rounded-md cursor-pointer text-[11.5px] transition-colors max-w-[160px] ${s.id === activeId ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] ring-1 ring-inset ring-[var(--accent)]/40' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>
              {renamingId === s.id ? (
                <input autoFocus onFocus={e => e.currentTarget.select()} value={renameDraft} maxLength={40} onChange={e => setRenameDraft(e.target.value)}
                  onBlur={() => void commitRename(s.id)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.id) } else if (e.key === 'Escape') { e.stopPropagation(); setRenamingId(null) } }}
                  onClick={e => e.stopPropagation()}
                  className="w-24 px-1 py-0 rounded border border-[var(--accent)] bg-[var(--input-bg)] text-[11px] text-[var(--text-primary)] outline-none" />
              ) : (
                <>
                  {/* v3.1.2 条目7：未开讲的会话带「准备中」点标（等价左栏徽标，页签即会话切换器）。
                      prepNavSeq 是重渲染触发器——nav 存 localStorage，开讲后需一次 bump 才能即时消标 */}
                  {(prepNavSeq >= 0 && readNav(s.id).prep?.started === false) && (
                    <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--warning)]" title="准备中：尚未发出首条消息" />
                  )}
                  <span className="truncate" title={s.title} onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(s.id); setRenameDraft(s.title) }}>{s.title}</span>
                  <button onClick={e => { e.stopPropagation(); void delSession(e, s.id, s.title) }} title="删除会话"
                    className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-red-400 transition-opacity shrink-0"><X size={10} /></button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="shrink-0 flex items-center gap-0.5">

          {/* P8（§3.14/3-35）+ UI 优化条目13.2（分层入口重构）：顶栏 chip 只开「本主题」层——
              全局画像唯一编辑入口在选择页画像卡片、工作区画像在各工作区卡片 hover「画像」 */}
          <button
            onClick={() => { if (activeId) void openProfile('session'); else showToast({ type: 'warning', message: '本主题画像随对话存放：先选择或新建一个对话' }) }}
            title="本主题画像（当前对话的 PROFILE.md · 对话内唯一编辑入口）。全局画像在「工作区选择页 → 学习者画像」卡片，工作区画像在各工作区卡片 hover「画像」；AI 每轮自动注入，冲突时以更细颗粒层为准"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
            <User size={12} />
            <span>画像</span>
            {profileSuggestion && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" title="AI 有画像更新建议待确认" />}
          </button>
          {/* 右栏展开入口：右栏不可见（收起或被工件栏自动收起）时顶栏显示，点击恢复素材库（参照外部产品：入口在顶栏） */}
          {!srcVisible && (
            <button onClick={openSources} title="展开右栏（素材库）"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
              <PanelRightOpen size={12} />
              <span>素材库</span>
              {srcEntries.length > 0 && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />}
            </button>
          )}
          {/* 会话要求（UI 优化条目8.1 方案 A：中型编辑弹层，规格对齐画像弹层；Ctrl+Enter 保存；阅读视图次级入口）。
              约束随会话存放（CONSTRAINTS.md 在会话夹内）——工作区没有任何会话时整个入口不渲染
              （2026-09-08 用户拍板：删除全部会话后也不出现，不只首次进入） */}
          {wsSessions.length > 0 && (
          <div className="relative shrink-0">
            <button
              onClick={() => { setInstrDraft(activeInstr); setInstrOpen(v => !v); if (activeId) void aiTeachReadConstraints(activeId).then(r => { const t = r?.ok && r.relPath ? (r.text ?? '').trim() : ''; setActiveInstr(t); setInstrDraft(t); if (r?.relPath) setInstrRel(r.relPath) }).catch(() => null) }}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] transition-colors ${activeInstr ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'} ${instrOpen ? 'bg-[var(--bg-hover)]' : ''}`}
              title="会话约束：写入本会话文件夹的 CONSTRAINTS.md，AI 每轮发送时重读（编辑器里可直接改）">
              <PenLine size={12} />
              <span>会话要求</span>
              {activeInstr && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />}
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
              顶栏就此收敛为 工作区 chip + 页签 + 画像 + 会话要求 + 禅模式 */}

          {/* P3b（§3.8-2/连锁）：顶栏「文档地图」退役——产物导航由逐条「整理成文档」+ P4 左栏资源管理器承接；
              顶栏恒为：会话要求 + Token 仪表 +（P5 工作区 chip）+ 禅模式 */}

          {/* 禅模式（唯一作用域 = 本模块）：一键窗口全屏 + 隐壳（标题栏/活动栏隐藏）；再点或 Esc 退出 */}
          {onZenLevelChange && (
            <button
              onClick={() => onZenLevelChange(zenLevel >= 1 ? 0 : 2)}
              title={zenLevel >= 1 ? '退出禅模式 (Esc)' : '禅模式 · 全屏沉浸'}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] transition-colors ${
                zenLevel >= 1
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Feather size={12} />
              {zenLevel >= 1 ? '退出禅' : '禅模式'}
            </button>
          )}
        </div>
      </div>

      <div ref={rowRef} className="relative flex flex-1 min-h-0">
        {/* 左栏（P4 §3.7 + UI 优化条目2/3）：ResizablePanel 可调宽持久化 + 折叠贴边条（悬停高亮，点/拖展开）；
            分区体 grid-rows 动画常挂载（滚动/展开状态自然保留），折叠态 visibility 兜底 */}
        <ResizablePanel side="left" storageKey="aiTeach.leftWidth" defaultWidth={248} minWidth={200} maxWidth={400}
          visible={leftOpen} onSnapClose={() => toggleSide('left')} onSnapOpen={() => toggleSide('left')}
          collapsedWidth={14}>
          {/* v3.1.2（开发负责人 2026-09-14）：会话列表区回归，与资源管理器「分区并列共存」——
              形态 A：会话（上，限高可折叠）+ 资源管理器（中，撑满剩余）+ 任务规划（下）。
              折叠任一分区，其余分区自动获得空间（原会话列表区曾因「页签即会话切换器」退役，本次恢复）。 */}
          <SectionHead open={!collapsedSec.sessions} title="会话" onToggle={() => toggleSec('sessions')}
            right={
              /* 菜单必须锚定在本按钮上（顶栏那个 ＋ 的菜单锚在顶栏里，左栏点它会「菜单出现在别处」），
                 故左栏自带一份 relative 容器 + 独立展开态 leftNewMenu */
              <span className="relative inline-flex">
                <button onClick={() => setLeftNewMenu(v => !v)} title="新建对话"
                  className="p-0.5 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><Plus size={12} /></button>
                {leftNewMenu && (
                  <div className="absolute right-0 top-full mt-1 w-52 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl z-40 overflow-hidden">
                    {TEMPLATES.map(t => (
                      <button key={t.id} onClick={() => { setLeftNewMenu(false); void newTask(t) }}
                        className="w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors">
                        <span className="mt-0.5 text-[var(--accent)]">{t.icon}</span>
                        <span className="min-w-0">
                          <span className="block text-[12px] text-[var(--text-primary)]">{t.label}</span>
                          <span className="block text-[10.5px] text-[var(--text-muted)]">{t.desc}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </span>
            } />
          <div className="grid shrink-0 transition-[grid-template-rows] duration-200 ease-out" style={{ gridTemplateRows: collapsedSec.sessions ? '0fr' : '1fr' }}>
            <div className={`overflow-hidden min-h-0 transition-opacity duration-150 ${collapsedSec.sessions ? 'invisible opacity-0' : 'opacity-100'}`}>
              <div className="max-h-[38vh] overflow-y-auto px-1.5 pb-1.5">
                {wsSessions.length === 0 && (
                  <div className="px-2 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">本工作区还没有对话，点右上 ＋ 新建。</div>
                )}
                {wsSessionTree.map(({ s, child }) => (
                  <div key={s.id} onClick={() => { void openSession(s.id, s.title) }}
                    title={s.id === activeId ? `当前对话：${activeTitle}` : s.title}
                    className={`group flex items-center gap-1.5 ${child ? 'ml-3.5 pl-1.5 border-l border-[var(--border-color)]' : ''} px-2 py-1.5 rounded-md cursor-pointer text-[12.5px] transition-colors ${s.id === activeId ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
                    {/* v3.1.2 条目11 P4：已升格支线的徽章 */}
                    {child && <span className="shrink-0 px-1 rounded text-[9.5px] text-[var(--accent)] bg-[var(--accent)]/10" title="由支线旁问升格而来">支线</span>}
                    {/* 未开讲的会话带「准备中」点标（读 nav.prep；prepNavSeq 触发重渲染） */}
                    {!child && (prepNavSeq >= 0 && readNav(s.id).prep?.started === false) && (
                      <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--warning)]" title="准备中：尚未发出首条消息" />
                    )}
                    {renamingId === s.id ? (
                      <input autoFocus onFocus={e => e.currentTarget.select()} value={renameDraft} maxLength={40}
                        onChange={e => setRenameDraft(e.target.value)}
                        onBlur={() => void commitRename(s.id)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.id) } else if (e.key === 'Escape') { e.stopPropagation(); setRenamingId(null) } }}
                        onClick={e => e.stopPropagation()}
                        className="flex-1 min-w-0 px-1 py-0 rounded border border-[var(--accent)] bg-[var(--input-bg)] text-[11.5px] text-[var(--text-primary)] outline-none" />
                    ) : (
                      <>
                        <span className="flex-1 min-w-0 truncate" onDoubleClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameDraft(s.title) }}>{s.title}</span>
                        <button onClick={e => { e.stopPropagation(); void delSession(e, s.id, s.title) }} title="删除会话"
                          className="shrink-0 opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-red-400 transition-opacity"><X size={10} /></button>
                      </>
                    )}
                  </div>
                ))}
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
                  syncSessionFiles({ sources: true, constraints: true })
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
          <div className="grid flex-1 min-h-0 transition-[grid-template-rows] duration-200 ease-out" style={{ gridTemplateRows: collapsedSec.explorer ? '0fr' : '1fr' }}>
            <div className={`overflow-hidden min-h-0 transition-opacity duration-150 ${collapsedSec.explorer ? 'invisible opacity-0' : 'opacity-100'}`}>
              <div className="h-full min-h-0 pb-1">
                <AiTeachFileTree
                  subRel={wsTreeSeg}
                  refreshSeq={treeRefreshSeq}
                  activeRel={(() => { const r = artTabs.find(t => t.id === artActive && !t.generating)?.rel ?? null; return r && r.startsWith(`${treeBase}/`) ? r.slice(treeBase.length + 1) : null })()}
                  onOpenMd={treeOpenArt}
                  onOpenHtml={treeOpenArt}
                  onOpenExternal={treeOpenExternal}
                />
              </div>
            </div>
          </div>

          <SectionHead open={!collapsedSec.plan} title="任务规划" onToggle={() => toggleSec('plan')}
            right={<span title={template.goal} className="cursor-help text-[var(--text-muted)] hover:text-[var(--text-secondary)]">ⓘ</span>} />
          <div className="grid shrink-0 transition-[grid-template-rows] duration-200 ease-out" style={{ gridTemplateRows: collapsedSec.plan ? '0fr' : '1fr' }}>
            <div className={`overflow-hidden min-h-0 transition-opacity duration-150 ${collapsedSec.plan ? 'invisible opacity-0' : 'opacity-100'}`}>
              <div className="p-2 border-t border-[var(--border-color)] overflow-y-auto max-h-[320px]">
                {/* UI 优化条目11（A+B）：活的任务规划——plan 协议驱动状态（无 plan 时回落模板播种），
                    数据徽标给真实读数（题目/素材/产物），点击步骤 = 跳步遥控；静态 goal 段落折叠为 ⓘ tooltip */}
                {(planState ?? template.steps.map(st => ({ step: st, status: 'todo' as const }))).map((st, i, arr) => {
                  const badge = planBadge(st.step)
                  return (
                    <button key={`${st.step}-${i}`} onClick={() => jumpPlanStep(i, st.step, st.status)}
                      title={st.status === 'current' ? `让 AI 讲解此步：「${st.step}」` : `跳到第 ${i + 1} 步：「${st.step}」`}
                      className="group w-full flex items-center gap-1.5 text-[11.5px] rounded-md px-1 py-0.5 -mx-1 hover:bg-[var(--bg-hover)] transition-colors text-left">
                      <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] shrink-0 ${
                        st.status === 'current' ? 'bg-[var(--accent)] text-white'
                          : st.status === 'done' ? 'bg-[var(--success)]/15 text-[var(--success)]'
                            : 'bg-[var(--bg-hover)] text-[var(--text-muted)]'}`}>
                        {st.status === 'done' ? '✓' : st.status === 'current' ? '●' : i + 1}
                      </span>
                      <span className={`min-w-0 flex-1 truncate ${
                        st.status === 'current' ? 'text-[var(--accent)] font-medium'
                          : st.status === 'done' ? 'text-[var(--text-muted)] line-through'
                            : 'text-[var(--text-secondary)]'}`}>
                        {st.step}
                        {st.status === 'current' && <span className="ml-1.5 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">讲解此步 →</span>}
                      </span>
                      {badge && <span className="shrink-0 px-1 rounded text-[9.5px] tabular-nums bg-[var(--bg-hover)] text-[var(--text-muted)]">{badge}</span>}
                      {st.status === 'current' && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" title={`第 ${i + 1} / ${arr.length} 步进行中`} />}
                    </button>
                  )
                })}
                {!planState && <div className="mt-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]">进度将随 AI 推进自动更新（plan 协议）</div>}
              </div>
            </div>
          </div>

          <div className="shrink-0 flex items-center border-t border-[var(--border-color)]">
            <button onClick={() => toggleSide('left')} title="折叠侧边栏"
              className="h-6 flex items-center gap-1 px-2 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
              <PanelLeftClose size={11} /> 折叠侧栏
            </button>
          </div>
        </ResizablePanel>

        {/* 中栏（工件栏方案 §1.2 定稿）：对话主区固定、永不替换；原 docView/reader 分支整体迁入右缘工件栏页签 */}
        <section className="flex-1 flex flex-col min-w-0 min-h-0">
          {midView === 'quiz' ? (
            /* P7（§3.2-7）：题目视图——题目 = 对话回答里的 ```quiz 围栏协议块（QuizParser 解析） */
            <div className="flex-1 flex flex-col min-h-0 relative">
              {midChips}
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="max-w-[820px] mx-auto w-full px-4 py-4 space-y-2">
                  {quizItems.length === 0 ? (
                    <div className="py-16 text-center">
                      <div className="text-[13px] text-[var(--text-secondary)]">本对话还没有题目</div>
                      <div className="mt-1 text-[11.5px] text-[var(--text-muted)]">让 AI 在「对话」里出题（按测验协议自动收录到这里），或快捷发起：</div>
                      <div className="mt-4 flex items-center justify-center gap-2">
                        {['根据最近的讲解内容出 5 道选择题', '围绕本会话主题出 3 道基础题'].map(t => (
                          <button key={t} onClick={() => sendQuick(t)}
                            className="px-2.5 py-1 rounded-lg border border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:border-[var(--accent)]/60 hover:text-[var(--text-primary)] transition-colors">{t}</button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2.5">
                        <button onClick={() => setQuizOpen(true)}
                          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12.5px] hover:opacity-90 transition-opacity">
                          <Presentation size={13} /> 开始答题（{quizItems.length} 题）
                        </button>
                        <span className="text-[10.5px] text-[var(--text-muted)]">自动判分、错题显示解析；交卷后成绩报告落会话文件夹</span>
                      </div>
                      {quizItems.map((q, i) => (
                        <div key={`${q.no}-${i}`} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
                          <div className="text-[12px] leading-relaxed text-[var(--text-primary)]">
                            <span className="text-[var(--text-muted)] mr-1.5 tabular-nums">{i + 1}.</span>
                            {q.question.split('\n')[0].slice(0, 140)}
                          </div>
                          <div className="mt-1 text-[10.5px] text-[var(--text-muted)]">选项 {q.options.map(o => o.key).join('/')}{q.points ? ` · ${q.points}` : ''} · 来自对话消息</div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
              {quizOpen && activeId && quizItems.length > 0 && (
                <QuizMode
                  quizzes={quizItems}
                  pageTitle={activeTitle || '随堂测验'}
                  pageId={`aiTeach:${activeId}`}
                  onClose={() => setQuizOpen(false)}
                  onFinish={handleQuizFinish}
                />
              )}
            </div>
          ) : (
            <>
              {midChips}
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
                  !prepStarted && prepTemplate ? (
                    /* v3.1.2 条目7：准备态引导区（中栏）——场景说明 + 本工作区素材迷你清单 */
                    <div className="h-full flex flex-col items-center justify-center gap-3 kb-view-in">
                      <div className="text-[26px] leading-none">{prepTemplate.icon}</div>
                      <div className="text-[15px] font-medium text-[var(--text-primary)]">先备好，再开讲</div>
                      <div className="text-[12px] text-[var(--text-muted)] text-center leading-[1.7]">
                        当前场景：<b className="font-medium text-[var(--text-secondary)]">{prepTemplate.label}</b><br />
                        素材、会话要求、首条消息都可以在下方先安排好。<br />
                        点「开始对话」才正式发送首条消息——在此之前不会产生任何 AI 调用。
                      </div>
                      {srcEntries.length > 0 && (
                        <div className="w-full max-w-[420px] mt-2">
                          <div className="flex items-center gap-2 mb-1.5 text-[11px] text-[var(--text-muted)]">
                            <span className="font-medium text-[var(--text-secondary)]">本工作区素材</span>
                            <span className="flex-1 h-px bg-[var(--border-color)]" />
                            <span>{srcEntries.length} 项</span>
                          </div>
                          {srcEntries.slice(0, 4).map(e => (
                            <div key={e.no} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--bg-secondary)] text-[11.5px] mb-1">
                              <span className="text-[10px] text-[var(--text-muted)] w-5 shrink-0">#{e.no}</span>
                              <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">{e.name}</span>
                              <span className="shrink-0 text-[9.5px] text-[var(--text-muted)] uppercase">{e.type}</span>
                            </div>
                          ))}
                          {srcEntries.length > 4 && (
                            <div className="text-[10.5px] text-[var(--text-muted)] pt-0.5">等共 {srcEntries.length} 项，可在下方「素材」条查看全部</div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center text-[12px] text-[var(--text-muted)]">开始对话</div>
                  )
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
                        {/* P8：```profile 建议块不直显；条目11/12：```plan / ```ask 协议块同样收敛（plan→侧栏、ask→提问卡） */}
                        <MarkdownPreview
                          content={m.content.replace(/```(profile|plan|ask)[^\n]*\n[\s\S]*?```/g, '')}
                          onQuizRetry={retryQuiz}
                        />
                        {/* 工件栏方案 §2：visual.html 工件卡（对话流唯一形态，HTML 正文永不进流）——数据源=trace 里的 artifact step */}
                        {(m.trace ?? []).some(s => s.artifact) && (
                          <div className="mt-1.5 space-y-1">
                            {(m.trace ?? []).filter(s => s.artifact).map((s, k) => {
                              const a = s.artifact as NonNullable<typeof s.artifact>
                              return (
                                <button key={k} onClick={() => { void openArtFile(a.rel, { title: a.title, lines: a.lines }) }} title={a.rel}
                                  className="w-full max-w-[440px] flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]/50 transition-colors text-left">
                                  <ImageIcon size={13} className="shrink-0 text-[var(--accent)]" />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[12px] text-[var(--text-primary)]">{a.title || a.rel.split('/').pop()}</span>
                                    <span className="block truncate text-[10px] text-[var(--text-muted)]">{a.rel} · {a.lines} 行 · 单文件自包含</span>
                                  </span>
                                  <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">在工件栏打开 →</span>
                                </button>
                              )
                            })}
                          </div>
                        )}
                        {/* UI 优化条目4：操作条升格为轻 chip 条（11.5px+图标，对齐顶栏 chip 规范）；时间戳坏数据不渲染 */}
                        <div className="text-[11.5px] mt-1.5 flex items-center gap-1.5 -ml-1.5">
                          {/* v3.1.2 条目11：支线旁问入口（与整理成文档/复制/轨迹同簇）。
                              已开过支线的回答 → 按钮变「支线追问 · 已开」并高亮，点击**重开原支线**：
                              锚点回答自己就是入口，关掉浮窗也不失联（映射落 localStorage，重启仍在）。 */}
                          {(() => {
                            const al = m.id ? anchorLanes[m.id] : undefined
                            return (
                              <button onClick={() => { setSideLaneWide(false); setSideLane({ parentSessionId: activeId ?? '', anchorMessageId: m.id ?? '', parentTitle: activeTitle, openLaneId: al?.laneId }) }}
                                title={al ? '这条回答已开过支线，点击重新打开' : '就这条回答的某一点开独立深挖线，不打断主线节奏'}
                                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors ${al ? 'text-[var(--accent)] hover:bg-[var(--bg-hover)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
                                <GitBranch size={12} />{al ? '支线追问 · 已开' : '就这点追问'}
                              </button>
                            )
                          })()}
                          <button onClick={() => { void organizeDocFor(m.content, idx, m.id) }}
                            className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors ${organized[m.id ?? `idx${idx}`] ? 'text-[var(--accent)] ring-1 ring-inset ring-[var(--accent)]/40' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
                            <FileOutput size={12} />{organized[m.id ?? `idx${idx}`] ? '✓ 已生成文档 →' : '整理成文档'}
                          </button>
                          <button onClick={() => { void navigator.clipboard.writeText(m.content).then(() => showToast({ type: 'info', message: '已复制本条回答' })).catch(() => null) }}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                            <Copy size={12} />复制
                          </button>
                          {fmtTime(m.createdAt) && <span className="text-[11px] text-[var(--text-muted)] tabular-nums ml-0.5">{fmtTime(m.createdAt)}</span>}
                          {m.trace && m.trace.length > 0 && (
                            <details className="cursor-pointer select-none">
                              <summary className="px-1.5 py-0.5 rounded-md list-none text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] transition-colors">调用轨迹（{m.trace.length} 步）</summary>
                              <ul className="mt-1 space-y-0.5">
                                {m.trace.map((st, j) => (
                                  <li key={j} className="flex items-center gap-1 text-[10.5px]">
                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.ok ? 'bg-[var(--success)]' : 'bg-red-500'}`} />
                                    <Wrench size={9} className="shrink-0 text-[var(--text-muted)]" />
                                    <span className="truncate">{st.kind === 'tool' ? toolName(st.name) : '思考'}</span>
                                    <span className="ml-auto tabular-nums text-[var(--text-muted)]">{st.durationMs}ms{st.tokens ? ` · ${st.tokens}t` : ''}</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
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
                  <div className="flex justify-start">
                    <div className="w-full max-w-[92%]">
                      <StreamBubble draft={streamDraft} textTransform={stripOpenFence} />
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-start">
                    <div className="max-w-[86%] rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] px-3.5 py-2.5 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
                      <Loader2 size={13} className="animate-spin shrink-0" />
                      <span className="min-w-0">
                        {!lastStep ? '正在思考…'
                          : lastStep.kind === 'tool'
                            ? (lastStep.ok
                              ? <>正在调用 <span className="text-[var(--accent)]">{toolName(lastStep.name)}</span>（第 {toolCount} 次工具调用）</>
                              : <>执行 {toolName(lastStep.name)} 失败，正在调整…</>)
                            : <>思考中…（已调用 {toolCount} 次工具）</>}
                      </span>
                    </div>
                  </div>
                ))}
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

              {profileSuggestion && !profDismissed && (
                /* P8（3-33 Plan B）：AI 画像更新建议——接受才写文件，下轮注入生效
                   UI 优化条目8.2.2：写入目标升三层（本主题 / 工作区 / 全局），细颗粒优先 */
                <div className="shrink-0 mx-2 mb-1.5 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/8 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <User size={12} className="shrink-0 text-[var(--accent)]" />
                    <span className="text-[12px] text-[var(--text-primary)]">AI 提议更新学习者画像（{profileSuggestion.text.length} 字）</span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-[var(--text-muted)]">选择写入层级</span>
                    <button onClick={() => { void acceptProfileSuggestion('session') }} title="写入当前会话文件夹 PROFILE.md（最细颗粒，覆盖上两层）"
                      className="shrink-0 px-2 py-0.5 rounded-md bg-[var(--accent)] text-white text-[11px] hover:opacity-90 transition-opacity">接受（本主题）</button>
                    {wsActive && (
                      <button onClick={() => { void acceptProfileSuggestion('workspace') }} title={`写入工作区「${wsActive.name}」画像（${aiTeachRoot}/${wsTreeSeg}/PROFILE.md，覆盖全局）`}
                        className="shrink-0 px-2 py-0.5 rounded-md border border-[var(--accent)]/50 text-[var(--accent)] text-[11px] hover:bg-[var(--accent)]/10 transition-colors">接受（工作区）</button>
                    )}
                    <button onClick={() => { void acceptProfileSuggestion('global') }} title="写入全局画像（userData，跨工作区/跨仓库共享）"
                      className="shrink-0 px-2 py-0.5 rounded-md border border-[var(--accent)]/50 text-[var(--accent)] text-[11px] hover:bg-[var(--accent)]/10 transition-colors">接受（全局）</button>
                    {/* 条目7 根因1：这两个按钮原先**没有任何按钮样式**（无底无描边 + `--text-muted`），
                        而同一排的「接受」三兄弟是实底/描边 → 用户读到的就是「前三个是按钮、后两个是灰字 = 像禁用」。
                        现改为与「接受（工作区/全局）」同源的次级描边样式（保留小尺寸、不抢主操作权重）；
                        「忽略」再暗一档（次要中的次要），但有描边 + 真 hover → 不再像禁用。 */}
                    <button type="button" onClick={() => setProfDismissed(true)} title="忽略（不写入；下条回答会重新提议）"
                      className="shrink-0 px-1.5 py-0.5 rounded-md border border-[var(--border-color)] text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] transition-colors">忽略</button>
                    {/* 条目7 根因2：由 scrollIntoView 改为就地展开；`建议内容全文` 这行文案收进 title（铁律 12：只收不删） */}
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
                </div>
              )}
              <div className="shrink-0 w-full max-w-[820px] mx-auto px-3 pb-2.5 pt-2">
                {/* v3.1.2 条目7：会话准备态 —— 未开讲时输入区位置显示准备面板（素材 / 会话要求 / 首条消息）
                    与正常输入框同一块区域互斥切换；点「开始对话」才发首条消息。 */}
                {!prepStarted && prepTemplate ? (
                  <div className="kb-view-in">
                    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] overflow-hidden">
                      {/* ① 素材条（折叠）：摘要 + 展开清单 + 既有登记入口 */}
                      <div onClick={() => onPrepFold('src')}
                        className="flex items-center gap-2 px-2.5 py-2 border-b border-[var(--border-color)] cursor-pointer select-none hover:bg-[var(--bg-hover)] transition-colors">
                        <Paperclip size={12} className="shrink-0 text-[var(--text-secondary)]" />
                        <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">素材</span>
                        <span className="flex-1 min-w-0 truncate text-[11.5px] text-[var(--text-muted)]">
                          {srcEntries.length > 0 ? `已登记 ${srcEntries.length} 项 · ${srcEntries[0].name} 等` : '尚未添加素材'}
                        </span>
                        {srcEntries.length > 0 && <span className="shrink-0 text-[11px] text-[var(--success)]">✓</span>}
                        <ChevronRight size={10} className={`shrink-0 text-[var(--text-muted)] kb-chevron ${prepSrcOpen ? 'rotate-90' : ''}`} />
                      </div>
                      <div className="grid transition-[grid-template-rows] duration-200" style={{ gridTemplateRows: prepSrcOpen ? '1fr' : '0fr' }}>
                        <div className="overflow-hidden">
                          <div className="p-2.5">
                            {srcEntries.length > 0 ? srcEntries.slice(0, 8).map(e => (
                              <div key={e.no} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[var(--bg-secondary)] text-[11.5px] mb-1">
                                <span className="text-[10px] text-[var(--text-muted)] w-5 shrink-0">#{e.no}</span>
                                <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">{e.name}</span>
                                <span className="shrink-0 text-[9.5px] text-[var(--text-muted)] uppercase">{e.type}</span>
                              </div>
                            )) : <div className="text-[11.5px] text-[var(--text-muted)] px-1 py-0.5">还没有素材，可在下方添加。</div>}
                            <button onClick={() => setSrcForm({ name: '', type: 'pdf', path: '', storage: '已入库', rangeFrom: '', rangeTo: '', note: '' })}
                              className="mt-1.5 w-full px-2 py-1.5 rounded-md border border-dashed border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors">
                              ＋ 添加素材（登记进工作区 SOURCES/SOURCE.md）
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* ② 会话要求条（折叠）：场景流程已播种，可展开预览 / 走既有弹层编辑 */}
                      <div onClick={() => onPrepFold('req')}
                        className="flex items-center gap-2 px-2.5 py-2 border-b border-[var(--border-color)] cursor-pointer select-none hover:bg-[var(--bg-hover)] transition-colors">
                        <ClipboardList size={12} className="shrink-0 text-[var(--text-secondary)]" />
                        <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">会话要求</span>
                        <span className="flex-1 min-w-0 truncate text-[11.5px] text-[var(--text-muted)]">
                          {activeInstr ? `场景流程已自动播种 · ${activeInstr.split('\n').length} 行` : '暂无要求'}
                        </span>
                        {activeInstr && <span className="shrink-0 text-[11px] text-[var(--success)]">✓</span>}
                        <ChevronRight size={10} className={`shrink-0 text-[var(--text-muted)] kb-chevron ${prepReqOpen ? 'rotate-90' : ''}`} />
                      </div>
                      <div className="grid transition-[grid-template-rows] duration-200" style={{ gridTemplateRows: prepReqOpen ? '1fr' : '0fr' }}>
                        <div className="overflow-hidden">
                          <div className="p-2.5">
                            <div className="rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] px-2.5 py-2 max-h-[110px] overflow-y-auto">
                              <pre className="whitespace-pre-wrap text-[11px] leading-[1.65] text-[var(--text-secondary)] font-[var(--font-mono,var(--font-family))]">{activeInstr || '（本会话没有额外要求）'}</pre>
                            </div>
                            <button onClick={() => { setInstrOpen(true); setInstrDraft(activeInstr) }}
                              className="mt-1.5 w-full px-2 py-1.5 rounded-md border border-dashed border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors">
                              编辑会话要求（CONSTRAINTS.md）
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* ③ 首条消息（主体）：场景模板预填、可自由编辑。
                          v3.2.0 条目6 顺带③：rows 固定 3 行 + 框内滚动。原为 `Math.min(6, Math.max(3, 行数))`——
                          每按一次 Enter 输入区就 ±1 行，而消息区是 flex-1 min-h-0，高度随之变化 → 对话内容上下跳。
                          高度由 rows 定死后，超出部分天然框内滚动（textarea 默认 overflow:auto），零额外样式。 */}
                      <textarea ref={inputRef} spellCheck={false} value={input}
                        onChange={e => onPrepDraftChange(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); startPreparedChat() } }}
                        rows={3}
                        placeholder={prepTemplate.startPrompt}
                        className="w-full px-2.5 py-2 bg-transparent text-[12.5px] leading-[1.7] resize-none outline-none text-[var(--text-primary)]" />
                      <div className="flex items-center gap-2 px-2.5 pb-2.5">
                        <span className="flex-1 min-w-0 truncate text-[11px] text-[var(--text-muted)]">首条消息已按场景模板预填，可自由编辑</span>
                        <button onClick={startPreparedChat} disabled={!input.trim() || pending || compressing}
                          className="shrink-0 px-4 py-1.5 rounded-md bg-[var(--accent)] text-white text-[12.5px] font-medium hover:opacity-90 disabled:opacity-40 transition-all kb-micro-pop">
                          开始对话
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 px-0.5 text-[10.5px] text-[var(--text-muted)]">
                      <span>准备态 · 未产生 AI 调用</span>
                      <span className="ml-auto">切走再切回会还原到这里</span>
                    </div>
                  </div>
                ) : askVisible && askPending ? (
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
                  const allPicked = !exam || pickedCount >= n
                  const customMode = askCustomOpen || (exam && pickedCur !== undefined && !curOpts.includes(pickedCur))
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
                          const picked = exam ? pickedCur === o : false
                          return (
                            <button key={o} disabled={pending}
                              onClick={() => (exam ? setAskPicks(p => ({ ...p, [page]: o })) : sendAskAnswer(o))}
                              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left text-[12.5px] transition-colors disabled:opacity-40 ${
                                picked ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'border-transparent hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'}`}>
                              <span className={`w-5 h-5 rounded-full border flex items-center justify-center text-[10px] shrink-0 ${picked ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}>{oi + 1}</span>
                              <span className="flex-1 min-w-0">{o}</span>
                              {picked && <ArrowRight size={13} className="text-[var(--accent)] shrink-0" />}
                            </button>
                          )
                        })}
                        {/* 其他补充：自定义回答（单题 Enter/↑ 即发；整卷 Enter 记为当前题答案） */}
                        {customMode ? (
                          <div className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-color)]">
                            <PenLine size={12} className="text-[var(--text-muted)] shrink-0" />
                            <input autoFocus value={askCustom} onChange={e => setAskCustom(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter' && askCustom.trim()) { const v = askCustom.trim(); setAskCustom(''); setAskCustomOpen(false); exam ? setAskPicks(p => ({ ...p, [page]: v })) : sendAskAnswer(v) } }}
                              placeholder="补充你的回答…（Enter 确认）"
                              className="flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none" />
                            <span className="text-[10px] text-[var(--text-muted)] shrink-0">Enter 确认</span>
                          </div>
                        ) : (
                          <button onClick={() => { setAskCustomOpen(true); setAskCustom(exam && pickedCur && !curOpts.includes(pickedCur) ? pickedCur : '') }}
                            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[12.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors">
                            <PenLine size={13} className="shrink-0" /> 其他补充…
                          </button>
                        )}
                      </div>
                      {/* 底部：进度 + 圆形 ↑ 发送 */}
                      <div className="mt-1.5 flex items-center">
                        {exam && <span className="text-[10.5px] text-[var(--text-muted)] mr-auto tabular-nums">已答 {pickedCount}/{n}{allPicked ? ' · 可提交' : ' · ‹›翻页作答'}</span>}
                        <button
                          onClick={() => { if (exam) submitAskExam(); else if (askCustom.trim()) { const v = askCustom.trim(); setAskCustom(''); setAskCustomOpen(false); sendAskAnswer(v) } }}
                          disabled={pending || (exam ? !allPicked : !(askCustomOpen && askCustom.trim()))}
                          title={exam ? `统一发送全部回答（${pickedCount}/${n}）` : '发送补充回答'}
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
                  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg px-3 pt-2.5 pb-2 focus-within:border-[var(--accent)]/60">
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
                    <div className="relative">
                      {slashOpen && (
                        <SlashCommandMenu items={slashItems} activeIndex={slashActive} onHover={setSlashActive} onPick={pickSlash} />
                      )}
                      <textarea ref={inputRef} spellCheck={false} value={input} onChange={e => { setInput(e.target.value); setSlashActive(0) }}
                        onKeyDown={e => { onSlashKeys(e); if (!e.defaultPrevented && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend() } }}
                        rows={2} placeholder={quotes.length > 0 ? '针对引用内容提问…（Enter 发送）' : '粘贴资料或输入指令…（Enter 发送，/ 唤起指令）'}
                        className="w-full px-0.5 py-1 rounded-none border-0 bg-transparent text-[13px] resize-none outline-none" />
                    </div>
                    {composerFooter}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        {/* v3.1.2 条目11：支线旁问 宽轨形态（贴右栏）——作为中栏的**兄弟节点**插入（不覆盖对话区，并列占宽），
            这才是「中栏不遮挡」；宽度可拖并持久化（复用 ResizablePanel）。 */}
        {sideLane && sideLaneWide && (
          <ResizablePanel side="right" storageKey="aiTeach.sideLaneWidth" defaultWidth={440} minWidth={320} maxWidth={720}
            visible className="border-l border-[var(--border-color)] kb-view-in">
            <SideLanePanel
              key={sideLane.openLaneId ?? sideLane.anchorMessageId}
              parentSessionId={sideLane.parentSessionId}
              parentTitle={sideLane.parentTitle}
              anchorMessageId={sideLane.anchorMessageId}
              openLaneId={sideLane.openLaneId}
              wide
              onClose={() => setSideLane(null)}
              onToggleWide={() => toggleSideLaneWide(false)}
              onLaneReady={(lid, ltitle) => noteLaneReady(sideLane.anchorMessageId, lid, ltitle)}
              onPromote={promoteLane}
            />
          </ResizablePanel>
        )}

        {/* 工件栏（docs/ai-teaching-artifacts-pane-design.md §1.2）：分隔条可拖 24%~60%、双击复位 46、宽度持久化。
            无打开页签即不渲染——工件栏没有主动展开把手（2026-09-09 用户拍板：右缘把手与素材库拉出条冲突），
            打开任意文件/工件卡自动出现，关掉全部页签自动消失 */}
        {/* 分隔条（2026-09-09 修抖动）：5px 热区 + 视觉线**居中**、hover 只加粗变色不改位置。
            老版 `left-2 w-px group-hover:left-1 group-hover:w-[3px]` 让视觉线静止时落在热区**外面**（8~9px，热区仅 0~5px），
            hover 又跳到 4~7px——鼠标在热区边缘微动会让 :hover 反复进出，视觉线带 transition-all 来回位移 4px，
            看着就是"手柄被来回小范围拖拽抖动"。现在 left-1/2 -translate-x-1/2 固定居中，只剩宽度/颜色过渡。 */}
        {artExpanded && !artZoom && (
          <div onPointerDown={onDividerDown}
            onLostPointerCapture={() => dividerEndRef.current?.()}
            onDoubleClick={() => setArtPct(46)} title="拖拽调宽（24%~60%）· 双击复位"
            className="group shrink-0 w-[5px] cursor-col-resize relative z-[5]">
            <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-px group-hover:w-[3px] bg-[var(--border-color)] group-hover:bg-[var(--accent)] transition-[width,background-color] duration-150" />
          </div>
        )}
        {/* 拖拽期遮罩（见 artDragMask 注释）：把指针物理上留在父文档内——工件栏正文是 `.html` 时
            挂的是 `kbview://` 独立文档的 iframe，一旦指针落进去，父文档就收不到 move/up。
            必须由收尾路径摘除（`onUp` / `lostpointercapture`），不能只认 up。 */}
        {artDragMask && <div className="fixed inset-0 z-[60] cursor-col-resize" />}
        {artExpanded && (
          <div className={artZoom ? 'absolute inset-0 z-40 min-h-0' : 'shrink-0 min-h-0'} style={artZoom ? undefined : { width: `${artPctEff}%`, minWidth: 300 }}>
            <ArtifactsPane
              tabs={artTabs}
              activeId={artActive}
              widthPx={artZoom ? rowW : (rowW > 0 ? Math.floor(rowW * artPctEff / 100) : 480)}
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
            />
          </div>
        )}

        {/* 右栏（UI 优化条目2/5）：ResizablePanel 可调宽持久化；「素材库/资料来源」双区块合并为素材库单一区块。
            收起 = 面板彻底归零（v3.2.0 条目 ⑤ 清死配置：原来同时传 collapsedWidth=0 与 onSnapOpen，
            而 onSnapOpen 只在「留出贴边条」时才有意义——0 宽的贴边条既看不见也点不到，是纯死配置；
            展开入口在顶栏工具组，不需要贴边条） */}
        <ResizablePanel side="right" storageKey="aiTeach.rightWidth" defaultWidth={280} minWidth={240} maxWidth={420}
          visible={srcVisible} onSnapClose={() => toggleSide('right')}>
          <div className="h-full min-h-0 flex flex-col">
          <div className="shrink-0">
            <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
              <span title="素材库 = 工作区主库 SOURCES/SOURCE.md（跨对话共用）+ 本对话历史登记（存量，标记「对话」）">素材库{srcEntries.length > 0 ? `（${srcEntries.length}）` : ''}</span>
              <div className="ml-auto flex items-center gap-1">
                {srcSessionRel && activeId && (
                  <button onClick={() => { void doPromoteSources() }} title="把本对话历史登记的素材（含原件与提取稿）并入工作区主库，之后所有对话共用"
                    className="px-1 py-0.5 rounded-md text-[var(--warning)] hover:bg-[var(--bg-hover)] transition-colors">上收</button>
                )}
                {srcEntries.length > 0 && (
                  <button onClick={() => setSrcCompact(!srcCompact)} title={srcCompact ? '展开卡片：恢复每条两行完整信息' : '收起卡片：全部压成单行细条（再点展开）'}
                    className={`px-1 py-0.5 rounded-md transition-colors ${srcCompact ? 'text-[var(--accent)] bg-[var(--accent)]/10 font-medium' : 'hover:bg-[var(--bg-hover)]'}`}>{srcCompact ? '展开卡片' : '收起卡片'}</button>
                )}
                {srcFileRel && (
                  <button onClick={() => { void openArtFile(srcFileRel) }} title="工件栏阅读 SOURCE.md"
                    className="px-1 py-0.5 rounded-md hover:bg-[var(--bg-hover)] transition-colors">SOURCE</button>
                )}
                {/* v3.1.1 登记入口进工作区主库：未选/未建会话也能登记（主库脱离对话常驻）——
                    解开「导素材要先建对话」的冷启动死结（更新计划第 5 项痛点） */}
                <button onClick={() => {
                    setSrcForm({ name: '', type: 'pdf', path: '', storage: '已入库', rangeFrom: '', rangeTo: '', note: '' })
                  }}
                  title="添加素材（写入工作区主库 SOURCE.md）"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                  <Plus size={11} /> 素材
                </button>
              </div>
            </div>
          </div>
          {/* 过滤 chips（方案 B）：单选、横向可滚、零数量组隐藏；只影响列表渲染，不动 SOURCE.md 与 AI 注入 */}
          {srcEntries.length > 0 && (
            <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border-color)] overflow-x-auto [scrollbar-width:none]">
              {[{ key: 'all', label: '全部' }, ...SRC_GROUPS].map(g => {
                const n = g.key === 'all' ? srcEntries.length : srcEntries.filter(e => srcGroupKey(e.type) === g.key).length
                if (g.key !== 'all' && n === 0) return null
                return (
                  <button key={g.key} onClick={() => setSrcFilter(g.key)}
                    className={`shrink-0 px-2 py-px rounded-full border text-[10.5px] whitespace-nowrap transition-colors duration-[180ms] ${srcFilter === g.key ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent)]/50'}`}>
                    {g.label} {n}
                  </button>
                )
              })}
            </div>
          )}
          {/* 素材列表内部滚动（方案 A，修「一锅滚」）：改动/进度钉底后，此处独立滚动 */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {/* 条目5.3：手编 / AI 直写 SOURCE.md 的形状异常提示（不静默丢失，指回文件改正） */}
            {srcAnom && (srcAnom.unnamed > 0 || srcAnom.dupNo > 0 || (srcAnom.noPath ?? 0) > 0) && (
              <button onClick={() => { if (srcFileRel) void openArtFile(srcFileRel) }}
                className="w-full flex items-start gap-1.5 px-2 py-1.5 border-b border-[var(--border-color)] bg-[var(--warning-bg)]/40 text-left text-[10.5px] text-[var(--warning)] hover:opacity-80 transition-opacity"
                title={`小节标题需为「### 编号. 名称」，字段行「- 字段: 值」。「路径」是登记必要信息，缺路径的小节不会出现在素材库。点击打开 SOURCE.md 修正。`}>
                <span className="shrink-0">⚠</span>
                <span className="min-w-0">
                  {srcAnom.unnamed > 0 && <span>{srcAnom.unnamed} 个小节缺「编号.」未登记</span>}
                  {srcAnom.unnamed > 0 && (srcAnom.dupNo > 0 || (srcAnom.noPath ?? 0) > 0) && <span> · </span>}
                  {srcAnom.dupNo > 0 && <span>{srcAnom.dupNo} 处编号重复被忽略</span>}
                  {srcAnom.dupNo > 0 && (srcAnom.noPath ?? 0) > 0 && <span> · </span>}
                  {(srcAnom.noPath ?? 0) > 0 && <span>{srcAnom.noPath} 个小节缺「路径」未登记</span>}
                  <span className="text-[var(--text-muted)]">（点开 SOURCE.md 修正）</span>
                </span>
              </button>
            )}
            {srcEntries.length > 0 ? (
              <div className="p-2 pt-1.5">
                {(() => {
                  const groups = SRC_GROUPS
                    .map(g => ({ g, items: srcEntries.filter(e => srcGroupKey(e.type) === g.key && (srcFilter === 'all' || srcFilter === g.key)) }))
                    .filter(x => x.items.length > 0)
                  if (groups.length === 0) return <div className="px-3 py-4 text-center text-[11px] text-[var(--text-muted)]">该类型下暂无素材</div>
                  return groups.map(({ g, items }) => {
                    const closed = srcFilter === 'all' && groupClosed.has(g.key)
                    return (
                      <div key={g.key} className="mb-1.5">
                        {/* 组头：箭头(260ms 旋转) + 色点 + 名称 + 计数徽标；点击 1fr↔0fr 折叠（360ms 定稿曲线） */}
                        <button onClick={() => toggleSrcGroup(g.key)} className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[11px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors select-none">
                          <ChevronDown size={11} className={`shrink-0 text-[var(--text-muted)] kb-group-anim transition-transform duration-[260ms] ${SRC_EASE} ${closed ? '-rotate-90' : ''}`} />
                          <span className="w-1.5 h-1.5 rounded-[2px] shrink-0" style={{ background: g.color }} />
                          <span>{g.label}</span>
                          <span className="ml-auto text-[9.5px] font-normal text-[var(--text-muted)] border border-[var(--border-color)] rounded-full px-1.5 leading-[15px]">{items.length}</span>
                        </button>
                        <div className={`grid kb-group-anim transition-[grid-template-rows] duration-[360ms] ${SRC_EASE} ${closed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}>
                          <div className={`min-h-0 overflow-hidden kb-group-anim transition-[opacity,transform] duration-[300ms] ${SRC_EASE} ${closed ? 'opacity-0 translate-x-1.5' : 'opacity-100 translate-x-0'}`}>
                            <div className="pt-1 space-y-1">{items.map(renderSrcCard)}</div>
                          </div>
                        </div>
                      </div>
                    )
                  })
                })()}
              </div>
            ) : (
              <div className="px-3 py-4 text-center text-[11px] text-[var(--text-muted)] leading-relaxed">
                {activeId ? '本对话还没登记素材。\n点右上「＋ 素材」登记，或在对话里让 AI 按 SOURCE.md 模板登记。' : '先选择一个对话。'}
              </div>
            )}
          </div>
          {/* 钉底区（方案 D）：转写进度卡上移至此 + 本次改动，素材再多也永不被列表推走 */}
          <div className="shrink-0">
          {/* 转写进度卡片：钉底区顶部（右栏改造方案 D——原「列表尾部空白区」会被素材增长推走，现固定可见） */}
          {visionBusy && (
            <div className="shrink-0 mx-2 mt-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-3 py-2.5">
              <div className="flex items-center gap-2 mb-2">
                <Loader2 size={12} className="animate-spin text-[var(--accent)] shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-primary)]">视觉转写 · {visionBusy.label}</span>
                <button onClick={() => { transcribeStopRef.current = true }} title="停止转写（已完成页保留，重发同区间自动续转）"
                  className="shrink-0 text-[10.5px] px-2 py-0.5 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-red-400 hover:border-red-400/50 transition-colors">停止</button>
              </div>
              <div className="h-2 rounded-full bg-[var(--bg-primary)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[var(--accent)] to-[var(--accent)]/50 transition-all duration-500 animate-pulse"
                  style={{ width: `${visionBusy.total ? Math.max(4, Math.min(100, Math.round((visionBusy.done ?? 0) / visionBusy.total * 100))) : 10}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                <span>已转写 {visionBusy.done ?? 0} / {visionBusy.total ?? '…'} 页</span>
                <span>{visionBusy.total ? Math.min(100, Math.round((visionBusy.done ?? 0) / visionBusy.total * 100)) : 0}%</span>
              </div>
            </div>
          )}
          {/* 条目5.1：旧「资料来源」区块退役（PPT 逐页阅读时代遗留）——pptx 原件阅读走素材库条目「原件」按钮（同一 openPptxReader） */}
          {/* 条目5.4：静态「产物」占位区块移除——产物清单由左栏资源管理器承接（真数据同源） */}
          <div className="shrink-0 pb-2">
            <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">本次改动{lastChanges ? `（${lastChanges.length}）` : ''}</div>
            {lastChanges && lastChanges.length > 0 ? (
              <div className="p-2">
                <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] overflow-hidden">
                  <ul className="py-1 max-h-40 overflow-y-auto">
                    {lastChanges.map((c, i) => (
                      <li key={i}>
                        {c.file ? (
                          <button onClick={() => (c.tool === 'visual.html' ? void openArtFile(String(c.file), { title: c.target }) : window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: c.file, from: 'aiTeaching' } })))}
                            title={c.tool === 'visual.html' ? '在工件栏打开渲染预览' : '在编辑器中打开'}
                            className="w-full flex items-center gap-1.5 px-2.5 py-1 text-left text-[11.5px] group hover:bg-[var(--bg-hover)] transition-colors">
                            <FileText size={10} className="shrink-0 text-[var(--accent)]" />
                            <span className="shrink-0 text-[var(--accent)]">{c.action}</span>
                            <span className="truncate text-[var(--text-primary)]">{c.target}</span>
                          </button>
                        ) : (
                          <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11.5px]">
                            <FileText size={10} className="shrink-0 text-[var(--text-muted)]" />
                            <span className="shrink-0 text-[var(--accent)]">{c.action}</span>
                            <span className="truncate text-[var(--text-secondary)]">{c.target}</span>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">本轮暂无写入改动</div>
            )}
          </div>
          <div className="p-2 shrink-0 flex items-center justify-between">
            <button onClick={() => { if (activeId) { void refreshMessages(activeId); void refreshSources(activeId); showToast({ type: 'info', message: '已刷新消息与素材列表' }) } }}
              className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors text-left">
              刷新当前会话
            </button>
            <button onClick={() => toggleSide('right')} title="折叠右栏"
              className="p-1 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
              <PanelRightClose size={12} />
            </button>
          </div>
          </div>
          </div>
        </ResizablePanel>
        {/* 右缘透明拉出条（2026-09-08 用户拍板：收起后面板彻底消失，但右缘保留透明拉出条——
            默认透明，悬停显示蓝色高亮竖条。两种展开方式：点击直接展开 / 按住向左拖过
            minWidth 一半即展开（与 ResizablePanel 折叠态「拖出展开」同语义）；
            拖拽展开后抑制随后的 click 派发防二次翻转；顶栏「素材库」按钮为等效入口。
            2026-09-15 同源补 pointer events + capture（v3.2.0 条目 ⑤）：本条在窗口最右缘，
            而有工件栏时**往左拖的前 120px 全落在工件栏上**——工件栏正文是 `.html` 时即
            `kbview://` iframe，父文档收不到 mousemove → 阈值永远走不到、拉出彻底失效；
            指针一旦进 iframe 连 mouseup 也丢 → body.cursor 卡住。capture 后事件不再断流。 */}
        {!srcVisible && (
          <div
            data-edge-strip="right"
            title="点击或向左拖拽展开素材库"
            className="shrink-0 w-2 group relative cursor-col-resize"
            onLostPointerCapture={() => { document.body.style.cursor = '' }}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault()
              // React 合成事件 currentTarget 在派发结束后被置 null——异步回调（onUp）里
              // 不能再读，必须在 pointerdown 同步期捕获元素引用（2026-09-08 实锤报错点）
              const strip = e.currentTarget as HTMLElement
              const startX = e.clientX
              let opened = false
              let maskOn = false
              try { strip.setPointerCapture(e.pointerId) } catch { /* 退回 window 监听 */ }
              const onMove = (ev: PointerEvent): void => {
                // 遮罩等真动了再挂：单击展开不该闪一层透明遮罩（4px 与全应用 dead-zone 同口径）
                if (!maskOn && Math.abs(ev.clientX - startX) >= 4) { maskOn = true; setArtDragMask(true) }
                if (opened) return
                if (startX - ev.clientX > 120) { opened = true; openSources() }
              }
              const onUp = (): void => {
                setArtDragMask(false)
                document.body.style.cursor = ''
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                window.removeEventListener('pointercancel', onUp)
                if (opened) {
                  const suppress = (ev: Event): void => { ev.stopPropagation(); strip.removeEventListener('click', suppress, true) }
                  strip.addEventListener('click', suppress, true)
                  setTimeout(() => strip.removeEventListener('click', suppress, true), 0)
                }
              }
              document.body.style.cursor = 'col-resize'
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
              window.addEventListener('pointercancel', onUp)
            }}
            onClick={openSources}
          >
            <div className="absolute top-0 bottom-0 right-0 w-1 bg-[var(--accent)]/0 group-hover:bg-[var(--accent)]/60 transition-colors duration-150" />
          </div>
        )}

        {/* 支线旁问浮窗（v3.1.2 补强，2026-09-14）：挂在**行容器末尾**，`absolute` 于整行
            （舞台 = rowRef，见 useFloatingWindow）。原先挂在中栏内部只能在中栏里浮，
            现在可跨左栏/中栏/工件栏自由拖动 + 八向缩放（热区见 floatWin.handles）。
            把它推到最右缘推不动时出现落位提示，松手自动转宽轨 —— 与宽轨态统一为「同一个窗口的两态」。 */}
        {sideLane && !sideLaneWide && floatWin.ready && (
          <div className="absolute z-40 rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-2xl overflow-hidden kb-pop"
            style={floatWin.style}>
            <SideLanePanel
              key={sideLane.openLaneId ?? sideLane.anchorMessageId}
              parentSessionId={sideLane.parentSessionId}
              parentTitle={sideLane.parentTitle}
              anchorMessageId={sideLane.anchorMessageId}
              openLaneId={sideLane.openLaneId}
              onClose={() => setSideLane(null)}
              onToggleWide={() => toggleSideLaneWide(true)}
              onLaneReady={(lid, ltitle) => noteLaneReady(sideLane.anchorMessageId, lid, ltitle)}
              onPromote={promoteLane}
              titleDrag={{ onPointerDown: floatWin.onTitlePointerDown, onDoubleClick: floatWin.onTitleDoubleClick }}
            />
            {/* 八向缩放热区：内贴外壳内缘，`kb-pop` 进场动画只管外壳，热区随之内外一致 */}
            {floatWin.handles.map(h => (
              <div key={h.dir} className="absolute z-20" style={h.style}
                onPointerDown={e => floatWin.onHandlePointerDown(e, h.dir)} />
            ))}
          </div>
        )}
        {/* 停靠落位提示：拖近右缘时在右栏位置浮现（`pointer-events-none` 不吃掉拖拽手势） */}
        {floatWin.dockHint && (
          <div className="absolute inset-y-3 right-3 w-16 z-30 pointer-events-none rounded-lg border border-[var(--accent)]/50 bg-[var(--accent)]/12 kb-dock-hint" />
        )}
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
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12.5px] hover:opacity-90 transition-opacity"><Plus size={12} /> 新建工作区</button>
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
                <div className="mt-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                  <button onClick={() => setWsModal({ mode: 'rename', id: w.id, value: w.name })}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><PenLine size={11} /> 改名</button>
                  {/* UI 优化条目8.2.2：工作区画像第三层入口（卡片 hover 行） */}
                  <button onClick={() => { void openProfile('workspace', w.id) }} title={`工作区画像 · ${aiTeachRoot}/${w.folderRel.startsWith(`${aiTeachRoot}/`) ? w.folderRel.slice(aiTeachRoot.length + 1) : w.folderRel}/PROFILE.md（本课程目标/进度，覆盖全局画像）`}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><User size={11} /> 画像</button>
                  {/* v3.1.2 条目6：工作区要求入口（卡片 hover 行，与画像并列）——本工作区所有会话共同遵循的 CONSTRAINTS.md */}
                  <button onClick={() => { void openWorkspaceConstraints(w.id) }} title={`工作区要求 · ${w.folderRel}/CONSTRAINTS.md（本工作区所有会话共同遵循，优先级：本会话要求 > 工作区要求 > 全局要求）`}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"><ScrollText size={11} /> 要求</button>
                  <button onClick={() => void removeWs(w)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:text-red-400 transition-colors"><Trash2 size={11} /> 删除</button>
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
            对话产物目录：<code className="px-1 rounded bg-[var(--bg-hover)]">{treeBase}/{'{MM-DD 会话标题}'}/</code>；删除工作区只解除归属，文件夹与对话保留。
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
      {srcForm && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30" onClick={() => setSrcForm(null)}>
          <div className="w-[430px] max-w-[92vw] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-1 text-[13px] font-medium text-[var(--text-primary)]">添加素材（登记进 SOURCE.md）</div>
            <div className="mb-3 truncate text-[10.5px] text-[var(--text-muted)]" title={srcFileRel ?? ''}>{srcFileRel ?? '首次登记时自动创建于工作区 SOURCES/ 下'}</div>
            <div className="space-y-2.5 text-[12.5px] text-[var(--text-primary)]">
              <div className="flex items-center gap-2">
                <label className="w-[52px] shrink-0 text-right text-[11.5px] text-[var(--text-secondary)]">名称 *</label>
                <input autoFocus value={srcForm.name} maxLength={60} onChange={e => setSrcForm({ ...srcForm, name: e.target.value })} placeholder="如：一次函数课件"
                  className="min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12.5px] outline-none focus:border-[var(--accent)]"
                  onKeyDown={e => { if (e.key === 'Escape') setSrcForm(null) }} />
              </div>
              {/* 类型全自动检测（2026-09-08 拍板）+ 存放方式常驻（2026-09-09 修 URL 死锁）：
                  「存放」选择器不受路径是否已填限制——否则默认已入库且未浏览时切不到「仅引用」，URL 无从录入；
                  类型徽章有路径后按扩展名/协议实时识别。分工不变：表单登记自动识别；手编/AI 登记由用户在文件里写明类型 */}
              <div className="flex items-center gap-2">
                {srcForm.path.trim() ? (
                  <span className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-secondary)]">
                    自动识别：{srcForm.type === 'dir' ? '目录（目录下所有文件都是素材）' : inferSrcType(srcForm.path)}
                  </span>
                ) : (
                  <span className="text-[11px] text-[var(--text-muted)]">类型按所填地址/文件自动识别</span>
                )}
                <label className="ml-2 shrink-0 text-[11.5px] text-[var(--text-secondary)]">存放</label>
                <select value={srcForm.storage} onChange={e => setSrcForm({ ...srcForm, storage: e.target.value === '已入库' ? '已入库' : '仅引用', path: '' })}
                  className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--accent)]">
                  <option value="已入库">已入库（拷贝原件）</option>
                  <option value="仅引用">仅引用（记路径/URL）</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="w-[52px] shrink-0 text-right text-[11.5px] text-[var(--text-secondary)]">{srcForm.storage === '已入库' ? '文件' : '地址'}</label>
                {srcForm.storage === '已入库' ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <button onClick={() => void pickSrcFile()} className="shrink-0 rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">浏览…</button>
                    <button onClick={() => void pickSrcDir()} title="登记仓库内某个目录：目录下所有文件都成为素材（文本文件 AI 直接读，非文本 AI 会先询问）"
                      className="shrink-0 rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">仓库目录…</button>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]" title={srcForm.path}>{srcForm.path || '未选择文件'}</span>
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <input value={srcForm.path} onChange={e => setSrcForm({ ...srcForm, path: e.target.value })} placeholder={inferSrcType(srcForm.path) === 'url' ? 'https://…' : '仓库内相对路径 / 绝对路径'}
                      className="min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12.5px] outline-none focus:border-[var(--accent)]" />
                    <button onClick={() => void pickSrcDir()} title="登记仓库内某个目录：目录下所有文件都成为素材（文本文件 AI 直接读，非文本 AI 会先询问）"
                      className="shrink-0 rounded-md border border-[var(--border-color)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">仓库目录…</button>
                  </div>
                )}
              </div>
              {(() => {
                const detected = inferSrcType(srcForm.path)
                return (detected === 'pdf' || detected === 'pptx' || detected === 'code') ? (
                  <div className="flex items-center gap-2">
                    <label className="w-[52px] shrink-0 text-right text-[11.5px] text-[var(--text-secondary)]" title="按 PDF/幻灯片自身的第几页（阅读器显示页码），不是书页印刷页码">{detected === 'code' ? '行号' : '页码'}</label>
                    <input value={srcForm.rangeFrom} inputMode="numeric" onChange={e => setSrcForm({ ...srcForm, rangeFrom: e.target.value.replace(/\D/g, '') })} placeholder={detected === 'code' ? '起始行' : '起始页'}
                      className="w-[72px] rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--accent)]" />
                    <span className="text-[var(--text-muted)]">–</span>
                    <input value={srcForm.rangeTo} inputMode="numeric" onChange={e => setSrcForm({ ...srcForm, rangeTo: e.target.value.replace(/\D/g, '') })} placeholder={detected === 'code' ? '结束行' : '结束页'}
                      className="w-[72px] rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--accent)]" />
                    <span className="text-[10.5px] text-[var(--text-muted)]">登记后可一键出提取稿</span>
                  </div>
                ) : null
              })()}
              <div className="flex items-center gap-2">
                <label className="w-[52px] shrink-0 text-right text-[11.5px] text-[var(--text-secondary)]">备注</label>
                <input value={srcForm.note} maxLength={80} onChange={e => setSrcForm({ ...srcForm, note: e.target.value })} placeholder="可选（如章节说明）"
                  className="min-w-0 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12.5px] outline-none focus:border-[var(--accent)]"
                  onKeyDown={e => { if (e.key === 'Enter') void submitSrcForm() }} />
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-[10px] text-[var(--text-muted)]">确定=程序解析模板写入文件（3-28）</span>
              <div className="flex gap-2">
                <button onClick={() => setSrcForm(null)} className="rounded-md px-3 py-1 text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">取消</button>
                <button onClick={() => void submitSrcForm()} disabled={!srcForm.name.trim()}
                  className="rounded-md bg-[var(--accent)] px-3 py-1 text-[12.5px] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">确定登记</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* UI 优化第三轮：画像编辑不再用弹层——三层=三份仓库内 PROFILE.md，入口直接跳编辑区打开
          （ensure 落骨架 → kb-open-in-editor from:aiTeaching → 编辑器「← 返回 AI教学」回跳）；弹层 JSX 已删除 */}
      {webDlg && activeId && (
        <WebSourceDialog sessionId={activeId ?? ''} entry={webDlg} onClose={() => setWebDlg(null)} onDone={() => { void refreshSources(activeId) }} />
      )}
    </div>
  )
}
