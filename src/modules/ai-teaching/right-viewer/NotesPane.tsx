/**
 * 右侧查看器 · 笔记页签（D1：会话内速记，可编辑）。
 *
 * 三个区域：32px 动作行 / 文件列表 / 编辑·预览。
 * 数据只有两处来源：会话文件夹本身与它下面的 `产物/`（F11 拍平后的产物落点）。
 *
 * 保存口径照 `src/modules/knowledge/components/PageEditor.tsx`（:994-1069）抄，不自创：
 *   · 写盘走 `workspaceWriteFile(rootId, relPath, text, expectedMtimeMs)`，基线 = 打开时读到的 mtime；
 *   · 成功回填新 mtime 并标 `已保存 · HH:MM`，冲突走 Toast + 重读磁盘；
 *   · 与 PageEditor 唯一的差别：**冲突时保留用户输入**（本页签是速记面，输入不该被静默丢掉），
 *     重读只用来刷新基线，下一次保存才覆盖磁盘 —— Toast 里把这件事说清楚。
 *
 * 这一步是「编辑器 = 唯一正式正文写入方」的会话内例外（plan §12 D1）；正式改正文仍走
 * `onOpenInEditor` 跳知识库编辑器，本页签不替代它。
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Copy, ExternalLink, Eye, FileText, Pencil, Plus, Search, X } from 'lucide-react'
import type { NotesPaneProps } from './paneContracts'
import {
  isNoteFile,
  mergeSaveResult,
  noteNameOf,
  pickNoteFiles,
  relativeTime,
  saveStateLabel,
  uniqueNotePath,
  type NoteFileRef,
  type NoteSaveState,
} from './notesPanePure'
import {
  aiTeachEnsureSessionFolder,
  aiTeachSessionFolder,
  getSetting,
  onAiTeachTreeRefresh,
  onWsExternalChange,
  workspaceListDir,
  workspaceMkdir,
  workspaceReadFile,
  workspaceStat,
  workspaceWriteFile,
} from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { showToast } from '../../../lib/toast'
import { MarkdownPreview } from '../../../components/shared/MarkdownPreview'
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

export function NotesPane(props: NotesPaneProps) {
  const { rootId, sessionId, width, active, open, request, onOpenInEditor, onDirtyChange } = props

  const [folder, setFolder] = useState<string | null>(null)
  const [files, setFiles] = useState<NoteFileRef[]>([])
  const [currentRel, setCurrentRel] = useState('')
  const [doc, setDoc] = useState<PaneDoc | null>(null)
  const [saveState, setSaveState] = useState<NoteSaveState>('clean')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState(false)
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
  const dirtyCbRef = useRef(onDirtyChange)
  dirtyCbRef.current = onDirtyChange

  const narrow = width > 0 && width < NARROW_WIDTH

  /* ------------------------------------------------------------ 保存 */

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
      const expectedMtimeMs = cur.mtimeMs > 0 ? cur.mtimeMs : undefined
      let res: Awaited<ReturnType<typeof workspaceWriteFile>> | null = null
      try {
        res = await workspaceWriteFile(cur.rootId, cur.relPath, body, expectedMtimeMs)
      } catch (e) {
        console.error('[NotesPane] save failed:', e)
        res = null
      }
      const merged = mergeSaveResult(
        { mtimeMs: cur.mtimeMs },
        res ? { ok: !!res.ok, mtimeMs: res.mtimeMs, conflict: res.conflict } : { ok: false },
      )

      if (merged.state === 'conflict') {
        // 磁盘被外部改过。与 PageEditor 的「放弃本地并重读」不同：这里保留用户输入，
        // 只把基线刷新为磁盘当前 mtime；用户继续编辑后下一次保存才会覆盖磁盘版本。
        if (aliveRef.current) {
          showToast({
            type: 'warning',
            message: '文件已被外部修改',
            detail: '你写的版本仍保留在这里；继续编辑并保存会覆盖磁盘上的版本',
          })
        }
        const disk = await workspaceReadFile(cur.rootId, cur.relPath).catch(() => null)
        if (openRef.current === cur) {
          if (disk && !disk.error && typeof disk.mtimeMs === 'number' && disk.mtimeMs > 0) {
            cur.mtimeMs = disk.mtimeMs
          }
          if (aliveRef.current) setSaveState('conflict')
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
  }, [])

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

  /* ------------------------------------------------------------ 打开文件 */

  const openFile = useCallback(
    async (relPath: string) => {
      if (!rootId || !relPath) return
      pendingOpenRef.current = relPath
      setLoadingRel(relPath)
      const seq = ++openSeqRef.current
      await saveNow()
      if (seq !== openSeqRef.current) return
      // 读盘期间先卸掉编辑器：避免用户在这几毫秒里继续敲字、随后被新文件覆盖
      setDoc(null)
      const res = await workspaceReadFile(rootId, relPath).catch(() => null)
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
        relPath,
        text,
        savedText: text,
        mtimeMs: typeof res.mtimeMs === 'number' && res.mtimeMs > 0 ? res.mtimeMs : 0,
      }
      setDoc(makeDoc(relPath, text))
      setCurrentRel(relPath)
      setDirty(false)
      setSaveState('clean')
      setSavedAt(null)
      setPreview(false)
    },
    [rootId, saveNow],
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
    const folderRel = folderRes?.ok && folderRes.relPath ? folderRes.relPath : null
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
    // 没有打开任何文件时默认落到最近改过的一篇（打开即编辑，D1）
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

  const createNote = useCallback(async () => {
    if (!rootId || !sessionId) return
    let base = folder
    if (!base) {
      const ensured = await aiTeachEnsureSessionFolder(sessionId).catch(() => null)
      if (ensured?.ok && ensured.relPath) base = ensured.relPath
    }
    if (!base) {
      showToast({ type: 'error', message: '无法新建笔记', detail: '会话文件夹不可用' })
      return
    }
    const outDir = joinRel(base, '产物')
    const listed = await workspaceListDir(rootId, base).catch(() => null)
    const hasOut =
      (listed?.entries ?? []).some((e) => e.type === 'dir' && e.name === '产物') ||
      (listed?.softNames ?? []).includes('产物')
    let targetDir = outDir
    if (!hasOut) {
      const made = await workspaceMkdir(rootId, outDir).catch(() => null)
      if (made?.ok) {
        targetDir = made.relPath ? made.relPath.replace(/\\/g, '/') : outDir
      } else {
        // 建目录失败就退级到会话文件夹根：宁可贵一层，也不让「新建笔记」变死按钮。
        // （F11 拍平后的正式落点是 `产物/`，这里是环境不允许时的兜底，不是新口径。）
        targetDir = base
      }
    }
    const names = ((await workspaceListDir(rootId, targetDir).catch(() => null))?.entries ?? []).map((e) =>
      joinRel(targetDir, e.name),
    )
    const relPath = uniqueNotePath(names, joinRel(targetDir, '笔记.md'))
    const res = await workspaceWriteFile(rootId, relPath, '', undefined)
    if (!res?.ok) {
      showToast({ type: 'error', message: '新建笔记失败', detail: res?.error })
      return
    }
    await scan()
    await openFile(relPath)
    setSearch('')
    setSearchOpen(false)
    setPreview(false)
  }, [rootId, sessionId, folder, scan, openFile])

  /* ------------------------------------------------------------ 输入 */

  const handleChange = useCallback(
    (relPath: string, value: string) => {
      const cur = openRef.current
      // 迟到的旧引擎回调不能污染刚切过来的文件
      if (!cur || cur.relPath !== relPath || value === cur.text) return
      cur.text = value
      setDoc((d) => (d && d.relPath === relPath ? { ...d, content: value, size: value.length } : d))
      if (!dirty) setDirty(true)
      setSaveState('dirty')
      scheduleSave(value)
    },
    [dirty, scheduleSave],
  )

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

  /* ------------------------------------------------------------ 切换会话：先落盘再重置 */

  useEffect(() => {
    let cancelled = false
    const reset = async () => {
      await saveNow()
      if (cancelled) return
      openRef.current = null
      pendingOpenRef.current = ''
      setDoc(null)
      setCurrentRel('')
      setDirty(false)
      setSaveState('clean')
      setSavedAt(null)
      setPreview(false)
      setSearch('')
      setLoadingRel(null)
      await scan()
    }
    void reset()
    return () => {
      cancelled = true
    }
  }, [rootId, sessionId, scan, saveNow])

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

  // 壳的「请打开这个文件」请求：路径不必在列表里（产物 / 本次改动点进来都算）
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

  /* ------------------------------------------------------------ 空态 */

  if (!rootId || !sessionId) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="kb-view-fade w-full max-w-[320px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-5 text-center text-[13px] text-[var(--text-primary)]">
          先进入一个 AI 教学对话
        </div>
      </div>
    )
  }

  const showList = !narrow || listOpen

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 动作行：32px，只放动作与当前文件，不另加标题 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-1.5">
        {narrow && (
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
        <button
          onClick={() => void createNote()}
          data-tip="在会话文件夹的 产物/ 下新建一篇笔记"
          aria-label="新建笔记"
          className="kb-press kb-micro-pop shrink-0 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Plus size={12} />
          {!narrow && <span>新建笔记</span>}
        </button>

        {narrow && !searchOpen ? (
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
              className={`min-w-0 bg-transparent text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none ${narrow ? 'w-[90px]' : 'w-[130px]'}`}
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
            <span
              className="min-w-0 max-w-[40%] truncate text-[11.5px] text-[var(--text-primary)]"
              data-tip={currentRel}
              aria-label={currentRel}
            >
              {noteNameOf(currentRel)}
            </span>
            <span className={`shrink-0 whitespace-nowrap text-[10.5px] tabular-nums ${statusClass}`} aria-live="polite">
              {saveLabel}
            </span>
          </>
        )}
      </div>

      {/* 文件列表：最近修改倒序，最多 12 条 */}
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
                    void openFile(f.relPath)
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
                <MarkdownPreview content={doc.content} />
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
            {loadingRel ? '打开中…' : '从上面选一篇笔记开始记'}
          </div>
        )}
      </div>
    </div>
  )
}
