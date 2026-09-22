/**
 * AI 可读「文本类代码文件」扩展名 —— 单一真相源。
 *
 * 三处共用（本文件建立前各持一份硬编码清单，改动时必然分裂）：
 * ① 主进程读白名单 `isAiReadableFile`（`electron/lib/builtinTools.ts`）—— vault.list / vault.read /
 *    vault.search 与插件 fs API 共用该判定；
 * ② 素材库类型识别 `CODE_EXTS`（`electron/lib/aiTeachingSources.ts`）；
 * ③ 前端素材类型预览 `inferSrcType`（`src/modules/ai-teaching/index.tsx`）。
 *
 * 来源：素材库原 `CODE_EXTS`（33 项）去掉 5 个配置类（json / yml / yaml / toml / ini）→ 28 项。
 * 配置类不放开（2026-09-15 拍板④：「真要改配置的时候也轮不到他来」）；
 * `.knowbase/modules/*.json` 的只读通道在 isAiReadableFile 内单独判定，不受本清单影响。
 * 放在 `src/lib/` 是因为主进程与渲染层都能引（先例：electron 引 `src/lib/settings`）。
 */
export const AI_TEXT_CODE_EXTS = [
  'js', 'ts', 'jsx', 'tsx', 'py', 'c', 'h', 'cpp', 'hpp', 'cc',
  'java', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sh', 'bat',
  'ps1', 'lua', 'sql', 'vue', 'scss', 'css', 'html', 'xml',
] as const

export const AI_TEXT_CODE_EXT_SET: ReadonlySet<string> = new Set(AI_TEXT_CODE_EXTS)

/**
 * 「可在应用内按文本查看」的归档扩展名（B-3 方案 A，元信息卡 →「查看内容」）。
 *
 * **与 `AI_TEXT_CODE_EXTS` 的区别在用途**：那份是「AI 可读/可写」的准入名单（2026-09-15 拍板把
 * json / yml / yaml / toml / ini 挡在外面，理由是"真要改配置的时候也轮不到他来"）；这份只管
 * **只读展示**——能解码成文本就够，配置类与纯文本自然应当包含。
 *
 * 从 `AI_TEXT_CODE_EXTS` 派生而非另抄一份：代码类那 28 项是两处共同的下界，
 * 这里只补展示专有的部分，避免第三份手抄清单（本仓已因清单各持一份吃过多次 drift）。
 */
const VIEW_ONLY_EXTS = [
  // 配置 / 数据类（AI 名单排除，展示要收）
  'json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'log',
  // 纯文本
  'txt', 'text', 'md', 'markdown',
] as const

export const TEXT_VIEWABLE_EXTS: readonly string[] = [...AI_TEXT_CODE_EXTS, ...VIEW_ONLY_EXTS]

export const TEXT_VIEWABLE_EXT_SET: ReadonlySet<string> = new Set(TEXT_VIEWABLE_EXTS)

/** 该扩展名（不带点，小写）能否在应用内按文本查看 */
export function isTextViewableExt(ext: string): boolean {
  return TEXT_VIEWABLE_EXT_SET.has(ext.toLowerCase())
}
