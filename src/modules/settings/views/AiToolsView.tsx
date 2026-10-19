import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { Bot, Gauge, RefreshCw, ShieldCheck, Plus, Plug, Trash2, AlertTriangle, Loader2, Sparkles, Store, Copy, Cpu, Upload, MessageSquare, BarChart3, GraduationCap, FolderOpen } from 'lucide-react'
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
import { AiToolsAdvanced } from './AiToolsAdvanced'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { HelpHint } from '../../../components/shared/HelpHint'
import { AiPermissionsTab } from './AiPermissionsTab'
import { SettingsGroup } from '../components/SettingsGroup'
import { MenuItem, MenuSep, RowMenuButton } from '../components/RowMenu'
import { SettingListPanel } from '../components/SettingListPanel'
import { SETTINGS, resetKeysForTab, defaultOf } from '../../../lib/settings'
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
 * 设置 → AI：一个页签一个域 —— 模型 / 权限 / 工具 / 对话 / 用量 / 教学。
 * 默认落在「模型」：AI 设置里最先要配的就是模型，旧默认是「内置工具」（只读清单，看完就没事干了）。
 */
export function AiToolsView({ initialTab }: { initialTab?: AiTab } = {}) {
  const { update } = useSettings()
  const [tab, setTab] = useState<AiTab>(initialTab ?? 'models')
  // 深链变化(面板再次"去配置模型"时组件可能仍挂载)同步切换
  useEffect(() => { if (initialTab) setTab(initialTab) }, [initialTab])
  /**
   * 「复位」：把**当前页签**的设置恢复为默认值。
   * 范围规则在 lib/settings.ts 的 resetKeysForTab（纯函数，契约真跑）—— 两条硬规矩：
   * 只动本页签的键；`level:'danger'` 的键一律不参与（安全边界不能被"恢复默认"顺手放开）。
   * 因此权限页会算出空范围，按钮置灰并说明原因。
   */
  const [confirmReset, setConfirmReset] = useState(false)
  const resetKeys = resetKeysForTab(tab)
  const doReset = () => {
    if (!confirmReset) { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 3000); return }
    for (const k of resetKeys) void update(k as keyof typeof SETTINGS, defaultOf(k) as never)
    setConfirmReset(false)
    showToast({ type: 'info', message: `已把本页 ${resetKeys.length} 项恢复为默认值` })
  }
  useEffect(() => { setConfirmReset(false) }, [tab])
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
      {/* 页签 + 复位（复位只作用于**当前页签**；安全开关不参与，见 settings.ts 的 resetKeysForTab） */}
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
        <button
          onClick={doReset}
          disabled={resetKeys.length === 0}
          title={resetKeys.length === 0
            ? '本页只有安全开关（终端执行 / 模块权限 / 仓库文件权限），它们不参与复位'
            : `把本页这 ${resetKeys.length} 项恢复为默认值（安全开关不参与）`}
          className={`ml-auto mb-1 px-2.5 py-1 rounded-md text-[11.5px] border transition-colors ${
            confirmReset
              ? 'border-red-500 text-red-400 hover:bg-red-500/10'
              : 'border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          } disabled:opacity-35 disabled:cursor-not-allowed`}>
          {confirmReset ? '再点一次：恢复默认' : '复位'}
        </button>
      </div>

      {/* 每个页签一个域。此前「工具调用量」汇总条与「AI 助手」两块常驻在这里（页签区之外），
          切页签它们纹丝不动 —— 那正是"一个页面糊了好几件事"的来源。现已各自归位：
          工具调用量 → 用量页签；AI 助手/感知/Agent 循环 → 对话页签。 */}
      {tab === 'models' && <div data-setting-anchor="aiTools.models"><AiModelsTab /></div>}

      {tab === 'perms' && <div data-setting-anchor="aiTools.perms"><AiPermissionsTab /></div>}

      {/* 工具页 = 五个折叠分组，行上带计数摘要（2026-10-14）。改造前它们各把整段内容摊开，
          工具页要滚好几屏，而"到底有几个 MCP、几个 Skill"得自己数。 */}
      {tab === 'tools' && (
        <div className="space-y-2">
          <McpServersTab onInvoked={refreshUsage} />
          <SkillsTab />
          <BuiltinToolsTab />
          <SettingsGroup title="高级" summary="LibreOffice · 网页抓取"
            hint="使用频率较低、安装完成后按需配置的选项。"
            anchorIds={['aiTools.sofficePath', 'aiTools.crawlPages', 'aiTools.crawlDelay']}>
            <AiToolsAdvanced />
          </SettingsGroup>
        </div>
      )}

      {tab === 'chat' && <ChatTab mascots={mascots} mascotDiag={mascotDiag} />}

      {tab === 'usage' && <AiUsageTab usage={usage} onUsageChange={setUsage} />}

      {tab === 'teach' && <div data-setting-anchor="aiTools.teach"><AiTeachingView /></div>}
    </div>
  )
}

/* =========================================================================
   通用行（对话页 / 工具页共用）：标签 + ⓘ + 右侧控件
   ========================================================================= */

/**
 * 设置行。改造前每个开关下面都挂一行 11px 常显解释，四组加起来十几行小字 ——
 * 现在解释全部进 ⓘ，行上只剩「标签 + 控件」。行间用分隔线，不再一行一张卡。
 */
function Row({ label, hint, children, divider = true, icon }: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  divider?: boolean
  icon?: ReactNode
}) {
  return (
    <div className={`flex items-center justify-between gap-3 py-2.5 ${divider ? 'border-t border-[var(--border-color)]' : ''}`}>
      <span className="min-w-0 flex items-center gap-1.5 text-[13px] text-[var(--text-primary)]">
        {icon ? <span className="shrink-0 text-[var(--text-muted)]">{icon}</span> : null}
        <span className="truncate">{label}</span>
        {hint ? <HelpHint text={hint} /> : null}
      </span>
      <span className="shrink-0 flex items-center gap-2">{children}</span>
    </div>
  )
}

/** 组内列表的卡片外框（行自带 border-t，所以容器只给内边距） */
const CARD = 'rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5'

/* =========================================================================
   对话页签
   ========================================================================= */

/**
 * 设置 → AI → 对话（2026-10-13 独立成页签；2026-10-14 收成四个折叠分组）。
 *
 * 装的是"对话怎么跑"：回复方式、助手感知与上下文、编辑器续写、Agent 循环预算。
 * 这些原来散在两处 —— 档位/窗口/吉祥物**常驻在页签区之外**（切页签纹丝不动，看着像页面串了域），
 * Agent 循环预算则埋在「内置工具」页签里（去找工具清单的人不会想到预算在这儿）。
 *
 * ★ 每个分组的 `anchorIds` 必须把它内部**每一个**可搜索锚点列全：折叠后内层不挂载，
 *   只声明组头那一个的话，搜「助手深度思考」会滚到一个收起的分组、什么都看不见。
 */
function ChatTab({ mascots, mascotDiag }: {
  mascots: PluginMascotInfo[]
  mascotDiag: { state: 'ok' | 'none' | 'disabled' | 'broken' | 'stale' | 'unavailable'; names: string[] }
}) {
  const { s, update } = useSettings()

  /**
   * 吉祥物那一行的说明分两种，**处理方式不同**（披露规范白名单）：
   *   · 正常态 = 功能说明 →进 ⓘ；
   *   · 读取不到 / 装了没启用 / 没加载起来 = **故障诊断** →常显（收起来等于让人自己猜为什么没角色）。
   */
  const mascotHint = mascots.length > 0
    ? '在含 AI 输入框的界面（对话主区、侧边对话、放大态、支线旁问、日程问答）的输入卡上沿显示所选角色。'
    : '尚未安装吉祥物角色；可在插件市场安装「书桌伙伴 · AI 吉祥物」后选择。'
  const mascotDiagText = mascotDiag.state === 'unavailable'
    ? '无法读取吉祥物清单（插件通道不可用）。若刚更新过版本或处于开发模式，请完整重启应用（开发模式下仅刷新界面不会更新主进程）；若仍无法读取，请将本行信息反馈给开发者。'
    : mascotDiag.state === 'stale'
      ? `已安装并启用了 ${mascotDiag.names.join('、')}，但未能读取角色，通常为主进程版本未同步；请重启应用后重试。`
      : mascotDiag.state === 'disabled'
        ? `已安装 ${mascotDiag.names.join('、')}，但当前未启用；请在 设置 → 插件 中启用后重试。`
        : mascotDiag.state === 'broken'
          ? `有插件未能加载（${mascotDiag.names.join('、')}）；请在 设置 → 插件 中查看其报错（文件缺失或清单校验未通过）。`
          : null

  return (
    <div className="space-y-2">
      {/* 回复方式（2026-10-13 按原型从「模型」页归位到这里）：
          它管的是"AI 怎么回"，不是"用哪个模型" —— 留在模型页就是混域。 */}
      <div data-setting-anchor="aiTools.stream">
        <SettingsGroup title="回复方式" summary="流式输出 · 思考过程"
          anchorIds={['aiTools.stream', 'aiTools.thinking']}>
          <div className={CARD}>
            <Row label="流式输出" divider={false}
              hint="逐字输出回复并实时显示工具调用过程；供应商不支持时自动回退。">
              <SettingSwitch checked={s.aiStreamEnabled !== false} onChange={v => { void update('aiStreamEnabled', v) }} aria-label="流式输出" />
            </Row>
            <div data-setting-anchor="aiTools.thinking">
              <Row label="显示思考过程"
                hint="推理模型的思考链以折叠区实时显示；普通模型不返回思考链。">
                <SettingSwitch checked={s.aiShowThinking !== false} onChange={v => { void update('aiShowThinking', v) }} aria-label="显示思考过程" />
              </Row>
            </div>
          </div>
        </SettingsGroup>
      </div>

      <div data-setting-anchor="aiTools.chat">
        <SettingsGroup title="AI 助手" summary="感知 · 上下文 · 吉祥物"
          anchorIds={['aiTools.chat', 'aiTools.perception', 'aiTools.assistantThinking', 'aiTools.ctxUsageDetail', 'aiTools.ctxWindow', 'ai.mascot']}>
          <div className={CARD}>
            {/* 感知模式（2026-10-13）：此前 ui:true 却无 anchor ⇒ 被 schemaKeyItems 静默排除在
                设置搜索之外，只能在 AI 助手面板里点到。现在给出设置页落点。 */}
            <div data-setting-anchor="aiTools.perception">
              <Row label="感知模式（发送前自动检索笔记）" divider={false}
                icon={<Sparkles size={14} />}
                hint="发送前自动检索知识库并注入最相关的笔记；检索在本地完成，不消耗对话 token；未配置向量模型时降级为关键词匹配。">
                <SettingSwitch checked={s.aiAssistantPerception === true} onChange={v => update('aiAssistantPerception', v)} aria-label="AI 助手感知模式" />
              </Row>
            </div>

            <div data-setting-anchor="aiTools.assistantThinking">
              <Row label="助手深度思考" icon={<Sparkles size={14} />}
                hint="让助手在回答前先列要点再给结论；更慢，但长任务上更稳。">
                <SettingSwitch checked={s.assistantThinking !== false} onChange={v => update('assistantThinking', v)} aria-label="助手深度思考" />
              </Row>
            </div>

            <div data-setting-anchor="aiTools.ctxUsageDetail">
              <Row label="占用指示档位" icon={<Gauge size={14} />}
                hint="输入区那一圈上下文占用的显示方式：隐藏 / 只留圆环 / 圆环加文字摘要。">
                <select value={s.ctxUsageDetail || 'compact'} onChange={e => update('ctxUsageDetail', e.target.value)}
                  className="px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                  <option value="off">隐藏</option>
                  <option value="compact">紧凑（上下文圆环）</option>
                  <option value="detailed">详细（圆环+文字摘要）</option>
                </select>
              </Row>
            </div>

            <div data-setting-anchor="aiTools.ctxWindow">
              <Row label="模型上下文窗口（token）" icon={<Cpu size={14} />}
                hint="0 表示不显示圆环、仅保留数字；填写所选模型的上下文窗口（如 128000）后，圆环按占用比例着色。">
                <input type="number" min={0} step={1000} value={s.ctxWindow ?? 0}
                  onChange={e => update('ctxWindow', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  className="w-40 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] text-right outline-none focus:border-[var(--accent)]" />
              </Row>
            </div>

            <div data-setting-anchor="ai.mascot">
              <Row label="吉祥物" icon={<Sparkles size={14} />} hint={mascotHint}>
                <select value={typeof s.aiMascot === 'string' ? s.aiMascot : 'auto'} onChange={e => update('aiMascot', e.target.value)}
                  className="px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                  <option value="auto">自动（用已安装的）</option>
                  <option value="placeholder">内置占位</option>
                  {mascots.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  <option value="off">关闭</option>
                </select>
              </Row>
            </div>
          </div>
          {/* 故障诊断常显（披露规范白名单③） */}
          {mascotDiagText && (
            <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-amber-400/90">{mascotDiagText}</p>
          )}
        </SettingsGroup>
      </div>

      {/* 编辑器续写（2026-10-13 按原型从「模型」页归位）：
          开关与"自动触发"属"怎么跑"，模型槽位在「模型 → 哪个场景用哪个模型」里。 */}
      <div data-setting-anchor="aiTools.inlineSuggest">
        <SettingsGroup title="编辑器续写" summary="内联建议 · 自动触发"
          hint="打字停顿后由 AI 续写下一句，以浅灰提示文字呈现。Tab 采纳、Esc 拒绝、Alt+A 立即请求；调用频率较高，建议在「模型」页签中单独指定成本较低、响应较快的模型。"
          anchorIds={['aiTools.inlineSuggest', 'aiTools.inlineSuggestAuto']}>
          <div className={CARD}>
            <Row label="启用内联建议" divider={false}>
              <SettingSwitch checked={s.aiAssistantInlineSuggest !== false} onChange={v => { void update('aiAssistantInlineSuggest', v) }} aria-label="启用内联建议" />
            </Row>
            <div data-setting-anchor="aiTools.inlineSuggestAuto"
              className={s.aiAssistantInlineSuggest === false ? 'opacity-40 pointer-events-none select-none' : ''}>
              <Row label="自动触发（停 0.8 秒出建议）"
                hint="仅在自然断点（句读、换行、写完一个词）发起；连续多次未采纳将自动暂停。">
                <SettingSwitch checked={s.aiAssistantInlineSuggestAuto !== false} onChange={v => { void update('aiAssistantInlineSuggestAuto', v) }} aria-label="自动触发" />
              </Row>
            </div>
          </div>
        </SettingsGroup>
      </div>

      <div data-setting-anchor="aiTools.agentLoop">
        <AgentLoopGroup />
      </div>
    </div>
  )
}

/**
 * Agent 循环预算（轮数 / 花费 / 上下文裁剪；Agent 第 0+2 层）。原埋在「内置工具」页签里。
 *
 * ⚠ 这几行的 ⓘ 文案**不许**照抄 `SETTINGS` 里那几条口语搜索别名（"最多思考几轮 / 带多少历史"
 * 那种说法）—— 契约 §9 的负向断言查的就是「视图里不得出现口语标签」，别名只活在设置搜索的关键词里。
 * 连注释里都别写全（这一行原本就是把这个别名原样抄了一遍，直接把负向断言写红了）。
 */
function AgentLoopGroup() {
  const { s, update } = useSettings()
  const agentMaxRounds = s.agentMaxRounds ?? 16
  const agentRunTokenBudget = s.agentRunTokenBudget ?? 500000
  const agentContextBudgetTokens = s.agentContextBudgetTokens ?? 24000
  const agentCompressionEnabled = s.agentCompressionEnabled !== false
  const agentCompressAtPercent = s.agentCompressAtPercent ?? 80
  const numCls = 'w-24 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] text-right outline-none focus:border-[var(--accent)]'

  return (
    <SettingsGroup title="Agent 循环" summary="轮数 · 预算 · 压缩"
      hint="控制单次任务的成本与深度：思考轮数或累计 token 达到上限后自动总结收场，不丢弃已获取的信息；相互独立的工具调用会并发执行。"
      anchorIds={['aiTools.agentLoop']}>
      <div className={CARD}>
        <Row label="最大推理轮数" divider={false}
          hint="达到上限后自动总结收场，不丢弃已经拿到的信息。">
          <input type="number" min={2} max={64} value={String(agentMaxRounds)}
            onChange={e => { void update('agentMaxRounds', Math.min(64, Math.max(2, Math.floor(Number(e.target.value) || 16)))) }}
            className={numCls} />
        </Row>
        <Row label="单次 token 预算"
          hint="单次任务累计消耗上限（输入 + 输出）；到达后自动总结收场。">
          <input type="number" min={0} step={50000} value={String(agentRunTokenBudget)}
            onChange={e => { void update('agentRunTokenBudget', Math.max(0, Math.floor(Number(e.target.value) || 0))) }}
            className={numCls} />
        </Row>
        <Row label="历史上下文预算"
          hint="决定发送给模型的历史消息量，0 表示不裁剪（长会话成本增长较快）。">
          <input type="number" min={0} step={2000} value={String(agentContextBudgetTokens)}
            onChange={e => { void update('agentContextBudgetTokens', Math.max(0, Math.floor(Number(e.target.value) || 0))) }}
            className={numCls} />
        </Row>
        <Row label="自动压缩触发线"
          hint="历史用量达到这个百分比时触发压缩：先把较早的对话压缩成纪要再发送。">
          <div className="flex items-center gap-1.5">
            <input type="number" min={50} max={100} step={5} value={String(agentCompressAtPercent)}
              onChange={e => { void update('agentCompressAtPercent', Math.min(100, Math.max(50, Math.floor(Number(e.target.value) || 80)))) }}
              className={numCls} />
            <span className="text-[12px] text-[var(--text-muted)]">%</span>
          </div>
        </Row>
        <Row label="历史自动压缩"
          hint="关闭后不再自动总结；历史超出上面的预算时会被优先丢弃。也可在聊天框输入 /compress 手动总结。">
          <SettingSwitch checked={agentCompressionEnabled} onChange={v => { void update('agentCompressionEnabled', v) }} aria-label="历史自动压缩" />
        </Row>
      </div>
    </SettingsGroup>
  )
}

/* =========================================================================
   工具页签 · 内置工具 + 最近调用
   ========================================================================= */

/** 只读的内置工具清单与最近调用记录。月度上限在「用量」页签、Agent 循环预算在「对话」页签。 */
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
    <>
      {/* 内置工具：只读清单，用带搜索的下拉（`SettingListPanel` 的 popover 形态）——
          52 个工具平铺会把折叠组撑成一面墙，选项面板里可搜索、可滚动才用得住。
          说明（"只读、不可关闭"）从面板标题下挪到分组标题的 ⓘ 上。 */}
      <div data-setting-anchor="aiTools.builtin">
        <SettingsGroup title="内置工具" summary={`${tools.length} 项 · 只读`}
          hint="官方提供的只读工具，不可关闭，以保证调用透明。列表只读，逐条说明见选中项下方。"
          headerRight={
            <button onClick={() => { void refresh() }} title="刷新" aria-label="刷新内置工具"
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <RefreshCw size={14} />
            </button>
          }
          anchorIds={['aiTools.builtin']}>
          <SettingListPanel
            display="popover"
            anchorId="aiTools.builtin"
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
        </SettingsGroup>
      </div>

      {/* 最近调用 */}
      <div data-setting-anchor="aiTools.audit">
        <SettingsGroup title="最近调用" summary={`${recentAudit.length} 条`}
          hint="最近 10 条审计记录（含入参摘要与耗时）。"
          anchorIds={['aiTools.audit']}>
          <div className={`${CARD} py-1`}>
            {recentAudit.map(e => <AuditRow key={e.id} entry={e} />)}
            {recentAudit.length === 0 && (
              <p className="py-2 text-[12px] text-[var(--text-muted)]">暂无调用记录</p>
            )}
          </div>
        </SettingsGroup>
      </div>
    </>
  )
}

function AuditRow({ entry }: { entry: AuditEntryInfo }) {
  let d: Record<string, unknown> = {}
  try { d = JSON.parse(entry.detail) } catch { /* ignore */ }
  return (
    <div className="flex items-center gap-2 py-1.5 border-t border-[var(--border-color)] first:border-t-0 text-[11px]" title={entry.action}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${d.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
      <code className="text-[var(--text-secondary)] truncate">{String(d.tool ?? entry.action)}</code>
      <span className="ml-auto text-[var(--text-disabled)] tabular-nums shrink-0">
        {typeof d.durationMs === 'number' ? `${d.durationMs}ms` : ''} · {entry.createdAt}
      </span>
    </div>
  )
}

/* =========================================================================
   MCP 服务器
   ========================================================================= */

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

/**
 * MCP 服务器（2026-10-14 收成一行一物）。
 *
 * 改造前每台服务器是一张卡：标题行 + 地址行 + 错误行 + 两个常驻按钮。
 * 现在一行 = 状态点 + 名称 + 连接方式 + 工具数 + ⋯ + 开关；地址与命令进 ⓘ 与 `title`，
 * 「刷新工具 / 删除」进 ⋯。错误仍**常显**（披露规范白名单③ 故障诊断）。
 */
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
    else showToast({ type: 'info', message: `检测到 ${r.tools.length} 个工具` })
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

  const connected = servers.filter(sv => sv.enabled).length

  return (
    <div data-setting-anchor="aiTools.mcp">
      <SettingsGroup title="MCP 服务器" summary={`${servers.length} 个 · 已连接 ${connected}`}
        hint={<>连接外部 MCP 服务器，其工具并入统一注册表；最多同时连接 {servers[0]?.maxConnections ?? 5} 个。</>}
        headerRight={
          <>
            <button onClick={() => { void refresh() }} title="刷新" aria-label="刷新 MCP 列表"
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <RefreshCw size={14} />
            </button>
            <button onClick={() => setWizardOpen(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">
              <Plus size={13} /> 添加服务器
            </button>
          </>
        }
        anchorIds={['aiTools.mcp']}>
        <div className={CARD}>
          {servers.map(sv => (
            <div key={sv.id} className="flex items-center gap-2 py-2.5 border-t border-[var(--border-color)] first:border-t-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass(sv.status)}`} title={sv.status} />
              <span className="text-[13px] text-[var(--text-primary)] truncate" title={sv.endpointPreview}>{sv.name}</span>
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)]">
                {TRANSPORT_BADGE[sv.transport]}
              </span>
              <HelpHint text={<>连接方式：{TRANSPORT_BADGE[sv.transport]}<br />{sv.transport === 'stdio' ? '命令' : '地址'}：<code>{sv.endpointPreview}</code></>} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">{sv.toolCount} 个工具</span>
              <span className="shrink-0 flex items-center gap-1">
                <RowMenuButton label={`「${sv.name}」操作`}>
                  <MenuItem onClick={() => { void handleRefreshTools(sv) }}>
                    <RefreshCw size={11} /> 刷新工具
                  </MenuItem>
                  <MenuSep />
                  <MenuItem danger onClick={() => { void handleRemove(sv) }}>
                    <Trash2 size={11} /> {confirmingId === sv.id ? '再点一次：删除服务器' : '删除服务器'}
                  </MenuItem>
                </RowMenuButton>
                <SettingSwitch checked={sv.enabled} aria-label={`启用 ${sv.name}`} onChange={() => { void handleToggle(sv) }} />
              </span>
            </div>
          ))}
          {!loading && servers.length === 0 && (
            <p className="py-2.5 text-[12px] text-[var(--text-muted)]">尚未添加 MCP 服务器。点击右上角「添加服务器」即可开始。</p>
          )}
        </div>
        {/* 连接失败要常显：它是故障诊断，不是可以藏起来的说明 */}
        {servers.filter(sv => sv.status === 'error' && sv.lastError).map(sv => (
          <p key={sv.id} className="mt-1.5 px-1 text-[11px] leading-relaxed text-red-400" title={sv.lastError ?? ''}>
            「{sv.name}」连接失败：{sv.lastError}
          </p>
        ))}
      </SettingsGroup>

      {wizardOpen && (
        <AddServerWizard
          onClose={() => setWizardOpen(false)}
          onSaved={async () => { setWizardOpen(false); await refresh() }}
        />
      )}
    </div>
  )
}

// ===== 三步添加向导（中央模态：这一步要连续填三项并做安全确认，属"多步表单"，
// 按 docs/ui-interaction-patterns.md 仍是允许模态的形态；存量模态本轮不回改） =====

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
      showToast({ type: 'info', message: `「${sv.name}」已保存（默认为禁用状态，开启开关后连接）` })
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
                    <input value={command} onChange={e => setCommand(e.target.value)} placeholder="例如 node、npx 或服务端脚本的绝对路径"
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
                保存后服务器处于<b>禁用</b>状态，需在列表中开启开关后才会连接。
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

/* =========================================================================
   Skill 技能
   ========================================================================= */

/** 安装方式的说明。空态时**常显**（披露规范白名单① 空态即引导），有内容时进分组 ⓘ。 */
const SKILL_INSTALL_HINT = '安装方式：选择 Skill 自身的文件夹（内含 SKILL.md 或 skill.json）即可，无需预先打包；若所选文件夹包含多个 Skill，将要求指定其中一个。'

/**
 * Skill 技能（2026-10-14 收成一行一物）。
 *
 * 改造前每条 Skill 是一张卡：标题行 + 描述一段 + 依赖工具一行 + 两个常驻按钮，
 * 装三五个就把页面撑满。现在一行 = 名称 + 来源 + 状态 + ⋯ + 开关；
 * 描述与依赖工具进 ⓘ（**一字不删**，只是不再常驻）。
 * 安装三个入口上移到分组标题行右侧（它们是"这个域"的动作，不是某一行的动作）。
 */
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
      showToast({ type: 'info', message: `「${r.skill?.title ?? installingName ?? 'Skill'}」已安装，AI 助手可立即使用` })
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

  const enabled = skills.filter(s => !s.disabled).length

  return (
    <div data-setting-anchor="aiTools.skill">
      <SettingsGroup title="Skill 技能" summary={`${skills.length} 个 · 已启用 ${enabled}`}
        hint={`声明式提示词资产，AI 助手会引用。可装 Skill 文件夹或 .zip 包，也可来自插件贡献。${SKILL_INSTALL_HINT}`}
        headerRight={
          <>
            <button onClick={() => { void refresh() }} title="刷新" aria-label="刷新 Skill 列表"
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
          </>
        }
        anchorIds={['aiTools.skill']}>
        <div className={CARD}>
          {skills.map(s => (
            <div key={s.registryName} className={`flex items-center gap-2 py-2.5 border-t border-[var(--border-color)] first:border-t-0 ${s.disabled ? 'opacity-60' : ''}`}>
              <Sparkles size={14} className={`shrink-0 ${s.disabled ? 'text-[var(--text-disabled)]' : 'text-[var(--accent)]'}`} />
              <span className="text-[13px] text-[var(--text-primary)] truncate">{s.title}</span>
              <HelpHint text={<>
                {s.description || '（该 Skill 没有写描述）'}
                {s.tools.length > 0 && <><br />依赖工具：{s.tools.join('、')}</>}
              </>} />
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)]">
                {s.source === 'standalone' ? '独立安装' : s.pluginName}
              </span>
              {s.disabled && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-zinc-500/40 text-[var(--text-disabled)]">已停用</span>
              )}
              <span className="ml-auto shrink-0 flex items-center gap-1">
                <RowMenuButton label={`「${s.title}」操作`}>
                  <MenuItem onClick={() => { void handleCopy(s) }}>
                    <Copy size={11} /> 复制提示词
                  </MenuItem>
                  {s.source === 'standalone' && (
                    <>
                      <MenuSep />
                      <MenuItem danger onClick={() => { void handleUninstall(s) }}>
                        <Trash2 size={11} /> {confirmingId === s.id ? '再点一次：卸载' : '卸载 Skill'}
                      </MenuItem>
                    </>
                  )}
                </RowMenuButton>
                <SettingSwitch checked={!s.disabled} aria-label={`${s.disabled ? '启用' : '停用'} ${s.title}`} onChange={() => { void handleToggle(s) }} />
              </span>
            </div>
          ))}
          {!loading && skills.length === 0 && (
            <p className="py-2.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
              暂无已安装的 Skill。{SKILL_INSTALL_HINT}
              也可安装含 skills 贡献的插件包（官方示例：AI 技能包）。
            </p>
          )}
        </div>
      </SettingsGroup>
    </div>
  )
}
