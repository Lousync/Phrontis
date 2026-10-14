import { useState, useEffect } from 'react'
import { FolderTree, Trash2 } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { SectionHead } from './SectionHead'

/**
 * 设置 → AI → 教学（2026-10-13 从「模块设置」迁入）。
 *
 * 迁入理由：它们本来就是 AI 设置（会话产物目录、删除联动），
 * 留在「模块设置」里造成"AI 设置分散在两处"，找模型配置的人不会往模块设置翻。
 * 同时补 anchor —— 此前 aiTeachRootDir / aiTeachDeleteSessionFolder 是 ui:true 却无 anchor，
 * 被 schemaKeyItems() 静默排除在设置搜索之外（搜不到等于不存在）。
 *
 * 视觉转写模型（决策 D）：先前只存在 localStorage 的 `aiTeach.visionModel`，是隐藏设置 ——
 * 搜不到、不随设置迁移（换电脑就丢）。本会话先把它提为正式设置键 aiTeachVisionModel，
 * 随后按原型归位到「模型 → 哪个场景用哪个模型」表（它与另外四个模型槽位是同一类东西），
 * 所以本页不再放第二份控件，只留一句指路。
 */
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
      <SectionHead title="AI教学" className="mb-4"
        hint="每个对话在仓库中拥有独立的产物文件夹，AI 生成的讲义与产物均存放于此。" />

      <div className="space-y-3 max-w-md">
        <div data-setting-anchor="aiTeach.rootDir">
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
          <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1 mt-1.5">
            位于当前仓库根目录下；重命名会一并迁移已有文件夹，迁移失败时保留原目录并给出提示。
          </p>
        </div>

        <div data-setting-anchor="aiTeach.deleteSessionFolder">
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
          <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1 mt-1.5">
            仅管理仓库中的产物文件夹；删除操作移入系统回收站，可还原。
          </p>
        </div>

        {/* 图片视觉转写模型（决策 D）已按原型归位到「模型 → 哪个场景用哪个模型」表（2026-10-13）：
            它是那张表里的第五个槽位，与另外四个模型槽位摆在一起才看得懂。
            这里只留说明、不再放第二份控件 —— 两份控件写同一个键，迟早不同步。 */}      </div>
    </div>
  )
}
