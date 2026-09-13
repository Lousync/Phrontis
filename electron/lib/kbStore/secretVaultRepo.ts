import { exists, readJson, writeJson } from './jsonStore'

/**
 * 密码本 vault 数据仓库（P5b / D4）：`.knowbase/secret/passwords.json`
 *
 * 行结构与 toolbox_passwords 表一致（snake_case 原样保留，与迁移器/回收站快照兼容）；
 * password 字段始终存 'enc1:' 密文（secretBox 同格式，密文机制见 lib/secretBox.ts 头注释），加解密归 passwordRepo 管。
 * 跨机器导入后解密失败 → 读取端返回空串，由 UI 引导重录（R1 口径）。
 */
export interface SecretPwdRow {
  id: string
  title: string
  url: string | null
  username: string | null
  account: string | null
  password: string
  notes: string | null
  sort_order: number
  created_at: string
  updated_at: string
  /** 收藏（2026-09-10 总览页）：置顶常用条目；旧数据无此字段 → 读取端按 false */
  favorite?: boolean
  /** 分组名（折叠展示用）；空/缺失 = 未分组 */
  group?: string | null
}

const MOD = 'secret'
const FILE = 'passwords.json'

/** JSON 文件是否已存在（区分「未播种」与「已迁 vault 但当前为空」） */
export function vaultSecretPasswordsExists(): boolean {
  return exists(MOD, FILE)
}

export function vaultPasswordsAll(): SecretPwdRow[] {
  return readJson<SecretPwdRow[]>(MOD, FILE, [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
}

export function vaultPasswordsSave(rows: SecretPwdRow[]): void {
  writeJson(MOD, FILE, rows)
}
