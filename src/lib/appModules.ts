import type { TabName } from '../types'

/**
 * 模块清单的**唯一真相源**。
 *
 * 为什么要有这个文件：模块清单原本被抄在 6 个地方，各自演化、已经飘了 ——
 *   · `App.tsx` 的 `MODULE_TABS`（命令面板 / 分屏）        —— 少了 aiTeaching
 *   · `App.tsx` 的启动回退候选 `all`                        —— 少了 desktop / aiTeaching，多了 recycle / help
 *   · `App.tsx` 的小窗 `switch-tab` 白名单                  —— 少了 desktop / editor / aiTeaching
 *   · `ActivityBar.tsx` 的 `ALL_MODULES`（右键显隐）        —— 只有 9 个 bar 模块
 *   · `settings.ts` 的 `activityBarOrder` 默认值            —— 混着 `export` / `recycle` 两个陈年 id
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
  /** 可作为「启动时默认显示」的落点 */
  startable: boolean
  /** 可钉成桌面磁贴 / 出现在桌面「添加控件」面板 */
  tile: boolean
  /** 出现在命令面板的「打开模块」 */
  palette: boolean
}

/**
 * ⚠️ 顺序即默认顺序，改动前先看两个消费者：
 *   · `PALETTE_MODULES`（命令面板按此顺序列出）
 *   · 活动栏「追加尚未进 activityBarOrder 的模块」也按此顺序
 * v3.4.0 工作台三栏外壳：`desktop`（磁贴壳）被三栏外壳整体替代、`user`（账户）并入设置，
 * 两者从清单删除；新增 `bookshelf` / `aiChat` / `graph` 三个「入口产生型」Tab。
 */
export const APP_MODULES = [
  { id: 'editor', label: '编辑器', bar: true, startable: true, tile: true, palette: true },
  { id: 'knowledge', label: '知识库', bar: true, startable: true, tile: true, palette: true },
  { id: 'blog', label: '博客', bar: true, startable: true, tile: true, palette: true },
  { id: 'schedule', label: '日程', bar: true, startable: true, tile: true, palette: true },
  { id: 'moments', label: '动态', bar: true, startable: true, tile: true, palette: true },
  { id: 'aiTeaching', label: 'AI教学', bar: true, startable: true, tile: true, palette: true },
  { id: 'toolbox', label: '工具箱', bar: true, startable: true, tile: true, palette: true },
  { id: 'plugins', label: '插件', bar: true, startable: true, tile: true, palette: true },
  // 以下不进活动栏图标位：只能从设置菜单 / 事件 / 命令打开，也**不当启动落点**
  // （「回收站」「帮助」是刻意去才会去的目的地，当启动落点必是 bug）
  { id: 'recycle', label: '回收站', bar: false, startable: false, tile: true, palette: true },
  { id: 'help', label: '帮助', bar: false, startable: false, tile: true, palette: true },
  // v3.4.0 新增「入口产生型」Tab：只能由工作台入口产生（书架=左栏书签、AI对话=⤢、图谱=知识库跳转），
  // 不进命令面板、不当启动落点——关掉后想再开，从对应入口再点一次即可（幂等哲学）
  { id: 'bookshelf', label: '书架', bar: false, startable: false, tile: false, palette: false },
  { id: 'aiChat', label: 'AI对话', bar: false, startable: false, tile: false, palette: false },
  { id: 'graph', label: '知识图谱', bar: false, startable: false, tile: false, palette: false },
  { id: 'releaseNotes', label: '更新说明', bar: false, startable: false, tile: true, palette: false },
  { id: 'settings', label: '设置', bar: false, startable: false, tile: true, palette: true },
  { id: 'devtools', label: '开发者工具', bar: false, startable: false, tile: false, palette: false },
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

const byFlag = (k: 'bar' | 'startable' | 'tile' | 'palette'): TabName[] =>
  APP_MODULES.filter((m) => m[k]).map((m) => m.id)

/** 活动栏图标位模块（成员；顺序由 settings 的 activityBarOrder 决定） */
export const BAR_MODULE_IDS = byFlag('bar')
/** 可作为「启动时默认显示」的模块 */
export const STARTABLE_MODULE_IDS = byFlag('startable')
/** 可钉成桌面磁贴的模块 */
export const TILE_MODULE_IDS = byFlag('tile')
/** 命令面板「打开模块」的清单（带名称） */
export const PALETTE_MODULES: Array<{ id: TabName; label: string }> =
  APP_MODULES.filter((m) => m.palette).map((m) => ({ id: m.id, label: m.label }))

/**
 * 工作台顶部模块切换条固定清单（v3.4.0 方案 §3.2；2026-09-16 第二轮 UI 反馈拍板）：
 * 切换条 = **固定模块单选切换器**（「其他模块整合进了工作台」心智，跟旧版顶部一个效果），
 * 不是 openTabs 停靠标签。成员从 APP_MODULES 派生、排除 aiTeaching / devtools
 * （排除清单见 workbenchLayout.WORKBENCH_TABBAR_EXCLUDED）——新增 TabName 进了
 * APP_MODULES 就自动出现在切换条，无需另改。
 */
export const WORKBENCH_SWITCHER_TABS: readonly TabName[] = APP_MODULES
  .map((m) => m.id)
  .filter((id) => !(id === 'aiTeaching' || id === 'devtools'))

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
 * 活动栏归一化顺序（含被隐藏的项）—— 拖拽后写回 `activityBarOrder` 用的就是它。
 * `ActivityBar` 与启动回退共用这一份，杜绝「两处各算一遍、迟早对不上」。
 */
export function activityOrder(rawOrder?: string): TabName[] {
  const stored = parseIdList(rawOrder, [])
  const order = stored.filter((id) => BAR_MODULE_IDS.includes(id as TabName)) as TabName[]
  for (const id of BAR_MODULE_IDS) if (!order.includes(id)) order.push(id)
  return order
}

/** 活动栏里真正显示出来的模块，顺序同 activityOrder */
export function activityVisibleOrder(rawOrder?: string, rawHidden?: string): TabName[] {
  const hidden = parseIdList(rawHidden, [])
  return activityOrder(rawOrder).filter((id) => !hidden.includes(id))
}

/**
 * 启动时该落到哪个 Tab。
 *
 * 规则（刻意做得很钝，钝才不会出意外）：
 *   ① 用户选了 `startupTab`、且它是可启动模块、且没被隐藏 → 就用它；
 *   ② 其余一切情况 → **编辑区兜底**（v3.4.0 起三栏外壳的默认主区即编辑区标签）。
 *
 * 曾经的做法是「按 activityBarOrder 逐项找，找不到就按一张硬编码清单找第一个没隐藏的」——
 * 而那张清单里含 `recycle` / `help`，这两个模块又不在活动栏的显隐菜单里（永远隐藏不掉），
 * 于是「把侧边栏模块全隐藏 + 重启」必然落到回收站。钝规则从根上消掉了这类兜底事故。
 */
export function resolveStartupTab(rawStartupTab?: string, rawHidden?: string): TabName {
  const t = String(rawStartupTab ?? '')
  const hidden = parseIdList(rawHidden, [])
  if (t && (STARTABLE_MODULE_IDS as string[]).includes(t) && !hidden.includes(t)) return t as TabName
  return 'editor'
}
