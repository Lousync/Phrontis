/**
 * 更新说明（release notes）—— 主进程业务层。
 *
 * 三层数据：
 *   ① 完整条目清单 `./data.ts`（由 CHANGELOG.md 生成，随应用发布）
 *   ② 手写亮点    `./highlights.ts`（发版前人工维护与审核）
 *   ③ 阅读记录    `<仓库>/.knowbase/modules/release-notes/index.json`（本文件负责读写）
 *
 * 为什么③落在仓库里而不是全局设置：仓库 = 账户（本仓既有口径），
 * 「这个仓库看过哪几版的更新说明」属于仓库级事实；同时顺带把当前版本说明留档，
 * 换电脑拷走仓库就能一起带走。
 *
 * 触发规则（详见 docs/release-notes-design.md）：
 *   - 只在 **major.minor 变化** 时自动打开（patch 版本不打扰）；这对应「中间版本号的提升」
 *   - **首次安装（无阅读记录）只写记录、不弹** —— 新用户先走新手引导，不该再塞一页更新说明
 *   - 当前版本没有对应说明数据时也不弹（避免打开一个空页）
 */

import { app, ipcMain } from 'electron'
import { readJson, writeJson } from 'phrontis-core/kbStore/jsonStore'
import { RELEASE_NOTES } from './data'
import { RELEASE_NOTE_HIGHLIGHTS } from './highlights'
import {
  RELEASE_NOTES_MODULE, RELEASE_NOTES_INDEX_KEY,
  type ReleaseNote, type ReleaseNoteHighlight, type ReleaseNotesIndex, type ReleaseNotesState,
} from './types'
import { decideMarkShown, decideStartup, normalizeVersion } from './judge'

// 判定规则本体在 ./judge.ts（零依赖纯函数，契约脚本可直接 import）。
// 这里转出去，让「规则」只有一个可引用的入口。
export { majorMinor, shouldAutoOpenNotes, mergeSeen, normalizeVersion } from './judge'

/** 设置读取器（registerReleaseNotesHandlers 注入），与 updateService / quizRepo 同款接法 */
let getSettingValue: (key: string) => unknown = () => undefined

const EMPTY_INDEX: ReleaseNotesIndex = { lastShown: '', seen: [], updatedAt: '' }

// ---------------------------------------------------------------- 版本号

/**
 * 当前应用版本。
 *
 * 开发期可被 `KNOWBASE_FAKE_APP_VERSION` 覆盖（**仅未打包时生效**）——
 * 否则 dev 下 `app.getVersion()` 恒为 package.json 里的版本，
 * 「升级后自动弹出」这条路径在开发机上根本走不到，只能靠改仓库里的
 * index.json 反着造，很不直观。生产构建完全不受影响。
 */
export function currentAppVersion(): string {
  if (!app.isPackaged) {
    const fake = String(process.env.KNOWBASE_FAKE_APP_VERSION || '').trim()
    if (fake) return fake.replace(/^v/, '')
  }
  return app.getVersion()
}

// majorMinor / shouldAutoOpenNotes / decideStartup / decideMarkShown 见 ./judge.ts

// ---------------------------------------------------------------- 阅读记录

function sanitizeIndex(raw: unknown): ReleaseNotesIndex {
  const o = (raw || {}) as Partial<ReleaseNotesIndex>
  return {
    lastShown: typeof o.lastShown === 'string' ? o.lastShown : '',
    seen: Array.isArray(o.seen) ? o.seen.filter((x): x is string => typeof x === 'string') : [],
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
  }
}

function readIndex(): ReleaseNotesIndex {
  return sanitizeIndex(readJson<ReleaseNotesIndex>(RELEASE_NOTES_MODULE, RELEASE_NOTES_INDEX_KEY, EMPTY_INDEX))
}

function writeIndex(next: ReleaseNotesIndex): boolean {
  return writeJson(RELEASE_NOTES_MODULE, RELEASE_NOTES_INDEX_KEY, next)
}

// ---------------------------------------------------------------- 数据访问

export function findReleaseNote(version: string): ReleaseNote | null {
  const v = String(version || '').replace(/^v/, '')
  return RELEASE_NOTES.find((n) => n.version === v) ?? null
}

export function findHighlights(version: string): readonly ReleaseNoteHighlight[] {
  const v = String(version || '').replace(/^v/, '')
  return RELEASE_NOTE_HIGHLIGHTS.filter((h) => h.version === v)
}

/** 版本列表（倒序，与 CHANGELOG 一致）——「查看全部版本」用，不带条目正文 */
export function listReleaseNotes(): Array<{ version: string; date: string; summary: string; itemCount: number }> {
  return RELEASE_NOTES.map((n) => ({
    version: n.version,
    date: n.date,
    summary: n.summary,
    itemCount: n.groups.reduce((a, g) => a + g.items.length, 0),
  }))
}

/** 单版本完整内容（清单 + 亮点） */
export function getReleaseNoteDetail(version: string): {
  note: ReleaseNote | null
  highlights: readonly ReleaseNoteHighlight[]
} {
  return { note: findReleaseNote(version), highlights: findHighlights(version) }
}

// ---------------------------------------------------------------- 判定
// 规则本体在 ./judge.ts（零依赖纯函数，契约脚本直接验它）。
// 本文件只做「读 index.json → 调判定 → 把 nextIndex 写回去」这一步。

function truthySetting(key: string, fallback: boolean): boolean {
  const v = getSettingValue(key)
  return typeof v === 'boolean' ? v : fallback
}

/**
 * 启动检测。**所有副作用（推进基线）都集中在这里**，渲染层只读返回值。
 *
 * 三种情形的真值表与取舍理由见 ./judge.ts 的 decideStartup —— 规则不写在这里。
 * 本函数是它唯一的调用点：读 index.json → 判定 → 按需把 nextIndex 写回去。
 */
export function getReleaseNotesState(): ReleaseNotesState {
  const currentVersion = currentAppVersion()
  const index = readIndex()
  const hasNotes = !!findReleaseNote(currentVersion)
  const autoOpenOn = truthySetting('releaseNotesAutoOpen', true)

  const { shouldAutoOpen, nextIndex } = decideStartup(
    currentVersion,
    index,
    hasNotes,
    autoOpenOn,
    new Date().toISOString(),
  )
  if (nextIndex) writeIndex(nextIndex)

  return { currentVersion, hasNotes, shouldAutoOpen }
}

/**
 * 渲染层确认「这一页展示过了」→ 推进基线（lastShown），并留档该版本说明。
 *
 * 只有**当前应用版本**才会推进基线（理由见 ./judge.ts 的 decideMarkShown）：
 * 用户翻看 v2.9.0 的历史说明不该把基线拨回去。
 */
export function markReleaseNotesShown(version: string): { ok: boolean; error?: string } {
  const v = normalizeVersion(version)
  if (!v) return { ok: false, error: '缺少版本号' }

  const stamp = new Date().toISOString()
  const nextIndex = decideMarkShown(v, currentAppVersion(), readIndex(), stamp)
  if (!writeIndex(nextIndex)) {
    return { ok: false, error: '写入失败（可能没有打开仓库，或磁盘不可写）' }
  }

  // 留档：整份该版本说明（清单 + 亮点）落一份到仓库，用户可直接翻阅、也便于 AI 读取
  if (truthySetting('releaseNotesKeepHistory', true)) {
    const { note, highlights } = getReleaseNoteDetail(v)
    if (note) {
      writeJson(RELEASE_NOTES_MODULE, `v${v}.json`, {
        version: note.version,
        date: note.date,
        summary: note.summary,
        highlights,
        groups: note.groups,
        archivedAt: stamp,
      })
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------- IPC

export function registerReleaseNotesHandlers(deps?: { getSettingValue?: (key: string) => unknown }): void {
  if (deps?.getSettingValue) getSettingValue = deps.getSettingValue

  ipcMain.handle('releaseNotes:getState', () => getReleaseNotesState())
  ipcMain.handle('releaseNotes:markShown', (_e, version: string) => markReleaseNotesShown(version))
  ipcMain.handle('releaseNotes:get', (_e, version: string) => getReleaseNoteDetail(version))
  ipcMain.handle('releaseNotes:list', () => listReleaseNotes())
}
