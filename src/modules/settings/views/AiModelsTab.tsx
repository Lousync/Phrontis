import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Plus, Trash2, RefreshCw, Loader2, Star, Pencil, Import, Check, X,
  ChevronRight, KeyRound, Zap, Copy, AlertTriangle,
} from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { Collapsible } from '../../../components/shared/Collapsible'
import { HelpHint } from '../../../components/shared/HelpHint'
import { MenuItem, MenuSep, RowMenuButton } from '../components/RowMenu'
import { SectionHead } from './SectionHead'
import { SettingsGroup } from '../components/SettingsGroup'
import { usePresence } from '../../../lib/usePresence'
import {
  llmListProviders, llmSaveProvider, llmRemoveProvider, llmToggleProvider,
  llmTestConnection, llmRefreshModels, llmAddModel, llmTestModel, llmVisionModels,
  llmCcSwitchList, llmCcSwitchImport, openExternal, copyText,
  llmSetModelFamily,
  llmAddAccount, llmSetActiveAccount, llmUpdateAccount, llmRemoveAccount, llmTestAccount,
} from '../../../lib/ipc'
import type { LlmProviderInfo, LlmProviderType, LlmModelFamily, LlmTestResultInfo, LlmModelTestResultInfo, LlmAccountInfo, CcSwitchItem } from '../../../types'
import { prettyModelName, familyHintOf } from '../../../lib/modelNames'
import { LLM_PRESETS, presetAddChip } from '../../../lib/llmPresets'
import type { LlmPreset } from '../../../lib/llmPresets'
import { AiModelPicker, TYPE_LABEL, FAMILY_LABEL, FAMILY_BY_TYPE } from './AiModelPicker'

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
// FAMILY_BY_TYPE）—— 选择器与逐模型协议面板都要用，放一处免得两套口径。

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

const inputCls = 'w-full px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]'

/**
 * 设置 → AI → 模型（2026-10-14 改造，方案 docs/ai-settings-v2-plan.md 第 2 刀）。
 *
 * 三条手法落在这一页：
 *   · **一行一物**：供应商列表每行只剩「chevron + 状态点 + 名称 + 类型 + 一行摘要 + 右侧动作」。
 *     改造前每张卡上同时挂着 baseUrl 行、官方地址提示、账号行、Key 徽章、延迟、可用性因果说明，
 *     「有几家供应商」得靠滚。
 *   · **点开才说**：展开 = 进入编辑（DSH 口径），表单/账号/模型清单/逐模型协议/场景分配全部降为折叠。
 *   · **解释走 ⓘ 悬停**：常显文字只留空态引导、不可逆警告、故障诊断三类。
 *
 * 两处实现层面的坑（都不是"风格问题"）：
 *   1. 行**不能**做成 `<button>`：行内还有 ⚡ / ⋯ / 开关三个按钮，嵌套 button 会被浏览器拆 DOM
 *      （表象是"⋯ 和开关各自变成一个带框的小方块"）。所以整行是 `div[role=button]` + 键盘处理。
 *   2. 打字机式的行内菜单/下拉**必须走 `AnchoredLayer`**：折叠容器的内层 `overflow: hidden`
 *      会把就地 absolute 的菜单裁掉半个（这一页的账号菜单与场景表下拉都在折叠组里）。
 */

/** 设置 → AI → 模型：供应商与账号 + 场景分配表 + 逐模型协议 + 回复长度 */
export function AiModelsTab() {
  const { s, update } = useSettings()
  const [providers, setProviders] = useState<LlmProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  /** 当前展开（= 正在编辑）的端点 id。一次只开一个：展开即编辑，没有"只读态 → 编辑态"两级 */
  const [openId, setOpenId] = useState<string | null>(null)
  /** 「＋ 添加供应商」点开的选择器（预设网格 + CC Switch 一行） */
  const [pickerOpen, setPickerOpen] = useState(false)
  /** 选择器里选中的预设：收起选择器、就地展开添加表单 */
  const [presetForm, setPresetForm] = useState<string | null>(null)
  const [ccsOpen, setCcsOpen] = useState(false)
  /** 账号 ⋯「把其他槽位也改用它…」发起的批量改槽位请求（adopt 卡片由场景表渲染） */
  const [adopt, setAdopt] = useState<AdoptRequest | null>(null)
  /**
   * 本机解不开 Key 的账号数（跨系统导入；Linux 平台化阶段 1）。
   * Key 密文由**其他系统**的钥匙串加密，密钥不随设置迁移 ⇒ 本机必然解不开；
   * 原先这种账号显示「已配置 Key」，用户的感受只是「调用老是 401」。见 electron/lib/secretBox.ts 头注释。
   */
  const unreadableKeyCount = providers.reduce((n, p) => n + p.accounts.filter(a => a.keyUnreadable).length, 0)
  /** 顶部提示条只在本会话内可关（不加 localStorage 记忆：它是数据状态的解释，重新填 Key 后应自动消失） */
  const [unreadableKeyNoticeOpen, setUnreadableKeyNoticeOpen] = useState(true)
  /**
   * 顶部提示条是否可见。**负边距必须跟着它走**（2026-10-19 修）：
   * `Collapsible` 的外层是常驻的（开合动画需要），原先 `-my-4` 无条件挂着 ——
   * 提示条收起后高度为 0、但上下各 −16px 的边距仍在，会把下面「供应商」整块向上拽，
   * 顶进页签栏的下划线里（真机截图可见）。
   */
  const keyNoticeVisible = unreadableKeyCount > 0 && unreadableKeyNoticeOpen

  /**
   * 打开「把其他槽位也改用它」：**此刻**把七个槽位的 from → to 算好。
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

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await llmListProviders()
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

  const assigned = SCENES.filter(sc => String(s[sc.key] ?? '').length > 0).length

  return (
    <div className="space-y-8">
      {/* 跨系统密文的解释性提示（Linux 平台化阶段 1）。走 Collapsible + .kb-collapse（铁律 13） */}
      <Collapsible open={keyNoticeVisible} className={keyNoticeVisible ? '-my-4' : ''} innerClassName="">{() => (
        <div className="flex items-start gap-2 rounded-md border border-[var(--border-color)] bg-[var(--warning-bg)] px-3 py-2">
          <AlertTriangle size={14} strokeWidth={1.7} className="mt-0.5 shrink-0 text-[var(--warning)]" />
          <div className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
            <b className="font-medium text-[var(--text-primary)]">{unreadableKeyCount} 个账号的 API Key 在本机无法解密。</b>
            这些 Key 由其他系统（Windows / macOS）的本机钥匙串加密，密钥不随设置迁移
            （本机钥匙串服务没运行时同样解不开）—— 在对应账号上重新填写 API Key 即可恢复；端点的地址、模型清单都不受影响。
          </div>
          <button
            type="button"
            onClick={() => setUnreadableKeyNoticeOpen(false)}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            知道了
          </button>
        </div>
      )}</Collapsible>

      {/* 供应商：常驻的**唯一**一层列表；加供应商收成一个按钮，8 个预设磁贴不再占首屏 */}
      <div>
        <div className="flex items-start justify-between gap-2 max-w-md">
          <SectionHead title="供应商" className="mb-3 min-w-0"
            hint="选择预设后仅需填写 API Key；如需修改接口地址、协议类型或请求头，点开端点行里的「自定义设置」。" />
          <button onClick={() => { setPresetForm(null); setPickerOpen(v => !v) }}
            aria-expanded={pickerOpen}
            className="flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
            <Plus size={13} /> 添加供应商
          </button>
        </div>

        <div className="max-w-md">
          {pickerOpen && (
            <PresetPicker
              onPick={id => { setPickerOpen(false); setPresetForm(id) }}
              onCcSwitch={() => setCcsOpen(true)}
            />
          )}

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

          <div className="space-y-2 mt-3">
            {providers.map(p => (
              <ProviderRow key={p.id} p={p} open={openId === p.id}
                onToggle={() => setOpenId(cur => (cur === p.id ? null : p.id))}
                onChanged={refresh} onAdopt={openAdopt}
                onSetDefault={async () => {
                  // 「设为默认端点」= 把对话默认模型指到这个端点的首个模型（与场景表同一真源）
                  const firstModel = p.models[0] ?? ''
                  void update('defaultChatModel', firstModel ? `${p.id}:${firstModel}` : '')
                  await refresh()
                }} />
            ))}
            {!loading && providers.length === 0 && (
              <p className="text-[12px] text-[var(--text-muted)] px-1 leading-relaxed">
                尚未配置供应商。点右上「＋ 添加供应商」选一个预设即可（只需粘 API Key）。
              </p>
            )}
          </div>
        </div>

        {ccsOpen && (
          <CcSwitchImportModal
            onClose={() => setCcsOpen(false)}
            onImported={async () => { setCcsOpen(false); await refresh() }}
          />
        )}
      </div>

      {/* 场景分配表（2026-10-13 按原型新增，2026-10-14 折叠成一行）：模型本来有三层作用域
          （本会话 ＞ AI 助手 ＞ 全局默认），而设置页只露了最底层那一层 —— 另外两处各自藏在
          助手面板与对话输入区里，改了默认模型却发现某处没变时无从解释。现在收成一张表。
          ★ anchorIds 必须列全组内**每一个**可搜索锚点：折叠后内层不挂载，只声明组头那一个，
            搜「图片视觉转写模型」会滚到一个收起的分组、什么都看不见。
          ★ className="max-w-md" 是 2026-10-15 的宽度对齐：`SettingsGroup` 的组头默认撑满内容列，
            比下面 max-w-md 的内容卡长一截（截图上右侧会多伸出两条长条），收进同一档之后
            整个 AI 模型页是一条等宽的列。**只在本页签收窄，其他页签的组头不动。** */}
      <div data-setting-anchor="aiTools.scenes">
        <SettingsGroup
          title="场景分配"
          summary={`已指定 ${assigned} / ${SCENES.length}`}
          className="max-w-md"
          anchorIds={['aiTools.scenes', 'aiTeach.visionModel', 'aiTools.imageModel', 'aiTools.imageEditModel']}
          hint="各场景可分别指定模型（这张表就是「哪个场景用哪个模型」）；留空表示跟随「对话默认模型」（见各行占位文字），显式指定后不再跟随。此处修改不影响单个对话的临时覆盖。">
          {adopt && (
            <AdoptCard who={adopt.who} rows={adopt.rows} applied={adopt.applied === true}
              onApply={() => { for (const r of adopt.rows) if (!r.noop) void update(r.key, r.to); setAdopt({ ...adopt, applied: true }) }}
              onUndo={() => { for (const r of adopt.rows) if (!r.noop) void update(r.key, r.from); setAdopt({ ...adopt, applied: false }) }}
              onCancel={() => setAdopt(null)} />
          )}
          <SceneTable providers={providers} freeSet={freeSet} onToggleFree={toggleFree} />
        </SettingsGroup>
      </div>

      {/* 原「高级」组（组内只有「单次 maxTokens 上限」一项）已于 2026-10-15 整体删除：
          那个上限不再由用户设置、也不再进设置搜索，组里没有别的内容 → 组头一并删掉，不留空壳。
          协议侧的新口径见 electron/lib/llmService.ts 的 buildOpenAiBody / buildOllamaBody /
          buildAnthropicBody 与 llmProtocolPure.buildResponsesBody。 */}

      {/* 免费模型标记：入口在选择器里（每个模型右侧的 ☆），不再另设手填清单 */}

      {/* AI 内联建议的开关与「自动触发」已按原型归位到「对话」页签（那是"怎么跑"）；
          它的**模型槽位**在场景分配表里（那是"用哪个模型"）。 */}
    </div>
  )
}

/* =========================================================================
   供应商列表 · 一行一物
   ========================================================================= */

function ProviderRow({ p, open, onToggle, onChanged, onSetDefault, onAdopt }: {
  p: LlmProviderInfo
  open: boolean
  onToggle: () => void
  onChanged: () => Promise<void>
  onSetDefault: () => Promise<void>
  /** 「把其他槽位也改用它…」——把模型槽位批量挪到这个账号所在的端点 */
  onAdopt: (pid: string, aid: string) => void
}) {
  const accounts = p.accounts ?? []
  const [testing, setTesting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  /**
   * 保存成功后把本行的 ⚡ 常显 3 秒（方案 §8 已定 1 的 B 形态）。
   * 零常驻成本，且正好命中「刚配完、还不知道往哪悬停」那一刻 —— 那也是本行动作唯一
   * 需要人发现的时刻。
   */
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** ⋯ 里点「手动添加模型」：展开本行**并**把编辑区的「模型清单」直接打开，别让人展开后再找一次 */
  const [wantModelList, setWantModelList] = useState(false)
  const { mounted } = usePresence(open, 220)

  useEffect(() => () => { if (peekTimer.current) clearTimeout(peekTimer.current) }, [])

  const startPeek = () => {
    setPeek(true)
    if (peekTimer.current) clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(() => setPeek(false), 3000)
  }

  /** 端点级 ⚡ 测的是**当前账号**：端点自身没有凭据，裸地址测不出能不能用 */
  const testActiveAccount = async () => {
    if (testing) return
    const acct = accounts.find(a => a.id === p.activeAccountId)
    if (!acct) {
      showToast({ type: 'error', message: '该端点还没有账号，点开先添加一个' })
      return
    }
    setTesting(true)
    try {
      const r = await llmTestAccount(p.id, acct.id)
      showToast(r.ok
        ? { type: 'info', message: `「${p.name} · ${acct.name}」连接成功（${r.latencyMs}ms）` }
        : { type: 'error', message: `「${acct.name}」测试失败：${r.error ?? '未知错误'}` })
      await onChanged()
    } finally { setTesting(false) }
  }

  const busy = testing

  return (
    <div className="kb-hoveronly-host rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => { setWantModelList(false); onToggle() }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWantModelList(false); onToggle() } }}
        className="group flex items-center gap-2 px-3.5 py-2.5 cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
      >
        <ChevronRight size={12} className={`kb-chevron shrink-0 text-[var(--text-muted)] ${open ? 'rotate-90' : ''}`} />
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.enabled ? 'bg-emerald-500' : 'bg-[var(--text-disabled)]'}`} />
        <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">{p.name}</span>
        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)]">{TYPE_LABEL[p.type]}</span>
        {p.isDefault && <Star size={12} className="shrink-0 text-yellow-400 fill-yellow-400" />}
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-muted)]">
          {accounts.length} 个账号 · {p.models.length > 0 ? `${p.models.length} 个模型` : '尚未获取模型'}
          {p.enabled ? '' : ' · 端点已停用'}
        </span>

        {/* 右侧动作：⚡ 悬停才显；⋯ 常显（它是这一行唯一的入口菜单）；开关常显
            （启停状态要一眼可见，收进 ⋯ 会让"端点已停用"变成翻菜单才知道） */}
        <button
          onClick={e => { e.stopPropagation(); void testActiveAccount() }}
          disabled={busy}
          title="测试当前账号连通性"
          aria-label="测试当前账号连通性"
          className={`kb-hoveronly ${peek ? 'is-peek' : ''} shrink-0 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors`}
        >
          {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
        </button>
        <RowMenuButton label="端点级操作">
          <MenuItem onClick={() => { void llmRefreshModels(p.id).then(r => { showToast(r.ok ? { type: 'info', message: `检测到 ${r.models.length} 个模型` } : { type: 'error', message: `刷新失败：${r.error}` }); return onChanged() }) }}>
            <RefreshCw size={11} /> 获取可用模型
          </MenuItem>
          <MenuItem onClick={() => { setWantModelList(true); if (!open) onToggle() }}>
            <Plus size={11} /> 手动添加模型
          </MenuItem>
          <MenuItem onClick={() => { void onSetDefault() }}>
            <Star size={11} /> 设为默认端点
          </MenuItem>
          <MenuSep />
          <MenuItem danger onClick={() => {
            if (!confirming) { setConfirming(true); setTimeout(() => setConfirming(false), 3000); return }
            void llmRemoveProvider(p.id).then(onChanged)
          }}>
            <Trash2 size={11} /> {confirming ? '再点一次：删除端点（含全部账号）' : '删除端点（含全部账号）'}
          </MenuItem>
        </RowMenuButton>
        <span className="shrink-0 pl-0.5" onClick={e => e.stopPropagation()}>
          <SettingSwitch checked={p.enabled} aria-label={`启用端点 ${p.name}`}
            onChange={() => { void llmToggleProvider(p.id, !p.enabled).then(onChanged) }} />
        </span>
      </div>

      {/* 不可用要说清因果：不是"暂时抽风"，是模型真的不会出现在选择器里。
          这一条**常显**（披露规范白名单③ 故障诊断）—— 收进折叠等于让人自己猜为什么选不到模型。 */}
      {!p.usable && (
        <p className="px-3.5 pb-2.5 text-[11px] leading-relaxed text-amber-400/90">
          该端点没有可用账号（均已停用或未配置 Key），其模型<b>不会出现在模型选择器</b>中。
        </p>
      )}

      {/* 展开 = 编辑：连体卡（同一张卡的下半截，不是又一张卡） */}
      <div className={`kb-collapse ${open ? 'open' : ''}`}>
        {open || mounted
          ? (
            <div className="border-t border-[var(--border-color)]">
              <ProviderEditor key={p.id} p={p} onChanged={onChanged} onSaved={startPeek}
                initialModelListOpen={wantModelList}
                onClose={onToggle} onAdopt={onAdopt} />
            </div>
          )
          : null}
      </div>
    </div>
  )
}

/**
 * 展开区（= 编辑器）。分两层状态：
 *   · **草稿**（名称 / 地址 / 协议 / 请求头 / 语义检索模型 / 新 Key）—— 本地 state，点「保存」才落盘；
 *   · **即时生效**（账号、模型清单、逐模型协议）—— 每个操作各自走 IPC 立即生效，与改造前一致
 *     （这些本来就没有"批量保存"的语义，硬做成草稿只会让人以为点了取消会回滚）。
 */
function ProviderEditor({ p, onChanged, onSaved, onClose, onAdopt, initialModelListOpen = false }: {
  p: LlmProviderInfo
  onChanged: () => Promise<void>
  /** 保存成功后通知外层把本行的 ⚡ 常显 3 秒 */
  onSaved: () => void
  onClose: () => void
  onAdopt: (pid: string, aid: string) => void
  /** ⋯「手动添加模型」进来时直接把「模型清单」打开 */
  initialModelListOpen?: boolean
}) {
  const [name, setName] = useState(p.name)
  const [apiKey, setApiKey] = useState('')
  const [type, setType] = useState<LlmProviderType>(p.type)
  const [baseUrl, setBaseUrl] = useState(p.baseUrl)
  const [embeddingModel, setEmbeddingModel] = useState(p.embeddingModel ?? '')
  const [headersText, setHeadersText] = useState(
    p.headers && Object.keys(p.headers).length ? JSON.stringify(p.headers) : '')
  const [saving, setSaving] = useState(false)
  const [advOpen, setAdvOpen] = useState(false)
  const [mlOpen, setMlOpen] = useState(initialModelListOpen)
  const [addingModel, setAddingModel] = useState(initialModelListOpen)
  const [famOpen, setFamOpen] = useState(false)
  const [draftTest, setDraftTest] = useState<LlmTestResultInfo | null>(null)
  const [testingDraft, setTestingDraft] = useState(false)
  const [switchingUrl, setSwitchingUrl] = useState(false)
  const [manualModel, setManualModel] = useState('')
  const [modelTest, setModelTest] = useState<Record<string, LlmModelTestResultInfo>>({})
  const [modelTesting, setModelTesting] = useState<string | null>(null)
  // 账号：操作即时生效（与改造前一致），所以只需记录"哪一行在忙 / 哪个表单开着"
  const [acctTesting, setAcctTesting] = useState<string | null>(null)
  const [acctForm, setAcctForm] = useState<{ mode: 'add' | 'rekey' | 'rename'; id?: string } | null>(null)
  const [acctName, setAcctName] = useState('')
  const [acctKey, setAcctKey] = useState('')

  const accounts = p.accounts ?? []
  /** 只有这个端点用的是 opencode 旧地址时才给「换官方地址」入口（旧地址表在文件头） */
  const officialUrl = officialUrlFor(p.baseUrl)

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

  /** 账号级 ⚡：与端点行的 ⚡ 同一个调用，但明确指定账号（端点行那个测的是当前账号） */
  const testAccount = async (a: LlmAccountInfo) => {
    if (acctTesting) return
    setAcctTesting(a.id)
    try {
      const r = await llmTestAccount(p.id, a.id)
      showToast(r.ok
        ? { type: 'info', message: `「${a.name}」连接成功（${r.latencyMs}ms）` }
        : { type: 'error', message: `「${a.name}」测试失败：${r.error ?? '未知错误'}` })
      await onChanged()
    } finally { setAcctTesting(null) }
  }

  /** 模型级测试：结果**行内**显示，不走 Toast —— 连着测两个模型时 Toast 会互相顶掉 */
  const testModelRow = async (m: string) => {
    if (modelTesting) return
    setModelTesting(m)
    try {
      const r = await llmTestModel(p.id, m)
      setModelTest(prev => ({ ...prev, [m]: r }))
    } finally { setModelTesting(null) }
  }

  const testDraftUrl = async () => {
    if (testingDraft || !baseUrl.trim()) return
    setTestingDraft(true)
    try { setDraftTest(await llmTestConnection({ type, baseUrl: baseUrl.trim(), id: p.id, accountId: p.activeAccountId })) }
    finally { setTestingDraft(false) }
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
      setBaseUrl(officialUrl)
      await onChanged()
    } finally { setSwitchingUrl(false) }
  }

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
        id: p.id, name: name.trim(), type, baseUrl: baseUrl.trim(),
        apiKey: apiKey || undefined, headers, embeddingModel: embeddingModel.trim() || undefined,
      })
      if (!r.ok) { showToast({ type: 'error', message: r.error ?? '保存失败' }); return }
      showToast({ type: 'info', message: `已保存「${name.trim()}」` })
      await onChanged()
      onSaved()
      onClose()
    } finally { setSaving(false) }
  }

  return (
    <div className="px-3.5 py-3">
      {/* 地址一行常显 + 复制：展开后第一眼要能确认"我连的是哪儿" */}
      <div className="flex items-center gap-2 mb-1.5">
        <code className="min-w-0 truncate text-[11.5px] text-[var(--text-muted)]">{p.baseUrl || '（未填写地址）'}</code>
        <button onClick={() => { void copyText(p.baseUrl).then(ok => showToast({ type: ok ? 'info' : 'error', message: ok ? '地址已复制' : '复制失败' })) }}
          className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
          <Copy size={10} /> 复制
        </button>
      </div>

      <FRow label="名称">
        <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
      </FRow>

      <FRow label="API 密钥">
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
          placeholder={p.type === 'ollama'
            ? '本地模型无需 API Key'
            : (p.hasKey ? '已配置 · 输入新值可替换' : '粘贴当前账号的 API Key')}
          disabled={p.type === 'ollama'}
          className={`${inputCls} font-mono`} />
      </FRow>

      {/* 自定义设置：地址 / 协议 / 请求头 / 语义检索模型。预设已填好地址与协议，所以默认收起 */}
      <FRow label="">
        <div className="w-full">
          <SubGroup title="自定义设置" summary="地址 · 协议 · 请求头 · 语义检索模型" open={advOpen} onToggle={() => setAdvOpen(v => !v)}>
            <div className="pl-[18px]">
              <FRow label="API 地址">
                <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="提供商默认" className={`${inputCls} font-mono`} />
                <button onClick={() => { void testDraftUrl() }} disabled={testingDraft || !baseUrl.trim()}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
                  {testingDraft && <Loader2 size={11} className="animate-spin" />} 测试地址
                </button>
              </FRow>
              {draftTest && (
                <div className={`pb-1 text-[11px] ${draftTest.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                  {draftTest.ok ? `✓ 该地址可达（${draftTest.latencyMs}ms）` : `✗ ${draftTest.error}`}
                </div>
              )}
              {officialUrl && (
                <p className="py-1.5 text-[11px] leading-relaxed">
                  <span className="text-[var(--text-muted)]">当前为 opencode 旧地址，官方已调整为 </span>
                  <span className="font-mono text-[var(--text-secondary)]">{officialUrl}</span>
                  <span className="text-[var(--text-muted)]">（模型数量多 10 个）。</span>
                  <button onClick={() => { void switchToOfficial() }} disabled={switchingUrl}
                    className="ml-1.5 px-1.5 py-0.5 rounded border border-[var(--accent)]/50 text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40 transition-colors">
                    {switchingUrl ? '替换中…' : '切换为官方地址'}
                  </button>
                </p>
              )}
              <FRow label="协议类型">
                <select value={type} onChange={e => setType(e.target.value as LlmProviderType)} className={inputCls}>
                  <option value="openai-compatible">OpenAI 兼容 · /chat/completions（DeepSeek / Moonshot / Qwen / GLM…）</option>
                  <option value="openai-responses">OpenAI Responses · /responses（GPT / Grok / Muse Spark 等）</option>
                  <option value="anthropic">Anthropic Messages · /messages（Claude 系列）</option>
                  <option value="ollama">Ollama 本地（http://localhost:11434）</option>
                </select>
              </FRow>
              <FRow label="请求头">
                <input value={headersText} onChange={e => setHeadersText(e.target.value)}
                  placeholder='{"头名":"值"}' className={`${inputCls} font-mono`} />
                <HelpHint text="按对话覆盖：填任何非空值即可，实际发送的是当前对话的 ID。" />
              </FRow>
              <FRow label="语义检索模型">
                <input value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)}
                  placeholder="如 text-embedding-3-small" className={`${inputCls} font-mono`} />
              </FRow>
            </div>
          </SubGroup>
        </div>
      </FRow>

      {/* 账号：同一端点、多把 Key。切账号只改 activeAccountId —— 模型 spec 指向端点 id，
          所以下面那些模型槽位一处都不用改。 */}
      <FRow label="">
        <div className="w-full pb-1 pt-1">
          <div className="flex items-center gap-1.5 mb-1 text-[11.5px] text-[var(--text-muted)]">
            账号
            <HelpHint text="同一端点的第二个账号复用地址、请求头与模型清单，仅 API Key 不同；两把 Key 分别加密存储，互不覆盖。" />
          </div>
          {accounts.map(a => {
            const isOn = a.id === p.activeAccountId
            const status = [
              a.lastLatencyMs != null ? `${a.lastLatencyMs}ms` : '未测过',
              relTime(a.lastTestedAt),
            ].filter(Boolean).join(' · ')
            return (
              <div key={a.id}
                className={`kb-hoveronly-host flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors ${
                  isOn ? 'bg-[var(--accent)]/5' : 'hover:bg-[var(--bg-hover)]'
                } ${a.enabled ? '' : 'opacity-60'}`}>
                <button onClick={() => { void acctAction(() => llmSetActiveAccount(p.id, a.id), `已切换到账号「${a.name}」`) }}
                  title={isOn ? '当前使用中' : '切换到这个账号'} aria-label={`切换到账号 ${a.name}`}
                  className={`w-3 h-3 rounded-full border shrink-0 transition-colors ${isOn ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--text-disabled)] hover:border-[var(--accent)]'}`} />
                <span className="text-[12px] text-[var(--text-primary)] truncate">{a.name}</span>
                {isOn && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--accent)]/40 text-[var(--accent)]">使用中</span>}
                {a.keyUnreadable
                  ? <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--danger)]/40 text-[var(--danger)]" title="Key 密文由其他系统加密，本机解不开；重新填写该账号的 API Key 即可恢复">Key 无法解密</span>
                  : a.hasKey || p.type === 'ollama'
                    ? <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-400">{p.type === 'ollama' ? '无需 Key' : '已配置 Key'}</span>
                    : <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-400">无 Key</span>}
                {!a.enabled && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-disabled)]">已停用</span>}
                <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-[var(--text-muted)]">{status}</span>
                <button onClick={() => { void testAccount(a) }} disabled={acctTesting !== null}
                  title="测试这个账号" aria-label={`测试账号 ${a.name}`}
                  className="kb-hoveronly shrink-0 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
                  {acctTesting === a.id ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                </button>
                <AccountMenu p={p} a={a} onAdopt={onAdopt} acctAction={acctAction} testAccount={testAccount}
                  onForm={f => { setAcctForm(f); setAcctKey(''); setAcctName(f.mode === 'rename' ? a.name : '') }} />
              </div>
            )
          })}

          {acctForm ? (
            <div className="mt-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                {acctForm.mode !== 'rekey' && (
                  <input value={acctName} onChange={e => setAcctName(e.target.value)}
                    placeholder={acctForm.mode === 'add' ? '账号名称，例如 工作号' : '新名称'}
                    className="w-32 shrink-0 px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]" />
                )}
                {acctForm.mode !== 'rename' && (
                  <input type="password" value={acctKey} onChange={e => setAcctKey(e.target.value)} placeholder="填写该账号的 API Key"
                    className="flex-1 min-w-[180px] px-2 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] font-mono outline-none focus:border-[var(--accent)]" />
                )}
                <button disabled={acctTesting !== null} onClick={() => { void saveAcctForm() }}
                  className="shrink-0 px-3 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">保存</button>
                <button onClick={() => setAcctForm(null)}
                  className="shrink-0 px-3 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
              </div>
            </div>
          ) : (
            <button onClick={() => { setAcctForm({ mode: 'add' }); setAcctName(''); setAcctKey('') }}
              className="mt-1.5 w-full px-2 py-1.5 rounded-md border border-dashed border-[var(--border-color)] text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]/50 transition-colors">
              ＋ 添加账号（同一端点，换个 Key）
            </button>
          )}
        </div>
      </FRow>

      {/* 模型目录 */}
      <FRow label="">
        <div className="w-full pb-1 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-[var(--text-muted)]">模型目录 · {p.models.length} 个</span>
            <button onClick={() => { void llmRefreshModels(p.id).then(r => { showToast(r.ok ? { type: 'info', message: `检测到 ${r.models.length} 个模型` } : { type: 'error', message: `刷新失败：${r.error}` }); return onChanged() }) }}
              className="ml-auto shrink-0 px-2 py-0.5 rounded-md text-[11px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              获取可用模型
            </button>
          </div>

          <SubGroup title="模型清单"
            summary={p.models.length ? `${p.models.slice(0, 3).join(' · ')}${p.models.length > 3 ? ' …' : ''}` : '目录外 ID 仍可直接发送'}
            open={mlOpen} onToggle={() => setMlOpen(v => !v)}>
            <div className="pl-[18px]">
              {p.models.length === 0 && (
                <p className="py-1 text-[11px] text-[var(--text-muted)]">还没有模型清单，点上方「获取可用模型」拉一次；也可以直接手填 ID。</p>
              )}
              {p.models.map(m => {
                const t = modelTest[m]
                return (
                  <div key={m} className="kb-hoveronly-host flex items-center gap-2 py-1">
                    <code className="min-w-0 flex-1 truncate text-[11.5px] font-mono text-[var(--text-secondary)]" title={m}>{m}</code>
                    {t && (
                      <span className={`shrink-0 text-[10.5px] ${t.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                        {t.ok ? `✓ 可用（${t.latencyMs}ms）` : `✗ ${t.error}`}
                      </span>
                    )}
                    <button onClick={() => { void testModelRow(m) }} disabled={modelTesting !== null}
                      title="测试这个模型" aria-label={`测试模型 ${m}`}
                      className="kb-hoveronly shrink-0 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
                      {modelTesting === m ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                    </button>
                  </div>
                )
              })}
              {addingModel ? (
                <div className="flex items-center gap-1 mt-1.5">
                  <input value={manualModel} onChange={e => setManualModel(e.target.value)}
                    autoFocus placeholder="输入模型 ID"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && manualModel.trim()) {
                        void llmAddModel(p.id, manualModel.trim()).then(r => {
                          if (r.ok) { showToast({ type: 'info', message: `已添加模型 ${manualModel.trim()}` }); setManualModel(''); setAddingModel(false); return onChanged() }
                          showToast({ type: 'error', message: r.error ?? '添加失败' })
                        })
                      }
                    }}
                    className="flex-1 min-w-0 px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--input-bg)] text-[11px] font-mono outline-none focus:border-[var(--accent)]" />
                  <button disabled={!manualModel.trim()}
                    onClick={() => { void llmAddModel(p.id, manualModel.trim()).then(r => { if (r.ok) { showToast({ type: 'info', message: '已添加模型' }); setManualModel(''); setAddingModel(false); return onChanged() } showToast({ type: 'error', message: r.error ?? '添加失败' }) }) }}
                    className="shrink-0 px-2 py-1 rounded text-[11px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">添加</button>
                  <button onClick={() => { setAddingModel(false); setManualModel('') }}
                    className="shrink-0 px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">取消</button>
                </div>
              ) : (
                <button onClick={() => setAddingModel(true)}
                  className="mt-1.5 w-full px-2 py-1.5 rounded-md border border-dashed border-[var(--border-color)] text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]/50 transition-colors">
                  ＋ 添加模型
                </button>
              )}
            </div>
          </SubGroup>

          {p.models.length > 0 && (
            <ModelFamilyPanel p={p} onChanged={onChanged} open={famOpen} onToggle={() => setFamOpen(v => !v)} />
          )}
        </div>
      </FRow>

      {/* 底部动作（右对齐，DSH 口径）：取消=只收起草稿，保存=落盘 */}
      <div className="flex items-center justify-end gap-2 pt-3 mt-1 border-t border-[var(--border-color)]">
        <button onClick={onClose}
          className="px-3.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
        <button onClick={() => { void save() }} disabled={saving}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
          {saving && <Loader2 size={12} className="animate-spin" />} 保存
        </button>
      </div>
    </div>
  )
}

/** 账号行的 ⋯ 菜单：动作都即时生效，所以只把「哪个表单开着」交给外层 */
function AccountMenu({ p, a, onAdopt, acctAction, testAccount, onForm }: {
  p: LlmProviderInfo
  a: LlmAccountInfo
  onAdopt: (pid: string, aid: string) => void
  acctAction: (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => Promise<void>
  testAccount: (a: LlmAccountInfo) => Promise<void>
  onForm: (f: { mode: 'add' | 'rekey' | 'rename'; id?: string }) => void
}) {
  return (
    <RowMenuButton label={`账号操作 ${a.name}`} size={13} className="kb-hoveronly">
      <MenuItem onClick={() => { void testAccount(a) }}>
        <Zap size={11} /> 测试这个账号
      </MenuItem>
      <MenuItem onClick={() => onForm({ mode: 'rekey', id: a.id })}>
        <KeyRound size={11} /> 更换 API Key
      </MenuItem>
      <MenuItem onClick={() => onForm({ mode: 'rename', id: a.id })}>
        <Pencil size={11} /> 重命名账号
      </MenuItem>
      <MenuSep />
      {/* 批量把模型槽位挪到这个端点：改动卡出现在「场景分配」那个折叠组里 */}
      <MenuItem onClick={() => onAdopt(p.id, a.id)}>
        <ChevronRight size={11} /> 将其他槽位改用此账号…
      </MenuItem>
      <MenuSep />
      <MenuItem onClick={() => { void acctAction(() => llmUpdateAccount({ providerId: p.id, accountId: a.id, enabled: !a.enabled }), a.enabled ? `已停用「${a.name}」（Key 保留）` : `已启用「${a.name}」`) }}>
        {a.enabled ? <><X size={11} /> 停用（Key 保留）</> : <><Check size={11} /> 启用</>}
      </MenuItem>
      <MenuItem danger onClick={() => { void acctAction(() => llmRemoveAccount(p.id, a.id), `已删除账号「${a.name}」及其 Key`) }}>
        <Trash2 size={11} /> 删除账号与 Key…
      </MenuItem>
    </RowMenuButton>
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

/** 编辑区里的一行（标签定宽 + 控件），对应原型的 .f-row / .f-label / .f-ctl */
function FRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 py-[7px] border-t border-[var(--border-color)] first:border-t-0 first:pt-0">
      {label ? <span className="w-[88px] shrink-0 text-[12px] text-[var(--text-secondary)]">{label}</span> : null}
      <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
    </div>
  )
}

/** 嵌套折叠（自定义设置 / 模型清单 / 逐模型协议）：比 SettingsGroup 更紧，没有 ⓘ 位 */
function SubGroup({ title, summary, open, onToggle, children }: {
  title: string
  summary?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="w-full flex items-center gap-1.5 py-2 text-left">
        <ChevronRight size={12} className={`kb-chevron shrink-0 text-[var(--text-muted)] ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">{title}</span>
        {summary ? <span className="ml-auto min-w-0 truncate text-[11px] text-[var(--text-muted)]">{summary}</span> : null}
      </button>
      <Collapsible open={open} innerClassName="">{() => children}</Collapsible>
    </>
  )
}

/* =========================================================================
   预设选择器 + 添加表单
   ========================================================================= */

/** 「＋ 添加供应商」点开的选择器：8 个预设 + 最后一行 CC Switch 导入 */
function PresetPicker({ onPick, onCcSwitch }: { onPick: (id: string) => void; onCcSwitch: () => void }) {
  return (
    <div className="mt-3 p-3 grid grid-cols-2 gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] kb-pop">
      {LLM_PRESETS.map(pr => (
        <button key={pr.id} onClick={() => onPick(pr.id)}
          title={pr.base || '自定义端点：地址与类型自己填'}
          className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] hover:border-[var(--accent)] hover:bg-[var(--bg-hover)] text-left transition-colors">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: pr.color }} />
          <span className="min-w-0">
            <span className="block text-[12px] text-[var(--text-primary)] truncate">{pr.name}</span>
            <span className="block text-[10.5px] text-[var(--text-muted)] truncate">{pr.sub}</span>
          </span>
        </button>
      ))}
      <div className="col-span-2 flex items-center justify-between gap-2 pt-0.5">
        <button onClick={onCcSwitch}
          className="flex items-center gap-1 text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
          <Import size={12} /> 从 CC Switch 导入
        </button>
        <span className="text-[11px] text-[var(--text-muted)]">选中预设 → 只差粘一个 Key</span>
      </div>
    </div>
  )
}

/**
 * 预设添加表单（2026-10-13，按原型 tmp/ai-settings-proto）。
 *
 * 与端点编辑区的分工：预设已经把**地址 / 类型 / 必需的请求头**填好了，用户只剩「粘 Key」
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

  return (
    <div className="mt-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] kb-pop">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: preset.color }} />
        <span className="text-[13px] font-medium text-[var(--text-primary)]">添加「{preset.name}」</span>
        <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--accent)]/40 text-[var(--accent)]">
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

      <FRow label="名称">
        <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
      </FRow>
      <FRow label={isLocal ? 'API Key（本地可留空）' : 'API Key'}>
        <input type="password" value={apiKey} disabled={isLocal} onChange={e => setApiKey(e.target.value)}
          placeholder={isLocal ? '本地模型无需 API Key' : '填写 API Key（加密写入磁盘，之后不可回读）'} className={`${inputCls} font-mono`} />
      </FRow>
      <FRow label={preset.modelInput === 'endpoint' ? '接入点 ID' : '模型 ID'}>
        <input value={model} onChange={e => setModel(e.target.value)}
          placeholder={preset.modelInput === 'endpoint' ? 'ep-2026…' : '可选，例如 deepseek-chat'} className={`${inputCls} font-mono`} />
      </FRow>

      <p className="pt-2 text-[11px] text-[var(--text-muted)] leading-relaxed">
        接口地址：<span className="font-mono text-[var(--text-secondary)]">{preset.base || '（自定义，请展开「高级」填写）'}</span>
      </p>

      {preset.srcConfig && (
        <p className="pt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-400 text-[10px]">按官方文档</span>
          地址与会话头取自 opencode 官方 Go 端点表。旧地址 <code>https://opencode.ai/zen/go/v1</code> 仍可用，但模型数量少 10 个；切换前请先「测试地址」确认该 Key 在新路径可用。
        </p>
      )}
      {preset.unverified && (
        <p className="pt-2 text-[11px] leading-relaxed text-amber-400/90">
          该地址未经在线核实，请核对后使用。
        </p>
      )}

      <button onClick={() => setAdv(v => !v)} aria-expanded={adv}
        className="mt-3 flex items-center gap-1 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
        <ChevronRight size={12} className={`kb-chevron ${adv ? 'rotate-90' : ''}`} />
        高级（接口地址 / 类型 / 语义检索模型 / 自定义请求头）
      </button>
      <Collapsible open={adv} innerClassName="">
        {() => (
          <div className="mt-2.5 pt-2.5 border-t border-[var(--border-color)]">
            <FRow label="接口地址">
              <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className={`${inputCls} font-mono`} />
            </FRow>
            <FRow label="协议类型">
              <select value={type} onChange={e => setType(e.target.value as LlmProviderType)} className={inputCls}>
                {(['openai-compatible', 'anthropic', 'openai-responses', 'ollama'] as LlmProviderType[]).map(t => (
                  <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                ))}
              </select>
            </FRow>
            <FRow label="语义检索模型">
              <input value={embeddingModel} onChange={e => setEmbeddingModel(e.target.value)}
                placeholder="如 text-embedding-3-small" className={`${inputCls} font-mono`} />
            </FRow>
            <FRow label="自定义请求头">
              <input value={headersText} onChange={e => setHeadersText(e.target.value)}
                placeholder='{"头名":"值"}' className={`${inputCls} font-mono`} />
            </FRow>
          </div>
        )}
      </Collapsible>

      <div className="flex items-center justify-end gap-2 pt-3 mt-1 border-t border-[var(--border-color)]">
        <button onClick={onCancel}
          className="px-3.5 py-1.5 rounded-md text-[12px] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
        <button onClick={() => { void save() }} disabled={saving}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
          {saving && <Loader2 size={12} className="animate-spin" />} 保存
        </button>
      </div>
    </div>
  )
}

/* =========================================================================
   逐模型协议
   ========================================================================= */

/**
 * 逐模型协议面板（2026-10-13，2026-10-14 折进编辑区）。
 *
 * 存在的理由：opencode Go 官方口径是 "Each model is served by one API family" —— 同一个
 * baseUrl、同一把 Key 下，模型分属 `/chat/completions`、`/messages`、`/responses` 三条路径。
 * 所以协议必须能按模型覆盖；能一键按官方端点表预填，用户就不必手工标 32 个模型。
 */
function ModelFamilyPanel({ p, onChanged, open, onToggle }: {
  p: LlmProviderInfo
  onChanged: () => Promise<void>
  open: boolean
  onToggle: () => void
}) {
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
    <SubGroup title="逐模型协议"
      summary={marked > 0 ? `${marked} 个单独指定` : '按官方端点表一键预填'}
      open={open} onToggle={onToggle}>
      <div className="pl-[18px]">
        <div className="flex items-center gap-2 flex-wrap py-1 text-[11px] text-[var(--text-muted)]">
          <span>
            默认 {fallback ? FAMILY_LABEL[fallback] : 'Ollama 原生'}
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
        </div>
        <div className="mt-1.5 rounded-md border border-[var(--border-color)] max-h-56 overflow-y-auto">
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
      </div>
    </SubGroup>
  )
}

/* =========================================================================
   场景分配表
   ========================================================================= */

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
  /** 采纳卡上的「已应用」标记（撤销要能回到原值） */
  applied?: boolean
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
    <div className="mb-3 px-3.5 py-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-secondary)]">
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
        单个对话自身的模型覆盖不在此列，属于该对话的独立设置。
      </p>
    </div>
  )
}

function SceneTable({ providers, freeSet, onToggleFree }: {
  providers: LlmProviderInfo[]
  freeSet: Set<string>
  onToggleFree: (modelId: string) => void
}) {
  const [visionSpecs, setVisionSpecs] = useState<Set<string>>(new Set())

  // 视觉转写那行的候选要收窄到"疑似支持图片"的模型（主进程按 VISION_MODEL_RE 过滤）
  useEffect(() => {
    let alive = true
    void llmVisionModels()
      .then(r => { if (alive) setVisionSpecs(new Set((r.models ?? []).map(m => m.spec))) })
      .catch(() => { if (alive) setVisionSpecs(new Set()) })
    return () => { alive = false }
  }, [])

  return (
    <div className="max-w-md rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-0.5">
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
  )
}

/** 场景表的一行：标签 + ⓘ 释义 + 选择器 + 悬停才显的「测试这个模型」+ 行内结果 */
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
    <div className="kb-hoveronly-host flex items-center gap-2.5 py-[5px] border-t border-[var(--border-color)] first:border-t-0">
      <span className="w-[116px] shrink-0 flex items-center gap-1 text-[12px] text-[var(--text-primary)]">
        <span className="truncate">{sc.label}</span>
        <HelpHint text={sc.desc} />
      </span>
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
      </div>
      {out && <span title={out} className={`shrink-0 max-w-[45%] truncate text-[10.5px] ${out.startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>{out}</span>}
      <button onClick={() => { void testModel() }} disabled={!cur || testing}
        title="用当前选中的模型发一次最小请求" aria-label={`测试模型 ${sc.label}`}
        className="kb-hoveronly shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors">
        {testing && <Loader2 size={11} className="animate-spin" />} 测试这个模型
      </button>
    </div>
  )
}

/* =========================================================================
   CC Switch 导入弹层（**观察期**：整条线可能随下个版本清理，见 docs/ai-settings-v2-plan.md §9。
   本轮只把它收进「＋ 添加供应商」的选择器里，不动实现）
   ========================================================================= */

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
