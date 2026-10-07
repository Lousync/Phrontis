import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, RefreshCw, Scissors, WifiOff, Copy, Check, RotateCcw, FolderOpen, Puzzle } from 'lucide-react'
import { showToast } from '../../../../lib/toast'
import { clipperStatus, clipperResetToken, clipperOpenFolder, clipperSelfPing } from '../../../../lib/ipc'
import type { ClipperStatus } from '../../../../types'

/**
 * 网页剪藏服务面板（工具箱入口，docs/plugin-web-clipper-design.md）。
 * 剪藏动作发生在浏览器扩展里；本面板负责：服务状态、配对令牌、自检、最近剪藏回顾、扩展安装指引。
 * 产物落当前仓库 `.knowbase/_draft/clipper/`（草稿区，不进知识索引），在编辑器中整理后转正。
 */

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 文件名 `2026-09-05-标题.md` → 展示用标题 */
function clipTitle(fileName: string): string {
  return fileName.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}-?/, '').replace(/-\d{6}$/, '')
}

export function WebClipper({ onBack }: { onBack: () => void }) {
  const [st, setSt] = useState<ClipperStatus | null>(null)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [pinging, setPinging] = useState(false)

  const refresh = useCallback(async () => {
    try { setSt(await clipperStatus()) } catch { setSt(null) }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      showToast({ type: 'error', message: '复制失败' })
    }
  }

  const resetToken = async () => {
    const r = await clipperResetToken()
    if (r.ok) {
      showToast({ type: 'info', message: '配对令牌已重置，请在浏览器扩展中重新填写' })
      refresh()
    }
  }

  const selfPing = async () => {
    setPinging(true)
    try {
      const r = await clipperSelfPing()
      showToast(r.ok
        ? { type: 'info', message: `服务自检通过${r.vault ? ` · 当前仓库「${r.vault}」` : ''}` }
        : { type: 'error', message: `自检失败：${r.error || 'HTTP ' + r.status}` })
    } finally {
      setPinging(false)
    }
  }

  const openFolder = async () => {
    const r = await clipperOpenFolder()
    if (!r.ok && r.error) showToast({ type: 'warning', message: r.error })
  }

  const dot = st == null
    ? 'bg-[var(--text-disabled)]'
    : st.running
      ? 'bg-[var(--success,var(--accent))]'
      : 'bg-[var(--danger,#e5484d)]'

  return (
    <div className="kb-theme-surface flex flex-col h-full">
      {/* 头部（与 lan-share 同款） */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          title="返回"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-[11.5px] font-medium text-[var(--text-muted)] flex items-center gap-1.5">
          <Scissors size={12} className="text-[var(--accent)]" />
          网页剪藏
        </span>
        <button
          onClick={refresh}
          className="ml-auto p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="刷新状态"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="max-w-[680px] mx-auto space-y-4">
          {/* 服务状态卡 */}
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${dot}`} />
              <span className="text-[13px] font-medium text-[var(--text-primary)]">
                {st == null ? '读取状态中…' : st.running ? '剪藏服务运行中' : '服务未运行'}
              </span>
              {st?.running && (
                <span className="text-[11px] text-[var(--text-muted)] ml-1">
                  http://127.0.0.1:{st.port}
                  {st.portDrifted && <span className="text-[var(--warning)]">（默认端口被占，已漂移）</span>}
                </span>
              )}
              <button
                onClick={selfPing}
                disabled={pinging || !st?.running}
                className="ml-auto text-[11px] px-2 py-1 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors"
                title="以扩展同款请求路径自检（含 Origin 白名单校验）"
              >
                {pinging ? '自检中…' : '自检'}
              </button>
            </div>
            {st?.error && <div className="text-[11px] text-[var(--danger,#e5484d)]">{st.error}</div>}
            <div className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
              {st?.vault
                ? <>剪藏落点：<code className="text-[var(--text-secondary)]">{st.vault.name}/.knowbase/_draft/clipper/</code>（草稿区，不进知识索引/图谱；编辑器打开整理后加 frontmatter id 转正）</>
                : <span className="text-[var(--warning)]">尚未打开仓库——扩展剪藏会收到「请先在 Phrontis 打开仓库」提示</span>}
            </div>
          </div>

          {/* 配对令牌卡 */}
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-2.5">
            <div className="text-[12px] font-medium text-[var(--text-primary)] flex items-center gap-1.5">
              <WifiOff size={12} className="text-[var(--text-muted)]" />浏览器扩展配对
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-[11.5px] px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)]">
                {st ? (tokenVisible ? st.token : st.tokenHint) : '…'}
              </code>
              <button onClick={() => setTokenVisible(v => !v)} className="text-[11px] px-2 py-1.5 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors" title={tokenVisible ? '隐藏令牌' : '显示完整令牌'}>
                {tokenVisible ? '隐藏' : '显示'}
              </button>
              <button onClick={() => copy('token', st?.token ?? '')} className="text-[11px] px-2 py-1.5 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-1">
                {copied === 'token' ? <Check size={11} /> : <Copy size={11} />}{copied === 'token' ? '已复制' : '复制'}
              </button>
              <button onClick={resetToken} className="text-[11px] px-2 py-1.5 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-1" title="重置后扩展需重新粘贴配对">
                <RotateCcw size={11} />重置
              </button>
            </div>
            <div className="text-[11px] text-[var(--text-disabled)] leading-relaxed">
              令牌保存在设备设置（不随仓库导出）。重置后浏览器扩展需重新粘贴。仅 127.0.0.1 + 扩展 Origin 白名单 + 令牌三重校验，剪藏内容不出本机。
            </div>
          </div>

          {/* 扩展安装指引 */}
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-2">
            <div className="text-[12px] font-medium text-[var(--text-primary)] flex items-center gap-1.5">
              <Puzzle size={12} className="text-[var(--text-muted)]" />安装浏览器扩展（Chrome / Edge / Brave）
            </div>
            <ol className="text-[11.5px] text-[var(--text-muted)] leading-relaxed list-decimal pl-4 space-y-1">
              <li>地址栏打开 <code className="text-[var(--text-secondary)]">chrome://extensions</code>，开启右上角「开发者模式」</li>
              <li>点「加载已解压的扩展程序」，选择下方目录：</li>
            </ol>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-[11px] px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)]">
                {st?.extensionDir || '（未找到扩展目录）'}
              </code>
              <button onClick={() => copy('extdir', st?.extensionDir ?? '')} disabled={!st?.extensionDir} className="text-[11px] px-2 py-1.5 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors flex items-center gap-1">
                {copied === 'extdir' ? <Check size={11} /> : <Copy size={11} />}{copied === 'extdir' ? '已复制' : '复制路径'}
              </button>
            </div>
            <li className="text-[11.5px] text-[var(--text-muted)] list-disc ml-5">扩展弹出面板中粘贴上面的配对令牌 → 看到「已连接」即可随页剪藏</li>
          </div>

          {/* 最近剪藏 */}
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-2">
            <div className="flex items-center gap-2">
              <div className="text-[12px] font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <FolderOpen size={12} className="text-[var(--text-muted)]" />最近剪藏
                {st?.clips.items.length ? <span className="text-[11px] text-[var(--text-disabled)]">（{st.clips.items.length}）</span> : null}
              </div>
              <button onClick={openFolder} className="ml-auto text-[11px] px-2 py-1 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
                打开文件夹
              </button>
            </div>
            {!st?.clips.available && <div className="text-[11px] text-[var(--text-disabled)]">当前仓库不可读</div>}
            {st?.clips.available && st.clips.items.length === 0 && <div className="text-[11px] text-[var(--text-disabled)]">还没有剪藏记录——装好扩展，看到好文章点一下即可</div>}
            {st?.clips.items.map(c => (
              <div key={c.name} className="flex items-center gap-2 text-[11.5px] py-1 border-b border-[var(--border-color)] last:border-0">
                <span className="text-[var(--text-disabled)] tabular-nums shrink-0">{formatTime(c.mtimeMs)}</span>
                <span className="truncate text-[var(--text-secondary)]" title={c.name}>{clipTitle(c.name)}</span>
                <span className="ml-auto shrink-0 text-[var(--text-disabled)]">{c.size > 1024 ? (c.size / 1024).toFixed(1) + ' KB' : c.size + ' B'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
