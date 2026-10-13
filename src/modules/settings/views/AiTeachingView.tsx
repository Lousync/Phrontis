import { useState, useEffect } from 'react'
import { FolderTree, Trash2, ScanText } from 'lucide-react'
import { useSettings } from '../../../lib/SettingsContext'
import { llmVisionModels } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'

/**
 * 设置 → AI 工具 → 教学（2026-10-13 从「模块设置」迁入）。
 *
 * 迁入理由：这三项本来就是 AI 设置（会话产物目录、删除联动、转写模型），
 * 留在「模块设置」里造成"AI 设置分散在两处"，找模型配置的人不会往模块设置翻。
 * 同时补 anchor —— 此前 aiTeachRootDir / aiTeachDeleteSessionFolder 是 ui:true 却无 anchor，
 * 被 schemaKeyItems() 静默排除在设置搜索之外（搜不到等于不存在）。
 *
 * 视觉转写模型（决策 D）：此前只存在 localStorage 的 `aiTeach.visionModel`，是隐藏设置 ——
 * 搜不到、不随设置迁移（换电脑就丢）。现在提为正式设置键 aiTeachVisionModel 作单一真源，
 * AI 教学素材库里的选择器读写同一个键。
 */
export function AiTeachingView() {
  const { s, update } = useSettings()
  const [rootDir, setRootDir] = useState(s.aiTeachRootDir || 'AI教学')
  const [visionOptions, setVisionOptions] = useState<Array<{ spec: string; providerName: string; model: string }>>([])

  useEffect(() => { setRootDir(s.aiTeachRootDir || 'AI教学') }, [s.aiTeachRootDir])

  // 仅列出疑似支持图片输入的模型（主进程按 VISION_MODEL_RE 过滤）
  useEffect(() => {
    let alive = true
    void llmVisionModels()
      .then(r => { if (alive) setVisionOptions(r.models ?? []) })
      .catch(() => { if (alive) setVisionOptions([]) })
    return () => { alive = false }
  }, [])

  const commitRootDir = () => {
    const v = rootDir.trim()
    if (!v || v === s.aiTeachRootDir) { setRootDir(s.aiTeachRootDir); return }
    // 合法性（单段目录名）由主进程最终校验；这里先行拦截明显非法输入并回退显示
    if (/[\\/:*?"<>|]/.test(v) || v === '.' || v === '..') { setRootDir(s.aiTeachRootDir); return }
    update('aiTeachRootDir', v)
  }

  const visionModel = typeof s.aiTeachVisionModel === 'string' ? s.aiTeachVisionModel : ''

  return (
    <div>
      <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">AI教学</h2>
      <p className="text-[12px] text-[var(--text-muted)] mb-4">
        每个对话在仓库里拥有一个专属文件夹，AI 生成的讲义与产物都落在其中。
      </p>

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
            位于当前仓库根下；改名会把已有的「{s.aiTeachRootDir}」文件夹一并重命名迁移（目标占用或权限失败时保留原文件夹并提示）。
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
            对话消息记录始终随会话删除；此设置只管理仓库里的产物文件夹。删除为移入系统回收站，可还原。
          </p>
        </div>

        {/* 图片视觉转写模型（决策 D：转写是与对话分开的、可单独设置的模型） */}
        <div data-setting-anchor="aiTeach.visionModel">
          <label className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <span className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
              <ScanText size={14} className="text-[var(--text-muted)]" />
              图片视觉转写模型
            </span>
            <select
              value={visionModel}
              onChange={e => {
                void update('aiTeachVisionModel', e.target.value)
                showToast({ type: 'info', message: e.target.value ? '已指定视觉转写模型' : '已改为自动挑选视觉模型' })
              }}
              className="w-48 px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] truncate"
            >
              <option value="">自动挑选（任一支持图片的模型）</option>
              {visionOptions.map(o => <option key={o.spec} value={o.spec}>{o.providerName} / {o.model}</option>)}
            </select>
          </label>
          <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1 mt-1.5">
            {visionOptions.length > 0
              ? '仅列出疑似支持图片输入的模型（按模型名判断，真不支持由接口报错兜底）。转写量大且只需认得清字，用便宜的小模型更划算。'
              : '暂无可选模型：到「模型」页签添加一个支持图片的模型（如 qwen-vl / glm-4v / gpt-4o / kimi-latest），或点供应商卡片的「刷新模型」。留空则由系统自动挑选。'}
          </p>
        </div>

        <p className="text-[11px] text-[var(--text-disabled)] leading-relaxed px-1">
          输入区用量指示档位与模型上下文窗口为通用设置（AI 教学与 AI 对话共用），现位于「对话」页签。
        </p>
      </div>
    </div>
  )
}
