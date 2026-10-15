/**
 * Skill 包 / 文件夹的入口定位（零依赖 —— 专供 `.AGENT/scripts/**` 契约脚本 import）。
 *
 * 为什么单独一个文件：`skillService.ts` 顶部 `import { ipcMain, dialog, ... } from 'electron'`，
 * 契约脚本用裸 node 跑不起来。凡是「值得断言、又不需要 electron」的判定都放这里
 * （同 `ccSwitchPure.ts` / `llmProtocolPure.ts` 的既有做法）。
 */

export const SKILL_ENTRY_NAMES = ['SKILL.md', 'skill.json'] as const

export type SkillPackUnit = '包' | '文件夹'

export type SkillEntryResolution =
  | { ok: true; entryPath: string; prefix: string }
  | { ok: false; error: string }

/**
 * 定位 Skill 入口。规则（2026-10-13 决策 F「只装根目录那个」）：
 *
 *   1. **根目录**有 `SKILL.md` / `skill.json` → 用它（`prefix` 为空）；
 *   2. 否则看单层顶层目录：**只有恰好一个**顶层目录含入口时才退让到它
 *      （兼容系统压缩工具默认多套一层文件夹，以及用户选中的是"装着若干 Skill 的父文件夹"
 *      但里面只有一个的情况）；
 *   3. 两个及以上 → 明确报错，让用户自己选，**不替他挑**。
 *
 * 为什么规则 3 是重点：此前是遍历文件表取**第一个**命中的，顺序取决于 zip 条目顺序 /
 * 目录遍历顺序 —— 等于随机装一个，而用户看到的是"安装成功"。
 *
 * `entryPath` 返回的是**原始键**（可能与 Map 里的键逐字相同，含反斜杠），
 * 供调用方 `files.get(entryPath)` 直接取内容；`prefix` 是**归一化后**的顶层目录前缀（以 `/` 结尾），
 * 供调用方按 `/` 归一化后切片。
 */
export function resolveSkillEntry(paths: Iterable<string>, unit: SkillPackUnit): SkillEntryResolution {
  const raw = [...paths]
  const norm = raw.map(p => p.replace(/\\/g, '/'))
  const entryNames = SKILL_ENTRY_NAMES as readonly string[]

  for (const name of SKILL_ENTRY_NAMES) {
    const i = norm.indexOf(name)
    if (i >= 0) return { ok: true, entryPath: raw[i], prefix: '' }
  }

  const nested: number[] = []
  norm.forEach((p, i) => {
    const seg = p.split('/')
    if (seg.length === 2 && entryNames.includes(seg[1])) nested.push(i)
  })
  const tops = [...new Set(nested.map(i => norm[i].split('/')[0]))]

  if (tops.length > 1) {
    const shown = tops.slice(0, 5).join(' / ') + (tops.length > 5 ? ' …' : '')
    return {
      ok: false,
      error: `一个${unit}只能装一个 Skill：检测到 ${tops.length} 个 Skill 目录（${shown}）。请直接选中要装的那一个`,
    }
  }
  if (nested.length > 0) {
    // 同一顶层目录下 SKILL.md 与 skill.json 并存时优先 SKILL.md（正文即提示词，信息更全）
    const pick = nested.find(i => norm[i].endsWith('SKILL.md')) ?? nested[0]
    return { ok: true, entryPath: raw[pick], prefix: `${norm[pick].split('/')[0]}/` }
  }

  return {
    ok: false,
    error: `这个${unit}里没有 SKILL.md 或 skill.json —— 请选中 Skill 自身的文件夹（或含它的压缩包）`,
  }
}
