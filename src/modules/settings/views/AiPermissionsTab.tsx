import { useEffect, useState } from 'react'
import { AlertTriangle, FileText, Terminal } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import { HelpHint } from '../../../components/shared/HelpHint'
import { SectionHead } from './SectionHead'
import { aiPermissionGet, aiPolicySet, aiTrustRevoke, aiTrustSet } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { AI_FILE_PRESETS, AI_PRESET_DESCS, AI_PRESET_LABELS, AI_PRESET_WRITE_EXTS } from '../../../lib/aiFilePolicyShared'
import type { AiFilePreset, AiPermissionState } from '../../../types'
// 模块清单、档位语义、解析都在纯模块里（零依赖）—— 契约脚本要真跑那几条规则
import { MODULES, PERM_LABEL, parsePerms, presetModulePerms } from '../../../lib/aiPermPresets'
import type { Perm, PermPreset } from '../../../lib/aiPermPresets'
import { VOCAB_ENTRY_ENABLED } from '../../../lib/featureFlags'

/**
 * 三态分段控件（2026-10-13 按原型：下拉 → 分段控件）。
 *
 * 改它的理由不是好看：原来每个模块都是两步（点开下拉 → 再选一项），
 * 8 个模块 + 仓库文件想扫一遍状态得点开每一行；分段控件一次点击就切换，
 * 而且**整列状态一眼扫得完**（哪几个是读写、哪几个被关掉）。
 */
function PermCtl({ cur, onChange, writeDead }: { cur: Perm; onChange: (p: Perm) => void; writeDead?: boolean }) {
  const opts: Perm[] = ['off', 'read', 'write']
  return (
    <span className="flex items-center rounded-md border border-[var(--border-color)] overflow-hidden shrink-0">
      {opts.map(o => {
        const on = cur === o
        const dead = o === 'write' && writeDead
        const onCls = o === 'write'
          ? 'bg-amber-500/20 text-amber-300'
          : o === 'off'
            ? 'bg-zinc-500/20 text-[var(--text-secondary)]'
            : 'bg-[var(--accent)]/15 text-[var(--accent)]'
        return (
          <button key={o} disabled={dead} data-tip={dead ? '该模块暂无写操作' : undefined} aria-label={dead ? '该模块暂无写操作' : undefined}
            onClick={() => onChange(o)}
            aria-pressed={on}
            className={`px-2.5 py-1 text-[11.5px] border-l border-[var(--border-color)] first:border-l-0 transition-colors ${
              on ? onCls : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            } disabled:opacity-30 disabled:cursor-not-allowed`}>
            {PERM_LABEL[o]}
          </button>
        )
      })}
    </span>
  )
}

/** 权限页的一行：模块名 + ⓘ 释义 + 三态控件。9 行共用一张卡，行间用分隔线（不再各自一张卡） */
function PermRow({ icon, label, hint, ctl, active }: {
  icon?: React.ReactNode
  label: string
  hint: string
  ctl: React.ReactNode
  active: boolean
}) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-t border-[var(--border-color)] first:border-t-0">
      {icon ? <span className={`shrink-0 ${active ? 'text-[var(--accent)]' : 'text-[var(--text-disabled)]'}`}>{icon}</span> : null}
      <span className="min-w-0 flex-1 flex items-center gap-1.5">
        <span className={`truncate text-[13px] ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{label}</span>
        <HelpHint text={hint} />
      </span>
      {ctl}
    </div>
  )
}

/** 设置 → AI → 权限：按模块 + 仓库文件域控制 AI 能动什么 */
export function AiPermissionsTab() {
  const { s, update } = useSettings()
  const perms = parsePerms(s.aiModulePermissions ?? '{}')
  // v3.17.0 背单词暂不开放：权限行一并收起；MODULES 仍保留，适配完成后由总闸恢复
  const visibleModules = VOCAB_ENTRY_ENABLED ? MODULES : MODULES.filter(m => m.id !== 'vocab')
  const anyWrite = MODULES.some(m => perms[m.id] === 'write') || s.aiVaultFilePerm === 'write'
  const vaultPerm: Perm = s.aiVaultFilePerm === 'off' || s.aiVaultFilePerm === 'read' || s.aiVaultFilePerm === 'write' ? s.aiVaultFilePerm : 'read'
  const terminalAiExec = s.terminalAiExec === true
  /** 「完全信任」是不可忽视的一步：点一次变成"再点一次确认"（铁律 25：确认行内化，不弹模态） */
  const [confirmAll, setConfirmAll] = useState(false)

  const setPerm = (moduleId: string, perm: Perm) => {
    const next = { ...perms, [moduleId]: perm }
    void update('aiModulePermissions', JSON.stringify(next))
    showToast({ type: 'info', message: `已将「${MODULES.find(m => m.id === moduleId)?.label}」对 AI 设为${PERM_LABEL[perm]}` })
  }

  const setVaultPerm = (perm: Perm) => {
    void update('aiVaultFilePerm', perm)
    showToast({ type: 'info', message: `已将「仓库文件」对 AI 设为${PERM_LABEL[perm]}` })
  }

  /**
   * 权限预设（原型三个档位）。原文案：「原来只能对 8 个模块 + 仓库文件逐个点下拉（每个两步），
   * 想"全部关掉"要操作 18 次。」
   * 档位语义住在 lib/aiPermPresets.ts（纯函数，契约脚本真跑）；
   * 「最保守」还要把**仓库文件**一起收回只读 —— 只改模块不改它等于没保守住。
   */
  const applyPreset = (mode: PermPreset) => {
    void update('aiModulePermissions', JSON.stringify(presetModulePerms(mode)))
    if (mode === 'safe') void update('aiVaultFilePerm', 'read')
    setConfirmAll(false)
    showToast({
      type: mode === 'all' ? 'warning' : 'info',
      message: mode === 'safe' ? '已应用「最保守」预设：全部模块只读，仓库文件一并收回只读'
        : mode === 'daily' ? '已应用「日常」预设：日程与记账可写，其余只读'
          : '已应用「完全信任」预设：有写操作的模块全部可读写',
    })
  }

  const presetBtn = 'px-2.5 py-1.5 rounded-md text-[12px] border transition-colors'

  return (
    <div className="space-y-8 max-w-md">
      {/* 权限预设 */}
      <div>
        <SectionHead title="权限预设" hint="先选择一个档位批量应用，再按模块单独调整。" />
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => applyPreset('safe')} className={`${presetBtn} border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]`}>
            最保守 · 全部只读
          </button>
          <button onClick={() => applyPreset('daily')} className={`${presetBtn} border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]`}>
            日常 · 读 + 日程/记账可写
          </button>
          <button
            onClick={() => {
              if (!confirmAll) { setConfirmAll(true); setTimeout(() => setConfirmAll(false), 3000); return }
              applyPreset('all')
            }}
            className={`${presetBtn} ${confirmAll ? 'border-red-500 text-red-400 hover:bg-red-500/10' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:text-amber-300 hover:bg-[var(--bg-hover)]'}`}>
            {confirmAll ? '再点一次：完全信任' : '完全信任 · 全部可读写'}
          </button>
        </div>
        {anyWrite && (
          <div className="flex items-start gap-2 mt-3 px-3 py-2.5 rounded-md bg-yellow-500/10 border border-yellow-600/40">
            <AlertTriangle size={15} className="text-yellow-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-yellow-200/90 leading-relaxed">
              AI 的写操作将<b>直接生效</b>（新建日记与待办、修改知识库页面），不会逐次请求确认。请仅在可信场景下开启。
            </p>
          </div>
        )}
      </div>

      {/* AI 能做什么（2026-10-14 改造）：9 行收进**一张卡**，每行只剩「模块名 + ⓘ + 三态控件」。
          改造前每行名称下面都挂一行 11px 常显描述（合计 154 字），整页读起来像一份说明书；
          文案一字不删，全部进 ⓘ —— 而且比原来更全：读写档的说明也写在一起了
          （原先是"选了读写才把那行字换掉"，等于另一半永远看不到）。 */}
      <div>
        <SectionHead title="AI 能做什么"
          hint={<><b>禁止</b>：相关工具不进入 AI 的工具列表；<b>只读</b>：仅可查询与阅读；<b>读写</b>：可新建、修改、删除，均记入审计日志。灰色「读写」表示该模块暂无写操作。</>} />

        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5">
          <PermRow
            icon={<FileText size={14} />}
            active={vaultPerm !== 'off'}
            label="仓库文件"
            hint="列目录与阅读仓库内文本类文件；设为读写后可新建、覆写、局部编辑、重命名与移动（删除走回收站）。"
            ctl={<PermCtl cur={vaultPerm} onChange={setVaultPerm} />}
          />
          {visibleModules.map(m => {
            const cur: Perm = perms[m.id] ?? 'read'
            return (
              <PermRow
                key={m.id}
                active={cur !== 'off'}
                label={m.label}
                hint={m.writeDesc ? `${m.desc}；设为读写后可${m.writeDesc}。` : `${m.desc}（该模块暂无写操作。）`}
                ctl={<PermCtl cur={cur} onChange={p => setPerm(m.id, p)} writeDead={!m.writeDesc} />}
              />
            )
          })}
        </div>
      </div>

      {/* AI 终端执行（2026-10-13）。
          schema 里 terminalAiExec 一直是 ui:true + anchor:'terminal.aiExec' + aiTab:'perms'，
          但**从未在任何视图渲染过** —— 设置搜索能搜到它、点进去却没有落点，实际只能手改
          settings.json。它是安全开关（level:'danger'），所以现在补上落点并把两道门的关系写清。 */}
      <div data-setting-anchor="terminal.aiExec">
        <SectionHead title="终端执行" className="mb-1"
          hint={<>开启后 AI 方可申请 <code>builtin.terminal.exec</code> 执行命令，<b>每条命令均需先在终端模块的「AI 执行记录」中行内确认</b>（高危命令给出严重警告）。本开关与模块权限中的「终端」是两道独立的门：本开关决定工具<b>是否存在</b>，模块权限决定其<b>可读或可写</b>，两者均开启后才可使用。</>} />
        <div className="mt-3">
          <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] cursor-pointer">
            <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
              <Terminal size={14} className={terminalAiExec ? 'text-[var(--accent)]' : 'text-[var(--text-disabled)]'} />
              允许 AI 申请执行终端命令
            </span>
            <SettingSwitch
              checked={terminalAiExec}
              onChange={v => {
                void update('terminalAiExec', v)
                showToast({ type: v ? 'warning' : 'info', message: v ? '已允许 AI 申请执行终端命令（每条命令仍需行内确认）' : '已禁止 AI 使用终端工具' })
              }}
              aria-label="AI 终端执行"
            />
          </label>
        </div>
      </div>

      {/* 当前工作区（P0-B，v3.31.0）：三层权限的第二/三层落点。
          一次性卡只在首次提问；这里是可以随时改 / 撤销的常驻入口。 */}
      <WorkspaceTrustSection />
    </div>
  )
}

/**
 * 当前工作区的信任与文件策略。
 *
 * 与助手面板顶部的「一次性卡」是同一份状态：卡负责首次询问，这里负责事后修改与撤销；
 * 撤销后 trust 回到 null，下次写文件会重新出现一次性卡。
 */
function WorkspaceTrustSection() {
  const [state, setState] = useState<AiPermissionState | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => { void aiPermissionGet().then(setState).catch(() => setState(null)) }
  useEffect(() => { load() }, [])
  useDataChanged('aiAssistant', load)

  if (!state) {
    return (
      <div data-setting-anchor="aiWorkspaceTrust">
        <SectionHead title="当前工作区" hint="打开一个仓库后，可在这里单独授权或撤销 AI 的写文件 / 执行命令能力。" />
        <p className="mt-3 text-[11.5px] text-[var(--text-muted)]">尚未打开仓库。</p>
      </div>
    )
  }

  const setTrust = async (patch: { fileWrite?: 'allow' | 'deny' | null; shellExec?: 'allow' | 'deny' | null }): Promise<void> => {
    setBusy(true)
    try {
      await aiTrustSet(patch)
      showToast({ type: 'info', message: '工作区授权已更新' })
      load()
    } finally { setBusy(false) }
  }

  const setPreset = async (preset: AiFilePreset): Promise<void> => {
    setBusy(true)
    try {
      await aiPolicySet({ ...(state.policy.overrides ?? {}), preset })
      showToast({ type: 'success', message: `可写类型已切换为：${AI_PRESET_LABELS[preset]}` })
      load()
    } finally { setBusy(false) }
  }

  const revoke = async (): Promise<void> => {
    setBusy(true)
    try {
      await aiTrustRevoke()
      showToast({ type: 'info', message: '已撤销本工作区授权', detail: '下次使用写文件 / 命令时会重新询问' })
      load()
    } finally { setBusy(false) }
  }

  const levelOf = (v: 'allow' | 'deny' | null, onPick: (n: 'allow' | 'deny' | null) => void): React.ReactNode => (
    <span className="flex items-center rounded-md border border-[var(--border-color)] overflow-hidden shrink-0">
      {([['allow', '允许'], ['deny', '禁止'], [null, '未设置']] as const).map(([val, label]) => {
        const on = v === val
        return (
          <button key={String(val)} onClick={() => onPick(val)} disabled={busy}
            aria-pressed={on}
            className={`px-2.5 py-1 text-[11.5px] border-l border-[var(--border-color)] first:border-l-0 transition-colors ${
              on
                ? val === 'allow' ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                  : val === 'deny' ? 'bg-zinc-500/20 text-[var(--text-secondary)]'
                    : 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            } disabled:opacity-40`}>
            {label}
          </button>
        )
      })}
    </span>
  )

  const preset = state.policy.effective.preset
  const extCount = preset === 'custom'
    ? state.policy.effective.writeExts.length
    : (AI_PRESET_WRITE_EXTS[preset as Exclude<AiFilePreset, 'custom'>]?.length ?? 0)

  return (
    <div data-setting-anchor="aiWorkspaceTrust">
      <SectionHead title="当前工作区"
        hint={<>授权按<b>仓库</b>记录、只存在本机（不随仓库文件走），换电脑会重新询问。写文件受下方「可写类型」限制；命令即使允许，每条仍会在终端模块逐条确认。撤销后下次使用会重新出现一次性询问。</>} />

      {!state.rootId ? (
        <p className="mt-3 text-[11.5px] text-[var(--text-muted)]">尚未打开仓库。</p>
      ) : (
        <div className="mt-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5">
          <div className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1 text-[13px] text-[var(--text-primary)]">写文件</span>
            {levelOf(state.trust.fileWrite, (v) => void setTrust({ fileWrite: v }))}
          </div>
          <div className="flex items-center gap-3 py-2.5 border-t border-[var(--border-color)]">
            <span className="min-w-0 flex-1 text-[13px] text-[var(--text-primary)]">执行命令</span>
            {levelOf(state.trust.shellExec, (v) => void setTrust({ shellExec: v }))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 py-2.5 border-t border-[var(--border-color)]">
            <span className="min-w-0 flex-1 text-[13px] text-[var(--text-primary)]">
              可写类型
              <span className="ml-1 text-[11px] text-[var(--text-muted)]">（{extCount} 种扩展名）</span>
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {AI_FILE_PRESETS.map((p) => (
                <button key={p} onClick={() => void setPreset(p)} disabled={busy}
                  className={`rounded px-2 py-0.5 text-[11px] border transition-colors ${
                    p === preset
                      ? 'border-[var(--accent)]/40 bg-[var(--accent)]/15 text-[var(--accent)]'
                      : 'border-[var(--border-color)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]'
                  } disabled:opacity-40`}
                  data-tip={AI_PRESET_DESCS[p]}>
                  {AI_PRESET_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
          {state.readOnlyMarked && (
            <p className="pb-2.5 text-[11px] text-[var(--text-muted)]">
              当前为<b>只读</b>：AI 不会写文件、也不会申请执行命令，不会再打扰你。
            </p>
          )}
        </div>
      )}

      {state.rootId && (state.trust.fileWrite !== null || state.trust.shellExec !== null) && (
        <button onClick={() => void revoke()} disabled={busy}
          className="mt-2 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40">
          撤销本工作区授权
        </button>
      )}
    </div>
  )
}