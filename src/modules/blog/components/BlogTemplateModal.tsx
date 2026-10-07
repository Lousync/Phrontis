import { useState, useEffect } from 'react'
import { X, FileText, Trash2, Settings2 } from 'lucide-react'
import { PluginIcon } from '../../../components/shared/ModuleIcons'
import type { BlogTemplate } from '../../../types'
import { listBlogTemplates, deleteBlogTemplate } from '../../../lib/ipc'
import { getPluginBlogTemplates, type PluginBlogTemplate } from '../../../lib/pluginService'
import { navigateToSettingsSection } from '../../settings'
import { usePresence } from '../../../lib/usePresence'

interface Props {
  open: boolean
  onClose: () => void
  onApply: (contentMd: string, name: string) => void
}

/** 写博时的模板套用弹层：点选即插入到文末；管理入口跳转设置页；插件模板虚拟合并展示 */
export function BlogTemplateModal({ open, onClose, onApply }: Props) {
  const [templates, setTemplates] = useState<BlogTemplate[]>([])
  const [pluginTpls, setPluginTpls] = useState<PluginBlogTemplate[]>([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void listBlogTemplates().then(setTemplates).catch(console.error)
    void getPluginBlogTemplates().then(setPluginTpls).catch(() => setPluginTpls([]))
  }, [open])

  // 进出场动效（B 类）：遮罩带 backdrop-blur → 按 §五 约束不做遮罩淡入，只动面板
  const { mounted, closing } = usePresence(open, 180)
  if (!mounted) return null

  return (
    <div
      className="absolute inset-0 z-50 bg-black/55 backdrop-blur-[3px] flex items-center justify-center p-5"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={`${closing ? 'kb-modal-out' : 'kb-modal-in'} w-full max-w-md max-h-[80%] flex flex-col rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-[0_28px_90px_rgba(0,0,0,0.5)] overflow-hidden`}>
        <div className="px-5 h-[52px] shrink-0 flex items-center justify-between border-b border-[var(--border-color)]">
          <span className="text-[14px] font-semibold text-[var(--text-primary)]">套用博客模板</span>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
          {templates.length === 0 && pluginTpls.length === 0 ? (
            <div className="py-10 text-center text-[12px] text-[var(--text-muted)] leading-relaxed">
              还没有模板。
              <br />到「设置 → 博客」中创建，或把一篇写得满意的日记存为模板。
            </div>
          ) : (
            <>
              {templates.map(tpl => (
                <div key={tpl.id} className="group flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors">
                  <button
                    onClick={() => { onApply(tpl.contentMd, tpl.name); onClose() }}
                    className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
                    title="插入到文末"
                  >
                    <FileText size={15} className="text-[var(--accent)] shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-[13px] text-[var(--text-primary)] truncate">{tpl.name}</span>
                      <span className="block text-[10px] text-[var(--text-muted)] truncate">
                        {(tpl.contentMd || '').replace(/[#*`>\-\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '空模板'}
                      </span>
                    </span>
                  </button>
                  {confirmDeleteId === tpl.id ? (
                    <>
                      <button onClick={() => { void deleteBlogTemplate(tpl.id).then(() => { setConfirmDeleteId(null); return listBlogTemplates().then(setTemplates) }).catch(console.error) }} className="px-1.5 py-0.5 rounded text-[10px] text-white bg-[var(--danger)] shrink-0">确认删除</button>
                      <button onClick={() => setConfirmDeleteId(null)} className="px-1.5 py-0.5 rounded text-[10px] text-[var(--text-muted)] border border-[var(--border-color)] shrink-0">取消</button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(tpl.id)}
                      className="p-1 rounded opacity-0 group-hover:opacity-100 hover:text-[var(--danger)] text-[var(--text-muted)] transition-all shrink-0"
                      title="删除模板"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}

              {/* 插件贡献的模板(虚拟合并,不可删除) */}
              {pluginTpls.map(tpl => (
                <div key={tpl.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors">
                  <button
                    onClick={() => { onApply(tpl.contentMd, tpl.name); onClose() }}
                    className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
                    title="插入到文末"
                  >
                    <PluginIcon size={15} className="text-[var(--accent)] shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-[13px] text-[var(--text-primary)] truncate">
                        {tpl.name}
                        <span className="ml-1.5 text-[10px] text-[var(--accent)] align-middle">插件</span>
                      </span>
                      <span className="block text-[10px] text-[var(--text-muted)] truncate">
                        {(tpl.contentMd || '').replace(/[#*`>\-\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '空模板'}
                      </span>
                    </span>
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="shrink-0 px-4 py-2.5 border-t border-[var(--border-color)] flex items-center justify-between">
          <span className="text-[10px] text-[var(--text-disabled)]">点击模板将插入到当前博文末尾</span>
          <button
            onClick={() => { onClose(); navigateToSettingsSection('modules') }}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
          >
            <Settings2 size={12} />
            管理模板
          </button>
        </div>
      </div>
    </div>
  )
}

