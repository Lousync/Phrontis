import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, Send, History, Settings2, Loader2 } from 'lucide-react'
import type { SuperviseConfig, SupervisePlatform } from '../../../../types'
import { showToast } from '../../../../lib/toast'
import { superviseGetConfig, superviseSaveConfig, superviseTest, superviseSendDailyNow } from '../../../../lib/ipc'
import { PushHistoryView } from './components/PushHistoryView'

interface Props { onBack: () => void }

type ViewTab = 'config' | 'history'

const PLATFORM_OPTIONS: {
  id: SupervisePlatform; label: string
  urlLabel: string; urlPlaceholder: string
  guide: string; needSecret?: boolean
}[] = [
  {
    id: 'serverchan',
    label: 'Server酱',
    urlLabel: 'SendKey',
    urlPlaceholder: 'SCTxxxx…（sct.ftqq.com 获取）',
    guide: '监督者在 sct.ftqq.com 用微信扫码登录 → 复制页面上的 SendKey 填到此处 → 同一微信关注「方糖」服务号即可收到推送。免费版每天限 5 条。',
  },
  {
    id: 'wecom',
    label: '企业微信机器人',
    urlLabel: 'Webhook 地址',
    urlPlaceholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
    guide: '企业微信群 → 群设置 → 群机器人 → 添加机器人 → 复制 Webhook 地址填入，监督者在群里即可收到消息。无条数限制。',
  },
  {
    id: 'dingtalk',
    label: '钉钉机器人',
    urlLabel: 'Webhook 地址',
    urlPlaceholder: 'https://oapi.dingtalk.com/robot/send?access_token=…',
    guide: '钉钉群 → 设置 → 智能群助手 → 添加机器人 → 自定义（安全设置选「加签」）→ 复制 Webhook 地址和密钥分别填入。',
    needSecret: true,
  },
  {
    id: 'custom',
    label: '自定义 Webhook',
    urlLabel: 'URL',
    urlPlaceholder: 'https://…',
    guide: '向该地址 POST JSON：{ title, content, timestamp }，HTTP 200 即视为成功。',
  },
]

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)] border border-[var(--border-color)]'
      }`}
      role="switch"
      aria-checked={checked}
    >
      <span className={`absolute top-[2px] left-[2px] w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </button>
  )
}

export function RemoteSupervise({ onBack }: Props) {
  const [tab, setTab] = useState<ViewTab>('config')
  const [cfg, setCfg] = useState<SuperviseConfig | null>(null)
  /** 各平台各自的地址/密钥草稿 —— 切换平台时互不串显 */
  const [platformDrafts, setPlatformDrafts] = useState<Record<string, { url: string; secret: string }>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [sendingDaily, setSendingDaily] = useState(false)

  useEffect(() => {
    void superviseGetConfig()
      .then(saved => {
        setCfg(saved)
        setPlatformDrafts({ [saved.platform]: { url: saved.webhookUrl, secret: saved.secret } })
      })
      .catch(e => console.error('加载监督配置失败', e))
  }, [])

  const update = useCallback(<K extends keyof SuperviseConfig>(key: K, value: SuperviseConfig[K]) => {
    setCfg(cur => (cur ? { ...cur, [key]: value } : cur))
  }, [])

  /** 切换平台：当前平台的填写内容暂存为草稿，载入目标平台的草稿（无则清空），互不串显 */
  const handlePlatformChange = useCallback((id: SupervisePlatform) => {
    if (!cfg || id === cfg.platform) return
    const nextDrafts = {
      ...platformDrafts,
      [cfg.platform]: { url: cfg.webhookUrl, secret: cfg.secret },
    }
    const target = nextDrafts[id] ?? { url: '', secret: '' }
    setPlatformDrafts(nextDrafts)
    setCfg({ ...cfg, platform: id, webhookUrl: target.url, secret: target.secret })
  }, [cfg, platformDrafts])

  const handleSave = async (): Promise<boolean> => {
    if (!cfg) return false
    if (cfg.enabled && !cfg.webhookUrl.trim()) {
      showToast({ type: 'warning', message: '请先填写推送平台的地址或 SendKey' })
      return false
    }
    setSaving(true)
    try {
      const saved = await superviseSaveConfig(cfg)
      setCfg(saved)
      showToast({ type: 'info', message: '配置已保存 ✅' })
      return true
    } catch (e) {
      console.error('保存配置失败', e)
      showToast({ type: 'error', message: '保存配置失败' })
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!(await handleSave())) return
    setTesting(true)
    try {
      const res = await superviseTest()
      if (res.ok) showToast({ type: 'info', message: '测试消息已发送，请在监督者端确认收到' })
      else showToast({ type: 'error', message: `发送失败：${res.error ?? '未知错误'}` })
    } finally {
      setTesting(false)
    }
  }

  const handleSendDailyNow = async () => {
    if (!(await handleSave())) return
    setSendingDaily(true)
    try {
      const res = await superviseSendDailyNow()
      if (res.ok) showToast({ type: 'info', message: '今日汇总已发送' })
      else showToast({ type: 'warning', message: `未发送：${res.skipped ?? res.error ?? ''}` })
    } finally {
      setSendingDaily(false)
    }
  }

  const platform = PLATFORM_OPTIONS.find(p => p.id === cfg?.platform)

  const TABS: { id: ViewTab; label: string; icon: React.ReactNode }[] = [
    { id: 'config', label: '配置', icon: <Settings2 size={14} /> },
    { id: 'history', label: '推送历史', icon: <History size={14} /> },
  ]

  return (
    <div className="kb-theme-surface flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          title="返回"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-[11.5px] font-medium text-[var(--text-muted)]">远程监督</span>
        <div className="ml-auto flex items-center gap-1">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] transition-colors ${
                tab === t.id
                  ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4">
        {!cfg ? (
          <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin text-[var(--text-muted)]" /></div>
        ) : tab === 'history' ? (
          <PushHistoryView />
        ) : (
          <div className="max-w-[560px] mx-auto space-y-4">
            {/* 总开关 */}
            <div className="flex items-center justify-between px-3 py-2.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <div>
                <div className="text-[12px] text-[var(--text-primary)]">启用远程监督</div>
                <div className="text-[10px] text-[var(--text-muted)]">关闭后不推送任何消息，历史记录保留</div>
              </div>
              <Toggle checked={cfg.enabled} onChange={v => update('enabled', v)} />
            </div>

            {/* 平台选择 */}
            <div className={`px-3 py-2.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] space-y-2.5 transition-opacity ${cfg.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
              <div className="text-[12px] text-[var(--text-primary)]">推送平台</div>
              <div className="grid grid-cols-4 gap-1.5">
                {PLATFORM_OPTIONS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => handlePlatformChange(p.id)}
                    className={`px-1 py-1.5 rounded text-[11px] border transition-colors ${
                      cfg.platform === p.id
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'border-[var(--border-color)] hover:bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {platform && (
                <>
                  <div>
                    <label className="text-[10px] text-[var(--text-muted)]">{platform.urlLabel}</label>
                    <input
                      value={cfg.webhookUrl}
                      onChange={e => update('webhookUrl', e.target.value)}
                      placeholder={platform.urlPlaceholder}
                      spellCheck={false}
                      className="w-full mt-0.5 px-2 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  {platform.needSecret && (
                    <div>
                      <label className="text-[10px] text-[var(--text-muted)]">加签密钥（SECRETS）</label>
                      <input
                        value={cfg.secret}
                        onChange={e => update('secret', e.target.value)}
                        placeholder='SEC…'
                        spellCheck={false}
                        className="w-full mt-0.5 px-2 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                  )}
                  <div className="text-[10px] leading-relaxed text-[var(--text-muted)] px-0.5">{platform.guide}</div>
                </>
              )}
            </div>

            {/* 推送时机 */}
            <div className={`px-3 py-2.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] divide-y divide-[var(--border-color)] transition-opacity ${cfg.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
              <div className="flex items-center justify-between pb-2.5">
                <div>
                  <div className="text-[12px] text-[var(--text-primary)]">打卡即时推送</div>
                  <div className="text-[10px] text-[var(--text-muted)]">每次打卡成功立即通知监督者</div>
                </div>
                <Toggle checked={cfg.instantPush} onChange={v => update('instantPush', v)} />
              </div>
              <div className="pt-2.5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[12px] text-[var(--text-primary)]">每日汇总</div>
                    <div className="text-[10px] text-[var(--text-muted)]">定时推送当天全部习惯完成情况</div>
                  </div>
                  <Toggle checked={cfg.dailyPush} onChange={v => update('dailyPush', v)} />
                </div>
                {cfg.dailyPush && (
                  <div className="flex items-center gap-2 mt-2">
                    <label className="text-[11px] text-[var(--text-muted)]">发送时间</label>
                    <input
                      type="time"
                      value={cfg.dailyTime}
                      onChange={e => update('dailyTime', e.target.value)}
                      className="px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between pt-2.5">
                <div>
                  <div className="text-[12px] text-[var(--text-primary)]">免打扰时段</div>
                  <div className="text-[10px] text-[var(--text-muted)]">时段内的推送挂起，结束后自动补发</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="time"
                    value={cfg.quietStart}
                    onChange={e => update('quietStart', e.target.value)}
                    className="px-1.5 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[11px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-[11px] text-[var(--text-muted)]">至</span>
                  <input
                    type="time"
                    value={cfg.quietEnd}
                    onChange={e => update('quietEnd', e.target.value)}
                    className="px-1.5 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] text-[11px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  {(cfg.quietStart || cfg.quietEnd) && (
                    <button
                      onClick={() => { update('quietStart', ''); update('quietEnd', '') }}
                      className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1"
                      title="清空即关闭免打扰"
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 操作按钮 */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="px-4 py-1.5 rounded bg-[var(--accent)] text-white text-[12px] hover:bg-[var(--accent-hover)] disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving && <Loader2 size={12} className="animate-spin" />} 保存配置
              </button>
              <button
                onClick={() => void handleTest()}
                disabled={testing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--border-color)] text-[12px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
              >
                {testing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} 发送测试消息
              </button>
              <button
                onClick={() => void handleSendDailyNow()}
                disabled={sendingDaily}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--border-color)] text-[12px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
              >
                {sendingDaily ? <Loader2 size={12} className="animate-spin" /> : null} 立即发送今日汇总
              </button>
            </div>

            <div className="text-[10px] text-[var(--text-muted)] leading-relaxed px-0.5">
              提示：Webhook 地址与密钥仅保存在本机，请勿分享给他人；测试前先点「保存配置」。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
