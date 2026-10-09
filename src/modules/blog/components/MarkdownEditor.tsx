import { useState, useEffect, useCallback, useRef } from 'react'
import { getEntryById, updateEntry, getTags, createTag, deleteEntry, getSetting, setSetting, openExternal } from '../../../lib/ipc'
import { ArrowLeft, Eye, Code, Plus, X, Trash2, ListTree, ImagePlus, LayoutTemplate } from 'lucide-react'
import { MarkdownPreview } from '../../../components/shared/MarkdownPreview'
import { BlogTemplateModal } from './BlogTemplateModal'
import { showToast } from '../../../lib/toast'
import { uploadImageFile, imageMarkdown, isImageFile, IMAGE_OWNER } from '../../../lib/editorImage'
import { useSettings } from '../../../lib/SettingsContext'
import { getGlobalActiveTab } from '../../../lib/activeTab'
import { ConfirmDialog } from '../../../components/shared'
import { SummaryPanel } from './SummaryPanel'
// 共享 Monaco 宿主（含「弃用受控 value + 最小 diff 保光标」修复，2026-09-20）：
// 博文编辑器原先直接用受控 <Editor value>，中文输入时光标跳文末 / 乱字，此处改为 MonacoPane。
import { MonacoPane, type MonacoPaneHandle } from '../../../components/shared/MonacoPane'
import type { Tag } from '../../../types'

interface Props {
  entryId: string; showLineNumbers: boolean; zoom?: number; onSave: () => void; onCancel: () => void
  onContentChange?: (content: string) => void
  onToggleOutline?: () => void
}

const MOOD_OPTIONS = [
  { emoji: '😄', label: '开心' },
  { emoji: '😫', label: '疲倦' },
  { emoji: '😢', label: '难过' },
  { emoji: '😕', label: '困惑' },
]
const MAX_TAGS = 5

/** 模块级稳定引用：内联箭头每次渲染都是新函数，会让 MarkdownPreview 的 memo 失效、预览反复重解析 */
const handlePreviewLinkClick = (href: string) => openExternal(href)

export function MarkdownEditor({ entryId, showLineNumbers, zoom = 1, onSave, onCancel, onContentChange, onToggleOutline }: Props) {
  const { s } = useSettings()
  const [contentMd, setContentMd] = useState('')
  const [date, setDate] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showTplModal, setShowTplModal] = useState(false)
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState(false)
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false)
  const [unsavedAction, setUnsavedAction] = useState<(() => void) | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const paneRef = useRef<MonacoPaneHandle | null>(null)
  const entryIdRef = useRef(entryId)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const contentRef = useRef(contentMd)
  const dateRef = useRef(date)
  const isDirtyRef = useRef(false)
  const savedContentRef = useRef('')
  const lastSaveErrorRef = useRef('')
  const skipDirtyRef = useRef(true) // skip first onChange (Monaco mount)

  // Tags & States
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [entryTags, setEntryTags] = useState<Tag[]>([])
  const [entryStates, setEntryStates] = useState<string>('')
  const [newTagName, setNewTagName] = useState('')
  const [showTagInput, setShowTagInput] = useState(false)

  const tagsRef = useRef<Tag[]>([])
  const statesRef = useRef('')

  useEffect(() => { contentRef.current = contentMd }, [contentMd])
  useEffect(() => { entryIdRef.current = entryId }, [entryId])
  useEffect(() => { dateRef.current = date }, [date])
  useEffect(() => { tagsRef.current = entryTags }, [entryTags])
  useEffect(() => { statesRef.current = entryStates }, [entryStates])

  useEffect(() => {
    Promise.all([
      getEntryById(entryId).then(d => {
        if (!d) return
        setContentMd(d.contentMd); setDate(d.date)
        savedContentRef.current = d.contentMd || ''
        isDirtyRef.current = false
        skipDirtyRef.current = true // skip dirty check until Monaco finishes mounting
        setTimeout(() => { skipDirtyRef.current = false }, 500) // auto-clear after mount window
        setEntryTags(d.tags || [])
        setEntryStates(d.states || '')
        onContentChange?.(d.contentMd)  // seed outline with existing content
        setLoaded(true)
      }),
      getTags().then(setAllTags)
    ])
  }, [entryId])

  // Load skip-delete setting
  useEffect(() => {
    getSetting('skipDeleteConfirm_blog').then(v => { if (v === true) setSkipDeleteConfirm(true) })
  }, [])

  // ===== Inline image insertion (paste / drag / toolbar) =====
  /** 上传单张图 → 返回可插入的 md（MonacoPane 在光标/落点处插入） */
  const handleImageToMarkdown = useCallback(async (f: File): Promise<string | null> => {
    if (!isImageFile(f)) return null
    try {
      const meta = await uploadImageFile(f, IMAGE_OWNER.blog, entryIdRef.current)
      return imageMarkdown(meta)
    } catch {
      showToast({ type: 'error', message: `图片「${f.name}」插入失败` })
      return null
    }
  }, [])

  /** 工具栏「图片」按钮：上传后在光标处插入 */
  const insertImageFiles = useCallback(async (files: File[]) => {
    for (const f of files) {
      const md = await handleImageToMarkdown(f)
      if (md) paneRef.current?.insertAtCursor(md)
    }
  }, [handleImageToMarkdown])

  const checkUnsaved = useCallback(() => {
    if (isDirtyRef.current) {
      setShowUnsavedConfirm(true)
      return true
    }
    return false
  }, [])

  const handleCancelWithCheck = useCallback(() => {
    if (checkUnsaved()) { setUnsavedAction(() => onCancel); return }
    onCancel()
  }, [checkUnsaved, onCancel])

  const handleDeleteEntry = () => {
    if (skipDeleteConfirm) {
      deleteEntry(entryId).then(onSave).catch(console.error)
    } else {
      setShowDeleteConfirm(true)
    }
  }

  const doSave = useCallback(async (c: string, d: string) => {
    setSaving(true)
    try {
      const tagIds = tagsRef.current.map(t => t.id)
      await updateEntry(entryId, {
        contentMd: c,
        contentHtml: '',
        date: d,
        tags: tagIds,
        states: statesRef.current,
      })
      isDirtyRef.current = false
      savedContentRef.current = c
      setLastSaved(new Date())
      lastSaveErrorRef.current = ''
    } catch (e) {
      // 保存失败要可见(如日期撞车的防重拒绝),同一错误只提示一次,避免自动保存每 2 秒刷屏
      const msg = e instanceof Error ? e.message : String(e)
      if (msg !== lastSaveErrorRef.current) showToast({ type: 'error', message: msg })
      lastSaveErrorRef.current = msg
    } finally { setSaving(false) }
  }, [entryId])

  const handleChange = (v: string | undefined) => {
    const val = v || ''
    setContentMd(val)
    onContentChange?.(val)
    // Within mount window: skip dirty check (Monaco may fire onChange with initial value)
    // Auto-save still runs — if Monaco normalized line endings, it gets persisted
    if (!skipDirtyRef.current && val !== savedContentRef.current) {
      isDirtyRef.current = true
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => doSave(val, dateRef.current), s.autoSaveDebounceMs)
  }

  const handleSaveAndClose = async () => {
    if (timer.current) clearTimeout(timer.current)
    await doSave(contentRef.current, dateRef.current)
    onSave()
  }

  const handleAddTag = async () => {
    const name = newTagName.trim()
    if (!name) { setShowTagInput(false); return }
    if (entryTags.length >= MAX_TAGS) { setShowTagInput(false); setNewTagName(''); return }
    // Existing tag?
    let tag = allTags.find(t => t.name === name)
    if (!tag) {
      tag = await createTag(name)
      setAllTags(prev => [...prev, tag!])
    }
    if (!entryTags.find(t => t.id === tag!.id)) {
      setEntryTags(prev => [...prev, tag!])
    }
    setNewTagName('')
    setShowTagInput(false)
  }

  const handleRemoveTag = (tagId: string) => {
    setEntryTags(prev => prev.filter(t => t.id !== tagId))
  }

  const handleToggleState = (emoji: string) => {
    const states = entryStates.split(',').filter(Boolean)
    const idx = states.indexOf(emoji)
    if (idx >= 0) {
      states.splice(idx, 1)
    } else {
      states.push(emoji)
    }
    setEntryStates(states.join(','))
  }

  // Ctrl+/ toggle preview, Ctrl+S save, Escape back
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (getGlobalActiveTab() !== 'blog') return
      if (e.ctrlKey && e.key === '/') { e.preventDefault(); setShowPreview(v => !v) }
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); handleSaveAndClose() }
      if (e.key === 'Escape') { e.preventDefault(); if (checkUnsaved()) { setUnsavedAction(() => onCancel); return } onCancel() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Outline navigation — scroll editor or preview DOM to target heading
  useEffect(() => {
    const handler = (e: Event) => {
      const { line, id } = (e as CustomEvent).detail as { line: number; id: string }
      if (showPreview) {
        // Preview mode: scroll DOM element
        const el = document.getElementById(id)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else {
        // Editing mode: use Monaco editor API
        paneRef.current?.revealLine(line)
      }
    }
    window.addEventListener('outline:go-to-heading', handler)
    return () => window.removeEventListener('outline:go-to-heading', handler)
  }, [showPreview])

  if (!loaded) {
    return <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] bg-[var(--bg-primary)]">加载中...</div>
  }

  const activeStates = entryStates.split(',').filter(Boolean)

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[var(--bg-primary)]">
      {/* toolbar */}
      <div className="flex items-center justify-between gap-0.5 px-2 py-1 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0">
        <div className="flex items-center gap-1">
          <button onClick={handleCancelWithCheck} className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
            <ArrowLeft size={13} /> 返回
          </button>
          <div className="w-px h-4 bg-[var(--input-bg)]" />
          <span className="text-[12px] text-[var(--text-primary)] font-medium">{date}</span>

          {/* Mood states */}
          <div className="w-px h-4 bg-[var(--input-bg)]" />
          <div className="flex items-center gap-0.5">
            {MOOD_OPTIONS.map(m => (
              <button
                key={m.emoji}
                onClick={() => handleToggleState(m.emoji)}
                title={m.label}
                className={`text-[15px] px-0.5 rounded transition-opacity ${activeStates.includes(m.emoji) ? 'opacity-100' : 'opacity-30 hover:opacity-60'}`}
              >
                {m.emoji}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-0.5">
          <span className="text-[11px] text-[var(--text-muted)] min-w-[60px] text-right">
            {saving ? '保存中...' : lastSaved ? '已保存 ' + fmtTime(lastSaved) : ''}
          </span>
          {!showPreview && (
            <>
              <button
                onClick={() => imageInputRef.current?.click()}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                title="插入图片"
              >
                <ImagePlus size={13} />
                图片
              </button>
              <button
                onClick={() => setShowTplModal(true)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                title="套用博客模板"
              >
                <LayoutTemplate size={13} />
                模板
              </button>
            </>
          )}
          <button onClick={() => setShowPreview(!showPreview)}
            className={'flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] transition-colors ' + (showPreview ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}
            title="Ctrl+/">
            {showPreview ? <Code size={13} /> : <Eye size={13} />}
            {showPreview ? '源码' : '预览'}
          </button>
          {onToggleOutline && (
            <button onClick={onToggleOutline}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              title="大纲 (Ctrl+O)">
              <ListTree size={13} />
              大纲
            </button>
          )}
          <button onClick={handleSaveAndClose}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors">
            完成
          </button>
          <button onClick={handleDeleteEntry}
            className="p-1 rounded-md text-[var(--text-secondary)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
            title="删除">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Tag bar */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-[var(--border-color)] bg-[var(--bg-primary)] shrink-0 overflow-x-auto">
        {entryTags.map(t => (
          <span key={t.id}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] shrink-0"
            style={{ backgroundColor: t.color + '20', color: t.color, border: `1px solid ${t.color}40` }}
          >
            {t.name}
            <button onClick={() => handleRemoveTag(t.id)}
              className="hover:text-[var(--danger)] transition-colors"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        {entryTags.length < MAX_TAGS && (
          showTagInput ? (
            <input
              autoFocus
              value={newTagName}
              onChange={e => setNewTagName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') { setShowTagInput(false); setNewTagName('') } }}
              onBlur={handleAddTag}
              placeholder="标签名..."
              className="w-20 px-1.5 py-0.5 bg-[var(--input-bg)] border border-[var(--accent)] rounded text-[11px] text-[var(--text-primary)] outline-none"
            />
          ) : (
            <button onClick={() => setShowTagInput(true)}
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded border border-dashed border-[var(--border-color)] transition-colors"
            >
              <Plus size={10} />标签
            </button>
          )
        )}
        {entryTags.length > 0 && (
          <span className="text-[10px] text-[var(--text-disabled)] ml-1">{entryTags.length}/{MAX_TAGS}</span>
        )}
      </div>

      {/* content */}
      <div className="flex-1 min-h-0 overflow-hidden bg-[var(--bg-primary)]">
        {showPreview ? (
          <div className="h-full overflow-y-auto">
            <div className="max-w-3xl mx-auto px-10 py-6">
              <MarkdownPreview content={contentMd} onLinkClick={handlePreviewLinkClick} />
              {date && <SummaryPanel date={date} />}
            </div>
          </div>
        ) : (
          <MonacoPane
            ref={paneRef}
            doc={{
              relPath: `blog/${entryId}.md`,
              modelPath: `kb://blog/${entryId}`,
              content: contentMd,
              language: 'markdown',
              binary: false,
              editable: true,
              truncated: false,
              size: contentMd.length,
            }}
            onChange={(_rel, v) => handleChange(v)}
            fontSize={Math.round(s.editorFontSize * zoom)}
            dimEnabled={false}
            inlineSuggestEnabled={false}
            inlineSuggestAuto={false}
            layoutKey={zoom}
            onPasteImage={handleImageToMarkdown}
            onDropImage={handleImageToMarkdown}
            editorOptions={{
              fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
              lineNumbers: showLineNumbers ? 'on' : 'off',
              wordWrap: 'on',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              renderWhitespace: 'selection',
              renderLineHighlight: 'line',
              folding: true,
              lineDecorationsWidth: 0,
              lineNumbersMinChars: 3,
              guides: { indentation: true },
              insertSpaces: true,
              selectionHighlight: true,
              occurrencesHighlight: 'off',
              bracketPairColorization: { enabled: true },
              matchBrackets: 'always',
              unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false, invisibleCharacters: false },
              placeholder: '开始写作...',
              padding: { top: 16, bottom: 16 },
            }}
          />
        )}
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml,image/heic,image/heif"
        multiple
        className="hidden"
        onChange={e => {
          const files = Array.from(e.target.files || [])
          if (files.length > 0) void insertImageFiles(files)
          e.target.value = ''
        }}
      />

      {/* 模板套用弹层：空文档直接套用，否则插入到文末 */}
      <BlogTemplateModal
        open={showTplModal}
        onClose={() => setShowTplModal(false)}
        onApply={(tplContent, tplName) => {
          const cur = contentRef.current
          const next = cur.trim().length === 0
            ? tplContent
            : cur.replace(/\s*$/, '') + '\n\n' + tplContent
          handleChange(next)
          showToast({ type: 'info', message: `模板「${tplName}」已应用` })
        }}
      />

      {/* Unsaved changes confirm dialog */}
      <ConfirmDialog
        open={showUnsavedConfirm}
        title="未保存的更改"
        message="当前博文有未保存的更改，确定要离开吗？"
        confirmLabel="离开"
        onConfirm={() => {
          setShowUnsavedConfirm(false)
          if (unsavedAction) { const a = unsavedAction; setUnsavedAction(null); a() }
        }}
        onCancel={() => { setShowUnsavedConfirm(false); setUnsavedAction(null) }}
      />

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title="确认删除"
        message="删除这篇博文？可在回收站恢复。"
        confirmLabel="删除"
        onConfirm={(skipNext) => {
          if (skipNext) {
            setSetting('skipDeleteConfirm_blog', true)
            setSkipDeleteConfirm(true)
          }
          setShowDeleteConfirm(false)
          deleteEntry(entryId).then(onSave).catch(console.error)
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  )
}

function fmtTime(d: Date): string {
  const diff = Date.now() - d.getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前'
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
