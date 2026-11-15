/**
 * 工作区信任卡（P0-B，v3.31.0）。
 *
 * 为什么是行内卡而不是中央模态：铁律 25 —— 常规授权不走中央弹窗。
 * 首次在某个仓库用 AI 写文件 / 执行命令时，这里一次性问清；之后不再打扰
 * （用户也可以到 设置 → AI → 权限 → 当前工作区 随时改）。
 *
 * 语义（与 aiPermissionPure 一致）：
 *  · 「一次性开启」→ 写文件 + 执行命令都 allow（一张卡同时授予）；
 *  · 「保持只读」→ 两者都 deny，卡片消失，面板只留只读标记；
 *  · 命令即使 allow，每条仍会在终端模块逐条确认 —— 信任只决定「能不能用」。
 */

import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, ShieldOff, ChevronDown, Loader2 } from 'lucide-react'
import { aiPermissionGet, aiPolicySet, aiTrustSet } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { showToast } from '../../../lib/toast'
import { AI_PRESET_LABELS, AI_FILE_PRESETS } from '../../../lib/aiFilePolicyShared'
import type { AiPermissionState, AiFilePreset } from '../../../types'

interface Props {
  /** 日程 / AI 教学等专用聊天面不接这张卡（保持既有行为） */
  enabled: boolean
}

const PRESET_OPTIONS = AI_FILE_PRESETS.filter((p) => p !== 'custom')

export function TrustGateCard({ enabled }: Props) {
  const [state, setState] = useState<AiPermissionState | null>(null)
  const [busy, setBusy] = useState<'grant' | 'readonly' | 'preset' | null>(null)
  const [showPresets, setShowPresets] = useState(false)

  const load = useCallback(() => {
    void aiPermissionGet().then(setState).catch(() => setState(null))
  }, [])

  useEffect(() => { if (enabled) load() }, [enabled, load])
  useDataChanged('aiAssistant', load)

  if (!enabled || !state || !state.rootId || !state.needsTrustPrompt || state.globalFilePerm === 'off') return null

  const grant = async (): Promise<void> => {
    setBusy('grant')
    try {
      await aiTrustSet({ fileWrite: 'allow', shellExec: 'allow' })
      showToast({ type: 'success', message: '已开启：本工作区允许 AI 写文件与执行命令', detail: '命令仍需逐条确认；可随时在 设置 → AI → 权限 撤销' })
      load()
    } finally { setBusy(null) }
  }

  const readOnly = async (): Promise<void> => {
    setBusy('readonly')
    try {
      // 只拒绝「待表态」的那几项：用户已经允许的写文件能力不该因为这里点一下被一起收回
      const patch: { fileWrite?: 'deny'; shellExec?: 'deny' } = {}
      if (state.pendingFileTrust) patch.fileWrite = 'deny'
      if (state.pendingExecTrust) patch.shellExec = 'deny'
      await aiTrustSet(patch)
      showToast({ type: 'info', message: '已设为只读', detail: '不再询问；可在 设置 → AI → 权限 → 当前工作区 改回' })
      load()
    } finally { setBusy(null) }
  }

  const pickPreset = async (preset: AiFilePreset): Promise<void> => {
    setBusy('preset')
    try {
      await aiPolicySet({ ...(state.policy.overrides ?? {}), preset })
      showToast({ type: 'success', message: `可写类型：${AI_PRESET_LABELS[preset]}` })
      setShowPresets(false)
      load()
    } finally { setBusy(null) }
  }

  const preset = state.policy.effective.preset

  return (
    <div className="kb-item-in mx-2 mt-2 shrink-0 rounded-lg border border-[var(--accent)]/30 bg-[var(--bg-secondary)] px-3 py-2.5" data-trust-gate>
      <div className="flex items-start gap-2">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-[var(--text-primary)]">允许 AI 在此工作区写文件并执行命令？</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
            写文件受本仓库策略限制；命令每条仍需你确认。此授权只对本工作区、本机生效，换电脑会重新询问。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button onClick={() => void grant()} disabled={busy !== null}
              className="kb-micro-pop flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11.5px] text-white hover:opacity-90 disabled:opacity-60">
              {busy === 'grant' ? <Loader2 size={11} className="animate-spin" /> : <ShieldCheck size={11} />}
              一次性开启
            </button>
            <button onClick={() => void readOnly()} disabled={busy !== null}
              className="kb-micro-pop flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-60">
              {busy === 'readonly' ? <Loader2 size={11} className="animate-spin" /> : <ShieldOff size={11} />}
              保持只读
            </button>
            <button onClick={() => setShowPresets(v => !v)} disabled={busy !== null}
              className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
              {AI_PRESET_LABELS[preset]}
              <ChevronDown size={11} className={`kb-chevron ${showPresets ? 'rotate-180' : ''}`} />
            </button>
          </div>
          {showPresets && (
            <div className="kb-collapse mt-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] p-1">
              {PRESET_OPTIONS.map((p) => (
                <button key={p} onClick={() => void pickPreset(p)} disabled={busy !== null}
                  className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11.5px] hover:bg-[var(--bg-hover)] ${p === preset ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}>
                  {AI_PRESET_LABELS[p]}
                  {p === preset && <span className="text-[10px]">当前</span>}
                </button>
              ))}
              <p className="px-2 pt-1 pb-0.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
                「自定义」请在 设置 → AI → 权限 → 当前工作区 里逐项勾选。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
