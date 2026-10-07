import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquare, FileText, Paperclip, Trash2, Wifi, X, Upload, Clock, ArrowLeft } from 'lucide-react'
import { showToast } from '../../../../lib/toast'
import {
  getPathForFile,
  lanShareStart, lanShareStop, lanShareStatus, lanShareQr,
  lanShareListInbox, lanShareListOutbox,
  lanShareRemoveInbox, lanShareRemoveOutbox,
  lanShareAddToOutbox,
  uploadAttachmentFromPath, createMomentsPost, createKnowledgePage,
} from '../../../../lib/ipc'
import type { LanShareStatus, LanShareInboxFile, LanShareOutboxFile } from '../../../../types'

/**
 * 设备传输：局域网短时双向互传（工具箱第 9 个工具）。
 * 电脑端开服务出二维码 → 平板扫码即连 → 上传到收件箱 / 下载待发送文件 → 用完即关。
 */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '即将自动关闭'
  const s = Math.ceil(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m} 分 ${r} 秒后自动关闭`
}

export function LanShare({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<LanShareStatus | null>(null)
  const [inbox, setInbox] = useState<LanShareInboxFile[]>([])
  const [outbox, setOutbox] = useState<LanShareOutboxFile[]>([])
  const [qr, setQr] = useState('')
  const [qrUrl, setQrUrl] = useState('')
  const qrUrlRef = useRef('')
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await lanShareStatus()
      setStatus(s)
      setRemaining(s.remainingMs)
      const [ib, ob] = await Promise.all([lanShareListInbox(), lanShareListOutbox()])
      setInbox(ib)
      setOutbox(ob)
      if (s.running && s.urls.length > 0) {
        // 保持当前选择（若仍有效），否则回退到首选地址
        const url = qrUrlRef.current && s.urls.includes(qrUrlRef.current) ? qrUrlRef.current : s.urls[0]
        qrUrlRef.current = url
        setQrUrl(url)
        setQr(await lanShareQr(url))
      } else {
        setQr('')
      }
    } catch { /* 主进程未就绪时静默 */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // 开启期间轮询（平板新上传 / 新下载标记实时可见）
  useEffect(() => {
    if (!status?.running) return
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [status?.running, refresh])

  // 剩余时间倒计时
  useEffect(() => {
    if (!status?.running) return
    const t = setInterval(() => setRemaining(r => Math.max(0, r - 1000)), 1000)
    return () => clearInterval(t)
  }, [status?.running])

  const handleStart = async () => {
    try {
      await lanShareStart({ autoStopMinutes: 15 })
      await refresh()
      showToast({ type: 'info', message: '设备传输已开启，用平板扫码连接' })
    } catch {
      showToast({ type: 'error', message: '开启失败，请检查端口是否被占用' })
    }
  }

  const handleStop = async () => {
    try {
      await lanShareStop()
      await refresh()
      showToast({ type: 'info', message: '已关闭，待发送文件已清空' })
    } catch {
      showToast({ type: 'error', message: '关闭失败' })
    }
  }

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const p = getPathForFile(f)
      if (!p) {
        showToast({ type: 'warning', message: `无法读取「${f.name}」的本地路径` })
        continue
      }
      const r = await lanShareAddToOutbox({ path: p })
      if (r.ok) {
        showToast({ type: 'success', message: `已加入待发送：${f.name}` })
      } else {
        showToast({ type: 'error', message: `加入失败：${f.name}` })
      }
    }
    await refresh()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files)
  }

  const archive = async (f: LanShareInboxFile, target: 'moment' | 'page' | 'attachment') => {
    if (busy) return
    setBusy(f.name)
    try {
      if (target === 'moment') {
        const m = await uploadAttachmentFromPath({ filePath: f.path })
        if (!m) throw new Error('附件入库失败')
        await createMomentsPost({ contentMd: `【设备传输】${f.name}`, attachmentIds: [m.id] })
      } else if (target === 'page') {
        const page = await createKnowledgePage({ title: f.name, contentMd: `【附件】${f.name}`, categoryId: null })
        await uploadAttachmentFromPath({ ownerType: 'knowledge_page', ownerId: page.id, filePath: f.path })
      } else {
        const m = await uploadAttachmentFromPath({ filePath: f.path })
        if (!m) throw new Error('附件入库失败')
      }
      await lanShareRemoveInbox(f.name)
      await refresh()
      showToast({ type: 'success', message: '已归档' })
    } catch (e) {
      showToast({ type: 'error', message: e instanceof Error ? e.message : '归档失败' })
    } finally {
      setBusy(null)
    }
  }

  const removeInbox = async (name: string) => {
    await lanShareRemoveInbox(name)
    await refresh()
  }

  const removeOutbox = async (name: string) => {
    await lanShareRemoveOutbox(name)
    await refresh()
  }

  const switchUrl = async (url: string) => {
    qrUrlRef.current = url
    setQrUrl(url)
    try {
      setQr(await lanShareQr(url))
    } catch { /* 忽略 */ }
  }

  const running = !!status?.running

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
          <Wifi size={12} className={running ? 'text-[var(--accent)]' : ''} />
          设备传输
        </span>
        {running && (
          <span className="ml-auto text-[11px] text-[var(--text-muted)] flex items-center gap-1">
            <Clock size={12} /> {formatCountdown(remaining)}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="max-w-[680px] mx-auto space-y-4">

          {/* 状态与二维码 */}
          {!running ? (
            <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-6 text-center">
              <p className="text-[13px] text-[var(--text-primary)]">让平板与电脑在同一局域网下，开启后即可互相传文件</p>
              <p className="text-[12px] text-[var(--text-muted)] mt-1.5">平板端无需安装任何软件，扫码即可连接</p>
              <button
                onClick={() => void handleStart()}
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-[var(--accent)] text-[var(--bg-primary)] text-[13px] hover:opacity-90 transition-opacity"
              >
                <Wifi size={14} /> 开启传输
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-5 flex items-center gap-5">
              {qr && (
                <div className="shrink-0 rounded-md bg-white p-2">
                  <img src={qr} alt="连接二维码" className="w-[130px] h-[130px]" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-[var(--text-primary)]">平板扫码连接</p>
                <p className="text-[12px] text-[var(--text-muted)] mt-1 break-all leading-relaxed">
                  {qrUrl || status?.urls[0] || '未获取到局域网地址'}
                </p>
                {status && status.urls.length > 1 && (
                  <div className="mt-2 space-y-0.5">
                    <p className="text-[11px] text-[var(--text-muted)]">其他地址（点选切换）</p>
                    {status.urls.filter(u => u !== qrUrl).map(u => (
                      <button
                        key={u}
                        onClick={() => void switchUrl(u)}
                        className="block w-full text-left text-[11px] font-mono break-all px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-[11px] leading-relaxed mt-2" style={{ color: 'var(--warning)' }}>
                  连不上？① 首次开启时请在 Windows 防火墙弹窗中允许访问；② 路由器若开了「AP 隔离」需关闭；③ 确认平板和电脑连的是同一个 Wi-Fi
                </p>
                <button
                  onClick={() => void handleStop()}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] text-[12px] hover:border-[var(--danger)] hover:text-[var(--danger)] transition-colors"
                >
                  <X size={13} /> 停止传输
                </button>
              </div>
            </div>
          )}

          {/* 发送到设备（outbox） */}
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-medium text-[var(--text-primary)]">发送到设备</h3>
              {outbox.length > 0 && (
                <span className="text-[11px] text-[var(--text-muted)]">{outbox.length} 个文件</span>
              )}
            </div>

            {running && (
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                className={`mt-3 rounded-md border-2 border-dashed p-5 text-center cursor-pointer transition-colors ${
                  dragging
                    ? 'border-[var(--accent)] bg-[var(--bg-tertiary)]'
                    : 'border-[var(--border-color)] hover:border-[var(--accent)]'
                }`}
              >
                <Upload size={18} className="mx-auto text-[var(--text-muted)]" />
                <p className="mt-1.5 text-[13px] text-[var(--text-primary)]">拖入文件或点击选择</p>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">拖入即自动出现在平板端 · 关闭传输时自动清空</p>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={e => {
                    if (e.target.files?.length) void addFiles(e.target.files)
                    e.target.value = ''
                  }}
                />
              </div>
            )}

            {outbox.length > 0 ? (
              <div className="mt-3 space-y-1.5">
                {outbox.map(f => (
                  <div key={f.name} className="flex items-center gap-2.5 px-3 py-2 rounded-md bg-[var(--bg-tertiary)]">
                    <span className="flex-1 min-w-0 text-[13px] text-[var(--text-primary)] truncate">{f.name}</span>
                    <span className="text-[11px] text-[var(--text-muted)] shrink-0">{formatSize(f.size)}</span>
                    <span className={`text-[11px] shrink-0 ${f.downloaded ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
                      {f.downloaded ? '已下载' : '待平板取走'}
                    </span>
                    <button
                      onClick={() => void removeOutbox(f.name)}
                      className="shrink-0 text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors"
                      title="移出待发送"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : running ? (
              <p className="mt-3 text-[12px] text-[var(--text-muted)] text-center py-2">暂无待发送文件</p>
            ) : (
              <p className="mt-3 text-[12px] text-[var(--text-muted)] text-center py-2">开启传输后即可添加文件</p>
            )}
          </div>

          {/* 收件箱（平板传来） */}
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
            <h3 className="text-[13px] font-medium text-[var(--text-primary)]">收到的文件</h3>
            {inbox.length > 0 ? (
              <div className="mt-3 space-y-1.5">
                {inbox.map(f => (
                  <div key={f.path} className="flex items-center gap-2.5 px-3 py-2 rounded-md bg-[var(--bg-tertiary)]">
                    <span className="flex-1 min-w-0 text-[13px] text-[var(--text-primary)] truncate">{f.name}</span>
                    <span className="text-[11px] text-[var(--text-muted)] shrink-0">{formatSize(f.size)}</span>
                    <span className="text-[11px] text-[var(--text-muted)] shrink-0">{formatTime(f.receivedAt)}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => void archive(f, 'moment')}
                        disabled={busy === f.name}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
                        title="归档为说说"
                      >
                        <MessageSquare size={13} />
                      </button>
                      <button
                        onClick={() => void archive(f, 'page')}
                        disabled={busy === f.name}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
                        title="归档为知识页"
                      >
                        <FileText size={13} />
                      </button>
                      <button
                        onClick={() => void archive(f, 'attachment')}
                        disabled={busy === f.name}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
                        title="存为附件"
                      >
                        <Paperclip size={13} />
                      </button>
                      <button
                        onClick={() => void removeInbox(f.name)}
                        disabled={busy === f.name}
                        className="flex items-center px-1.5 py-0.5 rounded text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
                        title="移除"
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-[12px] text-[var(--text-muted)] text-center py-2">
                平板传来的文件会出现在这里，可选择归档为说说、知识页或附件
              </p>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
