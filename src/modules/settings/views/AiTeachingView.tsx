import { useState, useEffect, type ReactNode } from 'react'
import { FolderTree, Trash2 } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { HelpHint } from '../../../components/shared/HelpHint'
import { SectionHead } from './SectionHead'

/**
 * 设置 → AI → 教学（2026-10-13 从「模块设置」迁入；2026-10-14 改成「一行一物」）。
 *
 * 迁入理由：它们本来就是 AI 设置（会话产物目录、删除联动），
 * 留在「模块设置」里造成"AI 设置分散在两处"，找模型配置的人不会往模块设置翻。
 * 同时补 anchor —— 此前 aiTeachRootDir / aiTeachDeleteSessionFolder 是 ui:true 却无 anchor，
 * 被 schemaKeyItems() 静默排除在设置搜索之外（搜不到等于不存在）。
 *
 * 视觉转写模型（决策 D）：先前只存在 localStorage 的 `aiTeach.visionModel`，是隐藏设置 ——
 * 搜不到、不随设置迁移（换电脑就丢）。本会话先把它提为正式设置键 aiTeachVisionModel，
 * 随后按原型归位到「模型 → 哪个场景用哪个模型」表（它与另外四个模型槽位是同一类东西），
 * 所以本页不再放第二份控件 —— 只在页尾**真正渲染**一行指路（见下方那段 JSX；那行字以前只存在于注释里）。
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

      {/* 两行一张卡：行 = 「图标 + 标签 + ⓘ + 右侧控件」。改造前每行下面各挂一段 11px 常显说明 */}
      <div className="max-w-md rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5">
        <div data-setting-anchor="aiTeach.rootDir" className="border-t border-[var(--border-color)] first:border-t-0">
          <TRow icon={<FolderTree size={14} />} label="产物根目录"
            hint="位于当前仓库根目录下；重命名会一并迁移已有文件夹，迁移失败时保留原目录并给出提示。">
            <input
              value={rootDir}
              onChange={e => setRootDir(e.target.value)}
              onBlur={commitRootDir}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
              placeholder="AI教学"
              className="w-40 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </TRow>
        </div>

        <div data-setting-anchor="aiTeach.deleteSessionFolder" className="border-t border-[var(--border-color)]">
          <TRow icon={<Trash2 size={14} />} label="删除会话时文件夹处理"
            hint="仅管理仓库中的产物文件夹；删除操作移入系统回收站，可还原。">
            <select
              value={s.aiTeachDeleteSessionFolder}
              onChange={e => update('aiTeachDeleteSessionFolder', e.target.value)}
              className="px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            >
              <option value="ask">每次询问</option>
              <option value="keep">保留文件夹</option>
              <option value="delete">一并删除（进回收站）</option>
            </select>
          </TRow>
        </div>
      </div>

      {/* ★ 缺陷修复（2026-10-14）：这里原先是一位注释，声称本页会留一句指路，
          可注释不渲染 —— 界面里从来没有这句话，而"视觉转写模型为什么不在这页"的理由
          也只有读过源码的人知道。现在把它真正渲染成一行**指路**。
          刻意常显：指路句收进 ⓘ 就等于没指（用户不会去悬停一个他不知道自己该找什么的提示）。 */}
      <p className="mt-3 max-w-md text-[11.5px] leading-relaxed text-[var(--text-muted)]">
        图片视觉转写模型不在本页 —— 它是「模型」页「场景分配」里的一个槽位，和另外几个模型放在一起才看得懂。
      </p>
    </div>
  )
}

/** 教学页的一行：图标 + 标签 + ⓘ + 右侧控件（不用 `<label>` 包：ⓘ 是按钮，套在 label 里点它会连带聚焦控件） */
function TRow({ icon, label, hint, children }: {
  icon: ReactNode
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="flex items-center gap-2 min-w-0 text-[13px] text-[var(--text-primary)]">
        <span className="shrink-0 text-[var(--text-muted)]">{icon}</span>
        <span className="truncate">{label}</span>
        {hint ? <HelpHint text={hint} /> : null}
      </span>
      <span className="ml-auto shrink-0">{children}</span>
    </div>
  )
}
