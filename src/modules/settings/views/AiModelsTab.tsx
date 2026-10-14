import { useEffect, useState, useCallback } from 'react'
import { Plus, Trash2, RefreshCw, Loader2, Star, Pencil, Import, Check, X, MoreHorizontal, ChevronRight, KeyRound } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { Collapsible } from '../../../components/shared/Collapsible'
import {
  llmListProviders, llmSaveProvider, llmRemoveProvider, llmToggleProvider,
  llmTestConnection, llmRefreshModels, llmAddModel, llmTestModel, llmVisionModels,
  llmCcSwitchList, llmCcSwitchImport, openExternal,
  llmSetModelFamily,
  llmAddAccount, llmSetActiveAccount, llmUpdateAccount, llmRemoveAccount, llmTestAccount,
} from '../../../lib/ipc'
import type { LlmProviderInfo, LlmProviderType, LlmModelFamily, LlmTestResultInfo, LlmModelTestResultInfo, LlmAccountInfo, CcSwitchItem } from '../../../types'
import { prettyModelName, isOpenCodeFree, familyHintOf } from '../../../lib/modelNames'
import { LLM_PRESETS, presetAddChip } from '../../../lib/llmPresets'
import type { LlmPreset } from '../../../lib/llmPresets'
import { AiModelPicker, TYPE_LABEL, FAMILY_LABEL, FAMILY_BY_TYPE, effectiveFamily } from './AiModelPicker'
import { SectionHead } from './SectionHead'

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

// 协议标签与「某模型实际走哪个协议」的判据住在选择器那个文件里（TYPE_LABEL / FAMILY_LABEL /
// FAMILY_BY_TYPE / effectiveFamily）—— 选择器与逐模型协议面板都要用，放一处免得两套口径。


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

/** 设置 → AI → 模型：供应商与账号 + 场景分配表 + 逐模型协议 + 回复长度 */
export function AiModelsTab() {
  const { s, update } = useSettings()
  const [providers, setProviders] = useState<LlmProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  /** 当前展开的预设添加表单（预设 id）；与 editing 互斥 —— 两个表单同时开没有意义 */
  const [presetForm, setPresetForm] = useState<string | null>(null)
  const [ccsOpen, setCcsOpen] = useState(false)
  /** 账号 ⋯「把其他槽位也改用它…」发起的批量改槽位请求（adopt 卡片由场景表渲染） */
  const [adopt, setAdopt] = useState<AdoptRequest | null>(null)
  /** 「高级」折叠（单次 maxTokens 上限）—— 折叠项都是 ui:false 的项，不影响设置搜索的落点 */
  const [adv, setAdv] = useState(false)

  /**
   * 打开「把其他槽位也改用它」：**此刻**把五个槽位的 from → to 算好。
   * 留空（= 跟随）的槽位不进表 —— 它们会跟着默认走，不该被批量改。
   */
  const openAdopt = (pid: string, aid: string) => {
    const p = providers.find(x => x.id === pid)
    if (!p) return
    const acct = p.accounts.find(a => a.id === aid)
    const who = `${p.name}${acct ? ' · ' + acct.name : ''}`
    const rows = SCENES
      .filter(sc => String(s[sc.key] ?? '').length > 0)
      .map(sc => {
        const from = String(s[sc.key])
        const mid = from.slice(from.indexOf(':') + 1)
        const fromText = specText(providers, from)
        if (from.slice(0, from.indexOf(':')) === p.id) {
          return { key: sc.key, label: sc.label, from, to: from, fromText, noop: true, toText: '已使用该端点：切换账号即可，模型无需更改' }
        }
        const toModel = p.models.includes(mid) ? mid : (p.models[0] ?? '')
        return {
          key: sc.key, label: sc.label, from, fromText, noop: !toModel,
          to: toModel ? `${p.id}:${toModel}` : '',
          toText: toModel ? `${who} / ${prettyModelName(toModel)}` : '该端点尚无模型清单，请先刷新模型',
        }
      })
    setAdopt({ pid, aid, who, rows })
  }
  // 模型级可用性测试（每个场景行自己持有状态），这里只需要把当前值给场景表

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await llmListProviders()
      setProviders(r.providers)
      setProviders(r.providers)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const freeSet = parseFreeSet(s.aiFreeModelIds ?? '[]')

  /** ☆ 点星：写回 aiFreeModelIds（JSON 数组）。原先是手填 ID 列表，现在点点就行 */
  const toggleFree = (modelId: string) => {
    const next = new Set(freeSet)
    if (next.has(modelId)) next.delete(modelId); else next.add(modelId)
    void update('aiFreeModelIds', JSON.stringify([...next]))
  }

  return (
    <div className="space-y-8">
      {/* 高级（2026-10-13 按原型收口）。
          为什么这一项能折叠：`llmMaxTokens` 是 `ui:false`（不进设置搜索）——
          折叠容器关着时内层不挂载，锚点会跟着消失，所以**可搜索的项一律常显**
          （sofficePath / 网页抓取那几项就是因此做成常显小节的，见 AiToolsAdvanced 头注）。 */}
      <div className="max-w-md">
        <button onClick={() => setAdv(v => !v)}
          className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <ChevronRight size={12} className={`transition-transform ${adv ? 'rotate-90' : ''}`} />
          高级
          <span className="ml-1 text-[10.5px] text-[var(--text-disabled)]">单次 maxTokens 上限</span>
        </button>
        <Collapsible open={adv} innerClassName="">
          {() => (
            <div className="mt-2 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] text-[var(--text-primary)]">单次 maxTokens 上限</div>
                  <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">取值范围 256 ~ 32768；设置过小将截断较长回复</div>
                </div>
                <input type="number" min={256} max={32768} value={String(s.llmMaxTokens ?? 4096)}
                  onChange={e => { void update('llmMaxTokens', Math.min(32768, Math.max(256, Math.floor(Number(e.target.value) || 4096)))) }}
                  className="w-28 shrink-0 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-right outline-none focus:border-[var(--accent)]" />
              </div>
            </div>
          )}
        </Collapsible>
      </div>

      {/* LibreOffice 路径已按原型归位到「工具 · 高级」（原在「模型」页，见 AiToolsAdvanced.tsx） */}

      {/* 供应商列表 */}
      <div>
        <div className="flex items-start justify-between gap-2 max-w-md">
          <SectionHead title="模型供应商" className="mb-3 min-w-0"
            hint="选择预设后仅需填写 API Key；如需修改接口地址、协议类型或请求头，请展开「高级」。" />
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setCcsOpen(true)} title="从 CC Switch 配置一键导入"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <Import size={13} /> CC Switch 导入
            </button>
            <button onClick={() => { setPresetForm(null); setEditing(v => !v) }}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              {editing ? <Pencil size={13} /> : <Plus size={13} />} 新建供应商
            </button>
          </div>
        </div>
        {/* 预设的价值不只是省打字：它顺带带上协议类型、必需的请求头、以及"模型那一栏怎么填"
            ——后两样是用户不可能自己知道的（opencode 的路由头 / 火山方舟的接入点 ID）。 */}

        {/* 预设网格 */}
        <div className="grid grid-cols-2 gap-2 max-w-md">
          {LLM_PRESETS.map(pr => (
            <button key={pr.id} onClick={() => { setEditing(false); setPresetForm(pr.id) }}
              title={pr.base || '自定义端点：地址与类型自己填'}
              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition-colors ${
                presetForm === pr.id
                  ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                  : 'border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]'
              }`}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: pr.color }} />
              <span className="min-w-0">
                <span className="block text-[12px] text-[var(--text-primary)] truncate">{pr.name}</span>
                <span className="block text-[10.5px] text-[var(--text-muted)] truncate">{pr.sub}</span>
              </span>
            </button>
          ))}
        </div>

        {/* 预设添加表单：把"预设替你填好了什么"明着列出来，不藏进「高级」 */}
        {presetForm && (() => {
          const pr = LLM_PRESETS.find(x => x.id === presetForm)
          if (!pr) return null
          return (
            <PresetAddForm
              preset={pr}
              onCancel={() => setPresetForm(null)}
              onDone={async () => { setPresetForm(null); await refresh() }}
            />
          )
        })()}

        {/* 空白表单（= 原型里的「新建」，也是「自定义 / 网关」预设的等价物） */}
        <Collapsible open={editing} innerClassName="">{() => <ProviderForm onDone={async () => { setEditing(false); await refresh() }} />}</Collapsible>

      {ccsOpen && (
        <CcSwitchImportModal
          onClose={() => setCcsOpen(false)}
          onImported={async () => { setCcsOpen(false); await refresh() }}
        />
      )}

        <div className="space-y-2 mt-4 max-w-md">
          {providers.map(p => (
            <ProviderCard key={p.id} p={p} onChanged={refresh} onAdopt={openAdopt}
              onSetDefault={async () => {
                // 「设为默认端点」= 把对话默认模型指到这个端点的首个模型（与场景表同一真源）
                const firstModel = p.models[0] ?? ''
                void update('defaultChatModel', firstModel ? `${p.id}:${firstModel}` : '')
                await refresh()
              }} />
          ))}
          {!loading && providers.length === 0 && (
            <p className="text-[12px] text-[var(--text-muted)] px-1 leading-relaxed">
              尚未配置供应商。选择上方任一预设最为便捷（仅需填写 API Key）；也可在本机安装 <b>CC Switch</b> 后用
              「CC Switch 导入」导入（Key 自动加密存储）。
            </p>
          )}
        </div>
      </div>

      {/* 场景分配表（2026-10-13 按原型新增）：模型本来有三层作用域（本会话 ＞ AI 助手 ＞ 全局默认），
          而设置页只露了最底层那一层 —— 另外两处各自藏在助手面板与对话输入区里，
          改了默认模型却发现某处没变时无从解释。现在收成一张表。 */}
      <SceneTable
        providers={providers}
        freeSet={freeSet}
        onToggleFree={toggleFree}
        adopt={adopt}
        onSetAdopt={setAdopt}
        onCloseAdopt={() => setAdopt(null)}
      />

      {/* 免费模型标记：入口在选择器里（每个模型右侧的 ☆），不再另设手填清单 */}

      {/* AI 内联建议的开关与「自动触发」已按原型归位到「对话」页签（那是"怎么跑"）；
          它的**模型槽位**在下面的场景分配表里（那是"用哪个模型"）。 */}
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
/** 五个"模型槽位"（= 原型 SCENE_LABEL 的五个场景）+ 生图两槽（v3.6.0） */
type ModelSlotKey = 'defaultChatModel' | 'assistantModelId' | 'aiAssistantInlineSuggestModelId' | 'agentCompressModelId' | 'aiTeachVisionModel' | 'aiImageModel' | 'aiImageEditModel'

/**
 * 「把其他槽位也改用它」的请求。**rows 在打开改动卡时就算好**（连同每行的原值 from），
 * 之后不再重算 —— 重算会把"已经改过去的槽位"当成 no-op 跳过，于是撤销静默失效。
 */
interface AdoptRequest {
  pid: string
  aid: string
  who: string
  rows: Array<{ key: ModelSlotKey; label: string; from: string; to: string; fromText: string; toText: string; noop: boolean }>
}

/**
 * 场景表。`anchor` 是**「要进设置搜索」的标记**（值 = SETTINGS 里那个 anchor）：
 * 带 anchor 的行**不走上表的 map 渲染**，而是各自包一层字面量 `data-setting-anchor="…"` 单独渲染
 * —— 设置搜索靠 DOM 找落点、`verify-ai-tab-anchors.mjs` 靠**字面量文本**数 anchor，
 * 写成 `data-setting-anchor={sc.anchor}` 表达式两边都认不出来（2026-10-14 实测踩到）。
 */
const SCENES: Array<{ key: ModelSlotKey; label: string; desc: string; placeholder: string; visionOnly?: boolean; anchor?: string }> = [
  { key: 'defaultChatModel', label: '对话默认模型', desc: 'AI 助手与 AI 教学的默认模型', placeholder: '未设置（AI 功能不可用）' },
  { key: 'assistantModelId', label: 'AI 助手（侧栏）', desc: '侧栏助手会话用', placeholder: '跟随对话默认' },
  { key: 'aiAssistantInlineSuggestModelId', label: '编辑器内联续写', desc: '调用最频繁，建议指定成本较低、响应较快的模型', placeholder: '跟随对话默认（思考型会自动换非思考）' },
  { key: 'agentCompressModelId', label: '长对话压缩摘要', desc: '较早对话压缩为纪要时使用', placeholder: '跟随当前会话模型' },
  { key: 'aiTeachVisionModel', label: '图片视觉转写', desc: 'AI 教学转写图片与 pptx 时使用', placeholder: '自动挑选（任一支持图片的模型）', visionOnly: true },
  // v3.6.0 对话内生图（docs/ai-image-gen-plan.md §7）：两个槽都**不做自动挑选** ——
  // 图像模型没法像 VISION_MODEL_RE 那样靠正则猜，猜错就是直接花钱调错模型，故留空即报错。
  { key: 'aiImageModel', label: '文生图', desc: '对话里敲 /生图 时用的图像生成模型', placeholder: '未设置（/生图 会提示未配置生图模型）', anchor: 'aiTools.imageModel' },
  { key: 'aiImageEditModel', label: '改图重绘', desc: '改已有图时用（需编辑类模型，如 image-edit / SeedEdit）', placeholder: '未设置（改图退化为按描述重画）', anchor: 'aiTools.imageEditModel' },
]

/** 「供应商 · 账号 / 模型名」——把 spec 说成人话 */
function specText(providers: LlmProviderInfo[], spec: string): string {
  const i = spec.indexOf(':')
  const p = providers.find(x => x.id === spec.slice(0, i))
  const mid = spec.slice(i + 1)
  const acct = p?.accounts.find(a => a.id === p.activeAccountId)
  return `${p?.name ?? spec.slice(0, i)}${acct ? ' · ' + acct.name : ''} / ${prettyModelName(mid)}`
}

/** 「把其他槽位也改用它」的改动卡（原型 adoptCardHTML）：from → to 逐行列清，应用/撤销 */
function AdoptCard({ who, rows, onApply, onUndo, onCancel, applied }: {
  who: string
  rows: Array<{ key: ModelSlotKey; label: string; from: string; to: string; fromText: string; toText: string; noop: boolean }>
  onApply: () => void
  onUndo: () => void
  onCancel: () => void
  applied: boolean
}) {
  const will = rows.filter(r => !r.noop)
  return (
    <div className="mb-3 px-3.5 py-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-secondary)] max-w-md">
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-[var(--text-primary)]">将其他槽位改用此账号</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-[var(--accent)]/40 text-[var(--accent)] shrink-0">{who}</span>
      </div>
      {applied ? (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[11px] text-emerald-400">✓ 已应用</span>
          <span className="text-[11px] text-[var(--text-muted)]">{will.length} 处槽位已改到它</span>
          <button onClick={onUndo} className="ml-auto text-[11px] px-2 py-1 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">撤销</button>
        </div>
      ) : (
        <>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            「跟随」的槽位（留空项）<b>不受影响</b>，将随默认模型变化。
            {will.length ? `下面 ${will.length} 处会改：` : '目前没有需要改的槽位 —— 已经都在它上面了。'}
          </p>
          <div className="mt-2 space-y-1">
            {rows.map(r => (
              <div key={r.key} className="flex items-baseline gap-2 text-[11px]">
                <span className="shrink-0 w-28 text-[var(--text-muted)]">{r.label}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                  {r.fromText}<span className="mx-1 text-[var(--text-disabled)]">→</span>
                  {r.noop ? <span className="text-[var(--text-disabled)]">{r.toText}</span> : <b className="text-[var(--text-primary)]">{r.toText}</b>}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2.5">
            <button onClick={onApply} disabled={will.length === 0}
              className="px-3 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
              应用到 {will.length} 处
            </button>
            <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
          </div>
        </>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-disabled)]">
        ※ 单个对话自身的模型覆盖不在此列，属于该对话的独立设置。
      </p>
    </div>
  )
}

/**
 * 场景分配表（2026-10-13 按原型新增）。
 *
 * 治的是「三层作用域不可见」：模型本来有三层（本会话 ＞ AI 助手 ＞ 全局默认），
 * 而设置页只露了最底层，另外两处各自藏在助手面板与对话输入区 ——
 * 改了默认模型却发现某处没变时无从解释。现在收成一张表，每行一个选择器。
 *
 * ★ adopt 的行**在打开改动卡时就算好并存进 state**：每次重算会把"已经改过去的槽位"
 * 当成 no-op 跳过，于是撤销静默失效（原型里专门写了这条）。所以这里只读不重算。
 */
function SceneTable({ providers, freeSet, onToggleFree, adopt, onSetAdopt, onCloseAdopt }: {
  providers: LlmProviderInfo[]
  freeSet: Set<string>
  onToggleFree: (modelId: string) => void
  adopt: AdoptRequest | null
  onSetAdopt: (a: AdoptRequest | null) => void
  onCloseAdopt: () => void
}) {
  const { s, update } = useSettings()
  const [visionSpecs, setVisionSpecs] = useState<Set<string>>(new Set())
  const [applied, setApplied] = useState(false)

  // 视觉转写那行的候选要收窄到"疑似支持图片"的模型（主进程按 VISION_MODEL_RE 过滤）
  useEffect(() => {
    let alive = true
    void llmVisionModels()
      .then(r => { if (alive) setVisionSpecs(new Set((r.models ?? []).map(m => m.spec))) })
      .catch(() => { if (alive) setVisionSpecs(new Set()) })
    return () => { alive = false }
  }, [])

  useEffect(() => { setApplied(false) }, [adopt])

  return (
    <div data-setting-anchor="aiTools.scenes">
      <SectionHead title="哪个场景用哪个模型"
        hint="各场景可分别指定模型；留空表示跟随上一行的默认模型（见占位文字），显式指定后不再跟随。此处修改不影响单个对话的临时覆盖。" />

      {adopt && (
        <AdoptCard who={adopt.who} rows={adopt.rows} applied={applied}
          onApply={() => { for (const r of adopt.rows) if (!r.noop) void update(r.key, r.to); setApplied(true) }}
          onUndo={() => { for (const r of adopt.rows) if (!r.noop) void update(r.key, r.from); setApplied(false) }}
          onCancel={onCloseAdopt} />
      )}

      <div className="space-y-2 max-w-md">
        {SCENES.filter(sc => !sc.visionOnly && !sc.anchor).map(sc => (
          <SceneRow key={sc.key} sc={sc} providers={providers} freeSet={freeSet}
            onToggleFree={onToggleFree} visionSpecs={visionSpecs} />
        ))}
        {/* 第五行·图片视觉转写：它那个设置项的**唯一落点**（控件从「教学」页搬到这里），
            所以锚点写成字面量 —— 设置搜索「图片视觉转写模型」要能跳到这一行。
            （写 data-setting-anchor={...} 表达式则契约脚本的文本扫描认不出来。） */}
        <div data-setting-anchor="aiTeach.visionModel">
          <SceneRow sc={SCENES.filter(sc => sc.visionOnly)[0]} providers={providers} freeSet={freeSet}
            onToggleFree={onToggleFree} visionSpecs={visionSpecs} />
        </div>
        {/* 生图两行（v3.6.0 对话内生图）：与上一行同理，锚点必须是**字面量** ——
            设置搜索「文生图模型 / 改图重绘模型」要能跳到这里，且 `verify-ai-tab-anchors.mjs`
            是按字面量串数 anchor 的（表达式形式它认不出来）。 */}
        <div data-setting-anchor="aiTools.imageModel">
          <SceneRow sc={SCENES.filter(sc => sc.key === 'aiImageModel')[0]} providers={providers} freeSet={freeSet}
            onToggleFree={onToggleFree} visionSpecs={visionSpecs} />
        </div>
        <div data-setting-anchor="aiTools.imageEditModel">
          <SceneRow sc={SCENES.filter(sc => sc.key === 'aiImageEditModel')[0]} providers={providers} freeSet={freeSet}
            onToggleFree={onToggleFree} visionSpecs={visionSpecs} />
        </div>
      </div>
    </div>
  )
}

/** 场景表的一行：左侧说明 + 可搜索选择器 + 「测试这个模型」 */
function SceneRow({ sc, providers, freeSet, onToggleFree, visionSpecs }: {
  sc: { key: ModelSlotKey; label: string; desc: string; placeholder: string; visionOnly?: boolean }
  providers: LlmProviderInfo[]
  freeSet: Set<string>
  onToggleFree: (modelId: string) => void
  visionSpecs: Set<string>
}) {
  const { s, update } = useSettings()
  const [testing, setTesting] = useState(false)
  const [out, setOut] = useState('')
  const cur = typeof s[sc.key] === 'string' ? String(s[sc.key]) : ''

  const testModel = async () => {
    const i = cur.indexOf(':')
    if (!cur || i < 0 || testing) return
    setTesting(true)
    try {
      const r = await llmTestModel(cur.slice(0, i), cur.slice(i + 1))
      setOut(r.ok ? `✓ 可用（${r.latencyMs}ms）` : `✗ ${r.error}`)
    } finally { setTesting(false) }
  }

  return (
    <div className="flex items-start gap-3">
      <div className="w-32 shrink-0 pt-1.5">
        <div className="text-[12px] text-[var(--text-primary)]">{sc.label}</div>
        <div className="text-[10.5px] text-[var(--text-muted)] leading-snug">{sc.desc}</div>
      </div>
      <div className="min-w-0 flex-1">
        <AiModelPicker
          value={cur}
          onChange={spec => { void update(sc.key, spec) }}
          providers={providers}
          freeSet={freeSet}
          onToggleFree={onToggleFree}
          placeholder={sc.placeholder}
          onlySpecs={sc.visionOnly && visionSpecs.size > 0 ? visionSpecs : undefined}
        />
        <div className="flex items-center gap-2 mt-1">
          <button onClick={() => { void testModel() }} disabled={!cur || testing}
            className="text-[10.5px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
            {testing ? '测试中…' : '测试这个模型'}
          </button>
          {out && <span className={`text-[10.5px] ${out.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>{out}</span>}
        </div>
      </div>
    </div>
  )
}

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
            title="按 opencode Go 官方端点表预填：GPT / Grok 使用 Responses，Claude / Qwen / MiniMax 使用 Messages，其余使用对话补全"
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

/** 「412ms · 2 分钟前」里的那一半：把测试时间点说成人话 */
function relTime(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = Date.now() - t
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  if (d < 172_800_000) return '昨天'
  return `${Math.floor(d / 86_400_000)} 天前`
}

/**
 * 「⋯」下拉（端点级与账号级共用）。原型里是浮层菜单；这里保持浮层，
 * 但点空白即关 —— settings 页面上同时只会开一个，不需要更多状态管理。
 * 打开按钮要 stopPropagation，否则点击会冒泡到 document 把刚开的菜单立刻关掉。
 */
function RowMenu({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return
    const close = (): void => onClose()
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open, onClose])
  if (!open) return null
  return (
    <div onClick={e => e.stopPropagation()}
      className="absolute right-0 top-full mt-1 z-20 min-w-[178px] py-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg kb-pop">
      {children}
    </div>
  )
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors ${
        danger ? 'text-red-400 hover:bg-red-500/10' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
      }`}>
      {children}
    </button>
  )
}

function ProviderCard({ p, onChanged, onSetDefault, onAdopt }: {
  p: LlmProviderInfo
  onChanged: () => Promise<void>
  onSetDefault: () => Promise<void>
  /** 「把其他槽位也改用它…」——把 5 个模型槽位批量挪到这个账号所在的端点 */
  onAdopt: (pid: string, aid: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [manualModel, setManualModel] = useState('')
  const [switchingUrl, setSwitchingUrl] = useState(false)
  const officialUrl = officialUrlFor(p.baseUrl)

  // 端点级 ⋯ / 账号级 ⋯ / 行内表单（手动加模型 · 加账号 · 换 Key · 重命名）——同一时刻只开一个
  const [menuOpen, setMenuOpen] = useState(false)
  const [acctMenu, setAcctMenu] = useState<string | null>(null)
  const [panel, setPanel] = useState<'addmodel' | null>(null)
  const [acctForm, setAcctForm] = useState<{ mode: 'add' | 'rekey' | 'rename'; id?: string } | null>(null)
  const [acctName, setAcctName] = useState('')
  const [acctKey, setAcctKey] = useState('')

  const acctAction = async (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    const r = await fn()
    showToast(r.ok ? { type: 'info', message: okMsg } : { type: 'error', message: r.error ?? '操作失败' })
    await onChanged()
  }

  const saveAcctForm = async () => {
    if (!acctForm) return
    if (acctForm.mode === 'add') {
      if (!acctKey.trim() && p.type !== 'ollama') { showToast({ type: 'error', message: '请填写该账号的 API Key' }); return }
      await acctAction(
        () => llmAddAccount({ providerId: p.id, name: acctName.trim() || undefined, apiKey: acctKey }),
        `已添加账号「${acctName.trim() || '新账号'}」并设为当前账号`,
      )
    } else if (acctForm.mode === 'rekey') {
      if (!acctKey.trim()) { showToast({ type: 'error', message: '请填写新的 API Key' }); return }
      await acctAction(
        () => llmUpdateAccount({ providerId: p.id, accountId: acctForm.id ?? '', apiKey: acctKey }),
        '已更新该账号的 Key',
      )
    } else {
      if (!acctName.trim()) { showToast({ type: 'error', message: '账号名称不能为空' }); return }
      await acctAction(
        () => llmUpdateAccount({ providerId: p.id, accountId: acctForm.id ?? '', name: acctName }),
        '已重命名账号',
      )
    }
    setAcctForm(null)
    setAcctKey('')
  }

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
        ? { type: 'info', message: `已切换为官方地址，检测到 ${rr.models.length} 个模型` }
        : { type: 'error', message: `地址已切换，但获取模型列表失败：${rr.error}` })
      await onChanged()
    } finally { setSwitchingUrl(false) }
  }

  const accounts = p.accounts ?? []
  const acctBusy = testing || switchingUrl

  return (
    <div className="px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      {/* 端点头：名字 / 类型 / 「N 个账号 · M 个模型」 / 启停 / 端点级 ⋯ */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.enabled ? 'bg-emerald-500' : 'bg-[var(--text-disabled)]'}`} />
        <span className="text-[13px] font-medium text-[var(--text-primary)]">{p.name}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)]">{TYPE_LABEL[p.type]}</span>
        {p.isDefault && <Star size={12} className="text-yellow-400 fill-yellow-400" />}
        <span className="text-[11px] text-[var(--text-muted)] truncate">
          {accounts.length} 个账号 · {p.models.length > 0 ? `${p.models.length} 个模型` : '尚未获取模型'}
          {p.enabled ? '' : ' · 端点已停用'}
        </span>
        <label className="ml-auto flex items-center cursor-pointer shrink-0">
          <SettingSwitch checked={p.enabled} onChange={() => { void llmToggleProvider(p.id, !p.enabled).then(onChanged) }} />
        </label>
        <span className="relative shrink-0">
          <button onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }} title="端点级操作"
            className={`p-1 rounded-md transition-colors ${menuOpen ? 'text-[var(--accent)] bg-[var(--bg-hover)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}>
            <MoreHorizontal size={14} />
          </button>
          <RowMenu open={menuOpen} onClose={() => setMenuOpen(false)}>
            <MenuItem onClick={() => { setMenuOpen(false); void llmRefreshModels(p.id).then(r => { showToast(r.ok ? { type: 'info', message: `检测到 ${r.models.length} 个模型` } : { type: 'error', message: `刷新失败：${r.error}` }); return onChanged() }) }}>
              <RefreshCw size={11} /> 刷新模型列表
            </MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); setPanel('addmodel') }}>
              <Plus size={11} /> 手动添加模型
            </MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); setEditing(true) }}>
              <Pencil size={11} /> 编辑端点
            </MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); void onSetDefault() }}>
              <Star size={11} /> 设为默认端点
            </MenuItem>
            <div className="my-1 h-px bg-[var(--border-color)]" />
            <MenuItem danger onClick={() => {
              if (!confirming) { setConfirming(true); setTimeout(() => setConfirming(false), 3000); return }
              void llmRemoveProvider(p.id).then(onChanged)
            }}>
              <Trash2 size={11} /> {confirming ? '再点一次：删除端点（含全部账号）' : '删除端点（含全部账号）'}
            </MenuItem>
          </RowMenu>
        </span>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mt-1 truncate font-mono">{p.baseUrl}</p>
      {officialUrl && (
        <p className="text-[11px] mt-1 leading-relaxed">
          <span className="text-[var(--text-muted)]">当前为 opencode 旧地址，官方已调整为 </span>
          <span className="font-mono text-[var(--text-secondary)]">{officialUrl}</span>
          <span className="text-[var(--text-muted)]">（模型数量多 10 个）。</span>
          <button onClick={() => { void switchToOfficial() }} disabled={switchingUrl}
            className="ml-1.5 px-1.5 py-0.5 rounded border border-[var(--accent)]/50 text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40 transition-colors">
            {switchingUrl ? '替换中…' : '切换为官方地址'}
          </button>
        </p>
      )}

      {/* 账号行：足够轻，读起来是"端点的子项"而不是又套一层卡片。
          切账号只改 activeAccountId —— 模型 spec 指向端点 id，所以下面那些模型槽位一处都不用改。 */}
      {accounts.map(a => {
        const isOn = a.id === p.activeAccountId
        const status = [
          a.lastLatencyMs != null ? `${a.lastLatencyMs}ms` : '未测过',
          relTime(a.lastTestedAt),
        ].filter(Boolean).join(' · ')
        return (
          <div key={a.id}
            className={`flex items-center gap-2 mt-1.5 px-2 py-1.5 rounded-md border transition-colors ${
              isOn ? 'border-[var(--accent)]/40 bg-[var(--accent)]/5' : 'border-transparent hover:bg-[var(--bg-hover)]'
            } ${a.enabled ? '' : 'opacity-60'}`}>
            <button onClick={() => { void acctAction(() => llmSetActiveAccount(p.id, a.id), `已切换到账号「${a.name}」`) }}
              title={isOn ? '当前使用中' : '切换到这个账号'}
              className={`w-3 h-3 rounded-full border shrink-0 transition-colors ${isOn ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--text-disabled)] hover:border-[var(--accent)]'}`} />
            <span className="text-[12px] text-[var(--text-primary)] truncate">{a.name}</span>
            {a.hasKey || p.type === 'ollama'
              ? <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-400 shrink-0">{p.type === 'ollama' ? '无需 Key' : '已配置 Key'}</span>
              : <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-400 shrink-0">无 Key</span>}
            {!a.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-disabled)] shrink-0">已停用</span>}
            <span className="text-[10.5px] text-[var(--text-muted)] truncate">{status}</span>
            <span className="relative ml-auto shrink-0">
              <button onClick={e => { e.stopPropagation(); setAcctMenu(acctMenu === a.id ? null : a.id) }} title="账号操作"
                className={`p-1 rounded-md transition-colors ${acctMenu === a.id ? 'text-[var(--accent)] bg-[var(--bg-hover)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}>
                <MoreHorizontal size={13} />
              </button>
              <RowMenu open={acctMenu === a.id} onClose={() => setAcctMenu(null)}>
                <MenuItem onClick={() => { setAcctMenu(null); void (async () => { setTesting(true); try { const r = await llmTestAccount(p.id, a.id); showToast(r.ok ? { type: 'info', message: `「${a.name}」连接成功（${r.latencyMs}ms）` } : { type: 'error', message: r.error ?? '测试失败' }) } finally { setTesting(false) } await onChanged() })() }}>
                  <Check size={11} /> 测试这个账号
                </MenuItem>
                <MenuItem onClick={() => { setAcctMenu(null); setAcctForm({ mode: 'rekey', id: a.id }); setAcctKey('') }}>
                  <KeyRound size={11} /> 更换 API Key
                </MenuItem>
                <MenuItem onClick={() => { setAcctMenu(null); setAcctForm({ mode: 'rename', id: a.id }); setAcctName(a.name) }}>
                  <Pencil size={11} /> 重命名账号
                </MenuItem>
                <div className="my-1 h-px bg-[var(--border-color)]" />
                {/* 批量把 5 个模型槽位挪到这个端点：改动卡出现在「哪个场景用哪个模型」那张表上方 */}
                <MenuItem onClick={() => { setAcctMenu(null); onAdopt(p.id, a.id) }}>
                  <ChevronRight size={11} /> 将其他槽位改用此账号…
                </MenuItem>
                <div className="my-1 h-px bg-[var(--border-color)]" />
                <MenuItem onClick={() => { setAcctMenu(null); void acctAction(() => llmUpdateAccount({ providerId: p.id, accountId: a.id, enabled: !a.enabled }), a.enabled ? `已停用「${a.name}」（Key 保留）` : `已启用「${a.name}」`) }}>
                  {a.enabled ? <><X size={11} /> 停用（Key 保留）</> : <><Check size={11} /> 启用</>}
                </MenuItem>
                <MenuItem danger onClick={() => { setAcctMenu(null); void acctAction(() => llmRemoveAccount(p.id, a.id), `已删除账号「${a.name}」及其 Key`) }}>
                  <Trash2 size={11} /> 删除账号与 Key…
                </MenuItem>
              </RowMenu>
            </span>
          </div>
        )
      })}

      {/* 不可用要说清因果：不是"暂时抽风"，是模型真的不会出现在选择器里 */}
      {!p.usable && (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-400/90">
          该端点没有可用账号（均已停用或未配置 Key），其模型<b>不会出现在模型选择器</b>中。
        </p>
      )}

      {/* 加账号 / 换 Key / 重命名：都走同一条行内表单（铁律 25：常规确认不弹中央模态） */}
      {acctForm ? (
        <div className="mt-2">
          <div className="flex items-center gap-2 flex-wrap">
            {acctForm.mode === 'add' && (
              <input value={acctName} onChange={e => setAcctName(e.target.value)} placeholder="账号名称，例如 工作号"
                className="w-32 px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]" />
            )}
            {acctForm.mode === 'rename' && (
              <input value={acctName} onChange={e => setAcctName(e.target.value)} placeholder="新名称"
                className="w-32 px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]" />
            )}
            {acctForm.mode !== 'rename' && (
              <input type="password" value={acctKey} onChange={e => setAcctKey(e.target.value)} placeholder="填写该账号的 API Key"
                className="flex-1 min-w-[180px] px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]" />
            )}
            <button disabled={acctBusy} onClick={() => { void saveAcctForm() }}
              className="px-3 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
              保存
            </button>
            <button onClick={() => setAcctForm(null)}
              className="px-3 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              取消
            </button>
          </div>
          {acctForm.mode === 'add' && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              同一端点的第二个账号复用地址、请求头与模型清单，仅 API Key 不同；两把 Key 分别加密存储，互不覆盖。
            </p>
          )}
        </div>
      ) : (
        <button onClick={() => { setAcctForm({ mode: 'add' }); setAcctName(''); setAcctKey('') }}
          className="mt-2 w-full px-2 py-1.5 rounded-md border border-dashed border-[var(--border-color)] text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]/50 transition-colors">
          ＋ 添加账号（同一端点，更换 Key）
        </button>
      )}

      {/* 手动加模型（原摊在卡片上的输入框，现收进 ⋯） */}
      {panel === 'addmodel' && (
        <div className="flex items-center gap-1 mt-2">
          <input value={manualModel} onChange={e => setManualModel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && manualModel.trim()) { void llmAddModel(p.id, manualModel.trim()).then(r => { if (r.ok) { setManualModel(''); showToast({ type: 'info', message: `已添加模型 ${manualModel}` }); return onChanged() } }) } }}
            placeholder="输入模型 ID"
            className="flex-1 min-w-0 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[11px] font-mono outline-none focus:border-[var(--accent)]" />
          <button disabled={!manualModel.trim()} title="添加模型"
            onClick={() => { void llmAddModel(p.id, manualModel.trim()).then((r: { ok: boolean; error?: string }) => { if (r.ok) { setManualModel(''); showToast({ type: 'info', message: '已添加模型' }); return onChanged() } else showToast({ type: 'error', message: r.error ?? '失败' }) }) }}
            className="shrink-0 px-2 py-1 rounded text-[11px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
            添加
          </button>
          <button onClick={() => setPanel(null)} className="shrink-0 px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">收起</button>
        </div>
      )}

      {p.models.length > 0 && <ModelFamilyPanel p={p} onChanged={onChanged} />}
      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
        {p.hasKey ? '当前账号已配置 Key' : '当前账号无 Key'}{p.embeddingModel ? ` · 语义检索:${p.embeddingModel}` : ''}
      </p>
      <Collapsible open={editing} innerClassName="">{() => <ProviderForm initial={p} onDone={async () => { setEditing(false); await onChanged() }} />}</Collapsible>
    </div>
  )
}

/**
 * 预设添加表单（2026-10-13，按原型 tmp/ai-settings-proto）。
 *
 * 与空白表单的分工：预设已经把**地址 / 类型 / 必需的请求头**填好了，用户只剩「粘 Key」
 * （火山方舟还要补一个接入点 ID）。所以这里默认只露最少的东西，
 * 而"预设替你填了什么"要**明着列出来** —— 尤其 opencode 的会话头：
 * 用户不可能知道要填它，藏进「高级」等于没带。
 */
function PresetAddForm({ preset, onDone, onCancel }: {
  preset: LlmPreset
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const isLocal = preset.type === 'ollama'
  const [name, setName] = useState(preset.name)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState(preset.base)
  const [type, setType] = useState<LlmProviderType>(preset.type)
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [headersText, setHeadersText] = useState(preset.header ? JSON.stringify(preset.header) : '')
  const [adv, setAdv] = useState(false)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!name.trim()) { showToast({ type: 'error', message: '名称不能为空' }); return }
    let headers: Record<string, string> | undefined
    const raw = headersText.trim()
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是对象')
        headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
      } catch {
        showToast({ type: 'error', message: '自定义请求头必须是 JSON 对象（{"头名":"值"}）' })
        return
      }
    }
    setSaving(true)
    try {
      const r = await llmSaveProvider({
        name: name.trim(), type, baseUrl: baseUrl.trim(), apiKey: apiKey || undefined,
        headers, embeddingModel: embeddingModel.trim() || undefined,
      })
      if (!r.ok) { showToast({ type: 'error', message: r.error ?? '保存失败' }); return }
      // 火山方舟这类平台：模型那一栏填的是接入点 ID，顺手加进清单，免得用户回去再找一趟
      if (model.trim() && r.id) await llmAddModel(r.id, model.trim())
      showToast({ type: 'info', message: model.trim() ? `已添加「${name.trim()}」并记录模型 ${model.trim()}` : `已添加「${name.trim()}」` })
      await onDone()
    } finally { setSaving(false) }
  }

  const inputCls = 'w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]'

  return (
    <div className="mt-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] max-w-md">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: preset.color }} />
        <span className="text-[13px] font-medium text-[var(--text-primary)]">添加「{preset.name}」</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-[var(--accent)]/40 text-[var(--accent)] shrink-0">
          {presetAddChip(preset)}
        </span>
      </div>

      {/* 预设替你填好、而你本来不可能知道的东西 —— 明着说，不藏进「高级」 */}
      {preset.header && (
        <div className="mb-2.5 px-2.5 py-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)]">
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
            <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-400 text-[10px]">预设带上</span>
            会话头 <code className="text-[var(--text-primary)]">{JSON.stringify(preset.header)}</code> ——
            官方要求每个对话使用稳定的会话 ID（用于路由与提示缓存），该值<b>不是账号凭据</b>；实际发送的是当前对话的 ID。
          </p>
        </div>
      )}
      {preset.modelInput === 'endpoint' && preset.modelHint && (
        <div className="mb-2.5 px-2.5 py-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)]">
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
            <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-400 text-[10px]">要你补一步</span>
            {preset.modelHint}
          </p>
        </div>
      )}
      {preset.modelHint && preset.modelInput !== 'endpoint' && (
        <p className="mb-2.5 text-[11px] leading-relaxed text-[var(--text-muted)]">{preset.modelHint}</p>
      )}

      <div className="space-y-2.5">
        <Row label="名称">
          <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
        </Row>
        <Row label={isLocal ? 'API Key（本地模型可留空）' : 'API Key'}>
          <input type="password" value={apiKey} disabled={isLocal} onChange={e => setApiKey(e.target.value)}
            placeholder={isLocal ? '本地模型无需 API Key' : '填写 API Key（加密写入磁盘，之后不可回读）'} className={inputCls} />
        </Row>
        <Row label={preset.modelInput === 'endpoint' ? '接入点 ID（ep-…）' : '模型 ID（可选，可稍后刷新获取）'}>
          <input value={model} onChange={e => setModel(e.target.value)}
            placeholder={preset.modelInput === 'endpoint' ? 'ep-2026…' : '例如 deepseek-chat'} className={inputCls} />
        </Row>
      </div>

      <p className="mt-2.5 text-[11px] text-[var(--text-muted)] leading-relaxed">
        接口地址：<span className="font-mono text-[var(--text-secondary)]">{preset.base || '（自定义，请展开「高级」填写）'}</span>
      </p>

      {preset.srcConfig && (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-400 text-[10px]">按官方文档</span>
          地址与会话头取自 opencode 官方 Go 端点表。旧地址 <code>https://opencode.ai/zen/go/v1</code> 仍可用，但模型数量少 10 个；切换前请先「测试连接」确认该 Key 在新路径可用。
        </p>
      )}
      {preset.unverified && (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-400/90">
          ⚠ 该地址未经在线核实，请核对后使用。
        </p>
      )}

      <button onClick={() => setAdv(v => !v)}
        className="mt-3 flex items-center gap-1 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
        <ChevronRight size={12} className={`transition-transform ${adv ? 'rotate-90' : ''}`} />
        高级（接口地址 / 类型 / 语义检索模型 / 自定义请求头）
      </button>
      <Collapsible open={adv} innerClassName="">
        {() => (
          <div className="mt-2.5 pt-2.5 border-t border-[var(--border-color)] space-y-2.5">
            <Row label="接口地址">
              <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className={inputCls} />
            </Row>
            <Row label="协议类型（端点默认值；个别模型不同时可在卡片上逐模型指定）">
              <select value={type} onChange={e => setType(e.target.value as LlmProviderType)} className={inputCls}>
                {(['openai-compatible', 'anthropic', 'openai-responses', 'ollama'] as LlmProviderType[]).map(t => (
                  <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                ))}
              </select>
            </Row>
            <Row label="语义检索模型（可选）">
              <input value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)}
                placeholder="如 text-embedding-3-small" className={inputCls} />
            </Row>
            <Row label="自定义请求头（JSON，可选）">
              <input value={headersText} onChange={e => setHeadersText(e.target.value)}
                placeholder='{"头名":"值"}' className={`${inputCls} font-mono`} />
            </Row>
          </div>
        )}
      </Collapsible>

      <div className="flex items-center gap-2 mt-3">
        <button onClick={() => { void save() }} disabled={saving}
          className="flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
          {saving && <Loader2 size={12} className="animate-spin" />} 保存
        </button>
        <button onClick={onCancel}
          className="px-3 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          取消
        </button>
      </div>
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
      <Row label="默认协议（个别模型不同时，保存后到卡片的「逐模型协议」里单独指定）">
        <select value={type} onChange={e => setType(e.target.value as LlmProviderType)}
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]">
          <option value="openai-compatible">OpenAI 兼容 · /chat/completions（DeepSeek / Moonshot / Qwen / GLM…）</option>
          <option value="openai-responses">OpenAI Responses · /responses（GPT / Grok / Muse Spark 等）</option>
          <option value="anthropic">Anthropic Messages · /messages（Claude 系列）</option>
          <option value="ollama">Ollama 本地（http://localhost:11434）</option>
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
      <Row label="嵌入模型（可选，知识语义检索用）">
        <input value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)}
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono outline-none focus:border-[var(--accent)]" />
      </Row>
      <Row label="自定义请求头（JSON，可选）">
        <textarea value={headersText} onChange={e => setHeadersText(e.target.value)} rows={2}
          placeholder='{"x-opencode-session": "knowbase"}'
          className="w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono outline-none focus:border-[var(--accent)] resize-none" />
        <span className="block text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">
          按对话覆盖：填任何非空值即可，实际发送的是当前对话的 ID。
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
                    一键导入需本机已安装 <b>CC Switch</b> 并已在其中配置供应商。<br />
                    安装并在 CC Switch 中配置 API Key 后，点击下方按钮重新扫描。
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
                    请先在 CC Switch 中添加包含 API Key 的自定义或预设供应商，然后重试。
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
// ===== 免费模型标记：入口已在选择器里（点 ☆），不再需要手填 ID 的编辑器 =====
//
// 2026-10-13 退掉原来的 `FreeModelMarker`：它让用户「每行一个模型 ID」手抄，
// 而模型选择器里每个模型旁边就有 ☆（原型原话：「☆ = 标记为免费（原来的"手填 ID 列表"改成点星）」）。
// 两套入口写同一个键（aiFreeModelIds）只会互相打架 —— 少一个入口少一处不一致。
// 免费判定仍是双轨：手动标记 ∪ id 自含 free（isFreeModel / isOpenCodeFree）。