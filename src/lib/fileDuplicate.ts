import { workspaceCopyFile } from './ipc'

/**
 * 创建文件副本（右键菜单「创建副本」共用实现）。
 *
 * 目标名 = 同目录 `主名 副本.扩展名`；已存在时由主进程 `ws:copy` 的 uniqueFileName 自动加后缀。
 * 走 `ws:copy` 按字节复制——文本与二进制（png / pdf / pptx …）都能正确复制；
 * 不要退回 readFile + createFile（会把二进制读坏）。
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
  return workspaceCopyFile(rootId, relPath, dstRel)
}
