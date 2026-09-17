import { useState, useEffect, useRef } from 'react'
import { useSettings } from '../../lib/SettingsContext'
import {
  X, Pin, ArrowDownToLine, Loader2, Play,
  Pause, Download, AlertTriangle, RefreshCw, SlidersHorizontal, ExternalLink,
  CalendarCheck2, UserPlus, MonitorPlay, LayoutGrid,
} from 'lucide-react'
import {
  useUpdateStore, updateStartupCheck, updateDownload, updatePause, updateCancel, updateInstall,
  updateFailKind, updateFailMessage, updateStageText,
} from '../../lib/updateStore'
import { MarkdownPreview } from './MarkdownPreview'
import { openExternal, edgeResizeStart, edgeResizeEnd } from '../../lib/ipc'
import { showToast } from '../../lib/toast'

function showToastSafe(message: string): void {
  showToast({ type: 'info', message })
}

interface TitleBarProps {
  /** 日程打卡侧边栏当前是否激活（内嵌显示中或独立窗口打开中）。用于按钮高亮 */
  dayPanelActive?: boolean
  /** 点击日程打卡侧边栏开关按钮：App 统一处理「脱离态→吸附 / 内嵌态→显示」逻辑 */
  onToggleDayPanel?: () => void
  /** 布局菜单 · 活动栏段：整条活动栏当前是否显示 + 切换出口（App 侧读写同一 setting） */
  activityBarVisible?: boolean
  onActivityBarChange?: (visible: boolean) => void
  /** 布局菜单 · 布局模式段：禅模式档位 + 切换出口（复用 App 的 zenLevel 单一真相源） */
  zenLevel?: number
  onZenLevelChange?: (n: number) => void
  /** 布局菜单 · 布局模式段：纯 OS 全屏开关（VS Code F11 语义，与禅模式相互独立） */
  osFullscreen?: boolean
  onOsFullscreenChange?: (v: boolean) => void
}

export function TitleBar({
  dayPanelActive = false, onToggleDayPanel,
  activityBarVisible = true, onActivityBarChange, zenLevel = 0, onZenLevelChange,
  osFullscreen = false, onOsFullscreenChange,
}: TitleBarProps = {}) {
  const { s: settings, update: updateSetting } = useSettings()
  const badgeEgg = settings.badgeEggActivated
  const [isMaximized, setIsMaximized] = useState(false)
  // DEV 专属：模拟新用户第一次进入（两段式确认防误触）——模拟的是「选择仓库阶段」：
  // 退出当前仓库（清 currentVaultId）→ 重载 → workspaceGetCurrent 为空 → 走欢迎/仓库选择页。
  // 不动新手引导（onboarding 是另一阶段，设置页已有重看入口）；仓库数据/登记不受影响
  const [freshUserArm, setFreshUserArm] = useState(false)
  const isDevSession = typeof location !== 'undefined' && location.protocol === 'http:'
  const simulateFirstRun = async (): Promise<void> => {
    try { await window.api.workspaceClearCurrentVault() } catch { /* ignore */ }
    try { sessionStorage.clear() } catch { /* 隐私模式忽略 */ }
    showToastSafe('已退出当前仓库，正在重载（进入仓库选择阶段）…')
    setTimeout(() => location.reload(), 400)
  }
  // DEV 专属：开始界面轮巡预览——应用共 2 个「选仓库/开始」界面（WelcomeOverlay 已于 2026-09-09 删除，
  // 无仓库统一走 VaultPicker），点一次切一个，第三下关闭。只拨 App.tsx 里的开关（dev:startScreen 事件）
  const START_SCREENS = [
    { key: 'first', label: '仓库选择页（无当前仓库 · VaultPicker 首启形态）' },
    { key: 'startup', label: '仓库选择页（每次启动 · VaultPicker startup 形态）' },
  ] as const
  const [startScreenIdx, setStartScreenIdx] = useState(-1)
  const cycleStartScreen = (): void => {
    const next = startScreenIdx + 1 >= START_SCREENS.length ? -1 : startScreenIdx + 1
    setStartScreenIdx(next)
    window.dispatchEvent(new CustomEvent('dev:startScreen', { detail: next < 0 ? null : START_SCREENS[next].key }))
    showToastSafe(next < 0 ? '开始界面预览已关闭' : `${next + 1}/${START_SCREENS.length} · ${START_SCREENS[next].label}`)
  }
  const [isPinned, setIsPinned] = useState(false)

  // ---- 更新入口:全部状态来自全局 updateStore,与设置页(高级)完全同步 ----
  const upd = useUpdateStore()
  const [panelOpen, setPanelOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const prevPhaseRef = useRef(upd.phase)

  useEffect(() => {
    window.api?.isMaximized()?.then(setIsMaximized)
    window.api?.isAlwaysOnTop()?.then(setIsPinned)
    window.api?.onMaximizeChange?.((v: boolean) => setIsMaximized(v))
    // 启动静默检查:store 内部幂等 + 6s 延迟 + 失败重试 3 次后静默
    updateStartupCheck()
  }, [])

  // 下载完成提示(状态中枢收尾时在标题栏提醒一次)
  useEffect(() => {
    if (prevPhaseRef.current !== 'downloaded' && upd.phase === 'downloaded') {
      showToastSafe(upd.metaMissing
        ? '安装包已就绪,但更新源元数据(latest.yml)缺失,安装可能校验失败'
        : `v${upd.check?.latestVersion || ''} 安装包已就绪,点击标题栏 ▶ 运行安装`)
    }
    prevPhaseRef.current = upd.phase
  }, [upd.phase, upd.metaMissing, upd.check?.latestVersion])

  // 面板外点击关闭
  useEffect(() => {
    if (!panelOpen) return
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setPanelOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [panelOpen])

  // ---- 布局菜单（VS Code Customize Layout 同款）：活动栏位置 + 布局模式 ----
  // 与上面「更新入口」的展开态各管各的：两个面板不会互相顶掉，各自点外部关闭。
  // 点选项 = 即刻生效并收起（开发负责人 2026-09-15 拍板，对齐 VS Code 菜单语义）——
  // 活动栏藏掉后这枚按钮留在原位并带描边提示，随时可以点开调回来
  const [layoutOpen, setLayoutOpen] = useState(false)
  const layoutRef = useRef<HTMLDivElement | null>(null)
  // 活动栏被整条藏起来时，这枚按钮自我解释（描边 + 强调色）——「洞」还在时用户得知道去哪儿找回来。
  // 菜单开着时让位给展开态底色，同一枚按钮不叠两种强调
  const abHiddenHint = activityBarVisible === false

  useEffect(() => {
    if (!layoutOpen) return
    const onDown = (e: PointerEvent) => {
      if (layoutRef.current && !layoutRef.current.contains(e.target as Node)) setLayoutOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [layoutOpen])

  // 入口可见:有新版/下载中/暂停/已下载,或下载失败(检查失败不展示,避免网络抖动打扰)
  const showEntry =
    upd.phase === 'available' || upd.phase === 'downloading' || upd.phase === 'paused' ||
    upd.phase === 'downloaded' || (upd.phase === 'error' && !!upd.check)

  const handleEntryClick = () => {
    // 已下载:点击直接运行安装(快速路径);其余状态展开面板
    if (upd.phase === 'downloaded') { void updateInstall(); return }
    setPanelOpen(o => !o)
  }

  const goSettings = () => {
    setPanelOpen(false)
    window.dispatchEvent(new CustomEvent('settings:open', { detail: { section: 'advanced' } }))
  }

  // UI 优化条目1.7（Q2 拍板）：最大化后拖标题栏空白处 = 恢复窗口 + 跟随移动。
  // 透明无埋窗口在最大化态的 drag-region 原生行为不可靠，统一并入 edgeResize 协议：
  // overlay（no-drag，压在空白区之上、交互控件之下）mousedown → 主进程 edge='move' 恢复+跟随；
  // 双击 = 还原/最大化 toggle（Edge 同款语义）。渲染层 mouseup 收尾跟随循环。
  const onMaxTitleDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    void edgeResizeStart('move').catch(() => {})
    const up = () => { void edgeResizeEnd().catch(() => {}); window.removeEventListener('mouseup', up) }
    window.addEventListener('mouseup', up)
  }

  const entryTitle =
    upd.phase === 'downloading' ? `正在下载 v${upd.check?.latestVersion}… ${upd.progress.percent}%`
    : upd.phase === 'paused' ? `下载已暂停 v${upd.check?.latestVersion},点击继续`
    : upd.phase === 'downloaded' ? `v${upd.check?.latestVersion} 已下载,点击运行安装程序`
    : upd.phase === 'error' ? `更新失败:${upd.error}`
    : `发现新版本 v${upd.check?.latestVersion},点击查看`

  const failKind = updateFailKind(upd.reason)
  // 非进度类阶段提示(校验中/换镜像);downloading 时为 null,按常规进度渲染
  const stageText = updateStageText(upd.stage)

  function togglePin() {
    const next = !isPinned
    setIsPinned(next)
    window.api?.setAlwaysOnTop(next)
  }

  return (
    <div
      className="relative z-[75] flex items-center h-9 bg-[color-mix(in_srgb,var(--bg-tertiary)_72%,transparent)] backdrop-blur-md border-b border-[var(--border-color)] select-none shrink-0 drag-region"
    >
      {/* 左：macOS 红绿灯窗控 + 开发版角标 + 窗口级操作（锚定主内容区，不随抽屉外扩漂移） */}
      <div className="relative z-10 flex items-center h-full pl-3 no-drag group/traffic">
        <TrafficLight color="#ff5f57" title="关闭" onClick={() => window.api?.close()}>
          <svg width="10" height="10" viewBox="0 0 8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none">
            <path d="M1.7 1.7 L6.3 6.3 M6.3 1.7 L1.7 6.3" />
          </svg>
        </TrafficLight>
        <TrafficLight color="#febc2e" title="最小化" onClick={() => window.api?.minimize()}>
          <svg width="10" height="10" viewBox="0 0 8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none">
            <path d="M1.7 4 H6.3" />
          </svg>
        </TrafficLight>
        <TrafficLight color="#28c840" title={isMaximized ? '还原' : '最大化'} onClick={() => window.api?.maximize()}>
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 8 8" fill="currentColor">
              <path d="M1 3.2 L3.2 1 L3.2 3.2 Z" />
              <path d="M7 4.8 L4.8 7 L4.8 4.8 Z" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 8 8" fill="currentColor">
              <path d="M1 1 L4 1 L1 4 Z" />
              <path d="M7 7 L4 7 L7 4 Z" />
            </svg>
          )}
        </TrafficLight>

        {/* DEV 专属：模拟新用户第一次进入（清 onboardingDone + 首启标记 → reload 弹引导）；打包版不显示 */}
        {isDevSession && (
          <button
            onClick={() => { if (freshUserArm) { setFreshUserArm(false); void simulateFirstRun() } else { setFreshUserArm(true); setTimeout(() => setFreshUserArm(false), 3000) } }}
            title={freshUserArm ? '再点一次确认：退出当前仓库并重载（进入选择仓库阶段，数据不受影响）' : '模拟新用户第一次进入（退出当前仓库 → 选择仓库阶段，dev 专属）'}
            className={`ml-2.5 flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded border select-none transition-colors ${freshUserArm ? 'bg-amber-500/25 text-amber-500 border-amber-500/60' : 'bg-amber-500/10 text-amber-500/70 border-amber-500/30 hover:text-amber-500 hover:bg-amber-500/20'}`}>
            <UserPlus size={10} />
            {freshUserArm ? '确认重置?' : '模拟新用户'}
          </button>
        )}

        {/* DEV 专属：轮巡预览 2 个仓库选择界面（无当前仓库首启 / 每次启动 startup 形态） */}
        {isDevSession && (
          <button
            onClick={cycleStartScreen}
            title="预览开始界面（dev 专属）：每点一次切换下一个——无仓库首启选择 / 每次启动选择，第三下关闭"
            className={`ml-1.5 flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded border select-none transition-colors ${startScreenIdx >= 0 ? 'bg-sky-500/25 text-sky-400 border-sky-500/60' : 'bg-sky-500/10 text-sky-400/70 border-sky-500/30 hover:text-sky-400 hover:bg-sky-500/20'}`}>
            <MonitorPlay size={10} />
            {startScreenIdx < 0 ? '开始界面' : `${startScreenIdx + 1}/${START_SCREENS.length}`}
          </button>
        )}

        {/* 开发版角标：dev server 是 http://，打包版是 file:// */}
        {(typeof location !== 'undefined' && location.protocol === 'http:') || badgeEgg ? (
          <span className="ml-2.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-500/20 text-amber-500 border border-amber-500/40 select-none">
            {badgeEgg ? 'YHAz' : 'DEV'}
          </span>
        ) : null}

        {/* UI 打磨点1：仓库切换器已迁至编辑器侧栏底部（editor/index.tsx treeColumn） */}

        {/* 窗口级操作：更新入口 / 日程侧边栏开关 / 置顶 */}
        {showEntry && (
          <div className="relative h-full ml-1" ref={panelRef}>
            <WinBtn onClick={handleEntryClick} title={entryTitle} className="w-9">
              {upd.phase === 'downloading'
                ? <span className="relative flex items-center justify-center w-[18px] h-[18px]">
                    <Loader2 size={13} strokeWidth={2} className="animate-spin text-[var(--accent)]" />
                  </span>
                : upd.phase === 'paused'
                  ? <Pause size={12} strokeWidth={2.5} className="text-[var(--warning)]" />
                  : upd.phase === 'downloaded'
                    ? <Play size={12} strokeWidth={2.5} className="text-[var(--success)]" fill="currentColor" />
                    : upd.phase === 'error'
                      ? <AlertTriangle size={13} strokeWidth={2} className="text-[var(--danger)]" />
                      : <ArrowDownToLine size={14} strokeWidth={2} className="text-[var(--accent)]" />}
              {upd.phase === 'available' && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[var(--warning)] animate-pulse" title="" />
              )}
            </WinBtn>

              {/* 下拉面板:进度/暂停/取消/重试/去设置,状态与设置页同源 */}
              {panelOpen && upd.phase !== 'downloaded' && (
                <div className="absolute left-0 top-full mt-1 w-80 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg z-50 no-drag overflow-hidden">
                  {upd.phase === 'available' && upd.check && (
                    <div className="p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <ArrowDownToLine size={13} className="text-[var(--accent)]" />
                        <span className="text-[13px] font-medium text-[var(--text-primary)]">发现新版本 v{upd.check.latestVersion}</span>
                        <button onClick={() => { void openExternal(upd.check!.releaseUrl).catch(() => {}) }}
                          className="ml-auto text-[var(--text-muted)] hover:text-[var(--accent)]" title="在浏览器打开发布页">
                          <ExternalLink size={12} />
                        </button>
                      </div>
                      <p className="text-[11px] text-[var(--text-muted)] mb-2">当前 v{upd.check.currentVersion} → 新版 v{upd.check.latestVersion}</p>
                      {upd.check.notes && (
                        <details className="mb-2 text-[12px]">
                          <summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-secondary)]">查看更新内容</summary>
                          <div className="mt-1.5 max-h-40 overflow-y-auto border border-[var(--border-color)] rounded p-2 bg-[var(--bg-secondary)]">
                            <MarkdownPreview content={upd.check.notes} />
                          </div>
                        </details>
                      )}
                      <div className="flex items-center gap-2">
                        <button onClick={() => void updateDownload()}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-medium text-white bg-[var(--accent)] rounded hover:bg-[var(--accent-hover)] transition-colors">
                          <Download size={12} />立即下载
                        </button>
                        <button onClick={goSettings}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] border border-[var(--border-color)] rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                          <SlidersHorizontal size={12} />去设置页管理
                        </button>
                      </div>
                    </div>
                  )}

                  {(upd.phase === 'downloading' || upd.phase === 'paused') && (
                    <div className="p-3">
                      <div className="h-1.5 bg-[var(--bg-tertiary)] rounded overflow-hidden mb-1.5">
                        <div className={`h-full transition-all ${upd.phase === 'paused' ? 'bg-[var(--warning)]' : 'bg-[var(--accent)]'}`}
                          style={{ width: `${upd.progress.percent}%` }} />
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] mb-2">
                        {stageText ? (
                          <span className="text-[var(--accent)]">{stageText}</span>
                        ) : (
                          <>
                            {upd.phase === 'paused' ? '已暂停 ' : '正在下载 '}{upd.check?.asset?.name} — {upd.progress.percent}%
                            {upd.progress.totalBytes > 0 && `（${(upd.progress.receivedBytes / 1048576).toFixed(1)} / ${(upd.progress.totalBytes / 1048576).toFixed(1)} MB）`}
                            {upd.phase === 'paused' && ',继续下载将从断点续传'}
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
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
                        <button onClick={goSettings} className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)]">去设置页</button>
                      </div>
                    </div>
                  )}

                  {upd.phase === 'error' && (
                    <div className="p-3">
                      <div className="flex items-start gap-1.5 mb-2">
                        <AlertTriangle size={13} className="text-[var(--danger)] mt-0.5 shrink-0" />
                        <span className="text-[12px] text-[var(--danger)] leading-relaxed">{updateFailMessage(upd)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => { setPanelOpen(false); void updateDownload() }}
                          className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-white bg-[var(--accent)] rounded hover:bg-[var(--accent-hover)] transition-colors">
                          <RefreshCw size={11} />重试
                        </button>
                        <button onClick={goSettings}
                          className="flex items-center gap-1 px-2.5 py-1 text-[11px] border border-[var(--border-color)] rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                          <SlidersHorizontal size={11} />{failKind === 'integrity' ? '更换镜像重试' : '镜像设置'}
                        </button>
                        {upd.downloadedPath && (
                          <button onClick={() => void updateInstall()}
                            className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)]">
                            重新运行安装包
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {(upd.phase === 'checking' || upd.phase === 'uptodate' || upd.phase === 'idle') && (
                    <div className="p-3 text-[12px] text-[var(--text-muted)] flex items-center gap-1.5">
                      {upd.phase === 'checking' && <Loader2 size={12} className="animate-spin" />}
                      {upd.phase === 'uptodate' ? '已是最新版本' : '正在检查更新…'}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* 布局控件组（VS Code Customize Layout 同款）：官方说法是「标题栏里切换主 UI 元素可见性的那组按钮
              （Side bars / Panel region），最右那枚开 Customize Layout 下拉」——
              于是「日程与打卡侧边栏」= VS Code 的 toggle Panel region，与「布局」同属一组。
              两侧细线把这一组与相邻的窗口级操作（更新 / 置顶）切开，读起来是「一组布局能力」
              而不是凭空多出来的一个图标。
              摆在窗口按钮簇里而不放标题栏最右：Phrontis 的窗口级操作全在左簇，右侧只有绝对定位的搜索框，
              单摆一枚图标到最右会回到「平白无故冒出来」的观感（原型里把它画在右侧是原型没对齐真机布局） */}
          <span className="mx-1 h-4 w-px shrink-0 bg-[var(--border-color)]" aria-hidden />
          <WinBtn
            onClick={onToggleDayPanel ?? (() => {})}
            title="日程与打卡侧边栏 (Ctrl+Alt+S)"
            className="w-9"
          >
            <CalendarCheck2
              size={14}
              strokeWidth={1.5}
              className={dayPanelActive ? 'text-[var(--accent)]' : ''}
              fill={dayPanelActive ? 'var(--accent)' : 'transparent'}
              fillOpacity={dayPanelActive ? 0.25 : 0}
            />
          </WinBtn>

          <div className="relative h-full" ref={layoutRef}>
            <WinBtn
              onClick={() => setLayoutOpen(o => !o)}
              title="自定义布局 · 活动栏与布局模式"
              className={`w-9 ${layoutOpen ? 'bg-[var(--bg-hover)]' : abHiddenHint ? 'bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/45' : ''}`}
            >
              <LayoutGrid size={14} strokeWidth={1.5}
                className={abHiddenHint || layoutOpen ? 'text-[var(--accent)]' : ''} />
            </WinBtn>

            {layoutOpen && (
              <div className="kb-pop absolute left-0 top-full z-50 mt-1 w-[296px] overflow-hidden rounded-[11px] border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl no-drag">
                <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
                  <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">自定义布局</span>
                  <span className="ml-auto text-[10.5px] text-[var(--text-muted)]">随全局保存</span>
                </div>
                <div className="mx-2 h-px bg-[var(--border-color)]" />

                <div className="px-2.5 pb-1 pt-2.5">
                  <div className="px-1 pb-2 text-[10.5px] tracking-[0.6px] text-[var(--text-muted)]">活动栏</div>
                  <div className="grid grid-cols-2 gap-1">
                    <LayoutOpt selected={!abHiddenHint} onClick={() => { onActivityBarChange?.(true); setLayoutOpen(false) }} label="默认">
                      {WF_AB_DEFAULT}
                    </LayoutOpt>
                    <LayoutOpt selected={abHiddenHint} onClick={() => { onActivityBarChange?.(false); setLayoutOpen(false) }} label="隐藏">
                      {WF_AB_HIDDEN}
                    </LayoutOpt>
                  </div>
                </div>

                <div className="mt-1.5 border-t border-[var(--border-color)] px-2.5 pb-1 pt-2.5">
                  <div className="flex items-center gap-1.5 px-1 pb-2 text-[10.5px] tracking-[0.6px] text-[var(--text-muted)]">
                    布局模式
                    <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-px text-[9.5px] tracking-normal">复用现有</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    <LayoutOpt selected={osFullscreen} onClick={() => { onOsFullscreenChange?.(!osFullscreen); setLayoutOpen(false) }} label="全屏">
                      {WF_MODE_FULL}
                    </LayoutOpt>
                    <LayoutOpt selected={zenLevel >= 2} onClick={() => { onZenLevelChange?.(zenLevel >= 2 ? 0 : 2); setLayoutOpen(false) }} label="禅模式">
                      {WF_MODE_ZEN}
                    </LayoutOpt>
                  </div>
                </div>

                <div className="mx-2 mt-1.5 border-t border-[var(--border-color)]" />
                {/* 脚注 = 元信息，不该常驻占面板高度 → 按全应用同款 <details> 折叠收起
                    （与上方更新面板的「查看更新内容」同一套写法；summary 保留默认三角当展开提示） */}
                <details className="px-3 pb-1.5 pt-2 text-[10.5px] text-[var(--text-muted)]">
                  <summary className="cursor-pointer select-none text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">说明</summary>
                  <div className="pt-1.5 leading-relaxed">
                    活动栏隐藏后，标题栏这枚「布局」按钮不会消失，随时可以把它调回来。<br />
                    禅模式原先挂在「AI 教学」模块顶栏，本次起统一收进这里 —— 全局只有这一个入口。
                  </div>
                </details>
              </div>
            )}
          </div>
          <span className="mx-1 h-4 w-px shrink-0 bg-[var(--border-color)]" aria-hidden />

          <WinBtn onClick={togglePin} title={isPinned ? '取消置顶' : '窗口置顶'} className="w-9">
            <Pin size={14} strokeWidth={1.5} fill={isPinned ? 'var(--text-primary)' : 'transparent'} />
          </WinBtn>
        </div>

      {/* UI 优化条目1.7：最大化态顶栏拖拽恢复 overlay（空白区接管，控件 z-10 保持可点；双击 toggle 还原） */}
      {isMaximized && (
        <div className="absolute inset-0 no-drag z-0" onMouseDown={onMaxTitleDown} onDoubleClick={() => window.api?.maximize()} />
      )}
    </div>
  )
}

function WinBtn({ children, onClick, title, className = '' }: {
  children: React.ReactNode; onClick: () => void; title?: string; className?: string
}) {
  return (
    <button onClick={onClick} title={title}
      className={`relative flex items-center justify-center h-full transition-colors duration-100 text-[var(--text-primary)] hover:bg-[var(--bg-hover)] ${className || 'w-11'}`}>
      {children}
    </button>
  )
}

/** macOS 红绿灯窗控：16px 彩色圆点，hover 组内点亮符号、单键加深 */
function TrafficLight({ color, title, onClick, children }: {
  color: string; title?: string; onClick: () => void; children?: React.ReactNode
}) {
  return (
    <button onClick={onClick} title={title}
      className="flex items-center justify-center w-5 h-5 transition-[filter] duration-100 hover:brightness-90">
      <span className="flex items-center justify-center w-4 h-4 rounded-full text-black/60 leading-none"
        style={{ backgroundColor: color }}>
        <span className="flex items-center justify-center leading-none opacity-0 group-hover/traffic:opacity-100 transition-opacity duration-100">
          {children}
        </span>
      </span>
    </button>
  )
}

/* ===== 布局菜单的选项（VS Code 的做法：给迷你线框图，不给文字开关）=====
   四张线框共用 46×31 画布：左边一条竖条 = 活动栏，中间三条横线 = 内容。
   实心竖条 = 显示；虚线竖条 = 隐藏；四角括号 = 全屏；居中窄块 = 禅模式。
   颜色一律继承 currentColor —— 选中态由外层 LayoutOpt 改文字色（走主题 accent），
   图里不写死任何颜色，亮/暗主题自动跟随。 */
const WF_AB_DEFAULT = (
  <svg width="46" height="31" viewBox="0 0 46 31" fill="none" stroke="currentColor" aria-hidden>
    <rect x="1" y="1" width="44" height="29" rx="3.4" strokeWidth="1.3" />
    <rect x="2" y="2" width="8.4" height="27" rx="2.4" fill="currentColor" stroke="none" opacity="0.5" />
    <path d="M14 7h24M14 13h18M14 19h22" strokeWidth="1.1" opacity="0.45" strokeLinecap="round" />
  </svg>
)
const WF_AB_HIDDEN = (
  <svg width="46" height="31" viewBox="0 0 46 31" fill="none" stroke="currentColor" aria-hidden>
    <rect x="1" y="1" width="44" height="29" rx="3.4" strokeWidth="1.3" />
    <rect x="2" y="2" width="8.4" height="27" rx="2.4" strokeWidth="1.1" strokeDasharray="2.4 2.2" opacity="0.5" />
    <path d="M14 7h24M14 13h18M14 19h22" strokeWidth="1.1" opacity="0.45" strokeLinecap="round" />
  </svg>
)
const WF_MODE_FULL = (
  <svg width="46" height="31" viewBox="0 0 46 31" fill="none" stroke="currentColor" aria-hidden>
    <rect x="1" y="1" width="44" height="29" rx="3.4" strokeWidth="1.3" />
    <rect x="3.4" y="3.4" width="39.2" height="24.2" rx="2" fill="currentColor" stroke="none" opacity="0.16" />
    <path d="M7 7h4M7 7v4M39 7h-4M39 7v4M7 24h4M7 24v-4M39 24h-4M39 24v-4" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
)
const WF_MODE_ZEN = (
  <svg width="46" height="31" viewBox="0 0 46 31" fill="none" stroke="currentColor" aria-hidden>
    <rect x="1" y="1" width="44" height="29" rx="3.4" strokeWidth="1.3" opacity="0.55" />
    <rect x="15" y="8" width="16" height="15" rx="2" fill="currentColor" stroke="none" opacity="0.22" />
    <path d="M18.5 13h9M18.5 17h6" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
  </svg>
)

function LayoutOpt({ selected, onClick, label, children }: {
  selected: boolean; onClick: () => void; label: string; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={`flex flex-col items-center gap-[5px] rounded-lg border px-1 pb-1.5 pt-1.5 text-[10.5px] leading-none tracking-[0.2px] transition-colors duration-100 ${
        selected
          ? 'border-[var(--accent)]/45 bg-[var(--accent)]/10 text-[var(--accent)]'
          : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}
