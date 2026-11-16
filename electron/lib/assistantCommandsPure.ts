/**
 * 自定义斜杠指令（P2）**纯逻辑**：命令名校验、frontmatter 解析、参数替换、骨架生成。
 *
 * 存放约定：`<vault>/.assistant/commands/<命令名>.md`，一文件一命令。
 * 正文即提示词；`$ARGUMENTS` 会被替换为命令后的文字。
 *
 * 零依赖独立文件：契约脚本 `verify-assistant-customization.mjs` 直接 import。
 */

export const MAX_COMMAND_NAME = 24
export const MAX_COMMAND_DESC = 200
export const MAX_COMMAND_PROMPT = 20_000
/** 单目录最多列出的命令数（防止误放大量文件拖慢弹层） */
export const MAX_COMMAND_FILES = 100

/** Windows 保留文件名（不能作为文件基名） */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/**
 * 命令名归一：文件名即命令名。
 * 允许 Unicode 字母 / 数字 / `_` / `-`，1–24 字符；拒绝空白、路径分隔符、`.`、前导点、Windows 保留名。
 * @returns 合法时返回原名（已 trim）；非法返回 null
 */
export function normalizeCommandName(raw: unknown): string | null {
  const name = String(raw ?? '').trim()
  if (!name || name.length > MAX_COMMAND_NAME) return null
  if (!/^[\p{L}\p{N}_-]+$/u.test(name)) return null
  if (name.startsWith('-') || name.startsWith('.')) return null
  if (WINDOWS_RESERVED.has(name.toLowerCase())) return null
  return name
}

export interface ParsedCommand {
  name: string
  description: string
  prompt: string
}

/** 极简 frontmatter：只取 description，其余忽略；无 frontmatter 时整篇是正文 */
function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const kv = t.match(/^([\w-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    meta[kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { meta, body: m[2] }
}

/**
 * 解析一个命令文件。
 * @param raw 文件原文
 * @param name 文件名（不含 .md）；非法 / 正文为空返回 null
 */
export function parseCommandFile(raw: string, name: string): ParsedCommand | null {
  const safeName = normalizeCommandName(name)
  if (!safeName) return null
  const { meta, body } = splitFrontmatter(String(raw ?? ''))
  const prompt = body.trim()
  if (!prompt) return null
  const desc = (meta.description ?? '').trim().slice(0, MAX_COMMAND_DESC) || '自定义指令'
  return {
    name: safeName,
    description: desc,
    prompt: prompt.length > MAX_COMMAND_PROMPT ? prompt.slice(0, MAX_COMMAND_PROMPT) : prompt,
  }
}

/**
 * 参数替换：`$ARGUMENTS` 全部替换；正文没有占位符且有参数时，追加到末尾。
 * 空参数不会留下多余空行。
 */
export function renderCommandPrompt(prompt: string, args: string): string {
  const body = String(prompt ?? '').replace(/\u0000/g, '').trim()
  const argText = String(args ?? '').replace(/\u0000/g, '').trim()
  if (!body) return ''
  let out = body.includes('$ARGUMENTS') ? body.split('$ARGUMENTS').join(argText) : body
  if (!body.includes('$ARGUMENTS') && argText) out = `${out}\n\n用户参数：${argText}`
  return out.length > MAX_COMMAND_PROMPT ? out.slice(0, MAX_COMMAND_PROMPT) : out
}

/** 新建命令的骨架（description 留空；正文给出用法说明） */
export function commandSkeleton(name: string): string {
  return [
    '---',
    `description: `,
    '---',
    `在这里写 /${name} 的提示词：这段正文会作为一条用户消息发给 AI。`,
    '',
    '用 $ARGUMENTS 接收命令后面的文字；不写占位符时，参数会追加到末尾。',
    '',
  ].join('\n')
}

/** 列表排序：按命令名码点序（跨平台确定，避免 locale 差异） */
export function sortCommandNames<T extends { name: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
