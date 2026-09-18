/**
 * 侧边栏图标包系统。
 *
 * 内置两包:default(手绘,ModuleIcons.tsx 内的实现)与 classic140(1.4.0 经典 lucide 细线)。
 * 插件可通过 `sidebarIcons` 贡献(内容级/S 级)追加新包:
 *   "contributions": { "sidebarIcons": [{ "id": "my-pack", "label": "我的图标", "icons": { "blog": "<svg…/>", … } }] }
 * icons 的值必须是完整 <svg>…</svg> 字符串(继承 currentColor 即可随主题变色),
 * 安装时按内容级安全分级,渲染时以 dangerouslySetInnerHTML 注入并强制填充容器。
 * 新包自动追加到 设置→外观→侧边栏图标 列表末尾,无需改动任何代码。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  FileText, Calendar, BookOpen, MessageCircle, Wrench, Package,
  Trash2, LifeBuoy, User, Settings, Upload, FileCode2, GraduationCap,
} from 'lucide-react'
import { pluginGetContribution, pluginListInstalled } from './ipc'

export type IconModuleId =
  | 'blog' | 'schedule' | 'knowledge' | 'moments' | 'aiTeaching' | 'toolbox' | 'plugins'
  | 'recycle' | 'help' | 'user' | 'settings' | 'export' | 'editor'

export const BUILTIN_ICON_PACKS = [
  { id: 'default', label: '手绘(默认)' },
  { id: 'classic140', label: '经典细线(1.4.0)' },
] as const

/** classic140:1.4.0 版活动栏的 lucide 细线图标(strokeWidth 1.5) */
export function renderClassicIcon(moduleId: IconModuleId, size: number, className?: string): React.ReactNode {
  const map = {
    blog: FileText, schedule: Calendar, knowledge: BookOpen, moments: MessageCircle,
    aiTeaching: GraduationCap,
    // plugins 用 Package（箱子）而非 Puzzle（拼图）：与手绘包的 PluginIconHandDrawn 同构，
    // 切换图标风格时只是画法不同、形状认得出来（2026-09-17 起）
    toolbox: Wrench, plugins: Package, recycle: Trash2, help: LifeBuoy,
    user: User, settings: Settings, export: Upload, editor: FileCode2,
  } as const
  const C = map[moduleId]
  return C ? <C size={size} strokeWidth={1.5} className={className} /> : null
}

export interface PluginIconPack {
  /** 完整风格 id:plugin:<插件id>:<包id> */
  id: string
  label: string
  pluginName: string
  /** moduleId → 完整 <svg>…</svg> 字符串 */
  icons: Partial<Record<IconModuleId, string>>
}

const SVG_RE = /^<svg[\s\S]*<\/svg>$/i

/** 收集已启用插件的图标包(plugins-changed 事件时自动重扫);失败静默为空 */
export function usePluginIconPacks(): PluginIconPack[] {
  const [packs, setPacks] = useState<PluginIconPack[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const rescan = () => setTick(t => t + 1)
    window.addEventListener('plugins-changed', rescan)
    return () => window.removeEventListener('plugins-changed', rescan)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const installed = await pluginListInstalled()
        const out: PluginIconPack[] = []
        for (const p of installed) {
          if (!p.enabled || p.broken || !p.contributions.includes('sidebarIcons')) continue
          try {
            const r = await pluginGetContribution(p.id, 'sidebarIcons')
            if (!r.ok || !Array.isArray(r.data)) continue
            (r.data as Record<string, unknown>[]).forEach((raw, i) => {
              if (!raw || typeof raw !== 'object' || typeof raw.icons !== 'object' || raw.icons === null) return
              const cleaned: Partial<Record<IconModuleId, string>> = {}
              for (const [k, v] of Object.entries(raw.icons as Record<string, unknown>)) {
                if (typeof v === 'string' && SVG_RE.test(v.trim())) cleaned[k as IconModuleId] = v.trim()
              }
              if (Object.keys(cleaned).length === 0) return
              out.push({
                id: `plugin:${p.id}:${typeof raw.id === 'string' && raw.id ? raw.id : i}`,
                label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : p.name,
                pluginName: p.name,
                icons: cleaned,
              })
            })
          } catch { /* 单个插件失败跳过 */ }
        }
        if (alive) setPacks(out)
      } catch { if (alive) setPacks([]) }
    })()
    return () => { alive = false }
  }, [tick])

  return packs
}

/** 把插件提供的 svg 字符串渲染为继承 currentColor、填充容器的节点 */
export function renderPluginSvg(svg: string, size: number, className?: string): React.ReactNode {
  return (
    <span
      className={`inline-flex items-center justify-center [&>svg]:w-full [&>svg]:h-full ${className ?? ''}`}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** 解析 sidebarIconStyle 设置值 → 指定包内某模块图标的节点;返回 null 表示走内置手绘 */
export function useSidebarIconNode(packId: string, moduleId: IconModuleId, size: number, className?: string): React.ReactNode | null {
  const pluginPacks = usePluginIconPacks()
  if (packId === 'classic140') return renderClassicIcon(moduleId, size, className)
  if (packId.startsWith('plugin:')) {
    const pack = pluginPacks.find(p => p.id === packId)
    const svg = pack?.icons[moduleId]
    if (svg) return renderPluginSvg(svg, size, className)
    return null // 包缺失(插件被禁用/卸载)→ 回退手绘
  }
  return null
}
