import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, ImagePlus, Trash2, Clock3, RefreshCw, PencilLine, Pin, PinOff, X, Camera, Check,
  ChevronLeft, ChevronRight, ChevronDown, Search, Images, List, LayoutGrid, Copy, Eye, EyeOff,
} from 'lucide-react'
import { ConfirmDialog } from '../../components/shared'
import {
  createMomentsPost,
  createMomentsAlbum,
  deleteMomentsPost,
  deleteMomentsAlbum,
  getAvatarBase64,
  getMomentsAlbums,
  getMomentsPosts,
  getUserProfile,
  renameMomentsAlbum,
  setMomentsAlbumCover,
  setUserUsername,
  setMomentsPostAlbum,
  toggleMomentsPin,
  uploadAttachments,
  deleteAttachment,
  updateMomentsPost,
  copyImageUrlToClipboard,
} from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { ThemeFxLayer } from '../../components/shared/ThemeFxLayer'
import type { MomentsAlbum, MomentsPost, UserProfile } from '../../types'

type EditorMode = 'create' | 'edit'
type ViewMode = 'timeline' | 'album'

type Draft = {
  contentMd: string
  attachments: PendingAtt[]
  tags: string[]
}

type PendingAtt = {
  id: string
  url: string
  thumbUrl: string
  name: string
  mime: string
  size: number
  pending: boolean
}

const MAX_IMAGES = 12
const MAX_TAGS = 5
const GRID_VISIBLE = 8 // 第 9 格用于展示 "+N" 折叠
const TAG_PALETTE = ['#38bdf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#f97316']

/** 按标签名稳定分配颜色（与每日博客的彩色标签风格一致） */
function tagColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return TAG_PALETTE[h % TAG_PALETTE.length]
}

function formatDateTime(value: string): string {
  return value.replace('T', ' ').slice(0, 16)
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function initials(name: string): string {
  const t = name.trim()
  if (!t) return 'K'
  return t.slice(0, 1).toUpperCase()
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** 生成缩略图（最大边 256px，JPEG） */
function makeThumb(dataUrl: string, max = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(dataUrl); return }
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      } catch {
        resolve(dataUrl)
      }
    }
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

/** 判断是否为 HEIC/HEIF：优先按扩展名/MIME，再按文件头特征兜底 */
const HEIC_EXT_RE = /\.(heic|heif)$/i

async function detectHeic(file: File): Promise<boolean> {
  if (/^image\/hei[cf]$/i.test(file.type || '') || HEIC_EXT_RE.test(file.name)) return true
  try {
    const { isHeic } = await import('heic-to/csp')
    return await isHeic(file)
  } catch {
    return false
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** 用 heic-to（libheif）把 HEIC/HEIF 本地转为 JPEG，Chromium 本身无法解码 HEIC */
async function convertHeicToJpeg(file: File): Promise<string> {
  const { heicTo } = await import('heic-to/csp')
  const jpeg = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 })
  return blobToDataUrl(jpeg)
}

/** 预处理待上传图片：HEIC 先转 JPEG 并同步文件名/MIME，再生成缩略图 */
async function prepareImageFile(f: File) {
  const heic = await detectHeic(f)
  let dataUrl = await readFileAsDataUrl(f)
  if (heic) {
    try {
      dataUrl = await convertHeicToJpeg(f)
    } catch {
      throw new Error(`HEIC 照片「${f.name}」转换失败，请改用 JPEG/PNG 后重试`)
    }
  }
  const thumbDataUrl = await makeThumb(dataUrl)
  return {
    name: heic ? f.name.replace(HEIC_EXT_RE, '.jpg') : f.name,
    mime: heic ? 'image/jpeg' : (f.type || 'image/*'),
    dataUrl,
    thumbDataUrl,
  }
}

/** 帖子图片访问：优先附件（文件化），老数据回退 base64 */
function postImages(post: MomentsPost): { urls: string[]; thumbs: string[] } {
  if (post.attachments && post.attachments.length > 0) {
    return {
      urls: post.attachments.map(a => a.url),
      thumbs: post.attachments.map(a => a.thumbUrl),
    }
  }
  const legacy = post.imageDataUrls || []
  return { urls: legacy, thumbs: legacy }
}

/** 把 Markdown 转成适合时间线预览的纯文本 */
function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' [代码块] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[|:]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 主页折叠文案：超过 maxLines 时截断并显示「全文」 */
function ClampedText({ text, maxLines = 5, onExpand }: { text: string; maxLines?: number; onExpand: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [text])

  return (
    <div>
      <div
        ref={ref}
        className="overflow-hidden whitespace-pre-wrap break-words"
        style={{ display: '-webkit-box', WebkitLineClamp: maxLines, WebkitBoxOrient: 'vertical' }}
      >
        {text}
      </div>
      {overflowing && (
        <button onClick={onExpand} className="mt-1.5 text-[13px] text-[var(--accent)] hover:underline">
          全文
        </button>
      )}
    </div>
  )
}

export function MomentsModule() {
  const [posts, setPosts] = useState<MomentsPost[]>([])
  const [albums, setAlbums] = useState<MomentsAlbum[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('timeline')
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null)
  const [tagQuery, setTagQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [mode, setMode] = useState<EditorMode>('create')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({ contentMd: '', attachments: [], tags: [] })
  const [tagInput, setTagInput] = useState('')
  const [tagInputVisible, setTagInputVisible] = useState(false)
  const [editorImagesExpanded, setEditorImagesExpanded] = useState(false)
  const [expandedFeedIds, setExpandedFeedIds] = useState<Set<string>>(new Set())
  const [expandedAlbumPosts, setExpandedAlbumPosts] = useState<Set<string>>(new Set())
  const [albumLayout, setAlbumLayout] = useState<'list' | 'grid'>('list')
  const [detailPostId, setDetailPostId] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [albumDeleteConfirm, setAlbumDeleteConfirm] = useState<MomentsAlbum | null>(null)
  const [albumModal, setAlbumModal] = useState<
    { mode: 'pick'; postId: string } | { mode: 'create'; postId?: string } | { mode: 'rename'; albumId: string } | null
  >(null)
  const [albumNameDraft, setAlbumNameDraft] = useState('')
  /** 相册「添加照片」的确认弹层：已上传的临时附件，等待用户选择是否上时间线 */
  const [albumPhotoConfirm, setAlbumPhotoConfirm] = useState<{ id: string; thumbUrl: string }[] | null>(null)
  const [albumPhotoShowTimeline, setAlbumPhotoShowTimeline] = useState(false)
  const [saving, setSaving] = useState(false)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [avatarDataUrl, setAvatarDataUrl] = useState('')
  const [editingSignature, setEditingSignature] = useState(false)
  const [signatureDraft, setSignatureDraft] = useState('')
  const postImageInputRef = useRef<HTMLInputElement>(null)
  const albumPhotoInputRef = useRef<HTMLInputElement>(null)
  const pageScrollRef = useRef<HTMLDivElement>(null)

  const loadPosts = useCallback(async () => {
    setLoading(true)
    try {
      setPosts(await getMomentsPosts())
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadAlbums = useCallback(async () => {
    try {
      setAlbums(await getMomentsAlbums())
    } catch (err) {
      console.error(err)
    }
  }, [])

  const reloadProfile = useCallback(async () => {
    try {
      const p = await getUserProfile()
      setProfile(p)
    } catch {
      setProfile(null)
    }
  }, [])

  useEffect(() => {
    loadPosts()
    loadAlbums()
    reloadProfile()
    getAvatarBase64()
      .then(v => { if (typeof v === 'string') setAvatarDataUrl(v) })
      .catch(() => setAvatarDataUrl(''))
  }, [loadPosts, loadAlbums, reloadProfile])

  // Esc 关闭编辑器 / 详情弹层（灯箱打开时让灯箱优先处理）
  useEffect(() => {
    if (!editorOpen && !detailPostId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !lightbox) {
        setEditorOpen(false)
        setDetailPostId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editorOpen, detailPostId, lightbox])

  // 灯箱：Esc 关闭，左右键切换图片
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
      if (e.key === 'ArrowLeft') setLightbox(l => l ? { ...l, index: (l.index - 1 + l.images.length) % l.images.length } : l)
      if (e.key === 'ArrowRight') setLightbox(l => l ? { ...l, index: (l.index + 1) % l.images.length } : l)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  const signature = profile?.username?.trim() || '写下此刻'
  const canSave = !saving && (draft.contentMd.trim().length > 0 || draft.attachments.length > 0)
  const detailPost = detailPostId ? posts.find(p => p.id === detailPostId) || null : null

  const switchView = (v: ViewMode) => {
    setViewMode(v)
    pageScrollRef.current?.scrollTo({ top: 0 })
  }

  // ---- 标签筛选 ----
  const filteredPosts = useMemo(() => {
    const q = tagQuery.trim().toLowerCase()
    if (!q) return posts
    return posts.filter(p => (p.tags || []).some(t => t.toLowerCase().includes(q)))
  }, [posts, tagQuery])

  const pinnedPosts = useMemo(() => filteredPosts.filter(p => p.isPinned && p.showInTimeline !== false), [filteredPosts])
  const normalPosts = useMemo(() => filteredPosts.filter(p => !p.isPinned && p.showInTimeline !== false), [filteredPosts])
  const albumPosts = useMemo(
    () => (selectedAlbumId ? filteredPosts.filter(p => p.albumId === selectedAlbumId && postImages(p).urls.length > 0) : []),
    [filteredPosts, selectedAlbumId]
  )
  const selectedAlbum = selectedAlbumId ? albums.find(a => a.id === selectedAlbumId) || null : null

  const closeEditor = (cleanup = true) => {
    // 清理未保存的临时附件
    if (cleanup) {
      for (const a of draft.attachments) {
        if (a.pending) deleteAttachment(a.id).catch(console.error)
      }
    }
    setEditorOpen(false)
    setEditingId(null)
    setEditorImagesExpanded(false)
    setDraft({ contentMd: '', attachments: [], tags: [] })
  }

  const openCreate = () => {
    setMode('create')
    setEditingId(null)
    setDraft({ contentMd: '', attachments: [], tags: [] })
    setTagInput('')
    setTagInputVisible(false)
    setEditorImagesExpanded(false)
    setEditorOpen(true)
  }

  const openEdit = (post: MomentsPost) => {
    setMode('edit')
    setEditingId(post.id)
    setDraft({
      contentMd: post.contentMd || '',
      attachments: (post.attachments || []).map(a => ({ ...a, pending: false })),
      tags: post.tags || [],
    })
    setTagInput('')
    setTagInputVisible(false)
    setEditorImagesExpanded(false)
    setEditorOpen(true)
  }

  const addTag = () => {
    const raw = tagInput.trim()
    if (!raw) {
      setTagInputVisible(false)
      return
    }
    const normalized = raw.startsWith('#') ? raw.slice(1) : raw
    setDraft(prev => {
      const exists = (prev.tags || []).some(t => t.toLowerCase() === normalized.toLowerCase())
      if (exists || prev.tags.length >= MAX_TAGS) return prev
      return { ...prev, tags: [...prev.tags, normalized] }
    })
    setTagInput('')
    setTagInputVisible(false)
  }

  const removeTag = (index: number) => {
    setDraft(prev => ({ ...prev, tags: prev.tags.filter((_, i) => i !== index) }))
  }

  // 把图片文件加入当前说说草稿（文件选择 + 粘贴两条路径复用）
  const addImageFiles = async (files: File[]) => {
    const room = MAX_IMAGES - draft.attachments.length
    const picked = files.slice(0, room)
    if (picked.length === 0) return
    try {
      const prepared = await Promise.all(picked.map(prepareImageFile))
      const records = await uploadAttachments({ ownerType: 'moments_post', ownerId: '', files: prepared })
      setDraft(prev => ({
        ...prev,
        attachments: [...prev.attachments, ...records.map(r => ({ ...r, pending: true }))],
      }))
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : '图片处理失败，请重试' })
    }
  }

  const handlePickImages = async () => {
    const input = postImageInputRef.current
    if (!input?.files?.length) return
    const files = Array.from(input.files)
    input.value = ''
    await addImageFiles(files)
  }

  // 粘贴截图到说说：图片进附件，不进正文文本框
  const handleEditorPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length === 0) return
    e.preventDefault()
    void addImageFiles(files)
  }

  const removeImage = (index: number) => {
    setDraft(prev => ({
      ...prev,
      attachments: prev.attachments.filter((_, i) => {
        if (i === index && prev.attachments[i]?.pending) deleteAttachment(prev.attachments[i].id).catch(console.error)
        return i !== index
      }),
    }))
  }

  const handlePickAlbumPhotos = async () => {
    const input = albumPhotoInputRef.current
    if (!input?.files?.length || !selectedAlbumId) return
    const files = Array.from(input.files).slice(0, MAX_IMAGES)
    input.value = ''
    if (files.length === 0) return
    try {
      const prepared = await Promise.all(files.map(prepareImageFile))
      const records = await uploadAttachments({ ownerType: 'moments_post', ownerId: '', files: prepared })
      // 上传完成后弹层让用户选择：仅存相册 / 同时显示在时间线
      setAlbumPhotoShowTimeline(false)
      setAlbumPhotoConfirm(records.map(r => ({ id: r.id, thumbUrl: r.thumbUrl })))
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : '图片处理失败，请重试' })
    }
  }

  /** 取消添加：清理已上传的临时附件 */
  const cancelAlbumPhotoConfirm = async () => {
    const ids = (albumPhotoConfirm || []).map(a => a.id)
    setAlbumPhotoConfirm(null)
    for (const id of ids) await deleteAttachment(id).catch(() => { /* ignore */ })
  }

  const confirmAlbumPhotos = async () => {
    if (!albumPhotoConfirm || !selectedAlbumId) return
    try {
      await createMomentsPost({
        contentMd: '',
        contentHtml: '',
        attachmentIds: albumPhotoConfirm.map(a => a.id),
        albumId: selectedAlbumId,
        isPinned: false,
        showInTimeline: albumPhotoShowTimeline,
      })
      setAlbumPhotoConfirm(null)
      await Promise.all([loadPosts(), loadAlbums()])
    } catch (err) {
      console.error(err)
    }
  }

  /** 切换某条说说是否显示在时间线（相册卡片 / 时间线卡片共用） */
  const togglePostTimeline = async (post: MomentsPost) => {
    try {
      await updateMomentsPost(post.id, { showInTimeline: post.showInTimeline === false })
      await loadPosts()
    } catch (err) {
      console.error(err)
    }
  }

  const startEditSignature = () => {
    setSignatureDraft(signature)
    setEditingSignature(true)
  }

  const saveSignature = async () => {
    const trimmed = signatureDraft.trim()
    if (!trimmed) return
    await setUserUsername(trimmed)
    setEditingSignature(false)
    await reloadProfile()
  }

  const handleSave = async () => {
    const trimmed = draft.contentMd.trim()
    if (saving || (trimmed.length === 0 && draft.attachments.length === 0)) return
    setSaving(true)
    try {
      const payload = {
        contentMd: trimmed,
        contentHtml: '',
        attachmentIds: draft.attachments.map(a => a.id),
        tags: draft.tags,
      }
      if (mode === 'create') {
        await createMomentsPost({ ...payload, isPinned: false })
      } else if (editingId) {
        await updateMomentsPost(editingId, payload)
      }
      closeEditor(false)
      setDraft({ contentMd: '', attachments: [], tags: [] })
      await loadPosts()
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleTogglePin = async (id: string) => {
    try {
      await toggleMomentsPin(id)
      await loadPosts()
    } catch (err) {
      console.error(err)
    }
  }

  const handleDelete = async () => {
    if (!confirmDeleteId) return
    try {
      await deleteMomentsPost(confirmDeleteId)
      setConfirmDeleteId(null)
      await loadPosts()
    } catch (err) {
      console.error(err)
    }
  }

  const openAlbumModal = (m: { mode: 'pick'; postId: string } | { mode: 'create'; postId?: string } | { mode: 'rename'; albumId: string }) => {
    setAlbumNameDraft('')
    setAlbumModal(m)
  }

  const confirmAlbumModal = async () => {
    const name = albumNameDraft.trim()
    if (!name || !albumModal) return
    try {
      if (albumModal.mode === 'rename') {
        await renameMomentsAlbum(albumModal.albumId, name)
      } else {
        const created = await createMomentsAlbum(name)
        if (created && albumModal.postId) {
          await setMomentsPostAlbum(albumModal.postId, created.id)
          await loadPosts()
        }
      }
      setAlbumModal(null)
      await loadAlbums()
    } catch (err) {
      console.error(err)
    }
  }

  const assignPostAlbum = async (postId: string, albumId: string) => {
    try {
      await setMomentsPostAlbum(postId, albumId)
      setAlbumModal(null)
      await Promise.all([loadPosts(), loadAlbums()])
    } catch (err) {
      console.error(err)
    }
  }

  const handleDeleteAlbum = async (album: MomentsAlbum) => {
    try {
      await deleteMomentsAlbum(album.id)
      setAlbumDeleteConfirm(null)
      setSelectedAlbumId(null)
      await Promise.all([loadPosts(), loadAlbums()])
    } catch (err) {
      console.error(err)
    }
  }

  const handleSetAlbumCover = async (albumId: string, postId: string, index: number) => {
    try {
      await setMomentsAlbumCover(albumId, postId, index)
      await loadAlbums()
    } catch (err) {
      console.error(err)
    }
  }

  const handleDeleteAlbumPhoto = async (item: { postId: string; indexInPost: number }) => {
    try {
      const post = posts.find(p => p.id === item.postId)
      if (!post) return
      // 删除的是相册封面引用时，清掉封面设置（自动回退到第一张）
      if (selectedAlbum && selectedAlbum.coverPostId === item.postId && selectedAlbum.coverIndex === item.indexInPost) {
        await setMomentsAlbumCover(selectedAlbum.id, '', 0)
      }
      const isLegacy = (post.attachmentIds || []).length === 0
      const remainingLegacy = isLegacy ? (post.imageDataUrls || []).filter((_, i) => i !== item.indexInPost) : []
      const remainingIds = isLegacy ? [] : (post.attachmentIds || []).filter((_, i) => i !== item.indexInPost)
      const hasText = !!(post.contentMd || '').trim()
      if (!hasText && (isLegacy ? remainingLegacy.length === 0 : remainingIds.length === 0)) {
        // 纯照片说说删掉最后一张图 → 整条进回收站
        await deleteMomentsPost(post.id)
      } else if (isLegacy) {
        await updateMomentsPost(post.id, { imageDataUrls: remainingLegacy })
      } else {
        await updateMomentsPost(post.id, { attachmentIds: remainingIds })
      }
      await Promise.all([loadPosts(), loadAlbums()])
    } catch (err) {
      console.error(err)
    }
  }

  const toggleFeedExpanded = (postId: string) => {
    setExpandedFeedIds(prev => {
      const next = new Set(prev)
      if (next.has(postId)) next.delete(postId)
      else next.add(postId)
      return next
    })
  }

  const toggleAlbumPost = (postId: string) => {
    setExpandedAlbumPosts(prev => {
      const next = new Set(prev)
      if (next.has(postId)) next.delete(postId)
      else next.add(postId)
      return next
    })
  }

  // 相册分组卡片头部（列表 / 网格展开态共用）
  const renderAlbumCardHeader = (post: MomentsPost, imgs: { urls: string[]; thumbs: string[] }, text: string, expanded: boolean) => {
    const cover = imgs.thumbs[0] || imgs.urls[0]
    const hiddenInTimeline = post.showInTimeline === false
    return (
      <div className="w-full flex items-center">
        <button
          onClick={() => toggleAlbumPost(post.id)}
          className="flex-1 min-w-0 flex items-center gap-3 px-3 py-3 text-left hover:bg-[var(--bg-hover)]/50 transition-colors"
          title={expanded ? '收起' : '展开'}
        >
          {cover ? (
            <img src={cover} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0 border border-[var(--border-color)]" loading="lazy" />
          ) : (
            <div className="w-14 h-14 rounded-lg bg-[var(--bg-primary)] shrink-0 border border-[var(--border-color)]" />
          )}
          <div className="min-w-0 flex-1">
            {text ? (
              <div className={'text-[13px] leading-snug text-[var(--text-primary)] whitespace-pre-wrap break-words ' + (expanded ? '' : 'line-clamp-2')}>
                {text}
              </div>
            ) : (
              <div className="text-[13px] text-[var(--text-muted)] italic">无文字记录</div>
            )}
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
              <span>{formatDateTime(post.createdAt)}</span>
              <span>·</span>
              <span>{imgs.urls.length} 张照片</span>
              {hiddenInTimeline && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-md bg-[var(--bg-hover)] border border-[var(--border-color)]">
                  <EyeOff size={9} />
                  仅相册
                </span>
              )}
            </div>
          </div>
          <ChevronDown size={16} className={'shrink-0 text-[var(--text-muted)] transition-transform duration-200 ' + (expanded ? 'rotate-180' : '')} />
        </button>
        <button
          onClick={e => { e.stopPropagation(); void togglePostTimeline(post) }}
          className={'mr-2 p-1 rounded-md transition-colors shrink-0 ' + (hiddenInTimeline
            ? 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            : 'text-[var(--accent)] hover:bg-[var(--bg-hover)]')}
          title={hiddenInTimeline ? '显示在时间线' : '从时间线隐藏（仅保留在相册）'}
        >
          {hiddenInTimeline ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    )
  }

  // 相册分组内的照片网格（列表 / 网格展开态共用）
  const renderAlbumPhotoGrid = (post: MomentsPost, imgs: { urls: string[]; thumbs: string[] }) => (
    <div className="grid grid-cols-3 gap-2">
      {imgs.urls.map((u, i) => (
        <div key={i} className="relative aspect-square rounded-xl overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)] group">
          <img
            src={imgs.thumbs[i] || u}
            alt=""
            className="w-full h-full object-cover cursor-zoom-in"
            loading="lazy"
            onClick={() => setLightbox({ images: imgs.urls, index: i })}
          />
          {selectedAlbum!.coverPostId === post.id && selectedAlbum!.coverIndex === i && (
            <span className="absolute left-1.5 top-1.5 px-1.5 py-0.5 rounded-full bg-black/55 text-white text-[10px] pointer-events-none">封面</span>
          )}
          <button
            onClick={e => { e.stopPropagation(); handleDeleteAlbumPhoto({ postId: post.id, indexInPost: i }).catch(console.error) }}
            className="absolute right-1.5 top-1.5 w-6 h-6 rounded-full bg-black/55 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-black/80 backdrop-blur transition-opacity"
            title="删除这张照片"
          >
            <Trash2 size={12} />
          </button>
          {!(selectedAlbum!.coverPostId === post.id && selectedAlbum!.coverIndex === i) && (
            <button
              onClick={e => { e.stopPropagation(); handleSetAlbumCover(selectedAlbum!.id, post.id, i).catch(console.error) }}
              className="absolute inset-x-1.5 bottom-1.5 py-1 rounded-lg bg-black/55 text-white text-[10px] backdrop-blur opacity-0 group-hover:opacity-100 transition-opacity"
              title="设为封面"
            >
              <Camera size={11} className="inline mr-1 -mt-0.5" />
              设为封面
            </button>
          )}
        </div>
      ))}
    </div>
  )

  const renderTags = (tags: string[], onClickTag?: (tag: string) => void) => {
    if (!tags || tags.length === 0) return null
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {tags.map(t => (
          onClickTag ? (
            <button
              key={t}
              onClick={e => { e.stopPropagation(); onClickTag(t) }}
              className="px-2 py-0.5 rounded-md bg-[var(--bg-hover)] border border-[var(--border-color)] text-[11px] text-[var(--accent)] hover:bg-[var(--bg-hover)]"
            >
              #{t}
            </button>
          ) : (
            <span key={t} className="px-2 py-0.5 rounded-md bg-[var(--bg-hover)] border border-[var(--border-color)] text-[11px] text-[var(--accent)]">
              #{t}
            </span>
          )
        ))}
      </div>
    )
  }

  const renderCoverGrid = (post: MomentsPost) => {
    const { urls, thumbs } = postImages(post)
    if (urls.length === 0) return null

    const expanded = expandedFeedIds.has(post.id)
    const visible = expanded ? urls : urls.slice(0, GRID_VISIBLE)
    const overflow = urls.length - visible.length
    const isSingle = urls.length === 1
    const colsClass = urls.length <= 4 ? 'grid-cols-2' : 'grid-cols-3'

    // 单图：整块封面展示
    if (isSingle) {
      return (
        <div
          onClick={e => { e.stopPropagation(); setLightbox({ images: urls, index: 0 }) }}
          className="relative w-[38%] max-w-[250px] shrink-0 min-h-[176px] bg-[var(--bg-primary)] cursor-zoom-in"
          title="点击放大查看"
        >
          <img src={thumbs[0] || urls[0]} alt="说说图片" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
        </div>
      )
    }

    return (
      <div className="relative w-[38%] max-w-[250px] shrink-0 bg-[var(--bg-primary)] p-[3px]">
        <span className="absolute right-1.5 top-1.5 z-10 px-1.5 py-0.5 rounded-full bg-black/50 text-white text-[10px] pointer-events-none">
          {urls.length} 张
        </span>
        <div className={`grid ${colsClass} gap-[3px]`}>
          {visible.map((img, i) => (
            <div
              key={i}
              onClick={e => { e.stopPropagation(); setLightbox({ images: urls, index: i }) }}
              className="relative aspect-square overflow-hidden rounded-[9px] bg-[var(--bg-primary)] cursor-zoom-in"
              title="点击放大查看"
            >
              <img src={thumbs[i] || img} alt={`说说图片 ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
            </div>
          ))}
          {overflow > 0 && !expanded && (
            <button
              onClick={e => { e.stopPropagation(); toggleFeedExpanded(post.id) }}
              className="relative aspect-square overflow-hidden rounded-[9px] bg-[var(--bg-primary)]"
              title={`展开剩余 ${overflow} 张图片`}
            >
              <img src={thumbs[GRID_VISIBLE] || urls[GRID_VISIBLE]} alt="" className="w-full h-full object-cover" loading="lazy" />
              <span className="absolute inset-0 bg-black/55 flex items-center justify-center text-white text-[16px] font-semibold">
                +{overflow}
              </span>
            </button>
          )}
        </div>
        {expanded && overflow > 0 && (
          <button
            onClick={e => { e.stopPropagation(); toggleFeedExpanded(post.id) }}
            className="absolute bottom-1.5 right-1.5 z-10 px-2 py-0.5 rounded-full bg-black/55 text-white text-[10px] backdrop-blur"
          >
            收起
          </button>
        )}
      </div>
    )
  }

  const renderPost = (post: MomentsPost) => {
    const previewText = post.contentMd || stripHtmlTags(post.contentHtml || '')
    // kb-cv：视口外说说跳过布局与绘制（时间线列表的 CSS 虚拟化，见 styles/index.css）
    return (
      <article
        key={post.id}
        onClick={() => setDetailPostId(post.id)}
        className="kb-cv flex rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden cursor-pointer hover:border-[var(--text-muted)]/40 transition-colors"
        title="查看完整文案"
      >
        {renderCoverGrid(post)}

        <div className="flex-1 min-w-0 px-4 py-3.5 flex flex-col">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 text-[11px] text-[var(--text-muted)] mt-0.5">
              <Clock3 size={11} />
              <span className="truncate">{formatDateTime(post.createdAt)}</span>
              {post.isPinned && <span className="inline-flex items-center gap-1 text-[var(--accent)]"><Pin size={10} />置顶</span>}
            </div>

            <div className="flex items-center gap-0.5 shrink-0">
              <button onClick={e => { e.stopPropagation(); handleTogglePin(post.id) }} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors" title={post.isPinned ? '取消置顶' : '置顶'}>
                {post.isPinned ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
              <button onClick={e => { e.stopPropagation(); openAlbumModal({ mode: 'pick', postId: post.id }) }} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors" title={post.albumId ? '更换相册' : '加入相册'}>
                <Images size={14} />
              </button>
              {post.albumId && (
                <button onClick={e => { e.stopPropagation(); void togglePostTimeline(post) }} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors" title="仅在相册中显示（从时间线隐藏）">
                  <EyeOff size={14} />
                </button>
              )}
              <button onClick={e => { e.stopPropagation(); openEdit(post) }} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors" title="编辑">
                <PencilLine size={14} />
              </button>
              <button onClick={e => { e.stopPropagation(); setConfirmDeleteId(post.id) }} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] transition-colors" title="删除">
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 mt-2 text-[14px] leading-6 text-[var(--text-primary)]">
            <ClampedText
              text={plainText(previewText) || previewText}
              maxLines={4}
              onExpand={() => setDetailPostId(post.id)}
            />
          </div>

          <div className="mt-2">
            {renderTags(post.tags || [], t => setTagQuery(t))}
          </div>

          <div className="mt-2 text-[10px] text-[var(--text-muted)] flex items-center gap-2 flex-wrap">
            <span>{post.updatedAt !== post.createdAt ? '已编辑' : '发布'}</span>
            {post.albumId && albums.find(a => a.id === post.albumId) && (
              <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
                <Images size={10} />
                {albums.find(a => a.id === post.albumId)!.name}
              </span>
            )}
          </div>
        </div>
      </article>
    )
  }

  return (
    <div className="kb-theme-surface relative flex flex-col h-full overflow-hidden">
      {/* 主题氛围特效：垫底画布（2026-09-27 挂载面扩到说说；内容层 z-[1] 压在其上，灯箱 z-70 不受影响） */}
      <ThemeFxLayer />
      <div ref={pageScrollRef} className="relative z-[1] flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="px-5 pt-4 pb-3">
          <div className="max-w-4xl mx-auto rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-5 py-4 flex items-center gap-3">
            <div className="w-12 h-12 rounded-full overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)] shrink-0">
              {avatarDataUrl ? (
                <img src={avatarDataUrl} alt="头像" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[15px] font-medium text-[var(--accent)]">{initials(signature)}</div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              {editingSignature ? (
                <div className="flex items-center gap-2 min-w-0">
                  <input
                    autoFocus
                    value={signatureDraft}
                    onChange={e => setSignatureDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveSignature().catch(console.error)
                      if (e.key === 'Escape') setEditingSignature(false)
                    }}
                    maxLength={30}
                    placeholder="输入签名"
                    className="min-w-0 flex-1 max-w-sm bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-md px-3 py-1.5 text-[15px] font-medium text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={() => { saveSignature().catch(console.error) }}
                    className="p-1 rounded-md text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                    title="保存签名"
                  >
                    <Check size={15} />
                  </button>
                  <button
                    onClick={() => setEditingSignature(false)}
                    className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                    title="取消"
                  >
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[15px] font-medium text-[var(--text-primary)] truncate">{signature}</span>
                  <button
                    onClick={startEditSignature}
                    className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                    title="修改签名"
                  >
                    <PencilLine size={13} />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

      {/* 搜索 + 视图切换 */}
      <div className="sticky top-0 z-30 px-2 py-1 bg-[var(--bg-primary)]/85 backdrop-blur-md">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={tagQuery}
              onChange={e => setTagQuery(e.target.value)}
              placeholder="搜索标签..."
              className="w-56 pl-8 pr-7 py-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)] transition-colors"
            />
            {tagQuery && (
              <button
                onClick={() => setTagQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                title="清除搜索"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-0.5">
            <button
              onClick={() => switchView('timeline')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] transition-colors ${viewMode === 'timeline' ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
            >
              <List size={12} />
              时间线
            </button>
            <button
              onClick={() => switchView('album')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] transition-colors ${viewMode === 'album' ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
            >
              <Images size={12} />
              相册
            </button>
          </div>
        </div>
      </div>

      <div className="px-5 pb-24">
        {/* 视图切换动效（docs/ui-animation-plan.md A 类）：key 随 视图模式/相册选择 变化重放进场，
            用纯 transform+opacity，不给图片墙做常驻 will-change */}
        <div key={`${viewMode}:${selectedAlbumId ?? ''}`} className="kb-view-in max-w-4xl mx-auto space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-[12px] text-[var(--text-muted)] gap-2">
              <RefreshCw size={14} className="animate-spin" />
              加载中...
            </div>
          ) : viewMode === 'album' ? (
            selectedAlbum ? (
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <button
                    onClick={() => setSelectedAlbumId(null)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    <ChevronLeft size={12} />
                    返回
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-[var(--text-primary)] truncate">{selectedAlbum.name}</div>
                    <div className="text-[11px] text-[var(--text-muted)]">{selectedAlbum.photoCount} 张照片</div>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => setAlbumLayout('list')}
                      className={'p-1 rounded-md transition-colors ' + (albumLayout === 'list' ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}
                      title="列表排列"
                    >
                      <List size={14} />
                    </button>
                    <button
                      onClick={() => setAlbumLayout('grid')}
                      className={'p-1 rounded-md transition-colors ' + (albumLayout === 'grid' ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}
                      title="网格排列"
                    >
                      <LayoutGrid size={14} />
                    </button>
                  </div>
                  <button
                    onClick={() => albumPhotoInputRef.current?.click()}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
                    title="直接添加照片到相册"
                  >
                    <ImagePlus size={12} />
                    添加照片
                  </button>
                  <button
                    onClick={() => openAlbumModal({ mode: 'rename', albumId: selectedAlbum.id })}
                    className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                    title="重命名相册"
                  >
                    <PencilLine size={14} />
                  </button>
                  {selectedAlbum.coverPostId && (
                    <button
                      onClick={() => { handleSetAlbumCover(selectedAlbum.id, '', 0).catch(console.error) }}
                      className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                      title="取消自定义封面（恢复为第一张照片）"
                    >
                      <X size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => setAlbumDeleteConfirm(selectedAlbum)}
                    className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] transition-colors"
                    title="删除相册"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {albumPosts.length === 0 ? (
                  <div className="py-16 text-center text-[12px] text-[var(--text-muted)]">
                    暂无照片，从说说卡片添加
                  </div>
                ) : (
                  albumLayout === 'list' ? (
                    <div className="space-y-3">
                      {albumPosts.map(post => {
                        const imgs = postImages(post)
                        const text = (post.contentMd || stripHtmlTags(post.contentHtml || '')).trim()
                        const expanded = expandedAlbumPosts.has(post.id)
                        return (
                          <div key={post.id} className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden">
                            {renderAlbumCardHeader(post, imgs, text, expanded)}
                            <div className="grid" style={{ gridTemplateRows: expanded ? '1fr' : '0fr', transition: 'grid-template-rows 300ms ease-in-out' }}>
                              <div className="overflow-hidden min-h-0">
                                <div className="px-3 pb-3" style={{ opacity: expanded ? 1 : 0, transform: expanded ? 'none' : 'translateY(-8px) scale(0.97)', transition: 'opacity 250ms ease-in-out, transform 300ms ease-in-out' }}>
                                  {renderAlbumPhotoGrid(post, imgs)}
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                      <button
                        onClick={() => albumPhotoInputRef.current?.click()}
                        className="w-full py-3 rounded-xl border border-dashed border-[var(--border-color)] bg-[var(--bg-hover)]/30 flex items-center justify-center gap-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                        title="添加照片"
                      >
                        <ImagePlus size={16} />
                        <span className="text-[12px]">添加照片</span>
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 items-start">
                      {albumPosts.map(post => {
                        const imgs = postImages(post)
                        const text = (post.contentMd || stripHtmlTags(post.contentHtml || '')).trim()
                        const expanded = expandedAlbumPosts.has(post.id)
                        const cover = imgs.thumbs[0] || imgs.urls[0]
                        if (expanded) {
                          return (
                            <div key={post.id} className="col-span-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden animate-album-unfold">
                              {renderAlbumCardHeader(post, imgs, text, true)}
                              <div className="px-3 pb-3">{renderAlbumPhotoGrid(post, imgs)}</div>
                            </div>
                          )
                        }
                        return (
                          <button key={post.id} onClick={() => toggleAlbumPost(post.id)} className="relative aspect-square rounded-xl overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)] group" title="展开">
                            {cover ? (
                              <img src={cover} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)]"><Images size={22} /></div>
                            )}
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-2 pt-8 pb-1.5 text-left">
                              {text ? (
                                <div className="text-[11px] text-white line-clamp-1">{text}</div>
                              ) : (
                                <div className="text-[11px] text-white/60 italic">无文字</div>
                              )}
                              <div className="text-[10px] text-white/75">{imgs.urls.length} 张</div>
                            </div>
                          </button>
                        )
                      })}
                      <button
                        onClick={() => albumPhotoInputRef.current?.click()}
                        className="aspect-square rounded-xl border border-dashed border-[var(--border-color)] bg-[var(--bg-hover)]/30 flex flex-col items-center justify-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                        title="添加照片"
                      >
                        <ImagePlus size={22} />
                        <span className="text-[11px]">添加照片</span>
                      </button>
                    </div>
                  )
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <div className="text-[12px] text-[var(--text-secondary)]">共 {albums.length} 个相册</div>
                  <button
                    onClick={() => openAlbumModal({ mode: 'create' })}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
                  >
                    <Plus size={12} />
                    新建相册
                  </button>
                </div>

                {albums.length === 0 ? (
                  <div className="py-16 text-center text-[12px] text-[var(--text-muted)]">
                    暂无相册
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {albums.map(a => (
                      <button
                        key={a.id}
                        onClick={() => setSelectedAlbumId(a.id)}
                        className="group rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden text-left hover:border-[var(--text-muted)]/40 transition-colors"
                      >
                        <div className="relative aspect-[4/3] bg-[var(--bg-primary)] overflow-hidden">
                          {a.cover ? (
                            <img src={a.cover} alt={a.name} className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300" loading="lazy" />
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)]">
                              <Images size={30} className="text-[var(--text-muted)]" />
                            </div>
                          )}
                        </div>
                        <div className="px-3 py-2.5">
                          <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">{a.name}</div>
                          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{a.photoCount} 张照片</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )
          ) : filteredPosts.length === 0 ? (
            <div className="py-20 text-center text-[12px] text-[var(--text-muted)]">
              {tagQuery ? '该标签下暂无内容' : '暂无说说'}
            </div>
          ) : (
            <>
              {pinnedPosts.length > 0 && (
                <section className="space-y-3">
                  <div className="text-[11.5px] font-medium text-[var(--text-muted)] px-1">置顶</div>
                  {pinnedPosts.map(renderPost)}
                </section>
              )}
              <section className="space-y-3">
                <div className="text-[11.5px] font-medium text-[var(--text-muted)] px-1">时间线</div>
                {normalPosts.map(renderPost)}
              </section>
            </>
          )}
        </div>
      </div>
      </div>

      {viewMode === 'timeline' && (
        <button
          onClick={openCreate}
          // absolute 相对模块根（= 主体卡片内）：任务栏展开/收起不影响相对位置；
          // bottom-24 避开右下角 AI 助手按钮
          className="absolute right-6 bottom-24 z-40 w-10 h-10 rounded-full bg-[var(--accent)] text-white shadow-[0_2px_12px_rgba(0,0,0,0.12)] hover:bg-[var(--accent-hover)] transition-colors flex items-center justify-center"
          title="新建说说"
        >
          <Plus size={18} />
        </button>
      )}

      {editorOpen && (
        /* 遮罩带 backdrop-blur → 按 §五 约束不做遮罩淡入（blur 层每帧重采样成本高），只动面板 */
        <div
          className="absolute inset-0 z-50 bg-black/55 backdrop-blur-[3px] flex items-center justify-center p-5"
          onMouseDown={e => { if (e.target === e.currentTarget) closeEditor() }}
          onPaste={handleEditorPaste}
        >
          <div className="kb-modal-in w-full max-w-2xl max-h-[88%] flex flex-col rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-[0_2px_12px_rgba(0,0,0,0.12)] overflow-hidden">
            <div className="px-4 h-11 shrink-0 flex items-center justify-between gap-3 border-b border-[var(--border-color)]">
              <button
                onClick={() => closeEditor()}
                className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              >
                取消
              </button>
              <span className="text-[13px] font-medium text-[var(--text-primary)]">{mode === 'create' ? '发表新说说' : '编辑说说'}</span>
              <button
                onClick={handleSave}
                disabled={!canSave}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors"
              >
                {saving ? '发表中...' : '发表'}
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="max-w-xl mx-auto px-6 pt-6 pb-8">
                <div className="flex items-center gap-3 pb-5">
                  <div className="w-11 h-11 rounded-full overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)] shrink-0">
                    {avatarDataUrl ? (
                      <img src={avatarDataUrl} alt="头像" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[14px] font-medium text-[var(--accent)]">{initials(signature)}</div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">{signature}</div>
                    <div className="text-[11px] text-[var(--text-muted)]">发布</div>
                  </div>
                </div>

                <textarea
                  autoFocus
                  value={draft.contentMd}
                  onChange={e => setDraft(prev => ({ ...prev, contentMd: e.target.value }))}
                  placeholder="这一刻的想法..."
                  className="w-full min-h-[150px] resize-none rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-3 text-[13px] leading-7 text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors placeholder:text-[var(--text-disabled)]"
                />

                <div className="mt-4 flex items-center gap-1.5 flex-wrap">
                  {draft.tags.map((tag, i) => (
                    <span
                      key={i}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] shrink-0"
                      style={{ backgroundColor: tagColor(tag) + '20', color: tagColor(tag), border: `1px solid ${tagColor(tag)}40` }}
                    >
                      {tag}
                      <button onClick={() => removeTag(i)} className="hover:text-[var(--danger)] transition-colors" title="移除标签">
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  {draft.tags.length < MAX_TAGS && (
                    tagInputVisible ? (
                      <input
                        autoFocus
                        value={tagInput}
                        onChange={e => setTagInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); addTag() }
                          if (e.key === 'Escape') { setTagInputVisible(false); setTagInput('') }
                        }}
                        onBlur={addTag}
                        placeholder="标签名..."
                        className="w-20 px-1.5 py-0.5 bg-[var(--input-bg)] border border-[var(--accent)] rounded-md text-[11px] text-[var(--text-primary)] outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => setTagInputVisible(true)}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded border border-dashed border-[var(--border-color)] transition-colors"
                      >
                        <Plus size={10} />标签
                      </button>
                    )
                  )}
                  {draft.tags.length > 0 && (
                    <span className="text-[10px] text-[var(--text-disabled)] ml-1">{draft.tags.length}/{MAX_TAGS}</span>
                  )}
                </div>

                <div className="mt-5">
                  <div className="grid grid-cols-3 gap-2.5 w-[264px]">
                    {draft.attachments.slice(0, editorImagesExpanded ? draft.attachments.length : GRID_VISIBLE).map((att, i) => (
                      <div key={i} className="relative aspect-square rounded-xl overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)] group">
                        <img src={att.thumbUrl} alt={`图片 ${i + 1}`} className="w-full h-full object-cover" />
                        <button
                          onClick={() => removeImage(i)}
                          className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-black/65 text-white flex items-center justify-center hover:bg-black/85 transition-colors opacity-0 group-hover:opacity-100"
                          title="移除图片"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}

                    {!editorImagesExpanded && draft.attachments.length > GRID_VISIBLE && (
                      <button
                        onClick={() => setEditorImagesExpanded(true)}
                        className="relative aspect-square rounded-xl overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)]"
                        title="展开全部图片"
                      >
                        <img src={draft.attachments[GRID_VISIBLE]?.thumbUrl} alt="" className="w-full h-full object-cover" />
                        <span className="absolute inset-0 bg-black/55 flex items-center justify-center text-white text-[18px] font-semibold">
                          +{draft.attachments.length - GRID_VISIBLE}
                        </span>
                      </button>
                    )}

                    {draft.attachments.length < MAX_IMAGES && (editorImagesExpanded || draft.attachments.length <= GRID_VISIBLE) && (
                      <button
                        onClick={() => postImageInputRef.current?.click()}
                        className="aspect-square rounded-xl border border-dashed border-[var(--border-color)] bg-[var(--bg-hover)]/40 flex flex-col items-center justify-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                        title="添加图片"
                      >
                        <ImagePlus size={22} />
                        <span className="text-[11px]">添加图片</span>
                      </button>
                    )}
                  </div>

                  {editorImagesExpanded && (
                    <button
                      onClick={() => setEditorImagesExpanded(false)}
                      className="mt-3 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      收起图片
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="shrink-0 px-6 py-2 border-t border-[var(--border-color)] bg-[var(--bg-primary)]/60 flex items-center justify-end">
              <span className="text-[11px] text-[var(--text-muted)]">{draft.contentMd.trim().length} 字 · {draft.attachments.length} 图</span>
            </div>
          </div>

          <input ref={postImageInputRef} type="file" accept="image/*,.heic,.heif" multiple className="hidden" onChange={() => { handlePickImages().catch(console.error) }} />
        </div>
      )}

      {detailPost && (
        <div
          className="absolute inset-0 z-50 bg-black/55 backdrop-blur-[3px] flex items-center justify-center p-5"
          onMouseDown={e => { if (e.target === e.currentTarget) setDetailPostId(null) }}
        >
          <div className="kb-modal-in w-full max-w-3xl max-h-[92%] flex flex-col rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-[0_2px_12px_rgba(0,0,0,0.12)] overflow-hidden">
            <div className="px-5 py-4 flex items-start justify-between gap-3 border-b border-[var(--border-color)]">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-full bg-[var(--bg-primary)] border border-[var(--border-color)] overflow-hidden flex items-center justify-center shrink-0">
                  {avatarDataUrl ? (
                    <img src={avatarDataUrl} alt="头像" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-[13px] font-semibold text-[var(--accent)]">{initials(signature)}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)] truncate">
                    {signature}
                    {detailPost.isPinned && <span className="inline-flex items-center gap-1 text-[var(--accent)] text-[11px]"><Pin size={10} />置顶</span>}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] mt-0.5">
                    <Clock3 size={11} />
                    <span>{formatDateTime(detailPost.createdAt)}</span>
                    {detailPost.updatedAt !== detailPost.createdAt && <span>· 已编辑</span>}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setDetailPostId(null)}
                className="p-1 shrink-0 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors flex items-center justify-center"
                title="关闭"
              >
                <X size={15} />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="px-6 py-5">
                {renderTags(detailPost.tags || [])}
                <div className={`text-[15px] leading-8 text-[var(--text-primary)] break-words whitespace-pre-wrap ${(detailPost.tags || []).length > 0 ? 'mt-3' : ''}`}>
                  {detailPost.contentMd || stripHtmlTags(detailPost.contentHtml || '')}
                </div>

                {postImages(detailPost).urls.length > 0 && (() => {
                  const imgs = postImages(detailPost)
                  return (
                  <div className="mt-5">
                    {imgs.urls.length === 1 ? (
                      <img
                        src={imgs.urls[0]}
                        alt="说说图片"
                        onClick={() => setLightbox({ images: imgs.urls, index: 0 })}
                        className="max-w-[200px] max-h-[320px] w-auto h-auto object-contain rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] cursor-zoom-in"
                        loading="lazy"
                        title="点击放大查看"
                      />
                    ) : (
                      <div className="grid grid-cols-3 max-w-[360px] gap-1">
                        {imgs.urls.map((img, i) => (
                          <div
                            key={i}
                            onClick={() => setLightbox({ images: imgs.urls, index: i })}
                            className="relative aspect-square overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] cursor-zoom-in"
                            title="点击放大查看"
                          >
                            <img src={imgs.thumbs[i] || img} alt={`说说图片 ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {albumModal && (
        <div
          className="absolute inset-0 z-[60] bg-black/55 backdrop-blur-[3px] flex items-center justify-center p-5"
          onMouseDown={e => { if (e.target === e.currentTarget) setAlbumModal(null) }}
        >
          <div className="kb-modal-in w-full max-w-sm rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-[0_2px_12px_rgba(0,0,0,0.12)] overflow-hidden">
            <div className="px-4 h-11 flex items-center justify-between border-b border-[var(--border-color)]">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">
                {albumModal.mode === 'rename' ? '重命名相册' : albumModal.mode === 'pick' ? '加入相册' : '新建相册'}
              </span>
              <button onClick={() => setAlbumModal(null)} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors" title="关闭">
                <X size={15} />
              </button>
            </div>

            <div className="p-4">
              {albumModal.mode === 'pick' && (
                <>
                  {(() => {
                    const post = posts.find(p => p.id === albumModal.postId)
                    const currentAlbum = post?.albumId ? albums.find(a => a.id === post.albumId) : null
                    return currentAlbum ? (
                      <button
                        onClick={() => assignPostAlbum(albumModal.postId, '').catch(console.error)}
                        className="w-full flex items-center gap-2.5 px-2.5 py-2 mb-1 rounded-xl hover:bg-[var(--bg-hover)] transition-colors text-left text-[13px] text-[var(--danger)]"
                      >
                        <X size={15} />
                        移出相册（{currentAlbum.name}）
                      </button>
                    ) : null
                  })()}
                  <div className="max-h-56 overflow-y-auto space-y-1 mb-3">
                    {albums.length === 0 ? (
                      <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">暂无相册</div>
                    ) : (
                      albums.map(a => {
                        const current = posts.find(p => p.id === albumModal.postId)?.albumId === a.id
                        return (
                          <button
                            key={a.id}
                            onClick={() => assignPostAlbum(albumModal.postId, a.id).catch(console.error)}
                            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-[var(--bg-hover)] transition-colors text-left"
                          >
                            <span className="w-8 h-8 rounded-lg overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)] shrink-0">
                              {a.cover ? (
                                <img src={a.cover} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <span className="w-full h-full flex items-center justify-center text-[var(--text-muted)]"><Images size={14} /></span>
                              )}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-[13px] text-[var(--text-primary)] truncate">{a.name}</span>
                              <span className="block text-[11px] text-[var(--text-muted)]">{a.photoCount} 张</span>
                            </span>
                            {current && <Check size={15} className="text-[var(--accent)] shrink-0" />}
                          </button>
                        )
                      })
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={albumNameDraft}
                      onChange={e => setAlbumNameDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') confirmAlbumModal().catch(console.error) }}
                      placeholder="新相册名称..."
                      maxLength={20}
                      className="flex-1 min-w-0 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                    />
                    <button
                      onClick={() => { confirmAlbumModal().catch(console.error) }}
                      disabled={!albumNameDraft.trim()}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors"
                    >
                      新建并加入
                    </button>
                  </div>
                </>
              )}

              {(albumModal.mode === 'create' || albumModal.mode === 'rename') && (
                <div className="space-y-3">
                  <input
                    autoFocus
                    value={albumNameDraft}
                    onChange={e => setAlbumNameDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') confirmAlbumModal().catch(console.error) }}
                    placeholder={albumModal.mode === 'rename' ? '输入新的相册名称' : '输入相册名称，例如：旅行、日常'}
                    maxLength={20}
                    className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
                  />
                  <div className="flex justify-end gap-1">
                    <button onClick={() => setAlbumModal(null)} className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                      取消
                    </button>
                    <button
                      onClick={() => { confirmAlbumModal().catch(console.error) }}
                      disabled={!albumNameDraft.trim()}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors"
                    >
                      {albumModal.mode === 'rename' ? '保存' : '创建'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {albumPhotoConfirm && (
        <div
          className="absolute inset-0 z-[60] bg-black/55 backdrop-blur-[3px] flex items-center justify-center p-5"
          onMouseDown={e => { if (e.target === e.currentTarget) void cancelAlbumPhotoConfirm() }}
        >
          <div className="kb-modal-in w-full max-w-sm rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-[0_2px_12px_rgba(0,0,0,0.12)] overflow-hidden">
            <div className="px-4 h-11 flex items-center justify-between border-b border-[var(--border-color)]">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">添加照片到相册</span>
              <button onClick={() => void cancelAlbumPhotoConfirm()} className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors" title="关闭">
                <X size={15} />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div className="flex items-center gap-1.5">
                {albumPhotoConfirm.slice(0, 6).map((a, i) => (
                  <img key={i} src={a.thumbUrl} alt="" className="w-11 h-11 rounded-lg object-cover border border-[var(--border-color)]" />
                ))}
                {albumPhotoConfirm.length > 6 && (
                  <span className="w-11 h-11 rounded-lg border border-dashed border-[var(--border-color)] flex items-center justify-center text-[12px] text-[var(--text-muted)] shrink-0">
                    +{albumPhotoConfirm.length - 6}
                  </span>
                )}
              </div>

              <p className="text-[12px] text-[var(--text-secondary)]">
                将 {albumPhotoConfirm.length} 张照片添加到「{selectedAlbum?.name || ''}」？
              </p>

              <label className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={albumPhotoShowTimeline}
                  onChange={e => setAlbumPhotoShowTimeline(e.target.checked)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-[13px] text-[var(--text-primary)]">同时显示在时间线</span>
                  <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">之后也可在相册或时间线中随时切换</span>
                </span>
              </label>
            </div>

            <div className="px-4 py-2.5 border-t border-[var(--border-color)] flex justify-end gap-1">
              <button onClick={() => void cancelAlbumPhotoConfirm()} className="px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                取消
              </button>
              <button
                onClick={() => void confirmAlbumPhotos()}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
              >
                确认添加
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <div
          className="absolute inset-0 z-[70] bg-black/90 backdrop-blur-sm flex items-center justify-center select-none"
          onMouseDown={e => { if (e.target === e.currentTarget) setLightbox(null) }}
        >
          {lightbox.images.length > 1 && (
            <button
              onClick={() => setLightbox(l => l ? { ...l, index: (l.index - 1 + l.images.length) % l.images.length } : l)}
              className="absolute left-5 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 text-white hover:bg-white/25 flex items-center justify-center transition-colors"
              title="上一张"
            >
              <ChevronLeft size={22} />
            </button>
          )}

          <img
            src={lightbox.images[lightbox.index]}
            alt="图片预览"
            className="kb-modal-in max-w-[88%] max-h-[88%] object-contain rounded-lg shadow-2xl"
          />

          {lightbox.images.length > 1 && (
            <button
              onClick={() => setLightbox(l => l ? { ...l, index: (l.index + 1) % l.images.length } : l)}
              className="absolute right-5 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 text-white hover:bg-white/25 flex items-center justify-center transition-colors"
              title="下一张"
            >
              <ChevronRight size={22} />
            </button>
          )}

          <button
            onClick={() => {
              void copyImageUrlToClipboard(lightbox.images[lightbox.index]).then(ok => {
                showToast({ type: ok ? 'info' : 'error', message: ok ? '图片已复制到剪贴板' : '复制失败' })
              })
            }}
            className="absolute right-16 top-5 px-3 h-10 rounded-full bg-white/10 text-white hover:bg-white/25 flex items-center gap-1.5 transition-colors"
            title="复制图片"
          >
            <Copy size={16} />
            复制
          </button>

          <button
            onClick={() => setLightbox(null)}
            className="absolute right-5 top-5 w-10 h-10 rounded-full bg-white/10 text-white hover:bg-white/25 flex items-center justify-center transition-colors"
            title="关闭"
          >
            <X size={18} />
          </button>

          {lightbox.images.length > 1 && (
            <span className="absolute bottom-5 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-white/10 text-white text-[12px]">
              {lightbox.index + 1} / {lightbox.images.length}
            </span>
          )}
        </div>
      )}

      <input ref={albumPhotoInputRef} type="file" accept="image/*,.heic,.heif" multiple className="hidden" onChange={() => { handlePickAlbumPhotos().catch(console.error) }} />

      <ConfirmDialog
        open={!!confirmDeleteId}
        title="删除说说"
        message="删除后会进入回收站，之后仍可恢复。"
        confirmLabel="删除"
        showCheckbox={false}
        onConfirm={() => { handleDelete().catch(console.error) }}
        onCancel={() => setConfirmDeleteId(null)}
      />

      <ConfirmDialog
        open={!!albumDeleteConfirm}
        title="删除相册"
        message={`删除相册「${albumDeleteConfirm?.name || ''}」后，其中的说说会保留在时间线，只是不再归入该相册。`}
        confirmLabel="删除"
        showCheckbox={false}
        onConfirm={() => { if (albumDeleteConfirm) handleDeleteAlbum(albumDeleteConfirm).catch(console.error) }}
        onCancel={() => setAlbumDeleteConfirm(null)}
      />
    </div>
  )
}
