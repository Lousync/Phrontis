/**
 * 仓库内图片的取回管线（批 3，2026-10-13，v3.5.0 线）。
 *
 * 为什么不用 `ws:readImage`：那条通道的白名单是**附件区**（`.attachments/` 等），
 * 管不了仓库里任意位置的图片；而扩它的白名单等于再开一扇能力相同的门。
 * `ws:readRangeBytes` 早就允许读仓库内任意位置、且按**扩展名**放行
 * （`electron/lib/workspaceManager.ts:235`），PDF / TXT / foliate 三个阅读器都在用。
 * 本批只往那份名单补了一个 `avif`。
 *
 * 取回链路（一次探测 + 一次读段，**不 stat**）：
 *   ① probe 128KB → `size` 与像素尺寸都在这一跳里拿到（`readRangeBuffer` 回传 size）
 *   ② 超字节上限 / 超像素上限 → 落「过大」卡，**不解码**（像素那条才是真命门）
 *   ③ 读整份 → Blob → objectURL（不用 base64 data:URI：多 33% 体积 + 一次 atob 全量解码）
 *   ④ 解码结果由 `<img>` 的 naturalWidth/Height 回填 —— 那才是**权威尺寸**
 *
 * 生命周期：换文件 / 卸载时 `revokeObjectURL`。漏掉这一步的表现是「切了几十张图之后
 * 进程内存一路涨」，而 blob URL 不会被 GC 回收（它被 URL 表持有）。
 */

import { useEffect, useRef, useState } from 'react'
import { workspaceReadRangeBytes } from '../../../lib/ipc'
import {
  MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, dimsFromHeader, imageMime, isRenderableImageExt,
  type ImageDims,
} from '../../../lib/imageFormats'

/**
 * 探测段大小。为什么是 128KB 而不是 4KB：
 * JPEG 的 SOF 段可能排在一个很大的 APP1（EXIF，内含缩略图）之后，
 * 4KB 常常读不到尺寸（`verify-image-math.mjs` G 组有一条专测这个形态）。
 * 128KB 一次读的代价可忽略，且远小于整份。
 */
const PROBE_BYTES = 128 * 1024

export type VaultImageStatus = 'idle' | 'loading' | 'ready' | 'toobig' | 'broken'

/** 「过大」的两种成因。★ 刻意回传**结构化**数据而不是一句拼好的话：
 *  文案与尺寸格式化归展示层（`FileInfoRows` 已是本仓尺寸换算的唯一出口，
 *  见 FileMetaCard.tsx 的模块注释），hook 里再抄一份 `formatSize` 就是第二处真相。 */
export type VaultImageLimit =
  | { kind: 'bytes'; limitBytes: number }
  | { kind: 'pixels'; limitPixels: number }

export interface VaultImageState {
  status: VaultImageStatus
  /** 可给 `<img src>` 的 objectURL（仅 status==='ready' 时非空） */
  url: string | null
  /** 文件字节数（探测回传；用于「过大」卡与文件信息） */
  sizeBytes: number
  /** 解码后由 `<img>` 回填的权威尺寸；解码前用文件头解析值兜底（可能为 null） */
  dims: ImageDims | null
  /** status==='toobig' 时的成因 */
  limit?: VaultImageLimit
  /** 读取或解码失败的原因 */
  error?: string
}

export interface VaultImage extends VaultImageState {
  /** `<img onLoad>`：回填权威尺寸 */
  onDecoded: (w: number, h: number) => void
  /** `<img onError>`：文件头能读、图像数据解不开 */
  onDecodeError: () => void
  /** 重读一次（「解码失败」卡上的重试；文件在外部被替换后也能救回来） */
  reload: () => void
}

const IDLE: VaultImageState = { status: 'idle', url: null, sizeBytes: 0, dims: null }

function extOf(relPath: string): string {
  const m = /\.([^./\\]+)$/.exec(relPath)
  return m ? m[1].toLowerCase() : ''
}

export function useVaultImage(rootId: string | null, relPath: string | null): VaultImage {
  const [state, setState] = useState<VaultImageState>(IDLE)
  /** 重读计数器：进 effect 依赖，`reload()` 一 bump 就重跑整条链路 */
  const [nonce, setNonce] = useState(0)
  /** 最近一次解码回填的权威尺寸 —— 换文件时必须清掉，否则新图会先按旧图的尺寸算适应比例 */
  const decodedRef = useRef<ImageDims | null>(null)

  useEffect(() => {
    decodedRef.current = null
    if (!rootId || !relPath) { setState(IDLE); return }
    const ext = extOf(relPath)
    // 扩展名不在放行集合里：主进程会直接拒，这里先落一张说明卡（免得报「读取失败」却不知为何）
    if (!isRenderableImageExt(ext)) {
      setState({ ...IDLE, status: 'broken', error: `.${ext || '(无扩展名)'} 不在应用内可渲染的图片格式里` })
      return
    }

    let alive = true
    let objectUrl: string | null = null
    setState({ status: 'loading', url: null, sizeBytes: 0, dims: null })

    void (async () => {
      try {
        const probe = await workspaceReadRangeBytes(rootId, relPath, 0, PROBE_BYTES)
        if (!alive) return
        if (probe.error) { setState({ ...IDLE, status: 'broken', error: probe.error }); return }
        const size = typeof probe.size === 'number' ? probe.size : 0
        if (size > MAX_IMAGE_BYTES) {
          setState({ ...IDLE, status: 'toobig', sizeBytes: size, limit: { kind: 'bytes', limitBytes: MAX_IMAGE_BYTES } })
          return
        }
        const headerDims = dimsFromHeader(probe.bytes)
        if (headerDims && headerDims.w * headerDims.h > MAX_IMAGE_PIXELS) {
          setState({
            ...IDLE, status: 'toobig', sizeBytes: size, dims: headerDims,
            limit: { kind: 'pixels', limitPixels: MAX_IMAGE_PIXELS },
          })
          return
        }
        // 整份读。length 传 size 即可（readRangeBuffer 会夹到文件尾）
        const full = await workspaceReadRangeBytes(rootId, relPath, 0, size)
        if (!alive) return
        if (full.error) { setState({ ...IDLE, status: 'broken', error: full.error, sizeBytes: size }); return }
        if (full.truncated) {
          setState({ ...IDLE, status: 'broken', error: '读取被截断，文件可能正在被外部程序改写', sizeBytes: size })
          return
        }
        const blob = new Blob([full.bytes as unknown as BlobPart], { type: imageMime(ext) })
        objectUrl = URL.createObjectURL(blob)
        if (!alive) { URL.revokeObjectURL(objectUrl); objectUrl = null; return }
        setState({ status: 'ready', url: objectUrl, sizeBytes: size, dims: headerDims })
      } catch (e) {
        if (alive) setState({ ...IDLE, status: 'broken', error: (e as Error)?.message || '读取失败' })
      }
    })()

    return () => {
      alive = false
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null }
    }
  }, [rootId, relPath, nonce])

  return {
    ...state,
    reload: () => setNonce(n => n + 1),
    onDecoded: (w: number, h: number) => {
      if (!(w > 0 && h > 0)) return
      decodedRef.current = { w, h }
      setState(s => (s.status === 'ready' ? { ...s, dims: { w, h } } : s))
    },
    onDecodeError: () => {
      setState(s => (s.status === 'ready'
        ? { ...s, status: 'broken', url: null, error: '文件头可读，但图像数据无法解码（文件可能已损坏，或扩展名与实际格式不符）' }
        : s))
    },
  }
}
