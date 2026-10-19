// R6 去库化：真相源 = .knowbase/secret/passwords.json（'enc1:' 密文，机制见 lib/secretBox.ts 头注释；sql.js 路径已移除，D9）
import { ipcMain, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { vaultPasswordsAll, vaultPasswordsSave, type SecretPwdRow } from '../../lib/kbStore/secretVaultRepo'
import { recycleBinAdd } from './recycleBinRepo'

// ---- types ----
interface PasswordRow {
  id: string; title: string; url: string | null; username: string | null
  account: string | null; password: string; notes: string | null
  sort_order: number; created_at: string; updated_at: string
  /** 收藏（总览页置顶） */
  favorite?: boolean
  /** 分组名（总览页折叠）；空 = 未分组 */
  group?: string | null
}

/** 新建/更新入参中新加的两个可选字段（favorite / group） */
type EntryMetaInput = { favorite?: boolean; group?: string | null }

// ---- 密码加密(safeStorage；密文机制见 lib/secretBox.ts 头注释) ----
// 密文格式: 'enc1:' + base64(加密字节);无前缀视为历史明文,读取时原样返回。
// 与 secretBox 同格式但不互相引用(与密码本历史数据兼容)。
// ★ 与 lib/secretBox.ts 是**两份必须同步的拷贝**（仓库有意不让两者互相引用）：
//   改动本段（三态、平台断言、跨平台提示口径）时，另一份必须同改，否则「密码本会提示、
//   LLM 账户页静默」这类不一致没有任何报错。契约见 .AGENT/scripts/linux-port/verify-linux-port.mjs §H。
// 三态（2026-10-19 · Linux 平台化）：解不开的密文（多来自其他系统 —— 密钥在各自机器的
// 系统钥匙串里，跨系统必然解不开）**不再静默返回空串**，而是标成 passwordUndecryptable 透给界面。
const ENC_PREFIX = 'enc1:'

export function encryptPassword(plain: string): string {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch { /* fall through */ }
  return plain // 加密不可用时退回明文(功能优先)
}

/** 解密三态（与 lib/secretBox.ts 的 SecretDecodeState 同义；见上方「两份拷贝」说明） */
export type PasswordDecodeState = 'empty' | 'plaintext' | 'encrypted' | 'undecryptable'
export interface PasswordDecode { state: PasswordDecodeState; value: string }

export function decodePassword(stored: string | null | undefined): PasswordDecode {
  if (!stored) return { state: 'empty', value: '' }
  if (!stored.startsWith(ENC_PREFIX)) return { state: 'plaintext', value: stored } // 历史明文
  try {
    return {
      state: 'encrypted',
      value: safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')),
    }
  } catch {
    // 解不开 ≠ 没有值：调用方按 'undecryptable' 显式提示（原先这里返回空串 ⇒「条目在、密码全空」）
    return { state: 'undecryptable', value: '' }
  }
}

/** 明文取值（签名保持兼容）。⚠️ 解不开时同样返回空串 —— 要区分请走 decodePassword。 */
export function decryptPassword(stored: string | null | undefined): string {
  return decodePassword(stored).value
}

/** 「有密码字段但本机解不开」——界面据此显示「无法解密」而不是一个空密码 */
export function isPasswordUndecryptable(stored: string | null | undefined): boolean {
  return decodePassword(stored).state === 'undecryptable'
}

function rowToPassword(row: PasswordRow) {
  const dec = decodePassword(row.password)
  return {
    id: row.id, title: row.title, url: row.url || '',
    username: row.username || '', account: row.account || '',
    password: dec.value, notes: row.notes || '',
    /** 密文来自其他系统、本机解不开（界面显式提示的依据；见上方三态说明） */
    passwordUndecryptable: dec.state === 'undecryptable',
    sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    // 旧行无这两列 → 缺省 false / ''（向后兼容，无需迁移）
    favorite: row.favorite === true, group: row.group || '',
  }
}

// 行结构与表一致（snake_case），password 字段沿用 enc1: 密文格式，回收站快照跨模式兼容。

function vaultRows(): PasswordRow[] {
  return vaultPasswordsAll() as unknown as PasswordRow[]
}

function vaultNextSortOrder(rows: PasswordRow[]): number {
  return rows.reduce((m, r) => Math.max(m, (r.sort_order ?? 0) + 1), 0)
}

/**
 * 新建密码条目（写入 vault 并返回明文行）。
 * 抽出为独立函数：主窗口 passwordVault:create 与悬浮小密码本 fillPopup:createEntry
 * 共用同一份创建逻辑（排序号、时间、加密口径一致），避免两处漂移。
 */
export function createPasswordEntryRow(data: {
  title?: string; url?: string; username?: string; account?: string; password?: string; notes?: string
} & EntryMetaInput): ReturnType<typeof rowToPassword> {
  const id = randomUUID()
  const now = new Date().toISOString()
  const rows = vaultRows()
  const row: PasswordRow = {
    id, title: data.title || '', url: data.url || '', username: data.username || '',
    account: data.account || '', password: encryptPassword(data.password || ''), notes: data.notes || '',
    sort_order: vaultNextSortOrder(rows), created_at: now, updated_at: now,
    favorite: data.favorite === true, group: data.group?.trim() || '',
  }
  vaultPasswordsSave([...rows, row] as unknown as SecretPwdRow[])
  return rowToPassword(row)
}

// ---- IPC handlers ----
export function registerPasswordHandlers(): void {

  ipcMain.handle('passwordVault:getAll', () => {
    return vaultRows().map(rowToPassword)
  })

  ipcMain.handle('passwordVault:getById', (_e, id: string) => {
    const rows = vaultRows()
    const hit = rows.find((r) => r.id === id)
    return hit ? rowToPassword(hit) : null
  })

  ipcMain.handle('passwordVault:create', (_e, data: {
    title?: string; url?: string; username?: string; account?: string; password?: string; notes?: string
  } & EntryMetaInput) => {
    return createPasswordEntryRow(data)
  })

  ipcMain.handle('passwordVault:update', (_e, id: string, data: {
    title?: string; url?: string; username?: string; account?: string; password?: string; notes?: string; sortOrder?: number
  } & EntryMetaInput & { expectedUpdatedAt?: string }) => {
    const rows = vaultRows()
    const i = rows.findIndex((r) => r.id === id)
    if (i < 0) return null
    const cur = rows[i]
    // 乐观锁（防跨窗口/跨条目串写覆盖）：客户端持有的版本与磁盘不一致即拒写。
    // 任一侧缺 updated_at 时跳过校验（旧数据向后兼容）；不传 expectedUpdatedAt 视为不做校验（局部更新）。
    if (data.expectedUpdatedAt && cur.updated_at && data.expectedUpdatedAt !== cur.updated_at) {
      throw new Error('PASSWORD_CONFLICT')
    }
    const next: PasswordRow = {
      ...cur,
      title: data.title !== undefined ? data.title : cur.title,
      url: data.url !== undefined ? data.url : cur.url,
      username: data.username !== undefined ? data.username : cur.username,
      account: data.account !== undefined ? data.account : cur.account,
      password: data.password !== undefined ? encryptPassword(data.password) : cur.password,
      notes: data.notes !== undefined ? data.notes : cur.notes,
      sort_order: data.sortOrder !== undefined ? data.sortOrder : cur.sort_order,
      favorite: data.favorite !== undefined ? data.favorite === true : cur.favorite,
      group: data.group !== undefined ? (data.group?.trim() || '') : cur.group,
      updated_at: new Date().toISOString(),
    }
    rows[i] = next
    vaultPasswordsSave(rows as unknown as SecretPwdRow[])
    return rowToPassword(next)
  })

  ipcMain.handle('passwordVault:delete', (_e, id: string) => {
    // Move to recycle bin instead of permanent delete
    const rows = vaultRows()
    const hit = rows.find((r) => r.id === id)
    if (!hit) return
    const entry = rowToPassword(hit)
    const binId = randomUUID()
    const snapshot = JSON.stringify({
      ...entry,
      // 明文可解 → 按本机密钥重加密。**解不开时 entry.password 是空串**：照旧重加密会把原始密文
      // 替换成空串（回收站里再也回不来）⇒ 原样保留 hit.password，至少在原来那台机器上还能恢复。
      password: entry.password ? encryptPassword(entry.password) : (hit.password || ''),
    })
    recycleBinAdd({ id: binId, original_id: id, module: 'passwordVault', title: entry.title || '未命名', data: snapshot, deleted_at: new Date().toISOString() })
    vaultPasswordsSave(rows.filter((r) => r.id !== id) as unknown as SecretPwdRow[])
  })
}
