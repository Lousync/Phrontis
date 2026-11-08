import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { findKnowledgePage, invalidateKnowledgeIndex } from 'phrontis-core/kbStore/knowledgeIndex'
import { parseMarkdown, serializeMarkdown } from 'phrontis-core/kbStore/mdStore'
import { vaultRecordTombstones } from 'phrontis-core/kbStore/tombstoneVaultRepo'
import { writeWorkspaceFile } from '../workspaceManager'
import { broadcastDataChanged } from '../../main/windowBus'
import { loadPairedDevices, loadNotesState, saveNotesState } from './devices'
import {
  MOBILE_NOTES_ROOT, deviceFolderName, isMobileNotesRel,
  notePushDecision, parseNoteFrontmatter, pickNoteFileName, sanitizeNoteStem,
} from './notesUsb'

/**
 * 手机伴侣 · 笔记 U 盘模式 vault 触达层（同步协议 v1.6）。
 *
 * 手机笔记 = 仓库里一棵双向同步子树 `移动端/<设备名>/<标题>.md`（frontmatter id/updated/tags）：
 *  - applyNoteUsb：push upsert 的 LWW 裁决 + 落盘（标题改动 = 改名，id 不变）；
 *  - applyDeleteNoteUsb：push 墓碑 → 删文件 + 记墓碑（unknown id 照样 applied）；
 *  - listNotesSinceUsb：pull 下行 —— 扫描设备文件夹检测桌面侧增删改（§4.3），
 *    无 id 文件自动生成 uuid 写回（拖入 = 发到手机）；
 *  - 写钩子见 workspaceManager.writeWorkspaceFile（桌面改动统一 bump frontmatter updated）。
 */

/** 设备文件夹仓库相对路径（重名设备消歧按全部配对设备，离线稳定） */
export function deviceFolderRel(deviceName: string, deviceId: string): string | null {
  const devices = ((): Array<{ name: string; deviceId: string }> => {
    try { return loadPairedDevices().map(d => ({ name: d.name, deviceId: d.deviceId })) } catch { return [] }
  })()
  const name = deviceFolderName(deviceName, deviceId, devices.map(d => d.name))
  return `${MOBILE_NOTES_ROOT}/${name}`
}

function requireRoot(): string | null {
  return getCurrentVault()?.rootPath ?? null
}

/** id → 设备文件夹内路径（notesState 镜像优先，知识索引兜底；只在移动端子树内有效） */
function resolveNoteRel(root: string, deviceId: string, id: string): { rel: string; updatedAt?: string } | null {
  const known = loadNotesState(deviceId).items[id]
  if (known) return { rel: known.path, updatedAt: known.updatedAt }
  const entry = findKnowledgePage(id)
  if (entry && isMobileNotesRel(entry.path)) {
    try {
      const fm = parseNoteFrontmatter(readFileSync(join(root, entry.path), 'utf-8'))
      return { rel: entry.path, updatedAt: fm?.updated }
    } catch { return null }
  }
  return null
}

function refresh(): void {
  invalidateKnowledgeIndex()
  // 铁律 1：主进程写盘后必须广播（手机上行 / 扫描改了 vault，知识库与文件树要刷新）
  broadcastDataChanged('knowledge')
}

/* ================= push：upsert（LWW） ================= */

export function applyNoteUsb(item: { deviceId: string; deviceName: string; id: string; updatedAt: string; data: { title: string; body: string } }): { applied: boolean; conflict?: boolean; reason?: string } {
  const root = requireRoot()
  if (!root) return { applied: false, reason: 'no-vault' }
  const folderRel = deviceFolderRel(item.deviceName, item.deviceId)
  if (!folderRel) return { applied: false, reason: 'no-device' }
  const dirAbs = join(root, folderRel)

  // LWW 裁决时钟：镜像优先，文件（按 id 走索引）兜底 —— 手改文件未同步时也能拿到最新版本
  const known = resolveNoteRel(root, item.deviceId, item.id)
  if (notePushDecision(known?.updatedAt, item.updatedAt) === 'conflict') {
    return { applied: false, conflict: true, reason: 'server-newer' }
  }

  // 标题改动 = 改名（id 不变）；空标题沿用旧文件名（手机允许无标题闪念）
  const oldRel = known?.rel
  const oldName = oldRel ? basename(oldRel) : undefined
  const oldStem = oldName ? oldName.replace(/\.md$/i, '').replace(/\(\d+\)$/, '') : ''
  const stem = sanitizeNoteStem(item.data.title.trim() || oldStem || '无标题')
  mkdirSync(dirAbs, { recursive: true })
  const existing = new Set(
    readdirSync(dirAbs).filter(n => n.toLowerCase().endsWith('.md') && !n.startsWith('.kb-tmp-')),
  )
  if (oldName) existing.delete(oldName)
  const fileName = pickNoteFileName(existing, stem)
  const newRel = `${folderRel}/${fileName}`
  const abs = join(root, newRel)

  // 先改名后写内容：保住文件身份连续性（fsWatcher 看到的是同一路径的一次自写更新）
  if (oldRel && oldRel !== newRel) {
    const oldAbs = join(root, oldRel)
    if (existsSync(oldAbs)) {
      try { unlinkSync(oldAbs) } catch { /* 旧文件不在 = 幂等 */ }
    }
  }
  const content = serializeMarkdown(
    { id: item.id, updated: item.updatedAt, tags: ['手机'] },
    item.data.body,
  )
  writeWorkspaceFile(abs, content) // markSelfWrite 防外部修改弹窗
  refresh()

  const state = loadNotesState(item.deviceId)
  delete state.items[item.id]
  state.items[item.id] = { path: newRel, updatedAt: item.updatedAt, mtimeMs: statSync(abs).mtimeMs }
  saveNotesState(item.deviceId, state)
  return { applied: true }
}

/* ================= push：墓碑 ================= */

export function applyDeleteNoteUsb(id: string, deletedAt: string): { applied: boolean; conflict?: boolean; reason?: string } {
  const root = requireRoot()
  if (!root) return { applied: false, reason: 'no-vault' }
  // 桌面没见过该 id（手机新建即丢的无害墓碑）→ 照样 applied（§4.1），墓碑照记防复活
  let devices: Array<{ deviceId: string; name: string }> = []
  try { devices = loadPairedDevices().map(d => ({ deviceId: d.deviceId, name: d.name })) } catch { /* 设备表不可读时只记墓碑 */ }
  for (const d of devices) {
    const st = loadNotesState(d.deviceId)
    if (st.items[id]) {
      try { unlinkSync(join(root, st.items[id].path)) } catch { /* 文件已不在 = 幂等 */ }
      delete st.items[id]
      saveNotesState(d.deviceId, st)
    }
  }
  vaultRecordTombstones('notes', [id], deletedAt)
  refresh()
  return { applied: true }
}

/* ================= pull：桌面侧变更检测（§4.3） ================= */

export function listNotesSinceUsb(device: { deviceId: string; deviceName: string }, sinceMs: number): Array<{ id: string; updatedAt: string; data: { title: string; body: string } }> {
  const root = requireRoot()
  if (!root) return []
  const folderRel = deviceFolderRel(device.deviceName, device.deviceId)
  if (!folderRel) return []
  const dirAbs = join(root, folderRel)
  const state = loadNotesState(device.deviceId)
  const now = Date.now()

  interface Found { rel: string; updatedAt: string; mtimeMs: number; title: string; body: string }
  const found = new Map<string, Found>()

  if (existsSync(dirAbs)) {
    for (const name of readdirSync(dirAbs)) {
      if (!name.toLowerCase().endsWith('.md') || name.startsWith('.kb-tmp-')) continue
      const rel = `${folderRel}/${name}`
      const abs = join(root, rel)
      let raw = ''
      let mtimeMs = 0
      try {
        raw = readFileSync(abs, 'utf-8')
        mtimeMs = statSync(abs).mtimeMs
      } catch { continue }
      // 无 id 文件：自动生成 uuid 写回（拖入/新建 = 发到手机，§2.1 v1.6）；updated 缺失一并补
      let doc = parseMarkdown(raw)
      if (!String(doc.frontmatter.id ?? '').trim()) {
        doc.frontmatter.id = randomUUID()
        if (!String(doc.frontmatter.updated ?? '').trim()) doc.frontmatter.updated = new Date().toISOString()
        const tags = Array.isArray(doc.frontmatter.tags) ? doc.frontmatter.tags.map(String) : []
        if (!tags.includes('手机')) tags.push('手机')
        doc.frontmatter.tags = tags
        const patched = serializeMarkdown(doc.frontmatter, doc.body)
        writeWorkspaceFile(abs, patched)
        doc = parseMarkdown(patched)
      }
      const id = String(doc.frontmatter.id).trim()
      const updatedAt = String(doc.frontmatter.updated ?? '').trim() || new Date(mtimeMs).toISOString()
      // 文件名 = 标题（(N) 后缀不进标题）
      found.set(id, { rel, updatedAt, mtimeMs, title: name.replace(/\.md$/i, '').replace(/\(\d+\)$/, ''), body: doc.body })
    }
  }

  // 变更集：新（不在镜像）/ 改（时钟或 mtime 变）；since≤0 = 全量（冲突重对 / 旧手机，§4.2 兼容矩阵）
  const changes: Array<{ id: string; updatedAt: string; data: { title: string; body: string } }> = []
  for (const [id, f] of found) {
    const known = state.items[id]
    const isNew = !known
    const changed = !!known && (known.updatedAt !== f.updatedAt || known.mtimeMs !== f.mtimeMs)
    const inWindow = isNew || Date.parse(f.updatedAt) > sinceMs || f.mtimeMs > sinceMs
    if (sinceMs <= 0 || (changed && inWindow) || (isNew && inWindow)) {
      changes.push({ id, updatedAt: f.updatedAt, data: { title: f.title, body: f.body } })
    }
  }
  // 删除检测：镜像里有、文件夹里没有 → 记墓碑（走 listTombstonesSince 下行，手机幂等删）
  const missing = Object.keys(state.items).filter(id => !found.has(id))
  if (missing.length) vaultRecordTombstones('notes', missing, new Date().toISOString())

  // 全部比对完 → 镜像 + 游标写回（§4.3）
  state.items = Object.fromEntries(
    [...found].map(([id, f]) => [id, { path: f.rel, updatedAt: f.updatedAt, mtimeMs: f.mtimeMs }]),
  )
  state.cursor = now
  saveNotesState(device.deviceId, state)
  if (changes.length || missing.length) refresh()
  return changes
}
