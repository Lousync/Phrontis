import type { TabName } from '../../types'
import { Trash2, FlaskConical } from 'lucide-react'
import { MomentsIcon, SettingsIcon, PluginIcon } from './ModuleIcons'

/**
 * 图标条（v3.4.0 工作台三栏外壳，方案 §3.4 / §10；2026-09-17 拍板变化：工具箱按钮撤掉，5 → 4）。
 *
 * - **固定 4 按钮**：回收站 / 插件市场 / 动态 / 设置——不再提供拖拽排序与右键显隐
 *   （旧 `activityBarOrder` / `activityBarHidden` 设置键随之废弃，见方案 §3.5）；
 * - **工具箱入口移除**：原「🧰 打开为中间标签页」的入口语义由右栏上部「工具箱工具入口区」
 *   承接（方案 §10，ToolLauncherZone），工具箱模块本身保留（命令面板/深链仍可达）；
 * - **入口幂等哲学**：标签只能由入口产生，重复点击已激活的按钮 = 无操作；
 * - 底部弹出菜单整条删除：设置按钮直接打开「设置」标签页（主题切换等在设置页内），
 *   帮助入口改在设置页（批次7）、回收站直接从本图标条进入；
 * - user 账户按钮删除（账户并入设置「账户」分组，批次7）；
 * - devtools 保留 dev-only 老位置（打包构建时静态消除）。
 */

const RAIL_BUTTONS: { id: TabName; label: string; icon: (size: number) => React.ReactNode }[] = [
  { id: 'recycle', label: '回收站', icon: (s) => <Trash2 size={s} /> },
  { id: 'plugins', label: '插件市场', icon: (s) => <PluginIcon size={s} /> },
  { id: 'moments', label: '动态', icon: (s) => <MomentsIcon size={s} /> },
]

interface Props {
  /** 当前激活模块；null = 全部标签已关闭的空态（无高亮项） */
  active: TabName | null
  onChange: (tab: TabName) => void
  /** UI 优化条目1：最大化时图标条卡去留白/圆角/边框阴影，贴满屏幕边缘 */
  flush?: boolean
}

export function ActivityBar({ active, onChange, flush }: Props) {
  // 尺寸对齐原型 v15（2026-09-16 第二轮 UI 反馈「图标条还是太粗」）：容器 44px、按钮 34×34、
  // 圆角 7px、图标 22px；激活指示条 3×18px，left -5px 贴容器左缘（(44-34)/2 = 5px）。
  const railCls = (isActive: boolean) => `
    w-[34px] h-[34px] flex items-center justify-center relative rounded-[7px] transition-all duration-150
    ${isActive
      ? 'text-[var(--accent)] bg-[var(--bg-hover)]/80 shadow-[inset_0_0_0_1px_var(--border-color)]'
      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/50'}
  `
  const railMark = (
    <div className="absolute -left-[5px] top-1/2 -translate-y-1/2 w-[3px] h-[18px] bg-[var(--accent)] rounded-r-full" />
  )

  return (
    <div
      className={`w-11 flex flex-col items-center py-2 gap-0.5 shrink-0 select-none transition-all duration-300 ease-out bg-[color-mix(in_srgb,var(--activitybar-bg)_85%,transparent)] ${flush ? 'rounded-none' : 'mx-1.5 my-1.5 rounded-xl border border-[var(--border-color)] shadow-[inset_0_1px_0_var(--glass-edge),0_6px_24px_rgba(0,0,0,0.16)]'}`}
    >
      {RAIL_BUTTONS.map(({ id, label, icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          title={label}
          className={railCls(active === id)}
        >
          {active === id && railMark}
          {icon(22)}
        </button>
      ))}

      <div className="mt-auto flex flex-col items-center">
        {/* 设置 —— 直接打开设置标签页（拍板：设置=中间标签页；原底部弹出菜单删除） */}
        <button onClick={() => onChange('settings')} title="设置" className={railCls(active === 'settings')}>
          {active === 'settings' && railMark}
          <SettingsIcon size={22} />
        </button>

        {/* 开发者工具 — 仅 DEV 渲染,打包构建时该分支被静态消除 */}
        {import.meta.env.DEV && (
          <button onClick={() => onChange('devtools')} title="开发者工具 (DEV)" className={railCls(active === 'devtools')}>
            {active === 'devtools' && railMark}
            <FlaskConical size={22} />
          </button>
        )}
      </div>
    </div>
  )
}
