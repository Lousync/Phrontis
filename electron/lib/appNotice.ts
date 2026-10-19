import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { ipcMain } from 'electron'
import { globalDataDir, globalReadJson, globalWriteJson } from './globalJsonStore'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'

/**
 * 主进程 → 渲染层的**用户可见告警**唯一出口（2026-10-19，Linux 平台化阶段 1）。
 *
 * 为什么需要它：启动期有几类「功能降级但进程照跑」的事实，原先只有主进程 `console.warn`
 * 能看到 —— 而从桌面图标启动时**用户根本看不到终端**（N-1「日志能拿到」同源问题）。
 * 于是「全局快捷键没注册上」「文件监听配额不足」「回收站不可用」都会表现为「功能悄悄没了」。
 *
 * ★ 投递策略 = **队列 + 广播**，两者都要（同 agent-adopt-notice 的取向）：
 *   · 渲染层还没起来时要**留在文件里**（队列）—— 启动期告警就发生在窗口加载之前，
 *     纯广播会打在一个还没有监听者的窗口上，静默丢失；文件队列跨重载、跨重启不丢。
 *   · 渲染层起来之后（`takeAppNotices()` 被调用即视为就绪）改为**只广播** ——
 *     否则转载入队列会在下次启动时把同一条旧告警再弹一遍。
 *
 * `id` 是渲染层去重用的：同一 session 内「订阅 + 取队列」有一个极小的重叠窗口，
 * 那一瞬间推送的告警会既走广播又落在取回结果里（同一 id），渲染层按 id 去重即可。
 */

const NOTICE_FILE = 'app-notices.json'

/** 队列上限：启动期告警只该是个位数；坏状态下也不让它无界增长（保留最新的） */
const MAX_QUEUE = 20

export interface AppNotice {
  id: string
  type: 'info' | 'warning' | 'error'
  /** 一句话现象（Toast 主行） */
  message: string
  /** 「怎么办」那一句（Toast 明细行，可选） */
  detail?: string
}

let seq = 0
/** 渲染层是否已就绪（调过 takeAppNotices）——是则只广播，不再入队 */
let rendererReady = false

/** 登记一条告警（主进程侧唯一入口；渲染层只负责展示，不参与判定） */
export function pushAppNotice(notice: Omit<AppNotice, 'id'>): void {
  const item: AppNotice = { ...notice, id: `n${++seq}.${Date.now()}` }
  if (rendererReady) {
    try { broadcast(BROADCAST_CHANNEL.appNotice, item) } catch { /* 没有窗口就没人看，不阻断 */ }
    return
  }
  try {
    const cur = globalReadJson<AppNotice[]>(NOTICE_FILE, [])
    const list = Array.isArray(cur) ? cur : []
    globalWriteJson(NOTICE_FILE, [...list, item].slice(-MAX_QUEUE))
  } catch {
    // 队列写不进去（目录不可写等）也不能影响启动：退化为「只广播」，
    // 渲染层若刚好已起来还能看到，看不到也不该让调用方的流程失败。
  }
  try { broadcast(BROADCAST_CHANNEL.appNotice, item) } catch { /* ignore */ }
}

/** 取走全部待取告警（**取走即删**，见头注释的投递策略）；同时把渲染层标记为就绪 */
export function takeAppNotices(): AppNotice[] {
  rendererReady = true
  const raw = globalReadJson<AppNotice[]>(NOTICE_FILE, [])
  const list = Array.isArray(raw) ? raw : []
  if (list.length === 0) return []
  try {
    const p = join(globalDataDir(), NOTICE_FILE)
    if (existsSync(p)) unlinkSync(p)
  } catch {
    // 删不掉就留着：下次启动会再提示一次（宁可重复一次，也不要谎报「已告知」）
  }
  return list
}

/** IPC 注册（读端唯一出口：app:takeNotices） */
export function registerAppNoticeHandlers(): void {
  ipcMain.handle('app:takeNotices', () => takeAppNotices())
}
