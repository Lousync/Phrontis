/**
 * AI 文件策略的**共享常量**（主进程与渲染层同源，先例：`aiTextExts.ts`）。
 *
 * 为什么单独一份：预设类型与中文名两边都要用 —— 主进程做判定与提示，
 * 渲染层做卡片/设置页文案。放在 `src/lib` 才能两边都 import 而不用跨层引 electron。
 */

import { AI_TEXT_CODE_EXTS, TEXT_VIEWABLE_EXTS } from './aiTextExts'

export type AiFilePreset = 'notes' | 'notes+code' | 'all-text' | 'custom'

export const AI_FILE_PRESETS: readonly AiFilePreset[] = ['notes', 'notes+code', 'all-text', 'custom']

function uniq(list: readonly string[]): string[] {
  return [...new Set(list.map((x) => x.toLowerCase().replace(/^\./, '')).filter(Boolean))]
}

const NOTES_EXTS: readonly string[] = ['md', 'markdown', 'txt', 'text']

/** 预设 → 可写扩展名（`custom` 不在表内）；主进程判定与设置页计数共用 */
export const AI_PRESET_WRITE_EXTS: Record<Exclude<AiFilePreset, 'custom'>, readonly string[]> = {
  notes: uniq(NOTES_EXTS),
  'notes+code': uniq([...NOTES_EXTS, ...AI_TEXT_CODE_EXTS]),
  'all-text': uniq(TEXT_VIEWABLE_EXTS),
}

export const AI_PRESET_LABELS: Record<AiFilePreset, string> = {
  notes: '仅笔记（.md/.txt）',
  'notes+code': '笔记 + 代码',
  'all-text': '全部文本文件（推荐）',
  custom: '自定义',
}

/** 预设的一句话说明（设置页用） */
export const AI_PRESET_DESCS: Record<AiFilePreset, string> = {
  notes: '只允许 AI 改 Markdown 与纯文本，最保守',
  'notes+code': '笔记 + 代码文件，不含 json / yml 等配置',
  'all-text': '界面能文本查看的都能改（含配置），仍拒绝二进制 / 密钥 / 点目录',
  custom: '只允许勾选的扩展名',
}
