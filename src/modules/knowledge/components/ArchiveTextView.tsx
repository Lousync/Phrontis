import { useEffect, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { MonacoPane } from '../../../components/shared/MonacoPane'
import { getFileTypeInfo } from '../../../lib/fileTypes'
import { workspaceGetCurrent, workspaceReadFile } from '../../../lib/ipc'

/**
 * 归档文本文件的**只读**内容视图。
 *
 * 两代用途（批 1，2026-10-12 改造为复用路径）：
 *  ① 原始用途（B-3 方案 A）：元信息卡 →「查看内容」的落点；
 *  ② 新增用途：**超过编辑上限（>10MB，`ReadFileResult.editable === false`）的文本类文件的直接落点** ——
 *     批 1 起文本类默认直接进可编辑落点，只有超限才退到这里只读打开。
 *     走它而不是把 10MB+ 正文灌进 PageEditor 的 `content` state：那会让自动保存
 *     的脏态比较与一批派生计算（题号 / 双链）白跑一遍，纯亏。
 *
 * 归档条目的索引正文恒为空——主进程对 entryKind==='file' 不读内容
 * （`knowledgeIndex.ts` 注释：「不读内容（二进制可能很大）」），所以本组件按需自读，
 * 与 WelcomeHtmlView / TxtReaderView 同一「给 path 自读」约定。
 *
 * 只读：`doc.editable=false` 交给 Monaco 拒绝编辑；不触碰 PageEditor 的脏状态机
 * （不调 onContentChange、不写盘）。
 */
export function ArchiveTextView({ path, fileType, fontSize, onBack, banner, backLabel = '返回' }: {
  path: string
  fileType: string
  fontSize?: number
  /** 返回上游（元信息卡）。作为页面的**直接落点**时不给（无上游可回） */
  onBack?: () => void
  /** 顶部提示条（超限原因等）；不给则不渲染 */
  banner?: string
  backLabel?: string
}) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setContent(null)
    setError(null)
    void (async () => {
      try {
        const cur = await workspaceGetCurrent()
        if (!cur?.rootId) throw new Error('当前没有打开的仓库')
        const res = await workspaceReadFile(cur.rootId, path)
        if (!alive) return
        setContent(res?.content ?? '')
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '读取失败')
      }
    })()
    return () => { alive = false }
  }, [path])

  return (
    <div className="kb-view-in flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 头部常驻：加载 / 失败态也留返回出口 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-2 py-1">
        {onBack && (
          <button
            data-wb="archiveViewBack"
            onClick={onBack}
            title={backLabel === '返回' ? '返回文件信息' : backLabel}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
          >
            <ArrowLeft size={12} />
            {backLabel}
          </button>
        )}
        <span className="truncate text-[11px] text-[var(--text-muted)]" title={path}>
          只读预览 · {path}
        </span>
      </div>

      {banner && (
        <div data-wb="archiveViewBanner" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--warning-bg)] px-3 py-1 text-[11.5px] text-[var(--warning)]">
          {banner}
        </div>
      )}

      {error ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-[var(--text-muted)]">{error}</div>
      ) : content === null ? (
        <div className="flex flex-1 items-center justify-center text-[var(--text-muted)]"><Loader2 size={16} className="animate-spin" /></div>
      ) : (
        <MonacoPane
          doc={{
            relPath: path,
            // 独立命名空间：与知识库就地编辑（kb://knowledge/…）、编辑区互不共享 Monaco model
            modelPath: `kb://archive-view/${path}`,
            content,
            language: getFileTypeInfo(fileType).monacoLang,
            binary: false,
            editable: false,
            truncated: false,
            size: content.length,
          }}
          onChange={() => { /* 只读视图：不接编辑回调 */ }}
          fontSize={fontSize}
        />
      )}
    </div>
  )
}
