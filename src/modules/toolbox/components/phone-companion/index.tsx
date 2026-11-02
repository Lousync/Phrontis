import { useCallback, useEffect, useRef, useState } from 'react'
import { Smartphone, ArrowLeft, RefreshCw, Trash2, X, Clock } from 'lucide-react'
import { showToast } from '../../../../lib/toast'
import {
  getSetting, setSetting,
  companionStart, companionStop, companionStatus, companionNewPairCode, companionQr, companionRevoke,
} from '../../../../lib/ipc'
import type { CompanionStatus } from '../../../../types'

/**
 * 手机伴侣：局域网常驻同步服务（对端 = Phrontis Mobile 手机端）。
 * 开服务 → 出配对码 + 二维码 → 手机在 设置 → 同步 输入地址与配对码（或粘贴配对链接）→ 长期互信。
 * 协议冻结口径：E:\Projects\Phrontis-mobile\docs\design.md §2.1。
 */

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function codeCountdown(expiresAt: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function PhoneCompanion({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [qr, setQr] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(0)
  const qrUrlRef = useRef('')

  const refresh = useCallback(async () => {
    try {
      const s = await companionStatus()
      setStatus(s)
      const url = s.running ? s.urls[0] || '' : ''
      if (url && url !== qrUrlRef.current) {
        qrUrlRef.current = url
        setQr(await companionQr(url))
      } else if (!url) {
        qrUrlRef.current = ''
        setQr('')
      }
    } catch { /* 主进程未就绪时静默 */ }
  }, [])

  useEffect(() => {
    void refresh()
    void getSetting('companionAutoStart').then(v => setAutoStart(v === true)).catch(() => { /* 忽略 */ })
  }, [refresh])

  // 运行期间轮询（配对结果 / 设备 lastSeen 实时可见）
  useEffect(() => {
    if (!status?.running) return
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [status?.running, refresh])

  // 配对码倒计时
  useEffect(() => {
    if (!status?.running) return
    const t = setInterval(() => setRemaining(status.pairCodeExpiresAt - Date.now()), 1000)
    return () => clearInterval(t)
  }, [status?.running, status?.pairCodeExpiresAt])

  const handleStart = async () => {
    setBusy(true)
    try {
      const s = await companionStart({})
      setStatus(s)
      if (s.urls[0]) {
        qrUrlRef.current = s.urls[0]
        setQr(await companionQr(s.urls[0]))
      }
      showToast({ type: 'info', message: `手机伴侣已开启（端口 ${s.port}），手机端输入地址与配对码即可连接` })
    } catch {
      showToast({ type: 'error', message: '开启失败，请检查端口是否被占用' })
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    setBusy(true)
    try {
      setStatus(await companionStop())
      qrUrlRef.current = ''
      setQr('')
      showToast({ type: 'info', message: '手机伴侣已关闭，已配对设备保留' })
    } catch {
      showToast({ type: 'error', message: '关闭失败' })
    } finally {
      setBusy(false)
    }
  }

  const toggleAutoStart = async () => {
    const next = !autoStart
    setAutoStart(next)
    try {
      await setSetting('companionAutoStart', next)
      showToast({ type: 'success', message: next ? '开机自启已开启' : '开机自启已关闭' })
    } catch {
      setAutoStart(!next)
      showToast({ type: 'error', message: '设置写入失败' })
    }
  }

  const running = !!status?.running
  const codeValid = running && !!status?.pairCode

  return (
    <div className="kb-theme-surface flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          title="返回"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-[11.5px] font-medium text-[var(--text-muted)] flex items-center gap-1.5">
          <Smartphone size={12} className={running ? 'text-[var(--accent)]' : ''} />
          手机伴侣
        </span>
        {running && (
          <span className="ml-auto text-[11px] text-[var(--text-muted)]">端口 {status?.port}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="max-w-[680px] mx-auto space-y-4">

          {/* 服务开关 */}
          {!running ? (
            <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-6 text-center">
              <p className="text-[13px] text-[var(--text-primary)]">让手机与电脑在同一局域网下，开启后手机端 Phrontis 即可与此同步</p>
              <p className="text-[12px] text-[var(--text-muted)] mt-1.5">服务常驻运行（不影响其他功能），已配对设备始终保留</p>
              <button
                onClick={() => void handleStart()}
                disabled={busy}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-[var(--accent)] text-[var(--bg-primary)] text-[13px] hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                <Smartphone size={14} /> 开启服务
              </button>
            </div>
          ) : (
            <>
              {/* 配对码 + 二维码 */}
              <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-5 flex items-center gap-5">
                {qr && (
                  <div className="shrink-0 rounded-md bg-white p-2">
                    <img src={qr} alt="配对二维码" className="w-[130px] h-[130px]" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-[var(--text-primary)]">手机端配对（设置 → 同步）</p>
                  {codeValid ? (
                    <>
                      <div className="mt-2 flex items-center gap-2.5">
                        <span className="font-mono text-[22px] font-semibold tracking-[0.18em] text-[var(--accent)]">
                          {status?.pairCode}
                        </span>
                        <span className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
                          <Clock size={11} /> {remaining > 0 ? codeCountdown(status!.pairCodeExpiresAt) : '已过期'}
                        </span>
                      </div>
                      <p className="text-[11.5px] text-[var(--text-muted)] mt-1.5 break-all leading-relaxed">
                        配对链接：{status?.urls[0] || '未获取到局域网地址'}
                      </p>
                      <p className="text-[11px] text-[var(--text-muted)] mt-1">
                        手机输入上方地址与配对码，或直接粘贴整条配对链接；配对成功后两端长期互信，配对码随即作废
                      </p>
                      <button
                        onClick={() => void companionNewPairCode().then(s => { setStatus(s); if (s.urls[0]) { qrUrlRef.current = ''; void refresh() } })}
                        className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        <RefreshCw size={11} /> 换一个配对码
                      </button>
                    </>
                  ) : (
                    <p className="text-[12px] text-[var(--text-muted)] mt-2">
                      当前没有有效配对码（可能已被使用或过期），点击「换一个配对码」重新出示
                    </p>
                  )}
                  <p className="text-[11px] leading-relaxed mt-2" style={{ color: 'var(--warning)' }}>
                    连不上？① 手机与电脑需在同一 Wi-Fi / 热点；② 首次开启时允许 Windows 防火墙访问；③ 路由器开了「AP 隔离」需关闭
                  </p>
                  <button
                    onClick={() => void handleStop()}
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] text-[12px] hover:border-[var(--danger)] hover:text-[var(--danger)] transition-colors"
                  >
                    <X size={13} /> 关闭服务
                  </button>
                </div>
              </div>

              {/* 已配对设备 */}
              <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-medium text-[var(--text-primary)]">已配对设备</h3>
                  {status && status.devices.length > 0 && (
                    <span className="text-[11px] text-[var(--text-muted)]">{status.devices.length} 台</span>
                  )}
                </div>
                {status && status.devices.length > 0 ? (
                  <div className="mt-3 space-y-1.5">
                    {status.devices.map(d => (
                      <div key={d.deviceId} className="flex items-center gap-2.5 px-3 py-2 rounded-md bg-[var(--bg-tertiary)]">
                        <Smartphone size={14} className="shrink-0 text-[var(--text-muted)]" />
                        <span className="flex-1 min-w-0 text-[13px] text-[var(--text-primary)] truncate">{d.name}</span>
                        <span className="text-[11px] text-[var(--text-muted)] shrink-0">
                          {Date.now() - d.lastSeenAt < 90_000
                            ? <span className="text-[var(--success)]">在线</span>
                            : `最近活跃 ${formatTime(d.lastSeenAt)}`}
                        </span>
                        {confirmRevoke === d.deviceId ? (
                          <span className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => void companionRevoke(d.deviceId).then(() => { setConfirmRevoke(null); void refresh(); showToast({ type: 'success', message: '已解除配对' }) })}
                              className="px-1.5 py-0.5 rounded text-[11px] text-[var(--danger)] hover:bg-[var(--bg-hover)] transition-colors"
                            >
                              确认解除
                            </button>
                            <button
                              onClick={() => setConfirmRevoke(null)}
                              className="px-1.5 py-0.5 rounded text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] transition-colors"
                            >
                              取消
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmRevoke(d.deviceId)}
                            className="shrink-0 text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors"
                            title="解除配对"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-[12px] text-[var(--text-muted)] text-center py-2">
                    还没有设备配对。手机端输入地址与配对码后，会出现在这里
                  </p>
                )}
              </div>
            </>
          )}

          {/* 偏好 */}
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
            <button onClick={() => void toggleAutoStart()} className="flex items-center gap-2.5 w-full text-left group">
              <span
                className={`w-8 h-[18px] rounded-full relative transition-colors shrink-0 ${autoStart ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)] border border-[var(--border-color)]'}`}
              >
                <span
                  className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${autoStart ? 'left-[16px]' : 'left-[2px]'}`}
                />
              </span>
              <span>
                <span className="text-[13px] text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">随应用启动自动开启服务</span>
                <span className="block text-[11px] text-[var(--text-muted)] mt-0.5">开启后应用启动即运行手机伴侣，无需手动打开</span>
              </span>
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}
