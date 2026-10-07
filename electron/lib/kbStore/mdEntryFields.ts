/**
 * md 条目的 frontmatter 缺省补全 —— **零依赖纯函数**（不 import fs / electron / jsonStore）。
 *
 * 索引是**唯一解析点**：条目字段在这里补齐后，下游（repo 映射 → IPC → 渲染层）只收不发散。
 * 历史教训（B-4）：`fileType` 的补全曾被写在「无 frontmatter id」的 auto 兜底分支里，
 * 于是**应用内正式新建的页（有 id）反而拿不到**——渲染层所有严格 `=== 'md'` 的分支
 * （左栏大纲按钮 / 沉浸阅读 / AI 续写）静默失效，界面看着一切正常。
 *
 * ★ 独立成文件的理由：契约脚本要能直接 `import` 它跑用例。`knowledgeIndex.ts` 用
 * extensionless 相对导入并间接引 `electron`，node 裸跑 import 不进来。
 * 同先例：`electron/lib/releaseNotes/judge.ts`（「零依赖独立文件，专为让脚本 import」）。
 */

/** 与 knowledgeIndex 内原实现逐字一致（非字符串一律 String()，null/undefined → ''） */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/**
 * 就地补全一条 md 条目的身份与类型字段：
 * - 无 id → 以 `auto:<relPath>` 作临时身份（2026-09-20 身份统一拍板，见 docs/note-identity-unify-design.md §1）；
 *   首次保存时由渲染层写回真 UUID，身份自动升级，用户零操作。
 * - 无 title → 取文件名去扩展名。
 * - 无 fileType → `'md'`。**对所有 md 无条件生效**：显式给了值则尊重原值
 *   （外部工具可能写别的类型），只填空串 / 缺失。
 *
 * @param fm  frontmatter 对象（就地修改）
 * @param rel 仓库相对路径（正斜杠分隔），仅用于派生 id 与 title
 */
export function normalizeMdEntryFields(fm: Record<string, unknown>, rel: string): void {
  if (!asString(fm.id)) {
    const fileName = rel.slice(rel.lastIndexOf('/') + 1)
    const dot = fileName.lastIndexOf('.')
    fm.id = `auto:${rel}`
    if (!asString(fm.title)) fm.title = dot > 0 ? fileName.slice(0, dot) : fileName
  }
  if (!asString(fm.fileType)) fm.fileType = 'md'
}
