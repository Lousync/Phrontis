/**
 * 右侧活动栏 · 笔记页签（D1：会话内速记 / 会话文件就地编辑）。
 *
 * 一个笔记页签 = 一个文件（壳按 relPath 去重，见 `viewerTabs.findNotesTab`）。
 *   普通笔记       `fileKind='note'`        写盘 `workspaceWriteFile` + `expectedMtimeMs`
 *   会话画像       `fileKind='profile'`     写盘 `aiTeachProfileWriteSession` + `expectedMtimeMs`
 *   会话要求       `fileKind='constraints'` 写盘 `aiTeachWriteConstraints` + `expectedMtimeMs`
 * 后两条**必须**走专用通道：结课后这两份文件只读（`assertCourseEditableBySession`），
 * 裸用 `workspaceWriteFile` 会绕过产品规则、也不会 `broadcastTreeRefresh`。
 *
 * 保存口径仍与 `PageEditor` 同一条（1s 防抖 + 打开时记 mtime 基线 + 冲突检测），
 * 与它唯一的差别：**冲突时保留用户输入**，只把基线刷新成磁盘现状 —— 本页签是速记面，
 * 输入不该被静默丢掉；是否覆盖磁盘由用户在行内条上选（保存态三态见 `saveStateLabel`）。
 *
 * 保活 / 关闭纪律：脏页签上报 `onDirtyChange`（壳据此不淘汰它）；关页签前壳会 await
 * `registerFlush` 注册的 flush，冲突未决时 flush 返回 false，壳拦住关闭。
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Copy, ExternalLink, Eye, FileText, List, Pencil, Plus, Search, User, X } from 'lucide-react'
import type { NotesPaneProps } from './paneContracts'
import {
  isNoteFile,
  mergeSaveResult,
  noteNameOf,
  pickNoteFiles,
  relativeTime,
  saveStateLabel,
  type NoteFileRef,
  type NoteSaveState,
} from './notesPanePure'
import { createSessionNote } from './noteFileOps'
import { noteTabTitle, baseName, type NotesFileKind } from './viewerTabs'
import {
  aiTeachProfileWriteSession,
  aiTeachSessionFolder,
  aiTeachWriteConstraints,
  getSetting,
  onAiTeachTreeRefresh,
  onWsExternalChange,
  workspaceListDir,
  workspaceReadFile,
  workspaceStat,
  workspaceWriteFile,
} from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { showToast } from '../../../lib/toast'
import { MarkdownPreview } from '../../../components/shared/MarkdownPreview'
import { QuizRecordContext, useQuizRecordStore } from '../../../components/shared/QuizRecordStore'
import { QuizSheetBar } from '../../../components/shared/QuizSheetBar'
import { extractQuizzes } from '../../../components/shared/QuizParser'
import type { PaneDoc } from '../../../components/shared/NoteSurface'
import type { NoteEngineId } from '../../../lib/noteEngine'

/**
 * 写作面是重依赖（NoteSurface → Monaco / CodeMirror），必须 lazy（铁律 20）：
 * 笔记页签没被切到时不下载编辑器 chunk。契约脚本断言这里出现 `lazy(`。
 */
const NoteSurfaceLazy = lazy(() =>
  import('../../../components/shared/NoteSurface').then((m) => ({ default: m.NoteSurface })),
)

const SAVE_DEBOUNCE_MS = 1000
const NOTE_LIMIT = 12
const NARROW_WIDTH = 420

interface OpenNote {
  rootId: string
  relPath: string
  /** 编辑器里的最新文本（可能尚未落盘） */
  text: string
  /** 最近一次成功落盘 / 从磁盘读到的文本（脏标记的唯一判据） */
  savedText: string
  /** 冲突检测基线（毫秒）；0 = 没有基线（文件曾经不存在） */
  mtimeMs: number
  fileKind: NotesFileKind
  /** 画像 / 要求所属会话：写盘按它走，不按当前 `sessionId` */
  ownerSessionId: string | null
}

/** 仓库相对路径拼接：会话夹与 `产物/` 一律用 `/`（主进程侧再归一） */
function joinRel(dir: string, name: string): string {
  const d = (dir || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return d ? `${d}/${name}` : name
}

function clockLabel(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function makeDoc(relPath: string, content: string): PaneDoc {
  return {
    relPath,
    // 命名空间隔离：与知识库 / 编辑器模块的同名文件各持一份 Monaco model，避免互相灌内容
    modelPath: `aiteach://notes/${relPath}`,
    content,
    language: /\.md$/i.test(relPath) ? 'markdown' : 'plaintext',
    binary: false,
    editable: true,
    truncated: false,
    size: content.length,
  }
}

function normalizeRel(rel: string): string {
  return String(rel ?? '').replace(/\\/g, '/')
}

export function NotesPane(props: NotesPaneProps) {
  const {
    rootId, sessionId, width, active, open, request,
    initialRelPath, fileKind, ownerSessionId, displayName, initialPreview,
    onOpenInEditor, onDirtyChange, onTitleChange, onRelPathChange,
    registerFlush, onRequestOpenNote, onRequestNewNote,
  } = props

  const kind: NotesFileKind = fileKind === 'profile' || fileKind === 'constraints' ? fileKind : 'note'
  const isSessionDoc = kind !== 'note'

  const [folder, setFolder] = useState<string | null>(null)
  const [files, setFiles] = useState<NoteFileRef[]>([])
  const [currentRel, setCurrentRel] = useState('')
  const [doc, setDoc] = useState<PaneDoc | null>(null)
  const [saveState, setSaveState] = useState<NoteSaveState>('clean')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [preview, setPreview] = useState(() => !!initialPreview && /\.md$/i.test(initialRelPath ?? ''))
  const [mode, setMode] = useState<NoteEngineId>('source')
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [listOpen, setListOpen] = useState(true)
  const [loadingRel, setLoadingRel] = useState<string | null>(null)

  const openRef = useRef<OpenNote | null>(null)
  const pendingOpenRef = useRef('')
  const aliveRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rescanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 写盘串行队列：切文件 / 切会话必须等前一次写盘结束，否则 in-flight 那段文字随 openRef 一起被换掉 */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const scanSeqRef = useRef(0)
  const openSeqRef = useRef(0)
  /** 冲突未决（flush 判据；state 是给界面用的，ref 是给异步闭包用的） */
  const conflictRef = useRef(false)
  const dirtyCbRef = useRef(onDirtyChange)
  dirtyCbRef.current = onDirtyChange
  const titleCbRef = useRef(onTitleChange)
  titleCbRef.current = onTitleChange
  const relCbRef = useRef(onRelPathChange)
  relCbRef.current = onRelPathChange
  /** 已上报过的身份（避免每次渲染都回调壳、把壳推进重渲染环） */
  const reportedRef = useRef('')
  /**
   * 「这份文件进来时默认进预览」的意图（方案 §8.1）。
   * 只靠 state 初值不够：读盘完成后的 `openFile` 会把 preview 重置成编辑态，
   * 挂在 effect 之后必然把初值冲掉。这里按「路径 + 是否预览」记意图，
   * 由 openFile 在真正拿到内容时判定一次；同页签内再换文件就回到编辑。
   */
  const previewIntentRef = useRef({
    preview: !!initialPreview,
    relPath: normalizeRel(initialRelPath ?? ''),
  })
  previewIntentRef.current = {
    preview: !!initialPreview,
    relPath: normalizeRel(initialRelPath ?? ''),
  }

  const narrow = width > 0 && width < NARROW_WIDTH

  /* ------------------------------------------------------------ 题单 */

  // 预览态作答：与知识库阅读态 / 旧工件栏共用同一份答题痕迹（只有 relPath，store 反查 pageId）。
  // 画像 / 要求不是知识页，不挂题单；非 .md 也没有题单围栏。
  const quizRel = kind === 'note' && /\.md$/i.test(currentRel) ? currentRel : ''
  const quizStore = useQuizRecordStore({ relPath: quizRel, pageTitle: baseName(quizRel) })
  // 只在预览态解析题单围栏：编辑时每次击键都会换 doc.content，对长题单反复 parse 会掉帧
  const quizzes = useMemo(
    () => (preview && quizRel ? extractQuizzes(doc?.content ?? '') : []),
    [preview, quizRel, doc?.content],
  )

  const setConflictState = useCallback((v: boolean) => {
    conflictRef.current = v
    if (aliveRef.current) setConflict(v)
  }, [])

  /* ------------------------------------------------------------ 保存 */

  /** 按 fileKind 选写盘通道（会话文件绝不裸用 workspaceWriteFile） */
  const writeBody = useCallback(async (
    cur: OpenNote,
    body: string,
  ): Promise<{ ok: boolean; mtimeMs?: number; conflict?: boolean; error?: string }> => {
    const expectedMtimeMs = cur.mtimeMs > 0 ? cur.mtimeMs : undefined
    const opts = expectedMtimeMs !== undefined ? { expectedMtimeMs } : undefined
    if (cur.fileKind === 'note') {
      const r = await workspaceWriteFile(cur.rootId, cur.relPath, body, expectedMtimeMs).catch(() => null)
      return r ? { ok: !!r.ok, mtimeMs: r.mtimeMs, conflict: r.conflict, error: r.error } : { ok: false }
    }
    const owner = cur.ownerSessionId || sessionId
    if (!owner) return { ok: false, error: '会话文件缺少所属会话，无法保存' }
    const r = cur.fileKind === 'profile'
      ? await aiTeachProfileWriteSession(owner, body, opts).catch(() => null)
      : await aiTeachWriteConstraints(owner, body, opts).catch(() => null)
    return r ? { ok: !!r.ok, mtimeMs: r.mtimeMs, conflict: r.conflict, error: r.error } : { ok: false }
  }, [sessionId])

  const saveNow = useCallback((): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const run = async (): Promise<void> => {
      // 执行时才读 openRef：队列里的这一笔永远写「轮到时」的那份缓冲
      const cur = openRef.current
      if (!cur || cur.text === cur.savedText) return
      if (aliveRef.current) setSaveState('saving')

      const body = cur.text
      const res = await writeBody(cur, body)
      const merged = mergeSaveResult(
        { mtimeMs: cur.mtimeMs },
        res ? { ok: !!res.ok, mtimeMs: res.mtimeMs, conflict: res.conflict } : { ok: false },
      )

      if (merged.state === 'conflict') {
        // 磁盘被外部改过。与 PageEditor 的「放弃本地并重读」不同：这里保留用户输入，
        // 只把基线刷新为磁盘当前 mtime；用户继续编辑后下一次保存才会覆盖磁盘版本，
        // 或者在行内条上显式选「重新载入」。
        const disk = await workspaceReadFile(cur.rootId, cur.relPath).catch(() => null)
        if (openRef.current === cur) {
          if (disk && !disk.error && typeof disk.mtimeMs === 'number' && disk.mtimeMs > 0) {
            cur.mtimeMs = disk.mtimeMs
          }
          setConflictState(true)
          if (aliveRef.current) {
            setSaveState('conflict')
            showToast({
              type: 'warning',
              message: '文件已被外部修改',
              detail: '你写的版本仍保留在这里；选「保留我的版本」写盘，或「重新载入」丢弃本地改动',
            })
          }
        }
        return
      }

      if (merged.state === 'saved') {
        if (typeof merged.mtimeMs === 'number' && merged.mtimeMs > 0) cur.mtimeMs = merged.mtimeMs
        cur.savedText = body
        if (openRef.current === cur && cur.text === body) {
          if (aliveRef.current) {
            setSaveState('saved')
            setSavedAt(clockLabel(Date.now()))
            setDirty(false)
            setConflictState(false)
          }
        } else if (aliveRef.current) {
          setSaveState('dirty')
        }
        return
      }

      if (aliveRef.current) {
        showToast({ type: 'error', message: '保存失败，请重试', detail: res?.error })
        setSaveState('dirty')
      }
    }
    const next = saveChainRef.current.then(run, run)
    saveChainRef.current = next.catch(() => {
      /* 单笔失败不阻断后续保存；错误已在 run 里 Toast 过 */
    })
    return next
  }, [writeBody, setConflictState])

  const scheduleSave = useCallback(
    (value: string) => {
      const cur = openRef.current
      if (!cur) return
      cur.text = value
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void saveNow()
      }, SAVE_DEBOUNCE_MS)
    },
    [saveNow],
  )

  /**
   * 关闭前 flush（壳在关页签时 await）：
   * 写一次 → 只有「已经把缓冲全部落盘且没有未决冲突」才允许关。
   */
  useEffect(() => {
    if (!registerFlush) return
    registerFlush(async () => {
      await saveNow()
      const cur = openRef.current
      const clean = !cur || cur.text === cur.savedText
      return clean && !conflictRef.current
    })
    return () => registerFlush(null)
  }, [registerFlush, saveNow])

  /* ------------------------------------------------------------ 打开文件 */

  const openFile = useCallback(
    async (relPath: string) => {
      if (!rootId || !relPath) return
      const target = normalizeRel(relPath)
      pendingOpenRef.current = target
      setLoadingRel(target)
      const seq = ++openSeqRef.current
      await saveNow()
      if (seq !== openSeqRef.current) return
      // 读盘期间先卸掉编辑器：避免用户在这几毫秒里继续敲字、随后被新文件覆盖
      setDoc(null)
      const res = await workspaceReadFile(rootId, target).catch(() => null)
      if (seq !== openSeqRef.current) return
      pendingOpenRef.current = ''
      setLoadingRel(null)
      if (!res || res.error || typeof res.content !== 'string' || res.binary) {
        showToast({
          type: 'error',
          message: res?.binary ? '该文件不是文本，无法在这里编辑' : '无法打开这篇笔记',
          detail: res?.error,
        })
        // 打开失败：回到上一份缓冲，别把界面留在「列表高亮旧文件、编辑区却空着」的状态
        const prev = openRef.current
        if (prev) setDoc(makeDoc(prev.relPath, prev.text))
        return
      }
      const text = res.content
      openRef.current = {
        rootId,
        relPath: target,
        text,
        savedText: text,
        mtimeMs: typeof res.mtimeMs === 'number' && res.mtimeMs > 0 ? res.mtimeMs : 0,
        fileKind: kind,
        ownerSessionId: kind === 'note' ? null : (ownerSessionId || sessionId || null),
      }
      setDoc(makeDoc(target, text))
      setCurrentRel(target)
      setDirty(false)
      setConflictState(false)
      setSaveState('clean')
      setSavedAt(null)
      // 文件树 / 素材点开的这一份默认进预览（仅 .md）；同页签内换文件回到编辑
      setPreview(
        previewIntentRef.current.preview
        && previewIntentRef.current.relPath === target
        && /\.md$/i.test(target),
      )
      // 身份上报：空 relPath 起家的页签靠这里补上文件身份（壳据此去重 / 持久化）
      if (reportedRef.current !== target) {
        reportedRef.current = target
        relCbRef.current?.(target)
        // 普通笔记按真实文件名报（壳给的 title 只是兜底）；画像 / 要求用人话
        titleCbRef.current?.(kind === 'note' ? noteTabTitle(target, kind) : (displayName || noteTabTitle(target, kind)))
      }
    },
    [rootId, saveNow, kind, ownerSessionId, sessionId, displayName, setConflictState],
  )

  /* ------------------------------------------------------------ 列表 */

  const scan = useCallback(async () => {
    const seq = ++scanSeqRef.current
    if (!rootId || !sessionId) {
      setFolder(null)
      setFiles([])
      return
    }
    const folderRes = await aiTeachSessionFolder(sessionId).catch(() => null)
    if (seq !== scanSeqRef.current) return
    const folderRel = folderRes?.ok && folderRes.relPath ? normalizeRel(folderRes.relPath) : null
    setFolder(folderRel)
    if (!folderRel) {
      setFiles([])
      return
    }
    const dirs = [folderRel, joinRel(folderRel, '产物')]
    const collected: NoteFileRef[] = []
    for (const dir of dirs) {
      const listed = await workspaceListDir(rootId, dir).catch(() => null)
      if (seq !== scanSeqRef.current) return
      const entries = (listed?.entries ?? [])
        .filter((e) => e.type === 'file' && isNoteFile(e.name))
        .slice(0, 24)
      // 列表已经带 mtime；再用 workspaceStat 校正一次（外部写入后目录缓存可能滞后）
      const rows = await Promise.all(
        entries.map(async (e): Promise<NoteFileRef> => {
          const relPath = joinRel(dir, e.name)
          const st = await workspaceStat(rootId, relPath).catch(() => null)
          const m = st && !st.error && st.mtime > 0 ? st.mtime : e.mtime
          return { relPath, mtimeMs: typeof m === 'number' && m > 0 ? m : 0 }
        }),
      )
      if (seq !== scanSeqRef.current) return
      collected.push(...rows)
    }
    const picked = pickNoteFiles(collected, NOTE_LIMIT)
    setFiles(picked)
    // 空页签（没有指定文件）落到最近改过的一篇；有指定文件时由 reset 直接开，不在这里抢
    if (!openRef.current && !pendingOpenRef.current && picked.length > 0) void openFile(picked[0].relPath)
  }, [rootId, sessionId, openFile])

  const scheduleRescan = useCallback(() => {
    if (rescanTimerRef.current) clearTimeout(rescanTimerRef.current)
    rescanTimerRef.current = setTimeout(() => {
      rescanTimerRef.current = null
      void scan()
    }, 300)
  }, [scan])

  /* ------------------------------------------------------------ 新建笔记 */

  /** 走壳（一个文件一个页签）；壳没接这个出口时退回到本实例内开新文件 */
  const createNote = useCallback(async () => {
    if (onRequestNewNote) {
      onRequestNewNote()
      return
    }
    const made = await createSessionNote(rootId, sessionId)
    if (!made.ok) {
      showToast({ type: 'error', message: '新建笔记失败', detail: made.error })
      return
    }
    await scan()
    await openFile(made.relPath)
    setSearch('')
    setSearchOpen(false)
    setPreview(false)
  }, [onRequestNewNote, rootId, sessionId, scan, openFile])

  /* ------------------------------------------------------------ 输入 */

  const handleChange = useCallback(
    (relPath: string, value: string) => {
      const cur = openRef.current
      // 迟到的旧引擎回调不能污染刚切过来的文件
      if (!cur || cur.relPath !== normalizeRel(relPath) || value === cur.text) return
      cur.text = value
      setDoc((d) => (d && d.relPath === cur.relPath ? { ...d, content: value, size: value.length } : d))
      if (!dirty) setDirty(true)
      setSaveState('dirty')
      scheduleSave(value)
    },
    [dirty, scheduleSave],
  )

  /* ------------------------------------------------------------ 冲突 / 只读条 */

  /** 保留我的版本：基线已刷新成磁盘现状，直接再写一次 */
  const keepMine = useCallback(() => {
    setConflictState(false)
    setSaveState('dirty')
    void saveNow()
  }, [saveNow, setConflictState])

  /** 重新载入：丢弃本地改动，读磁盘版本 */
  const reloadFromDisk = useCallback(async () => {
    const cur = openRef.current
    if (!cur) return
    const res = await workspaceReadFile(cur.rootId, cur.relPath).catch(() => null)
    if (!res || res.error || typeof res.content !== 'string') {
      showToast({ type: 'error', message: '重新载入失败', detail: res?.error })
      return
    }
    cur.text = res.content
    cur.savedText = res.content
    cur.mtimeMs = typeof res.mtimeMs === 'number' && res.mtimeMs > 0 ? res.mtimeMs : 0
    setDoc(makeDoc(cur.relPath, res.content))
    setDirty(false)
    setConflictState(false)
    setSaveState('clean')
    setSavedAt(null)
  }, [setConflictState])

  /* ------------------------------------------------------------ 设置 */

  const loadMode = useCallback(() => {
    void getSetting('editorWritingMode')
      .then((v) => {
        if (aliveRef.current) setMode(v === 'live' ? 'live' : 'source')
      })
      .catch(() => {
        /* 读不到设置就保持源码档：能编辑比「选哪档」重要 */
      })
  }, [])

  useEffect(() => {
    loadMode()
  }, [loadMode])
  useDataChanged('settings', loadMode)

  /* ------------------------------------------------------------ 打开目标 / 切换会话：先落盘再重置 */

  useEffect(() => {
    let cancelled = false
    const reset = async () => {
      const target = normalizeRel(initialRelPath ?? '')
      // 壳把 relPath 回填之后会带着同一个值再跑一次 —— 已经开着就别再读一遍盘
      if (target && openRef.current?.rootId === rootId && openRef.current?.relPath === target) {
        if (kind === 'note') await scan()
        return
      }
      await saveNow()
      if (cancelled) return
      openRef.current = null
      pendingOpenRef.current = ''
      setDoc(null)
      setCurrentRel('')
      setDirty(false)
      setConflictState(false)
      setSaveState('clean')
      setSavedAt(null)
      setPreview(false)
      setSearch('')
      setLoadingRel(null)
      if (target) {
        await openFile(target)
        if (cancelled) return
      }
      // 会话文件的文件列表没有意义（一个文件一个页签），只扫普通笔记
      if (kind === 'note') await scan()
    }
    void reset()
    return () => {
      cancelled = true
    }
  }, [rootId, sessionId, initialRelPath, kind, scan, saveNow, openFile, setConflictState])

  // 切页签 / 关面板时落盘一次（失败只 Toast，由 saveNow 内部兜住，不阻塞切换）
  useEffect(() => {
    if (!active || !open) void saveNow()
  }, [active, open, saveNow])

  // 卸载前最后一次 flush（组件已不在，仍要写盘）
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
      void saveNow()
    }
  }, [saveNow])

  // 外部写入 / 程序落盘后重扫列表（去抖 300ms）。
  // 注意：`DataChangeScope`（src/lib/dataChanged.ts）没有 'workspace' 这个作用域，
  // 因此文件侧走三条现成通道，而不是伪造一个不存在的 scope。
  useDataChanged('knowledge', scheduleRescan)
  useEffect(() => {
    const onSaved = () => scheduleRescan()
    const offTree = onAiTeachTreeRefresh(() => scheduleRescan())
    const offExternal = onWsExternalChange(() => scheduleRescan())
    window.addEventListener('kb:file-saved', onSaved)
    return () => {
      window.removeEventListener('kb:file-saved', onSaved)
      offTree?.()
      offExternal?.()
    }
  }, [scheduleRescan])

  useEffect(() => {
    dirtyCbRef.current?.(dirty)
  }, [dirty])

  // 壳的「请打开这个文件」请求（老入口兼容）：路径不必在列表里
  const requestSeq = request?.seq
  useEffect(() => {
    const rel = request?.relPath
    if (!rel || !rootId) return
    if (!isNoteFile(rel)) {
      showToast({ type: 'info', message: '笔记页签只能打开 md / txt', detail: rel })
      return
    }
    void openFile(rel)
    // request 对象身份不稳定，按 seq + 路径变化触发
  }, [requestSeq, request?.relPath, rootId, openFile])

  /* ------------------------------------------------------------ 派生 */

  const now = Date.now()
  const query = search.trim().toLowerCase()
  const rows = useMemo(() => {
    const list = query
      ? files.filter(
          (f) => noteNameOf(f.relPath).toLowerCase().includes(query) || f.relPath.toLowerCase().includes(query),
        )
      : files.slice()
    const inList = list.some((f) => f.relPath === currentRel)
    if (currentRel && !inList) {
      const matches = !query || noteNameOf(currentRel).toLowerCase().includes(query) || currentRel.toLowerCase().includes(query)
      // 从外面点进来的文件不在会话夹内：钉在列表顶部，别让它「打开着却看不见」
      if (matches) list.unshift({ relPath: currentRel, mtimeMs: 0 })
    }
    return list
  }, [files, query, currentRel])

  const canPreview = /\.md$/i.test(currentRel)
  const saveLabel = saveStateLabel(saveState, savedAt ?? undefined)
  const statusClass =
    saveState === 'conflict'
      ? 'text-[var(--danger)]'
      : saveState === 'dirty'
        ? 'text-[var(--warning)]'
        : saveState === 'saving'
          ? 'text-[var(--text-secondary)]'
          : 'text-[var(--text-muted)]'
  const fileIcon = kind === 'profile'
    ? <User size={12} />
    : kind === 'constraints'
      ? <List size={12} />
      : <FileText size={12} />

  /* ------------------------------------------------------------ 空态 */

  if (!rootId) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="kb-view-fade w-full max-w-[320px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-5 text-center text-[13px] text-[var(--text-primary)]">
          先打开一个仓库
        </div>
      </div>
    )
  }

  // 会话文件（画像 / 要求）必须挂在会话上；普通笔记 / 文件页签只需要仓库
  if (isSessionDoc && !sessionId) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="kb-view-fade w-full max-w-[320px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-5 text-center text-[13px] text-[var(--text-primary)]">
          先进入一个 AI 教学对话
        </div>
      </div>
    )
  }

  const hasSession = !!sessionId
  const showList = !isSessionDoc && hasSession && (!narrow || listOpen)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 动作行：32px，只放动作与当前文件，不另加标题 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-1.5">
        {!isSessionDoc && hasSession && narrow && (
          <button
            onClick={() => setListOpen((v) => !v)}
            data-tip={listOpen ? '收起笔记列表' : '展开笔记列表'}
            aria-label={listOpen ? '收起笔记列表' : '展开笔记列表'}
            aria-expanded={listOpen}
            className="kb-press shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ChevronDown size={13} className={`kb-chevron ${listOpen ? 'rotate-180' : ''}`} />
          </button>
        )}
        {!isSessionDoc && hasSession && (
          <button
            onClick={() => void createNote()}
            data-tip="在会话文件夹的 产物/ 下新建一篇笔记"
            aria-label="新建笔记"
            className="kb-press kb-micro-pop shrink-0 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Plus size={12} />
            {!narrow && <span>新建笔记</span>}
          </button>
        )}

        {isSessionDoc ? (
          /* 会话文件：文件身份常显（320px 下也不只剩一个图标） */
          <span
            className="flex min-w-0 items-center gap-1 text-[11.5px] text-[var(--text-primary)]"
            data-tip={currentRel}
            aria-label={currentRel}
          >
            <span className="shrink-0 text-[var(--text-muted)]">{fileIcon}</span>
            <span className="min-w-0 max-w-[46%] truncate">{currentRel ? baseName(currentRel) : noteTabTitle('', kind)}</span>
          </span>
        ) : !hasSession ? (
          <span
            className="flex min-w-0 items-center gap-1 text-[11.5px] text-[var(--text-primary)]"
            data-tip={currentRel}
            aria-label={currentRel}
          >
            <span className="shrink-0 text-[var(--text-muted)]"><FileText size={12} /></span>
            <span className="min-w-0 truncate">{currentRel ? baseName(currentRel) : '笔记'}</span>
          </span>
        ) : narrow && !searchOpen ? (
          <button
            onClick={() => setSearchOpen(true)}
            data-tip="搜索笔记"
            aria-label="搜索笔记"
            className="kb-press shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Search size={13} />
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1 rounded-md bg-[var(--input-bg)] px-1.5 py-0.5">
            <Search size={11} className="shrink-0 text-[var(--text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索"
              aria-label="搜索笔记"
              className={`kb-field-control min-w-0 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] ${narrow ? 'w-[90px]' : 'w-[130px]'}`}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                data-tip="清空搜索"
                aria-label="清空搜索"
                className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X size={10} />
              </button>
            )}
            {narrow && (
              <button
                onClick={() => {
                  setSearch('')
                  setSearchOpen(false)
                }}
                data-tip="关闭搜索"
                aria-label="关闭搜索"
                className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X size={10} />
              </button>
            )}
          </span>
        )}

        <span className="min-w-0 flex-1" />

        {currentRel && (
          <>
            {canPreview && (
              <button
                onClick={() => setPreview((v) => !v)}
                data-tip={preview ? '回到编辑' : '预览渲染结果'}
                aria-label={preview ? '回到编辑' : '预览'}
                aria-pressed={preview}
                className="kb-press shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                {preview ? <Pencil size={12} /> : <Eye size={12} />}
              </button>
            )}
            <button
              onClick={() => onOpenInEditor(currentRel)}
              data-tip="在编辑器中打开（正式编辑入口）"
              aria-label="在编辑器中打开"
              className="kb-press shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <ExternalLink size={12} />
            </button>
            <button
              onClick={() => {
                void navigator.clipboard
                  .writeText(currentRel)
                  .then(() => showToast({ type: 'info', message: '已复制路径' }))
                  .catch(() => {
                    /* 剪贴板不可用时静默：这是辅助动作，不该打断记笔记 */
                  })
              }}
              data-tip="复制仓库相对路径"
              aria-label="复制路径"
              className="kb-press shrink-0 rounded-md p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Copy size={12} />
            </button>
            {!isSessionDoc && (
              <span
                className="min-w-0 max-w-[40%] truncate text-[11.5px] text-[var(--text-primary)]"
                data-tip={currentRel}
                aria-label={currentRel}
              >
                {noteNameOf(currentRel)}
              </span>
            )}
            <span className={`shrink-0 whitespace-nowrap text-[10.5px] tabular-nums ${statusClass}`} aria-live="polite">
              {saveLabel}
            </span>
          </>
        )}
      </div>

      {/* 冲突：行内条（不弹模态，不遮挡正文）——铁律 25 */}
      {conflict && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--danger)]/40 bg-[var(--bg-secondary)] px-2 py-1">
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--danger)]">文件已被外部修改，你的版本仍在这里</span>
          <button
            onClick={keepMine}
            className="kb-press shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            保留我的版本
          </button>
          <button
            onClick={() => void reloadFromDisk()}
            className="kb-press shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            重新载入
          </button>
        </div>
      )}

      {/* 文件列表：最近修改倒序，最多 12 条（会话文件没有列表） */}
      {showList && (
        <div className="kb-view-fade max-h-[40%] shrink-0 overflow-y-auto border-b border-[var(--border-color)]">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
              <div className="text-[12px] text-[var(--text-muted)]">
                {query ? '没有匹配的笔记' : '这个对话还没有笔记'}
              </div>
              {!query && (
                <button
                  onClick={() => void createNote()}
                  className="kb-press rounded-md border border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  新建笔记
                </button>
              )}
            </div>
          ) : (
            rows.map((f) => {
              const isCurrent = f.relPath === currentRel
              return (
                <button
                  key={f.relPath}
                  onClick={() => {
                    // 一个页签 = 一个文件：点列表交给壳去重 / 开新页签，不在这里换文件
                    if (onRequestOpenNote) onRequestOpenNote(f.relPath)
                    else void openFile(f.relPath)
                    if (narrow) setListOpen(false)
                  }}
                  data-tip={f.relPath}
                  aria-label={f.relPath}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`kb-item-in flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] transition-colors ${
                    isCurrent
                      ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <FileText size={12} className="shrink-0 opacity-60" />
                  <span className="min-w-0 flex-1 truncate">{noteNameOf(f.relPath)}</span>
                  {loadingRel === f.relPath ? (
                    <span className="kb-spin" aria-label="打开中" />
                  ) : (
                    <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">
                      {relativeTime(now, f.mtimeMs)}
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
      )}

      {/* 编辑 / 预览 */}
      <div className="relative min-h-0 flex-1">
        {doc ? (
          preview && canPreview ? (
            <div key="preview" className="kb-view-fade h-full overflow-y-auto">
              <div className="mx-auto max-w-[820px] px-4 py-3">
                <QuizRecordContext.Provider value={quizStore}>
                  {/* 题单条与知识库阅读态同一条组件；本页签没有题单内「错题重做」视图，故不传 onReview */}
                  {quizzes.length > 0 && <QuizSheetBar quizzes={quizzes} store={quizStore} />}
                  <MarkdownPreview content={doc.content} />
                </QuizRecordContext.Provider>
              </div>
            </div>
          ) : (
            <div key="edit" className="kb-view-fade h-full">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">
                    编辑器加载中…
                  </div>
                }
              >
                <NoteSurfaceLazy doc={doc} mode={mode} onChange={handleChange} />
              </Suspense>
            </div>
          )
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[var(--text-muted)]">
            {loadingRel ? '打开中…' : isSessionDoc ? '文件还没有创建' : '从上面选一篇笔记开始记'}
          </div>
        )}
      </div>
    </div>
  )
}
