import React from 'react'

/**
 * AI助手模块图标（v3.9.0）：文件夹 + 右下角小机器人头。
 *
 * 文件夹轮廓**原样**取 lucide `folder-cog` 的路径（那段右下留缺口本是给齿轮的，正好让给头），
 * 只把齿轮换成机器人头 = 圆角矩形 + 两枚圆点眼 + 头顶天线（`circle r=.55` 是 lucide 画小圆点的既有手法）。
 * 24 视口 / 描边 2 / 继承 currentColor —— 与 lucide 同口径，可直接顶替 `<FolderCog size={s} />`。
 * 用户 2026-10-16 从 `tmp/ai-assistant-icon-picker/folder-bot-icon.html` 方案 A 拍板。
 *
 * 四处消费：工作台书签（WorkbenchLeftPanel）/ 桌面磁贴（tiles.tsx）/ 模块标题栏 / 空态。
 */
interface Props {
  size?: number
  className?: string
  style?: React.CSSProperties
}

export function AiAssistantIcon({ size = 24, className, style }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M10.3 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.98a2 2 0 0 1 1.69.9l.66 1.2A2 2 0 0 0 12 6h8a2 2 0 0 1 2 2v3.3" />
      <path d="M18 15v-1.3" />
      <circle cx="18" cy="13.15" r=".55" />
      <rect x="14.2" y="15" width="7.6" height="6" rx="1.9" />
      <circle cx="16.3" cy="18" r=".5" />
      <circle cx="19.7" cy="18" r=".5" />
    </svg>
  )
}
