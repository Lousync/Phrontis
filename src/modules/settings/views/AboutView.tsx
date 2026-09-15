import { useRef, useState, useEffect } from 'react'
import {
  Sparkles, RefreshCw, Download, ExternalLink, Play,
  CheckCircle2, AlertTriangle, Loader2, Pause, X, MonitorUp, FileText,
} from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { getAppVersion, listReleaseNotes, openExternal, workspaceImportWelcomeDoc } from '../../../lib/ipc'
import { SettingSwitch } from '../../../components/shared/SettingSwitch'
import {
  useUpdateStore, updateCheck, updateDownload, updatePause, updateCancel, updateInstall,
  updateFailKind, updateFailMessage, updateStageText,
} from '../../../lib/updateStore'
import { MarkdownPreview } from '../../../components/shared/MarkdownPreview'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { showToast } from '../../../lib/toast'
import { notifyDataChanged } from '../../../lib/dataChanged'

/**
 * 镜像输入框旁的「常用」快捷填充。
 * 2026-09-15 摘掉 `cdn.gh-proxy.com`：实测是坏节点（对同一资产返回 206 响应头后 0 字节即 terminated），
 * 已同时从主进程 `FALLBACK_MIRRORS` 移除，不宜再作为推荐项出现在 UI 上。
 */
const MIRROR_PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['gh.dpik.top', 'https://gh.dpik.top'],
  ['gh-proxy.com', 'https://gh-proxy.com'],
]

/** 设置 → 关于：版本 / 更新（下载镜像） / 新手引导 */
export function AboutView() {
  const { s, update } = useSettings()
  const upd = useUpdateStore()
  const mirrorInputRef = useRef<HTMLInputElement | null>(null)
  const [appVersion, setAppVersion] = useState('')
  // 导入《欢迎》页面：已存在同名文件时不直接覆盖，先弹应用内确认（该文件用户可自由改写）
  const [importingWelcome, setImportingWelcome] = useState(false)
  const [overwriteAsk, setOverwriteAsk] = useState(false)
  // 更新说明：已积累的版本数（按钮文案用）
  const [notesCount, setNotesCount] = useState(0)

  useEffect(() => { getAppVersion().then(setAppVersion).catch(() => {}) }, [])
  useEffect(() => {
    listReleaseNotes().then(l => setNotesCount(l?.length ?? 0)).catch(() => {})
  }, [])

  /** force=false 首次尝试：仓库无同名文件则直接导入；已有则转为覆盖确认 */
  const runImportWelcome = async (force: boolean) => {
    if (importingWelcome) return
    setImportingWelcome(true)
    try {
      const r = await workspaceImportWelcomeDoc(force)
      if (r.error) { showToast({ type: 'error', message: r.error }); return }
      if (r.exists) { setOverwriteAsk(true); return }
      notifyDataChanged('knowledge')
      showToast({
        type: 'info',
        message: `${r.created ? '《欢迎》页面已导入知识库' : '《欢迎》页面已更新为最新版'}${
          r.hasLegacyMd ? '；仓库根另有旧版「欢迎.md」，知识库会出现两条同名页面，可自行删除其一' : ''
        }`,
      })
    } catch (e) {
      showToast({ type: 'error', message: `导入失败：${(e as Error).message || '未知错误'}` })
    } finally {
      setImportingWelcome(false)
    }
  }

  const failText = upd.check ? updateFailMessage(upd) : (upd.error || '检查失败,请检查网络')
  const failKind = upd.check ? updateFailKind(upd.reason) : 'network'
  // 非进度类阶段提示(校验中/换镜像);downloading 时为 null,按常规进度渲染
  const stageText = updateStageText(upd.stage)

  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">关于</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-6">版本信息与应用更新</p>

      <div className="mb-8" data-setting-anchor="advanced.update">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">关于与更新</h3>
        <div className="flex items-center gap-3 mb-3">
          <span className="text-[13px] text-[var(--text-primary)]">当前版本 v{appVersion || '…'}</span>
          <button
            onClick={() => void updateCheck()}
            disabled={upd.phase === 'checking' || upd.phase === 'downloading'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-[var(--text-primary)] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {upd.phase === 'checking' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {upd.phase === 'checking' ? '检查中…' : '检查更新'}
          </button>
        </div>

        <div className="mb-4 max-w-md" data-setting-anchor="advanced.mirror">
          <label className="block text-[12px] text-[var(--text-secondary)] mb-1">下载镜像(GitHub 加速代理)</label>
          <input
            ref={mirrorInputRef}
            value={String(s.updateMirror ?? '')}
            onChange={e => update('updateMirror', e.target.value.trim())}
            placeholder="留空 = 直连 GitHub,例:https://gh.dpik.top"
            spellCheck={false}
            className="w-full px-2.5 py-1.5 text-[12px] font-mono bg-[var(--input-bg)] border border-[var(--border-color)] rounded outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
          />
          <p className="text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">
            镜像仅用于加速下载，失效自动回退直连。常用:{' '}
            {MIRROR_PRESETS.map(([name, url], i) => (
              <span key={url}>
                <button onClick={() => update('updateMirror', url)} className="text-[var(--accent)] hover:underline font-mono" title={`使用 ${url}`}>
                  {name}
                </button>
                {i < MIRROR_PRESETS.length - 1 && ' / '}
              </span>
            ))}
          </p>
        </div>

        {upd.phase === 'uptodate' && (
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--success)]">
            <CheckCircle2 size={13} />已是最新版本
          </div>
        )}

        {upd.phase === 'error' && (
          <div className="border border-[var(--danger)]/40 rounded-lg p-3 max-w-md bg-[var(--bg-secondary)]">
            <div className="flex items-start gap-1.5">
              <AlertTriangle size={13} className="text-[var(--danger)] mt-0.5 shrink-0" />
              <span className="text-[12px] text-[var(--danger)] leading-relaxed">{failText}</span>
            </div>
            {upd.check && (
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <button onClick={() => void updateDownload()}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-white bg-[var(--accent)] rounded hover:bg-[var(--accent-hover)] transition-colors">
                  <RefreshCw size={11} />{failKind === 'integrity' ? '重新下载' : '重试'}
                </button>
                <button onClick={() => {
                  mirrorInputRef.current?.focus()
                  mirrorInputRef.current?.select()
                }}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] border border-[var(--border-color)] rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                  <MonitorUp size={11} />更换镜像重试
                </button>
                <span className="text-[11px] text-[var(--text-muted)]">换镜像后点「重新下载」即可断点续传</span>
              </div>
            )}
          </div>
        )}

        {(upd.phase === 'available' || upd.phase === 'downloading' || upd.phase === 'paused' || upd.phase === 'downloaded') && upd.check && (
          <div className="border border-[var(--border-color)] rounded-lg p-3 max-w-md bg-[var(--bg-secondary)]">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={13} className="text-[var(--accent)]" />
              <span className="text-[13px] font-medium text-[var(--text-primary)]">发现新版本 v{upd.check.latestVersion}</span>
              <button
                onClick={() => openExternal(upd.check!.releaseUrl).catch(() => {})}
                className="ml-auto flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
              >
                <ExternalLink size={11} />发布页
              </button>
            </div>

            {(upd.phase === 'downloading' || upd.phase === 'paused') ? (
              <div>
                <div className="h-1.5 bg-[var(--bg-tertiary)] rounded overflow-hidden mb-1.5">
                  <div className={`h-full transition-all ${upd.phase === 'paused' ? 'bg-[var(--warning)]' : 'bg-[var(--accent)]'}`} style={{ width: `${upd.progress.percent}%` }} />
                </div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  {stageText ? (
                    <span className="text-[var(--accent)]">{stageText}</span>
                  ) : (
                    <>
                      {upd.phase === 'paused' ? '已暂停 ' : '正在下载 '}{upd.check.asset?.name} — {upd.progress.percent}%
                      {upd.progress.totalBytes > 0 && `（${(upd.progress.receivedBytes / 1048576).toFixed(1)} / ${(upd.progress.totalBytes / 1048576).toFixed(1)} MB）`}
                      {upd.phase === 'paused' && ',继续下载将从断点续传'}
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  {upd.phase === 'downloading' ? (
                    <button onClick={() => void updatePause()}
                      className="flex items-center gap-1 px-2.5 py-1 text-[11px] border border-[var(--border-color)] rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                      <Pause size={11} />暂停
                    </button>
                  ) : (
                    <button onClick={() => void updateDownload()}
                      className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-white bg-[var(--accent)] rounded hover:bg-[var(--accent-hover)] transition-colors">
                      <Download size={11} />继续下载
                    </button>
                  )}
                  <button onClick={() => void updateCancel()}
                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] border border-[var(--border-color)] rounded text-[var(--text-secondary)] hover:text-red-400 hover:bg-[var(--bg-hover)] transition-colors">
                    <X size={11} />取消下载
                  </button>
                </div>
              </div>
            ) : upd.phase === 'downloaded' ? (
              <div>
                <div className="flex items-center gap-1.5 text-[12px] text-[var(--success)] mb-2">
                  <CheckCircle2 size={13} />安装包已下载到系统「下载」目录
                </div>
                {upd.metaMissing && (
                  <div className="flex items-start gap-1.5 text-[11px] text-[var(--warning)] mb-2 leading-relaxed">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    更新源文件不完整:latest.yml 缺失,已按文件大小完成校验;若安装时提示 integrity check failed,请到发布页手动下载
                  </div>
                )}
                <button
                  onClick={() => void updateInstall()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] transition-colors"
                >
                  <Play size={12} />运行安装程序
                </button>
                <p className="text-[11px] text-[var(--text-muted)] mt-2">重新打开应用即完成更新。</p>
              </div>
            ) : (
              <div>
                {upd.check.asset ? (
                  <button
                    onClick={() => void updateDownload()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] transition-colors mb-2"
                  >
                    <Download size={12} />下载更新
                  </button>
                ) : (
                  <p className="text-[11px] text-[var(--text-muted)] mb-2">该版本未附带安装包，请前往发布页手动下载</p>
                )}
                {upd.check.notes && (
                  <details className="text-[12px]">
                    <summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-secondary)]">查看更新内容</summary>
                    <div className="mt-2 max-h-48 overflow-y-auto border border-[var(--border-color)] rounded p-2 bg-[var(--bg-primary)]">
                      <MarkdownPreview content={upd.check.notes} />
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 更新说明（VS Code 式 tab）：开关注册在 src/lib/settings.ts 的 releaseNotesAutoOpen /
          releaseNotesKeepHistory，说明见 docs/release-notes-design.md */}
      <div className="mb-8" data-setting-anchor="advanced.releaseNotes">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">更新说明</h3>

        <div className="flex items-center justify-between gap-3 max-w-md py-1.5">
          <span className="text-[12px] text-[var(--text-primary)]">新版本时自动打开更新说明</span>
          <SettingSwitch
            checked={s.releaseNotesAutoOpen !== false}
            onChange={v => update('releaseNotesAutoOpen', v)}
            aria-label="新版本时自动打开更新说明"
          />
        </div>
        <p className="text-[11px] text-[var(--text-muted)] max-w-md leading-relaxed">
          中间版本号（x.y）变化后的首次启动自动打开一页；修正版（x.y.z）与全新安装不打扰。
        </p>

        <div className="flex items-center justify-between gap-3 max-w-md py-1.5 mt-3">
          <span className="text-[12px] text-[var(--text-primary)]">在仓库中保留更新说明存档</span>
          <SettingSwitch
            checked={s.releaseNotesKeepHistory !== false}
            onChange={v => update('releaseNotesKeepHistory', v)}
            aria-label="在仓库中保留更新说明存档"
          />
        </div>
        <p className="text-[11px] text-[var(--text-muted)] max-w-md leading-relaxed">
          版本说明与阅读记录写入仓库的 <span className="font-mono">.knowbase/modules/release-notes/</span>，换电脑拷走仓库一并带走。
        </p>

        <div className="mt-3" data-setting-anchor="advanced.releaseNotesOpen">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('release-notes:open'))}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-[var(--text-primary)] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-colors"
          >
            <FileText size={12} />
            打开更新说明
          </button>
          <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed max-w-md">
            共 {notesCount} 个版本，页内可回看历史版本与全部变更条目。
          </p>
        </div>
      </div>

      <div data-setting-anchor="advanced.onboarding">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">新手引导</h3>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('onboarding:show'))}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-[var(--text-primary)] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-colors"
        >
          <Sparkles size={12} />
          重新查看新手引导
        </button>

        <div className="mt-4" data-setting-anchor="advanced.welcomeImport">
          <button
            onClick={() => void runImportWelcome(false)}
            disabled={importingWelcome}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-[var(--text-primary)] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {importingWelcome ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
            {importingWelcome ? '导入中…' : '导入《欢迎》页面到知识库'}
          </button>
          <p className="text-[11px] text-[var(--text-muted)] mt-1.5 leading-relaxed max-w-md">
            把《欢迎》导览页(<span className="font-mono">欢迎.html</span>)写回仓库根目录并收录进知识库，适合误删后恢复、或重新生成为最新版导览。
            仓库里已有该文件时会先询问，确认后覆盖(你对它的改动将被重置)。
          </p>
        </div>
      </div>

      <ConfirmDialog
        open={overwriteAsk}
        title="覆盖已有的《欢迎》页面？"
        message="仓库根目录已存在 欢迎.html。继续将用最新版导览内容覆盖它，你对这个文件的改动会被重置。"
        confirmLabel="覆盖导入"
        cancelLabel="取消"
        showCheckbox={false}
        variant="default"
        onConfirm={() => { setOverwriteAsk(false); void runImportWelcome(true) }}
        onCancel={() => setOverwriteAsk(false)}
      />
    </div>
  )
}
