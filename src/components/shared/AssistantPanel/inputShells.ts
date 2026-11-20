import { useSettings } from '../../../lib/SettingsContext'

/**
 * AI 输入卡外壳样式库（v3.4.0 反馈轮：原型 ai-input-style-prototype.html V1-V9 全量落地，
 * 设置 → 外观 →「AI 助手输入样式」切换）。AI 助手三态（AssistantPanel ChatBody）与
 * AI 教学对话输入框共用——样式统一影响着所有 AI 问答面。
 *
 * wrap = 输入卡容器；ta = textarea 覆盖类（V7 双层嵌套的内白条）。
 * 阴影/描边全部走主题变量（color-mix），明暗主题自适应。
 */
export const INPUT_SHELLS: Record<string, { wrap: string; ta?: string; glow?: boolean }> = {
  // glow = 该外壳自己**没有** focus 阴影，需要挂 `.kb-input-glow` 补一层光效（v3/v4/v7 自带，不补）
  v1: { wrap: 'rounded-xl bg-[var(--bg-tertiary)] transition-colors focus-within:bg-[var(--bg-hover)]', glow: true },
  v2: { wrap: 'rounded-xl bg-[var(--bg-primary)] border border-[var(--border-color)] transition-colors focus-within:border-[var(--accent)]', glow: true },
  v3: { wrap: 'rounded-xl bg-[var(--bg-primary)] border border-[var(--border-color)] transition-all focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]' },
  v4: { wrap: 'rounded-xl bg-[var(--bg-primary)] shadow-[0_2px_12px_color-mix(in_srgb,var(--text-primary)_9%,transparent)] transition-all focus-within:shadow-[0_4px_20px_color-mix(in_srgb,var(--accent)_16%,transparent)]' },
  v5: { wrap: 'rounded-[22px] bg-[var(--bg-tertiary)] transition-colors focus-within:bg-[var(--bg-hover)]', glow: true },
  v6: { wrap: 'rounded-xl bg-transparent border border-[var(--border-color)] transition-colors focus-within:border-[var(--accent)] focus-within:bg-[var(--bg-tertiary)]', glow: true },
  v7: { wrap: 'group rounded-xl bg-[var(--bg-tertiary)]', ta: 'bg-[var(--bg-primary)]! rounded-[10px]! px-2.5 mb-1.5 group-focus-within:shadow-[0_0_0_1.5px_color-mix(in_srgb,var(--accent)_45%,transparent)]' },
  v8: { wrap: 'rounded-none bg-transparent border-b-[1.5px] border-b-[var(--border-color)] px-1 transition-colors focus-within:border-b-[var(--accent)]', glow: true },
  v9: { wrap: 'rounded-xl bg-[var(--bg-tertiary)] border border-transparent transition-colors focus-within:border-[var(--accent)] focus-within:bg-[var(--bg-hover)]', glow: true },
  /**
   * v10 = AI 教学课堂原型（2026-11-20）：**浮起的卡**，不是「底色块」。
   *
   * 与 v1–v9 的区别不是颜色，而是层次：16px 圆角 + 一档抬升的底色 + 三层阴影
   * （1px 内环压边 / 2px 贴地 / 34px 大投影），聚焦时**整层阴影替换**而不是叠加光晕
   * —— 叠加会让 1px 边框读起来变成 2px，卡内文字跟着位移 1px。
   * 具体阴影写在 index.css 的 `.kb-composer-v10`（两态都在一处，便于对原型）。
   */
  v10: { wrap: 'kb-composer-v10 rounded-[16px] bg-[var(--bg-secondary)] border border-[var(--border-color)]' },
}

/** 读取当前输入样式（未知值回落 v1）。在组件顶层调用。 */
export function useInputShell() {
  const { s } = useSettings()
  // 未知值回落默认外观（v10 = 课堂原型的浮卡；设置里可切回 v1–v9）
  const id = typeof s.assistantInputStyle === 'string' && INPUT_SHELLS[s.assistantInputStyle] ? s.assistantInputStyle : 'v10'
  return INPUT_SHELLS[id]
}
