import { lazy, Suspense } from 'react'
import {
  Shield, Globe, Archive, Wifi, Scissors, Timer, CalendarCheck2, BellRing, FileText,
  Puzzle, ArrowLeft,
} from 'lucide-react'
import { PasswordVault } from '../../modules/toolbox/components/PasswordVault'
import { HabitTracker } from '../../modules/toolbox/components/habit-tracker'
import { BookmarkNav } from '../../modules/toolbox/components/bookmark-nav'
import { RemoteSupervise } from '../../modules/toolbox/components/remote-supervise'
import { ExportTool } from '../../modules/toolbox/components/export/ExportTool'
import { LanShare } from '../../modules/toolbox/components/lan-share'
import { WebClipper } from '../../modules/toolbox/components/web-clipper'
import { PluginFrame } from '../shared/PluginFrame'
import { showToast } from '../../lib/toast'
import type { PluginTool } from '../../lib/pluginService'

// PdfToolkit 内联 pdfjs（~800KB）：不进首屏，打开该工具时才加载
// （原 toolbox/index.tsx 同款口径，随注册表一起迁到这里）
const PdfToolkit = lazy(() => import('../../modules/toolbox/components/pdf-toolkit').then((m) => ({ default: m.PdfToolkit })))

/**
 * 工具注册表（v3.4.0 方案 §10.3，2026-09-17 拍板：右栏上部 = 工具箱工具入口区）。
 *
 * 原 `src/modules/toolbox/index.tsx` 的 DATA_TOOLS / PRODUCTIVITY_TOOLS 常量与
 * renderTool case 映射**整体迁到这里**，工具箱画廊与右栏入口区共同消费——
 * 右栏入口区（ToolLauncherZone）只依赖本文件，避免 shared/workbench → modules 的
 * 散点直连；工具清单与「id → 组件」映射从此只有一份（加工具只改这里）。
 *
 * `color` = 入口区条目右端彩色竖条（原型 v16 双列书签条语言，参照 v15 书签六色系）。
 */

export interface ToolMeta {
  id: string
  name: string
  /** 分组：data = 数据工具（入口区左列）/ prod = 效率工具（入口区右列） */
  group: 'data' | 'prod'
  color: string
  Icon: typeof Shield
}

export const BUILTIN_TOOLS: ToolMeta[] = [
  { id: 'password-vault', name: '密码本', group: 'data', color: '#e0524f', Icon: Shield },
  { id: 'bookmark-nav', name: '网址导航', group: 'data', color: '#4f6ef2', Icon: Globe },
  { id: 'data-export', name: '数据导出', group: 'data', color: '#3fae6a', Icon: Archive },
  { id: 'lan-share', name: '设备传输', group: 'data', color: '#e8842c', Icon: Wifi },
  { id: 'web-clipper', name: '网页剪藏', group: 'data', color: '#a06be0', Icon: Scissors },
  { id: 'pomodoro', name: '番茄钟', group: 'prod', color: '#4f6ef2', Icon: Timer },
  { id: 'habit-tracker', name: '习惯打卡', group: 'prod', color: '#3fae6a', Icon: CalendarCheck2 },
  { id: 'remote-supervise', name: '远程监督', group: 'prod', color: '#e0524f', Icon: BellRing },
  { id: 'pdf-toolkit', name: 'PDF 工具箱', group: 'prod', color: '#a06be0', Icon: FileText },
]

/** 可深链激活的内置工具 id 白名单（无效 id 忽略，避免 ToolHost 落 default 白屏） */
export const DEEPLINKABLE_TOOL_IDS = new Set(BUILTIN_TOOLS.map((t) => t.id))

export function findTool(id: string): ToolMeta | undefined {
  return BUILTIN_TOOLS.find((t) => t.id === id)
}

/* ================= 工具标签页 id 约定（v3.4.0 批次4） =================
 * 中间标签条 = openTabs 动态标签，元素是 TabName 或工具标签 id（`tool:<toolId>`）。
 * 工具不占 TabName（方案定案：TabName 冻结 16 项），只在前缀约定的字符串空间里存活；
 * 重复点击同入口 = 激活已有标签（openTabs includes 判定），关闭走文档标签通用 ✕。 */
export const TOOL_TAB_PREFIX = 'tool:'

export function toolTabId(toolId: string): string {
  return TOOL_TAB_PREFIX + toolId
}

export function isToolTabId(id: string): boolean {
  return id.startsWith(TOOL_TAB_PREFIX)
}

export function toolIdOfTab(tabId: string): string {
  return tabId.slice(TOOL_TAB_PREFIX.length)
}

/**
 * 工具全屏宿主：按 toolId 渲染对应工具组件（原 toolbox renderTool 的 case 映射）。
 * 工具箱模块（画廊内进入）与右栏入口区开的工具标签页共用——
 * onBack 由宿主语境决定：工具箱 = 回画廊，标签页 = 关闭标签。
 * 番茄钟不走本宿主（点击 = pomodoro:activate 全屏面板，沿用既有语义）。
 */
export function ToolHost({ toolId, onBack }: { toolId: string; onBack: () => void }) {
  switch (toolId) {
    case 'password-vault':
      return <PasswordVault onBack={onBack} />
    case 'habit-tracker':
      return <HabitTracker onBack={onBack} />
    case 'remote-supervise':
      return <RemoteSupervise onBack={onBack} />
    case 'pdf-toolkit':
      return (
        <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-muted)]">正在加载 PDF 工具…</div>}>
          <PdfToolkit onBack={onBack} />
        </Suspense>
      )
    case 'bookmark-nav':
      return <BookmarkNav onBack={onBack} />
    case 'data-export':
      return <ExportTool onBack={onBack} />
    case 'lan-share':
      return <LanShare onBack={onBack} />
    case 'web-clipper':
      return <WebClipper onBack={onBack} />
    default:
      return null
  }
}

/** UI 插件宿主：sandbox iframe 加载 plugin:// 页面，postMessage 桥按授权白名单执行（原 toolbox 同款） */
export function PluginToolHost({ tool, onBack }: { tool: PluginTool; onBack: () => void }) {
  // V3-2 授权单点化：改用 PluginFrame v2 双轨宿主（v2 报文 → host:rpc 主进程 Gateway 裁决，
  // data.*/kb.store.*/files.* 全可用；v1 报文保留兼容分支服务存量插件）。
  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          title="返回"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-[11.5px] font-medium text-[var(--text-muted)] flex items-center gap-1.5">
          <Puzzle size={12} className="text-[var(--accent)]" />
          {tool.name}
        </span>
        <span className="ml-auto text-[11px] text-[var(--text-disabled)]">插件</span>
      </div>
      <div className="min-h-0 flex-1">
        <PluginFrame
          key={`${tool.pluginId}:${tool.entry}`}
          pluginId={tool.pluginId}
          entry={tool.entry}
          grantedCapabilities={tool.grantedCapabilities}
          onDenied={(reason) => showToast({ type: 'warning', message: `插件请求被拒绝:${reason}` })}
        />
      </div>
    </div>
  )
}
