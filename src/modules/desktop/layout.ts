/**
 * 桌面外壳 —— 布局数据模型（纯数据 + 纯函数，无 React、无 IPC）
 *
 * 设计要点（与 docs 讨论定稿一致）：
 *  - 磁贴 = 栅格里的一个格子块，尺寸以「格」为单位（w 1~4 × h 1~3）。
 *  - 布局存**全局**（settings.desktopPresets），不随仓库走、不进 `.knowbase/`。
 *    理由：桌面怎么摆是「这台机器上的我习惯怎么用」，不是某份资料的一部分。
 *  - 控件 key 命名空间分两类：`module:*`（打开模块）与 `content:*`（磁贴内就地办事）。
 *    这里**必须**与 TabName 区分开，否则 defOf 之类的查表会串味（原型阶段踩过）。
 */

export interface TileLayout {
  id: string
  /** 控件标识：'module:editor' / 'content:todo' … */
  key: string
  w: number
  h: number
}

export interface DesktopPreset {
  id: string
  name: string
  tiles: TileLayout[]
}

/** 尺寸边界（格）。上限刻意压到 4×3：再大就会把「一屏看全」这件事毁掉。 */
export const MIN_W = 1
export const MAX_W = 4
export const MIN_H = 1
export const MAX_H = 3

/** 点尺寸标签时按档轮转的顺序（从小到大一圈） */
export const SIZE_CYCLE: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [2, 1], [3, 1], [2, 2], [3, 2], [1, 2], [4, 2], [2, 3], [1, 3],
]

let seq = 0
/** 磁贴 id：时间戳 + 序号，保证同一毫秒内连点两次也不会重复 */
export function newTileId(): string {
  seq += 1
  return `t${Date.now().toString(36)}${seq.toString(36)}`
}

export function newPresetId(): string {
  seq += 1
  return `p${Date.now().toString(36)}${seq.toString(36)}`
}

export function clampW(w: number): number {
  return Math.max(MIN_W, Math.min(MAX_W, Math.round(w)))
}
export function clampH(h: number): number {
  return Math.max(MIN_H, Math.min(MAX_H, Math.round(h)))
}

/** 默认三套预设。首次进入桌面时直接可用，不用先「添加控件」。 */
export const DEFAULT_PRESETS: DesktopPreset[] = [
  {
    id: 'study',
    name: '学习',
    tiles: [
      { id: 'd1-clock', key: 'content:clock', w: 2, h: 2 },
      { id: 'd1-todo', key: 'content:todo', w: 2, h: 2 },
      { id: 'd1-calendar', key: 'content:calendar', w: 2, h: 2 },
      { id: 'd1-checkin', key: 'content:checkin', w: 2, h: 2 },
      { id: 'd1-recent', key: 'content:recent', w: 2, h: 1 },
      { id: 'd1-kbstat', key: 'content:kbstat', w: 2, h: 1 },
      { id: 'd1-dirs', key: 'content:dirs', w: 2, h: 1 },
      { id: 'd1-pomodoro', key: 'module:toolbox', w: 1, h: 1 },
      { id: 'd1-editor', key: 'module:editor', w: 1, h: 1 },
    ],
  },
  {
    id: 'write',
    name: '写作',
    tiles: [
      { id: 'd2-editor', key: 'module:editor', w: 2, h: 2 },
      { id: 'd2-recent', key: 'content:recent', w: 2, h: 2 },
      { id: 'd2-clock', key: 'content:clock', w: 2, h: 2 },
      { id: 'd2-blog', key: 'module:blog', w: 1, h: 1 },
      { id: 'd2-feed', key: 'content:feed', w: 2, h: 1 },
      { id: 'd2-todo', key: 'content:todo', w: 2, h: 1 },
    ],
  },
  {
    id: 'review',
    name: '复盘',
    tiles: [
      { id: 'd3-checkin', key: 'content:checkin', w: 2, h: 2 },
      { id: 'd3-activity', key: 'content:activity', w: 3, h: 2 },
      { id: 'd3-todo', key: 'content:todo', w: 2, h: 2 },
      { id: 'd3-calendar', key: 'content:calendar', w: 2, h: 2 },
      { id: 'd3-kbstat', key: 'content:kbstat', w: 2, h: 1 },
      { id: 'd3-stats', key: 'module:user', w: 1, h: 1 },
      { id: 'd3-recent', key: 'content:recent', w: 2, h: 1 },
      { id: 'd3-feed', key: 'content:feed', w: 2, h: 1 },
    ],
  },
]

/** 深拷贝（预设会被反复改写，必须断开引用） */
export function clonePresets<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 解析 settings 里的预设 JSON；任何异常都退回默认三套（宁可回到出厂，也不要白屏） */
export function parsePresets(json: string | undefined | null): DesktopPreset[] {
  if (!json) return clonePresets(DEFAULT_PRESETS)
  try {
    const v = JSON.parse(json) as unknown
    if (!Array.isArray(v) || v.length === 0) return clonePresets(DEFAULT_PRESETS)
    const ok = v.every(
      (p) =>
        !!p &&
        typeof (p as DesktopPreset).id === 'string' &&
        typeof (p as DesktopPreset).name === 'string' &&
        Array.isArray((p as DesktopPreset).tiles),
    )
    if (!ok) return clonePresets(DEFAULT_PRESETS)
    // 尺寸一律过一遍 clamp：手改过 JSON 或旧版本存了越界值时不至于把栅格撑坏
    return (v as DesktopPreset[]).map((p) => ({
      ...p,
      tiles: p.tiles.map((t) => ({ ...t, w: clampW(t.w), h: clampH(t.h) })),
    }))
  } catch {
    return clonePresets(DEFAULT_PRESETS)
  }
}

/** 交换两块磁贴的位置（拖拽换位用；下标无效时原样返回） */
export function swapTiles(tiles: TileLayout[], idA: string, idB: string): TileLayout[] {
  const i = tiles.findIndex((t) => t.id === idA)
  const j = tiles.findIndex((t) => t.id === idB)
  if (i < 0 || j < 0 || i === j) return tiles
  const next = tiles.slice()
  const tmp = next[i]
  next[i] = next[j]
  next[j] = tmp
  return next
}

/** 按档轮转尺寸；当前尺寸不在档位上时回到第一档 */
export function nextSize(w: number, h: number): readonly [number, number] {
  const i = SIZE_CYCLE.findIndex((c) => c[0] === w && c[1] === h)
  return SIZE_CYCLE[(i + 1) % SIZE_CYCLE.length]
}

/** 栅格列数：按容器宽度算能排下几列（>=4 列才够摆；上限 8 列免得宽屏上格子巨大） */
export const CELL_UNIT = 108
export const CELL_GAP = 12
export function columnsFor(width: number): number {
  const n = Math.floor((width + CELL_GAP) / (CELL_UNIT + CELL_GAP))
  return Math.max(4, Math.min(8, n))
}
