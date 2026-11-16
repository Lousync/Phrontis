/**
 * 仓库规则文件（P1-6）：从磁盘读 `AGENTS.md` / `CLAUDE.md` 并拼成注入段。
 *
 * 与 `repoRulesPure.ts` 分工：这里只做文件系统访问（存在性 / 大小 / 目录判定），
 * 目录归一、去重、截断和文案全在纯函数里（契约可直接跑）。
 *
 * 安全边界：目录一律走 `normalizeRelDir` 的仓库相对路径，不接受绝对路径 / `..` / 点目录；
 * 单文件超过 512KB 直接跳过（规则文件不该是数据文件，避免误读大文件拖慢每轮装配）。
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import {
  normalizeRelDir,
  normalizeRuleDirs,
  renderRepoRulesHint,
  RULE_FILE_NAMES,
  type RepoRuleFile,
} from './repoRulesPure'

/** 单个规则文件的读取上限（字节；超过视为数据文件，不读） */
export const MAX_RULE_FILE_BYTES = 512 * 1024

function absOf(rootPath: string, dir: string): string {
  if (!dir) return rootPath
  return join(rootPath, ...dir.split('/'))
}

/**
 * 作用域路径 → 候选规则目录（含根）。
 * 目录条目取自身，文件条目取所在目录；再补全所有祖先目录。
 */
export function ruleDirsForScopePaths(rootPath: string | null, paths: string[]): string[] {
  const dirs: string[] = ['']
  for (const raw of paths) {
    const rel = normalizeRelDir(raw)
    if (rel === null || rel === '') continue
    let dir = rel
    if (rootPath) {
      try {
        const abs = absOf(rootPath, rel)
        if (existsSync(abs) && !statSync(abs).isDirectory()) {
          dir = rel.split('/').slice(0, -1).join('/')
        }
      } catch {
        // stat 失败按文件处理（取父目录）
        dir = rel.split('/').slice(0, -1).join('/')
      }
    } else {
      dir = rel.split('/').slice(0, -1).join('/')
    }
    const segs = dir.split('/').filter(Boolean)
    for (let i = 0; i <= segs.length; i++) dirs.push(segs.slice(0, i).join('/'))
  }
  return normalizeRuleDirs(dirs)
}

/** 按目录清单读规则文件（rootPath 为空 / 目录非法 → 空串） */
export function readRepoRulesFrom(rootPath: string | null, dirs: unknown[]): string {
  if (!rootPath) return ''
  const files: RepoRuleFile[] = []
  for (const dir of normalizeRuleDirs(dirs)) {
    const absDir = absOf(rootPath, dir)
    for (const name of RULE_FILE_NAMES) {
      const p = join(absDir, name)
      try {
        if (!existsSync(p)) continue
        const st = statSync(p)
        if (!st.isFile() || st.size > MAX_RULE_FILE_BYTES) continue
        const text = readFileSync(p, 'utf-8')
        if (!text.trim()) continue
        files.push({ dir, name, text })
      } catch {
        // 读不到就跳过：规则文件是锦上添花，绝不因此打断本次对话
      }
    }
  }
  return renderRepoRulesHint(files)
}
