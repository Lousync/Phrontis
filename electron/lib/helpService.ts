import { app } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { searchHelpIn, parseFrontmatter, parseList, tokenize as coreTokenize } from './helpRetrieval'
import type { HelpDocRaw, HelpHit } from './helpRetrieval'

/**
 * 帮助手册服务（主进程侧）—— 磁盘读取层。
 *
 * 背景：帮助文档原先只存在于 `src/modules/help/docs/`，由渲染层 `import.meta.glob` 编译进
 * bundle —— 主进程（AI）完全读不到。2026-09-10 迁到项目根的 `resources/help/`，
 * 渲染层与主进程读同一份，喂给 AI 的知识与用户看到的手册不会再漂移。
 *
 * 检索算法（frontmatter 解析 / bigram 分词 / 相关性排序）在 `./helpRetrieval`（零依赖纯函数），
 * 本文件只负责目录定位与读盘 —— 每次 searchHelp 都现读磁盘、无缓存，dev 下改手册立即生效。
 * 设计见 docs/ai-learn-center-design.md §7.3 / §7.5。
 */

export type { HelpDocRaw, HelpHit }

/** 资源根解析（与 dictionaryService 同款；直接以 js 启动时 appPath 可能偏，故多探几个位置） */
function helpDirCandidates(): string[] {
  if (app.isPackaged) return [join(process.resourcesPath, 'help')]
  const appPath = app.getAppPath()
  return [
    join(appPath, 'resources', 'help'),
    resolve(appPath, '..', '..', 'resources', 'help'),
    join(process.cwd(), 'resources', 'help'),
  ]
}

function helpDir(): string | null {
  for (const p of helpDirCandidates()) {
    try { if (existsSync(p)) return p } catch { /* 下一个 */ }
  }
  return null
}

/** 读取全部手册（无目录/读失败 → 空数组，绝不抛给调用方） */
export function loadHelpDocs(): HelpDocRaw[] {
  const dir = helpDir()
  if (!dir) return []
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')) } catch { return [] }

  const out: HelpDocRaw[] = []
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf8')
      const parsed = parseFrontmatter(raw)
      if (!parsed) continue
      const id = f.replace(/\.md$/i, '')
      out.push({
        id,
        title: parsed.meta.title || id,
        category: parsed.meta.category || '未分类',
        keywords: parseList(parsed.meta.keywords),
        body: parsed.body,
      })
    } catch { /* 单篇失败不影响其它 */ }
  }
  return out
}

export function tokenize(query: string): string[] {
  return coreTokenize(query)
}

/** 检索：读盘 + 委托纯算法层（帮助中心渲染层与 AI 共用 resources/help 这一份） */
export function searchHelp(query: string, limit = 3, id?: string): { hits: HelpHit[]; total: number; hint?: string } {
  const all = loadHelpDocs()
  if (all.length === 0) {
    return { hits: [], total: 0, hint: '帮助手册目录未找到（resources/help）。请如实告知用户当前无法查阅手册，不要凭空编造软件用法。' }
  }
  return searchHelpIn(all, query, limit, id)
}
