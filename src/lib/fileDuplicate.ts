import { workspaceCopyFile, workspaceReadFile, workspaceWriteFile } from './ipc'

/**
 * 创建文件副本（右键菜单「创建副本」共用实现）。
 *
 * 目标名 = 同目录 `主名 副本.扩展名`；已存在时由主进程 `ws:copy` 的 uniqueFileName 自动加后缀。
 * 走 `ws:copy` 按字节复制——文本与二进制（png / pdf / pptx …）都能正确复制；
 * 不要退回 readFile + createFile（会把二进制读坏）。
 *
 * B-34（2026-10-25）：复制完成后对 **.md 副本**重写 frontmatter `id`（新 UUID）——
 * 字节复制会让副本与原文件共用同一 id，索引对重复 id「后者已跳过」，两份文件在
 * 搜索 / 图谱 / 收藏 / 按 id 解析里永远只指得中其中一个（v1 探针实踩：按 id 删除删掉的是另一个文件）。
 * 只换 id 一行的值、绝不重建整块前缀（与 fmProps 同纪律）；非 md / 无 id / 值跨行的一律不动。
 *
 * @returns 主进程返回的 `{ ok, relPath?, renamed?, error? }`；调用方据 relPath/父目录刷新树。
 */
export function duplicateWorkspaceFile(rootId: string, relPath: string) {
  const slash = relPath.lastIndexOf('/')
  const dir = slash >= 0 ? relPath.slice(0, slash) : ''
  const name = slash >= 0 ? relPath.slice(slash + 1) : relPath
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const dstRel = `${dir ? `${dir}/` : ''}${stem} 副本${ext}`
  return workspaceCopyFile(rootId, relPath, dstRel).then(async (r) => {
    if (r?.ok && r.relPath && /\.md$/i.test(r.relPath)) {
      try {
        const read = await workspaceReadFile(rootId, r.relPath)
        if (read?.content) {
          const next = rewriteFrontmatterId(read.content, crypto.randomUUID())
          if (next) await workspaceWriteFile(rootId, r.relPath, next, read.mtimeMs)
        }
      } catch { /* id 重写失败不阻塞副本创建（失败即退回旧行为：与原文件同 id） */ }
    }
    return r
  })
}

/**
 * 把 frontmatter 里**单行** `id:` 的值换成 newId；返回重写后的全文，无需重写时返回 null。
 * 纯函数（契约脚本可直接 import）：没有 frontmatter / 没有 id 行 / id 值为跨行写法（`>-` 等）→ null。
 */
export function rewriteFrontmatterId(text: string, newId: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return null
  const sep = m[1].includes('\r\n') ? '\r\n' : '\n'
  const lines = m[1].split(/\r?\n/)
  const hit = lines.findIndex((l) => /^id:/.test(l))
  if (hit < 0) return null
  // 值跨行 / 块标量写法不动 —— 换值会毁结构
  if (/^id:\s*(\||>|&|\*).*$/.test(lines[hit])) return null
  lines[hit] = `id: ${newId}`
  return `---${sep}${lines.join(sep)}${sep}---${text.slice(m.index + m[0].length)}`
}
