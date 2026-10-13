import { useEffect, useState, useCallback } from 'react'
import { Bot, Plus, Trash2, RefreshCw, Loader2, Star, Pencil, Import } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { Collapsible } from '../../../components/shared/Collapsible'
import {
  llmListProviders, llmSaveProvider, llmRemoveProvider, llmToggleProvider,
  llmTestConnection, llmRefreshModels, llmSetDefaultModel, llmAddModel, llmTestModel,
  llmCcSwitchList, llmCcSwitchImport, openExternal, aiTeachSrcSofficeProbe,
  llmSetModelFamily,
} from '../../../lib/ipc'
import type { LlmProviderInfo, LlmProviderType, LlmModelFamily, LlmTestResultInfo, LlmModelTestResultInfo, CcSwitchItem } from '../../../types'
import { prettyModelName, isOpenCodeFree, familyHintOf } from '../../../lib/modelNames'

/** 免费=用户手动标记 ∪ id 含 free（上游不提供该元数据，双轨启发式） */
export function parseFreeSet(raw: string): Set<string> {
  try {
    const arr = JSON.parse(raw || '[]')
    return new Set(Array.isArray(arr) ? arr.map((x: unknown) => String(x)) : [])
  } catch { return new Set() }
}

export function isFreeModel(modelId: string, custom: Set<string>): boolean {
  if (custom.has(modelId)) return true
  return /(^|[-._])free([-._]|$)/i.test(modelId)
}

const TYPE_LABEL: Record<LlmProviderType, string> = {
  'openai-compatible': 'OpenAI 兼容',
  ollama: 'Ollama 本地',
  anthropic: 'Anthropic',
  'openai-responses': 'OpenAI Responses',
}

/** 供应商 type → 默认协议族（与主进程 FAMILY_BY_TYPE 同口径；ollama 无协议族概念） */
const FAMILY_BY_TYPE: Partial<Record<LlmProviderType, LlmModelFamily>> = {
  'openai-compatible': 'chat',
  'openai-responses': 'responses',
  anthropic: 'messages',
}

const FAMILY_LABEL: Record<LlmModelFamily, string> = {
  chat: '对话补全',
  messages: 'Messages',
  responses: 'Responses',
}

/** 某模型实际走哪个协议：逐模型覆盖优先，其次跟随供应商默认 */
function effectiveFamily(p: LlmProviderInfo, model: string): LlmModelFamily | null {
  return p.modelFamilies?.[model] ?? FAMILY_BY_TYPE[p.type] ?? null
}

/**
 * 已知的 opencode 旧地址 → 官方地址（2026-10-13）。
 * 官方文档给的 Go 端点是 `https://opencode.ai/inference/go/v1`；旧地址还能用，但模型清单
 * 与官方差 10 个（旧清单没有 glm-5.1 / claude-haiku-5-5 / qwen3.7-max 等）。
 * 不自动改用户正在用的地址 —— 万一新地址不认这把 Key 会当场用不了，所以只给一个行内按钮。
 */
const LEGACY_BASE_URL: Record<string, string> = {
  'https://opencode.ai/zen/go/v1': 'https://opencode.ai/inference/go/v1',
  'https://opencode.ai/zen/go': 'https://opencode.ai/inference/go/v1',
}

/** 归一化后查旧地址表（忽略结尾斜杠与大小写） */
function officialUrlFor(baseUrl: string): string | null {
  const key = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  return LEGACY_BASE_URL[key] ?? null
}

/** soffice 探测命中来源 → 可读文案（对应 main 侧 SofficeSource） */
const SOFFICE_SOURCE_LABEL: Record<string, string> = {
  setting: '此处填写的路径',
  env: '环境变量 SOFFICE_PATH',
  registry: 'Windows 注册表（安装器写入）',
  candidate: '常见安装位置',
  path: '系统 PATH',
}

/** 设置 → AI 工具 → 模型：供应商管理 + 默认模型 + token 预算 */
export function AiModelsTab() {
  const { s, update } = useSettings()
  const [providers, setProviders] = useState<LlmProviderInfo[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [ccsOpen, setCcsOpen] = useState(false)
  // 模型级可用性测试(选中具体模型后实测,区别于供应商探活)
  const [modelTesting, setModelTesting] = useState(false)
  const [modelTestResult, setModelTestResult] = useState<LlmModelTestResultInfo | null>(null)
  // LibreOffice 探测结果：纯即时反馈，不持久化（路径本身存在设置里）
  const [sofficeProbe, setSofficeProbe] = useState<{ ok: boolean; path?: string; source?: string } | null>(null)
  const [sofficeTesting, setSofficeTesting] = useState(false)

  const testSoffice = async () => {
    if (sofficeTesting) return
    setSofficeTesting(true)
    try {
      setSofficeProbe(await aiTeachSrcSofficeProbe(s.sofficePath ?? ''))
    } catch (e) {
      showToast({ type: 'error', message: `检测失败：${(e as Error).message}` })
    } finally {
      setSofficeTesting(false)
    }
  }

  const testSelectedModel = async () => {
    if (!defaultModel || modelTesting) return
    const idx = defaultModel.indexOf(':')
    const providerId = defaultModel.slice(0, idx)
    const model = defaultModel.slice(idx + 1)
    if (!providerId || !model) return
    setModelTesting(true)
    setModelTestResult(null)
    try {
      setModelTestResult(await llmTestModel(providerId, model))
    } finally {
      setModelTesting(false)
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await llmListProviders()
      setProviders(r.providers)
      setDefaultModel(r.defaultChatModel)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const freeSet = parseFreeSet(s.aiFreeModelIds ?? '[]')

  return (
    <div className="space-y-8">
      {/* 对话输出（docs/ai-streaming-design.md §5.4） */}
      <div data-setting-anchor="aiTools.stream">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">对话输出</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">AI 回复的输出方式与过程展示。</p>
        <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md space-y-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] text-[var(--text-primary)]">流式输出</div>
              <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">回复逐字输出并实时显示工具调用过程；供应商不支持时自动回退</div>
            </div>
            <SettingSwitch checked={s.aiStreamEnabled !== false} onChange={v => { void update('aiStreamEnabled', v) }} aria-label="流式输出" />
          </div>
          <div data-setting-anchor="aiTools.thinking" className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] text-[var(--text-primary)]">显示思考过程</div>
              <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">推理模型的思考链以折叠区实时显示；普通模型没有思考链，自动不出现</div>
            </div>
            <SettingSwitch checked={s.aiShowThinking !== false} onChange={v => { void update('aiShowThinking', v) }} aria-label="显示思考过程" />
          </div>
          {/* 单次 maxTokens（原在「Token 用量」卡里，随统计一起搬走时留在这里更贴题：它管的是输出长度） */}
          <div className="flex items-center justify-between gap-3 pt-1 border-t border-[var(--border-color)]">
            <div className="min-w-0">
              <div className="text-[13px] text-[var(--text-primary)]">单次输出上限</div>
              <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">单次调用最多生成多少 token（256 ~ 32768），越小越省费用</div>
            </div>
            <input type="number" min={256} max={32768} value={String(s.llmMaxTokens ?? 4096)}
              onChange={e => { void update('llmMaxTokens', Math.min(32768, Math.max(256, Math.floor(Number(e.target.value) || 4096)))) }}
              className="w-28 shrink-0 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-right outline-none focus:border-[var(--accent)]" />
          </div>
        </div>
      </div>

      {/* LibreOffice 路径：pptx 视觉转写的前置（原 ui:false 无任何入口，只能手改 settings.json） */}
      <div data-setting-anchor="aiTools.sofficePath">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">LibreOffice 路径</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">AI 教学素材的 pptx 视觉转写需先经本机 LibreOffice 转 PDF。留空 = 自动探测（注册表 / 常见安装位 / PATH）；装在自定义目录（如 D 盘）时手动填写 soffice.exe 绝对路径。</p>
        <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md">
          <div className="flex items-center gap-2">
            <input
              value={s.sofficePath ?? ''}
              onChange={e => { void update('sofficePath', e.target.value); setSofficeProbe(null) }}
              placeholder="D:\tools\LibreOffice\program\soffice.exe"
              spellCheck={false}
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-[var(--accent)]"
            />
            <button onClick={() => { void testSoffice() }} disabled={sofficeTesting}
              className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50">
              {sofficeTesting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 检测
            </button>
          </div>
          {sofficeProbe
            ? (
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
                {sofficeProbe.ok
                  ? <>已找到：<span className="text-[var(--text-secondary)] break-all">{sofficeProbe.path}</span>（来源：{SOFFICE_SOURCE_LABEL[sofficeProbe.source ?? ''] ?? sofficeProbe.source}）</>
                  : '未找到：确认已安装 LibreOffice，或在上方填入 soffice.exe 完整路径后重新检测'}
              </p>
            )
            : <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">点「检测」立即验证路径可用性 —— 刚装完或刚改路径都无需重启应用。</p>}
        </div>
      </div>

      {/* 供应商列表 */}
      <div>
        <div className="flex items-center justify-between max-w-md">
          <h2 className="text-[15px] font-medium text-[var(--text-primary)]">模型供应商</h2>
          <div className="flex items-center gap-1">
            <button onClick={() => setCcsOpen(true)} title="从 CC Switch 配置一键导入"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <Import size={13} /> CC Switch 导入
            </button>
            <button onClick={() => setEditing(v => !v)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">
              {editing ? <Pencil size={13} /> : <Plus size={13} />} 手动添加
            </button>
          </div>
        </div>

        {/* 新增服务商表单展开动效（docs/ui-animation-plan.md C 类） */}
        <Collapsible open={editing} innerClassName="">{() => <ProviderForm onDone={async () => { setEditing(false); await refresh() }} />}</Collapsible>

      {ccsOpen && (
        <CcSwitchImportModal
          onClose={() => setCcsOpen(false)}
          onImported={async () => { setCcsOpen(false); await refresh() }}
        />
      )}

        <div className="space-y-2 mt-4 max-w-md">
          {providers.map(p => (
            <ProviderCard key={p.id} p={p} onChanged={refresh}
              onSetDefault={async () => {
                const firstModel = p.models[0] ?? ''
                await llmSetDefaultModel(firstModel ? `${p.id}:${firstModel}` : '')
                await refresh()
              }} />
          ))}
          {!loading && providers.length === 0 && (
            <p className="text-[12px] text-[var(--text-muted)] px-1 leading-relaxed">
              尚未配置供应商。推荐本机安装 <b>CC Switch</b> 后点上方「CC Switch 导入」一键带入（Key 自动加密）；
              也可「手动添加」填 OpenAI 兼容接口（DeepSeek / Moonshot / Qwen / GLM 等）或本地 Ollama。
            </p>
          )}
        </div>
      </div>

      {/* 免费模型标记 */}
      <FreeModelMarker providers={providers} />

      {/* 默认模型 */}
      {providers.some(p => p.enabled && p.models.length > 0) && (
        <div>
          <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">默认对话模型</h2>
          <p className="text-[12px] text-[var(--text-muted)] mb-3">未指定模型时使用，选中后可测试可用性。</p>
          <div className="flex items-start gap-2 max-w-md">
            <select value={defaultModel}
              onChange={e => { setModelTestResult(null); void llmSetDefaultModel(e.target.value).then(refresh) }}
              className="flex-1 min-w-0 px-2.5 py-2 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] outline-none focus:border-[var(--accent)]">
              <option value="">未设置</option>
              {providers.filter(p => p.enabled).flatMap(p =>
                p.models.map(m => {
                  const free = isFreeModel(m, freeSet)
                  return <option key={`${p.id}:${m}`} value={`${p.id}:${m}`}>{free ? '[免费] ' : ''}{prettyModelName(m)}{free ? '' : ` · ${m}`}</option>
                })
              )}
            </select>
            <button onClick={() => void testSelectedModel()} disabled={!defaultModel || modelTesting}
              title="对该模型发送一次最小补全请求,验证其真实可用"
              className="shrink-0 flex items-center gap-1 px-2.5 py-2 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
              {modelTesting && <Loader2 size={12} className="animate-spin" />}
              {modelTesting ? '测试中…' : '测试模型'}
            </button>
          </div>
          {modelTestResult && (
            <p className={`text-[11px] mt-1.5 ${modelTestResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {modelTestResult.ok
                ? `✓ 模型可用（${modelTestResult.latencyMs}ms${modelTestResult.replyPreview ? `,回复「${modelTestResult.replyPreview}」` : ''}）`
                : `✗ ${modelTestResult.error}`}
            </p>
          )}
        </div>
      )}

      {/* AI 内联建议（B4）：原在「编辑器」设置页，2026-09-20 反馈迁来模型页统一管理 */}
      {providers.some(p => p.enabled && p.models.length > 0) && (
        <div data-setting-anchor="editor.inlineSuggest">
          <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">AI 内联建议（编辑器）</h2>
          <p className="text-[12px] text-[var(--text-muted)] mb-3">
            打字停顿后由 AI 续写下一句（灰色幽灵文字）；Tab 采纳、Esc 拒绝、Alt+A 立即要一条，
            笔记顶栏右侧的 ✨ 可随时开关。调用频次远高于对话，建议单独指定便宜、快的模型。
          </p>
          <label className="flex items-center justify-between gap-4 cursor-pointer max-w-md">
            <span className="text-[13px] text-[var(--text-primary)]">启用内联建议</span>
            <SettingSwitch
              checked={s.aiAssistantInlineSuggest !== false}
              onChange={(v) => update('aiAssistantInlineSuggest', v)}
            />
          </label>
          <div className={`mt-2.5 max-w-md ${s.aiAssistantInlineSuggest === false ? 'opacity-40 pointer-events-none select-none' : ''}`}>
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <span className="text-[13px] text-[var(--text-primary)]">自动触发（停 0.8 秒出建议）</span>
              <SettingSwitch
                checked={s.aiAssistantInlineSuggestAuto !== false}
                onChange={(v) => update('aiAssistantInlineSuggestAuto', v)}
              />
            </label>
            <p className="text-[11px] text-[var(--text-muted)] mt-1.5 mb-3 leading-relaxed max-w-md">
              自动触发只在自然断点（句读、换行、写完一个词之后）发起，词中间不打扰；连续几次建议都没采纳会自动暂停。
            </p>
            <div className="max-w-md">
              <p className="text-[13px] text-[var(--text-primary)] mb-1.5">内联建议模型</p>
              <select
                value={typeof s.aiAssistantInlineSuggestModelId === 'string' ? s.aiAssistantInlineSuggestModelId : ''}
                onChange={e => update('aiAssistantInlineSuggestModelId', e.target.value)}
                className="w-full px-2.5 py-2 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] outline-none focus:border-[var(--accent)]">
                <option value="">跟随全局默认模型（思考型自动换非思考）</option>
                {providers.filter(p => p.enabled).flatMap(p =>
                  p.models.map(m => {
                    const free = isFreeModel(m, freeSet)
                    return <option key={`${p.id}:${m}`} value={`${p.id}:${m}`}>{free ? '[免费] ' : ''}{prettyModelName(m)}{free ? '' : ` · ${m}`}</option>
                  })
                )}
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 逐模型协议面板（2026-10-13）。
 *
 * 存在的理由：opencode Go 官方口径是 "Each model is served by one API family" —— 同一个
 * baseUrl、同一把 Key 下，模型分属 `/chat/completions`、`/messages`、`/responses` 三条路径。
 * 所以协议必须能按模型覆盖；能一键按官方端点表预填，用户就不必手工标 32 个模型。
 */
function ModelFamilyPanel({ p, onChanged }: { p: LlmProviderInfo; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const fallback = FAMILY_BY_TYPE[p.type] ?? null
  const marked = p.models.filter(m => p.modelFamilies?.[m]).length
  const fillable = p.models.filter(m => {
    const h = familyHintOf(m)
    return h != null && p.modelFamilies?.[m] !== h
  })

  /** 一次性写回整份协议映射（比逐条 IPC 少写 30 多次设置文件） */
  const saveFamilies = async (next: Record<string, LlmModelFamily>) => {
    const r = await llmSaveProvider({
      id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl,
      headers: p.headers, modelFamilies: next,
    })
    if (!r.ok) showToast({ type: 'error', message: r.error ?? '协议设置保存失败' })
    await onChanged()
  }

  /** 单条改动走定点 IPC（只动这一个键，不重发整份供应商草稿） */
  const setOne = async (model: string, family: LlmModelFamily | '') => {
    const r = await llmSetModelFamily(p.id, model, family)
    if (!r.ok) showToast({ type: 'error', message: r.error ?? '协议设置失败' })
    await onChanged()
  }

  const fillFromHints = async () => {
    if (busy || fillable.length === 0) return
    setBusy(true)
    try {
      const next = { ...(p.modelFamilies ?? {}) }
      for (const m of fillable) next[m] = familyHintOf(m) as LlmModelFamily
      await saveFamilies(next)
      showToast({ type: 'info', message: `已按官方端点表标记 ${fillable.length} 个模型的协议` })
    } finally { setBusy(false) }
  }

  const clearAll = async () => {
    if (busy || marked === 0) return
    setBusy(true)
    try {
      await saveFamilies({})
      showToast({ type: 'info', message: '已清除协议标记，全部跟随默认协议' })
    } finally { setBusy(false) }
  }

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--text-muted)]">
        <span>
          协议：默认 {fallback ? FAMILY_LABEL[fallback] : 'Ollama 原生'}
          {marked > 0 ? ` · ${marked} 个模型单独指定` : ''}
        </span>
        {fillable.length > 0 && (
          <button onClick={() => { void fillFromHints() }} disabled={busy}
            title="按 opencode Go 官方端点表预填：GPT/Grok 走 Responses、Claude/Qwen/MiniMax 走 Messages，其余走对话补全"
            className="px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
            {busy ? '处理中…' : `按官方端点表标记（${fillable.length}）`}
          </button>
        )}
        {marked > 0 && (
          <button onClick={() => { void clearAll() }} disabled={busy}
            className="px-1.5 py-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            清除标记
          </button>
        )}
        <button onClick={() => setOpen(v => !v)}
          className="px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          {open ? '收起逐模型协议' : '逐模型协议'}
        </button>
      </div>
      <Collapsible open={open} innerClassName="">{() => (
        <div className="mt-2 rounded-md border border-[var(--border-color)] max-h-56 overflow-y-auto">
          {p.models.map(m => {
            const hint = familyHintOf(m)
            return (
              <div key={m} className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--border-color)] last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-[11px] font-mono text-[var(--text-secondary)]" title={m}>{m}</span>
                {hint && (
                  <span className="shrink-0 text-[10px] text-[var(--text-muted)]" title="官方端点表标注的协议">
                    官方 {FAMILY_LABEL[hint]}
                  </span>
                )}
                <select value={p.modelFamilies?.[m] ?? ''}
                  onChange={e => { void setOne(m, e.target.value as LlmModelFamily | '') }}
                  className="shrink-0 px-1.5 py-0.5 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[11px] outline-none focus:border-[var(--accent)]">
                  <option value="">跟随默认（{fallback ? FAMILY_LABEL[fallback] : '原生'}）</option>
                  <option value="chat">对话补全</option>
                  <option value="messages">Messages</option>
                  <option value="responses">Responses</option>
                </select>
              </div>
            )
          })}
        </div>
      )}</Collapsible>
    </div>
  )
}

function ProviderCard({ p, onChanged, onSetDefault }: {
  p: LlmProviderInfo
  onChanged: () => Promise<void>
  onSetDefault: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LlmTestResultInfo | null>(null)
  const [manualModel, setManualModel] = useState('')
  const [switchingUrl, setSwitchingUrl] = useState(false)
  const officialUrl = officialUrlFor(p.baseUrl)

  /** 换到官方地址：只改 baseUrl，Key / 自定义头 / 协议标记原样保留 */
  const switchToOfficial = async () => {
    if (!officialUrl || switchingUrl) return
    setSwitchingUrl(true)
    try {
      const r = await llmSaveProvider({
        id: p.id, name: p.name, type: p.type, baseUrl: officialUrl,
        headers: p.headers, modelFamilies: p.modelFamilies,
      })
      if (!r.ok) { showToast({ type: 'error', message: r.error ?? '地址替换失败' }); return }
      const rr = await llmRefreshModels(p.id)
      showToast(rr.ok
        ? { type: 'info', message: `已换到官方地址，发现 ${rr.models.length} 个模型` }
        : { type: 'error', message: `地址已换，但拉取模型失败：${rr.error}` })
      await onChanged()
    } finally { setSwitchingUrl(false) }
  }

  return (
    <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div className="flex items-center gap-2 flex-wrap">
        <Bot size={14} className="text-[var(--accent)] shrink-0" />
        <span className="text-[13px] font-medium text-[var(--text-primary)]">{p.name}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)]">{TYPE_LABEL[p.type]}</span>
        {p.isDefault && <Star size={12} className="text-yellow-400 fill-yellow-400" />}
        <label className="ml-auto flex items-center cursor-pointer">
          <SettingSwitch checked={p.enabled} onChange={() => { void llmToggleProvider(p.id, !p.enabled).then(onChanged) }} />
        </label>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mt-1 truncate font-mono">{p.baseUrl}</p>
      {officialUrl && (
        <p className="text-[11px] mt-1 leading-relaxed">
          <span className="text-[var(--text-muted)]">这是 opencode 的旧地址，官方现已改用 </span>
          <span className="font-mono text-[var(--text-secondary)]">{officialUrl}</span>
          <span className="text-[var(--text-muted)]">（模型清单多 10 个）。</span>
          <button onClick={() => { void switchToOfficial() }} disabled={switchingUrl}
            className="ml-1.5 px-1.5 py-0.5 rounded border border-[var(--accent)]/50 text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40 transition-colors">
            {switchingUrl ? '替换中…' : '换成官方地址'}
          </button>
        </p>
      )}
      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
        {p.models.length > 0 ? `${p.models.length} 个模型` : '未拉取模型'} · {p.hasKey ? '已配置 Key' : '无 Key'}{p.embeddingModel ? ` · 语义:${p.embeddingModel}` : ''}
      </p>
      {p.models.length > 0 && <ModelFamilyPanel p={p} onChanged={onChanged} />}
      <div className="flex items-center gap-1 mt-1.5">
        <input value={manualModel} onChange={e => setManualModel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && manualModel.trim()) { void llmAddModel(p.id, manualModel.trim()).then(r => { if (r.ok) { setManualModel(''); showToast({ type: 'info', message: `已添加模型 ${manualModel}` }); return onChanged() } }) } }}
          placeholder="手动填模型 ID"
          className="flex-1 min-w-0 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[11px] font-mono outline-none focus:border-[var(--accent)]" />
        <button disabled={!manualModel.trim()} title="添加模型"
          onClick={() => { void llmAddModel(p.id, manualModel.trim()).then((r: { ok: boolean; error?: string }) => { if (r.ok) { setManualModel(''); showToast({ type: 'info', message: '已添加模型' }); return onChanged() } else showToast({ type: 'error', message: r.error ?? '失败' }) }) }}
          className="shrink-0 px-2 py-1 rounded text-[11px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
          添加
        </button>
      </div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <button onClick={() => { void llmRefreshModels(p.id).then(r => { showToast(r.ok ? { type: 'info', message: `发现 ${r.models.length} 个模型` } : { type: 'error', message: `刷新失败：${r.error}` }); return onChanged() }) }}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          <RefreshCw size={11} /> 刷新模型
        </button>
        <button disabled={testing} onClick={async () => { setTesting(true); try { setTestResult(await llmTestConnection({ type: p.type, baseUrl: p.baseUrl, id: p.id })) } finally { setTesting(false) } }}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40">
          {testing && <Loader2 size={11} className="animate-spin" />} 测试
        </button>
        <button onClick={() => setEditing(v => !v)} title="编辑服务商（名称/地址/自定义请求头；Key 留空保留）"
          className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${editing ? 'border-[var(--accent)]/50 text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
          编辑
        </button>
        <button onClick={() => { void onSetDefault() }} title="设为默认"
          className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${p.isDefault ? 'border-yellow-500/50 text-yellow-400' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
          <Star size={11} /> 设默认
        </button>
        <button onClick={() => {
          if (!confirming) { setConfirming(true); setTimeout(() => setConfirming(false), 3000); return }
          void llmRemoveProvider(p.id).then(onChanged)
        }}
          className={`ml-auto text-[11px] px-2 py-1 rounded border transition-colors ${confirming ? 'border-red-500 text-red-400' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:text-red-400'}`}>
          <Trash2 size={11} />
        </button>
      </div>
      <Collapsible open={editing} innerClassName="">{() => <ProviderForm initial={p} onDone={async () => { setEditing(false); await onChanged() }} />}</Collapsible>
      {testResult && (
        <p className={`text-[11px] mt-1.5 ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {testResult.ok ? `✓ 连接成功（${testResult.latencyMs}ms，${testResult.models?.length ?? 0} 个模型）` : `✗ ${testResult.error}`}
        </p>
      )}
    </div>
  )
}

function ProviderForm({ onDone, initial }: { onDone: () => Promise<void>; initial?: LlmProviderInfo }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<LlmProviderType>(initial?.type ?? 'openai-compatible')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState(initial?.embeddingModel ?? '')
  const [headersText, setHeadersText] = useState(initial?.headers && Object.keys(initial.headers).length ? JSON.stringify(initial.headers, null, 2) : '')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LlmTestResultInfo | null>(null)

  return (
    <div className="mt-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] space-y-3 max-w-md">
      <Row label="名称">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="例如 DeepSeek"
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]" />
      </Row>
      <Row label="默认协议（个别模型走别的协议时，保存后到供应商卡片的「逐模型协议」里单独指定）">
        <select value={type} onChange={e => setType(e.target.value as LlmProviderType)}
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]">
          <option value="openai-compatible">OpenAI 兼容 · /chat/completions（DeepSeek / Moonshot / Qwen / GLM…）</option>
          <option value="openai-responses">OpenAI Responses · /responses（GPT / Grok / Muse Spark 等）</option>
          <option value="anthropic">Anthropic Messages · /messages（Claude 系列）</option>
          <option value="ollama">Ollama 本地（http://localhost:11434）</option>
        </select>
      </Row>
      <Row label="Base URL（含版本路径，如 https://api.deepseek.com/v1；opencode Go 为 https://opencode.ai/inference/go/v1）">
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={type === 'ollama' ? 'http://localhost:11434' : 'https://…/v1'}
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono outline-none focus:border-[var(--accent)]" />
      </Row>
      <Row label="API Key（加密存储，仅本机可解）">
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono outline-none focus:border-[var(--accent)]" />
      </Row>
      <Row label="嵌入模型（可选——知识语义检索用，如 text-embedding-3-small / bge-m3 / embedding-3）">
        <input value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)}
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono outline-none focus:border-[var(--accent)]" />
      </Row>
      <Row label="自定义请求头（JSON，可选——opencode 等网关的路由头在此填，如 {&quot;x-opencode-session&quot;:&quot;knowbase&quot;}）">
        <textarea value={headersText} onChange={e => setHeadersText(e.target.value)} rows={2}
          placeholder='{"x-opencode-session": "knowbase"}'
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono outline-none focus:border-[var(--accent)] resize-none" />
        <span className="block text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">
          这里填的值会被<b>按对话覆盖</b>：官方要求每个对话一个稳定 ID 才能吃到路由与提示缓存优化，
          常量值会让所有对话共用一个会话。填任何非空值即可，实际发送的是当前对话的 ID。
        </span>
      </Row>
      <div className="flex items-center gap-2">
        <button disabled={testing || !baseUrl.trim()} onClick={async () => { setTesting(true); try { setTestResult(await llmTestConnection({ type, baseUrl })) } finally { setTesting(false) } }}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
          {testing && <Loader2 size={12} className="animate-spin" />} 测试连通
        </button>
        <button disabled={saving || !name.trim() || !baseUrl.trim()} onClick={async () => {
          let headers: Record<string, string> | undefined
          const t = headersText.trim()
          if (t) {
            try {
              const parsed = JSON.parse(t)
              if (typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== 'string')) throw new Error('格式')
              headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k.trim(), String(v)]))
            } catch { showToast({ type: 'error', message: '自定义请求头不是合法的 JSON 对象（{"头名":"值"}）' }); return }
          }
          setSaving(true)
          try { const r = await llmSaveProvider({ id: initial?.id, name, type, baseUrl, apiKey: apiKey || undefined, headers, embeddingModel: embeddingModel.trim() || undefined }); if (r.ok) await onDone(); else showToast({ type: 'error', message: r.error ?? '保存失败' }) } finally { setSaving(false) }
        }}
          className="px-3 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
          保存
        </button>
        {testResult && (
          <span className={`text-[11px] ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {testResult.ok ? `✓ ${testResult.latencyMs}ms` : `✗ ${testResult.error}`}
          </span>
        )}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[12px] text-[var(--text-secondary)] mb-1">{label}</span>
      {children}
    </label>
  )
}

// ===== CC Switch 导入弹层 =====

function CcSwitchImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => Promise<void> }) {
  const [items, setItems] = useState<CcSwitchItem[] | null>(null)
  const [source, setSource] = useState('')
  const [ccsFound, setCcsFound] = useState(true)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  const rescan = useCallback(() => {
    setItems(null)
    llmCcSwitchList().then(r => {
      setItems(r.items)
      setSource(r.source)
      setCcsFound(r.found)
      setChecked(new Set(r.items.map(i => i.id)))
    }).catch(() => { setItems([]); setCcsFound(false) })
  }, [])

  useEffect(() => { rescan() }, [rescan])

  const toggle = (id: string) => {
    setChecked(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  const doImport = async () => {
    setImporting(true)
    try {
      const r = await llmCcSwitchImport([...checked])
      if (r.imported > 0) showToast({ type: 'info', message: `已导入 ${r.imported} 个供应商（Key 已加密存储）` })
      if (r.errors.length > 0) showToast({ type: 'error', message: r.errors[0] })
      await onImported()
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 kb-overlay" onClick={onClose}>
      <div className="w-[520px] max-h-[80vh] overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-3 border-b border-[var(--border-color)]">
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">从 CC Switch 导入供应商</h3>
          <p className="text-[11px] text-[var(--text-muted)] mt-1 break-all">来源：{source || '未找到'}</p>
        </div>
        <div className="px-5 py-4 space-y-2">
          {items === null && <p className="text-[12px] text-[var(--text-muted)] text-center py-4">读取中…</p>}
          {items !== null && items.length === 0 && (
            <div className="text-center py-4 space-y-3">
              {!ccsFound ? (
                <>
                  <p className="text-[13px] text-[var(--text-primary)]">未检测到 CC Switch</p>
                  <p className="text-[12px] text-[var(--text-muted)] leading-relaxed px-4">
                    一键导入依赖本机已安装 <b>CC Switch</b> 并在其中添加过供应商。<br />
                    安装并在 CC Switch 里配好 API Key 后，点击下方按钮重新扫描。
                  </p>
                  <div className="flex items-center justify-center gap-2">
                    <button onClick={() => { void openExternal('https://github.com/farion1231/cc-switch') }}
                      className="px-3 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] transition-colors">
                      获取 CC Switch
                    </button>
                    <button onClick={rescan} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">
                      <RefreshCw size={12} /> 重新扫描
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[12px] text-[var(--text-muted)]">
                    已检测到 CC Switch，但没有可导入的供应商。<br />
                    请在 CC Switch 中添加带 API Key 的自定义或预设供应商后重试。
                  </p>
                  <button onClick={rescan} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] transition-colors">
                    <RefreshCw size={12} /> 重新扫描
                  </button>
                </>
              )}
            </div>
          )}
          {items?.map(it => (
            <label key={it.id} className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-[var(--border-color)] cursor-pointer hover:bg-[var(--bg-hover)] transition-colors">
              <input type="checkbox" checked={checked.has(it.id)} onChange={() => toggle(it.id)} className="accent-[var(--accent)] w-4 h-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-[var(--text-primary)] truncate">{it.name}</span>
                <span className="block text-[11px] text-[var(--text-muted)] truncate font-mono">{it.baseUrl}</span>
              </span>
              <code className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] shrink-0">{it.keyPreview}</code>
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)] shrink-0">{it.type}</span>
            </label>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-[var(--border-color)] flex items-center justify-between">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
          <button onClick={() => { void doImport() }} disabled={importing || checked.size === 0}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
            {importing && <Loader2 size={12} className="animate-spin" />}
            导入选中（{checked.size}）
          </button>
        </div>
      </div>
    </div>
  )
}
// ===== 免费模型标记管理 =====

function FreeModelMarker({ providers }: { providers: LlmProviderInfo[] }) {
  const { s, update } = useSettings()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const allIds = [...new Set(providers.flatMap(p => p.models))]
  const freeSet = parseFreeSet(s.aiFreeModelIds ?? '[]')

  const openEditor = () => {
    setText([...freeSet].join('\n'))
    setOpen(true)
  }

  const save = () => {
    const ids = text.split('\n').map(l => l.trim()).filter(Boolean)
    void update('aiFreeModelIds', JSON.stringify([...new Set(ids)]))
    showToast({ type: 'info', message: `已保存免费标记（当前 ${ids.length} 个）` })
    setOpen(false)
  }

  return (
    <div className="max-w-md">
      <button onClick={() => (open ? setOpen(false) : openEditor())}
        className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
        免费模型标记（{freeSet.size} 个自定义 · 上游不区分，手动维护）
      </button>
      {open && (
        <div className="mt-2 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] space-y-2">
          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
            每行一个模型 ID。保存后下拉列表中会带 [免费] 前缀；id 自含 free 字样的自动识别，无需填写。
          </p>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={4}
            placeholder={'ox-alpha-free\nglm-5.2-air'}
            className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono resize-none outline-none focus:border-[var(--accent)]" />
          {allIds.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {allIds.filter(id => !freeSet.has(id) && (/free/i.test(id) || isOpenCodeFree(id))).map(id => (
                <button key={id} onClick={() => setText(t => (t.trim() ? t.replace(/\s*$/, '') + '\n' + id : id))}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                  title="点击加入清单">
                  + {id}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={save} className="px-3 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity">保存</button>
            <button onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-md text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">取消</button>
          </div>
        </div>
      )}
    </div>
  )
}