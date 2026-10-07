import { useState, useEffect } from 'react'
import { PluginIcon } from './ModuleIcons'

interface Props {
  src?: string          // 插件图标 URL(plugin:// 或 registry iconUrl);空/加载失败回退「插件」概念图标
  size?: number
  className?: string
  rounded?: boolean
}

/** 插件图标:优先展示插件自带图标,加载失败回退为「插件」概念图标
 *  （2026-09-22 B-9：由拼图改为 PluginIcon，跟随「设置→外观→侧边栏图标风格」三档） */
export function PluginIconImg({ src, size = 26, className, rounded = true }: Props) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])

  if (!src || failed) {
    return <PluginIcon size={size} strokeWidth={1.5} className={className} />
  }
  return (
    <img
      src={src}
      onError={() => setFailed(true)}
      className={`object-contain shrink-0 ${className || ''}`}
      style={{ width: size, height: size, borderRadius: rounded ? size * 0.22 : 0 }}
      alt=""
      draggable={false}
    />
  )
}
