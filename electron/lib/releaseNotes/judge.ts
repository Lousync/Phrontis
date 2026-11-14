/**
 * 更新说明的**纯判定区** —— 零依赖：不 import electron、不碰磁盘、不读时钟。
 *
 * 单独成文件的理由（不是为了好看）：
 * ① 契约脚本 `.AGENT/scripts/release-notes/verify-release-notes.mjs` 要**直接 import 这里**
 *    做表驱动验证。同一份逻辑若留在 `./index.ts`，脚本拿不到 —— 那个文件顶部
 *    `import { app, ipcMain } from 'electron'`，裸 node 解析 CJS 具名导出会当场失败。
 * ② 判定规则是这一版最容易「静默出错」的部分：弹错时机、把没读过的页面当成已读、
 *    让 patch 升级重复打扰。做成纯函数 = 边界可以穷举，而不是只能在真机上碰运气。
 *
 * 所以：**任何新的判定分支都加在这里，并同步补 verify 脚本的用例表**；
 * `./index.ts` 只负责「读 index.json → 调这里的函数 → 把 nextIndex 写回去」。
 */

import type { ReleaseNotesIndex } from './types'

/** 剥掉前导 v 与首尾空白。数据里的版本号约定不带 v，但用户 / 设置可能带 */
export function normalizeVersion(version: string): string {
  return String(version ?? '').replace(/^v/, '').trim()
}

/**
 * '3.1.0' → '3.1'；'3.1.0-beta.2' → '3.1'；'10.2.3' → '10.2'。
 * 前导 v 会先被剥掉（'v3.1.0' → '3.1'）；非标准版本号（无 `数字.数字` 前缀）原样返回。
 */
export function majorMinor(version: string): string {
  const v = normalizeVersion(version)
  const m = /^(\d+)\.(\d+)/.exec(v)
  return m ? `${m[1]}.${m[2]}` : v
}

/** 追加版本到 seen（去重、保序、只留最近 40 条）。返回新数组，不改入参 */
export function mergeSeen(seen: readonly string[], version: string): string[] {
  const v = normalizeVersion(version)
  const list = Array.isArray(seen) ? seen : []
  if (!v || list.includes(v)) return [...list]
  return [...list, v].slice(-40)
}

/**
 * major.minor 是否相对基线发生了变化（= 这个版本值得提醒一次）。
 *
 * - 首装 / 首次见到本仓库（基线为空）恒为 false —— 新用户先走新手引导，
 *   不该再塞一页更新说明。
 * - patch 升级（3.1.0 → 3.1.2）为 false —— 小补丁不打扰，用户能接受「不通知」，
 *   但接受不了「每次小更新都被弹一页」。
 *
 * 2026-11-14 更名（原 `shouldAutoOpenNotes`）：启动不再自动跳到更新说明页，
 * 改为**在看板出一枚入口**（见 decideStartup 的 unread）——这里只判「版本该不该提醒」，
 * 与「用什么形式提醒」无关。
 */
export function majorMinorChanged(currentVersion: string, baseline: string): boolean {
  const cur = normalizeVersion(currentVersion)
  const base = normalizeVersion(baseline)
  if (!cur || !base) return false
  return majorMinor(base) !== majorMinor(cur)
}

export interface NotesDecision {
  /**
   * 是否有**未读**的本版说明（= 该在看板上出提醒入口）。
   * 与「新版本时在看板提醒」开关解耦：开关由渲染层决定要不要真的画出来，
   * 判定层只回答「有没有东西可读」。
   */
  unread: boolean
  /** 需要落盘的下一份阅读记录；`null` = 本次不必写盘 */
  nextIndex: ReleaseNotesIndex | null
}

function indexWith(index: ReleaseNotesIndex, lastShown: string, version: string, nowIso: string): ReleaseNotesIndex {
  return {
    lastShown,
    seen: mergeSeen(index.seen, version),
    updatedAt: nowIso,
  }
}

/**
 * 启动时的判定（纯函数版）。三种情形：
 *
 * | 情形 | unread | 是否写盘 |
 * |---|---|---|
 * | ① 无基线（全新安装 / 首次见到本仓库） | false | **写**：把基线记成当前版本 |
 * | ② 同 major.minor（含 patch 升级） | false | 仅当基线 ≠ 当前版本时写（推进基线） |
 * | ③ major.minor 变了 | `hasNotes` | **不写** |
 *
 * 情形③ 故意不写盘：用户可能根本没看到这一页（刚渲染就崩了 / 立刻切走）。
 * 基线由渲染层页面**成功展示后**调 `markShown` 写入 —— 否则一次异常启动
 * 就会把「未读」标成「已读」，用户再也没有第二次机会看到。
 *
 * 情形② 的「仅当基线 ≠ 当前版本时写」：patch 升级也要推进基线，
 * 否则 lastShown 永远停在旧 patch 上，之后每次启动都要重跑一遍判定。
 */
export function decideStartup(
  currentVersion: string,
  index: ReleaseNotesIndex,
  hasNotes: boolean,
  nowIso: string,
): NotesDecision {
  const cur = normalizeVersion(currentVersion)
  const baseline = normalizeVersion(index?.lastShown ?? '')

  // ① 无基线
  if (!baseline) {
    return { unread: false, nextIndex: indexWith(index, cur, cur, nowIso) }
  }

  // ② 同 major.minor
  if (!majorMinorChanged(cur, baseline)) {
    if (baseline === cur) return { unread: false, nextIndex: null }
    return { unread: false, nextIndex: indexWith(index, cur, cur, nowIso) }
  }

  // ③ major.minor 变化：不写盘，等渲染层确认（页面展示过才推进基线）
  return { unread: hasNotes, nextIndex: null }
}

/**
 * 渲染层确认「这一页展示过了」时的判定。
 *
 * 只有**当前应用版本**才会推进基线：用户翻看 v2.9.0 的历史说明不该把基线拨回去，
 * 否则下次真升级时的判定窗口就错了（会被判成「同 major.minor」而永不弹）。
 * 非当前版本只记进 seen —— 留个「这本仓库见过哪些版本」的痕迹。
 */
export function decideMarkShown(
  version: string,
  currentVersion: string,
  index: ReleaseNotesIndex,
  nowIso: string,
): ReleaseNotesIndex {
  const v = normalizeVersion(version)
  const cur = normalizeVersion(currentVersion)
  if (v === cur) return indexWith(index, v, v, nowIso)
  return { ...index, seen: mergeSeen(index.seen, v), updatedAt: nowIso }
}
