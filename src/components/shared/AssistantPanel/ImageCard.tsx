import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Expand, MoreHorizontal, RefreshCw, Square, Trash2 } from 'lucide-react'
import { copyText, workspaceGetCurrent, workspaceTrash } from '../../../lib/ipc'
import { getCachedVaultImage, loadVaultImage } from '../../../lib/attachmentImage'
import { showToast } from '../../../lib/toast'
import type { AgentTraceStep } from '../../../types'

/**
 * 生图卡（v3.6.0 对话内生图 `/生图`；docs/ai-image-gen-plan.md §5.2）。
 *
 * 卡面口径（C1 = 简约）：**图就是卡** —— 不画外框、信息压成一行、动作悬停才出。
 * 三态共用一个组件，因为它们在视觉上是**同一个位置**的三张脸（占位框 → 成品 → 失败留空），
 * 拆成三个组件就得三处各自维护"占位框和成品一样大"这条不跳版纪律。
 *
 * 数据源两条（与方案 §5.2 一致）：
 *  · 成品/失败 —— 落库的 `trace.artifact`（刷新、重启后一样在，这是选 artifact 而不是
 *    往正文里塞 markdown 图的根本理由）；
 *  · 生成中 —— `agent:step` 里 `name === 'image'` 的跑动事件（`args` 带 prompt/aspect/ref，
 *    不带 artifact），由宿主筛出来喂给 `pending`。
 *
 * 动效纪律（铁律 13）：只用本文件里出现的既有/新增令牌（`.kb-img-develop` / `.kb-img-ph` /
 * `.kb-img-progress` / `.kb-view-fade` / `.kb-pop` / `.kb-overlay`），不写 transition-all、
 * 不临时造过渡。新增的三个令牌与降级段在 `src/styles/index.css` K 段。
 */

/** 生成中的阶段文字（A5）。★ 是**假进度**：文案只描述阶段，绝不出现百分比或预计时间（方案风险 4） */
const STAGES = ['理解描述', '构图', '采样', '细化']

/** 画幅 → CSS aspect-ratio；未知/未指定时按 16/9 占位（最常见的示意图比例） */
export function aspectToRatio(aspect?: string): string {
  switch ((aspect ?? '').trim()) {
    case '1:1': return '1 / 1'
    case '9:16': return '9 / 16'
    case '16:9': return '16 / 9'
    default: return '16 / 9'
  }
}

/** `.attachments/2026-10/dp-fill.png` → `dp-fill`（剥目录、剥扩展名、剥 `-vN` 版本后缀） */
export function imageVersionBase(rel: string): string {
  const name = String(rel ?? '').split('/').pop() ?? ''
  const stem = name.replace(/\.[^.]+$/, '')
  return stem.replace(/-v\d+$/, '')
}

/** `.attachments/2026-10/dp-fill-v3.png` → 3；没有 `-vN` 的初版 → 1 */
export function imageVersionNo(rel: string): number {
  const name = String(rel ?? '').split('/').pop() ?? ''
  const stem = name.replace(/\.[^.]+$/, '')
  const m = /-v(\d+)$/.exec(stem)
  return m ? Number(m[1]) || 1 : 1
}

export interface ImageArtifactView {
  rel: string
  title?: string
  w?: number
  h?: number
  bytes?: number
  prompt?: string
  ref?: string
  model?: string
  elapsedMs?: number
  /** 改图槽未配置 → 本次是按描述重画（卡上要标出来，不静默降级） */
  downgraded?: boolean
}

/** trace 里的 image 产物 → 卡片视图（字段由 agentService 组装，见 AgentTraceStep.artifact） */
export function imageArtifactOf(step: AgentTraceStep): ImageArtifactView | null {
  const a = step.artifact
  if (!a || a.kind !== 'image' || !a.rel) return null
  return {
    rel: a.rel, title: a.title, w: a.w, h: a.h, bytes: a.bytes,
    prompt: a.prompt, ref: a.ref, model: a.model, elapsedMs: a.elapsedMs, downgraded: a.downgraded,
  }
}

/**
 * 一条 trace 里的生图产物按「版本组」归并（docs/ai-image-gen-plan.md §5.2）：
 * 同一基名的 v1 / v2 / v3 合成**一张卡**（卡上出「版本 vN」切换），不同基名各一张。
 *
 * ★ 归并只在**同一条 trace（同一条消息 / 同一次运行）**内做 —— 跨消息归并会把两次
 *   独立生成误并成"同一张图的版本"。导出给两个面共用（助手面 MessageList 与 AI 教学消息区），
 *   两处各抄一份的话，版本口径迟早漂移。
 */
export function imageGroupsOf(trace?: AgentTraceStep[]): ImageArtifactView[][] {
  const byBase = new Map<string, ImageArtifactView[]>()
  for (const st of trace ?? []) {
    const v = imageArtifactOf(st)
    if (!v) continue
    const key = imageVersionBase(v.rel)
    const arr = byBase.get(key)
    if (arr) arr.push(v)
    else byBase.set(key, [v])
  }
  return [...byBase.values()].map((list) => list.sort((a, b) => imageVersionNo(a.rel) - imageVersionNo(b.rel)))
}

interface Props {
  /** 成品态（版本组里当前选中的那一版）。与 pending 互斥 */
  artifact?: ImageArtifactView
  /** 同 slug 的其它版本（含或不含 artifact 自身都可），≥2 项时出「版本」切换 */
  versions?: ImageArtifactView[]
  /** 生成中态：来自 agent:step 的 `args`（无 artifact） */
  pending?: { prompt?: string; aspect?: string; ref?: string } | null
  /** 失败态（A8）：一行字 + 重试 */
  error?: string
  /** 失败态的原始 prompt（重试要用它；失败步骤把 args 一并落进 trace，见 agentService） */
  errorPrompt?: string
  /** 停止生成（C3 生成期常显；A6 = 前端断开 + 主进程 abort，不落盘） */
  onStop?: () => void
  /** 重试 / 改图：把文本填回输入框（入口是对话，卡上没有"插入"按钮，见决策 D3） */
  onPrefill?: (text: string) => void
  /** 当前仓库根 id（删除产物用）；缺省时卡片自己取 */
  rootId?: string
}

/** 取仓库内图片的 objectURL（复用 src/lib/attachmentImage.ts 的缓存与归一化，不另开通道） */
function useVaultImage(rel?: string): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(() => (rel ? getCachedVaultImage(rel) : null))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!rel) { setUrl(null); setFailed(false); return }
    const hit = getCachedVaultImage(rel)
    if (hit) { setUrl(hit); setFailed(false); return }
    let alive = true
    setUrl(null); setFailed(false)
    void loadVaultImage(rel).then((u) => {
      if (!alive) return
      if (u) setUrl(u)
      else setFailed(true) // 文件被挪走/删掉/超限：走失败档，不留白框
    })
    return () => { alive = false }
  }, [rel])
  return { url, failed }
}

/** 生成中：占位框（与成品同比例，不跳版）+ 光晕呼吸 + 斜向扫光 + 阶段文字轮播 + 底部进度条 */
function PendingBody({ aspect, prompt, onStop }: { aspect?: string; prompt?: string; onStop?: () => void }) {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    // 轮播到最后一个阶段就停住（不复读 —— 复读会被读成"从头开始了"）
    const id = window.setInterval(() => setStage((v) => Math.min(v + 1, STAGES.length - 1)), 1600)
    return () => window.clearInterval(id)
  }, [])
  return (
    <div className="relative">
      <div
        className="kb-img-ph w-full rounded-lg bg-[var(--bg-tertiary)]"
        style={{ aspectRatio: aspectToRatio(aspect) }}
      />
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          title="停止生成（已生成的部分不落盘；服务端可能已计费）"
          className="absolute right-2 top-2 z-10 h-6 w-6 rounded-full bg-black/45 text-white flex items-center justify-center hover:bg-black/65 transition-colors"
        >
          <Square size={9} className="fill-current" />
        </button>
      )}
      <div className="absolute inset-x-0 bottom-0 px-2 pb-1.5">
        {prompt && <div className="mb-1 truncate text-[10.5px] text-[var(--text-muted)]" title={prompt}>{prompt}</div>}
        <span key={stage} className="kb-view-fade block text-[10.5px] text-[var(--text-secondary)]">
          {STAGES[stage]}…
        </span>
        <div className="kb-img-progress mt-1"><span /></div>
      </div>
    </div>
  )
}

export function ImageCard({ artifact, versions, pending, error, errorPrompt, onStop, onPrefill, rootId }: Props) {
  /** 版本组：`artifact` 自己 + 其它版本，按版本号升序。默认选中**最后生成的那一版** */
  const list = useMemo(() => {
    const all = [...(versions ?? [])]
    if (artifact && !all.some((v) => v.rel === artifact.rel)) all.push(artifact)
    return all.filter((v) => v.rel).sort((a, b) => imageVersionNo(a.rel) - imageVersionNo(b.rel))
  }, [versions, artifact])
  const [pickedRel, setPickedRel] = useState<string | undefined>(artifact?.rel)
  useEffect(() => {
    // 新产物落进同一个版本组时自动跟到最新那版（改图完成后用户要看的就是新图）
    const newest = list[list.length - 1]
    if (newest && !list.some((v) => v.rel === pickedRel)) setPickedRel(newest.rel)
  }, [list, pickedRel])
  const cur = list.find((v) => v.rel === pickedRel) ?? artifact ?? list[list.length - 1]

  const { url, failed } = useVaultImage(cur?.rel)
  const [zoom, setZoom] = useState(false)
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState(false)
  const [removed, setRemoved] = useState<string | null>(null) // 已移入回收站的 rel（本地态，trace 不动）
  const cardRef = useRef<HTMLDivElement>(null)

  // 放大（D6）：对话内暗底灯箱。★ 用 capture 抢在宿主全局 Esc 链之前 ——
  // 否则 Esc 既关灯箱又顺手把侧栏/抽屉也关了
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setZoom(false) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [zoom])

  // ⋯ 菜单：点外面关闭（菜单项点完立即切界面，不做退场动画）
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

  /** 删除产物：走既有 ws:trash（系统回收站，绝不 rm）。★ 只删磁盘文件，不动 trace —— 
   *  卡片原地转「已移入回收站」，用户还能从回收站找回来 */
  const removeArtifact = useCallback(async (rel: string) => {
    setMenu(false)
    try {
      const id = rootId || (await workspaceGetCurrent())?.rootId || ''
      if (!id) { showToast({ type: 'error', message: '没有打开的仓库，无法删除产物' }); return }
      const r = await workspaceTrash(id, rel)
      if (!r.ok) { showToast({ type: 'error', message: r.error ?? '删除失败' }); return }
      setRemoved(rel)
      showToast({ type: 'info', message: '产物已移入系统回收站' })
    } catch (e) {
      showToast({ type: 'error', message: `删除失败：${String((e as Error)?.message ?? e)}` })
    }
  }, [rootId])

  const copyPath = useCallback(async (rel: string) => {
    setMenu(false)
    const ok = await copyText(rel)
    if (!ok) { showToast({ type: 'error', message: '复制失败' }); return }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [])

  // ---- 生成中 ----
  if (pending) return <div className="max-w-[440px]"><PendingBody aspect={pending.aspect} prompt={pending.prompt} onStop={onStop} /></div>

  // ---- 失败（A8）：图位留空 + 一行字 + 重试 ----
  if (error) {
    const rp = String(errorPrompt ?? cur?.prompt ?? '').trim()
    return (
      <div className="max-w-[440px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-2">
        <div className="text-[11.5px] text-[var(--text-secondary)]">{error}</div>
        {rp && (
          <div className="mt-1.5 flex items-center gap-2">
            {onPrefill && (
              <button type="button" onClick={() => onPrefill(`/生图 ${rp}`)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors">
                <RefreshCw size={10} /> 重试
              </button>
            )}
            <button type="button" onClick={() => { void copyText(rp) }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
              <Copy size={10} /> 复制提示词
            </button>
          </div>
        )}
      </div>
    )
  }

  if (!cur?.rel) return null

  const name = cur.rel.split('/').pop() ?? cur.rel
  const ratio = cur.w && cur.h ? `${cur.w} / ${cur.h}` : undefined
  const meta = [
    name,
    cur.elapsedMs ? `${(cur.elapsedMs / 1000).toFixed(1)}s` : '',
    cur.w && cur.h ? `${cur.w}×${cur.h}` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div ref={cardRef} className="group/img relative max-w-[440px]">
      {removed === cur.rel ? (
        <div className="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-3 text-[11.5px] text-[var(--text-muted)]">
          产物已移入回收站（{name}）
        </div>
      ) : (
        <>
          {/* 成品：显影式进场 + 右下角「AI 生成」水印（E1，**渲染层叠加**，不改写落盘字节） */}
          <div className="kb-img-develop relative overflow-hidden rounded-lg bg-[var(--bg-tertiary)]">
            {url
              ? <img src={url} alt={cur.title || name} draggable={false}
                  className="block w-full cursor-zoom-in select-none"
                  style={ratio ? { aspectRatio: ratio, objectFit: 'contain' } : { maxHeight: 420, objectFit: 'contain' }}
                  onClick={() => setZoom(true)} />
              : (
                <div className="flex items-center justify-center text-[11.5px] text-[var(--text-muted)]"
                  style={{ aspectRatio: ratio ?? '16 / 9' }}>
                  {failed ? '图片取不到了（文件可能被移动或删除）' : '加载中…'}
                </div>
              )}
            {/* AIGC 标识（决策 E1）：**渲染层叠加**，不改写落盘字节（改文件要重编码，成本与失真都不划算）。
                `data-aigc` 是给契约脚本的锚：它保证标识只活在渲染层，不会有人顺手写进主进程落盘路径 */}
            <span data-aigc="render-only"
              className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/45 px-1.5 py-[1px] text-[9.5px] text-white/90 select-none">
              AI 生成
            </span>

            {/* 动作行：悬停才出（C1）。没有「插入知识页」—— 插图入口是对话（决策 D3） */}
            {!failed && (
              <div className="absolute left-2 top-2 flex items-center gap-1 opacity-0 group-hover/img:opacity-100 transition-opacity">
                <button type="button" title="对这张图说改图要求（入口是对话）"
                  onClick={() => onPrefill?.(`/生图 把这张图（${cur.rel}）改成：`)}
                  className="rounded bg-black/45 px-1.5 py-[2px] text-[10.5px] text-white hover:bg-black/65 transition-colors">
                  改图
                </button>
              </div>
            )}
            <button type="button" title="更多" onClick={() => setMenu((m) => !m)}
              className="absolute right-2 top-2 h-6 w-6 rounded-full bg-black/45 text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 hover:bg-black/65 transition-opacity">
              <MoreHorizontal size={13} />
            </button>

            {menu && (
              <div className="kb-pop absolute right-2 top-9 z-20 w-[168px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] py-1 shadow-xl"
                role="menu">
                <button type="button" role="menuitem" onClick={() => void copyPath(cur.rel)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                  {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />} 复制路径
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenu(false); setZoom(true) }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                  <Expand size={11} /> 放大
                </button>
                <button type="button" role="menuitem" onClick={() => void removeArtifact(cur.rel)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] text-red-400 hover:bg-[var(--bg-hover)] transition-colors">
                  <Trash2 size={11} /> 删除产物
                </button>
                {list.length > 1 && (
                  <div className="mt-1 border-t border-[var(--border-color)] px-2.5 pt-1.5 pb-0.5">
                    <div className="mb-1 text-[10px] text-[var(--text-muted)]">版本</div>
                    <div className="flex flex-wrap gap-1">
                      {list.map((v) => {
                        const n = imageVersionNo(v.rel)
                        const on = v.rel === cur.rel
                        return (
                          <button key={v.rel} type="button"
                            onClick={() => { setPickedRel(v.rel); setMenu(false) }}
                            title={v.rel}
                            className={'rounded px-1.5 py-[1px] text-[10.5px] transition-colors ' +
                              (on ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
                            v{n}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 元信息行：文件名 + 耗时/尺寸；完整路径走 hover 浮层（只动 opacity） */}
          <div className="relative mt-1 flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
            <span className="truncate">{meta}</span>
            {cur.downgraded && <span className="shrink-0 text-amber-400">按描述重画（未用原图）</span>}
            <span className="peer ml-auto shrink-0 cursor-help">路径</span>
            {/* 完整路径 hover 浮层：只动 opacity（不用 max-width 过渡 —— 那会每帧触发布局） */}
            <span className="pointer-events-none absolute right-0 bottom-full z-10 mb-1 max-w-[420px] truncate rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[10.5px] text-[var(--text-secondary)] opacity-0 shadow-lg transition-opacity peer-hover:opacity-100"
              title={cur.rel}>{cur.rel}</span>
          </div>
        </>
      )}

      {/* 放大（D6）：对话内暗底灯箱 —— 自绘，不复用批 3 的图片查看器（那是独立全屏宿主）。
          ★ 走 createPortal 挂到 body：助手侧栏根节点是 `fixed z-40`（自成层叠上下文），
            留在里面的话 `fixed inset-0` 会被那个上下文关住 —— 盖不住侧栏以外的区域，
            也会被更高层的浮层（如 z-300 的中央确认框）压住。z-[200] 落在
            「面板级浮层（130 档）之上、中央模态（300 档）之下」这一档。 */}
      {zoom && url && createPortal(
        <div className="kb-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setZoom(false)} role="dialog" aria-label="查看大图">
          <img src={url} alt={cur.title || name} draggable={false}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full select-none rounded-lg object-contain" />
        </div>, document.body)}
    </div>
  )
}
