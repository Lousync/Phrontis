/**
 * 仓库规则文件（P1-6）**纯逻辑**：目录选择 + 注入文案拼装。
 *
 * 读的是仓库里由 AI 工具生态写的约定文件（根目录 / 子目录的 `AGENTS.md`、`CLAUDE.md`），
 * 不是用户在本软件里维护的 `.assistant/CONSTRAINTS.md`（那一份仍走 assistantConstraints 注入）。
 * 两者可以同时生效：用户当前消息 > 助手要求（.assistant）> 更细目录规则 > 根目录规则。
 *
 * 零依赖独立文件：契约脚本 `verify-repo-rules.mjs` 直接 import。
 */

export const RULE_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const
export type RuleFileName = typeof RULE_FILE_NAMES[number]

/** 单个规则文件注入上限（字符） */
export const MAX_RULE_FILE_CHARS = 4000
/** 全部规则文件合计注入上限（字符） */
export const MAX_REPO_RULES_CHARS = 12000
/** 最多读几层目录（含根） */
export const MAX_RULE_DIRS = 8

export interface RepoRuleFile {
  /** 仓库相对目录，'' = 根 */
  dir: string
  name: string
  text: string
}

/**
 * 归一仓库相对目录：`''` = 根。
 * 拒绝绝对路径 / 盘符 / 越界 / 点目录（`.git`、`.knowbase`、`.assistant` 里的文件不当规则读）。
 * @returns 非法输入返回 null（调用方跳过）
 */
export function normalizeRelDir(raw: unknown): string | null {
  let s = String(raw ?? '').replace(/\\/g, '/').trim()
  if (!s || s === '.') return ''
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null
  s = s.replace(/^\.\/+/, '').replace(/\/+$/, '')
  const segs = s.split('/').filter(Boolean)
  if (segs.some((x) => x === '.' || x === '..' || x.startsWith('.'))) return null
  return segs.join('/')
}

const depthOf = (dir: string): number => (dir ? dir.split('/').length : 0)

/**
 * 目录清单归一：根恒在第一位；浅 → 深；去重；超过 `MAX_RULE_DIRS` 时保留根 + 最深的几层
 * （越靠近目标文件的规则越有用，中间层被挤掉只损失一层弱约束）。
 */
export function normalizeRuleDirs(dirs: unknown[]): string[] {
  const set = new Set<string>([''])
  for (const d of dirs) {
    const n = normalizeRelDir(d)
    if (n !== null) set.add(n)
  }
  const all = [...set].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b))
  if (all.length <= MAX_RULE_DIRS) return all
  return ['', ...all.filter((d) => d !== '').slice(-(MAX_RULE_DIRS - 1))]
}

/**
 * 规则文件 → system 注入段。
 * - 完全相同的正文只注入一次（AGENTS.md 与 CLAUDE.md 常互为副本）；
 * - 单文件 ≤4000 字、合计 ≤12000 字，超出截断并标注；
 * - 无文件 → 空串（零成本）。
 */
export function renderRepoRulesHint(files: RepoRuleFile[]): string {
  const seenText = new Set<string>()
  const parts: string[] = []
  let total = 0
  for (const f of files) {
    const dir = normalizeRelDir(f.dir)
    if (dir === null) continue
    const name = String(f.name ?? '').trim()
    if (!(RULE_FILE_NAMES as readonly string[]).includes(name)) continue
    const text = String(f.text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
    if (!text || seenText.has(text)) continue
    seenText.add(text)
    const perFile = text.length > MAX_RULE_FILE_CHARS
      ? `${text.slice(0, MAX_RULE_FILE_CHARS)}\n…（规则文件过长，已截断）`
      : text
    const budget = MAX_REPO_RULES_CHARS - total
    if (budget <= 0) break
    const body = perFile.length > budget ? `${perFile.slice(0, budget)}\n…（仓库规则总量超限，已截断）` : perFile
    const where = dir ? `${dir}/${name}` : name
    parts.push(`【仓库规则 · ${where}${dir ? '（更具体，优先）' : ''}】\n${body}`)
    total += body.length
  }
  if (parts.length === 0) return ''
  return '\n\n【仓库规则文件】以下是仓库里的 AGENTS.md / CLAUDE.md（AI 工具通用约定），请遵守。'
    + '越靠后的目录规则越具体，冲突时以更具体者为准；与用户当前消息或助手要求（.assistant/CONSTRAINTS.md）冲突时，以用户 / 助手要求为准。\n'
    + parts.join('\n\n')
}
