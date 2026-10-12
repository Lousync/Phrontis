/**
 * 笔记区「页面访问历史」——顶栏左端 `← →` 的数据源（2026-10-11 对齐 Obsidian 拍板）。
 *
 * 为什么单独一个文件、还写成纯函数：
 *   · 栈本身要跨「点页签 / 点双链 / 图谱跳转 / 沉浸阅读内跳转」共用，收口在模块层；
 *   · 但「截断前进分支 / 去重 / 上限 / 跳过失效条目」这类规则最容易写飞，
 *     所以要能被契约脚本直接 import 跑用例表（同 `electron/lib/releaseNotes/judge.ts` 的手法）。
 * 约束：本例只存 pageId，**不落盘**（重启即清空，拍板口径）。
 */

/** 栈上限（超出从头丢最旧的一条） */
export const NAV_HISTORY_CAP = 50

export interface NavState {
  /** 访问顺序的 pageId 列表 */
  stack: string[]
  /** 当前所在下标；空栈为 -1 */
  index: number
}

export const emptyNav = (): NavState => ({ stack: [], index: -1 })

/**
 * 入栈（打开一个页面时调用）。
 *
 * 三条规则，按序生效：
 *   ① **截断前进分支**——从历史中间退回去后又开了新页，原「前进」分支作废（浏览器同款语义）；
 *   ② **与栈顶同 id 不入**——重复点同一页不该撑出一串重复条目；
 *   ③ **超上限从头丢**——丢最旧的，保留最近 `cap` 条。
 */
export function pushNav(state: NavState, id: string, cap: number = NAV_HISTORY_CAP): NavState {
  if (!id) return state
  const head = state.stack.slice(0, Math.max(state.index + 1, 0))
  if (head.length > 0 && head[head.length - 1] === id) return { stack: head, index: head.length - 1 }
  const stack = [...head, id]
  while (stack.length > cap) stack.shift()
  return { stack, index: stack.length - 1 }
}

export const canNavBack = (s: NavState): boolean => s.index > 0
export const canNavForward = (s: NavState): boolean => s.index >= 0 && s.index < s.stack.length - 1

/** 当前所在条目（无则 null） */
export const currentNav = (s: NavState): string | null => s.stack[s.index] ?? null

/**
 * 前进 / 后退一步：走到该方向上**第一个仍然有效**的条目。
 *
 * `valid` 由调用方给（模块查页签表 / 页面索引）——页面被删、页签被关之后历史里会留死条目，
 * 直接跳会「点了没反应」，所以这里必须一路跳过；整段都无效就返回原 state（按钮随之保持禁用）。
 */
export function stepNav(
  state: NavState,
  dir: -1 | 1,
  valid: (id: string) => boolean,
): { state: NavState; id: string | null } {
  let i = state.index + dir
  while (i >= 0 && i < state.stack.length) {
    const id = state.stack[i]
    if (valid(id)) return { state: { stack: state.stack, index: i }, id }
    i += dir
  }
  return { state, id: null }
}
