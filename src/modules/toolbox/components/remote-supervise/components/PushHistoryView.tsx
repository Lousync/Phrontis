import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, CheckCircle, XCircle, Clock, Loader2, Trash2 } from 'lucide-react'
import type { SuperviseLog } from '../../../../../types'
import { showToast } from '../../../../../lib/toast'
import { superviseGetHistory, superviseRetry, superviseRetryAllFailed, superviseClearHistory } from '../../../../../lib/ipc'

/** 推送历史列表：状态标记、失败原因、单条/全部补推、一键清空 */
export function PushHistoryView() {
  const [logs, setLogs] = useState<SuperviseLog[]>([])
  const [loading, setLoading] = useState(true)
  const [retryingId, setRetryingId] = useState<number | null>(null)
  const [retryingAll, setRetryingAll] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setLogs(await superviseGetHistory(200))
    } catch (e) {
      console.error('加载推送历史失败', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => () => {
    if (clearTimer.current) clearTimeout(clearTimer.current)
  }, [])

  const failedCount = logs.filter(l => l.status === 'failed').length

  const handleClear = async () => {
    // 两步确认：第一次点击进入待确认态，3 秒内再点才执行
    if (!confirmingClear) {
      setConfirmingClear(true)
      clearTimer.current = setTimeout(() => setConfirmingClear(false), 3000)
      return
    }
    if (clearTimer.current) clearTimeout(clearTimer.current)
    setConfirmingClear(false)
    try {
      await superviseClearHistory()
      showToast({ type: 'info', message: '推送历史已清空' })
      await refresh()
    } catch (e) {
      console.error('清空推送历史失败', e)
      showToast({ type: 'error', message: '清空失败' })
    }
  }

  const handleRetry = async (id: number) => {
    setRetryingId(id)
    try {
      const updated = await superviseRetry(id)
      setLogs(cur => cur.map(l => (l.id === id && updated ? updated : l)))
      if (updated?.status === 'success') showToast({ type: 'info', message: '重推成功' })
      else showToast({ type: 'error', message: `重推失败：${updated?.errorMessage ?? '未知错误'}` })
    } catch (e) {
      console.error('重推失败', e)
    } finally {
      setRetryingId(null)
    }
  }

  const handleRetryAll = async () => {
    setRetryingAll(true)
    try {
      const res = await superviseRetryAllFailed()
      if (res.ok === res.total) showToast({ type: 'info', message: `全部重推成功（${res.ok}/${res.total}）` })
      else showToast({ type: 'warning', message: `重推完成：成功 ${res.ok} 条，失败 ${res.total - res.ok} 条` })
      await refresh()
    } catch (e) {
      console.error('批量重推失败', e)
    } finally {
      setRetryingAll(false)
    }
  }

  const StatusIcon = ({ log }: { log: SuperviseLog }) => {
    if (log.status === 'success') return <CheckCircle size={14} className="text-green-500 shrink-0" />
    if (log.status === 'failed') return <XCircle size={14} className="text-red-500 shrink-0" />
    return <Clock size={14} className="text-[var(--text-muted)] shrink-0" />
  }

  return (
    <div className="flex flex-col h-full">
      {/* 操作栏 */}
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-[11px] text-[var(--text-muted)]">最近 {logs.length} 条记录</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void refresh()}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--border-color)] hover:bg-[var(--bg-tertiary)]"
            data-tip="刷新" aria-label="刷新"
          >
            <RefreshCw size={12} /> 刷新
          </button>
          <button
            onClick={() => void handleRetryAll()}
            disabled={retryingAll || failedCount === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--border-color)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed"
            data-tip="重推全部失败项" aria-label="重推全部失败项"
          >
            {retryingAll ? <Loader2 size={12} className="animate-spin" /> : null}
            补推全部失败{failedCount > 0 ? `(${failedCount})` : ''}
          </button>
          {logs.length > 0 && (
            <button
              onClick={() => void handleClear()}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] border transition-colors ${
                confirmingClear
                  ? 'border-red-500 bg-red-500/10 text-red-400'
                  : 'border-[var(--border-color)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]'
              }`}
              data-tip="清空全部推送记录" aria-label="清空全部推送记录"
            >
              {confirmingClear ? <><Trash2 size={12} /> 确认清空？</> : <><Trash2 size={12} /> 清空历史</>}
            </button>
          )}
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto space-y-1.5">
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-muted)]" /></div>
        ) : logs.length === 0 ? (
          <div className="text-center py-8 text-[12px] text-[var(--text-muted)]">
            暂无推送记录
          </div>
        ) : (
          logs.map(log => (
            <div key={log.id} className="px-3 py-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <div className="flex items-start gap-2">
                <StatusIcon log={log} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[12px] text-[var(--text-primary)]">{log.title}</span>
                    <span className={`text-[9px] px-1 py-px rounded ${
                      log.pushType === 'daily'
                        ? 'bg-blue-500/15 text-blue-400'
                        : 'bg-green-500/15 text-green-400'
                    }`}>
                      {log.pushType === 'daily' ? '每日汇总' : '即时'}
                    </span>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                    创建于 {log.createdAt.replace('T', ' ').slice(0, 16)}
                    {log.pushedAt ? ` · 发送于 ${log.pushedAt.replace('T', ' ').slice(0, 16)}` : ''}
                    {log.retryCount > 0 ? ` · 已尝试 ${log.retryCount} 次` : ''}
                  </div>
                  {log.errorMessage && (
                    <div className="text-[10px] text-red-400 mt-1 break-all">{log.errorMessage}</div>
                  )}
                </div>
                {log.status === 'failed' && (
                  <button
                    onClick={() => void handleRetry(log.id)}
                    disabled={retryingId === log.id}
                    className="shrink-0 px-1.5 py-0.5 rounded text-[10px] border border-[var(--border-color)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                  >
                    {retryingId === log.id ? <Loader2 size={10} className="animate-spin" /> : '重推'}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
