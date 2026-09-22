import React from 'react'
import { useSettings } from '../../lib/SettingsContext'
import { useSidebarIconNode, type IconModuleId } from '../../lib/sidebarIcons'

/**
 * 统一风格的手绘模块图标（24px 视口、圆角描边）。
 * 全部继承 currentColor，配合主题的 accent / muted 颜色使用。
 */

interface IconProps {
  size?: number
  className?: string
  /** 线宽覆盖（默认 1.6）。**大尺寸下 1.6 偏粗** —— 插件市场空态那个 40px 图标原本就是 1.2（2026-09-22 B-9）。
   *  ★ 只有手绘包跟随此值：classic140 包自带 1.5、插件 SVG 包是第三方 `<svg>` 原样注入，
   *    两者「各显其形」是本图标系统的既有设计，不为统一线宽去改它们。 */
  strokeWidth?: number
}

function Svg({ size = 24, className, strokeWidth, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** 博客：带折角的文档 + 两行文字 */
function BlogIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5h7.2L17.5 7.8V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5Z" />
      <path d="M13.2 3.6v4.2h4.3" />
      <path d="M9 12h6.5" />
      <path d="M9 15.5h4" />
    </Svg>
  )
}

/** 日程：带对勾的日历 */
function ScheduleIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V6A1.5 1.5 0 0 1 6 4.5Z" />
      <path d="M4.5 9.5h15" />
      <path d="M8.5 3.5v3.2" />
      <path d="M15.5 3.5v3.2" />
      <path d="M9 14.2l2.1 2.1 4-4.6" />
    </Svg>
  )
}

/** 知识库：文件夹 */
function KnowledgeIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2h8a1.5 1.5 0 0 1 1.5 1.5V17A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17V7.5Z" />
      <path d="M7.5 11.5h6.5" />
      <path d="M7.5 14.5h9" />
    </Svg>
  )
}

/** 说说：微信风格气泡 + 三点 */
function MomentsIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-3.5 3.2a.55.55 0 0 1-.94-.39V17H6.5A2.5 2.5 0 0 1 4 14.5v-8Z" />
      <path d="M8.5 10.5h.01" strokeWidth={2.4} />
      <path d="M12 10.5h.01" strokeWidth={2.4} />
      <path d="M15.5 10.5h.01" strokeWidth={2.4} />
    </Svg>
  )
}

/** 工具箱：工具箱 */
function ToolboxIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 9V6.7c0-.8.5-1.45 1.2-1.75l2-.9c.65-.3 1.35.05 1.65.7l.7 1.5c.2.4.3.85.3 1.3V9" />
      <path d="M4.15 12.55c-.15.95.4 1.95 1.4 1.95h12.9c1 0 1.55-1 1.4-1.95l-.95-5.4c-.15-.9-.95-1.6-1.85-1.6H6.95c-.9 0-1.7.7-1.85 1.6l-.95 5.4Z" />
    </Svg>
  )
}

/** 导出：托盘 + 向上箭头 */
function ExportIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.5v9" />
      <path d="M8.5 8 12 4.5 15.5 8" />
      <path d="M5 14.5v2.5A1.5 1.5 0 0 0 6.5 18.5h11a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
    </Svg>
  )
}

/** 回收站：垃圾桶 */
function RecycleIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7l.75 11a1.5 1.5 0 0 0 1.5 1.4h6.5a1.5 1.5 0 0 0 1.5-1.4l.75-11" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </Svg>
  )
}

/** 帮助：问号 */
function HelpIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.4a2.6 2.6 0 1 1 3.7 2.4c-.8.4-1.3 1-1.3 1.9" />
      <path d="M12 17.2h.01" strokeWidth={2.4} />
    </Svg>
  )
}

/** 用户：人像 */
function UserIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M5 20c1.15-2.95 3.7-4.4 7-4.4s5.85 1.45 7 4.4" />
    </Svg>
  )
}

/** 设置：调节滑杆 */
function SettingsIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 21v-7" />
      <path d="M4 10V3" />
      <path d="M12 21v-9" />
      <path d="M12 8V3" />
      <path d="M20 21v-5" />
      <path d="M20 12V3" />
      <path d="M1.5 14h5" />
      <path d="M9.5 8h5" />
      <path d="M17.5 16h5" />
    </Svg>
  )
}

/** 插件：包裹箱（2026-09-17 由「拼图块」改为「立体箱」）。
 *
 *  几何与经典细线包的 lucide `Package` 同构（六边形箱体剪影 + 顶面两条棱 + 正面中缝 + 箱盖折痕），
 *  但笔法走项目手绘：线宽 1.6、圆角更大、折痕端点落在各棱中点。
 *  两包并存的用意：切「侧边栏图标风格」时各显其形（手绘=这个，经典细线=lucide Package），
 *  而不是换成一张只差 0.1px 线宽的同一个图标。 */
function PluginIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      {/* 箱体剪影：上顶点 → 右腰 → 右下 → 底部 → 左下 → 左腰 → 闭合（圆角由 stroke-linejoin 撑起） */}
      <path d="M12 3.5 20.1 8.1v7.7L12 20.4 3.9 15.8V8.1Z" />
      {/* 顶面两条棱：左腰中点 → 顶面下顶点 → 右腰中点 */}
      <path d="M3.9 8.1 12 12.65l8.1-4.55" />
      {/* 正面中缝：顶面下顶点 → 箱底 */}
      <path d="M12 12.65v7.75" />
      {/* 箱盖折痕：左上棱中点 → 顶面右棱中点 */}
      <path d="m7.95 5.8 8.1 4.55" />
    </Svg>
  )
}

/** AI教学：学士帽（帽板 + 帽身，流苏自帽板右角垂下带实心穗点，呼应插件图标的中心点设计语言） */
function AiTeachingIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.6 21.2 9 12 13.4 2.8 9Z" />
      <path d="M21.2 9.4v4.7" />
      <path d="M6.7 11.7v3.2a5.3 3 0 0 0 10.6 0v-3.2" />
      <circle cx="21.2" cy="15.4" r="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** 编辑器：尖括号代码图标（VS Code 风格） */
function EditorIconHandDrawn(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.5 7.2 4.7 12l3.8 4.8" />
      <path d="M15.5 7.2 19.3 12l-3.8 4.8" />
      <path d="M13.6 5.8l-3.2 12.4" />
    </Svg>
  )
}
// ===== 风格感知包装(设置→外观→侧边栏图标;default 走上方手绘实现) =====

function StyleAware({ moduleId, Fallback, size = 24, className, strokeWidth }: IconProps & {
  moduleId: IconModuleId
  Fallback: (props: IconProps) => React.ReactElement
}) {
  const { s } = useSettings()
  const node = useSidebarIconNode(s.sidebarIconStyle ?? 'default', moduleId, size, className)
  if (node) return <>{node}</>
  return <Fallback size={size} className={className} strokeWidth={strokeWidth} />
}

const HAND_DRAWN: Record<IconModuleId, (props: IconProps) => React.ReactElement> = {
  blog: BlogIconHandDrawn,
  schedule: ScheduleIconHandDrawn,
  knowledge: KnowledgeIconHandDrawn,
  moments: MomentsIconHandDrawn,
  aiTeaching: AiTeachingIconHandDrawn,
  toolbox: ToolboxIconHandDrawn,
  plugins: PluginIconHandDrawn,
  recycle: RecycleIconHandDrawn,
  help: HelpIconHandDrawn,
  user: UserIconHandDrawn,
  settings: SettingsIconHandDrawn,
  export: ExportIconHandDrawn,
  editor: EditorIconHandDrawn,
}

export function BlogIcon(props: IconProps) { return <StyleAware moduleId="blog" Fallback={BlogIconHandDrawn} {...props} /> }
export function ScheduleIcon(props: IconProps) { return <StyleAware moduleId="schedule" Fallback={ScheduleIconHandDrawn} {...props} /> }
export function KnowledgeIcon(props: IconProps) { return <StyleAware moduleId="knowledge" Fallback={KnowledgeIconHandDrawn} {...props} /> }
export function MomentsIcon(props: IconProps) { return <StyleAware moduleId="moments" Fallback={MomentsIconHandDrawn} {...props} /> }
export function AiTeachingIcon(props: IconProps) { return <StyleAware moduleId="aiTeaching" Fallback={AiTeachingIconHandDrawn} {...props} /> }
export function ToolboxIcon(props: IconProps) { return <StyleAware moduleId="toolbox" Fallback={ToolboxIconHandDrawn} {...props} /> }
export function ExportIcon(props: IconProps) { return <StyleAware moduleId="export" Fallback={ExportIconHandDrawn} {...props} /> }
export function RecycleIcon(props: IconProps) { return <StyleAware moduleId="recycle" Fallback={RecycleIconHandDrawn} {...props} /> }
export function HelpIcon(props: IconProps) { return <StyleAware moduleId="help" Fallback={HelpIconHandDrawn} {...props} /> }
export function UserIcon(props: IconProps) { return <StyleAware moduleId="user" Fallback={UserIconHandDrawn} {...props} /> }
export function SettingsIcon(props: IconProps) { return <StyleAware moduleId="settings" Fallback={SettingsIconHandDrawn} {...props} /> }
export function PluginIcon(props: IconProps) { return <StyleAware moduleId="plugins" Fallback={PluginIconHandDrawn} {...props} /> }
export function EditorIcon(props: IconProps) { return <StyleAware moduleId="editor" Fallback={EditorIconHandDrawn} {...props} /> }

/** 任意包预览:设置→外观 的图标选择器用它渲染每个包的效果 */
export function IconPreview({ moduleId, packId, size = 24, className }: { moduleId: IconModuleId; packId: string } & IconProps) {
  const node = useSidebarIconNode(packId, moduleId, size, className)
  if (node) return <>{node}</>
  const Fallback = HAND_DRAWN[moduleId]
  return Fallback ? <Fallback size={size} className={className} /> : null
}
