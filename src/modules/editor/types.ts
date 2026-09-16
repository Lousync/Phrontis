import type { WorkspaceEntry } from '../../types'

/** 打开中的文档（脏状态在文档上，标签只是视图） */
export interface EditorDoc {
  relPath: string
  content: string
  savedContent: string
  binary: boolean
  editable: boolean
  truncated: boolean
  size: number
  language: string
  lastSavedAt: number
  /** 上次读/写时记录的磁盘 mtime：保存冲突检测基线（对标 VS Code） */
  mtimeMs: number
  /**
   * frontmatter 前缀（含 --- 包裹，如 `---\nid: …\n---\n`）。
   * Markdown 文档存在时：Monaco 只显示 content=正文，保存时 prefix + content 拼回原样；
   * 无 frontmatter 的文档不设置该字段。
   */
  frontmatterPrefix?: string
  /** 打开时的 frontmatter 前缀快照（dirty 判定与保存基线，含"仅改前缀"场景） */
  savedPrefix?: string
  /**
   * v3.2.0 条目 18：文件已在磁盘上被删除（外部删除 / 移走）。
   * 口径对标 VS Code —— **标签不关闭**，标题加删除线提示；保存时**不带 mtime 基线**，
   * 主进程 `detectConflict` 对非正数基线直接放行（`workspaceManager.ts:290`），
   * 于是原子写自然把文件**重新创建**出来，不需要任何「重建」专用通道。
   */
  missing?: boolean
}

/**
 * 拆分 frontmatter：文本以 `---` 行开头且存在闭合 `---` 行时返回前缀与正文。
 * 前缀原样保留（含换行），正文从闭合行后开始——保存 = prefix + body，roundtrip 无损。
 */
export function splitFrontmatter(raw: string): { prefix: string; body: string } | null {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw)
  if (!m) return null
  const prefix = m[0]
  return { prefix, body: raw.slice(prefix.length) }
}

/** 拼回完整文件内容（保存用）：有前缀则拼，无则原样 */
export function joinFrontmatter(doc: Pick<EditorDoc, 'frontmatterPrefix' | 'content'>): string {
  return doc.frontmatterPrefix ? doc.frontmatterPrefix + doc.content : doc.content
}

/** 当前完整内容（dirty 比较用） */
export function fullContent(doc: Pick<EditorDoc, 'frontmatterPrefix' | 'content'>): string {
  return joinFrontmatter(doc)
}

/** 已保存基线（dirty 比较用，覆盖"仅改前缀"场景） */
export function savedFullContent(doc: Pick<EditorDoc, 'savedPrefix' | 'savedContent'>): string {
  return `${doc.savedPrefix ?? ''}${doc.savedContent}`
}

export type TreeNode = WorkspaceEntry & { relPath: string }

/** 目录缓存：dirRelPath -> entries（懒加载，展开时填充） */
export type DirCache = Record<string, TreeNode[]>

/** VS Code 式内联创建意图：目标目录 + 条目类型（file=普通文件 / dir=目录 / knowledge=带 frontmatter 知识页） */
export interface CreateIntent {
  dirRel: string
  type: 'file' | 'dir' | 'knowledge'
  /** 内联输入框默认名（全选态）：空 = 只 focus 让用户输入 */
  initial?: string
}

const LANG_MAP: Record<string, string> = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  py: 'python', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  java: 'java', rs: 'rust', go: 'go', sh: 'shell', bat: 'bat', cmd: 'bat',
  yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'xml', sql: 'sql',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini',
  txt: 'plaintext', log: 'plaintext', diff: 'diff', csv: 'plaintext',
}

export function languageFor(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return LANG_MAP[ext] || 'plaintext'
}

export function isTextEditable(name: string): boolean {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return name.toLowerCase() === 'readme' || ext in LANG_MAP || !ext
}

/** 拼接相对路径（'/' 分隔，渲染层统一格式，主进程 resolve 兼容） */
export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function parentRel(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i === -1 ? '' : relPath.slice(0, i)
}

export function baseName(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i === -1 ? relPath : relPath.slice(i + 1)
}
