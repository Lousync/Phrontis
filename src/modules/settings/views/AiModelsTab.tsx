import { useEffect, useState, useCallback } from 'react'
import { Bot, Gauge, Plus, Trash2, RefreshCw, Loader2, Star, Pencil, Import } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { Collapsible } from '../../../components/shared/Collapsible'
import {
  llmListProviders, llmSaveProvider, llmRemoveProvider, llmToggleProvider,
  llmTestConnection, llmRefreshModels, llmSetDefaultModel, llmGetUsage, llmAddModel, llmTestModel,
  llmCcSwitchList, llmCcSwitchImport, openExternal, llmUsageBreakdown, aiTeachSrcSofficeProbe,
} from '../../../lib/ipc'
import type { LlmProviderInfo, LlmProviderType, LlmTestResultInfo, LlmModelTestResultInfo, CcSwitchItem, LlmUsageBreakdownEntry } from '../../../types'
import { prettyModelName, isOpenCodeFree } from '../../../lib/modelNames'

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
  const [usage, setUsage] = useState({ monthTokens: 0 })
  const [breakdown, setBreakdown] = useState<{ month: string; entries: LlmUsageBreakdownEntry[] }>({ month: '', entries: [] })
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
      const [r, u, b] = await Promise.all([llmListProviders(), llmGetUsage(), llmUsageBreakdown()])
      setProviders(r.providers)
      setDefaultModel(r.defaultChatModel)
      setUsage(u)
      setBreakdown(b)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const freeSet = parseFreeSet(s.aiFreeModelIds ?? '[]')

  return (
    <div className="space-y-8">
      {/* 用量统计（仅统计不限额） */}
      <div>
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">Token 用量</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">本月累计消耗（仅统计，不设限额拦截）；每次对话回复下方的 ↑↓ 标记为单轮消耗。</p>
        <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md">
          <div className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2"><Gauge size={14} className="text-[var(--accent)]" />本月 tokens</span>
            <span className="tabular-nums text-[var(--text-secondary)]">{usage.monthTokens.toLocaleString()}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            <label className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-[var(--text-muted)] mr-2">单次 maxTokens</span>
              <input type="number" min={256} max={32768} value={String(s.llmMaxTokens ?? 4096)}
                onChange={e => { void update('llmMaxTokens', Math.min(32768, Math.max(256, Math.floor(Number(e.target.value) || 4096)))) }}
                className="w-28 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-right outline-none focus:border-[var(--accent)]" />
            </label>
          </div>
          {breakdown.entries.length > 0 && (
            <div className="mt-3 pt-2.5 border-t border-[var(--border-color)]">
              <p className="text-[11px] text-[var(--text-muted)] mb-1.5">按供应商/模型细分（{breakdown.month}）</p>
              <div className="space-y-1">
                {breakdown.entries.slice(0, 8).map(e => (
                  <div key={`${e.providerId}-${e.model}`} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-[var(--text-secondary)]" title={`${e.provider} · ${e.model}`}>{e.provider} · {prettyModelName(e.model)}</span>
                    <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{e.calls} 次 · {e.tokens.toLocaleString()} tok</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

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
      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
        {p.models.length > 0 ? `${p.models.length} 个模型` : '未拉取模型'} · {p.hasKey ? '已配置 Key' : '无 Key'}{p.embeddingModel ? ` · 语义:${p.embeddingModel}` : ''}
      </p>
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
      <Row label="类型">
        <select value={type} onChange={e => setType(e.target.value as LlmProviderType)}
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]">
          <option value="openai-compatible">OpenAI 兼容（DeepSeek/Moonshot/Qwen/GLM…）</option>
          <option value="ollama">Ollama 本地（http://localhost:11434）</option>
          <option value="anthropic">Anthropic（Claude 系列）</option>
        </select>
      </Row>
      <Row label="Base URL（含版本路径，如 https://api.deepseek.com/v1）">
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
      <Row label="自定义请求头（JSON，可选——opencode 等网关要求的路由头在此填，如 {&quot;x-opencode-session&quot;:&quot;knowbase&quot;}）">
        <textarea value={headersText} onChange={e => setHeadersText(e.target.value)} rows={2}
          placeholder='{"x-opencode-session": "knowbase"}'
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono outline-none focus:border-[var(--accent)] resize-none" />
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