import { useSettings } from '../../../lib/SettingsContext'

/**
 * AI 输入卡外壳样式库（v3.4.0 反馈轮：原型 ai-input-style-prototype.html V1-V9 全量落地，
 * 设置 → 外观 →「AI 助手输入样式」切换）。AI 助手三态（AssistantPanel ChatBody）与
 * AI 教学对话输入框共用——样式统一影响着所有 AI 问答面。
 *
 * wrap = 输入卡容器；ta = textarea 覆盖类（V7 双层嵌套的内白条）。
 * 阴影/描边全部走主题变量（color-mix），明暗主题自适应。
 */
export const INPUT_SHELLS: Record<string, { wrap: string; ta?: string }> = {
  v1: { wrap: 'rounded-xl bg-[var(--bg-tertiary)] transition-colors focus-within:bg-[var(--bg-hover)]' },
  v2: { wrap: 'rounded-xl bg-[var(--bg-primary)] border border-[var(--border-color)] transition-colors focus-within:border-[var(--accent)]' },
  v3: { wrap: 'rounded-xl bg-[var(--bg-primary)] border border-[var(--border-color)] transition-all focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]' },
  v4: { wrap: 'rounded-xl bg-[var(--bg-primary)] shadow-[0_2px_12px_color-mix(in_srgb,var(--text-primary)_9%,transparent)] transition-all focus-within:shadow-[0_4px_20px_color-mix(in_srgb,var(--accent)_16%,transparent)]' },
  v5: { wrap: 'rounded-[22px] bg-[var(--bg-tertiary)] transition-colors focus-within:bg-[var(--bg-hover)]' },
  v6: { wrap: 'rounded-xl bg-transparent border border-[var(--border-color)] transition-colors focus-within:border-[var(--line-strong)] focus-within:bg-[var(--bg-tertiary)]' },
  v7: { wrap: 'group rounded-xl bg-[var(--bg-tertiary)]', ta: 'bg-[var(--bg-primary)]! rounded-[10px]! px-2.5 mb-1.5 group-focus-within:shadow-[0_0_0_1.5px_color-mix(in_srgb,var(--accent)_45%,transparent)]' },
  v8: { wrap: 'rounded-none bg-transparent border-b-[1.5px] border-b-[var(--border-color)] px-1 transition-colors focus-within:border-b-[var(--accent)]' },
  v9: { wrap: 'rounded-xl bg-[var(--bg-tertiary)] border border-transparent transition-colors focus-within:border-[var(--accent)] focus-within:bg-[var(--bg-hover)]' },
}

/** 读取当前输入样式（未知值回落 v1）。在组件顶层调用。 */
export function useInputShell() {
  const { s } = useSettings()
  const id = typeof s.assistantInputStyle === 'string' && INPUT_SHELLS[s.assistantInputStyle] ? s.assistantInputStyle : 'v1'
  return INPUT_SHELLS[id]
}
