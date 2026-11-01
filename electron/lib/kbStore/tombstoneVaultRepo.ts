import { readJson, writeJsonOrThrow } from './jsonStore'

/**
 * 同步墓碑仓库（手机伴侣 v1.1）：vault 范围内的「条目已删除」登记。
 *
 * 存 `.knowbase/modules/phoneCompanion/tombstones.json` —— 放 vault 里而不是全局
 * userData，理由：墓碑是「这个 vault 的条目删除史」，换电脑拷 vault 时随仓走，
 * 新机器上的手机伴侣才能继续对旧删除做出正确裁决。
 *
 * 用途（协议口径：Phrontis-mobile/docs/design.md §2.1 墓碑节）：
 *  1. 手机上行删除 → 桌面删行 + 记墓碑；
 *  2. 桌面侧自己的删除（界面 / AI / 7 天清理 / 结算撤销）经 deleteSink 记墓碑，
 *     手机 pull 时据此删本地条目；
 *  3. 已墓碑的 id 再收到更旧的 upsert → 拒绝，防止「幽灵复活」。
 */

export interface TombstoneRow {
  domain: string
  id: string
  /** ISO 字符串；与条目 updatedAt 同一条 LWW 时线（新者赢，同刻桌面赢） */
  deletedAt: string
}

const MOD = 'modules/phoneCompanion'
const FILE = 'tombstones.json'
/** 墓碑上限：超限弃最旧。个人规模（记账 + 日程条目）远够；墓碑丢失的唯一后果是极旧条目可能被极旧上行复活 */
const MAX_TOMBSTONES = 5000

export function vaultTombstonesAll(): TombstoneRow[] {
  const rows = readJson<unknown>(MOD, FILE, [])
  return Array.isArray(rows) ? (rows as TombstoneRow[]) : []
}

function save(rows: TombstoneRow[]): void {
  writeJsonOrThrow(MOD, FILE, rows)
}

/** 同一 id 重复删除取更新的 deletedAt（重复上行删除是正常路径，幂等收敛） */
export function vaultRecordTombstones(domain: string, ids: string[], deletedAt: string): void {
  const cleanIds = ids.map(id => String(id || '')).filter(Boolean)
  if (!cleanIds.length || !domain) return
  const rows = vaultTombstonesAll().filter(r => !(r.domain === domain && cleanIds.includes(r.id) && String(r.deletedAt) >= deletedAt))
  const existing = new Set(rows.map(r => r.domain + '|' + r.id))
  for (const id of cleanIds) {
    if (!existing.has(domain + '|' + id)) rows.push({ domain, id, deletedAt })
  }
  rows.sort((a, b) => String(a.deletedAt).localeCompare(String(b.deletedAt)))
  save(rows.length > MAX_TOMBSTONES ? rows.slice(rows.length - MAX_TOMBSTONES) : rows)
}

/** 某条目的现行墓碑（无则 null）；upsert 防复活裁决用 */
export function vaultTombstoneFor(domain: string, id: string): TombstoneRow | null {
  return vaultTombstonesAll().find(r => r.domain === domain && r.id === id) ?? null
}

/** pull 下行：deletedAt > sinceMs 的全部墓碑（不分域，手机按 domain 分派 + 幂等应用） */
export function vaultTombstonesSince(sinceMs: number): TombstoneRow[] {
  return vaultTombstonesAll().filter(r => Date.parse(r.deletedAt) > sinceMs)
}
