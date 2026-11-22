/**
 * 右侧活动栏 · 会话笔记文件操作（异步，走渲染层 IPC）
 *
 * 一个笔记页签 = 一个文件，所以「新建笔记」必须由**壳**先落文件、再开页签；
 * `NotesPane` 里的同名按钮也走这里，两条路只保留一份命名 / 落点逻辑
 * （`产物/笔记.md` → `笔记-2.md` → …，见 PLAN §2.3）。
 */

import {
  aiTeachEnsureSessionFolder,
  workspaceListDir,
  workspaceMkdir,
  workspaceWriteFile,
} from '../../../lib/ipc'
import { uniqueNotePath } from './notesPanePure'

/** F11 拍平后的正式落点：会话文件夹下的 `产物/` */
export const NOTE_OUT_DIR = '产物'

export type CreateNoteResult = { ok: true; relPath: string } | { ok: false; error?: string }

function slash(rel: string): string {
  return String(rel ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function joinRel(dir: string, name: string): string {
  const d = slash(dir)
  return d ? `${d}/${name}` : name
}

/**
 * 在会话文件夹的 `产物/` 下落一篇空笔记并返回仓库相对路径。
 * 目录建不出来时退级到会话文件夹根（宁可贵一层，也不让「新建笔记」变死按钮）。
 */
export async function createSessionNote(rootId: string, sessionId: string): Promise<CreateNoteResult> {
  if (!rootId || !sessionId) return { ok: false, error: '会话文件夹不可用' }
  const ensured = await aiTeachEnsureSessionFolder(sessionId).catch(() => null)
  const base = ensured?.ok && ensured.relPath ? slash(ensured.relPath) : ''
  if (!base) return { ok: false, error: ensured?.error ?? '会话文件夹不可用' }

  const outDir = joinRel(base, NOTE_OUT_DIR)
  const listed = await workspaceListDir(rootId, base).catch(() => null)
  const hasOut =
    (listed?.entries ?? []).some((e) => e.type === 'dir' && e.name === NOTE_OUT_DIR) ||
    (listed?.softNames ?? []).includes(NOTE_OUT_DIR)

  let targetDir = outDir
  if (!hasOut) {
    const made = await workspaceMkdir(rootId, outDir).catch(() => null)
    if (made?.ok) targetDir = made.relPath ? slash(made.relPath) : outDir
    else targetDir = base
  }

  const names = ((await workspaceListDir(rootId, targetDir).catch(() => null))?.entries ?? []).map((e) =>
    joinRel(targetDir, e.name),
  )
  const relPath = uniqueNotePath(names, joinRel(targetDir, '笔记.md'))
  const res = await workspaceWriteFile(rootId, relPath, '', undefined)
  if (!res?.ok) return { ok: false, error: res?.error ?? '新建笔记失败' }
  return { ok: true, relPath }
}
