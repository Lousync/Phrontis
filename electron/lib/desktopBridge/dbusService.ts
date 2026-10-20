import * as dbus from 'dbus-next'
import { localToday } from '../../../src/lib/date'
import { broadcastDataChanged } from '../../main/windowBus'
import { vaultHabitsAll } from '../kbStore/habitVaultRepo'
import { vaultSearchPages } from '../kbStore/knowledgeVaultRepo'
import { toggleTodoDone } from '../todoActions'
import { setHabitChecked } from '../habitActions'
import { readTodaySnapshot } from './dayService'

/**
 * 桌面集成的对外接口（D-Bus，会话总线）。
 *
 * 契约见 `phrontis-desktop-integration/docs/interface.md`（`Core1`）。
 * 原则：**只覆盖轻动作**，不含写正文；消费方（GNOME 扩展 / 托盘 / CLI）不得直接碰 vault 文件。
 *
 * 2026-10-20（阶段 1 第一批）落地范围：
 *   GetToday / ToggleTodo / CheckIn / OpenApp / Search / GetCapabilities + Changed
 *   `PomodoroControl` 留给下一批（权威状态机在渲染层，需要一条下行命令通道）。
 *
 * 名字：正式版 `io.github.lousync.Phrontis`；dev 用 `.Dev` 后缀 —— 否则 `npm run dev` 会
 * 和已安装的正式版抢同一个总线名，后启动的那个只能排队（表象：接口调用打到了另一个实例）。
 * 可用 `PHRONTIS_BUS_NAME` 覆盖（契约脚本用它避免污染真实会话）。
 */

export const DEFAULT_BUS_NAME = 'io.github.lousync.Phrontis'
export const DEV_BUS_NAME = 'io.github.lousync.Phrontis.Dev'
export const OBJECT_PATH = '/io/github/lousync/Phrontis'
export const INTERFACE = 'io.github.lousync.Phrontis.Core1'

/** 能力表：消费方用它探测，**不要拿版本号猜**（接口只做加法） */
export const CAPABILITIES = ['today', 'todo', 'checkin', 'search', 'open'] as const

export function resolveBusName(packaged: boolean): string {
  const override = process.env.PHRONTIS_BUS_NAME?.trim()
  if (override) return override
  return packaged ? DEFAULT_BUS_NAME : DEV_BUS_NAME
}

interface BridgeOptions {
  packaged: boolean
  showWindow: () => void
}

type ChangedEmitter = { Changed: (scope: string) => void }

class Core1 extends dbus.interface.Interface {
  private readonly opts: BridgeOptions

  constructor(opts: BridgeOptions) {
    super(INTERFACE)
    this.opts = opts
  }

  GetToday(): unknown[] {
    const day = readTodaySnapshot(localToday())
    return [
      day.date,
      day.todos.map(t => [t.id, t.text, t.done, t.due, t.quadrant]),
      day.habits.map(h => [h.id, h.name, h.doneToday, h.streak, h.target]),
      [day.pomo.state, day.pomo.leftSeconds, day.pomo.totalSeconds],
    ]
  }

  ToggleTodo(id: string): boolean {
    const ok = toggleTodoDone(String(id ?? ''))
    if (ok) broadcastDataChanged('schedule')
    return ok
  }

  /** 幂等：已经是目标状态也返回 true（消费方不必先查再写） */
  CheckIn(habitId: string, value: boolean): boolean {
    const id = String(habitId ?? '')
    if (!id || !vaultHabitsAll().some(h => h.id === id)) return false
    const changed = setHabitChecked(id, localToday(), !!value)
    if (changed) broadcastDataChanged('habit')
    return true
  }

  /**
   * 唤起窗口。`target` 目前支持 '' / 'today' / 'pomodoro'；
   * `relPath` 跳转需要渲染层的开页签通道，阶段 2 再接（现在明确返回 false，不假装成功）。
   */
  OpenApp(target: string): boolean {
    const t = String(target ?? '').trim()
    if (t === '' || t === 'today' || t === 'pomodoro') {
      this.opts.showWindow()
      return true
    }
    console.warn('[desktop] OpenApp 的 relPath 目标尚未实现（阶段 2）：', t)
    return false
  }

  /** 只搜标题 / 正文 / 标签，返回仓库相对路径（够启动器用） */
  Search(query: string, limit: number): string[] {
    const q = String(query ?? '').trim()
    if (!q) return []
    const n = Math.min(50, Math.max(1, Math.trunc(Number(limit)) || 20))
    try {
      return vaultSearchPages(q)
        .map(p => p.path)
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .slice(0, n)
    } catch (e) {
      console.warn('[desktop] Search 失败:', e)
      return []
    }
  }

  GetCapabilities(): string[] {
    return [...CAPABILITIES]
  }
}

Core1.configureMembers({
  methods: {
    // Day = (s date, a(ssbsi) todos, a(ssbii) habits, (iii) pomo)
    GetToday: { inSignature: '', outSignature: '(sa(ssbsi)a(ssbii)(iii))' },
    ToggleTodo: { inSignature: 's', outSignature: 'b' },
    CheckIn: { inSignature: 'sb', outSignature: 'b' },
    OpenApp: { inSignature: 's', outSignature: 'b' },
    Search: { inSignature: 'si', outSignature: 'as' },
    GetCapabilities: { inSignature: '', outSignature: 'as' },
  },
  signals: {
    Changed: { signature: 's' },
  },
})

export interface DesktopBridgeHandle {
  busName: string
  /** 向所有消费方发 Changed（幂等由消费方自己保证） */
  emitChanged: (scope: string) => void
  stop: () => void
}

/**
 * 注册会话总线名并导出对象。总线不可用（无 session bus）时只告警、返回 null ——
 * 桌面集成是增强，不该让主应用起不来。
 */
export async function startDesktopBridge(opts: BridgeOptions): Promise<DesktopBridgeHandle | null> {
  if (process.platform !== 'linux') return null
  const bus = dbus.sessionBus()
  const iface = new Core1(opts)
  const busName = resolveBusName(opts.packaged)
  let stopped = false

  bus.on('error', (e: Error) => console.warn('[desktop] D-Bus 错误:', e?.message ?? e))
  bus.export(OBJECT_PATH, iface)

  try {
    // DO_NOT_QUEUE：别的实例（比如 dev 与正式版同名配置）已经占名时**直接失败**，
    // 而不是排队等对方退出（排队会让调用方一直挂在「无响应」上）。
    const reply = await bus.requestName(busName, dbus.NameFlag.DO_NOT_QUEUE)
    if (reply !== dbus.RequestNameReply.PRIMARY_OWNER && reply !== dbus.RequestNameReply.ALREADY_OWNER) {
      console.warn(`[desktop] 总线名 ${busName} 已被占用（reply=${reply}），桌面集成不启用`)
      bus.disconnect()
      return null
    }
    console.log('[desktop] D-Bus 服务已就绪:', busName, OBJECT_PATH, INTERFACE)
  } catch (e) {
    console.warn('[desktop] 注册 D-Bus 失败（桌面集成不启用）:', (e as Error)?.message ?? e)
    try { bus.disconnect() } catch { /* ignore */ }
    return null
  }

  return {
    busName,
    emitChanged: (scope: string) => {
      if (stopped) return
      try { (iface as unknown as ChangedEmitter).Changed(scope) } catch { /* 消费方断开等，忽略 */ }
    },
    stop: () => {
      if (stopped) return
      stopped = true
      try { bus.disconnect() } catch { /* ignore */ }
    },
  }
}
