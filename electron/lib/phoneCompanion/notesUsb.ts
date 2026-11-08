/**
 * 手机伴侣 · 笔记 U 盘模式（同步协议 v1.6）—— 纯类型 + 纯函数，零依赖。
 *
 * 协议真相源：Phrontis-mobile/docs/design.md §2.1「v1.6 笔记 U 盘模式」；
 * 桌面侧施工图：Phrontis-mobile/docs/handoff-notes-usb-desktop.md。
 * 契约脚本 .AGENT/scripts/phone-companion/verify-companion-protocol.mjs 直接 import 本文件。
 */

/** 仓库顶层固定一层「移动端」，其下每台配对设备一个文件夹 */
export const MOBILE_NOTES_ROOT = '移动端'

/** `移动端/<设备名>/…` 前缀判定（渲染/主进程共用的唯一口径） */
export function isMobileNotesRel(relPath: string): boolean {
  return relPath === MOBILE_NOTES_ROOT || relPath.startsWith(`${MOBILE_NOTES_ROOT}/`)
}

/* ================= 文件名 ================= */

/** Windows 文件名非法字符 + 控制字符 → 全角/删除；空标题兜底「无标题」 */
export function sanitizeNoteStem(title: string): string {
  const cleaned = String(title ?? '')
    // 文件名非法字符（design.md §2.1 v1.6：\ / : * ? " < > |）替换为全角，保内容可读
    .replace(/\\/g, '＼').replace(/\//g, '／').replace(/:/g, '：')
    .replace(/\*/g, '＊').replace(/\?/g, '？').replace(/"/g, '＂')
    .replace(/[<>|]/g, '')
    // 控制字符与首尾空白/点（Windows 文件名不能以点结尾）
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
  return cleaned.slice(0, 80) || '无标题'
}

/**
 * 设备文件夹名：`<设备名>`；设备名在**全部已配对设备**中重名时 `<名>-<deviceId 前 4 位>`
 * （必须按全部配对设备判重而不是在线设备——文件夹名要离线稳定）。
 */
export function deviceFolderName(deviceName: string, deviceId: string, allPairedNames: ReadonlyArray<string>): string {
  const name = String(deviceName ?? '').trim().slice(0, 40) || '手机'
  const dup = allPairedNames.filter((n) => n === name).length > 1
  return dup ? `${name}-${String(deviceId ?? '').slice(0, 4)}` : name
}

/**
 * 设备文件夹内取不重名的文件名：重名加 `(2)` 起的后缀。
 * existing = 该目录内已占用的文件名集合（含扩展名）。
 */
export function pickNoteFileName(existing: ReadonlySet<string>, stem: string): string {
  const base = `${sanitizeNoteStem(stem)}.md`
  if (!existing.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${sanitizeNoteStem(stem)}(${i}).md`
    if (!existing.has(candidate)) return candidate
  }
}

/* ================= frontmatter（跨端锚点，§3 硬契约） ================= */

export interface NoteFrontmatter {
  id: string
  /** ISO 字符串 = LWW 裁决时钟 */
  updated: string
}

/**
 * 轻解析 frontmatter 的 id / updated（不做完整 YAML）：
 * 只认文件开头 `---` 围栏内的 `id:` 与 `updated:` 行。缺任一 → null（不是可同步笔记）。
 */
export function parseNoteFrontmatter(raw: string): NoteFrontmatter | null {
  const text = String(raw ?? '')
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const head = text.slice(0, end)
  const id = /^\s*id:\s*(\S[\S]*)\s*$/m.exec(head)?.[1]?.trim() ?? ''
  const updated = /^\s*updated:\s*(\S[\S]*)\s*$/m.exec(head)?.[1]?.trim() ?? ''
  if (!id || !updated) return null
  return { id, updated }
}

/** 无 id 的 frontmatter 补 uuid（§2.1 v1.6：拖入/新建的无 id 文件由桌面检测时自动生成写回）；已是完整笔记原样返回 */
export function withGeneratedNoteId(raw: string, uuid: string): string {
  const text = String(raw ?? '')
  const parsed = parseNoteFrontmatter(text)
  if (parsed) return text
  if (!text.startsWith('---')) {
    // 无 frontmatter：按契约补最小围栏（id/updated 由调用方一并保证时才可达这里——只补 id 场景）
    return `---\nid: ${uuid}\n---\n${text.startsWith('\n') ? '' : '\n'}${text}`
  }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  return `${text.slice(0, end)}\nid: ${uuid}${text.slice(end)}`
}

/** 桌面写钩子（§3 规则）：任何一次内容改动都必须同步更新 frontmatter `updated`；无 id 的文件不动 */
export function bumpNoteFrontmatterUpdated(raw: string, iso: string): string {
  const text = String(raw ?? '')
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  const head = text.slice(0, end)
  if (!/^\s*id:\s*\S/m.test(head)) return text // 没有 id = 不是 U 盘笔记（普通 md 不被钩子碰）
  if (/^\s*updated:\s*\S/m.test(head)) {
    const bumped = head.replace(/^(\s*updated:\s*)\S.*$/m, `$1${iso}`)
    return bumped + text.slice(end)
  }
  return `${head}\nupdated: ${iso}${text.slice(end)}`
}

/* ================= LWW 裁决（§4.1 push 语义，桌面侧） ================= */

/**
 * push upsert 裁决：incoming 严格更新 → apply（写文件）；相同或更旧 → conflict
 * （手机以服务端版本收敛，下一轮 pull 带回桌面版）。与 shouldApplyIncoming 同一条时线。
 */
export function notePushDecision(localUpdatedAt: string | undefined, incomingUpdatedAt: string): 'apply' | 'conflict' {
  if (!localUpdatedAt) return 'apply' // 桌面没见过该 id → 新笔记
  return String(incomingUpdatedAt) > String(localUpdatedAt) ? 'apply' : 'conflict'
}
