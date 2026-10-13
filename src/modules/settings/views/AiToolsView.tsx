import { useEffect, useState, useCallback } from 'react'
import { Bot, Gauge, RefreshCw, ShieldCheck, Server, Plus, Plug, Trash2, AlertTriangle, Loader2, Sparkles, Store, Copy, Cpu, Upload, MessageSquare, BarChart3, GraduationCap, FolderOpen } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import {
  aiToolsList, aiToolsGetRecentAudit,
  mcpListServers, mcpAddServer, mcpRemoveServer, mcpToggleServer, mcpRefreshTools, mcpTestConnection,
  aiToolsListSkills, aiToolsCopySkillPrompt, aiToolsInstallSkillFromFile, aiToolsInstallSkillFromFolder, aiToolsUninstallSkill, aiToolsToggleSkill,
  llmListProviders,
  pluginListMascots, pluginListInstalled, onPluginInstalledChanged,
} from '../../../lib/ipc'
import { AiModelsTab } from './AiModelsTab'
import { AiUsageTab } from './AiUsageTab'
import { AiTeachingView } from './AiTeachingView'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { AiPermissionsTab } from './AiPermissionsTab'
import { CollapseList } from '../components/CollapseList'
import { SettingListPanel } from '../components/SettingListPanel'
import type { AiTab } from '../../../lib/settings'
import type { AgentToolInfo, AiToolUsage, AuditEntryInfo, McpServerInfo, McpServerDraft, McpTestResult, SkillInfo, SkillInstallResult, PluginMascotInfo, PluginSummary } from '../../../types'

const SOURCE_LABEL: Record<AgentToolInfo['source'], string> = {
  builtin: '内置',
  mcp: 'MCP',
  skill: 'Skill',
}

/** 工具归属模块 → 用户语言（原来直接渲染 module id，用户看到的是 quiz/knowledge 这类内部标识） */
const MODULE_LABEL: Record<string, string> = {
  knowledge: '知识库',
  blog: '博客/日记',
  schedule: '日程',
  checkin: '习惯打卡',
  pomodoro: '番茄专注',
  quiz: '错题本',
}

/**
 * 页签清单（2026-10-13 按域重排：5 → 6）。
 *
 * 旧页签 mixed 了多个域：工具清单 / 月度上限 / Agent 循环预算全挤在「内置工具」里，
 * 而「工具调用量」汇总条与「AI 助手」两块**常驻在页签区之外** —— 切页签它们纹丝不动，
 * 看起来就是"这个页面把好几件事糊在一起"。新口径一个页签一个域：
 * 模型（怎么接）· 权限（能动什么）· 工具（有哪些）· 对话（怎么跑）· 用量（用掉多少）· 教学。
 */
const AI_TABS = [
  ['models', '模型', <Cpu key="c" size={14} />],
  ['perms', '权限', <ShieldCheck key="p" size={14} />],
  ['tools', '工具', <Bot key="b" size={14} />],
  ['chat', '对话', <MessageSquare key="m" size={14} />],
  ['usage', '用量', <BarChart3 key="g" size={14} />],
  ['teach', '教学', <GraduationCap key="t" size={14} />],
] as const

/**
 * 设置 → AI 工具：一个页签一个域 —— 模型 / 权限 / 工具 / 对话 / 用量 / 教学。
 * 默认落在「模型」：AI 设置里最先要配的就是模型，旧默认是「内置工具」（只读清单，看完就没事干了）。
 */
export function AiToolsView({ initialTab }: { initialTab?: AiTab } = {}) {
  const [tab, setTab] = useState<AiTab>(initialTab ?? 'models')
  // 深链变化(面板再次"去配置模型"时组件可能仍挂载)同步切换
  useEffect(() => { if (initialTab) setTab(initialTab) }, [initialTab])
  const [usage, setUsage] = useState<AiToolUsage>({ used: 0, limit: 0 })
  const [mascots, setMascots] = useState<PluginMascotInfo[]>([])
  /**
   * 空列表的**五种真相**（F-1，2026-10-13）。此前这里只有一句「尚未安装吉祥物角色」，
   * 而"真没装 / 装了但没启用 / 装了但没加载起来 / 后台插件线没跟上 / 扫描抛错"五种情况
   * 看起来一模一样 —— 开发者 2026-10-13 就是这么被卡住的（截图里那句正是空列表文案）。
   * 判据全部来自**既有 IPC**（mascots + installed 两份清单交叉），不新增主进程通道：
   * 主进程恰好是最不该依赖的一环（铁律 8：dev 主进程没有热重载，它可能还停在旧版本）。
   *   ok          ── 有角色（正常）；
   *   none        ── 没有任何已装插件声明 mascot：真的没装；
   *   disabled    ── 有插件声明了 mascot 但**未启用**（扫描只收 enabled）；
   *   broken      ── 有插件没加载起来（缺文件 / 清单校验没过）；
   *   stale       ── 已装、已启用、却仍没角色 ⇒ 后台没跟上（重启应用）；
   *   unavailable ── mascots 那条 IPC 直接抛错（通道不存在 / 主进程异常）。
   */
  const [mascotDiag, setMascotDiag] = useState<{ state: 'ok' | 'none' | 'disabled' | 'broken' | 'stale' | 'unavailable'; names: string[] }>({ state: 'ok', names: [] })

  // 已安装插件的吉祥物角色（供「吉祥物」下拉）；安装/启停/卸载后刷新
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void (async () => {
        let list: PluginMascotInfo[] = []
        try {
          list = await pluginListMascots()
        } catch {
          // ★ 以前这里是 .catch(() => setMascots([]))：把"通道不可用"伪装成"没装"，
          //   用户看到的是「尚未安装吉祥物角色」——一句谎话。现在如实说并且能自诊断。
          if (!alive) return
          setMascots([])
          setMascotDiag({ state: 'unavailable', names: [] })
          return
        }
        if (!alive) return
        setMascots(list)
        if (list.length > 0) { setMascotDiag({ state: 'ok', names: [] }); return }
        // 空列表：拿**已安装插件清单**交叉判断到底是哪种空（该 IPC 是老通道，旧主进程也有）
        let installed: PluginSummary[] = []
        try { installed = await pluginListInstalled() } catch { installed = [] }
        if (!alive) return
        const declares = installed.filter(p => (p.contributions ?? []).includes('mascot'))
        const enabledDeclares = declares.filter(p => p.enabled && !p.broken)
        if (enabledDeclares.length > 0) { setMascotDiag({ state: 'stale', names: enabledDeclares.map(p => p.name) }); return }
        const disabledDeclares = declares.filter(p => !p.enabled)
        if (disabledDeclares.length > 0) { setMascotDiag({ state: 'disabled', names: disabledDeclares.map(p => p.name) }); return }
        const broken = installed.filter(p => p.broken)
        if (broken.length > 0) { setMascotDiag({ state: 'broken', names: broken.map(p => p.name) }); return }
        setMascotDiag({ state: 'none', names: [] })
      })()
    }
    load()
    const off = onPluginInstalledChanged(load)
    return () => { alive = false; off() }
  }, [])

  const refreshUsage = useCallback(async () => {
    try {
      const r = await aiToolsList()
      setUsage(r.usage)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { void refreshUsage() }, [refreshUsage])

  return (
    <div className="space-y-6">
      {/* 页签 */}
      <div className="flex items-center gap-1 border-b border-[var(--border-color)] flex-wrap">
        {AI_TABS.map(([id, label, icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-[13px] border-b-2 -mb-px transition-colors ${
              tab === id
                ? 'border-[var(--accent)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* 每个页签一个域。此前「工具调用量」汇总条与「AI 助手」两块常驻在这里（页签区之外），
          切页签它们纹丝不动 —— 那正是"一个页面糊了好几件事"的来源。现已各自归位：
          工具调用量 → 用量页签；AI 助手/感知/Agent 循环 → 对话页签。 */}
      {tab === 'models' && <div data-setting-anchor="aiTools.models"><AiModelsTab /></div>}

      {tab === 'perms' && <div data-setting-anchor="aiTools.perms"><AiPermissionsTab /></div>}

      {tab === 'tools' && (
        <div className="space-y-8">
          <BuiltinToolsTab />
          <McpServersTab onInvoked={refreshUsage} />
          <SkillsTab />
        </div>
      )}

      {tab === 'chat' && <ChatTab mascots={mascots} mascotDiag={mascotDiag} />}

      {tab === 'usage' && <AiUsageTab usage={usage} onUsageChange={setUsage} />}

      {tab === 'teach' && <div data-setting-anchor="aiTools.teach"><AiTeachingView /></div>}
    </div>
  )
}

// ===== 对话页签 =====

/**
 * 设置 → AI 工具 → 对话（2026-10-13 独立成页签）。
 *
 * 装的是"对话怎么跑"：助手感知、上下文占用指示、吉祥物、Agent 循环预算。
 * 这些原来散在两处 —— 档位/窗口/吉祥物**常驻在页签区之外**（切页签纹丝不动，看着像页面串了域），
 * Agent 循环预算则埋在「内置工具」页签里（去找工具清单的人不会想到预算在这儿）。
 */
function ChatTab({ mascots, mascotDiag }: {
  mascots: PluginMascotInfo[]
  mascotDiag: { state: 'ok' | 'none' | 'disabled' | 'broken' | 'stale' | 'unavailable'; names: string[] }
}) {
  const { s, update } = useSettings()
  return (
    <div className="space-y-8">
      <div data-setting-anchor="aiTools.chat">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">AI 助手</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          对话输入区的行为与显示，AI 教学与 AI 对话共用同一套档位与窗口口径。
        </p>
        <div className="space-y-3 max-w-md">
          {/* 感知模式（2026-10-13）：此前 ui:true 却无 anchor ⇒ 被 schemaKeyItems 静默排除在
              设置搜索之外，只能在 AI 助手面板里点到。现在给出设置页落点。 */}
          <div data-setting-anchor="aiTools.perception">
            <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
                <Sparkles size={14} className="text-[var(--text-muted)]" />
                感知模式（发送前自动检索笔记）
              </span>
              <SettingSwitch
                checked={s.aiAssistantPerception === true}
                onChange={v => update('aiAssistantPerception', v)}
                aria-label="AI 助手感知模式"
              />
            </label>
            <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1 mt-1.5">
              发送前自动检索知识库，把最相关的笔记素材注入本轮上下文；纯本地检索（至多一次向量化调用，不消耗对话 token）。
              未配置向量模型时自动降级为关键词匹配。也可在 AI 助手面板顶部随时开关。
            </p>
          </div>

          <label data-setting-anchor="aiTools.ctxUsageDetail" className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
              <Gauge size={14} className="text-[var(--text-muted)]" />
              占用指示档位
            </span>
            <select
              value={s.ctxUsageDetail || 'compact'}
              onChange={e => update('ctxUsageDetail', e.target.value)}
              className="px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            >
              <option value="off">隐藏</option>
              <option value="compact">紧凑（上下文圆环）</option>
              <option value="detailed">详细（圆环+文字摘要）</option>
            </select>
          </label>

          <div data-setting-anchor="aiTools.ctxWindow">
            <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
                <Cpu size={14} className="text-[var(--text-muted)]" />
                模型上下文窗口（token）
              </span>
              <input
                type="number" min={0} step={1000}
                value={s.ctxWindow ?? 0}
                onChange={e => update('ctxWindow', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                className="w-40 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1 mt-1.5">
              0=未设置，用量指示退化为纯数字；设置所选模型的上下文窗口（如 128000）后圆环按占用比例着色（&gt;85% 变红）。
            </p>
          </div>

          <div data-setting-anchor="ai.mascot">
            <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
                <Sparkles size={14} className="text-[var(--text-muted)]" />
                吉祥物
              </span>
              <select
                value={typeof s.aiMascot === 'string' ? s.aiMascot : 'auto'}
                onChange={e => update('aiMascot', e.target.value)}
                className="px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              >
                <option value="auto">自动（用已安装的）</option>
                <option value="placeholder">内置占位</option>
                {mascots.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                <option value="off">关闭</option>
              </select>
            </label>
            <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1 mt-1.5">
              {mascots.length > 0
                ? '有 AI 输入框的地方（对话主区 / 侧边对话 / 放大态 / 支线旁问 / 日程问答）在输入卡上沿显示所选角色，随 AI 活动切换小动作。'
                : mascotDiag.state === 'unavailable'
                  ? '读不到吉祥物清单（插件线不可用）—— 若刚更新过版本或正在开发模式，先把应用整个重启一次（开发模式下只刷新界面不够，后台不会跟着更新）；仍不行请把这一行报给开发者。'
                  : mascotDiag.state === 'stale'
                    ? `已安装并启用了 ${mascotDiag.names.join('、')}，但没能读出角色 —— 多半是后台（主进程）还停在旧版本，重启应用后再看。`
                    : mascotDiag.state === 'disabled'
                      ? `已安装 ${mascotDiag.names.join('、')}，但它当前未启用 —— 到 设置 → 插件 里启用后，这里就会出现可选角色。`
                      : mascotDiag.state === 'broken'
                        ? `有插件没能加载起来（${mascotDiag.names.join('、')}）—— 到 设置 → 插件 看它的报错（文件缺失或清单校验没过）。`
                        : '尚未安装吉祥物角色；到插件市场安装「书桌伙伴 · AI 吉祥物」后即可在此选择。'}
            </p>
          </div>
        </div>
      </div>

      <AgentLoopPanel />
    </div>
  )
}

/** Agent 循环预算（轮数 / token 预算 / 上下文裁剪；Agent 第 0+2 层）。原埋在「内置工具」页签里。 */
function AgentLoopPanel() {
  const { s, update } = useSettings()
  const agentMaxRounds = s.agentMaxRounds ?? 16
  const agentRunTokenBudget = s.agentRunTokenBudget ?? 500000
  const agentContextBudgetTokens = s.agentContextBudgetTokens ?? 24000
  const agentCompressionEnabled = s.agentCompressionEnabled !== false
  const agentCompressAtPercent = s.agentCompressAtPercent ?? 80
  const agentCompressModelId = s.agentCompressModelId ?? ''
  // 压缩专用模型下拉：全部供应商的全部模型（'' = 跟随当前会话模型）
  const [compressModelOptions, setCompressModelOptions] = useState<Array<{ value: string; label: string }>>([])
  useEffect(() => {
    void llmListProviders().then(({ providers }) => {
      setCompressModelOptions(providers.flatMap(p => (p.models ?? []).map(m => ({ value: `${p.id}:${m}`, label: `${p.name} / ${m}` }))))
    }).catch(() => setCompressModelOptions([]))
  }, [])

  return (
    <div data-setting-anchor="aiTools.agentLoop">
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">Agent 循环</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-4">
        控制单次请求的推理预算：轮数或累计 token 触顶后自动总结收场（不丢弃已获取的信息）。互相独立的工具调用会并发执行以减少轮数消耗。
      </p>
      <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md space-y-2.5">
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-[var(--text-primary)]">最大推理轮数</span>
          <input
            type="number"
            min={2}
            max={64}
            value={String(agentMaxRounds)}
            onChange={e => { void update('agentMaxRounds', Math.min(64, Math.max(2, Math.floor(Number(e.target.value) || 16)))) }}
            className="w-24 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] text-right outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-[var(--text-primary)]">单次 token 预算</span>
          <input
            type="number"
            min={0}
            step={50000}
            value={String(agentRunTokenBudget)}
            onChange={e => { void update('agentRunTokenBudget', Math.max(0, Math.floor(Number(e.target.value) || 0))) }}
            className="w-24 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] text-right outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-[var(--text-primary)]">历史上下文预算</span>
          <input
            type="number"
            min={0}
            step={2000}
            value={String(agentContextBudgetTokens)}
            onChange={e => { void update('agentContextBudgetTokens', Math.max(0, Math.floor(Number(e.target.value) || 0))) }}
            className="w-24 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] text-right outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-[var(--text-primary)]">自动压缩触发线</span>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={50}
              max={100}
              step={5}
              value={String(agentCompressAtPercent)}
              onChange={e => { void update('agentCompressAtPercent', Math.min(100, Math.max(50, Math.floor(Number(e.target.value) || 80)))) }}
              className="w-24 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] text-right outline-none focus:border-[var(--accent)]"
            />
            <span className="text-[12px] text-[var(--text-muted)]">%</span>
          </div>
        </label>
        <div className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-[var(--text-primary)]">历史自动压缩</span>
          <SettingSwitch checked={agentCompressionEnabled} onChange={v => { void update('agentCompressionEnabled', v) }} aria-label="历史自动压缩" />
        </div>
        <label className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-[var(--text-primary)] shrink-0">压缩专用模型</span>
          <select
            value={agentCompressModelId}
            onChange={e => { void update('agentCompressModelId', e.target.value) }}
            className="w-44 px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] truncate"
          >
            <option value="">跟随当前会话模型</option>
            {compressModelOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <p className="text-[11px] text-[var(--text-muted)]">
          历史上下文预算控制带进模型的历史消息量，0 表示不裁剪（不推荐：长会话费用会快速上涨）。
          开启自动压缩后，上下文达到触发线（历史预算的百分比）时先把较早的对话折叠为持久化纪要再发送（代替直接丢弃）；
          也可随时在聊天框输入 /compress 手动压缩。
        </p>
      </div>
    </div>
  )
}

// ===== 工具页签 · 内置工具 =====

/** 只读的内置工具清单与最近调用记录。月度上限搬去「用量」页签、Agent 循环预算搬去「对话」页签。 */
function BuiltinToolsTab() {
  const [tools, setTools] = useState<AgentToolInfo[]>([])
  const [recentAudit, setRecentAudit] = useState<AuditEntryInfo[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [listResult, audit] = await Promise.all([aiToolsList(), aiToolsGetRecentAudit(10)])
      setTools(listResult.tools.filter(t => t.source === 'builtin'))
      setRecentAudit(audit)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <div className="space-y-8">
      {/* 内置工具只读列表（popover 悬浮：展开覆盖下方内容，不推挤） */}
      <div data-setting-anchor="aiTools.builtin">
        <SettingListPanel
          display="popover"
          title="内置工具"
          count={tools.length}
          anchorId="aiTools.builtin"
          titleClassName="text-[15px] font-medium text-[var(--text-primary)]"
          titleRight={
            <button onClick={() => { void refresh() }} title="刷新"
              className="p-1.5 -mr-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <RefreshCw size={14} />
            </button>
          }
          description="官方提供的只读工具，未来 Agent 与外部客户端经由统一注册表调用。不可关闭以保证透明。"
          items={tools.map(t => ({
            id: t.name,
            label: t.name,
            icon: <Bot size={14} />,
            tags: [
              { label: SOURCE_LABEL[t.source] },
              ...(t.readOnly ? [{ label: '只读', tone: 'success' as const }] : []),
              ...(t.requires === 'write' ? [{ label: '写入', tone: 'warning' as const }] : []),
              ...(t.module ? [{ label: MODULE_LABEL[t.module] ?? t.module }] : []),
            ],
            desc: t.description,
          }))}
          defaultSelectedId={tools[0]?.name}
          maxListHeightClassName="max-h-[260px]"
        />
      </div>

      {/* 最近调用 */}
      <div data-setting-anchor="aiTools.audit">
        <CollapseList
          title="最近调用"
          count={recentAudit.length}
          anchorId="aiTools.audit"
          titleClassName="text-[15px] font-medium text-[var(--text-primary)]"
        >
          <p className="text-[12px] text-[var(--text-muted)] mb-3">最近 10 条审计记录（含入参摘要与耗时，不含返回内容）。</p>
          <div className="space-y-1.5 max-w-md">
            {recentAudit.map(e => <AuditRow key={e.id} entry={e} />)}
            {recentAudit.length === 0 && <p className="text-[12px] text-[var(--text-muted)]">暂无调用记录</p>}
          </div>
        </CollapseList>
      </div>
    </div>
  )
}

function AuditRow({ entry }: { entry: AuditEntryInfo }) {
  let d: Record<string, unknown> = {}
  try { d = JSON.parse(entry.detail) } catch { /* ignore */ }
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--border-color)] text-[11px]" title={entry.action}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${d.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
      <code className="text-[var(--text-secondary)] truncate">{String(d.tool ?? entry.action)}</code>
      <span className="ml-auto text-[var(--text-disabled)] tabular-nums shrink-0">
        {typeof d.durationMs === 'number' ? `${d.durationMs}ms` : ''} · {entry.createdAt}
      </span>
    </div>
  )
}

// ===== MCP 服务器页签 =====

const TRANSPORT_BADGE: Record<McpServerInfo['transport'], string> = {
  stdio: '本机命令',
  sse: 'SSE',
  http: 'HTTP',
}

function statusDotClass(status: McpServerInfo['status']): string {
  if (status === 'ok') return 'bg-emerald-500'
  if (status === 'error') return 'bg-red-500'
  return 'bg-zinc-500'
}

function McpServersTab({ onInvoked }: { onInvoked: () => void }) {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setServers(await mcpListServers()) } finally { setLoading(false) }
    onInvoked()
  }, [onInvoked])

  useEffect(() => { void refresh() }, [refresh])

  const handleToggle = async (sv: McpServerInfo) => {
    const r = await mcpToggleServer(sv.id, !sv.enabled)
    if (!r.ok) showToast({ type: 'error', message: `启用失败：${r.error ?? '未知错误'}` })
    else if (!sv.enabled) showToast({ type: 'info', message: `「${sv.name}」已连接` })
    await refresh()
  }

  const handleRefreshTools = async (sv: McpServerInfo) => {
    const r = await mcpRefreshTools(sv.id)
    if (!r.ok) showToast({ type: 'error', message: `刷新失败：${r.error}` })
    else showToast({ type: 'info', message: `发现 ${r.tools.length} 个工具` })
    await refresh()
  }

  const handleRemove = async (sv: McpServerInfo) => {
    if (confirmingId !== sv.id) {
      setConfirmingId(sv.id)
      setTimeout(() => setConfirmingId(cur => (cur === sv.id ? null : cur)), 3000)
      return
    }
    setConfirmingId(null)
    await mcpRemoveServer(sv.id)
    showToast({ type: 'info', message: `「${sv.name}」已删除` })
    await refresh()
  }

  return (
    <div data-setting-anchor="aiTools.mcp">
      <div className="flex items-center justify-between max-w-md">
        <div>
          <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">MCP 服务器</h2>
          <p className="text-[12px] text-[var(--text-muted)]">
            连接外部 Model Context Protocol 服务器，其工具将并入统一注册表。最多同时连接 {servers[0]?.maxConnections ?? 5} 个。
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => { void refresh() }} title="刷新"
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            <RefreshCw size={14} />
          </button>
          <button onClick={() => setWizardOpen(true)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">
            <Plus size={13} /> 添加服务器
          </button>
        </div>
      </div>

      <div className="space-y-2 mt-4 max-w-md">
        {servers.map(sv => (
          <div key={sv.id} className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass(sv.status)}`} title={sv.status} />
              <span className="text-[13px] font-medium text-[var(--text-primary)]">{sv.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)]">
                {TRANSPORT_BADGE[sv.transport]}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">{sv.toolCount} 个工具</span>
              <label className="ml-auto flex items-center cursor-pointer">
                <SettingSwitch checked={sv.enabled} onChange={() => { void handleToggle(sv) }} />
              </label>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] mt-1 truncate font-mono" title={sv.endpointPreview}>{sv.endpointPreview}</p>
            {sv.status === 'error' && sv.lastError && (
              <p className="text-[11px] text-red-400 mt-1 line-clamp-2" title={sv.lastError}>⚠ {sv.lastError}</p>
            )}
            <div className="flex items-center gap-2 mt-2">
              <button onClick={() => { void handleRefreshTools(sv) }}
                className="text-[11px] px-2 py-1 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                刷新工具
              </button>
              <button onClick={() => { void handleRemove(sv) }}
                className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
                  confirmingId === sv.id
                    ? 'border-red-500 text-red-400 hover:bg-red-500/10'
                    : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}>
                <Trash2 size={11} />
                {confirmingId === sv.id ? '再点一次确认删除' : '删除'}
              </button>
            </div>
          </div>
        ))}
        {!loading && servers.length === 0 && (
          <p className="text-[12px] text-[var(--text-muted)] px-1">尚未添加 MCP 服务器。点击右上角「添加服务器」开始。</p>
        )}
      </div>

      {wizardOpen && (
        <AddServerWizard
          onClose={() => setWizardOpen(false)}
          onSaved={async () => { setWizardOpen(false); await refresh() }}
        />
      )}
    </div>
  )
}

// ===== 三步添加向导 =====

function AddServerWizard({ onClose, onSaved }: { onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [step, setStep] = useState(1)
  const [transport, setTransport] = useState<'stdio' | 'sse' | 'http'>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [commandArgs, setCommandArgs] = useState('')
  const [url, setUrl] = useState('')
  const [envText, setEnvText] = useState('')
  const [confirmCommand, setConfirmCommand] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<McpTestResult | null>(null)

  const parseEnv = (): Record<string, string> | undefined => {
    const lines = envText.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) return undefined
    const env: Record<string, string> = {}
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1)
    }
    return Object.keys(env).length > 0 ? env : undefined
  }

  const buildDraft = (): McpServerDraft => ({
    name: name.trim(),
    transport,
    ...(transport === 'stdio'
      ? { command: command.trim(), commandArgs: commandArgs.trim() ? commandArgs.trim().split(/\s+/) : [], env: parseEnv(), confirmCommand }
      : { url: url.trim(), confirmCommand }),
  })

  const canLeaveStep2 = transport === 'stdio'
    ? command.trim().length > 0 && confirmCommand
    : /^https?:\/\/.+/.test(url.trim())
  const canSave = name.trim().length > 0 && canLeaveStep2

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try { setTestResult(await mcpTestConnection(buildDraft())) } finally { setTesting(false) }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const sv = await mcpAddServer(buildDraft())
      showToast({ type: 'info', message: `「${sv.name}」已保存（默认禁用，打开开关即连接）` })
      await onSaved()
    } catch (err) {
      showToast({ type: 'error', message: `保存失败：${String((err as Error)?.message ?? err)}` })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 kb-overlay" onClick={onClose}>
      <div className="w-[520px] max-h-[85vh] overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-3 border-b border-[var(--border-color)] flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">添加 MCP 服务器</h3>
          <span className="text-[11px] text-[var(--text-muted)]">步骤 {Math.min(step, 3)} / 3</span>
        </div>

        <div className="px-5 py-4 space-y-4">
          {step === 1 && (
            <div className="grid grid-cols-3 gap-2">
              {([['stdio', '本机命令', '通过命令行在本机启动服务器进程'], ['sse', 'SSE', '连接远程 Server-Sent Events 端点'], ['http', 'HTTP', '连接 Streamable HTTP 端点']] as const).map(([id, label, desc]) => (
                <button key={id} onClick={() => setTransport(id)}
                  className={`px-3 py-3 rounded-lg border text-left transition-colors ${
                    transport === id
                      ? 'border-[var(--accent)] bg-[var(--bg-selected)]'
                      : 'border-[var(--border-color)] hover:border-[var(--text-disabled)]'
                  }`}>
                  <div className="text-[13px] font-medium text-[var(--text-primary)]">{label}</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-1 leading-snug">{desc}</div>
                </button>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <Field label="名称">
                <input value={name} onChange={e => setName(e.target.value)} placeholder="例如 my-tools"
                  className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
              </Field>

              {transport === 'stdio' ? (
                <>
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-md bg-yellow-500/10 border border-yellow-600/40">
                    <AlertTriangle size={15} className="text-yellow-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-yellow-200/90 leading-relaxed">
                      此类型将在<b>本机执行任意命令</b>。请确认命令来源可信；保存后默认处于禁用状态。
                    </p>
                  </div>
                  <Field label="命令">
                    <input value={command} onChange={e => setCommand(e.target.value)} placeholder="例如 node 或 C:\tools\server.exe"
                      className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                  </Field>
                  <Field label="参数（空格分隔）">
                    <input value={commandArgs} onChange={e => setCommandArgs(e.target.value)} placeholder="例如 server.js --port 3000"
                      className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                  </Field>
                  <Field label="环境变量（可选，每行 KEY=VALUE，加密存储）">
                    <textarea value={envText} onChange={e => setEnvText(e.target.value)} rows={3} placeholder={'API_KEY=xxx\nDEBUG=1'}
                      className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)] resize-none" />
                  </Field>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={confirmCommand} onChange={e => setConfirmCommand(e.target.checked)} className="accent-[var(--accent)] w-4 h-4" />
                    <span className="text-[12px] text-[var(--text-secondary)]">我了解将执行此命令</span>
                  </label>
                </>
              ) : (
                <Field label="URL">
                  <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/mcp"
                    className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
                </Field>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <button onClick={() => { void handleTest() }} disabled={testing || !canSave}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-[13px] border border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
                测试连通性并预览工具
              </button>
              {testResult && (
                <div className={`px-3 py-2.5 rounded-md border text-[12px] ${
                  testResult.ok ? 'border-emerald-700/40 bg-emerald-500/5' : 'border-red-700/40 bg-red-500/5'
                }`}>
                  {testResult.ok ? (
                    <>
                      <p className="text-emerald-400">✓ 连接成功（{testResult.latencyMs}ms），发现 {testResult.tools.length} 个工具：</p>
                      <ul className="mt-1.5 space-y-1">
                        {testResult.tools.slice(0, 8).map(t => (
                          <li key={t.name} className="text-[var(--text-secondary)] truncate">
                            <code>{t.name}</code>{t.description ? ` — ${t.description}` : ''}
                          </li>
                        ))}
                      </ul>
                      {testResult.tools.length > 8 && <p className="text-[var(--text-muted)] mt-1">…等共 {testResult.tools.length} 个</p>}
                    </>
                  ) : (
                    <p className="text-red-400 break-all">✗ {testResult.error}</p>
                  )}
                </div>
              )}
              <p className="text-[11px] text-[var(--text-muted)]">
                保存后服务器处于<b>禁用</b>状态，需在列表中打开开关才会真正连接。
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border-color)] flex items-center justify-between">
          <button onClick={step === 1 ? onClose : () => setStep(s => s - 1)}
            className="px-3 py-1.5 rounded-md text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            {step === 1 ? '取消' : '上一步'}
          </button>
          {step < 3 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={!canLeaveStep2}
              className="px-3.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
              下一步
            </button>
          ) : (
            <button onClick={() => { void handleSave() }} disabled={!canSave || saving}
              className="px-3.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
              {saving ? '保存中…' : '保存'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[12px] text-[var(--text-secondary)] mb-1">{label}</span>
      {children}
    </label>
  )
}

// ===== Skill 页签 =====

function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await aiToolsListSkills()
      setSkills(r.skills)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const handleCopy = async (s: SkillInfo) => {
    const ok = await aiToolsCopySkillPrompt(s.pluginId, s.id)
    showToast(ok
      ? { type: 'info', message: `「${s.title}」提示词已复制到剪贴板` }
      : { type: 'error', message: '复制失败：技能可能已被禁用或卸载' })
  }

  const finishInstall = async (r: SkillInstallResult, installingName?: string) => {
    if (r.success) {
      showToast({ type: 'info', message: `「${r.skill?.title ?? installingName ?? 'Skill'}」已安装，AI 助手立即可用` })
    } else if (r.message !== '已取消') {
      showToast({ type: 'error', message: `安装失败：${r.message ?? '未知错误'}` })
    }
    await refresh()
  }

  const handlePickFolder = async () => {
    setInstalling(true)
    try {
      await finishInstall(await aiToolsInstallSkillFromFolder())
    } finally {
      setInstalling(false)
    }
  }

  const handlePickFile = async () => {
    setInstalling(true)
    try {
      await finishInstall(await aiToolsInstallSkillFromFile())
    } finally {
      setInstalling(false)
    }
  }

  const handleUninstall = async (s: SkillInfo) => {
    if (confirmingId !== s.id) {
      setConfirmingId(s.id)
      setTimeout(() => setConfirmingId(cur => (cur === s.id ? null : cur)), 3000)
      return
    }
    setConfirmingId(null)
    const r = await aiToolsUninstallSkill(s.id)
    showToast(r.success
      ? { type: 'info', message: `「${s.title}」已卸载` }
      : { type: 'error', message: `卸载失败：${r.message ?? '未知错误'}` })
    await refresh()
  }

  const handleToggle = async (s: SkillInfo) => {
    const r = await aiToolsToggleSkill(s.registryName, s.disabled)
    showToast(r.success
      ? { type: 'info', message: `「${s.title}」已${s.disabled ? '启用' : '停用'}` }
      : { type: 'error', message: `操作失败：${r.message ?? '未知错误'}` })
    await refresh()
  }

  return (
    <div data-setting-anchor="aiTools.skill">
      <div className="flex items-center justify-between max-w-md">
        <div>
          <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">Skill 技能</h2>
          <p className="text-[12px] text-[var(--text-muted)]">
            声明式提示词资产，AI 助手会引用它们。可安装 Skill 文件夹或 .zip 包，也可来自插件贡献。
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => { void refresh() }} title="刷新"
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            <RefreshCw size={14} />
          </button>
          <button onClick={() => { void handlePickFolder() }} disabled={installing}
            title="选中 Skill 自身的文件夹（内含 SKILL.md 或 skill.json）"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
            {installing ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
            选择文件夹安装
          </button>
          <button onClick={() => { void handlePickFile() }} disabled={installing}
            title="安装已经打包好的 .zip Skill 包"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
            <Upload size={13} /> .zip 包
          </button>
          <button onClick={() => window.dispatchEvent(new CustomEvent('plugins:open'))}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            <Store size={13} /> 去插件市场
          </button>
        </div>
      </div>

      {/* 2026-10-13：这里原本是一个"拖入 .zip"的拖拽区，而它**从来没收到过事件** ——
          src/App.tsx 在 document 捕获阶段把任何 .zip 拖放都吃掉去开「整仓备份恢复」弹窗了
          （onDrop 里 preventDefault + stopPropagation）。也就是说界面在教用户做一件做不到的事，
          AI 手册里也这么写。现在换成明确可点的「选择文件夹安装」（Skill 的本体本来就是文件夹），
          .zip 包保留为次要入口，拖拽区与相关文案一并撤掉。 */}
      <div className="mt-4 max-w-md rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-3">
        <p className="text-[11.5px] text-[var(--text-secondary)] leading-relaxed">
          安装方式：<b>选中 Skill 自身的文件夹</b>（内含 <code>SKILL.md</code> 或 <code>skill.json</code>）即可，不必先打包；
          也支持现成的 <code>.zip</code> 包。
        </p>
        <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed mt-1">
          若选中的文件夹里含多个 Skill，会明确提示你改选具体那一个 —— 不会替你随便挑一个装。
        </p>
      </div>

      <div className="space-y-2 mt-4 max-w-md">
        {skills.map(s => (
          <div key={s.registryName} className={`px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] transition-opacity ${s.disabled ? 'opacity-60' : ''}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <Sparkles size={14} className={`shrink-0 ${s.disabled ? 'text-[var(--text-disabled)]' : 'text-[var(--accent)]'}`} />
              <span className="text-[13px] font-medium text-[var(--text-primary)]">{s.title}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)]">
                {s.source === 'standalone' ? '独立安装' : s.pluginName}
              </span>
              {s.disabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-500/40 text-[var(--text-disabled)]">已停用</span>
              )}
              <label className="ml-auto flex items-center gap-2 cursor-pointer shrink-0" title={s.disabled ? '启用该 Skill' : '停用该 Skill（AI 不再使用，文件保留）'}>
                <span className="text-[11px] text-[var(--text-muted)]">{s.disabled ? '停用' : '启用'}</span>
                <SettingSwitch checked={!s.disabled} onChange={() => { void handleToggle(s) }} />
              </label>
            </div>
            {s.description && (
              <p className="text-[12px] text-[var(--text-secondary)] mt-1.5 leading-relaxed">{s.description}</p>
            )}
            {s.tools.length > 0 && (
              <p className="text-[11px] text-[var(--text-muted)] mt-1.5" title={s.tools.join(', ')}>
                依赖工具：{s.tools.join('、')}
              </p>
            )}
            <div className="flex items-center gap-2 mt-2">
              <button onClick={() => { void handleCopy(s) }}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                <Copy size={11} /> 复制提示词
              </button>
              {s.source === 'standalone' && (
                <button onClick={() => { void handleUninstall(s) }}
                  className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
                    confirmingId === s.id
                      ? 'border-red-500 text-red-400 hover:bg-red-500/10'
                      : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }`}>
                  <Trash2 size={11} />
                  {confirmingId === s.id ? '再点一次确认卸载' : '卸载'}
                </button>
              )}
            </div>
          </div>
        ))}
        {!loading && skills.length === 0 && (
          <p className="text-[12px] text-[var(--text-muted)] px-1">
            暂无已装 Skill。点「选择文件夹安装」装一个（或安装含 skills 贡献的插件包，官方示例：AI 技能包）。
          </p>
        )}
      </div>
    </div>
  )
}
