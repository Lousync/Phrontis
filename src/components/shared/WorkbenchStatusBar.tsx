import { useState, useEffect } from 'react'
import { FolderGit2, Timer, Keyboard } from 'lucide-react'
import { workspaceGetCurrent } from '../../lib/ipc'
import { usePomodoro } from '../../modules/toolbox/hooks/PomodoroContext'

/**
 * Workbench 布局（R1-W1）底部状态栏：仓库上下文 · 番茄钟常驻 · 快捷键提示。
 * 只读仓库信息来自主进程 workspaceGetCurrent（渲染层不接触绝对路径，仅显示名称）。
 */
export function WorkbenchStatusBar() {
  const [repo, setRepo] = useState<{ name: string } | null>(null)
  const pom = usePomodoro()

  useEffect(() => {
    let alive = true
    workspaceGetCurrent()
      .then((cur) => { if (alive) setRepo(cur ? { name: cur.name ?? '未命名仓库' } : null) })
      .catch(() => { if (alive) setRepo(null) })
    // 编辑器切换仓库后刷新仓库上下文
    const h = () => {
      workspaceGetCurrent()
        .then((cur) => { if (alive) setRepo(cur ? { name: cur.name ?? '未命名仓库' } : null) })
        .catch(() => {})
    }
    window.addEventListener('wb-repo-changed', h)
    return () => { alive = false; window.removeEventListener('wb-repo-changed', h) }
  }, [])

  const pomActive = pom.state.visible
  const pomLabel = pomActive
    ? `${pom.state.phase === 'work' ? '专注' : '休息'} ${pom.display}${pom.state.running ? '' : '（已暂停）'}`
    : ''

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-tertiary)_72%,transparent)] px-3 text-[11px] text-[var(--text-secondary)] select-none">
      {repo && (
        <span className="flex min-w-0 items-center gap-1.5" title="当前仓库">
          <FolderGit2 size={11} className="shrink-0 text-[var(--accent)]" />
          <span className="truncate">{repo.name}</span>
        </span>
      )}
      <span className="flex-1" />
      {pomActive && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('pomodoro:activate'))}
          title="打开番茄钟面板"
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Timer size={11} className={pom.state.running ? 'text-[var(--accent)]' : ''} />
          {pomLabel}
        </button>
      )}
      <span className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[var(--text-tertiary)]" title="快捷键">
        <Keyboard size={11} />
        Ctrl+B 折叠侧栏
      </span>
    </div>
  )
}
