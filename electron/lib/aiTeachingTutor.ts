import { createAgentSession, getAgentSession } from './agentSessionRepo'
import { ensureSessionFolder, rootDirName, setTutorCreateHandler, setTutorFolderResolver, type FolderResult } from './aiTeachingFolders'

/**
 * AI 教学「对话」模式 · tutor 会话（不建课 / 不归工作区）。
 *
 * 方案：`docs/ai-teaching-tutor-mode-plan.md` §2.1 / §2.5。
 * - 会话仍用 `source: 'aiTeaching'`，只多一个 `aiTeachMode: 'tutor'` 标记；
 * - 会话夹 = `{AI教学根}/对话/{MM-DD 标题}/`，锚点 `.session.json` 带 `kind: 'tutor'`；
 * - 不新增列表函数：渲染层复用 `agent:sessions`，按 `aiTeachMode === 'tutor'` 过滤。
 *
 * 为什么 isTutorSession 每次读会话行：标记可在运行时被改写（重命名 / 迁移），
 * 进程级缓存会让「刚建的对话」在本进程内一直判成课程会话。
 */

/** tutor 会话的父目录名（单一层级，所有对话共用） */
export const TUTOR_FOLDER_NAME = '对话'

/** 该会话是否为「对话」模式会话（读会话行；无仓库 / 无会话 → false） */
export function isTutorSession(sessionId: string): boolean {
  const id = String(sessionId ?? '')
  if (!id) return false
  try {
    return getAgentSession(id)?.aiTeachMode === 'tutor'
  } catch {
    return false
  }
}

/** 文件夹解析器：tutor → `{rootDir}/对话`；其它会话 → null（交给课时 / 助手 / 工作区分支） */
function tutorParentRel(sessionId: string, getSetting: (key: string) => unknown): string | null {
  if (!isTutorSession(sessionId)) return null
  return `${rootDirName(getSetting)}/${TUTOR_FOLDER_NAME}`
}

// 模块加载即注册（与 aiTeachingCourse 的 setLessonFolderResolver 同款接线）：
// tutor → folders 单向依赖，folders 不 import 本文件，避免循环 import 的初始化顺序问题。
setTutorFolderResolver(tutorParentRel)
setTutorCreateHandler((title, getSetting) => createTutorSession(title, getSetting))

export interface TutorSessionResult {
  ok: boolean
  /** 会话已建就一定有 id（建夹失败也不丢会话，渲染层可先进入再重试） */
  sessionId?: string
  /** 会话文件夹相对路径（建夹失败时为 null / 缺省） */
  relPath?: string | null
  error?: string
}

/**
 * 新建 tutor 会话 + 建夹。
 * 标题空 → 「新对话」；建夹失败仍返回 sessionId（会话已落库，不能丢）。
 */
export function createTutorSession(
  title: string | undefined,
  getSetting: (key: string) => unknown,
): TutorSessionResult {
  let sessionId: string
  try {
    const name = String(title ?? '').trim() || '新对话'
    const row = createAgentSession(name, 'aiTeaching', { aiTeachMode: 'tutor' })
    sessionId = row.id
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  let ensured: FolderResult
  try {
    ensured = ensureSessionFolder(sessionId, getSetting)
  } catch (e) {
    return { ok: false, sessionId, relPath: null, error: (e as Error).message }
  }
  if (!ensured.ok) return { ok: false, sessionId, relPath: null, error: ensured.error ?? '会话文件夹创建失败' }
  return { ok: true, sessionId, relPath: ensured.relPath ?? null }
}
