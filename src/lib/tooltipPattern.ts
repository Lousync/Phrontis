/**
 * 主题包 / 插件的「悬停提示图案」声明（零依赖纯函数，2026-11-13）。
 *
 * 为什么单独一个文件：
 *   · `pluginService.ts` 里有 `ipc` 依赖，契约脚本在 Node 里 import 不了；
 *   · 图案是**唯一**允许插件往气泡表面写 CSS 的入口，校验规则必须能被用例表逐条钉死；
 *   · 与 `electron/lib/releaseNotes/judge.ts` 同一套思路：纯函数 + 脚本直接 import。
 *
 * 安全边界（照抄 `sanitizeVars` 的既有口径，再收紧）：
 *   · 只接受渐变函数（linear / radial / conic 及其 repeating 形态）与 `none`；
 *   · 字符集白名单，天然挡掉 `;` `{` `}` `<` `>` `@` 引号与反斜杠（防规则注入）；
 *   · 关键字黑名单挡掉 `url()` / `image-set()` / `element()` / `paint()` / `expression` 等
 *     能引外部资源或执行脚本的写法 —— 图案只能是"算出来的",不能是"取回来的"；
 *   · 括号必须配平，长度 ≤ 400；尺寸只认一组 `数字+单位`（px / rem / em / %）或 `auto`。
 *
 * 为什么不做图片纹理：插件主题的颜色目前经 `sanitizeVars` 注入，`url()` 是被禁的；
 * 要让插件带自己的 PNG / SVG，就必须放宽到"允许外部资源"，那会把主题包变成可执行攻击面。
 * 渐变已经能覆盖点阵、扫描线、角饰这几类需求，先守住这条线。
 */

/** 图案字符串长度上限（够写一条三段式渐变） */
export const TIP_PATTERN_MAX = 400

/** 图案尺寸字符串长度上限 */
export const TIP_PATTERN_SIZE_MAX = 40

const GRADIENT_PREFIX = /^(repeating-)?(linear|radial|conic)-gradient\(/i

/** 白名单字符集：字母数字 + 颜色 / 单位 / 分隔符。故意不含 `;` `{}` `<>` `@` `'` `"` `\` */
const SAFE_CHARS = /^[A-Za-z0-9#%.,()\s/+-]+$/

/** 能引外部资源或执行脚本的写法 */
const BANNED = /url\s*\(|image-set\s*\(|element\s*\(|paint\s*\(|src\s*\(|expression|javascript:|@import|behavior|-moz-binding/i

const SIZE = /^\d+(\.\d+)?(px|rem|em|%)(\s+\d+(\.\d+)?(px|rem|em|%))?$/

export interface TooltipDecoration {
  /** CSS `background-image` 值，只允许渐变 */
  pattern?: unknown
  /** CSS `background-size` 值：`auto` 或一组长度 */
  patternSize?: unknown
}

/** 校验图案；不可用时返回 null（调用方直接跳过，不要抛错打断整套主题） */
export function sanitizeTipPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().replace(/\s+/g, ' ')
  if (!value || value.length > TIP_PATTERN_MAX) return null
  if (/^none$/i.test(value)) return 'none'
  if (!SAFE_CHARS.test(value)) return null
  if (BANNED.test(value)) return null
  if (!GRADIENT_PREFIX.test(value)) return null
  // 括号配平：少一个右括号会把后面的声明一起吞掉
  let depth = 0
  for (const ch of value) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (depth < 0) return null
  }
  if (depth !== 0) return null
  return value
}

/** 校验图案尺寸；`auto` 原样通过 */
export function sanitizeTipPatternSize(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  if (!value || value.length > TIP_PATTERN_SIZE_MAX) return null
  if (value === 'auto') return 'auto'
  if (!SIZE.test(value)) return null
  return value
}

/**
 * 把主题声明里的 `tooltip` 字段变成两行 CSS 变量（带缩进，直接拼进主题规则）。
 * 返回空数组 = 没有可用的图案，调用方不需要写任何东西。
 */
export function tooltipDeclarations(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rec = raw as Record<string, unknown>
  const out: string[] = []
  const pattern = sanitizeTipPattern(rec.pattern)
  if (pattern) out.push(`  --tip-pattern: ${pattern};`)
  const size = sanitizeTipPatternSize(rec.patternSize)
  if (size) out.push(`  --tip-pattern-size: ${size};`)
  return out
}
