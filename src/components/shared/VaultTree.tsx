/**
 * 全仓共享文件树（笔记合并 Phase 2 批次 1，docs/notes-merge-phase2-design.md §2）。
 * 从 editor 模块上移：纯 props 驱动（dirCache/expanded/回调），数据与状态全在宿主侧。
 * 知识库「文件视图」与编辑区共用同一份实现；TreeNode/DirCache/CreateIntent 类型随迁至此。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, FolderTree } from 'lucide-react'
import { Collapsible } from './Collapsible'
import { DeleteWipe } from './DeleteWipe'
import { TreeGuideLine } from './treeGuides'
import { useSettings } from '../../lib/SettingsContext'

import { getFileIcon } from '../../lib/fileIcons'
import ignoreRuleSvg from '../../assets/ignore.svg?raw'
import type { WorkspaceEntry } from '../../types/index'

/** 树条目：工作区条目 + 相对路径（文件树语境的通用节点） */
export type TreeNode = WorkspaceEntry & { relPath: string }
/** 目录缓存：dirRelPath -> entries（懒加载，展开时填充） */
export type DirCache = Record<string, TreeNode[]>
/** 内联创建可产生的四种条目：file=普通文件 / dir=目录 / knowledge=带 frontmatter 知识页 /
 *  category=分类目录（B-13 并入；顶层 mkdir + categories.json 登记，**恒落仓库根层**，
 *  所以调用方传的 dirRel 对它无意义——树只管在给到的 dirRel 下渲染输入行） */
export type CreateType = 'file' | 'dir' | 'knowledge' | 'category'

/** VS Code 式内联创建意图：目标目录 + 条目类型（file=普通文件 / dir=目录 / knowledge=带 frontmatter 知识页） */
export interface CreateIntent {
  dirRel: string
  type: CreateType
  /** 内联输入框默认名（全选态）：空 = 只 focus 让用户输入 */
  initial?: string
}
/** 重命名意图：该 relPath 的条目替换为内联输入行（宿主持有状态，树保持受控） */
export interface RenameIntent {
  relPath: string
}

interface Props {
  dirCache: DirCache
  expanded: Set<string>
  activePath: string | null
  onToggleDir: (relPath: string) => void
  onOpenFile: (node: TreeNode) => void
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void
  onMove: (srcRel: string, targetDirRel: string) => void
  /** VS Code 式内联创建：非空表示在目标目录的条目末尾显示待命名行 */
  creating?: CreateIntent | null
  onCommitCreate?: (dirRel: string, type: CreateType, rawName: string) => void
  onCancelCreate?: () => void
  /** 重命名态：非空表示该 relPath 的条目替换为内联输入行 */
  renaming?: RenameIntent | null
  onCommitRename?: (relPath: string, rawName: string) => void
  onCancelRename?: () => void
  /** 删除动画状态（键 = relPath）：'animating' 播放红色吞噬，'done' 收尾淡出。
   *  与 NotebookList / ChapterPanel 共用同一 deleteWithAnimation 语义，只是键由分类 id 换成相对路径。 */
  deletingMap?: Map<string, 'animating' | 'done'>
  /** 选中目录（B-7）：头部「＋」的落点来源；null/undefined = 无选中，由调用方回退到仓库根。
   *  与 activePath 是两层语义：activePath = 正在看哪个文件，selectedPath = 下一个新建落在哪。
   *  全 optional，不传 = 与加此特性前完全一致（编辑器侧的文件树即不传）。 */
  selectedPath?: string | null
  /** 点目录行 / 点文件行（回调其父目录）时上报选中目录——受控，树自身不持选中态 */
  onSelectDir?: (dirRel: string) => void
  /** 软件生成项名单（根层 .ignore / AI教学 产物根等，ws:listDir 附带）：
   *  命中条目从主列表移到底部「软件文件」折叠节（VS Code 时间线式，默认收起） */
  softNames?: string[]
  /** 目录聚焦：开启后只显示当前打开文件的目录链 + 同级项，其余骨架化/隐藏（样式 folderFocusStyle） */
  focusOn?: boolean
  /** 点击骨架条 = 退出聚焦并定位（目录展开 / 文件打开） */
  onFocusLocate?: (relPath: string, isDir: boolean) => void
  /** 根容器 ref：父级用它把焦点交给文件树（右键「粘贴」需先聚焦，见 editor/index.tsx） */
  rootRef?: React.RefObject<HTMLDivElement | null>
}

const DRAG_MIME = 'text/x-kb-rel'

/** 父目录相对路径（根层条目 → ''）。选中目录（B-7）与聚焦判定共用同一口径 */
const parentDirOf = (rel: string) => rel.split('/').slice(0, -1).join('/')

function FileIcon({ name }: { name: string }) {
  // .ignore 文件名精确匹配分支（先于 ext 提取；不做 'ignore' 后缀注册——避免 a.ignore 等误命中，§9.3-2）。
  // 复用 src/lib/fileIcons 知识库已建好的 vscode-icons 库（CC BY 4.0）；
  // 按扩展名映射 27 种文件类型，未命中走 default.svg。无扩展名（新建知识页）默认 md。
  const isIgnoreRule = name.toLowerCase() === '.ignore'
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const svg = isIgnoreRule ? ignoreRuleSvg : getFileIcon(ext)
  return (
    <span
      className="shrink-0 inline-flex items-center justify-center"
      style={{ width: 14, height: 14 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/**
 * 目录树：懒加载 + 拖拽移动。
 * 拖拽：条目均可拖（mime: text/x-kb-rel）；目录与根容器是落点，
 * drop 时把源相对路径移动到目标目录下（主进程 ws:rename 跨目录移动）。
 */
export function VaultTree({ dirCache, expanded, activePath, onToggleDir, onOpenFile, onContextMenu, onMove, creating, onCommitCreate, onCancelCreate, renaming, onCommitRename, onCancelRename, deletingMap, selectedPath, onSelectDir, softNames, focusOn, onFocusLocate, rootRef }: Props) {
  const [dragOver, setDragOver] = useState<string | null>(null)
  /** 删除动画状态（键 = relPath；animating 渲染吞噬 / done 收尾淡出） */
  const delState = (rel: string) => deletingMap?.get(rel)
  /** 删除动画行附加类（.kb-deleting 自带 position:relative + pointer-events:none） */
  const delClass = (rel: string) => {
    const st = delState(rel)
    return st === 'animating' ? ' kb-deleting' : st === 'done' ? ' kb-deleting kb-done' : ''
  }

  /**
   * 目录聚焦（2026-09-12）：只保留「当前打开文件的祖先目录链 + 同级文件」实名——
   * 链外的目录一律失焦（兄弟目录也不保留实名），同级文件保留实名方便切换；其余骨架化/隐藏。
   * 2026-09-19 补充：聚焦目标在**仓库根层**（不在任何目录里）时，同级保留规则不适用——
   * 其他顶层文件/目录一并骨架化，只留聚焦目标实名（否则一聚焦根层文件整棵树都还是实名）。
   */
  const { s: focusSettings } = useSettings()
  const focusHide = (focusSettings.folderFocusStyle ?? 'skeleton') === 'hidden'
  // 聚焦目标 = 当前打开文件；全部标签关闭后回退到本次会话最近打开的文件（否则无打开文件时开关永远空操作）
  const lastActiveRef = useRef<string | null>(null)
  if (activePath) lastActiveRef.current = activePath
  const focusPath = activePath ?? lastActiveRef.current
  const focusActive = !!focusOn && !!focusPath
  const curParentDir = focusPath ? parentDirOf(focusPath) : null
  const isChainDir = (rel: string) => !!focusPath && (focusPath + '/').startsWith(rel + '/')
  const isSiblingItem = (rel: string) =>
    !!focusPath && curParentDir !== '' && parentDirOf(rel) === curParentDir
  const skelWidth = (rel: string) => { let h = 0; for (let i = 0; i < rel.length; i++) h = (h * 31 + rel.charCodeAt(i)) >>> 0; return 42 + (h % 48) }
  /** 骨架条：占位 + 悬停显原名；点击 = 退出聚焦并定位 */
  const renderSkeletonRow = (relPath: string, name: string, isDir: boolean, depth: number, icon: React.ReactNode) => (
    <div
      key={`skel-${relPath}`}
      onClick={() => onFocusLocate?.(relPath, isDir)}
      title={`${name}（点击退出聚焦并定位）`}
      className="group flex items-center gap-1 rounded-md px-1.5 py-[3px] cursor-pointer select-none hover:bg-[var(--bg-hover)]"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="w-[12px] shrink-0" />
      <span className="opacity-25 shrink-0 inline-flex">{icon}</span>
      <span className="h-[10px] rounded-[5px] bg-[var(--bg-tertiary)] shrink-0 group-hover:hidden" style={{ width: skelWidth(relPath) }} />
      <span className="hidden group-hover:block truncate text-[12.5px] text-[var(--text-muted)]">{name}</span>
    </div>
  )
  // 「软件文件」折叠节开合（默认收起，localStorage 记忆——VS Code 时间线式）
  const [softOpen, setSoftOpen] = useState(() => {
    try { return localStorage.getItem('kb.treeSoftOpen') === '1' } catch { return false }
  })
  const toggleSoftOpen = () => {
    setSoftOpen((v) => {
      try { localStorage.setItem('kb.treeSoftOpen', v ? '0' : '1') } catch { /* 隐私模式静默 */ }
      return !v
    })
  }

  const startDrag = (e: React.DragEvent, relPath: string) => {
    e.dataTransfer.setData(DRAG_MIME, relPath)
    e.dataTransfer.effectAllowed = 'move'
  }

  const dropToDir = (e: React.DragEvent, dirRel: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(null)
    const src = e.dataTransfer.getData(DRAG_MIME)
    if (src && src !== dirRel) onMove(src, dirRel)
  }

  const renderFileRow = (e: TreeNode, depth: number): React.ReactNode => {
    if (focusActive && e.relPath !== focusPath && !isSiblingItem(e.relPath)) {
      if (focusHide) return null
      return renderSkeletonRow(e.relPath, e.name, false, depth, <FileIcon name={e.name} />)
    }
    if (renaming?.relPath === e.relPath) {
      return (
        <InlineRenameRow
          key={e.relPath}
          depth={depth}
          name={e.name}
          isDir={false}
          onCommit={(raw) => onCommitRename?.(e.relPath, raw)}
          onCancel={onCancelRename ?? (() => {})}
        />
      )
    }
    return (
      <div
        key={e.relPath}
        draggable
        onDragStart={(ev) => startDrag(ev, e.relPath)}
        className={`group flex items-center gap-1 rounded-md px-1.5 py-[3px] cursor-pointer select-none hover:bg-[var(--bg-hover)] ${activePath === e.relPath ? 'bg-[var(--bg-selected)]/40' : ''} ${focusActive && focusPath === e.relPath ? 'ring-1 ring-inset ring-[var(--accent)]/40' : ''}${delClass(e.relPath)}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => { onSelectDir?.(parentDirOf(e.relPath)); onOpenFile(e) }}
        onContextMenu={(ev) => onContextMenu(ev, e)}
        title={e.relPath}
      >
        <span className="w-[12px] shrink-0" />
        <FileIcon name={e.name} />
        <span className={`truncate text-[12.5px] ${activePath === e.relPath ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>{e.name}</span>
        {delState(e.relPath) === 'animating' && <DeleteWipe />}
      </div>
    )
  }

  const renderDir = (relPath: string, depth: number): React.ReactNode => {
    const entries = dirCache[relPath] ?? []
    const dirNode = relPath === '' ? null : {
      name: relPath.split('/').pop() || relPath,
      type: 'dir' as const,
      size: 0,
      mtime: 0,
      relPath,
    }
    // 目录聚焦：目录只认链条（兄弟目录也失焦），根容器永不骨架化；链上目录强制展开
    if (focusActive && dirNode && !isChainDir(relPath)) {
      if (focusHide) return null
      return renderSkeletonRow(relPath, dirNode.name, true, depth, <Folder size={14} className="text-[var(--text-muted)]" />)
    }
    const isOpen = expanded.has(relPath) || (focusActive && isChainDir(relPath))
    return (
      <div
        key={relPath}
        className={depth === 0 ? 'flex flex-1 flex-col' : undefined}
        onContextMenu={depth === 0 ? (e) => {
          // 根层容器铺满整个树区（flex-1）：空白处右键的 target 是本容器而非 FileTree 根，
          // 在此以工作区根目录打开右键菜单（行内右键 target≠容器，不受影响）
          if (e.target === e.currentTarget) {
            onContextMenu(e, { name: '工作区', type: 'dir', size: 0, mtime: 0, relPath: '' })
          }
        } : undefined}
      >
        {dirNode && (renaming?.relPath === relPath ? (
          <InlineRenameRow
            key={relPath}
            depth={depth}
            name={dirNode.name}
            isDir
            onCommit={(raw) => onCommitRename?.(relPath, raw)}
            onCancel={onCancelRename ?? (() => {})}
          />
        ) : (
          <div
            draggable
            onDragStart={(e) => startDrag(e, relPath)}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(relPath) }}
            onDragLeave={() => setDragOver((p) => (p === relPath ? null : p))}
            onDrop={(e) => dropToDir(e, relPath)}
            className={`group relative flex items-center gap-1 rounded-md px-1.5 py-[3px] cursor-pointer select-none hover:bg-[var(--bg-hover)] ${
              dragOver === relPath ? 'bg-[var(--accent)]/15 ring-1 ring-inset ring-[var(--accent)]/40' : ''
            }${delClass(relPath)}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => { onSelectDir?.(relPath); onToggleDir(relPath) }}
            onContextMenu={(e) => onContextMenu(e, dirNode)}
            title={relPath}
          >
            {/* 选中目录（B-7）：左缘 2px 强调色竖条、不铺底色——文件「正在看」已占用蓝底，
                同底色会让人以为目录被打开了。与 activePath 是两层语义（落点 vs 正在看）。 */}
            {selectedPath === relPath && (
              <span
                aria-hidden
                data-wb="treeDirSelected"
                className="pointer-events-none absolute bottom-[3px] left-[1px] top-[3px] w-[2px] rounded-full bg-[var(--accent)]"
              />
            )}
            <ChevronRight
              size={12}
              className={`kb-chevron shrink-0 text-[var(--text-muted)] ${isOpen ? 'rotate-90' : ''}`}
            />
            {isOpen ? <FolderOpen size={14} className="shrink-0 text-[var(--text-muted)]" /> : <Folder size={14} className="shrink-0 text-[var(--text-muted)]" />}
            <span className="truncate text-[12.5px] text-[var(--text-primary)]">{dirNode.name}</span>
            {delState(relPath) === 'animating' && <DeleteWipe />}
          </div>
        ))}
        {(() => {
          // 软件生成项分组（仅根层）：命中名单的条目移到底部「软件文件」折叠节（VS Code 时间线式）
          const softSet = depth === 0 && softNames?.length ? new Set(softNames) : null
          const main = softSet ? entries.filter((e) => !softSet.has(e.name)) : entries
          const softItems = softSet ? entries.filter((e) => softSet.has(e.name)) : []
          const children = (
            <>
              {main.map((e) => {
                return e.type === 'dir'
                  ? renderDir(e.relPath, depth + 1)
                  : renderFileRow(e, depth + 1)
              })}
              {/* VS Code 式内联创建行：归位到主条目末尾——此前渲染在「软件文件」折叠节之后，命名框视觉上落进折叠节 */}
              {creating && creating.dirRel === relPath && (
                <InlineCreateRow
                  key={`__create__${creating.type}`}
                  depth={depth + 1}
                  type={creating.type}
                  initial={creating.initial}
                  onCommit={(rawName) => onCommitCreate?.(creating.dirRel, creating.type, rawName)}
                  onCancel={onCancelCreate ?? (() => {})}
                />
              )}
              {softItems.length > 0 && !focusActive && (
                <div className="mt-auto border-t border-[var(--border-color)] pt-1">
                  <div
                    onClick={toggleSoftOpen}
                    className="flex items-center gap-1 rounded-md px-1.5 py-[3px] cursor-pointer select-none hover:bg-[var(--bg-hover)]"
                    style={{ paddingLeft: 6 }}
                    title="软件生成的目录与文件（AI教学 产物、.ignore 过滤规则等）"
                  >
                    <ChevronRight
                      size={12}
                      className={`kb-chevron shrink-0 text-[var(--text-muted)] ${softOpen ? 'rotate-90' : ''}`}
                    />
                    <span className="truncate text-[12px] text-[var(--text-muted)]">软件文件</span>
                    <span className="ml-auto shrink-0 pr-1 text-[10px] text-[var(--text-muted)]">{softItems.length}</span>
                  </div>
                  <div className={`kb-collapse ${softOpen ? 'open' : ''}`}>
                    <div className="flex flex-col">
                      {softItems.map((e) =>
                        e.type === 'dir' ? renderDir(e.relPath, 1) : renderFileRow(e, 1)
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )
          // 根层（depth 0）保持直接子节点渲染：其父是 flex 列且依赖 mt-auto 把「软件文件」压到底，
          // 加包裹层会换掉 flex 上下文；根层是虚拟目录（无行），也没有属于自己的参考线。
          // 子目录统一走 <Collapsible>（收起时不挂载子树，展开/收起两个方向都有高度过渡，
          // docs/ui-animation-plan.md C 类）；子级块加 relative 包裹层 + 贯穿竖线——
          // 线从父行下方直通末子级，避免「每行画线段被圆角裁成竹节」的起伏感。
          if (depth === 0) return isOpen ? children : null
          return (
            <Collapsible open={isOpen} innerClassName="">
              {() => (
                <div className="relative">
                  <TreeGuideLine level={depth} />
                  {children}
                </div>
              )}
            </Collapsible>
          )
        })()}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      /* tabIndex：右键「粘贴」要先 programmatic focus 到这里（paste 命令落在「当前聚焦元素」上，
         焦点留在 Monaco 里的话会变成往正文插文本）。focus 圈用极淡 inset ring：
         既知道焦点进来了，又不抢视觉（开发负责人厌恶醒目标签）。
         注意 Ctrl+V 的守卫**不看焦点在不在树上**，只看焦点在不在文本编辑区
         （Chromium 会把非可编辑焦点的 paste 事件 target 重定向成 BODY，见 editor/index.tsx
         的 isTextEditingTarget）——所以这里不需要额外的 data-* 标记。 */
      tabIndex={0}
      className={`flex flex-1 flex-col overflow-y-auto px-1.5 py-1 outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--accent)]/25 ${dragOver === '' ? 'bg-[var(--accent)]/10' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver('') }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(null) }}
      onDrop={(e) => dropToDir(e, '')}
      onContextMenu={(e) => {
        // 空白区右键 → 以工作区根目录打开右键菜单（新建文件/文件夹/知识页）——节点行上的右键已各自处理并阻止冒泡
        if (e.target === e.currentTarget) {
          onContextMenu(e, { name: '工作区', type: 'dir', size: 0, mtime: 0, relPath: '' })
        }
      }}
    >
      {renderDir('', 0)}
    </div>
  )
}

/** VS Code 式内联创建行：条目末尾的可编辑输入框。Enter 提交、Esc 取消、失焦取消 */
function InlineCreateRow({ depth, type, initial, onCommit, onCancel }: {
  depth: number
  type: CreateType
  initial?: string
  onCommit: (rawName: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const committedRef = useRef(false)
  // 默认名：file→"新建文件.md"（保持扩选态方便直接输入主名）; dir→"新目录"; knowledge/category→空
  const def = type === 'file' ? (initial ?? '新建文件.md') : type === 'dir' ? (initial ?? '新目录') : (initial ?? '')
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (def) { el.value = def; requestAnimationFrame(() => el.select()) }
  }, [def])
  const commit = () => {
    if (committedRef.current) return
    committedRef.current = true
    onCommit(inputRef.current?.value ?? '')
  }
  const cancel = () => {
    if (committedRef.current) return
    committedRef.current = true
    onCancel()
  }
  return (
    <div
      className="flex items-center gap-1 rounded-md px-1.5 py-[3px]"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="w-[12px] shrink-0" />
      {type === 'dir' || type === 'category'
        ? (type === 'category'
          ? <FolderTree size={14} className="shrink-0 text-[var(--text-muted)]" />
          : <Folder size={14} className="shrink-0 text-[var(--text-muted)]" />)
        : <FileIcon name={def || '新建文件.md'} />}
      <input
        ref={inputRef}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') cancel()
          e.stopPropagation()
        }}
        onBlur={() => cancel()}
        placeholder={type === 'category' ? '分类名称…' : type === 'knowledge' ? '页面标题…' : '名称…'}
        className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg-primary)] px-1 py-[1px] text-[12.5px] text-[var(--text-primary)] outline-none"
      />
    </div>
  )
}

/** 内联重命名行：原地替换被重命名的条目（与 InlineCreateRow 同语义——Enter 提交 / Esc 取消 / 失焦取消）。
 *  输入框预填原名，并选中**主名**（不含扩展名），直接输入即替换主名、扩展名保留。 */
function InlineRenameRow({ depth, name, isDir, onCommit, onCancel }: {
  depth: number
  name: string
  isDir: boolean
  onCommit: (rawName: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const committedRef = useRef(false)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const dot = name.lastIndexOf('.')
    requestAnimationFrame(() => { if (dot > 0) el.setSelectionRange(0, dot); else el.select() })
  }, [name])
  const commit = () => {
    if (committedRef.current) return
    committedRef.current = true
    onCommit(inputRef.current?.value ?? '')
  }
  const cancel = () => {
    if (committedRef.current) return
    committedRef.current = true
    onCancel()
  }
  return (
    <div
      className="flex items-center gap-1 rounded-md px-1.5 py-[3px]"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="w-[12px] shrink-0" />
      {isDir
        ? <Folder size={14} className="shrink-0 text-[var(--text-muted)]" />
        : <FileIcon name={name} />}
      <input
        ref={inputRef}
        spellCheck={false}
        defaultValue={name}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') cancel()
          e.stopPropagation()
        }}
        onBlur={() => cancel()}
        className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg-primary)] px-1 py-[1px] text-[12.5px] text-[var(--text-primary)] outline-none"
      />
    </div>
  )
}
