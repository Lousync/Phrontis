import type { TabName } from '../types'

/**
 * 模块清单的**唯一真相源**。
 *
 * 为什么要有这个文件：模块清单原本被抄在 6 个地方，各自演化、已经飘了 ——
 *   · `App.tsx` 的 `MODULE_TABS`（命令面板）              —— 少了 aiTeaching
 *   · `App.tsx` 的启动回退候选 `all`                        —— 少了 desktop / aiTeaching，多了 recycle / help
 *   · `App.tsx` 的小窗 `switch-tab` 白名单                  —— 少了 desktop / editor / aiTeaching
 *   · `ActivityBar.tsx` 的 `ALL_MODULES`（右键显隐）        —— 只有 9 个 bar 模块
 *   · `settings.ts` 的 `activityBarOrder` 默认值（已随旧图标条退役删除）—— 曾混着 `export` / `recycle` 两个陈年 id
 *   · `desktop/tiles.tsx` 的 `DESK_MODULES`（磁贴入口）
 * 其中「启动回退候选里混进 recycle，而 recycle 又永远无法被隐藏」直接导致了
 * **把侧边栏模块全部隐藏后重启，应用自动打开回收站**（App.tsx 的兜底循环必然走到 recycle）。
 *
 * 这里只放 **id / 名称 / 成员资格**；图标和一句话说明属于组件层，不进 lib
 * （`tiles.tsx` 反向 import 组件会形成循环依赖，那条注释是对的，问题只是清单被抄了多份）。
 *
 * 图标仍然各组件自持：`ActivityBar` 的 BAR_ICONS、`tiles.tsx` 的 desc/icon、设置页的图标表。
 * 它们按 id 取，成员与顺序一律来自本文件。
 */

export interface AppModuleDef {
  id: TabName
  label: string
  /** 活动栏图标位：参与拖拽排序、右键「显示/隐藏模块」 */
  bar: boolean
  /** 可钉成桌面磁贴 / 出现在桌面「添加控件」面板 */
  tile: boolean
  /** 出现在命令面板的「打开模块」 */
  palette: boolean
}

/**
 * ⚠️ 顺序即默认顺序，改动前先看消费者：
 *   · `PALETTE_MODULES`（命令面板按此顺序列出）
 *   · 活动栏图标条追加顺序（`ActivityBar` 的 RAIL_BUTTONS）
 * v3.4.0 工作台三栏外壳：`desktop`（磁贴壳）被三栏外壳整体替代、`user`（账户）并入设置，
 * 两者从清单删除；新增 `bookshelf` / `aiChat` / `graph` 三个「入口产生型」Tab。
 */
export const APP_MODULES = [
  // 2026-09-20 阶段四：editor 模块整体退役（能力已并入笔记区；桌面磁贴随桌面模块后续专项处理）
  { id: 'knowledge', label: '笔记', bar: true, tile: true, palette: true },
  { id: 'blog', label: '博客', bar: true, tile: true, palette: true },
  { id: 'schedule', label: '日程', bar: true, tile: true, palette: true },
  { id: 'moments', label: '动态', bar: true, tile: true, palette: true },
  { id: 'aiTeaching', label: 'AI教学', bar: true, tile: true, palette: true },
  { id: 'toolbox', label: '工具箱', bar: true, tile: true, palette: true },
  { id: 'plugins', label: '插件', bar: true, tile: true, palette: true },
  // 2026-09-22 书市（S4）：左栏独立整窗模块，与工具箱 / 插件平级（方案 §1.2 第 5 条、拍板 ⑤）。
  // 排在 bar 段末尾是有意的 —— 活动栏图标条（ActivityBar 的 RAIL_BUTTONS）按同一顺序追加，
  // 现有四项的位置一个不动。
  { id: 'bookMarket', label: '书市', bar: true, tile: true, palette: true },
  // 以下不进活动栏图标位：只能从设置菜单 / 事件 / 命令打开
  // （「回收站」「帮助」是刻意去才会去的目的地，不该摆在图标条上）
  { id: 'recycle', label: '回收站', bar: false, tile: true, palette: true },
  { id: 'help', label: '帮助', bar: false, tile: true, palette: true },
  // v3.4.0 新增「入口产生型」Tab：只能由工作台入口产生（书架=左栏书签、AI对话=⤢、图谱=知识库跳转），
  // 不进命令面板——关掉后想再开，从对应入口再点一次即可（幂等哲学）
  { id: 'bookshelf', label: '书架', bar: false, tile: false, palette: false },
  { id: 'aiChat', label: 'AI对话', bar: false, tile: false, palette: false },
  { id: 'graph', label: '知识图谱', bar: false, tile: false, palette: false },
  { id: 'releaseNotes', label: '更新说明', bar: false, tile: true, palette: false },
  { id: 'settings', label: '设置', bar: false, tile: true, palette: true },
  { id: 'devtools', label: '开发者工具', bar: false, tile: false, palette: false },
] as const satisfies readonly AppModuleDef[]

type CoveredId = (typeof APP_MODULES)[number]['id']
/**
 * 编译期兜底：`TabName` 加了新成员却忘了进 `APP_MODULES` 时，**这里会直接报错**
 * （错误信息会带上漏掉的 id），而不是等运行时表现成「某个清单里莫名少一项」。
 */
type _AllTabNamesCovered = Exclude<TabName, CoveredId> extends never
  ? true
  : ['APP_MODULES 遗漏了这些 TabName：', Exclude<TabName, CoveredId>]
export const __ALL_TAB_NAMES_COVERED: _AllTabNamesCovered = true

const byFlag = (k: 'bar' | 'tile' | 'palette'): TabName[] =>
  APP_MODULES.filter((m) => m[k]).map((m) => m.id)

/** 活动栏图标位模块（bar:true；顺序语义已死 —— 旧 activityBarOrder 键与旧八模块图标条随
 *  v3.4.0 三栏外壳退役，现只剩成员资格被契约脚本当 APP_MODULES 快照锚用） */
export const BAR_MODULE_IDS = byFlag('bar')
/** 可钉成桌面磁贴的模块 */
export const TILE_MODULE_IDS = byFlag('tile')
/** 命令面板「打开模块」的清单（带名称） */
export const PALETTE_MODULES: Array<{ id: TabName; label: string }> =
  APP_MODULES.filter((m) => m.palette).map((m) => ({ id: m.id, label: m.label }))

const KNOWN_IDS: string[] = APP_MODULES.map((m) => m.id)

export function isTabName(v: unknown): v is TabName {
  return typeof v === 'string' && KNOWN_IDS.includes(v)
}

export function labelOf(id: TabName): string {
  return APP_MODULES.find((m) => m.id === id)?.label ?? id
}

/** 陈年 id 归一：`immersive` 是 aiTeaching 的旧名（AI教学 P0 改名时留下一批存量数据） */
export function normalizeModuleId(id: string): string {
  return id === 'immersive' ? 'aiTeaching' : id
}

function parseIdList(raw: string | undefined, fallback: TabName[]): string[] {
  try {
    const v = JSON.parse(String(raw ?? ''))
    if (Array.isArray(v)) return v.map((x) => normalizeModuleId(String(x)))
  } catch { /* 坏数据当空处理，走 fallback */ }
  return fallback.slice()
}

/**
 * **图标条（最左窄列）**的成员与规范顺序。
 *
 * ⚠️ 这不是 `bar: true` 那 8 个：图标条只放「整窗独占」的入口，笔记 / 博客 / 日程 / 工具箱
 * 现在是左栏书签的形态、不在图标条上（`recycle` 反过来是 `bar: false` 却在条上）。
 * 顶部「工作台」按钮与底部「设置」按钮由组件固定，不参与排序与显隐。
 *
 * 顺序与显隐走 settings 的 `railOrder` / `railHidden`（2026-09-26 起图标条是顺序/显隐的
 * 唯一承载 —— 旧 `activityBarOrder` / `activityBarHidden` 已随旧八模块图标条退役删除）。
 * `ActivityBar` 的图标表按 id 取，成员与顺序一律来自这里。
 */
export const RAIL_MODULE_IDS: TabName[] = ['aiTeaching', 'recycle', 'plugins', 'moments', 'bookMarket']

/** 图标条归一化顺序（含被隐藏的项）—— 拖拽后写回 `railOrder` 用的就是它 */
export function railOrder(rawOrder?: string): TabName[] {
  const stored = parseIdList(rawOrder, [])
  const order = stored.filter((id) => RAIL_MODULE_IDS.includes(id as TabName)) as TabName[]
  for (const id of RAIL_MODULE_IDS) if (!order.includes(id)) order.push(id)
  return order
}

/** 图标条里真正显示出来的按钮，顺序同 railOrder */
export function railVisibleOrder(rawOrder?: string, rawHidden?: string): TabName[] {
  const hidden = parseIdList(rawHidden, [])
  return railOrder(rawOrder).filter((id) => !hidden.includes(id))
}

/** 图标条被隐藏的按钮 id（右键菜单勾选态用；与 railVisibleOrder 同一份解析口径） */
export function railHiddenIds(rawHidden?: string): string[] {
  return parseIdList(rawHidden, [])
}
