import { useEffect, useState, useCallback } from 'react'
import { Bot, Gauge, RefreshCw, ShieldCheck, Server, Plus, Plug, Trash2, AlertTriangle, Loader2, Sparkles, Store, Copy, Cpu, Upload } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import {
  aiToolsList, aiToolsGetRecentAudit,
  mcpListServers, mcpAddServer, mcpRemoveServer, mcpToggleServer, mcpRefreshTools, mcpTestConnection,
  aiToolsListSkills, aiToolsCopySkillPrompt, aiToolsInstallSkill, aiToolsInstallSkillFromFile, aiToolsUninstallSkill, aiToolsToggleSkill,
  llmListProviders,
} from '../../../lib/ipc'
import { AiModelsTab } from './AiModelsTab'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { AiPermissionsTab } from './AiPermissionsTab'
import { CollapseList } from '../components/CollapseList'
import { SettingListPanel } from '../components/SettingListPanel'
import type { AgentToolInfo, AiToolUsage, AuditEntryInfo, McpServerInfo, McpServerDraft, McpTestResult, SkillInfo, SkillInstallResult } from '../../../types'

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

type AiTab = 'builtin' | 'mcp' | 'skill' | 'models' | 'perms'

/** 设置 → AI 工具：月度用量汇总 + 内置工具清单 + MCP 外部服务器管理 + Skill 提示词资产 */
export function AiToolsView({ initialTab }: { initialTab?: AiTab } = {}) {
  const [tab, setTab] = useState<AiTab>(initialTab ?? 'builtin')
  // 深链变化(面板再次"去配置模型"时组件可能仍挂载)同步切换
  useEffect(() => { if (initialTab) setTab(initialTab) }, [initialTab])
  const { s, update } = useSettings()
  const [usage, setUsage] = useState<AiToolUsage>({ used: 0, limit: 0 })

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
        {([
          ['builtin', '内置工具', <Bot key="b" size={14} />],
          ['mcp', 'MCP', <Server key="m" size={14} />],
          ['skill', 'Skill', <Sparkles key="s" size={14} />],
          ['models', '模型', <Cpu key="c" size={14} />],
          ['perms', '权限', <ShieldCheck key="p" size={14} />],
        ] as const).map(([id, label, icon]) => (
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

      {/* 汇总条 */}
      <div data-setting-anchor="aiTools.usage">
        <UsageSummary usage={usage} />
      </div>

      {/* F-12 遗留收口（2026-10-07）：AI 助手对话显示设置。键早已通用化（AI 教学与 AI 对话共用口径），
          控件原滞留在「AI教学」设置页且 ui:false 搜不到；迁入本小节常显。
          放在页签区之外（汇总条与页签内容之间），保证从设置搜索跳锚点时无论当前激活哪个页签都能滚到。 */}
      <div data-setting-anchor="aiTools.ctxUsageDetail">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">AI 助手</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          对话输入区的上下文占用指示，AI 教学与 AI 对话共用同一套档位与窗口口径。
        </p>
        <div className="space-y-3 max-w-md">
          <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
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
        </div>
      </div>

      {tab === 'builtin' && <BuiltinToolsTab usage={usage} onUsageChange={setUsage} monthlyLimit={s.aiToolMonthlyLimit ?? 0} />}
      {tab === 'mcp' && <McpServersTab onInvoked={refreshUsage} />}
      {tab === 'skill' && <SkillsTab />}
      {tab === 'models' && <div data-setting-anchor="aiTools.models"><AiModelsTab /></div>}

      {tab === 'perms' && <div data-setting-anchor="aiTools.perms"><AiPermissionsTab /></div>}
    </div>
  )
}

// ===== 汇总条 =====

function UsageSummary({ usage }: { usage: AiToolUsage }) {
  const pct = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0
  const overLimit = usage.limit > 0 && usage.used >= usage.limit
  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">工具调用量</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-4">
        本自然月内所有 AI 工具调用次数（内置工具与 MCP 外部工具均计入）。
      </p>
      <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md">
        <div className="flex items-center justify-between text-[13px]">
          <span className="flex items-center gap-2 text-[var(--text-primary)]">
            <Gauge size={14} className="text-[var(--accent)]" />
            本月调用
          </span>
          <span className={`tabular-nums ${overLimit ? 'text-red-400' : 'text-[var(--text-secondary)]'}`}>
            {usage.used} / {usage.limit > 0 ? usage.limit : '不限'}
          </span>
        </div>
        {usage.limit > 0 && (
          <div className="mt-2 h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${overLimit ? 'bg-red-500' : 'bg-[var(--accent)]'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ===== 内置工具页签 =====

function BuiltinToolsTab({ usage, onUsageChange, monthlyLimit }: {
  usage: AiToolUsage
  onUsageChange: (u: AiToolUsage) => void
  monthlyLimit: number
}) {
  const { s, update } = useSettings()
  const [tools, setTools] = useState<AgentToolInfo[]>([])
  const [recentAudit, setRecentAudit] = useState<AuditEntryInfo[]>([])
  const [loading, setLoading] = useState(true)
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

  const pct = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0

  return (
    <div className="space-y-8">
      {/* 月度上限 */}
      <div data-setting-anchor="aiTools.monthlyLimit">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">月度调用上限</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          达到上限后调用将被拒绝，0 表示不限制。
        </p>
        <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md">
          <span className="text-[13px] text-[var(--text-primary)]">每月最多调用次数</span>
          <input
            type="number"
            min={0}
            value={String(monthlyLimit)}
            onChange={e => {
              const n = Math.max(0, Math.floor(Number(e.target.value) || 0))
              void update('aiToolMonthlyLimit', n)
              onUsageChange({ ...usage, limit: n })
            }}
            className="w-24 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] text-right outline-none focus:border-[var(--accent)]"
          />
        </label>
        {usage.limit > 0 && (
          <div className="mt-2 h-1 rounded-full bg-[var(--bg-hover)] overflow-hidden max-w-md">
            <div className="h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {/* Agent 循环预算（轮数 / token 预算 / 上下文裁剪；Agent 第 0+2 层） */}
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
  const [dragOver, setDragOver] = useState(false)
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

  const handleInstallBuffer = async (data: ArrayBuffer, name: string) => {
    setInstalling(true)
    try {
      await finishInstall(await aiToolsInstallSkill(new Uint8Array(data), name), name)
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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.zip')) {
      showToast({ type: 'error', message: '仅支持 .zip 格式的 Skill 包' })
      return
    }
    const reader = new FileReader()
    reader.onload = () => { void handleInstallBuffer(reader.result as ArrayBuffer, file.name) }
    reader.onerror = () => showToast({ type: 'error', message: '读取文件失败' })
    reader.readAsArrayBuffer(file)
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
            声明式提示词资产，AI 助手会引用它们。可拖入 zip 独立安装，或来自插件贡献。
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => { void refresh() }} title="刷新"
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            <RefreshCw size={14} />
          </button>
          <button onClick={() => { void handlePickFile() }} disabled={installing}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
            {installing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            安装 Skill
          </button>
          <button onClick={() => window.dispatchEvent(new CustomEvent('plugins:open'))}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            <Store size={13} /> 去插件市场
          </button>
        </div>
      </div>

      {/* 拖拽安装区 */}
      <div
        onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
        onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
        onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }}
        onDrop={handleDrop}
        onClick={() => { void handlePickFile() }}
        className={`mt-4 max-w-md rounded-lg border-2 border-dashed px-4 py-5 text-center cursor-pointer transition-colors ${
          dragOver
            ? 'border-[var(--accent)] bg-[var(--bg-selected)]'
            : 'border-[var(--border-color)] hover:border-[var(--text-disabled)]'
        }`}
      >
        <div className="flex flex-col items-center gap-1.5">
          <Upload size={20} className={dragOver ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
          <p className="text-[12px] text-[var(--text-secondary)]">
            {installing ? '安装中…' : dragOver ? '释放以安装' : '拖入 Skill 包（.zip）到此处，或点击选择文件'}
          </p>
          <p className="text-[11px] text-[var(--text-muted)]">
            支持 SKILL.md 或 skill.json 格式（详见帮助文档）
          </p>
        </div>
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
            暂无已装 Skill。拖入 zip 独立安装，或安装含 skills 贡献的插件包（官方示例：AI 技能包）。
          </p>
        )}
      </div>
    </div>
  )
}
