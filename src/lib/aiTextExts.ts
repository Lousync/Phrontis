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
