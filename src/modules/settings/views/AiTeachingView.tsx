import { useState, useEffect } from 'react'
import { FolderTree, Trash2, Gauge, Database } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'

/** 设置 → 模块设置 → AI教学：会话产物根目录与删除联动（总纲 §二，P1） */
export function AiTeachingView() {
  const { s, update } = useSettings()
  const [rootDir, setRootDir] = useState(s.aiTeachRootDir || 'AI教学')

  useEffect(() => { setRootDir(s.aiTeachRootDir || 'AI教学') }, [s.aiTeachRootDir])

  const commitRootDir = () => {
    const v = rootDir.trim()
    if (!v || v === s.aiTeachRootDir) { setRootDir(s.aiTeachRootDir); return }
    // 合法性（单段目录名）由主进程最终校验；这里先行拦截明显非法输入并回退显示
    if (/[\\/:*?"<>|]/.test(v) || v === '.' || v === '..') { setRootDir(s.aiTeachRootDir); return }
    update('aiTeachRootDir', v)
  }

  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">AI教学</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-4">
        每个对话在仓库里拥有一个专属文件夹，AI 生成的讲义与产物都落在其中。
      </p>

      <div className="space-y-3 max-w-md">
        <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
            <FolderTree size={14} className="text-[var(--text-muted)]" />
            产物根目录
          </span>
          <input
            value={rootDir}
            onChange={e => setRootDir(e.target.value)}
            onBlur={commitRootDir}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
            placeholder="AI教学"
            className="w-40 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1">
          位于当前仓库根下；改名会把已有的「{s.aiTeachRootDir}」文件夹一并重命名迁移（目标占用或权限失败时保留原文件夹并提示）。
        </p>

        <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
            <Trash2 size={14} className="text-[var(--text-muted)]" />
            删除会话时文件夹处理
          </span>
          <select
            value={s.aiTeachDeleteSessionFolder}
            onChange={e => update('aiTeachDeleteSessionFolder', e.target.value)}
            className="px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value="ask">每次询问</option>
            <option value="keep">保留文件夹</option>
            <option value="delete">一并删除（进回收站）</option>
          </select>
        </label>
        <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1">
          对话消息记录始终随会话删除；此设置只管理仓库里的产物文件夹。删除为移入系统回收站，可还原。
        </p>

        {/* UI 优化条目9：输入区用量指示三档 + 上下文窗口大小（圆环分母，0=退化纯数字） */}
        <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
            <Gauge size={14} className="text-[var(--text-muted)]" />
            输入区用量指示
          </span>
          <select
            value={s.ctxUsageDetail || 'compact'}
            onChange={e => update('ctxUsageDetail', e.target.value)}
            className="px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value="off">隐藏</option>
            <option value="compact">紧凑（上下文圆环）</option>
            <option value="detailed">详细（圆环+文字摘要）</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
            <Database size={14} className="text-[var(--text-muted)]" />
            模型上下文窗口（token）
          </span>
          <input
            type="number" min={0} step={1000}
            value={s.ctxWindow ?? 0}
            onChange={e => update('ctxWindow', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="w-40 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1">
          0=未设置，用量指示退化为纯数字；设置所选模型的上下文窗口（如 128000）后圆环按占用比例着色（&gt;85% 变红）。
        </p>
      </div>
    </div>
  )
}
