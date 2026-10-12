import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Folder } from 'lucide-react'
import { loadTreeSubtree } from '../../lib/treeExpand'
import { workspaceGetCurrent } from '../../lib/ipc'

/**
 * 目录选择器（「将文件移动到…」的落点选择，2026-10-12）。
 * 设计：`docs/file-menu-rework-design.md` §4.2 · 原型：`tmp/file-menu-proto/index.html`
 *
 * 形态：**带输入框的扁平目录列表**（照 Obsidian）——输入实时筛选，↑↓ 移动高亮，Enter 确认，Esc 取消。
 * 为什么不做逐层展开的二级菜单：目录一深就是一串子菜单，且目录多时滚不完；
 * 扁平 + 筛选在两种极端下都够用。
 *
 * 数据源 `loadTreeSubtree(rootId, '', 2000)`（src/lib/treeExpand.ts）已经带了
 * 2000 目录上限与 `truncated` 标记 —— 大仓库不会把整棵树一次性拉爆。
 *
 * ★ 排除项（不做会得到「移了等于没移」或「把自己移进自己」）：
 *   · 源文件**当前所在目录**（移过去是空操作）；
 *   · 源**目录自身**及其全部子孙（移进去会成环）。
 *
 * 定位 / 进出场 / 外点关闭都由宿主 `FileContextMenu` 的二级面板负责 —— 本组件只管内容与键盘。
 */
export interface DirPickerProps {
  /** 仓库 rootId；不传则自己 `workspaceGetCurrent()` 解析（宿主手里只有异步 `ensureVaultRoot` 时用这条） */
  rootId?: string
  /** 源条目的仓库相对路径（文件或目录） */
  sourceRel: string
  onPick: (targetDirRel: string) => void
  onCancel: () => void
}

interface Row { rel: string; label: string; depth: number }

const parentDirOf = (rel: string): string => {
  const i = rel.lastIndexOf('/')
  return i === -1 ? '' : rel.slice(0, i)
}
const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

export function DirPicker({ rootId, sourceRel, onPick, onCancel }: DirPickerProps) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const rid = rootId || (await workspaceGetCurrent().then((c) => c?.rootId).catch(() => null))
      if (!alive) return
      if (!rid) { setRows([]); return }
      const r = await loadTreeSubtree(rid, '').catch(() => null)
      if (!alive) return
      if (!r) { setRows([]); return }
      const selfIsDir = r.dirs.has(sourceRel)
      const sameDir = parentDirOf(sourceRel)
      const out: Row[] = []
      for (const rel of r.dirs) {
        if (rel === sameDir) continue                                  // 移了等于没移
        if (selfIsDir && (rel === sourceRel || rel.startsWith(sourceRel + '/'))) continue  // 移进自己 / 子孙
        out.push({ rel, label: rel === '' ? '（仓库根）' : baseName(rel), depth: rel === '' ? 0 : rel.split('/').length })
      }
      // 字典序排序天然就是层级序（'a' < 'a/b' < 'ab'，因为 '/' 的码位小于字母）
      out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
      setRows(out)
      setTruncated(r.truncated)
      setHi(0)
    })()
    return () => { alive = false }
  }, [rootId, sourceRel])

  const shown = useMemo(() => {
    if (!rows) return []
    const s = q.trim().toLowerCase()
    if (!s) return rows
    return rows.filter((r) => r.rel.toLowerCase().includes(s))
  }, [rows, q])

  useEffect(() => { setHi(0) }, [q])
  useEffect(() => { inputRef.current?.focus() }, [])

  // 高亮行滚进可视区
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${hi}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  const onKey = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((v) => Math.min(v + 1, shown.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((v) => Math.max(v - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const pick = shown[hi]
      if (pick) onPick(pick.rel)
    }
  }

  return (
    <div className="w-[268px]" data-wb="dirPicker">
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2.5 py-2 text-[var(--text-muted)]">
        <Folder size={14} className="shrink-0" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="输入目录名筛选…"
          className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
        />
      </div>

      <div ref={listRef} className="max-h-[240px] overflow-y-auto p-[5px]">
        {rows === null && (
          <div className="px-2.5 py-3 text-center text-[12px] text-[var(--text-disabled)]">正在读取目录…</div>
        )}
        {rows !== null && shown.length === 0 && (
          <div className="px-2.5 py-3 text-center text-[12px] text-[var(--text-disabled)]">
            {rows.length === 0 ? '仓库里没有可作为目标的目录' : '没有匹配的目录'}
          </div>
        )}
        {shown.map((r, i) => (
          <button
            key={r.rel || '__root__'}
            type="button"
            data-row={i}
            title={r.rel || '仓库根'}
            /* 保住输入框焦点：不拦 mousedown 的话，鼠标点行会把焦点从输入框移走，
               之后 ↑↓ / Enter 就失灵了（click 仍然照常触发） */
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setHi(i)}
            onClick={() => onPick(r.rel)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-[5px] text-left text-[12.5px] leading-snug transition-colors ${
              i === hi ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            <Folder size={13} className="shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 truncate" style={{ paddingLeft: r.depth * 12 }}>{r.label}</span>
          </button>
        ))}
      </div>

      <div className="border-t border-[var(--border-color)] px-2.5 py-1.5 text-[10.5px] text-[var(--text-disabled)]">
        {truncated ? '目录过多，已截断到 2000 个 · ' : ''}Enter 移到高亮项 · ↑↓ 选择 · Esc 取消
      </div>
    </div>
  )
}
