/**
 * frontmatter 拆装（共享层）：编辑器模块与知识库就地编辑共用的唯一实现。
 * 从 `src/modules/editor/types.ts` 上移而来（笔记合并 Phase 1，docs/notes-merge-phase1-design.md §1.2）；
 * editor/types.ts 保留 re-export，既有消费方与契约脚本不受影响。
 */

/** 拆分 frontmatter：文本以 `---` 行开头且存在闭合 `---` 行时返回前缀与正文。
 * 前缀原样保留（含换行），正文从闭合行后开始——保存 = prefix + body，roundtrip 无损。 */
export function splitFrontmatter(raw: string): { prefix: string; body: string } | null {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw)
  if (!m) return null
  const prefix = m[0]
  return { prefix, body: raw.slice(prefix.length) }
}

/** 拼回完整文件内容（保存用）：有前缀则拼，无则原样 */
export function joinFrontmatter(doc: { frontmatterPrefix?: string; content: string }): string {
  return doc.frontmatterPrefix ? doc.frontmatterPrefix + doc.content : doc.content
}

/** 前缀里是否已有 id 行（frontmatter 内的顶格 `id:`） */
export function hasFrontmatterId(prefix: string): boolean {
  return /^---\r?\n(?:(?!---)[\s\S])*?^id:[ \t]*\S/m.test(prefix) || /^---\r?\nid:[ \t]*\S/.test(prefix)
}

/**
 * 首次保存自动补 id（2026-09-20 拍板，docs/note-identity-unify-design.md §1）：
 * 无 frontmatter id 的 `.md` 在**首次被编辑保存**时静默写入 id —— 用户零操作，
 * 「转为正式笔记」这个门槛按钮随之退役。
 * 为什么放在渲染层保存路径而不是主进程收口：PageEditor 内存里持有 frontmatter 前缀（`vaultPrefixRef`），
 * 若由主进程改写文件，内存前缀会缺 id，下一次保存又会把它写掉 → 身份来回丢。故注入后必须同步回内存前缀。
 * 返回注入后的前缀与是否发生注入；已有 id / 空前缀新建整块两种情形都在这里收口。
 */
export function ensureFrontmatterId(prefix: string, relPath: string, id: string): { prefix: string; injected: boolean } {
  if (hasFrontmatterId(prefix)) return { prefix, injected: false }
  if (prefix) {
    // 已有 frontmatter 块：id 插到首行 `---` 之后，其余字段原样保留
    return { prefix: prefix.replace(/^---\r?\n/, `---\nid: ${id}\n`), injected: true }
  }
  const name = relPath.slice(relPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  return { prefix: `---\nid: ${id}\ntitle: ${name}\n---\n`, injected: true }
}

/**
 * 保存时刷新 frontmatter `updated`（2026-09-20 反馈：最近编辑列表停在旧值——
 * 索引 updatedAt 取自 frontmatter.updated 而非文件 mtime，就地保存原样拼回旧前缀导致列表不更新）。
 * - 已有 updated 行（任何格式：日期 / ISO）原位替换为当前 ISO 时间；
 * - 无 updated 行则在闭合 `---` 前插入一行；
 * - 无 frontmatter 的纯文件不动（不为此注入 frontmatter——「文件即条目」的普通文件没有编辑时间语义）。
 * 与 ensureFrontmatterId 同一收口理由：内存前缀必须同步回写，否则下一次保存又写回旧值。
 */
export function bumpFrontmatterUpdated(prefix: string, now = new Date().toISOString()): { prefix: string; changed: boolean } {
  if (!prefix) return { prefix, changed: false }
  if (/^updated:[ \t]/m.test(prefix)) {
    return { prefix: prefix.replace(/^updated:[ \t]*[^\r\n]*/m, `updated: ${now}`), changed: true }
  }
  const closing = /(?:\r?\n)---\r?\n$/.exec(prefix)
  if (!closing) return { prefix, changed: false }
  return { prefix: prefix.slice(0, closing.index) + `\nupdated: ${now}\n---\n`, changed: true }
}
