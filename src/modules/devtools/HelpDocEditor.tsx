/**
 * 帮助文档编辑器 — 开发者工具的第一个子工具。
 *
 * 直接读写 src/modules/help/docs/*.md(经主进程 devtools IPC,仅 DEV):
 * 保存后 Vite glob 感知新文件,帮助模块无需重启即可看到。
 * 文档 id = 文件名(去 .md),Toast 的 detail 字段用它跳转,因此重命名有破坏性。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'
import { ResizablePanel } from '../../components/shared/ResizablePanel'
import { ConfirmDialog } from '../../components/shared'
import { PANEL_CONSTRAINTS } from '../../lib/settings'
import { showToast } from '../../lib/toast'
import type { DevtoolsHelpDocMeta } from '../../types'

interface Draft {
  fileName: string               // 含 .md
  originalFileName: string | null // null = 新建
  title: string
  category: string
  icon: string
  body: string
}

const COMMON_ICONS = [
  'FileText', 'Keyboard', 'BookOpen', 'Tag', 'Calendar', 'Smile', 'Wrench', 'Info',
  'AlertTriangle', 'Star', 'Heart', 'Clock', 'ListTodo', 'Brain', 'Globe', 'Image',
  'PenLine', 'Search', 'Shield', 'Sparkles', 'Terminal', 'Zap',
]

function isKnownIcon(name: string): boolean {
  return Boolean((LucideIcons as unknown as Record<string, unknown>)[name])
}

function IconPreview({ name, size = 16 }: { name: string; size?: number }) {
  const C = (LucideIcons as unknown as Record<string, React.ComponentType<{ size?: number }>>)[name]
  return C ? <C size={size} /> : null
}

export function HelpDocEditor() {
  const devtools = window.devtoolsApi
  const DOCS_CONSTRAINTS = PANEL_CONSTRAINTS.sidebarWidth_devtoolsDocs
  const [docs, setDocs] = useState<DevtoolsHelpDocMeta[]>([])
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [fileNameTouched, setFileNameTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  // 第二侧边栏(文档列表)收放:拖拽吸附收起,贴边条点击/拖出展开
  const [docsBarOpen, setDocsBarOpen] = useState(true)
  // 确认对话框(应用内 ConfirmDialog — Electron 原生 confirm 会破坏键盘焦点,禁止使用)
  const [confirmSave, setConfirmSave] = useState<{ kind: 'rename' | 'overwrite' } | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  const loadList = useCallback(async () => {
    if (!devtools) return
    const res = await devtools.helpDocsList()
    setDocs(res.docs)
    setDirty(new Set(res.dirty))
  }, [devtools])

  useEffect(() => { loadList() }, [loadList])

  const categories = useMemo(() => [...new Set(docs.map(d => d.category))].sort(), [docs])

  const openDoc = async (fileName: string) => {
    if (!devtools) return
    const res = await devtools.helpDocsRead(fileName)
    if (res.error) { showToast({ type: 'error', message: res.error }); return }
    setDraft({
      fileName: res.fileName, originalFileName: res.fileName,
      title: res.title, category: res.category, icon: res.icon, body: res.body,
    })
    setFileNameTouched(true)
  }

  const newDoc = () => {
    setDraft({ fileName: '', originalFileName: null, title: '', category: '操作指南', icon: 'FileText', body: '' })
    setFileNameTouched(false)
  }

  // 新建时文件名跟随标题(中文文件名),手动编辑过则不再跟随
  const draftTitle = draft?.title ?? ''
  useEffect(() => {
    if (!fileNameTouched) {
      setDraft(d => (d && d.originalFileName === null ? { ...d, fileName: d.title.replace(/[\\/:*?"<>|\s]+/g, '') } : d))
    }
  }, [draftTitle, fileNameTouched])

  if (!devtools) return null

  const update = (patch: Partial<Draft>) => setDraft(d => (d ? { ...d, ...patch } : d))

  const save = async () => {
    if (!draft || saving) return
    const title = draft.title.trim()
    const category = draft.category.trim()
    const icon = draft.icon.trim() || 'FileText'
    const fileName = draft.fileName.trim()
    if (!title || !category) { showToast({ type: 'warning', message: '标题与分类不能为空' }); return }
    if (!fileName) { showToast({ type: 'warning', message: '文件名不能为空(仅允许中英文、数字、连字符、下划线)' }); return }
    if (!isKnownIcon(icon)) {
      showToast({ type: 'warning', message: '图标无效，已回退 FileText' })
      return
    }

    const renamed = draft.originalFileName !== null && fileName !== draft.originalFileName
    if (renamed) { setConfirmSave({ kind: 'rename' }); return }
    if (docs.some(d => d.fileName === fileName && d.fileName !== draft.originalFileName)) {
      setConfirmSave({ kind: 'overwrite' })
      return
    }
    void doSave(false)
  }

  const doSave = async (applyRename: boolean) => {
    if (!draft) return
    const title = draft.title.trim()
    const category = draft.category.trim()
    const icon = draft.icon.trim() || 'FileText'
    const fileName = draft.fileName.trim()
    setConfirmSave(null)
    setSaving(true)
    const res = await devtools.helpDocsWrite({ fileName, title, category, icon, body: draft.body })
    if (res.error) {
      setSaving(false)
      showToast({ type: 'error', message: res.error })
      return
    }
    if (applyRename && draft.originalFileName && draft.originalFileName !== fileName) {
      await devtools.helpDocsDelete(draft.originalFileName)
    }
    const finalName = res.fileName ?? fileName
    setDraft(d => (d ? { ...d, fileName: finalName, originalFileName: finalName } : d))
    setSaving(false)
    showToast({ type: 'info', message: `文档「${title}」已保存,帮助模块可即时查看`, detail: finalName.replace(/\.md$/, '') })
    await loadList()
  }

  const remove = async () => {
    if (!draft?.originalFileName) return
    try {
      const res = await devtools.helpDocsDelete(draft.originalFileName)
      if (res.error) { showToast({ type: 'error', message: res.error }); return }
      showToast({ type: 'info', message: `文档「${draft.title}」已删除` })
      setDraft(null)
      setConfirmDeleteOpen(false)
      await loadList()
    } catch (e) {
      showToast({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, DevtoolsHelpDocMeta[]>()
    for (const d of docs) {
      if (!map.has(d.category)) map.set(d.category, [])
      map.get(d.category)!.push(d)
    }
    return map
  }, [docs])

  return (
    <div className="flex h-full">
      {/* 左侧:文档列表(可收放伸缩) */}
      <ResizablePanel
        storageKey="sidebarWidth_devtoolsDocs"
        defaultWidth={DOCS_CONSTRAINTS.default}
        minWidth={DOCS_CONSTRAINTS.min}
        maxWidth={DOCS_CONSTRAINTS.max}
        visible={docsBarOpen}
        onSnapClose={() => setDocsBarOpen(false)}
        onSnapOpen={() => setDocsBarOpen(true)}
      >
        <div className="w-full h-full bg-[var(--bg-secondary)] py-4 flex flex-col overflow-y-auto">
          <div className="px-3 mb-3">
            <button
              onClick={newDoc}
              className="w-full flex items-center justify-center gap-1.5 px-1.5 py-1 text-[11.5px] rounded-md bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
            >
              <Plus size={13} />
              新建文档
            </button>
          </div>
        {[...grouped.entries()].map(([cat, catDocs]) => (
          <div key={cat} className="mb-3">
            <div className="text-[10px] font-semibold text-[var(--text-disabled)] uppercase tracking-wide px-4 mb-1">{cat}</div>
            {catDocs.map(d => {
              const active = draft !== null && (draft.originalFileName === d.fileName || draft.fileName === d.fileName)
              return (
                <button
                  key={d.fileName}
                  onClick={() => openDoc(d.fileName)}
                  className={`w-full flex items-center gap-2 px-4 py-1.5 text-[13px] transition-colors ${
                    active
                      ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] border-l-2 border-l-[var(--accent)] pl-[14px]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] border-l-2 border-l-transparent pl-[14px]'
                  }`}
                  data-tip={d.fileName} aria-label={d.fileName}
                >
                  <span className={active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>
                    <IconPreview name={d.icon} size={14} />
                  </span>
                  <span className="truncate flex-1 text-left">{d.title}</span>
                  {dirty.has(d.fileName) && (
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] shrink-0" data-tip="有未提交的 git 改动" aria-label="有未提交的 git 改动" />
                  )}
                </button>
              )
            })}
          </div>
          ))}
        </div>
      </ResizablePanel>

      {/* 右侧:编辑区 */}
      {draft === null ? (
        <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">
          选择或新建文档
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0">
          {/* 元信息 */}
          <div className="shrink-0 px-3 py-2 border-b border-[var(--border-color)] grid grid-cols-[1fr_1fr_1fr] gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--text-muted)]">标题</span>
              <input
                value={draft.title}
                onChange={e => update({ title: e.target.value })}
                placeholder="功能名称"
                className="px-2.5 py-1.5 text-[13px] bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--text-muted)]">分类</span>
              <input
                value={draft.category}
                onChange={e => update({ category: e.target.value })}
                list="devtools-category-list"
                placeholder="相同分类自动归组"
                className="px-2.5 py-1.5 text-[13px] bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <datalist id="devtools-category-list">
                {categories.map(c => <option key={c} value={c} />)}
              </datalist>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--text-muted)]">图标(lucide)</span>
              <div className="flex items-center gap-1">
                <span className="w-6 h-6 shrink-0 flex items-center justify-center text-[var(--text-secondary)] border border-[var(--border-color)] rounded">
                  <IconPreview name={draft.icon} />
                </span>
                <input
                  value={draft.icon}
                  onChange={e => update({ icon: e.target.value })}
                  placeholder="FileText"
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-[13px] bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>
              <span className="flex flex-wrap gap-1">
                {COMMON_ICONS.map(name => (
                  <button
                    key={name}
                    onClick={() => update({ icon: name })}
                    data-tip={name} aria-label={name}
                    className={`w-6 h-6 flex items-center justify-center rounded border transition-colors ${
                      draft.icon === name
                        ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--bg-hover)]'
                        : 'border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <IconPreview name={name} size={13} />
                  </button>
                ))}
              </span>
            </label>
          </div>

          {/* 文件名 + 操作 */}
          <div className="shrink-0 px-3 py-1.5 border-b border-[var(--border-color)] flex items-center gap-3">
            <label className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-[11px] text-[var(--text-muted)] shrink-0">文件名</span>
              <input
                value={draft.fileName}
                onChange={e => { setFileNameTouched(true); update({ fileName: e.target.value }) }}
                placeholder="与标题一致;即文档 id"
                className="flex-1 min-w-0 px-2.5 py-1.5 text-[12px] font-mono bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            {draft.originalFileName && dirty.has(draft.originalFileName) && (
              <span className="text-[11px] text-[var(--warning)] shrink-0">git 有未提交改动</span>
            )}
            {draft.originalFileName && (
              <button
                onClick={() => setConfirmDeleteOpen(true)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-danger)] hover:bg-[var(--bg-hover)] transition-colors shrink-0"
              >
                <Trash2 size={13} />
                删除
              </button>
            )}
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 shrink-0"
            >
              <Save size={13} />
              {saving ? '保存中…' : '保存'}
            </button>
          </div>

          {/* 正文:编辑 + 实时预览 */}
          <div className="flex-1 min-h-0 flex">
            <textarea
              value={draft.body}
              onChange={e => update({ body: e.target.value })}
              placeholder="正文 Markdown(标准语法:标题/表格/代码块/列表)"
              className="flex-1 min-w-0 resize-none px-5 py-4 text-[13px] font-mono leading-relaxed bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none border-r border-[var(--border-color)]"
            />
            <div className="flex-1 min-w-0 overflow-y-auto py-4">
              <div className="max-w-2xl mx-auto px-8">
                <MarkdownPreview content={draft.body} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 保存覆盖/重命名确认 */}
      <ConfirmDialog
        open={confirmSave !== null}
        title={confirmSave?.kind === 'rename' ? '文件名已修改' : '覆盖同名文档'}
        variant="default"
        confirmLabel="继续保存"
        showCheckbox={false}
        message={
          confirmSave?.kind === 'rename'
            ? `文件名将改为「${draft?.fileName ?? ''}」，旧文件会被删除。`
            : `已存在同名文档「${draft?.fileName ?? ''}」，保存将覆盖它。`
        }
        onConfirm={() => void doSave(confirmSave?.kind === 'rename')}
        onCancel={() => setConfirmSave(null)}
      />

      {/* 删除文档确认 */}
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="删除文档"
        message={`删除「${draft?.title ?? ''}」？未提交的改动将丢失。`}
        confirmLabel="删除"
        showCheckbox={false}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  )
}
